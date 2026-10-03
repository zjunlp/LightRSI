/* eslint-disable @typescript-eslint/no-explicit-any */
import type { HostPayloadCodec, HostRequestEnvelope } from "@lightrsi/host-adapter";
import type { ContextSegment, RuntimeTurnContext } from "@lightrsi/kernel";
import {
  analyzeExecOutputTruncation,
  analyzeToolPayloadTrim,
  resolveReductionPasses,
  runReductionBeforeCall,
} from "@lightrsi/reduction";
import type { TokenPilotCodexConfig } from "./config.js";
import { loadCodexSessionSnapshot } from "./session-state.js";

type SegmentBinding = {
  segmentId: string;
  itemIndex: number;
  field: "content" | "arguments" | "output";
  blockIndex?: number;
  blockKey?: "text" | "content";
  toolName?: string;
  callId?: string;
};

type ReductionInstruction = {
  strategy: string;
  segmentIds: string[];
  confidence: number;
  priority: number;
  rationale: string;
  parameters?: Record<string, unknown>;
};

export type CodexReductionPassEffect = {
  id: string;
  changed: boolean;
  skippedReason?: string;
  note?: string;
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  touchedSegmentIds?: string[];
};

export type CodexReductionDiagnostics = {
  inputItems: number;
  toolLikeItems: number;
  candidateSegments: number;
  candidateChars: number;
};

type CodexReductionReportEntry = {
  id: string;
  phase: string;
  target: string;
  changed: boolean;
  skippedReason?: string;
  note?: string;
  beforeChars: number;
  afterChars: number;
  touchedSegmentIds?: string[];
};

export type CodexReductionVisualSegment = {
  segmentId: string;
  itemIndex: number;
  field: "content" | "arguments" | "output" | "result";
  blockIndex?: number;
  blockKey?: "text" | "content";
  toolName?: string;
  savedChars: number;
  beforeText: string;
  afterText: string;
  report: CodexReductionReportEntry[];
};

export type CodexReductionSummary = {
  changedItems: number;
  changedBlocks: number;
  savedChars: number;
  beforeChars: number;
  afterChars: number;
  report: CodexReductionReportEntry[];
  passEffects: CodexReductionPassEffect[];
  diagnostics: CodexReductionDiagnostics;
  visualSegments?: CodexReductionVisualSegment[];
  disclosedReadPaths?: string[];
  /** Normalized read path -> call_id of the read that first disclosed it (null: not attributable). */
  disclosedReadOwners?: DisclosedReadOwners;
  skippedReason?: string;
};

export type DisclosedReadOwners = Record<string, string | null>;

