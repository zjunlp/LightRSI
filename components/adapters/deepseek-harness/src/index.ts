/**
 * TokenPilot DeepSeek Harness plugin entry (Cordis).
 *
 * DSH's plugin loader calls `apply(ctx, config)` with the live plugin context
 * and the profile/bundle config patch. This module is intentionally tiny: it
 * normalizes config and, when enabled, registers the eviction handler on
 * `agent/pre-step`. Everything else lives in the sibling modules.
 *
 * `ctx` is typed against the structural `DshPluginContext` bridge, so this
 * package needs no `@deepseek-ai/cordis` import — the real Cordis context
 * satisfies the subset used here. `inject` tells DSH which services to make
 * available before `apply` runs.
 *
 * The master flag remains default-off. When enabled, mutation additionally
 * requires a configured estimator and durable LightRSI state directory.
 */

import { normalizeDshConfig } from "./config.js";
import { registerEvictionPreStep } from "./eviction-engine.js";
import type { DshPluginContext } from "./types.js";

/** Cordis plugin name. */
export const name = "tokenpilot-dsh";

/** Host services DSH must provide before `apply` runs. */
export const inject = ["tokenMeter"];

/** Cordis plugin entry. */
export function apply(ctx: DshPluginContext, rawConfig?: unknown): void {
  const config = normalizeDshConfig(rawConfig);
  if (!config.enabled) return; // master flag off: attach nothing
  registerEvictionPreStep(ctx, config);
}

export default apply;
