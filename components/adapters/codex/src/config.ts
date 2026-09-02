import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TaskStateEstimatorApiConfig } from "@lightrsi/eviction";
import type { CodexContextRewriteConfig, CodexMutationPlan } from "./context-rewrite/types.js";

export type CodexProviderConfig = {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  wireApi?: "responses" | "chat";
  requiresOpenAIAuth?: boolean;
};

export type TokenPilotCodexConfig = {
  enabled: boolean;
  logLevel: "info" | "debug";
  stateDir: string;
  proxyPort: number;
  providerName: string;
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  upstreamProvider?: string;
  upstream?: CodexProviderConfig;
  proxyMode: {
    pureForward: boolean;
  };
  hooks: {
    dynamicContextTarget: "developer" | "user";
  };
  modules: {
    stabilizer: boolean;
    reduction: boolean;
  };
  taskStateEstimator: TaskStateEstimatorApiConfig;
  contextRewrite: CodexContextRewriteConfig & {
    // Test/smoke override only. Production rewrite planning must derive this at runtime.
    mutationPlan?: CodexMutationPlan;
  };
  reduction: {
    triggerMinChars: number;
    maxToolChars: number;
    passes: {
      readStateCompaction: boolean;
      toolPayloadTrim: boolean;
      htmlSlimming: boolean;
      execOutputTruncation: boolean;
      agentsStartupOptimization: boolean;
    };
    passOptions: Record<string, Record<string, unknown>>;
  };
};

type NormalizeCodexConfigOptions = {
  configPath?: string;
};

function runtimeHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function expandHomePath(value: string): string {
  if (value === "~") return runtimeHomeDir();
  if (value.startsWith("~/")) return join(runtimeHomeDir(), value.slice(2));
  return value;
}

export function defaultCodexConfigPath(): string {
  return join(runtimeHomeDir(), ".codex", "config.toml");
}

export function defaultTokenPilotConfigPath(): string {
  return process.env.TOKENPILOT_CODEX_CONFIG
    ? resolve(process.env.TOKENPILOT_CODEX_CONFIG)
    : join(runtimeHomeDir(), ".codex", "tokenpilot.json");
}

export function defaultStateDir(configPath = defaultTokenPilotConfigPath()): string {
  return join(dirname(configPath), "tokenpilot-state", "tokenpilot");
}

export function defaultHooksConfigPath(): string {
  return process.env.CODEX_HOOKS_CONFIG_PATH
    ? resolve(process.env.CODEX_HOOKS_CONFIG_PATH)
    : join(runtimeHomeDir(), ".codex", "hooks.json");
}

export function resolvedCodexConfigPath(): string {
  return process.env.CODEX_CONFIG_PATH
    ? resolve(process.env.CODEX_CONFIG_PATH)
    : defaultCodexConfigPath();
}

export type CodexMcpServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutSec?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(next)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumberValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  return value === undefined ? undefined : numberValue(value, fallback, min, max);
}

function sanitizeCodexReductionPassOptions(raw: unknown): Record<string, Record<string, unknown>> {
  const input = asRecord(raw);
  const output: Record<string, Record<string, unknown>> = {};
  for (const key of [
    "readStateCompaction",
    "toolPayloadTrim",
    "htmlSlimming",
    "execOutputTruncation",
    "agentsStartupOptimization",
  ]) {
    const value = asRecord(input[key]);
    if (Object.keys(value).length > 0) {
      output[key] = value as Record<string, unknown>;
    }
  }
  return output;
}

function sanitizeCodexMutationPlan(raw: unknown): CodexMutationPlan | undefined {
  const input = asRecord(raw);
  if (!Array.isArray(input.operations)) return undefined;
  const operations = input.operations
    .filter((operation) => operation && typeof operation === "object" && !Array.isArray(operation))
    .map((operation) => {
      const next = operation as Record<string, unknown>;
      return {
        type: typeof next.type === "string" ? next.type : "",
        stableItemId: stringValue(next.stableItemId),
      };
    });
  return {
    baseRevision: stringValue(input.baseRevision),
    operations,
  };
}

