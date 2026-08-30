/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir } from "node:fs/promises";
import {
  buildGatewayForwardHeaders,
  countTextWithPreciseTokens,
  createSseJsonStreamObserver,
  createStaticStatePathResolver,
  forwardGatewayRequest,
  type HostGatewayForwarder,
  type HostGatewayStreamObserver,
  recordUxEffect,
  sendJsonResponse,
  startHostGatewayRuntimeServer,
  setForwardResponseHeaders,
  loadActiveContextMutationPlans,
  saveActiveContextMutationPlan,
  markContextMutationPlanApplied,
  markContextMutationPlanFailed,
} from "@lightrsi/host-adapter";
import {
  prepareObservedBeforeCall,
} from "@lightrsi/product-surface";
import { configureStatePathResolver } from "@lightrsi/artifact-store";
import type { RuntimeMessage } from "@lightrsi/kernel";
import type { TokenPilotClaudeCodeConfig } from "./config.js";
import { proxyBaseUrlForPort } from "./config.js";
import type { TokenPilotClaudeCodeLogger } from "./logger.js";
import { createClaudeMessagesPayloadCodec } from "./messages-codec.js";
import { encodeRequestOrBypass } from "./context-rewrite/encode-bypass.js";
import { reduceClaudeRequestEnvelope, type ClaudeReductionSummary } from "./reduction.js";
import {
  applyClaudeEviction,
  analyzeClaudeEviction,
  buildToolResultSegments,
  buildClaudeHistoryBlocks,
  type ClaudeEvictionApplySummary,
} from "./eviction.js";
import { loadSessionTaskRegistry, persistSessionTaskRegistry } from "@lightrsi/history";
import { claudeContextRewriteBackend, relocateContextMutationPlan } from "./context-rewrite/backend.js";
import { applyArchivePlan } from "./context-rewrite/archive.js";
import {
  readLatestClaudeSnapshotRecord,
  saveLatestClaudeSnapshot,
} from "./context-rewrite/snapshot-store.js";
import { appendOverlayHistory } from "./context-rewrite/overlay-history.js";
import { resolveClaudeTaskStateEstimator } from "./context-rewrite/estimator-config.js";
import { prepareSemanticDelta } from "./context-rewrite/semantic-pipeline.js";
import { buildSegmentToStableIdMap } from "./context-rewrite/segment-stable-id-map.js";
import {
  buildContextMutationPlan,
  planLifecycleEviction,
  type LifecyclePlannerConfig,
} from "@lightrsi/eviction";
import { createHash as _createHash } from "node:crypto";
import {
  appendClaudeCodeRecentTurnBinding,
  upsertClaudeCodeSessionSnapshot,
} from "./session-state.js";
import { prepareClaudeStablePrefix } from "./stable-prefix.js";
import {
  buildStabilityVisualSnapshotFromEnvelopes,
} from "@lightrsi/stabilizer";
import { appendClaudeCodeTrace } from "./trace.js";
import { createClaudeCodeGatewayForwarder, resolveClaudeCodeUpstream } from "./upstream.js";
import { appendClaudeCodeCacheAuditRecord, buildClaudeCodeCacheAuditSnapshot } from "./cache-audit.js";
import { buildAnthropicGatewayModelList, mapClaudeVisibleModelToUpstreamModel } from "./provider-profile.js";
import { resolveLatestClaudeCodeSessionId } from "./session-state.js";
import { lookupRealSessionId, recordSessionMapping } from "./context-rewrite/session-map.js";
import { initializeClaudeCodeTokenPilotPreset } from "./preset.js";
import { attributeClaudeSnapshotTasks } from "./context-cleaner/snapshot.js";
import {
  abandonClaudeCleanerOverlay,
  finalizeClaudeCleanerOverlay,
  prepareClaudeCleanerOverlay,
} from "./context-cleaner/runtime.js";
import { readClaudeCleanerSchedule } from "./context-cleaner/scheduler.js";

export type ClaudeCodeGatewayRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

type ClaudeCodeGatewayRuntimeDependencies = {
  cloneRequestPayload?: typeof structuredClone;
  resolveEstimator?: typeof resolveClaudeTaskStateEstimator;
  persistTaskRegistry?: typeof persistSessionTaskRegistry;
  saveSnapshot?: typeof saveLatestClaudeSnapshot;
};

const CLAUDE_LIFECYCLE_PLAN_SOURCE = "claude-lifecycle";

function isSyntheticClaudeSessionId(sessionId: string): boolean {
  return sessionId.startsWith("claude-synth-");
}

