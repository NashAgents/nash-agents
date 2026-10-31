import { resolveNashHome } from "../../config/data-home.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import cp from "node:child_process";
import { SandboxUnavailableError } from "../errors.js";
import { WindowsSandboxHelperManager } from "./sandbox-helper.js";

export interface SandboxRecoveryRecord {
  taskId: string;
  pid: number;
  processIdentity?: string;
  cleanupPending?: boolean;
  temporaryPaths?: string[];
  createdAt: number;
  profileName: string;
  sid?: string;
  allowedTraversePaths?: string[];
  allowedReadPaths: string[];
  allowedWritePaths: string[];
}

export interface CrashRecoveryResult {
  scanned: number;
  recovered: number;
  warnings: string[];
}

/**
 * Windows 原生沙箱崩溃恢复账本 (WindowsSandboxCrashRecoveryLedger)
 *
 * 核心安全职责：
 * 1. 事务性记录每一次 AppContainer Profile 与 DACL ACE 授权生命周期；
 * 2. 在宿主异常终止 (taskkill / 崩溃 / 断电重启) 导致 finally 无法触发时，提供离线对账清理能力；
 * 3. 在沙箱初始化与每次执行前自动扫描死亡进程遗留的孤儿 Profile 与 ACE，实施幂等清理并告警；
 * 4. 彻底杜绝全局 ACL 污染与 Windows 注册表孤儿 AppContainer 堆积。
 */
export class WindowsSandboxCrashRecoveryLedger {
  private static readonly LEDGER_DIR = path.join(resolveNashHome(), "sandbox");
  private static readonly LEDGER_FILE = path.join(WindowsSandboxCrashRecoveryLedger.LEDGER_DIR, "windows-recovery-ledger.json");

  private static recordPath(taskId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new SandboxUnavailableError("Invalid recovery task ID");
    return path.join(this.LEDGER_DIR, `windows-recovery-${taskId}.json`);
  }

  static readLedger(): SandboxRecoveryRecord[] {
    try {
      if (!fs.existsSync(this.LEDGER_DIR)) return [];
      const files = fs.readdirSync(this.LEDGER_DIR).filter(f => /^windows-recovery-.+\.json$/.test(f) && f !== "windows-recovery-ledger.json");
      const records = files.map(f => JSON.parse(fs.readFileSync(path.join(this.LEDGER_DIR, f), "utf8")) as SandboxRecoveryRecord);
      if (fs.existsSync(this.LEDGER_FILE)) records.push(...JSON.parse(fs.readFileSync(this.LEDGER_FILE, "utf8")));
      return records;
    } catch (error) {
      throw new SandboxUnavailableError(`Recovery ledger unreadable (Fail-Closed): ${String(error)}`);
    }
  }

