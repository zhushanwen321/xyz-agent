<template>
  <div
    class="group flex items-center gap-2 py-1.5 px-2 text-xs rounded-xs cursor-pointer transition-colors duration-100 ease-ease select-none relative"
    :class="node.id === activeNodeId ? 'bg-accent-light text-accent font-semibold' : 'hover:bg-accent-light'"
    @click="$emit('navigate', node.id)"
  >
    <span
      v-if="hasChildren"
      class="w-[14px] h-[14px] flex items-center justify-center text-[8px] text-muted cursor-pointer shrink-0 transition-transform duration-150 ease-ease"
      :class="{ '-rotate-90': collapsed }"
      @click.stop="collapsed = !collapsed"
    >▾</span>
    <span v-else style="width:14px;display:inline-block"></span>
    <span class="w-[7px] h-[7px] rounded-full shrink-0" :style="dotStyle"></span>
    <span class="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
      <strong v-if="node.bold">{{ node.label }}</strong>
      <template v-else>{{ node.label }}</template>
    </span>
    <span v-if="node.meta" class="text-[10px] text-muted font-mono whitespace-nowrap">{{ node.meta }}</span>
    <span v-if="depth > 0" class="hidden group-hover:inline-flex py-[3px] px-2 border border-border rounded-xs bg-surface text-muted text-[10px] cursor-pointer font-body transition-all duration-100 ease-ease whitespace-nowrap shrink-0 hover:bg-danger-light hover:text-danger hover:border-danger" @click.stop="$emit('kill', node.id)">终止</span>
  </div>
  <div v-if="hasChildren" class="pl-4 border-l border-border ml-[11px]" :class="{ hidden: collapsed }">
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
