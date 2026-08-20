<template>
  <!--
    展示组件 · trace-inspector（session-trace D5b：drawer 临时上下文页）。
    选中 trace 行才切入（PanelContainer default slot v-if chain 最前），不占一级 tab 位
    （SideDrawerTab 体系不变）；顶部「← 返回」清除选中 → 复原前 tab 内容（activeTab 未被
    改过，单向 main→drawer）。内容按 kind 分支（§3.4「展开详情」列）：
    消息类文本/逐 block、工具完整输出、压缩 summary 全文、SYSTEM 留痕全文、
    其余原始 JSON 兜底（G1：任何 entry 详情不丢信息）。
  -->
  <div v-if="row" class="flex h-full min-h-0 flex-col" data-testid="trace-inspector">
    <!-- head：返回 + kind badge + 定位 -->
    <div class="flex flex-shrink-0 items-center gap-2 border-b border-hairline px-2.5 py-2">
      <Button
        variant="ghost"
        size="sm"
        class="h-5 gap-1 px-1.5 text-[11px] text-neutral-dim hover:text-neutral-fg"
        data-testid="trace-inspector-back"
        @click="clearTraceSelection(props.sessionId)"
      >
        <ArrowLeft class="size-3" />
        {{ t('panel.trace.inspectorBack') }}
      </Button>
      <span
        class="shrink-0 rounded px-1.5 py-px font-mono text-[10px] tracking-wide"
        :class="kindBadgeClass"
      >{{ row.kind }}</span>
      <span class="min-w-0 truncate font-mono text-[11px] text-neutral-fg">#{{ row.seq }}<template v-if="time"> · {{ time }}</template></span>
    </div>
    <!-- sub：来源说明 -->
    <p class="flex-shrink-0 px-2.5 pb-1.5 pt-1 text-[11px] text-neutral-faint">{{ t('panel.trace.inspectorSubtitle') }}</p>
    <!-- body：kind 分支详情 -->
    <div class="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4" data-testid="trace-inspector-body">
      <!-- 损坏行恢复指引（§3.1）：打开 JSONL 所在目录（通道待常驻扩展接线，先置灰收口文案） -->
      <div
        v-if="row.kind === 'MALFORMED'"
        class="mb-2 flex flex-wrap items-center gap-2 rounded-sm border border-hairline bg-bg-input px-2.5 py-2"
        data-testid="trace-malformed-actions"
      >
        <Button
          variant="ghost"
          size="sm"
          disabled
          class="h-5 gap-1 px-1.5 text-[11px] text-neutral-dim"
        >
          <FolderOpen class="size-3" />
          {{ t('panel.trace.malformedOpenDir') }}
        </Button>
        <span class="min-w-0 flex-1 text-[11px] text-neutral-faint">{{ t('panel.trace.malformedHint', { line: row.lineNumber ?? 0 }) }}</span>
      </div>
      <!-- 消息类：USER / NOTICE(role=custom) 文本全文 -->
      <pre v-if="preText !== null" class="mb-2 overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-input p-2.5 font-mono text-[11px] leading-relaxed text-neutral-mid">{{ preText }}</pre>
      <!-- ASSISTANT：逐 content block -->
      <div v-if="blocks.length > 0" class="mb-2 flex flex-col gap-1" data-testid="trace-inspector-blocks">
        <div
          v-for="(block, i) in blocks"
          :key="i"
          class="flex items-center gap-2 rounded-sm px-1.5 py-1 text-[11px] text-neutral-mid hover:bg-surface-2"
        >
          <span class="w-14 flex-shrink-0 font-mono text-[10px] text-neutral-faint">{{ block.type }}</span>
          <span class="min-w-0 flex-1 truncate" :class="block.type === 'thinking' ? 'text-reasoning' : ''">{{ block.preview }}</span>
        </div>
      </div>
      <!-- meta kv（kind 特化字段：exitCode/tokensBefore/version/…） -->
      <div class="mb-2 flex flex-col gap-1.5">
        <div v-for="kv in detailKv" :key="kv.k" class="flex items-baseline gap-2 text-[11px]">
          <span class="w-20 flex-shrink-0 text-neutral-faint">{{ kv.k }}</span>
          <span class="min-w-0 break-all font-mono text-[11px] text-neutral-mid" :class="kv.tone === 'bad' ? 'text-danger' : kv.tone === 'ok' ? 'text-success' : ''">{{ kv.v }}</span>
        </div>
      </div>
      <!-- 原始 entry JSON（通用兜底，G1 不丢信息；MALFORMED 行 raw 原文） -->
      <p class="mb-1 text-[10px] uppercase tracking-wide text-neutral-faint">{{ t('panel.trace.inspectorRaw') }}</p>
      <pre class="overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-input p-2.5 font-mono text-[10px] leading-relaxed text-neutral-dim">{{ rawJson }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * inspector 详情渲染。数据源 = useTraceRows 共享派生（与 TraceView 同源，选中行按
 * partition.selectedKey 查找）。结构：preText（文本全文）/ blocks（assistant 逐块）/
 * detailKv（kind 特化标量）/ rawJson（原始 entry 兜底）四层，按 kind 填充。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, FolderOpen } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { TraceRow } from '@xyz-agent/core/domain/session-trace'
import { useTraceRows } from '@/composables/features/trace/useTraceRows'
import { clearTraceSelection, useSessionTrace } from '@/composables/features/trace/useSessionTrace'
import { KIND_BADGE_CLASS } from './trace-kind-style'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const { partition } = useSessionTrace()
const rows = useTraceRows()

/** 选中行（selectedKey → rows 查找；分区切换/选中清除时为 null → 本组件整体不渲染）。 */
const row = computed<TraceRow | null>(() => {
  const key = partition.value.selectedKey
  if (!key) return null
  return rows.value.find((r) => r.key === key) ?? null
})

