import type { ChatMessage, ToolCall } from "../model/chat-completions-client.js";

export interface ToolResultPrunerOptions {
  /**
   * 保留最近不被修剪的 Tool 消息数量（默认 2）
   */
  keepRecentToolCount?: number;

  /**
   * 修剪后保留在 summary 中的摘要长度上限（默认 120 字符）
   */
  maxSummaryChars?: number;
}

export interface PruneResult {
  messages: ChatMessage[];
  prunedCount: number;
  freedChars: number;
}

/**
 * ToolResult 渐进式修剪器：在触发全面 LLM Compaction 前，优先清理旧的历史工具大输出
 */
export class ToolResultPruner {
  private readonly keepRecentToolCount: number;
  private readonly maxSummaryChars: number;

  constructor(options?: ToolResultPrunerOptions) {
    this.keepRecentToolCount = options?.keepRecentToolCount ?? 2;
    this.maxSummaryChars = options?.maxSummaryChars ?? 120;
  }

  /**
   * 对消息列表中的旧 ToolResult 执行修剪
   */
  prune(messages: ChatMessage[]): PruneResult {
    // 1. 建立 tool_call_id -> ToolCall 元数据的索引映射
    const toolCallMap = new Map<string, { toolName: string; args: string }>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallMap.set(tc.id, {
            toolName: tc.function.name,
            args: tc.function.arguments,
          });
        }
      }
    }

    // 2. 收集所有 role === "tool" 的消息索引
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        toolIndices.push(i);
      }
    }

    // 若工具消息数量小于等于保留数量，无需修剪
    if (toolIndices.length <= this.keepRecentToolCount) {
      return {
        messages: [...messages],
        prunedCount: 0,
        freedChars: 0,
      };
    }

    // 计算可被修剪的索引范围（除了最后 keepRecentToolCount 个）
    const candidateIndices = new Set(
      toolIndices.slice(0, toolIndices.length - this.keepRecentToolCount)
    );

    let prunedCount = 0;
    let freedChars = 0;

    const newMessages: ChatMessage[] = messages.map((msg, index) => {
      if (!candidateIndices.has(index) || msg.role !== "tool") {
        return msg;
      }

      const rawContent = typeof msg.content === "string" ? msg.content : "";

      // 如果已经是修剪过的 stub，跳过
      if (rawContent.startsWith("[Previous tool output pruned]")) {
        return msg;
      }

      const toolCallId = msg.tool_call_id ?? "unknown_call_id";
      const meta = toolCallMap.get(toolCallId);
      const toolName = meta?.toolName ?? "unknown_tool";

      // 提取可能存在的 SpillRef
      let spillRef: string | undefined;
      const spillMatch = rawContent.match(/tool-result:\/\/[a-zA-Z0-9_-]+/);
      if (spillMatch) {
        spillRef = spillMatch[0];
      }

      // 生成简要摘要说明
      let summary = "";
      if (meta?.args) {
        try {
          const parsed = JSON.parse(meta.args);
          if (parsed.path) {
            summary = `file '${parsed.path}'`;
          } else if (parsed.pattern) {
            summary = `search pattern '${parsed.pattern}'`;
          } else if (parsed.command) {
            summary = `command '${parsed.command.slice(0, 50)}'`;
          } else {
            summary = JSON.stringify(parsed).slice(0, this.maxSummaryChars);
          }
        } catch {
          summary = meta.args.slice(0, this.maxSummaryChars);
        }
      } else {
        const firstLine = rawContent.split("\n")[0] ?? "";
        summary = firstLine.slice(0, this.maxSummaryChars);
      }

      const stubLines = [
        "[Previous tool output pruned]",
        `tool: ${toolName}`,
        `tool_call_id: ${toolCallId}`,
      ];

      if (spillRef) {
        stubLines.push(`spill_ref: ${spillRef}`);
      }
      stubLines.push(`summary: ${summary}`);

      const stubContent = stubLines.join("\n");
      const saved = rawContent.length - stubContent.length;

      if (saved > 0) {
        freedChars += saved;
      }
      prunedCount++;

      return {
        role: "tool",
        tool_call_id: toolCallId,
        content: stubContent,
      };
    });

    return {
      messages: newMessages,
      prunedCount,
      freedChars,
    };
  }
}
