import crypto from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  ToolCall,
} from "./chat-completions-client.js";
import type { ModelRequestObservation } from "../observability/model-usage.js";

export type ModelApiFormat = "completions" | "responses" | "messages";
export class ModelProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "ModelProtocolError"; }
}

/**
 * 根据显式配置或 BaseURL 自动解析目标模型 API 协议格式
 */
export function resolveModelFormat(
  explicitFormat?: ModelApiFormat | string,
  baseUrl?: string
): ModelApiFormat {
  if (explicitFormat) {
    const normalized = explicitFormat.trim().toLowerCase();
    if (normalized === "completions" || normalized === "responses" || normalized === "messages") {
      return normalized as ModelApiFormat;
    }
  }

  if (baseUrl) {
    const url = baseUrl.toLowerCase();
    if (url.includes("/anthropic") || url.endsWith("/messages")) {
      return "messages";
    }
    if (url.includes("/responses")) {
      return "responses";
    }
  }

  return "completions";
}

/**
 * 根据格式和 BaseURL 解析出真实的请求端点 URL
 */
export function resolveEndpointUrl(baseUrl: string, format: ModelApiFormat): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");

  switch (format) {
    case "completions": {
      if (cleanBase.endsWith("/chat/completions")) return cleanBase;
      return `${cleanBase}/chat/completions`;
    }
    case "responses": {
      if (cleanBase.endsWith("/responses")) return cleanBase;
      if (cleanBase.endsWith("/v1")) return `${cleanBase}/responses`;
      return `${cleanBase}/v1/responses`;
    }
    case "messages": {
      if (cleanBase.endsWith("/messages")) return cleanBase;
      if (cleanBase.endsWith("/anthropic/v1")) return `${cleanBase}/messages`;
      if (cleanBase.endsWith("/anthropic")) return `${cleanBase}/v1/messages`;
      if (cleanBase.includes("deepseek.com")) {
        // DeepSeek 官方 Anthropic 端点规范为 https://api.deepseek.com/anthropic/v1/messages
        const root = cleanBase.replace(/\/v1$/, "");
        return `${root}/anthropic/v1/messages`;
      }
      if (cleanBase.endsWith("/v1")) return `${cleanBase}/messages`;
      return `${cleanBase}/v1/messages`;
    }
  }
}

/**
 * 生成各协议所需的 HTTP 请求头
 */
export function buildHeaders(
  apiKey: string,
  format: ModelApiFormat,
  customHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...customHeaders,
  };

  if (format === "messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    // 兼容可能同时接受 Bearer 的代理网关
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return headers;
}

/**
 * 健壮的 JSON 解析助手
 */
function safeParseJson(str: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    return { raw: str };
  }
}

// ==========================================
// 1. OpenAI Chat Completions 协议适配
// ==========================================

export function serializeCompletionsRequest(
  request: ChatCompletionRequest,
  stream = false
): Record<string, unknown> {
  return {
    ...request,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

export function deserializeCompletionsResponse(
  raw: any
): ChatCompletionResponse {
  return raw as ChatCompletionResponse;
}

// ==========================================
// 2. OpenAI / DeepSeek Responses 协议适配
// ==========================================

export function serializeResponsesRequest(
  request: ChatCompletionRequest,
  stream = false
): Record<string, unknown> {
  const inputItems: Array<Record<string, unknown>> = [];

  for (const msg of request.messages) {
    if (msg.role === "system") {
      inputItems.push({
        type: "message",
        role: "system",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
    } else if (msg.role === "user") {
      inputItems.push({
        type: "message",
        role: "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
    } else if (msg.role === "assistant") {
      // DeepSeek Responses 协议严格约束：thinking 模式下必须将 reasoning_text 带回
      if (msg.reasoning_content) {
        inputItems.push({
          type: "reasoning",
          content: [{ type: "reasoning_text", text: msg.reasoning_content }],
        });
      }

      if (msg.content) {
        inputItems.push({
          type: "message",
          role: "assistant",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        });
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          inputItems.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
    } else if (msg.role === "tool") {
      inputItems.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
    }
  }

  const payload: Record<string, unknown> = {
    model: request.model,
    input: inputItems,
    stream,
  };

  if (typeof request.temperature === "number") {
    payload.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    payload.tools = request.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters ?? { type: "object", properties: {} },
    }));
  }

  return payload;
}

export function deserializeResponsesResponse(
  raw: any
): ChatCompletionResponse {
  let reasoningContent = "";
  let content = "";
  const toolCalls: ToolCall[] = [];

  const outputItems = Array.isArray(raw.output) ? raw.output : [];
  for (const item of outputItems) {
    if (item.type === "reasoning") {
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "reasoning_text" && part.text) {
            reasoningContent += part.text;
          }
        }
      }
    } else if (item.type === "message") {
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) {
            content += part.text;
          } else if (typeof part === "string") {
            content += part;
          }
        }
      } else if (typeof item.content === "string") {
        content += item.content;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || crypto.randomUUID(),
        type: "function",
        function: {
          name: item.name || "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }

  const usage = raw.usage
    ? {
        prompt_tokens: raw.usage.input_tokens ?? raw.usage.prompt_tokens,
        completion_tokens: raw.usage.output_tokens ?? raw.usage.completion_tokens,
        total_tokens: raw.usage.total_tokens ?? ((raw.usage.input_tokens ?? 0) + (raw.usage.output_tokens ?? 0)),
      }
    : undefined;

  return {
    id: raw.id || crypto.randomUUID(),
    model: raw.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content.length > 0 ? content : null,
          reasoning_content: reasoningContent.length > 0 ? reasoningContent : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage,
  };
}

// ==========================================
// 3. Anthropic Messages 协议适配
// ==========================================

export function serializeMessagesRequest(
  request: ChatCompletionRequest,
  stream = false
): Record<string, unknown> {
  let systemPrompt = "";
  const anthropicMessages: Array<Record<string, unknown>> = [];

  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      anthropicMessages.push({
        role: "user",
        content: [...pendingToolResults],
      });
      pendingToolResults = [];
    }
  };

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
    } else if (msg.role === "tool") {
      // Anthropic 将工具调用结果作为 user 消息中的 tool_result 内容块呈现
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
    } else if (msg.role === "user") {
      flushToolResults();
      anthropicMessages.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
    } else if (msg.role === "assistant") {
      flushToolResults();
      const contentParts: Array<Record<string, unknown>> = [];

      // 若有思考内容且需传递
      if (msg.reasoning_content) {
        contentParts.push({
          type: "thinking",
          thinking: msg.reasoning_content,
          signature: "synthetic",
        });
      }

      if (msg.content) {
        contentParts.push({
          type: "text",
          text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        });
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          contentParts.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: safeParseJson(tc.function.arguments),
          });
        }
      }

      anthropicMessages.push({
        role: "assistant",
        content: contentParts.length === 1 && contentParts[0]?.type === "text"
          ? (contentParts[0].text as string)
          : contentParts,
      });
    }
  }

  flushToolResults();

  const payload: Record<string, unknown> = {
    model: request.model,
    messages: anthropicMessages,
    max_tokens: 8192,
    stream,
  };

  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  if (typeof request.temperature === "number") {
    payload.temperature = request.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    payload.tools = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
  }

  return payload;
}

