/**
 * DSH Context Cleaner execution bridge.
 *
 * A command can only create a durable scheduled plan. This module runs inside
 * DSH's real `agent/pre-step` lifecycle, revalidates the frozen plan against
 * the live surface, and performs the one permitted canonical rewrite through
 * `applyEvictionTransaction`. It never invents a second surface mutation path.
 */

import {
  createContextCleanerHostExecutionBridge,
  type ContextCleanAppliedReceipt,
  type ContextCleanExecutionRequest,
  type ContextCleanExecutionSnapshot,
  type ContextCleanReceipt,
  type ContextCleanScheduledReceipt,
  type ContextCleanTerminalReceipt,
  type ContextCleanerHostExecutionBridge,
} from "@lightrsi/cleaner";
import type { SessionTaskRegistry } from "@lightrsi/history";

import {
  applyEvictionTransaction,
  type AppendableSession,
  type EvictionPlan,
  type EvictionTarget,
} from "../surface-transaction.js";
import { describeEffectiveItems, type CycleSession } from "../eviction-cycle.js";
import { buildDshCleanSnapshot, DSH_HOST_ID, surfaceRevision } from "./snapshot.js";
import type { DshCleanerSessionStore } from "./session-catalog.js";

/** Extract the durable seq from a `event-<seq>-<kind>` stable id. */
function parseSeq(stableId: string): number | undefined {
  const match = /^event-(\d+)-/.exec(stableId);
  return match ? Number(match[1]) : undefined;
}

