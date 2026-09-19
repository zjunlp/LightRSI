/**
 * DSH Cleaner schedule pointer.
 *
 * The shared Cleaner stores plans and receipts by plan id. DeepSeek Harness
 * additionally needs a small, durable session -> scheduled-plan pointer so
 * the next real `agent/pre-step` can find work without scanning the store.
 *
 * A pointer is deliberately tiny: it contains execution identity only, never
 * session text, model output, credentials, or command UI state. It is
 * single-writer per session, idempotent for the same identity, and terminal
 * after an apply/cancel/stale/failure result so replay cannot mutate twice.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const DSH_CLEANER_SCHEDULE_SCHEMA = "lightrsi.deepseek-harness.cleaner-schedule/v1" as const;
const DSH_CLEANER_HOST_ID = "deepseek-harness" as const;
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_TIMEOUT_MS = 500;
const LOCK_RETRY_MS = 5;

type ScheduleIdentity = {
  schema: typeof DSH_CLEANER_SCHEDULE_SCHEMA;
  hostId: typeof DSH_CLEANER_HOST_ID;
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: string[];
  scheduledAt: string;
  updatedAt: string;
};

export type DshCleanerScheduledRecord = ScheduleIdentity & { status: "scheduled" };
/**
 * A durable execution reservation.  It is intentionally separate from the
 * shared receipt: it prevents two overlapping DSH requests from both passing
 * validation and rewriting the same canonical surface.
 */
export type DshCleanerClaimedRecord = ScheduleIdentity & {
  status: "claimed";
  claimId: string;
  claimedAt: string;
};
export type DshCleanerTerminalStatus = "applied" | "stale" | "cancelled" | "failed";
export type DshCleanerTerminalRecord = ScheduleIdentity & {
  status: "terminal";
  receiptStatus: DshCleanerTerminalStatus;
  reasons: string[];
};
export type DshCleanerScheduleRecord = DshCleanerScheduledRecord | DshCleanerClaimedRecord | DshCleanerTerminalRecord;

export type DshCleanerScheduleReadResult =
  | { outcome: "missing"; reasons: [] }
  | { outcome: "ready"; record: DshCleanerScheduledRecord; reasons: [] }
  | { outcome: "claimed"; record: DshCleanerClaimedRecord; reasons: [] }
  | { outcome: "terminal"; record: DshCleanerTerminalRecord; reasons: [] }
  | { outcome: "bypassed"; reasons: string[] };

export type DshCleanerScheduleWriteResult = {
  outcome: "stored" | "transitioned" | "unchanged" | "missing" | "conflict" | "bypassed";
  record?: DshCleanerScheduleRecord;
  reasons: string[];
};

export type DshCleanerScheduleClaimResult =
  | { outcome: "claimed"; record: DshCleanerClaimedRecord; reasons: [] }
  | { outcome: "already-claimed"; record: DshCleanerClaimedRecord; reasons: [] }
  | { outcome: "missing" | "terminal" | "conflict" | "bypassed"; record?: DshCleanerScheduleRecord; reasons: string[] };

type ScheduleLock = { release(): Promise<void> };
type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function uniqueNonBlankStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonBlank)
    && new Set(value).size === value.length;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonBlank);
}

function schedulePath(stateDir: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(stateDir, "cleaner-schedule", `${digest}.json`);
}

function lockPath(stateDir: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(stateDir, "cleaner-schedule", `${digest}.lock`);
}

