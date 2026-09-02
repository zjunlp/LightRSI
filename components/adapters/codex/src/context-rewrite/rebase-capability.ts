import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_CAPABILITY_DEFAULT_TTL_MS,
  CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA,
  CODEX_REBASE_CAPABILITY_SCHEMA,
  LIGHTMEM2_CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA,
  LIGHTMEM2_CODEX_REBASE_CAPABILITY_SCHEMA,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  type CodexProviderReplayCompatibilityDecision,
  type CodexRebaseCapability,
  type CodexRebaseCapabilityEvidence,
  type CodexRebaseCapabilityStatus,
  type CodexUpstreamResponse,
  type JsonObject,
} from "./types.js";
import { acquireCodexRebaseSessionLock } from "./rebase-epoch.js";

export type CodexRebaseCapabilityJournalReadResult = {
  entries: CodexRebaseCapability[];
  capabilities: CodexRebaseCapability[];
  malformedLineCount: number;
  staleLineCount: number;
  readError?: string;
};

export type CodexRebasePayloadItemDescriptor = {
  itemType: string;
  payloadDigest: string;
};

export type CodexProviderReplayCompatibilityResult = {
  decisions: CodexProviderReplayCompatibilityDecision[];
  journalTrusted: boolean;
  reason?: string;
};

export type CodexRebaseRejectionClassification = {
  kind:
    | "chain_reference_unsupported"
    | "item_unsupported"
    | "payload_rejected"
    | "ambiguous"
    | "transient"
    | "unclassified";
  itemTypes: string[];
  errorCode?: string;
};

const CAPABILITY_JOURNAL_LOCK_SESSION_ID = "__provider-capabilities-journal__";
const CAPABILITY_JOURNAL_LOCK_TIMEOUT_MS = 5_000;
const CAPABILITY_JOURNAL_LOCK_RETRY_MS = 10;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type CapabilityDimensions = Pick<
  CodexRebaseCapability,
  "provider" | "model" | "wireMode" | "apiVersion" | "endpointId" | "itemType" | "itemSchemaVersion"
>;

