import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applySafetyPolicy, findDamagedPersistenceRecords, type SafetyItem, type TaskState } from "../src/safety-policy.js";
import { buildToolPairs, classifyPair } from "../src/tool-closure.js";

/**
 * This suite runs against 观祥's shared oracle (tests/fixtures/session-events.json,
 * PR #54). The estimator's task labels are treated as INPUT (taskState/current);
 * the safety policy's evict/keep is the OUTPUT under test.
 */
const fixtureUrl = new URL("./fixtures/session-events.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
  cases: Array<{
    id: string;
    events: Array<{ seq: number; type: string; data?: unknown }>;
    effectiveEventSeqs: number[];
    persistenceRecords?: unknown[];
    expected: {
      items: Array<{ sourceEventSeq: number; kind: string; taskState: TaskState; current: boolean; action: "evict" | "keep" }>;
      toolPairs: Array<{ callId: string; status: string; action: "evict" | "keep" | "defer" }>;
      damagedPersistenceRecordIndexes: number[];
    };
  }>;
};

function caseById(id: string) {
  const c = fixture.cases.find((x) => x.id === id);
  assert.ok(c, `missing fixture case ${id}`);
  return c;
}

function itemsFromExpected(c: ReturnType<typeof caseById>): SafetyItem[] {
  const callIdsBySeq = new Map<number, string[]>();
  for (const [callId, pair] of buildToolPairs(c.events, c.effectiveEventSeqs)) {
    for (const seq of [...pair.callSeqs, ...pair.resultSeqs]) {
      const callIds = callIdsBySeq.get(seq) ?? [];
      callIds.push(callId);
      callIdsBySeq.set(seq, callIds);
    }
  }
  return c.expected.items.map((it) => ({
    sourceEventSeq: it.sourceEventSeq,
    kind: it.kind,
    taskState: it.taskState,
    current: it.current,
    callIds: callIdsBySeq.get(it.sourceEventSeq),
    chars: 1,
  }));
}

describe("applySafetyPolicy against the shared G1 oracle", () => {
  for (const c of fixture.cases) {
    it(`matches expected evict/keep for '${c.id}'`, () => {
      const decision = applySafetyPolicy(itemsFromExpected(c), c.effectiveEventSeqs, c.events);
      for (const expected of c.expected.items) {
        assert.equal(
          decision.action.get(expected.sourceEventSeq),
          expected.action,
          `seq ${expected.sourceEventSeq} (${expected.kind}, ${expected.taskState})`,
        );
      }
    });

    it(`matches expected tool-pair actions for '${c.id}'`, () => {
      const decision = applySafetyPolicy(itemsFromExpected(c), c.effectiveEventSeqs, c.events);
      for (const pair of c.expected.toolPairs) {
        if (pair.action === "defer") {
          assert.ok(decision.deferredCallIds.includes(pair.callId), `${pair.callId} should be deferred (${pair.status})`);
        } else if (pair.action === "evict") {
          assert.ok(!decision.deferredCallIds.includes(pair.callId), `${pair.callId} should evict, not defer`);
        }
      }
    });
  }
});

describe("tool closure classification", () => {
  it("classifies closed / orphan / duplicate", () => {
    assert.equal(classifyPair([1], [2]), "closed");
    assert.equal(classifyPair([], [2]), "orphan_result");
    assert.equal(classifyPair([1], []), "missing_result");
    assert.equal(classifyPair([1, 3], [2]), "duplicate_call");
    assert.equal(classifyPair([1], [2, 4]), "duplicate_result");
  });

  it("keeps every result when one shared assistant call envelope is incomplete", () => {
    const events = [
      {
        seq: 1,
        type: "assistant/message",
        data: {
          message: {
            content: [
              { type: "tool-call", id: "call-a" },
              { type: "tool-call", id: "call-b" },
            ],
          },
        },
      },
      {
        seq: 2,
        type: "tool/result",
        data: {
          message: {
            source: { callId: "call-a" },
            content: [{ type: "tool-result", toolCallId: "call-a", content: [] }],
          },
        },
      },
    ];
    const decision = applySafetyPolicy([
      { sourceEventSeq: 1, kind: "tool_call", taskState: "completed", current: false, callIds: ["call-a", "call-b"], chars: 10 },
      { sourceEventSeq: 2, kind: "tool_result", taskState: "completed", current: false, callIds: ["call-a"], chars: 500 },
    ], [1, 2], events);
    assert.equal(decision.action.get(2), "keep");
    assert.deepEqual(decision.deferredCallIds, ["call-a", "call-b"]);
  });
});

describe("findDamagedPersistenceRecords", () => {
  it("flags malformed records by index, exposing no content", () => {
    const c = caseById("damaged-persistence-record");
    const damaged = findDamagedPersistenceRecords(c.persistenceRecords ?? []);
    assert.deepEqual(damaged, c.expected.damagedPersistenceRecordIndexes);
  });
});
