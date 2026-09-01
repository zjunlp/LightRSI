#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED = Object.freeze({
  dshVersion: "0.1.2-alpha.3",
  dshCommit: "dd6322d604e00eec1ba5e0c8541159906a21094a",
  nodeRange: "^22.19.0 || >=24.0.0",
});

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const adapterDirectory = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(adapterDirectory, "../../..");

function option(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return entry?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function corepackPnpm(args) {
  if (process.platform === "win32") {
    const entry = join(
      dirname(process.execPath),
      "node_modules",
      "corepack",
      "dist",
      "corepack.js",
    );

    assert.ok(existsSync(entry), `Corepack entry not found at ${entry}`);
    return { command: process.execPath, args: [entry, "pnpm", ...args] };
  }

  return { command: "corepack", args: ["pnpm", ...args] };
}

function printable(command, args) {
  return [command, ...args]
    .map((value) => (/\s/u.test(value) ? JSON.stringify(value) : value))
    .join(" ");
}

function run(command, args, options = {}) {
  process.stdout.write(`\n> ${printable(command, args)}\n`);

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });

  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) {
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    throw new Error(
      `${printable(command, args)} exited ${String(result.status)}\n${stdout}${stderr}`,
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function countTokenPilotRows(config) {
  return (config.match(/^\s*-?\s*id:\s*tokenpilot-dsh\s*$/gmu) ?? []).length;
}

function assertNodeVersion() {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((value) => Number(value));

  const supported = major >= 24 || (major === 22 && minor >= 19);

  assert.ok(
    supported,
    `Node ${process.versions.node} is outside ${SUPPORTED.nodeRange}`,
  );
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a dynamic Web port"));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(port);
      });
    });
  });
}

function canConnect(port) {
  return new Promise((resolveConnection) => {
    const socket = connect({ host: "127.0.0.1", port });

    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveConnection(false);
    });
    socket.once("error", () => resolveConnection(false));
  });
}

