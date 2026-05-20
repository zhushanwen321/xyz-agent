<template>
  <div class="flex-1 overflow-y-auto p-5 px-6 flex flex-col gap-3.5" ref="containerRef" @scroll="onScroll">
    <div v-for="msg in messages" :key="msg.id">
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

const SCROLL_THRESHOLD_PX = 80

const userAtBottom = ref(true)

function onScroll() {
  const el = containerRef.value
  if (el) userAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD_PX
}

watch(() => props.messages.length, () => {
  nextTick(() => {
    if (!userAtBottom.value) return
    const el = containerRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
})
</script>