function cleanDimension(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function isStatus(value: unknown): value is CodexRebaseCapabilityStatus {
  return value === "verified_supported"
    || value === "verified_unsupported"
    || value === "payload_rejected";
}

function isEvidence(value: unknown): value is CodexRebaseCapabilityEvidence {
  return value === "mock_fixture" || value === "real_provider";
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isEndpointId(value: unknown): value is string {
  return value === "not-observed" || isDigest(value);
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCodexRebaseCapability(value: unknown): CodexRebaseCapability | undefined {
  const entry = asObject(value);
  if (!entry || (entry.schema !== CODEX_REBASE_CAPABILITY_SCHEMA
    && entry.schema !== LIGHTMEM2_CODEX_REBASE_CAPABILITY_SCHEMA)) return undefined;
  if (
    typeof entry.provider !== "string" || !entry.provider.trim()
    || typeof entry.model !== "string" || !entry.model.trim()
    || typeof entry.wireMode !== "string" || !entry.wireMode.trim()
    || typeof entry.apiVersion !== "string" || !entry.apiVersion.trim()
    || !isEndpointId(entry.endpointId)
    || typeof entry.itemType !== "string" || !entry.itemType.trim()
    || typeof entry.itemSchemaVersion !== "string" || !entry.itemSchemaVersion.trim()
    || !isStatus(entry.status)
    || !isEvidence(entry.evidence)
    || !canonicalTimestamp(entry.observedAt)
    || !canonicalTimestamp(entry.expiresAt)
    || Date.parse(entry.expiresAt) <= Date.parse(entry.observedAt)
    || (entry.responseStatus !== undefined
      && (typeof entry.responseStatus !== "number"
        || !Number.isInteger(entry.responseStatus)
        || entry.responseStatus < 100
        || entry.responseStatus > 599))
    || (entry.reason !== undefined && typeof entry.reason !== "string")
    || (entry.errorCode !== undefined && typeof entry.errorCode !== "string")
  ) {
    return undefined;
  }
  const payloadDigest = isDigest(entry.payloadDigest) ? entry.payloadDigest : undefined;
  if ((entry.status === "payload_rejected") !== Boolean(payloadDigest)) return undefined;

  return {
    schema: CODEX_REBASE_CAPABILITY_SCHEMA,
    provider: entry.provider.trim(),
    model: entry.model.trim(),
    wireMode: entry.wireMode.trim(),
    apiVersion: entry.apiVersion.trim(),
    endpointId: entry.endpointId,
    itemType: entry.itemType.trim(),
    itemSchemaVersion: entry.itemSchemaVersion.trim(),
    status: entry.status,
    evidence: entry.evidence,
    payloadDigest,
    reason: optionalTrimmedString(entry.reason),
    responseStatus: entry.responseStatus as number | undefined,
    errorCode: optionalTrimmedString(entry.errorCode),
    observedAt: entry.observedAt,
    expiresAt: entry.expiresAt,
  };
}

function dimensionKey(entry: CapabilityDimensions): string {
  return [
    entry.provider,
    entry.model,
    entry.wireMode,
    entry.apiVersion,
    entry.endpointId,
    entry.itemType,
    entry.itemSchemaVersion,
  ].join("\u0000");
}

function capabilityKey(entry: CodexRebaseCapability): string {
  return entry.status === "payload_rejected"
    ? `${dimensionKey(entry)}\u0000payload\u0000${entry.payloadDigest}`
    : `${dimensionKey(entry)}\u0000item`;
}

function collapseLatestCapabilities(entries: CodexRebaseCapability[]): CodexRebaseCapability[] {
  const latest = new Map<string, CodexRebaseCapability>();
  for (const entry of entries) {
    const key = capabilityKey(entry);
    latest.delete(key);
    latest.set(key, entry);
  }
  return Array.from(latest.values());
}

function normalizedDimensions(params: CapabilityDimensions): CapabilityDimensions {
  return {
    provider: cleanDimension(params.provider, "unknown-provider"),
    model: cleanDimension(params.model, "unknown-model"),
    wireMode: cleanDimension(params.wireMode, CODEX_REBASE_WIRE_MODE),
    apiVersion: cleanDimension(params.apiVersion, CODEX_REBASE_API_VERSION),
    endpointId: isEndpointId(params.endpointId) ? params.endpointId : "not-observed",
    itemType: cleanDimension(params.itemType, "unknown"),
    itemSchemaVersion: cleanDimension(params.itemSchemaVersion, CODEX_REBASE_ITEM_SCHEMA_VERSION),
  };
}

export function codexRebaseEndpointIdentity(endpoint: string | undefined): string {
  const normalized = endpoint?.trim();
  return normalized
    ? `sha256:${createHash("sha256").update(normalized).digest("hex")}`
    : "not-observed";
}

export function codexRebasePayloadDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function codexRebaseCapabilityJournalPath(stateDir: string): string {
  return join(stateDir, "context-rewrite", "codex", "provider-capabilities.jsonl");
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withCapabilityJournalLock<T>(
  stateDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + CAPABILITY_JOURNAL_LOCK_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const lock = await acquireCodexRebaseSessionLock({
      stateDir,
      sessionId: CAPABILITY_JOURNAL_LOCK_SESSION_ID,
    });
    if (lock) {
      try {
        return await action();
      } finally {
        await lock.release();
      }
    }
    await wait(Math.min(CAPABILITY_JOURNAL_LOCK_RETRY_MS, Math.max(1, deadline - performance.now())));
  }
  throw new Error("Timed out acquiring Codex provider capability journal lock");
}

function parseCapabilityJournalText(raw: string): CodexRebaseCapabilityJournalReadResult {
  const entries: CodexRebaseCapability[] = [];
  let malformedLineCount = 0;
  let staleLineCount = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const object = asObject(parsed);
      if (object?.schema === CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA
        || object?.schema === LIGHTMEM2_CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA) {
        staleLineCount += 1;
        continue;
      }
      const capability = parseCodexRebaseCapability(parsed);
      if (capability) entries.push(capability);
      else malformedLineCount += 1;
    } catch {
      malformedLineCount += 1;
    }
  }
  return {
    entries,
    capabilities: collapseLatestCapabilities(entries),
    malformedLineCount,
    staleLineCount,
  };
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

function isIncompleteJsonError(error: unknown): boolean {
  return error instanceof SyntaxError
    && /(?:unexpected end of json input|unterminated string in json)/iu.test(error.message);
}

async function recoverCapabilityJournalTailLocked(stateDir: string): Promise<void> {
  const path = codexRebaseCapabilityJournalPath(stateDir);
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }
  if (raw.length === 0 || raw.at(-1) === 0x0a) return;

  const lastNewline = raw.lastIndexOf(0x0a);
  const prefixLength = lastNewline + 1;
  let prefixText: string;
  try {
    prefixText = FATAL_UTF8_DECODER.decode(raw.subarray(0, prefixLength));
  } catch {
    return;
  }
  const prefixResult = parseCapabilityJournalText(prefixText);
  if (prefixResult.malformedLineCount > 0) return;

  const tail = raw.subarray(prefixLength);
  let tailText: string;
  try {
    tailText = FATAL_UTF8_DECODER.decode(tail);
  } catch {
    await syncTruncate(path, prefixLength);
    return;
  }

  try {
    const parsed = JSON.parse(tailText) as unknown;
    const object = asObject(parsed);
    const isLegacy = object?.schema === CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA
      || object?.schema === LIGHTMEM2_CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA;
    if (isLegacy || parseCodexRebaseCapability(parsed)) {
      await syncAppendNewline(path);
      return;
    }
    // A complete but non-canonical record is not safe to guess or rewrite.
    return;
  } catch (error) {
    // A syntactically incomplete final JSON value is the recoverable crash case.
    if (!isIncompleteJsonError(error)) return;
    await syncTruncate(path, prefixLength);
  }
}

async function readCodexRebaseCapabilityJournalUnlocked(
  stateDir: string,
): Promise<CodexRebaseCapabilityJournalReadResult> {
  let raw: string;
  try {
    raw = await readFile(codexRebaseCapabilityJournalPath(stateDir), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { entries: [], capabilities: [], malformedLineCount: 0, staleLineCount: 0 };
    }
    return {
      entries: [],
      capabilities: [],
      malformedLineCount: 0,
      staleLineCount: 0,
      readError: error instanceof Error ? error.message : String(error),
    };
  }

  return parseCapabilityJournalText(raw);
}

export async function readCodexRebaseCapabilityJournal(
  stateDir: string,
): Promise<CodexRebaseCapabilityJournalReadResult> {
  return withCapabilityJournalLock(stateDir, async () => {
    await recoverCapabilityJournalTailLocked(stateDir);
    return readCodexRebaseCapabilityJournalUnlocked(stateDir);
  });
}

async function appendSyncedCapabilityEntry(path: string, entry: CodexRebaseCapability): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendCodexRebaseCapability(params: CapabilityDimensions & {
  stateDir: string;
  status: CodexRebaseCapabilityStatus;
  evidence: CodexRebaseCapabilityEvidence;
  payloadDigest?: string;
  reason?: string;
  responseStatus?: number;
  errorCode?: string;
  observedAt?: string;
  expiresAt?: string;
  ttlMs?: number;
}): Promise<CodexRebaseCapability> {
  const observedAt = params.observedAt ?? new Date().toISOString();
  if (!canonicalTimestamp(observedAt)) {
    throw new Error("Codex rebase capability requires a canonical observation time");
  }
  const ttlMs = params.ttlMs ?? CODEX_REBASE_CAPABILITY_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Codex rebase capability requires a positive TTL");
  }
  const expiresAt = params.expiresAt ?? new Date(Date.parse(observedAt) + ttlMs).toISOString();
  if (!canonicalTimestamp(expiresAt) || Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new Error("Codex rebase capability requires a canonical expiry after observation");
  }
  if (!isEndpointId(params.endpointId)) {
    throw new Error("Codex rebase capability endpoint identity must be a digest or not-observed");
  }
  if ((params.status === "payload_rejected") !== isDigest(params.payloadDigest)) {
    throw new Error("Payload-specific capability rejection requires exactly one payload digest");
  }
  const dimensions = normalizedDimensions(params);
  const entry: CodexRebaseCapability = {
    schema: CODEX_REBASE_CAPABILITY_SCHEMA,
    ...dimensions,
    status: params.status,
    evidence: params.evidence,
    payloadDigest: params.status === "payload_rejected" ? params.payloadDigest : undefined,
    reason: optionalTrimmedString(params.reason),
    responseStatus: params.responseStatus,
    errorCode: optionalTrimmedString(params.errorCode),
    observedAt,
    expiresAt,
  };
  await withCapabilityJournalLock(params.stateDir, () => (
    recoverCapabilityJournalTailLocked(params.stateDir).then(() => (
      appendSyncedCapabilityEntry(codexRebaseCapabilityJournalPath(params.stateDir), entry)
    ))
  ));
  return entry;
}

