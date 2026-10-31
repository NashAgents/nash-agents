import cp from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WindowsSandboxHelperManager } from "./sandbox-helper.js";
import { WindowsSandboxCrashRecoveryLedger } from "./recovery-ledger.js";
import type {
  WindowsSandboxProbeResult,
  WindowsSandboxVerificationResult,
  SandboxVerificationStatus,
} from "./types.js";

/**
 * Windows 原生沙箱能力探针 (WindowsSandboxProbe)
 *
 * 核心职责：
 * 1. 真实探测 Windows 操作系统版本与内核 Build；
 * 2. 检查管理员提权状态 (UAC / High Integrity)；
 * 3. 探测 Job Objects 与 Restricted Token 安全能力；
 * 4. 探测 PowerShell、cmd 及 Git Bash 等真实 Shell 工具；
 * 5. 严格落实“声明能力 ≠ 真实验证隔离”原则，实施真实内核隔离自检 (Self-Test Isolation Verification)；
 * 6. 执行前自动联动 Crash Recovery 扫描并回收孤儿 Profile 与 ACE。
 */
export class WindowsSandboxProbe {
  private static cachedResult?: WindowsSandboxProbeResult;
  private static cachedVerification?: WindowsSandboxVerificationResult;

  /**
   * 基础静态能力探测 (检查系统版本、Helper 二进制、可用 Shell 及版本握手)
   */
  static probe(force = false): WindowsSandboxProbeResult {
    if (this.cachedResult && !force) {
      return this.cachedResult;
    }

    // 每次探测前先静默执行孤儿资源清理
    try {
      WindowsSandboxCrashRecoveryLedger.recoverOrphans();
    } catch {}

    if (process.platform !== "win32") {
      const res: WindowsSandboxProbeResult = {
        isWindows: false,
        osVersion: os.release(),
        buildNumber: 0,
        isElevated: false,
        jobObjectsAvailable: false,
        restrictedTokenAvailable: false,
        appContainerAvailable: false,
        networkIsolationAvailable: false,
        filesystemIsolationAvailable: false,
        helperAvailable: false,
        isolationStatus: "UNAVAILABLE",
        availableShells: {
          powershell: false,
          pwsh: false,
          cmd: false,
          bash: false,
        },
        reason: `当前平台 '${process.platform}' 非 Windows。`,
      };
      this.cachedResult = res;
      return res;
    }

    const osVersion = os.release();
    const buildParts = osVersion.split(".");
    const buildNumber = parseInt(buildParts[2] ?? "0", 10);

    // 检查是否具备管理员权限
    let isElevated = false;
    try {
      cp.execSync("net session", { stdio: ["ignore", "ignore", "ignore"] });
      isElevated = true;
    } catch {
      isElevated = false;
    }

    // 探测 Helper 真实握手
    const versionInfo = WindowsSandboxHelperManager.getVersionInfo();
    const helperPath = WindowsSandboxHelperManager.resolveHelperExecutablePath();

    // 探测真实 Shell
    const checkTool = (tool: string): string | null => {
      try {
        const out = cp.execSync(`where ${tool}`, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" });
        return out.trim().split("\r\n")[0] || null;
      } catch {
        return null;
      }
    };

    const discoveredBash = checkTool("bash.exe") || checkTool("bash");
    const git = checkTool("git.exe");
    const gitBashPath = [
      ...(git ? [path.resolve(path.dirname(git), "bash.exe"), path.resolve(path.dirname(git), "../bin/bash.exe")] : []),
      ...(discoveredBash && /[/\\]git[/\\]/i.test(discoveredBash) ? [discoveredBash] : []),
    ].find(candidate => fs.existsSync(candidate)) ?? null;
    const powershellPath = checkTool("powershell.exe") || checkTool("powershell");
    const pwshPath = checkTool("pwsh.exe") || checkTool("pwsh");
    const cmdPath = checkTool("cmd.exe") || checkTool("cmd");

    const helperOk = versionInfo !== null;
    const appContainerOk = Boolean(versionInfo?.appContainer);
    const jobOk = Boolean(versionInfo?.jobObjects);

    let isolationStatus: SandboxVerificationStatus = "UNVERIFIED";
    if (!helperOk || !jobOk) {
      isolationStatus = "UNAVAILABLE";
    } else if (!appContainerOk) {
      isolationStatus = "DEGRADED";
    }

    const result: WindowsSandboxProbeResult = {
      isWindows: true,
      osVersion,
      buildNumber,
      isElevated,
      jobObjectsAvailable: jobOk,
      restrictedTokenAvailable: Boolean(versionInfo?.restrictedToken),
      appContainerAvailable: appContainerOk,
      networkIsolationAvailable: Boolean(versionInfo?.networkIsolation),
      filesystemIsolationAvailable: Boolean(versionInfo?.filesystemIsolation),
      helperAvailable: helperOk,
      helperPath,
      isolationStatus,
      availableShells: {
        powershell: Boolean(powershellPath),
        pwsh: Boolean(pwshPath),
        cmd: Boolean(cmdPath),
        bash: Boolean(gitBashPath),
        gitBashPath: gitBashPath || undefined,
      },
    };

    if (!result.helperAvailable) {
      result.reason = "未找到已编译的 nash-windows-sandbox-helper.exe 或版本协议握手失败。";
    }

    this.cachedResult = result;
    return result;
  }

  /**
   * 真实内核级隔离能力验收自检 (Verified Sandbox Capabilities)
   *
   * 针对文件系统拦截、网络阻断及进程治理执行轻量探针，
   * 绝不盲目相信静态 API 返回。
   */
  static verifyIsolation(force = false): WindowsSandboxVerificationResult {
    const identity = WindowsSandboxHelperManager.getArtifactIdentity();
    if (this.cachedVerification && !force && identity?.sha256 === this.cachedVerification.helperSha256 &&
        (this.cachedVerification.verificationExpiresAt ?? 0) > Date.now()) {
      return this.cachedVerification;
    }
    const probe = this.probe(true);
    const details: string[] = [];
    let fsVerified = false;
    let netDenyVerified = false;
    let netAllowVerified = false;
    let jobControlVerified = false;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nash-probe-"));
    const workspace = path.join(tempRoot, "workspace");
    const outside = path.join(tempRoot, "outside.txt");
    try {
      if (!probe.isWindows || !probe.helperAvailable || !probe.appContainerAvailable) {
        throw new Error(probe.reason ?? "AppContainer unavailable");
      }
      WindowsSandboxHelperManager.assertArtifactMatchesManifest();
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, "read.txt"), "READ_OK");
      fs.writeFileSync(outside, "OUTSIDE_UNCHANGED");
      const run = (script: string, networkAllow = false, write = false, timeoutMs = 7000) =>
        WindowsSandboxHelperManager.execute({
          command: process.execPath, args: ["-e", script], cwd: workspace,
          appContainerEnabled: true, networkAllow, timeoutMs,
          allowedReadPaths: [workspace, path.dirname(process.execPath)],
          allowedWritePaths: write ? [workspace] : [],
        });
      const positive = run("const fs=require('fs');if(fs.readFileSync('read.txt','utf8')!=='READ_OK')process.exit(3);fs.writeFileSync('write.txt','WRITE_OK');console.log('FS_POSITIVE_OK')", false, true);
      const negative = run(`const fs=require('fs');let n=0;for(const f of [()=>fs.readFileSync(${JSON.stringify(outside)}),()=>fs.writeFileSync(${JSON.stringify(outside)},'BAD'),()=>fs.writeFileSync('read.txt','BAD')]){try{f()}catch(e){if(['EACCES','EPERM'].includes(e.code))n++}}if(n===3){console.log('FS_BOUNDARIES_DENIED');process.exit(91)}process.exit(4)`);
      fsVerified = positive.exitCode === 0 && positive.stdout.includes("FS_POSITIVE_OK") &&
        negative.exitCode === 91 && negative.stdout.includes("FS_BOUNDARIES_DENIED") &&
        fs.readFileSync(outside, "utf8") === "OUTSIDE_UNCHANGED" &&
        fs.readFileSync(path.join(workspace, "read.txt"), "utf8") === "READ_OK";
      details.push(`Filesystem positive=${positive.exitCode}, negative=${negative.exitCode}, verified=${fsVerified}`);
      // Identical destination and executable for both controls. A loader failure or timeout is never isolation evidence.
      const networkScript = "const n=require('net').connect(53,'1.1.1.1',()=>{console.log('NET_CONNECTED');n.destroy()});n.setTimeout(4000,()=>process.exit(94));n.on('error',e=>{console.log('NET_ERROR:'+e.code);process.exit(['EACCES','EPERM'].includes(e.code)?92:93)})";
      const allow = run(networkScript, true);
      const deny = run(networkScript, false);
      netAllowVerified = allow.exitCode === 0 && allow.stdout.includes("NET_CONNECTED");
      netDenyVerified = netAllowVerified && deny.exitCode === 92 && /NET_ERROR:(EACCES|EPERM)/.test(deny.stdout);
      details.push(`Network allow=${allow.exitCode}, deny=${deny.exitCode}, verified=${netDenyVerified}`);
      const timeout = run("console.log('JOB_STARTED');setInterval(()=>{},1000)", false, false, 1500);
      jobControlVerified = timeout.killed && timeout.stdout.includes("JOB_STARTED");
      details.push(`Job timeout verified=${jobControlVerified}`);
    } catch (error) {
      details.push(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    const verifiedAt = Date.now();
    const verification: WindowsSandboxVerificationResult = {
      helperPath: identity?.path, helperSha256: identity?.sha256,
      verifiedAt, verificationExpiresAt: verifiedAt + 86400000,
      filesystemIsolationVerified: fsVerified, networkDenyVerified: netDenyVerified,
      networkAllowVerified: netAllowVerified, jobObjectsControlVerified: jobControlVerified,
      status: fsVerified && netDenyVerified && jobControlVerified ? "VERIFIED" : probe.helperAvailable ? "DEGRADED" : "UNAVAILABLE",
      details,
    };
    this.cachedVerification = verification;
    if (this.cachedResult) {
      this.cachedResult.isolationStatus = verification.status;
      this.cachedResult.isolationVerification = verification;
    }
    return verification;
  }

  static resetCache(): void {
    this.cachedResult = undefined;
    this.cachedVerification = undefined;
    WindowsSandboxHelperManager.resetCache();
  }
}
