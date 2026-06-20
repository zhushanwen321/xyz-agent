<template>
  <!--
    展示组件 · trace 块（message-stream 折叠区内的单个块）。
    draft-message-stream §4：thinking(紫斜体) / tool_call(青色 mono)。
    tool 失败：整块红框（danger 边 + 淡红底），错误是 tool 属性非 turn 属性。
    审批按钮 DEFERRED（G-018），v1 不渲染。
  -->
  <div class="trace-blk py-2" :class="blockClass">
    <!-- thinking 块 -->
    <div v-if="type === 'thinking'" class="trace-think">
      <div class="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-reasoning">
        <Brain class="size-3" />
        <span>思考</span>
      </div>
      <p class="italic leading-relaxed text-muted">{{ content }}</p>
    </div>

    <!-- tool_call 块 -->
    <div v-else class="trace-tool">
      <div
        class="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em]"
        :class="isFailed ? 'text-danger' : 'text-info'"
      >
        <Wrench class="size-3" />
        <span>工具{{ isFailed ? ' · 失败' : isRunning ? ' · 进行中' : '' }}</span>
      </div>
      <div class="font-mono text-[12px] text-fg">
        <span :class="isFailed ? 'text-danger' : 'text-info'">{{ toolName }}</span>
        <span class="text-muted">({{ argPath }})</span>
      </div>
      <div v-if="result" class="mt-1 pl-0.5 inline-flex items-start gap-1 font-mono text-[12px] leading-snug whitespace-pre-wrap"
        :class="isFailed ? 'border-l-2 border-danger pl-2 text-danger' : 'text-muted'">
        <Check v-if="!isFailed" class="mt-0.5 size-3 shrink-0 text-success" />
        <XCircle v-else class="mt-0.5 size-3 shrink-0 text-danger" />
        <span>{{ result }}</span>
        <span v-if="isRunning" class="streaming-cursor" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Brain, Check, Wrench, XCircle } from '@lucide/vue'
import type { ToolCall } from '@xyz-agent/shared'

const props = defineProps<{
  type: 'thinking' | 'tool'
  /** thinking 内容 */
  content?: string
  /** tool_call 数据（type==='tool' 时必填） */
  tool?: ToolCall
}>()

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')
const toolName = computed(() => props.tool?.toolName ?? 'tool')
const result = computed(() => props.tool?.output)

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

<style scoped>
/* 流式光标（draft .cursor） */
.streaming-cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: text-bottom;
  border-radius: 1px;
  background: var(--accent);
  animation: blink 1s step-end infinite;
}
@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
</style>
