import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createEmptySessionTaskRegistry } from "@lightrsi/history";
import type { SemanticTaskUpdate } from "@lightrsi/eviction";

import { runDshEvictionCycle, describeEffectiveItems } from "../src/eviction-cycle.js";
import type { AppendOptions, AppendedEvent } from "../src/surface-transaction.js";
import type { DshLogEventWithMeta } from "../src/types.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/session-events.json", import.meta.url), "utf8"),
) as {
  cases: Array<{
    id: string;
    sessionId: string;
    events: DshLogEventWithMeta[];
    effectiveEventSeqs: number[];
    expected: { items: Array<{ sourceEventSeq: number; taskId: string; taskState: string; action: string }> };
  }>;
};

function caseById(id: string) {
  const c = fixture.cases.find((x) => x.id === id);
  assert.ok(c, `missing case ${id}`);
  return c;
}

function seqToTurn(c: ReturnType<typeof caseById>): Map<number, number> {
  const map = new Map<number, number>();
  let turn = 0;
  for (const e of c.events) {
    const data = (e.data ?? {}) as { turn?: number };
    if (e.type === "turn/start" && typeof data.turn === "number") turn = data.turn;
    map.set(e.seq, typeof data.turn === "number" ? data.turn : turn);
  }
  return map;
}

/**
 * Estimator that reproduces the fixture's task states as real taskUpdates, so
 * the shared mapper builds the registry the way production would. `completed`
 * tasks carry completionEvidence (the mapper rejects completed without it).
 */
function estimatorFor(c: ReturnType<typeof caseById>) {
  const turnOf = seqToTurn(c);
  const byTask = new Map<string, { state: string; turns: Set<number> }>();
  for (const item of c.expected.items) {
    const entry = byTask.get(item.taskId) ?? { state: item.taskState, turns: new Set<number>() };
    entry.turns.add(turnOf.get(item.sourceEventSeq) ?? 0);
    byTask.set(item.taskId, entry);
  }
  const taskUpdates: SemanticTaskUpdate[] = [...byTask.entries()].map(([taskId, { state, turns }]): SemanticTaskUpdate => {
    const completed = state === "completed";
    return {
      taskId,
      objective: `objective for ${taskId}`,
      lifecycle: completed ? "completed" : "active",
      coveredTurnAbsIds: [...turns].sort((a, b) => a - b).map((t) => `${c.sessionId}:t${t}`),
      ...(completed ? { completionEvidence: [`evidence:${taskId}`] } : {}),
    };
  });
  return { estimate: () => ({ baseVersion: 0, taskUpdates }) };
}

function mockSession(c: ReturnType<typeof caseById>) {
  const log: Array<{ type: string; opts?: AppendOptions }> = [];
  let nextSeq = 1000;
  const session = {
    id: c.sessionId,
    events: c.events,
    surface: { nodes: c.effectiveEventSeqs, replaceGeneration: 0 },
    append(type: string, _data: unknown, opts?: AppendOptions): AppendedEvent {
      log.push({ type, opts });
      return { seq: nextSeq++ };
    },
  };
  return { session, log };
}

const stableRevision = () => "rev-1";

describe("runDshEvictionCycle against the G1 oracle", () => {
  it("evicts exactly the expected seqs for 'lifecycle-and-tool-safety'", async () => {
    const c = caseById("lifecycle-and-tool-safety");
    const { session, log } = mockSession(c);
    const out = await runDshEvictionCycle({
      session,
      registry: createEmptySessionTaskRegistry(c.sessionId),
      estimator: estimatorFor(c),
      computeRevision: stableRevision,
    });

    const expectedEvict = c.expected.items.filter((i) => i.action === "evict").map((i) => i.sourceEventSeq).sort();
    assert.deepEqual(out.result.appliedSeqs.slice().sort((a, b) => a - b), expectedEvict);
    assert.equal(out.status, "applied");
    for (const item of c.expected.items) {
      if (item.action === "keep") assert.ok(!out.result.appliedSeqs.includes(item.sourceEventSeq), `seq ${item.sourceEventSeq} kept`);
    }
    assert.equal(log.filter((e) => e.type === "user/message").length, expectedEvict.length);
  });

  it("evicts nothing for the compaction case (all keep)", async () => {
    const c = caseById("compaction-replacement-and-unknown-event");
    const { session } = mockSession(c);
    const out = await runDshEvictionCycle({
      session,
      registry: createEmptySessionTaskRegistry(c.sessionId),
      estimator: estimatorFor(c),
      computeRevision: stableRevision,
    });
    assert.deepEqual(out.result.appliedSeqs, []);
  });
});

describe("describeEffectiveItems", () => {
  it("maps effective events to kind/role/turn, skips ignorable + off-surface", () => {
    const c = caseById("lifecycle-and-tool-safety");
    const items = describeEffectiveItems(c.events, c.effectiveEventSeqs);
    const bySeq = new Map(items.map((i) => [i.seq, i]));
    assert.equal(bySeq.get(3)?.kind, "tool_call");
    assert.equal(bySeq.get(4)?.kind, "tool_result");
    assert.equal(bySeq.get(4)?.role, "user");
    assert.equal(bySeq.get(5)?.role, "assistant");
    assert.equal(bySeq.get(18)?.turn, 4);
  });
});
