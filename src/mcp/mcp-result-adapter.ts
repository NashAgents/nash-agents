import type { ToolResult } from "../tools/executor.js";
import type { SpillStore } from "../context/spill/spill-store.js";

export interface MCPResultAdapterOptions {
  spillStore?: SpillStore;
  sessionId?: string;
  maxInlineChars?: number;
}

export const DEFAULT_MAX_INLINE_CHARS = 24_000; // 约 6000 tokens，超过此大小触发溢出落盘保护

/**
 * MCP 结果适配器：统一将 MCP CallToolResult 转换为 Nash ToolResult
 */
export class MCPResultAdapter {
  private readonly spillStore?: SpillStore;
  private readonly sessionId?: string;
  private readonly maxInlineChars: number;

  constructor(options?: MCPResultAdapterOptions) {
    this.spillStore = options?.spillStore;
    this.sessionId = options?.sessionId;
    this.maxInlineChars = options?.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
  }

  /**
   * 将原始 MCP 工具调用返回值格式化为 Nash 标准化的 ToolResult
   */
  async formatResult(
    rawResult: unknown,
    toolName: string,
    toolCallId?: string,
    executionTimeMs = 0
  ): Promise<ToolResult> {
    if (!rawResult || typeof rawResult !== "object") {
      return {
        success: true,
        output: String(rawResult ?? "(无输出)"),
        executionTimeMs,
      };
    }

    const obj = rawResult as Record<string, unknown>;
    const isError = Boolean(obj.isError);

    const parts: string[] = [];

    // 解析 MCP 标准 content 数组
    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        if (!item || typeof item !== "object") {
          parts.push(String(item));
          continue;
        }

        const type = (item as any).type;
        if (type === "text" && typeof (item as any).text === "string") {
          parts.push((item as any).text);
        } else if (type === "image") {
          const mime = (item as any).mimeType || "image/*";
          const len = typeof (item as any).data === "string" ? (item as any).data.length : 0;
          parts.push(`[MCP Image Content: mimeType=${mime}, base64Length=${len}]`);
        } else if (type === "audio") {
          const mime = (item as any).mimeType || "audio/*";
          const len = typeof (item as any).data === "string" ? (item as any).data.length : 0;
          parts.push(`[MCP Audio Content: mimeType=${mime}, base64Length=${len}]`);
        } else if (type === "resource" && (item as any).resource) {
          const res = (item as any).resource;
          if (typeof res.text === "string") {
            parts.push(`[MCP Resource: ${res.uri}]\n${res.text}`);
          } else if (typeof res.blob === "string") {
            parts.push(`[MCP Resource Blob: ${res.uri}, mimeType=${res.mimeType || "unknown"}]`);
          } else {
            parts.push(`[MCP Resource: ${res.uri}]`);
          }
        } else {
          try {
            parts.push(JSON.stringify(item, null, 2));
          } catch {
            parts.push(String(item));
          }
        }
      }
    } else if (typeof obj.output === "string") {
      parts.push(obj.output);
    } else {
      try {
        parts.push(JSON.stringify(obj, null, 2));
      } catch {
        parts.push(String(obj));
      }
    }

    let fullOutput = parts.join("\n\n").trim();
    if (!fullOutput) {
      fullOutput = isError ? "MCP 工具返回执行失败，但未提供详细错误文本。" : "(工具调用成功，无输出内容)";
    }

    // 大结果 SpillStore 治理：超出阈值时持久化落盘，返回紧凑切片与读取引导
    if (fullOutput.length > this.maxInlineChars && !this.spillStore) {
      // 没有落盘存储时也绝不把远端返回的任意长文本整体塞进上下文：
      // 外部 MCP Server 可返回无界内容，直接注入会挤爆窗口。
      const dropped = fullOutput.length - this.maxInlineChars;
      fullOutput = `${fullOutput.slice(0, this.maxInlineChars)}\n\n[MCP 输出超出上限 ${this.maxInlineChars} 字符，已截断 ${dropped} 字符（当前会话未启用落盘存储）]`;
    }

    if (fullOutput.length > this.maxInlineChars && this.spillStore) {
      try {
        const spillRef = await this.spillStore.save(fullOutput, {
          sessionId: this.sessionId,
          toolName,
          toolCallId,
        });

        const totalLines = fullOutput.split("\n").length;
        const totalChars = fullOutput.length;
        const preview = fullOutput.slice(0, 1200);

        fullOutput = `[MCP Tool Result Exceeded Limit - Automatically Spilled]
Artifact Locator: ${spillRef.locator}
Total Lines: ${totalLines} | Total Characters: ${totalChars}
Preview (first 1200 chars):
${preview}
... [剩余内容已截断并落盘]

提示：完整输出已保存至外部存储。如需继续查看后续内容，可使用 read_tool_result 工具分页读取：
{ "locator": "${spillRef.locator}", "offset": 1, "limit": 100 }`;
      } catch (spillErr) {
        console.warn(
          `[MCPResultAdapter] 落盘保存失败，保留原始截断输出:`,
          spillErr instanceof Error ? spillErr.message : String(spillErr)
        );
      }
    }

    return {
      success: !isError,
      output: fullOutput,
      error: isError ? fullOutput : undefined,
      executionTimeMs,
    };
  }
}
