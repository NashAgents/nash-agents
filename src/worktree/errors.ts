/**
 * Worktree 隔离与合并强类型错误
 */

export class WorktreeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorktreeError";
    this.code = code;
  }
}

export class WorktreeCreateFailedError extends WorktreeError {
  readonly agentId: string;
  readonly originalError?: string;

  constructor(agentId: string, originalError?: string) {
    super(
      "WORKTREE_CREATE_FAILED",
      `创建 Agent '${agentId}' 的 Git worktree 隔离工作区失败${
        originalError ? `: ${originalError}` : ""
      }。`
    );
    this.name = "WorktreeCreateFailedError";
    this.agentId = agentId;
    this.originalError = originalError;
  }
}

export class DirtyWorkspaceError extends WorktreeError {
  readonly dirtyFiles: string[];

  constructor(dirtyFiles: string[]) {
    super(
      "DIRTY_WORKSPACE",
      `当前主工作区存在未提交的在途修改，无法直接创建安全的 Worktree 隔离分支。\n` +
        `未提交文件: [${dirtyFiles.join(", ")}]\n` +
        `为防止子 Agent 基于旧 HEAD 产生版本错乱，请先在主工作区 commit 或 stash 暂存修改。`
    );
    this.name = "DirtyWorkspaceError";
    this.dirtyFiles = dirtyFiles;
  }
}

export class WorktreeMergeConflictError extends WorktreeError {
  readonly agentId: string;
  readonly conflictFiles: string[];

  constructor(agentId: string, conflictFiles: string[]) {
    super(
      "WORKTREE_MERGE_CONFLICT",
      `合并 Agent '${agentId}' 的 Worktree 分支时发生代码冲突: [${conflictFiles.join(
        ", "
      )}]。\n请由 Lead Agent 或用户介入解决冲突。`
    );
    this.name = "WorktreeMergeConflictError";
    this.agentId = agentId;
    this.conflictFiles = conflictFiles;
  }
}
