import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { writeJsonFileAtomic } from "../state/file-store.js";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextMutationOperation,
  type ContextMutationPlan,
} from "./contracts.js";

export const CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION = 1 as const;

export type ContextMutationPlanStatus = "active" | "applied" | "failed";

export type StoredContextMutationPlan = {
  schemaVersion: typeof CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION;
  storedAt: string;
  plan: ContextMutationPlan;
};

export type ContextMutationPlanStoreWriteResult = {
  outcome: "stored" | "transitioned" | "unchanged" | "missing" | "bypassed";
  status?: ContextMutationPlanStatus;
  bypassed: boolean;
  reasons: string[];
};

export type ContextMutationPlanStoreReadResult = {
  plans: ContextMutationPlan[];
  bypassed: boolean;
  reasons: string[];
  quarantinedFileCount: number;
};

export type ContextMutationPlanStoreLockOptions = {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
};

type PlanStoreSessionLock = {
  release(): Promise<void>;
};

type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

type StoredPlanReadResult =
  | { kind: "ok"; entry: StoredContextMutationPlan }
  | { kind: "missing" }
  | { kind: "corrupt" }
  | { kind: "unsupported_schema" }
  | { kind: "read_error" };

type LocatedPlan = {
  status: ContextMutationPlanStatus;
  path: string;
  entry: StoredContextMutationPlan;
};

type LocatePlanResult =
  | { kind: "missing" }
  | { kind: "found"; located: LocatedPlan }
  | { kind: "bypassed"; reasons: string[]; quarantinedFileCount: number };

const PLAN_STATUSES: readonly ContextMutationPlanStatus[] = [
  "active",
  "applied",
  "failed",
];
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function canonicalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => !isNonBlankString(item))) {
    return undefined;
  }
  if (new Set(value).size !== value.length) return undefined;
  return [...value];
}

function canonicalOptionalStringArray(
  value: unknown,
): string[] | undefined | null {
  if (value === undefined) return undefined;
  return canonicalStringArray(value) ?? null;
}

function canonicalPersistableOperation(
  value: unknown,
): ContextMutationOperation | undefined {
  if (!isRecord(value)
    || !isNonBlankString(value.id)
    || (value.type !== "remove" && value.type !== "replace")
    || "replacementItems" in value
    || !isNonBlankString(value.rationale)
    || typeof value.estimatedSavedChars !== "number"
    || !Number.isFinite(value.estimatedSavedChars)
    || value.estimatedSavedChars < 0) {
    return undefined;
  }

  const targetItemIds = canonicalStringArray(value.targetItemIds);
  if (!targetItemIds || targetItemIds.length === 0) return undefined;
  const taskIds = canonicalOptionalStringArray(value.taskIds);
  const archiveRefs = canonicalOptionalStringArray(value.archiveRefs);
  if (taskIds === null || archiveRefs === null) return undefined;

  let targetItemFingerprints: Record<string, string> | undefined;
  if (value.targetItemFingerprints !== undefined) {
    const fingerprints = value.targetItemFingerprints;
    if (!isRecord(fingerprints)
      || Object.keys(fingerprints).length !== targetItemIds.length) {
      return undefined;
    }
    const entries = targetItemIds.map((targetItemId) => [
      targetItemId,
      fingerprints[targetItemId],
    ] as const);
    if (entries.some(([, fingerprint]) => !isNonBlankString(fingerprint))) {
      return undefined;
    }
    targetItemFingerprints = Object.fromEntries(entries) as Record<string, string>;
  }

  return {
    id: value.id,
    type: value.type,
    targetItemIds,
    ...(targetItemFingerprints ? { targetItemFingerprints } : {}),
    ...(taskIds ? { taskIds } : {}),
    rationale: value.rationale,
    estimatedSavedChars: value.estimatedSavedChars,
    ...(archiveRefs ? { archiveRefs } : {}),
  };
}

