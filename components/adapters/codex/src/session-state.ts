import {
  appendRecentTurnBinding,
  loadRecentTurnBindings,
  loadSessionSnapshot,
  readJsonFile,
  resolveLatestSessionId,
  sessionStateRoot,
  sessionSnapshotPath,
  writeJsonFileAtomic,
  writeLatestSessionRef,
  writeSessionSnapshot,
} from "@lightrsi/host-adapter";
import { join } from "node:path";

export type CodexSessionSnapshot = {
  sessionId: string;
  codexSessionId?: string;
  latestResponseId?: string;
  previousResponseId?: string;
  latestModel?: string;
  latestUpstreamProvider?: string;
  workspaceHint?: string;
  transcriptPath?: string;
  disclosedReadPaths?: string[];
  /** Normalized read path -> call_id of the read that first disclosed it (null: not attributable). */
  disclosedReadOwners?: Record<string, string | null>;
  lastHookEvent?: string;
  lastToolName?: string;
  lastToolInputChars?: number;
  lastToolOutputChars?: number;
  updatedAt: string;
};

export type CodexRecentTurnBinding = {
  sessionId: string;
  responseId?: string;
  previousResponseId?: string;
  model?: string;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  toolCallCount?: number;
  stream?: boolean;
  updatedAt: string;
};

export type UpsertCodexSessionSnapshotOptions = {
  markLatest?: boolean;
};

type CodexResponseSessionRef = {
  responseId: string;
  sessionId: string;
  updatedAt: string;
};

type CodexPromptCacheKeySessionRef = {
  promptCacheKey: string;
  sessionId: string;
  updatedAt: string;
};

type CodexHostSessionAliasRef = {
  codexSessionId: string;
  sessionId: string;
  updatedAt: string;
};

function responseSessionPath(stateDir: string, responseId: string): string {
  return join(sessionStateRoot(stateDir), "responses", `${encodeURIComponent(responseId)}.json`);
}

function promptCacheKeySessionPath(stateDir: string, promptCacheKey: string): string {
  return join(sessionStateRoot(stateDir), "prompt-cache-keys", `${encodeURIComponent(promptCacheKey)}.json`);
}

function hostSessionAliasPath(stateDir: string, codexSessionId: string): string {
  return join(sessionStateRoot(stateDir), "host-session-aliases", `${encodeURIComponent(codexSessionId)}.json`);
}

async function markLatestSession(stateDir: string, sessionId: string, updatedAt: string): Promise<void> {
  await writeLatestSessionRef(stateDir, sessionId, updatedAt);
}

export async function loadCodexSessionSnapshot(
  stateDir: string,
  sessionId: string,
): Promise<CodexSessionSnapshot | null> {
  return loadSessionSnapshot<CodexSessionSnapshot>(stateDir, sessionId);
}

export async function upsertCodexSessionSnapshot(
  stateDir: string,
  sessionId: string,
  patch: Partial<CodexSessionSnapshot>,
  options?: UpsertCodexSessionSnapshotOptions,
): Promise<CodexSessionSnapshot> {
  const current = await loadCodexSessionSnapshot(stateDir, sessionId);
  const updatedAt = new Date().toISOString();
  const next: CodexSessionSnapshot = {
    sessionId,
    codexSessionId: patch.codexSessionId ?? current?.codexSessionId,
    latestResponseId: patch.latestResponseId ?? current?.latestResponseId,
    previousResponseId: patch.previousResponseId ?? current?.previousResponseId,
    latestModel: patch.latestModel ?? current?.latestModel,
    latestUpstreamProvider: patch.latestUpstreamProvider ?? current?.latestUpstreamProvider,
    workspaceHint: patch.workspaceHint ?? current?.workspaceHint,
    transcriptPath: patch.transcriptPath ?? current?.transcriptPath,
    disclosedReadPaths: patch.disclosedReadPaths ?? current?.disclosedReadPaths,
    disclosedReadOwners: patch.disclosedReadOwners ?? current?.disclosedReadOwners,
    lastHookEvent: patch.lastHookEvent ?? current?.lastHookEvent,
    lastToolName: patch.lastToolName ?? current?.lastToolName,
    lastToolInputChars: patch.lastToolInputChars ?? current?.lastToolInputChars,
    lastToolOutputChars: patch.lastToolOutputChars ?? current?.lastToolOutputChars,
    updatedAt,
  };
  await writeSessionSnapshot(stateDir, sessionId, next);
  if (options?.markLatest !== false) {
    await markLatestSession(stateDir, sessionId, updatedAt);
  }
  return next;
}

