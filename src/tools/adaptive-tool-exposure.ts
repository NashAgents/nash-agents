import type { ChatCompletionTool } from "../model/chat-completions-client.js";
import { type Tool, toChatCompletionTool } from "./tool.js";
import type { ToolRegistry } from "./registry.js";
import { ConservativeTokenEstimator } from "../context/token-meter.js";

export type AgentRoleType = "coordinator" | "worker" | "scout" | "subagent" | "general" | string;

export interface AdaptiveToolExposureOptions {
  role?: AgentRoleType;
  initialActiveTools?: string[];
  autoActivateKeywords?: boolean;
}

export interface ToolCatalogSummary {
  name: string;
  category: string;
  description: string;
  executionKind?: "process" | "read" | "write";
}

/**
 * 角色默认核心暴露工具集（极简主义，降低 40-60% Schema Token 消耗）
 */
const LEAD_TOOLS = ["read_file", "write_file", "edit_file", "list_files", "grep_search", "bash", "create_task", "update_task", "complete_task", "block_task", "list_tasks", "spawn_agent", "wait_agent", "list_agents", "spawn_teammate", "assign_task", "supersede_task", "interrupt_agent", "list_team", "send_message", "wait_for_change", "enter_plan_mode", "propose_plan", "read_tool_result", "job_list", "job_output", "job_kill", "remember", "search_memory", "search_mcp_tools", "discover_tools", "activate_tools"];
const ROLE_CORE_TOOL_MAP: Record<string, string[]> = {
  main: LEAD_TOOLS,
  lead: LEAD_TOOLS,
  subagent: ["wait_agent", "read_tool_result","read_file", "write_file", "edit_file", "list_files", "grep_search", "bash", "complete_task", "list_tasks", "spawn_agent", "list_agents", "discover_tools", "activate_tools"],
  "team-member": ["read_file", "write_file", "edit_file", "bash", "claim_task", "complete_task", "block_task", "send_message", "wait_for_change", "list_tasks", "discover_tools", "activate_tools"],
  coordinator: [
    "run_distributed_task_graph",
    "replan_distributed_task_graph",
    "get_cluster_task_status",
    "read_graph_artifact",
    "search_cluster_projects",
    "remember",
    "search_memory",
    "discover_tools",
    "activate_tools",
  ],
  worker: [
    "read_file",
    "write_file",
    "edit_file",
    "bash",
    "publish_artifact",
    "read_graph_artifact",
    "discover_tools",
    "activate_tools",
  ],
  scout: [
    "read_file",
    "list_files",
    "grep_search",
    "read_project_meta",
    "submit_discovery_report",
    "discover_tools",
    "activate_tools",
  ],
  general: [
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "grep_search",
    "bash",
    "discover_tools",
    "activate_tools",
  ],
};

/**
 * 关键词与动态工具激活映射
 */
const KEYWORD_AUTO_ACTIVATE_MAP: Record<string, string[]> = {
  memory: ["remember", "search_memory"],
  skill: ["run_skill", "list_skills"],
  mcp: ["search_mcp_tools", "execute_mcp_tool"],
  artifact: ["publish_artifact", "read_graph_artifact"],
  graph: ["run_distributed_task_graph", "replan_distributed_task_graph"],
  job: ["job_list", "job_output", "job_kill"],
};

export class AdaptiveToolExposure {
  private readonly role: string;
  private readonly activeToolNames: Set<string>;
  private readonly autoActivateKeywords: boolean;
  private readonly estimator = new ConservativeTokenEstimator();

