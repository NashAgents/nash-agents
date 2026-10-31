<template>
  <component :is="layoutComponent">
    <div class="flex-1 flex flex-col p-4 md:p-6 max-w-6xl mx-auto w-full">
      <!-- 顶部面包屑与返回导航 -->
      <div class="flex items-center justify-between gap-4 pb-4 border-b border-surface-800 mb-6">
        <div class="flex items-center gap-3">
          <router-link
            to="/projects"
            class="p-2 rounded-lg bg-surface-900 border border-surface-800 text-surface-400 hover:text-surface-200 hover:border-surface-700 transition-colors"
            title="返回项目目录"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </router-link>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-bold text-surface-100 tracking-tight">
                {{ project?.name || '项目详情' }}
              </h2>
              <span
                v-if="statusInfo"
                :class="['px-2 py-0.5 rounded-full text-[10px] font-mono', statusInfo.badgeClass]"
              >
                {{ statusInfo.label }}
              </span>
            </div>
            <p class="text-xs text-surface-400 mt-0.5 font-mono">
              {{ friendlyNodeName }} · {{ project?.projectId }}
            </p>
          </div>
        </div>

        <!-- 核心操作区 -->
        <div class="flex items-center gap-2">
          <button
            v-if="statusInfo?.canExecuteDirectly"
            @click="startTaskOnProject"
            class="px-3.5 py-1.5 rounded-lg bg-nash-500 hover:bg-nash-400 text-surface-950 font-bold text-xs shadow-sm hover:shadow transition-all flex items-center gap-1.5"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>在此项目发起任务</span>
          </button>
          <span
            v-else-if="statusInfo?.status === 'discovered'"
            class="text-xs text-amber-400/90 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg"
          >
            待管理员注册授权
          </span>
        </div>
      </div>

      <!-- 加载与空状态 -->
      <div v-if="loading" class="flex-1 flex items-center justify-center py-20 text-surface-400 text-xs font-mono">
        正在拉取项目上下文与关联资源...
      </div>

      <div v-else-if="error" class="flex-1 flex flex-col items-center justify-center py-20 text-center">
        <p class="text-sm text-red-400 mb-3">{{ error }}</p>
        <router-link
          to="/projects"
          class="px-4 py-1.5 rounded-lg bg-surface-800 text-surface-200 text-xs hover:bg-surface-700 transition-colors"
        >
          返回项目目录
        </router-link>
      </div>

      <!-- 项目主内容区 -->
      <div v-else-if="project" class="space-y-6">
        <!-- 标签导航 -->
        <div class="flex items-center gap-2 border-b border-surface-800 pb-2 overflow-x-auto no-scrollbar">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            @click="activeTab = tab.id"
            :class="[
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 whitespace-nowrap',
              activeTab === tab.id
                ? 'bg-nash-500/15 text-nash-400 border border-nash-500/30 font-semibold'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-900 border border-transparent'
            ]"
          >
            <span>{{ tab.name }}</span>
            <span
              v-if="tab.count !== undefined"
              class="px-1.5 py-0.2 rounded-full bg-surface-800 text-[10px] text-surface-400"
            >
              {{ tab.count }}
            </span>
          </button>
        </div>

        <!-- Tab 1: 概览 -->
        <div v-if="activeTab === 'overview'" class="space-y-6">
          <div class="p-5 rounded-2xl bg-surface-900 border border-surface-800 space-y-4">
            <h3 class="text-xs font-bold text-surface-300 uppercase tracking-wider font-mono">项目简介与架构</h3>
            <p class="text-sm text-surface-200 leading-relaxed font-sans">
              {{ project.summary || project.description || '该项目在注册时未提供详细描述文本。' }}
            </p>

            <div v-if="project.technologies && project.technologies.length > 0" class="pt-2">
              <span class="text-xs text-surface-400 font-mono block mb-2">已索引技术栈：</span>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="tech in project.technologies"
                  :key="tech"
                  class="px-2.5 py-1 rounded bg-surface-800/80 text-surface-300 font-mono text-xs border border-surface-700/50"
                >
                  {{ tech }}
                </span>
              </div>
            </div>

            <div v-if="project.capabilities && project.capabilities.length > 0" class="pt-2">
              <span class="text-xs text-surface-400 font-mono block mb-2">项目专项能力：</span>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="cap in project.capabilities"
                  :key="cap"
                  class="px-2.5 py-1 rounded bg-surface-800/50 text-surface-400 font-mono text-xs"
                >
                  ◈ {{ cap }}
                </span>
              </div>
            </div>
          </div>

          <!-- 宿主节点信息卡片 -->
          <div class="p-5 rounded-2xl bg-surface-900 border border-surface-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="space-y-1">
              <h4 class="text-xs font-bold text-surface-300 uppercase tracking-wider font-mono">所在物理节点</h4>
              <p class="text-sm font-semibold text-surface-100 flex items-center gap-2">
                <span>{{ friendlyNodeName }}</span>
                <span class="text-xs font-normal text-surface-400 font-mono">({{ project.nodeId }})</span>
              </p>
              <p class="text-xs text-surface-400 font-mono">
                平台：{{ nodeInfo?.platform || 'Darwin/Linux' }} · 主机名：{{ nodeInfo?.hostname || 'Cluster Worker' }}
              </p>
            </div>
            <div class="flex items-center gap-3">
              <span class="inline-flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20 font-mono">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                节点在线通信中
              </span>
            </div>
          </div>
        </div>

        <!-- Tab 2: 联邦记忆 -->
        <div v-if="activeTab === 'memory'" class="space-y-4">
          <div v-if="memoryEntries.length > 0" class="space-y-3">
            <div
              v-for="mem in memoryEntries"
              :key="mem.id || mem.topic"
              class="p-4 rounded-xl bg-surface-900 border border-surface-800 space-y-2 hover:border-surface-700 transition-colors"
            >
              <div class="flex items-center justify-between gap-2">
                <h4 class="font-bold text-sm text-surface-100">{{ mem.topic || mem.title || '未命名记忆' }}</h4>
                <span class="text-[10px] font-mono text-surface-400 bg-surface-800 px-2 py-0.5 rounded">
                  置信度: {{ mem.confidence || '0.90' }}
                </span>
              </div>
              <p class="text-xs text-surface-300 leading-relaxed font-sans">
                {{ mem.summary || mem.content }}
              </p>
            </div>
          </div>
          <div v-else class="py-12 text-center text-surface-500 text-xs font-mono">
            该项目暂无沉淀的专属联邦记忆词条
          </div>
        </div>

        <!-- Tab 3: MCP 与 Skills -->
        <div v-if="activeTab === 'capabilities'" class="space-y-6">
          <!-- Skills -->
          <div class="space-y-3">
            <h4 class="text-xs font-bold text-surface-300 uppercase tracking-wider font-mono">可用 Agent Skills</h4>
            <div v-if="skills.length > 0" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div
                v-for="skill in skills"
                :key="skill.skillId || skill.name"
                class="p-3.5 rounded-xl bg-surface-900 border border-surface-800 space-y-1.5"
              >
                <div class="flex items-center justify-between">
                  <span class="font-bold text-xs text-surface-100 font-mono">{{ skill.name }}</span>
                  <span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-surface-800 text-surface-400">
                    {{ skill.scope || 'global' }}
                  </span>
                </div>
                <p class="text-xs text-surface-400 line-clamp-2">{{ skill.description }}</p>
              </div>
            </div>
            <p v-else class="text-xs text-surface-500 font-mono">当前节点未注册项目专属 Skills</p>
          </div>

          <!-- MCP Servers & Tools -->
          <div class="space-y-3 pt-2">
            <h4 class="text-xs font-bold text-surface-300 uppercase tracking-wider font-mono">可用 MCP Tools</h4>
            <div v-if="mcpCapabilities.length > 0" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div
                v-for="m in mcpCapabilities"
                :key="m.name || m.toolName"
                class="p-3.5 rounded-xl bg-surface-900 border border-surface-800 space-y-1"
              >
                <span class="font-bold text-xs text-nash-400 font-mono">⚙ {{ m.name || m.toolName }}</span>
                <p class="text-xs text-surface-400 line-clamp-2">{{ m.description || 'MCP 工具接口' }}</p>
              </div>
            </div>
            <p v-else class="text-xs text-surface-500 font-mono">暂无挂载的 MCP Capabilities</p>
          </div>
        </div>

        <!-- Tab 4: 任务历史 -->
        <div v-if="activeTab === 'history'" class="space-y-3">
          <div v-if="tasks.length > 0" class="space-y-2">
            <div
              v-for="task in tasks"
              :key="task.taskId"
              @click="$router.push(`/tasks/${task.taskId}`)"
              class="p-3.5 rounded-xl bg-surface-900 border border-surface-800 hover:border-surface-700 cursor-pointer transition-all flex items-center justify-between gap-4"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-xs font-bold text-surface-100 truncate">{{ task.goal }}</span>
                  <span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-800 text-surface-300">
                    {{ task.status }}
                  </span>
                </div>
                <p class="text-[11px] text-surface-400 font-mono truncate">
                  Task ID: {{ task.taskId }} · {{ formatTime(task.createdAt) }}
                </p>
              </div>
              <span class="text-xs text-surface-500 font-mono shrink-0">查看详情 →</span>
            </div>
          </div>
          <div v-else class="py-12 text-center text-surface-500 text-xs font-mono">
            该项目尚未执行过历史任务
          </div>
        </div>

        <!-- Tab 5: 项目信息 -->
        <div v-if="activeTab === 'info'" class="p-5 rounded-2xl bg-surface-900 border border-surface-800 space-y-4 font-mono text-xs">
          <h4 class="text-xs font-bold text-surface-300 uppercase tracking-wider mb-2">项目注册与物理属性</h4>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-surface-300">
            <div>
              <span class="text-surface-500 block mb-1">项目标识符 (Project ID)</span>
              <span class="text-surface-100 select-all">{{ project.projectId }}</span>
            </div>
            <div>
              <span class="text-surface-500 block mb-1">物理宿主节点 (Node ID)</span>
              <span class="text-surface-100 select-all">{{ project.nodeId }}</span>
            </div>
            <div v-if="project.canonicalPath">
              <span class="text-surface-500 block mb-1">物理路径 (Canonical Path)</span>
              <span class="text-surface-100 select-all">{{ project.canonicalPath }}</span>
            </div>
            <div>
              <span class="text-surface-500 block mb-1">目录修订代次 (Revision)</span>
              <span class="text-surface-100">{{ project.revision ?? 1 }}</span>
            </div>
            <div>
              <span class="text-surface-500 block mb-1">首次注册时间</span>
              <span class="text-surface-100">{{ formatTime(project.registeredAt) }}</span>
            </div>
            <div>
              <span class="text-surface-500 block mb-1">最后索引时间</span>
              <span class="text-surface-100">{{ formatTime(project.lastIndexedAt || project.updatedAt) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useUiStore } from "../stores/ui";
import { useWorkspaceStore } from "../stores/workspace";
import { api } from "../services/api";
import { getFriendlyNodeName, getProjectStatus } from "../utils/project-helpers";

import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

const route = useRoute();
const router = useRouter();
const uiStore = useUiStore();
const workspaceStore = useWorkspaceStore();

const project = ref<any | null>(null);
const nodeInfo = ref<any | null>(null);
const memoryEntries = ref<any[]>([]);
const skills = ref<any[]>([]);
const mcpCapabilities = ref<any[]>([]);
const tasks = ref<any[]>([]);
const loading = ref(true);
const error = ref("");
const activeTab = ref("overview");

const layoutComponent = computed(() => {
  if (uiStore.isMobile) return MobileLayout;
  if (uiStore.isTablet) return TabletLayout;
  return DesktopLayout;
});

const friendlyNodeName = computed(() => {
  if (!project.value) return "";
  return getFriendlyNodeName(project.value.nodeId, nodeInfo.value?.hostname);
});

const statusInfo = computed(() => {
  if (!project.value) return null;
  return getProjectStatus(project.value, true);
});

const tabs = computed(() => [
  { id: "overview", name: "概览" },
  { id: "memory", name: "项目记忆", count: memoryEntries.value.length },
  { id: "capabilities", name: "MCP 与 Skills", count: skills.value.length + mcpCapabilities.value.length },
  { id: "history", name: "任务历史", count: tasks.value.length },
  { id: "info", name: "项目信息" },
]);

onMounted(async () => {
  const pId = route.params.projectId as string;
  const nId = route.query.nodeId as string | undefined;
  if (!pId) {
    error.value = "缺少有效的项目标识符";
    loading.value = false;
    return;
  }

  try {
    const res = await api.getProjectDetails(pId, nId);
    project.value = res.project;
    nodeInfo.value = res.node || null;
    memoryEntries.value = res.memory || [];
    skills.value = res.skills || [];
    mcpCapabilities.value = res.mcp || [];
    tasks.value = res.tasks || [];
  } catch (err: any) {
    error.value = err.message || "未能加载项目详细信息";
  } finally {
    loading.value = false;
  }
});

async function startTaskOnProject() {
  if (!project.value) return;
  workspaceStore.setProjectContext({
    projectId: project.value.projectId,
    projectName: project.value.name,
    nodeId: project.value.nodeId,
    nodeName: friendlyNodeName.value,
  });
  await workspaceStore.createNewConversation();
  router.push("/");
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return "未知";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
