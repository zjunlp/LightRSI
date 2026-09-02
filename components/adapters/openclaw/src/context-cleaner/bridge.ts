import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  createContextCleanerHostExecutionBridge,
  type ContextCleanerControlPlane,
  type ContextCleanerHostBridge,
  type ContextCleanReceipt,
  type ContextCleanScheduledReceipt,
  type ExecuteApprovedContextCleanParams,
} from "@lightrsi/cleaner";
import {
  loadCanonicalState,
  loadSessionTaskRegistry,
  canonicalStatePath,
  type CanonicalTranscriptState,
} from "@lightrsi/history";
import { writeJsonFileAtomic } from "@lightrsi/host-adapter";

import {
  createOpenClawReferenceBackend,
  type OpenClawReferenceBackendRequest,
} from "../context-rewrite/reference-backend.js";
import { appendTaskStateTrace } from "../trace/io.js";
import { asRecord, extractPathLike, safeId } from "../context-stack/integration/config-types.js";
import { contentToText } from "../context-stack/integration/runtime-event-text.js";
import {
  canonicalMessageTaskIds,
  dedupeStrings,
  ensureContextSafeDetails,
  extractToolMessageText,
  isToolResultLikeMessage,
  messageToolCallId,
} from "../context-stack/integration/runtime-tooling.js";
import { listOpenClawCleanerSessions } from "./session-catalog.js";

const OPENCLAW_HOST_ID = "openclaw";

type OpenClawCleanerConfig = {
  replacementMode?: "pointer_stub" | "drop";
  now?: () => string;
};

type OpenClawApplyIntent = {
  version: 1;
  planId: string;
  sessionId: string;
  previousRevision: string;
  nextRevision: string;
  receipt: ContextCleanReceipt;
};

function intentPath(stateDir: string, planId: string): string {
  const key = createHash("sha256").update(planId).digest("hex");
  return join(stateDir, "context-cleaner", "openclaw-apply", `${key}.json`);
}

function sessionLockPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDir, "context-cleaner", "openclaw-locks", `${key}.lock`);
}

async function withSessionLock<T>(params: {
  stateDir: string;
  sessionId: string;
  action(): Promise<T>;
}): Promise<T> {
  const path = sessionLockPath(params.stateDir, params.sessionId);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ageMs = Date.now() - (await stat(path)).mtimeMs;
      if (ageMs <= 5 * 60_000) throw new Error("openclaw_clean_session_busy");
      await unlink(path);
      handle = await open(path, "wx");
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await params.action();
  } finally {
    await handle?.close().catch(() => undefined);
    if (handle) await unlink(path).catch(() => undefined);
  }
}

