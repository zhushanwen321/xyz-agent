<template>
  <!--
    变更集卡（ADR-0024 D6，flow-2 §状态机·变更集卡）。
    5 态状态机：accumulating / ready / partially-reviewed / resolved / superseded。
    runtime 推 accumulating/ready（事实态），前端用户交互驱动 partially-reviewed/resolved/superseded（审查态）。

    渲染：折叠卡（header 计数 + 状态指示 + 展开文件列表，A/M/D badge + 行数）。
    resolved/superseded 默认折叠归档。
  -->
  <div v-if="fileChanges.length > 0" class="change-set-card rounded-md border border-border bg-bg">
    <!-- header：点击折叠/展开 -->
    <div
      class="flex cursor-pointer select-none items-center gap-2 px-3 py-2"
      @click="collapsed = !collapsed"
    >
      <ChevronRight class="size-3 shrink-0 text-muted transition-transform" :class="collapsed ? '' : 'rotate-90'" />
      <FileEdit class="size-3.5 shrink-0 text-info" />
      <span class="text-[12px] font-medium text-fg">变更集</span>
      <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-subtle">{{ fileChanges.length }}</span>
      <!-- 状态 badge -->
      <span class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="statusClass">{{ statusLabel }}</span>
      <!-- 行数汇总 -->
      <span v-if="totalAdd > 0 || totalDel > 0" class="ml-auto flex items-center gap-1.5 text-[10px] tabular-nums">
        <span class="text-success">+{{ totalAdd }}</span>
        <span class="text-danger">-{{ totalDel }}</span>
      </span>
    </div>

    <!-- 展开详情：文件清单 -->
    <div v-if="!collapsed" class="border-t border-border">
      <div
        v-for="c in fileChanges"
        :key="c.filePath"
        class="flex items-center gap-2 px-3 py-1.5 text-[12px]"
      >
        <span class="shrink-0 rounded-sm px-1 py-0.5 font-mono text-[10px] font-semibold" :class="changeBadgeClass(c.status)">{{ changeLabel(c.status) }}</span>
        <span class="flex-1 truncate font-mono text-fg" :title="c.filePath">{{ c.filePath }}</span>
        <span v-if="c.addLines !== undefined || c.delLines !== undefined" class="shrink-0 flex items-center gap-1 text-[10px] tabular-nums">
          <span v-if="c.addLines !== undefined" class="text-success">+{{ c.addLines }}</span>
          <span v-if="c.delLines !== undefined" class="text-danger">-{{ c.delLines }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, FileEdit } from '@lucide/vue'
import type { FileChange, ChangeSetStatus } from '@xyz-agent/shared'

const props = defineProps<{
  fileChanges: FileChange[]
  status?: ChangeSetStatus
}>()

/**
 * resolved/superseded 默认折叠（归档态）；其余默认展开（审查中）。
 */
const collapsed = ref(props.status === 'resolved' || props.status === 'superseded')

/** 状态 badge 文案（响应式：status 变化时重算） */
const statusLabel = computed(() => resolveStatusLabel(props.status))
const statusClass = computed(() => resolveStatusClass(props.status))

function resolveStatusLabel(status: ChangeSetStatus | undefined): string {
  switch (status) {
    case 'accumulating': return '生成中'
    case 'ready': return '待审查'
    case 'partially-reviewed': return '部分已审'
    case 'resolved': return '已完成'
    case 'superseded': return '已过期'
    default: return '待审查'
  }
}
function resolveStatusClass(status: ChangeSetStatus | undefined): string {
  switch (status) {
    case 'accumulating': return 'bg-accent-soft text-accent'
    case 'ready': return 'bg-info/10 text-info'
    case 'partially-reviewed': return 'bg-amber-500/10 text-amber-500'
    case 'resolved': return 'bg-success/10 text-success'
    case 'superseded': return 'bg-surface text-subtle'
    default: return 'bg-info/10 text-info'
  }
}

/** 行数汇总（所有文件的 addLines/delLines 之和） */
const totalAdd = computed(() =>
  props.fileChanges.reduce((sum, c) => sum + (c.addLines ?? 0), 0),
)
const totalDel = computed(() =>
  props.fileChanges.reduce((sum, c) => sum + (c.delLines ?? 0), 0),
)

/** 单文件变更状态 badge（A/M/D） */
function changeLabel(status: FileChange['status']): string {
  return { added: 'A', modified: 'M', deleted: 'D' }[status]
}
function changeBadgeClass(status: FileChange['status']): string {
  return {
    added: 'bg-success/10 text-success',
    modified: 'bg-info/10 text-info',
    deleted: 'bg-danger/10 text-danger',
  }[status]
}
</script>
