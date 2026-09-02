import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertCleanerInstallArtifacts,
  buildCleanerInstallPlan,
  cleanerInstallEnvironment,
  inspectCleanerInstallArtifacts,
  parseCleanerInstallArgs,
} from "../install-cleaner.mjs";

test("cleaner installer accepts only the supported Codex and Claude Code hosts", () => {
  assert.deepEqual(parseCleanerInstallArgs(["codex"]), {
    host: "codex",
    dryRun: false,
    skipBuild: false,
  });
  assert.deepEqual(parseCleanerInstallArgs(["claude-code", "--dry-run"]), {
    host: "claude-code",
    dryRun: true,
    skipBuild: false,
  });
  assert.throws(() => parseCleanerInstallArgs([]), /cleaner_install_host_missing/);
  assert.throws(() => parseCleanerInstallArgs(["openclaw"]), /cleaner_install_host_unsupported:openclaw/);
  assert.throws(() => parseCleanerInstallArgs(["codex", "--unknown"]), /cleaner_install_argument_unknown/);
});

test("cleaner installer builds the shared CLI and MCP before the selected adapter", () => {
  const root = resolve("/tmp/lightrsi-installer-fixture");
  const plan = buildCleanerInstallPlan(root, {
    host: "codex",
    dryRun: false,
    skipBuild: false,
  }, "linux");

  assert.deepEqual(
    plan.steps.slice(0, 3).map((step) => step.args),
    [
      ["pnpm", "--filter", "@lightrsi/cli", "build"],
      ["pnpm", "--filter", "@lightrsi/mcp", "build"],
      ["pnpm", "--filter", "@lightrsi/codex-adapter", "build"],
    ],
  );
  assert.equal(plan.steps.at(-1)?.kind, "install");
  assert.match(plan.steps.at(-1)?.args.at(-1) ?? "", /components[\\/]adapters[\\/]codex[\\/]dist[\\/]install-codex\.js$/);
  assert.deepEqual(plan.requiredArtifacts.map((path) => path.replaceAll("\\", "/")), [
    `${root.replaceAll("\\", "/")}/components/products/cli/dist/cli.js`,
    `${root.replaceAll("\\", "/")}/components/products/mcp/dist/server.js`,
    `${root.replaceAll("\\", "/")}/components/adapters/codex/dist/install-codex.js`,
  ]);
});

test("cleaner installer invokes Corepack through cmd.exe on Windows", () => {
  const plan = buildCleanerInstallPlan(resolve("C:\\lightrsi-installer-fixture"), {
    host: "codex",
    dryRun: false,
    skipBuild: false,
  }, "win32");

  assert.match(plan.steps[0]?.command ?? "", /cmd\.exe$/i);
  assert.deepEqual(plan.steps[0]?.args, [
    "/d",
    "/s",
    "/c",
    "corepack",
    "pnpm",
    "--filter",
    "@lightrsi/cli",
    "build",
  ]);
});

test("cleaner installer can reuse prebuilt Claude Code release assets", () => {
  const plan = buildCleanerInstallPlan(resolve("/tmp/lightrsi-installer-fixture"), {
    host: "claude-code",
    dryRun: false,
    skipBuild: true,
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.kind, "install");
  assert.match(plan.steps[0]?.args.at(-1) ?? "", /components[\\/]adapters[\\/]claude-code[\\/]dist[\\/]install-claude-code\.js$/);
  assert.match(plan.verifyCommands[0] ?? "", /^lightrsi claude-code doctor$/);
  assert.match(plan.verifyCommands[1] ?? "", /^lightrsi claude-code clean --help$/);
});

test("cleaner installer uses the existing Windows npm bin directory when it is already on PATH", () => {
  const appData = "C:\\Users\\tester\\AppData\\Roaming";
  const env = cleanerInstallEnvironment({
    APPDATA: appData,
    PATH: `C:\\Windows\\System32;${appData}\\npm`,
  }, "win32");

  assert.equal(env.LIGHTRSI_BIN_DIR, `${appData}\\npm`);
  assert.equal(env.PATH, `C:\\Windows\\System32;${appData}\\npm`);
});

test("cleaner installer preserves an explicit CLI bin directory", () => {
  const env = cleanerInstallEnvironment({
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    PATH: "C:\\Windows\\System32",
    LIGHTRSI_BIN_DIR: "D:\\tools\\bin",
  }, "win32");

  assert.equal(env.LIGHTRSI_BIN_DIR, "D:\\tools\\bin");
});

test("cleaner installer rejects missing or stale prebuilt artifacts before Host install", async () => {
  const root = await mkdtemp(join(tmpdir(), "lightrsi-cleaner-installer-stale-"));
  try {
    const plan = buildCleanerInstallPlan(root, {
      host: "codex",
      dryRun: false,
      skipBuild: true,
    });
    assert.throws(() => assertCleanerInstallArtifacts(plan), /cleaner_install_artifact_missing/);

    const cliSource = join(root, "components", "products", "cli", "src", "cli.ts");
    const files = [
      cliSource,
      ...plan.requiredArtifacts,
    ];
    for (const path of files) {
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, "fixture\n", "utf8");
    }
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    const newTime = new Date("2021-01-01T00:00:00.000Z");
    for (const artifact of plan.requiredArtifacts) await utimes(artifact, oldTime, oldTime);
    await utimes(cliSource, newTime, newTime);

    const inspection = inspectCleanerInstallArtifacts(plan);
    assert.deepEqual(inspection.missing, []);
    assert.deepEqual(inspection.stale, [{
      artifact: plan.requiredArtifacts[0],
      newestInput: cliSource,
    }]);
    assert.throws(() => assertCleanerInstallArtifacts(plan), /cleaner_install_artifact_stale/);

    await utimes(plan.requiredArtifacts[0], new Date("2022-01-01T00:00:00.000Z"), new Date("2022-01-01T00:00:00.000Z"));
    assert.doesNotThrow(() => assertCleanerInstallArtifacts(plan));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
