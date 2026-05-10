<template>
  <div v-if="message" class="streaming-msg">
    <MessageBubble :message="message" />
    <span v-if="isStreaming" class="streaming-cursor"></span>
  </div>
</template>

<script setup lang="ts">
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'

defineProps<{ message: Message | null; isStreaming: boolean }>()
</script>

<style scoped>
.streaming-msg { display: flex; align-items: flex-start; gap: 4px; }
.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 16px;
  background: var(--accent);
  border-radius: 1px;
  margin-top: 2px;
  animation: blink 1s step-end infinite;
}
@media (prefers-reduced-motion: reduce) {
  .streaming-cursor { opacity: 0.6; animation: none; }
}
@keyframes blink { 50% { opacity: 0; } }
</style>
