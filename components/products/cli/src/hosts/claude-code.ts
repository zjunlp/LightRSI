import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ProductSurfaceConfigAdapter,
  ProductSurfaceHostBridge,
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@lightrsi/host-adapter";
import {
  getNestedValue,
  formatDisplayValue,
  formatOnOff,
} from "@lightrsi/product-surface";
import {
  defaultClaudeCodeMcpConfigPath,
  defaultClaudeCodeSettingsPath,
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
  normalizeTokenPilotClaudeCodeConfig,
  writeTokenPilotClaudeCodeConfig,
} from "../../../../adapters/claude-code/src/config.js";
import {
  inspectClaudeCodeDoctor,
  formatClaudeCodeDoctorReport,
} from "../../../../adapters/claude-code/src/doctor.js";
import {
  claudeCodeProductSurfaceConfigAdapter,
  resolveClaudeCodeStateDir,
} from "../../../../adapters/claude-code/src/host-config-adapter.js";
import { resolveLatestClaudeCodeSessionId } from "../../../../adapters/claude-code/src/session-state.js";
import {
  readRecentClaudeCodeCacheAuditRecordsForSession,
} from "../../../../adapters/claude-code/src/cache-audit.js";
import { createClaudeCodeContextCleanerBridge } from "../../../../adapters/claude-code/src/context-cleaner/index.js";
import {
  applyStandardRuntimeModeConfig,
  buildSessionReportResult,
  createRestrictedHostCommandHandler,
  resolveConfiguredPreferredSessionId,
  resolvePreferredSessionId,
} from "./shared.js";
import { handleStandaloneVisualCommandWithSelection } from "./visual.js";
import type { CliHostPathOverrides } from "../context-store.js";
import type { CleanCommandBackend } from "../clean.js";
import { createHostCleanCommandBackend } from "./cleaner.js";

const CLAUDE_REDUCTION_PASS_NAMES = [
  "readStateCompaction",
  "toolPayloadTrim",
  "htmlSlimming",
  "execOutputTruncation",
  "agentsStartupOptimization",
] as const;

function resolveClaudeCodePaths(pathOverrides?: CliHostPathOverrides): {
  tokenPilotConfigPath: string;
  settingsPath: string;
  mcpConfigPath: string;
} {
  return {
    tokenPilotConfigPath: pathOverrides?.tokenPilotConfigPath?.trim() || defaultTokenPilotClaudeCodeConfigPath(),
    settingsPath: pathOverrides?.hostConfigPath?.trim() || defaultClaudeCodeSettingsPath(),
    mcpConfigPath: pathOverrides?.hostAuxConfigPath?.trim() || defaultClaudeCodeMcpConfigPath(),
  };
}

async function loadConfig(pathOverrides?: CliHostPathOverrides): Promise<Record<string, unknown>> {
  return loadTokenPilotClaudeCodeConfig(resolveClaudeCodePaths(pathOverrides).tokenPilotConfigPath) as unknown as Record<string, unknown>;
}

export async function createClaudeCodeCleanCommandBackend(
  pathOverrides?: CliHostPathOverrides,
): Promise<CleanCommandBackend | undefined> {
  const config = await loadTokenPilotClaudeCodeConfig(
    resolveClaudeCodePaths(pathOverrides).tokenPilotConfigPath,
  );
  const stateDir = resolveClaudeCodeStateDir(config as unknown as Record<string, unknown>);
  if (!stateDir) return undefined;
  return createHostCleanCommandBackend({
    stateDir,
    recommendationEnabled: config.taskStateEstimator.enabled,
    recommendationConfig: {
      baseUrl: config.taskStateEstimator.baseUrl,
      apiKey: config.taskStateEstimator.apiKey,
      model: config.taskStateEstimator.model,
      requestTimeoutMs: config.taskStateEstimator.requestTimeoutMs,
    },
    createBridge(controlPlane) {
      return createClaudeCodeContextCleanerBridge({ stateDir, controlPlane });
    },
  });
}

async function writeConfig(nextConfig: Record<string, unknown>, pathOverrides?: CliHostPathOverrides): Promise<void> {
  const { tokenPilotConfigPath } = resolveClaudeCodePaths(pathOverrides);
  await mkdir(dirname(tokenPilotConfigPath), { recursive: true });
  await writeTokenPilotClaudeCodeConfig(
    normalizeTokenPilotClaudeCodeConfig(nextConfig, { configPath: tokenPilotConfigPath }),
    tokenPilotConfigPath,
  );
}

