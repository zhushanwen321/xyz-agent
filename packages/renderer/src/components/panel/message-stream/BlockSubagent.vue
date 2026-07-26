<template>
  <!--
    subagent 块（pi-subagents 的 "subagent" tool）：从 Block.vue 抽离，承载 subagent 渲染。
    draft-message-stream §4：紫色 Bot 图标 + agent 名 + task 预览，sync 模式 header 滚动进度。
    - failed 红框由外层 Block.vue 的 blockClass 作用在 trace-blk 根 div 上（保持抽离前 DOM 一致），
      本组件根 div 仅承载 trace-subagent 内容，不重复加红框。
    W2 纯结构抽离：所有 class 与抽离前 Block.vue 原样一致（零视觉变化），W3 再改视觉。
  -->
  <div class="trace-subagent">
    <div
      class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-opacity hover:opacity-80"
      :class="subagentHeaderColor"
      :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
      @click="toggleTool"
    >
      <ChevronRight class="size-2.5 shrink-0 transition-transform" :class="toolExpanded ? 'rotate-90' : ''" />
      <Bot class="size-3 shrink-0" />
      <span class="shrink-0 whitespace-nowrap">{{ t('panel.message.subagent') }}</span>
      <span class="shrink-0 normal-case tracking-normal text-neutral-mid">{{ subagentAgent || subagentHeaderLabel }}</span>
      <span v-if="subagentTask" class="min-w-0 normal-case tracking-normal text-neutral-dim truncate">· {{ subagentTaskPreview }}</span>
      <!-- 状态/进度（滚动更新）：sync running 显当前工具+turn+tokens -->
      <span v-if="isRunning" class="ml-0.5 inline-flex shrink-0 items-center gap-1 normal-case tracking-normal whitespace-nowrap text-reasoning">
        <span class="size-[6px] shrink-0 rounded-full bg-reasoning animate-working-pulse" />
        <span class="truncate">{{ subagentLiveInfo || t('panel.message.running') }}</span>
      </span>
      <Check v-else-if="!isFailed && !isUnfinished" class="ml-0.5 size-3 shrink-0 text-success" />
      <XCircle v-else-if="isFailed" class="ml-0.5 size-3 shrink-0 text-danger" />
      <span v-else-if="isUnfinished" class="ml-0.5 normal-case tracking-normal text-neutral-dim whitespace-nowrap">{{ t('panel.message.noResult') }}</span>
    </div>
    <template v-if="toolExpanded">
      <!-- sync 模式：progress 快照详情（toolCount/turn/tokens/duration）+ 最终输出 -->
      <div v-if="subagentProgressDetail" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-neutral-mid">
        <span v-if="subagentProgressDetail.toolCount != null" class="text-info">{{ t('panel.subagent.toolCount', { count: subagentProgressDetail.toolCount }) }}</span>
        <span v-if="subagentProgressDetail.turnCount != null">turn {{ subagentProgressDetail.turnCount }}</span>
        <span v-if="subagentProgressDetail.tokens != null">{{ formatTokens(subagentProgressDetail.tokens) }}</span>
        <span v-if="subagentProgressDetail.durationMs != null">{{ formatDuration(subagentProgressDetail.durationMs) }}</span>
        <span v-if="subagentProgressDetail.currentTool" class="truncate text-reasoning">→ {{ subagentProgressDetail.currentTool }}</span>
      </div>
      <!-- 最终输出 -->
      <div
        v-if="result"
        class="mt-1 inline-flex items-start gap-1 pl-0.5 font-mono text-[12px] leading-snug whitespace-pre-wrap"
        :class="isFailed ? 'border-l-2 border-danger pl-2 text-danger' : 'text-neutral-mid'"
      >
        <span>{{ result }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, ChevronRight, Check, XCircle } from '@lucide/vue'
import type { ToolCall } from '@xyz-agent/shared'

const { t } = useI18n()

const props = defineProps<{
  tool: ToolCall
  /** 所属 session（透传保留，当前 subagent 渲染未直接使用，向后兼容/未来扩展） */
  sessionId?: string | null
}>()

const isFailed = computed(() => props.tool.status === 'error')
const isRunning = computed(() => props.tool.status === 'running')
/** 流结束未收到 tool_call_end（进程崩溃/WS 断连/event-adapter 乱序丢消息）。
 *  诚实态，区别于 running（实时进行中）和 error（明确失败）——未收到结果不代表失败。 */
const isUnfinished = computed(() => props.tool.status === 'end_not_received')
const result = computed(() => props.tool.output)

/**
 * tool 折叠：默认 1 行收起（含 streaming/running 态——header 行已含摘要+状态指示，1 行即可观察进度，
 * 点击才展开详情）。仅 failed 强制展开（错误须直视，不可收起）。
 */
const toolCollapsed = ref(true)
const toolExpanded = computed(() => isFailed.value || !toolCollapsed.value)

