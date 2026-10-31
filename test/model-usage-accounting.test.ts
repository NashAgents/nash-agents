import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callChatCompletions, streamChatCompletions, accumulateChatCompletionStream } from "../src/model/chat-completions-client.js";
import { aggregateModelUsage, attributeContext, normalizeProviderUsage, type ModelUsageRecord } from "../src/observability/model-usage.js";
import { defaultTraceContext } from "../src/observability/trace-context.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";

const request = { model: "test-model", messages: [{ role: "user" as const, content: "private input" }] };
async function provider(t: any, handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}

test("MOCK_UNIT: provider subsets are retained without double counting or invented zeros", () => {
  const usage = normalizeProviderUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 10 } }, true);
  assert.equal(usage.totalTokens, 120); assert.equal(usage.cacheReadTokens, 80); assert.equal(usage.reasoningTokens, 10);
  assert.equal(normalizeProviderUsage(undefined, true).inputTokens, null);
  assert.equal(normalizeProviderUsage({ prompt_tokens: 10 }, true).usageCompleteness, "PARTIAL");
  assert.equal(normalizeProviderUsage({ prompt_tokens: -1, completion_tokens: NaN }, true).totalTokens, null);
});

test("SIMULATED_INTEGRATION: nonstream ledger correlates purpose and trace without prompt text", async t => {
  const records: ModelUsageRecord[] = [];
  const url = await provider(t, (_, response) => response.end(JSON.stringify({ id: "provider-id", choices: [{ message: { content: "yes" } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })));
  await defaultTraceContext.run({ projectId: "p", sessionId: "s", traceId: "trace", spanId: "parent", taskId: "task", modelUsageSink: record => { records.push(record); } }, () => callChatCompletions(url, "private-key", request, { purpose: "security" }));
  assert.equal(records.length, 2); assert.equal(records[0]!.status, "started"); assert.equal(records[1]!.status, "completed");
  assert.equal(records[1]!.parentSpanId, "parent"); assert.equal(records[1]!.modelRequestId, "provider-id"); assert.equal(records[1]!.purpose, "security");
  assert.ok(!JSON.stringify(records).includes("private input")); assert.ok(!JSON.stringify(records).includes("private-key"));
  assert.equal(aggregateModelUsage([...records, records[1]!]).modelCalls, 1);
  assert.equal(aggregateModelUsage(records).totalTokens, 12);
});

test("SIMULATED_INTEGRATION: streaming usage snapshots and trailing usage are counted once", async t => {
  const records: ModelUsageRecord[] = [];
  const url = await provider(t, (_, response) => {
    response.setHeader("content-type", "text/event-stream");
    for (const chunk of [ { id: "stream-id", choices: [{ delta: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 1 } }, { id: "stream-id", choices: [], usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45, prompt_tokens_details: { cached_tokens: 30 } } } ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await accumulateChatCompletionStream(streamChatCompletions(url, "key", request, { usageSink: record => { records.push(record); } }));
  const totals = aggregateModelUsage(records);
  assert.equal(totals.totalTokens, 45); assert.equal(totals.cacheReadTokens, 30); assert.equal(totals.modelCalls, 1);
  assert.equal(records.at(-1)!.usageCompleteness, "COMPLETE"); assert.ok(records.at(-1)!.ttftMs! >= 0);
});

test("SIMULATED_INTEGRATION: missing usage remains unavailable even on successful completion", async t => {
  const records: ModelUsageRecord[] = [];
  const url = await provider(t, (_, response) => response.end(JSON.stringify({ id: "missing", choices: [{ message: { content: "ok" } }] })));
  await callChatCompletions(url, "key", request, { usageSink: record => { records.push(record); } });
  const totals = aggregateModelUsage(records);
  assert.equal(totals.inputTokens, null); assert.equal(totals.completeness, "PARTIAL"); assert.equal(totals.incompleteRequests, 1);
});

test("SIMULATED_INTEGRATION: timeout and early stream termination never claim completed", async t => {
  const records: ModelUsageRecord[] = [];
  const url = await provider(t, (_, response) => { response.setHeader("content-type", "text/event-stream"); response.write(`data: ${JSON.stringify({ id: "early", choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 8, completion_tokens: 1 } })}\n\n`); });
  for await (const _chunk of streamChatCompletions(url, "key", request, { usageSink: record => { records.push(record); } })) break;
  assert.equal(records.at(-1)!.status, "cancelled"); assert.equal(records.at(-1)!.usageCompleteness, "PARTIAL"); assert.equal(records.at(-1)!.inputTokens, 8);
  await assert.rejects(callChatCompletions(url, "key", request, { signal: AbortSignal.timeout(30), usageSink: record => { records.push(record); } }));
  assert.equal(records.at(-1)!.status, "timed_out");
});

test("MOCK_UNIT: context attribution is explicitly estimated and partitions tool schemas/results", () => {
  const context = attributeContext({ ...request, messages: [...request.messages, { role: "tool", content: "error evidence", tool_call_id: "c" }], tools: [{ type: "function", function: { name: "test" } }] });
  assert.equal(context.source, "LOCALLY_ESTIMATED"); assert.ok(context.estimatedTokens.tool_results! > 0); assert.ok(context.estimatedTokens.tool_schemas! > 0);
  assert.match(context.requestSha256, /^[a-f0-9]{64}$/);
});

test("SIMULATED_INTEGRATION: replay cannot revert terminal usage and pagination stays scoped", async t => {
  const store = new InMemoryClusterStore();
  const url = await provider(t, (_, response) => response.end(JSON.stringify({ id: "same-provider-id", choices: [{ message: { content: "ok" } }] })));
  const records: ModelUsageRecord[] = [];
  for (const graphId of ["a", "b"]) await callChatCompletions(url, "key", request, { context: { graphId }, usageSink: async record => { records.push(record); await store.saveModelUsage(record); } });
  await store.saveModelUsage(records[0]!);
  assert.equal((await store.listModelUsage({ graphId: "a" }))[0]!.status, "completed");
  assert.equal((await store.listModelUsage({ limit: 1 })).length, 1); assert.equal(aggregateModelUsage(records).modelCalls, 2);
  assert.equal(await store.purgeModelUsage(Date.now() + 1), 2);
});
