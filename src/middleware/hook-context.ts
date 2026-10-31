import type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../model/chat-completions-client.js";
import type { Tool, ToolResult } from "../tools/index.js";

/**
 * Agent 顶层生命周期上下文
 */
export interface AgentHookContext {
  /**
   * 用户输入的原始提示词
   */
  userInput: string;

  /**
   * 当前会话上下文消息列表
   */
  messages: ChatMessage[];

  /**
   * Agent 最终生成的回复文本（在 afterAgentRun 阶段可用）
   */
  response?: string;

  /**
   * 运行过程中捕获的错误对象（在 onAgentError 阶段可用）
   */
  error?: Error;

  /**
   * 跨生命周期透传的自定义元数据
   */
  metadata: Record<string, unknown>;
}

/**
 * Model 大模型调用层生命周期上下文
 */
export interface ModelHookContext {
  /**
   * 补全请求参数（包含 model、messages、tools 等）
   */
  request: ChatCompletionRequest;

  /**
   * 模型接口返回的原始响应结构（在 afterModelCall 阶段可用）
   */
  response?: ChatCompletionResponse;

  /**
   * 模型调用过程中抛出的异常错误（在 onModelError 阶段可用）
   */
  error?: Error;

  /**
   * 跨生命周期透传的自定义元数据
   */
  metadata: Record<string, unknown>;
}

/**
 * Tool 工具执行层生命周期上下文
 */
export interface ToolHookContext {
  /**
   * 正在调用的工具名称
   */
  toolName: string;

  /**
   * 原始入参（JSON 字符串或对象）
   */
  rawArgs: string | unknown;

  /**
   * 已解析并通过校验的结构化键值对参数对象（供权限检查、沙箱判定、参数审计使用）
   */
  parsedArgs?: Record<string, unknown>;

  /**
   * 匹配到的工具定义实例（若工具未找到则为 undefined）
   */
  tool?: Tool;

  /**
   * 工具执行后返回的标准化结果（在 afterToolExecute 阶段可用）
   */
  result?: ToolResult;

  /**
   * 工具执行或参数解析过程中捕获的错误（在 onToolError 阶段可用）
   */
  error?: Error;

  /**
   * 跨生命周期透传的自定义元数据
   */
  metadata: Record<string, unknown>;
}
