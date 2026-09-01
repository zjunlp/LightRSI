import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  inspectTokenPilotMcpHealth,
  TOKENPILOT_MCP_SERVER_NAME,
  type TokenPilotObservedMcpConfig,
  inspectClaudeMcpServerConfig,
  listClaudeMcpConfigCandidates,
} from "../../../products/mcp/src/index.js";
import {
  asObjectRecord,
  scanInstalledHookEvents,
} from "../../shared/doctor-shared.js";
import {
  CLAUDE_TOOL_SEARCH_DEFAULT,
  CLAUDE_TOOL_SEARCH_ENV,
  proxyBaseUrlForPort,
  type TokenPilotClaudeCodeConfig,
} from "./config.js";
import { resolveClaudeCodeHookCommandForInstall } from "./install.js";
import { resolveClaudeCodeMcpServerSpecForInstall } from "./install.js";
import { inspectClaudeTaskStateEstimatorConfig } from "./context-rewrite/estimator-config.js";
import {
  emptyClaudeCleanerObservability,
  readClaudeCleanerObservability,
  type ClaudeCleanerObservability,
} from "./context-cleaner/observability.js";
import { resolveLatestClaudeCodeSessionId } from "./session-state.js";

export type ClaudeCodeDoctorReport = {
  settingsPath: string;
  tokenPilotConfigPath: string;
  stateDir: string;
  proxyBaseUrl: string;
  mcpConfigPath: string;
  expectedHookCommand: string;
  expectedMcpCommand: string;
  expectedMcpArgs: string[];
  settingsInstalled: boolean;
  hooksInstalled: boolean;
  hooksComplete: boolean;
  hooksMatchExpectedCommand: boolean;
  installedHookEvents: string[];
  missingHookEvents: string[];
  routedViaGateway: boolean;
  overlayBackendMode: string;
  overlayEvictionEnabled: boolean;
  overlayEvictionFailureMode: string;
  overlayPlanStoreStatus: string;
  overlaySessionBinding: string;
  overlayTaskStateEstimatorEnabled: boolean;
  overlayTaskStateEstimatorConfigured: boolean;
  toolSearchEnabled: boolean;
  proxyHealthy: boolean;
  upstreamBaseUrl: string;
  mcpInstalled: boolean;
  mcpStateDirMatches: boolean;
  mcpCommandMatches: boolean;
  mcpArgsMatch: boolean;
  mcpStartupTimeoutSecMatches: boolean;
  expectedMcpStartupTimeoutSec: number;
  stateDirExists: boolean;
  sessionStateAvailable: boolean;
  uxEffectsAvailable: boolean;
  coreRuntimeHealthy: boolean;
  recoveryMcpHealthy: boolean;
  degradedMode: boolean;
  cleaner?: ClaudeCleanerObservability;
};

const HOOK_EVENT_NAMES = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

function remediationLines(report: ClaudeCodeDoctorReport): string[] {
  const fixes: string[] = [];
  if (!report.settingsInstalled) {
    fixes.push("- run `pnpm --filter @lightrsi/claude-code-adapter install:claude-code` to create Claude settings and gateway routing");
    return fixes;
  }
  if (!report.routedViaGateway || !report.toolSearchEnabled) {
    fixes.push("- rerun the Claude Code install command to refresh gateway env and tool-search settings");
  }
  if (!report.hooksInstalled || !report.hooksComplete || !report.hooksMatchExpectedCommand) {
    fixes.push("- rerun the Claude Code install command to repair TokenPilot hook entries in `settings.json`");
  }
  if (!report.mcpInstalled || !report.mcpStateDirMatches || !report.mcpCommandMatches || !report.mcpArgsMatch) {
    fixes.push("- rerun the Claude Code install command to refresh the recovery MCP server entry in `.claude.json`");
  }
  if (report.mcpInstalled && !report.mcpStartupTimeoutSecMatches) {
    fixes.push("- rerun the Claude Code install command or set the recovery MCP `startup_timeout_sec` to the expected value");
  }
  if (report.settingsInstalled && fixes.length === 0 && !report.proxyHealthy) {
    fixes.push("- start a new Claude Code session so SessionStart can boot the local TokenPilot gateway");
    fixes.push("- if the gateway is still unhealthy after a new session starts, run `tokenpilot-claude-code start` or `tokenpilot-claude-code restart`");
  }
  return fixes;
}

