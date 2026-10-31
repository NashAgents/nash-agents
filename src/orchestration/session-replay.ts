import type { SessionStore } from "../context/session/session-store.js";
import { TaskManager } from "../task/task-manager.js";
import { AgentRegistry } from "../agent/agent-registry.js";
import type { Task, TaskResult } from "../task/types.js";

export interface ReplayedSessionState {
  taskManager: TaskManager;
  agentRegistry: AgentRegistry;
  eventCount: number;
  recoveredTasksCount: number;
  recoveredAgentsCount: number;
}

/**
 * SessionReplayEngine - 从 durable session.jsonl 重建 Task / Agent 运行时状态
 *
 * 铁律：
 * 1. session.jsonl 是 Durable Session 的唯一事实来源；
 * 2. 进程重启后通过按时序重放 session.jsonl 中的 domain_event 记录，可 100% 重建 TaskGraph 与 AgentRegistry；
 * 3. 崩溃恢复 (Crash Recovery)：由于进程已消亡，重启时未完结的 running 任务必须自动降级恢复为 ready，running Agent 收敛为 interrupted。
 */
export class SessionReplayEngine {
  /**
   * 从给定的 SessionStore 重放并还原 TaskManager 与 AgentRegistry 状态
   */
  static async replay(
    sessionStore: SessionStore,
    options?: { autoRecoverRunning?: boolean }
  ): Promise<ReplayedSessionState> {
    const autoRecover = options?.autoRecoverRunning ?? true;
    const taskManager = new TaskManager({
      sessionId: sessionStore.sessionId,
    });
    const agentRegistry = new AgentRegistry({
      sessionId: sessionStore.sessionId,
    });

    const records = await sessionStore.getRecords();
    let eventCount = 0;

    for (const rec of records) {
      if (rec.type !== "domain_event") {
        continue;
      }

      eventCount++;
      const { eventType, data } = rec;

      try {
        switch (eventType) {
          case "task.created": {
            const rawTask = data.task as Task;
            if (rawTask && !taskManager.getTask(rawTask.id)) {
              taskManager.createTask({
                id: rawTask.id,
                subject: rawTask.subject,
                description: rawTask.description,
                dependencies: rawTask.dependencies,
                writeScopes: rawTask.writeScopes,
                ownerAgentId: rawTask.ownerAgentId,
                metadata: rawTask.metadata,
              });
            }
            break;
          }

          case "task.started": {
            const taskId = String(data.taskId);
            const agentId = String(data.agentId);
            const task = taskManager.getTask(taskId);
            if (task && task.status === "ready") {
              taskManager.claimTask(taskId, agentId);
              if (agentRegistry.getAgent(agentId)) {
                agentRegistry.updateStatus(agentId, "running", { currentTaskId: taskId });
              }
            }
            break;
          }

          case "task.completed": {
            const taskId = String(data.taskId);
            const result = data.result as TaskResult;
            const agentId = data.agentId ? String(data.agentId) : undefined;
            const task = taskManager.getTask(taskId);
            if (task && task.status !== "completed") {
              taskManager.completeTask(taskId, result ?? { summary: "done" }, { agentId });
            }
            break;
          }

          case "task.failed": {
            const taskId = String(data.taskId);
            const error = data.error as any;
            const agentId = data.agentId ? String(data.agentId) : undefined;
            const task = taskManager.getTask(taskId);
            if (task && task.status !== "failed") {
              taskManager.failTask(taskId, error ?? { message: "failed" }, { agentId });
            }
            break;
          }

          case "task.blocked": {
            const taskId = String(data.taskId);
            const reason = String(data.reason ?? "blocked");
            const blockedBy = data.blockedBy as string[] | undefined;
            const task = taskManager.getTask(taskId);
            if (task && task.status !== "blocked") {
              taskManager.blockTask(taskId, reason, blockedBy);
            }
            break;
          }

          case "task.cancelled": {
            const taskId = String(data.taskId);
            const reason = data.reason ? String(data.reason) : undefined;
            const task = taskManager.getTask(taskId);
            if (task && task.status !== "cancelled") {
              taskManager.cancelTask(taskId, reason);
            }
            break;
          }

          case "task.owner_changed": {
            const taskId = String(data.taskId);
            const newOwner = data.newOwner ? String(data.newOwner) : undefined;
            const task = taskManager.getTask(taskId);
            if (task && newOwner) {
              taskManager.assignTask(taskId, newOwner);
            }
            break;
          }

          case "agent.spawned": {
            const rawAgent = data.agent as any;
            if (rawAgent && !agentRegistry.getAgent(rawAgent.agentId)) {
              agentRegistry.register({
                agentId: rawAgent.agentId,
                name: rawAgent.name,
                parentAgentId: rawAgent.parentAgentId,
                type: rawAgent.type,
                depth: rawAgent.depth,
                role: rawAgent.role,
                roleDescription: rawAgent.roleDescription,
                worktreePath: rawAgent.worktreePath,
              });
            }
            break;
          }

          case "agent.running":
          case "agent.waiting":
          case "agent.completed":
          case "agent.failed":
          case "agent.interrupted": {
            const rawAgent = data.agent as any;
            const targetStatus = eventType.replace("agent.", "") as any;
            if (rawAgent && agentRegistry.getAgent(rawAgent.agentId)) {
              agentRegistry.updateStatus(rawAgent.agentId, targetStatus, {
                currentTaskId: rawAgent.currentTaskId,
                error: data.error as any,
              });
            }
            break;
          }
        }
      } catch {
        // best-effort 重放单条事件
      }
    }

    let recoveredTasksCount = 0;
    let recoveredAgentsCount = 0;

    // 崩溃恢复状态收敛 (Crash Recovery)
    if (autoRecover) {
      for (const task of taskManager.getTasks()) {
        if (task.status === "running") {
          recoveredTasksCount++;
          // 将未完结的 running 任务恢复为 ready，便于新进程认领重做
          taskManager.unclaimTask(task.id, task.ownerAgentId ?? "unknown");
        }
      }

      for (const agent of agentRegistry.getAllAgents()) {
        if (agent.status === "running" || agent.status === "waiting") {
          recoveredAgentsCount++;
          agentRegistry.updateStatus(agent.agentId, "interrupted", {
            error: {
              code: "PROCESS_CRASH_RECOVERED",
              message: "系统重启发现上次未完结进程，状态已收敛为 interrupted",
            },
          });
        }
      }
    }

    return {
      taskManager,
      agentRegistry,
      eventCount,
      recoveredTasksCount,
      recoveredAgentsCount,
    };
  }
}
