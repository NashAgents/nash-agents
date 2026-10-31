import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import * as crypto from "node:crypto";
import type { SandboxPolicy } from "./types.js";
import { cloneSandboxPolicy } from "./policy.js";
import {
  FilesystemAccessDeniedError,
  ApprovalDeniedError,
} from "./errors.js";
import type { ApprovalService } from "../approval/approval-service.js";
import {
  FileObservationStore,
  defaultFileObservationStore,
} from "../filesystem/file-observation-store.js";
import {
  FileLockManager,
  defaultFileLockManager,
  resolveCanonicalPhysicalPath,
} from "../filesystem/file-lock-manager.js";
import { isPathInScope } from "../filesystem/write-scope.js";
import { StaleFileVersionError } from "../filesystem/errors.js";
import type { EventBus } from "../observability/event-bus.js";
import {
  isWindowsReservedDevice,
  hasAlternateDataStream,
  isInsideWorkspaceWindows,
} from "./windows/path-utils.js";

export interface FileSystemAccessOptions {
  /**
   * 工作区根目录路径，默认为 process.cwd()
   */
  workspaceRoot?: string;

  /**
   * 当前生效的沙箱安全策略
   */
  policy: SandboxPolicy;

  /**
   * 审批交互服务（若未提供，所有越界/违规操作直接 Fail-Closed 拒绝）
   */
  approvalService?: ApprovalService;

  /**
   * 当前绑定的 Agent ID（用于多 Agent 文件版本观察）
   */
  agentId?: string;

  /**
   * 当前任务约束的文件写范围 (如 ["src/auth/**"])
   */
  writeScopes?: string[];

  /**
   * 文件观察版本存储实例
   */
  observationStore?: FileObservationStore;

  /**
   * 文件互斥锁管理器
   */
  lockManager?: FileLockManager;

  /**
   * 事件总线
   */
  eventBus?: EventBus;
}

/**
 * 统一文件系统安全访问控制层 (FileSystemAccess)
 *
 * 核心设计目标：
 * 1. 统一收口所有文件操作的安全边界；
 * 2. 严格按 SandboxPolicy 的模式 (read-only, workspace-write, danger-full-access) 实施强制访问检查；
 * 3. 拦截多 Agent 文件写冲突（writeScopes 越界检查 + SHA-256 Stale Version 过期检查）；
 * 4. 基于 FileLockManager 提供文件级原子“校验 -> 写入 -> 更新版本”临界区保护；
 * 5. 深度联动 ApprovalService 支持提权；
 * 6. 屏蔽跨目录逃逸攻击。
 */
export class FileSystemAccess {
  private readonly workspaceRoot: string;
  private policy: SandboxPolicy;
  private readonly approvalService?: ApprovalService;
  private readonly agentId?: string;
  private readonly writeScopes?: string[];
  private readonly observationStore: FileObservationStore;
  private readonly lockManager: FileLockManager;
  private readonly eventBus?: EventBus;

