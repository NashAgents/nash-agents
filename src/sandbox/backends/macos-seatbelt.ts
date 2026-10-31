import { resolveCanonicalPhysicalPath } from "../../filesystem/file-lock-manager.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type {
  SandboxBackend,
  SandboxBackendCapabilities,
  SandboxExecutionSpec,
  SandboxProcessRequest,
  SandboxProcessResult,
} from "./sandbox-backend.js";
import { buildSandboxEnvironment } from "../environment.js";
import { FilesystemAccessDeniedError, SandboxUnavailableError } from "../errors.js";

/**
 * 解析并获取路径的规范化真实物理路径（自动处理 macOS 下 /tmp -> /private/tmp 等软链接）
 */
function resolveCanonicalPath(rawPath: string): string {
  return resolveCanonicalPhysicalPath(rawPath);
}

/**
 * 转义 Seatbelt Scheme 字符串中的特殊字符
 */
function escapeSchemeString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface MacOsSeatbeltOptions {
  /**
   * 自定义 sandbox-exec 可执行文件路径，默认为 /usr/bin/sandbox-exec
   */
  executablePath?: string;

  /**
   * 受控临时工作目录路径
   */
  controlledTempDir?: string;
}

/**
 * macOS 原生 Seatbelt (sandbox-exec) 沙箱执行后端
 */
export class MacOsSeatbeltBackend implements SandboxBackend {
  readonly name = "macos-seatbelt";
  private readonly executablePath: string;
  private readonly controlledTempDir?: string;

  constructor(options?: MacOsSeatbeltOptions) {
    this.executablePath = options?.executablePath ?? "/usr/bin/sandbox-exec";
    this.controlledTempDir = options?.controlledTempDir;
  }

  /**
   * 检查当前系统环境是否支持 macOS Seatbelt 沙箱
   */
  isAvailable(): boolean {
    if (process.platform !== "darwin") {
      return false;
    }
    try {
      return (
        fs.existsSync(this.executablePath) &&
        fs.statSync(this.executablePath).isFile()
      );
    } catch {
      return false;
    }
  }

