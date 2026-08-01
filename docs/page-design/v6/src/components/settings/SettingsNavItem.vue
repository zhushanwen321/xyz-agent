<script setup lang="ts">
/** SettingsNavItem：nav 行项 — Button ghost 基底。
 * active = bg-surface + accent；icon 16px + label + count（中性圆点 bg-surface neutral-dim）。*/
defineProps<{
  label: string
  icon: string
  count?: number
  active?: boolean
  disabled?: boolean
}>()
defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <button
    class="nav-item"
    :class="{ active, disabled }"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <span class="ico" v-html="icon" />
    <span class="label">{{ label }}</span>
    <span v-if="count !== undefined && count > 0" class="count">{{ count }}</span>
  </button>
</template>

<style scoped>
.nav-item {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--neutral-mid);
  font-size: var(--text-base);
  text-align: left;
  transition: all var(--duration-fast) var(--ease);
}
.nav-item:hover:not(.active):not(.disabled) {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.nav-item.active {
  background: var(--surface);
  color: var(--accent);
}
.nav-item.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ico {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.ico :deep(svg) {
  width: 16px;
  height: 16px;
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  height: 16px;
  min-width: 16px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--surface);
  color: var(--neutral-dim);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.nav-item.active .count {
  background: color-mix(in oklch, var(--accent) 18%, transparent);
  color: var(--accent);
}
</style>
