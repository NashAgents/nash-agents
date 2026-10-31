import {
  type ModelApiFormat,
  resolveModelFormat,
  resolveEndpointUrl,
  buildHeaders,
  serializeCompletionsRequest,
  deserializeCompletionsResponse,
  serializeResponsesRequest,
  deserializeResponsesResponse,
  transformResponsesStream,
  serializeMessagesRequest,
  deserializeMessagesResponse,
  transformMessagesStream,
} from "./model-adapter.js";
import { ModelRequestObservation, type ModelCallOptions } from "../observability/model-usage.js";
import { currentModelContext } from "../product/runtime.js";
import { ModelProtocolError } from "./model-adapter.js";
import https from "node:https";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveNashHome } from "../config/data-home.js";

/**
 * 模型 HTTP 层的类型化错误。
 *
 * 关键约束：message 必须与历史文本逐字节一致（`Model API request failed [status statusText]: body`），
 * 调用方已有断言依赖该文本；新增的 status / statusText / retryAfterMs 只作为结构化补充字段，
 * 让上层（如 Security Review）能区分 429 / 5xx / 网络错误，而不是解析字符串。
 */
export class ModelHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** 仅当响应携带可解析的 Retry-After 头时存在（毫秒）。 */
  readonly retryAfterMs?: number;

  constructor(status: number, statusText: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ModelHttpError";
    this.status = status;
    this.statusText = statusText;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 解析 Retry-After（秒数或 HTTP 日期），转换成毫秒；无法解析时返回 undefined。
 */
export function parseRetryAfterHeader(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Math.round(Number(trimmed) * 1000);
    return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

let cachedCa: Buffer | undefined | null = null;
/**
 * 读取 Coordinator 自签 CA。
 *
 * 关键修复：Node 的全局 fetch（undici）**不识别 `agent` 选项**，
 * 传入 `https.Agent` 会被静默忽略，自签证书仍然报 self-signed certificate。
 * 因此这里返回 CA 字节，由 fetchWithCa() 走 https.request 真正生效。
 */
function getCustomCa(urlStr: string): Buffer | undefined {
  if (!urlStr.startsWith("https:")) return undefined;
  if (cachedCa !== null) return cachedCa ?? undefined;
  try {
    const caPath = path.join(resolveNashHome(), "nash-ca.crt");
    cachedCa = fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined;
  } catch {
    cachedCa = undefined;
  }
  return cachedCa ?? undefined;
}

/** 用显式 CA 发起请求并包装成标准 Response；无 CA 时退回原生 fetch。 */
async function fetchWithCa(urlStr: string, init: RequestInit & { agent?: unknown }, ca?: Buffer): Promise<Response> {
  if (!ca) return fetch(urlStr, init as RequestInit);
  const url = new URL(urlStr);
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
  const body = typeof init.body === "string" ? init.body : undefined;
  const incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? "POST", headers, ca, signal: init.signal as AbortSignal | undefined }, resolve);
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const stream = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: incoming.statusCode ?? 500,
    statusText: incoming.statusMessage ?? "",
    headers: Object.fromEntries(Object.entries(incoming.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")])),
  });
}

export type { ModelApiFormat };
export { resolveModelFormat };

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean | null;
}

export interface ChatCompletionTool {
  type: "function";
  function: FunctionDefinition;
}

export interface ToolCall { // 工具调用
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessageTextPart {
  type: "text";
  text: string;
}

export interface ChatMessageImagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ChatMessageContentPart = ChatMessageTextPart | ChatMessageImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ChatMessageContentPart[] | any;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];  // content和tool_calls是互斥的，content为null时，tool_calls必须有值，且有tool_call一定是assistant角色
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

export interface ProviderTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cached_tokens?: number;
  uncached_prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface ChatCompletionResponse {
  model?: string;
  id: string;
  choices: ChatCompletionChoice[];
  usage?: ProviderTokenUsage;
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  thought?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ProviderTokenUsage;
}

/**
 * 健壮的 SSE (Server-Sent Events) 数据行异步解析器
 * 正确处理 TCP/HTTP 分包、跨包拼装与 UTF-8 多字节字符边界
 */

