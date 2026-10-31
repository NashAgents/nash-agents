<template>
  <div class="min-h-screen bg-surface-950 text-surface-100 flex flex-col font-sans">
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { useAuthStore } from "./stores/auth";
import { closeAllSseConnections } from "./services/sse";
import { useUiStore } from "./stores/ui";
import { useClusterStore } from "./stores/cluster";
import { useApprovalsStore } from "./stores/approvals";

import { useWorkbenchLayoutStore, layoutCategory } from "./stores/workbench-layout";

const authStore = useAuthStore();
const uiStore = useUiStore();
const layoutStore = useWorkbenchLayoutStore();
watch(() => layoutCategory(uiStore.windowWidth), () => layoutStore.restoreLayout(uiStore.windowWidth), { immediate: true });
const clusterStore = useClusterStore();
const approvalsStore = useApprovalsStore();

let clusterUnsub: (() => void) | null = null;
let approvalsUnsub: (() => void) | null = null;

onMounted(() => {
  uiStore.initTheme();
  uiStore.handleResize();
  window.addEventListener("resize", uiStore.handleResize);


});

watch(() => authStore.isAuthenticated, (authenticated) => {
  clusterUnsub?.(); approvalsUnsub?.();
  clusterUnsub = null; approvalsUnsub = null;
  if (authenticated) {
    clusterUnsub = clusterStore.startSseListener();
    approvalsUnsub = approvalsStore.startSseListener();
    void clusterStore.loadCluster();
    void approvalsStore.loadApprovals();
  } else closeAllSseConnections();
}, { immediate: true });

onUnmounted(() => {
  window.removeEventListener("resize", uiStore.handleResize);
  if (clusterUnsub) clusterUnsub();
  if (approvalsUnsub) approvalsUnsub();
});
</script>
