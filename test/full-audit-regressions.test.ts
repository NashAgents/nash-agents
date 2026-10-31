import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { FileLockManager, resolveCanonicalPhysicalPath } from "../src/filesystem/file-lock-manager.js";
import { checkScopeOverlap, isPathInScope } from "../src/filesystem/write-scope.js";
import { readTextPage } from "../src/filesystem/text-page.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { CompactionEngine } from "../src/context/compaction-engine.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { LocalSpillStore } from "../src/context/spill/local-spill-store.js";
import { accumulateChatCompletionStream, type ToolCall } from "../src/model/chat-completions-client.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { createLocalClusterStore } from "../src/cluster/storage/local-cluster-store.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";
import { CoordinatorMainAgent } from "../src/cluster/coordinator/main-agent/coordinator-main-agent.js";
import { RoutingFeedbackController } from "../src/cluster/router/routing-feedback-controller.js";
import { ExecutionJournal } from "../src/cluster/worker/execution-journal.js";
import { WorkerRuntime } from "../src/cluster/worker/worker-runtime.js";
import { TeamRuntime } from "../src/team/team-runtime.js";
import { AgentRegistry, SubAgentRuntime } from "../src/agent/index.js";
import { ConcurrencyController } from "../src/concurrency/concurrency-controller.js";
import { TaskManager } from "../src/task/task-manager.js";
import { PlanMode } from "../src/plan/plan-mode.js";
import { DecisionController } from "../src/decision/decision-controller.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import { CliApprovalProvider } from "../src/approval/cli-approval.js";
import { InputManager } from "../src/cli/input-manager.js";
import { WorktreeManager } from "../src/worktree/worktree-manager.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { MacOsSeatbeltBackend } from "../src/sandbox/backends/macos-seatbelt.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { ProcessJob } from "../src/jobs/process-job.js";
import { EventBus } from "../src/observability/event-bus.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { AdaptiveToolExposure } from "../src/tools/adaptive-tool-exposure.js";
import { computeNextCronTime } from "../src/cluster/scheduled/cron-parser.js";

async function directory(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-full-audit-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const policy = () => createDefaultSandboxPolicy();
const toolCall = (id: string): ToolCall => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } });

