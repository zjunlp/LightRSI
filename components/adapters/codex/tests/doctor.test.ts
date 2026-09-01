import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { appendFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import {
  codexMcpServerDiagnostic,
  codexProviderDiagnostic,
  formatCodexDoctorReport,
  inspectCodexDoctor,
} from "../src/doctor.js";
import {
  appendCodexRebaseCapability,
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  codexRebaseCapabilityJournalPath,
  codexRebaseEndpointIdentity,
} from "../src/context-rewrite/index.js";

async function reserveUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

const execFileAsync = promisify(execFile);

test("inspectCodexDoctor reports missing provider and hooks honestly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, "model_provider = \"OpenAI\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, false);
    assert.equal(report.hooksInstalled, false);
    assert.equal(report.hooksComplete, false);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.deepEqual(report.installedHookEvents, []);
    assert.deepEqual(report.missingHookEvents, ["SessionStart", "PreToolUse", "PostToolUse"]);
    assert.equal(report.daemonRunning, false);
    assert.equal(report.mcpInstalled, false);
    assert.equal(report.mcpStateDirMatches, false);
    assert.equal(report.mcpCommandMatches, false);
    assert.equal(report.mcpArgsMatch, false);
    assert.equal(report.taskStateEstimator?.status, "disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor reports incomplete estimator config without leaking secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-estimator-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, "model_provider = \"OpenAI\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }), "utf8");

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
        taskStateEstimator: {
          enabled: true,
          apiKey: "doctor-secret-never-report",
          model: "estimator-model",
        },
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });
    const text = formatCodexDoctorReport(report);

    assert.equal(report.taskStateEstimator?.status, "incomplete");
    assert.deepEqual(report.taskStateEstimator?.missingFields, ["baseUrl"]);
    assert.match(text, /task-state estimator status: incomplete/);
    assert.match(text, /missing fields: baseUrl/);
    assert.match(text, /runtime remains disabled/);
    assert.doesNotMatch(text, /doctor-secret-never-report|Authorization/i);
    assert.doesNotMatch(JSON.stringify(report), /doctor-secret-never-report/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor diagnostics summarize provider and MCP config without secret values", () => {
  const provider = codexProviderDiagnostic({
    name: "provider-name",
    baseUrl: "https://user:provider-password@example.com/v1?api_key=query-secret",
    apiKey: "provider-api-secret",
    wireApi: "responses",
    requiresOpenAIAuth: true,
  });
  const mcp = codexMcpServerDiagnostic({
    command: "node",
    args: ["server.js", "--token", "mcp-argument-secret"],
    env: {
      TOKENPILOT_STATE_DIR: "/tmp/state",
      SERVICE_API_KEY: "mcp-env-secret",
    },
    startupTimeoutSec: 90,
  });
  const serialized = JSON.stringify({ provider, mcp });

  assert.deepEqual(provider, {
    configured: true,
    name: "provider-name",
    baseUrlConfigured: true,
    apiKeyConfigured: true,
    wireApi: "responses",
    requiresOpenAIAuth: true,
  });
  assert.deepEqual(mcp, {
    configured: true,
    commandConfigured: true,
    argsCount: 3,
    envKeys: ["SERVICE_API_KEY", "TOKENPILOT_STATE_DIR"],
    startupTimeoutSec: 90,
  });
  assert.doesNotMatch(serialized, /provider-password|query-secret|provider-api-secret|mcp-argument-secret|mcp-env-secret/);

  const unsafeName = codexProviderDiagnostic({
    name: "Authorization Bearer provider-name-secret",
    baseUrl: "https://example.com/v1",
  });
  assert.equal(unsafeName.name, "(configured but not safely displayable)");
  assert.doesNotMatch(JSON.stringify(unsafeName), /Authorization|Bearer|provider-name-secret/i);
});

