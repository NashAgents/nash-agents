import { defineStore } from "pinia";
import { ref, computed, watch, onScopeDispose } from "vue";
import { api } from "../services/api.js";
import { globalClusterSse } from "../services/sse.js";
import { scopedExecutionTasks, type ExecutionTask } from "../services/task-monitor.js";

export interface MessageItem {
  id: string;
  conversationId: string;
  sender: "user" | "assistant" | "system";
  content: string;
  messageType?: string;
  metadata?: any;
  timestamp: number;
}

export interface ConversationItem {
  id: string;
  title: string;
  titleSource?: "default" | "ai_generated" | "user_defined";
  titleRevision?: number;
  createdAt: number;
  updatedAt: number;
  linkedTaskIds?: string[];
  linkedGraphIds?: string[];
  messages: MessageItem[];
}

export interface SelectedProjectContext {
  projectId: string;
  projectName: string;
  nodeId: string;
  nodeName?: string;
}

export interface ActivityProgress {
  conversationId?: string;
  phase: string;
  detail: string;
  scoutStates?: Record<string, "running" | "completed" | "failed" | "outcome_unknown">;
  timestamp: number;
}

export const useWorkspaceStore = defineStore("workspace", () => {
  let selectionRequest = 0;
  const creatingDraft = ref(false);
  const submissionError = ref("");
  const pendingSends = ref<Record<string, boolean>>({});
  const settledSends = ref(new Set<string>());
  let taskStateVersion = 0;
  const conversations = ref<ConversationItem[]>([]);
  const currentConversation = ref<ConversationItem | null>(null);
  const isDraft = ref(false);
  const loading = ref(false);
  const sending = ref(false);
  const activeSendingConvId = ref<string | null>(null);
  // 按会话隔离的动态协同活动字典，彻底杜绝跨会话状态泄漏
  const conversationActivities = ref<Record<string, ActivityProgress>>({});
  const currentActiveTask = ref<any | null>(null);
  // 多节点并行任务追踪表，支持 TaskGraph 多分支与多节点并行实时感知
  const activeRunningTasks = ref<Record<string, any>>({});
  const taskSummaries = ref<Record<string, ExecutionTask[]>>({});
  const currentExecutionTasks = computed(() => {
    const conversation = currentConversation.value;
    if (!conversation || conversation.id === "draft") return [];
    return scopedExecutionTasks(conversation, [
      ...(taskSummaries.value[conversation.id] ?? []),
      ...(currentActiveTask.value ? [currentActiveTask.value] : []),
      ...Object.values(activeRunningTasks.value),
    ]);
  });

  // 严格绑定当前激活会话的实时活动，会话切换后自动计算为当前会话状态或 null
  const currentActivity = computed(() => {
    if (!currentConversation.value) return null;
    return conversationActivities.value[currentConversation.value.id] || null;
  });

  const activeGraphId = computed(() => {
    if (currentActivity.value?.phase === "analyzing") return null;
    const graphs = currentConversation.value?.linkedGraphIds;
    return graphs && graphs.length > 0 ? graphs[graphs.length - 1] : null;
  });

  const activeTaskId = computed(() => {
    const tasks = currentConversation.value?.linkedTaskIds;
    return tasks && tasks.length > 0 ? tasks[tasks.length - 1] : null;
  });

  // 获取当前会话下所有处于运行态的多节点并行子任务列表
  const currentConversationRunningTasks = computed(() => {
    if (!currentConversation.value) return [];
    const linked = currentConversation.value.linkedTaskIds || [];
    const graphIds = currentConversation.value.linkedGraphIds || [];
    const list = Object.values(activeRunningTasks.value).filter(
      (t) => (linked.includes(t.taskId) || graphIds.includes(t.dispatchOptions?.graphContext?.graphId)) && ["created", "queued", "accepted", "running", "dispatched", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"].includes(t.status)
    );
    if (
      list.length === 0 &&
      currentActiveTask.value &&
      linked.includes(currentActiveTask.value.taskId) &&
      ["created", "queued", "accepted", "running", "dispatched", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"].includes(currentActiveTask.value.status)
    ) {
      return [currentActiveTask.value];
    }
    return list;
  });

  watch(
    () => activeTaskId.value,
    async (taskId) => {
      const version = taskStateVersion;
      if (taskId) {
        try {
          const res = await api.getTask(taskId);
          if (activeTaskId.value === taskId && version === taskStateVersion) currentActiveTask.value = res.task;
        } catch {
          if (activeTaskId.value === taskId && version === taskStateVersion) currentActiveTask.value = null;
        }
      } else {
        currentActiveTask.value = null;
      }
    },
    { immediate: true }
  );

  const selectedProjectContext = ref<SelectedProjectContext | null>(null);

  function setProjectContext(ctx: SelectedProjectContext) {
    selectedProjectContext.value = ctx;
  }

  function clearProjectContext() {
    selectedProjectContext.value = null;
  }

  const isCurrentConversationRunning = computed(() => {
    if (!currentConversation.value) return false;
    const convId = currentConversation.value.id;
    // 1. 本会话正在发送并由协调器主智能体推理中
    if ((pendingSends.value[convId] && !settledSends.value.has(convId)) || (sending.value && activeSendingConvId.value === convId)) {
      return true;
    }
    // 2. 本会话存在正在运行的动态协同活动
    if (conversationActivities.value[convId] && conversationActivities.value[convId].phase !== "completed") {
      return true;
    }
    // 3. 本会话关联的任务当前正在执行
    if (currentConversationRunningTasks.value.length > 0) {
      return true;
    }
    if (
      currentActiveTask.value &&
      currentConversation.value.linkedTaskIds?.includes(currentActiveTask.value.taskId) &&
      ["created", "queued", "accepted", "running", "dispatched", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"].includes(currentActiveTask.value.status)
    ) {
      return true;
    }
    return false;
  });

  const executionStatusText = computed(() => {
    const statuses = [currentActivity.value?.phase, ...currentConversationRunningTasks.value.map((task) => task.status)];
    if (statuses.includes("outcome_unknown")) return "执行结果待确认，请检查节点连接状态。";
    if (statuses.includes("cancelling")) return "已请求取消，正在等待执行节点确认停止…";
    if (statuses.includes("waiting_approval")) return "正在等待审批…";
    if (statuses.includes("queued")) return "任务已排队，等待目标节点上线…";
    return "Nash Agent 正在协同执行中...";
  });

  function settleSend(convId: string) {
    if (pendingSends.value[convId]) settledSends.value.add(convId);
    if (activeSendingConvId.value === convId) {
      sending.value = false;
      activeSendingConvId.value = null;
    }
  }

  function refreshSelectedConversation(convId: string | null) {
    if (convId && currentConversation.value?.id === convId) {
      void selectConversation(convId).catch(() => {});
    }
  }

  // 初始化 SSE 动态活动监听
  const unsubscribe = globalClusterSse.subscribe((event) => {
    const { type, data } = event;

    // 辅助解析：根据事件中的 conversationId、taskId 映射到目标会话 ID
    const resolveConvId = (): string | null => {
      if (data?.conversationId) return data.conversationId;
      if (data?.taskId) {
        const found = [currentConversation.value, ...conversations.value].find((c) => c?.linkedTaskIds?.includes(data.taskId));
        if (found) return found.id;
      }
      if (data?.graphId) {
        const found = [currentConversation.value, ...conversations.value].find((c) => c?.linkedGraphIds?.includes(data.graphId));
        if (found) return found.id;
      }
      return null;
    };

    const targetConvId = resolveConvId();
    if (type === "transport.open" && currentConversation.value?.id && currentConversation.value.id !== "draft") {
      void selectConversation(currentConversation.value.id).catch(() => {});
    }

    if (type === "cluster.heartbeat" && isCurrentConversationRunning.value) {
      refreshSelectedConversation(currentConversation.value?.id ?? null);
    }

    // 服务端回放游标已失效时，事件流无法补齐，必须强制重建一次权威状态。
    if (type === "stream.reset" && currentConversation.value?.id && currentConversation.value.id !== "draft") {
      void selectConversation(currentConversation.value.id).catch(() => {});
    }

    if (type === "coordinator.turn_started") {
      const convId = data?.conversationId || targetConvId;
      if (convId) {
        conversationActivities.value[convId] = {
          conversationId: convId,
          phase: "analyzing",
          detail: "正在分析用户意图并统筹集群资源...",
          timestamp: Date.now(),
        };
      }
    } else if (type === "coordinator.phase") {
      if (targetConvId && data?.phase && data?.detail) {
        conversationActivities.value[targetConvId] = { ...conversationActivities.value[targetConvId], conversationId: targetConvId,
          phase: data.phase, detail: data.detail, timestamp: data.timestamp || Date.now() };
      }
    } else if (type === "conversation.task_linked") {
      const convId = data?.conversationId || targetConvId;
      if (convId && data?.taskId) {
        if (currentConversation.value && currentConversation.value.id === convId) {
          const currentList = currentConversation.value.linkedTaskIds ?? [];
          if (!currentList.includes(data.taskId)) {
            currentConversation.value = {
              ...currentConversation.value,
              linkedTaskIds: [...currentList, data.taskId],
            };
          }
        }
        if (!activeRunningTasks.value[data.taskId]) {
          activeRunningTasks.value[data.taskId] = { taskId: data.taskId, nodeId: data.nodeId, projectId: data.projectId,
            goal: data.goal, isScout: data.isScout ?? true, status: "dispatched", createdAt: Date.now(), timestamp: Date.now() };
        }
      }
    } else if (type === "coordinator.task_dispatched") {
      const convId = data?.conversationId || targetConvId;
      if (convId) {
        if (data.graphId) {
          const linked = conversations.value.find((conversation) => conversation.id === convId);
          if (linked) linked.linkedGraphIds = [...new Set([...(linked.linkedGraphIds ?? []), data.graphId])];
          const selected = currentConversation.value;
          if (selected && selected.id === convId) selected.linkedGraphIds = [...new Set([...(selected.linkedGraphIds ?? []), data.graphId])];
          conversationActivities.value[convId] = { conversationId: convId, phase: "running", detail: "任务图已启动，正在执行各阶段任务…", timestamp: Date.now() };
          return;
        }

        // 更新会话的 linkedTaskIds
        const conv = conversations.value.find((c) => c.id === convId);
        if (conv) {
          if (!conv.linkedTaskIds) conv.linkedTaskIds = [];
          if (data.taskId && !conv.linkedTaskIds.includes(data.taskId)) {
            conv.linkedTaskIds.push(data.taskId);
          }
        }
        if (currentConversation.value && currentConversation.value.id === convId) {
          const currentList = currentConversation.value.linkedTaskIds ?? [];
          if (data.taskId && !currentList.includes(data.taskId)) {
            currentConversation.value = {
              ...currentConversation.value,
              linkedTaskIds: [...currentList, data.taskId],
            };
          }
        }

        conversationActivities.value[convId] = {
          conversationId: convId,
          phase: "dispatched",
          detail: `已向节点 ${data.nodeId || "远程节点"} 派发任务 (${data.taskId})，正在执行中...`,
          timestamp: Date.now(),
        };
        if (data.taskId && !activeRunningTasks.value[data.taskId]) {
          activeRunningTasks.value[data.taskId] = { taskId: data.taskId, nodeId: data.nodeId, projectId: data.projectId,
            goal: data.goal, isScout: data.isScout, status: "dispatched", createdAt: Date.now(), timestamp: Date.now() };
          refreshSelectedConversation(convId);
        }
      }
    } else if (type === "coordinator.turn_cancelled") {
      const convId = data?.conversationId || targetConvId;
      if (convId) {
        conversationActivities.value[convId] = { conversationId: convId, phase: "cancelling", detail: "已请求取消，正在等待执行节点确认停止。", timestamp: Date.now() };
        settleSend(convId);
        refreshSelectedConversation(convId);
      }
    } else if (type.startsWith("graph.") || type === "task.control_ack") {
      // 图节点不一定在 linkedTaskIds 中；图生命周期必须通过图归属刷新权威快照。
      if (["graph.started", "graph.resumed", "graph.paused", "graph.completed", "graph.cancelled", "graph.failed", "graph.partially_completed", "graph.outcome_unknown", "graph.replan_committed", "graph.replanned", "graph.replan_started", "graph.node_dispatched", "graph.node_cancelled", "graph.node_waiting_approval", "task.control_ack"].includes(type)) {
        refreshSelectedConversation(targetConvId);
      }
    } else if (type === "discovery.started") {
      const convId = targetConvId;
      if (convId) {
        conversationActivities.value[convId] = {
          conversationId: convId,
          phase: "discovering",
          detail: `正在检索集群目录与联邦记忆 (${data?.query || ""})...`,
          scoutStates: {},
          timestamp: Date.now(),
        };
      }
    } else if (type === "discovery.scout_dispatched") {
      const convId = targetConvId;
      if (convId && conversationActivities.value[convId]) {
        const act = conversationActivities.value[convId];
        act.scoutStates = act.scoutStates || {};
        act.scoutStates[data.nodeId || "worker"] = "running";
        act.detail = `正在唤起分布式 Scout 深入各节点调查物理证据 (${data.nodeId || "Worker"})...`;
      }
      if (data.taskId && currentConversation.value && currentConversation.value.id === convId) {
        if (!currentConversation.value.linkedTaskIds) currentConversation.value.linkedTaskIds = [];
        if (!currentConversation.value.linkedTaskIds.includes(data.taskId)) {
          currentConversation.value.linkedTaskIds.push(data.taskId);
        }

      }
    } else if (["discovery.scout_completed", "discovery.scout_failed", "discovery.scout_outcome_unknown", "discovery.scout_wait_expired"].includes(type)) {
      const convId = targetConvId;
      if (convId && conversationActivities.value[convId]) {
        const act = conversationActivities.value[convId];
        if (act.scoutStates) {
          act.scoutStates[data.nodeId || "worker"] = type === "discovery.scout_wait_expired" ? "running" : type === "discovery.scout_outcome_unknown" ? "outcome_unknown" : type === "discovery.scout_failed" || data.error ? "failed" : "completed";
        }
        act.detail = type === "discovery.scout_wait_expired" ? `节点 [${data.nodeId || "Worker"}] 前台等待已结束，后台仍在执行。` : type === "discovery.scout_outcome_unknown" ? `节点 [${data.nodeId || "Worker"}] 执行结果未知，等待对账。` : type === "discovery.scout_failed" || data.error ? `节点 [${data.nodeId || "Worker"}] 探查未完成，正在核对原因…` : `节点 [${data.nodeId || "Worker"}] 底层执行已结束，探查范围仍需核验。`;
      }
    } else if (type === "discovery.completed") {
      const convId = targetConvId;
      if (convId && conversationActivities.value[convId]) {
        const count = data.validatedCandidatesCount ?? data.candidatesFound ?? 0;
        if (data.status !== "background_running") conversationActivities.value[convId].phase = "synthesizing";
        conversationActivities.value[convId].detail =
          data.status === "background_running" ? "前台等待已结束，后台 Scout 仍在执行。" : data.status === "outcome_unknown" ? "部分执行结果未知，等待节点对账。" : data.status === "known_nodes_offline" ? "已知线索所在节点离线，范围尚未确认。" : data.status === "no_online_nodes" ? "没有可用的在线节点，范围尚未确认。" : count > 0 ? `探查轮次已结束，发现 ${count} 个候选项目；覆盖范围仍需核验。` : "探查轮次已结束，覆盖范围仍需核验。";
      }
    } else if (type === "coordinator.turn_completed") {
      const convId = data?.conversationId || targetConvId;
      if (convId) {
        if (data?.settled) settleSend(convId);
        refreshSelectedConversation(convId);
      }
    } else if (type === "conversation.message_created") {
      if (data && currentConversation.value && data.conversationId === currentConversation.value.id) {
        const existing = currentConversation.value.messages.some((m) => m.id === data.message.id);
        if (!existing) {
          // 关键去重：检查是否存在相同发送者与内容的乐观消息 (opt-...)，就地替换，绝不重复 push！
          const optIdx = currentConversation.value.messages.findIndex(
            (m) =>
              m.id.startsWith("opt-") &&
              m.sender === data.message.sender &&
              m.content.trim() === data.message.content.trim()
          );
          if (optIdx !== -1) {
            currentConversation.value.messages[optIdx] = data.message;
          } else {
            currentConversation.value.messages.push(data.message);
          }
        }

        // 核心生命周期闭环：当收到 assistant 发送的正式回复时，立即解除执行中状态，杜绝界面滞留在“正在协同中”！
        if (data.message.sender === "assistant") {
          delete conversationActivities.value[data.conversationId];
          if (activeSendingConvId.value === data.conversationId) {
            activeSendingConvId.value = null;
            sending.value = false;
          }
        }
      }
    } else if (type === "conversation.title_updated") {
      const convId = data?.conversationId;
      const newTitle = data?.title;
      if (convId && newTitle) {
        const found = conversations.value.find((c) => c.id === convId);
        if (found) {
          found.title = newTitle;
          if (data.titleSource) found.titleSource = data.titleSource;
          if (data.titleRevision) found.titleRevision = data.titleRevision;
        }
        if (currentConversation.value && currentConversation.value.id === convId) {
          currentConversation.value.title = newTitle;
          if (data.titleSource) currentConversation.value.titleSource = data.titleSource;
          if (data.titleRevision) currentConversation.value.titleRevision = data.titleRevision;
        }
        // 关键：强制触发 conversations 响应式更新，确保左侧会话列表即时重新渲染！
        conversations.value = [...conversations.value];
      }
    } else if (type === "conversation.message_updated") {
      if (data && currentConversation.value && data.conversationId === currentConversation.value.id) {
        const idx = currentConversation.value.messages.findIndex((m) => m.id === data.message.id);
        if (idx !== -1) {
          currentConversation.value.messages[idx] = data.message;
        }
      }
    } else if (type === "task.started") {
      const convId = targetConvId;
      if (data?.taskId) {
        activeRunningTasks.value[data.taskId] = {
          taskId: data.taskId,
          nodeId: data.nodeId || "Worker",
          projectId: data.projectId,
          goal: data.goal,
          status: "running",
          timestamp: Date.now(),
        };
        const version = taskStateVersion;
        api
          .getTask(data.taskId)
          .then((res) => {
            if (version === taskStateVersion && res?.task && activeRunningTasks.value[data.taskId]) {
              activeRunningTasks.value[data.taskId] = { ...activeRunningTasks.value[data.taskId], ...res.task };
            }
          })
          .catch(() => {});
      }
      if (convId) {
        const linked = currentConversation.value?.id === convId ? currentConversation.value.linkedTaskIds || [] : [];
        const runningList = Object.values(activeRunningTasks.value).filter(
          (t) => linked.includes(t.taskId) && ["created", "queued", "accepted", "running", "dispatched", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"].includes(t.status)
        );
        const uniqueNodes = Array.from(new Set(runningList.map((t) => t.nodeId)));
        let detailText = `目标节点 [${data.nodeId || "Worker"}] 已承接任务，正在本地沙箱执行...`;
        if (uniqueNodes.length > 1) {
          detailText = `[${uniqueNodes.length} 个节点并行协同中] ${uniqueNodes.map((n) => `[${n}]`).join(" · ")} 正在本地沙箱执行...`;
        }
        conversationActivities.value[convId] = {
          conversationId: convId,
          phase: "running",
          detail: detailText,
          timestamp: Date.now(),
        };
      }
      if (currentActiveTask.value && data.taskId === currentActiveTask.value.taskId) {
        currentActiveTask.value.status = "running";
      }
    } else if (type === "task.progress") {
      const convId = targetConvId;
      if (data?.taskId && activeRunningTasks.value[data.taskId]) {
        activeRunningTasks.value[data.taskId].activitySummary = data.activitySummary;
      }
      if (convId) {
        const linked = currentConversation.value?.id === convId ? currentConversation.value.linkedTaskIds || [] : [];
        const runningList = Object.values(activeRunningTasks.value).filter(
          (t) => linked.includes(t.taskId) && ["created", "queued", "accepted", "running", "dispatched", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"].includes(t.status)
        );
        const uniqueNodes = Array.from(new Set(runningList.map((t) => t.nodeId)));
        let detailText = data.activitySummary ? `[${data.nodeId || "Worker"}] ${data.activitySummary}` : "Worker 正在执行任务...";
        if (uniqueNodes.length > 1) {
          detailText = `[${uniqueNodes.length} 个节点并行协同中] ${data.activitySummary ? `[${data.nodeId}] ${data.activitySummary}` : uniqueNodes.map((n) => `[${n}]`).join(" · ")}`;
        }
        conversationActivities.value[convId] = {
          conversationId: convId,
          phase: "running",
          detail: detailText,
          timestamp: Date.now(),
        };
      }
      if (currentActiveTask.value && data.taskId === currentActiveTask.value.taskId) {
        currentActiveTask.value.resultSummary = data.activitySummary;
      }
    } else if (type === "task.completed") {
      taskStateVersion++;
      const convId = targetConvId;
      if (data?.taskId && activeRunningTasks.value[data.taskId]) {
        activeRunningTasks.value[data.taskId].status = "completed";
        activeRunningTasks.value[data.taskId].finalAnswer = data.finalAnswer;
        setTimeout(() => {
          delete activeRunningTasks.value[data.taskId];
        }, 4000);
      }
      if (convId) {
        const awaitingSummary = Boolean(pendingSends.value[convId] || (sending.value && activeSendingConvId.value === convId));
        conversationActivities.value[convId] = {
          conversationId: convId,
          phase: awaitingSummary ? "synthesizing" : "completed",
          detail: `目标节点 [${data.nodeId || "Worker"}] 已完成执行，正在核对结果并整理答复…`,
          timestamp: Date.now(),
        };
        setTimeout(() => {
          if (conversationActivities.value[convId]?.phase === "completed") {
            delete conversationActivities.value[convId];
          }
        }, 3000);
      }
      if (currentActiveTask.value && data.taskId === currentActiveTask.value.taskId) {
        currentActiveTask.value.status = "completed";
        currentActiveTask.value.finalAnswer = data.finalAnswer;
      }
      // 仅当完成的任务属于当前正在查看的会话时才自动拉取会话刷新
      if (currentConversation.value?.id && (convId === currentConversation.value.id || currentConversation.value.linkedTaskIds?.includes(data.taskId))) {
        selectConversation(currentConversation.value.id);
      }
    } else if (type === "task.failed") {
      taskStateVersion++;
      const convId = targetConvId;
      if (data?.taskId && activeRunningTasks.value[data.taskId]) {
        activeRunningTasks.value[data.taskId].status = "failed";
        activeRunningTasks.value[data.taskId].error = data.error;
        setTimeout(() => {
          delete activeRunningTasks.value[data.taskId];
        }, 4000);
      }
      if (convId) {
        delete conversationActivities.value[convId];
      }
      if (currentActiveTask.value && data.taskId === currentActiveTask.value.taskId) {
        currentActiveTask.value.status = "failed";
        currentActiveTask.value.error = data.error;
      }
      if (currentConversation.value?.id && (convId === currentConversation.value.id || currentConversation.value.linkedTaskIds?.includes(data.taskId))) {
        selectConversation(currentConversation.value.id);
      }
    } else if (type === "task.cancelled") {
      taskStateVersion++;
      const convId = targetConvId;
      if (data?.taskId && activeRunningTasks.value[data.taskId]) {
        activeRunningTasks.value[data.taskId].status = "cancelled";
        setTimeout(() => {
          delete activeRunningTasks.value[data.taskId];
        }, 4000);
      }
      if (convId) {
        delete conversationActivities.value[convId];
      }
      if (currentActiveTask.value && data.taskId === currentActiveTask.value.taskId) {
        currentActiveTask.value.status = "cancelled";
      }
      if (currentConversation.value?.id && (convId === currentConversation.value.id || currentConversation.value.linkedTaskIds?.includes(data.taskId))) {
        selectConversation(currentConversation.value.id);
      }
    }
  });
  onScopeDispose(unsubscribe);

  async function loadConversations() {
    loading.value = true;
    try {
      const res = await api.listConversations(50);
      const rawList = res.conversations || [];

      // 空会话不进入列表；删除必须由显式操作触发，避免多页面并发丢数据。
      const validConvs = rawList.filter(
        (c: ConversationItem) => c.messages && c.messages.length > 0
      );
      conversations.value = validConvs;

      // 刷新保底韧性：优先恢复用户此前正在查看的会话 ID
      const savedId =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("nash_active_conv_id")
          : null;
      const matched = savedId ? validConvs.find((c: ConversationItem) => c.id === savedId) : null;
      if (matched) {
        await selectConversation(matched.id);
      } else if (validConvs.length > 0) {
        await selectConversation(validConvs[0]!.id);
      } else {
        startNewDraft();
      }
    } finally {
      loading.value = false;
    }
  }

  function startNewDraft() {
    selectionRequest++;
    isDraft.value = true;
    currentConversation.value = {
      id: "draft",
      title: "新任务",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      linkedTaskIds: [],
      linkedGraphIds: [],
      messages: [],
    };
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("nash_active_conv_id");
    }
  }

  async function selectConversation(id: string) {
    if (id === "draft") {
      startNewDraft();
      return;
    }
    const request = ++selectionRequest;
    isDraft.value = false;
    loading.value = true;
    try {
      const res = (await api.getConversation(id)) as any;
      if (request !== selectionRequest) return;

      // 关键：若前端已收到通过 SSE 广播的 AI 标题或用户自定义标题，绝对防止被携带 default 来源的旧快照冲刷回退！
      const idx = conversations.value.findIndex((c) => c.id === id);
      if (idx !== -1 && res.conversation) {
        const existing = conversations.value[idx];
        const keepExistingTitle =
          existing?.titleSource &&
          existing.titleSource !== "default" &&
          res.conversation.titleSource === "default";

        const finalTitle = keepExistingTitle ? existing!.title : (res.conversation.title || existing?.title);
        const finalSource = keepExistingTitle ? existing!.titleSource : (res.conversation.titleSource || existing?.titleSource);
        const finalRev = keepExistingTitle
          ? Math.max(existing!.titleRevision || 0, res.conversation.titleRevision || 0)
          : (res.conversation.titleRevision ?? existing?.titleRevision);

        res.conversation.title = finalTitle;
        res.conversation.titleSource = finalSource;
        res.conversation.titleRevision = finalRev;

        conversations.value[idx] = {
          ...conversations.value[idx],
          ...res.conversation,
          title: finalTitle,
          titleSource: finalSource,
          titleRevision: finalRev,
        };
        conversations.value = [...conversations.value];
      }
      currentConversation.value = res.conversation;
      if (Array.isArray(res.taskSummaries)) taskSummaries.value[id] = res.taskSummaries;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("nash_active_conv_id", id);
      }

      taskStateVersion++;
      if (Array.isArray(res.activeTasks)) {
        for (const tid of res.conversation?.linkedTaskIds ?? []) delete activeRunningTasks.value[tid];
        for (const [tid, task] of Object.entries(activeRunningTasks.value)) {
          if (res.conversation?.linkedGraphIds?.includes(task.dispatchOptions?.graphContext?.graphId)) delete activeRunningTasks.value[tid];
        }
        for (const task of res.activeTasks) activeRunningTasks.value[task.taskId] = task;
        currentActiveTask.value = res.activeTasks.find((task: any) => task.taskId === activeTaskId.value) ?? null;
      }

      // 快照替换本会话状态；不能保留取消前的 analyzing/running，也不能把后台图冒充为模型请求。
      if (res.activeTurn) {
        activeSendingConvId.value = id;
        sending.value = true;
      } else {
        settleSend(id);
      }
      if (res.isRunning) {
        const statuses: string[] = [res.activeTurn?.status, ...(res.activeTasks ?? []).map((task: any) => task.status),
          ...(res.activeGraphs ?? []).map((graph: any) => graph.status)].filter(Boolean);
        const phase = ["outcome_unknown", "cancelling", "waiting_approval", "queued"].find((status) => statuses.includes(status))
          ?? res.activeTurn?.progress?.phase
          ?? (res.activeTasks?.length || res.activeGraphs?.length ? "running" : "analyzing");
        conversationActivities.value[id] = {
          conversationId: id, phase,
          detail: ({ outcome_unknown: "执行结果待确认，请检查节点恢复情况。", waiting_approval: "正在等待你的审批。", cancelling: "已请求取消，正在等待执行节点确认停止。", queued: "任务已排队，等待目标节点上线。" } as Record<string, string>)[phase]
            ?? res.activeTurn?.progress?.detail ?? (phase === "running" ? "目标节点正在执行任务。" : "正在分析用户意图并统筹集群资源..."),
          timestamp: res.activeTurn?.startedAt || Date.now(),
        };
      } else {
        delete conversationActivities.value[id];
      }
    } finally {
      if (request === selectionRequest) loading.value = false;
    }
  }

  async function createNewConversation(initialPrompt?: string) {
    startNewDraft();
    return currentConversation.value;
  }

  async function updateConversationTitle(id: string, newTitle: string) {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await api.updateConversation(id, trimmed, "user_defined");
      const found = conversations.value.find((c) => c.id === id);
      if (found) {
        found.title = trimmed;
        found.titleSource = "user_defined";
      }
      if (currentConversation.value && currentConversation.value.id === id) {
        currentConversation.value.title = trimmed;
        currentConversation.value.titleSource = "user_defined";
      }
    } catch (err) {
      console.error("Failed to update conversation title:", err);
    }
  }

  async function sendMessage(text: string, selection?: { optionId: string }): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;
    submissionError.value = "";
    let targetConversation = currentConversation.value;
    if (isDraft.value || !targetConversation || targetConversation.id === "draft") {
      if (creatingDraft.value) { submissionError.value = "正在创建会话，请稍后发送"; return false; }
      creatingDraft.value = true;
      sending.value = true;
      activeSendingConvId.value = "draft";
      const request = selectionRequest;
      try {
        const created = await api.createConversation(trimmed.slice(0, 30));
        targetConversation = created.conversation;
        conversations.value.unshift(targetConversation!);
        if (request === selectionRequest) {
          currentConversation.value = targetConversation;
          isDraft.value = false;
          if (typeof localStorage !== "undefined") localStorage.setItem("nash_active_conv_id", targetConversation!.id);
        }
      } catch (err: any) {
        submissionError.value = err.message || "创建会话失败，请重试";
        return false;
      } finally {
        creatingDraft.value = false;
        if (activeSendingConvId.value === "draft") { sending.value = false; activeSendingConvId.value = null; }
      }
    }
    const convId = targetConversation!.id;
    if (pendingSends.value[convId]) { submissionError.value = "此会话正在发送上一条消息"; return false; }
    settledSends.value.delete(convId);
    pendingSends.value[convId] = true;
    activeSendingConvId.value = convId;
    sending.value = true;
    conversationActivities.value[convId] = { conversationId: convId, phase: "analyzing", detail: "正在分析用户意图并统筹集群资源...", timestamp: Date.now() };
    const optimistic = { id: `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`, conversationId: convId, sender: "user" as const,
      content: trimmed, messageType: "text", timestamp: Date.now() };
    targetConversation!.messages.push(optimistic);
    try {
      const res = await api.sendConversationMessage(convId, trimmed, selection);
      if (res.conversation) {
        const index = conversations.value.findIndex((c) => c.id === convId);
        const existingConv = index !== -1 ? conversations.value[index] : null;

        // 关键防覆盖逻辑：如果本地或者此前已收到更新的 titleRevision 或已由 AI 命名 / 用户自定义，
        // 则保留较新的 title，绝不能被老快照覆盖！
        let finalTitle = res.conversation.title;
        let finalSource = res.conversation.titleSource;
        let finalRevision = res.conversation.titleRevision;

        if (existingConv) {
          const existingRev = existingConv.titleRevision || 0;
          const incomingRev = res.conversation.titleRevision || 0;
          if (
            existingRev > incomingRev ||
            (existingConv.titleSource && existingConv.titleSource !== "default" && res.conversation.titleSource === "default") ||
            (existingConv.titleSource === "ai_generated" && res.conversation.titleSource === "default") ||
            (existingConv.title && existingConv.title !== res.conversation.title && res.conversation.titleSource === "default" && existingConv.titleSource === "ai_generated")
          ) {
            finalTitle = existingConv.title;
            finalSource = existingConv.titleSource;
            finalRevision = Math.max(existingRev, incomingRev);
          }
        }

        const mergedConv = {
          ...res.conversation,
          title: finalTitle,
          titleSource: finalSource,
          titleRevision: finalRevision,
        };

        if (currentConversation.value?.id === convId) {
          currentConversation.value = mergedConv;
        }
        if (index !== -1) {
          conversations.value[index] = mergedConv;
          conversations.value = [...conversations.value];
        }
      }
      return true;
    } catch (err: any) {
      submissionError.value = err.message || "发送失败，请重试";
      targetConversation!.messages = targetConversation!.messages.filter((message) => message.id !== optimistic.id);
      return false;
    } finally {
      delete pendingSends.value[convId];
      settledSends.value.delete(convId);
      if (activeSendingConvId.value === convId) { sending.value = false; activeSendingConvId.value = null; }
      if (currentConversation.value?.id === convId) await selectConversation(convId).catch(() => {});
    }
  }

  async function cancelCurrentExecution() {
    if (!currentConversation.value || currentConversation.value.id === "draft") return;
    const convId = currentConversation.value.id;
    const result = await api.cancelConversation(convId);
    if (!result.success) throw new Error(result.message);
    if (currentConversation.value?.id === convId) await selectConversation(convId);
  }

  async function interruptCurrentExecution() {
    if (!currentConversation.value || currentConversation.value.id === "draft") return;
    const convId = currentConversation.value.id;
    const result = await api.interruptConversation(convId);
    if (!result.success || !result.interrupted) throw new Error(result.message);
  }

  async function deleteConversation(id: string) {
    if (id === "draft") {
      startNewDraft();
      return;
    }
    await api.deleteConversation(id);
    delete conversationActivities.value[id];
    conversations.value = conversations.value.filter((c) => c.id !== id);
    if (currentConversation.value?.id === id) {
      if (conversations.value.length > 0) {
        await selectConversation(conversations.value[0]!.id);
      } else {
        startNewDraft();
      }
    }
  }

  return {
    conversations,
    creatingDraft,
    submissionError,
    currentConversation,
    isDraft,
    loading,
    sending,
    activeSendingConvId,
    conversationActivities,
    selectedProjectContext,
    setProjectContext,
    clearProjectContext,
    currentActivity,
    currentActiveTask,
    activeRunningTasks,
    currentConversationRunningTasks,
    currentExecutionTasks,
    activeGraphId,
    activeTaskId,
    isCurrentConversationRunning,
    executionStatusText,
    loadConversations,
    selectConversation,
    startNewDraft,
    createNewConversation,
    updateConversationTitle,
    sendMessage,
    cancelCurrentExecution,
    interruptCurrentExecution,
    deleteConversation,
  };
});
