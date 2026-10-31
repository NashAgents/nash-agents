import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { layoutCategory } from "./workbench-layout";

export const useUiStore = defineStore("ui", () => {
  const windowWidth = ref(typeof window !== "undefined" ? window.innerWidth : 1280);
  const isDark = ref(false);

  // 响应式端形态判定
  const isMobile = computed(() => windowWidth.value < 768);
  const isTablet = computed(() => windowWidth.value >= 768 && windowWidth.value < 1024);
  const isDesktop = computed(() => windowWidth.value >= 1024);

  // 面板展开状态
  const leftSidebarOpen = ref(windowWidth.value >= 1024);
  const rightContextOpen = ref(windowWidth.value >= 1024);
  const mobileDrawerOpen = ref(false);
  const activeContextTab = ref<"graph" | "activity" | "artifacts" | "approvals">("graph");

  const expandedNavGroup = ref<string | null>(null);
  const navScrollTop = ref(0);
  const recentScrollTop = ref(0);
  let changingCategory = false;
  function restorePanelPreferences() {
    changingCategory = true;
    try {
      const saved = JSON.parse(localStorage.getItem(`nash_panels_${layoutCategory(windowWidth.value)}`) || "{}");
      leftSidebarOpen.value = isDesktop.value && saved.left !== false;
      rightContextOpen.value = isDesktop.value && saved.right !== false;
    } catch {
      leftSidebarOpen.value = isDesktop.value;
      rightContextOpen.value = isDesktop.value;
    } finally { changingCategory = false; }
  }
  try { expandedNavGroup.value = localStorage.getItem("nash_navigation_group"); } catch {}
  restorePanelPreferences();
  watch([leftSidebarOpen, rightContextOpen], () => {
    if (changingCategory || !isDesktop.value) return;
    try { localStorage.setItem(`nash_panels_${layoutCategory(windowWidth.value)}`, JSON.stringify({ left: leftSidebarOpen.value, right: rightContextOpen.value })); } catch {}
  }, { flush: "sync" });
  watch(expandedNavGroup, group => {
    try { group ? localStorage.setItem("nash_navigation_group", group) : localStorage.removeItem("nash_navigation_group"); } catch {}
  });
  function handleResize() {
    const previous = layoutCategory(windowWidth.value);
    windowWidth.value = window.innerWidth;
    if (previous !== layoutCategory(windowWidth.value)) restorePanelPreferences();
  }

  function toggleTheme() {
    isDark.value = !isDark.value;
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDark.value);
      document.documentElement.classList.toggle("light", !isDark.value);
    }
    localStorage.setItem("nash_theme", isDark.value ? "dark" : "light");
  }

  function initTheme() {
    const saved = localStorage.getItem("nash_theme");
    if (saved) {
      isDark.value = saved === "dark";
    } else {
      isDark.value = false;
    }
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDark.value);
      document.documentElement.classList.toggle("light", !isDark.value);
    }
  }

  return {
    expandedNavGroup, navScrollTop, recentScrollTop,
    windowWidth,
    isDark,
    isMobile,
    isTablet,
    isDesktop,
    leftSidebarOpen,
    rightContextOpen,
    mobileDrawerOpen,
    activeContextTab,
    handleResize,
    toggleTheme,
    initTheme,
  };
});
