#!/usr/bin/env node
import { installClaudeCodeTokenPilot } from "../src/install.js";

async function main() {
  const result = await installClaudeCodeTokenPilot({
    settingsPath: process.env.CLAUDE_CODE_SETTINGS_PATH,
    mcpConfigPath: process.env.CLAUDE_CODE_MCP_CONFIG_PATH,
    tokenPilotConfigPath: process.env.TOKENPILOT_CLAUDE_CODE_CONFIG,
  });
  console.log([
    "TokenPilot Claude Code install complete:",
    `- settings: ${result.settingsPath}`,
    `- settings backup created: ${result.settingsBackedUp ? "yes" : "no"}`,
    `- mcp config: ${result.mcpConfigPath}`,
    `- mcp config backup created: ${result.mcpConfigBackedUp ? "yes" : "no"}`,
    `- tokenpilot config: ${result.tokenPilotConfigPath}`,
    `- state dir: ${result.stateDir}`,
    `- proxy base URL: ${result.proxyBaseUrl}`,
    `- observability hooks installed: ${result.hooksInstalled ? "yes" : "no"}`,
    `- expected hook command: ${result.expectedHookCommand}`,
    `- expected MCP command: ${result.expectedMcpCommand}`,
    `- expected MCP args: ${result.expectedMcpArgs.join(" ")}`,
    `- expected MCP startup timeout: ${result.expectedMcpStartupTimeoutSec}s`,
    `- command skills dir: ${result.commandSkillsDir}`,
    `- command skills: ${result.commandSkillNames.join(", ")}`,
    `- lightrsi CLI bin: ${result.cliBinInstalled ? `installed at ${result.cliLauncherPath ?? result.cliBinPath}` : `skipped (missing build at ${result.cliBinPath})`}`,
    ...(result.hostCliBinPath ? [`- tokenpilot-claude-code CLI bin: installed at ${result.hostCliLauncherPath ?? result.hostCliBinPath}`] : []),
    ...(!result.cliBinDirOnPath ? [`- lightrsi CLI PATH note: add ${result.cliBinDir} to PATH if 'lightrsi' is unavailable.`] : []),
    `- tool search env: ${result.toolSearchEnvName}=${result.toolSearchEnvValue}`,
    `- recovery MCP server: ${result.mcpServerName}`,
    `- recovery MCP probe: ${result.mcpProbe.ok ? "ok" : "degraded"}`,
    `- recovery MCP probe detail: ${result.mcpProbe.detail}`,
    "- next step: trust the installed TokenPilot hooks if Claude Code asks for hook review",
    "- next step: start a new Claude Code session so SessionStart can boot the local gateway",
    "- manual fallback: run `tokenpilot-claude-code start` if the first doctor still shows proxy unhealthy",
  ].join("\n"));
  if (result.mcpProbe.degraded) {
    console.log("MCP recovery is currently degraded. Claude Code gateway routing and reduction remain usable, but `memory_fault_recover` may be unavailable until MCP startup succeeds.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
