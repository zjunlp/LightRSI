import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanerControlPlane,
  type ContextCleanerHostBridge,
  type ContextCleanReceipt,
  type ExecuteApprovedContextCleanParams,
} from "@lightrsi/cleaner";
import { loadSessionTaskRegistry } from "@lightrsi/history";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  countTextWithPreciseTokens,
  type ModelContextSnapshot,
} from "@lightrsi/host-adapter";

import { buildCodexEffectiveHistoryView, parseCodexRollout } from "../context-history/index.js";
import { codexSharedContextRewriteBackend } from "../context-rewrite/backend.js";
import { buildCodexLifecycleBackendRequest } from "../context-rewrite/lifecycle-input.js";
import {
  loadCodexSessionSnapshot,
} from "../session-state.js";
import { scheduleCodexCleanerPlan } from "./scheduler.js";
import { listCodexCleanerSessions } from "./session-catalog.js";

const CODEX_HOST_ID = "codex";

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizedUniqueStrings(values: string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim());
  return normalized.every(Boolean) && new Set(normalized).size === normalized.length
    ? normalized
    : undefined;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullableNonNegativeInteger(value: unknown): boolean {
  return value === null || nonNegativeInteger(value);
}

function validReceiptState(receipt: ContextCleanReceipt): boolean {
  if (!nullableNonNegativeInteger(receipt.estimatedSavedTokens)
    || !nonNegativeInteger(receipt.estimatedSavedChars)
    || !["exact", "estimated", "chars_only"].includes(receipt.tokenCountMode)) {
    return false;
  }
  const record = receipt as unknown as Record<string, unknown>;
  if (receipt.status === "applied") {
    const evidence = receipt.evidence as unknown as Record<string, unknown> | undefined;
    return receipt.fallbackUsed === false
      && nullableNonNegativeInteger(receipt.appliedSavedTokens)
      && nonNegativeInteger(receipt.appliedSavedChars)
      && typeof evidence?.previousRevision === "string"
      && Boolean(evidence.previousRevision.trim())
      && typeof evidence?.nextRevision === "string"
      && Boolean(evidence.nextRevision.trim())
      && normalizedUniqueStrings(receipt.evidence.operationIds) !== undefined
      && receipt.evidence.operationIds.length > 0
      && normalizedUniqueStrings(receipt.evidence.itemIds) !== undefined
      && receipt.evidence.itemIds.length > 0;
  }
  if (!["analyzed", "approved", "scheduled", "stale", "cancelled", "failed"].includes(receipt.status)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(record, "appliedSavedTokens")
    || Object.prototype.hasOwnProperty.call(record, "appliedSavedChars")) {
    return false;
  }
  return true;
}

function validateApprovedRequest(request: ExecuteApprovedContextCleanParams): string[] {
  if (request.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION) {
    throw new Error("codex_clean_approval_schema_mismatch");
  }
  if (request.hostId !== CODEX_HOST_ID) {
    throw new Error("codex_clean_approval_host_mismatch");
  }
  if (!request.cleanPlanId.trim()
    || !request.sessionId.trim()
    || !request.baseRevision.trim()
    || !canonicalTimestamp(request.approvedAt)
    || request.selectedTasks.length === 0) {
    throw new Error("codex_clean_approval_invalid");
  }
  const taskIds = normalizedUniqueStrings(request.selectedTasks.map((task) => task.taskId));
  if (!taskIds) throw new Error("codex_clean_approval_invalid");
  const claimedItemIds = new Set<string>();
  for (const task of request.selectedTasks) {
    const itemIds = normalizedUniqueStrings(task.itemIds);
    if (!itemIds
      || itemIds.length === 0
      || Object.keys(task.itemDigests).length !== itemIds.length) {
      throw new Error("codex_clean_approval_targets_invalid");
    }
    for (const itemId of itemIds) {
      if (claimedItemIds.has(itemId)
        || typeof task.itemDigests[itemId] !== "string"
        || !task.itemDigests[itemId]!.trim()) {
        throw new Error("codex_clean_approval_targets_invalid");
      }
      claimedItemIds.add(itemId);
    }
  }
  return taskIds;
}

function validateReceipt(params: {
  receipt: ContextCleanReceipt;
  planId: string;
  sessionId?: string;
  selectedTaskIds?: string[];
}): ContextCleanReceipt {
  const { receipt } = params;
  const selectedTaskIds = normalizedUniqueStrings(receipt.selectedTaskIds);
  if (receipt.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION
    || receipt.hostId !== CODEX_HOST_ID
    || receipt.planId !== params.planId
    || (params.sessionId !== undefined && receipt.sessionId !== params.sessionId)
    || !canonicalTimestamp(receipt.updatedAt)
    || !selectedTaskIds
    || !validReceiptState(receipt)) {
    throw new Error("codex_clean_receipt_mismatch");
  }
  if (params.selectedTaskIds) {
    const expected = [...params.selectedTaskIds].sort();
    const actual = [...selectedTaskIds].sort();
    if (expected.length !== actual.length
      || expected.some((taskId, index) => taskId !== actual[index])) {
      throw new Error("codex_clean_receipt_mismatch");
    }
  }
  return receipt;
}

