import { createHash } from "node:crypto";

import {
  createContextCleanerHostExecutionBridge,
  type ContextCleanPreparedExecution,
  type ContextCleanReceipt,
  type ContextCleanTerminalReceipt,
} from "@lightrsi/cleaner";
import {
  relocateContextMutationPlan,
  revalidateContextMutationPlan,
  validateContextMutationProtocolClosure,
  type ContextRewriteResult,
  type ModelContextSnapshot,
} from "@lightrsi/host-adapter";

import { applyArchivePlan } from "../context-rewrite/archive.js";
import {
  claudeContextRewriteBackend,
  type ClaudeOverlayRequest,
} from "../context-rewrite/backend.js";
import { buildClaudeCleanerAppliedReceipt } from "./applied-receipt.js";
import {
  acquireClaudeCleanerScheduleLock,
  appendClaudeCleanerCommitted,
  appendClaudeCleanerTerminal,
  readClaudeCleanerSchedule,
  type ClaudeCleanerScheduledRecord,
} from "./scheduler.js";

const STALE_REASONS = new Set([
  "clean_execution_revision_stale",
  "clean_execution_item_stale",
  "clean_execution_protected_item_targeted",
  "clean_execution_task_attribution_stale",
  "clean_execution_task_not_evictable",
  "clean_execution_revalidation_failed",
  "clean_execution_protocol_closure_failed",
  "claude_cleaner_relocation_incomplete",
  "claude_cleaner_current_scope_invalid",
  "claude_cleaner_overlay_incomplete",
]);

type ClaudeCleanerPreparedOverlay = {
  outcome: "prepared";
  suppressAutomaticEviction: true;
  execution: ContextCleanPreparedExecution;
  request: ClaudeOverlayRequest;
  rewriteResult: ContextRewriteResult;
  overlayId: string;
  release(): Promise<void>;
};

export type ClaudeCleanerOverlayResult =
  | { outcome: "absent"; suppressAutomaticEviction: false; reasonCodes: [] }
  | ClaudeCleanerPreparedOverlay
  | { outcome: "terminal"; suppressAutomaticEviction: true; reasonCodes: string[] }
  | { outcome: "reserved"; suppressAutomaticEviction: true; reasonCodes: string[] };

export type ClaudeCleanerOverlayFinalization =
  | { outcome: "applied"; reasonCodes: string[] }
  | { outcome: "reserved"; reasonCodes: string[] };

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter((reason) => reason.trim().length > 0))];
}

function overlayId(execution: ContextCleanPreparedExecution, revision: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      cleanPlanId: execution.cleanPlanId,
      mutationPlanId: execution.mutationPlan.planId,
      revision,
      operationIds: execution.mutationPlan.operations.map((operation) => operation.id),
    }))
    .digest("hex")
    .slice(0, 24);
}

function staleReasonCodes(reasons: readonly string[]): string[] | undefined {
  const normalized = uniqueReasons(reasons);
  return normalized.some((reason) => STALE_REASONS.has(reason)) ? normalized : undefined;
}

function terminalReceipt(params: {
  scheduledReceipt: ContextCleanPreparedExecution["scheduledReceipt"];
  status: ContextCleanTerminalReceipt["status"];
  reasons: string[];
  updatedAt: string;
}): ContextCleanTerminalReceipt {
  return {
    ...params.scheduledReceipt,
    status: params.status,
    deferredTaskIds: [...params.scheduledReceipt.selectedTaskIds],
    fallbackUsed: params.status === "failed",
    reasons: uniqueReasons(params.reasons),
    updatedAt: params.updatedAt,
  };
}

