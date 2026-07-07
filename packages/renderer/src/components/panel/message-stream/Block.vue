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
        class="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-reasoning transition-colors hover:text-[var(--reasoning)]"
        :title="thinkingExpanded ? '收起推理' : '展开推理'"
        @click="toggleThinking"
      >
        <ChevronRight class="size-2.5 transition-transform" :class="thinkingExpanded ? 'rotate-90' : ''" />
        <Brain class="size-3" />
        <span class="whitespace-nowrap">思考</span>
        <span v-if="!thinkingExpanded" class="ml-0.5 truncate text-muted">· {{ previewText }}</span>
      </div>
      <!-- text-[12px] 对齐 tool 详情字号（曾用继承字号偏大） -->
      <p v-if="thinkingExpanded" class="mt-1 text-[12px] italic leading-relaxed text-muted">{{ content }}</p>
    </div>

    <!-- 中间产出 text 块（draft §4 Output Text 中间：折进执行流程，下划线行，markdown 渲染）。
         streaming 光标（draft §1 末尾光标）：streaming 态末位 text 块显示，从 Turn.vue 传入 -->
    <div v-else-if="type === 'text'" class="border-b border-dashed border-border pb-2 text-[12.5px] leading-relaxed text-muted">
      <MarkdownRenderer :content="content ?? ''" :session-id="sessionId ?? undefined" />
      <span v-if="streaming" class="streaming-cursor ml-0.5 inline-block h-3.5 w-[7px] translate-y-[3px] rounded-[1px] bg-accent align-text-bottom animate-blink" />
    </div>

    <!-- tool_call 块：默认 1 行收起（streaming/running 也收起），header 含摘要，点击展开详情。
         subagent（pi-subagents 扩展的 "subagent" tool）用独立样式：紫色 Subagent 行，sync 模式滚动进度。 -->
    <div v-else class="trace-tool">
      <!-- ── subagent 块：独立样式（紫色，Bot 图标，与思考块同语义族）── -->
      <div v-if="isSubagent" class="trace-subagent">
        <div
          class="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-opacity hover:opacity-80"
          :class="subagentHeaderColor"
          :title="toolExpanded ? '收起' : '展开'"
          @click="toggleTool"
        >
          <ChevronRight class="size-2.5 transition-transform" :class="toolExpanded ? 'rotate-90' : ''" />
          <Bot class="size-3" />
          <span class="whitespace-nowrap">Subagent</span>
          <span class="normal-case tracking-normal text-muted">{{ subagentAgent || subagentHeaderLabel }}</span>
          <span v-if="subagentTask" class="normal-case tracking-normal text-subtle truncate">· {{ subagentTaskPreview }}</span>
          <!-- 状态/进度（滚动更新）：sync running 显当前工具+turn+tokens；async 显派发/完成/失败 -->
          <span v-if="isAsyncSubagent" class="ml-0.5 inline-flex items-center gap-1 normal-case tracking-normal whitespace-nowrap">
            <span v-if="asyncState === 'dispatched'" class="flex items-center gap-0.5 text-subtle">
              <span class="size-[6px] rounded-full bg-subtle animate-working-pulse" />后台运行
            </span>
            <Check v-else-if="asyncState === 'completed'" class="size-3 text-success" />
            <XCircle v-else-if="asyncState === 'failed'" class="size-3 text-danger" />
            <span v-else-if="asyncState === 'paused'" class="text-subtle">已暂停</span>
          </span>
          <span v-else-if="isRunning" class="ml-0.5 inline-flex items-center gap-1 normal-case tracking-normal whitespace-nowrap text-reasoning">
            <span class="size-[6px] rounded-full bg-reasoning animate-working-pulse" />
            <span class="truncate">{{ subagentLiveInfo || '运行中' }}</span>
          </span>
          <Check v-else-if="!isFailed && !isUnfinished" class="ml-0.5 size-3 text-success" />
          <XCircle v-else-if="isFailed" class="ml-0.5 size-3 text-danger" />
        </div>
        <template v-if="toolExpanded">
          <!-- sync 模式：progress 快照详情（toolCount/turn/tokens/duration）+ 最终输出 -->
          <div v-if="!isAsyncSubagent && subagentProgressDetail" class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted">
            <span v-if="subagentProgressDetail.toolCount != null" class="text-info">工具 ×{{ subagentProgressDetail.toolCount }}</span>
            <span v-if="subagentProgressDetail.turnCount != null">turn {{ subagentProgressDetail.turnCount }}</span>
            <span v-if="subagentProgressDetail.tokens != null">{{ formatTokens(subagentProgressDetail.tokens) }}</span>
            <span v-if="subagentProgressDetail.durationMs != null">{{ formatDuration(subagentProgressDetail.durationMs) }}</span>
            <span v-if="subagentProgressDetail.currentTool" class="truncate text-reasoning">→ {{ subagentProgressDetail.currentTool }}</span>
          </div>
          <!-- 最终输出（sync 的 finalOutput / async 的派发文本或完成 summary） -->
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
          class="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-opacity hover:opacity-80"
          :class="isFailed ? 'text-danger' : isUnfinished ? 'text-subtle' : 'text-info'"
          :title="toolExpanded ? '收起' : '展开'"
          @click="toggleTool"
        >
          <ChevronRight class="size-2.5 transition-transform" :class="toolExpanded ? 'rotate-90' : ''" />
          <Wrench class="size-3" />
          <span class="normal-case tracking-normal">{{ toolName }}</span>
          <span v-if="argPath" class="normal-case tracking-normal text-subtle truncate">· {{ argPath }}</span>
          <!-- 状态指示：running 脉冲点 / completed Check 图标 / failed XCircle 图标 -->
          <span v-if="isRunning" class="ml-0.5 inline-flex items-center gap-0.5 normal-case tracking-normal whitespace-nowrap text-accent">
            <span class="size-[6px] rounded-full bg-accent animate-working-pulse" />进行中
          </span>
          <Check v-else-if="!isFailed && !isUnfinished && result" class="ml-0.5 size-3 text-success" />
          <XCircle v-else-if="isFailed" class="ml-0.5 size-3 text-danger" />
        </div>
        <template v-if="toolExpanded">
          <div class="mt-1 font-mono text-[12px] text-fg">
            <span :class="isFailed ? 'text-danger' : 'text-info'">{{ toolName }}</span>
            <span class="text-muted">({{ argPath }})</span>
          </div>
          <div
            v-if="result"
            class="mt-1 inline-flex items-start gap-1 pl-0.5 font-mono text-[12px] leading-snug whitespace-pre-wrap"
            :class="isFailed ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'"
          >
            <Check v-if="!isFailed" class="mt-0.5 size-3 shrink-0 text-success" />
            <XCircle v-else class="mt-0.5 size-3 shrink-0 text-danger" />
            <span>{{ result }}</span>
            <span v-if="isRunning" class="ml-0.5 inline-block h-3.5 w-[7px] translate-y-[3px] rounded-[1px] bg-accent align-text-bottom animate-blink" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Bot, Brain, ChevronRight, Check, Wrench, XCircle } from '@lucide/vue'
