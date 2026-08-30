/**
 * DSH eviction cycle — the closure (Task-R5 core).
 *
 * Composes the pieces into the loop 徐步强 named:
 *   codec → estimator → registry(update) → R3 safety filter → R4 transaction.
 *
 * It is a PURE pipeline over an in-hand registry: the registry comes in as a
 * parameter and the updated registry comes back out. Loading/persisting it
 * (the DSH state directory) stays at the caller's edge (eviction-engine), which
 * keeps this testable and isolates the one DSH-state integration point.
 *
 * Registry mechanics are NOT reimplemented — task updates go through the shared
 * `mapTaskUpdatesToRegistryPatch` + `applySessionTaskRegistryPatch`.
 */

import {
  applySessionTaskRegistryPatch,
  type SessionTaskRegistry,
} from "@lightrsi/history";
import { mapTaskUpdatesToRegistryPatch, type TaskStateEstimator } from "@lightrsi/eviction";

import { buildDshDeltaView, buildDshRawSemanticSnapshot } from "./session-codec.js";
import { runTaskStateEstimate } from "./lifecycle-estimator.js";
import { applySafetyPolicy, type SafetyItem, type TaskState } from "./safety-policy.js";
import {
  applyEvictionTransaction,
  type AppendableSession,
  type EvictionPlan,
  type EvictionTarget,
  type TransactionResult,
} from "./surface-transaction.js";
import type { DshLogEventWithMeta, DshMessage } from "./types.js";
import { assistantCallIds, resultCallId } from "./tool-closure.js";

/** The session view the cycle needs: durable log + surface + append (R4). */
export interface CycleSession extends AppendableSession {
  readonly events: readonly DshLogEventWithMeta[];
}

export interface EvictionCycleResult {
  registry: SessionTaskRegistry;
  result: TransactionResult;
  registryPersisted: boolean;
  /** Coarse status for logging: why nothing was applied, when applicable. */
  status: "applied" | "deferred" | "empty" | "no-delta";
}

type EffectiveItem = {
  seq: number;
  turn: number;
  kind: SafetyItem["kind"];
  role: "user" | "assistant";
  callIds?: string[];
  chars: number;
  event: DshLogEventWithMeta;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isReplace(event: DshLogEventWithMeta): boolean {
  const op = (event as { surfaceOp?: unknown }).surfaceOp;
  return isObject(op) && op.op === "replace";
}

function visibleChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + visibleChars(item), 0);
  if (!isObject(value)) return 0;
  if (typeof value.text === "string") return value.text.length;
  if (Array.isArray(value.content)) return visibleChars(value.content);
  return 0;
}

/** Describe the model-visible items on the surface (turn/kind/role/callId). */
export function describeEffectiveItems(
  events: readonly DshLogEventWithMeta[],
  effectiveSeqs: readonly number[],
): EffectiveItem[] {
  const effective = new Set(effectiveSeqs);
  const items: EffectiveItem[] = [];
  let activeTurn = 0;

  for (const event of events) {
    const data = isObject((event as { data?: unknown }).data) ? (event.data as Record<string, unknown>) : {};
    if (event.type === "turn/start" && typeof data.turn === "number") activeTurn = data.turn;
    const turn = typeof data.turn === "number" ? data.turn : activeTurn;

    if (!effective.has(event.seq) || event.ignorable === true) continue;

    switch (event.type) {
      case "user/message":
      case "assistant/message": {
        const kind = isReplace(event) ? "compaction_checkpoint" : "message";
        const role = event.type === "assistant/message" ? "assistant" : "user";
        const message = event.type === "assistant/message" && isObject(data.message) ? data.message : data;
        const callIds = event.type === "assistant/message" ? assistantCallIds(event) : [];
        items.push({
          seq: event.seq,
          turn,
          kind: callIds.length > 0 ? "tool_call" : kind,
          role,
          ...(callIds.length > 0 ? { callIds } : {}),
          chars: visibleChars(message.content),
          event,
        });
        break;
      }
      case "tool/result":
        items.push({
          seq: event.seq,
          turn,
          kind: "tool_result",
          role: "user",
          ...(resultCallId(event) ? { callIds: [resultCallId(event)!] } : {}),
          chars: visibleChars(isObject(data.message) ? data.message.content : undefined),
          event,
        });
        break;
      default:
        break;
    }
  }
  return items;
}

