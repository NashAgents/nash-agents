<template>
  <aside
    ref="sidebarRootRef"
    :inert="((uiStore.isMobile || uiStore.isTablet) && !uiStore.leftSidebarOpen) || undefined"
    :class="[
      'flex flex-col bg-surface-950 z-[60] select-none overflow-hidden h-full',
      uiStore.isMobile || uiStore.isTablet
        ? [
            'fixed inset-y-0 left-0 w-72 shadow-2xl transition-transform duration-300',
            uiStore.leftSidebarOpen ? 'translate-x-0' : '-translate-x-full',
          ]
        : 'w-full relative',
    ]"
  >
    <!-- 顶部新建任务/会话区与收缩按钮 (flex-shrink-0 稳定高度) -->
    <div :class="isExpanded ? 'p-3' : 'p-2 flex-col h-auto'" class="border-b border-surface-800 flex items-center justify-between gap-2 flex-shrink-0 h-14">
      <button
        @click="createNewTask"
        class="min-w-0 flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-nash-500 hover:bg-nash-600 text-white font-medium text-xs shadow-sm transition-all active:scale-95 cursor-pointer"
        :title="t.workspace.newConversation"
      >
        <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        <span v-if="isExpanded">
          {{ t.workspace.newConversation }}
        </span>
      </button>

      <!-- 桌面端折叠切换按钮 -->
      <button
        v-if="!uiStore.isMobile && !uiStore.isTablet"
        @click="uiStore.leftSidebarOpen = !uiStore.leftSidebarOpen"
        class="p-2 text-surface-400 hover:text-surface-200 hover:bg-surface-800 rounded-lg transition-colors flex-shrink-0 cursor-pointer"
        :title="uiStore.leftSidebarOpen ? '收起侧边栏' : '展开侧边栏'"
        :aria-label="uiStore.leftSidebarOpen ? '收起侧边栏' : '展开侧边栏'"
      >
        <svg
          class="w-4 h-4 transition-transform duration-200"
          :class="{ 'rotate-180': !uiStore.leftSidebarOpen }"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
        </svg>
      </button>

      <!-- 移动端关闭按钮 -->
      <button
        v-if="uiStore.isMobile || uiStore.isTablet"
        @click="uiStore.leftSidebarOpen = false"
        class="p-2 text-surface-400 hover:text-surface-200 hover:bg-surface-800 rounded-lg flex-shrink-0 cursor-pointer"
        aria-label="关闭侧边栏"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- 展开状态：两段式独立滚动容器 + 水平 Invisible Splitter -->
    <template v-if="isExpanded">
      <!-- 1. 中间功能导航区域 (独立可滚动有界容器，高度由用户调整锁定，展开手风琴绝对不影响会话区位置) -->
      <nav
        ref="navSectionRef"
        aria-label="功能导航"
        @scroll="uiStore.navScrollTop = ($event.target as HTMLElement).scrollTop"
        class="flex-shrink-0 overflow-y-auto p-2 space-y-2.5 custom-scrollbar"
        :style="navSectionStyle"
      >
        <!-- 工作台 (高优先级单列直接入口) -->
        <div>
          <router-link
            to="/"
            :class="[
              'flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-colors relative group',
              isRouteActive('/')
                ? 'bg-surface-800/90 text-nash-400 font-semibold border-l-2 border-nash-500'
                : 'text-surface-300 hover:text-surface-100 hover:bg-surface-900',
            ]"
            @click="closeOnMobile"
          >
            <span class="w-5 h-5 flex items-center justify-center flex-shrink-0">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
            </span>
            <span class="truncate flex-1">
              {{ t.nav.workspace }}
            </span>
          </router-link>
        </div>

        <!-- 6 大功能分组导航列表 -->
        <div v-for="group in functionalGroups" :key="group.id" class="space-y-1">
          <!-- 分组手风琴折叠头 -->
          <div class="pt-1">
            <button
              @click="toggleGroup(group.id)"
              :aria-expanded="isGroupOpen(group.id)"
              :aria-controls="`nav-${group.id}`"
              class="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-surface-300 hover:text-surface-200 transition-colors rounded group/btn cursor-pointer"
            >
              <div class="flex items-center gap-3 min-w-0">
                <component :is="group.items[0]?.icon" class="w-4 h-4 shrink-0" />
                <span>{{ group.title }}</span>
                <span
                  v-if="getBadgeValue(group.badge) > 0"
                  class="px-1.5 py-0.2 rounded-full text-[9px] bg-amber-500/20 text-amber-400 font-mono font-bold"
                >
                  {{ getBadgeValue(group.badge) }}
                </span>
              </div>
              <svg
                class="w-3.5 h-3.5 text-surface-500 group-hover/btn:text-surface-300 transition-transform duration-200"
                :class="{ '-rotate-90': !isGroupOpen(group.id) }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>

          <!-- 分组子项列表 -->
          <div :id="`nav-${group.id}`" v-show="isGroupOpen(group.id)" class="nav-group-items space-y-0.5 pl-6">
            <router-link
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              :class="[
                'flex items-center gap-3 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors relative group',
                isRouteActive(item.path)
                  ? 'bg-surface-800/90 text-nash-400 font-semibold border-l-2 border-nash-500'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900/60',
              ]"
              @click="closeOnMobile"
            >
              <span class="w-5 h-5 flex items-center justify-center flex-shrink-0 relative">
                <component :is="item.icon" class="w-4 h-4" />
              </span>

              <span class="truncate flex-1">
                {{ item.label }}
              </span>

              <span
                v-if="getBadgeValue(item.badge) > 0"
                class="px-1.5 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-400 font-mono font-bold"
              >
                {{ getBadgeValue(item.badge) }}
              </span>
            </router-link>
          </div>
        </div>
      </nav>

      <!-- 2. 水平 Invisible Splitter (上下拖拽调节导航与最近会话高度分配) -->
      <InvisibleSplitter
        v-if="!uiStore.isMobile"
        direction="horizontal"
        label="调整侧边栏功能导航与最近会话区域高度分配"
        :current-value="currentNavHeightPx"
        :min-value="minNavHeightPx"
        :max-value="maxNavHeightPx"
        @drag-start="handleSplitterDragStart"
        @drag-move="handleSplitterDragMove"
        @drag-end="handleSplitterDragEnd"
        @reset="layoutStore.resetSidebarNavRatio"
        @step="handleSplitterStep"
      />

      <!-- 3. 底部最近会话区域 (独立弹性滚动容器 flex-1 min-h-0) -->
      <div class="recent-sessions flex-1 min-h-0 flex flex-col pt-2 px-2 overflow-hidden bg-surface-950/40">
        <div class="px-3 py-1 flex items-center justify-between text-[11px] font-semibold text-surface-400 uppercase tracking-wider flex-shrink-0">
          <span>{{ t.workspace.recentConversations }}</span>
          <span class="text-[10px] text-surface-400 font-mono">
            {{ workspaceStore.conversations.length }}
          </span>
        </div>

        <!-- 会话卡片独立滚动区 -->
        <div ref="recentSectionRef" aria-label="最近会话" @scroll="uiStore.recentScrollTop = ($event.target as HTMLElement).scrollTop" class="flex-1 min-h-0 overflow-y-auto space-y-1 mt-1 pr-1 custom-scrollbar">
          <!-- 当前草稿高亮项 -->
          <div
            v-if="workspaceStore.isDraft || workspaceStore.currentConversation?.id === 'draft'"
            class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-nash-500/10 border border-nash-500/30 text-nash-300 font-medium cursor-pointer"
            @click="selectDraft"
          >
            <span class="w-2 h-2 rounded-full bg-nash-400 animate-pulse flex-shrink-0"></span>
            <span class="truncate flex-1 font-mono">新任务草稿 (待输入...)</span>
          </div>

          <!-- 真实历史会话列表 -->
          <div
            v-for="conv in workspaceStore.conversations"
            :key="conv.id"
            :class="[
              'group relative flex flex-col px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors border',
              !workspaceStore.isDraft && workspaceStore.currentConversation?.id === conv.id
                ? 'bg-surface-800/90 border-surface-700 text-surface-100 font-medium'
                : 'border-transparent text-surface-400 hover:text-surface-200 hover:bg-surface-900/60',
            ]"
            @click="selectConv(conv.id)"
          >
            <div class="flex items-center justify-between gap-1.5 w-full">
              <div class="flex items-center gap-2 truncate flex-1">
                <span
                  v-if="isConvRunning(conv)"
                  class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"
                  title="该会话任务正在执行中"
                ></span>
                <svg
                  v-else
                  class="w-3.5 h-3.5 text-surface-500 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                  />
                </svg>

                <input
                  v-if="editingConvId === conv.id"
                  v-model="editingTitle"
                  ref="editInputRef"
                  type="text"
                  class="bg-surface-950 border border-nash-500 px-1.5 py-0.5 rounded text-xs text-surface-100 focus:outline-none w-full"
                  @click.stop
                  @keydown.enter.stop="saveTitle(conv.id)"
                  @keydown.esc.stop="cancelEdit"
                  @blur="saveTitle(conv.id)"
                />
                <span v-else class="truncate select-none" :title="conv.title">
                  {{ conv.title || "任务会话" }}
                </span>
              </div>

              <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  @click.stop="startEdit(conv)"
                  class="p-1 text-surface-400 hover:text-nash-300 rounded transition-colors"
                  title="重命名会话"
                >
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>

                <button
                  @click.stop="deleteConv(conv.id)"
                  class="p-1 text-surface-400 hover:text-rose-400 rounded transition-colors"
                  title="删除会话"
                >
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div class="flex items-center justify-between text-[10px] text-surface-500 font-mono mt-1 pl-5">
              <span>{{ formatTime(conv.updatedAt || conv.createdAt) }}</span>
              <span
                v-if="conv.linkedTaskIds && conv.linkedTaskIds.length > 0"
                class="px-1.5 py-0.2 rounded bg-surface-900 border border-surface-700 text-surface-400"
              >
                {{ conv.linkedTaskIds.length }} 任务
              </span>
            </div>
          </div>

          <div v-if="workspaceStore.conversations.length === 0 && !workspaceStore.isDraft" class="py-6 text-center text-surface-500 text-xs">
            暂无历史任务会话
          </div>
        </div>
      </div>
    </template>

    <!-- 收缩态 (w-16)：极简图标导航列，隐藏下方会话 -->
    <template v-else>
      <nav class="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
        <!-- 工作台 -->
        <router-link
          to="/"
          :class="[
            'flex items-center justify-center p-2 rounded-lg text-xs font-medium transition-colors relative group',
            isRouteActive('/')
              ? 'bg-surface-800/90 text-nash-400 font-semibold'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900',
          ]"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <div class="absolute left-full ml-3 px-2.5 py-1 bg-surface-900 border border-surface-700 text-surface-100 rounded-md text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl">
            {{ t.nav.workspace }}
          </div>
        </router-link>

        <div v-for="group in functionalGroups" :key="group.id" class="space-y-1">
          <div class="h-px bg-surface-800/80 my-1.5 mx-2" />
          <div class="space-y-1">
            <router-link
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              :class="[
                'flex items-center justify-center p-2 rounded-lg text-xs font-medium transition-colors relative group',
                isRouteActive(item.path)
                  ? 'bg-surface-800/90 text-nash-400 font-semibold'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900',
              ]"
            >
              <span class="relative">
                <component :is="item.icon" class="w-5 h-5" />
                <span
                  v-if="getBadgeValue(item.badge) > 0"
                  class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500 animate-pulse"
                />
              </span>
              <div class="absolute left-full ml-3 px-2.5 py-1 bg-surface-900 border border-surface-700 text-surface-100 rounded-md text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 shadow-xl flex items-center gap-1.5">
                <span class="text-surface-400 text-[10px]">{{ group.title }} ·</span>
                <span class="font-medium">{{ item.label }}</span>
              </div>
            </router-link>
          </div>
        </div>
      </nav>
    </template>
  </aside>

  <!-- 移动端背景遮罩 -->
  <div
    v-if="(uiStore.isMobile || uiStore.isTablet) && uiStore.leftSidebarOpen"
    class="fixed inset-0 bg-black/60 z-30 backdrop-blur-sm"
    @click="uiStore.leftSidebarOpen = false"
  ></div>