test("formatCodexDoctorReport redacts credentials embedded in diagnostic URLs", () => {
  const text = formatCodexDoctorReport({
    configPath: "/tmp/config.toml",
    hooksConfigPath: "/tmp/hooks.json",
    tokenPilotConfigPath: "/tmp/tokenpilot.json",
    proxyBaseUrl: "http://127.0.0.1:17667/v1",
    expectedHookCommand: "node hooks-handler.js",
    expectedMcpCommand: process.execPath,
    expectedMcpArgs: ["/tmp/server.js"],
    expectedMcpStartupTimeoutSec: 90,
    adapterEnabled: false,
    providerInstalled: true,
    providerActive: true,
    providerIntercepted: false,
    hooksInstalled: true,
    hooksComplete: true,
    hooksMatchExpectedCommand: true,
    installedHookEvents: ["SessionStart", "PreToolUse", "PostToolUse"],
    missingHookEvents: [],
    daemonRunning: false,
    proxyHealthy: false,
    stateDir: "/tmp/state",
    upstreamLoopDetected: false,
    upstreamBaseUrl: "https://user:url-password@example.com/v1?api_key=url-query-secret",
    mcpInstalled: true,
    mcpStateDirMatches: true,
    mcpCommandMatches: true,
    mcpArgsMatch: true,
    mcpStartupTimeoutSecMatches: true,
    coreRuntimeHealthy: false,
    recoveryMcpHealthy: true,
    degradedMode: false,
  });

  assert.match(text, /upstream base URL: https:\/\/example\.com\/v1/);
  assert.doesNotMatch(text, /url-password|url-query-secret/);
});

