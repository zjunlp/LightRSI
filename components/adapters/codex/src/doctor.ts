import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  inspectTokenPilotMcpHealth,
  TOKENPILOT_MCP_SERVER_NAME,
} from "../../../products/mcp/src/index.js";
import {
  asObjectRecord,
  scanInstalledHookEvents,
} from "../../shared/doctor-shared.js";
import type {
  CodexMcpServerConfig,
  CodexProviderConfig,
  TokenPilotCodexConfig,
} from "./config.js";
import {
  readCodexMcpServerFromToml,
  readCodexProviderFromToml,
  readCodexRootModelProvider,
} from "./config.js";
import {
  formatCodexRebaseCapabilityStatus,
  readCodexRebaseCapabilityJournal,
} from "./context-rewrite/rebase-capability.js";
import {
  codexEstimatorDiagnostic,
  resolveCodexTaskStateEstimator,
  type CodexEstimatorDiagnostic,
} from "./context-rewrite/estimator-config.js";
import {
  emptyCodexCleanerObservability,
  readCodexCleanerObservability,
  type CodexCleanerObservability,
} from "./context-cleaner/observability.js";
import { readDaemonStatus } from "./daemon.js";
import { resolveCodexHookCommandForInstall, resolveCodexMcpServerSpecForInstall } from "./install.js";
import { resolveLatestCodexSessionId } from "./session-state.js";

export type CodexDoctorReport = {
  configPath: string;
  hooksConfigPath: string;
  tokenPilotConfigPath: string;
  proxyBaseUrl: string;
  expectedHookCommand: string;
  expectedMcpCommand: string;
  expectedMcpArgs: string[];
  providerInstalled: boolean;
  providerActive: boolean;
  providerIntercepted: boolean;
  hooksInstalled: boolean;
  hooksComplete: boolean;
  hooksMatchExpectedCommand: boolean;
  installedHookEvents: string[];
  missingHookEvents: string[];
  daemonRunning: boolean;
  proxyHealthy: boolean;
  stateDir: string;
  upstreamProvider?: string;
  upstreamLoopDetected: boolean;
  upstreamBaseUrl?: string;
  mcpInstalled: boolean;
  mcpStateDirMatches: boolean;
  mcpCommandMatches: boolean;
  mcpArgsMatch: boolean;
  mcpStartupTimeoutSecMatches: boolean;
  expectedMcpStartupTimeoutSec: number;
  adapterEnabled: boolean;
  coreRuntimeHealthy: boolean;
  recoveryMcpHealthy: boolean;
  degradedMode: boolean;
  rebaseCapabilityStatus?: string[];
  rebaseCapabilityTrusted?: boolean;
  rebaseCapabilityIssue?: string;
  taskStateEstimator?: CodexEstimatorDiagnostic;
  cleaner?: CodexCleanerObservability;
};

export type CodexProviderDiagnostic = {
  configured: boolean;
  name?: string;
  baseUrlConfigured: boolean;
  apiKeyConfigured: boolean;
  wireApi?: "responses" | "chat";
  requiresOpenAIAuth?: boolean;
};

export type CodexMcpServerDiagnostic = {
  configured: boolean;
  commandConfigured: boolean;
  argsCount: number;
  envKeys: string[];
  startupTimeoutSec?: number;
};

const HOOK_EVENT_NAMES = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

function normalizeLocalProxyBaseUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/v1$/i.exec(trimmed);
  if (!match) return undefined;
  return `http://127.0.0.1:${match[1]}/v1`;
}

function sanitizeDiagnosticUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, value.endsWith("/") ? "/" : "");
  } catch {
    return "(configured but not safely displayable)";
  }
}

