/**
 * Native, read-only Context Cleaner commands for DeepSeek Harness.
 *
 * `/tokenpilot-clean` never adds a user message and never starts an LLM turn.
 * Analysis writes an immutable plan; explicit selection writes only a durable
 * schedule. The next real `agent/pre-step` is the sole place that can rewrite
 * the DSH canonical surface.
 */

import {
  createContextCleanerControlPlane,
  createContextCleanerControlService,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerControlService,
} from "@lightrsi/cleaner";
import {
  loadSessionTaskRegistry,
  type SessionTaskRegistry,
} from "@lightrsi/history";

import type {
  TokenPilotCommandDefinition,
  TokenPilotCommandInvocation,
  TokenPilotCommandResult,
} from "../commands.js";
import type { TokenPilotDshConfig } from "../config.js";
import type { DshSession, DshTokenMeter } from "../types.js";
import { createDshCleanerCapabilities } from "./capabilities.js";
import { cancelDshCleanerSchedule, readDshCleanerSchedule } from "./scheduler.js";
import type { DshCleanSnapshotSession } from "./snapshot.js";
import type { DshCleanerSessionStore } from "./session-catalog.js";

/** The optional DSH command capability used by the Cleaner. */
export interface ContextCleanerCommandContext {
  readonly commands: {
    register(definition: TokenPilotCommandDefinition): () => void;
  };
  /** Kept optional for old callers; Cleaner commands never meter or mutate. */
  readonly tokenMeter?: DshTokenMeter;
}

export type ContextCleanerCommandDependencies = {
  /** Test seam; production reads the durable TaskState registry. */
  loadRegistry?: (
    sessionId: string,
  ) => Promise<SessionTaskRegistry> | SessionTaskRegistry;
  /** Test seam for reproducible timestamps. */
  now?: () => string;
  /** Optional live DSH session catalogue, supplied by Cordis injection. */
  getSessions?: () => DshCleanerSessionStore | undefined;
};

type Runtime = {
  readonly stateDir: string;
  readonly sessions: DshCleanerSessionStore;
  readonly control: ContextCleanerControlService;
};

type ParsedInput =
  | { kind: "analyze"; sessionId?: string }
  | { kind: "schedule"; planId: string; selectedTaskIds: string[] }
  | { kind: "status"; planId: string }
  | { kind: "cancel"; planId: string }
  | { kind: "help" }
  | { kind: "invalid" };

function singleSessionStore(session: DshSession): DshCleanerSessionStore {
  const catalogSession = session as unknown as DshCleanSnapshotSession;
  return {
    list: () => [catalogSession],
    get: (sessionId) => sessionId === session.id ? catalogSession : undefined,
  };
}
function configuredStateDir(config: TokenPilotDshConfig): string | undefined {
  if (!config.enabled || !config.stateDir?.trim()) return undefined;
  return config.stateDir.trim();
}

function createRuntime(
  session: DshSession,
  config: TokenPilotDshConfig,
  dependencies: ContextCleanerCommandDependencies,
): Runtime | undefined {
  const stateDir = configuredStateDir(config);
  if (!stateDir) return undefined;

  const sessions = dependencies.getSessions?.() ?? singleSessionStore(session);
  const loadRegistry = dependencies.loadRegistry
    ?? ((sessionId: string) => loadSessionTaskRegistry(stateDir, sessionId));
  const capabilities = createDshCleanerCapabilities({
    stateDir,
    sessions,
    loadRegistry,
  });
  const controlPlane = createContextCleanerControlPlane({
    stateDir,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  return {
    stateDir,
    sessions,
    control: createContextCleanerControlService({
      stateDir,
      capabilities,
      controlPlane,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    }),
  };
}
function helpText(): string {
  return [
    "TokenPilot Context Cleaner",
    "Usage:",
    "  /tokenpilot-clean [--session <session-id>]",
    "  /tokenpilot-clean --plan <plan-id> --select <task-id[,task-id...]>",
    "  /tokenpilot-clean --status <plan-id>",
    "  /tokenpilot-clean --cancel <plan-id>",
    "",
    "Analysis and cancel are read-only for the DSH context. A selection is only scheduled; the next agent request performs the canonical cleanup.",
  ].join("\n");
}

function notConfiguredText(): string {
  return [
    "Context Cleaner is unavailable.",
    "Set tokenpilot-dsh enabled: true and provide a writable stateDir, then reload the DSH profile.",
  ].join("\n");
}

function parseTaskIds(value: string): string[] | undefined {
  const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
  return ids.length > 0 && new Set(ids).size === ids.length ? ids : undefined;
}

function parseFlags(tokens: string[]): Map<string, string> | undefined {
  const flags = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || !value || flags.has(flag)) return undefined;
    flags.set(flag, value);
  }
  return flags;
}

