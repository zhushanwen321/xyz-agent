<script setup lang="ts">
/**
 * MobileFileTreeNode —— 递归文件树节点（spec P4 D6 只读）。
 * 独立组件便于递归 self-reference（SFC name + <MobileFileTreeNode> 自引用）。
 */
import { ChevronRight, Folder, FileText } from '@lucide/vue'
import type { FileNode } from '@xyz-agent/shared'

const props = defineProps<{
  node: FileNode
  level: number
  expanded: Set<string>
}>()
const emit = defineEmits<{
  toggle: [path: string]
  select: [path: string]
}>()

function onClick(): void {
  if (props.node.type === 'dir') {
    emit('toggle', props.node.path)
  } else {
    emit('select', props.node.path)
  }
}
</script>

<template>
  <li>
    <button
      type="button"
      class="flex w-full items-center gap-1.5 border-0 bg-transparent py-1.5 text-left text-sm text-muted hover:bg-surface-hover"
      :style="{ paddingLeft: `${level * 16 + 12}px` }"
      :data-testid="`mobile-file-node-${node.path}`"
      @click="onClick"
    >
      <ChevronRight
        v-if="node.type === 'dir'"
        :size="14"
        class="shrink-0"
        :style="{ transform: expanded.has(node.path) ? 'rotate(90deg)' : 'none', transition: 'transform 150ms' }"
      />
      <span v-else class="inline-block w-[14px] shrink-0" />
      <Folder v-if="node.type === 'dir'" :size="14" class="shrink-0 text-muted" />
      <FileText v-else :size="14" class="shrink-0 text-subtle" />
      <span class="truncate">{{ node.name }}</span>
    </button>
    <!-- 递归子节点（dir 展开时） -->
    <ul v-if="node.type === 'dir' && expanded.has(node.path) && node.children">
      <MobileFileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :level="level + 1"
        :expanded="expanded"
        @toggle="emit('toggle', $event)"
        @select="emit('select', $event)"
      />
    </ul>
  </li>
</template>
