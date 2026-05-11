<template>
  <div class="msg-list" ref="containerRef" @scroll="onScroll">
    <div v-for="msg in messages" :key="msg.id" class="msg-wrapper">
      <MessageBubble :message="msg" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { Message } from '@xyz-agent/shared'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{ messages: Message[] }>()
const containerRef = ref<HTMLElement | null>(null)

const userAtBottom = ref(true)

function onScroll() {
  const el = containerRef.value
  if (el) userAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

watch(() => props.messages.length, () => {
  nextTick(() => {
    if (!userAtBottom.value) return
    const el = containerRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
})
</script>

<style scoped>
.msg-list { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 14px; }
.msg-wrapper { /* no max-width, .msg handles it */ }
</style>
