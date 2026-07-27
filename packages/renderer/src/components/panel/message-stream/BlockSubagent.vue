<template>
  <!--
    subagent 块（pi-subagents 的 "subagent" tool）：从 Block.vue 抽离，承载 subagent 渲染。
    Demo H 视觉：去卡片化（users ICON + SUBAGENT. prefix + 左缩进 14px + 底部 dashed 分割），
    running 用双环 loader（accent 蓝，去 reasoning 紫），failed hover 才显 warn 暖橙。
    - 用户可见断言：header 含 users ICON + 'subagent' prefix（CSS 大写 SUBAGENT.）+ agent 名 + task 预览。
    - sync 模式 header 滚动进度（currentTool/turn/tokens）。
    - failed：错误摘要进 body 文本（中性灰 border-l），hover 染 warn（不再鲜红）。
  -->
  <div class="trace-subagent border-b border-dashed border-border pb-2.5 mb-0.5" data-testid="subagent-block">
    <div
      class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[13px] font-medium transition-opacity hover:opacity-80"
      :class="subagentHeaderColor"
      :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
      @click="toggleTool"
    >
      <ChevronRight class="size-3 shrink-0 transition-transform text-neutral-mid" :class="toolExpanded ? 'rotate-90' : ''" />
      <!-- running 态 loader（双环 + accent），其余走 users ICON -->
      <span v-if="isRunning" class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" /> <!-- eslint-disable-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
      <component :is="BLOCK_ICON_LUCIDE.subagent" v-else class="size-[13px] shrink-0 text-neutral-ico hover:text-neutral-ico-hover" :class="isFailed ? 'hover:text-warn' : ''" />
      <span class="subagent-tag shrink-0 whitespace-nowrap uppercase tracking-[0.08em] font-semibold text-[12px] text-neutral-fg font-mono">subagent</span>
      <span class="shrink-0 whitespace-nowrap text-neutral-mid">{{ subagentAgent || subagentHeaderLabel }}</span>
      <span v-if="subagentTask" class="min-w-0 truncate text-neutral-dim">· {{ subagentTaskPreview }}</span>
      <!-- 状态/进度（滚动更新）：sync running 显当前工具+turn+tokens -->
      <span v-if="isRunning" class="ml-0.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-accent">
        <span class="truncate">{{ subagentLiveInfo || t('panel.message.running') }}</span>
      </span>
      <!-- completed 态：显示 progress metadata（turn/tokens/duration） -->
      <template v-else-if="!isFailed && !isUnfinished">
        <span v-if="subagentCompletedMeta" class="shrink-0 text-neutral-dim">{{ subagentCompletedMeta }}</span>
        <Check class="ml-0.5 size-3 shrink-0 text-neutral-mid" />
      </template>
      <span v-else-if="isUnfinished" class="ml-0.5 whitespace-nowrap text-neutral-dim">{{ t('panel.message.noResult') }}</span>
    </div>
    <template v-if="toolExpanded">
      <!-- sync 模式：progress 快照详情（toolCount/turn/tokens/duration）+ 最终输出 -->
      <div v-if="subagentProgressDetail" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-neutral-mid">
        <span v-if="subagentProgressDetail.toolCount != null" class="text-neutral-fg">{{ t('panel.subagent.toolCount', { count: subagentProgressDetail.toolCount }) }}</span>
        <span v-if="subagentProgressDetail.turnCount != null">turn {{ subagentProgressDetail.turnCount }}</span>
        <span v-if="subagentProgressDetail.tokens != null">{{ formatTokens(subagentProgressDetail.tokens) }}</span>
        <span v-if="subagentProgressDetail.durationMs != null">{{ formatDuration(subagentProgressDetail.durationMs) }}</span>
        <span v-if="subagentProgressDetail.currentTool" class="truncate text-neutral-mid">→ {{ subagentProgressDetail.currentTool }}</span>
      </div>
      <!-- 最终输出：copy 按钮在左上角（border-l 旁） -->
      <div v-if="result" class="group/result relative mt-1">
        <Button
          variant="ghost"
          size="icon"
          class="absolute top-0 left-0 size-5 rounded-sm text-neutral-dim opacity-0 transition-opacity hover:text-neutral-fg group-hover/result:opacity-100"
          :title="t('panel.message.copy')"
          @click.stop="copy(result, `subagent-${tool.id}`)"
        >
          <Check v-if="copied === `subagent-${tool.id}`" class="size-3 text-success" />
          <CopyIcon v-else class="size-3" />
        </Button>
        <div
          class="subagent-result select-text border-l-2 border-neutral-faint pl-6 font-mono text-[12px] leading-snug"
          :class="isFailed ? 'text-neutral-mid hover:border-warn hover:text-neutral-fg' : 'text-neutral-mid'"
        >
          <template v-if="parsedSubagentOutput">
            <span class="whitespace-pre-wrap">{{ parsedSubagentOutput.summary }}</span>
            <div v-if="parsedSubagentOutput.stats.length" class="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-neutral-dim">
              <span v-for="(stat, i) in parsedSubagentOutput.stats" :key="i">{{ stat }}</span>
            </div>
          </template>
          <span v-else class="whitespace-pre-wrap select-text">{{ result }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy as CopyIcon, ChevronRight, Check } from '@lucide/vue'
