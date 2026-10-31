<template>
  <span class="relative flex h-2 w-2">
    <span
      v-if="pulse"
      :class="[
        'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
        colorClass,
      ]"
    ></span>
    <span :class="['relative inline-flex rounded-full h-2 w-2', colorClass]"></span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

interface Props {
  status?:
    | "online"
    | "offline"
    | "running"
    | "completed"
    | "failed"
    | "waiting"
    | "warning";
  pulse?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  status: "online",
  pulse: false,
});

const colorClass = computed(() => {
  switch (props.status) {
    case "online":
    case "completed":
      return "bg-emerald-500";
    case "running":
      return "bg-purple-500";
    case "waiting":
      return "bg-amber-500";
    case "failed":
      return "bg-rose-500";
    case "warning":
      return "bg-amber-500";
    case "offline":
    default:
      return "bg-surface-500";
  }
});
</script>