export function normalizeTokenPilotCodexConfig(
  raw: unknown,
  options?: NormalizeCodexConfigOptions,
): TokenPilotCodexConfig {
  const obj = asRecord(raw);
  const proxyMode = asRecord(obj.proxyMode);
  const hooks = asRecord(obj.hooks);
  const modules = asRecord(obj.modules);
  const taskStateEstimator = asRecord(obj.taskStateEstimator);
  const contextRewrite = asRecord(obj.contextRewrite);
  const reduction = asRecord(obj.reduction);
  const passes = asRecord(reduction.passes);
  const upstream = asRecord(obj.upstream);
  const upstreamBaseUrl = stringValue(upstream.baseUrl);
  const configPath = options?.configPath ?? defaultTokenPilotConfigPath();

  return {
    enabled: boolValue(obj.enabled, true),
    logLevel: obj.logLevel === "debug" ? "debug" : "info",
    stateDir: expandHomePath(stringValue(obj.stateDir) ?? defaultStateDir(configPath)),
    proxyPort: numberValue(obj.proxyPort, 17667, 1025, 65535),
    providerName: stringValue(obj.providerName) ?? "tokenpilot",
    proxyBaseUrl: stringValue(obj.proxyBaseUrl),
    proxyApiKey: stringValue(obj.proxyApiKey),
    upstreamProvider: stringValue(obj.upstreamProvider) ?? "OpenAI",
    upstream: upstreamBaseUrl
      ? {
        name: stringValue(upstream.name),
        baseUrl: upstreamBaseUrl.replace(/\/+$/, ""),
        apiKey: stringValue(upstream.apiKey),
        wireApi: upstream.wireApi === "chat" ? "chat" : "responses",
        requiresOpenAIAuth: boolValue(upstream.requiresOpenAIAuth, true),
      }
      : undefined,
    proxyMode: {
      pureForward: boolValue(proxyMode.pureForward, false),
    },
    hooks: {
      dynamicContextTarget: hooks.dynamicContextTarget === "user" ? "user" : "developer",
    },
    modules: {
      stabilizer: boolValue(modules.stabilizer, true),
      reduction: boolValue(modules.reduction, true),
    },
    taskStateEstimator: {
      enabled: taskStateEstimator.enabled === undefined
        ? undefined
        : boolValue(taskStateEstimator.enabled, false),
      baseUrl: stringValue(taskStateEstimator.baseUrl)?.replace(/\/+$/, ""),
      apiKey: stringValue(taskStateEstimator.apiKey),
      model: stringValue(taskStateEstimator.model),
      requestTimeoutMs: optionalNumberValue(taskStateEstimator.requestTimeoutMs, 60_000, 1_000, 300_000),
      batchTurns: optionalNumberValue(taskStateEstimator.batchTurns, 5, 1, 100),
      evictionLookaheadTurns: optionalNumberValue(taskStateEstimator.evictionLookaheadTurns, 3, 1, 100),
      inputMode: taskStateEstimator.inputMode === undefined
        ? undefined
        : taskStateEstimator.inputMode === "completed_summary_plus_active_turns"
          ? "completed_summary_plus_active_turns"
          : "sliding_window",
      lifecycleMode: taskStateEstimator.lifecycleMode === undefined
        ? undefined
        : taskStateEstimator.lifecycleMode === "decoupled" ? "decoupled" : "coupled",
      evidenceMode: taskStateEstimator.evidenceMode === undefined
        ? undefined
        : taskStateEstimator.evidenceMode === "two_state" ? "two_state" : "three_state",
    },
    contextRewrite: {
      enabled: boolValue(contextRewrite.enabled, false),
      mode: "response_chain_rebase",
      failureMode: "bypass",
      retryOriginalRequest: boolValue(contextRewrite.retryOriginalRequest, true),
      cooldownMs: numberValue(contextRewrite.cooldownMs, 300_000, 0, 86_400_000),
      providerCompatibilityProbe: contextRewrite.providerCompatibilityProbe === "mock_fixture"
        || contextRewrite.providerCompatibilityProbe === "real_provider"
        ? contextRewrite.providerCompatibilityProbe
        : "real_provider",
      mutationPlan: sanitizeCodexMutationPlan(contextRewrite.mutationPlan),
    },
    reduction: {
      triggerMinChars: numberValue(reduction.triggerMinChars, 2200, 256, 1_000_000),
      maxToolChars: numberValue(reduction.maxToolChars, 1200, 256, 1_000_000),
      passes: {
        readStateCompaction: boolValue(passes.readStateCompaction, true),
        toolPayloadTrim: boolValue(passes.toolPayloadTrim, true),
        htmlSlimming: boolValue(passes.htmlSlimming, true),
        execOutputTruncation: boolValue(passes.execOutputTruncation, true),
        agentsStartupOptimization: boolValue(passes.agentsStartupOptimization, true),
      },
      passOptions: sanitizeCodexReductionPassOptions(reduction.passOptions),
    },
  };
}

