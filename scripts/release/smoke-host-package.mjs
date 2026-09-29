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
let cleanupCodexCliPath;
let cleanupEnvironment;

async function assertInstalledBin(binPath, targetPath) {
  const entry = await lstat(binPath);
  if (entry.isSymbolicLink()) {
    assert.equal(await readlink(binPath), targetPath);
    return;
  }
  assert.equal(entry.isFile(), true);
  assert.deepEqual(await readFile(binPath), await readFile(targetPath));
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
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
  const requiredDistFiles = [
    "index.js",
    "cli.js",
    "hooks-handler.js",
    installEntry,
    "lightrsi.js",
    "lightmem2.js",
    "mcp-server.js",
  ];
  if (host === "codex") requiredDistFiles.push("cleaner-mcp-server.js");
  for (const file of requiredDistFiles) {
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
    cleanupCodexCliPath = join(distDir, "cli.js");
    cleanupEnvironment = env;
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
    ? "tokenpilot-codex-hook.ps1"
    : "hooks-handler.js";
  assert.match(installedConfig, new RegExp(`${normalizedDistDir}/${hookEntry}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(installedConfig, new RegExp(`${normalizedDistDir}/mcp-server.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  if (host === "codex") {
    assert.match(
      installedConfig,
      new RegExp(`${normalizedDistDir}/cleaner-mcp-server.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  await assertInstalledBin(join(binDir, "lightrsi"), join(distDir, "lightrsi.js"));
  await assertInstalledBin(join(binDir, "lightmem2"), join(distDir, "lightrsi.js"));
  await assertInstalledBin(join(binDir, hostCliName), join(distDir, "cli.js"));
  if (process.platform === "win32") {
    for (const commandName of ["lightrsi", "lightmem2", hostCliName]) {
      const cmd = await readFile(join(binDir, `${commandName}.cmd`), "ascii");
      assert.match(cmd, /powershell\.exe .*"%~dpn0\.ps1" %\*/i);
      const powerShell = await readFile(join(binDir, `${commandName}.ps1`));
      assert.deepEqual([...powerShell.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    }
    const sharedPowerShell = await readFile(join(binDir, "lightrsi.ps1"), "utf8");
    const hostPowerShell = await readFile(join(binDir, `${hostCliName}.ps1`), "utf8");
    assert.match(sharedPowerShell.replace(/\\+/g, "/"), new RegExp(`${normalizedDistDir}/lightrsi.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(hostPowerShell.replace(/\\+/g, "/"), new RegExp(`${normalizedDistDir}/cli.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const windowsPowerShell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = await execFileAsync(windowsPowerShell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& ${quotePowerShellLiteral(join(binDir, "lightrsi.cmd"))} ${host} clean --help`,
    ], { env, timeout: 45_000 });
    assert.match(result.stdout, /lightrsi <host> clean/);
  }

  const skillsRoot = host === "codex" ? join(homeDir, ".codex", "skills") : join(homeDir, ".claude", "skills");
  const skill = (await readFile(join(skillsRoot, "lightrsi-doctor", "SKILL.md"), "utf8")).replace(/\\+/g, "/");
  assert.match(skill, new RegExp(`${normalizedDistDir}/lightrsi.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const cleanerSkill = (await readFile(join(skillsRoot, "lightrsi-clean", "SKILL.md"), "utf8")).replace(/\\+/g, "/");
  if (host === "codex") {
    assert.match(cleanerSkill, /Call `lightrsi_cleaner\.lightrsi_clean` exactly once with an empty input object/);
    assert.match(cleanerSkill, /Do not run a shell command or invoke the LightRSI CLI/);
    assert.match(cleanerSkill, /Do not supply, infer, or rewrite plan IDs, task IDs, item IDs, item digests, or deletion ranges/);
    assert.doesNotMatch(cleanerSkill, /^\s*lightrsi codex clean(?:\s|$)/m);
  } else {
    assert.match(cleanerSkill, new RegExp(`^   lightrsi ${host} clean$`, "m"));
    assert.ok(
      cleanerSkill.indexOf(normalizedDistDir) < cleanerSkill.indexOf(`   lightrsi ${host} clean`),
      "installed skill must prefer the version-pinned bundled CLI",
    );
    assert.doesNotMatch(cleanerSkill, new RegExp(`^   lightrsi ${host} clean\\s+--`, "m"));
    assert.match(cleanerSkill, /Never choose task IDs, item IDs, item digests, or deletion ranges/);
    assert.match(cleanerSkill, /Never answer the confirmation prompt or run a follow-up command/);
    assert.match(cleanerSkill, /Same-terminal interactive selection/);
    assert.match(cleanerSkill, /user must run `\/exit`/);
    assert.match(cleanerSkill, /lightrsi claude-code clean --require-tty --session <session-id>/);
    assert.match(cleanerSkill, /claude --resume <session-id>/);
    assert.match(cleanerSkill, /next ordinary Claude Code request/);
  }
  const cleanerStatusSkill = (await readFile(join(skillsRoot, "lightrsi-clean-status", "SKILL.md"), "utf8")).replace(/\\+/g, "/");
  assert.match(cleanerStatusSkill, new RegExp(`^   lightrsi ${host} clean --status <plan-id>$`, "m"));
  assert.match(cleanerStatusSkill, new RegExp(`${normalizedDistDir}/lightrsi.js`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const cleanerApplySkill = await readFile(join(skillsRoot, "lightrsi-clean-apply", "SKILL.md"), "utf8");
  assert.match(cleanerApplySkill, new RegExp(`^   lightrsi ${host} clean --plan <plan-id> --select <task-id\\[,task-id\\.\\.\\.\\]>$`, "m"));
  assert.match(cleanerApplySkill, /Explicit invocation with both the plan ID and task IDs is approval/);
  const cleanerCancelSkill = await readFile(join(skillsRoot, "lightrsi-clean-cancel", "SKILL.md"), "utf8");
  assert.match(cleanerCancelSkill, new RegExp(`^   lightrsi ${host} clean --cancel <plan-id>$`, "m"));
  assert.match(cleanerCancelSkill, /approval to cancel only that exact plan/);

  const loaded = await import(pathToFileURL(join(distDir, "index.js")).href);
  assert.ok(Object.keys(loaded).length > 0);
  process.stdout.write(`${host} release smoke passed: ${archivePath}\n`);
} finally {
  if (cleanupCodexCliPath && cleanupEnvironment) {
    await execFileAsync(process.execPath, [cleanupCodexCliPath, "stop"], {
      env: cleanupEnvironment,
      timeout: 15_000,
    }).catch(() => undefined);
  }
  await rm(extractDir, { recursive: true, force: true });
}
