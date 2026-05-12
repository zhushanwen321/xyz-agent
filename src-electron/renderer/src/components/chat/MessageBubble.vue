<template>
  <!-- system 消息：全宽横幅 -->
  <div
    v-if="message.role === 'system'"
    :class="[
      'self-stretch w-full max-w-none my-2 border border-border bg-surface rounded-sm px-3.5 py-2.5 text-[13px] flex items-start gap-2.5 box-border',
      message.status === 'error' && 'border-danger bg-danger-light',
    ]"
  >
    <span
      :class="[
        'w-2 h-2 rounded-full shrink-0 mt-1',
        message.status === 'error' ? 'bg-danger' : 'bg-success',
      ]"
    ></span>
    <div class="flex-1">
      <div class="font-semibold text-[13px]">{{ message.content }}</div>
    </div>
  </div>

  <!-- assistant / user 消息 -->
  <div
    v-else
    :data-role="message.role"
    :class="[
      'py-3 px-4 leading-[1.6] text-sm',
      message.role === 'user'
        ? 'self-end max-w-[75%] bg-accent text-white rounded rounded-br-xs'
        : 'self-start w-full bg-transparent',
    ]"
  >
    <div
      :class="[
        'text-[10px] font-semibold uppercase tracking-[0.04em] leading-[1.4] mb-[3px]',
        message.role === 'user' ? 'text-right text-[var(--white-70)]' : 'text-muted',
      ]"
    >
      <template v-if="message.role === 'assistant'">助手</template>
      <template v-else>用户</template>
    </div>

    <!-- Thinking blocks -->
    <ThinkingBlock
      v-for="block in message.thinking"
      :key="block.id"
      :text="block.content"
      :streaming="message.status === 'streaming'"
      :collapsed="block.collapsed"
    />

    <!-- Tool call cards -->
    <ToolCallCard
      v-for="tc in message.toolCalls"
      :key="tc.id"
      :tool-call="tc"
      :batch-info="batchInfoMap.get(tc.id)"
    />

    <!-- Markdown content -->
    <div v-if="message.content" class="msg__body select-text">
      <span
        v-if="message.role === 'user' && message.skillName"
        class="inline-flex items-center gap-0.5 text-[11px] font-medium py-[1px] px-1.5 rounded-full bg-[var(--white-25)] text-white mr-1 align-middle leading-[1.4]"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="10" height="10"><path d="M2 8l4 4 8-8"/></svg>
        {{ message.skillName }}
      </span>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span v-html="renderedContent"></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@xyz-agent/shared'
import type { BatchInfo } from './ToolCallCard.vue'
import { renderMarkdown } from '../../lib/markdown'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ message: Message }>()

const renderedContent = computed(() => renderMarkdown(props.message.content))

// ── Batch detection: consecutive same-type file operations ──
function extractContentSize(input: unknown): number {
  if (!input) return 0
  try {
    const obj = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>
    const text = obj.content ?? obj.new_text ?? ''
    return String(text).length
  } catch { return 0 }
}

function formatBatchSize(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

const batchInfoMap = computed(() => {
  const result = new Map<string, BatchInfo>()
  const toolCalls = props.message.toolCalls
  if (!toolCalls || toolCalls.length < 2) return result

  let batchStart = 0
  for (let i = 1; i <= toolCalls.length; i++) {
    const isEnd = i === toolCalls.length || toolCalls[i].toolName !== toolCalls[batchStart].toolName
    if (isEnd) {
      const size = i - batchStart
      // Only group file operation batches (write, edit)
      const name = toolCalls[batchStart].toolName
      if (size >= 2 && (name === 'write' || name === 'edit')) {
        let totalBytes = 0
        for (let j = batchStart; j < i; j++) {
          totalBytes += extractContentSize(toolCalls[j].input)
        }
        const totalSize = formatBatchSize(totalBytes)
        for (let j = batchStart; j < i; j++) {
          result.set(toolCalls[j].id, {
            index: j - batchStart,
            total: size,
            isLast: j === i - 1,
            totalSize,
          })
        }
      }
      batchStart = i
    }
  }
  return result
})
</script>

<!-- msg__body 内的 p/code 由 v-html 渲染，无法用 Tailwind 类作用于动态内容 -->
<style scoped>
.msg__body p { margin-bottom: 6px; }
.msg__body p:last-child { margin-bottom: 0; }
.msg__body code {
  background: var(--bg);
  padding: 1px 4px;
  border-radius: var(--radius-xs);
  font-size: 0.88em;
  font-family: var(--font-mono);
}
/* 用户消息气泡内的 code 需要白底 */
[data-role="user"] .msg__body code {
  background: rgba(255, 255, 255, 0.2);
  color: white;
}
</style>
