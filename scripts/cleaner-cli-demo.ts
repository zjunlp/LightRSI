#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readContextCleanPlan,
  readContextCleanReceipt,
  transitionContextCleanState,
  type ContextCleanAppliedReceipt,
} from "@lightrsi/cleaner";
import {
  buildTurnAbsId,
  createEmptySessionTaskRegistry,
  persistSessionTaskRegistry,
  type TaskLifecycle,
} from "@lightrsi/history";

import {
  appendCodexRequestJournalEntry,
  appendCodexResponseJournalEntry,
} from "../components/adapters/codex/src/context-history/index.js";
import { upsertCodexSessionSnapshot } from "../components/adapters/codex/src/session-state.js";
import { writeCliContextState } from "../components/products/cli/src/context-store.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = join(repositoryRoot, "var", "cleaner-cli-demo");
const demoHome = join(demoRoot, "home");
const stateDir = join(demoRoot, "codex-state");
const configPath = join(demoHome, ".codex", "tokenpilot.json");
const cliContextPath = join(demoHome, ".lightrsi", "state", "cli-context.json");
const cliEntryPath = join(repositoryRoot, "components", "products", "cli", "dist", "cli.js");
const manifestPath = join(demoRoot, "demo-manifest.json");
const variablesPath = join(demoRoot, "demo-variables.ps1");
const demoSessionIds = {
  single: "codex-cleaner-demo-single",
  cancel: "codex-cleaner-demo-cancel",
  batch: "codex-cleaner-demo-batch",
} as const;

type DemoTurn = {
  taskId: string;
  title: string;
  objective: string;
  lifecycle: TaskLifecycle;
  user: string;
  assistant: string;
};

type DemoPlanIds = {
  singleCleanPlanId: string;
  cancelCleanPlanId: string;
  batchCleanPlanId: string;
};

const turns: DemoTurn[] = [
  {
    taskId: "task-research",
    title: "Research context-cleaning designs",
    objective: "Compare task-scoped context-cleaning approaches",
    lifecycle: "evictable",
    user: `Research context-cleaning designs and compare their safety rules. ${"Archived research notes. ".repeat(80)}`,
    assistant: `The comparison is complete and the findings were delivered. ${"Completed research evidence. ".repeat(70)}`,
  },
  {
    taskId: "task-debug",
    title: "Debug an earlier daemon failure",
    objective: "Resolve a completed daemon startup investigation",
    lifecycle: "completed",
    user: `Investigate the earlier daemon startup failure. ${"Historical diagnostic trace. ".repeat(65)}`,
    assistant: `The daemon issue was isolated and fixed; no unresolved question remains. ${"Resolved diagnostic evidence. ".repeat(55)}`,
  },
  {
    taskId: "task-current",
    title: "Record the current Cleaner demo",
    objective: "Keep the active demo instructions available",
    lifecycle: "active",
    user: "Prepare the current Cleaner CLI demonstration and keep these instructions active.",
    assistant: "The Cleaner CLI demonstration is still in progress.",
  },
];

function taskSpan(sessionId: string, turnSeq: number) {
  const turnAbsId = buildTurnAbsId(sessionId, turnSeq);
  return {
    firstTurnAbsId: turnAbsId,
    lastTurnAbsId: turnAbsId,
    supportingTurnAbsIds: [turnAbsId],
    lastEstimatorTurnAbsId: turnAbsId,
  };
}

