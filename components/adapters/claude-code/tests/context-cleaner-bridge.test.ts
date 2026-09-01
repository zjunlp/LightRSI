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
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  sessionSnapshotPath,
} from "@lightrsi/host-adapter";

import { createClaudeCodeContextCleanerBridge } from "../src/context-cleaner/index.js";
import { readClaudeCleanerSchedule } from "../src/context-cleaner/scheduler.js";
import { saveLatestClaudeSnapshot } from "../src/context-rewrite/snapshot-store.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";

const SESSION = "claude-cleaner-session";
const PLAN = "clean-plan-1";

function pendingReceipt(
  status: ContextCleanPendingReceipt["status"],
): ContextCleanPendingReceipt {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: PLAN,
    hostId: "claude-code",
    sessionId: SESSION,
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
    fallbackUsed: false,
    appliedSavedTokens: null,
    appliedSavedChars: 10,
    evidence: {
      previousRevision: "revision-before",
      nextRevision: "revision-after",
      operationIds: ["operation-1"],
      itemIds: ["item-1"],
    },
  };
}

function approval(): ExecuteApprovedContextCleanParams {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    cleanPlanId: PLAN,
    hostId: "claude-code",
    sessionId: SESSION,
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
}

function fakeControlPlane(): ContextCleanerControlPlane {
  return {
    async executeApprovedClean() { return pendingReceipt("scheduled"); },
    async readCleanReceipt() { return pendingReceipt("scheduled"); },
    async cancelCleanPlan() { return terminalReceipt("cancelled"); },
  };
}

test("Claude cleaner bridge lists sessions and reads a chars-only canonical snapshot", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-bridge-"));
  try {
    await upsertClaudeCodeSessionSnapshot(stateDir, SESSION, {
      latestModel: "claude-sonnet-4-6",
    });
    assert.deepEqual(await saveLatestClaudeSnapshot(stateDir, SESSION, {
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      hostId: "claude-code",
      sessionId: SESSION,
      revision: "revision-1",
      items: [{
        stableId: "item-1",
        kind: "user",
        fingerprint: "digest-1",
        chars: 12,
      }],
    }, { model: "claude-sonnet-4-6" }), { saved: true });

    const bridge = createClaudeCodeContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    assert.equal(bridge.hostId, "claude-code");
    assert.equal(bridge.rewriteMode, "request_overlay");
    assert.deepEqual((await bridge.listSessions()).map((session) => session.sessionId), [SESSION]);
    const snapshot = await bridge.readCleanSnapshot(SESSION);
    assert.equal(snapshot.hostId, "claude-code");
    assert.equal(snapshot.sessionId, SESSION);
    assert.equal(snapshot.revision, "revision-1");
    assert.equal(snapshot.model, "claude-sonnet-4-6");
    assert.equal(snapshot.tokenCountMode, "chars_only");
    assert.equal(snapshot.tokenCountMethod, "utf16_chars");
    assert.equal(snapshot.itemTokenCounts, undefined);
    assert.ok(snapshot.capturedAt);
    assert.equal("adapterMetadata" in snapshot, false);
    assert.equal("messages" in snapshot, false);

    const repeated = await bridge.readCleanSnapshot(SESSION);
    assert.equal(repeated.revision, snapshot.revision);
    assert.deepEqual(repeated.items, snapshot.items);
    assert.equal(repeated.capturedAt, snapshot.capturedAt);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Claude cleaner bridge rejects a session without a canonical snapshot", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-missing-"));
  try {
    await upsertClaudeCodeSessionSnapshot(stateDir, SESSION, {
      latestModel: "claude-sonnet-4-6",
    });
    const bridge = createClaudeCodeContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    await assert.rejects(
      bridge.readCleanSnapshot(SESSION),
      /claude_clean_snapshot_unavailable/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Claude cleaner bridge preserves approved targets and receipt evidence", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-bridge-schedule-"));
  let captured: ExecuteApprovedContextCleanParams | undefined;
  const applied = appliedReceipt();
  const cancelled = terminalReceipt("cancelled");
  const bridge = createClaudeCodeContextCleanerBridge({
    stateDir,
    controlPlane: {
      async executeApprovedClean(request) {
        captured = request;
        return pendingReceipt("scheduled");
      },
      async readCleanReceipt() { return applied; },
      async cancelCleanPlan() { return cancelled; },
    },
  });
  try {
    const request = approval();

    const scheduled = await bridge.executeApprovedClean(request);
    assert.strictEqual(captured, request);
    assert.equal(scheduled.status, "scheduled");
    assert.equal("appliedSavedChars" in scheduled, false);
    const local = await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION });
    assert.equal(local.outcome, "ready");
    if (local.outcome === "ready") {
      assert.equal(local.record.cleanPlanId, PLAN);
      assert.deepEqual(local.record.selectedTaskIds, ["task-1"]);
    }
    assert.strictEqual(await bridge.readCleanReceipt(PLAN), applied);
    assert.deepEqual(applied.evidence, {
      previousRevision: "revision-before",
      nextRevision: "revision-after",
      operationIds: ["operation-1"],
      itemIds: ["item-1"],
    });
    assert.strictEqual(await bridge.cancelCleanPlan(PLAN), cancelled);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Claude cleaner bridge rejects cross-host or mutated approvals before execution", async () => {
  let executions = 0;
  const bridge = createClaudeCodeContextCleanerBridge({
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
    bridge.executeApprovedClean({ ...approval(), hostId: "codex" }),
    /claude_clean_approval_host_mismatch/,
  );
  await assert.rejects(
    bridge.executeApprovedClean({
      ...approval(),
      selectedTasks: [{
        taskId: "task-1",
        itemIds: ["item-1"],
        itemDigests: { "other-item": "digest-1" },
      }],
    }),
    /claude_clean_approval_targets_invalid/,
  );
  assert.equal(executions, 0);
});

