import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanExecutionRequest,
  type ContextCleanerHostExecutionBridge,
  type ContextCleanerHostBridge,
  type ContextCleanPendingReceipt,
  type ContextCleanReceipt,
  type ContextCleanSnapshot,
  type ContextCleanTerminalReceipt,
  isAppliedContextCleanReceipt,
} from "../src/index.js";
import { samplePlan, sampleSnapshot } from "./fixtures.js";

function pendingReceipt(
  status: ContextCleanPendingReceipt["status"],
): ContextCleanPendingReceipt {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: "clean-plan-1",
    hostId: "fake-host",
    sessionId: "session-1",
    status,
    selectedTaskIds: ["task-a"],
    estimatedSavedTokens: 50,
    estimatedSavedChars: 200,
    tokenCountMode: "estimated",
    deferredTaskIds: [],
    fallbackUsed: false,
    reasons: [],
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function terminalReceipt(
  status: ContextCleanTerminalReceipt["status"],
): ContextCleanTerminalReceipt {
  return {
    ...pendingReceipt("scheduled"),
    status,
    fallbackUsed: status === "failed",
  };
}

function snapshot(): ContextCleanSnapshot {
  return {
    ...sampleSnapshot(),
    capturedAt: "2026-08-20T00:00:00.000Z",
    tokenCountMode: "chars_only",
    tokenCountMethod: "utf16_chars",
  };
}

test("fake Host backend satisfies the shared contract without production behavior", async () => {
  const calls: string[] = [];
  const bridge: ContextCleanerHostBridge = {
    hostId: "fake-host",
    rewriteMode: "request_overlay",
    async listSessions() {
      return [{ sessionId: "session-1", updatedAt: "2026-08-20T00:00:00.000Z" }];
    },
    async readCleanSnapshot() {
      return snapshot();
    },
    async executeApprovedClean() {
      calls.push("execute");
      return pendingReceipt("scheduled");
    },
    async readCleanReceipt() {
      calls.push("read");
      return pendingReceipt("scheduled");
    },
    async cancelCleanPlan() {
      calls.push("cancel");
      return terminalReceipt("cancelled");
    },
  };

  assert.equal((await bridge.listSessions())[0]?.sessionId, "session-1");
  assert.equal((await bridge.readCleanSnapshot("session-1")).tokenCountMode, "chars_only");
  assert.equal((await bridge.executeApprovedClean({
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: "clean-plan-1",
      hostId: "fake-host",
      sessionId: "session-1",
      baseRevision: "rev-1",
      approvedAt: "2026-08-20T00:00:00.000Z",
      selectedTasks: [{
        taskId: "task-a",
        itemIds: ["item-a", "item-b"],
        itemDigests: { "item-a": "digest-a", "item-b": "digest-b" },
      }],
    })).status, "scheduled");
  assert.equal((await bridge.readCleanReceipt("clean-plan-1"))?.status, "scheduled");
  assert.equal((await bridge.cancelCleanPlan("clean-plan-1")).status, "cancelled");
  assert.deepEqual(calls, ["execute", "read", "cancel"]);
});

test("approved execution freezes the exact task targets shown to the user", async () => {
  let capturedTaskIds: string[] = [];
  const bridge: ContextCleanerHostBridge = {
    hostId: "fake-host",
    rewriteMode: "request_overlay",
    async listSessions() {
      return [];
    },
    async readCleanSnapshot() {
      return snapshot();
    },
    async executeApprovedClean(params) {
      capturedTaskIds = params.selectedTasks.flatMap((task) => task.itemIds);
      return pendingReceipt("scheduled");
    },
    async readCleanReceipt() {
      return undefined;
    },
    async cancelCleanPlan() {
      return terminalReceipt("cancelled");
    },
  };

  await bridge.executeApprovedClean({
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    cleanPlanId: samplePlan().planId,
    hostId: bridge.hostId,
    sessionId: "session-1",
    baseRevision: "rev-1",
    approvedAt: "2026-08-20T00:00:00.000Z",
    selectedTasks: [samplePlan().tasks[0]!],
  });

  assert.deepEqual(capturedTaskIds, ["item-a", "item-b"]);
});

test("only applied receipts expose actual savings", () => {
  const scheduled = pendingReceipt("scheduled");
  assert.equal(isAppliedContextCleanReceipt(scheduled), false);

  const applied: ContextCleanReceipt = {
    ...pendingReceipt("scheduled"),
    status: "applied",
    appliedSavedTokens: 40,
    appliedSavedChars: 160,
    fallbackUsed: false,
    evidence: {
      previousRevision: "rev-1",
      nextRevision: "rev-2",
      operationIds: ["operation-1"],
      itemIds: ["item-a", "item-b"],
    },
  };
  assert.equal(isAppliedContextCleanReceipt(applied), true);
  if (isAppliedContextCleanReceipt(applied)) {
    assert.equal(applied.appliedSavedChars, 160);
  }
});

const receiptBase = {
  schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
  planId: "clean-plan-invalid",
  hostId: "fake-host",
  sessionId: "session-1",
  selectedTaskIds: ["task-a"],
  estimatedSavedTokens: 50,
  estimatedSavedChars: 200,
  tokenCountMode: "estimated" as const,
  deferredTaskIds: [],
  fallbackUsed: false,
  reasons: [],
  updatedAt: "2026-08-20T00:00:00.000Z",
};

// @ts-expect-error Applied receipts require measured savings and rewrite evidence.
const appliedWithoutEvidence: ContextCleanReceipt = {
  ...receiptBase,
  status: "applied",
};
void appliedWithoutEvidence;

// @ts-expect-error Scheduled receipts must not report applied savings.
const scheduledWithAppliedSavings: ContextCleanReceipt = {
  ...receiptBase,
  status: "scheduled",
  appliedSavedTokens: 40,
  appliedSavedChars: 160,
};
void scheduledWithAppliedSavings;

test("shared plan fixture is data-only and contains no raw Host payload", () => {
  const plan = samplePlan();
  assert.equal(plan.schemaVersion, CONTEXT_CLEAN_SCHEMA_VERSION);
  assert.equal(plan.tasks[0]?.recommendation, "clean");
  assert.equal("adapterMetadata" in plan, false);
  assert.equal(
    plan.tasks.reduce((total, task) => total + task.charCount, 0)
      + plan.protectedChars
      + plan.unassignedChars,
    plan.usedChars,
  );
  assert.equal(
    plan.tasks.reduce((total, task) => total + (task.tokenCount ?? 0), 0)
      + (plan.protectedTokens ?? 0)
      + (plan.unassignedTokens ?? 0),
    plan.usedTokens,
  );
});

// @ts-expect-error A fallback sends original context and cannot be applied.
const appliedWithFallback: ContextCleanReceipt = {
  ...receiptBase,
  status: "applied",
  fallbackUsed: true,
  appliedSavedTokens: 40,
  appliedSavedChars: 160,
  evidence: {
    previousRevision: "rev-1",
    nextRevision: "rev-2",
    operationIds: ["operation-1"],
    itemIds: ["item-a"],
  },
};
void appliedWithFallback;

const executionRequest: ContextCleanExecutionRequest = {
  cleanPlanId: "clean-plan-1",
  sessionId: "session-1",
  baseRevision: "rev-1",
  selectedTaskIds: ["task-a"],
};
void executionRequest;

const fakeExecutionBridge: ContextCleanerHostExecutionBridge = {
  hostId: "fake-host",
  async prepareScheduledClean() {
    return {
      outcome: "missing",
      bypassed: false,
      reasons: ["clean_execution_missing"],
    };
  },
  async recordCleanReceipt() {
    return {
      outcome: "missing",
      bypassed: true,
      reasons: ["clean_execution_missing"],
    };
  },
};
void fakeExecutionBridge;

const executionRequestWithCallerSelectedItems: ContextCleanExecutionRequest = {
  ...executionRequest,
  // @ts-expect-error Runtime callers cannot replace the item scope frozen in the stored plan.
  itemIds: ["item-a"],
};
void executionRequestWithCallerSelectedItems;