async function resolveObservedClaudeSessionId(stateDir: string, sessionId: string): Promise<string> {
  if (!isSyntheticClaudeSessionId(sessionId)) {
    return sessionId;
  }
  // Persisted synth->real binding takes priority so the overlay keeps a stable
  // anchor across requests and restarts, even if the "latest" session changes.
  const persisted = await lookupRealSessionId(stateDir, sessionId);
  if (persisted) {
    return persisted;
  }
  const latestSessionId = await resolveLatestClaudeCodeSessionId(stateDir);
  if (latestSessionId && !isSyntheticClaudeSessionId(latestSessionId)) {
    await recordSessionMapping(stateDir, sessionId, latestSessionId);
    return latestSessionId;
  }
  return sessionId;
}

function normalizeRequestHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(headers));
}

function countAnthropicMessagePayloadText(payload: unknown): string {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const system = typeof root.system === "string" ? root.system : "";
  const messagesText = Array.isArray(root.messages)
    ? root.messages
      .map((message) => {
        const item = message && typeof message === "object" && !Array.isArray(message)
          ? message as Record<string, unknown>
          : {};
        const content = item.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((block) => {
            const entry = block && typeof block === "object" && !Array.isArray(block)
              ? block as Record<string, unknown>
              : {};
            if (typeof entry.text === "string") return entry.text;
            if (typeof entry.content === "string") return entry.content;
            if (typeof entry.input === "string") return entry.input;
            if (typeof entry.output === "string") return entry.output;
            return "";
          })
          .filter(Boolean)
          .join("\n");
      })
      .filter(Boolean)
      .join("\n")
    : "";
  return [system, messagesText].filter(Boolean).join("\n");
}

