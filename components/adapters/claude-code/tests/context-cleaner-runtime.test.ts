import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  readContextCleanReceipt,
  saveContextCleanPlan,
  transitionContextCleanState,
  type ContextCleanPlan,
  type ContextCleanPendingReceipt,
} from "@lightrsi/cleaner";
import type { SessionTaskRegistry } from "@lightrsi/history";
import type { RuntimeMessage } from "@lightrsi/kernel";
import { attributeClaudeSnapshotTasks } from "../src/context-cleaner/snapshot.js";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";
import {
  finalizeClaudeCleanerOverlay,
  prepareClaudeCleanerOverlay,
} from "../src/context-cleaner/runtime.js";
import { readClaudeCleanerSchedule, scheduleClaudeCleanerPlan } from "../src/context-cleaner/scheduler.js";

const SESSION = "claude-cleaner-runtime-session";
const PLAN = "claude-clean-plan-runtime";
const REVISION = "claude-cleaner-runtime-revision";
const NOW = "2026-08-28T00:00:00.000Z";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-runtime-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("applies one frozen historical Claude overlay and records actual evidence", async () => {
  await withTempState(async (stateDir) => {
    const messages: RuntimeMessage[] = [
      { role: "assistant", content: "EVICT_ME_approved_history" },
      { role: "user", content: "CURRENT_REQUEST" },
    ];
    const rawSnapshot = buildClaudeContextSnapshot({
      sessionId: SESSION,
      revision: REVISION,
      messages,
    });
    const historical = rawSnapshot.items[0]!;
    const baseSnapshot = {
      ...rawSnapshot,
      items: rawSnapshot.items.map((item, index) => ({
        ...item,
        ...(index === 0 ? { taskIds: ["task-completed"] } : {}),
      })),
    };
    const unassignedChars = baseSnapshot.items
      .filter((item) => item.taskIds === undefined)
      .reduce((total, item) => total + item.chars, 0);
    const plan: ContextCleanPlan = {
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      planId: PLAN,
      hostId: "claude-code",
      sessionId: SESSION,
      baseRevision: REVISION,
      usedTokens: null,
      usedChars: baseSnapshot.items.reduce((total, item) => total + item.chars, 0),
      protectedTokens: null,
      protectedChars: 0,
      unassignedTokens: null,
      unassignedChars,
      tokenCountMode: "chars_only",
      tokenCountMethod: "utf16_chars",
      createdAt: NOW,
      tasks: [{
        taskId: "task-completed",
        label: "completed",
        description: "completed task",
        summary: "completed",
        lifecycleState: "completed",
        itemIds: [historical.stableId],
        itemDigests: { [historical.stableId]: historical.fingerprint },
        tokenCount: null,
        charCount: historical.chars,
        tokenPercent: null,
        recommendation: "clean",
        reasonCodes: ["completed"],
        selectable: true,
      }],
    };
    assert.equal((await saveContextCleanPlan({ stateDir, plan })).outcome, "stored");
    const receipt: Omit<ContextCleanPendingReceipt, "status"> = {
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      planId: PLAN,
      hostId: "claude-code",
      sessionId: SESSION,
      selectedTaskIds: ["task-completed"],
      estimatedSavedTokens: null,
      estimatedSavedChars: historical.chars,
      tokenCountMode: "chars_only" as const,
      deferredTaskIds: [],
      fallbackUsed: false as const,
      reasons: [],
      updatedAt: NOW,
    };
    await transitionContextCleanState({ stateDir, receipt: { ...receipt, status: "approved" } });
    await transitionContextCleanState({ stateDir, receipt: { ...receipt, status: "scheduled" } });
    assert.equal((await scheduleClaudeCleanerPlan({
      stateDir,
      sessionId: SESSION,
      cleanPlanId: PLAN,
      baseRevision: REVISION,
      selectedTaskIds: ["task-completed"],
      scheduledAt: NOW,
    })).outcome, "stored");

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot,
      currentSnapshot: baseSnapshot,
      request: { sessionId: SESSION, revision: REVISION, messages },
      activeTaskIds: ["task-current"],
      evictableTaskIds: ["task-completed"],
      now: "2026-08-28T00:00:01.000Z",
    });

    assert.equal(prepared.outcome, "prepared");
    if (prepared.outcome !== "prepared") return;
    assert.equal(prepared.request.messages[0]?.content, "[evicted: earlier content removed]");

    const finalized = await finalizeClaudeCleanerOverlay({
      stateDir,
      prepared,
      now: "2026-08-28T00:00:02.000Z",
    });
    assert.deepEqual(finalized, { outcome: "applied", reasonCodes: [] });
    const applied = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(applied.value?.status, "applied");
    assert.equal(applied.value?.appliedSavedChars, prepared.rewriteResult.savedChars);
    assert.deepEqual(applied.value?.evidence?.itemIds, [historical.stableId]);
    assert.equal((await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION })).outcome, "committed");
  });
});

