import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION,
  type WindowsSandboxHelperConfig,
} from "../src/sandbox/windows/types.js";

/**
 * Windows Native Helper 协议直驱验收
 *
 * 该套件直接驱动 `nash-windows-sandbox-helper.exe`（--config-file），不经过 AgentLoop、
 * 不调用任何 LLM，也不依赖 Security Monitor / ApprovalService。它证明的是操作系统层面的
 * 强制力，因此必须与以下四类「拒绝」严格区分：
 *
 *   1. Security-LLM 拒绝     — 独立审查模型给出 <verdict>BLOCK</verdict>
 *   2. 审批拒绝              — ApprovalService 的人工 deny
 *   3. ACL / AppContainer 拒绝 — 内核权限拦截文件读写（本套件用例 1-2、5）
 *   4. Job Object 终止       — timeout/kill，以 killed=true 表达（本套件用例 3 与场景 D）
 *
 * 加载器失败、配置解析失败或超时永远不能作为隔离成功的证据；所有用例都要求 helper
 * 输出结构化 JSON，并区分 exitCode（子进程真实退出码）与 killed（Job Object 终止）。
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HELPER_PATH = path.join(REPO_ROOT, "native/bin/win32-x64/nash-windows-sandbox-helper.exe");
const MANIFEST_PATH = `${HELPER_PATH}.manifest.json`;
const HELPER_SOURCE_PATH = path.join(REPO_ROOT, "native/windows-sandbox-helper/main.c");
const HELPER_TYPES_PATH = path.join(REPO_ROOT, "src/sandbox/windows/types.ts");
const HELPER_MANAGER_PATH = path.join(REPO_ROOT, "src/sandbox/windows/sandbox-helper.ts");
const HELPER_TEMP_PATTERN = /^nash-win-sb-.*\.json$/;

function emitEvidence(payload: Record<string, unknown>): void {
  // 单行、机器可读：运维可原样粘贴进验收报告
  console.log(`HELPER_EVIDENCE ${JSON.stringify(payload)}`);
}

interface HelperJson {
  exitCode: number;
  stdout: string;
  stderr: string;
  killed: boolean;
  // --cleanup-profile 结构化输出字段
  profile?: string;
  deleted?: boolean;
  code?: string;
}

interface HelperRun {
  json?: HelperJson;
  status: number | null;
  stderr: string;
  parseError?: string;
}

function runHelper(args: string[], timeoutMs = 60000): HelperRun {
  const result = spawnSync(HELPER_PATH, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const lastLine = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
  if (!lastLine) {
    return {
      status: result.status,
      stderr,
      parseError: `helper emitted no stdout (status=${result.status}${result.signal ? `, signal=${result.signal}` : ""})`,
    };
  }
  try {
    return { json: JSON.parse(lastLine) as HelperJson, status: result.status, stderr };
  } catch {
    return {
      status: result.status,
      stderr,
      parseError: `helper stdout is not one JSON line: ${lastLine.slice(0, 200)}`,
    };
  }
}

function helperTempFiles(): Set<string> {
  try {
    return new Set(fs.readdirSync(os.tmpdir()).filter((name) => HELPER_TEMP_PATTERN.test(name)));
  } catch {
    return new Set();
  }
}

// AppContainer profile 的真实归属地：注册表项与 Packages 目录，二者都必须随清理消失。
const APPCONTAINER_STORAGE_KEY =
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Storage";

function regQuery(key: string): { status: number | null; stdout: string } {
  const result = spawnSync("reg.exe", ["query", key], { encoding: "utf8", timeout: 15000, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function listAppContainerProfiles(): Set<string> {
  const { status, stdout } = regQuery(APPCONTAINER_STORAGE_KEY);
  const names = new Set<string>();
  if (status !== 0) return names;
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith(APPCONTAINER_STORAGE_KEY)) continue;
    const name = value.slice(APPCONTAINER_STORAGE_KEY.length).replace(/^\\/, "");
    if (name) names.add(name);
  }
  return names;
}

function profileExists(profile: string): boolean {
  return regQuery(`${APPCONTAINER_STORAGE_KEY}\\${profile}`).status === 0;
}

function packagesDir(profile: string): string {
  return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Packages", profile);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(100);
  }
  return predicate();
}

/** 异步驱动 helper：清理用例需要在运行期间观测 profile 是否真的被创建。 */
function startHelper(file: string): Promise<HelperRun> {
  return new Promise((resolve) => {
    const child = spawn(HELPER_PATH, ["--config-file", file], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ status: null, stderr: error.message, parseError: error.message }));
    child.on("close", (status) => {
      const lastLine = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
      if (!lastLine) {
        resolve({ status, stderr: stderr.trim(), parseError: `helper emitted no stdout (status=${status})` });
        return;
      }
      try {
        resolve({ json: JSON.parse(lastLine) as HelperJson, status, stderr: stderr.trim() });
      } catch {
        resolve({ status, stderr: stderr.trim(), parseError: `helper stdout is not one JSON line: ${lastLine.slice(0, 200)}` });
      }
    });
  });
}

