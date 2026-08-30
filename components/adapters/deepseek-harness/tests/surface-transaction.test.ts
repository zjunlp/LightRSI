import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyEvictionTransaction,
  findOrphanedEvictionIds,
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
      if (type === "user/message") {
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
      role: seq === 4 ? "user" : "assistant",
      stubText: `[evicted #${seq}]`,
    })),
  };
}
const okRevision = () => REV;

describe("applyEvictionTransaction", () => {
  it("brackets replacements with start/end and replaces each target on the surface", () => {
    const { session, log } = mockSession([2, 3, 4, 5, 8, 18]);
    const result = applyEvictionTransaction(session, planFor([2, 3, 4, 5]), okRevision);

    assert.equal(result.status, "committed");
    assert.deepEqual(result.appliedSeqs, [2, 3, 4, 5]);

    // start is first, end is last, both log-only.
    assert.equal(log[0].type, "eviction/start");
    assert.equal(log[0].opts?.ignorable, true);
    assert.equal(log.at(-1)?.type, "eviction/end");
    assert.equal((log.at(-1)?.data as { status: string }).status, "committed");

    // each replacement carries a canonical replace over its own seq + provenance.
    const replacements = log.filter((e) => e.type === "user/message");
    assert.equal(replacements.length, 4);
    for (const r of replacements) {
      const op = r.opts?.surfaceOp;
      assert.ok(op && op.op === "replace");
      assert.equal(op.start, op.end);
      assert.ok(r.opts?.sourceEventSeqs?.includes(op.start));
      assert.ok(r.opts?.sourceEventSeqs?.includes(log[0].seq)); // references eviction/start
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
    assert.equal((log.at(-1)?.data as { status: string }).status, "partial");
  });

  it("is empty for an empty plan and never appends", () => {
    const { session, log } = mockSession([2, 3]);
    const result = applyEvictionTransaction(session, planFor([]), okRevision);
    assert.equal(result.status, "empty");
    assert.equal(log.length, 0);
  });
});

describe("findOrphanedEvictionIds", () => {
  it("finds a start with no matching end", () => {
    const events = [
      { type: "eviction/start", data: { evictionId: "a" } },
      { type: "eviction/applied", data: { evictionId: "a" } },
      { type: "eviction/end", data: { evictionId: "a" } },
      { type: "eviction/start", data: { evictionId: "b" } }, // interrupted
    ];
    assert.deepEqual(findOrphanedEvictionIds(events), ["b"]);
  });

  it("returns nothing when all transactions closed", () => {
    const events = [
      { type: "eviction/start", data: { evictionId: "a" } },
      { type: "eviction/end", data: { evictionId: "a" } },
    ];
    assert.deepEqual(findOrphanedEvictionIds(events), []);
  });
});
