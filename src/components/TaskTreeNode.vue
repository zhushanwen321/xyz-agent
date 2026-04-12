<script setup lang="ts">
import { ref, computed } from 'vue'
import type { OrchestrateNode } from '../types'

const props = defineProps<{
  node: OrchestrateNode
  allNodes: Map<string, OrchestrateNode>
  depth: number
  selectedNodeId?: string | null
}>()

const emit = defineEmits<{
  select: [nodeId: string]
  kill: [nodeId: string]
  anchor: [nodeId: string]
}>()

const isExpanded = ref(true)

const children = computed(() =>
  props.node.children_ids
    .map(id => props.allNodes.get(id))
    .filter(Boolean) as OrchestrateNode[]
)

const statusDotColor = computed(() => {
  switch (props.node.status) {
    case 'running': return 'bg-blue-400'
    case 'completed': return 'bg-green-400'
    case 'idle': return 'bg-yellow-400'
    case 'failed': return 'bg-red-400'
    default: return 'bg-zinc-400'
  }
})

const roleBadge = computed(() =>
  props.node.role === 'orchestrator' ? 'O' : 'E'
)
</script>

<template>
  <div>
    <!-- 节点行 -->
    <div
      class="flex items-center gap-1.5 py-1 rounded-sm hover:bg-zinc-800/50 cursor-pointer text-[12px]"
      :class="{ 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/30': selectedNodeId === node.node_id }"
      :style="{ paddingLeft: `${depth * 16 + 4}px` }"
      @click="emit('anchor', node.node_id)"
    >
      <!-- 展开/折叠 -->
      <button
        v-if="children.length > 0"
        class="w-4 h-4 flex items-center justify-center text-text-secondary hover:text-text-primary shrink-0"
        @click.stop="isExpanded = !isExpanded"
      >
        <span class="text-[10px] transition-transform" :class="isExpanded ? '' : '-rotate-90'">\u25BC</span>
      </button>
      <span v-else class="w-4 shrink-0" />

      <!-- Role badge -->
      <span
        class="w-4 h-4 rounded-sm flex items-center justify-center text-[9px] font-bold font-mono shrink-0"
        :class="node.role === 'orchestrator' ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-600/40 text-zinc-400'"
      >
        {{ roleBadge }}
      </span>

      <!-- 描述 -->
      <span class="text-text-primary truncate min-w-0 flex-1">
        {{ node.description }}
      </span>

      <!-- 状态色点 -->
      <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="statusDotColor" />

      <!-- Kill 按钮：仅 running 状态显示 -->
      <button
        v-if="node.status === 'running'"
        class="w-4 h-4 flex items-center justify-center text-text-secondary hover:text-red-400 shrink-0"
        title="Kill"
        @click.stop="emit('kill', node.node_id)"
      >
        <span class="text-[10px]">\u2715</span>
      </button>
    </div>

    <!-- 递归渲染子节点，最大深度 20 防止循环引用导致栈溢出 -->
    <div v-if="isExpanded && children.length > 0 && depth < 20">
      <TaskTreeNode
        v-for="child in children"
        :key="child.node_id"
        :node="child"
        :all-nodes="allNodes"
        :depth="depth + 1"
        :selected-node-id="selectedNodeId"
        @select="emit('select', $event)"
        @kill="emit('kill', $event)"
        @anchor="emit('anchor', $event)"
      />
    </div>
  </div>
</template>
