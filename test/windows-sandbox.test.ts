import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import cp from "node:child_process";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { WindowsSandboxBackend } from "../src/sandbox/backends/windows-sandbox.js";
import { WindowsSandboxHelperManager } from "../src/sandbox/windows/sandbox-helper.js";
import { WindowsSandboxProbe } from "../src/sandbox/windows/capability-probe.js";
import { WindowsSandboxDoctor } from "../src/sandbox/windows/doctor.js";
import { WindowsBackendSelector } from "../src/sandbox/windows/backend-selector.js";
import {
  isWindowsReservedDevice,
  hasAlternateDataStream,
  isInsideWorkspaceWindows,
  resolveCanonicalPhysicalPathWindows,
} from "../src/sandbox/windows/path-utils.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { resolveWorkspacePath } from "../src/tools/path-utils.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { SandboxUnavailableError, FilesystemAccessDeniedError } from "../src/sandbox/errors.js";

const processLifecyclePolicy = () => ({
  ...createDefaultSandboxPolicy(),
  filesystem: { mode: "danger-full-access" as const },
  network: { mode: "allow" as const },
});

describe("Windows process policy enforcement on every platform", () => {
  it("when filesystem isolation is unavailable, strictly rejects read-only and workspace-write before spawning (Fail-Closed)", async (t) => {
    let calls = 0;
    t.mock.method(WindowsSandboxHelperManager, "execute", () => { calls++; });
    const backend = new WindowsSandboxBackend();
    // 模拟底层缺少 filesystemIsolation 能力
    t.mock.method(backend, "getCapabilities", () => ({
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: true,
      syscallFiltering: false,
      noNewPrivileges: false,
      resourceLimits: true,
    }));

    for (const mode of ["read-only", "workspace-write"] as const) {
      const request = {
        command: process.execPath,
        cwd: process.cwd(),
        policy: { ...processLifecyclePolicy(), filesystem: { mode } },
      };
      assert.throws(() => backend.buildExecutionSpec(request), SandboxUnavailableError);
      await assert.rejects(backend.run(request), SandboxUnavailableError);
    }
    assert.equal(calls, 0);
  });

  it("when network isolation is unavailable, strictly rejects network deny (Fail-Closed)", async (t) => {
    const backend = new WindowsSandboxBackend();
    t.mock.method(backend, "getCapabilities", () => ({
      filesystemIsolation: true,
      networkIsolation: false,
      processIsolation: true,
      syscallFiltering: false,
      noNewPrivileges: true,
      resourceLimits: true,
    }));

    const request = {
      command: "node",
      cwd: process.cwd(),
      policy: { ...processLifecyclePolicy(), network: { mode: "deny" as const } },
    };
    assert.throws(() => backend.buildExecutionSpec(request), SandboxUnavailableError);
    await assert.rejects(backend.run(request), SandboxUnavailableError);
  });

  it("when filesystem isolation is unavailable, strictly rejects scopedWritePaths constraints", async (t) => {
    const backend = new WindowsSandboxBackend();
    t.mock.method(backend, "getCapabilities", () => ({
      filesystemIsolation: false,
      networkIsolation: true,
      processIsolation: true,
      syscallFiltering: false,
      noNewPrivileges: true,
      resourceLimits: true,
    }));

    const request = {
      command: "node",
      cwd: process.cwd(),
      policy: processLifecyclePolicy(),
      scopedWritePaths: [process.cwd()],
    };
    assert.throws(() => backend.buildExecutionSpec(request), SandboxUnavailableError);
    await assert.rejects(backend.run(request), SandboxUnavailableError);
  });

  it("does not return a bare command when the helper is unavailable", (t) => {
    const backend = new WindowsSandboxBackend();
    t.mock.method(backend, "isAvailable", () => false);
    assert.throws(() => backend.buildExecutionSpec({
      command: "node", cwd: process.cwd(), policy: processLifecyclePolicy(),
    }), SandboxUnavailableError);
  });
});