  /**
   * 根据当前安全策略动态生成 macOS Seatbelt Scheme 策略配置
   */
  generateProfile(request: SandboxProcessRequest): string {
    const rules: string[] = [];

    rules.push("(version 1)");
    rules.push("(allow default)");

    // 1. 网络维度限制（完全独立于文件系统策略）
    if (request.policy.network.mode === "deny") {
      rules.push("(deny network*)");
    }

    // 2. 文件系统维度限制
    const fsMode = request.policy.filesystem.mode;

    if (fsMode === "danger-full-access") {
      // 显式高权限模式，不添加任何 file-write 阻断规则
    } else if (fsMode === "full-capability") {
      // Full Capability 模式：保留操作系统底层系统核心目录只读防护，常规用户目录与工作区放行
      rules.push(
        "(deny file-write*\n" +
          '  (subpath "/System")\n' +
          '  (subpath "/etc")\n' +
          '  (subpath "/bin")\n' +
          '  (subpath "/sbin")\n' +
          '  (subpath "/usr")\n' +
          '  (subpath "/private/etc"))'
      );
    } else {
      // 默认禁止一切全局写操作，仅按需精确开洞
      rules.push("(deny file-write*)");

      // 允许写入系统标准虚拟设备与描述符
      rules.push(
        "(allow file-write*\n" +
          '  (literal "/dev/null")\n' +
          '  (literal "/dev/zero")\n' +
          '  (literal "/dev/dtracehelper")\n' +
          '  (literal "/dev/tty")\n' +
          '  (subpath "/dev/fd"))'
      );

      if (fsMode === "workspace-write") {
        const rawCwd = path.resolve(request.cwd);
        const canonicalCwd = resolveCanonicalPath(rawCwd);

        if (request.scopedWritePaths && request.scopedWritePaths.length > 0) {
          // 精确白名单限制：仅允许写入 scopedWritePaths 中的子路径
          for (const scopedPath of request.scopedWritePaths) {
            const normalized = scopedPath.replace(/\\/g, "/").replace(/^\.\//, "");
            const wildcard = normalized.indexOf("*");
            const literal = wildcard < 0 ? normalized : normalized.slice(0, wildcard);
            const scopeRoot = path.resolve(rawCwd, literal || ".");
            const canonicalRoot = resolveCanonicalPath(scopeRoot);
            const relative = path.relative(canonicalCwd, canonicalRoot);
            if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
              throw new FilesystemAccessDeniedError(scopedPath, "write", "scopedWritePaths escapes workspace");
            }
            if (wildcard < 0 || normalized.endsWith("/**") && wildcard === normalized.length - 2 || normalized === "*" || normalized === "**") {
              rules.push(`(allow file-write* (subpath "${escapeSchemeString(canonicalRoot)}"))`);
            } else {
              const pattern = canonicalRoot + (!literal || literal.endsWith("/") ? "/" : "") + normalized.slice(wildcard);
              const regex = "^" + pattern.split(/(\*\*\/|\*\*|\*)/).map(part => part === "**/" ? "(.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("") + "$";
              rules.push(`(allow file-write* (regex #"${escapeSchemeString(regex)}"))`);
            }
          }
        } else {
          // 允许工作区内部的所有写入
          rules.push(`(allow file-write* (subpath "${escapeSchemeString(canonicalCwd)}"))`);
          if (canonicalCwd !== rawCwd) {
            rules.push(`(allow file-write* (subpath "${escapeSchemeString(rawCwd)}"))`);
          }
        }

        // 允许受控临时目录写入
        if (this.controlledTempDir) {
          const rawTemp = path.resolve(this.controlledTempDir);
          const canonicalTemp = resolveCanonicalPath(rawTemp);
          rules.push(`(allow file-write* (subpath "${escapeSchemeString(canonicalTemp)}"))`);
          if (canonicalTemp !== rawTemp) {
            rules.push(`(allow file-write* (subpath "${escapeSchemeString(rawTemp)}"))`);
          }
        }

        // 允许通过审批临时单次放行的路径
        if (request.extraAllowedWritePaths && request.extraAllowedWritePaths.length > 0) {
          for (const extraPath of request.extraAllowedWritePaths) {
            const rawExtra = path.resolve(extraPath);
            const canonicalExtra = resolveCanonicalPath(rawExtra);
            rules.push(`(allow file-write* (subpath "${escapeSchemeString(canonicalExtra)}"))`);
            if (canonicalExtra !== rawExtra) {
              rules.push(`(allow file-write* (subpath "${escapeSchemeString(rawExtra)}"))`);
            }
          }
        }
      } else if (fsMode === "read-only") {
        // read-only 模式下工作区不允许写入，也不提供额外临时目录写入放行
      }
    }

    return rules.join("\n");
  }

  /**
   * 获取沙箱后端的能力指示
   */
  getCapabilities(): SandboxBackendCapabilities {
    return {
      filesystemIsolation: true,
      networkIsolation: true,
      processIsolation: false,
      syscallFiltering: false,
      resourceLimits: false,
    };
  }

  /**
   * 将请求转换为底层可执行程序及完整启动规格
   */
  buildExecutionSpec(request: SandboxProcessRequest): SandboxExecutionSpec {
    const profile = this.generateProfile(request);
    const sanitizedEnv = buildSandboxEnvironment(request.env);

    const execArgs: string[] = ["-p", profile, request.command];
    if (request.args && request.args.length > 0) {
      execArgs.push(...request.args);
    }

    return {
      executable: this.executablePath,
      args: execArgs,
      cwd: request.cwd,
      env: sanitizedEnv,
    };
  }

  /**
   * 在 Seatbelt 沙箱约束下启动子进程并等待执行结束
   */
  async run(request: SandboxProcessRequest): Promise<SandboxProcessResult> {
    if (!this.isAvailable()) {
      throw new SandboxUnavailableError(
        `macOS Seatbelt 沙箱执行器不可用: 路径 '${this.executablePath}' 不存在或当前操作系统非 macOS。`
      );
    }

    const profile = this.generateProfile(request);
    const sanitizedEnv = buildSandboxEnvironment(request.env);

    // 组织 sandbox-exec 执行参数：sandbox-exec -p <profile> <command> ...<args>
    const execArgs: string[] = ["-p", profile, request.command];
    if (request.args && request.args.length > 0) {
      execArgs.push(...request.args);
    }

    const timeout = request.timeout ?? 30_000;
    const maxBuffer = request.maxBuffer ?? 10 * 1024 * 1024;

    return new Promise<SandboxProcessResult>((resolve) => {
      execFile(
        this.executablePath,
        execArgs,
        {
          cwd: request.cwd,
          env: sanitizedEnv,
          timeout,
          maxBuffer,
        },
        (error, stdout, stderr) => {
          let exitCode = 0;
          let killed = false;

          if (error) {
            exitCode = typeof error.code === "number" ? error.code : 1;
            killed = Boolean(error.killed);
          }

          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode,
            killed,
          });
        }
      );
    });
  }
}