function itemTypeForPayloadItem(item: JsonObject): string {
  if (typeof item.type === "string" && item.type.trim()) return item.type.trim();
  if (typeof item.role === "string" && item.role.trim()) return "message";
  return "unknown";
}

export function codexRebasePayloadItems(payload: JsonObject): CodexRebasePayloadItemDescriptor[] {
  const grouped = new Map<string, JsonObject[]>();
  const input = Array.isArray(payload.input) ? payload.input : [];
  for (const item of input) {
    const entry = asObject(item);
    if (!entry) continue;
    const itemType = itemTypeForPayloadItem(entry);
    const values = grouped.get(itemType) ?? [];
    values.push(entry);
    grouped.set(itemType, values);
  }
  return Array.from(grouped, ([itemType, items]) => ({
    itemType,
    payloadDigest: codexRebasePayloadDigest(items),
  }));
}

export function codexRebasePayloadItemTypes(payload: JsonObject): string[] {
  return codexRebasePayloadItems(payload).map((entry) => entry.itemType);
}

function findLatest(
  entries: CodexRebaseCapability[],
  predicate: (entry: CodexRebaseCapability) => boolean,
): CodexRebaseCapability | undefined {
  let latest: CodexRebaseCapability | undefined;
  for (const entry of entries) {
    if (predicate(entry)) latest = entry;
  }
  return latest;
}