describe("Windows Native Sandbox & Process Lifecycle Tests", { skip: process.platform !== "win32" ? "Requires Windows platform" : false }, () => {
  let tempWorkspace: string;
  let outsideDir: string;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "nash-win-sb-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-win-out-"));
  });

  afterEach(async () => {
    try {
      if (fsSync.existsSync(tempWorkspace)) {
        await fs.rm(tempWorkspace, { recursive: true, force: true });
      }
      if (fsSync.existsSync(outsideDir)) {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // ==========================================
  // 1. 初始化、能力探测与平台选择
  // ==========================================
  describe("1. Probe & Selector", () => {
    it("正确探测 Windows 系统环境并成功与 Native Helper 进行版本握手", () => {
      const probe = WindowsSandboxProbe.probe(true);
      assert.equal(probe.isWindows, true);
      assert.ok(probe.buildNumber > 0);
      assert.equal(probe.helperAvailable, true);
      assert.equal(probe.jobObjectsAvailable, true);
      assert.equal(probe.restrictedTokenAvailable, true);
      assert.ok(probe.availableShells.powershell || probe.availableShells.cmd);
    });

    it("WindowsBackendSelector 正确选择 WindowsSandboxBackend", () => {
      const backend = WindowsBackendSelector.select();
      assert.equal(backend.name, "windows-sandbox");
      assert.equal(backend.isAvailable(), true);
      const caps = backend.getCapabilities?.();
      assert.equal(caps?.processIsolation, true);
      assert.equal(caps?.filesystemIsolation, true);
      assert.equal(caps?.networkIsolation, true);
      assert.equal(caps?.noNewPrivileges, true);
    });

    it("SandboxService 自动为 win32 注入 WindowsSandboxBackend", () => {
      const service = new SandboxService({ policy: createDefaultSandboxPolicy() });
      assert.equal(service.getBackend().name, "windows-sandbox");
      assert.equal(service.isAvailable(), true);
    });
  });

  // ==========================================
  // 2. Windows 真实进程执行与 Shell 工具
  // ==========================================
  describe("2. Process Execution via Job Objects", () => {
    it("在受控沙箱中执行 cmd.exe 命令", async () => {
      const service = new SandboxService({
        policy: processLifecyclePolicy(),
        cwd: tempWorkspace,
      });

      const res = await service.runProcess({
        command: "cmd.exe",
        args: ["/c", "echo WIN_SANDBOX_CMD_TEST"],
      });

      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /WIN_SANDBOX_CMD_TEST/);
    });

    it("在受控沙箱中执行 PowerShell 命令", async () => {
      const service = new SandboxService({
        policy: processLifecyclePolicy(),
        cwd: tempWorkspace,
      });

      const res = await service.runProcess({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'POWERSHELL_SUCCESS'"],
      });

      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /POWERSHELL_SUCCESS/);
    });

    it("在受控沙箱中执行 Node.js 并获取环境变量", async () => {
      const service = new SandboxService({
        policy: processLifecyclePolicy(),
        cwd: tempWorkspace,
      });

      const res = await service.runProcess({
        command: "node.exe",
        args: ["-e", "console.log(process.env.NASH_TEST_VAR)"],
        env: { NASH_TEST_VAR: "SECRET_CLEAN_VAL" },
      });

      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /SECRET_CLEAN_VAL/);
    });

    it("敏感 API Key 自动脱敏隔离 (DEEPSEEK_API_KEY 绝不泄漏至子进程)", async () => {
      const service = new SandboxService({
        policy: processLifecyclePolicy(),
        cwd: tempWorkspace,
      });

      const res = await service.runProcess({
        command: "node.exe",
        args: ["-e", "console.log(process.env.DEEPSEEK_API_KEY || 'NOT_PRESENT')"],
        env: { DEEPSEEK_API_KEY: "sk-my-super-secret-key" },
      });

      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /NOT_PRESENT/);
      assert.doesNotMatch(res.stdout, /sk-my-super-secret-key/);
    });
  });

  // ==========================================
  // 3. 进程超时、取消与进程树强力终止
  // ==========================================
  describe("3. Process Tree Termination & Timeout", () => {
    it("超时命令由 Job Object 彻底终止，并标记 killed=true", async () => {
      const service = new SandboxService({
        policy: processLifecyclePolicy(),
        cwd: tempWorkspace,
      });

      const res = await service.runProcess({
        command: "node.exe",
        args: ["-e", "setTimeout(() => {}, 15000)"],
        timeout: 1000,
      });

      assert.equal(res.killed, true);
      assert.notEqual(res.exitCode, 0);
    });

    it("派生多层子进程树 (Parent -> Child -> Grandchild) 时由 Job Object 一并击毙，无孤儿泄漏", async () => {
      const helper = WindowsSandboxHelperManager.resolveHelperExecutablePath();
      assert.ok(helper);

      // PowerShell 启动一个耗时的后台子进程并睡眠
      const config = {
        protocolVersion: 1,
        command: "powershell.exe",
        args: ["-NoProfile", "-Command", "Start-Process cmd.exe -ArgumentList '/c timeout 30' -NoNewWindow; Start-Sleep 10"],
        timeoutMs: 1500,
      };

      const result = WindowsSandboxHelperManager.execute(config);
      assert.equal(result.killed, true);
    });
  });

  // ==========================================
  // 4. Windows 路径安全与防逃逸
  // ==========================================
  describe("4. Windows Filesystem Security & Anti-Traversal", () => {
    it("正确识别并拦截 Windows 保留设备名 (CON, PRN, AUX, NUL, COM1, LPT1)", () => {
      assert.equal(isWindowsReservedDevice("CON"), true);
      assert.equal(isWindowsReservedDevice("con.txt"), true);
      assert.equal(isWindowsReservedDevice("NUL"), true);
      assert.equal(isWindowsReservedDevice("nul.json"), true);
      assert.equal(isWindowsReservedDevice("C:\\Users\\test\\aux"), true);
      assert.equal(isWindowsReservedDevice("COM1"), true);
      assert.equal(isWindowsReservedDevice("LPT3.log"), true);
      assert.equal(isWindowsReservedDevice("normal_file.txt"), false);
      assert.equal(isWindowsReservedDevice("context.ts"), false);
    });

    it("正确识别并拦截 Windows Alternate Data Streams (ADS)", () => {
      assert.equal(hasAlternateDataStream("test.txt:hidden"), true);
      assert.equal(hasAlternateDataStream("C:\\Users\\test.txt::$DATA"), true);
      assert.equal(hasAlternateDataStream("C:\\Users\\normal.txt"), false);
      assert.equal(hasAlternateDataStream("D:\\file.ts"), false);
    });

    it("大小写不敏感物理路径判定 (C:\\ vs c:\\ 均能正确比对并拦截逃逸)", () => {
      const rootUpper = "C:\\Projects\\nash";
      const insideLower = "c:\\projects\\nash\\src\\index.ts";
      const outsideSibling = "c:\\projects\\nash-evil\\hack.ts";
      const outsideParent = "c:\\projects\\secret.txt";

      assert.equal(isInsideWorkspaceWindows(insideLower, rootUpper), true);
      assert.equal(isInsideWorkspaceWindows(outsideSibling, rootUpper), false);
      assert.equal(isInsideWorkspaceWindows(outsideParent, rootUpper), false);
    });

    it("FileSystemAccess 拦截向 Windows 保留设备名称写入", async () => {
      const fsAccess = new FileSystemAccess({
        policy: {
          filesystem: { mode: "workspace-write" },
          network: { mode: "deny" },
          approval: { mode: "never" },
        },
        workspaceRoot: tempWorkspace,
      });

      const writeTool = createWriteFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await writeTool.execute({
            path: "NUL.txt",
            content: "evil data",
          });
        },
        (err: Error) => {
          assert.match(err.message, /保留设备名称/);
          return true;
        }
      );
    });

    it("FileSystemAccess 拦截通过 ADS 语法注入隐藏流文件", async () => {
      const fsAccess = new FileSystemAccess({
        policy: {
          filesystem: { mode: "workspace-write" },
          network: { mode: "deny" },
          approval: { mode: "never" },
        },
        workspaceRoot: tempWorkspace,
      });

      const writeTool = createWriteFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await writeTool.execute({
            path: "sample.txt:hidden_stream",
            content: "hidden data",
          });
        },
        (err: Error) => {
          assert.match(err.message, /Alternate Data Streams/);
          return true;
        }
      );
    });

    it("FileSystemAccess 严格阻断读取操作系统敏感注册表文件 (SAM / SYSTEM)", async () => {
      const fsAccess = new FileSystemAccess({
        policy: {
          filesystem: { mode: "danger-full-access" },
          network: { mode: "deny" },
          approval: { mode: "never" },
        },
        workspaceRoot: tempWorkspace,
      });

      const readTool = createReadFileTool(fsAccess);

      await assert.rejects(
        async () => {
          await readTool.execute({
            path: "C:\\Windows\\System32\\config\\SAM",
          });
        },
        (err: Error) => {
          assert.match(err.message, /核心特权敏感文件/);
          return true;
        }
      );
    });

    it("resolveWorkspacePath 拒绝跨盘符逃逸与工作区外绝对路径", () => {
      const root = tempWorkspace;
      // 正常工作区内部路径
      const okPath = resolveWorkspacePath("src/index.ts", root);
      assert.ok(okPath.startsWith(path.resolve(root)));

      // 尝试访问工作区外路径
      assert.throws(
        () => {
          resolveWorkspacePath("../../outside.txt", root);
        },
        /工作区根目录之外/
      );

      // 尝试访问其他盘符 (如非当前盘的根路径)
      assert.throws(
        () => {
          const otherDrive = path.resolve(root).startsWith("C:") ? "D:\\outside" : "C:\\outside";
          resolveWorkspacePath(otherDrive, root);
        },
        /工作区根目录之外/
      );
    });
  });

  // ==========================================
  // 5. Pre-Tool Security Monitor Windows 兼容
  // ==========================================
  describe("5. Pre-Tool Security Monitor on Windows", () => {
    it("确定性硬拦截尝试提取 Windows SAM 敏感注册表配置的操作", async () => {
      const monitor = new PreToolSecurityMonitor({ enabled: true });

      const decision = await monitor.evaluateToolCall({
        toolName: "read_file",
        toolArgs: { path: "C:\\Windows\\System32\\config\\SAM" },
        rawArgs: '{"path":"C:\\\\Windows\\\\System32\\\\config\\\\SAM"}',
        argsFingerprint: "fp-sam",
        cwd: tempWorkspace,
        userAuthorizationContext: { userIntent: "Read files" },
        agentIdentity: { agentId: "main" },
      });

      assert.equal(decision.verdict, "BLOCK");
      assert.match(decision.reason, /特权文件/);
    });

    it("常规合法工作区代码读写操作免审快速放行 (Fast-Path 0ms)", async () => {
      const monitor = new PreToolSecurityMonitor({ enabled: true });
      const safeFile = path.join(tempWorkspace, "index.ts");
      await fs.writeFile(safeFile, "console.log('hello');", "utf-8");

      const decision = await monitor.evaluateToolCall({
        toolName: "read_file",
        toolArgs: { path: safeFile },
        rawArgs: JSON.stringify({ path: safeFile }),
        argsFingerprint: "fp-safe",
        cwd: tempWorkspace,
        userAuthorizationContext: { userIntent: "Read local source code" },
        agentIdentity: { agentId: "main" },
      });

      assert.equal(decision.verdict, "ALLOW");
    });
  });

  // ==========================================
  // 6. Fail-Closed 铁律验证
  // ==========================================
  describe("6. Fail-Closed Enforcement on Windows", () => {
    it("当沙箱被强制指定为不可用时，系统坚决拒绝运行裸进程并抛出 SandboxUnavailableError", async () => {
      const unavailableBackend = WindowsBackendSelector.select(undefined, {
        forceBackend: "unavailable",
      });

      const service = new SandboxService({
        backend: unavailableBackend,
        policy: createDefaultSandboxPolicy(),
        cwd: tempWorkspace,
      });

      await assert.rejects(
        async () => {
          await service.runProcess({
            command: "cmd.exe",
            args: ["/c", "echo should fail"],
          });
        },
        (err: Error) => {
          assert.ok(err instanceof SandboxUnavailableError);
          assert.match(err.message, /Fail-Closed/);
          return true;
        }
      );
    });
  });

  // ==========================================
  // 7. Windows Sandbox Doctor 综合自检
  // ==========================================
  describe("7. Windows Sandbox Doctor", () => {
    it("运行完整自检，返回 AVAILABLE 终态与完整能力矩阵", () => {
      const report = WindowsSandboxDoctor.runDiagnostics();
      assert.equal(report.platform, "win32");
      assert.equal(report.overallStatus, "Available");
      assert.ok(report.items.length >= 8);
      assert.ok(report.items.some((i) => i.name === "Windows Job Objects" && i.status === "OK"));
      assert.ok(report.items.some((i) => i.name === "Restricted Access Token" && i.status === "OK"));
      assert.ok(report.items.some((i) => i.name === "Native Sandbox Helper" && i.status === "OK"));
      assert.ok(report.items.some((i) => i.name === "AppContainer Process" && i.status === "OK"));
      assert.ok(report.items.some((i) => i.name === "Filesystem Read Boundary" && i.status === "OK"));
      assert.ok(report.items.some((i) => i.name === "Network Deny" && i.status === "OK"));
      // 子进程 stdio 管道能力必须被真实测得并如实呈现：OK（全局命名管道可用）或 WARNING（仅 LOCAL 命名空间可用）。
      const pipes = report.items.find((i) => i.name === "Piped Child Stdio");
      assert.ok(pipes, "doctor must report the AppContainer piped-child-stdio capability");
      assert.notEqual(pipes!.status, "FAILED");
      assert.match(pipes!.detail, /global=(OK|FAIL:\w+).*local=(OK|FAIL:\w+)/, "the item must carry real probe evidence, not a static claim");
    });
  });
});
