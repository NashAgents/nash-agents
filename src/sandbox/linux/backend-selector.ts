import type { SandboxBackend, SandboxProcessRequest, SandboxProcessResult, SandboxPolicy } from "../types.js";
import { SandboxUnavailableError } from "../errors.js";
import { LinuxSandboxProbe } from "./capability-probe.js";
import {
  LinuxBubblewrapBackend,
  type LinuxBubblewrapOptions,
} from "../backends/linux-bubblewrap.js";
import {
  LinuxLandlockBackend,
  type LinuxLandlockOptions,
} from "../backends/linux-landlock.js";

/**
 * 表达沙箱后端不可用状态的 Fail-Closed 占位后端实现
 */
export class SandboxUnavailableBackend implements SandboxBackend {
  readonly name: string;
  readonly reason: string;

  constructor(
    name = "unavailable",
    reason = "Sandbox backend is not available on this platform."
  ) {
    this.name = name;
    this.reason = reason;
  }

  isAvailable(): boolean {
    return false;
  }

  async run(request: SandboxProcessRequest): Promise<SandboxProcessResult> {
    throw new SandboxUnavailableError(
      `沙箱后端 '${this.name}' 不可用: ${this.reason}`
    );
  }
}

export interface LinuxBackendSelectorOptions {
  /**
   * Bubblewrap 配置选项
   */
  bubblewrapOptions?: LinuxBubblewrapOptions;

  /**
   * Landlock 配置选项
   */
  landlockOptions?: LinuxLandlockOptions;

  /**
   * 仅供内部测试/调试使用的强制后端指定 (Runtime Authority)
   */
  forceBackend?: "bubblewrap" | "landlock";
}

/**
 * Linux 平台能力感知型 (Capability-Aware) 沙箱后端自动选择器
 *
 * 核心设计准则：
 * 1. 首选 LinuxBubblewrapBackend (提供强 Namespace 隔离与完整网络栈隔离)；
 * 2. 备选 LinuxLandlockBackend (提供内核 Landlock LSM 与 Seccomp 网络阻断)；
 * 3. 严格的能力感知 (Capability-Aware)：根据当前 SandboxPolicy 的具体需求做能力匹配，
 *    若策略要求网络隔离而备选后端无法提供，坚决拒绝降级并 Fail-Closed；
 * 4. 彻底杜绝静默裸跑。
 */
export class LinuxBackendSelector {
  /**
   * 根据当前安全策略与系统能力，选择并实例化最适用的 Linux 沙箱后端
   *
   * @param policy - 当前调用的沙箱安全策略（可选，默认为标准安全策略）
   * @param options - 后端选择与配置选项
   */
  static select(
    policy?: SandboxPolicy,
    options?: LinuxBackendSelectorOptions
  ): SandboxBackend {
    // 1. 内部测试 Override 支持
    if (options?.forceBackend === "landlock") {
      const landlock = new LinuxLandlockBackend(options?.landlockOptions);
      if (landlock.isAvailable()) {
        return landlock;
      }
      return new SandboxUnavailableBackend(
        "linux-landlock",
        "强制指定的 Landlock 后端在当前系统不可用 (缺少内核 Landlock 或 Native Helper)。"
      );
    }

    if (options?.forceBackend === "bubblewrap") {
      const bwrap = new LinuxBubblewrapBackend(options?.bubblewrapOptions);
      if (bwrap.isAvailable()) {
        return bwrap;
      }
      return new SandboxUnavailableBackend(
        "linux-bubblewrap",
        "强制指定的 Bubblewrap 后端在当前系统不可用。"
      );
    }

    const probe = LinuxSandboxProbe.probe();

    const requireNetworkIsolation = policy ? policy.network.mode === "deny" : true;
    const requireFilesystemIsolation = policy
      ? policy.filesystem.mode !== "danger-full-access"
      : true;

    // 2. 首选方案：Bubblewrap
    if (probe.bubblewrapUsable) {
      // 验证网络隔离能力是否能满足 policy 要求
      if (!requireNetworkIsolation || probe.networkNamespaceUsable) {
        return new LinuxBubblewrapBackend(options?.bubblewrapOptions);
      }
    }

    // 3. 次选方案：Landlock Fallback
    const landlockBackend = new LinuxLandlockBackend(options?.landlockOptions);
    if (landlockBackend.isAvailable()) {
      const caps = landlockBackend.getCapabilities();
      const fsOk = !requireFilesystemIsolation || caps.filesystemIsolation;
      const netOk = !requireNetworkIsolation || caps.networkIsolation;

      if (fsOk && netOk) {
        return landlockBackend;
      }
    }

    // 4. 严格 Fail-Closed：无可满足当前 Policy 要求的沙箱后端可用
    const failureReason =
      probe.reason ??
      "Bubblewrap 不可用且 Landlock LSM 无法满足当前策略的安全能力要求 (Fail-Closed)。";

    return new SandboxUnavailableBackend("linux-sandbox", failureReason);
  }
}