export function formatClaudeCodeDoctorReport(report: ClaudeCodeDoctorReport): string {
  const cleaner = report.cleaner ?? emptyClaudeCleanerObservability();
  const lines = [
    "TokenPilot Claude Code doctor:",
    `- tokenpilot config: ${report.tokenPilotConfigPath}`,
    `- claude settings: ${report.settingsPath}`,
    `- mcp config: ${report.mcpConfigPath}`,
    `- stateDir: ${report.stateDir}`,
    `- expected hook command: ${report.expectedHookCommand}`,
    `- expected MCP command: ${report.expectedMcpCommand}`,
    `- expected MCP args: ${report.expectedMcpArgs.length > 0 ? report.expectedMcpArgs.join(" ") : "(none)"}`,
    `- expected MCP startup timeout: ${report.expectedMcpStartupTimeoutSec}s`,
    `- core runtime healthy: ${report.coreRuntimeHealthy ? "yes" : "no"}`,
    `- recovery MCP healthy: ${report.recoveryMcpHealthy ? "yes" : "no"}`,
    `- degraded mode: ${report.degradedMode ? "yes" : "no"}`,
    `- settings installed: ${report.settingsInstalled ? "yes" : "no"}`,
    `- observability hooks installed: ${report.hooksInstalled ? "yes" : "no"}`,
    `- observability hooks complete: ${report.hooksComplete ? "yes" : "no"}`,
    `- observability hooks match expected command: ${report.hooksMatchExpectedCommand ? "yes" : "no"}`,
    `- installed hook events: ${report.installedHookEvents.length > 0 ? report.installedHookEvents.join(", ") : "(none)"}`,
    `- missing hook events: ${report.missingHookEvents.length > 0 ? report.missingHookEvents.join(", ") : "(none)"}`,
    `- recovery MCP installed: ${report.mcpInstalled ? "yes" : "no"}`,
    `- recovery MCP stateDir matches: ${report.mcpStateDirMatches ? "yes" : "no"}`,
    `- recovery MCP command matches: ${report.mcpCommandMatches ? "yes" : "no"}`,
    `- recovery MCP args match: ${report.mcpArgsMatch ? "yes" : "no"}`,
    `- recovery MCP startup timeout matches: ${report.mcpStartupTimeoutSecMatches ? "yes" : "no"}`,
    `- routed via gateway: ${report.routedViaGateway ? "yes" : "no"}`,
    `- overlay backend mode: ${report.overlayBackendMode}`,
    `- overlay plan store: ${report.overlayPlanStoreStatus}`,
    `- overlay session binding: ${report.overlaySessionBinding}`,
    `- overlay eviction enabled: ${report.overlayEvictionEnabled ? "yes" : "no"}`,
    `- overlay eviction failure mode: ${report.overlayEvictionFailureMode}`,
    `- task-state estimator enabled: ${report.overlayTaskStateEstimatorEnabled ? "yes" : "no"}`,
    `- task-state estimator configured: ${report.overlayTaskStateEstimatorConfigured ? "yes" : "no"}`,
    `- tool search enabled: ${report.toolSearchEnabled ? "yes" : "no"}`,
    `- proxy healthy: ${report.proxyHealthy ? "yes" : "no"}`,
    `- proxy base URL: ${report.proxyBaseUrl}`,
    `- upstream base URL: ${report.upstreamBaseUrl}`,
    `- state dir exists: ${report.stateDirExists ? "yes" : "no"}`,
    `- session state available: ${report.sessionStateAvailable ? "yes" : "no"}`,
    `- ux effects available: ${report.uxEffectsAvailable ? "yes" : "no"}`,
    `- Cleaner capability: ${cleaner.availability}`,
    `- Cleaner plan store: ${cleaner.planStore}`,
    `- Cleaner pending plan: ${cleaner.pendingPlan}`,
    `- Cleaner last receipt: ${cleaner.lastReceipt}`,
    `- Cleaner rewrite mode: ${cleaner.rewriteMode}`,
  ];
  if (report.degradedMode) {
    lines.push(
      "",
      "Degraded mode:",
      "- Claude Code gateway routing and reduction remain available",
      "- real `memory_fault_recover` MCP recovery is currently unavailable or drifted",
    );
  }
  const fixes = remediationLines(report);
  if (fixes.length > 0) {
    lines.push("", "Suggested fixes:");
    lines.push(...fixes);
  }
  return lines.join("\n");
}

