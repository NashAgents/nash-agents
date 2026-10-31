<template>
  <section class="rounded-xl border border-surface-800 bg-surface-900 p-4 space-y-4" aria-label="运行性能分析" data-testid="runtime-performance">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-sm font-semibold text-surface-100">运行性能分析</h3>
      <span class="text-xs text-surface-400">Usage {{ usage?.completeness || 'NO_DATA' }} · Trace {{ trace?.completeness || 'NO_DATA' }}</span>
    </header>
    <p v-if="!requests.length" class="text-sm text-surface-400">No Data：该执行没有统一用量记录，历史图主链统计仍保留在下方。</p>
    <template v-else>
      <dl class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm tabular-nums">
        <div><dt class="text-xs text-surface-400">模型请求</dt><dd class="mt-1 font-semibold">{{ usage.modelCalls }}</dd></div>
        <div><dt class="text-xs text-surface-400">已知输入 / 输出 Token</dt><dd class="mt-1 font-semibold">{{ number(usage.inputTokens) }} / {{ number(usage.outputTokens) }}</dd></div>
        <div><dt class="text-xs text-surface-400">用量不完整的请求</dt><dd class="mt-1 font-semibold">{{ usage.incompleteRequests }}</dd></div>
        <div><dt class="text-xs text-surface-400">图生命周期</dt><dd class="mt-1 font-semibold">{{ duration(provenance.graphWallTimeMs) }}</dd></div>
      </dl>
      <p class="text-xs leading-6 text-surface-400">包含同一执行 Trace 下的 Main、规划、Worker、安全审查与压缩等已观测调用。未知用量不计作 0；缓存与推理 Token 是 Provider 子集，不再加进总量。未配置可信定价，费用未估算。</p>
      <div v-if="criticalPath" class="border-t border-surface-800 pt-3 space-y-2 text-xs" data-testid="critical-path-summary">
        <h4 class="font-semibold text-surface-200">历史因果关键路径与并行治理 (Dynamic Critical Path)</h4>
        <dl class="grid grid-cols-2 lg:grid-cols-4 gap-3 text-surface-300 tabular-nums">
          <div><dt class="text-surface-400">完整因果耗时</dt><dd class="font-medium text-surface-100">{{ duration(criticalPath.totalCausalDurationMs) }} ({{ criticalPath.completeness }})</dd></div>
          <div><dt class="text-surface-400">DAG 任务关键链</dt><dd class="font-medium text-surface-100">{{ duration(criticalPath.taskChainDurationMs) }}</dd></div>
          <div><dt class="text-surface-400">并行重叠比</dt><dd class="font-medium text-surface-100">{{ criticalPath.parallelOverlapRatio }}x</dd></div>
          <div><dt class="text-surface-400">主要耗时瓶颈</dt><dd class="font-medium text-amber-400">{{ criticalPath.bottleneckStage }}</dd></div>
        </dl>
        <p class="text-surface-400 leading-5">阶段分解：规划 {{ duration(criticalPath.planningDurationMs) }} · 重规划 {{ duration(criticalPath.replanDurationMs) }} · 汇聚等待 {{ duration(criticalPath.joinWaitDurationMs) }} · 语义复核 {{ duration(criticalPath.goalVerificationDurationMs) }}</p>
      </div>
      <div class="border-t border-surface-800 pt-3 space-y-2">
        <h4 class="text-xs font-semibold text-surface-200">最长模型请求</h4>
        <div v-for="request in slowest" :key="request.accountingId" class="flex justify-between gap-3 text-xs">
          <span class="break-all">{{ request.purpose }} · {{ request.nodeId || 'Coordinator' }} · {{ request.status }}</span><span class="tabular-nums shrink-0">{{ duration(request.durationMs) }}</span>
        </div>
      </div>
      <details class="border-t border-surface-800 pt-1">
        <summary>Agent 与 Worker 用量</summary>
        <div class="space-y-3 text-xs pb-2">
          <article v-for="group in agents" :key="group.key" class="rounded-lg border border-surface-800 p-3 space-y-2">
            <p class="font-medium break-all">{{ group.key }}</p>
            <p class="text-surface-400">{{ group.calls }} 次请求 · 输入 {{ number(group.input) }} / 输出 {{ number(group.output) }} · {{ group.unknown }} 次不完整</p>
            <p class="text-surface-400">缓存读取 {{ number(group.cache) }} · 推理 {{ number(group.reasoning) }} · 模型耗时之和 {{ duration(group.duration) }}（含并行，不等于墙钟）</p>
          </article>
        </div>
      </details>
      <details class="border-t border-surface-800 pt-1">
        <summary>上下文组成 · 本地估算</summary>
        <p class="text-xs leading-6 text-surface-400 mb-3">按消息角色和工具定义估算，包含重复发送的内容；无法从角色继续区分记忆、产物与规划内容。比例不代表 Provider 精确分词，不与账单总量强行对齐。</p>
        <div v-for="part in contextParts" :key="part.name" class="space-y-1 mb-3 text-xs">
          <div class="flex justify-between"><span>{{ contextLabels[part.name] || part.name }}</span><span class="tabular-nums">{{ number(part.tokens) }} · {{ part.percent.toFixed(1) }}%</span></div>
          <div class="h-1.5 rounded bg-surface-800"><div class="h-1.5 rounded bg-nash-500" :style="{ width: `${part.percent}%` }" /></div>
        </div>
      </details>
    </template>
    <details class="border-t border-surface-800 pt-1">
      <summary>执行时间线与父子 Span</summary>
      <p class="text-xs leading-6 text-surface-400 mb-3">各机仅比较本地单调耗时。跨机器时钟偏移与误差尚未测定，因此不伪造跨机对齐的甘特图。缺失结束记录保留 running / PARTIAL，不能视为完成。</p>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
        <label class="text-xs text-surface-400">Worker<select v-model="worker" aria-label="时间线 Worker"><option value="">全部</option><option v-for="id in workers" :key="id">{{ id }}</option></select></label>
        <label class="text-xs text-surface-400">Agent<select v-model="agent" aria-label="时间线 Agent"><option value="">全部</option><option v-for="id in agentIds" :key="id">{{ id }}</option></select></label>
        <label class="text-xs text-surface-400">阶段<select v-model="phase" aria-label="时间线阶段"><option value="">全部</option><option v-for="id in phases" :key="id">{{ id }}</option></select></label>
        <label class="flex items-center gap-2 text-xs text-surface-300 min-h-11 self-end"><input v-model="errorsOnly" type="checkbox" />仅异常</label>
      </div>
      <p v-if="!filteredSpans.length" class="text-sm text-surface-400 py-3">No Data：没有符合筛选条件的 Span。</p>
      <div v-for="span in filteredSpans.slice(0, shown)" :key="span.spanId" class="border-l-2 border-surface-700 pl-3 py-1 text-xs" :style="{ marginLeft: `${depth(span) * 8}px` }">
        <details>
          <summary class="flex-wrap justify-between gap-2"><span class="break-all">{{ span.phase || span.name }} · {{ span.outcome }}</span><span class="tabular-nums text-surface-400">{{ duration(span.durationMs) }}</span></summary>
          <dl class="grid grid-cols-1 lg:grid-cols-2 gap-2 text-surface-400 pb-3 break-all"><div>Worker {{ span.nodeId || 'Coordinator' }} · {{ span.platform }}</div><div>Task {{ span.taskId || '—' }}</div><div>Span {{ span.spanId }}</div><div>Parent {{ span.parentSpanId || 'root' }}</div><div>Revision {{ span.graphRevision ?? '—' }} · {{ span.completeness }}</div><div>错误 {{ span.error?.name || '—' }}</div></dl>
        </details>
      </div>
      <button v-if="filteredSpans.length > shown" class="min-h-11 text-xs text-nash-400" @click="shown += 40">继续显示 {{ Math.min(40, filteredSpans.length - shown) }} 条</button>
    </details>
    <details class="border-t border-surface-800 pt-1">
      <summary>22 阶段采集覆盖与请求证据</summary>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-2 text-xs text-surface-400 mb-4"><p v-for="item in trace?.phases || []" :key="item.phase">{{ item.phase }} · {{ item.coverage }} · {{ item.spans }} spans</p></div>
      <p v-if="usage?.truncated || trace?.truncated" class="text-xs text-amber-700 dark:text-amber-400">当前返回已达查询上限，数据为 PARTIAL。</p>
      <details v-for="request in requests.slice(0, requestLimit)" :key="request.accountingId" class="text-xs border-t border-surface-800">
        <summary class="break-all">{{ request.purpose }} · {{ request.model }} · {{ request.status }} · {{ duration(request.durationMs) }}</summary>
        <p class="break-all text-surface-400 leading-6">Provider Request ID：{{ request.modelRequestId || 'UNAVAILABLE' }}<br />{{ request.usageSource }} / {{ request.usageCompleteness }} · Input {{ number(request.inputTokens) }} / Output {{ number(request.outputTokens) }}<br />TTFT {{ duration(request.ttftMs) }} · Cache read {{ number(request.cacheReadTokens) }} / write {{ number(request.cacheWriteTokens) }} · Reasoning {{ number(request.reasoningTokens) }}<br />Task {{ request.taskId || '—' }} · Run {{ request.runId || '—' }} · Attempt {{ request.executionAttempt ?? '—' }}</p>
      </details>
      <button v-if="requests.length > requestLimit" class="min-h-11 text-xs text-nash-400" @click="requestLimit += 40">继续显示请求</button>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
