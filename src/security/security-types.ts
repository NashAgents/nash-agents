/**
 * Nash Pre-Tool Security Monitor 类型定义
 *
 * 规范统一安全审查判定、上下文结构、威胁分类与配置接口
 */

export type SecurityVerdict = "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";

/**
 * 安全判定威胁与规则分类 (核心 Threat Model 与规则体系)
 */
export type SecurityCategory =
  | "Prompt Injection"
  | "Scope Creep"
  | "Accidental Damage"
  | "Data Exfiltration"
  | "Security Bypass"
  | "Credential Destruction"
  | "Git Destructive"
  | "Destructive File System"
  | "Production Mutation"
  | "Unauthorized External Publishing"
  | "Sensitive Data Leak"
  | "Privilege Escalation"
  | "Routine Operation"
  | "Safety Fail-Closed"
  | "Policy Violation"
  | "Soft Block";

/**
 * 待审查工具调用的完整上下文
 */
export interface SecurityContext {
  executionKind?: "process" | "read" | "write";
  /** 工具名称 (如 "bash", "write_file", "dispatch_cluster_task", "mcp__*") */
  toolName: string;

  /** 解析后的参数对象 */
  toolArgs: Record<string, unknown>;

  /** 工具原始调用字符串参数 */
  rawArgs: string;

  /** 工具名与参数的 SHA-256 指纹，确保审查通过后执行的参数不可篡改 */
  argsFingerprint: string;

  /** 当前工作目录 (cwd) */
  cwd?: string;

  /** 目标物理或规范化文件路径 */
  resolvedTarget?: string;

  /** 目标文件真实路径 (fs.realpath 解析结果，检测符号链接跳跃) */
  resolvedRealpath?: string;

  /** 目标文件内容哈希或 mtime 特征 (TOCTOU 防御) */
  targetFileFingerprint?: string;

  /** 策略版本 */
  policyRevision?: number;

  /** 提示词与规则版本 */
  promptVersion?: string;

  /** 执行主体身份信息 */
  agentIdentity: {
    agentId: string;
    role?: string;
    nodeType?: "coordinator" | "worker" | "scout" | "subagent" | "team_member" | "main";
  };

  /** 关联任务与会话标识 */
  taskId?: string;
  runId?: string;
  nodeId?: string;
  projectId?: string;

  /** 指令来源标记 (区分可信与不可信数据源，防提示词注入) */
  sourceTag?: "user_directive" | "coordinator_instruction" | "agent_generated" | "external_untrusted";

  /** 执行入口静态解析证据 (如 package.json 脚本、目标脚本前缀等) */
  executionEvidence?: {
    scriptSnippet?: string;
    packageScript?: string;
    isDynamicEval?: boolean;
    resolvedTargetRealpath?: string;
    isSymlink?: boolean;
    hasSensitiveSyscall?: boolean;
  };

  /** 用户授权与意图上下文 */
  userAuthorizationContext: {
    /** 核心用户意图目标 */
    userIntent?: string;
    /** 用户最近的消息记录 */
    recentUserMessages?: string[];
    /** 用户显式授予的固定白名单或授权 (例如 explicit user boundaries) */
    standingAuthorizations?: string[];
    /** 会话历史摘要 */
    sessionHistorySummary?: string;
  };
}

/**
 * 独立 Security LLM 判定结果
 */
export interface SecurityDecision {
  /** 最终判定：放行 / 阻断 / 需用户审批 */
  verdict: SecurityVerdict;

  /** 风险评分 0-100 (50 为安全分界线，>=50 为风险) */
  severity: number;

  /** 命中规则或威胁分类 */
  category?: SecurityCategory | string;

  /** 命中具体规则名 */
  ruleName?: string;

  /** 详细判定原因与分析 */
  reason: string;

  /** 参数完整性哈希指纹 */
  fingerprint: string;

  /** 多维安全决策缓存键 */
  securityCacheKey?: string;

