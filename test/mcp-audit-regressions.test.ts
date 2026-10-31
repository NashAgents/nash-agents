import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MCPManager } from "../src/mcp/mcp-manager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { AdaptiveToolExposure } from "../src/tools/adaptive-tool-exposure.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { runAgentLoop } from "../src/runtime/agent-loop.js";
import { resolveProjectContext } from "../src/project/project-context.js";
import { TeamRuntime } from "../src/team/team-runtime.js";
import { TaskManager } from "../src/task/task-manager.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { ConcurrencyController } from "../src/concurrency/concurrency-controller.js";

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"nash-mcp-audit-"));
  const registry = new ToolRegistry();
  const manager = new MCPManager({registry,projectRoot:dir,homeDir:dir,nashHome:path.join(dir,"home")});
  t.after(async()=>{await manager.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {dir,registry,manager};
}
async function registerTools(t: TestContext) {
  const result=await fixture(t),{manager}=result;
  manager.configManager.saveServer("fixture",{transport:"stdio",command:process.execPath,enabled:false},"user");
  const config=manager.configManager.getServer("fixture")!;
  manager.connectionManager.registerServer("fixture",config);
  const entry=(manager.connectionManager as any).connections.get("fixture");
  entry.status="connected";entry.tools=[{serverName:"fixture",name:"audit_read",description:"Read audit evidence",inputSchema:{type:"object"}}];
  manager.syncToolsToRegistry();
  return result;
}
function fakeModel(t: TestContext, responses: any[]) {
  const requests:any[]=[];
  for(const [key,value] of Object.entries({DEEPSEEK_API_KEY:"fixture-only",DEEPSEEK_BASE_URL:"http://unused.invalid",DEEPSEEK_MODEL:"fixture"})) {
    const previous=process.env[key];process.env[key]=value;
    t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  }
  t.mock.method(globalThis,"fetch",async (_url:any,init:any)=>{
    requests.push(JSON.parse(init.body));
    const delta=responses.shift()??{content:"done"};
    return new Response(`data: ${JSON.stringify({id:"fixture",choices:[{index:0,delta,finish_reason:delta.tool_calls?"tool_calls":"stop"}]})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
  });
  return requests;
}

test("SIMULATED_INTEGRATION: MCP search activation reaches the following model request",async t=>{
  const {dir,registry,manager}=await registerTools(t);
  const requests=fakeModel(t,[{tool_calls:[{index:0,id:"search",type:"function",function:{name:"search_mcp_tools",arguments:JSON.stringify({query:"audit"})}}]},{content:"done"}]);
  const projectContext=await resolveProjectContext({projectRoot:dir,nashHome:path.join(dir,"home")});
  await runAgentLoop("Inspect evidence",{registry,mcpManager:manager,projectContext,agentType:"main",securityMonitor:new PreToolSecurityMonitor({enabled:false}),printStats:false,standaloneSystemPrompt:true,maxSteps:3});
  assert.equal(requests.length,2);
  assert.ok(!requests[0].tools.some((tool:any)=>tool.function.name==="mcp__fixture__audit_read"));
  assert.ok(requests[1].tools.some((tool:any)=>tool.function.name==="mcp__fixture__audit_read"));
});

test("SIMULATED_INTEGRATION: deleting MCP configuration reloads away runtime connections and schemas",async t=>{
  const {manager,registry}=await registerTools(t);
  assert.ok(registry.has("mcp__fixture__audit_read"));
  manager.configManager.removeServer("fixture");
  await manager.reload();
  assert.equal(manager.getStatus("fixture"),undefined);assert.ok(!registry.has("mcp__fixture__audit_read"));
});

test("REAL_SANDBOX: timed-out MCP handshake closes its independent stdio process",async t=>{
  const {dir,manager}=await fixture(t);
  const sandbox=new SandboxService({policy:createDefaultSandboxPolicy(),cwd:dir});
  if(!sandbox.isAvailable()){t.skip("native sandbox is unavailable on this host");return;}
  manager.connectionManager.registerServer("hung",{transport:"stdio",command:process.execPath,args:["-e","require('node:fs').writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000)"],timeoutMs:400});
  const result=await manager.testServer("hung");assert.equal(result.success,false);
  const pid=Number(await fs.readFile(path.join(dir,"pid.txt"),"utf8"));
  t.after(()=>{try{process.kill(pid,"SIGKILL");}catch{}});
  let alive=true;
  for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(alive,false);
});

test("SIMULATED_INTEGRATION: team mail is persisted and ACKed before the next model step",async t=>{
  const {dir}=await fixture(t),team=new TeamRuntime({name:"fixture",leaderId:"main",taskManager:new TaskManager(),agentRegistry:new AgentRegistry(),concurrencyController:new ConcurrencyController()});
  t.after(()=>team.destroy());team.sendMessage("worker","main","Mailbox evidence 123");
  const requests=fakeModel(t,[{content:"done"}]);
  const projectContext=await resolveProjectContext({projectRoot:dir,nashHome:path.join(dir,"home")});
  await runAgentLoop("Inspect",{tools:[],teamRuntime:team,projectContext,agentType:"main",printStats:false,standaloneSystemPrompt:true,maxSteps:1});
  assert.ok(requests[0].messages.some((message:any)=>String(message.content).includes("Mailbox evidence 123")));
  assert.equal(team.mailbox.getUnreadCount("main"),0);assert.deepEqual(team.mailbox.peekAllMessages("main"),[]);
});
