import { defineStore } from "pinia";
import { ref, onScopeDispose } from "vue";
import { globalClusterSse } from "../services/sse.js";
import { api } from "../services/api.js";

export const useArtifactsStore = defineStore("artifacts", () => {
  const artifacts = ref<any[]>([]);
  const currentArtifact = ref<any>(null);
  const previewContent = ref<string>("");
  const isTruncated = ref(false);
  const loading = ref(false);
  const previewLoading = ref(false);

  const scopedArtifacts = ref<any[]>([]);
  let graphScope: string | null = null;
  let scopeRequest = 0;
  let previewRequest = 0;
  let listRequest = 0;

  async function setGraphScope(graphId: string | null) {
    graphScope = graphId;
    scopedArtifacts.value = [];
    clearPreview();
    await refreshScope();
  }

  async function refreshScope() {
    const request = ++scopeRequest;
    const graphId = graphScope;
    if (!graphId) return;
    const res = await api.listArtifacts(graphId);
    if (request === scopeRequest && graphId === graphScope) {
      scopedArtifacts.value = res.artifacts.filter((artifact: any) => artifact.graphId === graphId);
    }
  }

  function clearPreview() {
    previewRequest++;
    currentArtifact.value = null;
    previewContent.value = "";
    previewLoading.value = false;
  }

  const unsubscribe = globalClusterSse.subscribe(({ type, data }) => {
    if (graphScope && (["transport.open", "cluster.heartbeat"].includes(type) ||
      (data?.graphId === graphScope && ["graph.node_completed", "graph.completed"].includes(type)))) {
      void refreshScope().catch(() => {});
    }
  });
  onScopeDispose(unsubscribe);

  async function loadArtifacts(graphId?: string) {
    const request = ++listRequest;
    loading.value = true;
    try {
      const res = await api.listArtifacts(graphId);
      if (request === listRequest) artifacts.value = res.artifacts;
    } finally {
      if (request === listRequest) loading.value = false;
    }
  }

  async function loadPreview(artifactId: string) {
    const request = ++previewRequest;
    previewLoading.value = true;
    previewContent.value = "";
    isTruncated.value = false;
    try {
      const res = await api.getArtifactContent(artifactId);
      if (request !== previewRequest) return;
      currentArtifact.value = res;
      previewContent.value = res.content;
      isTruncated.value = res.truncated;
    } finally {
      if (request === previewRequest) previewLoading.value = false;
    }
  }

  function getDownloadUrl(artifactId: string): string {
    return api.getArtifactDownloadUrl(artifactId);
  }

  return {
    artifacts, scopedArtifacts, setGraphScope, clearPreview,
    currentArtifact,
    previewContent,
    isTruncated,
    loading,
    previewLoading,
    loadArtifacts,
    loadPreview,
    getDownloadUrl,
  };
});
