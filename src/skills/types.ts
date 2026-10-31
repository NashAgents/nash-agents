/**
 * Skill 作用域
 */
export type SkillScope = "global" | "project";

/**
 * Skill 运行与披露模式 (/skills)
 * - on: 渐进式披露 (Progressive Disclosure) - 注入 Level 1 元数据描述，按需 skill_open 展开
 * - off: 禁用 - 不注入 Prompt，不参与自动发现
 * - name-only: 仅限名称 - 仅在 Prompt 中暴露技能名称，不注入描述 (极致节省 Token)
 * - user-only: 仅限用户 - 不注入 AI Prompt，仅响应用户斜杠命令显式触发
 */
export type SkillMode = "on" | "off" | "name-only" | "user-only";

export interface SkillItemWithMode {
  metadata: SkillMetadata;
  mode: SkillMode;
  estimatedTokens: number;
}

/**
 * Skill Level 1 元数据 (用于快速 Discovery 与 Context 注入)
 */
export interface SkillMetadata {
  /**
   * 技能唯一名称标识 (安全 slug: a-z0-9-_)
   */
  name: string;

  /**
   * 技能一句话描述 (用于判断何时触发)
   */
  description: string;

  /**
   * 作用域
   */
  scope: SkillScope;

  /**
   * 技能目录物理绝对路径
   */
  directoryPath: string;

  /**
   * SKILL.md 文件绝对路径
   */
  skillFilePath: string;

  /**
   * 适用场景触发条件说明 (When to use)
   */
  whenToUse?: string;

  /**
   * 标签 (可选)
   */
  tags?: string[];

  /**
   * 是否存在 references/ 辅助文档目录
   */
  hasReferences?: boolean;

  /**
   * 是否存在 scripts/ 辅助脚本目录
   */
  hasScripts?: boolean;
}

/**
 * Skill Level 2 完整定义 (按需加载)
 */
export interface SkillDefinition {
  metadata: SkillMetadata;

  /**
   * SKILL.md 完整原始文本
   */
  fullContent: string;

  /**
   * 触发与使用场景 (When to use)
   */
  whenToUse: string;

  /**
   * 标准化操作规程 (Procedure)
   */
  procedure: string;

  /**
   * 验证与验收步骤 (Verification)
   */
  verification: string;

  /**
   * 可用的参考文档列表 (references/*.md)
   */
  referenceFiles?: string[];

  /**
   * 可用的辅助脚本列表 (scripts/*)
   */
  scriptFiles?: string[];
}

/**
 * Skill 观察记录 (内部自动学习机制，记录潜在 workflow candidate)
 */
export interface SkillObservation {
  id: string;
  name: string;
  workflowSignature: string;
  successCount: number;
  failureCount: number;
  lastUsedAt: string;
  createdAt: string;
  evidenceSessionId?: string;
  suggestedProcedure?: string;
  suggestedVerification?: string;
}

/**
 * Skill 模块配置
 */
export interface SkillConfig {
  /**
   * 是否启用 Skills 系统 (默认 true)
   */
  enabled: boolean;

  /**
   * 是否在 Context 中自动发现并展示 Available Skills 元数据 (默认 true)
   */
  autoDiscover: boolean;

  /**
   * 是否启用自动 Skill 生成/提炼 (默认 true，但受严格 promotion 约束)
   */
  autoGenerate: boolean;

  /**
   * 单次 Context 注入的最大 Skill 元数据条目数 (默认 10)
   */
  maxMetadataEntries: number;
}

export const DEFAULT_SKILL_CONFIG: SkillConfig = {
  enabled: true,
  autoDiscover: true,
  autoGenerate: true,
  maxMetadataEntries: 10,
};
