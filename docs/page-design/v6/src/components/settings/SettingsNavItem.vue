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
    <!-- §2 hover 右侧 chevron（链接提示，纯视觉） -->
    <svg class="link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  </button>
</template>

<style scoped>
.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
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
/* §2 键盘焦点态：ring-2 accent + offset；active 项同样保留 accent ring（spec CSS SSOT，anno 文字靠后） */
.nav-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.ico {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  opacity: 0.85;
  transition: opacity var(--duration-fast) var(--ease);
}
.ico :deep(svg) {
  width: 16px;
  height: 16px;
}
.nav-item:hover:not(.disabled) .ico,
.nav-item.active .ico {
  opacity: 1;
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
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
.nav-item.active .count {
  background: var(--surface);
  color: var(--neutral-dim);
}
/* hover 右侧 chevron：opacity 0 → 1（链接提示，无跳转） */
.link {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--neutral-faint);
  opacity: 0;
  transition: opacity var(--duration-fast);
}
.nav-item:hover .link {
  opacity: 1;
}
</style>
