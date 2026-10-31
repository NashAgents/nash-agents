import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WindowsSandboxBackend } from "../src/sandbox/backends/windows-sandbox.js";
import { SandboxUnavailableError } from "../src/sandbox/errors.js";

const policy = { filesystem: { mode: "workspace-write" as const }, network: { mode: "deny" as const }, approval: { mode: "never" as const } };
describe("Windows native shell and ACL alias regressions", { skip: process.platform !== "win32" }, () => {
  it("keeps PowerShell 7 command discovery available when installed", async t => {
    const executable = path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    if (!fs.existsSync(executable)) { t.skip("PowerShell 7 is not installed on this host"); return; }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nash-pwsh7-"));
    try {
      const file = path.join(cwd, "read.txt"); fs.writeFileSync(file, "PWSH7_READ_OK");
      const result = await new WindowsSandboxBackend().run({ command: executable,
        args: ["-NoProfile", "-NonInteractive", "-Command", `Get-Content -LiteralPath '${file.replaceAll("'", "''")}'`], cwd, policy });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /PWSH7_READ_OK/);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("respects an explicitly supplied PowerShell module search path", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nash-module-override-"));
    try {
      const result = await new WindowsSandboxBackend().run({ command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('OVERRIDE_PRESENT='+($env:PSModulePath -match 'nash-explicit-module-path'))"],
        env: { PSModulePath: "C:\\nash-explicit-module-path" }, cwd, policy });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /OVERRIDE_PRESENT=True/i);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("keeps the PowerShell module cache in the task's temporary directory and cleans it up", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nash-module-cache-"));
    try {
      const result = await new WindowsSandboxBackend().run({ command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({cache:process.env.PSModuleAnalysisCachePath,tmp:process.env.TEMP}))"], cwd, policy });
      assert.equal(result.exitCode, 0, result.stderr);
      const paths = JSON.parse(result.stdout.trim()) as { cache: string; tmp: string };
      const cacheDir = path.dirname(paths.cache);
      assert.match(path.basename(cacheDir), /^nash-task-tmp-\d+-[a-f0-9]{8}$/);
      assert.equal(fs.realpathSync.native(path.dirname(cacheDir)).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
      assert.equal(path.basename(paths.cache), "powershell-module-analysis.cache");
      assert.equal(fs.existsSync(cacheDir), false, "task cache directory must be removed after execution");
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("PowerShell launches Node and npm in the actual workspace", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nash-native-tools-"));
    try {
      fs.writeFileSync(path.join(cwd, "check.cjs"), "console.log('CHILD_WORKSPACE='+process.cwd());console.log('NATIVE_CHILD_OK')");
      const backend = new WindowsSandboxBackend();
      const result = await backend.run({ command: "bash", args: ["-lc", "node check.cjs; npm --version"], cwd, policy });
      assert.equal(result.exitCode, 0, result.stderr);
      const reportedCwd = /^CHILD_WORKSPACE=(.+)\r?$/m.exec(result.stdout)?.[1];
      assert.ok(reportedCwd, result.stdout);
      // Windows may return the long form while TEMP uses its 8.3 alias.
      // Resolve both physical paths so a different directory still fails.
      assert.equal(fs.realpathSync.native(reportedCwd).toLowerCase(), fs.realpathSync.native(cwd).toLowerCase());
      assert.match(result.stdout, /NATIVE_CHILD_OK/);
      assert.match(result.stdout, /\d+\.\d+\.\d+/);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("rejects a preexisting external hard link before propagating an ACL", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-hardlink-"));
    const cwd = path.join(root, "workspace"); fs.mkdirSync(cwd);
    const outside = path.join(root, "private.txt"); fs.writeFileSync(outside, "PRIVATE");
    try {
      fs.linkSync(outside, path.join(cwd, "alias.txt"));
      await assert.rejects(new WindowsSandboxBackend().run({ command: process.execPath,
        args: ["-e", "console.log(require('fs').readFileSync('alias.txt','utf8'))"], cwd, policy }), SandboxUnavailableError);
      assert.equal(fs.readFileSync(outside, "utf8"), "PRIVATE");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("runs two independent AppContainers concurrently without sharing task access", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-parallel-native-"));
    const dirs = ["a", "b"].map(n => { const d = path.join(root, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "private.txt"), n); return d; });
    try {
      const run = (index: number) => new Promise<string>((resolve, reject) => {
        const other = path.join(dirs[1 - index]!, "private.txt");
        const script = `try{require('fs').readFileSync(${JSON.stringify(other)});process.exit(99)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e}setTimeout(()=>console.log('PARALLEL_OK'),500)`;
        const spec = new WindowsSandboxBackend().buildExecutionSpec({ command: process.execPath, args: ["-e", script], cwd: dirs[index]!, policy, timeout: 4000 });
        const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true });
        let stdout = "", stderr = "";
        child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
        child.once("error", reject);
        child.once("close", code => { try { spec.cleanup?.(); assert.equal(code, 0, stderr); resolve(stdout); } catch (e) { reject(e); } });
      });
      const results = await Promise.allSettled([run(0), run(1)]);
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        assert.match(result.value, /PARALLEL_OK/);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
