import type { MCPToolDefinition, MCPServerConfig } from "./types.js";
import { buildMCPToolName } from "./mcp-tool-adapter.js";

export interface ToolSearchResult {
  toolName: string;
  rawToolName: string;
  serverName: string;
  description: string;
  parametersSummary: string;
  score: number;
}

export const MCP_DYNAMIC_DISCOVERY_THRESHOLD = 20;

/**
 * 常见中英文意图与同义词映射表（轻量语义增强，无需笨重向量库）
 */
const INTENT_SYNONYMS: Record<string, string[]> = {
  b站: ["bilibili", "subtitle", "video", "b站", "哔哩哔哩"],
  哔哩哔哩: ["bilibili", "subtitle", "video", "b站"],
  字幕: ["subtitle", "transcript", "caption", "srt", "vtt", "subtitles"],
  提取: ["extract", "fetch", "get", "download", "pull"],
  列表: ["list", "catalog", "index", "all"],
  视频: ["video", "bilibili", "media"],
  搜索: ["search", "find", "query", "lookup"],
  文件: ["file", "fs", "read", "write"],
  代码: ["code", "ast", "symbol", "git"],
  数据库: ["database", "sql", "query", "db", "table"],
  浏览器: ["browser", "web", "fetch", "crawl", "page"],
};

/**
 * 估算单个工具 Schema 的 Token 开销
 */
export function estimateToolSchemaTokens(tool: MCPToolDefinition): number {
  const schemaStr = JSON.stringify(tool.inputSchema || {});
  const descStr = tool.description || "";
  // 按照平均 3.5 字符 ≈ 1 token 估算
  return Math.ceil((tool.name.length + descStr.length + schemaStr.length) / 3.5);
}

/**
 * 渐进式 MCP 工具发现与元数据检索中心 (Context Budget 调度)
 */
export class MCPToolDiscovery {
  private readonly toolIndex = new Map<string, MCPToolDefinition>();
  private readonly serverConfigs = new Map<string, MCPServerConfig>();

  /**
   * 注册/更新服务配置
   */
  setServerConfigs(configs: Record<string, MCPServerConfig>): void {
    this.serverConfigs.clear();
    for (const [k, v] of Object.entries(configs)) {
      this.serverConfigs.set(k, v);
    }
  }

  /**
   * 刷新全量工具索引
   */
  updateIndex(tools: MCPToolDefinition[]): void {
    this.toolIndex.clear();
    for (const tool of tools) {
      const uniqueName = buildMCPToolName(tool.serverName, tool.name);
      this.toolIndex.set(uniqueName, tool);
    }
  }

  /**
   * 获取当前索引的工具总量
   */
  getTotalToolCount(): number {
    return this.toolIndex.size;
  }

  /**
   * 获取所有配置了 alwaysLoad: true 的工具名称集合
   */
  getAlwaysLoadToolNames(): Set<string> {
    const alwaysLoadTools = new Set<string>();
    for (const [uniqueName, def] of this.toolIndex.entries()) {
      const cfg = this.serverConfigs.get(def.serverName);
      if (cfg?.alwaysLoad === true) {
        alwaysLoadTools.add(uniqueName);
      }
    }
    return alwaysLoadTools;
  }

  /**
   * 基于 Context Budget 智能判定是否需要启用三层渐进式发现
   *
   * 考量维度：
   * 1. 显式 alwaysLoad 的 Server 不计入阻断；
   * 2. 非 alwaysLoad 工具总 Token 开销占上下文窗口比例；
   * 3. 工具总数超过阈值。
   */
  shouldUseProgressiveDiscovery(options?: {
    contextWindow?: number;
    budgetTokens?: number;
  }): boolean {
    const contextWindow = options?.contextWindow ?? 64_000;
    const maxAllowedTokens = options?.budgetTokens ?? Math.min(contextWindow * 0.12, 10_000);

    let nonAlwaysLoadCount = 0;
    let totalSchemaTokens = 0;

    for (const [_, def] of this.toolIndex.entries()) {
      const cfg = this.serverConfigs.get(def.serverName);
      if (cfg?.alwaysLoad === true) {
        continue;
      }
      nonAlwaysLoadCount++;
      totalSchemaTokens += estimateToolSchemaTokens(def);
    }

    // 若非 alwaysLoad 工具数量超过阈值，或 Schema 总消耗超过预算，激活渐进式收敛
    return (
      nonAlwaysLoadCount > MCP_DYNAMIC_DISCOVERY_THRESHOLD ||
      totalSchemaTokens > maxAllowedTokens
    );
  }

