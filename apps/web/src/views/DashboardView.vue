<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api } from "../services/api";
import { productError } from "../services/product-api";
import { useUiStore } from "../stores/ui";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
const ui = useUiStore(), layout = computed(() => ui.isMobile ? MobileLayout : ui.isTablet ? TabletLayout : DesktopLayout);
const status = ref<Awaited<ReturnType<typeof api.getClusterStatus>>>(), tasks = ref<any[]>([]), nodes = ref<any[]>([]);
const loading = ref(true), error = ref("");
const metrics = computed(() => [
  { label: "在线节点", value: status.value ? `${status.value.onlineNodes} / ${status.value.totalNodes}` : "—", path: "/cluster", hint: "已认证的真实执行节点" },
  { label: "运行中任务", value: status.value?.runningTasks ?? "—", path: "/tasks", hint: "来自任务状态存储" },
  { label: "等待审批", value: status.value?.pendingApprovals ?? "—", path: "/approvals", hint: "需要你的明确决策" },
  { label: "累计任务", value: status.value?.totalTasks ?? "—", path: "/tasks", hint: "当前实例的实际记录" },
]);
const stateNames: Record<string, string> = { online: "在线", offline: "离线", revoked: "已撤销", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", pending: "等待中", dispatched: "已派发", waiting_approval: "等待审批", outcome_unknown: "结果待核对" };
async function load() {
  loading.value = true; error.value = "";
  const results = await Promise.allSettled([api.getClusterStatus(), api.listTasks({ limit: 8 }), api.getNodes()]);
  const [s, t, n] = results;
  status.value = s.status === "fulfilled" ? s.value : undefined;
  tasks.value = t.status === "fulfilled" ? t.value.tasks : [];
  nodes.value = n.status === "fulfilled" ? n.value.nodes : [];
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") error.value = productError(failure.reason);
  loading.value = false;
}
onMounted(load);
</script>
<template><component :is="layout"><div class="product-page product-stack">
  <header class="product-header"><div><p class="product-eyebrow">NASH AGENTS / OVERVIEW</p><h1>把目标交给可靠的执行</h1><p class="product-subtitle">从一个工作区开始，观察每次真实调用、节点协作与任务交付。</p></div><router-link to="/" class="product-button primary">发起任务</router-link></header>
  <p v-if="error" class="product-notice error" role="alert">部分数据暂时不可用：{{ error }}</p><div class="product-actions"><span class="product-tag" :class="status?.status === 'ok' ? 'success' : 'warning'">{{ status?.status === 'ok' ? 'Coordinator 运行正常' : loading ? '正在读取状态' : '状态未确认' }}</span><span v-if="status" class="product-help">更新于 {{ new Date(status.timestamp).toLocaleTimeString() }}</span><button class="product-button ml-auto" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新概览' }}</button></div>
  <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"><router-link v-for="metric in metrics" :key="metric.label" :to="metric.path" class="product-card product-stack"><p class="product-help">{{ metric.label }}</p><p class="product-stat">{{ metric.value }}</p><p class="product-help">{{ metric.hint }}</p></router-link></div>
  <div class="product-grid"><section class="product-card product-stack"><div class="product-actions"><h2 class="mr-auto">最近任务</h2><router-link to="/tasks" class="product-help underline">查看全部</router-link></div><p v-if="!tasks.length" class="product-empty">{{ loading ? '正在读取任务…' : '还没有任务记录。添加项目后，从一次只读检查开始。' }}</p><div v-else class="product-list"><router-link v-for="task in tasks" :key="task.taskId" :to="`/tasks/${encodeURIComponent(task.taskId)}`"><div class="min-w-0"><p class="text-sm font-medium truncate">{{ task.goal || '未命名任务' }}</p><p class="product-mono text-surface-400 mt-1">{{ task.taskId }}</p></div><span class="product-tag">{{ stateNames[task.status] || task.status }}</span></router-link></div></section>
  <section class="product-card product-stack"><div class="product-actions"><h2 class="mr-auto">执行节点</h2><router-link to="/cluster" class="product-help underline">管理节点</router-link></div><p v-if="!nodes.length" class="product-empty">{{ loading ? '正在读取节点…' : '还没有节点。使用一次性邀请注册本机或远程 Worker。' }}</p><div v-else class="product-list"><div v-for="node in nodes.slice(0, 6)" :key="node.nodeId"><div class="min-w-0"><p class="text-sm font-medium">{{ node.name }}</p><p class="product-help">{{ node.platform || '系统尚未上报' }} · {{ node.arch || '架构尚未上报' }}</p></div><span class="product-tag" :class="node.status === 'online' ? 'success' : ''">{{ stateNames[node.status] || node.status }}</span></div></div></section></div>
  <section class="product-card product-stack"><div><h2>准备好第一个工作区</h2><p class="product-help">先配置模型与受限权限，再添加明确授权的项目。任务结果可从工具记录和产物中复核。</p></div><div class="product-actions"><router-link to="/models" class="product-button">配置模型</router-link><router-link to="/projects" class="product-button">添加项目</router-link><router-link to="/security" class="product-button">检查安全策略</router-link><router-link to="/diagnostics" class="product-button">连接诊断</router-link></div></section>
</div></component></template>