  static processIdentity(pid: number): string | undefined {
    const helper = WindowsSandboxHelperManager.resolveHelperExecutablePath();
    if (!helper) return undefined;
    try {
      return cp.execFileSync(helper, ["--process-identity", String(pid)], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch { return undefined; }
  }

  static registerTransaction(record: SandboxRecoveryRecord): void {
    fs.mkdirSync(this.LEDGER_DIR, { recursive: true });
    const complete = { ...record, processIdentity: record.processIdentity ?? this.processIdentity(record.pid) };
    if (this.isProcessAlive(record.pid) && !complete.processIdentity) throw new SandboxUnavailableError("Cannot establish recovery owner identity");
    const file = this.recordPath(record.taskId);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(complete), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }

  static deregisterTransaction(taskId: string): void {
    fs.rmSync(this.recordPath(taskId), { force: true });
    if (fs.existsSync(this.LEDGER_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(this.LEDGER_FILE, "utf8")) as SandboxRecoveryRecord[];
      // Legacy entries are removed individually only after successful recovery.
      fs.writeFileSync(this.LEDGER_FILE, JSON.stringify(legacy.filter(r => r.taskId !== taskId)));
    }
  }

  static completeTransaction(taskId: string): void {
    const record = this.readLedger().find(r => r.taskId === taskId);
    if (!record) return;
    const helper = WindowsSandboxHelperManager.resolveHelperExecutablePath();
    if (!helper || !record.sid) throw new SandboxUnavailableError("Cannot revoke sandbox transaction without helper and SID");
    this.registerTransaction({ ...record, cleanupPending: true });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        cp.execFileSync(helper, ["--cleanup-json", JSON.stringify(record)], { timeout: 15000, stdio: "ignore" });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    if (lastErr) throw lastErr;
    this.deregisterTransaction(taskId);
  }

  private static cleanupTemporaryPaths(record: SandboxRecoveryRecord): void {
    const tempRoot = fs.realpathSync.native(os.tmpdir()).toLowerCase();
    for (const target of record.temporaryPaths ?? []) {
      if (!fs.existsSync(target)) continue;
      const targetReal = fs.realpathSync.native(target);
      const parentReal = fs.realpathSync.native(path.dirname(targetReal)).toLowerCase();
      if (fs.lstatSync(targetReal).isSymbolicLink() ||
          parentReal !== tempRoot ||
          !/^nash-task-tmp-\d+-[a-f0-9]{8}$/.test(path.basename(targetReal))) {
        throw new SandboxUnavailableError("Untrusted recovery temporary path");
      }
      fs.rmSync(targetReal, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  /**
   * 判断指定 PID 的进程是否仍存活
   */
  static isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as any)?.code;
      // EPERM 说明进程存在但无权限发信号，依然判定存活
      return code === "EPERM";
    }
  }

  /**
   * 扫描并清理孤儿资源 (Crash Recovery)
   */
  static recoverOrphans(): CrashRecoveryResult {
    const records = this.readLedger();
    if (records.length === 0) {
      return { scanned: 0, recovered: 0, warnings: [] };
    }

    const helperPath = WindowsSandboxHelperManager.resolveHelperExecutablePath();
    const survivingRecords: SandboxRecoveryRecord[] = [];
    const warnings: string[] = [];
    let recoveredCount = 0;

    for (const record of records) {
      const currentIdentity = this.processIdentity(record.pid);
      const alive = (!record.cleanupPending || record.pid !== process.pid) && this.isProcessAlive(record.pid) &&
        (!record.processIdentity || currentIdentity === record.processIdentity);
      if (!record.cleanupPending && this.isProcessAlive(record.pid) && !currentIdentity) {
        warnings.push(`[CrashRecovery] Owner identity unavailable: ${record.taskId}`);
        survivingRecords.push(record);
        continue;
      }
      if (alive) {
        // 对应任务进程仍在运行，保留账本
        survivingRecords.push(record);
        continue;
      }

      // 进程已死亡，属于异常崩溃遗留！立即执行幂等清理


      let failed = false;
      if (!helperPath || (!record.sid && (record.allowedReadPaths.length || record.allowedWritePaths.length))) {
        warnings.push(`[CrashRecovery] Missing helper or SID: ${record.taskId}`);
        survivingRecords.push(record);
        continue;
      }
      // 1. 撤销文件系统 ACE 权限
      if (helperPath && record.sid) {
        const allPaths = [...new Set([...record.allowedReadPaths, ...record.allowedWritePaths, ...(record.allowedTraversePaths ?? [])])];
        for (const p of allPaths) {
          try {
            if (fs.existsSync(p)) {
              cp.execFileSync(helperPath, ["--revoke-acl", record.sid, p], {
                encoding: "utf-8",
                timeout: 3000,
                stdio: ["ignore", "pipe", "pipe"],
              });
            }
          } catch (e: any) {
            failed = true;
            warnings.push(`[CrashRecovery] 撤销 ACE 失败 (${p}): ${e.message}`);
          }
        }
      }

      // 2. 销毁 AppContainer Profile
      if (helperPath && record.profileName) {
        let profileDeleted = false;
        let lastErr: any;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            cp.execFileSync(helperPath, ["--cleanup-profile", record.profileName], {
              encoding: "utf-8",
              timeout: 3000,
              stdio: ["ignore", "pipe", "pipe"],
            });
            profileDeleted = true;
            break;
          } catch (e: any) {
            lastErr = e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          }
        }
        if (!profileDeleted) {
          failed = true;
          warnings.push(`[CrashRecovery] 销毁 Profile 失败 (${record.profileName}): ${lastErr?.message}`);
        }
      }

      if (!failed) {
        try { this.cleanupTemporaryPaths(record); }
        catch (error) { failed = true; warnings.push(`Recovery temporary cleanup failed: ${String(error)}`); }
      }
      if (failed) survivingRecords.push(record);
      else { this.deregisterTransaction(record.taskId); recoveredCount++; }
    }

    // 更新持久化账本
    // Failed recoveries retain their per-task records for retry.

    return {
      scanned: records.length,
      recovered: recoveredCount,
      warnings,
    };
  }
}