function lockOwner(value: unknown): LockOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  return nonBlank(owner.token)
    && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
    && nonBlank(owner.hostname)
    && canonicalTimestamp(owner.createdAt)
    ? owner as unknown as LockOwner
    : undefined;
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    return lockOwner(JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function lockIsStale(path: string): Promise<boolean> {
  const owner = await readLockOwner(path);
  if (owner) {
    if (owner.hostname === hostname()) return !processIsAlive(owner.pid);
    return Date.now() - Date.parse(owner.createdAt) > LOCK_STALE_AFTER_MS;
  }
  try {
    return Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_AFTER_MS;
  } catch {
    return true;
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameIdentity(left: ScheduleIdentity, right: ScheduleIdentity): boolean {
  return left.schema === right.schema
    && left.hostId === right.hostId
    && left.sessionId === right.sessionId
    && left.cleanPlanId === right.cleanPlanId
    && left.baseRevision === right.baseRevision
    && left.scheduledAt === right.scheduledAt
    && sameStringSet(left.selectedTaskIds, right.selectedTaskIds);
}

function validate(parsed: unknown): DshCleanerScheduleRecord | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== DSH_CLEANER_SCHEDULE_SCHEMA
    || record.hostId !== DSH_CLEANER_HOST_ID
    || !nonBlank(record.sessionId)
    || !nonBlank(record.cleanPlanId)
    || !nonBlank(record.baseRevision)
    || !uniqueNonBlankStrings(record.selectedTaskIds)
    || !canonicalTimestamp(record.scheduledAt)
    || !canonicalTimestamp(record.updatedAt)) {
    return undefined;
  }
  if (record.status === "scheduled") return record as unknown as DshCleanerScheduledRecord;
  if (record.status === "claimed"
    && nonBlank(record.claimId)
    && canonicalTimestamp(record.claimedAt)) {
    return record as unknown as DshCleanerClaimedRecord;
  }
  if (record.status === "terminal"
    && ["applied", "stale", "cancelled", "failed"].includes(record.receiptStatus as string)
    && stringArray(record.reasons)) {
    return record as unknown as DshCleanerTerminalRecord;
  }
  return undefined;
}

async function writeRecord(path: string, record: DshCleanerScheduleRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8");
  await rename(tmp, path);
}

async function acquireSessionLock(params: {
  stateDir: string;
  sessionId: string;
}): Promise<ScheduleLock | undefined> {
  const path = lockPath(params.stateDir, params.sessionId);
  const recoveryPath = `${path}.recovery`;
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true });

  while (performance.now() < deadline) {
    try {
      await stat(recoveryPath);
      await delay(LOCK_RETRY_MS);
      continue;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return undefined;
    }

    try {
      await mkdir(path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return undefined;
      if (await lockIsStale(path)) {
        try {
          await mkdir(recoveryPath);
        } catch (recoveryError) {
          if (errorCode(recoveryError) !== "EEXIST") return undefined;
          await delay(LOCK_RETRY_MS);
          continue;
        }
        try {
          if (await lockIsStale(path)) await rm(path, { recursive: true, force: true });
        } finally {
          await rm(recoveryPath, { recursive: true, force: true });
        }
        continue;
      }
      await delay(LOCK_RETRY_MS);
      continue;
    }

    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    try {
      await writeFile(join(path, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
    } catch {
      await rm(path, { recursive: true, force: true });
      return undefined;
    }
    return {
      async release() {
        try {
          if ((await readLockOwner(path))?.token === owner.token) {
            await rm(path, { recursive: true, force: true });
          }
        } catch {
          // An uncertain lock must not delete a later owner's lock.
        }
      },
    };
  }
  return undefined;
}

/** Read the current schedule pointer for a session. Missing file -> `missing`. */
export async function readDshCleanerSchedule(params: {
  stateDir: string;
  sessionId: string;
}): Promise<DshCleanerScheduleReadResult> {
  let raw: string;
  try {
    raw = await readFile(schedulePath(params.stateDir, params.sessionId), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { outcome: "missing", reasons: [] };
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_read_error"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_malformed"] };
  }
  const record = validate(parsed);
  if (!record) return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_invalid"] };
  if (record.sessionId !== params.sessionId) {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_session_mismatch"] };
  }
  if (record.status === "scheduled") return { outcome: "ready", record, reasons: [] };
  if (record.status === "claimed") return { outcome: "claimed", record, reasons: [] };
  return { outcome: "terminal", record, reasons: [] };
}

/**
 * Persist one scheduled identity. Replaying exactly the same pending schedule
 * is safe. A terminal record is a replay guard for its completed plan, not a
 * permanent session lock, so a later *new* plan may replace it. A different
 * pending selection is still a conflict and is never overwritten.
 */
export async function scheduleDshCleanerPlan(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: string[];
  scheduledAt: string;
}): Promise<DshCleanerScheduleWriteResult> {
  if (!nonBlank(params.stateDir)
    || !nonBlank(params.sessionId)
    || !nonBlank(params.cleanPlanId)
    || !nonBlank(params.baseRevision)
    || !uniqueNonBlankStrings(params.selectedTaskIds)
    || !canonicalTimestamp(params.scheduledAt)) {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_request_invalid"] };
  }
  const record: DshCleanerScheduledRecord = {
    schema: DSH_CLEANER_SCHEDULE_SCHEMA,
    hostId: DSH_CLEANER_HOST_ID,
    sessionId: params.sessionId,
    cleanPlanId: params.cleanPlanId,
    baseRevision: params.baseRevision,
    selectedTaskIds: [...params.selectedTaskIds],
    scheduledAt: params.scheduledAt,
    updatedAt: params.scheduledAt,
    status: "scheduled",
  };
  const lock = await acquireSessionLock(params);
  if (!lock) return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_lock_busy"] };
  try {
    const current = await readDshCleanerSchedule(params);
    if (current.outcome === "bypassed") return { outcome: "bypassed", reasons: current.reasons };
    if (current.outcome === "missing") {
      await writeRecord(schedulePath(params.stateDir, params.sessionId), record);
      return { outcome: "stored", record, reasons: [] };
    }
    if (current.outcome === "ready") {
      if (sameIdentity(current.record, record)) {
        return { outcome: "unchanged", record: current.record, reasons: [] };
      }
      return {
        outcome: "conflict",
        record: current.record,
        reasons: ["dsh_cleaner_schedule_pending_conflict"],
      };
    }

    if (current.outcome === "claimed") {
      return {
        outcome: "conflict",
        record: current.record,
        reasons: ["dsh_cleaner_schedule_claimed_conflict"],
      };
    }

    // The terminal pointer prevents the same plan from replaying, but it must
    // not prevent a later, independently analyzed plan for this session. The
    // immutable shared receipt remains the audit history for the old plan.
    if (current.record.cleanPlanId !== record.cleanPlanId) {
      await writeRecord(schedulePath(params.stateDir, params.sessionId), record);
      return { outcome: "stored", record, reasons: [] };
    }
    return {
      outcome: "conflict",
      record: current.record,
      reasons: ["dsh_cleaner_schedule_terminal_conflict"],
    };
  } catch {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_write_error"] };
  } finally {
    await lock.release();
  }
}
/**
 * Compatibility wrapper for older adapter code. It now has safe schedule
 * semantics rather than silently overwriting a pointer.
 */
