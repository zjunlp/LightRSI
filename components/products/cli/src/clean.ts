import { promptForCleanTasks, type CleanTaskPrompt } from "./clean-prompt.js";
import {
  renderCleanPlan,
  renderCleanReceipt,
  type CleanPlanView,
  type CleanReceiptView,
} from "./clean-renderer.js";

export interface CleanCommandBackend {
  analyze(sessionId: string): Promise<CleanPlanView>;
  readPlan(planId: string): Promise<CleanPlanView | undefined>;
  approve(planId: string, selectedTaskIds: string[]): Promise<CleanReceiptView>;
  readReceipt(planId: string): Promise<CleanReceiptView | undefined>;
  cancel(planId: string): Promise<CleanReceiptView>;
}

export type CleanCommandBackendResolver = (params: {
  hostId: string;
  sessionId?: string;
  pathOverrides?: {
    tokenPilotConfigPath?: string;
    hostConfigPath?: string;
    hostAuxConfigPath?: string;
  };
}) => Promise<CleanCommandBackend | undefined> | CleanCommandBackend | undefined;

let backendResolver: CleanCommandBackendResolver | undefined;

/** Common Host registration point. Host-specific construction remains outside the CLI controller. */
export function registerCleanCommandBackendResolver(resolver: CleanCommandBackendResolver | undefined): void {
  backendResolver = resolver;
}

export function resolveCleanCommandBackend(params: {
  hostId: string;
  sessionId?: string;
  pathOverrides?: {
    tokenPilotConfigPath?: string;
    hostConfigPath?: string;
    hostAuxConfigPath?: string;
  };
}): Promise<CleanCommandBackend | undefined> {
  return Promise.resolve(backendResolver?.(params));
}

type ParsedCleanArgs =
  | { action: "analyze"; sessionId?: string }
  | { action: "approve"; planId: string; selectedTaskIds: string[] }
  | { action: "status"; planId: string }
  | { action: "cancel"; planId: string };

export function formatCleanUsage(): string {
  return [
    "Usage:",
    "  lightrsi <host> clean [--session <session-id>]",
    "  lightrsi <host> clean --plan <plan-id> --select <task-id[,task-id...]>",
    "  lightrsi <host> clean --status <plan-id>",
    "  lightrsi <host> clean --cancel <plan-id>",
  ].join("\n");
}

function parseCleanArgs(args: string[]): ParsedCleanArgs {
  if (args.length === 0) return { action: "analyze" };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    throw new Error("clean_help");
  }

  const valueAt = (index: number, missingError: string): string => {
    const value = args[index]?.trim();
    if (!value || value.startsWith("--")) throw new Error(missingError);
    return value;
  };

  if (args.length === 2 && args[0] === "--session") {
    return { action: "analyze", sessionId: valueAt(1, "clean_session_id_missing") };
  }
  if (args.length === 2 && args[0] === "--status") {
    return { action: "status", planId: valueAt(1, "clean_plan_id_missing") };
  }
  if (args.length === 2 && args[0] === "--cancel") {
    return { action: "cancel", planId: valueAt(1, "clean_plan_id_missing") };
  }
  if (args.length === 4 && args[0] === "--plan" && args[2] === "--select") {
    const selectedTaskIds = valueAt(3, "clean_selection_missing").split(",").map((taskId) => taskId.trim());
    if (selectedTaskIds.some((taskId) => !taskId)) throw new Error("clean_selection_malformed");
    return {
      action: "approve",
      planId: valueAt(1, "clean_plan_id_missing"),
      selectedTaskIds,
    };
  }
  throw new Error("clean_argument_syntax");
}

export function cleanSessionIdFromArgs(args: string[]): string | undefined {
  const parsed = parseCleanArgs(args);
  return parsed.action === "analyze" ? parsed.sessionId : undefined;
}

function validateSelection(plan: CleanPlanView, selectedTaskIds: string[]): string[] {
  if (selectedTaskIds.length === 0) throw new Error("clean_selection_empty");
  if (new Set(selectedTaskIds).size !== selectedTaskIds.length) throw new Error("clean_selection_duplicate_task");
  const tasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
  for (const taskId of selectedTaskIds) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`clean_selection_unknown_task:${taskId}`);
    if (!task.selectable) throw new Error(`clean_selection_task_protected:${taskId}`);
  }
  return selectedTaskIds;
}

async function approveSelection(
  backend: CleanCommandBackend,
  plan: CleanPlanView,
  selectedTaskIds: string[],
): Promise<string> {
  const selected = validateSelection(plan, selectedTaskIds);
  return renderCleanReceipt(await backend.approve(plan.planId, selected));
}

function renderNonInteractiveAnalysis(plan: CleanPlanView, rendered: string): string {
  const selectableTasks = plan.tasks.filter((task) => task.selectable);
  const choices = selectableTasks.length === 0
    ? "No selectable tasks are available; no changes were applied."
    : [
      "Selectable tasks:",
      "None selected by default.",
      ...selectableTasks.map((task, index) => `${index + 1}. ${task.taskId} - ${task.label}`),
      "Choose task IDs explicitly after reviewing this plan.",
    ].join("\n");
  const nextCommand = selectableTasks.length === 0
    ? ""
    : ` Apply with --plan ${plan.planId} --select <task-id[,task-id...]>`;
  return `${rendered}\n\n${choices}\n\nAnalysis only (non-interactive).${nextCommand}`;
}

export async function handleCleanCommand(params: {
  args: string[];
  sessionId?: string;
  backend: CleanCommandBackend;
  interactive?: boolean;
  prompt?: CleanTaskPrompt;
}): Promise<{ text: string }> {
  let parsed: ParsedCleanArgs;
  try {
    parsed = parseCleanArgs(params.args);
  } catch (error) {
    if (error instanceof Error && error.message === "clean_help") return { text: formatCleanUsage() };
    throw error;
  }

  if (parsed.action === "status") {
    const receipt = await params.backend.readReceipt(parsed.planId);
    return { text: receipt ? renderCleanReceipt(receipt) : `Context clean receipt not found: ${parsed.planId}` };
  }
  if (parsed.action === "cancel") return { text: renderCleanReceipt(await params.backend.cancel(parsed.planId)) };
  if (parsed.action === "approve") {
    const plan = await params.backend.readPlan(parsed.planId);
    if (!plan) throw new Error(`clean_plan_missing:${parsed.planId}`);
    return { text: await approveSelection(params.backend, plan, parsed.selectedTaskIds) };
  }

  const sessionId = parsed.sessionId ?? params.sessionId?.trim();
  if (!sessionId) throw new Error("clean_session_id_missing");
  const plan = await params.backend.analyze(sessionId);
  const rendered = renderCleanPlan(plan);
  const interactive = params.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return { text: renderNonInteractiveAnalysis(plan, rendered) };
  }
  const terminalPromptOwnsPlanOutput = params.prompt === undefined
    && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const resultText = (summary: string) => terminalPromptOwnsPlanOutput
    ? summary
    : `${rendered}\n\n${summary}`;
  const selection = await (params.prompt ?? promptForCleanTasks)(plan);
  if (selection === undefined) return { text: resultText("Context clean cancelled; no changes were applied.") };
  if (selection.length === 0) return { text: resultText("No tasks selected; no changes were applied.") };
  return { text: resultText(await approveSelection(params.backend, plan, selection)) };
}