  constructor(
    private readonly registry: ToolRegistry,
    options?: AdaptiveToolExposureOptions
  ) {
    this.role = options?.role ?? "general";
    this.autoActivateKeywords = options?.autoActivateKeywords ?? true;
    this.activeToolNames = new Set<string>();

    // 1. 装载角色核心工具
    const coreTools = ROLE_CORE_TOOL_MAP[this.role === "member" ? "team-member" : this.role] ?? ROLE_CORE_TOOL_MAP.general;
    for (const name of coreTools) {
      if (this.registry.has(name)) {
        this.activeToolNames.add(name);
      }
    }

    // 2. 装载显式初始指定的工具
    if (options?.initialActiveTools) {
      for (const name of options.initialActiveTools) {
        if (this.registry.has(name)) {
          this.activeToolNames.add(name);
        }
      }
    }
  }

  /**
   * 自动探测用户输入/上下文中的关键词，按需预激活对应工具
   */
  public autoActivateForContext(text: string): string[] {
    if (!this.autoActivateKeywords || !text) return [];
    const lower = text.toLowerCase();
    const activated: string[] = [];

    for (const [keyword, tools] of Object.entries(KEYWORD_AUTO_ACTIVATE_MAP)) {
      if (lower.includes(keyword)) {
        for (const tool of tools) {
          if (this.registry.has(tool) && !this.activeToolNames.has(tool)) {
            this.activeToolNames.add(tool);
            activated.push(tool);
          }
        }
      }
    }
    return activated;
  }

  /**
   * 动态激活一个或多个工具
   */
  public activate(toolNames: string[]): { activated: string[]; notFound: string[] } {
    const activated: string[] = [];
    const notFound: string[] = [];

    for (const name of toolNames) {
      if (this.registry.has(name)) {
        this.activeToolNames.add(name);
        activated.push(name);
      } else {
        notFound.push(name);
      }
    }

    return { activated, notFound };
  }

  /**
   * 撤销暴露指定工具（不影响底层执行权限）
   */
  public deactivate(toolName: string): boolean {
    return this.activeToolNames.delete(toolName);
  }

  /**
   * 检查指定工具当前是否处于暴露状态
   */
  public isExposed(toolName: string): boolean {
    if (toolName === "discover_tools" || toolName === "activate_tools") {
      return this.registry.has(toolName);
    }
    return this.activeToolNames.has(toolName);
  }

  /**
   * 获取当前应暴露给 LLM 的完整 Tool Definitions
   */
  public getExposedDefinitions(): ChatCompletionTool[] {
    // 保证元发现工具常驻暴露
    if (this.registry.has("discover_tools")) this.activeToolNames.add("discover_tools");
    if (this.registry.has("activate_tools")) this.activeToolNames.add("activate_tools");

    const tools: ChatCompletionTool[] = [];
    for (const name of this.activeToolNames) {
      const tool = this.registry.get(name);
      if (tool) {
        tools.push(toChatCompletionTool(tool));
      }
    }
    return tools;
  }

  /**
   * 获取当前所有可用工具（包括未激活工具）的精简元数据摘要目录
   */
  public getCatalogSummary(query?: string, category?: string): ToolCatalogSummary[] {
    const allTools = this.registry.getAll();
    const qLower = (query ?? "").toLowerCase().trim();
    const summaries: ToolCatalogSummary[] = [];

    for (const tool of allTools) {
      // 分类启发式提取
      let cat = "utility";
      if (/^(read_file|write_file|edit_file|list_files|grep_search)$/.test(tool.name)) cat = "filesystem";
      else if (/^(bash|execute_command)$/.test(tool.name)) cat = "execution";
      else if (/^(publish_artifact|read_graph_artifact)$/.test(tool.name)) cat = "artifact";
      else if (/^(remember|search_memory)$/.test(tool.name)) cat = "memory";
      else if (/^(run_distributed_task_graph|replan_distributed_task_graph|get_cluster_task_status)$/.test(tool.name)) cat = "orchestration";
      else if (tool.name.startsWith("mcp__") || tool.name.includes("mcp")) cat = "mcp";
      else if (tool.name.includes("skill")) cat = "skill";

      if (category && cat !== category) continue;

      const desc = tool.description ? tool.description.split("\n")[0].slice(0, 120) : "No description provided.";
      if (qLower) {
        const match = tool.name.toLowerCase().includes(qLower) || desc.toLowerCase().includes(qLower) || cat.includes(qLower);
        if (!match) continue;
      }

      summaries.push({
        name: tool.name,
        category: cat,
        description: desc,
        executionKind: tool.executionKind,
      });
    }

    return summaries;
  }

