/**
 * Regression matrix: repeat-read disclosure carried across Codex requests
 * (src/reduction.ts, src/session-state.ts)
 *
 * The tool_payload_trim pass leaves a file read untrimmed when its path was already
 * disclosed (the model re-reading a file it saw summarised wants the full body).
 * Codex resends the whole input history on every request, so the adapter must not
 * hand the pass a path whose disclosing read is still in the history: the pass would
 * then treat that same read as a repeat and send it untrimmed (prompt-cache miss).
 *
 * normalizeDisclosedReadOwners
 *   O1 non-objects/arrays → undefined; keys trimmed + lowercased, blank keys dropped;
 *      non-string or empty owners → null
 * carriedDisclosedReadPaths
 *   O2 no owners → undefined; owner present → not carried; owner absent → carried;
 *      null owner → carried
 * recordDisclosedReadOwners
 *   O3 no reported paths → unchanged; a new path is owned by the call_id of the first
 *      eligible trimmed read with that path; no matching segment → null; a known path
 *      keeps its owner
 *   O4 a non-read tool using the same path cannot become the disclosure owner
 *   O5 owners not present in the bounded reported path set are discarded
 * applyBeforeCallReductionToPayload + snapshot (as the proxy persists it)
 *   D1 the same read still in history on the next request stays trimmed and
 *      byte-identical (regression)
 *   D2 once the disclosing read has left history, a new read of the same path is sent
 *      in full (existing progressive-disclosure behaviour kept)
 *   D3 a legacy snapshot with only disclosedReadPaths (no owners) is ignored: the read
 *      is trimmed
 *   D4 owners round-trip through upsertCodexSessionSnapshot and survive
 *      mergeCodexSessionSnapshot
 *   D5 when two reads share a path, ownership follows the read actually trimmed;
 *      removing an earlier untrimmed read does not make the retained read expand
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ContextSegment } from "@lightrsi/kernel";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import {
  applyBeforeCallReductionToPayload,
  carriedDisclosedReadPaths,
  normalizeDisclosedReadOwners,
  recordDisclosedReadOwners,
} from "../src/reduction.js";
import { loadCodexSessionSnapshot, mergeCodexSessionSnapshot, upsertCodexSessionSnapshot } from "../src/session-state.js";

const CODE = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  return input.trim() + "${i}";\n}\n`).join("\n");
const PATH = "/repo/src/handlers.ts";

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "codex-disclosed-"));
  return { stateDir, config: normalizeTokenPilotCodexConfig({ stateDir }) };
}

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
function readTurn(callId: string) {
  return readTurnWithContent(callId, CODE);
}

function readTurnWithContent(callId: string, output: string) {
  return [
    { type: "function_call", call_id: callId, name: "Read", arguments: JSON.stringify({ path: PATH }) },
    { type: "function_call_output", call_id: callId, output },
  ];
}
const shellTurn = [
  { type: "function_call", call_id: "call_sh", name: "shell", arguments: JSON.stringify({ command: ["echo", "hi"] }) },
  { type: "function_call_output", call_id: "call_sh", output: "hi" },
];

/** One proxy request: reduce, then persist the disclosure fields the way the proxy does after the response. */
async function request(env: Awaited<ReturnType<typeof setup>>, sessionId: string, input: unknown[]) {
  const payload: any = { model: "m", input: structuredClone(input) };
  const summary = await applyBeforeCallReductionToPayload({ payload, sessionId, config: env.config });
  await upsertCodexSessionSnapshot(env.stateDir, sessionId, {
    disclosedReadPaths: summary.disclosedReadPaths,
    disclosedReadOwners: summary.disclosedReadOwners,
  });
  return { payload, summary };
}

test("O1 normalizeDisclosedReadOwners", () => {
  for (const junk of [undefined, null, "x", 3, ["/a"]]) assert.equal(normalizeDisclosedReadOwners(junk), undefined);
  assert.deepEqual(
    normalizeDisclosedReadOwners({ " /Repo/A.ts ": "call_1", "  ": "call_2", "/b": 5, "/c": "", "/d": null }),
    { "/repo/a.ts": "call_1", "/b": null, "/c": null, "/d": null },
  );
});

test("O2 carriedDisclosedReadPaths", () => {
  assert.equal(carriedDisclosedReadPaths(undefined, new Set()), undefined);
  const owners = { "/present": "call_1", "/gone": "call_2", "/unowned": null };
  assert.deepEqual(carriedDisclosedReadPaths(owners, new Set(["call_1"])), ["/gone", "/unowned"]);
  assert.equal(carriedDisclosedReadPaths({ "/present": "call_1" }, new Set(["call_1"])), undefined);
});

test("O3 recordDisclosedReadOwners", () => {
  const segments = [
    { id: "input-2-output", kind: "volatile", text: "x", priority: 0, metadata: { path: "/Repo/A.ts" } },
    { id: "input-4-output", kind: "volatile", text: "x", priority: 0, metadata: { path: "/repo/a.ts" } },
  ] as ContextSegment[];
  const bindings = [
    { segmentId: "input-2-output", itemIndex: 2, field: "output" as const, toolName: "Read", callId: "call_first" },
    { segmentId: "input-4-output", itemIndex: 4, field: "output" as const, toolName: "Read", callId: "call_second" },
  ];
  const known = { "/known": "call_old" };
  assert.equal(recordDisclosedReadOwners(known, undefined, segments, bindings, new Set()), known);
  assert.deepEqual(
    recordDisclosedReadOwners(
      known,
      ["/repo/a.ts", "/elsewhere.ts", "/known"],
      segments,
      bindings,
      new Set(["input-2-output", "input-4-output"]),
    ),
    { "/known": "call_old", "/repo/a.ts": "call_first", "/elsewhere.ts": null },
  );
});

