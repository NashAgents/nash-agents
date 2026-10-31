import type { MCPConnectionManager } from "./mcp-connection-manager.js";
import type { MCPPromptDefinition } from "./types.js";

/**
 * MCP Prompt 管理中心：负责读取与渲染远程 MCP Prompts
 */
export class MCPPromptManager {
  constructor(private readonly connectionManager: MCPConnectionManager) {}

  /**
   * 列出所有可用的 Prompts 模板
   */
  listPrompts(serverName?: string): MCPPromptDefinition[] {
    const all = this.connectionManager.getAllPrompts();
    if (serverName) {
      return all.filter((p) => p.serverName === serverName);
    }
    return all;
  }

  /**
   * 获取并渲染指定 Prompt
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<unknown> {
    return await this.connectionManager.getPrompt(serverName, promptName, args);
  }
}
