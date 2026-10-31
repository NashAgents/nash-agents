<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-5xl mx-auto w-full">
      <!-- 顶栏返回与面包屑导航 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-surface-800 mb-4">
        <div class="flex flex-wrap items-center gap-2 text-xs font-mono">
          <router-link
            to="/tasks"
            class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-900 border border-surface-700 text-surface-300 hover:text-surface-100 hover:bg-surface-800 transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span>返回任务列表</span>
          </router-link>

          <span v-if="associatedConversation" class="text-surface-600">/</span>

          <!-- 直达发起会话 -->
          <button
            v-if="associatedConversation"
            @click="goToAssociatedConversation"
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-nash-500/10 border border-nash-500/30 text-nash-300 hover:bg-nash-500/20 transition-colors truncate max-w-[280px]"
            title="直达发起该任务的会话"
          >
            <svg class="w-3.5 h-3.5 text-nash-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <span class="truncate">会话: {{ associatedConversation.title }}</span>
            <span class="text-nash-400">›</span>
          </button>
        </div>

        <!-- 任务状态与控制按钮 (中断/取消，保证 flex-shrink-0 不被挤压) -->
        <div class="flex items-center gap-2 flex-shrink-0">
          <Badge v-if="tasksStore.currentTask" :variant="getStatusVariant(tasksStore.currentTask.status)" size="md">
            {{ tasksStore.currentTask.status }}
          </Badge>
          <button
            v-if="canInterrupt"
            :disabled="controlPending"
            @click="handleInterrupt"
            class="px-2.5 py-1 rounded-lg bg-surface-900 border border-surface-700 hover:bg-surface-800 text-surface-200 text-xs font-mono transition-colors whitespace-nowrap"
          >
            {{ t.workspace.interrupt }}
          </button>
          <button
            v-if="canCancel"
            :disabled="controlPending"
            @click="handleCancel"
            class="px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 hover:bg-rose-500/20 text-rose-300 text-xs font-mono transition-colors whitespace-nowrap"
          >
            {{ t.workspace.cancel }}
          </button>
        </div>
      </div>

      <p v-if="tasksStore.loading" role="status" class="text-surface-400 mb-4">正在加载任务…</p>
      <p v-if="tasksStore.error" role="alert" class="text-rose-400 mb-4">{{ tasksStore.error }}</p>
      <p v-if="controlError" role="alert" class="text-rose-400 mb-4">{{ controlError }}</p>
      <!-- 任务目标与元数据卡片 (美观卡片化布局，彻底消除挤压变形) -->
      <div class="mb-5 p-4 rounded-xl bg-surface-900 border border-surface-800 shadow-sm space-y-3">
        <h2 class="text-sm sm:text-base font-semibold text-surface-100 leading-relaxed break-words">
          {{ tasksStore.currentTask?.goal || '任务详情' }}
        </h2>
        <div class="flex flex-wrap items-center gap-2 pt-2 border-t border-surface-800/80 text-xs text-surface-400 font-mono">
          <span class="px-2 py-0.5 rounded bg-surface-950 border border-surface-800 flex items-center gap-1">
            <span class="text-surface-500">Task ID:</span>
            <span class="text-surface-200">{{ tasksStore.currentTask?.taskId }}</span>
          </span>
          <span class="px-2 py-0.5 rounded bg-surface-950 border border-surface-800 flex items-center gap-1">
            <span class="text-surface-500">节点:</span>
            <span class="text-surface-200">{{ tasksStore.currentTask?.nodeId }}</span>
          </span>
          <span class="px-2 py-0.5 rounded bg-surface-950 border border-surface-800 flex items-center gap-1">
            <span class="text-surface-500">项目:</span>
            <span class="text-surface-200">{{ tasksStore.currentTask?.projectId }}</span>
          </span>
          <span v-if="(tasksStore.currentTask as any)?.activeGrant" class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold flex items-center gap-1">
            <span>全访问 · 安全模型审查</span>
          </span>
          <button
            v-if="(tasksStore.currentTask as any)?.activeGrant"
            type="button"
            class="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/40 font-semibold hover:bg-rose-500/20 disabled:opacity-50"
            :disabled="revokePending"
            @click="handleRevokeGrant"
          >
            {{ revokePending ? '撤销中…' : '撤销全访问' }}
          </button>
          <span v-if="tasksStore.currentTask?.createdAt" class="text-surface-500 ml-auto">
            {{ formatTime(tasksStore.currentTask.createdAt) }}
          </span>
        </div>
      </div>

      <!-- 最终产物/答案卡片 -->
      <div v-if="tasksStore.currentTask?.finalAnswer" class="mb-6 p-4 rounded-xl bg-surface-900 border border-emerald-500/30 shadow-sm space-y-2">
        <h3 class="text-xs font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          执行最终结果 (Final Answer)
        </h3>
        <div class="markdown-body text-sm text-surface-200 leading-relaxed font-sans bg-surface-950 p-3 rounded-lg border border-surface-800" v-html="renderMarkdown(tasksStore.currentTask.finalAnswer)"></div>
      </div>

      <!-- 运行态 Steer 悬浮输入条 -->
      <div v-if="tasksStore.currentTask?.status === 'running'" class="mb-5 p-3 rounded-xl bg-surface-900 border border-amber-500/30 space-y-2 shadow-sm">
        <div class="flex items-center gap-2">
          <input
            v-model="steerText"
            type="text"
            placeholder="向正在运行中的 Worker 发送实时 Steer 调整指令（如：别探测了，停一下）..."
            class="flex-1 bg-surface-950 border border-surface-700 px-3.5 py-2 rounded-lg text-xs text-surface-100 focus:outline-none focus:border-amber-500 font-sans"
            :disabled="steerSending"
            @keydown.enter="handleSteer"
          />
          <button
            @click="handleSteer"
            :disabled="!steerText.trim() || steerSending"
            class="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-black text-xs font-semibold disabled:opacity-40 transition-colors flex items-center gap-1.5 shadow-sm flex-shrink-0"
          >
            <span v-if="steerSending" class="w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin"></span>
            <span>发送 Steer</span>
          </button>
        </div>
        <!-- 成功或错误提示 -->
        <p v-if="steerFeedback" :class="['text-[11px] font-mono px-1', steerFeedback.isError ? 'text-rose-400' : 'text-emerald-400']">
          {{ steerFeedback.text }}
        </p>
      </div>

      <!-- 事件流时间线 (Activity Timeline) -->
      <div class="space-y-3">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wider font-mono">
          执行活动时间线 (Event Timeline · {{ tasksStore.currentEvents.length }} 条记录)
        </h3>

        <div class="space-y-2">
          <div
            v-for="(evt, i) in tasksStore.currentEvents"
            :key="i"
            class="p-3 rounded-lg bg-surface-900/60 border border-surface-800 text-xs flex flex-col gap-1.5 font-mono"
          >
            <div class="flex items-center justify-between text-[11px]">
              <span class="text-nash-400 font-bold flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-nash-500"></span>
                {{ evt.eventType }}
              </span>
              <span class="text-surface-400 font-sans">{{ formatTime(getEventTime(evt)) }}</span>
            </div>
            <pre class="text-[11px] text-surface-200 bg-surface-950/90 p-2.5 rounded-lg border border-surface-800/80 overflow-x-auto whitespace-pre-wrap leading-relaxed">{{ formatPayload(getEventPayload(evt)) }}</pre>
          </div>
        </div>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useUiStore } from "../stores/ui";
