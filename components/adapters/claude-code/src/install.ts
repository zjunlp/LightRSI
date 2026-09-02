import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LIGHTRSI_VERSION } from "@lightrsi/kernel";
import {
  DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS,
  DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  probeTokenPilotMcpServer,
  resolveTokenPilotMcpProbeServerSpec,
  resolveTokenPilotMcpServerSpec,
  type TokenPilotMcpServerSpec,
} from "../../../products/mcp/src/index.js";
import {
  CLAUDE_TOOL_SEARCH_DEFAULT,
  CLAUDE_TOOL_SEARCH_ENV,
  defaultClaudeUpstreamBaseUrl,
  defaultClaudeCodeMcpConfigPath,
  defaultClaudeCodeSettingsPath,
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
  proxyBaseUrlForPort,
  writeTokenPilotClaudeCodeConfig,
} from "./config.js";
import {
  defaultClaudeCodeSkillBridgeDir,
  installCommandSkillBridge,
} from "../../shared/command-skill-bridge.js";
import { installLightRsiCliBin } from "../../shared/cli-bin-install.js";
import { rememberCliHostPathOverrides } from "../../shared/cli-context.js";
import { installHostCliBin } from "../../shared/host-cli-bin-install.js";
import { rewriteInstalledClaudeVisibleModel } from "./provider-profile.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isClaudeCodeAdapterRoot(candidate: string): boolean {
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  if (!existsSync(join(candidate, "dist", "hooks-handler.js")) && !existsSync(join(candidate, "src", "hooks-handler.ts"))) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return parsed.name === "@lightrsi/claude-code-adapter";
  } catch {
    return false;
  }
}

function adapterRootFromHere(moduleDir = __dirname): string {
  const fromDist = resolve(moduleDir, "..");
  if (isClaudeCodeAdapterRoot(fromDist)) {
    return fromDist;
  }
  const fromSrc = resolve(moduleDir, "..");
  if (isClaudeCodeAdapterRoot(fromSrc)) {
    return fromSrc;
  }
  let current = resolve(moduleDir, "..");
  for (let i = 0; i < 10; i += 1) {
    const nested = join(current, "components", "adapters", "claude-code");
    if (isClaudeCodeAdapterRoot(nested)) {
      return nested;
    }
    current = dirname(current);
  }
  current = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (isClaudeCodeAdapterRoot(current)) {
      return current;
    }
    const nested = join(current, "components", "adapters", "claude-code");
    if (isClaudeCodeAdapterRoot(nested)) {
      return nested;
    }
    current = dirname(current);
  }
  return join(process.cwd(), "components", "adapters", "claude-code");
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}

function tokenPilotHookCommand(adapterRoot: string): string {
  const distHandler = resolve(adapterRoot, "dist", "hooks-handler.js");
  if (existsSync(distHandler)) {
    return `${shellQuote(process.execPath)} ${shellQuote(distHandler)}`;
  }
  const srcHandler = resolve(adapterRoot, "src", "hooks-handler.ts");
  return `${shellQuote(process.execPath)} --import tsx ${shellQuote(srcHandler)}`;
}

export function resolveClaudeCodeHookCommandForInstall(moduleDir = __dirname): string {
  return tokenPilotHookCommand(adapterRootFromHere(moduleDir));
}

export function resolveClaudeCodeMcpServerSpecForInstall(stateDir: string): TokenPilotMcpServerSpec {
  const fallback = resolveTokenPilotMcpServerSpec({
    stateDir,
    requireBuild: false,
  });
  const bundledEntryPath = join(adapterRootFromHere(), "dist", "mcp-server.js");
  return existsSync(bundledEntryPath)
    ? { ...fallback, args: [bundledEntryPath], entryPath: bundledEntryPath }
    : fallback;
}

export function resolveClaudeCodeMcpServerSpecForProbe(stateDir: string): TokenPilotMcpServerSpec {
  const fallback = resolveTokenPilotMcpProbeServerSpec({
    stateDir,
    requireBuild: false,
  });
  const bundledEntryPath = join(adapterRootFromHere(), "dist", "mcp-server.js");
  return existsSync(bundledEntryPath)
    ? { ...fallback, command: process.execPath, args: [bundledEntryPath], entryPath: bundledEntryPath }
    : fallback;
}

function isTokenPilotHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  const command = record.command;
  return typeof command === "string" && command.includes("hooks-handler.");
}

function upsertHookGroup(groups: unknown, group: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(groups)
    ? groups.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
    : [];
  const filtered = list.filter((item) => {
    const hooks = Array.isArray(item.hooks) ? item.hooks : [];
    return !hooks.some(isTokenPilotHookEntry);
  });
  filtered.push(group);
  return filtered;
}

