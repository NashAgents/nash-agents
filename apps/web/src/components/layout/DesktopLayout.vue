<template>
  <div class="workbench flex h-dvh w-full overflow-hidden bg-surface-950 text-surface-100 flex-col">
    <HeaderBar :inert="overlayOpen || undefined">
      <template #actions>
        <button v-if="showContextPanel && !uiStore.isDesktop" class="context-launcher p-2 text-surface-400 hover:text-surface-200 hover:bg-surface-800 rounded-lg transition-colors"
          aria-label="展开上下文面板" title="上下文检查器" @click="uiStore.rightContextOpen = true">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" stroke-width="1.5" /><path d="M15 4v16" stroke-width="1.5" /></svg>
        </button>
      </template>
    </HeaderBar>
    <div ref="workbenchRef" class="flex flex-1 min-h-0 overflow-hidden relative">
      <div :class="uiStore.isDesktop ? 'shrink-0 h-full min-w-0' : 'contents'"
        :style="uiStore.isDesktop ? { width: `${sizes.sidebar}px` } : undefined" :inert="overlayOpen || undefined" data-panel="sidebar">
        <SidebarNav />
      </div>
      <InvisibleSplitter v-if="uiStore.isDesktop && uiStore.leftSidebarOpen" direction="vertical" label="调整左侧导航栏宽度" :disabled="overlayOpen"
        :current-value="sizes.sidebar" :min-value="220" :max-value="maxSidebarWidth"
        @drag-start="layoutStore.isDraggingSidebar = true" @drag-move="handleSidebarDragMove"
        @drag-end="finishSidebar" @reset="resetSidebar" @step="handleSidebarStep" />
      <main class="flex-1 flex flex-col min-w-0 min-h-0 bg-surface-950 overflow-y-auto relative"
        :class="{ 'pb-16': uiStore.isMobile }" data-panel="conversation" :inert="overlayOpen || undefined"><slot /></main>
      <InvisibleSplitter v-if="showContextPanel && sizes.docked" direction="vertical" label="调整右侧检查器面板宽度" reverse
        :current-value="sizes.context" :min-value="300" :max-value="maxContextWidth"
        @drag-start="layoutStore.isDraggingContext = true" @drag-move="handleContextDragMove"
        @drag-end="finishContext" @reset="resetContext" @step="handleContextStep" />
      <div v-if="overlayOpen" class="absolute inset-0 bg-black/40 z-[80]" @click="uiStore.rightContextOpen = false" />
      <aside v-if="showContextPanel && (uiStore.isDesktop || uiStore.rightContextOpen)" data-panel="inspector"
        class="context-inspector bg-surface-900/60 flex flex-col shrink-0 min-w-0 overflow-hidden"
        :class="{ 'context-overlay': overlayOpen, 'border-l border-surface-800': !sizes.docked, 'items-center': !uiStore.rightContextOpen }"
        :style="{ width: `${inspectorWidth}px` }" :role="overlayOpen ? 'dialog' : undefined"
        :aria-modal="overlayOpen ? true : undefined" aria-label="上下文检查器" @keydown.esc="uiStore.rightContextOpen = false" @keydown.tab="trapContextFocus">
        <div class="flex items-center justify-between p-2 shrink-0 gap-2">
          <button ref="contextToggle" @click="uiStore.rightContextOpen = !uiStore.rightContextOpen"
            class="p-1.5 text-surface-400 hover:text-surface-200 hover:bg-surface-800 rounded-lg transition-colors"
            :title="uiStore.rightContextOpen ? '收起上下文面板' : '展开上下文面板'"
            :aria-label="uiStore.rightContextOpen ? '收起上下文面板' : '展开上下文面板'" :aria-expanded="uiStore.rightContextOpen">
            <svg class="w-4 h-4" :class="{ 'rotate-180': !uiStore.rightContextOpen }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <template v-if="uiStore.rightContextOpen">
            <span class="text-[11px] font-medium text-surface-400 flex-1">上下文</span>
            <button class="text-[10px] text-surface-400 hover:text-surface-200 px-2 py-1 rounded focus-visible:outline"
              aria-label="恢复检查器默认宽度" @click="resetContext">重置</button>
          </template>
        </div>
        <div v-if="uiStore.rightContextOpen" class="flex-1 flex flex-col min-h-0 min-w-0 px-3 pb-3">
          <div role="tablist" aria-label="上下文内容" class="context-tabs flex items-center gap-1 border-b border-surface-800 pb-2 mb-3 shrink-0 overflow-x-auto">
            <button v-for="(tab, index) in contextTabs" :key="tab.key" role="tab" :id="`context-tab-${tab.key}`" aria-controls="context-content"
              :aria-selected="uiStore.activeContextTab === tab.key" :tabindex="uiStore.activeContextTab === tab.key ? 0 : -1"
              @click="uiStore.activeContextTab = tab.key" @keydown="handleTabKey($event, index)"
              :class="['px-2.5 py-1.5 rounded-md transition-colors font-medium text-xs whitespace-nowrap', uiStore.activeContextTab === tab.key ? 'bg-surface-800 text-nash-400' : 'text-surface-400 hover:text-surface-200']">{{ tab.label }}</button>
          </div>
          <div id="context-content" role="tabpanel" :aria-labelledby="`context-tab-${uiStore.activeContextTab}`"
            class="context-content flex-1 min-h-0 min-w-0 overflow-y-auto"><slot name="context" /></div>
        </div>
      </aside>
    </div>
    <BottomNav v-if="uiStore.isMobile" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { useRoute } from "vue-router";
