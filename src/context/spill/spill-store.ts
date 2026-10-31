import type { SpillRef } from "../types.js";

/**
 * 分页与切片读取选项
 */
export interface SpillReadOptions {
  /**
   * 起始行号（从 1 开始计数，默认 1）
   */
  offset?: number;

  /**
   * 读取的最大行数
   */
  limit?: number;

  /**
   * 起始字符偏移量（从 0 开始计数，默认 0）
   */
  charOffset?: number;

  /**
   * 单次读取返回的最大字符数硬限制（防止超长单行撑爆 Context）
   */
  maxChars?: number;
}

/**
 * 分页读取结果结构
 */
export interface SpillReadResult {
  /**
   * 读取出的切片文本内容
   */
  content: string;

  /**
   * 起始行号 (1-indexed)
   */
  startLine: number;

  /**
   * 结束行号 (1-indexed)
   */
  endLine: number;

  /**
   * Artifact 原始总行数
   */
  totalLines: number;

  /**
   * 起始字符偏移 (0-indexed)
   */
  startChar: number;

  /**
   * 结束字符偏移 (0-indexed)
   */
  endChar: number;

  /**
   * Artifact 原始总字符数
   */
  totalChars: number;

  /**
   * 是否还有后续未读内容
   */
  hasMore: boolean;

  /**
   * 下一页行号偏移量（若 hasMore 为 true）
   */
  nextLineOffset?: number;

  /**
   * 下一页字符偏移量（若 hasMore 为 true）
   */
  nextCharOffset?: number;

  /**
   * 该 Artifact 的标准定位符
   */
  locator: string;
}

/**
 * Artifact 元数据信息
 */
export interface SpillArtifactInfo {
  id: string;
  locator: string;
  sessionId: string;
  bytes: number;
  chars: number;
  createdAt: number;
  toolName?: string;
  toolCallId?: string;
}

/**
 * Spill 存储层标准接口 (SPI)
 */
export interface SpillStore {
  /**
   * 保存完整 ToolResult 内容至外部存储，返回不透明 SpillRef
   */
  save(
    content: string,
    options?: {
      sessionId?: string;
      toolName?: string;
      toolCallId?: string;
      artifactId?: string;
    }
  ): Promise<SpillRef>;

  /**
   * 按行/字符分页读取 Artifact 切片内容（支持超长单行安全截断）
   */
  read(
    refOrLocatorOrId: string | SpillRef,
    options?: SpillReadOptions
  ): Promise<SpillReadResult>;

  /**
   * 获取指定 Artifact 的元数据
   */
  get(refOrLocatorOrId: string | SpillRef): Promise<SpillArtifactInfo | null>;

  /**
   * 删除指定 Artifact
   */
  delete(refOrLocatorOrId: string | SpillRef): Promise<boolean>;

  /**
   * 列出指定 Session 或所有 Session 的 Artifact
   */
  list(sessionId?: string): Promise<SpillArtifactInfo[]>;

  /**
   * 获取指定 Session 当前占用的 Spill 存储总字节数
   */
  getSessionBytes(sessionId: string): Promise<number>;

  /**
   * 获取全局 Spill 存储占用的总字节数
   */
  getGlobalBytes(): Promise<number>;
}
