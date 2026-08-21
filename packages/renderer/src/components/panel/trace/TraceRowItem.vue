<template>
  <!--
    展示组件 · trace-row-item（session-trace §3.4 渲染模型，一行 = 一个 entry）。
    12 kind + MALFORMED 数据驱动渲染：seq + kind badge（demo 色板）+ 时间 + headline
    （core 数据提取）+ kind 特化 meta 后缀 + 「不进 context」弱标记。
    assistant 聚合行带 chevron（toggle-expand）内联展开子 block（TraceBlockRowItem）。
    状态语义：
    - 影子化（shadowed）：降透明（demo .tr-row.shadowed opacity .42），hover 恢复。
    - 选中态：bg-surface-hover + 摘要 text-accent，无 ring 无左条（v6 §3.4 列表项型；
      行底色已是 surface 的场景按 SearchModal sm-item 登记例外——surface-hover + 强调字色）。
    - MALFORMED headline 走 i18n（core headline 是数据提取，损坏行文案归 UI 层）。
  -->
  <div
    class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-[5px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-surface-2"
    :class="[
      row.shadowed ? 'opacity-40 hover:opacity-75' : '',
      selected ? 'bg-surface-hover hover:bg-surface-hover' : '',
    ]"
    :data-testid="`trace-row-${row.seq}`"
    :data-kind="row.kind"
    :data-shadowed="row.shadowed ? 'true' : undefined"
    :data-in-context="row.inContext ? 'true' : undefined"
    :title="rowTitle"
    @click="emit('select', row)"
  >
    <!-- seq 全行对齐（不引入占位 gutter——普通行保持原左边界）；assistant 聚合行的
         展开开关（chevron，stopPropagation 不触发行选中）置于 seq 与 badge 之间，
         仅 assistant 行 badge 右移（badge 宽度本随 kind 文字变化，无对齐损失） -->
    <span class="w-9 shrink-0 text-left font-mono text-[10px] tabular-nums text-neutral-faint">#{{ row.seq }}</span>
    <Button
      v-if="expandable"
      variant="ghost"
      size="sm"
      class="h-4 w-4 shrink-0 p-0 text-neutral-faint hover:bg-surface-2 hover:text-neutral-mid"
      :data-testid="`trace-expand-toggle-${row.seq}`"
      :title="t('panel.trace.toggleBlocks')"
      @click.stop="emit('toggle-expand', row)"
    >
      <ChevronDown v-if="expanded" class="size-3" />
      <ChevronRight v-else class="size-3" />
    </Button>
    <span
      class="shrink-0 rounded px-1.5 py-px font-mono text-[10px] tracking-wide"
      :class="KIND_BADGE_CLASS[row.kind]"
    >{{ row.kind }}</span>
    <span v-if="time" class="shrink-0 font-mono text-[10px] tabular-nums text-neutral-faint">{{ time }}</span>
    <span
      class="min-w-0 flex-1 truncate text-[12px]"
      :class="selected ? 'text-accent' : row.shadowed ? 'text-neutral-mid' : 'text-neutral-fg'"
    >
      <template v-if="row.kind === 'MALFORMED'">{{ t('panel.trace.malformedLine', { line: row.lineNumber ?? 0 }) }}</template>
      <template v-else>{{ headline }}</template>
      <span v-if="suffix" class="ml-1.5 font-mono text-[10px] text-neutral-dim">{{ suffix }}</span>
    </span>
    <span
      v-if="!row.inContext && !row.shadowed"
      class="shrink-0 font-mono text-[10px] text-neutral-faint"
    >{{ t('panel.trace.notInContext') }}</span>
    <!-- SESSION 行溯源链接（§3.1 样例 5）：parentSession 两形态由 useTraceJump 编排解析。
         stopPropagation：链接点击不触发行选中。 -->
    <Button
      v-if="row.kind === 'SESSION' && row.meta.parentSession"
      variant="ghost"
      size="sm"
      class="h-4 shrink-0 gap-0.5 px-1 text-[10px] text-accent hover:bg-surface-2 hover:underline"
      data-testid="trace-row-jump-parent"
      :title="t('panel.trace.jumpParentTitle')"
      @click.stop="emit('jump-parent', row)"
    >
      <GitFork class="size-3" />
      {{ t('panel.trace.jumpParent') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
/**
 * 单行渲染。headline/suffix 纯数据展示（core summarizeRow 产物 + 本层拼接的数据符号
 * 如 blocks 计数 / exit code），句子级文案（MALFORMED / 不进 context）走 t()——
 * 键内容收口在 trace-i18n 单元。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, GitFork } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { TraceRow } from '@xyz-agent/core/domain/session-trace'
import { KIND_BADGE_CLASS } from './trace-kind-style'

const props = defineProps<{
  row: TraceRow
  selected: boolean
  /** 子 block 展开态（仅 assistant 可展开行有意义）。 */
  expanded?: boolean
}>()

const emit = defineEmits<{
  select: [row: TraceRow]
  'jump-parent': [row: TraceRow]
  'toggle-expand': [row: TraceRow]
}>()

const { t } = useI18n()

/** 可展开 = assistant 且 content 为非空数组（展开内容抽取在 display items 层）。 */
const expandable = computed(() => {
  if (props.row.kind !== 'ASSISTANT') return false
  const content = (props.row.entry as { message?: { content?: unknown } } | undefined)?.message?.content
  return Array.isArray(content) && content.length > 0
})

/** 行 headline：空值兜底为 kind 标签（core 契约「空 headline 由 UI 以 kind 标签兜底」）。 */
const headline = computed(() => props.row.headline || props.row.kind)

/** ISO timestamp → HH:MM:SS（本地展示取字符串时间部分，避免时区换算引入的口径分裂）。 */
const time = computed(() => {
  const ts = props.row.timestamp
  if (!ts) return ''
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts)
  return m ? m[2] : ''
})

/** kind 特化 meta 后缀（数据符号：计数 / exit code；句子文案走 t()）。 */
const suffix = computed(() => {
  const m = props.row.meta
  switch (props.row.kind) {
    case 'ASSISTANT': {
      const parts: string[] = []
      if (m.thinkingBlocks) parts.push(`thinking×${m.thinkingBlocks}`)
      if (m.toolCalls) parts.push(`tool×${m.toolCalls}`)
      if (m.textBlocks) parts.push(`text×${m.textBlocks}`)
      return parts.join(' ')
    }
    case 'BASH': {
      const parts: string[] = []
      if (m.exitCode !== undefined) parts.push(`exit ${m.exitCode}`)
      if (m.cancelled) parts.push('cancelled')
      if (m.truncated) parts.push('truncated')
      if (m.excludeFromContext) parts.push(t('panel.trace.notInContextBash'))
      return parts.join(' · ')
    }
    case 'TOOL':
      return m.isError ? 'error' : m.isError === false ? 'ok' : ''
    case 'COMPACTED':
      return m.fromHook ? 'hook' : ''
    default:
      return ''
  }
})

/** 悬停提示：影子化 / 损坏行给排查线索（§3.1 失败路径恢复指引）。 */
const rowTitle = computed(() => {
  if (props.row.kind === 'MALFORMED') {
    return t('panel.trace.malformedHint', { line: props.row.lineNumber ?? 0 })
  }
  if (props.row.shadowed) return t('panel.trace.shadowedHint')
  return ''
})
</script>