</template>

<script setup lang="ts">
import { ref, computed, h, nextTick, watch, onMounted, onUnmounted, type ComputedRef, type VNode } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useUiStore } from "../../stores/ui";
import { useWorkbenchLayoutStore } from "../../stores/workbench-layout";
import { useWorkspaceStore, type ConversationItem } from "../../stores/workspace";
import { useClusterStore } from "../../stores/cluster";
import { useI18n } from "../../i18n";
import InvisibleSplitter from "./InvisibleSplitter.vue";

export interface NavItem {
  path: string;
  label: string;
  icon: () => VNode;
  badge?: () => number | undefined;
}

export interface NavGroup {
  id: string;
  title: string;
  badge?: () => number | undefined;
  items: NavItem[];
}

const uiStore = useUiStore();
const layoutStore = useWorkbenchLayoutStore();
const workspaceStore = useWorkspaceStore();
const clusterStore = useClusterStore();
const { t } = useI18n();
const router = useRouter();
const route = useRoute();

const sidebarRootRef = ref<HTMLElement | null>(null);
const navSectionRef = ref<HTMLElement | null>(null);
const recentSectionRef = ref<HTMLElement | null>(null);
const totalAvailableHeight = ref(600);

const isExpanded = computed(() => uiStore.leftSidebarOpen || uiStore.isMobile || uiStore.isTablet);

