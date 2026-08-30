import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanerControlPlane,
  type ContextCleanerHostBridge,
  type ContextCleanReceipt,
  type ExecuteApprovedContextCleanParams,
} from "@lightrsi/cleaner";

import { readLatestClaudeSnapshotRecord } from "../context-rewrite/snapshot-store.js";
import { listClaudeCleanerSessions } from "./session-catalog.js";
import { scheduleClaudeCleanerPlan } from "./scheduler.js";

const CLAUDE_HOST_ID = "claude-code";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizedUniqueStrings(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized = values.map((value) => (
    typeof value === "string" ? value.trim() : ""
  ));
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
    const operationIds = normalizedUniqueStrings(evidence?.operationIds);
    const itemIds = normalizedUniqueStrings(evidence?.itemIds);
    return receipt.fallbackUsed === false
      && nullableNonNegativeInteger(receipt.appliedSavedTokens)
      && nonNegativeInteger(receipt.appliedSavedChars)
      && typeof evidence?.previousRevision === "string"
      && Boolean(evidence.previousRevision.trim())
      && typeof evidence?.nextRevision === "string"
      && Boolean(evidence.nextRevision.trim())
      && operationIds !== undefined
      && operationIds.length > 0
      && itemIds !== undefined
      && itemIds.length > 0;
  }
  if (!["analyzed", "approved", "scheduled", "stale", "cancelled", "failed"].includes(receipt.status)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(record, "appliedSavedTokens")
    || Object.prototype.hasOwnProperty.call(record, "appliedSavedChars")) {
    return false;
  }
  return !["analyzed", "approved", "scheduled"].includes(receipt.status)
    || receipt.fallbackUsed === false;
}

function validateApprovedRequest(request: ExecuteApprovedContextCleanParams): string[] {
  if (request.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION) {
    throw new Error("claude_clean_approval_schema_mismatch");
  }
  if (request.hostId !== CLAUDE_HOST_ID) {
    throw new Error("claude_clean_approval_host_mismatch");
  }
  if (typeof request.cleanPlanId !== "string"
    || !request.cleanPlanId.trim()
    || typeof request.sessionId !== "string"
    || !request.sessionId.trim()
    || typeof request.baseRevision !== "string"
    || !request.baseRevision.trim()
    || !canonicalTimestamp(request.approvedAt)
    || !Array.isArray(request.selectedTasks)
    || request.selectedTasks.length === 0) {
    throw new Error("claude_clean_approval_invalid");
  }
  const taskIds = normalizedUniqueStrings(request.selectedTasks.map((task) => (
    isRecord(task) ? task.taskId : undefined
  )));
  if (!taskIds) throw new Error("claude_clean_approval_invalid");
  const claimedItemIds = new Set<string>();
  for (const task of request.selectedTasks) {
    if (!isRecord(task)) throw new Error("claude_clean_approval_targets_invalid");
    const itemIds = normalizedUniqueStrings(task.itemIds);
    const itemDigests = isRecord(task.itemDigests) ? task.itemDigests : undefined;
    if (!itemIds
      || itemIds.length === 0
      || !itemDigests
      || Object.keys(itemDigests).length !== itemIds.length) {
      throw new Error("claude_clean_approval_targets_invalid");
    }
    for (const itemId of itemIds) {
      if (claimedItemIds.has(itemId)
        || typeof itemDigests[itemId] !== "string"
        || !itemDigests[itemId]!.trim()) {
        throw new Error("claude_clean_approval_targets_invalid");
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
  if (!isRecord(params.receipt)) throw new Error("claude_clean_receipt_mismatch");
  const { receipt } = params;
  const selectedTaskIds = normalizedUniqueStrings(receipt.selectedTaskIds);
  if (receipt.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION
    || receipt.hostId !== CLAUDE_HOST_ID
    || receipt.planId !== params.planId
    || (params.sessionId !== undefined && receipt.sessionId !== params.sessionId)
    || !canonicalTimestamp(receipt.updatedAt)
    || !selectedTaskIds
    || !validReceiptState(receipt)) {
    throw new Error("claude_clean_receipt_mismatch");
  }
  if (params.selectedTaskIds) {
    const expected = [...params.selectedTaskIds].sort();
    const actual = [...selectedTaskIds].sort();
    if (expected.length !== actual.length
      || expected.some((taskId, index) => taskId !== actual[index])) {
      throw new Error("claude_clean_receipt_mismatch");
    }
  }
  return receipt;
}

export function createClaudeCodeContextCleanerBridge(params: {
  stateDir: string;
  controlPlane: ContextCleanerControlPlane;
}): ContextCleanerHostBridge {
  return {
    hostId: CLAUDE_HOST_ID,
    rewriteMode: "request_overlay",
    async listSessions() {
      return listClaudeCleanerSessions(params.stateDir);
    },
    async readCleanSnapshot(sessionId) {
      const record = await readLatestClaudeSnapshotRecord(params.stateDir, sessionId);
      if (!record) throw new Error("claude_clean_snapshot_unavailable");
      return {
        ...record.snapshot,
        capturedAt: record.storedAt,
        ...(record.model ? { model: record.model } : {}),
        tokenCountMode: "chars_only",
        tokenCountMethod: "utf16_chars",
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
        const scheduled = await scheduleClaudeCleanerPlan({
          stateDir: params.stateDir,
          sessionId: request.sessionId,
          cleanPlanId: request.cleanPlanId,
          baseRevision: request.baseRevision,
          selectedTaskIds,
          scheduledAt: receipt.updatedAt,
        });
        if (scheduled.outcome !== "stored" && scheduled.outcome !== "unchanged") {
          throw new Error(`claude_clean_schedule_failed:${scheduled.reasons.join(",")}`);
        }
      }
      return receipt;
    },
    async readCleanReceipt(planId) {
      if (!planId.trim()) throw new Error("claude_clean_plan_id_invalid");
      const receipt = await params.controlPlane.readCleanReceipt(planId);
      return receipt ? validateReceipt({ receipt, planId }) : undefined;
    },
    async cancelCleanPlan(planId) {
      if (!planId.trim()) throw new Error("claude_clean_plan_id_invalid");
      return validateReceipt({
        receipt: await params.controlPlane.cancelCleanPlan(planId),
        planId,
      });
    },
  };
}
