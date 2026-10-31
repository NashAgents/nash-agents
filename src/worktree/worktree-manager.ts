import * as crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execFile } from "node:child_process";
import type { WorktreeInfo, WorktreeMergeResult } from "./types.js";
import {
  WorktreeError,
  WorktreeCreateFailedError,
  DirtyWorkspaceError,
  WorktreeMergeConflictError,
} from "./errors.js";
import type { EventBus } from "../observability/event-bus.js";

export interface WorktreeManagerOptions {
  projectRoot?: string;
  worktreesDir?: string;
  eventBus?: EventBus;
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

/**
 * WorktreeManager - 管理多 Agent 的 Git Worktree 物理工作区隔离与合并
 *
 * 铁律：
 * 1. 默认共享 workspace，仅在明确需要独立分支隔离时创建 worktree；
 * 2. 严格检查主工作区未提交修改，拒绝静默基于旧 HEAD 产生版本分裂；
 * 3. 产生 Merge Conflict 时优雅捕获并抛出结构化 WorktreeMergeConflictError。
 */
export class WorktreeManager {
  private readonly projectRoot: string;
  private readonly worktreesDir: string;
  private readonly eventBus?: EventBus;
  private readonly protectedWorktrees = new Set<string>();
  private readonly activeWorktrees = new Map<string, WorktreeInfo>();

  constructor(options?: WorktreeManagerOptions) {
    this.projectRoot = path.resolve(options?.projectRoot ?? process.cwd());
    this.worktreesDir =
      options?.worktreesDir ??
      path.join(this.projectRoot, ".nash", "worktrees");
    this.eventBus = options?.eventBus;
  }

  getWorktree(agentId: string): WorktreeInfo | undefined {
    const info = this.activeWorktrees.get(agentId);
    return info ? { ...info } : undefined;
  }