function validPersistableSnapshot(
  snapshot: ModelContextSnapshot,
  sessionId: string,
  revision: string,
): boolean {
  if (snapshot.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
    || snapshot.hostId !== "codex"
    || snapshot.sessionId !== sessionId
    || snapshot.revision !== revision
    || !snapshot.revision.trim()
    || Object.prototype.hasOwnProperty.call(snapshot, "adapterMetadata")) return false;
  const stableIds = new Set<string>();
  for (const item of snapshot.items) {
    if (!item.stableId.trim()
      || stableIds.has(item.stableId)
      || !item.fingerprint.trim()
      || !Number.isSafeInteger(item.chars)
      || item.chars < 0) return false;
    stableIds.add(item.stableId);
  }
  return true;
}

export function createCodexContextCleanerBridge(params: {
  stateDir: string;
  controlPlane: ContextCleanerControlPlane;
}): ContextCleanerHostBridge {
  return {
    hostId: CODEX_HOST_ID,
    rewriteMode: "response_chain_rebase",
    async listSessions() {
      return listCodexCleanerSessions(params.stateDir);
    },
    async readCleanSnapshot(sessionId) {
      const session = await loadCodexSessionSnapshot(params.stateDir, sessionId);
      if (!session) throw new Error("codex_clean_session_not_found");
      const view = await buildCodexEffectiveHistoryView({
        stateDir: params.stateDir,
        sessionId,
        headResponseId: session.latestResponseId,
        async rolloutViewBootstrap() {
          if (!session.transcriptPath) return null;
          return (await parseCodexRollout(session.transcriptPath))?.view ?? null;
        },
      });
      if (view.history.incomplete
        || !view.semanticComplete
        || view.reasonCodes.length > 0
        || view.history.deferredItems.length > 0
        || view.history.unresolvedCallIds.length > 0) {
        throw new Error("codex_clean_snapshot_incomplete");
      }
      const registry = await loadSessionTaskRegistry(params.stateDir, sessionId);
      if (registry.sessionId !== sessionId) {
        throw new Error("codex_clean_registry_session_mismatch");
      }
      const model = session.latestModel?.trim() || undefined;
      const backendRequest = buildCodexLifecycleBackendRequest({
        view,
        registry,
        request: {
          sessionId,
          payload: {
            ...(model ? { model } : {}),
            ...(session.latestResponseId
              ? { previous_response_id: session.latestResponseId }
              : {}),
            input: [],
          },
          effectiveHistory: view.history,
          currentInput: [],
        },
      });
      const backendSnapshot = await codexSharedContextRewriteBackend.readSnapshot({
        sessionId,
        request: backendRequest,
      });
      const sourceItems = [
        ...view.history.replayableItems,
        ...view.history.observationOnlyItems,
        ...view.history.deferredItems,
      ];
      const sourceItemsById = new Map(
        sourceItems.map((item) => [item.stableItemId, item] as const),
      );
      const { adapterMetadata: _adapterMetadata, ...persistableSnapshot } = backendSnapshot;
      if (!validPersistableSnapshot(persistableSnapshot, sessionId, view.history.revision)
        || sourceItemsById.size !== sourceItems.length
        || sourceItems.length !== persistableSnapshot.items.length
        || persistableSnapshot.items.some((item) => !sourceItemsById.has(item.stableId))) {
        throw new Error("codex_clean_snapshot_invalid");
      }
      if (Number.isNaN(Date.parse(session.updatedAt))) {
        throw new Error("codex_clean_snapshot_timestamp_invalid");
      }
      const counts = model
        ? persistableSnapshot.items.map((item) => {
            const sourceItem = sourceItemsById.get(item.stableId)!;
            return [
              item.stableId,
              countTextWithPreciseTokens(model, JSON.stringify(sourceItem.item)),
            ] as const;
          })
        : [];
      const exact = counts.length > 0 && counts.every(([, count]) => count.mode === "openai_tokens");
      return {
        ...persistableSnapshot,
        capturedAt: session.updatedAt,
        ...(model ? { model } : {}),
        tokenCountMode: exact ? "exact" : "chars_only",
        tokenCountMethod: exact ? "openai_tokenizer" : "utf16_chars",
        ...(exact
          ? { itemTokenCounts: Object.fromEntries(counts.map(([itemId, count]) => [itemId, count.count])) }
          : {}),
      };
    },
    async executeApprovedClean(request) {
      const selectedTaskIds = validateApprovedRequest(request);
      const receipt = validateReceipt({
        receipt: await params.controlPlane.executeApprovedClean(request),
        planId: request.cleanPlanId,
        sessionId: request.sessionId,
        selectedTaskIds,
      });
      if (receipt.status === "scheduled") {
        const scheduled = await scheduleCodexCleanerPlan({
          stateDir: params.stateDir,
          sessionId: request.sessionId,
          cleanPlanId: request.cleanPlanId,
          baseRevision: request.baseRevision,
          selectedTaskIds,
          scheduledAt: receipt.updatedAt,
        });
        if (scheduled.outcome !== "stored" && scheduled.outcome !== "unchanged") {
          throw new Error(`codex_clean_schedule_failed:${scheduled.reasons.join(",")}`);
        }
      }
      return receipt;
    },
    async readCleanReceipt(planId) {
      if (!planId.trim()) throw new Error("codex_clean_plan_id_invalid");
      const receipt = await params.controlPlane.readCleanReceipt(planId);
      return receipt ? validateReceipt({ receipt, planId }) : undefined;
    },
    async cancelCleanPlan(planId) {
      if (!planId.trim()) throw new Error("codex_clean_plan_id_invalid");
      return validateReceipt({
        receipt: await params.controlPlane.cancelCleanPlan(planId),
        planId,
      });
    },
  };
}
