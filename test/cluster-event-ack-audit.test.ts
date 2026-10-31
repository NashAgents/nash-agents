import { test,type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { WssGateway } from "../src/cluster/coordinator/wss-gateway.js";
import { createEnvelope } from "../src/cluster/protocol/message-codec.js";

async function fixture(t:TestContext) {
 const store=new InMemoryClusterStore(),invites=new InviteManager(),registry=new NodeRegistry(store,invites);
 const server=http.createServer(),gateway=new WssGateway({server,store,registry,coordinatorNodeId:"coordinator"});
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws/cluster`),messages:any[]=[];
 t.after(async()=>{ws.terminate();gateway.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 ws.on("message",raw=>messages.push(JSON.parse(String(raw))));await once(ws,"open");
 const send=(type:any,payload:any)=>ws.send(JSON.stringify(createEnvelope(type,payload,"worker","coordinator")));
 const next=async(type:string)=>{while(true){const index=messages.findIndex(message=>message.type===type);if(index>=0)return messages.splice(index,1)[0];await once(ws,"message",{signal:AbortSignal.timeout(3000)});}};
 send("node.hello",{nodeId:"worker",name:"test",platform:"linux",arch:"x64",hostname:"test",capabilities:[],projects:[],maxConcurrentRuns:1,inviteCode:invites.createInvite().inviteCode});
 await next("node.authenticated");
 await store.saveTask({taskId:"task",runId:"run",nodeId:"worker",projectId:"project",goal:"fixture",status:"running",dispatchAttempt:1,createdAt:Date.now(),updatedAt:Date.now()});
 return {store,registry,gateway,send,next};
}

test("SIMULATED_INTEGRATION: event ACK scans incrementally and never acknowledges a missing sequence",async t=>{
 const {store,send,next}=await fixture(t),queries:number[]=[];
 const original=store.getEventsForTask.bind(store);
 t.mock.method(store,"getEventsForTask",async(taskId:string,after=0,limit?:number)=>{queries.push(after);assert.ok((limit??0)<=1000);return original(taskId,after,limit);});
 const event=(seq:number)=>({seq,taskId:"task",runId:"run",nodeId:"worker",eventType:"fixture",data:{},timestamp:Date.now()});
 for(const [seqs,expected] of [[[1,3],1],[[4],1],[[2],4]] as Array<[number[],number]>) {
  send("event.batch",{taskId:"task",runId:"run",nodeId:"worker",events:seqs.map(event)});
  assert.equal((await next("event.ack")).payload.lastAckedSeq,expected);
 }
 assert.deepEqual(queries,[1,2,2]);
});

test("SIMULATED_INTEGRATION: Worker crash rejection receives result ACK on first delivery and replay",async t=>{
 const {store,send,next}=await fixture(t);
 for(let i=0;i<2;i++) {
  send("task.rejected",{taskId:"task",runId:"run",nodeId:"worker",code:"OUTCOME_UNKNOWN",reason:"crash"});
  assert.equal((await next("task.result_ack")).payload.runId,"run");
  assert.equal((await store.getTask("task"))!.status,"outcome_unknown");
 }
});

test("SIMULATED_INTEGRATION: security.audit events that are not audit records still let the batch ACK",async t=>{
 const {store,send,next}=await fixture(t),saved:any[]=[];
 t.mock.method(store,"saveSecurityAudit",async(record:any)=>{saved.push(record);});
 // Worker grant status notifications share the event type but carry no audit id; passing
 // them to the audit store throws and would block the batch from being acknowledged.
 const statusEvent={seq:1,taskId:"task",runId:"run",nodeId:"worker",eventType:"security.audit",data:{type:"TASK_SECURITY_GRANT_APPLIED",grantId:"grant",timestamp:Date.now()},timestamp:Date.now()};
 send("event.batch",{taskId:"task",runId:"run",nodeId:"worker",events:[statusEvent]});
 assert.equal((await next("event.ack")).payload.lastAckedSeq,1);
 assert.equal(saved.length,0);
 const record={id:"audit-1",timestamp:Date.now(),toolName:"bash",argsFingerprint:"fingerprint",decisionSource:"LLM_MONITOR",verdict:"ALLOW",reason:"fixture"};
 const auditEvent={seq:2,taskId:"task",runId:"run",nodeId:"worker",eventType:"security.audit",data:record,timestamp:Date.now()};
 send("event.batch",{taskId:"task",runId:"run",nodeId:"worker",events:[auditEvent]});
 assert.equal((await next("event.ack")).payload.lastAckedSeq,2);
 assert.equal(saved.length,1);
 assert.equal(saved[0].id,"audit-1");
});

test("SIMULATED_INTEGRATION: authenticated Workers cannot publish another producer or host storage path",async t=>{
 const {store,registry,gateway}=await fixture(t);
 const connection=registry.getConnection("worker")!;
 const envelope=createEnvelope("artifact.ready",{artifactId:"a",producerNodeId:"other",producerTaskId:"task",graphId:"g",storagePath:"/etc/passwd"},"worker","coordinator");
 await assert.rejects((gateway as any).handleEnvelope(envelope,connection.ws,undefined,()=>{}),/Untrusted artifact/);
 assert.equal(await store.getArtifact("a"),null);
});
