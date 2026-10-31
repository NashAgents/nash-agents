import * as crypto from "node:crypto";
import {
  CLUSTER_PROTOCOL_VERSION,
  type ClusterEnvelope,
  type ClusterMessageType,
} from "./types.js";

/**
 * 默认单条协议消息大小上限 (1MB)，防止超大恶意载荷撑爆内存
 */
export const MAX_MESSAGE_SIZE_BYTES = 1024 * 1024;

export function approvalResolutionMessageId(approvalId: string): string {
  return `appr-${crypto.createHash("sha256").update(approvalId).digest("hex").slice(0, 32)}`;
}

/**
 * Stable dispatch identity for one task attempt. A coordinator crash between persisting
 * the task and enqueuing the dispatch must not create a second outbox row for it.
 */
export function dispatchMessageId(taskId: string, runId: string, dispatchAttempt: number): string {
  return `disp-${crypto.createHash("sha256").update(`${taskId}:${runId}:${dispatchAttempt}`).digest("hex").slice(0, 32)}`;
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(`[ClusterProtocol] ${message}`);
    this.name = "ProtocolError";
  }
}

/**
 * 创建符合标准信封格式的消息
 */
export function createEnvelope<T = unknown>(
  type: ClusterMessageType,
  payload: T,
  sourceNodeId: string,
  targetNodeId: string,
  correlationId?: string
): ClusterEnvelope<T> {
  return {
    protocolVersion: CLUSTER_PROTOCOL_VERSION,
    messageId: `msg-${crypto.randomUUID().slice(0, 12)}`,
    correlationId,
    sourceNodeId,
    targetNodeId,
    timestamp: Date.now(),
    type,
    payload,
  };
}

/**
 * 将信封序列化为 JSON 字符串，附带体积保护
 */
export function encodeEnvelope<T>(envelope: ClusterEnvelope<T>): string {
  const json = JSON.stringify(envelope);
  if (Buffer.byteLength(json, "utf-8") > MAX_MESSAGE_SIZE_BYTES) {
    throw new ProtocolError(
      `Message size exceeds maximum limit of ${MAX_MESSAGE_SIZE_BYTES} bytes`,
      "MESSAGE_TOO_LARGE"
    );
  }
  return json;
}

/**
 * 反序列化并严格校验入站消息信封
 */
export function decodeEnvelope(raw: string | Buffer): ClusterEnvelope {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.length > MAX_MESSAGE_SIZE_BYTES) {
      throw new ProtocolError(
        `Buffer size exceeds maximum limit of ${MAX_MESSAGE_SIZE_BYTES} bytes`,
        "MESSAGE_TOO_LARGE"
      );
    }
    text = raw.toString("utf-8");
  } else {
    throw new ProtocolError("Incoming message must be string or Buffer", "INVALID_INPUT_TYPE");
  }

  if (Buffer.byteLength(text, "utf-8") > MAX_MESSAGE_SIZE_BYTES) {
    throw new ProtocolError(
      `Message size exceeds maximum limit of ${MAX_MESSAGE_SIZE_BYTES} bytes`,
      "MESSAGE_TOO_LARGE"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProtocolError(
      `Invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`,
      "MALFORMED_JSON"
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ProtocolError("Envelope must be an object", "INVALID_ENVELOPE");
  }

  const env = parsed as Partial<ClusterEnvelope>;

  if (env.protocolVersion !== CLUSTER_PROTOCOL_VERSION) {
    throw new ProtocolError(
      `Unsupported protocol version: ${env.protocolVersion ?? "unknown"}, expected ${CLUSTER_PROTOCOL_VERSION}`,
      "VERSION_MISMATCH"
    );
  }

  if (typeof env.messageId !== "string" || !env.messageId) {
    throw new ProtocolError("Missing or invalid messageId", "INVALID_ENVELOPE");
  }

  if (typeof env.type !== "string" || !env.type) {
    throw new ProtocolError("Missing or invalid message type", "INVALID_ENVELOPE");
  }

  if (typeof env.sourceNodeId !== "string" || !env.sourceNodeId) {
    throw new ProtocolError("Missing or invalid sourceNodeId", "INVALID_ENVELOPE");
  }

  if (typeof env.targetNodeId !== "string" || !env.targetNodeId) {
    throw new ProtocolError("Missing or invalid targetNodeId", "INVALID_ENVELOPE");
  }

  if (typeof env.timestamp !== "number" || isNaN(env.timestamp)) {
    throw new ProtocolError("Missing or invalid timestamp", "INVALID_ENVELOPE");
  }

  if (env.payload === undefined) {
    throw new ProtocolError("Missing payload in envelope", "INVALID_ENVELOPE");
  }

  return env as ClusterEnvelope;
}