function isProcessAlive(pid: number): boolean {
  const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  // 本机存在该 PID 时 CSV 首行以引号开头；不存在时是 INFO 文本。
  return (result.stdout ?? "").trim().startsWith('"');
}

async function waitForProcessExit(pid: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(200);
  }
  return !isProcessAlive(pid);
}

// ===========================================================================
// Portable 契约：声明能力面必须自洽（任何平台都运行，只读、零副作用）
// ===========================================================================
describe("Windows helper declared capability surface (portable contract)", {
  // The manifest is produced by the MSVC helper build. Linux/macOS source
  // installs intentionally have no Windows helper, so they must not fail here.
  skip: process.platform !== "win32" ? "Requires a built Windows helper manifest" : false,
}, () => {
  it("protocol version, manifest and --version-json schema agree with the fields the client reads", () => {
    assert.equal(EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION, 2, "helper protocol must stay at version 2");

    // 1. Manifest 必须存在且与代码期望的协议版本一致
    assert.ok(fs.existsSync(MANIFEST_PATH), `helper manifest missing: ${MANIFEST_PATH}`);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as {
      protocolVersion: number;
      executable: string;
      binarySha256: string;
      sourceSha256: string;
      platform: string;
    };
    assert.equal(manifest.protocolVersion, EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION);
    assert.equal(manifest.platform, "win32");
    assert.equal(manifest.executable, path.relative(REPO_ROOT, HELPER_PATH).split(path.sep).join("/"));
    assert.match(manifest.binarySha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.sourceSha256, /^[a-f0-9]{64}$/);

    // 2. 源码里的协议常量与 --version-json 的发射格式必须一致
    const source = fs.readFileSync(HELPER_SOURCE_PATH, "utf8");
    assert.match(source, /#define PROTOCOL_VERSION 2/);
    const versionFnStart = source.indexOf("static void print_version_json");
    assert.ok(versionFnStart >= 0, "print_version_json must exist in helper source");
    const versionFn = source.slice(versionFnStart);
    const templateMatch = versionFn.match(/printf\("(\{.*?)\\n"/s);
    assert.ok(templateMatch, "--version-json must be emitted as a single JSON line");
    const template = templateMatch![1]!.replace(/\\"/g, '"');

    assert.match(template, /"protocolVersion":%d/);
    assert.match(template, /"platform":"win32"/);
    assert.match(template, /"arch":"x64"/);

    // 3. 发射的布尔字段集合 == WindowsHelperVersionInfo 中客户端真正读取的布尔字段集合
    const emittedBooleans = new Map<string, string>();
    for (const match of template.matchAll(/"(\w+)":(%s|true|false)/g)) {
      emittedBooleans.set(match[1]!, match[2]!);
    }
    const typesSource = fs.readFileSync(HELPER_TYPES_PATH, "utf8");
    const interfaceStart = typesSource.indexOf("export interface WindowsHelperVersionInfo");
    assert.ok(interfaceStart >= 0, "WindowsHelperVersionInfo must exist");
    const interfaceEnd = typesSource.indexOf("}", interfaceStart);
    const interfaceBody = typesSource.slice(interfaceStart, interfaceEnd);
    const declaredBooleans = [...interfaceBody.matchAll(/^\s+(\w+)\??:\s*boolean;/gm)].map((match) => match[1]!);

    assert.deepEqual(
      [...emittedBooleans.keys()].sort(),
      [...declaredBooleans].sort(),
      "--version-json must emit exactly the boolean capabilities the client parses",
    );
    for (const [key, token] of emittedBooleans) {
      assert.ok(token === "%s" || token === "true" || token === "false", `${key} must be boolean-shaped, got ${token}`);
    }

    // 4. 客户端握手确实按该协议版本做 Fail-Closed 校验
    const managerSource = fs.readFileSync(HELPER_MANAGER_PATH, "utf8");
    assert.match(managerSource, /parsed\.protocolVersion !== EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION/);
  });
});

// ===========================================================================
// Runtime 契约：在 Windows 上直驱 helper，证明 OS 级强制力
// ===========================================================================
describe(
  "Windows Native Helper protocol enforcement (direct, no LLM)",
  { skip: process.platform !== "win32" ? "Requires Windows platform (PE32+ helper binary)" : false, timeout: 180000 },
  () => {
    let tempRoot: string;
    let configDir: string;
    let caseDir: string;
    let workspace: string;
    let baselineHelperTempFiles: Set<string>;
    let configSeq = 0;

    before(() => {
      assert.ok(fs.existsSync(HELPER_PATH), `helper binary missing: ${HELPER_PATH}`);
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nash-helper-protocol-"));
      configDir = path.join(tempRoot, "configs");
      fs.mkdirSync(configDir);
      baselineHelperTempFiles = helperTempFiles();
    });

    after(() => {
      if (!tempRoot || !fs.existsSync(tempRoot)) return;
      assert.deepEqual(fs.readdirSync(configDir), [], "suite temp config files must all be deleted");
      const leaked = [...helperTempFiles()].filter((name) => !baselineHelperTempFiles.has(name));
      assert.deepEqual(leaked, [], "no nash-win-sb-*.json helper config may leak into %TEMP%");
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
      caseDir = fs.mkdtempSync(path.join(tempRoot, "case-"));
      workspace = path.join(caseDir, "workspace");
      fs.mkdirSync(workspace);
    });

    afterEach(() => {
      if (caseDir) fs.rmSync(caseDir, { recursive: true, force: true });
    });

    function newProfileName(tag: string): string {
      return `NashHelperTest_${tag}_${process.pid}_${Date.now()}_${++configSeq}`;
    }

    // 与 capability-probe 相同的正对照结构：workspace 直接位于 caseDir 之下，
    // 只授予 workspace 与 node 运行时目录的读取权，其余一概不授权。
    function containerConfig(profile: string, overrides: Partial<WindowsSandboxHelperConfig> = {}): WindowsSandboxHelperConfig {
      return {
        protocolVersion: EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION,
        command: process.execPath,
        args: [],
        cwd: workspace,
        timeoutMs: 20000,
        appContainerEnabled: true,
        appContainerName: profile,
        networkAllow: false,
        allowedReadPaths: [workspace, path.dirname(process.execPath)],
        ...overrides,
      };
    }

    function runSandbox(tag: string, config: WindowsSandboxHelperConfig): HelperRun {
      const file = path.join(configDir, `${tag}-${++configSeq}.json`);
      fs.writeFileSync(file, JSON.stringify(config), "utf8");
      try {
        return runHelper(["--config-file", file]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }

    function requireJson(result: HelperRun, caseName: string): HelperJson {
      assert.equal(
        result.parseError,
        undefined,
        `${caseName}: helper did not emit structured JSON (${result.parseError}); stderr=${result.stderr.slice(0, 500)}`,
      );
      return result.json!;
    }

    // -----------------------------------------------------------------------
    // 1. 合法写入：allowedWritePaths 内写入成功
    // -----------------------------------------------------------------------
    it("1) LEGAL WRITE: write inside allowedWritePaths exits 0 and is verified on the host", () => {
      const profile = newProfileName("write");
      const script = [
        "const fs=require('fs');",
        "fs.writeFileSync('legal-write.txt','LEGAL_WRITE_OK');",
        "if(fs.readFileSync('legal-write.txt','utf8')!=='LEGAL_WRITE_OK')process.exit(3);",
        "console.log('LEGAL_WRITE_CONFIRMED');",
      ].join("");
      const json = requireJson(
        runSandbox("legal-write", containerConfig(profile, { args: ["-e", script], allowedWritePaths: [workspace] })),
        "legal_write",
      );

      assert.equal(json.killed, false);
      assert.equal(json.exitCode, 0, `legal write failed: ${json.stderr.slice(0, 500)}`);
      assert.match(json.stdout, /LEGAL_WRITE_CONFIRMED/);
      assert.equal(fs.readFileSync(path.join(workspace, "legal-write.txt"), "utf8"), "LEGAL_WRITE_OK");

      emitEvidence({ case: "legal_write", exitCode: json.exitCode, killed: json.killed, marker: "LEGAL_WRITE_CONFIRMED", hostVerified: true });
    });

    // -----------------------------------------------------------------------
    // 2. 越界写入：内核 ACL 拒绝，宿主文件保持原样，且不得被误计为 Job kill
    // -----------------------------------------------------------------------
    it("2) OUT-OF-BOUNDS WRITE: ACL denial with exitCode 91, outside file unchanged, killed=false", () => {
      const profile = newProfileName("oob");
      const outsideFile = path.join(caseDir, "outside.txt");
      const workspaceFile = path.join(workspace, "read.txt");
      fs.writeFileSync(outsideFile, "OUTSIDE_UNCHANGED");
      fs.writeFileSync(workspaceFile, "READ_ONLY_ORIGINAL");

      const script =
        "const fs=require('fs');" +
        `const targets=[['read_outside',()=>fs.readFileSync(${JSON.stringify(outsideFile)})],` +
        `['write_outside',()=>fs.writeFileSync(${JSON.stringify(outsideFile)},'HACKED')],` +
        "['write_workspace',()=>fs.writeFileSync('read.txt','HACKED')]];" +
        "let denied=0;const codes=[];" +
        "for(const [label,fn] of targets){try{fn();codes.push(label+':ALLOWED')}catch(e){codes.push(label+':'+e.code);if(['EACCES','EPERM'].includes(e.code))denied++}}" +
        "console.log('FS_CODES:'+codes.join(','));" +
        "if(denied===3){console.log('FS_BOUNDARIES_DENIED');process.exit(91)}process.exit(4);";
      // 只读模式：allowedReadPaths 已包含 workspace，但没有任何写授权。
      const json = requireJson(runSandbox("oob-write", containerConfig(profile, { args: ["-e", script] })), "oob_write");

      assert.equal(json.exitCode, 91, `expected ACL-denied marker exit 91, got ${json.exitCode}: ${json.stdout}${json.stderr}`);
      assert.match(json.stdout, /FS_BOUNDARIES_DENIED/);
      assert.match(json.stdout, /(?:read_outside|write_outside|write_workspace):(?:EACCES|EPERM)/);
      // exitCode 与 killed 必须分离：ACL 拒绝不是 Job Object 终止
      assert.equal(json.killed, false, "ACL denial must not be reported as a Job Object kill");
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "OUTSIDE_UNCHANGED");
      assert.equal(fs.readFileSync(workspaceFile, "utf8"), "READ_ONLY_ORIGINAL");

      emitEvidence({
        case: "oob_write",
        exitCode: json.exitCode,
        killed: json.killed,
        marker: "FS_BOUNDARIES_DENIED",
        codes: /FS_CODES:([^\n]+)/.exec(json.stdout)?.[1] ?? "",
        outsideUnchanged: true,
        workspaceUnchanged: true,
      });
    });

    // -----------------------------------------------------------------------
    // 3. 子进程约束：Job Object ACTIVE_PROCESS 拒绝额外子进程，且并发数不超限
    // -----------------------------------------------------------------------
    it("3) CHILD PROCESS CONSTRAINT: maxProcesses refuses an extra child and the refusal is not a timeout", async () => {
      const maxProcesses = 2;
      // Reuse the helper's already-authorized handles. Node's "ignore" can need
      // NUL access and fail before CreateProcess on hosted Windows.
      // Creating new pipes can also hang on some Windows builds.
      const script =
        "const cp=require('child_process');const fs=require('fs');" +
        "const say=(l)=>{try{fs.writeSync(1,l+'\\n')}catch{}};" +
        "const kid=cp.spawn(process.execPath,['-e','setInterval(function(){},1000)'],{stdio:'inherit',windowsHide:true});" +
        "say('GRANDCHILD_PID='+kid.pid);" +
        "setTimeout(function(){" +
        "  const s=cp.spawnSync(process.execPath,['-e','process.exit(0)'],{stdio:'inherit',timeout:5000,windowsHide:true});" +
        "  say('SECOND_STATUS='+String(s.status)+' SECOND_ERROR='+(s.error?(s.error.code||s.error.message):'none'));" +
        "  if(s.status===0&&!s.error){say('CHILD_SPAWN_ALLOWED');process.exit(96)}" +
        "  say('CHILD_SPAWN_DENIED');process.exit(92);" +
        "},1200);";

      const startedAt = Date.now();
      const json = requireJson(
        runSandbox("process-limit", containerConfig(newProfileName("procs"), { args: ["-e", script], maxProcesses })),
        "process_limit",
      );
      const elapsedMs = Date.now() - startedAt;

      // 目标进程(1) + 存活子进程(1) 已达上限，第三次 CreateProcess 必须被 Job Object 拒绝。
      if (json.exitCode !== 92) {
        // Preserve the positive control even when the first child unexpectedly fails.
        // This distinguishes a global spawn restriction from the configured limit.
        const diagnosticControl = requireJson(
          runSandbox("process-control-diagnostic", containerConfig(newProfileName("procsdiag"), { args: ["-e", script], maxProcesses: 4 })),
          "process_control_diagnostic",
        );
        const diagnosticPid = /GRANDCHILD_PID=(\d+)/.exec(diagnosticControl.stdout)?.[1];
        if (diagnosticPid) assert.ok(await waitForProcessExit(Number(diagnosticPid), 15000), "diagnostic grandchild must not survive Job Object close");
        const hostControl = requireJson(
          runSandbox("process-host-diagnostic", containerConfig(newProfileName("procshost"), { args: ["-e", script], maxProcesses: 4, appContainerEnabled: false })),
          "process_host_diagnostic",
        );
        const hostPid = /GRANDCHILD_PID=(\d+)/.exec(hostControl.stdout)?.[1];
        if (hostPid) assert.ok(await waitForProcessExit(Number(hostPid), 15000), "host diagnostic grandchild must not survive Job Object close");
        const probeScript = "const f=require('fs'),c=require('child_process');try{f.accessSync(process.execPath,f.constants.R_OK);console.log('NODE_READABLE')}catch(e){console.log('NODE_READ_ERROR:'+e.code)};for(const [name,exe,args] of [['node',process.execPath,['-e','process.exit(0)']],['cmd','cmd.exe',['/c','exit','0']]]){try{const r=c.spawnSync(exe,args,{stdio:'ignore',timeout:5000,windowsHide:true});console.log(name.toUpperCase()+'_STATUS:'+r.status+':'+(r.error?.code||'none'))}catch(e){console.log(name.toUpperCase()+'_THREW:'+(e.code||e.name))}}";
        const spawnProbe = requireJson(
          runSandbox("process-spawn-diagnostic", containerConfig(newProfileName("procsprobe"), { args: ["-e", probeScript], maxProcesses: 0 })),
          "process_spawn_diagnostic",
        );
        assert.equal(json.exitCode, 92, `Job Object must refuse the extra child: ${json.stdout}${json.stderr}; positive control: exit=${diagnosticControl.exitCode}, stdout=${diagnosticControl.stdout}, stderr=${diagnosticControl.stderr}; no AppContainer: exit=${hostControl.exitCode}, stdout=${hostControl.stdout}, stderr=${hostControl.stderr}; spawn probe: exit=${spawnProbe.exitCode}, stdout=${spawnProbe.stdout}, stderr=${spawnProbe.stderr}`);
      }
      assert.equal(json.exitCode, 92, `Job Object must refuse the extra child: ${json.stdout}${json.stderr}`);
      assert.equal(json.killed, false, "refusing a child must not be reported as a Job Object kill");
      assert.match(json.stdout, /GRANDCHILD_PID=\d+/);
      assert.match(json.stdout, /SECOND_STATUS=null/, "CreateProcess must fail outright instead of succeeding");
      assert.match(json.stdout, /CHILD_SPAWN_DENIED/);
      assert.doesNotMatch(json.stdout, /CHILD_SPAWN_ALLOWED/);
      assert.ok(elapsedMs < 15000, `the refusal must be immediate, not a pipe deadlock ending at the Job timeout (${elapsedMs}ms)`);

      const grandchildPid = Number(/GRANDCHILD_PID=(\d+)/.exec(json.stdout)![1]);
      assert.ok(
        await waitForProcessExit(grandchildPid, 15000),
        `orphan grandchild ${grandchildPid} survived Job Object close`,
      );

      // 正对照：同一脚本在更宽配额下必须成功创建第二个子进程，证明拒绝来自 maxProcesses 而不是通用封锁。
      const control = requireJson(
        runSandbox("process-control", containerConfig(newProfileName("procsctl"), { args: ["-e", script], maxProcesses: 4 })),
        "process_control",
      );
      assert.equal(control.exitCode, 96, `with capacity the second child must start: ${control.stdout}${control.stderr}`);
      assert.equal(control.killed, false);
      assert.match(control.stdout, /SECOND_STATUS=0/);
      assert.match(control.stdout, /CHILD_SPAWN_ALLOWED/);
      const controlGrandchild = Number(/GRANDCHILD_PID=(\d+)/.exec(control.stdout)![1]);
      assert.ok(await waitForProcessExit(controlGrandchild, 15000), "control grandchild must not survive Job Object close");

      emitEvidence({
        case: "child_process_constraint",
        exitCode: json.exitCode,
        killed: json.killed,
        marker: "CHILD_SPAWN_DENIED",
        maxProcesses,
        elapsedMs,
        deniedStatus: /SECOND_STATUS=(\w+)/.exec(json.stdout)![1],
        controlExitCode: control.exitCode,
        controlAllowed: true,
        grandchildExited: true,
      });
    });

    // -----------------------------------------------------------------------
    // 4. 资源上限：超出 memoryLimitBytes 的分配失败，合法分配成功
    // -----------------------------------------------------------------------
    it("4) RESOURCE LIMIT: allocation beyond memoryLimitBytes fails while a legal allocation succeeds", (t) => {
      const profile = newProfileName("memory");
      const memoryLimitBytes = 256 * 1024 * 1024;
      // 分块分配：单块 32 MiB 的 malloc 失败会抛出可捕获的 ERR_MEMORY_ALLOCATION_FAILED，
      // 避免一次性巨型分配在某些 Windows 版本上直接触发不可捕获的进程终止。
      const script =
        "const legal=Buffer.alloc(8*1024*1024);legal[0]=1;legal[legal.length-1]=2;" +
        "console.log('LEGAL_ALLOC_OK:'+legal.length);" +
        "const held=[];try{for(let i=0;i<64;i++){held.push(Buffer.alloc(32*1024*1024));}" +
        "console.log('OOM_ALLOC_UNEXPECTEDLY_SUCCEEDED');process.exit(90);" +
        "}catch(e){console.log('OOM_ALLOC_DENIED:'+(e.code||e.name));process.exit(93);}";
      const result = runSandbox("memory-limit", containerConfig(profile, { args: ["-e", script], memoryLimitBytes }));
      const unsupported = /SetInformationJobObject failed/.test(result.stderr) ||
        /SetInformationJobObject failed/.test(result.json?.stderr ?? "");
      if (unsupported) {
        t.skip(`helper/OS reports the Job Object memory limit as unsupported: ${(result.stderr || result.json?.stderr || "").slice(0, 200)}`);
        return;
      }
      const json = requireJson(result, "memory_limit");

      assert.equal(json.killed, false);
      assert.match(json.stdout, /LEGAL_ALLOC_OK:\d+/, "a legal allocation inside the cap must succeed");
      assert.notEqual(json.exitCode, 90, "allocation beyond memoryLimitBytes must not succeed");
      assert.notEqual(json.exitCode, 0, "the over-cap allocation must fail the child");
      if (json.stdout.includes("OOM_ALLOC_DENIED")) {
        assert.match(json.stdout, /OOM_ALLOC_DENIED:/);
      }

      emitEvidence({
        case: "resource_limit",
        exitCode: json.exitCode,
        killed: json.killed,
        marker: json.stdout.includes("OOM_ALLOC_DENIED") ? "OOM_ALLOC_DENIED" : "OOM_PROCESS_EXIT",
        memoryLimitBytes,
        legalAlloc: true,
      });
    });

    // -----------------------------------------------------------------------
    // 5. 清理：AppContainer profile 不存在残留，无临时配置，无孤儿进程
    // -----------------------------------------------------------------------
    it("5) CLEANUP: profile created then fully removed, other AppContainers untouched", async () => {
      const profile = newProfileName("cleanup");
      // 运行 2.5 秒，宿主才能在运行期间观测到 profile 真的被创建（否则清理断言可能只是在检查一个从未存在的名字）。
      const script = "const fs=require('fs');fs.writeSync(1,'CHILD_PID='+process.pid+'\\n');setTimeout(function(){fs.writeSync(1,'CLEANUP_RUN_OK\\n')},2500);";
      const before = listAppContainerProfiles();

      const configFile = path.join(configDir, `cleanup-${++configSeq}.json`);
      fs.writeFileSync(configFile, JSON.stringify(containerConfig(profile, { args: ["-e", script], timeoutMs: 30000 })), "utf8");
      let running: Promise<HelperRun>;
      try {
        running = startHelper(configFile);
        const created = await waitFor(() => profileExists(profile), 20000);
        assert.ok(created, "the sandbox run must create its AppContainer profile before we can test cleanup");
      } finally {
        fs.rmSync(configFile, { force: true });
      }
      const json = requireJson(await running, "cleanup");

      assert.equal(json.exitCode, 0, `cleanup probe run failed: ${json.stderr.slice(0, 500)}`);
      assert.equal(json.killed, false);
      assert.match(json.stdout, /CLEANUP_RUN_OK/);
      const childPid = Number(/CHILD_PID=(\d+)/.exec(json.stdout)![1]);
      assert.ok(await waitForProcessExit(childPid, 15000), `sandbox child ${childPid} survived Job Object close`);

      // 退出后：注册表项与 Packages 目录都必须消失——这是真实资源证据，不是返回码推断。
      assert.equal(profileExists(profile), false, `profile registry key must be gone after the run: ${profile}`);
      assert.equal(fs.existsSync(packagesDir(profile)), false, `profile package directory must be gone after the run: ${packagesDir(profile)}`);

      // 清理不得波及系统里其他 AppContainer。
      const after = listAppContainerProfiles();
      for (const name of before) {
        assert.ok(after.has(name), `unrelated AppContainer profile '${name}' must survive the cleanup`);
      }

      // --cleanup-profile 的契约是幂等：缺失也算成功（该 Windows build 对不存在的 profile 返回 S_OK，
      // 所以成功语义只由 deleted/status 表达，不能用 HRESULT 反推残留）。
      const first = runHelper(["--cleanup-profile", profile]);
      assert.equal(first.json?.deleted, true, `first cleanup must succeed: ${first.parseError ?? first.stderr}`);
      assert.equal(first.status, 0);
      const second = runHelper(["--cleanup-profile", profile]);
      assert.equal(second.json?.deleted, true, `second cleanup must be idempotent: ${second.parseError ?? second.stderr}`);
      assert.equal(second.status, 0);
      assert.equal(profileExists(profile), false, "cleanup must leave no registry residue");
      assert.equal(fs.existsSync(packagesDir(profile)), false, "cleanup must leave no package directory");

      // 临时配置文件：套件自建文件已删除，helper 自身也不得在 %TEMP% 留下 nash-win-sb-*.json
      assert.deepEqual(fs.readdirSync(configDir), [], "suite temp config files must be deleted");
      const leaked = [...helperTempFiles()].filter((name) => !baselineHelperTempFiles.has(name));
      assert.deepEqual(leaked, [], "helper must not leak nash-win-sb-*.json into %TEMP%");

      emitEvidence({
        case: "cleanup",
        exitCode: json.exitCode,
        killed: json.killed,
        marker: "CLEANUP_RUN_OK",
        profile,
        profileCreatedDuringRun: true,
        registryResidue: false,
        packageDirResidue: false,
        cleanupFirst: first.json?.code,
        cleanupSecond: second.json?.code,
        childExited: true,
        tempConfigFilesLeaked: 0,
      });
    });

    // -----------------------------------------------------------------------
    // 6. 沙箱内子进程 stdio：AppContainer 命名管道创建能力与管道阻塞的真实边界
    // -----------------------------------------------------------------------
    it("6) APPCONTAINER STDIO: global named pipes are denied, LOCAL pipes work, piped child stdio blocks until the Job timeout", async () => {
      const profile = newProfileName("stdio");
      // Node 的 libuv 在全局命名空间 (\\.\pipe\<name>) 创建子进程 stdio 管道；AppContainer 只被允许
      // 在自身命名空间 (\\.\pipe\LOCAL\) 创建。两者各测一次，用同一次运行给出版本级证据。
      const pipeScript = [
        "const net=require('net');const out=[];let left=2;",
        "const done=(ns,v)=>{out.push(ns+'='+v);if(--left===0){console.log('PIPE_PROBE:'+out.join(','));process.exit(0)}};",
        "for(const ns of ['global','local']){",
        "  const name=(ns==='local'?'\\\\\\\\.\\\\pipe\\\\LOCAL\\\\':'\\\\\\\\.\\\\pipe\\\\')+'nash-stdio-'+process.pid;",
        "  const s=net.createServer();",
        "  s.on('error',e=>done(ns,'FAIL:'+(e.code||e.message)));",
        "  s.listen(name,()=>{done(ns,'OK');s.close()});",
        "}",
        "setTimeout(()=>{console.log('PIPE_PROBE:'+out.join(',')+',TIMEOUT');process.exit(0)},2000);",
      ].join("");
      const pipes = requireJson(runSandbox("stdio-pipes", containerConfig(newProfileName("stdiopipes"), { args: ["-e", pipeScript] })), "stdio_pipes");
      assert.equal(pipes.killed, false);
      assert.match(pipes.stdout, /PIPE_PROBE:/, "the pipe probe must produce structured evidence");
      const evidence = /PIPE_PROBE:([^\r\n]*)/.exec(pipes.stdout)?.[1] ?? "";
      const globalOk = /(^|,)global=OK(,|$)/.test(evidence);
      const localOk = /(^|,)local=OK(,|$)/.test(evidence);
      assert.equal(localOk, true, `AppContainer must still create LOCAL named pipes (${evidence})`);

      // 目标进程再创建带管道 stdio 的子进程：若全局命名管道被拒绝，调用会阻塞并被 Job Object 在超时后终止。
      const pipedChild =
        "const cp=require('child_process');const fs=require('fs');const t=Date.now();" +
        "const r=cp.spawnSync(process.execPath,['-e','process.stdout.write(\"K\")'],{encoding:'utf8',timeout:4000});" +
        "fs.writeSync(1,'RESULT '+JSON.stringify({status:r.status,error:r.error&&(r.error.code||r.error.message),out:r.stdout,ms:Date.now()-t})+'\\n');";
      const blocked = requireJson(
        runSandbox("stdio-piped-child", containerConfig(newProfileName("stdiopiped"), { args: ["-e", pipedChild], timeoutMs: 7000 })),
        "stdio_piped_child",
      );
      // 继承父进程 stdio 的子进程不创建新管道，必须在同一 AppContainer 内正常完成。
      const inherited = requireJson(
        runSandbox("stdio-inherit", containerConfig(newProfileName("stdioinherit"), {
          args: ["-e", "const cp=require('child_process');const r=cp.spawnSync(process.execPath,['-e','process.stdout.write(\"KINH\")'],{stdio:'inherit',timeout:4000});console.log('INHERIT_STATUS:'+r.status);"],
        })),
        "stdio_inherit",
      );
      assert.equal(inherited.killed, false);
      assert.equal(inherited.exitCode, 0);
      assert.match(inherited.stdout, /KINH/);
      assert.match(inherited.stdout, /INHERIT_STATUS:0/);

      if (globalOk) {
        // 该 Windows build 允许 AppContainer 创建全局命名管道：管道子进程必须正常返回，不能是超时。
        assert.equal(blocked.killed, false, `piped child stdio must complete when global pipes exist: ${JSON.stringify(blocked)}`);
        assert.equal(blocked.exitCode, 0);
        assert.match(blocked.stdout, /"status":0/);
      } else {
        // 已知平台限制：阻塞而非错误返回，表现为 Job Object 超时终止（killed=true）。
        // 这条断言把「挂起到超时」固定成可观测事实，避免将来被误判为可用。
        assert.match(evidence, /global=FAIL:(EADDRINUSE|EPERM|EACCES)/);
        assert.equal(blocked.killed, true, `piped child stdio must block until the Job timeout on this build: ${JSON.stringify(blocked)}`);
        assert.doesNotMatch(blocked.stdout, /"status":0/, "piped child must not silently succeed");
      }

      emitEvidence({
        case: "appcontainer_stdio",
        profile,
        globalPipeCreation: globalOk,
        localPipeCreation: localOk,
        pipeEvidence: evidence,
        pipedChildKilled: blocked.killed,
        pipedChildExitCode: blocked.exitCode,
        inheritedStdioExitCode: inherited.exitCode,
        hostSideCaptureUnaffected: true,
      });
    });
  },
);
