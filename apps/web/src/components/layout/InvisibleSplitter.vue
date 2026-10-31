<template>
  <div ref="splitterRef" role="separator" :tabindex="disabled ? -1 : 0"
    :aria-orientation="direction" :aria-valuenow="Math.round(currentValue)" :aria-valuemin="Math.round(minValue)"
    :aria-valuemax="Math.round(maxValue)" :aria-label="label" :aria-disabled="disabled"
    :aria-valuetext="`${Math.round(currentValue)} 像素`"
    :title="`${label} · 方向键调整，Shift 加速，双击或 Enter 恢复`"
    class="invisible-splitter" :class="[direction, { dragging: isDragging, disabled }]"
    @pointerdown="handlePointerDown" @pointermove="handlePointerMove" @pointerup="finishDrag"
    @pointercancel="finishDrag" @lostpointercapture="finishDrag" @dblclick="reset" @keydown="handleKeyDown">
    <span class="splitter-hitbox" /><span class="splitter-grip" aria-hidden="true" />
  </div>
  <Teleport to="body"><div v-if="isDragging" class="splitter-shield" :style="{ cursor: direction === 'vertical' ? 'col-resize' : 'row-resize' }" /></Teleport>
</template>

<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
const props = withDefaults(defineProps<{
  direction?: "vertical" | "horizontal"; currentValue?: number; minValue?: number; maxValue?: number;
  label?: string; disabled?: boolean; reverse?: boolean;
}>(), { direction: "vertical", currentValue: 0, minValue: 0, maxValue: 1000, label: "调整面板大小", disabled: false, reverse: false });
const emit = defineEmits<{
  (e: "drag-start", event: PointerEvent): void;
  (e: "drag-move", delta: { dx: number; dy: number; clientX: number; clientY: number }): void;
  (e: "drag-end"): void; (e: "reset"): void; (e: "step", delta: number): void;
}>();
const splitterRef = ref<HTMLDivElement | null>(null);
const isDragging = ref(false);
let startX = 0, startY = 0, emittedX = 0, emittedY = 0;
let activePointerId: number | null = null;
let previousCursor = "", previousSelect = "";
function handlePointerDown(e: PointerEvent) {
  if (props.disabled || e.button !== 0 || activePointerId !== null || !e.isPrimary) return;
  e.preventDefault();
  splitterRef.value?.focus({ preventScroll: true });
  activePointerId = e.pointerId;
  startX = e.clientX; startY = e.clientY; emittedX = 0; emittedY = 0;
  isDragging.value = true;
  previousCursor = document.body.style.cursor; previousSelect = document.body.style.userSelect;
  document.body.style.cursor = props.direction === "vertical" ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";
  try { splitterRef.value?.setPointerCapture(e.pointerId); } catch { /* Window listeners cover unsupported capture. */ }
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", finishDrag);
  window.addEventListener("pointercancel", finishDrag);
  window.addEventListener("blur", finishDrag);
  document.addEventListener("visibilitychange", onVisibilityChange);
  emit("drag-start", e);
}
function handlePointerMove(e: PointerEvent) {
  if (e.pointerId !== activePointerId) return;
  const totalX = Math.round(e.clientX - startX), totalY = Math.round(e.clientY - startY);
  const dx = totalX - emittedX, dy = totalY - emittedY;
  emittedX = totalX; emittedY = totalY;
  if (dx || dy) emit("drag-move", { dx, dy, clientX: e.clientX, clientY: e.clientY });
}
function finishDrag(e?: Event) {
  if (activePointerId === null || (e instanceof PointerEvent && e.pointerId !== activePointerId)) return;
  const pointerId = activePointerId;
  activePointerId = null; isDragging.value = false;
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", finishDrag);
  window.removeEventListener("pointercancel", finishDrag);
  window.removeEventListener("blur", finishDrag);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (splitterRef.value?.hasPointerCapture(pointerId)) splitterRef.value.releasePointerCapture(pointerId);
  document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelect;
  emit("drag-end");
}
function onVisibilityChange() { if (document.hidden) finishDrag(); }
function reset() { if (!props.disabled) emit("reset"); }
function handleKeyDown(e: KeyboardEvent) {
  if (props.disabled) return;
  const keys = props.direction === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  let delta: number | undefined;
  if (keys.includes(e.key)) delta = (e.key === keys[0] ? -1 : 1) * (e.shiftKey ? 32 : 8);
  if (e.key === "Home" || e.key === "End") delta = ((e.key === "Home" ? props.minValue : props.maxValue) - props.currentValue) * (props.reverse ? -1 : 1);
  if (["Enter", " "].includes(e.key)) { e.preventDefault(); reset(); }
  if (delta !== undefined) { e.preventDefault(); emit("step", delta); }
}
onBeforeUnmount(() => finishDrag());
</script>

<style scoped>
.invisible-splitter { position: relative; flex: none; z-index: 70; outline: none; touch-action: none; background: var(--border-subtle); transition: background-color 150ms; }
.vertical { width: 1px; align-self: stretch; cursor: col-resize; }
.horizontal { height: 1px; width: 100%; cursor: row-resize; }
.splitter-hitbox { position: absolute; inset: 0; }
.vertical .splitter-hitbox { left: -6px; right: -6px; }
.horizontal .splitter-hitbox { top: -6px; bottom: -6px; }
.splitter-grip { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); opacity: 0; pointer-events: none; border: 1px solid rgb(var(--surface-600)); border-radius: 5px; background: rgb(var(--surface-950)); transition: opacity 150ms, border-color 150ms; }
.vertical .splitter-grip { width: 7px; height: 28px; }
.horizontal .splitter-grip { width: 28px; height: 7px; }
.splitter-grip::after { content: ''; position: absolute; inset: 5px 2px; background: rgb(var(--surface-500)); border-radius: 1px; }
.horizontal .splitter-grip::after { inset: 2px 5px; }
.invisible-splitter:hover { background: rgb(var(--surface-500)); }
.invisible-splitter:hover .splitter-grip, .invisible-splitter:focus-visible .splitter-grip, .dragging .splitter-grip { opacity: 1; }
.invisible-splitter:focus-visible, .invisible-splitter.dragging { background: var(--brand-accent); }
.invisible-splitter:focus-visible .splitter-grip, .dragging .splitter-grip { border-color: var(--brand-accent); }
.invisible-splitter:focus-visible .splitter-grip { outline: 2px solid var(--brand-accent); outline-offset: 3px; }
.disabled { pointer-events: none; cursor: default; }
.splitter-shield { position: fixed; inset: 0; z-index: 9999; user-select: none; touch-action: none; }
@media (pointer: coarse) { .vertical .splitter-hitbox { left: -11px; right: -11px; } .horizontal .splitter-hitbox { top: -11px; bottom: -11px; } }
@media (prefers-reduced-motion: reduce) { .invisible-splitter, .splitter-grip { transition: none; } }
</style>
