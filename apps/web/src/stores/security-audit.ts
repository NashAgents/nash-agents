import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../services/api";

export interface SecurityAuditItem {
  id: string;
  timestamp: number;
  toolName: string;
  argsFingerprint: string;
  sanitizedArgs: Record<string, unknown>;
  rawArgsSnippet: string;
  decisionSource: "LLM_MONITOR" | "DETERMINISTIC_POLICY" | "USER_APPROVAL" | "SYSTEM_FAILURE";
  verdict: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
  severity: number;
  riskCategory: string;
  ruleName?: string;
  reason: string;
  decisionEvidence?: string;
  agentId: string;
  nodeId?: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  durationMs: number;
  isHardBlock: boolean;
  tokensUsed?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  modelVersion?: string;
  reviewFeedback: {
    status: "unreviewed" | "confirmed_risk" | "false_positive" | "needs_investigation";
    reviewedAt?: number;
    reviewedBy?: string;
    comment?: string;
  };
  createdAt: number;
}

export interface SecurityAuditStats {
  totalCount: number;
  allowCount: number;
  blockCount: number;
  requireApprovalCount: number;
  sourceCounts: Record<string, number>;
  falsePositiveCount: number;
  topRiskCategories: Array<{ category: string; count: number }>;
}

export const useSecurityAuditStore = defineStore("securityAudit", () => {
  const audits = ref<SecurityAuditItem[]>([]);
  const total = ref(0);
  const selectedAudit = ref<SecurityAuditItem | null>(null);
  const stats = ref<SecurityAuditStats>({
    totalCount: 0,
    allowCount: 0,
    blockCount: 0,
    requireApprovalCount: 0,
    sourceCounts: {},
    falsePositiveCount: 0,
    topRiskCategories: [],
  });
  const loading = ref(false);
  const loadingStats = ref(false);
  const submittingFeedback = ref(false);
  const error = ref<string | null>(null);

  async function loadAudits(filter?: any) {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.listSecurityAudits(filter);
      audits.value = res.items || [];
      total.value = res.total || 0;
    } catch (err: any) {
      error.value = err?.message || String(err);
    } finally {
      loading.value = false;
    }
  }

  async function loadStats(windowMs?: number) {
    loadingStats.value = true;
    try {
      const res = await api.getSecurityAuditStats(windowMs);
      stats.value = res;
    } finally {
      loadingStats.value = false;
    }
  }

  async function submitFeedback(id: string, feedback: { status: string; comment?: string }) {
    submittingFeedback.value = true;
    try {
      const res = await api.submitSecurityAuditFeedback(id, feedback);
      const idx = audits.value.findIndex((a) => a.id === id);
      if (idx !== -1 && res.audit) {
        audits.value[idx] = res.audit;
      }
      if (selectedAudit.value?.id === id && res.audit) {
        selectedAudit.value = res.audit;
      }
      return res;
    } finally {
      submittingFeedback.value = false;
    }
  }

  function selectAudit(audit: SecurityAuditItem | null) {
    selectedAudit.value = audit;
  }

  return {
    audits,
    total,
    selectedAudit,
    stats,
    loading,
    loadingStats,
    submittingFeedback,
    error,
    loadAudits,
    loadStats,
    submitFeedback,
    selectAudit,
  };
});