const kindBadgeClass = computed(() => (row.value ? KIND_BADGE_CLASS[row.value.kind] : ''))

const time = computed(() => {
  const ts = row.value?.timestamp
  if (!ts) return ''
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts)
  return m ? m[2] : ''
})

/** content 中第一段长文本（USER/NOTICE 文本全文，与 core firstText 语义一致但保留全文）。 */
function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
      .map((b) => String((b as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  return ''
}

/** 文本全文层（USER / NOTICE / COMPACTED summary / BRANCH summary / SYSTEM 留痕全文 / MALFORMED raw）。 */
const preText = computed<string | null>(() => {
  const r = row.value
  if (!r) return null
  if (r.kind === 'MALFORMED') return r.raw ?? null
  if (r.kind === 'USER') return textContent((r.entry as { message?: { content?: unknown } })?.message?.content) || null
  if (r.kind === 'NOTICE') {
    const entry = r.entry
    if (entry?.type === 'custom_message') {
      const c = (entry as { content?: unknown }).content
      return typeof c === 'string' ? c : textContent(c) || null
    }
    if (entry?.type === 'message') {
      return textContent((entry as { message?: { content?: unknown } })?.message?.content) || null
    }
    return null
  }
  if (r.kind === 'COMPACTED' || r.kind === 'BRANCH') {
    const s = (r.entry as { summary?: unknown })?.summary
    return typeof s === 'string' && s ? s : null
  }
  if (r.kind === 'SYSTEM') {
    const data = (r.entry as { data?: { fullText?: unknown } })?.data
    const full = data && typeof data === 'object' ? data.fullText : undefined
    return typeof full === 'string' && full ? full : null
  }
  return null
})

/** assistant 逐 block 列表（type + 预览：thinking/text 正文、toolCall 工具名）。 */
const blocks = computed<{ type: string; preview: string }[]>(() => {
  const r = row.value
  if (!r || r.kind !== 'ASSISTANT') return []
  const content = (r.entry as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return []
  return content.map((b) => {
    if (typeof b !== 'object' || b === null) return { type: '?', preview: '' }
    const block = b as { type?: unknown; text?: unknown; thinking?: unknown; toolName?: unknown; toolCallId?: unknown }
    const type = String(block.type ?? '?')
    let preview = ''
    if (typeof block.text === 'string') preview = block.text
    else if (typeof block.thinking === 'string') preview = block.thinking
    else if (typeof block.toolName === 'string') preview = `${block.toolName}${block.toolCallId ? ` → ${block.toolCallId}` : ''}`
    return { type, preview: preview.split('\n')[0] ?? '' }
  })
})

/** kind 特化标量 kv（从 row.meta 取值——core summarizeRow 提取的 SSOT，不二次解析 entry）。 */
const detailKv = computed<{ k: string; v: string; tone?: 'ok' | 'bad' }[]>(() => {
  const r = row.value
  if (!r) return []
  const out: { k: string; v: string; tone?: 'ok' | 'bad' }[] = []
  const m = r.meta
  const push = (k: string, v: unknown, tone?: 'ok' | 'bad') => {
    if (v !== undefined && v !== '') out.push({ k, v: String(v), tone })
  }
  push('id', r.entry && 'id' in r.entry ? (r.entry as { id?: unknown }).id : undefined)
  push('parentId', r.entry && 'parentId' in r.entry ? (r.entry as { parentId?: unknown }).parentId : undefined)
  switch (r.kind) {
    case 'ASSISTANT':
      push('model', m.model)
      push('provider', m.provider)
      push('stopReason', m.stopReason)
      break
    case 'TOOL':
      push('toolName', m.toolName)
      push('toolCallId', m.toolCallId)
      if (m.isError === true) push('result', 'error', 'bad')
      else if (m.isError === false) push('result', 'ok', 'ok')
      break
    case 'BASH':
      push('command', m.command)
      if (m.exitCode !== undefined) push('exitCode', m.exitCode, m.exitCode === 0 ? 'ok' : 'bad')
      push('cancelled', m.cancelled)
      push('truncated', m.truncated)
      push('fullOutputPath', m.fullOutputPath)
      push('excludeFromContext', m.excludeFromContext)
      break
    case 'COMPACTED':
      push('tokensBefore', m.tokensBefore)
      push('firstKeptEntryId', m.firstKeptEntryId)
      push('fromHook', m.fromHook)
      break
    case 'BRANCH':
      push('fromId', m.fromId)
      break
    case 'SYSTEM':
      push('version', m.version)
      push('reason', m.reason)
      push('hash', m.hash)
      push('charCount', m.charCount)
      break
    case 'SESSION':
      push('cwd', m.cwd)
      push('parentSession', m.parentSession)
      push('forkEntryId', m.forkEntryId)
      break
    case 'BOUNDARY':
      push('outcome', m.outcome)
      push('reason', m.reason)
      push('handedOffTo', m.handedOffTo)
      break
    default:
      push('customType', m.customType)
      break
  }
  // context 语义标注（§3.4：全量态下不进 context 的 kind 弱标记；影子化给排查线索）
  if (r.shadowed) out.push({ k: 'context', v: t('panel.trace.shadowedHint') })
  else if (!r.inContext) out.push({ k: 'context', v: t('panel.trace.notInContext') })
  return out
})

/** JSON.stringify 缩进宽度（原始 entry 兜底展示）。 */
const JSON_INDENT = 2

/** 原始 entry JSON（COMPACTED summary / SYSTEM 全文等长文本也兜底可见）。 */
const rawJson = computed(() => {
  const r = row.value
  if (!r) return ''
  return JSON.stringify(r.entry ?? { raw: r.raw }, null, JSON_INDENT)
})
</script>
