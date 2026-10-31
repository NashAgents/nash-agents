import type { Task, TaskStatus } from "../task/types.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import { AgentTreeProjection } from "./agent-tree-projection.js";
import { getVisibleWidth } from "./terminal-renderer.js";

export interface ActiveTaskGraphRenderOptions {
  maxWidth?: number;
  maxVisibleTasks?: number;
  isExpanded?: boolean;
  agentRegistry?: AgentRegistry;
}

/**
 * ActiveTaskGraphProjection - 负责执行期 TaskManager 活跃任务图的单一事实来源投影
 *
 * 核心设计：
 * 1. 唯一数据源：TaskManager 任务快照；
 * 2. Header 进度统计 (x/y) 与行状态严格来自同一个 snapshot，杜绝矛盾；
 * 3. 强状态图标映射：
 *    - completed:  ✓ (\x1b[32m)
 *    - running:    → (\x1b[33m)
 *    - ready:      ○ (\x1b[36m)
 *    - pending:    · (\x1b[90m)
 *    - blocked:    ⚠ (\x1b[31m)
 *    - failed:     ✗ (\x1b[31m)
 *    - superseded: ⊘ (\x1b[90m)
 *    - cancelled:  ⊘ (\x1b[90m)
 * 4. 显示所有者简洁 DisplayName (metro-analyst)，杜绝 agent-uuid 噪音；
 * 5. superseded / cancelled 历史任务默认折叠，防止挤占视野。
 */
export class ActiveTaskGraphProjection {
  static getTaskIcon(task: Task): string {
    const isSuperseded = Boolean(task.supersededByTaskId || task.supersededReason);
    if (isSuperseded) {
      return "\x1b[90m⊘\x1b[0m";
    }

    switch (task.status) {
      case "completed":
        return "\x1b[32m✓\x1b[0m";
      case "running":
        return "\x1b[33m→\x1b[0m";
      case "ready":
        return "\x1b[36m○\x1b[0m";
      case "pending":
        return "\x1b[90m·\x1b[0m";
      case "blocked":
        return "\x1b[31m⚠\x1b[0m";
      case "failed":
        return "\x1b[31m✗\x1b[0m";
      case "cancelled":
        return "\x1b[90m⊘\x1b[0m";
      default:
        return "\x1b[90m○\x1b[0m";
    }
  }

  static getOwnerDisplayName(agentId: string | undefined, agentRegistry?: AgentRegistry): string {
    if (!agentId) return "";
    if (agentRegistry) {
      const record = agentRegistry.getAgent(agentId);
      if (record) {
        return AgentTreeProjection.getDisplayName(record);
      }
    }
    // 若匹配默认 main
    if (agentId === "main" || agentId === "main-agent") return "Main";
    return agentId;
  }

  static render(tasks: Task[], options?: ActiveTaskGraphRenderOptions): string[] {
    if (!tasks || tasks.length === 0) {
      return [];
    }

    const lines: string[] = [];
    const isExpanded = options?.isExpanded ?? true;
    const maxWidth = options?.maxWidth ?? 80;
    const maxVisibleTasks = options?.maxVisibleTasks ?? 6;
    const registry = options?.agentRegistry;

    // 统计：同 snapshot
    const completedCount = tasks.filter((t) => t.status === "completed").length;
    const totalCount = tasks.length;

    // 分离活跃任务与已作废任务
    const isSupersededTask = (t: Task) =>
      Boolean(t.supersededByTaskId || t.supersededReason || t.status === "cancelled");

    const activeTasks = tasks.filter((t) => !isSupersededTask(t));
    const supersededTasks = tasks.filter((t) => isSupersededTask(t));

    // 按任务原本创建时序（计划时序）排列，保证步骤序号 1, 2, 3 绝对稳定一致
    const orderedActiveTasks = [...activeTasks].sort((a, b) => a.createdAt - b.createdAt);

    // 找到当前正在运行的任务及其在 active 任务中的 1-based 序号
    const runningIndex = orderedActiveTasks.findIndex((t) => t.status === "running");
    const runningTask = runningIndex >= 0 ? orderedActiveTasks[runningIndex] : undefined;
    const runningStepNum = runningIndex >= 0 ? runningIndex + 1 : undefined;

    let progressNote = "";
    if (runningStepNum !== undefined) {
      progressNote = `running #${runningStepNum}`;
    } else if (completedCount === totalCount && totalCount > 0) {
      progressNote = "done ✓";
    }

    const planHeaderTitle = progressNote
      ? `\x1b[1mPlan (${completedCount}/${totalCount})\x1b[0m \x1b[90m· ${progressNote}\x1b[0m`
      : `\x1b[1mPlan (${completedCount}/${totalCount})\x1b[0m`;

    if (!isExpanded) {
      const activeTask =
        runningTask ??
        orderedActiveTasks.find((t) => t.status === "ready") ??
        orderedActiveTasks.find((t) => t.status === "blocked");
      const sub = activeTask ? ` · #${runningStepNum ?? 1} ${activeTask.subject}` : "";
      lines.push(`\x1b[90m${planHeaderTitle}${sub} (Ctrl+T expand)\x1b[0m`);
      return lines;
    }

    lines.push(`${planHeaderTitle} \x1b[90m(Ctrl+T collapse)\x1b[0m`);

    let windowStart = 0;
    if (orderedActiveTasks.length > maxVisibleTasks && runningIndex >= 0) {
      windowStart = Math.max(0, Math.min(runningIndex - 1, orderedActiveTasks.length - maxVisibleTasks));
    }
    const visibleActive = orderedActiveTasks.slice(windowStart, windowStart + maxVisibleTasks);

    if (windowStart > 0) {
      lines.push(`  \x1b[90m… ${windowStart} earlier tasks\x1b[0m`);
    }

    for (let i = 0; i < visibleActive.length; i++) {
      const t = visibleActive[i];
      const stepNumber = windowStart + i + 1;
      const icon = this.getTaskIcon(t);
      const assignedId =
        t.status === "completed"
          ? (t.completedByAgentId ?? t.ownerAgentId)
          : t.ownerAgentId;
      const ownerName = this.getOwnerDisplayName(assignedId, registry);
      const ownerText = ownerName ? `\x1b[90m${ownerName}\x1b[0m` : "";

      let subjectText = t.subject;
      if (t.status === "running") {
        subjectText = `\x1b[33m\x1b[1m${t.subject}\x1b[0m \x1b[33m(running #${stepNumber})\x1b[0m`;
      } else if (t.status === "completed") {
        subjectText = `\x1b[90m${t.subject}\x1b[0m`;
      } else if (t.status === "blocked") {
        subjectText = `\x1b[31m${t.subject}\x1b[0m${t.blockedReason ? ` \x1b[90m(${t.blockedReason})\x1b[0m` : ""}`;
      }

      const leftPart = `  ${stepNumber}. ${icon} ${subjectText}`;
      const pad = Math.max(2, maxWidth - getVisibleWidth(leftPart) - getVisibleWidth(ownerText) - 2);
      lines.push(`${leftPart}${" ".repeat(pad)}${ownerText}`);
    }

    const remainingActive = orderedActiveTasks.length - (windowStart + visibleActive.length);
    if (remainingActive > 0) {
      lines.push(`  \x1b[90m… ${remainingActive} more tasks\x1b[0m`);
    }

    if (supersededTasks.length > 0) {
      lines.push(`  \x1b[90m⊘ ${supersededTasks.length} superseded tasks\x1b[0m`);
    }

    return lines;
  }
}