export interface SseEventMessage {
  event?: string;
  data: string;
}

/**
 * 健壮的 SSE 事件行解析器，保留 event 与 data 关联
 */
export async function* parseSseEvents(
  stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream | AsyncIterable<Uint8Array | Buffer | string>
): AsyncGenerator<SseEventMessage, void, unknown> {
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  const asyncIterable =
    "getReader" in stream && typeof (stream as any).getReader === "function"
      ? (async function* () {
          const reader = (stream as ReadableStream<Uint8Array>).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) yield value;
            }
          } finally {
            reader.releaseLock();
          }
        })()
      : (stream as AsyncIterable<Uint8Array | Buffer | string>);

  let currentEvent: string | undefined;

  for await (const chunk of asyncIterable) {
    if (typeof chunk === "string") {
      buffer += chunk;
    } else {
      buffer += decoder.decode(chunk, { stream: true });
    }

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) {
        if (!trimmed) {
          currentEvent = undefined;
        }
        continue;
      }

      if (trimmed.startsWith("event:")) {
        currentEvent = trimmed.slice(6).trim();
      } else if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        yield { event: currentEvent, data };
      }
    }
  }

  const remainder = buffer.trim();
  if (remainder.startsWith("data:")) {
    yield { event: currentEvent, data: remainder.slice(5).trim() };
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream | AsyncIterable<Uint8Array | Buffer | string>
): AsyncGenerator<string, void, unknown> {
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  const asyncIterable =
    "getReader" in stream && typeof (stream as any).getReader === "function"
      ? (async function* () {
          const reader = (stream as ReadableStream<Uint8Array>).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) yield value;
            }
          } finally {
            reader.releaseLock();
          }
        })()
      : (stream as AsyncIterable<Uint8Array | Buffer | string>);

  for await (const chunk of asyncIterable) {
    if (typeof chunk === "string") {
      buffer += chunk;
    } else {
      buffer += decoder.decode(chunk, { stream: true });
    }

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        yield data;
      }
    }
  }

  // 处理末尾残留
  const remainder = buffer.trim();
  if (remainder.startsWith("data:")) {
    yield remainder.slice(5).trim();
  }
}

/**
 * 发起 SSE 流式 Chat Completions 请求并逐 chunk 产生增量
 */
