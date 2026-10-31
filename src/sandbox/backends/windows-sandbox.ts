import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type {
  SandboxBackend,
  SandboxBackendCapabilities,
  SandboxExecutionSpec,
  SandboxProcessRequest,
  SandboxProcessResult,
} from "./sandbox-backend.js";
import { buildSandboxEnvironment } from "../environment.js";
import { SandboxUnavailableError, FilesystemAccessDeniedError } from "../errors.js";
import { WindowsSandboxProbe } from "../windows/capability-probe.js";
import { WindowsSandboxHelperManager } from "../windows/sandbox-helper.js";
import { WindowsSandboxCrashRecoveryLedger } from "../windows/recovery-ledger.js";
import type { WindowsSandboxHelperConfig } from "../windows/types.js";
import { resolveWindowsWriteScope } from "../windows/path-utils.js";

export interface WindowsSandboxOptions {
  controlledTempDir?: string;
  maxProcesses?: number;
  memoryLimitBytes?: number;
  cpuRateLimitPercent?: number;
  forceAppContainer?: boolean;
}

/**
 * Windows 原生安全沙箱后端 (WindowsSandboxBackend)
 *
 * 核心安全机制：
 * 1. Windows AppContainer 内核级进程、文件系统与网络强隔离：
 *    - 动态派生唯一 AppContainer Profile 与 SID；
 *    - 基于 Windows DACL 的受控工作区（Workspace）与读写子路径（scopedWritePaths）精准授权；
 *    - network: deny 模式下清空全部网络 Capabilities，内核级阻断 TCP/UDP/DNS/Loopback；
 *    - network: allow 模式下赋予受控网络能力 (internetClient / privateNetworkClientServer)；
 *    - 执行完毕（或超时强杀）后 100% 自动回滚撤销 ACE 并销毁 Profile，绝不污染宿主原始 ACL。
 * 2. Windows Job Objects 强进程生命周期治理：
 *    - 进程以挂起模式 (CREATE_SUSPENDED) 启动，在执行任何字节前加入 Job Object；
 *    - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 杜绝僵尸进程泄漏；
 *    - 支持最大活跃进程数限制 (防 Fork Bomb) 与 Job 内存配额控制；
 *    - 超时或取消时通过 TerminateJobObject 彻底击毙整个子孙进程树。
 * 3. Restricted Access Token & Integrity Levels：
 *    - DISABLE_MAX_PRIVILEGE 剥离管理员特权；
 *    - 杜绝 Agent 工具默认以提权管理员身份运行。
 * 4. 严格践行 Fail-Closed 铁律：
 *    - 若 AppContainer 或 Job Objects 无法满足策略要求，坚决拒绝降级为裸进程。
 */
export class WindowsSandboxBackend implements SandboxBackend {
  readonly name = "windows-sandbox";
  private readonly options: WindowsSandboxOptions;

  constructor(options?: WindowsSandboxOptions) {
    this.options = options ?? {};
  }

  /**
   * 探测当前 Windows 宿主环境沙箱是否可用
   */
  isAvailable(): boolean {
    if (process.platform !== "win32") {
      return false;
    }
    const probe = WindowsSandboxProbe.probe();
    return probe.helperAvailable && probe.jobObjectsAvailable;
  }

  /**
   * 获取沙箱后端能力指示
   */
  getCapabilities(): SandboxBackendCapabilities {
    if (process.platform !== "win32") {
      return {
        filesystemIsolation: false,
        networkIsolation: false,
        processIsolation: false,
        syscallFiltering: false,
        noNewPrivileges: false,
        resourceLimits: false,
      };
    }

    const probe = WindowsSandboxProbe.probe();
    const hasAppContainer =
      probe.helperAvailable &&
      probe.appContainerAvailable &&
      Boolean(probe.filesystemIsolationAvailable);

    return {
      filesystemIsolation: hasAppContainer,
      networkIsolation: hasAppContainer && Boolean(probe.networkIsolationAvailable),
      processIsolation: probe.jobObjectsAvailable,
      syscallFiltering: false,
      noNewPrivileges: hasAppContainer || probe.restrictedTokenAvailable,
      resourceLimits: probe.jobObjectsAvailable,
    };
  }

