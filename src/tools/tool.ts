import type { ChatCompletionTool } from "../model/chat-completions-client.js";

/**
 * Agent 工具接口定义
 */
export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export interface Tool<TArgs = any, TResult = unknown> {
  readonly name: string;
  readonly executionKind?: "process" | "read" | "write";
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  execute(args: TArgs, context?: ToolExecutionContext): Promise<TResult> | TResult;
}

/**
 * 将 Tool 实例转换为 OpenAI 兼容的 ChatCompletionTool 定义
 */
export function toChatCompletionTool(tool: Tool): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {
        type: "object",
        properties: {},
      },
    },
  };
}

/**
 * 定义工具的类型辅助函数
 */
export function defineTool<TArgs = any, TResult = unknown>(
  tool: Tool<TArgs, TResult>
): Tool<TArgs, TResult> {
  return tool;
}
