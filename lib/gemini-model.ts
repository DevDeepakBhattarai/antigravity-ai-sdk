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
import {
  ANTIGRAVITY_HEADERS,
  CLOUDCODE_ENDPOINTS,
} from "./antigravity/constants";
import crypto from "node:crypto";
import { convertJSONSchemaToOpenAPISchema } from "./schema-utils";

// -- Gemini types --

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | {
      inlineData: { mimeType: string; data: string };
      thoughtSignature?: string;
    }
  | {
      functionCall: {
        name: string;
        args?: Record<string, unknown>;
      };
      thoughtSignature?: string;
    }
  | { functionResponse: { name: string; response: unknown } };

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

// -- Helpers --

function toBase64(data: Uint8Array | string | URL): string {
  if (typeof data === "string") {
    if (data.startsWith("data:")) {
      const commaIndex = data.indexOf(",");
      if (commaIndex !== -1) {
        return data.slice(commaIndex + 1);
      }
    }
    return data;
  }
  if (data instanceof URL) throw new Error("URL file parts not supported");
  if (typeof Buffer !== "undefined")
    return Buffer.from(data).toString("base64");
  let b = "";
  for (const byte of data) b += String.fromCharCode(byte);
  return btoa(b);
}

function convertPrompt(
  prompt: LanguageModelV3Message[],
  providerOptionsName = "gemini-oauth",
) {
  const systemParts: { text: string }[] = [];
  const contents: GeminiContent[] = [];

  for (const msg of prompt) {
    if (msg.role === "system") {
      systemParts.push({ text: msg.content });
      continue;
    }

    if (msg.role === "user" || msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const p of msg.content) {
        const anyPart = p as unknown as {
          providerMetadata?: Record<string, Record<string, unknown>>;
          providerOptions?: Record<string, Record<string, unknown>>;
        };
        const providerOpts =
          anyPart.providerMetadata?.[providerOptionsName] ??
          anyPart.providerOptions?.[providerOptionsName];

        const thoughtSignature =
          providerOpts?.thoughtSignature != null
            ? String(providerOpts.thoughtSignature)
            : undefined;

        if (p.type === "text") {
          parts.push({
            text: p.text,
            thoughtSignature,
          });
        } else if (p.type === "file") {
          parts.push({
            inlineData: { mimeType: p.mediaType, data: toBase64(p.data) },
            thoughtSignature,
          });
        } else if (p.type === "tool-call") {
          parts.push({
            functionCall: {
              name: p.toolName,
              args:
                typeof p.input === "string"
                  ? JSON.parse(p.input)
                  : ((p.input as Record<string, unknown>) ?? {}),
            },
            thoughtSignature,
          });
        } else if (p.type === "tool-result") {
          parts.push({
            functionResponse: { name: p.toolName, response: extractResult(p) },
          });
        } else if (p.type === "reasoning") {
          parts.push({
            text: p.text,
            thought: true,
            thoughtSignature,
          });
        }
      }
      if (parts.length) {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts,
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      const parts: GeminiPart[] = [];
      for (const p of msg.content) {
        if (p.type === "tool-result") {
          parts.push({
            functionResponse: { name: p.toolName, response: extractResult(p) },
          });
        }
      }
      if (parts.length) contents.push({ role: "user", parts });
    }
  }

  return {
    contents,
    systemInstruction: systemParts.length
      ? { role: "user" as const, parts: systemParts }
      : undefined,
  };
}

function extractResult(p: { output?: unknown; result?: unknown }): unknown {
  const o = p.output as { type?: string; value?: unknown } | undefined;
  if (o) {
    if (o.type === "text" || o.type === "error-text")
      return { content: o.value ?? "" }; // Google expects 'content' key often for simple text
    if (o.type === "json" || o.type === "error-json") return o.value;
    if (o.type === "content")
      return typeof o.value === "string" ? { content: o.value } : o.value;
    if (o.type === "execution-denied")
      return { error: "Tool execution denied" };
  }
  // Fallback for simple result
  return typeof p.result === "string" ? { content: p.result } : p.result;
}

