<template>
  <!--
    展示组件 · trace 块（message-stream 折叠区内的单个块）。
    draft-message-stream §4：thinking(紫斜体) / tool_call(青色 mono) / 中间 output text(下划线行)。
    - thinking：header 可点击 toggle，长块独立再折叠，默认收起。
    - tool：默认 1 行收起（streaming/running 也收起，header 含 toolName+argPath 摘要+状态指示），
            点击展开详情。仅 failed 强制展开（错误须直视）。
    - subagent（pi-subagents 的 "subagent" tool）：独立样式（紫色 Bot 图标），sync 模式 header
            滚动显示当前工具/turn/tokens（从 detail progress 快照提取），async 模式显派发/完成/失败态。
    - tool 失败：整块红框（danger 边 + 淡红底）。
    审批按钮 DEFERRED（G-018），v1 不渲染。
  -->
  <div class="trace-blk py-2" :class="blockClass">
    <!-- thinking 块：header 可点击 toggle，长 reasoning 独立再折叠（本地折叠态，由 collapsed prop 初始化） -->
    <div v-if="type === 'thinking'" class="trace-think">
      <div
        class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-reasoning transition-colors hover:text-[var(--reasoning)]"
        :title="thinkingExpanded ? t('panel.message.collapseReasoning') : t('panel.message.expandReasoning')"
        @click="toggleThinking"
      >
        <ChevronRight class="size-2.5 shrink-0 transition-transform" :class="thinkingExpanded ? 'rotate-90' : ''" />
        <Brain class="size-3 shrink-0" />
        <span class="shrink-0 whitespace-nowrap">{{ t('panel.message.thinkingBlock') }}</span>
        <span v-if="!thinkingExpanded" class="ml-0.5 min-w-0 truncate text-muted">· {{ previewText }}</span>
      </div>
      <!-- text-[12px] 对齐 tool 详情字号；去 italic（md 结构+全局 italic 可读性差，由 thinking variant 降级样式表达次要语义） -->
      <div v-if="thinkingExpanded" class="trace-think-body mt-1 text-[12px] leading-relaxed text-muted">
        <MarkdownRenderer :content="content ?? ''" :session-id="sessionId ?? undefined" variant="thinking" />
      </div>
    </div>

    <!-- 中间产出 text 块（draft §4 Output Text 中间：折进执行流程，下划线行，markdown 渲染）。
         streaming 光标已移到 Turn.vue trace 末尾（保证永远在最后一行，不受 contentBlocks 时序影响）。 -->
    <div v-else-if="type === 'text'" class="border-b border-dashed border-border pb-2 text-[12.5px] leading-relaxed text-muted">
      <MarkdownRenderer :content="content ?? ''" :session-id="sessionId ?? undefined" />
    </div>

    <!-- tool_call 块：默认 1 行收起（streaming/running 也收起），header 含摘要，点击展开详情。
         subagent（pi-subagents 的 "subagent" tool）用独立样式：紫色 Subagent 行，sync 模式滚动进度。 -->
    <div v-else class="trace-tool">
      <!-- ── subagent 块：独立样式（紫色，Bot 图标，与思考块同语义族）── -->
      <div v-if="isSubagent" class="trace-subagent">
        <div
          class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-opacity hover:opacity-80"
          :class="subagentHeaderColor"
          :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
          @click="toggleTool"
        >
          <ChevronRight class="size-2.5 shrink-0 transition-transform" :class="toolExpanded ? 'rotate-90' : ''" />
          <Bot class="size-3 shrink-0" />
          <span class="shrink-0 whitespace-nowrap">{{ t('panel.message.subagent') }}</span>
          <span class="shrink-0 normal-case tracking-normal text-muted">{{ subagentAgent || subagentHeaderLabel }}</span>
          <span v-if="subagentTask" class="min-w-0 normal-case tracking-normal text-subtle truncate">· {{ subagentTaskPreview }}</span>
          <!-- 状态/进度（滚动更新）：sync running 显当前工具+turn+tokens -->
          <span v-if="isRunning" class="ml-0.5 inline-flex shrink-0 items-center gap-1 normal-case tracking-normal whitespace-nowrap text-reasoning">
            <span class="size-[6px] shrink-0 rounded-full bg-reasoning animate-working-pulse" />
            <span class="truncate">{{ subagentLiveInfo || t('panel.message.running') }}</span>
          </span>
          <Check v-else-if="!isFailed && !isUnfinished" class="ml-0.5 size-3 shrink-0 text-success" />
          <XCircle v-else-if="isFailed" class="ml-0.5 size-3 shrink-0 text-danger" />
          <span v-else-if="isUnfinished" class="ml-0.5 normal-case tracking-normal text-subtle whitespace-nowrap">{{ t('panel.message.noResult') }}</span>
        </div>
        <template v-if="toolExpanded">
          <!-- sync 模式：progress 快照详情（toolCount/turn/tokens/duration）+ 最终输出 -->
          <div v-if="subagentProgressDetail" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted">
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
            :class="isFailed ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'"
          >
            <span>{{ result }}</span>
          </div>
        </template>
      </div>

      <!-- ── 普通 tool 块：1 行收起（header 含 toolName+argPath 摘要+状态），点击展开详情 ── -->
      <div v-else>
        <div
          data-testid="tool-block-header"
          class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-opacity hover:opacity-80"
          :class="isFailed ? 'text-danger' : isUnfinished ? 'text-subtle' : 'text-info'"
          :title="toolExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
          @click="toggleTool"
        >
          <ChevronRight class="size-2.5 shrink-0 transition-transform" :class="toolExpanded ? 'rotate-90' : ''" />
          <Wrench class="size-3 shrink-0" />
          <span class="shrink-0 normal-case tracking-normal">{{ toolName }}</span>
          <span v-if="argPath" class="min-w-0 normal-case tracking-normal text-subtle truncate">· {{ argPath }}</span>
          <!-- 状态指示：running 脉冲点 / completed Check 图标 / failed XCircle 图标 -->
          <span v-if="isRunning" class="ml-0.5 inline-flex shrink-0 items-center gap-0.5 normal-case tracking-normal whitespace-nowrap text-accent">
            <span class="size-[6px] shrink-0 rounded-full bg-accent animate-working-pulse" />{{ t('panel.message.inProgress') }}
          </span>
          <Check v-else-if="!isFailed && !isUnfinished && result" class="ml-0.5 size-3 shrink-0 text-success" />
          <XCircle v-else-if="isFailed" class="ml-0.5 size-3 shrink-0 text-danger" />
          <span v-else-if="isUnfinished" class="ml-0.5 normal-case tracking-normal text-subtle whitespace-nowrap">{{ t('panel.message.noResult') }}</span>
        </div>
        <template v-if="toolExpanded">
          <!-- 补充细节条：失败错误摘要 + 行数/字符数 + 耗时。对齐 subagent 展开体信息架构 -->
          <div v-if="metaItems.length" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <span
              v-for="(item, idx) in metaItems"
              :key="idx"
              :class="{
                'text-danger font-semibold': item.tone === 'danger',
                'text-info': item.tone === 'info',
                'text-muted': item.tone === 'muted',
              }"
            >{{ item.text }}</span>
          </div>
          <!-- 结果区：无 Check/XCircle 图标（header 状态指示已覆盖） -->
          <div
            v-if="result"
            class="mt-1 font-mono text-[12px] leading-snug whitespace-pre-wrap"
            :class="isFailed ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'"
          >
            <GuiComponentRenderer v-if="guiComponent" :component="guiComponent" />
            <AnsiText v-else-if="outputRaw" :content="outputRaw" />
            <span v-else>{{ result }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, Brain, ChevronRight, Check, Wrench, XCircle } from '@lucide/vue'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import { extractGui } from '@xyz-agent/extension-protocol'
