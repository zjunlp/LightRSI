import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readContextCleanReceipt,
  transitionContextCleanState,
} from "@lightrsi/cleaner";
import {
  applySessionTaskRegistryPatch,
  createEmptySessionTaskRegistry,
  persistSessionTaskRegistry,
} from "@lightrsi/history";

import {
  createDshCleanerPreStepState,
  registerDshCleanerPreStep,
} from "../src/cleaner-pre-step.js";
import {
  executeContextCleanerCommand,
  type ContextCleanerCommandContext,
} from "../src/context-cleaner/commands.js";
import {
  claimDshCleanerSchedule,
  readDshCleanerSchedule,
  scheduleDshCleanerPlan,
} from "../src/context-cleaner/scheduler.js";
import { buildDshCleanSnapshot, surfaceRevision } from "../src/context-cleaner/snapshot.js";
import { normalizeDshConfig } from "../src/config.js";
import * as adapterPlugin from "../src/index.js";
import type {
  DshLogEventWithMeta,
  DshPluginContext,
  DshPreStepDecision,
  DshPreStepNext,
  DshPreStepPayload,
  DshSession,
} from "../src/types.js";

type Handler = (payload: DshPreStepPayload, next: DshPreStepNext) => Promise<DshPreStepDecision>;

function makeSession(id = "context-cleaner-command-test", includeToolResult = false): DshSession {
  const events: DshLogEventWithMeta[] = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    {
      seq: 2,
      type: "user/message",
      data: {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "Create a weekly meal plan with inexpensive breakfasts." }],
        source: { kind: "user" },
      },
    },
    {
      seq: 3,
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
        content: [
          { type: "text", text: "Here is the completed seven-day breakfast plan." },
          ...(includeToolResult ? [{
            type: "tool-call" as const,
            id: "call-1",
            name: "price_lookup",
            arguments: "{}",
          }] : []),
        ],
          source: { kind: "model" },
        },
      },
    },
  ];
  if (includeToolResult) {
    events.push({
      seq: 4,
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "tool-result-1",
          role: "user",
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "The price lookup completed successfully." }],
          }],
          source: { kind: "tool" },
        },
        error: { name: "none", code: "none" },
      },
    });
  }
  const nodes = includeToolResult ? [2, 3, 4] : [2, 3];
  let nextSeq = includeToolResult ? 5 : 4;

  const session: DshSession = {
    id,
    events,
    surface: { nodes, replaceGeneration: 0 },
    append: (type, data, options) => {
      const seq = nextSeq;
      nextSeq += 1;
      events.push({
        seq,
        type,
        data,
        ...(options?.surfaceOp ? { surfaceOp: options.surfaceOp } : {}),
        ...(options?.sourceEventSeqs ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
      } as unknown as DshLogEventWithMeta);
      const replacement = options?.surfaceOp;
      if (replacement && typeof replacement === "object") {
        const start = nodes.indexOf(replacement.start);
        assert.notEqual(start, -1, "the replacement source must be on the live surface");
        nodes.splice(start, replacement.end - replacement.start + 1, seq);
        session.surface.replaceGeneration += 1;
      }
      return { seq };
    },
  };
  return session;
}

function completedRegistry(session: DshSession) {
  return applySessionTaskRegistryPatch(
    createEmptySessionTaskRegistry(session.id),
    {
      upsertTasks: {
        "meal-plan": {
          taskId: "meal-plan",
          title: "Weekly meal plan",
          objective: "Design one inexpensive breakfast for each day.",
          lifecycle: "completed",
          completionEvidence: ["The seven-day plan was delivered."],
          unresolvedQuestions: [],
          span: {
            firstTurnAbsId: `${session.id}:t1`,
            lastTurnAbsId: `${session.id}:t1`,
            supportingTurnAbsIds: [`${session.id}:t1`],
            lastEstimatorTurnAbsId: `${session.id}:t1`,
          },
        },
      },
      completedTaskIds: ["meal-plan"],
      evictableTaskIds: ["meal-plan"],
      upsertTurnToTaskIds: {
        [`${session.id}:t1`]: ["meal-plan"],
      },
    },
  );
}

function configured(stateDir: string) {
  return normalizeDshConfig({
    enabled: true,
    stateDir,
    eviction: { enabled: false },
  });
}