// MOCK_UNIT / SIMULATED_INTEGRATION only; these do not claim remote Worker execution.
test("SIMULATED_INTEGRATION: dangling symlinks, aliased scopes and approved path retargets fail closed", { skip: process.platform === "win32" }, async t => {
  const dir = await directory(t), workspace = path.join(dir, "workspace"), outside = path.join(dir, "outside");
  await fs.mkdir(workspace); await fs.mkdir(outside);
  const link = path.join(workspace, "escape");
  await fs.symlink(path.join(outside, "new-file"), link);
  assert.equal(resolveCanonicalPhysicalPath(link), path.join(resolveCanonicalPhysicalPath(outside), "new-file"));
  const access = new FileSystemAccess({ workspaceRoot: workspace, policy: policy() });
  await assert.rejects(access.executeAtomicWrite("escape", file => fs.writeFile(file, "bad")), /安全|denied/);
  await fs.mkdir(path.join(workspace, "allowed")); await fs.mkdir(path.join(workspace, "other"));
  await fs.symlink(path.join(workspace, "other"), path.join(workspace, "allowed", "alias"));
  const scoped = new FileSystemAccess({ workspaceRoot: workspace, policy: policy(), writeScopes: ["allowed/**"] });
  await assert.rejects(scoped.resolveForWrite("allowed/alias/new"), /writeScopes/);
  const approval = new ApprovalService({ askApproval: async () => "allow-once" });
  class RetargetLock extends FileLockManager {
    override async withLock<T>(_file: string, action: () => Promise<T>): Promise<T> {
      await fs.unlink(link); await fs.symlink(path.join(outside, "different"), link); return action();
    }
  }
  const approved = new FileSystemAccess({ workspaceRoot: workspace, policy: policy(), approvalService: approval, lockManager: new RetargetLock() });
  await assert.rejects(approved.executeAtomicWrite("escape", file => fs.writeFile(file, "bad")), /TOCTOU/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(access.resolveForRead("/private/etc/sudoers"), /敏感/);
});

test("MOCK_UNIT: recursive globs match nested and root files, escape metacharacters and lock intersections", () => {
  for (const file of ["src/main.ts", "src/a/b/c.ts"]) assert.ok(isPathInScope(file, "src/**/*.ts"));
  assert.ok(!isPathInScope("src/axb.ts", "src/a+b.ts"));
  for (const [a,b] of [[".", "src/auth/**"], ["src/**/*.ts", "src/auth/a.ts"], ["src/a*.ts", "src/*b.ts"]]) assert.ok(checkScopeOverlap([a!], [b!]).conflict);
  assert.ok(!checkScopeOverlap(["src/auth/**"], ["docs/**"]).conflict);
});

test("SIMULATED_INTEGRATION: file pagination uses actual line/character cursors without gaps", async t => {
  const dir = await directory(t), file = path.join(dir, "long.txt");
  const content = "x".repeat(120000) + "\r\n尾行\r\n";
  await fs.writeFile(file, content);
  let offset = 1, charOffset = 0, text = "";
  for (let pages = 0; pages < 100; pages++) {
    const page = await readTextPage(file, offset, 200, 4096, charOffset);
    text += page.lines.map(line => line.replace(/^\d+: /, "")).join("");
    if (page.nextOffset > page.totalLines) break;
    assert.ok(page.nextOffset > offset || page.nextCharOffset > charOffset);
    offset = page.nextOffset; charOffset = page.nextCharOffset;
  }
  assert.equal(text, "x".repeat(120000) + "尾行");
  const access = new FileSystemAccess({ workspaceRoot: dir, policy: policy() });
  const output = await createReadFileTool(access).execute({ path: "long.txt" });
  assert.match(String(output), /Lines 1-1 of 2/);
  assert.match(String(output), /offset=1, charOffset=\d+/);
  await fs.writeFile(file, "abc\r\ndef\r\n");
  const exact = await readTextPage(file, 1, 2, 13);
  assert.deepEqual(exact.lines, ["1: abc", "2: def"]);
  assert.equal(exact.truncated, false);
});

test("MOCK_UNIT: compaction never leaves orphan tool responses, including a single large tool group", async () => {
  const engine = new CompactionEngine({ keepRecentMessages: 30, llmInvoker: async () => "summary" });
  const calls = [toolCall("a"), toolCall("b"), toolCall("c")];
  const result = await engine.compact([{ role: "assistant", tool_calls: calls }, ...calls.map(call => ({ role: "tool" as const, tool_call_id: call.id, content: "large" }))]);
  assert.ok(!result.compactedMessages.some(message => message.role === "tool"));
});

test("MOCK_UNIT: colliding gateway indexes and standard interleaved tool indexes remain separate", async () => {
  for (const collision of [true, false]) {
    const chunks = [
      { index: 0, id: "a", function: { name: "read_file", arguments: '{"path":' } },
      { index: collision ? 0 : 1, id: "b", function: { name: "write_file", arguments: '{"path":' } },
      { index: collision ? 0 : 1, function: { arguments: '"b"}' } },
      ...(collision ? [] : [{ index: 0, function: { arguments: '"a"}' } }]),
    ];
    if (collision) chunks.splice(1, 0, { index: 0, function: { arguments: '"a"}' } });
    const result = await accumulateChatCompletionStream(chunks.map(call => ({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })) as any);
    const calls = result.response.choices[0]!.message.tool_calls!;
    assert.deepEqual(calls.map(call => JSON.parse(call.function.arguments)), [{ path: "a" }, { path: "b" }]);
    assert.deepEqual(calls.map(call => call.function.name), ["read_file", "write_file"]);
  }
});

test("MOCK_UNIT: session domain events cannot duplicate real tool results", () => {
  const records: any[] = [{ type: "assistant", toolCalls: [toolCall("a"), toolCall("b")] }, { type: "domain_event", data: {} }, { type: "tool_result", toolCallId: "a", content: "real" }, { type: "domain_event", data: {} }, { type: "tool_result", toolCallId: "b", content: "real-b" }];
  const messages = LocalSessionStore.recordsToChatMessages(records);
  assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.content), ["real", "real-b"]);
});

test("SIMULATED_INTEGRATION: oversized spill lines continue by characters and reproduce all bytes", async t => {
  const store = new LocalSpillStore({ baseDir: await directory(t) });
  const content = "x".repeat(50000) + "\nend";
  const ref = await store.save(content, { sessionId: "fixture" });
  let page = await store.read(ref, { offset: 1, maxChars: 1000 }), result = page.content;
  assert.equal(page.nextLineOffset, undefined);
  for (let i=0; page.hasMore && i<100; i++) {
    const next = await store.read(ref, { charOffset: page.nextCharOffset, maxChars: 1000 });
    assert.ok(next.endChar > page.endChar); result += next.content; page = next;
  }
  assert.equal(result, content);
});