type EffectiveDshItem = ReturnType<typeof describeEffectiveItems>[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanStub(kind: string, seq: number): { type: "text"; text: string } {
  return { type: "text", text: `[cleaned: ${kind} @${seq}]` };
}

/**
 * Build a canonical DSH replacement. Tool results have a required native
 * envelope (`turn`, `step`, `error`, and the message wrapper), so preserve the
 * original event data rather than fabricating a bare message payload.
 */
function buildCleanTarget(item: EffectiveDshItem, planId: string): EvictionTarget {
  const data = isObject(item.event.data) ? structuredClone(item.event.data) : {};
  if (item.event.type === "user/message" || item.event.type === "assistant/message") {
    return {
      sourceEventSeq: item.seq,
      eventType: "user/message",
      data: {
        id: `lightrsi-clean-${planId}-${item.seq}`,
        role: "user",
        content: [cleanStub(item.kind, item.seq)],
        source: {
          kind: "plugin",
          plugin: "tokenpilot-dsh",
          form: "notice",
          summary: `Cleaned historical context at event ${item.seq}`,
        },
      },
    };
  }

  const message = isObject(data.message) ? data.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const resultBlock = isObject(content[0]) ? content[0] : {};
  return {
    sourceEventSeq: item.seq,
    eventType: "tool/result",
    data: {
      ...data,
      message: {
        ...message,
        content: [{ ...resultBlock, content: [cleanStub(item.kind, item.seq)] }],
      },
    },
  };
}

/** Build the shared execution bridge, reading DSH's live canonical surface. */
export function createDshCleanerExecutionBridge(params: {
  stateDir: string;
  sessions: DshCleanerSessionStore;
  loadRegistry: (sessionId: string) => Promise<SessionTaskRegistry> | SessionTaskRegistry;
}): ContextCleanerHostExecutionBridge {
  return createContextCleanerHostExecutionBridge({
    stateDir: params.stateDir,
    hostId: DSH_HOST_ID,
    async readExecutionSnapshot(sessionId): Promise<ContextCleanExecutionSnapshot> {
      const session = params.sessions.get(sessionId);
      if (!session) throw new Error("dsh_clean_execution_snapshot_unavailable");
      const registry = await params.loadRegistry(sessionId);
      const { snapshot } = buildDshCleanSnapshot({ session, registry, revision: surfaceRevision(session) });
      return {
        snapshot,
        activeTaskIds: registry.activeTaskIds,
        evictableTaskIds: registry.evictableTaskIds,
      };
    },
  });
}

export type DshCleanApplyOutcome =
  | { outcome: "applied"; receipt: ContextCleanAppliedReceipt; claimed: true }
  | { outcome: "terminal"; receipt: ContextCleanReceipt; claimed: false }
  | { outcome: "stale"; receipt?: ContextCleanTerminalReceipt; reasons: string[]; claimed: boolean }
  | { outcome: "failed"; receipt?: ContextCleanTerminalReceipt; reasons: string[]; claimed: boolean; surfaceChanged: boolean }
  | { outcome: "skipped"; reasons: string[]; claimed: false };

function terminalReceipt(params: {
  receipt: ContextCleanScheduledReceipt;
  status: "stale" | "failed";
  reasons: string[];
}): ContextCleanTerminalReceipt {
  return {
    schemaVersion: params.receipt.schemaVersion,
    planId: params.receipt.planId,
    hostId: params.receipt.hostId,
    sessionId: params.receipt.sessionId,
    selectedTaskIds: [...params.receipt.selectedTaskIds],
    estimatedSavedTokens: params.receipt.estimatedSavedTokens,
    estimatedSavedChars: params.receipt.estimatedSavedChars,
    tokenCountMode: params.receipt.tokenCountMode,
    deferredTaskIds: [...params.receipt.deferredTaskIds],
    reasons: [...new Set(params.reasons)],
    updatedAt: new Date().toISOString(),
    status: params.status,
    fallbackUsed: params.receipt.fallbackUsed,
  };
}

function staleValidationReasons(reasons: readonly string[]): boolean {
  return reasons.some((reason) => [
    "clean_execution_revision_stale",
    "clean_execution_task_not_evictable",
    "clean_execution_item_stale",
    "clean_execution_protected_item_targeted",
    "clean_execution_task_attribution_stale",
    "clean_execution_revalidation_failed",
    "clean_execution_protocol_closure_failed",
  ].includes(reason));
}

async function recordTerminal(params: {
  executionBridge: ContextCleanerHostExecutionBridge;
  scheduledReceipt: ContextCleanScheduledReceipt;
  status: "stale" | "failed";
  reasons: string[];
}): Promise<ContextCleanTerminalReceipt | undefined> {
  const receipt = terminalReceipt({
    receipt: params.scheduledReceipt,
    status: params.status,
    reasons: params.reasons,
  });
  const result = await params.executionBridge.recordCleanReceipt(receipt);
  return result.bypassed ? undefined : receipt;
}

/**
 * Apply a scheduled clean to the live surface.
 *
 * Only a fully committed transaction becomes `applied`. A stale validation,
 * empty target set, deferred transaction, or partial transaction is persisted
 * as a terminal non-applied result, so a later pre-step cannot replay a
 * mutation that was already rejected or only partly landed.
 */
export async function applyScheduledDshClean(params: {
  session: CycleSession;
  executionBridge: ContextCleanerHostExecutionBridge;
  request: ContextCleanExecutionRequest;
  computeRevision: (session: AppendableSession) => string;
}): Promise<DshCleanApplyOutcome> {
  const prepared = await params.executionBridge.prepareScheduledClean(params.request);
  if (prepared.outcome === "terminal") {
    return { outcome: "terminal", receipt: prepared.receipt, claimed: false };
  }
  if (prepared.outcome !== "ready") {
    const reasons = "reasons" in prepared && prepared.reasons.length > 0
      ? [...prepared.reasons]
      : [`clean_prepare_${prepared.outcome}`];
    // A claimed pointer must always become terminal, even when live
    // revalidation cannot produce an executable mutation.  Persist the shared
    // terminal receipt while we still have the frozen scheduled receipt; this
    // makes `/tokenpilot-clean --status` agree with the local replay guard and
    // prevents an old scheduled receipt from looking retryable after a claim.
    if (prepared.outcome === "bypassed" && prepared.receipt?.status === "scheduled") {
      const status = staleValidationReasons(reasons) ? "stale" as const : "failed" as const;
      const receipt = await recordTerminal({
        executionBridge: params.executionBridge,
        scheduledReceipt: prepared.receipt as ContextCleanScheduledReceipt,
        status,
        reasons,
      });
      return status === "stale"
        ? { outcome: "stale", ...(receipt ? { receipt } : {}), reasons, claimed: false }
        : { outcome: "failed", ...(receipt ? { receipt } : {}), reasons, claimed: false, surfaceChanged: false };
    }
    return { outcome: "skipped", reasons, claimed: false };
  }

  const { execution } = prepared;
  const previousRevision = params.computeRevision(params.session);

  // mutationPlan target item ids (event-<seq>-<kind>) -> DSH's R4 targets.
  const bySeq = new Map(
    describeEffectiveItems(params.session.events, params.session.surface.nodes).map((item) => [item.seq, item]),
  );
  const targets: EvictionTarget[] = [];
  const targetedSeqs = new Set<number>();
  for (const operation of execution.mutationPlan.operations) {
    for (const stableId of operation.targetItemIds) {
      const seq = parseSeq(stableId);
      if (seq === undefined || !bySeq.has(seq) || targetedSeqs.has(seq)) continue;
      targetedSeqs.add(seq);
      targets.push(buildCleanTarget(bySeq.get(seq)!, execution.mutationPlan.planId));
    }
  }

  if (targets.length === 0) {
    const reasons = ["clean_no_targets"];
    const receipt = await recordTerminal({
      executionBridge: params.executionBridge,
      scheduledReceipt: execution.scheduledReceipt,
      status: "stale",
      reasons,
    });
    return { outcome: "stale", ...(receipt ? { receipt } : {}), reasons, claimed: true };
  }

  const plan: EvictionPlan = {
    evictionId: execution.mutationPlan.planId,
    revision: previousRevision,
    targets,
  };
  const result = applyEvictionTransaction(params.session, plan, params.computeRevision);
  if (result.status !== "committed") {
    const status = result.status === "partial" ? "failed" as const : "stale" as const;
    const reasons = [
      `clean_apply_${result.status}`,
      ...(result.deferReason ? [`clean_apply_${result.deferReason}`] : []),
    ];
    const receipt = await recordTerminal({
      executionBridge: params.executionBridge,
      scheduledReceipt: execution.scheduledReceipt,
      status,
      reasons,
    });
    return status === "stale"
      ? { outcome: "stale", ...(receipt ? { receipt } : {}), reasons, claimed: true }
      : { outcome: "failed", ...(receipt ? { receipt } : {}), reasons, claimed: true, surfaceChanged: result.status === "partial" };
  }

  const applied = new Set(result.appliedSeqs);
  if (applied.size !== targets.length || targets.some((target) => !applied.has(target.sourceEventSeq))) {
    const reasons = ["clean_apply_incomplete_commit"];
    const receipt = await recordTerminal({
      executionBridge: params.executionBridge,
      scheduledReceipt: execution.scheduledReceipt,
      status: "failed",
      reasons,
    });
    return { outcome: "failed", ...(receipt ? { receipt } : {}), reasons, claimed: true, surfaceChanged: false };
  }

  const appliedOperations = execution.mutationPlan.operations.filter((operation) =>
    operation.targetItemIds.length > 0
    && operation.targetItemIds.every((stableId) => {
      const seq = parseSeq(stableId);
      return seq !== undefined && applied.has(seq);
    }),
  );
  const appliedItemIds = appliedOperations.flatMap((operation) => operation.targetItemIds);
  const appliedSavedChars = appliedOperations.reduce((sum, operation) => sum + (operation.estimatedSavedChars ?? 0), 0);

  const scheduled = execution.scheduledReceipt;
  const receipt: ContextCleanAppliedReceipt = {
    schemaVersion: scheduled.schemaVersion,
    planId: scheduled.planId,
    hostId: DSH_HOST_ID,
    sessionId: scheduled.sessionId,
    selectedTaskIds: scheduled.selectedTaskIds,
    estimatedSavedTokens: scheduled.estimatedSavedTokens,
    estimatedSavedChars: scheduled.estimatedSavedChars,
    tokenCountMode: scheduled.tokenCountMode,
    deferredTaskIds: scheduled.deferredTaskIds,
    reasons: scheduled.reasons,
    updatedAt: new Date().toISOString(),
    status: "applied",
    appliedSavedTokens: null,
    appliedSavedChars,
    fallbackUsed: false,
    evidence: {
      previousRevision,
      nextRevision: params.computeRevision(params.session),
      operationIds: appliedOperations.map((operation) => operation.id),
      itemIds: appliedItemIds,
    },
  };

  const saved = await params.executionBridge.recordCleanReceipt(receipt);
  if (saved.bypassed) {
    // The rewrite already landed, so make the scheduler terminal in the caller
    // and never let a later request replay it as a second mutation.
    return {
      outcome: "failed",
      reasons: ["clean_applied_receipt_record_failed", ...saved.reasons],
      claimed: true,
      surfaceChanged: true,
    };
  }
  return { outcome: "applied", receipt, claimed: true };
}
