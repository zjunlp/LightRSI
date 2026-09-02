/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  runReductionAfterCall as runLayerReductionAfterCall,
  runReductionBeforeCall as runLayerReductionBeforeCall,
  resolveReductionPasses as resolveLayerReductionPasses,
} from "@lightrsi/reduction";
import { configureStatePathResolver } from "@lightrsi/artifact-store";
import {
  extractInputText,
  normalizeTurnBindingMessage,
} from "./context-stack/request-preprocessing/stable-prefix.js";
import { applyProxyReductionToInput } from "./context-stack/request-preprocessing/before-call-reduction.js";
import type { ProxyReductionResult } from "./context-stack/request-preprocessing/before-call-reduction.js";
import type { ProxyAfterCallReductionResult } from "./context-stack/request-preprocessing/after-call-reduction.js";
import type { RootPromptRewrite } from "./context-stack/request-preprocessing/root-prompt-stabilizer.js";
import {
  extractTurnObservations,
  readTranscriptEntriesForSession,
  transcriptMessageStableId,
  syncRawSemanticTurnsFromTranscript,
} from "./context-stack/page-out/transcript-sync.js";
import {
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  archiveContent,
  buildRecoveryHint,
  registerMemoryFaultRecoverTool,
} from "./context-stack/page-in-api.js";
import {
  PluginRuntimeConfig,
  PluginLogger,
  asRecord,
} from "./context-stack/integration/config-types.js";
import type { UpstreamConfig, UpstreamHttpResponse } from "./context-stack/integration/upstream-types.js";
import { normalizeConfig } from "./context-stack/integration/config-normalize.js";
import { applyPolicyBeforeCall, buildPolicyModuleConfigFromPluginConfig } from "./context-stack/integration/policy-config-bridge.js";
import { createPluginContextEngine } from "./context-stack/integration/context-engine.js";
import { registerRuntime } from "./context-stack/integration/runtime-register.js";
import { hookOn, makeLogger } from "./context-stack/integration/runtime-helpers.js";
import {
  canonicalMessageTaskIds,
  dedupeStrings,
  ensureContextSafeDetails,
  extractToolMessageText,
  extractWorkspaceDirFromMessages,
  isToolResultLikeMessage,
  messageToolCallId,
  applyBeforeToolCallDefaults,
  applyWorkspacePathHintToToolParams,
} from "./context-stack/integration/runtime-tooling.js";
import {
  contentToText,
  extractItemText,
  extractLastUserMessage,
  extractOpenClawSessionId,
  extractProviderResponseText,
  extractSessionKey,
  findLastUserItem,
} from "./context-stack/integration/runtime-event-text.js";
import { maybeRegisterProxyProvider } from "./context-stack/integration/proxy-provider.js";
import { ensureExplicitProxyModelsInConfig } from "./context-stack/integration/upstream-config.js";
import { installLlmHookTap } from "./context-stack/integration/trace-hooks.js";
import { extractPathLike, safeId } from "./context-stack/integration/config-types.js";
import {
  maybeBlockRepeatedToolCall,
  recordToolCallMemo,
} from "./context-stack/integration/tool-call-memo.js";
import { appendTaskStateTrace } from "./trace/io.js";
import { registerTokenPilotCommand } from "./commands/tokenpilot-command.js";
import { appendEvictionVisualSnapshot } from "@lightrsi/product-surface";
import { registerLayeredContextEngine, registerToolCallHooks, registerToolResultPersistHook } from "./plugin-register-hooks.js";
import { __testHooks, contextSafeRecovery, proxyRuntimeHelpers } from "./plugin-test-support.js";
import { createWorkspaceHintStore } from "./plugin-workspace-hints.js";
import { createOpenClawStatePathResolver } from "./context-stack/integration/host-adapter.js";
import { initializeOpenClawTokenPilotPreset } from "./preset.js";
import { createOpenClawContextCleanerBridge } from "./context-cleaner/index.js";

module.exports = {
  id: "tokenpilot",
  name: "TokenPilot Runtime Optimizer",
  __testHooks,
  createOpenClawContextCleanerBridge,

  register(api: any) {
    initializeOpenClawTokenPilotPreset();
    const logger = makeLogger(api?.logger);
    configureStatePathResolver(createOpenClawStatePathResolver());
    const cfg = normalizeConfig(api?.pluginConfig);
    const { rememberWorkspaceHint, resolveWorkspaceHintForEvent } = createWorkspaceHintStore(
      extractSessionKey,
      extractOpenClawSessionId,
    );

    registerTokenPilotCommand(api, logger);

    if (!cfg.enabled) {
      logger.info("[plugin-runtime] Plugin disabled by config.");
      return;
    }

    registerToolCallHooks({
      api,
      cfg,
      hookOn,
      appendTaskStateTrace,
      maybeBlockRepeatedToolCall,
      applyBeforeToolCallDefaults,
      applyWorkspacePathHintToToolParams,
      resolveWorkspaceHintForEvent,
      recordToolCallMemo,
      safeId,
      logger,
    });

    registerToolResultPersistHook({
      api,
      cfg,
      hookOn,
      logger,
      appendTaskStateTrace,
      ensureContextSafeDetails,
      extractOpenClawSessionId,
      extractToolMessageText,
      isToolResultLikeMessage,
      safeId,
    });

    registerLayeredContextEngine({
      api,
      cfg,
      logger,
      createPluginContextEngine,
      appendTaskStateTrace,
      appendEvictionVisualSnapshot: (payload) => appendEvictionVisualSnapshot(cfg.stateDir, { kind: "eviction", ...payload }),
      readTranscriptEntriesForSession,
      transcriptMessageStableId,
      asRecord,
      canonicalMessageTaskIds,
      contentToText,
      dedupeStrings,
      ensureContextSafeDetails,
      extractPathLike,
      extractToolMessageText,
      isToolResultLikeMessage,
      messageToolCallId,
      safeId,
    });

    void registerRuntime(api, cfg, logger, {
      debugEnabled: cfg.logLevel === "debug",
      hookOn,
      safeId,
      contentToText,
      contextSafeRecovery,
      memoryFaultRecoverToolName: MEMORY_FAULT_RECOVER_TOOL_NAME,
      extractTurnObservations,
      extractSessionKey,
      extractLastUserMessage,
      extractOpenClawSessionId,
      extractWorkspaceDirFromMessages,
      normalizeTurnBindingMessage,
      rememberWorkspaceHint,
      extractItemText: (item: any) => extractItemText(item, extractInputText),
      findLastUserItem,
      syncRawSemanticTurnsFromTranscript,
      appendTaskStateTrace,
      maybeRegisterProxyProvider,
      ensureExplicitProxyModelsInConfig,
      installLlmHookTap,
      proxyRuntimeHelpers,
    });
  },
};