export async function loadTokenPilotCodexConfig(configPath = defaultTokenPilotConfigPath()): Promise<TokenPilotCodexConfig> {
  if (!existsSync(configPath)) {
    return normalizeTokenPilotCodexConfig({}, { configPath });
  }
  const text = await readFile(configPath, "utf8");
  return normalizeTokenPilotCodexConfig(JSON.parse(text), { configPath });
}

export async function writeTokenPilotCodexConfig(
  config: TokenPilotCodexConfig,
  configPath = defaultTokenPilotConfigPath(),
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}

type TomlSection = {
  name: string;
  values: Record<string, string>;
};

function parseTomlStringValue(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed ? trimmed : undefined;
}

export async function readCodexProviderFromToml(
  providerName: string,
  configPath = defaultCodexConfigPath(),
): Promise<CodexProviderConfig | undefined> {
  if (!existsSync(configPath)) return undefined;
  const text = await readFile(configPath, "utf8");
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      current = { name: sectionMatch[1], values: {} };
      sections.push(current);
      continue;
    }
    if (!current || trimmed.startsWith("#")) continue;
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!assignment) continue;
    current.values[assignment[1]] = assignment[2].replace(/\s+#.*$/, "").trim();
  }
  const section = sections.find((item) => item.name === `model_providers.${providerName}`);
  if (!section) return undefined;
  const baseUrl = parseTomlStringValue(section.values.base_url);
  if (!baseUrl) return undefined;
  const wireApi = parseTomlStringValue(section.values.wire_api);
  const apiKey = parseTomlStringValue(section.values.api_key)
    ?? parseTomlStringValue(section.values.apiKey);
  return {
    name: parseTomlStringValue(section.values.name),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    wireApi: wireApi === "chat" ? "chat" : "responses",
    requiresOpenAIAuth: section.values.requires_openai_auth !== "false",
  };
}

export async function readCodexRootModelProvider(
  configPath = defaultCodexConfigPath(),
): Promise<string | undefined> {
  if (!existsSync(configPath)) return undefined;
  const text = await readFile(configPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[.+\]$/.test(trimmed)) break;
    const assignment = /^model_provider\s*=\s*(.+)$/.exec(trimmed);
    if (!assignment) continue;
    return parseTomlStringValue(assignment[1]);
  }
  return undefined;
}

export async function readCodexMcpServerFromToml(
  serverName: string,
  configPath = defaultCodexConfigPath(),
): Promise<CodexMcpServerConfig | undefined> {
  if (!existsSync(configPath)) return undefined;
  const text = await readFile(configPath, "utf8");
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      current = { name: sectionMatch[1], values: {} };
      sections.push(current);
      continue;
    }
    if (!current || trimmed.startsWith("#")) continue;
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!assignment) continue;
    current.values[assignment[1]] = assignment[2].replace(/\s+#.*$/, "").trim();
  }
  const section = sections.find((item) => item.name === `mcp_servers.${serverName}`);
  if (!section) return undefined;
  const envSection = sections.find((item) => item.name === `mcp_servers.${serverName}.env`);
  const command = parseTomlStringValue(section.values.command);
  if (!command) return undefined;
  const argsValue = section.values.args?.trim();
  const args = argsValue
    ? Array.from(argsValue.matchAll(/"((?:\\.|[^"])*)"|'([^']*)'/g)).map((match) =>
      (match[1] ?? match[2] ?? "").replace(/\\"/g, "\"").replace(/\\\\/g, "\\"))
    : [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envSection?.values ?? {})) {
    const parsed = parseTomlStringValue(value);
    if (parsed) env[key] = parsed;
  }
  const startupTimeoutSec = section.values.startup_timeout_sec
    ? Number(section.values.startup_timeout_sec)
    : undefined;
  return {
    command,
    args,
    env,
    startupTimeoutSec: Number.isFinite(startupTimeoutSec) ? startupTimeoutSec : undefined,
  };
}

export async function resolveUpstreamProvider(
  config: TokenPilotCodexConfig,
  codexConfigPath = resolvedCodexConfigPath(),
): Promise<CodexProviderConfig> {
  if (config.proxyBaseUrl) {
    return {
      name: "explicit",
      baseUrl: config.proxyBaseUrl.replace(/\/+$/, ""),
      apiKey: config.proxyApiKey,
      wireApi: "responses",
      requiresOpenAIAuth: true,
    };
  }
  if (config.upstream?.baseUrl) return config.upstream;
  const providerName = config.upstreamProvider ?? "OpenAI";
  const provider = await readCodexProviderFromToml(providerName, codexConfigPath);
  if (!provider) {
    throw new Error(`Codex provider ${providerName} was not found in ${codexConfigPath}`);
  }
  return provider;
}