  /**
   * 检索相关工具（多语言支持、关键词语义召回与智能排序）
   */
  search(query: string, serverFilter?: string, limit = 8): ToolSearchResult[] {
    const qLower = query.toLowerCase().trim();
    const rawTokens = qLower.split(/[\s,，、._\-/]+/).filter(Boolean);

    // 展开同义词词根
    const expandedTokens = new Set<string>(rawTokens);
    for (const t of rawTokens) {
      if (INTENT_SYNONYMS[t]) {
        for (const syn of INTENT_SYNONYMS[t]!) {
          expandedTokens.add(syn);
        }
      }
      // 反向查找
      for (const [k, v] of Object.entries(INTENT_SYNONYMS)) {
        if (v.includes(t)) {
          expandedTokens.add(k);
          v.forEach((item) => expandedTokens.add(item));
        }
      }
    }

    const tokens = Array.from(expandedTokens);
    const results: ToolSearchResult[] = [];

    for (const [uniqueName, def] of this.toolIndex.entries()) {
      if (serverFilter && def.serverName !== serverFilter) {
        continue;
      }

      const nameLower = def.name.toLowerCase();
      const uniqueNameLower = uniqueName.toLowerCase();
      const descLower = (def.description || "").toLowerCase();
      const serverLower = def.serverName.toLowerCase();

      let score = 0;

      // 1. 完全精确匹配
      if (uniqueNameLower === qLower || nameLower === qLower) {
        score += 150;
      } else if (uniqueNameLower.includes(qLower) || nameLower.includes(qLower)) {
        score += 60;
      } else if (serverLower.includes(qLower)) {
        score += 50;
      } else if (descLower.includes(qLower)) {
        score += 35;
      }

      // 2. 词素命中与别名打分
      for (const token of tokens) {
        if (nameLower.includes(token)) score += 25;
        if (serverLower.includes(token)) score += 20;
        if (descLower.includes(token)) score += 12;
      }

      // 3. 用户显式提及 Server Name 时大幅提权
      if (qLower.includes(serverLower)) {
        score += 40;
      }

      if (score > 0 || tokens.length === 0) {
        const props = (def.inputSchema?.properties as Record<string, unknown>) || {};
        const reqs = (def.inputSchema?.required as string[]) || [];
        const paramKeys = Object.keys(props);
        const paramsSummary =
          paramKeys.length > 0
            ? paramKeys.map((p) => `${p}${reqs.includes(p) ? "*" : ""}`).join(", ")
            : "none";

        results.push({
          toolName: uniqueName,
          rawToolName: def.name,
          serverName: def.serverName,
          description: def.description || "(无描述)",
          parametersSummary: `params: [${paramsSummary}]`,
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * 生成 Tier 1 Catalog 概览文本
   */
  generateCatalogSummary(): string {
    const serversMap = new Map<string, string[]>();
    for (const [_, def] of this.toolIndex.entries()) {
      const list = serversMap.get(def.serverName) ?? [];
      list.push(def.name);
      serversMap.set(def.serverName, list);
    }

    const lines: string[] = ["# MCP Servers & Tools Catalog"];
    for (const [server, tools] of serversMap.entries()) {
      const cfg = this.serverConfigs.get(server);
      const alwaysTag = cfg?.alwaysLoad ? " [always-loaded]" : "";
      lines.push(
        `- **${server}**${alwaysTag} (${tools.length} tools): ${tools.slice(0, 5).join(", ")}${
          tools.length > 5 ? ` ...+${tools.length - 5} more` : ""
        }`
      );
    }
    return lines.join("\n");
  }

  /**
   * 获取指定服务的所有工具定义
   */
  getToolsForServer(serverName: string): MCPToolDefinition[] {
    const list: MCPToolDefinition[] = [];
    for (const def of this.toolIndex.values()) {
      if (def.serverName === serverName) {
        list.push(def);
      }
    }
    return list;
  }
}
