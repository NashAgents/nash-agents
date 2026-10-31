import type { Task, TaskStatus } from "../task/types.js";
import type { TaskManager } from "../task/task-manager.js";
import type { AgentRecord } from "../agent/types.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { TeamRuntime } from "../team/team-runtime.js";

/**
 * 状态符号与颜色修饰（兼容 ANSI 与纯文本）
 */
function getTaskStatusSymbol(status: TaskStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "→";
    case "ready":
      return "○";
    case "pending":
      return "·";
    case "blocked":
      return "⛔";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
  }
}

/**
 * 生成 Task-Centric 任务中心视图
 *
 * 示例：
 * Goal: Refactor Auth
 * ✓ [task-1] Read auth.ts             (backend-agent)
 * → [task-2] Implement JWT validation (backend-agent)
 * ○ [task-3] Update frontend state    (unassigned)
 * ⛔ [task-4] Integration test        (blocked by: task-2)
 */
export function formatTaskCentricView(
  taskManager: TaskManager,
  options?: { goal?: string }
): string {
  const tasks = taskManager.getTasks();
  if (tasks.length === 0) {
    return "(暂无已创建的任务)";
  }

  const lines: string[] = [];
  if (options?.goal) {
    lines.push(`Goal: ${options.goal}`);
  }

  for (const task of tasks) {
    const symbol = getTaskStatusSymbol(task.status);
    let ownerDisplay = "";

    if (task.status === "completed") {
      const agent = task.completedByAgentId ?? task.ownerAgentId;
      ownerDisplay = agent ? `(${agent} · completed)` : "(completed)";
    } else if (task.status === "running") {
      const agent = task.ownerAgentId;
      ownerDisplay = agent ? `(${agent} · running)` : "(running)";
    } else if (task.status === "failed") {
      const agent = task.failedByAgentId ?? task.ownerAgentId;
      ownerDisplay = agent ? `(${agent} · failed)` : "(failed)";
    } else if (task.status === "cancelled") {
      ownerDisplay = task.supersededByTaskId || task.supersededReason ? "(superseded)" : "(cancelled)";
    } else if (task.status === "ready") {
      ownerDisplay = task.ownerAgentId ? `(${task.ownerAgentId})` : "(ready)";
    } else {
      ownerDisplay = task.ownerAgentId ? `(${task.ownerAgentId})` : "(unassigned)";
    }

    let extra = "";

    if (task.status === "blocked" && task.blockedReason) {
      extra = ` [blocked: ${task.blockedReason}]`;
    } else if (task.dependencies.length > 0 && task.status === "pending") {
      extra = ` [deps: ${task.dependencies.join(", ")}]`;
    }

    if (task.writeScopes && task.writeScopes.length > 0) {
      extra += ` [scopes: ${task.writeScopes.join(", ")}]`;
    }

    lines.push(`${symbol} [${task.id}] ${task.subject.padEnd(30)} ${ownerDisplay}${extra}`);
  }

  return lines.join("\n");
}

/**
 * 生成 Agent-Centric 执行者层次树视图
 *
 * 示例：
 * Main                     coordinating
 * ├── researcher           completed
 * ├── backend-agent        running (Task: task-2)
 * └── frontend-agent       waiting
 */
export function formatAgentCentricView(
  agentRegistry: AgentRegistry,
  taskManager?: TaskManager
): string {
  const allAgents = agentRegistry.getAllAgents();
  if (allAgents.length === 0) {
    return "(暂无活跃的 Agent 记录)";
  }

  const rootAgents = allAgents.filter((a) => !a.parentAgentId || a.depth === 0);
  const lines: string[] = [];

  const renderAgent = (agent: AgentRecord, prefix = "", isLast = true) => {
    let statusText = agent.status;
    if (agent.currentTaskId && taskManager) {
      const task = taskManager.getTask(agent.currentTaskId);
      if (task) {
        statusText += ` (Task: ${task.subject})`;
      } else {
        statusText += ` (Task: ${agent.currentTaskId})`;
      }
    }

    const displayName = agent.name ? `${agent.name} [${agent.agentId}]` : agent.agentId;
    const roleText = agent.role ? ` <${agent.role}>` : "";
    const nodePrefix = prefix === "" ? "" : isLast ? "└── " : "├── ";

    lines.push(`${prefix}${nodePrefix}${displayName}${roleText}: ${statusText}`);

    const children = agentRegistry.getChildren(agent.agentId);
    const nextPrefix = prefix + (isLast ? "    " : "│   ");

    for (let i = 0; i < children.length; i++) {
      const childIsLast = i === children.length - 1;
      renderAgent(children[i], nextPrefix, childIsLast);
    }
  };

  for (let i = 0; i < rootAgents.length; i++) {
    renderAgent(rootAgents[i], "", i === rootAgents.length - 1);
  }

  return lines.join("\n");
}

/**
 * 生成 Team 综合状态概览视图 (Roster + TaskBoard + Mailbox)
 */
export function formatTeamView(team: TeamRuntime): string {
  const lines: string[] = [];
  lines.push(`=== Team: ${team.name} [Leader: ${team.leaderId}] ===\n`);

  lines.push("[Roster Members]");
  const members = team.roster.getMembers();
  if (members.length === 0) {
    lines.push("  (无成员)");
  } else {
    for (const m of members) {
      const agent = team.agentRegistry.getAgent(m.agentId);
      const unread = team.mailbox.getUnreadCount(m.agentId);
      const unreadTag = unread > 0 ? ` [${unread} unread msgs]` : "";
      lines.push(
        `  • ${m.name} (${m.agentId}) <${m.role}> - status: ${agent?.status ?? "unknown"}${unreadTag}`
      );
    }
  }

  lines.push("\n[TaskBoard]");
  const taskView = formatTaskCentricView(team.taskManager);
  lines.push(taskView.split("\n").map((l) => `  ${l}`).join("\n"));

  return lines.join("\n");
}
