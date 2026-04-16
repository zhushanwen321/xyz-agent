<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import type { ChatMessage, AssistantSegment, TaskNode } from '../types'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{
  message: ChatMessage
  isStreaming?: boolean
  taskNodes: Map<string, TaskNode>
  toolUseToTaskId: Map<string, string>
  selectMode?: boolean
  selected?: boolean
  onOpenSubAgentTab?: (taskId: string) => void
}>()

const emit = defineEmits<{
  'toggle-select': [id: string]
}>()

function handleClick() {
  if (props.selectMode) {
    emit('toggle-select', props.message.id)
  }
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')

const segments = computed<AssistantSegment[]>(() => props.message.segments ?? [])

function renderMarkdown(text: string): string {
  return md.render(text)
}
</script>

<template>
  <!-- eslint-disable vue/no-v-html -->
  <!-- 选择模式包裹层 -->
  <div
    class="relative"
    :class="[
      selectMode ? 'cursor-pointer' : '',
      selectMode && selected ? 'rounded-md ring-1 ring-semantic-green/40' : '',
    ]"
    @click="handleClick"
  >
    <!-- 选择模式 checkbox -->
    <div
      v-if="selectMode"
      class="absolute left-[-6px] top-1/2 z-10 -translate-y-1/2"
    >
      <div
        class="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-[9px] font-bold leading-none"
        :class="selected
          ? 'border-semantic-green bg-semantic-green text-white'
          : 'border-border-default bg-elevated'"
      >
        <span v-if="selected">&#10003;</span>
      </div>
    </div>

    <!-- 消息内容（选择模式时右移留出 checkbox 空间） -->
    <div :class="selectMode ? 'ml-3' : ''">

  <!-- User 消息 — 左对齐，全宽背景 -->
  <div v-if="isUser" class="flex items-start gap-2 border-l-[3px] border-l-[#a1a1aa] px-2 py-1.5" style="background-color: var(--color-bg-user)">
    <div class="flex w-[76px] shrink-0 items-center gap-1.5">
      <div class="flex h-4 w-4 items-center justify-center rounded bg-inset text-[10px] font-mono font-bold text-muted-foreground">U</div>
      <span class="font-mono text-[10px] text-tertiary">User</span>
    </div>
    <div class="min-w-0 flex-1">
      <div class="prose max-w-none text-foreground" v-html="renderMarkdown(message.content)" />
    </div>
  </div>

  <!-- System 消息 — 全宽，红色提示 -->
  <div v-else-if="isSystem" class="rounded-md border border-semantic-red/30 bg-semantic-red/10 px-3 py-1.5">
    <div class="flex items-center gap-2 text-[10px] font-medium text-semantic-red">
      <span>!</span>
      <span>System</span>
    </div>
    <div class="mt-1 text-[10px] text-semantic-red" v-html="renderMarkdown(message.content)" />
  </div>

  <!-- Assistant 消息 — 左对齐，全宽背景 -->
  <div v-else class="flex items-start gap-2 border-l-[3px] border-l-semantic-green px-2 py-1.5" style="background-color: var(--color-bg-ai)">
    <div class="flex w-[76px] shrink-0 items-center gap-1.5">
      <div class="flex h-4 w-4 items-center justify-center rounded text-[10px] font-mono font-bold text-semantic-green" style="background:#22c55e22">&lambda;</div>
      <span class="font-mono text-[10px] text-semantic-green">Assistant</span>
    </div>

    <div class="min-w-0 flex-1">
      <template v-if="segments.length > 0">
        <template v-for="(seg, idx) in segments" :key="idx">
          <!-- text segment -->
          <div
            v-if="seg.type === 'text' && seg.text"
            :class="{ 'mb-2': idx < segments.length - 1 }"
          >
            <div class="prose max-w-none text-foreground" v-html="renderMarkdown(seg.text)" />
          </div>

          <!-- tool segment -->
          <div v-else-if="seg.type === 'tool'" class="mb-2">
            <ToolCallCard
              :tool-call="seg.call"
              :task-nodes="taskNodes"
              :tool-use-to-task-id="toolUseToTaskId"
              :task-id="toolUseToTaskId.get(seg.call.tool_use_id)"
              :on-open-tab="onOpenSubAgentTab"
            />
          </div>

          <!-- thinking segment -->
          <div v-else-if="seg.type === 'thinking'" class="mb-2">
            <details open class="thinking-block">
              <summary class="thinking-summary">
                <span class="thinking-icon">&#9670;</span>
                <span>思考过程</span>
                <span v-if="seg.duration_ms > 0" class="thinking-duration">
                  {{ (seg.duration_ms / 1000).toFixed(1) }}s
                </span>
              </summary>
              <div class="thinking-content">{{ seg.text }}</div>
            </details>
          </div>
        </template>

        <!-- 流式闪烁光标 -->
        <span
          v-if="isStreaming"
          class="mt-1 ml-1 inline-block h-3 w-1.5 bg-semantic-green animate-cursor-blink"
        />
      </template>

      <!-- 无 segments 时用 content 渲染 -->
      <div v-else-if="message.content">
        <div class="prose max-w-none text-foreground" v-html="renderMarkdown(message.content)" />
      </div>
    </div>
  </div>

    </div>
  </div>
</template>

<style scoped>
.thinking-block {
  background: var(--color-bg-ai, #111);
  border: 1px solid var(--color-border-default, #27272a);
  border-radius: 8px;
  overflow: hidden;
}
.thinking-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 11px;
  color: #8b8bff;
  background: var(--color-bg-ai, #131517);
  user-select: none;
}
.thinking-icon { font-size: 8px; }
.thinking-duration { color: #555; font-size: 10px; }
.thinking-content {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--color-text-secondary, #a1a1aa);
  line-height: 1.6;
  border-top: 1px solid var(--color-border-default, #27272a);
  white-space: pre-wrap;
}
</style>