test("applies every item in an approved, closed Claude tool pair", async () => {
  await withTempState(async (stateDir) => {
    const messages: unknown[] = [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_cleaner_pair",
          name: "Read",
          input: { path: "/repo/old-file.txt" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_cleaner_pair",
          content: "EVICT_TOOL_RESULT_".repeat(80),
        }],
      },
      { role: "user", content: "CURRENT_REQUEST" },
    ];
    const rawSnapshot = buildClaudeContextSnapshot({
      sessionId: SESSION,
      revision: REVISION,
      messages: messages as RuntimeMessage[],
    });
    const registry: SessionTaskRegistry = {
      sessionId: SESSION,
      version: 1,
      tasks: {
        "task-completed": {
          taskId: "task-completed",
          title: "completed",
          objective: "completed",
          lifecycle: "completed",
          completionEvidence: [],
          unresolvedQuestions: [],
          span: {
            firstTurnAbsId: `${SESSION}:t1`,
            lastTurnAbsId: `${SESSION}:t1`,
            supportingTurnAbsIds: [`${SESSION}:t1`],
            lastEstimatorTurnAbsId: `${SESSION}:t1`,
          },
        },
      },
      activeTaskIds: [],
      completedTaskIds: ["task-completed"],
      evictableTaskIds: ["task-completed"],
      taskToBlockIds: {},
      blockToTaskIds: {
        "anthropic-tool-result:toolu_cleaner_pair": ["task-completed"],
      },
      turnToTaskIds: {},
      lastProcessedTurnSeq: 1,
    };
    const snapshot = attributeClaudeSnapshotTasks({
      snapshot: rawSnapshot,
      messages,
      registry,
    });
    const approvedItems = snapshot.items.filter((item) => item.taskIds?.includes("task-completed"));
    assert.deepEqual(approvedItems.map((item) => item.kind), ["tool_call", "tool_result"]);
    const unassignedChars = snapshot.items
      .filter((item) => item.taskIds === undefined)
      .reduce((total, item) => total + item.chars, 0);

    const plan: ContextCleanPlan = {
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      planId: PLAN,
      hostId: "claude-code",
      sessionId: SESSION,
      baseRevision: REVISION,
      usedTokens: null,
      usedChars: snapshot.items.reduce((total, item) => total + item.chars, 0),
      protectedTokens: null,
      protectedChars: 0,
      unassignedTokens: null,
      unassignedChars,
      tokenCountMode: "chars_only",
      tokenCountMethod: "utf16_chars",
      createdAt: NOW,
      tasks: [{
        taskId: "task-completed",
        label: "completed",
        description: "completed task",
        summary: "completed",
        lifecycleState: "completed",
        itemIds: approvedItems.map((item) => item.stableId),
        itemDigests: Object.fromEntries(approvedItems.map((item) => [item.stableId, item.fingerprint])),
        tokenCount: null,
        charCount: approvedItems.reduce((total, item) => total + item.chars, 0),
        tokenPercent: null,
        recommendation: "clean",
        reasonCodes: ["completed"],
        selectable: true,
      }],
    };
    assert.equal((await saveContextCleanPlan({ stateDir, plan })).outcome, "stored");
    const pending: Omit<ContextCleanPendingReceipt, "status"> = {
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      planId: PLAN,
      hostId: "claude-code",
      sessionId: SESSION,
      selectedTaskIds: ["task-completed"],
      estimatedSavedTokens: null,
      estimatedSavedChars: plan.tasks[0]!.charCount,
      tokenCountMode: "chars_only",
      deferredTaskIds: [],
      fallbackUsed: false,
      reasons: [],
      updatedAt: NOW,
    };
    await transitionContextCleanState({ stateDir, receipt: { ...pending, status: "approved" } });
    await transitionContextCleanState({ stateDir, receipt: { ...pending, status: "scheduled" } });
    await scheduleClaudeCleanerPlan({
      stateDir,
      sessionId: SESSION,
      cleanPlanId: PLAN,
      baseRevision: REVISION,
      selectedTaskIds: ["task-completed"],
      scheduledAt: NOW,
    });

    const prepared = await prepareClaudeCleanerOverlay({
      stateDir,
      sessionId: SESSION,
      baseSnapshot: snapshot,
      currentSnapshot: snapshot,
      request: { sessionId: SESSION, revision: REVISION, messages: messages as RuntimeMessage[] },
      activeTaskIds: [],
      evictableTaskIds: ["task-completed"],
      now: "2026-08-28T00:00:01.000Z",
    });

    assert.equal(prepared.outcome, "prepared", JSON.stringify(prepared));
    if (prepared.outcome !== "prepared") return;
    assert.deepEqual(prepared.rewriteResult.removedItemIds, approvedItems.map((item) => item.stableId));
    const toolUse = (prepared.request.messages[0]?.content as Array<Record<string, unknown>>)[0];
    const toolResult = (prepared.request.messages[1]?.content as Array<Record<string, unknown>>)[0];
    assert.deepEqual(toolUse, {
      type: "tool_use",
      id: "toolu_cleaner_pair",
      name: "Read",
      input: {},
    });
    assert.equal(toolResult?.type, "tool_result");
    assert.equal(toolResult?.tool_use_id, "toolu_cleaner_pair");
  });
});