import { useTasksStore } from "../stores/tasks";
import { useWorkspaceStore } from "../stores/workspace";
import { useI18n } from "../i18n";

import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

import { renderMarkdown } from "../services/markdown";
import Badge from "../components/ui/Badge.vue";

const uiStore = useUiStore();
const tasksStore = useTasksStore();
const workspaceStore = useWorkspaceStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const controlPending = ref(false);
const revokePending = ref(false);
const controlError = ref("");
const canInterrupt = computed(() => tasksStore.currentTask?.status === "running");
const canCancel = computed(() => ["created", "queued", "dispatched", "accepted", "running", "waiting_approval", "outcome_unknown"].includes(tasksStore.currentTask?.status));
const steerText = ref("");
const steerSending = ref(false);
const steerFeedback = ref<{ text: string; isError: boolean } | null>(null);

const associatedConversation = computed(() => {
  const currentId = tasksStore.currentTask?.taskId;
  if (!currentId) return null;
  return workspaceStore.conversations.find((c) => c.linkedTaskIds?.includes(currentId)) || null;
});

function goToAssociatedConversation() {
  if (associatedConversation.value) {
    workspaceStore.selectConversation(associatedConversation.value.id);
    router.push("/");
  }
}

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

watch(() => route.params.id, async (id) => {
  const taskId = String(id);
  steerText.value = "";
  steerFeedback.value = null;
  controlError.value = "";
  if (workspaceStore.conversations.length === 0) {
    workspaceStore.loadConversations().catch(() => {});
  }
  await tasksStore.loadTaskDetails(taskId);
}, { immediate: true });

