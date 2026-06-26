<template>
  <!--
    展示组件 · 文件视图（子视图 B，draft-five-states §B）。
    树形目录 + 文件列表，按扩展名着色，M/A/D 状态标签。
    数据来源：props.changes（Sidebar 从 chat store 聚合 active session 的 fileChanges 传入）。
  -->
  <ScrollArea class="h-full">
    <div class="flex flex-col gap-0.5 px-1">
      <!-- 头部：改动文件计数 + 当前 session -->
      <div class="flex items-center gap-1.5 px-2 py-1.5">
        <span class="font-mono text-[10px] uppercase tracking-wider text-subtle">改动文件</span>
        <span class="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">
          {{ fileCount }}
        </span>
      </div>
      <div v-if="sessionLabel" class="truncate px-2 pb-1 font-mono text-[10.5px] text-muted">
        <span class="text-fg">{{ sessionLabel }}</span>
        <span v-if="branch" class="opacity-60"> · </span>
        <span v-if="branch" class="text-accent">{{ branch }}</span>
      </div>

      <!-- 过滤框：实时按路径模糊匹配文件树 -->
      <div class="relative px-2 pb-1.5">
        <Search class="pointer-events-none absolute left-4 top-1/2 size-3 -translate-y-1/2 text-subtle" />
        <Input
          v-model="filterText"
          class="h-6 pl-6 pr-2 text-[11px]"
          placeholder="过滤文件..."
        />
      </div>

      <!-- 空态 -->
      <div
        v-if="fileCount === 0"
        class="flex flex-col items-center justify-center gap-2 py-10 text-center"
      >
        <FolderOpen class="size-5 text-subtle opacity-50" />
        <p class="text-[11.5px] text-subtle opacity-55">暂无改动文件</p>
      </div>

      <!-- 文件树 -->
      <div v-else class="mt-1 flex flex-col gap-px">
        <FileTreeRow
          v-for="node in tree"
          :key="node.key"
          :node="node"
          :depth="0"
        />
      </div>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FileChange } from '@xyz-agent/shared'
import { FolderOpen, Search } from '@lucide/vue'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import FileTreeRow from './FileTreeRow.vue'

/** 树节点（内部类型，由扁平 FileChange[] 构建） */
interface TreeNode {
  key: string
  name: string
  type: 'file' | 'dir'
  children: TreeNode[]
  change?: FileChange['status']
  /** +N/-N 行数（文件用，FR-10 §4.8 F8） */
  addLines?: number
  delLines?: number
  /** 直系文件数（目录用，展示在右侧） */
  fileCount: number
}

const props = defineProps<{
  changes: FileChange[]
  sessionLabel?: string
  branch?: string
}>()

// 过滤框文本：按 filePath 模糊匹配，空串表示不过滤
const filterText = ref('')

// 过滤后的 changes（path.includes）。过滤命中数为 0 但有输入时，下方空态分支会处理。
const filteredChanges = computed<FileChange[]>(() => {
  const q = filterText.value.trim().toLowerCase()
  if (!q) return props.changes
  return props.changes.filter((c) => c.filePath.toLowerCase().includes(q))
})

const fileCount = computed(() => filteredChanges.value.length)

/** 扁平 FileChange[] → 嵌套树。默认展开所有目录（改动文件少，全展开更直观）。 */
const tree = computed<TreeNode[]>(() => buildTree(filteredChanges.value))

function buildTree(changes: FileChange[]): TreeNode[] {
  const root: TreeNode[] = []
  // key → node 引用，用于挂载子节点
  const dirMap = new Map<string, TreeNode>()

  for (const fc of changes) {
    const parts = fc.filePath.split('/')
    let path = ''
    let level = root
    parts.forEach((part, i) => {
      path = path ? `${path}/${part}` : part
      const isFile = i === parts.length - 1
      if (isFile) {
        level.push({
          key: path,
          name: part,
          type: 'file',
          children: [],
          change: fc.status,
          addLines: fc.addLines,
          delLines: fc.delLines,
          fileCount: 1,
        })
      } else {
        let dir = dirMap.get(path)
        if (!dir) {
          dir = { key: path, name: part, type: 'dir', children: [], fileCount: 0 }
          dirMap.set(path, dir)
          level.push(dir)
        }
        dir.fileCount += 1
        level = dir.children
      }
    })
  }
  return root
}
</script>
