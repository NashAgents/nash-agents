import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { LinuxSandboxHelperManager, type HelperVersionInfo } from "./sandbox-helper.js";
import { ResourceController, type CgroupProbeResult } from "./resource-controller.js";

export interface LinuxSandboxCapabilities {
  bubblewrapInstalled: boolean;
  bubblewrapUsable: boolean;
  userNamespaceUsable: boolean;
  networkNamespaceUsable: boolean;
  pidNamespaceUsable: boolean;
  ipcNamespaceUsable: boolean;
  utsNamespaceUsable: boolean;
  bwrapVersion?: string;
  executablePath?: string;

  // Seccomp & Helper & no_new_privs
  seccompSupported: boolean;
  helperAvailable: boolean;
  noNewPrivsSupported: boolean;
  helperVersion?: HelperVersionInfo | null;

  // Landlock LSM
  landlockAvailable: boolean;
  landlockAbi: number;

  // cgroup v2
  cgroupV2Available: boolean;
  cgroupDelegated: boolean;
  cgroupControllers: {
    memory: boolean;
    pids: boolean;
    cpu: boolean;
  };

  reason?: string;
}

/**
 * 探测 Linux 内核、系统工具及沙箱能力的全局统一探针
 */
export class LinuxSandboxProbe {
  private static cachedResult?: LinuxSandboxCapabilities;

