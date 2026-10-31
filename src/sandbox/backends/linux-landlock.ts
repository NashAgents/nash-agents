import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type {
  SandboxBackend,
  SandboxBackendCapabilities,
  SandboxExecutionSpec,
  SandboxProcessRequest,
  SandboxProcessResult,
} from "./sandbox-backend.js";
import { buildSandboxEnvironment } from "../environment.js";
import { SandboxUnavailableError } from "../errors.js";
import { LinuxSandboxProbe } from "../linux/capability-probe.js";
import {
  resolveCanonicalPath,
  canonicalizeWriteScopes,
} from "../linux/path-utils.js";
import {
  LinuxSandboxHelperManager,
  type LinuxSandboxHelperConfig,
} from "../linux/sandbox-helper.js";
import { ResourceController, type ResourceLimits } from "../linux/resource-controller.js";

export interface LinuxLandlockOptions {
  /**
   * 受控临时工作目录
   */
  controlledTempDir?: string;

  /**
   * 资源限制 (cgroup v2)
   */
  resourceLimits?: ResourceLimits;
}

/**
 * Linux 原生 Landlock LSM 沙箱执行后端
 *
 * 当宿主环境未安装 Bubblewrap 或未启用 unprivileged user namespace 时，
 * 本后端作为 Linux 原生内核 LSM 安全回退保障。
 *
 * 核心安全机制：
 * 1. 原生 Landlock LSM 规则：/ 根目录只读，仅工作区或 scopedWritePaths 允许写入；
 * 2. 联动 LinuxSandboxHelper 安装 Targeted Seccomp 拦截高危 syscall；
 * 3. 针对 network: deny，利用 Seccomp 拦截 AF_INET/AF_INET6 socket，保留 AF_UNIX 本地 IPC；
 * 4. 强制启用 no_new_privs；
 * 5. 进程组生命周期治理与可选 cgroup v2 配额。
 */
export class LinuxLandlockBackend implements SandboxBackend {
  readonly name = "linux-landlock";
  private readonly controlledTempDir?: string;
  private readonly resourceLimits?: ResourceLimits;

  constructor(options?: LinuxLandlockOptions) {
    this.controlledTempDir = options?.controlledTempDir;
    this.resourceLimits = options?.resourceLimits;
  }

  /**
   * 检查当前系统环境是否支持 Landlock 沙箱与 Helper
   */
  isAvailable(): boolean {
    if (process.platform !== "linux") {
      return false;
    }
    const probe = LinuxSandboxProbe.probe();
    return (
      probe.landlockAvailable &&
      probe.landlockAbi >= 3 &&
      probe.helperAvailable
    );
  }

  /**
   * 明确说明当前环境为何不可用：区分「内核无 Landlock」与「ABI 低于契约要求」，避免把版本不足误报成不支持。
   */
  private unavailableReason(): string {
    const probe = LinuxSandboxProbe.probe();
    if (!probe.landlockAvailable) {
      return "内核未启用 Landlock LSM";
    }
    if (probe.landlockAbi < 3) {
      return `Landlock ABI ${probe.landlockAbi} 低于要求的 ABI 3 (缺少 TRUNCATE 强制能力，需 Linux 6.2+)`;
    }
    if (!probe.helperAvailable) {
      return "Native Helper 不可用";
    }
    return "未知原因";
  }

  /**
   * 获取沙箱后端的能力指示
   */
  getCapabilities(): SandboxBackendCapabilities {
    const probe = LinuxSandboxProbe.probe();
    // 依赖 Helper 的 seccomp socket 过滤实现 network isolation
    const networkIsolation = probe.seccompSupported && probe.helperAvailable;

    return {
      filesystemIsolation: probe.landlockAvailable && probe.landlockAbi >= 3,
      networkIsolation,
      processIsolation: false, // Landlock 本身不提供 PID namespace，依赖 POSIX 进程组治理
      syscallFiltering: probe.seccompSupported,
      noNewPrivileges: probe.noNewPrivsSupported,
      unixSocketIsolation: false,
      resourceLimits: probe.cgroupV2Available && probe.cgroupDelegated,
    };
  }

