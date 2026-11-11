import type {
  MemoryEntry,
  MemoryEvidence,
  MemoryKind,
  MemoryScope,
} from "../memory/types.js";
import type { SkillMetadata, SkillScope } from "../skills/types.js";

/**
 * Run 结束时的近期对话片段（已由运行时裁剪，不包含工具消息正文）。
 */
export interface LearningConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 实际执行过的工具调用及其结果。
 *
 * result 是脱敏后的真实输出；构建学习上下文时会再做长度裁剪并保留可追溯引用。
 */
export interface LearningToolCall {
  name: string;
  args: Record<string, unknown> | string;
  result?: string;
  success?: boolean;
  toolCallId?: string;
}

/**
 * Run 结束时的学习上下文输入
 */
export interface RunLearningInput {
  sessionId: string;
  runId?: string;
  userInput: string;
  response?: string;
  recentMessages?: LearningConversationMessage[];
  toolCalls?: LearningToolCall[];
  verifiedFiles?: string[];
  testResults?: {
    command: string;
    passed: boolean;
    redToGreen?: boolean;
  };
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Memory 提炼结果的旧版结构（MemoryDistiller 仍作为显式信号/规则辅助保留）。
 */
export interface DistilledMemoryItem {
  content: string;
  kind: MemoryEntry["kind"];
  source: MemoryEntry["source"];
  confidence: number;
  tags?: string[];
  evidence?: MemoryEvidence[];
  supersedes?: string[];
}

/**
 * 模型允许声明的记忆依据。
 *
 * 刻意不包含 "agent-learned"/"inferred"：自动沉淀不允许把模型猜测写成长期事实。
 */
export type LearningMemoryBasis =
  | "user-explicit"
  | "user-correction"
  | "verified-runtime"
  | "verified-code";

/**
 * 通过严格校验、可交给 MemoryService 写入的记忆候选。
 */
export interface LearningMemoryCandidate {
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  basis: LearningMemoryBasis;
  confidence: number;
  evidence: string;
  tags?: string[];
}

/**
 * 通过严格校验、可交给 SkillService 写入的 Skill 候选。
 */
export interface LearningSkillCandidate {
  name: string;
  description: string;
  whenToUse: string;
  procedure: string;
  verification: string;
  limitations?: string;
  scope: SkillScope;
  evidence: string;
}

/**
 * 模型返回的顶层决策类型。
 */
export type LearningDecisionKind = "none" | "memory" | "skill" | "both";

/**
 * 模型原始结构化输出（尚未通过字段校验）。
 */
export interface RawLearningDecision {
  decision: LearningDecisionKind;
  memories?: unknown;
  skill?: unknown;
  notes?: string;
}

/**
 * 单条候选被拒绝的原因（不影响同批其他候选的写入判断）。
 */
export interface LearningRejection {
  target: "memory" | "skill";
  index?: number;
  reason: string;
}

/**
 * 非致命警告：例如模型声明的作用域被保守降级、顶层 decision 与实际内容不一致。
 */
export interface LearningWarning {
  stage: "validation" | "scope" | "dedupe" | "skill";
  message: string;
}

/**
 * 学习阶段的可观察失败记录。
 */
export interface LearningFailure {
  stage: "context" | "model" | "parse" | "validation" | "memory-write" | "skill-write";
  message: string;
}

/**
 * Run 学习综合输出
 */
export interface RunLearningResult {
  status: "skipped" | "completed" | "partial" | "failed";
  memoriesLearned: MemoryEntry[];
  skillsObserved?: string[];
  skillsCreated?: SkillMetadata[];
  skillSkippedReason?: string;
  skippedReason?: string;
  failures: LearningFailure[];
  warnings?: LearningWarning[];
  rejections?: LearningRejection[];
  modelUsed?: string;
  promptChars?: number;
  /** 模型对本次判断的可选说明（尤其 decision=none 时）。 */
  notes?: string;
}

/**
 * 显式用户信号：只用于给模型提示与校验 user-explicit 依据，不直接产生写入。
 */
export interface ExplicitLearningSignals {
  explicitMemoryRequest: boolean;
  explicitCorrection: boolean;
  explicitSkillRequest: boolean;
  requestedSkillName?: string;
  mentionsGlobalScope: boolean;
}
