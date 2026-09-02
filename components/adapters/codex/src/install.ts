import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "node:net";
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
  defaultCodexConfigPath,
  defaultHooksConfigPath,
  defaultTokenPilotConfigPath,
  type CodexProviderConfig,
  loadTokenPilotCodexConfig,
  readCodexProviderFromToml,
  readCodexRootModelProvider,
  writeTokenPilotCodexConfig,
} from "./config.js";
import { stopDaemon } from "./daemon.js";
import {
  defaultCodexSkillBridgeDir,
  installCommandSkillBridge,
} from "../../shared/command-skill-bridge.js";
import { installLightRsiCliBin } from "../../shared/cli-bin-install.js";
import { rememberCliHostPathOverrides } from "../../shared/cli-context.js";
import { installHostCliBin } from "../../shared/host-cli-bin-install.js";

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

const RESERVED_CODEX_PROVIDER_PROXY_NAMES: Record<string, string> = {
  openai: "tokenpilot-openai",
};

function reservedCodexProviderProxyName(providerName: string): string | undefined {
  return RESERVED_CODEX_PROVIDER_PROXY_NAMES[providerName];
}

function builtInCodexProviderConfig(providerName: string): CodexProviderConfig | undefined {
  if (providerName !== "openai") return undefined;
  return {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    wireApi: "responses",
    requiresOpenAIAuth: true,
  };
}

function replaceOrInsertRootAssignment(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let inRoot = true;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\[.+\]$/.test(trimmed)) inRoot = false;
    if (!inRoot) break;
    if (new RegExp(`^${key}\\s*=`).test(trimmed)) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }
  lines.unshift(`${key} = ${value}`);
  return lines.join("\n");
}

function rewriteProviderSectionForProxy(text: string, params: {
  providerName: string;
  baseUrl: string;
  displayName?: string;
  wireApi?: "responses" | "chat";
  requiresOpenAIAuth?: boolean;
}): string {
  const sectionHeader = `[model_providers.${params.providerName}]`;
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  const desired = {
    name: params.displayName,
    base_url: params.baseUrl,
    wire_api: params.wireApi ?? "responses",
    requires_openai_auth: params.requiresOpenAIAuth === false ? "false" : "true",
  };

  if (startIndex === -1) {
    const section = [
      sectionHeader,
      `name = ${quoteToml(desired.name ?? params.providerName)}`,
      `base_url = ${quoteToml(desired.base_url)}`,
      `wire_api = ${quoteToml(desired.wire_api)}`,
      `requires_openai_auth = ${desired.requires_openai_auth}`,
    ].join("\n");
    return `${text.replace(/\s*$/, "")}\n\n${section}\n`;
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  const sectionLines = [...lines.slice(startIndex, endIndex)];
  const rewriteAssignment = (key: string, value: string, quote = true): void => {
    const assignment = `${key} = ${quote ? quoteToml(value) : value}`;
    const relativeIndex = sectionLines.findIndex((line, index) =>
      index > 0 && new RegExp(`^\\s*${key}\\s*=`).test(line.trim()));
    if (relativeIndex >= 0) {
      sectionLines[relativeIndex] = assignment;
      return;
    }
    sectionLines.push(assignment);
  };

  if (desired.name) {
    rewriteAssignment("name", desired.name);
  }
  rewriteAssignment("base_url", desired.base_url);
  rewriteAssignment("wire_api", desired.wire_api);
  rewriteAssignment("requires_openai_auth", desired.requires_openai_auth, false);

  return [
    ...lines.slice(0, startIndex),
    ...sectionLines,
    ...lines.slice(endIndex),
  ].join("\n");
}

function removeProviderSectionFamily(text: string, providerName: string): string {
  const prefix = `model_providers.${providerName}`;
  let removing = false;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      const sectionName = sectionMatch[1]!;
      removing = sectionName === prefix || sectionName.startsWith(`${prefix}.`);
    }
    if (!removing) kept.push(line);
  }
  return kept.join("\n");
}

