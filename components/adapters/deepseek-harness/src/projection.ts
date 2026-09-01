/**
 * TokenPilot whole-session projection for DeepSeek Harness.
 *
 * The projection is a pure fold over the durable session log. It publishes one
 * whole value under the `tokenpilot` key and never depends on a paginated UI
 * event window.
 *
 * Existing canonical replacement events are treated as authoritative applied
 * evidence. A future `tokenpilot/state` whole-value event is also supported
 * without changing the projection contract.
 */

import type { DshLogEventWithMeta } from "./types.js";

export type TokenPilotTransactionStatus =
  | "applied"
  | "partial"
  | "deferred";

export interface TokenPilotTransactionProjection {
  /** Stable identity of the latest observed transaction. */
  evictionId: string;

  /** Evidence-backed status of the latest transaction. */
  status: TokenPilotTransactionStatus;

  /**
   * Durable event seq that owns the latest rich state. Commands may return
   * this value as CommandResult.sourceEventSeq.
   */
  sourceEventSeq: number;

  /** Original surface event seqs whose replacements actually landed. */
  appliedSourceEventSeqs: number[];
}

export interface TokenPilotProjection {
  /** Whether the TokenPilot integration is enabled. */
  enabled: boolean;

  /** Timestamp of the latest estimator-related evidence, or null. */
  lastEstimatorRun: number | null;

  /** Number of candidates reported by the latest evidence, or null. */
  candidateCount: number | null;

  /** Estimated removable tokens. Never confused with applied tokens. */
  estimatedTokens: number | null;

  /** Tokens proven removed by applied before/after evidence. */
  appliedTokens: number | null;

  /** Reasons the latest operation was deferred. */
  deferredReasons: string[];

  /** Latest authoritative transaction, or null before any transaction. */
  lastTransaction: TokenPilotTransactionProjection | null;
}

export interface TokenPilotProjectionSchema<T> {
  parse(value: unknown): T;
}

export interface TokenPilotProjectionDefinition {
  key: "tokenpilot";
  schema: TokenPilotProjectionSchema<TokenPilotProjection>;
  init(): TokenPilotProjection;
  apply(
    state: TokenPilotProjection,
    event: DshLogEventWithMeta,
  ): TokenPilotProjection;
  view(
    state: TokenPilotProjection,
  ): TokenPilotProjection;
  stateVersion: number;
}

export interface TokenPilotProjectionContext {
  sessionProjections: {
    register(
      definition: TokenPilotProjectionDefinition,
    ): () => void;
  };
}

type ProjectionEvent = DshLogEventWithMeta & {
  readonly time?: number;
  readonly surfaceOp?:
    | "append"
    | {
        readonly op: "replace";
        readonly start: number;
        readonly end: number;
      };
  readonly sourceEventSeqs?: readonly number[];
};

interface ProjectionMessage {
  id?: unknown;
  content?: unknown;
  source?: unknown;
}

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function readNullableNumber(
  value: unknown,
  name: string,
): number | null {
  if (value === null) {
    return null;
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  ) {
    return value;
  }

  throw new TypeError(
    `tokenpilot projection ${name} must be a non-negative number or null`,
  );
}

function readNonNegativeInteger(
  value: unknown,
  name: string,
): number {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }

  throw new TypeError(
    `tokenpilot projection ${name} must be a non-negative integer`,
  );
}

function readStringArray(
  value: unknown,
  name: string,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError(
      `tokenpilot projection ${name} must be a string array`,
    );
  }

  return [...value];
}

function readTransaction(
  value: unknown,
): TokenPilotTransactionProjection | null {
  if (value === null) {
    return null;
  }

  if (!isObject(value)) {
    throw new TypeError(
      "tokenpilot projection lastTransaction must be an object or null",
    );
  }

  if (
    typeof value.evictionId !== "string" ||
    value.evictionId.length === 0
  ) {
    throw new TypeError(
      "tokenpilot transaction evictionId must be a non-empty string",
    );
  }

  if (
    value.status !== "applied" &&
    value.status !== "partial" &&
    value.status !== "deferred"
  ) {
    throw new TypeError(
      "tokenpilot transaction status is invalid",
    );
  }

  const sourceEventSeq = readNonNegativeInteger(
    value.sourceEventSeq,
    "lastTransaction.sourceEventSeq",
  );

  if (
    !Array.isArray(value.appliedSourceEventSeqs) ||
    !value.appliedSourceEventSeqs.every(
      (item) =>
        typeof item === "number" &&
        Number.isSafeInteger(item) &&
        item >= 0,
    )
  ) {
    throw new TypeError(
      "tokenpilot transaction appliedSourceEventSeqs must contain non-negative integers",
    );
  }

  return {
    evictionId: value.evictionId,
    status: value.status,
    sourceEventSeq,
    appliedSourceEventSeqs: uniqueSortedNumbers(
      value.appliedSourceEventSeqs,
    ),
  };
}

