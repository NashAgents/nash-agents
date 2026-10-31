import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WindowsSandboxCrashRecoveryLedger as Ledger } from "../src/sandbox/windows/recovery-ledger.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("Windows owner death terminates the real Job tree and recovers its ACL ledger", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nash-owner-crash-"));
  const backendUrl = new URL("../src/sandbox/backends/windows-sandbox.ts", import.meta.url).href;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const script = `import {WindowsSandboxBackend} from ${JSON.stringify(backendUrl)}; await new WindowsSandboxBackend().run({command:process.execPath,args:['-e',${JSON.stringify("require('fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)")}],cwd:${JSON.stringify(workspace)},timeout:30000,policy:{filesystem:{mode:'workspace-write'},network:{mode:'deny'},approval:{mode:'never'}}});`;
  const owner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: root, stdio: "ignore", windowsHide: true });
  let childPid: number | undefined;
  let childIdentity: string | undefined;
  t.after(async () => {
    owner.kill();
    if (childPid && childIdentity && Ledger.processIdentity(childPid) === childIdentity) {
      try { process.kill(childPid); } catch {}
    }
    await pause(100);
    Ledger.recoverOrphans();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const pidFile = path.join(workspace, "child.pid");
  const deadline = Date.now() + 25000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline && owner.exitCode === null) await pause(100);
  assert.ok(fs.existsSync(pidFile), "AppContainer child must actually start before owner-crash validation");
  childPid = Number(fs.readFileSync(pidFile, "utf8"));
  childIdentity = Ledger.processIdentity(childPid);
  const record = Ledger.readLedger().find(r => r.pid === owner.pid);
  assert.ok(record?.sid && record.processIdentity, "recovery intent and owner birth identity must precede execution");
  owner.kill("SIGTERM");
  const stopped = Date.now() + 12000;
  while (Ledger.isProcessAlive(childPid) && Date.now() < stopped) await pause(100);
  assert.equal(Ledger.isProcessAlive(childPid), false, "native Job must terminate when the pinned owner exits");
  const recovery = Ledger.recoverOrphans();
  assert.equal(recovery.warnings.length, 0);
  assert.equal(Ledger.readLedger().some(r => r.taskId === record.taskId), false);
  const acl = execFileSync("icacls.exe", [workspace], { encoding: "utf8" });
  assert.equal(acl.includes(record.sid), false, "task SID must be revoked from workspace DACL");
});
