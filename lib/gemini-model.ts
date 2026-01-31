import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Message,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { getValidAccessToken } from "./antigravity/token-manager";
import { getProjectId } from "./antigravity/project-resolver";
import { ANTIGRAVITY_HEADERS, CLOUDCODE_ENDPOINTS } from "./antigravity/constants";
import crypto from "node:crypto";

// -- Gemini types --

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: unknown } };

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

// -- Helpers --

function toBase64(data: Uint8Array | string | URL): string {
  if (typeof data === "string") return data;
  if (data instanceof URL) throw new Error("URL file parts not supported");
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let b = "";
  for (const byte of data) b += String.fromCharCode(byte);
  return btoa(b);
}

function convertPrompt(prompt: LanguageModelV3Message[]) {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const msg of prompt) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user" || msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const p of msg.content) {
        if (p.type === "text") parts.push({ text: p.text });
        else if (p.type === "file")
          parts.push({ inlineData: { mimeType: p.mediaType, data: toBase64(p.data) } });
        else if (p.type === "tool-call")
          parts.push({
            functionCall: {
              name: p.toolName,
              args: typeof p.input === "string" ? JSON.parse(p.input) : (p.input as Record<string, unknown>) ?? {},
            },
          });
        else if (p.type === "tool-result")
          parts.push({ functionResponse: { name: p.toolName, response: extractResult(p) } });
        else if (p.type === "reasoning") parts.push({ text: p.text });
      }
      if (parts.length) contents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
      continue;
    }

    if (msg.role === "tool") {
      const parts: GeminiPart[] = [];
      for (const p of msg.content) {
        if (p.type === "tool-result")
          parts.push({ functionResponse: { name: p.toolName, response: extractResult(p) } });
      }
      if (parts.length) contents.push({ role: "user", parts });
    }
  }

  return {
    contents,
    systemInstruction: systemParts.length
      ? { role: "user" as const, parts: systemParts.map((t) => ({ text: t })) }
      : undefined,
  };
}

function extractResult(p: { output?: unknown; result?: unknown }): unknown {
  const o = p.output as { type?: string; value?: unknown } | undefined;
  if (o) {
    if (o.type === "text" || o.type === "error-text") return { text: o.value ?? "" };
    if (o.type === "json" || o.type === "error-json") return o.value;
    if (o.type === "content") return o.value;
    if (o.type === "execution-denied") return { error: "Tool execution denied" };
  }
  return p.result ?? { text: "No result" };
}

function convertTools(options: LanguageModelV3CallOptions) {
  const fns = options.tools?.filter((t) => t.type === "function");
  if (!fns?.length) return {};
  const declarations = fns.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
  let toolConfig: unknown;
  if (options.toolChoice) {
    const tc = options.toolChoice;
    let mode: string = "AUTO";
    let allowed: string[] | undefined;
    if (tc.type === "none") mode = "NONE";
    else if (tc.type === "required") mode = "ANY";
    else if (tc.type === "tool") { mode = "ANY"; allowed = [tc.toolName]; }
    toolConfig = { functionCallingConfig: { mode, ...(allowed ? { allowedFunctionNames: allowed } : {}) } };
  }
  return { tools: [{ functionDeclarations: declarations }], toolConfig };
}

function mapFinish(raw?: string): LanguageModelV3FinishReason {
  const r = (raw ?? "").toUpperCase();
  const unified = r === "STOP" ? "stop" : r === "MAX_TOKENS" ? "length" : r === "SAFETY" || r === "RECITATION" ? "content-filter" : "other";
  return { unified, raw: raw ?? undefined };
}

function mapUsage(m?: { promptTokenCount?: number; candidatesTokenCount?: number }): LanguageModelV3Usage {
  return {
    inputTokens: { total: m?.promptTokenCount, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: m?.candidatesTokenCount, text: undefined, reasoning: undefined },
  };
}

let nextId = 0;
function callId() { return `call_${Date.now().toString(36)}_${(nextId++).toString(36)}`; }

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...ANTIGRAVITY_HEADERS,
  };
}

function wrapBody(model: string, project: string, inner: Record<string, unknown>) {
  return { project, model, request: inner, requestType: "agent", userAgent: "antigravity", requestId: `agent-${crypto.randomUUID()}` };
}

async function fetchFallback(action: string, headers: Record<string, string>, body: string, signal?: AbortSignal) {
  let last: Error | null = null;
  for (const base of CLOUDCODE_ENDPOINTS) {
    try {
      return await fetch(`${base}/v1internal:${action}`, { method: "POST", headers, body, signal });
    } catch (e) { last = e instanceof Error ? e : new Error(String(e)); }
  }
  throw last ?? new Error("All endpoints failed");
}

function unwrap(json: Record<string, unknown>): Record<string, unknown> {
  if (json.response && typeof json.response === "object") return json.response as Record<string, unknown>;
  return json;
}

function parseContent(gemini: Record<string, unknown>) {
  const cands = gemini.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }> | undefined;
  const cand = cands?.[0];
  const parts = cand?.content?.parts ?? [];
  const content: LanguageModelV3Content[] = [];
  for (const p of parts) {
    if (typeof p.text === "string") content.push({ type: "text", text: p.text });
    else if (p.functionCall && typeof (p.functionCall as { name?: string }).name === "string") {
      const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
      content.push({ type: "tool-call", toolCallId: callId(), toolName: fc.name, input: JSON.stringify(fc.args ?? {}) });
    }
  }
  return { content, finishReason: cand?.finishReason, usage: gemini.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined };
}

