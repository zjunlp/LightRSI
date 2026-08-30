import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanPreparedExecution,
} from "@lightrsi/cleaner";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextRewriteResult,
} from "@lightrsi/host-adapter";

import { buildClaudeCleanerAppliedReceipt } from "../src/context-cleaner/applied-receipt.js";

function execution(): ContextCleanPreparedExecution {
  return {
    cleanPlanId: "clean-plan-1",
    hostId: "claude-code",
    sessionId: "claude-session-1",
    baseRevision: "revision-before",
    selectedTasks: [{
      taskId: "task-completed",
      itemIds: ["item-1"],
      itemDigests: { "item-1": "digest-1" },
    }],
    mutationPlan: {
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      planId: "mutation-plan-1",
      hostId: "claude-code",
      sessionId: "claude-session-1",
      baseRevision: "revision-before",
      sourceModuleId: "cleaner_manual",
      createdAt: "2026-08-28T00:00:00.000Z",
      operations: [{
        id: "operation-1",
        type: "replace",
        targetItemIds: ["item-1"],
        targetItemFingerprints: { "item-1": "digest-1" },
        rationale: "user approved completed task cleanup",
        estimatedSavedChars: 99,
      }],
    },
    scheduledReceipt: {
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      planId: "clean-plan-1",
      hostId: "claude-code",
      sessionId: "claude-session-1",
      status: "scheduled",
      selectedTaskIds: ["task-completed"],
      estimatedSavedTokens: null,
      estimatedSavedChars: 99,
      tokenCountMode: "chars_only",
      deferredTaskIds: [],
      fallbackUsed: false,
      reasons: [],
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  };
}

function rewrite(overrides: Partial<ContextRewriteResult> = {}): ContextRewriteResult {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    mode: "request_overlay",
    planId: "mutation-plan-1",
    applied: true,
    changed: true,
    previousRevision: "revision-before",
    nextRevision: "revision-after",
    appliedOperationIds: ["operation-1"],
    deferredOperationIds: [],
    removedItemIds: ["item-1"],
    savedChars: 7,
    fallbackUsed: false,
    ...overrides,
  };
}

test("records actual Claude overlay savings and complete rewrite evidence", () => {
  const built = buildClaudeCleanerAppliedReceipt({
    execution: execution(),
    rewriteResult: rewrite(),
    overlayId: "claude-overlay-1",
    updatedAt: "2026-08-28T00:00:01.000Z",
  });

  assert.deepEqual(built.reasons, []);
  assert.equal(built.receipt?.status, "applied");
  assert.equal(built.receipt?.appliedSavedChars, 7);
  assert.equal(built.receipt?.appliedSavedTokens, null);
  assert.deepEqual(built.receipt?.evidence, {
    previousRevision: "revision-before",
    nextRevision: "revision-after",
    operationIds: ["operation-1"],
    itemIds: ["item-1"],
    eventIds: ["claude-overlay:claude-overlay-1"],
  });
});

test("rejects a partial or fallback Claude overlay instead of issuing applied", () => {
  for (const candidate of [
    rewrite({ removedItemIds: [], savedChars: 0, applied: false, changed: false }),
    rewrite({ fallbackUsed: true }),
    rewrite({ appliedOperationIds: ["other-operation"] }),
  ]) {
    const built = buildClaudeCleanerAppliedReceipt({
      execution: execution(),
      rewriteResult: candidate,
      overlayId: "claude-overlay-1",
      updatedAt: "2026-08-28T00:00:01.000Z",
    });
    assert.equal(built.receipt, undefined);
    assert.deepEqual(built.reasons, ["claude_cleaner_receipt_rewrite_evidence_invalid"]);
  }
});
