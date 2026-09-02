/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  buildGatewayForwardHeaders,
  readJsonFile,
  writeJsonFileAtomic,
} from "@lightrsi/host-adapter";
import { join } from "node:path";
import { Readable } from "node:stream";
import { collectCodexResponseItemsFromStream } from "./context-history/sse-item-collector.js";
import type { CodexProviderConfig } from "./config.js";

export type UpstreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
};

export type UpstreamStreamResponse = {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
};

type OptionalResponsesField = "prompt_cache_options" | "prompt_cache_retention" | "prompt_cache_key";

type InboundHeaders = Record<string, string | string[] | undefined>;

export const CODEX_CHATGPT_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function resolveCodexRequestUpstream(params: {
  upstream: CodexProviderConfig;
  upstreamProvider?: string;
  inboundHeaders?: InboundHeaders;
}): CodexProviderConfig {
  const isBuiltInOpenAI = params.upstreamProvider?.trim().toLowerCase() === "openai";
  const usesChatGptAccount = Object.keys(params.inboundHeaders ?? {}).some(
    (name) => name.toLowerCase() === "chatgpt-account-id",
  );
  if (!isBuiltInOpenAI || !usesChatGptAccount) return params.upstream;
  return {
    ...params.upstream,
    baseUrl: CODEX_CHATGPT_UPSTREAM_BASE_URL,
  };
}

type UpstreamResponsesCapabilityRecord = {
  endpoint: string;
  unsupportedOptionalFields: OptionalResponsesField[];
  updatedAt: string;
};

const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

function endpointFor(upstream: CodexProviderConfig): string {
  const base = upstream.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) return `${base}/responses`;
  if (base.endsWith("/v1/responses")) return base;
  return `${base}/v1/responses`;
}

function upstreamApiKey(upstream: CodexProviderConfig, inboundAuthorization?: string): string {
  if (upstream.apiKey) return upstream.apiKey;
  if (inboundAuthorization?.toLowerCase().startsWith("bearer ")) {
    return inboundAuthorization.slice("bearer ".length).trim();
  }
  return process.env.OPENAI_API_KEY ?? "";
}

function headersFrom(resp: Response): Record<string, string> {
  return Object.fromEntries(resp.headers.entries());
}

function requestHeaders(
  upstream: CodexProviderConfig,
  inboundAuthorization?: string,
  inboundHeaders?: InboundHeaders,
): Record<string, string> {
  const apiKey = upstreamApiKey(upstream, inboundAuthorization);
  return buildGatewayForwardHeaders({
    upstream: {
      baseUrl: upstream.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      name: upstream.name,
      protocol: "custom",
    },
    inboundAuthorization,
    inboundHeaders,
    includeJsonContentType: true,
  });
}
function clonePayloadWithoutOptionalField(payload: any, field: OptionalResponsesField): any {
  if (!payload || typeof payload !== "object") return payload;
  if (!(field in payload)) return payload;
  const next = { ...(payload as Record<string, unknown>) };
  delete next[field];
  return next;
}

function clonePayloadWithoutUnsupportedFields(
  payload: any,
  unsupportedFields: Iterable<OptionalResponsesField>,
): any {
  let next = payload;
  for (const field of unsupportedFields) {
    next = clonePayloadWithoutOptionalField(next, field);
  }
  return next;
}

function unsupportedOptionalFieldFromText(text: string): OptionalResponsesField | undefined {
  if (!text) return undefined;
  if (/unsupported parameter:\s*prompt_cache_options/i.test(text)) {
    return "prompt_cache_options";
  }
  if (/unsupported parameter:\s*prompt_cache_retention/i.test(text)) {
    return "prompt_cache_retention";
  }
  if (/unsupported parameter:\s*prompt_cache_key/i.test(text)) {
    return "prompt_cache_key";
  }
  return undefined;
}

function encryptedReasoningRequested(payload: any): boolean {
  return Array.isArray(payload?.include) && payload.include.includes("reasoning.encrypted_content");
}

function outputItemsFromResponse(text: string, contentType: string | null): any[] {
  if (contentType?.toLowerCase().includes("text/event-stream") || /^event:\s*response\./mu.test(text)) {
    return collectCodexResponseItemsFromStream(text).outputItems;
  }
  try {
    const parsed = JSON.parse(text) as any;
    return Array.isArray(parsed?.output) ? parsed.output : [];
  } catch {
    return [];
  }
}

function requestedEncryptedReasoningMissing(payload: any, resp: Response, text: string): boolean {
  if (!encryptedReasoningRequested(payload)) return false;
  return outputItemsFromResponse(text, resp.headers.get("content-type")).some((item) => {
    const type = String(item?.type ?? "").toLowerCase();
    return (type === "reasoning" || type === "compaction")
      && (typeof item?.encrypted_content !== "string" || !item.encrypted_content.trim());
  });
}