function upsertMcpServerSection(text: string, params: {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutSec?: number;
}): string {
  const escape = (value: string) => JSON.stringify(value);
  const sectionHeader = `[mcp_servers.${params.serverName}]`;
  const lines = [
    sectionHeader,
    `command = ${escape(params.command)}`,
  ];
  if (params.args.length > 0) {
    lines.push(`args = [${params.args.map((value) => escape(value)).join(", ")}]`);
  }
  if (typeof params.startupTimeoutSec === "number" && Number.isFinite(params.startupTimeoutSec) && params.startupTimeoutSec > 0) {
    lines.push(`startup_timeout_sec = ${Math.trunc(params.startupTimeoutSec)}`);
  }
  const envEntries = Object.entries(params.env);
  if (envEntries.length > 0) {
    lines.push("", `[mcp_servers.${params.serverName}.env]`);
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${escape(value)}`);
    }
  }
  const section = lines.join("\n");
  const escapedServer = params.serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionFamilyRe = new RegExp(
    `\\n?\\[mcp_servers\\.${escapedServer}\\](?:[\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${escapedServer}(?:\\.|\\]))[^\\]]+\\]|$))?`
    + `(?:\\n\\[mcp_servers\\.${escapedServer}\\.[^\\]]+\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${escapedServer}(?:\\.|\\]))[^\\]]+\\]|$))*`,
  );
  if (sectionFamilyRe.test(text)) {
    return text.replace(sectionFamilyRe, `\n${section}\n`);
  }
  return `${text.replace(/\s*$/, "")}\n\n${section}\n`;
}

function isCodexAdapterRoot(candidate: string): boolean {
  const packageJsonPath = join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  if (!existsSync(join(candidate, "dist", "hooks-handler.js")) && !existsSync(join(candidate, "src", "hooks-handler.ts"))) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return parsed.name === "@lightrsi/codex-adapter";
  } catch {
    return false;
  }
}

function adapterRootFromHere(moduleDir = __dirname): string {
  const fromDist = resolve(moduleDir, "..");
  if (isCodexAdapterRoot(fromDist)) {
    return fromDist;
  }
  const fromSrc = resolve(moduleDir, "..");
  if (isCodexAdapterRoot(fromSrc)) {
    return fromSrc;
  }
  let current = resolve(moduleDir, "..");
  for (let i = 0; i < 10; i += 1) {
    const nested = join(current, "components", "adapters", "codex");
    if (isCodexAdapterRoot(nested)) {
      return nested;
    }
    current = dirname(current);
  }
  current = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (isCodexAdapterRoot(current)) {
      return current;
    }
    const nested = join(current, "components", "adapters", "codex");
    if (isCodexAdapterRoot(nested)) return nested;
    current = dirname(current);
  }
  return join(process.cwd(), "components", "adapters", "codex");
}

function shellQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function normalizeLocalProxyBaseUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/v1$/i.exec(trimmed);
  if (!match) return undefined;
  return `http://127.0.0.1:${match[1]}/v1`;
}

function isLoopbackProxyProvider(provider: CodexProviderConfig | undefined): boolean {
  return Boolean(normalizeLocalProxyBaseUrl(provider?.baseUrl));
}

function sameProviderEndpoint(left: CodexProviderConfig | undefined, right: CodexProviderConfig | undefined): boolean {
  return Boolean(left?.baseUrl && right?.baseUrl && left.baseUrl === right.baseUrl);
}

