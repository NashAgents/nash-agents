<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col h-full min-h-0 bg-surface-950">
      <p v-if="graphsStore.error || controlError" role="alert" class="p-4 text-sm text-rose-400">{{ graphsStore.error || controlError }}</p>
      <!-- 模式一：任务图列表页 (/graphs) -->
      <div v-if="isListMode" class="flex-1 flex flex-col p-4 md:p-6 max-w-6xl mx-auto w-full min-h-0 overflow-y-auto">
        <!-- 列表顶栏 -->
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-surface-800 mb-6">
          <div>
            <h2 class="text-lg font-bold text-surface-100 tracking-tight flex items-center gap-2">
              <svg class="w-5 h-5 text-nash-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span>{{ t.graph.title || '分布式任务图' }}</span>
            </h2>
            <p class="text-xs text-surface-400 mt-1 font-mono">
              跨多节点有向无环图 (DAG) 编排 · 并发调度 · Join Barrier 聚合与状态收敛
            </p>
          </div>

          <!-- 搜索与状态过滤 -->
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <input
              v-model="searchKeyword"
              type="text"
              placeholder="搜索任务图目标或 ID..."
              class="px-3 py-1.5 text-xs rounded-lg bg-surface-900 border border-surface-700 text-surface-100 placeholder-surface-500 focus:outline-none focus:border-nash-500 font-mono w-full sm:w-56"
            />
            <select
              v-model="statusFilter"
              class="px-2.5 py-1.5 text-xs rounded-lg bg-surface-900 border border-surface-700 text-surface-200 focus:outline-none focus:border-nash-500 font-mono"
            >
              <option value="all">全部状态</option>
              <option value="running">运行中 (running)</option>
              <option value="completed">已完成 (completed)</option>
              <option value="partially_completed">部分完成</option>
              <option value="paused">已暂停</option>
              <option value="blocked">已阻断</option>
              <option value="cancelling">正在取消 (cancelling)</option>
              <option value="cancelled">已取消 (cancelled)</option>
              <option value="failed">失败 (failed)</option>
            </select>
            <button
              @click="graphsStore.loadGraphs()"
              class="px-3 py-1.5 rounded-lg bg-surface-900 border border-surface-700 text-xs font-mono text-surface-300 hover:text-surface-100 transition-colors shrink-0"
            >
              刷新
            </button>
          </div>
        </div>

        <!-- 列表卡片网格 -->
        <div v-if="filteredGraphs.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div
            v-for="g in filteredGraphs"
            :key="g.graphId"
            @click="navigateToGraph(g.graphId)"
            class="p-4 rounded-xl bg-surface-900 border border-surface-800 hover:border-nash-500/70 cursor-pointer transition-all shadow-sm flex flex-col justify-between space-y-3 group"
          >
            <div>
              <div class="flex items-start justify-between gap-2 mb-2">
                <h3 class="font-semibold text-xs text-surface-100 group-hover:text-nash-300 transition-colors line-clamp-2" :title="g.parentGoal">
                  {{ g.parentGoal || g.graphId }}
                </h3>
                <Badge :variant="getStatusBadgeVariant(g.status)" size="sm">
                  {{ g.status }}
                </Badge>
              </div>

              <div class="space-y-1 text-[11px] text-surface-400 font-mono">
                <div>Graph ID: <span class="text-surface-300">{{ g.graphId }}</span></div>
                <div>版本: <span class="text-surface-300">Revision v{{ g.revision || 1 }}</span></div>
                <div>创建时间: <span class="text-surface-300">{{ formatTime(g.createdAt) }}</span></div>
                <div v-if="g.error" class="text-rose-400 truncate text-[10px]">
                  异常: {{ g.error }}
                </div>
              </div>
            </div>

            <div class="pt-3 border-t border-surface-800/80 flex items-center justify-between text-xs font-mono">
              <span class="text-surface-400 text-[11px]">点击进入 DAG 拓扑 →</span>
              <span class="text-nash-400 group-hover:translate-x-0.5 transition-transform">›</span>
            </div>
          </div>
        </div>

        <EmptyState
          v-else
          title="暂无匹配的任务图"
          description="可在工作台输入复合多阶段任务以自主生成分布式任务图"
        />
      </div>

      <!-- 模式二：任务图详情 DAG 视口 (/graphs/:id) -->
      <div v-else class="flex-1 flex flex-col h-full min-h-0">
        <!-- 详情顶栏操作条 -->
        <div class="border-b border-surface-800 px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between bg-surface-950/90 backdrop-blur-md z-10 gap-3 shrink-0">
          <div class="flex items-center gap-3 min-w-0 w-full lg:w-auto">
            <!-- 确定性返回任务图列表 -->
            <button
              @click="handleBackToList"
              class="text-surface-400 hover:text-surface-100 p-1.5 rounded-lg hover:bg-surface-800 transition-colors shrink-0 flex items-center gap-1 text-xs font-mono"
              title="返回任务图列表"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              <span class="hidden sm:inline">任务图列表</span>
            </button>

            <span class="text-surface-600 hidden sm:inline">/</span>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 min-w-0">
                <h2 class="text-sm font-semibold text-surface-100 truncate max-w-[240px] sm:max-w-md">
                  {{ graphsStore.currentGraph?.parentGoal || '任务图详情' }}
                </h2>
                <Badge v-if="graphsStore.currentGraph" :variant="getStatusBadgeVariant(graphsStore.currentGraph.status)" size="sm">
                  {{ graphsStore.currentGraph.status }}
                </Badge>
              </div>
              <div class="flex items-center gap-2 text-[11px] text-surface-400 font-mono">
                <span class="hidden sm:inline">Graph: {{ currentGraphId }}</span>
                <span class="hidden sm:inline">·</span>
                <span class="whitespace-nowrap">版本 v{{ graphsStore.currentGraph?.revision || 1 }}</span>
                <span>·</span>
                <span class="whitespace-nowrap">{{ graphsStore.currentNodes.length }} 节点</span>
              </div>
            </div>
          </div>

          <!-- 右侧视图切换与控制动作 -->
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <!-- 视图模式切换 -->
            <div class="flex items-center bg-surface-900 border border-surface-800 rounded-lg p-0.5 text-xs">
              <button
                @click="viewMode = 'dag'"
                :class="[
                  'min-h-11 px-2.5 py-1 rounded-md transition-colors font-medium',
                  viewMode === 'dag' ? 'bg-surface-800 text-nash-400 font-semibold' : 'text-surface-400 hover:text-surface-200',
                ]"
              >
                DAG 拓扑
              </button>
              <button
                @click="viewMode = 'stage'"
                :class="[
                  'min-h-11 px-2.5 py-1 rounded-md transition-colors font-medium',
                  viewMode === 'stage' ? 'bg-surface-800 text-nash-400 font-semibold' : 'text-surface-400 hover:text-surface-200',
                ]"
              >
                阶段列表
              </button>
              <button
                @click="viewMode = 'timeline'"
                :class="[
                  'min-h-11 px-2.5 py-1 rounded-md transition-colors font-medium',
                  viewMode === 'timeline' ? 'bg-surface-800 text-nash-400 font-semibold' : 'text-surface-400 hover:text-surface-200',
                ]"
              >
                时间线与版本 (v{{ graphsStore.currentGraph?.revision || 1 }})
              </button>
            </div>

            <!-- 暂停/继续控制 -->
            <button
              v-if="graphsStore.currentGraph?.status === 'running'"
              @click="handlePause"
              :disabled="controlBusy"
              class="min-h-11 px-2.5 py-1 text-xs rounded-lg bg-surface-900 border border-surface-700 hover:bg-surface-800 text-surface-300 font-mono transition-colors"
            >
              暂停
            </button>
            <button
              v-else-if="graphsStore.currentGraph?.status === 'paused'"
              @click="handleResume"
              :disabled="controlBusy"
              class="min-h-11 px-2.5 py-1 text-xs rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-400 font-mono transition-colors"
            >
              继续
            </button>

            <!-- 取消图 -->
            <button
              v-if="['running', 'blocked', 'ready'].includes(graphsStore.currentGraph?.status)"
              @click="handleCancel"
              :disabled="controlBusy"
              class="min-h-11 px-2.5 py-1 text-xs rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 font-mono hover:bg-rose-500/20 transition-colors"
            >
              取消整图
            </button>
          </div>
        </div>

        <!-- 主视图：DAG 拓扑可视化 / 阶段卡片列表 / 任务时间线与重规划历史 -->
        <div class="flex-1 min-h-0 relative overflow-y-auto">
          <TaskGraphFlow
            v-if="viewMode === 'dag'"
            :nodes="graphsStore.currentNodes"
            :edges="graphsStore.currentEdges"
            :verifications="graphsStore.currentVerifications"
            :provenance="graphsStore.currentProvenance"
            :artifacts="graphsStore.currentArtifacts"
          />
          <GraphStageList
            v-else-if="viewMode === 'stage'"
            :nodes="graphsStore.currentNodes"
            :edges="graphsStore.currentEdges"
          />
          <div v-else class="p-4 md:p-6 max-w-5xl mx-auto space-y-6 text-xs">
            <!-- 策略决策与目标完成度评估 -->
            <div v-if="graphsStore.currentGraph?.strategyDecision || graphsStore.currentGoalEvaluation" class="bg-surface-900 border border-surface-800 rounded-xl p-4 space-y-3">
              <h3 class="font-semibold text-surface-100 text-sm">自主编排决策与目标评估 (Strategy & Goal Evaluation)</h3>
              <div v-if="graphsStore.currentGraph?.strategyDecision" class="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-[11px]">
                <div class="bg-surface-950 p-2.5 rounded border border-surface-800">
                  <span class="text-surface-400 block">执行模式</span>
                  <span class="text-nash-400 font-semibold">{{ graphsStore.currentGraph.strategyDecision.mode }}</span>
                </div>
                <div class="bg-surface-950 p-2.5 rounded border border-surface-800">
                  <span class="text-surface-400 block">复杂度评分</span>
                  <span class="text-surface-200">{{ graphsStore.currentGraph.strategyDecision.complexityScore }} (开销:{{ graphsStore.currentGraph.strategyDecision.estimatedCoordinationOverhead }})</span>
                </div>
                <div class="bg-surface-950 p-2.5 rounded border border-surface-800">
                  <span class="text-surface-400 block">目标完成状态</span>
                  <span class="text-emerald-400">{{ graphsStore.currentGoalEvaluation?.completionStatus || graphsStore.currentGraph.status }}</span>
                </div>
              </div>
              <p v-if="graphsStore.currentGraph?.strategyDecision?.reason" class="text-surface-300 font-mono text-[11px] bg-surface-950 p-2.5 rounded border border-surface-800">
                决策依据: {{ graphsStore.currentGraph.strategyDecision.reason }}
              </p>
              <p v-if="graphsStore.currentGoalEvaluation?.summary" class="text-surface-300 font-mono text-[11px] bg-surface-950 p-2.5 rounded border border-surface-800">
                目标核验: {{ graphsStore.currentGoalEvaluation.summary }}
              </p>
            </div>

            <div v-if="graphsStore.currentProvenance" class="bg-surface-900 border border-surface-800 rounded-xl p-4 space-y-3">
              <h3 class="font-semibold text-surface-100 text-sm">执行耗时与证据</h3>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono">
                <div><span class="text-surface-400 block">Planner</span>{{ Math.round(graphsStore.currentProvenance.plannerDurationMs ?? 0) }} ms</div>
                <div><span class="text-surface-400 block">Replanner</span>{{ Math.round(graphsStore.currentProvenance.replannerDurationMs ?? 0) }} ms</div>
                <div><span class="text-surface-400 block">图完整生命周期</span>{{ Math.round(graphsStore.currentProvenance.graphWallTimeMs) }} ms</div>
                <div><span class="text-surface-400 block">Worker 耗时总和</span>{{ Math.round(graphsStore.currentProvenance.summedWorkerExecutionMs) }} ms</div>
                <div><span class="text-surface-400 block">任务依赖链耗时</span>{{ Math.round(graphsStore.currentProvenance.taskCriticalPathMs) }} ms</div>
                <div><span class="text-surface-400 block">Worker 模型调用</span>{{ graphsStore.currentProvenance.modelCalls }}</div>
                <div><span class="text-surface-400 block">工具执行</span>{{ graphsStore.currentProvenance.toolCalls }}</div>
                <div><span class="text-surface-400 block">图内 LLM 调用</span>{{ graphsStore.currentProvenance.graphModelCalls ?? '—' }}</div>
                <div><span class="text-surface-400 block">输入 / 输出 Token</span>{{ graphsStore.currentProvenance.tokenUsage?.inputTokens ?? '—' }} / {{ graphsStore.currentProvenance.tokenUsage?.outputTokens ?? '—' }}</div>
                <div><span class="text-surface-400 block">旧口径已知总 Token</span>{{ graphsStore.currentProvenance.tokenUsage?.totalTokens ?? '—' }}</div>
              </div>
              <p class="text-xs text-surface-400">图生命周期从持久化至终态；规划与最终答复单独计时。任务依赖链只使用各 Worker 本机耗时，不跨机器相减时间戳。</p>
              <p class="text-surface-500 text-[11px]">调用与 Token 包含图内规划、重规划、Worker 和目标评价；不含外围 Main 会话及安全审查等辅助模型。未知用量调用：{{ graphsStore.currentProvenance.unknownTokenUsageCalls ?? '—' }}。</p>
              <details v-if="graphsStore.currentGraph?.strategyDecision?.planningAttempts?.length" class="text-xs">
                <summary class="cursor-pointer">初始模型 DAG 与约束修正记录</summary>
                <pre class="mt-2 whitespace-pre-wrap break-all max-h-80 overflow-auto text-surface-300">{{ JSON.stringify(graphsStore.currentGraph.strategyDecision.planningAttempts, null, 2) }}</pre>
              </details>
            </div>

            <RuntimePerformanceInspector v-if="graphsStore.currentProvenance" :provenance="graphsStore.currentProvenance" />

            <!-- Revision 与动态重规划历史 -->
            <div class="bg-surface-900 border border-surface-800 rounded-xl p-4 space-y-3">
              <h3 class="font-semibold text-surface-100 text-sm">图版本与重规划历史 (Graph Revisions)</h3>
              <div v-if="graphsStore.currentRevisions.length" class="space-y-2 font-mono text-[11px]">
                <div
                  v-for="rev in graphsStore.currentRevisions"
                  :key="rev.revision"
                  class="p-3 rounded-lg bg-surface-950 border border-surface-800 flex flex-col gap-1"
                >
                  <div class="flex items-center justify-between">
                    <span class="text-nash-400 font-semibold">Revision v{{ rev.revision }} · {{ rev.triggerType }}</span>
                    <span class="text-surface-400">{{ formatTime(rev.createdAt) }}</span>
                  </div>
                  <p class="text-surface-200">{{ rev.reason }}</p>
                  <div v-if="rev.diffSummary?.addedNodes?.length || rev.diffSummary?.addedEdges?.length" class="text-surface-400 text-[10px]">
                    <span v-if="rev.diffSummary?.addedNodes?.length">新增节点: {{ rev.diffSummary?.addedNodes.join(', ') }} </span>
                    <span v-if="rev.diffSummary?.addedEdges?.length">重连边: {{ rev.diffSummary?.addedEdges.length }} 条</span>
                  </div>
                </div>
              </div>
              <p v-else class="text-surface-400 font-mono">初始版本 v1，尚未触发动态重规划。</p>
            </div>

            <div class="bg-surface-900 border border-surface-800 rounded-xl p-4 space-y-3">
              <h3 class="font-semibold text-surface-100 text-sm">节点执行历史</h3>
              <details v-for="node in graphsStore.currentNodes" :key="node.nodeId" class="border border-surface-800 rounded-lg p-3 text-sm">
                <summary class="cursor-pointer text-surface-100">{{ node.title || node.nodeId }} · {{ node.status }}<span v-if="node.recoveryState"> · {{ node.recoveryState === 'recovered' ? '恢复成功' : '恢复中' }}</span> · {{ node.attempts?.length || 0 }} 次执行</summary>
                <p v-if="node.error" class="mt-2 text-red-400 whitespace-pre-wrap">当前错误：{{ node.error }}</p>
                <div v-for="(attempt, index) in node.attempts" :key="attempt.taskId" class="mt-2 p-2 rounded bg-surface-950 text-surface-300">
                  <router-link class="text-nash-300 underline" :to="`/tasks/${attempt.taskId}`">执行 {{ Number(index) + 1 }} · {{ attempt.status }} · {{ attempt.taskId }}</router-link>
                  <p v-if="attempt.retryOfTaskId">重试来源：{{ attempt.retryOfTaskId }}</p>
                  <p v-if="attempt.error" class="text-red-400 whitespace-pre-wrap">失败原因：{{ attempt.error }}</p>
                  <p v-if="attempt.resultSummary" class="whitespace-pre-wrap">{{ attempt.resultSummary }}</p>
                </div>
              </details>
            </div>

            <!-- Mission Timeline 事件流 -->
            <div class="bg-surface-900 border border-surface-800 rounded-xl p-4 space-y-3">
              <h3 class="font-semibold text-surface-100 text-sm">执行时间线 (Mission Timeline · {{ graphsStore.currentEvents.length }} 事件)</h3>
              <div v-if="graphsStore.currentEvents.length" class="space-y-2 font-mono text-[11px] max-h-96 overflow-y-auto">
                <div
                  v-for="evt in graphsStore.currentEvents"
                  :key="evt.seq"
                  class="p-2.5 rounded bg-surface-950 border border-surface-800 flex items-start justify-between gap-3"
                >
                  <div class="space-y-0.5 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-nash-400 font-semibold">#{{ evt.seq }} {{ evt.eventType }}</span>
                      <span v-if="evt.nodeId" class="px-1.5 py-0.2 rounded bg-surface-800 text-surface-300">Node: {{ evt.nodeId }}</span>
                    </div>
                    <p class="text-surface-300 break-all">{{ JSON.stringify(evt.payload) }}</p>
                  </div>
                  <span class="text-surface-400 shrink-0 text-[10px]">{{ formatTime(evt.createdAt ?? evt.timestamp) }}</span>
                </div>
              </div>
              <p v-else class="text-surface-400 font-mono">暂无任务图事件。</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useUiStore } from "../stores/ui";
