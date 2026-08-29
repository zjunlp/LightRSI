import type {
  ContextCleanAppliedReceipt,
  ContextCleanPreparedExecution,
} from "@lightrsi/cleaner";
import type { ContextRewriteResult } from "@lightrsi/host-adapter";

export type ClaudeCleanerAppliedReceiptBuildResult =
  | { receipt: ContextCleanAppliedReceipt; reasons: [] }
  | { receipt?: undefined; reasons: string[] };

function uniqueNonBlankStrings(values: readonly string[]): boolean {
  return values.length > 0
    && values.every((value) => value.trim().length > 0)
    && new Set(values).size === values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/**
 * Builds an applied receipt only from the exact mutation that the Claude
 * request-overlay backend produced. Estimates and partial overlays can never
 * cross this boundary as applied savings.
 */
export function buildClaudeCleanerAppliedReceipt(params: {
  execution: ContextCleanPreparedExecution;
  rewriteResult: ContextRewriteResult;
  overlayId: string;
  updatedAt: string;
}): ClaudeCleanerAppliedReceiptBuildResult {
  const { execution, rewriteResult } = params;
  const operationIds = execution.mutationPlan.operations.map((operation) => operation.id);
  const itemIds = execution.mutationPlan.operations.flatMap((operation) => operation.targetItemIds);
  if (execution.scheduledReceipt.status !== "scheduled"
    || execution.cleanPlanId !== execution.scheduledReceipt.planId
    || execution.hostId !== "claude-code"
    || execution.sessionId !== execution.scheduledReceipt.sessionId
    || execution.mutationPlan.hostId !== "claude-code"
    || execution.mutationPlan.sessionId !== execution.sessionId
    || execution.mutationPlan.sourceModuleId !== "cleaner_manual"
    || !uniqueNonBlankStrings(operationIds)
    || !uniqueNonBlankStrings(itemIds)
    || !params.overlayId.trim()
    || !canonicalTimestamp(params.updatedAt)) {
    return { reasons: ["claude_cleaner_receipt_execution_invalid"] };
  }
  if (rewriteResult.mode !== "request_overlay"
    || rewriteResult.planId !== execution.mutationPlan.planId
    || !rewriteResult.applied
    || !rewriteResult.changed
    || rewriteResult.fallbackUsed
    || !rewriteResult.previousRevision.trim()
    || !rewriteResult.nextRevision.trim()
    || rewriteResult.deferredOperationIds.length > 0
    || !nonNegativeInteger(rewriteResult.savedChars)
    || !sameStringSet(rewriteResult.appliedOperationIds, operationIds)
    || !sameStringSet(rewriteResult.removedItemIds, itemIds)) {
    return { reasons: ["claude_cleaner_receipt_rewrite_evidence_invalid"] };
  }
  return {
    receipt: {
      ...execution.scheduledReceipt,
      status: "applied",
      deferredTaskIds: [],
      fallbackUsed: false,
      reasons: [],
      updatedAt: params.updatedAt,
      appliedSavedTokens: null,
      appliedSavedChars: rewriteResult.savedChars,
      evidence: {
        previousRevision: rewriteResult.previousRevision,
        nextRevision: rewriteResult.nextRevision,
        operationIds,
        itemIds,
        eventIds: [`claude-overlay:${params.overlayId}`],
      },
    },
    reasons: [],
  };
}
