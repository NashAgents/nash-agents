<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-6xl mx-auto w-full">
      <!-- 页面标题与操作 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h2 class="text-lg font-bold text-surface-100 tracking-tight">
            {{ t.nav.tasks }}
          </h2>
          <p class="text-xs text-surface-400 mt-0.5 font-mono">
            {{ goals.length }} 个用户目标 · 已加载 {{ tasksStore.tasks.length }} 个底层任务
          </p>
        </div>

        <!-- 筛选与搜索 -->
        <div class="flex items-center gap-2">
          <select
            v-model="statusFilter"
            class="px-3 py-1.5 rounded-lg bg-surface-900 border border-surface-700 text-surface-200 text-xs focus:outline-none focus:border-nash-500 font-mono"
            @change="loadFilteredTasks"
          >
            <option value="">全部状态</option>
            <option value="running">执行中 (Running)</option>
            <option value="completed">已完成 (Completed)</option>
            <option value="waiting_approval">待审批 (Waiting Approval)</option>
            <option value="failed">失败 (Failed)</option>
            <option value="cancelled">已取消 (Cancelled)</option>
          </select>
          <button
            @click="loadFilteredTasks"
            class="p-2 rounded-lg bg-surface-900 border border-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-800 transition-colors"
            title="刷新"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 任务分类选项卡 (全部任务 vs 业务主任务 vs 内部探查任务) -->
      <div class="flex items-center gap-2 border-b border-surface-800 pb-2 mb-4">
        <button
          @click="activeCategory = 'all'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5',
            activeCategory === 'all'
              ? 'bg-nash-500 text-white shadow-sm'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900',
          ]"
        >
          <span>全部任务</span>
          <span class="px-1.5 py-0.2 rounded-full text-[10px] bg-black/20 font-mono">
            {{ goals.length }}
          </span>
        </button>

        <button
          @click="activeCategory = 'business'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5',
            activeCategory === 'business'
              ? 'bg-nash-500 text-white shadow-sm'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900',
          ]"
        >
          <span>Worker 任务</span>
          <span class="px-1.5 py-0.2 rounded-full text-[10px] bg-black/20 font-mono">
            {{ businessTasksCount }}
          </span>
        </button>

        <button
          @click="activeCategory = 'scout'"
          :class="[
            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5',
            activeCategory === 'scout'
              ? 'bg-nash-500 text-white shadow-sm'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900',
          ]"
        >
          <span>底层探查 (Scout)</span>
          <span class="px-1.5 py-0.2 rounded-full text-[10px] bg-black/20 font-mono">
            {{ scoutTasksCount }}
          </span>
        </button>
      </div>

      <div v-if="activeCategory === 'all'" class="space-y-3">
        <p v-if="goalError" class="text-red-400" role="alert">{{ goalError }}</p>
        <details v-for="goal in goals" :key="goal.goalRunId" class="p-4 rounded-xl bg-surface-900 border border-surface-800">
          <summary class="cursor-pointer text-surface-100 font-semibold">
            {{ goal.rootGoal }} <span class="text-surface-400 text-xs"> · {{ goal.status }} · {{ formatTime(goal.createdAt) }}</span>
          </summary>
          <div class="mt-3 space-y-2 text-sm text-surface-300">
            <p>阶段：{{ goal.currentStage || '规划中' }} · 报告版本 {{ goal.reportRevision }}</p>
            <p>执行状态：{{ goal.executionState || '尚未聚合' }} · 报告状态：{{ goal.reportState || '待生成' }}</p>
            <div v-if="goal.coverageEvaluation" class="rounded-lg bg-surface-950/60 border border-surface-800 p-3 space-y-1">
              <p class="text-surface-100">覆盖结论：{{ coverageCompletionLabel(goal.coverageEvaluation.completion) }} · 评估于 {{ formatTime(goal.coverageEvaluation.evaluatedAt) }}</p>
              <p>
                检查项：合计 {{ goal.coverageEvaluation.counts.requirements }} · 已核验 {{ goal.coverageEvaluation.counts.verified }} · 由替代项承接 {{ goal.coverageEvaluation.counts.replaced }} · 失败 {{ goal.coverageEvaluation.counts.failed }} · 证据不足 {{ goal.coverageEvaluation.counts.inconclusive }} · 未知 {{ goal.coverageEvaluation.counts.unknown }} · 未通过核验 {{ goal.coverageEvaluation.counts.unverified }}
              </p>
              <p v-if="goal.coverageEvaluation.counts.pending" class="text-amber-400">仍有必需检查在执行或等待审批，目标尚未收敛。</p>
              <p v-if="goal.coverageEvaluation.observedScope?.authorizedRoots?.length">实际检查目录：{{ goal.coverageEvaluation.observedScope.authorizedRoots.join('、') }}</p>
              <p v-for="reason in goal.coverageEvaluation.reasons" :key="reason" class="text-surface-400">· {{ reason }}</p>
              <p v-for="check in goal.coverageEvaluation.checks" :key="`ev:${check.graphId}:${check.graphNodeId}`">
                检查 {{ check.graphNodeId }}：{{ coverageCheckLabel(check.status) }} · 任务 {{ check.taskId || '无' }} · 节点 {{ check.nodeId || '未知' }} · 运行 {{ check.runId || '无' }}<span v-if="check.reason"> · {{ check.reason }}</span>
              </p>
              <div v-for="scope in goal.coverageEvaluation.scopes" :key="scope.discoveryId">
                <p>探查 {{ scope.discoveryId }}：{{ coverageCheckLabel(scope.status) }} · 必需节点 {{ scope.requiredNodeIds.join('、') || '无' }}</p>
                <p v-for="node in scope.nodes" :key="node.nodeId" class="pl-3 text-surface-400">节点 {{ node.nodeId }}：{{ coverageCheckLabel(node.status) }} · 检查目录 {{ node.checkedRoots.join('、') || '无' }}<span v-if="node.reason"> · {{ node.reason }}</span></p>
                <p v-for="reason in scope.reasons" :key="reason" class="pl-3 text-amber-400">· {{ reason }}</p>
              </div>
            </div>
            <p v-if="goal.reportState === 'failed'" class="text-amber-400" role="alert">报告生成失败，系统将根据持久化记录重试。</p>
            <details v-for="scope in goal.discoveryScopes || []" :key="scope.discoveryId" class="text-surface-400">
              <summary class="cursor-pointer">探查范围记录 v{{ scope.version }} · {{ scope.discoveryId }}</summary>
              <p>选择来源：{{ scope.selectionSource }}；选中节点：{{ scope.selectedNodeIds.join('、') || '无' }}</p>
              <p>节点状态采集（非原子）：{{ scope.snapshot.map(node => `${node.nodeId} (${node.connected ? '已连接' : '未连接'}, 目录版本 ${node.catalogRevision ?? '未知'})`).join('、') }}</p>
              <p v-if="scope.truncatedByLimit" class="text-amber-400">探查目标受数量上限截断，未选中的范围尚未检查。</p>
              <p>该记录仅说明派发范围；完成覆盖仍须核对执行和扫描收据。</p>
            </details>
            <details v-for="coverage in goal.coverageHistory || []" :key="coverage.version" class="text-surface-400">
              <summary class="cursor-pointer">计划覆盖记录 v{{ coverage.version }} · 任务图 {{ coverage.graphId }} / 修订 {{ coverage.graphRevision }}</summary>
              <p :class="goal.status === 'completed' ? 'text-surface-400' : 'text-amber-400'">
                {{ goal.status === 'completed' ? '该版计划的检查项均已取得验证收据；覆盖判定以上方“覆盖结论”为准。' : '用户目标覆盖范围尚未确认；此记录只保存计划与检查要求。' }}
              </p>
              <p>来源：{{ coverage.source === 'graph_replan' ? '重新规划' : '已建立的任务图' }}；根目标{{ coverage.rootGoalMatches ? '与图目标一致' : '与图目标不一致' }}。</p>
              <p v-if="coverage.catalogSnapshot">节点目录采集为顺序观察，时间窗口 {{ formatTime(coverage.catalogSnapshot.startedAt) }} 至 {{ formatTime(coverage.catalogSnapshot.completedAt) }}。</p>
              <p v-for="check in coverage.checks" :key="check.graphNodeId">{{ check.graphNodeId }}：{{ check.goal }} · 节点 {{ check.targetNodeId || '未指定' }} · 项目 {{ check.targetProjectId || '未指定' }} · 验收要求 {{ check.acceptanceCriteria.length }} 项</p>
            </details>
            <router-link v-if="goal.status === 'waiting_approval'" class="text-nash-300 underline" to="/approvals">前往审批中心</router-link>
            <p v-if="goal.interimReport" class="whitespace-pre-wrap">阶段性报告：{{ goal.interimReport }}</p>
            <p v-if="goal.finalReport" class="whitespace-pre-wrap">最终报告：{{ goal.finalReport }}</p>
            <details v-if="goal.reportHistory?.length" class="text-surface-400">
              <summary class="cursor-pointer">报告版本与证据来源</summary>
              <div v-for="report in goal.reportHistory" :key="report.revision" class="mt-2 pl-3 border-l border-surface-700">
                <p>版本 {{ report.revision }} · {{ formatTime(report.createdAt) }}</p>
                <p class="whitespace-pre-wrap">{{ report.content }}</p>
                <p v-if="report.evidence?.graphIds?.length">任务图：{{ report.evidence.graphIds.join('、') }}</p>
                <p v-if="report.evidence?.taskIds?.length">执行任务：{{ report.evidence.taskIds.join('、') }}</p>
                <p v-if="report.evidence?.coverage" class="text-surface-200">覆盖判定：{{ coverageCompletionLabel(report.evidence.coverage.completion) }}</p>
                <p v-for="check in report.evidence?.coverageChecks || []" :key="`${check.graphId}:${check.graphRevision ?? ''}:${check.graphNodeId}`">检查 {{ check.graphNodeId }}：{{ coverageCheckLabel(check.status) }} · 执行 {{ check.taskId || '无' }} · 节点 {{ check.nodeId || '未知' }} · 运行 {{ check.runId || '无' }}<span v-if="check.reason"> · {{ check.reason }}</span></p>
                <div v-for="scope in report.evidence?.coverageScopes || []" :key="scope.discoveryId" class="pl-3">
                  <p>探查 {{ scope.discoveryId }}：{{ coverageCheckLabel(scope.status) }}</p>
                  <p v-for="node in scope.nodes" :key="node.nodeId">节点 {{ node.nodeId }}：{{ coverageCheckLabel(node.status) }} · 检查目录 {{ node.checkedRoots.join('、') || '无' }} · 候选 {{ node.candidates }}</p>
                </div>
                <p v-if="report.evidence?.artifactIds?.length">产物：{{ report.evidence.artifactIds.join('、') }}</p>
                <p v-for="event in report.evidence?.scoutEvents || []" :key="`${event.taskId}:${event.seq}`">探查事件：{{ event.taskId }} / {{ event.seq }}<span v-if="event.omittedScans"> · {{ event.omittedScans }} 条扫描范围记录未保留</span></p>
                <p v-for="scan in report.evidence?.scoutScans || []" :key="`${scan.taskId}:${scan.seq}:${scan.scope}`">Worker {{ scan.nodeId }} 上报的扫描范围：{{ scan.authorizedRoots.join('、') || '无已授权目录' }}；{{ scan.scope }}；{{ scan.truncated ? '已截断' : '未报告截断' }}；错误 {{ scan.errorCount }} 个</p>
              </div>
            </details>
            <p v-for="id in goal.linkedGraphIds" :key="id"><router-link class="text-nash-300 underline" :to="`/graphs/${id}`">任务图 {{ id }}</router-link></p>
            <div v-for="id in goal.linkedTaskIds" :key="id"><router-link class="text-nash-300 underline" :to="`/tasks/${id}`">{{ goalTaskLabel(goal, id) }} {{ id }}</router-link><span v-if="goalTask(goal, id)"> · {{ goalTask(goal, id).status }}</span><p v-if="goalTask(goal, id)?.dispatchOptions?.contextOverrides?.recoveryOf" class="text-surface-400">恢复原因：{{ goalTask(goal, id).dispatchOptions.contextOverrides.recoveryOf.reason }} · 原执行 {{ goalTask(goal, id).dispatchOptions.contextOverrides.recoveryOf.taskId }}</p></div>
            <button class="text-nash-300 underline" @click="goToConversation(goal.conversationId)">查看原会话</button>
          </div>
        </details>
        <EmptyState v-if="!goalError && goals.length === 0" title="暂无用户目标" description="历史任务可在 Worker 任务中查看。" />
      </div>
      <!-- 任务列表 -->
      <div v-else-if="displayTasks.length > 0" class="space-y-3">
        <div
          v-for="task in displayTasks"
          :key="task.taskId"
          class="p-4 rounded-xl bg-surface-900 border border-surface-800 hover:border-surface-700 transition-all cursor-pointer shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
          @click="$router.push(`/tasks/${task.taskId}`)"
        >
          <div class="space-y-2 flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <StatusDot :status="task.status" :pulse="task.status === 'running'" />
              <h3 class="text-sm font-semibold text-surface-100 truncate group-hover:text-nash-400 transition-colors">
                {{ task.goal }}
              </h3>
            </div>

            <!-- 元数据与关联会话 -->
            <div class="flex flex-wrap items-center gap-3 text-xs text-surface-400 font-mono">
              <span class="flex items-center gap-1">
                <svg class="w-3.5 h-3.5 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                {{ task.nodeId }}
              </span>
              <span>·</span>
              <span>项目: {{ task.projectId }}</span>
              <span>·</span>
              <span>{{ formatTime(task.createdAt) }}</span>

              <!-- 关联的会话直达标签 -->
              <span
                v-if="taskConversationMap.get(task.taskId)"
                class="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-800 text-nash-300 border border-surface-700 hover:border-nash-500/50"
                @click.stop="goToConversation(taskConversationMap.get(task.taskId)!.id)"
                :title="'关联会话: ' + taskConversationMap.get(task.taskId)!.title"
              >
                <svg class="w-3 h-3 text-nash-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                <span class="truncate max-w-[150px] font-sans text-[11px]">
                  {{ taskConversationMap.get(task.taskId)!.title }}
                </span>
                <span class="text-nash-400 text-[10px]">直达 ›</span>
              </span>
            </div>
          </div>

          <div class="flex items-center gap-3 flex-shrink-0">
            <span v-if="(task as any).activeGrant" class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-bold">
              全访问
            </span>
            <Badge :variant="getStatusVariant(task.status)" size="md">
              {{ task.status }}
            </Badge>
            <svg class="w-4 h-4 text-surface-600 group-hover:text-surface-300 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <EmptyState
        v-else
        :title="activeCategory === 'business' ? '暂无业务主任务' : '暂无任务记录'"
        description="可以在工作台输入自然语言创建并派发任务"
      />
    </div>
  </component>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useUiStore } from "../stores/ui";
