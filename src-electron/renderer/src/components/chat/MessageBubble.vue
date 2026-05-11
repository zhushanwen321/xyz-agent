<template>
  <!-- system 消息：全宽横幅 -->
  <div v-if="message.role === 'system'" :class="['msg msg--system', message.status === 'error' && 'msg--system--alert']">
    <span :class="['msg--system__dot', message.status === 'error' ? 'msg--system__dot--alert' : 'msg--system__dot--done']"></span>
    <div class="msg--system__content">
      <div class="msg--system__title">{{ message.content }}</div>
    </div>
  </div>

  <!-- assistant / user 消息 -->
  <div v-else :class="['msg', message.role === 'assistant' ? 'msg--bot' : `msg--${message.role}`]">
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
      :collapsed="block.collapsed"
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
.msg { padding: 12px 16px; line-height: 1.6; font-size: 14px; }
.msg--user { align-self: flex-end; max-width: 75%; background: var(--accent); color: white; border-radius: var(--radius); border-bottom-right-radius: var(--radius-xs); }
.msg--bot { align-self: flex-start; width: 100%; background: transparent; }

/* system 消息：全宽横幅，与设计文档 views_chat.html 对齐 */
.msg--system {
  align-self: stretch;
  width: 100%;
  max-width: none;
  margin: 8px 0;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 13px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  box-sizing: border-box;
}
.msg--system--alert {
  border-color: var(--danger);
  background: var(--danger-light, oklch(97% 0.015 25));
}
.msg--system__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
}
.msg--system__dot--done { background: var(--success); }
.msg--system__dot--alert { background: var(--danger); }
.msg--system__content { flex: 1; }
.msg--system__title { font-weight: 600; font-size: 13px; }

.msg__role { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; line-height: 1.4; color: var(--muted); margin-bottom: 3px; }
.msg__role--user { text-align: right; color: rgba(255, 255, 255, 0.7); }
.msg__body p { margin-bottom: 6px; }
.msg__body p:last-child { margin-bottom: 0; }
.msg__body code { background: var(--bg); padding: 1px 4px; border-radius: var(--radius-xs); font-size: 0.88em; font-family: var(--font-mono); }
.msg--user .msg__body code { background: rgba(255, 255, 255, 0.2); color: white; }
</style>