function parseInput(rawInput: string): ParsedInput {
  const input = rawInput.trim();
  if (!input) return { kind: "analyze" };
  if (input === "help" || input === "--help") return { kind: "help" };

  // Keep the original private command syntax as a compatibility alias while
  // making the documented flag form the canonical public contract.
  const legacy = input.split(/\s+/);
  if (legacy[0] === "apply" && legacy[1] && legacy[2] && legacy.length === 3) {
    const selectedTaskIds = parseTaskIds(legacy[2]);
    return selectedTaskIds ? { kind: "schedule", planId: legacy[1], selectedTaskIds } : { kind: "invalid" };
  }
  if (legacy[0] === "status" && legacy[1] && legacy.length === 2) return { kind: "status", planId: legacy[1] };
  if (legacy[0] === "cancel" && legacy[1] && legacy.length === 2) return { kind: "cancel", planId: legacy[1] };

  const flags = parseFlags(legacy);
  if (!flags) return { kind: "invalid" };
  if (flags.size === 1 && flags.has("--session")) {
    return { kind: "analyze", sessionId: flags.get("--session") };
  }
  if (flags.size === 2 && flags.has("--plan") && flags.has("--select")) {
    const selectedTaskIds = parseTaskIds(flags.get("--select")!);
    return selectedTaskIds
      ? { kind: "schedule", planId: flags.get("--plan")!, selectedTaskIds }
      : { kind: "invalid" };
  }
  if (flags.size === 1 && flags.has("--status")) return { kind: "status", planId: flags.get("--status")! };
  if (flags.size === 1 && flags.has("--cancel")) return { kind: "cancel", planId: flags.get("--cancel")! };
  return { kind: "invalid" };
}

function taskSize(task: ContextCleanPlan["tasks"][number]): string {
  return task.tokenCount === null ? `${task.charCount} chars` : `${task.tokenCount} tok / ${task.charCount} chars`;
}

function taskRisk(task: ContextCleanPlan["tasks"][number]): string {
  return task.reasonCodes.length === 0 ? "none" : task.reasonCodes.join(", ");
}

function formatPlan(plan: ContextCleanPlan, fallbackUsed: boolean): string {
  const lines = [
    "Context Cleaner plan",
    `plan id: ${plan.planId}`,
    `session: ${plan.sessionId}`,
    `surface revision: ${plan.baseRevision}`,
    `context: ${plan.usedChars} chars (${plan.tokenCountMode}); protected: ${plan.protectedChars}; unassigned: ${plan.unassignedChars}`,
    fallbackUsed
      ? "recommendations: deterministic safe fallback (no extra model request)"
      : "recommendations: model-assisted",
    "",
    "SEL | TASK | SIZE | ADVICE | RISK | DESCRIPTION",
  ];
  if (plan.tasks.length === 0) {
    lines.push("(no completed, evictable task is eligible for cleanup)");
  } else {
    for (const task of plan.tasks) {
      const selectable = task.selectable ? "[ ]" : "[-]";
      lines.push(
        `${selectable} | ${task.taskId} | ${taskSize(task)} | ${task.recommendation} | ${taskRisk(task)} | ${task.label}`,
      );
    }
  }
  lines.push(
    "",
    `Schedule explicit task IDs only: /tokenpilot-clean --plan ${plan.planId} --select <task-id>`,
  );
  return lines.join("\n");
}

function formatReceipt(receipt: ContextCleanReceipt): string {
  const lines = [
    "Context Cleaner status",
    `plan id: ${receipt.planId}`,
    `status: ${receipt.status}`,
    `selected tasks: ${receipt.selectedTaskIds.join(", ") || "none"}`,
    `estimated saved: ${receipt.estimatedSavedChars} chars`,
    `fallback used: ${receipt.fallbackUsed ? "yes" : "no"}`,
  ];
  if (receipt.status === "applied") {
    lines.push(
      `applied saved: ${receipt.appliedSavedChars} chars`,
      `surface: ${receipt.evidence.previousRevision} -> ${receipt.evidence.nextRevision}`,
    );
  }
  if (receipt.reasons.length > 0) lines.push(`reasons: ${receipt.reasons.join(", ")}`);
  return lines.join("\n");
}

async function analyze(
  runtime: Runtime,
  invocation: TokenPilotCommandInvocation,
  sessionId?: string,
): Promise<TokenPilotCommandResult> {
  const targetSessionId = sessionId ?? invocation.agent.session.id;
  if (!runtime.sessions.get(targetSessionId)) {
    return { kind: "error", text: "Context Cleaner session is unavailable in this DSH host." };
  }
  const plan = await runtime.control.analyze(targetSessionId);
  const receipt = await runtime.control.readReceipt(plan.planId);
  return { kind: "success", text: formatPlan(plan, receipt?.fallbackUsed ?? false) };
}

async function readStatus(
  runtime: Runtime,
  planId: string,
): Promise<TokenPilotCommandResult> {
  const receipt = await runtime.control.readReceipt(planId);
  return receipt
    ? { kind: "success", text: formatReceipt(receipt) }
    : { kind: "error", text: "Context Cleaner plan was not found." };
}

async function schedule(
  runtime: Runtime,
  planId: string,
  selectedTaskIds: string[],
): Promise<TokenPilotCommandResult> {
  const receipt = await runtime.control.approve(planId, selectedTaskIds);
  return {
    kind: "success",
    text: [
      formatReceipt(receipt),
      receipt.status === "scheduled"
        ? "The selection is scheduled. Send the next agent request to perform the canonical cleanup."
        : "This plan is already terminal; no context mutation was requested.",
    ].join("\n"),
  };
}