export async function writeDshCleanerSchedule(params: {
  stateDir: string;
  record: DshCleanerScheduledRecord;
}): Promise<DshCleanerScheduleWriteResult> {
  return scheduleDshCleanerPlan({
    stateDir: params.stateDir,
    sessionId: params.record.sessionId,
    cleanPlanId: params.record.cleanPlanId,
    baseRevision: params.record.baseRevision,
    selectedTaskIds: params.record.selectedTaskIds,
    scheduledAt: params.record.scheduledAt,
  });
}

/**
 * Atomically reserve one scheduled plan for an `agent/pre-step` execution.
 *
 * The reservation is durable before the caller touches the DSH surface.  If
 * the process dies after the rewrite but before a receipt is saved, a future
 * request sees `claimed` and fails closed instead of replaying the rewrite.
 * A user can analyze a fresh plan after the claim has been finalized.
 */
export async function claimDshCleanerSchedule(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  claimedAt?: string;
}): Promise<DshCleanerScheduleClaimResult> {
  const claimedAt = params.claimedAt ?? new Date().toISOString();
  if (!nonBlank(params.stateDir)
    || !nonBlank(params.sessionId)
    || !nonBlank(params.cleanPlanId)
    || !canonicalTimestamp(claimedAt)) {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_claim_invalid"] };
  }
  const lock = await acquireSessionLock(params);
  if (!lock) return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_lock_busy"] };
  try {
    const current = await readDshCleanerSchedule(params);
    if (current.outcome === "bypassed") return { outcome: "bypassed", reasons: current.reasons };
    if (current.outcome === "missing") return { outcome: "missing", reasons: ["dsh_cleaner_schedule_missing"] };
    if (current.record.cleanPlanId !== params.cleanPlanId) {
      return { outcome: "conflict", record: current.record, reasons: ["dsh_cleaner_schedule_identity_conflict"] };
    }
    if (current.outcome === "terminal") {
      return { outcome: "terminal", record: current.record, reasons: ["dsh_cleaner_schedule_terminal"] };
    }
    if (current.outcome === "claimed") {
      return { outcome: "already-claimed", record: current.record, reasons: [] };
    }
    const record: DshCleanerClaimedRecord = {
      ...current.record,
      status: "claimed",
      claimId: randomUUID(),
      claimedAt,
      updatedAt: claimedAt,
    };
    await writeRecord(schedulePath(params.stateDir, params.sessionId), record);
    return { outcome: "claimed", record, reasons: [] };
  } catch {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_claim_write_error"] };
  } finally {
    await lock.release();
  }
}

