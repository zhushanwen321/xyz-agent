<template>
  <!--
    展示组件 · trace 块（message-stream 折叠区内的单个块）。
    draft-message-stream §4：thinking(紫斜体) / tool_call(青色 mono) / 中间 output text(下划线行)。
    - thinking：header 可点击 toggle，长块独立再折叠，默认收起。
    - tool：默认收起（仅显示 header 工具名+状态），点击展开详情；running 态强制展开。
    - tool 失败：整块红框（danger 边 + 淡红底）。
    审批按钮 DEFERRED（G-018），v1 不渲染。
  -->
  <div class="trace-blk py-2" :class="blockClass">
    <!-- thinking 块：header 可点击 toggle，长 reasoning 独立再折叠（本地折叠态，由 collapsed prop 初始化） -->
    <div v-if="type === 'thinking'" class="trace-think">
      <div
        class="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-reasoning transition-colors hover:text-[var(--reasoning)]"
        :title="thinkingCollapsed ? '展开推理' : '收起推理'"
        @click="thinkingCollapsed = !thinkingCollapsed"
      >
        <ChevronRight class="size-2.5 transition-transform" :class="thinkingCollapsed ? '' : 'rotate-90'" />
        <Brain class="size-3" />
        <span>思考</span>
        <span v-if="thinkingCollapsed" class="ml-0.5 truncate text-muted">· {{ previewText }}</span>
      </div>
      <!-- text-[12px] 对齐 tool 详情字号（曾用继承字号偏大） -->
      <p v-if="!thinkingCollapsed" class="mt-1 text-[12px] italic leading-relaxed text-muted">{{ content }}</p>
    </div>

    <!-- 中间产出 text 块（draft §4 Output Text 中间：折进执行流程，下划线行） -->
    <p v-else-if="type === 'text'" class="border-b border-dashed border-border pb-2 text-[12.5px] leading-relaxed text-muted">
      {{ content }}
    </p>

    <!-- tool_call 块：默认收起，header 点击 toggle；running 强制展开 -->
    <div v-else class="trace-tool">
      <div
        class="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-opacity hover:opacity-80"
        :class="isFailed ? 'text-danger' : 'text-info'"
        :title="toolExpanded ? '收起' : '展开'"
        @click="toolCollapsed = !toolCollapsed"
      >
        <ChevronRight class="size-2.5 transition-transform" :class="toolExpanded ? 'rotate-90' : ''" />
        <Wrench class="size-3" />
        <span>工具{{ isFailed ? ' · 失败' : isRunning ? ' · 进行中' : '' }}</span>
        <span class="normal-case tracking-normal">{{ toolName }}</span>
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
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Brain, ChevronRight, Check, Wrench, XCircle } from '@lucide/vue'
import type { ToolCall } from '@xyz-agent/shared'

const props = defineProps<{
  type: 'thinking' | 'tool' | 'text'
  /** thinking / text 内容 */
  content?: string
  /** tool_call 数据（type==='tool' 时必填） */
  tool?: ToolCall
  /** thinking 块初始折叠态（来自 ThinkingBlock.collapsed，默认收起） */
  collapsed?: boolean
}>()

/* ── thinking 独立折叠（draft §4「长块可单独再折叠」）：本地态，由 collapsed prop 初始化 ── */
const thinkingCollapsed = ref(props.collapsed ?? true)

/** 收起态的正文预览（截断，draft：收起时显一行摘要） */
const PREVIEW_LIMIT = 60
const previewText = computed(() => {
  const c = props.content?.trim() ?? ''
  if (c.length <= PREVIEW_LIMIT) return c
  return `${c.slice(0, PREVIEW_LIMIT)}…`
})

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')
const toolName = computed(() => props.tool?.toolName ?? 'tool')
const result = computed(() => props.tool?.output)

/**
 * tool 折叠：默认收起，点击展开；running 态强制展开（实时可见）。
 * trace 默认收起要求（问题 3）：点击「已工作」展开后 tool 也应默认折叠，仅 running 强制可见。
 */
const toolCollapsed = ref(true)
const toolExpanded = computed(() => isRunning.value || !toolCollapsed.value)

/** 从 input 提取可读参数（path / command 等），简化展示 */
const argPath = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  if (!input) return ''
  if (typeof input.path === 'string') return input.path
  if (typeof input.command === 'string') return input.command
  return ''
})

const blockClass = computed(() => {
  if (props.type !== 'tool' || !isFailed.value) return ''
  // 失败 tool：整块红框（draft trace-tool.failed）
  return 'my-1 rounded-lg border border-danger bg-[rgba(239,68,68,0.06)] px-3'
})
</script>