test("SIMULATED_INTEGRATION: local graph CAS, atomic patches and audit events survive reopening", async t => {
  const filename = path.join(await directory(t), "store.bin");
  let store = createLocalClusterStore(filename);
  const graph = await new DistributedGraphOrchestrator({ store, scheduler: {} as any }).createGraph({ parentGoal: "fixture", reasoning: "fixture", requiresMultiAgent: false, nodes: [{ nodeId: "A", title: "A", goal: "A", dependencies: [] }] });
  assert.equal(await store.transitionGraphStatus!(graph.graphId, graph.revision, "ready", "running"), true);
  store = createLocalClusterStore(filename);
  assert.equal((await store.getGraph!(graph.graphId))!.status, "running");
  const patch: any = { graphId: graph.graphId, expectedRevision: graph.revision, nextRevision: graph.revision + 1, operationId: "fixture", reason: "test", updateNodes: [] };
  assert.equal((await store.applyGraphPatchAtomic!(patch)).success, true);
  store = createLocalClusterStore(filename);
  assert.equal((await store.getGraph!(graph.graphId))!.revision, graph.revision + 1);
  assert.ok((await store.listGraphEvents!(graph.graphId)).some(event => event.eventType === "graph.replanned"));
  await store.updateGraphStatus!(graph.graphId, "completed");
  assert.equal((await store.applyGraphPatchAtomic!({ ...patch, operationId: "next", expectedRevision: graph.revision+1, nextRevision: graph.revision+2 })).success, false);
});

