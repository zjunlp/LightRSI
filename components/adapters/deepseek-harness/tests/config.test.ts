import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DSH_CONFIG_DEFAULTS, normalizeDshConfig } from "../src/config.js";

describe("normalizeDshConfig", () => {
  it("defaults to a fully-off, fail-open config on empty input", () => {
    const c = normalizeDshConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.logLevel, "info");
    assert.equal(c.stateDir, undefined);
    assert.equal(c.taskStateEstimator.enabled, false);
    assert.equal(c.taskStateEstimator.requestTimeoutMs, DSH_CONFIG_DEFAULTS.estimator.requestTimeoutMs);
    assert.equal(c.taskStateEstimator.batchTurns, 5);
    assert.equal(c.taskStateEstimator.evictionLookaheadTurns, 3);
    assert.equal(c.eviction.enabled, false);
    assert.equal(c.eviction.minBlockChars, 200);
    assert.equal(c.eviction.failureMode, "bypass");
    assert.equal(c.compaction.runEvictionBeforeCompaction, true);
  });

  it("tolerates junk input (null/array/string) as empty", () => {
    for (const junk of [null, undefined, [], "nope", 42]) {
      const c = normalizeDshConfig(junk);
      assert.equal(c.enabled, false);
      assert.equal(c.eviction.failureMode, "bypass");
    }
  });

  it("clamps numeric fields to their bounds and truncates", () => {
    const c = normalizeDshConfig({
      taskStateEstimator: { requestTimeoutMs: 10, batchTurns: 0, evictionLookaheadTurns: 9999 },
      eviction: { minBlockChars: -5 },
    });
    assert.equal(c.taskStateEstimator.requestTimeoutMs, 1_000); // min
    assert.equal(c.taskStateEstimator.batchTurns, 1); // min
    assert.equal(c.taskStateEstimator.evictionLookaheadTurns, 50); // max
    assert.equal(c.eviction.minBlockChars, 0); // min
  });

  it("rejects unknown enum values, falls back", () => {
    const c = normalizeDshConfig({
      logLevel: "trace",
      taskStateEstimator: { inputMode: "wat", lifecycleMode: "coupled", evidenceMode: "nope" },
    });
    assert.equal(c.logLevel, "info"); // bad -> default
    assert.equal(c.taskStateEstimator.inputMode, undefined); // bad -> undefined
    assert.equal(c.taskStateEstimator.lifecycleMode, "coupled"); // valid -> kept
    assert.equal(c.taskStateEstimator.evidenceMode, undefined); // bad -> undefined
  });

  it("passes a fully-specified valid config through", () => {
    const c = normalizeDshConfig({
      enabled: true,
      stateDir: " /tmp/lightrsi-dsh-test ",
      logLevel: "debug",
      taskStateEstimator: {
        enabled: true,
        baseUrl: "https://api.example.com",
        apiKey: "sk-x",
        model: "some-model",
        requestTimeoutMs: 30_000,
        batchTurns: 8,
        evictionLookaheadTurns: 4,
        inputMode: "completed_summary_plus_active_turns",
        lifecycleMode: "decoupled",
        evidenceMode: "three_state",
      },
      eviction: { enabled: true, minBlockChars: 500 },
      compaction: { runEvictionBeforeCompaction: false },
    });
    assert.equal(c.enabled, true);
    assert.equal(c.stateDir, "/tmp/lightrsi-dsh-test");
    assert.equal(c.taskStateEstimator.baseUrl, "https://api.example.com");
    assert.equal(c.taskStateEstimator.batchTurns, 8);
    assert.equal(c.taskStateEstimator.inputMode, "completed_summary_plus_active_turns");
    assert.equal(c.eviction.enabled, true);
    assert.equal(c.eviction.minBlockChars, 500);
    assert.equal(c.compaction.runEvictionBeforeCompaction, false);
    assert.equal(c.eviction.failureMode, "bypass"); // always forced
  });

  it("trims string fields and drops empties", () => {
    const c = normalizeDshConfig({ taskStateEstimator: { baseUrl: "  ", apiKey: "  k  " } });
    assert.equal(c.taskStateEstimator.baseUrl, undefined);
    assert.equal(c.taskStateEstimator.apiKey, "k");
  });
});
