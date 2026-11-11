import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Uses an isolated pseudo-terminal and a fake model, but exercises the real CLI entry and loop.
for (const scenario of ["draft", "switch"] as const) test(`TTY CLI handles an idle completion with ${scenario}`, {timeout: 30000}, async t => {
  if (process.platform === "win32") { t.skip("requires a POSIX pseudo-terminal"); return; }
  if (spawnSync("python3", ["--version"]).error) { t.skip("requires python3 for the pseudo-terminal"); return; }
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-local-team-pty-"));
  const home = path.join(dir, "home"), project = path.join(dir, "project");
  fs.mkdirSync(home); fs.mkdirSync(project);
  const log = path.join(dir, "requests.jsonl"), gate = path.join(dir, "release");
  const preload = path.join(dir, "fixture.mjs");
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import { PreToolSecurityMonitor } from ${JSON.stringify(pathToFileURL(path.join(root, "src/security/security-monitor.ts")).href)};
PreToolSecurityMonitor.prototype.evaluateParallelToolCalls = async contexts => contexts.map(c => ({verdict:'ALLOW',fingerprint:c.argsFingerprint,toolName:c.toolName,severity:0,category:'test',reason:'fixture',durationMs:0}));
let mainRequests = 0;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init.body));
  fs.appendFileSync(process.env.PTY_LOG, JSON.stringify(body) + '\\n');
  const messages = body.messages || [];
  const isChild = messages.some(m => m.role === 'user' && m.content === 'PTY_CHILD_TASK');
  let delta;
  if (isChild) {
    while (!fs.existsSync(process.env.PTY_GATE)) {
      if (init.signal?.aborted) throw init.signal.reason;
      await new Promise(r => setTimeout(r, 10));
    }
    delta = {role:'assistant',content:'PTY_CHILD_COMPLETE'};
  } else if (++mainRequests === 1) {
    delta = {role:'assistant',tool_calls:[{index:0,id:'call-pty',type:'function',function:{name:'spawn_agent',arguments:JSON.stringify({prompt:'PTY_CHILD_TASK',background:true,name:'pty-worker'})}}]};
  } else {
    delta = {role:'assistant',content:'PTY_MAIN_DONE'};
  }
  const payload = {choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]};
  return new Response('data: '+JSON.stringify(payload)+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
};
`);
  const py = `import os,pty,select,sys,signal\npid,fd=pty.fork()\nif pid==0: os.execv(sys.argv[1],sys.argv[1:])\ndef stop(*args): raise KeyboardInterrupt()\nsignal.signal(signal.SIGTERM,stop)\ntry:\n while True:\n  ready,_,_=select.select([0,fd],[],[],1)\n  if 0 in ready:\n   data=os.read(0,65536)\n   if not data: break\n   os.write(fd,data)\n  if fd in ready:\n   try: data=os.read(fd,65536)\n   except OSError: break\n   if not data: break\n   os.write(1,data)\nexcept KeyboardInterrupt: pass\nfinally:\n try: os.kill(pid,signal.SIGKILL)\n except ProcessLookupError: pass\n try: os.waitpid(pid,0)\n except ChildProcessError: pass\n`;
  const child = spawn("python3", ["-c", py, process.execPath, "--import", import.meta.resolve("tsx"), "--import", pathToFileURL(preload).href, path.join(root, "src/index.ts")], {
    cwd: project,
    env: {...process.env, HOME: home, NASH_HOME: path.join(home, "nash"), NASH_INIT_ACCESS_MODE: "restricted", DEEPSEEK_API_KEY: "fixture", DEEPSEEK_BASE_URL: "http://fixture.invalid/v1", DEEPSEEK_API_FORMAT: "completions", PTY_LOG: log, PTY_GATE: gate},
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-50000); });
  child.stderr.on("data", chunk => { output = (output + chunk.toString()).slice(-50000); });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill("SIGTERM"), 1000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const readRequests = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const until = async (predicate: () => boolean, label: string) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error(`CLI exited before ${label}: ${output.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`timeout waiting for ${label}: ${JSON.stringify(readRequests().map((b: any) => b.messages?.filter((m: any) => m.role !== "system").map((m: any) => ({role: m.role, content: m.content}))))}\n${output.slice(-2000)}`);
  };
  await until(() => output.includes("Nash"), "startup");
  child.stdin.write("dispatch\r");
  await until(() => readRequests().some((b: any) => b.messages?.some((m: any) => m.role === "user" && m.content === "PTY_CHILD_TASK")), "child dispatch");
  await until(() => readRequests().filter((b: any) => !b.messages?.some((m: any) => m.role === "user" && m.content === "PTY_CHILD_TASK")).length >= 2, "lead final response");
  // Allow the final response to finish and the real CLI to return to its input wait.
  await new Promise(resolve => setTimeout(resolve, 250));
  if (scenario === "switch") {
    const sessions = path.join(home, "nash", "projects");
    const sessionFile = fs.readdirSync(sessions, {recursive: true}).map(name => path.join(sessions, String(name))).find(name => name.endsWith("session.jsonl") && fs.readFileSync(name, "utf8").includes("PTY_MAIN_DONE"));
    assert.ok(sessionFile, "original session must be persisted before switching");
    const originalSessionId = path.basename(path.dirname(sessionFile));
    child.stdin.write("/new\r");
    await new Promise(resolve => setTimeout(resolve, 200));
    child.stdin.write("NEW_SESSION_PROMPT\r");
    await until(() => readRequests().some((b: any) => b.messages?.some((m: any) => m.role === "user" && m.content === "NEW_SESSION_PROMPT")), "new session response");
    await new Promise(resolve => setTimeout(resolve, 250));
    const beforeCompletion = readRequests().length;
    output = "";
    fs.writeFileSync(gate, "go");
    await until(() => fs.readdirSync(sessions, {recursive: true}).map(name => path.join(sessions, String(name))).some(name => name.endsWith("session.jsonl") && fs.readFileSync(name, "utf8").includes("PTY_CHILD_COMPLETE")), "child completion in original runtime");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readRequests().length, beforeCompletion, "old session completion must not wake the new session");
    assert.equal(output.includes("PTY_CHILD_COMPLETE"), false, "old session completion must not appear in the new session UI");
    child.stdin.write(`/resume ${originalSessionId}\r`);
    await until(() => readRequests().some((b: any) => b.messages?.some((m: any) => typeof m.content === "string" && m.content.includes("PTY_CHILD_COMPLETE") && m.content.includes("Notification ID"))), "original session resumed notification");
    const resumed = readRequests().find((b: any) => b.messages?.some((m: any) => typeof m.content === "string" && m.content.includes("PTY_CHILD_COMPLETE") && m.content.includes("Notification ID")));
    assert.equal(resumed.messages.some((m: any) => m.content === "NEW_SESSION_PROMPT"), false);
    return;
  }
  child.stdin.write("UNSENT_DRAFT");
  await new Promise(resolve => setTimeout(resolve, 50));
  fs.writeFileSync(gate, "go");
  await until(() => readRequests().some((b: any) => b.messages?.some((m: any) => typeof m.content === "string" && m.content.includes("PTY_CHILD_COMPLETE") && m.content.includes("Notification ID"))), "automatic notification turn");
  await new Promise(resolve => setTimeout(resolve, 200));
  child.stdin.write("_PRESERVED\r");
  await until(() => readRequests().some((b: any) => b.messages?.some((m: any) => m.role === "user" && m.content === "UNSENT_DRAFT_PRESERVED")), "preserved draft submission");
});
