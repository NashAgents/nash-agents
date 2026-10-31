<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div class="flex items-center justify-between pb-4 border-b border-surface-800 mb-6">
        <div>
          <h2 class="text-lg font-bold text-surface-100 tracking-tight">
            {{ t.approval.title }}
          </h2>
          <p class="text-xs text-surface-400 mt-0.5 font-mono">
            人机协同安全边界 · 支持单次放行 (Allow Once) 与阻断拒绝 (Deny)
          </p>
        </div>
        <button
          @click="() => approvalsStore.loadApprovals()"
          class="px-3 py-1.5 rounded-lg bg-surface-900 border border-surface-700 text-xs font-mono text-surface-300 hover:text-surface-100 transition-colors"
        >
          刷新
        </button>
      </div>

      <!-- 待处理审批列表 -->
      <div class="space-y-4 mb-8">
        <h3 class="text-xs font-semibold text-amber-400 uppercase tracking-wider font-mono flex items-center gap-2">
          <span>待审批项目 ({{ approvalsStore.pendingApprovals.length }})</span>
          <span v-if="approvalsStore.pendingApprovals.length" class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
        </h3>

        <div v-if="approvalsStore.pendingApprovals.length > 0" class="space-y-3">
          <div
            v-for="appr in approvalsStore.pendingApprovals"
            :key="appr.approvalId"
            class="p-4 rounded-xl bg-surface-900 border border-amber-500/40 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4"
          >
            <div class="space-y-2 flex-1">
              <div class="flex items-center gap-2 font-mono text-xs">
                <span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                  {{ appr.toolName || '工具操作' }}
                </span>
                <span class="text-surface-400">Node: {{ appr.nodeId }}</span>
                <span class="text-surface-400">Task: {{ appr.taskId }}</span>
              </div>
              <div class="text-xs text-surface-200 font-sans">
                <span class="text-surface-400">理由:</span> {{ appr.reason }}
              </div>
              <div class="text-xs text-surface-300 font-mono bg-surface-950 p-2 rounded border border-surface-800 break-all">
                目标资源: {{ appr.target }}
              </div>
            </div>

            <div class="flex items-center gap-2 flex-shrink-0">
              <button
                @click="approvalsStore.resolve(appr.approvalId, 'allow-once')"
                class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors active:scale-95 shadow-sm"
              >
                放行一次
              </button>
              <button
                @click="approvalsStore.resolve(appr.approvalId, 'deny')"
                class="px-4 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 font-semibold text-xs transition-colors"
              >
                拒绝操作
              </button>
              <button
                v-if="canGrant(appr)"
                @click="openGrantModal(appr)"
                class="px-4 py-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold text-xs transition-colors flex items-center gap-1.5 active:scale-95 shadow-sm"
              >
                <svg class="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                仅此任务启用全访问
              </button>
              <span
                v-else-if="appr.pendingGrant"
                class="px-3 py-2 rounded-lg bg-surface-900 text-amber-300 border border-amber-500/30 text-[11px] font-semibold"
              >
                等待 Worker 确认授权…
              </span>
              <span
                v-else-if="appr.grantIneligibleReason"
                class="text-[11px] text-surface-500 font-mono max-w-[180px] truncate"
                :title="appr.grantIneligibleReason"
              >
                {{ appr.grantIneligibleReason }}
              </span>
            </div>
          </div>
        </div>

        <div v-else class="p-6 rounded-xl bg-surface-900/40 border border-surface-800 text-center text-xs text-surface-400 font-mono">
          暂无等待中的安全审批
        </div>
      </div>

      <!-- 历史审批列表 -->
      <div class="space-y-3">
        <h3 class="text-xs font-semibold text-surface-400 uppercase tracking-wider font-mono">
          审批历史记录 ({{ historyApprovals.length }})
        </h3>
        <div class="space-y-2">
          <div
            v-for="appr in historyApprovals"
            :key="appr.approvalId"
            class="p-3 rounded-lg bg-surface-900/40 border border-surface-800 text-xs flex items-center justify-between font-mono text-surface-300"
          >
            <div class="flex items-center gap-2 truncate">
              <span class="text-surface-400">{{ appr.nodeId }}</span>
              <span class="truncate">{{ appr.target }}</span>
            </div>
            <Badge :variant="appr.decision === 'grant-task-full-access' ? 'warning' : appr.decision === 'allow-once' || appr.status === 'approved' ? 'success' : 'danger'" size="sm">
              {{ appr.status === 'expired' ? '已过期' : appr.decision === 'grant-task-full-access' ? '全访问 · 安全模型审查' : appr.decision === 'allow-once' || appr.status === 'approved' ? '已批准' : '已拒绝' }}
            </Badge>
          </div>
        </div>
      </div>

      <!-- 任务级全访问授权风险确认弹窗 -->
      <div
        v-if="grantModalAppr"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
        @click.self="closeGrantModal"
      >
        <div class="bg-surface-900 border border-amber-500/50 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2.5 text-amber-400">
              <svg class="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h3 class="text-sm font-bold tracking-tight text-surface-100">
                确认仅对此任务启用完全访问？
              </h3>
            </div>
            <button
              @click="closeGrantModal"
              class="text-surface-400 hover:text-surface-200 text-sm font-mono"
            >
              ✕
            </button>
          </div>

          <p class="text-xs text-surface-300 leading-relaxed">
            该操作将针对当前任务的本次执行实例提升权限。升级后后续操作不再逐次请求人工审批，由安全模型自动审查放行。
          </p>

          <div class="bg-surface-950 p-3.5 rounded-xl border border-surface-800 space-y-2 text-xs font-mono">
            <div class="flex justify-between text-surface-400">
              <span>目标节点:</span>
              <span class="text-surface-200">{{ grantModalAppr.nodeId }}</span>
            </div>
            <div class="flex justify-between text-surface-400">
              <span>任务 ID:</span>
              <span class="text-surface-200 truncate max-w-[280px]">{{ grantModalAppr.taskId }}</span>
            </div>
            <div class="flex justify-between text-surface-400">
              <span>运行 Run ID:</span>
              <span class="text-surface-200 truncate max-w-[280px]">{{ grantModalAppr.runId }}</span>
            </div>
            <div class="flex justify-between text-surface-400">
              <span>当前模式:</span>
              <span class="text-amber-300 font-bold">{{ currentPolicyLabel(grantModalAppr) }}</span>
            </div>
            <div class="flex justify-between text-surface-400">
              <span>任务状态:</span>
              <span class="text-surface-200">{{ grantModalAppr.taskStatus || 'waiting_approval' }}</span>
            </div>
            <div class="flex justify-between text-surface-400 pt-1 border-t border-surface-800">
              <span>升级目标 (仅后续工具调用):</span>
              <span class="text-emerald-400 font-bold">danger-full-access + allow + auto-grant</span>
            </div>
          </div>

          <div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-xs text-amber-200/90 space-y-1.5">
            <p class="font-semibold text-amber-300">安全审查与硬拦截依然生效：</p>
            <ul class="list-disc list-inside space-y-0.5 text-[11px] text-amber-200/80">
              <li>PreToolSecurityMonitor 确定性硬拦截规则（如 rm -rf /）仍强制阻断；</li>
              <li>安全模型审查未通过或模型服务不可用时，系统依然 Fail-Closed 拒绝；</li>
              <li>授权仅限此 Task/Run，不影响同节点其他任务，不修改全局默认配置。</li>
            </ul>
          </div>

          <label class="flex items-start gap-2.5 text-xs text-surface-200 cursor-pointer pt-1">
            <input
              v-model="grantConfirmed"
              type="checkbox"
              class="mt-0.5 rounded border-surface-700 bg-surface-950 text-amber-500 focus:ring-0"
              :disabled="grantLoading"
            />
            <span>我已充分知晓该任务将具备工作区外文件读写及网络操作能力，明确同意仅为此任务授予全访问权限。</span>
          </label>

          <p v-if="grantError" class="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-lg border border-rose-500/30">
            {{ grantError }}
          </p>

          <div class="flex items-center justify-end gap-3 pt-2">
            <button
              @click="closeGrantModal"
              :disabled="grantLoading"
              class="px-4 py-2 rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 text-xs font-semibold transition-colors"
            >
              取消
            </button>
            <button
              @click="executeGrantTaskFullAccess"
              :disabled="!grantConfirmed || grantLoading"
              class="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-black font-bold text-xs transition-colors flex items-center gap-1.5 shadow-md"
            >
              <span v-if="grantLoading" class="w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin"></span>
              <span>{{ grantLoading ? '正在下发授权并等待 Worker 确认…' : '确认仅此任务启用全访问' }}</span>
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
import { useApprovalsStore } from "../stores/approvals";
import { useI18n } from "../i18n";

