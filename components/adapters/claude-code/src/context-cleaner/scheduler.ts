import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { appendJsonl } from "@lightrsi/host-adapter";

export const CLAUDE_CLEANER_SCHEDULE_SCHEMA = "lightrsi.claude-code.cleaner-schedule/v1" as const;

type ClaudeCleanerScheduleIdentity = {
  schema: typeof CLAUDE_CLEANER_SCHEDULE_SCHEMA;
  hostId: "claude-code";
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: string[];
  scheduledAt: string;
  updatedAt: string;
};

export type ClaudeCleanerScheduledRecord = ClaudeCleanerScheduleIdentity & {
  status: "scheduled";
};

/** Adapter-local execution marker; shared Cleaner owns the plan and receipt. */
export type ClaudeCleanerCommittedRecord = ClaudeCleanerScheduleIdentity & {
  status: "committed";
  mutationPlanId: string;
  overlayId: string;
};

export type ClaudeCleanerTerminalRecord = ClaudeCleanerScheduleIdentity & {
  status: "terminal";
  receiptStatus: "stale" | "cancelled" | "failed";
  reasons: string[];
};

export type ClaudeCleanerScheduleRecord =
  | ClaudeCleanerScheduledRecord
  | ClaudeCleanerCommittedRecord
  | ClaudeCleanerTerminalRecord;

export type ClaudeCleanerScheduleReadResult =
  | { outcome: "missing"; reasons: [] }
  | { outcome: "ready"; record: ClaudeCleanerScheduledRecord; reasons: [] }
  | { outcome: "committed"; record: ClaudeCleanerCommittedRecord; reasons: [] }
  | { outcome: "terminal"; record: ClaudeCleanerTerminalRecord; reasons: [] }
  | { outcome: "bypassed"; reasons: string[] };

export type ClaudeCleanerScheduleWriteResult = {
  outcome: "stored" | "transitioned" | "unchanged" | "missing" | "conflict" | "bypassed";
  record?: ClaudeCleanerScheduleRecord;
  reasons: string[];
};

type ClaudeCleanerScheduleJournal = {
  records: ClaudeCleanerScheduleRecord[];
  malformedLineCount: number;
  readError?: string;
};

const LOCK_TIMEOUT_MS = 1_000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30 * 60 * 1_000;

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function uniqueNonBlankStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonBlankString)
    && new Set(value).size === value.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIdentity(
  left: ClaudeCleanerScheduleIdentity,
  right: ClaudeCleanerScheduleIdentity,
): boolean {
  return left.hostId === right.hostId
    && left.sessionId === right.sessionId
    && left.cleanPlanId === right.cleanPlanId
    && left.baseRevision === right.baseRevision
    && left.scheduledAt === right.scheduledAt
    && sameStringSet(left.selectedTaskIds, right.selectedTaskIds);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalRecord(value: unknown): ClaudeCleanerScheduleRecord | undefined {
  const record = asRecord(value);
  if (!record
    || record.schema !== CLAUDE_CLEANER_SCHEDULE_SCHEMA
    || record.hostId !== "claude-code"
    || !nonBlankString(record.sessionId)
    || !nonBlankString(record.cleanPlanId)
    || !nonBlankString(record.baseRevision)
    || !uniqueNonBlankStrings(record.selectedTaskIds)
    || !canonicalTimestamp(record.scheduledAt)
    || !canonicalTimestamp(record.updatedAt)) return undefined;

  const identity: ClaudeCleanerScheduleIdentity = {
    schema: CLAUDE_CLEANER_SCHEDULE_SCHEMA,
    hostId: "claude-code",
    sessionId: record.sessionId,
    cleanPlanId: record.cleanPlanId,
    baseRevision: record.baseRevision,
    selectedTaskIds: [...record.selectedTaskIds],
    scheduledAt: record.scheduledAt,
    updatedAt: record.updatedAt,
  };
  if (record.status === "scheduled") return { ...identity, status: "scheduled" };
  if (record.status === "committed"
    && nonBlankString(record.mutationPlanId)
    && nonBlankString(record.overlayId)) {
    return { ...identity, status: "committed", mutationPlanId: record.mutationPlanId, overlayId: record.overlayId };
  }
  if (record.status === "terminal"
    && (record.receiptStatus === "stale" || record.receiptStatus === "cancelled" || record.receiptStatus === "failed")
    && uniqueNonBlankStrings(record.reasons)) {
    return { ...identity, status: "terminal", receiptStatus: record.receiptStatus, reasons: [...record.reasons] };
  }
  return undefined;
}

function validTransition(
  previous: ClaudeCleanerScheduleRecord | undefined,
  next: ClaudeCleanerScheduleRecord,
): boolean {
  if (!previous) return next.status === "scheduled";
  if (!sameIdentity(previous, next)) return false;
  if (previous.status === "scheduled") return true;
  return JSON.stringify(previous) === JSON.stringify(next);
}

function scheduleSessionDir(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDir, "claude-context", "cleaner-schedules", `session-${key}`);
}