export async function resolveCodexProviderReplayCompatibility(params: Omit<CapabilityDimensions, "itemType"> & {
  stateDir: string;
  items: CodexRebasePayloadItemDescriptor[];
  acceptedEvidence?: CodexRebaseCapabilityEvidence[];
  now?: string;
}): Promise<CodexProviderReplayCompatibilityResult> {
  const journal = await readCodexRebaseCapabilityJournal(params.stateDir);
  const acceptedEvidence = new Set(params.acceptedEvidence ?? ["real_provider"]);
  const now = params.now ?? new Date().toISOString();
  if (!canonicalTimestamp(now)) throw new Error("Codex provider compatibility requires a canonical current time");

  const baseDimensions = {
    provider: params.provider,
    model: params.model,
    wireMode: params.wireMode,
    apiVersion: params.apiVersion,
    endpointId: params.endpointId,
    itemSchemaVersion: params.itemSchemaVersion,
  };
  const unknownDecisions = (reason: string): CodexProviderReplayCompatibilityDecision[] => (
    params.items.map((item) => ({
      ...normalizedDimensions({ ...baseDimensions, itemType: item.itemType }),
      status: "unknown_probe_required",
      payloadDigest: item.payloadDigest,
      reason,
    }))
  );

  if (journal.readError || journal.malformedLineCount > 0) {
    return {
      decisions: unknownDecisions("capability_journal_untrusted"),
      journalTrusted: false,
      reason: "capability_journal_untrusted",
    };
  }

  const decisions = params.items.map((item): CodexProviderReplayCompatibilityDecision => {
    const dimensions = normalizedDimensions({ ...baseDimensions, itemType: item.itemType });
    const matching = journal.capabilities.filter((entry) => dimensionKey(entry) === dimensionKey(dimensions));
    const accepted = matching.filter((entry) => acceptedEvidence.has(entry.evidence));
    const unexpired = accepted.filter((entry) => Date.parse(entry.expiresAt) > Date.parse(now));
    const payloadRejection = findLatest(unexpired, (entry) => (
      entry.status === "payload_rejected" && entry.payloadDigest === item.payloadDigest
    ));
    if (payloadRejection) {
      return {
        ...dimensions,
        status: "payload_rejected",
        evidence: payloadRejection.evidence,
        payloadDigest: item.payloadDigest,
        reason: payloadRejection.reason ?? "payload_rejected",
        observedAt: payloadRejection.observedAt,
        expiresAt: payloadRejection.expiresAt,
      };
    }
    const itemCapability = findLatest(unexpired, (entry) => entry.status !== "payload_rejected");
    if (itemCapability) {
      return {
        ...dimensions,
        status: itemCapability.status,
        evidence: itemCapability.evidence,
        payloadDigest: item.payloadDigest,
        reason: itemCapability.reason ?? itemCapability.status,
        observedAt: itemCapability.observedAt,
        expiresAt: itemCapability.expiresAt,
      };
    }
    const reason = accepted.length > 0
      ? "capability_expired"
      : matching.some((entry) => entry.evidence === "mock_fixture")
        ? "mock_fixture_not_provider_verified"
        : journal.staleLineCount > 0
          ? "legacy_capability_not_reused"
          : "capability_not_observed";
    return {
      ...dimensions,
      status: "unknown_probe_required",
      payloadDigest: item.payloadDigest,
      reason,
    };
  });
  return { decisions, journalTrusted: true };
}