/**
 * Cancel only an unclaimed schedule. This is the local half of the
 * cancellation/claim race: if an execution already has a durable claim, the
 * command must not turn the shared receipt into `cancelled` underneath it.
 */
export async function cancelDshCleanerSchedule(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  reasons: string[];
  updatedAt?: string;
}): Promise<DshCleanerScheduleWriteResult> {
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  if (!nonBlank(params.stateDir)
    || !nonBlank(params.sessionId)
    || !nonBlank(params.cleanPlanId)
    || !stringArray(params.reasons)
    || !canonicalTimestamp(updatedAt)) {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_request_invalid"] };
  }
  const lock = await acquireSessionLock(params);
  if (!lock) return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_lock_busy"] };
  try {
    const current = await readDshCleanerSchedule(params);
    if (current.outcome === "bypassed") return { outcome: "bypassed", reasons: current.reasons };
    if (current.outcome === "missing") return { outcome: "missing", reasons: ["dsh_cleaner_schedule_missing"] };
    if (current.record.cleanPlanId !== params.cleanPlanId) {
      return { outcome: "conflict", record: current.record, reasons: ["dsh_cleaner_schedule_identity_conflict"] };
    }
    if (current.outcome === "claimed") {
      return { outcome: "conflict", record: current.record, reasons: ["dsh_cleaner_schedule_claimed_conflict"] };
    }
    if (current.outcome === "terminal") {
      return current.record.receiptStatus === "cancelled"
        ? { outcome: "unchanged", record: current.record, reasons: [] }
        : { outcome: "conflict", record: current.record, reasons: ["dsh_cleaner_schedule_terminal_conflict"] };
    }
    const record: DshCleanerTerminalRecord = {
      ...current.record,
      status: "terminal",
      receiptStatus: "cancelled",
      reasons: [...params.reasons],
      updatedAt,
    };
    await writeRecord(schedulePath(params.stateDir, params.sessionId), record);
    return { outcome: "transitioned", record, reasons: [] };
  } catch {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_write_error"] };
  } finally {
    await lock.release();
  }
}

/** Mark the current schedule terminal once a request has consumed it. */
export async function finalizeDshCleanerSchedule(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  receiptStatus: DshCleanerTerminalStatus;
  reasons: string[];
  claimId?: string;
  updatedAt?: string;
}): Promise<DshCleanerScheduleWriteResult> {
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  if (!nonBlank(params.stateDir)
    || !nonBlank(params.sessionId)
    || !nonBlank(params.cleanPlanId)
    || !["applied", "stale", "cancelled", "failed"].includes(params.receiptStatus)
    || !stringArray(params.reasons)
    || !canonicalTimestamp(updatedAt)) {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_request_invalid"] };
  }
  const lock = await acquireSessionLock(params);
  if (!lock) return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_lock_busy"] };
  try {
    const current = await readDshCleanerSchedule(params);
    if (current.outcome === "bypassed") return { outcome: "bypassed", reasons: current.reasons };
    if (current.outcome === "missing") {
      return { outcome: "missing", reasons: ["dsh_cleaner_schedule_missing"] };
    }
    if (current.record.cleanPlanId !== params.cleanPlanId) {
      return { outcome: "conflict", record: current.record, reasons: ["dsh_cleaner_schedule_identity_conflict"] };
    }
    if (current.outcome === "terminal") {
      if (current.record.receiptStatus === params.receiptStatus
        && sameStringSet(current.record.reasons, params.reasons)) {
        return { outcome: "unchanged", record: current.record, reasons: [] };
      }
      return { outcome: "conflict", record: current.record, reasons: ["dsh_cleaner_schedule_terminal_conflict"] };
    }
    if (params.claimId
      && (current.outcome !== "claimed" || current.record.claimId !== params.claimId)) {
      return { outcome: "conflict", record: current.record, reasons: ["dsh_cleaner_schedule_claim_conflict"] };
    }
    const record: DshCleanerTerminalRecord = {
      ...current.record,
      status: "terminal",
      receiptStatus: params.receiptStatus,
      reasons: [...params.reasons],
      updatedAt,
    };
    await writeRecord(schedulePath(params.stateDir, params.sessionId), record);
    return { outcome: "transitioned", record, reasons: [] };
  } catch {
    return { outcome: "bypassed", reasons: ["dsh_cleaner_schedule_write_error"] };
  } finally {
    await lock.release();
  }
}
