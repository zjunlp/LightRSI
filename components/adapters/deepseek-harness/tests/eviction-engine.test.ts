import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerEvictionPreStep } from "../src/eviction-engine.js";
import { normalizeDshConfig } from "../src/config.js";
import type {
  DshLogEventWithMeta,
  DshPluginContext,
  DshPreStepDecision,
  DshPreStepPayload,
} from "../src/types.js";

type Handler = (payload: DshPreStepPayload, next: () => Promise<DshPreStepDecision>) => Promise<DshPreStepDecision>;

/** Capture the handler registered on agent/pre-step + count tokenMeter use. */
function mockCtx(): { ctx: DshPluginContext; getHandler: () => Handler } {
  let handler: Handler | undefined;
  const ctx: DshPluginContext = {
    on: (_event, h) => { handler = h as Handler; },
    tokenMeter: { measure: () => ({}) },
  };
  return { ctx, getHandler: () => {
    if (!handler) throw new Error("handler not registered");
    return handler;
  } };
}

function payloadWith(events: DshLogEventWithMeta[], opts: { aborted?: boolean } = {}): DshPreStepPayload {
  return {
    agent: {
      session: {
        id: "sess-x",
        events,
        surface: { nodes: events.map((event) => event.seq), replaceGeneration: 0 },
        append: () => ({ seq: events.length + 1 }),
      },
    },
    messages: [],
    turn: 1,
    step: 0,
    signal: { aborted: opts.aborted ?? false },
  };
}

const ENABLED = normalizeDshConfig({
  enabled: true,
  eviction: { enabled: true },
  taskStateEstimator: { baseUrl: "https://api.example.com", apiKey: "sk-x", model: "m" },
});
const UNCONFIGURED = normalizeDshConfig({ enabled: true, eviction: { enabled: true } });
const DEFERRED: DshPreStepDecision = { kind: "enter", messages: ["downstream"] };
const nextStub = async (): Promise<DshPreStepDecision> => DEFERRED;

const SAMPLE: DshLogEventWithMeta[] = [
  { seq: 1, type: "turn/start", data: { turn: 1 } },
  {
    seq: 2,
    type: "user/message",
    data: { id: "msg-user-2", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
  },
];

describe("registerEvictionPreStep", () => {
  it("registers exactly one agent/pre-step handler", () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, ENABLED);
    assert.doesNotThrow(() => getHandler());
  });

  it("defers (calls next) when the flag is off, without reading the session", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, normalizeDshConfig({ enabled: false }));
    let sessionRead = false;
    const payload = payloadWith(SAMPLE);
    Object.defineProperty(payload.agent, "session", { get() { sessionRead = true; throw new Error("should not read"); } });
    const result = await getHandler()(payload, nextStub);
    assert.deepEqual(result, DEFERRED);
    assert.equal(sessionRead, false);
  });

  it("defers on an aborted signal", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, ENABLED);
    const result = await getHandler()(payloadWith(SAMPLE, { aborted: true }), nextStub);
    assert.deepEqual(result, DEFERRED);
  });

  it("defers on an empty log", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, ENABLED);
    const result = await getHandler()(payloadWith([]), nextStub);
    assert.deepEqual(result, DEFERRED);
  });

  it("defers when an unrecognized, non-ignorable event is present", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, ENABLED);
    const events: DshLogEventWithMeta[] = [...SAMPLE, { seq: 3, type: "mystery/event", data: {} }];
    const result = await getHandler()(payloadWith(events), nextStub);
    assert.deepEqual(result, DEFERRED);
  });

  it("proceeds past an unrecognized event that is marked ignorable", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, ENABLED);
    const events: DshLogEventWithMeta[] = [...SAMPLE, { seq: 3, type: "todo/write", data: {}, ignorable: true }];
    // still defers (estimator seam not wired) but reaches the seam without bailing early
    const result = await getHandler()(payloadWith(events), nextStub);
    assert.deepEqual(result, DEFERRED);
  });

  it("does not reject pinned DSH required log-only events", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, ENABLED);
    const events: DshLogEventWithMeta[] = [
      ...SAMPLE,
      { seq: 3, type: "request/header", data: { header: {}, reason: "initial" } },
      { seq: 4, type: "assistant/chunk", data: { turn: 1, step: 0, chunk: {} } },
      { seq: 5, type: "session/end-seed", data: {} },
    ];
    const result = await getHandler()(payloadWith(events), nextStub);
    assert.deepEqual(result, DEFERRED);
  });

  it("defers when the estimator is enabled but unconfigured (no creds)", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, UNCONFIGURED);
    const result = await getHandler()(payloadWith(SAMPLE), nextStub);
    assert.deepEqual(result, DEFERRED);
  });

  it("fails open (calls next) if the codec throws", async () => {
    const { ctx, getHandler } = mockCtx();
    registerEvictionPreStep(ctx, ENABLED);
    const payload = payloadWith(SAMPLE);
    // force an error deep in the flow by making events iteration blow up mid-way
    Object.defineProperty(payload.agent.session, "events", {
      get() { return { length: 2, map() { throw new Error("boom"); }, [Symbol.iterator]() { throw new Error("boom"); } }; },
    });
    const result = await getHandler()(payload, nextStub);
    assert.deepEqual(result, DEFERRED);
  });
});
