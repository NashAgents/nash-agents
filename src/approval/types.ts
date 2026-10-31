/**
 * 需要提权审批的能力类型
 */
export type ApprovalCapability =
  | "filesystem-write"
  | "filesystem-outside-workspace"
  | "network"
  | "mcp-local"
  | "full-access"
  | "mcp-registration"
  | "security-monitor"
  | `security-monitor:${string}`;

/**
 * 用户的审批裁决结果：
 * - allow-once: 仅针对本次单次操作放行，不改变全局策略
 * - deny: 拒绝本次操作
 */
export type ApprovalDecision = "allow-once" | "deny";

/**
 * 提权审批请求内容
 */
export interface ApprovalRequest {
  /**
   * 审批请求全局唯一 ID
   */
  id?: string;

  /**
   * 发起审批的 Agent 标识与元信息
   */
  agentId?: string;
  agentName?: string;
  agentType?: string;
  parentAgentId?: string;
  taskId?: string;

  /**
   * 触发审批的具体原因或上下文描述
   */
  reason: string;

  /**
   * 请求提升的安全能力维度
   */
  capability: ApprovalCapability;

  /**
   * 请求操作的目标（如文件路径或命令）
   */
  target?: string;

  /**
   * 触发审批的工具名称及参数摘要（脱敏后）
   */
  toolName?: string;
  toolArgsSummary?: string;

  /**
   * 发起请求时该 Agent 的当前策略快照
   */
  currentSandboxPolicy?: Record<string, unknown>;

  /**
   * 创建时间戳
   */
  createdAt?: number;
}

/**
 * 队列中处于等待决议状态的审批项
 */
export interface QueuedApprovalItem {
  id: string;
  request: ApprovalRequest;
  agentId: string;
  agentName: string;
  createdAt: number;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  yieldResumeSlot?: () => Promise<void>;
  abortSignal?: AbortSignal;
}

/**
 * 审批交互提供者接口（例如 CLI 提示、GUI 弹窗或测试 Mock）
 */
export interface ApprovalProvider {
  /**
   * 向用户展示审批请求并等待用户做出裁决
   */
  askApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  cancelApproval?(requestId: string): void;
}