const props = defineProps<{ provenance: any }>();
const criticalPath = computed(() => props.provenance?.criticalPath);
const usage = computed(() => props.provenance?.unifiedUsage);
const trace = computed(() => props.provenance?.runtimeTrace);
const requests = computed<any[]>(() => usage.value?.requests || []);
const spans = computed<any[]>(() => trace.value?.timeline || []);
const worker = ref(""); const agent = ref(""); const phase = ref(""); const errorsOnly = ref(false); const shown = ref(40); const requestLimit = ref(40);
const workers = computed(() => [...new Set<string>(spans.value.map(s => s.nodeId).filter(Boolean))]);
const agentIds = computed(() => [...new Set<string>(spans.value.map(s => s.agentId).filter(Boolean))]);
const phases = computed(() => [...new Set<string>(spans.value.map(s => s.phase).filter(Boolean))]);
const filteredSpans = computed(() => spans.value.filter(s => (!worker.value || s.nodeId === worker.value) && (!agent.value || s.agentId === agent.value) && (!phase.value || s.phase === phase.value) && (!errorsOnly.value || ["failed", "cancelled", "timed_out"].includes(s.outcome))));
const slowest = computed(() => [...requests.value].filter(r => typeof r.durationMs === "number").sort((a,b) => b.durationMs-a.durationMs).slice(0,3));
const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("zh-CN") : "未知";
const duration = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? `${(n/1000).toFixed(2)} s` : "未知";
const sumKnown = (rows: any[], key: string) => { const values = rows.map(r => r[key]).filter(n => typeof n === "number"); return values.length ? values.reduce((a,b) => a+b,0) : null; };
const agents = computed(() => [...new Set(requests.value.map(r => `${r.nodeId || 'Coordinator'} / ${r.agentId || 'service'}`))].map(key => { const rows = requests.value.filter(r => `${r.nodeId || 'Coordinator'} / ${r.agentId || 'service'}` === key); return { key, calls: rows.length, input: sumKnown(rows,'inputTokens'), output: sumKnown(rows,'outputTokens'), cache: sumKnown(rows,'cacheReadTokens'), reasoning: sumKnown(rows,'reasoningTokens'), duration: sumKnown(rows,'durationMs'), unknown: rows.filter(r => r.usageCompleteness !== 'COMPLETE').length }; }));
const contextLabels: Record<string,string> = { system: "System 与开发指令", user: "用户目标与任务上下文", conversation: "助手历史与工具调用参数", tool_results: "工具结果", tool_schemas: "工具定义", protocol: "协议开销" };
const contextParts = computed(() => { const sums: Record<string,number> = {}; for(const r of requests.value)for(const [name,value] of Object.entries(r.context?.estimatedTokens || {}))if(typeof value === 'number')sums[name]=(sums[name]||0)+value; const total=Object.values(sums).reduce((a,b)=>a+b,0);return Object.entries(sums).map(([name,tokens])=>({name,tokens,percent:total?tokens/total*100:0})).sort((a,b)=>b.tokens-a.tokens); });
function depth(span: any) { let level=0;const seen=new Set([span.spanId]);let parent=spans.value.find(s=>s.spanId===span.parentSpanId);while(parent&&parent.nodeId===span.nodeId&&level<5&&!seen.has(parent.spanId)){seen.add(parent.spanId);level++;parent=spans.value.find(s=>s.spanId===parent.parentSpanId);}return level; }
</script>

<style scoped>
summary { @apply cursor-pointer min-h-11 flex items-center text-surface-200 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nash-500; }
select { @apply mt-1 min-h-11 w-full rounded-lg border border-surface-700 bg-surface-950 text-surface-200 px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nash-500; }
button { @apply focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nash-500; }
</style>
