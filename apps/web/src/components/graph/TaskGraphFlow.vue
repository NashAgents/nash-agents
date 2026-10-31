<template>
  <div ref="graphRoot" class="task-graph-flow relative w-full h-full min-h-[400px] bg-surface-950 overflow-hidden flex flex-col">
    <div v-if="graphApprovals.length" class="p-3 space-y-2 border-b border-amber-500/40 text-xs">
      <div v-for="approval in graphApprovals" :key="approval.approvalId" class="space-y-1">
        <p class="text-amber-400">等待审批 · {{ approval.toolName }} · {{ approval.nodeId }}</p>
        <p class="break-all">{{ approval.reason }}：{{ approval.target }}</p>
        <div class="flex gap-3">
          <button class="text-emerald-400" @click="approvalsStore.resolve(approval.approvalId, 'allow-once')">放行一次</button>
          <button class="text-surface-400" @click="approvalsStore.resolve(approval.approvalId, 'deny')">拒绝</button>
        </div>
      </div>
    </div>
    <!-- Vue Flow 画布 -->
    <VueFlow
      :nodes="flowNodes"
      :edges="flowEdges"
      :default-viewport="{ zoom: 0.9, x: 40, y: 40 }"
      :min-zoom="0.2"
      :max-zoom="2"
      :fit-view-on-init="true"
      class="flex-1"
      @node-click="onNodeClick"
    >
      <Background :pattern-color="'#27272a'" :gap="24" />
      <Controls position="bottom-left" />
      <MiniMap position="bottom-right" :node-color="getMiniMapNodeColor" />

      <!-- 自定义节点渲染模板 -->
      <template #node-custom="nodeProps">
        <GraphNodeCustom
          :data="nodeProps.data"
          :selected="selectedNodeId === nodeProps.id"
          @select="selectNode(nodeProps.data)"
        />
      </template>
    </VueFlow>

    <!-- 选中节点详情浮层 (自适应底栏 Dock，避免盖死整个 DAG 画布) -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-full opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-full opacity-0"
    >
      <div
        v-if="selectedNode"
        class="absolute left-3 right-3 bottom-3 max-h-[55%] bg-surface-900/95 border border-surface-700/80 rounded-xl p-4 shadow-2xl z-30 overflow-y-auto backdrop-blur-md flex flex-col"
      >
        <div class="flex items-center justify-between pb-2.5 border-b border-surface-800">
          <div class="flex items-center gap-2">
            <StatusDot :status="selectedNode.status" />
            <h4 class="font-semibold text-xs md:text-sm text-surface-100 truncate">
              {{ selectedNode.title }}
            </h4>
          </div>
          <button
            @click="selectedNode = null"
            class="text-surface-400 hover:text-surface-200 p-1 rounded-lg hover:bg-surface-800 transition-colors"
            title="关闭详情"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="mt-4 space-y-4 text-xs">
          <!-- 目标 -->
          <div>
            <span class="text-surface-400 block mb-1">执行目标</span>
            <p class="text-surface-200 bg-surface-950 p-2.5 rounded-lg border border-surface-800 font-sans leading-relaxed">
              {{ selectedNode.goal }}
            </p>
          </div>

          <!-- 状态与分配 -->
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 font-mono">
            <div>
              <span class="text-surface-400 block mb-1">状态</span>
              <Badge variant="primary">{{ selectedNode.status }}</Badge>
              <span v-if="selectedNode.recoveryState" class="ml-2 text-amber-400">{{ selectedNode.recoveryState === 'recovered' ? '恢复成功' : '恢复中' }}</span>
            </div>
            <div>
              <span class="text-surface-400 block mb-1">执行节点</span>
              <span class="text-surface-200">{{ selectedNode.assignedNodeId || selectedNode.candidateNodeId || 'Auto' }}</span>
            </div>
            <div>
              <span class="text-surface-400 block mb-1">目标项目</span>
              <span class="text-surface-200">{{ selectedNode.assignedProjectId || selectedNode.candidateProjectId || 'Auto' }}</span>
            </div>
            <div>
              <span class="text-surface-400 block mb-1">沙箱策略</span>
              <span class="text-surface-200">
                {{ selectedNode.requiredSandboxPolicy ? `${selectedNode.requiredSandboxPolicy.filesystemMode} · net:${selectedNode.requiredSandboxPolicy.networkMode}` : (selectedNode.readOnly !== false ? 'read-only · net:deny' : 'workspace-write · net:deny') }}
              </span>
            </div>
            <div>
              <span class="text-surface-400 block mb-1">重试 / 尝试</span>
              <span class="text-surface-200">{{ selectedNode.attemptCount ?? 0 }} / {{ selectedNode.retryPolicy?.maxRetries ?? 0 }} ({{ selectedNode.retryPolicy?.classification || 'none' }})</span>
            </div>
            <div>
              <span class="text-surface-400 block mb-1">执行后端</span>
              <span class="text-surface-200">{{ selectedExecution?.tools?.find((tool: any) => tool.sandboxBackend)?.sandboxBackend || '未记录' }}</span>
            </div>
            <div v-if="selectedExecution?.causalEvents?.some((event: any) => event.classification)">
              <span class="text-surface-400 block mb-1">错误分类</span>
              <span class="text-rose-400">{{ selectedExecution.causalEvents.find((event: any) => event.classification)?.classification }}</span>
            </div>
            <div>
              <span class="text-surface-400 block mb-1">结果验证</span>
              <span v-if="selectedNodeVerification" :class="selectedNodeVerification.status === 'passed' ? 'text-emerald-400' : 'text-rose-400'">
                {{ selectedNodeVerification.status === 'passed' ? '✓ Passed' : '✗ Failed' }}
              </span>
              <span v-else class="text-surface-400">待验证</span>
            </div>
          </div>

          <div v-if="selectedNode.attempts?.length" class="space-y-2">
            <span class="text-surface-400 block">执行历史</span>
            <div v-for="(attempt, index) in selectedNode.attempts" :key="attempt.taskId" class="bg-surface-950 p-2 rounded border border-surface-800">
              <router-link class="text-nash-300 underline" :to="`/tasks/${attempt.taskId}`">执行 {{ Number(index) + 1 }} · {{ attempt.status }} · {{ attempt.taskId }}</router-link>
              <p v-if="attempt.retryOfTaskId" class="text-surface-400">重试来源：{{ attempt.retryOfTaskId }}</p>
              <p v-if="attempt.error" class="text-rose-400 whitespace-pre-wrap">失败原因：{{ attempt.error }}</p>
            </div>
          </div>

          <!-- 验证标准与证据 -->
          <div v-if="selectedNode.acceptanceCriteria?.length || selectedNodeVerification">
            <span class="text-surface-400 block mb-1">完成标准与验证结果 (Result Verification)</span>
            <div class="space-y-1 font-mono text-[11px] bg-surface-950 p-2.5 rounded-lg border border-surface-800">
              <div v-for="(crit, idx) in (selectedNodeVerification?.criteriaResults || selectedNode.acceptanceCriteria || [])" :key="idx" class="flex items-center justify-between gap-2">
                <span class="text-surface-300">{{ crit.type }}: {{ crit.description }}</span>
                <span v-if="crit.passed !== undefined" :class="crit.passed ? 'text-emerald-400' : 'text-rose-400'">
                  {{ crit.passed ? 'PASS' : `FAIL (${crit.reason || ''})` }}
                </span>
              </div>
              <div v-if="selectedNodeVerification && !selectedNodeVerification.criteriaResults?.length" class="text-surface-300">
                {{ selectedNodeVerification.message }}
              </div>
            </div>
          </div>

          <details v-if="selectedExecution" class="rounded-lg border border-surface-800 p-3 space-y-2">
            <summary class="cursor-pointer text-surface-200">真实执行证据 · {{ selectedExecution.tools.length }} 次工具调用</summary>
            <p class="font-mono break-all">Run: {{ selectedExecution.runId }}</p>
            <p>AgentLoop 模型调用: {{ selectedExecution.modelCalls ?? '未记录' }} · 输入 / 输出 Token: {{ selectedExecution.tokenUsage?.inputTokens ?? '未记录' }} / {{ selectedExecution.tokenUsage?.outputTokens ?? '未记录' }}</p>
            <p>Worker 本机耗时: {{ selectedExecution.durationMs == null ? '尚无终态' : `${Math.round(selectedExecution.durationMs)} ms` }}</p>
            <div v-for="tool in selectedExecution.tools" :key="tool.toolCallId" class="border-t border-surface-800 pt-2 font-mono break-all">
              <p>{{ tool.toolName }} · {{ tool.success ? '成功' : '失败' }} · exit: {{ tool.exitCode ?? '不适用' }}</p>
              <p class="text-surface-400">{{ tool.toolCallId }}</p>
            </div>
            <pre v-if="selectedNodeVerification?.evidence" class="text-[10px] whitespace-pre-wrap break-all">{{ JSON.stringify(selectedNodeVerification.evidence, null, 2) }}</pre>
          </details>

          <!-- 产物 -->
          <div v-if="selectedNode.producedArtifacts?.length || selectedNodeArtifacts.length">
            <span class="text-surface-400 block mb-1">产出产物 (Artifacts)</span>
            <div class="space-y-1">
              <div
                v-for="art in (selectedNodeArtifacts.length ? selectedNodeArtifacts : selectedNode.producedArtifacts)"
                :key="art.artifactId || art.name"
                class="flex items-center justify-between gap-2 p-2 rounded bg-surface-800/80 border border-surface-700/60 font-mono text-[11px]"
              >
                <div class="flex items-center gap-2 truncate">
                  <svg class="w-3.5 h-3.5 text-nash-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <span class="truncate">{{ art.name }}</span>
                </div>
                <span v-if="art.sha256" :title="art.sha256" class="text-[10px] text-surface-400 shrink-0">
                  {{ art.sizeBytes }}B · sha256:{{ art.sha256.slice(0, 8) }}
                </span>
              </div>
            </div>
          </div>

          <!-- 依赖 -->
          <div v-if="selectedNode.dependencies?.length">
            <span class="text-surface-400 block mb-1">前置依赖 (Join Barrier)</span>
            <div class="flex flex-wrap gap-1.5 font-mono text-[11px]">
              <span
                v-for="dep in selectedNode.dependencies"
                :key="dep"
                class="px-2 py-0.5 rounded bg-surface-800 text-surface-300 border border-surface-700"
              >
                {{ dep }}
              </span>
            </div>
          </div>

          <!-- 错误信息 -->
          <div v-if="selectedNode.error">
            <span class="text-rose-400 block mb-1">错误 / 阻断原因</span>
            <p class="text-rose-300 bg-rose-950/30 p-2.5 rounded-lg border border-rose-500/30 font-mono text-[11px] whitespace-pre-wrap">
              {{ selectedNode.error }}
            </p>
          </div>

          <!-- 结果摘要 -->
          <div v-if="selectedNode.resultSummary">
            <span class="text-surface-400 block mb-1">执行结果摘要</span>
            <p class="text-surface-200 bg-surface-950 p-2.5 rounded-lg border border-surface-800 font-mono text-[11px] whitespace-pre-wrap">
              {{ selectedNode.resultSummary }}
            </p>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import GraphNodeCustom from "./GraphNodeCustom.vue";
