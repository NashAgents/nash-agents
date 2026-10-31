import { defineStore } from "pinia";
import { ref, computed } from "vue";

export const DEFAULT_SIDEBAR_WIDTH = 280;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 400;

export const DEFAULT_CONTEXT_WIDTH = 400;
export const MIN_CONTEXT_WIDTH = 300;
export const MIN_CONVERSATION_WIDTH = 500;

export const DEFAULT_SIDEBAR_NAV_RATIO = 0.5;
export const MIN_SIDEBAR_NAV_HEIGHT = 140;
export const MIN_SIDEBAR_RECENT_HEIGHT = 120;

const STORAGE_KEY = "nash_workbench_layout_v2";
export const layoutCategory = (width: number) => width < 768 ? "mobile" : width < 1024 ? "tablet" : width < 1440 ? "desktop" : "wide";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// Preferences stay intact when a temporary viewport constraint changes the rendered sizes.
export function fitWorkbench(width: number, sidebar: number, context: number, leftOpen: boolean, rightOpen: boolean) {
  const left = leftOpen ? sidebar : 64;
  const docked = rightOpen && width >= (leftOpen ? MIN_SIDEBAR_WIDTH : 64) + MIN_CONTEXT_WIDTH + MIN_CONVERSATION_WIDTH + 2;
  const right = docked ? Math.max(MIN_CONTEXT_WIDTH, Math.min(context, width - left - MIN_CONVERSATION_WIDTH - 2)) : 40;
  const fittedLeft = leftOpen ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(sidebar, width - right - MIN_CONVERSATION_WIDTH - 2)) : 64;
  return { sidebar: fittedLeft, context: right, docked };
}

export interface StoredWorkbenchLayout {
  sidebarWidth?: number;
  contextWidth?: number;
  sidebarNavRatio?: number;
  sidebarNavHeight?: number;
}

