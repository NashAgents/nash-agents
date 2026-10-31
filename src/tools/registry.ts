import type { ChatCompletionTool } from "../model/chat-completions-client.js";
import { type Tool, toChatCompletionTool } from "./tool.js";

/**
 * 工具注册中心（ToolRegistry）
 *
 * 负责工具的管理与元数据导出：
 * 1. 维护工具注册表（添加、批量注册、查询、注销）；
 * 2. 导出符合大模型格式的 tools Schema 定义。
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * 注册单个工具
   */
  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /**
   * 批量注册多个工具
   */
  registerMany(tools: Tool[]): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  /**
   * 检查指定工具是否已注册
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  hasTool(name: string): boolean {
    return this.has(name);
  }

  /**
   * 按名称注销指定工具
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 按名称获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getTool(name: string): Tool | undefined {
    return this.get(name);
  }

  /**
   * 获取所有已注册的工具
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 导出所有已注册工具的 OpenAI ChatCompletionTool 定义列表
   */
  getDefinitions(): ChatCompletionTool[] {
    return this.getAll().map(toChatCompletionTool);
  }
}
