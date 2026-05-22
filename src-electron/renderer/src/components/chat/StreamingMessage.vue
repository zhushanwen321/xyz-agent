<template>
  <MessageBubble v-if="message" :message="message" :is-streaming="isStreaming" />
</template>

<script setup lang="ts">
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'

defineProps<{ message: Message | null; isStreaming: boolean }>()
</script>