  /**
   * 根据当前安全策略与请求，构建 Helper 配置
   */
  buildHelperConfig(request: SandboxProcessRequest): LinuxSandboxHelperConfig {
    const fsMode = request.policy.filesystem.mode;
    const isNetworkDeny = request.policy.network.mode === "deny";
    const canonicalCwd = resolveCanonicalPath(request.cwd);

    let landlockEnabled = false;
    const readOnlyPaths: string[] = [];
    const readWritePaths: string[] = [];

    if (fsMode === "danger-full-access") {
      landlockEnabled = false;
    } else {
      landlockEnabled = true;
      // 根目录只读
      readOnlyPaths.push("/");
      // Node opens this device when spawning a child with ignored stdio.
      // The helper verifies the opened inode is the real null character device.
      readWritePaths.push("/dev/null");

      if (fsMode === "workspace-write") {
        if (request.scopedWritePaths && request.scopedWritePaths.length > 0) {
          const validScopes = canonicalizeWriteScopes(
            canonicalCwd,
            request.scopedWritePaths
          );
          for (const s of validScopes) {
            readWritePaths.push(s);
          }
        } else {
          readWritePaths.push(canonicalCwd);
        }

        // 允许受控临时目录
        if (this.controlledTempDir) {
          const canonicalTemp = resolveCanonicalPath(this.controlledTempDir);
          if (fs.existsSync(canonicalTemp)) {
            readWritePaths.push(canonicalTemp);
          }
        }

        // 额外放行路径
        if (
          request.extraAllowedWritePaths &&
          request.extraAllowedWritePaths.length > 0
        ) {
          for (const extra of request.extraAllowedWritePaths) {
            const cExtra = resolveCanonicalPath(extra);
            if (fs.existsSync(cExtra)) {
              readWritePaths.push(cExtra);
            }
          }
        }

        // 默认允许 /tmp 写入 (保证编译运行临时文件)
        // 关键安全防线：若工作区自身位于 /tmp 下，绝对不能将父级 /tmp 设为 RW，否则会击穿 scopedWritePaths 或工作区限制
        if (!canonicalCwd.startsWith("/tmp") && !canonicalCwd.startsWith("/tmp/")) {
          readWritePaths.push("/tmp");
        }
      } else if (fsMode === "full-capability") {
        // Full Capability 模式：根目录只读防护，开发者工作区与用户目录赋予 RW 权限
        readWritePaths.push(canonicalCwd);
        const homedir = os.homedir();
        if (fs.existsSync(homedir)) {
          readWritePaths.push(homedir);
        }
        if (!canonicalCwd.startsWith("/tmp") && !canonicalCwd.startsWith("/tmp/")) {
          readWritePaths.push("/tmp");
        }
      } else if (fsMode === "read-only") {
        // read-only 模式：根目录已只读，不添加任何工作区读写路径，仅允许系统临时目录只读
      }
    }

    return {
      landlockEnabled,
      seccompEnabled: true,
      noNewPrivs: true,
      blockNetworkSockets: isNetworkDeny,
      readOnlyPaths,
      readWritePaths,
      command: request.command,
      args: request.args,
    };
  }

  /**
   * 将请求转换为底层可执行程序及完整启动规格
   */
  buildExecutionSpec(request: SandboxProcessRequest): SandboxExecutionSpec {
    if (!this.isAvailable()) {
      throw new SandboxUnavailableError(
        `Linux Landlock 沙箱后端不可用: ${this.unavailableReason()}。系统严格拒绝执行 (Fail-Closed)。`
      );
    }

    if (request.policy.network.mode === "deny" && !this.getCapabilities().networkIsolation) {
      throw new SandboxUnavailableError("Landlock cannot enforce network: deny (Fail-Closed)");
    }
    const cgroup = this.resourceLimits ? ResourceController.createCgroupSync("landlock", `job-${process.pid}-${crypto.randomUUID()}`, this.resourceLimits) : null;
    try {
      const helperConfig = this.buildHelperConfig(request);
      helperConfig.cgroupPath = cgroup?.cgroupPath;
      const helperSpec = LinuxSandboxHelperManager.buildExecutionArgs(helperConfig);
      return {
        executable: helperSpec.executable, args: helperSpec.args,
        cwd: resolveCanonicalPath(request.cwd), env: buildSandboxEnvironment(request.env),
        cleanup: () => { helperSpec.cleanup(); void cgroup?.cleanup().catch(() => {}); },
      };
    } catch (error) { void cgroup?.cleanup().catch(() => {}); throw error; }
  }

