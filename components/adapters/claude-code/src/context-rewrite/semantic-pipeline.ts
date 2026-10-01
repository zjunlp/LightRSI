import {
  buildDeltaViewFromRawSemanticSnapshot,
  listRawSemanticTurnSeqs,
  loadRawSemanticTurnRecord,
  loadSessionTaskRegistry,
  persistRawSemanticTurnRecord,
  persistSessionTaskRegistry,
  SessionTaskRegistryVersionMismatchError,
  type RawSemanticTurnRecord,
  type DeltaView,
  type SessionTaskRegistry,
} from "@lightrsi/history";
import type { TaskStateEstimator } from "@lightrsi/eviction";
import { createHash } from "node:crypto";
import {
  buildRawSemanticTurnRecord,
  buildRawSemanticSnapshot,
  sliceClaudeMessagesForCurrentUserTurn,
} from "./semantic-mapping.js";
import { claimClaudeSemanticTurn } from "./turn-counter.js";

export type SemanticPipelineResult = {
  ran: boolean;
  changed: boolean;
  turnSeq?: number;
  note?: string;
};

/**
 * V2 semantic-delta pipeline for one Claude request. Advances the per-session
 * turn counter, records this turn, then rebuilds the (lastProcessed, now]
 * interval into a DeltaView, asks the estimator for task-state updates, and
 * persists the updated registry. A successful no-op estimate advances
 * lastProcessedTurnSeq too, so the same observations are not re-estimated.
 *
 * The whole thing is fail-open: any error (I/O, estimator, version conflict)
 * leaves the request path untouched and returns { ran:false/… } instead of
 * throwing. The caller (gateway) must treat this as best-effort side work that
 * can never block or fail the actual request.
 *
 * Watermark: updateRegistryFromDelta's mapper already sets
 * lastProcessedTurnSeq = delta.toTurnSeqInclusive in the patch, so a successful
 * update returns a registry whose watermark is advanced — we persist it as-is.
 * Estimator failures and version mismatches leave the watermark unchanged so a
 * later turn can recover the interval safely.
 */
export type SemanticDeltaPreparation =
  | {
      ok: true;
      turnSeq: number;
      isNewRequest: boolean;
      registry: SessionTaskRegistry;
      delta: DeltaView;
      turnAbsIdByToolCallId: ReadonlyMap<string, string>;
    }
  | { ok: false; turnSeq?: number; note: string };

export function buildUniqueToolCallTurnMap(
  turns: readonly RawSemanticTurnRecord[],
): ReadonlyMap<string, string> {
  const turnIdsByCallId = new Map<string, Set<string>>();
  for (const turn of turns) {
    for (const item of [...turn.toolCalls, ...turn.toolResults]) {
      const callId = item.toolCallId.trim();
      const turnAbsId = item.anchor.turnAbsId.trim();
      if (!callId || !turnAbsId) continue;
      const turnIds = turnIdsByCallId.get(callId) ?? new Set<string>();
      turnIds.add(turnAbsId);
      turnIdsByCallId.set(callId, turnIds);
    }
  }

  const result = new Map<string, string>();
  for (const [callId, turnIds] of turnIdsByCallId) {
    if (turnIds.size === 1) result.set(callId, [...turnIds][0]!);
  }
  return result;
}

/**
 * Recover historical tool-call ownership without claiming or persisting a new
 * semantic turn. Manual Cleaner schedules intentionally pause the lifecycle
 * planner, but the Cleaner still needs this read-only map to re-attribute the
 * approved task scope on the next request.
 */
export async function loadPersistedToolCallTurnMap(params: {
  stateDir: string;
  sessionId: string;
}): Promise<ReadonlyMap<string, string>> {
  const allSeqs = await listRawSemanticTurnSeqs(params.stateDir, params.sessionId);
  const loaded = await Promise.all(
    allSeqs.map((seq) => loadRawSemanticTurnRecord(params.stateDir, params.sessionId, seq)),
  );
  return buildUniqueToolCallTurnMap(
    loaded.filter((record): record is RawSemanticTurnRecord => record !== null),
  );
}

/**
 * Prepare the (lastProcessed, now] semantic-delta materials for one Claude
 * request: claim the per-session turn seq, persist this turn's raw record,
 * load the registry, and rebuild the interval into a DeltaView. This is the
 * shared "materials" step both runSemanticPipeline and the lifecycle-planner
 * gateway wiring consume, so the turn-seq / interval logic lives in exactly one
 * place. Returns { ok: false } (never throws for control flow) when there is
 * nothing to process for this turn (already processed); callers early-out on it.
 * Genuine errors still throw and are caught fail-open by the caller.
 */
