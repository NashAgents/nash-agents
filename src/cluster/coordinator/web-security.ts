import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export class WebRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "WebRequestError";
  }
}

export function equalSecret(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    try {
      cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // 无效 Cookie 不能使整个 HTTP 服务崩溃。
    }
  }
  return cookies;
}

export function isSecureRequest(req: IncomingMessage, trustProxy = false): boolean {
  return Boolean((req.socket as { encrypted?: boolean }).encrypted) || trustProxy && req.headers["x-forwarded-proto"] === "https";
}

export function acceptsOrigin(req: IncomingMessage, allowedOrigins: readonly string[], trustProxy = false): boolean {
  const origin = req.headers.origin;
  const isMatch = (targetOrigin: string): boolean => {
    if (allowedOrigins.includes(targetOrigin)) return true;
    try {
      const parsed = new URL(targetOrigin);
      const https = isSecureRequest(req, trustProxy);
      return parsed.origin === `${https ? "https" : "http"}://${req.headers.host}`;
    } catch {
      return false;
    }
  };

  if (origin) {
    return isMatch(origin);
  }

  // 若无 Origin 头，退回严格核验 Referer（防伪造与 Referer 泄露绕过）
  const referer = req.headers.referer;
  if (referer) {
    try {
      const refUrl = new URL(referer);
      return isMatch(refUrl.origin);
    } catch {
      return false;
    }
  }

  // 无 Origin 且无 Referer 时（如直接输入 URL 或纯 CLI API 工具调用），放行同机直连
  return true;
}
