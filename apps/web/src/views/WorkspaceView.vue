<template>
  <component :is="layoutComponent">
    <!-- 中间主视图：消息流与输入框 -->
    <div class="flex-1 flex flex-col h-full min-h-0 relative">
      <!-- 顶部当前会话信息条 (仅非空会话展示) -->
      <div
        v-if="workspaceStore.currentConversation && !workspaceStore.isDraft && workspaceStore.currentConversation.messages.length > 0"
        class="px-4 py-2 border-b border-surface-800/80 bg-surface-950/70 backdrop-blur flex items-center justify-between text-xs z-10"
      >
        <div class="flex items-center gap-2 truncate flex-1 mr-2">
          <svg class="w-3.5 h-3.5 text-nash-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span class="font-semibold text-surface-200 truncate" :title="workspaceStore.currentConversation.title">
            {{ workspaceStore.currentConversation.title }}
          </span>
        </div>

        <!-- 关联的任务直达胶囊 -->
        <div
          v-if="workspaceStore.currentConversation.linkedTaskIds && workspaceStore.currentConversation.linkedTaskIds.length > 0"
          class="flex items-center gap-1.5 flex-shrink-0"
        >
          <router-link
            v-for="tid in workspaceStore.currentConversation.linkedTaskIds.slice(-2)"
            :key="tid"
            :to="`/tasks/${tid}`"
            class="px-2 py-0.5 rounded bg-surface-900 border border-surface-700/80 hover:border-nash-500/50 text-[11px] font-mono text-nash-400 hover:text-nash-300 flex items-center gap-1 transition-colors"
            title="查看任务详情与事件时间线"
          >
            <span>任务: {{ tid.slice(-8) }}</span>
            <span class="text-surface-500">›</span>
          </router-link>
        </div>
      </div>

      <!-- 消息列表视口 -->
      <div
        ref="scrollContainerRef"
        class="flex-1 overflow-y-auto px-4 py-4 space-y-2 min-h-0"
        @scroll="handleUserScroll"
      >
        <!-- 空状态 / 欢迎卡片 -->
        <div
          v-if="!workspaceStore.currentConversation || workspaceStore.currentConversation.messages.length === 0"
          class="h-full flex flex-col items-center justify-center my-auto py-12 text-center"
        >
          <div class="w-16 h-16 rounded-2xl bg-nash-500/10 border border-nash-500/30 flex items-center justify-center text-nash-500 font-bold text-2xl mb-4 shadow-inner">
            N
          </div>
          <h2 class="text-lg font-bold text-surface-100 tracking-tight">
            {{ t.workspace.welcomeSubtitle }}
          </h2>
          <p class="text-xs text-surface-400 mt-1 max-w-md">
            直接用自然语言描述任务，Nash 将自动通过 Semantic Router 智能选点派发，或通过 Distributed TaskGraph 协同执行。
          </p>

          <!-- 快速动作 Chips -->
          <div class="mt-6 flex flex-wrap gap-2 max-w-lg justify-center">
            <button
              v-for="(action, i) in quickPrompts"
              :key="i"
              @click="handleQuickPrompt(action)"
              class="px-3 py-1.5 rounded-full bg-surface-900 border border-surface-700/80 hover:border-nash-500/60 text-surface-300 hover:text-surface-100 text-xs transition-all active:scale-95 shadow-sm text-left flex items-center gap-1.5"
            >
              <span class="text-nash-500 font-bold">›</span>
              <span>{{ action }}</span>
            </button>
          </div>
        </div>

        <!-- 历史消息列表 -->
        <div v-else class="max-w-4xl mx-auto w-full pb-4">
          <ChatMessage
            v-for="msg in workspaceStore.currentConversation.messages"
            :key="msg.id"
            :message="msg"
            @select-option="handleOptionSelect"
          />
          <section v-for="goal in goalReports" :key="goal.goalRunId" class="my-4 p-4 rounded-xl bg-surface-900 border border-surface-700 text-sm text-surface-200" aria-live="polite">
            <h3 class="font-semibold text-nash-300">目标更新 · {{ goal.status === 'completed' ? '最终报告' : '部分报告' }}</h3>
            <p class="text-xs text-surface-400 mt-1">{{ goal.rootGoal }} · 报告版本 {{ goal.reportRevision }}</p>
            <p v-if="goal.coverageEvaluation" class="text-xs text-surface-400 mt-1">
              覆盖范围：{{ goal.coverageEvaluation.completion === 'completed' ? '全部检查项已取得与执行尝试绑定的验证收据' : '覆盖范围未全部核验，结论仅限已检查部分' }}<span v-if="goal.coverageEvaluation.observedScope?.authorizedRoots?.length"> · 实际检查目录 {{ goal.coverageEvaluation.observedScope.authorizedRoots.join('、') }}</span>
            </p>
            <p class="whitespace-pre-wrap mt-3">{{ goal.finalReport }}</p>
          </section>

          <!-- 实时活动流 / 阶段状态卡片 (仅当当前会话有正在运行的协同活动或任务时显示，杜绝跨会话状态泄漏) -->
          <div
            v-if="workspaceStore.isCurrentConversationRunning || workspaceStore.currentActivity"
            class="my-4 p-3.5 rounded-xl bg-surface-900 border border-nash-500/30 text-xs shadow-sm space-y-2.5 animate-fade-in"
          >
            <div class="flex items-center justify-between text-surface-200">
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full bg-nash-400 animate-pulse"></span>
                <span class="font-semibold text-nash-300">
                  {{ workspaceStore.currentActivity?.detail || 'Nash Agent 正在执行分布式任务...' }}
                </span>
              </div>
              <span class="text-[10px] font-mono text-surface-500">实时协同中</span>
            </div>

            <!-- 分布式多节点/并行分支任务实时状态与进展反馈卡片 (支持多节点并发呈现) -->
            <div
              v-for="task in workspaceStore.currentConversationRunningTasks"
              :key="task.taskId"
              class="p-3 rounded-lg bg-surface-950 border border-purple-500/40 space-y-2 shadow-sm"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full bg-purple-400 animate-ping"></span>
                  <span class="font-mono font-semibold text-purple-300 text-xs">
                    分支任务: {{ task.taskId }}
                  </span>
                </div>
                <div class="flex items-center gap-1.5 font-mono">
                  <span class="px-2 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30 font-semibold">
                    {{ task.nodeId }}
                  </span>
                  <span v-if="task.projectId" class="px-2 py-0.5 rounded text-[10px] bg-surface-800 text-surface-300 border border-surface-700">
                    {{ task.projectId }}
                  </span>
                </div>
              </div>

              <!-- 任务目标 -->
              <p class="text-surface-300 text-[11px] leading-relaxed line-clamp-2 bg-surface-900/60 p-2 rounded border border-surface-800">
                <span class="text-surface-400 font-mono">目标: </span>{{ task.goal }}
              </p>

              <!-- 最新动态 / 进度反馈 -->
              <div v-if="task.resultSummary || task.activitySummary" class="flex items-start gap-1.5 p-2 rounded bg-surface-900 border border-surface-800 font-mono text-[11px] text-surface-200">
                <span class="text-nash-400 font-bold">›</span>
                <span class="whitespace-pre-wrap">{{ task.resultSummary || task.activitySummary }}</span>
              </div>

              <div class="flex items-center justify-between pt-1 border-t border-surface-800/80 text-[11px]">
                <router-link
                  :to="`/tasks/${task.taskId}`"
                  class="text-nash-400 hover:text-nash-300 font-mono flex items-center gap-1 hover:underline"
                >
                  <span>查看实时任务事件时间线 ›</span>
                </router-link>
                <span class="text-surface-400 font-mono text-[10px]">Worker 沙箱运行中</span>
              </div>
            </div>

            <!-- 分布式 Scout 探查节点并行进展状态卡片 -->
            <div
              v-if="workspaceStore.currentActivity?.scoutStates && Object.keys(workspaceStore.currentActivity.scoutStates).length > 0"
              class="pt-2 border-t border-surface-800/80 flex flex-wrap gap-2 text-[11px] font-mono"
            >
              <div
                v-for="(state, node) in workspaceStore.currentActivity.scoutStates"
                :key="node"
                class="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-950 border border-surface-800"
              >
                <span class="text-surface-400">{{ node }}:</span>
                <span
                  :class="[
                    'font-semibold',
                    state === 'running' ? 'text-amber-400 animate-pulse' : state === 'completed' ? 'text-emerald-400' : 'text-rose-400',
                  ]"
                >
                  {{ state === 'running' ? '运行中' : state === 'completed' ? '执行结束' : state === 'failed' ? '失败' : '结果未知，待对账' }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部输入框 -->
      <ChatInputBox />
    </div>

    <!-- 桌面端右侧上下文面板插槽 -->
    <template #context>
      <!-- TaskGraph 选项卡 -->
      <div v-if="uiStore.activeContextTab === 'graph'" class="h-full flex flex-col">
        <div v-if="activeGraph" class="h-full flex flex-col">
          <div class="flex flex-wrap gap-2 items-center justify-between pb-2 mb-2 border-b border-surface-800 text-xs">
            <span class="font-mono text-surface-200 font-semibold truncate min-w-0 flex-1" :title="activeGraph.parentGoal">
              {{ activeGraph.parentGoal }}
            </span>
            <div class="flex items-center gap-2 flex-shrink-0">
              <Badge variant="primary" size="sm">{{ activeGraph.status }}</Badge>
              <router-link
                :to="`/graphs/${activeGraph.graphId}`"
                class="px-2 py-0.5 rounded bg-surface-800 hover:bg-surface-700 text-nash-400 hover:text-nash-300 font-mono text-[11px] flex items-center gap-1 transition-colors border border-surface-700/80"
                title="在独立大图页面全屏查看并交互此 DAG 任务图"
              >
                <span>全屏 DAG</span>
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </router-link>
            </div>
          </div>
          <button v-if="scopedApprovals.length" @click="uiStore.activeContextTab = 'approvals'"
            class="p-2 mb-2 rounded border border-amber-500/40 text-amber-400 text-xs text-left">
            当前任务图有 {{ scopedApprovals.length }} 项待审批，点击处理
          </button>
          <div class="inspector-graph-summary hidden flex-col gap-2">
            <router-link v-for="node in graphsStore.currentNodes" :key="node.nodeId" :to="node.taskId ? `/tasks/${node.taskId}` : `/graphs/${activeGraph.graphId}`"
              class="p-3 rounded-lg border border-surface-800 bg-surface-950 min-w-0 hover:border-surface-600">
              <div class="flex items-center gap-2 text-xs"><span class="font-medium flex-1 min-w-0 truncate" :title="node.title">{{ node.title }}</span><Badge variant="primary" size="sm">{{ node.status }}</Badge></div>
              <p class="text-xs text-surface-400 mt-2 line-clamp-2 break-all">{{ node.resultSummary || node.goal }}</p>
              <span class="inline-block text-[11px] text-nash-400 mt-2">查看详情 ›</span>
            </router-link>
          </div>
          <div class="inspector-graph-canvas flex-1 min-h-[350px] relative rounded-xl border border-surface-800 overflow-hidden">
            <TaskGraphFlow :nodes="graphsStore.currentNodes" :edges="graphsStore.currentEdges" />
          </div>
        </div>
        <TaskExecutionMonitor v-else-if="workspaceStore.currentExecutionTasks.length"
          :tasks="workspaceStore.currentExecutionTasks" :coordinating="workspaceStore.sending" />
        <div v-else-if="workspaceStore.sending" class="p-8 text-center text-xs text-surface-400 space-y-3">
          <div class="inline-block w-6 h-6 border-2 border-nash-500/30 border-t-nash-400 rounded-full animate-spin"></div>
          <p class="font-medium text-surface-200">正在统筹集群任务…</p>
          <p class="text-surface-500 text-[11px]">正在分析目标并同步派发分布式任务，拓扑流即将呈现</p>
        </div>
        <EmptyState
          v-else
          title="当前无活跃任务或任务图"
          description="输入复合任务将生成分布式 DAG，或执行单节点自主任务"
        />
      </div>

      <!-- 产物选项卡 -->
      <div v-else-if="uiStore.activeContextTab === 'artifacts'" class="h-full flex flex-col">
        <div v-if="artifactsStore.scopedArtifacts.length > 0" class="space-y-2 overflow-y-auto">
          <div
            v-for="art in artifactsStore.scopedArtifacts"
            :key="art.artifactId"
            class="p-2.5 rounded-lg bg-surface-950 border border-surface-800 text-xs flex flex-col gap-1 cursor-pointer hover:border-surface-700 transition-colors"
            @click="openArtifactPreview(art)"
          >
            <div class="flex items-center justify-between">
              <span class="font-semibold text-surface-200 truncate">{{ art.name }}</span>
              <span class="text-[10px] text-surface-400 font-mono">{{ formatBytes(art.sizeBytes) }}</span>
            </div>
            <div class="text-[10px] text-surface-400 font-mono truncate">
              生成时间: {{ formatTime(art.createdAt) }}
            </div>
            <div class="text-[10px] text-surface-400 font-mono truncate">
              任务图: {{ art.graphId }} · 节点: {{ art.producerNodeId }}
            </div>
          </div>
        </div>
        <EmptyState
          v-else
          title="暂无生成产物"
          description="仅显示当前任务图的产物；尚未产出时保持为空"
        />
      </div>

      <!-- 待审批选项卡 -->
      <div v-else-if="uiStore.activeContextTab === 'approvals'" class="h-full flex flex-col">
        <div v-if="scopedApprovals.length > 0" class="space-y-3 overflow-y-auto">
          <div
            v-for="appr in scopedApprovals"
            :key="appr.approvalId"
            class="p-3 rounded-xl bg-surface-950 border border-amber-500/40 text-xs space-y-2 shadow-sm"
          >
            <div class="flex items-center justify-between text-amber-400 font-semibold">
              <span class="flex items-center gap-1.5">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                请求权限审批
              </span>
              <span class="font-mono text-[10px] text-surface-400 break-all min-w-0">{{ appr.nodeId }}</span>
            </div>
            <p class="text-surface-300 font-mono text-[11px] bg-surface-900 p-2 rounded">
              目标: {{ appr.target || '未知资源' }}
            </p>
            <div class="flex gap-2 pt-1">
              <button
                @click="approvalsStore.resolve(appr.approvalId, 'allow-once')"
                class="flex-1 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-[11px] transition-colors"
              >
                放行一次
              </button>
              <button
                @click="approvalsStore.resolve(appr.approvalId, 'deny')"
                class="flex-1 py-1 rounded bg-surface-800 hover:bg-surface-700 text-surface-300 font-medium text-[11px] transition-colors"
              >
                拒绝
              </button>
            </div>
          </div>
        </div>
        <EmptyState
          v-else
          title="当前无待处理审批"
          description="跨工作区写入或敏感操作将在此请求授权"
        />
      </div>
    </template>
  </component>

  <!-- 产物预览弹窗 -->
  <Modal v-model="showArtifactModal" :title="`产物预览: ${selectedArtifact?.name || ''}`">
    <div v-if="artifactsStore.previewLoading" class="p-8 text-center text-xs text-surface-400">
      正在加载文件内容...
    </div>
    <div v-else class="space-y-3">
      <div class="flex items-center justify-between text-xs font-mono text-surface-400 pb-2 border-b border-surface-800">
        <span>SHA-256: {{ selectedArtifact?.sha256 }}</span>
        <span>大小: {{ formatBytes(selectedArtifact?.sizeBytes || 0) }}</span>
      </div>
      <div class="text-xs text-surface-400 space-y-1">
        <p>系统记录的生成时间：{{ formatTime(selectedArtifact?.createdAt) }}</p>
        <p>所属任务图：{{ selectedArtifact?.graphId }}</p>
        <p>正文由模型生成，正文中的日期不作为系统时间记录。</p>
      </div>
      <pre class="p-3 rounded-lg bg-surface-950 border border-surface-800 font-mono text-xs overflow-x-auto text-surface-200 max-h-96 whitespace-pre-wrap">{{ artifactsStore.previewContent }}</pre>
    </div>
    <template #footer>
      <a
        v-if="selectedArtifact"
        :href="artifactsStore.getDownloadUrl(selectedArtifact.artifactId)"
        download
        class="px-4 py-2 rounded-lg bg-nash-500 hover:bg-nash-600 text-white font-semibold text-xs transition-colors flex items-center gap-1.5"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        下载文件
      </a>
    </template>
  </Modal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { api } from "../services/api";
import { globalClusterSse } from "../services/sse";
import { useUiStore } from "../stores/ui";
import { useWorkspaceStore } from "../stores/workspace";
import { useGraphsStore } from "../stores/graphs";
import { useArtifactsStore } from "../stores/artifacts";
import { useApprovalsStore } from "../stores/approvals";
import { useI18n } from "../i18n";

import DesktopLayout from "../components/layout/DesktopLayout.vue";

import ChatMessage from "../components/chat/ChatMessage.vue";
import TaskExecutionMonitor from "../components/chat/TaskExecutionMonitor.vue";
import ChatInputBox from "../components/chat/ChatInputBox.vue";
import TaskGraphFlow from "../components/graph/TaskGraphFlow.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import Badge from "../components/ui/Badge.vue";
import Modal from "../components/ui/Modal.vue";

const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();
const graphsStore = useGraphsStore();
const artifactsStore = useArtifactsStore();
const approvalsStore = useApprovalsStore();
const { t } = useI18n();

const scrollContainerRef = ref<HTMLDivElement | null>(null);
const userScrolledUp = ref(false);
const showArtifactModal = ref(false);
const selectedArtifact = ref<any | null>(null);
const goalReports = ref<Array<{ goalRunId: string; rootGoal: string; status: string; reportRevision: number; finalReport: string; coverageEvaluation?: { completion: string; observedScope?: { authorizedRoots: string[] } } }>>([]);
let goalRequest = 0;
async function loadGoalReports(): Promise<void> {
  const conversationId = workspaceStore.currentConversation?.id;
  const request = ++goalRequest;
  if (!conversationId || conversationId === "draft") { goalReports.value = []; return; }
  try {
    const result = await api.request<{ goals: typeof goalReports.value }>("/api/cluster/goal-runs", { params: { conversationId } });
    if (request === goalRequest && workspaceStore.currentConversation?.id === conversationId) goalReports.value = result.goals.filter(goal => Boolean(goal.finalReport));
  } catch { if (request === goalRequest) goalReports.value = []; }
}
watch(() => workspaceStore.currentConversation?.id, () => { goalReports.value = []; void loadGoalReports(); }, { immediate: true });
const unsubscribeGoals = globalClusterSse.subscribe(event => {
  if ((event.type === "goal_run.updated" && event.data?.conversationId === workspaceStore.currentConversation?.id) || event.type === "transport.open" || event.type === "stream.reset") void loadGoalReports();
});
onUnmounted(() => { goalRequest++; unsubscribeGoals(); });

const layoutComponent = computed(() => {
  return DesktopLayout;
});

const quickPrompts = computed(() => [
  t.value.workspace.action1,
  t.value.workspace.action2,
  t.value.workspace.action3,
  t.value.workspace.action4,
]);

const activeGraph = computed(() => {
  if (!workspaceStore.activeGraphId) return null;
  if (graphsStore.currentGraph?.graphId === workspaceStore.activeGraphId) {
    return graphsStore.currentGraph;
  }
  return null;
});

const scopedApprovals = computed(() => {
  const taskIds = new Set(workspaceStore.currentConversation?.linkedTaskIds ?? []);
  if (activeGraph.value) for (const node of graphsStore.currentNodes) if (node.taskId) taskIds.add(node.taskId);
  return approvalsStore.pendingApprovals.filter((approval) => taskIds.has(approval.taskId));
});

watch(() => [workspaceStore.currentConversation?.id, workspaceStore.activeGraphId], () => {
  showArtifactModal.value = false;
  selectedArtifact.value = null;
  void artifactsStore.setGraphScope(workspaceStore.activeGraphId ?? null).catch(() => {});
}, { immediate: true });


onMounted(async () => {
  await Promise.all([
    workspaceStore.loadConversations(),
    approvalsStore.loadApprovals(),
  ]);

  if (workspaceStore.activeGraphId) {
    await graphsStore.loadGraphDetails(workspaceStore.activeGraphId);
  }
  scrollToBottom();
});

watch(
  () => workspaceStore.currentConversation?.messages.length,
  () => {
    if (!userScrolledUp.value) {
      nextTick(() => scrollToBottom());
    }
  }
);

watch(
  () => workspaceStore.activeGraphId,
  async (graphId) => {
    if (graphId) {
      await graphsStore.loadGraphDetails(graphId);
    } else {
      graphsStore.cleanup();
    }
  }
);

function handleUserScroll() {
  if (!scrollContainerRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.value;
  userScrolledUp.value = scrollHeight - (scrollTop + clientHeight) > 80;
}

function scrollToBottom() {
  if (!scrollContainerRef.value) return;
  scrollContainerRef.value.scrollTop = scrollContainerRef.value.scrollHeight;
}

function handleQuickPrompt(text: string) {
  workspaceStore.sendMessage(text);
}

function handleOptionSelect(opt: any) {
  const text = opt.label || opt.id || opt.projectId;
  workspaceStore.sendMessage(text, { optionId: String(opt.id) });
}

async function openArtifactPreview(art: any) {
  selectedArtifact.value = art;
  showArtifactModal.value = true;
  await artifactsStore.loadPreview(art.artifactId);
}

function formatTime(value?: number) {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (北京时间)' : '未知';
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
</script>
