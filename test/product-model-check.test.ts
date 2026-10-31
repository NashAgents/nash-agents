import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { testModelProfile, ModelProbeError } from "../src/product/model-check.js";
import type { ResolvedModel } from "../src/product/types.js";

test("capability probe verifies streaming tool arguments and reasoning/tool-result continuation before success", async t => {
  const received: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); received.push(body);
    const follow = body.messages.some((message: any) => message.role === "tool");
    const tool = Boolean(body.tools?.length) && !follow;
    const name = "nash_connection_probe", call = { id: "call-probe", type: "function", function: { name, arguments: '{"value":"nash-ready"}' } };
    if (!body.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: "fixture", choices: [{ index: 0, message: { role: "assistant", content: tool ? null : "OK", ...(tool ? { tool_calls: [call], reasoning_content: "probe requires an echo tool" } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } : {}) })}\n\n`);
    if (body.messages[0]?.content.includes("Count from 1")) { chunk({ content: "1" }); const timer = setInterval(() => chunk({ content: "2" }), 100); res.once("close", () => clearInterval(timer)); return; }
    if (tool) { chunk({ reasoning_content: "probe requires an echo tool" }); chunk({ tool_calls: [{ index: 0, id: "call-probe", type: "function", function: { name: "nash_connection_", arguments: '{"value":"' } }] }); chunk({ tool_calls: [{ index: 0, function: { name: "probe", arguments: 'nash-ready"}' } }] }); }
    else chunk({ content: "OK" });
    if (body.model !== "fixture-truncated") { chunk({}, tool ? "tool_calls" : "stop"); res.write("data: [DONE]\n\n"); }
    res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const profile: ResolvedModel = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "fixture-probe", apiKey: "fixture-api-key", format: "completions", contextWindow: 64000, compactionThreshold: 0.8, timeoutMs: 5000, streaming: true, toolCalling: true, configurationVersion: 1 };
  const result = await testModelProfile(profile); assert.equal(result.passed, true); assert.equal(result.checks.streamingTools, true); assert.equal(result.checks.streamingArguments, true); assert.equal(result.checks.streamingMultiTurn, true); assert.equal(result.checks.cancellation, true); assert.equal(result.usageReported, true);
  const follow = received.find(body => body.stream && body.messages.some((message: any) => message.role === "tool")); assert.equal(follow.messages.find((message: any) => message.role === "assistant").reasoning_content, "probe requires an echo tool"); assert.equal(follow.messages.find((message: any) => message.role === "tool").tool_call_id, "call-probe");
  await assert.rejects(testModelProfile({ ...profile, model: "fixture-truncated" }), (error: unknown) => error instanceof ModelProbeError && error.stage === "streaming-tool-call");
});