const editingConvId = ref<string | null>(null);
const editingTitle = ref("");
const editInputRef = ref<HTMLInputElement | null>(null);

// 监听容器高度自适应
function updateAvailableHeight() {
  if (sidebarRootRef.value) {
    // 减去顶部标题栏 56px (h-14)
    const h = sidebarRootRef.value.clientHeight - 57;
    if (h > 100) {
      totalAvailableHeight.value = h;
    }
  }
}

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  updateAvailableHeight();
  if (navSectionRef.value) navSectionRef.value.scrollTop = uiStore.navScrollTop;
  if (recentSectionRef.value) recentSectionRef.value.scrollTop = uiStore.recentScrollTop;
  if (typeof ResizeObserver !== "undefined" && sidebarRootRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateAvailableHeight();
    });
    resizeObserver.observe(sidebarRootRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});

const minNavHeightPx = computed(() => Math.min(140, totalAvailableHeight.value * 0.45));
const maxNavHeightPx = computed(() => Math.max(minNavHeightPx.value, totalAvailableHeight.value - Math.min(120, totalAvailableHeight.value * 0.4)));
const currentNavHeightPx = computed(() => Math.round(Math.min(maxNavHeightPx.value, Math.max(minNavHeightPx.value, totalAvailableHeight.value * layoutStore.sidebarNavRatio))));

