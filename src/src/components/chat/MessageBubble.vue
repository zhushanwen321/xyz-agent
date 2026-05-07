<template>
  <div :class="['msg', `msg--${message.role}`]">
    <div :class="['msg__role', `msg__role--${message.role}`]">
      <template v-if="message.role === 'assistant'"><span class="msg__lambda">λ</span> assistant</template>
      <template v-else>User</template>
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
.msg { padding: 10px 14px; border-radius: var(--radius-lg); line-height: 1.6; font-size: var(--font-size-body); }
.msg--user { align-self: flex-end; background: var(--color-bg-elevated); border-left: var(--color-bar-width, 3px) solid var(--color-text-tertiary); max-width: 75%; border-radius: 0 8px 8px 0; }
.msg--assistant { align-self: flex-start; background: var(--color-bg-ai); border-left: var(--color-bar-width, 3px) solid var(--color-accent); max-width: 85%; border-radius: 0 8px 8px 0; }
.msg__role { font-size: var(--font-size-label); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-muted); margin-bottom: 3px; font-family: var(--font-mono); }
.msg__role--user { text-align: right; }
.msg__lambda { opacity: 0.6; }
.msg__body p { margin-bottom: 6px; }
.msg__body p:last-child { margin-bottom: 0; }
.msg__body code { background: var(--color-bg-base); padding: 1px 4px; border-radius: var(--radius-sm); font-size: 0.88em; font-family: var(--font-mono); }
</style>
