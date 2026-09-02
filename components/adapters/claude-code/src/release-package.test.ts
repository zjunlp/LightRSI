import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(__dirname, "..");
const tarCommand = process.platform === "win32"
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

async function packRelease(): Promise<string> {
  if (process.platform !== "win32") {
    const result = await execFileAsync("bash", ["scripts/pack_release.sh"], { cwd: packageDir });
    const archiveName = result.stdout.trim().split("\n").at(-1)?.split(/[\\/]/).at(-1) ?? "";
    if (!archiveName) throw new Error("pack_release.sh produced no archive");
    return join(packageDir, archiveName);
  }
  const scriptName = `.pack-release-${process.pid}.sh`;
  const scriptPath = join(packageDir, "scripts", scriptName);
  const shimName = `.pack-bin-${process.pid}`;
  const shimDir = join(packageDir, "scripts", shimName);
  const packRoot = await mkdtemp(join(tmpdir(), `lightrsi-claude-code-pack-${process.pid}-`));
  const posixPackRoot = (await execFileAsync("bash", ["-lc", "pwd"], { cwd: packRoot })).stdout.trim();
  const pnpmCjs = join(process.env.APPDATA ?? "", "npm", "node_modules", "pnpm", "bin", "pnpm.cjs");
  const packScript = (await readFile(join(packageDir, "scripts", "pack_release.sh"), "utf8"))
    .replaceAll("\r\n", "\n")
    .replace(/mktemp -d \/tmp\/lightrsi-[^\s)]+/, `mktemp -d ${posixPackRoot}/pack-XXXXXX`);
  const nodeShim = `#!/bin/bash
args=()
for arg in "$@"; do
  case "$arg" in
    /mnt/[A-Za-z]/*|/[A-Za-z]/*) arg="$(printf '%s' "$arg" | sed -E 's#^/(mnt/)?([A-Za-z])/#\\2:/#')" ;;
  esac
  args+=("$arg")
done
exec node.exe "\${args[@]}"
`;
  await writeFile(scriptPath, packScript, "utf8");
  await mkdir(shimDir, { recursive: true });
  await writeFile(join(shimDir, "node"), nodeShim, "utf8");
  await writeFile(join(shimDir, "pnpm"), nodeShim.replace('exec node.exe "${args[@]}"', `exec node.exe '${pnpmCjs}' "\${args[@]}"`), "utf8");
  await chmod(join(shimDir, "node"), 0o755);
  await chmod(join(shimDir, "pnpm"), 0o755);
  try {
    const result = await execFileAsync("bash", [
      "-lc",
      `PATH="$(pwd)/scripts/${shimName}:$PATH" bash scripts/${scriptName}`,
    ], { cwd: packageDir });
    const archiveName = result.stdout.trim().split("\n").at(-1)?.split(/[\\/]/).at(-1) ?? "";
    if (!archiveName) throw new Error("pack_release.sh produced no archive");
    return join(packageDir, archiveName);
  } finally {
    await rm(shimDir, { recursive: true, force: true });
    await rm(scriptPath, { force: true });
    await rm(packRoot, { recursive: true, force: true });
  }
}

test("packaged Claude codec preserves structured systems and native cache control", async () => {
  const extractDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-release-smoke-"));
  let archivePath = "";
  try {
    archivePath = await packRelease();
    await execFileAsync(tarCommand, ["-xzf", archivePath, "-C", extractDir]);
    const installedDir = join(extractDir, "package");
    const manifest = JSON.parse(await readFile(join(installedDir, "package.json"), "utf8"));
    assert.equal(manifest.name, "@lightrsi/claude-code-adapter");
    const require = createRequire(__filename);
    const bundled = require(join(installedDir, "dist", "index.js"));
    const codec = bundled.createClaudeMessagesPayloadCodec();
    const raw = {
      model: "claude-sonnet-4-6",
      system: [{ type: "text", text: "Stable rules.", cache_control: { type: "ephemeral" }, unknown: { keep: true } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    const encoded = codec.encodeRequest(codec.decodeRequest(raw));
    assert.deepEqual(encoded.system, raw.system);
    assert.deepEqual(encoded.cache_control, { type: "ephemeral" });
    assert.equal("prompt_cache_key" in encoded, false);
    assert.deepEqual(encoded.messages, raw.messages);
    await execFileAsync(process.execPath, [
      resolve(packageDir, "../../..", "scripts", "release", "smoke-host-package.mjs"),
      archivePath,
      "claude-code",
      manifest.version,
    ], { timeout: 60_000 });
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
});
