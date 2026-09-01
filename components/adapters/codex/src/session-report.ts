import {
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@lightrsi/host-adapter";
import {
  buildBaseSessionOverview,
  resolveBaseSessionTopology,
  renderSessionReport,
} from "@lightrsi/product-surface";
import { readRecentCodexCacheAuditRecordsForSession, summarizeCodexCacheAudit } from "./cache-audit.js";
import {
  formatCodexRebaseCapabilityStatus,
  readCodexRebaseCapabilityJournal,
  readCodexRebaseCooldownJournal,
  readCodexRebaseEpochJournal,
} from "./context-rewrite/index.js";
import type {
  CodexRebaseCooldown,
  CodexRebaseEpoch,
  CodexRebaseEpochStatus,
} from "./context-rewrite/types.js";
import {
  readCodexCleanerObservability,
  type CodexCleanerObservability,
} from "./context-cleaner/observability.js";
import {
  loadCodexRecentTurnBindings,
  loadCodexSessionSnapshot,
  resolveCanonicalCodexSessionId,
} from "./session-state.js";

export type CodexSessionTopology = {
  sessionId: string;
  latestResponseId?: string;
  previousResponseId?: string;
  responseChain: string[];
  latestModel?: string;
  workspaceHint?: string;
  lastHookEvent?: string;
  lastToolName?: string;
  lastToolInputChars?: number;
  lastToolOutputChars?: number;
  updatedAt?: string;
  turnCount: number;
};

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function activeCooldowns(cooldowns: CodexRebaseCooldown[]): CodexRebaseCooldown[] {
  const now = Date.now();
  return cooldowns.filter((entry) => {
    const expiresAtMs = timestampMs(entry.expiresAt);
    return expiresAtMs !== undefined && expiresAtMs > now;
  });
}

function countEpochs(epochs: CodexRebaseEpoch[]): Record<CodexRebaseEpochStatus, number> {
  return {
    pending: epochs.filter((entry) => entry.status === "pending").length,
    committed: epochs.filter((entry) => entry.status === "committed").length,
    failed: epochs.filter((entry) => entry.status === "failed").length,
    rolled_back: epochs.filter((entry) => entry.status === "rolled_back").length,
  };
}

function latestEpoch(epochs: CodexRebaseEpoch[]): CodexRebaseEpoch | undefined {
  return epochs.at(-1);
}

function latestCooldown(cooldowns: CodexRebaseCooldown[]): CodexRebaseCooldown | undefined {
  return cooldowns.at(-1);
}

function formatCharsAndTokens(chars: number, tokens: number): string {
  return `${chars} chars (~${tokens} tokens)`;
}

function formatCleanerSavings(
  value: CodexCleanerObservability["savings"]["estimated"],
  availability: CodexCleanerObservability["availability"],
): string {
  if (!value) return availability === "degraded" ? "unknown" : "none";
  return `${value.tokens === null ? "tokens unavailable" : `${value.tokens} tokens`}, ${value.chars} chars`;
}

function buildCodexCleanerReportLines(observation: CodexCleanerObservability): string[] {
  return [
    `- Cleaner estimated savings: ${formatCleanerSavings(observation.savings.estimated, observation.availability)}`,
    `- Cleaner scheduled savings: ${formatCleanerSavings(observation.savings.scheduled, observation.availability)}`,
    `- Cleaner applied savings: ${formatCleanerSavings(observation.savings.applied, observation.availability)}`,
    `- Cleaner fallback count: ${observation.fallbackCount ?? "unknown"}`,
  ];
}

function formatCodexRebaseAccounting(epoch: CodexRebaseEpoch): string | undefined {
  const accounting = epoch.accounting;
  if (!accounting) return undefined;
  return "- CDR-02 rebase accounting: "
    + `planned_saved=${formatCharsAndTokens(accounting.plannedSavedChars, accounting.plannedSavedTokens)}, `
    + `removed=${formatCharsAndTokens(accounting.actuallyRemovedChars, accounting.actuallyRemovedTokens)}, `
    + `replay_cost=${formatCharsAndTokens(accounting.rebaseReplayCostChars, accounting.rebaseReplayCostTokens)}, `
    + `subsequent_saved=${accounting.subsequentSavedCharsPerTurn} chars/turn `
    + `(~${accounting.subsequentSavedTokensPerTurn} tokens/turn), `
    + `estimator_cost=${formatCharsAndTokens(accounting.estimatorCostChars, accounting.estimatorCostTokens)}, `
    + `fallback_extra_requests=${accounting.fallbackExtraRequestCount} `
    + `cache_cold_misses=${accounting.cacheColdMissCount} `
    + `break_even_turn=${accounting.breakEvenTurn ?? "never"}`;
}

async function buildCodexRebaseReportLines(
  stateDir: string,
  sessionId: string,
): Promise<string[]> {
  const [epochJournal, cooldownJournal, capabilityJournal] = await Promise.all([
    readCodexRebaseEpochJournal(stateDir, sessionId),
    readCodexRebaseCooldownJournal(stateDir, sessionId),
    readCodexRebaseCapabilityJournal(stateDir),
  ]);
  const readErrors = [
    epochJournal.readError ? `epoch=${epochJournal.readError}` : "",
    cooldownJournal.readError ? `cooldown=${cooldownJournal.readError}` : "",
    capabilityJournal.readError ? `capability=${capabilityJournal.readError}` : "",
  ].filter(Boolean);
  const epochs = epochJournal.epochs;
  const cooldowns = cooldownJournal.cooldowns;
  const capabilities = capabilityJournal.capabilities;
  if (
    epochs.length === 0
    && cooldowns.length === 0
    && capabilities.length === 0
    && readErrors.length === 0
  ) {
    return [];
  }

  const counts = countEpochs(epochs);
  const latest = latestEpoch(epochs);
  const currentCooldowns = activeCooldowns(cooldowns);
  const cooldown = latestCooldown(cooldowns);
  const capabilityJournalTrusted = !capabilityJournal.readError
    && capabilityJournal.malformedLineCount === 0;
  const capabilityStatus = capabilityJournalTrusted
    ? capabilities.map((entry) => formatCodexRebaseCapabilityStatus(entry)).sort()
    : [];
  const malformedRows =
    epochJournal.malformedLineCount
    + cooldownJournal.malformedLineCount
    + capabilityJournal.malformedLineCount;
  const lines = [
    "- CDR-03 rebase epochs: "
      + `committed=${counts.committed}, `
      + `rolled_back=${counts.rolled_back}, `
      + `failed=${counts.failed}, `
      + `pending=${counts.pending}`,
  ];
  if (latest) {
    lines.push(
      "- CDR-03 latest rebase epoch: "
        + `${latest.status} ${latest.epochId} `
        + `old=${latest.oldPreviousResponseId}`
        + (latest.newResponseId ? ` new=${latest.newResponseId}` : ""),
    );
    const accountingLine = formatCodexRebaseAccounting(latest);
    if (accountingLine) lines.push(accountingLine);
  }
  if (cooldowns.length > 0) {
    lines.push(
      "- CDR-04 rebase cooldowns: "
        + `active=${currentCooldowns.length}/${cooldowns.length}`
        + (cooldown ? ` latest=${cooldown.reason} expires=${cooldown.expiresAt}` : ""),
    );
  }
  if (capabilityStatus.length > 0) {
    lines.push(`- CDR-05 rebase capability cache: ${capabilityStatus.join(", ")}`);
  } else if (!capabilityJournalTrusted) {
    lines.push("- CDR-05 rebase capability cache: untrusted; runtime will bypass rebase");
  }
  if (malformedRows > 0) {
    lines.push(`- rebase journal malformed rows: ${malformedRows}`);
  }
  if (readErrors.length > 0) {
    lines.push(`- rebase journal read errors: ${readErrors.join(", ")}`);
  }
  return lines;
}

export async function resolveCodexSessionTopology(
  stateDir: string,
  sessionRef?: string,
): Promise<CodexSessionTopology | undefined> {
  const sessionId = await resolveCanonicalCodexSessionId(
    stateDir,
    typeof sessionRef === "string" ? sessionRef.trim() || undefined : undefined,
  );
  if (!sessionId) return undefined;

  const [snapshot, bindings] = await Promise.all([
    loadCodexSessionSnapshot(stateDir, sessionId),
    loadCodexRecentTurnBindings(stateDir, sessionId, 12),
  ]);
  if (!snapshot && bindings.length === 0) return undefined;

  return resolveBaseSessionTopology({
    sessionId,
    snapshot,
    bindings,
    getSnapshotLatestResponseId: (value) => value?.latestResponseId,
    getBindingResponseId: (value) => value?.responseId,
    getSnapshotPreviousResponseId: (value) => value?.previousResponseId,
    getBindingPreviousResponseId: (value) => value?.previousResponseId,
    getSnapshotModel: (value) => value?.latestModel,
    getBindingModel: (value) => value?.model,
    getSnapshotWorkspaceHint: (value) => value?.workspaceHint,
    getSnapshotUpdatedAt: (value) => value?.updatedAt,
    getBindingUpdatedAt: (value) => value?.updatedAt,
    buildExtra: (value) => ({
      lastHookEvent: value?.lastHookEvent,
      lastToolName: value?.lastToolName,
      lastToolInputChars: value?.lastToolInputChars,
      lastToolOutputChars: value?.lastToolOutputChars,
    }),
  });
}

export async function renderCodexSessionReport(stateDir: string, sessionRef?: string): Promise<string> {
  const topology = await resolveCodexSessionTopology(stateDir, sessionRef);
  if (!topology) return "No Codex TokenPilot session data found.";

  const overview = buildBaseSessionOverview(topology);
  const cacheAuditRecords = await readRecentCodexCacheAuditRecordsForSession(stateDir, topology.sessionId, 64);
  const cacheAuditSummary = cacheAuditRecords.length > 0
    ? summarizeCodexCacheAudit(cacheAuditRecords)
    : null;
  const rebaseReportLines = await buildCodexRebaseReportLines(stateDir, topology.sessionId);
  const cleanerReportLines = buildCodexCleanerReportLines(
    await readCodexCleanerObservability({ stateDir, sessionId: topology.sessionId }),
  );

  const baseReport = await renderSessionReport({
    stateDir,
    title: "TokenPilot Codex report:",
    sessionId: topology.sessionId,
    detailsEnabled: true,
    overview,
    cacheAuditSummary,
    readers: {
      readLatest: readLatestUxEffect,
      readAggregate: readUxSessionAggregate,
    },
  });
  return `${baseReport}\n${[...rebaseReportLines, ...cleanerReportLines].join("\n")}`;
}
