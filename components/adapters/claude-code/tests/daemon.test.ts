import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reserveUnusedPort } from "@lightrsi/host-adapter";
import { startClaudeCodeDaemon, stopClaudeCodeDaemon } from "../src/daemon.js";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";

test("startClaudeCodeDaemon waits for a healthy gateway when the wall clock jumps forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-daemon-monotonic-"));
  const originalDateNow = Date.now;
  let healthProbeClockCalls = 0;
  try {
    const proxyPort = await reserveUnusedPort();
    const config = normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: "http://127.0.0.1:9",
    });
    const serverScript = [
      'const { createServer } = require("node:http");',
      'createServer((request, response) => response.end("ok")).listen(process.argv[1], "127.0.0.1");',
    ].join("\n");

    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => {
        const stack = new Error().stack ?? "";
        if (!stack.includes("waitForGatewayHealthy")) return originalDateNow();
        healthProbeClockCalls += 1;
        return healthProbeClockCalls === 1 ? 1_000 : 12_000;
      },
    });

    const result = await startClaudeCodeDaemon(config, {
      cliArgs: ["-e", serverScript, String(proxyPort)],
    });

    assert.equal(result.running, true);
    assert.equal(result.started, true);
    await stopClaudeCodeDaemon(config);
  } finally {
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    await rm(dir, { recursive: true, force: true });
  }
});
