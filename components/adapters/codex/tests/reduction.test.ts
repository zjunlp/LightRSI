import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { createCodexResponsesPayloadCodec } from "../src/responses-codec.js";
import {
  applyBeforeCallReductionToPayload,
  normalizeResponsesInputForUpstream,
  reduceCodexRequestEnvelope,
} from "../src/reduction.js";
import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { loadCodexSessionSnapshot, upsertCodexSessionSnapshot } from "../src/session-state.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalLightRsiStateDir = process.env.LIGHTRSI_STATE_DIR;
let reductionSuiteHome = "";

before(async () => {
  reductionSuiteHome = await mkdtemp(join(tmpdir(), "lightrsi-codex-reduction-suite-"));
  process.env.HOME = reductionSuiteHome;
  process.env.USERPROFILE = reductionSuiteHome;
  process.env.LIGHTRSI_STATE_DIR = join(reductionSuiteHome, ".lightrsi", "state");
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalLightRsiStateDir === undefined) delete process.env.LIGHTRSI_STATE_DIR;
  else process.env.LIGHTRSI_STATE_DIR = originalLightRsiStateDir;
  if (reductionSuiteHome) {
    await rm(reductionSuiteHome, { recursive: true, force: true });
  }
});

test("normalizeResponsesInputForUpstream stringifies structured function payloads", () => {
  const input: any[] = [
    {
      type: "function_call",
      arguments: { command: "git status" },
    },
    {
      type: "function_call_output",
      output: { stdout: "ok" },
    },
  ];

  normalizeResponsesInputForUpstream(input);

  assert.equal(input[0].arguments, "{\"command\":\"git status\"}");
  assert.equal(input[1].output, "{\"stdout\":\"ok\"}");
});

test("applyBeforeCallReductionToPayload skips below-threshold payloads", async () => {
  const config = normalizeTokenPilotCodexConfig({
    reduction: {
      triggerMinChars: 5000,
      maxToolChars: 1200,
      passes: {
        readStateCompaction: true,
        toolPayloadTrim: true,
        htmlSlimming: true,
        execOutputTruncation: true,
        agentsStartupOptimization: true,
      },
    },
  });

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      { role: "tool", type: "function_call_output", output: "short tool output" },
    ],
  };

  const result = await applyBeforeCallReductionToPayload({
    payload,
    sessionId: "session-small",
    config,
  });

  assert.equal(result.changedItems, 0);
  assert.equal(result.savedChars, 0);
  assert.equal(result.skippedReason, "below_trigger_min_chars");
});

test("reduceCodexRequestEnvelope trims large tool output and preserves developer role", async () => {
  const config = normalizeTokenPilotCodexConfig({
    reduction: {
      triggerMinChars: 256,
      maxToolChars: 400,
      passes: {
        readStateCompaction: false,
        toolPayloadTrim: true,
        htmlSlimming: false,
        execOutputTruncation: true,
        agentsStartupOptimization: false,
      },
      passOptions: {
        execOutputTruncation: {
          toolThresholds: {
            bash: 400,
          },
        },
      },
    },
  });
  const codec = createCodexResponsesPayloadCodec();
  const longOutput = `HEAD\n${"line\n".repeat(600)}`;
  const envelope = codec.decodeRequest({
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [
      { role: "developer", content: "root prompt" },
      { role: "user", content: "check status" },
      { role: "tool", type: "function_call_output", name: "bash", output: longOutput },
    ],
  });

  const reduced = await reduceCodexRequestEnvelope({
    envelope,
    codec,
    config,
  });

  assert.ok(reduced.summary.savedChars > 0);
  assert.ok(reduced.summary.changedBlocks > 0);
  const encoded = codec.encodeRequest(reduced.envelope) as any;
  assert.equal(encoded.input[0].role, "developer");
  assert.ok(String(encoded.input[2].output).length < longOutput.length);
});

test("applyBeforeCallReductionToPayload reuses disclosed read paths from session snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-codex-reduction-"));
  try {
    const config = normalizeTokenPilotCodexConfig({
      stateDir: join(dir, "state"),
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 400,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: false,
          agentsStartupOptimization: false,
        },
      },
    });
    const codePayload = `
export function loadConfig(file: string) {
  return file.trim();
}

export function saveConfig(file: string, text: string) {
  return text + file;
}
`.repeat(30);

    const firstPayload: any = {
      model: "tokenpilot/gpt-5.4-mini",
      input: [
        {
          type: "function_call",
          call_id: "call_read_1",
          name: "Read",
          arguments: JSON.stringify({ path: "/repo/src/config.ts" }),
        },
        {
          role: "tool",
          type: "function_call_output",
          call_id: "call_read_1",
          output: codePayload,
        },
      ],
    };

    const first = await applyBeforeCallReductionToPayload({
      payload: firstPayload,
      sessionId: "sess-read-1",
      config,
    });
    assert.ok((first.disclosedReadPaths?.length ?? 0) > 0);
    assert.match(String(firstPayload.input[1]?.output ?? ""), /\[code outlined lines=/);

    await upsertCodexSessionSnapshot(config.stateDir, "sess-read-1", {
      disclosedReadPaths: first.disclosedReadPaths,
      disclosedReadOwners: first.disclosedReadOwners,
    });

    const secondPayload: any = {
      model: "tokenpilot/gpt-5.4-mini",
      input: [
        {
          type: "function_call",
          call_id: "call_read_2",
          name: "Read",
          arguments: JSON.stringify({ path: "/repo/src/config.ts" }),
        },
        {
          role: "tool",
          type: "function_call_output",
          call_id: "call_read_2",
          output: codePayload,
        },
      ],
    };

    const second = await applyBeforeCallReductionToPayload({
      payload: secondPayload,
      sessionId: "sess-read-1",
      config,
    });

    assert.ok((second.disclosedReadPaths?.length ?? 0) > 0);
    assert.doesNotMatch(String(secondPayload.input[1]?.output ?? ""), /\[code outlined lines=/);
    assert.match(String(secondPayload.input[1]?.output ?? ""), /export function loadConfig/);

    const snapshot = await loadCodexSessionSnapshot(config.stateDir, "sess-read-1");
    assert.deepEqual(snapshot?.disclosedReadPaths, first.disclosedReadPaths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
