<template>
  <!--
    展示组件 · 文件视图（子视图 B，draft-five-states §B）。
    树形目录 + 文件列表，按扩展名着色，M/A/D 状态标签。
    数据来源：mock/data.ts 的 fixtureFileChanges（按 sessionId 索引）。
    v1 仅 mock 视图，runtime file-changes 通道联调见 ADR-0024。
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
import { computed } from 'vue'
import type { FileChange } from '@xyz-agent/shared'
import { FolderOpen } from '@lucide/vue'
import { ScrollArea } from '@/components/ui/scroll-area'
import FileTreeRow from './FileTreeRow.vue'

/** 树节点（内部类型，由扁平 FileChange[] 构建） */
interface TreeNode {
  key: string
  name: string
  type: 'file' | 'dir'
  children: TreeNode[]
  change?: FileChange['status']
  /** 直系文件数（目录用，展示在右侧） */
  fileCount: number
}

const props = defineProps<{
  changes: FileChange[]
  sessionLabel?: string
  branch?: string
}>()

const fileCount = computed(() => props.changes.length)

/** 扁平 FileChange[] → 嵌套树。默认展开所有目录（改动文件少，全展开更直观）。 */
const tree = computed<TreeNode[]>(() => buildTree(props.changes))

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
