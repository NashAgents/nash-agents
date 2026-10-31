import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/observability/event-bus.js";
import { InstrumentationService } from "../src/observability/instrumentation-service.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { projectExecutionProvenance } from "../src/cluster/graph/execution-provenance.js";

test("MOCK_UNIT: serial span durations use a monotonic clock even if wall time moves backwards", async (t) => {
  let monotonic = 0; let wall = 10000; const events: any[] = [];
  t.mock.method(Date, "now", () => wall);
  const bus = new EventBus(); bus.subscribe("*", (e) => { events.push(e); });
  const service = new InstrumentationService({ eventBus: bus, monotonicNow: () => monotonic });
  await service.runSpan("one", {}, async () => { monotonic += 40; wall -= 500; }, { eventTypePrefix: "tool" });
  await service.runSpan("two", {}, async () => { monotonic += 60; wall -= 500; }, { eventTypePrefix: "tool" });
  assert.deepEqual(events.filter((e) => e.type === "tool.completed").map((e) => e.data.durationMs), [40, 60]);
  assert.equal(monotonic, 100);
});
test("MOCK_UNIT: overlapping spans do not turn summed execution into wall time", async () => {
  let monotonic = 0; const events: any[] = []; const bus = new EventBus(); bus.subscribe("*", (e) => { events.push(e); });
  const service = new InstrumentationService({ eventBus: bus, monotonicNow: () => monotonic });
  let releaseA!: () => void; let releaseB!: () => void;
  const a = service.runSpan("A", {}, () => new Promise<void>((resolve) => { releaseA = resolve; }), { eventTypePrefix: "tool" });
  const b = service.runSpan("B", {}, () => new Promise<void>((resolve) => { releaseB = resolve; }), { eventTypePrefix: "tool" });
  monotonic = 50; releaseA(); await a; monotonic = 90; releaseB(); await b;
  const sum = events.filter((e) => e.type === "tool.completed").reduce((n, e) => n + e.data.durationMs, 0);
  assert.equal(sum, 140); assert.equal(monotonic, 90);
});
test("MOCK_UNIT: timeout and cancellation produce failed spans, never completed spans", async () => {
  let monotonic = 0; const events: any[] = []; const bus = new EventBus(); bus.subscribe("*", (e) => { events.push(e); });
  const service = new InstrumentationService({ eventBus: bus, monotonicNow: () => monotonic });
  await assert.rejects(service.runSpan("model-timeout", {}, async () => { monotonic = 20; throw new Error("timeout"); }, { eventTypePrefix: "model" }), /timeout/);
  assert.equal(events.filter((e) => e.type === "model.completed").length, 0);
  assert.equal(events.find((e) => e.type === "model.failed").data.durationMs, 20);
});
test("SIMULATED_INTEGRATION: graph wall time, critical task chain and summed work remain distinct under clock skew", async () => {
  const store = new InMemoryClusterStore();
  await store.saveGraph({ graphId: "g", revision: 1, status: "completed", createdAt: 8000, completedAt: 10000 } as any);
  for (const [id, duration] of [["A", 300], ["B", 400], ["join", 250]] as const) {
    await store.saveGraphNode({ graphId: "g", nodeId: id, taskId: id, status: "completed" } as any);
    await store.saveTask({ taskId: id, runId: `run-${id}`, nodeId: `worker-${id}` } as any);
    await store.appendEvents([{ taskId: id, runId: `run-${id}`, nodeId: `worker-${id}`, seq: 1, timestamp: id === "A" ? -1e12 : 1e12, eventType: "task.completed", data: { durationMs: duration } }]);
  }
  await store.saveGraphEdges(["A", "B"].map((id) => ({ graphId: "g", fromNodeId: id, toNodeId: "join" } as any)));
  const result = (await projectExecutionProvenance(store, "g"))!;
  assert.equal(result.graphWallTimeMs, 2000); assert.equal(result.taskCriticalPathMs, 650); assert.equal(result.summedWorkerExecutionMs, 950);
});


test("MOCK_UNIT: ToolExecutor preserves explicit business failure without requiring a preformatted output string", async () => {
  const { ToolExecutor } = await import("../src/tools/executor.js");
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const registry = new ToolRegistry(); registry.register({ name: "business_failure", description:"fixture", parameters:{type:"object"}, execute:async()=>({success:false,error:"CONSTRAINT_REJECTED"}) });
  const result = await new ToolExecutor(registry).execute("business_failure",{});
  assert.equal(result.success,false); assert.match(result.output,/CONSTRAINT_REJECTED/); assert.ok(result.executionTimeMs! >= 0);
});


test("SIMULATED_INTEGRATION: graph metrics combine native token fields with planner/replanner/review usage and expose unknown calls", async () => {
  const store=new InMemoryClusterStore();
  await store.saveGraph({graphId:"usage",revision:1,status:"running",createdAt:0,strategyDecision:{planningRequestIds:["plan"],planningTokens:{promptTokens:10,completionTokens:2,totalTokens:12}}} as any);
  await store.saveGraphNode({graphId:"usage",nodeId:"node",taskId:"task"} as any);
  await store.saveTask({taskId:"task",runId:"run",nodeId:"worker"} as any);
  await store.appendEvents([{taskId:"task",runId:"run",nodeId:"worker",seq:1,timestamp:1,eventType:"model.completed",data:{hasUsage:true,inTokens:20,outTokens:3}},{taskId:"task",runId:"run",nodeId:"worker",seq:2,timestamp:2,eventType:"model.failed",data:{}}]);
  await store.appendGraphEvent("usage","graph.replan_started",{});await store.appendGraphEvent("usage","graph.replan_proposed",{durationMs:17,usage:{prompt_tokens:30,completion_tokens:4,total_tokens:34}});
  await store.recordGraphVerification({graphId:"usage",graphNodeId:"$goal",verificationType:"goal_semantic",status:"passed",evidence:{usage:{prompt_tokens:40,completion_tokens:5,total_tokens:45}},verifiedAt:3});
  const metrics=(await projectExecutionProvenance(store,"usage"))!;
  assert.deepEqual(metrics.tokenUsage,{inputTokens:100,outputTokens:14,totalTokens:114});assert.equal(metrics.graphModelCalls,5);assert.equal(metrics.replannerDurationMs,17);assert.equal(metrics.unknownTokenUsageCalls,1);
});
