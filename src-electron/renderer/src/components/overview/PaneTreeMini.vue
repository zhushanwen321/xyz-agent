<template>
  <div
    v-if="node.type === 'pane'"
    class="minipane"
  >
    {{ node.sessionId || '空面板' }}
  </div>
  <div
    v-else
    class="minisplit"
    :class="node.direction === 'vertical' ? 'minisplit--col' : 'minisplit--row'"
  >
    <div
      class="minisplit__child"
      :style="{ flex: ratioToFlex(node.ratio, 0) }"
    >
      <PaneTreeMini :node="node.children[0]" />
    </div>
    <div class="minisplit__divider" />
    <div
      class="minisplit__child"
      :style="{ flex: ratioToFlex(node.ratio, 1) }"
    >
      <PaneTreeMini :node="node.children[1]" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PaneTree } from '@xyz-agent/shared'

defineProps<{
  node: PaneTree
}>()

function ratioToFlex(ratio: number, index: 0 | 1): string {
  if (index === 0) return String(ratio)
  return String(1 - ratio)
}
</script>

<style scoped>
.minipane {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 11px;
  color: var(--muted);
  padding: 4px 6px;
  text-align: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.minisplit {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.minisplit--row {
  flex-direction: row;
}

.minisplit--col {
  flex-direction: column;
}

.minisplit__child {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.minisplit__divider {
  flex-shrink: 0;
  background: var(--border);
  opacity: 0.5;
}

.minisplit--row .minisplit__divider {
  width: 1px;
}

.minisplit--col .minisplit__divider {
  height: 1px;
}
</style>
