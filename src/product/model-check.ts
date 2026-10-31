import { callChatCompletions, streamChatCompletions, accumulateChatCompletionStream, type ChatMessage } from "../model/chat-completions-client.js";
import type { ResolvedModel } from "./types.js";
import { ProductConfigError } from "./types.js";

export interface ModelCheckResult { passed: boolean; checks: Record<string, boolean>; format: string; model: string; durationMs: number; usageReported: boolean }
export class ModelProbeError extends ProductConfigError {
  constructor(readonly stage: string, readonly checks: Record<string, boolean>) { super(`模型能力测试失败，阶段：${stage}；配置未应用`, "MODEL_CHECK_FAILED"); this.name = "ModelProbeError"; }
}
export async function testModelProfile(profile: ResolvedModel, signal?: AbortSignal): Promise<ModelCheckResult> {
  const start = Date.now(), checks: Record<string, boolean> = {};
  const options = { format: profile.format, headers: profile.headers, timeoutMs: Math.min(profile.timeoutMs, 120000), signal, purpose: "unspecified" as const };
  const probe = async <T>(stage: string, run: () => Promise<T>): Promise<T> => { try { return await run(); } catch { signal?.throwIfAborted(); throw new ModelProbeError(stage, { ...checks }); } };
  const text = await probe("text", () => callChatCompletions(profile.baseUrl, profile.apiKey, { model: profile.model, messages: [{ role: "user", content: "Reply with the word OK only." }] }, options));
  checks.text = Boolean(text.choices[0]?.message.content);
  let usageReported = Boolean(text.usage);
  const tools = [{ type: "function" as const, function: { name: "nash_connection_probe", description: "Echo a probe value to verify tool invocation.", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } }];
  const messages: ChatMessage[] = [{ role: "user", content: "Call nash_connection_probe exactly once with value 'nash-ready'. Do not answer in text before calling the tool." }];
  const toolResponse = await probe("tool-call", () => callChatCompletions(profile.baseUrl, profile.apiKey, { model: profile.model, messages, tools }, options));
  const assistant = toolResponse.choices[0]?.message, calls = assistant?.tool_calls;
  if (calls?.length !== 1 || calls[0].function.name !== "nash_connection_probe") throw new ProductConfigError("模型未按要求调用测试工具，配置未应用", "MODEL_TOOL_CHECK_FAILED");
  let args: unknown; try { args = JSON.parse(calls[0].function.arguments); } catch { throw new ProductConfigError("模型返回的工具参数不是 JSON", "MODEL_TOOL_CHECK_FAILED"); }
  checks.tools = true;
  checks.arguments = Boolean(args && typeof args === "object" && (args as { value?: unknown }).value === "nash-ready");
  if (!checks.arguments) throw new ProductConfigError("模型测试工具参数错误", "MODEL_TOOL_CHECK_FAILED");
  const followup = await probe("multi-turn", () => callChatCompletions(profile.baseUrl, profile.apiKey, { model: profile.model, messages: [...messages, { ...assistant, role: "assistant" }, { role: "tool", tool_call_id: calls[0].id, content: "nash-ready" }, { role: "user", content: "The tool succeeded. Reply OK without further tool calls." }], tools }, options));
  checks.multiTurn = Boolean(followup.choices[0]?.message.content) && !followup.choices[0]?.message.tool_calls?.length;
  const streamed = await probe("streaming-tool-call", () => accumulateChatCompletionStream(streamChatCompletions(profile.baseUrl, profile.apiKey, { model: profile.model, messages, tools }, options)));
  const streamAssistant = streamed.response.choices[0]?.message, streamCall = streamAssistant?.tool_calls?.[0];
  checks.streamingTools = streamAssistant?.tool_calls?.length === 1 && streamCall?.function.name === "nash_connection_probe";
  if (!checks.streamingTools || !streamCall) throw new ModelProbeError("streaming-tool-name", { ...checks });
  try { checks.streamingArguments = JSON.parse(streamCall.function.arguments).value === "nash-ready"; } catch { checks.streamingArguments = false; }
  if (!checks.streamingArguments) throw new ModelProbeError("streaming-tool-arguments", { ...checks });
  const streamFollowup = await probe("streaming-multi-turn", () => accumulateChatCompletionStream(streamChatCompletions(profile.baseUrl, profile.apiKey, { model: profile.model, messages: [...messages, { ...streamAssistant, role: "assistant" }, { role: "tool", tool_call_id: streamCall.id, content: "nash-ready" }, { role: "user", content: "The tool succeeded. Reply OK without further tool calls." }], tools }, options)));
  checks.streamingMultiTurn = Boolean(streamFollowup.response.choices[0]?.message.content) && !streamFollowup.response.choices[0]?.message.tool_calls?.length;
  checks.streaming = checks.streamingMultiTurn;
  usageReported ||= Boolean(streamed.response.usage || streamFollowup.response.usage);
  const cancel = new AbortController();
  const stream = streamChatCompletions(profile.baseUrl, profile.apiKey, { model: profile.model, messages: [{ role: "user", content: "Count from 1 to 100, writing each number separately." }] }, { ...options, signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal });
  try {
    const first = await probe("cancellation-start", () => stream.next());
    if (first.done) throw new ProductConfigError("模型没有返回可取消的数据流", "MODEL_CANCEL_CHECK_FAILED");
    cancel.abort(new DOMException("Connection probe cancellation", "AbortError"));
    checks.cancellation = false;
    try { for (let index = 0; index < 256; index++) { if ((await stream.next()).done) break; } } catch { checks.cancellation = true; }
  } finally { await stream.return(); }
  const passed = Object.values(checks).every(Boolean);
  if (!passed) throw new ModelProbeError(Object.entries(checks).find(([, value]) => !value)?.[0] ?? "unknown", { ...checks });
  return { passed, checks, format: profile.format ?? "completions", model: profile.model, durationMs: Date.now() - start, usageReported };
}
