import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../services/api.js";
import { createTaskSse, type SseConnection } from "../services/sse.js";

export const useTasksStore = defineStore("tasks", () => {
  const tasks = ref<any[]>([]);
  const currentTask = ref<any>(null);
  const currentEvents = ref<any[]>([]);
  const loading = ref(false);
  const error = ref("");

  let detailRequest = 0;
  let selectedTaskId: string | null = null;
  let activeSse: SseConnection | null = null;
  let sseUnsubscribe: (() => void) | null = null;

  async function loadTasks(params?: { nodeId?: string; status?: string; limit?: number }) {
    loading.value = true;
    try {
      const res = await api.listTasks(params);
      tasks.value = res.tasks;
    } finally {
      loading.value = false;
    }
  }

  async function loadTaskDetails(taskId: string) {
    const request = ++detailRequest;
    selectedTaskId = taskId;
    currentTask.value = null;
    currentEvents.value = [];
    error.value = "";
    loading.value = true;
    if (activeSse) {
      activeSse.close();
      activeSse = null;
    }
    if (sseUnsubscribe) {
      sseUnsubscribe();
      sseUnsubscribe = null;
    }

    try {
      const [taskRes, eventsRes] = await Promise.all([
        api.getTask(taskId),
        api.getTaskEvents(taskId),
      ]);
      if (request !== detailRequest) return;
      // activeGrant 由服务端作为兄弟字段返回，必须合并进任务对象，否则详情页徽标永远为空。
      currentTask.value = (taskRes as any).activeGrant
        ? { ...taskRes.task, activeGrant: (taskRes as any).activeGrant }
        : taskRes.task;
      currentEvents.value = eventsRes.events;

      // 实时长连接
      activeSse = createTaskSse(taskId);
      sseUnsubscribe = activeSse.subscribe((event) => {
        handleTaskEvent(event);
      });
    } catch (err) {
      if (request === detailRequest) error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (request === detailRequest) loading.value = false;
    }
  }

  function handleTaskEvent(event: { type: string; data: any }) {
    const { type, data } = event;
    if (type === "transport.open" && selectedTaskId) {
      const id = selectedTaskId;
      const request = detailRequest;
      void api.getTask(id).then((res) => {
        if (request !== detailRequest) return;
        currentTask.value = (res as any).activeGrant ? { ...res.task, activeGrant: (res as any).activeGrant } : res.task;
      }).catch(() => {});
      return;
    }
    if (type === "approval.requested" && currentTask.value) currentTask.value.status = "waiting_approval";
    if (type === "approval.resolved" && currentTask.value) currentTask.value.status = "running";
    if (
      type === "transport.open" ||
      type.startsWith("stream.") ||
      data?.type?.startsWith("stream.") ||
      (type === "message" && (!data?.eventType || data?.type?.startsWith("stream.")))
    ) {
      return;
    }
    if (data?.taskId && data.taskId !== selectedTaskId) return;
    if (data?.seq && currentEvents.value.some((ev) => ev.seq === data.seq)) return;
    if (type === "task.started") {
      if (currentTask.value) currentTask.value.status = "running";
    } else if (type === "task.progress") {
      if (currentTask.value) {
        currentTask.value.resultSummary = data.activitySummary;
      }
    } else if (type === "task.completed") {
      if (currentTask.value) {
        currentTask.value.status = "completed";
        currentTask.value.finalAnswer = data.finalAnswer;
      }
    } else if (type === "task.failed") {
      if (currentTask.value) {
        currentTask.value.status = "failed";
        currentTask.value.error = data.error;
      }
    } else if (type === "task.cancelled") {
      if (currentTask.value) {
        currentTask.value.status = "cancelled";
      }
    }

    currentEvents.value.push({
      seq: data?.seq,
      eventType: type,
      payload: data,
      createdAt: data?.timestamp ?? Date.now(),
    });
  }

  async function steer(taskId: string, content: string) {
    return api.steerTask(taskId, content);
  }

  async function interrupt(taskId: string) {
    return api.interruptTask(taskId);
  }

  async function cancel(taskId: string, reason?: string) {
    return api.cancelTask(taskId, reason);
  }

  async function revokeGrant(taskId: string, grantId: string, reason?: string) {
    return api.revokeTaskGrant(taskId, { grantId, reason });
  }

  function cleanup() {
    detailRequest++;
    selectedTaskId = null;
    currentTask.value = null;
    currentEvents.value = [];
    loading.value = false;
    error.value = "";
    if (activeSse) {
      activeSse.close();
      activeSse = null;
    }
    if (sseUnsubscribe) {
      sseUnsubscribe();
      sseUnsubscribe = null;
    }
  }

  return {
    tasks,
    currentTask,
    currentEvents,
    loading,
    error,
    loadTasks,
    loadTaskDetails,
    steer,
    interrupt,
    cancel,
    revokeGrant,
    cleanup,
  };
});
