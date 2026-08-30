import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyEvictionTransaction,
  type AppendableSession,
  type AppendedEvent,
  type AppendOptions,
  type EvictionPlan,
} from "../src/surface-transaction.js";

interface Appended {
  type: string;
  data: unknown;
  opts?: AppendOptions;
  seq: number;
}

/** Mock DSH session that records appends and hands out increasing seqs. */
function mockSession(nodes: number[], opts: { failOnNthReplacement?: number } = {}): {
  session: AppendableSession;
  log: Appended[];
} {
  const log: Appended[] = [];
  let nextSeq = 100;
  let replacementCount = 0;
  const session: AppendableSession = {
    id: "sess-r4",
    surface: { nodes, replaceGeneration: 0 },
    append(type: string, data: unknown, appendOpts?: AppendOptions): AppendedEvent {
      if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
        replacementCount += 1;
        if (opts.failOnNthReplacement === replacementCount) throw new Error("append failed");
      }
      const seq = nextSeq++;
      log.push({ type, data, opts: appendOpts, seq });
      return { seq };
    },
  };
  return { session, log };
}

// 观祥 G1 case-1 evictables: seqs 2,3,4,5 (completed task, closed tool pair).
const REV = "dsh-rev-fixture";
function planFor(targetSeqs: number[]): EvictionPlan {
  return {
    evictionId: "evt-1",
    revision: REV,
    targets: targetSeqs.map((seq) => ({
      sourceEventSeq: seq,
      eventType: seq === 4 ? "tool/result" : "user/message",
      data: seq === 4
        ? {
            turn: 1,
            step: 0,
            message: {
              id: "result-4",
              role: "user",
              content: [{ type: "tool-result", toolCallId: "call-4", content: [{ type: "text", text: "[evicted #4]" }] }],
              source: { kind: "tool", callId: "call-4" },
            },
          }
        : seq === 2
          ? { id: "replacement-2", role: "user", content: [{ type: "text", text: "[evicted #2]" }], source: { kind: "plugin", plugin: "tokenpilot-dsh" } }
          : { id: `replacement-${seq}`, role: "user", content: [{ type: "text", text: `[evicted #${seq}]` }], source: { kind: "plugin", plugin: "tokenpilot-dsh" } },
    })),
  };
}
const okRevision = () => REV;

describe("applyEvictionTransaction", () => {
  it("writes only native replacement events and cites each shadowed node", () => {
    const { session, log } = mockSession([2, 3, 4, 5, 8, 18]);
    const result = applyEvictionTransaction(session, planFor([2, 3, 4, 5]), okRevision);

    assert.equal(result.status, "committed");
    assert.deepEqual(result.appliedSeqs, [2, 3, 4, 5]);

    // each replacement carries a canonical replace over its own seq + provenance.
    const replacements = log.filter((e) => e.opts?.surfaceOp !== undefined);
    assert.equal(replacements.length, 4);
    assert.deepEqual(replacements.map((event) => event.type), [
      "user/message",
      "user/message",
      "tool/result",
      "user/message",
    ]);
    for (const r of replacements) {
      const op = r.opts?.surfaceOp;
      assert.ok(op && op.op === "replace");
      assert.equal(op.start, op.end);
      assert.ok(r.opts?.sourceEventSeqs?.includes(op.start));
      assert.deepEqual(r.opts?.sourceEventSeqs, [op.start]);
    }
  });

  it("defers (no appends) when the revision drifted", () => {
    const { session, log } = mockSession([2, 3, 4, 5]);
    const result = applyEvictionTransaction(session, planFor([2, 3]), () => "different-rev");
    assert.equal(result.status, "deferred");
    assert.equal(result.deferReason, "revision-changed");
    assert.equal(log.length, 0);
  });

  it("defers when a target left the surface (membership changed)", () => {
    const { session, log } = mockSession([2, 3]); // 4,5 no longer on surface
    const result = applyEvictionTransaction(session, planFor([2, 3, 4, 5]), okRevision);
    assert.equal(result.status, "deferred");
    assert.equal(result.deferReason, "membership-changed");
    assert.equal(log.length, 0);
  });

  it("reports a real partial commit when a replacement fails mid-way", () => {
    const { session, log } = mockSession([2, 3, 4, 5], { failOnNthReplacement: 3 });
    const result = applyEvictionTransaction(session, planFor([2, 3, 4, 5]), okRevision);

    assert.equal(result.status, "partial");
    assert.deepEqual(result.appliedSeqs, [2, 3]); // only landed ones count
    assert.ok(result.failedSeqs.includes(4));
    assert.ok(result.failedSeqs.includes(5));
    assert.equal(log.filter((event) => event.opts?.surfaceOp !== undefined).length, 2);
  });

  it("is empty for an empty plan and never appends", () => {
    const { session, log } = mockSession([2, 3]);
    const result = applyEvictionTransaction(session, planFor([]), okRevision);
    assert.equal(result.status, "empty");
    assert.equal(log.length, 0);
  });
});
