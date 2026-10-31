import type { AgentRecord } from "../agent/types.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { TaskManager } from "../task/task-manager.js";
import type { ApprovalService } from "../approval/approval-service.js";

export interface AgentActivityInfo {
  kind: "tool" | "model" | "waiting" | "completed" | "failed" | "idle";
  summary?: string;
  startedAt: number;
}

/**
 * 实时维护各 Agent 的当前动态并渲染 Agent Tree 与 Navigation 选区
 *
 * 命名与层级规则：
 * 1. agent.type === "main" -> 始终显示为 "Main"；
 * 2. agent.type === "team-lead" -> 显示为 "Lead"；
 * 3. agent.type === "subagent" / "team-member" -> 使用 agent.name (无 name 时回退 agentId)；
 * 4. Current Activity 作为子节点单行挂在 Agent 下方；
 * 5. 导航选择支持 ↑/↓ 高亮光标 (>) 与当前焦点视图指示 ([viewing])。
 */
export class AgentTreeProjection {
  private readonly activities = new Map<string, AgentActivityInfo>();

  setActivity(agentId: string, activity: AgentActivityInfo): void {
    this.activities.set(agentId, activity);
  }

  getActivity(agentId: string): AgentActivityInfo | undefined {
    return this.activities.get(agentId);
  }

  clearActivity(agentId: string): void {
    this.activities.delete(agentId);
  }

  /**
   * 格式化 Agent 显示名称
   */
  static getDisplayName(agent: AgentRecord): string {
    if (agent.type === "main") {
      return "Main";
    }
    if (agent.type === "team-lead") {
      return "Lead";
    }
    return agent.name ?? agent.agentId;
  }

  /**
   * 按深度优先次序获取所有可供键盘导航选择的 Agent 列表
   */
  getNavigableAgents(agentRegistry: AgentRegistry): AgentRecord[] {
    const allAgents = agentRegistry.getAllAgents();
    if (allAgents.length === 0) return [];

    const rootAgents = allAgents
      .filter((a) => !a.parentAgentId || a.depth === 0 || !allAgents.some((other) => other.agentId === a.parentAgentId))
      .sort((a, b) => {
        if (a.type === "main" || a.agentId === "main") return -1;
        if (b.type === "main" || b.agentId === "main") return 1;
        return 0;
      });
    const result: AgentRecord[] = [];
    const visited = new Set<string>();

    const traverse = (agent: AgentRecord) => {
      if (visited.has(agent.agentId)) return;
      visited.add(agent.agentId);
      result.push(agent);
      const children = agentRegistry.getChildren(agent.agentId);
      for (const child of children) {
        traverse(child);
      }
    };

    for (const root of rootAgents) {
      traverse(root);
    }
    for (const agent of allAgents) traverse(agent);

    return result;
  }

  /**
   * 渲染带导航光标 (>) 和状态的多层 Agent Tree 视图
   */
  renderNavigableTree(
    agentRegistry: AgentRegistry,
    selectedIndex: number,
    activeViewAgentId = "main",
    approvalService?: ApprovalService,
    options?: { showActivity?: boolean }
  ): string {
    const navigableAgents = this.getNavigableAgents(agentRegistry);
    if (navigableAgents.length === 0) {
      return "  (暂无活跃 Agent)";
    }

    const agents = this.getNavigableAgents(agentRegistry);
    const rootAgents = agents.filter((a) => !a.parentAgentId || a.depth === 0 || !agents.some((other) => other.agentId === a.parentAgentId));
    const lines: string[] = [];
    const visited = new Set<string>();
    const showActivity = options?.showActivity ?? true;

    // 获取当前处于 pending 审批的 agentId 集合
    const pendingApprovalAgentIds = new Set<string>();
    if (approvalService) {
      const activeAppr = approvalService.getActiveApproval();
      if (activeAppr) {
        pendingApprovalAgentIds.add(activeAppr.agentId);
      }
      for (const p of approvalService.getPendingApprovals()) {
        pendingApprovalAgentIds.add(p.agentId);
      }
    }

    let currentIndex = 0;

    const renderNode = (
      agent: AgentRecord,
      prefix: string,
      isLast: boolean
    ) => {
      if (visited.has(agent.agentId)) return;
      visited.add(agent.agentId);
      const nodeIndex = currentIndex++;
      const isSelected = nodeIndex === selectedIndex;
      const isViewing =
        agent.agentId === activeViewAgentId ||
        (activeViewAgentId === "main" && agent.type === "main");

      const displayName = AgentTreeProjection.getDisplayName(agent);
      let statusDisplay: string = agent.status;

      if (pendingApprovalAgentIds.has(agent.agentId)) {
        statusDisplay = "\x1b[33m\x1b[1mapproval ⚠\x1b[0m";
      } else if (agent.status === "running") {
        statusDisplay = "\x1b[36mworking\x1b[0m";
      } else if (agent.status === "completed") {
        statusDisplay = "\x1b[32mdone ✓\x1b[0m";
      } else if (agent.status === "failed") {
        statusDisplay = "\x1b[31mfailed ✗\x1b[0m";
      } else if (agent.status === "interrupted") {
        statusDisplay = "\x1b[33minterrupted ⊘\x1b[0m";
      } else if (agent.status === "waiting") {
        statusDisplay = "\x1b[90mwaiting\x1b[0m";
      }

      const act = this.activities.get(agent.agentId);

      // 特殊状态微调：若处于 waiting 且有等待说明
      if (agent.status === "waiting" && act?.summary && !pendingApprovalAgentIds.has(agent.agentId)) {
        statusDisplay = `\x1b[90m${act.summary}\x1b[0m`;
      }

      const cursorSymbol = isSelected ? "\x1b[36m>\x1b[0m" : " ";
      const viewBadge = isViewing ? " \x1b[36m[view]\x1b[0m" : "";
      const nodePrefix = prefix === "" ? "" : isLast ? "└ " : "├ ";
      const padName = (displayName + viewBadge).padEnd(20);

      lines.push(`${cursorSymbol} ${prefix}${nodePrefix}${padName} ${statusDisplay}`);

      const nextPrefix = prefix + (isLast ? "    " : "│   ");

      // 渲染当前 Activity (仅在 running 状态且有具体 activity 时单行挂在下方)
      if (showActivity && agent.status === "running" && !pendingApprovalAgentIds.has(agent.agentId)) {
        if (act && act.summary && act.kind !== "waiting") {
          lines.push(`    ${nextPrefix}└ \x1b[33m${act.summary}\x1b[0m`);
        }
      }

      const children = agentRegistry.getChildren(agent.agentId);
      for (let i = 0; i < children.length; i++) {
        renderNode(children[i], nextPrefix, i === children.length - 1);
      }
    };

    for (let i = 0; i < rootAgents.length; i++) {
      renderNode(rootAgents[i], "", i === rootAgents.length - 1);
    }
    for (const agent of agents) {
      if (!visited.has(agent.agentId)) renderNode(agent, "", true);
    }

    return lines.join("\n");
  }

  /**
   * 渲染多层 Agent Tree 文本视图（兼容原有接口）
   */
  renderTree(
    agentRegistry: AgentRegistry,
    taskManager?: TaskManager,
    options?: { showActivity?: boolean }
  ): string {
    return this.renderNavigableTree(agentRegistry, -1, "main", undefined, options);
  }
}