async function persistTerminal(params: {
  stateDir: string;
  sessionId: string;
  execution: ContextCleanPreparedExecution;
  status: "stale" | "failed";
  reasonCodes: string[];
  updatedAt: string;
}): Promise<ClaudeCleanerOverlayResult> {
  const receipt = terminalReceipt({
    scheduledReceipt: params.execution.scheduledReceipt,
    status: params.status,
    reasons: params.reasonCodes,
    updatedAt: params.updatedAt,
  });
  const bridge = createContextCleanerHostExecutionBridge({
    stateDir: params.stateDir,
    hostId: "claude-code",
    async readExecutionSnapshot() {
      throw new Error("terminal receipt does not read an execution snapshot");
    },
  });
  const stored = await bridge.recordCleanReceipt(receipt);
  if (stored.bypassed || stored.value?.status !== params.status) {
    return {
      outcome: "reserved",
      suppressAutomaticEviction: true,
      reasonCodes: uniqueReasons(["claude_cleaner_terminal_receipt_write_failed", ...stored.reasons]),
    };
  }
  const local = await appendClaudeCleanerTerminal({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    cleanPlanId: params.execution.cleanPlanId,
    receiptStatus: params.status,
    reasons: receipt.reasons,
    updatedAt: params.updatedAt,
  });
  if (local.outcome !== "transitioned" && local.outcome !== "unchanged") {
    return {
      outcome: "reserved",
      suppressAutomaticEviction: true,
      reasonCodes: uniqueReasons(["claude_cleaner_terminal_schedule_write_failed", ...local.reasons]),
    };
  }
  return { outcome: "terminal", suppressAutomaticEviction: true, reasonCodes: receipt.reasons };
}

function currentScopeIsSafe(params: {
  execution: ContextCleanPreparedExecution;
  snapshot: ModelContextSnapshot;
  activeTaskIds: readonly string[];
  evictableTaskIds: readonly string[];
}): boolean {
  const active = new Set(params.activeTaskIds);
  const evictable = new Set(params.evictableTaskIds);
  const items = new Map(params.snapshot.items.map((item) => [item.stableId, item]));
  return params.execution.mutationPlan.operations.every((operation) => {
    const taskIds = operation.taskIds ?? [];
    return taskIds.length > 0
      && taskIds.every((taskId) => !active.has(taskId) && evictable.has(taskId))
      && operation.targetItemIds.every((itemId) => {
        const item = items.get(itemId);
        return item !== undefined
          && item.kind !== "system"
          && item.kind !== "developer"
          && item.role !== "system"
          && item.role !== "developer"
          && taskIds.some((taskId) => item.taskIds?.includes(taskId));
      });
  });
}

function archivePreservedFullScope(execution: ContextCleanPreparedExecution): boolean {
  return execution.mutationPlan.operations.every((operation) => (
    operation.targetItemIds.length > 0
    && Object.keys(operation.targetItemFingerprints ?? {}).length === operation.targetItemIds.length
  ));
}

