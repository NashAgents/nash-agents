export interface ExecutionTask {
  taskId: string;
  nodeId?: string;
  projectId?: string;
  goal?: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
  resultSummary?: string;
  activitySummary?: string;
  error?: string;
  isScout?: boolean;
  dispatchOptions?: { contextOverrides?: { isDiscovery?: boolean } };
}

const activeStates = new Set(["created", "queued", "accepted", "dispatched", "running", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"]);

export function scopedExecutionTasks(conversation: { linkedTaskIds?: string[]; messages: { sender: string; timestamp: number }[] }, tasks: ExecutionTask[]): ExecutionTask[] {
  const owned = new Set(conversation.linkedTaskIds ?? []);
  const latestUser = conversation.messages.filter(message => message.sender === "user").at(-1)?.timestamp ?? 0;
  const merged = new Map<string, ExecutionTask>();
  for (const task of tasks) {
    if (!owned.has(task.taskId)) continue;
    merged.set(task.taskId, { ...merged.get(task.taskId), ...task });
  }
  // Historical terminal tasks must not turn a new single-node request into a multi-node run.
  return [...merged.values()].filter(task => !task.createdAt || task.createdAt >= latestUser || activeStates.has(task.status))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.taskId.localeCompare(b.taskId));
}

export function taskStatus(status: string): { label: string; variant: "default" | "primary" | "success" | "warning" | "danger" } {
  switch (status) {
    case "completed": return { label: "已完成", variant: "success" };
    case "failed": return { label: "失败", variant: "danger" };
    case "cancelled": return { label: "已取消", variant: "default" };
    case "waiting_approval": return { label: "等待审批", variant: "warning" };
    case "outcome_unknown": return { label: "结果待确认", variant: "warning" };
    case "cancelling": return { label: "取消中", variant: "warning" };
    case "queued": case "created": return { label: "排队中", variant: "default" };
    case "dispatched": case "accepted": return { label: "已派发", variant: "primary" };
    case "running": case "interrupting": return { label: "执行中", variant: "primary" };
    default: return { label: "状态待确认", variant: "warning" };
  }
}

export function executionSummary(tasks: ExecutionTask[], coordinating = false) {
  const groups = [...new Set(tasks.map(task => task.nodeId ?? "未知节点"))].map(nodeId => ({ nodeId, tasks: tasks.filter(task => (task.nodeId ?? "未知节点") === nodeId) }));
  const scouts = tasks.length > 0 && tasks.every(task => task.isScout || task.dispatchOptions?.contextOverrides?.isDiscovery);
  const title = groups.length > 1 ? (scouts ? "多节点探查监控" : "多节点任务监控") : scouts ? "探查任务监控" : "任务监控";
  const completed = tasks.filter(task => task.status === "completed").length;
  const failed = tasks.filter(task => task.status === "failed").length;
  const active = tasks.filter(task => activeStates.has(task.status));
  let status = taskStatus(active.find(task => task.status === "outcome_unknown")?.status
    ?? active.find(task => task.status === "waiting_approval")?.status
    ?? active.find(task => task.status === "cancelling")?.status
    ?? active.find(task => ["running", "interrupting", "dispatched", "accepted"].includes(task.status))?.status
    ?? active[0]?.status ?? "unknown");
  if (!active.length && tasks.length && tasks.every(task => ["completed", "failed", "cancelled"].includes(task.status))) {
    status = failed ? { label: "存在失败", variant: "danger" }
      : completed === tasks.length ? { label: "已完成", variant: "success" }
      : tasks.every(task => task.status === "cancelled") ? { label: "已取消", variant: "default" }
      : { label: "已结束", variant: "default" };
    if (coordinating) status = { label: "正在汇总", variant: "primary" };
  }
  return { groups, title, completed, failed, status };
}
