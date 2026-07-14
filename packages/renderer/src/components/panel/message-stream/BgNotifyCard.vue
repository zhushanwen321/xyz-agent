<template>
  <!--
    展示组件 · background subagent 完成通知卡片。
    渲染 pi-subagents 扩展经 sendMessage(customType:"subagent-bg-notify") 注入的完成通知。
    数据来源：notifier.ts 的 BgNotifyRecord（单条）或 {batch, items}（批量合并）。

    视觉定位：比 SystemNotice（弱化提示线）醒目，但弱于 user/assistant 气泡——
    体现"系统级异步通知"语义。卡片形态（带边框 + 浅底），区别于普通消息气泡。

    content（进 LLM context 的完整 result）与 details（UI 渲染用）分离：
    pi-subagents 的 content 含完整结果文本，details 含结构化 BgNotifyRecord。
    卡片优先用 details 渲染紧凑摘要，展开后显 content（LLM 看到的全文）。
  -->
  <div class="bg-notify-card flex flex-col gap-1.5 rounded-md border px-3 py-2"
    :class="cardClass"
  >
    <!-- 批量：多条 record 各自一行 -->
    <div v-if="isBatch" class="flex flex-col gap-1">
      <div
        v-for="record in records"
        :key="record.id"
        class="flex items-center gap-1.5 font-mono text-[11.5px]"
        :class="recordTextClass(record)"
      >
        <component :is="recordIcon(record)" class="size-3 shrink-0" />
        <span class="font-semibold">{{ record.agent }}</span>
        <span v-if="record.model" class="text-subtle">· {{ record.model }}</span>
        <span v-if="elapsedLabel(record)" class="text-subtle">— {{ elapsedLabel(record) }}</span>
      </div>
    </div>

    <!-- 单条：状态行 + 摘要 + 可展开详情 -->
    <div v-else class="flex flex-col gap-1">
      <div
        class="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[11.5px] transition-opacity hover:opacity-80"
        :class="single ? recordTextClass(single) : ''"
        :title="expanded ? t('panel.message.collapse') : t('panel.message.expand')"
        @click="expanded = !expanded"
      >
        <ChevronRight class="size-2.5 transition-transform" :class="expanded ? 'rotate-90' : ''" />
        <component v-if="single" :is="recordIcon(single)" class="size-3 shrink-0" />
        <span v-if="single" class="font-semibold">{{ single.agent }}</span>
        <span v-if="single?.model" class="text-subtle">· {{ single.model }}</span>
        <span v-if="single && elapsedLabel(single)" class="text-subtle">— {{ elapsedLabel(single) }}</span>
      </div>

      <!-- 摘要首行（result/error，收起态可见一行） -->
      <p v-if="summaryLine" class="pl-4 text-[12px] leading-snug text-muted line-clamp-1">{{ summaryLine }}</p>

      <!-- 展开详情：完整 content + patchFile 提示 -->
      <template v-if="expanded">
        <div v-if="patchHint" class="ml-4 mt-0.5 rounded-sm border border-info/30 bg-info/5 px-2 py-1 font-mono text-[11px] text-info">
          {{ patchHint }}
        </div>
        <div v-if="fullContent" class="ml-4 max-h-[200px] overflow-y-auto whitespace-pre-wrap rounded-sm bg-surface-2/50 px-2 py-1 text-[11.5px] leading-relaxed text-muted">
          {{ fullContent }}
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, XCircle, Pause, ChevronRight } from '@lucide/vue'
import type { Component } from 'vue'
import type { BgNotifyRecord, Message } from '@xyz-agent/shared'

const { t } = useI18n()

const props = defineProps<{
  message: Message
}>()

/** 是否批量形态（{batch:true, items:[]}）。'batch' in d 是 TS 类型守卫（narrow 到批量分支），
 *  Array.isArray(d.items) 是运行时防御（展示组件不依赖上游 parseBgNotifyDetails 不变量）。 */
const isBatch = computed(() => {
  const d = props.message.bgNotify
  return !!d && 'batch' in d && Array.isArray(d.items)
})

/** 单条 record（非 batch 时取，batch 或缺失时返回 null） */
const single = computed<BgNotifyRecord | null>(() => {
  const d = props.message.bgNotify
  if (!d || 'batch' in d) return null
  return d
})

/** records 数组（batch 时取 items，单条时包一层数组便于统一渲染） */
const records = computed<BgNotifyRecord[]>(() => {
  const d = props.message.bgNotify
  if (!d) return []
  if ('batch' in d) return Array.isArray(d.items) ? d.items : []
  return [d]
})

/** 展开/收起态（仅单条形态用） */
const expanded = ref(false)

/** 卡片整体样式：按最差状态着色（批量取最差，单条取自身） */
const cardClass = computed(() => {
  const recs = records.value
  const hasFailed = recs.some((r) => r.status === 'failed')
  const hasCancelled = recs.some((r) => r.status === 'cancelled')
  if (hasFailed) {
    return 'border-danger/40 bg-[color-mix(in_oklch,var(--danger)_5%,transparent)]'
  }
  if (hasCancelled) {
    return 'border-muted/30 bg-muted/5'
  }
  return 'border-border bg-surface-hover/40'
})

/** 单条摘要首行（收起态可见）：done→result 首行，failed→error */
const summaryLine = computed(() => {
  const s = single.value
  if (!s) return ''
  if (s.status === 'failed') return s.error ?? ''
  if (s.status === 'cancelled') return t('panel.bgNotify.cancelled')
  return s.result ?? ''
})

/** 完整 content（展开后显示 LLM 看到的全文） */
const fullContent = computed(() => props.message.content || '')

/** patchFile 提示（fork+worktree 模式改动回传契约） */
const patchHint = computed(() => {
  const s = single.value
  if (!s?.patchFile) return ''
  return `改动以 patch 形式保存：${s.patchFile}（用 git apply 应用到当前仓库）`
})

/** record → 状态图标 */
function recordIcon(record: BgNotifyRecord): Component {
  if (record.status === 'failed') return XCircle
  if (record.status === 'cancelled') return Pause
  return CheckCircle2
}

/** record → 文字色（与图标语义一致） */
function recordTextClass(record: BgNotifyRecord): string {
  if (record.status === 'failed') return 'text-danger'
  if (record.status === 'cancelled') return 'text-muted'
  return 'text-fg'
}

/** record 耗时摘要（startedAt→endedAt 差值，秒；endedAt 缺失或异常返空串） */
function elapsedLabel(record: BgNotifyRecord): string {
  const MS_PER_SECOND = 1000
  const { startedAt, endedAt } = record
  if (typeof endedAt !== 'number' || endedAt <= startedAt) return ''
  return `${((endedAt - startedAt) / MS_PER_SECOND).toFixed(1)}s`
}
</script>