import { useGraphsStore } from "../stores/graphs";
import { useI18n } from "../i18n";

import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

import RuntimePerformanceInspector from "../components/graph/RuntimePerformanceInspector.vue";
import TaskGraphFlow from "../components/graph/TaskGraphFlow.vue";
import GraphStageList from "../components/graph/GraphStageList.vue";
import Badge from "../components/ui/Badge.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const uiStore = useUiStore();
const graphsStore = useGraphsStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const controlBusy = ref(false);
const controlError = ref("");
const searchKeyword = ref("");
const statusFilter = ref("all");
const viewMode = ref<"stage" | "dag" | "timeline">(uiStore.isMobile ? "stage" : "dag");

// 路由判定：若无 :id 则为列表模式，有 :id 则为指定图的详情模式
const isListMode = computed(() => !route.params.id);
const currentGraphId = computed(() => (route.params.id ? String(route.params.id) : ""));

const filteredGraphs = computed(() => {
  return graphsStore.graphs.filter((g) => {
    if (statusFilter.value !== "all" && g.status !== statusFilter.value) {
      return false;
    }
    if (searchKeyword.value.trim()) {
      const q = searchKeyword.value.toLowerCase().trim();
      const matchGoal = (g.parentGoal || "").toLowerCase().includes(q);
      const matchId = (g.graphId || "").toLowerCase().includes(q);
      return matchGoal || matchId;
    }
    return true;
  });
});

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

