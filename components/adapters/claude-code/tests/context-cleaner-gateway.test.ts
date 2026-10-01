import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  readContextCleanReceipt,
  saveContextCleanPlan,
  transitionContextCleanState,
  type ContextCleanPendingReceipt,
  type ContextCleanPlan,
} from "@lightrsi/cleaner";
import type { HostGatewayForwarder } from "@lightrsi/host-adapter";
import {
  persistRawSemanticTurnRecord,
  persistSessionTaskRegistry,
  rawSemanticTurnRecordPath,
  sessionTaskRegistryPath,
  type SessionTaskRegistry,
} from "@lightrsi/history";

import { attributeClaudeSnapshotTasks } from "../src/context-cleaner/snapshot.js";
import {
  acquireClaudeCleanerScheduleLock,
  scheduleClaudeCleanerPlan,
} from "../src/context-cleaner/scheduler.js";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";
import { buildRawSemanticTurnRecord } from "../src/context-rewrite/semantic-mapping.js";
import { claudeContextRewriteBackend } from "../src/context-rewrite/backend.js";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";
import {
  readLatestClaudeSnapshotRecord,
  saveLatestClaudeSnapshot,
} from "../src/context-rewrite/snapshot-store.js";

const SESSION = "claude-cleaner-gateway-session";
const PLAN = "claude-cleaner-gateway-plan";
const REVISION = "claude-cleaner-gateway-base-revision";
const NOW = "2026-08-29T00:00:00.000Z";

async function reserveUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function withoutCodecDefaults(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, entry) => (
    key === "is_error" && entry === false ? undefined : entry
  ));
}

function registry(): SessionTaskRegistry {
  return {
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
      "anthropic-tool-result:toolu_cleaner_gateway": ["task-completed"],
    },
    turnToTaskIds: {},
    lastProcessedTurnSeq: 1,
  };
}

