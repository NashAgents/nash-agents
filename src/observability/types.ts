/**
 * Nash Agent 统一强类型事件名称枚举
 */
export type HarnessEventType =
  // Agent Run 级别事件
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.spawned"
  | "agent.running"
  | "agent.waiting"
  | "agent.interrupted"
  | "agent.steered"
  // Task 级别事件
  | "task.created"
  | "task.ready"
  | "task.started"
  | "task.blocked"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.outcome_unknown"
  | "task.superseded"
  | "task.owner_changed"
  // Team 级别事件
  | "team.created"
  | "team.member_added"
  | "team.member_removed"
  | "team.message.sent"
  | "team.message.delivered"
  // Workflow 级别事件
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  // Plan Mode 级别事件
  | "plan.entered"
  | "plan.proposed"
  | "plan.approved"
  | "plan.rejected"
  | "plan.exited"
  | "plan.patch_started"
  | "plan.patch_completed"
  // 用户运行期交互事件
  | "user.steer_queued"
  | "user.steer_applied"
  | "user.queue_appended"
  | "user.interrupted"
  // 文件版本与冲突事件
  | "file.modified"
  | "file.stale_version"
  | "file.write_scope_conflict"
  // Worktree 隔离事件
  | "worktree.created"
  | "worktree.merged"
  | "worktree.failed"
  // 模型调用级别事件
  | "runtime.span"
  | "model.usage"
  | "model.started"
  | "model.completed"
  | "model.failed"
  | "model.thought_delta"
  | "model.content_delta"
  // 工具执行级别事件
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "tool.result"
  // 后台 Job 级别事件
  | "job.created"
  | "job.started"
  | "job.promoted"
  | "job.completed"
  | "job.failed"
  | "job.cancelled"
  | "job.timed_out"
  | "job.output_updated"
  // 沙箱与审批事件
  | "sandbox.denied"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "approval.resolved"
  // 安全审查级别事件
  | "security.blocked"
  | "security.approval_denied"
  | "security.auto_granted"
  | "security.evaluated"
  // 上下文治理与溢出事件
  | "context.spilled"
  | "context.pruned"
  | "context.compaction.started"
  | "context.compaction.completed"
  | "context.compaction.failed"
  // 会话级别事件
  | "session.started"
  | "session.completed"
  | "session.synthetic_compensation_failed"
  // 记忆与技能事件
  | "memory.recalled"
  | "memory.created"
  | "memory.updated"
  | "memory.deprecated"
  | "skill.discovered"
  | "skill.loaded"
  // MCP 协议与服务事件
  | "mcp.server.connecting"
  | "mcp.server.connected"
  | "mcp.server.disconnected"
  | "mcp.server.reconnecting"
  | "mcp.server.failed"
  | "mcp.tools.updated"
  // 集群协调、会话与分布式探查事件 (Cluster & Coordinator)
  | "coordinator.turn_started"
  | "coordinator.turn_completed"
  | "coordinator.turn_cancelled"
  | "coordinator.turn_interrupted"
  | "coordinator.task_dispatched"
  | "coordinator.phase"
  | "discovery.started"
  | "discovery.scout_dispatched"
  | "discovery.scout_completed"
  | "discovery.completed"
  | "conversation.message_created"
  | "conversation.message_updated"
  | "task.progress";

/**
 * 统一强类型事件结构
 */
export interface HarnessEvent<T = Record<string, unknown>> {
  id: string;
  type: HarnessEventType;
  timestamp: string; // ISO 8601

  projectId: string;
  sessionId: string;

  traceId?: string;
  spanId?: string;
  parentSpanId?: string;

  agentId?: string;
  agentName?: string;
  agentType?: string;
  taskId?: string;

  data: T;
}

/**
 * Trace Span 状态
 */
export type SpanStatus = "ok" | "error" | "unset";

/**
 * 脱敏后的错误记录
 */
export interface RedactedErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Trace Span 记录结构
 */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;

  name: string;

  startTime: number; // Unix 时间戳 (ms)
  endTime?: number;
  durationMs?: number;

  status: SpanStatus;
  attributes: Record<string, unknown>;
  error?: RedactedErrorInfo;
}

/**
 * Span 树节点结构（用于还原单次 Agent Run 的调用层次树）
 */
export interface SpanTreeNode {
  span: SpanRecord;
  children: SpanTreeNode[];
}

/**
 * 指标快照统计结构
 */
export interface MetricsSnapshot {
  // Agent 维度
  agentRuns: number;
  agentSuccess: number;
  agentFailures: number;
  agentDurationMs: number;

  // Model 维度
  modelCalls: number;
  modelFailures: number;
  modelLatencyMs: number;
  inputTokens: number;
  outputTokens: number;

  // Tool 维度
  toolCalls: number;
  toolFailures: number;
  toolLatencyMs: number;
  perToolCallCount: Record<string, number>;

  // Context 维度
  spills: number;
  spilledBytes: number;
  prunes: number;
  compactions: number;
  compactionFailures: number;

  // Sandbox / Approval 维度
  sandboxDenied: number;
  approvalRequested: number;
  approvalGranted: number;
  approvalDenied: number;
}

/**
 * OpenTelemetry 配置定义
 */
export interface OpenTelemetryConfig {
  enabled: boolean;
  endpoint: string;
  traces: boolean;
  metrics: boolean;
  logs: boolean;
  serviceName: string;
  timeoutMs?: number;
}

/**
 * Observability 全局配置结构
 */
export interface ObservabilityConfig {
  enabled: boolean;
  consoleSummary: boolean;
  otel: OpenTelemetryConfig;
}

/**
 * 默认 Observability 配置
 */
export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enabled: true,
  consoleSummary: true,
  otel: {
    enabled: false,
    endpoint: "http://localhost:4318",
    traces: true,
    metrics: true,
    logs: true,
    serviceName: "nash-agent",
    timeoutMs: 5000,
  },
};