import type { ToolCall } from '@xyz-agent/shared'
import { SUBAGENT_TOOL_NAMES } from '@xyz-agent/shared'
import MarkdownRenderer from './MarkdownRenderer.vue'

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
  /** streaming 光标（draft §1 末尾光标）：仅末位 text 块在 working 态显示，Turn.vue 传入 */
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

/** async（background）模式判定：asyncState 有值表示走过后台派发路径。
 *  sync 模式 asyncState 缺省。判定优先看 asyncState（tool_call_end 时据 details.asyncId 设置）。 */
const isAsyncSubagent = computed(() => !!props.tool?.asyncState)
const asyncState = computed(() => props.tool?.asyncState)

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
    return arr.length > 1 ? `${firstName} 等 ${arr.length} 个` : firstName
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
  if (Array.isArray(input?.tasks) || Array.isArray(input?.chain)) return '多 Subagent'
  return ''
})

/**
 * sync 模式运行中的实时进度文本（滚动更新）。
 * 数据源：ToolCall.detail（chat-message-effects tool_call_update 写入的 AgentProgress 快照）。
 * pi-subagents 推送的 partialResult 是 { details: { progress: AgentProgress[] } }，
 * event-adapter 提取后存入 detail。取 progress[0]（single 模式首项）。
 */
const subagentLiveInfo = computed(() => {
  if (!isRunning.value) return ''
  const detail = props.tool?.detail
  const progress = extractProgressSnapshot(detail)
  if (!progress) return ''
  const parts: string[] = []
  if (progress.currentTool) {
    const tool = progress.currentTool
    parts.push(`${tool}`)
  }
  if (progress.turnCount != null) parts.push(`turn ${progress.turnCount}`)
  if (progress.tokens != null) parts.push(formatTokens(progress.tokens))
  return parts.join(' · ')
})

/** 展开体的 progress 详情（已完成工具数/turn/tokens/duration/当前工具） */
const subagentProgressDetail = computed(() => extractProgressSnapshot(props.tool?.detail))

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

/** subagent header 颜色：failed→danger，running→reasoning(紫)，async dispatched→subtle，完成→reasoning */
const subagentHeaderColor = computed(() => {
  if (isFailed.value) return 'text-danger'
  if (isAsyncSubagent.value) {
    return asyncState.value === 'failed' ? 'text-danger' : 'text-reasoning'
  }
  return 'text-reasoning'
})

const blockClass = computed(() => {
  if (props.type !== 'tool' || !isFailed.value) return ''
  // 失败 tool：整块红框（draft trace-tool.failed）
  return 'my-1 rounded-lg border border-danger bg-[rgba(239,68,68,0.06)] px-3'
})
</script>
