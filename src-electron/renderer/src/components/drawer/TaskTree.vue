<template>
  <div class="tree-root">
    <template v-for="node in nodes" :key="node.id">
      <TreeNodeItem
        :node="node"
        :active-node-id="activeNodeId"
        :depth="0"
        @navigate="$emit('navigate', $event)"
        @kill="$emit('kill', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import TreeNodeItem from './TreeNodeItem.vue'

interface TreeNode {
  id: string
  label: string
  status?: string
  meta?: string
  bold?: boolean
  children?: TreeNode[]
}

defineProps<{
  nodes: TreeNode[]
  activeNodeId: string
}>()

defineEmits<{
  navigate: [nodeId: string]
  kill: [nodeId: string]
}>()
</script>
