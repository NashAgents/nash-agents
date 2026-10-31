<template>
  <div class="flex h-screen w-screen overflow-hidden bg-surface-950 text-surface-100 flex-col">
    <HeaderBar />
    <div class="flex flex-1 min-h-0 overflow-hidden relative">
      <SidebarNav />
      <main class="flex-1 flex flex-col min-w-0 bg-surface-950 overflow-y-auto relative">
        <slot></slot>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import HeaderBar from "./HeaderBar.vue";
import SidebarNav from "./SidebarNav.vue";
</script>
