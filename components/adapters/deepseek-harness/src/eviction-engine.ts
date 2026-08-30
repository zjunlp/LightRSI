/**
 * Eviction pre-step orchestration (Task-R5 landing point).
 *
 * Registers on DSH's `agent/pre-step` waterfall. On each eligible model step it
 * runs the eviction cycle (codec → estimator → registry → R3 safety → R4
 * transaction) and re-meters. Fail-open is the whole safety story (§4.3): any
 * failure leaves the surface untouched and calls `next()` — there is no
 * HTTP-style resend; the correct fail-open is "no mutation + next()".
 *
 * Registry persistence uses LightRSI's durable state directory with version
 * CAS. Tests may inject a store, but production never falls back to volatile
 * process memory because restart would silently reset task lifecycle state.
 */

import {
  loadSessionTaskRegistry,
  persistSessionTaskRegistry,
  type SessionTaskRegistry,
} from "@lightrsi/history";

import { runDshEvictionCycle, type CycleSession } from "./eviction-cycle.js";
import { createDshTaskStateEstimator } from "./lifecycle-estimator.js";
import type { AppendableSession } from "./surface-transaction.js";
import type { TokenPilotDshConfig } from "./config.js";
import type {
  DshLogEventWithMeta,
  DshPluginContext,
  DshPreStepDecision,
  DshPreStepNext,
  DshPreStepPayload,
} from "./types.js";

const RECOGNIZED_TYPES = new Set<string>([
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided",
  "approval/policy", "assistant/chunk", "assistant/message", "command/done", "command/run",
  "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
  "feedback/record", "goal/change", "hook/invoked", "hook/result", "llm/retry",
  "llm/retry-started", "permission/preset", "plan/mode", "request/context", "request/header",
  "sandbox/mode", "schedule/change", "session/end-seed", "session/title",
  "session/title-llm-request", "step/end", "step/start", "subagent/descriptor", "todo/write",
  "tool-workflow/agent-end", "tool-workflow/agent-start", "tool-workflow/run-end",
  "tool-workflow/run-start", "tool/call", "tool/code-dispatch", "tool/code-dispatch-start",
  "tool/result", "turn/end", "turn/start", "user/message", "web/deepseek-search-llm-request",
]);

type SkipReason =
  | "disabled" | "aborted" | "empty-log" | "unrecognized-required-event"
  | "estimator-not-configured" | "registry-not-configured"
  | "applied" | "no-candidates" | "error";

function log(config: TokenPilotDshConfig, reason: SkipReason, detail?: unknown): void {
  if (config.logLevel === "debug") console.debug?.("[tokenpilot:dsh] pre-step", { reason, detail });
}

function hasUnrecognizedRequiredEvent(events: readonly DshLogEventWithMeta[]): boolean {
  for (const event of events) {
    if (!RECOGNIZED_TYPES.has(event.type) && event.ignorable !== true) return true;
  }
  return false;
}

/** Surface revision for R4's guard: changes when membership or replace-generation changes. */
function surfaceRevision(session: AppendableSession): string {
  let hash = 5381;
  const events = (session as Partial<CycleSession>).events;
  const lastEventSeq = events?.at(-1)?.seq ?? -1;
  const material = `${session.id}|${lastEventSeq}|${session.surface.nodes.join(",")}|${session.surface.replaceGeneration}`;
  for (let i = 0; i < material.length; i += 1) hash = ((hash << 5) + hash + material.charCodeAt(i)) >>> 0;
  return `dsh-surf-${hash.toString(16)}`;
}

/** Injectable registry persistence. Production uses LightRSI's durable CAS store. */
export interface RegistryStore {
  load(sessionId: string): SessionTaskRegistry | Promise<SessionTaskRegistry>;
  persist(sessionId: string, registry: SessionTaskRegistry, expectedVersion: number): void | Promise<void>;
}

function persistentRegistryStore(stateDir: string): RegistryStore {
  return {
    load: (sessionId) => loadSessionTaskRegistry(stateDir, sessionId),
    persist: async (_sessionId, registry, expectedVersion) => {
      await persistSessionTaskRegistry(stateDir, registry, {
        expectedVersion,
      });
    },
  };
}

/**
 * Register the TokenPilot eviction handler on `agent/pre-step`. `registryStore`
 * defaults to the durable store rooted at `config.stateDir`. Without a state
 * directory the handler conservatively bypasses mutation.
 */
export function registerEvictionPreStep(
  ctx: DshPluginContext,
  config: TokenPilotDshConfig,
  registryStore: RegistryStore | undefined = config.stateDir
    ? persistentRegistryStore(config.stateDir)
    : undefined,
): void {
  const estimator = createDshTaskStateEstimator(config.taskStateEstimator);

  // §1.3: eviction must run BEFORE DSH compaction in the pre-step waterfall, so
  // compaction sees the already-shrunk surface. `prepend` puts this handler ahead
  // of compaction-basic's (which registers normally), mirroring how DSH's own
  // invariant handler prepends to run first.
  ctx.on("agent/pre-step", async (payload: DshPreStepPayload, next: DshPreStepNext): Promise<DshPreStepDecision> => {
    if (!config.enabled || !config.eviction.enabled) { log(config, "disabled"); return next(); }

    try {
      if (payload.signal.aborted) { log(config, "aborted"); return next(); }

      const session = payload.agent.session;
      if (session.events.length === 0) { log(config, "empty-log"); return next(); }
      if (hasUnrecognizedRequiredEvent(session.events)) { log(config, "unrecognized-required-event"); return next(); }
      if (!estimator) { log(config, "estimator-not-configured"); return next(); }
      if (!registryStore) { log(config, "registry-not-configured"); return next(); }

      // The live DSH session supports append() (verified against core/session);
      // the bridge type omits it, so treat it structurally as a CycleSession.
      const cycleSession = session as unknown as CycleSession;
      const registry = await registryStore.load(session.id);

      const cycle = await runDshEvictionCycle({
        session: cycleSession,
        registry,
        estimator,
        computeRevision: surfaceRevision,
        minBlockChars: config.eviction.minBlockChars,
        persistRegistry: async (nextRegistry, expectedVersion) => {
          await registryStore.persist(session.id, nextRegistry, expectedVersion);
        },
      });

      if (cycle.result.status === "committed" || cycle.result.status === "partial") {
        // Eviction changed the surface → re-meter so downstream sees the new size (§1.3).
        ctx.tokenMeter.measure(session);
        log(config, "applied", cycle.result.appliedSeqs);
        if (!cycle.registryPersisted) log(config, "error", "registry watermark persist failed after mutation");
      } else {
        log(config, "no-candidates", cycle.status);
      }
      return next();
    } catch (error) {
      log(config, "error", error);
      return next();
    }
  }, config.compaction.runEvictionBeforeCompaction ? { prepend: true } : undefined);
}
