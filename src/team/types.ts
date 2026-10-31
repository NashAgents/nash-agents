import type { AgentRecord } from "../agent/types.js";

/**
 * Team 内部点对点与广播消息结构
 */
export interface TeamMessage {
  type: "team_message";
  teamId: string;
  messageId: string;
  senderAgentId: string;
  senderName?: string;
  targetAgentId: string; // 指定接收方 agentId，或 "*" 代表广播给全体成员
  content: string;
  createdAt: number;
}

/**
 * 团队成员配置元数据
 */
export interface TeamMemberConfig {
  agentId?: string;
  name: string;
  role: string;
  roleDescription: string;
  systemPrompt?: string;
  writeScopes?: string[];
  worktreePath?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 团队实体接口
 */
export interface Team {
  teamId: string;
  name: string;
  leaderId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 团队变更等待事件类型
 */
export type TeamChangeEventReason =
  | "task_ready"
  | "task_completed"
  | "task_failed"
  | "task_blocked"
  | "task_assigned"
  | "mail_received"
  | "member_status_changed"
  | "interrupted"
  | "timeout";

/**
 * 团队变更唤醒通知结构
 */
export interface TeamChangeNotification {
  reason: TeamChangeEventReason;
  agentId: string;
  details?: Record<string, unknown>;
}
