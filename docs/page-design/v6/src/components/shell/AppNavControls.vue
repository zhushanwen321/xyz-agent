<script setup lang="ts">
import { sidebarCollapsed } from '@/composables/useStore'

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}
</script>

<template>
  <div class="app-nav-controls" v-show="!sidebarCollapsed">
    <button class="nav-btn" title="收起/展开侧栏" @click="toggleSidebar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
    </button>
    <button class="nav-btn" title="后退">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
    </button>
    <button class="nav-btn" title="前进">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
    </button>
  </div>
</template>

<style scoped>
.app-nav-controls {
  position: absolute;
  left: 100px;
  top: 21px;
  display: flex;
  gap: 2px;
  z-index: var(--z-popover);
}
.nav-btn {
  width: 26px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--neutral-dim);
  transition: background var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.nav-btn svg { width: 14px; height: 14px; }
.nav-btn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.nav-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
</style>
