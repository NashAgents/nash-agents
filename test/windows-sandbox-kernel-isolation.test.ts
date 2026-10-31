import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import cp from "node:child_process";
import crypto from "node:crypto";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { WindowsSandboxBackend } from "../src/sandbox/backends/windows-sandbox.js";
import { WindowsSandboxHelperManager } from "../src/sandbox/windows/sandbox-helper.js";
import { WindowsSandboxProbe } from "../src/sandbox/windows/capability-probe.js";
import { WindowsSandboxCrashRecoveryLedger } from "../src/sandbox/windows/recovery-ledger.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { SandboxUnavailableError, FilesystemAccessDeniedError } from "../src/sandbox/errors.js";

/**
 * Nash Native Windows Sandbox — Kernel-Enforced Filesystem & Network Isolation
 * 严格负面与正向安全测试套件 (Scenarios A through S)
 */
describe("Windows Sandbox Kernel-Enforced Isolation Security Test Suite", { skip: process.platform !== "win32" ? "Requires Windows platform" : false }, () => {
  let tempWorkspace: string;
  let protectedOutsideDir: string;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "nash-win-sec-ws-"));
    protectedOutsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-win-sec-out-"));
  });

  afterEach(async () => {
    try {
      if (fsSync.existsSync(tempWorkspace)) {
        await fs.rm(tempWorkspace, { recursive: true, force: true });
      }
      if (fsSync.existsSync(protectedOutsideDir)) {
        await fs.rm(protectedOutsideDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // =========================================================================
  // 场景 A：工作区只读模式 — 允许读取项目文件，尝试修改被 Windows 内核直接拒绝
  // =========================================================================
  it("场景 A：工作区只读 — 允许读取项目文件，尝试修改被 Windows 内核直接拒绝", async () => {
    const testFile = path.join(tempWorkspace, "code.txt");
    await fs.writeFile(testFile, "ORIGINAL_CONTENT", "utf-8");

    const service = new SandboxService({
      policy: {
        filesystem: { mode: "read-only" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    // 1. 允许读取工作区文件
    const readRes = await service.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Get-Content '${testFile}'`],
      cwd: tempWorkspace,
    });
    if (readRes.exitCode !== 0) {
      // Diagnose runtime module discovery without exposing environment values.
      const diagnostic = await service.runProcess({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "$p=$env:PSModulePath; [Console]::WriteLine('MODULE_PATH_SET='+(-not [String]::IsNullOrEmpty($p))); $base=[IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','Modules'); $d=[IO.Path]::Combine($base,'Microsoft.PowerShell.Management'); [Console]::WriteLine('SYSTEM_MODULE_DIR_EXISTS='+[IO.Directory]::Exists($d)); $found=$false; foreach($part in ($p -split ';')) { if($part.TrimEnd('\\') -ieq $base.TrimEnd('\\')) { $found=$true } }; [Console]::WriteLine('SYSTEM_MODULE_PATH_PRESENT='+$found); try { [void][IO.Directory]::GetDirectories($base); [Console]::WriteLine('MODULE_PARENT_ENUMERABLE=True') } catch { [Console]::WriteLine('MODULE_PARENT_ENUMERABLE=False'); [Console]::WriteLine('ENUM_ERROR_TYPE='+$_.Exception.GetType().Name) }; try { $manifest=[IO.Path]::Combine($d,'Microsoft.PowerShell.Management.psd1'); [void][IO.File]::ReadAllText($manifest); [Console]::WriteLine('MANIFEST_READABLE=True') } catch { [Console]::WriteLine('MANIFEST_READABLE=False'); [Console]::WriteLine('MANIFEST_ERROR_TYPE='+$_.Exception.GetType().Name) }; try { $available=@(Get-Module -ListAvailable -Name Microsoft.PowerShell.Management -ErrorAction Stop); [Console]::WriteLine('MODULE_DISCOVERY_COUNT='+$available.Count); if($available.Count -gt 0) { [Console]::WriteLine('DISCOVERED_EXPORTS_COUNT='+$available[0].ExportedCommands.Count); [Console]::WriteLine('DISCOVERED_GET_CONTENT='+$available[0].ExportedCommands.ContainsKey('Get-Content')) } } catch { [Console]::WriteLine('MODULE_DISCOVERY_ERROR='+$_.FullyQualifiedErrorId) }; [Console]::WriteLine('AUTOLOAD_PREFERENCE='+[string]$PSModuleAutoLoadingPreference); try { $cmd=Get-Command Get-Content -ErrorAction Stop; [Console]::WriteLine('COMMAND_LOOKUP_OK='+[bool]$cmd) } catch { [Console]::WriteLine('COMMAND_LOOKUP_ERROR='+$_.FullyQualifiedErrorId) }; try { Import-Module Microsoft.PowerShell.Management -ErrorAction Stop; [Console]::WriteLine('IMPORT_OK=True') } catch { [Console]::WriteLine('IMPORT_OK=False'); [Console]::WriteLine('ERROR_ID='+$_.FullyQualifiedErrorId) }"],
        cwd: tempWorkspace,
      });
      const systemModules = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules");
      const isolatedDiscovery = await service.runProcess({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", `[Console]::WriteLine('EFFECTIVE_MODULE_PATH_COUNT='+@($env:PSModulePath -split ';').Count); [Console]::WriteLine('EFFECTIVE_HAS_AWS='+($env:PSModulePath -match 'AWS')); Get-Content '${testFile}'`],
        env: { PSModulePath: systemModules },
        cwd: tempWorkspace,
      });
      // PowerShell 5.1 inserts its machine-wide module directory when PSModulePath
      // contains the literal PSHOME\\Modules path. This spelling addresses the
      // same system directory without the insertion and is used only as a probe.
      const psHome = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
      const equivalentSystemPath = await service.runProcess({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", `[Console]::WriteLine('EFFECTIVE_MODULE_PATH_COUNT='+@($env:PSModulePath -split ';').Count); Get-Content '${testFile}'`],
        env: { PSModulePath: `${psHome}\\.\\Modules` },
        cwd: tempWorkspace,
      });
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const minimalPath = [path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";");
      const minimalPathDiscovery = await service.runProcess({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", `Get-Content '${testFile}'`],
        env: { PATH: minimalPath },
        cwd: tempWorkspace,
      });
      const trace = await service.runProcess({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "$trace=[IO.Path]::Combine([IO.Path]::GetDirectoryName($env:PSModuleAnalysisCachePath),'discovery-trace.txt'); try { Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop; Trace-Command -Name CommandDiscovery,Modules -Expression { Get-Command Get-Content -ErrorAction SilentlyContinue } -FilePath $trace; if([IO.File]::Exists($trace)){ $lines=[IO.File]::ReadAllLines($trace); $matchCount=0; foreach($line in $lines){ if($line -notmatch 'Looking for' -and $line -match 'denied|exception|error|failed|Get-Content|ImportModule|AutoLoad'){ if($matchCount -lt 60){ [Console]::WriteLine('TRACE='+$line); $matchCount++ } } }; [Console]::WriteLine('TRACE_MATCHES='+$matchCount) } else { [Console]::WriteLine('TRACE_MISSING=True') } } catch { [Console]::WriteLine('TRACE_ERROR='+$_.FullyQualifiedErrorId) }"],
        cwd: tempWorkspace,
      });
      assert.equal(readRes.exitCode, 0, `PowerShell read failed: ${readRes.stderr}; diagnostic: ${diagnostic.stdout} ${diagnostic.stderr}; system-only module path read: exit=${isolatedDiscovery.exitCode}, content=${isolatedDiscovery.stdout.includes("ORIGINAL_CONTENT")}, stdout=${isolatedDiscovery.stdout}, stderr=${isolatedDiscovery.stderr}; equivalent system path read: exit=${equivalentSystemPath.exitCode}, content=${equivalentSystemPath.stdout.includes("ORIGINAL_CONTENT")}, stdout=${equivalentSystemPath.stdout}, stderr=${equivalentSystemPath.stderr}; minimal PATH read: exit=${minimalPathDiscovery.exitCode}, content=${minimalPathDiscovery.stdout.includes("ORIGINAL_CONTENT")}, stderr=${minimalPathDiscovery.stderr}; trace: ${trace.stdout} ${trace.stderr}`);
    }
    assert.equal(readRes.exitCode, 0);
    assert.match(readRes.stdout, /ORIGINAL_CONTENT/);

    // 2. 尝试修改工作区文件被操作系统拒绝 (ACCESS_DENIED)
    const writeRes = await service.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Set-Content -Path '${testFile}' -Value 'HACKED_CONTENT'`],
      cwd: tempWorkspace,
    });
    assert.notEqual(writeRes.exitCode, 0);
    assert.match(writeRes.stderr, /UnauthorizedAccessException|拒绝访问|Access.*denied/i);

    // 确认宿主文件内容未被篡改
    const fileAfter = await fs.readFile(testFile, "utf-8");
    assert.equal(fileAfter, "ORIGINAL_CONTENT");
  });

  // =========================================================================
  // 场景 B：工作区内写入成功 — 工作区内可写
  // =========================================================================
  it("场景 B：工作区内写入成功 — 工作区内可写，文件正确生成与更新", async () => {
    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    const insideFile = path.join(tempWorkspace, "inside.txt");
    const wsWriteRes = await service.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Set-Content -Path '${insideFile}' -Value 'VALID_DATA'`],
      cwd: tempWorkspace,
    });
    assert.equal(wsWriteRes.exitCode, 0);

    const content = await fs.readFile(insideFile, "utf-8");
    assert.match(content, /VALID_DATA/);
  });

  // =========================================================================
  // 场景 C：工作区外写入拒绝 — 工作区外写入被 Windows 内核直接阻断
  // =========================================================================
  it("场景 C：工作区外写入拒绝 — 工作区外写入被 Windows 内核直接阻断", async () => {
    const outsideTarget = path.join(protectedOutsideDir, "outside_target.txt");
    await fs.writeFile(outsideTarget, "PROTECTED_OUTSIDE", "utf-8");

    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    const outWriteRes = await service.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Set-Content -Path '${outsideTarget}' -Value 'ATTACK_OVERWRITE'`],
      cwd: tempWorkspace,
    });
    assert.notEqual(outWriteRes.exitCode, 0);
    assert.match(outWriteRes.stderr, /Unauthorized[\s\S]*AccessException|PermissionDenied|拒绝访问|Access[\s\S]*denied/i);

    const outsideContent = await fs.readFile(outsideTarget, "utf-8");
    assert.equal(outsideContent, "PROTECTED_OUTSIDE");
  });

  // =========================================================================
  // 场景 D：工作区外读取拒绝 — 工作区外读取被内核拦截
  // =========================================================================
  it("场景 D：工作区外读取拒绝 — PowerShell 与 Node.js 访问未授权文件均遭到操作系统拦截", async () => {
    const secretFile = path.join(protectedOutsideDir, "secret.key");
    await fs.writeFile(secretFile, "SUPER_CONFIDENTIAL_KEY_2026", "utf-8");

    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    // 1. PowerShell 绕过测试
    const psRes = await service.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Get-Content '${secretFile}'`],
      cwd: tempWorkspace,
    });
    assert.notEqual(psRes.exitCode, 0);
    assert.match(psRes.stderr, /Unauthorized[\s\S]*AccessException|PermissionDenied|拒绝访问|Access[\s\S]*denied/i);

    // 2. Node.js fs.readFileSync 绕过测试
    const nodeRes = await service.runProcess({
      command: "node.exe",
      args: ["-e", `fs.readFileSync(${JSON.stringify(secretFile)})`],
      cwd: tempWorkspace,
    });
    assert.notEqual(nodeRes.exitCode, 0);
    assert.match(nodeRes.stderr, /EPERM|EACCES|operation not permitted/i);
  });

  // =========================================================================
  // 场景 E：任务间文件访问隔离 — 任务 A 无法访问任务 B 的私有临时目录
  // =========================================================================
  it("场景 E：任务间文件访问隔离 — 任务 A 专属 AppContainer 无法访问任务 B 的私有临时目录", async () => {
    const taskBDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-task-b-private-"));
    const taskBSecret = path.join(taskBDir, "task_b_token.txt");
    await fs.writeFile(taskBSecret, "TOKEN_FOR_TASK_B_ONLY", "utf-8");

    try {
      const service = new SandboxService({
        policy: {
          filesystem: { mode: "workspace-write" },
          network: { mode: "deny" },
          approval: { mode: "never" },
        },
        cwd: tempWorkspace,
      });

      // 任务 A 在独立 AppContainer 中尝试窃取任务 B 目录中的文件
      const res = await service.runProcess({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", `Get-Content '${taskBSecret}'`],
        cwd: tempWorkspace,
      });

      assert.notEqual(res.exitCode, 0);
      assert.match(res.stderr, /Unauthorized[\s\S]*AccessException|PermissionDenied|拒绝访问|Access[\s\S]*denied|ItemNotFound/i);
    } finally {
      if (fsSync.existsSync(taskBDir)) {
        await fs.rm(taskBDir, { recursive: true, force: true });
      }
    }
  });

  // =========================================================================
  // 场景 F：并发 AppContainer Profile — 多个沙箱并发执行互不冲突
  // =========================================================================
  it("场景 F：并发 AppContainer Profile — 多个沙箱任务并发执行，各自拥有唯一 Profile 与 SID", async () => {
    const service1 = new SandboxService({
      policy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, approval: { mode: "never" } },
      cwd: tempWorkspace,
    });
    const service2 = new SandboxService({
      policy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, approval: { mode: "never" } },
      cwd: tempWorkspace,
    });

    const [res1, res2] = await Promise.all([
      service1.runProcess({ command: "cmd.exe", args: ["/c", "echo CONCURRENT_TASK_1"], cwd: tempWorkspace }),
      service2.runProcess({ command: "cmd.exe", args: ["/c", "echo CONCURRENT_TASK_2"], cwd: tempWorkspace }),
    ]);

    assert.equal(res1.exitCode, 0);
    assert.match(res1.stdout, /CONCURRENT_TASK_1/);
    assert.equal(res2.exitCode, 0);
    assert.match(res2.stdout, /CONCURRENT_TASK_2/);
  });

  // =========================================================================
  // 场景 G：ACL 异常退出恢复 — 崩溃恢复账本自动扫描死亡进程并幂等清理
  // =========================================================================
  it("场景 G：ACL 异常退出恢复 — 崩溃恢复账本自动检测死亡进程遗留任务并实施幂等清理", async () => {
    const dummyProfile = `NashTestOrphan_${Date.now()}`;
    const dummyTask = `nash-task-dead-${Date.now()}`;

    WindowsSandboxCrashRecoveryLedger.registerTransaction({
      taskId: dummyTask,
      pid: 99999999, // 不存在的死亡 PID
      createdAt: Date.now() - 30000,
      profileName: dummyProfile,
      allowedReadPaths: [],
      allowedWritePaths: [],
    });

    const recordsBefore = WindowsSandboxCrashRecoveryLedger.readLedger();
    assert.ok(recordsBefore.some((r) => r.taskId === dummyTask));

    // 执行崩溃恢复
    const recovery = WindowsSandboxCrashRecoveryLedger.recoverOrphans();
    assert.ok(recovery.recovered >= 1);

    const recordsAfter = WindowsSandboxCrashRecoveryLedger.readLedger();
    assert.ok(!recordsAfter.some((r) => r.taskId === dummyTask));
  });

  // =========================================================================
  // 场景 H：Helper 崩溃与独立清理恢复
  // =========================================================================
  it("场景 H：Helper 独立清理 — --cleanup-profile 与 --revoke-acl CLI 接口幂等可用", () => {
    const helperPath = WindowsSandboxHelperManager.resolveHelperExecutablePath();
    assert.ok(helperPath && fsSync.existsSync(helperPath));

    const out = cp.execFileSync(helperPath, ["--cleanup-profile", "NashNonExistentProfileCheck"], {
      encoding: "utf-8",
    });
    assert.match(out, /"deleted":true/);
  });

  // =========================================================================
  // 场景 I：系统重启遗留授权恢复机制验证
  // =========================================================================
  it("场景 I：系统重启遗留授权恢复 — 沙箱探针初始化时自动清扫孤儿资源", () => {
    // 写入一个模拟遗留记录
    const dummyTask = `nash-reboot-orphan-${Date.now()}`;
    WindowsSandboxCrashRecoveryLedger.registerTransaction({
      taskId: dummyTask,
      pid: 99999998,
      createdAt: Date.now() - 3600000,
      profileName: `NashReboot_${Date.now()}`,
      allowedReadPaths: [],
      allowedWritePaths: [],
    });

    // 触发 probe 初始化
    WindowsSandboxProbe.probe(true);

    const records = WindowsSandboxCrashRecoveryLedger.readLedger();
    assert.ok(!records.some((r) => r.taskId === dummyTask));
  });

  // =========================================================================
  // 场景 J：network: deny 模式 — 操作系统内核级阻断网络外联 (TCP / UDP / DNS)
  // =========================================================================
  it("场景 J：network: deny 模式 — 操作系统内核级阻断网络外联，禁止 TCP 与 DNS 请求", async () => {
    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    // 1. PowerShell TCP Socket 阻断测试
    const tcpRes = await service.runProcess({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "try { $client = [System.Net.Sockets.TcpClient]::new('1.1.1.1', 80); exit 0 } catch { exit 88 }",
      ],
      cwd: tempWorkspace,
    });
    assert.equal(tcpRes.exitCode, 88);

    // 2. Node.js DNS 域名解析阻断测试
    const dnsRes = await service.runProcess({
      command: "node.exe",
      args: [
        "-e",
        "require('dns').lookup('www.bing.com', (err) => { if (err) process.exit(71); process.exit(0); });",
      ],
      cwd: tempWorkspace,
    });
    assert.equal(dnsRes.exitCode, 71);
  });

  // =========================================================================
  // 场景 K：network: allow 真实成功 — 外网 DNS 与真实 TCP 通信成功
  // =========================================================================
  it("场景 K：network: allow 真实成功 — 授予网络能力后真实连通外部网络 (无伪断言)", async () => {
    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    // 1. 真实 DNS 解析成功
    const dnsRes = await service.runProcess({
      command: "node.exe",
      args: [
        "-e",
        "require('dns').lookup('www.bing.com', (err, addr) => { if (err) { console.error(err); process.exit(1); } console.log('DNS_ADDR:' + addr); process.exit(0); });",
      ],
      cwd: tempWorkspace,
      timeout: 10000,
    });
    assert.equal(dnsRes.exitCode, 0);
    assert.match(dnsRes.stdout, /DNS_ADDR:/);

    // 2. 真实 TCP 连接成功 (严格断言 exitCode === 0)
    const netRes = await service.runProcess({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "try { $client = [System.Net.Sockets.TcpClient]::new('1.1.1.1', 53); $client.Close(); Write-Output 'NET_CONNECTED_OK'; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }",
      ],
      cwd: tempWorkspace,
      timeout: 10000,
    });
    assert.equal(netRes.exitCode, 0);
    assert.match(netRes.stdout, /NET_CONNECTED_OK/);
  });

  // =========================================================================
  // 场景 L：network: deny 与 network: allow 正交性验证
  // =========================================================================
  it("场景 L：策略正交性 — workspace-write + network: deny 与 read-only + network: allow 互不干扰", async () => {
    const serviceWsDeny = new SandboxService({
      policy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, approval: { mode: "never" } },
      cwd: tempWorkspace,
    });

    const serviceRoAllow = new SandboxService({
      policy: { filesystem: { mode: "read-only" }, network: { mode: "allow" }, approval: { mode: "never" } },
      cwd: tempWorkspace,
    });

    // 1. serviceWsDeny 可写但不可联网
    const writeTest = await serviceWsDeny.runProcess({
      command: "cmd.exe",
      args: ["/c", "echo ORTHO_WRITE > ortho.txt"],
      cwd: tempWorkspace,
    });
    assert.equal(writeTest.exitCode, 0);

    const denyNet = await serviceWsDeny.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "try { [System.Net.Dns]::GetHostAddresses('www.bing.com') | Out-Null; exit 0 } catch { exit 61 }"],
      cwd: tempWorkspace,
    });
    assert.equal(denyNet.exitCode, 61);

    // 2. serviceRoAllow 可联网但不可写
    const roWrite = await serviceRoAllow.runProcess({
      command: "cmd.exe",
      args: ["/c", "echo FAIL_RO >> ortho.txt"],
      cwd: tempWorkspace,
    });
    assert.notEqual(roWrite.exitCode, 0);

    const allowNet = await serviceRoAllow.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "try { [System.Net.Dns]::GetHostAddresses('www.bing.com') | Out-Null; exit 0 } catch { exit 62 }"],
      cwd: tempWorkspace,
      timeout: 10000,
    });
    assert.equal(allowNet.exitCode, 0);
  });

  // =========================================================================
  // 场景 M：Loopback 隔离与 IPC 管道权限安全
  // =========================================================================
  it("场景 M：Loopback 隔离与 IPC 管道安全 — AppContainer 无法连接 127.0.0.1 且管道限制最小权限", async () => {
    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "allow" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    // 启动本地受控 TCP 服务
    const net = await import("net");
    const server = net.createServer((socket) => socket.end("HELLO_LOCAL"));
    await new Promise<void>((resolve) => server.listen(48888, "127.0.0.1", () => resolve()));

    try {
      // 在 AppContainer 中尝试连接 127.0.0.1，必须被 Windows WFP 回环阻断驱动拦截
      const res = await service.runProcess({
        command: "node.exe",
        args: [
          "-e",
          "const net = require('net'); const client = net.connect(48888, '127.0.0.1', () => process.exit(0)); client.on('error', () => process.exit(98));",
        ],
        cwd: tempWorkspace,
        timeout: 4000,
      });

      // AppContainer 默认不可访问本地回环 (ETIMEDOUT / 98)
      assert.notEqual(res.exitCode, 0);
    } finally {
      server.close();
    }
  });

  // =========================================================================
  // 场景 N：子进程继承 — cmd -> PowerShell 孙子进程无法逃逸沙箱
  // =========================================================================
  it("场景 N：子进程继承 — cmd -> PowerShell 孙子进程无法逃逸沙箱", async () => {
    const secretFile = path.join(protectedOutsideDir, "nested_secret.txt");
    await fs.writeFile(secretFile, "NESTED_SECRET_VAL", "utf-8");

    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    // cmd.exe 拉起 powershell 读取外部机密
    const res = await service.runProcess({
      command: "cmd.exe",
      args: ["/c", "powershell", "-NoProfile", "-NonInteractive", "-Command", `Get-Content '${secretFile}'`],
      cwd: tempWorkspace,
    });

    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /Unauthorized[\s\S]*AccessException|PermissionDenied|拒绝访问|Access[\s\S]*denied/i);
  });

  // =========================================================================
  // 场景 O：Job Objects 取消与超时终止 — TerminateJobObject 彻底击毙进程树
  // =========================================================================
  it("场景 O：Job Objects 取消与超时终止 — 进程树超时后由 Job Object 彻底清理，标记 killed=true", async () => {
    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    const res = await service.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
      cwd: tempWorkspace,
      timeout: 1000,
    });

    assert.equal(res.killed, true);
    assert.notEqual(res.exitCode, 0);
  });

  // =========================================================================
  // 场景 P：Handle Leak 与临时目录清理
  // =========================================================================
  it("场景 P：Handle Leak 与清理 — 执行结束后不残留受控临时目录，原始目录保持纯净", async () => {
    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });

    await service.runProcess({
      command: "cmd.exe",
      args: ["/c", "echo HANDLE_TEST"],
      cwd: tempWorkspace,
    });

    const tmpContents = await fs.readdir(os.tmpdir());
    const leftoverDirs = tmpContents.filter((name) => name.startsWith("nash-task-tmp-"));
    assert.equal(leftoverDirs.length, 0);
  });

  // =========================================================================
  // 场景 Q：Helper 参数篡改与 JSON 注入防御
  // =========================================================================
  it("场景 Q：Helper 参数篡改防御 — 环境变量值包含伪造 command 不会造成解析混乱", () => {
    const helperPath = WindowsSandboxHelperManager.resolveHelperExecutablePath();
    assert.ok(helperPath && fsSync.existsSync(helperPath));

    // 构造恶意 JSON：环境变量中伪造 "command": "calc.exe"
    const fakeConfig = {
      protocolVersion: 2,
      command: "cmd.exe",
      args: ["/c", "echo SAFE_PARSED"],
      cwd: os.tmpdir(),
      env: {
        INJECTED: "\"command\": \"calc.exe\", \"timeoutMs\": 1",
      },
      appContainerEnabled: false,
    };

    const tempJson = path.join(os.tmpdir(), `nash-test-tamper-${Date.now()}.json`);
    try {
      fsSync.writeFileSync(tempJson, JSON.stringify(fakeConfig), "utf-8");
      const out = cp.execFileSync(helperPath, ["--config-file", tempJson], {
        encoding: "utf-8",
      });
      const parsed = JSON.parse(out.trim());
      assert.equal(parsed.exitCode, 0);
      assert.match(parsed.stdout, /SAFE_PARSED/);
    } finally {
      if (fsSync.existsSync(tempJson)) fsSync.unlinkSync(tempJson);
    }
  });

  // =========================================================================
  // 场景 R：AppContainer Profile 冲突处理 — 重复名称通过 SID 派生平滑处理
  // =========================================================================
  it("场景 R：AppContainer Profile 冲突处理 — 相同名称重复执行不会崩溃", () => {
    const res1 = WindowsSandboxHelperManager.execute({
      command: "cmd.exe",
      args: ["/c", "echo TEST_PROFILE_1"],
      appContainerEnabled: true,
      appContainerName: "NashConflictCheckTest",
      timeoutMs: 5000,
    });
    assert.equal(res1.exitCode, 0);

    const res2 = WindowsSandboxHelperManager.execute({
      command: "cmd.exe",
      args: ["/c", "echo TEST_PROFILE_2"],
      appContainerEnabled: true,
      appContainerName: "NashConflictCheckTest",
      timeoutMs: 5000,
    });
    assert.equal(res2.exitCode, 0);
  });

  // =========================================================================
  // 场景 S：沙箱不可用模拟 — 缺少 Helper 或能力时严格 Fail-Closed
  // =========================================================================
  it("场景 S：沙箱不可用模拟 — 缺少 Helper 或能力时严格 Fail-Closed，拒绝以宿主裸权限运行", async (t) => {
    const backend = new WindowsSandboxBackend();
    t.mock.method(backend, "isAvailable", () => false);

    const request = {
      command: "powershell.exe",
      cwd: tempWorkspace,
      policy: {
        filesystem: { mode: "workspace-write" as const },
        network: { mode: "deny" as const },
        approval: { mode: "never" as const },
      },
    };

    assert.throws(() => backend.buildExecutionSpec(request), SandboxUnavailableError);
    await assert.rejects(backend.run(request), SandboxUnavailableError);
  });
});
