<template>
  <section aria-label="会话任务监控" class="flex flex-col min-h-0 rounded-xl border border-surface-800 bg-surface-950 overflow-hidden">
    <div class="p-4 border-b border-surface-800 space-y-2">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-surface-100">{{ summary.title }}</h3>
        <Badge :variant="summary.status.variant">{{ summary.status.label }}</Badge>
      </div>
      <p class="text-xs text-surface-400">{{ summary.groups.length }} 个节点 · {{ tasks.length }} 个任务</p>
      <p class="text-xs text-surface-300" aria-live="polite">
        已完成 {{ summary.completed }}/{{ tasks.length }}<span v-if="summary.failed"> · 失败 {{ summary.failed }}</span>
      </p>
    </div>
    <div class="inspector-task-grid overflow-y-auto p-3 gap-3 flex flex-col">
      <section v-for="group in summary.groups" :key="group.nodeId" :aria-label="`节点 ${group.nodeId}`" class="rounded-lg border border-surface-800 bg-surface-900 p-3 space-y-3 min-w-0">
        <div>
          <h4 class="text-sm font-semibold text-surface-200 break-words">{{ nodeName(group.nodeId) }}</h4>
          <p class="inspector-secondary text-xs text-surface-400 font-mono break-all mt-1">{{ group.nodeId }}</p>
        </div>
        <article v-for="task in group.tasks" :key="task.taskId" class="border-t border-surface-800 pt-3 space-y-2 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-surface-400 break-all">{{ task.projectId || '项目待确认' }}</span>
            <Badge :variant="taskStatus(task.status).variant" class="shrink-0">{{ taskStatus(task.status).label }}</Badge>
          </div>
          <p class="text-xs text-surface-200 leading-relaxed break-words">{{ task.goal || '正在读取任务信息…' }}</p>
          <p v-if="task.error || task.activitySummary || task.resultSummary" class="inspector-summary text-xs text-surface-300 leading-relaxed break-words">{{ task.error || task.activitySummary || task.resultSummary }}</p>
          <router-link :to="`/tasks/${task.taskId}`" :aria-label="`查看任务 ${task.taskId}`"
            class="min-h-11 inline-flex items-center text-xs text-nash-400 hover:text-nash-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-nash-500 rounded">
            查看任务与事件时间线 ›
          </router-link>
        </article>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Badge from "../ui/Badge.vue";
import { useClusterStore } from "../../stores/cluster";
import { executionSummary, taskStatus, type ExecutionTask } from "../../services/task-monitor";
const props = defineProps<{ tasks: ExecutionTask[]; coordinating: boolean }>();
const cluster = useClusterStore();
const summary = computed(() => executionSummary(props.tasks, props.coordinating));
function nodeName(nodeId: string) { return cluster.nodes.find(node => node.nodeId === nodeId)?.name || nodeId; }
</script>
