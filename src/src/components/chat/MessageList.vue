<template>
  <div class="msg-list" ref="containerRef">
    <div v-for="msg in messages" :key="msg.id" class="msg-wrapper">
      <MessageBubble :message="msg" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{ messages: Message[] }>()
const containerRef = ref<HTMLElement | null>(null)

// Auto-scroll to bottom
watch(() => props.messages.length, () => {
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight
  }
})
</script>

<style scoped>
.msg-list { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; }
.msg-wrapper { max-width: 80%; }
</style>
