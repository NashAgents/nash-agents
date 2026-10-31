import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api } from "../services/api.js";
import { globalClusterSse } from "../services/sse.js";
import { useApprovalsStore } from "./approvals.js";

export const useClusterStore = defineStore("cluster", () => {
  const nodes = ref<any[]>([]);
  const status = ref<any>(null);
  const loading = ref(false);
  const sseConnected = ref(false);
  const error = ref("");

  const activeNodes = computed(() => nodes.value.filter(node => node.status !== "revoked"));
  const historicalNodes = computed(() => nodes.value.filter(node => node.status === "revoked"));
  const onlineNodes = computed(() => {
    return nodes.value.filter((n) => n.status === "online");
  });
  const onlineNodesCount = computed(() => {
    if (typeof status.value?.onlineNodes === "number") {
      return status.value.onlineNodes;
    }
    return onlineNodes.value.length;
  });
  const runningTasksCount = computed(() => status.value?.runningTasks ?? 0);
  const pendingApprovalsCount = computed(() => {
    try {
      const approvalsStore = useApprovalsStore();
      if (approvalsStore.isLoaded || approvalsStore.approvals.length > 0) {
        return approvalsStore.pendingApprovals.length;
      }
    } catch {}
    return status.value?.pendingApprovals ?? 0;
  });

  function setPendingApprovals(count: number) {
    if (!status.value) {
      status.value = { pendingApprovals: Math.max(0, count) };
    } else {
      status.value.pendingApprovals = Math.max(0, count);
    }
  }

  function decrementPendingApprovals(step = 1) {
    if (status.value && typeof status.value.pendingApprovals === "number") {
      status.value.pendingApprovals = Math.max(0, status.value.pendingApprovals - step);
    }
  }

  function incrementPendingApprovals(step = 1) {
    if (status.value && typeof status.value.pendingApprovals === "number") {
      status.value.pendingApprovals = status.value.pendingApprovals + step;
    } else if (!status.value) {
      status.value = { pendingApprovals: step };
    }
  }

  async function loadCluster() {
    loading.value = true;
    error.value = "";
    try {
      const [statusRes, nodesRes] = await Promise.all([
        api.getClusterStatus(),
        api.getNodes(),
      ]);
      status.value = statusRes;
      nodes.value = nodesRes.nodes;
    } catch (err) {
      error.value = "集群状态暂时不可用";
      status.value = null;
      console.warn("Failed to load cluster state:", err);
    } finally {
      loading.value = false;
    }
  }

  function startSseListener() {
    return globalClusterSse.subscribe((event: any) => {
      if (event.type === "transport.error" || event.type === "transport.closed") {
        sseConnected.value = false;
        if (event.type === "transport.error") void api.getMe().catch(() => {});
        return;
      }
      if (event.type === "transport.open") {
        sseConnected.value = true;
        void loadCluster();
        return;
      }
      if (event.type === "cluster.snapshot") {
        status.value = {
          ...status.value,
          onlineNodes: event.data.onlineNodes,
          totalNodes: event.data.totalNodes,
          historicalNodes: event.data.historicalNodes,
          runningTasks: event.data.runningTasks,
          pendingApprovals: event.data.pendingApprovals,
          activeGraphs: event.data.activeGraphs,
        };
        // 若节点列表为空或在线数不一致，自动刷新节点详情
        if (nodes.value.length === 0 || event.data.onlineNodes !== onlineNodes.value.length) {
          loadCluster();
        }
      } else if (event.type === "cluster.heartbeat") {
        if (status.value) {
          status.value.onlineNodes = event.data.onlineNodes;
          status.value.pendingApprovals = event.data.pendingApprovals;
          if (typeof event.data.runningTasks === "number") {
            status.value.runningTasks = event.data.runningTasks;
          }
        }
      } else if (event.type === "approval.requested") {
        if (typeof event.data?.pendingApprovals === "number") {
          setPendingApprovals(event.data.pendingApprovals);
        } else {
          try {
            const approvalsStore = useApprovalsStore();
            if (approvalsStore.isLoaded || approvalsStore.approvals.length > 0) {
              setPendingApprovals(approvalsStore.pendingApprovals.length);
            } else {
              incrementPendingApprovals();
            }
          } catch {
            incrementPendingApprovals();
          }
        }
      } else if (event.type === "approval.resolved") {
        if (typeof event.data?.pendingApprovals === "number") {
          setPendingApprovals(event.data.pendingApprovals);
        } else {
          try {
            const approvalsStore = useApprovalsStore();
            if (approvalsStore.isLoaded || approvalsStore.approvals.length > 0) {
              setPendingApprovals(approvalsStore.pendingApprovals.length);
            } else {
              decrementPendingApprovals();
            }
          } catch {
            decrementPendingApprovals();
          }
        }
      } else if (event.type === "task.started") {
        if (status.value) {
          status.value.runningTasks = (status.value.runningTasks || 0) + 1;
        }
      } else if (
        event.type === "task.completed" ||
        event.type === "task.failed" ||
        event.type === "task.cancelled"
      ) {
        if (status.value) {
          status.value.runningTasks = Math.max(0, (status.value.runningTasks || 0) - 1);
        }
      }
    });
  }

  return {
    nodes,
    error,
    status,
    loading,
    sseConnected,
    activeNodes,
    historicalNodes,
    onlineNodes,
    onlineNodesCount,
    runningTasksCount,
    pendingApprovalsCount,
    setPendingApprovals,
    decrementPendingApprovals,
    incrementPendingApprovals,
    loadCluster,
    startSseListener,
  };
});