import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
import Badge from "../components/ui/Badge.vue";

const uiStore = useUiStore();
const approvalsStore = useApprovalsStore();
const { t } = useI18n();

const grantModalAppr = ref<any>(null);
const grantConfirmed = ref(false);
const grantLoading = ref(false);
const grantError = ref("");

function openGrantModal(appr: any) {
  grantModalAppr.value = appr;
  grantConfirmed.value = false;
  grantLoading.value = false;
  grantError.value = "";
}

function closeGrantModal() {
  if (grantLoading.value) return;
  grantModalAppr.value = null;
  grantConfirmed.value = false;
  grantError.value = "";
}

async function executeGrantTaskFullAccess() {
  if (!grantModalAppr.value || !grantConfirmed.value || grantLoading.value) return;
  grantLoading.value = true;
  grantError.value = "";
  try {
    await approvalsStore.grantTaskFullAccess(grantModalAppr.value.approvalId);
    grantModalAppr.value = null;
  } catch (err: any) {
    grantError.value = err?.message || "下发任务级全访问授权失败，请重试";
  } finally {
    grantLoading.value = false;
  }
}

function canGrant(appr: any): boolean {
  if (appr.grantEligible !== undefined) return Boolean(appr.grantEligible);
  return appr.status === "pending" && !appr.activeGrant && !appr.pendingGrant;
}

function currentPolicyLabel(appr: any): string {
  const policy = appr?.currentPolicy;
  if (!policy) return "未知 (由服务端确认)";
  return `${policy.filesystem?.mode ?? "?"} / network:${policy.network?.mode ?? "?"} / approval:${policy.approval?.mode ?? "?"}`;
}

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

const historyApprovals = computed(() => {
  return approvalsStore.approvals.filter((a) => a.status !== "pending");
});

onMounted(async () => {
  await approvalsStore.loadApprovals();
});
</script>
