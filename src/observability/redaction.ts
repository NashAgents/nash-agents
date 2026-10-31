import type { ToolResult } from "../tools/executor.js";

/**
 * LLM Token 指标字段白名单模式（数字型 Token 计数绝不能当作鉴权 Token 误脱敏）
 */
const LLM_TOKEN_METRIC_PATTERN =
  /^(?:cacheReadTokens|cacheWriteTokens|reasoningTokens|inTokens|outTokens|inputTokens|outputTokens|promptTokens|completionTokens|totalTokens|cachedTokens|uncachedTokens|prompt_tokens|completion_tokens|total_tokens|cached_tokens|uncached_tokens|tokens|tokenCount|token_count)$/i;

/**
 * 敏感字段名匹配模式（涵盖 API Key、Authorization、Token、Secret、Password、Credentials 等）
 */
const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|auth(?:orization)?|bearer|token|secret|password|passwd|credential|private[_-]?key)/i;

/**
 * 文本中各类敏感 Secret / Token / 私钥的正规匹配模式
 */
const SENSITIVE_VALUE_REGEXES: RegExp[] = [
  /Bearer\s+[a-zA-Z0-9_\-\.]{8,}/gi,
  /(?<![a-zA-Z0-9_])sk-[a-zA-Z0-9_\-]{16,}/gi,
  /ghp_[a-zA-Z0-9]{20,}/gi,
  /glpat-[a-zA-Z0-9_\-]{20,}/gi,
  /xox[baprs]-[a-zA-Z0-9_\-]{10,}/gi,
  /AIza[0-9A-Za-z-_]{35}/g,
];

/**
 * 私钥证书块匹配模式
 */
const PRIVATE_KEY_BLOCK_REGEX =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi;

/**
 * JSON 与常见配置文件中的敏感键值对匹配模式
 */
const SENSITIVE_KV_REGEX =
  /(["']?(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi;

/**
 * Shell 环境变量导出模式
 */
const SENSITIVE_ENV_EXPORT_REGEX =
  /((?:export\s+)?[a-zA-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWD|PASSWORD)\s*=\s*["']?)([^"'\s\r\n]+)(["']?)/gi;

/**
 * 脱敏字符串中的敏感 token、密钥与私钥块
 */
export function redactString(input: string): string {
  if (!input || typeof input !== "string") {
    return input;
  }
  let result = input;

  // 1. 脱敏私钥块
  result = result.replace(PRIVATE_KEY_BLOCK_REGEX, "[REDACTED_PRIVATE_KEY]");

  // 2. 脱敏已知前缀 Token
  for (const regex of SENSITIVE_VALUE_REGEXES) {
    result = result.replace(regex, (matched) => {
      if (matched.toLowerCase().startsWith("bearer ")) {
        return "Bearer [REDACTED]";
      }
      return "[REDACTED]";
    });
  }

  // 3. 脱敏 JSON / 键值对中的明文 Secret (保留键名结构)
  result = result.replace(SENSITIVE_KV_REGEX, (_match, prefix, _secret, suffix) => {
    return `${prefix}[REDACTED]${suffix}`;
  });

  // 4. 脱敏 Shell 环境变量导出
  result = result.replace(SENSITIVE_ENV_EXPORT_REGEX, (_match, prefix, _secret, suffix) => {
    return `${prefix}[REDACTED]${suffix || ""}`;
  });

  return result;
}

/**
 * 深度递归脱敏 Object/Array 结构，防止 API Key、Secret 及敏感环境变量泄露至 Trace/Events/OTel
 */
export function redactObject<T = unknown>(input: T, depth = 0, maxDepth = 6): T {
  if (depth > maxDepth) return "[TRUNCATED]" as T;
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === "string") {
    return redactString(input) as unknown as T;
  }

  if (typeof input !== "object") {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item, depth + 1, maxDepth)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (LLM_TOKEN_METRIC_PATTERN.test(key) || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (/^(?:planningTokens|tokenUsage|estimatedTokens)$/i.test(key) && value && typeof value === "object") {
      result[key] = redactObject(value, depth + 1, maxDepth);
    } else if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactObject(value, depth + 1, maxDepth);
    } else if (typeof value === "string") {
      result[key] = redactString(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * 对 ToolResult 进行 Observability 摘要脱敏（避免把数万字符的巨大文件输出完整复制进 Trace/Event/OTel）
 */
export function redactToolResult(
  toolName: string,
  rawResult: ToolResult,
  spillRef?: string
): Record<string, unknown> {
  const outputChars = rawResult.output ? rawResult.output.length : 0;
  const outputBytes = Buffer.byteLength(rawResult.output ?? "", "utf-8");

  // 仅在输出较短 (<= 200 字符) 且安全时保留简短预览，其余仅记录元数据
  const preview =
    rawResult.output && rawResult.output.length <= 200
      ? redactString(rawResult.output)
      : rawResult.output
      ? redactString(rawResult.output.slice(0, 100)) + `... (${outputChars} chars total)`
      : undefined;

  return {
    toolName,
    success: rawResult.success,
    executionTimeMs: rawResult.executionTimeMs,
    outputChars,
    outputBytes,
    spillRef,
    preview,
  };
}
