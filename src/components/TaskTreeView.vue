<script setup lang="ts">
import { computed } from 'vue'
import type { OrchestrateNode } from '../types'
import TaskTreeNode from './TaskTreeNode.vue'
import { formatTokensAlways as formatTokens, formatDuration } from '../lib/format'
import { getStatusClasses } from '../lib/status'

const props = defineProps<{
  nodes: Map<string, OrchestrateNode>
  selectedNodeId?: string | null
  anchorNodeId?: string | null
}>()

const emit = defineEmits<{
  select: [nodeId: string]
  kill: [nodeId: string]
  anchor: [nodeId: string | null]
}>()

// 根节点：没有 parent_id 的节点
const rootNodes = computed(() =>
  [...props.nodes.values()].filter(n => n.parent_id === null)
)

// 从根到目标节点的路径
function findPath(targetId: string): OrchestrateNode[] {
  for (const node of props.nodes.values()) {
    if (node.parent_id === null) {
      const path = _findPath(node, targetId, [])
      if (path) return path
    }
  }
  return []
}

function _findPath(node: OrchestrateNode, targetId: string, path: OrchestrateNode[]): OrchestrateNode[] | null {
  path.push(node)
  if (node.node_id === targetId) return [...path]
  for (const childId of node.children_ids) {
    const child = props.nodes.get(childId)
    if (child) {
      const result = _findPath(child, targetId, path)
      if (result) return result
    }
  }
  path.pop()
  return null
}

// 计算 subtree 大小（含自身）
function countSubtree(node: OrchestrateNode): number {
  let count = 1
  for (const childId of node.children_ids) {
    const child = props.nodes.get(childId)
    if (child) count += countSubtree(child)
  }
  return count
}

const anchorNode = computed(() => {
  if (!props.anchorNodeId) return null
  return props.nodes.get(props.anchorNodeId) ?? null
})

// 祖先路径，不含自身
const ancestorPath = computed(() => {
  if (!props.anchorNodeId) return []
  return findPath(props.anchorNodeId).slice(0, -1)
})

const anchorChildren = computed(() => {
  if (!anchorNode.value) return []
  return anchorNode.value.children_ids
    .map(id => props.nodes.get(id))
    .filter(Boolean) as OrchestrateNode[]
})

const anchorSubtreeSize = computed(() => {
  if (!anchorNode.value) return 0
  return countSubtree(anchorNode.value) - 1
})

function roleLabel(role: string): string {
  if (role === 'orchestrator') return '[O]'
  if (role === 'executor') return '[E]'
  return '[M]'
}

function roleColorClass(role: string): string {
  if (role === 'orchestrator') return 'text-[#eab308]'
  if (role === 'executor') return 'text-[#3b82f6]'
  return 'text-[#22c55e]'
}
</script>

