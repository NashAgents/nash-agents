/**
 * Nash Pre-Tool Security Monitor 核心门面
 *
 * 统一承接 Coordinator Main Agent、Scout Agent、Worker Agent、SubAgent、TeamMember 的工具审查
 * 支持确定性 Fast Path 校验、多维上下文缓存、依赖冲突检查、参数指纹防篡改与审批防重放
 */

import {
  ApprovalBinding,
  SecurityContext,
  SecurityDecision,
  SecurityMonitorConfig,
} from "./security-types.js";
import { SecurityEvaluator } from "./security-evaluator.js";
import { SecurityResultCache } from "./security-cache.js";
import { ReviewLimiter } from "./review-limiter.js";
import { randomUUID } from "node:crypto";
import { redactString } from "../observability/redaction.js";

/**
 * 以受限并发执行异步映射：最多 limit 个任务同时进行。
 * items 中的错误会以 Promise.all 语义上抛（一旦失败即拒绝）。
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class PreToolSecurityMonitor {
  private evaluator: SecurityEvaluator;
  private cache: SecurityResultCache;
  private config: SecurityMonitorConfig;
  /**
   * 真实安全审查的并发上限。Worker 运行时把同一实例注入所有任务，
   * 让节点级在途审查数不再随任务数线性膨胀。
   */
  private readonly reviewLimiter: ReviewLimiter;

  constructor(config?: SecurityMonitorConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      cacheEnabled: config?.cacheEnabled ?? true,
      auditLogging: config?.auditLogging ?? true,
      ...config,
    };
    this.evaluator = new SecurityEvaluator(this.config);
    this.cache = new SecurityResultCache({ ttlMs: config?.cacheTtlMs });
    this.reviewLimiter = config?.reviewLimiter ?? new ReviewLimiter(config?.maxConcurrentReviews ?? 2);
  }

  /** 仅供观测与测试：当前在途的真实安全审查数。 */
  public get reviewInFlight(): number {
    return this.reviewLimiter.inFlight;
  }

  /**
   * 动态更新安全监控配置
   */
  public updateConfig(newConfig: Partial<SecurityMonitorConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.evaluator.updateConfig(newConfig);
  }

  /**
   * 校验待执行工具参数是否与安全审查时的参数哈希指纹完全一致
   * 若参数被任何中间环节篡改，坚决拒绝执行
   */
  public verifyFingerprint(toolName: string, actualRawArgs: string, expectedFingerprint: string): boolean {
    const computed = SecurityEvaluator.computeFingerprint(toolName, actualRawArgs);
    return computed === expectedFingerprint;
  }

  /**
   * 获取审批授权管理
   */
  public grantApproval(context: SecurityContext, ttlMs?: number): ApprovalBinding {
    return this.cache.grantApproval(context, ttlMs);
  }

  public consumeApproval(context: SecurityContext): boolean {
    return this.cache.consumeApproval(context);
  }

  public recordDenial(context: SecurityContext, reason: string): void {
    this.cache.recordDenial(context, reason);
  }

  public isRecentlyDenied(context: SecurityContext, windowMs?: number): { denied: boolean; reason?: string } {
    return this.cache.isRecentlyDenied(context, windowMs);
  }

  /**
   * 审查单个待执行工具调用
   */
  public async evaluateToolCall(context: SecurityContext, signal?: AbortSignal, options?: { bypassCache?: boolean }): Promise<SecurityDecision> {
    signal?.throwIfAborted();
    if (this.config.enabled === false) {
      // 即使显式禁用（仅限测试/受控环境），确定性硬拦截依然生效：
      // 关闭审查模型绝不等价于允许破坏性操作。
      const forcedDeterministic = this.evaluator.evaluateDeterministic(context);
      if (forcedDeterministic && forcedDeterministic.verdict === "BLOCK") {
        forcedDeterministic.decisionSource = "DETERMINISTIC_POLICY";
        forcedDeterministic.isHardBlock = true;
        this.logAudit(context, forcedDeterministic);
        return forcedDeterministic;
      }
      const disabledDecision: SecurityDecision = {
        verdict: "ALLOW",
        severity: 0,
        category: "Routine Operation",
        reason: "Security Monitor 审查模型已被显式全局禁用；确定性硬拦截仍在生效。",
        fingerprint: context.argsFingerprint,
        toolName: context.toolName,
        evaluatedAt: Date.now(),
        durationMs: 0,
        decisionSource: "SYSTEM_FAILURE",
      };
      this.logAudit(context, disabledDecision);
      return disabledDecision;
    }

    // 0. 检查是否近期已被用户显式拒绝 (防换包装重复重试)
    const recentDenial = this.cache.isRecentlyDenied(context);
    if (recentDenial.denied) {
      const denialDecision: SecurityDecision = {
        verdict: "BLOCK",
        severity: 90,
        category: "Policy Violation",
        ruleName: "Recent User Denial Anti-Retry",
        reason: `该操作近期已被用户明确拒绝 (${recentDenial.reason})，在未获得新授权前严禁重复尝试。`,
        fingerprint: context.argsFingerprint,
        toolName: context.toolName,
        evaluatedAt: Date.now(),
        durationMs: 0,
        decisionSource: "USER_APPROVAL",
        isHardBlock: false,
      };
      this.logAudit(context, denialDecision);
      return denialDecision;
    }

    // 1. 尝试确定性快速判定 (Deterministic Fast Path & Hard Block)
    const deterministic = this.evaluator.evaluateDeterministic(context);
    if (deterministic) {
      deterministic.decisionSource = "DETERMINISTIC_POLICY";
      // isHardBlock 的含义是「人工审批也不得放行」。只有确定性 BLOCK 规则
      // （破坏性删除、特权文件篡改、保留设备名等）具备这一属性；
      // 高危但合法的操作（如 curl 管道执行）保持 REQUIRE_APPROVAL，仍可由人放行。
      deterministic.isHardBlock = deterministic.verdict === "BLOCK";
      this.logAudit(context, deterministic);
      return deterministic;
    }

    // 2. 尝试从多维缓存中获取审查结果 (排除高风险与动态操作)
    if (this.config.cacheEnabled && !options?.bypassCache) {
      const cached = this.cache.get({
        toolName: context.toolName,
        argsFingerprint: context.argsFingerprint,
        cwd: context.cwd,
        resolvedTarget: context.resolvedTarget,
        resolvedRealpath: context.resolvedRealpath,
        targetFileFingerprint: context.targetFileFingerprint,
        nodeId: context.nodeId,
        projectId: context.projectId,
        agentId: context.agentIdentity?.agentId || "main",
        taskId: context.taskId,
        userIntent: context.userAuthorizationContext?.userIntent,
        standingAuthorizations: context.userAuthorizationContext?.standingAuthorizations,
        policyRevision: context.policyRevision,
        promptVersion: context.promptVersion,
      });

      if (cached) {
        cached.fromCache = true;
        if (!cached.decisionSource) cached.decisionSource = "DETERMINISTIC_POLICY";
        this.logAudit(context, cached);
        return cached;
      }
    }

    // 3. 调用独立 Security LLM 实施审查 (经由节点级并发限流；排队期间同样响应取消)
    const decision = await this.reviewLimiter.run(signal, () => this.evaluator.evaluateWithModel(context, signal));
    if (!decision.decisionSource) {
      decision.decisionSource = "LLM_MONITOR";
    }

    // 4. 成功判定且符合安全缓存条件时存入缓存
    if (this.config.cacheEnabled && this.cache.isCacheable(context, decision)) {
      this.cache.set(
        {
          toolName: context.toolName,
          argsFingerprint: context.argsFingerprint,
          cwd: context.cwd,
          resolvedTarget: context.resolvedTarget,
          resolvedRealpath: context.resolvedRealpath,
          targetFileFingerprint: context.targetFileFingerprint,
          nodeId: context.nodeId,
          projectId: context.projectId,
          agentId: context.agentIdentity?.agentId || "main",
          taskId: context.taskId,
          userIntent: context.userAuthorizationContext?.userIntent,
          standingAuthorizations: context.userAuthorizationContext?.standingAuthorizations,
          policyRevision: context.policyRevision,
          promptVersion: context.promptVersion,
        },
        decision
      );
    }

    this.logAudit(context, decision);
    return decision;
  }

  /**
   * 并行审查同一轮生成的多个工具调用
   */
  public async evaluateParallelToolCalls(contexts: SecurityContext[], signal?: AbortSignal): Promise<SecurityDecision[]> {
    if (!contexts || contexts.length === 0) return [];
    // 外层扇出同样收敛到限流上限：即使单个任务一轮吐出大量工具调用，
    // 也不会在节点级限流器前排起过长队列。限流只削减并发，不改变任何判定。
    return mapWithConcurrency(contexts, this.reviewLimiter.limit, (ctx) => this.evaluateToolCall(ctx, signal));
  }

  /**
   * 清空所有状态
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * 工具参数递归脱敏方法
   */
  public static sanitizeArgs(toolArgs: Record<string, unknown> | undefined): Record<string, unknown> {
    const visited = new WeakSet<object>();
    const sanitize = (value: unknown, depth: number): unknown => {
      if (depth > 12) return "[TRUNCATED]";
      if (typeof value === "string") {
        const clean = redactString(value.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [MASKED]"));
        return clean.length > 500 ? clean.slice(0, 500) + "... [TRUNCATED]" : clean;
      }
      if (!value || typeof value !== "object") return value;
      if (visited.has(value)) return "[CIRCULAR]";
      visited.add(value);
      const clean = Array.isArray(value) ? value.map(item => sanitize(item, depth + 1))
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
          /api[_-]?key|secret|password|token|credential/i.test(key) ? "[REDACTED]" : sanitize(item, depth + 1)]));
      visited.delete(value);
      return clean;
    };
    return toolArgs && typeof toolArgs === "object" ? sanitize(toolArgs, 0) as Record<string, unknown> : {};
  }

  /**
   * 输出审计日志、脱敏并持久化入库
   */
  private logAudit(context: SecurityContext, decision: SecurityDecision): void {
    if (!this.config.auditLogging) return;

    // 若配置了持久化 AuditSink，构建完整的脱敏审计记录并落盘
    if (this.config.auditSink) {
      const sanitized = PreToolSecurityMonitor.sanitizeArgs(context.toolArgs);
      const rawSnippet = JSON.stringify(sanitized).slice(0, 300);
      const auditRecord = {
        id: `sec-${randomUUID()}`,
        timestamp: decision.evaluatedAt || Date.now(),
        toolName: context.toolName,
        argsFingerprint: context.argsFingerprint,
        sanitizedArgs: sanitized,
        rawArgsSnippet: rawSnippet,
        decisionSource: decision.decisionSource || (decision.fromCache ? "DETERMINISTIC_POLICY" : "LLM_MONITOR"),
        verdict: decision.verdict,
        severity: decision.severity,
        riskCategory: String(decision.category || "Routine Operation"),
        ruleName: decision.ruleName,
        reason: redactString(decision.reason),
        decisionEvidence: decision.decisionEvidence ? redactString(decision.decisionEvidence) : undefined,
        agentId: context.agentIdentity?.agentId || "main",
        nodeId: context.nodeId,
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        durationMs: decision.durationMs,
        isHardBlock: Boolean(decision.isHardBlock),
        tokensUsed: decision.tokensUsed,
        modelVersion: decision.modelVersion,
        reviewFeedback: { status: "unreviewed" },
        createdAt: Date.now(),
      };

      try {
        const res = this.config.auditSink(auditRecord);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((err) => {
            this.config.onAuditError?.(err);
          });
        }
      } catch (err) {
        this.config.onAuditError?.(err);
      }
    }
  }
}
