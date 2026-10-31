<template>
  <header class="h-14 border-b border-surface-800 bg-surface-950/80 backdrop-blur-md px-3 sm:px-4 flex items-center justify-between z-30 sticky top-0">
    <!-- 左侧：Logo 与状态 -->
    <div class="flex items-center gap-2 sm:gap-3">
      <!-- 移动端抽屉唤起按钮 -->
      <button
        v-if="uiStore.isMobile || uiStore.isTablet"
        @click="uiStore.leftSidebarOpen = !uiStore.leftSidebarOpen"
        class="p-2 text-surface-400 hover:text-surface-200 hover:bg-surface-800 rounded-lg transition-colors"
        aria-label="Toggle Navigation"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      <!-- 品牌 Logo -->
      <router-link to="/" class="flex items-center gap-2 group">
        <div class="w-8 h-8 rounded-lg bg-nash-500/10 border border-nash-500/30 flex items-center justify-center text-nash-500 font-bold text-sm tracking-wider group-hover:scale-105 transition-transform">
          N
        </div>
        <div class="flex flex-col">
          <span class="font-semibold text-sm text-surface-100 tracking-tight leading-none flex items-center gap-1.5">
            Nash
            <span class="text-xs text-nash-400 font-normal">Cluster</span>
          </span>
          <span class="text-[10px] text-surface-400 font-mono mt-0.5 whitespace-nowrap">
            Phase 5 · Control
          </span>
        </div>
      </router-link>

      <!-- 运行状态指示器 -->
      <div class="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-full bg-surface-900 border border-surface-800 text-xs text-surface-300 ml-2">
        <StatusDot :status="statusType" :pulse="clusterStore.runningTasksCount > 0" />
        <span class="font-mono text-[11px]">{{ statusLabel }}</span>
      </div>
    </div>

    <!-- 右侧：集群在线数、审批待办、主题与语言 -->
    <div class="flex items-center gap-1 sm:gap-2">
      <!-- 集群节点状态徽标 -->
      <router-link
        to="/cluster"
        class="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-900/60 hover:bg-surface-800 border border-surface-800 text-xs text-surface-300 transition-colors"
      >
        <StatusDot :status="clusterStore.sseConnected ? 'online' : 'offline'" />
        <span>{{ t.header.clusterNodes }}</span>
        <span class="font-mono font-bold text-emerald-400">
          {{ clusterStore.error ? "状态不可用" : `${clusterStore.onlineNodesCount}/${clusterStore.status?.totalNodes ?? clusterStore.nodes.length}` }}
        </span>
      </router-link>

      <!-- 待审批徽标 -->
      <router-link
        v-if="clusterStore.pendingApprovalsCount > 0"
        to="/approvals"
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs hover:bg-amber-500/20 transition-colors animate-pulse"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <span class="font-mono font-bold">{{ clusterStore.pendingApprovalsCount }}</span>
      </router-link>

      <slot name="actions" />

      <!-- 语言切换 -->
      <button
        @click="toggleLanguage"
        class="px-2.5 py-1 text-xs rounded-lg border border-surface-800 hover:bg-surface-800 text-surface-300 transition-colors font-mono"
        :title="t.header.toggleLang"
      >
        {{ lang === 'zh' ? 'EN' : '中' }}
      </button>

      <!-- 模式切换 -->
      <button
        @click="uiStore.toggleTheme"
        class="p-2 text-surface-400 hover:text-surface-200 hover:bg-surface-800 rounded-lg transition-colors"
        :title="uiStore.isDark ? t.header.themeLight : t.header.themeDark"
      >
        <svg v-if="uiStore.isDark" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
        <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      </button>

      <!-- 用户信息与登出 -->
      <div v-if="authStore.user" class="flex items-center gap-2 pl-2 border-l border-surface-800">
        <span class="text-xs text-surface-300 hidden md:inline font-mono">
          {{ authStore.user.username }}
        </span>
        <button
          @click="handleLogout"
          class="p-2 text-surface-400 hover:text-rose-400 hover:bg-surface-800 rounded-lg transition-colors"
          :title="t.nav.logout"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useUiStore } from "../../stores/ui";
import { useClusterStore } from "../../stores/cluster";
import { useAuthStore } from "../../stores/auth";
import { useI18n } from "../../i18n";
import StatusDot from "../ui/StatusDot.vue";

const uiStore = useUiStore();
const clusterStore = useClusterStore();
const authStore = useAuthStore();
const { t, lang, toggleLanguage } = useI18n();
const router = useRouter();

const statusType = computed(() => {
  if (!clusterStore.sseConnected) return "offline";
  if (clusterStore.runningTasksCount > 0) return "running";
  if (clusterStore.pendingApprovalsCount > 0) return "waiting";
  return "online";
});

const statusLabel = computed(() => {
  if (!clusterStore.sseConnected) return "连接已断开";
  if (clusterStore.error) return "状态不可用";
  if (clusterStore.runningTasksCount > 0) {
    return `${clusterStore.runningTasksCount} ${t.value.header.statusWorking}`;
  }
  if (clusterStore.pendingApprovalsCount > 0) {
    return t.value.header.statusAwaitingApproval;
  }
  return t.value.header.statusReady;
});

async function handleLogout() {
  await authStore.logout();
  router.push("/login");
}
</script>