import type { ToolCall } from '@xyz-agent/shared'
import { SUBAGENT_TOOL_NAMES } from '@xyz-agent/shared'
import AnsiText from './gui/AnsiText.vue'
import GuiComponentRenderer from './GuiComponentRenderer.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'

const { t } = useI18n()

const props = defineProps<{
  type: 'thinking' | 'tool' | 'text'
  /** thinking / text 内容 */
  content?: string
  /** tool_call 数据（type==='tool' 时必填） */
  tool?: ToolCall
  /** thinking 块初始折叠态（来自 ThinkingBlock.collapsed，默认收起） */
  collapsed?: boolean
  /** working 态（turn 进行中）：thinking 强制全展开且不可手动收（draft §1 无背景下划线展开）。
   *  tool 块不再因 working 强制展开（改后 streaming 态也 1 行收起，header 自带状态指示）。 */
  working?: boolean
  /** @deprecated streaming 光标已移到 Turn.vue trace 末尾独立元素（streaming-tail），
   *  保证永远在最后一行。此 prop 保留向后兼容，不再被驱动（Turn.vue 不再传入 true）。 */
  streaming?: boolean
  /** 所属 session（透传给 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
}>()

/* ── thinking 折叠：working 态强制展开且不可收（draft §1）；非 working 由本地态 toggle ── */
const thinkingCollapsed = ref(props.collapsed ?? true)
const thinkingExpanded = computed(() => props.working || !thinkingCollapsed.value)

function toggleThinking(): void {
  if (props.working) return
  thinkingCollapsed.value = !thinkingCollapsed.value
}

/** 收起态的正文预览（截断，draft：收起时显一行摘要） */
const PREVIEW_LIMIT = 60
const previewText = computed(() => {
  const c = props.content?.trim() ?? ''
  if (c.length <= PREVIEW_LIMIT) return c
  return `${c.slice(0, PREVIEW_LIMIT)}…`
})

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')
/** 流结束未收到 tool_call_end（进程崩溃/WS 断连/event-adapter 乱序丢消息）。
 *  诚实态，区别于 running（实时进行中）和 error（明确失败）——未收到结果不代表失败。 */
const isUnfinished = computed(() => props.tool?.status === 'end_not_received')
const toolName = computed(() => props.tool?.toolName ?? 'tool')
const result = computed(() => props.tool?.output)
/** 原始 ANSI 文本（未经 stripAnsi）。有此字段时用 AnsiText 渲染着色，无则回退 output 纯文本。 */
const outputRaw = computed(() => props.tool?.outputRaw)
/** 补充细节条 meta 项：耗时 + 工具特化信息（read/bash 的输出行数、read 字符数）。
 *  - 耗时：startTime→endTime，数据源已就绪。
 *  - 行数/字符数：pi 协议不返回文件元信息（exit code / fileSize 均无），前端从 output 文本自算。
 *    read 工具的 output 是文件内容，行数/字符数有统计意义；bash 的 output 是命令输出，行数有参考价值；
 *    edit/write 等 output 是简短确认（如 "done"），行数无意义不展示。
 *  exit code / 测试数等无法从 output 可靠提取（pi 不返回数值 exit code），不做。
 *  失败态首项（错误性质）用 danger 色强调。 */
const OUTPUT_META_TOOLS = new Set(['read', 'bash', 'cat', 'glob', 'grep', 'list'])

interface MetaItem {
  /** 高亮态：failed 首项用 danger，普通信息用 info（蓝），其余默认 muted */
  tone: 'danger' | 'info' | 'muted'
  text: string
}

/** 错误摘要截断长度（细节条单行不撑爆） */
const ERROR_SUMMARY_LIMIT = 40
/** 字符数格式化阈值（>= 此值显示为 XK chars） */
const CHAR_K_THRESHOLD = 1000

const metaItems = computed<MetaItem[]>(() => {
  const items: MetaItem[] = []
  // 失败态首项：错误定性（从 error/output 首行提取一句话）
  if (isFailed.value) {
    const errText = (props.tool?.error ?? props.tool?.output ?? '').trim()
    if (errText) {
      const firstLine = errText.split('\n')[0].trim()
      items.push({
        tone: 'danger',
        text: firstLine.length > ERROR_SUMMARY_LIMIT ? `${firstLine.slice(0, ERROR_SUMMARY_LIMIT)}…` : firstLine,
      })
    }
  }
  // 工具特化：行数/字符数（仅 read/bash 等输出有统计意义的工具）
  const name = toolName.value
  const output = props.tool?.output ?? ''
  if (OUTPUT_META_TOOLS.has(name) && output.trim()) {
    const lineCount = output.split('\n').length
    items.push({ tone: 'muted', text: `${lineCount} 行` })
    // read/cat 额外显示字符数（文件内容大小有参考价值）
    if (name === 'read' || name === 'cat') {
      items.push({ tone: 'muted', text: formatCharCount(output.length) })
    }
  }
  // 耗时（末位）
  const start = props.tool?.startTime
  const end = props.tool?.endTime
  if (typeof start === 'number' && typeof end === 'number' && end > start) {
    items.push({ tone: 'muted', text: formatDuration(end - start) })
  }
  return items
})

/** 字符数格式化：>= CHAR_K_THRESHOLD 显示为 XK chars，否则原值 + chars */
function formatCharCount(n: number): string {
  if (n >= CHAR_K_THRESHOLD) return `${(n / CHAR_K_THRESHOLD).toFixed(1)}K chars`
  return `${n} chars`
}

/**
 * 从 tool.details.__gui__ 提取结构化渲染组件（extension GUI 协议，spec §9.1）。
 * extension RPC 模式把 GuiComponent 放进 details.__gui__.component，前端用 extractGui
 * 统一校验版本后路由到 GuiComponentRenderer。无 __gui__ 时 undefined（走 AnsiText/纯文本兜底）。
 * 注：ToolCall 的结构化扩展数据存在 details 字段（pi tool_execution_end result.details）。
 *
 * streaming __gui__ 仅在 running 态有效——tool_call_end 后若 details 无 __gui__，
 * 不应回退到过期的 streaming detail（如 extension streaming 推了进度组件但最终返回纯文本）。
 * 否则已完成工具会错误显示 streaming 过程中的临时 GUI 组件。
 */
const guiComponent = computed<GuiComponent | undefined>(() => {
  // tool_call_end 的 details（复数，最终态）优先
  const fromEnd = extractGui(props.tool?.details)?.component
  if (fromEnd) return fromEnd
  // streaming 态 fallback：仅在 tool 仍在 running 时用 detail（单数）。
  // tool_call_end 后 detail 残留不应被当作渲染源（最终态无 __gui__ → 不渲染 GUI 组件）。
  if (isRunning.value) {
    const streamingDetail = props.tool?.detail
    if (typeof streamingDetail === 'object' && streamingDetail !== null) {
      return extractGui(streamingDetail)?.component
    }
  }
  return undefined
})

/**
 * tool 折叠：默认 1 行收起（含 streaming/running 态——改前 working/running 强制展开，
 * 改后 header 行已含摘要+状态指示，1 行即可观察进度，点击才展开详情）。
 * 仅 failed 强制展开（错误须直视，不可收起）。
 */
const toolCollapsed = ref(true)
const toolExpanded = computed(() => isFailed.value || !toolCollapsed.value)

function toggleTool(): void {
  toolCollapsed.value = !toolCollapsed.value
}

/**
 * 从 input 提取可读参数摘要（header 单行展示）。覆盖高频工具：
 * bash→command、read/write/edit→path、grep→pattern、todo_write→tasks 数量等。
 * 未覆盖的工具返回空串（header 只显 toolName）。
 */
const argPath = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.path === 'string') return input.path
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.pattern === 'string') return input.pattern
  if (Array.isArray(input.tasks)) return `${input.tasks.length} todos`
  return ''
})

