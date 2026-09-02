/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Readable, Transform } from "node:stream";
import {
  findFirstMessageText,
  prepareObservedBeforeCall,
} from "@lightrsi/product-surface";
import {
  countTextWithPreciseTokens,
  createStaticStatePathResolver,
  type ContextMutationPlan,
  type ContextRewriteEventInput,
  type ContextRewriteEventName,
  type HostRequestEnvelope,
  prepareBeforeCallWithReductionSummary,
  recordUxEffect,
  forwardGatewayRawRequest,
  sendJsonResponse,
  startHostGatewayRuntimeServer,
  setForwardResponseHeaders,
} from "@lightrsi/host-adapter";
import { readContextCleanReceipt } from "@lightrsi/cleaner";
import { configureStatePathResolver } from "@lightrsi/artifact-store";
import type { TokenPilotCodexConfig } from "./config.js";
import {
  defaultCodexConfigPath,
  resolveUpstreamProvider,
} from "./config.js";
import type { TokenPilotCodexLogger } from "./logger.js";
import {
  createCodexSessionResolver,
  createCodexResponsesPayloadCodec,
  extractResponsesInputText,
  syncPayloadFromEnvelope,
} from "./responses-codec.js";
import {
  type CodexReductionSummary,
  reduceCodexRequestEnvelope,
} from "./reduction.js";
import {
  buildStabilityVisualSnapshotFromEnvelopes,
} from "@lightrsi/stabilizer";
import { prepareCodexStablePrefix } from "./stable-prefix.js";
import {
  requestUpstreamResponses,
  requestUpstreamResponsesStream,
  resolveCodexRequestUpstream,
} from "./upstream.js";
import {
  appendCodexRecentTurnBinding,
  indexCodexHostSessionAlias,
  indexCodexPromptCacheKeySession,
  indexCodexResponseSession,
  mergeCodexSessionSnapshot,
  loadCodexSessionSnapshot,
  resolveCodexSessionIdByPromptCacheKey,
  resolveCodexSessionIdByResponseId,
  upsertCodexSessionSnapshot,
} from "./session-state.js";
import { snapshotCodexResponsesStream } from "./stream-observer.js";
import { appendTrace } from "./trace.js";
import { appendCodexCacheAuditRecord, buildCodexCacheAuditSnapshot } from "./cache-audit.js";
import { initializeCodexTokenPilotPreset } from "./preset.js";
import {
  appendCodexRequestJournalEntry,
  appendCodexResponseJournalEntry,
  buildCodexEffectiveHistoryView,
  collectCodexResponseItemsFromStream,
  parseCodexRollout,
  validateCodexRolloutBootstrap,
} from "./context-history/index.js";
import type {
  CodexJournalStatus,
  CodexRequestJournalEntry,
  JsonObject,
} from "./context-history/types.js";
import {
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  acquireCodexRebaseSessionLock,
  buildCodexRebaseRequest,
  codexRebaseEndpointIdentity,
  codexSharedContextRewriteBackend,
  createCodexContextRewriteLifecycle,
  executeCodexProviderContinuationWithReplay,
  executeCodexRebaseWithFallback,
  failPendingCodexRebaseEpochsAfterRestart,
  type CodexLifecyclePreparedPlan,
  resolveCodexProviderContinuationCompatibility,
  resolveCodexTaskStateEstimator,
  revalidateCodexLifecyclePreparedPlan,
  runCodexLifecyclePlanner,
  withCodexRebaseEstimatorAccounting,
  withCodexRebaseReplayAccountingInput,
} from "./context-rewrite/index.js";
import type {
  CodexRebaseCapabilityEvidence,
  CodexMutationPlan,
  CodexRebaseRequestResult,
} from "./context-rewrite/types.js";
import {
  finalizeCodexCleanerAppliedReceipt,
  finalizeCodexCleanerHandoffFailure,
  isCodexCleanerStaleReasonCode,
  prepareCodexCleanerRebase,
  revalidateCodexCleanerPreparedRebase,
  type CodexCleanerPreparedRebase,
} from "./context-cleaner/runtime.js";
import { readCodexCleanerSchedule } from "./context-cleaner/scheduler.js";

export type CodexProxyRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

async function recordCodexUxReduction(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  originalRequestText: string;
  reducedRequestText: string;
}): Promise<void> {
  const beforeCount = countTextWithPreciseTokens(params.model, params.originalRequestText);
  const afterCount = countTextWithPreciseTokens(params.model, params.reducedRequestText);
  const countMode = beforeCount.mode === "openai_tokens" && afterCount.mode === "openai_tokens"
    ? "openai_tokens"
    : "chars";
  const savedCount = countMode === "chars"
    ? Math.max(0, params.originalRequestText.length - params.reducedRequestText.length)
    : Math.max(0, beforeCount.count - afterCount.count);
  if (savedCount <= 0) return;
  await recordUxEffect(params.stateDir, {
    at: new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model,
    countMode,
    beforeCount: countMode === "chars" ? params.originalRequestText.length : beforeCount.count,
    afterCount: countMode === "chars" ? params.reducedRequestText.length : afterCount.count,
    savedCount,
    details: {
      requestSavedCount: savedCount,
    },
  });
}

