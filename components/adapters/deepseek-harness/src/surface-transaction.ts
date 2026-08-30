/**
 * Canonical surface transaction (Task-R4).
 *
 * Turns R3's safe evict decisions into real canonical-surface mutations, the way
 * DSH's own compaction does (compaction-basic/src/region.ts): append a durable
 * lifecycle bracket, then append replacement events carrying
 * `surfaceOp: { op: 'replace', ... }` + `sourceEventSeqs`. The append-only log is
 * never edited in place — the evicted nodes stay for audit/replay; only the
 * current surface (deriveMessages) stops showing them.
 *
 * Transaction shape (durable, log-only events):
 *   eviction/start   — before ANY replacement; carries the revision it planned against
 *   <replacement>*   — one per target: same role, pointer-stub content, surfaceOp replace
 *   eviction/applied — one per landed replacement
 *   eviction/end     — last; status committed | partial | aborted
 *
 * Safety:
 *   - re-reads the surface and DEFERS the whole batch (no appends) if the
 *     revision changed or any target left the surface (§4.3);
 *   - a mid-transaction failure is reported as a real partial commit — only
 *     truly-landed replacements count; nothing is faked as a clean rollback;
 *   - fail-open: the caller treats any non-committed result as "no eviction this
 *     turn" and proceeds with the original surface.
 *
 * NOTE ON TYPES: the three eviction events are appended by string key. The
 * intended final form registers them on DSH's SessionEventMap via declaration
 * merging once the adapter takes a `@deepseek-ai/dsh-session/types` dependency:
 *
 *   declare module '@deepseek-ai/dsh-session/types' {
 *     interface SessionEventMap {
 *       'eviction/start': EvictionStartData;
 *       'eviction/applied': EvictionAppliedData;
 *       'eviction/end': EvictionEndData;
 *     }
 *   }
 *
 * Kept decoupled here (like the rest of the adapter) so it builds without a DSH
 * import; the runtime append is unaffected.
 */

/** A canonical replace over a durable seq range. */
export type SurfaceReplaceOp = { op: "replace"; start: number; end: number };

export interface EvictionStartData {
  evictionId: string;
  revision: string;
  targetSeqs: readonly number[];
  createdAt: string;
}

export interface EvictionAppliedData {
  evictionId: string;
  sourceEventSeq: number;
  replacementSeq: number;
}

export interface EvictionEndData {
  evictionId: string;
  status: "committed" | "partial" | "aborted";
  appliedSeqs: readonly number[];
  failedSeqs: readonly number[];
}

export interface AppendOptions {
  surfaceOp?: SurfaceReplaceOp;
  sourceEventSeqs?: readonly number[];
  ignorable?: true;
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
  /** Preserve the original envelope role; only the visible content is replaced. */
  role: "user" | "assistant";
  /** Pointer-stub content that replaces the evicted visible text. */
  stubText: string;
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

function stubMessage(target: EvictionTarget): unknown {
  return {
    role: target.role,
    content: [{ type: "text", text: target.stubText }],
    source: { kind: "plugin", plugin: "tokenpilot-dsh", evicted: true },
  };
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

  const createdAt = new Date().toISOString();
  let startEvent: AppendedEvent;
  try {
    startEvent = session.append(
      "eviction/start",
      { evictionId: plan.evictionId, revision: plan.revision, targetSeqs: plan.targets.map((t) => t.sourceEventSeq), createdAt } satisfies EvictionStartData,
      { ignorable: true },
    );
  } catch {
    // Nothing landed; safe to treat as a clean defer.
    return { status: "deferred", deferReason: "revision-changed", ...base };
  }

  const applied: number[] = [];
  const failed: number[] = [];
  for (const target of plan.targets) {
    try {
      const replacement = session.append("user/message", stubMessage(target), {
        surfaceOp: { op: "replace", start: target.sourceEventSeq, end: target.sourceEventSeq },
        sourceEventSeqs: [target.sourceEventSeq, startEvent.seq],
      });
      session.append(
        "eviction/applied",
        { evictionId: plan.evictionId, sourceEventSeq: target.sourceEventSeq, replacementSeq: replacement.seq } satisfies EvictionAppliedData,
        { ignorable: true },
      );
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

  try {
    session.append(
      "eviction/end",
      { evictionId: plan.evictionId, status, appliedSeqs: applied, failedSeqs: failed } satisfies EvictionEndData,
      { ignorable: true },
    );
  } catch {
    // End marker failed to persist; the transaction is still whatever landed.
    // Leaving it without an end makes it discoverable as orphaned on restart.
  }

  return {
    status: status === "committed" ? "committed" : status === "aborted" ? "deferred" : "partial",
    evictionId: plan.evictionId,
    appliedSeqs: applied,
    failedSeqs: failed,
    ...(status === "aborted" ? { deferReason: "revision-changed" as const } : {}),
  };
}

/**
 * Restart recovery: an `eviction/start` with no matching `eviction/end` is an
 * interrupted transaction. Callers must settle it as interrupted evidence and
 * re-estimate — never silently resume the old plan.
 */
export function findOrphanedEvictionIds(
  events: readonly { type: string; data?: unknown }[],
): string[] {
  const started = new Set<string>();
  const ended = new Set<string>();
  for (const event of events) {
    const id = (event.data as { evictionId?: unknown } | undefined)?.evictionId;
    if (typeof id !== "string") continue;
    if (event.type === "eviction/start") started.add(id);
    else if (event.type === "eviction/end") ended.add(id);
  }
  return [...started].filter((id) => !ended.has(id));
}