// -- Model factory --

export function createGeminiOAuth(modelId: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "gemini-oauth",
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const token = await getValidAccessToken();
      const projectId = await getProjectId(token);
      const { contents, systemInstruction } = convertPrompt(options.prompt);
      const { tools, toolConfig } = convertTools(options);

      const gen: Record<string, unknown> = {};
      if (options.temperature != null) gen.temperature = options.temperature;
      if (options.maxOutputTokens != null) gen.maxOutputTokens = options.maxOutputTokens;
      if (options.topP != null) gen.topP = options.topP;
      if (options.topK != null) gen.topK = options.topK;
      if (options.stopSequences?.length) gen.stopSequences = options.stopSequences;

      const inner: Record<string, unknown> = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(Object.keys(gen).length ? { generationConfig: gen } : {}),
        ...(tools ? { tools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      };

      const wrapped = wrapBody(modelId, projectId, inner);
      const headers = buildHeaders(token);
      const res = await fetchFallback("generateContent", headers, JSON.stringify(wrapped), options.abortSignal);

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Gemini error ${res.status}: ${t || res.statusText}`);
      }

      const raw = (await res.json()) as Record<string, unknown>;
      const gemini = unwrap(raw);
      const { content, finishReason, usage } = parseContent(gemini);

      return {
        content,
        finishReason: mapFinish(finishReason),
        usage: mapUsage(usage),
        warnings: [],
        request: { body: wrapped },
        response: { headers: Object.fromEntries(res.headers.entries()), body: raw },
      };
    },

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const token = await getValidAccessToken();
      const projectId = await getProjectId(token);
      const { contents, systemInstruction } = convertPrompt(options.prompt);
      const { tools, toolConfig } = convertTools(options);

      const gen: Record<string, unknown> = {};
      if (options.temperature != null) gen.temperature = options.temperature;
      if (options.maxOutputTokens != null) gen.maxOutputTokens = options.maxOutputTokens;
      if (options.topP != null) gen.topP = options.topP;
      if (options.topK != null) gen.topK = options.topK;
      if (options.stopSequences?.length) gen.stopSequences = options.stopSequences;

      const inner: Record<string, unknown> = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(Object.keys(gen).length ? { generationConfig: gen } : {}),
        ...(tools ? { tools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      };

      const wrapped = wrapBody(modelId, projectId, inner);
      const headers = buildHeaders(token);
      headers["Accept"] = "text/event-stream";
      const res = await fetchFallback("streamGenerateContent?alt=sse", headers, JSON.stringify(wrapped), options.abortSignal);

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Gemini stream error ${res.status}: ${t || res.statusText}`);
      }
      if (!res.body) throw new Error("No body in streaming response");

      return {
        stream: parseSSE(res.body),
        request: { body: wrapped },
        response: { headers: Object.fromEntries(res.headers.entries()) },
      };
    },
  };
}

// -- SSE parser --

function parseSSE(body: ReadableStream<Uint8Array>): ReadableStream<LanguageModelV3StreamPart> {
  let buf = "";
  let started = false;
  let textId: string | null = null;
  let accText = "";

  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(ctrl) {
      const reader = body.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const evts = buf.split("\n\n");
          buf = evts.pop() ?? "";
          for (const e of evts) { const j = sseData(e); if (j) emit(j as Record<string, unknown>, ctrl); }
        }
        if (buf.trim()) { const j = sseData(buf); if (j) emit(j as Record<string, unknown>, ctrl); }
      } catch (err) { ctrl.enqueue({ type: "error", error: err }); }
      finally {
        if (textId) { ctrl.enqueue({ type: "text-end", id: textId }); textId = null; }
        ctrl.enqueue({ type: "finish", finishReason: { unified: "other", raw: undefined }, usage: mapUsage() });
        ctrl.close();
      }

      function sseData(raw: string): unknown | null {
        for (const l of raw.split("\n")) {
          if (l.startsWith("data:")) {
            const p = l.slice(5).trim();
            if (!p || p === "[DONE]") return null;
            try { return JSON.parse(p); } catch { return null; }
          }
        }
        return null;
      }

      function emit(chunk: Record<string, unknown>, c: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {
        if (!started) { c.enqueue({ type: "stream-start", warnings: [] }); started = true; }
        const inner = unwrap(chunk);
        const cand = (inner.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }>)?.[0];
        for (const p of cand?.content?.parts ?? []) {
          if (typeof p.text === "string") {
            const full = p.text;
            const delta = full.startsWith(accText) ? full.slice(accText.length) : full;
            if (delta) {
              if (!textId) { textId = callId(); c.enqueue({ type: "text-start", id: textId }); }
              c.enqueue({ type: "text-delta", id: textId, delta });
            }
            if (full.length >= accText.length) accText = full;
          } else if (p.functionCall && typeof (p.functionCall as { name?: string }).name === "string") {
            const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
            const id = callId();
            c.enqueue({ type: "tool-input-start", id, toolName: fc.name });
            const a = JSON.stringify(fc.args ?? {});
            c.enqueue({ type: "tool-input-delta", id, delta: a });
            c.enqueue({ type: "tool-input-end", id });
            c.enqueue({ type: "tool-call", toolCallId: id, toolName: fc.name, input: a });
          }
        }
        const usage = inner.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
        if (cand?.finishReason) {
          if (textId) { c.enqueue({ type: "text-end", id: textId }); textId = null; }
          c.enqueue({ type: "finish", finishReason: mapFinish(cand.finishReason), usage: mapUsage(usage) });
        }
      }
    },
  });
}