<template>
  <div class="space-y-0.5">
    <!-- 紧凑模式（默认） -->
    <template v-if="!anchorNodeId">
      <TaskTreeNode
        v-for="node in rootNodes"
        :key="node.node_id"
        :node="node"
        :all-nodes="nodes"
        :depth="0"
        :selected-node-id="selectedNodeId"
        @select="emit('select', $event)"
        @kill="emit('kill', $event)"
        @anchor="emit('anchor', $event)"
      />
    </template>

    <!-- 锚定模式 -->
    <div v-else class="flex flex-col gap-1.5">
      <!-- Exit anchor -->
      <div class="text-right">
        <button class="text-[10px] text-[#71717a] hover:text-[#fafafa] cursor-pointer" @click="emit('anchor', null)">&times; exit focus</button>
      </div>

      <!-- PARENTS -->
      <template v-if="ancestorPath.length > 0">
        <div class="text-[10px] text-[#71717a] font-semibold tracking-wider py-1">PARENTS</div>
        <div
          v-for="(ancestor, idx) in ancestorPath"
          :key="ancestor.node_id"
          class="py-1 px-2 rounded-sm bg-[#1f1f23] border border-[#27272a] cursor-pointer hover:border-[#3b82f6] transition-colors opacity-70"
          :style="{ marginLeft: `${idx * 12}px` }"
          @click="emit('anchor', ancestor.node_id)"
        >
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] font-bold" :class="roleColorClass(ancestor.role)">
              {{ roleLabel(ancestor.role) }}
            </span>
            <span class="text-[11px] text-[#fafafa] font-semibold truncate flex-1">{{ ancestor.description }}</span>
            <span class="text-[10px] font-mono text-[#71717a] shrink-0">{{ formatTokens(ancestor.usage.total_tokens) }}</span>
          </div>
        </div>
      </template>

      <!-- CURRENT -->
      <div v-if="anchorNode" class="text-[10px] text-[#71717a] font-semibold tracking-wider py-1">CURRENT</div>
      <div v-if="anchorNode" class="rounded-md border-[1.5px] border-[#3b82f6] bg-[#111113] p-2.5">
        <div class="flex items-center gap-1.5 mb-1.5">
          <span class="text-[11px] font-bold" :class="roleColorClass(anchorNode.role)">
            {{ roleLabel(anchorNode.role) }}
          </span>
          <span class="text-[12px] text-[#fafafa] font-bold flex-1 truncate">{{ anchorNode.description }}</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-sm" :class="getStatusClasses(anchorNode.status)">{{ anchorNode.status }}</span>
        </div>
        <div class="text-[10px] text-[#a1a1aa] space-y-0.5">
          <div class="flex justify-between"><span>tokens</span><span class="font-mono">{{ formatTokens(anchorNode.usage.total_tokens) }} / {{ formatTokens(anchorNode.budget.max_tokens) }}</span></div>
          <div class="flex justify-between"><span>duration</span><span class="font-mono">{{ formatDuration(anchorNode.usage.duration_ms) }}</span></div>
          <div class="flex justify-between"><span>tool calls</span><span class="font-mono">{{ anchorNode.usage.tool_uses }}</span></div>
          <div class="flex justify-between"><span>depth</span><span class="font-mono">{{ ancestorPath.length }}</span></div>
          <div class="flex justify-between"><span>children</span><span class="font-mono">{{ anchorChildren.length }}</span></div>
          <div class="flex justify-between"><span>subtree</span><span class="font-mono">{{ anchorSubtreeSize + 1 }} nodes</span></div>
        </div>
      </div>

      <!-- CHILDREN -->
      <div v-if="anchorChildren.length > 0" class="text-[10px] text-[#71717a] font-semibold tracking-wider py-1">CHILDREN ({{ anchorChildren.length }})</div>
      <div
        v-for="child in anchorChildren"
        :key="child.node_id"
        class="py-1.5 px-2.5 rounded-sm bg-[#1f1f23] border border-[#27272a] cursor-pointer hover:border-[#3b82f6] hover:bg-[#18181b] transition-colors"
        @click="emit('anchor', child.node_id)"
      >
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] font-bold" :class="roleColorClass(child.role)">
            {{ roleLabel(child.role) }}
          </span>
          <span class="text-[11px] text-[#fafafa] font-semibold truncate flex-1">{{ child.description }}</span>
          <span class="text-[10px] font-mono text-[#71717a] shrink-0">{{ formatTokens(child.usage.total_tokens) }}</span>
          <span class="text-[10px] px-1.5 py-0.5 rounded-sm" :class="getStatusClasses(child.status)">
            {{ child.status === 'idle' && child.reuse_count > 0 ? `idle(${child.reuse_count}x)` : child.status }}
          </span>
        </div>
        <div v-if="child.children_ids.length > 0" class="text-[10px] text-[#3b82f6] mt-0.5 pt-0.5 border-t border-[#27272a]">
          {{ child.children_ids.length }} direct &middot; {{ countSubtree(child) - 1 }} total &rarr;
        </div>
      </div>
    </div>
  </div>
</template>