import { useTasksStore } from "../stores/tasks";
import { useWorkspaceStore } from "../stores/workspace";
import { globalClusterSse } from "../services/sse";
import { api } from "../services/api";
import { useI18n } from "../i18n";

import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

import StatusDot from "../components/ui/StatusDot.vue";
import Badge from "../components/ui/Badge.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const uiStore = useUiStore();
const tasksStore = useTasksStore();
const workspaceStore = useWorkspaceStore();
const { t } = useI18n();
const router = useRouter();

const statusFilter = ref("");
const activeCategory = ref<"all" | "business" | "scout">("all");
interface CoverageCheckEvidence { graphId: string; graphRevision?: number; graphNodeId: string; requirementId?: string; taskId?: string; nodeId?: string; runId?: string; status: string; verificationType?: string; reason?: string; artifactIds?: string[] }
interface GoalCoverageScopes { discoveryId: string; status: string; requiredNodeIds: string[]; truncatedByLimit: boolean; reasons: string[]; nodes: Array<{ nodeId: string; status: string; taskId?: string; runId?: string; candidates: number; checkedRoots: string[]; scanScope?: string; reason: string }> }
interface GoalCoverageSummary { completion: string; counts: Record<string, number>; reasons: string[]; observedScope: { nodeIds: string[]; authorizedRoots: string[]; truncatedScopes: number } }
interface GoalRun { goalRunId: string; conversationId: string; rootGoal: string; status: string; executionState?: string; currentStage?: string; linkedTaskIds: string[]; linkedGraphIds: string[]; taskSummaries?: any[]; interimReport?: string; finalReport?: string; reportState?: string; reportRevision: number; createdAt: number; coverageHistory?: Array<{ version: number; graphId: string; graphRevision: number; rootGoalMatches: boolean; source: string; catalogSnapshot?: { startedAt: number; completedAt: number }; checks: Array<{ graphNodeId: string; goal: string; targetNodeId?: string; targetProjectId?: string; acceptanceCriteria: unknown[] }> }>; coverageEvaluation?: { completion: string; goalVerification: string; counts: Record<string, number>; reasons: string[]; coverageGaps: string[]; evaluatedAt: number; observedScope: { nodeIds: string[]; authorizedRoots: string[]; truncatedScopes: number }; checks: Array<{ graphId: string; graphNodeId: string; status: string; taskId?: string; nodeId?: string; runId?: string; reason: string }>; scopes: GoalCoverageScopes[] }; discoveryScopes?: Array<{ version: number; discoveryId: string; selectionSource: string; selectedNodeIds: string[]; truncatedByLimit: boolean; snapshot: Array<{ nodeId: string; connected: boolean; catalogRevision?: number }> }>; reportHistory?: Array<{ revision: number; createdAt: number; content: string; status?: string; evidence?: { graphIds: string[]; taskIds: string[]; coverageChecks?: CoverageCheckEvidence[]; coverageScopes?: GoalCoverageScopes[]; coverage?: GoalCoverageSummary; artifactIds?: string[]; scoutEvents?: Array<{ taskId: string; seq: number; omittedScans?: number }>; scoutScans?: Array<{ taskId: string; nodeId: string; seq: number; authorizedRoots: string[]; scope: string; truncated: boolean; errorCount: number }> } }> }
const goals = ref<GoalRun[]>([]);
const goalError = ref("");

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

