<template>
  <div v-if="message" class="streaming-msg">
    <MessageBubble :message="message" />
    <span v-if="isStreaming" class="streaming-cursor">▊</span>
  </div>
</template>

<script setup lang="ts">
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'

defineProps<{ message: Message | null; isStreaming: boolean }>()
</script>

<style scoped>
.streaming-msg { display: flex; align-items: flex-start; gap: 4px; padding: 0 24px 12px; }
.streaming-cursor { animation: blink 1s step-end infinite; color: var(--accent); font-size: 14px; }
@keyframes blink { 50% { opacity: 0; } }
</style>
