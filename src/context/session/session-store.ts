import type { ChatMessage } from "../../model/chat-completions-client.js";
import type {
  SessionRecord,
  UserSessionRecord,
  AssistantSessionRecord,
  ToolResultSessionRecord,
  CompactionSessionRecord,
  DomainEventSessionRecord,
  SessionSummary,
} from "../types.js";

/**
 * Durable Session 持久化会话存储接口
 */
export interface SessionStore {
  /**
   * 当前会话唯一标识 ID
   */
  readonly sessionId: string;

  /**
   * 追加单条结构化历史记录（原子追加写入 JSONL）
   */
  appendRecord(record: SessionRecord): Promise<void>;

  /**
   * 追加用户消息记录
   */
  appendUserMessage(
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<UserSessionRecord>;

  /**
   * 追加 Assistant 消息记录（包含可选的 toolCalls）
   */
  appendAssistantMessage(
    content: string | null,
    toolCalls?: AssistantSessionRecord["toolCalls"],
    metadata?: Record<string, unknown>
  ): Promise<AssistantSessionRecord>;

  /**
   * 追加 ToolResult 记录（超长输出仅存 preview 与 spillRef，不重复存储大文本）
   */
  appendToolResult(
    toolCallId: string,
    toolName: string,
    result: {
      content?: string;
      preview?: string;
      spillRef?: string;
      originalChars: number;
      offloaded: boolean;
      success: boolean;
      executionTimeMs?: number;
    },
    metadata?: Record<string, unknown>
  ): Promise<ToolResultSessionRecord>;

  /**
   * 追加 Compaction 压缩事件记录（保留完整历史，不删除原始记录）
   */
  appendCompactionRecord(
    summary: string,
    compactedRange: { startIndex: number; endIndex: number },
    consolidatedCount?: number,
    metadata?: Record<string, unknown>,
    activeMessages?: ChatMessage[]
  ): Promise<CompactionSessionRecord>;

  /**
   * 追加结构化领域事件（Task, Team, Agent, Plan 变更等）
   */
  appendDomainEvent(
    eventType: string,
    data: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<DomainEventSessionRecord>;

  /**
   * 获取当前会话所有的历史持久化记录（按时间顺序）
   */
  getRecords(): Promise<SessionRecord[]>;

  /**
   * 获取当前会话的元信息摘要
   */
  getSummary(): Promise<SessionSummary>;

  /**
   * 获取所有历史 Compaction 事件记录
   */
  getCompactionHistory(): Promise<CompactionSessionRecord[]>;

  /**
   * 将 Durable Session 中的完整执行历史重构为标准的 ChatMessage 列表（用于 debug/tracing/replay）
   */
  toChatMessages(): Promise<ChatMessage[]>;

  /**
   * 清空或删除当前会话的持久化文件
   */
  clear(): Promise<void>;
}
