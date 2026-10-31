<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { api } from "../services/api";
import { productApi, productError } from "../services/product-api";
import { useUiStore } from "../stores/ui";
import { useAuthStore } from "../stores/auth";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
import Modal from "../components/ui/Modal.vue";
const ui = useUiStore(), auth = useAuthStore(), layout = computed(() => ui.isMobile ? MobileLayout : ui.isTablet ? TabletLayout : DesktopLayout);
const nodes = ref<any[]>([]), loading = ref(true), busy = ref(""), error = ref(""), notice = ref("");
const invitation = ref<{ inviteCode: string; expiresAt: number }>(), showDetails = ref(false), selected = ref<any>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const active = computed(() => nodes.value.filter(n => n.status !== "revoked")), online = computed(() => nodes.value.filter(n => n.status === "online"));
const states: Record<string, string> = { online: "在线", offline: "离线", revoked: "已撤销" };
async function load() {
  loading.value = true; error.value = "";
  try { nodes.value = (await api.getNodes()).nodes; } catch (e) { error.value = productError(e); } finally { loading.value = false; }
}
async function invite() {
  busy.value = "invite"; error.value = ""; notice.value = "";
  try {
    invitation.value = await productApi.invite();
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { invitation.value = undefined; }, Math.max(0, invitation.value.expiresAt - Date.now()));
  } catch (e) { error.value = productError(e); } finally { busy.value = ""; }
}
async function copyInvite() {
  if (!invitation.value) return;
  try { await navigator.clipboard.writeText(invitation.value.inviteCode); notice.value = "邀请码已复制，请仅通过可信渠道分享给加入者。"; }
  catch { error.value = "当前浏览器无法访问剪贴板，请手动选择并复制邀请码。"; }
}
async function revoke(node: any) {
  if (!window.confirm(`撤销节点“${node.name}”的连接与执行权限？已有身份将不能继续连接，重新加入需要新的邀请。`)) return;
  busy.value = node.nodeId; error.value = ""; notice.value = "";
  try { const result = await productApi.revokeNode(node.nodeId); if (!result.success) throw new Error("节点撤销未成功，请刷新状态后重试。"); notice.value = `节点 ${node.name} 的访问权限已撤销。`; await load(); }
  catch (e) { error.value = productError(e); } finally { busy.value = ""; }
}
function details(node: any) { selected.value = node; showDetails.value = true; }
onMounted(load);
onBeforeUnmount(() => { if (expiryTimer) clearTimeout(expiryTimer); invitation.value = undefined; });
</script>
<template><component :is="layout"><div class="product-page product-stack">
  <header class="product-header"><div><p class="product-eyebrow">RESOURCES / NODES</p><h1>执行节点</h1><p class="product-subtitle">通过一次性邀请注册 Worker。节点身份、项目授权和模型凭据分别管理。</p></div><div class="product-actions"><button class="product-button" :disabled="loading || !!busy" @click="load">刷新</button><button v-if="auth.isAdmin" class="product-button primary" :disabled="!!busy" @click="invite">{{ busy === 'invite' ? '生成中…' : '邀请新节点' }}</button></div></header>
  <p v-if="error" class="product-notice error" role="alert">{{ error }}</p><p v-if="notice" class="product-notice success" role="status">{{ notice }}</p>
  <section v-if="invitation" class="product-card product-stack"><h2>一次性节点邀请</h2><p class="product-help">有效至 {{ new Date(invitation.expiresAt).toLocaleString() }}，仅可使用一次。不要公开或放进命令行参数。</p><label class="product-field" for="node-invite">邀请码<input id="node-invite" class="product-input product-mono" :value="invitation.inviteCode" readonly autocomplete="off" /></label><div class="product-actions"><button class="product-button" @click="copyInvite">复制邀请码</button><button class="product-button" @click="invitation = undefined">隐藏邀请码</button></div><p class="product-help">在新 Worker 上完成初始化后运行 <code>node dist/index.js node join</code>，按隐藏输入提示配对。</p></section>
  <div class="product-actions"><span class="product-tag success">{{ online.length }} 个在线</span><span class="product-tag">{{ active.length }} 个活跃身份</span><span class="product-tag">{{ nodes.length - active.length }} 个已撤销</span></div>
  <p v-if="loading" class="product-empty" role="status">正在读取真实节点状态…</p><div v-else-if="!nodes.length" class="product-card product-empty"><h2>还没有注册的节点</h2><p>在本机启动 Coordinator + Worker，或生成一次性邀请加入独立 Worker。</p></div>
  <div v-else class="product-grid"><article v-for="node in nodes" :key="node.nodeId" class="product-card product-stack"><div class="product-actions"><h2 class="mr-auto">{{ node.name }}</h2><span class="product-tag" :class="node.status === 'online' ? 'success' : node.status === 'offline' ? 'warning' : ''">{{ states[node.status] || node.status }}</span></div><p class="product-mono text-surface-400">{{ node.nodeId }}</p><dl class="product-list text-sm"><div><dt>角色</dt><dd>{{ node.role || '未上报' }}</dd></div><div><dt>系统与架构</dt><dd>{{ node.platform || '未上报' }} · {{ node.arch || '未上报' }}</dd></div><div><dt>主机名称</dt><dd class="truncate max-w-[200px]">{{ node.hostname || '未上报' }}</dd></div><div><dt>沙箱</dt><dd>{{ node.sandboxCapability?.name || '尚未上报' }}</dd></div><div><dt>隔离验证</dt><dd>{{ node.sandboxCapability?.status === 'verified' ? '已验证' : node.sandboxCapability?.status ? '已探测，尚未完整验证' : '未报告' }}</dd></div><div><dt>最后心跳</dt><dd>{{ node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : '尚未收到' }}</dd></div></dl><div class="product-actions"><button class="product-button" @click="details(node)">查看能力</button><router-link v-if="auth.isAdmin && node.status !== 'revoked'" :to="{ path: '/models', query: { node: node.nodeId } }" class="product-button">模型覆盖</router-link><button v-if="auth.isAdmin && node.status !== 'revoked'" class="product-button danger" :disabled="!!busy" @click="revoke(node)">{{ busy === node.nodeId ? '撤销中…' : '撤销权限' }}</button></div></article></div>
</div></component>
<Modal v-model="showDetails" :title="`${selected?.name || '节点'} · 能力报告`"><div v-if="selected" class="product-stack"><p class="product-mono">{{ selected.nodeId }}</p><p class="product-help">{{ selected.sandboxCapability?.details || '尚无沙箱详细报告。连接在线不代表隔离验证通过。' }}</p><dl v-if="selected.sandboxCapability?.structuredDetails" class="product-list text-sm"><div><dt>进程树治理</dt><dd>{{ selected.sandboxCapability.structuredDetails.processIsolationVerified ? '已验证' : '未验证' }}</dd></div><div><dt>文件系统隔离</dt><dd>{{ selected.sandboxCapability.structuredDetails.filesystemIsolationVerified ? '已验证' : '未验证' }}</dd></div><div><dt>网络隔离</dt><dd>{{ selected.sandboxCapability.structuredDetails.networkIsolationVerified ? '已验证' : '未验证' }}</dd></div></dl><h3 class="font-semibold">上报的能力</h3><div v-if="selected.capabilities?.length" class="product-actions"><span v-for="capability in selected.capabilities" :key="capability.name" class="product-tag">{{ capability.name }} · {{ capability.status }}</span></div><p v-else class="product-help">尚无能力清单，不填充默认能力。</p></div></Modal>
</template>
