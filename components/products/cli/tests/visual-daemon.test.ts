import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureDetachedVisualDaemon,
  resolveCliEntryPathFromHostModule,
} from "../src/hosts/visual-daemon.js";

test("resolveCliEntryPathFromHostModule finds dist/cli.js from a src host module path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-visual-daemon-src-"));
  try {
    const distDir = join(dir, "dist");
    const srcHostsDir = join(dir, "src", "hosts");
    await mkdir(distDir, { recursive: true });
    await mkdir(srcHostsDir, { recursive: true });
    await writeFile(join(distDir, "cli.js"), "module.exports = {};\n", "utf8");

    const resolved = resolveCliEntryPathFromHostModule(join(srcHostsDir, "visual.ts"));
    assert.equal(resolved, join(distDir, "cli.js"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveCliEntryPathFromHostModule recovers from an old wrong products/cli/cli.js path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-visual-daemon-wrong-cli-"));
  try {
    const distDir = join(dir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "cli.js"), "module.exports = {};\n", "utf8");

    const resolved = resolveCliEntryPathFromHostModule(join(dir, "cli.js"));
    assert.equal(resolved, join(distDir, "cli.js"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDetachedVisualDaemon keeps waiting when the wall clock jumps forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-visual-daemon-clock-"));
  const metaPath = join(dir, "visual-server.json");
  const pidPath = join(dir, "visual-server.pid");
  const logPath = join(dir, "visual-server.log");
  const originalDateNow = Date.now;
  let wallClockCall = 0;

  const daemonScript = [
    'const { createServer } = require("node:http");',
    'const { writeFileSync } = require("node:fs");',
    'const metaPath = process.argv[1];',
    'const server = createServer((request, response) => {',
    '  response.writeHead(request.url === "/health" ? 200 : 404);',
    '  response.end();',
    '});',
    'server.listen(0, "127.0.0.1", () => {',
    '  const address = server.address();',
    '  writeFileSync(metaPath, JSON.stringify({',
    '    url: `http://127.0.0.1:${address.port}`,',
    '    pid: process.pid,',
    '    signature: "clock-test",',
    '  }));',
    '});',
  ].join("\n");

  Object.defineProperty(Date, "now", {
    configurable: true,
    value: () => {
      wallClockCall += 1;
      return wallClockCall === 1 ? 1_000 : 12_000;
    },
  });

  try {
    const url = await ensureDetachedVisualDaemon<{ url?: string; pid?: number; signature?: string }>({
      daemonArgs: ["-e", daemonScript, metaPath],
      metaPath,
      pidPath,
      logPath,
      expectedSignature: "clock-test",
      readSignature(meta) {
        return meta?.signature;
      },
      readUrl(meta) {
        return meta?.url;
      },
      readPid(meta) {
        return meta?.pid;
      },
      timeoutMs: 1_000,
    });

    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The daemon may already have been terminated by the startup helper.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDetachedVisualDaemon tolerates a cold daemon start during a busy test run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-visual-daemon-cold-start-"));
  const metaPath = join(dir, "visual-server.json");
  const pidPath = join(dir, "visual-server.pid");
  const logPath = join(dir, "visual-server.log");
  const daemonScript = [
    'const { createServer } = require("node:http");',
    'const { writeFileSync } = require("node:fs");',
    'const metaPath = process.argv[1];',
    'const delayMs = Number(process.argv[2]);',
    'const server = createServer((request, response) => {',
    '  response.writeHead(request.url === "/health" ? 200 : 404);',
    '  response.end();',
    '});',
    'setTimeout(() => server.listen(0, "127.0.0.1", () => {',
    '  const address = server.address();',
    '  writeFileSync(metaPath, JSON.stringify({',
    '    url: `http://127.0.0.1:${address.port}`,',
    '    pid: process.pid,',
    '    signature: "cold-start-test",',
    '  }));',
    '}), delayMs);',
  ].join("\n");

  try {
    const url = await ensureDetachedVisualDaemon<{ url?: string; pid?: number; signature?: string }>({
      daemonArgs: ["-e", daemonScript, metaPath, "5200"],
      metaPath,
      pidPath,
      logPath,
      expectedSignature: "cold-start-test",
      readSignature(meta) {
        return meta?.signature;
      },
      readUrl(meta) {
        return meta?.url;
      },
      readPid(meta) {
        return meta?.pid;
      },
    });

    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The daemon may already have been terminated by the startup helper.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
