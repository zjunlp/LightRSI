import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  analyzeContextCleanSession,
  CONTEXT_CLEAN_SCHEMA_VERSION,
  createContextCleanerControlPlane,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ExecuteApprovedContextCleanParams,
} from "@lightrsi/cleaner";
import {
  createEmptySessionTaskRegistry,
  loadCanonicalState,
  persistSessionTaskRegistry,
  saveCanonicalState,
} from "@lightrsi/history";
import { writeJsonFileAtomic } from "@lightrsi/host-adapter";

import { pluginStateSubdir } from "@lightrsi/artifact-store";
import { createOpenClawContextCleanerBridge } from "./bridge.js";

const SESSION_ID = "openclaw-clean-session";
const NOW = "2026-08-31T00:01:00.000Z";

function task(taskId: string, lifecycle: "active" | "evictable") {
  return {
    taskId,
    title: taskId,
    objective: `Objective for ${taskId}`,
    lifecycle,
    ...(lifecycle === "evictable" ? { evictableReason: "completed" } : {}),
    completionEvidence: lifecycle === "evictable" ? ["delivered"] : [],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${taskId}-turn-1`,
      lastTurnAbsId: `${taskId}-turn-1`,
      supportingTurnAbsIds: [`${taskId}-turn-1`],
      lastEstimatorTurnAbsId: `${taskId}-turn-1`,
    },
  };
}

function message(messageId: string, taskId: string, content: string, role = "assistant") {
  return {
    messageId,
    role,
    content,
    details: {
      contextSafe: {
        taskIds: [taskId],
        turnAbsId: `${taskId}-turn-1`,
      },
    },
  };
}

async function seed(stateDir: string): Promise<void> {
  await saveCanonicalState(stateDir, {
    version: 1,
    sessionId: SESSION_ID,
    messages: [
      message("completed-user", "task-completed", "Investigate the completed issue", "user"),
      message("completed-answer", "task-completed", "The completed task delivered a detailed final result."),
      message("active-user", "task-active", "Continue the active task", "user"),
    ],
    seenMessageIds: ["completed-user", "completed-answer", "active-user"],
    updatedAt: "2026-08-31T00:00:00.000Z",
  });
  const registry = createEmptySessionTaskRegistry(SESSION_ID);
  registry.tasks = {
    "task-completed": task("task-completed", "evictable"),
    "task-active": task("task-active", "active"),
  };
  registry.completedTaskIds = ["task-completed"];
  registry.evictableTaskIds = ["task-completed"];
  registry.activeTaskIds = ["task-active"];
  await persistSessionTaskRegistry(stateDir, registry);
}

function approval(plan: ContextCleanPlan): ExecuteApprovedContextCleanParams {
  const selected = plan.tasks.find((entry) => entry.taskId === "task-completed");
  assert.ok(selected?.selectable);
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    cleanPlanId: plan.planId,
    hostId: "openclaw",
    sessionId: plan.sessionId,
    baseRevision: plan.baseRevision,
    approvedAt: NOW,
    selectedTasks: [{
      taskId: selected.taskId,
      itemIds: [...selected.itemIds],
      itemDigests: { ...selected.itemDigests },
    }],
  };
}

async function analyzed(stateDir: string) {
  const controlPlane = createContextCleanerControlPlane({ stateDir, now: () => NOW });
  const bridge = createOpenClawContextCleanerBridge({
    stateDir,
    controlPlane,
    config: { replacementMode: "drop", now: () => NOW },
  });
  const result = await analyzeContextCleanSession({
    stateDir,
    bridge,
    sessionId: SESSION_ID,
  });
  return { bridge, controlPlane, plan: result.plan };
}

test("lists canonical sessions and exposes a chars-only cleaner snapshot", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-catalog-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge } = await analyzed(stateDir);

  assert.deepEqual(await bridge.listSessions(), [{
    sessionId: SESSION_ID,
    updatedAt: "2026-08-31T00:00:00.000Z",
  }]);
  const snapshot = await bridge.readCleanSnapshot(SESSION_ID);
  assert.equal(snapshot.hostId, "openclaw");
  assert.equal(snapshot.tokenCountMode, "chars_only");
  assert.equal(snapshot.tokenCountMethod, "utf16_chars");
  assert.equal(snapshot.items.length, 3);
});

test("applies an approved plan immediately, archives first, and persists an applied receipt", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-apply-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, plan } = await analyzed(stateDir);
  const request = approval(plan);

  const receipt = await bridge.executeApprovedClean(request);

  assert.equal(receipt.status, "applied");
  if (receipt.status !== "applied") return;
  assert.equal(receipt.appliedSavedTokens, null);
  assert.ok(receipt.appliedSavedChars > 0);
  assert.equal(receipt.evidence.previousRevision, plan.baseRevision);
  assert.notEqual(receipt.evidence.nextRevision, plan.baseRevision);
  assert.deepEqual(receipt.selectedTaskIds, ["task-completed"]);
  assert.ok(receipt.evidence.itemIds.includes("completed-user"));

  const state = await loadCanonicalState(stateDir, SESSION_ID);
  assert.deepEqual(state?.messages.map((entry) => entry.messageId), ["active-user"]);
  const archiveDir = pluginStateSubdir(stateDir, "canonical-eviction", "task");
  assert.ok((await readdir(archiveDir)).some((name) => name.endsWith(".json")));
  assert.equal((await bridge.readCleanReceipt(plan.planId))?.status, "applied");

  const replayed = await bridge.executeApprovedClean(request);
  assert.deepEqual(replayed, receipt);
});

test("marks a plan stale when canonical state changes after analysis", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-stale-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, plan } = await analyzed(stateDir);
  const state = await loadCanonicalState(stateDir, SESSION_ID);
  assert.ok(state);
  state.messages.push(message("new-active", "task-active", "A newer active turn", "user"));
  state.seenMessageIds.push("new-active");
  state.updatedAt = "2026-08-31T00:02:00.000Z";
  await saveCanonicalState(stateDir, state);

  const receipt = await bridge.executeApprovedClean(approval(plan));

  assert.equal(receipt.status, "stale");
  assert.ok(receipt.reasons.some((reason) => reason.includes("revision")));
  assert.equal((await loadCanonicalState(stateDir, SESSION_ID))?.messages.length, 4);
});

test("serializes competing cleaner applies before scheduling either mutation", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-lock-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, plan } = await analyzed(stateDir);
  const key = createHash("sha256").update(SESSION_ID).digest("hex");
  const lockDir = join(stateDir, "context-cleaner", "openclaw-locks");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, `${key}.lock`), JSON.stringify({ pid: 1 }), "utf8");

  await assert.rejects(
    bridge.executeApprovedClean(approval(plan)),
    /openclaw_clean_session_busy/,
  );
  assert.equal((await bridge.readCleanReceipt(plan.planId))?.status, "analyzed");
});

test("recovers an applied receipt when canonical persistence completed before receipt commit", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-cleaner-recovery-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  await seed(stateDir);
  const { bridge, controlPlane, plan } = await analyzed(stateDir);
  const request = approval(plan);
  const scheduled = await controlPlane.executeApprovedClean(request);
  assert.equal(scheduled.status, "scheduled");
  if (scheduled.status !== "scheduled") return;

  const before = await bridge.readCleanSnapshot(SESSION_ID);
  const nextState = await loadCanonicalState(stateDir, SESSION_ID);
  assert.ok(nextState);
  nextState.messages = nextState.messages.filter((entry) => entry.messageId === "active-user");
  nextState.updatedAt = "2026-08-31T00:03:00.000Z";
  await saveCanonicalState(stateDir, nextState);
  const after = await bridge.readCleanSnapshot(SESSION_ID);
  const applied: ContextCleanReceipt = {
    ...scheduled,
    status: "applied",
    appliedSavedTokens: null,
    appliedSavedChars: 80,
    fallbackUsed: false,
    evidence: {
      previousRevision: before.revision,
      nextRevision: after.revision,
      operationIds: ["recovered-operation"],
      itemIds: ["completed-user", "completed-answer"],
    },
  };
  const key = createHash("sha256").update(plan.planId).digest("hex");
  const intentFile = join(stateDir, "context-cleaner", "openclaw-apply", `${key}.json`);
  await writeJsonFileAtomic(intentFile, {
    version: 1,
    planId: plan.planId,
    sessionId: SESSION_ID,
    previousRevision: before.revision,
    nextRevision: after.revision,
    receipt: applied,
  });

  const recovered = await bridge.readCleanReceipt(plan.planId);

  assert.deepEqual(recovered, applied);
  await assert.rejects(readFile(intentFile, "utf8"), { code: "ENOENT" });
});
