import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api } from "../services/api";

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  triggerType: "cron" | "interval" | "once";
  cronExpression?: string;
  intervalMs?: number;
  runAt?: number;
  timezone?: string;
  targetType: "single_task" | "graph";
  taskConfig?: {
    goal: string;
    prompt?: string;
    nodeId?: string;
    projectId?: string;
    timeoutMs?: number;
    maxSteps?: number;
  };
  graphConfig?: {
    parentGoal: string;
    nodes?: any[];
  };
  concurrencyPolicy: "SKIP_IF_RUNNING" | "QUEUE" | "ALLOW_CONCURRENT";
  misfirePolicy: "RUN_ONCE_IMMEDIATELY" | "SKIP_MISFIRE" | "CATCH_UP";
  maxConcurrency: number;
  lastRunAt?: number;
  lastRunStatus?: string;
  nextRunAt?: number;
  runCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskRun {
  id: string;
  scheduledTaskId: string;
  targetType: "single_task" | "graph";
  taskId?: string;
  graphId?: string;
  triggerTime: number;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "failed" | "skipped";
  skipReason?: string;
  error?: string;
  resultSummary?: string;
  metrics?: Record<string, unknown>;
  createdAt: number;
}

export const useScheduledStore = defineStore("scheduled", () => {
  const tasks = ref<ScheduledTask[]>([]);
  const currentRuns = ref<ScheduledTaskRun[]>([]);
  const selectedTask = ref<ScheduledTask | null>(null);
  const loading = ref(false);
  const loadingHistory = ref(false);
  const error = ref<string | null>(null);

  const activeTasksCount = computed(() => tasks.value.filter((t) => t.enabled).length);
  const totalTasksCount = computed(() => tasks.value.length);

  async function loadTasks(filter?: { enabled?: boolean; targetType?: string }) {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.listScheduledTasks(filter);
      tasks.value = res.tasks || [];
    } catch (err: any) {
      error.value = err?.message || String(err);
    } finally {
      loading.value = false;
    }
  }

  async function createTask(payload: any) {
    loading.value = true;
    try {
      const created = await api.createScheduledTask(payload);
      tasks.value.unshift(created);
      return created;
    } finally {
      loading.value = false;
    }
  }

  async function updateTask(id: string, patch: any) {
    loading.value = true;
    try {
      const updated = await api.updateScheduledTask(id, patch);
      const idx = tasks.value.findIndex((t) => t.id === id);
      if (idx !== -1) {
        tasks.value[idx] = updated;
      }
      if (selectedTask.value?.id === id) {
        selectedTask.value = updated;
      }
      return updated;
    } finally {
      loading.value = false;
    }
  }

  async function deleteTask(id: string) {
    await api.deleteScheduledTask(id);
    tasks.value = tasks.value.filter((t) => t.id !== id);
    if (selectedTask.value?.id === id) {
      selectedTask.value = null;
    }
  }

  async function pauseTask(id: string) {
    const updated = await api.pauseScheduledTask(id);
    const idx = tasks.value.findIndex((t) => t.id === id);
    if (idx !== -1) tasks.value[idx] = updated;
    if (selectedTask.value?.id === id) selectedTask.value = updated;
    return updated;
  }

  async function resumeTask(id: string) {
    const updated = await api.resumeScheduledTask(id);
    const idx = tasks.value.findIndex((t) => t.id === id);
    if (idx !== -1) tasks.value[idx] = updated;
    if (selectedTask.value?.id === id) selectedTask.value = updated;
    return updated;
  }

  async function runNow(id: string, force = false) {
    const res = await api.runScheduledTaskNow(id, force);
    // 刷新执行历史
    if (selectedTask.value?.id === id) {
      loadHistory(id);
    }
    return res;
  }

  async function loadHistory(id: string, status?: string) {
    loadingHistory.value = true;
    try {
      const res = await api.getScheduledTaskHistory(id, { status, limit: 50 });
      currentRuns.value = res.runs || [];
    } finally {
      loadingHistory.value = false;
    }
  }

  function selectTask(task: ScheduledTask | null) {
    selectedTask.value = task;
    if (task) {
      loadHistory(task.id);
    } else {
      currentRuns.value = [];
    }
  }

  return {
    tasks,
    currentRuns,
    selectedTask,
    loading,
    loadingHistory,
    error,
    activeTasksCount,
    totalTasksCount,
    loadTasks,
    createTask,
    updateTask,
    deleteTask,
    pauseTask,
    resumeTask,
    runNow,
    loadHistory,
    selectTask,
  };
});
