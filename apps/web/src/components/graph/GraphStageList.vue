<template>
  <div class="space-y-4 p-4">
    <div
      v-for="(stage, idx) in stages"
      :key="idx"
      class="bg-surface-900 border border-surface-800 rounded-xl p-4 shadow-sm"
    >
      <!-- 阶段标题 -->
      <div class="flex items-center justify-between pb-2.5 border-b border-surface-800/80 mb-3">
        <div class="flex items-center gap-2">
          <span class="w-6 h-6 rounded-md bg-nash-500/10 border border-nash-500/30 text-nash-400 flex items-center justify-center font-mono font-bold text-xs">
            {{ idx + 1 }}
          </span>
          <h4 class="font-semibold text-xs text-surface-200 uppercase tracking-wider font-mono">
            阶段 {{ idx + 1 }} · {{ getStageStatus(stage) }}
          </h4>
        </div>
        <span class="text-[11px] text-surface-400 font-mono">
          {{ stage.nodes.length }} 个任务
        </span>
      </div>

      <!-- 阶段内的子任务卡片 -->
      <div class="space-y-2">
        <div
          v-for="node in stage.nodes"
          :key="node.nodeId"
          class="p-3 rounded-lg bg-surface-950 border border-surface-800 flex flex-col gap-1.5 cursor-pointer hover:border-surface-700 transition-colors"
          @click="$emit('select-node', node)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <StatusDot :status="node.status" :pulse="node.status === 'running'" />
              <span class="font-semibold text-xs text-surface-100 truncate max-w-[200px]">
                {{ node.title }}
              </span>
            </div>
            <Badge :variant="getStatusVariant(node.status)" size="sm">
              {{ node.status }}
            </Badge>
          </div>

          <p class="text-[11px] text-surface-400 line-clamp-1 font-sans">
            {{ node.goal }}
          </p>

          <div class="flex items-center justify-between text-[10px] text-surface-400 font-mono pt-1">
            <span>节点: {{ node.assignedNodeId || 'Auto' }}</span>
            <span v-if="node.producedArtifacts?.length" class="text-nash-400">
              产物: {{ node.producedArtifacts.length }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import StatusDot from "../ui/StatusDot.vue";
import Badge from "../ui/Badge.vue";

interface Props {
  nodes: any[];
  edges: any[];
}

const props = defineProps<Props>();
defineEmits(["select-node"]);

const stages = computed(() => {
  const nodes = props.nodes || [];
  const edges = props.edges || [];

  const depthMap = new Map<string, number>();
  for (const n of nodes) depthMap.set(n.nodeId, 0);

  for (let i = 0; i < nodes.length; i++) {
    for (const edge of edges) {
      const fromDepth = depthMap.get(edge.fromNodeId) ?? 0;
      const toDepth = depthMap.get(edge.toNodeId) ?? 0;
      if (fromDepth + 1 > toDepth) {
        depthMap.set(edge.toNodeId, fromDepth + 1);
      }
    }
  }

  const stageMap = new Map<number, any[]>();
  for (const n of nodes) {
    const d = depthMap.get(n.nodeId) ?? 0;
    if (!stageMap.has(d)) stageMap.set(d, []);
    stageMap.get(d)!.push(n);
  }

  return Array.from(stageMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([_, stageNodes]) => ({
      nodes: stageNodes,
    }));
});

function getStageStatus(stage: { nodes: any[] }) {
  if (stage.nodes.every((n) => n.status === "completed")) return "已完成 ✓";
  if (stage.nodes.some((n) => n.status === "running")) return "执行中 →";
  if (stage.nodes.some((n) => n.status === "failed")) return "失败 ✗";
  return "等待前置 ○";
}

function getStatusVariant(status: string) {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "purple";
    case "waiting_dependencies":
      return "warning";
    case "failed":
      return "danger";
    case "dispatched":
    case "ready":
      return "info";
    default:
      return "default";
  }
}
</script>