export function deserializeMessagesResponse(
  raw: any
): ChatCompletionResponse {
  let reasoningContent = "";
  let content = "";
  const toolCalls: ToolCall[] = [];

  const contentItems = Array.isArray(raw.content) ? raw.content : [];
  for (const item of contentItems) {
    if (item.type === "thinking" && item.thinking) {
      reasoningContent += item.thinking;
    } else if (item.type === "text" && item.text) {
      content += item.text;
    } else if (item.type === "tool_use") {
      toolCalls.push({
        id: item.id || crypto.randomUUID(),
        type: "function",
        function: {
          name: item.name || "",
          arguments: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {}),
        },
      });
    }
  }

  const usage = raw.usage
    ? {
        prompt_tokens: raw.usage.input_tokens,
        completion_tokens: raw.usage.output_tokens,
        total_tokens: (raw.usage.input_tokens ?? 0) + (raw.usage.output_tokens ?? 0),
        prompt_tokens_details: {
          cached_tokens: raw.usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: raw.usage.cache_creation_input_tokens ?? 0,
        },
      }
    : undefined;

  let finishReason = "stop";
  if (raw.stop_reason === "tool_use" || toolCalls.length > 0) {
    finishReason = "tool_calls";
  } else if (raw.stop_reason === "max_tokens") {
    finishReason = "length";
  }

  return {
    id: raw.id || crypto.randomUUID(),
    model: raw.model,
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
}

// ==========================================
// 4. 流式 SSE 事件到统一 ChatCompletionChunk 转换
// ==========================================