/** Classify an item's task state from the registry (never re-inferred from content). */
function classify(
  item: EffectiveItem,
  registry: SessionTaskRegistry,
  currentTurn: number,
): { taskState: TaskState; current: boolean } {
  if (item.turn >= currentTurn) return { taskState: "current", current: true };

  const turnAbsId = `${registry.sessionId}:t${item.turn}`;
  const taskIds = registry.turnToTaskIds[turnAbsId] ?? [];
  const evictable = new Set(registry.evictableTaskIds);
  const completed = new Set(registry.completedTaskIds);
  const active = new Set(registry.activeTaskIds);

  // Removable only if EVERY owning task is completed/evictable and none active.
  if (taskIds.length > 0 && taskIds.every((id) => evictable.has(id) || completed.has(id)) && !taskIds.some((id) => active.has(id))) {
    return { taskState: "completed", current: false };
  }
  if (taskIds.some((id) => active.has(id))) return { taskState: "active", current: false };
  return { taskState: "unresolved", current: false };
}

function currentTurnOf(events: readonly DshLogEventWithMeta[]): number {
  let turn = 0;
  for (const e of events) {
    const data = isObject((e as { data?: unknown }).data) ? (e.data as Record<string, unknown>) : {};
    if (e.type === "turn/start" && typeof data.turn === "number") turn = Math.max(turn, data.turn);
  }
  return turn;
}