export async function readUnsupportedCodexRebaseItemTypes(params: Omit<CapabilityDimensions, "itemType"> & {
  stateDir: string;
  itemTypes: string[];
  acceptedEvidence?: CodexRebaseCapabilityEvidence[];
  now?: string;
}): Promise<string[]> {
  const result = await resolveCodexProviderReplayCompatibility({
    ...params,
    items: Array.from(new Set(params.itemTypes)).map((itemType) => ({
      itemType,
      payloadDigest: codexRebasePayloadDigest([]),
    })),
  });
  if (!result.journalTrusted) throw new Error("Codex rebase capability journal is untrusted");
  return result.decisions
    .filter((entry) => entry.status === "verified_unsupported")
    .map((entry) => entry.itemType);
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return output;
  }
  const object = asObject(value);
  if (!object) return output;
  for (const item of Object.values(object)) collectStrings(item, output);
  return output;
}

function parsedResponseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function responseErrorText(response: CodexUpstreamResponse): string {
  const parsed = parsedResponseText(response.text);
  return (parsed === undefined ? [response.text] : collectStrings(parsed)).join(" ").toLowerCase();
}

function nestedErrorCode(value: unknown): string | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  if (typeof object.code === "string" && object.code.trim()) return object.code.trim().toLowerCase();
  for (const child of Object.values(object)) {
    const code = nestedErrorCode(child);
    if (code) return code;
  }
  return undefined;
}

