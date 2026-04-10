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
  <!-- User 消息 — 右对齐，内联标签 -->
  <div v-if="isUser" class="flex w-[95%] flex-row-reverse items-start self-end">
    <div class="flex shrink-0 items-center gap-1.5 px-1">
      <div class="flex h-4 w-4 items-center justify-center rounded bg-bg-inset text-[10px] font-mono font-bold text-text-secondary">U</div>
      <span class="font-mono text-[10px] text-text-tertiary">User</span>
    </div>
    <div class="flex-1 rounded-md border border-border-default border-l-[3px] border-l-[#a1a1aa] bg-bg-elevated px-3 py-1.5">
      <div class="prose max-w-none text-text-primary" v-html="renderMarkdown(message.content)" />
    </div>
  </div>

  <!-- System 消息 — 全宽，红色提示 -->
  <div v-else-if="isSystem" class="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-1.5">
    <div class="flex items-center gap-2 text-[10px] font-medium text-accent-red">
      <span>!</span>
      <span>System</span>
    </div>
    <div class="mt-1 text-[10px] text-accent-red" v-html="renderMarkdown(message.content)" />
  </div>

  <!-- Assistant 消息 — 左对齐，内联标签 -->
  <div v-else class="flex w-[95%] flex-row items-start self-start">
    <div class="flex shrink-0 items-center gap-1.5 px-1">
      <div class="flex h-4 w-4 items-center justify-center rounded bg-[#22c55e22] text-[10px] font-mono font-bold text-accent">&lambda;</div>
      <span class="font-mono text-[10px] text-accent">Assistant</span>
    </div>

    <div class="flex-1">
      <template v-if="segments.length > 0">
        <template v-for="(seg, idx) in segments" :key="idx">
          <!-- text segment -->
          <div
            v-if="seg.type === 'text' && seg.text"
            class="rounded-md border border-border-default border-l-[3px] border-l-accent bg-bg-elevated px-3 py-1.5"
            :class="{ 'mb-2': idx < segments.length - 1 }"
          >
            <div class="prose max-w-none text-text-primary" v-html="renderMarkdown(seg.text)" />
          </div>

          <!-- tool segment -->
          <div v-else-if="seg.type === 'tool'" class="mb-2">
            <ToolCallCard :tool-call="seg.call" />
          </div>
        </template>

        <!-- 流式闪烁光标 -->
        <span
          v-if="isStreaming"
          class="mt-1 ml-1 inline-block h-3 w-1.5 bg-accent animate-cursor-blink"
        />
      </template>

      <!-- 无 segments 时用 content 渲染 -->
      <div
        v-else-if="message.content"
        class="rounded-md border border-border-default border-l-[3px] border-l-accent bg-bg-elevated px-3 py-1.5"
      >
        <div class="prose max-w-none text-text-primary" v-html="renderMarkdown(message.content)" />
      </div>
    </div>
  </div>
</template>
