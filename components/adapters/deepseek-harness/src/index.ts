/**
 * TokenPilot DeepSeek Harness plugin entry (Cordis).
 *
 * The existing eviction implementation remains isolated in eviction-engine.
 * This entry only normalizes configuration and wires the available runtime
 * capabilities together.
 *
 * Projection and command services are optional. They are acquired through
 * ctx.inject() so headless compositions without those services still load.
 */

import { normalizeDshConfig } from "./config.js";

import {
  registerTokenPilotCommands,
  type TokenPilotCommandContext,
} from "./commands.js";

import {
  registerEvictionPreStep,
} from "./eviction-engine.js";

import {
  registerTokenPilotProjection,
  type TokenPilotProjectionContext,
} from "./projection.js";

import type {
  DshPluginContext,
} from "./types.js";

/** Cordis plugin name. */
export const name = "tokenpilot-dsh";

/**
 * tokenMeter remains the only mandatory service.
 *
 * sessionProjections and commands are optional capabilities acquired through
 * ctx.inject(), so this change does not alter the existing Cordis bundle.
 */
export const inject = ["tokenMeter"];

type TokenPilotUiContext =
  TokenPilotProjectionContext &
  TokenPilotCommandContext;

interface DshOptionalCapabilityHost {
  inject(
    services: readonly [
      "sessionProjections",
      "commands",
    ],
    callback: (
      ctx: TokenPilotUiContext,
    ) => void,
  ): void;
}

/**
 * Register the read-only whole-session projection and human status command
 * when the host composition provides both optional services.
 */
function registerTokenPilotUi(
  ctx: DshPluginContext,
  enabled: boolean,
): void {
  const optionalCtx = ctx as DshPluginContext & {
    inject?: DshOptionalCapabilityHost["inject"];
  };

  if (typeof optionalCtx.inject !== "function") {
    return;
  }

  optionalCtx.inject(
    [
      "sessionProjections",
      "commands",
    ],
    (featureCtx) => {
      registerTokenPilotProjection(
        featureCtx,
        enabled,
      );

      registerTokenPilotCommands(
        featureCtx,
      );
    },
  );
}

/** Cordis plugin entry. */
export function apply(
  ctx: DshPluginContext,
  rawConfig?: unknown,
): void {
  const config =
    normalizeDshConfig(rawConfig);

  /*
   * The read-only projection and status command can report disabled state.
   * They never create a model turn or mutate the session surface.
   */
  registerTokenPilotUi(
    ctx,
    config.enabled,
  );

  /*
   * The existing mutation path remains strictly default-off.
   * No eviction handler is attached while the master flag is disabled.
   */
  if (!config.enabled) {
    return;
  }

  registerEvictionPreStep(
    ctx,
    config,
  );
}

export default apply;