async function setupSession(sessionId: string): Promise<void> {
  let previousResponseId: string | undefined;
  for (const [index, turn] of turns.entries()) {
    const turnSeq = index + 1;
    const requestId = `${sessionId}-request-${turnSeq}`;
    const responseId = `${sessionId}-response-${turnSeq}`;
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId,
      turnOrdinal: turnSeq,
      payload: {
        model: "gpt-5.4-mini",
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        input: [
          ...(turnSeq === 1
            ? [{ role: "developer", content: "Preserve platform and safety instructions." }]
            : []),
          { role: "user", content: turn.user },
        ],
      },
      status: "completed",
      observedAt: `2026-09-02T00:0${turnSeq}:00.000Z`,
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId,
      response: {
        id: responseId,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        status: "completed",
        output: [{
          id: `${sessionId}-message-${turnSeq}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: turn.assistant }],
        }],
      },
      status: "completed",
      observedAt: `2026-09-02T00:0${turnSeq}:30.000Z`,
    });
    previousResponseId = responseId;
  }

  await upsertCodexSessionSnapshot(stateDir, sessionId, {
    latestResponseId: previousResponseId,
    latestModel: "gpt-5.4-mini",
    workspaceHint: repositoryRoot,
  });

  const registry = createEmptySessionTaskRegistry(sessionId);
  registry.version = 1;
  registry.lastProcessedTurnSeq = turns.length;
  registry.activeTaskIds = ["task-current"];
  registry.completedTaskIds = ["task-research", "task-debug"];
  registry.evictableTaskIds = ["task-research", "task-debug"];
  for (const [index, turn] of turns.entries()) {
    const turnSeq = index + 1;
    const turnAbsId = buildTurnAbsId(sessionId, turnSeq);
    registry.turnToTaskIds[turnAbsId] = [turn.taskId];
    registry.tasks[turn.taskId] = {
      taskId: turn.taskId,
      title: turn.title,
      objective: turn.objective,
      lifecycle: turn.lifecycle,
      completionEvidence: turn.lifecycle === "active" ? [] : ["Delivered in the recorded demo history"],
      unresolvedQuestions: [],
      span: taskSpan(sessionId, turnSeq),
    };
  }
  await persistSessionTaskRegistry(stateDir, registry);
}

function setupLines(): string[] {
  return [
    "Codex Cleaner CLI demo fixture is ready.",
    `Demo root: ${demoRoot}`,
    "Sessions:",
    `- single clean: ${demoSessionIds.single}`,
    `- cancelled plan: ${demoSessionIds.cancel}`,
    `- batch clean: ${demoSessionIds.batch}`,
    "",
    "PowerShell environment:",
    `$env:HOME = '${demoHome.replaceAll("'", "''")}'`,
    `$env:USERPROFILE = '${demoHome.replaceAll("'", "''")}'`,
    `$env:TOKENPILOT_CODEX_CONFIG = '${configPath.replaceAll("'", "''")}'`,
    `$singleCleanSessionId = '${demoSessionIds.single}'`,
    `$cancelCleanSessionId = '${demoSessionIds.cancel}'`,
    `$batchCleanSessionId = '${demoSessionIds.batch}'`,
    "",
    "The latest/default Codex session is the single-clean session, so `lightrsi codex clean` works without --session.",
  ];
}

async function setup(showInstructions = true): Promise<void> {
  await rm(demoRoot, { recursive: true, force: true });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    enabled: true,
    stateDir,
    proxyPort: 17699,
    upstreamProvider: "demo-local",
    upstream: {
      name: "demo-local",
      baseUrl: "http://127.0.0.1:9/v1",
      wireApi: "responses",
      requiresOpenAIAuth: false,
    },
    taskStateEstimator: { enabled: false },
    contextRewrite: { enabled: true },
  }, null, 2)}\n`, "utf8");

  // Keep the session selected by the canonical no-argument clean command deterministic:
  // Codex resolves the most recently observed Host session when --session is omitted.
  await setupSession(demoSessionIds.batch);
  await setupSession(demoSessionIds.cancel);
  await setupSession(demoSessionIds.single);
  await writeCliContextState({
    lastActiveHost: "codex",
    lastSessionByHost: { codex: demoSessionIds.single },
    configPathsByHost: {
      codex: { tokenPilotConfigPath: configPath },
    },
    lastUpdatedAt: "2026-09-02T00:10:00.000Z",
  }, cliContextPath);

  if (showInstructions) process.stdout.write(`${setupLines().join("\n")}\n`);
}

function runDemoCli(args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, [cliEntryPath, ...args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: demoHome,
        USERPROFILE: demoHome,
        TOKENPILOT_CODEX_CONFIG: configPath,
      },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error([
          `Cleaner demo CLI failed: ${args.join(" ")}`,
          stderr.trim(),
          stdout.trim(),
        ].filter(Boolean).join("\n")));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function createAnalyzedPlan(sessionId: string): Promise<string> {
  const output = await runDemoCli(["codex", "clean", "--session", sessionId]);
  const planId = /Context clean plan (\S+)/.exec(output)?.[1]?.trim();
  if (!planId) throw new Error(`Cleaner demo plan ID missing for session: ${sessionId}`);
  return planId;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function writePreparedArtifacts(planIds: DemoPlanIds): Promise<void> {
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    demoRoot,
    configPath,
    sessions: {
      single: { sessionId: demoSessionIds.single, planId: planIds.singleCleanPlanId },
      cancel: { sessionId: demoSessionIds.cancel, planId: planIds.cancelCleanPlanId },
      batch: { sessionId: demoSessionIds.batch, planId: planIds.batchCleanPlanId },
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(variablesPath, [
    `Set-Location -LiteralPath ${psQuote(repositoryRoot)}`,
    `function global:lightrsi { & node ${psQuote(cliEntryPath)} @args }`,
    `$env:HOME = ${psQuote(demoHome)}`,
    `$env:USERPROFILE = ${psQuote(demoHome)}`,
    `$env:TOKENPILOT_CODEX_CONFIG = ${psQuote(configPath)}`,
    `$singleCleanSessionId = ${psQuote(demoSessionIds.single)}`,
    `$cancelCleanSessionId = ${psQuote(demoSessionIds.cancel)}`,
    `$batchCleanSessionId = ${psQuote(demoSessionIds.batch)}`,
    `$singleCleanPlanId = ${psQuote(planIds.singleCleanPlanId)}`,
    `$cancelCleanPlanId = ${psQuote(planIds.cancelCleanPlanId)}`,
    `$batchCleanPlanId = ${psQuote(planIds.batchCleanPlanId)}`,
    "",
  ].join("\r\n"), "utf8");
}

async function prepare(): Promise<void> {
  await setup(false);
  const planIds: DemoPlanIds = {
    singleCleanPlanId: await createAnalyzedPlan(demoSessionIds.single),
    cancelCleanPlanId: await createAnalyzedPlan(demoSessionIds.cancel),
    batchCleanPlanId: await createAnalyzedPlan(demoSessionIds.batch),
  };
  await writePreparedArtifacts(planIds);
  process.stdout.write([
    "Codex Cleaner CLI demo plans are prepared in analyzed state.",
    `- single: ${planIds.singleCleanPlanId}`,
    `- cancel: ${planIds.cancelCleanPlanId}`,
    `- batch: ${planIds.batchCleanPlanId}`,
    `Manifest: ${manifestPath}`,
    `PowerShell variables: ${variablesPath}`,
    "",
    "Load the prepared demo in the current PowerShell:",
    `. ${psQuote(variablesPath)}`,
  ].join("\n") + "\n");
}

async function apply(planId: string): Promise<void> {
  if (!planId.trim()) throw new Error("Usage: cleaner:demo:codex apply <plan-id>");
  const planRead = await readContextCleanPlan({ stateDir, planId });
  const receiptRead = await readContextCleanReceipt({ stateDir, planId });
  if (planRead.bypassed || !planRead.value) throw new Error(`Demo plan not found: ${planId}`);
  if (receiptRead.bypassed || receiptRead.value?.status !== "scheduled") {
    throw new Error(`Demo plan is not scheduled: ${planId}`);
  }
  const plan = planRead.value.plan;
  if (!Object.values(demoSessionIds).includes(plan.sessionId as typeof demoSessionIds[keyof typeof demoSessionIds])) {
    throw new Error(`Plan does not belong to a Cleaner CLI demo session: ${planId}`);
  }
  const scheduled = receiptRead.value;
  const selected = new Set(scheduled.selectedTaskIds);
  const itemIds = plan.tasks
    .filter((task) => selected.has(task.taskId))
    .flatMap((task) => task.itemIds);
  if (itemIds.length === 0) throw new Error("Demo scheduled plan has no selected items");
  const suffix = createHash("sha256").update(`${planId}:${itemIds.join(",")}`).digest("hex").slice(0, 12);
  const applied: ContextCleanAppliedReceipt = {
    ...scheduled,
    status: "applied",
    fallbackUsed: false,
    appliedSavedTokens: scheduled.estimatedSavedTokens,
    appliedSavedChars: scheduled.estimatedSavedChars,
    evidence: {
      previousRevision: plan.baseRevision,
      nextRevision: `demo-applied-${suffix}`,
      operationIds: [`demo-operation-${suffix}`],
      itemIds,
      providerResponseId: `demo-response-${suffix}`,
    },
    reasons: [...scheduled.reasons, "offline_demo_host_success"],
    updatedAt: new Date().toISOString(),
  };
  const result = await transitionContextCleanState({ stateDir, receipt: applied });
  if (result.bypassed) throw new Error(`Demo apply failed: ${result.reasons.join(",")}`);
  process.stdout.write(`Simulated successful Host request for ${planId}; receipt is now applied.\n`);
}

async function main(): Promise<void> {
  const [command, argument = ""] = process.argv.slice(2);
  if (command === "setup") await setup();
  else if (command === "prepare") await prepare();
  else if (command === "apply") await apply(argument);
  else throw new Error("Usage: cleaner:demo:codex <setup|prepare|apply> [plan-id]");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
