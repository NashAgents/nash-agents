import crypto from "node:crypto";
import { createNamespaceTerminator } from "../linux/process-tree.js";
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
import { LinuxSandboxHelperManager } from "../linux/sandbox-helper.js";
import { ResourceController, type ResourceLimits, type CgroupHandle } from "../linux/resource-controller.js";

export interface LinuxBubblewrapOptions {
  /**
   * 自定义 bwrap 可执行文件路径（默认由 LinuxSandboxProbe 自动发现）
   */
  executablePath?: string;

  /**
   * 受控临时工作目录路径
   */
  controlledTempDir?: string;

  /**
   * 是否启用 Seccomp 加固（默认根据 Helper 探测自动启用）
   */
  enableSeccomp?: boolean;

  /**
   * 资源配额限制 (cgroup v2)
   */
  resourceLimits?: ResourceLimits;
}

/**
 * Linux 原生 Bubblewrap (bwrap) 沙箱执行后端
 *
 * 核心安全机制：
 * 1. 严格使用 Linux Namespaces 隔离：mount, pid, ipc, uts, net；
 * 2. 显式剥离所有内核 capabilities (--cap-drop ALL)；
 * 3. 宿主根文件系统默认全量只读挂载 (--ro-bind / /)；
 * 4. 挂载独立 private tmpfs 至 /run 与 /tmp，隔绝宿主 Unix Socket (Docker, D-Bus)；
 * 5. 精确限制 scopedWritePaths，仅白名单子目录可写，未授权工作区范围保持只读；
 * 6. 内联 LinuxSandboxHelper 施加 no_new_privs 与 Targeted Seccomp 拦截；
 * 7. 统一进程组治理 (SIGTERM -> grace -> SIGKILL) 与可选 cgroup v2 配额。
 */
export class LinuxBubblewrapBackend implements SandboxBackend {
  readonly name = "linux-bubblewrap";
  private readonly configuredExecutablePath?: string;
  private readonly controlledTempDir?: string;
  private readonly enableSeccomp: boolean;
  private readonly resourceLimits?: ResourceLimits;

  constructor(options?: LinuxBubblewrapOptions) {
    this.configuredExecutablePath = options?.executablePath;
    this.controlledTempDir = options?.controlledTempDir;
    this.enableSeccomp = options?.enableSeccomp !== false;
    this.resourceLimits = options?.resourceLimits;
  }

  /**
   * 获取 bwrap 实际可执行文件路径
   */
  getExecutablePath(): string {
    if (this.configuredExecutablePath) {
      return this.configuredExecutablePath;
    }
    const probed = LinuxSandboxProbe.probe();
    return probed.executablePath ?? "/usr/bin/bwrap";
  }

  /**
   * 检查当前系统环境是否支持并可用 Linux Bubblewrap 沙箱
   */
  isAvailable(): boolean {
    if (process.platform !== "linux") {
      return false;
    }
    if (this.configuredExecutablePath) {
      try {
        return (
          fs.existsSync(this.configuredExecutablePath) &&
          fs.statSync(this.configuredExecutablePath).isFile()
        );
      } catch {
        return false;
      }
    }
    const probed = LinuxSandboxProbe.probe();
    return probed.bubblewrapUsable;
  }

  /**
   * 获取沙箱后端的能力指示
   */
  getCapabilities(): SandboxBackendCapabilities {
    const probed = LinuxSandboxProbe.probe();
    return {
      filesystemIsolation: true,
      networkIsolation: probed.networkNamespaceUsable,
      processIsolation: true,
      syscallFiltering: probed.seccompSupported,
      noNewPrivileges: probed.noNewPrivsSupported,
      unixSocketIsolation: true,
      resourceLimits: probed.cgroupV2Available && probed.cgroupDelegated,
    };
  }