import StatusDot from "../ui/StatusDot.vue";
import Badge from "../ui/Badge.vue";
import { useApprovalsStore } from "../../stores/approvals";

interface Props {
  nodes: any[];
  edges: any[];
  verifications?: any[];
  artifacts?: any[];
  provenance?: any;
}

const props = defineProps<Props>();
const approvalsStore = useApprovalsStore();
const graphApprovals = computed(() => {
  const taskIds = new Set(props.nodes.map((node) => node.taskId).filter(Boolean));
  return approvalsStore.pendingApprovals.filter((approval) => taskIds.has(approval.taskId));
});
const emit = defineEmits(["select-node"]);

const selectedNodeVerification = computed(() => {
  if (!selectedNode.value || !props.verifications?.length) return null;
  const matches = props.verifications.filter((v) => v.graphNodeId === selectedNode.value.nodeId && (!v.evidence?.taskId || v.evidence.taskId === selectedNode.value.taskId));
  return matches.length > 0 ? matches[matches.length - 1] : null;
});

const selectedNodeArtifacts = computed(() => {
  if (!selectedNode.value || !props.artifacts?.length) return [];
  return props.artifacts.filter((a) => a.producerTaskId === selectedNode.value.taskId && a.producerNodeId === selectedNode.value.assignedNodeId);
});

