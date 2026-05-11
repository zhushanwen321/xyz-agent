<template>
  <div
    class="window-card"
    :class="['overview__card', { highlighted }]"
    @click="$emit('select')"
  >
    <div class="window-card__header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="18" rx="2" ry="2" />
        <line x1="2" y1="9" x2="22" y2="9" />
      </svg>
      {{ windowLabel }}
    </div>
    <div class="window-card__preview">
      <PaneTreeMini :node="windowState.paneTree" />
    </div>
    <div class="window-card__footer">
      {{ paneCount }} 面板
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { WindowState, PaneTree } from '@xyz-agent/shared'
import PaneTreeMini from './PaneTreeMini.vue'

const props = defineProps<{
  windowState: WindowState
  highlighted: boolean
}>()

defineEmits<{
  select: []
}>()

function countPanes(node: PaneTree): number {
  if (node.type === 'pane') return 1
  return countPanes(node.children[0]) + countPanes(node.children[1])
}

const paneCount = computed(() => countPanes(props.windowState.paneTree))

const windowLabel = computed(() => {
  const id = props.windowState.windowId
  // Extract number from win-N pattern or use ID directly
  const match = id.match(/win-(\d+)/)
  if (match) return `窗口 ${match[1]}`
  return `窗口 ${id}`
})
</script>

<style scoped>
.window-card {
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s var(--ease);
  display: flex;
  flex-direction: column;
}

.window-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
}

.window-card.highlighted {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px oklch(64% 0.13 28 / 0.4);
}

.window-card__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.window-card__header svg {
  color: var(--muted);
  flex-shrink: 0;
}

.window-card__preview {
  flex: 1;
  height: 100px;
  overflow: hidden;
  padding: 4px;
}

.window-card__footer {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--muted);
  border-top: 1px solid var(--border);
}
</style>
