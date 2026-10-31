<template>
  <div class="border-t border-surface-800 bg-surface-950/90 backdrop-blur-md px-4 py-3 z-20">
    <!-- 运行态状态指示条 (仅当当前会话有正在执行的任务或推理时显示) -->
    <div
      v-if="workspaceStore.isCurrentConversationRunning"
      class="flex items-center justify-between mb-2 px-3 py-1.5 rounded-lg bg-nash-500/10 border border-nash-500/30 text-xs text-nash-700 dark:text-nash-300 animate-fade-in shadow-xs"
    >
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-nash-500 animate-pulse"></span>
        <span class="font-mono font-medium">{{ workspaceStore.executionStatusText }}</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          @click="handleInterrupt"
          :disabled="interrupting"
          class="px-2 py-0.5 rounded bg-surface-200 hover:bg-surface-300 dark:bg-surface-800 dark:hover:bg-surface-700 text-surface-800 dark:text-surface-200 text-[11px] font-mono border border-surface-300 dark:border-surface-700 transition-colors disabled:opacity-50 font-medium"
        >
          {{ interrupting ? "已发送中断" : t.workspace.interrupt }}
        </button>
        <template v-if="!showCancelConfirm">
          <button
            @click="showCancelConfirm = true"
            :disabled="cancelling"
            class="px-2 py-0.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-500/20 dark:hover:bg-rose-500/30 dark:text-rose-300 dark:border-rose-500/30 text-[11px] font-mono border transition-colors disabled:opacity-50 font-medium"
          >
            {{ cancelling ? "正在取消..." : t.workspace.cancel }}
          </button>
        </template>
        <div v-else class="flex items-center gap-1.5 animate-fade-in bg-rose-50 dark:bg-rose-950/80 border border-rose-300 dark:border-rose-500/40 px-2 py-0.5 rounded shadow-sm">
          <span class="text-[11px] text-rose-800 dark:text-rose-200 font-sans font-medium">确认取消?</span>
          <button
            @click="executeCancel"
            :disabled="cancelling"
            class="px-1.5 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-mono transition-colors font-medium shadow-xs"
          >
            确定
          </button>
          <button
            @click="showCancelConfirm = false"
            class="px-1.5 py-0.5 rounded bg-surface-200 hover:bg-surface-300 dark:bg-surface-800 text-surface-700 dark:text-surface-300 hover:text-surface-900 dark:hover:text-white text-[10px] font-mono transition-colors border border-surface-300 dark:border-surface-700"
          >
            返回
          </button>
        </div>
      </div>
    </div>

    <!-- 优化成功撤销条 (Undo Banner) -->
    <div
      v-if="showUndoBanner"
      class="flex items-center justify-between mb-2 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-nash-500/10 border border-emerald-300 dark:border-nash-500/30 text-xs text-emerald-800 dark:text-nash-300 animate-fade-in shadow-sm"
    >
      <div class="flex items-center gap-1.5 truncate mr-2">
        <svg class="w-3.5 h-3.5 text-emerald-600 dark:text-nash-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <span class="font-medium truncate">{{ t.workspace.optimizedSuccess }}，可检查确认或继续编辑</span>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <button
          @click="handleUndoOptimize"
          class="px-2 py-0.5 rounded bg-white hover:bg-emerald-100 dark:bg-surface-800 dark:hover:bg-surface-700 text-emerald-700 dark:text-nash-300 hover:text-emerald-900 dark:hover:text-white text-[11px] font-mono border border-emerald-300 dark:border-surface-700/80 transition-colors flex items-center gap-1 active:scale-95 font-medium shadow-xs"
          title="恢复优化前的原始草稿"
        >
          <span>↶ {{ t.workspace.undoOptimize }}</span>
        </button>
        <button
          @click="showUndoBanner = false"
          class="text-surface-400 hover:text-surface-600 dark:hover:text-surface-200 p-0.5 transition-colors"
          title="关闭提示"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 优化错误或提交错误提示 -->
    <div
      v-if="optimizeError || controlError || workspaceStore.submissionError"
      role="alert"
      class="flex items-center justify-between mb-2 px-3 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-300 dark:border-rose-500/30 text-xs text-rose-800 dark:text-rose-300 animate-fade-in shadow-sm"
    >
      <div class="flex items-center gap-1.5 truncate mr-2">
        <svg class="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="truncate font-medium">{{ optimizeError || controlError || workspaceStore.submissionError }}</span>
      </div>
      <button
        @click="clearErrors"
        class="text-surface-400 hover:text-surface-600 dark:hover:text-surface-200 p-0.5 flex-shrink-0"
        title="关闭"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- 项目上下文卡片 (仅当从 Project Explorer 发起任务时挂载) -->
    <div
      v-if="workspaceStore.selectedProjectContext"
      class="flex items-center justify-between mb-2 px-3 py-1.5 rounded-lg bg-surface-900 border border-nash-500/30 text-xs text-surface-200 shadow-xs animate-fade-in"
    >
      <div class="flex items-center gap-2 truncate mr-2">
        <span class="text-nash-400 font-mono font-bold">◈</span>
        <span class="font-medium text-surface-100 truncate">
          目标上下文：{{ workspaceStore.selectedProjectContext.projectName }}
        </span>
        <span class="text-[10px] font-mono text-surface-400 bg-surface-800 px-1.5 py-0.2 rounded border border-surface-700/60">
          {{ workspaceStore.selectedProjectContext.nodeName || workspaceStore.selectedProjectContext.nodeId }}
        </span>
      </div>
      <button
        @click="workspaceStore.clearProjectContext()"
        class="text-surface-400 hover:text-surface-200 text-xs font-mono px-1.5 py-0.5 rounded hover:bg-surface-800 transition-colors"
        title="清除项目上下文，恢复全局集群调度"
      >
        ✕ 清除
      </button>
    </div>

    <!-- 输入容器：双横线经典布局 + 优化流光状态 -->
    <div
      :class="[
        'relative bg-surface-900 border rounded-xl shadow-sm transition-all',
        isOptimizing
          ? 'border-nash-500/80 ring-1 ring-nash-500/50 bg-gradient-to-r from-surface-900 via-nash-950/40 to-surface-900 animate-shimmer-flow'
          : 'border-surface-700/80 focus-within:border-nash-500/80 focus-within:ring-1 focus-within:ring-nash-500/50',
      ]"
    >
      <textarea
        ref="textareaRef"
        v-model="inputText"
        :rows="rows"
        :readonly="isOptimizing"
        :placeholder="placeholderText"
        :class="[
          'w-full bg-transparent text-surface-100 placeholder-surface-500 px-3.5 pt-3 pb-10 text-sm resize-none focus:outline-none leading-relaxed font-sans transition-opacity',
          isOptimizing ? 'cursor-wait select-text opacity-90' : '',
        ]"
        @keydown="handleKeyDown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      ></textarea>

      <!-- 底部操作栏 -->
      <div class="absolute bottom-2 inset-x-3 flex items-center justify-between">
        <!-- 左侧状态提示 -->
        <div class="flex items-center gap-1.5 text-[11px] font-mono">
          <template v-if="isOptimizing">
            <div class="flex items-center gap-1.5 text-nash-600 dark:text-nash-400 font-medium animate-pulse">
              <span class="w-2 h-2 rounded-full bg-nash-500 animate-ping"></span>
              <span>{{ t.workspace.optimizing }}</span>
              <button
                type="button"
                @click="cancelOptimize"
                class="ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono text-surface-600 hover:text-surface-900 dark:text-surface-400 dark:hover:text-surface-100 bg-surface-200 hover:bg-surface-300 dark:bg-surface-800 transition-colors border border-surface-300 dark:border-surface-700/50 font-medium"
                title="取消优化 (Esc)"
              >
                {{ t.workspace.cancelOptimize }} (Esc)
              </button>
            </div>
          </template>
          <template v-else>
            <span class="text-surface-500 hidden sm:inline">Enter {{ t.workspace.send }} · Shift+Enter 换行</span>
          </template>
        </div>

        <!-- 右侧操作按钮组 -->
        <div class="flex items-center gap-2 ml-auto">
          <!-- 运行态 Steer 按钮 -->
          <button
            v-if="isRunning && inputText.trim() && !isOptimizing"
            type="button"
            @click="handleSteer"
            class="px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-500/20 hover:bg-amber-100 dark:hover:bg-amber-500/30 text-amber-800 dark:text-amber-300 font-medium text-xs border border-amber-300 dark:border-amber-500/40 transition-colors flex items-center gap-1 active:scale-95 shadow-xs"
          >
            <span>⇥ {{ t.workspace.steer }}</span>
          </button>

          <!-- AI 提示词优化按钮 (AI Prompt Optimizer) -->
          <button
            type="button"
            :disabled="!inputText.trim() || isOptimizing || isSendingCurrent"
            @click="handleOptimizePrompt"
            :class="[
              'p-1.5 rounded-lg text-xs flex items-center justify-center transition-all shadow-sm focus:outline-none focus:ring-1 focus:ring-nash-500/50 relative group',
              isOptimizing
                ? 'bg-nash-500/20 text-nash-600 dark:text-nash-300 border border-nash-500/50 animate-pulse-subtle'
                : inputText.trim() && !isSendingCurrent
                ? 'text-surface-600 dark:text-surface-300 hover:text-nash-600 dark:hover:text-nash-300 hover:bg-nash-500/10 border border-surface-300 dark:border-surface-700/60 hover:border-nash-500/40 active:scale-95'
                : 'text-surface-400 dark:text-surface-600 bg-transparent border border-transparent cursor-not-allowed opacity-40',
            ]"
            :title="isOptimizing ? t.workspace.optimizing : t.workspace.optimizePrompt"
            :aria-label="t.workspace.optimizePrompt"
          >
            <!-- 加载中 Spinner -->
            <svg
              v-if="isOptimizing"
              class="w-4 h-4 text-nash-400 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            <!-- Sparkles 正式矢量图标 -->
            <svg
              v-else
              class="w-4 h-4 transition-transform group-hover:scale-110"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
              <path d="M5 3v4" />
              <path d="M19 17v4" />
              <path d="M3 5h4" />
              <path d="M17 19h4" />
            </svg>
          </button>

          <!-- 发送按钮 -->
          <button
            type="button"
            :disabled="!inputText.trim() || isSendingCurrent || isOptimizing"
            @click="submit"
            :class="[
              'px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm',
              inputText.trim() && !isSendingCurrent && !isOptimizing
                ? 'bg-nash-500 hover:bg-nash-600 text-white active:scale-95'
                : 'bg-surface-800 text-surface-500 cursor-not-allowed border border-surface-700/50',
            ]"
          >
            <span v-if="isSendingCurrent" class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
            <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
            <span>{{ t.workspace.send }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import { useWorkspaceStore } from "../../stores/workspace";
import { useClusterStore } from "../../stores/cluster";
import { useTasksStore } from "../../stores/tasks";
import { useGraphsStore } from "../../stores/graphs";
import { useI18n } from "../../i18n";
import { api } from "../../services/api";

const workspaceStore = useWorkspaceStore();
const clusterStore = useClusterStore();
const tasksStore = useTasksStore();
const graphsStore = useGraphsStore();
const { t } = useI18n();

const inputText = ref("");
const isComposing = ref(false); // 关键：输入法中状态锁
let compositionTimer: any = null;
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const interrupting = ref(false);
const cancelling = ref(false);
const showCancelConfirm = ref(false);
const controlError = ref("");

// AI 提示词优化相关响应式状态
const isOptimizing = ref(false);
const optimizeError = ref("");
const showUndoBanner = ref(false);
const lastOptimizedOriginal = ref<string | null>(null);
let activeOptimizeRequestId = 0;
let optimizeAbortController: AbortController | null = null;

const isRunning = computed(() => {
  return workspaceStore.isCurrentConversationRunning;
});

const isSendingCurrent = computed(() => {
  return workspaceStore.sending && workspaceStore.activeSendingConvId === workspaceStore.currentConversation?.id;
});

const placeholderText = computed(() => {
  return t.value.workspace.inputPlaceholder;
});

const rows = computed(() => {
  const lineCount = (inputText.value.match(/\n/g) || []).length + 1;
  return Math.min(Math.max(lineCount, 2), 6);
});

function clearErrors() {
  optimizeError.value = "";
  controlError.value = "";
  workspaceStore.submissionError = "";
}

function handleCompositionStart() {
  isComposing.value = true;
  if (compositionTimer) {
    clearTimeout(compositionTimer);
    compositionTimer = null;
  }
}

function handleCompositionEnd() {
  // 关键防抖：macOS 拼音输入法在按 Enter 确认拼音时，compositionend 触发时机比 keydown(Enter) 略早
  // 必须延迟 60ms 释放锁，彻底屏蔽选词回车击穿触发消息提交！
  compositionTimer = setTimeout(() => {
    isComposing.value = false;
    compositionTimer = null;
  }, 60);
}

function handleKeyDown(e: KeyboardEvent) {
  // 优化中响应 Esc 取消
  if (isOptimizing.value) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelOptimize();
      return;
    }
    // 优化中禁止 Enter 发送
    if (e.key === "Enter") {
      e.preventDefault();
      return;
    }
  }

  // 若输入法正在输入、组合中、或处于 229 候选词代码状态，严禁提交
  if (isComposing.value || e.isComposing || (e as any).keyCode === 229) {
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

/**
 * 触发 AI 提示词优化
 */
async function handleOptimizePrompt() {
  const text = inputText.value.trim();
  if (!text || isOptimizing.value || isSendingCurrent.value) return;

  // 1. 记录原始草稿快照以供撤销
  lastOptimizedOriginal.value = inputText.value;
  showUndoBanner.value = false;
  optimizeError.value = "";
  clearErrors();

  // 2. 锁定并进入 OPTIMIZING 状态
  isOptimizing.value = true;
  const requestId = ++activeOptimizeRequestId;
  optimizeAbortController = new AbortController();

  try {
    const res = await api.optimizePrompt(
      text,
      workspaceStore.currentConversation?.id,
      optimizeAbortController.signal
    );

    // 防竞态检查：若该请求期间已被取消或被新请求覆盖，坚决不写入草稿
    if (requestId !== activeOptimizeRequestId) return;

    if (res && res.optimizedText) {
      inputText.value = res.optimizedText;
      showUndoBanner.value = true;
    } else {
      throw new Error("优化结果返回为空");
    }
  } catch (err: any) {
    // 若为主动取消，则静默恢复，不显示报错红条
    if (
      optimizeAbortController?.signal.aborted ||
      err.name === "AbortError" ||
      String(err.message || "").includes("取消") ||
      String(err.message || "").includes("aborted")
    ) {
      return;
    }
    // 保留原始草稿，仅展示明确错误
    optimizeError.value = err.message || "提示词优化失败，请稍后重试";
  } finally {
    if (requestId === activeOptimizeRequestId) {
      isOptimizing.value = false;
      optimizeAbortController = null;
      nextTick(() => {
        textareaRef.value?.focus();
      });
    }
  }
}

/**
 * 取消当前正在进行的提示词优化
 */
function cancelOptimize() {
  activeOptimizeRequestId++;
  if (optimizeAbortController) {
    optimizeAbortController.abort();
    optimizeAbortController = null;
  }
  isOptimizing.value = false;
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

/**
 * 撤销优化，恢复原始草稿
 */
function handleUndoOptimize() {
  if (lastOptimizedOriginal.value !== null) {
    inputText.value = lastOptimizedOriginal.value;
    lastOptimizedOriginal.value = null;
  }
  showUndoBanner.value = false;
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

async function submit() {
  if (isOptimizing.value) return;
  const text = inputText.value.trim();
  if (!text || isSendingCurrent.value) return;

  // 1. 同步立即清空输入框与重置状态，杜绝任何视觉残留或连击重入
  inputText.value = "";
  showUndoBanner.value = false;
  lastOptimizedOriginal.value = null;
  clearErrors();

  if (textareaRef.value) {
    textareaRef.value.style.height = "auto";
  }

  // 2. 发送消息（若有选定的项目上下文，智能作为上下文前缀传递给 Coordinator）
  let messageContent = text;
  if (workspaceStore.selectedProjectContext) {
    const ctx = workspaceStore.selectedProjectContext;
    messageContent = `[目标项目: ${ctx.projectName} (${ctx.projectId}) @ ${ctx.nodeName || ctx.nodeId}]\n\n${text}`;
    workspaceStore.clearProjectContext();
  }
  const sent = await workspaceStore.sendMessage(messageContent);
  if (!sent && !inputText.value) inputText.value = text;
}

async function handleSteer() {
  if (isOptimizing.value) return;
  const text = inputText.value.trim();
  if (!text) return;

  // 立即清空输入框
  inputText.value = "";
  showUndoBanner.value = false;
  lastOptimizedOriginal.value = null;
  clearErrors();

  if (textareaRef.value) {
    textareaRef.value.style.height = "auto";
  }

  controlError.value = "";
  try {
    if (workspaceStore.activeGraphId) await graphsStore.steer(workspaceStore.activeGraphId, text);
    else if (workspaceStore.activeTaskId) await tasksStore.steer(workspaceStore.activeTaskId, text);
    else throw new Error("协调器仍在分析目标，暂时没有可调整的远程任务");
  } catch (err: any) {
    controlError.value = err.message || "调整失败，请重试";
    if (!inputText.value) inputText.value = text;
  }
}

async function handleInterrupt() {
  interrupting.value = true;
  controlError.value = "";
  try {
    await workspaceStore.interruptCurrentExecution();
  } catch (err: any) {
    controlError.value = err.message || String(err);
  } finally {
    setTimeout(() => {
      interrupting.value = false;
    }, 2000);
  }
}

async function executeCancel() {
  showCancelConfirm.value = false;
  cancelling.value = true;
  controlError.value = "";
  try {
    await workspaceStore.cancelCurrentExecution();
  } catch (err: any) {
    controlError.value = err.message || String(err);
  } finally {
    cancelling.value = false;
  }
}
</script>