export async function mergeCodexSessionSnapshot(
  stateDir: string,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<CodexSessionSnapshot | null> {
  const normalizedSourceSessionId = sourceSessionId.trim();
  const normalizedTargetSessionId = targetSessionId.trim();
  if (!normalizedSourceSessionId || !normalizedTargetSessionId) return null;
  if (normalizedSourceSessionId === normalizedTargetSessionId) {
    return loadCodexSessionSnapshot(stateDir, normalizedTargetSessionId);
  }

  const [source, target] = await Promise.all([
    loadCodexSessionSnapshot(stateDir, normalizedSourceSessionId),
    loadCodexSessionSnapshot(stateDir, normalizedTargetSessionId),
  ]);
  if (!source) return target;

  return upsertCodexSessionSnapshot(stateDir, normalizedTargetSessionId, {
    codexSessionId: target?.codexSessionId ?? source.codexSessionId,
    latestResponseId: target?.latestResponseId ?? source.latestResponseId,
    previousResponseId: target?.previousResponseId ?? source.previousResponseId,
    latestModel: target?.latestModel ?? source.latestModel,
    latestUpstreamProvider: target?.latestUpstreamProvider ?? source.latestUpstreamProvider,
    workspaceHint: target?.workspaceHint ?? source.workspaceHint,
    transcriptPath: target?.transcriptPath ?? source.transcriptPath,
    disclosedReadPaths: target?.disclosedReadPaths ?? source.disclosedReadPaths,
    disclosedReadOwners: target?.disclosedReadOwners ?? source.disclosedReadOwners,
    lastHookEvent: target?.lastHookEvent ?? source.lastHookEvent,
    lastToolName: target?.lastToolName ?? source.lastToolName,
    lastToolInputChars: target?.lastToolInputChars ?? source.lastToolInputChars,
    lastToolOutputChars: target?.lastToolOutputChars ?? source.lastToolOutputChars,
  });
}

export async function appendCodexRecentTurnBinding(
  stateDir: string,
  binding: CodexRecentTurnBinding,
): Promise<void> {
  await appendRecentTurnBinding(stateDir, binding);
}

export async function indexCodexResponseSession(
  stateDir: string,
  responseId: string,
  sessionId: string,
): Promise<void> {
  const normalizedResponseId = responseId.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedResponseId || !normalizedSessionId) return;
  await writeJsonFileAtomic(responseSessionPath(stateDir, normalizedResponseId), {
    responseId: normalizedResponseId,
    sessionId: normalizedSessionId,
    updatedAt: new Date().toISOString(),
  } satisfies CodexResponseSessionRef);
}

export async function resolveCodexSessionIdByResponseId(
  stateDir: string,
  responseId: string,
): Promise<string | undefined> {
  const normalizedResponseId = responseId.trim();
  if (!normalizedResponseId) return undefined;
  const record = await readJsonFile<CodexResponseSessionRef>(responseSessionPath(stateDir, normalizedResponseId));
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
  return sessionId || undefined;
}

export async function indexCodexPromptCacheKeySession(
  stateDir: string,
  promptCacheKey: string,
  sessionId: string,
): Promise<void> {
  const normalizedPromptCacheKey = promptCacheKey.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedPromptCacheKey || !normalizedSessionId) return;
  await writeJsonFileAtomic(promptCacheKeySessionPath(stateDir, normalizedPromptCacheKey), {
    promptCacheKey: normalizedPromptCacheKey,
    sessionId: normalizedSessionId,
    updatedAt: new Date().toISOString(),
  } satisfies CodexPromptCacheKeySessionRef);
}

export async function resolveCodexSessionIdByPromptCacheKey(
  stateDir: string,
  promptCacheKey: string,
): Promise<string | undefined> {
  const normalizedPromptCacheKey = promptCacheKey.trim();
  if (!normalizedPromptCacheKey) return undefined;
  const record = await readJsonFile<CodexPromptCacheKeySessionRef>(
    promptCacheKeySessionPath(stateDir, normalizedPromptCacheKey),
  );
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
  return sessionId || undefined;
}

export async function indexCodexHostSessionAlias(
  stateDir: string,
  codexSessionId: string,
  sessionId: string,
): Promise<void> {
  const normalizedCodexSessionId = codexSessionId.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedCodexSessionId || !normalizedSessionId) return;
  await writeJsonFileAtomic(hostSessionAliasPath(stateDir, normalizedCodexSessionId), {
    codexSessionId: normalizedCodexSessionId,
    sessionId: normalizedSessionId,
    updatedAt: new Date().toISOString(),
  } satisfies CodexHostSessionAliasRef);
}

export async function resolveCodexSessionAlias(
  stateDir: string,
  codexSessionId: string,
): Promise<string | undefined> {
  const normalizedCodexSessionId = codexSessionId.trim();
  if (!normalizedCodexSessionId) return undefined;
  const record = await readJsonFile<CodexHostSessionAliasRef>(
    hostSessionAliasPath(stateDir, normalizedCodexSessionId),
  );
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
  return sessionId || undefined;
}

export async function loadCodexRecentTurnBindings(
  stateDir: string,
  sessionId: string,
  limit = 8,
): Promise<CodexRecentTurnBinding[]> {
  return loadRecentTurnBindings<CodexRecentTurnBinding>(
    stateDir,
    sessionId,
    limit,
    (entry): entry is CodexRecentTurnBinding =>
      Boolean(entry && typeof entry === "object" && typeof (entry as { sessionId?: unknown }).sessionId === "string"),
  );
}

export async function resolveLatestCodexSessionId(stateDir: string): Promise<string | undefined> {
  return resolveLatestSessionId(stateDir);
}

export async function resolveCanonicalCodexSessionId(
  stateDir: string,
  sessionRef?: string,
): Promise<string | undefined> {
  const normalizedSessionRef = typeof sessionRef === "string" ? sessionRef.trim() : "";
  if (normalizedSessionRef) {
    return await resolveCodexSessionAlias(stateDir, normalizedSessionRef) ?? normalizedSessionRef;
  }
  return resolveLatestCodexSessionId(stateDir);
}