  /**
   * 检查主工作区是否存在未提交的修改
   */
  async getDirtyFiles(): Promise<string[]> {
    const statusRes = await runGit(["status", "--porcelain", "-z"], this.projectRoot);
    if (statusRes.code !== 0) throw new WorktreeError("WORKTREE_STATUS_FAILED", statusRes.stderr);
    if (statusRes.stdout.trim() === "") {
      return [];
    }

    const entries = statusRes.stdout.split("\0"), files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry) continue;
      files.push(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2))) i++;
    }
    return files;
  }

  /**
   * 为指定 Agent 创建独立的 Git worktree 隔离工作区
   */
  async createWorktree(
    agentId: string,
    options?: { baseBranch?: string; allowDirty?: boolean }
  ): Promise<WorktreeInfo> {
    // 1. 严格检查主工作区是否处于 Dirty 状态
    const dirtyFiles = await this.getDirtyFiles();
    if (dirtyFiles.length > 0 && !options?.allowDirty) {
      throw new DirtyWorkspaceError(dirtyFiles);
    }

    const sanitizedAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const worktreePath = path.join(this.worktreesDir, sanitizedAgentId);
    const branchName = `nash-worktree/${sanitizedAgentId}-${Date.now().toString(36)}`;
    const baseBranch = options?.baseBranch ?? "HEAD";

    await fs.mkdir(this.worktreesDir, { recursive: true });

    // 若目录已存在，先尝试清理
    if (fsSync.existsSync(worktreePath)) {
      throw new WorktreeCreateFailedError(agentId, "Existing worktree must be reconciled before reuse");
    }

    // 执行 git worktree add -b <branchName> <worktreePath> <baseBranch>
    const res = await runGit(
      ["worktree", "add", "-b", branchName, worktreePath, baseBranch],
      this.projectRoot
    );

    if (res.code !== 0) {
      this.emitEvent("worktree.failed", {
        agentId,
        error: res.stderr,
      });
      throw new WorktreeCreateFailedError(agentId, res.stderr);
    }

    const info: WorktreeInfo = {
      agentId,
      worktreePath,
      branch: branchName,
      baseBranch,
      createdAt: Date.now(),
    };

    this.activeWorktrees.set(agentId, info);

    this.emitEvent("worktree.created", {
      agentId,
      worktreePath,
      branch: branchName,
    });

    return { ...info };
  }

  /**
   * 在 Worktree 隔离分支中自动提交所有修改
   */
  async commitChanges(
    agentId: string,
    commitMessage: string
  ): Promise<string | undefined> {
    const info = this.activeWorktrees.get(agentId);
    if (!info || !fsSync.existsSync(info.worktreePath)) {
      return undefined;
    }

    const added = await runGit(["add", "-A"], info.worktreePath);
    if (added.code !== 0) { this.protectedWorktrees.add(agentId); throw new WorktreeError("WORKTREE_COMMIT_FAILED", added.stderr); }
    const statusRes = await runGit(["status", "--porcelain"], info.worktreePath);
    if (statusRes.code !== 0) { this.protectedWorktrees.add(agentId); throw new WorktreeError("WORKTREE_STATUS_FAILED", statusRes.stderr); }
    if (statusRes.stdout.trim() === "") {
      return undefined;
    }

    const commitRes = await runGit(
      ["commit", "-m", commitMessage],
      info.worktreePath
    );

    if (commitRes.code === 0) {
      const hashRes = await runGit(["rev-parse", "HEAD"], info.worktreePath);
      return hashRes.stdout.trim();
    }

    this.protectedWorktrees.add(agentId);
    throw new WorktreeError("WORKTREE_COMMIT_FAILED", commitRes.stderr);
  }

  /**
   * 将 Agent 的 Worktree 分支合并回目标主分支，并自动检测冲突
   */
  async mergeWorktree(
    agentId: string,
    options?: { targetBranch?: string; commitMessage?: string }
  ): Promise<WorktreeMergeResult> {
    const info = this.activeWorktrees.get(agentId);
    if (!info) {
      throw new Error(`未找到 Agent '${agentId}' 的活跃 Worktree。`);
    }

    const commitHash = await this.commitChanges(
      agentId,
      options?.commitMessage ?? `feat(agent): changes from ${agentId}`
    );

    const mergeRes = await runGit(
      ["merge", "--no-ff", info.branch, "-m", `Merge branch '${info.branch}' from agent ${agentId}`],
      this.projectRoot
    );

    if (mergeRes.code !== 0) {
      this.protectedWorktrees.add(agentId);
      const statusRes = await runGit(["status", "--porcelain"], this.projectRoot);
      const conflictFiles: string[] = [];

      for (const line of statusRes.stdout.split("\n")) {
        if (/^(UU|AA|UD|DU|UA|AU)/.test(line.trim())) {
          conflictFiles.push(line.trim().slice(3).trim());
        }
      }

      await runGit(["merge", "--abort"], this.projectRoot);

      this.emitEvent("worktree.failed", {
        agentId,
        conflictFiles,
        error: "Merge conflict",
      });

      throw new WorktreeMergeConflictError(
        agentId,
        conflictFiles.length > 0 ? conflictFiles : ["(unknown conflict files)"]
      );
    }

    this.protectedWorktrees.delete(agentId);
    this.emitEvent("worktree.merged", {
      agentId,
      branch: info.branch,
      commitHash,
    });

    return {
      merged: true,
      commitHash,
      conflict: false,
    };
  }

  /**
   * 清理指定的 Worktree 目录及其临时分支
   */
  async cleanupWorktree(
    agentId: string,
    options?: { force?: boolean }
  ): Promise<void> {
    if (this.protectedWorktrees.has(agentId)) throw new WorktreeError("WORKTREE_PRESERVED", "Commit or merge failed; worktree retained for recovery");
    const info = this.activeWorktrees.get(agentId);
    const sanitizedAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const worktreePath = info?.worktreePath ?? path.join(this.worktreesDir, sanitizedAgentId);

    const removeArgs = ["worktree", "remove"];
    if (options?.force) {
      removeArgs.push("--force");
    }
    removeArgs.push(worktreePath);

    const removed = await runGit(removeArgs, this.projectRoot);
    if (removed.code !== 0) throw new WorktreeError("WORKTREE_CLEANUP_FAILED", removed.stderr);

    if (info?.branch) {
      await runGit(["branch", "-D", info.branch], this.projectRoot);
    }

    this.activeWorktrees.delete(agentId);
  }

  async cleanupAll(): Promise<void> {
    for (const agentId of Array.from(this.activeWorktrees.keys())) {
      await this.cleanupWorktree(agentId, { force: true });
    }
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: "worktree",
        sessionId: "worktree-session",
        data,
      });
    }
  }
}
