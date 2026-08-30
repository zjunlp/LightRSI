/**
 * DeepSeek Harness adapter configuration.
 *
 * Lean and native: unlike the claude-code adapter there is no proxy, gateway,
 * or reduction config — DSH owns transport, persistence, and compaction. This
 * holds only what the TokenPilot plugin itself decides: the master feature
 * flag (default OFF, per R5), the task-state estimator settings, the eviction
 * failure mode, and the ordering against DSH's native compaction (§1.3).
 *
 * `normalizeDshConfig` takes an untrusted raw object (e.g. a parsed profile /
 * bundle config patch) and returns a fully-defaulted, clamped config. It is
 * config-first and side-effect free; secret/endpoint injection from env is a
 * later concern and deliberately not done here.
 */

export type DshEstimatorConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requestTimeoutMs: number;
  batchTurns: number;
  evictionLookaheadTurns: number;
  inputMode?: "sliding_window" | "completed_summary_plus_active_turns";
  lifecycleMode?: "coupled" | "decoupled";
  evidenceMode?: "two_state" | "three_state";
};

export type TokenPilotDshConfig = {
  /** Master switch for the whole TokenPilot DSH integration. Default OFF (R5). */
  enabled: boolean;
  logLevel: "info" | "debug";
  /** LightRSI-owned durable state root for task registry CAS. */
  stateDir?: string;
  taskStateEstimator: DshEstimatorConfig;
  eviction: {
    enabled: boolean;
    /** Minimum chars a candidate block must have to be worth evicting. */
    minBlockChars: number;
    /** Optimization failure must never block the agent — fail open. */
    failureMode: "bypass";
  };
  compaction: {
    /**
     * §1.3: TokenPilot eviction runs first in `agent/pre-step`, DSH compaction
     * after (then re-meter). Flip only for deliberate experiments.
     */
    runEvictionBeforeCompaction: boolean;
  };
};

export const DSH_CONFIG_DEFAULTS = {
  enabled: false,
  logLevel: "info" as const,
  stateDir: undefined,
  estimator: {
    enabled: false,
    requestTimeoutMs: 60_000,
    batchTurns: 5,
    evictionLookaheadTurns: 3,
  },
  eviction: {
    enabled: false,
    minBlockChars: 200,
    failureMode: "bypass" as const,
  },
  compaction: {
    runEvictionBeforeCompaction: true,
  },
} satisfies Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(next)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function normalizeEstimator(raw: unknown): DshEstimatorConfig {
  const r = asRecord(raw);
  const d = DSH_CONFIG_DEFAULTS.estimator;
  return {
    enabled: boolValue(r.enabled, d.enabled),
    baseUrl: stringValue(r.baseUrl),
    apiKey: stringValue(r.apiKey),
    model: stringValue(r.model),
    requestTimeoutMs: numberValue(r.requestTimeoutMs, d.requestTimeoutMs, 1_000, 600_000),
    batchTurns: numberValue(r.batchTurns, d.batchTurns, 1, 100),
    evictionLookaheadTurns: numberValue(r.evictionLookaheadTurns, d.evictionLookaheadTurns, 1, 50),
    inputMode: enumValue(r.inputMode, ["sliding_window", "completed_summary_plus_active_turns"] as const),
    lifecycleMode: enumValue(r.lifecycleMode, ["coupled", "decoupled"] as const),
    evidenceMode: enumValue(r.evidenceMode, ["two_state", "three_state"] as const),
  };
}

/** Normalize an untrusted raw config object into a fully-defaulted config. */
export function normalizeDshConfig(raw: unknown): TokenPilotDshConfig {
  const r = asRecord(raw);
  const eviction = asRecord(r.eviction);
  const compaction = asRecord(r.compaction);
  const d = DSH_CONFIG_DEFAULTS;

  return {
    enabled: boolValue(r.enabled, d.enabled),
    logLevel: enumValue(r.logLevel, ["info", "debug"] as const) ?? d.logLevel,
    stateDir: stringValue(r.stateDir),
    taskStateEstimator: normalizeEstimator(r.taskStateEstimator),
    eviction: {
      enabled: boolValue(eviction.enabled, d.eviction.enabled),
      minBlockChars: numberValue(eviction.minBlockChars, d.eviction.minBlockChars, 0, 100_000),
      failureMode: "bypass",
    },
    compaction: {
      runEvictionBeforeCompaction: boolValue(
        compaction.runEvictionBeforeCompaction,
        d.compaction.runEvictionBeforeCompaction,
      ),
    },
  };
}