export function claudeCleanerScheduleJournalPath(stateDir: string, sessionId: string): string {
  return join(scheduleSessionDir(stateDir, sessionId), "schedule.jsonl");
}

function scheduleLockPath(stateDir: string, sessionId: string): string {
  return join(scheduleSessionDir(stateDir, sessionId), "schedule.lock");
}

export async function acquireClaudeCleanerScheduleLock(params: {
  stateDir: string;
  sessionId: string;
}): Promise<{ release(): Promise<void> } | undefined> {
  const path = scheduleLockPath(params.stateDir, params.sessionId);
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const startedAt = performance.now();
  await mkdir(scheduleSessionDir(params.stateDir, params.sessionId), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(path, "wx");
      await handle.writeFile(token, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(path);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      if (performance.now() - startedAt >= LOCK_TIMEOUT_MS) return undefined;
      await delay(LOCK_RETRY_MS);
    }
  }
  return {
    async release() {
      await handle?.close().catch(() => undefined);
      try {
        if (await readFile(path, "utf8") === token) await unlink(path);
      } catch {
        // A missing/replaced lock belongs to recovery or another owner.
      }
    },
  };
}

async function readScheduleJournal(
  stateDir: string,
  sessionId: string,
): Promise<ClaudeCleanerScheduleJournal> {
  let raw: string;
  try {
    raw = await readFile(claudeCleanerScheduleJournalPath(stateDir, sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], malformedLineCount: 0 };
    }
    return { records: [], malformedLineCount: 0, readError: String(error) };
  }

  const latestByPlanId = new Map<string, ClaudeCleanerScheduleRecord>();
  let malformedLineCount = 0;
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    try {
      const entry = canonicalRecord(JSON.parse(line) as unknown);
      const previous = entry ? latestByPlanId.get(entry.cleanPlanId) : undefined;
      if (!entry || entry.sessionId !== sessionId || !validTransition(previous, entry)) {
        malformedLineCount += 1;
        continue;
      }
      latestByPlanId.set(entry.cleanPlanId, entry);
    } catch {
      malformedLineCount += 1;
    }
  }
  return { records: [...latestByPlanId.values()], malformedLineCount };
}

function journalFailureReasons(journal: ClaudeCleanerScheduleJournal): string[] | undefined {
  if (journal.readError) return ["claude_cleaner_schedule_journal_unavailable"];
  if (journal.malformedLineCount > 0) return ["claude_cleaner_schedule_journal_malformed"];
  return undefined;
}

export async function readClaudeCleanerSchedule(params: {
  stateDir: string;
  sessionId: string;
}): Promise<ClaudeCleanerScheduleReadResult> {
  if (!nonBlankString(params.stateDir) || !nonBlankString(params.sessionId)) {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_request_invalid"] };
  }
  const journal = await readScheduleJournal(params.stateDir, params.sessionId);
  const reasons = journalFailureReasons(journal);
  if (reasons) return { outcome: "bypassed", reasons };
  const scheduled = journal.records.filter(
    (record): record is ClaudeCleanerScheduledRecord => record.status === "scheduled",
  );
  if (scheduled.length > 1) {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_pending_conflict"] };
  }
  if (scheduled[0]) return { outcome: "ready", record: scheduled[0], reasons: [] };
  const latest = journal.records.at(-1);
  if (!latest) return { outcome: "missing", reasons: [] };
  if (latest.status === "committed") return { outcome: "committed", record: latest, reasons: [] };
  if (latest.status === "terminal") return { outcome: "terminal", record: latest, reasons: [] };
  return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_pending_conflict"] };
}

function validScheduleParams(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: string[];
  scheduledAt: string;
}): boolean {
  return nonBlankString(params.stateDir)
    && nonBlankString(params.sessionId)
    && nonBlankString(params.cleanPlanId)
    && nonBlankString(params.baseRevision)
    && uniqueNonBlankStrings(params.selectedTaskIds)
    && canonicalTimestamp(params.scheduledAt);
}

