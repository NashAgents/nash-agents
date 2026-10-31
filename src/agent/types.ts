/**
 * Agent 类型分类
 */
export type AgentType = "main" | "subagent" | "team-lead" | "team-member";

/**
 * Agent 运行生命周期状态
 */
export type AgentStatus =
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

/**
 * 统一 Agent 记录结构（轻量元数据，严禁复制完整 Session / 聊天内容）
 */
export interface AgentRecord {
  agentId: string;
  name?: string;
  parentAgentId?: string;

  type: AgentType;
  status: AgentStatus;

  /**
   * 当前正在处理的 Task ID
   */
  currentTaskId?: string;

  /**
   * 调用层级嵌套深度（Main 为 0，直接 SubAgent 为 1...）
   */
  depth: number;

  /**
   * 角色专业领域标识 (如 "backend", "frontend", "researcher")
   */
  role?: string;

  /**
   * 角色定位描述
   */
  roleDescription?: string;

  /**
   * 绑定的隔离工作区路径（当使用 Git worktree 时指定）
   */
  worktreePath?: string;

  createdAt: number;
  updatedAt: number;
  completedAt?: number;

  error?: {
    code?: string;
    message: string;
    stack?: string;
  };
}

/**
 * 创建/注册 Agent 输入
 */
export interface RegisterAgentInput {
  agentId?: string;
  name?: string;
  parentAgentId?: string;
  type: AgentType;
  status?: AgentStatus;
  depth?: number;
  role?: string;
  roleDescription?: string;
  worktreePath?: string;
  currentTaskId?: string;
}
