/**
 * Nash Pre-Tool Security Evaluator
 *
 * 负责执行独立安全模型调用、确定性基础规则预检、Shell 间接副作用识别、输出严格解析与 Fail-Closed 防护
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SecurityContext,
  SecurityDecision,
  SecurityMonitorConfig,
  SecurityVerdict,
} from "./security-types.js";
import {
  NASH_SECURITY_MONITOR_SYSTEM_PROMPT,
  buildSecurityUserPrompt,
} from "./security-prompt.js";
import { DeterministicFastPathEligibilityValidator } from "./fast-path-validator.js";
import { callChatCompletions, ModelHttpError } from "../model/chat-completions-client.js";
import { getNashModelConfig } from "../config/nash-config.js";
import { currentModelContext } from "../product/runtime.js";

/** 安全审查最多重试 2 次（即最多 3 次尝试），仅在可重试的传输类错误上生效。 */
const SECURITY_REVIEW_MAX_RETRIES = 2;
const SECURITY_REVIEW_BACKOFF_BASE_MS = 250;
const SECURITY_REVIEW_BACKOFF_CAP_MS = 4000;
const SECURITY_REVIEW_BACKOFF_JITTER_MS = 100;
const SECURITY_REVIEW_DEFAULT_TOTAL_BUDGET_MS = 30000;

/** 可重试的底层网络错误码（undici / node:net / DNS）。 */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

function isTimeoutFailure(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || (err as { code?: string }).code === "UND_ERR_HEADERS_TIMEOUT");
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // undici 的 fetch 失败统一是 TypeError("fetch failed")，真实原因在 cause 上。
  if (err instanceof TypeError) return true;
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 判定一次安全审查失败是否值得重试，并提取 Retry-After。
 *
 * 绝不重试：
 * - 调用方主动中止（由调用点先行判断 signal.aborted）；
 * - 可解析但语义无效的模型输出（那不会抛错，走 parseDecisionOutput）；
 * - 4xx（除 429）与任何非传输类错误。
 */
function classifyReviewFailure(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (err instanceof ModelHttpError) {
    if (err.status === 429 || err.status >= 500) {
      return { retryable: true, retryAfterMs: err.retryAfterMs };
    }
    return { retryable: false };
  }
  if (isTimeoutFailure(err) || isNetworkFailure(err)) return { retryable: true };
  return { retryable: false };
}

