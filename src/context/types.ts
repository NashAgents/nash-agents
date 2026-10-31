import type { ChatMessage, ToolCall } from "../model/chat-completions-client.js";
import type { ToolResult } from "../tools/executor.js";

/**
 * 外部 Spill 存储句柄，用于在 Active Context 与 Session 中不透明引用大文件/输出
 */
export interface SpillRef {
  /**
   * 唯一 Artifact 标识符（如 uuid 或 hash）
   */
  id: string;

  /**
   * 协议定位符，格式形如 tool-result://<id>
   */
  locator: string;

  /**
   * 存储的原始字节数 (Bytes)
   */
  bytes: number;

  /**
   * 存储的原始字符数 (Chars)
   */
  chars: number;

  /**
   * 创建时间戳 (ms)
   */
  createdAt: number;

  /**
   * 所属会话 ID
   */
  sessionId?: string;

  /**
   * 产生该结果的工具名称
   */
  toolName?: string;

  /**
   * 对应的工具调用 ID
   */
  toolCallId?: string;
}

/**
 * Spill 存储治理策略定义
 */
export interface SpillPolicy {
  /**
   * 是否启用溢出存储
   */
  enabled: boolean;

  /**
   * 允许直接内联到 Active Context 的最大字符数，超出则自动 Spill
   */
  maxInlineChars: number;

  /**
   * 单个 Spill Artifact 允许的最大字节数
   */
  maxArtifactBytes: number;

  /**
   * 单个 Session 允许的最大总 Spill 字节数
   */
  maxSessionBytes: number;

  /**
   * 全局允许的最大总 Spill 字节数（用于 GC 清理）
   */
  maxGlobalBytes: number;

  /**
   * 已结束/归档 Session 数据的保留天数
   */
  retentionDays: number;
}

/**
 * Context Management 子系统全局配置
 */
export interface ContextConfig {
  /**
   * 是否在达到阈值时自动执行上下文压缩 (Compaction)
   */
  autoCompact: boolean;

  /**
   * 触发压缩时，保留在活跃上下文中的最近消息条数（不被 summary 替换）
   */
  keepRecentMessages: number;

  /**
   * Spill 存储与生命周期管理策略
   */
  spill: SpillPolicy;

  /**
   * 自定义存储根目录（默认 NASH_HOME/context/（默认 ~/.nash-agents）或工作区 .nash/context/）
   */
  baseDir?: string;
}

/**
 * Token 使用量测量结果
 */
export interface TokenUsageMetrics {
  /**
   * 模型的最大上下文窗口容量 (Tokens)
   */
  contextWindow: number;

  /**
   * 当前估算的输入 Tokens 数量
   */
  estimatedInputTokens: number;

  /**
   * 上下文使用比例 (estimatedInputTokens / contextWindow)
   */
  usageRatio: number;

  /**
   * 压缩触发阈值比例 (如 0.8)
   */
  compactionThreshold: number;

  /**
   * 是否已达到压缩阈值 (usageRatio >= compactionThreshold)
   */
  shouldCompact: boolean;
}

/**
 * Compaction 压缩结构化记录
 */
export interface CompactionRecord {
  /**
   * 记录唯一标识 ID
   */
  id: string;

  /**
   * 记录类型固定为 compaction
   */
  type: "compaction";

  /**
   * LLM 生成的 12 模块结构化摘要文本
   */
  summary: string;

  /**
   * 被本次压缩替换的消息索引范围
   */
  compactedRange: {
    startIndex: number;
    endIndex: number;
  };

  /**
   * 被本次压缩覆盖的首条记录 ID (稳定序列标识)
   */
  coveredFromRecordId?: string;

  /**
   * 被本次压缩覆盖的末条记录 ID (稳定序列标识)
   */
  coveredToRecordId?: string;

  /**
   * 已经累计合并的摘要次数（用于多次压缩防丢失跟踪）
   */
  consolidatedCount?: number;

  /**
   * 创建时间戳 (ms)
   */
  createdAt: number;
}

/**
 * Durable Session JSONL 持久化记录：用户消息
 */
export interface UserSessionRecord {
  type: "user";
  id: string;
  content: string;
  createdAt: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Durable Session JSONL 持久化记录：Assistant 消息
 */
export interface AssistantSessionRecord {
  type: "assistant";
  id: string;
  content: string | null;
  toolCalls?: ToolCall[];
  createdAt: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Durable Session JSONL 持久化记录：Tool 执行结果（若超长仅存预览与 SpillRef，不重复存完整大内容）
 */
export interface ToolResultSessionRecord {
  type: "tool_result";
  id: string;
  toolCallId: string;
  toolName: string;
  content?: string;
  preview?: string;
  spillRef?: string;
  originalChars: number;
  offloaded: boolean;
  success: boolean;
  executionTimeMs?: number;
  createdAt: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Durable Session JSONL 持久化记录：Compaction 事件
 */
export interface CompactionSessionRecord {
  type: "compaction";
  id: string;
  summary: string;
  compactedRange: {
    startIndex: number;
    endIndex: number;
  };
  coveredFromRecordId?: string;
  coveredToRecordId?: string;
  /** Versioned logical snapshot; indices alone cannot address repeated compactions. */
  activeMessages?: ChatMessage[];
  consolidatedCount?: number;
  createdAt: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Durable Session JSONL 持久化记录：统一领域事件 (Task, Team, Agent, Plan 等)
 */
export interface DomainEventSessionRecord {
  type: "domain_event";
  id: string;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: number;
  traceId?: string;
  spanId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Durable Session JSONL 持久化记录：元数据/状态标记
 */
export interface MetadataSessionRecord {
  type: "metadata";
  id: string;
  key: string;
  value: unknown;
  createdAt: number;
}

/**
 * Durable Session JSONL 中所有可序列化的行记录联合类型
 */
export type SessionRecord =
  | UserSessionRecord
  | AssistantSessionRecord
  | ToolResultSessionRecord
  | CompactionSessionRecord
  | DomainEventSessionRecord
  | MetadataSessionRecord;

/**
 * 会话元信息摘要（用于 /resume 会话列表展示与检索）
 */
export interface SessionSummary {
  /**
   * 会话唯一标识 ID
   */
  sessionId: string;

  /**
   * 会话创建时间戳 (毫秒)
   */
  createdAt: number;

  /**
   * 会话最近活动/更新时间戳 (毫秒)
   */
  updatedAt: number;

  /**
   * 会话内的结构化记录总数
   */
  recordCount: number;

  /**
   * 用户与助手交互消息轮数
   */
  messageCount: number;

  /**
   * 首条用户 Prompt 预览（截取前 100 字符）
   */
  firstUserPrompt?: string;

  /**
   * 最近一条用户 Prompt 预览
   */
  lastUserPrompt?: string;

  /** Readable task title derived from a real user request. */
  title?: string;

  /** Runtime owner of this context; older sessions may have no marker. */
  sessionKind?: "main" | "subagent" | "team-lead" | "team-member";

  /**
   * 是否经历过上下文 Compaction 压缩
   */
  hasCompaction: boolean;
}

/**
 * ToolResult 处理结果
 */
export interface ProcessedToolResult {
  /**
   * 最终放入 Active Context 的消息内容
   */
  content: string;

  /**
   * 是否发生了 Spill 外部离线存储
   */
  offloaded: boolean;

  /**
   * 原始字符总数
   */
  originalChars: number;

  /**
   * 若发生溢出，对应的 SpillRef
   */
  spillRef?: SpillRef;

  /**
   * 原始 ToolResult
   */
  rawResult: ToolResult;
}
