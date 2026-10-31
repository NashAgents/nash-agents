<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { productApi, productError, type ProductConfig, type ProductUser, type Diagnostics } from "../services/product-api";
import { useUiStore } from "../stores/ui";
import { useAuthStore } from "../stores/auth";
import { useI18n } from "../i18n";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
const ui = useUiStore(), auth = useAuthStore(), router = useRouter();
const { lang, toggleLanguage } = useI18n();
const layout = computed(() => ui.isMobile ? MobileLayout : ui.isTablet ? TabletLayout : DesktopLayout);
const config = ref<ProductConfig>(), diagnostics = ref<Diagnostics>(), users = ref<ProductUser[]>([]);
const loading = ref(true), busy = ref(""), error = ref(""), notice = ref("");
const listenHost = ref(""), listenPort = ref(18443), publicUrl = ref(""), databaseUrl = ref("");
const username = ref(""), newPassword = ref(""), repeatedPassword = ref("");
const selectedUser = ref(""), changedPassword = ref(""), repeatedChange = ref("");
async function load() {
  loading.value = true; error.value = "";
  if (!auth.isAdmin) { loading.value = false; return; }
  try {
    const [cfg, accounts, diag] = await Promise.all([productApi.config(), productApi.users(), productApi.diagnostics()]);
    config.value = cfg; users.value = accounts.users; diagnostics.value = diag;
    listenHost.value = cfg.coordinator.listenHost; listenPort.value = cfg.coordinator.listenPort; publicUrl.value = cfg.coordinator.publicUrl ?? ""; databaseUrl.value = "";
    if (!selectedUser.value) selectedUser.value = auth.user?.userId ?? "";
  } catch (e) { error.value = productError(e); } finally { loading.value = false; }
}
async function saveConnection() {
  if (!config.value) return;
  busy.value = "connection"; error.value = ""; notice.value = "";
  try {
    const result = await productApi.update({ coordinator: { listenHost: listenHost.value.trim(), listenPort: listenPort.value, publicUrl: publicUrl.value.trim() || undefined, ...(databaseUrl.value ? { databaseUrl: databaseUrl.value } : {}) } }, config.value.version);
    config.value = result.config; databaseUrl.value = "";
    notice.value = `配置 v${result.config.version} 已保存。监听与数据库连接需要计划内重启后生效，请先备份并停止本产品实例。`;
  } catch (e) { error.value = productError(e); } finally { busy.value = ""; }
}
function validPassword(password: string, confirmation: string) {
  if (password.length < 12) throw new Error("密码至少需要 12 个字符。");
  if (password !== confirmation) throw new Error("两次输入的密码不一致。");
}
async function createAdmin() {
  busy.value = "create"; error.value = ""; notice.value = "";
  try {
    validPassword(newPassword.value, repeatedPassword.value);
    const result = await productApi.createAdmin(username.value.trim(), newPassword.value);
    newPassword.value = ""; repeatedPassword.value = ""; username.value = "";
    users.value = (await productApi.users()).users;
    notice.value = `管理员 ${result.user.username} 已创建。`;
  } catch (e) { error.value = productError(e); } finally { busy.value = ""; }
}
async function changePassword() {
  busy.value = "password"; error.value = ""; notice.value = "";
  try {
    validPassword(changedPassword.value, repeatedChange.value);
    if (!selectedUser.value) throw new Error("请选择要修改的账号。");
    const result = await productApi.changePassword(selectedUser.value, changedPassword.value);
    changedPassword.value = ""; repeatedChange.value = "";
    notice.value = result.sessionsRevoked ? "密码已更新，该账号的现有会话已撤销。" : "密码已更新。";
    if (selectedUser.value === auth.user?.userId) { await auth.logout(); await router.replace("/login"); }
  } catch (e) { error.value = productError(e); } finally { busy.value = ""; }
}
async function logout() { await auth.logout(); await router.replace("/login"); }
onMounted(load);
</script>
<template><component :is="layout"><div class="product-page product-stack">
  <header class="product-header"><div><p class="product-eyebrow">SYSTEM / SETTINGS</p><h1>系统设置</h1><p class="product-subtitle">管理连接、管理员和你的控制台偏好。修改需要重启的设置时会明确提示。</p></div><span v-if="config" class="product-tag">配置 v{{ config.version }}</span></header>
  <p v-if="error" class="product-notice error" role="alert">{{ error }} <button class="underline" @click="load">刷新</button></p><p v-if="notice" class="product-notice success" role="status">{{ notice }}</p>
  <p v-if="loading" class="product-empty" role="status">正在读取系统设置…</p>
  <template v-else-if="config && auth.isAdmin">
    <form class="product-card product-stack" @submit.prevent="saveConnection"><div><h2>Coordinator 与存储</h2><p class="product-help">公布地址用于用户和 Worker 访问；数据库连接不回显凭据。</p></div><div class="product-grid"><label class="product-field" for="listen-host">监听地址<input id="listen-host" v-model="listenHost" class="product-input" required :disabled="!!busy" /></label><label class="product-field" for="listen-port">监听端口<input id="listen-port" v-model.number="listenPort" type="number" min="1" max="65535" class="product-input" required :disabled="!!busy" /></label></div><label class="product-field" for="public-url">公布地址<input id="public-url" v-model="publicUrl" type="url" class="product-input" :disabled="!!busy" placeholder="https://coordinator.example.com" /><small>跨不可信网络应使用可信 HTTPS/WSS，端口号本身不会启用 TLS。</small></label><label class="product-field" for="database-url">PostgreSQL 连接<input id="database-url" v-model="databaseUrl" type="password" autocomplete="new-password" class="product-input" :disabled="!!busy" :placeholder="config.coordinator.databaseConfigured ? '已配置；留空保留现有连接' : '留空继续使用本地持久存储'" /><small>配置变更不自动搬迁本地任务数据。切换存储前请备份并单独计划迁移。</small></label><div class="product-notice"><p>管理员配置：{{ diagnostics?.database.product || '尚未报告' }} · 任务存储：{{ diagnostics?.database.cluster === 'local' ? '本地持久存储' : diagnostics?.database.cluster || '尚未报告' }}</p><p v-if="diagnostics?.pendingRestart" class="product-help mt-1">已保存的服务设置等待重启；以下连接状态属于当前运行实例。</p><p class="product-help mt-1">{{ diagnostics?.database.connection?.cluster === 'connected' ? '当前任务存储连接正常' : diagnostics?.database.connection?.cluster === 'unavailable' ? '当前任务存储连接不可用，请检查诊断' : '连接探测结果尚未报告' }}</p></div><div class="product-actions"><button type="submit" class="product-button primary" :disabled="!!busy">{{ busy === 'connection' ? '保存中…' : '保存连接设置' }}</button><router-link to="/diagnostics" class="product-button">查看实际连接诊断</router-link></div></form>
    <section class="product-card product-stack"><div><h2>管理员账号</h2><p class="product-help">没有固定测试账户。管理员可管理模型、策略和节点，请谨慎授予权限。</p></div><div class="product-list"><div v-for="user in users" :key="user.userId"><span class="font-medium text-sm">{{ user.username }} <span v-if="user.userId === auth.user?.userId" class="product-help">（当前账号）</span></span><span class="product-tag">{{ user.role === 'admin' ? '管理员' : '查看者' }}</span></div></div>
      <details><summary class="product-help cursor-pointer">创建管理员</summary><form @submit.prevent="createAdmin" class="product-stack mt-5"><label class="product-field" for="admin-username">用户名<input id="admin-username" v-model="username" required maxlength="64" autocomplete="off" class="product-input" :disabled="!!busy" /></label><div class="product-grid"><label class="product-field" for="admin-password">新密码<input id="admin-password" v-model="newPassword" type="password" required minlength="12" maxlength="1024" autocomplete="new-password" class="product-input" :disabled="!!busy" /><small>至少 12 个字符。</small></label><label class="product-field" for="admin-repeat">再次输入密码<input id="admin-repeat" v-model="repeatedPassword" type="password" required minlength="12" autocomplete="new-password" class="product-input" :disabled="!!busy" /></label></div><button type="submit" class="product-button self-start" :disabled="!!busy">{{ busy === 'create' ? '正在创建…' : '创建管理员' }}</button></form></details>
      <hr class="product-divider" /><form @submit.prevent="changePassword" class="product-stack"><h3 class="font-semibold text-sm">更新账号密码</h3><label class="product-field" for="password-account">账号<select id="password-account" v-model="selectedUser" required class="product-input" :disabled="!!busy"><option v-for="user in users" :key="user.userId" :value="user.userId">{{ user.username }}</option></select></label><div class="product-grid"><label class="product-field" for="changed-password">新密码<input id="changed-password" v-model="changedPassword" type="password" required minlength="12" maxlength="1024" autocomplete="new-password" class="product-input" :disabled="!!busy" /></label><label class="product-field" for="changed-repeat">再次输入密码<input id="changed-repeat" v-model="repeatedChange" type="password" required minlength="12" autocomplete="new-password" class="product-input" :disabled="!!busy" /></label></div><p class="product-help">更新后该账号的现有会话会撤销；修改自己的密码后需要重新登录。</p><button type="submit" class="product-button self-start" :disabled="!!busy">{{ busy === 'password' ? '正在更新…' : '更新密码并撤销旧会话' }}</button></form>
    </section>
    <section class="product-card product-stack"><h2>备份与恢复</h2><p class="product-help">停止本产品后备份完整产品目录，包括配置数据库、匹配的主密钥、节点身份和任务产物。使用 PostgreSQL 时另做一致性备份。不要在浏览器下载或分享包含真实凭据的目录。</p><a href="https://github.com/NashAgents/nash-agents/blob/main/docs/operations/backup-restore.md" target="_blank" rel="noopener noreferrer" class="product-button self-start">阅读备份与恢复指引</a></section>
  </template>
  <section class="product-card product-stack"><h2>界面与会话</h2><div class="product-actions"><button class="product-button" @click="toggleLanguage">{{ lang === 'zh' ? 'Switch to English' : '切换为中文' }}</button><button class="product-button" @click="ui.toggleTheme">{{ ui.isDark ? '使用明亮主题' : '使用深色主题' }}</button><button class="product-button danger" @click="logout">退出当前登录</button></div><p class="product-help">主题和语言偏好保存在当前浏览器，不会改变其他用户的配置。</p></section>
</div></component></template>
