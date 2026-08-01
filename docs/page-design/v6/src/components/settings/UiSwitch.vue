<script setup lang="ts">
/** UiSwitch：通用开关控件。
 * track h-5 w-9，checked=bg-accent，unchecked=bg-border-strong；thumb size-4，checked translate-x-[18px]。*/
withDefaults(
  defineProps<{
    checked: boolean
    disabled?: boolean
    ariaLabel?: string
  }>(),
  { disabled: false, ariaLabel: '' },
)
defineEmits<{ (e: 'update:checked', v: boolean): void }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    class="ui-switch"
    :class="{ on: checked, disabled }"
    :aria-checked="checked"
    :aria-label="ariaLabel"
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
/* spec §6.4 精确复刻：无 hover 变色（unchecked/checked 均不响应 hover） */
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
  /* ON 态 knob 用 accent-fg：亮 accent（太极灰）下自动转深色 knob，保持可见 */
  background: var(--accent-fg);
}
.ui-switch:focus-visible {
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
</style>
