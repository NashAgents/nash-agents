<template>
  <div :class="['w-full transition-all duration-150', isUser ? 'my-3' : 'my-4']">
    <!-- 1. 用户消息：平直通栏深灰卡片 -->
    <div
      v-if="isUser"
      class="w-full user-message-card rounded-lg px-4 py-3.5 shadow-sm border border-surface-700/60"
    >
      <div class="flex items-center justify-between mb-1.5 text-[11px] text-surface-400 font-mono">
        <span class="flex items-center gap-1.5 text-nash-400 font-semibold">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          User
        </span>
        <span>{{ formatTime(message.timestamp) }}</span>
      </div>
      <div
        class="nash-markdown select-text font-sans font-medium text-surface-100"
        v-html="renderedContent"
      ></div>
    </div>

    <!-- 2. Assistant 消息 / 系统活动 -->
    <div
      v-else
      class="w-full assistant-message-card rounded-xl p-4 md:p-5 my-3 space-y-3 transition-all"
    >
      <!-- 头部标识与操作条 -->
      <div class="flex items-center justify-between pb-2.5 border-b border-surface-800/60 text-[11px] text-surface-400 font-mono">
        <div class="flex items-center gap-2">
          <div class="w-5 h-5 rounded-md bg-nash-500/15 border border-nash-500/30 flex items-center justify-center text-nash-400 text-[10px] font-bold shadow-sm">
            N
          </div>
          <span class="text-surface-100 font-semibold tracking-wide">Nash Agent</span>
          <span v-if="message.metadata?.reportKind === 'interim'" class="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">阶段性报告</span>
          <span v-if="message.messageType && message.messageType !== 'text'" class="text-[10px] px-1.5 py-0.2 rounded bg-surface-800 text-surface-400 uppercase font-mono">
            {{ message.messageType }}
          </span>
          <span v-if="message.metadata?.source === 'worker_deliverable'" class="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
            Worker Deliverable
          </span>
        </div>
        <div class="flex items-center gap-3">
          <span>{{ formatTime(message.timestamp) }}</span>
          <button
            @click="copyMessage"
            class="flex items-center gap-1 text-[11px] text-surface-400 hover:text-surface-200 px-2 py-0.5 rounded hover:bg-surface-800 transition-colors font-mono cursor-pointer"
            :title="copied ? '已复制' : '复制内容'"
          >
            <svg v-if="!copied" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <svg v-else class="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span :class="copied ? 'text-emerald-400 font-medium' : ''">{{ copied ? '已复制' : '复制' }}</span>
          </button>
        </div>
      </div>

      <!-- 路由决策卡片 -->
      <div
        v-if="message.messageType === 'routing_decision' && message.metadata?.candidate"
        class="bg-surface-900 border border-surface-800 rounded-lg p-3 text-xs space-y-1.5 my-1"
      >
        <div class="flex items-center justify-between font-semibold text-surface-200">
          <span class="flex items-center gap-1.5 text-nash-400">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            路由选定目标
          </span>
          <span class="font-mono text-emerald-400">
            Score: {{ (message.metadata.candidate.score * 100).toFixed(0) }}%
          </span>
        </div>
        <div class="grid grid-cols-2 gap-2 text-surface-400 pt-1 border-t border-surface-800/60 font-mono text-[11px]">
          <div>Node: <span class="text-surface-200">{{ message.metadata.candidate.nodeId }}</span></div>
          <div>Project: <span class="text-surface-200">{{ message.metadata.candidate.projectId }}</span></div>
        </div>
      </div>

      <!-- 任务图生成卡片 -->
      <div
        v-if="message.messageType === 'graph_planning' && message.metadata?.graphId"
        class="bg-surface-900 border border-nash-500/30 rounded-lg p-3 text-xs space-y-2 my-1"
      >
        <div class="flex items-center justify-between font-semibold text-surface-200">
          <span class="flex items-center gap-1.5 text-nash-400">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            分布式任务图已启动 ({{ message.metadata.nodeCount }} 阶段)
          </span>
          <router-link
            :to="`/graphs/${message.metadata.graphId}`"
            class="text-nash-400 hover:text-nash-300 underline font-mono text-[11px]"
          >
            查看 DAG 可视化 →
          </router-link>
        </div>
      </div>

      <!-- 人机澄清选项卡片 (Phase 6 / Human-in-the-Loop Clarification) -->
      <div
        v-if="message.messageType === 'clarification' && message.metadata?.pendingClarification?.options?.length"
        class="bg-surface-900 border border-amber-500/30 rounded-lg p-3 text-xs space-y-2 my-2 shadow-sm"
      >
        <div class="flex items-center gap-1.5 font-semibold text-amber-400">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {{ message.metadata.pendingClarification.question || '请选择目标资源推进执行:' }}
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
          <button
            v-for="(opt, idx) in message.metadata.pendingClarification.options"
            :key="opt.id || idx"
            @click="emit('selectOption', opt)"
            class="p-2.5 rounded-lg bg-surface-950 border border-surface-700/80 hover:border-nash-500 hover:bg-surface-800 transition-all text-left flex flex-col justify-between group cursor-pointer"
          >
            <div class="font-semibold text-surface-200 group-hover:text-nash-300 transition-colors">
              {{ opt.label || opt.id }}
            </div>
            <div class="text-[11px] text-surface-400 font-mono mt-1 flex items-center justify-between">
              <span>节点: {{ opt.nodeId }}</span>
              <span v-if="opt.projectId">项目: {{ opt.projectId }}</span>
            </div>
            <div v-if="opt.details" class="text-[10px] text-surface-400 mt-1 line-clamp-2">
              {{ opt.details }}
            </div>
          </button>
        </div>
      </div>

      <!-- 普通 Markdown 正文 -->
      <div
        class="nash-markdown select-text"
        v-html="renderedContent"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { renderMarkdown } from "../../services/markdown";
import type { MessageItem } from "../../stores/workspace";

// 启用 GitHub Flavored Markdown 与自然换行


interface Props {
  message: MessageItem;
}

const props = defineProps<Props>();
const emit = defineEmits<{ (e: "selectOption", option: any): void }>();
const isUser = computed(() => props.message.sender === "user");
const copied = ref(false);

const renderedContent = computed(() => renderMarkdown(props.message.content || ""));

function formatTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function copyMessage() {
  try {
    await navigator.clipboard.writeText(props.message.content);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {}
}
</script>
