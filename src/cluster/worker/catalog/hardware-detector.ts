import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { createDefaultToolRegistry } from "../../../tools/index.js";
import type { NodeHardwareCapability } from "../../protocol/types.js";
import { verifyPosixSandbox } from "../../../sandbox/posix-verification.js";
import { WindowsSandboxProbe } from "../../../sandbox/windows/capability-probe.js";

/**
 * 探测当前节点硬件配置与运行环境执行能力
 * 严格遵从能力分级准则：
 * Detected: 硬件或工具链物理存在
 * Available: 基础驱动或运行时可用
 * Configured: 已配置但尚未跑通端到端验证
 * Verified: 经过实际测试验证可用
 * Unavailable: 明确不可用
 * Unknown: 状态未知
 */
export function detectNodeHardwareCapabilities(): NodeHardwareCapability[] {
  const list: NodeHardwareCapability[] = [];
  const now = Date.now();
  for (const tool of createDefaultToolRegistry().getAll()) list.push({
    name: `tool:${tool.name}`, category: "other", status: "available", details: tool.description ?? tool.name,
    detectionMethod: "actual base ToolRegistry enumeration; execution remains subject to sandbox and approval", detectedAt: now,
  });
  for (const [name, executable, args] of [
    ["Python Runtime", process.platform === "win32" ? "python.exe" : "python3", ["--version"]],
    ["PowerShell Runtime", process.platform === "win32" ? "powershell.exe" : "pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]],
  ] as const) {
    const probe = spawnSync(executable, [...args], { encoding: "utf8", timeout: 2000, windowsHide: true });
    if (probe.status === 0) list.push({ name, category: "runtime", status: "verified", details: (probe.stdout || probe.stderr).trim().slice(0, 200), detectionMethod: "bounded runtime version probe", detectedAt: now, verifiedAt: now });
  }

  // 1. CPU
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "Unknown CPU";
  list.push({
    name: "CPU",
    category: "cpu",
    status: "available",
    details: `${cpuModel} (${cpus.length} cores, ${process.arch})`,
    detectionMethod: "os.cpus",
    detectedAt: now,
    verifiedAt: now,
  });

  // 2. Memory
  const totalMemGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  const freeMemGb = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
  list.push({
    name: "System Memory",
    category: "memory",
    status: "available",
    details: `${totalMemGb} GB total, ${freeMemGb} GB free`,
    detectionMethod: "os.totalmem",
    detectedAt: now,
    verifiedAt: now,
  });

  // 3. Sandbox
  if (process.platform === "darwin" || process.platform === "linux") {
    const verification = verifyPosixSandbox();
    list.push({
      name: verification.backend,
      category: "sandbox",
      status: verification.verified ? "verified" : "degraded",
      details: verification.details.join("; "),
      detectionMethod: "selected backend filesystem controls and live loopback network controls",
      detectedAt: now,
      verifiedAt: verification.structuredDetails.verifiedAt,
      structuredDetails: verification.structuredDetails,
    });
  } else if (process.platform === "win32") {
    const probe = WindowsSandboxProbe.probe();
    const helperExists = probe.helperAvailable;
    const jobObjects = probe.jobObjectsAvailable;
    const verification = WindowsSandboxProbe.verifyIsolation();
    const fsVerified = verification.filesystemIsolationVerified;
    const netVerified = verification.networkDenyVerified;
    const isVerified = verification.status === "VERIFIED";
    const status: NodeHardwareCapability["status"] = isVerified ? "verified" : helperExists ? "degraded" : "unavailable";
    const details = verification.details.join("; ");

    list.push({
      name: "Windows Native Sandbox",
      category: "sandbox",
      status,
      details,
      detectionMethod: "WindowsSandboxProbe.probe()",
      detectedAt: now,
      verifiedAt: verification.verifiedAt,
      structuredDetails: {
        backend: "windows-sandbox",
        helperPath: verification.helperPath,
        helperSha256: verification.helperSha256,
        installed: helperExists,
        operational: helperExists && jobObjects,
        filesystemIsolationVerified: fsVerified,
        networkIsolationVerified: netVerified,
        processIsolationVerified: verification.jobObjectsControlVerified,
        supportedPolicies: fsVerified
          ? ["read-only", "workspace-write", "danger-full-access"]
          : ["danger-full-access"],
        supportedNetworkModes: netVerified ? (verification.networkAllowVerified ? ["deny", "allow"] : ["deny"]) : ["allow"],
        requiresWslForRestrictedExecution: !isVerified,
        verifiedAt: verification.verifiedAt,
        verificationExpiresAt: verification.verificationExpiresAt,
        failureReason: isVerified
          ? undefined
          : helperExists
            ? "AppContainer DACL runtime isolation unverified; restricted execution requires WSL2"
            : "Helper binary missing",
      },
    });
  }

  // 4. Runtime
  list.push({
    name: "Node.js Runtime",
    category: "runtime",
    status: "verified",
    details: `Node.js ${process.version} (${process.platform} ${process.arch})`,
    detectionMethod: "process.version",
    detectedAt: now,
    verifiedAt: now,
  });

  // 5. GPU 物理探测与严格状态隔离
  if (process.platform === "darwin" && process.arch === "arm64") {
    list.push({
      name: "Apple Silicon Metal GPU",
      category: "gpu",
      status: "available",
      details: "Unified memory architecture with Apple Metal accelerator",
      detectionMethod: "os.arch(arm64)",
      detectedAt: now,
      verifiedAt: now,
    });
  } else {
    // 探测 NVIDIA GPU (如 WSL2 / Linux)
    try {
      const out = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      if (out) {
        const firstGpu = out.split("\n")[0].trim();
        list.push({
          name: "NVIDIA GPU",
          category: "gpu",
          // 铁律：检测到 GPU 物理存在不代表 PyTorch 已装或 CUDA 可用
          status: "detected",
          details: `${firstGpu} (Physically detected via nvidia-smi; CUDA/framework unverified)`,
          detectionMethod: "nvidia-smi",
          detectedAt: now,
        });
      }
    } catch {
      // 未检测到 NVIDIA GPU，不添加假记录
    }

    if (process.platform === "win32" && !list.some((c) => c.category === "gpu")) {
      try {
        const out = execSync(
          'powershell.exe -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
          {
            encoding: "utf-8",
            timeout: 2000,
            stdio: ["ignore", "pipe", "ignore"],
          }
        ).trim();
        if (out) {
          const firstGpu = out.split("\r\n")[0].trim();
          list.push({
            name: firstGpu,
            category: "gpu",
            status: "detected",
            details: `${firstGpu} (Physically detected via Win32_VideoController; Driver available, compute framework unverified)`,
            detectionMethod: "Win32_VideoController",
            detectedAt: now,
          });
        }
      } catch {}
    }
  }

  return list;
}
