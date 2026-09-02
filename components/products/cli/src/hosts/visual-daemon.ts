import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { resolveCliHomeDir } from "../context-store.js";

const DEFAULT_VISUAL_DAEMON_STARTUP_TIMEOUT_MS = 15_000;

function childProcessExecArgv(): string[] {
  return process.execArgv.filter((arg) => arg !== "--test");
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

async function waitForVisualServer(url: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const resp = await fetch(`${url}/health`);
      if (resp.ok) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function readJsonMeta<TMeta>(metaPath: string): Promise<TMeta | undefined> {
  try {
    if (!existsSync(metaPath)) return undefined;
    return JSON.parse(await readFile(metaPath, "utf8")) as TMeta;
  } catch {
    return undefined;
  }
}

export function resolveCliEntryPathFromHostModule(hostModulePath: string): string {
  const normalizedPath = String(hostModulePath || "").trim();
  if (!normalizedPath) {
    throw new Error("Unable to resolve CLI entry from an empty host module path");
  }

  const directDistCli = join(dirname(normalizedPath), "cli.js");
  if (basename(normalizedPath) === "cli.js" && existsSync(normalizedPath)) {
    return normalizedPath;
  }
  if (basename(normalizedPath) === "cli.ts" && directDistCli !== normalizedPath && existsSync(directDistCli)) {
    return directDistCli;
  }

  let current = dirname(normalizedPath);
  for (let i = 0; i < 8; i += 1) {
    const distCliPath = join(current, "dist", "cli.js");
    if (existsSync(distCliPath)) return distCliPath;

    const siblingCliPath = join(current, "cli.js");
    if (existsSync(siblingCliPath)) return siblingCliPath;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`Unable to resolve CLI entry from ${hostModulePath}`);
}

export function sharedVisualRootDir(): string {
  return join(resolveCliHomeDir(), ".lightrsi", "state");
}

export function sharedVisualPidPath(): string {
  return join(sharedVisualRootDir(), "visual-server.pid");
}

export function sharedVisualMetaPath(): string {
  return join(sharedVisualRootDir(), "visual-server.json");
}

export function sharedVisualLogPath(): string {
  return join(sharedVisualRootDir(), "visual-server.log");
}

export function singleHostVisualPidPath(stateDir: string): string {
  return join(stateDir, "visual-server.pid");
}

export function singleHostVisualMetaPath(stateDir: string): string {
  return join(stateDir, "visual-server.json");
}

export function singleHostVisualLogPath(stateDir: string): string {
  return join(stateDir, "visual-server.log");
}

export async function ensureDetachedVisualDaemon<TMeta>(params: {
  daemonArgs: string[];
  metaPath: string;
  pidPath: string;
  logPath: string;
  expectedSignature: string;
  readSignature(meta: TMeta | undefined): string | undefined;
  readUrl(meta: TMeta | undefined): string | undefined;
  readPid(meta: TMeta | undefined): number | undefined;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_VISUAL_DAEMON_STARTUP_TIMEOUT_MS;
  const currentMeta = await readJsonMeta<TMeta>(params.metaPath);
  const currentUrl = params.readUrl(currentMeta);
  const currentPid = Number(params.readPid(currentMeta) ?? 0);
  const currentSignature = params.readSignature(currentMeta);
  if (
    currentUrl
    && currentPid > 0
    && isProcessRunning(currentPid)
    && currentSignature === params.expectedSignature
  ) {
    const healthy = await waitForVisualServer(currentUrl, 500);
    if (healthy) return currentUrl;
  }

  await mkdir(dirname(params.metaPath), { recursive: true });
  await mkdir(dirname(params.pidPath), { recursive: true });
  await mkdir(dirname(params.logPath), { recursive: true });
  const log = await open(params.logPath, "a");
  const child = spawn(process.execPath, [...childProcessExecArgv(), ...params.daemonArgs], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: process.env,
  });
  child.unref();
  await log.close().catch(() => undefined);
  await writeFile(params.pidPath, `${child.pid}\n`, "utf8");

  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const parsed = await readJsonMeta<TMeta>(params.metaPath);
    const parsedUrl = params.readUrl(parsed);
    const parsedPid = Number(params.readPid(parsed) ?? 0);
    const parsedSignature = params.readSignature(parsed);
    if (
      parsedUrl
      && parsedPid === child.pid
      && parsedSignature === params.expectedSignature
    ) {
      const healthy = await waitForVisualServer(parsedUrl, 1000);
      if (healthy) return parsedUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (isProcessRunning(child.pid ?? 0)) {
    try {
      process.kill(child.pid ?? 0, "SIGTERM");
    } catch {
      // ignore
    }
  }
  await rm(params.pidPath, { force: true }).catch(() => undefined);
  throw new Error(`Failed to start visual daemon for ${params.expectedSignature}`);
}