  constructor(options: FileSystemAccessOptions) {
    const rawRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.workspaceRoot = process.platform === "win32"
      ? rawRoot.replace(/^[a-zA-Z]:/, (m) => m.toUpperCase())
      : rawRoot;
    this.policy = cloneSandboxPolicy(options.policy);
    this.approvalService = options.approvalService;
    this.agentId = options.agentId;
    this.writeScopes = options.writeScopes ? [...options.writeScopes] : undefined;
    this.observationStore = options.observationStore ?? defaultFileObservationStore;
    this.lockManager = options.lockManager ?? defaultFileLockManager;
    this.eventBus = options.eventBus;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  getPolicy(): SandboxPolicy {
    return cloneSandboxPolicy(this.policy);
  }

  /**
   * 运行时安全升级沙箱策略（由 TaskSecurityGrant 授权调用）
   */
  updatePolicy(newPolicy: SandboxPolicy): void {
    this.policy = cloneSandboxPolicy(newPolicy);
  }

  getAgentId(): string | undefined {
    return this.agentId;
  }

  getWriteScopes(): string[] | undefined {
    return this.writeScopes ? [...this.writeScopes] : undefined;
  }

  private getCanonicalPath(rawPath: string): string {
    return resolveCanonicalPhysicalPath(rawPath);
  }

  isOutsideWorkspace(targetPath: string): boolean {
    if (process.platform === "win32") {
      return !isInsideWorkspaceWindows(targetPath, this.workspaceRoot);
    }
    const canonicalTarget = resolveCanonicalPhysicalPath(targetPath);
    const canonicalRoot = resolveCanonicalPhysicalPath(this.workspaceRoot);
    const relative = path.relative(canonicalRoot, canonicalTarget);
    return (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      relative.startsWith("../") ||
      relative.startsWith("..\\") ||
      path.isAbsolute(relative)
    );
  }

  /**
   * 校验读取权限，并在文件存在时记录 Agent 观测到的 SHA-256 哈希
   */
  async resolveForRead(
    inputPath: string,
    options?: { agentId?: string; observe?: boolean }
  ): Promise<string> {
    const targetPath = this.normalizeInputPath(inputPath);
    const mode = this.policy.filesystem.mode;
    const effectiveAgentId = options?.agentId ?? this.agentId;

    let allowedPath: string | undefined;

    // Windows 保留设备名称与 ADS 语法拦截
    if (process.platform === "win32") {
      if (isWindowsReservedDevice(inputPath) || isWindowsReservedDevice(targetPath)) {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "read",
          `安全限制：Windows 保留设备名称 (CON, PRN, AUX, NUL, COM*, LPT*) 严禁访问。`
        );
      }
      if (hasAlternateDataStream(inputPath) || hasAlternateDataStream(targetPath)) {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "read",
          `安全限制：Windows Alternate Data Streams (ADS) 语法严禁访问。`
        );
      }
    }

    // 系统底层特权与敏感只读文件保护列表
    const normLower = this.getCanonicalPath(targetPath).toLowerCase().replace(/\\/g, "/").replace(/^\/private\/etc(?=\/|$)/, "/etc");
    const isSensitiveSystemFile =
      normLower === "/etc/shadow" ||
      normLower === "/etc/sudoers" ||
      normLower === "/etc/master.passwd" ||
      (process.platform === "win32" && (
        normLower.includes("system32/config/sam") ||
        normLower.includes("system32/config/system") ||
        normLower.includes("system32/config/security") ||
        normLower.endsWith("/pagefile.sys") ||
        normLower.endsWith("/hiberfil.sys") ||
        normLower.includes("system volume information")
      ));

    if (isSensitiveSystemFile) {
      throw new FilesystemAccessDeniedError(
        inputPath,
        "read",
        `安全限制：拒绝读取操作系统核心特权敏感文件 '${inputPath}'。`
      );
    }