async function convertTools(options: LanguageModelV3CallOptions) {
  const fns = options.tools?.filter((t) => t.type === "function");
  if (!fns?.length) return {};

  const declarations = await Promise.all(
    fns.map(async (t) => ({
      name: t.name,
      description: t.description,
      parameters: convertJSONSchemaToOpenAPISchema(t.inputSchema),
    })),
  );

  let toolConfig: unknown;
  if (options.toolChoice) {
    const tc = options.toolChoice;
    let mode: string = "AUTO";
    let allowed: string[] | undefined;

    if (tc.type === "none") mode = "NONE";
    else if (tc.type === "required") mode = "ANY";
    else if (tc.type === "tool") {
      mode = "ANY";
      allowed = [tc.toolName];
    }

    toolConfig = {
      functionCallingConfig: {
        mode,
        ...(allowed ? { allowedFunctionNames: allowed } : {}),
      },
    };
  }

  return { tools: [{ functionDeclarations: declarations }], toolConfig };
}

function mapFinish(raw?: string): LanguageModelV3FinishReason {
  const r = (raw ?? "").toUpperCase();
  const unified =
    r === "STOP"
      ? "stop"
      : r === "MAX_TOKENS"
        ? "length"
        : r === "SAFETY" || r === "RECITATION"
          ? "content-filter"
          : "other";
  return { unified, raw: raw ?? undefined };
}

function mapUsage(m?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: m?.promptTokenCount ?? 0,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: m?.candidatesTokenCount ?? 0,
      text: undefined,
      reasoning: m?.thoughtsTokenCount,
    },
  };
}