async function readIntent(stateDir: string, planId: string): Promise<OpenClawApplyIntent | undefined> {
  try {
    const parsed = JSON.parse(await readFile(intentPath(stateDir, planId), "utf8")) as OpenClawApplyIntent;
    if (parsed?.version !== 1
      || parsed.planId !== planId
      || typeof parsed.sessionId !== "string"
      || typeof parsed.previousRevision !== "string"
      || typeof parsed.nextRevision !== "string"
      || !parsed.receipt
      || parsed.receipt.planId !== planId
      || parsed.receipt.status !== "applied") {
      throw new Error("openclaw_clean_apply_intent_invalid");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveIntent(stateDir: string, intent: OpenClawApplyIntent): Promise<void> {
  const path = intentPath(stateDir, intent.planId);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFileAtomic(path, intent);
}

async function removeIntent(stateDir: string, planId: string): Promise<void> {
  await unlink(intentPath(stateDir, planId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isScheduledReceipt(
  receipt: ContextCleanReceipt,
): receipt is ContextCleanScheduledReceipt {
  return receipt.status === "scheduled";
}

function uniqueStrings(values: readonly string[]): string[] | undefined {
  const normalized = values.map((value) => value.trim());
  return normalized.every(Boolean) && new Set(normalized).size === normalized.length
    ? normalized
    : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.length === actual.length
    && expected.every((value, index) => value === actual[index]);
}

function validNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateReceipt(params: {
  receipt: ContextCleanReceipt;
  planId: string;
  sessionId?: string;
  selectedTaskIds?: string[];
}): ContextCleanReceipt {
  const { receipt } = params;
  if (receipt.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION
    || receipt.hostId !== OPENCLAW_HOST_ID
    || receipt.planId !== params.planId
    || (params.sessionId !== undefined && receipt.sessionId !== params.sessionId)
    || !canonicalTimestamp(receipt.updatedAt)
    || !uniqueStrings(receipt.selectedTaskIds)
    || !uniqueStrings(receipt.deferredTaskIds)
    || (receipt.estimatedSavedTokens !== null
      && !validNonNegativeInteger(receipt.estimatedSavedTokens))
    || !validNonNegativeInteger(receipt.estimatedSavedChars)) {
    throw new Error("openclaw_clean_receipt_mismatch");
  }
  if (params.selectedTaskIds
    && !sameStrings(receipt.selectedTaskIds, params.selectedTaskIds)) {
    throw new Error("openclaw_clean_receipt_mismatch");
  }
  if (receipt.status === "applied") {
    if (receipt.fallbackUsed
      || (receipt.appliedSavedTokens !== null
        && !validNonNegativeInteger(receipt.appliedSavedTokens))
      || !validNonNegativeInteger(receipt.appliedSavedChars)
      || !receipt.evidence.previousRevision.trim()
      || !receipt.evidence.nextRevision.trim()
      || !uniqueStrings(receipt.evidence.operationIds)?.length
      || !uniqueStrings(receipt.evidence.itemIds)?.length) {
      throw new Error("openclaw_clean_receipt_mismatch");
    }
  } else {
    const record = receipt as unknown as Record<string, unknown>;
    if (Object.hasOwn(record, "appliedSavedTokens")
      || Object.hasOwn(record, "appliedSavedChars")) {
      throw new Error("openclaw_clean_receipt_mismatch");
    }
  }
  return receipt;
}

function validateApproval(request: ExecuteApprovedContextCleanParams): string[] {
  if (request.schemaVersion !== CONTEXT_CLEAN_SCHEMA_VERSION) {
    throw new Error("openclaw_clean_approval_schema_mismatch");
  }
  if (request.hostId !== OPENCLAW_HOST_ID) {
    throw new Error("openclaw_clean_approval_host_mismatch");
  }
  if (!request.cleanPlanId.trim()
    || !request.sessionId.trim()
    || !request.baseRevision.trim()
    || !canonicalTimestamp(request.approvedAt)
    || request.selectedTasks.length === 0) {
    throw new Error("openclaw_clean_approval_invalid");
  }
  const taskIds = uniqueStrings(request.selectedTasks.map((task) => task.taskId));
  if (!taskIds) throw new Error("openclaw_clean_approval_invalid");
  const claimedItemIds = new Set<string>();
  for (const task of request.selectedTasks) {
    const itemIds = uniqueStrings(task.itemIds);
    if (!itemIds || itemIds.length === 0 || Object.keys(task.itemDigests).length !== itemIds.length) {
      throw new Error("openclaw_clean_approval_targets_invalid");
    }
    for (const itemId of itemIds) {
      if (claimedItemIds.has(itemId) || !task.itemDigests[itemId]?.trim()) {
        throw new Error("openclaw_clean_approval_targets_invalid");
      }
      claimedItemIds.add(itemId);
    }
  }
  return taskIds;
}

function createRequest(params: {
  stateDir: string;
  state: CanonicalTranscriptState;
  replacementMode: "pointer_stub" | "drop";
}): OpenClawReferenceBackendRequest {
  return {
    stateDir: params.stateDir,
    sessionId: params.state.sessionId,
    state: params.state,
    evictionEnabled: true,
    evictionPolicy: "model_scored",
    evictionMinBlockChars: 0,
    evictionReplacementMode: params.replacementMode,
    helpers: {
      appendTaskStateTrace,
      asRecord,
      canonicalMessageTaskIds: (message) => canonicalMessageTaskIds(message, asRecord),
      contentToText,
      dedupeStrings,
      ensureContextSafeDetails,
      extractPathLike,
      extractToolMessageText,
      isToolResultLikeMessage,
      messageToolCallId,
      safeId,
      logger: { info: () => undefined },
    },
  };
}

function terminalReceipt(params: {
  scheduled: ContextCleanScheduledReceipt;
  status: "stale" | "failed";
  reasons: string[];
  now: () => string;
}): ContextCleanReceipt {
  return {
    ...params.scheduled,
    status: params.status,
    reasons: params.reasons.length > 0 ? params.reasons : [`openclaw_clean_${params.status}`],
    updatedAt: params.now(),
  };
}

function targetItemIds(params: {
  operationIds: readonly string[];
  mutationPlan: { operations: Array<{ id: string; targetItemIds: string[] }> };
}): string[] {
  const applied = new Set(params.operationIds);
  return dedupeStrings(params.mutationPlan.operations
    .filter((operation) => applied.has(operation.id))
    .flatMap((operation) => operation.targetItemIds));
}

export function createOpenClawContextCleanerBridge(params: {
  stateDir: string;
  controlPlane: ContextCleanerControlPlane;
  config?: OpenClawCleanerConfig;
}): ContextCleanerHostBridge {
  if (!params.stateDir.trim()) throw new Error("openclaw_clean_state_dir_missing");
  const now = params.config?.now ?? (() => new Date().toISOString());
  const replacementMode = params.config?.replacementMode === "drop" ? "drop" : "pointer_stub";
  const backend = createOpenClawReferenceBackend();

  async function readState(sessionId: string): Promise<CanonicalTranscriptState> {
    const state = await loadCanonicalState(params.stateDir, sessionId);
    if (!state) throw new Error("openclaw_clean_session_not_found");
    if (!canonicalTimestamp(state.updatedAt)) throw new Error("openclaw_clean_snapshot_timestamp_invalid");
    return state;
  }

  async function readSnapshot(sessionId: string) {
    const state = await readState(sessionId);
    const request = createRequest({ stateDir: params.stateDir, state, replacementMode });
    const { adapterMetadata: _adapterMetadata, ...snapshot } = await backend.readSnapshot({
      sessionId,
      request,
    });
    return {
      ...snapshot,
      capturedAt: state.updatedAt,
      tokenCountMode: "chars_only" as const,
      tokenCountMethod: "utf16_chars",
    };
  }

  const executionBridge = createContextCleanerHostExecutionBridge({
    stateDir: params.stateDir,
    hostId: OPENCLAW_HOST_ID,
    async readExecutionSnapshot(sessionId) {
      const [snapshot, registry] = await Promise.all([
        readSnapshot(sessionId),
        loadSessionTaskRegistry(params.stateDir, sessionId),
      ]);
      return {
        snapshot,
        activeTaskIds: registry.activeTaskIds,
        evictableTaskIds: registry.evictableTaskIds,
      };
    },
  });

  async function record(receipt: ContextCleanReceipt): Promise<ContextCleanReceipt> {
    const stored = await executionBridge.recordCleanReceipt(receipt);
    if (stored.bypassed) {
      throw new Error(`openclaw_clean_receipt_store_failed:${stored.reasons.join(",")}`);
    }
    return receipt;
  }

  async function recoverIntent(
    scheduled: ContextCleanScheduledReceipt,
  ): Promise<ContextCleanReceipt | undefined> {
    const intent = await readIntent(params.stateDir, scheduled.planId);
    if (!intent) return undefined;
    if (intent.sessionId !== scheduled.sessionId) {
      throw new Error("openclaw_clean_apply_intent_identity_mismatch");
    }
    const state = await readState(scheduled.sessionId);
    const current = await backend.readSnapshot({
      sessionId: scheduled.sessionId,
      request: createRequest({ stateDir: params.stateDir, state, replacementMode }),
    });
    if (current.revision === intent.nextRevision) {
      const receipt = await record(intent.receipt);
      await removeIntent(params.stateDir, scheduled.planId);
      return receipt;
    }
    if (current.revision === intent.previousRevision) {
      await removeIntent(params.stateDir, scheduled.planId);
      return undefined;
    }
    await removeIntent(params.stateDir, scheduled.planId);
    return record(terminalReceipt({
      scheduled,
      status: "stale",
      reasons: ["openclaw_clean_revision_stale"],
      now,
    }));
  }

  return {
    hostId: OPENCLAW_HOST_ID,
    rewriteMode: "canonical",
    listSessions() {
      return listOpenClawCleanerSessions(params.stateDir);
    },
    readCleanSnapshot: readSnapshot,
    async executeApprovedClean(request) {
      const selectedTaskIds = validateApproval(request);
      return withSessionLock({
        stateDir: params.stateDir,
        sessionId: request.sessionId,
        action: async () => {
          const scheduled = validateReceipt({
            receipt: await params.controlPlane.executeApprovedClean(request),
            planId: request.cleanPlanId,
            sessionId: request.sessionId,
            selectedTaskIds,
          });
          if (!isScheduledReceipt(scheduled)) {
            await removeIntent(params.stateDir, request.cleanPlanId).catch(() => undefined);
            return scheduled;
          }

          const recovered = await recoverIntent(scheduled);
          if (recovered) return recovered;

      const prepared = await executionBridge.prepareScheduledClean({
        cleanPlanId: request.cleanPlanId,
        sessionId: request.sessionId,
        baseRevision: request.baseRevision,
        selectedTaskIds,
      });
      if (prepared.outcome === "terminal") return prepared.receipt;
      if (prepared.outcome !== "ready") {
        const stale = prepared.reasons.some((reason) =>
          reason.includes("stale") || reason.includes("revision") || reason.includes("state_changed"));
        return record(terminalReceipt({
          scheduled,
          status: stale ? "stale" : "failed",
          reasons: prepared.reasons,
          now,
        }));
      }

      const state = await readState(request.sessionId);
      const backendRequest = createRequest({ stateDir: params.stateDir, state, replacementMode });
      const snapshot = await backend.readSnapshot({ sessionId: request.sessionId, request: backendRequest });
      if (snapshot.revision !== request.baseRevision) {
        return record(terminalReceipt({
          scheduled,
          status: "stale",
          reasons: ["openclaw_clean_revision_stale"],
          now,
        }));
      }

      const applied = await backend.apply({
        snapshot,
        plan: prepared.execution.mutationPlan,
        request: backendRequest,
      });
      if (!applied.result.applied || !applied.result.changed) {
        return record(terminalReceipt({
          scheduled,
          status: applied.result.fallbackUsed ? "failed" : "stale",
          reasons: applied.result.fallbackUsed
            ? ["openclaw_clean_canonical_rewrite_failed"]
            : ["openclaw_clean_no_applicable_targets"],
          now,
        }));
      }

      const appliedTaskIds = applied.result.details?.appliedTaskIds ?? [];
      const deferredTaskIds = selectedTaskIds.filter((taskId) => !appliedTaskIds.includes(taskId));
      const receipt: ContextCleanReceipt = {
        ...scheduled,
        status: "applied",
        appliedSavedTokens: null,
        appliedSavedChars: applied.result.savedChars,
        deferredTaskIds,
        reasons: deferredTaskIds.length > 0 ? ["openclaw_clean_targets_deferred"] : [],
        updatedAt: now(),
        fallbackUsed: false,
        evidence: {
          previousRevision: applied.result.previousRevision,
          nextRevision: applied.result.nextRevision,
          operationIds: [...applied.result.appliedOperationIds],
          itemIds: targetItemIds({
            operationIds: applied.result.appliedOperationIds,
            mutationPlan: prepared.execution.mutationPlan,
          }),
        },
      };
      await saveIntent(params.stateDir, {
        version: 1,
        planId: scheduled.planId,
        sessionId: scheduled.sessionId,
        previousRevision: applied.result.previousRevision,
        nextRevision: applied.result.nextRevision,
        receipt,
      });

      const latest = await readState(request.sessionId);
      const latestSnapshot = await backend.readSnapshot({
        sessionId: request.sessionId,
        request: createRequest({ stateDir: params.stateDir, state: latest, replacementMode }),
      });
      if (latestSnapshot.revision !== request.baseRevision) {
        await removeIntent(params.stateDir, scheduled.planId);
        return record(terminalReceipt({
          scheduled,
          status: "stale",
          reasons: ["openclaw_clean_revision_stale"],
          now,
        }));
      }

      await writeJsonFileAtomic(
        canonicalStatePath(params.stateDir, request.sessionId),
        applied.request.state,
      );
      const storedReceipt = await record(receipt);
      await removeIntent(params.stateDir, scheduled.planId).catch(() => undefined);
      return storedReceipt;
        },
      });
    },
    async readCleanReceipt(planId) {
      if (!planId.trim()) throw new Error("openclaw_clean_plan_id_invalid");
      const receipt = await params.controlPlane.readCleanReceipt(planId);
      if (!receipt) return undefined;
      const validated = validateReceipt({ receipt, planId });
      if (!isScheduledReceipt(validated)) return validated;
      try {
        return await withSessionLock({
          stateDir: params.stateDir,
          sessionId: validated.sessionId,
          action: async () => {
            const current = await params.controlPlane.readCleanReceipt(planId);
            if (!current) return undefined;
            const latest = validateReceipt({ receipt: current, planId });
            if (!isScheduledReceipt(latest)) return latest;
            return await recoverIntent(latest) ?? latest;
          },
        });
      } catch (error) {
        if ((error as Error).message === "openclaw_clean_session_busy") return validated;
        throw error;
      }
    },
    async cancelCleanPlan(planId) {
      if (!planId.trim()) throw new Error("openclaw_clean_plan_id_invalid");
      const current = await params.controlPlane.readCleanReceipt(planId);
      if (!current) {
        return validateReceipt({
          receipt: await params.controlPlane.cancelCleanPlan(planId),
          planId,
        });
      }
      const validated = validateReceipt({ receipt: current, planId });
      return withSessionLock({
        stateDir: params.stateDir,
        sessionId: validated.sessionId,
        action: async () => {
          const latestValue = await params.controlPlane.readCleanReceipt(planId);
          if (!latestValue) throw new Error("openclaw_clean_receipt_missing");
          const latest = validateReceipt({ receipt: latestValue, planId });
          if (isScheduledReceipt(latest)) {
            const recovered = await recoverIntent(latest);
            if (recovered) return recovered;
          }
          return validateReceipt({
            receipt: await params.controlPlane.cancelCleanPlan(planId),
            planId,
          });
        },
      });
    },
  };
}
