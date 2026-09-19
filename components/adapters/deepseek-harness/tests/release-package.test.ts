import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(import.meta.dirname, "..");
const tarCommand = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

test("packed DSH bundle resolves through its package entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-dsh-release-"));
  try {
    const npmArgs = [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      root,
    ];
    const packed = process.platform === "win32"
      ? await execFileAsync(
        process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        ["/d", "/s", "/c", "npm.cmd", ...npmArgs],
        { cwd: packageDir },
      )
      : await execFileAsync("npm", npmArgs, { cwd: packageDir });
    const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const archive = join(root, result[0]!.filename);
    const installedDir = join(
      root,
      "node_modules",
      "@lightrsi",
      "deepseek-harness-adapter",
    );
    await mkdir(dirname(installedDir), { recursive: true });
    await execFileAsync(tarCommand, ["-xzf", archive, "-C", dirname(installedDir)]);
    await rename(join(dirname(installedDir), "package"), installedDir);

    const manifest = JSON.parse(
      await readFile(join(installedDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifest.main, "./dist/index.js");
    for (const internalDependency of [
      "@lightrsi/cleaner",
      "@lightrsi/eviction",
      "@lightrsi/history",
      "@lightrsi/host-adapter",
      "@lightrsi/product-surface",
    ]) {
      assert.equal(
        (manifest.dependencies as Record<string, unknown> | undefined)?.[internalDependency],
        undefined,
        `${internalDependency} must be bundled rather than installed from npm`,
      );
    }
    assert.equal(
      await readFile(join(installedDir, "cordis.patch.yml"), "utf8")
        .then((value) => value.includes("@lightrsi/deepseek-harness-adapter")),
      true,
    );

    const require = createRequire(join(root, "consumer.mjs"));
    const entry = require.resolve("@lightrsi/deepseek-harness-adapter");
    const plugin = await import(pathToFileURL(entry).href) as {
      name: string;
      inject: readonly string[];
      apply(ctx: { inject(services: readonly string[], callback: (scope: unknown) => void): void }, config: unknown): void;
    };
    const events: string[] = [];
    const commands: string[] = [];
    const commandScope = {
      commands: {
        register(definition: { name: string }) {
          commands.push(definition.name);
          return () => {};
        },
      },
      inject(services: readonly string[], callback: (scope: unknown) => void) {
        if (services.includes("sessions")) callback({ sessions: { list: () => [], get: () => undefined } });
        if (services.includes("sessionProjections")) {
          callback({
            sessionProjections: {
              register: () => () => {},
              snapshot: () => ({ asOfSeq: -1, values: {} }),
            },
          });
        }
      },
    };
    plugin.apply({
      inject(services, callback) {
        if (services.includes("commands")) callback(commandScope);
        if (services.includes("tokenMeter")) {
          callback({
            on(event: string) { events.push(event); },
            tokenMeter: { measure: () => ({}) },
          });
        }
      },
    }, {
      enabled: true,
      stateDir: "C:/tmp/lightrsi-release-test",
      eviction: { enabled: true },
      taskStateEstimator: {
        enabled: true,
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        model: "test-model",
      },
    });
    assert.equal(plugin.name, "tokenpilot-dsh");
    assert.deepEqual(plugin.inject, []);
    assert.equal("default" in plugin, false);
    assert.deepEqual(events, ["agent/pre-step", "agent/pre-step"]);
    assert.deepEqual(commands.sort(), ["context-cleaner", "tokenpilot-clean", "tokenpilot-status"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
