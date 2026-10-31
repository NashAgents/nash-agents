<template>
  <nav
    v-if="uiStore.isMobile"
    class="fixed bottom-0 inset-x-0 h-14 bg-surface-950/95 backdrop-blur-md border-t border-surface-800 flex items-center justify-around z-30 pb-safe"
  >
    <router-link
      v-for="item in mobileItems"
      :key="item.path"
      :to="item.path"
      :class="[
        'flex flex-col items-center justify-center flex-1 h-full py-1 text-[10px] font-medium transition-colors relative',
        $route.path === item.path ? 'text-nash-500 font-semibold' : 'text-surface-400 hover:text-surface-200',
      ]"
    >
      <div class="relative">
        <component :is="item.icon" class="w-5 h-5" />
        <span
          v-if="item.badge"
          class="absolute -top-1 -right-2 px-1 text-[9px] rounded-full bg-amber-500 text-black font-bold"
        >
          {{ item.badge }}
        </span>
      </div>
      <span class="mt-0.5">{{ item.label }}</span>
    </router-link>
  </nav>
</template>

<script setup lang="ts">
import { computed, h } from "vue";
import { useUiStore } from "../../stores/ui";
import { useClusterStore } from "../../stores/cluster";
import { useI18n } from "../../i18n";

const uiStore = useUiStore();
const clusterStore = useClusterStore();
const { t } = useI18n();

const icon = (d: string) =>
  h(
    "svg",
    { fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", class: "w-5 h-5" },
    [h("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", d })]
  );

const mobileItems = computed(() => [
  { path: "/dashboard", label: t.value.nav.dashboard, icon: () => icon("M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"), badge: undefined },
  { path: "/", label: t.value.nav.workspace, icon: () => icon("M4 4h16v12H9l-5 4V4z"), badge: undefined },
  { path: "/cluster", label: t.value.nav.cluster, icon: () => icon("M3 4h18v6H3zM3 14h18v6H3z"), badge: undefined },
  { path: "/approvals", label: t.value.nav.approvals, icon: () => icon("M12 3l9 4v5c0 5-9 9-9 9s-9-4-9-9V7l9-4z"), badge: clusterStore.pendingApprovalsCount > 0 ? String(clusterStore.pendingApprovalsCount) : undefined },
  { path: "/settings", label: t.value.nav.settings, icon: () => icon("M12 8a4 4 0 100 8 4 4 0 000-8zM12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6L7 7m10 10l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"), badge: undefined },
]);
</script>