async function maybeResolveLatestSessionId(pathOverrides?: CliHostPathOverrides): Promise<string | undefined> {
  return resolveConfiguredPreferredSessionId({
    loadConfig() {
      return loadConfig(pathOverrides);
    },
    resolveStateDir: resolveClaudeCodeStateDir,
    resolveLatestSessionId: resolveLatestClaudeCodeSessionId,
    readLatestUxEffect,
  });
}

function formatClaudeCodeStatus(currentConfig: Record<string, unknown>): string {
  return [
    "TokenPilot Claude Code status:",
    `- enabled: ${formatOnOff(currentConfig.enabled)}`,
    `- stabilizer: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
    `- reduction: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- eviction: ${formatOnOff(Boolean(getNestedValue(currentConfig, ["modules", "eviction"])) && Boolean(getNestedValue(currentConfig, ["eviction", "enabled"])))}`,
    `- evictionMinBlockChars: ${formatDisplayValue(getNestedValue(currentConfig, ["eviction", "minBlockChars"]))}`,
    `- proxyPort: ${formatDisplayValue(currentConfig.proxyPort)}`,
    `- upstreamBaseUrl: ${formatDisplayValue(currentConfig.upstreamBaseUrl)}`,
  ].join("\n");
}

export function createClaudeCodeCliBridge(target: {
  host: "claude-code";
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
}): {
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
} {
  const paths = resolveClaudeCodePaths(target.pathOverrides);
  const bridge: ProductSurfaceHostBridge = {
    loadConfig() {
      return loadConfig(target.pathOverrides);
    },
    writeConfig(nextConfig) {
      return writeConfig(nextConfig, target.pathOverrides);
    },
    async handleDoctor(currentConfig) {
      const config = currentConfig as any;
      const report = await inspectClaudeCodeDoctor({
        config,
        settingsPath: paths.settingsPath,
        tokenPilotConfigPath: paths.tokenPilotConfigPath,
        mcpConfigPath: paths.mcpConfigPath,
      });
      return {
        text: formatClaudeCodeDoctorReport(report),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveClaudeCodeStateDir(currentConfig);
      if (!stateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      const sessionId = await resolvePreferredSessionId({
        explicitSessionId: target.sessionId,
        stateDir,
        resolveLatestSessionId: resolveLatestClaudeCodeSessionId,
        readLatestUxEffect,
      });
      return handleStandaloneVisualCommandWithSelection({
        host: "claude-code",
        sessionId,
      });
    },
    async handleReport(_ctx, currentConfig) {
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: target.sessionId,
        configAdapter: claudeCodeProductSurfaceConfigAdapter,
        resolveLatestSessionId: resolveLatestClaudeCodeSessionId,
        readLatestUxEffect,
        readSessionAggregate: readUxSessionAggregate,
        async readRecentCacheAuditRecords(stateDir, sessionId) {
          return readRecentClaudeCodeCacheAuditRecordsForSession(stateDir, sessionId, 64);
        },
      });
    },
  };

  const handleCommand = createRestrictedHostCommandHandler({
    displayName: "Claude Code",
    cliHostName: "claude-code",
    reductionPassNames: CLAUDE_REDUCTION_PASS_NAMES,
    supportsEviction: true,
    bridge,
    configAdapter: claudeCodeProductSurfaceConfigAdapter,
    loadConfig() {
      return loadConfig(target.pathOverrides);
    },
    formatStatus: formatClaudeCodeStatus,
    async applyMode(mode) {
      const current = await loadConfig(target.pathOverrides);
      await writeConfig(applyStandardRuntimeModeConfig(current, mode), target.pathOverrides);
    },
  });

  return {
    bridge,
    configAdapter: claudeCodeProductSurfaceConfigAdapter,
    maybeResolveLatestSessionId() {
      return maybeResolveLatestSessionId(target.pathOverrides);
    },
    async resolveSessionId(sessionId?: string): Promise<string | undefined> {
      const text = typeof sessionId === "string" ? sessionId.trim() : "";
      return text || undefined;
    },
    handleCommand,
  };
}