export async function* streamChatCompletions(
  baseUrl: string,
  apiKey: string,
  request: ChatCompletionRequest,
  options?: ModelCallOptions & { format?: ModelApiFormat }
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  const contextModel = options?.purpose === "security" ? currentModelContext()?.security : currentModelContext()?.main;
  const inherited = contextModel?.baseUrl === baseUrl && contextModel.apiKey === apiKey ? contextModel : undefined;
  const format = resolveModelFormat(options?.format ?? inherited?.format, baseUrl);
  const targetUrl = resolveEndpointUrl(baseUrl, format);
  const headers = buildHeaders(apiKey, format, { ...inherited?.headers, ...options?.headers });
  const timeoutMs = options?.timeoutMs ?? inherited?.timeoutMs;
  const requestSignal = timeoutMs ? AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)]) : options?.signal;

  let requestBody: Record<string, unknown>;
  switch (format) {
    case "completions":
      requestBody = serializeCompletionsRequest(request, true);
      break;
    case "responses":
      requestBody = serializeResponsesRequest(request, true);
      break;
    case "messages":
      requestBody = serializeMessagesRequest(request, true);
      break;
  }

  const observation = new ModelRequestObservation(baseUrl, request, { ...options, signal: requestSignal });
  await observation.started();
  let completed = false;
  let failure: unknown;
  let response: Response | undefined;
  try {
    response = await fetchWithCa(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: requestSignal,
    }, getCustomCa(targetUrl));
    observation.responseHeaders(response);
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Model API stream request failed [${response.status}]: ${(apiKey ? errText.replaceAll(apiKey, "[REDACTED]") : errText).slice(0, 300)}`);
    }
    if (!response.body) throw new Error("Model API returned empty response body for SSE stream.");

    if (format === "completions") {
      for await (const data of parseSseStream(response.body)) {
        if (data === "[DONE]") { completed = true; break; }
        let parsed: ChatCompletionChunk;
        try { parsed = JSON.parse(data) as ChatCompletionChunk; } catch { continue; }
        if ((parsed as ChatCompletionChunk & { error?: unknown }).error) throw new ModelProtocolError("Completions stream reported a provider failure");
        if (parsed.choices?.some(choice => Boolean(choice.finish_reason))) completed = true;
        observation.chunk(parsed);
        yield parsed;
      }
      if (!completed) throw new ModelProtocolError("Completions stream ended before a terminal event");
    } else if (format === "responses") {
      for await (const chunk of transformResponsesStream(parseSseEvents(response.body))) {
        observation.chunk(chunk);
        yield chunk;
      }
      completed = true;
    } else if (format === "messages") {
      for await (const chunk of transformMessagesStream(parseSseEvents(response.body))) {
        observation.chunk(chunk);
        yield chunk;
      }
      completed = true;
    }
  } catch (error) { failure = error; throw error; }
  finally {
    await response?.body?.cancel().catch(() => {});
    await observation.finish(completed ? "completed" : failure ? "failed" : "cancelled", failure);
  }
}

export interface AccumulatedStreamResult {
  response: ChatCompletionResponse;
  reasoning_content: string;
}

export interface StreamChunkCallbacks {
  onThoughtDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
}

/**
 * 流式 Think 标签解析状态机，支持跨 chunk 识别 <think>...</think> 思考块
 */
export class StreamThoughtExtractor {
  private buffer = "";
  private inThinkTag = false;
  private currentTagType: "think" | "thought" | "reasoning" | null = null;
  private reasoningAccumulated = "";
  private contentAccumulated = "";

  private readonly callbacks?: StreamChunkCallbacks;

  constructor(callbacks?: StreamChunkCallbacks) {
    this.callbacks = callbacks;
  }

  feedContent(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (!this.inThinkTag) {
        // 查找思考开始标签
        const thinkMatch = this.buffer.match(/<(think|thought|reasoning)>/i);
        if (thinkMatch && typeof thinkMatch.index === "number") {
          const startIdx = thinkMatch.index;
          const tagLen = thinkMatch[0].length;
          const tagType = thinkMatch[1]!.toLowerCase() as "think" | "thought" | "reasoning";

          const beforeTag = this.buffer.substring(0, startIdx);
          if (beforeTag) {
            this.contentAccumulated += beforeTag;
            this.callbacks?.onContentDelta?.(beforeTag);
          }

          this.inThinkTag = true;
          this.currentTagType = tagType;
          this.buffer = this.buffer.substring(startIdx + tagLen);
        } else {
          // 检查尾部是否包含部分开标签前缀 (如 "<", "<t", "<th", "<think")
          const partialMatch = this.buffer.match(/<[a-zA-Z]*$/);
          if (partialMatch && typeof partialMatch.index === "number") {
            const emitLen = partialMatch.index;
            if (emitLen > 0) {
              const toEmit = this.buffer.substring(0, emitLen);
              this.contentAccumulated += toEmit;
              this.callbacks?.onContentDelta?.(toEmit);
              this.buffer = this.buffer.substring(emitLen);
            }
            break;
          } else {
            this.contentAccumulated += this.buffer;
            this.callbacks?.onContentDelta?.(this.buffer);
            this.buffer = "";
          }
        }
      } else {
        // 查找思考结束标签
        const tag = this.currentTagType ?? "think";
        const closePattern = new RegExp(`</(${tag}|think|thought|reasoning)>`, "i");
        const closeMatch = this.buffer.match(closePattern);

        if (closeMatch && typeof closeMatch.index === "number") {
          const endIdx = closeMatch.index;
          const tagLen = closeMatch[0].length;

          const thoughtContent = this.buffer.substring(0, endIdx);
          if (thoughtContent) {
            this.reasoningAccumulated += thoughtContent;
            this.callbacks?.onThoughtDelta?.(thoughtContent);
          }

          this.inThinkTag = false;
          this.currentTagType = null;
          this.buffer = this.buffer.substring(endIdx + tagLen);
        } else {
          // 检查尾部是否包含部分闭标签前缀 (如 "</", "</t", "</th")
          const partialMatch = this.buffer.match(/<\/[a-zA-Z]*$/);
          if (partialMatch && typeof partialMatch.index === "number") {
            const emitLen = partialMatch.index;
            if (emitLen > 0) {
              const toEmit = this.buffer.substring(0, emitLen);
              this.reasoningAccumulated += toEmit;
              this.callbacks?.onThoughtDelta?.(toEmit);
              this.buffer = this.buffer.substring(emitLen);
            }
            break;
          } else {
            this.reasoningAccumulated += this.buffer;
            this.callbacks?.onThoughtDelta?.(this.buffer);
            this.buffer = "";
          }
        }
      }
    }
  }

  feedExplicitThought(thoughtDelta: string): void {
    if (!thoughtDelta) return;
    this.reasoningAccumulated += thoughtDelta;
    this.callbacks?.onThoughtDelta?.(thoughtDelta);
  }

  flush(): { content: string; reasoning: string } {
    if (this.buffer.length > 0) {
      if (this.inThinkTag) {
        this.reasoningAccumulated += this.buffer;
        this.callbacks?.onThoughtDelta?.(this.buffer);
      } else {
        this.contentAccumulated += this.buffer;
        this.callbacks?.onContentDelta?.(this.buffer);
      }
      this.buffer = "";
    }

    return {
      content: this.contentAccumulated,
      reasoning: this.reasoningAccumulated,
    };
  }
}

/**
 * 实时累积流式 Chunk，拼装思考过程、正文内容与索引化工具调用
 */
export async function accumulateChatCompletionStream(
  stream: AsyncIterable<ChatCompletionChunk> | Iterable<ChatCompletionChunk>,
  callbacks?: StreamChunkCallbacks,
  signal?: AbortSignal
): Promise<AccumulatedStreamResult> {
  let id: string = crypto.randomUUID();
  let finishReason = "stop";
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
  const idToIndexMap = new Map<string, number>();
  const rawToActiveIndex = new Map<number, number>();
  let lastActiveIndex = 0;
  let usage: ChatCompletionResponse["usage"];

  const extractor = new StreamThoughtExtractor(callbacks);

  for await (const chunk of stream) {
    if (signal?.aborted) {
      throw new Error("Stream aborted by caller.");
    }
    if (chunk.id) id = chunk.id;
    if (chunk.usage) usage = chunk.usage;

    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) continue;

      // 1. 提取独立字段思考内容 (兼容 reasoning_content, thought, reasoning)
      const thoughtChunk = delta.reasoning_content ?? delta.thought ?? delta.reasoning;
      if (thoughtChunk) {
        extractor.feedExplicitThought(thoughtChunk);
      }

      // 2. 提取正文内容并做 <think> 流式分流
      if (delta.content) {
        extractor.feedContent(delta.content);
      }

      // 3. 提取并按 index / id 累积分片工具调用
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let resolvedIndex: number;
          const rawIndex = tc.index ?? 0;

          if (tc.id) {
            if (idToIndexMap.has(tc.id)) {
              resolvedIndex = idToIndexMap.get(tc.id)!;
            } else {
              // 检查 rawIndex 对应的 entry 是否已被其他 call_id 占用
              const existingAtRaw = toolCallsMap.get(rawIndex);
              if (existingAtRaw && existingAtRaw.id && existingAtRaw.id !== tc.id) {
                // 网关对多工具调用固定输出了相同的 index (如 index: 0)，分配新槽位
                resolvedIndex = toolCallsMap.size;
                while (toolCallsMap.has(resolvedIndex)) resolvedIndex++;
              } else {
                resolvedIndex = rawIndex;
              }
              idToIndexMap.set(tc.id, resolvedIndex);
            }
          } else if (tc.index !== undefined) {
            resolvedIndex = rawToActiveIndex.get(tc.index) ?? tc.index;
          } else {
            resolvedIndex = lastActiveIndex;
          }

          if (tc.index !== undefined) rawToActiveIndex.set(tc.index, resolvedIndex);
          lastActiveIndex = resolvedIndex;

          let entry = toolCallsMap.get(resolvedIndex);
          if (!entry) {
            entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
            toolCallsMap.set(resolvedIndex, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) {
            const incoming = tc.function.name;
            if (!entry.name) {
              entry.name = incoming;
            } else if (incoming.startsWith(entry.name)) {
              // 兼容部分网关/反代的累计型输出 (如 "search" -> "search_files")
              entry.name = incoming;
            } else {
              // 标准 OpenAI SSE delta 纯增量追加 (如 "test_case_" + "test")
              entry.name += incoming;
            }
          }
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }
  }

  const { content, reasoning: reasoningContent } = extractor.flush();

  const toolCalls: ToolCall[] = Array.from(toolCallsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, val]) => ({
      id: val.id || crypto.randomUUID(),
      type: "function",
      function: {
        name: val.name,
        arguments: val.arguments,
      },
    }));

  const assembledResponse: ChatCompletionResponse = {
    id,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content.length > 0 ? content : null,
          reasoning_content: reasoningContent.length > 0 ? reasoningContent : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };

  return {
    response: assembledResponse,
    reasoning_content: reasoningContent,
  };
}

export async function callChatCompletions(
  baseUrl: string,
  apiKey: string,
  request: ChatCompletionRequest,
  options?: ModelCallOptions & { format?: ModelApiFormat }
): Promise<ChatCompletionResponse> {
  const contextModel = options?.purpose === "security" ? currentModelContext()?.security : currentModelContext()?.main;
  const inherited = contextModel?.baseUrl === baseUrl && contextModel.apiKey === apiKey ? contextModel : undefined;
  const format = resolveModelFormat(options?.format ?? inherited?.format, baseUrl);
  const targetUrl = resolveEndpointUrl(baseUrl, format);
  const headers = buildHeaders(apiKey, format, { ...inherited?.headers, ...options?.headers });
  const timeoutMs = options?.timeoutMs ?? inherited?.timeoutMs;
  const requestSignal = timeoutMs ? AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)]) : options?.signal;

  let requestBody: Record<string, unknown>;
  switch (format) {
    case "completions":
      requestBody = serializeCompletionsRequest(request, false);
      break;
    case "responses":
      requestBody = serializeResponsesRequest(request, false);
      break;
    case "messages":
      requestBody = serializeMessagesRequest(request, false);
      break;
  }

  const observation = new ModelRequestObservation(baseUrl, request, { ...options, signal: requestSignal });
  await observation.started();
  try {
    const response = await fetchWithCa(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: requestSignal,
    }, getCustomCa(targetUrl));
    observation.responseHeaders(response);
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const message = `Model API request failed [${response.status} ${response.statusText}]: ${(apiKey ? errText.replaceAll(apiKey, "[REDACTED]") : errText).slice(0, 300)}`;
      throw new ModelHttpError(
        response.status,
        response.statusText,
        message,
        parseRetryAfterHeader(response.headers?.get?.("retry-after")),
      );
    }
    const rawData = await response.json();

    let data: ChatCompletionResponse;
    switch (format) {
      case "completions":
        data = deserializeCompletionsResponse(rawData);
        break;
      case "responses":
        data = deserializeResponsesResponse(rawData);
        break;
      case "messages":
        data = deserializeMessagesResponse(rawData);
        break;
    }

    observation.chunk({ id: data.id, model: data.model, usage: data.usage });
    if (!data.choices?.length) throw new Error("Invalid model response: choices array is empty.");
    await observation.finish("completed");
    return data;
  } catch (error) { await observation.finish("failed", error); throw error; }
}

/**
 * 通用模型调用入口（callChatCompletions 的现代语义别名）
 */
export const callModel = callChatCompletions;

/**
 * 通用流式模型调用入口（streamChatCompletions 的现代语义别名）
 */
export const streamModel = streamChatCompletions;
