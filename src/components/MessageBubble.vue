<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import type { ChatMessage, AssistantSegment } from '../types'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{
  message: ChatMessage
  isStreaming?: boolean
}>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')

// assistant 消息使用 segments 渲染，user 消息使用 content
const segments = computed<AssistantSegment[]>(() => props.message.segments ?? [])

function renderMarkdown(text: string): string {
  return md.render(text)
}

</script>

<template>
  <!-- User 消息 — 右对齐，深色卡片 + 灰色色条 -->
  <div v-if="isUser" class="flex flex-col items-end">
    <div class="mb-1 flex items-center gap-1.5 font-mono text-[11px]">
      <span class="rounded px-1.5 py-0.5 text-text-secondary bg-[#ffffff15]">User</span>
    </div>
    <div class="max-w-[75%] rounded-lg border border-border-default border-l-[3px] border-l-[#a1a1aa] bg-bg-elevated px-4 py-3">
      <div class="prose prose-sm max-w-none text-text-primary" v-html="renderMarkdown(message.content)" />
    </div>
  </div>

  <!-- System 消息 — 全宽，红色提示 -->
  <div v-else-if="isSystem" class="rounded-md border border-accent-red/30 bg-accent-red/10 px-4 py-2.5">
    <div class="flex items-center gap-2 text-xs font-medium text-accent-red">
      <span>!</span>
      <span>System</span>
    </div>
    <div class="mt-1 text-sm text-accent-red" v-html="renderMarkdown(message.content)" />
  </div>

  <!-- Assistant 消息 — 左对齐，基于 segments 渲染 -->
  <div v-else class="flex flex-col items-start">
    <div class="mb-1 flex items-center gap-1.5 font-mono text-[11px]">
      <span class="rounded px-1.5 py-0.5 text-accent bg-[#22c55e22]">&lambda; Assistant</span>
    </div>

    <!-- 有 segments 时逐段渲染 -->
    <template v-if="segments.length > 0">
      <template v-for="(seg, idx) in segments" :key="idx">
        <!-- text segment -->
        <div
          v-if="seg.type === 'text' && seg.text"
          class="max-w-[85%] rounded-lg border border-border-default border-l-[3px] border-l-accent bg-bg-elevated px-4 py-3"
          :class="{ 'mb-3': idx < segments.length - 1 }"
        >
          <div class="prose prose-sm max-w-none text-text-primary" v-html="renderMarkdown(seg.text)" />
        </div>

        <!-- tool segment -->
        <div v-else-if="seg.type === 'tool'" class="mb-3 w-full max-w-[85%]">
          <ToolCallCard :tool-call="seg.call" />
        </div>
      </template>

      <!-- 流式闪烁光标 -->
      <span
        v-if="isStreaming"
        class="mt-1 ml-1 inline-block h-4 w-2 bg-accent animate-cursor-blink"
      />
    </template>

    <!-- 无 segments 时用 content 渲染（向后兼容） -->
    <div
      v-else-if="message.content"
      class="max-w-[85%] rounded-lg border border-border-default border-l-[3px] border-l-accent bg-bg-elevated px-4 py-3"
    >
      <div class="prose prose-sm max-w-none text-text-primary" v-html="renderMarkdown(message.content)" />
    </div>
  </div>
</template>
