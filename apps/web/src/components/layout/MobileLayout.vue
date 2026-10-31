<template>
  <div class="flex flex-col min-h-screen w-screen bg-surface-950 text-surface-100 overflow-x-hidden">
    <!-- 顶部移动端状态栏 -->
    <HeaderBar />

    <!-- 左侧可滑出抽屉 (通过 SidebarNav 实现) -->
    <SidebarNav />

    <!-- 中间主体内容区 (底部留出 BottomNav 高度 + 安全区) -->
    <main class="flex-1 flex flex-col min-w-0 pb-16 overflow-y-auto">
      <slot></slot>
    </main>

    <!-- 底部固定导航条 -->
    <BottomNav />
  </div>
</template>

<script setup lang="ts">
import HeaderBar from "./HeaderBar.vue";
import SidebarNav from "./SidebarNav.vue";
import BottomNav from "./BottomNav.vue";
</script>