async function recordClaudeRequestReductionUx(params: {
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

function extractWorkspaceHint(envelope: {
  instructions?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const metadataHint = typeof envelope.metadata?.workspaceHint === "string"
    ? envelope.metadata.workspaceHint.trim()
    : "";
  if (metadataHint) return metadataHint;
  const instructions = typeof envelope.instructions === "string" ? envelope.instructions : "";
  const match = instructions.match(/Your working directory is:\s*(.+)/);
  const raw = match?.[1]?.trim() ?? "";
  return raw && raw !== "<WORKDIR>" ? raw : undefined;
}

async function recordClaudeGatewayTurn(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  responseId?: string;
  previousResponseId?: string;
  disclosedReadPaths?: string[];
  requestChars: number;
  responseChars: number;
  assistantChars: number;
  reductionSavedChars: number;
  evictionSavedChars: number;
  stablePrefixApplied: boolean;
  reductionApplied: boolean;
  stream: boolean;
  workspaceHint?: string;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  await upsertClaudeCodeSessionSnapshot(params.stateDir, params.sessionId, {
    latestResponseId: params.responseId,
    previousResponseId: params.previousResponseId,
    latestModel: params.model,
    workspaceHint: params.workspaceHint,
    disclosedReadPaths: params.disclosedReadPaths,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
    evictionSavedChars: params.evictionSavedChars,
  });
  await appendClaudeCodeRecentTurnBinding(params.stateDir, {
    sessionId: params.sessionId,
    responseId: params.responseId,
    previousResponseId: params.previousResponseId,
    model: params.model,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
    evictionSavedChars: params.evictionSavedChars,
    stablePrefixApplied: params.stablePrefixApplied,
    reductionApplied: params.reductionApplied,
    stream: params.stream,
    updatedAt,
  });
}

export async function startClaudeCodeGatewayRuntime(params: {
  config: TokenPilotClaudeCodeConfig;
  logger: TokenPilotClaudeCodeLogger;
  forwarder?: HostGatewayForwarder;
  streamObserver?: HostGatewayStreamObserver;
  dependencies?: ClaudeCodeGatewayRuntimeDependencies;
}): Promise<ClaudeCodeGatewayRuntime> {
  initializeClaudeCodeTokenPilotPreset();
  const { config, logger } = params;
  if (!config.enabled) {
    throw new Error("TokenPilot Claude Code adapter is disabled by config");
  }

  configureStatePathResolver(createStaticStatePathResolver({
    hostId: "claude-code",
    displayName: "Claude Code",
    stateDir: config.stateDir,
    namespaceDir: "tokenpilot",
  }));

  await mkdir(config.stateDir, { recursive: true });
  const upstream = resolveClaudeCodeUpstream(config);
  const codec = createClaudeMessagesPayloadCodec();
  const forwarder = params.forwarder ?? createClaudeCodeGatewayForwarder(config);
  const streamObserver = params.streamObserver ?? createSseJsonStreamObserver({
    responseIdPaths: [["message", "id"], ["id"]],
    usagePaths: [["usage"]],
  });

  const runtime = await startHostGatewayRuntimeServer({
    port: config.proxyPort,
    requestPath: "/v1/messages",
    basePath: "/v1",
    healthPayload: {
      ok: true,
      adapter: "tokenpilot-claude-code",
      upstream: upstream.baseUrl,
      stateDir: config.stateDir,
    },
    async handleRoute({ req, res, pathname, readBody }) {
      const inboundHeaders = normalizeRequestHeaders(req.headers);
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;

      if (req.method === "GET" && pathname === "/v1/models") {
        const upstreamResp = await forwardGatewayRequest({
          upstream,
          method: "GET",
          requestPath: "/v1/models",
          inboundAuthorization: authorization,
          inboundHeaders,
        });
        if (upstreamResp.status === 404) {
          sendJsonResponse(res, 200, buildAnthropicGatewayModelList(config));
          return true;
        }
        const text = await upstreamResp.text();
        setForwardResponseHeaders(res, Object.fromEntries(upstreamResp.headers.entries()), "application/json; charset=utf-8");
        res.statusCode = upstreamResp.status;
        res.end(text);
        return true;
      }

      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        const body = await readBody();
        const payload = JSON.parse(body);
        const upstreamPayload = {
          ...payload,
          model: typeof payload?.model === "string"
            ? mapClaudeVisibleModelToUpstreamModel(config, payload.model)
            : payload?.model,
        };
        const upstreamResp = await forwardGatewayRequest({
          upstream,
          method: "POST",
          requestPath: "/v1/messages/count_tokens",
          payload: upstreamPayload,
          inboundAuthorization: authorization,
          inboundHeaders,
        });

        if (upstreamResp.status !== 404) {
          const text = await upstreamResp.text();
          setForwardResponseHeaders(res, Object.fromEntries(upstreamResp.headers.entries()), "application/json; charset=utf-8");
          res.statusCode = upstreamResp.status;
          res.end(text);
          return true;
        }

        const countText = countAnthropicMessagePayloadText(payload);
        const model = typeof payload?.model === "string" && payload.model.trim()
          ? payload.model
          : "claude-sonnet-4-6";
        const tokenCount = countTextWithPreciseTokens(model, countText);
        sendJsonResponse(res, 200, {
          input_tokens: tokenCount.count,
        });
        return true;
      }

      return false;
    },
    async handleRequest({ req, res, body }) {
      let payload = JSON.parse(body);
      let envelope = codec.decodeRequest(payload, {
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      const originalRequestText = typeof envelope.metadata?.inputText === "string"
        ? envelope.metadata.inputText
        : "";
      const sessionId = await resolveObservedClaudeSessionId(config.stateDir, envelope.session.sessionId);
      const plannerMessages = Array.isArray((payload as Record<string, unknown>).messages)
        ? (payload as Record<string, unknown>).messages as unknown[]
        : [];
      const cleanerSnapshotRevision = _createHash("sha256")
        .update(JSON.stringify(plannerMessages))
        .digest("hex")
        .slice(0, 32);

      const evictionEnabled = config.modules.eviction && config.eviction.enabled;
      let evictionSummary: ClaudeEvictionApplySummary = {
        enabled: evictionEnabled,
        changed: false,
        evictedMessageCount: 0,
        evictedToolResultCount: 0,
        savedChars: 0,
        evictedBlockIds: [],
      };
      let evictionBypassReason: string | undefined;
      let activePlanId: string | undefined;
      let activePlanStatus: "active" | "applied" | undefined;
      let evictionPlanSource: "lifecycle" | "heuristic" | "none" = "none";
      let lifecyclePlannerStatus: "completed" | "deferred" | "bypassed" | "not_configured" = "not_configured";
      let lifecyclePlannerReasonCodes: string[] = [];
      let lifecycleRegistryVersion: number | undefined;
      let manualCleanerOverlay: Extract<
        Awaited<ReturnType<typeof prepareClaudeCleanerOverlay>>,
        { outcome: "prepared" }
      > | undefined;
      let manualCleanerSuppressesAutomaticEviction = false;

      // A scheduled manual clean owns the next safe rewrite boundary. Check the
      // adapter-local marker before lifecycle analysis so an automatic planner
      // cannot race it or advance task state on the same request. A malformed
      // or unreadable marker is also fail-closed for automatic eviction.
      try {
        const manualSchedule = await readClaudeCleanerSchedule({
          stateDir: config.stateDir,
          sessionId,
        });
        if (manualSchedule.outcome === "ready" || manualSchedule.outcome === "bypassed") {
          manualCleanerSuppressesAutomaticEviction = true;
          lifecyclePlannerStatus = "deferred";
          lifecyclePlannerReasonCodes = [
            manualSchedule.outcome === "ready"
              ? "manual_cleaner_schedule_pending"
              : "manual_cleaner_schedule_unavailable",
          ];
        }
      } catch (error) {
        manualCleanerSuppressesAutomaticEviction = true;
        lifecyclePlannerStatus = "deferred";
        lifecyclePlannerReasonCodes = ["manual_cleaner_schedule_unavailable"];
        logger.warn(`context cleaner schedule check failed (ignored): ${String(error)}`);
      }

      // Lifecycle planner (estimator-driven) runs independently of the eviction
      // toggle so registry updates happen every ordinary turn. A pending manual
      // Cleaner schedule is the one exception: it exclusively owns this request
      // boundary. Fail-open: any planner error leaves plannerPlan undefined and
      // the request proceeds unchanged.
      let plannerPlan: ReturnType<typeof buildContextMutationPlan> | undefined;
      let lifecycleEstimator: ReturnType<typeof resolveClaudeTaskStateEstimator>;
      if (!manualCleanerSuppressesAutomaticEviction) {
        try {
          lifecycleEstimator = (params.dependencies?.resolveEstimator ?? resolveClaudeTaskStateEstimator)({
            config: config.taskStateEstimator,
            env: process.env,
          });
        } catch (error) {
          lifecycleEstimator = undefined;
          lifecyclePlannerStatus = "bypassed";
          lifecyclePlannerReasonCodes = ["estimator_resolver_error"];
          logger.warn(`lifecycle estimator resolver failed (ignored): ${String(error)}`);
        }
      }
      if (lifecycleEstimator) {
        try {
          const prep = await prepareSemanticDelta({
            stateDir: config.stateDir,
            sessionId,
            messages: plannerMessages,
          });
          if (prep.ok) {
            const plannerRevision = _createHash("sha256")
              .update(JSON.stringify(plannerMessages))
              .digest("hex")
              .slice(0, 32);
            const { bindings: plannerBindings } = buildToolResultSegments(plannerMessages);
            const plannerSnapshot = await claudeContextRewriteBackend.readSnapshot({
              sessionId,
              request: {
                sessionId,
                revision: plannerRevision,
                messages: plannerMessages as unknown as RuntimeMessage[],
              },
            });
            const plannerResult = await planLifecycleEviction({
              registry: prep.registry,
              delta: prep.delta,
              pendingTurnCount: prep.turnSeq - prep.registry.lastProcessedTurnSeq,
              estimator: lifecycleEstimator,
              historyBlocks: buildClaudeHistoryBlocks(
                sessionId,
                envelope.model,
                plannerMessages,
                prep.turnAbsIdByToolCallId,
              ),
              snapshot: plannerSnapshot,
              stableItemIdsByMessageId: buildSegmentToStableIdMap(sessionId, plannerBindings),
              config: {
                enabled: true,
                batchTurns: config.taskStateEstimator.batchTurns,
                evictionEnabled: config.eviction.enabled,
                evictionPolicy: "lifecycle",
                evictionMinBlockChars: config.eviction.minBlockChars,
              } satisfies LifecyclePlannerConfig,
              createdAt: new Date().toISOString(),
              sourcePresetId: CLAUDE_LIFECYCLE_PLAN_SOURCE,
            });
            lifecyclePlannerStatus = plannerResult.status;
            lifecyclePlannerReasonCodes = plannerResult.reasonCodes;
            lifecycleRegistryVersion = plannerResult.registry.version;
            let registryCommitted = !plannerResult.registryUpdateRequired;
            if (plannerResult.registryUpdateRequired) {
              try {
                await (params.dependencies?.persistTaskRegistry ?? persistSessionTaskRegistry)(config.stateDir, plannerResult.registry, {
                  expectedVersion: plannerResult.expectedRegistryVersion,
                });
                registryCommitted = true;
              } catch (error) {
                logger.warn(`lifecycle registry persist failed (ignored): ${String(error)}`);
                lifecyclePlannerReasonCodes = [
                  ...lifecyclePlannerReasonCodes,
                  "registry_persist_failed",
                ];
              }
            }
            if (registryCommitted && plannerResult.status === "completed" && plannerResult.plan) {
              plannerPlan = plannerResult.plan;
              evictionPlanSource = "lifecycle";
            }
          } else {
            lifecyclePlannerStatus = "deferred";
            lifecyclePlannerReasonCodes = [prep.note];
          }
        } catch (error) {
          lifecyclePlannerStatus = "bypassed";
          lifecyclePlannerReasonCodes = ["planner_runtime_error"];
          logger.warn(`lifecycle planner failed (ignored): ${String(error)}`);
        }
      }

      // A scheduled manual clean must validate against the canonical snapshot
      // from approval time. Read that base before this request replaces it.
      let previousCleanerSnapshot: Awaited<ReturnType<typeof readLatestClaudeSnapshotRecord>>;
      try {
        previousCleanerSnapshot = await readLatestClaudeSnapshotRecord(config.stateDir, sessionId);
      } catch (error) {
        logger.warn(`context cleaner base snapshot read failed (ignored): ${String(error)}`);
      }

      // Build the current canonical snapshot after lifecycle update, then let a
      // pending manual Cleaner plan preempt automatic eviction for this request.
      // The snapshot persisted below remains the original inbound request.
      let cleanerSnapshot:
        | Awaited<ReturnType<typeof claudeContextRewriteBackend.readSnapshot>>
        | undefined;
      let cleanerRegistry: Awaited<ReturnType<typeof loadSessionTaskRegistry>> | undefined;
      try {
        const baseCleanerSnapshot = await claudeContextRewriteBackend.readSnapshot({
          sessionId,
          request: {
            sessionId,
            revision: cleanerSnapshotRevision,
            messages: plannerMessages as unknown as RuntimeMessage[],
          },
        });
        cleanerSnapshot = baseCleanerSnapshot;
        try {
          cleanerRegistry = await loadSessionTaskRegistry(config.stateDir, sessionId);
          cleanerSnapshot = attributeClaudeSnapshotTasks({
            snapshot: baseCleanerSnapshot,
            messages: plannerMessages,
            registry: cleanerRegistry,
          });
        } catch (error) {
          // Task attribution is optional. Keep the canonical snapshot even when
          // registry recovery fails so Cleaner can still inspect unassigned context.
          logger.warn(`context cleaner task attribution failed (ignored): ${String(error)}`);
        }
      } catch (error) {
        logger.warn(`context cleaner snapshot preparation failed (ignored): ${String(error)}`);
      }

      if (cleanerSnapshot && cleanerRegistry) {
        const manual = await prepareClaudeCleanerOverlay({
          stateDir: config.stateDir,
          sessionId,
          baseSnapshot: previousCleanerSnapshot?.snapshot ?? cleanerSnapshot,
          currentSnapshot: cleanerSnapshot,
          request: {
            sessionId,
            revision: cleanerSnapshotRevision,
            messages: plannerMessages as RuntimeMessage[],
          },
          activeTaskIds: cleanerRegistry.activeTaskIds,
          evictableTaskIds: cleanerRegistry.evictableTaskIds,
        });
        manualCleanerSuppressesAutomaticEviction = manual.suppressAutomaticEviction;
        if (manual.outcome === "prepared") {
          manualCleanerOverlay = manual;
          payload = { ...(payload as Record<string, unknown>), messages: manual.request.messages };
          envelope = codec.decodeRequest(payload, {
            headers: req.headers as Record<string, string | string[] | undefined>,
          });
        } else if (manual.outcome === "reserved") {
          logger.warn(`context cleaner manual overlay deferred (ignored): ${manual.reasonCodes.join(",")}`);
        }
      } else if (!manualCleanerSuppressesAutomaticEviction) {
        const schedule = await readClaudeCleanerSchedule({ stateDir: config.stateDir, sessionId });
        manualCleanerSuppressesAutomaticEviction = schedule.outcome === "ready";
      }

      // Persist the complete original inbound history after manual Cleaner has
      // consumed the previous baseline, but before any automatic overlay.
      if (cleanerSnapshot) {
        try {
          const saveResult = await (
            params.dependencies?.saveSnapshot ?? saveLatestClaudeSnapshot
          )(config.stateDir, sessionId, cleanerSnapshot, { model: envelope.model });
          if (!saveResult.saved) {
            logger.warn(
              `context cleaner snapshot persistence failed (ignored): ${saveResult.reason}`,
            );
          }
        } catch (error) {
          logger.warn(`context cleaner snapshot persistence failed (ignored): ${String(error)}`);
        }
      }

      if (evictionEnabled && !manualCleanerSuppressesAutomaticEviction) {
        try {
          const candidatePayload = (
            params.dependencies?.cloneRequestPayload ?? structuredClone
          )(payload) as { messages?: unknown[] };
          const overlayMessages =
            (candidatePayload.messages ?? []) as typeof envelope.messages;
          const revision = _createHash("sha256")
            .update(JSON.stringify(overlayMessages))
            .digest("hex")
            .slice(0, 32);

          const analysis = lifecycleEstimator
            ? {
                enabled: true,
                changed: false,
                evictedBlockIds: [],
                savedChars: 0,
                selections: [],
              }
            : analyzeClaudeEviction({
                sessionId,
                model: envelope.model,
                messages: overlayMessages,
                config: { enabled: true, minBlockChars: config.eviction.minBlockChars },
              });

          if (plannerPlan || (!lifecycleEstimator && analysis.changed && analysis.selections.length > 0)) {
            if (!plannerPlan) evictionPlanSource = "heuristic";
            const { bindings } = buildToolResultSegments(overlayMessages);
            const segmentLocations = new Map(
              [...bindings.entries()].map(([segmentId, binding]) => [
                segmentId,
                { messageIndex: binding.messageIndex, blockIndex: binding.blockIndex },
              ]),
            );

            const overlayRequest = { sessionId, revision, messages: overlayMessages };
            const snapshot = await claudeContextRewriteBackend.readSnapshot({
              sessionId,
              request: overlayRequest,
            });
            const loaded = plannerPlan
              ? { plans: [], bypassed: false, reasons: [] }
              : await loadActiveContextMutationPlans({
                  stateDir: config.stateDir,
                  sessionId,
                });
            if (loaded.bypassed) {
              throw new Error(`context mutation plan store unavailable: ${loaded.reasons.join(",")}`);
            }
            const replayablePlans = loaded.plans.filter(
              (candidate) => candidate.sourcePresetId !== CLAUDE_LIFECYCLE_PLAN_SOURCE,
            );
            // Relocate any active plan onto the CURRENT snapshot: a later turn
            // may have shifted item positions (new stableIds + revision) while
            // the underlying content is unchanged, so an exact-revision match
            // would miss it. relocate re-anchors operations by fingerprint and
            // defers anything ambiguous or gone.
            let plan: ReturnType<typeof buildContextMutationPlan> | undefined = plannerPlan;
            let replayedFromStore = false;
            if (plannerPlan) {
              // Planner produced a fresh plan this turn: persist it and skip
              // relocate/replay + the signal-heuristic build entirely (planner
              // plans are recomputed each turn, never relocated).
              const stored = await saveActiveContextMutationPlan({
                stateDir: config.stateDir,
                plan: plannerPlan,
              });
              if (stored.bypassed || (stored.status !== "active" && stored.status !== "applied")) {
                throw new Error(`context mutation plan could not be persisted: ${stored.reasons.join(",")}`);
              }
              activePlanStatus = stored.status;
            }
            for (const candidate of replayablePlans) {
              const { plan: relocatedPlan, relocated } = relocateContextMutationPlan({
                snapshot,
                plan: candidate,
              });
              if (relocated) {
                // Re-persist the relocated plan so its stored form tracks the
                // current revision (supervisor-confirmed behavior).
                await saveActiveContextMutationPlan({
                  stateDir: config.stateDir,
                  plan: relocatedPlan,
                });
                plan = relocatedPlan;
                replayedFromStore = true;
                activePlanStatus = "active";
                break;
              }
            }
            if (!plannerPlan && !replayedFromStore) {
              const persistedPlan = loaded.plans.find(
                (candidate) => candidate.sourcePresetId !== CLAUDE_LIFECYCLE_PLAN_SOURCE
                  && candidate.baseRevision === snapshot.revision,
              );
              if (persistedPlan) {
                plan = persistedPlan;
                activePlanStatus = "active";
              } else {
                plan = buildContextMutationPlan({
                  hostId: "claude-code",
                  sessionId,
                  snapshot,
                  selections: analysis.selections.map((selection) => ({
                    segmentIds: selection.segmentIds,
                    chars: selection.chars,
                  })),
                  segmentLocations,
                });
                const stored = await saveActiveContextMutationPlan({
                  stateDir: config.stateDir,
                  plan,
                });
                if (stored.bypassed || (stored.status !== "active" && stored.status !== "applied")) {
                  throw new Error(`context mutation plan could not be persisted: ${stored.reasons.join(",")}`);
                }
                activePlanStatus = stored.status;
              }
            }
            if (!plan) {
              throw new Error("context mutation plan unavailable");
            }
            activePlanId = plan.planId;
            // Archive stage (before apply): each tool_result the plan would evict
            // is archived first. On success we record the opaque archiveRef on the
            // op so apply writes a recovery_ref into the stub. On failure we drop
            // that item from the op targets so apply will NOT stub it — the
            // original stays in the forwarded request. Never stub without a
            // successful archive, or the content is deleted unrecoverably.
            await applyArchivePlan({
              stateDir: config.stateDir,
              sessionId,
              snapshot,
              plan,
              request: overlayRequest,
            });
            const { request: rewritten, result } = await claudeContextRewriteBackend.apply({
              snapshot,
              plan,
              request: overlayRequest,
            });
            if (result.changed && activePlanStatus === "active") {
              const applied = await markContextMutationPlanApplied({
                stateDir: config.stateDir,
                sessionId,
                planId: plan.planId,
              });
              if (applied.bypassed) {
                throw new Error(`context mutation plan commit failed: ${applied.reasons.join(",")}`);
              }
            }
            // Record this turn's overlay in the append-only audit log (§4.5).
            if (result.changed) {
              await appendOverlayHistory(config.stateDir, {
                sessionId,
                planId: plan.planId,
                previousRevision: result.previousRevision,
                nextRevision: result.nextRevision,
                removedItemIds: result.removedItemIds,
                savedChars: result.savedChars,
                relocated: replayedFromStore,
              });
            }

            evictionSummary = {
              ...evictionSummary,
              changed: result.changed,
              savedChars: result.savedChars,
              evictedBlockIds: result.removedItemIds,
              evictedToolResultCount: result.removedItemIds.length,
              evictedMessageCount: result.removedItemIds.length,
            };

            if (result.changed) {
              payload = { ...(payload as Record<string, unknown>), messages: rewritten.messages };
              envelope = codec.decodeRequest(payload, {
                headers: req.headers as Record<string, string | string[] | undefined>,
              });
            }
          }
        } catch {
          evictionBypassReason = "analysis_or_apply_error";
          logger.warn("context eviction bypassed category=analysis_or_apply_error");
          if (activePlanId && activePlanStatus === "active") {
            await markContextMutationPlanFailed({
              stateDir: config.stateDir,
              sessionId,
              planId: activePlanId,
            }).catch(() => undefined);
          }
        }
      }
      if (envelope.model.startsWith("tokenpilot/")) {
        envelope = {
          ...envelope,
          model: envelope.model.slice("tokenpilot/".length),
        };
      }
      envelope = {
        ...envelope,
        model: mapClaudeVisibleModelToUpstreamModel(config, envelope.model),
      };
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const model = envelope.model;
      const workspaceHint = extractWorkspaceHint(envelope);
      const prepared = await prepareObservedBeforeCall<ClaudeReductionSummary>({
        envelope,
        codec,
        config: { mode: "normal" },
        prepareStablePrefix(nextEnvelope) {
          return prepareClaudeStablePrefix(nextEnvelope, config);
        },
        async applyBeforeCallReduction({ envelope: nextEnvelope, codec: nextCodec }) {
          return reduceClaudeRequestEnvelope({
            envelope: nextEnvelope,
            codec: nextCodec,
            config,
          });
        },
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
                  return typeof envelope.instructions === "string" ? envelope.instructions : "";
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
                segments: (reductionSummary.visualSegments ?? []).map((segment) => ({
                  segmentId: segment.segmentId,
                  itemIndex: segment.messageIndex,
                  field: segment.field === "text" ? "content" : segment.field,
                  blockIndex: segment.blockIndex,
                  toolName: segment.toolName,
                  savedChars: segment.savedChars,
                  beforeText: segment.beforeText,
                  afterText: segment.afterText,
                  report: segment.report,
                })),
              }
              : undefined;
          },
        },
      });
      const reductionSummary = prepared.reductionSummary;
      {
        const encoded = encodeRequestOrBypass({ codec, envelope: prepared.envelope, rawBody: body });
        payload = encoded.payload as Record<string, unknown>;
        if (encoded.bypassed) {
          evictionBypassReason = "encode_error";
          logger.warn("context overlay bypassed category=encode_error");
        }
        if (manualCleanerOverlay) {
          if (encoded.bypassed) {
            await abandonClaudeCleanerOverlay(manualCleanerOverlay);
            manualCleanerOverlay = undefined;
          } else {
            const finalized = await finalizeClaudeCleanerOverlay({
              stateDir: config.stateDir,
              prepared: manualCleanerOverlay,
            });
            manualCleanerOverlay = undefined;
            if (finalized.outcome !== "applied") {
              // Receipt persistence is part of the manual-clean transaction.
              // Never send an unrecorded overlay; preserve the caller payload.
              payload = JSON.parse(body) as Record<string, unknown>;
              envelope = codec.decodeRequest(payload, {
                headers: req.headers as Record<string, string | string[] | undefined>,
              });
              logger.warn(`context cleaner manual overlay bypassed (ignored): ${finalized.reasonCodes.join(",")}`);
            } else if (finalized.reasonCodes.length > 0) {
              logger.warn(`context cleaner manual overlay local recovery needed: ${finalized.reasonCodes.join(",")}`);
            }
          }
        }
      }
      const reducedRequestText = typeof prepared.envelope.metadata?.inputText === "string"
        ? prepared.envelope.metadata.inputText
        : "";
      const cacheAuditSnapshot = buildClaudeCodeCacheAuditSnapshot({
        envelope: prepared.envelope,
        sessionId,
        model: prepared.envelope.model,
        stream: prepared.envelope.stream,
        originalRequestPromptCacheKey:
          typeof prepared.envelope.metadata?.originalPromptCacheKey === "string"
            ? prepared.envelope.metadata.originalPromptCacheKey
            : null,
        requestPromptCacheKey:
          typeof prepared.envelope.metadata?.frameworkStablePromptCacheKey === "string"
            ? prepared.envelope.metadata.frameworkStablePromptCacheKey
            : typeof prepared.envelope.metadata?.promptCacheKey === "string"
              ? prepared.envelope.metadata.promptCacheKey
            : null,
      });

      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_before_call",
        sessionId,
        model: prepared.envelope.model,
        stream: prepared.envelope.stream,
        requestChars: body.length,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        reductionChangedBlocks: reductionSummary?.changedBlocks ?? 0,
        reductionChangedMessages: reductionSummary?.changedMessages ?? 0,
        reductionSkippedReason: reductionSummary?.skippedReason ?? null,
        reductionPassEffects: reductionSummary?.passEffects ?? [],
        evictionEnabled: evictionSummary.enabled,
        evictionApplied: evictionSummary.changed,
        evictionSavedChars: evictionSummary.savedChars,
        evictionChangedMessages: evictionSummary.evictedMessageCount,
        evictionChangedToolResults: evictionSummary.evictedToolResultCount,
        evictionBypassReason: evictionBypassReason ?? null,
        evictionPlanSource,
        lifecyclePlannerStatus,
        lifecyclePlannerReasonCodes,
        lifecycleRegistryVersion: lifecycleRegistryVersion ?? null,
      });

      if (prepared.envelope.stream) {
        const upstreamResp = await forwarder.requestStream({
          upstream,
          payload,
          inboundAuthorization: authorization,
          inboundHeaders: normalizeRequestHeaders(req.headers),
        });
        res.statusCode = upstreamResp.status;
        setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        const chunks: Buffer[] = [];
        upstreamResp.stream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          chunks.push(buffer);
          res.write(buffer);
        });
        upstreamResp.stream.once("end", async () => {
          const rawStreamText = Buffer.concat(chunks).toString("utf8");
          const snapshot = streamObserver.snapshot(rawStreamText);
          const responseId = typeof snapshot.metadata?.responseId === "string" ? snapshot.metadata.responseId : undefined;
          const previousResponseId =
            typeof snapshot.metadata?.previousResponseId === "string" ? snapshot.metadata.previousResponseId : undefined;
          await recordClaudeRequestReductionUx({
            stateDir: config.stateDir,
            sessionId,
            model: prepared.envelope.model,
            originalRequestText,
            reducedRequestText,
          });
          await appendClaudeCodeCacheAuditRecord({
            stateDir: config.stateDir,
            snapshot: cacheAuditSnapshot,
            responsePromptCacheKey: null,
            usage: snapshot.usage ?? null,
            status: upstreamResp.status,
          });
          await appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            assistantChars: snapshot.assistantText.length,
            responseChars: rawStreamText.length,
          });
          await recordClaudeGatewayTurn({
            stateDir: config.stateDir,
            sessionId,
            model: prepared.envelope.model,
            responseId,
            previousResponseId,
            disclosedReadPaths: reductionSummary?.disclosedReadPaths,
            requestChars: body.length,
            responseChars: rawStreamText.length,
            assistantChars: snapshot.assistantText.length,
            reductionSavedChars: reductionSummary?.savedChars ?? 0,
            evictionSavedChars: evictionSummary?.savedChars ?? 0,
            stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
            reductionApplied: prepared.diagnostics.reductionApplied === true,
            stream: true,
            workspaceHint,
          });
          res.end();
        });
        upstreamResp.stream.once("error", (error) => {
          logger.error(error instanceof Error ? error.message : String(error));
          void appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.destroyed) {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
        return;
      }

      const upstreamResp = await forwarder.request({
        upstream,
        payload,
        inboundAuthorization: authorization,
        inboundHeaders: normalizeRequestHeaders(req.headers),
      });
      setForwardResponseHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.statusCode = upstreamResp.status;
      let assistantChars = 0;
      let responseId: string | undefined;
      let previousResponseId: string | undefined;
      let responsePromptCacheKey: string | undefined;
      let decodedUsage: Record<string, unknown> | null = null;
      try {
        const decoded = codec.decodeResponse(JSON.parse(upstreamResp.text), prepared.envelope);
        assistantChars = decoded.assistantText?.length ?? 0;
        responseId = typeof decoded.metadata?.responseId === "string" ? decoded.metadata.responseId : undefined;
        previousResponseId =
          typeof decoded.metadata?.previousResponseId === "string" ? decoded.metadata.previousResponseId : undefined;
        responsePromptCacheKey =
          typeof decoded.metadata?.promptCacheKey === "string" ? decoded.metadata.promptCacheKey : undefined;
        decodedUsage = decoded.usage ?? null;
      } catch {
        assistantChars = 0;
      }
      await recordClaudeRequestReductionUx({
        stateDir: config.stateDir,
        sessionId,
        model: prepared.envelope.model,
        originalRequestText,
        reducedRequestText,
      });
      await appendClaudeCodeCacheAuditRecord({
        stateDir: config.stateDir,
        snapshot: cacheAuditSnapshot,
        responsePromptCacheKey,
        usage: decodedUsage,
        status: upstreamResp.status,
      });
      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_after_call",
        sessionId,
        model: prepared.envelope.model,
        stream: false,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
        assistantChars,
      });
      await recordClaudeGatewayTurn({
        stateDir: config.stateDir,
        sessionId,
        model: prepared.envelope.model,
        responseId,
        previousResponseId,
        disclosedReadPaths: reductionSummary?.disclosedReadPaths,
        requestChars: body.length,
        responseChars: upstreamResp.text.length,
        assistantChars,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        evictionSavedChars: evictionSummary?.savedChars ?? 0,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        stream: false,
        workspaceHint,
      });
      res.end(upstreamResp.text);
    },
    async handleError({ error, res }) {
      logger.error(error instanceof Error ? error.message : String(error));
      sendJsonResponse(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return {
    baseUrl: proxyBaseUrlForPort(config.proxyPort),
    close: runtime.close,
  };
}
