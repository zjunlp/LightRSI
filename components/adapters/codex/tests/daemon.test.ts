import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { reserveUnusedPort } from "@lightrsi/host-adapter";
import { daemonPaths, startDaemon, stopDaemon } from "../src/daemon.js";
import { normalizeTokenPilotCodexConfig, writeTokenPilotCodexConfig } from "../src/config.js";

test("startDaemon replaces a stale pid when the configured proxy port is unhealthy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-daemon-"));
  let dummy: ReturnType<typeof spawn> | undefined;
  try {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    const config = normalizeTokenPilotCodexConfig({
      proxyPort,
      stateDir,
      upstreamProvider: "OPENAI",
      upstream: {
        name: "OpenAI",
        baseUrl: "http://127.0.0.1:9",
        wireApi: "responses",
        requiresOpenAIAuth: true,
      },
    });
    await mkdir(stateDir, { recursive: true });
    await writeTokenPilotCodexConfig(config, configPath);

    dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const { pidPath, logPath } = daemonPaths(config);
    await writeFile(pidPath, `${dummy.pid}\n`, "utf8");

    const cliPath = join(process.cwd(), "dist", "cli.js");
    const result = await startDaemon(config, {
      configPath,
      cliPath,
    });

    assert.equal(result.running, true);
    assert.equal(result.started, true);
    assert.notEqual(result.pid, dummy.pid);
    const persistedPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    assert.equal(persistedPid, result.pid);
    assert.match(await readFile(logPath, "utf8"), /proxy listening at http:\/\/127\.0\.0\.1:/);

    await stopDaemon(config);
  } finally {
    if (dummy?.pid) {
      try {
        process.kill(dummy.pid, "SIGKILL");
      } catch {
        // The stale process should already be gone.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("startDaemon waits for a healthy proxy when the wall clock jumps forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-daemon-monotonic-"));
  const originalDateNow = Date.now;
  let healthProbeClockCalls = 0;
  try {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    const config = normalizeTokenPilotCodexConfig({
      proxyPort,
      stateDir,
      upstreamProvider: "OPENAI",
      upstream: {
        name: "OpenAI",
        baseUrl: "http://127.0.0.1:9",
        wireApi: "responses",
        requiresOpenAIAuth: true,
      },
    });
    await mkdir(stateDir, { recursive: true });
    await writeTokenPilotCodexConfig(config, configPath);

    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => {
        const stack = new Error().stack ?? "";
        if (!stack.includes("waitForProxyHealthy")) return originalDateNow();
        healthProbeClockCalls += 1;
        return healthProbeClockCalls === 1 ? 1_000 : 12_000;
      },
    });

    const result = await startDaemon(config, {
      configPath,
      cliPath: join(process.cwd(), "dist", "cli.js"),
    });

    assert.equal(result.running, true);
    assert.equal(result.started, true);
    await stopDaemon(config);
  } finally {
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    await rm(dir, { recursive: true, force: true });
  }
});
