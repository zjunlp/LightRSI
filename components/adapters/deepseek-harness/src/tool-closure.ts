/**
 * Tool call/result closure (Task-R3, part 1).
 *
 * Groups effective tool events by `callId` and classifies each group's closure
 * status. Only a strictly closed pair (exactly one call + one result) is safe
 * to evict, and only as a unit. Everything else — an orphan result, a call with
 * no result, or a duplicated call id — is unsafe and must be deferred.
 *
 * This mirrors the pairing scheme the shared fixture oracle uses
 * (tests/session-event-fixtures.test.ts): tool/call → data.callId; tool/result
 * → message.source.callId (fallback: the tool-result block's toolCallId).
 */

export type ToolPairStatus =
  | "closed"
  | "orphan_result"
  | "missing_result"
  | "duplicate_call"
  | "duplicate_result";

export interface ToolPair {
  callId: string;
  callSeqs: number[];
  resultSeqs: number[];
  status: ToolPairStatus;
}

/** Minimal event shape the closure logic reads. */
export interface ClosureEvent {
  seq: number;
  type: string;
  data?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a tool/result event's callId (source.callId, else the tool-result block). */
export function resultCallId(event: ClosureEvent): string | undefined {
  const data = isObject(event.data) ? event.data : {};
  const message = isObject(data.message) ? data.message : {};
  const source = isObject(message.source) ? message.source : {};
  if (typeof source.callId === "string" && source.callId.length > 0) return source.callId;

  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (isObject(block) && block.type === "tool-result" && typeof block.toolCallId === "string") {
      return block.toolCallId;
    }
  }
  return undefined;
}

function callCallId(event: ClosureEvent): string | undefined {
  const data = isObject(event.data) ? event.data : {};
  return typeof data.callId === "string" && data.callId.length > 0 ? data.callId : undefined;
}

export function classifyPair(callSeqs: readonly number[], resultSeqs: readonly number[]): ToolPairStatus {
  if (callSeqs.length > 1) return "duplicate_call";
  if (resultSeqs.length > 1) return "duplicate_result";
  if (callSeqs.length === 0) return "orphan_result";
  if (resultSeqs.length === 0) return "missing_result";
  return "closed";
}

/** Only a strictly closed pair may be evicted (and only as a unit). */
export function isEvictablePair(status: ToolPairStatus): boolean {
  return status === "closed";
}

/**
 * Build the tool-pair map over the events that are currently on the surface
 * (`effectiveSeqs`). Events not on the surface never participate in a pair.
 */
export function buildToolPairs(
  events: readonly ClosureEvent[],
  effectiveSeqs: Iterable<number>,
): Map<string, ToolPair> {
  const effective = new Set(effectiveSeqs);
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();

  for (const event of events) {
    if (!effective.has(event.seq)) continue;

    if (event.type === "tool/call") {
      const id = callCallId(event);
      if (id) (calls.get(id) ?? calls.set(id, []).get(id)!).push(event.seq);
    } else if (event.type === "tool/result") {
      const id = resultCallId(event);
      if (id) (results.get(id) ?? results.set(id, []).get(id)!).push(event.seq);
    }
  }

  const pairs = new Map<string, ToolPair>();
  for (const callId of new Set([...calls.keys(), ...results.keys()])) {
    const callSeqs = (calls.get(callId) ?? []).sort((a, b) => a - b);
    const resultSeqs = (results.get(callId) ?? []).sort((a, b) => a - b);
    pairs.set(callId, { callId, callSeqs, resultSeqs, status: classifyPair(callSeqs, resultSeqs) });
  }
  return pairs;
}
