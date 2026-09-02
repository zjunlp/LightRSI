import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  saveContextCleanPlan,
  type ContextCleanPlan,
} from "@lightrsi/cleaner";

import { resolveCleanCommandBackend } from "../src/clean.js";
import { dispatchCli } from "../src/dispatch.js";
import { createHostCleanCommandBackend } from "../src/hosts/cleaner.js";
import { registerBuiltInCliHostProducts } from "../src/hosts/factory.js";

function plan(): ContextCleanPlan {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: "plan-host-registration",
    hostId: "codex",
    sessionId: "session-1",
    baseRevision: "revision-1",
    usedTokens: 50,
    usedChars: 200,
    protectedTokens: 0,
    protectedChars: 0,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "estimated",
    tokenCountMethod: "fixture",
    tasks: [{
      taskId: "task-a",
      label: "Finished task",
      description: "Finished task description",
      summary: "Finished task summary",
      lifecycleState: "completed",
      itemIds: ["item-a"],
      itemDigests: { "item-a": "digest-a" },
      tokenCount: 50,
      charCount: 200,
      tokenPercent: 100,
      recommendation: "clean",
      reasonCodes: ["completed_and_cold"],
      selectable: true,
    }],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

test("Host backend recovers frozen item targets from the stored plan", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-cli-clean-host-"));
  try {
    await saveContextCleanPlan({ stateDir, plan: plan() });
    const backend = createHostCleanCommandBackend({
      stateDir,
      recommendationEnabled: false,
      recommendationConfig: {},
      now: () => "2026-08-30T00:01:00.000Z",
      createBridge(controlPlane) {
        return {
          hostId: "codex",
          rewriteMode: "response_chain_rebase",
          async listSessions() { return []; },
          async readCleanSnapshot() { throw new Error("unused"); },
          executeApprovedClean(request) { return controlPlane.executeApprovedClean(request); },
          readCleanReceipt(planId) { return controlPlane.readCleanReceipt(planId); },
          cancelCleanPlan(planId) { return controlPlane.cancelCleanPlan(planId); },
        };
      },
    });
    const stored = await backend.readPlan(plan().planId);
    assert.deepEqual(stored?.tasks.map((task) => task.taskId), ["task-a"]);
    const receipt = await backend.approve(plan().planId, ["task-a"]);
    assert.equal(receipt.status, "scheduled");
    assert.deepEqual(receipt.selectedTaskIds, ["task-a"]);
    assert.equal(receipt.estimatedSavedTokens, 50);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("built-in lookup creates Codex, Claude, and OpenClaw cleaner backends", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-cli-clean-lookup-"));
  const originalOpenClawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  try {
    const codexConfigPath = join(root, "codex-tokenpilot.json");
    const claudeConfigPath = join(root, "claude-tokenpilot.json");
    await writeFile(codexConfigPath, JSON.stringify({
      stateDir: join(root, "codex-state"),
      taskStateEstimator: { enabled: false },
    }), "utf8");
    await writeFile(claudeConfigPath, JSON.stringify({
      stateDir: join(root, "claude-state"),
      upstreamBaseUrl: "https://api.anthropic.com/v1/messages",
      taskStateEstimator: { enabled: false },
    }), "utf8");
    const openClawConfigPath = join(root, "openclaw.json");
    process.env.OPENCLAW_CONFIG_PATH = openClawConfigPath;
    await writeFile(openClawConfigPath, JSON.stringify({
      plugins: {
        entries: {
          tokenpilot: {
            config: {
              stateDir: join(root, "openclaw-state"),
              taskStateEstimator: { enabled: false },
            },
          },
        },
      },
    }), "utf8");

    registerBuiltInCliHostProducts();
    assert.ok(await resolveCleanCommandBackend({
      hostId: "codex",
      pathOverrides: { tokenPilotConfigPath: codexConfigPath },
    }));
    assert.ok(await resolveCleanCommandBackend({
      hostId: "claude-code",
      pathOverrides: { tokenPilotConfigPath: claudeConfigPath },
    }));
    assert.ok(await resolveCleanCommandBackend({ hostId: "openclaw" }));
  } finally {
    if (originalOpenClawConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = originalOpenClawConfigPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("real Codex clean dispatch reaches the registered backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-cli-clean-real-dispatch-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalConfigPath = process.env.TOKENPILOT_CODEX_CONFIG;
  try {
    const configPath = join(root, "codex-tokenpilot.json");
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.TOKENPILOT_CODEX_CONFIG = configPath;
    await writeFile(configPath, JSON.stringify({
      stateDir: join(root, "codex-state"),
      taskStateEstimator: { enabled: false },
    }), "utf8");
    const result = await dispatchCli(["codex", "clean", "--status", "missing-plan"]);
    assert.equal(result.text, "Context clean receipt not found: missing-plan");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalConfigPath === undefined) delete process.env.TOKENPILOT_CODEX_CONFIG;
    else process.env.TOKENPILOT_CODEX_CONFIG = originalConfigPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("real OpenClaw clean dispatch applies a canonical plan immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-cli-openclaw-clean-dispatch-"));
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalSmokeHome = process.env.LIGHTRSI_SMOKE_HOME;
  try {
    const stateDir = join(root, "openclaw-state");
    const configPath = join(root, "openclaw.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.LIGHTRSI_SMOKE_HOME = root;
    await writeFile(configPath, JSON.stringify({
      plugins: { entries: { tokenpilot: { config: {
        stateDir,
        eviction: { replacementMode: "drop" },
        taskStateEstimator: { enabled: false },
      } } } },
    }), "utf8");

    const sessionId = "openclaw-cli-clean-session";
    const canonicalDir = join(stateDir, "tokenpilot", "canonical-state");
    await mkdir(canonicalDir, { recursive: true });
    await writeFile(join(canonicalDir, `${sessionId}.json`), JSON.stringify({
      version: 1,
      sessionId,
      messages: [
        {
          messageId: "completed-item",
          role: "assistant",
          content: "Completed OpenClaw task with enough context to release.",
          details: { contextSafe: { taskIds: ["task-completed"], turnAbsId: "turn-1" } },
        },
        {
          messageId: "active-item",
          role: "user",
          content: "Current task must remain.",
          details: { contextSafe: { taskIds: ["task-active"], turnAbsId: "turn-2" } },
        },
      ],
      seenMessageIds: ["completed-item", "active-item"],
      updatedAt: "2026-08-31T00:00:00.000Z",
    }), "utf8");
    const registryDir = join(stateDir, "task-state", sessionId);
    await mkdir(registryDir, { recursive: true });
    const task = (taskId: string, lifecycle: string, turn: string) => ({
      taskId,
      title: taskId,
      objective: taskId,
      lifecycle,
      completionEvidence: lifecycle === "evictable" ? ["delivered"] : [],
      unresolvedQuestions: [],
      span: {
        firstTurnAbsId: turn,
        lastTurnAbsId: turn,
        supportingTurnAbsIds: [turn],
        lastEstimatorTurnAbsId: turn,
      },
    });
    await writeFile(join(registryDir, "registry.json"), JSON.stringify({
      sessionId,
      version: 1,
      tasks: {
        "task-completed": task("task-completed", "evictable", "turn-1"),
        "task-active": task("task-active", "active", "turn-2"),
      },
      activeTaskIds: ["task-active"],
      completedTaskIds: ["task-completed"],
      evictableTaskIds: ["task-completed"],
      taskToBlockIds: {},
      blockToTaskIds: {},
      turnToTaskIds: {},
      lastProcessedTurnSeq: 2,
    }), "utf8");

    registerBuiltInCliHostProducts();
    const backend = await resolveCleanCommandBackend({ hostId: "openclaw" });
    assert.ok(backend);
    const analyzed = await backend.analyze(sessionId);
    const result = await dispatchCli([
      "openclaw",
      "clean",
      "--plan",
      analyzed.planId,
      "--select",
      "task-completed",
    ]);
    assert.match(result.text, /Context clean applied/);
    assert.match(result.text, /Released:/);
  } finally {
    if (originalConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalSmokeHome === undefined) delete process.env.LIGHTRSI_SMOKE_HOME;
    else process.env.LIGHTRSI_SMOKE_HOME = originalSmokeHome;
    await rm(root, { recursive: true, force: true });
  }
});
