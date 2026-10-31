import type { Tool } from "../tools/tool.js";
import type { ToolResult } from "../tools/executor.js";
import type { MCPToolDiscovery } from "./mcp-tool-discovery.js";

export interface SearchMCPToolsArgs {
  query: string;
  server?: string;
  limit?: number;
}

export interface SearchMCPToolsHandler {
  onToolsFound?: (toolNames: string[]) => void | Promise<void>;
}

/**
 * search_mcp_tools 工具：支持模型自主渐进式检索与动态激活 MCP 外部工具
 */
export class SearchMCPToolsTool implements Tool<SearchMCPToolsArgs> {
  public readonly name = "search_mcp_tools";
  public readonly description =
    "Search available tools across all connected Model Context Protocol (MCP) servers by intent or keywords. When matched, tools are dynamically activated and their complete schemas become available in subsequent steps.";

  public readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords or functional intent to search for (e.g. 'bilibili subtitle', 'postgres query', 'git')",
      },
      server: {
        type: "string",
        description: "Optional server name filter to constrain the search",
      },
      limit: {
        type: "integer",
        description: "Maximum number of matching tools to return (default 8)",
      },
    },
    required: ["query"],
  };

  constructor(
    private readonly discovery: MCPToolDiscovery,
    private readonly handler?: SearchMCPToolsHandler
  ) {}

  async execute(args: SearchMCPToolsArgs): Promise<ToolResult> {
    const startTime = Date.now();
    const query = args.query?.trim();

    if (!query) {
      return {
        success: false,
        output: "Error: 搜索查询参数 'query' 不能为空。",
        executionTimeMs: Date.now() - startTime,
      };
    }

    const matches = this.discovery.search(query, args.server, args.limit ?? 8);

    if (matches.length === 0) {
      return {
        success: true,
        output: `未找到与 '${query}' 匹配的 MCP 工具。当前已连接工具总数: ${this.discovery.getTotalToolCount()}。请尝试其他关键词或通过 /mcp 检查服务连接状态。`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 触发动态激活钩子
    if (this.handler?.onToolsFound) {
      await this.handler.onToolsFound(matches.map((m) => m.toolName));
    }

    const formattedLines = matches.map((m, idx) => {
      return `${idx + 1}. **${m.toolName}** (from \`${m.serverName}\`)\n   - 描述: ${m.description}\n   - 参数: ${m.parametersSummary}`;
    });

    return {
      success: true,
      output: `找到 ${matches.length} 个相关 MCP 工具，并已在当前上下文中激活：\n\n${formattedLines.join("\n\n")}\n\n你可以在接下来的步骤中直接调用上述工具。`,
      executionTimeMs: Date.now() - startTime,
    };
  }
}
