/**
 * Public product metadata for DeepSeek Harness.
 *
 * The native DSH command obtains live sessions through Cordis. This module is
 * intentionally limited to discovery/configuration and re-exports the public
 * Cleaner capability factory, so a CLI product never reaches into DSH events
 * or a session surface directly.
 */

import { readFile } from "node:fs/promises";

import { readLatestUxEffect } from "@lightrsi/host-adapter";
import { defineProductHostRegistration } from "@lightrsi/product-surface";

import { normalizeDshConfig } from "./config.js";

export { createDshCleanerCapabilities, type DshCleanerCapabilityParams } from "./context-cleaner/capabilities.js";

/** Resolve only the LightRSI-owned state directory; never read a DSH session here. */
export function resolveDshStateDir(config: unknown): string | undefined {
  return normalizeDshConfig(config).stateDir;
}

async function loadConfiguredStateDir(productConfigPath?: string): Promise<string | undefined> {
  const environment = process.env.TOKENPILOT_DSH_STATE_DIR?.trim();
  if (environment) return environment;
  const path = productConfigPath?.trim();
  if (!path) return undefined;
  try {
    return resolveDshStateDir(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export const DSH_PRODUCT_HOST_REGISTRATION = defineProductHostRegistration({
  hostId: "deepseek-harness",
  displayName: "DeepSeek Harness",
  preset: { presetId: "tokenpilot-dsh", presetVersion: "1" },
  resolveStateDir(context) {
    return loadConfiguredStateDir(context?.productConfigPath);
  },
  readLatestActivity: readLatestUxEffect,
});
