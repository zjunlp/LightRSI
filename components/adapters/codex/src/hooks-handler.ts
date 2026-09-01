#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  defaultCodexConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
} from "./config.js";
import {
  readDaemonStatus,
  startDaemon,
} from "./daemon.js";
import { resolveCodexSessionAlias, upsertCodexSessionSnapshot } from "./session-state.js";
import { appendTrace } from "./trace.js";
import { dirname, join } from "node:path";

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findFirstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pending: object[] = [value as object];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const obj = current as Record<string, unknown>;
    for (const key of keys) {
      const direct = stringValue(obj[key]);
      if (direct) return direct;
    }
    for (const child of Object.values(obj)) {
      if (child && typeof child === "object") {
        pending.push(child as object);
      }
    }
  }
  return undefined;
}

function estimateTextChars(value: unknown): number {
  let total = 0;
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      total += current.length;
      continue;
    }
    if (current == null) continue;
    if (typeof current === "object") {
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...Object.values(current as Record<string, unknown>));
      continue;
    }
    total += String(current).length;
  }
  return total;
}

function hookErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportObservationFailure(hookEventName: string, operation: string, error: unknown): void {
  console.error(
    `[tokenpilot-codex] ${hookEventName} ${operation} failed; continuing without hook telemetry: ${hookErrorMessage(error)}`,
  );
}

function extractToolEvent(input: Record<string, unknown>): {
  toolName: string | null;
  toolInputChars: number;
  toolOutputChars: number;
} {
  const toolName = findFirstString(input, ["tool_name", "toolName", "name", "tool"]);
  const outputLike =
    (input.tool_response ?? input.toolResponse ?? input.response ?? input.result ?? input.output) as unknown;
  const inputLike =
    (input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? input.args) as unknown;
  return {
    toolName: toolName ?? null,
    toolInputChars: estimateTextChars(inputLike),
    toolOutputChars: estimateTextChars(outputLike),
  };
}

function workspaceHintFromEvent(input: Record<string, unknown>): string | undefined {
  return findFirstString(input, [
    "cwd",
    "workspace",
    "workspace_path",
    "workspacePath",
    "project_root",
    "projectRoot",
  ]);
}

function successOutputForHook(hookEventName: string): string | undefined {
  if (hookEventName === "Stop") {
    return "{\"continue\":true}\n";
  }
  return undefined;
}

function writeSuccessOutput(hookEventName: string): void {
  const output = successOutputForHook(hookEventName);
  if (typeof output === "string" && output.length > 0) {
    process.stdout.write(output);
  }
}

export async function processCodexHookEvent(event: Record<string, unknown>): Promise<string | undefined> {
  const hookEventName = stringValue(event.hook_event_name) ?? stringValue(event.event) ?? "unknown";
  const configPath = process.env.TOKENPILOT_CODEX_CONFIG ?? defaultTokenPilotConfigPath();
  const codexConfigPath = process.env.CODEX_CONFIG_PATH ?? defaultCodexConfigPath();
  const config = await loadTokenPilotCodexConfig(configPath);
  const codexSessionId = stringValue(event.session_id);
  const sessionId = codexSessionId
    ? await resolveCodexSessionAlias(config.stateDir, codexSessionId) ?? codexSessionId
    : undefined;
  const workspaceHint = workspaceHintFromEvent(event);
  const transcriptPath = stringValue(event.transcript_path);
  const hookModel = stringValue(event.model);
  const tool = extractToolEvent(event);
  const common = {
    hookEventName,
    codexSessionId: codexSessionId ?? null,
    sessionId: sessionId ?? null,
    transcriptPath: transcriptPath ?? null,
    cwd: workspaceHint ?? null,
    model: hookModel ?? null,
  };

  if (sessionId) {
    try {
      await upsertCodexSessionSnapshot(config.stateDir, sessionId, {
        codexSessionId,
        latestModel: hookModel,
        workspaceHint,
        transcriptPath,
        lastHookEvent: hookEventName,
        lastToolName: tool.toolName ?? undefined,
        lastToolInputChars: tool.toolInputChars,
        lastToolOutputChars: tool.toolOutputChars,
      }, {
        markLatest: false,
      });
    } catch (error) {
      if (hookEventName === "SessionStart") throw error;
      reportObservationFailure(hookEventName, "session snapshot", error);
    }
  }

  if (hookEventName === "SessionStart") {
    const defaultCliPath = join(dirname(process.argv[1]), "cli.js");
    const daemon = await startDaemon(config, {
      configPath,
      codexConfigPath,
      cliPath: process.env.TOKENPILOT_CODEX_CLI ?? defaultCliPath,
    });
    await appendTrace(config.stateDir, {
      stage: "codex_hook_session_start",
      ...common,
      daemon,
    });
    return successOutputForHook(hookEventName);
  }

  if (hookEventName === "PostToolUse") {
    try {
      await appendTrace(config.stateDir, {
        stage: "codex_hook_post_tool_use",
        ...common,
        ...tool,
      });
    } catch (error) {
      reportObservationFailure(hookEventName, "trace append", error);
    }
    return successOutputForHook(hookEventName);
  }

  if (hookEventName === "PreToolUse") {
    try {
      await appendTrace(config.stateDir, {
        stage: "codex_hook_pre_tool_use",
        ...common,
        ...tool,
      });
    } catch (error) {
      reportObservationFailure(hookEventName, "trace append", error);
    }
    return successOutputForHook(hookEventName);
  }

  if (hookEventName === "Stop") {
    try {
      const daemon = await readDaemonStatus(config);
      await appendTrace(config.stateDir, {
        stage: "codex_hook_stop",
        ...common,
        daemon,
      });
    } catch (error) {
      reportObservationFailure(hookEventName, "trace append", error);
    }
    return successOutputForHook(hookEventName);
  }

  await appendTrace(config.stateDir, {
    stage: "codex_hook_observed",
    ...common,
  });
  return successOutputForHook(hookEventName);
}

async function main() {
  let event: Record<string, unknown>;
  try {
    event = await readStdinJson();
  } catch (err) {
    console.error(`hook input parse failed; continuing without hook action: ${hookErrorMessage(err)}`);
    writeSuccessOutput("Stop");
    return;
  }
  const output = await processCodexHookEvent(event);
  if (typeof output === "string" && output.length > 0) {
    process.stdout.write(output);
  }
}

const entryArg = process.argv[1];
const isDirectExecution = typeof entryArg === "string"
  && entryArg.endsWith("hooks-handler.js");

if (isDirectExecution) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
