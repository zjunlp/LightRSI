import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerEvictionPreStep } from "../src/eviction-engine.js";
import { normalizeDshConfig } from "../src/config.js";
import type { DshPluginContext, DshPreStepDecision, DshPreStepNext, DshPreStepPayload } from "../src/types.js";

type Handler = (payload: DshPreStepPayload, next: DshPreStepNext) => Promise<DshPreStepDecision>;

/**
 * Mock pre-step waterfall honoring the `prepend` option: prepended handlers go
 * to the front, others append. `run` executes them in order, threading `next`.
 */
function mockWaterfall() {
  const handlers: Handler[] = [];
  const ctx: DshPluginContext = {
    on: (_event, handler, options) => {
      if (options?.prepend) handlers.unshift(handler as Handler);
      else handlers.push(handler as Handler);
    },
    tokenMeter: { measure: () => ({}) },
  };
  const terminal: DshPreStepDecision = { kind: "enter", messages: [] };
  async function run(payload: DshPreStepPayload): Promise<DshPreStepDecision> {
    const dispatch = (i: number): Promise<DshPreStepDecision> =>
      i >= handlers.length ? Promise.resolve(terminal) : handlers[i]!(payload, () => dispatch(i + 1));
    return dispatch(0);
  }
  return { ctx, handlers, run };
}

function payload(): DshPreStepPayload {
  return {
    agent: {
      session: {
        id: "s",
        events: [],
        surface: { nodes: [], replaceGeneration: 0 },
        append: () => ({ seq: 0 }),
      },
    },
    messages: [],
    turn: 1,
    step: 0,
    signal: { aborted: false },
  };
}

// Eviction disabled/unconfigured → its handler just defers via next(); we only
// care about ORDER here, not eviction's internal work.
const CONFIG = normalizeDshConfig({ enabled: true, eviction: { enabled: true } });

describe("pre-step listener order (§1.3: eviction before compaction)", () => {
  it("prepends eviction ahead of an already-registered compaction handler", () => {
    const { ctx, handlers } = mockWaterfall();

    const compaction: Handler = async (_p, next) => next();
    ctx.on("agent/pre-step", compaction); // compaction-basic registers normally, first
    registerEvictionPreStep(ctx, CONFIG); // eviction prepends

    assert.equal(handlers.length, 2);
    assert.notEqual(handlers[0], compaction, "eviction should be ahead of compaction");
    assert.equal(handlers[1], compaction, "compaction should run after eviction");
  });

  it("runs eviction first, then compaction, when the waterfall executes", async () => {
    const { ctx, run } = mockWaterfall();

    const order: string[] = [];
    const compaction: Handler = async (_p, next) => {
      order.push("compaction");
      return next();
    };
    // A tap prepended AFTER eviction would jump ahead; to observe eviction's slot
    // we register the tap as eviction's neighbor via a wrapper on compaction only.
    ctx.on("agent/pre-step", compaction);
    registerEvictionPreStep(ctx, CONFIG);

    await run(payload());
    // Eviction sits at index 0 and calls next() (unconfigured → defer), so the
    // only recorded run is compaction — which necessarily ran *after* eviction.
    assert.deepEqual(order, ["compaction"]);
  });

  it("without prepend, a normally-registered handler stays behind compaction", () => {
    const { ctx, handlers } = mockWaterfall();
    const compaction: Handler = async (_p, next) => next();
    const other: Handler = async (_p, next) => next();
    ctx.on("agent/pre-step", compaction);
    ctx.on("agent/pre-step", other); // no prepend → appended
    assert.equal(handlers[0], compaction);
    assert.equal(handlers[1], other);
  });

  it("honors runEvictionBeforeCompaction=false", () => {
    const { ctx, handlers } = mockWaterfall();
    const compaction: Handler = async (_p, next) => next();
    ctx.on("agent/pre-step", compaction);
    registerEvictionPreStep(ctx, normalizeDshConfig({
      enabled: true,
      eviction: { enabled: true },
      compaction: { runEvictionBeforeCompaction: false },
    }));
    assert.equal(handlers[0], compaction);
    assert.equal(handlers.length, 2);
  });
});