/** Run one eviction cycle. Registry in → updated registry + transaction result out. */
export async function runDshEvictionCycle(params: {
  session: CycleSession;
  registry: SessionTaskRegistry;
  estimator: TaskStateEstimator;
  computeRevision: (session: AppendableSession) => string;
  evictionId?: string;
  minBlockChars?: number;
  persistRegistry?: (registry: SessionTaskRegistry, expectedVersion: number) => void | Promise<void>;
}): Promise<EvictionCycleResult> {
  const { session, estimator, computeRevision } = params;

  const snapshot = buildDshRawSemanticSnapshot(session.id, session.events, {
    surfaceEventSeqs: session.surface.nodes,
  });
  const delta = buildDshDeltaView(snapshot, { fromTurnSeqExclusive: params.registry.lastProcessedTurnSeq });
  let registry = params.registry;
  let registryPersistedBeforeMutation = false;
  let registryExpectedVersion = params.registry.version;
  if (delta.coveredTurnAbsIds.length > 0) {
    // Estimator → registry update (shared mapper; no registry logic reinvented).
    const output = await runTaskStateEstimate(estimator, { registry: params.registry, delta });
    const { patch } = mapTaskUpdatesToRegistryPatch({
      registry: params.registry,
      updates: output.taskUpdates,
      coveredTurnAbsIds: delta.coveredTurnAbsIds,
      toTurnSeqInclusive: delta.toTurnSeqInclusive,
    });
    registry = applySessionTaskRegistryPatch(params.registry, patch);
    // Registry CAS is a precondition for canonical mutation. Persist task state
    // first, but keep the watermark behind until the surface transaction lands;
    // otherwise a partial append would permanently hide its unprocessed tail.
    const pendingRegistry = {
      ...registry,
      lastProcessedTurnSeq: params.registry.lastProcessedTurnSeq,
    };
    await params.persistRegistry?.(pendingRegistry, params.registry.version);
    registry = pendingRegistry;
    registryPersistedBeforeMutation = params.persistRegistry !== undefined;
    registryExpectedVersion = pendingRegistry.version;
  }

  // Classify effective items against the updated registry, then R3 safety filter.
  const currentTurn = currentTurnOf(session.events);
  const effective = describeEffectiveItems(session.events, session.surface.nodes);
  const bySeq = new Map(effective.map((it) => [it.seq, it]));
  const safetyItems: SafetyItem[] = effective.map((it) => {
    const c = classify(it, registry, currentTurn);
    return {
      sourceEventSeq: it.seq,
      kind: it.kind,
      taskState: c.taskState,
      current: c.current,
      callIds: it.callIds,
      chars: it.chars,
    };
  });

  const decision = applySafetyPolicy(
    safetyItems,
    session.surface.nodes,
    session.events,
    params.minBlockChars ?? 0,
  );
  if (decision.evictSeqs.length === 0) {
    registry = { ...registry, lastProcessedTurnSeq: delta.toTurnSeqInclusive };
    if (registryPersistedBeforeMutation && params.persistRegistry) {
      await params.persistRegistry(registry, registryExpectedVersion);
    }
    return {
      registry,
      result: emptyResult(),
      registryPersisted: true,
      status: delta.coveredTurnAbsIds.length === 0 ? "no-delta" : "empty",
    };
  }

  // Build the plan and apply it as a canonical transaction (R4).
  const targets: EvictionTarget[] = decision.evictSeqs.map((seq) => {
    const it = bySeq.get(seq);
    if (!it) throw new Error(`eviction target ${seq} is not a current surface item`);
    return buildEvictionTarget(it, params.evictionId ?? `dsh-evict-${session.id}-${currentTurn}`);
  });
  const plan: EvictionPlan = {
    evictionId: params.evictionId ?? `dsh-evict-${session.id}-${currentTurn}`,
    revision: computeRevision(session),
    targets,
  };
  const result = applyEvictionTransaction(session, plan, computeRevision);

  const shouldAdvanceWatermark = result.status === "committed";
  const finalRegistry = shouldAdvanceWatermark
    ? { ...registry, lastProcessedTurnSeq: delta.toTurnSeqInclusive }
    : registry;
  let registryPersisted = true;
  if (shouldAdvanceWatermark && registryPersistedBeforeMutation && params.persistRegistry) {
    try {
      await params.persistRegistry(finalRegistry, registryExpectedVersion);
    } catch {
      // Replacements already landed. Keep the in-memory result truthful and let
      // the next cycle recover the stale watermark from the canonical surface.
      registryPersisted = false;
    }
  }

  return {
    registry: finalRegistry,
    result,
    registryPersisted,
    status: result.status === "committed" || result.status === "partial" ? "applied" : "deferred",
  };
}

function replacementMessageId(evictionId: string, seq: number): string {
  return `lightrsi-${evictionId}-${seq}`;
}

function textStub(kind: string, seq: number): { type: "text"; text: string } {
  return { type: "text", text: `[evicted: ${kind} @${seq}]` };
}

/** Build a replacement that satisfies the native DSH event envelope. */
function buildEvictionTarget(item: EffectiveItem, evictionId: string): EvictionTarget {
  const data = isObject(item.event.data) ? structuredClone(item.event.data) : {};
  if (item.event.type === "user/message" || item.event.type === "assistant/message") {
    return {
      sourceEventSeq: item.seq,
      eventType: "user/message",
      data: {
        id: replacementMessageId(evictionId, item.seq),
        role: "user",
        content: [textStub(item.kind, item.seq)],
        source: {
          kind: "plugin",
          plugin: "tokenpilot-dsh",
          form: "notice",
          summary: `Evicted historical context at event ${item.seq}`,
        },
      } satisfies DshMessage,
    };
  }
  const message = isObject(data.message) ? data.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const resultBlock = isObject(content[0]) ? content[0] : {};
  return {
    sourceEventSeq: item.seq,
    eventType: "tool/result",
    data: {
      ...data,
      message: {
        ...message,
        content: [{ ...resultBlock, content: [textStub(item.kind, item.seq)] }],
      },
    },
  };
}

function emptyResult(): TransactionResult {
  return { status: "empty", evictionId: "", appliedSeqs: [], failedSeqs: [] };
}
