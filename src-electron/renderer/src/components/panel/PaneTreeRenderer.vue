<template>
  <!-- Pane leaf node -->
  <div
    v-if="node.type === 'pane'"
    :class="['flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden border-t-2', node.id === focusedPaneId ? 'border-t-accent' : 'border-t-border']"
    @mousedown="paneStore.navigateToPane(node.id)"
  >
    <PaneSessionView
      v-if="node.sessionId"
      :pane-id="node.id"
      :session-id="node.sessionId"
    />
    <EmptyPane
      v-else
      :pane-id="node.id"
    />
  </div>

  <!-- Split node -->
  <div
    v-else
    ref="splitContainerRef"
    :class="['flex flex-1 min-w-0 min-h-0 overflow-hidden', node.direction === 'horizontal' ? 'flex-row' : 'flex-col']"
  >
    <div
      class="flex min-w-0 min-h-0"
      :style="firstChildStyle"
    >
      <PaneTreeRenderer
        :node="node.children[0]"
        :focused-pane-id="focusedPaneId"
      />
    </div>
    <SplitDivider
      :direction="node.direction"
      @resize="handleResize"
    />
    <div
      class="flex min-w-0 min-h-0"
      :style="secondChildStyle"
    >
      <PaneTreeRenderer
        :node="node.children[1]"
        :focused-pane-id="focusedPaneId"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { PaneTree } from '@xyz-agent/shared'
import { usePaneStore } from '../../stores/pane'
import PaneSessionView from './PaneSessionView.vue'
import EmptyPane from './EmptyPane.vue'
import SplitDivider from './SplitDivider.vue'

const PERCENT_SCALE = 100

const props = withDefaults(
  defineProps<{
    node: PaneTree
    focusedPaneId: string
  }>(),
  {}
)

const paneStore = usePaneStore()
const splitContainerRef = ref<HTMLElement | null>(null)

// Flex-basis styles for split children based on ratio
const firstChildStyle = computed(() => {
  if (props.node.type !== 'split') return {}
  const basis = `${(props.node.ratio * PERCENT_SCALE).toFixed(1)}%`
  return { flexBasis: basis }
})

const secondChildStyle = computed(() => {
  if (props.node.type !== 'split') return {}
  const basis = `${((1 - props.node.ratio) * PERCENT_SCALE).toFixed(1)}%`
  return { flexBasis: basis }
})

// Convert resize delta from SplitDivider to a new ratio
function handleResize(delta: number) {
  const container = splitContainerRef.value
  const node = props.node
  if (!container || node.type !== 'split') return

  const size =
    node.direction === 'horizontal'
      ? container.offsetWidth
      : container.offsetHeight
  if (size <= 0) return

  const newRatio = node.ratio + delta / size
  paneStore.updateRatio(node.id, newRatio)
}
</script>