function normalizeResponsesInputForUpstream(input: any): void {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "function_call" && typeof item.arguments !== "string" && item.arguments != null) {
      item.arguments = JSON.stringify(item.arguments);
    }
    if (type === "function_call_output" && typeof item.output !== "string" && item.output != null) {
      item.output = JSON.stringify(item.output);
    }
  }
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    return asJsonObject(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function codexMutationPlanId(plan: CodexMutationPlan): string {
  return `plan-${hashJson({
    baseRevision: plan.baseRevision ?? null,
    operations: plan.operations,
  })}`;
}

type CodexLifecyclePlan = {
  planId: string;
  operationIds?: string[];
  itemIds?: string[];
  previousRevision?: string;
  nextRevision?: string;
  estimatedSavedChars?: number;
  savedChars?: number;
};

function codexMutationLifecyclePlan(plan: CodexMutationPlan): CodexLifecyclePlan {
  return {
    planId: codexMutationPlanId(plan),
    operationIds: plan.operations.map((operation, index) => (
      `op-${index + 1}-${hashJson({
        type: operation.type,
        stableItemId: operation.stableItemId ?? null,
      })}`
    )),
    itemIds: plan.operations
      .map((operation) => operation.stableItemId)
      .filter((stableItemId): stableItemId is string => Boolean(stableItemId)),
    previousRevision: plan.baseRevision,
  };
}

function codexSharedLifecyclePlan(plan: ContextMutationPlan): CodexLifecyclePlan {
  return {
    planId: plan.planId,
    operationIds: plan.operations.map((operation) => operation.id),
    itemIds: [...new Set(plan.operations.flatMap((operation) => operation.targetItemIds))],
    previousRevision: plan.baseRevision,
    estimatedSavedChars: plan.operations.reduce(
      (total, operation) => total + Math.max(0, operation.estimatedSavedChars ?? 0),
      0,
    ),
  };
}

function allLifecycleOperationsApplied(
  plan: CodexLifecyclePlan,
  appliedOperationIds: readonly string[],
  deferredOperationIds: readonly string[],
): boolean {
  const expected = [...new Set(plan.operationIds ?? [])];
  const applied = [...new Set(appliedOperationIds)];
  return expected.length > 0
    && deferredOperationIds.length === 0
    && applied.length === expected.length
    && expected.every((operationId) => applied.includes(operationId));
}

function codexValidationReasonCodes(error: unknown): string[] {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const reasons: string[] = [];
  if (message.includes("revision_mismatch")) reasons.push("revision_drift");
  if (message.includes("effective_history_incomplete")) reasons.push("effective_history_incomplete");
  if (message.includes("tool_") || message.includes("program_")) reasons.push("tool_closure_unresolved");
  if (message.includes("mutation_target")) reasons.push("mutation_target_unavailable");
  if (message.includes("unsupported_operation")) reasons.push("unsupported_operation");
  return reasons.length > 0 ? reasons : ["rewrite_validation_error"];
}

const SAFE_REWRITE_REASON_CODES = new Set([
  "capability_check_error",
  "capability_journal_untrusted",
  "cooldown_active",
  "encrypted_payload_rejected",
  "epoch_store_error",
  "fallback_original_request",
  "fallback_upstream_error",
  "feature_disabled",
  "history_journal_write_failed",
  "item_schema_unsupported",
  "lifecycle_execution_plan_invalid",
  "lifecycle_execution_registry_load_failed",
  "lifecycle_execution_registry_version_changed",
  "lifecycle_execution_snapshot_changed",
  "native_response_chain_used",
  "provider_replay_probe_required",
  "provider_replay_rejected",
  "rebase_journal_error",
  "rebase_response_failed",
  "rebase_response_id_missing",
  "rebase_response_incomplete",
  "rebase_stream_failed",
  "rebase_stream_incomplete",
  "rebase_stream_malformed",
  "rebase_upstream_error",
  "rebase_upstream_rejected",
  "request_journal_unavailable",
  "response_chain_head_missing",
  "rewrite_configuration_unsupported",
  "rewrite_execution_guard_error",
  "rewrite_execution_guard_rejected",
  "rewrite_execution_guard_unavailable",
  "rewrite_guard_busy",
  "stateless_continuation_succeeded",
]);

function codexSafeRuntimeReason(reason: string | undefined, fallback: string): string {
  return reason && SAFE_REWRITE_REASON_CODES.has(reason) ? reason : fallback;
}

function isLifecycleExecutionDeferredReason(reason: string | undefined): boolean {
  return reason === "lifecycle_execution_plan_invalid"
    || reason === "lifecycle_execution_registry_load_failed"
    || reason === "lifecycle_execution_registry_version_changed"
    || reason === "lifecycle_execution_snapshot_changed";
}

function computeEncodedProviderWirePrefixHash(payload: JsonObject): string | null {
  const input = Array.isArray(payload.input) ? payload.input : [];
  const firstUserIndex = input.findIndex((item: any) => (
    item
    && typeof item === "object"
    && (item.role === "user" || (item.type === "message" && item.role === "user"))
  ));
  const boundary = firstUserIndex >= 0 ? firstUserIndex : input.length;
  return createHash("sha256")
    .update(JSON.stringify({
      v: 2,
      model: payload.model ?? null,
      instructions: payload.instructions ?? null,
      tools: payload.tools ?? null,
      input: input.slice(0, boundary),
    }))
    .digest("hex");
}

function encodedRequestPayload(params: {
  codec: ReturnType<typeof createCodexResponsesPayloadCodec>;
  envelope: HostRequestEnvelope;
  fallback: JsonObject;
}): JsonObject {
  const encoded = asJsonObject(params.codec.encodeRequest(params.envelope));
  return encoded ? cloneJsonObject(encoded) : cloneJsonObject(params.fallback);
}

function responsePayloadStatus(response: JsonObject | undefined): CodexJournalStatus | undefined {
  const status = typeof response?.status === "string" ? response.status.toLowerCase() : undefined;
  if (!status) return undefined;
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "incomplete";
}

function nonStreamRequestStatus(params: {
  httpStatus: number;
  response: JsonObject | undefined;
}): CodexJournalStatus {
  if (params.httpStatus < 200 || params.httpStatus >= 300) return "failed";
  const status = responsePayloadStatus(params.response);
  if (status && status !== "completed") return status;
  return typeof params.response?.id === "string" && params.response.id.trim()
    ? "completed"
    : "incomplete";
}

function startsNewResponseChain(outcome: string | undefined): boolean {
  return outcome === "committed" || outcome === "stateless_replay";
}

function streamRequestStatus(params: {
  httpStatus: number;
  collected: ReturnType<typeof collectCodexResponseItemsFromStream>;
}): CodexJournalStatus {
  if (params.httpStatus < 200 || params.httpStatus >= 300) return "failed";
  if (params.collected.status === "failed") return "failed";
  const sawCompleted = (params.collected.eventTypeCounts["response.completed"] ?? 0) > 0;
  if (params.collected.status !== "completed" || !sawCompleted) return "incomplete";
  return "completed";
}

function truncateJournalError(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
}

function activeMutationPlan(config: TokenPilotCodexConfig): CodexMutationPlan | undefined {
  const plan = config.contextRewrite.mutationPlan;
  return plan && plan.operations.length > 0 ? plan : undefined;
}

function canAttemptCodexRebase(params: {
  config: TokenPilotCodexConfig;
  payload: JsonObject;
  requestEntry?: CodexRequestJournalEntry;
}): boolean {
  return Boolean(
    params.config.contextRewrite.enabled
    && params.config.contextRewrite.mode === "response_chain_rebase"
    && params.config.contextRewrite.failureMode === "bypass"
    && params.config.contextRewrite.retryOriginalRequest
    && params.requestEntry
    && activeMutationPlan(params.config)
    && typeof params.payload.previous_response_id === "string"
    && params.payload.previous_response_id,
  );
}

function upstreamRequestPath(baseUrl: string, inboundPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) {
    return inboundPath.startsWith("/v1") ? inboundPath.slice(3) || "/" : inboundPath;
  }
  return inboundPath.startsWith("/v1") ? inboundPath : `/v1${inboundPath}`;
}

