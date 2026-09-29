import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type SkillBridgeStyle = "claude" | "codex";

type InstallCommandSkillBridgeParams = {
  adapterRoot: string;
  skillsDir: string;
  host: "codex" | "claude-code";
  style: SkillBridgeStyle;
};

type SkillSpec = {
  name: string;
  description: string;
  commandArgs: string[];
  mode: "read_only" | "cleaner_analysis" | "cleaner_status" | "cleaner_apply" | "cleaner_cancel";
};

const COMMAND_SKILLS: SkillSpec[] = [
  {
    name: "lightrsi-status",
    description: "Show the current LightRSI runtime status for this host. Only use when explicitly invoked.",
    commandArgs: ["status"],
    mode: "read_only",
  },
  {
    name: "lightrsi-report",
    description: "Show the current LightRSI savings report for this host. Only use when explicitly invoked.",
    commandArgs: ["report"],
    mode: "read_only",
  },
  {
    name: "lightrsi-doctor",
    description: "Run the LightRSI doctor for this host and report installation or runtime drift. Only use when explicitly invoked.",
    commandArgs: ["doctor"],
    mode: "read_only",
  },
  {
    name: "lightrsi-visual",
    description: "Show the current LightRSI text-mode session visual for this host. Only use when explicitly invoked.",
    commandArgs: ["visual"],
    mode: "read_only",
  },
  {
    name: "lightrsi-clean",
    description: "Analyze the current context with LightRSI Cleaner. Only use when explicitly invoked; user confirmation is required before any clean is scheduled.",
    commandArgs: ["clean"],
    mode: "cleaner_analysis",
  },
  {
    name: "lightrsi-clean-status",
    description: "Show one LightRSI Cleaner plan receipt. Only use when explicitly invoked with the complete plan ID.",
    commandArgs: ["clean", "--status", "<plan-id>"],
    mode: "cleaner_status",
  },
  {
    name: "lightrsi-clean-apply",
    description: "Schedule explicitly selected LightRSI Cleaner tasks. Only use when explicitly invoked with the complete plan ID and complete task IDs.",
    commandArgs: ["clean", "--plan", "<plan-id>", "--select", "<task-id[,task-id...]>"],
    mode: "cleaner_apply",
  },
  {
    name: "lightrsi-clean-cancel",
    description: "Cancel one LightRSI Cleaner plan. Only use when explicitly invoked with the complete plan ID.",
    commandArgs: ["clean", "--cancel", "<plan-id>"],
    mode: "cleaner_cancel",
  },
];

const LEGACY_SKILL_NAMES = [
  "lightmem2-status",
  "lightmem2-report",
  "lightmem2-doctor",
  "lightmem2-visual",
  "lightmem2-clean",
  "lightmem2-clean-status",
  "lightmem2-clean-apply",
  "lightmem2-clean-cancel",
];

function cliDistPathFromAdapterRoot(adapterRoot: string): string {
  const bundledPath = resolve(adapterRoot, "dist", "lightrsi.js");
  if (existsSync(bundledPath)) return bundledPath;
  return resolve(adapterRoot, "..", "..", "products", "cli", "dist", "cli.js");
}

function shellCommand(cliPath: string, host: string, commandArgs: string[]): string {
  const argv = [cliPath, host, ...commandArgs];
  return `node ${argv.map((value) => JSON.stringify(value)).join(" ")}`;
}

