<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { productApi, productError, type ProductConfig, type SecurityPolicy } from "../services/product-api";
import { useUiStore } from "../stores/ui";
import { useAuthStore } from "../stores/auth";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
const ui = useUiStore(), auth = useAuthStore();
const layout = computed(() => ui.isMobile ? MobileLayout : ui.isTablet ? TabletLayout : DesktopLayout);
const config = ref<ProductConfig>(), loading = ref(true), saving = ref(false), error = ref(""), notice = ref("");
const policy = ref<SecurityPolicy>({ filesystem: "workspace-write", network: "deny", approval: "ask" });
const confirmed = ref(false);
const pendingApply = ref<{ version: number; updatedAt: number; attempts?: number; state?: "waiting_retry" | "blocked"; nextRetryAt?: number | null; errorCode?: string } | null>(null);
watch(() => policy.value.filesystem, () => { confirmed.value = false; });
async function load() {
  loading.value = true; error.value = ""; notice.value = "";
  try { config.value = await productApi.config(); policy.value = { ...config.value.security }; confirmed.value = false; pendingApply.value = (await productApi.diagnostics()).securityApplyPending ?? null; }
  catch (e) { error.value = productError(e); } finally { loading.value = false; }
}
async function save() {
  if (!config.value) return;
  if (policy.value.filesystem === "danger-full-access" && !confirmed.value) { error.value = "请先阅读风险并明确确认完全访问。"; return; }
  saving.value = true; error.value = ""; notice.value = "";
  try {
    const result = await productApi.update({ security: { ...policy.value, confirmFullAccess: policy.value.filesystem === "danger-full-access" ? confirmed.value : false } }, config.value.version);
    config.value = result.config; policy.value = { ...result.config.security }; confirmed.value = false;
    notice.value = `安全策略 v${result.config.version} 已保存。新任务使用新策略；收紧权限会触发正在执行任务的权限复核。`;
  } catch (e) { error.value = productError(e); } finally { saving.value = false; }
}
onMounted(load);
</script>
<template>
  <component :is="layout"><div class="product-page product-stack">
    <header class="product-header"><div><p class="product-eyebrow">GOVERNANCE / SECURITY</p><h1>安全策略</h1><p class="product-subtitle">明确工具能访问什么、何时需要审批。原生隔离不可用时保持拒绝执行。</p></div><span v-if="config" class="product-tag">策略 v{{ config.version }}</span></header>
    <p v-if="error" class="product-notice error" role="alert">{{ error }} <button @click="load" class="underline">刷新配置</button></p><p v-if="notice" class="product-notice success" role="status">{{ notice }}</p>
    <p v-if="pendingApply" class="product-notice warning" role="status">配置 v{{ pendingApply.version }} 已保存，运行中任务的权限复核尚未完成。{{ pendingApply.state === 'blocked' ? '安全应用处理器不可用，请检查 Coordinator 配置并恢复服务。' : '系统会按退避间隔重试。' }}<span v-if="pendingApply.attempts"> 已尝试 {{ pendingApply.attempts }} 次。</span></p>
    <p v-if="loading" class="product-empty" role="status">正在读取安全策略…</p>
    <form v-else-if="config && auth.isAdmin" class="product-stack" @submit.prevent="save">
      <section class="product-card product-stack"><div><h2>文件访问范围</h2><p class="product-help">工作区的物理路径和节点授权在 Projects 中维护，符号链接不会扩大授权。</p></div>
        <label class="product-field" for="filesystem-mode">默认文件权限<select id="filesystem-mode" v-model="policy.filesystem" class="product-input" :disabled="saving"><option value="read-only">只读 · 允许查看授权文件</option><option value="workspace-write">工作区读写 · 仅修改已授权目录</option><option v-if="config.security.filesystem === 'full-capability'" value="full-capability">现有扩展能力策略</option><option value="danger-full-access">完全访问 · 需要明确确认</option></select></label>
        <p v-if="policy.filesystem === 'danger-full-access'" class="product-notice warning">完全访问会降低原生文件隔离，工具可能修改工作区以外的数据。只有在理解风险并信任当前任务时启用，不能用于绕过沙箱安装失败。</p>
        <label v-if="policy.filesystem === 'danger-full-access'" class="product-toggle"><input v-model="confirmed" type="checkbox" :disabled="saving" required />我了解风险，明确允许该配置使用完全访问。</label>
        <router-link to="/projects" class="product-button self-start">查看工作区与项目授权</router-link>
      </section>
      <section class="product-card product-stack"><h2>网络与审批</h2><div class="product-grid"><label class="product-field" for="network-policy">工具进程网络<select id="network-policy" v-model="policy.network" class="product-input" :disabled="saving"><option value="deny">拒绝网络访问</option><option value="allow">允许网络访问</option></select><small>模型和集群连接由受控运行时单独处理。</small></label><label class="product-field" for="approval-policy">受限操作处理<select id="approval-policy" v-model="policy.approval" class="product-input" :disabled="saving"><option value="ask">请求人工审批</option><option value="never">直接拒绝，不请求审批</option><option value="auto-grant">安全审查通过后自动放行</option></select><small>安全硬拦截与安全审查仍然生效。</small></label></div></section>
      <section class="product-card product-stack"><h2>安全模型与审计</h2><p class="product-help">安全模型的继承、独立 Provider 和节点覆盖在 Models 中配置。安全审查不会因模型相同而省略。</p><div class="product-actions"><router-link to="/models" class="product-button">配置安全模型</router-link><router-link to="/approvals" class="product-button">审批记录</router-link><router-link to="/security/audit" class="product-button">安全审查历史</router-link></div></section>
      <div class="product-actions"><button type="submit" class="product-button primary" :disabled="saving || (policy.filesystem === 'danger-full-access' && !confirmed)">{{ saving ? '正在应用…' : '应用安全策略' }}</button><span class="product-help">作用范围：当前 Coordinator 管理的任务。</span></div>
    </form>
  </div></component>
</template>