/* ── subagent（pi-subagents 扩展的 "subagent" tool）特殊渲染 ── */
const isSubagent = computed(() => SUBAGENT_TOOL_NAMES.has(toolName.value))

/** subagent input 的 agent / task（single 模式）。
 *  parallel(chain 模式 input 有 tasks/chain 数组，P1 取首项摘要，P2 再完善。 */
const subagentAgent = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
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
  const input = props.tool?.input as Record<string, unknown> | undefined
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
  const t = subagentTask.value.trim()
  if (t.length <= TASK_PREVIEW_LIMIT) return t
  return `${t.slice(0, TASK_PREVIEW_LIMIT)}…`
})

/** parallel/chain 无 agent 名时的兜底标签 */
const subagentHeaderLabel = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (Array.isArray(input?.tasks) || Array.isArray(input?.chain)) return t('panel.message.multiSubagent')
  return ''
})

/** progress 快照（单一 computed，liveInfo 与展开体详情共用，避免重复提取）。
 *  数据源：ToolCall.detail（chat-message-effects tool_call_update 写入的 AgentProgress 快照）。
 *  pi-subagents 推送的 partialResult 是 { details: { progress: AgentProgress[] } }，
 *  event-adapter 提取后存入 detail。取 progress[0]（single 模式首项）。 */
const subagentProgressDetail = computed(() => extractProgressSnapshot(props.tool?.detail))

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

const blockClass = computed(() => {
  if (props.type !== 'tool') return ''
  // 失败 tool / 失败 subagent：整块红框（draft trace-tool.failed）。
  if (!isFailed.value) return ''
  return 'my-1 rounded-lg border border-danger bg-[color-mix(in_oklch,var(--danger)_6%,transparent)] px-3'
})
</script>
