/**
 * 工作区隔离模式
 */
export type WorkspaceIsolationMode = "shared" | "worktree";

/**
 * Worktree 实例信息
 */
export interface WorktreeInfo {
  agentId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  createdAt: number;
}

/**
 * Worktree 合并结果
 */
export interface WorktreeMergeResult {
  merged: boolean;
  commitHash?: string;
  conflict: boolean;
  conflictFiles?: string[];
  summary?: string;
}