function toggleTool(): void {
  toolCollapsed.value = !toolCollapsed.value
}

/** subagent input 的 agent / task（single 模式）。
 *  parallel(chain 模式 input 有 tasks/chain 数组，取首项摘要。 */
const subagentAgent = computed(() => {
  const input = props.tool.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.agent === 'string') return input.agent
  // parallel/chain：取数组首项 agent 名 + 数量
  const arr = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.chain) ? input.chain : null
  if (arr && arr.length > 0) {
    const first = arr[0] as Record<string, unknown> | undefined
    const firstName = first && typeof first.agent === 'string' ? first.agent : ''
    return arr.length > 1
      ? t('panel.subagent.multiSummary', { first: firstName, count: arr.length })
      : firstName
  }
  return ''
})

const subagentTask = computed(() => {
  const input = props.tool.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.task === 'string') return input.task
  const arr = Array.isArray(input.tasks) ? input.tasks : Array.isArray(input.chain) ? input.chain : null
  if (arr && arr.length > 0) {
    const first = arr[0] as Record<string, unknown> | undefined
    return first && typeof first.task === 'string' ? first.task : ''
  }
  return ''
})

/** task 描述截断长度（header 单行不撑爆） */
const TASK_PREVIEW_LIMIT = 48

/** header 行 task 预览（截断，避免过长 task 描述撑爆 1 行） */
const subagentTaskPreview = computed(() => {
  const taskText = subagentTask.value.trim()
  if (taskText.length <= TASK_PREVIEW_LIMIT) return taskText
  return `${taskText.slice(0, TASK_PREVIEW_LIMIT)}…`
})

/** parallel/chain 无 agent 名时的兜底标签 */
const subagentHeaderLabel = computed(() => {
  const input = props.tool.input as Record<string, unknown> | undefined
  if (Array.isArray(input?.tasks) || Array.isArray(input?.chain)) return t('panel.message.multiSubagent')
  return ''
})

/** progress 快照（单一 computed，liveInfo 与展开体详情共用，避免重复提取）。
 *  数据源：ToolCall.detail（chat-message-effects tool_call_update 写入的 AgentProgress 快照）。
 *  pi-subagents 推送的 partialResult 是 { details: { progress: AgentProgress[] } }，
 *  event-adapter 提取后存入 detail。取 progress[0]（single 模式首项）。 */
const subagentProgressDetail = computed(() => extractProgressSnapshot(props.tool.detail))

/**
 * sync 模式运行中的实时进度文本（滚动更新，header 单行展示）。
 * 从 subagentProgressDetail 提取当前工具/turn/tokens 拼接，每次 update 快照刷新滚动。
 */
const subagentLiveInfo = computed(() => {
  if (!isRunning.value) return ''
  const progress = subagentProgressDetail.value
  if (!progress) return ''
  const parts: string[] = []
  if (progress.currentTool) {
    parts.push(`${progress.currentTool}`)
  }
  if (progress.turnCount != null) parts.push(`turn ${progress.turnCount}`)
  if (progress.tokens != null) parts.push(formatTokens(progress.tokens))
  return parts.join(' · ')
})

/** 从 detail 提取 AgentProgress 快照。
 *  detail 可能形态：{ progress: AgentProgress[] }（pi-subagents partialResult.details）
 *  或直接是 AgentProgress 对象（其他 extension 推送形态），防御性两种都试。 */
function extractProgressSnapshot(detail: unknown): Record<string, unknown> | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  // 形态 1：{ progress: [...] } —— pi-subagents 的 partialResult.details.progress 数组
  if (Array.isArray(d.progress) && d.progress.length > 0) {
    return d.progress[0] as Record<string, unknown>
  }
  // 形态 2：直接是 AgentProgress（含 currentTool/turnCount/tokens 等字段）
  if ('currentTool' in d || 'turnCount' in d || 'tokens' in d || 'toolCount' in d) {
    return d
  }
  return null
}

/** token / 时长格式化阈值 */
const TOKEN_K = 1000
const TOKEN_M = 1000000
const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60000

/** 格式化 token 数（1000→1k，1000000→1M）。接受 unknown（progress 快照字段类型宽松） */
function formatTokens(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n >= TOKEN_M) return `${(n / TOKEN_M).toFixed(1)}M tokens`
  if (n >= TOKEN_K) return `${(n / TOKEN_K).toFixed(1)}k tokens`
  return `${n} tokens`
}

/** 格式化时长（ms→s/min）。接受 unknown（progress 快照字段类型宽松） */
function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (ms >= MS_PER_MINUTE) return `${(ms / MS_PER_MINUTE).toFixed(1)}min`
  if (ms >= MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(0)}s`
  return `${ms}ms`
}

/** subagent header 颜色：failed→danger，其余→reasoning(紫) */
const subagentHeaderColor = computed(() => {
  if (isFailed.value) return 'text-danger'
  return 'text-reasoning'
})

</script>
