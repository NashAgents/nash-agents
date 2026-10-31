import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api } from "../services/api.js";
import { globalClusterSse } from "../services/sse.js";
import { useClusterStore } from "./cluster.js";

function approvalStatusForDecision(decision: string | undefined): "approved" | "denied" {
  // 显式穷举，未知裁决一律不静默当作放行。
  if (decision === "deny") return "denied";
  if (decision === "allow-once" || decision === "grant-task-full-access") return "approved";
  return "denied";
}

export const useApprovalsStore = defineStore("approvals", () => {
  const approvals = ref<any[]>([]);
  const loading = ref(false);
  const isLoaded = ref(false);

  const pendingApprovals = computed(() =>
    approvals.value.filter((a) => a.status === "pending" && (!a.expiresAt || a.expiresAt > Date.now()))
  );

  let snapshotRequest = 0;

  async function loadApprovals() {
    const request = ++snapshotRequest;
    loading.value = true;
    try {
      const res = await api.listApprovals();
      if (request === snapshotRequest) {
        approvals.value = [...res.approvals, ...(res.history ?? [])];
        isLoaded.value = true;
        const clusterStore = useClusterStore();
        clusterStore.setPendingApprovals(pendingApprovals.value.length);
      }
    } finally {
      if (request === snapshotRequest) loading.value = false;
    }
  }

  async function resolve(approvalId: string, decision: "allow-once" | "deny") {
    const clusterStore = useClusterStore();
    const item = approvals.value.find((a) => a.approvalId === approvalId);
    const prevStatus = item?.status;

    // 乐观即时更新本地审批项状态与全局待办徽标计数
    if (item) {
      item.status = decision === "allow-once" ? "approved" : "denied";
    }
    clusterStore.decrementPendingApprovals();

    try {
      await api.resolveApproval(approvalId, decision);
      clusterStore.setPendingApprovals(pendingApprovals.value.length);
    } catch (err) {
      if (item && prevStatus) {
        item.status = prevStatus;
      }
      clusterStore.setPendingApprovals(pendingApprovals.value.length);
      throw err;
    }
  }

  async function grantTaskFullAccess(approvalId: string) {
    const clusterStore = useClusterStore();
    const item = approvals.value.find((a) => a.approvalId === approvalId);
    const prevStatus = item?.status;

    // 不修改条目状态：服务端在 Worker 确认前仍视其为 pending，列表必须保持一致。
    try {
      const res = await api.grantTaskFullAccess(approvalId);
      if (item) {
        item.status = "approved";
        item.decision = "grant-task-full-access";
        item.grantId = res.grantId;
      }
      clusterStore.decrementPendingApprovals();
      clusterStore.setPendingApprovals(pendingApprovals.value.length);
      void loadApprovals().catch(() => {});
      return res;
    } catch (err) {
      if (item && prevStatus) {
        item.status = prevStatus;
      }
      clusterStore.setPendingApprovals(pendingApprovals.value.length);
      // 失败可能留下 pendingGrant / revocation_pending：以服务端为准刷新。
      void loadApprovals().catch(() => {});
      throw err;
    }
  }

  function startSseListener() {
    return globalClusterSse.subscribe((event) => {
      if (["transport.open", "cluster.snapshot", "cluster.heartbeat"].includes(event.type)) {
        void loadApprovals().catch(() => {});
      } else if (event.type === "approval.requested") {
        snapshotRequest++;
        approvals.value = [{ ...event.data, status: "pending" }, ...approvals.value.filter((a) => a.approvalId !== event.data.approvalId)];
        isLoaded.value = true;
        const clusterStore = useClusterStore();
        clusterStore.setPendingApprovals(pendingApprovals.value.length);
      } else if (event.type === "approval.resolved") {
        snapshotRequest++;
        const item = approvals.value.find((a) => a.approvalId === event.data.approvalId);
        if (item) {
          item.status = approvalStatusForDecision(event.data.decision);
          item.decision = event.data.decision;
          if (event.data.grantId) item.grantId = event.data.grantId;
        }
        isLoaded.value = true;
        const clusterStore = useClusterStore();
        clusterStore.setPendingApprovals(pendingApprovals.value.length);
      } else if (["task.grant_applied", "task.grant_revoked", "task.grant_unconfirmed"].includes(event.type)) {
        // 授权状态变化以服务端持久化记录为准，刷新快照而不是凭事件猜测。
        void loadApprovals().catch(() => {});
      }
    });
  }

  return {
    approvals,
    pendingApprovals,
    loading,
    isLoaded,
    loadApprovals,
    resolve,
    grantTaskFullAccess,
    startSseListener,
  };
});