export function normalizeDisclosedReadOwners(value: unknown): DisclosedReadOwners | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const next: DisclosedReadOwners = {};
  for (const [path, owner] of Object.entries(value as Record<string, unknown>)) {
    const normalized = path.trim().toLowerCase();
    if (!normalized) continue;
    next[normalized] = typeof owner === "string" && owner ? owner : null;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Paths to hand the pass as "already disclosed". Codex resends the whole input
 * history every request, so a disclosing read that is still in it is re-detected by
 * the pass itself. Carrying its path too would make the pass treat that same read as
 * a repeat and send it untrimmed, which breaks the prompt cache. Only paths whose
 * disclosing read has left the history (compaction) are carried.
 */
export function carriedDisclosedReadPaths(
  owners: DisclosedReadOwners | undefined,
  presentCallIds: ReadonlySet<string>,
): string[] | undefined {
  if (!owners) return undefined;
  const carried = Object.entries(owners)
    .filter(([, owner]) => owner === null || !presentCallIds.has(owner))
    .map(([path]) => path);
  return carried.length > 0 ? carried : undefined;
}

/**
 * Rebuild owners for the reported path set; new paths belong to a matching read
 * actually trimmed in this request.
 */
export function recordDisclosedReadOwners(
  owners: DisclosedReadOwners | undefined,
  reportedPaths: unknown,
  segments: readonly ContextSegment[],
  bindings: readonly SegmentBinding[],
  trimmedSegmentIds: ReadonlySet<string>,
): DisclosedReadOwners | undefined {
  const paths = normalizeDisclosedReadPaths(reportedPaths);
  if (!paths) return owners;
  const next: DisclosedReadOwners = {};
  const bindingBySegment = new Map(bindings.map((binding) => [binding.segmentId, binding]));
  for (const path of paths) {
    if (owners && Object.hasOwn(owners, path)) {
      next[path] = owners[path] ?? null;
      continue;
    }
    const owner = segments.find((segment) => {
      if (!trimmedSegmentIds.has(segment.id)) return false;
      const binding = bindingBySegment.get(segment.id);
      const toolName = binding?.toolName?.trim().toLowerCase();
      if (toolName !== "read" && toolName !== "file_read") return false;
      const segmentPath = (segment.metadata as Record<string, unknown> | undefined)?.path;
      return typeof segmentPath === "string" && segmentPath.trim().toLowerCase() === path;
    });
    next[path] = (owner && bindingBySegment.get(owner.id)?.callId) || null;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function presentCallIds(payload: any): Set<string> {
  const ids = new Set<string>();
  for (const item of Array.isArray(payload?.input) ? payload.input : []) {
    if (item && typeof item === "object" && typeof item.call_id === "string" && item.call_id) ids.add(item.call_id);
  }
  return ids;
}

function normalizeDisclosedReadPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const next = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (normalized) next.add(normalized);
  }
  return next.size > 0 ? [...next] : undefined;
}

function stringifyStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseStructuredObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extractPathHint(value: unknown): string | undefined {
  const record = asRecord(value);
  const candidates = [
    record.path,
    record.file_path,
    record.filePath,
    record.filename,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function normalizeResponsesInputForUpstream(input: any): void {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "function_call" && typeof item.arguments !== "string") {
      item.arguments = stringifyStructuredValue(item.arguments);
    }
    if (type === "function_call_output" && typeof item.output !== "string") {
      item.output = stringifyStructuredValue(item.output);
    }
  }
}

function payloadKindForItem(item: any): "stdout" | "stderr" | "json" | "blob" {
  const text = typeof item?.output === "string" ? item.output : typeof item?.content === "string" ? item.content : "";
  const lowerType = String(item?.type ?? "").toLowerCase();
  if (lowerType.includes("stderr")) return "stderr";
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }
  return "stdout";
}

function payloadKindForText(text: string): "stdout" | "stderr" | "json" | "blob" {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return "stdout";
    }
  }
  if (/(\bstderr\b|error:|traceback|exception)/i.test(text)) return "stderr";
  if (isHtmlLikeText(text)) return "blob";
  if (text.length > 500 && countLines(text) <= 2) return "blob";
  return "stdout";
}

function isToolLikeInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const role = String(item.role ?? "").toLowerCase();
  const type = String(item.type ?? "").toLowerCase();
  if (role === "tool" || role === "observation" || role === "toolresult") return true;
  if (type === "function_call_output" || type === "tool_result" || type === "tool_call_output") return true;
  if (typeof item.tool_call_id === "string" && item.tool_call_id.trim()) return true;
  if (typeof item.toolCallId === "string" && item.toolCallId.trim()) return true;
  return false;
}

function isHtmlLikeText(text: string): boolean {
  return /<\/?(html|body|main|section|article|nav|script|style|div|span|a|p|ul|ol|li|table|meta|link)\b/i.test(text);
}

function looksLikeWebPayload(text: string): boolean {
  if (isHtmlLikeText(text)) return true;
  return /\b(<!doctype html|<head\b|<body\b|href=|src=|aria-|data-|document\.|window\.)/i.test(text);
}

function countLines(text: string): number {
  const matches = text.match(/\n/g);
  return matches ? matches.length + 1 : text.length > 0 ? 1 : 0;
}