export async function inspectClaudeCodeDoctor(params: {
  config: TokenPilotClaudeCodeConfig;
  settingsPath: string;
  tokenPilotConfigPath: string;
  mcpConfigPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeCodeDoctorReport> {
  const proxyBaseUrl = proxyBaseUrlForPort(params.config.proxyPort);
  const expectedHookCommand = resolveClaudeCodeHookCommandForInstall();
  const expectedMcpSpec = resolveClaudeCodeMcpServerSpecForInstall(params.config.stateDir);
  const latestSessionId = await resolveLatestClaudeCodeSessionId(params.config.stateDir);
  const cleaner = latestSessionId
    ? await readClaudeCleanerObservability({ stateDir: params.config.stateDir, sessionId: latestSessionId })
    : emptyClaudeCleanerObservability();
  let settingsInstalled = false;
  let routedViaGateway = false;
  let toolSearchEnabled = false;
  let mcpConfigPath = params.mcpConfigPath;
  let mcpInstalled = false;
  let mcpStateDirMatches = false;
  let mcpCommandMatches = false;
  let mcpArgsMatch = false;
  let mcpStartupTimeoutSecMatches = false;
  let observedMcp: TokenPilotObservedMcpConfig | undefined;

  if (existsSync(params.settingsPath)) {
    settingsInstalled = true;
    try {
      const root = JSON.parse(await readFile(params.settingsPath, "utf8"));
      const rootRecord = asObjectRecord(root);
      const env = asObjectRecord(rootRecord.env);
      routedViaGateway = env.ANTHROPIC_BASE_URL === proxyBaseUrl;
      toolSearchEnabled = env[CLAUDE_TOOL_SEARCH_ENV] === CLAUDE_TOOL_SEARCH_DEFAULT;
    } catch {
      settingsInstalled = true;
    }
  }

  let hookScan = {
    installedHookEvents: [] as string[],
    missingHookEvents: [...HOOK_EVENT_NAMES] as string[],
    hooksInstalled: false,
    hooksComplete: false,
    hooksMatchExpectedCommand: false,
  };

  if (existsSync(params.settingsPath)) {
    try {
      const root = JSON.parse(await readFile(params.settingsPath, "utf8"));
      hookScan = scanInstalledHookEvents({
        hooksRoot: asObjectRecord(root),
        hookEventNames: HOOK_EVENT_NAMES,
        isTokenPilotCommand(command) {
          return command.includes("hooks-handler.");
        },
        expectedCommand: expectedHookCommand,
      });
    } catch {
      // keep default hook scan result
    }
  }

  for (const candidate of await listClaudeMcpConfigCandidates(params.mcpConfigPath)) {
    const inspected = await inspectClaudeMcpServerConfig(candidate, TOKENPILOT_MCP_SERVER_NAME);
    if (inspected.installed) {
      observedMcp = inspected;
      mcpInstalled = true;
      mcpConfigPath = candidate;
      mcpStateDirMatches = inspected.env?.TOKENPILOT_STATE_DIR === params.config.stateDir;
      mcpCommandMatches = inspected.command === expectedMcpSpec.command;
      mcpArgsMatch =
        Array.isArray(inspected.args)
        && inspected.args.length === expectedMcpSpec.args.length
        && inspected.args.every((value, index) => value === expectedMcpSpec.args[index]);
      mcpStartupTimeoutSecMatches = inspected.startupTimeoutSec === DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC;
      break;
    }
  }

  const stateDirExists = existsSync(params.config.stateDir);
  const sessionStateAvailable = existsSync(join(params.config.stateDir, "session-state", "latest.json"));
  const uxEffectsAvailable = existsSync(join(params.config.stateDir, "ux-effects", "latest.json"));
  const proxyHealthy = await checkHealth(proxyBaseUrl);
  const coreRuntimeHealthy = routedViaGateway && toolSearchEnabled && proxyHealthy;
  const mcpHealth = inspectTokenPilotMcpHealth({
    observed: observedMcp,
    expected: expectedMcpSpec,
    expectedStateDir: params.config.stateDir,
    expectedStartupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  });
  mcpInstalled = mcpHealth.installed;
  mcpStateDirMatches = mcpHealth.stateDirMatches;
  mcpCommandMatches = mcpHealth.commandMatches;
  mcpArgsMatch = mcpHealth.argsMatch;
  mcpStartupTimeoutSecMatches = mcpHealth.startupTimeoutSecMatches;
  const recoveryMcpHealthy = mcpHealth.healthy;
  const estimatorStatus = inspectClaudeTaskStateEstimatorConfig({
    config: params.config.taskStateEstimator,
    env: params.env ?? process.env,
  });

  return {
    overlayBackendMode: "request_overlay",
    overlayEvictionEnabled: params.config.modules.eviction && params.config.eviction.enabled,
    overlayEvictionFailureMode: params.config.eviction.failureMode,
    overlayPlanStoreStatus: "persistent",
    overlaySessionBinding: "persisted",
    overlayTaskStateEstimatorEnabled: estimatorStatus.enabled,
    overlayTaskStateEstimatorConfigured: estimatorStatus.configured,
    settingsPath: params.settingsPath,
    mcpConfigPath,
    tokenPilotConfigPath: params.tokenPilotConfigPath,
    stateDir: params.config.stateDir,
    proxyBaseUrl,
    expectedHookCommand,
    expectedMcpCommand: expectedMcpSpec.command,
    expectedMcpArgs: expectedMcpSpec.args,
    settingsInstalled,
    hooksInstalled: hookScan.hooksInstalled,
    hooksComplete: hookScan.hooksComplete,
    hooksMatchExpectedCommand: hookScan.hooksMatchExpectedCommand,
    installedHookEvents: hookScan.installedHookEvents,
    missingHookEvents: hookScan.missingHookEvents,
    mcpInstalled,
    mcpStateDirMatches,
    mcpCommandMatches,
    mcpArgsMatch,
    mcpStartupTimeoutSecMatches,
    expectedMcpStartupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
    routedViaGateway,
    toolSearchEnabled,
    proxyHealthy,
    upstreamBaseUrl: params.config.upstreamBaseUrl,
    stateDirExists,
    sessionStateAvailable,
    uxEffectsAvailable,
    coreRuntimeHealthy,
    recoveryMcpHealthy,
    degradedMode: coreRuntimeHealthy && !recoveryMcpHealthy,
    cleaner,
  };
}
