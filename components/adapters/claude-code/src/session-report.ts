import {
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@lightrsi/host-adapter";
import {
  buildBaseSessionOverview,
  resolveBaseSessionTopology,
  renderSessionReport,
  type ProductSurfaceSessionOverviewItem,
} from "@lightrsi/product-surface";
import {
  readRecentClaudeCodeCacheAuditRecordsForSession,
  summarizeClaudeCodeCacheAudit,
} from "./cache-audit.js";
import {
  loadClaudeCodeRecentTurnBindings,
  loadClaudeCodeSessionSnapshot,
  resolveLatestClaudeCodeSessionId,
} from "./session-state.js";
import {
  readClaudeCleanerObservability,
  type ClaudeCleanerObservability,
} from "./context-cleaner/observability.js";

export type ClaudeCodeSessionTopology = {
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
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  reductionSavedChars?: number;
  evictionSavedChars?: number;
  evictionSavedCharsCumulative?: number;
  updatedAt?: string;
  turnCount: number;
};

function formatCleanerSavings(
  value: ClaudeCleanerObservability["savings"]["estimated"],
  availability: ClaudeCleanerObservability["availability"],
): string {
  if (!value) return availability === "degraded" ? "unknown" : "none";
  return `${value.tokens === null ? "tokens unavailable" : `${value.tokens} tokens`}, ${value.chars} chars`;
}

function buildClaudeCleanerReportLines(observation: ClaudeCleanerObservability): string[] {
  return [
    `- Cleaner estimated savings: ${formatCleanerSavings(observation.savings.estimated, observation.availability)}`,
    `- Cleaner scheduled savings: ${formatCleanerSavings(observation.savings.scheduled, observation.availability)}`,
    `- Cleaner applied savings: ${formatCleanerSavings(observation.savings.applied, observation.availability)}`,
    `- Cleaner fallback count: ${observation.fallbackCount ?? "unknown"}`,
  ];
}

export async function resolveClaudeCodeSessionTopology(
  stateDir: string,
  sessionRef?: string,
): Promise<ClaudeCodeSessionTopology | undefined> {
  const sessionId = (typeof sessionRef === "string" ? sessionRef.trim() || undefined : undefined)
    ?? await resolveLatestClaudeCodeSessionId(stateDir);
  if (!sessionId) return undefined;

  const [snapshot, bindings] = await Promise.all([
    loadClaudeCodeSessionSnapshot(stateDir, sessionId),
    loadClaudeCodeRecentTurnBindings(stateDir, sessionId, 12),
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
    buildExtra: (value, latestBinding) => ({
      lastHookEvent: value?.lastHookEvent,
      lastToolName: value?.lastToolName,
      lastToolInputChars: value?.lastToolInputChars,
      lastToolOutputChars: value?.lastToolOutputChars,
      requestChars: value?.requestChars ?? latestBinding?.requestChars,
      responseChars: value?.responseChars ?? latestBinding?.responseChars,
      assistantChars: value?.assistantChars ?? latestBinding?.assistantChars,
      reductionSavedChars: value?.reductionSavedChars ?? latestBinding?.reductionSavedChars,
      evictionSavedChars: value?.evictionSavedChars ?? latestBinding?.evictionSavedChars,
      evictionSavedCharsCumulative: bindings.reduce(
        (total, b) => total + (typeof b?.evictionSavedChars === "number" ? b.evictionSavedChars : 0),
        0,
      ),
    }),
  });
}

export async function renderClaudeCodeSessionReport(stateDir: string, sessionRef?: string): Promise<string> {
  const topology = await resolveClaudeCodeSessionTopology(stateDir, sessionRef);
  if (!topology) return "No Claude Code TokenPilot session data found.";

  const overview: ProductSurfaceSessionOverviewItem[] = buildBaseSessionOverview(topology, [
    { label: "Latest request chars", value: topology.requestChars ?? 0 },
    { label: "Latest response chars", value: topology.responseChars ?? 0 },
    { label: "Latest assistant chars", value: topology.assistantChars ?? 0 },
    { label: "Latest reduction savings", value: topology.reductionSavedChars ?? 0 },
    { label: "Latest eviction savings", value: topology.evictionSavedChars ?? 0 },
    { label: "Cumulative eviction savings", value: topology.evictionSavedCharsCumulative ?? 0 },
  ]);

  if (topology.lastToolName) {
    overview.push({ label: "Last tool", value: topology.lastToolName });
  }
  const cacheAuditRecords = await readRecentClaudeCodeCacheAuditRecordsForSession(stateDir, topology.sessionId, 64);
  const cacheAuditSummary = cacheAuditRecords.length > 0
    ? summarizeClaudeCodeCacheAudit(cacheAuditRecords)
    : null;
  const cleanerReportLines = buildClaudeCleanerReportLines(
    await readClaudeCleanerObservability({ stateDir, sessionId: topology.sessionId }),
  );

  const baseReport = await renderSessionReport({
    stateDir,
    title: "TokenPilot Claude Code report:",
    sessionId: topology.sessionId,
    detailsEnabled: true,
    overview,
    cacheAuditSummary,
    readers: {
      readLatest: readLatestUxEffect,
      readAggregate: readUxSessionAggregate,
    },
  });
  return `${baseReport}\n${cleanerReportLines.join("\n")}`;
}
