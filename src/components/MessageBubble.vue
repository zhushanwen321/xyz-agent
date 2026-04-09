<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import type { ChatMessage } from '../types'
import type { ToolCallState } from '../composables/useChat'

const props = defineProps<{
  message: ChatMessage
  streamingText?: string
  activeToolCalls?: Map<string, ToolCallState>
}>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')

const renderedContent = computed(() => {
  let text = props.message.content
  if (props.streamingText) {
    text += props.streamingText
  }
  return md.render(text)
})

const runningTools = computed(() => {
  if (!props.activeToolCalls) return []
  return Array.from(props.activeToolCalls.values()).filter((t) => t.is_running)
})
</script>

<template>
  <div
    class="flex"
    :class="{
      'justify-end': isUser,
      'justify-start': !isUser,
    }"
  >
    <div
      class="max-w-[80%] rounded-lg px-4 py-2.5"
      :class="{
        'bg-primary text-primary-foreground': isUser,
        'bg-muted': !isUser && !isSystem,
        'bg-destructive/10 text-destructive': isSystem,
      }"
    >
      <div class="mb-1 text-xs font-medium opacity-60">
        {{ isUser ? 'You' : isSystem ? 'System' : 'Assistant' }}
      </div>

      <!-- 正在运行的工具调用指示器 -->
      <div v-if="runningTools.length > 0" class="mb-2 flex flex-wrap gap-1.5">
        <span
          v-for="tool in runningTools"
          :key="tool.tool_use_id"
          class="inline-flex items-center gap-1 rounded-md bg-secondary/80 px-2 py-0.5 text-xs text-secondary-foreground"
        >
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
          {{ tool.tool_name }}
        </span>
      </div>

      <div
        class="prose prose-sm max-w-none dark:prose-invert"
        v-html="renderedContent"
      />
      <span
        v-if="streamingText"
        class="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current"
      />
    </div>
  </div>
</template>
