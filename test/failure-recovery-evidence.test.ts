import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SequencedEvent } from "../src/cluster/protocol/types.js";
import { classifyRecoveredFailures } from "../src/cluster/graph/failure-recovery.js";
import { snapshotWorkspace, isRepeatableTestCommand } from "../src/cluster/worker/verification-snapshot.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshot = (files: Record<string,string>) => ({ complete: true, files, digest: hash(JSON.stringify(Object.entries(files).sort())), bytes: 10 });
function fixture(testFile = "sample.test.mjs") {
  const before = snapshot({ [testFile]: hash("assertions"), "package.json": hash("scripts") });
  const after = snapshot({ ...before.files, "runtime-config.json": hash("fixed") });
  const events: SequencedEvent[] = [];
  const event = (eventType: string, data: Record<string,unknown>) => { const e = { seq: events.length+1, taskId: "task", runId: "run", nodeId: "worker", timestamp: 100, eventType, data }; events.push(e); return e; };
  const command = `node --test-isolation=none --test ${testFile}`;
  const execution = (id: string, code: number, version: typeof before) => {
    event("tool.started", { toolCallId: id, rawArgs: JSON.stringify({ command }) });
    event(code ? "job.failed" : "job.completed", { toolCallId: id, command, exitCode: code });
    const result = event("tool.result", { source: "ToolExecutor", toolCallId: id, success: code === 0, exitCode: code });
    event("verification.test_execution", { source: "WorkerTaskRunner", toolCallId: id, command, exitCode: code, success: code === 0, before: version, after: version });
    return result;
  };
  const failure = execution("failed",1,before);
  event("file.modified", { relativePath: "runtime-config.json", beforeSha256: null, afterSha256: after.files["runtime-config.json"] });
  execution("retest",0,after);
  event("verification.workspace_final", { source: "WorkerTaskRunner", snapshot: after });
  event("task.completed", {});
  return { events, failure, before, after };
}

test("SIMULATED_INTEGRATION: exact retest after observed repair discharges failure and retains historical call", () => {
  const f=fixture(); const result=classifyRecoveredFailures(f.events,[f.failure]);
  assert.equal(result.recovered.length,1); assert.deepEqual(result.unresolved,[]);
  assert.equal(result.recovered[0]!.failedToolCallId,"failed"); assert.equal(f.events.find(e=>e.data.toolCallId==="failed"&&e.eventType==="tool.result")!.data.success,false);
});
for (const mutation of ["missing_repair","changed_test","stale_final","missing_job","different_command","foreign_run","cancelled","mutating_test","incomplete_snapshot"] as const) test(`MOCK_UNIT: recovery rejects ${mutation}`,()=>{
  const f=fixture(); const retest=f.events.find(e=>e.eventType==="verification.test_execution"&&e.data.toolCallId==="retest")!;
  if(mutation==="missing_repair")f.events=f.events.filter(e=>e.eventType!=="file.modified");
  if(mutation==="changed_test"){const changed=snapshot({...f.after.files,"sample.test.mjs":hash("assertions deleted")});retest.data.before=changed;retest.data.after=changed;f.events.find(e=>e.eventType==="verification.workspace_final")!.data.snapshot=changed;}
  if(mutation==="stale_final")f.events.find(e=>e.eventType==="verification.workspace_final")!.data.snapshot=f.before;
  if(mutation==="missing_job")f.events=f.events.filter(e=>e.eventType!=="job.completed");
  if(mutation==="different_command")retest.data.command="node --test unrelated.test.mjs";
  if(mutation==="foreign_run")retest.runId="foreign";
  if(mutation==="cancelled")f.events.at(-1)!.eventType="task.cancelled";
  if(mutation==="mutating_test")retest.data.before=f.before;
  if(mutation==="incomplete_snapshot")retest.data.before={...f.after,complete:false};
  assert.deepEqual(classifyRecoveredFailures(f.events,[f.failure]).unresolved,["failed"]);
});
test("MOCK_UNIT: an unrelated failure cannot be discharged by a successful test",()=>{
  const f=fixture();const other={...f.failure,data:{...f.failure.data,toolCallId:"unrelated"}};
  assert.deepEqual(classifyRecoveredFailures(f.events,[f.failure,other]).unresolved,["unrelated"]);
});
test("SIMULATED_INTEGRATION: snapshot uses actual file hashes and refuses links/sensitive files",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"nash-recovery-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const access=new FileSystemAccess({workspaceRoot:root,policy:createDefaultSandboxPolicy()});
  await writeFile(path.join(root,"sample.test.mjs"),"actual assertions");
  const first=await snapshotWorkspace(access);assert.equal(first.complete,true);assert.equal(first.files["sample.test.mjs"],hash("actual assertions"));
  await writeFile(path.join(root,".env"),"DO_NOT_COLLECT");const privateSnapshot=await snapshotWorkspace(access);assert.equal(privateSnapshot.complete,false);assert.ok(!JSON.stringify(privateSnapshot).includes("DO_NOT_COLLECT"));await rm(path.join(root,".env"));
  await symlink(path.join(root,"sample.test.mjs"),path.join(root,"link"));assert.equal((await snapshotWorkspace(access)).complete,false);
});
test("MOCK_UNIT: unsupported compound commands execute normally but cannot establish deterministic recovery",()=>{
  assert.equal(isRepeatableTestCommand("node --test-isolation=none --test sample.test.mjs"),true);
  assert.equal(isRepeatableTestCommand("npm test"),true);
  for(const cmd of ["npm test || true","echo ok","node --test sample.test.mjs; rm x","npm test > fake.log"])assert.equal(isRepeatableTestCommand(cmd),false);
});


