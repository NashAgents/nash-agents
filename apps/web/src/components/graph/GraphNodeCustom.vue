<template>
  <div
    :class="[
      'w-64 rounded-xl border p-3 shadow-card transition-all duration-200 select-none cursor-pointer relative',
      statusBorderClass,
      isSelected ? 'ring-2 ring-nash-500 scale-102' : 'hover:border-surface-600',
    ]"
    @click="$emit('select', nodeData)"
  >
    <!-- Vue Flow 连线锚点 -->
    <Handle type="target" :position="Position.Left" class="!w-2.5 !h-2.5 !bg-surface-500 !border-2 !border-surface-900" />

    <!-- 顶部：节点标题与状态 -->
    <div class="flex items-start justify-between gap-2 mb-2">
      <div class="flex items-center gap-1.5 truncate">
        <StatusDot :status="nodeData?.status" :pulse="nodeData?.status === 'running' || nodeData?.status === 'cancelling'" />
        <h4 class="text-xs font-semibold text-surface-100 truncate" :title="nodeData?.title">
          {{ nodeData?.title || '未命名任务' }}
        </h4>
      </div>
      <Badge :variant="statusBadgeVariant" size="sm">
        {{ statusLabel }}
      </Badge>
    </div>

    <!-- 节点所属目标与操作 -->
    <p class="text-[11px] text-surface-400 line-clamp-2 mb-2.5 font-sans leading-normal">
      {{ nodeData?.goal || '无具体描述' }}
    </p>

    <!-- 元数据行：Worker 节点与项目 -->
    <div class="pt-2 border-t border-surface-800/80 flex items-center justify-between text-[10px] text-surface-400 font-mono gap-1">
      <span class="flex items-center gap-1 truncate max-w-[130px]" :title="`${nodeData?.assignedNodeId || nodeData?.candidateNodeId || 'Auto'} · ${nodeData?.assignedProjectId || nodeData?.candidateProjectId || ''}`">
        <svg class="w-3 h-3 text-surface-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
        <span class="truncate">{{ nodeData?.assignedNodeId || nodeData?.candidateNodeId || 'Auto' }}</span>
      </span>

      <!-- 产物、重试与重规划徽标 -->
      <div class="flex items-center gap-1 shrink-0">
        <span
          v-if="nodeData?.nodeId?.startsWith('Fix_') || nodeData?.nodeId?.startsWith('Retest_')"
          class="px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px]"
          title="动态重规划插入节点"
        >
          Replan
        </span>
        <span
          v-if="nodeData?.attemptCount > 0"
          class="px-1 py-0.2 rounded bg-surface-800 text-surface-300 text-[9px]"
          :title="`重试次数: ${nodeData.attemptCount}/${nodeData.maxRetries ?? 2}`"
        >
          ↻{{ nodeData.attemptCount }}
        </span>
        <span
          v-if="nodeData?.producedArtifacts?.length"
          class="flex items-center gap-0.5 px-1 py-0.2 rounded bg-surface-800 text-surface-300"
          :title="`产生产物: ${nodeData.producedArtifacts.length}`"
        >
          <svg class="w-2.5 h-2.5 text-nash-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          {{ nodeData.producedArtifacts.length }}
        </span>
      </div>
    </div>

    <!-- Vue Flow 输出连线锚点 -->
    <Handle type="source" :position="Position.Right" class="!w-2.5 !h-2.5 !bg-nash-500 !border-2 !border-surface-900" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import StatusDot from "../ui/StatusDot.vue";
import Badge from "../ui/Badge.vue";

interface Props {
  data: any;
  selected?: boolean;
}

const props = defineProps<Props>();
defineEmits(["select"]);

const nodeData = computed(() => props.data ?? {});
const isSelected = computed(() => props.selected);

const statusBorderClass = computed(() => {
  const s = nodeData.value?.status;
  switch (s) {
    case "completed":
      return "border-emerald-500/40 bg-surface-900";
    case "running":
      return "border-purple-500/60 bg-purple-950/20";
    case "waiting_approval":
    case "cancelling":
      return "border-amber-500/60 bg-amber-950/20";
    case "dispatched":
    case "ready":
      return "border-sky-500/40 bg-surface-900";
    case "waiting_dependencies":
      return "border-amber-500/40 bg-surface-900/60 opacity-80";
    case "blocked":
      return "border-surface-700 bg-surface-900/40 opacity-70";
    case "failed":
      return "border-rose-500/50 bg-rose-950/20";
    case "cancelled":
      return "border-surface-700 bg-surface-950 opacity-60";
    default:
      return "border-surface-800 bg-surface-900";
  }
});

const statusBadgeVariant = computed(() => {
  const s = nodeData.value?.status;
  switch (s) {
    case "completed":
      return "success";
    case "running":
      return "purple";
    case "cancelling":
      return "warning";
    case "waiting_dependencies":
      return "warning";
    case "failed":
      return "danger";
    case "ready":
    case "dispatched":
      return "info";
    default:
      return "default";
  }
});

const statusLabel = computed(() => {
  const s = nodeData.value?.status;
  switch (s) {
    case "completed":
      return "已完成";
    case "running":
      return "执行中";
    case "waiting_approval":
      return "等待审批";
    case "cancelling":
      return "取消中";
    case "waiting_dependencies":
      return "等待依赖";
    case "ready":
      return "已就绪";
    case "dispatched":
      return "已派发";
    case "blocked":
      return "已阻断";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已取消";
    default:
      return s || "等待中";
  }
});
</script>
