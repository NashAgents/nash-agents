<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-6xl mx-auto w-full">
      <!-- 页面顶部：标题、状态与统计 -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-surface-800 mb-5">
        <div>
          <div class="flex items-center gap-2.5">
            <h2 class="text-lg font-bold text-surface-100 tracking-tight">
              项目目录
            </h2>
            <span class="px-2 py-0.5 rounded-full bg-surface-800 text-surface-400 font-mono text-[11px]">
              {{ filteredProjects.length }} / {{ projects.length }} 个项目
            </span>
          </div>
          <p class="text-xs text-surface-400 mt-0.5 font-mono">
            探索 Nash Cluster 中的多节点项目、开发资源与 Agent 协作上下文
          </p>
        </div>

        <!-- 控件区：搜索、视图切换 -->
        <div class="flex items-center gap-2.5">
          <!-- 搜索框 -->
          <div class="relative w-full sm:w-64">
            <svg
              class="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-surface-500 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              v-model="searchQuery"
              type="text"
              placeholder="搜索项目名称、技术栈或描述..."
              class="w-full pl-8 pr-7 py-1.5 rounded-lg bg-surface-900 border border-surface-700/80 text-surface-100 text-xs focus:outline-none focus:border-nash-500 font-sans placeholder-surface-500 transition-colors"
            />
            <button
              v-if="searchQuery"
              @click="searchQuery = ''"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 text-xs"
            >
              ✕
            </button>
          </div>

          <!-- 网格/列表切换按钮 -->
          <div class="flex items-center p-0.5 rounded-lg bg-surface-900 border border-surface-800">
            <button
              @click="viewMode = 'grid'"
              :class="[
                'p-1.5 rounded-md text-xs transition-colors',
                viewMode === 'grid' ? 'bg-surface-800 text-surface-100 shadow-sm' : 'text-surface-400 hover:text-surface-200'
              ]"
              title="网格视图"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              @click="viewMode = 'list'"
              :class="[
                'p-1.5 rounded-md text-xs transition-colors',
                viewMode === 'list' ? 'bg-surface-800 text-surface-100 shadow-sm' : 'text-surface-400 hover:text-surface-200'
              ]"
              title="列表视图"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 快速过滤胶囊栏：按节点与状态 -->
      <div class="flex items-center justify-between gap-3 flex-wrap pb-4">
        <!-- 节点筛选 -->
        <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          <span class="text-[11px] font-mono text-surface-500 mr-1">节点:</span>
          <button
            v-for="nodeOpt in nodeFilterOptions"
            :key="nodeOpt.value"
            @click="selectedNodeFilter = nodeOpt.value"
            :class="[
              'px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap',
              selectedNodeFilter === nodeOpt.value
                ? 'bg-surface-800 text-nash-400 border border-surface-700'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900 border border-transparent'
            ]"
          >
            {{ nodeOpt.label }}
          </button>
        </div>

        <!-- 注册状态筛选 -->
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] font-mono text-surface-500 mr-1">状态:</span>
          <select
            v-model="selectedStatusFilter"
            class="px-2.5 py-1 rounded-md bg-surface-900 border border-surface-700/80 text-surface-300 text-xs focus:outline-none focus:border-nash-500 font-mono"
          >
            <option value="all">全部状态</option>
            <option value="registered">已注册 (已授权)</option>
            <option value="discovered">自动发现 (待授权)</option>
          </select>
        </div>
      </div>

      <!-- 加载中 -->
      <div v-if="loading" class="flex-1 flex items-center justify-center py-20 text-surface-400 text-xs font-mono">
        正在拉取集群多节点项目目录...
      </div>

      <!-- 模式一：Grid View 紧凑自适应卡片 -->
      <div
        v-else-if="filteredProjects.length > 0 && viewMode === 'grid'"
        class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5"
      >
        <div
          v-for="proj in filteredProjects"
          :key="`${proj.nodeId}-${proj.projectId}`"
          @click="goToDetail(proj)"
          class="p-4 rounded-xl bg-surface-900 border border-surface-800 hover:border-surface-700 hover:bg-surface-900/90 transition-all cursor-pointer flex flex-col justify-between group space-y-3"
        >
          <!-- 卡片头部：图标、名称与节点友好标签 -->
          <div>
            <div class="flex items-start justify-between gap-2 mb-1.5">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-6 h-6 rounded-md bg-surface-800 border border-surface-700/60 flex items-center justify-center text-xs text-nash-400 shrink-0 font-mono font-bold">
                  {{ getIconGlyph(proj) }}
                </span>
                <h3 class="font-bold text-sm text-surface-100 group-hover:text-nash-400 transition-colors truncate">
                  {{ proj.name }}
                </h3>
              </div>
              <span class="text-[11px] font-mono text-surface-400 shrink-0 bg-surface-800/80 px-2 py-0.5 rounded border border-surface-700/40">
                {{ getFriendlyNodeName(proj.nodeId) }}
              </span>
            </div>

            <!-- 项目描述：限制 2 行，自适应排版 -->
            <p class="text-xs text-surface-400 font-sans line-clamp-2 leading-relaxed mb-2.5">
              {{ proj.summary || proj.description || '项目暂无架构与用途说明。' }}
            </p>

            <!-- 技术栈标签：最多展示 3 个，超出折叠 -->
            <div class="flex flex-wrap items-center gap-1">
              <span
                v-for="tech in (proj.technologies || []).slice(0, 3)"
                :key="tech"
                class="px-1.5 py-0.5 rounded bg-surface-800/90 text-surface-300 font-mono text-[10px] border border-surface-700/30"
              >
                {{ tech }}
              </span>
              <span
                v-if="(proj.technologies || []).length > 3"
                class="px-1 py-0.5 rounded bg-surface-800/50 text-surface-400 font-mono text-[9px]"
              >
                +{{ proj.technologies.length - 3 }}
              </span>
            </div>
          </div>

          <!-- 卡片底部：状态指示与发起任务轻量操作 -->
          <div class="pt-2.5 border-t border-surface-800/80 flex items-center justify-between gap-2">
            <span
              :class="['text-[10px] font-mono px-2 py-0.5 rounded-full', getStatusMeta(proj).badgeClass]"
            >
              {{ getStatusMeta(proj).label }}
            </span>

            <div class="flex items-center gap-1.5" @click.stop>
              <button
                v-if="getStatusMeta(proj).canExecuteDirectly"
                @click="startTaskOnProject(proj)"
                class="px-2.5 py-1 rounded-md bg-surface-800 hover:bg-nash-500/20 text-surface-300 hover:text-nash-400 font-medium text-[11px] border border-surface-700 hover:border-nash-500/30 transition-all flex items-center gap-1"
                title="在当前项目启动 Nash Agent 会话"
              >
                <span>发起任务</span>
                <span class="text-xs">→</span>
              </button>
              <button
                @click="goToDetail(proj)"
                class="p-1 rounded-md text-surface-500 hover:text-surface-200 hover:bg-surface-800 transition-colors"
                title="查看项目详情"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 模式二：List View 高密度列表模式 -->
      <div
        v-else-if="filteredProjects.length > 0 && viewMode === 'list'"
        class="rounded-xl border border-surface-800 bg-surface-900 overflow-hidden divide-y divide-surface-800"
      >
        <div
          v-for="proj in filteredProjects"
          :key="`${proj.nodeId}-${proj.projectId}`"
          @click="goToDetail(proj)"
          class="p-3 sm:px-4 sm:py-3 hover:bg-surface-800/40 cursor-pointer transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
        >
          <!-- 左侧：图标、名称与简介 -->
          <div class="flex items-start gap-3 min-w-0 flex-1">
            <span class="w-7 h-7 rounded-md bg-surface-800 border border-surface-700/60 flex items-center justify-center text-xs text-nash-400 shrink-0 font-mono font-bold mt-0.5">
              {{ getIconGlyph(proj) }}
            </span>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h4 class="font-bold text-sm text-surface-100 group-hover:text-nash-400 transition-colors truncate">
                  {{ proj.name }}
                </h4>
                <span class="text-[10px] font-mono text-surface-400 bg-surface-800 px-1.5 py-0.2 rounded border border-surface-700/40">
                  {{ getFriendlyNodeName(proj.nodeId) }}
                </span>
                <span
                  :class="['text-[9px] font-mono px-1.5 py-0.2 rounded-full', getStatusMeta(proj).badgeClass]"
                >
                  {{ getStatusMeta(proj).label }}
                </span>
              </div>
              <p class="text-xs text-surface-400 font-sans truncate max-w-xl mt-0.5">
                {{ proj.summary || proj.description || '项目暂无架构与用途说明。' }}
              </p>
            </div>
          </div>

          <!-- 右侧：技术栈标签与动作按钮 -->
          <div class="flex items-center justify-between sm:justify-end gap-3 shrink-0" @click.stop>
            <div class="hidden md:flex flex-wrap items-center gap-1 max-w-xs justify-end">
              <span
                v-for="tech in (proj.technologies || []).slice(0, 2)"
                :key="tech"
                class="px-1.5 py-0.5 rounded bg-surface-800/80 text-surface-400 font-mono text-[10px]"
              >
                {{ tech }}
              </span>
              <span
                v-if="(proj.technologies || []).length > 2"
                class="text-[9px] font-mono text-surface-500"
              >
                +{{ proj.technologies.length - 2 }}
              </span>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                v-if="getStatusMeta(proj).canExecuteDirectly"
                @click="startTaskOnProject(proj)"
                class="px-2.5 py-1 rounded-md bg-surface-800 hover:bg-nash-500/20 text-surface-300 hover:text-nash-400 font-medium text-xs border border-surface-700 hover:border-nash-500/30 transition-all flex items-center gap-1"
              >
                <span>发起任务</span>
                <span class="text-xs">→</span>
              </button>
              <button
                @click="goToDetail(proj)"
                class="p-1 rounded-md text-surface-500 hover:text-surface-200 hover:bg-surface-800 transition-colors"
                title="查看项目详情"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 空结果状态 -->
      <EmptyState
        v-else
        title="未检索到匹配项目"
        description="请尝试调整搜索关键词、节点筛选或检查目标节点的 ProjectRegistry 注册状态"
      />
    </div>
  </component>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useUiStore } from "../stores/ui";
