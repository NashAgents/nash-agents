<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { productApi, productError, type Diagnostics } from "../services/product-api";
import { useUiStore } from "../stores/ui";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
const ui = useUiStore(), layout = computed(() => ui.isMobile ? MobileLayout : ui.isTablet ? TabletLayout : DesktopLayout);
const data = ref<Diagnostics>(), loading = ref(true), error = ref(""), checkedAt = ref(0);
async function load() {
  loading.value = true; error.value = "";
  try { data.value = await productApi.diagnostics(); checkedAt.value = Date.now(); }
  catch (e) { error.value = productError(e); data.value = undefined; }
  finally { loading.value = false; }
}
function connection(value?: string) { return value === "connected" ? "连接正常" : value === "unavailable" ? "连接不可用" : "尚未报告连接探测"; }
onMounted(load);
</script>
<template><component :is="layout"><div class="product-page product-stack">
  <header class="product-header"><div><p class="product-eyebrow">SYSTEM / DIAGNOSTICS</p><h1>连接与诊断</h1><p class="product-subtitle">读取实际后台状态。配置已填写、连接可用和隔离验证分别呈现。</p></div><button class="product-button" :disabled="loading" @click="load">{{ loading ? '正在检查…' : '重新检查' }}</button></header>
  <p v-if="error" class="product-notice error" role="alert">{{ error }}</p><p v-if="loading" class="product-empty" role="status">正在检查当前实例…</p>
  <template v-else-if="data"><p v-if="data.pendingRestart" class="product-notice warning" role="status">已保存的服务设置尚未全部生效。请安排重启；当前连接诊断仍反映正在运行的实例。</p><div class="product-grid">
    <section class="product-card product-stack"><div><h2>数据存储</h2><p class="product-help">管理员配置与任务持久化分别检查。</p></div><dl class="product-list"><div><dt>产品配置</dt><dd>{{ data.database.product }}</dd></div><div><dt>产品数据库连接</dt><dd>{{ connection(data.database.connection?.product) }}</dd></div><div><dt>任务存储</dt><dd>{{ data.database.cluster === 'local' ? '本地持久存储' : data.database.cluster }}</dd></div><div v-if="data.database.configuredCluster && data.database.configuredCluster !== data.database.cluster"><dt>已保存的目标存储</dt><dd>{{ data.database.configuredCluster }}</dd></div><div><dt>任务存储连接</dt><dd>{{ connection(data.database.connection?.cluster) }}</dd></div></dl><p v-if="data.database.connection?.error" class="product-notice error">{{ data.database.connection.error }}</p></section>
    <section class="product-card product-stack"><div><h2>模型网关</h2><p class="product-help">网关认证状态不等于 Provider 能力测试通过。</p></div><dl class="product-list"><div><dt>节点认证</dt><dd>{{ data.gateway.authenticated ? '已启用' : '未启用' }}</dd></div><div><dt>当前请求</dt><dd>{{ data.gateway.activeRequests }} / {{ data.gateway.maxConcurrentRequests }}</dd></div><div><dt>单节点并发上限</dt><dd>{{ data.gateway.maxPerNode }}</dd></div><div><dt>已保存配置版本</dt><dd>v{{ data.configurationVersion }}</dd></div><div v-if="data.activeServiceConfigurationVersion !== undefined"><dt>服务启动配置版本</dt><dd>v{{ data.activeServiceConfigurationVersion }}</dd></div></dl><router-link to="/models" class="product-button">测试模型能力</router-link></section>
  </div><section class="product-card product-stack"><h2>节点报告</h2><div v-if="!data.nodes.length" class="product-empty">还没有已注册节点。添加 Worker 后可检查它上报的能力。</div><div v-else class="product-table-wrap"><table class="product-table"><thead><tr><th>节点身份</th><th>状态</th><th>系统</th><th>沙箱后端</th></tr></thead><tbody><tr v-for="node in data.nodes" :key="node.nodeId"><td class="product-mono">{{ node.nodeId }}</td><td>{{ node.status }}</td><td>{{ node.platform || '未上报' }}</td><td>{{ typeof node.sandbox === 'string' ? node.sandbox : '未上报；请查看节点能力清单' }}</td></tr></tbody></table></div><router-link to="/cluster" class="product-button self-start">查看节点隔离能力</router-link></section>
  <section class="product-card product-stack"><h2>配置生效范围</h2><p class="product-help">模型和策略的新版本用于新任务。监听地址、端口、存储和 Worker 启动设置需要计划内重启。</p><p class="product-help">认证方式：{{ data.authentication }} · 检查于 {{ new Date(checkedAt).toLocaleString() }}</p><details><summary class="product-help cursor-pointer">查看需要重启的字段</summary><ul class="product-mono mt-3"><li v-for="field in data.restartRequiredFor" :key="field">{{ field }}</li></ul></details></section></template>
</div></component></template>