  /**
   * 根据当前安全策略与请求参数，构建 bwrap 命令行参数数组
   */
  generateBwrapArgs(
    request: SandboxProcessRequest,
    targetCommand?: { command: string; args?: string[]; helperExecutable?: string }
  ): string[] {
    const cmd = targetCommand?.command ?? request.command;
    const cmdArgs = targetCommand?.args ?? request.args ?? [];

    // run() and ProcessJob already spawn detached. A second setsid inside bwrap
    // separates the namespace init from the process group used for cancellation.
    const args: string[] = [
      "--die-with-parent",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--cap-drop",
      "ALL",
    ];

    // 1. 网络维度隔离规则（与文件系统解耦）
    if (request.policy.network.mode === "deny") {
      args.push("--unshare-net");
    }

    // 2. 基础系统与设备挂载
    const fsMode = request.policy.filesystem.mode;

    if (fsMode === "danger-full-access") {
      // 显式高权限模式：全盘可写绑定挂载
      args.push("--bind", "/", "/");
      args.push("--dev", "/dev");
      args.push("--proc", "/proc");
    } else {
      // 默认全盘只读挂载
      args.push("--ro-bind", "/", "/");
      args.push("--dev", "/dev");
      args.push("--proc", "/proc");

      // 私有 tmpfs 挂载：隔绝宿主 /tmp 并满足工具临时文件写需求
      args.push("--tmpfs", "/tmp");
      const workspace = resolveCanonicalPath(request.cwd);
      if (workspace === "/tmp" || workspace.startsWith("/tmp/")) args.push("--ro-bind", workspace, workspace);

      // 私有 tmpfs 挂载：隔绝宿主 /run 与 /var/run 中的特权 Unix Domain Socket (如 docker.sock, dbus 等)
      args.push("--tmpfs", "/run");
      try {
        if (fs.existsSync("/var/run") && !fs.lstatSync("/var/run").isSymbolicLink()) {
          args.push("--tmpfs", "/var/run");
        }
      } catch {}

      // 保留 DNS 必需的静态 stub-resolv.conf 纯文本解析文件（绝不暴露任何 unix domain socket）
      try {
        const stubResolv = "/run/systemd/resolve/stub-resolv.conf";
        if (fs.existsSync(stubResolv)) {
          args.push("--dir", "/run/systemd/resolve");
          args.push("--ro-bind", stubResolv, stubResolv);
        }
      } catch {}

      if (fsMode === "workspace-write") {
        const canonicalCwd = resolveCanonicalPath(request.cwd);
        const pathsToBind = new Set<string>();

        if (request.scopedWritePaths && request.scopedWritePaths.length > 0) {
          // 精确白名单限制：规范化并去重
          const validScopes = canonicalizeWriteScopes(
            canonicalCwd,
            request.scopedWritePaths
          );
          for (const s of validScopes) {
            pathsToBind.add(s);
          }
        } else {
          // 默认允许整个当前工作区目录写
          if (fs.existsSync(canonicalCwd)) {
            pathsToBind.add(canonicalCwd);
          }
        }

        // 受控临时工作目录
        if (this.controlledTempDir) {
          const canonicalTemp = resolveCanonicalPath(this.controlledTempDir);
          if (fs.existsSync(canonicalTemp)) {
            pathsToBind.add(canonicalTemp);
          }
        }

        // 允许通过用户审批临时单次放行的路径
        if (
          request.extraAllowedWritePaths &&
          request.extraAllowedWritePaths.length > 0
        ) {
          for (const extraPath of request.extraAllowedWritePaths) {
            const canonicalExtra = resolveCanonicalPath(extraPath);
            if (fs.existsSync(canonicalExtra)) {
              pathsToBind.add(canonicalExtra);
            }
          }
        }

        for (const targetPath of pathsToBind) {
          args.push("--bind", targetPath, targetPath);
        }
      } else if (fsMode === "full-capability") {
        // Full Capability 模式：保持 OS 根系统只读防护，用户目录与开发工作区支持写操作
        const canonicalCwd = resolveCanonicalPath(request.cwd);
        if (fs.existsSync(canonicalCwd)) {
          args.push("--bind", canonicalCwd, canonicalCwd);
        }
        const homedir = os.homedir();
        if (fs.existsSync(homedir)) {
          args.push("--bind", homedir, homedir);
        }
        if (this.controlledTempDir && fs.existsSync(this.controlledTempDir)) {
          args.push("--bind", this.controlledTempDir, this.controlledTempDir);
        }
      } else if (fsMode === "read-only") {
        // read-only 模式：全盘保持只读
        const canonicalCwd = resolveCanonicalPath(request.cwd);
        if (fs.existsSync(canonicalCwd)) {
          args.push("--ro-bind", canonicalCwd, canonicalCwd);
        }
      }
    }

    // The private tmpfs mounts hide helpers installed under these directories.
    // Expose only the already selected executable, never its containing directory.
    const helper = targetCommand?.helperExecutable;
    if (fsMode !== "danger-full-access" && helper && ["/tmp/", "/run/", "/var/run/"].some(prefix => helper.startsWith(prefix))) {
      args.push("--ro-bind", helper, helper);
    }

    // 3. 子进程工作目录切换 (canonical cwd)
    const targetCwd = resolveCanonicalPath(request.cwd);
    args.push("--chdir", targetCwd);

    // 4. 追加待执行命令与参数（使用 -- 终止 bwrap 参数解析）
    args.push("--", cmd);
    if (cmdArgs.length > 0) {
      args.push(...cmdArgs);
    }

    return args;
  }

