import { createProductSurfaceCommandHandler } from "@lightrsi/product-surface";
import { TOKENPILOT_PRODUCT_SURFACE_IDENTITY } from "@lightrsi/tokenpilot";
import type { CliHostPathOverrides } from "../context-store.js";
import { registerCleanCommandBackendResolver } from "../clean.js";
import { createClaudeCodeCleanCommandBackend, createClaudeCodeCliBridge } from "./claude-code.js";
import { createCodexCleanCommandBackend, createCodexCliBridge } from "./codex.js";
import { createOpenClawCliBridge } from "./openclaw.js";
import {
  CLI_HOSTS,
  getCliHostRegistration,
  registerCliHostProducts,
  type CliHostId,
  type CliHostRegistration,
  type CliHostRuntime,
} from "./registry.js";

export type { CliHostPathOverrides } from "../context-store.js";
export type { CliHostRuntime } from "./registry.js";

const CLI_HOST_REGISTRATIONS: CliHostRegistration[] = CLI_HOSTS.map((host) => ({
  ...host,
  createRuntime(target) {
    if (host.hostId === "codex") {
      return createCodexCliBridge({
        host: "codex",
        sessionId: target.sessionId,
        pathOverrides: target.pathOverrides,
      });
    }
    if (host.hostId === "claude-code") {
      return createClaudeCodeCliBridge({
        host: "claude-code",
        sessionId: target.sessionId,
        pathOverrides: target.pathOverrides,
      });
    }
    const bridge = createOpenClawCliBridge({ host: "openclaw", sessionId: target.sessionId });
    const handler = createProductSurfaceCommandHandler({
      bridge: bridge.bridge,
      configAdapter: bridge.configAdapter,
      identity: TOKENPILOT_PRODUCT_SURFACE_IDENTITY,
    });
    return {
      handleCommand(ctx) {
        return handler(ctx);
      },
      maybeResolveLatestSessionId: bridge.maybeResolveLatestSessionId,
      resolveSessionId(sessionId?: string) {
        return bridge.resolveSessionId(sessionId);
      },
    };
  },
}));

export function registerBuiltInCliHostProducts(): void {
  registerCliHostProducts(CLI_HOST_REGISTRATIONS);
  registerCleanCommandBackendResolver(({ hostId, pathOverrides }) => {
    if (hostId === "codex") return createCodexCleanCommandBackend(pathOverrides);
    if (hostId === "claude-code") return createClaudeCodeCleanCommandBackend(pathOverrides);
    return undefined;
  });
}

export function createCliHostRuntime(target: {
  host: CliHostId;
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
}): CliHostRuntime {
  return getCliHostRegistration(target.host).createRuntime(target);
}
