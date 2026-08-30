import { createHash } from "node:crypto";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextMutationPlan,
  type ContextRewriteResult,
  type ContextRewriteValidation,
  type ModelContextRewriteBackend,
  type ModelContextSnapshot,
} from "@lightrsi/host-adapter";
import type { RuntimeMessage } from "@lightrsi/kernel";
import { buildClaudeContextSnapshot } from "./snapshot.js";

const CLAUDE_HOST_ID = "claude-code";
const TOOL_RESULT_POINTER = "[evicted: earlier tool result content removed]";
const TEXT_POINTER = "[evicted: earlier content removed]";

export type ClaudeOverlayRequest = {
  sessionId: string;
  revision: string;
  messages: RuntimeMessage[];
};

// Front-checks that must all hold before any operation may apply. Mirrors the
// openclaw reference backend, minus canonical-state specifics.
function fatalReasonsFor(
  snapshot: ModelContextSnapshot,
  plan: ContextMutationPlan,
): string[] {
  const reasons: string[] = [];
  if (plan.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION) {
    reasons.push(`unsupported schema version: ${plan.schemaVersion}`);
  }
  if (snapshot.hostId !== CLAUDE_HOST_ID || plan.hostId !== CLAUDE_HOST_ID) {
    reasons.push("hostId must be claude-code");
  }
  if (plan.sessionId !== snapshot.sessionId) {
    reasons.push("plan sessionId does not match snapshot");
  }
  if (plan.baseRevision !== snapshot.revision) {
    reasons.push("plan baseRevision does not match snapshot");
  }
  const ids = new Set(snapshot.items.map((item) => item.stableId));
  if (ids.size !== snapshot.items.length) {
    reasons.push("snapshot item ids must be unique");
  }
  return reasons;
}

type ParsedStableId = { msgIdx: number; blockIdx: number };

function parseStableId(id: string): ParsedStableId | undefined {
  const parts = id.split(":");
  if (parts.length < 3) return undefined;
  const msgIdx = Number(parts[parts.length - 2]);
  const blockIdx = Number(parts[parts.length - 1]);
  if (!Number.isInteger(msgIdx) || !Number.isInteger(blockIdx)) return undefined;
  return { msgIdx, blockIdx };
}

function asBlockRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lastUserMessageIndex(messages: RuntimeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function blockCharCount(block: Record<string, unknown>): number {
  const value =
    block.type === "tool_result"
      ? block.content
      : block.type === "tool_use"
        ? block.input
        : (block.text ?? block.content);
  if (typeof value === "string") return value.length;
  return JSON.stringify(value ?? "").length;
}

function messagesRevision(messages: RuntimeMessage[]): string {
  return `claude-rev-${createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")}`;
}

function isRewritableBlock(
  block: Record<string, unknown>,
  sourceModuleId: string,
): boolean {
  return block.type === "tool_result"
    || block.type === "text"
    // A Cleaner approval freezes both sides of a closed pair. Keep the
    // protocol identifiers, but remove the historical tool input as part of
    // that exact, user-approved scope. Automatic eviction keeps its existing
    // result-only behavior.
    || (block.type === "tool_use" && sourceModuleId === "cleaner_manual");
}

function claudeToolClosureReasons(
  snapshot: ModelContextSnapshot,
  plan: ContextMutationPlan,
): Map<string, string> {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const item of snapshot.items) {
    if (item.kind === "tool_call" && item.callId) {
      calls.set(item.callId, (calls.get(item.callId) ?? 0) + 1);
    }
    if (item.kind === "tool_result" && item.callId) {
      results.set(item.callId, (results.get(item.callId) ?? 0) + 1);
    }
  }

  const itemById = new Map(snapshot.items.map((item) => [item.stableId, item]));
  const reasons = new Map<string, string>();
  for (const operation of plan.operations) {
    const targetIds = new Set(operation.targetItemIds);
    for (const targetId of operation.targetItemIds) {
      const item = itemById.get(targetId);
      if (!item || (item.kind !== "tool_call" && item.kind !== "tool_result")) continue;
      if (!item.callId) {
        reasons.set(operation.id, `operation ${operation.id} has a tool item without call id`);
        break;
      }
      if ((calls.get(item.callId) ?? 0) !== 1 || (results.get(item.callId) ?? 0) !== 1) {
        reasons.set(operation.id, `operation ${operation.id} targets an incomplete tool pair`);
        break;
      }
      if (plan.sourceModuleId === "cleaner_manual") {
        const pair = snapshot.items.filter((candidate) => candidate.callId === item.callId
          && (candidate.kind === "tool_call" || candidate.kind === "tool_result"));
        if (pair.some((candidate) => !targetIds.has(candidate.stableId))) {
          reasons.set(operation.id, `operation ${operation.id} targets only part of a tool pair`);
          break;
        }
      }
    }
  }
  return reasons;
}

