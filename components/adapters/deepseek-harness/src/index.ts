/** TokenPilot DeepSeek Harness plugin entry (Cordis). */

import { normalizeDshConfig } from "./config.js";
import {
  registerTokenPilotCommands,
  type TokenPilotCommandContext,
} from "./commands.js";
import {
  registerContextCleanerCommands,
  type ContextCleanerCommandContext,
} from "./context-cleaner/commands.js";
import type { DshCleanerSessionStore } from "./context-cleaner/session-catalog.js";
import {
  createDshCleanerPreStepState,
  registerDshCleanerPreStep,
} from "./cleaner-pre-step.js";
import { registerEvictionPreStep } from "./eviction-engine.js";
import {
  registerTokenPilotProjection,
  type TokenPilotProjectionContext,
} from "./projection.js";
import type { DshPluginContext } from "./types.js";

export {
  createDshCleanerCapabilities,
  type DshCleanerCapabilityParams,
} from "./context-cleaner/capabilities.js";
export {
  DSH_PRODUCT_HOST_REGISTRATION,
  resolveDshStateDir,
} from "./product-registration.js";

/** Cordis plugin name. */
export const name = "tokenpilot-dsh";

/**
 * All DSH services are acquired through optional child injections. This keeps
 * headless compositions loadable and avoids Cordis's "without inject" error.
 */
export const inject: readonly string[] = [];

type CommandHost = ContextCleanerCommandContext & Pick<TokenPilotCommandContext, "commands">;
type ProjectionHost = TokenPilotProjectionContext & Pick<TokenPilotCommandContext, "sessionProjections">;
type RuntimeHost = DshPluginContext;

type InjectableContext = {
  inject?: (services: readonly string[], callback: (ctx: any) => void) => void;
};

function registerCommands(ctx: InjectableContext, config: ReturnType<typeof normalizeDshConfig>): void {
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["commands"], (commandCtx: CommandHost & InjectableContext) => {
    let sessions: DshCleanerSessionStore | undefined;
    if (typeof commandCtx.inject === "function") {
      commandCtx.inject(["sessions"], (sessionCtx: { sessions?: DshCleanerSessionStore }) => {
        sessions = sessionCtx.sessions;
      });
    }

    registerContextCleanerCommands(commandCtx, config, {
      getSessions: () => sessions,
    });

    if (typeof commandCtx.inject !== "function") return;
    commandCtx.inject(["sessionProjections"], (projectionCtx: ProjectionHost) => {
      registerTokenPilotProjection(projectionCtx, config.enabled);
      registerTokenPilotCommands(
        {
          commands: commandCtx.commands,
          sessionProjections: projectionCtx.sessionProjections,
        },
      );
    });
  });
}

function registerRuntime(ctx: InjectableContext, config: ReturnType<typeof normalizeDshConfig>): void {
  if (!config.enabled || typeof ctx.inject !== "function") return;
  ctx.inject(["tokenMeter"], (runtimeCtx: RuntimeHost) => {
    const cleanerState = createDshCleanerPreStepState();
    // Both Cleaner and eviction prepend. Register eviction first so Cleaner is
    // at the front: Cleaner -> automatic eviction (unless claimed) -> DSH's
    // native compaction handler.
    registerEvictionPreStep(runtimeCtx, config, undefined, {
      shouldSkipAutomaticEviction: (payload) => cleanerState.wasClaimed(payload),
    });
    registerDshCleanerPreStep(runtimeCtx, config, cleanerState);
  });
}

/** Cordis plugin entry. */
export function apply(ctx: unknown, rawConfig?: unknown): void {
  const config = normalizeDshConfig(rawConfig);
  const injectable = ctx as InjectableContext;
  registerCommands(injectable, config);
  registerRuntime(injectable, config);
}