async function canListenOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveAvailableCodexProxyPort(
  preferredPort: number,
  params?: { waitForPreferredMs?: number },
): Promise<number> {
  const waitForPreferredMs = params?.waitForPreferredMs ?? 0;
  const deadline = performance.now() + waitForPreferredMs;
  do {
    if (await canListenOnPort(preferredPort)) return preferredPort;
    if (performance.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
  for (let port = preferredPort + 1; port <= preferredPort + 20; port += 1) {
    if (await canListenOnPort(port)) return port;
  }
  return preferredPort;
}

function hookWrapperPath(adapterRoot: string): string {
  return join(adapterRoot, "dist", "tokenpilot-codex-hook.cmd");
}

function hookScriptPath(adapterRoot: string): string {
  return join(adapterRoot, "dist", "hooks-handler.js");
}

async function ensureWindowsHookWrapper(adapterRoot: string): Promise<string> {
  const wrapperPath = hookWrapperPath(adapterRoot);
  await mkdir(dirname(wrapperPath), { recursive: true });
  await writeFile(wrapperPath, [
    "@echo off",
    `${shellQuote(process.execPath)} ${shellQuote(hookScriptPath(adapterRoot))} %*`,
    "",
  ].join("\r\n"), "utf8");
  return wrapperPath;
}

async function tokenPilotHookCommand(adapterRoot: string, platform = process.platform): Promise<string> {
  if (platform === "win32") {
    return shellQuote(await ensureWindowsHookWrapper(adapterRoot));
  }
  return `${shellQuote(process.execPath)} ${shellQuote(hookScriptPath(adapterRoot))}`;
}

export async function resolveCodexHookCommandForInstall(
  platform = process.platform,
  moduleDir = __dirname,
): Promise<string> {
  return tokenPilotHookCommand(adapterRootFromHere(moduleDir), platform);
}

export function resolveCodexMcpServerSpecForInstall(stateDir: string): TokenPilotMcpServerSpec {
  const fallback = resolveTokenPilotMcpServerSpec({
    stateDir,
    requireBuild: false,
  });
  const bundledEntryPath = join(adapterRootFromHere(), "dist", "mcp-server.js");
  return existsSync(bundledEntryPath)
    ? { ...fallback, args: [bundledEntryPath], entryPath: bundledEntryPath }
    : fallback;
}

export function resolveCodexMcpServerSpecForProbe(stateDir: string): TokenPilotMcpServerSpec {
  const fallback = resolveTokenPilotMcpProbeServerSpec({
    stateDir,
    requireBuild: false,
  });
  const bundledEntryPath = join(adapterRootFromHere(), "dist", "mcp-server.js");
  return existsSync(bundledEntryPath)
    ? { ...fallback, command: process.execPath, args: [bundledEntryPath], entryPath: bundledEntryPath }
    : fallback;
}

function asHookConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isTokenPilotHookGroup(item: Record<string, unknown>): boolean {
  const hooks = Array.isArray(item.hooks) ? item.hooks : [];
  return hooks.some((hook) => {
    if (!hook || typeof hook !== "object") return false;
    const command = (hook as Record<string, unknown>).command;
    return typeof command === "string"
      && (command.includes("hooks-handler.js") || command.includes("tokenpilot-codex-hook.cmd"));
  });
}

function upsertTokenPilotHookGroup(groups: unknown, group: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(groups) ? groups.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
  const filtered = list.filter((item) => !isTokenPilotHookGroup(item));
  return [...filtered, group];
}

function removeTokenPilotHookGroups(groups: unknown): Record<string, unknown>[] {
  const list = Array.isArray(groups) ? groups.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
  return list.filter((item) => !isTokenPilotHookGroup(item));
}

async function installHooksJson(params: {
  hooksConfigPath: string;
  adapterRoot: string;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const existing = existsSync(params.hooksConfigPath)
    ? JSON.parse(await readFile(params.hooksConfigPath, "utf8"))
    : {};
  const root = asHookConfig(existing);
  const hooks = asHookConfig(root.hooks);
  const command = await tokenPilotHookCommand(params.adapterRoot, params.platform);
  const handler = (statusMessage: string, timeout = 30) => ({
    type: "command",
    command,
    statusMessage,
    timeout,
  });

  hooks.SessionStart = upsertTokenPilotHookGroup(hooks.SessionStart, {
    matcher: "startup|resume",
    hooks: [handler("Starting TokenPilot Codex proxy")],
  });
  hooks.PreToolUse = upsertTokenPilotHookGroup(hooks.PreToolUse, {
    matcher: ".*",
    hooks: [handler("Recording TokenPilot pre-tool metadata", 10)],
  });
  hooks.PostToolUse = upsertTokenPilotHookGroup(hooks.PostToolUse, {
    matcher: ".*",
    hooks: [handler("Recording TokenPilot tool output", 10)],
  });
  const stopGroups = removeTokenPilotHookGroups(hooks.Stop);
  if (stopGroups.length === 0) delete hooks.Stop;
  else hooks.Stop = stopGroups;

  await mkdir(dirname(params.hooksConfigPath), { recursive: true });
  if (existsSync(params.hooksConfigPath)) {
    await copyFile(params.hooksConfigPath, `${params.hooksConfigPath}.tokenpilot.bak`);
  }
  await writeFile(params.hooksConfigPath, `${JSON.stringify({ ...root, hooks }, null, 2)}\n`, "utf8");
}

export async function installCodexTokenPilot(params?: {
  codexConfigPath?: string;
  tokenPilotConfigPath?: string;
  hooksConfigPath?: string;
  providerName?: string;
  installHooks?: boolean;
  probeMcp?: boolean;
  platform?: NodeJS.Platform;
  cliBinDir?: string;
  cliContextPath?: string;
}): Promise<{
  codexConfigPath: string;
  tokenPilotConfigPath: string;
  hooksConfigPath: string;
  providerName: string;
  activeProviderName: string;
  baseUrl: string;
  hooksInstalled: boolean;
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
  const codexConfigPath = params?.codexConfigPath ?? defaultCodexConfigPath();
  const tokenPilotConfigPath = params?.tokenPilotConfigPath ?? defaultTokenPilotConfigPath();
  const hooksConfigPath = params?.hooksConfigPath ?? defaultHooksConfigPath();
  const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
  const previousProxyPort = tokenPilotConfig.proxyPort;
  const commandSkillsDir = defaultCodexSkillBridgeDir(dirname(codexConfigPath));
  const stoppedDaemon = await stopDaemon(tokenPilotConfig).catch(() => undefined);
  tokenPilotConfig.proxyPort = await resolveAvailableCodexProxyPort(tokenPilotConfig.proxyPort, {
    waitForPreferredMs: stoppedDaemon?.stopped ? 1_000 : 0,
  });
  const existingRootProvider = await readCodexRootModelProvider(codexConfigPath);
  const persistedProviderName = tokenPilotConfig.providerName !== "tokenpilot"
    ? tokenPilotConfig.providerName
    : undefined;
  const selectedProviderName = (existingRootProvider
    || params?.providerName?.trim()
    || tokenPilotConfig.upstreamProvider
    || persistedProviderName
    || "OpenAI");
  const reservedProviderProxyName = reservedCodexProviderProxyName(selectedProviderName);
  const providerName = reservedProviderProxyName ?? selectedProviderName;
  const interceptedProvider = await readCodexProviderFromToml(providerName, codexConfigPath);
  const previousProxyBaseUrl = `http://127.0.0.1:${previousProxyPort}/v1`;
  const existingInterceptedProxyBaseUrl = normalizeLocalProxyBaseUrl(interceptedProvider?.baseUrl);
  const providerAlreadyRouted = tokenPilotConfig.providerName === providerName
    && interceptedProvider?.baseUrl === previousProxyBaseUrl
    && Boolean(tokenPilotConfig.upstream?.baseUrl);
  const installedProviderLooksFresh = existingInterceptedProxyBaseUrl === previousProxyBaseUrl;
  const upstreamProvider = providerAlreadyRouted || installedProviderLooksFresh
    ? tokenPilotConfig.upstream
    : builtInCodexProviderConfig(selectedProviderName) ?? interceptedProvider;
  tokenPilotConfig.enabled = true;
  tokenPilotConfig.providerName = providerName;
  tokenPilotConfig.upstreamProvider = selectedProviderName;
  if (
    upstreamProvider?.baseUrl
    && !isLoopbackProxyProvider(upstreamProvider)
    && !sameProviderEndpoint(upstreamProvider, tokenPilotConfig.upstream)
  ) {
    tokenPilotConfig.upstream = upstreamProvider;
  }
  await writeTokenPilotCodexConfig(tokenPilotConfig, tokenPilotConfigPath);
  const baseUrl = `http://127.0.0.1:${tokenPilotConfig.proxyPort}/v1`;
  const mcpServer = resolveCodexMcpServerSpecForInstall(tokenPilotConfig.stateDir);
  const mcpProbeServer = resolveCodexMcpServerSpecForProbe(tokenPilotConfig.stateDir);

  await mkdir(dirname(codexConfigPath), { recursive: true });
  const existing = existsSync(codexConfigPath) ? await readFile(codexConfigPath, "utf8") : "";
  if (existsSync(codexConfigPath)) {
    await copyFile(codexConfigPath, `${codexConfigPath}.tokenpilot.bak`);
  }
  let next = existing;
  if (reservedProviderProxyName) {
    next = removeProviderSectionFamily(next, selectedProviderName);
  }
  next = replaceOrInsertRootAssignment(next, "model_provider", quoteToml(providerName));
  next = rewriteProviderSectionForProxy(next, {
    providerName,
    baseUrl,
    displayName: interceptedProvider?.name ?? providerName,
    wireApi: interceptedProvider?.wireApi ?? "responses",
    requiresOpenAIAuth: interceptedProvider?.requiresOpenAIAuth ?? true,
  });
  next = upsertMcpServerSection(next, {
    serverName: mcpServer.serverName,
    command: mcpServer.command,
    args: mcpServer.args,
    env: mcpServer.env,
    startupTimeoutSec: DEFAULT_TOKENPILOT_MCP_STARTUP_TIMEOUT_SEC,
  });
  await writeFile(codexConfigPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  const hooksInstalled = params?.installHooks !== false;
  if (hooksInstalled) {
    await installHooksJson({
      hooksConfigPath,
      adapterRoot: adapterRootFromHere(),
      platform: params?.platform,
    });
  }
  const commandSkillBridge = await installCommandSkillBridge({
    adapterRoot: adapterRootFromHere(),
    skillsDir: commandSkillsDir,
    host: "codex",
    style: "codex",
  });
  const cliBin = await installLightRsiCliBin({
    adapterRoot: adapterRootFromHere(),
    binDir: params?.cliBinDir,
    platform: params?.platform,
  });
  const hostCliBin = cliBin.installed
    ? await installHostCliBin({
      adapterRoot: adapterRootFromHere(),
      host: "codex",
      binDir: cliBin.binDir,
      platform: params?.platform,
    })
    : undefined;
  await rememberCliHostPathOverrides("codex", {
    tokenPilotConfigPath,
    hostConfigPath: codexConfigPath,
    hostAuxConfigPath: hooksConfigPath,
  }, params?.cliContextPath);
  const expectedHookCommand = await resolveCodexHookCommandForInstall(params?.platform);
  const mcpProbeResult = params?.probeMcp === false
    ? {
      ok: false,
      timedOut: false,
      degraded: true,
      detail: "MCP startup probe skipped by installer options",
    }
    : await probeTokenPilotMcpServer(mcpProbeServer, {
      timeoutMs: DEFAULT_TOKENPILOT_MCP_INSTALL_PROBE_TIMEOUT_MS,
      clientName: "tokenpilot-codex-install",
      clientVersion: LIGHTRSI_VERSION,
    });
  return {
    codexConfigPath,
    tokenPilotConfigPath,
    hooksConfigPath,
    providerName,
    activeProviderName: providerName,
    baseUrl,
    hooksInstalled,
    mcpServerName: mcpServer.serverName,
    expectedHookCommand,
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
      ...mcpProbeResult,
      degraded: !mcpProbeResult.ok,
    },
  };
}
