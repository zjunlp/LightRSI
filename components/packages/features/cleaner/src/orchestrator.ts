import { createHash } from "node:crypto";

import {
  loadSessionTaskRegistry,
  type SessionTaskRegistry,
} from "@lightrsi/history";
import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  isTerminalContextCleanStatus,
  type ContextCleanPendingReceipt,
  type ContextCleanPlan,
  type ContextCleanReceipt,
  type ContextCleanerControlPlane,
  type ContextCleanerHostBridge,
  type ExecuteApprovedContextCleanParams,
} from "./contracts.js";
import { readContextCleanPlan, saveContextCleanPlan } from "./clean-plan-store.js";
import { readContextCleanReceipt } from "./clean-receipt-store.js";
import { transitionContextCleanState } from "./clean-state-coordinator.js";
import { buildContextCleanBreakdown } from "./token-accounting.js";
import {
  analyzeContextCleanRecommendations,
  type ContextCleanRecommendationProvider,
  type ContextCleanTaskEvidence,
} from "./recommendation.js";

export type ContextCleanAnalysisResult = {
  plan: ContextCleanPlan;
  receipt: ContextCleanPendingReceipt;
  fallbackUsed: boolean;
  reasons: string[];
};

export type AnalyzeContextCleanSessionParams = {
  stateDir: string;
  bridge: ContextCleanerHostBridge;
  sessionId: string;
  contextWindowTokens?: number;
  provider?: ContextCleanRecommendationProvider;
  loadRegistry?: (stateDir: string, sessionId: string) => Promise<SessionTaskRegistry>;
};

function canonicalPlanId(plan: Omit<ContextCleanPlan, "planId">): string {
  const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
  return `ctxclean-${digest}`;
}

function taskEvidence(registry: SessionTaskRegistry): Record<string, ContextCleanTaskEvidence> {
  return Object.fromEntries(Object.values(registry.tasks).map((task) => [task.taskId, {
    completionEvidence: task.completionEvidence,
    unresolvedIssues: task.unresolvedQuestions,
  }]));
}

function analyzedReceipt(
  plan: ContextCleanPlan,
  reasons: string[],
  fallbackUsed: boolean,
): ContextCleanPendingReceipt {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: plan.planId,
    hostId: plan.hostId,
    sessionId: plan.sessionId,
    status: "analyzed",
    selectedTaskIds: [],
    estimatedSavedTokens: 0,
    estimatedSavedChars: 0,
    tokenCountMode: plan.tokenCountMode,
    deferredTaskIds: [],
    reasons,
    updatedAt: plan.createdAt,
    fallbackUsed,
  };
}

function throwStoreFailure(operation: string, reasons: string[]): never {
  throw new Error(`${operation}:${reasons.join(",") || "unknown"}`);
}

