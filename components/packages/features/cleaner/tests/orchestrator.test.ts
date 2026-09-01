import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionTaskRegistry } from "@lightrsi/history";
import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  analyzeContextCleanSession,
  createContextCleanerControlPlane,
  readContextCleanPlan,
  readContextCleanReceipt,
  type ContextCleanerHostBridge,
  type ContextCleanRecommendationProvider,
  type ContextCleanSnapshot,
} from "../src/index.js";
import { sampleSnapshot } from "./fixtures.js";

const capturedAt = "2026-08-20T00:00:00.000Z";

function registry(): SessionTaskRegistry {
  const span = {
    firstTurnAbsId: "turn-1",
    lastTurnAbsId: "turn-2",
    supportingTurnAbsIds: ["turn-1", "turn-2"],
    lastEstimatorTurnAbsId: "turn-2",
  };
  return {
    sessionId: "session-1",
    version: 1,
    tasks: {
      "task-a": {
        taskId: "task-a",
        title: "Finished task",
        objective: "Finish task A",
        lifecycle: "evictable",
        completionEvidence: ["Delivered"],
        unresolvedQuestions: [],
        span,
      },
      "task-current": {
        taskId: "task-current",
        title: "Current task",
        objective: "Continue current task",
        lifecycle: "active",
        completionEvidence: [],
        unresolvedQuestions: [],
        span,
      },
    },
    activeTaskIds: ["task-current"],
    completedTaskIds: ["task-a"],
    evictableTaskIds: ["task-a"],
    taskToBlockIds: {},
    blockToTaskIds: {},
    turnToTaskIds: {},
    lastProcessedTurnSeq: 2,
  };
}

function snapshot(): ContextCleanSnapshot {
  return {
    ...sampleSnapshot(),
    capturedAt,
    model: "gpt-5.4",
    tokenCountMode: "estimated",
    tokenCountMethod: "fixture",
    itemTokenCounts: { "item-a": 30, "item-b": 20, "item-current": 10 },
  };
}

function bridge(cleanSnapshot: ContextCleanSnapshot = snapshot()): ContextCleanerHostBridge {
  return {
    hostId: "codex",
    rewriteMode: "response_chain_rebase",
    async listSessions() { return [{ sessionId: "session-1" }]; },
    async readCleanSnapshot() { return cleanSnapshot; },
    async executeApprovedClean() { throw new Error("unused"); },
    async readCleanReceipt() { return undefined; },
    async cancelCleanPlan() { throw new Error("unused"); },
  };
}

const provider: ContextCleanRecommendationProvider = {
  async recommend(input) {
    return {
      output: {
        tasks: input.tasks.map((task) => ({
          taskId: task.taskId,
          label: task.label,
          description: task.description,
          summary: task.summary,
          recommendation: task.lifecycleState === "completed" ? "clean" : "keep",
          reasonCodes: task.lifecycleState === "completed" ? ["completed_and_cold"] : [],
          confidence: 0.9,
        })),
      },
    };
  },
};

