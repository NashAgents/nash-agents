import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { ClusterDatabase } from "../src/cluster/storage/db.js";
import { PostgresClusterStore } from "../src/cluster/storage/cluster-store.js";
import { ModelRequestObservation } from "../src/observability/model-usage.js";

test("REAL_DATABASE: usage and spans survive Store recreation, replay and scoped pagination", { skip: !process.env.NASH_TEST_DATABASE_URL }, async t => {
  const connection=process.env.NASH_TEST_DATABASE_URL!;const admin=new ClusterDatabase(connection);const schema=`nash_usage_${randomUUID().replaceAll('-','')}`;let db:ClusterDatabase|undefined;let created=false;
  t.after(async()=>{try{await db?.close();if(created)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.close();}});
  assert.equal(await admin.connect(),true);await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
  const url=new URL(connection);url.searchParams.set('options',`-c search_path=${schema}`);db=new ClusterDatabase(url.toString());assert.equal(await db.connect(),true);await db.runMigrations();
  const store=new PostgresClusterStore(db);const records:any[]=[];
  const observation=new ModelRequestObservation('https://provider.example/v1',{model:'test',messages:[]},{context:{traceId:'trace',conversationId:'conversation',graphId:'graph'},usageSink:async record=>{records.push(record);await store.saveModelUsage(record);}});
  await observation.started();observation.chunk({id:'provider',usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25,cached_tokens:10}});await observation.finish('completed');
  const next=new PostgresClusterStore(db);await next.saveModelUsage(records[0]);const saved=await next.listModelUsage({traceId:'trace'});assert.equal(saved.length,1);assert.equal(saved[0]!.status,'completed');assert.equal(saved[0]!.cacheReadTokens,10);assert.equal((await next.listModelUsage({graphId:'foreign'})).length,0);
  const span:any={spanId:'span',traceId:'trace',name:'tool',startTime:1,status:'unset',attributes:{},platform:process.platform,timingSource:'process_monotonic',outcome:'running',completeness:'PARTIAL'};
  await next.saveRuntimeSpan(span);await next.saveRuntimeSpan({...span,endTime:3,durationMs:2,status:'error',outcome:'cancelled',completeness:'COMPLETE'});await next.saveRuntimeSpan(span);
  assert.equal((await next.listRuntimeSpans('trace'))[0]!.outcome,'cancelled');assert.equal(await next.purgeModelUsage(Date.now()+1),1);
  await next.saveNode({nodeId:'worker',name:'fixture',role:'worker',platform:'linux',arch:'x64',hostname:'fixture',tokenHash:'fixture',status:'online',lastSeenAt:1,metadata:{},createdAt:1,updatedAt:1});
  await next.saveTask({taskId:'task',runId:'run',nodeId:'worker',projectId:'fixture',goal:'batch replay',status:'running',dispatchAttempt:1,createdAt:1,updatedAt:1});
  const events=Array.from({length:450},(_,index)=>({taskId:'task',runId:'run',nodeId:'worker',seq:index+1,eventType:'test.evidence',data:{text:`保留原始证据 ${index}`},timestamp:1}));
  events.splice(250,0,{...events[0]!,data:{text:'conflicting duplicate must not replace original'}});
  assert.equal(await next.appendEvents(events),450);assert.equal(await next.appendEvents(events),0);
  const persisted=await next.getEventsForTask('task',0,1000);
  assert.deepEqual(persisted.map(e=>e.seq),Array.from({length:450},(_,i)=>i+1));
  assert.equal(persisted[0]!.data.text,'保留原始证据 0');assert.ok(persisted.every(e=>e.runId==='run'&&e.nodeId==='worker'));
});

test("SIMULATED_INTEGRATION: Trace API requires authentication and rejects cross-graph or invalid paging", async t => {
  const dir=await mkdtemp(join(tmpdir(),'nash-trace-api-'));const key=randomUUID();const coordinator=new ClusterCoordinator({ephemeral:true,customDir:dir,listenHost:'127.0.0.1',listenPort:0,adminApiKey:key});
  t.after(async()=>{try{await coordinator.stop();}finally{await rm(dir,{recursive:true,force:true});}});
  const address=await coordinator.start();const base=`http://127.0.0.1:${address.port}/api/cluster`;const store=coordinator.getStore();
  await store.saveGraph!({graphId:'graph',revision:1,strategyDecision:{traceId:'trace'},status:'completed',createdAt:1} as any);
  const get=(route:string,auth=true)=>fetch(base+route,{headers:auth?{Authorization:`Bearer ${key}`}:{}});
  assert.equal((await get('/graphs/graph/trace',false)).status,401);assert.equal((await get('/graphs/foreign/trace')).status,404);assert.equal((await get('/graphs/graph/trace?limit=1001')).status,400);
  const response=await get('/graphs/graph/usage?limit=1');assert.equal(response.status,200);const body:any=await response.json();assert.deepEqual(body.items,[]);assert.equal(body.traceId,'trace');assert.equal(body.completeness,'PARTIAL');
});
