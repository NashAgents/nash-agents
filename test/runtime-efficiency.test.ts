import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkerEventForwarder } from "../src/cluster/worker/event-forwarder.js";
import { WorkerGraphArtifacts } from "../src/cluster/worker/graph-artifacts.js";
import { LocalSpillStore } from "../src/context/spill/local-spill-store.js";
import { ToolResultManager } from "../src/context/tool-result-manager.js";
import { InstrumentationService } from "../src/observability/instrumentation-service.js";
import { TraceContextManager } from "../src/observability/trace-context.js";
import { summarizeRuntime } from "../src/observability/runtime-phase.js";

test("SIMULATED_INTEGRATION: coalescing 1000 previews reduces durable events while preserving exact text/order", async t => {
  const dir=await mkdtemp(join(tmpdir(),"nash-delta-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const journal=join(dir,"events.json");const forwarder=new WorkerEventForwarder("task","run","worker","coordinator",500,journal);
  for(let i=0;i<1000;i++)forwarder.queueStreamDelta("model.content_delta",{delta:"x",agentId:"a",spanId:"s"});
  forwarder.emitEvent("model.usage",{accountingId:"request",status:"completed"});
  const saved=JSON.parse(await readFile(journal,"utf8"));
  assert.equal(saved.pendingEvents.length,2);assert.equal(saved.pendingEvents[0].data.delta,"x".repeat(1000));assert.equal(saved.pendingEvents[1].eventType,"model.usage");
  const reload=new WorkerEventForwarder("task","run","worker","coordinator",500,journal);assert.equal(reload.getPendingCount(),2);reload.handleEventAck(2);assert.equal(reload.getPendingCount(),0);
});
test("MOCK_UNIT: paged upstream artifacts retain identity and access only the task-bound inputs", async () => {
  const content="head"+"x".repeat(20000)+"CRITICAL TAIL";const sha256=createHash("sha256").update(content).digest("hex");
  const artifacts=new WorkerGraphArtifacts({graphId:"graph",graphNodeId:"join",inputs:[{name:"report",content,sha256,artifactId:"artifact",producerNodeId:"producer"}],outputs:[]});
  const read=artifacts.tools().find(t=>t.name==="read_graph_artifact")!;
  const first:any=await read.execute({name:"report"});assert.equal(first.content.length,8000);assert.equal(first.truncated,true);assert.equal(first.sha256,sha256);
  const tail:any=await read.execute({name:"report",offset:20000,limit:100});assert.match(tail.content,/CRITICAL TAIL/);
  // 未绑定到本任务的产物必须返回结构化失败，且绝不带出任何内容。
  const foreign:any=await read.execute({name:"foreign"});
  assert.equal(foreign.success,false);assert.equal(foreign.code,"ARTIFACT_NOT_FOUND");assert.equal(foreign.content,undefined);
  await assert.rejects(async()=>read.execute({name:"report",offset:-1}));
});
test("SIMULATED_INTEGRATION: large output keeps diagnostic/tail hints and complete re-readable original evidence", async t => {
  const dir=await mkdtemp(join(tmpdir(),"nash-context-efficiency-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new LocalSpillStore({spillDir:dir});const manager=new ToolResultManager({spillStore:store,sessionId:"test"});
  const output="header\n"+"context\n".repeat(5000)+"\nERROR: unique final failure";
  const result=await manager.process("fixture","call",{success:false,output});assert.equal(result.offloaded,true);assert.match(result.content,/unique final failure/);assert.match(result.content,/SHA-256/);assert.ok(result.content.length<output.length/5);
  const full=await store.read(result.spillRef!,{limit:100000,maxChars:100000});assert.equal(full.content,output);
});
test("SIMULATED_INTEGRATION: parent/child IDs and monotonic duration survive asynchronous nesting",async()=>{
  const traceContext=new TraceContextManager();const spans:any[]=[];let tick=0;const service=new InstrumentationService({traceContext,monotonicNow:()=>tick});
  await traceContext.run({projectId:"p",sessionId:"s",traceId:"trace",runtimeSpanSink:span=>{spans.push(span);}},()=>service.runSpan("parent",{phase:"task_dispatch"},async()=>{tick=5;await service.runSpan("child",{phase:"tool"},async()=>{tick=15;});tick=20;}));
  const terminals=spans.filter(s=>s.endTime!==undefined);const parent=terminals.find(s=>s.name==="parent");const child=terminals.find(s=>s.name==="child");assert.equal(child.parentSpanId,parent.spanId);assert.equal(parent.durationMs,20);assert.equal(child.durationMs,10);
  assert.equal(summarizeRuntime(spans,[]).completeness,"PARTIAL");
});