function shouldAdoptSettingsUpstream(
  currentUpstreamBaseUrl: string,
  settingsUpstreamBaseUrl: string,
  proxyBaseUrl: string,
): boolean {
  const normalizedCurrent = currentUpstreamBaseUrl.trim().replace(/\/+$/, "");
  const normalizedSettings = settingsUpstreamBaseUrl.trim().replace(/\/+$/, "");
  const normalizedProxy = proxyBaseUrl.trim().replace(/\/+$/, "");
  const normalizedDefault = defaultClaudeUpstreamBaseUrl().replace(/\/+$/, "");
  if (!normalizedSettings || normalizedSettings === normalizedProxy) {
    return false;
  }
  return !normalizedCurrent || normalizedCurrent === normalizedDefault;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export async function installClaudeCodeTokenPilot(params?: {
  settingsPath?: string;
  tokenPilotConfigPath?: string;
  mcpConfigPath?: string;
  probeMcp?: boolean;
  cliBinDir?: string;
  cliContextPath?: string;
  platform?: NodeJS.Platform;
}): Promise<{
  settingsPath: string;
  mcpConfigPath: string;
  tokenPilotConfigPath: string;
  proxyBaseUrl: string;
  stateDir: string;
  settingsBackedUp: boolean;
  mcpConfigBackedUp: boolean;
  hooksInstalled: boolean;
  toolSearchEnvName: string;
  toolSearchEnvValue: string;
  mcpServerName: string;
  expectedHookCommand: string;
  expectedMcpCommand: string;
  expectedMcpArgs: string[];
  expectedMcpStartupTimeoutSec: number;
  commandSkillsDir: string;
  commandSkillNames: string[];
  cliBinInstalled: boolean;
  cliBinPath: string;
  cliLauncherPath?: string;
  cliBinDir: string;
  cliBinDirOnPath: boolean;
  hostCliBinPath?: string;
  hostCliLauncherPath?: string;
  mcpProbe: {
    ok: boolean;
    detail: string;
    timedOut: boolean;
    degraded: boolean;
  };
}> {
  const settingsPath = params?.settingsPath ?? defaultClaudeCodeSettingsPath();
  const mcpConfigPath = params?.mcpConfigPath ?? defaultClaudeCodeMcpConfigPath();
  const tokenPilotConfigPath = params?.tokenPilotConfigPath ?? defaultTokenPilotClaudeCodeConfigPath();
  const config = await loadTokenPilotClaudeCodeConfig(tokenPilotConfigPath);
  const commandSkillsDir = defaultClaudeCodeSkillBridgeDir(settingsPath);
  const existing = existsSync(settingsPath)
    ? JSON.parse(await readFile(settingsPath, "utf8"))
    : {};
  const root = asRecord(existing);
  const existingEnv = asRecord(root.env);
  const existingAnthropicBaseUrl = typeof existingEnv.ANTHROPIC_BASE_URL === "string"
    ? existingEnv.ANTHROPIC_BASE_URL.trim()
    : "";
  const existingRootModel = typeof root.model === "string" ? root.model.trim() : "";
  const proxyBaseUrl = proxyBaseUrlForPort(config.proxyPort);
  if (shouldAdoptSettingsUpstream(config.upstreamBaseUrl, existingAnthropicBaseUrl, proxyBaseUrl)) {
    config.upstreamBaseUrl = existingAnthropicBaseUrl.replace(/\/+$/, "");
  }
  const visibleModelEnvKeys = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ] as const;
  const configuredVisibleModels = uniqueStrings(
    visibleModelEnvKeys
    .map((key) => typeof existingEnv[key] === "string" ? String(existingEnv[key]).trim() : "")
      .concat(existingRootModel ? [existingRootModel] : []),
  );
  if (!String(config.upstreamModel ?? "").trim() && configuredVisibleModels[0]) {
    config.upstreamModel = configuredVisibleModels[0];
  }
  if (configuredVisibleModels.length > 0) {
    config.visibleModels = configuredVisibleModels;
  }
  await writeTokenPilotClaudeCodeConfig(config, tokenPilotConfigPath);
  const mcpServer = resolveClaudeCodeMcpServerSpecForInstall(config.stateDir);
  const mcpProbeServer = resolveClaudeCodeMcpServerSpecForProbe(config.stateDir);
  const env: Record<string, unknown> = {
    ...existingEnv,
    ANTHROPIC_BASE_URL: proxyBaseUrl,
    [CLAUDE_TOOL_SEARCH_ENV]: CLAUDE_TOOL_SEARCH_DEFAULT,
  };
  for (const key of visibleModelEnvKeys) {
    const visibleModel = rewriteInstalledClaudeVisibleModel(config, env[key]);
    if (visibleModel) {
      env[key] = visibleModel;
    }
  }
  const rewrittenRootModel = rewriteInstalledClaudeVisibleModel(config, root.model);
  const hooks = asRecord(root.hooks);
  const command = resolveClaudeCodeHookCommandForInstall();
  const handler = () => ({
    type: "command",
    command,
  });
  hooks.SessionStart = upsertHookGroup(hooks.SessionStart, { hooks: [handler()] });
  hooks.PreToolUse = upsertHookGroup(hooks.PreToolUse, { hooks: [handler()] });
  hooks.PostToolUse = upsertHookGroup(hooks.PostToolUse, { hooks: [handler()] });
  hooks.Stop = upsertHookGroup(hooks.Stop, { hooks: [handler()] });
  hooks.SessionEnd = upsertHookGroup(hooks.SessionEnd, { hooks: [handler()] });
  const next = {
    ...root,
    ...(rewrittenRootModel ? { model: rewrittenRootModel } : {}),
    env,
    hooks,
  };

  await mkdir(dirname(settingsPath), { recursive: true });
  const settingsBackedUp = existsSync(settingsPath);
  if (existsSync(settingsPath)) {
    await copyFile(settingsPath, `${settingsPath}.tokenpilot.bak`);
  }
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  const mcpExisting = existsSync(mcpConfigPath)
    ? JSON.parse(await readFile(mcpConfigPath, "utf8"))
    : {};
  const mcpRoot = asRecord(mcpExisting);
  const mcpServers = {
    ...asRecord(mcpRoot.mcpServers),
    [mcpServer.serverName]: {
      command: mcpServer.command,
      args: mcpServer.args,
      env: mcpServer.env,
      startup_timeout_sec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
    },
  };
  await mkdir(dirname(mcpConfigPath), { recursive: true });
  const mcpConfigBackedUp = existsSync(mcpConfigPath);
  if (existsSync(mcpConfigPath)) {
    await copyFile(mcpConfigPath, `${mcpConfigPath}.tokenpilot.bak`);
  }
  await writeFile(mcpConfigPath, `${JSON.stringify({ ...mcpRoot, mcpServers }, null, 2)}\n`, "utf8");
  const commandSkillBridge = await installCommandSkillBridge({
    adapterRoot: adapterRootFromHere(),
    skillsDir: commandSkillsDir,
    host: "claude-code",
    style: "claude",
  });
  const cliBin = await installLightRsiCliBin({
    adapterRoot: adapterRootFromHere(),
    binDir: params?.cliBinDir,
    platform: params?.platform,
  });
  const hostCliBin = cliBin.installed
    ? await installHostCliBin({
      adapterRoot: adapterRootFromHere(),
      host: "claude-code",
      binDir: cliBin.binDir,
      platform: params?.platform,
    })
    : undefined;
  await rememberCliHostPathOverrides("claude-code", {
    tokenPilotConfigPath,
    hostConfigPath: settingsPath,
    hostAuxConfigPath: mcpConfigPath,
  }, params?.cliContextPath);
  const mcpProbe = params?.probeMcp === false
    ? {
      ok: false,
      timedOut: false,
      degraded: true,
      detail: "MCP startup probe skipped by installer options",
    }
    : await probeTokenPilotMcpServer(mcpProbeServer, {
      timeoutMs: DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS,
      clientName: "tokenpilot-claude-code-install",
      clientVersion: LIGHTRSI_VERSION,
    });
  return {
    settingsPath,
    mcpConfigPath,
    tokenPilotConfigPath,
    proxyBaseUrl,
    stateDir: config.stateDir,
    settingsBackedUp,
    mcpConfigBackedUp,
    hooksInstalled: true,
    toolSearchEnvName: CLAUDE_TOOL_SEARCH_ENV,
    toolSearchEnvValue: CLAUDE_TOOL_SEARCH_DEFAULT,
    mcpServerName: mcpServer.serverName,
    expectedHookCommand: command,
    expectedMcpCommand: mcpServer.command,
    expectedMcpArgs: mcpServer.args,
    expectedMcpStartupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
    commandSkillsDir: commandSkillBridge.skillsDir,
    commandSkillNames: commandSkillBridge.skillNames,
    cliBinInstalled: cliBin.installed,
    cliBinPath: cliBin.binPath,
    cliLauncherPath: cliBin.launcherPath,
    cliBinDir: cliBin.binDir,
    cliBinDirOnPath: cliBin.binDirOnPath,
    hostCliBinPath: hostCliBin?.binPath,
    hostCliLauncherPath: hostCliBin?.launcherPath,
    mcpProbe: {
      ...mcpProbe,
      degraded: !mcpProbe.ok,
    },
  };
}
