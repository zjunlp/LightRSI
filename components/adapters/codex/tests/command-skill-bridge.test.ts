import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { installCommandSkillBridge } from "../../shared/command-skill-bridge.js";

const execFileAsync = promisify(execFile);

function parseJsonQuotedCommand(command: string): string[] {
  return [...command.matchAll(/"(?:\\.|[^"\\])*"/gu)].map((match) => JSON.parse(match[0]!));
}

for (const [host, style] of [
  ["codex", "codex"],
  ["claude-code", "claude"],
] as const) {
  test(`installs a restricted ${host} cleaner command skill`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `lightrsi-${host}-clean-skill-`));
    try {
      const adapterRoot = join(dir, "adapter");
      const adapterDistDir = join(adapterRoot, "dist");
      const skillsDir = join(dir, "skills");
      const invocationPath = join(dir, "invocation.json");
      await mkdir(adapterDistDir, { recursive: true });
      await writeFile(join(adapterDistDir, "lightrsi.js"), [
        'const { writeFileSync } = require("node:fs");',
        'writeFileSync(process.env.LIGHTRSI_FAKE_CLI_LOG, JSON.stringify(process.argv.slice(2)));',
        "",
      ].join("\n"), "utf8");
      const result = await installCommandSkillBridge({
        adapterRoot,
        skillsDir,
        host,
        style,
      });

      assert.ok(result.skillNames.includes("lightrsi-clean"));
      const skillRaw = await readFile(join(skillsDir, "lightrsi-clean", "SKILL.md"), "utf8");
      assert.match(skillRaw, new RegExp(`^   lightrsi ${host} clean$`, "m"));
      assert.doesNotMatch(skillRaw, new RegExp(`^   lightrsi ${host} clean\\s+--`, "m"));
      assert.match(skillRaw, /Never choose task IDs, item IDs, item digests, or deletion ranges/);
      assert.match(skillRaw, /Never answer the confirmation prompt or run a follow-up command/);
      const fallbackLine = skillRaw.match(/^   (".*lightrsi\.js".*)$/m)?.[1];
      const nodeFallbackLine = skillRaw.match(/^   (node ".*lightrsi\.js".*)$/m)?.[1];
      assert.equal(fallbackLine, undefined);
      assert.ok(nodeFallbackLine, "cleaner skill fallback command missing");
      const command = parseJsonQuotedCommand(nodeFallbackLine);
      await execFileAsync(process.execPath, command, {
        env: { ...process.env, LIGHTRSI_FAKE_CLI_LOG: invocationPath },
      });
      assert.deepEqual(JSON.parse(await readFile(invocationPath, "utf8")), [host, "clean"]);
      if (style === "codex") {
        assert.match(
          await readFile(join(skillsDir, "lightrsi-clean", "agents", "openai.yaml"), "utf8"),
          /allow_implicit_invocation:\s*false/,
        );
      } else {
        assert.match(skillRaw, /disable-model-invocation:\s*true/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