export function classifyCodexRebaseCapabilityRejection(params: {
  response: CodexUpstreamResponse;
  items: CodexRebasePayloadItemDescriptor[];
}): CodexRebaseRejectionClassification {
  const itemTypes = params.items.map((entry) => entry.itemType);
  const parsed = parsedResponseText(params.response.text);
  const detectedErrorCode = nestedErrorCode(parsed);
  if ([401, 403, 429].includes(params.response.status) || params.response.status >= 500) {
    return { kind: "transient", itemTypes: [], errorCode: detectedErrorCode };
  }
  if (params.response.status !== 400) {
    return { kind: "unclassified", itemTypes: [], errorCode: detectedErrorCode };
  }

  const text = responseErrorText(params.response);
  const chainReferenceRejected = text.includes("previous_response_id") && (
    detectedErrorCode === "invalid_request_error"
    || detectedErrorCode === "unsupported_parameter"
    || /(unsupported|not supported|unknown|invalid|unrecognized|does not exist|not found)/iu.test(text)
  );
  if (chainReferenceRejected) {
    return { kind: "chain_reference_unsupported", itemTypes: [], errorCode: detectedErrorCode };
  }
  const encryptedTypes = itemTypes.filter((itemType) => itemType === "reasoning" || itemType === "compaction");
  const namedEncryptedTypes = encryptedTypes.filter((itemType) => text.includes(itemType.toLowerCase()));
  const payloadSpecific = detectedErrorCode === "invalid_encrypted_content"
    || /(encrypted|payload).*(invalid|expired|expiry|lineage|mismatch)/iu.test(text)
    || /(invalid|expired|expiry|lineage|mismatch).*(encrypted|payload)/iu.test(text);
  if (payloadSpecific) {
    const attributable = namedEncryptedTypes.length > 0
      ? namedEncryptedTypes
      : encryptedTypes.length === 1
        ? encryptedTypes
        : [];
    return attributable.length > 0
      ? { kind: "payload_rejected", itemTypes: Array.from(new Set(attributable)), errorCode: detectedErrorCode }
      : { kind: "ambiguous", itemTypes: [], errorCode: detectedErrorCode };
  }

  const explicitItemUnsupported = /(unsupported item|item type.*unsupported|unknown item|schema.*item|not supported)/iu.test(text)
    || detectedErrorCode === "unsupported_item_type";
  const namedItemTypes = itemTypes.filter((itemType) => text.includes(itemType.toLowerCase()));
  if (explicitItemUnsupported && namedItemTypes.length > 0) {
    return {
      kind: "item_unsupported",
      itemTypes: Array.from(new Set(namedItemTypes)),
      errorCode: detectedErrorCode,
    };
  }
  return explicitItemUnsupported || /(schema|invalid_request_error)/iu.test(text)
    ? { kind: "ambiguous", itemTypes: [], errorCode: detectedErrorCode }
    : { kind: "unclassified", itemTypes: [], errorCode: detectedErrorCode };
}

export function unsupportedCodexRebaseItemTypesFromResponse(params: {
  response: CodexUpstreamResponse;
  itemTypes: string[];
}): string[] {
  const classification = classifyCodexRebaseCapabilityRejection({
    response: params.response,
    items: params.itemTypes.map((itemType) => ({
      itemType,
      payloadDigest: codexRebasePayloadDigest([]),
    })),
  });
  return classification.kind === "item_unsupported" ? classification.itemTypes : [];
}

export function formatCodexRebaseCapabilityStatus(
  entry: CodexRebaseCapability,
  now = new Date().toISOString(),
): string {
  const evidence = entry.evidence === "real_provider" ? "real-provider" : "mock/fixture";
  const validity = Date.parse(entry.expiresAt) > Date.parse(now) ? "active" : "expired";
  return `${entry.provider}/${entry.model} ${entry.wireMode} ${entry.apiVersion} `
    + `${entry.itemType}@${entry.itemSchemaVersion} ${entry.status} evidence=${evidence} state=${validity}`;
}