onUnmounted(() => {
  tasksStore.cleanup();
});

async function handleSteer() {
  const text = steerText.value.trim();
  if (!text || !tasksStore.currentTask || steerSending.value) return;
  steerSending.value = true;
  steerFeedback.value = null;
  try {
    await tasksStore.steer(tasksStore.currentTask.taskId, text);
    steerText.value = "";
    steerFeedback.value = { text: "✓ Steer 调整指令已成功发送至执行节点！", isError: false };
    setTimeout(() => {
      steerFeedback.value = null;
    }, 4000);
  } catch (err: any) {
    steerFeedback.value = { text: `Steer 发送失败: ${err.message || String(err)}`, isError: true };
  } finally {
    steerSending.value = false;
  }
}

async function control(action: "interrupt" | "cancel") {
  const taskId = tasksStore.currentTask?.taskId;
  if (!taskId || controlPending.value) return;
  controlPending.value = true;
  controlError.value = "";
  try {
    const result = await tasksStore[action](taskId);
    if (result?.success === false) throw new Error(result.message || "执行节点未确认操作");
    if (String(route.params.id) === taskId) await tasksStore.loadTaskDetails(taskId);
  } catch (error) {
    if (String(route.params.id) === taskId) controlError.value = error instanceof Error ? error.message : String(error);
  } finally { controlPending.value = false; }
}
async function handleRevokeGrant() {
  const taskId = tasksStore.currentTask?.taskId;
  const grantId = (tasksStore.currentTask as any)?.activeGrant?.grantId;
  if (!taskId || !grantId || revokePending.value) return;
  if (!confirm("确定撤销此任务的全访问授权吗？撤销后该任务立即回到工作区写入 + 网络拒绝策略。")) return;
  revokePending.value = true;
  controlError.value = "";
  try {
    const result = await tasksStore.revokeGrant(taskId, grantId);
    // 只有 Worker 真实 ACK 才算撤销完成；未确认时必须如实提示，不能刷新成"已撤销"。
    if (result?.confirmed === false) throw new Error(result.message || "Worker 尚未确认撤销，授权可能仍然生效");
    if (String(route.params.id) === taskId) await tasksStore.loadTaskDetails(taskId);
  } catch (error) {
    controlError.value = error instanceof Error ? error.message : String(error);
  } finally { revokePending.value = false; }
}
async function handleInterrupt() { await control("interrupt"); }
async function handleCancel() {
  if (confirm("确定要取消此任务吗？")) await control("cancel");
}

function getEventTime(evt: any): number {
  return evt?.createdAt ?? evt?.timestamp ?? 0;
}

function getEventPayload(evt: any): any {
  return evt?.payload ?? evt?.data ?? {};
}

function formatTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatPayload(payload: any) {
  if (!payload || (typeof payload === "object" && Object.keys(payload).length === 0)) {
    return "{ /* 无附加参数 */ }";
  }
  try {
    return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function getStatusVariant(status: string) {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "purple";
    case "waiting_approval":
      return "warning";
    case "failed":
      return "danger";
    case "dispatched":
    case "accepted":
      return "info";
    default:
      return "default";
  }
}
</script>
