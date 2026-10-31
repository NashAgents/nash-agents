import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { callChatCompletions, streamChatCompletions, accumulateChatCompletionStream, type ChatMessage } from "../src/model/chat-completions-client.js";
import type { ModelApiFormat } from "../src/model/model-adapter.js";

test("all three transports preserve real HTTP tool round trips, streaming usage and provider failures (local fixture)", async t => {
  const requests: Array<{ path: string; authorization?: string; apiKey?: string }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    requests.push({ path: req.url!, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined });
    const format = req.url!.endsWith("/responses") ? "responses" : req.url!.endsWith("/messages") ? "messages" : "completions";
    const tool = Boolean(body.tools?.length) && !raw.includes("tool_result") && !raw.includes("function_call_output") && !body.messages?.some((message: any) => message.role === "tool");
    const message = { role: "assistant", content: tool ? null : "ready", ...(tool ? { tool_calls: [{ id: "call-fixture", type: "function", function: { name: "echo", arguments: '{"value":"ready"}' } }] } : {}) };
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (body.model === "fixture-error") { event("error", { error: { message: "fixture error" } }); res.end(); return; }
      if (format === "responses") {
        event("response.created", { response: { id: "fixture", model: body.model } });
        if (tool) { event("response.output_item.added", { output_index: 0, item: { type: "function_call", call_id: "call-fixture", name: "echo" } }); event("response.function_call_arguments.delta", { output_index: 0, delta: '{"value":"ready"}' }); }
        else event("response.output_text.delta", { delta: "ready" });
        if (body.model !== "fixture-truncated") event("response.completed", { response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
      } else if (format === "messages") {
        event("message_start", { message: { id: "fixture", model: body.model, usage: { input_tokens: 5, output_tokens: 0 } } });
        if (tool) { event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call-fixture", name: "echo" } }); event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"value":"ready"}' } }); }
        else event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ready" } });
        if (body.model !== "fixture-truncated") { event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } }); event("message_stop", {}); }
      } else {
        res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : { content: "ready" }, finish_reason: null }] })}\n\n`);
        if (body.model !== "fixture-truncated") res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
      }
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      const output = format === "completions" ? { id: "fixture", model: body.model, choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : format === "responses" ? { id: "fixture", model: body.model, output: tool ? [{ type: "function_call", call_id: "call-fixture", name: "echo", arguments: '{"value":"ready"}' }] : [{ type: "message", content: [{ type: "output_text", text: "ready" }] }], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } }
        : { id: "fixture", model: body.model, content: tool ? [{ type: "tool_use", id: "call-fixture", name: "echo", input: { value: "ready" } }] : [{ type: "text", text: "ready" }], stop_reason: tool ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
      res.end(JSON.stringify(output));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const tools = [{ type: "function" as const, function: { name: "echo", parameters: { type: "object", properties: { value: { type: "string" } } } } }];
  for (const format of ["completions", "responses", "messages"] satisfies ModelApiFormat[]) {
    const options = { format, timeoutMs: 5000 }, messages: ChatMessage[] = [{ role: "user", content: "probe" }];
    const first = await callChatCompletions(baseUrl, "fixture-provider-key", { model: "fixture-model", messages, tools }, options);
    const call = first.choices[0].message.tool_calls![0]; assert.equal(call.function.name, "echo"); assert.deepEqual(JSON.parse(call.function.arguments), { value: "ready" });
    const follow = await callChatCompletions(baseUrl, "fixture-provider-key", { model: "fixture-model", messages: [...messages, first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "ready" }], tools }, options); assert.equal(follow.choices[0].message.content, "ready");
    const streamed = await accumulateChatCompletionStream(streamChatCompletions(baseUrl, "fixture-provider-key", { model: "fixture-model", messages, tools }, options)); assert.equal(streamed.response.choices[0].message.tool_calls![0].function.name, "echo"); assert.deepEqual(JSON.parse(streamed.response.choices[0].message.tool_calls![0].function.arguments), { value: "ready" }); assert.equal(streamed.response.usage?.prompt_tokens, 5); assert.equal(streamed.response.usage?.completion_tokens, 2); assert.equal(streamed.response.usage?.total_tokens, 7);
    await assert.rejects(async () => { for await (const _ of streamChatCompletions(baseUrl, "fixture-provider-key", { model: "fixture-error", messages }, options)) {} }, /failure/);
    await assert.rejects(async () => { for await (const _ of streamChatCompletions(baseUrl, "fixture-provider-key", { model: "fixture-truncated", messages }, options)) {} }, /terminal/);
  }
  assert.ok(requests.some(req => req.path === "/v1/responses")); assert.ok(requests.some(req => req.path === "/v1/messages" && req.apiKey === "fixture-provider-key")); assert.ok(requests.every(req => req.authorization === "Bearer fixture-provider-key"));
});