test("O4 recordDisclosedReadOwners assigns a same-path disclosure only to a read", () => {
  const segments = [
    { id: "write-output", kind: "volatile", text: "wrote 1 byte", priority: 0, metadata: { path: "/repo/a.ts" } },
    { id: "read-output", kind: "volatile", text: "file contents", priority: 0, metadata: { path: "/repo/a.ts" } },
  ] as ContextSegment[];
  const bindings = [
    { segmentId: "write-output", itemIndex: 2, field: "output" as const, toolName: "Write", callId: "call_write" },
    { segmentId: "read-output", itemIndex: 4, field: "output" as const, toolName: "Read", callId: "call_read" },
  ];
  assert.deepEqual(
    recordDisclosedReadOwners(undefined, ["/repo/a.ts"], segments, bindings, new Set(["write-output", "read-output"])),
    { "/repo/a.ts": "call_read" },
  );
});

test("O5 recordDisclosedReadOwners keeps only the bounded reported path set", () => {
  const existing = Object.fromEntries(
    Array.from({ length: 130 }, (_, index) => [`/repo/file-${index}.ts`, `call_${index}`]),
  );
  const reported = Array.from({ length: 128 }, (_, index) => `/repo/file-${index + 2}.ts`);
  const owners = recordDisclosedReadOwners(existing, reported, [], [], new Set());
  assert.equal(Object.keys(owners ?? {}).length, 128);
  assert.equal(owners?.["/repo/file-0.ts"], undefined);
  assert.equal(owners?.["/repo/file-1.ts"], undefined);
  assert.equal(owners?.["/repo/file-2.ts"], "call_2");
  assert.equal(owners?.["/repo/file-129.ts"], "call_129");
});

test("D1 the same read still in history stays trimmed on the next request", async () => {
  const env = await setup();
  const first = await request(env, "d1", [user("read it"), ...readTurn("call_r1")]);
  assert.ok(String(first.payload.input[2].output).length < CODE.length, "precondition: the first read is trimmed");
  const second = await request(env, "d1", [user("read it"), ...readTurn("call_r1"), ...shellTurn]);
  assert.equal(String(second.payload.input[2].output), String(first.payload.input[2].output));
});

test("D2 a new read of the same path after the first left history is sent in full", async () => {
  const env = await setup();
  const first = await request(env, "d2", [user("read it"), ...readTurn("call_r1")]);
  assert.ok(String(first.payload.input[2].output).length < CODE.length);
  const second = await request(env, "d2", [user("summary, then read it again in full"), ...readTurn("call_r2")]);
  assert.equal(second.payload.input[2].output, CODE);
});

test("D3 a legacy snapshot without owners does not force reads untrimmed", async () => {
  const env = await setup();
  await upsertCodexSessionSnapshot(env.stateDir, "d3", { disclosedReadPaths: [PATH] });
  const out = await request(env, "d3", [user("read it"), ...readTurn("call_r1")]);
  assert.ok(String(out.payload.input[2].output).length < CODE.length);
});

test("D4 owners round-trip through the snapshot and survive a session merge", async () => {
  const env = await setup();
  await request(env, "d4-source", [user("read it"), ...readTurn("call_r1")]);
  assert.deepEqual((await loadCodexSessionSnapshot(env.stateDir, "d4-source"))?.disclosedReadOwners, { [PATH]: "call_r1" });
  await upsertCodexSessionSnapshot(env.stateDir, "d4-source", { lastToolName: "shell" });
  assert.deepEqual((await loadCodexSessionSnapshot(env.stateDir, "d4-source"))?.disclosedReadOwners, { [PATH]: "call_r1" });
  const merged = await mergeCodexSessionSnapshot(env.stateDir, "d4-source", "d4-target");
  assert.deepEqual(merged?.disclosedReadOwners, { [PATH]: "call_r1" });
});

test("D5 ownership follows the same-path read actually trimmed", async () => {
  const env = await setup();
  const first = await request(env, "d5", [user("read it twice"), ...readTurnWithContent("call_short", "not found"), ...readTurn("call_long")]);
  const firstLongOutput = String(first.payload.input[4].output);
  assert.ok(firstLongOutput.length < CODE.length, "precondition: only the long read is trimmed");
  assert.deepEqual(first.summary.disclosedReadOwners, { [PATH]: "call_long" });

  const second = await request(env, "d5", [user("continue after history compaction"), ...readTurn("call_long")]);
  const secondLongOutput = String(second.payload.input[2].output);
  assert.ok(secondLongOutput.length < CODE.length, "the retained long read must not expand back to full content");
  // The segment id is positional, so the content-derived archive path moves with the read.
  const normalizeArchiveLocation = (text: string) => text.replace(/^Archive: .+$/m, "Archive: <location>");
  assert.equal(normalizeArchiveLocation(secondLongOutput), normalizeArchiveLocation(firstLongOutput));
});
