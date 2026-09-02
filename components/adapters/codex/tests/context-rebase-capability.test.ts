import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  appendCodexRebaseCapability,
  acquireCodexRebaseSessionLock,
  classifyCodexRebaseCapabilityRejection,
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA,
  CODEX_REBASE_CAPABILITY_SCHEMA,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  codexRebaseCapabilityJournalPath,
  codexRebaseEndpointIdentity,
  codexRebasePayloadItems,
  executeCodexRebaseWithFallback,
  readCodexRebaseCapabilityJournal,
  readCodexRebaseEpochJournal,
  resolveCodexProviderReplayCompatibility,
  type CodexRebaseCapabilityEvidence,
  type CodexRebaseCapabilityStoreParams,
  type JsonObject,
} from "../src/context-rewrite/index.js";

async function withTempState(
  fn: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-rebase-capability-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function capabilityStore(
  stateDir: string,
  model = "gpt-5.4-mini",
  options: Partial<CodexRebaseCapabilityStoreParams> = {},
): CodexRebaseCapabilityStoreParams {
  return {
    stateDir,
    provider: "OpenAI",
    model,
    wireMode: CODEX_REBASE_WIRE_MODE,
    apiVersion: CODEX_REBASE_API_VERSION,
    endpointId: codexRebaseEndpointIdentity("https://api.openai.example/v1"),
    itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
    acceptedEvidence: ["real_provider", "mock_fixture"],
    evidenceSource: "mock_fixture",
    ...options,
  };
}

async function appendCapability(params: {
  stateDir: string;
  model?: string;
  itemType: string;
  status: "verified_supported" | "verified_unsupported" | "payload_rejected";
  evidence?: CodexRebaseCapabilityEvidence;
  payloadDigest?: string;
  reason?: string;
  observedAt?: string;
  ttlMs?: number;
  storeOverrides?: Partial<CodexRebaseCapabilityStoreParams>;
}) {
  const store = capabilityStore(params.stateDir, params.model, params.storeOverrides);
  return appendCodexRebaseCapability({
    ...store,
    itemType: params.itemType,
    status: params.status,
    evidence: params.evidence ?? "real_provider",
    payloadDigest: params.payloadDigest,
    reason: params.reason,
    observedAt: params.observedAt,
    ttlMs: params.ttlMs,
  });
}

async function decisionsFor(params: {
  stateDir: string;
  payload: JsonObject;
  model?: string;
  now?: string;
  acceptedEvidence?: CodexRebaseCapabilityEvidence[];
  storeOverrides?: Partial<CodexRebaseCapabilityStoreParams>;
}) {
  const store = capabilityStore(params.stateDir, params.model, params.storeOverrides);
  return resolveCodexProviderReplayCompatibility({
    ...store,
    items: codexRebasePayloadItems(params.payload),
    now: params.now,
    acceptedEvidence: params.acceptedEvidence,
  });
}

test("CDR-05 capability journal waits for its owner when the wall clock jumps forward", async () => {
  await withTempState(async (stateDir) => {
    const owner = await acquireCodexRebaseSessionLock({
      stateDir,
      sessionId: "__provider-capabilities-journal__",
    });
    assert.ok(owner);

    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => (calls++ === 0 ? 1_000 : 12_000);
    try {
      const releaseTimer = setTimeout(() => {
        void owner.release();
      }, 30);
      const capability = await appendCapability({
        stateDir,
        itemType: "message",
        status: "verified_supported",
      });
      clearTimeout(releaseTimer);
      assert.equal(capability.itemType, "message");
    } finally {
      Date.now = originalNow;
      await owner.release();
    }
  });
});

test("CDR-05 Provider Compatibility binds decisions to provider, model, wire, API, endpoint, item schema, and TTL", async () => {
  await withTempState(async (stateDir) => {
    await appendCapability({
      stateDir,
      itemType: "message",
      status: "verified_supported",
      observedAt: "2026-08-06T00:00:00.000Z",
      ttlMs: 60_000,
    });

    const supported = await decisionsFor({
      stateDir,
      payload: { input: [{ role: "user", content: "current" }] },
      now: "2026-08-06T00:00:30.000Z",
    });
    assert.equal(supported.journalTrusted, true);
    assert.equal(supported.decisions[0]?.status, "verified_supported");
    assert.equal(supported.decisions[0]?.evidence, "real_provider");

    const expired = await decisionsFor({
      stateDir,
      payload: { input: [{ role: "user", content: "current" }] },
      now: "2026-08-06T00:01:01.000Z",
    });
    assert.equal(expired.decisions[0]?.status, "unknown_probe_required");
    assert.equal(expired.decisions[0]?.reason, "capability_expired");

    for (const storeOverrides of [
      { apiVersion: "responses/v2" },
      { wireMode: "chat_completions" },
      { endpointId: codexRebaseEndpointIdentity("https://other.example/v1") },
      { itemSchemaVersion: "responses-item/v3" },
    ]) {
      const changed = await decisionsFor({
        stateDir,
        payload: { input: [{ role: "user", content: "current" }] },
        now: "2026-08-06T00:00:30.000Z",
        storeOverrides,
      });
      assert.equal(changed.decisions[0]?.status, "unknown_probe_required");
      assert.equal(changed.decisions[0]?.reason, "capability_not_observed");
    }
  });
});

test("CDR-05 Provider Compatibility supports supported, unsupported, and revalidated-supported transitions", async () => {
  await withTempState(async (stateDir) => {
    for (const [status, observedAt] of [
      ["verified_supported", "2026-08-06T00:00:00.000Z"],
      ["verified_unsupported", "2026-08-06T00:01:00.000Z"],
      ["verified_supported", "2026-08-06T00:02:00.000Z"],
    ] as const) {
      await appendCapability({ stateDir, itemType: "reasoning", status, observedAt });
    }
    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(journal.entries.length, 3);
    assert.equal(journal.capabilities.length, 1);
    assert.equal(journal.capabilities[0]?.status, "verified_supported");
    const result = await decisionsFor({
      stateDir,
      payload: { input: [{ type: "reasoning", encrypted_content: "exact" }] },
      now: "2026-08-06T00:03:00.000Z",
    });
    assert.equal(result.decisions[0]?.status, "verified_supported");
  });
});

test("CDR-05 Provider Compatibility reads the LightMem2 v2 schema as canonical evidence", async () => {
  await withTempState(async (stateDir) => {
    await appendCapability({
      stateDir,
      itemType: "message",
      status: "verified_supported",
      observedAt: "2026-08-06T00:00:00.000Z",
      ttlMs: 60_000,
    });
    const path = codexRebaseCapabilityJournalPath(stateDir);
    const canonical = await readFile(path, "utf8");
    await writeFile(path, canonical.replaceAll(CODEX_REBASE_CAPABILITY_SCHEMA, "lightmem2.codex.rebase-capability/v2"), "utf8");

    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(journal.malformedLineCount, 0);
    assert.equal(journal.capabilities[0]?.schema, CODEX_REBASE_CAPABILITY_SCHEMA);
    const result = await decisionsFor({
      stateDir,
      payload: { input: [{ role: "user", content: "current" }] },
      now: "2026-08-06T00:00:30.000Z",
    });
    assert.equal(result.decisions[0]?.status, "verified_supported");
  });
});

test("CDR-05 Provider Compatibility treats mock evidence as distinct from real-provider verification", async () => {
  await withTempState(async (stateDir) => {
    await appendCapability({
      stateDir,
      itemType: "reasoning",
      status: "verified_supported",
      evidence: "mock_fixture",
    });
    const payload = { input: [{ type: "reasoning", encrypted_content: "exact" }] };
    const realDecision = await decisionsFor({ stateDir, payload });
    assert.equal(realDecision.decisions[0]?.status, "unknown_probe_required");
    assert.equal(realDecision.decisions[0]?.reason, "mock_fixture_not_provider_verified");

    const mockDecision = await decisionsFor({
      stateDir,
      payload,
      acceptedEvidence: ["real_provider", "mock_fixture"],
    });
    assert.equal(mockDecision.decisions[0]?.status, "verified_supported");
    assert.equal(mockDecision.decisions[0]?.evidence, "mock_fixture");
  });
});

test("CDR-05 Provider Compatibility isolates legacy rows and fails closed on malformed or unreadable journals", async () => {
  await withTempState(async (stateDir) => {
    await mkdir(dirname(codexRebaseCapabilityJournalPath(stateDir)), { recursive: true });
    await appendFile(
      codexRebaseCapabilityJournalPath(stateDir),
      `${JSON.stringify({
        schema: CODEX_REBASE_CAPABILITY_LEGACY_SCHEMA,
        provider: "OpenAI",
        model: "gpt-5.4-mini",
        itemType: "message",
        status: "supported",
        observedAt: "2026-08-06T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const legacy = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(legacy.staleLineCount, 1);
    assert.equal(legacy.malformedLineCount, 0);
    const legacyDecision = await decisionsFor({ stateDir, payload: { input: [{ role: "user", content: "x" }] } });
    assert.equal(legacyDecision.decisions[0]?.reason, "legacy_capability_not_reused");

    await appendFile(codexRebaseCapabilityJournalPath(stateDir), "not-json\n", "utf8");
    const malformed = await decisionsFor({ stateDir, payload: { input: [{ role: "user", content: "x" }] } });
    assert.equal(malformed.journalTrusted, false);
    assert.equal(malformed.decisions[0]?.reason, "capability_journal_untrusted");
  });

  await withTempState(async (stateDir) => {
    await mkdir(codexRebaseCapabilityJournalPath(stateDir), { recursive: true });
    const unreadable = await decisionsFor({ stateDir, payload: { input: [{ role: "user", content: "x" }] } });
    assert.equal(unreadable.journalTrusted, false);
    assert.equal(unreadable.decisions[0]?.reason, "capability_journal_untrusted");
  });
});

test("CDR-05 unknown compatibility bypasses before opening an epoch", async () => {
  await withTempState(async (stateDir) => {
    const originalPayload = { model: "gpt-5.4-mini", previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] };
    const rebasedPayload = { model: "gpt-5.4-mini", input: [{ role: "user", content: "current" }] };
    const sentPayloads: JsonObject[] = [];
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-unknown",
      planId: "plan-unknown",
      epochId: "epoch-unknown",
      originalPayload,
      rebasedPayload,
      epochStore: { stateDir, oldPreviousResponseId: "resp-old", oldRevision: "rev-old" },
      capabilityStore: capabilityStore(stateDir),
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.equal(result.outcome, "bypassed");
    assert.equal(result.capability?.reason, "provider_replay_probe_required");
    assert.deepEqual(sentPayloads, [originalPayload]);
    assert.equal((await readCodexRebaseEpochJournal(stateDir, "codex-session-unknown")).entries.length, 0);

    await appendCapability({
      stateDir,
      itemType: "message",
      status: "verified_unsupported",
      reason: "item_schema_unsupported",
    });
    const unsupportedPayloads: JsonObject[] = [];
    const unsupported = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-unsupported",
      planId: "plan-unsupported",
      epochId: "epoch-unsupported",
      originalPayload,
      rebasedPayload,
      epochStore: { stateDir, oldPreviousResponseId: "resp-old", oldRevision: "rev-old" },
      capabilityStore: capabilityStore(stateDir),
      async sendUpstream(payload) {
        unsupportedPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original-unsupported", output: [] }) };
      },
    });
    assert.equal(unsupported.outcome, "bypassed");
    assert.deepEqual(unsupported.capability?.unsupportedItemTypes, ["message"]);
    assert.deepEqual(unsupportedPayloads, [originalPayload]);
    assert.equal((await readCodexRebaseEpochJournal(stateDir, "codex-session-unsupported")).entries.length, 0);
  });
});

test("CDR-05 mock capability evidence is ignored unless the harness explicitly accepts it", async () => {
  await withTempState(async (stateDir) => {
    await appendCapability({
      stateDir,
      itemType: "message",
      status: "verified_supported",
      evidence: "mock_fixture",
    });
    const originalPayload = {
      model: "gpt-5.4-mini",
      previous_response_id: "resp-old",
      input: [{ role: "user", content: "current" }],
    };
    const rebasedPayload = {
      model: "gpt-5.4-mini",
      input: [{ role: "user", content: "current" }],
    };
    const sentPayloads: JsonObject[] = [];
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-real-runtime",
      planId: "plan-real-runtime",
      epochId: "epoch-real-runtime",
      originalPayload,
      rebasedPayload,
      capabilityStore: capabilityStore(stateDir, undefined, {
        probeMode: "disabled",
        acceptedEvidence: ["real_provider"],
        evidenceSource: "real_provider",
      }),
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.equal(result.outcome, "bypassed");
    assert.equal(result.capability?.reason, "provider_replay_probe_required");
    assert.deepEqual(sentPayloads, [originalPayload]);
  });
});

test("CDR-05 concurrent capability observations remain complete and parseable", async () => {
  await withTempState(async (stateDir) => {
    await Promise.all(Array.from({ length: 24 }, (_, index) => appendCapability({
      stateDir,
      itemType: `message-${index}`,
      status: "verified_supported",
      observedAt: `2026-08-07T00:00:${String(index).padStart(2, "0")}.000Z`,
    })));
    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(journal.readError, undefined);
    assert.equal(journal.malformedLineCount, 0);
    assert.equal(journal.entries.length, 24);
    assert.equal(journal.capabilities.length, 24);
  });
});

test("CDR-05 capability journal recovers a truncated final JSON record", async () => {
  await withTempState(async (stateDir) => {
    const capability = await appendCapability({
      stateDir,
      itemType: "message",
      status: "verified_supported",
    });
    const path = codexRebaseCapabilityJournalPath(stateDir);
    const raw = await readFile(path, "utf8");
    await appendFile(path, JSON.stringify({ ...capability, itemType: "reasoning" }).slice(0, 24), "utf8");

    const recovered = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(recovered.malformedLineCount, 0);
    assert.equal(recovered.entries.length, 1);
    assert.equal((await readFile(path, "utf8")), raw);
  });
});

test("CDR-05 a malformed non-JSON tail remains untrusted instead of being discarded", async () => {
  await withTempState(async (stateDir) => {
    await mkdir(dirname(codexRebaseCapabilityJournalPath(stateDir)), { recursive: true });
    const path = codexRebaseCapabilityJournalPath(stateDir);
    await appendFile(path, "not-json", "utf8");

    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(journal.malformedLineCount, 1);
    assert.equal(await readFile(path, "utf8"), "not-json");
  });
});

test("CDR-05 an untrusted capability journal bypasses before opening an epoch", async () => {
  await withTempState(async (stateDir) => {
    await mkdir(dirname(codexRebaseCapabilityJournalPath(stateDir)), { recursive: true });
    await appendFile(codexRebaseCapabilityJournalPath(stateDir), "not-json\n", "utf8");
    const originalPayload = { model: "gpt-5.4-mini", previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] };
    const sentPayloads: JsonObject[] = [];
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-untrusted",
      planId: "plan-untrusted",
      epochId: "epoch-untrusted",
      originalPayload,
      rebasedPayload: { model: "gpt-5.4-mini", input: [{ role: "user", content: "current" }] },
      epochStore: { stateDir, oldPreviousResponseId: "resp-old", oldRevision: "rev-old" },
      capabilityStore: capabilityStore(stateDir, undefined, { probeMode: "mock_fixture" }),
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.equal(result.outcome, "bypassed");
    assert.equal(result.capability?.reason, "capability_journal_untrusted");
    assert.deepEqual(sentPayloads, [originalPayload]);
    assert.equal((await readCodexRebaseEpochJournal(stateDir, "codex-session-untrusted")).entries.length, 0);
  });
});

test("CDR-05 explicit item schema rejection records only the named item and skips later probes", async () => {
  await withTempState(async (stateDir) => {
    const originalPayload = { model: "gpt-5.4-mini", previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] };
    const rebasedPayload = { model: "gpt-5.4-mini", input: [{ type: "web_search_call", query: "not replayable" }, { role: "user", content: "current" }] };
    const store = capabilityStore(stateDir, undefined, {
      probeMode: "mock_fixture",
      evidenceSource: undefined,
    });
    const firstPayloads: JsonObject[] = [];
    const first = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-capability",
      planId: "plan-capability",
      epochId: "epoch-capability",
      originalPayload,
      rebasedPayload,
      capabilityStore: store,
      async sendUpstream(payload) {
        firstPayloads.push(payload);
        return firstPayloads.length === 1
          ? {
            status: 400,
            headers: { "content-type": "application/json" },
            text: JSON.stringify({ error: { code: "unsupported_item_type", message: "Unsupported item type: web_search_call" } }),
          }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.equal(first.outcome, "bypassed");
    assert.deepEqual(first.capability?.unsupportedItemTypes, ["web_search_call"]);
    assert.deepEqual(firstPayloads, [rebasedPayload, originalPayload]);
    assert.equal((await readCodexRebaseCapabilityJournal(stateDir)).entries.at(-1)?.evidence, "mock_fixture");

    const secondPayloads: JsonObject[] = [];
    const second = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-capability",
      planId: "plan-capability-next",
      epochId: "epoch-capability-next",
      originalPayload,
      rebasedPayload,
      capabilityStore: store,
      async sendUpstream(payload) {
        secondPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original-2", output: [] }) };
      },
    });
    assert.equal(second.outcome, "bypassed");
    assert.deepEqual(second.capability?.unsupportedItemTypes, ["web_search_call"]);
    assert.deepEqual(secondPayloads, [originalPayload]);
  });
});

test("CDR-05 encrypted payload rejection is scoped to the exact payload and does not poison the item capability", async () => {
  await withTempState(async (stateDir) => {
    const originalPayload = { model: "gpt-5.6-sol", previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] };
    const rejectedPayload = {
      model: "gpt-5.6-sol",
      input: [{ type: "compaction", encrypted_content: "provider-bound-old" }, { role: "user", content: "current" }],
    };
    const store = capabilityStore(stateDir, "gpt-5.6-sol", { probeMode: "mock_fixture" });
    let calls = 0;
    const first = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-payload",
      planId: "plan-payload",
      epochId: "epoch-payload",
      originalPayload,
      rebasedPayload: rejectedPayload,
      capabilityStore: store,
      async sendUpstream() {
        calls += 1;
        return calls === 1
          ? {
            status: 400,
            headers: {},
            text: JSON.stringify({ error: { code: "invalid_encrypted_content", message: "Compaction encrypted payload lineage expired" } }),
          }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.deepEqual(first.capability?.payloadRejectedItemTypes, ["compaction"]);

    const samePayloads: JsonObject[] = [];
    const same = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-payload",
      planId: "plan-payload-same",
      epochId: "epoch-payload-same",
      originalPayload,
      rebasedPayload: rejectedPayload,
      capabilityStore: store,
      async sendUpstream(payload) {
        samePayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original-same", output: [] }) };
      },
    });
    assert.equal(same.outcome, "bypassed");
    assert.deepEqual(same.capability?.payloadRejectedItemTypes, ["compaction"]);
    assert.deepEqual(samePayloads, [originalPayload]);

    const freshPayload = {
      model: "gpt-5.6-sol",
      input: [{ type: "compaction", encrypted_content: "provider-bound-fresh" }, { role: "user", content: "current" }],
    };
    const freshPayloads: JsonObject[] = [];
    const fresh = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-payload",
      planId: "plan-payload-fresh",
      epochId: "epoch-payload-fresh",
      originalPayload,
      rebasedPayload: freshPayload,
      capabilityStore: store,
      async sendUpstream(payload) {
        freshPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-rebased-fresh", output: [] }) };
      },
    });
    assert.equal(fresh.outcome, "committed");
    assert.deepEqual(freshPayloads, [freshPayload]);
  });
});

test("CDR-05 ambiguous multi-item rejection does not mark every item unsupported", async () => {
  const payload = {
    input: [
      { type: "reasoning", encrypted_content: "reasoning" },
      { type: "compaction", encrypted_content: "compaction" },
    ],
  };
  const classification = classifyCodexRebaseCapabilityRejection({
    response: {
      status: 400,
      headers: {},
      text: JSON.stringify({ error: { code: "invalid_request_error", message: "Input schema is not supported" } }),
    },
    items: codexRebasePayloadItems(payload),
  });
  assert.equal(classification.kind, "ambiguous");
  assert.deepEqual(classification.itemTypes, []);

  await withTempState(async (stateDir) => {
    let calls = 0;
    await executeCodexRebaseWithFallback({
      sessionId: "codex-session-ambiguous",
      planId: "plan-ambiguous",
      epochId: "epoch-ambiguous",
      originalPayload: { model: "gpt-5.4-mini", previous_response_id: "resp-old", input: [] },
      rebasedPayload: payload,
      capabilityStore: capabilityStore(stateDir, undefined, { probeMode: "mock_fixture" }),
      async sendUpstream() {
        calls += 1;
        return calls === 1
          ? { status: 400, headers: {}, text: JSON.stringify({ error: { code: "invalid_request_error", message: "Input schema is not supported" } }) }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.deepEqual((await readCodexRebaseCapabilityJournal(stateDir)).entries, []);
  });
});

test("CDR-05 auth, rate-limit, 5xx, and network failures do not pollute compatibility", async () => {
  await withTempState(async (stateDir) => {
    for (const status of [401, 403, 429, 500]) {
      let calls = 0;
      await executeCodexRebaseWithFallback({
        sessionId: `codex-session-${status}`,
        planId: `plan-${status}`,
        epochId: `epoch-${status}`,
        originalPayload: { model: "gpt-5.4-mini", previous_response_id: "resp-old", input: [] },
        rebasedPayload: { model: "gpt-5.4-mini", input: [{ role: "user", content: "current" }] },
        capabilityStore: capabilityStore(stateDir, undefined, { probeMode: "mock_fixture" }),
        async sendUpstream() {
          calls += 1;
          return calls === 1
            ? { status, headers: {}, text: JSON.stringify({ error: { message: "temporary failure" } }) }
            : { status: 200, headers: {}, text: JSON.stringify({ id: `resp-original-${status}`, output: [] }) };
        },
      });
    }
    let networkCalls = 0;
    await executeCodexRebaseWithFallback({
      sessionId: "codex-session-network",
      planId: "plan-network",
      epochId: "epoch-network",
      originalPayload: { model: "gpt-5.4-mini", previous_response_id: "resp-old", input: [] },
      rebasedPayload: { model: "gpt-5.4-mini", input: [{ role: "user", content: "current" }] },
      capabilityStore: capabilityStore(stateDir, undefined, { probeMode: "mock_fixture" }),
      async sendUpstream() {
        networkCalls += 1;
        if (networkCalls === 1) throw new Error("network unavailable");
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original-network", output: [] }) };
      },
    });
    assert.deepEqual((await readCodexRebaseCapabilityJournal(stateDir)).entries, []);
  });
});

test("CDR-05 explicit mock probe records mock evidence without claiming real-provider support", async () => {
  await withTempState(async (stateDir) => {
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-supported",
      planId: "plan-supported",
      epochId: "epoch-supported",
      originalPayload: { model: "gpt-5.4-mini", previous_response_id: "resp-old", input: [] },
      rebasedPayload: { model: "gpt-5.4-mini", input: [{ role: "user", content: "current" }] },
      capabilityStore: capabilityStore(stateDir, undefined, { probeMode: "mock_fixture" }),
      async sendUpstream() {
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-rebased", output: [] }) };
      },
    });
    assert.equal(result.outcome, "committed");
    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(journal.capabilities[0]?.status, "verified_supported");
    assert.equal(journal.capabilities[0]?.evidence, "mock_fixture");
    assert.equal(journal.capabilities[0]?.schema, CODEX_REBASE_CAPABILITY_SCHEMA);

    const realDecision = await decisionsFor({
      stateDir,
      payload: { input: [{ role: "user", content: "current" }] },
    });
    assert.equal(realDecision.decisions[0]?.status, "unknown_probe_required");
  });
});