export async function analyzeContextCleanSession(
  params: AnalyzeContextCleanSessionParams,
): Promise<ContextCleanAnalysisResult> {
  const sessionId = params.sessionId.trim();
  if (!params.stateDir.trim() || !sessionId) throw new Error("clean_analysis_identity_invalid");
  if (params.contextWindowTokens !== undefined
    && (!Number.isSafeInteger(params.contextWindowTokens) || params.contextWindowTokens <= 0)) {
    throw new Error("clean_analysis_context_window_invalid");
  }

  const snapshot = await params.bridge.readCleanSnapshot(sessionId);
  if (snapshot.hostId !== params.bridge.hostId || snapshot.sessionId !== sessionId) {
    throw new Error("clean_analysis_snapshot_identity_mismatch");
  }
  if (!snapshot.revision.trim() || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new Error("clean_analysis_snapshot_invalid");
  }

  const registry = await (params.loadRegistry ?? loadSessionTaskRegistry)(params.stateDir, sessionId);
  if (registry.sessionId !== sessionId) throw new Error("clean_analysis_registry_identity_mismatch");

  const breakdown = buildContextCleanBreakdown({
    snapshot,
    registry,
    model: snapshot.model,
    itemTokenCounts: snapshot.itemTokenCounts,
  });
  const recommended = await analyzeContextCleanRecommendations({
    tasks: breakdown.tasks,
    evidenceByTaskId: taskEvidence(registry),
    provider: params.provider,
  });
  const planWithoutId: Omit<ContextCleanPlan, "planId"> = {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    hostId: params.bridge.hostId,
    sessionId,
    baseRevision: snapshot.revision,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    ...(params.contextWindowTokens !== undefined
      ? { contextWindowTokens: params.contextWindowTokens }
      : {}),
    usedTokens: breakdown.usedTokens,
    usedChars: breakdown.usedChars,
    protectedTokens: breakdown.protectedTokens,
    protectedChars: breakdown.protectedChars,
    unassignedTokens: breakdown.unassignedTokens,
    unassignedChars: breakdown.unassignedChars,
    tokenCountMode: breakdown.tokenCountMode,
    tokenCountMethod: breakdown.tokenCountMethod,
    tasks: recommended.tasks,
    createdAt: snapshot.capturedAt,
  };
  const plan: ContextCleanPlan = {
    ...planWithoutId,
    planId: canonicalPlanId(planWithoutId),
  };
  const saved = await saveContextCleanPlan({ stateDir: params.stateDir, plan });
  if (saved.bypassed) throwStoreFailure("clean_analysis_plan_store_failed", saved.reasons);

  const receipt = analyzedReceipt(plan, recommended.reasons, recommended.fallbackUsed);
  const transitioned = await transitionContextCleanState({ stateDir: params.stateDir, receipt });
  if (transitioned.bypassed) {
    throwStoreFailure("clean_analysis_receipt_store_failed", transitioned.reasons);
  }
  return {
    plan,
    receipt,
    fallbackUsed: recommended.fallbackUsed,
    reasons: recommended.reasons,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sameDigests(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return sameStrings(leftKeys, rightKeys)
    && leftKeys.every((key) => left[key] === right[key]);
}

function validateApproval(
  plan: ContextCleanPlan,
  request: ExecuteApprovedContextCleanParams,
): ContextCleanPlan["tasks"] {
  if (request.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION
    || request.cleanPlanId !== plan.planId
    || request.hostId !== plan.hostId
    || request.sessionId !== plan.sessionId
    || request.baseRevision !== plan.baseRevision
    || Number.isNaN(Date.parse(request.approvedAt))
    || request.selectedTasks.length === 0) {
    throw new Error("clean_approval_invalid");
  }
  const selectedIds = request.selectedTasks.map((task) => task.taskId);
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error("clean_approval_duplicate_task");
  const byTaskId = new Map(plan.tasks.map((task) => [task.taskId, task]));
  return request.selectedTasks.map((selected) => {
    const stored = byTaskId.get(selected.taskId);
    if (!stored) throw new Error("clean_approval_unknown_task");
    if (!stored.selectable) throw new Error("clean_approval_task_not_selectable");
    if (!sameStrings(selected.itemIds, stored.itemIds)
      || !sameDigests(selected.itemDigests, stored.itemDigests)) {
      throw new Error("clean_approval_targets_mismatch");
    }
    return stored;
  });
}

function savings(tasks: ContextCleanPlan["tasks"]): { tokens: number | null; chars: number } {
  return {
    tokens: tasks.every((task) => task.tokenCount !== null)
      ? tasks.reduce((total, task) => total + (task.tokenCount ?? 0), 0)
      : null,
    chars: tasks.reduce((total, task) => total + task.charCount, 0),
  };
}

function pendingReceipt(params: {
  plan: ContextCleanPlan;
  status: "approved" | "scheduled";
  selectedTaskIds: string[];
  updatedAt: string;
  fallbackUsed: boolean;
}): ContextCleanPendingReceipt {
  const estimated = savings(params.plan.tasks.filter((task) => params.selectedTaskIds.includes(task.taskId)));
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: params.plan.planId,
    hostId: params.plan.hostId,
    sessionId: params.plan.sessionId,
    status: params.status,
    selectedTaskIds: params.selectedTaskIds,
    estimatedSavedTokens: estimated.tokens,
    estimatedSavedChars: estimated.chars,
    tokenCountMode: params.plan.tokenCountMode,
    deferredTaskIds: [],
    reasons: [],
    updatedAt: params.updatedAt,
    fallbackUsed: params.fallbackUsed,
  };
}

export function createContextCleanerControlPlane(params: {
  stateDir: string;
  now?: () => string;
}): ContextCleanerControlPlane {
  const now = params.now ?? (() => new Date().toISOString());
  return {
    async executeApprovedClean(request) {
      const stored = await readContextCleanPlan({ stateDir: params.stateDir, planId: request.cleanPlanId });
      if (stored.bypassed) throwStoreFailure("clean_approval_plan_unavailable", stored.reasons);
      if (!stored.value) throw new Error("clean_approval_plan_missing");
      const currentReceipt = await readContextCleanReceipt({
        stateDir: params.stateDir,
        planId: request.cleanPlanId,
      });
      if (currentReceipt.bypassed) {
        throwStoreFailure("clean_approval_receipt_unavailable", currentReceipt.reasons);
      }
      if (isTerminalContextCleanStatus(stored.value.status)) {
        if (!currentReceipt.value) throw new Error("clean_approval_terminal_receipt_missing");
        return currentReceipt.value;
      }
      const selected = validateApproval(stored.value.plan, request);
      const selectedTaskIds = selected.map((task) => task.taskId);
      if (stored.value.status === "scheduled") {
        if (!currentReceipt.value
          || currentReceipt.value.status !== "scheduled"
          || !sameStrings(currentReceipt.value.selectedTaskIds, selectedTaskIds)) {
          throw new Error("clean_approval_scheduled_conflict");
        }
        return currentReceipt.value;
      }
      if (stored.value.status === "analyzed") {
        const approved = pendingReceipt({
          plan: stored.value.plan,
          status: "approved",
          selectedTaskIds,
          updatedAt: request.approvedAt,
          fallbackUsed: currentReceipt.value?.fallbackUsed ?? false,
        });
        const result = await transitionContextCleanState({ stateDir: params.stateDir, receipt: approved });
        if (result.bypassed) throwStoreFailure("clean_approval_store_failed", result.reasons);
      } else if (stored.value.status === "approved"
        && (!currentReceipt.value
          || currentReceipt.value.status !== "approved"
          || !sameStrings(currentReceipt.value.selectedTaskIds, selectedTaskIds))) {
        throw new Error("clean_approval_selection_conflict");
      }
      const scheduled = pendingReceipt({
        plan: stored.value.plan,
        status: "scheduled",
        selectedTaskIds,
        updatedAt: now(),
        fallbackUsed: currentReceipt.value?.fallbackUsed ?? false,
      });
      const result = await transitionContextCleanState({ stateDir: params.stateDir, receipt: scheduled });
      if (result.bypassed) throwStoreFailure("clean_schedule_store_failed", result.reasons);
      return scheduled;
    },
    async readCleanReceipt(planId) {
      const result = await readContextCleanReceipt({ stateDir: params.stateDir, planId });
      if (result.bypassed) throwStoreFailure("clean_receipt_unavailable", result.reasons);
      return result.value;
    },
    async cancelCleanPlan(planId) {
      const planRead = await readContextCleanPlan({ stateDir: params.stateDir, planId });
      if (planRead.bypassed) throwStoreFailure("clean_cancel_plan_unavailable", planRead.reasons);
      if (!planRead.value) throw new Error("clean_cancel_plan_missing");
      const receiptRead = await readContextCleanReceipt({ stateDir: params.stateDir, planId });
      if (receiptRead.bypassed) throwStoreFailure("clean_cancel_receipt_unavailable", receiptRead.reasons);
      if (isTerminalContextCleanStatus(planRead.value.status)) {
        if (!receiptRead.value) throw new Error("clean_cancel_terminal_receipt_missing");
        return receiptRead.value;
      }
      const current = receiptRead.value;
      const cancelled: ContextCleanReceipt = {
        schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
        planId,
        hostId: planRead.value.plan.hostId,
        sessionId: planRead.value.plan.sessionId,
        status: "cancelled",
        selectedTaskIds: current?.selectedTaskIds ?? [],
        estimatedSavedTokens: current ? current.estimatedSavedTokens : 0,
        estimatedSavedChars: current?.estimatedSavedChars ?? 0,
        tokenCountMode: planRead.value.plan.tokenCountMode,
        deferredTaskIds: current?.deferredTaskIds ?? [],
        reasons: ["cancelled_by_user"],
        updatedAt: now(),
        fallbackUsed: current?.fallbackUsed ?? false,
      };
      const result = await transitionContextCleanState({ stateDir: params.stateDir, receipt: cancelled });
      if (result.bypassed) throwStoreFailure("clean_cancel_store_failed", result.reasons);
      return cancelled;
    },
  };
}