  /**
   * 测量当前工具暴露相较于全量暴露节省的 Token 数
   */
  public measureTokenSavings(): {
    totalTools: number;
    exposedTools: number;
    fullSchemaTokens: number;
    exposedSchemaTokens: number;
    savedTokens: number;
    savingPercentage: number;
  } {
    const allDefs = this.registry.getDefinitions();
    const exposedDefs = this.getExposedDefinitions();

    const fullSchemaTokens = allDefs.length ? this.estimator.estimateText(JSON.stringify(allDefs)) : 0;
    const exposedSchemaTokens = exposedDefs.length ? this.estimator.estimateText(JSON.stringify(exposedDefs)) : 0;
    const savedTokens = Math.max(0, fullSchemaTokens - exposedSchemaTokens);
    const savingPercentage = fullSchemaTokens > 0 ? (savedTokens / fullSchemaTokens) * 100 : 0;

    return {
      totalTools: allDefs.length,
      exposedTools: exposedDefs.length,
      fullSchemaTokens,
      exposedSchemaTokens,
      savedTokens,
      savingPercentage: Number(savingPercentage.toFixed(1)),
    };
  }
}

/**
 * 创建内置轻量级工具发现工具：discover_tools
 */
export function createDiscoverToolsTool(exposure: AdaptiveToolExposure): Tool {
  return {
    name: "discover_tools",
    executionKind: "read",
    description: "Search and inspect available cluster, filesystem, memory, orchestration, or MCP tools that are not yet active in your current context. Use activate_tools to activate them for use.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional keyword to search tool names, categories, or descriptions (e.g. 'mcp', 'artifact', 'git', 'memory').",
        },
        category: {
          type: "string",
          description: "Optional category filter: 'filesystem', 'execution', 'artifact', 'memory', 'orchestration', 'mcp', 'skill', 'utility'.",
        },
      },
    },
    execute(args: { query?: string; category?: string }) {
      const catalog = exposure.getCatalogSummary(args.query, args.category);
      const metrics = exposure.measureTokenSavings();
      return {
        count: catalog.length,
        tools: catalog.map(t => ({
          name: t.name,
          category: t.category,
          description: t.description,
          isActive: exposure.isExposed(t.name),
        })),
        hint: "Call activate_tools with tool names to bring full schemas into your prompt.",
        stats: {
          activeCount: metrics.exposedTools,
          totalAvailableCount: metrics.totalTools,
        },
      };
    },
  };
}

/**
 * 创建内置工具激活工具：activate_tools
 */
export function createActivateToolsTool(exposure: AdaptiveToolExposure): Tool {
  return {
    name: "activate_tools",
    executionKind: "read",
    description: "Activate specific tools by name so their detailed parameters and schemas become available to you in the next step.",
    parameters: {
      type: "object",
      properties: {
        toolNames: {
          type: "array",
          items: { type: "string" },
          description: "List of exact tool names to activate into your prompt context.",
        },
      },
      required: ["toolNames"],
    },
    execute(args: { toolNames: string[] }) {
      const result = exposure.activate(args.toolNames || []);
      const metrics = exposure.measureTokenSavings();
      return {
        success: true,
        activated: result.activated,
        notFound: result.notFound.length > 0 ? result.notFound : undefined,
        currentActiveToolsCount: metrics.exposedTools,
        message: `Successfully activated ${result.activated.length} tools. Their full schemas will be available in subsequent model steps.`,
      };
    },
  };
}