const navSectionStyle = computed(() => {
  return {
    height: `${currentNavHeightPx.value}px`,
  };
});

// 水平 Splitter 拖拽事件
function handleSplitterDragStart() {
  layoutStore.isDraggingSidebarNav = true;
}

function handleSplitterDragMove(delta: { dy: number }) {
  const newHeight = currentNavHeightPx.value + delta.dy;
  layoutStore.setSidebarNavHeight(newHeight, totalAvailableHeight.value);
}

function handleSplitterDragEnd() {
  layoutStore.isDraggingSidebarNav = false;
  layoutStore.persistLayout();
}

function handleSplitterStep(delta: number) {
  layoutStore.stepSidebarNavHeight(delta, totalAvailableHeight.value);
}

// 图标工厂
const icon = (d: string) =>
  h(
    "svg",
    { fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", class: "w-4 h-4" },
    [h("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", d })]
  );

// 路由与分组手风琴联动 (严格满足：展开当前页面所属分组，默认同一时间只展开一个功能分组)
const currentActiveGroup = computed(() => {
  const p = route.path;
  if (p.startsWith("/dashboard")) return "overview";
  if (p.startsWith("/tasks") || p.startsWith("/graphs") || p.startsWith("/schedules")) return "taskCenter";
  if (p.startsWith("/cluster") || p.startsWith("/projects") || p.startsWith("/memory")) return "clusterResources";
  if (p.startsWith("/approvals") || p.startsWith("/security")) return "securityAudit";
  if (p.startsWith("/artifacts")) return "deliverables";
  if (p.startsWith("/settings") || p.startsWith("/models") || p.startsWith("/diagnostics")) return "systemSettings";
  return null;
});

function isGroupOpen(groupId: string): boolean { return uiStore.expandedNavGroup === groupId; }
function toggleGroup(groupId: string) { uiStore.expandedNavGroup = isGroupOpen(groupId) ? null : groupId; }

function getBadgeValue(fn?: () => number | undefined): number {
  return fn ? (fn() ?? 0) : 0;
}

// 路由前缀匹配判断
function isRouteActive(path: string): boolean {
  if (path === "/security") return route.path === "/security";
  if (path === "/") {
    return route.path === "/";
  }
  return route.path === path || route.path.startsWith(`${path}/`);
}

watch(
  () => route.path,
  () => {
    if (currentActiveGroup.value) uiStore.expandedNavGroup = currentActiveGroup.value;
  },
  { immediate: true }
);

