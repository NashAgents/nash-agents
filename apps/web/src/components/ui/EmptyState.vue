<template>
  <div class="flex flex-col items-center justify-center p-8 text-center my-auto">
    <div class="w-12 h-12 rounded-xl bg-surface-800/80 border border-surface-700/60 flex items-center justify-center text-surface-400 mb-3 shadow-inner">
      <slot name="icon">
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
        </svg>
      </slot>
    </div>
    <h4 class="text-sm font-semibold text-surface-200 mb-1">
      <slot name="title">{{ title }}</slot>
    </h4>
    <p class="text-xs text-surface-400 max-w-sm mb-4">
      <slot name="description">{{ description }}</slot>
    </p>
    <div v-if="$slots.action">
      <slot name="action"></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  title?: string;
  description?: string;
}

defineProps<Props>();
</script>