test("SIMULATED_INTEGRATION: a text-only successful process result requires the actual bound Job exit code",()=>{
  const f=fixture();const result=f.events.find(e=>e.eventType==="tool.result"&&e.data.toolCallId==="retest")!;
  delete result.data.exitCode;
  assert.equal(classifyRecoveredFailures(f.events,[f.failure]).recovered.length,1);
  const job=f.events.find(e=>e.eventType==="job.completed")!;delete job.data.exitCode;
  assert.deepEqual(classifyRecoveredFailures(f.events,[f.failure]).unresolved,["failed"]);
});


test("SIMULATED_INTEGRATION: recovery snapshots reuse security eligibility and refuse cloud credentials and databases",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"nash-snapshot-sensitive-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const access=new FileSystemAccess({workspaceRoot:root,policy:createDefaultSandboxPolicy()});
  await mkdir(path.join(root,".aws"));await writeFile(path.join(root,".aws","credentials"),"PRIVATE CLOUD CREDENTIAL");
  let sensitiveReads=0;const resolve=access.resolveForRead.bind(access);access.resolveForRead=async(...args)=>{if(String(args[0]).includes(".aws"))sensitiveReads++;return resolve(...args);};
  const cloud=await snapshotWorkspace(access);assert.equal(cloud.complete,false);assert.equal(sensitiveReads,0);assert.equal(Object.keys(cloud.files).length,0);
  await rm(path.join(root,".aws"),{recursive:true,force:true});await writeFile(path.join(root,"data.sqlite"),"PRIVATE DATABASE");
  const database=await snapshotWorkspace(access);assert.equal(database.complete,false);assert.equal(Object.keys(database.files).length,0);
});


for(const testFile of ["SAMPLE.TEST.MJS","integration_test.py","conftest.py"]) test(`MOCK_UNIT: recovery cannot discharge changed test controls ${testFile}`,()=>{
  const f=fixture(testFile);const changed=snapshot({...f.after.files,[testFile]:hash("assertions removed")});
  const retest=f.events.find(e=>e.eventType==="verification.test_execution"&&e.data.toolCallId==="retest")!;retest.data.before=changed;retest.data.after=changed;
  f.events.find(e=>e.eventType==="verification.workspace_final")!.data.snapshot=changed;
  f.events.find(e=>e.eventType==="file.modified")!.data.afterSha256=changed.files["runtime-config.json"];
  for(const event of f.events) if(event.seq>5)event.seq++;
  f.events.splice(5,0,{...f.failure,seq:6,eventType:"file.modified",data:{relativePath:testFile,beforeSha256:f.before.files[testFile],afterSha256:changed.files[testFile]}});
  assert.deepEqual(classifyRecoveredFailures(f.events,[f.failure]).unresolved,["failed"]);
});
