<template>
  <!-- 递归行：目录（可折叠）/ 文件（图标 + M/A/D 状态标签） -->
  <div>
    <!-- 目录 -->
    <div
      v-if="node.type === 'dir'"
      class="flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-[11px] transition-colors hover:bg-surface-hover"
      :style="{ paddingLeft: `${depth * 10 + 8}px` }"
      @click="toggle"
    >
      <ChevronRight
        class="size-3 shrink-0 text-subtle transition-transform"
        :class="{ 'rotate-90': expanded }"
      />
      <Folder class="size-3.5 shrink-0 text-muted" />
      <span class="flex-1 truncate text-muted">{{ node.name }}</span>
      <span class="font-mono text-[9.5px] text-subtle">{{ node.fileCount }}</span>
    </div>
    <template v-if="node.type === 'dir' && expanded">
      <FileTreeRow
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :depth="depth + 1"
      />
    </template>

    <!-- 文件 -->
    <div
      v-else
      class="flex items-center gap-2 rounded-md py-1 pr-2 transition-colors hover:bg-surface-hover"
      :style="{ paddingLeft: `${depth * 10 + 18}px` }"
    >
      <component :is="fileIcon" class="size-3.5 shrink-0" :class="fileIconColor" />
      <span class="flex-1 truncate font-mono text-[12px] text-fg">{{ node.name }}</span>
      <span
        v-if="typeof node.addLines === 'number' || typeof node.delLines === 'number'"
        class="font-mono text-[10px]"
      >
        <span v-if="node.addLines" class="text-success">+{{ node.addLines }}</span>
        <span v-if="node.addLines && node.delLines" class="text-subtle"> </span>
        <span v-if="node.delLines" class="text-danger">−{{ node.delLines }}</span>
      </span>
      <span
        v-if="node.change"
        class="rounded-sm px-1 py-0.5 font-mono text-[10px]"
        :class="changeBadgeClass"
      >{{ changeLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ChevronRight, Folder, FileText, FileCode, FileJson } from '@lucide/vue'
import type { FileChange } from '@xyz-agent/shared'

interface TreeNode {
  key: string
  name: string
  type: 'file' | 'dir'
  children: TreeNode[]
  change?: FileChange['status']
  /** +N/-N 行数（文件用，FR-10 §4.8 F8） */
  addLines?: number
  delLines?: number
  fileCount: number
}

const props = defineProps<{
  node: TreeNode
  depth: number
}>()

/** 目录展开态（本地，全展开默认，无需持久化） */
const expanded = ref(true)
function toggle(): void {
  expanded.value = !expanded.value
}

const ext = computed(() => {
  const parts = props.node.name.split('.')
  return parts.length > 1 ? (parts.pop() ?? '') : ''
})

/** 文件图标按扩展名 */
const fileIcon = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': case 'js': case 'cjs': case 'mjs': return FileCode
    case 'json': return FileJson
    default: return FileText
  }
})

/** 图标色按扩展名（避开 M/A/D 的橙绿红） */
const fileIconColor = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': return 'text-info'
    case 'vue': return 'text-success'
    case 'json': return 'text-warning'
    case 'md': return 'text-muted'
    default: return 'text-subtle'
  }
})

/** M/A/D/U/R/? 标签（modified 橙 / added 绿 / deleted 红 / unmerged 红，design-tokens 语义色） */
const changeBadgeClass = computed(() => {
  switch (props.node.change) {
    case 'modified': return 'bg-warning/12 text-warning'
    case 'added': return 'bg-success/12 text-success'
    case 'deleted': return 'bg-danger/12 text-danger'
    case 'unmerged': return 'bg-danger/16 text-danger font-semibold'
    default: return ''
  }
})

const changeLabel = computed(() => {
  switch (props.node.change) {
    case 'modified': return 'M'
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'unmerged': return 'U'
    default: return ''
  }
})
</script>
