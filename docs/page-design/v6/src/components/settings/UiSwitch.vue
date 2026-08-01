<script setup lang="ts">
/** UiSwitch：通用开关控件。
 * track h-5 w-9，checked=bg-accent，unchecked=bg-border-strong；thumb size-4，checked translate-x-[18px]。*/
defineProps<{
  checked: boolean
  disabled?: boolean
}>()
defineEmits<{ (e: 'update:checked', v: boolean): void }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    class="ui-switch"
    :class="{ on: checked, disabled }"
    :aria-checked="checked"
    :disabled="disabled"
    @click="!disabled && $emit('update:checked', !checked)"
  >
    <span class="thumb"></span>
  </button>
</template>

<style scoped>
.ui-switch {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--border-strong);
  border: 1px solid transparent;
  position: relative;
  flex-shrink: 0;
  transition: background var(--duration) var(--ease);
}
.ui-switch.on {
  background: var(--accent);
}
.ui-switch:hover:not(.disabled) {
  background: var(--neutral-faint);
}
.ui-switch.on:hover:not(.disabled) {
  background: var(--accent-hover);
}
.ui-switch.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  transition: transform var(--duration) var(--ease);
}
.ui-switch.on .thumb {
  transform: translateX(18px);
}
</style>
