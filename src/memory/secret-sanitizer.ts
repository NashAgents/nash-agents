/**
 * 敏感信息与私密凭据正则检测模式
 */
const SENSITIVE_PATTERNS = [
  // API Keys / Tokens
  /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|jwt[_-]?token|bearer)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{16,})["']?/gi,
  // DeepSeek / OpenAI / Anthropic / GitHub / AWS key prefixes
  /(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40})/g,
  // Passwords
  /(?:password|passwd|pwd)\s*[:=]\s*["']?([^"'\s\n\r]{6,})["']?/gi,
  // Authorization Headers
  /Authorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Private Keys
  /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
  // Cookies / Session Tokens
  /(?:session[_-]?id|cookie)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{24,})["']?/gi,
];

/**
 * 检查文本是否包含明显的私密信息
 */
export function containsSecret(text: string): boolean {
  if (!text || typeof text !== "string") {
    return false;
  }
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * 净化文本中的敏感信息，将检测到的私密凭据替换为 [REDACTED_SECRET]
 */
export function sanitizeSecretText(text: string): string {
  if (!text || typeof text !== "string") {
    return text;
  }
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      // 保留前缀键名，仅遮蔽实际凭价值
      if (match.includes(":") || match.includes("=")) {
        const parts = match.split(/[:=]/);
        const prefix = parts[0];
        const delimiter = match.includes("=") ? "=" : ":";
        return `${prefix}${delimiter} "[REDACTED_SECRET]"`;
      }
      return "[REDACTED_SECRET]";
    });
  }
  return result;
}