test("doctor-codex script exposes estimator diagnostics without serializing configured secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-script-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(dir, "state");
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      'model_provider = "tokenpilot"',
      "",
      "[model_providers.tokenpilot]",
      `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`,
      'api_key = "tokenpilot-provider-secret"',
      'wire_api = "responses"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://user:url-password@example.com/v1?api_key=query-secret"',
      'api_key = "upstream-provider-secret"',
      'wire_api = "responses"',
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover]",
      `command = ${JSON.stringify(process.execPath)}`,
      'args = ["server.js", "--token", "mcp-argument-secret"]',
      "startup_timeout_sec = 90",
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover.env]",
      'SERVICE_API_KEY = "mcp-env-secret"',
      `TOKENPILOT_STATE_DIR = ${JSON.stringify(stateDir)}`,
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }), "utf8");
    await writeFile(tokenPilotConfigPath, JSON.stringify({
      stateDir,
      proxyPort,
      providerName: "tokenpilot",
      upstreamProvider: "OpenAI",
      taskStateEstimator: {
        enabled: true,
        apiKey: "estimator-script-secret",
        model: "estimator-model",
      },
    }), "utf8");

    const adapterDir = fileURLToPath(new URL("..", import.meta.url));
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/doctor-codex.ts"],
      {
        cwd: adapterDir,
        env: {
          ...process.env,
          CODEX_CONFIG_PATH: codexConfigPath,
          CODEX_HOOKS_CONFIG_PATH: hooksConfigPath,
          TOKENPILOT_CODEX_CONFIG: tokenPilotConfigPath,
          LIGHTRSI_TASK_STATE_ESTIMATOR_ENABLED: "",
          LIGHTRSI_TASK_STATE_ESTIMATOR_API_KEY: "",
          TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED: "",
          TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY: "",
        },
      },
    );
    const output = JSON.parse(stdout) as Record<string, any>;
    const serialized = `${stdout}\n${stderr}`;

    assert.equal(output.taskStateEstimator.status, "incomplete");
    assert.deepEqual(output.taskStateEstimator.missingFields, ["baseUrl"]);
    assert.equal(output.tokenpilotProvider.apiKeyConfigured, true);
    assert.equal(output.upstream.apiKeyConfigured, true);
    assert.equal(output.recoveryMcp.argsCount, 3);
    assert.deepEqual(output.recoveryMcp.envKeys, ["SERVICE_API_KEY", "TOKENPILOT_STATE_DIR"]);
    assert.doesNotMatch(
      serialized,
      /tokenpilot-provider-secret|url-password|query-secret|upstream-provider-secret|mcp-argument-secret|mcp-env-secret|estimator-script-secret|Authorization/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor checks the configured provider name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-provider-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, [
      "model_provider = \"tp-custom\"",
      "",
      "[model_providers.tp-custom]",
      "name = \"TokenPilot Custom\"",
      "base_url = \"http://127.0.0.1:17667/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
        providerName: "tp-custom",
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, true);
    assert.equal(report.providerActive, true);
    assert.equal(report.hooksInstalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor detects installed recovery MCP entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-mcp-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, [
      "model_provider = \"tokenpilot\"",
      "",
      "[model_providers.tokenpilot]",
      "name = \"TokenPilot\"",
      "base_url = \"http://127.0.0.1:17667/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify("/tmp/server.js")}]`,
      "startup_timeout_sec = 90",
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover.env]",
      `TOKENPILOT_STATE_DIR = ${JSON.stringify(join(dir, "state"))}`,
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, true);
    assert.equal(report.mcpInstalled, true);
    assert.equal(report.mcpStateDirMatches, true);
    assert.equal(report.mcpCommandMatches, true);
    assert.equal(report.mcpArgsMatch, false);
    assert.equal(report.mcpStartupTimeoutSecMatches, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor treats a non-tokenpilot active provider as healthy when it is routed through the local proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-intercepted-root-"));
  const proxyPort = await reserveUnusedPort();
  const server = createHttpServer((req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, adapter: "tokenpilot-codex" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(proxyPort, "127.0.0.1", () => resolve());
    });

    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      `name = ${JSON.stringify("OPENAI")}`,
      `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
        providerName: "OPENAI",
        upstreamProvider: "OPENAI",
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, true);
    assert.equal(report.providerActive, true);
    assert.equal(report.providerIntercepted, true);
    assert.equal(report.proxyHealthy, true);
    assert.equal(report.coreRuntimeHealthy, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor reports partial hook installs explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-hooks-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, "model_provider = \"tokenpilot\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
      },
    }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.hooksInstalled, true);
    assert.equal(report.hooksComplete, false);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.deepEqual(report.installedHookEvents, ["SessionStart", "PostToolUse"]);
    assert.deepEqual(report.missingHookEvents, ["PreToolUse"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor accepts Windows hook wrapper commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-hooks-win-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, "model_provider = \"tokenpilot\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "D:\\LightRSI\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "D:\\LightRSI\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "D:\\LightRSI\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
        Stop: [{ hooks: [{ type: "command", command: "D:\\LightRSI\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
      },
    }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.hooksInstalled, true);
    assert.equal(report.hooksComplete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor rejects a healthy response from a different adapter on the same port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-wrong-adapter-"));
  const proxyPort = await reserveUnusedPort();
  const server = createHttpServer((req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, adapter: "tokenpilot-openclaw" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(proxyPort, "127.0.0.1", () => resolve());
    });

    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, [
      "model_provider = \"tokenpilot\"",
      "",
      "[model_providers.tokenpilot]",
      `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.proxyHealthy, false);
    assert.equal(report.coreRuntimeHealthy, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor detects when tokenpilot upstream loops into another local proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-upstream-loop-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      `name = ${JSON.stringify("OPENAI")}`,
      `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
        providerName: "OPENAI",
        upstreamProvider: "OPENAI",
        upstream: {
          name: "OPENAI",
          baseUrl: "http://127.0.0.1:17667/v1",
          wireApi: "responses",
          requiresOpenAIAuth: true,
        },
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.upstreamLoopDetected, true);
    assert.equal(report.upstreamBaseUrl, "http://127.0.0.1:17667/v1");

    const text = formatCodexDoctorReport(report);
    assert.match(text, /upstream loops into local proxy: yes/);
    assert.match(text, /restore `tokenpilot\.json` upstream to the real remote API base URL/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatCodexDoctorReport includes remediation hints for drifted installs", async () => {
  const proxyPort = await reserveUnusedPort();
  const report = await inspectCodexDoctor({
    config: normalizeTokenPilotCodexConfig({
      stateDir: join(tmpdir(), "lightrsi-codex-doctor-remediation-state"),
      proxyPort,
    }),
    configPath: join(tmpdir(), "lightrsi-missing-codex-config.toml"),
    hooksConfigPath: join(tmpdir(), "lightrsi-missing-codex-hooks.json"),
    tokenPilotConfigPath: join(tmpdir(), "lightrsi-missing-codex-tokenpilot.json"),
  });
  const text = formatCodexDoctorReport(report);
  assert.match(text, /Suggested fixes:/);
  assert.match(text, /rerun the Codex install command/i);
});

test("inspectCodexDoctor reports cached rebase capabilities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-doctor-capability-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(dir, "state");
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, "model_provider = \"OpenAI\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await appendCodexRebaseCapability({
      stateDir,
      provider: "OpenAI",
      model: "gpt-5.4-mini",
      wireMode: CODEX_REBASE_WIRE_MODE,
      apiVersion: CODEX_REBASE_API_VERSION,
      endpointId: codexRebaseEndpointIdentity("https://api.openai.example/v1"),
      itemType: "web_search_call",
      itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
      status: "verified_unsupported",
      evidence: "mock_fixture",
      reason: "schema_error",
      observedAt: "2026-07-28T10:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    await appendCodexRebaseCapability({
      stateDir,
      provider: "OpenAI",
      model: "gpt-5.4-mini",
      wireMode: CODEX_REBASE_WIRE_MODE,
      apiVersion: CODEX_REBASE_API_VERSION,
      endpointId: codexRebaseEndpointIdentity("https://api.openai.example/v1"),
      itemType: "reasoning",
      itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
      status: "verified_supported",
      evidence: "real_provider",
      reason: "provider_smoke_committed",
      observedAt: "2026-07-28T10:01:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir,
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.deepEqual(report.rebaseCapabilityStatus, [
      "OpenAI/gpt-5.4-mini responses responses/v1 reasoning@responses-item/v2 verified_supported evidence=real-provider state=active",
      "OpenAI/gpt-5.4-mini responses responses/v1 web_search_call@responses-item/v2 verified_unsupported evidence=mock/fixture state=active",
    ]);
    const formatted = formatCodexDoctorReport(report);
    assert.match(formatted, /reasoning@responses-item\/v2 verified_supported evidence=real-provider/);
    assert.match(formatted, /web_search_call@responses-item\/v2 verified_unsupported evidence=mock\/fixture/);

    await appendFile(codexRebaseCapabilityJournalPath(stateDir), "not-json\n", "utf8");
    const untrustedReport = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({ stateDir, proxyPort }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });
    assert.equal(untrustedReport.rebaseCapabilityTrusted, false);
    assert.match(formatCodexDoctorReport(untrustedReport), /capability cache: untrusted .*runtime will bypass rebase/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatCodexDoctorReport shows degraded mode when core runtime is healthy but MCP recovery drifted", () => {
  const text = formatCodexDoctorReport({
    configPath: "/tmp/config.toml",
    hooksConfigPath: "/tmp/hooks.json",
    tokenPilotConfigPath: "/tmp/tokenpilot.json",
    proxyBaseUrl: "http://127.0.0.1:17667/v1",
    expectedHookCommand: "node hooks-handler.js",
    expectedMcpCommand: process.execPath,
    expectedMcpArgs: ["/tmp/server.js"],
    expectedMcpStartupTimeoutSec: 90,
    adapterEnabled: true,
    providerInstalled: true,
    providerActive: true,
    hooksInstalled: true,
    hooksComplete: true,
    hooksMatchExpectedCommand: true,
    installedHookEvents: ["SessionStart", "PreToolUse", "PostToolUse"],
    missingHookEvents: [],
    daemonRunning: true,
    proxyHealthy: true,
    stateDir: "/tmp/state",
    upstreamProvider: "OpenAI",
    upstreamLoopDetected: false,
    upstreamBaseUrl: "https://api.openai.com/v1",
    mcpInstalled: true,
    mcpStateDirMatches: true,
    mcpCommandMatches: true,
    mcpArgsMatch: true,
    mcpStartupTimeoutSecMatches: false,
    coreRuntimeHealthy: true,
    recoveryMcpHealthy: false,
    degradedMode: true,
  });

  assert.match(text, /core runtime healthy: yes/);
  assert.match(text, /recovery MCP healthy: no/);
  assert.match(text, /degraded mode: yes/);
  assert.match(text, /stable-prefix rewriting and reduction remain available/);
  assert.match(text, /startup_timeout_sec/);
});

test("formatCodexDoctorReport explains first-run SessionStart remediation when the proxy is unhealthy", () => {
  const text = formatCodexDoctorReport({
    configPath: "/tmp/config.toml",
    hooksConfigPath: "/tmp/hooks.json",
    tokenPilotConfigPath: "/tmp/tokenpilot.json",
    proxyBaseUrl: "http://127.0.0.1:17680/v1",
    expectedHookCommand: "node hooks-handler.js",
    expectedMcpCommand: process.execPath,
    expectedMcpArgs: ["/tmp/server.js"],
    expectedMcpStartupTimeoutSec: 90,
    adapterEnabled: true,
    providerInstalled: true,
    providerActive: true,
    providerIntercepted: true,
    hooksInstalled: true,
    hooksComplete: true,
    hooksMatchExpectedCommand: true,
    installedHookEvents: ["SessionStart", "PreToolUse", "PostToolUse"],
    missingHookEvents: [],
    mcpInstalled: true,
    mcpStateDirMatches: true,
    mcpCommandMatches: true,
    mcpArgsMatch: true,
    mcpStartupTimeoutSecMatches: true,
    daemonRunning: false,
    proxyHealthy: false,
    upstreamProvider: "OPENAI",
    upstreamBaseUrl: "https://api.openai.com/v1",
    upstreamLoopDetected: false,
    coreRuntimeHealthy: false,
    recoveryMcpHealthy: true,
    degradedMode: false,
  });
  assert.match(text, /trust the TokenPilot hooks in Codex/);
  assert.match(text, /start a new session so SessionStart can boot the local proxy/);
  assert.match(text, /tokenpilot-codex start/);
});

test("formatCodexDoctorReport explains disabled adapter without suggesting daemon start", () => {
  const text = formatCodexDoctorReport({
    configPath: "/tmp/config.toml",
    hooksConfigPath: "/tmp/hooks.json",
    tokenPilotConfigPath: "/tmp/tokenpilot.json",
    proxyBaseUrl: "http://127.0.0.1:17680/v1",
    expectedHookCommand: "node hooks-handler.js",
    expectedMcpCommand: process.execPath,
    expectedMcpArgs: ["/tmp/server.js"],
    expectedMcpStartupTimeoutSec: 90,
    adapterEnabled: false,
    providerInstalled: true,
    providerActive: true,
    providerIntercepted: true,
    hooksInstalled: true,
    hooksComplete: true,
    hooksMatchExpectedCommand: true,
    installedHookEvents: ["SessionStart", "PreToolUse", "PostToolUse"],
    missingHookEvents: [],
    mcpInstalled: true,
    mcpStateDirMatches: true,
    mcpCommandMatches: true,
    mcpArgsMatch: true,
    mcpStartupTimeoutSecMatches: true,
    daemonRunning: false,
    proxyHealthy: false,
    stateDir: "/tmp/state",
    upstreamProvider: "OPENAI",
    upstreamBaseUrl: "https://api.openai.com/v1",
    upstreamLoopDetected: false,
    coreRuntimeHealthy: false,
    recoveryMcpHealthy: true,
    degradedMode: false,
  });
  assert.match(text, /adapter enabled: no/);
  assert.match(text, /set `enabled: true`/);
  assert.doesNotMatch(text, /tokenpilot-codex start/);
});
