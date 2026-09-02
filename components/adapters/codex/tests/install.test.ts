import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { reserveUnusedPort } from "@lightrsi/host-adapter";

async function assertInstalledCliLink(linkPath: string, targetPattern: RegExp, allowRegularFile: boolean) {
  const linkStat = await lstat(linkPath);
  if (linkStat.isSymbolicLink()) {
    assert.match(await readlink(linkPath), targetPattern);
    return;
  }
  assert.equal(allowRegularFile && linkStat.isFile(), true);
}
import { readCliContextState } from "../../../products/cli/src/context-store.js";
import {
  loadTokenPilotCodexConfig,
  normalizeTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "../src/config.js";
import { daemonPaths, readDaemonStatus } from "../src/daemon.js";
import { inspectCodexDoctor } from "../src/doctor.js";
import {
  installCodexTokenPilot as installCodexTokenPilotBase,
  resolveCodexHookCommandForInstall,
} from "../src/install.js";

const originalSuiteHome = process.env.HOME;
const originalSuiteUserProfile = process.env.USERPROFILE;
let installSuiteHome = "";

before(async () => {
  installSuiteHome = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-suite-"));
  process.env.HOME = installSuiteHome;
  process.env.USERPROFILE = installSuiteHome;
});

after(async () => {
  if (originalSuiteHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalSuiteHome;
  if (originalSuiteUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalSuiteUserProfile;
  if (installSuiteHome) {
    await rm(installSuiteHome, { recursive: true, force: true });
  }
});

function installCodexTokenPilot(
  params: NonNullable<Parameters<typeof installCodexTokenPilotBase>[0]>,
) {
  const testRoot = dirname(params.codexConfigPath ?? params.tokenPilotConfigPath ?? tmpdir());
  return installCodexTokenPilotBase({
    ...params,
    cliBinDir: params.cliBinDir ?? join(testRoot, "bin"),
    cliContextPath: join(testRoot, ".lightrsi", "state", "cli-context.json"),
  });
}

function parseGeneratedShellCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quoted) {
      if (character === "\\") {
        const escaped = command[index + 1];
        if (escaped === "\\" || escaped === "\"") {
          current += escaped;
          index += 1;
        } else {
          current += character;
        }
      } else if (character === "\"") {
        quoted = false;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\"") {
      quoted = true;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }

  assert.equal(quoted, false, "generated shell command contains an unterminated quote");
  if (started) args.push(current);
  return args;
}

test("installCodexTokenPilot writes provider, MCP, and hooks with expected commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const cliBinDir = join(dir, "bin");
    const legacySkillDir = join(dir, "skills", "lightmem2-report");
    const legacyCleanerSkillDir = join(dir, "skills", "lightmem2-clean");
    const userSkillDir = join(dir, "skills", "personal-clean");
    await mkdir(legacySkillDir, { recursive: true });
    await writeFile(join(legacySkillDir, "SKILL.md"), "legacy", "utf8");
    await mkdir(legacyCleanerSkillDir, { recursive: true });
    await writeFile(join(legacyCleanerSkillDir, "SKILL.md"), "legacy cleaner", "utf8");
    await mkdir(userSkillDir, { recursive: true });
    await writeFile(join(userSkillDir, "SKILL.md"), "user-owned", "utf8");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(tokenPilotConfigPath, JSON.stringify({ enabled: false }, null, 2), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      cliBinDir,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    assert.match(codexToml, /model_provider = "OPENAI"/);
    assert.match(codexToml, /\[model_providers\.OPENAI\]/);
    assert.match(codexToml, /\[model_providers\.OPENAI\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.doesNotMatch(codexToml, /\[model_providers\.tokenpilot\]/);
    assert.match(codexToml, /\[mcp_servers\.tokenpilot_memory_fault_recover\]/);
    assert.match(codexToml, /startup_timeout_sec\s*=\s*90/);
    assert.equal(codexToml.includes(`command = ${JSON.stringify(result.expectedMcpCommand)}`), true);
    assert.equal(result.expectedMcpArgs.length, 1);
    assert.match(result.expectedMcpArgs[0] ?? "", /dist[\/\\]server\.js$/);
    for (const arg of result.expectedMcpArgs) {
      assert.equal(codexToml.includes(JSON.stringify(arg)), true);
    }
    assert.equal(result.expectedMcpStartupTimeoutSec, 90);
    assert.equal(result.mcpProbe.ok, true);
    assert.equal(result.mcpProbe.degraded, false);
    assert.equal(result.activeProviderName, "OPENAI");
    assert.equal(result.providerName, "OPENAI");
    assert.deepEqual(result.commandSkillNames, [
      "lightrsi-status",
      "lightrsi-report",
      "lightrsi-doctor",
      "lightrsi-visual",
      "lightrsi-clean",
    ]);
    assert.equal(result.cliBinInstalled, true);
    assert.equal(result.cliBinPath, join(cliBinDir, "lightrsi"));
    assert.equal(result.cliBinDir, cliBinDir);
    assert.equal(result.cliBinDirOnPath, false);
    assert.equal(result.hostCliBinPath, join(cliBinDir, "tokenpilot-codex"));
    assert.equal(result.cliLauncherPath, process.platform === "win32" ? join(cliBinDir, "lightrsi.cmd") : undefined);
    assert.equal(result.hostCliLauncherPath, process.platform === "win32" ? join(cliBinDir, "tokenpilot-codex.cmd") : undefined);
    const allowRegularFile = process.platform === "win32";
    await assertInstalledCliLink(result.cliBinPath, /products[\/\\]cli[\/\\]dist[\/\\]cli\.js$/, allowRegularFile);
    await assertInstalledCliLink(result.hostCliBinPath!, /adapters[\/\\]codex[\/\\]dist[\/\\]cli\.js$/, allowRegularFile);
    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.enabled, true);
    assert.equal(tokenPilotConfig.upstreamProvider, "OPENAI");
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "https://api.openai.com/v1");
    const cliContext = await readCliContextState(join(dir, ".lightrsi", "state", "cli-context.json"));
    assert.equal(cliContext.configPathsByHost?.codex?.tokenPilotConfigPath, tokenPilotConfigPath);
    assert.equal(cliContext.configPathsByHost?.codex?.hostConfigPath, codexConfigPath);
    assert.equal(cliContext.configPathsByHost?.codex?.hostAuxConfigPath, hooksConfigPath);

    const hooks = JSON.parse(await readFile(hooksConfigPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse"]) {
      const entries = hooks.hooks?.[eventName]?.[0]?.hooks;
      assert.ok(Array.isArray(entries), `${eventName} hook group missing`);
      assert.equal(String(entries[0]?.command ?? ""), result.expectedHookCommand);
    }
    assert.equal(hooks.hooks?.Stop, undefined);

    const skillRaw = await readFile(join(result.commandSkillsDir, "lightrsi-report", "SKILL.md"), "utf8");
    assert.match(skillRaw, /lightrsi codex report/);
    assert.match(skillRaw, /node/);
    const policyRaw = await readFile(join(result.commandSkillsDir, "lightrsi-report", "agents", "openai.yaml"), "utf8");
    assert.match(policyRaw, /allow_implicit_invocation:\s*false/);
    const cleanSkillRaw = await readFile(join(result.commandSkillsDir, "lightrsi-clean", "SKILL.md"), "utf8");
    assert.match(cleanSkillRaw, /^   lightrsi codex clean$/m);
    assert.doesNotMatch(cleanSkillRaw, /^   lightrsi codex clean\s+--/m);
    assert.match(cleanSkillRaw, /Never choose task IDs, item IDs, item digests, or deletion ranges/);
    assert.match(cleanSkillRaw, /Never add `--plan`, `--select`, `--status`, or `--cancel`/);
    assert.match(cleanSkillRaw, /Never answer the confirmation prompt/);
    const cleanPolicyRaw = await readFile(join(result.commandSkillsDir, "lightrsi-clean", "agents", "openai.yaml"), "utf8");
    assert.match(cleanPolicyRaw, /allow_implicit_invocation:\s*false/);
    await assert.rejects(stat(legacySkillDir), { code: "ENOENT" });
    await assert.rejects(stat(legacyCleanerSkillDir), { code: "ENOENT" });
    assert.equal(await readFile(join(userSkillDir, "SKILL.md"), "utf8"), "user-owned");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot removes legacy TokenPilot Stop hooks but preserves user hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-remove-stop-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: ".*", hooks: [{ type: "command", command: "user-stop-hook" }] },
          { hooks: [{ type: "command", command: "tokenpilot-codex-hook.cmd" }] },
        ],
      },
    }, null, 2), "utf8");

    await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const hooks = JSON.parse(await readFile(hooksConfigPath, "utf8")) as {
      hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    assert.deepEqual(hooks.hooks?.Stop, [
      { matcher: ".*", hooks: [{ type: "command", command: "user-stop-hook" }] },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot reports degraded MCP mode when probe is skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-skip-probe-"));
  try {
    const result = await installCodexTokenPilot({
      codexConfigPath: join(dir, "config.toml"),
      hooksConfigPath: join(dir, "hooks.json"),
      tokenPilotConfigPath: join(dir, "tokenpilot.json"),
      probeMcp: false,
    });

    assert.equal(result.mcpProbe.ok, false);
    assert.equal(result.mcpProbe.degraded, true);
    assert.match(result.mcpProbe.detail, /skipped/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot restores execute permission on the shared lightrsi CLI target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-cli-perm-"));
  const cliDistPath = resolve(__dirname, "..", "..", "..", "products", "cli", "dist", "cli.js");
  const originalMode = (await stat(cliDistPath)).mode & 0o777;
  try {
    await chmod(cliDistPath, 0o644);
    const result = await installCodexTokenPilot({
      codexConfigPath: join(dir, "config.toml"),
      hooksConfigPath: join(dir, "hooks.json"),
      tokenPilotConfigPath: join(dir, "tokenpilot.json"),
      cliBinDir: join(dir, "bin"),
      probeMcp: false,
    });

    assert.equal(result.cliBinInstalled, true);
    if (process.platform !== "win32") {
      assert.equal(((await stat(cliDistPath)).mode & 0o111) !== 0, true);
    }
  } finally {
    await chmod(cliDistPath, originalMode).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot preserves an existing custom root provider and reroutes that provider to the proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-custom-root-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENROUTER\"",
      "",
      "[model_providers.OPENROUTER]",
      "name = \"OpenRouter\"",
      "base_url = \"https://openrouter.ai/api/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    assert.match(codexToml, /model_provider = "OPENROUTER"/);
    assert.match(codexToml, /\[model_providers\.OPENROUTER\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.equal(result.providerName, "OPENROUTER");
    assert.equal(result.activeProviderName, "OPENROUTER");

    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.providerName, "OPENROUTER");
    assert.equal(tokenPilotConfig.upstreamProvider, "OPENROUTER");
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "https://openrouter.ai/api/v1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot preserves the last real upstream when the current provider already points at an older local proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-loopback-upstream-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        proxyPort: 17668,
        providerName: "OPENAI",
        upstreamProvider: "OPENAI",
        upstream: {
          name: "OPENAI",
          baseUrl: "http://47.88.93.22:10001",
          wireApi: "responses",
          requiresOpenAIAuth: true,
        },
      }),
      tokenPilotConfigPath,
    );

    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OPENAI\"",
      "base_url = \"http://127.0.0.1:17667/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "http://47.88.93.22:10001");
    assert.equal(result.providerName, "OPENAI");

    const codexToml = await readFile(codexConfigPath, "utf8");
    assert.match(codexToml, new RegExp(`base_url = "http://127\\.0\\.0\\.1:${tokenPilotConfig.proxyPort}/v1"`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot does not treat a fresh default install as an upstream loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-fresh-upstream-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.upstream?.baseUrl, undefined);
    assert.equal(tokenPilotConfig.upstreamProvider, "OpenAI");
    const report = await inspectCodexDoctor({
      config: tokenPilotConfig,
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });
    assert.equal(report.upstreamLoopDetected, false);
    assert.equal(report.upstreamBaseUrl, undefined);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot writes Windows hook wrappers into hooks.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-win-hook-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      platform: "win32",
    });

    assert.match(result.expectedHookCommand, /tokenpilot-codex-hook\.cmd"$/);

    const hooks = JSON.parse(await readFile(hooksConfigPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse"]) {
      const entries = hooks.hooks?.[eventName]?.[0]?.hooks;
      assert.ok(Array.isArray(entries), `${eventName} hook group missing`);
      assert.match(String(entries[0]?.command ?? ""), /tokenpilot-codex-hook\.cmd"$/);
    }
    assert.equal(hooks.hooks?.Stop, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot rewrites the MCP server block idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-mcp-idempotent-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });
    await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    const envHeaders = codexToml.match(/\[mcp_servers\.tokenpilot_memory_fault_recover\.env\]/g) ?? [];
    assert.equal(envHeaders.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot shifts the proxy port when the preferred port is already occupied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-port-shift-"));
  const blocker = await new Promise<{ server: import("node:net").Server; port: number }>((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to reserve blocker port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        proxyPort: blocker.port,
      }),
      tokenPilotConfigPath,
    );
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.notEqual(config.proxyPort, blocker.port);
    assert.equal(result.baseUrl, `http://127.0.0.1:${config.proxyPort}/v1`);
  } finally {
    await new Promise<void>((resolve) => blocker.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot routes the reserved built-in openai provider through a custom proxy provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-builtin-openai-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"openai\"",
      "",
      "[model_providers.openai]",
      "base_url = \"https://invalid.example/v1\"",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.match(codexToml, /model_provider = "tokenpilot-openai"/);
    assert.match(codexToml, /\[model_providers\.tokenpilot-openai\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.doesNotMatch(codexToml, /\[model_providers\.openai\]/);
    assert.equal(result.providerName, "tokenpilot-openai");
    assert.equal(tokenPilotConfig.providerName, "tokenpilot-openai");
    assert.equal(tokenPilotConfig.upstreamProvider, "openai");
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "https://api.openai.com/v1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot waits for a released preferred port when the wall clock jumps forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-port-clock-"));
  const blocker = await new Promise<{ server: import("node:net").Server; port: number }>((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to reserve blocker port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
  let dummy: ReturnType<typeof spawn> | undefined;
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const config = normalizeTokenPilotCodexConfig({
      proxyPort: blocker.port,
      stateDir: join(dir, "state"),
    });
    await writeTokenPilotCodexConfig(config, tokenPilotConfigPath);
    const { pidPath } = daemonPaths(config);
    await mkdir(dirname(pidPath), { recursive: true });
    dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await writeFile(pidPath, `${dummy.pid}\n`, "utf8");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const originalNow = Date.now;
    let portWaitCalls = 0;
    Date.now = () => new Error().stack?.includes("resolveAvailableCodexProxyPort")
      ? (portWaitCalls++ === 0 ? 1_000 : 12_000)
      : originalNow();
    const closeTimer = setTimeout(() => {
      blocker.server.close();
    }, 30);
    try {
      const result = await installCodexTokenPilot({
        codexConfigPath,
        hooksConfigPath,
        tokenPilotConfigPath,
        probeMcp: false,
      });
      assert.equal(result.baseUrl, `http://127.0.0.1:${blocker.port}/v1`);
      assert.equal((await loadTokenPilotCodexConfig(tokenPilotConfigPath)).proxyPort, blocker.port);
    } finally {
      clearTimeout(closeTimer);
      Date.now = originalNow;
    }
  } finally {
    await new Promise<void>((resolve) => blocker.server.close(() => resolve()));
    if (dummy?.pid) {
      try {
        process.kill(dummy.pid, "SIGKILL");
      } catch {
        // The installer is expected to stop this process.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot stops an existing daemon before resolving the proxy port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-install-stop-daemon-"));
  const daemonPort = await reserveUnusedPort();
  let dummy: ReturnType<typeof spawn> | undefined;
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const stateDir = join(dir, "state");
    const config = normalizeTokenPilotCodexConfig({
      proxyPort: daemonPort,
      stateDir,
    });
    await writeTokenPilotCodexConfig(config, tokenPilotConfigPath);
    const { pidPath } = daemonPaths(config);
    await mkdir(dirname(pidPath), { recursive: true });

    dummy = spawn(process.execPath, [
      "-e",
      [
        "const http = require('node:http');",
        "const server = http.createServer((req, res) => {",
        "  if (req.url === '/health') {",
        "    res.writeHead(200, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ ok: true, adapter: 'tokenpilot-codex' }));",
        "    return;",
        "  }",
        "  res.writeHead(404);",
        "  res.end('not found');",
        "});",
        `server.listen(${daemonPort}, '127.0.0.1');`,
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ], {
      stdio: "ignore",
    });
    await writeFile(pidPath, `${dummy.pid}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const persisted = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(persisted.proxyPort, daemonPort);
    assert.equal(result.baseUrl, `http://127.0.0.1:${daemonPort}/v1`);
    assert.equal((await readDaemonStatus(persisted)).running, false);
  } finally {
    if (dummy?.pid) {
      try {
        process.kill(dummy.pid, "SIGKILL");
      } catch {
        // The installer is expected to stop this process.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveCodexHookCommandForInstall finds the adapter root from the bundled CLI tree", async () => {
  const repoRoot = resolve(__dirname, "..", "..", "..", "..");
  const bundledCliModuleDir = join(repoRoot, "components", "products", "cli", "dist");
  const adapterDistDir = join(repoRoot, "components", "adapters", "codex", "dist");
  const originalCwd = process.cwd();
  try {
    process.chdir(dirname(repoRoot));
    const windowsCommand = await resolveCodexHookCommandForInstall("win32", bundledCliModuleDir);
    assert.deepEqual(parseGeneratedShellCommand(windowsCommand), [
      join(adapterDistDir, "tokenpilot-codex-hook.cmd"),
    ]);

    const posixCommand = await resolveCodexHookCommandForInstall("linux", bundledCliModuleDir);
    assert.deepEqual(parseGeneratedShellCommand(posixCommand), [
      process.execPath,
      join(adapterDistDir, "hooks-handler.js"),
    ]);
  } finally {
    process.chdir(originalCwd);
  }
});