  /**
   * 在 Landlock LSM 与 Seccomp 约束下启动进程
   */
  async run(request: SandboxProcessRequest): Promise<SandboxProcessResult> {
    if (!this.isAvailable()) {
      throw new SandboxUnavailableError(
        `Linux Landlock 沙箱执行器不可用: ${this.unavailableReason()}。系统严格拒绝执行 (Fail-Closed)。`
      );
    }

    // 检查网络策略是否满足 (若要求 network: deny 但 seccomp 无法拦截 socket，则 fail closed)
    if (
      request.policy.network.mode === "deny" &&
      !this.getCapabilities().networkIsolation
    ) {
      throw new SandboxUnavailableError(
        "Linux Landlock 后端无法在当前环境下提供 network: deny 隔离保证 (缺少 Seccomp Socket 过滤能力)。系统严格拒绝执行 (Fail-Closed)。"
      );
    }

    const helperConfig = this.buildHelperConfig(request);
    const helperSpec = LinuxSandboxHelperManager.buildExecutionArgs(helperConfig);
    const sanitizedEnv = buildSandboxEnvironment(request.env);
    const targetCwd = resolveCanonicalPath(request.cwd);
    const timeout = request.timeout ?? 30_000;
    const maxBuffer = request.maxBuffer ?? 10 * 1024 * 1024;
    const killGraceMs = 2_000;

    let cgroupHandle: any = null;
    if (this.resourceLimits) {
      const randomJobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      cgroupHandle = await ResourceController.createCgroup(
        "landlock",
        randomJobId,
        this.resourceLimits
      );
    }

    return new Promise<SandboxProcessResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let exitCode = 0;
      let isSettled = false;
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const child = spawn(helperSpec.executable, helperSpec.args, {
        cwd: targetCwd,
        env: sanitizedEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (child.pid && cgroupHandle) {
        cgroupHandle.addProcess(child.pid).catch(() => {});
      }

      const cleanupTimers = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = undefined;
        }
      };

      const finish = async () => {
        if (isSettled) return;
        isSettled = true;
        cleanupTimers();

        helperSpec.cleanup();

        if (cgroupHandle) {
          try {
            await cgroupHandle.cleanup();
          } catch {}
        }

        resolve({
          stdout,
          stderr,
          exitCode,
          killed,
        });
      };

      if (timeout > 0) {
        timer = setTimeout(() => {
          killed = true;
          exitCode = 124;
          if (child.pid) {
            if (cgroupHandle) {
              cgroupHandle.kill().catch(() => {});
            }
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              try {
                child.kill("SIGTERM");
              } catch {}
            }

            graceTimer = setTimeout(() => {
              if (child.pid) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  try {
                    child.kill("SIGKILL");
                  } catch {}
                }
              }
            }, killGraceMs);
          }
        }, timeout);
      }

      if (child.stdout) {
        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          if (stdout.length < maxBuffer) {
            stdout += chunk;
          }
        });
      }

      if (child.stderr) {
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < maxBuffer) {
            stderr += chunk;
          }
        });
      }

      child.on("error", (err: Error) => {
        exitCode = 1;
        stderr += `\n${err.message}`;
        finish();
      });

      child.on("close", (code, signal) => {
        if (!killed) {
          exitCode = code ?? (signal ? 128 : 0);
        }
        finish();
      });
    });
  }
}