async function prepareLockedOverlay(params: {
  stateDir: string;
  sessionId: string;
  baseSnapshot: ModelContextSnapshot;
  currentSnapshot: ModelContextSnapshot;
  request: ClaudeOverlayRequest;
  activeTaskIds: readonly string[];
  evictableTaskIds: readonly string[];
  schedule: ClaudeCleanerScheduledRecord;
  now: string;
  release(): Promise<void>;
}): Promise<ClaudeCleanerOverlayResult> {
  const bridge = createContextCleanerHostExecutionBridge({
    stateDir: params.stateDir,
    hostId: "claude-code",
    async readExecutionSnapshot() {
      return {
        snapshot: params.baseSnapshot,
        activeTaskIds: params.activeTaskIds,
        evictableTaskIds: params.evictableTaskIds,
      };
    },
  });
  const shared = await bridge.prepareScheduledClean({
    cleanPlanId: params.schedule.cleanPlanId,
    sessionId: params.sessionId,
    baseRevision: params.schedule.baseRevision,
    selectedTaskIds: [...params.schedule.selectedTaskIds],
  });
  if (shared.outcome === "terminal") {
    await params.release();
    if (shared.receipt.status === "stale" || shared.receipt.status === "cancelled" || shared.receipt.status === "failed") {
      await appendClaudeCleanerTerminal({
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        cleanPlanId: params.schedule.cleanPlanId,
        receiptStatus: shared.receipt.status,
        reasons: shared.receipt.reasons.length > 0 ? shared.receipt.reasons : ["claude_cleaner_terminal_replayed"],
        updatedAt: shared.receipt.updatedAt,
      });
    }
    return { outcome: "terminal", suppressAutomaticEviction: true, reasonCodes: shared.receipt.reasons };
  }
  if (shared.outcome !== "ready") {
    const stale = shared.outcome === "bypassed" ? staleReasonCodes(shared.reasons) : undefined;
    if (shared.outcome === "bypassed" && stale && shared.receipt?.status === "scheduled") {
      const execution = {
        cleanPlanId: shared.receipt.planId,
        hostId: shared.receipt.hostId,
        sessionId: shared.receipt.sessionId,
        baseRevision: params.schedule.baseRevision,
        selectedTasks: [],
        mutationPlan: { ...params.baseSnapshot, operations: [] } as never,
        scheduledReceipt: shared.receipt,
      } as ContextCleanPreparedExecution;
      await params.release();
      return persistTerminal({
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        execution,
        status: "stale",
        reasonCodes: stale,
        updatedAt: params.now,
      });
    }
    await params.release();
    return {
      outcome: "reserved",
      suppressAutomaticEviction: true,
      reasonCodes: shared.reasons,
    };
  }

  const relocation = relocateContextMutationPlan({
    snapshot: params.currentSnapshot,
    plan: shared.execution.mutationPlan,
  });
  const execution: ContextCleanPreparedExecution = {
    ...shared.execution,
    mutationPlan: relocation.plan,
  };
  if (relocation.deferredOperationIds.length > 0
    || relocation.plan.operations.length !== shared.execution.mutationPlan.operations.length
    || !currentScopeIsSafe({
      execution,
      snapshot: params.currentSnapshot,
      activeTaskIds: params.activeTaskIds,
      evictableTaskIds: params.evictableTaskIds,
    })) {
    await params.release();
    return persistTerminal({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      execution: shared.execution,
      status: "stale",
      reasonCodes: relocation.deferredOperationIds.length > 0
        ? ["claude_cleaner_relocation_incomplete", ...relocation.reasons]
        : ["claude_cleaner_current_scope_invalid"],
      updatedAt: params.now,
    });
  }
  const revalidation = revalidateContextMutationPlan({
    snapshot: params.currentSnapshot,
    plan: execution.mutationPlan,
  });
  const closure = validateContextMutationProtocolClosure({
    snapshot: params.currentSnapshot,
    plan: execution.mutationPlan,
    activeTaskIds: params.activeTaskIds,
    evictableTaskIds: params.evictableTaskIds,
    candidateOperationIds: revalidation.applicableOperationIds,
  });
  if (!revalidation.valid
    || revalidation.deferredOperationIds.length > 0
    || revalidation.applicableOperationIds.length !== execution.mutationPlan.operations.length
    || !closure.valid
    || closure.deferredOperationIds.length > 0
    || closure.applicableOperationIds.length !== execution.mutationPlan.operations.length) {
    await params.release();
    return persistTerminal({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      execution: shared.execution,
      status: "stale",
      reasonCodes: ["clean_execution_revalidation_failed", ...revalidation.reasons, ...closure.reasons],
      updatedAt: params.now,
    });
  }

  const archivePlan = structuredClone(execution.mutationPlan);
  const archivedExecution: ContextCleanPreparedExecution = { ...execution, mutationPlan: archivePlan };
  try {
    await applyArchivePlan({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      snapshot: params.currentSnapshot,
      plan: archivePlan,
      request: params.request,
    });
    if (!archivePreservedFullScope(archivedExecution)) {
      await params.release();
      return persistTerminal({
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        execution: shared.execution,
        status: "failed",
        reasonCodes: ["claude_cleaner_archive_incomplete"],
        updatedAt: params.now,
      });
    }
    const applied = await claudeContextRewriteBackend.apply({
      snapshot: params.currentSnapshot,
      plan: archivePlan,
      request: params.request,
    });
    const expectedOperationIds = archivePlan.operations.map((operation) => operation.id);
    const expectedItemIds = archivePlan.operations.flatMap((operation) => operation.targetItemIds);
    if (!applied.result.applied
      || !applied.result.changed
      || applied.result.fallbackUsed
      || applied.result.deferredOperationIds.length > 0
      || applied.result.appliedOperationIds.length !== expectedOperationIds.length
      || applied.result.removedItemIds.length !== expectedItemIds.length) {
      await params.release();
      return persistTerminal({
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        execution: shared.execution,
        status: "stale",
        reasonCodes: ["claude_cleaner_overlay_incomplete"],
        updatedAt: params.now,
      });
    }
    return {
      outcome: "prepared",
      suppressAutomaticEviction: true,
      execution: archivedExecution,
      request: applied.request,
      rewriteResult: applied.result,
      overlayId: overlayId(archivedExecution, params.currentSnapshot.revision),
      release: params.release,
    };
  } catch {
    await params.release();
    return persistTerminal({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      execution: shared.execution,
      status: "failed",
      reasonCodes: ["claude_cleaner_overlay_apply_failed"],
      updatedAt: params.now,
    });
  }
}

