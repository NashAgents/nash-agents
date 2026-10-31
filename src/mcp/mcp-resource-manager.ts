import type { Tool } from "../tools/tool.js";
import type { ToolResult } from "../tools/executor.js";
import type { MCPConnectionManager } from "./mcp-connection-manager.js";
import type { SpillStore } from "../context/spill/spill-store.js";
import { MCPResultAdapter } from "./mcp-result-adapter.js";

/**
 * list_mcp_resources 工具
 */
export class ListMCPResourcesTool implements Tool {
  public readonly name = "list_mcp_resources";
  public readonly description =
    "List all available resources from connected MCP servers (documents, database schemas, logs, templates, etc.).";

  public readonly parameters = {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "Optional server name to filter resources by",
      },
    },
  };

  constructor(private readonly connectionManager: MCPConnectionManager) {}

  async execute(args: { server?: string }): Promise<ToolResult> {
    const startTime = Date.now();
    const all = this.connectionManager.getAllResources();
    const filtered = args.server ? all.filter((r) => r.serverName === args.server) : all;

    if (filtered.length === 0) {
      return {
        success: true,
        output: "当前已连接的 MCP 服务未提供任何 Resources 资源。",
        executionTimeMs: Date.now() - startTime,
      };
    }

    const lines = filtered.map(
      (r, idx) =>
        `${idx + 1}. \`${r.uri}\` (${r.serverName})\n   - 名称: ${r.name}\n   - 类型: ${r.mimeType || "unspecified"}\n   - 描述: ${r.description || "(无)"}`
    );

    return {
      success: true,
      output: `找到 ${filtered.length} 个 MCP 资源：\n\n${lines.join("\n\n")}\n\n可使用 read_mcp_resource 工具通过 URI 读取具体资源内容。`,
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * read_mcp_resource 工具
 */
export class ReadMCPResourceTool implements Tool {
  public readonly name = "read_mcp_resource";
  public readonly description =
    "Read the content of a specific resource from an MCP server using its resource URI.";

  public readonly parameters = {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "The name of the MCP server hosting the resource",
      },
      uri: {
        type: "string",
        description: "The URI of the resource to read (e.g. 'postgres://schema/public', 'file:///...')",
      },
    },
    required: ["server", "uri"],
  };

  private readonly resultAdapter: MCPResultAdapter;

  constructor(
    private readonly connectionManager: MCPConnectionManager,
    spillStore?: SpillStore
  ) {
    this.resultAdapter = new MCPResultAdapter({ spillStore });
  }

  async execute(args: { server: string; uri: string }): Promise<ToolResult> {
    const startTime = Date.now();
    if (!args.server || !args.uri) {
      return {
        success: false,
        output: "Error: 参数 'server' 和 'uri' 均为必填项。",
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      const rawRes = await this.connectionManager.readResource(args.server, args.uri);
      return await this.resultAdapter.formatResult(
        rawRes,
        `read_mcp_resource:${args.server}`,
        undefined,
        Date.now() - startTime
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Error: 读取资源 '${args.uri}' 失败: ${errMsg}`,
        error: errMsg,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}
