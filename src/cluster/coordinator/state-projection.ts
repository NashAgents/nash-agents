import type { SequencedEvent } from "../protocol/types.js";
import type { ClusterTaskRecord, ClusterTaskStatus } from "../storage/cluster-store.js";

export interface ProjectedTaskState {
  taskId: string;
  nodeId: string;
  projectId: string;
  goal: string;
  status: ClusterTaskStatus;
  currentActivity: string;
  currentStep: number;
  maxSteps?: number;
  totalToolCalls: number;
  recentTools: string[];
  pendingApproval?: {
    approvalId: string;
    capability: string;
    toolName?: string;
    reason: string;
    target?: string;
  };
  lastEventAt: number;
  finalAnswer?: string;
  error?: string;
  durationMs?: number;
}

export class TaskStateProjection {
  /**
   * 将任务记录与历史事件流合成为最新状态快照
   */
  static project(task: ClusterTaskRecord, events: SequencedEvent[]): ProjectedTaskState {
    let currentActivity = "Initializing...";
    let currentStep = 0;
    let maxSteps: number | undefined;
    let totalToolCalls = 0;
    const recentTools: string[] = [];
    let pendingApproval: ProjectedTaskState["pendingApproval"];
    let lastEventAt = task.updatedAt;

    for (const ev of events) {
      if (ev.timestamp > lastEventAt) {
        lastEventAt = ev.timestamp;
      }

      switch (ev.eventType) {
        case "task.started":
          currentActivity = "Agent run started";
          break;
        case "task.progress":
          if (ev.data.activitySummary) {
            currentActivity = String(ev.data.activitySummary);
          }
          if (typeof ev.data.currentStep === "number") {
            currentStep = ev.data.currentStep;
          }
          if (typeof ev.data.maxSteps === "number") {
            maxSteps = ev.data.maxSteps;
          }
          break;
        case "tool.started":
          totalToolCalls++;
          const tName = String(ev.data.toolName ?? "unknown");
          recentTools.push(tName);
          if (recentTools.length > 5) recentTools.shift();
          currentActivity = `Executing tool: ${tName}`;
          break;
        case "tool.completed":
          currentActivity = `Completed tool: ${String(ev.data.toolName ?? "")}`;
          break;
        case "tool.failed":
          currentActivity = `Tool failed: ${String(ev.data.toolName ?? "")} (${String(ev.data.error ?? "")})`;
          break;
        case "model.started":
          currentActivity = "Thinking and generating response...";
          break;
        case "agent.steered":
          currentActivity = `Received user steer guidance: ${String(ev.data.content ?? "").slice(0, 40)}...`;
          break;
        case "approval.requested":
          pendingApproval = {
            approvalId: String(ev.data.approvalId ?? ev.data.id),
            capability: String(ev.data.capability),
            toolName: ev.data.toolName ? String(ev.data.toolName) : undefined,
            reason: String(ev.data.reason ?? ""),
            target: ev.data.target ? String(ev.data.target) : undefined,
          };
          currentActivity = `Waiting for user approval: ${pendingApproval.capability} (${pendingApproval.reason})`;
          break;
        case "approval.resolved":
          pendingApproval = undefined;
          currentActivity = `Approval resolved: ${String(ev.data.decision)}`;
          break;
        case "task.completed":
          currentActivity = "Completed successfully";
          break;
        case "task.failed":
          currentActivity = `Failed: ${String(ev.data.error ?? "")}`;
          break;
        case "task.cancelled":
          currentActivity = "Cancelled by user";
          break;
      }
    }

    if (task.status === "completed") {
      currentActivity = "Completed successfully";
    } else if (task.status === "failed") {
      currentActivity = `Failed: ${task.error ?? "Unknown error"}`;
    } else if (task.status === "cancelled") {
      currentActivity = "Task cancelled";
    }

    const durationMs = task.completedAt ? task.completedAt - task.createdAt : Date.now() - task.createdAt;

    return {
      taskId: task.taskId,
      nodeId: task.nodeId,
      projectId: task.projectId,
      goal: task.goal,
      status: task.status,
      currentActivity,
      currentStep,
      maxSteps,
      totalToolCalls,
      recentTools,
      pendingApproval,
      lastEventAt,
      finalAnswer: task.finalAnswer,
      error: task.error,
      durationMs,
    };
  }
}