// 6 大功能导航分组定义
const functionalGroups: ComputedRef<NavGroup[]> = computed(() => [
  {
    id: "overview",
    title: t.value.nav.dashboard,
    items: [{ path: "/dashboard", label: t.value.nav.dashboard, icon: () => icon("M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z") }],
  },
  {
    id: "taskCenter",
    title: t.value.navGroups.taskCenter,
    items: [
      {
        path: "/tasks",
        label: t.value.nav.tasks,
        icon: () => icon("M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"),
      },
      {
        path: "/graphs",
        label: t.value.nav.graphs,
        icon: () => icon("M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"),
      },
      {
        path: "/schedules",
        label: t.value.nav.schedules,
        icon: () => icon("M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"),
      },
    ],
  },
  {
    id: "clusterResources",
    title: t.value.navGroups.clusterResources,
    items: [
      {
        path: "/cluster",
        label: t.value.nav.cluster,
        icon: () => icon("M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"),
      },
      {
        path: "/projects",
        label: t.value.nav.projects,
        icon: () => icon("M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"),
      },
      {
        path: "/memory",
        label: t.value.nav.memory,
        icon: () => icon("M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"),
      },
    ],
  },
  {
    id: "securityAudit",
    title: t.value.navGroups.securityAudit,
    badge: () => clusterStore.pendingApprovalsCount,
    items: [
      {
        path: "/security",
        label: t.value.nav.security,
        icon: () => icon("M12 3l9 4v5c0 5-9 9-9 9s-9-4-9-9V7l9-4z"),
      },
      {
        path: "/approvals",
        label: t.value.nav.approvals,
        icon: () => icon("M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"),
        badge: () => clusterStore.pendingApprovalsCount,
      },
      {
        path: "/security/audit",
        label: t.value.nav.securityAudit,
        icon: () => icon("M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"),
      },
    ],
  },
  {
    id: "deliverables",
    title: t.value.navGroups.deliverables,
    items: [
      {
        path: "/artifacts",
        label: t.value.nav.artifacts,
        icon: () => icon("M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"),
      },
    ],
  },
  {
    id: "systemSettings",
    title: t.value.navGroups.systemSettings,
    items: [
      {
        path: "/models",
        label: t.value.nav.models,
        icon: () => icon("M9 3h6v4h4v6h-4v4H9v-4H5V7h4V3z"),
      },
      {
        path: "/diagnostics",
        label: t.value.nav.diagnostics,
        icon: () => icon("M3 12h4l3-7 4 14 3-7h4"),
      },
      {
        path: "/settings",
        label: t.value.nav.settings,
        icon: () => icon("M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"),
      },
    ],
  },
]);

function isConvRunning(conv: ConversationItem): boolean {
  if (workspaceStore.activeSendingConvId === conv.id) return true;
  if (workspaceStore.conversationActivities?.[conv.id]) return true;
  return false;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function createNewTask() {
  workspaceStore.startNewDraft();
  if (uiStore.isMobile || uiStore.isTablet) {
    uiStore.leftSidebarOpen = false;
  }
  router.push("/");
}

function selectDraft() {
  workspaceStore.selectConversation("draft");
  if (uiStore.isMobile || uiStore.isTablet) {
    uiStore.leftSidebarOpen = false;
  }
  router.push("/");
}

function selectConv(id: string) {
  workspaceStore.selectConversation(id);
  if (uiStore.isMobile || uiStore.isTablet) {
    uiStore.leftSidebarOpen = false;
  }
  router.push("/");
}

function closeOnMobile() {
  if (uiStore.isMobile || uiStore.isTablet) {
    uiStore.leftSidebarOpen = false;
  }
}

function startEdit(conv: ConversationItem) {
  editingConvId.value = conv.id;
  editingTitle.value = conv.title || "";
  nextTick(() => {
    editInputRef.value?.focus();
    editInputRef.value?.select();
  });
}

function cancelEdit() {
  editingConvId.value = null;
  editingTitle.value = "";
}

async function saveTitle(id: string) {
  if (!editingConvId.value) return;
  const newTitle = editingTitle.value.trim();
  if (newTitle) {
    await workspaceStore.updateConversationTitle(id, newTitle);
  }
  editingConvId.value = null;
  editingTitle.value = "";
}

async function deleteConv(id: string) {
  if (confirm("确定删除该会话记录吗？")) {
    await workspaceStore.deleteConversation(id);
  }
}
</script>

<style scoped>
.nav-group-items { animation: nav-reveal 150ms ease-out; }
@keyframes nav-reveal { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .nav-group-items { animation: none; } }
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(120, 120, 120, 0.2);
  border-radius: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(120, 120, 120, 0.4);
}
</style>
