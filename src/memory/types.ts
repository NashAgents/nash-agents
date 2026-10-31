/**
 * Memory 作用域：全局 (跨项目) 与 项目级别 (特定项目)
 */
export type MemoryScope = "global" | "project";

/**
 * Memory 知识分类
 */
export type MemoryKind =
  | "fact"
  | "preference"
  | "architecture"
  | "environment"
  | "decision"
  | "lesson";

/**
 * Memory 来源类型
 */
export type MemorySource =
  | "user-explicit"
  | "user-correction"
  | "verified-runtime"
  | "verified-code"
  | "agent-learned";

/**
 * Memory 证据指针 (轻量引用，严禁复制海量 tool stdout)
 */
export interface MemoryEvidence {
  sessionId?: string;
  runId?: string;
  filePath?: string;
  toolName?: string;
  toolCallId?: string;
  summary?: string;
  timestamp?: number;
}

/**
 * Memory 实体条目
 */
export interface MemoryEntry {
  /**
   * 唯一标识 (UUID 或基于内容的稳定 slug)
   */
  id: string;

  /**
   * 作用域
   */
  scope: MemoryScope;

  /**
   * 分类
   */
  kind: MemoryKind;

  /**
   * 核心知识文本 (简明扼要，通常 1~2 句话)
   */
  content: string;

  /**
   * 置信度 0.0 ~ 1.0 (用户显式为 1.0)
   */
  confidence: number;

  /**
   * 来源
   */
  source: MemorySource;

  /**
   * ISO 8601 创建时间
   */
  createdAt: string;

  /**
   * ISO 8601 最后更新/强化时间
   */
  updatedAt: string;

  /**
   * 强化/重复验证次数
   */
  reinforcementCount: number;

  /**
   * 被该条目废弃/替代的旧 memory id 列表
   */
  supersedes?: string[];

  /**
   * 是否已废弃 (被新事实替代或用户要求遗忘)
   */
  deprecated?: boolean;

  /**
   * 证据链列表 (轻量引用)
   */
  evidence?: MemoryEvidence[];

  /**
   * 归属的项目 ID (project scope 必填)
   */
  projectId?: string;

  /**
   * 标签列表 (辅助检索)
   */
  tags?: string[];
}

/**
 * Memory 检索查询入参
 */
export interface MemoryQuery {
  /**
   * 用户查询文本 / 任务描述
   */
  query: string;

  /**
   * 当前项目 ID
   */
  projectId?: string;

  /**
   * 限制最大召回条目数 (默认 6~8)
   */
  maxEntries?: number;

  /**
   * 限制最大估算 Token 数 (默认 1200)
   */
  maxTokens?: number;

  /**
   * 过滤作用域 (默认同时检索 project 与 global，优先 project)
   */
  scope?: MemoryScope | "all";

  /**
   * 最低置信度阈值 (默认 0.3)
   */
  minConfidence?: number;
}

/**
 * 检索结果条目 (包含评分元信息)
 */
export interface ScoredMemoryEntry {
  entry: MemoryEntry;
  score: number;
  matchReasons: string[];
}

/**
 * Memory 检索综合响应
 */
export interface MemoryRetrievalResult {
  entries: MemoryEntry[];
  totalRetrieved: number;
  estimatedTokens: number;
  projectCount: number;
  globalCount: number;
}

/**
 * Memory 配置项
 */
export interface MemoryConfig {
  /**
   * 是否启用 Memory 系统 (默认 true)
   */
  enabled: boolean;

  /**
   * 是否在 Agent 运行完成后自动提炼学习 (默认 true)
   */
  autoLearn: boolean;

  /**
   * 单次 Context 注入的最大 Memory 条目数 (默认 8)
   */
  maxContextEntries: number;

  /**
   * 单次 Context 注入的最大 Memory Token 预算 (默认 1500)
   */
  maxContextTokens: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  autoLearn: true,
  maxContextEntries: 8,
  maxContextTokens: 1500,
};
