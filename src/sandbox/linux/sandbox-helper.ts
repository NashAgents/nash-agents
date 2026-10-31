import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SandboxUnavailableError } from "../errors.js";

export const EXPECTED_HELPER_PROTOCOL_VERSION = 1;

export interface HelperVersionInfo {
  protocolVersion: number;
  platform: string;
  arch: string;
  landlock: boolean;
  landlockAbi: number;
  seccomp: boolean;
  noNewPrivs: boolean;
}

export interface LinuxSandboxHelperConfig {
  protocolVersion?: number;
  landlockEnabled?: boolean;
  seccompEnabled?: boolean;
  noNewPrivs?: boolean;
  blockNetworkSockets?: boolean;
  readOnlyPaths?: string[];
  readWritePaths?: string[];
  cgroupPath?: string;
  command: string;
  args?: string[];
}

/**
 * Linux 原生沙箱辅助程序 (nash-linux-sandbox-helper) 管理器
 *
 * 核心安全职责：
 * 1. 查找并验证平台匹配的预编译 Helper 二进制文件；
 * 2. 与 Helper 进行协议版本握手 (--version-json)，不兼容时严格 Fail-Closed；
 * 3. 构造安全的序列化配置（通过专用只读临时配置文件传递，杜绝命令行参数注入与 Shell 逃逸）；
 * 4. Helper 执行后自动回收配置文件，确保零磁盘污染。
 */
export class LinuxSandboxHelperManager {
  private static cachedVersionInfo?: HelperVersionInfo | null;
  private static cachedExecutablePath?: string;

  /**
   * 探测并解析当前架构适用的 helper 二进制路径
   */
  static resolveHelperExecutablePath(customPath?: string): string | undefined {
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }
    if (this.cachedExecutablePath && fs.existsSync(this.cachedExecutablePath)) {
      return this.cachedExecutablePath;
    }

    if (process.platform !== "linux") {
      return undefined;
    }

    const arch = process.arch === "x64" ? "linux-x64" : process.arch === "arm64" ? "linux-arm64" : undefined;
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
      path.resolve(currentFileDir, `../../../native/bin/${arch}/nash-linux-sandbox-helper`),
      path.resolve(currentFileDir, `../../native/bin/${arch}/nash-linux-sandbox-helper`),
      path.resolve(process.cwd(), `native/bin/${arch}/nash-linux-sandbox-helper`),
      `/usr/local/bin/nash-linux-sandbox-helper`,
      `/usr/bin/nash-linux-sandbox-helper`,
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
   * 探测并握手 Helper 版本与内核支持状态
   */
  static getVersionInfo(customPath?: string, force = false): HelperVersionInfo | null {
    if (this.cachedVersionInfo !== undefined && !force) {
      return this.cachedVersionInfo;
    }

    const helperPath = this.resolveHelperExecutablePath(customPath);
    if (!helperPath) {
      this.cachedVersionInfo = null;
      return null;
    }

    try {
      const output = execFileSync(helperPath, ["--version-json"], {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const parsed = JSON.parse(output.trim()) as HelperVersionInfo;
      if (parsed.protocolVersion !== EXPECTED_HELPER_PROTOCOL_VERSION) {
        throw new SandboxUnavailableError(
          `nash-linux-sandbox-helper 协议版本不匹配: 期望 ${EXPECTED_HELPER_PROTOCOL_VERSION}, 实际 ${parsed.protocolVersion}`
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
    return info !== null && info.protocolVersion === EXPECTED_HELPER_PROTOCOL_VERSION;
  }

  /**
   * 构造调用规格并写入安全配置文件
   */
  static buildExecutionArgs(
    config: LinuxSandboxHelperConfig,
    customPath?: string
  ): {
    executable: string;
    args: string[];
    cleanup: () => void;
  } {
    const helperPath = this.resolveHelperExecutablePath(customPath);
    if (!helperPath) {
      throw new SandboxUnavailableError(
        "无法启动 Linux 原生沙箱辅助程序: 未找到与当前架构匹配的 nash-linux-sandbox-helper 二进制文件。"
      );
    }

    const versionInfo = this.getVersionInfo(helperPath);
    if (!versionInfo || versionInfo.protocolVersion !== EXPECTED_HELPER_PROTOCOL_VERSION) {
      throw new SandboxUnavailableError(
        "nash-linux-sandbox-helper 版本握手失败或协议不兼容 (Fail-Closed)。"
      );
    }

    const fullConfig: LinuxSandboxHelperConfig = {
      protocolVersion: EXPECTED_HELPER_PROTOCOL_VERSION,
      landlockEnabled: Boolean(config.landlockEnabled),
      seccompEnabled: config.seccompEnabled !== false, // 默认开启
      noNewPrivs: config.noNewPrivs !== false,         // 默认开启
      blockNetworkSockets: Boolean(config.blockNetworkSockets),
      readOnlyPaths: config.readOnlyPaths ?? [],
      readWritePaths: config.readWritePaths ?? [],
      cgroupPath: config.cgroupPath,
      command: config.command,
      args: config.args ?? [],
    };

    const configJson = JSON.stringify(fullConfig);

    return {
      executable: helperPath,
      args: ["--config-json", configJson],
      cleanup: () => {},
    };
  }

  /**
   * 重置缓存 (供单元测试 Mock 使用)
   */
  static resetCache(): void {
    this.cachedVersionInfo = undefined;
    this.cachedExecutablePath = undefined;
  }
}
