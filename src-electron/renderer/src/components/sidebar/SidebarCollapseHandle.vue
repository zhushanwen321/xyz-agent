<script setup lang="ts">
import { computed } from 'vue'
import { useSidebarStore } from '../../stores/sidebar'

const sidebar = useSidebarStore()

const isCollapsed = computed(() => sidebar.collapsed)

function handleToggle() {
  sidebar.toggle()
}
</script>

<template>
  <!-- Collapsed state: floating pill expand button at left edge center -->
  <!-- eslint-disable-next-line taste/no-native-html-elements -- custom floating pill design, xyz-ui Button doesn't match this shape -->
  <button
    v-if="isCollapsed"
    class="expand-pill"
    title="Expand sidebar"
    @click="handleToggle"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
  </button>
</template>

<style scoped>
.expand-pill {
  position: fixed;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  width: 24px;
  height: 48px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: none;
  border-radius: 0 1px 1px 0;
  cursor: pointer;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  color: var(--muted);
  box-shadow: 1px 0 4px rgba(0, 0, 0, 0.04);
}

.expand-pill:hover {
  background: var(--hover-bg);
  border-color: var(--muted);
  color: var(--fg);
  width: 28px;
  box-shadow: 2px 0 6px rgba(0, 0, 0, 0.06);
}
</style>