async function cancel(runtime: Runtime, planId: string): Promise<TokenPilotCommandResult> {
  const plan = await runtime.control.readPlan(planId);
  if (!plan) return { kind: "error", text: "Context Cleaner plan was not found." };

  // Claim and cancel compete through the same local pointer. Mark a pending
  // pointer cancelled *before* moving the shared receipt so a concurrently
  // starting pre-step can never rewrite after the user sees a cancellation.
  const pointer = await readDshCleanerSchedule({ stateDir: runtime.stateDir, sessionId: plan.sessionId });
  if (pointer.outcome === "claimed" && pointer.record.cleanPlanId === planId) {
    return {
      kind: "error",
      text: "Context Cleaner is already executing this plan; wait for its terminal receipt instead of cancelling it.",
    };
  }
  if (pointer.outcome === "ready" && pointer.record.cleanPlanId === planId) {
    const local = await cancelDshCleanerSchedule({
      stateDir: runtime.stateDir,
      sessionId: plan.sessionId,
      cleanPlanId: planId,
      reasons: ["cancelled_by_user"],
    });
    if (local.outcome !== "transitioned" && local.outcome !== "unchanged") {
      return {
        kind: "error",
        text: `Context Cleaner could not reserve cancellation safely: ${local.reasons.join(", ") || local.outcome}`,
      };
    }
  } else if (pointer.outcome === "ready" && pointer.record.cleanPlanId !== planId) {
    return { kind: "error", text: "Another Context Cleaner plan is scheduled for this session." };
  } else if (pointer.outcome === "bypassed") {
    return {
      kind: "error",
      text: `Context Cleaner could not verify cancellation safely: ${pointer.reasons.join(", ")}`,
    };
  }

  const receipt = await runtime.control.cancel(planId);
  return { kind: "success", text: formatReceipt(receipt) };
}

/** Execute `/tokenpilot-clean` without creating an LLM turn. */
export async function executeContextCleanerCommand(
  context: ContextCleanerCommandContext,
  config: TokenPilotDshConfig,
  invocation: TokenPilotCommandInvocation,
  dependencies: ContextCleanerCommandDependencies = {},
): Promise<TokenPilotCommandResult> {
  void context;
  if (invocation.signal.aborted) {
    return { kind: "error", text: "Context Cleaner request was cancelled." };
  }
  const runtime = createRuntime(invocation.agent.session, config, dependencies);
  if (!runtime) return { kind: "error", text: notConfiguredText() };

  const input = parseInput(invocation.rawInput);
  try {
    switch (input.kind) {
      case "analyze": return await analyze(runtime, invocation, input.sessionId);
      case "schedule": return await schedule(runtime, input.planId, input.selectedTaskIds);
      case "status": return await readStatus(runtime, input.planId);
      case "cancel": return await cancel(runtime, input.planId);
      case "help": return { kind: "success", text: helpText() };
      case "invalid": return { kind: "error", text: helpText() };
    }
  } catch (error) {
    return {
      kind: "error",
      text: `Context Cleaner could not complete the request: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function commandDefinition(
  name: "tokenpilot-clean" | "context-cleaner",
  context: ContextCleanerCommandContext,
  config: TokenPilotDshConfig,
  dependencies: ContextCleanerCommandDependencies,
): TokenPilotCommandDefinition {
  return {
    name,
    description: "Plan and explicitly schedule cleanup of completed task context.",
    input: { hint: "[--session|--plan --select|--status|--cancel] ..." },
    recordInput: false,
    handler: (invocation) => executeContextCleanerCommand(context, config, invocation, dependencies),
  };
}

/** Create the canonical `/tokenpilot-clean` command definition. */
export function createTokenPilotCleanCommand(
  context: ContextCleanerCommandContext,
  config: TokenPilotDshConfig,
  dependencies: ContextCleanerCommandDependencies = {},
): TokenPilotCommandDefinition {
  return commandDefinition("tokenpilot-clean", context, config, dependencies);
}

/** Legacy alias retained for profiles that already expose `/context-cleaner`. */
export function createContextCleanerCommand(
  context: ContextCleanerCommandContext,
  config: TokenPilotDshConfig,
  dependencies: ContextCleanerCommandDependencies = {},
): TokenPilotCommandDefinition {
  return commandDefinition("context-cleaner", context, config, dependencies);
}

/** Register the canonical command plus the backwards-compatible alias. */
export function registerContextCleanerCommands(
  context: ContextCleanerCommandContext,
  config: TokenPilotDshConfig,
  dependencies: ContextCleanerCommandDependencies = {},
): () => void {
  const disposeCanonical = context.commands.register(createTokenPilotCleanCommand(context, config, dependencies));
  const disposeAlias = context.commands.register(createContextCleanerCommand(context, config, dependencies));
  return () => {
    disposeAlias();
    disposeCanonical();
  };
}