function invocation(session: DshSession, rawInput: string) {
  return {
    commandId: "tokenpilot-clean-test",
    agent: { session },
    rawInput,
    signal: { aborted: false },
  };
}

function planIdFrom(text: string | undefined): string {
  const planId = /plan id: ([^\n]+)/u.exec(text ?? "")?.[1];
  assert.ok(planId, "the command must render an immutable plan ID");
  return planId;
}

describe("Context Cleaner DSH command", () => {
  it("counts nested DSH tool-result text in Cleaner accounting", () => {
    const session = makeSession("context-cleaner-tool-count-test", true);
    const built = buildDshCleanSnapshot({
      session,
      registry: completedRegistry(session),
      revision: surfaceRevision(session),
    });
    const result = built.snapshot.items.find((item) => item.stableId === "event-4-tool-result");

    assert.equal(result?.chars, 40);
    assert.equal(
      built.itemTextByStableId["event-4-tool-result"],
      "The price lookup completed successfully.",
    );
  });

  it("keeps the root plugin headless-loadable and mounts optional services through Cordis injections", () => {
    const unwrapExports = (exports: Record<string, unknown>) => exports.default ?? exports;
    assert.equal("default" in adapterPlugin, false);
    assert.deepEqual(adapterPlugin.inject, []);
    assert.equal(unwrapExports(adapterPlugin as Record<string, unknown>), adapterPlugin);

    const commandNames: string[] = [];
    const preStepHandlers: string[] = [];
    const injectionRequests: string[][] = [];
    const commandContext = {
      commands: {
        register: (definition: { name: string }) => {
          commandNames.push(definition.name);
          return () => {};
        },
      },
      inject: (services: readonly string[], callback: (value: unknown) => void) => {
        injectionRequests.push([...services]);
        if (services.includes("sessions")) {
          callback({ sessions: { list: () => [], get: () => undefined } });
        } else if (services.includes("sessionProjections")) {
          callback({
            sessionProjections: {
              register: () => () => {},
              snapshot: () => ({ asOfSeq: -1, values: {} }),
            },
          });
        }
      },
    };
    const runtimeContext: DshPluginContext = {
      on: (event) => { preStepHandlers.push(event); },
      tokenMeter: { measure: () => ({}) },
    };
    const root = {
      inject: (services: readonly string[], callback: (value: unknown) => void) => {
        injectionRequests.push([...services]);
        if (services.includes("commands")) callback(commandContext);
        if (services.includes("tokenMeter")) callback(runtimeContext);
      },
    };

    adapterPlugin.apply(root, configured("C:/tmp/lightrsi-cleaner-test"));

    assert.deepEqual(commandNames.sort(), ["context-cleaner", "tokenpilot-clean", "tokenpilot-status"]);
    assert.deepEqual(injectionRequests, [
      ["commands"], ["sessions"], ["sessionProjections"], ["tokenMeter"],
    ]);
    assert.deepEqual(preStepHandlers, ["agent/pre-step", "agent/pre-step"]);
  });

  it("analyzes read-only and schedules an explicit task without rewriting the DSH surface", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession();
      const registry = completedRegistry(session);
      await persistSessionTaskRegistry(stateDir, registry, { expectedVersion: 0 });
      const context: ContextCleanerCommandContext = { commands: { register: () => () => {} } };
      const config = configured(stateDir);
      const dependencies = {
        now: () => "2026-09-18T00:00:00.000Z",
      };

      const analysis = await executeContextCleanerCommand(context, config, invocation(session, ""), dependencies);
      if (analysis.kind !== "success") assert.fail(analysis.text);
      assert.match(analysis.text ?? "", /Context Cleaner plan/u);
      assert.match(analysis.text ?? "", /\[ \] \| meal-plan \|/u);
      assert.deepEqual(session.surface.nodes, [2, 3], "analysis must not mutate DSH's surface");

      const planId = planIdFrom(analysis.text);
      const scheduled = await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--plan ${planId} --select meal-plan`),
        dependencies,
      );
      if (scheduled.kind !== "success") assert.fail(scheduled.text);
      assert.match(scheduled.text ?? "", /status: scheduled/u);
      assert.deepEqual(session.surface.nodes, [2, 3], "selection only schedules; it cannot rewrite context");

      const pointer = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(pointer.outcome, "ready");
      if (pointer.outcome === "ready") assert.equal(pointer.record.cleanPlanId, planId);

      const status = await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--status ${planId}`),
        dependencies,
      );
      assert.match(status.text ?? "", /status: scheduled/u);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("executes a scheduled clean exactly once at the next agent/pre-step and records applied evidence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession("context-cleaner-pre-step-test");
      const registry = completedRegistry(session);
      await persistSessionTaskRegistry(stateDir, registry, { expectedVersion: 0 });
      const context: ContextCleanerCommandContext = { commands: { register: () => () => {} } };
      const config = configured(stateDir);
      const dependencies = { now: () => "2026-09-18T00:00:00.000Z" };

      const analysis = await executeContextCleanerCommand(context, config, invocation(session, ""), dependencies);
      if (analysis.kind !== "success") assert.fail(analysis.text);
      const planId = planIdFrom(analysis.text);
      const scheduled = await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--plan ${planId} --select meal-plan`),
        dependencies,
      );
      if (scheduled.kind !== "success") assert.fail(scheduled.text);
      assert.deepEqual(session.surface.nodes, [2, 3]);

      const handlers: Handler[] = [];
      let meterCalls = 0;
      const runtimeContext: DshPluginContext = {
        on: (_event, handler) => { handlers.push(handler as Handler); },
        tokenMeter: { measure: () => { meterCalls += 1; } },
      };
      const state = createDshCleanerPreStepState();
      registerDshCleanerPreStep(runtimeContext, config, state);
      assert.equal(handlers.length, 1);
      const payload: DshPreStepPayload = {
        agent: { session }, messages: [], turn: 2, step: 0, signal: { aborted: false },
      };
      const next: DshPreStepNext = async () => ({ kind: "enter", messages: [] });

      await handlers[0]!(payload, next);
      assert.equal(state.wasClaimed(payload), true);
      assert.equal(meterCalls, 1, "the committed rewrite must be re-metered once");
      assert.equal(session.surface.nodes.includes(2), false);
      assert.equal(session.surface.nodes.includes(3), false);
      assert.match(JSON.stringify(session.events.slice(-2)), /\[cleaned: message @2\]/u);

      const pointer = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(pointer.outcome, "terminal");
      if (pointer.outcome === "terminal") assert.equal(pointer.record.receiptStatus, "applied");

      const eventCount = session.events.length;
      await handlers[0]!(payload, next);
      assert.equal(session.events.length, eventCount, "terminal schedule replay must not rewrite a second time");

      const status = await executeContextCleanerCommand(context, config, invocation(session, `--status ${planId}`), dependencies);
      assert.match(status.text ?? "", /status: applied/u);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves the native tool/result envelope when a selected task is cleaned", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession("context-cleaner-tool-envelope-test", true);
      await persistSessionTaskRegistry(stateDir, completedRegistry(session), { expectedVersion: 0 });
      const context: ContextCleanerCommandContext = { commands: { register: () => () => {} } };
      const config = configured(stateDir);
      const dependencies = { now: () => "2026-09-18T00:00:00.000Z" };
      const analysis = await executeContextCleanerCommand(context, config, invocation(session, ""), dependencies);
      const planId = planIdFrom(analysis.text);
      const scheduled = await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--plan ${planId} --select meal-plan`),
        dependencies,
      );
      if (scheduled.kind !== "success") assert.fail(scheduled.text);

      const handlers: Handler[] = [];
      const runtimeContext: DshPluginContext = {
        on: (_event, handler) => { handlers.push(handler as Handler); },
        tokenMeter: { measure: () => {} },
      };
      registerDshCleanerPreStep(runtimeContext, config, createDshCleanerPreStepState());
      await handlers[0]!({
        agent: { session }, messages: [], turn: 2, step: 0, signal: { aborted: false },
      }, async () => ({ kind: "enter", messages: [] }));

      const status = await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--status ${planId}`),
        dependencies,
      );
      assert.match(status.text ?? "", /status: applied/u);

      const replacement = session.events.find((event) =>
        event.type === "tool/result" && (event as { sourceEventSeqs?: readonly number[] }).sourceEventSeqs?.includes(4),
      ) as { data?: Record<string, unknown> } | undefined;
      assert.ok(replacement, "the tool result must be replaced through the canonical transaction");
      assert.equal(replacement.data?.turn, 1);
      assert.equal(replacement.data?.step, 1);
      assert.deepEqual(replacement.data?.error, { name: "none", code: "none" });
      const message = replacement.data?.message as { content?: Array<{ content?: Array<{ text?: string }> }> };
      assert.equal(message.content?.[0]?.content?.[0]?.text, "[cleaned: tool_result @4]");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("terminalizes a stale scheduled plan without rewriting the surface", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession("context-cleaner-stale-test");
      await persistSessionTaskRegistry(stateDir, completedRegistry(session), { expectedVersion: 0 });
      const context: ContextCleanerCommandContext = { commands: { register: () => () => {} } };
      const config = configured(stateDir);
      const dependencies = { now: () => "2026-09-18T00:00:00.000Z" };

      const analysis = await executeContextCleanerCommand(context, config, invocation(session, ""), dependencies);
      if (analysis.kind !== "success") assert.fail(analysis.text);
      const planId = planIdFrom(analysis.text);
      const scheduled = await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--plan ${planId} --select meal-plan`),
        dependencies,
      );
      if (scheduled.kind !== "success") assert.fail(scheduled.text);

      // A selected item changed after planning. Append-only history is safely
      // rebased by the shared bridge, but a frozen target digest mismatch must
      // save a stale receipt instead of applying the original selection.
      const changedUser = session.events.find((event) => event.seq === 2) as {
        data: { content: Array<{ text?: string }> };
      };
      changedUser.data.content[0]!.text = "This original request was replaced after planning.";
      const handlers: Handler[] = [];
      let meterCalls = 0;
      const runtimeContext: DshPluginContext = {
        on: (_event, handler) => { handlers.push(handler as Handler); },
        tokenMeter: { measure: () => { meterCalls += 1; } },
      };
      registerDshCleanerPreStep(runtimeContext, config, createDshCleanerPreStepState());
      const payload: DshPreStepPayload = {
        agent: { session }, messages: [], turn: 2, step: 0, signal: { aborted: false },
      };
      const next: DshPreStepNext = async () => ({ kind: "enter", messages: [] });
      await handlers[0]!(payload, next);

      assert.equal(meterCalls, 0);
      assert.deepEqual(session.surface.nodes, [2, 3]);
      const pointer = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(pointer.outcome, "terminal");
      if (pointer.outcome === "terminal") assert.equal(pointer.record.receiptStatus, "stale");
      const status = await executeContextCleanerCommand(context, config, invocation(session, `--status ${planId}`), dependencies);
      assert.match(status.text ?? "", /status: stale/u);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not claim a local pointer until its shared plan and receipt are both scheduled", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession("context-cleaner-half-scheduled-test");
      const pointer = await scheduleDshCleanerPlan({
        stateDir,
        sessionId: session.id,
        cleanPlanId: "ctxclean-awaiting-shared-receipt",
        baseRevision: "dsh-surf-awaiting-shared-receipt",
        selectedTaskIds: ["meal-plan"],
        scheduledAt: "2026-09-18T00:00:00.000Z",
      });
      assert.equal(pointer.outcome, "stored");

      const handlers: Handler[] = [];
      const runtimeContext: DshPluginContext = {
        on: (_event, handler) => { handlers.push(handler as Handler); },
        tokenMeter: { measure: () => {} },
      };
      registerDshCleanerPreStep(runtimeContext, configured(stateDir), createDshCleanerPreStepState());
      const payload: DshPreStepPayload = {
        agent: { session }, messages: [], turn: 2, step: 0, signal: { aborted: false },
      };
      await handlers[0]!(payload, async () => ({ kind: "enter", messages: [] }));

      assert.deepEqual(session.surface.nodes, [2, 3]);
      const after = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(after.outcome, "ready", "the pointer remains retryable after a shared-store failure");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned claim into matching failed terminal states", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession("context-cleaner-abandoned-claim-test");
      await persistSessionTaskRegistry(stateDir, completedRegistry(session), { expectedVersion: 0 });
      const context: ContextCleanerCommandContext = { commands: { register: () => () => {} } };
      const config = configured(stateDir);
      const dependencies = { now: () => "2026-09-18T00:00:00.000Z" };
      const analysis = await executeContextCleanerCommand(context, config, invocation(session, ""), dependencies);
      const planId = planIdFrom(analysis.text);
      await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--plan ${planId} --select meal-plan`),
        dependencies,
      );
      const claim = await claimDshCleanerSchedule({
        stateDir,
        sessionId: session.id,
        cleanPlanId: planId,
        claimedAt: "2026-09-18T00:00:01.000Z",
      });
      assert.equal(claim.outcome, "claimed");

      const handlers: Handler[] = [];
      registerDshCleanerPreStep({
        on: (_event, handler) => { handlers.push(handler as Handler); },
        tokenMeter: { measure: () => {} },
      }, config, createDshCleanerPreStepState());
      await handlers[0]!({
        agent: { session }, messages: [], turn: 2, step: 0, signal: { aborted: false },
      }, async () => ({ kind: "enter", messages: [] }));

      const pointer = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(pointer.outcome, "terminal");
      if (pointer.outcome === "terminal") assert.equal(pointer.record.receiptStatus, "failed");
      const status = await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--status ${planId}`),
        dependencies,
      );
      assert.match(status.text ?? "", /status: failed/u);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("repairs a claimed pointer from an existing shared terminal receipt", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession("context-cleaner-terminal-reconcile-test");
      await persistSessionTaskRegistry(stateDir, completedRegistry(session), { expectedVersion: 0 });
      const context: ContextCleanerCommandContext = { commands: { register: () => () => {} } };
      const config = configured(stateDir);
      const dependencies = { now: () => "2026-09-18T00:00:00.000Z" };
      const analysis = await executeContextCleanerCommand(context, config, invocation(session, ""), dependencies);
      const planId = planIdFrom(analysis.text);
      await executeContextCleanerCommand(
        context,
        config,
        invocation(session, `--plan ${planId} --select meal-plan`),
        dependencies,
      );
      const claim = await claimDshCleanerSchedule({ stateDir, sessionId: session.id, cleanPlanId: planId });
      assert.equal(claim.outcome, "claimed");
      const scheduled = await readContextCleanReceipt({ stateDir, planId });
      assert.equal(scheduled.value?.status, "scheduled");
      await transitionContextCleanState({
        stateDir,
        receipt: {
          ...scheduled.value!,
          status: "failed",
          reasons: ["simulated_terminal_write_before_local_finalize"],
          updatedAt: "2026-09-18T00:00:02.000Z",
        },
      });

      const handlers: Handler[] = [];
      registerDshCleanerPreStep({
        on: (_event, handler) => { handlers.push(handler as Handler); },
        tokenMeter: { measure: () => {} },
      }, config, createDshCleanerPreStepState());
      await handlers[0]!({
        agent: { session }, messages: [], turn: 2, step: 0, signal: { aborted: false },
      }, async () => ({ kind: "enter", messages: [] }));

      const pointer = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(pointer.outcome, "terminal");
      if (pointer.outcome === "terminal") {
        assert.equal(pointer.record.receiptStatus, "failed");
        assert.deepEqual(pointer.record.reasons, ["simulated_terminal_write_before_local_finalize"]);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("cancels a scheduled plan without touching its context and leaves a terminal replay guard", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-cleaner-"));
    try {
      const session = makeSession("context-cleaner-cancel-test");
      const registry = completedRegistry(session);
      await persistSessionTaskRegistry(stateDir, registry, { expectedVersion: 0 });
      const context: ContextCleanerCommandContext = { commands: { register: () => () => {} } };
      const config = configured(stateDir);
      const dependencies = {
        now: () => "2026-09-18T00:00:00.000Z",
      };
      const analysis = await executeContextCleanerCommand(context, config, invocation(session, ""), dependencies);
      const planId = planIdFrom(analysis.text);
      await executeContextCleanerCommand(context, config, invocation(session, `--plan ${planId} --select meal-plan`), dependencies);

      const cancelled = await executeContextCleanerCommand(context, config, invocation(session, `--cancel ${planId}`), dependencies);
      if (cancelled.kind !== "success") assert.fail(cancelled.text);
      assert.match(cancelled.text ?? "", /status: cancelled/u);
      assert.deepEqual(session.surface.nodes, [2, 3]);

      const pointer = await readDshCleanerSchedule({ stateDir, sessionId: session.id });
      assert.equal(pointer.outcome, "terminal");
      if (pointer.outcome === "terminal") assert.equal(pointer.record.receiptStatus, "cancelled");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
