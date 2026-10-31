/**
 * Coordinator Decision Controller
 * 负责在复杂语义场景下安全调用 Nash 原生 runAgentLoop 进行多工具深层分析
 * 严格限制推理轮数、工具调用总数与 Wall-Clock 超时预算
 */

import { runAgentLoop } from "../../runtime/agent-loop.js";
import { ToolRegistry, ToolExecutor } from "../../tools/index.js";
import { createClusterAgentTools } from "../tools/cluster-tools.js";
import type { ClusterSearchService } from "../coordinator/catalog/cluster-search-service.js";
import type { CoordinatorCatalogService } from "../coordinator/catalog/coordinator-catalog-service.js";
import type { IClusterStore } from "../storage/cluster-store.js";
import type { NodeRegistry } from "../coordinator/node-registry.js";
import type { TaskIntent, RoutingCandidate } from "./types.js";

export interface CoordinatorDecisionControllerOptions {
  store: IClusterStore;
  registry: NodeRegistry;
  searchService: ClusterSearchService;
  catalogService?: CoordinatorCatalogService;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

export class CoordinatorDecisionController {
  private readonly maxSteps: number;
  private readonly maxToolCalls: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: CoordinatorDecisionControllerOptions) {
    this.maxSteps = options.maxSteps ?? 25;
    this.maxToolCalls = options.maxToolCalls ?? 30;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  /**
   * 调用 Coordinator AgentLoop 针对歧义或复杂意图进行深层语义裁决
   */
  async consultCoordinatorAgentLoop(
    intent: TaskIntent,
    candidates: RoutingCandidate[]
  ): Promise<{ recommendedNodeId?: string; recommendedProjectId?: string; analysisReason: string }> {
    // 1. 装配 Cluster Tools 到独立 Registry
    const tools = createClusterAgentTools({
      searchService: this.options.searchService,
      catalogService: this.options.catalogService,
      store: this.options.store,
      registry: this.options.registry,
    });

    const registry = new ToolRegistry();
    for (const tool of tools) {
      registry.register(tool);
    }
    const executor = new ToolExecutor(registry);

    // 2. 构造紧凑规范的 Prompt，禁止模型注入指令
    const candidatesSummary = candidates
      .slice(0, 5)
      .map(
        (c, i) =>
          `${i + 1}. Node: ${c.nodeId}, Project: ${c.projectId} (${c.projectName}), Score: ${c.score}, Summary: ${c.projectSummary}`
      )
      .join("\n");

    const prompt = `你现在是 Nash Cluster Coordinator 的任务路由决策器。
用户原始任务: "${intent.originalRequest}"
目标意图: "${intent.goal}"
操作类型: "${intent.operation}"
当前候选列表:
${candidatesSummary}

请使用集群搜索工具核查相关项目的长期记忆与能力状态，输出最合适的 (nodeId, projectId) 以及判断依据。
请简明回答并以 JSON 块结尾:
\`\`\`json
{
  "nodeId": "选定Node ID",
  "projectId": "选定Project ID",
  "reason": "推荐理由"
}
\`\`\``;

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const response = await runAgentLoop(prompt, {
        registry,
        executor,
        maxSteps: this.maxSteps,
        maxToolCalls: this.maxToolCalls,
        maxRunMs: this.timeoutMs,
        agentName: "CoordinatorRouter",
        agentType: "router",
        abortSignal: abortController.signal,
      });

      // 提取 JSON
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          recommendedNodeId: parsed.nodeId,
          recommendedProjectId: parsed.projectId,
          analysisReason: parsed.reason ?? response.slice(0, 300),
        };
      }

      return {
        analysisReason: response.slice(0, 300),
      };
    } catch (err) {
      return {
        analysisReason: `Coordinator AgentLoop consultation skipped or timed out: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