// Rewrite a single block to its pointer stub. tool_result keeps its type and
// tool_use_id so the tool-use/tool-result pair stays closed; only the content
// is replaced. Other blocks become a short text stub.
function toolResultContentDigest(block: Record<string, unknown>): string | undefined {
  const content = block.content;
  if (typeof content !== "string") return undefined;
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// Given an op's archiveRefs (opaque "archive://claude/<digest>" entries), find
// the recovery dataKey for a specific block by matching the block's own content
// digest. Matching by digest (not array order) guarantees the recovery_ref is
// bound to the correct item.
function recoveryRefForBlock(
  block: Record<string, unknown>,
  archiveRefs: string[] | undefined,
): string | undefined {
  if (!archiveRefs || archiveRefs.length === 0) return undefined;
  const digest = toolResultContentDigest(block);
  if (!digest) return undefined;
  const match = archiveRefs.find((ref) => ref === "archive://claude/" + digest);
  return match ? "claude_tool_result:" + digest : undefined;
}

function stubBlock(block: Record<string, unknown>, recoveryRef?: string): Record<string, unknown> {
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: {},
    };
  }
  if (block.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: recoveryRef
        ? "[Tool payload trimmed; recovery_ref=" + recoveryRef + "]"
        : TOOL_RESULT_POINTER,
      ...(block.is_error === true ? { is_error: true } : {}),
    };
  }
  return { type: "text", text: TEXT_POINTER };
}

