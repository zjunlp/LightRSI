/**
 * Independent eviction safety policy (Task-R3, part 2).
 *
 * The estimator only proposes candidates (via task lifecycle). This filter runs
 * independently before any surface mutation and NEVER trusts the model's
 * self-reported state. It clears an item for eviction only if ALL hold:
 *   - the item is on the current surface (effective),
 *   - its task is `completed` (not current / active / blocked / unresolved),
 *   - it is not part of the current turn,
 *   - it is not a canonical compaction checkpoint,
 *   - if it is a tool call/result, its callId group is strictly closed
 *     (1 call + 1 result) and every item in that group is itself clearable —
 *     otherwise the whole group is deferred.
 *
 * Anything failing these is kept. This matches the shared fixture oracle
 * (tests/fixtures/session-events.json).
 */

import { buildToolPairs, isEvictablePair, type ClosureEvent } from "./tool-closure.js";

export type TaskState = "completed" | "unresolved" | "current" | "active" | "blocked";

export type ItemKind = "message" | "tool_call" | "tool_result" | "compaction_checkpoint" | string;

export interface SafetyItem {
  sourceEventSeq: number;
  kind: ItemKind;
  taskState: TaskState;
  current: boolean;
  /** Present for tool_call / tool_result items; ties the item to its pair. */
  callIds?: readonly string[];
  /** Visible characters that would actually be replaced. */
  chars?: number;
}

export type SafetyAction = "evict" | "keep";

export interface SafetyDecision {
  action: Map<number, SafetyAction>;
  evictSeqs: number[];
  keepSeqs: number[];
  /** callIds whose group was protected because it wasn't strictly closed. */
  deferredCallIds: string[];
}

/** True when an item is individually clearable (ignoring tool-group coupling). */
function isClearable(item: SafetyItem, effective: Set<number>): boolean {
  if (!effective.has(item.sourceEventSeq)) return false;
  if (item.current) return false;
  if (item.kind === "compaction_checkpoint") return false;
  return item.taskState === "completed";
}

/**
 * Apply the safety policy. `events` is only needed to re-derive tool pairs over
 * the effective surface; item task state comes from the caller (the estimator /
 * registry), never re-inferred here.
 */
export function applySafetyPolicy(
  items: readonly SafetyItem[],
  effectiveSeqs: Iterable<number>,
  events: readonly ClosureEvent[],
  minBlockChars = 0,
): SafetyDecision {
  const effective = new Set(effectiveSeqs);
  const action = new Map<number, SafetyAction>();
  for (const item of items) action.set(item.sourceEventSeq, "keep"); // default keep

  const pairs = buildToolPairs(events, effective);
  const itemsBySeq = new Map(items.map((it) => [it.sourceEventSeq, it]));
  const deferredCallIds: string[] = [];

  // DSH keeps tool calls inside assistant messages. Preserve that call envelope
  // and only rewrite a result when its pair is strict and both sides are safe.
  const tooledSeqs = new Set<number>();
  const unsafeToolSeqs = new Set<number>();
  const unsafeCallEnvelopeSeqs = new Set<number>();
  for (const pair of pairs.values()) {
    const memberSeqs = [...pair.callSeqs, ...pair.resultSeqs];
    for (const seq of memberSeqs) tooledSeqs.add(seq);

    const everyMemberClearable = memberSeqs.every((seq) => {
      const it = itemsBySeq.get(seq);
      return it ? isClearable(it, effective) : false;
    });

    if (!isEvictablePair(pair.status) || !everyMemberClearable) {
      for (const seq of memberSeqs) unsafeToolSeqs.add(seq);
      for (const seq of pair.callSeqs) unsafeCallEnvelopeSeqs.add(seq);
      deferredCallIds.push(pair.callId);
    }
  }

  // One assistant message may carry multiple calls. If any call in that shared
  // envelope is unsafe, no sibling result may be rewritten independently.
  for (const pair of pairs.values()) {
    if (!pair.callSeqs.some((seq) => unsafeCallEnvelopeSeqs.has(seq))) continue;
    for (const seq of [...pair.callSeqs, ...pair.resultSeqs]) unsafeToolSeqs.add(seq);
    deferredCallIds.push(pair.callId);
  }

  for (const item of items) {
    if (!tooledSeqs.has(item.sourceEventSeq)) continue;
    const resultIsLargeEnough = item.kind === "tool_result" && (item.chars ?? 0) >= minBlockChars;
    action.set(
      item.sourceEventSeq,
      resultIsLargeEnough && !unsafeToolSeqs.has(item.sourceEventSeq) ? "evict" : "keep",
    );
  }

  // Non-tool items: evict iff individually clearable.
  for (const item of items) {
    if (tooledSeqs.has(item.sourceEventSeq)) continue;
    action.set(
      item.sourceEventSeq,
      isClearable(item, effective) && (item.chars ?? 0) >= minBlockChars ? "evict" : "keep",
    );
  }

  const evictSeqs: number[] = [];
  const keepSeqs: number[] = [];
  for (const [seq, act] of action) (act === "evict" ? evictSeqs : keepSeqs).push(seq);
  evictSeqs.sort((a, b) => a - b);
  keepSeqs.sort((a, b) => a - b);
  const uniqueDeferredCallIds = [...new Set(deferredCallIds)].sort();

  return { action, evictSeqs, keepSeqs, deferredCallIds: uniqueDeferredCallIds };
}

/**
 * Detect malformed persisted event records without exposing their content.
 * A record is valid iff it is an object carrying a numeric `seq` and a string
 * `type`. Returns the indexes of records that fail — nothing from the content.
 */
export function findDamagedPersistenceRecords(records: readonly unknown[]): number[] {
  const damaged: number[] = [];
  records.forEach((record, index) => {
    const ok =
      typeof record === "object" &&
      record !== null &&
      !Array.isArray(record) &&
      typeof (record as { seq?: unknown }).seq === "number" &&
      typeof (record as { type?: unknown }).type === "string";
    if (!ok) damaged.push(index);
  });
  return damaged;
}