export async function prepareSemanticDelta(params: {
  stateDir: string;
  sessionId: string;
  messages: unknown[];
}): Promise<SemanticDeltaPreparation> {
  const { stateDir, sessionId, messages } = params;
  const currentTurnMessages = sliceClaudeMessagesForCurrentUserTurn(messages);
  if (currentTurnMessages.length === 0) {
    return { ok: false, note: "internal_request_ignored" };
  }
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex");
  const { turnSeq, isNewRequest } = await claimClaudeSemanticTurn(
    stateDir,
    sessionId,
    requestFingerprint,
  );

  const existingRecord = await loadRawSemanticTurnRecord(stateDir, sessionId, turnSeq);
  if (isNewRequest || !existingRecord) {
    const record = buildRawSemanticTurnRecord({
      sessionId,
      turnSeq,
      messages: currentTurnMessages,
    });
    await persistRawSemanticTurnRecord(stateDir, record);
  }

  const registry = await loadSessionTaskRegistry(stateDir, sessionId);
  const fromTurnSeqExclusive = registry.lastProcessedTurnSeq;
  if (!isNewRequest && fromTurnSeqExclusive >= turnSeq) {
    return { ok: false, turnSeq, note: "already_processed" };
  }

  // Load the full persisted record set for stable historical tool attribution;
  // build the estimator delta from the requested (lastProcessed, now] window.
  const allSeqs = await listRawSemanticTurnSeqs(stateDir, sessionId);
  const intervalSeqs = allSeqs.filter(
    (seq) => seq > fromTurnSeqExclusive && seq <= turnSeq,
  );
  const loaded = await Promise.all(
    allSeqs.map((seq) => loadRawSemanticTurnRecord(stateDir, sessionId, seq)),
  );
  const allTurns = loaded.filter((r): r is RawSemanticTurnRecord => r !== null);
  const intervalSeqSet = new Set(intervalSeqs);
  const turns = allTurns.filter((turn) => intervalSeqSet.has(turn.turnSeq));

  const snapshot = buildRawSemanticSnapshot({ sessionId, turns });
  const delta = buildDeltaViewFromRawSemanticSnapshot(snapshot, {
    fromTurnSeqExclusive,
    toTurnSeqInclusive: turnSeq,
  });

  return {
    ok: true,
    turnSeq,
    isNewRequest,
    registry,
    delta,
    turnAbsIdByToolCallId: buildUniqueToolCallTurnMap(allTurns),
  };
}

export async function runSemanticPipeline(params: {
  stateDir: string;
  sessionId: string;
  messages: unknown[];
  estimator: TaskStateEstimator;
  updateRegistryFromDelta: (args: {
    registry: import("@lightrsi/history").SessionTaskRegistry;
    delta: import("@lightrsi/history").DeltaView;
    estimator: TaskStateEstimator;
  }) => Promise<{
    registry: import("@lightrsi/history").SessionTaskRegistry;
    changed: boolean;
    processed?: boolean;
    note?: string;
  }>;
}): Promise<SemanticPipelineResult> {
  const { stateDir, sessionId, messages, estimator, updateRegistryFromDelta } = params;
  try {
    const prep = await prepareSemanticDelta({ stateDir, sessionId, messages });
    if (!prep.ok) {
      return { ran: true, changed: false, turnSeq: prep.turnSeq, note: prep.note };
    }
    const { turnSeq, registry, delta } = prep;

    const result = await updateRegistryFromDelta({ registry, delta, estimator });
    if (!result.changed && result.processed !== true) {
      return { ran: true, changed: false, turnSeq, note: result.note };
    }

    try {
      await persistSessionTaskRegistry(stateDir, result.registry, {
        expectedVersion: registry.version,
      });
    } catch (error) {
      if (error instanceof SessionTaskRegistryVersionMismatchError) {
        // Another writer advanced the registry; abandon rather than clobber.
        return { ran: true, changed: false, turnSeq, note: "version_conflict" };
      }
      throw error;
    }

    return { ran: true, changed: result.changed, turnSeq, note: result.note };
  } catch {
    // fail-open: semantic side-work must never break the request path
    return { ran: false, changed: false, note: "pipeline_error" };
  }
}
