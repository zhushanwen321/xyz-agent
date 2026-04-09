<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, type Ref } from 'vue'
import { useChat } from '../composables/useChat'
import { getCurrentModel, listTools, isTauri } from '../lib/tauri'
import MessageBubble from './MessageBubble.vue'
import MessageInput from './MessageInput.vue'
import EmptyState from './EmptyState.vue'
import StatusBar from './StatusBar.vue'

const props = defineProps<{
  currentSessionId: string | null
}>()

const sessionIdRef = computed(() => props.currentSessionId) as Ref<string | null>
const { messages, streamingText, isStreaming, tokenUsage, send } = useChat(sessionIdRef)

// 运行时配置（从后端获取一次）
const modelName = ref('loading...')
const toolCount = ref(0)

onMounted(async () => {
  if (!isTauri()) return
  try {
    const [model, tools] = await Promise.all([getCurrentModel(), listTools()])
    modelName.value = model
    toolCount.value = tools.length
  } catch (err) {
    console.warn('[ChatView] failed to load runtime config:', err)
  }
})

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
  <div class="flex h-full flex-1 flex-col bg-bg-surface">
    <!-- 消息区域 -->
    <div ref="scrollContainer" class="flex-1 overflow-y-auto px-4 py-6">
      <EmptyState v-if="messages.length === 0" />

      <div v-else class="mx-auto max-w-[720px] space-y-6">
        <MessageBubble
          v-for="(msg, index) in messages"
          :key="msg.id"
          :message="msg"
          :streaming-text="isLastAssistantStreaming && index === messages.length - 1 ? streamingText : undefined"
        />

        <!-- 流式文本独立气泡 -->
        <MessageBubble
          v-if="streamingText && !isLastAssistantStreaming"
          :message="{
            id: `streaming-${Date.now()}`,
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

    <StatusBar
      :is-streaming="isStreaming"
      :model-name="modelName"
      :input-tokens="tokenUsage.inputTokens"
      :output-tokens="tokenUsage.outputTokens"
      :tool-count="toolCount"
    />
  </div>
</template>
