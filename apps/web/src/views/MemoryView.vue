<template>
  <component :is="layoutComponent">
    <div class="memory-page flex-1 w-full min-w-0 max-w-6xl mx-auto p-4 md:p-8 space-y-6">
      <header class="flex items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-2 text-nash-400 mb-2"><BookOpen :size="18" /><span class="text-xs font-semibold tracking-wide">项目知识库</span></div>
          <h1 class="text-2xl font-bold text-surface-100">联邦记忆</h1>
          <p class="mt-2 text-sm text-surface-400 leading-relaxed">按项目整理各节点共享的知识，查看内容、用途与来源。</p>
        </div>
        <button type="button" class="secondary-button shrink-0" :disabled="store.loading" @click="store.load(store.activeQuery)"><RefreshCw :size="16" :class="{ 'animate-spin': store.loading }" />刷新</button>
      </header>

      <section aria-label="记忆检索与筛选" class="rounded-2xl border border-surface-800 bg-surface-900 p-4 md:p-5 space-y-4">
        <form class="flex flex-col sm:flex-row gap-3" @submit.prevent="search">
          <div class="flex-1 min-w-0">
            <label for="memory-query" class="block text-sm font-medium text-surface-200 mb-2">搜索项目知识</label>
            <div class="relative"><Search :size="18" class="absolute left-3 top-3.5 text-surface-400 pointer-events-none" /><input id="memory-query" v-model="query" type="search" placeholder="例如：字幕提取、沙箱架构、音频同步" class="field pl-10" /></div>
          </div>
          <button type="submit" class="primary-button sm:self-end" :disabled="store.loading || !query.trim()">搜索记忆</button>
        </form>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label class="text-xs text-surface-400">项目<select aria-label="项目" v-model="projectFilter" class="field mt-1"><option value="">全部项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
          <label class="text-xs text-surface-400">节点<select aria-label="节点" v-model="nodeFilter" class="field mt-1"><option value="">全部节点</option><option v-for="nodeId in nodeIds" :key="nodeId" :value="nodeId">{{ nodeName(nodeId) }}</option></select></label>
          <label class="text-xs text-surface-400">排序<select aria-label="排序" v-model="sort" class="field mt-1"><option v-if="store.activeQuery" value="relevance">相关性优先</option><option value="recent">记录时间从新到旧</option><option value="topic">主题名称</option></select></label>
        </div>
        <div class="flex flex-wrap items-center gap-2 border-t border-surface-800 pt-4" aria-label="记忆来源筛选">
          <button v-for="tab in tabs" :key="tab.id" type="button" class="filter-button" :class="sourceFilter === tab.id ? 'bg-nash-500/10 text-nash-400 border-nash-500/40' : 'text-surface-400 border-transparent hover:text-surface-100'" :aria-pressed="sourceFilter === tab.id" @click="sourceFilter = tab.id">{{ tab.label }}<span class="ml-1.5 tabular-nums opacity-75">{{ tab.count }}</span></button>
        </div>
      </section>

      <div v-if="store.activeQuery" class="flex flex-wrap items-center justify-between gap-2 text-sm"><p class="text-surface-300">“{{ store.activeQuery }}”的搜索结果<span class="text-surface-400 ml-2">检索范围：共享主题摘要</span></p><button type="button" class="secondary-button" @click="browse">返回全部记忆</button></div>
      <p v-if="store.activeQuery" class="text-xs text-surface-400">相关性用于排列搜索结果，不代表内容正确率。列表按项目分组，组内按所选顺序排列。</p>
      <div v-if="store.error" role="alert" class="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-surface-200"><p>记忆加载失败：{{ store.error }}</p><button type="button" class="secondary-button mt-3" @click="store.load(store.activeQuery)">重试</button></div>
      <div v-else-if="store.loading" role="status" class="rounded-xl border border-surface-800 p-8 text-sm text-surface-400 flex items-center justify-center gap-3"><LoaderCircle :size="18" class="animate-spin" />正在读取记忆…</div>
      <template v-else>
        <div class="flex flex-wrap justify-between items-center gap-3 text-xs text-surface-400" aria-live="polite"><span>共 {{ filtered.length }} 条摘要 · {{ groups.length }} 个项目 · {{ filteredNodeCount }} 个节点</span><button v-if="projectFilter || nodeFilter || sourceFilter !== 'all'" type="button" class="text-nash-400 min-h-11 px-2" @click="clearFilters">清除筛选</button></div>
        <section v-for="group in visibleGroups" :key="group.id" class="space-y-3" :aria-label="`${group.name} 项目记忆`">
          <div class="flex items-center gap-3"><span class="rounded-lg bg-nash-500/10 text-nash-400 p-2"><Folder :size="18" /></span><h2 class="text-base font-semibold text-surface-100 break-all">{{ group.name }}</h2><span class="text-xs text-surface-400 shrink-0">{{ group.total }} 条</span></div>
          <div class="rounded-xl border border-surface-800 bg-surface-950 overflow-hidden divide-y divide-surface-800">
            <article v-for="item in group.items" :key="memoryKey(item)" class="p-4 md:p-5 space-y-3" data-testid="memory-card">
              <div class="flex items-start justify-between gap-3">
                <div class="flex flex-wrap items-center gap-2 min-w-0"><h3 class="text-sm font-semibold text-surface-100 break-all">{{ memoryTopic(item) }}</h3><span class="tag">{{ memoryOrigin(item) === 'discovery' ? '自主发现' : '项目记忆' }}</span><span v-if="memoryReviewReason(item)" class="tag review-tag">待核对</span><span v-if="duplicates.get(memoryKey(item))" class="tag">另有 {{ duplicates.get(memoryKey(item))!.length }} 条相同内容</span></div>
                <span v-if="store.activeQuery && typeof item.score === 'number'" class="text-xs text-nash-400 shrink-0 tabular-nums" title="规则计算的排序分，不代表准确率">相关性 {{ Math.round(item.score * 100) }}/100</span>
              </div>
              <div class="space-y-2"><p v-for="(point, index) in memoryPoints(item)" :key="index" class="text-sm text-surface-200 leading-7 break-words whitespace-pre-wrap"><span v-if="point.kind" class="text-xs text-surface-400 mr-2">{{ point.kind }}</span>{{ point.content || '未记录内容' }}</p></div>
              <p v-if="memoryReviewReason(item)" class="flex items-start gap-2 text-xs leading-6 text-amber-700 dark:text-amber-400 bg-amber-500/5 rounded-lg px-3 py-2"><CircleHelp :size="15" class="shrink-0 mt-1" />{{ memoryReviewReason(item) }}</p>
              <div class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-surface-400"><span class="inline-flex items-center gap-1.5"><Monitor :size="13" />{{ nodeName(item.nodeId) }}</span><span>记录时间 {{ formatMemoryTime(item) }}</span></div>
              <details class="text-xs text-surface-400">
                <summary class="cursor-pointer min-h-11 flex items-center gap-1.5 text-nash-400 w-fit select-none"><ChevronRight :size="14" class="details-chevron" />用途与来源</summary>
                <div class="rounded-lg bg-surface-900 border border-surface-800 p-4 space-y-4">
                  <div><h4 class="text-surface-200 font-medium mb-1">这条记忆用于什么</h4><p class="leading-6">{{ memoryPurpose(item) }}</p></div>
                  <dl class="grid grid-cols-1 md:grid-cols-2 gap-3 leading-6 break-all"><div><dt>项目标识</dt><dd class="text-surface-200 font-mono">{{ item.projectId }}</dd></div><div><dt>发布节点</dt><dd class="text-surface-200 font-mono">{{ item.nodeId }}</dd></div><div><dt>摘要标识</dt><dd class="text-surface-200 font-mono">{{ item.entryId }}</dd></div><div><dt>原始来源引用</dt><dd class="text-surface-200 font-mono">{{ item.sourceReference || item.evidence || '未提供来源引用' }}</dd></div></dl>
                  <p class="leading-6">来源引用用于定位原始记录，不表示内容已核验。记录时间按北京时间显示；历史索引可能记录的是导出时间。</p>
                  <div v-if="duplicates.get(memoryKey(item))" class="border-t border-surface-800 pt-3"><h4 class="text-surface-200 mb-1">相同内容也出现在</h4><p v-for="other in duplicates.get(memoryKey(item))" :key="memoryKey(other)" class="leading-6 break-all">{{ memoryProjectName(other) }} · {{ nodeName(other.nodeId) }} · {{ other.entryId }}</p><p class="mt-1">保留各自归属，尚未自动合并或删除。</p></div>
                </div>
              </details>
            </article>
          </div>
        </section>
        <div v-if="filtered.length > limit" class="text-center"><button type="button" class="secondary-button mx-auto" @click="limit += 30">继续显示（剩余 {{ filtered.length - limit }} 条）</button></div>
        <div v-if="filtered.length === 0" class="text-center border border-dashed border-surface-800 rounded-xl px-4 py-12 space-y-3"><BookOpen :size="28" class="mx-auto text-surface-400" /><h2 class="text-base font-semibold text-surface-200">{{ store.items.length ? '没有符合筛选条件的记忆' : store.activeQuery ? '没有找到相关记忆' : '暂无共享记忆' }}</h2><p class="text-sm text-surface-400">{{ store.activeQuery ? '试试项目名或更简短的关键词，也可以返回全部记忆。' : '项目发布的主题摘要会显示在这里。' }}</p></div>
      </template>
      <details class="border-t border-surface-800 pt-4 text-xs text-surface-400"><summary class="cursor-pointer min-h-11 flex items-center gap-2 w-fit"><CircleHelp :size="15" />这些记忆从哪里来？</summary><div class="space-y-2 leading-6 pb-4 max-w-3xl"><p>项目记忆来自 Worker 本地项目知识库；自主发现来自历史项目探查。这里显示的是共享摘要，不是本次会话的消息或任务产物。</p><p>原始记录由节点保管。当前页面搜索共享主题摘要；完整内容需要节点授权的远程检索。分类和来源标记不代表事实已经验证。</p><p>“待核对”提示内容缺少明确含义或依赖旧上下文；未标记也不代表已验证。历史记录均保留，便于追溯。</p></div></details>
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { BookOpen, ChevronRight, CircleHelp, Folder, LoaderCircle, Monitor, RefreshCw, Search } from "lucide-vue-next";
import { useUiStore } from "../stores/ui";
import { useClusterStore } from "../stores/cluster";
import { useMemoryStore } from "../stores/memory.js";
import { formatMemoryTime, memoryDuplicates, memoryKey, memoryOrigin, memoryPoints, memoryProjectName, memoryPurpose, memoryReviewReason, memoryTimestamp, memoryTopic, type MemoryRecord } from "../services/memory-presentation.js";
import DesktopLayout from "../components/layout/DesktopLayout.vue";
import TabletLayout from "../components/layout/TabletLayout.vue";
import MobileLayout from "../components/layout/MobileLayout.vue";