test("slash clean apply control request preserves the approval-time snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-slash-apply-"));
  const stateDir = join(root, "state");
  const proxyPort = await reserveUnusedPort();
  const historicalMessages = [
    { role: "user", content: [{ type: "text", text: "COMPLETED_TASK_REQUEST" }] },
    { role: "assistant", content: [{ type: "text", text: "COMPLETED_TASK_RESPONSE" }] },
  ];
  const baseSnapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: REVISION,
    messages: historicalMessages as never,
  });
  const forwarder: HostGatewayForwarder = {
    async requestRaw() { throw new Error("requestRaw not used"); },
    async request() {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "msg_slash_apply",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() { throw new Error("requestStream not used"); },
  };
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir,
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: false },
      taskStateEstimator: { enabled: false },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    assert.deepEqual(await saveLatestClaudeSnapshot(stateDir, SESSION, baseSnapshot), { saved: true });
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        messages: [
          ...historicalMessages,
          {
            role: "user",
            content: [{
              type: "text",
              text: [
                "<command-message>lightrsi-clean-apply</command-message>",
                "<command-name>/lightrsi-clean-apply</command-name>",
                `<command-args>${PLAN} task-completed</command-args>`,
              ].join("\n"),
            }],
          },
          {
            role: "user",
            content: [{
              type: "text",
              text: [
                "Base directory for this skill: C:\\Users\\tester\\.claude\\skills\\lightrsi-clean-apply",
                "Schedule the exact LightRSI Cleaner task selection explicitly supplied by the user.",
                `ARGUMENTS: ${PLAN} task-completed`,
              ].join("\n\n"),
            }],
          },
        ],
        max_tokens: 128,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(
      (await readLatestClaudeSnapshotRecord(stateDir, SESSION))?.snapshot.revision,
      REVISION,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled Claude clean defers unavailable prerequisites and commits only an accepted overlay", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-gateway-"));
  const stateDir = join(root, "state");
  const proxyPort = await reserveUnusedPort();
  const historicalMessages = [
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_cleaner_gateway",
        name: "Read",
        input: { path: "/repo/old-file.txt" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_cleaner_gateway",
        content: "EVICT_GATEWAY_TOOL_RESULT_".repeat(80),
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "old task complete" }] },
    { role: "user", content: [{ type: "text", text: "APPROVAL_CURRENT_REQUEST" }] },
  ];
  const baseSnapshot = attributeClaudeSnapshotTasks({
    snapshot: buildClaudeContextSnapshot({
      sessionId: SESSION,
      revision: REVISION,
      messages: historicalMessages as never,
    }),
    messages: historicalMessages,
    registry: registry(),
  });
  const approvedItems = baseSnapshot.items.filter(
    (item) => item.taskIds?.includes("task-completed"),
  );
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

  const forwarded: Array<Record<string, unknown>> = [];
  let rejectNext = false;
  const forwarder: HostGatewayForwarder = {
    async requestRaw() { throw new Error("requestRaw not used"); },
    async request(params) {
      forwarded.push(params.payload as Record<string, unknown>);
      if (rejectNext) {
        rejectNext = false;
        return {
          status: 503,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({ error: { type: "overloaded_error", message: "retry" } }),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "msg_cleaner_gateway",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() { throw new Error("stream not used"); },
  };
  let resolverCalls = 0;
  let failSnapshotRead = false;
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir,
      proxyPort,
      modules: { stabilizer: true, reduction: true, eviction: true },
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 300,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: true,
          agentsStartupOptimization: false,
        },
      },
      eviction: { enabled: true, minBlockChars: 1 },
      taskStateEstimator: { enabled: true, batchTurns: 1 },
    }),
    logger: createConsoleLogger(false),
    forwarder,
    dependencies: {
      resolveEstimator() {
        resolverCalls += 1;
        return undefined;
      },
      async readSnapshot(
        params: Parameters<typeof claudeContextRewriteBackend.readSnapshot>[0],
      ) {
        if (failSnapshotRead) throw new Error("simulated current snapshot failure");
        return claudeContextRewriteBackend.readSnapshot(params);
      },
    },
  });

  try {
    const runtimeRegistry = registry();
    runtimeRegistry.blockToTaskIds = {};
    runtimeRegistry.turnToTaskIds = {
      [`${SESSION}:t1`]: ["task-completed"],
    };
    await persistSessionTaskRegistry(stateDir, runtimeRegistry, { expectedVersion: 0 });
    const rawTurn = buildRawSemanticTurnRecord({
      sessionId: SESSION,
      turnSeq: 1,
      messages: historicalMessages.slice(0, 2),
    });
    await persistRawSemanticTurnRecord(stateDir, rawTurn);
    assert.deepEqual(await saveLatestClaudeSnapshot(stateDir, SESSION, baseSnapshot), { saved: true });
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
    assert.equal((await scheduleClaudeCleanerPlan({
      stateDir,
      sessionId: SESSION,
      cleanPlanId: PLAN,
      baseRevision: REVISION,
      selectedTaskIds: ["task-completed"],
      scheduledAt: NOW,
    })).outcome, "stored");

    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: false,
      messages: [
        ...historicalMessages,
        { role: "assistant", content: [{ type: "text", text: "previous response" }] },
        { role: "user", content: [{ type: "text", text: "KEEP_CURRENT_REQUEST" }] },
      ],
      max_tokens: 128,
    });
    const originalMessages = (JSON.parse(requestBody) as { messages: Array<Record<string, unknown>> }).messages;

    await rm(join(stateDir, "claude-context", "sessions"), { recursive: true, force: true });
    const missingApprovalSnapshot = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });
    assert.equal(missingApprovalSnapshot.status, 200);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");
    assert.equal(forwarded.length, 1);
    assert.deepEqual(withoutCodecDefaults(forwarded[0]!.messages), originalMessages);

    assert.deepEqual(await saveLatestClaudeSnapshot(stateDir, SESSION, baseSnapshot), { saved: true });
    await writeFile(rawSemanticTurnRecordPath(stateDir, SESSION, 1), "{not-json", "utf8");
    const deferred = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });
    assert.equal(deferred.status, 200);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");
    assert.equal(
      (await readLatestClaudeSnapshotRecord(stateDir, SESSION))?.snapshot.revision,
      REVISION,
    );
    assert.equal(forwarded.length, 2);
    const unchangedMessages = forwarded[1]!.messages as Array<Record<string, unknown>>;
    assert.deepEqual(withoutCodecDefaults(unchangedMessages), originalMessages);

    await rm(rawSemanticTurnRecordPath(stateDir, SESSION, 1), { force: true });
    const missingRawTurnDeferred = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });
    assert.equal(missingRawTurnDeferred.status, 200);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");
    assert.equal(
      (await readLatestClaudeSnapshotRecord(stateDir, SESSION))?.snapshot.revision,
      REVISION,
    );
    assert.equal(forwarded.length, 3);
    assert.deepEqual(withoutCodecDefaults(forwarded[2]!.messages), originalMessages);

    await persistRawSemanticTurnRecord(stateDir, rawTurn);
    await writeFile(sessionTaskRegistryPath(stateDir, SESSION), "{not-json", "utf8");
    const registryDeferred = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });
    assert.equal(registryDeferred.status, 200);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");
    assert.equal(
      (await readLatestClaudeSnapshotRecord(stateDir, SESSION))?.snapshot.revision,
      REVISION,
    );
    assert.equal(forwarded.length, 4);
    assert.deepEqual(withoutCodecDefaults(forwarded[3]!.messages), originalMessages);

    await rm(sessionTaskRegistryPath(stateDir, SESSION), { force: true });
    const missingRegistryDeferred = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });
    assert.equal(missingRegistryDeferred.status, 200);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");
    assert.equal(
      (await readLatestClaudeSnapshotRecord(stateDir, SESSION))?.snapshot.revision,
      REVISION,
    );
    assert.equal(forwarded.length, 5);
    assert.deepEqual(withoutCodecDefaults(forwarded[4]!.messages), originalMessages);

    await persistSessionTaskRegistry(stateDir, runtimeRegistry);
    failSnapshotRead = true;
    const snapshotDeferred = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });
    failSnapshotRead = false;
    assert.equal(snapshotDeferred.status, 200);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");
    assert.equal(
      (await readLatestClaudeSnapshotRecord(stateDir, SESSION))?.snapshot.revision,
      REVISION,
    );
    assert.equal(forwarded.length, 6);
    assert.deepEqual(withoutCodecDefaults(forwarded[5]!.messages), originalMessages);

    const heldCleanerLock = await acquireClaudeCleanerScheduleLock({ stateDir, sessionId: SESSION });
    assert.ok(heldCleanerLock);
    let lockDeferred: Response;
    try {
      lockDeferred = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": SESSION },
        body: requestBody,
      });
    } finally {
      await heldCleanerLock.release();
    }
    assert.equal(lockDeferred.status, 200);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");
    assert.equal(
      (await readLatestClaudeSnapshotRecord(stateDir, SESSION))?.snapshot.revision,
      REVISION,
    );
    assert.equal(forwarded.length, 7);
    assert.deepEqual(withoutCodecDefaults(forwarded[6]!.messages), originalMessages);
    const deferredTrace = (await readFile(join(stateDir, "event-trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.stage === "gateway_before_call")
      .at(-1);
    assert.equal(deferredTrace?.stablePrefixApplied, false);
    assert.equal(deferredTrace?.reductionApplied, false);

    rejectNext = true;
    const rejected = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });
    assert.equal(rejected.status, 503);
    assert.equal((await readContextCleanReceipt({ stateDir, planId: PLAN })).value?.status, "scheduled");

    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": SESSION },
      body: requestBody,
    });

    assert.equal(response.status, 200);
    assert.equal(resolverCalls, 0);
    assert.equal(forwarded.length, 9);
    for (const forwardedIndex of [7, 8]) {
      const messages = forwarded[forwardedIndex]!.messages as Array<Record<string, unknown>>;
      assert.deepEqual((messages[0]!.content as Array<Record<string, unknown>>)[0], {
        type: "tool_use",
        id: "toolu_cleaner_gateway",
        name: "Read",
        input: {},
      });
      assert.match(
        String((messages[1]!.content as Array<Record<string, unknown>>)[0]!.content),
        /^\[(Tool payload trimmed|evicted: earlier tool result)/,
      );
      assert.equal(
        (messages.at(-1)!.content as Array<Record<string, unknown>>)[0]!.text,
        "KEEP_CURRENT_REQUEST",
      );
    }
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value?.status, "applied");
    assert.deepEqual(receipt.value?.evidence?.itemIds, approvedItems.map((item) => item.stableId));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
