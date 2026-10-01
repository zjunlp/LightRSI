import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSessionTaskRegistry,
  loadRawSemanticTurnRecord,
  persistRawSemanticTurnRecord,
  persistSessionTaskRegistry,
  type SessionTaskRegistry,
  type DeltaView,
} from "@lightrsi/history";
import type { TaskStateEstimator } from "@lightrsi/eviction";
import {
  buildUniqueToolCallTurnMap,
  loadPersistedToolCallTurnMap,
  runSemanticPipeline,
} from "../src/context-rewrite/semantic-pipeline.js";
import { buildRawSemanticTurnRecord } from "../src/context-rewrite/semantic-mapping.js";
import { updateRegistryFromDelta as realUpdateRegistryFromDelta } from "../src/context-rewrite/task-registry-update.js";

async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lightrsi-semantic-pipeline-"));
}

// A no-op estimator: the pipeline injects updateRegistryFromDelta, so the
// estimator object itself is never actually called in these tests — the fake
// updater decides the outcome. We still pass one to satisfy the type.
const fakeEstimator: TaskStateEstimator = {
  estimate: () => ({ baseVersion: 0, taskUpdates: [] }),
};

const SIMPLE_MESSAGES = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  { role: "assistant", content: [{ type: "text", text: "hi" }] },
];

test("changed=true: persists the updated registry (watermark advanced by mapper)", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-1";

  // Fake updater: returns a registry whose watermark the mapper already
  // advanced to the delta's toTurnSeqInclusive, and version bumped.
  const updateRegistryFromDelta = async (args: {
    registry: SessionTaskRegistry;
    delta: DeltaView;
    estimator: TaskStateEstimator;
  }) => {
    const next: SessionTaskRegistry = {
      ...args.registry,
      lastProcessedTurnSeq: args.delta.toTurnSeqInclusive,
      version: args.registry.version + 1,
    };
    return { registry: next, changed: true };
  };

  const result = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator: fakeEstimator,
    updateRegistryFromDelta,
  });

  assert.equal(result.ran, true);
  assert.equal(result.changed, true);
  assert.equal(result.turnSeq, 1);

  // The registry was persisted with the advanced watermark.
  const persisted = await loadSessionTaskRegistry(stateDir, sessionId);
  assert.equal(persisted.lastProcessedTurnSeq, 1);
});

test("changed=false: does NOT persist, watermark stays put (re-covers next turn)", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-2";

  const updateRegistryFromDelta = async (args: {
    registry: SessionTaskRegistry;
    delta: DeltaView;
    estimator: TaskStateEstimator;
  }) => {
    return { registry: args.registry, changed: false, note: "no_updates" };
  };

  const result = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator: fakeEstimator,
    updateRegistryFromDelta,
  });

  assert.equal(result.ran, true);
  assert.equal(result.changed, false);
  assert.equal(result.note, "no_updates");

  // Watermark not advanced (still 0) because nothing changed.
  const persisted = await loadSessionTaskRegistry(stateDir, sessionId);
  assert.equal(persisted.lastProcessedTurnSeq, 0);
});

test("version conflict during persist is abandoned, not clobbered", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-3";

  // Pre-seed a registry at version 5 so the pipeline's expectedVersion (0,
  // from its own fresh load) will mismatch when it tries to persist.
  const seeded = await loadSessionTaskRegistry(stateDir, sessionId);
  await persistSessionTaskRegistry(stateDir, { ...seeded, version: 5 });

  const updateRegistryFromDelta = async (args: {
    registry: SessionTaskRegistry;
    delta: DeltaView;
    estimator: TaskStateEstimator;
  }) => {
    // Pipeline loaded version 5, so expectedVersion=5 — force a mismatch by
    // having ANOTHER writer bump it to 6 before our persist runs.
    await persistSessionTaskRegistry(stateDir, { ...args.registry, version: 6 });
    const next: SessionTaskRegistry = {
      ...args.registry,
      lastProcessedTurnSeq: args.delta.toTurnSeqInclusive,
      version: args.registry.version + 1,
    };
    return { registry: next, changed: true };
  };

  const result = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator: fakeEstimator,
    updateRegistryFromDelta,
  });

  assert.equal(result.ran, true);
  assert.equal(result.changed, false);
  assert.equal(result.note, "version_conflict");
});

test("interval covers only (lastProcessed, now]", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-4";

  // Advance the registry watermark to 1 first so the next run's interval
  // starts after turn 1.
  const seeded = await loadSessionTaskRegistry(stateDir, sessionId);
  await persistSessionTaskRegistry(stateDir, { ...seeded, lastProcessedTurnSeq: 1 });

  let seenDelta: DeltaView | undefined;
  const updateRegistryFromDelta = async (args: {
    registry: SessionTaskRegistry;
    delta: DeltaView;
    estimator: TaskStateEstimator;
  }) => {
    seenDelta = args.delta;
    return { registry: args.registry, changed: false };
  };

  // First run bumps turnSeq to 1... but watermark is already 1, so interval is
  // empty. Run again to get turnSeq 2 with a (1, 2] interval.
  await runSemanticPipeline({
    stateDir, sessionId, messages: SIMPLE_MESSAGES,
    estimator: fakeEstimator, updateRegistryFromDelta,
  });
  await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: [
      { role: "user", content: [{ type: "text", text: "a different request" }] },
    ],
    estimator: fakeEstimator, updateRegistryFromDelta,
  });

  assert.ok(seenDelta);
  assert.equal(seenDelta!.fromTurnSeqExclusive, 1);
  assert.equal(seenDelta!.toTurnSeqInclusive, 2);
});

