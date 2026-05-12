<template>
  <div
    v-if="node.type === 'pane'"
    class="flex items-center justify-center h-full text-[11px] text-muted py-1 px-[6px] text-center overflow-hidden whitespace-nowrap text-ellipsis"
  >
    {{ node.sessionId || '空面板' }}
  </div>
  <div
    v-else
    class="flex h-full overflow-hidden"
    :class="node.direction === 'vertical' ? 'flex-col' : 'flex-row'"
  >
    <div
      class="min-w-0 min-h-0 overflow-hidden"
      :style="{ flex: ratioToFlex(node.ratio, 0) }"
    >
      <PaneTreeMini :node="node.children[0]" />
    </div>
    <div
      class="shrink-0 bg-border opacity-50"
      :class="node.direction === 'vertical' ? 'h-px' : 'w-px'"
    />
    <div
      class="min-w-0 min-h-0 overflow-hidden"
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