/** 可被 AbortSignal 立刻打断的等待。 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject((signal as { reason?: unknown }).reason);
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject((signal as { reason?: unknown }).reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class SecurityEvaluator {
  private config: SecurityMonitorConfig;
  private fastPathValidator: DeterministicFastPathEligibilityValidator;

  constructor(config: SecurityMonitorConfig) {
    this.config = {
      enabled: config.enabled ?? true,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      format: config.format,
      headers: config.headers,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens ?? 512,
      temperature: config.temperature ?? 0,
      failClosedOnHighRisk: config.failClosedOnHighRisk ?? true,
    };
    this.fastPathValidator = new DeterministicFastPathEligibilityValidator();
  }

  public updateConfig(newConfig: Partial<SecurityMonitorConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * 计算参数哈希指纹 (规范化参数结构)
   */
  public static computeFingerprint(toolName: string, rawArgs: string): string {
    let canonical = rawArgs;
    try {
      const parsed = JSON.parse(rawArgs);
      if (typeof parsed === "object" && parsed !== null) {
        // 键名排序以达成参数等价指纹一致性
        const sortedKeys = Object.keys(parsed).sort();
        const sortedObj: Record<string, unknown> = {};
        for (const k of sortedKeys) {
          sortedObj[k] = parsed[k];
        }
        canonical = JSON.stringify(sortedObj);
      }
    } catch {}

    return crypto
      .createHash("sha256")
      .update(`${toolName}::${canonical}`, "utf-8")
      .digest("hex");
  }

  /**
   * 确定性预检 (Deterministic Fast Path & Hard Block)
   * 采用 DeterministicFastPathEligibilityValidator 严防敏感读取盲区
   */
  public evaluateDeterministic(context: SecurityContext): SecurityDecision | null {
    const startTime = Date.now();

    // 关键时序前置：在进入确定性预检前，必须首先采集物理执行证据与解析物理真实路径
    this.enrichExecutionEvidence(context);

    const { toolName, rawArgs, argsFingerprint } = context;
    const rawLower = (rawArgs || "").toLowerCase();
    // 确定性硬拦截不能靠工具名绕过：MCP 工具 (mcp__server__tool) 的参数同样可能携带
    // shell 命令，远端执行的效果与本地 bash 等价，因此与 bash 共用同一套硬拦截规则。
    // 工具名只是入口标识，不构成可信边界。
    const isCommandSurface = toolName === "bash" || toolName.startsWith("mcp__");

    // 1. 确定性 HARD BLOCK 检测 (系统破坏、特权篡改与 Fork Bomb)
    if (
      isCommandSurface &&
      (rawLower.includes("rm -rf /") ||
        rawLower.includes("rm -rf /*") ||
        rawLower.includes("chmod -r 777 /") ||
        rawLower.includes(":(){ :|:& };:"))
    ) {
      return {
        verdict: "BLOCK",
        severity: 99,
        category: "Destructive File System",
        ruleName: "System Destruction Hard Block",
        reason: "确定性硬性拦截：检测到试图彻底清空根文件系统或执行 Fork Bomb 的高危破坏命令。",
        fingerprint: argsFingerprint,
        toolName,
        evaluatedAt: Date.now(),
        durationMs: Date.now() - startTime,
      };
    }

    if (
      isCommandSurface &&
      (rawLower.includes("/etc/shadow") ||
        rawLower.includes("/etc/sudoers") ||
        rawLower.includes("passwd root") ||
        rawLower.includes("chown root"))
    ) {
      return {
        verdict: "BLOCK",
        severity: 95,
        category: "Privilege Escalation",
        ruleName: "Privilege Escalation Hard Block",
        reason: "确定性硬性拦截：检测到试图读取或修改系统核心影子密码与 Sudoers 特权文件。",
        fingerprint: argsFingerprint,
        toolName,
        evaluatedAt: Date.now(),
        durationMs: Date.now() - startTime,
      };
    }

    // 2. 检查 Shell 恶意管道外泄与远程未知脚本直接执行
    if (
      isCommandSurface &&
      (rawLower.includes("curl ") || rawLower.includes("wget ")) &&
      (rawLower.includes(" | bash") ||
        rawLower.includes(" | sh") ||
        rawLower.includes("id_rsa") ||
        rawLower.includes(".env"))
    ) {
      return {
        verdict: "REQUIRE_APPROVAL",
        severity: 92,
        category: "Remote Code Execution / Data Exfiltration",
        ruleName: "Suspicious Shell Pipeline Protection",
        reason: "确定性安全规则：检测到通过 curl/wget 管道直接执行远程未知脚本或尝试将私钥/环境变量外泄，需用户人工核准。",
        needsApprovalReason: `检测到潜在的远程未知代码执行或凭据外泄管道: ${rawArgs.slice(0, 100)}`,
        fingerprint: argsFingerprint,
        toolName,
        evaluatedAt: Date.now(),
        durationMs: Date.now() - startTime,
      };
    }

    // 3. 确定性 Fast Path 资格严格验证
    const fastPathResult = this.fastPathValidator.validate(context);

    if (fastPathResult.hardBlock) {
      return fastPathResult.hardBlock;
    }

    if (fastPathResult.isEligible) {
      return {
        verdict: "ALLOW",
        severity: 0,
        category: "Routine Operation",
        ruleName: "Deterministic Fast Path Exemption",
        reason: fastPathResult.reason || "符合常规无害操作确定性放行条件，直接放行。",
        fingerprint: argsFingerprint,
        toolName,
        evaluatedAt: Date.now(),
        durationMs: Date.now() - startTime,
      };
    }

    // 未能通过 Fast Path 资格验证的操作（包含写、执行、敏感读与外部交互），移交独立 LLM 深入审查
    return null;
  }

  /**
   * 收集 Shell 与文件执行入口的物理证据 (间接副作用识别)
   */
  public enrichExecutionEvidence(context: SecurityContext): void {
    const baseCwd = context.cwd || process.cwd();
    // Re-evaluation must not inherit evidence for a file or script that has changed/disappeared.
    delete context.executionEvidence;
    delete context.resolvedTarget;
    delete context.resolvedRealpath;
    delete context.targetFileFingerprint;

    // 1. 若为 bash / execute_command，解析命令与入口脚本
    if (context.toolName === "bash" || context.toolName === "execute_command") {
      const cmd = String(context.toolArgs.command || context.rawArgs || "").trim();
      const evidence: SecurityContext["executionEvidence"] = {};

      // 提取 npm / pnpm / yarn 脚本 (包括 test 隐含的 pretest/posttest 链条)
      const npmMatch = cmd.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([a-zA-Z0-9_-]+)/);
      if (npmMatch && npmMatch[1]) {
        const scriptName = npmMatch[1];
        const pkgJsonPath = path.join(baseCwd, "package.json");
        try {
          if (fs.existsSync(pkgJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
            const scripts = pkg.scripts || {};
            const parts: string[] = [];
            if (scripts[`pre${scriptName}`]) {
              parts.push(`pre${scriptName}: "${scripts[`pre${scriptName}`]}"`);
            }
            if (scripts[scriptName]) {
              parts.push(`${scriptName}: "${scripts[scriptName]}"`);
            }
            if (scripts[`post${scriptName}`]) {
              parts.push(`post${scriptName}: "${scripts[`post${scriptName}`]}"`);
            }
            if (parts.length > 0) {
              evidence.packageScript = parts.join(" -> ");
            }
          }
        } catch {}
      }

      // 提取执行的本地脚本 (如 python script.py, node file.js, bash run.sh)
      const scriptMatch = cmd.match(/^(?:python3?|node|bash|sh)\s+([^\s;&|]+)/);
      if (scriptMatch && scriptMatch[1]) {
        const scriptFile = path.resolve(baseCwd, scriptMatch[1]);
        try {
          if (fs.existsSync(scriptFile)) {
            const content = fs.readFileSync(scriptFile, "utf-8");
            evidence.scriptSnippet = content.slice(0, 400);
            evidence.resolvedTargetRealpath = fs.realpathSync.native ? fs.realpathSync.native(scriptFile) : fs.realpathSync(scriptFile);
            evidence.isSymlink = evidence.resolvedTargetRealpath !== scriptFile;

            // 检查脚本内部是否包含系统敏感或网络操作调用
            const lowerSnippet = content.toLowerCase();
            if (
              lowerSnippet.includes("os.system(") ||
              lowerSnippet.includes("subprocess.") ||
              lowerSnippet.includes("child_process") ||
              lowerSnippet.includes("requests.post(") ||
              lowerSnippet.includes("fetch(") ||
              lowerSnippet.includes("socket.") ||
              lowerSnippet.includes(".env") ||
              lowerSnippet.includes("id_rsa")
            ) {
              evidence.hasSensitiveSyscall = true;
            }
          }
        } catch {}
      }

      context.executionEvidence = { ...(context.executionEvidence || {}), ...evidence };
    }

    // 2. 若为文件操作，检测真实路径与符号链接
    const rawTarget =
      (context.toolArgs.path as string) ||
      (context.toolArgs.file_path as string) ||
      (context.toolArgs.filePath as string) ||
      "";

    if (rawTarget) {
      const resolved = path.resolve(baseCwd, rawTarget);
      context.resolvedTarget = resolved;
      try {
        if (fs.existsSync(resolved)) {
          const real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
          context.resolvedRealpath = real;
          const stat = fs.statSync(resolved);
          context.targetFileFingerprint = `${stat.mtimeMs}_${stat.size}`;
          if (context.executionEvidence) {
            context.executionEvidence.resolvedTargetRealpath = real;
            context.executionEvidence.isSymlink = real !== resolved;
          } else {
            context.executionEvidence = {
              resolvedTargetRealpath: real,
              isSymlink: real !== resolved,
            };
          }
        }
      } catch {}
    }
  }

  /**
   * 调用独立 Security LLM 进行深入意图与风险审查
   */
  public async evaluateWithModel(context: SecurityContext, signal?: AbortSignal): Promise<SecurityDecision> {
    const startTime = Date.now();
    const { toolName, argsFingerprint } = context;

    // 注入物理执行证据
    this.enrichExecutionEvidence(context);

    const boundModel = currentModelContext()?.security;
    let baseUrl = this.config.baseUrl ?? boundModel?.baseUrl;
    let apiKey = this.config.apiKey ?? boundModel?.apiKey;
    let model = this.config.model ?? boundModel?.model;
    let format = this.config.format ?? boundModel?.format;

    // 若未显式配置独立 Security LLM 参数，自动继承全局 Model 配置
    if (!baseUrl || !apiKey || !model) {
      try {
        const sysModel = getNashModelConfig();
        baseUrl = baseUrl || sysModel.baseUrl;
        apiKey = apiKey || sysModel.apiKey;
        model = model || sysModel.model;
        format = format ?? sysModel.format;
      } catch {}
    }

    // 若依然未配置模型连接参数，触发安全降级保护
    if (!baseUrl || !apiKey || !model) {
      return this.handleFallbackOnMissingConfig(context, startTime);
    }

    const userPrompt = buildSecurityUserPrompt(context);

    // 单次尝试预算与总预算分离：单次超时只结束本次尝试，总预算封顶全部重试与退避。
    const perAttemptTimeoutMs = this.config.timeoutMs ?? boundModel?.timeoutMs ?? 10000;
    const configuredTotalBudget = this.config.totalTimeoutMs ?? SECURITY_REVIEW_DEFAULT_TOTAL_BUDGET_MS;
    const totalBudgetMs = Math.max(perAttemptTimeoutMs, configuredTotalBudget);
    const deadline = Date.now() + totalBudgetMs;

    let lastError: unknown;

    for (let attempt = 0; attempt <= SECURITY_REVIEW_MAX_RETRIES; attempt++) {
      // 调用方中止立即上抛，绝不在中止后再发起任何一次请求。
      signal?.throwIfAborted();

      const remainingBudgetMs = deadline - Date.now();
      if (remainingBudgetMs <= 0) break;

      const attemptTimeoutMs = Math.min(perAttemptTimeoutMs, remainingBudgetMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new DOMException("Security review timed out", "TimeoutError"));
      }, attemptTimeoutMs);

      try {
        const response = await callChatCompletions(baseUrl, apiKey, {
          model,
          messages: [
            { role: "system", content: NASH_SECURITY_MONITOR_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: this.config.temperature ?? 0,
          stream: false,
        }, { purpose: "security", format, headers: this.config.headers ?? boundModel?.headers, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });

        clearTimeout(timeout);

        const assistantMsg = response.choices?.[0]?.message?.content || "";
        const tokens = response.usage && typeof response.usage.prompt_tokens === "number" && typeof response.usage.completion_tokens === "number" && typeof response.usage.total_tokens === "number"
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined;

        const parsed = this.parseDecisionOutput(assistantMsg, context);
        return {
          ...parsed,
          fingerprint: argsFingerprint,
          toolName,
          evaluatedAt: Date.now(),
          durationMs: Date.now() - startTime,
          tokensUsed: tokens,
          modelVersion: model,
          promptVersion: "v2.0",
        };
      } catch (err: unknown) {
        clearTimeout(timeout);
        // 调用方主动中止：立即上抛，不重试、也不降级为某个本地判定。
        signal?.throwIfAborted();
        lastError = err;

        const classification = classifyReviewFailure(err);
        if (!classification.retryable || attempt === SECURITY_REVIEW_MAX_RETRIES) break;

        const remainingAfterFailureMs = deadline - Date.now();
        if (remainingAfterFailureMs <= 0) break;

        // Retry-After 优先；否则指数退避 + 抖动。两者都不得超过剩余总预算。
        const backoffMs = classification.retryAfterMs
          ?? Math.min(SECURITY_REVIEW_BACKOFF_CAP_MS, SECURITY_REVIEW_BACKOFF_BASE_MS * 2 ** attempt)
            + Math.floor(Math.random() * SECURITY_REVIEW_BACKOFF_JITTER_MS);
        const waitMs = Math.min(Math.max(0, backoffMs), remainingAfterFailureMs);

        // Retry-After: 0 表示可以立即重试；只有真正没有剩余预算时才放弃。
        if (waitMs > 0) {
          try {
            await sleepWithSignal(waitMs, signal);
          } catch {
            signal?.throwIfAborted();
            break;
          }
        }
      }
    }

    signal?.throwIfAborted();
    return this.handleFallbackOnError(context, lastError ?? new Error("安全审查请求未完成"), startTime);
  }

  /**
   * 解析模型输出 XML 标签或 Severity 文本
   */
  private parseDecisionOutput(
    rawText: string,
    context: SecurityContext
  ): Omit<SecurityDecision, "fingerprint" | "toolName" | "evaluatedAt" | "durationMs"> {
    // 1. 尝试解析标准的 <decision> XML 结构
    const verdictMatch = rawText.match(/<verdict>\s*(ALLOW|BLOCK|REQUIRE_APPROVAL)\s*<\/verdict>/i);
    const severityMatch = rawText.match(/<severity>\s*(\d+)\s*<\/severity>/i);
    const categoryMatch = rawText.match(/<category>(.*?)<\/category>/is);
    const ruleMatch = rawText.match(/<ruleName>(.*?)<\/ruleName>/is);
    const reasonMatch = rawText.match(/<reason>(.*?)<\/reason>/is);
    const needsApprovalMatch = rawText.match(/<needsApprovalReason>(.*?)<\/needsApprovalReason>/is);
    const evidenceMatch = rawText.match(/<decisionEvidence>(.*?)<\/decisionEvidence>/is);
    const authBasisMatch = rawText.match(/<authorizationBasis>(.*?)<\/authorizationBasis>/is);

    if (verdictMatch) {
      const rawVerdict = verdictMatch[1].toUpperCase() as SecurityVerdict;
      const severity = severityMatch ? parseInt(severityMatch[1], 10) : rawVerdict === "ALLOW" ? 10 : 75;
      const category = categoryMatch ? categoryMatch[1].trim() : undefined;
      const ruleName = ruleMatch ? ruleMatch[1].trim() : undefined;
      const reason = reasonMatch ? reasonMatch[1].trim() : "根据 Security Monitor 策略审查判定完成。";
      const needsApprovalReason = needsApprovalMatch ? needsApprovalMatch[1].trim() : undefined;
      const decisionEvidence = evidenceMatch ? evidenceMatch[1].trim() : undefined;
      const authorizationBasis = authBasisMatch ? authBasisMatch[1].trim() : undefined;

      return {
        verdict: rawVerdict,
        severity,
        category,
        ruleName,
        reason,
        needsApprovalReason,
        decisionEvidence,
        authorizationBasis,
      };
    }

    // 2. 兼容仅输出 <severity>N</severity> 的简短打分格式
    if (severityMatch) {
      const score = parseInt(severityMatch[1], 10);
      const isHighRisk = score >= 50;
      const category = categoryMatch ? categoryMatch[1].trim() : isHighRisk ? "Policy Violation" : "Routine Operation";
      const verdict: SecurityVerdict = isHighRisk ? "REQUIRE_APPROVAL" : "ALLOW";

      return {
        verdict,
        severity: score,
        category,
        reason: `模型评分为 ${score} (${isHighRisk ? "存在潜在操作风险" : "在安全阈值以内"})。`,
      };
    }

    // 3. 模型输出了自由文本，进行语义关键词匹配兜底
    const lower = rawText.toLowerCase();
    if (lower.includes("block") && !lower.includes("allow")) {
      return {
        verdict: "BLOCK",
        severity: 85,
        category: "Policy Violation",
        reason: "模型审查建议阻断该操作：" + rawText.slice(0, 150),
      };
    }
    if (lower.includes("require_approval") || lower.includes("approval required")) {
      return {
        verdict: "REQUIRE_APPROVAL",
        severity: 65,
        category: "Soft Block",
        reason: "模型判定该操作具有潜在风险，需用户人工批准。",
        needsApprovalReason: "该操作具有潜在破坏性或涉及外部资源，需确认授权。",
      };
    }

    // 无法明确解析，按 Fail-Closed 判定
    return this.handleUnparsableOutput(context, rawText);
  }

  /**
   * 无法解析模型输出时的安全兜底
   */
  private handleUnparsableOutput(
    context: SecurityContext,
    rawText: string
  ): Omit<SecurityDecision, "fingerprint" | "toolName" | "evaluatedAt" | "durationMs"> {
    const needsReview = !this.fastPathValidator.validate(context).isEligible;

    if (needsReview && this.config.failClosedOnHighRisk) {
      return {
        verdict: "REQUIRE_APPROVAL",
        severity: 70,
        category: "Safety Fail-Closed",
        reviewUnavailable: true,
        decisionSource: "SYSTEM_FAILURE",
        reason: `安全审查模型输出无法解析，待执行操作不具备确定性免审资格，触发人工审批：${rawText.slice(0, 100)}`,
        needsApprovalReason: `安全审查模型响应异常，针对待执行工具 '${context.toolName}' 触发安全审批保护。`,
      };
    }

    return {
      verdict: "ALLOW",
      severity: 20,
      category: "Routine Operation",
      decisionSource: "SYSTEM_FAILURE",
      reason: "输出解析未命中明确威胁规则，常规操作放行。",
    };
  }

  /**
   * 模型请求出错时的降级与 Fail-Closed 处理
   */
  private handleFallbackOnError(
    context: SecurityContext,
    err: unknown,
    startTime: number
  ): SecurityDecision {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isHighRiskTool = !this.fastPathValidator.validate(context).isEligible;

    // 高风险操作执行 Fail-Closed
    if (isHighRiskTool && this.config.failClosedOnHighRisk) {
      return {
        verdict: "REQUIRE_APPROVAL",
        severity: 75,
        category: "Safety Fail-Closed",
        reviewUnavailable: true,
        decisionSource: "SYSTEM_FAILURE",
        ruleName: "Model Unavailable High Risk Protection",
        reason: `独立 Security Monitor 调用失败 (${errorMsg})，高风险工具 '${context.toolName}' 坚决不静默放行，已转为人机审批。`,
        needsApprovalReason: `安全审查服务调用异常，为防止非预期破坏，请人工确认是否执行: ${context.toolName}`,
        fingerprint: context.argsFingerprint,
        toolName: context.toolName,
        evaluatedAt: Date.now(),
        durationMs: Date.now() - startTime,
      };
    }

    // 只有通过确定性免审校验或显式关闭 Fail-Closed 的调用才能走此分支。
    return {
      verdict: "ALLOW",
      severity: 30,
      category: "Routine Operation",
      decisionSource: "SYSTEM_FAILURE",
      ruleName: "Model Unavailable Read-Only Fallback",
      reason: `独立 Security Monitor 暂时不可用 (${errorMsg})，只读/常规工具放行。`,
      fingerprint: context.argsFingerprint,
      toolName: context.toolName,
      evaluatedAt: Date.now(),
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 缺少配置时的降级处理
   */
  private handleFallbackOnMissingConfig(
    context: SecurityContext,
    startTime: number
  ): SecurityDecision {
    return this.handleFallbackOnError(context, new Error("安全模型未配置"), startTime);
  }
}
