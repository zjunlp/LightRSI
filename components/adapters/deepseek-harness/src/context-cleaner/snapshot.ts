/**
 * DSH → ContextCleanSnapshot (context cleaner, unit 1).
 *
 * The cleaner core analyzes a Host-neutral `ModelContextSnapshot`. This module
 * builds that snapshot from the DSH canonical surface: one item per
 * model-visible durable event, with registry-proven task attribution and the
 * visible text the cleaner needs for token accounting. It reads only; it never
 * mutates the surface (that is the execution bridge, via R4 surface-transaction).
 */

import type { SessionTaskRegistry } from "@lightrsi/history";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextItemKind,
  type ContextItemRef,
  type ModelContextSnapshot,
} from "@lightrsi/host-adapter";
import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanSnapshot,
  type ContextCleanTokenCountMode,
} from "@lightrsi/cleaner";

import type { DshLogEventWithMeta } from "../types.js";

export const DSH_HOST_ID = "deepseek-harness";

/**
 * Stable surface revision: changes when surface membership or the replace
 * generation changes. Used both for a snapshot's baseRevision and (later) the
 * R4 execution guard, so a scheduled clean is rejected if the surface moved.
 */
export function surfaceRevision(session: {
  readonly surface: { readonly nodes: readonly number[]; readonly replaceGeneration: number };
}): string {
  let hash = 5381;
  const material = `${session.surface.nodes.join(",")}|${session.surface.replaceGeneration}`;
  for (let i = 0; i < material.length; i += 1) hash = ((hash << 5) + hash + material.charCodeAt(i)) >>> 0;
  return `dsh-surf-${hash.toString(16)}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Stable djb2 fingerprint over kind + visible text (identity across revisions). */
function fingerprint(kind: string, text: string): string {
  let hash = 5381;
  const material = `${kind}\u0000${text}`;
  for (let i = 0; i < material.length; i += 1) hash = ((hash << 5) + hash + material.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

function isReplace(event: DshLogEventWithMeta): boolean {
  const op = (event as { surfaceOp?: unknown }).surfaceOp;
  return isObject(op) && op.op === "replace";
}

function messageText(data: Record<string, unknown>): string {
  const message = isObject(data.message) ? data.message : data;
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value)) return;
    if (value.type === "text" && typeof value.text === "string") {
      parts.push(value.text);
      return;
    }
    if (Array.isArray(value.content)) visit(value.content);
  };
  visit(message.content);
  if (parts.length === 0 && typeof message.text === "string") {
    parts.push(message.text);
  }
  return parts.join("\n");
}

function toolCallText(data: Record<string, unknown>): string {
  const name = typeof data.name === "string" ? data.name : "";
  const args = data.arguments ?? data.args ?? data.input;
  const argText = args === undefined ? "" : (() => {
    try { return JSON.stringify(args); } catch { return String(args); }
  })();
  return `${name}(${argText})`;
}

/** Tool-call blocks live inside a DSH assistant message, not only in log-only tool/call events. */
function assistantToolCalls(data: Record<string, unknown>): Array<{ callId: string; text: string }> {
  const message = isObject(data.message) ? data.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block) => {
    if (!isObject(block)
      || block.type !== "tool-call"
      || typeof block.id !== "string"
      || !block.id.trim()) return [];
    return [{
      callId: block.id,
      text: toolCallText(block),
    }];
  });
}

function resultCallId(data: Record<string, unknown>): string | undefined {
  const message = isObject(data.message) ? data.message : {};
  const source = isObject(message.source) ? message.source : {};
  if (typeof source.callId === "string" && source.callId) return source.callId;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const b of content) {
    if (isObject(b) && b.type === "tool-result" && typeof b.toolCallId === "string") return b.toolCallId;
  }
  return undefined;
}

const KIND_SLUG: Record<ContextItemKind, string> = {
  system: "system", developer: "developer", user: "user", assistant: "assistant",
  reasoning: "reasoning", tool_call: "tool-call", tool_result: "tool-result",
  compaction: "compaction", unknown: "unknown",
};

/** Registry-proven task ids for a turn (only tasks that actually exist). */
function turnTaskIds(registry: SessionTaskRegistry, sessionId: string, turn: number): string[] | undefined {
  const ids = registry.turnToTaskIds[`${sessionId}:t${turn}`];
  if (!ids || ids.length === 0) return undefined;
  const normalized = ids.map((id) => id.trim()).filter((id) => id && registry.tasks[id] !== undefined);
  if (normalized.length === 0) return undefined;
  return [...new Set(normalized)].sort();
}

export interface DshCleanSnapshotSession {
  readonly id: string;
  readonly events: readonly DshLogEventWithMeta[];
  readonly surface: { readonly nodes: readonly number[]; readonly replaceGeneration: number };
}

/** Build the cleaner snapshot from the current DSH surface. Read-only. */
export function buildDshCleanSnapshot(params: {
  session: DshCleanSnapshotSession;
  registry: SessionTaskRegistry;
  revision: string;
  capturedAt?: string;
}): { snapshot: ContextCleanSnapshot; itemTextByStableId: Record<string, string> } {
  const { session, registry, revision } = params;
  const effective = new Set(session.surface.nodes);
  const items: ContextItemRef[] = [];
  const itemTextByStableId: Record<string, string> = {};
  let activeTurn = 0;

  for (const event of session.events) {
    const data = isObject((event as { data?: unknown }).data) ? (event.data as Record<string, unknown>) : {};
    if (event.type === "turn/start" && typeof data.turn === "number") activeTurn = data.turn;
    const turn = typeof data.turn === "number" ? data.turn : activeTurn;
    if (!effective.has(event.seq) || event.ignorable === true) continue;

    let kind: ContextItemKind;
    let text: string;
    let callId: string | undefined;
    switch (event.type) {
      case "user/message":
        kind = isReplace(event) ? "compaction" : "user";
        text = messageText(data);
        break;
      case "assistant/message":
        kind = isReplace(event) ? "compaction" : "assistant";
        text = messageText(data);
        break;
      case "tool/call":
        kind = "tool_call";
        text = toolCallText(data);
        callId = typeof data.callId === "string" ? data.callId : undefined;
        break;
      case "tool/result":
        kind = "tool_result";
        text = messageText(data);
        callId = resultCallId(data);
        break;
      default:
        continue; // turn/step boundaries + unknown types are not items
    }

    const taskIds = turnTaskIds(registry, session.id, turn);
    const embeddedCalls = event.type === "assistant/message" && !isReplace(event)
      ? assistantToolCalls(data)
      : [];

    // An assistant envelope containing only a tool call has no independent
    // visible text. Keep its call item, but do not create a duplicate empty
    // assistant item that would be independently selectable.
    if (!(kind === "assistant" && text.length === 0 && embeddedCalls.length > 0)) {
      const stableId = `event-${event.seq}-${KIND_SLUG[kind]}`;
      const ref: ContextItemRef = {
        stableId,
        kind,
        role: kind === "tool_call" ? "assistant" : kind === "tool_result" ? "user" : kind,
        ...(callId ? { callId } : {}),
        ...(taskIds ? { taskIds } : {}),
        fingerprint: fingerprint(kind, text),
        chars: text.length,
      };
      items.push(ref);
      itemTextByStableId[stableId] = text;
    }

    for (const embedded of embeddedCalls) {
      const stableId = `event-${event.seq}-tool-call-${embedded.callId}`;
      const ref: ContextItemRef = {
        stableId,
        kind: "tool_call",
        role: "assistant",
        callId: embedded.callId,
        ...(taskIds ? { taskIds } : {}),
        fingerprint: fingerprint("tool_call", embedded.text),
        chars: embedded.text.length,
      };
      items.push(ref);
      itemTextByStableId[stableId] = embedded.text;
    }
  }

  const base: ModelContextSnapshot = {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    hostId: DSH_HOST_ID,
    sessionId: session.id,
    revision,
    items,
  };

  const tokenCountMode: ContextCleanTokenCountMode = "chars_only";
  const snapshot: ContextCleanSnapshot = {
    ...base,
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    tokenCountMode,
    tokenCountMethod: "dsh-surface-chars",
  };
  void CONTEXT_CLEAN_SCHEMA_VERSION;

  return { snapshot, itemTextByStableId };
}
