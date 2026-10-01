import type { SessionTaskRegistry } from "@lightrsi/history";
import type { ContextItemRef, ModelContextSnapshot } from "@lightrsi/host-adapter";

import { buildToolResultSegments } from "../eviction.js";

export function scheduledCleanerAttributionUnavailable(params: {
  selectedTaskIds: readonly string[];
  approvalSnapshot: ModelContextSnapshot;
  currentSnapshot: ModelContextSnapshot;
}): boolean {
  const selectedTaskIds = new Set(params.selectedTaskIds);
  const expectedTaskIdsByCallId = new Map<string, Set<string>>();
  for (const item of params.approvalSnapshot.items) {
    if (!item.callId) continue;
    const expectedTaskIds = (item.taskIds ?? []).filter((taskId) => selectedTaskIds.has(taskId));
    if (expectedTaskIds.length === 0) continue;
    const accumulated = expectedTaskIdsByCallId.get(item.callId) ?? new Set<string>();
    for (const taskId of expectedTaskIds) accumulated.add(taskId);
    expectedTaskIdsByCallId.set(item.callId, accumulated);
  }

  let unavailableAttribution = false;
  for (const [callId, expectedTaskIds] of expectedTaskIdsByCallId) {
    const approvalPair = params.approvalSnapshot.items.filter((item) => item.callId === callId
      && (item.kind === "tool_call" || item.kind === "tool_result"));
    const currentPair = params.currentSnapshot.items.filter((item) => item.callId === callId
      && (item.kind === "tool_call" || item.kind === "tool_result"));
    const approvalCalls = approvalPair.filter((item) => item.kind === "tool_call");
    const approvalResults = approvalPair.filter((item) => item.kind === "tool_result");
    const currentCalls = currentPair.filter((item) => item.kind === "tool_call");
    const currentResults = currentPair.filter((item) => item.kind === "tool_result");
    // Missing, partial, or ambiguous pairs are genuine context drift and stay
    // on the existing stale-validation path. That deterministic drift wins
    // over unavailable attribution on any other approved pair.
    if (approvalCalls.length !== 1
      || approvalResults.length !== 1
      || currentCalls.length !== 1
      || currentResults.length !== 1) return false;
    if (approvalCalls[0]!.fingerprint !== currentCalls[0]!.fingerprint
      || approvalResults[0]!.fingerprint !== currentResults[0]!.fingerprint) return false;
    const retainsApprovedTaskProof = [...expectedTaskIds].some((taskId) => (
      currentPair.every((item) => item.taskIds?.includes(taskId))
    ));
    if (retainsApprovedTaskProof) continue;
    // A different non-empty task attribution is also deterministic drift.
    // Defer only when the complete pair has lost attribution evidence entirely.
    if (currentPair.every((item) => (item.taskIds?.length ?? 0) > 0)) return false;
    unavailableAttribution = true;
  }
  return unavailableAttribution;
}

function provenTaskIds(
  registry: SessionTaskRegistry,
  segmentId: string,
  toolUseId: string,
  turnAbsIdByToolCallId?: ReadonlyMap<string, string>,
): string[] | undefined {
  const direct = registry.blockToTaskIds[segmentId];
  const turnAbsId = turnAbsIdByToolCallId?.get(toolUseId);
  const related = direct ?? (turnAbsId ? registry.turnToTaskIds[turnAbsId] : undefined);
  if (!related || related.length === 0) return undefined;
  const normalized = related.map((taskId) => taskId.trim());
  if (normalized.some((taskId) => !taskId || registry.tasks[taskId] === undefined)
    || new Set(normalized).size !== normalized.length) return undefined;
  return [...normalized].sort();
}

/**
 * Add only registry-proven task ownership to a canonical Claude snapshot.
 * Claude's stable item ids are positional, while the registry keys historical
 * closed tool results by semantic segment id. buildToolResultSegments is the
 * adapter-owned proof that connects those identities. Text and current-turn
 * content deliberately remain unassigned.
 */
export function attributeClaudeSnapshotTasks(params: {
  snapshot: ModelContextSnapshot;
  messages: unknown[];
  registry: SessionTaskRegistry;
  turnAbsIdByToolCallId?: ReadonlyMap<string, string>;
}): ModelContextSnapshot {
  const cleanItems = params.snapshot.items.map(({ taskIds: _taskIds, ...item }) => item);
  if (params.snapshot.hostId !== "claude-code"
    || params.registry.sessionId !== params.snapshot.sessionId) {
    return { ...params.snapshot, items: cleanItems };
  }

  const itemsByStableId = new Map(cleanItems.map((item) => [item.stableId, item] as const));
  const itemsByCallId = new Map<string, ContextItemRef[]>();
  for (const item of cleanItems) {
    if (!item.callId) continue;
    const related = itemsByCallId.get(item.callId) ?? [];
    related.push(item);
    itemsByCallId.set(item.callId, related);
  }

  const attributedTaskIds = new Map<string, string[]>();
  const { bindings } = buildToolResultSegments(params.messages);
  for (const binding of bindings.values()) {
    const taskIds = provenTaskIds(
      params.registry,
      binding.segmentId,
      binding.toolUseId,
      params.turnAbsIdByToolCallId,
    );
    if (!taskIds) continue;
    const resultStableId = `${params.snapshot.sessionId}:${binding.messageIndex}:${binding.blockIndex}`;
    const result = itemsByStableId.get(resultStableId);
    const pairedItems = itemsByCallId.get(binding.toolUseId) ?? [];
    const calls = pairedItems.filter((item) => item.kind === "tool_call");
    const results = pairedItems.filter((item) => item.kind === "tool_result");
    if (result?.kind !== "tool_result"
      || result.callId !== binding.toolUseId
      || calls.length !== 1
      || results.length !== 1
      || results[0]?.stableId !== resultStableId) continue;
    attributedTaskIds.set(calls[0]!.stableId, taskIds);
    attributedTaskIds.set(resultStableId, taskIds);
  }

  return {
    ...params.snapshot,
    items: cleanItems.map((item) => {
      const taskIds = attributedTaskIds.get(item.stableId);
      return taskIds ? { ...item, taskIds } : item;
    }),
  };
}
