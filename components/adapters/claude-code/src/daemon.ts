import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { TokenPilotClaudeCodeConfig } from "./config.js";

export type ClaudeCodeDaemonStatus = {
  running: boolean;
  pid?: number;
  pidPath: string;
  logPath: string;
  detectedBy?: "pid" | "health";
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function claudeCodeDaemonPaths(config: TokenPilotClaudeCodeConfig): {
  pidPath: string;
  logPath: string;
} {
  return {
    pidPath: join(config.stateDir, "tokenpilot-claude-code.pid"),
    logPath: join(config.stateDir, "tokenpilot-claude-code.log"),
  };
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isGatewayHealthy(config: TokenPilotClaudeCodeConfig): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${config.proxyPort}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForGatewayHealthy(config: TokenPilotClaudeCodeConfig, params?: {
  timeoutMs?: number;
  intervalMs?: number;
  pid?: number;
}): Promise<boolean> {
  const timeoutMs = params?.timeoutMs ?? 5_000;
  const intervalMs = params?.intervalMs ?? 150;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (await isGatewayHealthy(config)) return true;
    if (params?.pid && !isProcessRunning(params.pid)) return false;
    await sleep(intervalMs);
  }
  return false;
}

export async function readClaudeCodeDaemonStatus(config: TokenPilotClaudeCodeConfig): Promise<ClaudeCodeDaemonStatus> {
  const { pidPath, logPath } = claudeCodeDaemonPaths(config);
  if (!existsSync(pidPath)) {
    if (await isGatewayHealthy(config)) {
      return { running: true, pidPath, logPath, detectedBy: "health" };
    }
    return { running: false, pidPath, logPath };
  }
  const raw = await readFile(pidPath, "utf8").catch(() => "");
  const pid = Number.parseInt(raw.trim(), 10);
  if (!isProcessRunning(pid)) {
    await rm(pidPath, { force: true }).catch(() => undefined);
    return { running: false, pidPath, logPath };
  }
  return { running: true, pid, pidPath, logPath, detectedBy: "pid" };
}

export async function startClaudeCodeDaemon(config: TokenPilotClaudeCodeConfig, params?: {
  configPath?: string;
  nodePath?: string;
  cliPath?: string;
  cliArgs?: string[];
}): Promise<ClaudeCodeDaemonStatus & { started: boolean }> {
  const current = await readClaudeCodeDaemonStatus(config);
  if (current.running) return { ...current, started: false };

  const { pidPath, logPath } = claudeCodeDaemonPaths(config);
  await mkdir(dirname(pidPath), { recursive: true });
  const out = await open(logPath, "a");
  const err = await open(logPath, "a");
  const cliArgs = params?.cliArgs ?? [(params?.cliPath ?? process.argv[1]), "serve"];
  const child = spawn(params?.nodePath ?? process.execPath, cliArgs, {
    detached: true,
    stdio: ["ignore", out.fd, err.fd],
    env: {
      ...process.env,
      ...(params?.configPath ? { TOKENPILOT_CLAUDE_CODE_CONFIG: params.configPath } : {}),
    },
  });
  child.unref();
  await writeFile(pidPath, `${child.pid}\n`, "utf8");
  await out.close().catch(() => undefined);
  await err.close().catch(() => undefined);

  if (!await waitForGatewayHealthy(config, { pid: child.pid })) {
    if (isProcessRunning(child.pid ?? 0)) {
      try {
        process.kill(child.pid ?? 0, "SIGTERM");
      } catch {
        // Child may have exited while health probing timed out.
      }
    }
    await rm(pidPath, { force: true }).catch(() => undefined);
    throw new Error(`TokenPilot Claude Code gateway did not become healthy on port ${config.proxyPort}; see ${logPath}`);
  }

  return {
    running: true,
    pid: child.pid,
    pidPath,
    logPath,
    started: true,
  };
}

export async function stopClaudeCodeDaemon(config: TokenPilotClaudeCodeConfig): Promise<ClaudeCodeDaemonStatus & { stopped: boolean }> {
  const status = await readClaudeCodeDaemonStatus(config);
  if (!status.running || !status.pid) return { ...status, stopped: false };
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have exited between status read and stop.
  }
  await rm(status.pidPath, { force: true }).catch(() => undefined);
  return {
    ...status,
    running: false,
    stopped: true,
  };
}