export async function scheduleClaudeCleanerPlan(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  baseRevision: string;
  selectedTaskIds: string[];
  scheduledAt?: string;
}): Promise<ClaudeCleanerScheduleWriteResult> {
  const scheduledAt = params.scheduledAt ?? new Date().toISOString();
  if (!validScheduleParams({ ...params, scheduledAt })) {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_request_invalid"] };
  }
  const record: ClaudeCleanerScheduledRecord = {
    schema: CLAUDE_CLEANER_SCHEDULE_SCHEMA,
    hostId: "claude-code",
    sessionId: params.sessionId,
    cleanPlanId: params.cleanPlanId,
    baseRevision: params.baseRevision,
    selectedTaskIds: [...params.selectedTaskIds],
    status: "scheduled",
    scheduledAt,
    updatedAt: scheduledAt,
  };
  const lock = await acquireClaudeCleanerScheduleLock(params);
  if (!lock) return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_lock_busy"] };
  try {
    const journal = await readScheduleJournal(params.stateDir, params.sessionId);
    const reasons = journalFailureReasons(journal);
    if (reasons) return { outcome: "bypassed", reasons };
    const existing = journal.records.find((entry) => entry.cleanPlanId === params.cleanPlanId);
    if (existing) {
      return existing.status === "scheduled" && sameIdentity(existing, record)
        ? { outcome: "unchanged", record: existing, reasons: [] }
        : { outcome: "conflict", record: existing, reasons: ["claude_cleaner_schedule_identity_conflict"] };
    }
    if (journal.records.some((entry) => entry.status === "scheduled")) {
      return { outcome: "conflict", reasons: ["claude_cleaner_schedule_pending_conflict"] };
    }
    await appendJsonl(claudeCleanerScheduleJournalPath(params.stateDir, params.sessionId), record);
    return { outcome: "stored", record, reasons: [] };
  } catch {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_write_failed"] };
  } finally {
    await lock.release();
  }
}

async function transitionSchedule(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  updatedAt: string;
  build(previous: ClaudeCleanerScheduledRecord): ClaudeCleanerScheduleRecord;
  matchesExisting(existing: ClaudeCleanerScheduleRecord): boolean;
}): Promise<ClaudeCleanerScheduleWriteResult> {
  if (!nonBlankString(params.stateDir)
    || !nonBlankString(params.sessionId)
    || !nonBlankString(params.cleanPlanId)
    || !canonicalTimestamp(params.updatedAt)) {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_request_invalid"] };
  }
  const lock = await acquireClaudeCleanerScheduleLock(params);
  if (!lock) return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_lock_busy"] };
  try {
    const journal = await readScheduleJournal(params.stateDir, params.sessionId);
    const reasons = journalFailureReasons(journal);
    if (reasons) return { outcome: "bypassed", reasons };
    const existing = journal.records.find((record) => record.cleanPlanId === params.cleanPlanId);
    if (!existing) return { outcome: "missing", reasons: ["claude_cleaner_schedule_missing"] };
    if (existing.status !== "scheduled") {
      return params.matchesExisting(existing)
        ? { outcome: "unchanged", record: existing, reasons: [] }
        : { outcome: "conflict", record: existing, reasons: ["claude_cleaner_schedule_terminal_conflict"] };
    }
    const next = canonicalRecord(params.build(existing));
    if (!next || !validTransition(existing, next)) {
      return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_transition_invalid"] };
    }
    await appendJsonl(claudeCleanerScheduleJournalPath(params.stateDir, params.sessionId), next);
    return { outcome: "transitioned", record: next, reasons: [] };
  } catch {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_write_failed"] };
  } finally {
    await lock.release();
  }
}

export async function appendClaudeCleanerCommitted(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  mutationPlanId: string;
  overlayId: string;
  updatedAt?: string;
}): Promise<ClaudeCleanerScheduleWriteResult> {
  if (!nonBlankString(params.mutationPlanId) || !nonBlankString(params.overlayId)) {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_request_invalid"] };
  }
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  return transitionSchedule({
    ...params,
    updatedAt,
    build(previous) {
      return { ...previous, status: "committed", mutationPlanId: params.mutationPlanId, overlayId: params.overlayId, updatedAt };
    },
    matchesExisting(existing) {
      return existing.status === "committed"
        && existing.mutationPlanId === params.mutationPlanId
        && existing.overlayId === params.overlayId;
    },
  });
}

export async function appendClaudeCleanerTerminal(params: {
  stateDir: string;
  sessionId: string;
  cleanPlanId: string;
  receiptStatus: "stale" | "cancelled" | "failed";
  reasons: string[];
  updatedAt?: string;
}): Promise<ClaudeCleanerScheduleWriteResult> {
  if (!uniqueNonBlankStrings(params.reasons)) {
    return { outcome: "bypassed", reasons: ["claude_cleaner_schedule_request_invalid"] };
  }
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  return transitionSchedule({
    ...params,
    updatedAt,
    build(previous) {
      return { ...previous, status: "terminal", receiptStatus: params.receiptStatus, reasons: [...params.reasons], updatedAt };
    },
    matchesExisting(existing) {
      return existing.status === "terminal"
        && existing.receiptStatus === params.receiptStatus
        && sameStrings(existing.reasons, params.reasons);
    },
  });
}
