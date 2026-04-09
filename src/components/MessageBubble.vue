<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import type { ChatMessage } from '../types'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{
  message: ChatMessage
  streamingText?: string
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

const hasContent = computed(() => props.message.content || props.streamingText)
</script>

<template>
  <!-- User 消息 — 右对齐，深色卡片 -->
  <div v-if="isUser" class="flex justify-end">
    <div class="max-w-[85%] rounded-lg border border-border-default bg-bg-elevated px-4 py-3">
      <div class="prose prose-sm max-w-none text-text-primary" v-html="renderedContent" />
    </div>
  </div>

  <!-- System 消息 — 全宽，红色提示 -->
  <div v-else-if="isSystem" class="rounded-md border border-accent-red/30 bg-accent-red/10 px-4 py-2.5">
    <div class="flex items-center gap-2 text-xs font-medium text-accent-red">
      <span>!</span>
      <span>System</span>
    </div>
    <div class="mt-1 text-sm text-accent-red" v-html="renderedContent" />
  </div>

  <!-- Assistant 消息 — 左对齐，无背景 -->
  <div v-else class="flex justify-start">
    <div class="max-w-full">
      <!-- 角色标签 -->
      <div class="mb-2 flex items-center gap-1.5 font-mono text-[11px] text-accent">
        <span class="text-accent">&lambda;</span>
        <span class="font-medium">assistant</span>
      </div>

      <!-- 工具调用卡片 -->
      <div v-if="message.toolCalls && message.toolCalls.length > 0" class="mb-3 space-y-2">
        <ToolCallCard
          v-for="tc in message.toolCalls"
          :key="tc.tool_use_id"
          :tool-call="tc"
        />
      </div>

      <!-- 文本内容 -->
      <div
        v-if="hasContent"
        class="prose prose-sm max-w-none text-text-primary"
        v-html="renderedContent"
      />
      <!-- 流式光标 -->
      <span
        v-if="streamingText"
        class="ml-0.5 inline-block h-4 w-2 bg-accent animate-cursor-blink"
      />
    </div>
  </div>
</template>
