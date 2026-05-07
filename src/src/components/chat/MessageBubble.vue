<template>
  <div :class="['msg', message.role === 'assistant' ? 'msg--bot' : `msg--${message.role}`]">
    <div :class="['msg__role', `msg__role--${message.role}`]">
      <template v-if="message.role === 'assistant'">助手</template>
      <template v-else>用户</template>
    </div>

    <!-- Thinking blocks -->
    <ThinkingBlock
      v-for="block in message.thinking"
      :key="block.id"
      :text="block.content"
      :streaming="message.status === 'streaming'"
    />

    <!-- Tool call cards -->
    <ToolCallCard
      v-for="tc in message.toolCalls"
      :key="tc.id"
      :tool-call="tc"
    />

    <!-- Markdown content -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="message.content" class="msg__body" v-html="renderedContent"></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@xyz-agent/shared'
import { renderMarkdown } from '../../lib/markdown'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ message: Message }>()

const renderedContent = computed(() => renderMarkdown(props.message.content))
</script>

<style scoped>
.msg { max-width: 80%; padding: 10px 14px; border-radius: var(--radius); line-height: 1.6; font-size: 14px; }
.msg--user { align-self: flex-end; background: var(--accent-light); border-bottom-right-radius: var(--radius-xs); }
.msg--bot { align-self: flex-start; background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: var(--radius-xs); }
.msg__role { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 3px; }
.msg__role--user { text-align: right; }
.msg__body p { margin-bottom: 6px; }
.msg__body p:last-child { margin-bottom: 0; }
.msg__body code { background: var(--bg); padding: 1px 4px; border-radius: var(--radius-xs); font-size: 0.88em; font-family: var(--font-mono); }
</style>