function parseProjection(
  value: unknown,
): TokenPilotProjection {
  if (!isObject(value)) {
    throw new TypeError(
      "tokenpilot projection must be an object",
    );
  }

  if (typeof value.enabled !== "boolean") {
    throw new TypeError(
      "tokenpilot projection enabled must be a boolean",
    );
  }

  const candidateCount =
    value.candidateCount === null
      ? null
      : readNonNegativeInteger(
          value.candidateCount,
          "candidateCount",
        );

  return {
    enabled: value.enabled,
    lastEstimatorRun: readNullableNumber(
      value.lastEstimatorRun,
      "lastEstimatorRun",
    ),
    candidateCount,
    estimatedTokens: readNullableNumber(
      value.estimatedTokens,
      "estimatedTokens",
    ),
    appliedTokens: readNullableNumber(
      value.appliedTokens,
      "appliedTokens",
    ),
    deferredReasons: readStringArray(
      value.deferredReasons,
      "deferredReasons",
    ),
    lastTransaction: readTransaction(
      value.lastTransaction,
    ),
  };
}

export const tokenPilotProjectionSchema:
  TokenPilotProjectionSchema<TokenPilotProjection> = {
    parse: parseProjection,
  };

function initialProjection(
  enabled: boolean,
): TokenPilotProjection {
  return {
    enabled,
    lastEstimatorRun: null,
    candidateCount: null,
    estimatedTokens: null,
    appliedTokens: null,
    deferredReasons: [],
    lastTransaction: null,
  };
}

function uniqueSortedNumbers(
  values: readonly number[],
): number[] {
  return [...new Set(values)].sort(
    (left, right) => left - right,
  );
}

function optionalNumber(
  value: unknown,
): number | undefined {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  ) {
    return value;
  }

  return undefined;
}

function optionalInteger(
  value: unknown,
): number | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }

  return undefined;
}

function optionalStringArray(
  value: unknown,
): string[] | undefined {
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  ) {
    return [...value];
  }

  return undefined;
}

function eventMessage(
  event: DshLogEventWithMeta,
): ProjectionMessage | undefined {
  const data = (event as { data?: unknown }).data;

  if (event.type === "user/message") {
    return isObject(data)
      ? data
      : undefined;
  }

  if (
    event.type === "assistant/message" ||
    event.type === "tool/result"
  ) {
    if (!isObject(data) || !isObject(data.message)) {
      return undefined;
    }

    return data.message;
  }

  return undefined;
}

function containsEvictionStub(
  value: unknown,
): boolean {
  if (typeof value === "string") {
    return /^\[evicted: .+ @\d+\]$/u.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(containsEvictionStub);
  }

  if (!isObject(value)) {
    return false;
  }

  return Object.values(value).some(
    containsEvictionStub,
  );
}

function collectStubSourceSeqs(
  value: unknown,
  output: number[] = [],
): number[] {
  if (typeof value === "string") {
    const match =
      /^\[evicted: .+ @(\d+)\]$/u.exec(value);

    if (match?.[1] !== undefined) {
      const seq = Number(match[1]);

      if (Number.isSafeInteger(seq) && seq >= 0) {
        output.push(seq);
      }
    }

    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStubSourceSeqs(item, output);
    }

    return output;
  }

  if (isObject(value)) {
    for (const item of Object.values(value)) {
      collectStubSourceSeqs(item, output);
    }
  }

  return output;
}

function evidenceFromMessage(
  message: ProjectionMessage,
): Record<string, unknown> | undefined {
  if (!isObject(message.source)) {
    return undefined;
  }

  return isObject(message.source.tokenpilot)
    ? message.source.tokenpilot
    : undefined;
}

function isTokenPilotReplacement(
  event: ProjectionEvent,
  message: ProjectionMessage,
): boolean {
  if (
    !isObject(event.surfaceOp) ||
    event.surfaceOp.op !== "replace"
  ) {
    return false;
  }

  if (
    isObject(message.source) &&
    message.source.plugin === "tokenpilot-dsh"
  ) {
    return true;
  }

  return containsEvictionStub(message.content);
}

function replacementSourceSeqs(
  event: ProjectionEvent,
  message: ProjectionMessage,
): number[] {
  const declared = Array.isArray(
    event.sourceEventSeqs,
  )
    ? event.sourceEventSeqs.filter(
        (item): item is number =>
          typeof item === "number" &&
          Number.isSafeInteger(item) &&
          item >= 0,
      )
    : [];

  if (declared.length > 0) {
    return uniqueSortedNumbers(declared);
  }

  return uniqueSortedNumbers(
    collectStubSourceSeqs(message.content),
  );
}

