/**
 * Nash Pre-Tool Security Monitor 决策缓存与审批授权防重放中枢
 *
 * 核心职责：
 * 1. 多维安全决策缓存键 (针对 CWD、Realpath、符号链接、文件指纹、策略版本实施细粒度隔离，杜绝 TOCTOU 漏洞)；
 * 2. 区分【参数完整性指纹】、【安全决策缓存键】与【审批授权绑定指纹】；
 * 3. 严格限制可缓存操作（高风险、副作用与破坏性操作坚决不予缓存，逐次审查）；
 * 4. 审批授权防重放与防偷渡（绑定 Task、Node、Project、Agent 身份与过期时间，单次核销）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { ApprovalBinding, SecurityContext, SecurityDecision } from "./security-types.js";

export interface CacheKeyParams {
  toolName: string;
  argsFingerprint: string;
  cwd?: string;
  resolvedTarget?: string;
  resolvedRealpath?: string;
  targetFileFingerprint?: string;
  nodeId?: string;
  projectId?: string;
  agentId?: string;
  taskId?: string;
  userIntent?: string;
  standingAuthorizations?: string[];
  policyRevision?: number;
  promptVersion?: string;
}

export class SecurityResultCache {
  private cache = new Map<string, { decision: SecurityDecision; expiresAt: number }>();
  private approvalBindings = new Map<string, ApprovalBinding>();
  private recentDenials = new Map<string, { deniedAt: number; reason: string }>();

  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000; // 默认 5 分钟
    this.maxEntries = options?.maxEntries ?? 1000;
  }

  /**
   * 生成多维安全决策缓存键 (Security Cache Key)
   * 细粒度纳入工作目录、符号链接物理路径、文件特征与策略版本
   */
  public generateSecurityCacheKey(params: CacheKeyParams): string {
    const raw = [
      params.toolName,
      params.argsFingerprint,
      params.cwd || "",
      params.resolvedTarget || "",
      params.resolvedRealpath || "",
      params.targetFileFingerprint || "",
      params.nodeId || "local",
      params.projectId || "",
      params.agentId || "",
      params.taskId || "",
      params.userIntent || "",
      (params.standingAuthorizations || []).sort().join(";"),
      params.policyRevision ?? 1,
      params.promptVersion || "v2.0",
    ].join("::");

    return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
  }

  /**
   * 判断一个工具操作是否允许复用缓存 (高风险、破坏性及动态命令严禁缓存)
   */
  public isCacheable(context: SecurityContext, decision: SecurityDecision): boolean {
    // 0. 模型/系统故障的降级结论绝不进入缓存：恢复后必须重新执行真实审查
    if (decision.decisionSource === "SYSTEM_FAILURE" || decision.reviewUnavailable) {
      return false;
    }

    // 1. 只有最终判为 ALLOW 且风险评分较低的操作允许进入缓存
    if (decision.verdict !== "ALLOW" || decision.severity >= 50) {
      return false;
    }

    // 2. 具备动态外部副作用的 Shell 命令逐次审查，不予静态缓存
    if (context.toolName === "bash" || context.toolName === "execute_command") {
      const cmd = String(context.toolArgs.command || context.rawArgs || "").toLowerCase();
      // 仅允许极少数明确幂等只读的状态查询命令缓存
      const safeInspectCommands = ["git status", "git branch", "node -v", "npm -v", "uname", "pwd", "whoami"];
      const isPureInspect = safeInspectCommands.some((c) => cmd.trim() === c || cmd.trim().startsWith(c + " "));
      if (!isPureInspect) {
        return false;
      }
    }

    // 3. 写操作及外部派发工具默认不缓存，保证每次写盘与派发均实时受控
    if (
      context.toolName === "write_file" ||
      context.toolName === "edit_file" ||
      context.toolName === "dispatch_cluster_task"
    ) {
      return false;
    }

    return true;
  }

  /**
   * 从缓存中检索判定
   */
  public get(params: CacheKeyParams): SecurityDecision | null {
    const key = this.generateSecurityCacheKey(params);
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return {
      ...entry.decision,
      securityCacheKey: key,
      fromCache: true,
      evaluatedAt: Date.now(),
    };
  }

  /**
   * 写入缓存
   */
  public set(params: CacheKeyParams, decision: SecurityDecision): void {
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const key = this.generateSecurityCacheKey(params);
    this.cache.set(key, {
      decision: { ...decision, securityCacheKey: key },
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  // ============================================================
  // 审批授权绑定与防重放中枢 (Approval Binding & Anti-Replay)
  // ============================================================

  /**
   * 计算审批授权绑定指纹
   * 严格绑定：工具名 + 参数指纹 + 目标节点 + 目标项目 + 执行智能体 + 任务ID
   */
  public static computeApprovalFingerprint(context: SecurityContext): string {
    const raw = [
      context.toolName,
      context.argsFingerprint,
      context.nodeId || "local",
      context.projectId || "default",
      context.agentIdentity?.agentId || "main",
      context.taskId || "no-task",
    ].join("::");

    return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
  }

  /**
   * 记录已通过的用户单次审批
   */
  public grantApproval(context: SecurityContext, ttlMs = 5 * 60 * 1000): ApprovalBinding {
    const approvalFingerprint = SecurityResultCache.computeApprovalFingerprint(context);
    const approvalId = `appr-${crypto.randomUUID().slice(0, 8)}`;

    const binding: ApprovalBinding = {
      approvalId,
      toolName: context.toolName,
      argsFingerprint: context.argsFingerprint,
      approvalFingerprint,
      nodeId: context.nodeId,
      projectId: context.projectId,
      agentId: context.agentIdentity?.agentId || "main",
      taskId: context.taskId,
      grantedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      status: "granted",
    };

    this.approvalBindings.set(approvalFingerprint, binding);
    return binding;
  }

  /**
   * 校验并核销审批授权 (单次有效，不可重放)
   */
  public consumeApproval(context: SecurityContext): boolean {
    const approvalFingerprint = SecurityResultCache.computeApprovalFingerprint(context);
    const binding = this.approvalBindings.get(approvalFingerprint);
    if (!binding) return false;

    // 校验过期时间
    if (Date.now() > binding.expiresAt) {
      binding.status = "expired";
      this.approvalBindings.delete(approvalFingerprint);
      return false;
    }

    // 校验状态是否仍为有效
    if (binding.status !== "granted") {
      return false;
    }

    // 校验参数指纹与任务一致性
    if (binding.argsFingerprint !== context.argsFingerprint || binding.taskId !== context.taskId) {
      return false;
    }

    // 核销：单次放行后立即置为 consumed，杜绝重放
    binding.status = "consumed";
    this.approvalBindings.delete(approvalFingerprint);
    return true;
  }

  /**
   * 记录用户拒绝审批行为，防止 Agent 在同一任务内换包装死循环尝试
   */
  public recordDenial(context: SecurityContext, reason: string): void {
    const approvalFingerprint = SecurityResultCache.computeApprovalFingerprint(context);
    this.recentDenials.set(approvalFingerprint, {
      deniedAt: Date.now(),
      reason,
    });
  }

  /**
   * 检查该操作近期是否已被明确拒绝
   */
  public isRecentlyDenied(context: SecurityContext, windowMs = 60 * 1000): { denied: boolean; reason?: string } {
    const approvalFingerprint = SecurityResultCache.computeApprovalFingerprint(context);
    const record = this.recentDenials.get(approvalFingerprint);
    if (!record) return { denied: false };

    if (Date.now() - record.deniedAt < windowMs) {
      return { denied: true, reason: record.reason };
    }

    this.recentDenials.delete(approvalFingerprint);
    return { denied: false };
  }

  /**
   * 清空全部缓存与审批状态
   */
  public clear(): void {
    this.cache.clear();
    this.approvalBindings.clear();
    this.recentDenials.clear();
  }
}