  /** 审批授权绑定指纹 (用于 Require Approval 防重放) */
  approvalFingerprint?: string;

  /** 被审查的工具名称 */
  toolName: string;

  /** 若需用户审批，具体的审批原因提示 */
  needsApprovalReason?: string;

  /** 判定证据依据 */
  decisionEvidence?: string;

  /** 授权基准依据 */
  authorizationBasis?: string;

  /** 审查模型版本 */
  modelVersion?: string;

  /** 审查提示词版本 */
  promptVersion?: string;

  /** 判定时间戳 */
  evaluatedAt: number;

  /** 判定耗时 (毫秒) */
  durationMs: number;

  /** Token 开销统计 */
  tokensUsed?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** 判定来源 */
  decisionSource?: "LLM_MONITOR" | "DETERMINISTIC_POLICY" | "USER_APPROVAL" | "SYSTEM_FAILURE";

  /** 是否为确定性硬拦截 (Hard Block) */
  isHardBlock?: boolean;

  /**
   * 该 REQUIRE_APPROVAL 是因为「安全审查模型不可用/输出不可解析」的 Fail-Closed 升级，
   * 而不是模型给出了需要人工判断的风险结论。auto-grant 模式绝不能自动放行这类升级。
   */
  reviewUnavailable?: boolean;

  /** 是否命中缓存 */
  fromCache?: boolean;
}

/**
 * 审批授权凭据与防重放绑定契约
 */
export interface ApprovalBinding {
  approvalId: string;
  toolName: string;
  argsFingerprint: string;
  approvalFingerprint: string;
  nodeId?: string;
  projectId?: string;
  agentId: string;
  taskId?: string;
  grantedAt: number;
  expiresAt: number;
  status: "granted" | "denied" | "consumed" | "expired";
}

/**
 * Security Monitor 配置
 */
export interface SecurityMonitorConfig {
  format?: import("../model/model-adapter.js").ModelApiFormat;
  headers?: Record<string, string>;
  onAuditError?: (error: unknown) => void;
  /** 是否启用 Pre-Tool Security Monitor (默认 true) */
  enabled?: boolean;

  /** 独立的 Security 模型名称 (例如低延迟小模型或用户配置的模型) */
  model?: string;

  /** 独立 Base URL (若未提供则复用系统配置) */
  baseUrl?: string;

  /** 独立 API Key (若未提供则复用系统配置) */
  apiKey?: string;

  /** 单次安全判定模型请求的超时时间 (默认 10000ms)；重试时每次调用独立计时 */
  timeoutMs?: number;

  /**
   * 安全审查总预算 (包含全部重试与退避，默认 30000ms)。
   * 预算耗尽后立即走既有的 Fail-Closed 降级路径，绝不无限重试。
   */
  totalTimeoutMs?: number;

  /** 单节点真实安全审查的最大在途并发 (默认 2) */
  maxConcurrentReviews?: number;

  /**
   * 节点级共享的审查并发限流器。
   * Worker 运行时在所有任务间共享同一实例，避免 N 任务 × M 工具同时打爆上游安全模型。
   */
  reviewLimiter?: import("./review-limiter.js").ReviewLimiter;

  /** 判定最大输出 token (默认 512) */
  maxTokens?: number;

  /** 模型温度 (默认 0) */
  temperature?: number;

  /** 是否启用判定结果指纹缓存 (默认 true) */
  cacheEnabled?: boolean;

  /** 缓存生存时间 (毫秒，默认 5 分钟) */
  cacheTtlMs?: number;

  /** 当模型不可用或无法解析时，高风险操作是否 Fail-Closed (默认 true) */
  failClosedOnHighRisk?: boolean;

  /** 是否记录审计事件 (默认 true) */
  auditLogging?: boolean;

  /** 自定义持久化审计接收器 (Sink) */
  auditSink?: (record: any) => Promise<void> | void;
}