  /**
   * 查找系统中 bwrap 的有效可执行文件路径
   */
  static findBwrapExecutable(): string | undefined {
    const candidates = [
      "/usr/bin/bwrap",
      "/usr/local/bin/bwrap",
      "/bin/bwrap",
    ];

    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          return p;
        }
      } catch {}
    }

    // PATH 查找
    const envPath = process.env.PATH || "";
    const paths = envPath.split(":");
    for (const dir of paths) {
      if (!dir) continue;
      const target = `${dir}/bwrap`;
      try {
        if (fs.existsSync(target) && fs.statSync(target).isFile()) {
          return target;
        }
      } catch {}
    }

    return undefined;
  }

  /**
   * 探测 Landlock LSM 内核支持与 ABI 版本
   */
  static probeLandlock(): { available: boolean; abi: number } {
    if (process.platform !== "linux") {
      return { available: false, abi: 0 };
    }

    const helperInfo = LinuxSandboxHelperManager.getVersionInfo();
    if (helperInfo && helperInfo.landlock) {
      return { available: true, abi: helperInfo.landlockAbi };
    }

    try {
      const lsmPath = "/sys/kernel/security/lsm";
      if (fs.existsSync(lsmPath)) {
        const lsmContent = fs.readFileSync(lsmPath, "utf-8");
        if (lsmContent.includes("landlock")) {
          return { available: true, abi: helperInfo?.landlockAbi ?? 1 };
        }
      }
    } catch {}

    return { available: false, abi: 0 };
  }

  /**
   * 探测当前 Linux 系统的沙箱能力（单例缓存，首次探测后复用结果）
   *
   * @param force - 是否强制重新探测
   */
  static probe(force = false): LinuxSandboxCapabilities {
    if (this.cachedResult && !force) {
      return this.cachedResult;
    }

    if (process.platform !== "linux") {
      const result: LinuxSandboxCapabilities = {
        bubblewrapInstalled: false,
        bubblewrapUsable: false,
        userNamespaceUsable: false,
        networkNamespaceUsable: false,
        pidNamespaceUsable: false,
        ipcNamespaceUsable: false,
        utsNamespaceUsable: false,
        seccompSupported: false,
        helperAvailable: false,
        noNewPrivsSupported: false,
        landlockAvailable: false,
        landlockAbi: 0,
        cgroupV2Available: false,
        cgroupDelegated: false,
        cgroupControllers: { memory: false, pids: false, cpu: false },
        reason: `Platform is '${process.platform}', not Linux.`,
      };
      this.cachedResult = result;
      return result;
    }

    // 1. Helper 与 Seccomp / no_new_privs 探测
    const helperInfo = LinuxSandboxHelperManager.getVersionInfo();
    const helperAvailable = helperInfo !== null;
    const seccompSupported = Boolean(helperInfo?.seccomp);
    const noNewPrivsSupported = Boolean(helperInfo?.noNewPrivs);

    // 2. Landlock 探测
    const landlockResult = this.probeLandlock();

    // 3. cgroup v2 探测
    const cgroupProbe: CgroupProbeResult = ResourceController.probe(force);

    // 4. Bubblewrap 探测
    const bwrapPath = this.findBwrapExecutable();
    if (!bwrapPath) {
      const result: LinuxSandboxCapabilities = {
        bubblewrapInstalled: false,
        bubblewrapUsable: false,
        userNamespaceUsable: false,
        networkNamespaceUsable: false,
        pidNamespaceUsable: false,
        ipcNamespaceUsable: false,
        utsNamespaceUsable: false,
        seccompSupported,
        helperAvailable,
        noNewPrivsSupported,
        helperVersion: helperInfo,
        landlockAvailable: landlockResult.available,
        landlockAbi: landlockResult.abi,
        cgroupV2Available: cgroupProbe.cgroupV2Available,
        cgroupDelegated: cgroupProbe.delegatedWritable,
        cgroupControllers: cgroupProbe.controllers,
        reason:
          "Bubblewrap executable ('bwrap') is not installed or not found in PATH. " +
          "Please install 'bubblewrap' package (e.g. apt install bubblewrap).",
      };
      this.cachedResult = result;
      return result;
    }

    // 获取 bwrap 版本
    let bwrapVersion: string | undefined;
    try {
      const verOutput = execFileSync(bwrapPath, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      bwrapVersion = verOutput.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const result: LinuxSandboxCapabilities = {
        bubblewrapInstalled: true,
        executablePath: bwrapPath,
        bubblewrapUsable: false,
        userNamespaceUsable: false,
        networkNamespaceUsable: false,
        pidNamespaceUsable: false,
        ipcNamespaceUsable: false,
        utsNamespaceUsable: false,
        seccompSupported,
        helperAvailable,
        noNewPrivsSupported,
        helperVersion: helperInfo,
        landlockAvailable: landlockResult.available,
        landlockAbi: landlockResult.abi,
        cgroupV2Available: cgroupProbe.cgroupV2Available,
        cgroupDelegated: cgroupProbe.delegatedWritable,
        cgroupControllers: cgroupProbe.controllers,
        reason: `Failed to execute '${bwrapPath} --version': ${msg}`,
      };
      this.cachedResult = result;
      return result;
    }

    // 探针：最小只读沙箱启动测试 (验证 user namespace 与 mount namespace)
    let userNamespaceUsable = false;
    let minSandboxUsable = false;
    let minProbeError = "";
    try {
      execFileSync(
        bwrapPath,
        [
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "true",
        ],
        {
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      userNamespaceUsable = true;
      minSandboxUsable = true;
    } catch (err: unknown) {
      minProbeError = err instanceof Error ? err.message : String(err);
      if (
        minProbeError.includes("No such file or directory") ||
        minProbeError.includes("Permission denied") ||
        minProbeError.includes("Operation not permitted") ||
        minProbeError.includes("setting up uid map") ||
        minProbeError.includes("unshare")
      ) {
        userNamespaceUsable = false;
      }
    }

    if (!minSandboxUsable) {
      const result: LinuxSandboxCapabilities = {
        bubblewrapInstalled: true,
        executablePath: bwrapPath,
        bwrapVersion,
        bubblewrapUsable: false,
        userNamespaceUsable,
        networkNamespaceUsable: false,
        pidNamespaceUsable: false,
        ipcNamespaceUsable: false,
        utsNamespaceUsable: false,
        seccompSupported,
        helperAvailable,
        noNewPrivsSupported,
        helperVersion: helperInfo,
        landlockAvailable: landlockResult.available,
        landlockAbi: landlockResult.abi,
        cgroupV2Available: cgroupProbe.cgroupV2Available,
        cgroupDelegated: cgroupProbe.delegatedWritable,
        cgroupControllers: cgroupProbe.controllers,
        reason:
          `Bubblewrap is installed (${bwrapVersion} at ${bwrapPath}), but minimal container setup failed: ${minProbeError}. ` +
          "This typically indicates unprivileged user namespace restrictions (e.g. AppArmor / sysctl kernel.unprivileged_userns_clone=0).",
      };
      this.cachedResult = result;
      return result;
    }

    // 探针：网络命名空间隔离能力测试 (--unshare-net)
    let networkNamespaceUsable = false;
    try {
      execFileSync(
        bwrapPath,
        [
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-net",
          "true",
        ],
        {
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      networkNamespaceUsable = true;
    } catch {
      networkNamespaceUsable = false;
    }

    // PID / IPC / UTS namespace 测试
    let pidNamespaceUsable = false;
    let ipcNamespaceUsable = false;
    let utsNamespaceUsable = false;
    try {
      execFileSync(
        bwrapPath,
        [
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-pid",
          "true",
        ],
        { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
      );
      pidNamespaceUsable = true;
    } catch {}

    try {
      execFileSync(
        bwrapPath,
        [
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-ipc",
          "true",
        ],
        { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
      );
      ipcNamespaceUsable = true;
    } catch {}

    try {
      execFileSync(
        bwrapPath,
        [
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-uts",
          "true",
        ],
        { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
      );
      utsNamespaceUsable = true;
    } catch {}

    const result: LinuxSandboxCapabilities = {
      bubblewrapInstalled: true,
      executablePath: bwrapPath,
      bwrapVersion,
      bubblewrapUsable: true,
      userNamespaceUsable: true,
      networkNamespaceUsable,
      pidNamespaceUsable,
      ipcNamespaceUsable,
      utsNamespaceUsable,
      seccompSupported,
      helperAvailable,
      noNewPrivsSupported,
      helperVersion: helperInfo,
      landlockAvailable: landlockResult.available,
      landlockAbi: landlockResult.abi,
      cgroupV2Available: cgroupProbe.cgroupV2Available,
      cgroupDelegated: cgroupProbe.delegatedWritable,
      cgroupControllers: cgroupProbe.controllers,
    };

    this.cachedResult = result;
    return result;
  }

  /**
   * 重置探测缓存（主要用于单元测试中 Mock 环境）
   */
  static resetCache(): void {
    this.cachedResult = undefined;
    ResourceController.resetCache();
    LinuxSandboxHelperManager.resetCache();
  }
}