const selectedExecution = computed(() => props.provenance?.executions?.find((e: any) => e.taskId === selectedNode.value?.taskId));
watch(() => props.nodes, (nodes) => {
  if (selectedNode.value) selectedNode.value = nodes.find((n) => n.nodeId === selectedNode.value.nodeId) ?? null;
});

const { fitView } = useVueFlow();
const graphRoot = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleFit() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { void nextTick(() => { if (graphRoot.value?.clientWidth && graphRoot.value?.clientHeight) fitView({ padding: 0.2, duration: 0 }); }); }, 120);
}
onMounted(() => {
  if (!graphRoot.value) return;
  resizeObserver = new ResizeObserver(scheduleFit);
  resizeObserver.observe(graphRoot.value);
});
onBeforeUnmount(() => { resizeObserver?.disconnect(); clearTimeout(resizeTimer); });

const selectedNode = ref<any | null>(null);
const selectedNodeId = computed(() => selectedNode.value?.nodeId);

// 计算拓扑层次并自动分布节点位置
const flowNodes = computed(() => {
  const elements: any[] = [];
  const nodes = props.nodes || [];
  const edges = props.edges || [];

  // 计算每个节点的依赖深度 (In-degree & Depth)
  const depthMap = new Map<string, number>();
  for (const n of nodes) {
    depthMap.set(n.nodeId, 0);
  }

  // 简单拓扑推算层次
  for (let i = 0; i < nodes.length; i++) {
    for (const edge of edges) {
      const fromDepth = depthMap.get(edge.fromNodeId) ?? 0;
      const toDepth = depthMap.get(edge.toNodeId) ?? 0;
      if (fromDepth + 1 > toDepth) {
        depthMap.set(edge.toNodeId, fromDepth + 1);
      }
    }
  }

  // 按深度分列
  const columns = new Map<number, any[]>();
  for (const n of nodes) {
    const d = depthMap.get(n.nodeId) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(n);
  }

  // 布局坐标
  const HORIZONTAL_GAP = 320;
  const VERTICAL_GAP = 140;

  for (const [colIndex, colNodes] of columns.entries()) {
    colNodes.forEach((node, rowIndex) => {
      elements.push({
        id: node.nodeId,
        type: "custom",
        position: {
          x: colIndex * HORIZONTAL_GAP + 50,
          y: rowIndex * VERTICAL_GAP + 50,
        },
        data: node,
      });
    });
  }

  return elements;
});