async function waitForPort(port, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DSH Web exited before opening port ${port}`);
    }

    if (await canConnect(port)) return;

    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }

  throw new Error(`DSH Web did not open port ${port} within ${timeoutMs} ms`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;

  child.kill("SIGTERM");

  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);

  if (child.exitCode === null) child.kill("SIGKILL");
}

function launcherArguments(dshCheckout, args) {
  return [
    "--import",
    "tsx/esm",
    join(dshCheckout, "apps", "cli", "src", "bin.ts"),
    ...args,
  ];
}

function latestTarball(directory) {
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith(".tgz"))
    .sort();

  assert.equal(candidates.length, 1, "adapter pack must produce one tarball");
  return join(directory, candidates[0]);
}

const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "TERM",
  "NO_COLOR",
];

function isolatedSmokeEnvironment(paths) {
  const environment = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }

  environment.HOME = paths.userHome;
  environment.USERPROFILE = paths.userHome;
  environment.DSH_HOME = paths.dshHome;
  environment.XDG_CONFIG_HOME = join(paths.root, "xdg-config");
  environment.XDG_DATA_HOME = join(paths.root, "xdg-data");
  environment.XDG_CACHE_HOME = join(paths.root, "xdg-cache");
  environment.APPDATA = join(paths.root, "appdata");
  environment.LOCALAPPDATA = join(paths.root, "localappdata");
  environment.DSH_TELEMETRY_DISABLED = "1";
  return environment;
}

async function main() {
  const checkoutOption = option("dsh-checkout") ?? process.env.DSH_CHECKOUT;

  assert.ok(
    checkoutOption,
    "provide --dsh-checkout=/absolute/path or set DSH_CHECKOUT",
  );

  const dshCheckout = resolve(checkoutOption);
  const allowUnknown = hasFlag("allow-unknown");
  const keepTemporaryHome = hasFlag("keep-temp");
  const packageJsonPath = join(dshCheckout, "package.json");

  assert.ok(existsSync(packageJsonPath), `${dshCheckout} is not a DSH checkout`);
  assert.ok(
    existsSync(join(dshCheckout, "node_modules")),
    "install the pinned DSH checkout with corepack pnpm install --frozen-lockfile",
  );

  assertNodeVersion();

  const dshPackage = readJson(packageJsonPath);
  const { stdout: commitOutput } = run(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: dshCheckout, capture: true },
  );
  const actualCommit = commitOutput.trim();
  const knownVersion =
    dshPackage.version === SUPPORTED.dshVersion &&
    actualCommit === SUPPORTED.dshCommit;

  if (!knownVersion) {
    process.stderr.write(
      `WARNING: unknown DSH ${String(dshPackage.version)} @ ${actualCommit}; ` +
        "TokenPilot mutation remains disabled.\n",
    );

    assert.ok(
      allowUnknown,
      "unknown DSH checkout; rerun with --allow-unknown for observation only",
    );
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "lightrsi-dsh-compat-"));
  const temporaryUserHome = join(temporaryRoot, "user-home");
  const dshHome = join(temporaryRoot, "dsh-home");
  const artifacts = join(temporaryRoot, "artifacts");
  mkdirSync(temporaryUserHome, { recursive: true });
  mkdirSync(artifacts, { recursive: true });

  const smokeEnvironment = isolatedSmokeEnvironment({
    root: temporaryRoot,
    userHome: temporaryUserHome,
    dshHome,
  });

  try {
    const typecheck = corepackPnpm([
      "--filter",
      "@lightrsi/deepseek-harness-adapter",
      "typecheck",
    ]);
    run(typecheck.command, typecheck.args, { cwd: repositoryRoot });

    const build = corepackPnpm([
      "--filter",
      "@lightrsi/deepseek-harness-adapter",
      "build",
    ]);
    run(build.command, build.args, { cwd: repositoryRoot });

    run(process.execPath, [
      "--import",
      "tsx",
      "--test",
      "tests/projection-commands.test.ts",
      "tests/persistence-restart.test.ts",
    ], { cwd: adapterDirectory });

    const pack = corepackPnpm([
      "--filter",
      "@lightrsi/deepseek-harness-adapter",
      "pack",
      "--pack-destination",
      artifacts,
    ]);
    run(pack.command, pack.args, { cwd: repositoryRoot });

    const tarball = latestTarball(artifacts);

    const dshBuild = corepackPnpm(["run", "build"]);
    run(dshBuild.command, dshBuild.args, {
      cwd: dshCheckout,
      env: smokeEnvironment,
    });

    const dshKeylessSmoke = corepackPnpm([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.e2e.config.ts",
      "apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts",
    ]);
    run(dshKeylessSmoke.command, dshKeylessSmoke.args, {
      cwd: dshCheckout,
      env: smokeEnvironment,
    });

    const dsh = (args, capture = false) => run(
      process.execPath,
      launcherArguments(dshCheckout, args),
      {
        cwd: dshCheckout,
        env: smokeEnvironment,
        capture,
      },
    );

    for (const profile of ["web", "headless"]) {
      dsh(["plugin", "--profile", profile, "add", tarball]);
      dsh(["plugin", "--profile", profile, "add", tarball]);

      const dump = dsh(["--profile", profile, "--dump-config"], true).stdout;

      assert.equal(
        countTokenPilotRows(dump),
        1,
        `${profile} must contain exactly one tokenpilot-dsh row`,
      );
    }

    const port = await reservePort();

    const web = spawn(
      process.execPath,
      launcherArguments(dshCheckout, [
        "web",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--trusted-host",
        "127.0.0.1",
      ]),
      {
        cwd: dshCheckout,
        env: smokeEnvironment,
        stdio: "ignore",
        windowsHide: true,
      },
    );

    try {
      await waitForPort(port, web);
    } finally {
      await stopChild(web);
    }

    for (const profile of ["web", "headless"]) {
      dsh([
        "plugin",
        "--profile",
        profile,
        "remove",
        "@lightrsi/deepseek-harness-adapter",
      ]);

      const dump = dsh(["--profile", profile, "--dump-config"], true).stdout;

      assert.equal(
        countTokenPilotRows(dump),
        0,
        `${profile} must not retain tokenpilot-dsh after remove`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "pass",
        dshVersion: dshPackage.version,
        dshCommit: actualCommit,
        knownVersion,
        mutationEnabled: false,
        temporaryUserHome,
        temporaryDshHome: dshHome,
      }, null, 2)}\n`,
    );
  } finally {
    if (keepTemporaryHome) {
      process.stdout.write(
        `Temporary smoke root retained at ${temporaryRoot}\n`,
      );
    } else {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
