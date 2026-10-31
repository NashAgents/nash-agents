<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-6xl mx-auto w-full">
      <!-- 顶部标题与新建按钮 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-surface-800 mb-6 gap-3">
        <div>
          <h2 class="text-lg font-bold text-surface-100 tracking-tight flex items-center gap-2">
            <span>{{ t.schedules.title }}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-nash-500/10 text-nash-400 border border-nash-500/30">
              Zero-Busy-Wait Engine
            </span>
          </h2>
          <p class="text-xs text-surface-400 mt-0.5">
            {{ t.schedules.subtitle }}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="openCreateModal"
            class="px-3.5 py-2 rounded-lg bg-nash-500 hover:bg-nash-600 text-white font-medium text-xs shadow-sm transition-all flex items-center gap-1.5"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            <span>{{ t.schedules.newSchedule }}</span>
          </button>
          <button
            @click="scheduledStore.loadTasks()"
            class="px-3 py-2 rounded-lg bg-surface-900 border border-surface-700 text-xs font-mono text-surface-300 hover:text-surface-100 transition-colors"
          >
            刷新
          </button>
        </div>
      </div>

      <!-- 统计指标卡片 -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-surface-400 uppercase tracking-wider">运行中计划</div>
          <div class="text-xl font-bold text-emerald-400 mt-1 font-mono">
            {{ scheduledStore.activeTasksCount }}
          </div>
        </div>
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-surface-400 uppercase tracking-wider">总计划数</div>
          <div class="text-xl font-bold text-surface-100 mt-1 font-mono">
            {{ scheduledStore.totalTasksCount }}
          </div>
        </div>
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-surface-400 uppercase tracking-wider">下次执行倒计时</div>
          <div class="text-xs font-medium text-amber-400 mt-2 truncate font-mono">
            {{ earliestNextRun }}
          </div>
        </div>
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-surface-400 uppercase tracking-wider">调度并发策略</div>
          <div class="text-xs font-medium text-surface-300 mt-2 font-mono">
            SKIP_IF_RUNNING (默认)
          </div>
        </div>
      </div>

      <!-- 筛选与搜索工具条 -->
      <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4">
        <div class="flex items-center gap-1.5 p-1 bg-surface-900 rounded-lg border border-surface-800 text-xs">
          <button
            v-for="f in triggerFilters"
            :key="f.value"
            @click="activeTriggerFilter = f.value"
            :class="[
              'px-2.5 py-1 rounded transition-colors',
              activeTriggerFilter === f.value
                ? 'bg-surface-800 text-nash-400 font-semibold'
                : 'text-surface-400 hover:text-surface-200',
            ]"
          >
            {{ f.label }}
          </button>
        </div>

        <div class="relative w-full sm:w-64">
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t.schedules.searchPlaceholder"
            class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-1.5 text-xs text-surface-100 placeholder-surface-500 focus:outline-none focus:border-nash-500"
          />
        </div>
      </div>

      <!-- 任务计划列表 -->
      <div class="rounded-xl border border-surface-800 bg-surface-900/40 overflow-hidden shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-surface-900 text-surface-400 border-b border-surface-800 font-mono text-[11px]">
              <tr>
                <th class="py-3 px-4">任务名称 / 目标</th>
                <th class="py-3 px-3">触发周期</th>
                <th class="py-3 px-3">目标类型与节点</th>
                <th class="py-3 px-3">下次执行</th>
                <th class="py-3 px-3">状态</th>
                <th class="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-surface-800/60 font-sans">
              <tr
                v-for="task in filteredTasks"
                :key="task.id"
                class="hover:bg-surface-800/40 transition-colors group"
              >
                <!-- 名称与描述 -->
                <td class="py-3.5 px-4 max-w-xs">
                  <div class="font-medium text-surface-100 flex items-center gap-2">
                    <span>{{ task.name }}</span>
                    <span v-if="task.runCount > 0" class="text-[10px] text-surface-500 font-mono">
                      (已跑{{ task.runCount }}次)
                    </span>
                  </div>
                  <div class="text-[11px] text-surface-400 mt-0.5 truncate font-mono">
                    {{ task.taskConfig?.goal || task.description || '无补充目标' }}
                  </div>
                </td>

                <!-- 触发周期 -->
                <td class="py-3.5 px-3 font-mono text-[11px]">
                  <span
                    v-if="task.triggerType === 'cron'"
                    class="px-2 py-0.5 rounded bg-surface-800 text-nash-300 font-bold"
                  >
                    cron: {{ task.cronExpression }}
                  </span>
                  <span
                    v-else-if="task.triggerType === 'interval'"
                    class="px-2 py-0.5 rounded bg-surface-800 text-blue-300 font-bold"
                  >
                    每 {{ Math.round((task.intervalMs || 0) / 60000) }} 分钟
                  </span>
                  <span
                    v-else
                    class="px-2 py-0.5 rounded bg-surface-800 text-purple-300 font-bold"
                  >
                    一次性
                  </span>
                </td>

                <!-- 目标类型与节点 -->
                <td class="py-3.5 px-3 font-mono text-[11px] text-surface-300">
                  <div class="flex items-center gap-1.5">
                    <span class="px-1.5 py-0.2 rounded bg-surface-800 text-[10px]">
                      {{ task.targetType === 'single_task' ? '单任务' : 'TaskGraph' }}
                    </span>
                    <span class="truncate max-w-[120px]" :title="task.taskConfig?.nodeId">
                      {{ task.taskConfig?.nodeId ? task.taskConfig.nodeId : '自动路由' }}
                    </span>
                  </div>
                </td>

                <!-- 下次执行 -->
                <td class="py-3.5 px-3 font-mono text-[11px]">
                  <span v-if="task.enabled && task.nextRunAt" class="text-surface-200">
                    {{ formatTimestamp(task.nextRunAt) }}
                  </span>
                  <span v-else class="text-surface-500 italic">
                    {{ task.enabled ? '计算中...' : '已暂停' }}
                  </span>
                </td>

                <!-- 状态 -->
                <td class="py-3.5 px-3">
                  <span
                    :class="[
                      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-medium',
                      task.enabled
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-surface-800 text-surface-400 border border-surface-700',
                    ]"
                  >
                    <span :class="['w-1.5 h-1.5 rounded-full', task.enabled ? 'bg-emerald-400 animate-pulse' : 'bg-surface-500']"></span>
                    <span>{{ task.enabled ? '已启用' : '已暂停' }}</span>
                  </span>
                </td>

                <!-- 操作按钮 -->
                <td class="py-3.5 px-4 text-right">
                  <div class="inline-flex items-center gap-1">
                    <button
                      @click="triggerRunNow(task.id)"
                      class="px-2 py-1 rounded bg-surface-800 hover:bg-nash-600 hover:text-white text-surface-300 font-medium transition-colors"
                      title="立即执行一次"
                    >
                      运行
                    </button>
                    <button
                      @click="toggleTaskStatus(task)"
                      class="px-2 py-1 rounded bg-surface-800 hover:bg-surface-700 text-surface-300 transition-colors"
                    >
                      {{ task.enabled ? '暂停' : '恢复' }}
                    </button>
                    <button
                      @click="openHistory(task)"
                      class="px-2 py-1 rounded bg-surface-800 hover:bg-surface-700 text-surface-300 transition-colors"
                    >
                      历史
                    </button>
                    <button
                      @click="deleteTask(task.id)"
                      class="px-2 py-1 rounded bg-surface-800 hover:bg-rose-600/80 hover:text-white text-surface-400 transition-colors"
                      title="删除任务"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>

              <tr v-if="filteredTasks.length === 0">
                <td colspan="6" class="py-12 text-center text-surface-500">
                  <div class="flex flex-col items-center justify-center gap-2">
                    <svg class="w-8 h-8 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span>{{ t.schedules.noTasks }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 执行历史 Slide-over 抽屉 -->
      <div
        v-if="showHistoryDrawer"
        class="fixed inset-0 z-50 overflow-hidden flex justify-end"
      >
        <div class="absolute inset-0 bg-black/50 backdrop-blur-xs transition-opacity" @click="showHistoryDrawer = false"></div>
        <div class="relative w-full max-w-lg bg-surface-950 border-l border-surface-800 h-full shadow-2xl flex flex-col p-6 z-10 overflow-y-auto">
          <div class="flex items-center justify-between pb-4 border-b border-surface-800 mb-4">
            <div>
              <h3 class="text-sm font-bold text-surface-100 flex items-center gap-2">
                <span>{{ scheduledStore.selectedTask?.name }}</span>
                <span class="text-xs text-surface-400 font-mono">执行历史</span>
              </h3>
              <p class="text-[11px] text-surface-400 font-mono mt-0.5">
                Schedule ID: {{ scheduledStore.selectedTask?.id }}
              </p>
            </div>
            <button
              @click="showHistoryDrawer = false"
              class="p-1.5 text-surface-400 hover:text-surface-100 rounded-lg hover:bg-surface-800 transition-colors"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- 历史列表 -->
          <div class="space-y-3 flex-1 overflow-y-auto custom-scrollbar">
            <div
              v-for="run in scheduledStore.currentRuns"
              :key="run.id"
              class="p-3.5 rounded-xl bg-surface-900 border border-surface-800 space-y-2 text-xs"
            >
              <div class="flex items-center justify-between font-mono text-[11px]">
                <span class="text-surface-400">{{ formatTimestamp(run.startedAt) }}</span>
                <span
                  :class="[
                    'px-2 py-0.5 rounded text-[10px] font-bold',
                    run.status === 'completed'
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : run.status === 'failed'
                      ? 'bg-rose-500/20 text-rose-400'
                      : run.status === 'skipped'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-blue-500/20 text-blue-400 animate-pulse',
                  ]"
                >
                  {{ run.status }}
                </span>
              </div>

              <div v-if="run.taskId" class="font-mono text-[11px] text-surface-300 flex items-center gap-2">
                <span class="text-surface-500">Task:</span>
                <router-link :to="`/tasks/${run.taskId}`" class="text-nash-400 hover:underline">
                  {{ run.taskId }}
                </router-link>
              </div>

              <div v-if="run.skipReason" class="text-amber-400/90 text-[11px] font-mono">
                跳过原因: {{ run.skipReason }}
              </div>

              <div v-if="run.resultSummary" class="text-surface-300 text-xs bg-surface-950 p-2 rounded border border-surface-800/80">
                {{ run.resultSummary }}
              </div>

              <div v-if="run.error" class="text-rose-400 text-xs bg-surface-950 p-2 rounded border border-rose-900/40">
                {{ run.error }}
              </div>
            </div>

            <div v-if="scheduledStore.currentRuns.length === 0" class="py-12 text-center text-surface-500 text-xs">
              {{ t.schedules.noHistory }}
            </div>
          </div>
        </div>
      </div>

      <!-- 新建定时任务 Modal -->
      <div
        v-if="showCreateModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
      >
        <div class="bg-surface-950 border border-surface-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
          <div class="flex items-center justify-between pb-3 border-b border-surface-800">
            <h3 class="text-sm font-bold text-surface-100">新建定时任务</h3>
            <button @click="showCreateModal = false" class="text-surface-400 hover:text-surface-100">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="space-y-3 text-xs">
            <div>
              <label class="block text-surface-400 mb-1">任务名称 *</label>
              <input
                v-model="newTaskForm.name"
                type="text"
                placeholder="例如: 每日节点状态巡检"
                class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-2 text-surface-100 focus:outline-none focus:border-nash-500"
              />
            </div>

            <div>
              <label class="block text-surface-400 mb-1">触发频率类型 *</label>
              <select
                v-model="newTaskForm.triggerType"
                class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-2 text-surface-100 focus:outline-none focus:border-nash-500 font-mono"
              >
                <option value="cron">Cron 表达式 (周期循环)</option>
                <option value="interval">固定间隔</option>
                <option value="once">一次性未来时间</option>
              </select>
            </div>

            <div v-if="newTaskForm.triggerType === 'cron'">
              <label class="block text-surface-400 mb-1">Cron 表达式 * (如 '0 9 * * *' 代表每日9点)</label>
              <input
                v-model="newTaskForm.cronExpression"
                type="text"
                placeholder="0 9 * * *"
                class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-2 text-surface-100 font-mono focus:outline-none focus:border-nash-500"
              />
              <div class="text-[10px] text-surface-500 mt-1 flex gap-2 font-mono">
                <span class="cursor-pointer text-nash-400 hover:underline" @click="newTaskForm.cronExpression = '0 9 * * *'">[每日9点]</span>
                <span class="cursor-pointer text-nash-400 hover:underline" @click="newTaskForm.cronExpression = '*/30 * * * *'">[每30分钟]</span>
                <span class="cursor-pointer text-nash-400 hover:underline" @click="newTaskForm.cronExpression = '0 0 * * 1'">[每周一0点]</span>
              </div>
            </div>

            <div v-else-if="newTaskForm.triggerType === 'interval'">
              <label for="schedule-interval" class="block text-surface-400 mb-1">间隔（分钟）*</label>
              <input id="schedule-interval" v-model.number="newTaskForm.intervalMinutes" type="number" min="1" step="1" class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-2 text-surface-100" />
            </div>
            <div v-else-if="newTaskForm.triggerType === 'once'">
              <label for="schedule-run-at" class="block text-surface-400 mb-1">执行时间（本地时区）*</label>
              <input id="schedule-run-at" v-model="newTaskForm.runAt" type="datetime-local" class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-2 text-surface-100" />
            </div>

            <div>
              <label class="block text-surface-400 mb-1">执行目标指令 (Goal) *</label>
              <textarea
                v-model="newTaskForm.goal"
                rows="3"
                placeholder="例如: 检查腾讯云与WSL2节点服务状态，汇总资源使用情况"
                class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-2 text-surface-100 focus:outline-none focus:border-nash-500"
              ></textarea>
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-surface-400 mb-1">指定执行节点 (可选)</label>
                <input
                  v-model="newTaskForm.nodeId"
                  type="text"
                  placeholder="留空自动路由"
                  class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-1.5 text-surface-100 font-mono text-[11px]"
                />
              </div>
              <div>
                <label class="block text-surface-400 mb-1">并发策略</label>
                <select
                  v-model="newTaskForm.concurrencyPolicy"
                  class="w-full bg-surface-900 border border-surface-800 rounded-lg px-2 py-1.5 text-surface-100 font-mono text-[11px]"
                >
                  <option value="SKIP_IF_RUNNING">SKIP_IF_RUNNING</option>
                  <option value="QUEUE">QUEUE</option>
                  <option value="ALLOW_CONCURRENT">ALLOW_CONCURRENT</option>
                </select>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-end gap-2 pt-3 border-t border-surface-800">
            <button
              @click="showCreateModal = false"
              class="px-4 py-2 rounded-lg bg-surface-900 text-surface-300 hover:bg-surface-800 text-xs transition-colors"
            >
              取消
            </button>
            <button
              @click="submitCreateTask"
              :disabled="!newTaskForm.name || !newTaskForm.goal"
              class="px-4 py-2 rounded-lg bg-nash-500 hover:bg-nash-600 disabled:opacity-50 text-white font-medium text-xs shadow-sm transition-colors"
            >
              创建任务
            </button>
          </div>
        </div>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useUiStore } from "../stores/ui";
