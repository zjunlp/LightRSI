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
  defaultCodexConfigPath,
  defaultHooksConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
  normalizeTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "../../../../adapters/codex/src/config.js";
import { inspectCodexDoctor, formatCodexDoctorReport } from "../../../../adapters/codex/src/doctor.js";
import {
  codexProductSurfaceConfigAdapter,
  resolveCodexStateDir,
} from "../../../../adapters/codex/src/host-config-adapter.js";
import {
  resolveCanonicalCodexSessionId,
  resolveLatestCodexSessionId,
} from "../../../../adapters/codex/src/session-state.js";
import {
  readRecentCodexCacheAuditRecordsForSession,
} from "../../../../adapters/codex/src/cache-audit.js";
import { createCodexContextCleanerBridge } from "../../../../adapters/codex/src/context-cleaner/index.js";
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

const CODEX_REDUCTION_PASS_NAMES = [
  "readStateCompaction",
  "toolPayloadTrim",
  "htmlSlimming",
  "execOutputTruncation",
  "agentsStartupOptimization",
] as const;

function resolveCodexPaths(pathOverrides?: CliHostPathOverrides): {
  tokenPilotConfigPath: string;
  codexConfigPath: string;
  hooksConfigPath: string;
} {
  return {
    tokenPilotConfigPath: pathOverrides?.tokenPilotConfigPath?.trim() || defaultTokenPilotConfigPath(),
    codexConfigPath: pathOverrides?.hostConfigPath?.trim() || process.env.CODEX_CONFIG_PATH?.trim() || defaultCodexConfigPath(),
    hooksConfigPath: pathOverrides?.hostAuxConfigPath?.trim() || defaultHooksConfigPath(),
  };
}

async function loadConfig(pathOverrides?: CliHostPathOverrides): Promise<Record<string, unknown>> {
  return loadTokenPilotCodexConfig(resolveCodexPaths(pathOverrides).tokenPilotConfigPath) as unknown as Record<string, unknown>;
}

export async function createCodexCleanCommandBackend(
  pathOverrides?: CliHostPathOverrides,
): Promise<CleanCommandBackend | undefined> {
  const config = await loadTokenPilotCodexConfig(resolveCodexPaths(pathOverrides).tokenPilotConfigPath);
  const stateDir = resolveCodexStateDir(config as unknown as Record<string, unknown>);
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
      return createCodexContextCleanerBridge({ stateDir, controlPlane });
    },
  });
}

async function writeConfig(nextConfig: Record<string, unknown>, pathOverrides?: CliHostPathOverrides): Promise<void> {
  const { tokenPilotConfigPath } = resolveCodexPaths(pathOverrides);
  await mkdir(dirname(tokenPilotConfigPath), { recursive: true });
  await writeTokenPilotCodexConfig(
    normalizeTokenPilotCodexConfig(nextConfig, { configPath: tokenPilotConfigPath }),
    tokenPilotConfigPath,
  );
}

async function maybeResolveLatestSessionId(pathOverrides?: CliHostPathOverrides): Promise<string | undefined> {
  return resolveConfiguredPreferredSessionId({
    loadConfig() {
      return loadConfig(pathOverrides);
    },
    resolveStateDir: resolveCodexStateDir,
    resolveLatestSessionId: resolveLatestCodexSessionId,
    readLatestUxEffect,
  });
}

async function resolveCodexCliSessionId(params: {
  currentConfig: Record<string, unknown>;
  explicitSessionId?: string;
}): Promise<string | undefined> {
  const stateDir = resolveCodexStateDir(params.currentConfig);
  if (!stateDir) return undefined;
  const explicit = typeof params.explicitSessionId === "string" ? params.explicitSessionId.trim() : "";
  if (explicit) {
    return resolveCanonicalCodexSessionId(stateDir, explicit);
  }
  return resolvePreferredSessionId({
    stateDir,
    resolveLatestSessionId: resolveLatestCodexSessionId,
    readLatestUxEffect,
  });
}

function formatCodexStatus(currentConfig: Record<string, unknown>): string {
  return [
    "TokenPilot Codex status:",
    `- enabled: ${formatOnOff(currentConfig.enabled)}`,
    `- stabilizer: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
    `- reduction: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- proxyPort: ${formatDisplayValue(currentConfig.proxyPort)}`,
    `- upstreamProvider: ${formatDisplayValue(currentConfig.upstreamProvider)}`,
  ].join("\n");
}

export function createCodexCliBridge(target: {
  host: "codex";
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
  handleVisualCommand?(params: {
    host?: string;
    sessionId?: string;
  }): Promise<{ text: string }>;
}): {
  bridge: ProductSurfaceHostBridge;
  configAdapter: ProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  resolveSessionId(sessionId?: string): Promise<string | undefined>;
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
} {
  const paths = resolveCodexPaths(target.pathOverrides);
  const bridge: ProductSurfaceHostBridge = {
    loadConfig() {
      return loadConfig(target.pathOverrides);
    },
    writeConfig(nextConfig) {
      return writeConfig(nextConfig, target.pathOverrides);
    },
    async handleDoctor(currentConfig) {
      const config = currentConfig as any;
      const report = await inspectCodexDoctor({
        config,
        configPath: paths.codexConfigPath,
        tokenPilotConfigPath: paths.tokenPilotConfigPath,
        hooksConfigPath: paths.hooksConfigPath,
      });
      return {
        text: formatCodexDoctorReport(report),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveCodexStateDir(currentConfig);
      if (!stateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      const sessionId = await resolveCodexCliSessionId({
        currentConfig,
        explicitSessionId: target.sessionId,
      });
      return (target.handleVisualCommand ?? handleStandaloneVisualCommandWithSelection)({
        host: "codex",
        sessionId,
      });
    },
    async handleReport(_ctx, currentConfig) {
      const sessionId = await resolveCodexCliSessionId({
        currentConfig,
        explicitSessionId: target.sessionId,
      });
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: sessionId,
        configAdapter: codexProductSurfaceConfigAdapter,
        resolveLatestSessionId: resolveLatestCodexSessionId,
        readLatestUxEffect,
        readSessionAggregate: readUxSessionAggregate,
        async readRecentCacheAuditRecords(stateDir, sessionId) {
          return readRecentCodexCacheAuditRecordsForSession(stateDir, sessionId, 64);
        },
      });
    },
  };

  const handleCommand = createRestrictedHostCommandHandler({
    displayName: "Codex",
    cliHostName: "codex",
    reductionPassNames: CODEX_REDUCTION_PASS_NAMES,
    bridge,
    configAdapter: codexProductSurfaceConfigAdapter,
    loadConfig() {
      return loadConfig(target.pathOverrides);
    },
    formatStatus: formatCodexStatus,
    async applyMode(mode) {
      const current = await loadConfig(target.pathOverrides);
      await writeConfig(applyStandardRuntimeModeConfig(current, mode), target.pathOverrides);
    },
  });

  return {
    bridge,
    configAdapter: codexProductSurfaceConfigAdapter,
    maybeResolveLatestSessionId() {
      return maybeResolveLatestSessionId(target.pathOverrides);
    },
    async resolveSessionId(sessionId?: string): Promise<string | undefined> {
      return resolveCodexCliSessionId({
        currentConfig: await loadConfig(target.pathOverrides),
        explicitSessionId: sessionId,
      });
    },
    handleCommand,
  };
}
