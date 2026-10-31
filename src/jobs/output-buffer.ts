import type { OutputBufferSnapshot } from "./types.js";

export interface BoundedOutputBufferOptions {
  /**
   * 内存中保留的最大字节数，默认为 2MB (2 * 1024 * 1024)
   */
  maxRetainedBytes?: number;
}

/**
 * 有容量上限的进程输出流缓冲区 (Bounded Output Buffer)
 *
 * 铁律：
 * 1. 杜绝后台进程产生几十 MB 输出时无限撑爆 Node.js 堆内存；
 * 2. 精确维护 totalBytes (总生成字节数) 与 retainedBytes (当前保留字节数)；
 * 3. 超过 maxRetainedBytes 时自动对头部旧数据进行安全截断 (FIFO Sliding Window)，保留最新的尾部输出 (tail)。
 */
export class BoundedOutputBuffer {
  private readonly maxRetainedBytes: number;

  private stdoutChunks: string[] = [];
  private stderrChunks: string[] = [];
  private combinedChunks: string[] = [];

  private totalStdoutBytes = 0;
  private totalStderrBytes = 0;
  private totalCombinedBytes = 0;

  private retainedStdoutBytes = 0;
  private retainedStderrBytes = 0;
  private retainedCombinedBytes = 0;

  private stdoutTruncated = false;
  private stderrTruncated = false;
  private combinedTruncated = false;

  constructor(options?: BoundedOutputBufferOptions) {
    this.maxRetainedBytes = options?.maxRetainedBytes ?? 2 * 1024 * 1024; // 2MB
  }

  /**
   * 追加 stdout 数据块
   */
  appendStdout(chunk: string): void {
    if (!chunk) return;
    const byteLen = Buffer.byteLength(chunk, "utf-8");
    this.totalStdoutBytes += byteLen;
    this.stdoutChunks.push(chunk);
    this.retainedStdoutBytes += byteLen;

    this.trimChunks(
      this.stdoutChunks,
      this.retainedStdoutBytes,
      (newRetained) => {
        this.retainedStdoutBytes = newRetained;
        this.stdoutTruncated = true;
      }
    );

    this.appendCombined(chunk);
  }

  /**
   * 追加 stderr 数据块
   */
  appendStderr(chunk: string): void {
    if (!chunk) return;
    const byteLen = Buffer.byteLength(chunk, "utf-8");
    this.totalStderrBytes += byteLen;
    this.stderrChunks.push(chunk);
    this.retainedStderrBytes += byteLen;

    this.trimChunks(
      this.stderrChunks,
      this.retainedStderrBytes,
      (newRetained) => {
        this.retainedStderrBytes = newRetained;
        this.stderrTruncated = true;
      }
    );

    this.appendCombined(chunk);
  }

  private appendCombined(chunk: string): void {
    const byteLen = Buffer.byteLength(chunk, "utf-8");
    this.totalCombinedBytes += byteLen;
    this.combinedChunks.push(chunk);
    this.retainedCombinedBytes += byteLen;

    this.trimChunks(
      this.combinedChunks,
      this.retainedCombinedBytes,
      (newRetained) => {
        this.retainedCombinedBytes = newRetained;
        this.combinedTruncated = true;
      }
    );
  }

  private trimChunks(
    chunks: string[],
    currentRetained: number,
    onTrimmed: (newRetained: number) => void
  ): void {
    if (currentRetained <= this.maxRetainedBytes) {
      return;
    }

    let excess = currentRetained - this.maxRetainedBytes;
    while (chunks.length > 0 && excess > 0) {
      const firstChunk = chunks[0];
      const firstChunkBytes = Buffer.byteLength(firstChunk, "utf-8");

      if (firstChunkBytes <= excess) {
        chunks.shift();
        currentRetained -= firstChunkBytes;
        excess -= firstChunkBytes;
      } else {
        // 部分截断第一个 chunk
        const remainingBytes = firstChunkBytes - excess;
        // 简单按字符估算截断
        const sliceRatio = remainingBytes / firstChunkBytes;
        const charLen = Math.floor(firstChunk.length * sliceRatio);
        chunks[0] = firstChunk.slice(firstChunk.length - charLen);
        currentRetained -= excess;
        excess = 0;
      }
    }

    onTrimmed(currentRetained);
  }

  /**
   * 获取当前输出快照
   */
  getSnapshot(): OutputBufferSnapshot {
    return {
      totalBytes: this.totalCombinedBytes,
      retainedBytes: this.retainedCombinedBytes,
      truncated: this.combinedTruncated,
      stdoutTail: this.stdoutChunks.join(""),
      stderrTail: this.stderrChunks.join(""),
      combinedTail: this.combinedChunks.join(""),
    };
  }

  /**
   * 获取指定行数的最近尾部文本
   */
  getTailLines(maxLines = 50): string {
    const fullText = this.combinedChunks.join("");
    const lines = fullText.trimEnd().split(/\r?\n/);
    if (lines.length <= maxLines) {
      return fullText;
    }
    const tailLines = lines.slice(lines.length - maxLines);
    return `... [前序输出已省略，仅保留最近 ${maxLines} 行]\n` + tailLines.join("\n");
  }

  /**
   * 获取格式化后的最终摘要输出（包含 stdout 与 stderr 区分）
   */
  getFormattedSummary(maxChars = 4000): string {
    const stdout = this.stdoutChunks.join("").trim();
    const stderr = this.stderrChunks.join("").trim();

    const parts: string[] = [];
    if (stdout) {
      const trimmedStdout =
        stdout.length > maxChars
          ? stdout.slice(stdout.length - maxChars) + `\n... [stdout 已截断，总大小: ${this.totalStdoutBytes} 字节]`
          : stdout;
      parts.push(trimmedStdout);
    }

    if (stderr) {
      const trimmedStderr =
        stderr.length > maxChars
          ? stderr.slice(stderr.length - maxChars) + `\n... [stderr 已截断，总大小: ${this.totalStderrBytes} 字节]`
          : stderr;
      parts.push(`STDERR:\n${trimmedStderr}`);
    }

    if (parts.length === 0) {
      return "(无输出)";
    }

    return parts.join("\n");
  }
}