import { useUiStore } from "../../stores/ui";
import { useWorkbenchLayoutStore, fitWorkbench } from "../../stores/workbench-layout";
import { useI18n } from "../../i18n";
import HeaderBar from "./HeaderBar.vue";
import SidebarNav from "./SidebarNav.vue";
import InvisibleSplitter from "./InvisibleSplitter.vue";
import BottomNav from "./BottomNav.vue";
const uiStore = useUiStore(), layoutStore = useWorkbenchLayoutStore();
const { t } = useI18n();
const route = useRoute();
const workbenchRef = ref<HTMLElement | null>(null), contextToggle = ref<HTMLButtonElement | null>(null);
const availableWidth = ref(uiStore.windowWidth);
const showContextPanel = computed(() => route.path === "/");
const sizes = computed(() => {
  if (!uiStore.isDesktop) {
    const docked = !uiStore.isMobile && uiStore.rightContextOpen && availableWidth.value >= 842;
    return { sidebar: 0, context: Math.min(layoutStore.contextWidth, Math.max(300, availableWidth.value - 501)), docked };
  }
  if (!showContextPanel.value) return { sidebar: uiStore.leftSidebarOpen ? Math.min(layoutStore.sidebarWidth, availableWidth.value - 501) : 64, context: 0, docked: false };
  return fitWorkbench(availableWidth.value, layoutStore.sidebarWidth, layoutStore.contextWidth, uiStore.leftSidebarOpen, uiStore.rightContextOpen);
});
const overlayOpen = computed(() => showContextPanel.value && uiStore.rightContextOpen && !sizes.value.docked);
const inspectorWidth = computed(() => !uiStore.rightContextOpen ? 40 : sizes.value.docked ? sizes.value.context : Math.min(layoutStore.contextWidth, availableWidth.value - 24));
const maxSidebarWidth = computed(() => layoutStore.getMaxSidebarWidth(availableWidth.value, sizes.value.context, showContextPanel.value && sizes.value.docked));
const maxContextWidth = computed(() => layoutStore.getMaxContextWidth(availableWidth.value, sizes.value.sidebar, uiStore.isDesktop && uiStore.leftSidebarOpen));
const contextTabs = computed(() => [
  { key: "graph" as const, label: t.value.nav.graphs }, { key: "artifacts" as const, label: t.value.nav.artifacts }, { key: "approvals" as const, label: t.value.nav.approvals },
]);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (workbenchRef.value) {
    availableWidth.value = workbenchRef.value.clientWidth;
    observer = new ResizeObserver(([entry]) => { if (entry) availableWidth.value = entry.contentRect.width; });
    observer.observe(workbenchRef.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());
let previousFocus: HTMLElement | null = null;
watch(overlayOpen, async open => {
  if (open) {
    previousFocus = document.activeElement as HTMLElement | null;
    if (!uiStore.isDesktop) uiStore.leftSidebarOpen = false;
    await nextTick(); contextToggle.value?.focus({ preventScroll: true });
  } else if (!uiStore.rightContextOpen) {
    await nextTick();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    else workbenchRef.value?.querySelector<HTMLButtonElement>(".context-launcher")?.focus();
  }
});
function trapContextFocus(event: KeyboardEvent) {
  if (!overlayOpen.value) return;
  const nodes = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]')).filter(node => node.tabIndex >= 0 && node.getClientRects().length);
  const next = nodes.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1);
  if (next < 0 || next >= nodes.length) { event.preventDefault(); nodes[next < 0 ? nodes.length - 1 : 0]?.focus(); }
}
function handleSidebarDragMove(delta: { dx: number }) { layoutStore.setSidebarWidth(sizes.value.sidebar + delta.dx, availableWidth.value, sizes.value.context, showContextPanel.value && sizes.value.docked); }
function handleContextDragMove(delta: { dx: number }) { layoutStore.setContextWidth(sizes.value.context - delta.dx, availableWidth.value, sizes.value.sidebar, uiStore.isDesktop && uiStore.leftSidebarOpen); }
function finishSidebar() { layoutStore.isDraggingSidebar = false; layoutStore.persistLayout(); }
function finishContext() { layoutStore.isDraggingContext = false; layoutStore.persistLayout(); }
function handleSidebarStep(delta: number) { handleSidebarDragMove({ dx: delta }); layoutStore.persistLayout(); }
function handleContextStep(delta: number) { handleContextDragMove({ dx: delta }); layoutStore.persistLayout(); }
function resetSidebar() { layoutStore.resetSidebarWidth(); }
function resetContext() { layoutStore.resetContextWidth(); }
function handleTabKey(event: KeyboardEvent, index: number) {
  const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
  if (next < 0) return;
  event.preventDefault(); uiStore.activeContextTab = contextTabs.value[next]!.key;
  (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
}
</script>

<style scoped>
.context-inspector { container-type: inline-size; container-name: inspector; }
.context-overlay { position: absolute; top: 0; bottom: 0; right: 0; z-index: 90; background: rgb(var(--surface-950)); box-shadow: -12px 0 40px #0002; }

.context-content { overflow-wrap: anywhere; }
.context-content :deep(.min-w-0) { min-width: 0; }
@container inspector (max-width: 359px) {
  .context-tabs { gap: 0; }
  .context-tabs button { flex: 1; padding-inline: 6px; }
  .context-content :deep(.inspector-secondary) { display: none; }
  .context-content :deep(.inspector-summary) { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .context-content :deep(.inspector-graph-canvas) { display: none; }
  .context-content :deep(.inspector-graph-summary) { display: flex; }
  .context-content :deep(.inspector-task-grid) { display: flex; flex-direction: column; }
}
@container inspector (min-width: 500px) {
  .context-content :deep(.inspector-task-grid) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
}
@container inspector (max-width: 499px) { .context-content :deep(.vue-flow__minimap) { display: none; } }
</style>
