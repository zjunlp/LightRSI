import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  analyzeContextCleanSession,
  createApiContextCleanRecommendationProvider,
  createContextCleanerControlPlane,
  readContextCleanPlan,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerControlPlane,
  type ContextCleanerHostBridge,
} from "@lightrsi/cleaner";

import type { CleanCommandBackend } from "../clean.js";
import type { CleanPlanView, CleanReceiptView } from "../clean-renderer.js";

type RecommendationConfig = Parameters<typeof createApiContextCleanRecommendationProvider>[0];

function planView(plan: ContextCleanPlan): CleanPlanView {
  return {
    planId: plan.planId,
    hostId: plan.hostId,
    sessionId: plan.sessionId,
    ...(plan.contextWindowTokens !== undefined
      ? { contextWindowTokens: plan.contextWindowTokens }
      : {}),
    usedTokens: plan.usedTokens,
    usedChars: plan.usedChars,
    protectedTokens: plan.protectedTokens,
    protectedChars: plan.protectedChars,
    unassignedTokens: plan.unassignedTokens,
    unassignedChars: plan.unassignedChars,
    tokenCountMode: plan.tokenCountMode,
    tasks: plan.tasks.map((task) => ({
      taskId: task.taskId,
      label: task.label,
      description: task.description,
      lifecycleState: task.lifecycleState,
      tokenCount: task.tokenCount,
      charCount: task.charCount,
      tokenPercent: task.tokenPercent,
      recommendation: task.recommendation,
      reasonCodes: [...task.reasonCodes],
      selectable: task.selectable,
    })),
  };
}

function receiptView(receipt: ContextCleanReceipt): CleanReceiptView {
  return {
    planId: receipt.planId,
    status: receipt.status,
    selectedTaskIds: [...receipt.selectedTaskIds],
    estimatedSavedTokens: receipt.estimatedSavedTokens,
    estimatedSavedChars: receipt.estimatedSavedChars,
    ...(receipt.status === "applied"
      ? {
          appliedSavedTokens: receipt.appliedSavedTokens,
          appliedSavedChars: receipt.appliedSavedChars,
        }
      : {}),
    deferredTaskIds: [...receipt.deferredTaskIds],
    reasons: [...receipt.reasons],
  };
}

function storeFailure(operation: string, reasons: string[]): never {
  throw new Error(`${operation}:${reasons.join(",") || "unknown"}`);
}

export function createHostCleanCommandBackend(params: {
  stateDir: string;
  createBridge(controlPlane: ContextCleanerControlPlane): ContextCleanerHostBridge;
  recommendationEnabled?: boolean;
  recommendationConfig: RecommendationConfig;
  contextWindowTokens?: number;
  now?: () => string;
}): CleanCommandBackend {
  const stateDir = params.stateDir.trim();
  if (!stateDir) throw new Error("clean_host_state_dir_missing");
  const controlPlane = createContextCleanerControlPlane({ stateDir, now: params.now });
  const bridge = params.createBridge(controlPlane);
  const provider = params.recommendationEnabled === false
    ? undefined
    : createApiContextCleanRecommendationProvider(params.recommendationConfig);

  async function storedPlan(planId: string): Promise<ContextCleanPlan | undefined> {
    const result = await readContextCleanPlan({ stateDir, planId });
    if (result.bypassed) storeFailure("clean_cli_plan_unavailable", result.reasons);
    return result.value?.plan;
  }

  return {
    async analyze(sessionId) {
      return planView((await analyzeContextCleanSession({
        stateDir,
        bridge,
        sessionId,
        provider,
        contextWindowTokens: params.contextWindowTokens,
      })).plan);
    },
    async readPlan(planId) {
      const plan = await storedPlan(planId);
      return plan ? planView(plan) : undefined;
    },
    async approve(planId, selectedTaskIds) {
      const plan = await storedPlan(planId);
      if (!plan) throw new Error(`clean_cli_plan_missing:${planId}`);
      if (new Set(selectedTaskIds).size !== selectedTaskIds.length) {
        throw new Error("clean_cli_selection_duplicate_task");
      }
      const tasksById = new Map(plan.tasks.map((task) => [task.taskId, task]));
      const selectedTasks = selectedTaskIds.map((taskId) => {
        const task = tasksById.get(taskId);
        if (!task) throw new Error(`clean_cli_selection_unknown_task:${taskId}`);
        if (!task.selectable) throw new Error(`clean_cli_selection_task_protected:${taskId}`);
        return {
          taskId,
          itemIds: [...task.itemIds],
          itemDigests: { ...task.itemDigests },
        };
      });
      return receiptView(await bridge.executeApprovedClean({
        schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
        cleanPlanId: plan.planId,
        hostId: plan.hostId,
        sessionId: plan.sessionId,
        baseRevision: plan.baseRevision,
        approvedAt: params.now?.() ?? new Date().toISOString(),
        selectedTasks,
      }));
    },
    async readReceipt(planId) {
      const receipt = await bridge.readCleanReceipt(planId);
      return receipt ? receiptView(receipt) : undefined;
    },
    async cancel(planId) {
      return receiptView(await bridge.cancelCleanPlan(planId));
    },
  };
}
