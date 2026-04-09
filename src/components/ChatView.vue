<script setup lang="ts">
import { ref, watch, nextTick, computed, type Ref } from 'vue'
import { useChat } from '../composables/useChat'
import MessageBubble from './MessageBubble.vue'
import MessageInput from './MessageInput.vue'

const props = defineProps<{
  currentSessionId: string | null
}>()

const sessionIdRef = computed(() => props.currentSessionId) as Ref<string | null>
const { messages, streamingText, isStreaming, send } = useChat(sessionIdRef)

const scrollContainer = ref<HTMLDivElement | null>(null)

watch(
  [() => messages.value.length, streamingText],
  async () => {
    await nextTick()
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  },
)

/** 最后一条消息是 assistant 且正在流式输出时，streamingText 追加到该消息 */
const isLastAssistantStreaming = computed(() => {
  if (!streamingText.value) return false
  const last = messages.value[messages.value.length - 1]
  return last?.role === 'assistant'
})

function handleSend(content: string) {
  send(content)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div ref="scrollContainer" class="flex-1 overflow-y-auto px-4 py-4">
      <div v-if="messages.length === 0" class="flex h-full items-center justify-center text-muted-foreground">
        <p>开始一段新对话</p>
      </div>

      <div class="mx-auto max-w-3xl space-y-4">
        <MessageBubble
          v-for="(msg, index) in messages"
          :key="msg.id"
          :message="msg"
          :streaming-text="isLastAssistantStreaming && index === messages.length - 1 ? streamingText : undefined"
        />

        <!-- 流式文本独立气泡：仅在最后一条不是 assistant 时使用（如用户刚发送后） -->
        <MessageBubble
          v-if="streamingText && !isLastAssistantStreaming"
          :message="{
            id: 'streaming',
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
          }"
          :streaming-text="streamingText"
        />
      </div>
    </div>

    <MessageInput
      :is-streaming="isStreaming"
      @send="handleSend"
    />
  </div>
</template>
