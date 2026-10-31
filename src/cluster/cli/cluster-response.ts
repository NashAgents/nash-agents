/**
 * CLI 对 Coordinator HTTP 响应的解释层：纯函数、无网络、无凭证读取。
 * 目的是让"401/403/5xx 被当成空列表"这类误判在单测中可直接复现。
 */

export interface ClusterNodesPayload {
  nodes: unknown[];
  [key: string]: unknown;
}

export interface ClusterResponseInterpretation {
  /** 是否可继续渲染成功结果。 */
  ok: boolean;
  /** 进程退出码语义：成功为 0，任何失败为 1。 */
  exitCode: number;
  /** 面向用户的可读消息；成功时可能为空。 */
  message: string;
  /** 仅在 HTTP 2xx 且结构合法时提供。 */
  data?: ClusterNodesPayload;
}

const DETAIL_LIMIT = 300;
const AUTH_GUIDANCE =
  "Set NASH_ADMIN_API_KEY to the Coordinator's admin API key, or log in to the Web console and reuse its session.";

function extractDetail(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return "";
  let detail = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const candidate = record.error ?? record.message ?? record.detail;
      if (typeof candidate === "string" && candidate.trim()) detail = candidate.trim();
    }
  } catch {
    // 非 JSON 错误体（例如反代返回的 HTML）直接使用原始文本片段。
  }
  detail = detail.replace(/\s+/g, " ").trim();
  return detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}…` : detail;
}

function withDetail(message: string, bodyText: string): string {
  const detail = extractDetail(bodyText);
  if (!detail) return message;
  // 避免出现 "session.: detail" 这类双标点。
  return `${message.replace(/[.。]\s*$/, "")}: ${detail}`;
}

/**
 * 将一次 `GET /api/cluster/nodes` 的 HTTP 状态与响应体翻译为可读消息 + 退出码语义。
 * 绝不把非 2xx 响应当成"没有节点"。
 */
export function interpretClusterResponse(
  status: number,
  bodyText: string,
  targetUrl: string
): ClusterResponseInterpretation {
  if (status === 401) {
    return {
      ok: false,
      exitCode: 1,
      message: withDetail(
        `Coordinator authentication failed (HTTP 401) at ${targetUrl}. ${AUTH_GUIDANCE}`,
        bodyText
      ),
    };
  }
  if (status === 403) {
    return {
      ok: false,
      exitCode: 1,
      message: withDetail(
        `Permission denied (HTTP 403) at ${targetUrl}: the current credentials cannot read cluster nodes. ` +
          "Use an admin-level NASH_ADMIN_API_KEY or an admin Web console session.",
        bodyText
      ),
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      exitCode: 1,
      message: withDetail(`Coordinator server error (HTTP ${status}) at ${targetUrl}`, bodyText),
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      exitCode: 1,
      message: withDetail(`Request to ${targetUrl} failed (HTTP ${status})`, bodyText),
    };
  }

  const trimmed = bodyText.trim();
  if (!trimmed) {
    return {
      ok: false,
      exitCode: 1,
      message: `Unexpected response from ${targetUrl} (HTTP ${status}): empty body, expected JSON with a "nodes" array.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // JSON.parse 的报错自带片段会被截断，这里补充响应体开头，便于定位（例如反代 HTML）。
    const excerpt = trimmed.replace(/\s+/g, " ").slice(0, 120);
    return {
      ok: false,
      exitCode: 1,
      message: `Unexpected response from ${targetUrl} (HTTP ${status}): not valid JSON (${reason}); body starts with: ${excerpt}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      exitCode: 1,
      message: `Unexpected response from ${targetUrl} (HTTP ${status}): expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
    };
  }

  const nodes = (parsed as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      exitCode: 1,
      message: `Unexpected response from ${targetUrl} (HTTP ${status}): missing "nodes" array.`,
    };
  }

  const data = parsed as ClusterNodesPayload;
  if (nodes.length === 0) {
    return { ok: true, exitCode: 0, message: "No nodes registered yet.", data };
  }
  return { ok: true, exitCode: 0, message: "", data };
}

/** 连接失败（拒连、DNS、TLS、超时）时的可读消息，必须包含目标地址。 */
export function formatClusterConnectionError(targetUrl: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const codeSuffix = code && !reason.includes(code) ? ` (${code})` : "";
  return (
    `Failed to connect to Coordinator at ${targetUrl}: ${reason}${codeSuffix}. ` +
    "Check that the Coordinator is running and NASH_COORDINATOR_URL points at it."
  );
}
