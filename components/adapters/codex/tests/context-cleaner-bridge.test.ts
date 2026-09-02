import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanerControlPlane,
  type ContextCleanAppliedReceipt,
  type ContextCleanPendingReceipt,
  type ContextCleanTerminalReceipt,
  type ExecuteApprovedContextCleanParams,
} from "@lightrsi/cleaner";
import {
  buildTurnAbsId,
  createEmptySessionTaskRegistry,
  persistSessionTaskRegistry,
} from "@lightrsi/history";
import { sessionStateRoot, writeSessionSnapshot } from "@lightrsi/host-adapter";

import {
  appendCodexRequestJournalEntry,
  appendCodexResponseJournalEntry,
} from "../src/context-history/index.js";
import { createCodexContextCleanerBridge } from "../src/context-cleaner/index.js";
import { readCodexCleanerSchedule } from "../src/context-cleaner/scheduler.js";
import { upsertCodexSessionSnapshot } from "../src/session-state.js";

async function withTempState(
  run: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-bridge-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function pendingReceipt(
  status: ContextCleanPendingReceipt["status"],
): ContextCleanPendingReceipt {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: "clean-plan-1",
    hostId: "codex",
    sessionId: "codex-cleaner-session",
    status,
    selectedTaskIds: ["task-1"],
    estimatedSavedTokens: null,
    estimatedSavedChars: 10,
    tokenCountMode: "chars_only",
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

function appliedReceipt(): ContextCleanAppliedReceipt {
  return {
    ...pendingReceipt("scheduled"),
    status: "applied",
    appliedSavedTokens: 2,
    appliedSavedChars: 10,
    evidence: {
      previousRevision: "revision-before",
      nextRevision: "revision-after",
      operationIds: ["operation-1"],
      itemIds: ["item-1"],
    },
  };
}

function fakeControlPlane(): ContextCleanerControlPlane {
  return {
    async executeApprovedClean() { return pendingReceipt("scheduled"); },
    async readCleanReceipt() { return pendingReceipt("scheduled"); },
    async cancelCleanPlan() { return terminalReceipt("cancelled"); },
  };
}

test("Codex cleaner bridge preserves approved targets and control-plane receipts", async () => {
  await withTempState(async (stateDir) => {
  let captured: ExecuteApprovedContextCleanParams | undefined;
  const applied = appliedReceipt();
  const cancelled = terminalReceipt("cancelled");
  const bridge = createCodexContextCleanerBridge({
    stateDir,
    controlPlane: {
      async executeApprovedClean(request) {
        captured = request;
        return pendingReceipt("scheduled");
      },
      async readCleanReceipt() {
        return applied;
      },
      async cancelCleanPlan() {
        return cancelled;
      },
    },
  });
  const request: ExecuteApprovedContextCleanParams = {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    cleanPlanId: "clean-plan-1",
    hostId: "codex",
    sessionId: "codex-cleaner-session",
    baseRevision: "revision-before",
    approvedAt: "2026-08-21T00:00:00.000Z",
    selectedTasks: [{
      taskId: "task-1",
      itemIds: ["item-1", "item-2"],
      itemDigests: {
        "item-1": "digest-1",
        "item-2": "digest-2",
      },
    }],
  };

  const scheduled = await bridge.executeApprovedClean(request);
  assert.strictEqual(captured, request);
  assert.equal(scheduled.status, "scheduled");
  assert.equal("appliedSavedChars" in scheduled, false);
  assert.strictEqual(await bridge.readCleanReceipt(request.cleanPlanId), applied);
  assert.deepEqual(applied.evidence, {
    previousRevision: "revision-before",
    nextRevision: "revision-after",
    operationIds: ["operation-1"],
    itemIds: ["item-1"],
  });
  assert.strictEqual(await bridge.cancelCleanPlan(request.cleanPlanId), cancelled);
  const stored = await readCodexCleanerSchedule({ stateDir, sessionId: request.sessionId });
  assert.equal(stored.outcome, "ready");
  if (stored.outcome === "ready") {
    assert.equal(stored.record.cleanPlanId, request.cleanPlanId);
    assert.equal(stored.record.baseRevision, request.baseRevision);
    assert.deepEqual(stored.record.selectedTaskIds, ["task-1"]);
  }
  });
});

test("Codex cleaner bridge rejects cross-host approvals before control-plane execution", async () => {
  let executions = 0;
  const bridge = createCodexContextCleanerBridge({
    stateDir: "unused-state-dir",
    controlPlane: {
      ...fakeControlPlane(),
      async executeApprovedClean() {
        executions += 1;
        return pendingReceipt("scheduled");
      },
    },
  });

  await assert.rejects(
    bridge.executeApprovedClean({
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: "clean-plan-1",
      hostId: "claude-code",
      sessionId: "codex-cleaner-session",
      baseRevision: "revision-before",
      approvedAt: "2026-08-21T00:00:00.000Z",
      selectedTasks: [{
        taskId: "task-1",
        itemIds: ["item-1"],
        itemDigests: { "item-1": "digest-1" },
      }],
    }),
    /codex_clean_approval_host_mismatch/,
  );
  assert.equal(executions, 0);
});

test("Codex cleaner bridge rejects mutated approval targets", async () => {
  const bridge = createCodexContextCleanerBridge({
    stateDir: "unused-state-dir",
    controlPlane: fakeControlPlane(),
  });

  await assert.rejects(
    bridge.executeApprovedClean({
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: "clean-plan-1",
      hostId: "codex",
      sessionId: "codex-cleaner-session",
      baseRevision: "revision-before",
      approvedAt: "2026-08-21T00:00:00.000Z",
      selectedTasks: [{
        taskId: "task-1",
        itemIds: ["item-1"],
        itemDigests: { "other-item": "digest-1" },
      }],
    }),
    /codex_clean_approval_targets_invalid/,
  );
});

test("Codex cleaner bridge rejects mismatched control-plane receipts", async () => {
  const bridge = createCodexContextCleanerBridge({
    stateDir: "unused-state-dir",
    controlPlane: {
      async executeApprovedClean() {
        return { ...pendingReceipt("scheduled"), hostId: "claude-code" };
      },
      async readCleanReceipt() {
        return { ...pendingReceipt("scheduled"), planId: "other-plan" };
      },
      async cancelCleanPlan() {
        return { ...terminalReceipt("cancelled"), hostId: "openclaw" };
      },
    },
  });
  const request: ExecuteApprovedContextCleanParams = {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    cleanPlanId: "clean-plan-1",
    hostId: "codex",
    sessionId: "codex-cleaner-session",
    baseRevision: "revision-before",
    approvedAt: "2026-08-21T00:00:00.000Z",
    selectedTasks: [{
      taskId: "task-1",
      itemIds: ["item-1"],
      itemDigests: { "item-1": "digest-1" },
    }],
  };

  await assert.rejects(bridge.executeApprovedClean(request), /codex_clean_receipt_mismatch/);
  await assert.rejects(bridge.readCleanReceipt(request.cleanPlanId), /codex_clean_receipt_mismatch/);
  await assert.rejects(bridge.cancelCleanPlan(request.cleanPlanId), /codex_clean_receipt_mismatch/);
});

test("Codex cleaner bridge rejects malformed applied receipts loaded at runtime", async () => {
  const malformed = {
    ...pendingReceipt("scheduled"),
    status: "applied",
    fallbackUsed: true,
    appliedSavedTokens: 2,
    appliedSavedChars: 10,
  } as unknown as ContextCleanAppliedReceipt;
  const bridge = createCodexContextCleanerBridge({
    stateDir: "unused-state-dir",
    controlPlane: {
      ...fakeControlPlane(),
      async readCleanReceipt() {
        return malformed;
      },
    },
  });

  await assert.rejects(
    bridge.readCleanReceipt("clean-plan-1"),
    /codex_clean_receipt_mismatch/,
  );
});

test("Codex cleaner bridge does not schedule a non-scheduled control-plane receipt", async () => {
  await withTempState(async (stateDir) => {
    const bridge = createCodexContextCleanerBridge({
      stateDir,
      controlPlane: {
        ...fakeControlPlane(),
        async executeApprovedClean() {
          return pendingReceipt("approved");
        },
      },
    });
    const receipt = await bridge.executeApprovedClean({
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: "clean-plan-1",
      hostId: "codex",
      sessionId: "codex-cleaner-session",
      baseRevision: "revision-before",
      approvedAt: "2026-08-21T00:00:00.000Z",
      selectedTasks: [{
        taskId: "task-1",
        itemIds: ["item-1"],
        itemDigests: { "item-1": "digest-1" },
      }],
    });
    assert.equal(receipt.status, "approved");
    assert.equal((await readCodexCleanerSchedule({
      stateDir,
      sessionId: "codex-cleaner-session",
    })).outcome, "missing");
  });
});

test("Codex cleaner bridge preserves conservative recommendation fallback through scheduling", async () => {
  await withTempState(async (stateDir) => {
    const bridge = createCodexContextCleanerBridge({
      stateDir,
      controlPlane: {
        ...fakeControlPlane(),
        async executeApprovedClean() {
          return { ...pendingReceipt("scheduled"), fallbackUsed: true };
        },
      },
    });
    const receipt = await bridge.executeApprovedClean({
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      cleanPlanId: "clean-plan-1",
      hostId: "codex",
      sessionId: "codex-cleaner-session",
      baseRevision: "revision-before",
      approvedAt: "2026-08-21T00:00:00.000Z",
      selectedTasks: [{
        taskId: "task-1",
        itemIds: ["item-1"],
        itemDigests: { "item-1": "digest-1" },
      }],
    });
    assert.equal(receipt.status, "scheduled");
    assert.equal(receipt.fallbackUsed, true);
    assert.equal((await readCodexCleanerSchedule({
      stateDir,
      sessionId: "codex-cleaner-session",
    })).outcome, "ready");
  });
});

test("Codex cleaner bridge lists persisted sessions and reads canonical effective history", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-bridge-"));
  try {
    const sessionId = "codex-cleaner-session";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "old task" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: {
        id: "response-1",
        output: [{ type: "message", role: "assistant", content: "done" }],
      },
      status: "completed",
    });
    await upsertCodexSessionSnapshot(stateDir, sessionId, {
      latestResponseId: "response-1",
      latestModel: "gpt-5.4",
    });
    const taskId = "semantic-task-1";
    const turnAbsId = buildTurnAbsId(sessionId, 1);
    const registry = createEmptySessionTaskRegistry(sessionId);
    registry.version = 1;
    registry.lastProcessedTurnSeq = 1;
    registry.activeTaskIds = [taskId];
    registry.turnToTaskIds[turnAbsId] = [taskId];
    registry.tasks[taskId] = {
      taskId,
      title: "semantic task",
      objective: "verify registry-backed cleaner attribution",
      lifecycle: "active",
      completionEvidence: [],
      unresolvedQuestions: [],
      span: {
        firstTurnAbsId: turnAbsId,
        lastTurnAbsId: turnAbsId,
        supportingTurnAbsIds: [turnAbsId],
        lastEstimatorTurnAbsId: turnAbsId,
      },
    };
    await persistSessionTaskRegistry(stateDir, registry);

    const bridge = createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    assert.equal(bridge.hostId, "codex");
    assert.equal(bridge.rewriteMode, "response_chain_rebase");
    assert.deepEqual((await bridge.listSessions()).map((session) => session.sessionId), [sessionId]);
    const snapshot = await bridge.readCleanSnapshot(sessionId);
    assert.equal(snapshot.hostId, "codex");
    assert.equal(snapshot.sessionId, sessionId);
    assert.ok(snapshot.revision);
    assert.ok(snapshot.items.length > 0);
    assert.equal(snapshot.tokenCountMode, "exact");
    assert.equal(snapshot.tokenCountMethod, "openai_tokenizer");
    assert.ok(snapshot.capturedAt);
    assert.ok(snapshot.items.every((item) => item.stableId && item.fingerprint));
    assert.ok(snapshot.items.every((item) => item.taskIds?.length === 1));
    assert.ok(snapshot.items.every((item) => item.taskIds?.[0] === taskId));
    assert.ok(snapshot.items.every((item) => !item.taskIds?.includes(turnAbsId)));
    assert.deepEqual(
      Object.keys(snapshot.itemTokenCounts ?? {}).sort(),
      snapshot.items.map((item) => item.stableId).sort(),
    );
    assert.equal("adapterMetadata" in snapshot, false);

    const repeated = await bridge.readCleanSnapshot(sessionId);
    assert.equal(repeated.revision, snapshot.revision);
    assert.deepEqual(repeated.items, snapshot.items);
    assert.deepEqual(repeated.itemTokenCounts, snapshot.itemTokenCounts);
    assert.equal(repeated.capturedAt, snapshot.capturedAt);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex cleaner bridge rejects unknown sessions instead of returning an empty snapshot", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-missing-"));
  try {
    const bridge = createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    await assert.rejects(
      bridge.readCleanSnapshot("missing-session"),
      /codex_clean_session_not_found/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex cleaner bridge rejects a session whose committed response chain is incomplete", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-incomplete-"));
  try {
    const sessionId = "codex-cleaner-incomplete";
    await upsertCodexSessionSnapshot(stateDir, sessionId, {
      latestResponseId: "missing-response",
      latestModel: "gpt-5.4",
    });
    const bridge = createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    await assert.rejects(
      bridge.readCleanSnapshot(sessionId),
      /codex_clean_snapshot_incomplete/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex cleaner session catalog sorts valid sessions and isolates malformed entries", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-catalog-"));
  try {
    await writeSessionSnapshot(stateDir, "older-session", {
      sessionId: "older-session",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await writeSessionSnapshot(stateDir, "newer-session", {
      sessionId: "newer-session",
      updatedAt: "2026-08-21T00:00:00.000Z",
    });
    const sessionsDir = join(sessionStateRoot(stateDir), "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "%E0%A4%A.json"), "{}", "utf8");
    await writeFile(join(sessionsDir, "mismatched.json"), JSON.stringify({
      sessionId: "different-session",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }), "utf8");
    await writeFile(join(sessionsDir, "malformed.json"), "{", "utf8");

    const bridge = createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    assert.deepEqual(await bridge.listSessions(), [
      { sessionId: "newer-session", updatedAt: "2026-08-21T00:00:00.000Z" },
      { sessionId: "older-session", updatedAt: "2026-08-20T00:00:00.000Z" },
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex cleaner bridge leaves items unassigned when the registry has no evidence", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-unassigned-"));
  try {
    const sessionId = "codex-cleaner-unassigned";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "unassigned task" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: {
        id: "response-1",
        output: [{ type: "message", role: "assistant", content: "done" }],
      },
      status: "completed",
    });
    await upsertCodexSessionSnapshot(stateDir, sessionId, {
      latestResponseId: "response-1",
      latestModel: "gpt-5.4",
    });

    const snapshot = await createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    }).readCleanSnapshot(sessionId);
    assert.ok(snapshot.items.length > 0);
    assert.ok(snapshot.items.every((item) => item.taskIds === undefined));
    assert.ok(snapshot.items.every((item) => !item.taskIds?.includes(buildTurnAbsId(sessionId, 1))));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex cleaner bridge keeps a cross-turn tool pair on one semantic task", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-tool-pair-"));
  try {
    const sessionId = "codex-cleaner-tool-pair";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "run the tool" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: {
        id: "response-1",
        output: [{
          id: "function-call-1",
          type: "function_call",
          call_id: "call-1",
          name: "run",
          arguments: "{}",
        }],
      },
      status: "completed",
    });
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-2",
      payload: {
        previous_response_id: "response-1",
        input: [
          { type: "function_call_output", call_id: "call-1", output: "ok" },
          { role: "user", content: "continue" },
        ],
      },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-2",
      response: {
        id: "response-2",
        previous_response_id: "response-1",
        output: [{ type: "message", role: "assistant", content: "finished" }],
      },
      status: "completed",
    });
    await upsertCodexSessionSnapshot(stateDir, sessionId, {
      latestResponseId: "response-2",
      latestModel: "gpt-5.4",
    });
    const taskId = "tool-task";
    const turnAbsId = buildTurnAbsId(sessionId, 1);
    const registry = createEmptySessionTaskRegistry(sessionId);
    registry.version = 1;
    registry.lastProcessedTurnSeq = 1;
    registry.activeTaskIds = [taskId];
    registry.turnToTaskIds[turnAbsId] = [taskId];
    registry.tasks[taskId] = {
      taskId,
      title: "tool task",
      objective: "keep tool protocol ownership closed",
      lifecycle: "active",
      completionEvidence: [],
      unresolvedQuestions: [],
      span: {
        firstTurnAbsId: turnAbsId,
        lastTurnAbsId: turnAbsId,
        supportingTurnAbsIds: [turnAbsId],
        lastEstimatorTurnAbsId: turnAbsId,
      },
    };
    await persistSessionTaskRegistry(stateDir, registry);

    const snapshot = await createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    }).readCleanSnapshot(sessionId);
    const call = snapshot.items.find((item) => item.kind === "tool_call");
    const output = snapshot.items.find((item) => item.kind === "tool_result");
    assert.deepEqual(call?.taskIds, [taskId]);
    assert.deepEqual(output?.taskIds, [taskId]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex cleaner bridge reports chars-only accounting when the model is unknown", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-chars-"));
  try {
    const sessionId = "codex-cleaner-chars";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "count chars" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: {
        id: "response-1",
        output: [{ type: "message", role: "assistant", content: "done" }],
      },
      status: "completed",
    });
    await upsertCodexSessionSnapshot(stateDir, sessionId, {
      latestResponseId: "response-1",
    });

    const snapshot = await createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    }).readCleanSnapshot(sessionId);
    assert.equal(snapshot.tokenCountMode, "chars_only");
    assert.equal(snapshot.tokenCountMethod, "utf16_chars");
    assert.equal(snapshot.model, undefined);
    assert.equal(snapshot.itemTokenCounts, undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Codex cleaner bridge rejects a snapshot with an invalid capture timestamp", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-time-"));
  try {
    const sessionId = "codex-cleaner-invalid-time";
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      payload: { input: [{ role: "user", content: "invalid time" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-1",
      response: {
        id: "response-1",
        output: [{ type: "message", role: "assistant", content: "done" }],
      },
      status: "completed",
    });
    await writeSessionSnapshot(stateDir, sessionId, {
      sessionId,
      latestResponseId: "response-1",
      latestModel: "gpt-5.4",
      updatedAt: "not-a-time",
    });

    const bridge = createCodexContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    await assert.rejects(
      bridge.readCleanSnapshot(sessionId),
      /codex_clean_snapshot_timestamp_invalid/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