function upstreamCapabilityPath(stateDir: string, upstream: CodexProviderConfig): string {
  return join(
    stateDir,
    "upstream-capabilities",
    "responses",
    `${encodeURIComponent(endpointFor(upstream))}.json`,
  );
}

async function loadUnsupportedOptionalFields(
  stateDir: string | undefined,
  upstream: CodexProviderConfig,
): Promise<Set<OptionalResponsesField>> {
  if (!stateDir) return new Set();
  const record = await readJsonFile<UpstreamResponsesCapabilityRecord>(
    upstreamCapabilityPath(stateDir, upstream),
  );
  const updatedAt = Date.parse(String(record?.updatedAt ?? ""));
  const endpoint = endpointFor(upstream);
  const fresh = record?.endpoint === endpoint
    && Number.isFinite(updatedAt)
    && updatedAt <= Date.now()
    && Date.now() - updatedAt < CAPABILITY_TTL_MS;
  const fields = fresh && Array.isArray(record?.unsupportedOptionalFields)
    ? record.unsupportedOptionalFields.filter(
      (value): value is OptionalResponsesField =>
        value === "prompt_cache_options" || value === "prompt_cache_retention" || value === "prompt_cache_key",
    )
    : [];
  return new Set(fields);
}

async function persistUnsupportedOptionalField(
  stateDir: string | undefined,
  upstream: CodexProviderConfig,
  field: OptionalResponsesField,
): Promise<void> {
  if (!stateDir) return;
  const unsupportedFields = await loadUnsupportedOptionalFields(stateDir, upstream);
  unsupportedFields.add(field);
  await writeJsonFileAtomic(upstreamCapabilityPath(stateDir, upstream), {
    endpoint: endpointFor(upstream),
    unsupportedOptionalFields: Array.from(unsupportedFields),
    updatedAt: new Date().toISOString(),
  } satisfies UpstreamResponsesCapabilityRecord);
}

export async function requestUpstreamResponses(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
  inboundHeaders?: InboundHeaders;
  stateDir?: string;
}): Promise<UpstreamHttpResponse> {
  const send = (payload: any) => fetch(endpointFor(params.upstream), {
    method: "POST",
    headers: requestHeaders(params.upstream, params.inboundAuthorization, params.inboundHeaders),
    body: JSON.stringify(payload),
  });
  const unsupportedFields = await loadUnsupportedOptionalFields(params.stateDir, params.upstream);
  let payload = clonePayloadWithoutUnsupportedFields(params.payload, unsupportedFields);
  let resp = await send(payload);
  let text = await resp.text();
  if (!resp.ok) {
    const unsupportedField = unsupportedOptionalFieldFromText(text);
    if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
      await persistUnsupportedOptionalField(params.stateDir, params.upstream, unsupportedField);
      const downgraded = clonePayloadWithoutOptionalField(payload, unsupportedField);
      if (downgraded !== payload) {
        payload = downgraded;
        resp = await send(payload);
        text = await resp.text();
      }
    }
  }
  let encryptedRepairAttempts = 0;
  while (resp.ok
    && requestedEncryptedReasoningMissing(payload, resp, text)
    && encryptedRepairAttempts < 2) {
    encryptedRepairAttempts += 1;
    resp = await send(payload);
    text = await resp.text();
  }
  return {
    status: resp.status,
    headers: headersFrom(resp),
    text,
  };
}

export async function requestUpstreamResponsesStream(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
  inboundHeaders?: InboundHeaders;
  stateDir?: string;
}): Promise<UpstreamStreamResponse> {
  const send = (payload: any) => fetch(endpointFor(params.upstream), {
    method: "POST",
    headers: requestHeaders(params.upstream, params.inboundAuthorization, params.inboundHeaders),
    body: JSON.stringify(payload),
  });
  const unsupportedFields = await loadUnsupportedOptionalFields(params.stateDir, params.upstream);
  let payload = clonePayloadWithoutUnsupportedFields(params.payload, unsupportedFields);
  let resp = await send(payload);
  if (!resp.ok) {
    const text = await resp.text();
    const unsupportedField = unsupportedOptionalFieldFromText(text);
    if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
      await persistUnsupportedOptionalField(params.stateDir, params.upstream, unsupportedField);
      const downgraded = clonePayloadWithoutOptionalField(payload, unsupportedField);
      if (downgraded !== payload) {
        payload = downgraded;
        resp = await send(payload);
      } else {
        return {
          status: resp.status,
          headers: headersFrom(resp),
          stream: Readable.from([text]),
        };
      }
    } else {
      return {
        status: resp.status,
        headers: headersFrom(resp),
        stream: Readable.from([text]),
      };
    }
  }
  return {
    status: resp.status,
    headers: headersFrom(resp),
    stream: resp.body ? Readable.fromWeb(resp.body as any) : Readable.from([""]),
  };
}
