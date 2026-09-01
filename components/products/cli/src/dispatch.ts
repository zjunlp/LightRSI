import type { ProductCommandResult } from "@lightrsi/host-adapter";
import {
  readCliContextState,
  updateCliContextState,
} from "./context-store.js";
import type { CliHostPathOverrides } from "./context-store.js";
import { CLI_HOSTS, parseCliHostId, resolveLatestCliReportHost, type CliHostId } from "./hosts/registry.js";
import { createCliHostRuntime, registerBuiltInCliHostProducts } from "./hosts/factory.js";
import { handleStandaloneVisualCommandWithSelection } from "./hosts/visual.js";
import {
  cleanSessionIdFromArgs,
  formatCleanUsage,
  handleCleanCommand,
  resolveCleanCommandBackend,
} from "./clean.js";
import { formatCliUsage } from "./usage.js";

registerBuiltInCliHostProducts();

type HostTarget = {
  host: CliHostId;
  sessionId?: string;
  pathOverrides?: CliHostPathOverrides;
};

function currentEnvPathOverrides(host: CliHostId): CliHostPathOverrides | undefined {
  if (host === "codex") {
    const tokenPilotConfigPath = process.env.TOKENPILOT_CODEX_CONFIG?.trim();
    const hostConfigPath = process.env.CODEX_CONFIG_PATH?.trim();
    const hostAuxConfigPath = process.env.CODEX_HOOKS_CONFIG_PATH?.trim();
    return tokenPilotConfigPath || hostConfigPath || hostAuxConfigPath
      ? { tokenPilotConfigPath, hostConfigPath, hostAuxConfigPath }
      : undefined;
  }
  if (host === "claude-code") {
    const tokenPilotConfigPath = process.env.TOKENPILOT_CLAUDE_CODE_CONFIG?.trim();
    const hostConfigPath = process.env.CLAUDE_CODE_SETTINGS_PATH?.trim();
    const hostAuxConfigPath = process.env.CLAUDE_CODE_MCP_CONFIG_PATH?.trim();
    return tokenPilotConfigPath || hostConfigPath || hostAuxConfigPath
      ? { tokenPilotConfigPath, hostConfigPath, hostAuxConfigPath }
      : undefined;
  }
  return undefined;
}

function parseBooleanContextCommand(args: string[]): boolean {
  return args.length === 1 && args[0] === "context";
}

async function resolvePathOverrides(host: CliHostId): Promise<CliHostPathOverrides | undefined> {
  return currentEnvPathOverrides(host) ?? (await readCliContextState()).configPathsByHost?.[host];
}

async function resolveDefaultTarget(): Promise<HostTarget | undefined> {
  const state = await readCliContextState();
  const host = state.lastActiveHost;
  if (!host) return undefined;
  const sessionId = state.lastSessionByHost?.[host];
  const pathOverrides = state.configPathsByHost?.[host];
  return { host, sessionId, pathOverrides };
}

async function resolveTarget(argv: string[]): Promise<{
  target?: HostTarget;
  commandArgs: string[];
  handledText?: string;
}> {
  if (parseBooleanContextCommand(argv)) {
    const state = await readCliContextState();
    const lines = [
      "LightRSI CLI context:",
      `- lastActiveHost: ${state.lastActiveHost ?? "(unset)"}`,
      ...CLI_HOSTS.map((host) => `- ${host.hostId} session: ${state.lastSessionByHost?.[host.hostId] ?? "(unset)"}`),
      ...CLI_HOSTS.map((host) => {
        const overrides = state.configPathsByHost?.[host.hostId];
        const summary = [
          overrides?.tokenPilotConfigPath,
          overrides?.hostConfigPath,
          overrides?.hostAuxConfigPath,
        ].filter(Boolean);
        return `- ${host.hostId} config target: ${summary.length > 0 ? summary.join(" | ") : "(unset)"}`;
      }),
      `- lastUpdatedAt: ${state.lastUpdatedAt ?? "(unset)"}`,
    ];
    return { commandArgs: [], handledText: lines.join("\n") };
  }

  if (argv[0] === "use") {
    const host = parseCliHostId(argv[1]);
    if (!host) {
      return { commandArgs: [], handledText: `Unknown host.\n\n${formatCliUsage()}` };
    }
    if (argv[2] === "session") {
      let sessionId = String(argv[3] ?? "").trim();
      if (!sessionId) {
        return { commandArgs: [], handledText: "Missing session id." };
      }
      const runtime = createCliHostRuntime({
        host,
        sessionId,
        pathOverrides: await resolvePathOverrides(host),
      });
      sessionId = (await runtime.resolveSessionId(sessionId)) ?? sessionId;
      await updateCliContextState({ host, sessionId, pathOverrides: await resolvePathOverrides(host) });
      return { commandArgs: [], handledText: `Default context = ${host} / ${sessionId}` };
    }
    await updateCliContextState({ host, pathOverrides: await resolvePathOverrides(host) });
    return { commandArgs: [], handledText: `Default host = ${host}` };
  }

  const explicitHost = parseCliHostId(argv[0]);
  if (explicitHost) {
    if (argv[1] === "session") {
      const sessionId = String(argv[2] ?? "").trim();
      const commandArgs = argv.slice(3);
      return {
        target: {
          host: explicitHost,
          sessionId: sessionId || undefined,
          pathOverrides: await resolvePathOverrides(explicitHost),
        },
        commandArgs,
      };
    }
    return {
      target: { host: explicitHost, pathOverrides: await resolvePathOverrides(explicitHost) },
      commandArgs: argv.slice(1),
    };
  }

  const defaultTarget = await resolveDefaultTarget();
  return {
    target: defaultTarget,
    commandArgs: argv,
  };
}

