import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SandboxUnavailableError } from "../errors.js";
import {
  EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION,
  type WindowsHelperVersionInfo,
  type WindowsSandboxHelperConfig,
} from "./types.js";

/**
 * Windows 原生沙箱辅助程序 (nash-windows-sandbox-helper.exe) 管理器
 */
export class WindowsSandboxHelperManager {
  private static cachedVersionInfo?: WindowsHelperVersionInfo | null;
  private static cachedExecutablePath?: string;
  private static cachedVersionKey?: string;

  static getArtifactIdentity(customPath?: string): { path: string; sha256: string } | undefined {
    const executable = this.resolveHelperExecutablePath(customPath);
    if (!executable) return undefined;
    const realPath = fs.realpathSync.native(executable);
    return { path: realPath, sha256: crypto.createHash("sha256").update(fs.readFileSync(realPath)).digest("hex") };
  }

  static assertArtifactMatchesManifest(customPath?: string): void {
    const identity = this.getArtifactIdentity(customPath);
    if (!identity) throw new SandboxUnavailableError("Windows Helper missing");
    try {
      const manifest = JSON.parse(fs.readFileSync(`${identity.path}.manifest.json`, "utf8"));
      const source = path.resolve(path.dirname(identity.path), "../../windows-sandbox-helper/main.c");
      const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
      if (manifest.binarySha256 !== identity.sha256 || manifest.sourceSha256 !== sourceSha256 ||
          manifest.protocolVersion !== EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION) {
        throw new Error("binary/source/protocol mismatch");
      }
    } catch (error) {
      throw new SandboxUnavailableError(`Native artifact manifest verification failed (Fail-Closed): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 探测并解析当前架构适用的 helper 二进制路径
   */
  static resolveHelperExecutablePath(customPath?: string): string | undefined {
    if (customPath) {
      return fs.existsSync(customPath) ? customPath : undefined;
    }
    if (this.cachedExecutablePath && fs.existsSync(this.cachedExecutablePath)) {
      return this.cachedExecutablePath;
    }

    if (process.platform !== "win32") {
      return undefined;
    }

    const arch = process.arch === "x64" ? "win32-x64" : process.arch === "arm64" ? "win32-arm64" : undefined;
    if (!arch) {
      return undefined;
    }

    const currentFileDir = (() => {
      try {
        return path.dirname(fileURLToPath(import.meta.url));
      } catch {
        return process.cwd();
      }
    })();

    const candidates = [
      path.resolve(currentFileDir, `../../../native/bin/${arch}/nash-windows-sandbox-helper.exe`),
      path.resolve(currentFileDir, `../../native/bin/${arch}/nash-windows-sandbox-helper.exe`),
      path.resolve(process.cwd(), `native/bin/${arch}/nash-windows-sandbox-helper.exe`),
    ];

    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          this.cachedExecutablePath = cand;
          return cand;
        }
      } catch {}
    }

    return undefined;
  }

  /**
   * 探测并握手 Helper 版本与 Win32 安全能力状态
   */
  static getVersionInfo(customPath?: string, force = false): WindowsHelperVersionInfo | null {
    const identity = this.getArtifactIdentity(customPath);
    const versionKey = identity ? `${identity.path}:${identity.sha256}` : "missing";
    if (this.cachedVersionInfo !== undefined && this.cachedVersionKey === versionKey && !force) {
      return this.cachedVersionInfo;
    }

    this.cachedVersionKey = versionKey;
    const helperPath = identity?.path;
    if (!helperPath) {
      this.cachedVersionInfo = null;
      return null;
    }

    try {
      const output = execFileSync(helperPath, ["--version-json"], {
        encoding: "utf-8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const parsed = JSON.parse(output.trim()) as WindowsHelperVersionInfo;
      if (parsed.protocolVersion !== EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION && parsed.protocolVersion !== 1) {
        throw new SandboxUnavailableError(
          `nash-windows-sandbox-helper 协议版本不匹配: 期望 ${EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION}, 实际 ${parsed.protocolVersion}`
        );
      }
      this.cachedVersionInfo = parsed;
      return parsed;
    } catch (err: unknown) {
      if (err instanceof SandboxUnavailableError) {
        throw err;
      }
      this.cachedVersionInfo = null;
      return null;
    }
  }

  /**
   * 判断 Helper 是否可用
   */
  static isAvailable(customPath?: string): boolean {
    const info = this.getVersionInfo(customPath);
    return info !== null && (info.protocolVersion === EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION || info.protocolVersion === 1);
  }

  /**
   * 执行沙箱化进程请求，经由独立临时配置文件传递参数
   */
  static execute(
    config: WindowsSandboxHelperConfig,
    customPath?: string
  ): {
    exitCode: number;
    stdout: string;
    stderr: string;
    killed: boolean;
  } {
    const helperPath = this.resolveHelperExecutablePath(customPath);
    if (!helperPath) {
      throw new SandboxUnavailableError(
        "无法启动 Windows 原生沙箱辅助程序: 未找到 nash-windows-sandbox-helper.exe 二进制文件。"
      );
    }

    if (config.appContainerEnabled) this.assertArtifactMatchesManifest(helperPath);
    const versionInfo = this.getVersionInfo(helperPath);
    if (!versionInfo || (versionInfo.protocolVersion !== EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION && versionInfo.protocolVersion !== 1)) {
      throw new SandboxUnavailableError(
        "nash-windows-sandbox-helper 版本握手失败或协议不兼容 (Fail-Closed)。"
      );
    }

    const fullConfig: WindowsSandboxHelperConfig = {
      protocolVersion: versionInfo.protocolVersion,
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd ?? process.cwd(),
      env: config.env,
      timeoutMs: config.timeoutMs ?? 30000,
      maxBuffer: config.maxBuffer ?? 10 * 1024 * 1024,
      maxProcesses: config.maxProcesses,
      memoryLimitBytes: config.memoryLimitBytes,
      cpuRateLimitPercent: config.cpuRateLimitPercent,
      dropAdminPrivileges: config.dropAdminPrivileges,
      restrictedTokenEnabled: config.restrictedTokenEnabled,
      integrityLevel: config.integrityLevel,
      appContainerEnabled: config.appContainerEnabled,
      appContainerName: config.appContainerName,
      networkAllow: config.networkAllow,
      allowedReadPaths: config.allowedReadPaths,
      allowedWritePaths: config.allowedWritePaths,
    };

    const tempFileName = `nash-win-sb-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    try {
      fs.writeFileSync(tempFilePath, JSON.stringify(fullConfig), "utf-8");

      const output = execFileSync(helperPath, ["--config-file", tempFilePath], {
        encoding: "utf-8",
        timeout: (config.timeoutMs ?? 30000) + 10000,
        maxBuffer: (config.maxBuffer ?? 10 * 1024 * 1024) + 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const trimmed = output.trim();
      const lastLine = trimmed.split("\n").pop() ?? trimmed;
      const parsed = JSON.parse(lastLine) as {
        exitCode: number;
        stdout: string;
        stderr: string;
        killed?: boolean;
      };

      return {
        exitCode: parsed.exitCode ?? 0,
        stdout: parsed.stdout ?? "",
        stderr: parsed.stderr ?? "",
        killed: Boolean(parsed.killed),
      };
    } catch (err: unknown) {
      const anyErr = err as any;
      if (anyErr.stdout) {
        try {
          const parsed = JSON.parse(anyErr.stdout.toString().trim());
          return {
            exitCode: parsed.exitCode ?? 1,
            stdout: parsed.stdout ?? "",
            stderr: parsed.stderr ?? "",
            killed: Boolean(parsed.killed),
          };
        } catch {}
      }
      throw new SandboxUnavailableError(
        `Windows 沙箱辅助程序执行异常: ${anyErr.message || String(err)}`
      );
    } finally {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch {}
    }
  }

  /**
   * 重置缓存 (供单元测试使用)
   */
  static resetCache(): void {
    this.cachedVersionInfo = undefined;
    this.cachedExecutablePath = undefined;
    this.cachedVersionKey = undefined;
  }
}