export function codexProviderDiagnostic(
  provider: CodexProviderConfig | undefined,
): CodexProviderDiagnostic {
  const name = provider?.name?.trim();
  return {
    configured: Boolean(provider),
    name: name && !/(?:\b(?:bearer|api[_-]?key|access[_-]?token|secret|authorization)\b|sk-[a-z0-9_-]{12,}|(?:github_pat_|gh[pousr]_)[a-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|(?:xapp-|xox[baprsuv]-)[a-z0-9-]{10,}|tvly-[a-z0-9-]{12,}|[?&](?:key|token|signature)=)/iu.test(name)
      ? name
      : name
        ? "(configured but not safely displayable)"
        : undefined,
    baseUrlConfigured: Boolean(provider?.baseUrl),
    apiKeyConfigured: Boolean(provider?.apiKey),
    wireApi: provider?.wireApi,
    requiresOpenAIAuth: provider?.requiresOpenAIAuth,
  };
}

export function codexMcpServerDiagnostic(
  server: CodexMcpServerConfig | undefined,
): CodexMcpServerDiagnostic {
  return {
    configured: Boolean(server),
    commandConfigured: Boolean(server?.command),
    argsCount: server?.args.length ?? 0,
    envKeys: Object.keys(server?.env ?? {}).sort(),
    startupTimeoutSec: server?.startupTimeoutSec,
  };
}

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/health`);
    if (!resp.ok) return false;
    const payload = await resp.json().catch(() => undefined) as { adapter?: string } | undefined;
    return payload?.adapter === "tokenpilot-codex";
  } catch {
    return false;
  }
}

export function formatCodexDoctorReport(report: CodexDoctorReport): string {
  const cleaner = report.cleaner ?? emptyCodexCleanerObservability();
  const taskStateEstimator = report.taskStateEstimator ?? {
    status: "disabled" as const,
    model: null,
    baseUrlConfigured: false,
    apiKeyConfigured: false,
    requestTimeoutMs: 60_000,
    batchTurns: 5,
    evictionLookaheadTurns: 3,
    missingFields: [],
  };
  const rebaseCapabilityStatus = report.rebaseCapabilityStatus ?? [];
  const rebaseCapabilitySummary = report.rebaseCapabilityTrusted === false
    ? `untrusted (${report.rebaseCapabilityIssue ?? "read or validation error"}); runtime will bypass rebase`
    : rebaseCapabilityStatus.length > 0
      ? rebaseCapabilityStatus.join(", ")
      : "(none)";
  const lines = [
    "TokenPilot Codex doctor:",
    `- tokenpilot config: ${report.tokenPilotConfigPath}`,
    `- codex config: ${report.configPath}`,
    `- hooks config: ${report.hooksConfigPath}`,
    `- stateDir: ${report.stateDir}`,
    `- expected hook command: ${report.expectedHookCommand}`,
    `- expected MCP command: ${report.expectedMcpCommand}`,
    `- expected MCP args: ${report.expectedMcpArgs.length > 0 ? report.expectedMcpArgs.join(" ") : "(none)"}`,
    `- expected MCP startup timeout: ${report.expectedMcpStartupTimeoutSec}s`,
    `- adapter enabled: ${report.adapterEnabled ? "yes" : "no"}`,
    `- core runtime healthy: ${report.coreRuntimeHealthy ? "yes" : "no"}`,
    `- recovery MCP healthy: ${report.recoveryMcpHealthy ? "yes" : "no"}`,
    `- degraded mode: ${report.degradedMode ? "yes" : "no"}`,
    `- provider installed: ${report.providerInstalled ? "yes" : "no"}`,
    `- active provider selected: ${report.providerActive ? "yes" : "no"}`,
    `- active provider routed through proxy: ${report.providerIntercepted ? "yes" : "no"}`,
    `- recovery MCP installed: ${report.mcpInstalled ? "yes" : "no"}`,
    `- hooks installed: ${report.hooksInstalled ? "yes" : "no"}`,
    `- hooks complete: ${report.hooksComplete ? "yes" : "no"}`,
    `- hooks match expected command: ${report.hooksMatchExpectedCommand ? "yes" : "no"}`,
    `- installed hook events: ${report.installedHookEvents.length > 0 ? report.installedHookEvents.join(", ") : "(none)"}`,
    `- missing hook events: ${report.missingHookEvents.length > 0 ? report.missingHookEvents.join(", ") : "(none)"}`,
    `- recovery MCP stateDir matches: ${report.mcpStateDirMatches ? "yes" : "no"}`,
    `- recovery MCP command matches: ${report.mcpCommandMatches ? "yes" : "no"}`,
    `- recovery MCP args match: ${report.mcpArgsMatch ? "yes" : "no"}`,
    `- recovery MCP startup timeout matches: ${report.mcpStartupTimeoutSecMatches ? "yes" : "no"}`,
    `- daemon running: ${report.daemonRunning ? "yes" : "no"}`,
    `- proxy healthy: ${report.proxyHealthy ? "yes" : "no"}`,
    `- proxy base URL: ${sanitizeDiagnosticUrl(report.proxyBaseUrl) ?? "(unset)"}`,
    `- upstream provider: ${report.upstreamProvider ?? "(unset)"}`,
    `- upstream base URL: ${sanitizeDiagnosticUrl(report.upstreamBaseUrl) ?? "(unset)"}`,
    `- upstream loops into local proxy: ${report.upstreamLoopDetected ? "yes" : "no"}`,
    `- task-state estimator status: ${taskStateEstimator.status}`,
    `- task-state estimator model: ${taskStateEstimator.model ?? "(unset)"}`,
    `- task-state estimator base URL configured: ${taskStateEstimator.baseUrlConfigured ? "yes" : "no"}`,
    `- task-state estimator API key configured: ${taskStateEstimator.apiKeyConfigured ? "yes" : "no"}`,
    `- task-state estimator request timeout: ${taskStateEstimator.requestTimeoutMs}ms`,
    `- task-state estimator batch turns: ${taskStateEstimator.batchTurns}`,
    `- task-state estimator eviction lookahead turns: ${taskStateEstimator.evictionLookaheadTurns}`,
    `- task-state estimator missing fields: ${taskStateEstimator.missingFields.length > 0 ? taskStateEstimator.missingFields.join(", ") : "(none)"}`,
    `- CDR-05 rebase capability cache: ${rebaseCapabilitySummary}`,
    `- Cleaner capability: ${cleaner.availability}`,
    `- Cleaner plan store: ${cleaner.planStore}`,
    `- Cleaner pending plan: ${cleaner.pendingPlan}`,
    `- Cleaner last receipt: ${cleaner.lastReceipt}`,
    `- Cleaner rewrite mode: ${cleaner.rewriteMode}`,
  ];
  const fixes: string[] = [];
  if (!report.adapterEnabled) {
    fixes.push("- rerun the Codex install command to set `enabled: true` in `tokenpilot.json`");
  }
  if (!report.providerInstalled) {
    fixes.push("- rerun the Codex install command to refresh the intercepted provider entry in `config.toml`");
  }
  if (report.providerInstalled && !report.providerActive) {
    fixes.push("- set the root `model_provider` in `config.toml` back to the provider TokenPilot installed against");
  }
  if (report.providerInstalled && report.providerActive && !report.providerIntercepted) {
    fixes.push("- rerun the Codex install command or repoint the active provider `base_url` to the local TokenPilot proxy");
  }
  if (report.upstreamLoopDetected) {
    fixes.push("- stop all TokenPilot Codex proxy processes, restore `tokenpilot.json` upstream to the real remote API base URL, then restart the daemon");
    fixes.push("- rerun the Codex install command after the daemon is stopped so the intercepted provider is not captured as the upstream provider");
  }
  if (!report.hooksInstalled || !report.hooksComplete || !report.hooksMatchExpectedCommand) {
    fixes.push("- rerun the Codex install command to repair TokenPilot hook groups in `hooks.json`");
  }
  if (!report.mcpInstalled || !report.mcpStateDirMatches || !report.mcpCommandMatches || !report.mcpArgsMatch) {
    fixes.push("- rerun the Codex install command to refresh the recovery MCP entry in `config.toml`");
  }
  if (report.mcpInstalled && !report.mcpStartupTimeoutSecMatches) {
    fixes.push("- rerun the Codex install command or set `startup_timeout_sec` on `tokenpilot_memory_fault_recover` to the expected value");
  }
  if (report.adapterEnabled && (!report.daemonRunning || !report.proxyHealthy)) {
    fixes.push("- trust the TokenPilot hooks in Codex, then start a new session so SessionStart can boot the local proxy");
    fixes.push("- if the proxy is still unhealthy after a new session starts, run `tokenpilot-codex start` or `tokenpilot-codex restart`");
  }
  if (taskStateEstimator.status === "incomplete") {
    fixes.push(
      `- configure taskStateEstimator ${taskStateEstimator.missingFields.length > 0 ? taskStateEstimator.missingFields.join(", ") : "settings"}; estimator runtime remains disabled until the configuration is ready`,
    );
  }
  if (report.degradedMode) {
    lines.push(
      "",
      "Degraded mode:",
      "- stable-prefix rewriting and reduction remain available",
      "- real `memory_fault_recover` MCP recovery is currently unavailable or drifted",
    );
  }
  if (fixes.length > 0) {
    lines.push("", "Suggested fixes:");
    lines.push(...fixes);
  }
  return lines.join("\n");
}

export async function inspectCodexDoctor(params: {
  config: TokenPilotCodexConfig;
  configPath: string;
  tokenPilotConfigPath: string;
  hooksConfigPath: string;
}): Promise<CodexDoctorReport> {
  const daemon = await readDaemonStatus(params.config);
  const proxyBaseUrl = `http://127.0.0.1:${params.config.proxyPort}/v1`;
  const providerName = params.config.providerName || "tokenpilot";
  const expectedHookCommand = await resolveCodexHookCommandForInstall();
  const expectedMcpSpec = resolveCodexMcpServerSpecForInstall(params.config.stateDir);
  const tokenpilotProvider = await readCodexProviderFromToml(providerName, params.configPath);
  const rootProvider = await readCodexRootModelProvider(params.configPath);
  const mcp = await readCodexMcpServerFromToml(TOKENPILOT_MCP_SERVER_NAME, params.configPath);
  let hooksRoot: Record<string, unknown> = {};
  if (existsSync(params.hooksConfigPath)) {
    hooksRoot = JSON.parse(await readFile(params.hooksConfigPath, "utf8").catch(() => "{}")) as Record<string, unknown>;
  }
  const {
    installedHookEvents,
    missingHookEvents,
    hooksComplete,
    hooksInstalled,
    hooksMatchExpectedCommand,
  } = scanInstalledHookEvents({
    hooksRoot: asObjectRecord(hooksRoot),
    hookEventNames: HOOK_EVENT_NAMES,
    isTokenPilotCommand(command) {
      return command.includes("hooks-handler.js") || command.includes("tokenpilot-codex-hook.cmd");
    },
    expectedCommand: expectedHookCommand,
  });
  const proxyHealthy = await checkHealth(proxyBaseUrl);
  const providerIntercepted = tokenpilotProvider?.baseUrl === proxyBaseUrl;
  const fallbackUpstreamBaseUrl = params.config.upstreamProvider
    ? (await readCodexProviderFromToml(params.config.upstreamProvider, params.configPath))?.baseUrl
    : undefined;
  const upstreamBaseUrl = params.config.upstream?.baseUrl
    ?? (providerIntercepted ? undefined : fallbackUpstreamBaseUrl);
  const upstreamLoopDetected = Boolean(normalizeLocalProxyBaseUrl(upstreamBaseUrl));
  const mcpHealth = inspectTokenPilotMcpHealth({
    observed: mcp,
    expected: expectedMcpSpec,
    expectedStateDir: params.config.stateDir,
    expectedStartupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  });
  const capabilityJournal = await readCodexRebaseCapabilityJournal(params.config.stateDir);
  const rebaseCapabilityTrusted = !capabilityJournal.readError
    && capabilityJournal.malformedLineCount === 0;
  const rebaseCapabilityStatus = rebaseCapabilityTrusted
    ? capabilityJournal.capabilities.map((entry) => formatCodexRebaseCapabilityStatus(entry)).sort()
    : [];
  const rebaseCapabilityIssue = capabilityJournal.readError
    ?? (capabilityJournal.malformedLineCount > 0
      ? `${capabilityJournal.malformedLineCount} malformed row(s)`
      : undefined);
  const coreRuntimeHealthy = params.config.enabled
    && Boolean(tokenpilotProvider)
    && providerIntercepted
    && daemon.running
    && proxyHealthy;
  const recoveryMcpHealthy = mcpHealth.healthy;
  const taskStateEstimator = codexEstimatorDiagnostic(resolveCodexTaskStateEstimator({
    config: params.config.taskStateEstimator,
    env: process.env,
  }));
  const latestSessionId = await resolveLatestCodexSessionId(params.config.stateDir);
  const cleaner = latestSessionId
    ? await readCodexCleanerObservability({ stateDir: params.config.stateDir, sessionId: latestSessionId })
    : emptyCodexCleanerObservability();
  return {
    configPath: params.configPath,
    hooksConfigPath: params.hooksConfigPath,
    tokenPilotConfigPath: params.tokenPilotConfigPath,
    proxyBaseUrl,
    expectedHookCommand,
    expectedMcpCommand: expectedMcpSpec.command,
    expectedMcpArgs: expectedMcpSpec.args,
    adapterEnabled: params.config.enabled,
    providerInstalled: Boolean(tokenpilotProvider),
    providerActive: rootProvider === providerName,
    providerIntercepted,
    hooksInstalled,
    hooksComplete,
    hooksMatchExpectedCommand,
    installedHookEvents,
    missingHookEvents,
    daemonRunning: daemon.running,
    proxyHealthy,
    stateDir: params.config.stateDir,
    upstreamProvider: params.config.upstreamProvider,
    upstreamLoopDetected,
    upstreamBaseUrl: sanitizeDiagnosticUrl(upstreamBaseUrl),
    mcpInstalled: mcpHealth.installed,
    mcpStateDirMatches: mcpHealth.stateDirMatches,
    mcpCommandMatches: mcpHealth.commandMatches,
    mcpArgsMatch: mcpHealth.argsMatch,
    mcpStartupTimeoutSecMatches: mcpHealth.startupTimeoutSecMatches,
    expectedMcpStartupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
    coreRuntimeHealthy,
    recoveryMcpHealthy,
    degradedMode: coreRuntimeHealthy && !recoveryMcpHealthy,
    rebaseCapabilityStatus,
    rebaseCapabilityTrusted,
    rebaseCapabilityIssue,
    taskStateEstimator,
    cleaner,
  };
}
