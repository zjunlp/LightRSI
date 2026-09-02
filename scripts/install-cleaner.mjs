#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_HOSTS = new Set(["codex", "claude-code"]);

const HOST_INSTALL = {
  codex: {
    packageName: "@lightrsi/codex-adapter",
    installer: ["components", "adapters", "codex", "dist", "install-codex.js"],
  },
  "claude-code": {
    packageName: "@lightrsi/claude-code-adapter",
    installer: ["components", "adapters", "claude-code", "dist", "install-claude-code.js"],
  },
};

export function cleanerInstallUsage() {
  return [
    "Usage:",
    "  node scripts/install-cleaner.mjs <codex|claude-code> [--skip-build] [--dry-run]",
    "",
    "This installs the selected Host adapter, shared lightrsi CLI, recovery MCP,",
    "and the constrained lightrsi-clean command skill.",
    "--skip-build accepts only complete artifacts newer than their source inputs.",
    "",
    "Environment overrides supported by the Host installers include:",
    "  LIGHTRSI_BIN_DIR",
    "  CODEX_CONFIG_PATH / CODEX_HOOKS_CONFIG_PATH / TOKENPILOT_CODEX_CONFIG",
    "  CLAUDE_CODE_SETTINGS_PATH / CLAUDE_CODE_MCP_CONFIG_PATH / TOKENPILOT_CLAUDE_CODE_CONFIG",
  ].join("\n");
}

export function parseCleanerInstallArgs(argv) {
  let host;
  let dryRun = false;
  let skipBuild = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`cleaner_install_argument_unknown:${arg}`);
    if (!host) {
      if (!SUPPORTED_HOSTS.has(arg)) throw new Error(`cleaner_install_host_unsupported:${arg}`);
      host = arg;
      continue;
    }
    throw new Error(`cleaner_install_argument_unknown:${arg}`);
  }

  if (!host) throw new Error("cleaner_install_host_missing");
  return { host, dryRun, skipBuild };
}

function corepackInvocation(platform) {
  if (platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", "corepack"],
    };
  }
  return { command: "corepack", argsPrefix: [] };
}

function comparablePath(value, platform) {
  if (platform === "win32") {
    return value.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase();
  }
  return resolve(value);
}

export function cleanerInstallEnvironment(sourceEnv = process.env, platform = process.platform) {
  const env = { ...sourceEnv };
  if (env.LIGHTRSI_BIN_DIR || env.LIGHTMEM2_BIN_DIR || platform !== "win32" || !env.APPDATA) {
    return env;
  }

  const npmBinDir = join(env.APPDATA, "npm");
  const npmBinKey = comparablePath(npmBinDir, platform);
  const pathContainsNpmBin = String(env.PATH ?? "")
    .split(";")
    .filter(Boolean)
    .some((entry) => comparablePath(entry, platform) === npmBinKey);
  if (pathContainsNpmBin) env.LIGHTRSI_BIN_DIR = npmBinDir;
  return env;
}

export function buildCleanerInstallPlan(repoRoot, options, platform = process.platform) {
  const root = resolve(repoRoot);
  const hostConfig = HOST_INSTALL[options.host];
  if (!hostConfig) throw new Error(`cleaner_install_host_unsupported:${options.host}`);

  const packagesRoot = join(root, "components", "packages");
  const sharedAdapterRoot = join(root, "components", "adapters", "shared");
  const cliRoot = join(root, "components", "products", "cli");
  const mcpRoot = join(root, "components", "products", "mcp");
  const adapterRoot = join(root, "components", "adapters", options.host);
  const cliArtifact = join(root, "components", "products", "cli", "dist", "cli.js");
  const mcpArtifact = join(root, "components", "products", "mcp", "dist", "server.js");
  const installerArtifact = join(root, ...hostConfig.installer);
  const corepack = corepackInvocation(platform);
  const buildSteps = options.skipBuild ? [] : [
    "@lightrsi/cli",
    "@lightrsi/mcp",
    hostConfig.packageName,
  ].map((packageName) => ({
    kind: "build",
    command: corepack.command,
    args: [...corepack.argsPrefix, "pnpm", "--filter", packageName, "build"],
  }));

  return {
    host: options.host,
    steps: [
      ...buildSteps,
      { kind: "install", command: process.execPath, args: [installerArtifact] },
    ],
    requiredArtifacts: [cliArtifact, mcpArtifact, installerArtifact],
    artifactFreshness: [
      {
        artifact: cliArtifact,
        inputs: [join(cliRoot, "src"), join(cliRoot, "build.ts"), join(cliRoot, "package.json"), packagesRoot],
      },
      {
        artifact: mcpArtifact,
        inputs: [join(mcpRoot, "src"), join(mcpRoot, "build.ts"), join(mcpRoot, "package.json"), packagesRoot],
      },
      {
        artifact: installerArtifact,
        inputs: [
          join(adapterRoot, "src"),
          join(adapterRoot, "scripts", options.host === "codex" ? "install-codex.ts" : "install-claude-code.ts"),
          join(adapterRoot, "build.ts"),
          join(adapterRoot, "package.json"),
          sharedAdapterRoot,
          packagesRoot,
        ],
      },
    ],
    verifyCommands: [
      `lightrsi ${options.host} doctor`,
      `lightrsi ${options.host} clean --help`,
    ],
  };
}