export async function* transformResponsesStream(
  sseEvents: AsyncGenerator<{ event?: string; data: string }, void, unknown>
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  let id = crypto.randomUUID();
  let model: string | undefined;
  const itemTypeMap = new Map<number, string>();
  const itemToolCallIndexMap = new Map<number, number>();
  let nextToolCallIdx = 0;
  let completed = false;

  for await (const { event, data } of sseEvents) {
    if (data === "[DONE]") break;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const eventType = event || parsed.type;
    if (eventType === "error" || eventType === "response.failed" || eventType === "response.incomplete" || parsed.error) throw new ModelProtocolError("Responses stream reported a provider failure");

    if (eventType === "response.created" && parsed.response) {
      if (parsed.response.id) id = parsed.response.id;
      if (parsed.response.model) model = parsed.response.model;
    } else if (eventType === "response.output_item.added" && parsed.item) {
      const idx = parsed.output_index ?? 0;
      itemTypeMap.set(idx, parsed.item.type);
      if (parsed.item.type === "function_call") {
        const tcIdx = nextToolCallIdx++;
        itemToolCallIndexMap.set(idx, tcIdx);
        yield {
          id,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: tcIdx,
                    id: parsed.item.call_id || parsed.item.id || crypto.randomUUID(),
                    type: "function",
                    function: {
                      name: parsed.item.name || "",
                      arguments: "",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
      }
    } else if ((eventType === "response.reasoning_text.delta" || eventType === "response.reasoning_summary_text.delta") && parsed.delta) {
      yield {
        id,
        model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: parsed.delta },
            finish_reason: null,
          },
        ],
      };
    } else if (eventType === "response.output_text.delta" && parsed.delta) {
      yield {
        id,
        model,
        choices: [
          {
            index: 0,
            delta: { content: parsed.delta },
            finish_reason: null,
          },
        ],
      };
    } else if (eventType === "response.function_call_arguments.delta" && parsed.delta) {
      const tcIdx = itemToolCallIndexMap.get(parsed.output_index ?? 0) ?? 0;
      yield {
        id,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: tcIdx,
                  function: { arguments: parsed.delta },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    } else if ((eventType === "response.done" || eventType === "response.completed") && parsed.response) {
      if (parsed.response.status === "failed" || parsed.response.status === "incomplete") throw new ModelProtocolError("Responses stream did not complete successfully");
      completed = true;
      const usage = parsed.response.usage
        ? {
            prompt_tokens: parsed.response.usage.input_tokens,
            completion_tokens: parsed.response.usage.output_tokens,
            total_tokens: parsed.response.usage.total_tokens ?? (typeof parsed.response.usage.input_tokens === "number" && typeof parsed.response.usage.output_tokens === "number" ? parsed.response.usage.input_tokens + parsed.response.usage.output_tokens : undefined),
            prompt_tokens_details: { cached_tokens: parsed.response.usage.input_tokens_details?.cached_tokens },
            completion_tokens_details: { reasoning_tokens: parsed.response.usage.output_tokens_details?.reasoning_tokens },
          }
        : undefined;

      yield {
        id,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: nextToolCallIdx > 0 ? "tool_calls" : "stop",
          },
        ],
        usage,
      };
    }
  }
  if (!completed) throw new ModelProtocolError("Responses stream ended before a terminal response event");
}

export async function* transformMessagesStream(
  sseEvents: AsyncGenerator<{ event?: string; data: string }, void, unknown>
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  let id = crypto.randomUUID();
  let model: string | undefined;
  const blockTypeMap = new Map<number, string>();
  const toolCallIndexMap = new Map<number, number>();
  let nextToolCallIdx = 0;
  let inputTokens: number | undefined, outputTokens: number | undefined;
  let completed = false;

  for await (const { event, data } of sseEvents) {
    if (data === "[DONE]") break;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const eventType = event || parsed.type;
    if (eventType === "error" || parsed.error) throw new ModelProtocolError("Messages stream reported a provider failure");
    if (eventType === "message_stop") { completed = true; continue; }

    if (eventType === "message_start" && parsed.message) {
      if (parsed.message.id) id = parsed.message.id;
      if (parsed.message.model) model = parsed.message.model;
      if (parsed.message.usage) {
        inputTokens = parsed.message.usage.input_tokens;
        outputTokens = parsed.message.usage.output_tokens;
        yield {
          id,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
          },
        };
      }
    } else if (eventType === "content_block_start" && parsed.content_block) {
      const blockIdx = parsed.index ?? 0;
      const bType = parsed.content_block.type;
      blockTypeMap.set(blockIdx, bType);

      if (bType === "tool_use") {
        const tcIdx = nextToolCallIdx++;
        toolCallIndexMap.set(blockIdx, tcIdx);
        yield {
          id,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: tcIdx,
                    id: parsed.content_block.id || crypto.randomUUID(),
                    type: "function",
                    function: {
                      name: parsed.content_block.name || "",
                      arguments: "",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
      }
    } else if (eventType === "content_block_delta" && parsed.delta) {
      const delta = parsed.delta;
      if (delta.type === "thinking_delta" && delta.thinking) {
        yield {
          id,
          model,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: delta.thinking },
              finish_reason: null,
            },
          ],
        };
      } else if (delta.type === "text_delta" && delta.text) {
        yield {
          id,
          model,
          choices: [
            {
              index: 0,
              delta: { content: delta.text },
              finish_reason: null,
            },
          ],
        };
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        const tcIdx = toolCallIndexMap.get(parsed.index ?? 0) ?? 0;
        yield {
          id,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: tcIdx,
                    function: { arguments: delta.partial_json },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
      }
    } else if (eventType === "message_delta") {
      if (parsed.delta?.stop_reason) completed = true;
      let finishReason = "stop";
      if (parsed.delta?.stop_reason === "tool_use" || nextToolCallIdx > 0) {
        finishReason = "tool_calls";
      } else if (parsed.delta?.stop_reason === "max_tokens") {
        finishReason = "length";
      }

      if (parsed.usage?.input_tokens !== undefined) inputTokens = parsed.usage.input_tokens;
      if (parsed.usage?.output_tokens !== undefined) outputTokens = parsed.usage.output_tokens;
      const usage = parsed.usage
        ? {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
          }
        : undefined;

      yield {
        id,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: parsed.delta?.stop_reason ? finishReason : null,
          },
        ],
        usage,
      };
    }
  }
  if (!completed) throw new ModelProtocolError("Messages stream ended before a terminal message event");
}
