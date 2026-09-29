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
  test(`installs restricted ${host} cleaner command skills`, async () => {
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

      assert.deepEqual(
        result.skillNames.filter((name) => name.startsWith("lightrsi-clean")),
        [
          "lightrsi-clean",
          "lightrsi-clean-status",
          "lightrsi-clean-apply",
          "lightrsi-clean-cancel",
        ],
      );
      const skillRaw = await readFile(join(skillsDir, "lightrsi-clean", "SKILL.md"), "utf8");
      const fallbackLine = skillRaw.match(/^   (".*lightrsi\.js".*)$/m)?.[1];
      const nodeFallbackLine = skillRaw.match(/^   (node ".*lightrsi\.js".*)$/m)?.[1];
      assert.equal(fallbackLine, undefined);
      if (style === "codex") {
        assert.match(skillRaw, /`lightrsi_cleaner\.lightrsi_clean`/);
        assert.match(skillRaw, /exactly once/i);
        assert.match(skillRaw, /do not run (?:a )?shell command/i);
        assert.match(skillRaw, /user-entered `!lightrsi-clean`/i);
        assert.match(skillRaw, /Up\/Down, Space, Enter, and `q`/);
        assert.match(skillRaw, /MCP form remains/i);
        assert.doesNotMatch(skillRaw, /MCP form uses Up\/Down, Space, Enter, and `q`/i);
        assert.equal(nodeFallbackLine, undefined);
      } else {
        assert.match(skillRaw, new RegExp(`^   lightrsi ${host} clean$`, "m"));
        assert.doesNotMatch(skillRaw, new RegExp(`^   lightrsi ${host} clean\\s+--`, "m"));
        assert.match(skillRaw, /Never choose task IDs, item IDs, item digests, or deletion ranges/);
        assert.match(skillRaw, /Never answer the confirmation prompt or run a follow-up command/);
        assert.match(skillRaw, /Same-terminal interactive selection/);
        assert.match(skillRaw, /user must run `\/exit`/);
        assert.match(skillRaw, /lightrsi claude-code clean --require-tty --session <session-id>/);
        assert.match(skillRaw, /Up\/Down moves, Space toggles a task, Enter submits, and `q` cancels/);
        assert.match(skillRaw, /claude --resume <session-id>/);
        assert.match(skillRaw, /next ordinary Claude Code request/);
        assert.ok(nodeFallbackLine, "cleaner skill fallback command missing");
        const command = parseJsonQuotedCommand(nodeFallbackLine);
        await execFileAsync(process.execPath, command, {
          env: { ...process.env, LIGHTRSI_FAKE_CLI_LOG: invocationPath },
        });
        assert.deepEqual(JSON.parse(await readFile(invocationPath, "utf8")), [host, "clean"]);
      }

      const controlSkills = [
        {
          name: "lightrsi-clean-status",
          primaryArgs: ["clean", "--status", "<plan-id>"],
          executedArgs: [host, "clean", "--status", "ctxclean-plan1"],
        },
        {
          name: "lightrsi-clean-apply",
          primaryArgs: ["clean", "--plan", "<plan-id>", "--select", "<task-id[,task-id...]>"],
          executedArgs: [host, "clean", "--plan", "ctxclean-plan1", "--select", "session-1:t2,session-1:t3"],
        },
        {
          name: "lightrsi-clean-cancel",
          primaryArgs: ["clean", "--cancel", "<plan-id>"],
          executedArgs: [host, "clean", "--cancel", "ctxclean-plan1"],
        },
      ] as const;

      for (const control of controlSkills) {
        const controlRaw = await readFile(join(skillsDir, control.name, "SKILL.md"), "utf8");
        assert.match(controlRaw, new RegExp(`^   lightrsi ${host} ${control.primaryArgs.join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
        assert.match(controlRaw, /current user request must/);
        assert.match(controlRaw, /verbatim/);
        const controlFallback = controlRaw.match(/^   (node ".*lightrsi\.js".*)$/m)?.[1];
        assert.ok(controlFallback, `${control.name} fallback command missing`);
        const controlCommand = parseJsonQuotedCommand(controlFallback).map((argument) => argument
          .replace("<plan-id>", "ctxclean-plan1")
          .replace("<task-id[,task-id...]>", "session-1:t2,session-1:t3"));
        await execFileAsync(process.execPath, controlCommand, {
          env: { ...process.env, LIGHTRSI_FAKE_CLI_LOG: invocationPath },
        });
        assert.deepEqual(JSON.parse(await readFile(invocationPath, "utf8")), control.executedArgs);
      }

      const statusRaw = await readFile(join(skillsDir, "lightrsi-clean-status", "SKILL.md"), "utf8");
      assert.match(statusRaw, /This skill is read-only/);
      const applyRaw = await readFile(join(skillsDir, "lightrsi-clean-apply", "SKILL.md"), "utf8");
      assert.match(applyRaw, /Explicit invocation with both the plan ID and task IDs is approval/);
      assert.match(applyRaw, /a session ID without the task suffix is not a task ID/);
      assert.match(applyRaw, /Never construct item IDs, item digests, deletion ranges/);
      const cancelRaw = await readFile(join(skillsDir, "lightrsi-clean-cancel", "SKILL.md"), "utf8");
      assert.match(cancelRaw, /approval to cancel only that exact plan/);
      if (style === "codex") {
        for (const skillName of result.skillNames.filter((name) => name.startsWith("lightrsi-clean"))) {
          assert.match(
            await readFile(join(skillsDir, skillName, "agents", "openai.yaml"), "utf8"),
            /allow_implicit_invocation:\s*false/,
          );
        }
      } else {
        assert.match(skillRaw, /disable-model-invocation:\s*true/);
        for (const control of controlSkills) {
          assert.match(
            await readFile(join(skillsDir, control.name, "SKILL.md"), "utf8"),
            /disable-model-invocation:\s*true/,
          );
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
