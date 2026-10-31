<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="modelValue"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
        @click.self="close"
      >
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="opacity-0 scale-95"
          enter-to-class="opacity-100 scale-100"
          leave-active-class="transition duration-150 ease-in"
          leave-from-class="opacity-100 scale-100"
          leave-to-class="opacity-0 scale-95"
        >
          <div
            class="w-full max-w-2xl bg-surface-900 border border-surface-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            ref="dialogRef"
            tabindex="-1"
            :aria-label="title || '详细信息'"
            role="dialog"
            aria-modal="true"
          >
            <!-- 弹窗标题 -->
            <div class="flex items-center justify-between px-6 py-4 border-b border-surface-800">
              <h3 class="text-base font-semibold text-surface-100">
                <slot name="title">{{ title }}</slot>
              </h3>
              <button
                @click="close"
                class="text-surface-400 hover:text-surface-200 p-1 rounded-lg hover:bg-surface-800 transition-colors"
                aria-label="关闭"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- 弹窗内容 -->
            <div class="px-6 py-4 overflow-y-auto flex-1">
              <slot></slot>
            </div>

            <!-- 弹窗底部操作 -->
            <div v-if="$slots.footer" class="flex items-center justify-end gap-3 px-6 py-4 border-t border-surface-800 bg-surface-900/50">
              <slot name="footer"></slot>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, nextTick } from "vue";

interface Props {
  modelValue: boolean;
  title?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "close"): void;
}>();

const dialogRef = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
watch(() => props.modelValue, async (open) => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    dialogRef.value?.focus();
  } else previousFocus?.focus();
}, { immediate: true });

function close() {
  emit("update:modelValue", false);
  emit("close");
}

function handleKeyDown(e: KeyboardEvent) {
  if (!props.modelValue) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  if (e.key === "Tab") {
    const focusable = Array.from(dialogRef.value?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? []);
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (!first) { e.preventDefault(); dialogRef.value?.focus(); }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.value)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.value)) { e.preventDefault(); first.focus(); }
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
});
</script>
