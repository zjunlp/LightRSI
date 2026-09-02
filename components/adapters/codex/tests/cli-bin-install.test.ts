import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { installLightRsiCliBin } from "../../shared/cli-bin-install.js";
import { installHostCliBin } from "../../shared/host-cli-bin-install.js";

const execFileAsync = promisify(execFile);

test("CLI bin installer writes Windows command launchers for the shared and host CLIs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-windows-cli-bin-"));
  try {
    const adapterRoot = join(dir, "components", "adapters", "codex");
    const distDir = join(adapterRoot, "dist");
    const binDir = join(dir, "bin");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "lightrsi.js"), "#!/usr/bin/env node\n", "utf8");
    await writeFile(join(distDir, "cli.js"), "#!/usr/bin/env node\n", "utf8");

    const shared = await installLightRsiCliBin({
      adapterRoot,
      binDir,
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });
    const host = await installHostCliBin({
      adapterRoot,
      host: "codex",
      binDir,
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });

    assert.equal(shared.launcherPath, join(binDir, "lightrsi.cmd"));
    assert.equal(shared.legacyLauncherPath, join(binDir, "lightmem2.cmd"));
    assert.equal(host.launcherPath, join(binDir, "tokenpilot-codex.cmd"));
    assert.match(await readFile(shared.launcherPath!, "utf8"), /"C:\\Program Files\\nodejs\\node\.exe" .*lightrsi\.js" %\*/);
    assert.match(await readFile(shared.legacyLauncherPath!, "utf8"), /lightrsi\.js" %\*/);
    assert.match(await readFile(host.launcherPath!, "utf8"), /cli\.js" %\*/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI bin installer honors LIGHTRSI_BIN_DIR when no explicit directory is passed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-bin-env-"));
  const previous = process.env.LIGHTRSI_BIN_DIR;
  try {
    const adapterRoot = join(dir, "components", "adapters", "codex");
    const distDir = join(adapterRoot, "dist");
    const configuredBinDir = join(dir, "configured-bin");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "lightrsi.js"), "#!/usr/bin/env node\n", "utf8");
    process.env.LIGHTRSI_BIN_DIR = configuredBinDir;

    const result = await installLightRsiCliBin({ adapterRoot });

    assert.equal(result.binDir, configuredBinDir);
    assert.equal(result.binPath, join(configuredBinDir, "lightrsi"));
  } finally {
    if (previous === undefined) delete process.env.LIGHTRSI_BIN_DIR;
    else process.env.LIGHTRSI_BIN_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows command launchers execute shared and Host CLIs with forwarded arguments", {
  skip: process.platform !== "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi windows launcher "));
  try {
    const adapterRoot = join(dir, "adapter with spaces");
    const distDir = join(adapterRoot, "dist");
    const binDir = join(dir, "bin with spaces");
    const sharedLog = join(dir, "shared.json");
    const hostLog = join(dir, "host.json");
    await mkdir(distDir, { recursive: true });
    const fakeCli = 'require("node:fs").writeFileSync(process.env.LIGHTRSI_LAUNCHER_LOG, JSON.stringify(process.argv.slice(2)));\n';
    await writeFile(join(distDir, "lightrsi.js"), fakeCli, "utf8");
    await writeFile(join(distDir, "cli.js"), fakeCli, "utf8");

    const shared = await installLightRsiCliBin({ adapterRoot, binDir, platform: "win32" });
    const host = await installHostCliBin({ adapterRoot, host: "codex", binDir, platform: "win32" });
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await execFileAsync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& ${quotePowerShell(shared.launcherPath!)} codex clean --help`,
    ], {
      env: { ...process.env, LIGHTRSI_LAUNCHER_LOG: sharedLog },
    });
    await execFileAsync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& ${quotePowerShell(host.launcherPath!)} doctor`,
    ], {
      env: { ...process.env, LIGHTRSI_LAUNCHER_LOG: hostLog },
    });

    assert.deepEqual(JSON.parse(await readFile(sharedLog, "utf8")), ["codex", "clean", "--help"]);
    assert.deepEqual(JSON.parse(await readFile(hostLog, "utf8")), ["doctor"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