// 构建任务与会话的反向关联表
const taskConversationMap = computed(() => {
  const map = new Map<string, { id: string; title: string }>();
  for (const conv of workspaceStore.conversations) {
    if (conv.linkedTaskIds) {
      for (const tid of conv.linkedTaskIds) {
        map.set(tid, { id: conv.id, title: conv.title });
      }
    }
  }
  return map;
});

const isScoutTask = (task: any) => {
  return task.dispatchOptions?.contextOverrides?.taskType === "scout";
};
function goalTask(goal: GoalRun, id: string) { return goal.taskSummaries?.find(task => task.taskId === id); }
function goalTaskLabel(goal: GoalRun, id: string) {
  const task = goalTask(goal, id);
  if (!task) return "执行任务";
  return isScoutTask(task) ? (task.dispatchOptions?.contextOverrides?.recoveryOf ? "恢复探查" : "关联探查") : task.dispatchOptions?.graphContext ? "图节点执行" : "执行任务";
}

const businessTasksCount = computed(() => {
  return tasksStore.tasks.filter((t) => !isScoutTask(t)).length;
});

const scoutTasksCount = computed(() => {
  return tasksStore.tasks.filter((t) => isScoutTask(t)).length;
});

const displayTasks = computed(() => {
  if (activeCategory.value === "business") {
    return tasksStore.tasks.filter((t) => !isScoutTask(t));
  }
  if (activeCategory.value === "scout") {
    return tasksStore.tasks.filter((t) => isScoutTask(t));
  }
  return tasksStore.tasks;
});

