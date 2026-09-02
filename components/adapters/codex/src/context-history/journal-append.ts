import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";

import {
  codexContextHistoryJournalPath,
  parseCodexContextHistoryJournalLine,
  parseCodexContextHistoryJournalText,
  readCodexContextHistoryJournal,
} from "./journal-store.js";
import type { CodexContextHistoryJournalReadResult } from "./journal-store.js";

type CodexContextHistoryJournalLockOwner = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

export type CodexContextHistoryJournalLock = {
  lockPath: string;
  release(): Promise<void>;
};

export type CodexContextHistoryJournalTailRecoveryResult = {
  status: "not_needed" | "truncated" | "newline_appended" | "blocked";
  reason?:
    | "malformed_trailing_record"
    | "complete_record_missing_newline"
    | "invalid_trailing_record"
    | "invalid_prefix"
    | "read_error";
  recoveredByteCount: number;
  tailSha256?: string;
};

const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const LOCK_REMOVE_MAX_RETRIES = 5;
const LOCK_REMOVE_RETRY_MS = 20;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isTransientWindowsLockError(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = errorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function removeLockPath(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: LOCK_REMOVE_MAX_RETRIES,
    retryDelay: LOCK_REMOVE_RETRY_MS,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function asLockOwner(value: unknown): CodexContextHistoryJournalLockOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  return typeof owner.token === "string" && owner.token.length > 0
    && typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.hostname === "string" && owner.hostname.length > 0
    && timestampMs(owner.createdAt) !== undefined
    ? owner as CodexContextHistoryJournalLockOwner
    : undefined;
}

async function readLockOwner(lockPath: string): Promise<CodexContextHistoryJournalLockOwner | undefined> {
  for (let attempt = 0; attempt <= LOCK_REMOVE_MAX_RETRIES; attempt += 1) {
    try {
      return asLockOwner(JSON.parse(await readFile(lockPath, "utf8")) as unknown);
    } catch (error) {
      if (isTransientWindowsLockError(error) && attempt < LOCK_REMOVE_MAX_RETRIES) {
        await wait(LOCK_REMOVE_RETRY_MS);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

async function lockIsStale(params: {
  lockPath: string;
  staleAfterMs: number;
  nowMs: number;
}): Promise<boolean> {
  const owner = await readLockOwner(params.lockPath);
  if (owner) {
    if (owner.hostname === hostname()) return !isProcessAlive(owner.pid);
    return params.nowMs - (timestampMs(owner.createdAt) ?? params.nowMs) > params.staleAfterMs;
  }
  try {
    const lockStat = await stat(params.lockPath);
    return params.nowMs - lockStat.mtimeMs > params.staleAfterMs;
  } catch (error) {
    // The owner may have released the lock between our failed exclusive open
    // and this stat. Treat a missing path as contention and retry creation;
    // claiming it as stale could rename a replacement lock created meanwhile.
    if (errorCode(error) === "ENOENT") return false;
    if (isTransientWindowsLockError(error)) return false;
    throw error;
  }
}

export function codexContextHistoryJournalLockPath(stateDir: string, sessionId: string): string {
  return `${codexContextHistoryJournalPath(stateDir, sessionId)}.lock`;
}

async function tryAcquireJournalLock(params: {
  stateDir: string;
  sessionId: string;
  staleAfterMs: number;
}): Promise<CodexContextHistoryJournalLock | undefined> {
  const lockPath = codexContextHistoryJournalLockPath(params.stateDir, params.sessionId);
  const recoveryPath = `${lockPath}.recovery`;
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await pathExists(recoveryPath)) return undefined;
    let lockHandle: Awaited<ReturnType<typeof open>>;
    try {
      lockHandle = await open(lockPath, "wx");
    } catch (error) {
      if (isTransientWindowsLockError(error)) return undefined;
      if (errorCode(error) !== "EEXIST") throw error;
      if (await pathExists(recoveryPath)) return undefined;
      if (!await lockIsStale({
        lockPath,
        staleAfterMs: params.staleAfterMs,
        nowMs: Date.now(),
      })) return undefined;

      let recoveryHandle: Awaited<ReturnType<typeof open>>;
      try {
        recoveryHandle = await open(recoveryPath, "wx");
      } catch (recoveryError) {
        if (isTransientWindowsLockError(recoveryError)
          || errorCode(recoveryError) === "EEXIST") return undefined;
        throw recoveryError;
      }
      try {
        await recoveryHandle.writeFile(randomUUID(), "utf8");
        await recoveryHandle.sync();
      } finally {
        await recoveryHandle.close();
      }

      const claimedStaleLockPath = `${lockPath}.stale-${randomUUID()}`;
      try {
        if (await lockIsStale({
          lockPath,
          staleAfterMs: params.staleAfterMs,
          nowMs: Date.now(),
        })) {
          try {
            await rename(lockPath, claimedStaleLockPath);
            await removeLockPath(claimedStaleLockPath);
          } catch (claimError) {
            if (!isTransientWindowsLockError(claimError)) {
              const claimErrorCode = errorCode(claimError);
              if (claimErrorCode !== "ENOENT" && claimErrorCode !== "EEXIST") {
                throw claimError;
              }
            }
          }
        }
      } finally {
        await removeLockPath(recoveryPath);
      }
      continue;
    }

    const owner: CodexContextHistoryJournalLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    try {
      await lockHandle.writeFile(JSON.stringify(owner), "utf8");
      await lockHandle.sync();
    } catch (error) {
      const failedLockPath = `${lockPath}.failed-${owner.token}`;
      try {
        await rename(lockPath, failedLockPath);
        await removeLockPath(failedLockPath);
      } catch {
        // A missing or replaced path is no longer this failed acquisition's lock.
      }
      throw error;
    } finally {
      await lockHandle.close();
    }

    return {
      lockPath,
      async release() {
        try {
          const current = await readLockOwner(lockPath);
          if (current?.token === owner.token) {
            const releasedLockPath = `${lockPath}.released-${owner.token}`;
            await rename(lockPath, releasedLockPath);
            await removeLockPath(releasedLockPath);
          }
        } catch {
          // Leaving a stale lock is safer than deleting a lock whose owner may have changed.
        }
      },
    };
  }
  return undefined;
}

export async function acquireCodexContextHistoryJournalLock(params: {
  stateDir: string;
  sessionId: string;
  staleAfterMs?: number;
  timeoutMs?: number;
  retryMs?: number;
}): Promise<CodexContextHistoryJournalLock> {
  const staleAfterMs = Math.max(1_000, params.staleAfterMs ?? DEFAULT_LOCK_STALE_MS);
  const timeoutMs = Math.max(0, params.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const retryMs = Math.max(1, params.retryMs ?? DEFAULT_LOCK_RETRY_MS);
  const deadline = performance.now() + timeoutMs;

  do {
    const lock = await tryAcquireJournalLock({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      staleAfterMs,
    });
    if (lock) return lock;
    if (performance.now() >= deadline) break;
    await wait(Math.min(retryMs, Math.max(1, deadline - performance.now())));
  } while (true);

  throw new Error(`Timed out acquiring Codex context-history journal lock for session ${params.sessionId}`);
}

export async function withCodexContextHistoryJournalLock<T>(params: {
  stateDir: string;
  sessionId: string;
}, action: () => Promise<T>): Promise<T> {
  const lock = await acquireCodexContextHistoryJournalLock(params);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(value: Uint8Array): string | undefined {
  try {
    return FATAL_UTF8_DECODER.decode(value);
  } catch {
    return undefined;
  }
}

async function syncTruncate(path: string, size: number): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncAppendNewline(path: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.appendFile("\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function journalTailState(
  path: string,
): Promise<"missing" | "terminated" | "unterminated" | "read_error"> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "read_error";
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return "read_error";
    if (fileStat.size === 0) return "terminated";
    const lastByte = Buffer.allocUnsafe(1);
    const read = await handle.read(lastByte, 0, 1, fileStat.size - 1);
    if (read.bytesRead !== 1) return "read_error";
    return lastByte[0] === 0x0a ? "terminated" : "unterminated";
  } catch {
    return "read_error";
  } finally {
    await handle.close();
  }
}

export async function recoverCodexContextHistoryJournalTailLocked(
  stateDir: string,
  sessionId: string,
): Promise<CodexContextHistoryJournalTailRecoveryResult> {
  // Writers always terminate canonical JSONL records with LF. Under the same
  // session lock, an unterminated suffix is recoverable only when every prior
  // line is canonical and the suffix is either an incomplete JSON/UTF-8 value
  // or one complete canonical record that only lost its final LF.
  const path = codexContextHistoryJournalPath(stateDir, sessionId);
  const tailState = await journalTailState(path);
  if (tailState === "missing" || tailState === "terminated") {
    return { status: "not_needed", recoveredByteCount: 0 };
  }
  if (tailState === "read_error") {
    return { status: "blocked", reason: "read_error", recoveredByteCount: 0 };
  }
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "not_needed", recoveredByteCount: 0 };
    return { status: "blocked", reason: "read_error", recoveredByteCount: 0 };
  }
  if (raw.length === 0 || raw.at(-1) === 0x0a) {
    return { status: "not_needed", recoveredByteCount: 0 };
  }

  const lastNewline = raw.lastIndexOf(0x0a);
  const prefixLength = lastNewline + 1;
  const prefix = raw.subarray(0, prefixLength);
  const tail = raw.subarray(prefixLength);
  const tailSha256 = sha256Bytes(tail);
  const prefixText = decodeUtf8(prefix);
  if (prefixText === undefined
    || parseCodexContextHistoryJournalText(prefixText, sessionId).malformedLineCount > 0) {
    return {
      status: "blocked",
      reason: "invalid_prefix",
      recoveredByteCount: 0,
      tailSha256,
    };
  }

  const tailText = decodeUtf8(tail);
  if (tailText !== undefined) {
    const parsedTail = parseCodexContextHistoryJournalLine(tailText, sessionId);
    if (parsedTail.status === "valid") {
      await syncAppendNewline(path);
      return {
        status: "newline_appended",
        reason: "complete_record_missing_newline",
        recoveredByteCount: 0,
        tailSha256,
      };
    }
    if (parsedTail.status === "invalid_record") {
      return {
        status: "blocked",
        reason: "invalid_trailing_record",
        recoveredByteCount: 0,
        tailSha256,
      };
    }
  }

  await syncTruncate(path, prefixLength);
  return {
    status: "truncated",
    reason: "malformed_trailing_record",
    recoveredByteCount: tail.length,
    tailSha256,
  };
}

export async function recoverCodexContextHistoryJournalTail(
  stateDir: string,
  sessionId: string,
): Promise<CodexContextHistoryJournalTailRecoveryResult> {
  return withCodexContextHistoryJournalLock({ stateDir, sessionId }, () => (
    recoverCodexContextHistoryJournalTailLocked(stateDir, sessionId)
  ));
}

export async function readCodexContextHistoryJournalRecoveringTail(
  stateDir: string,
  sessionId: string,
): Promise<CodexContextHistoryJournalReadResult> {
  return withCodexContextHistoryJournalLock({ stateDir, sessionId }, async () => {
    await recoverCodexContextHistoryJournalTailLocked(stateDir, sessionId);
    return readCodexContextHistoryJournal(stateDir, sessionId);
  });
}

export async function appendCodexContextHistoryJournalEntryLocked(
  stateDir: string,
  sessionId: string,
  payload: unknown,
): Promise<void> {
  const path = codexContextHistoryJournalPath(stateDir, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await recoverCodexContextHistoryJournalTailLocked(stateDir, sessionId);
  const current = await readCodexContextHistoryJournal(stateDir, sessionId);
  if (current.readError || current.malformedLineCount > 0) {
    throw new Error(`Refusing to append to invalid Codex context-history journal for session ${sessionId}`);
  }
  const handle = await open(path, "a");
  try {
    await handle.appendFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendCodexContextHistoryJournalEntry(
  stateDir: string,
  sessionId: string,
  payload: unknown,
): Promise<void> {
  await withCodexContextHistoryJournalLock({ stateDir, sessionId }, async () => {
    await appendCodexContextHistoryJournalEntryLocked(stateDir, sessionId, payload);
  });
}
