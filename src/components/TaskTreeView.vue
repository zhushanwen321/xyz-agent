<script setup lang="ts">
import { computed } from 'vue'
import type { OrchestrateNode } from '../types'
import TaskTreeNode from './TaskTreeNode.vue'

const props = defineProps<{
  nodes: Map<string, OrchestrateNode>
}>()

const emit = defineEmits<{
  select: [nodeId: string]
  kill: [nodeId: string]
}>()

// 根节点：没有 parent_id 的节点
const rootNodes = computed(() =>
  [...props.nodes.values()].filter(n => n.parent_id === null)
)
</script>

<template>
  <div class="space-y-0.5">
    <TaskTreeNode
      v-for="node in rootNodes"
      :key="node.node_id"
      :node="node"
      :all-nodes="nodes"
      :depth="0"
      @select="emit('select', $event)"
      @kill="emit('kill', $event)"
    />
  </div>
</template>
