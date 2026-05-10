<template>
  <!-- Pane leaf node -->
  <div
    v-if="node.type === 'pane'"
    class="ptr-pane"
    :class="{ 'ptr-pane--focused': node.id === focusedPaneId }"
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
    class="ptr-split"
    :class="`ptr-split--${node.direction}`"
  >
    <div
      class="ptr-split__child"
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
      class="ptr-split__child"
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
  const basis = `${(props.node.ratio * 100).toFixed(1)}%`
  return { flexBasis: basis }
})

const secondChildStyle = computed(() => {
  if (props.node.type !== 'split') return {}
  const basis = `${((1 - props.node.ratio) * 100).toFixed(1)}%`
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

<style scoped>
.ptr-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-top: 2px solid var(--border);
}
.ptr-pane--focused {
  border-top-color: var(--accent);
}

.ptr-split {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.ptr-split--horizontal {
  flex-direction: row;
}
.ptr-split--vertical {
  flex-direction: column;
}

.ptr-split__child {
  flex: 0 1 auto;
  display: flex;
  min-width: 0;
  min-height: 0;
  /* Prevent child from shrinking below zero */
}
</style>