export const useWorkbenchLayoutStore = defineStore("workbenchLayout", () => {
  let category = layoutCategory(typeof window !== "undefined" ? window.innerWidth : 1280);
  // 面板尺寸状态 (px)
  const sidebarWidth = ref<number>(DEFAULT_SIDEBAR_WIDTH);
  const contextWidth = ref<number>(DEFAULT_CONTEXT_WIDTH);

  // 容器高度变化时按比例恢复；不将旧屏幕上的绝对高度直接套用。
  const sidebarNavRatio = ref<number>(DEFAULT_SIDEBAR_NAV_RATIO);
  // 当前交互的像素值仅供调用方观测，恢复统一使用比例。
  const sidebarNavHeight = ref<number | null>(null);

  // 拖拽激活状态 (用于全局光标与防止误选)
  const isDraggingSidebar = ref(false);
  const isDraggingContext = ref(false);
  const isDraggingSidebarNav = ref(false);

  const isAnyDragging = computed(
    () => isDraggingSidebar.value || isDraggingContext.value || isDraggingSidebarNav.value
  );

  // 动态计算给定视口宽度下，中间保留 500px 时各面板的最大允许宽度
  function getMaxSidebarWidth(windowWidth: number, currentContextWidth: number, rightOpen: boolean): number {
    const effectiveContextWidth = rightOpen ? currentContextWidth + 1 : 40;
    const available = windowWidth - effectiveContextWidth - MIN_CONVERSATION_WIDTH - 1;
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, available));
  }

  function getMaxContextWidth(windowWidth: number, currentSidebarWidth: number, leftOpen: boolean): number {
    const effectiveSidebarWidth = leftOpen ? currentSidebarWidth + 1 : 64;
    const available = windowWidth - effectiveSidebarWidth - MIN_CONVERSATION_WIDTH - 1;
    return Math.min(800, Math.max(MIN_CONTEXT_WIDTH, available));
  }

  function setSidebarWidth(width: number, windowWidth?: number, currentContextWidth?: number, rightOpen: boolean = true) {
    let max = MAX_SIDEBAR_WIDTH;
    if (windowWidth !== undefined && currentContextWidth !== undefined) {
      max = getMaxSidebarWidth(windowWidth, currentContextWidth, rightOpen);
    }
    if (!finite(width)) return;
    sidebarWidth.value = Math.round(Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, width)));
  }

  function setContextWidth(width: number, windowWidth?: number, currentSidebarWidth?: number, leftOpen: boolean = true) {
    let max = 800;
    if (windowWidth !== undefined && currentSidebarWidth !== undefined) {
      max = getMaxContextWidth(windowWidth, currentSidebarWidth, leftOpen);
    }
    if (!finite(width)) return;
    contextWidth.value = Math.round(Math.min(max, Math.max(MIN_CONTEXT_WIDTH, width)));
  }

  function setSidebarNavHeight(height: number, totalAvailableHeight: number) {
    if (!finite(height) || !finite(totalAvailableHeight) || totalAvailableHeight <= 0) return;
    const minH = MIN_SIDEBAR_NAV_HEIGHT;
    const maxH = Math.max(minH, totalAvailableHeight - MIN_SIDEBAR_RECENT_HEIGHT);
    const clampedHeight = Math.round(Math.min(maxH, Math.max(minH, height)));
    sidebarNavHeight.value = clampedHeight;
    sidebarNavRatio.value = Math.max(0.15, Math.min(0.85, clampedHeight / totalAvailableHeight));
  }

  function resetSidebarWidth() {
    sidebarWidth.value = DEFAULT_SIDEBAR_WIDTH;
    persistLayout();
  }

  function resetContextWidth() {
    contextWidth.value = DEFAULT_CONTEXT_WIDTH;
    persistLayout();
  }

  function resetSidebarNavRatio() {
    sidebarNavRatio.value = DEFAULT_SIDEBAR_NAV_RATIO;
    sidebarNavHeight.value = null;
    persistLayout();
  }

  function stepSidebarWidth(delta: number, windowWidth?: number, currentContextWidth?: number, rightOpen: boolean = true) {
    setSidebarWidth(sidebarWidth.value + delta, windowWidth, currentContextWidth, rightOpen);
    persistLayout();
  }

  function stepContextWidth(delta: number, windowWidth?: number, currentSidebarWidth?: number, leftOpen: boolean = true) {
    setContextWidth(contextWidth.value + delta, windowWidth, currentSidebarWidth, leftOpen);
    persistLayout();
  }

  function stepSidebarNavHeight(delta: number, totalHeight: number) {
    const current = Math.min(Math.max(140, totalHeight - 120), Math.max(140, totalHeight * sidebarNavRatio.value));
    setSidebarNavHeight(current + delta, totalHeight);
    persistLayout();
  }

  // 持久化到 localStorage
  function persistLayout() {
    if (typeof localStorage === "undefined") return;
    try {
      const data: StoredWorkbenchLayout = {
        sidebarWidth: sidebarWidth.value,
        contextWidth: contextWidth.value,
        sidebarNavRatio: sidebarNavRatio.value,
        sidebarNavHeight: sidebarNavHeight.value ?? undefined,
      };
      let profiles: Record<string, StoredWorkbenchLayout> = {};
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        if (saved && typeof saved === "object" && !Array.isArray(saved)) profiles = saved;
      } catch { /* A valid interaction repairs malformed preferences. */ }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...profiles, [category]: data }));
    } catch {
      // 忽略存储异常
    }
  }

  // 恢复持久化布局并结合当前屏幕安全 Clamp
  function restoreLayout(windowWidth: number = typeof window !== "undefined" ? window.innerWidth : 1280) {
    if (typeof localStorage === "undefined") return;
    category = layoutCategory(windowWidth);
    sidebarWidth.value = DEFAULT_SIDEBAR_WIDTH;
    contextWidth.value = DEFAULT_CONTEXT_WIDTH;
    sidebarNavRatio.value = DEFAULT_SIDEBAR_NAV_RATIO;
    sidebarNavHeight.value = null;
    try {
      const profiles = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const legacy = localStorage.getItem("nash_workbench_layout_v1");
      const parsed = profiles?.[category] ?? (legacy ? JSON.parse(legacy) : {});
      if (finite(parsed?.sidebarWidth)) setSidebarWidth(parsed.sidebarWidth);
      if (finite(parsed?.contextWidth)) setContextWidth(parsed.contextWidth);
      if (finite(parsed?.sidebarNavRatio)) sidebarNavRatio.value = Math.min(0.85, Math.max(0.15, parsed.sidebarNavRatio));
    } catch {
      // 忽略解析错误
    }
  }

  return {
    sidebarWidth,
    contextWidth,
    sidebarNavRatio,
    sidebarNavHeight,
    isDraggingSidebar,
    isDraggingContext,
    isDraggingSidebarNav,
    isAnyDragging,
    getMaxSidebarWidth,
    getMaxContextWidth,
    setSidebarWidth,
    setContextWidth,
    setSidebarNavHeight,
    resetSidebarWidth,
    resetContextWidth,
    resetSidebarNavRatio,
    stepSidebarWidth,
    stepContextWidth,
    stepSidebarNavHeight,
    persistLayout,
    restoreLayout,
  };
});