function canonicalPersistablePlan(value: unknown): ContextMutationPlan | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
    || !isNonBlankString(value.planId)
    || !isNonBlankString(value.hostId)
    || !isNonBlankString(value.sessionId)
    || !isNonBlankString(value.baseRevision)
    || !isNonBlankString(value.sourceModuleId)
    || (value.sourcePresetId !== undefined && !isNonBlankString(value.sourcePresetId))
    || !Array.isArray(value.operations)
    || value.operations.length === 0
    || !isIsoTimestamp(value.createdAt)) {
    return undefined;
  }

  const operations = value.operations.map(canonicalPersistableOperation);
  if (operations.some((operation) => operation === undefined)) return undefined;
  const operationIds = operations.map((operation) => operation!.id);
  if (new Set(operationIds).size !== operationIds.length) return undefined;

  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId: value.planId,
    hostId: value.hostId,
    sessionId: value.sessionId,
    baseRevision: value.baseRevision,
    sourceModuleId: value.sourceModuleId,
    ...(value.sourcePresetId !== undefined
      ? { sourcePresetId: value.sourcePresetId }
      : {}),
    operations: operations as ContextMutationOperation[],
    createdAt: value.createdAt,
  };
}

function plansEqual(left: ContextMutationPlan, right: ContextMutationPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorCode(error: unknown): string | undefined {
  return error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isIsoTimestamp(value: unknown): value is string {
  const parsed = timestampMs(value);
  return parsed !== undefined && new Date(parsed).toISOString() === value;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function asLockOwner(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) return undefined;
  return isNonBlankString(value.token)
    && typeof value.pid === "number"
    && Number.isInteger(value.pid)
    && value.pid > 0
    && isNonBlankString(value.hostname)
    && timestampMs(value.createdAt) !== undefined
    ? value as LockOwner
    : undefined;
}

function requireNonBlank(value: string, name: string): string | undefined {
  return value.trim() ? undefined : `${name}_empty`;
}

export function contextMutationPlanSessionRoot(
  stateDir: string,
  sessionId: string,
): string {
  return join(
    stateDir,
    "context-rewrite",
    "sessions",
    `session-${sha256(sessionId)}`,
  );
}

export function contextMutationPlanStatusDir(
  stateDir: string,
  sessionId: string,
  status: ContextMutationPlanStatus,
): string {
  return join(contextMutationPlanSessionRoot(stateDir, sessionId), "plans", status);
}

export function contextMutationPlanQuarantineDir(
  stateDir: string,
  sessionId: string,
  status: ContextMutationPlanStatus,
): string {
  return join(
    contextMutationPlanSessionRoot(stateDir, sessionId),
    "plans",
    "quarantine",
    status,
  );
}

export function contextMutationPlanFilePath(
  stateDir: string,
  sessionId: string,
  status: ContextMutationPlanStatus,
  planId: string,
): string {
  return join(
    contextMutationPlanStatusDir(stateDir, sessionId, status),
    `plan-${sha256(planId)}.json`,
  );
}

export function contextMutationPlanLockPath(
  stateDir: string,
  sessionId: string,
): string {
  return join(contextMutationPlanSessionRoot(stateDir, sessionId), "plan-store.lock");
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    return asLockOwner(
      JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as unknown,
    );
  } catch {
    return undefined;
  }
}

async function lockIsStale(params: {
  lockPath: string;
  staleAfterMs: number;
  nowMs: number;
}): Promise<boolean> {
  const owner = await readLockOwner(params.lockPath);
  if (owner) {
    if (owner.hostname === hostname()) return !isProcessAlive(owner.pid);
    return params.nowMs - (timestampMs(owner.createdAt) ?? params.nowMs)
      > params.staleAfterMs;
  }
  try {
    const lockStat = await stat(params.lockPath);
    return params.nowMs - lockStat.mtimeMs > params.staleAfterMs;
  } catch {
    return true;
  }
}

async function acquireSessionLock(params: {
  stateDir: string;
  sessionId: string;
  options?: ContextMutationPlanStoreLockOptions;
}): Promise<PlanStoreSessionLock | undefined> {
  const lockPath = contextMutationPlanLockPath(params.stateDir, params.sessionId);
  const recoveryPath = `${lockPath}.recovery`;
  const timeoutMs = Math.max(0, params.options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const retryMs = Math.max(1, params.options?.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
  const staleAfterMs = Math.max(1_000, params.options?.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
  const deadline = performance.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await stat(recoveryPath);
      if (performance.now() >= deadline) return undefined;
      await delay(retryMs);
      continue;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await lockIsStale({ lockPath, staleAfterMs, nowMs: Date.now() })) {
        try {
          await mkdir(recoveryPath);
        } catch (recoveryError) {
          if (errorCode(recoveryError) !== "EEXIST") throw recoveryError;
          if (performance.now() >= deadline) return undefined;
          await delay(retryMs);
          continue;
        }
        try {
          if (await lockIsStale({
            lockPath,
            staleAfterMs,
            nowMs: Date.now(),
          })) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } finally {
          await rm(recoveryPath, { recursive: true, force: true });
        }
        continue;
      }
      if (performance.now() >= deadline) return undefined;
      await delay(retryMs);
      continue;
    }

    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    try {
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify(owner),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    return {
      async release() {
        try {
          const current = await readLockOwner(lockPath);
          if (current?.token === owner.token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch {
          // Leaving an uncertain lock is safer than deleting a new owner's lock.
        }
      },
    };
  }
}

async function readStoredPlanFile(params: {
  path: string;
  sessionId: string;
}): Promise<StoredPlanReadResult> {
  let raw: string;
  try {
    raw = await readFile(params.path, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "read_error" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRecord(parsed)) return { kind: "corrupt" };
  if (
    typeof parsed.schemaVersion === "number"
    && parsed.schemaVersion !== CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION
  ) {
    return { kind: "unsupported_schema" };
  }
  const rawPlan = parsed.plan;
  if (
    isRecord(rawPlan)
    && typeof rawPlan.schemaVersion === "number"
    && rawPlan.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
  ) {
    return { kind: "unsupported_schema" };
  }
  const plan = canonicalPersistablePlan(rawPlan);
  if (
    parsed.schemaVersion !== CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION
    || !isIsoTimestamp(parsed.storedAt)
    || !plan
    || plan.sessionId !== params.sessionId
    || basename(params.path) !== `plan-${sha256(plan.planId)}.json`
  ) {
    return { kind: "corrupt" };
  }
  return {
    kind: "ok",
    entry: {
      schemaVersion: CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION,
      storedAt: parsed.storedAt,
      plan,
    },
  };
}

async function quarantinePlanFile(params: {
  path: string;
  stateDir: string;
  sessionId: string;
  status: ContextMutationPlanStatus;
}): Promise<boolean> {
  try {
    const quarantineDir = contextMutationPlanQuarantineDir(
      params.stateDir,
      params.sessionId,
      params.status,
    );
    await mkdir(quarantineDir, { recursive: true });
    await rename(
      params.path,
      join(
        quarantineDir,
        `${basename(params.path)}.${Date.now()}.${randomUUID()}.corrupt`,
      ),
    );
    return true;
  } catch {
    return false;
  }
}

async function locatePlanUnlocked(params: {
  stateDir: string;
  sessionId: string;
  planId: string;
}): Promise<LocatePlanResult> {
  const located: LocatedPlan[] = [];
  let quarantinedFileCount = 0;
  const reasons: string[] = [];
  for (const status of PLAN_STATUSES) {
    const path = contextMutationPlanFilePath(
      params.stateDir,
      params.sessionId,
      status,
      params.planId,
    );
    const read = await readStoredPlanFile({ path, sessionId: params.sessionId });
    if (read.kind === "missing") continue;
    if (read.kind === "ok") {
      located.push({ status, path, entry: read.entry });
      continue;
    }
    if (read.kind === "corrupt") {
      const quarantined = await quarantinePlanFile({
        path,
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        status,
      });
      if (quarantined) quarantinedFileCount += 1;
      reasons.push(quarantined ? "corrupt_plan_quarantined" : "corrupt_plan_quarantine_failed");
    } else {
      reasons.push(read.kind === "unsupported_schema" ? "unsupported_schema" : "plan_read_failed");
    }
  }
  if (reasons.length > 0) {
    return { kind: "bypassed", reasons, quarantinedFileCount };
  }
  if (located.length === 0) return { kind: "missing" };
  if (located.length > 1) {
    return {
      kind: "bypassed",
      reasons: ["plan_status_conflict"],
      quarantinedFileCount: 0,
    };
  }
  return { kind: "found", located: located[0]! };
}

function bypassedWrite(...reasons: string[]): ContextMutationPlanStoreWriteResult {
  return {
    outcome: "bypassed",
    bypassed: true,
    reasons,
  };
}

export async function saveActiveContextMutationPlan(params: {
  stateDir: string;
  plan: ContextMutationPlan;
  storedAt?: string;
  lock?: ContextMutationPlanStoreLockOptions;
}): Promise<ContextMutationPlanStoreWriteResult> {
  const stateDirError = requireNonBlank(params.stateDir, "state_dir");
  if (stateDirError) return bypassedWrite(stateDirError);
  const plan = canonicalPersistablePlan(params.plan);
  if (!plan) return bypassedWrite("invalid_plan");
  const storedAt = params.storedAt ?? new Date().toISOString();
  if (!isIsoTimestamp(storedAt)) return bypassedWrite("stored_at_invalid");

  let lock: PlanStoreSessionLock | undefined;
  try {
    lock = await acquireSessionLock({
      stateDir: params.stateDir,
      sessionId: plan.sessionId,
      options: params.lock,
    });
    if (!lock) return bypassedWrite("session_lock_unavailable");

    const existing = await locatePlanUnlocked({
      stateDir: params.stateDir,
      sessionId: plan.sessionId,
      planId: plan.planId,
    });
    if (existing.kind === "bypassed") return bypassedWrite(...existing.reasons);
    if (existing.kind === "found") {
      if (!plansEqual(existing.located.entry.plan, plan)) {
        return bypassedWrite("plan_id_conflict");
      }
      return {
        outcome: "unchanged",
        status: existing.located.status,
        bypassed: false,
        reasons: [],
      };
    }

    const path = contextMutationPlanFilePath(
      params.stateDir,
      plan.sessionId,
      "active",
      plan.planId,
    );
    await writeJsonFileAtomic(path, {
      schemaVersion: CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION,
      storedAt,
      plan,
    } satisfies StoredContextMutationPlan);
    return {
      outcome: "stored",
      status: "active",
      bypassed: false,
      reasons: [],
    };
  } catch {
    return bypassedWrite("plan_store_write_failed");
  } finally {
    await lock?.release();
  }
}

async function transitionContextMutationPlan(params: {
  stateDir: string;
  sessionId: string;
  planId: string;
  targetStatus: "applied" | "failed";
  lock?: ContextMutationPlanStoreLockOptions;
}): Promise<ContextMutationPlanStoreWriteResult> {
  const inputErrors = [
    requireNonBlank(params.stateDir, "state_dir"),
    requireNonBlank(params.sessionId, "session_id"),
    requireNonBlank(params.planId, "plan_id"),
  ].filter((reason): reason is string => reason !== undefined);
  if (inputErrors.length > 0) return bypassedWrite(...inputErrors);

  let lock: PlanStoreSessionLock | undefined;
  try {
    lock = await acquireSessionLock({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      options: params.lock,
    });
    if (!lock) return bypassedWrite("session_lock_unavailable");

    const existing = await locatePlanUnlocked(params);
    if (existing.kind === "bypassed") return bypassedWrite(...existing.reasons);
    if (existing.kind === "missing") {
      return {
        outcome: "missing",
        bypassed: true,
        reasons: ["plan_not_found"],
      };
    }
    if (existing.located.status === params.targetStatus) {
      return {
        outcome: "unchanged",
        status: params.targetStatus,
        bypassed: false,
        reasons: [],
      };
    }
    if (existing.located.status !== "active") {
      return bypassedWrite("plan_terminal_status_conflict");
    }

    const targetPath = contextMutationPlanFilePath(
      params.stateDir,
      params.sessionId,
      params.targetStatus,
      params.planId,
    );
    await mkdir(dirname(targetPath), { recursive: true });
    await rename(existing.located.path, targetPath);
    return {
      outcome: "transitioned",
      status: params.targetStatus,
      bypassed: false,
      reasons: [],
    };
  } catch {
    return bypassedWrite("plan_store_transition_failed");
  } finally {
    await lock?.release();
  }
}

export async function markContextMutationPlanApplied(params: {
  stateDir: string;
  sessionId: string;
  planId: string;
  lock?: ContextMutationPlanStoreLockOptions;
}): Promise<ContextMutationPlanStoreWriteResult> {
  return transitionContextMutationPlan({ ...params, targetStatus: "applied" });
}

export async function markContextMutationPlanFailed(params: {
  stateDir: string;
  sessionId: string;
  planId: string;
  lock?: ContextMutationPlanStoreLockOptions;
}): Promise<ContextMutationPlanStoreWriteResult> {
  return transitionContextMutationPlan({ ...params, targetStatus: "failed" });
}

async function loadStatusUnlocked(params: {
  stateDir: string;
  sessionId: string;
  status: ContextMutationPlanStatus;
}): Promise<ContextMutationPlanStoreReadResult> {
  const dir = contextMutationPlanStatusDir(
    params.stateDir,
    params.sessionId,
    params.status,
  );
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { plans: [], bypassed: false, reasons: [], quarantinedFileCount: 0 };
    }
    return {
      plans: [],
      bypassed: true,
      reasons: ["plan_directory_read_failed"],
      quarantinedFileCount: 0,
    };
  }

  const plans: ContextMutationPlan[] = [];
  const reasons: string[] = [];
  let quarantinedFileCount = 0;
  for (const name of names) {
    const path = join(dir, name);
    const read = await readStoredPlanFile({ path, sessionId: params.sessionId });
    if (read.kind === "ok") {
      plans.push(read.entry.plan);
      continue;
    }
    if (read.kind === "corrupt") {
      const quarantined = await quarantinePlanFile({
        path,
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        status: params.status,
      });
      if (quarantined) quarantinedFileCount += 1;
      reasons.push(quarantined ? "corrupt_plan_quarantined" : "corrupt_plan_quarantine_failed");
    } else if (read.kind === "unsupported_schema") {
      reasons.push("unsupported_schema");
    } else {
      reasons.push("plan_read_failed");
    }
  }

  if (reasons.length > 0) {
    return { plans: [], bypassed: true, reasons, quarantinedFileCount };
  }
  const uniquePlanIds = new Set(plans.map((plan) => plan.planId));
  if (uniquePlanIds.size !== plans.length) {
    return {
      plans: [],
      bypassed: true,
      reasons: ["duplicate_plan_id"],
      quarantinedFileCount,
    };
  }
  plans.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
      || left.planId.localeCompare(right.planId));
  return { plans, bypassed: false, reasons: [], quarantinedFileCount };
}

export async function loadContextMutationPlans(params: {
  stateDir: string;
  sessionId: string;
  status: ContextMutationPlanStatus;
  lock?: ContextMutationPlanStoreLockOptions;
}): Promise<ContextMutationPlanStoreReadResult> {
  const inputErrors = [
    requireNonBlank(params.stateDir, "state_dir"),
    requireNonBlank(params.sessionId, "session_id"),
  ].filter((reason): reason is string => reason !== undefined);
  if (inputErrors.length > 0) {
    return {
      plans: [],
      bypassed: true,
      reasons: inputErrors,
      quarantinedFileCount: 0,
    };
  }

  let lock: PlanStoreSessionLock | undefined;
  try {
    lock = await acquireSessionLock({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      options: params.lock,
    });
    if (!lock) {
      return {
        plans: [],
        bypassed: true,
        reasons: ["session_lock_unavailable"],
        quarantinedFileCount: 0,
      };
    }
    const loaded = await loadStatusUnlocked(params);
    if (loaded.bypassed) return loaded;

    for (const plan of loaded.plans) {
      for (const otherStatus of PLAN_STATUSES) {
        if (otherStatus === params.status) continue;
        const conflicting = await readStoredPlanFile({
          path: contextMutationPlanFilePath(
            params.stateDir,
            params.sessionId,
            otherStatus,
            plan.planId,
          ),
          sessionId: params.sessionId,
        });
        if (conflicting.kind === "ok") {
          return {
            plans: [],
            bypassed: true,
            reasons: ["plan_status_conflict"],
            quarantinedFileCount: loaded.quarantinedFileCount,
          };
        }
        if (conflicting.kind === "corrupt") {
          const quarantined = await quarantinePlanFile({
            path: contextMutationPlanFilePath(
              params.stateDir,
              params.sessionId,
              otherStatus,
              plan.planId,
            ),
            stateDir: params.stateDir,
            sessionId: params.sessionId,
            status: otherStatus,
          });
          return {
            plans: [],
            bypassed: true,
            reasons: [
              quarantined
                ? "corrupt_plan_quarantined"
                : "corrupt_plan_quarantine_failed",
            ],
            quarantinedFileCount:
              loaded.quarantinedFileCount + (quarantined ? 1 : 0),
          };
        }
        if (conflicting.kind !== "missing") {
          return {
            plans: [],
            bypassed: true,
            reasons: [
              conflicting.kind === "unsupported_schema"
                ? "unsupported_schema"
                : "conflicting_plan_read_failed",
            ],
            quarantinedFileCount: loaded.quarantinedFileCount,
          };
        }
      }
    }
    return loaded;
  } catch {
    return {
      plans: [],
      bypassed: true,
      reasons: ["plan_store_read_failed"],
      quarantinedFileCount: 0,
    };
  } finally {
    await lock?.release();
  }
}

export async function loadActiveContextMutationPlans(params: {
  stateDir: string;
  sessionId: string;
  lock?: ContextMutationPlanStoreLockOptions;
}): Promise<ContextMutationPlanStoreReadResult> {
  return loadContextMutationPlans({ ...params, status: "active" });
}