const flowEdges = computed(() => {
  const edges = props.edges || [];
  const nodeMap = new Map((props.nodes || []).map((n) => [n.nodeId, n]));

  return edges.map((edge) => {
    const fromNode = nodeMap.get(edge.fromNodeId);
    const toNode = nodeMap.get(edge.toNodeId);

    const fromStatus = fromNode?.status || "pending";
    const toStatus = toNode?.status || "pending";

    const isCancelled =
      fromStatus === "cancelled" ||
      fromStatus === "cancelling" ||
      toStatus === "cancelled" ||
      toStatus === "cancelling";

    const isFailed = fromStatus === "failed" || toStatus === "failed";
    const isCompleted = fromStatus === "completed" && toStatus === "completed";
    const isRunning =
      !isCancelled &&
      !isFailed &&
      (fromStatus === "running" || toStatus === "running");

    let strokeColor = "#3f3f46"; // 默认等待深灰
    if (isCancelled) {
      strokeColor = "#52525b"; // 取消暗灰
    } else if (isFailed) {
      strokeColor = "#ef4444"; // 失败暗红
    } else if (isCompleted) {
      strokeColor = "#10b981"; // 已完成翡翠绿
    } else if (isRunning) {
      strokeColor = "#f97316"; // 运行活跃亮橙
    }

    return {
      id: edge.edgeId || `${edge.fromNodeId}->${edge.toNodeId}`,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      animated: isRunning,
      style: { stroke: strokeColor, strokeWidth: 2 },
    };
  });
});

watch(
  () => props.nodes,
  () => {
    nextTick(() => {
      try {
        fitView({ padding: 0.2 });
      } catch {}
    });
  },
  { deep: true }
);

function onNodeClick(e: any) {
  if (e.node?.data) {
    selectNode(e.node.data);
  }
}

function selectNode(data: any) {
  selectedNode.value = data;
  emit("select-node", data);
}

function getMiniMapNodeColor(node: any) {
  switch (node.data?.status) {
    case "completed":
      return "#10b981";
    case "running":
      return "#8b5cf6";
    case "waiting_dependencies":
      return "#f59e0b";
    case "failed":
      return "#f43f5e";
    default:
      return "#52525b";
  }
}
</script>

<style scoped>
.task-graph-flow { container: graph / inline-size; overflow-wrap: anywhere; }
@container graph (max-width: 360px) { .grid-cols-2 { grid-template-columns: minmax(0, 1fr); } }
</style>
