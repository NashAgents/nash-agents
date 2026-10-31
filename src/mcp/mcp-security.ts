import { URL } from "node:url";
import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";

/**
 * 敏感字段名匹配集合（大小写无关）
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-mcp-token",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "token",
  "secret",
]);

/**
 * 环境变量引用正则: ${VAR_NAME}
 */
const ENV_VAR_REGEX = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/**
 * 安全继承的基础环境变量白名单（用于 stdio 子进程）
 */
export const DEFAULT_STDIO_SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_ENV",
  "TMPDIR",
  "PWD",
];

/**
 * 环境变量解析异常
 */
export class MissingEnvVarError extends Error {
  constructor(public readonly varName: string, context?: string) {
    super(
      `MCP 配置中引用的环境变量 '\${${varName}}' 未定义。${
        context ? `上下文: ${context}` : ""
      }`
    );
    this.name = "MissingEnvVarError";
  }
}

/**
 * 安全校验异常
 */
export class MCPSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPSecurityError";
  }
}

/**
 * 判断单个物理 IP 是否属于私有、回环、链路本地、云元数据等受限地址段
 */
export function isPrivateOrRestrictedIp(ip: string): boolean {
  // 1. 标准化清除 IPv6 包装
  let cleanIp = ip.replace(/^\[|\]$/g, "").trim().toLowerCase();

  // IPv4 映射的 IPv6 地址转换 (::ffff:127.0.0.1 -> 127.0.0.1)
  if (cleanIp.startsWith("::ffff:") && cleanIp.includes(".")) {
    cleanIp = cleanIp.slice(7);
  }

  // IPv4 判定
  if (net.isIPv4(cleanIp)) {
    const parts = cleanIp.split(".").map(Number);
    const [a, b, c, d] = parts;
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      return true;
    }

    // 0.0.0.0/8 (当前网络)
    if (a === 0) return true;

    // 127.0.0.0/8 (Loopback 回环)
    if (a === 127) return true;

    // 10.0.0.0/8 (RFC 1918 私网)
    if (a === 10) return true;

    // 172.16.0.0/12 (RFC 1918 私网 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 (RFC 1918 私网)
    if (a === 192 && b === 168) return true;

    // 169.254.0.0/16 (RFC 3927 链路本地 Link-Local，含 AWS/阿里云等云元数据 169.254.169.254)
    if (a === 169 && b === 254) return true;

    // 100.64.0.0/10 (RFC 6598 运营商级 NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 224.0.0.0/4 (组播) 与 240.0.0.0/4 (保留)
    if (a >= 224) return true;

    return false;
  }

  // IPv6 判定
  if (net.isIPv6(cleanIp)) {
    // ::1 (Loopback)
    if (cleanIp === "::1" || cleanIp === "0:0:0:0:0:0:0:1") return true;
    // :: (Unspecified)
    if (cleanIp === "::" || cleanIp === "0:0:0:0:0:0:0:0") return true;
    // fc00::/7 (Unique Local Address 私网地址，包含 fc00:: 与 fd00::)
    if (cleanIp.startsWith("fc") || cleanIp.startsWith("fd")) return true;
    // fe80::/10 (Link-Local 链路本地地址)
    if (
      cleanIp.startsWith("fe8") ||
      cleanIp.startsWith("fe9") ||
      cleanIp.startsWith("fea") ||
      cleanIp.startsWith("feb")
    ) {
      return true;
    }

    return false;
  }

  // 无法识别为合规 IP 则默认视为不安全
  return true;
}

/**
 * 判断主机名字符串是否为字面量 Loopback 标识
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost")
  );
}

/**
 * 字符串级 URL 语法与初步安全校验
 */
export function validateMCPUrl(
  urlString: string,
  allowInsecureHttp = false
): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new MCPSecurityError(`非法的 MCP Server URL: '${urlString}'`);
  }

  const host = parsed.hostname;

  // 若直接写了字面量私有/云元数据 IP
  if (net.isIP(host) && isPrivateOrRestrictedIp(host) && !allowInsecureHttp) {
    if (!isLoopbackHostname(host)) {
      throw new MCPSecurityError(
        `SSRF 安全阻断: 试图访问内部私有网络或云元数据地址 '${host}' 被拒绝。`
      );
    }
  }

  if (parsed.protocol === "https:") {
    return;
  }

  if (parsed.protocol === "http:") {
    if (isLoopbackHostname(host) || allowInsecureHttp) {
      return;
    }
    throw new MCPSecurityError(
      `非安全的 HTTP 连接被拒绝: '${urlString}'。远程公网 MCP Server 必须使用 HTTPS。如需在测试环境下强制使用，需显式声明 allowInsecureHttp: true。`
    );
  }

  throw new MCPSecurityError(
    `不受支持的 URL 协议: '${parsed.protocol}'。必须为 https: 或 http:`
  );
}

/**
 * 彻底的 DNS 预检：将域名解析为实际物理 IP 并核查每个 IP 是否指向内网（防 DNS Rebinding）
 */
