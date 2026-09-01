import {
  readContextCleanPlan,
  readContextCleanReceipt,
  type ContextCleanReceipt,
} from "@lightrsi/cleaner";
import type { ModelContextRewriteMode } from "@lightrsi/host-adapter";

import { readCodexCleanerSchedule } from "./scheduler.js";

type CleanerSavings = {
  tokens: number | null;
  chars: number;
};

export type CodexCleanerObservability = {
  availability: "available" | "degraded";
  planStore: "available" | "missing" | "unknown";
  pendingPlan: "none" | "scheduled" | "unknown";
  lastReceipt: ContextCleanReceipt["status"] | "none" | "unknown";
  rewriteMode: ModelContextRewriteMode;
  savings: {
    estimated?: CleanerSavings;
    scheduled?: CleanerSavings;
    applied?: CleanerSavings;
  };
  fallbackCount: number | null;
};

function unavailable(): CodexCleanerObservability {
  return {
    availability: "degraded",
    planStore: "unknown",
    pendingPlan: "unknown",
    lastReceipt: "unknown",
    rewriteMode: "response_chain_rebase",
    savings: {},
    fallbackCount: null,
  };
}

export function emptyCodexCleanerObservability(): CodexCleanerObservability {
  return {
    availability: "available",
    planStore: "unknown",
    pendingPlan: "none",
    lastReceipt: "none",
    rewriteMode: "response_chain_rebase",
    savings: {},
    fallbackCount: 0,
  };
}

function estimatedSavings(receipt: ContextCleanReceipt): CleanerSavings {
  return {
    tokens: receipt.estimatedSavedTokens,
    chars: receipt.estimatedSavedChars,
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((value) => right.includes(value));
}

function belongsToCurrentSchedule(params: {
  hostId: "codex";
  sessionId: string;
  cleanPlanId: string;
  planBaseRevision: string;
  scheduleBaseRevision: string;
  scheduleSelectedTaskIds: readonly string[];
  scheduleStatus: "scheduled" | "committed" | "terminal";
  terminalReceiptStatus?: "stale" | "cancelled" | "failed";
  receipt: ContextCleanReceipt;
}): boolean {
  return params.receipt.planId === params.cleanPlanId
    && params.receipt.hostId === params.hostId
    && params.receipt.sessionId === params.sessionId
    && params.planBaseRevision === params.scheduleBaseRevision
    && sameStringSet(params.receipt.selectedTaskIds, params.scheduleSelectedTaskIds)
    && (params.scheduleStatus !== "committed" || params.receipt.status === "applied")
    && (params.scheduleStatus !== "terminal"
      || params.terminalReceiptStatus === params.receipt.status);
}

/**
 * Reads only metadata for the current scheduled Cleaner plan. The adapter
 * journal supplies an opaque plan id; the shared store remains read-by-id and
 * is never scanned here.
 */
export async function readCodexCleanerObservability(params: {
  stateDir: string;
  sessionId: string;
}): Promise<CodexCleanerObservability> {
  const schedule = await readCodexCleanerSchedule(params);
  if (schedule.outcome === "bypassed") return unavailable();
  if (schedule.outcome === "missing") {
    return emptyCodexCleanerObservability();
  }

  const cleanPlanId = schedule.record.cleanPlanId;
  const plan = await readContextCleanPlan({ stateDir: params.stateDir, planId: cleanPlanId });
  if (plan.bypassed) return unavailable();
  if (!plan.value) {
    return {
      availability: "degraded",
      planStore: "missing",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    };
  }
  if (plan.value.plan.hostId !== "codex" || plan.value.plan.sessionId !== params.sessionId) {
    return unavailable();
  }

  const receipt = await readContextCleanReceipt({ stateDir: params.stateDir, planId: cleanPlanId });
  if (receipt.bypassed) return unavailable();
  if (!receipt.value) {
    return {
      availability: "degraded",
      planStore: "available",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    };
  }
  if (!belongsToCurrentSchedule({
    hostId: "codex",
    sessionId: params.sessionId,
    cleanPlanId,
    planBaseRevision: plan.value.plan.baseRevision,
    scheduleBaseRevision: schedule.record.baseRevision,
    scheduleSelectedTaskIds: schedule.record.selectedTaskIds,
    scheduleStatus: schedule.record.status,
    terminalReceiptStatus: schedule.record.status === "terminal"
      ? schedule.record.receiptStatus
      : undefined,
    receipt: receipt.value,
  }) || plan.value.status !== receipt.value.status) {
    return unavailable();
  }

  const savings: CodexCleanerObservability["savings"] = {
    estimated: estimatedSavings(receipt.value),
  };
  if (receipt.value.status === "scheduled") {
    savings.scheduled = estimatedSavings(receipt.value);
  } else if (receipt.value.status === "applied") {
    savings.applied = {
      tokens: receipt.value.appliedSavedTokens,
      chars: receipt.value.appliedSavedChars,
    };
  }
  return {
    availability: "available",
    planStore: "available",
    pendingPlan: receipt.value.status === "scheduled" ? "scheduled" : "none",
    lastReceipt: receipt.value.status,
    rewriteMode: "response_chain_rebase",
    savings,
    fallbackCount: receipt.value.fallbackUsed ? 1 : 0,
  };
}