test("SIMULATED_INTEGRATION: artifact HTTP access requires trusted identity, never spoofed node headers", async t => {
  const store = new InMemoryClusterStore(), artifacts = new ArtifactService(store, await directory(t));
  await assert.rejects(artifacts.publishArtifact({ graphId: "../escape", name: "x", producerTaskId: "t", producerNodeId: "w", content: "secret" }), /graph ID/);
  const artifact = await artifacts.publishArtifact({ graphId: "g", name: "x", producerTaskId: "t", producerNodeId: "w", content: "secret" });
  const handler = new ClusterApiHandler({ store, artifactService: artifacts, registry: {} as any, scheduler: {} as any, inviteManager: {} as any, coordinatorNodeId: "c", adminApiKey: "fixture-key" });
  const server = http.createServer((req,res) => { void handler.handleRequest(req,res); });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await store.saveWebSession({ sessionId:"viewer",userId:"v",username:"viewer",role:"viewer",csrfToken:"csrf",createdAt:Date.now(),expiresAt:Date.now()+10000 });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/cluster/artifacts/${artifact.artifactId}`;
  for (const suffix of ["content", "download"]) {
    const response = await fetch(`${base}/${suffix}`, { headers: { cookie:"nash_session=viewer", "x-nash-node-id":"w" } });
    assert.equal(response.status,403);
  }
  assert.equal((await fetch(`${base}/content`,{headers:{authorization:"Bearer fixture-key"}})).status,200);
});

test("MOCK_UNIT: a Coordinator timeout has explicit timeout state and user cancellation remains distinct", async () => {
  const makeAgent = () => new CoordinatorMainAgent({ store: new InMemoryClusterStore(), registry:{listOnlineConnections:()=>[]} as any, searchService:{} as any, discoveryService:{} as any,
    timeoutMs:10, modelConfigOverride:{baseUrl:"http://unused.invalid",apiKey:"fixture",model:"fixture"},
    agentLoop: async (_input, options) => new Promise((_resolve,reject) => options!.abortSignal!.addEventListener("abort",() => reject(options!.abortSignal!.reason),{once:true})) });
  assert.equal((await makeAgent().chat("timeout","fixture")).state,"timeout");
  const controller = new AbortController(); const result = makeAgent().chat("cancel","fixture",{abortSignal:controller.signal});
  setTimeout(() => controller.abort(),1); assert.equal((await result).state,"cancelled");
});

test("SIMULATED_INTEGRATION: unknown graph outcomes settle waiters and retain downstream safety", async () => {
  const store=new InMemoryClusterStore(), bus=new EventBus(), events:string[]=[];
  bus.subscribe("*",event => { events.push(event.type); });
  const orchestrator=new DistributedGraphOrchestrator({store,scheduler:{} as any,eventBus:bus});
  const graph=await orchestrator.createGraph({parentGoal:"fixture",reasoning:"test",requiresMultiAgent:true,nodes:[{nodeId:"A",title:"A",goal:"A",dependencies:[]},{nodeId:"B",title:"B",goal:"B",dependencies:["A"]}]});
  await store.updateGraphStatus(graph.graphId,"running");
  await store.updateGraphNodeStatus(graph.graphId,"A","outcome_unknown");
  const wait=orchestrator.waitForCompletion(graph.graphId,1000);
  await orchestrator.advanceGraph(graph.graphId);
  assert.equal((await wait).status,"outcome_unknown");
  assert.ok(events.includes("graph.outcome_unknown"));
});

test("SIMULATED_INTEGRATION: crash recovery persists unknown terminal before ACK, stopping replay", async t => {
  const journal=new ExecutionJournal(await directory(t)); journal.claim("task","run");
  const sent:any[]=[];
  const runtime:any={client:{getWebSocket:()=>({readyState:1,send:(message:string)=>sent.push(JSON.parse(message))}),coordinatorId:"c"},journal,nodeId:"w",activeRunners:new Map(),detachedForwarders:new Map()};
  (WorkerRuntime.prototype as any).replayPending.call(runtime);
  assert.equal(journal.get("task")!.terminal!.type,"task.rejected"); journal.confirm("task","run");
  (WorkerRuntime.prototype as any).replayPending.call(runtime);
  assert.equal(sent.length,1);
});

test("MOCK_UNIT: real Worker event names and fields prevent unsafe rerouting", async () => {
  const controller=new RoutingFeedbackController(new InMemoryClusterStore(),{} as any);
  const result=await controller.evaluateIntervention({taskId:"t"} as any,"NODE_OFFLINE","disconnected",{workerEvents:[{eventType:"tool.started",data:{toolName:"bash"}}]});
  assert.equal(result.outcomeUnknown,true); assert.equal(result.shouldReplan,false);
});

test("SIMULATED_INTEGRATION: conversation snapshots preserve concurrent appends, renames and targeted deletion", async () => {
  const store=new InMemoryClusterStore();
  await store.saveConversation({id:"c",title:"old",titleRevision:0,messages:[],createdAt:1,updatedAt:1});
  const rename=(await store.getConversation("c"))!, append=(await store.getConversation("c"))!;
  rename.title="new";rename.titleRevision=1;rename.titleSource="ai_generated";
  append.messages.push({id:"m",conversationId:"c",sender:"user",content:"hello",messageType:"text",timestamp:2});
  await Promise.all([store.saveConversation(rename),store.saveConversation(append)]);
  assert.equal((await store.getConversation("c"))!.title,"new"); assert.equal((await store.getConversation("c"))!.messages.length,1);
  const deletion=(await store.getConversation("c"))!; deletion.messages=[];
  await store.appendConversationMessage("c",{id:"n",conversationId:"c",sender:"assistant",content:"newer",messageType:"text",timestamp:3});
  await store.saveConversation(deletion);
  assert.deepEqual((await store.getConversation("c"))!.messages.map(message=>message.id),["n"]);
});

test("SIMULATED_INTEGRATION: fresh recipients receive broadcasts and unowned Main waits never acquire slots", async () => {
  const registry=new AgentRegistry(),concurrency=new ConcurrencyController(),team=new TeamRuntime({name:"test",leaderId:"main",taskManager:new TaskManager(),agentRegistry:registry,concurrencyController:concurrency});
  team.addMember({agentId:"worker",name:"Worker",role:"worker",roleDescription:"test"});
  team.sendMessage("main","*","hello"); assert.equal(team.claimMessagesForStep("worker")[0]!.content,"hello");
  await team.waitForChange("main",{timeoutMs:1});assert.equal(concurrency.getRunningCount(),0);
  const release=await concurrency.acquireSlot(undefined,"worker");
  const wait=team.waitForChange("worker",{timeoutMs:1000}); assert.equal(concurrency.getRunningCount(),0);
  team.sendMessage("main","worker","wake"); await wait; assert.equal(concurrency.getRunningCount(),1);
  release();assert.equal(concurrency.getRunningCount(),0);team.destroy();
});

test("MOCK_UNIT: SubAgent task metadata and physical workspace mode reach ownership checks", async t => {
  const tasks=new TaskManager(); tasks.createTask({id:"task",subject:"test"});
  let workspaceMode:string|undefined;
  t.mock.method(tasks,"claimTask",(_id: string,_agent: string,_rev: number | undefined,options: any) => { workspaceMode=options?.workspaceMode;throw new Error("stop before model"); });
  const runtime=new SubAgentRuntime({taskManager:tasks,agentRegistry:new AgentRegistry(),concurrencyController:new ConcurrencyController()});
  await runtime.spawn("test",{agentId:"agent",taskId:"task",worktreePath:"/isolated/fixture"});
  assert.equal(tasks.getTask("task")!.metadata?.delegatedTo,"agent");assert.equal(workspaceMode,"worktree");
});

test("MOCK_UNIT: repeated plans have unique task IDs and repeated entry restores the writable policy", () => {
  const fsAccess=new FileSystemAccess({policy:policy()}),tasks=new TaskManager(),mode=new PlanMode({fsAccess,taskManager:tasks});
  for (let i=0;i<2;i++) { mode.enter("test"); mode.enter("test again");mode.proposePlan({summary:"test",steps:[{subject:"step"}]});mode.resolveApproval(true);mode.exit(); }
  assert.equal(new Set(tasks.getTasks().map(task=>task.id)).size,2);
  assert.equal(fsAccess.getPolicy().filesystem.mode,"workspace-write");
});

test("SIMULATED_INTEGRATION: long and split bracketed pastes preserve text and release keyboard mode", async t => {
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const manager=new InputManager({input,output,isTTY:true});t.after(()=>manager.close());
  const text="很长的代码".repeat(200);
  const result=manager.readUserMessage();input.write("\x1b[200~");input.write(text+"\x1b[20");input.write("1~\r");
  assert.equal(await result,text);
  for (let cut=1;cut<=5;cut++) {
    const fragmented=manager.readUserMessage();
    input.write("\x1b[200~"+text+"\x1b[201~".slice(0,cut));
    input.write("\x1b[201~".slice(cut)+"\r");
    assert.equal(await fragmented,text);
  }
  const next=manager.readUserMessage();input.write("ok\r");assert.equal(await next,"ok");
});

test("SIMULATED_INTEGRATION: aborted approval closes only its matching decision and advances FIFO", async t => {
  const input=new PassThrough(),output=new PassThrough();output.resume();const manager=new InputManager({input,output,isTTY:true});t.after(()=>manager.close());
  const decision=new DecisionController(),approval=new ApprovalService({provider:new CliApprovalProvider({inputManager:manager,decisionController:decision}),isTTY:true});
  const abort=new AbortController();const first=approval.requestApproval({id:"first",capability:"network",reason:"fixture"},{signal:abort.signal});
  const second=approval.requestApproval({id:"second",capability:"network",reason:"fixture"});
  abort.abort();await first;assert.equal(decision.getActiveDecision()?.id,"second");decision.cancelActive();await second;assert.equal(decision.getPendingCount(),0);
});

test("SIMULATED_INTEGRATION: unrelated memories coexist and Tier 2 survives many preference entries", async t => {
  const memory=new MemoryService({nashHome:await directory(t)});
  await memory.remember({content:"Use the audit tool for security reviews.",kind:"fact"});
  await memory.remember({content:"Use the rendering tool for diagrams.",kind:"fact"});
  for(let i=0;i<12;i++) await memory.remember({content:`User preference ${i}: color ${String.fromCharCode(65+i)}`,kind:"preference"});
  await memory.remember({content:"Zebraprotocol uses a durable disk journal.",kind:"architecture"});
  const context=await memory.getProgressiveMemoryContext("Zebraprotocol");assert.match(context.prompt,/Tier 2 Retrieval/);assert.match(context.prompt,/durable disk journal/);
  const entries=await memory.getAll();assert.equal(entries.filter(entry=>!entry.deprecated&&entry.content.includes("tool")).length,2);
});

test("MOCK_UNIT: main, lead, subagent and member expose the correct registered lifecycle tools", () => {
  const registry=new ToolRegistry();
  for(const name of ["create_task","spawn_agent","wait_agent","read_tool_result","job_list","job_output","job_kill","claim_task","wait_for_change"]) registry.register({name,description:"test",parameters:{type:"object"},execute:()=>"ok"});
  for(const role of ["main","lead"]) { const exposure=new AdaptiveToolExposure(registry,{role});for(const name of ["create_task","spawn_agent","wait_agent","read_tool_result"]) assert.ok(exposure.isExposed(name));exposure.autoActivateForContext("job");assert.ok(exposure.isExposed("job_list")); }
  assert.ok(new AdaptiveToolExposure(registry,{role:"subagent"}).isExposed("wait_agent"));
  const member=new AdaptiveToolExposure(registry,{role:"member"});assert.ok(member.isExposed("wait_for_change"));assert.ok(!member.isExposed("create_task"));
});

test("MOCK_UNIT: cron step days are restricted and DST fixed wall schedules fire once", () => {
  assert.equal(new Date(computeNextCronTime("0 0 */2 * 1",Date.parse("2026-10-25T00:01Z"),"UTC")).toISOString(),"2026-10-26T00:00:00.000Z");
  assert.equal(new Date(computeNextCronTime("30 1 * * *",Date.parse("2026-11-01T05:30Z"),"America/New_York")).toISOString(),"2026-11-02T06:30:00.000Z");
});

test("SIMULATED_INTEGRATION: Worktree filenames preserve spaces and failed commits preserve recoverable work", async t => {
  const dir=await directory(t);const git=(...args:string[])=>execFileSync("git",args,{cwd:dir,encoding:"utf8"});
  git("init","-q");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");
  await fs.writeFile(path.join(dir,"source.txt"),"original");git("add",".");git("commit","-qm","fixture");
  const worktrees=new WorktreeManager({projectRoot:dir});await fs.writeFile(path.join(dir,"source.txt"),"changed");await fs.writeFile(path.join(dir," leading space.txt"),"new");
  assert.deepEqual((await worktrees.getDirtyFiles()).sort(),[" leading space.txt","source.txt"]);
  git("checkout","--","source.txt");await fs.rm(path.join(dir," leading space.txt"));
  const worktree=await worktrees.createWorktree("worker");await fs.writeFile(path.join(worktree.worktreePath,"source.txt"),"uncommitted");
  git("config","core.hooksPath",path.join(dir,"hooks"));await fs.mkdir(path.join(dir,"hooks"));await fs.writeFile(path.join(dir,"hooks","pre-commit"),"#!/bin/sh\nexit 1\n",{mode:0o755});
  await assert.rejects(worktrees.mergeWorktree("worker"),/WORKTREE_COMMIT_FAILED/);
  await assert.rejects(worktrees.cleanupWorktree("worker",{force:true}),/WORKTREE_PRESERVED/);
  assert.equal(await fs.readFile(path.join(worktree.worktreePath,"source.txt"),"utf8"),"uncommitted");
});

test("SIMULATED_INTEGRATION: ProcessJob honors backend cwd/env and releases execution resources once", async t => {
  const dir=await directory(t);let cleaned=0;
  const sandboxService=new SandboxService({policy:policy(),backend:{name:"fixture",isAvailable:()=>true,run:async()=>({stdout:"",stderr:"",exitCode:0,killed:false}),buildExecutionSpec:()=>({executable:process.execPath,args:["-e","console.log(require('fs').realpathSync.native(process.cwd()));console.log(process.env.AUDIT_SENTINEL)"],cwd:dir,env:{AUDIT_SENTINEL:"from-spec",SystemRoot:process.env.SystemRoot??""},cleanup:()=>{cleaned++;}})}});
  const job=new ProcessJob({cwd:process.cwd(),command:"unused",ownerAgentId:"main",sessionId:"s",projectId:"p",sandboxService});
  job.start();await job.waitFor(5000);
  assert.equal(job.getRecord().status,"completed");assert.match(job.getRecord().resultSummary!,/from-spec/);assert.ok(job.getRecord().resultSummary!.includes(resolveCanonicalPhysicalPath(dir)));assert.equal(cleaned,1);
});

test("MOCK_UNIT: Seatbelt rejects escaped scopes and permits the recursive directory rather than a literal glob", async t => {
  const dir=await directory(t);await fs.mkdir(path.join(dir,"src"));
  const backend=new MacOsSeatbeltBackend();
  assert.throws(()=>backend.generateProfile({command:"unused",cwd:dir,policy:policy(),scopedWritePaths:["../escape/**"]}),/escapes/);
  const profile=backend.generateProfile({command:"unused",cwd:dir,policy:policy(),scopedWritePaths:["src/**"]});
  const targetDir=resolveCanonicalPhysicalPath(path.join(dir,"src"));
  const expectedSubpath=process.platform==="win32"?targetDir.replace(/\\/g,"\\\\"):targetDir;
  assert.ok(profile.includes(`(subpath "${expectedSubpath}")`));assert.ok(!profile.includes("src/**"));
});
