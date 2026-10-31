import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../services/api.js";
import { createGraphSse, type SseConnection } from "../services/sse.js";

export const useGraphsStore = defineStore("graphs", () => {
  const graphs = ref<any[]>([]);
  const currentGraph = ref<any>(null);
  const currentSnapshot = ref<any>(null);
  const currentNodes = ref<any[]>([]);
  const currentEdges = ref<any[]>([]);
  const currentRevisions = ref<any[]>([]);
  const currentVerifications = ref<any[]>([]);
  const currentArtifacts = ref<any[]>([]);
  const currentEvents = ref<any[]>([]);
  const currentGoalEvaluation = ref<any>(null);
  const currentProvenance = ref<any>(null);
  const loading = ref(false);

  let detailRequest = 0;
  let snapshotRequest = 0;
  const error = ref("");
  let selectedGraphId: string | null = null;
  let activeSse: SseConnection | null = null;
  let sseUnsubscribe: (() => void) | null = null;

  async function loadGraphs() {
    loading.value = true;
    try {
      const res = await api.listGraphs({ limit: 30 });
      graphs.value = res.graphs;
    } catch (err: any) { error.value = err.message || "任务图列表加载失败"; }
    finally {
      loading.value = false;
    }
  }

  async function loadGraphDetails(graphId: string) {
    const request = ++detailRequest;
    snapshotRequest++;
    error.value = "";
    currentGraph.value = null;
    currentSnapshot.value = null;
    currentNodes.value = [];
    currentEdges.value = [];
    currentRevisions.value = [];
    currentVerifications.value = [];
    currentArtifacts.value = [];
    currentEvents.value = [];
    currentGoalEvaluation.value = null;
    currentProvenance.value = null;
    selectedGraphId = graphId;
    loading.value = true;
    if (activeSse) {
      activeSse.close();
      activeSse = null;
    }
    if (sseUnsubscribe) {
      sseUnsubscribe();
      sseUnsubscribe = null;
    }

    try {
      const res = await api.getGraph(graphId);
      if (request !== detailRequest) return;
      currentGraph.value = res.graph;
      currentSnapshot.value = res.snapshot;
      currentNodes.value = res.nodes || [];
      currentEdges.value = res.edges || [];
      currentRevisions.value = res.revisions || [];
      currentVerifications.value = res.verifications || [];
      currentArtifacts.value = res.artifacts || [];
      currentEvents.value = res.events || [];
      currentGoalEvaluation.value = res.goalEvaluation || null;
      currentProvenance.value = res.provenance || null;

      // 建立针对该 Graph 的实时 SSE
      activeSse = createGraphSse(graphId);
      sseUnsubscribe = activeSse.subscribe((event) => {
        handleGraphEvent(event);
      });
    } catch (err: any) {
      if (request === detailRequest) error.value = err.message || "任务图加载失败";
    } finally {
      if (request === detailRequest) loading.value = false;
    }
  }

  function handleGraphEvent(event: { type: string; data: any }) {
    const { type, data } = event;
    if (data?.graphId && data.graphId !== selectedGraphId) return;
    if (type === "graph.end" && currentGraph.value) currentGraph.value.status = data.status;
    if (type === "graph.node_activity") {
      const node = currentNodes.value.find((n) => n.nodeId === data.nodeId && n.taskId === data.taskId);
      if (node) node.status = data.status;
    }
    if (["graph.node_activity", "transport.open", "graph.paused", "graph.resumed", "graph.replan_committed", "graph.revision_committed", "graph.replanned", "graph.replan_started", "graph.node_dispatched", "graph.node_waiting_approval", "graph.node_cancelled", "graph.node_skipped", "graph.started", "graph.failed", "graph.partially_completed", "graph.outcome_unknown", "graph.node_completed", "graph.node_failed", "graph.cancelled", "graph.completed", "graph.task_dispatched", "graph.node_blocked"].includes(type)) {
      const graphId = selectedGraphId;
      const request = detailRequest;
      const snapshot = ++snapshotRequest;
      if (graphId) void api.getGraph(graphId).then((res) => {
        if (request !== detailRequest || snapshot !== snapshotRequest || graphId !== selectedGraphId) return;
        currentGraph.value = res.graph; currentSnapshot.value = res.snapshot;
        currentNodes.value = res.nodes || []; currentEdges.value = res.edges || [];
        currentRevisions.value = res.revisions || [];
        currentVerifications.value = res.verifications || [];
        currentArtifacts.value = res.artifacts || [];
        currentEvents.value = res.events || [];
        currentGoalEvaluation.value = res.goalEvaluation || null;
      currentProvenance.value = res.provenance || null;
      }).catch(() => {});
    }
    if (type === "graph.node_ready") {
      const node = currentNodes.value.find((n) => n.nodeId === data.nodeId);
      if (node) node.status = "ready";
    } else if (["graph.task_dispatched", "graph.node_dispatched"].includes(type)) {
      const node = currentNodes.value.find((n) => n.nodeId === data.nodeId);
      if (node) {
        node.status = "dispatched";
        node.taskId = data.taskId;
        node.assignedNodeId = data.targetNodeId || data.assignedNodeId || node.assignedNodeId;
        node.assignedProjectId = data.targetProjectId || data.assignedProjectId || node.assignedProjectId;
      }
    } else if (type === "graph.node_completed") {
      const node = currentNodes.value.find((n) => n.nodeId === data.nodeId);
      if (node) {
        node.status = "completed";
        node.resultSummary = data.resultSummary;
      }
    } else if (type === "graph.node_failed") {
      const node = currentNodes.value.find((n) => n.nodeId === data.nodeId);
      if (node) {
        node.status = "failed";
        node.error = data.error;
      }
    } else if (type === "graph.node_blocked") {
      const node = currentNodes.value.find((n) => n.nodeId === data.nodeId);
      if (node) node.status = "blocked";
    } else if (["graph.node_cancelled", "graph.node_skipped", "graph.node_waiting_approval"].includes(type)) {
      const node = currentNodes.value.find(n => n.nodeId === data.nodeId);
      if (node) node.status = type.slice("graph.node_".length);
    } else if (type === "graph.completed") {
      if (currentGraph.value) currentGraph.value.status = "completed";
    } else if (type === "graph.cancelled") {
      if (currentGraph.value) currentGraph.value.status = "cancelled";
    }
  }

  async function steer(graphId: string, instruction: string) {
    return api.steerGraph(graphId, instruction);
  }

  async function pause(graphId: string) {
    const result = await api.pauseGraph(graphId);
    if (currentGraph.value?.graphId === graphId) currentGraph.value.status = result.status ?? "paused";
  }

  async function resume(graphId: string) {
    const result = await api.resumeGraph(graphId);
    if (currentGraph.value?.graphId === graphId) currentGraph.value.status = result.status ?? "running";
  }

  async function cancel(graphId: string, reason?: string) {
    const result = await api.cancelGraph(graphId, reason);
    if (currentGraph.value?.graphId === graphId) currentGraph.value.status = result.status ?? "cancelling";
  }

  async function replan(graphId: string, reason?: string, failedNodeId?: string) {
    const res = await api.replanGraph(graphId, reason, failedNodeId);
    await loadGraphDetails(graphId);
    return res;
  }

  function cleanup() {
    detailRequest++;
    selectedGraphId = null;
    if (activeSse) {
      activeSse.close();
      activeSse = null;
    }
    if (sseUnsubscribe) {
      sseUnsubscribe();
      sseUnsubscribe = null;
    }
  }

  return {
    graphs,
    error,
    currentGraph,
    currentSnapshot,
    currentNodes,
    currentEdges,
    currentRevisions,
    currentVerifications,
    currentArtifacts,
    currentEvents,
    currentGoalEvaluation,
    currentProvenance,
    loading,
    loadGraphs,
    loadGraphDetails,
    steer,
    pause,
    resume,
    cancel,
    replan,
    cleanup,
  };
});
