import type { MCPManager } from "../../../mcp/mcp-manager.js";
import type {
  MCPCapabilityCatalogItem,
  MCPToolCatalogItem,
  MCPCapabilityStatus,
} from "../../protocol/types.js";

export class MCPManagerAdapter {
  constructor(
    private readonly mcpManager: MCPManager,
    private readonly nodeId: string
  ) {}

  /**
   * 导出当前节点的 MCP Capability Catalog
   * 严格过滤并脱敏所有敏感 Token、Header、Env 与 Cookie
   */
  exportCatalogItems(revision = 1): MCPCapabilityCatalogItem[] {
    const configuredServers = this.mcpManager.configManager.loadAllServers();
    const liveStatuses = this.mcpManager.listStatuses();
    const statusMap = new Map(liveStatuses.map((s) => [s.name, s]));
    const items: MCPCapabilityCatalogItem[] = [];

    // 合并配置与活跃运行状态
    const allNames = Array.from(new Set([...Object.keys(configuredServers), ...liveStatuses.map((s) => s.name)]));

    for (const name of allNames) {
      const cfg = configuredServers[name];
      const s = statusMap.get(name);

      let capStatus: MCPCapabilityStatus = "unknown";
      if (cfg?.enabled === false || s?.enabled === false) {
        capStatus = "disabled";
      } else if (s) {
        if (s.status === "connected") {
          capStatus = "available";
        } else if (s.status === "connecting") {
          capStatus = "configured";
        } else if (s.status === "failed") {
          if (s.lastError && (s.lastError.includes("环境变量") || s.lastError.includes("401") || s.lastError.includes("未定义"))) {
            capStatus = "needs_auth";
          } else {
            capStatus = "failed";
          }
        } else if (s.status === "disconnected") {
          capStatus = "configured";
        }
      } else {
        // 尚未连通，检查是否需要凭证
        if (cfg?.headers && Object.values(cfg.headers).some((h) => typeof h === "string" && h.includes("${"))) {
          capStatus = "needs_auth";
        } else {
          capStatus = "configured";
        }
      }

      // 获取当前服务挂载的工具列表
      const serverTools = this.mcpManager.toolDiscovery.getToolsForServer(name);
      let tools: MCPToolCatalogItem[] = serverTools.map((t) => {
        let risk: "read-only" | "idempotent-write" | "destructive" | "unknown" = "unknown";
        const lowerName = t.name.toLowerCase();
        if (lowerName.includes("read") || lowerName.includes("get") || lowerName.includes("list") || lowerName.includes("search") || lowerName.includes("extract")) {
          risk = "read-only";
        } else if (lowerName.includes("write") || lowerName.includes("edit") || lowerName.includes("set") || lowerName.includes("update")) {
          risk = "idempotent-write";
        } else if (lowerName.includes("delete") || lowerName.includes("remove") || lowerName.includes("drop")) {
          risk = "destructive";
        }

        const paramNames: string[] = [];
        if (t.inputSchema && typeof t.inputSchema === "object" && (t.inputSchema as any).properties) {
          paramNames.push(...Object.keys((t.inputSchema as any).properties));
        }

        return {
          toolName: t.name,
          description: t.description ?? "",
          parameterNames: paramNames,
          riskClassification: risk,
          available: capStatus === "available",
        };
      });

      // 如果尚未动态发现工具，提取常见已知服务的静态声明工具以供索引发现
      if (tools.length === 0 && name.includes("bilibili")) {
        tools = [
          {
            toolName: "extract_bilibili_subtitles",
            description: "提取 Bilibili 视频字幕文档 (支持 BV号、分P与纯文本/SRT格式)",
            parameterNames: ["url", "format", "page"],
            riskClassification: "read-only",
            available: capStatus === "available",
          },
          {
            toolName: "list_bilibili_subtitles",
            description: "查询 Bilibili 视频的分 P 列表与字幕语言清单",
            parameterNames: ["url"],
            riskClassification: "read-only",
            available: capStatus === "available",
          },
        ];
      }

      const transport = (s?.transport || cfg?.transport || "stdio") as any;
      const capabilitySummary = `${name} (${transport}): ${tools.length} tools (${tools.map((t) => t.toolName).join(", ") || "none"})`;

      items.push({
        serverId: name,
        nodeId: this.nodeId,
        displayName: name,
        transportType: transport,
        status: capStatus,
        capabilitySummary,
        tools,
        resourceCount: s?.resourceCount ?? 0,
        promptCount: s?.promptCount ?? 0,
        lastVerifiedAt: s?.lastConnectedAt ?? Date.now(),
        revision,
      });
    }

    return items;
  }
}