let unsubscribeSse: (() => void) | null = null;
let refreshTimer: any = null;

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadFilteredTasks();
  }, 400);
}

onMounted(async () => {
  if (workspaceStore.conversations.length === 0) {
    workspaceStore.loadConversations().catch(() => {});
  }
  await loadFilteredTasks();

  // 关键体验：全局 SSE 实时刷新任务列表，杜绝用户手动按刷新！
  unsubscribeSse = globalClusterSse.subscribe((event) => {
    if (
      event.type.startsWith("task.") ||
      event.type.startsWith("coordinator.task_") ||
      event.type.startsWith("discovery.")
      || event.type.startsWith("goal_run.") || event.type === "transport.open" || event.type === "stream.reset"
    ) {
      scheduleRefresh();
    }
  });
});

onUnmounted(() => {
  if (unsubscribeSse) {
    unsubscribeSse();
    unsubscribeSse = null;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
});

// A slower earlier response must never overwrite a newer goal state (e.g. completed → running).
let goalRequestId = 0;
async function loadFilteredTasks() {
  const requestId = ++goalRequestId;
  await Promise.all([tasksStore.loadTasks({
    status: statusFilter.value || undefined,
    limit: 60,
  }), api.request<{ goals: GoalRun[] }>("/api/cluster/goal-runs").then(result => {
    if (requestId !== goalRequestId) return;
    goals.value = result.goals; goalError.value = "";
  }).catch(() => {
    if (requestId !== goalRequestId) return;
    goalError.value = "无法读取用户目标，请刷新重试。";
  })]);
}

const COVERAGE_LABELS: Record<string, string> = {
  verified: "已核验",
  completed_unverified: "执行结束，未通过证据核验",
  revision_mismatch: "图修订已变化，收据不再适用",
  superseded: "已由替代项承接",
  planned: "尚未派发",
  dispatched: "已派发",
  running: "执行中",
  waiting_approval: "等待审批",
  failed: "执行失败",
  inconclusive: "证据不足",
  unknown: "结果未知",
  missing: "缺少执行记录",
  pending: "仍有必需检查未完成",
};
function coverageCheckLabel(status: string) { return COVERAGE_LABELS[status] ?? status; }
function coverageCompletionLabel(completion: string) {
  return ({
    completed: "目标已完成（全部检查取得执行收据）",
    partially_completed: "部分完成（覆盖范围未全部核验）",
    failed: "未完成",
    outcome_unknown: "结果未知",
    pending: "仍在执行",
  } as Record<string, string>)[completion] ?? completion;
}

function goToConversation(convId: string) {
  workspaceStore.selectConversation(convId);
  router.push("/");
}

function formatTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
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