import type { ToolCall } from '@xyz-agent/shared'
import { BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG } from './block-icon'
import { formatTokens, formatDuration } from './format-utils'
import { Button } from '@/components/ui/button'
import { useCopy } from '@/composables/effects/useCopy'

const { t } = useI18n()
const { copied, copy } = useCopy()

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
 *  detail 可能形态：{ progress: AgentProgress[] }（pi-subagents partialResult.details.progress 数组）
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

/** Demo H：subagent header 色——failed 改中性灰（hover 染 warn，由 subagent-block hover 处理），
 *  其余中性 fg（去 reasoning 紫）。running 由 loader + accent 文案表达，header 整体仍中性。 */
const subagentHeaderColor = computed(() => {
  if (isFailed.value) return 'text-neutral-mid'
  return 'text-neutral-fg'
})

/** completed 态 progress metadata（turn/tokens/duration），与 running 态 liveInfo 对称 */
const subagentCompletedMeta = computed(() => {
  const progress = subagentProgressDetail.value
  if (!progress) return ''
  const parts: string[] = []
  if (progress.turnCount != null) parts.push(`turn ${progress.turnCount}`)
  if (progress.tokens != null) parts.push(formatTokens(progress.tokens as number))
  if (progress.durationMs != null) parts.push(formatDuration(progress.durationMs as number))
  return parts.join(' · ')
})

/** 尝试解析 subagent output 为结构化信息（JSON → summary + stats，纯文本 → null） */
const parsedSubagentOutput = computed(() => {
  const raw = result.value?.trim()
  if (!raw) return null
  // 尝试 JSON parse（pi-subagents 可能返回结构化结果）
  try {
    const data = JSON.parse(raw)
    if (typeof data === 'object' && data !== null) {
      const summary = data.summary ?? data.result ?? data.message ?? ''
      const stats: string[] = []
      if (data.filesChanged != null) stats.push(`${data.filesChanged} files`)
      if (data.linesAdded != null) stats.push(`+${data.linesAdded}`)
      if (data.linesRemoved != null) stats.push(`-${data.linesRemoved}`)
      if (data.testsPassed != null) stats.push(`${data.testsPassed} tests`)
      if (summary) return { summary: String(summary), stats }
    }
  } catch { /* output is plain text, not JSON — expected for most subagent results */ return null }
  // 纯文本：直接返回，不结构化
  return null
})
</script>

<style scoped>
/* Demo H 去卡片化：subagent-tag ::after accent 蓝点。
   Tailwind 无法表达 ::after content，走 scoped style（三层结构 escape hatch）。
   源码写小写 subagent，渲染自动大写 SUBAGENT（CSS text-transform）。 */
.subagent-tag::after {
  content: '';
  display: inline-block;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
  margin-left: 5px;
  vertical-align: middle;
}
</style>