  /**
   * 将请求转换为底层可执行程序及完整启动规格
   */
  buildExecutionSpec(request: SandboxProcessRequest): SandboxExecutionSpec {
    const executable = this.getExecutablePath();
    const sanitizedEnv = buildSandboxEnvironment(request.env);

    // 检查是否可以使用 Native Helper 来应用 no_new_privs 与 seccomp
    let innerCommand = request.command;
    let innerArgs = request.args ?? [];
    let helperExecutable: string | undefined;
    let cleanupHelperConfig: (() => void) | undefined;

    if (this.enableSeccomp && LinuxSandboxHelperManager.isAvailable()) {
      try {
        const helperSpec = LinuxSandboxHelperManager.buildExecutionArgs({
          command: request.command,
          args: request.args,
          seccompEnabled: true,
          noNewPrivs: true,
          blockNetworkSockets: request.policy.network.mode === "deny",
        });
        helperExecutable = fs.realpathSync(helperSpec.executable);
        innerCommand = helperExecutable;
        innerArgs = helperSpec.args;
        cleanupHelperConfig = helperSpec.cleanup;
      } catch (error) {
        throw new SandboxUnavailableError(`无法构建 Seccomp 启动规格: ${String(error)}`);
      }
    }

    let cgroup: CgroupHandle | null = null;
    try {
      const args = this.generateBwrapArgs(request, { command: innerCommand, args: innerArgs, helperExecutable });
      const canonicalCwd = resolveCanonicalPath(request.cwd);
      cgroup = this.resourceLimits ? ResourceController.createCgroupSync("bubblewrap", `job-${process.pid}-${crypto.randomUUID()}`, this.resourceLimits) : null;
      // The outer helper joins the cgroup before bwrap or any target code starts.
      const wrapper = cgroup ? LinuxSandboxHelperManager.buildExecutionArgs({
        command: executable, args, cgroupPath: cgroup.cgroupPath,
        noNewPrivs: true, seccompEnabled: false, landlockEnabled: false,
      }) : undefined;
      return {
        executable: wrapper?.executable ?? executable,
        args: wrapper?.args ?? args,
        terminate: createNamespaceTerminator(executable),
        cleanup: () => { cleanupHelperConfig?.(); wrapper?.cleanup(); void cgroup?.cleanup().catch(() => {}); },
        cwd: canonicalCwd,
        env: sanitizedEnv,
      };
    } catch (error) { cleanupHelperConfig?.(); void cgroup?.cleanup().catch(() => {}); throw error; }
  }

  /**
   * 在 Bubblewrap 沙箱约束下启动子进程并等待执行结束
   */
  async run(request: SandboxProcessRequest): Promise<SandboxProcessResult> {
    if (!this.isAvailable()) {
      const probe = LinuxSandboxProbe.probe();
      const reason = probe.reason ?? "Bubblewrap 沙箱在当前平台不可用。";
      throw new SandboxUnavailableError(
        `Linux Bubblewrap 沙箱执行器不可用: ${reason}`
      );
    }

    const spec = this.buildExecutionSpec(request);
    const bwrapArgs = spec.args;
    const executable = spec.executable;
    const sanitizedEnv = spec.env;
    const targetCwd = spec.cwd;
    const timeout = request.timeout ?? 30_000;
    const maxBuffer = request.maxBuffer ?? 10 * 1024 * 1024;
    const killGraceMs = 2_000;
    const cleanupHelperConfig = spec.cleanup;
    return new Promise<SandboxProcessResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let exitCode = 0;
      let isSettled = false;
      let timer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const child = spawn(executable, bwrapArgs, {
        cwd: targetCwd,
        env: sanitizedEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

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

        if (cleanupHelperConfig) {
          cleanupHelperConfig();
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
            try {
              spec.terminate?.(child.pid, "SIGTERM");
            } catch {
              try {
                child.kill("SIGTERM");
              } catch {}
            }

            graceTimer = setTimeout(() => {
              if (child.pid) {
                try {
                  spec.terminate?.(child.pid, "SIGKILL");
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
