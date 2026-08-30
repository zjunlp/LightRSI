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

type ParsedCleanArgs = {
  sessionId?: string;
  planId?: string;
  selectedTaskIds?: string[];
  status: boolean;
  cancel: boolean;
};

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
  const parsed: ParsedCleanArgs = { status: false, cancel: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--plan") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("clean_plan_id_missing");
      if (parsed.planId) throw new Error("clean_plan_id_duplicate");
      parsed.planId = value;
    } else if (argument === "--session") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("clean_session_id_missing");
      if (parsed.sessionId) throw new Error("clean_session_id_duplicate");
      parsed.sessionId = value;
    } else if (argument === "--select") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("clean_selection_missing");
      if (parsed.selectedTaskIds) throw new Error("clean_selection_duplicate_argument");
      parsed.selectedTaskIds = value.split(",").map((taskId) => taskId.trim()).filter(Boolean);
    } else if (argument === "--status" || argument === "--cancel") {
      const action = argument === "--status" ? "status" : "cancel";
      if (parsed[action]) throw new Error(`clean_${action}_duplicate`);
      parsed[action] = true;
      const possiblePlanId = args[index + 1]?.trim();
      if (possiblePlanId && !possiblePlanId.startsWith("--")) {
        index += 1;
        if (parsed.planId && parsed.planId !== possiblePlanId) throw new Error("clean_plan_id_conflict");
        parsed.planId = possiblePlanId;
      }
    } else if (argument === "--help" || argument === "-h") throw new Error("clean_help");
    else throw new Error(`clean_argument_unknown:${argument}`);
  }
  const actions = Number(parsed.selectedTaskIds !== undefined) + Number(parsed.status) + Number(parsed.cancel);
  if (actions > 1) throw new Error("clean_action_conflict");
  if (actions > 0 && !parsed.planId) throw new Error("clean_plan_id_missing");
  if (parsed.planId && actions === 0) throw new Error("clean_action_missing");
  return parsed;
}

export function cleanSessionIdFromArgs(args: string[]): string | undefined {
  const indexes = args.flatMap((argument, index) => argument === "--session" ? [index] : []);
  if (indexes.length === 0) return undefined;
  if (indexes.length > 1) throw new Error("clean_session_id_duplicate");
  const sessionId = args[indexes[0]! + 1]?.trim();
  if (!sessionId || sessionId.startsWith("--")) throw new Error("clean_session_id_missing");
  return sessionId;
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

  if (parsed.planId) {
    if (parsed.status) {
      const receipt = await params.backend.readReceipt(parsed.planId);
      return { text: receipt ? renderCleanReceipt(receipt) : `Context clean receipt not found: ${parsed.planId}` };
    }
    if (parsed.cancel) return { text: renderCleanReceipt(await params.backend.cancel(parsed.planId)) };
    const plan = await params.backend.readPlan(parsed.planId);
    if (!plan) throw new Error(`clean_plan_missing:${parsed.planId}`);
    return { text: await approveSelection(params.backend, plan, parsed.selectedTaskIds!) };
  }

  const sessionId = parsed.sessionId ?? params.sessionId?.trim();
  if (!sessionId) throw new Error("clean_session_id_missing");
  const plan = await params.backend.analyze(sessionId);
  const rendered = renderCleanPlan(plan);
  const interactive = params.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return {
      text: `${rendered}\n\nAnalysis only (non-interactive). Apply with --plan ${plan.planId} --select <task-id[,task-id...]>`,
    };
  }
  const selection = await (params.prompt ?? promptForCleanTasks)(plan);
  if (selection === undefined) return { text: `${rendered}\n\nContext clean cancelled; no changes were applied.` };
  if (selection.length === 0) return { text: `${rendered}\n\nNo tasks selected; no changes were applied.` };
  return { text: `${rendered}\n\n${await approveSelection(params.backend, plan, selection)}` };
}
