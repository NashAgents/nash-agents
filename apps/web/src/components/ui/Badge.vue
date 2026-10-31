<template>
  <span
    :class="[
      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors',
      variantClasses[variant] || variantClasses.default,
      sizeClasses[size] || sizeClasses.sm,
    ]"
  >
    <slot name="icon"></slot>
    <slot></slot>
  </span>
</template>

<script setup lang="ts">
interface Props {
  variant?:
    | "default"
    | "primary"
    | "success"
    | "warning"
    | "danger"
    | "info"
    | "purple"
    | "outline";
  size?: "sm" | "md";
}

const props = withDefaults(defineProps<Props>(), {
  variant: "default",
  size: "sm",
});

const variantClasses = {
  default: "bg-surface-800 text-surface-300 border-surface-700",
  primary: "bg-nash-500/10 text-nash-400 border-nash-500/30",
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  danger: "bg-rose-500/10 text-rose-400 border-rose-500/30",
  info: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  purple: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  outline: "bg-transparent text-surface-400 border-surface-700",
};

const sizeClasses = {
  sm: "text-xs px-2 py-0.5",
  md: "text-sm px-3 py-1",
};
</script>