test("Claude cleaner bridge rejects mismatched or malformed receipts", async () => {
  const malformedApplied = {
    ...pendingReceipt("scheduled"),
    status: "applied",
    fallbackUsed: true,
    appliedSavedTokens: null,
    appliedSavedChars: 10,
  } as unknown as ContextCleanAppliedReceipt;
  const bridge = createClaudeCodeContextCleanerBridge({
    stateDir: "unused-state-dir",
    controlPlane: {
      async executeApprovedClean() {
        return { ...pendingReceipt("scheduled"), hostId: "codex" };
      },
      async readCleanReceipt(planId) {
        return planId === "malformed" ? malformedApplied : {
          ...pendingReceipt("scheduled"),
          planId: "other-plan",
        };
      },
      async cancelCleanPlan() {
        return { ...terminalReceipt("cancelled"), hostId: "openclaw" };
      },
    },
  });

  await assert.rejects(bridge.executeApprovedClean(approval()), /claude_clean_receipt_mismatch/);
  await assert.rejects(bridge.readCleanReceipt(PLAN), /claude_clean_receipt_mismatch/);
  await assert.rejects(bridge.cancelCleanPlan(PLAN), /claude_clean_receipt_mismatch/);
  await assert.rejects(bridge.readCleanReceipt("malformed"), /claude_clean_receipt_mismatch/);
});

