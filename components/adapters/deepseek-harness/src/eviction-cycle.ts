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
import type { DshLogEventWithMeta } from "./types.js";

/** The session view the cycle needs: durable log + surface + append (R4). */
export interface CycleSession extends AppendableSession {
  readonly events: readonly DshLogEventWithMeta[];
}

export interface EvictionCycleResult {
  registry: SessionTaskRegistry;
  result: TransactionResult;
  /** Coarse status for logging: why nothing was applied, when applicable. */
  status: "applied" | "deferred" | "empty" | "no-delta";
}

type EffectiveItem = {
  seq: number;
  turn: number;
  kind: SafetyItem["kind"];
  role: "user" | "assistant";
  callId?: string;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isReplace(event: DshLogEventWithMeta): boolean {
  const op = (event as { surfaceOp?: unknown }).surfaceOp;
  return isObject(op) && op.op === "replace";
}

function resultCallId(data: Record<string, unknown>): string | undefined {
  const message = isObject(data.message) ? data.message : {};
  const source = isObject(message.source) ? message.source : {};
  if (typeof source.callId === "string" && source.callId) return source.callId;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const b of content) {
    if (isObject(b) && b.type === "tool-result" && typeof b.toolCallId === "string") return b.toolCallId;
  }
  return undefined;
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
        items.push({ seq: event.seq, turn, kind, role });
        break;
      }
      case "tool/call":
        items.push({ seq: event.seq, turn, kind: "tool_call", role: "assistant", callId: typeof data.callId === "string" ? data.callId : undefined });
        break;
      case "tool/result":
        items.push({ seq: event.seq, turn, kind: "tool_result", role: "user", callId: resultCallId(data) });
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
}): Promise<EvictionCycleResult> {
  const { session, estimator, computeRevision } = params;

  const snapshot = buildDshRawSemanticSnapshot(session.id, session.events, {
    surfaceEventSeqs: session.surface.nodes,
  });
  const delta = buildDshDeltaView(snapshot, { fromTurnSeqExclusive: params.registry.lastProcessedTurnSeq });
  if (delta.coveredTurnAbsIds.length === 0) {
    return { registry: params.registry, result: emptyResult(), status: "no-delta" };
  }

  // Estimator → registry update (shared mapper; no registry logic reinvented).
  const output = await runTaskStateEstimate(estimator, { registry: params.registry, delta });
  const { patch } = mapTaskUpdatesToRegistryPatch({
    registry: params.registry,
    updates: output.taskUpdates,
    coveredTurnAbsIds: delta.coveredTurnAbsIds,
    toTurnSeqInclusive: delta.toTurnSeqInclusive,
  });
  const registry = applySessionTaskRegistryPatch(params.registry, patch);

  // Classify effective items against the updated registry, then R3 safety filter.
  const currentTurn = currentTurnOf(session.events);
  const effective = describeEffectiveItems(session.events, session.surface.nodes);
  const bySeq = new Map(effective.map((it) => [it.seq, it]));
  const safetyItems: SafetyItem[] = effective.map((it) => {
    const c = classify(it, registry, currentTurn);
    return { sourceEventSeq: it.seq, kind: it.kind, taskState: c.taskState, current: c.current, callId: it.callId };
  });

  const decision = applySafetyPolicy(safetyItems, session.surface.nodes, session.events);
  if (decision.evictSeqs.length === 0) {
    return { registry, result: emptyResult(), status: "empty" };
  }

  // Build the plan and apply it as a canonical transaction (R4).
  const targets: EvictionTarget[] = decision.evictSeqs.map((seq) => {
    const it = bySeq.get(seq);
    return { sourceEventSeq: seq, role: it?.role ?? "user", stubText: `[evicted: ${it?.kind ?? "item"} @${seq}]` };
  });
  const plan: EvictionPlan = {
    evictionId: params.evictionId ?? `dsh-evict-${session.id}-${currentTurn}`,
    revision: computeRevision(session),
    targets,
  };
  const result = applyEvictionTransaction(session, plan, computeRevision);

  return {
    registry: { ...registry, lastProcessedTurnSeq: delta.toTurnSeqInclusive },
    result,
    status: result.status === "committed" || result.status === "partial" ? "applied" : "deferred",
  };
}

function emptyResult(): TransactionResult {
  return { status: "empty", evictionId: "", appliedSeqs: [], failedSeqs: [] };
}
