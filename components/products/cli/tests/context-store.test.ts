import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCliContextState,
  resolveCliHomeDir,
  updateCliContextState,
  writeCliContextState,
} from "../src/context-store.js";

test("context store honors an explicit HOME before the Windows user profile", () => {
  assert.equal(
    resolveCliHomeDir(
      { HOME: "/tmp/isolated-home", USERPROFILE: "C:\\Users\\real-user" },
      "C:\\Users\\fallback-user",
    ),
    "/tmp/isolated-home",
  );
  assert.equal(
    resolveCliHomeDir({ USERPROFILE: "C:\\Users\\isolated-user" }, "C:\\Users\\fallback-user"),
    "C:\\Users\\isolated-user",
  );
});

test("context store reads empty state by default and persists updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-context-"));
  const file = join(dir, "cli-context.json");
  try {
    const empty = await readCliContextState(file);
    assert.deepEqual(empty, { lastSessionByHost: {}, configPathsByHost: {} });

    await updateCliContextState({ host: "openclaw" }, file);
    const withHost = await readCliContextState(file);
    assert.equal(withHost.lastActiveHost, "openclaw");
    assert.deepEqual(withHost.lastSessionByHost, {});

    await updateCliContextState({ host: "openclaw", sessionId: "sess-1" }, file);
    const withSession = await readCliContextState(file);
    assert.equal(withSession.lastActiveHost, "openclaw");
    assert.equal(withSession.lastSessionByHost?.openclaw, "sess-1");
    assert.ok(withSession.lastUpdatedAt);

    await updateCliContextState({
      host: "codex",
      pathOverrides: {
        tokenPilotConfigPath: "/tmp/codex/tokenpilot.json",
        hostConfigPath: "/tmp/codex/config.toml",
        hostAuxConfigPath: "/tmp/codex/hooks.json",
      },
    }, file);
    const withPaths = await readCliContextState(file);
    assert.equal(withPaths.configPathsByHost?.codex?.tokenPilotConfigPath, "/tmp/codex/tokenpilot.json");
    assert.equal(withPaths.configPathsByHost?.codex?.hostConfigPath, "/tmp/codex/config.toml");
    assert.equal(withPaths.configPathsByHost?.codex?.hostAuxConfigPath, "/tmp/codex/hooks.json");

    await writeCliContextState({
      lastActiveHost: "codex",
      lastSessionByHost: { codex: "sess-2" },
      configPathsByHost: {
        codex: {
          tokenPilotConfigPath: "/tmp/codex/tokenpilot.json",
        },
      },
      lastUpdatedAt: "2026-06-24T00:00:00.000Z",
    }, file);
    const replaced = await readCliContextState(file);
    assert.equal(replaced.lastActiveHost, "codex");
    assert.equal(replaced.lastSessionByHost?.codex, "sess-2");
    assert.equal(replaced.configPathsByHost?.codex?.tokenPilotConfigPath, "/tmp/codex/tokenpilot.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("context store falls back cleanly when the persisted file is invalid JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-context-invalid-"));
  const file = join(dir, "cli-context.json");
  try {
    await writeFile(file, "{not-valid-json", "utf8");

    const state = await readCliContextState(file);
    assert.deepEqual(state, { lastSessionByHost: {}, configPathsByHost: {} });

    await updateCliContextState({ host: "codex", sessionId: "sess-recovered" }, file);
    const recovered = await readCliContextState(file);
    assert.equal(recovered.lastActiveHost, "codex");
    assert.equal(recovered.lastSessionByHost?.codex, "sess-recovered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("context store reads legacy LightMem2 state only when canonical state is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-cli-context-legacy-"));
  const canonical = join(dir, ".lightrsi", "state", "cli-context.json");
  const legacy = join(dir, ".lightmem2", "state", "cli-context.json");
  try {
    await mkdir(join(dir, ".lightmem2", "state"), { recursive: true });
    await writeFile(legacy, JSON.stringify({ lastActiveHost: "codex" }), { encoding: "utf8", flag: "wx" });
    const migrated = await readCliContextState(canonical, legacy);
    assert.equal(migrated.lastActiveHost, "codex");

    await writeCliContextState({ lastActiveHost: "claude-code" }, canonical);
    const canonicalState = await readCliContextState(canonical, legacy);
    assert.equal(canonicalState.lastActiveHost, "claude-code");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