export async function prepareClaudeCleanerOverlay(params: {
  stateDir: string;
  sessionId: string;
  baseSnapshot: ModelContextSnapshot;
  currentSnapshot: ModelContextSnapshot;
  request: ClaudeOverlayRequest;
  activeTaskIds: readonly string[];
  evictableTaskIds: readonly string[];
  now?: string;
}): Promise<ClaudeCleanerOverlayResult> {
  const initial = await readClaudeCleanerSchedule({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
  });
  if (initial.outcome === "missing") {
    return { outcome: "absent", suppressAutomaticEviction: false, reasonCodes: [] };
  }
  if (initial.outcome !== "ready") {
    return {
      outcome: initial.outcome === "terminal" || initial.outcome === "committed" ? "terminal" : "reserved",
      suppressAutomaticEviction: true,
      reasonCodes: initial.outcome === "terminal" ? initial.record.reasons : initial.reasons,
    };
  }
  const lock = await acquireClaudeCleanerScheduleLock(params);
  if (!lock) {
    return { outcome: "reserved", suppressAutomaticEviction: true, reasonCodes: ["claude_cleaner_runtime_lock_busy"] };
  }
  const current = await readClaudeCleanerSchedule({ stateDir: params.stateDir, sessionId: params.sessionId });
  if (current.outcome !== "ready" || current.record.cleanPlanId !== initial.record.cleanPlanId) {
    await lock.release();
    return {
      outcome: current.outcome === "terminal" || current.outcome === "committed" ? "terminal" : "reserved",
      suppressAutomaticEviction: true,
      reasonCodes: current.outcome === "ready" ? ["claude_cleaner_runtime_schedule_changed"] : current.reasons,
    };
  }
  return prepareLockedOverlay({
    ...params,
    schedule: current.record,
    now: params.now ?? new Date().toISOString(),
    release: () => lock.release(),
  });
}

/** Completes a prepared overlay after gateway encoding still preserves its exact scope. */
export async function finalizeClaudeCleanerOverlay(params: {
  stateDir: string;
  prepared: Extract<ClaudeCleanerOverlayResult, { outcome: "prepared" }>;
  now?: string;
}): Promise<ClaudeCleanerOverlayFinalization> {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await params.prepared.release();
  };
  try {
    const built = buildClaudeCleanerAppliedReceipt({
      execution: params.prepared.execution,
      rewriteResult: params.prepared.rewriteResult,
      overlayId: params.prepared.overlayId,
      updatedAt: params.now ?? new Date().toISOString(),
    });
    if (!built.receipt) return { outcome: "reserved", reasonCodes: built.reasons };
    const bridge = createContextCleanerHostExecutionBridge({
      stateDir: params.stateDir,
      hostId: "claude-code",
      async readExecutionSnapshot() {
        throw new Error("applied receipt does not read an execution snapshot");
      },
    });
    const stored = await bridge.recordCleanReceipt(built.receipt);
    if (stored.bypassed || stored.value?.status !== "applied") {
      return {
        outcome: "reserved",
        reasonCodes: uniqueReasons(["claude_cleaner_applied_receipt_write_failed", ...stored.reasons]),
      };
    }
    // The shared state transition is now terminal and serializes retries. Drop
    // the reservation before appending the local marker, whose own transition
    // acquires the same non-reentrant session lock.
    await release();
    const local = await appendClaudeCleanerCommitted({
      stateDir: params.stateDir,
      sessionId: params.prepared.execution.sessionId,
      cleanPlanId: params.prepared.execution.cleanPlanId,
      mutationPlanId: params.prepared.execution.mutationPlan.planId,
      overlayId: params.prepared.overlayId,
      updatedAt: built.receipt.updatedAt,
    });
    if (local.outcome !== "transitioned" && local.outcome !== "unchanged") {
      return {
        outcome: "applied",
        reasonCodes: uniqueReasons(["claude_cleaner_applied_schedule_write_failed", ...local.reasons]),
      };
    }
    return { outcome: "applied", reasonCodes: [] };
  } finally {
    await release();
  }
}

/** Releases a reserved candidate when a later gateway stage must retain the original request. */
export async function abandonClaudeCleanerOverlay(
  prepared: Extract<ClaudeCleanerOverlayResult, { outcome: "prepared" }>,
): Promise<void> {
  await prepared.release();
}