  /**
   * 构建底层可执行程序及沙箱执行规格
   */
  buildExecutionSpec(request: SandboxProcessRequest): SandboxExecutionSpec {
    const prepared = this.prepareExecution(request);
    const executable = WindowsSandboxHelperManager.resolveHelperExecutablePath();
    if (!executable) { prepared.cleanup(); throw new SandboxUnavailableError("Windows Helper missing"); }
    return {
      executable,
      args: ["--stream", "--config-json", JSON.stringify(prepared.config)],
      cwd: prepared.config.cwd!,
      env: prepared.config.env ?? {},
      cleanup: prepared.cleanup,
      // The direct helper owns the kill-on-close Job. Terminating it closes the
      // Job immediately; a separate taskkill process adds a cancellation race.
      terminate: (pid) => { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } },
    };
  }

  /**
   * 在 Windows AppContainer + Job Object 约束环境中执行进程
   */
  async run(request: SandboxProcessRequest): Promise<SandboxProcessResult> {
    const prepared = this.prepareExecution(request);
    try { return WindowsSandboxHelperManager.execute(prepared.config); }
    finally { prepared.cleanup(); }
  }

  private prepareExecution(request: SandboxProcessRequest): { config: WindowsSandboxHelperConfig; cleanup: () => void } {
    this.assertSupportedPolicy(request);
    if (!this.isAvailable()) {
      const probe = WindowsSandboxProbe.probe();
      throw new SandboxUnavailableError(
        `Windows 沙箱执行器不可用: ${probe.reason ?? "Job Objects 或 Native Helper 缺失 (Fail-Closed)。"}`
      );
    }

    const sanitizedEnv = buildSandboxEnvironment(request.env);
    const cwdResolved = path.resolve(request.cwd);
    const canonicalCwd = fs.existsSync(cwdResolved) ? fs.realpathSync.native(cwdResolved) : cwdResolved;
    const timeout = request.timeout ?? 30000;
    const maxBuffer = request.maxBuffer ?? 10 * 1024 * 1024;

    // 解析实际执行命令与参数
    let commandToRun = request.command;
    let argsToRun = request.args ?? [];

    // 若请求调用 "bash"，在 Windows 上解析实际可用的 shell
    if (commandToRun === "bash") {
      const probe = WindowsSandboxProbe.probe();
      if (probe.availableShells.powershell) {
        commandToRun = "powershell.exe";
        const commandFlag = argsToRun.findIndex((arg) => arg === "-c" || arg === "-lc");
        if (commandFlag < 0 || !argsToRun[commandFlag + 1]) throw new SandboxUnavailableError("Shell execution requires an explicit command argument");
        const script = argsToRun[commandFlag + 1];
        // Exact executable grants permit execution but intentionally do not permit PATH directory enumeration.
        argsToRun = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
          `$global:LASTEXITCODE = 0; $ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Utility,Microsoft.PowerShell.Management -ErrorAction Stop; Set-Alias -Name node -Value '${process.execPath.replaceAll("'", "''")}' -Scope Global; New-PSDrive -Name NashWorkspace -PSProvider FileSystem -Root '${canonicalCwd.replaceAll("'", "''")}' | Out-Null; Set-Location NashWorkspace:; ${script}; exit $global:LASTEXITCODE`];
      } else {
        throw new SandboxUnavailableError("Native Windows PowerShell is unavailable; an unverified POSIX/WSL shell cannot substitute (Fail-Closed)");
      }
    }

    const fsMode = request.policy.filesystem.mode;
    const netMode = request.policy.network.mode;
    const caps = this.getCapabilities();

    // 决定是否启用 AppContainer 隔离
    const useAppContainer =
      (fsMode === "read-only" ||
        fsMode === "workspace-write" ||
        netMode === "deny" ||
        Boolean(request.scopedWritePaths?.length) ||
        Boolean(this.options.forceAppContainer)) &&
      caps.filesystemIsolation;

    if (useAppContainer) WindowsSandboxHelperManager.assertArtifactMatchesManifest();
    const recovery = WindowsSandboxCrashRecoveryLedger.recoverOrphans();
    if (useAppContainer && recovery.warnings.length) {
      throw new SandboxUnavailableError(`Windows sandbox crash recovery incomplete (Fail-Closed): ${recovery.warnings.join("; ")}`);
    }

    const allowedReadPaths: string[] = [];
    const allowedWritePaths: string[] = [];
    let taskTempDir: string | undefined;
    const taskId = `nash-task-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const profileName = `NashSandbox_${process.pid}_${crypto.randomUUID()}`;

    if (useAppContainer) {
      const realCwd = canonicalCwd;

      // 优化 Node.js 在 AppContainer 下的符号链接遍历行为
      sanitizedEnv.NODE_PRESERVE_SYMLINKS = "1";
      sanitizedEnv.NODE_PRESERVE_SYMLINKS_MAIN = "1";

      if ((commandToRun === "node" || commandToRun === "node.exe") && argsToRun.length > 0) {
        if (!argsToRun[0].startsWith("-")) {
          const scriptCandidate = path.resolve(realCwd, argsToRun[0]);
          if (fs.existsSync(scriptCandidate)) {
            argsToRun[0] = scriptCandidate;
          }
        }
      }

      // 允许读取开发工具链所在根目录 (确保 Node.js / Git 依赖组件能被加载)
      const toolDirsToRead = this.resolveToolRuntimePaths(commandToRun, argsToRun);
      for (const td of toolDirsToRead) {
        if (!allowedReadPaths.includes(td)) {
          allowedReadPaths.push(td);
        }
      }

      if (fsMode === "read-only") {
        allowedReadPaths.push(realCwd);
      } else if (fsMode === "workspace-write") {
        if (request.scopedWritePaths?.length) {
          // scopedWritePaths: 整个工作区只读，仅指定合法子路径可写
          allowedReadPaths.push(realCwd);
          for (const sp of request.scopedWritePaths) {
            const resolvedSp = resolveWindowsWriteScope(sp, realCwd);
            // 物理真实路径防逃逸二次校验 (拦截 Junction 与符号链接跨越工作区)
            let realSp = resolvedSp;
            if (fs.existsSync(resolvedSp)) {
              realSp = fs.realpathSync.native(resolvedSp);
            } else {
              // 若文件尚未创建，校验其最近存在的祖先目录 realpath
              let parent = path.dirname(resolvedSp);
              while (!fs.existsSync(parent) && path.dirname(parent) !== parent) {
                parent = path.dirname(parent);
              }
              if (fs.existsSync(parent)) {
                const realParent = fs.realpathSync.native(parent);
                const relParent = path.relative(realCwd.toLowerCase(), realParent.toLowerCase());
                if (relParent.startsWith("..") || path.isAbsolute(relParent)) {
                  throw new FilesystemAccessDeniedError(sp, "write", `scopedWritePaths 禁止跨越或通过符号链接逃逸授权工作区: '${sp}'`);
                }
              }
            }

            const rel = path.relative(realCwd.toLowerCase(), realSp.toLowerCase());
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
              throw new FilesystemAccessDeniedError(sp, "write", `scopedWritePaths 禁止跨越或通过符号链接逃逸授权工作区: '${sp}'`);
            }

            if (!allowedWritePaths.includes(realSp)) {
              allowedWritePaths.push(realSp);
            }
          }
        } else {
          allowedWritePaths.push(realCwd);
        }
      }
    }

    // Windows PowerShell 5.1 inserts the machine-wide module directory when
    // PSModulePath contains the literal PSHOME\\Modules spelling. Scanning
    // unrelated machine modules can break or stall command discovery, including
    // outside AppContainer. The dot spelling selects the same system directory
    // without that insertion. Explicit caller module paths and pwsh are untouched.
    const hasExplicitModulePath = Object.keys(request.env ?? {}).some(key => key.toLowerCase() === "psmodulepath");
    const shellName = path.win32.basename(commandToRun).toLowerCase();
    const isWindowsPowerShell = shellName === "powershell" || shellName === "powershell.exe";
    const isCmdLaunchingWindowsPowerShell = (shellName === "cmd" || shellName === "cmd.exe") &&
      /(?:^|[\s"'\\/])powershell(?:\.exe)?(?=[\s"']|$)/i.test(argsToRun.join(" ")) &&
      !/(?:^|[\s"'\\/])pwsh(?:\.exe)?(?=[\s"']|$)/i.test(argsToRun.join(" "));
    const windowsRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (!hasExplicitModulePath && windowsRoot && (isWindowsPowerShell || isCmdLaunchingWindowsPowerShell)) {
      const psHome = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0");
      sanitizedEnv.PSModulePath = `${psHome}\\.\\Modules`;
    }

    if (useAppContainer) {
      // 为开发工具准备隔离的受控临时写目录
      taskTempDir = path.join(os.tmpdir(), `nash-task-tmp-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        fs.mkdirSync(taskTempDir, { recursive: true });
        taskTempDir = fs.realpathSync.native(taskTempDir);
        allowedWritePaths.push(taskTempDir);
        sanitizedEnv.TEMP = taskTempDir;
        sanitizedEnv.TMP = taskTempDir;
        // Windows PowerShell reads this at process startup. Its default points
        // into the host profile, which an AppContainer may not be able to use.
        // Keep the cache inside this task's already-authorized temporary tree.
        sanitizedEnv.PSModuleAnalysisCachePath = path.join(taskTempDir, "powershell-module-analysis.cache");
      } catch {}

    }

    const dropAdmin = fsMode === "read-only" || fsMode === "workspace-write" || useAppContainer;

    const config: WindowsSandboxHelperConfig = {
      command: commandToRun,
      args: argsToRun,
      cwd: canonicalCwd,
      env: sanitizedEnv,
      timeoutMs: timeout,
      maxBuffer,
      maxProcesses: this.options.maxProcesses,
      memoryLimitBytes: this.options.memoryLimitBytes,
      cpuRateLimitPercent: this.options.cpuRateLimitPercent,
      dropAdminPrivileges: dropAdmin,
      restrictedTokenEnabled: dropAdmin && !useAppContainer,
      appContainerEnabled: useAppContainer,
      appContainerName: useAppContainer ? profileName : undefined,
      networkAllow: netMode === "allow",
      allowedReadPaths: allowedReadPaths.length > 0 ? allowedReadPaths : undefined,
      allowedWritePaths: allowedWritePaths.length > 0 ? allowedWritePaths : undefined,
    };

    // 在崩溃恢复账本中注册本次任务事务
    if (useAppContainer) {
      try {
      const helper = WindowsSandboxHelperManager.resolveHelperExecutablePath()!;
      const sid = execFileSync(helper, ["--profile-sid", profileName], { encoding: "utf8", timeout: 3000 }).trim();
      if (!/^S-1-15-2-/.test(sid)) throw new SandboxUnavailableError("Cannot derive AppContainer recovery SID");
      WindowsSandboxCrashRecoveryLedger.registerTransaction({
          taskId,
          pid: process.pid,
          createdAt: Date.now(),
          profileName,
          sid,
          temporaryPaths: taskTempDir ? [taskTempDir] : [],
              allowedReadPaths,
          allowedWritePaths,
        });
      } catch (error) {
        if (taskTempDir) fs.rmSync(taskTempDir, { recursive: true, force: true });
        throw error;
      }
    }

    return { config, cleanup: () => {
      try { if (useAppContainer) WindowsSandboxCrashRecoveryLedger.completeTransaction(taskId); }
      finally { if (taskTempDir) fs.rmSync(taskTempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    }};
  }

  /**
   * 收集开发工具运行时依赖路径 (Node.js, Git 等)
   */
  private resolveToolRuntimePaths(command: string, args: string[]): string[] {
    const dirs: string[] = [];
    try {
      const nodeDir = path.dirname(process.execPath);
      const needsNpm = /(?:^|[\s"'\\/])npm(?:\.cmd)?(?=[\s"']|$)/i.test([command, ...args].join(" "));
      const nodeRuntime = needsNpm ? nodeDir : process.execPath;
      if (fs.existsSync(nodeRuntime)) dirs.push(nodeRuntime);
    } catch {}

    // Standard CPython installs require their adjacent DLLs and standard library.
    // Never authorize a volume root, user profile, or arbitrary PATH parent.
    const needsPython = /(?:^|[\s"'\\/])python(?:\d+(?:\.\d+)*)?(?:\.exe)?(?=[\s"']|$)/i.test([command, ...args].join(" "));
    try {
      const python = needsPython ? execFileSync("where.exe", ["python.exe"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0]?.trim() : undefined;
      if (python && fs.existsSync(python)) {
        const runtimeDir = path.dirname(fs.realpathSync(python));
        if (/^python\d[\w.-]*$/i.test(path.basename(runtimeDir)) && !dirs.includes(runtimeDir)) dirs.push(runtimeDir);
      }
    } catch { /* Python is optional; absence must not broaden another runtime directory. */ }

    const probe = WindowsSandboxProbe.probe();
    if (/^(git|bash)(\.exe)?$/i.test(path.basename(command)) && probe.availableShells.gitBashPath) {
      try {
        const gitBinDir = path.dirname(probe.availableShells.gitBashPath);
        if (fs.existsSync(gitBinDir)) dirs.push(gitBinDir);
        const gitRootDir = path.resolve(gitBinDir, "..");
        if (fs.existsSync(gitRootDir)) dirs.push(gitRootDir);
      } catch {}
    }

    return dirs;
  }

  /**
   * 策略支持检查 (严格遵循 Fail-Closed 原则)
   */
  private assertSupportedPolicy(request: SandboxProcessRequest): void {
    const caps = this.getCapabilities();
    const fsMode = request.policy.filesystem.mode;
    const netMode = request.policy.network.mode;

    if (fsMode === "full-capability") {
      throw new SandboxUnavailableError("Windows full-capability boundaries are not verified; select an explicit verified workspace policy (Fail-Closed)");
    }

    // 1. 若请求受限文件系统写入或只读，且无内核文件系统隔离支持
    if ((fsMode === "read-only" || fsMode === "workspace-write") && !caps.filesystemIsolation) {
      throw new SandboxUnavailableError(
        `Windows 原生沙箱未就绪：当前系统缺少 AppContainer/文件系统隔离能力，无法执行受限模式 '${fsMode}' (Fail-Closed)。受限执行请使用 WSL2。`
      );
    }

    // 2. 若请求网络阻断 (network: deny)，且无内核网络隔离支持
    if (netMode === "deny" && !caps.networkIsolation) {
      throw new SandboxUnavailableError(
        "Windows 原生沙箱未就绪：当前系统缺少 AppContainer 网络阻断能力，无法执行 network: deny (Fail-Closed)。受限执行请使用 WSL2。"
      );
    }

    // 3. 若指定了 scopedWritePaths 细粒度写隔离，且无内核文件系统隔离支持
    if (request.scopedWritePaths?.length && !caps.filesystemIsolation) {
      throw new SandboxUnavailableError(
        "Windows 原生沙箱未就绪：当前系统缺少 AppContainer 文件系统 ACL 能力，无法实施 scopedWritePaths 隔离 (Fail-Closed)。"
      );
    }
  }
}