let nextId = 0;
function callId() {
  return `call_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...ANTIGRAVITY_HEADERS,
  };
}

type AntigravityThinkingOptions = {
  enabled?: boolean;
  includeThoughts?: boolean;
  thinkingLevel?: "low" | "medium" | "high";
  thinkingBudget?: number;
};

function resolveThinkingConfig(
  options: LanguageModelV3CallOptions,
): Record<string, unknown> | undefined {
  const providerOptions = options.providerOptions as
    | { antigravity?: { thinking?: AntigravityThinkingOptions } }
    | undefined;
  const thinking = providerOptions?.antigravity?.thinking;
  if (!thinking || thinking.enabled === false) return undefined;

  const config: Record<string, unknown> = {
    includeThoughts: thinking.includeThoughts ?? true,
  };
  if (thinking.thinkingLevel) config.thinkingLevel = thinking.thinkingLevel;
  if (thinking.thinkingBudget != null)
    config.thinkingBudget = thinking.thinkingBudget;
  return config;
}

function wrapBody(
  model: string,
  project: string,
  inner: Record<string, unknown>,
) {
  return {
    project,
    model,
    request: inner,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
  };
}

async function fetchFallback(
  action: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) {
  let last: Error | null = null;
  for (const base of CLOUDCODE_ENDPOINTS) {
    try {
      return await fetch(`${base}/v1internal:${action}`, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw last ?? new Error("All endpoints failed");
}

function unwrap(json: Record<string, unknown>): Record<string, unknown> {
  if (json.response && typeof json.response === "object")
    return json.response as Record<string, unknown>;
  return json;
}

const parseContent = (gemini: Record<string, unknown>) => {
  const content: LanguageModelV3Content[] = [];
  if (process.env.NODE_ENV !== "production") {
    console.log(
      "[gemini] parseContent raw response",
      JSON.stringify(gemini).slice(0, 4000),
    );
  }

  const pushReasoning = (text: string, signature?: string) => {
    if (text)
      content.push({
        type: "reasoning",
        text,
        providerMetadata: signature
          ? { "gemini-oauth": { thoughtSignature: signature } }
          : undefined,
      });
  };

  const pushText = (text: string, signature?: string) => {
    if (text)
      content.push({
        type: "text",
        text,
        providerMetadata: signature
          ? { "gemini-oauth": { thoughtSignature: signature } }
          : undefined,
      });
  };

  const parseParts = (parts: Array<Record<string, unknown>>) => {
    for (const p of parts) {
      const signature =
        typeof p.thoughtSignature === "string" ? p.thoughtSignature : undefined;

      if (
        (p as { thought?: boolean }).thought === true ||
        p.type === "thinking" ||
        p.type === "reasoning"
      ) {
        const reasoningText =
          typeof p.text === "string"
            ? p.text
            : typeof (p as { thinking?: string }).thinking === "string"
              ? (p as { thinking?: string }).thinking
              : "";
        pushReasoning(reasoningText ?? "", signature);
        continue;
      }
      if (typeof p.text === "string") {
        pushText(p.text, signature);
        continue;
      }
      if (
        p.functionCall &&
        typeof (p.functionCall as { name?: string }).name === "string"
      ) {
        const fc = p.functionCall as {
          name: string;
          args?: Record<string, unknown>;
        };
        content.push({
          type: "tool-call",
          toolCallId: callId(),
          toolName: fc.name,
          input: JSON.stringify(fc.args ?? {}),
          providerMetadata: signature
            ? { "gemini-oauth": { thoughtSignature: signature } }
            : undefined,
        });
      }
      if (p.inlineData) {
        // Handle inline images/data
        const id = p.inlineData as { mimeType: string; data: string };
        content.push({
          type: "file",
          mediaType: id.mimeType,
          data: id.data,
          providerMetadata: signature
            ? { "gemini-oauth": { thoughtSignature: signature } }
            : undefined,
        });
      }
    }
  };

  const cands = gemini.candidates as
    | Array<{
        content?: { parts?: Array<Record<string, unknown>> };
        finishReason?: string;
      }>
    | undefined;

  const cand = cands?.[0];
  const parts = cand?.content?.parts ?? [];
  parseParts(parts);

  // If there's content directly in the object (Anthropic-style wrapper sometimes seen in internal proxies)
  const anthContent = gemini.content as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(anthContent) && content.length === 0) {
    for (const block of anthContent) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking") {
        const reasoningText =
          typeof block.thinking === "string"
            ? block.thinking
            : typeof block.text === "string"
              ? block.text
              : "";
        pushReasoning(reasoningText, undefined); // AnthContent usually doesn't have signature like this
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        pushText(block.text, undefined);
      }
    }
  }

  // Handle usage
  const usage = gemini.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      }
    | undefined;

  return {
    content,
    finishReason: cand?.finishReason,
    usage,
  };
};

// -- Model factory --

export function createGeminiOAuth(modelId: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "gemini-oauth",
    modelId,
    supportedUrls: {},

    async doGenerate(
      options: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3GenerateResult> {
      const token = await getValidAccessToken();
      const projectId = await getProjectId(token);
      const { contents, systemInstruction } = convertPrompt(options.prompt);
      const { tools, toolConfig } = await convertTools(options);

      const gen: Record<string, unknown> = {};
      if (options.temperature != null) gen.temperature = options.temperature;
      if (options.maxOutputTokens != null)
        gen.maxOutputTokens = options.maxOutputTokens;
      if (options.topP != null) gen.topP = options.topP;
      if (options.topK != null) gen.topK = options.topK;
      if (options.stopSequences?.length)
        gen.stopSequences = options.stopSequences;
      const thinkingConfig = resolveThinkingConfig(options);
      if (thinkingConfig) gen.thinkingConfig = thinkingConfig;

      const inner: Record<string, unknown> = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(Object.keys(gen).length ? { generationConfig: gen } : {}),
        ...(tools ? { tools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      };

      const wrapped = wrapBody(modelId, projectId, inner);
      const headers = buildHeaders(token);
      const res = await fetchFallback(
        "generateContent",
        headers,
        JSON.stringify(wrapped),
        options.abortSignal,
      );

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
        response: {
          headers: Object.fromEntries(res.headers.entries()),
          body: raw,
        },
      };
    },

    async doStream(
      options: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3StreamResult> {
      const token = await getValidAccessToken();
      const projectId = await getProjectId(token);
      const { contents, systemInstruction } = convertPrompt(options.prompt);
      const { tools, toolConfig } = await convertTools(options);

      const gen: Record<string, unknown> = {};
      if (options.temperature != null) gen.temperature = options.temperature;
      if (options.maxOutputTokens != null)
        gen.maxOutputTokens = options.maxOutputTokens;
      if (options.topP != null) gen.topP = options.topP;
      if (options.topK != null) gen.topK = options.topK;
      if (options.stopSequences?.length)
        gen.stopSequences = options.stopSequences;
      const thinkingConfig = resolveThinkingConfig(options);
      if (thinkingConfig) gen.thinkingConfig = thinkingConfig;

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
      const res = await fetchFallback(
        "streamGenerateContent?alt=sse",
        headers,
        JSON.stringify(wrapped),
        options.abortSignal,
      );

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(
          `Gemini stream error ${res.status}: ${t || res.statusText}`,
        );
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

function parseSSE(
  body: ReadableStream<Uint8Array>,
): ReadableStream<LanguageModelV3StreamPart> {
  let buf = "";
  let started = false;
  let textId: string | null = null;
  let accText = "";
  let reasoningId: string | null = null;
  let accReasoning = "";

  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(ctrl) {
      const reader = body.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const evts = buf.split(/\r?\n\r?\n/);
          buf = evts.pop() ?? "";
          for (const e of evts) {
            const j = sseData(e);
            if (j) emit(j as Record<string, unknown>, ctrl);
          }
        }
        if (buf.trim()) {
          const j = sseData(buf);
          if (j) emit(j as Record<string, unknown>, ctrl);
        }
      } catch (err) {
        ctrl.enqueue({ type: "error", error: err });
      } finally {
        if (textId) {
          ctrl.enqueue({ type: "text-end", id: textId });
          textId = null;
        }
        if (reasoningId) {
          ctrl.enqueue({ type: "reasoning-end", id: reasoningId });
          reasoningId = null;
        }
        ctrl.enqueue({
          type: "finish",
          finishReason: { unified: "other", raw: undefined },
          usage: mapUsage(),
        });
        ctrl.close();
      }

      function sseData(raw: string): unknown | null {
        const dataLines: string[] = [];
        for (const l of raw.split(/\r?\n/)) {
          if (l.startsWith("data:")) {
            dataLines.push(l.slice(5).trim());
          }
        }
        if (dataLines.length === 0) return null;
        const payload = dataLines.join("\n").trim();
        if (!payload || payload === "[DONE]") return null;
        try {
          return JSON.parse(payload);
        } catch {
          return null;
        }
      }

      function emit(
        chunk: Record<string, unknown>,
        c: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
      ) {
        if (!started) {
          c.enqueue({ type: "stream-start", warnings: [] });
          started = true;
        }
        const inner = unwrap(chunk);
        if (process.env.NODE_ENV !== "production") {
          console.log(
            "[gemini] stream chunk",
            JSON.stringify(inner).slice(0, 2000),
          );
        }

        // Handle Candidates
        const cand = (
          inner.candidates as Array<{
            content?: { parts?: Array<Record<string, unknown>> };
            finishReason?: string;
          }>
        )?.[0];

        if (cand?.content?.parts) {
          for (const p of cand.content.parts) {
            const signature =
              typeof p.thoughtSignature === "string"
                ? p.thoughtSignature
                : undefined;

            if (
              (p as { thought?: boolean }).thought === true ||
              p.type === "thinking" ||
              p.type === "reasoning"
            ) {
              const fullReasoning =
                typeof p.text === "string"
                  ? p.text
                  : typeof (p as { thinking?: string }).thinking === "string"
                    ? (p as { thinking?: string }).thinking
                    : "";
              emitReasoning(fullReasoning ?? "", signature);
            } else if (typeof p.text === "string") {
              emitText(p.text, signature);
            } else if (
              p.functionCall &&
              typeof (p.functionCall as { name?: string }).name === "string"
            ) {
              const fc = p.functionCall as {
                name: string;
                args?: Record<string, unknown>;
              };
              // For tool calls, we need a unique ID for the call
              const id = callId();
              c.enqueue({ type: "tool-input-start", id, toolName: fc.name });
              const a = JSON.stringify(fc.args ?? {});
              c.enqueue({ type: "tool-input-delta", id, delta: a });
              c.enqueue({ type: "tool-input-end", id });
              c.enqueue({
                type: "tool-call",
                toolCallId: id,
                toolName: fc.name,
                input: a,
                providerMetadata: signature
                  ? { "gemini-oauth": { thoughtSignature: signature } }
                  : undefined,
              });
            }
          }
        }

        if (cand?.finishReason) {
          if (textId) {
            c.enqueue({ type: "text-end", id: textId });
            textId = null;
          }
          if (reasoningId) {
            c.enqueue({ type: "reasoning-end", id: reasoningId });
            reasoningId = null;
          }
          const usage = inner.usageMetadata as
            | {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                thoughtsTokenCount?: number;
              }
            | undefined;
          c.enqueue({
            type: "finish",
            finishReason: mapFinish(cand.finishReason),
            usage: mapUsage(usage),
          });
          return;
        }

        const usage = inner.usageMetadata as
          | {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              thoughtsTokenCount?: number;
            }
          | undefined;

        // If we have usage but no finish reason (sometimes happens at end of stream), emit finish
        if (!cand && usage) {
          if (textId) {
            c.enqueue({ type: "text-end", id: textId });
            textId = null;
          }
          if (reasoningId) {
            c.enqueue({ type: "reasoning-end", id: reasoningId });
            reasoningId = null;
          }

          c.enqueue({
            type: "finish",
            finishReason: { unified: "other", raw: undefined },
            usage: mapUsage(usage),
          });
        }

        function emitReasoning(fullReasoning: string, signature?: string) {
          if (!fullReasoning) return;
          const delta = fullReasoning.startsWith(accReasoning)
            ? fullReasoning.slice(accReasoning.length)
            : fullReasoning;
          if (delta) {
            if (!reasoningId) {
              reasoningId = callId();
              c.enqueue({
                type: "reasoning-start",
                id: reasoningId,
                providerMetadata: signature
                  ? { "gemini-oauth": { thoughtSignature: signature } }
                  : undefined,
              });
            }
            c.enqueue({
              type: "reasoning-delta",
              id: reasoningId,
              delta,
            });
            if (process.env.NODE_ENV !== "production") {
              console.log("[gemini] reasoning delta", delta.slice(0, 200));
            }
          }
          if (fullReasoning.length >= accReasoning.length)
            accReasoning = fullReasoning;
        }

        function emitText(full: string, signature?: string) {
          if (!full) return;
          const delta = full.startsWith(accText)
            ? full.slice(accText.length)
            : full;
          if (delta) {
            if (!textId) {
              textId = callId();
              c.enqueue({
                type: "text-start",
                id: textId,
                providerMetadata: signature
                  ? { "gemini-oauth": { thoughtSignature: signature } }
                  : undefined,
              });
            }
            c.enqueue({ type: "text-delta", id: textId, delta });
          }
          if (full.length >= accText.length) accText = full;
        }
      }
    },
  });
}