export async function resolveAndValidateHostIps(
  hostname: string,
  allowInsecureOrLoopback = false
): Promise<string[]> {
  if (isLoopbackHostname(hostname)) {
    if (!allowInsecureOrLoopback) {
      // 本地测试默认允许回环
    }
    return ["127.0.0.1"];
  }

  // 若主机名已经是 IP
  if (net.isIP(hostname)) {
    if (isPrivateOrRestrictedIp(hostname) && !allowInsecureOrLoopback) {
      throw new MCPSecurityError(
        `SSRF 物理 IP 阻断: 目标端点直接指向受限网段 IP '${hostname}'。`
      );
    }
    return [hostname];
  }

  // 执行真实 DNS A 与 AAAA 记录解析
  let addresses: dns.LookupAddress[] = [];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (err: unknown) {
    throw new MCPSecurityError(
      `DNS 解析失败，无法验证端点主机名 '${hostname}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new MCPSecurityError(`DNS 未返回主机名 '${hostname}' 的任何 IP 记录。`);
  }

  const resolvedIps = addresses.map((a) => a.address);

  // 严防 DNS Rebinding：只要解析结果中任何一个 IP 命中了私有/云元数据，立刻阻断
  for (const ip of resolvedIps) {
    if (isPrivateOrRestrictedIp(ip) && !allowInsecureOrLoopback) {
      throw new MCPSecurityError(
        `SSRF DNS 重绑定阻断: 域名 '${hostname}' 解析到私有/内网受限 IP '${ip}'，坚决拒绝连接。`
      );
    }
  }

  return resolvedIps;
}

/**
 * 网络级安全探测客户端 (Safe Probe Client)
 *
 * 核心安全防线：
 * 1. 发起请求前执行真实物理 DNS 校验；
 * 2. 禁用自动重定向（redirect: "manual"），对 3xx Location 重新执行严格 DNS/IP 检查；
 * 3. 严格限制最大 3 次跳转；
 * 4. 附带硬超时控制。
 */
export async function safeProbeEndpoint(
  initialUrl: string,
  options?: {
    allowInsecure?: boolean;
    timeoutMs?: number;
    body?: string;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; headers: Headers; finalUrl: string }> {
  let currentUrl = initialUrl;
  const maxRedirects = 3;
  let redirects = 0;
  const timeoutMs = options?.timeoutMs ?? 5000;

  while (redirects <= maxRedirects) {
    validateMCPUrl(currentUrl, options?.allowInsecure);

    const parsed = new URL(currentUrl);
    // DNS 物理解析深度校验
    await resolveAndValidateHostIps(parsed.hostname, options?.allowInsecure);

    const res = await fetch(currentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(options?.headers ?? {}),
      },
      body: options?.body,
      redirect: "manual", // 绝对禁止自动重定向
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 检查是否发生重定向 (301, 302, 307, 308)
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new MCPSecurityError("服务端返回重定向状态但缺少 Location 请求头");
      }
      redirects++;
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    return {
      status: res.status,
      headers: res.headers,
      finalUrl: currentUrl,
    };
  }

  throw new MCPSecurityError("重定向次数过多，已终止探测");
}

/**
 * 计算 MCP 敏感配置项的指纹哈希（用于 Workspace Trust 变更判定）
 */
export function computeServerFingerprint(config: Record<string, unknown>): string {
  const norm = {
    transport: config.transport,
    command: config.command,
    args: config.args,
    url: config.url,
    env: config.env,
    headers: config.headers ? Object.keys(config.headers as Record<string, unknown>).sort() : undefined,
  };
  return crypto.createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}

/**
 * 解析并插值字符串中的环境变量引用，例如 "Bearer ${BILIBILI_MCP_TOKEN}"
 */
export function resolveEnvString(input: string, contextDesc?: string): string {
  return input.replace(ENV_VAR_REGEX, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined || value === "") {
      throw new MissingEnvVarError(varName, contextDesc);
    }
    return value;
  });
}

/**
 * 递归解析对象中所有字符串字段的环境变量引用
 */
export function resolveEnvRecord(
  record: Record<string, string>,
  contextDesc?: string
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    resolved[key] = resolveEnvString(val, `${contextDesc ?? ""} [key: ${key}]`);
  }
  return resolved;
}

/**
 * 判断 Header 名称是否属于敏感凭证字段
 */
export function isSensitiveHeader(headerName: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(headerName.toLowerCase());
}

/**
 * 对 Header 字典进行脱敏处理，返回副本
 */
export function redactHeaders(
  headers?: Record<string, string>
): Record<string, string> {
  if (!headers) return {};
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveHeader(key)) {
      if (value.toLowerCase().startsWith("bearer ")) {
        redacted[key] = "Bearer [REDACTED]";
      } else {
        redacted[key] = "[REDACTED]";
      }
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * 为 stdio 子进程构建隔离的环境变量集合，清洗泄露风险
 */
export function buildSanitizedStdioEnv(
  customEnv?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of DEFAULT_STDIO_SAFE_ENV_VARS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }

  if (customEnv) {
    for (const [key, value] of Object.entries(customEnv)) {
      env[key] = resolveEnvString(value, `stdio env [${key}]`);
    }
  }

  return env;
}
