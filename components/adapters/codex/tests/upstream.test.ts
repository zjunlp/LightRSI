import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_CHATGPT_UPSTREAM_BASE_URL,
  requestUpstreamResponses,
  resolveCodexRequestUpstream,
} from "../src/upstream.js";

test("built-in OpenAI requests use the ChatGPT Codex endpoint for ChatGPT-authenticated accounts", () => {
  const upstream = { baseUrl: "https://api.openai.com/v1", wireApi: "responses" as const };
  assert.deepEqual(resolveCodexRequestUpstream({
    upstream,
    upstreamProvider: "openai",
    inboundHeaders: { "ChatGPT-Account-Id": "account-fixture" },
  }), {
    ...upstream,
    baseUrl: CODEX_CHATGPT_UPSTREAM_BASE_URL,
  });
  assert.equal(resolveCodexRequestUpstream({
    upstream,
    upstreamProvider: "openai",
    inboundHeaders: { authorization: "Bearer api-key-fixture" },
  }), upstream);
});

test("enhanced Responses forwarding preserves ChatGPT authentication context headers", async () => {
  let receivedHeaders: IncomingHttpHeaders | undefined;
  const server = createServer(async (req, res) => {
    receivedHeaders = req.headers;
    for await (const _chunk of req) {
      // Drain the request body before replying.
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  try {
    const response = await requestUpstreamResponses({
      upstream: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        wireApi: "responses",
        requiresOpenAIAuth: true,
      },
      payload: { model: "gpt-fixture", input: [] },
      inboundAuthorization: "Bearer chatgpt-token-fixture",
      inboundHeaders: {
        authorization: "Bearer chatgpt-token-fixture",
        "chatgpt-account-id": "account-fixture",
        originator: "codex_cli_rs",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(receivedHeaders?.authorization, "Bearer chatgpt-token-fixture");
    assert.equal(receivedHeaders?.["chatgpt-account-id"], "account-fixture");
    assert.equal(receivedHeaders?.originator, "codex_cli_rs");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withReasoningFixture(
  responses: Array<{ encrypted?: string }>,
  run: (baseUrl: string, requestCount: () => number) => Promise<void>,
): Promise<void> {
  let count = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request body before replying.
    }
    const fixture = responses[Math.min(count, responses.length - 1)] ?? {};
    count += 1;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `resp-${count}`,
      status: "completed",
      output: [{
        type: "reasoning",
        encrypted_content: fixture.encrypted,
        summary: [],
      }],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, () => count);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("upstream retries up to twice when requested encrypted reasoning is omitted", async () => {
  await withReasoningFixture([{}, {}, { encrypted: "opaque-retry-state" }], async (baseUrl, requestCount) => {
    const response = await requestUpstreamResponses({
      upstream: { baseUrl, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        store: false,
        include: ["reasoning.encrypted_content"],
        input: [{ role: "user", content: "test" }],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(requestCount(), 3);
    assert.match(response.text, /opaque-retry-state/);
  });
});
test("upstream encrypted-reasoning repair is bounded to two retries", async () => {
  await withReasoningFixture([{}, {}, {}], async (baseUrl, requestCount) => {
    const response = await requestUpstreamResponses({
      upstream: { baseUrl, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        include: ["reasoning.encrypted_content"],
        input: [{ role: "user", content: "test" }],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(requestCount(), 3);
    assert.doesNotMatch(response.text, /encrypted_content":"opaque/);
  });
});
test("expired unsupported-field capability records allow one bounded retry", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-capability-expiry-"));
  let requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    if ("prompt_cache_retention" in payload) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: prompt_cache_retention" } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const endpoint = `${baseUrl}/responses`;
  try {
    await mkdir(join(stateDir, "upstream-capabilities", "responses"), { recursive: true });
    await writeFile(
      join(stateDir, "upstream-capabilities", "responses", `${encodeURIComponent(endpoint)}.json`),
      JSON.stringify({
        endpoint,
        unsupportedOptionalFields: ["prompt_cache_retention"],
        updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }),
      "utf8",
    );
    const response = await requestUpstreamResponses({
      upstream: { baseUrl, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        prompt_cache_retention: "24h",
        input: [{ role: "user", content: "test" }],
      },
      stateDir,
    });
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.prompt_cache_retention, "24h");
    assert.equal("prompt_cache_retention" in (requests[1] ?? {}), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("unsupported prompt_cache_options is persisted and retried once without that field", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cache-options-capability-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(payload);
    if ("prompt_cache_options" in payload) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: prompt_cache_options" } }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a port");
  try {
    const response = await requestUpstreamResponses({
      upstream: { baseUrl: `http://127.0.0.1:${address.port}/v1`, wireApi: "responses", requiresOpenAIAuth: false },
      payload: {
        model: "gpt-fixture",
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        input: [{ role: "user", content: "test" }],
      },
      stateDir,
    });
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0]?.prompt_cache_options, { mode: "explicit", ttl: "30m" });
    assert.equal("prompt_cache_options" in (requests[1] ?? {}), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  }
});