export const claudeContextRewriteBackend: ModelContextRewriteBackend<ClaudeOverlayRequest> = {
  hostId: CLAUDE_HOST_ID,
  mode: "request_overlay",

  async readSnapshot({ sessionId, request }) {
    return buildClaudeContextSnapshot({
      sessionId,
      revision: request.revision,
      messages: request.messages,
    });
  },

  async validate({ snapshot, plan }) {
    const fatal = fatalReasonsFor(snapshot, plan);
    if (fatal.length > 0) {
      return {
        valid: false,
        applicableOperationIds: [],
        deferredOperationIds: plan.operations.map((op) => op.id),
        reasons: fatal,
      };
    }
    // An operation is applicable only if every target item still exists in the
    // snapshot, has an exact fingerprint claim, and survives protocol closure.
    // Otherwise it is deferred, never fuzzily applied.
    const itemById = new Map<string, typeof snapshot.items>();
    for (const item of snapshot.items) {
      itemById.set(item.stableId, [
        ...(itemById.get(item.stableId) ?? []),
        item,
      ]);
    }
    const applicableOperationIds: string[] = [];
    const deferredOperationIds: string[] = [];
    const closureReasons = claudeToolClosureReasons(snapshot, plan);
    const operationIdCounts = new Map<string, number>();
    for (const op of plan.operations) {
      operationIdCounts.set(op.id, (operationIdCounts.get(op.id) ?? 0) + 1);
    }
    const reasons: string[] = [];
    for (const op of plan.operations) {
      if ((operationIdCounts.get(op.id) ?? 0) !== 1) {
        if (!deferredOperationIds.includes(op.id)) deferredOperationIds.push(op.id);
        if (!reasons.includes(`operation ${op.id} has a duplicate id`)) {
          reasons.push(`operation ${op.id} has a duplicate id`);
        }
        continue;
      }
      if (op.targetItemIds.length === 0) {
        if (!deferredOperationIds.includes(op.id)) deferredOperationIds.push(op.id);
        reasons.push(`operation ${op.id} has no targets`);
        continue;
      }
      if (closureReasons.has(op.id)) {
        if (!deferredOperationIds.includes(op.id)) deferredOperationIds.push(op.id);
        reasons.push(closureReasons.get(op.id)!);
        continue;
      }
      const fingerprintKeys = Object.keys(op.targetItemFingerprints ?? {});
      const fingerprintsInScope = op.targetItemFingerprints === undefined
        || (fingerprintKeys.length === op.targetItemIds.length
          && op.targetItemIds.every((id) => fingerprintKeys.includes(id)));
      const targetsOk = fingerprintsInScope && op.targetItemIds.every((id) => {
        const matchingItems = itemById.get(id) ?? [];
        const item = matchingItems.length === 1 ? matchingItems[0] : undefined;
        if (!item) return false;
        const expected = op.targetItemFingerprints?.[id];
        return expected === undefined || expected === item.fingerprint;
      });
      if (targetsOk) {
        if (!applicableOperationIds.includes(op.id)) applicableOperationIds.push(op.id);
      } else {
        if (!deferredOperationIds.includes(op.id)) deferredOperationIds.push(op.id);
        reasons.push(`operation ${op.id} targets are missing or drifted`);
      }
    }
    return {
      valid: true,
      applicableOperationIds,
      deferredOperationIds,
      reasons,
    };
  },

  async apply({ snapshot, plan, request }) {
    const validation = await this.validate({ snapshot, plan });

    const unchanged = (fallbackUsed: boolean): ContextRewriteResult => ({
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      mode: "request_overlay",
      planId: plan.planId,
      applied: false,
      changed: false,
      previousRevision: snapshot.revision,
      nextRevision: snapshot.revision,
      appliedOperationIds: [],
      deferredOperationIds: plan.operations.map((op) => op.id),
      removedItemIds: [],
      savedChars: 0,
      fallbackUsed,
    });

    if (!validation.valid || validation.applicableOperationIds.length === 0) {
      return { request, result: unchanged(false) };
    }

    try {
      // Guard against drift: the request we are about to rewrite must still
      // describe the same revision the plan was validated against.
      const current = buildClaudeContextSnapshot({
        sessionId: request.sessionId,
        revision: request.revision,
        messages: request.messages,
      });
      if (request.sessionId !== snapshot.sessionId) {
        return { request, result: unchanged(false) };
      }
      const snapshotItems = new Map(snapshot.items.map((item) => [item.stableId, item.fingerprint]));
      const currentItems = new Map(current.items.map((item) => [item.stableId, item.fingerprint]));
      if (current.revision !== snapshot.revision
        || snapshotItems.size !== currentItems.size
        || [...snapshotItems].some(([id, fingerprint]) => currentItems.get(id) !== fingerprint)) {
        return { request, result: unchanged(false) };
      }

      const messages = structuredClone(request.messages);
      const protectedIdx = lastUserMessageIndex(messages);
      const applicable = new Set(validation.applicableOperationIds);

      const removedItemIds: string[] = [];
      const appliedOperationIds: string[] = [];
      const deferredOperationIds = [...validation.deferredOperationIds];
      let savedChars = 0;

      for (const op of plan.operations) {
        if (!applicable.has(op.id)) continue;
        let opTouched = false;

        for (const itemId of op.targetItemIds) {
          const parsed = parseStableId(itemId);
          if (!parsed) continue;
          const { msgIdx, blockIdx } = parsed;
          // Never rewrite the current user turn or assistant prefill after it.
          if (protectedIdx < 0 || msgIdx >= protectedIdx) continue;
          const message = messages[msgIdx];
          if (!message) continue;
          if (typeof message.content === "string") {
            if (blockIdx !== 0 || message.role !== "assistant") continue;
            const oldText = message.content;
            message.content = TEXT_POINTER;
            savedChars += Math.max(0, oldText.length - TEXT_POINTER.length);
            removedItemIds.push(itemId);
            opTouched = true;
            continue;
          }
          if (!Array.isArray(message.content)) continue;
          const block = asBlockRecord(message.content[blockIdx]);
          if (!block || !isRewritableBlock(block, plan.sourceModuleId)) continue;
          // A manual Cleaner scope contains both sides of a valid pair. Its
          // tool-use stub retains id/name and an object input, so the rewritten
          // Messages history remains structurally closed.
          const recoveryRef = recoveryRefForBlock(block, op.archiveRefs);
          const stub = stubBlock(block, recoveryRef);
          savedChars += Math.max(0, blockCharCount(block) - blockCharCount(stub));
          message.content[blockIdx] = stub as never;
          removedItemIds.push(itemId);
          opTouched = true;
        }

        if (opTouched) appliedOperationIds.push(op.id);
        else deferredOperationIds.push(op.id);
      }

      const changed = removedItemIds.length > 0;
      const nextRequest = changed ? { ...request, messages } : request;
      const nextRevision = changed ? messagesRevision(messages) : snapshot.revision;

      const result: ContextRewriteResult = {
        schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
        mode: "request_overlay",
        planId: plan.planId,
        applied: appliedOperationIds.length > 0,
        changed,
        previousRevision: snapshot.revision,
        nextRevision,
        appliedOperationIds,
        deferredOperationIds,
        removedItemIds,
        savedChars,
        fallbackUsed: false,
      };
      return { request: nextRequest, result };
    } catch {
      return { request, result: unchanged(true) };
    }
  },
};

