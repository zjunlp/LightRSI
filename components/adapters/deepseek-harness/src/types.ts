/**
 * DSH-owned bridge types consumed by the DeepSeek Harness session codec.
 *
 * Per the integration non-goals (§2.2), DSH-native event/message shapes must
 * stay inside this adapter and must NOT leak into LightRSI's shared persistent
 * contract. So instead of importing deep DSH internal packages, the codec
 * consumes these minimal structural mirrors of the exact DSH events it maps.
 * A thin pre-step layer (eviction-engine) feeds real DSH `SessionEvent`s in;
 * they already match structurally, so no conversion logic is needed there.
 *
 * Every field below is mirrored from the pinned DSH source
 * (deepseek-harness @ 141eb6f):
 *   - SessionEventMap            packages/core/session/src/types.ts:236
 *   - Message / *Message         packages/llm/llm/src/message.ts:135-160
 *   - ContentBlock union         packages/llm/llm/src/types.ts:54-110
 *
 * If a mirrored shape drifts from DSH on a version bump, the compatibility
 * smoke (G5) is where that surfaces — this file is the single place to update.
 */

/** DSH `CallId` is a branded string; we only need its string identity here. */
export type DshCallId = string;

/** Mirror of DSH ContentBlock variants the codec reads (switch on `type`, fall through unknowns). */
export type DshContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: DshCallId; name: string; arguments: string }
  | { type: "tool-result"; toolCallId: DshCallId; content: DshContentBlock[]; isError?: boolean }
  // merge-extensible: unknown block types are tolerated and ignored, never fatal.
  | { type: string; [k: string]: unknown };

/** Mirror of DSH `Message` (packages/llm/llm/src/message.ts:135). */
export interface DshMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: DshContentBlock[];
  /** `source.kind` distinguishes human `user` from synthetic `plugin` injection. */
  source: { kind: string; callId?: DshCallId; [k: string]: unknown };
}

/**
 * A durable DSH `SessionEvent`, narrowed to the members the codec maps.
 * `seq` is the append-only log sequence — the stable anchor (§4.1). `type` is
 * the `SessionEventMap` key; `data` is that member's payload.
 */
export type DshDurableEvent =
  | { seq: number; type: "turn/start"; data: { turn: number } }
  | { seq: number; type: "turn/end"; data: { turn: number; reason?: unknown } }
  | { seq: number; type: "step/start"; data: { turn: number; step: number } }
  | { seq: number; type: "step/end"; data: { turn: number; step: number } }
  | { seq: number; type: "user/message"; data: DshMessage }
  | { seq: number; type: "assistant/message"; data: { turn: number; step: number; message: DshMessage; interrupted?: true } }
  | { seq: number; type: "tool/call"; data: { turn: number; step: number; callId: DshCallId; name: string; arguments: string } }
  | { seq: number; type: "tool/result"; data: { turn: number; step: number; message: DshMessage; error?: { name: string; code: string } } };

/**
 * Any other SessionEventMap member (todo/write, request/*, assistant/chunk,
 * session/end-seed, plugin events): log-only. Kept OUT of the discriminated
 * union above so it can't widen the known members' `type` to `string` and
 * break narrowing. The codec tolerates these and never lets them drop the
 * snapshot.
 */
export interface DshUnknownEvent {
  seq: number;
  type: string;
  data?: unknown;
}

/** The full durable log the codec consumes: known events plus tolerated unknowns. */
export type DshLogEvent = DshDurableEvent | DshUnknownEvent;

/* ------------------------------------------------------------------ *
 * Runtime bridge (agent/pre-step). Minimal structural mirrors of the
 * DSH runtime surface the eviction pre-step handler touches, verified
 * against deepseek-harness @ 141eb6f:
 *   - Session.events / .surface.replaceGeneration  core/session/src/index.ts:559,431
 *   - agent.session on the pre-step payload         compaction-basic/src/index.ts:66
 *   - PreStepDecision                               api-catalog.ts:3633
 *   - ctx.on('agent/pre-step', …) + ctx.tokenMeter  api-catalog / compaction-basic
 * Kept here (not imported from DSH) per §2.2.
 * ------------------------------------------------------------------ */

/** SessionEvent.ignorable: absent ⇒ required; true ⇒ a reader may safely skip an unrecognized event. */
export type DshLogEventWithMeta = DshLogEvent & { ignorable?: true };

export interface DshSessionSurface {
  /** Current model-visible surface event seqs in canonical order. */
  readonly nodes: readonly number[];
  /** Monotonic count of committed surface `replace` ops. */
  replaceGeneration: number;
}

export interface DshSession {
  readonly id: string;
  /** Append-only durable event log (session.events). */
  readonly events: readonly DshLogEventWithMeta[];
  readonly surface: DshSessionSurface;
  append(type: string, data: unknown, options?: {
    surfaceOp?: "append" | { op: "replace"; start: number; end: number };
    sourceEventSeqs?: readonly number[];
  }): { seq: number };
}

export interface DshAgent {
  readonly session: DshSession;
}

export type DshPreStepDecision =
  | { kind: "reject" }
  | { kind: "enter"; messages: unknown[] };

export interface DshPreStepPayload {
  agent: DshAgent;
  messages: unknown[];
  turn: number;
  step: number;
  signal: { aborted: boolean };
}

export type DshPreStepNext = () => Promise<DshPreStepDecision>;

export interface DshTokenMeter {
  measure(session: DshSession): unknown;
}

/** The slice of the Cordis plugin context the eviction pre-step handler uses. */
export interface DshPluginContext {
  on(
    event: "agent/pre-step",
    handler: (payload: DshPreStepPayload, next: DshPreStepNext) => Promise<DshPreStepDecision>,
    options?: { prepend?: boolean },
  ): void;
  tokenMeter: DshTokenMeter;
}

/**
 * Minimal surface description for the stable revision (§4.1). The codec does
 * not own the surface node model (that is DSH's); it only needs the ordered
 * durable seqs and the replace generation to compute a reproducible revision.
 */
export interface DshSurfaceDescriptor {
  sessionId: string;
  /** Highest durable event seq observed. */
  lastEventSeq: number;
  /** How many surface `replace` ops have been committed (0 for a fresh surface). */
  surfaceReplaceGeneration: number;
  /** Ordered durable seqs of the nodes currently on the model-visible surface. */
  orderedSurfaceNodeSeqs: number[];
}