function navigateToGraph(graphId: string) {
  router.push(`/graphs/${graphId}`);
}

function handleBackToList() {
  router.push("/graphs");
}

function getStatusBadgeVariant(status: string) {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "primary";
    case "cancelling":
    case "cancelled":
    case "failed":
      return "danger";
    case "blocked":
      return "warning";
    default:
      return "default";
  }
}

function formatTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

watch(
  () => route.params.id,
  async (newId) => {
    if (newId) {
      await graphsStore.loadGraphDetails(String(newId));
    } else {
      graphsStore.cleanup();
      await graphsStore.loadGraphs();
    }
  }
);

onMounted(async () => {
  if (route.params.id) {
    // 明确加载用户指定的 Graph ID
    await graphsStore.loadGraphDetails(String(route.params.id));
  } else {
    // 访问 /graphs 时展示任务图列表，绝对不自动打开旧图
    await graphsStore.loadGraphs();
  }
});

onUnmounted(() => {
  graphsStore.cleanup();
});

async function control(action: () => Promise<void>) {
  if (controlBusy.value) return;
  controlBusy.value = true; controlError.value = "";
  try { await action(); }
  catch (err: any) { controlError.value = err.message || "操作失败，请重试"; }
  finally { controlBusy.value = false; }
}
async function handlePause() { if (graphsStore.currentGraph) await control(() => graphsStore.pause(graphsStore.currentGraph.graphId)); }
async function handleResume() { if (graphsStore.currentGraph) await control(() => graphsStore.resume(graphsStore.currentGraph.graphId)); }
async function handleCancel() { if (graphsStore.currentGraph && confirm("确定要取消此分布式任务图吗？")) await control(() => graphsStore.cancel(graphsStore.currentGraph.graphId)); }

</script>