import { useScheduledStore, type ScheduledTask } from "../stores/scheduled";
import { useI18n } from "../i18n";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

const uiStore = useUiStore();
const scheduledStore = useScheduledStore();
const { t } = useI18n();

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

const searchQuery = ref("");
const activeTriggerFilter = ref("all");
const showHistoryDrawer = ref(false);
const showCreateModal = ref(false);

const triggerFilters = computed(() => [
  { label: t.value.schedules.filterAll, value: "all" },
  { label: t.value.schedules.filterCron, value: "cron" },
  { label: t.value.schedules.filterInterval, value: "interval" },
  { label: t.value.schedules.filterOnce, value: "once" },
]);

const newTaskForm = ref({
  name: "",
  triggerType: "cron",
  cronExpression: "0 9 * * *",
  intervalMinutes: 60,
  runAt: "",
  goal: "",
  nodeId: "",
  concurrencyPolicy: "SKIP_IF_RUNNING",
});

const filteredTasks = computed(() => {
  return scheduledStore.tasks.filter((t) => {
    if (activeTriggerFilter.value !== "all" && t.triggerType !== activeTriggerFilter.value) {
      return false;
    }
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        (t.cronExpression && t.cronExpression.toLowerCase().includes(q)) ||
        (t.taskConfig?.goal && t.taskConfig.goal.toLowerCase().includes(q))
      );
    }
    return true;
  });
});

