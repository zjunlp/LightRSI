import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  handleCleanCommand,
  registerCleanCommandBackendResolver,
  type CleanCommandBackend,
} from "../src/clean.js";
import type { CleanPlanView, CleanReceiptView } from "../src/clean-renderer.js";
import { dispatchCli } from "../src/dispatch.js";

function plan(): CleanPlanView {
  return {
    planId: "plan-1", hostId: "codex", sessionId: "session-1", usedTokens: 80,
    usedChars: 320, protectedTokens: 10, protectedChars: 40, unassignedTokens: 0,
    unassignedChars: 0, tokenCountMode: "estimated",
    tasks: [
      { taskId: "task-a", label: "Finished work", description: "Finished the work", lifecycleState: "completed", tokenCount: 60,
        charCount: 240, tokenPercent: 75, recommendation: "clean", reasonCodes: [], selectable: true },
      { taskId: "task-current", label: "Current work", description: "Current work", lifecycleState: "active", tokenCount: 20,
        charCount: 80, tokenPercent: 25, recommendation: "protected", reasonCodes: [], selectable: false },
    ],
  };
}

function receipt(status = "scheduled", selectedTaskIds = ["task-a"]): CleanReceiptView {
  return { planId: "plan-1", status, selectedTaskIds, estimatedSavedTokens: 60,
    estimatedSavedChars: 240, deferredTaskIds: [], reasons: [] };
}

function backend(calls: string[]): CleanCommandBackend {
  return {
    async analyze(sessionId) { calls.push(`analyze:${sessionId}`); return plan(); },
    async readPlan(planId) { calls.push(`plan:${planId}`); return planId === "plan-1" ? plan() : undefined; },
    async approve(planId, taskIds) { calls.push(`approve:${planId}:${taskIds.join(",")}`); return receipt(); },
    async readReceipt(planId) { calls.push(`receipt:${planId}`); return receipt(); },
    async cancel(planId) { calls.push(`cancel:${planId}`); return receipt("cancelled"); },
  };
}

test("interactive clean analyzes, prompts by task id, and approves selection", async () => {
  const calls: string[] = [];
  const result = await handleCleanCommand({
    args: [], sessionId: "session-1", backend: backend(calls), interactive: true,
    async prompt() { return ["task-a"]; },
  });
  assert.deepEqual(calls, ["analyze:session-1", "approve:plan-1:task-a"]);
  assert.match(result.text, /Context clean scheduled/);
  assert.match(result.text, /next Host request/);
});

test("explicit plan selection supports scripts and rejects protected tasks", async () => {
  const calls: string[] = [];
  const accepted = await handleCleanCommand({
    args: ["--plan", "plan-1", "--select", "task-a"], backend: backend(calls), interactive: false,
  });
  assert.match(accepted.text, /Context clean scheduled/);
  await assert.rejects(
    handleCleanCommand({
      args: ["--plan", "plan-1", "--select", "task-current"], backend: backend([]), interactive: false,
    }),
    /clean_selection_task_protected:task-current/,
  );
});

test("status and cancel do not re-run analysis", async () => {
  const calls: string[] = [];
  await handleCleanCommand({ args: ["--status", "plan-1"], backend: backend(calls) });
  await handleCleanCommand({ args: ["--cancel", "plan-1"], backend: backend(calls) });
  assert.deepEqual(calls, ["receipt:plan-1", "cancel:plan-1"]);
});

test("dispatch registers clean without coupling the controller to a Host adapter", async () => {
  const home = await mkdtemp(join(tmpdir(), "lightrsi-cli-clean-dispatch-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const calls: string[] = [];
  registerCleanCommandBackendResolver(() => backend(calls));
  try {
    const result = await dispatchCli(["codex", "clean", "--session", "session-1"]);
    assert.deepEqual(calls, ["analyze:session-1"]);
    assert.match(result.text, /Context clean plan plan-1/);
  } finally {
    registerCleanCommandBackendResolver(undefined);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(home, { recursive: true, force: true });
  }
});

test("clean help is available before a Host backend is registered", async () => {
  registerCleanCommandBackendResolver(undefined);
  const result = await dispatchCli(["codex", "clean", "--help"]);
  assert.match(result.text, /clean --status <plan-id>/);
  assert.match(result.text, /clean \[--session <session-id>\]/);
});
