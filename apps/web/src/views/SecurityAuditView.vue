<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-6xl mx-auto w-full">
      <!-- 顶部标题与刷新 -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-surface-800 mb-6 gap-3">
        <div>
          <h2 class="text-lg font-bold text-surface-100 tracking-tight flex items-center gap-2">
            <span>{{ t.securityAudit.title }}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30">
              Pre-Tool Monitor Audit Trail
            </span>
          </h2>
          <p class="text-xs text-surface-400 mt-0.5">
            {{ t.securityAudit.subtitle }}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="refreshData"
            class="px-3.5 py-2 rounded-lg bg-surface-900 border border-surface-700 text-xs font-mono text-surface-300 hover:text-surface-100 transition-colors flex items-center gap-1.5"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>刷新审计流水</span>
          </button>
        </div>
      </div>

      <!-- 安全态势指标 KPI 卡片 -->
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-surface-400 uppercase tracking-wider">审查调用总量</div>
          <div class="text-xl font-bold text-surface-100 mt-1 font-mono">
            {{ securityAuditStore.stats.totalCount }}
          </div>
        </div>
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-rose-900/40 bg-rose-950/10">
          <div class="text-[11px] font-mono text-rose-400 uppercase tracking-wider">安全拦截 (BLOCK)</div>
          <div class="text-xl font-bold text-rose-400 mt-1 font-mono">
            {{ securityAuditStore.stats.blockCount }}
          </div>
        </div>
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-emerald-400 uppercase tracking-wider">安全放行 (ALLOW)</div>
          <div class="text-xl font-bold text-emerald-400 mt-1 font-mono">
            {{ securityAuditStore.stats.allowCount }}
          </div>
        </div>
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-amber-400 uppercase tracking-wider">审批升级 (APPROVAL)</div>
          <div class="text-xl font-bold text-amber-400 mt-1 font-mono">
            {{ securityAuditStore.stats.requireApprovalCount }}
          </div>
        </div>
        <div class="p-3.5 rounded-xl bg-surface-900/80 border border-surface-800">
          <div class="text-[11px] font-mono text-blue-400 uppercase tracking-wider">复核标记数</div>
          <div class="text-xl font-bold text-blue-400 mt-1 font-mono">
            {{ securityAuditStore.stats.falsePositiveCount }}
          </div>
        </div>
      </div>

      <!-- 筛选与搜索工具条 -->
      <div class="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <!-- 判定结果筛选 -->
          <select
            v-model="filterVerdict"
            @change="triggerSearch"
            class="bg-surface-900 border border-surface-800 rounded-lg px-2.5 py-1.5 text-xs text-surface-200 font-mono focus:outline-none focus:border-nash-500"
          >
            <option value="">{{ t.securityAudit.filterAllVerdict }}</option>
            <option value="BLOCK">仅看拦截 (BLOCK)</option>
            <option value="ALLOW">仅看放行 (ALLOW)</option>
            <option value="REQUIRE_APPROVAL">仅看审批 (APPROVAL)</option>
          </select>

          <!-- 决策来源筛选 -->
          <select
            v-model="filterSource"
            @change="triggerSearch"
            class="bg-surface-900 border border-surface-800 rounded-lg px-2.5 py-1.5 text-xs text-surface-200 font-mono focus:outline-none focus:border-nash-500"
          >
            <option value="">{{ t.securityAudit.filterAllSource }}</option>
            <option value="LLM_MONITOR">独立模型 (LLM_MONITOR)</option>
            <option value="DETERMINISTIC_POLICY">确定性策略 (DETERMINISTIC)</option>
            <option value="USER_APPROVAL">用户审批 (USER_APPROVAL)</option>
            <option value="SYSTEM_FAILURE">系统降级 (SYSTEM_FAILURE)</option>
          </select>

          <!-- 复核状态筛选 -->
          <select
            v-model="filterReview"
            @change="triggerSearch"
            class="bg-surface-900 border border-surface-800 rounded-lg px-2.5 py-1.5 text-xs text-surface-200 font-mono focus:outline-none focus:border-nash-500"
          >
            <option value="">全部复核状态</option>
            <option value="unreviewed">未复核</option>
            <option value="false_positive">标记为误判</option>
            <option value="confirmed_risk">确认为风险</option>
          </select>
        </div>

        <div class="relative w-full md:w-64">
          <input
            v-model="searchKeyword"
            type="text"
            @keyup.enter="triggerSearch"
            :placeholder="t.securityAudit.searchPlaceholder"
            class="w-full bg-surface-900 border border-surface-800 rounded-lg px-3 py-1.5 text-xs text-surface-100 placeholder-surface-500 focus:outline-none focus:border-nash-500 font-sans"
          />
        </div>
      </div>

      <!-- 审计流水表格 -->
      <div class="rounded-xl border border-surface-800 bg-surface-900/40 overflow-hidden shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-surface-900 text-surface-400 border-b border-surface-800 font-mono text-[11px]">
              <tr>
                <th class="py-3 px-4">审查时间</th>
                <th class="py-3 px-3">目标工具 / Agent</th>
                <th class="py-3 px-3">判定结果</th>
                <th class="py-3 px-3">决策来源</th>
                <th class="py-3 px-3">威胁分类与规则</th>
                <th class="py-3 px-3">严重级别</th>
                <th class="py-3 px-4">判定原因与分析</th>
                <th class="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-surface-800/60 font-sans">
              <tr
                v-for="item in securityAuditStore.audits"
                :key="item.id"
                class="hover:bg-surface-800/40 transition-colors group cursor-pointer"
                @click="openDetails(item)"
              >
                <!-- 时间 -->
                <td class="py-3 px-4 font-mono text-[11px] text-surface-400 whitespace-nowrap">
                  {{ formatTime(item.timestamp) }}
                </td>

                <!-- 工具与主体 -->
                <td class="py-3 px-3 font-mono text-[11px]">
                  <div class="font-bold text-surface-200">{{ item.toolName }}</div>
                  <div class="text-[10px] text-surface-500 truncate max-w-[100px]">
                    {{ item.agentId || 'main' }}
                  </div>
                </td>

                <!-- 判定结果 -->
                <td class="py-3 px-3">
                  <span
                    :class="[
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold',
                      item.verdict === 'ALLOW'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : item.verdict === 'BLOCK'
                        ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                        : 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
                    ]"
                  >
                    <span>{{ item.verdict }}</span>
                    <span v-if="item.isHardBlock" class="text-[9px] px-1 rounded bg-rose-950 text-rose-300 font-extrabold">HARD</span>
                  </span>
                </td>

                <!-- 决策来源 -->
                <td class="py-3 px-3 font-mono text-[10px]">
                  <span
                    :class="[
                      'px-1.5 py-0.5 rounded font-medium',
                      item.decisionSource === 'LLM_MONITOR'
                        ? 'bg-purple-500/20 text-purple-300'
                        : item.decisionSource === 'DETERMINISTIC_POLICY'
                        ? 'bg-blue-500/20 text-blue-300'
                        : item.decisionSource === 'USER_APPROVAL'
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-rose-500/20 text-rose-300',
                    ]"
                  >
                    {{ item.decisionSource }}
                  </span>
                </td>

                <!-- 威胁分类 -->
                <td class="py-3 px-3 max-w-[140px]">
                  <div class="font-medium text-surface-200 truncate" :title="item.riskCategory">
                    {{ item.riskCategory || 'Routine' }}
                  </div>
                  <div v-if="item.ruleName" class="text-[10px] text-surface-500 font-mono truncate" :title="item.ruleName">
                    {{ item.ruleName }}
                  </div>
                </td>

                <!-- 严重分级 -->
                <td class="py-3 px-3 font-mono text-[11px]">
                  <div class="flex items-center gap-1.5">
                    <span :class="[item.severity >= 50 ? 'text-rose-400 font-bold' : 'text-emerald-400']">
                      {{ item.severity }}
                    </span>
                    <div class="w-12 h-1.5 bg-surface-800 rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full transition-all"
                        :class="item.severity >= 80 ? 'bg-rose-500' : item.severity >= 50 ? 'bg-amber-500' : 'bg-emerald-500'"
                        :style="{ width: `${item.severity}%` }"
                      />
                    </div>
                  </div>
                </td>

                <!-- 原因摘要 -->
                <td class="py-3 px-4 max-w-xs">
                  <div class="text-[11px] text-surface-300 line-clamp-2" :title="item.reason">
                    {{ item.reason }}
                  </div>
                </td>

                <!-- 操作按钮 -->
                <td class="py-3 px-4 text-right" @click.stop>
                  <button
                    @click="openDetails(item)"
                    class="px-2.5 py-1 rounded bg-surface-800 hover:bg-surface-700 text-surface-200 font-medium text-xs transition-colors"
                  >
                    详情与复核
                  </button>
                </td>
              </tr>

              <tr v-if="securityAuditStore.audits.length === 0">
                <td colspan="8" class="py-12 text-center text-surface-500">
                  <div class="flex flex-col items-center justify-center gap-2">
                    <svg class="w-8 h-8 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <span>{{ t.securityAudit.noRecords }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 审计详情与误判复核 Slide-over Drawer -->
      <div
        v-if="showDetailDrawer"
        class="fixed inset-0 z-50 overflow-hidden flex justify-end"
      >
        <div class="absolute inset-0 bg-black/50 backdrop-blur-xs transition-opacity" @click="showDetailDrawer = false"></div>
        <div class="relative w-full max-w-xl bg-surface-950 border-l border-surface-800 h-full shadow-2xl flex flex-col p-6 z-10 overflow-y-auto">
          <!-- 抽屉头部 -->
          <div class="flex items-center justify-between pb-4 border-b border-surface-800 mb-4">
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-bold text-surface-100 font-mono">
                  {{ securityAuditStore.selectedAudit?.toolName }}
                </h3>
                <span
                  :class="[
                    'px-2 py-0.5 rounded text-[10px] font-bold font-mono',
                    securityAuditStore.selectedAudit?.verdict === 'ALLOW'
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : securityAuditStore.selectedAudit?.verdict === 'BLOCK'
                      ? 'bg-rose-500/20 text-rose-400'
                      : 'bg-amber-500/20 text-amber-400',
                  ]"
                >
                  {{ securityAuditStore.selectedAudit?.verdict }}
                </span>
                <span v-if="securityAuditStore.selectedAudit?.isHardBlock" class="px-1.5 py-0.5 rounded text-[10px] bg-rose-950 text-rose-300 font-mono font-extrabold border border-rose-800">
                  HARD BLOCK
                </span>
              </div>
              <p class="text-[11px] text-surface-400 font-mono mt-0.5">
                Audit ID: {{ securityAuditStore.selectedAudit?.id }}
              </p>
            </div>
            <button
              @click="showDetailDrawer = false"
              class="p-1.5 text-surface-400 hover:text-surface-100 rounded-lg hover:bg-surface-800 transition-colors"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- 抽屉正文 -->
          <div v-if="securityAuditStore.selectedAudit" class="space-y-4 flex-1 overflow-y-auto custom-scrollbar pr-1 text-xs">
            <!-- 决策元数据 -->
            <div class="grid grid-cols-2 gap-3 p-3 rounded-xl bg-surface-900 border border-surface-800 font-mono text-[11px]">
              <div>
                <span class="text-surface-500">判定来源:</span>
                <span class="text-surface-200 ml-1.5 font-bold">{{ securityAuditStore.selectedAudit.decisionSource }}</span>
              </div>
              <div>
                <span class="text-surface-500">风险评分:</span>
                <span class="text-surface-200 ml-1.5 font-bold">{{ securityAuditStore.selectedAudit.severity }}/100</span>
              </div>
              <div>
                <span class="text-surface-500">威胁分类:</span>
                <span class="text-surface-200 ml-1.5">{{ securityAuditStore.selectedAudit.riskCategory }}</span>
              </div>
              <div>
                <span class="text-surface-500">审查耗时:</span>
                <span class="text-surface-200 ml-1.5">{{ securityAuditStore.selectedAudit.durationMs }}ms</span>
              </div>
              <div class="col-span-2 truncate">
                <span class="text-surface-500">执行节点/任务:</span>
                <span class="text-surface-300 ml-1.5">{{ securityAuditStore.selectedAudit.nodeId || '本地' }} · {{ securityAuditStore.selectedAudit.taskId || '主协同会话' }}</span>
              </div>
            </div>

            <!-- 判定原因与证据 -->
            <div>
              <div class="font-semibold text-surface-200 mb-1 flex items-center gap-1.5">
                <span>{{ t.securityAudit.reasonLabel }}</span>
              </div>
              <div class="p-3 rounded-lg bg-surface-900 border border-surface-800 text-surface-300 leading-relaxed font-sans">
                {{ securityAuditStore.selectedAudit.reason }}
              </div>
            </div>

            <div v-if="securityAuditStore.selectedAudit.decisionEvidence">
              <div class="font-semibold text-surface-200 mb-1">
                <span>{{ t.securityAudit.decisionEvidenceTitle }}</span>
              </div>
              <pre class="p-3 rounded-lg bg-surface-950 border border-surface-800 font-mono text-[11px] text-surface-300 overflow-x-auto whitespace-pre-wrap">{{ securityAuditStore.selectedAudit.decisionEvidence }}</pre>
            </div>

            <!-- 脱敏工具参数指纹 -->
            <div>
              <div class="font-semibold text-surface-200 mb-1 flex items-center justify-between">
                <span>{{ t.securityAudit.sanitizedArgsTitle }}</span>
                <span class="text-[10px] font-mono text-surface-500 truncate max-w-[200px]" :title="securityAuditStore.selectedAudit.argsFingerprint">
                  SHA-256: {{ securityAuditStore.selectedAudit.argsFingerprint.slice(0, 16) }}...
                </span>
              </div>
              <pre class="p-3 rounded-lg bg-surface-950 border border-surface-800 font-mono text-[11px] text-nash-300 overflow-x-auto">{{ JSON.stringify(securityAuditStore.selectedAudit.sanitizedArgs, null, 2) }}</pre>
            </div>

            <!-- 确定性 Hard Block 警告提示 -->
            <div
              v-if="securityAuditStore.selectedAudit.isHardBlock"
              class="p-3 rounded-xl bg-rose-950/40 border border-rose-800/80 text-rose-300 text-xs flex items-start gap-2.5 leading-relaxed"
            >
              <svg class="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <span class="font-bold">硬安全拦截铁律：</span>
                <span>{{ t.securityAudit.hardBlockNotice }}</span>
              </div>
            </div>

            <!-- 误判复核表单 -->
            <div class="p-4 rounded-xl bg-surface-900 border border-surface-800 space-y-3 mt-4">
              <div class="font-semibold text-surface-100 flex items-center justify-between">
                <span>人工审查与误判复核</span>
                <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-surface-800 text-surface-300">
                  当前状态: {{ securityAuditStore.selectedAudit.reviewFeedback.status }}
                </span>
              </div>

              <div>
                <label class="block text-surface-400 mb-1 text-[11px]">审查结论 *</label>
                <select
                  v-model="feedbackForm.status"
                  class="w-full bg-surface-950 border border-surface-800 rounded-lg px-3 py-2 text-surface-200 focus:outline-none focus:border-nash-500 font-sans"
                >
                  <option value="unreviewed">未审查 (Unreviewed)</option>
                  <option value="false_positive">标记为误判 (False Positive) - 本操作实际安全</option>
                  <option value="confirmed_risk">确认属于真实风险 (Confirmed Risk) - 拦截正确</option>
                  <option value="needs_investigation">需进一步调查 (Needs Investigation)</option>
                </select>
              </div>

              <div>
                <label class="block text-surface-400 mb-1 text-[11px]">复核批注与依据说明 (可选)</label>
                <textarea
                  v-model="feedbackForm.comment"
                  rows="2"
                  placeholder="例如: 脚本中的删除指令仅指向工作区内部构建目录，属于正常测试清理"
                  class="w-full bg-surface-950 border border-surface-800 rounded-lg px-3 py-1.5 text-surface-100 focus:outline-none focus:border-nash-500"
                ></textarea>
              </div>

              <div class="flex items-center justify-end gap-2 pt-1">
                <button
                  @click="submitReview"
                  :disabled="securityAuditStore.submittingFeedback"
                  class="px-4 py-2 rounded-lg bg-nash-500 hover:bg-nash-600 disabled:opacity-50 text-white font-medium text-xs shadow-sm transition-all"
                >
                  {{ securityAuditStore.submittingFeedback ? '提交中...' : '提交复核结论' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useUiStore } from "../stores/ui";
import { useSecurityAuditStore, type SecurityAuditItem } from "../stores/security-audit";
import { useI18n } from "../i18n";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

const uiStore = useUiStore();
const securityAuditStore = useSecurityAuditStore();
const { t } = useI18n();

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

const filterVerdict = ref("");
const filterSource = ref("");
const filterReview = ref("");
const searchKeyword = ref("");
const showDetailDrawer = ref(false);

const feedbackForm = ref({
  status: "unreviewed",
  comment: "",
});

function formatTime(timestamp: number): string {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function triggerSearch() {
  securityAuditStore.loadAudits({
    verdict: filterVerdict.value || undefined,
    decisionSource: filterSource.value || undefined,
    reviewStatus: filterReview.value || undefined,
    riskCategory: searchKeyword.value || undefined,
  });
}

function refreshData() {
  triggerSearch();
  securityAuditStore.loadStats();
}

function openDetails(item: SecurityAuditItem) {
  securityAuditStore.selectAudit(item);
  feedbackForm.value = {
    status: item.reviewFeedback?.status || "unreviewed",
    comment: item.reviewFeedback?.comment || "",
  };
  showDetailDrawer.value = true;
}

async function submitReview() {
  if (!securityAuditStore.selectedAudit) return;
  try {
    const res = await securityAuditStore.submitFeedback(securityAuditStore.selectedAudit.id, {
      status: feedbackForm.value.status,
      comment: feedbackForm.value.comment,
    });
    if (res?.warning) {
      alert(`复核已保存！\n\n${res.warning}`);
    } else {
      alert("复核结论已成功保存！");
    }
  } catch (err: any) {
    alert(`提交失败: ${err?.message || err}`);
  }
}

onMounted(() => {
  securityAuditStore.loadAudits();
  securityAuditStore.loadStats();
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