import { useWorkspaceStore } from "../stores/workspace";
import { api } from "../services/api";
import { getFriendlyNodeName, getProjectStatus, getProjectIconType } from "../utils/project-helpers";

import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
import EmptyState from "../components/ui/EmptyState.vue";

const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();
const router = useRouter();

const projects = ref<any[]>([]);
const loading = ref(true);
const searchQuery = ref("");
const selectedNodeFilter = ref("all");
const selectedStatusFilter = ref("all");
const viewMode = ref<"grid" | "list">(
  (typeof localStorage !== "undefined" && (localStorage.getItem("nash_projects_view_mode") as any)) || "grid"
);

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

// 计算所有可用节点的友好筛选选项
const nodeFilterOptions = computed(() => {
  const nodeMap = new Map<string, string>();
  nodeMap.set("all", "全部节点");
  for (const p of projects.value) {
    if (p.nodeId && !nodeMap.has(p.nodeId)) {
      nodeMap.set(p.nodeId, getFriendlyNodeName(p.nodeId));
    }
  }
  return Array.from(nodeMap.entries()).map(([value, label]) => ({ value, label }));
});

// 综合搜索与筛选
const filteredProjects = computed(() => {
  let list = projects.value;

  // 1. 节点筛选
  if (selectedNodeFilter.value !== "all") {
    list = list.filter((p) => p.nodeId === selectedNodeFilter.value);
  }

  // 2. 状态筛选
  if (selectedStatusFilter.value !== "all") {
    list = list.filter((p) => {
      const meta = getStatusMeta(p);
      return meta.status === selectedStatusFilter.value;
    });
  }

  // 3. 搜索匹配
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase().trim();
    list = list.filter(
      (p) =>
        p.name?.toLowerCase().includes(q) ||
        p.projectId?.toLowerCase().includes(q) ||
        p.summary?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q) ||
        p.technologies?.some((t: string) => t.toLowerCase().includes(q)) ||
        getFriendlyNodeName(p.nodeId).toLowerCase().includes(q)
    );
  }

  return list;
});

onMounted(async () => {
  try {
    const res = await api.getCatalogProjects();
    projects.value = res.projects || [];
  } catch (err) {
    console.error("Failed to load catalog projects:", err);
  } finally {
    loading.value = false;
  }
});

function getStatusMeta(proj: any) {
  return getProjectStatus(proj, true);
}

function getIconGlyph(proj: any): string {
  const t = getProjectIconType(proj);
  switch (t) {
    case "agent": return "◈";
    case "web": return "⬡";
    case "desktop": return "▣";
    case "python": return "🐍";
    default: return "⌗";
  }
}

function goToDetail(proj: any) {
  router.push({
    name: "ProjectDetail",
    params: { projectId: proj.projectId },
    query: { nodeId: proj.nodeId },
  });
}

async function startTaskOnProject(proj: any) {
  workspaceStore.setProjectContext({
    projectId: proj.projectId,
    projectName: proj.name,
    nodeId: proj.nodeId,
    nodeName: getFriendlyNodeName(proj.nodeId),
  });
  await workspaceStore.createNewConversation();
  router.push("/");
}
</script>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