const IGNORED_BUILD_INPUT_DIRS = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "tests",
  "var",
]);
const BUILD_INPUT_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".ts", ".tsx"]);

function buildInputFiles(inputPath) {
  if (!existsSync(inputPath)) return [];
  const entry = statSync(inputPath);
  if (entry.isFile()) return [inputPath];
  if (!entry.isDirectory()) return [];

  const files = [];
  for (const child of readdirSync(inputPath, { withFileTypes: true })) {
    if (child.isDirectory() && IGNORED_BUILD_INPUT_DIRS.has(child.name)) continue;
    const childPath = join(inputPath, child.name);
    if (child.isDirectory()) {
      files.push(...buildInputFiles(childPath));
      continue;
    }
    const extension = child.name.slice(child.name.lastIndexOf("."));
    if (BUILD_INPUT_EXTENSIONS.has(extension)) files.push(childPath);
  }
  return files;
}

export function inspectCleanerInstallArtifacts(plan) {
  const missing = plan.requiredArtifacts.filter((path) => !existsSync(path));
  const stale = [];
  for (const check of plan.artifactFreshness ?? []) {
    if (!existsSync(check.artifact)) continue;
    const artifactMtimeMs = statSync(check.artifact).mtimeMs;
    let newestInput;
    let newestInputMtimeMs = Number.NEGATIVE_INFINITY;
    for (const input of check.inputs.flatMap(buildInputFiles)) {
      const inputMtimeMs = statSync(input).mtimeMs;
      if (inputMtimeMs > newestInputMtimeMs) {
        newestInput = input;
        newestInputMtimeMs = inputMtimeMs;
      }
    }
    if (newestInput && newestInputMtimeMs > artifactMtimeMs + 1) {
      stale.push({ artifact: check.artifact, newestInput });
    }
  }
  return { missing, stale };
}

export function assertCleanerInstallArtifacts(plan) {
  const inspection = inspectCleanerInstallArtifacts(plan);
  if (inspection.missing.length > 0) {
    throw new Error(`cleaner_install_artifact_missing:${inspection.missing.join(",")}`);
  }
  if (inspection.stale.length > 0) {
    throw new Error(`cleaner_install_artifact_stale:${inspection.stale
      .map(({ artifact, newestInput }) => `${artifact}<${newestInput}`)
      .join(",")}`);
  }
}

function formatCommand(step) {
  return [step.command, ...step.args].map((value) => JSON.stringify(value)).join(" ");
}

function assertSupportedNode(host) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = host === "codex"
    ? major > 22 || (major === 22 && minor >= 13)
    : major >= 20;
  if (!supported) {
    const minimum = host === "codex" ? "22.13.0" : "20.0.0";
    throw new Error(`cleaner_install_node_unsupported:${process.versions.node}; requires >=${minimum}`);
  }
}

function runStep(step, repoRoot, env) {
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cleaner_install_step_failed:${step.kind}:${result.status ?? "unknown"}`);
  }
}

export function runCleanerInstall(repoRoot, options) {
  assertSupportedNode(options.host);
  const plan = buildCleanerInstallPlan(repoRoot, options);
  const installEnv = cleanerInstallEnvironment();
  if (options.skipBuild) assertCleanerInstallArtifacts(plan);
  process.stdout.write(`LightRSI Cleaner install target: ${plan.host}\n`);
  for (const step of plan.steps) {
    process.stdout.write(`- ${step.kind}: ${formatCommand(step)}\n`);
    if (options.dryRun) continue;
    if (step.kind === "install" && !options.skipBuild) {
      assertCleanerInstallArtifacts(plan);
    }
    runStep(step, repoRoot, installEnv);
  }

  if (options.dryRun) {
    process.stdout.write("Dry run complete; no files or Host configuration were changed.\n");
    return plan;
  }

  process.stdout.write(`LightRSI Cleaner install complete for ${plan.host}.\nVerify with:\n`);
  for (const command of plan.verifyCommands) process.stdout.write(`  ${command}\n`);
  return plan;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const repoRoot = resolve(dirname(scriptPath), "..");
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${cleanerInstallUsage()}\n`);
  } else {
    try {
      runCleanerInstall(repoRoot, parseCleanerInstallArgs(argv));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${cleanerInstallUsage()}\n`);
      process.exitCode = 1;
    }
  }
}
