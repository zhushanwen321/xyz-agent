<template>
  <div v-if="message" class="flex items-start gap-1">
    <MessageBubble :message="message" />
    <span v-if="isStreaming" class="inline-block w-0.5 h-4 bg-accent rounded-[1px] mt-0.5 animate-blink motion-reduce:opacity-60 motion-reduce:animate-none"></span>
  </div>
</template>

<script setup lang="ts">
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'

defineProps<{ message: Message | null; isStreaming: boolean }>()
</script>


