<template>
  <div class="tree-root">
    <div
      v-for="node in nodes"
      :key="node.id"
      class="tree-node"
      :class="{ active: node.id === activeNodeId }"
      @click="$emit('navigate', node.id)"
    >
      <span class="tree-node__dot" :class="`dot--${node.status || 'idle'}`"></span>
      <span class="tree-node__label">{{ node.label }}</span>
      <span v-if="node.meta" class="tree-node__meta">{{ node.meta }}</span>
      <button class="tree-node__kill" @click.stop="$emit('kill', node.id)">终止</button>
    </div>
  </div>
</template>

<script setup lang="ts">
interface TreeNode {
  id: string
  label: string
  status?: string
  meta?: string
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