async function forwardPureProviderWire(params: {
  upstream: Awaited<ReturnType<typeof resolveUpstreamProvider>>;
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  pathname: string;
  body: string;
  controller: AbortController;
  stateDir: string;
  requestStartedAt: number;
  bodyReceivedAt: number;
}): Promise<void> {
  const requestId = randomUUID();
  const dispatchAt = performance.now();
  const requestBytes = Buffer.byteLength(params.body, "utf8");
  let responseStatus: number | null = null;
  let headersAt: number | null = null;
  let firstResponseBodyChunkAt: number | null = null;
  let lastResponseBodyChunkAt: number | null = null;
  let downstreamFinishAt: number | null = null;
  let abortSource: string | null = null;
  const traceTiming = () => ({
    pre_upstream_ms: dispatchAt - params.requestStartedAt,
    body_received_ms: params.bodyReceivedAt - params.requestStartedAt,
    upstream_headers_ms: headersAt === null ? null : headersAt - dispatchAt,
    upstream_first_chunk_ms: firstResponseBodyChunkAt === null || headersAt === null
      ? null
      : firstResponseBodyChunkAt - headersAt,
    upstream_stream_ms: firstResponseBodyChunkAt === null || lastResponseBodyChunkAt === null
      ? null
      : lastResponseBodyChunkAt - firstResponseBodyChunkAt,
    downstream_drain_ms: downstreamFinishAt === null
      ? null
      : downstreamFinishAt - (lastResponseBodyChunkAt ?? headersAt ?? dispatchAt),
    total_ms: downstreamFinishAt === null ? null : downstreamFinishAt - params.requestStartedAt,
  });
  const appendTimingTrace = (stage: string, extra: Record<string, unknown> = {}) => {
    void appendTrace(params.stateDir, {
      stage,
      requestId,
      method: params.req.method ?? "POST",
      pathname: params.pathname,
      requestBytes,
      responseStatus,
      hasResponseBody: firstResponseBodyChunkAt !== null,
      ...traceTiming(),
      ...extra,
    }).catch(() => {});
  };
  params.req.once("aborted", () => {
    abortSource = "request_aborted";
    params.controller.abort();
  });
  params.res.once("close", () => {
    abortSource = params.res.writableFinished ? "response_close_after_finish" : "response_close_before_finish";
    params.controller.abort();
  });
  try {
    const authorization = params.req.headers.authorization;
    const inboundAuthorization = Array.isArray(authorization)
      ? authorization.join(", ")
      : authorization;
    const response = await forwardGatewayRawRequest({
      upstream: {
        baseUrl: params.upstream.baseUrl,
        apiKey: params.upstream.apiKey,
        name: params.upstream.name,
        protocol: "custom",
      },
      method: params.req.method ?? "POST",
      requestPath: upstreamRequestPath(params.upstream.baseUrl, params.pathname),
      body: params.body,
      inboundAuthorization,
      inboundHeaders: params.req.headers,
      includeJsonContentType: false,
      signal: params.controller.signal,
    });
    responseStatus = response.status;
    headersAt = performance.now();
    params.res.statusCode = response.status;
    setForwardResponseHeaders(
      params.res,
      Object.fromEntries(response.headers.entries()),
      "application/octet-stream",
    );
    if (!response.body) {
      await new Promise<void>((resolve, reject) => {
        params.res.once("finish", resolve);
        params.res.once("error", reject);
        params.res.end();
      });
      downstreamFinishAt = performance.now();
      appendTimingTrace("pure_forward_timing", { hasResponseBody: false });
      return;
    }
    const observer = new Transform({
      transform(chunk, _encoding, callback) {
        const now = performance.now();
        if (firstResponseBodyChunkAt === null) firstResponseBodyChunkAt = now;
        lastResponseBodyChunkAt = now;
        callback(null, chunk);
      },
    });
    const upstreamStream = Readable.fromWeb(response.body as any);
    await new Promise<void>((resolve, reject) => {
      params.res.once("finish", () => {
        downstreamFinishAt = performance.now();
        resolve();
      });
      params.res.once("error", reject);
      upstreamStream.once("error", reject);
      observer.once("error", reject);
      upstreamStream.pipe(observer).pipe(params.res);
    });
    appendTimingTrace("pure_forward_timing");
  } catch (error) {
    if (params.controller.signal.aborted || params.res.destroyed) {
      appendTimingTrace("pure_forward_cancelled", {
        abortSource,
        responseDestroyed: params.res.destroyed,
        responseWritableEnded: params.res.writableEnded,
        responseWritableFinished: params.res.writableFinished,
      });
      return;
    }
    if (!params.res.headersSent) {
      sendJsonResponse(params.res, 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      params.res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    appendTimingTrace("pure_forward_failed", {
      errorClass: error instanceof Error ? error.name : "unknown",
      abortSource,
      responseDestroyed: params.res.destroyed,
      responseWritableEnded: params.res.writableEnded,
      responseWritableFinished: params.res.writableFinished,
    });
  }
}

export async function startCodexResponsesProxy(params: {
  config: TokenPilotCodexConfig;
  logger: TokenPilotCodexLogger;
  codexConfigPath?: string;
  allowMockFixtureEvidence?: boolean;
}): Promise<CodexProxyRuntime> {
  initializeCodexTokenPilotPreset();
  const { config, logger } = params;
  if (!config.enabled) {
    throw new Error("TokenPilot Codex adapter is disabled by config");
  }
  configureStatePathResolver(createStaticStatePathResolver({
    hostId: "codex",
    displayName: "Codex",
    stateDir: config.stateDir,
    namespaceDir: "tokenpilot",
  }));
  await mkdir(config.stateDir, { recursive: true });
  const upstream = await resolveUpstreamProvider(config, params.codexConfigPath ?? defaultCodexConfigPath());
  const upstreamProviderName = upstream.name ?? config.upstreamProvider ?? "OpenAI";
  const estimatorResolution = resolveCodexTaskStateEstimator({
    config: config.taskStateEstimator,
  });
  const lifecyclePlanningConfigured = estimatorResolution.config.enabled;
  const epochRecoveryBySession = new Map<string, Promise<void>>();

  async function recoverSessionEpochsAfterRestart(sessionId: string): Promise<void> {
    let recovery = epochRecoveryBySession.get(sessionId);
    if (!recovery) {
      recovery = (async () => {
        const sessionLock = await acquireCodexRebaseSessionLock({
          stateDir: config.stateDir,
          sessionId,
        });
        if (!sessionLock) {
          epochRecoveryBySession.delete(sessionId);
          await appendTrace(config.stateDir, {
            stage: "context_rewrite_pending_epoch_recovery_deferred",
            sessionId,
            reason: "session_lock_busy",
          });
          return;
        }
        try {
          const failed = await failPendingCodexRebaseEpochsAfterRestart({
            stateDir: config.stateDir,
            sessionId,
          });
          if (failed.length > 0) {
            await appendTrace(config.stateDir, {
              stage: "context_rewrite_pending_epochs_recovered",
              sessionId,
              failedEpochIds: failed.map((entry) => entry.epochId),
            });
          }
        } finally {
          await sessionLock.release();
        }
      })().catch(async (err) => {
        epochRecoveryBySession.delete(sessionId);
        try {
          await appendTrace(config.stateDir, {
            stage: "context_rewrite_pending_epoch_recovery_failed",
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // Recovery remains best effort so normal proxying can continue.
        }
      });
      epochRecoveryBySession.set(sessionId, recovery);
    }
    await recovery;
  }

  const runtime = await startHostGatewayRuntimeServer({
    port: config.proxyPort,
    requestPath: "/v1/responses",
    basePath: "/v1",
    healthPayload: {
      ok: true,
      adapter: "tokenpilot-codex",
      upstream: upstreamProviderName,
      stateDir: config.stateDir,
    },
    async handleRoute({ req, res, pathname, readBody }) {
      if (!config.proxyMode.pureForward
        || req.method !== "POST"
        || !["/v1/responses", "/v1/chat/completions"].includes(pathname)) {
        return false;
      }
      const requestStartedAt = performance.now();
      const controller = new AbortController();
      const onRequestAborted = () => controller.abort();
      const onResponseClose = () => {
        if (!res.writableFinished) controller.abort();
      };
      req.once("aborted", onRequestAborted);
      res.once("close", onResponseClose);
      try {
        const body = await readBody(controller.signal);
        const bodyReceivedAt = performance.now();
        const requestUpstream = resolveCodexRequestUpstream({
          upstream,
          upstreamProvider: config.upstreamProvider,
          inboundHeaders: req.headers,
        });
        await forwardPureProviderWire({
          upstream: requestUpstream,
          req,
          res,
          pathname,
          body,
          controller,
          stateDir: config.stateDir,
          requestStartedAt,
          bodyReceivedAt,
        });
      } catch (error) {
        if (!controller.signal.aborted && !res.destroyed) throw error;
      } finally {
        req.off("aborted", onRequestAborted);
        res.off("close", onResponseClose);
      }
      return true;
    },
    async handleRequest({ req, res, body }) {
      const requestUpstream = resolveCodexRequestUpstream({
        upstream,
        upstreamProvider: config.upstreamProvider,
        inboundHeaders: req.headers,
      });
      const inboundPayload = JSON.parse(body) as JsonObject;
      normalizeResponsesInputForUpstream(inboundPayload?.input);
      const inboundPromptCacheKey =
        typeof inboundPayload?.prompt_cache_key === "string" ? inboundPayload.prompt_cache_key.trim() : "";
      const mappedPreviousSessionId =
        typeof inboundPayload?.previous_response_id === "string"
          ? await resolveCodexSessionIdByResponseId(config.stateDir, inboundPayload.previous_response_id)
          : undefined;
      const mappedPromptCacheSessionId =
        !mappedPreviousSessionId && inboundPromptCacheKey
          ? await resolveCodexSessionIdByPromptCacheKey(config.stateDir, inboundPromptCacheKey)
          : undefined;
      const codec = createCodexResponsesPayloadCodec(
        createCodexSessionResolver({
          mappedPreviousSessionId: mappedPreviousSessionId ?? mappedPromptCacheSessionId,
        }),
      );
      let envelope = codec.decodeRequest(inboundPayload);
      const inboundModel = envelope.model;
      const model = inboundModel.startsWith("tokenpilot/")
        ? inboundModel.slice("tokenpilot/".length)
        : inboundModel;
      if (model !== inboundModel) {
        envelope = { ...envelope, model };
      }
      const sessionId = envelope.session.sessionId;
      const contextRewriteLifecycle = createCodexContextRewriteLifecycle({
        stateDir: config.stateDir,
        sessionId,
      });
      const emittedContextRewriteStages = new Set<string>();
      let activeLifecyclePlan: CodexLifecyclePlan | undefined;
      const emitContextRewriteStage = async (
        stage: ContextRewriteEventName,
        details: Partial<Omit<
          ContextRewriteEventInput,
          "stage" | "hostId" | "sessionId" | "mode"
        >> = {},
        lifecyclePlan: CodexLifecyclePlan | undefined = activeLifecyclePlan,
      ): Promise<void> => {
        const planId = details.planId ?? lifecyclePlan?.planId;
        const eventKey = `${planId ?? "request"}\0${stage}`;
        if (emittedContextRewriteStages.has(eventKey)) return;
        emittedContextRewriteStages.add(eventKey);
        await contextRewriteLifecycle.append({
          stage,
          ...(lifecyclePlan?.planId ? { planId: lifecyclePlan.planId } : {}),
          ...(lifecyclePlan?.previousRevision
            ? { previousRevision: lifecyclePlan.previousRevision }
            : {}),
          ...(lifecyclePlan?.nextRevision ? { nextRevision: lifecyclePlan.nextRevision } : {}),
          ...(lifecyclePlan?.operationIds ? { operationIds: lifecyclePlan.operationIds } : {}),
          ...(lifecyclePlan?.itemIds ? { itemIds: lifecyclePlan.itemIds } : {}),
          ...(lifecyclePlan?.estimatedSavedChars !== undefined
            ? { estimatedSavedChars: lifecyclePlan.estimatedSavedChars }
            : {}),
          ...(lifecyclePlan?.savedChars !== undefined ? { savedChars: lifecyclePlan.savedChars } : {}),
          ...details,
        });
      };
      await recoverSessionEpochsAfterRestart(sessionId);
      if (inboundPromptCacheKey) {
        if (
          inboundPromptCacheKey !== sessionId
          && !inboundPromptCacheKey.startsWith("lightrsi-codex-")
        ) {
          await mergeCodexSessionSnapshot(config.stateDir, inboundPromptCacheKey, sessionId);
          await indexCodexHostSessionAlias(config.stateDir, inboundPromptCacheKey, sessionId);
        }
        await indexCodexPromptCacheKeySession(config.stateDir, inboundPromptCacheKey, sessionId);
      }
      const originalPayload = encodedRequestPayload({
        codec,
        envelope,
        fallback: inboundPayload,
      });
      normalizeResponsesInputForUpstream(originalPayload?.input);
      const originalRequestText = extractResponsesInputText(originalPayload?.input);

      let requestJournalEntry: CodexRequestJournalEntry | undefined;
      try {
        requestJournalEntry = await appendCodexRequestJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          payload: originalPayload,
          status: "pending",
        });
      } catch (err) {
        await appendTrace(config.stateDir, {
          stage: "context_history_request_journal_failed",
          sessionId,
          model,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let rebaseRequest: CodexRebaseRequestResult | undefined;
      let rebasePlanId: string | undefined;
      let lifecyclePreparedPlan: CodexLifecyclePreparedPlan | undefined;
      let cleanerPreparedRebase: CodexCleanerPreparedRebase | undefined;
      let continuationReplayRequest: CodexRebaseRequestResult | undefined;
      let rebaseAccounting = rebaseRequest?.accounting;
      const cleanerSchedule = await readCodexCleanerSchedule({
        stateDir: config.stateDir,
        sessionId,
      });
      const committedCleanerReceipt = cleanerSchedule.outcome === "committed"
        ? await readContextCleanReceipt({
          stateDir: config.stateDir,
          planId: cleanerSchedule.record.cleanPlanId,
        })
        : undefined;
      const manualCleanerReserved = cleanerSchedule.outcome === "ready"
        || cleanerSchedule.outcome === "bypassed"
        || (cleanerSchedule.outcome === "committed"
          && (committedCleanerReceipt?.bypassed
            || committedCleanerReceipt?.value?.status !== "applied"));
      const mutationPlan = manualCleanerReserved || lifecyclePlanningConfigured
        ? undefined
        : activeMutationPlan(config);
      let effectiveHistoryViewPromise: ReturnType<typeof buildCodexEffectiveHistoryView> | undefined;
      const buildEffectiveHistoryViewForHead = (): ReturnType<typeof buildCodexEffectiveHistoryView> => {
        if (!requestJournalEntry || typeof originalPayload.previous_response_id !== "string") {
          throw new Error("Codex effective history requires a journaled response-chain request");
        }
        return buildCodexEffectiveHistoryView({
          stateDir: config.stateDir,
          sessionId,
          headResponseId: originalPayload.previous_response_id,
          currentRequestId: requestJournalEntry.requestId,
          async rolloutViewBootstrap() {
            const snapshot = await loadCodexSessionSnapshot(config.stateDir, sessionId);
            if (!snapshot?.transcriptPath) return null;
            const rollout = await parseCodexRollout(snapshot.transcriptPath);
            if (!rollout) return null;
            const validation = validateCodexRolloutBootstrap({
              rollout,
              // prompt_cache_key is an upstream cache namespace, not the
              // Codex host session identity used by rollout metadata.
              expectedCodexSessionId: snapshot.codexSessionId,
              snapshotCodexSessionId: snapshot.codexSessionId,
              sourceModel: snapshot.latestModel,
              sourceUpstreamProvider: snapshot.latestUpstreamProvider,
              currentModel: model,
              currentCodexProvider: config.providerName,
              currentUpstreamProvider: upstreamProviderName,
            });
            if (validation.rejectionReason) {
              await appendTrace(config.stateDir, {
                stage: "context_history_rollout_bootstrap_rejected",
                sessionId,
                reason: validation.rejectionReason,
              });
            }
            return validation.view;
          },
        });
      };
      const effectiveHistoryViewForHead = (): ReturnType<typeof buildCodexEffectiveHistoryView> => {
        effectiveHistoryViewPromise ??= buildEffectiveHistoryViewForHead();
        return effectiveHistoryViewPromise;
      };
      const effectiveHistoryForHead = async () => (
        await effectiveHistoryViewForHead()
      ).history;

      if (manualCleanerReserved) {
        if (!config.contextRewrite.enabled) {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["feature_disabled"],
            fallbackUsed: true,
          });
        } else if (!requestJournalEntry) {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["request_journal_unavailable"],
            fallbackUsed: true,
          });
        } else if (typeof originalPayload.previous_response_id !== "string"
          || !originalPayload.previous_response_id) {
          await emitContextRewriteStage("context_rewrite_deferred", {
            reasonCodes: ["response_chain_head_missing"],
          });
        } else if (!config.contextRewrite.retryOriginalRequest
          || config.contextRewrite.mode !== "response_chain_rebase"
          || config.contextRewrite.failureMode !== "bypass") {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["rewrite_configuration_unsupported"],
            fallbackUsed: true,
          });
        } else {
          try {
            const effectiveHistoryView = await effectiveHistoryViewForHead();
            const cleanerResult = await prepareCodexCleanerRebase({
              stateDir: config.stateDir,
              sessionId,
              view: effectiveHistoryView,
              backendRequest: {
                sessionId,
                payload: originalPayload,
                effectiveHistory: effectiveHistoryView.history,
                currentInput: originalPayload.input,
              },
            });
            await appendTrace(config.stateDir, {
              stage: "context_cleaner_runtime_prepared",
              sessionId,
              model,
              outcome: cleanerResult.outcome,
              reasonCodes: cleanerResult.reasonCodes,
            });
            if (cleanerResult.outcome === "ready") {
              cleanerPreparedRebase = cleanerResult.prepared;
              activeLifecyclePlan = codexSharedLifecyclePlan(
                cleanerResult.prepared.execution.mutationPlan,
              );
              rebaseRequest = cleanerResult.prepared.rebaseRequest;
              rebasePlanId = cleanerResult.prepared.execution.mutationPlan.planId;
              rebaseAccounting = cleanerResult.prepared.rebaseRequest.accounting;
              activeLifecyclePlan = {
                ...activeLifecyclePlan,
                previousRevision: rebaseRequest.oldRevision,
                nextRevision: rebaseRequest.rebaseRevision,
                estimatedSavedChars: rebaseRequest.accounting.plannedSavedChars,
                savedChars: rebaseRequest.accounting.actuallyRemovedChars,
              };
              await emitContextRewriteStage("context_rewrite_planned");
            } else {
              await emitContextRewriteStage(
                cleanerResult.outcome === "stale" || cleanerResult.outcome === "reserved"
                  ? "context_rewrite_deferred"
                  : "context_rewrite_bypassed",
                {
                  reasonCodes: cleanerResult.reasonCodes.length > 0
                    ? cleanerResult.reasonCodes
                    : [`cleaner_runtime_${cleanerResult.outcome}`],
                  fallbackUsed: cleanerResult.outcome !== "stale",
                },
              );
            }
          } catch (err) {
            cleanerPreparedRebase = undefined;
            await appendTrace(config.stateDir, {
              stage: "context_cleaner_runtime_failed",
              sessionId,
              model,
              reason: err instanceof Error ? err.message : String(err),
            });
            await emitContextRewriteStage("context_rewrite_bypassed", {
              reasonCodes: ["cleaner_runtime_failed"],
              fallbackUsed: true,
            });
          }
        }
      } else if (lifecyclePlanningConfigured) {
        if (!config.contextRewrite.enabled) {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["feature_disabled"],
            fallbackUsed: true,
          });
        } else if (!requestJournalEntry) {
          await emitContextRewriteStage("context_rewrite_failed", {
            reasonCodes: ["request_journal_unavailable"],
            errorCategory: "history_journal_write_failed",
            fallbackUsed: true,
          });
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["fallback_original_request"],
            fallbackUsed: true,
          });
        } else if (typeof originalPayload.previous_response_id !== "string"
          || !originalPayload.previous_response_id) {
          await emitContextRewriteStage("context_rewrite_deferred", {
            reasonCodes: ["response_chain_head_missing"],
          });
        } else if (!config.contextRewrite.retryOriginalRequest
          || config.contextRewrite.mode !== "response_chain_rebase"
          || config.contextRewrite.failureMode !== "bypass") {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["rewrite_configuration_unsupported"],
            fallbackUsed: true,
          });
        } else if (!estimatorResolution.estimator) {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["estimator_missing"],
            fallbackUsed: true,
          });
        } else {
          try {
            const effectiveHistoryView = await effectiveHistoryViewForHead();
            const lifecycleResult = await runCodexLifecyclePlanner({
              stateDir: config.stateDir,
              sessionId,
              view: effectiveHistoryView,
              backendRequest: {
                sessionId,
                payload: originalPayload,
                effectiveHistory: effectiveHistoryView.history,
                currentInput: originalPayload.input,
              },
              estimator: estimatorResolution.estimator,
              config: {
                enabled: true,
                batchTurns: estimatorResolution.config.batchTurns,
                evictionEnabled: true,
                evictionPolicy: "model_scored",
                evictionMinBlockChars: 256,
              },
              createdAt: new Date().toISOString(),
              expectedCurrentRequest: requestJournalEntry,
              inputMode: estimatorResolution.config.inputMode,
              sourcePresetId: "tokenpilot",
            });
            await appendTrace(config.stateDir, {
              stage: "context_rewrite_lifecycle_planner_completed",
              sessionId,
              model,
              status: lifecycleResult.status,
              reasonCodes: lifecycleResult.reasonCodes,
              attemptedEstimator: lifecycleResult.attemptedEstimator,
              registryPersisted: lifecycleResult.registryPersisted,
              registryChanged: lifecycleResult.registryChanged,
              registryVersionBefore: lifecycleResult.registryVersionBefore ?? null,
              registryVersionAfter: lifecycleResult.registryVersionAfter ?? null,
              estimatorUsage: lifecycleResult.estimatorUsage ?? null,
            });
            if (lifecycleResult.preparedPlan) {
              activeLifecyclePlan = codexSharedLifecyclePlan(lifecycleResult.preparedPlan.plan);
              await emitContextRewriteStage("context_rewrite_planned");
              const applied = await codexSharedContextRewriteBackend.apply({
                snapshot: lifecycleResult.preparedPlan.snapshot,
                plan: lifecycleResult.preparedPlan.plan,
                request: lifecycleResult.preparedPlan.backendRequest,
              });
              const details = applied.result.details;
              if (
                applied.result.applied
                && details?.rebasePrepared
                && allLifecycleOperationsApplied(
                  activeLifecyclePlan,
                  applied.result.appliedOperationIds,
                  applied.result.deferredOperationIds,
                )
              ) {
                const accounting = withCodexRebaseEstimatorAccounting(
                  details.accounting,
                  lifecycleResult.estimatorUsage,
                );
                lifecyclePreparedPlan = lifecycleResult.preparedPlan;
                rebaseRequest = {
                  payload: applied.request.payload,
                  oldRevision: applied.result.previousRevision,
                  rebaseRevision: applied.result.nextRevision,
                  accounting,
                };
                rebasePlanId = lifecycleResult.preparedPlan.plan.planId;
                activeLifecyclePlan = {
                  ...activeLifecyclePlan,
                  previousRevision: rebaseRequest.oldRevision,
                  nextRevision: rebaseRequest.rebaseRevision,
                  estimatedSavedChars: rebaseRequest.accounting.plannedSavedChars,
                  savedChars: rebaseRequest.accounting.actuallyRemovedChars,
                };
              } else {
                lifecyclePreparedPlan = undefined;
                await emitContextRewriteStage("context_rewrite_deferred", {
                  reasonCodes: ["lifecycle_runner_plan_invalid"],
                  deferredOperationIds: activeLifecyclePlan.operationIds,
                });
              }
            } else {
              lifecyclePreparedPlan = undefined;
              activeLifecyclePlan = undefined;
              await emitContextRewriteStage(
                lifecycleResult.status === "bypassed"
                  ? "context_rewrite_bypassed"
                  : "context_rewrite_deferred",
                {
                  reasonCodes: lifecycleResult.reasonCodes,
                  ...(lifecycleResult.status === "bypassed" ? { fallbackUsed: true } : {}),
                },
              );
            }
          } catch (err) {
            lifecyclePreparedPlan = undefined;
            activeLifecyclePlan = undefined;
            await appendTrace(config.stateDir, {
              stage: "context_rewrite_lifecycle_planning_failed",
              sessionId,
              model,
              reason: err instanceof Error ? err.message : String(err),
            });
            await emitContextRewriteStage("context_rewrite_bypassed", {
              reasonCodes: ["lifecycle_runner_failed"],
              fallbackUsed: true,
            });
          }
        }
      } else if (mutationPlan) {
        activeLifecyclePlan = codexMutationLifecyclePlan(mutationPlan);
        await emitContextRewriteStage("context_rewrite_planned");
        if (!config.contextRewrite.enabled) {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["feature_disabled"],
            fallbackUsed: true,
          });
        } else if (!requestJournalEntry) {
          await emitContextRewriteStage("context_rewrite_failed", {
            reasonCodes: ["request_journal_unavailable"],
            errorCategory: "history_journal_write_failed",
            fallbackUsed: true,
          });
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["fallback_original_request"],
            fallbackUsed: true,
          });
        } else if (typeof originalPayload.previous_response_id !== "string"
          || !originalPayload.previous_response_id) {
          await emitContextRewriteStage("context_rewrite_deferred", {
            reasonCodes: ["response_chain_head_missing"],
          });
        } else if (!config.contextRewrite.retryOriginalRequest
          || config.contextRewrite.mode !== "response_chain_rebase"
          || config.contextRewrite.failureMode !== "bypass") {
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["rewrite_configuration_unsupported"],
            fallbackUsed: true,
          });
        }
      }
      if (canAttemptCodexRebase({ config, payload: originalPayload, requestEntry: requestJournalEntry })
        && mutationPlan
        && requestJournalEntry) {
        const planId = activeLifecyclePlan?.planId ?? codexMutationPlanId(mutationPlan);
        try {
          const effectiveHistory = await effectiveHistoryForHead();
          rebaseRequest = buildCodexRebaseRequest({
            sessionId,
            planId,
            baseRevision: mutationPlan.baseRevision ?? effectiveHistory.revision,
            originalPayload,
            effectiveHistory,
            currentInput: originalPayload.input,
            mutationPlan,
          });
          rebasePlanId = planId;
          activeLifecyclePlan = {
            ...(activeLifecyclePlan ?? { planId }),
            previousRevision: rebaseRequest.oldRevision,
            nextRevision: rebaseRequest.rebaseRevision,
            estimatedSavedChars: rebaseRequest.accounting.plannedSavedChars,
            savedChars: rebaseRequest.accounting.actuallyRemovedChars,
          };
        } catch (err) {
          await appendTrace(config.stateDir, {
            stage: "context_rewrite_rebase_deferred",
            sessionId,
            model,
            reason: err instanceof Error ? err.message : String(err),
          });
          await emitContextRewriteStage("context_rewrite_deferred", {
            reasonCodes: codexValidationReasonCodes(err),
            deferredOperationIds: activeLifecyclePlan?.operationIds,
          });
        }
      }

      const canPrepareContinuationReplay = !rebaseRequest
        && !manualCleanerReserved
        && requestJournalEntry
        && typeof originalPayload.previous_response_id === "string"
        && config.contextRewrite.providerCompatibilityProbe !== "disabled";
      let continuationLifecyclePlanned = false;
      if (canPrepareContinuationReplay) {
        continuationLifecyclePlanned = true;
        activeLifecyclePlan = { planId: "provider-continuation-replay" };
        await emitContextRewriteStage("context_rewrite_planned");
        try {
          const effectiveHistory = await effectiveHistoryForHead();
          continuationReplayRequest = buildCodexRebaseRequest({
            sessionId,
            planId: "provider-continuation-replay",
            baseRevision: effectiveHistory.revision,
            originalPayload,
            effectiveHistory,
            currentInput: originalPayload.input,
            mutationPlan: { baseRevision: effectiveHistory.revision, operations: [] },
          });
          activeLifecyclePlan = {
            planId: "provider-continuation-replay",
            previousRevision: continuationReplayRequest.oldRevision,
            nextRevision: continuationReplayRequest.rebaseRevision,
            estimatedSavedChars: continuationReplayRequest.accounting.plannedSavedChars,
            savedChars: continuationReplayRequest.accounting.actuallyRemovedChars,
          };
        } catch (err) {
          await appendTrace(config.stateDir, {
            stage: "provider_continuation_replay_deferred",
            sessionId,
            model,
            reason: err instanceof Error ? err.message : String(err),
          });
          await emitContextRewriteStage("context_rewrite_deferred", {
            reasonCodes: codexValidationReasonCodes(err),
          });
        }
      }
      if (!config.contextRewrite.enabled && !mutationPlan && !continuationLifecyclePlanned) {
        activeLifecyclePlan = undefined;
        await emitContextRewriteStage("context_rewrite_bypassed", {
          reasonCodes: ["feature_disabled"],
          fallbackUsed: true,
        });
      }

      const payload = cloneJsonObject(rebaseRequest?.payload ?? originalPayload);
      normalizeResponsesInputForUpstream(payload?.input);
      const preparedEnvelope = rebaseRequest ? codec.decodeRequest(payload) : envelope;
      const prepareStablePrefixForCodex = (nextEnvelope: HostRequestEnvelope) => (
        prepareCodexStablePrefix(nextEnvelope, config)
      );
      const applyBeforeCallReductionForCodex = async (args: {
        envelope: HostRequestEnvelope;
        codec: any;
      }) => reduceCodexRequestEnvelope({
        envelope: args.envelope,
        codec: args.codec,
        config,
      });
      const prepared = await prepareObservedBeforeCall<CodexReductionSummary>({
        envelope: preparedEnvelope,
        codec,
        config: { mode: "normal" },
        prepareStablePrefix: prepareStablePrefixForCodex,
        applyBeforeCallReduction: applyBeforeCallReductionForCodex,
        observability: {
          stateDir: config.stateDir,
          sessionId,
          model,
          recordUxEffectNow: false,
          buildStability({ originalEnvelope, prepared }) {
            return prepared.diagnostics.stablePrefixApplied === true
              ? buildStabilityVisualSnapshotFromEnvelopes({
                sessionId,
                model,
                upstreamModel: model,
                originalEnvelope,
                preparedEnvelope: prepared.envelope,
                dynamicContextTarget: config.hooks.dynamicContextTarget,
                getDeveloperText(envelope) {
                  return findFirstMessageText(envelope, (message: any) => {
                    if (!message || typeof message !== "object" || message.role !== "system") return false;
                    const originalRole = message.metadata?.__codexOriginalRole;
                    return originalRole === "developer" || originalRole === "system";
                  });
                },
              })
              : undefined;
          },
          buildReduction(reductionSummary) {
            return reductionSummary.savedChars > 0
              ? {
                countMode: "chars",
                beforeCount: reductionSummary.beforeChars,
                afterCount: reductionSummary.afterChars,
                savedCount: reductionSummary.savedChars,
                details: {
                  requestSavedCount: reductionSummary.savedChars,
                },
                segments: reductionSummary.visualSegments ?? [],
              }
              : undefined;
          },
        },
      });
      const reductionSummary = prepared.reductionSummary;
      syncPayloadFromEnvelope(payload, prepared.envelope, codec);
      normalizeResponsesInputForUpstream(payload?.input);
      if (rebaseRequest) {
        rebaseAccounting = withCodexRebaseReplayAccountingInput(rebaseRequest.accounting, payload.input);
      }
      const fallbackPayload = cloneJsonObject(originalPayload);
      if (rebaseRequest) {
        const fallbackPrepared = await prepareBeforeCallWithReductionSummary<CodexReductionSummary>({
          envelope,
          codec,
          config: { mode: "normal" },
          prepareStablePrefix: prepareStablePrefixForCodex,
          applyBeforeCallReduction: applyBeforeCallReductionForCodex,
        });
        syncPayloadFromEnvelope(fallbackPayload, fallbackPrepared.envelope, codec);
        normalizeResponsesInputForUpstream(fallbackPayload?.input);
      }
      let continuationReplayPayload: JsonObject | undefined;
      if (continuationReplayRequest) {
        continuationReplayPayload = cloneJsonObject(continuationReplayRequest.payload);
        const continuationEnvelope = codec.decodeRequest(continuationReplayPayload);
        const continuationPrepared = await prepareBeforeCallWithReductionSummary<CodexReductionSummary>({
          envelope: continuationEnvelope,
          codec,
          config: { mode: "normal" },
          prepareStablePrefix: prepareStablePrefixForCodex,
          applyBeforeCallReduction: applyBeforeCallReductionForCodex,
        });
        syncPayloadFromEnvelope(continuationReplayPayload, continuationPrepared.envelope, codec);
        normalizeResponsesInputForUpstream(continuationReplayPayload?.input);
      }
      const requestText = extractResponsesInputText(payload?.input);
      const cacheAuditSnapshot = buildCodexCacheAuditSnapshot({
        envelope: prepared.envelope,
        sessionId,
        model,
        stream: payload.stream === true,
        originalRequestPromptCacheKey:
          typeof prepared.envelope.metadata?.originalPromptCacheKey === "string"
            ? prepared.envelope.metadata.originalPromptCacheKey
            : null,
        requestPromptCacheKey:
          typeof prepared.envelope.metadata?.promptCacheKey === "string"
            ? prepared.envelope.metadata.promptCacheKey
            : typeof prepared.envelope.metadata?.frameworkStablePromptCacheKey === "string"
              ? prepared.envelope.metadata.frameworkStablePromptCacheKey
              : null,
        providerWirePrefixHash:
          computeEncodedProviderWirePrefixHash(payload)
          ?? (typeof prepared.envelope.metadata?.providerWirePrefixHash === "string"
            ? prepared.envelope.metadata.providerWirePrefixHash
            : null),
        cacheFamilyId:
          typeof prepared.envelope.metadata?.cacheFamilyId === "string"
            ? prepared.envelope.metadata.cacheFamilyId
            : null,
      });
      await appendTrace(config.stateDir, {
        stage: "proxy_before_call",
        sessionId,
        model,
        stream: payload.stream === true,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        recoveryInjected: prepared.diagnostics.recoveryInjected === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        reductionChangedItems: reductionSummary?.changedItems ?? 0,
        reductionChangedBlocks: reductionSummary?.changedBlocks ?? 0,
        reductionSkippedReason: reductionSummary?.skippedReason ?? null,
        reductionPassEffects: reductionSummary?.passEffects ?? [],
        promptCacheKey: prepared.envelope.metadata?.promptCacheKey ?? null,
        contextRewriteEnabled: config.contextRewrite.enabled,
        contextRewritePlanned: Boolean(rebaseRequest),
        providerContinuationReplayPrepared: Boolean(continuationReplayPayload),
      });

      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const sendUpstream = (nextPayload: JsonObject) => requestUpstreamResponses({
        upstream: requestUpstream,
        payload: nextPayload,
        inboundAuthorization: authorization,
        inboundHeaders: req.headers,
        stateDir: config.stateDir,
      });
      const acceptedEvidence: CodexRebaseCapabilityEvidence[] = params.allowMockFixtureEvidence
        ? ["real_provider", "mock_fixture"]
        : ["real_provider"];
      const capabilityStore = {
        stateDir: config.stateDir,
        provider: upstreamProviderName,
        model,
        wireMode: CODEX_REBASE_WIRE_MODE,
        apiVersion: CODEX_REBASE_API_VERSION,
        endpointId: codexRebaseEndpointIdentity(requestUpstream.baseUrl),
        itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
        probeMode: config.contextRewrite.providerCompatibilityProbe,
        acceptedEvidence,
        evidenceSource: params.allowMockFixtureEvidence ? "mock_fixture" : "real_provider",
      } as const;
      const nativeStreamChainVerified = payload.stream === true
        && continuationReplayPayload
        && await resolveCodexProviderContinuationCompatibility({
          chainedPayload: payload,
          capabilityStore,
        }) === "verified_supported";
      let contextRewriteOutcome: string | undefined = nativeStreamChainVerified
        ? "chained"
        : undefined;
      let contextRewriteValidationPassed = false;
      let contextRewriteFailureReason: string | undefined;
      let contextRewriteDeferredReason: string | undefined;
      let contextRewriteBypassReason: string | undefined;
      let contextHistoryJournalPersisted = false;
      if (nativeStreamChainVerified) contextRewriteValidationPassed = true;
      const committedContextInputItems = (): JsonObject[] | undefined => {
        const source = contextRewriteOutcome === "stateless_replay"
          ? continuationReplayPayload
          : payload;
        return Array.isArray(source?.input) ? source.input as JsonObject[] : undefined;
      };

      const finalizeContextRewriteLifecycle = async (
        requestStatus: CodexJournalStatus,
      ): Promise<void> => {
        if (!activeLifecyclePlan || !contextRewriteOutcome) return;
        const responseCompleted = requestStatus === "completed";
        const journalReady = contextHistoryJournalPersisted;
        if (contextRewriteOutcome === "committed" || contextRewriteOutcome === "stateless_replay") {
          if (!responseCompleted || !journalReady) {
            await emitContextRewriteStage("context_rewrite_failed", {
              reasonCodes: [journalReady
                ? "rebase_response_incomplete"
                : "history_journal_write_failed"],
              errorCategory: journalReady
                ? "provider_response_incomplete"
                : "history_journal_write_failed",
              fallbackUsed: false,
            });
            return;
          }
          await emitContextRewriteStage("context_rewrite_validated", {
            applicableOperationIds: activeLifecyclePlan.operationIds,
          });
          await emitContextRewriteStage("context_rewrite_applied", {
            applicableOperationIds: activeLifecyclePlan.operationIds,
            fallbackUsed: false,
          });
          return;
        }
        if (contextRewriteOutcome === "chained") {
          if (!responseCompleted || !journalReady) {
            await emitContextRewriteStage("context_rewrite_failed", {
              reasonCodes: [journalReady
                ? "rebase_response_incomplete"
                : "history_journal_write_failed"],
              errorCategory: journalReady
                ? "provider_response_incomplete"
                : "history_journal_write_failed",
              fallbackUsed: false,
            });
            return;
          }
          await emitContextRewriteStage("context_rewrite_validated");
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: ["native_response_chain_used"],
            fallbackUsed: false,
          });
          return;
        }
        if (contextRewriteOutcome === "bypassed") {
          if (!responseCompleted || !journalReady) {
            await emitContextRewriteStage("context_rewrite_failed", {
              reasonCodes: [journalReady
                ? "rebase_response_incomplete"
                : "history_journal_write_failed"],
              errorCategory: journalReady
                ? "provider_response_incomplete"
                : "history_journal_write_failed",
              fallbackUsed: true,
            });
            return;
          }
          if (contextRewriteValidationPassed) {
            await emitContextRewriteStage("context_rewrite_validated", {
              applicableOperationIds: activeLifecyclePlan.operationIds,
            });
          }
          if (contextRewriteFailureReason) {
            await emitContextRewriteStage("context_rewrite_failed", {
              reasonCodes: [codexSafeRuntimeReason(
                contextRewriteFailureReason,
                "rebase_upstream_rejected",
              )],
              errorCategory: "rewrite_apply_failed",
              fallbackUsed: true,
            });
          } else if (contextRewriteDeferredReason) {
            await emitContextRewriteStage("context_rewrite_deferred", {
              reasonCodes: [codexSafeRuntimeReason(
                contextRewriteDeferredReason,
                "provider_replay_probe_required",
              )],
              deferredOperationIds: activeLifecyclePlan.operationIds,
            });
          }
          await emitContextRewriteStage("context_rewrite_bypassed", {
            reasonCodes: [codexSafeRuntimeReason(
              contextRewriteBypassReason,
              "fallback_original_request",
            )],
            fallbackUsed: true,
          });
          return;
        }
        if (contextRewriteValidationPassed) {
          await emitContextRewriteStage("context_rewrite_validated", {
            applicableOperationIds: activeLifecyclePlan.operationIds,
          });
        }
        await emitContextRewriteStage("context_rewrite_failed", {
          reasonCodes: [codexSafeRuntimeReason(
            contextRewriteFailureReason,
            "rebase_upstream_error",
          )],
          errorCategory: "provider_request_failed",
          fallbackUsed: contextRewriteValidationPassed,
        });
      };

      const appendStreamContextHistory = async (paramsForJournal: {
        status: number;
        rawStreamText: string;
        committed: boolean;
      }): Promise<void> => {
        if (!requestJournalEntry) return;
        const collected = collectCodexResponseItemsFromStream(paramsForJournal.rawStreamText);
        const status = streamRequestStatus({
          httpStatus: paramsForJournal.status,
          collected,
        });
        const error = status === "failed" ? truncateJournalError(paramsForJournal.rawStreamText) : undefined;
        await appendCodexResponseJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          rawStreamText: paramsForJournal.rawStreamText,
          previousResponseId: paramsForJournal.committed
            ? null
            : typeof originalPayload.previous_response_id === "string"
              ? originalPayload.previous_response_id
              : null,
          status,
          error,
        });
        await appendCodexRequestJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          payload: originalPayload,
          committedInputItems: paramsForJournal.committed
            ? committedContextInputItems()
            : undefined,
          status,
          error,
        });
        contextHistoryJournalPersisted = true;
      };

      const appendNonStreamContextHistory = async (paramsForJournal: {
        response: ReturnType<typeof parseJsonObject>;
        responseText: string;
        httpStatus: number;
        committed: boolean;
      }): Promise<void> => {
        if (!requestJournalEntry) return;
        const status = nonStreamRequestStatus({
          httpStatus: paramsForJournal.httpStatus,
          response: paramsForJournal.response,
        });
        const error = status === "failed" ? truncateJournalError(paramsForJournal.responseText) : undefined;
        await appendCodexResponseJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          response: paramsForJournal.response,
          previousResponseId: paramsForJournal.committed
            ? null
            : typeof originalPayload.previous_response_id === "string"
              ? originalPayload.previous_response_id
              : null,
          status,
          error,
        });
        await appendCodexRequestJournalEntry({
          stateDir: config.stateDir,
          sessionId,
          requestId: requestJournalEntry.requestId,
          payload: originalPayload,
          committedInputItems: paramsForJournal.committed
            ? committedContextInputItems()
            : undefined,
          status,
          error,
        });
        contextHistoryJournalPersisted = true;
      };

      const persistAcceptedRebaseResponse = async (paramsForCommit: {
        response: { status: number; text: string };
        newResponseId: string;
      }): Promise<void> => {
        if (payload.stream === true) {
          await appendStreamContextHistory({
            status: paramsForCommit.response.status,
            rawStreamText: paramsForCommit.response.text,
            committed: true,
          });
        } else {
          await appendNonStreamContextHistory({
            response: parseJsonObject(paramsForCommit.response.text),
            responseText: paramsForCommit.response.text,
            httpStatus: paramsForCommit.response.status,
            committed: true,
          });
        }
        await indexCodexResponseSession(config.stateDir, paramsForCommit.newResponseId, sessionId);
        contextHistoryJournalPersisted = true;
      };

      const sendRebasedOrCurrentPayload = async () => {
        if (rebaseRequest && requestJournalEntry && rebasePlanId) {
          try {
            const result = await executeCodexRebaseWithFallback({
              sessionId,
              planId: rebasePlanId,
              epochId: `epoch-${requestJournalEntry.requestId}`,
              originalPayload: fallbackPayload,
              rebasedPayload: payload,
              sendUpstream,
              beforeCommit: persistAcceptedRebaseResponse,
              accounting: rebaseAccounting,
              epochStore: {
                stateDir: config.stateDir,
                oldPreviousResponseId: String(originalPayload.previous_response_id),
                oldRevision: rebaseRequest.oldRevision,
                newRevision: rebaseRequest.rebaseRevision,
              },
              cooldownStore: {
                stateDir: config.stateDir,
                cooldownMs: config.contextRewrite.cooldownMs,
              },
              capabilityStore,
              executionGuard: cleanerPreparedRebase
                ? async () => {
                    let currentView;
                    try {
                      currentView = await buildEffectiveHistoryViewForHead();
                    } catch {
                      return {
                        allowed: false,
                        reason: "cleaner_runtime_snapshot_changed",
                      };
                    }
                    const handoff = await revalidateCodexCleanerPreparedRebase({
                      stateDir: config.stateDir,
                      sessionId,
                      prepared: cleanerPreparedRebase,
                      view: currentView,
                      backendRequest: {
                        sessionId,
                        payload: originalPayload,
                        effectiveHistory: currentView.history,
                        currentInput: originalPayload.input,
                      },
                    });
                    return {
                      allowed: handoff.valid,
                      reason: handoff.reasonCodes[0],
                    };
                  }
                : lifecyclePreparedPlan
                ? async () => {
                    let currentView;
                    try {
                      currentView = await buildEffectiveHistoryViewForHead();
                    } catch {
                      return {
                        allowed: false,
                        reason: "lifecycle_execution_snapshot_changed",
                      };
                    }
                    const handoff = await revalidateCodexLifecyclePreparedPlan({
                      stateDir: config.stateDir,
                      sessionId,
                      preparedPlan: lifecyclePreparedPlan,
                      view: currentView,
                      backendRequest: {
                        sessionId,
                        payload: originalPayload,
                        effectiveHistory: currentView.history,
                        currentInput: originalPayload.input,
                      },
                    });
                    return {
                      allowed: handoff.valid,
                      reason: handoff.reasonCodes[0],
                    };
                  }
                : undefined,
            });
            if (result.outcome === "committed"
              && cleanerPreparedRebase
              && result.epoch?.status === "committed") {
              const finalized = await finalizeCodexCleanerAppliedReceipt({
                stateDir: config.stateDir,
                sessionId,
                prepared: cleanerPreparedRebase,
                epoch: result.epoch,
              });
              await appendTrace(config.stateDir, {
                stage: "context_cleaner_applied_receipt_finalized",
                sessionId,
                model,
                outcome: finalized.outcome,
                reasonCodes: finalized.reasonCodes,
              });
              if (finalized.outcome !== "applied") {
                await appendTrace(config.stateDir, {
                  stage: "context_cleaner_applied_receipt_failed",
                  sessionId,
                  model,
                  reasonCodes: finalized.reasonCodes,
                });
              }
            }
            if (result.outcome === "bypassed"
              && cleanerPreparedRebase
              && isCodexCleanerStaleReasonCode(result.reason)) {
              const finalized = await finalizeCodexCleanerHandoffFailure({
                stateDir: config.stateDir,
                sessionId,
                prepared: cleanerPreparedRebase,
                reasonCodes: [result.reason!],
              });
              await appendTrace(config.stateDir, {
                stage: "context_cleaner_handoff_finalized",
                sessionId,
                model,
                outcome: finalized.outcome,
                reasonCodes: finalized.reasonCodes,
              });
            }
            contextRewriteOutcome = result.outcome;
            contextRewriteValidationPassed = Boolean(result.rebaseResponse)
              || result.outcome === "committed";
            if (result.outcome !== "committed") contextHistoryJournalPersisted = false;
            if (result.outcome === "bypassed") {
              if (result.rebaseResponse) {
                contextRewriteFailureReason = result.reason
                  ?? result.cooldown?.reason
                  ?? result.capability?.reason
                  ?? "rebase_upstream_rejected";
                contextRewriteBypassReason = "fallback_original_request";
              } else if (result.capability?.reason === "provider_replay_probe_required") {
                contextRewriteDeferredReason = result.capability.reason;
                contextRewriteBypassReason = "fallback_original_request";
              } else if (result.capability?.reason) {
                contextRewriteBypassReason = result.capability.reason;
              } else if (result.reason === "cooldown_active") {
                contextRewriteBypassReason = "cooldown_active";
              } else if (result.reason === "rewrite_guard_busy") {
                contextRewriteBypassReason = "rewrite_guard_busy";
              } else if (isLifecycleExecutionDeferredReason(result.reason)) {
                contextRewriteDeferredReason = result.reason;
                contextRewriteBypassReason = "fallback_original_request";
              } else if (result.reason) {
                contextRewriteFailureReason = result.reason;
                contextRewriteBypassReason = "fallback_original_request";
              } else if (result.cooldown) {
                contextRewriteBypassReason = "cooldown_active";
              } else {
                contextRewriteBypassReason = "rewrite_guard_busy";
              }
            } else if (result.outcome === "failed") {
              contextRewriteFailureReason = result.reason
                ?? result.cooldown?.reason
                ?? result.capability?.reason
                ?? "rebase_upstream_error";
            }
            return result.response;
          } catch (error) {
            contextRewriteOutcome = "failed";
            contextRewriteFailureReason = "rebase_upstream_error";
            await emitContextRewriteStage("context_rewrite_failed", {
              reasonCodes: ["rebase_upstream_error"],
              errorCategory: "provider_request_failed",
              fallbackUsed: true,
            });
            throw error;
          }
        }
        if (continuationReplayPayload) {
          try {
            const result = await executeCodexProviderContinuationWithReplay({
              chainedPayload: payload,
              statelessReplayPayload: continuationReplayPayload,
              sendUpstream,
              capabilityStore,
            });
            contextRewriteOutcome = result.outcome;
            contextRewriteValidationPassed = result.outcome !== "failed";
            if (result.outcome === "failed") {
              contextRewriteFailureReason = "rebase_upstream_error";
            }
            return result.response;
          } catch (error) {
            contextRewriteOutcome = "failed";
            contextRewriteFailureReason = "rebase_upstream_error";
            await emitContextRewriteStage("context_rewrite_failed", {
              reasonCodes: ["rebase_upstream_error"],
              errorCategory: "provider_request_failed",
              fallbackUsed: false,
            });
            throw error;
          }
        }
        return sendUpstream(payload);
      };
      const recordStreamResponse = async (paramsForRecord: {
        status: number;
        rawStreamText: string;
      }): Promise<void> => {
        const snapshot = snapshotCodexResponsesStream(paramsForRecord.rawStreamText);
        const logicalPreviousResponseId = startsNewResponseChain(contextRewriteOutcome)
          ? undefined
          : typeof originalPayload.previous_response_id === "string"
            ? originalPayload.previous_response_id
            : undefined;
        const collected = collectCodexResponseItemsFromStream(paramsForRecord.rawStreamText);
        const requestStatus = streamRequestStatus({
          httpStatus: paramsForRecord.status,
          collected,
        });
        await recordCodexUxReduction({
          stateDir: config.stateDir,
          sessionId,
          model,
          originalRequestText,
          reducedRequestText: requestText,
        });
        await appendCodexCacheAuditRecord({
          stateDir: config.stateDir,
          snapshot: cacheAuditSnapshot,
          responsePromptCacheKey: snapshot.responsePromptCacheKey ?? null,
          usage: snapshot.usage ?? null,
          status: paramsForRecord.status,
        });
        if (requestJournalEntry && !contextHistoryJournalPersisted) {
          try {
            await appendStreamContextHistory({
              status: paramsForRecord.status,
              rawStreamText: paramsForRecord.rawStreamText,
              committed: startsNewResponseChain(contextRewriteOutcome),
            });
          } catch (err) {
            await appendTrace(config.stateDir, {
              stage: "context_history_response_journal_failed",
              sessionId,
              model,
              stream: true,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await finalizeContextRewriteLifecycle(requestStatus);
        await appendTrace(config.stateDir, {
          stage: "proxy_after_call",
          sessionId,
          model,
          status: paramsForRecord.status,
          stream: true,
          completed: requestStatus === "completed",
          streamStatus: collected.status,
          malformedEventCount: collected.malformedEventCount,
          responseChars: paramsForRecord.rawStreamText.length,
          assistantChars: snapshot.assistantText.length,
          responseId: snapshot.responseId ?? null,
          previousResponseId: logicalPreviousResponseId ?? null,
          contextRewriteOutcome: contextRewriteOutcome ?? null,
        });
        await upsertCodexSessionSnapshot(config.stateDir, sessionId, {
          latestResponseId: snapshot.responseId,
          previousResponseId: logicalPreviousResponseId,
          latestModel: model,
          latestUpstreamProvider: upstreamProviderName,
          disclosedReadPaths: reductionSummary?.disclosedReadPaths,
        });
        if (typeof snapshot.responseId === "string" && snapshot.responseId) {
          await indexCodexResponseSession(config.stateDir, snapshot.responseId, sessionId);
        }
        await appendCodexRecentTurnBinding(config.stateDir, {
          sessionId,
          responseId: snapshot.responseId,
          previousResponseId: logicalPreviousResponseId,
          model,
          requestChars: requestText.length,
          responseChars: paramsForRecord.rawStreamText.length,
          assistantChars: snapshot.assistantText.length,
          stream: true,
          updatedAt: new Date().toISOString(),
        });
      };
      if (payload.stream === true) {
        if ((rebaseRequest && requestJournalEntry)
          || (continuationReplayPayload && !nativeStreamChainVerified)) {
          const upstreamResp = await sendRebasedOrCurrentPayload();
          res.statusCode = upstreamResp.status;
          setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
          await recordStreamResponse({
            status: upstreamResp.status,
            rawStreamText: upstreamResp.text,
          });
          res.end(upstreamResp.text);
          return;
        }
        const upstreamResp = await requestUpstreamResponsesStream({
          upstream: requestUpstream,
          payload,
          inboundAuthorization: authorization,
          inboundHeaders: req.headers,
          stateDir: config.stateDir,
        });
        res.statusCode = upstreamResp.status;
        setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        const streamChunks: Buffer[] = [];
        upstreamResp.stream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          streamChunks.push(buffer);
          res.write(buffer);
        });
        upstreamResp.stream.once("end", async () => {
          const rawStreamText = Buffer.concat(streamChunks).toString("utf8");
          try {
            await recordStreamResponse({
              status: upstreamResp.status,
              rawStreamText,
            });
            res.end();
          } catch (err) {
            void appendTrace(config.stateDir, {
              stage: "proxy_after_call",
              sessionId,
              model,
              status: upstreamResp.status,
              stream: true,
              completed: false,
              error: err instanceof Error ? err.message : String(err),
            });
            if (!res.destroyed) {
              res.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });
        upstreamResp.stream.once("error", (err) => {
          void appendTrace(config.stateDir, {
            stage: "proxy_after_call",
            sessionId,
            model,
            status: upstreamResp.status,
            stream: true,
            completed: false,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.destroyed) {
            res.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        });
        return;
      }

      const upstreamResp = await sendRebasedOrCurrentPayload();
      const responseJson = parseJsonObject(upstreamResp.text);
      let responseId = typeof responseJson?.id === "string" && responseJson.id.trim()
        ? responseJson.id
        : undefined;
      const previousResponseId = startsNewResponseChain(contextRewriteOutcome)
        ? undefined
        : typeof originalPayload.previous_response_id === "string"
          ? originalPayload.previous_response_id
          : undefined;
      let assistantChars = 0;
      let toolCallCount = 0;
      try {
        const decoded = codec.decodeResponse(responseJson ?? JSON.parse(upstreamResp.text), prepared.envelope);
        responseId = typeof decoded.metadata?.responseId === "string" && decoded.metadata.responseId
          ? decoded.metadata.responseId
          : responseId;
        assistantChars = decoded.assistantText?.length ?? 0;
        toolCallCount = decoded.toolCalls?.length ?? 0;
        await appendCodexCacheAuditRecord({
          stateDir: config.stateDir,
          snapshot: cacheAuditSnapshot,
          responsePromptCacheKey:
            typeof decoded.metadata?.promptCacheKey === "string"
              ? decoded.metadata.promptCacheKey
              : null,
          usage: decoded.usage ?? null,
          status: upstreamResp.status,
        });
      } catch {
        // Some upstream error payloads may not match the expected Responses shape.
      }
      if (requestJournalEntry && !contextHistoryJournalPersisted) {
        try {
          await appendNonStreamContextHistory({
            response: responseJson,
            responseText: upstreamResp.text,
            httpStatus: upstreamResp.status,
            committed: startsNewResponseChain(contextRewriteOutcome),
          });
        } catch (err) {
          await appendTrace(config.stateDir, {
            stage: "context_history_response_journal_failed",
            sessionId,
            model,
            stream: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await finalizeContextRewriteLifecycle(nonStreamRequestStatus({
        httpStatus: upstreamResp.status,
        response: responseJson,
      }));
      await recordCodexUxReduction({
        stateDir: config.stateDir,
        sessionId,
        model,
        originalRequestText,
        reducedRequestText: requestText,
      });
      await upsertCodexSessionSnapshot(config.stateDir, sessionId, {
        latestResponseId: responseId,
        previousResponseId,
        latestModel: model,
        latestUpstreamProvider: upstreamProviderName,
        disclosedReadPaths: reductionSummary?.disclosedReadPaths,
      });
      if (typeof responseId === "string" && responseId) {
        await indexCodexResponseSession(config.stateDir, responseId, sessionId);
      }
      await appendCodexRecentTurnBinding(config.stateDir, {
        sessionId,
        responseId,
        previousResponseId,
        model,
        requestChars: requestText.length,
        responseChars: upstreamResp.text.length,
        assistantChars,
        toolCallCount,
        stream: false,
        updatedAt: new Date().toISOString(),
      });
      await appendTrace(config.stateDir, {
        stage: "proxy_after_call",
        sessionId,
        model,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
        assistantChars,
        responseId: responseId ?? null,
        previousResponseId: previousResponseId ?? null,
        contextRewriteOutcome: contextRewriteOutcome ?? null,
      });
      res.statusCode = upstreamResp.status;
      setForwardResponseHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.end(upstreamResp.text);
    },
    async handleError({ error, res }) {
      const err = error;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      sendJsonResponse(res, 500, { error: message });
    },
  });

  const baseUrl = runtime.baseUrl;
  logger.info(`proxy listening at ${baseUrl}; upstream=${upstream.baseUrl}`);
  return {
    baseUrl,
    close: runtime.close,
  };
}