const uiStore = useUiStore();
const cluster = useClusterStore();
const store = useMemoryStore();
const query = ref("");
const projectFilter = ref("");
const nodeFilter = ref("");
const sourceFilter = ref("all");
const sort = ref("recent");
const limit = ref(30);
const layoutComponent = computed(() => uiStore.isMobile ? MobileLayout : uiStore.isTablet ? TabletLayout : DesktopLayout);
const knownItems = computed(() => [...new Map([...store.entries, ...store.results].map((item) => [memoryKey(item), item])).values()]);
const projects = computed(() => [...new Map(knownItems.value.map((item) => [item.projectId, { id: item.projectId, name: memoryProjectName(item) }])).values()].sort((a, b) => a.name.localeCompare(b.name)));
const nodeIds = computed(() => [...new Set(knownItems.value.map((item) => item.nodeId))]);
const duplicates = computed(() => memoryDuplicates(knownItems.value));
const baseItems = computed(() => store.items.filter((item) => (!projectFilter.value || item.projectId === projectFilter.value) && (!nodeFilter.value || item.nodeId === nodeFilter.value)));
const tabs = computed(() => [
  { id: "all", label: "全部", count: baseItems.value.length },
  { id: "project", label: "项目记忆", count: baseItems.value.filter((item) => memoryOrigin(item) === "project").length },
  { id: "discovery", label: "自主发现", count: baseItems.value.filter((item) => memoryOrigin(item) === "discovery").length },
  { id: "review", label: "待核对", count: baseItems.value.filter((item) => memoryReviewReason(item)).length },
]);
const filtered = computed(() => baseItems.value.filter((item) => sourceFilter.value === "all" || (sourceFilter.value === "review" ? !!memoryReviewReason(item) : memoryOrigin(item) === sourceFilter.value)).sort((a, b) => {
  if (sort.value === "relevance") return (b.score ?? 0) - (a.score ?? 0);
  if (sort.value === "topic") return memoryTopic(a).localeCompare(memoryTopic(b), "zh-CN");
  return memoryTimestamp(b) - memoryTimestamp(a);
}));
function groupItems(items: MemoryRecord[]) {
  const totals = new Map<string, number>();
  for (const item of filtered.value) totals.set(item.projectId, (totals.get(item.projectId) ?? 0) + 1);
  const groups = new Map<string, { id: string; name: string; items: MemoryRecord[]; total: number }>();
  for (const item of items) {
    const group = groups.get(item.projectId) ?? { id: item.projectId, name: memoryProjectName(item), items: [], total: totals.get(item.projectId) ?? 0 };
    group.items.push(item); groups.set(item.projectId, group);
  }
  return [...groups.values()];
}
const groups = computed(() => groupItems(filtered.value));
const visibleGroups = computed(() => groupItems(filtered.value.slice(0, limit.value)));
const filteredNodeCount = computed(() => new Set(filtered.value.map((item) => item.nodeId)).size);
function nodeName(nodeId: string) { return cluster.nodes.find((node) => node.nodeId === nodeId)?.name || nodeId.replace(/^node-/, ""); }
function clearFilters() { projectFilter.value = ""; nodeFilter.value = ""; sourceFilter.value = "all"; }
async function search() { if (query.value.trim()) { sort.value = "relevance"; await store.load(query.value); } }
async function browse() { query.value = ""; sort.value = "recent"; await store.load(); }
watch([projectFilter, nodeFilter, sourceFilter, sort, () => store.activeQuery], () => { limit.value = 30; });
onMounted(() => { query.value = store.activeQuery; sort.value = store.activeQuery ? "relevance" : "recent"; void store.load(store.activeQuery); });
onUnmounted(() => store.$dispose());
</script>

<style scoped>
.field { @apply min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2.5 text-base sm:text-sm text-surface-100 outline-none focus:border-nash-500 focus:ring-2 focus:ring-nash-500/20; }
.field.pl-10 { padding-left: 2.5rem; }
.primary-button { @apply min-h-11 rounded-lg bg-nash-500 px-5 text-sm font-semibold text-white hover:bg-nash-600 disabled:opacity-50 disabled:cursor-not-allowed; }
.secondary-button { @apply min-h-11 px-3 rounded-lg border border-surface-700 text-sm text-surface-300 hover:bg-surface-900 disabled:opacity-50 inline-flex items-center justify-center gap-2; }
.filter-button { @apply min-h-11 px-3 rounded-lg border text-xs font-medium; }
.tag { @apply border border-surface-700 rounded-md px-2 py-0.5 text-xs text-surface-400; }
.tag.review-tag { @apply border-amber-500/40 text-amber-700 dark:text-amber-400; }
button, summary { @apply focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nash-500; }
details[open] > summary .details-chevron { transform: rotate(90deg); }
</style>
