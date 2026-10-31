<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { api } from "../services/api";
import { useRoute } from "vue-router";
import { productApi, productError, profileDraft, profileInput, type ProductConfig, type ProfileDraft, type PublicProfile, type SecurityBinding, type ModelCheck } from "../services/product-api";
import { useUiStore } from "../stores/ui";
import { useAuthStore } from "../stores/auth";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";
const ui = useUiStore(), auth = useAuthStore(), route = useRoute();
const layout = computed(() => ui.isMobile ? MobileLayout : ui.isTablet ? TabletLayout : DesktopLayout);
const config = ref<ProductConfig>(), nodes = ref<Array<{ nodeId: string; name: string; status: string }>>([]);
const versions = ref<Array<{ version: number; createdAt: number }>>([]), rollbackVersion = ref(0);
const loading = ref(true), busy = ref(""), error = ref(""), notice = ref("");
const target = ref(typeof route.query.node === "string" ? route.query.node : ""), mainMode = ref("independent"), securityMode = ref<SecurityBinding["mode"]>("follow-main"), securityModel = ref("");
const main = ref<ProfileDraft>(profileDraft()), independentSecurity = ref<ProfileDraft>(profileDraft());
const reports = ref<Record<string, ModelCheck>>({});
const editors = computed(() => [
  ...(!target.value || mainMode.value === "independent" ? [{ key: "main", title: "主模型配置", draft: main.value }] : []),
  ...(securityMode.value === "independent" ? [{ key: "security", title: "独立安全模型", draft: independentSecurity.value }] : []),
]);
const labels: Record<string, string> = { text: "文本生成", tools: "工具调用", arguments: "工具参数", multiTurn: "多轮工具结果", streaming: "流式输出", streamingTools: "流式工具调用", streamingArguments: "流式工具参数", streamingMultiTurn: "流式多轮结果", cancellation: "取消传播" };
function resetDrafts() {
  if (!config.value) return;
  const override = target.value ? config.value.nodeOverrides[target.value] : undefined;
  mainMode.value = target.value && !override?.main ? "inherit" : "independent";
  main.value = profileDraft(override?.main ?? config.value.models.main);
  if (target.value && !override?.main) main.value.apiKeyConfigured = false;
  const binding = override?.security ?? config.value.models.security;
  securityMode.value = target.value && !override?.security && binding.mode === "independent" ? "coordinator" : binding.mode;
  securityModel.value = binding.mode === "same-provider" ? binding.model : "";
  independentSecurity.value = profileDraft(binding.mode === "independent" ? binding.profile : undefined);
  reports.value = {}; error.value = "";
}
watch(target, resetDrafts);
watch([main, independentSecurity, securityMode, securityModel, mainMode], () => { reports.value = {}; }, { deep: true });
async function load() {
  loading.value = true; error.value = "";
  try {
    const [cfg, history, nodeList] = await Promise.all([productApi.config(), productApi.versions(), api.getNodes()]);
    config.value = cfg; versions.value = history.versions; nodes.value = nodeList.nodes.filter(n => n.status !== "revoked"); resetDrafts();
  } catch (e) { error.value = productError(e); } finally { loading.value = false; }
}
function validProfile(draft: ProfileDraft) {
  if (!draft.model.trim() || !draft.baseUrl.trim()) throw new Error("请填写模型名称与服务地址。");
  let url: URL; try { url = new URL(draft.baseUrl); } catch { throw new Error("请填写有效的 HTTP(S) 服务地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("服务地址必须为不含凭据和查询参数的 HTTP(S) URL。");
  if (!draft.apiKey && !draft.apiKeyConfigured) throw new Error("请为新模型配置输入 API Key。");
}
function securityInput(): SecurityBinding {
  if (securityMode.value === "independent") { validProfile(independentSecurity.value); return { mode: "independent", profile: profileInput(independentSecurity.value) }; }
  if (securityMode.value === "same-provider") { if (!securityModel.value.trim()) throw new Error("请输入安全模型名称。"); return { mode: "same-provider", model: securityModel.value.trim() }; }
  return { mode: securityMode.value };
}
async function test(purpose: "main" | "security") {
  busy.value = `test-${purpose}`; error.value = ""; notice.value = "";
  try {
    let draft: ProfileDraft, testPurpose = purpose, nodeId = target.value || undefined;
    if (purpose === "main") {
      draft = target.value && mainMode.value === "inherit" ? profileDraft(config.value?.models.main) : main.value;
      if (target.value && mainMode.value === "inherit") nodeId = undefined;
    } else if (securityMode.value === "independent") draft = independentSecurity.value;
    else if (securityMode.value === "coordinator") {
      const binding = config.value!.models.security;
      draft = profileDraft(binding.mode === "independent" ? binding.profile : config.value!.models.main);
      if (binding.mode === "same-provider") draft.model = binding.model;
      nodeId = undefined;
    } else {
      draft = target.value && mainMode.value === "inherit" ? profileDraft(config.value?.models.main) : { ...main.value };
      testPurpose = "main";
      if (target.value && mainMode.value === "inherit") nodeId = undefined;
      if (securityMode.value === "same-provider") draft.model = securityModel.value.trim();
    }
    validProfile(draft);
    reports.value[purpose] = await productApi.testModel(profileInput(draft), testPurpose, nodeId);
    notice.value = "能力测试已完成。测试不会保存配置。";
  } catch (e) { delete reports.value[purpose]; error.value = productError(e); } finally { busy.value = ""; }
}
async function save() {
  if (!config.value) return;
  busy.value = "save"; error.value = ""; notice.value = "";
  try {
    if (!target.value || mainMode.value === "independent") validProfile(main.value);
    const security = securityInput();
    const patch = target.value ? { nodeOverrides: { [target.value]: { main: mainMode.value === "independent" ? profileInput(main.value) : undefined, security } } } : { models: { main: profileInput(main.value), security } };
    const result = await productApi.update(patch, config.value.version);
    config.value = result.config; resetDrafts();
    versions.value = (await productApi.versions()).versions;
    notice.value = `配置 v${result.config.version} 已应用于新任务。正在执行的请求保留原版本。`;
  } catch (e) { error.value = productError(e); } finally { busy.value = ""; }
}
async function rollback() {
  if (!config.value || !rollbackVersion.value || !window.confirm(`将当前配置恢复为 v${rollbackVersion.value} 的内容？此操作会创建新版本，并可能恢复旧的模型或安全设置。`)) return;
  busy.value = "rollback"; error.value = "";
  try {
    const version = Number(rollbackVersion.value), expected = config.value.version;
    const result = await productApi.rollback(version, expected).catch((failure: unknown) => {
      if (!(failure instanceof Error) || !failure.message.includes("回滚目标为完全访问")) throw failure;
      if (!window.confirm("此历史版本会恢复完全访问，允许工具修改授权工作区以外的数据。明确接受此风险并继续恢复？")) throw new Error("已取消完全访问恢复，当前配置保持不变。");
      return productApi.rollback(version, expected, true);
    });
    config.value = result.config; resetDrafts(); versions.value = (await productApi.versions()).versions;
    notice.value = `已恢复并创建配置 v${result.config.version}，新任务使用此版本。${result.restartRequired ? "服务启动设置已变化，请安排重启后确认连接生效。" : ""}`; rollbackVersion.value = 0;
  } catch (e) { error.value = productError(e); } finally { busy.value = ""; }
}
onMounted(load);
</script>

<template>
  <component :is="layout">
    <div class="product-page product-stack">
      <header class="product-header">
        <div><p class="product-eyebrow">CONFIGURATION / MODELS</p><h1>模型配置</h1><p class="product-subtitle">为推理与安全审查选择模型。先验证能力，再将配置应用到新任务。</p></div>
        <span v-if="config" class="product-tag">当前版本 v{{ config.version }}</span>
      </header>
      <p v-if="error" class="product-notice error" role="alert">{{ error }} <button type="button" @click="load" class="underline ml-2">刷新配置</button></p>
      <p v-if="notice" class="product-notice success" role="status">{{ notice }}</p>
      <p v-if="loading" class="product-empty" role="status">正在读取模型配置…</p>
      <template v-else-if="config && auth.isAdmin">
        <section class="product-card">
          <label class="product-field" for="model-target">配置范围
            <select id="model-target" v-model="target" class="product-input" :disabled="!!busy">
              <option value="">Coordinator 默认模型</option><option v-for="node in nodes" :key="node.nodeId" :value="node.nodeId">{{ node.name }} · {{ node.nodeId }}</option>
            </select>
            <small>节点覆盖仅影响选中的 Worker。继承模型通过认证网关调用，不向 Worker 复制服务密钥。</small>
          </label>
        </section>
        <form class="product-stack" @submit.prevent="save">
          <section class="product-card product-stack">
            <div><h2>主模型</h2><p class="product-help">负责理解任务、规划和工具调用。</p></div>
            <label v-if="target" class="product-field" for="main-inheritance">使用方式<select id="main-inheritance" v-model="mainMode" class="product-input" :disabled="!!busy"><option value="inherit">继承 Coordinator 主模型</option><option value="independent">为此节点单独配置</option></select></label>
            <p v-if="target && mainMode === 'inherit'" class="product-notice">使用 Coordinator 主模型：{{ config.models.main?.model || '尚未配置' }}。凭据保留在 Coordinator。</p>
          </section>
          <section class="product-card product-stack">
            <div><h2>安全模型关系</h2><p class="product-help">关系动态解析；即使使用同一模型，安全审查仍使用独立上下文。</p></div>
            <label class="product-field" for="security-inheritance">安全模型<select id="security-inheritance" v-model="securityMode" class="product-input" :disabled="!!busy"><option value="follow-main">跟随本节点主模型</option><option value="same-provider">同 Provider，不同模型</option><option value="independent">完全独立配置</option><option v-if="target" value="coordinator">跟随 Coordinator 安全模型</option></select></label>
            <label v-if="securityMode === 'same-provider'" class="product-field" for="security-name">安全模型名称<input id="security-name" v-model="securityModel" required class="product-input" :disabled="!!busy" /></label>
          </section>
          <section v-for="editor in editors" :key="editor.key" class="product-card product-stack">
            <h2>{{ editor.title }}</h2>
            <div class="product-grid">
              <label class="product-field" :for="`${editor.key}-format`">API 协议<select :id="`${editor.key}-format`" v-model="editor.draft.format" class="product-input" :disabled="!!busy"><option value="completions">Chat Completions</option><option value="responses">Responses</option><option value="messages">Anthropic Messages</option></select></label>
              <label class="product-field" :for="`${editor.key}-model`">模型名称<input :id="`${editor.key}-model`" v-model="editor.draft.model" required maxlength="256" class="product-input" :disabled="!!busy" placeholder="Provider 提供的模型名称" /></label>
              <label class="product-field" :for="`${editor.key}-url`">服务地址<input :id="`${editor.key}-url`" v-model="editor.draft.baseUrl" required type="url" class="product-input" :disabled="!!busy" placeholder="https://api.example.com/v1" /><small>使用 Provider 提供的 API 前缀，不要在地址中填写密钥。</small></label>
              <label class="product-field" :for="`${editor.key}-key`">API Key<input :id="`${editor.key}-key`" v-model="editor.draft.apiKey" type="password" autocomplete="new-password" :required="!editor.draft.apiKeyConfigured" class="product-input" :disabled="!!busy" :placeholder="editor.draft.apiKeyConfigured ? '已保存；留空保留原密钥' : '输入新的服务密钥'" /><small>{{ editor.draft.apiKeyConfigured ? '已保存的密钥不会回显。更换服务地址时请同时输入新密钥。' : '凭据仅发送至后台受保护存储。' }}</small></label>
            </div>
            <details><summary class="product-help cursor-pointer">超时与能力选项</summary><div class="product-grid mt-4"><label class="product-field" :for="`${editor.key}-timeout`">超时（毫秒）<input :id="`${editor.key}-timeout`" v-model.number="editor.draft.timeoutMs" type="number" min="1000" max="600000" step="1000" class="product-input" :disabled="!!busy" /></label><div class="product-stack"><label class="product-toggle"><input type="checkbox" v-model="editor.draft.streaming" :disabled="!!busy" />启用流式输出</label><label class="product-toggle"><input type="checkbox" v-model="editor.draft.toolCalling" :disabled="!!busy" />启用工具调用</label></div></div></details>
          </section>
          <section class="product-card product-stack">
            <div><h2>真实能力测试</h2><p class="product-help">会向服务发出实际请求，验证文本、工具参数、多轮、流式和取消。测试可能产生费用，且不会保存配置。</p></div>
            <div class="product-actions"><button type="button" class="product-button" :disabled="!!busy" @click="test('main')">{{ busy === 'test-main' ? '正在验证主模型…' : '测试主模型' }}</button><button type="button" class="product-button" :disabled="!!busy" @click="test('security')">{{ busy === 'test-security' ? '正在验证安全模型…' : '测试安全模型' }}</button></div>
            <p v-if="busy" class="product-help" role="status">{{ busy === 'save' ? '后端正在校验并测试配置，请稍候…' : '操作进行中，请等待实际结果。' }}</p>
            <div v-for="(report, key) in reports" :key="key" class="product-notice"><strong>{{ key === 'main' ? '主模型' : '安全模型' }} · {{ report.passed ? '测试通过' : '未通过' }}</strong><p class="product-help">{{ report.model }} · {{ report.format }} · {{ (report.durationMs / 1000).toFixed(1) }} 秒</p><div class="product-actions mt-3"><span v-for="(passed, check) in report.checks" :key="check" class="product-tag" :class="passed ? 'success' : 'warning'">{{ labels[check] || check }}：{{ passed ? '通过' : '未通过' }}</span><span class="product-tag">Usage：{{ report.usageReported ? '已报告' : '未报告' }}</span></div></div>
            <div class="product-actions"><button type="submit" class="product-button primary" :disabled="!!busy">{{ busy === 'save' ? '正在验证并保存…' : '验证并应用配置' }}</button><span class="product-help">保存失败会保留原有效配置。</span></div>
          </section>
        </form>
        <section class="product-card product-stack"><div><h2>配置版本恢复</h2><p class="product-help">恢复会创建新版本，包含该版本的模型与安全设置。不会回滚任务副作用或数据库结构。</p></div><div class="product-actions"><select v-model.number="rollbackVersion" aria-label="选择历史配置版本" class="product-input" style="max-width:320px" :disabled="!!busy"><option :value="0">选择历史版本</option><option v-for="version in versions.filter(v => v.version !== config!.version)" :key="version.version" :value="version.version">v{{ version.version }} · {{ new Date(version.createdAt).toLocaleString() }}</option></select><button type="button" class="product-button" :disabled="!!busy || !rollbackVersion" @click="rollback">审阅并恢复</button></div></section>
      </template>
    </div>
  </component>
</template>