const earliestNextRun = computed(() => {
  const activeNextTimes = scheduledStore.tasks
    .filter((t) => t.enabled && t.nextRunAt && t.nextRunAt > Date.now())
    .map((t) => t.nextRunAt as number);
  if (activeNextTimes.length === 0) return "暂无排期";
  const earliest = Math.min(...activeNextTimes);
  return formatTimestamp(earliest);
});

function formatTimestamp(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

async function triggerRunNow(id: string) {
  try {
    await scheduledStore.runNow(id);
    alert("已触发立即执行！可在历史记录或任务列表中查看。");
  } catch (err: any) {
    alert(`触发失败: ${err?.message || err}`);
  }
}

async function toggleTaskStatus(task: ScheduledTask) {
  if (task.enabled) {
    await scheduledStore.pauseTask(task.id);
  } else {
    await scheduledStore.resumeTask(task.id);
  }
}

async function deleteTask(id: string) {
  if (confirm(t.value.schedules.confirmDelete)) {
    await scheduledStore.deleteTask(id);
  }
}

function openHistory(task: ScheduledTask) {
  scheduledStore.selectTask(task);
  showHistoryDrawer.value = true;
}

function openCreateModal() {
  newTaskForm.value = {
    name: "",
    triggerType: "cron",
    cronExpression: "0 9 * * *",
  intervalMinutes: 60,
  runAt: "",
    goal: "",
    nodeId: "",
    concurrencyPolicy: "SKIP_IF_RUNNING",
  };
  showCreateModal.value = true;
}

async function submitCreateTask() {
  try {
    if (newTaskForm.value.triggerType === "interval" && (!Number.isSafeInteger(newTaskForm.value.intervalMinutes) || newTaskForm.value.intervalMinutes < 1)) throw new Error("请输入正整数分钟间隔");
    if (newTaskForm.value.triggerType === "once" && !(new Date(newTaskForm.value.runAt).getTime() > Date.now())) throw new Error("请选择未来的执行时间");
    await scheduledStore.createTask({
      name: newTaskForm.value.name,
      triggerType: newTaskForm.value.triggerType,
      cronExpression: newTaskForm.value.triggerType === "cron" ? newTaskForm.value.cronExpression : undefined,
      intervalMs: newTaskForm.value.triggerType === "interval" ? newTaskForm.value.intervalMinutes * 60000 : undefined,
      runAt: newTaskForm.value.triggerType === "once" ? new Date(newTaskForm.value.runAt).getTime() : undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      goal: newTaskForm.value.goal,
      nodeId: newTaskForm.value.nodeId || undefined,
      concurrencyPolicy: newTaskForm.value.concurrencyPolicy,
    });
    showCreateModal.value = false;
  } catch (err: any) {
    alert(`创建失败: ${err?.message || err}`);
  }
}

onMounted(() => {
  scheduledStore.loadTasks();
});
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(120, 120, 120, 0.2);
  border-radius: 4px;
}
</style>
