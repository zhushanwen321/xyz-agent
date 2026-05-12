<template>
  <div
    class="bg-surface border-2 border-border rounded overflow-hidden cursor-pointer transition-all duration-200 ease-ease flex flex-col hover:border-accent hover:-translate-y-[2px] hover:scale-[1.02] hover:shadow-lg"
    :class="{ 'border-accent ring-3 ring-[oklch(64%_0.13_28_/_0.4)]': highlighted }"
    @click="$emit('select')"
  >
    <div class="flex items-center gap-[6px] py-2 px-3 text-xs font-semibold text-fg border-b border-border bg-bg">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted shrink-0">
        <rect x="2" y="3" width="20" height="18" rx="2" ry="2" />
        <line x1="2" y1="9" x2="22" y2="9" />
      </svg>
      {{ windowLabel }}
    </div>
    <div class="flex-1 h-[100px] overflow-hidden p-1">
      <PaneTreeMini :node="windowState.paneTree" />
    </div>
    <div class="py-[6px] px-3 text-[11px] text-muted border-t border-border">
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

