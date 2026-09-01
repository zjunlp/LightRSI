/**
 * Human-facing TokenPilot status command for DeepSeek Harness.
 *
 * `/tokenpilot-status` reads the whole-session projection and renders it
 * directly to the UI. It does not submit a user message or start a model turn.
 */

import {
  tokenPilotProjectionSchema,
  type TokenPilotProjection,
} from "./projection.js";

import type { DshSession } from "./types.js";

/**
 * Minimal structural mirror of the DSH command result.
 *
 * A successful result may point to an earlier authoritative domain event
 * through sourceEventSeq.
 */
export type TokenPilotCommandResult =
  | {
      readonly kind: "success";
      readonly text?: string;
      readonly sourceEventSeq?: number;
    }
  | {
      readonly kind: "error";
      readonly text: string;
    };

/** Minimal structural mirror of one DSH command invocation. */
export interface TokenPilotCommandInvocation {
  readonly commandId: string;

  readonly agent: {
    readonly session: DshSession;
  };

  /** Exact text after `/tokenpilot-status`. */
  readonly rawInput: string;

  readonly signal: {
    readonly aborted: boolean;
  };
}

/** Command definition accepted by ctx.commands.register(). */
export interface TokenPilotCommandDefinition {
  readonly name: string;
  readonly description: string;

  readonly input?: {
    readonly hint: string;
  };

  readonly recordInput?: boolean;

  readonly handler: (
    invocation: TokenPilotCommandInvocation,
  ) =>
    | TokenPilotCommandResult
    | Promise<TokenPilotCommandResult>;
}

/** Whole-value projection snapshot returned by the registry. */
export interface TokenPilotProjectionSnapshot {
  /**
   * Last durable event reflected by every value.
   * An empty session uses -1.
   */
  readonly asOfSeq: number;

  readonly values: Record<string, unknown>;
}

/**
 * Runtime capabilities used by this module.
 *
 * Kept structural so the adapter does not import private DSH packages.
 */
export interface TokenPilotCommandContext {
  readonly commands: {
    register(
      definition: TokenPilotCommandDefinition,
    ): () => void;
  };

  readonly sessionProjections: {
    snapshot(
      session: DshSession,
    ): TokenPilotProjectionSnapshot;
  };
}

function formatOptionalNumber(
  value: number | null,
  unit: string,
): string {
  if (value === null) {
    return "unknown";
  }

  return `${value} ${unit}`;
}

function formatTimestamp(
  value: number | null,
): string {
  if (value === null) {
    return "never";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toISOString();
}

function formatDeferredReasons(
  reasons: readonly string[],
): string {
  if (reasons.length === 0) {
    return "none";
  }

  return reasons.join(", ");
}

/**
 * Describe work that reached the scheduling/transaction phase.
 *
 * This stays separate from both estimatedTokens and appliedTokens:
 *
 * - estimated: estimator prediction;
 * - scheduled: transaction/candidate state;
 * - applied: evidence-backed replacement result.
 */
function formatScheduledState(
  projection: TokenPilotProjection,
): string {
  const transaction = projection.lastTransaction;

  if (transaction === null) {
    return "none";
  }

  if (transaction.status === "deferred") {
    return "none (deferred)";
  }

  if (projection.candidateCount === null) {
    return `present (${transaction.status})`;
  }

  return (
    `${projection.candidateCount} candidate(s) ` +
    `(${transaction.status})`
  );
}

function formatLastTransaction(
  projection: TokenPilotProjection,
): string[] {
  const transaction = projection.lastTransaction;

  if (transaction === null) {
    return ["last transaction: none"];
  }

  const sourceSeqs =
    transaction.appliedSourceEventSeqs.length === 0
      ? "none"
      : transaction.appliedSourceEventSeqs.join(", ");

  return [
    `last transaction id: ${transaction.evictionId}`,
    `last transaction status: ${transaction.status}`,
    `authoritative event seq: ${transaction.sourceEventSeq}`,
    `applied source event seqs: ${sourceSeqs}`,
  ];
}

/**
 * Build plain status text for clients without a rich projection renderer.
 */
export function formatTokenPilotStatus(
  projection: TokenPilotProjection,
  asOfSeq: number,
): string {
  const lines = [
    "TokenPilot status",
    `enabled: ${projection.enabled ? "yes" : "no"}`,
    `projection as-of event: ${asOfSeq}`,
    `last estimator run: ${formatTimestamp(
      projection.lastEstimatorRun,
    )}`,
    `candidate count: ${formatOptionalNumber(
      projection.candidateCount,
      "candidate(s)",
    )}`,
    `estimated: ${formatOptionalNumber(
      projection.estimatedTokens,
      "token(s)",
    )}`,
    `scheduled: ${formatScheduledState(projection)}`,
    `applied: ${formatOptionalNumber(
      projection.appliedTokens,
      "token(s), evidence-backed",
    )}`,
    `deferred reasons: ${formatDeferredReasons(
      projection.deferredReasons,
    )}`,
    ...formatLastTransaction(projection),
  ];

  return lines.join("\n");
}

function readProjection(
  ctx: TokenPilotCommandContext,
  session: DshSession,
):
  | {
      readonly projection: TokenPilotProjection;
      readonly asOfSeq: number;
    }
  | undefined {
  const snapshot =
    ctx.sessionProjections.snapshot(session);

  const value = snapshot.values.tokenpilot;

  if (value === undefined) {
    return undefined;
  }

  try {
    return {
      projection:
        tokenPilotProjectionSchema.parse(value),
      asOfSeq: snapshot.asOfSeq,
    };
  } catch {
    return undefined;
  }
}

/**
 * Execute the status command.
 *
 * This function only reads sessionProjections. It never calls the agent,
 * appends a model message, or starts a model turn.
 */
export function executeTokenPilotStatusCommand(
  ctx: TokenPilotCommandContext,
  invocation: TokenPilotCommandInvocation,
): TokenPilotCommandResult {
  if (invocation.signal.aborted) {
    return {
      kind: "error",
      text: "TokenPilot status request was cancelled.",
    };
  }

  if (invocation.rawInput.trim().length !== 0) {
    return {
      kind: "error",
      text: "Usage: /tokenpilot-status",
    };
  }

  const result = readProjection(
    ctx,
    invocation.agent.session,
  );

  if (result === undefined) {
    return {
      kind: "error",
      text:
        "TokenPilot projection is unavailable for this session.",
    };
  }

  const text = formatTokenPilotStatus(
    result.projection,
    result.asOfSeq,
  );

  const sourceEventSeq =
    result.projection.lastTransaction
      ?.sourceEventSeq;

  if (sourceEventSeq === undefined) {
    return {
      kind: "success",
      text,
    };
  }

  return {
    kind: "success",
    text,
    sourceEventSeq,
  };
}

/** Create the `/tokenpilot-status` command definition. */
export function createTokenPilotStatusCommand(
  ctx: TokenPilotCommandContext,
): TokenPilotCommandDefinition {
  return {
    name: "tokenpilot-status",

    description:
      "Show TokenPilot estimator, scheduling, application, and deferral status.",

    recordInput: false,

    handler: (invocation) =>
      executeTokenPilotStatusCommand(
        ctx,
        invocation,
      ),
  };
}

/**
 * Register TokenPilot's human-facing command.
 *
 * The returned function unregisters the command.
 */
export function registerTokenPilotCommands(
  ctx: TokenPilotCommandContext,
): () => void {
  return ctx.commands.register(
    createTokenPilotStatusCommand(ctx),
  );
}
