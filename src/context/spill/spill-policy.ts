import type { SpillPolicy } from "../types.js";

/**
 * 默认 Spill 存储治理策略
 */
export const DEFAULT_SPILL_POLICY: SpillPolicy = {
  enabled: true,
  maxInlineChars: 16_000,
  maxArtifactBytes: 16 * 1024 * 1024, // 16 MB
  maxSessionBytes: 256 * 1024 * 1024, // 256 MB
  maxGlobalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  retentionDays: 7,
};

/**
 * 当单个 Artifact 大小超过 maxArtifactBytes 时抛出
 */
export class SpillArtifactQuotaError extends Error {
  constructor(size: number, limit: number) {
    super(
      `SpillArtifactQuotaExceeded: Artifact 字节数 (${size} B) 超过单文件上限 (${limit} B)`
    );
    this.name = "SpillArtifactQuotaError";
  }
}

/**
 * 当单 Session 总 Spill 字节数超过 maxSessionBytes 时抛出
 */
export class SpillSessionQuotaError extends Error {
  constructor(sessionId: string, current: number, limit: number) {
    super(
      `SpillSessionQuotaExceeded: 会话 '${sessionId}' Spill 总量 (${current} B) 超过会话配额 (${limit} B)`
    );
    this.name = "SpillSessionQuotaError";
  }
}

/**
 * 当全局 Spill 字节数超过 maxGlobalBytes 且无法通过 GC 清理时抛出
 */
export class SpillGlobalQuotaError extends Error {
  constructor(current: number, limit: number) {
    super(
      `SpillGlobalQuotaExceeded: 全局 Spill 存储 (${current} B) 超过上限 (${limit} B)`
    );
    this.name = "SpillGlobalQuotaError";
  }
}