export async function dispatchCli(argv: string[]): Promise<ProductCommandResult> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { text: formatCliUsage() };
  }

  const resolved = await resolveTarget(argv);
  if (resolved.handledText) {
    return { text: resolved.handledText };
  }

  const { target, commandArgs } = resolved;
  if (commandArgs.length === 1 && commandArgs[0] === "visual") {
    return handleStandaloneVisualCommandWithSelection({
      host: target?.host,
      sessionId: target?.sessionId,
    });
  }
  if (!target) {
    return {
      text: `No default host is selected.\n\n${formatCliUsage()}`,
    };
  }
  if (commandArgs.length === 0) {
    return {
      text: formatCliUsage(),
    };
  }

  let effectiveTarget = target;
  let latestReportNotice: string | undefined;
  if (
    argv.length > 0
    && commandArgs.length === 1
    && commandArgs[0] === "report"
    && !parseCliHostId(argv[0])
  ) {
    const latestHost = await resolveLatestCliReportHost();
    if (latestHost) {
      effectiveTarget = {
        host: latestHost.hostId,
        sessionId: latestHost.hostId === target.host ? target.sessionId : undefined,
        pathOverrides: await resolvePathOverrides(latestHost.hostId),
      };
      latestReportNotice = `Showing latest TokenPilot report from ${latestHost.displayName} (${latestHost.latestAt}).`;
    }
  }

  const runtime = createCliHostRuntime({
    host: effectiveTarget.host,
    sessionId: effectiveTarget.sessionId,
    pathOverrides: await resolvePathOverrides(effectiveTarget.host) ?? effectiveTarget.pathOverrides,
  });
  if (commandArgs[0] === "clean") {
    if (commandArgs.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
      return { text: formatCleanUsage() };
    }
    const requestedSessionId = cleanSessionIdFromArgs(commandArgs.slice(1)) ?? effectiveTarget.sessionId;
    const resolvedSessionId = requestedSessionId
      ? await runtime.resolveSessionId(requestedSessionId)
      : await runtime.maybeResolveLatestSessionId();
    const cleanPathOverrides = await resolvePathOverrides(effectiveTarget.host)
      ?? effectiveTarget.pathOverrides;
    const backend = await resolveCleanCommandBackend({
      hostId: effectiveTarget.host,
      sessionId: resolvedSessionId,
      pathOverrides: cleanPathOverrides,
    });
    if (!backend) {
      return {
        text: `Context Cleaner is not registered for ${effectiveTarget.host} yet.`,
      };
    }
    const result = await handleCleanCommand({
      args: commandArgs.slice(1),
      sessionId: resolvedSessionId,
      backend,
    });
    await updateCliContextState({
      host: effectiveTarget.host,
      sessionId: resolvedSessionId,
      pathOverrides: cleanPathOverrides,
    });
    return result;
  }
  const result = await runtime.handleCommand({
    args: commandArgs.join(" "),
    sessionId: effectiveTarget.sessionId,
  });

  const resolvedSessionId = effectiveTarget.sessionId
    ? await runtime.resolveSessionId(effectiveTarget.sessionId)
    : await runtime.maybeResolveLatestSessionId();
  await updateCliContextState({
    host: effectiveTarget.host,
    sessionId: resolvedSessionId,
    pathOverrides: await resolvePathOverrides(effectiveTarget.host) ?? effectiveTarget.pathOverrides,
  });
  if (latestReportNotice && result.text.startsWith("TokenPilot report:")) {
    return { text: `${latestReportNotice}\n${result.text}` };
  }
  return result;
}