    if (mode === "danger-full-access" || mode === "full-capability") {
      // Full Capability 与 Danger Full Access 模式：允许读取合法常规外部与内部路径
      allowedPath = targetPath;
    } else {
      const outside = this.isOutsideWorkspace(targetPath);
      if (!outside) {
        allowedPath = targetPath;
      } else if (this.policy.approval.mode === "auto-grant") {
        // 安全边界铁律：approval 只决定「允许的审批如何获得授权」，
        // 绝不能单独把明确的 filesystem 边界 (read-only / workspace-write) 放宽为全盘访问。
        // 需要跨工作区读取时必须由管理员授予该 Task/Run 全访问，或显式切换全局策略。
        throw new FilesystemAccessDeniedError(
          inputPath,
          "read",
          `当前策略明确限制文件系统边界 (filesystem: ${mode})，approval: auto-grant 不能放宽该边界；` +
          `如需读取工作区外路径，请由管理员授予该 Task/Run 全访问，或将全局策略切换为 full-capability / danger-full-access。`
        );
      } else if (this.policy.approval.mode === "ask" && this.approvalService) {
        const decision = await this.approvalService.requestApproval(
          {
            capability: "filesystem-outside-workspace",
            target: inputPath,
            reason: `Agent 试图读取工作区外部的路径 '${inputPath}'。当前工作区为 '${this.workspaceRoot}'。`,
            agentId: effectiveAgentId,
          },
          { agentId: effectiveAgentId }
        );

        if (decision === "allow-once") {
          allowedPath = targetPath;
        } else {
          throw new ApprovalDeniedError(
            "filesystem-outside-workspace",
            inputPath,
            `用户拒绝了读取工作区外路径 '${inputPath}' 的审批请求。`
          );
        }
      } else {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "read",
          `安全限制：拒绝访问工作区根目录之外的路径 '${inputPath}'。当前工作区为 '${this.workspaceRoot}'。`
        );
      }
    }

    // 记录文件观察哈希
    if (options?.observe !== false && effectiveAgentId && allowedPath && fsSync.existsSync(allowedPath)) {
      try {
        const stat = await fs.stat(allowedPath);
        if (stat.isFile()) {
          const hash = await FileObservationStore.computeFileHash(allowedPath);
          if (hash) this.observationStore.recordObservation(effectiveAgentId, allowedPath, hash);
        }
      } catch {}
    }

    return allowedPath;
  }

  /**
   * 校验写入权限，并在修改前严格检查：
   * 1. writeScopes 范围约束；
   * 2. Stale Version 版本一致性校验。
   */
  async resolveForWrite(
    inputPath: string,
    options?: { agentId?: string; checkStale?: boolean; skipApproval?: boolean }
  ): Promise<string> {
    const targetPath = this.normalizeInputPath(inputPath);
    const mode = this.policy.filesystem.mode;
    const effectiveAgentId = options?.agentId ?? this.agentId;
    const checkStale = options?.checkStale ?? true;

    if (mode !== "danger-full-access") {
      try {
        const info = fsSync.statSync(targetPath);
        if (info.isFile() && info.nlink > 1) {
          throw new FilesystemAccessDeniedError(inputPath, "write", "受限写入禁止修改具有多个硬链接的文件。");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    // Windows 保留设备名称与 ADS 语法拦截
    if (process.platform === "win32") {
      if (isWindowsReservedDevice(inputPath) || isWindowsReservedDevice(targetPath)) {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `安全限制：Windows 保留设备名称 (CON, PRN, AUX, NUL, COM*, LPT*) 严禁访问。`
        );
      }
      if (hasAlternateDataStream(inputPath) || hasAlternateDataStream(targetPath)) {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `安全限制：Windows Alternate Data Streams (ADS) 语法严禁访问。`
        );
      }
    }

    // 1. 校验 writeScopes 范围约束
    if (this.writeScopes && this.writeScopes.length > 0) {
      const relPath = path.relative(this.getCanonicalPath(this.workspaceRoot), this.getCanonicalPath(targetPath)).replace(/\\/g, "/") || ".";
      const inScope = this.writeScopes.some((scope) =>
        isPathInScope(relPath, scope)
      );

      if (!inScope) {
        this.emitEvent("file.write_scope_conflict", {
          targetPath: relPath,
          writeScopes: this.writeScopes,
          agentId: effectiveAgentId,
        });

        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `安全限制：目标路径 '${relPath}' 超出了当前任务声明的 writeScopes [${this.writeScopes.join(
            ", "
          )}]。`
        );
      }
    }

    // 2. 基础沙箱权限校验
    let allowedPath: string | undefined;

    if (mode === "danger-full-access") {
      allowedPath = targetPath;
    } else if (mode === "full-capability") {
      // 操作系统底层核心系统目录保护，防止破坏 OS 关键底座
      const normLower = this.getCanonicalPath(targetPath).toLowerCase().replace(/\\/g, "/").replace(/^\/private\/etc(?=\/|$)/, "/etc");
      const isSystemProtectedDir =
        normLower.startsWith("/system") ||
        (normLower === "/etc" || normLower.startsWith("/etc/")) ||
        (normLower === "/boot" || normLower.startsWith("/boot/")) ||
        (normLower === "/sbin" || normLower.startsWith("/sbin/")) ||
        (normLower === "/dev" || normLower.startsWith("/dev/")) ||
        (normLower === "/proc" || normLower.startsWith("/proc/")) ||
        (normLower === "/sys" || normLower.startsWith("/sys/")) ||
        (process.platform === "win32" && (
          normLower.includes("system32/config") ||
          normLower.includes("system32/drivers/etc/hosts") ||
          normLower.includes("/windows/system32") ||
          normLower.endsWith("/pagefile.sys") ||
          normLower.endsWith("/hiberfil.sys")
        ));

      if (isSystemProtectedDir) {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `安全限制：Full Capability 模式严禁写入操作系统底座关键系统目录 '${inputPath}'。`
        );
      }
      allowedPath = targetPath;
    } else if (mode === "read-only") {
      if (options?.skipApproval) {
        allowedPath = targetPath;
      } else if (this.policy.approval.mode === "auto-grant") {
        // 安全边界铁律：approval: auto-grant 不能把显式的 read-only 放宽为可写。
        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `当前策略为 read-only，approval: auto-grant 不能放宽文件系统边界；` +
          `如需写入，请由管理员授予该 Task/Run 全访问，或将全局策略切换为可写模式。`
        );
      } else if (this.policy.approval.mode === "ask" && this.approvalService) {
        const decision = await this.approvalService.requestApproval(
          {
            capability: "filesystem-write",
            target: inputPath,
            reason: `当前沙箱处于 read-only 模式，Agent 试图向 '${inputPath}' 写入文件。`,
            agentId: effectiveAgentId,
          },
          { agentId: effectiveAgentId }
        );

        if (decision === "allow-once") {
          allowedPath = targetPath;
        } else {
          throw new ApprovalDeniedError(
            "filesystem-write",
            inputPath,
            `用户拒绝了在只读模式下写入路径 '${inputPath}' 的审批请求。`
          );
        }
      } else {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `安全限制：当前沙箱策略为 read-only，严禁对路径 '${inputPath}' 执行写入操作。`
        );
      }
    } else {
      // workspace-write
      const outside = this.isOutsideWorkspace(targetPath);
      if (!outside) {
        allowedPath = targetPath;
      } else if (options?.skipApproval) {
        allowedPath = targetPath;
      } else if (this.policy.approval.mode === "auto-grant") {
        // 安全边界铁律：approval: auto-grant 不能把 workspace-write 放宽为工作区外可写。
        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `当前策略明确限制工作区外写入 (filesystem: workspace-write)，approval: auto-grant 不能放宽该边界；` +
          `如需写入工作区外路径，请由管理员授予该 Task/Run 全访问，或将全局策略切换为 danger-full-access。`
        );
      } else if (this.policy.approval.mode === "ask" && this.approvalService) {
        const decision = await this.approvalService.requestApproval(
          {
            capability: "filesystem-outside-workspace",
            target: inputPath,
            reason: `Agent 试图写入工作区外部的路径 '${inputPath}'。当前工作区为 '${this.workspaceRoot}'。`,
            agentId: effectiveAgentId,
          },
          { agentId: effectiveAgentId }
        );

        if (decision === "allow-once") {
          allowedPath = targetPath;
        } else {
          throw new ApprovalDeniedError(
            "filesystem-outside-workspace",
            inputPath,
            `用户拒绝了写入工作区外路径 '${inputPath}' 的审批请求。`
          );
        }
      } else {
        throw new FilesystemAccessDeniedError(
          inputPath,
          "write",
          `安全限制：拒绝访问工作区根目录之外的路径 '${inputPath}'。当前工作区为 '${this.workspaceRoot}'。`
        );
      }
    }

    // 3. Stale Version 版本一致性校验
    if (checkStale && effectiveAgentId && allowedPath && fsSync.existsSync(allowedPath)) {
      try {
        const stat = await fs.stat(allowedPath);
        if (stat.isFile()) {
          const lastObserved = this.observationStore.getLastObservation(
            effectiveAgentId,
            allowedPath
          );

          if (lastObserved) {
            const currentBuffer = await fs.readFile(allowedPath);
            const currentHash = FileObservationStore.computeHash(currentBuffer);

            if (lastObserved !== currentHash) {
              const rel = this.toRelativePath(allowedPath);
              this.emitEvent("file.stale_version", {
                filePath: rel,
                agentId: effectiveAgentId,
                lastObservedHash: lastObserved,
                currentDiskHash: currentHash,
              });

              throw new StaleFileVersionError(
                rel,
                lastObserved,
                currentHash
              );
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof StaleFileVersionError) {
          throw err;
        }
      }
    }

    return allowedPath;
  }

  /**
   * 在细粒度文件路径互斥锁保护下执行原子写操作（校验 -> 写入 -> 更新 Hash 在单一原子临界区中完成）
   *
   * 铁律：
   * 1. 锁外预完成人机审批交互，绝不在互斥锁内等待人类决策（杜绝级联死锁）；
   * 2. 锁内进行 TOCTOU 二次校验（确保父目录在排队期间未被篡改为符号链接）；
   * 3. 锁内执行 Stale Version 原子比对与物理写盘。
   *
   * @param inputPath - 目标写入路径
   * @param writer - 实际物理写入回调函数 (如执行 fs.writeFile)
   * @param options - 附加配置
   */
  async executeAtomicWrite<T>(
    inputPath: string,
    writer: (resolvedPath: string) => Promise<T>,
    options?: { agentId?: string; checkStale?: boolean }
  ): Promise<T> {
    const effectiveAgentId = options?.agentId ?? this.agentId;

    const targetPath = this.normalizeInputPath(inputPath);
    const approvedPhysicalPath = this.getCanonicalPath(targetPath);

    // 1. 锁外完成权限预检与人机审批（若需要）
    await this.resolveForWrite(inputPath, {
      ...options,
      checkStale: false,
      skipApproval: false,
    });

    // 2. 获取细粒度文件路径互斥锁
    return await this.lockManager.withLock(approvedPhysicalPath, async () => {
      if (this.getCanonicalPath(targetPath) !== approvedPhysicalPath) {
        throw new FilesystemAccessDeniedError(inputPath, "write", "安全拦截 (TOCTOU)：审批或等待文件锁期间目标物理路径发生变化。");
      }

      // 4. 在锁保护内安全校验 Stale Version (跳过已在锁外完成的审批)
      const resolvedPath = await this.resolveForWrite(inputPath, {
        ...options,
        checkStale: options?.checkStale ?? true,
        skipApproval: true,
      });

      // 5. 在锁保护内执行物理写入
      const before = await fs.readFile(resolvedPath).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT" || err.code === "EISDIR") return undefined; throw err; });
      const result = await writer(resolvedPath);
      const after = await fs.readFile(resolvedPath);
      if (!before || !before.equals(after)) this.emitEvent("file.modified", { path: resolvedPath, relativePath: this.toRelativePath(resolvedPath).replaceAll("\\", "/"), beforeSha256: before ? crypto.createHash("sha256").update(before).digest("hex") : null, afterSha256: crypto.createHash("sha256").update(after).digest("hex") });

      // 6. 在锁保护内立即计算并刷新 Agent 观测到的最新 Hash
      if (effectiveAgentId && fsSync.existsSync(resolvedPath)) {
        try {
          const buffer = await fs.readFile(resolvedPath);
          this.observationStore.recordObservation(
            effectiveAgentId,
            resolvedPath,
            buffer
          );
        } catch {}
      }

      return result;
    });
  }

  /**
   * 手动更新或重置 Agent 对文件的观察哈希
   */
  recordFileWritten(
    targetPath: string,
    content: string | Buffer,
    agentId?: string
  ): void {
    const effectiveAgentId = agentId ?? this.agentId;
    if (effectiveAgentId) {
      this.observationStore.recordObservation(
        effectiveAgentId,
        targetPath,
        content
      );
    }
  }

  toRelativePath(targetPath: string): string {
    const resolved = path.resolve(this.workspaceRoot, targetPath);
    const rel = path.relative(this.workspaceRoot, resolved);
    if (rel === "") {
      return ".";
    }
    return process.platform === "win32" ? rel.replace(/\\/g, "/") : rel;
  }

  private normalizeInputPath(inputPath: string): string {
    if (typeof inputPath !== "string") {
      throw new Error("路径参数必须为非空字符串。");
    }

    const trimmed = inputPath.trim();
    if (trimmed === "") {
      return this.workspaceRoot;
    }

    const resolved = path.resolve(this.workspaceRoot, trimmed);
    return process.platform === "win32"
      ? resolved.replace(/^[a-zA-Z]:/, (m) => m.toUpperCase())
      : resolved;
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: "filesystem",
        sessionId: "sandbox",
        data,
      });
    }
  }
}
