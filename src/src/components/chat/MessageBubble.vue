<template>
  <div :class="['msg', `msg--${message.role}`]">
    <div class="msg__role">{{ roleLabel }}</div>

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
import { useI18n } from 'vue-i18n'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ message: Message }>()
const { t } = useI18n()

const roleLabel = computed(() => props.message.role === 'user' ? t('chat.user') : t('chat.assistant'))
const renderedContent = computed(() => renderMarkdown(props.message.content))
</script>

<style scoped>
.msg { padding: 10px 14px; border-radius: var(--radius-lg); line-height: 1.6; font-size: 14px; }
.msg--user { align-self: flex-end; background: var(--color-accent-light); border-bottom-right-radius: var(--radius-sm); }
.msg--assistant { align-self: flex-start; background: var(--color-surface); border: 1px solid var(--color-border); border-bottom-left-radius: var(--radius-sm); }
.msg__role { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-muted); margin-bottom: 3px; }
.msg__body p { margin-bottom: 6px; }
.msg__body p:last-child { margin-bottom: 0; }
.msg__body code { background: var(--color-bg-base); padding: 1px 4px; border-radius: var(--radius-sm); font-size: 0.88em; font-family: var(--font-mono); }
</style>
