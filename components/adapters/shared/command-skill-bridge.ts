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
  mode: "read_only" | "cleaner";
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
    mode: "cleaner",
  },
];

const LEGACY_SKILL_NAMES = [
  "lightmem2-status",
  "lightmem2-report",
  "lightmem2-doctor",
  "lightmem2-visual",
  "lightmem2-clean",
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
  const body = params.spec.mode === "cleaner"
    ? [
      `Run the local LightRSI Cleaner analysis for ${params.host} and return the output.`,
      "",
      "Execution rules:",
      "1. Prefer the installed CLI command if it exists:",
      `   ${commandText}`,
      "2. If `lightrsi` is unavailable in PATH, run this exact fallback command instead:",
      `   ${params.cliCommand}`,
      "3. Return the command output in a fenced code block.",
      "4. If the command fails, briefly explain the failure and include the stderr text.",
      "",
      "Safety rules:",
      "- This command may create an analyzed plan, but it must not schedule or apply a rewrite.",
      "- Never choose task IDs, item IDs, item digests, or deletion ranges.",
      "- Never add `--plan`, `--select`, `--status`, or `--cancel` to the command.",
      "- Never answer the confirmation prompt or run a follow-up command from its output.",
      "- The user must personally review the analysis and enter any later confirmation command.",
    ].join("\n")
    : [
      `Run the local LightRSI command surface for ${params.host} and return the output.`,
      "",
      "Execution rules:",
      "1. Prefer the installed CLI command if it exists:",
      `   ${commandText}`,
      "2. If `lightrsi` is unavailable in PATH, run this exact fallback command instead:",
      `   ${params.cliCommand}`,
      "3. Return the command output in a fenced code block.",
      "4. If the command fails, briefly explain the failure and include the stderr text.",
      "",
      "Do not modify configuration in this skill. This bridge is read-only.",
    ].join("\n");

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