test("analysis persists an immutable plan and protects the active task", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-orchestrator-"));
  try {
    const result = await analyzeContextCleanSession({
      stateDir: root,
      bridge: bridge(),
      sessionId: "session-1",
      contextWindowTokens: 128_000,
      provider,
      async loadRegistry() { return registry(); },
    });
    assert.match(result.plan.planId, /^ctxclean-[a-f0-9]{24}$/);
    assert.equal(result.plan.contextWindowTokens, 128_000);
    assert.equal(result.fallbackUsed, false);
    assert.deepEqual(result.plan.tasks.map((task) => [task.taskId, task.recommendation, task.selectable]), [
      ["task-a", "clean", true],
      ["task-current", "protected", false],
    ]);
    assert.equal((await readContextCleanPlan({ stateDir: root, planId: result.plan.planId })).value?.status, "analyzed");
    assert.equal((await readContextCleanReceipt({ stateDir: root, planId: result.plan.planId })).value?.status, "analyzed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("control plane validates exact frozen targets and schedules idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-control-plane-"));
  try {
    const analysis = await analyzeContextCleanSession({
      stateDir: root,
      bridge: bridge(),
      sessionId: "session-1",
      provider,
      async loadRegistry() { return registry(); },
    });
    const selected = analysis.plan.tasks.find((task) => task.taskId === "task-a")!;
    const request = {
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: analysis.plan.planId,
      hostId: analysis.plan.hostId,
      sessionId: analysis.plan.sessionId,
      baseRevision: analysis.plan.baseRevision,
      approvedAt: "2026-08-20T00:01:00.000Z",
      selectedTasks: [{
        taskId: selected.taskId,
        itemIds: [...selected.itemIds].reverse(),
        itemDigests: { ...selected.itemDigests },
      }],
    };
    const controlPlane = createContextCleanerControlPlane({
      stateDir: root,
      now: () => "2026-08-20T00:02:00.000Z",
    });
    const scheduled = await controlPlane.executeApprovedClean(request);
    assert.equal(scheduled.status, "scheduled");
    assert.deepEqual(scheduled.selectedTaskIds, ["task-a"]);
    assert.equal(scheduled.estimatedSavedTokens, 50);
    assert.equal(scheduled.estimatedSavedChars, 200);
    assert.deepEqual(await controlPlane.executeApprovedClean(request), scheduled);

    await assert.rejects(
      controlPlane.executeApprovedClean({
        ...request,
        selectedTasks: [{ ...request.selectedTasks[0]!, itemDigests: { "item-a": "changed" } }],
      }),
      /clean_approval_targets_mismatch/,
    );
    const cancelled = await controlPlane.cancelCleanPlan(analysis.plan.planId);
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(await controlPlane.cancelCleanPlan(analysis.plan.planId), cancelled);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing recommendation provider fails closed without making tasks unsafe", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-fallback-"));
  try {
    const result = await analyzeContextCleanSession({
      stateDir: root,
      bridge: bridge(),
      sessionId: "session-1",
      async loadRegistry() { return registry(); },
    });
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(result.reasons, ["recommendation_provider_unavailable"]);
    assert.deepEqual(result.plan.tasks.map((task) => task.recommendation), ["keep", "protected"]);
    const persistedReceipt = await readContextCleanReceipt({ stateDir: root, planId: result.plan.planId });
    assert.equal(persistedReceipt.value?.status, "analyzed");
    assert.equal(persistedReceipt.value?.fallbackUsed, true);

    const selected = result.plan.tasks.find((task) => task.taskId === "task-a")!;
    const controlPlane = createContextCleanerControlPlane({
      stateDir: root,
      now: () => "2026-08-20T00:02:00.000Z",
    });
    const scheduled = await controlPlane.executeApprovedClean({
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: result.plan.planId,
      hostId: result.plan.hostId,
      sessionId: result.plan.sessionId,
      baseRevision: result.plan.baseRevision,
      approvedAt: "2026-08-20T00:01:00.000Z",
      selectedTasks: [{
        taskId: selected.taskId,
        itemIds: selected.itemIds,
        itemDigests: selected.itemDigests,
      }],
    });
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.fallbackUsed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a chars-only plan preserves null token accounting and char savings", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-clean-cancel-chars-"));
  try {
    const charSnapshot: ContextCleanSnapshot = {
      ...sampleSnapshot(),
      capturedAt,
      tokenCountMode: "chars_only",
      tokenCountMethod: "utf16_chars",
    };
    const analysis = await analyzeContextCleanSession({
      stateDir: root,
      bridge: bridge(charSnapshot),
      sessionId: "session-1",
      provider,
      async loadRegistry() { return registry(); },
    });
    const task = analysis.plan.tasks.find((item) => item.taskId === "task-a")!;
    const controlPlane = createContextCleanerControlPlane({
      stateDir: root,
      now: () => "2026-08-20T00:02:00.000Z",
    });
    await controlPlane.executeApprovedClean({
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: analysis.plan.planId,
      hostId: analysis.plan.hostId,
      sessionId: analysis.plan.sessionId,
      baseRevision: analysis.plan.baseRevision,
      approvedAt: "2026-08-20T00:01:00.000Z",
      selectedTasks: [{
        taskId: task.taskId,
        itemIds: task.itemIds,
        itemDigests: task.itemDigests,
      }],
    });
    const cancelled = await controlPlane.cancelCleanPlan(analysis.plan.planId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.estimatedSavedTokens, null);
    assert.equal(cancelled.estimatedSavedChars, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