function thresholdForTool(toolName: string, config: TokenPilotCodexConfig): number {
  const normalized = toolName.toLowerCase();
  const optionThresholds = config.reduction.passOptions.execOutputTruncation?.toolThresholds;
  if (optionThresholds && typeof optionThresholds === "object" && normalized in optionThresholds) {
    const value = Number((optionThresholds as Record<string, unknown>)[normalized]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (normalized === "bash" || normalized === "shell" || normalized === "powershell") return 30_000;
  if (normalized === "grep" || normalized === "rg") return 20_000;
  if (normalized === "read" || normalized === "file_read") return Infinity;
  if (normalized === "mcp_auth") return 10_000;
  return 50_000;
}

function segmentForText(params: {
  id: string;
  text: string;
  source: string;
  item: any;
  field: string;
  latestUserQuery: string;
  path?: string;
  toolName?: string;
}): ContextSegment {
  const isToolLike =
    String(params.item?.role ?? "").toLowerCase() === "tool"
    || String(params.item?.type ?? "").toLowerCase() === "function_call_output"
    || params.field === "output";
  const toolName = typeof params.toolName === "string" && params.toolName.trim()
    ? params.toolName.trim()
    : typeof params.item?.name === "string" ? params.item.name : "tool";
  return {
    id: params.id,
    kind: isToolLike ? "volatile" : "semi_stable",
    text: params.text,
    priority: isToolLike ? 30 : 60,
    source: params.source,
    metadata: {
      role: params.item?.role,
      type: params.item?.type,
      fieldName: params.field,
      latestUserQuery: params.latestUserQuery,
      ...(params.path ? { path: params.path } : {}),
      ...(isToolLike
        ? {
            role: "tool",
            isToolPayload: true,
            payloadKind: payloadKindForItem(params.item),
            toolPayload: {
              enabled: true,
              kind: payloadKindForItem(params.item),
              toolName,
              fieldName: params.field,
              ...(params.path ? { path: params.path } : {}),
            },
            reduction: {
              target: "tool_payload",
              payloadKind: payloadKindForItem(params.item),
              toolPayloadTrim: {
                enabled: true,
                kind: payloadKindForItem(params.item),
              },
            },
          }
        : {}),
    },
  };
}

function extractLatestUserQuery(input: any): string {
  if (!Array.isArray(input)) return "";
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object" || String(item.role ?? "") !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content
        .map((block: any) => block && typeof block === "object" && typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function buildTurnContext(
  payload: any,
  sessionId: string,
  options?: { disclosedReadPaths?: string[] },
): {
  turnCtx: RuntimeTurnContext;
  bindings: SegmentBinding[];
  diagnostics: CodexReductionDiagnostics;
} {
  const segments: ContextSegment[] = [];
  const bindings: SegmentBinding[] = [];
  const latestUserQuery = extractLatestUserQuery(payload?.input);
  const toolCallHints = new Map<string, { toolName?: string; path?: string }>();
  let inputItems = 0;
  let toolLikeItems = 0;
  if (Array.isArray(payload?.input)) {
    payload.input.forEach((item: any, itemIndex: number) => {
      if (!item || typeof item !== "object") return;
      inputItems += 1;
      if (String(item.type ?? "").toLowerCase() === "function_call") {
        const callId = typeof item.call_id === "string"
          ? item.call_id
          : typeof item.id === "string" ? item.id : "";
        if (callId) {
          toolCallHints.set(callId, {
            toolName: typeof item.name === "string" ? item.name : undefined,
            path: extractPathHint(parseStructuredObject(item.arguments)),
          });
        }
      }
      if (!isToolLikeInputItem(item)) return;
      toolLikeItems += 1;
      const callHint = typeof item.call_id === "string" ? toolCallHints.get(item.call_id) : undefined;
      const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
      if (typeof item.output === "string") {
        const id = `input-${itemIndex}-output`;
        segments.push(segmentForText({
          id,
          text: item.output,
          source: "responses.input.output",
          item,
          field: "output",
          latestUserQuery,
          path: callHint?.path,
          toolName: callHint?.toolName,
        }));
        bindings.push({
          segmentId: id,
          itemIndex,
          field: "output",
          toolName: callHint?.toolName ?? (typeof item?.name === "string" ? item.name : undefined),
          ...(callId ? { callId } : {}),
        });
      }
      if (typeof item.arguments === "string") {
        const id = `input-${itemIndex}-arguments`;
        segments.push(segmentForText({
          id,
          text: item.arguments,
          source: "responses.input.arguments",
          item,
          field: "arguments",
          latestUserQuery,
          path: callHint?.path,
          toolName: callHint?.toolName,
        }));
        bindings.push({
          segmentId: id,
          itemIndex,
          field: "arguments",
          toolName: callHint?.toolName ?? (typeof item?.name === "string" ? item.name : undefined),
          ...(callId ? { callId } : {}),
        });
      }
      if (typeof item.content === "string") {
        const id = `input-${itemIndex}-content`;
        segments.push(segmentForText({
          id,
          text: item.content,
          source: "responses.input.content",
          item,
          field: "content",
          latestUserQuery,
          path: callHint?.path,
          toolName: callHint?.toolName,
        }));
        bindings.push({
          segmentId: id,
          itemIndex,
          field: "content",
          toolName: callHint?.toolName ?? (typeof item?.name === "string" ? item.name : undefined),
          ...(callId ? { callId } : {}),
        });
      }
      if (Array.isArray(item.content)) {
        item.content.forEach((block: any, blockIndex: number) => {
          if (!block || typeof block !== "object") return;
          const blockKey = typeof block.text === "string" ? "text" : typeof block.content === "string" ? "content" : undefined;
          if (!blockKey) return;
          const id = `input-${itemIndex}-content-${blockIndex}-${blockKey}`;
          segments.push(segmentForText({
            id,
            text: block[blockKey],
            source: `responses.input.content.${blockKey}`,
            item,
            field: "content",
            latestUserQuery,
            path: callHint?.path,
            toolName: callHint?.toolName,
          }));
          bindings.push({
            segmentId: id,
            itemIndex,
            field: "content",
            blockIndex,
            blockKey,
            toolName: callHint?.toolName ?? (typeof item?.name === "string" ? item.name : undefined),
            ...(callId ? { callId } : {}),
          });
        });
      }
    });
  }
  return {
    turnCtx: {
      sessionId,
      sessionMode: "single",
      provider: "codex",
      model: typeof payload?.model === "string" ? payload.model : "",
      apiFamily: "openai-responses",
      prompt: latestUserQuery,
      budget: {
        maxInputTokens: 0,
        reserveOutputTokens: 0,
      },
      segments,
      metadata: {
        latestUserQuery,
        ...(options?.disclosedReadPaths ? { disclosedReadPaths: options.disclosedReadPaths } : {}),
      },
    },
    bindings,
    diagnostics: {
      inputItems,
      toolLikeItems,
      candidateSegments: segments.length,
      candidateChars: segments.reduce((sum, segment) => sum + segment.text.length, 0),
    },
  };
}

function buildAnalyzerReductionInstructions(
  segments: ContextSegment[],
  config: TokenPilotCodexConfig,
): ReductionInstruction[] {
  const instructions: ReductionInstruction[] = [];
  if (config.reduction.passes.toolPayloadTrim) {
    const toolPayloadDecision = analyzeToolPayloadTrim(segments, {
      enabled: true,
      minChars: 120,
      minSavedChars: Math.max(300, Math.floor(config.reduction.maxToolChars * 0.25)),
      onlyLikelyToolSegments: false,
    });
    instructions.push(...toolPayloadDecision.instructions);
  }
  if (config.reduction.passes.execOutputTruncation) {
    const toolThresholds = config.reduction.passOptions.execOutputTruncation?.toolThresholds;
    const execDecision = analyzeExecOutputTruncation(segments, {
      enabled: true,
      toolThresholds: toolThresholds && typeof toolThresholds === "object"
        ? toolThresholds as Record<string, number>
        : {},
      minExcessChars: 1000,
    });
    instructions.push(...execDecision.instructions);
  }
  return instructions;
}

function buildCodexFallbackReductionInstructions(
  segments: ContextSegment[],
  config: TokenPilotCodexConfig,
): ReductionInstruction[] {
  const instructions: ReductionInstruction[] = [];
  const toolPayloadByKind = new Map<string, ContextSegment[]>();
  const execSegmentIds: string[] = [];

  for (const segment of segments) {
    const meta = segment.metadata ?? {};
    const toolPayload = meta.toolPayload && typeof meta.toolPayload === "object"
      ? meta.toolPayload as Record<string, unknown>
      : {};
    const isToolPayload =
      meta.isToolPayload === true ||
      meta.role === "tool" ||
      meta.role === "tool_result" ||
      meta.fieldName === "output" ||
      typeof toolPayload.toolName === "string";
    const isWebPayload = looksLikeWebPayload(segment.text);
    const shouldConsiderForTrim = isToolPayload || isWebPayload;
    if (!shouldConsiderForTrim) continue;

    const toolName = typeof toolPayload.toolName === "string" && toolPayload.toolName.trim()
      ? toolPayload.toolName.trim()
      : isWebPayload ? "web_fetch" : "tool";
    const payloadKind = isWebPayload
      ? "blob"
      : typeof meta.payloadKind === "string" ? meta.payloadKind : payloadKindForText(segment.text);

    if (config.reduction.passes.toolPayloadTrim && segment.text.length >= (isWebPayload ? 120 : 200)) {
      const key = payloadKind === "json" || payloadKind === "stderr" || payloadKind === "blob" ? payloadKind : "stdout";
      const existing = toolPayloadByKind.get(key) ?? [];
      existing.push(segment);
      toolPayloadByKind.set(key, existing);
    }

    const execThreshold = thresholdForTool(toolName, config);
    if (
      config.reduction.passes.execOutputTruncation &&
      Number.isFinite(execThreshold) &&
      segment.text.length > execThreshold
    ) {
      execSegmentIds.push(segment.id);
    }
  }

  for (const [kind, kindSegments] of toolPayloadByKind) {
    const totalChars = kindSegments.reduce((sum, segment) => sum + segment.text.length, 0);
    const hasWebPayload = kindSegments.some((segment) => looksLikeWebPayload(segment.text));
    const minGroupChars = hasWebPayload
      ? Math.max(300, Math.floor(config.reduction.maxToolChars * 0.25))
      : Math.max(600, Math.floor(config.reduction.maxToolChars * 0.5));
    if (totalChars < minGroupChars) continue;
    instructions.push({
      strategy: "tool_payload_trim",
      segmentIds: kindSegments.map((segment) => segment.id),
      confidence: kind === "json" ? 0.9 : kind === "stdout" ? 0.8 : 0.75,
      priority: hasWebPayload ? 9 : 8,
      rationale: `Codex tool payload trim: ${kindSegments.length} ${kind} segment(s), ${totalChars} chars`,
      parameters: {
        payloadKind: kind,
        segmentCount: kindSegments.length,
        totalChars,
      },
    });
  }

  if (execSegmentIds.length > 0) {
    instructions.push({
      strategy: "exec_output_truncation",
      segmentIds: execSegmentIds,
      confidence: 0.99,
      priority: 10,
      rationale: `Codex large tool output truncation: ${execSegmentIds.length} segment(s)`,
    });
  }

  return instructions.sort((a, b) => b.priority - a.priority);
}

function dedupeReductionInstructions(instructions: ReductionInstruction[]): ReductionInstruction[] {
  const seen = new Set<string>();
  const result: ReductionInstruction[] = [];
  for (const instruction of instructions) {
    const key = `${instruction.strategy}:${[...instruction.segmentIds].sort().join(",")}:${JSON.stringify(instruction.parameters ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(instruction);
  }
  return result.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

function withReductionPolicy(
  turnCtx: RuntimeTurnContext,
  instructions: ReductionInstruction[],
): RuntimeTurnContext {
  if (instructions.length === 0) return turnCtx;
  const existingPolicy = turnCtx.metadata?.policy && typeof turnCtx.metadata.policy === "object"
    ? turnCtx.metadata.policy as Record<string, unknown>
    : {};
  const existingDecisions = existingPolicy.decisions && typeof existingPolicy.decisions === "object"
    ? existingPolicy.decisions as Record<string, unknown>
    : {};
  const existingReduction = existingDecisions.reduction && typeof existingDecisions.reduction === "object"
    ? existingDecisions.reduction as Record<string, unknown>
    : {};
  const existingInstructions = Array.isArray(existingReduction.instructions)
    ? existingReduction.instructions as unknown[]
    : [];
  return {
    ...turnCtx,
    metadata: {
      ...(turnCtx.metadata ?? {}),
      policy: {
        ...existingPolicy,
        decisions: {
          ...existingDecisions,
          reduction: {
            ...existingReduction,
            instructions: [...existingInstructions, ...instructions],
          },
        },
      },
    },
  };
}

function summarizePassEffects(report: CodexReductionReportEntry[]): CodexReductionPassEffect[] {
  return report.map((entry) => ({
    id: String(entry.id),
    changed: entry.changed,
    skippedReason: entry.skippedReason,
    note: entry.note,
    beforeChars: entry.beforeChars,
    afterChars: entry.afterChars,
    savedChars: Math.max(0, entry.beforeChars - entry.afterChars),
    touchedSegmentIds: entry.touchedSegmentIds,
  }));
}

function passOptionsFromConfig(config: TokenPilotCodexConfig): Record<string, Record<string, unknown>> {
  return {
    read_state_compaction: config.reduction.passOptions.readStateCompaction ?? {},
    tool_payload_trim: {
      maxChars: config.reduction.maxToolChars,
      ...(config.reduction.passOptions.toolPayloadTrim ?? {}),
    },
    html_slimming: config.reduction.passOptions.htmlSlimming ?? {},
    exec_output_truncation: config.reduction.passOptions.execOutputTruncation ?? {},
    agents_startup_optimization: config.reduction.passOptions.agentsStartupOptimization ?? {},
  };
}

function enabledPassIds(config: TokenPilotCodexConfig): Set<string> {
  const ids = new Set<string>();
  if (config.reduction.passes.readStateCompaction) ids.add("read_state_compaction");
  if (config.reduction.passes.toolPayloadTrim) ids.add("tool_payload_trim");
  if (config.reduction.passes.htmlSlimming) ids.add("html_slimming");
  if (config.reduction.passes.execOutputTruncation) ids.add("exec_output_truncation");
  if (config.reduction.passes.agentsStartupOptimization) ids.add("agents_startup_optimization");
  return ids;
}

export async function applyBeforeCallReductionToPayload(params: {
  payload: any;
  sessionId: string;
  config: TokenPilotCodexConfig;
}): Promise<CodexReductionSummary> {
  const { payload, sessionId, config } = params;
  if (!config.modules.reduction || config.proxyMode.pureForward || !Array.isArray(payload?.input)) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      beforeChars: 0,
      afterChars: 0,
      report: [],
      passEffects: [],
      diagnostics: {
        inputItems: Array.isArray(payload?.input) ? payload.input.length : 0,
        toolLikeItems: 0,
        candidateSegments: 0,
        candidateChars: 0,
      },
      skippedReason: !Array.isArray(payload?.input) ? "no_input_array" : "disabled",
    };
  }
  const snapshot = await loadCodexSessionSnapshot(config.stateDir, sessionId);
  // Snapshots written before owners were tracked only have `disclosedReadPaths`; those
  // are ignored rather than carried, because carrying them reproduces the cache miss.
  const disclosedReadOwners = normalizeDisclosedReadOwners(snapshot?.disclosedReadOwners);
  const built = buildTurnContext(payload, sessionId, {
    disclosedReadPaths: carriedDisclosedReadPaths(disclosedReadOwners, presentCallIds(payload)),
  });
  const analyzerInstructions = buildAnalyzerReductionInstructions(built.turnCtx.segments, config);
  const fallbackInstructions = buildCodexFallbackReductionInstructions(built.turnCtx.segments, config);
  const localInstructions = dedupeReductionInstructions([...analyzerInstructions, ...fallbackInstructions]);
  const turnCtx = withReductionPolicy(built.turnCtx, localInstructions);
  const { bindings } = built;
  const totalChars = turnCtx.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  if (turnCtx.segments.length === 0 || totalChars < config.reduction.triggerMinChars) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      beforeChars: totalChars,
      afterChars: totalChars,
      report: [],
      passEffects: [],
      diagnostics: built.diagnostics,
      skippedReason: turnCtx.segments.length === 0 ? "no_candidate_segments" : "below_trigger_min_chars",
    };
  }
  const passOptions = passOptionsFromConfig(config);
  const enabled = enabledPassIds(config);
  const passes = resolveReductionPasses({
    maxToolChars: config.reduction.maxToolChars,
    passOptions,
  }).filter((pass) => pass.phase === "before_call" && enabled.has(pass.id));
  const { turnCtx: reducedCtx, report } = await runReductionBeforeCall({ turnCtx, passes });
  const passEffects = summarizePassEffects(report);
  const changedSegmentIds = new Set<string>();
  const trimmedSegmentIds = new Set<string>();
  for (const entry of report) {
    if (!entry.changed) continue;
    for (const id of entry.touchedSegmentIds ?? []) {
      changedSegmentIds.add(id);
      if (entry.id === "tool_payload_trim") trimmedSegmentIds.add(id);
    }
  }
  if (changedSegmentIds.size === 0) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      beforeChars: totalChars,
      afterChars: totalChars,
      report,
      passEffects,
      diagnostics: built.diagnostics,
      disclosedReadPaths: normalizeDisclosedReadPaths(reducedCtx.metadata?.disclosedReadPaths),
      disclosedReadOwners: recordDisclosedReadOwners(disclosedReadOwners, reducedCtx.metadata?.disclosedReadPaths, built.turnCtx.segments, built.bindings, trimmedSegmentIds),
      skippedReason: "pipeline_no_effect",
    };
  }
  const segmentMap = new Map(reducedCtx.segments.map((segment) => [segment.id, segment]));
  let changedBlocks = 0;
  let savedChars = 0;
  const changedItems = new Set<number>();
  const visualSegments: CodexReductionVisualSegment[] = [];
  for (const binding of bindings) {
    if (!changedSegmentIds.has(binding.segmentId)) continue;
    const segment = segmentMap.get(binding.segmentId);
    if (!segment) continue;
    const item = payload.input[binding.itemIndex];
    if (!item || typeof item !== "object") continue;
    let before = "";
    if (binding.field === "output" || binding.field === "arguments") {
      if (typeof item[binding.field] !== "string" || item[binding.field] === segment.text) continue;
      before = item[binding.field];
      item[binding.field] = segment.text;
    } else if (binding.blockIndex === undefined) {
      if (typeof item.content !== "string" || item.content === segment.text) continue;
      before = item.content;
      item.content = segment.text;
    } else {
      const block = Array.isArray(item.content) ? item.content[binding.blockIndex] : null;
      if (!block || typeof block !== "object" || !binding.blockKey) continue;
      if (typeof block[binding.blockKey] !== "string" || block[binding.blockKey] === segment.text) continue;
      before = block[binding.blockKey];
      block[binding.blockKey] = segment.text;
    }
    changedBlocks += 1;
    changedItems.add(binding.itemIndex);
    const segmentSavedChars = Math.max(0, before.length - segment.text.length);
    savedChars += segmentSavedChars;
    visualSegments.push({
      segmentId: binding.segmentId,
      itemIndex: binding.itemIndex,
      field: binding.field,
      blockIndex: binding.blockIndex,
      blockKey: binding.blockKey,
      toolName: binding.toolName,
      savedChars: segmentSavedChars,
      beforeText: before,
      afterText: segment.text,
      report: report.filter((entry) => entry.changed && entry.touchedSegmentIds?.includes(binding.segmentId)),
    });
  }
  return {
    changedItems: changedItems.size,
    changedBlocks,
    savedChars,
    beforeChars: totalChars,
    afterChars: Math.max(0, totalChars - savedChars),
    report,
    passEffects,
    diagnostics: built.diagnostics,
    visualSegments,
    disclosedReadPaths: normalizeDisclosedReadPaths(reducedCtx.metadata?.disclosedReadPaths),
    disclosedReadOwners: recordDisclosedReadOwners(disclosedReadOwners, reducedCtx.metadata?.disclosedReadPaths, built.turnCtx.segments, built.bindings, trimmedSegmentIds),
  };
}

export async function reduceCodexRequestEnvelope(params: {
  envelope: HostRequestEnvelope;
  codec: HostPayloadCodec;
  config: TokenPilotCodexConfig;
}): Promise<{
  envelope: HostRequestEnvelope;
  summary: CodexReductionSummary;
}> {
  const rawPayload = params.codec.encodeRequest(params.envelope) as any;
  normalizeResponsesInputForUpstream(rawPayload?.input);
  const summary = await applyBeforeCallReductionToPayload({
    payload: rawPayload,
    sessionId: params.envelope.session.sessionId,
    config: params.config,
  });
  if (summary.changedBlocks === 0) {
    return {
      envelope: params.envelope,
      summary,
    };
  }
  return {
    envelope: params.codec.decodeRequest(rawPayload),
    summary,
  };
}
