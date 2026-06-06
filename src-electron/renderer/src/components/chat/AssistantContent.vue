<!--
  助手消息内容编排：将 thinking/toolCall/text 按 section 分组渲染。
  从 MessageBubble 中提取，职责清晰：只管 assistant 内容的 sections 编排。
-->
<template>
  <template v-if="sections.length">
    <AssistantSection
      v-for="(section, si) in sections"
      :key="si"
      :type="section.type"
      :label="sectionLabel(section)"
    >
      <!-- Thinking blocks -->
      <template v-if="section.type === 'thinking'">
        <ThinkingBlock
          v-for="block in section.blocks"
          :key="block.refId"
          :text="resolveThinkingContent(block.refId)"
          :streaming="isStreaming && !thinkingEndTime(block.refId)"
          :start-time="thinkingStartTime(block.refId)"
          :end-time="thinkingEndTime(block.refId)"
        />
      </template>

      <!-- Tool call blocks -->
      <template v-else-if="section.type === 'toolCall'">
        <ToolCallCard
          v-for="block in section.blocks"
          :key="block.refId"
          :tool-call="resolveToolCall(block.refId)!"
          :batch-info="batchInfoMap.get(block.refId)"
        />
      </template>

      <!-- Text block -->
      <template v-else-if="section.type === 'text' && message.content">
        <div
          class="msg__body select-text py-1 leading-[1.6] text-fg text-xs"
          :data-message-id="message.id"
          :data-markdown-source="message.content"
          @click="handleBodyClick"
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-html="renderedContent"></span>
          <span v-if="isStreaming" class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"></span>
        </div>
      </template>
    </AssistantSection>
  </template>

  <!-- Fallback: 无任何 section 时（空消息） -->
  <div v-else-if="message.content" class="py-2 px-3 leading-[1.6] text-xs rounded-sm msg-assistant-fallback">
    <div
      class="msg__body select-text"
      :data-message-id="message.id"
      :data-markdown-source="message.content"
      @click="handleBodyClick"
    >
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span v-html="renderedContent"></span>
      <span v-if="isStreaming" class="inline-block w-0.5 h-[1.1em] bg-accent rounded-sm align-text-bottom animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@xyz-agent/shared'
import type { AssistantSection as Section } from '../../lib/message-layout'
import { groupIntoSections } from '../../lib/message-layout'
import type { BatchInfo } from './ToolCallCard.vue'
import { useMarkdownRender } from '../../composables/useMarkdownRender'
import { useMarkdownBodyClick } from '../../composables/useMarkdownBodyClick'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'
import AssistantSection from './AssistantSection.vue'

const BYTES_PER_KB = 1024
const MIN_TOOL_CALLS = 2
const BATCH_MIN_SIZE = 2

const props = defineProps<{
  message: Message
  isStreaming?: boolean
}>()

// ── Section grouping ──

const sections = computed<Section[]>(() => groupIntoSections(props.message))

const toolCallCount = computed(() => props.message.toolCalls?.length ?? 0)

function sectionLabel(section: Section): string | undefined {
  if (section.type === 'text') return '回答'
  if (section.type === 'toolCall' && toolCallCount.value > 1) {
    return `${toolCallCount.value} 次工具调用`
  }
  // thinking: ThinkingBlock toggle shows "Thinking · 3.2s" inline, no section label needed
  return undefined
}

// ── Content block resolution ──

function resolveThinkingContent(refId: string): string {
  return props.message.thinking?.find(b => b.id === refId)?.content ?? ''
}

function resolveThinking(refId: string): import('@xyz-agent/shared').ThinkingBlock | undefined {
  return props.message.thinking?.find(b => b.id === refId)
}

/** Thinking start time. Returns undefined for history messages (no data available). */
function thinkingStartTime(refId: string): number | undefined {
  return resolveThinking(refId)?.startTime
}

/** Thinking end time. Returns undefined for history messages. */
function thinkingEndTime(refId: string): number | undefined {
  return resolveThinking(refId)?.endTime
}

function resolveToolCall(refId: string): import('@xyz-agent/shared').ToolCall | undefined {
  return props.message.toolCalls?.find(tc => tc.id === refId)
}

// ── Markdown rendering ──

const { renderedContent } = useMarkdownRender(
  () => props.message.content,
  {
    messageId: () => props.message.id,
    status: () => props.message.status,
  },
)

// ── Event delegation: copy + collapse (shared composable) ──
const { handleBodyClick } = useMarkdownBodyClick()

// ── Batch detection ──

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
  if (bytes < BYTES_PER_KB) return `${bytes}B`
  if (bytes < BYTES_PER_KB * BYTES_PER_KB) return `${(bytes / BYTES_PER_KB).toFixed(1)}KB`
  return `${(bytes / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)}MB`
}

const batchInfoMap = computed(() => {
  const result = new Map<string, BatchInfo>()
  const toolCalls = props.message.toolCalls
  if (!toolCalls || toolCalls.length < MIN_TOOL_CALLS) return result

  let batchStart = 0
  for (let i = 1; i <= toolCalls.length; i++) {
    const isEnd = i === toolCalls.length || toolCalls[i].toolName !== toolCalls[batchStart].toolName
    if (isEnd) {
      const size = i - batchStart
      const name = toolCalls[batchStart].toolName
      if (size >= BATCH_MIN_SIZE && (name === 'write' || name === 'edit')) {
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

<style scoped>
.msg-assistant-fallback {
  background: var(--msg-assistant-bg);
}
</style>
