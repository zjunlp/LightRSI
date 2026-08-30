import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { SessionTaskRegistry } from "@lightrsi/history";

import { attributeClaudeSnapshotTasks } from "../src/context-cleaner/snapshot.js";
import { scheduleClaudeCleanerPlan } from "../src/context-cleaner/scheduler.js";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";
import { saveLatestClaudeSnapshot } from "../src/context-rewrite/snapshot-store.js";
import { persistSessionTaskRegistry } from "@lightrsi/history";

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

test("scheduled Claude clean retries after upstream rejection and commits only an accepted overlay", async () => {
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
  const forwarder: HostGatewayForwarder = {
    async requestRaw() { throw new Error("requestRaw not used"); },
    async request(params) {
      forwarded.push(params.payload as Record<string, unknown>);
      if (forwarded.length === 1) {
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
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir,
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: true },
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
    },
  });

  try {
    await persistSessionTaskRegistry(stateDir, registry(), { expectedVersion: 0 });
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
    assert.equal(forwarded.length, 2);
    const messages = forwarded[1]!.messages as Array<Record<string, unknown>>;
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
    const receipt = await readContextCleanReceipt({ stateDir, planId: PLAN });
    assert.equal(receipt.value?.status, "applied");
    assert.deepEqual(receipt.value?.evidence?.itemIds, approvedItems.map((item) => item.stableId));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