function evictionIdFromMessage(
  message: ProjectionMessage,
  evidence: Record<string, unknown> | undefined,
  replacementEventSeq: number,
): string {
  if (
    typeof evidence?.evictionId === "string" &&
    evidence.evictionId.length > 0
  ) {
    return evidence.evictionId;
  }

  if (typeof message.id === "string") {
    const match =
      /^lightrsi-(.+)-\d+$/u.exec(message.id);

    if (
      match?.[1] !== undefined &&
      match[1].length > 0
    ) {
      return match[1];
    }
  }

  return `replacement-${replacementEventSeq}`;
}

function applyReplacementEvidence(
  state: TokenPilotProjection,
  event: ProjectionEvent,
): TokenPilotProjection {
  const message = eventMessage(event);

  if (
    message === undefined ||
    !isTokenPilotReplacement(event, message)
  ) {
    return state;
  }

  const evidence = evidenceFromMessage(message);

  const evictionId = evictionIdFromMessage(
    message,
    evidence,
    event.seq,
  );

  const currentSourceSeqs =
    replacementSourceSeqs(event, message);

  const sameTransaction =
    state.lastTransaction?.evictionId ===
    evictionId;

  const priorSourceSeqs =
    sameTransaction &&
    state.lastTransaction !== null
      ? state.lastTransaction
          .appliedSourceEventSeqs
      : [];

  const appliedSourceEventSeqs =
    uniqueSortedNumbers([
      ...priorSourceSeqs,
      ...currentSourceSeqs,
    ]);

  const evidenceCandidateCount =
    optionalInteger(evidence?.candidateCount);

  const candidateCount =
    evidenceCandidateCount ??
    Math.max(
      sameTransaction
        ? state.candidateCount ?? 0
        : 0,
      appliedSourceEventSeqs.length,
    );

  const eventTime = optionalNumber(event.time);

  const lastEstimatorRun =
    optionalNumber(
      evidence?.lastEstimatorRun,
    ) ??
    eventTime ??
    (sameTransaction
      ? state.lastEstimatorRun
      : null);

  const estimatedTokens =
    optionalNumber(evidence?.estimatedTokens) ??
    (sameTransaction
      ? state.estimatedTokens
      : null);

  const appliedTokens =
    optionalNumber(evidence?.appliedTokens) ??
    (sameTransaction
      ? state.appliedTokens
      : null);

  const deferredReasons =
    optionalStringArray(
      evidence?.deferredReasons,
    ) ?? [];

  return {
    enabled: state.enabled,
    lastEstimatorRun,
    candidateCount,
    estimatedTokens,
    appliedTokens,
    deferredReasons,
    lastTransaction: {
      evictionId,
      status: "applied",
      sourceEventSeq: event.seq,
      appliedSourceEventSeqs,
    },
  };
}

function cloneProjection(
  state: TokenPilotProjection,
): TokenPilotProjection {
  return {
    ...state,
    deferredReasons: [
      ...state.deferredReasons,
    ],
    lastTransaction:
      state.lastTransaction === null
        ? null
        : {
            ...state.lastTransaction,
            appliedSourceEventSeqs: [
              ...state.lastTransaction
                .appliedSourceEventSeqs,
            ],
          },
  };
}

/**
 * Create the projection definition registered on
 * `ctx.sessionProjections`.
 */
export function createTokenPilotProjectionDefinition(
  enabled: boolean,
): TokenPilotProjectionDefinition {
  return {
    key: "tokenpilot",

    schema: tokenPilotProjectionSchema,

    init: () => initialProjection(enabled),

    apply: (state, event) => {
      /*
       * Future-compatible whole-value event. Invalid or unrelated unknown
       * events are ignored without losing the current projection.
       */
      if (event.type === "tokenpilot/state") {
        try {
          return parseProjection(
            (event as { data?: unknown }).data,
          );
        } catch {
          return state;
        }
      }

      return applyReplacementEvidence(
        state,
        event as ProjectionEvent,
      );
    },

    view: cloneProjection,

    stateVersion: 1,
  };
}

/**
 * Register the whole-value `tokenpilot` projection.
 *
 * The returned function unregisters the projection.
 */
export function registerTokenPilotProjection(
  ctx: TokenPilotProjectionContext,
  enabled: boolean,
): () => void {
  return ctx.sessionProjections.register(
    createTokenPilotProjectionDefinition(
      enabled,
    ),
  );
}
