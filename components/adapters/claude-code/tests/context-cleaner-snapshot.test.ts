import assert from "node:assert/strict";
import test from "node:test";

import type { SessionTaskRegistry } from "@lightrsi/history";

import {
  attributeClaudeSnapshotTasks,
  scheduledCleanerAttributionUnavailable,
} from "../src/context-cleaner/snapshot.js";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";

const SESSION = "claude-task-attribution";

function registry(
  blockToTaskIds: Record<string, string[]>,
  taskIds: string[] = ["task-read"],
): SessionTaskRegistry {
  return {
    sessionId: SESSION,
    version: 1,
    tasks: Object.fromEntries(taskIds.map((taskId) => [taskId, {
      taskId,
      title: taskId,
      objective: taskId,
      lifecycle: "completed",
      completionEvidence: [],
      unresolvedQuestions: [],
      span: {
        firstTurnAbsId: `${SESSION}:t1`,
        lastTurnAbsId: `${SESSION}:t1`,
        supportingTurnAbsIds: [`${SESSION}:t1`],
        lastEstimatorTurnAbsId: `${SESSION}:t1`,
      },
    }])),
    activeTaskIds: [],
    completedTaskIds: taskIds,
    evictableTaskIds: [],
    taskToBlockIds: {},
    blockToTaskIds,
    turnToTaskIds: {},
    lastProcessedTurnSeq: 1,
  };
}

function messages() {
  return [
    { role: "system", content: [{ type: "text", text: "stay safe" }] },
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_read",
        name: "Read",
        input: { file_path: "/repo/a.ts" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_read",
        content: "file body",
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ];
}

test("attributes a proven historical tool call/result pair from blockToTaskIds", () => {
  const inbound = messages();
  const snapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "revision-1",
    messages: inbound as any,
  });
  const attributed = attributeClaudeSnapshotTasks({
    snapshot,
    messages: inbound,
    registry: registry({ "anthropic-tool-result:toolu_read": ["task-read"] }),
  });

  const call = attributed.items.find((item) => item.kind === "tool_call");
  const result = attributed.items.find((item) => item.kind === "tool_result");
  assert.deepEqual(call?.taskIds, ["task-read"]);
  assert.deepEqual(result?.taskIds, ["task-read"]);
  assert.equal(call?.callId, result?.callId);
  assert.ok(
    attributed.items
      .filter((item) => item.kind !== "tool_call" && item.kind !== "tool_result")
      .every((item) => item.taskIds === undefined),
  );
});

test("attributes a historical pair through its unique semantic turn ownership", () => {
  const inbound = messages();
  const snapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "revision-turn-proof",
    messages: inbound as any,
  });
  const taskRegistry = registry({});
  taskRegistry.turnToTaskIds = { [`${SESSION}:t1`]: ["task-read"] };

  const attributed = (attributeClaudeSnapshotTasks as any)({
    snapshot,
    messages: inbound,
    registry: taskRegistry,
    turnAbsIdByToolCallId: new Map([["toolu_read", `${SESSION}:t1`]]),
  });

  const pair = attributed.items.filter((item: { callId?: string }) => item.callId === "toolu_read");
  assert.equal(pair.length, 2);
  assert.ok(pair.every((item: { taskIds?: string[] }) =>
    JSON.stringify(item.taskIds) === JSON.stringify(["task-read"])));
});

test("leaves current-turn, ambiguous, and unknown-task mappings unassigned", () => {
  const currentToolPair = [
    ...messages().slice(0, -1),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_current", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_current", content: "current" }],
    },
  ];
  const snapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "revision-current",
    messages: currentToolPair as any,
  });
  const attributed = attributeClaudeSnapshotTasks({
    snapshot,
    messages: currentToolPair,
    registry: registry({
      "anthropic-tool-result:toolu_read": ["missing-task"],
      "anthropic-tool-result:toolu_current": ["task-read"],
    }),
  });

  assert.ok(attributed.items.every((item) => item.taskIds === undefined));
});

test("rejects attribution from a registry for another session", () => {
  const inbound = messages();
  const snapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "revision-mismatch",
    messages: inbound as any,
  });
  const wrongRegistry = registry({ "anthropic-tool-result:toolu_read": ["task-read"] });
  wrongRegistry.sessionId = "different-session";

  const attributed = attributeClaudeSnapshotTasks({
    snapshot,
    messages: inbound,
    registry: wrongRegistry,
  });
  assert.ok(attributed.items.every((item) => item.taskIds === undefined));
});

test("treats explicit task reattribution as stale context rather than unavailable evidence", () => {
  const inbound = messages();
  const baseSnapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "revision-reattributed",
    messages: inbound as any,
  });
  const approvalSnapshot = attributeClaudeSnapshotTasks({
    snapshot: baseSnapshot,
    messages: inbound,
    registry: registry({ "anthropic-tool-result:toolu_read": ["task-read"] }),
  });
  const currentSnapshot = attributeClaudeSnapshotTasks({
    snapshot: baseSnapshot,
    messages: inbound,
    registry: registry(
      { "anthropic-tool-result:toolu_read": ["task-other"] },
      ["task-read", "task-other"],
    ),
  });

  assert.equal(scheduledCleanerAttributionUnavailable({
    selectedTaskIds: ["task-read"],
    approvalSnapshot,
    currentSnapshot,
  }), false);
});

test("lets deterministic pair drift override unavailable attribution on another pair", () => {
  const approvalMessages = [
    ...messages().slice(0, -1),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_other", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_other", content: "other" }],
    },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ];
  const approvalSnapshot = attributeClaudeSnapshotTasks({
    snapshot: buildClaudeContextSnapshot({
      sessionId: SESSION,
      revision: "revision-multi-pair",
      messages: approvalMessages as any,
    }),
    messages: approvalMessages,
    registry: registry({
      "anthropic-tool-result:toolu_read": ["task-read"],
      "anthropic-tool-result:toolu_other": ["task-read"],
    }),
  });
  const currentMessages = approvalMessages.filter((message) => {
    const block = Array.isArray(message.content)
      ? message.content[0] as Record<string, unknown> | undefined
      : undefined;
    return block?.id !== "toolu_read" && block?.tool_use_id !== "toolu_read";
  });
  const currentSnapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "revision-multi-pair-current",
    messages: currentMessages as any,
  });

  assert.equal(scheduledCleanerAttributionUnavailable({
    selectedTaskIds: ["task-read"],
    approvalSnapshot,
    currentSnapshot,
  }), false);
});

test("lets fingerprint drift override unavailable attribution on another pair", () => {
  const approvalMessages = [
    ...messages().slice(0, -1),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_other", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_other", content: "other" }],
    },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ];
  const approvalSnapshot = attributeClaudeSnapshotTasks({
    snapshot: buildClaudeContextSnapshot({
      sessionId: SESSION,
      revision: "revision-fingerprint-drift",
      messages: approvalMessages as any,
    }),
    messages: approvalMessages,
    registry: registry({
      "anthropic-tool-result:toolu_read": ["task-read"],
      "anthropic-tool-result:toolu_other": ["task-read"],
    }),
  });
  const currentMessages = structuredClone(approvalMessages) as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  const changedResult = currentMessages
    .flatMap((message) => message.content)
    .find((block) => block.tool_use_id === "toolu_other");
  assert.ok(changedResult);
  changedResult.content = "changed other result";
  const currentSnapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "revision-fingerprint-drift-current",
    messages: currentMessages as any,
  });

  assert.equal(scheduledCleanerAttributionUnavailable({
    selectedTaskIds: ["task-read"],
    approvalSnapshot,
    currentSnapshot,
  }), false);
});