function skillMarkdown(params: {
  style: SkillBridgeStyle;
  spec: SkillSpec;
  host: "codex" | "claude-code";
  cliCommand: string;
}): string {
  const commandText = `lightrsi ${params.host} ${params.spec.commandArgs.join(" ")}`;
  const claudeCleanerInteractiveHelp = params.host === "claude-code"
    ? [
      "",
      "Same-terminal interactive selection:",
      "- Claude Code runs this skill without a TTY, so this skill only analyzes and prints the plan.",
      "- Preserve and point out the complete `Interactive selection in this same terminal` block from the command output.",
      "- The user must run `/exit`, then personally run the printed `lightrsi claude-code clean --require-tty --session <session-id>` command in that same terminal.",
      "- In the selector, Up/Down moves, Space toggles a task, Enter submits, and `q` cancels without scheduling a clean.",
      "- After the selector returns, the user must run the printed `claude --resume <session-id>` command with that same session ID.",
      "- Submitting schedules only the selected tasks. The rewrite runs once on the next ordinary Claude Code request after the session is resumed.",
    ].join("\n")
    : "";
  const codexCleanerAnalysisBody = [
    "Analyze and schedule a LightRSI Cleaner selection through the Codex MCP form.",
    "For exact raw terminal controls, the user must type the user-entered `!lightrsi-clean` command; it provides Up/Down, Space, Enter, and `q` directly in the current terminal.",
    "The MCP form remains the compatibility path and may use controls chosen by the Codex client.",
    "",
    "Execution rules:",
    "1. Call `lightrsi_cleaner.lightrsi_clean` exactly once with an empty input object.",
    "2. Let the MCP tool show the complete plan and let Codex collect the user's selection.",
    "3. Return the tool result to the user, including any cancellation or error result.",
    "4. Do not run a shell command or invoke the LightRSI CLI as part of this skill.",
    "",
    "Safety rules:",
    "- Do not supply, infer, or rewrite plan IDs, task IDs, item IDs, item digests, or deletion ranges.",
    "- Do not call the Cleaner apply, status, or cancel command after the MCP tool returns.",
    "- The selection accepted in the Codex form is the only selection authorized by this invocation.",
  ].join("\n");
  const cleanerBodies = {
    cleaner_analysis: [
      `Run the local LightRSI Cleaner analysis for ${params.host} and return the output.`,
      "",
      "Execution rules:",
      "1. Run this exact version-pinned bundled CLI command:",
      `   ${params.cliCommand}`,
      "2. Only if that bundled file is missing, use the installed PATH command instead:",
      `   ${commandText}`,
      "3. Return the command output in a fenced code block.",
      "4. If the command fails, briefly explain the failure and include the stderr text.",
      "",
      "Safety rules:",
      "- This command may create an analyzed plan, but it must not schedule or apply a rewrite.",
      "- Never choose task IDs, item IDs, item digests, or deletion ranges.",
      "- Never add `--plan`, `--select`, `--status`, or `--cancel` to the command.",
      "- Never answer the confirmation prompt or run a follow-up command from its output.",
      "- The user must personally review the analysis and enter any later confirmation command.",
      claudeCleanerInteractiveHelp,
    ].join("\n"),
    cleaner_status: [
      `Read one local LightRSI Cleaner receipt for ${params.host} and return the output.`,
      "",
      "Required input:",
      "- The current user request must contain exactly one complete plan ID matching `ctxclean-[A-Za-z0-9]+`.",
      "- Use that plan ID verbatim. If it is missing or ambiguous, do not run a command; ask for one complete plan ID.",
      "",
      "Execution rules:",
      "1. Replace `<plan-id>` with the validated plan ID.",
      "2. Run this version-pinned bundled command with the same replacement:",
      `   ${params.cliCommand}`,
      "3. Only if that bundled file is missing, use the installed PATH command instead:",
      `   ${commandText}`,
      "4. Return the command output in a fenced code block.",
      "5. If the command fails, briefly explain the failure and include the stderr text.",
      "",
      "Safety rules:",
      "- This skill is read-only. Never analyze, select, schedule, apply, or cancel a plan.",
      "- Never reuse a plan ID from another task when the current request does not contain it.",
      "- Never add any CLI arguments beyond the documented `--status <plan-id>` form.",
    ].join("\n"),
    cleaner_apply: [
      `Schedule the exact LightRSI Cleaner task selection explicitly supplied by the user for ${params.host}.`,
      "",
      "Required input and confirmation:",
      "- The current user request must explicitly invoke this skill and contain exactly one complete plan ID matching `ctxclean-[A-Za-z0-9]+`.",
      "- It must also contain one or more complete task IDs copied from selectable rows in that plan.",
      "- Explicit invocation with both the plan ID and task IDs is approval to schedule only those exact task IDs.",
      "- Each task ID must match `[A-Za-z0-9][A-Za-z0-9._:-]*`; multiple IDs must be comma-separated without inventing or expanding selections.",
      "- If any required value is missing, ambiguous, duplicated, or malformed, do not run a command; ask the user to provide the complete values.",
      "",
      "Execution rules:",
      "1. Replace `<plan-id>` and `<task-id[,task-id...]>` with the validated values, preserving every ID verbatim.",
      "2. Run this version-pinned bundled command with the same replacements:",
      `   ${params.cliCommand}`,
      "3. Only if that bundled file is missing, use the installed PATH command instead:",
      `   ${commandText}`,
      "4. Return the command output in a fenced code block and state that an accepted selection applies on the next Host request.",
      "5. If the command fails, briefly explain the failure and include the stderr text.",
      "",
      "Safety rules:",
      "- Never choose, infer, shorten, repair, or add a task ID. In particular, a session ID without the task suffix is not a task ID.",
      "- Never select protected or non-selectable rows, even if the user supplies them; let the CLI reject stale or invalid selections.",
      "- Never run analysis, status, cancel, or a subsequent Host request as part of this skill.",
      "- Never construct item IDs, item digests, deletion ranges, or any lower-level rewrite command.",
    ].join("\n"),
    cleaner_cancel: [
      `Cancel one local LightRSI Cleaner plan for ${params.host} and return the receipt.`,
      "",
      "Required input and confirmation:",
      "- The current user request must explicitly invoke this skill and contain exactly one complete plan ID matching `ctxclean-[A-Za-z0-9]+`.",
      "- Explicit invocation with that plan ID is approval to cancel only that exact plan.",
      "- If the plan ID is missing or ambiguous, do not run a command; ask for one complete plan ID.",
      "",
      "Execution rules:",
      "1. Replace `<plan-id>` with the validated plan ID, preserving it verbatim.",
      "2. Run this version-pinned bundled command with the same replacement:",
      `   ${params.cliCommand}`,
      "3. Only if that bundled file is missing, use the installed PATH command instead:",
      `   ${commandText}`,
      "4. Return the command output in a fenced code block.",
      "5. If the command fails, briefly explain the failure and include the stderr text.",
      "",
      "Safety rules:",
      "- Never infer a plan ID from another task or cancel more than one plan.",
      "- Never run analysis, status, selection, apply, or a subsequent Host request as part of this skill.",
      "- Never add any CLI arguments beyond the documented `--cancel <plan-id>` form.",
    ].join("\n"),
  } as const;
  const body = params.style === "codex" && params.spec.mode === "cleaner_analysis"
    ? codexCleanerAnalysisBody
    : params.spec.mode === "read_only"
    ? [
      `Run the local LightRSI command surface for ${params.host} and return the output.`,
      "",
      "Execution rules:",
      "1. Run this exact version-pinned bundled CLI command:",
      `   ${params.cliCommand}`,
      "2. Only if that bundled file is missing, use the installed PATH command instead:",
      `   ${commandText}`,
      "3. Return the command output in a fenced code block.",
      "4. If the command fails, briefly explain the failure and include the stderr text.",
      "",
      "Do not modify configuration in this skill. This bridge is read-only.",
    ].join("\n")
      : cleanerBodies[params.spec.mode];

  if (params.style === "claude") {
    return [
      "---",
      `name: ${params.spec.name}`,
      `description: ${params.spec.description}`,
      "disable-model-invocation: true",
      "allowed-tools: Bash(lightrsi *) Bash(node *)",
      "---",
      "",
      body,
      "",
    ].join("\n");
  }

  return [
    "---",
    `name: ${params.spec.name}`,
    `description: ${params.spec.description}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function codexSkillPolicyYaml(): string {
  return [
    "policy:",
    "  allow_implicit_invocation: false",
    "",
  ].join("\n");
}

export async function installCommandSkillBridge(
  params: InstallCommandSkillBridgeParams,
): Promise<{ skillsDir: string; skillNames: string[] }> {
  const cliPath = cliDistPathFromAdapterRoot(params.adapterRoot);
  await mkdir(params.skillsDir, { recursive: true });

  for (const legacySkillName of LEGACY_SKILL_NAMES) {
    await rm(join(params.skillsDir, legacySkillName), { recursive: true, force: true });
  }

  for (const spec of COMMAND_SKILLS) {
    const skillDir = join(params.skillsDir, spec.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skillMarkdown({
      style: params.style,
      spec,
      host: params.host,
      cliCommand: shellCommand(cliPath, params.host, spec.commandArgs),
    }), "utf8");

    if (params.style === "codex") {
      const agentsDir = join(skillDir, "agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, "openai.yaml"), codexSkillPolicyYaml(), "utf8");
    }
  }

  return {
    skillsDir: params.skillsDir,
    skillNames: COMMAND_SKILLS.map((spec) => spec.name),
  };
}

export function defaultCodexSkillBridgeDir(codexHomeDir: string): string {
  return join(codexHomeDir, "skills");
}

export function defaultClaudeCodeSkillBridgeDir(settingsPath: string): string {
  return join(dirname(settingsPath), "skills");
}
