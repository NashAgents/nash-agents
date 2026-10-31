import type {
  SandboxBackend,
  SandboxPolicy,
} from "../types.js";
import { SandboxUnavailableBackend } from "../linux/backend-selector.js";
import { WindowsSandboxProbe } from "./capability-probe.js";
import {
  WindowsSandboxBackend,
  type WindowsSandboxOptions,
} from "../backends/windows-sandbox.js";

export interface WindowsBackendSelectorOptions {
  windowsOptions?: WindowsSandboxOptions;
  forceBackend?: "windows-sandbox" | "unavailable";
}

/**
 * Windows 平台能力感知型沙箱后端自动选择器 (WindowsBackendSelector)
 */
export class WindowsBackendSelector {
  static select(
    policy?: SandboxPolicy,
    options?: WindowsBackendSelectorOptions
  ): SandboxBackend {
    if (options?.forceBackend === "unavailable") {
      return new SandboxUnavailableBackend(
        "windows-sandbox",
        "强制指定 Windows 沙箱不可用 (调试/测试模式)。"
      );
    }

    if (process.platform !== "win32") {
      return new SandboxUnavailableBackend(
        "windows-sandbox",
        `当前操作系统平台 '${process.platform}' 非 Windows。`
      );
    }

    const probe = WindowsSandboxProbe.probe();

    if (probe.helperAvailable && probe.jobObjectsAvailable) {
      return new WindowsSandboxBackend(options?.windowsOptions);
    }

    const failureReason =
      probe.reason ??
      "Windows Job Objects 或 Native Helper 不可用，无法满足当前沙箱安全要求 (Fail-Closed)。";

    return new SandboxUnavailableBackend("windows-sandbox", failureReason);
  }
}
