import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import process from "node:process";

const execFileAsync = promisify(execFile);
const archivePath = resolve(process.argv[2] ?? "");
const host = String(process.argv[3] ?? "").trim();
const expectedVersion = String(process.argv[4] ?? "").trim();

if (!process.argv[2] || !["codex", "claude-code"].includes(host) || !expectedVersion) {
  throw new Error("Usage: node smoke-host-package.mjs <archive.tgz> <codex|claude-code> <version>");
}

const expectedPackageName = `@lightrsi/${host}-adapter`;
const installEntry = host === "codex" ? "install-codex.js" : "install-claude-code.js";
const hostCliName = host === "codex" ? "tokenpilot-codex" : "tokenpilot-claude-code";
const tarCommand = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";
const extractDir = await mkdtemp(join(tmpdir(), `lightrsi-${host}-release-smoke-`));

async function assertInstalledBin(binPath, targetPath) {
  const entry = await lstat(binPath);
  if (entry.isSymbolicLink()) {
    assert.equal(await readlink(binPath), targetPath);
    return;
  }
  assert.equal(entry.isFile(), true);
  assert.deepEqual(await readFile(binPath), await readFile(targetPath));
}

try {
  await execFileAsync(tarCommand, ["-xzf", archivePath, "-C", extractDir]);
  const packageDir = join(extractDir, "package");
  const distDir = join(packageDir, "dist");
  const homeDir = join(extractDir, "home");
  const binDir = join(homeDir, ".local", "bin");
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

  assert.equal(manifest.name, expectedPackageName);
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  for (const file of ["index.js", "cli.js", "hooks-handler.js", installEntry, "lightrsi.js", "lightmem2.js", "mcp-server.js"]) {
    await readFile(join(distDir, file));
  }

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    LIGHTRSI_BIN_DIR: binDir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  let hostConfigPath;
  let auxiliaryConfigPath;
  if (host === "codex") {
    hostConfigPath = join(homeDir, ".codex", "config.toml");
    auxiliaryConfigPath = join(homeDir, ".codex", "hooks.json");
    env.CODEX_CONFIG_PATH = hostConfigPath;
    env.CODEX_HOOKS_CONFIG_PATH = auxiliaryConfigPath;
    env.TOKENPILOT_CODEX_CONFIG = join(homeDir, ".codex", "tokenpilot.json");
  } else {
    hostConfigPath = join(homeDir, ".claude", "settings.json");
    auxiliaryConfigPath = join(homeDir, ".claude.json");
    env.CLAUDE_CODE_SETTINGS_PATH = hostConfigPath;
    env.CLAUDE_CODE_MCP_CONFIG_PATH = auxiliaryConfigPath;
    env.TOKENPILOT_CLAUDE_CODE_CONFIG = join(homeDir, ".claude", "tokenpilot.json");
  }

  await execFileAsync(process.execPath, [join(distDir, installEntry)], {
    cwd: packageDir,
    env,
    timeout: 45_000,
  });

  const hostConfig = await readFile(hostConfigPath, "utf8");
  const auxiliaryConfig = await readFile(auxiliaryConfigPath, "utf8");
  const installedConfig = `${hostConfig}\n${auxiliaryConfig}`.replace(/\\+/g, "/");
  const normalizedDistDir = distDir.replace(/\\+/g, "/");
  const hookEntry = process.platform === "win32" && host === "codex"
    ? "tokenpilot-codex-hook.cmd"
    : "hooks-handler.js";
  assert.match(installedConfig, new RegExp(`${normalizedDistDir}/${hookEntry}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(installedConfig, new RegExp(`${normalizedDistDir}/mcp-server.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await assertInstalledBin(join(binDir, "lightrsi"), join(distDir, "lightrsi.js"));
  await assertInstalledBin(join(binDir, "lightmem2"), join(distDir, "lightrsi.js"));
  await assertInstalledBin(join(binDir, hostCliName), join(distDir, "cli.js"));
  if (process.platform === "win32") {
    assert.match(await readFile(join(binDir, "lightrsi.cmd"), "utf8"), /lightrsi\.js" %\*/);
    assert.match(await readFile(join(binDir, `${hostCliName}.cmd`), "utf8"), /cli\.js" %\*/);
  }

  const skillsRoot = host === "codex" ? join(homeDir, ".codex", "skills") : join(homeDir, ".claude", "skills");
  const skill = (await readFile(join(skillsRoot, "lightrsi-doctor", "SKILL.md"), "utf8")).replace(/\\+/g, "/");
  assert.match(skill, new RegExp(`${normalizedDistDir}/lightrsi.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const cleanerSkill = (await readFile(join(skillsRoot, "lightrsi-clean", "SKILL.md"), "utf8")).replace(/\\+/g, "/");
  assert.match(cleanerSkill, new RegExp(`^   lightrsi ${host} clean$`, "m"));
  assert.doesNotMatch(cleanerSkill, new RegExp(`^   lightrsi ${host} clean\\s+--`, "m"));
  assert.match(cleanerSkill, /Never choose task IDs, item IDs, item digests, or deletion ranges/);
  assert.match(cleanerSkill, /Never answer the confirmation prompt or run a follow-up command/);

  const loaded = await import(pathToFileURL(join(distDir, "index.js")).href);
  assert.ok(Object.keys(loaded).length > 0);
  process.stdout.write(`${host} release smoke passed: ${archivePath}\n`);
} finally {
  await rm(extractDir, { recursive: true, force: true });
}