/**
 * Relocate a persisted plan onto a new snapshot when a later turn has shifted
 * item positions (so stableIds and the revision changed) but the underlying
 * content is unchanged. For each operation, every target is re-anchored by its
 * content fingerprint: exactly one snapshot item with that fingerprint -> the
 * operation is re-targeted to that item's new stableId; zero or multiple
 * matches -> the operation is dropped (deferred), never fuzzily relocated.
 * The returned plan carries the new snapshot.revision as its baseRevision so
 * the standard validate/apply path accepts it.
 */
export function relocateContextMutationPlan(params: {
  snapshot: ModelContextSnapshot;
  plan: ContextMutationPlan;
}): { plan: ContextMutationPlan; relocated: boolean } {
  const { snapshot, plan } = params;

  const stableIdsByFingerprint = new Map<string, string[]>();
  for (const item of snapshot.items) {
    stableIdsByFingerprint.set(item.fingerprint, [
      ...(stableIdsByFingerprint.get(item.fingerprint) ?? []),
      item.stableId,
    ]);
  }

  const relocatedOperations: ContextMutationPlan["operations"] = [];
  for (const op of plan.operations) {
    const fingerprints = op.targetItemFingerprints ?? {};
    const nextTargetIds: string[] = [];
    const nextFingerprints: Record<string, string> = {};
    let relocatable = op.targetItemIds.length > 0;

    for (const oldId of op.targetItemIds) {
      const fingerprint = fingerprints[oldId];
      if (fingerprint === undefined) {
        relocatable = false;
        break;
      }
      const matches = stableIdsByFingerprint.get(fingerprint) ?? [];
      // Conservative: only a unique fingerprint match is safe to relocate.
      if (matches.length !== 1) {
        relocatable = false;
        break;
      }
      nextTargetIds.push(matches[0]);
      nextFingerprints[matches[0]] = fingerprint;
    }

    if (relocatable) {
      relocatedOperations.push({
        ...op,
        targetItemIds: nextTargetIds,
        targetItemFingerprints: nextFingerprints,
      });
    }
    // Non-relocatable operations are dropped: deferred, never fuzzily applied.
  }

  return {
    plan: {
      ...plan,
      baseRevision: snapshot.revision,
      operations: relocatedOperations,
    },
    relocated: relocatedOperations.length > 0,
  };
}

export type EvictableToolResult = {
  opId: string;
  itemId: string;
  toolUseId: string;
  msgIdx: number;
  blockIdx: number;
  originalText: string;
};

/**
 * Collect the tool_result items a plan would evict from the current request,
 * together with their original text — WITHOUT mutating anything. The gateway
 * uses this to archive each tool_result before apply runs; apply then evicts
 * the same items. Sharing one locator keeps "what gets archived" and "what gets
 * evicted" from drifting apart. Only tool_result blocks are collected (text
 * blocks are not archived). Mirrors apply's locating rules, including the
 * protected-turn guard, so it never selects the active user turn or a prefill.
 */
export function collectEvictableToolResults(params: {
  snapshot: ModelContextSnapshot;
  plan: ContextMutationPlan;
  request: ClaudeOverlayRequest;
  applicableOperationIds: string[];
}): EvictableToolResult[] {
  const { plan, request, applicableOperationIds } = params;
  const applicable = new Set(applicableOperationIds);
  const messages = request.messages;
  const protectedIdx = lastUserMessageIndex(messages);
  const collected: EvictableToolResult[] = [];

  for (const op of plan.operations) {
    if (!applicable.has(op.id)) continue;
    for (const itemId of op.targetItemIds) {
      const parsed = parseStableId(itemId);
      if (!parsed) continue;
      const { msgIdx, blockIdx } = parsed;
      if (protectedIdx < 0 || msgIdx >= protectedIdx) continue;
      const message = messages[msgIdx];
      if (!message || !Array.isArray(message.content)) continue;
      const block = asBlockRecord(message.content[blockIdx]);
      if (!block || block.type !== "tool_result") continue;
      const content = block.content;
      if (typeof content !== "string") continue;
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      collected.push({
        opId: op.id,
        itemId,
        toolUseId,
        msgIdx,
        blockIdx,
        originalText: content,
      });
    }
  }
  return collected;
}
