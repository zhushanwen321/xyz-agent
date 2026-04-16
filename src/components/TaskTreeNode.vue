<script setup lang="ts">
import { ref, computed } from 'vue'
import type { OrchestrateNode } from '../types'
import { formatTokens } from '../lib/format'

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

const statusLabel = computed(() => {
  if (props.node.status === 'idle' && props.node.reuse_count > 0) {
    return `idle(${props.node.reuse_count}x)`
  }
  switch (props.node.status) {
    case 'completed': return '&#x2713;'
    case 'failed': return '&#x2717;'
    case 'idle': return 'idle'
    case 'running': return ''
    default: return props.node.status
  }
})

const statusColor = computed(() => {
  switch (props.node.status) {
    case 'running': return 'text-blue-400'
    case 'completed': return 'text-green-400'
    case 'idle': return 'text-yellow-400'
    case 'failed': return 'text-red-400'
    default: return 'text-zinc-400'
  }
})

const roleBadge = computed(() =>
  props.node.role === 'orchestrator' ? 'O' : 'E'
)
</script>

<template>
  <div class="tree-node" :class="{ 'is-root': depth === 0 }">
    <!-- 节点行 -->
    <div
      class="tree-node-row flex items-center gap-1.5 py-1 rounded-sm hover:bg-zinc-800/50 cursor-pointer text-[12px]"
      :class="{ 'bg-blue-500/10 ring-1 ring-inset ring-blue-500/30': selectedNodeId === node.node_id }"
      @click="emit('anchor', node.node_id)"
    >
      <!-- 展开/折叠 -->
      <button
        v-if="children.length > 0"
        class="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
        @click.stop="isExpanded = !isExpanded"
      >
        <span class="text-[10px] transition-transform" :class="isExpanded ? '' : '-rotate-90'">&#x25BC;</span>
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
      <span class="text-foreground truncate min-w-0 flex-1">
        {{ node.description }}
      </span>

      <!-- 元数据：children 数（非叶节点显示） -->
      <span v-if="children.length > 0" class="text-[10px] text-tertiary shrink-0">
        {{ children.length }}ch
      </span>

      <!-- depth 标签（仅非根节点显示） -->
      <span v-if="depth > 0" class="text-[10px] text-tertiary shrink-0">
        d{{ depth }}
      </span>

      <!-- Token 用量 -->
      <span v-if="formatTokens(node.usage.total_tokens)" class="text-[10px] font-mono text-muted-foreground shrink-0">
        {{ formatTokens(node.usage.total_tokens) }}
      </span>

      <!-- 状态标识 -->
      <span v-if="node.status === 'running'" class="shrink-0">
        <span class="inline-block h-2 w-2 animate-spin rounded-full border border-blue-400 border-t-transparent" />
      </span>
      <span v-else class="text-[10px] font-mono shrink-0" :class="statusColor" v-html="statusLabel" />

      <!-- Kill 按钮：仅 running 状态显示 -->
      <button
        v-if="node.status === 'running'"
        class="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-red-400 shrink-0"
        title="Kill"
        @click.stop="emit('kill', node.node_id)"
      >
        <span class="text-[10px]">&#x2715;</span>
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

<style scoped>
.tree-node {
  position: relative;
}

/* 根节点基础缩进 */
.tree-node.is-root {
  padding-left: 4px;
}

/* 子节点通过 wrapper 缩进，产生累积缩进效果 */
.tree-node:not(.is-root) {
  padding-left: 16px;
}

/* 垂直连接线 — 贯穿子节点列表 */
.tree-node:not(.is-root)::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #3f3f46;
}

/* 水平连接线 — 从垂直线延伸到节点内容 */
.tree-node:not(.is-root) > .tree-node-row::before {
  content: '';
  position: absolute;
  left: -9px;
  top: 50%;
  width: 9px;
  height: 1px;
  background: #3f3f46;
}

/* 需要让 row 支持 before 伪元素定位 */
.tree-node-row {
  position: relative;
}

/* 最后一个子节点的垂直线只到节点中心 */
.tree-node:not(.is-root):last-child::before {
  bottom: calc(100% - 12px);
}
</style>