test("a successful no-op estimate advances the watermark once", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-noop";
  const estimator: TaskStateEstimator = {
    estimate: () => ({ baseVersion: 0, taskUpdates: [] }),
  };

  const first = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator,
    updateRegistryFromDelta: realUpdateRegistryFromDelta,
  });
  const retry = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator,
    updateRegistryFromDelta: realUpdateRegistryFromDelta,
  });

  assert.equal(first.changed, false);
  assert.equal(retry.note, "already_processed");
  const registry = await loadSessionTaskRegistry(stateDir, sessionId);
  assert.equal(registry.lastProcessedTurnSeq, 1);
  assert.equal(registry.version, 1);
});

test("a retry restores a raw turn that was missing after a claimed counter", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-raw-retry";
  const estimator: TaskStateEstimator = {
    estimate: () => ({ baseVersion: 0, taskUpdates: [] }),
  };

  await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator,
    updateRegistryFromDelta: async () => {
      throw new Error("simulate raw turn follow-up failure");
    },
  });

  // The pipeline above wrote its raw record before the injected updater fails,
  // so remove it to model a process dying between turn claim and raw record
  // persistence. The retry must restore it rather than consume an empty delta.
  const { unlink } = await import("node:fs/promises");
  const { rawSemanticTurnRecordPath } = await import("@lightrsi/history");
  await unlink(rawSemanticTurnRecordPath(stateDir, sessionId, 1));

  const retry = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator,
    updateRegistryFromDelta: realUpdateRegistryFromDelta,
  });

  assert.equal(retry.turnSeq, 1);
  assert.equal(await loadRawSemanticTurnRecord(stateDir, sessionId, 1) !== null, true);
  assert.equal((await loadSessionTaskRegistry(stateDir, sessionId)).lastProcessedTurnSeq, 1);
});

test("an internal error fails open (ran=false, request path unaffected)", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-5";

  const updateRegistryFromDelta = async () => {
    throw new Error("boom inside update");
  };

  const result = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: SIMPLE_MESSAGES,
    estimator: fakeEstimator,
    updateRegistryFromDelta,
  });

  assert.equal(result.ran, false);
  assert.equal(result.changed, false);
  assert.equal(result.note, "pipeline_error");
});

test("tool call attribution fails closed when a call id appears in multiple turns", () => {
  const anchor = (turnSeq: number) => ({
    sessionId: "sess-map",
    turnAbsId: `sess-map:t${turnSeq}`,
    turnSeq,
    role: "tool" as const,
  });
  const turns = [1, 2].map((turnSeq) => ({
    sessionId: "sess-map",
    turnSeq,
    turnAbsId: `sess-map:t${turnSeq}`,
    messages: [],
    toolCalls: [{
      anchor: anchor(turnSeq),
      toolCallId: "duplicate-call-id",
      toolName: "Read",
      argumentsSummary: "{}",
    }],
    toolResults: [],
  }));

  assert.equal(buildUniqueToolCallTurnMap(turns).has("duplicate-call-id"), false);
  assert.equal(
    buildUniqueToolCallTurnMap([turns[0]!]).get("duplicate-call-id"),
    "sess-map:t1",
  );
});

test("loads the persisted tool-call turn map without claiming a new turn", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-persisted-map";
  const record = buildRawSemanticTurnRecord({
    sessionId,
    turnSeq: 3,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_persisted", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_persisted", content: "done" }],
      },
    ],
  });
  await persistRawSemanticTurnRecord(stateDir, record);

  const result = await loadPersistedToolCallTurnMap({ stateDir, sessionId });

  assert.equal(result.get("toolu_persisted"), `${sessionId}:t3`);
  assert.equal(await loadRawSemanticTurnRecord(stateDir, sessionId, 4), null);
});

test("internal Claude metadata requests do not advance or invoke the semantic estimator", async () => {
  const stateDir = await tempStateDir();
  const sessionId = "sess-internal-request";
  let updateCalls = 0;

  const result = await runSemanticPipeline({
    stateDir,
    sessionId,
    messages: [{
      role: "user",
      content: "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]",
    }],
    estimator: fakeEstimator,
    updateRegistryFromDelta: async ({ registry }) => {
      updateCalls += 1;
      return { registry, changed: false };
    },
  });

  assert.equal(result.ran, true);
  assert.equal(result.changed, false);
  assert.equal(result.note, "internal_request_ignored");
  assert.equal(updateCalls, 0);
  assert.equal((await loadSessionTaskRegistry(stateDir, sessionId)).lastProcessedTurnSeq, 0);
  assert.equal(await loadRawSemanticTurnRecord(stateDir, sessionId, 1), null);
});
