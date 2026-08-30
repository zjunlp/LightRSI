/**
 * Canonical surface transaction (Task-R4).
 *
 * Turns R3's safe evict decisions into real canonical-surface mutations, the way
 * DSH's own compaction does (compaction-basic/src/region.ts): append durable
 * replacement events carrying `surfaceOp: { op: 'replace', ... }` and
 * `sourceEventSeqs`. The append-only log is
 * never edited in place — the evicted nodes stay for audit/replay; only the
 * current surface (deriveMessages) stops showing them.
 *
 * DSH currently has no out-of-tree registration API for appendable ignorable
 * event types. Writing plugin-owned `eviction/*` events would therefore create
 * an unknown required event that persistence refuses on restart. Transaction
 * evidence is derived from the atomic replacement appends themselves; each
 * replacement cites the exact shadowed node.
 *
 * Safety:
 *   - re-reads the surface and DEFERS the whole batch (no appends) if the
 *     revision changed or any target left the surface (§4.3);
 *   - a mid-transaction failure is reported as a real partial commit — only
 *     truly-landed replacements count; nothing is faked as a clean rollback;
 *   - fail-open: a clean failure mutates nothing; a partial result explicitly
 *     reports the replacements that already landed and must be re-metered.
 *
 */

/** A canonical replace over a durable seq range. */
export type SurfaceReplaceOp = { op: "replace"; start: number; end: number };

export interface AppendOptions {
  surfaceOp?: SurfaceReplaceOp;
  sourceEventSeqs?: readonly number[];
}

export interface AppendedEvent {
  seq: number;
}

/** The slice of a DSH Session R4 writes through. */
export interface AppendableSession {
  readonly id: string;
  readonly surface: {
    readonly nodes: readonly number[];
    readonly replaceGeneration: number;
  };
  append(type: string, data: unknown, opts?: AppendOptions): AppendedEvent;
}

/** One item cleared by R3, ready to be replaced with an auditable stub. */
export interface EvictionTarget {
  sourceEventSeq: number;
  /** Native DSH surface event type; never coerce every replacement to user/message. */
  eventType: "user/message" | "tool/result";
  /** Complete native envelope with only the intended visible content replaced. */
  data: unknown;
}

export interface EvictionPlan {
  evictionId: string;
  /** Revision the plan was computed against; re-checked before any mutation. */
  revision: string;
  targets: readonly EvictionTarget[];
}

export type TransactionStatus = "committed" | "partial" | "deferred" | "empty";

export interface TransactionResult {
  status: TransactionStatus;
  evictionId: string;
  /** Source seqs whose replacement actually landed (the only real savings). */
  appliedSeqs: number[];
  failedSeqs: number[];
  deferReason?: "revision-changed" | "membership-changed";
}

/**
 * Apply an eviction plan to the live session as a canonical transaction.
 * `computeRevision(session)` must return the same revision scheme the plan used.
 */
export function applyEvictionTransaction(
  session: AppendableSession,
  plan: EvictionPlan,
  computeRevision: (session: AppendableSession) => string,
): TransactionResult {
  const base = { evictionId: plan.evictionId, appliedSeqs: [] as number[], failedSeqs: [] as number[] };

  if (plan.targets.length === 0) {
    return { status: "empty", ...base };
  }

  // Guard 1: revision drift → defer the whole batch, mutate nothing.
  if (computeRevision(session) !== plan.revision) {
    return { status: "deferred", deferReason: "revision-changed", ...base };
  }

  // Guard 2: every target must still be on the current surface.
  const onSurface = new Set(session.surface.nodes);
  if (!plan.targets.every((t) => onSurface.has(t.sourceEventSeq))) {
    return { status: "deferred", deferReason: "membership-changed", ...base };
  }

  const applied: number[] = [];
  const failed: number[] = [];
  for (const target of plan.targets) {
    try {
      session.append(target.eventType, target.data, {
        surfaceOp: { op: "replace", start: target.sourceEventSeq, end: target.sourceEventSeq },
        sourceEventSeqs: [target.sourceEventSeq],
      });
      applied.push(target.sourceEventSeq);
    } catch {
      // Partial commit: record and stop. Do NOT pretend the earlier ones rolled back.
      failed.push(target.sourceEventSeq);
      break;
    }
  }

  // Any targets not yet attempted after a failure are also "not applied".
  for (const target of plan.targets) {
    if (!applied.includes(target.sourceEventSeq) && !failed.includes(target.sourceEventSeq)) {
      failed.push(target.sourceEventSeq);
    }
  }

  const status: "committed" | "partial" | "aborted" =
    applied.length === plan.targets.length ? "committed" : applied.length === 0 ? "aborted" : "partial";

  return {
    status: status === "committed" ? "committed" : status === "aborted" ? "deferred" : "partial",
    evictionId: plan.evictionId,
    appliedSeqs: applied,
    failedSeqs: failed,
    ...(status === "aborted" ? { deferReason: "revision-changed" as const } : {}),
  };
}
