<template>
  <div
    class="tree-node"
    :class="{ active: node.id === activeNodeId }"
    @click="$emit('navigate', node.id)"
  >
    <span
      v-if="hasChildren"
      class="tree-node__toggle"
      :class="{ collapsed: collapsed }"
      @click.stop="collapsed = !collapsed"
    >▾</span>
    <span v-else style="width:14px;display:inline-block"></span>
    <span class="tree-node__dot" :style="dotStyle"></span>
    <span class="tree-node__label">
      <strong v-if="node.bold">{{ node.label }}</strong>
      <template v-else>{{ node.label }}</template>
    </span>
    <span v-if="node.meta" class="tree-node__meta">{{ node.meta }}</span>
    <span v-if="depth > 0" class="tree-node__kill" @click.stop="$emit('kill', node.id)">终止</span>
  </div>
  <div v-if="hasChildren" class="tree-children" :class="{ collapsed }">
    <template v-for="child in node.children" :key="child.id">
      <TreeNodeItem
        :node="child"
        :active-node-id="activeNodeId"
        :depth="depth + 1"
        @navigate="$emit('navigate', $event)"
        @kill="$emit('kill', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface TreeNode {
  id: string
  label: string
  status?: string
  meta?: string
  bold?: boolean
  children?: TreeNode[]
}

const props = defineProps<{
  node: TreeNode
  activeNodeId: string
  depth: number
}>()

defineEmits<{
  navigate: [nodeId: string]
  kill: [nodeId: string]
}>()

const collapsed = ref(false)

const hasChildren = computed(() => props.node.children && props.node.children.length > 0)

// Map status to CSS variable, matching HTML prototype inline styles
const statusColorMap: Record<string, string> = {
  success: 'var(--success)',
  accent: 'var(--accent)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  border: 'var(--border)',
  idle: 'var(--border)',
  run: 'var(--success)',
  pause: 'var(--warning)',
}

const dotStyle = computed(() => ({
  background: statusColorMap[props.node.status || 'idle'] || 'var(--border)',
}))
</script>