test("Claude cleaner session catalog sorts valid state and isolates malformed records", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-sessions-"));
  try {
    const records = [
      { sessionId: "session-older", updatedAt: "2026-08-20T00:00:00.000Z" },
      { sessionId: "session-newer", updatedAt: "2026-08-21T00:00:00.000Z" },
      { sessionId: "session-mismatch", updatedAt: "2026-08-22T00:00:00.000Z" },
      { sessionId: "session-bad-time", updatedAt: "not-a-date" },
    ];
    for (const record of records) {
      const path = sessionSnapshotPath(stateDir, record.sessionId);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify({
        ...record,
        ...(record.sessionId === "session-mismatch" ? { sessionId: "other-session" } : {}),
      }), "utf8");
    }
    const corruptPath = sessionSnapshotPath(stateDir, "session-corrupt");
    await writeFile(corruptPath, "{ not json", "utf8");
    await writeFile(
      join(corruptPath, "..", "bad%XX.json"),
      JSON.stringify({ sessionId: "bad", updatedAt: "2026-08-23T00:00:00.000Z" }),
      "utf8",
    );

    const bridge = createClaudeCodeContextCleanerBridge({
      stateDir,
      controlPlane: fakeControlPlane(),
    });
    assert.deepEqual(await bridge.listSessions(), [
      { sessionId: "session-newer", updatedAt: "2026-08-21T00:00:00.000Z" },
      { sessionId: "session-older", updatedAt: "2026-08-20T00:00:00.000Z" },
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Claude cleaner bridge rejects malformed approval shapes and duplicate target scope", async () => {
  let executions = 0;
  const bridge = createClaudeCodeContextCleanerBridge({
    stateDir: "unused-state-dir",
    controlPlane: {
      ...fakeControlPlane(),
      async executeApprovedClean() {
        executions += 1;
        return pendingReceipt("scheduled");
      },
    },
  });
  const cases: Array<[string, ExecuteApprovedContextCleanParams, RegExp]> = [
    ["schema", { ...approval(), schemaVersion: 999 as 1 }, /approval_schema_mismatch/],
    ["timestamp", { ...approval(), approvedAt: "2026-08-21" }, /approval_invalid/],
    ["selectedTasks", { ...approval(), selectedTasks: null as never }, /approval_invalid/],
    ["digests", {
      ...approval(),
      selectedTasks: [{ taskId: "task-1", itemIds: ["item-1"], itemDigests: null as never }],
    }, /approval_targets_invalid/],
    ["duplicate task", {
      ...approval(),
      selectedTasks: [approval().selectedTasks[0]!, approval().selectedTasks[0]!],
    }, /approval_invalid/],
    ["duplicate item", {
      ...approval(),
      selectedTasks: [
        { taskId: "task-1", itemIds: ["item-1"], itemDigests: { "item-1": "digest-1" } },
        { taskId: "task-2", itemIds: ["item-1"], itemDigests: { "item-1": "digest-1" } },
      ],
    }, /approval_targets_invalid/],
    ["extra digest", {
      ...approval(),
      selectedTasks: [{
        taskId: "task-1",
        itemIds: ["item-1"],
        itemDigests: { "item-1": "digest-1", extra: "digest-extra" },
      }],
    }, /approval_targets_invalid/],
  ];

  for (const [label, request, pattern] of cases) {
    await assert.rejects(bridge.executeApprovedClean(request), pattern, label);
  }
  assert.equal(executions, 0);
});

test("Claude cleaner bridge rejects invalid receipt accounting and state combinations", async () => {
  const cases: Array<[string, ContextCleanPendingReceipt | ContextCleanAppliedReceipt]> = [
    ["negative estimate", { ...pendingReceipt("scheduled"), estimatedSavedChars: -1 }],
    ["invalid timestamp", { ...pendingReceipt("scheduled"), updatedAt: "2026-08-20" }],
    ["duplicate tasks", { ...pendingReceipt("scheduled"), selectedTaskIds: ["task-1", "task-1"] }],
    ["pending actual savings", {
      ...pendingReceipt("scheduled"),
      appliedSavedTokens: null,
      appliedSavedChars: 1,
    } as unknown as ContextCleanPendingReceipt],
    ["applied fallback", {
      ...appliedReceipt(),
      fallbackUsed: true,
    } as unknown as ContextCleanAppliedReceipt],
    ["applied missing evidence", {
      ...pendingReceipt("scheduled"),
      status: "applied",
      appliedSavedTokens: null,
      appliedSavedChars: 1,
    } as unknown as ContextCleanAppliedReceipt],
    ["applied empty operations", {
      ...appliedReceipt(),
      evidence: { ...appliedReceipt().evidence, operationIds: [] },
    }],
  ];

  for (const [label, candidate] of cases) {
    const bridge = createClaudeCodeContextCleanerBridge({
      stateDir: "unused-state-dir",
      controlPlane: {
        ...fakeControlPlane(),
        async readCleanReceipt() { return candidate; },
      },
    });
    await assert.rejects(
      bridge.readCleanReceipt(PLAN),
      /claude_clean_receipt_mismatch/,
      label,
    );
  }
});

test("Claude cleaner bridge rejects blank plan ids without calling the control plane", async () => {
  let reads = 0;
  let cancels = 0;
  const bridge = createClaudeCodeContextCleanerBridge({
    stateDir: "unused-state-dir",
    controlPlane: {
      ...fakeControlPlane(),
      async readCleanReceipt() { reads += 1; return undefined; },
      async cancelCleanPlan() { cancels += 1; return terminalReceipt("cancelled"); },
    },
  });
  await assert.rejects(bridge.readCleanReceipt(" "), /claude_clean_plan_id_invalid/);
  await assert.rejects(bridge.cancelCleanPlan(" "), /claude_clean_plan_id_invalid/);
  assert.equal(reads, 0);
  assert.equal(cancels, 0);
});
