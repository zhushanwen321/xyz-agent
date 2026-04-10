<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, type Ref } from 'vue'
import { useChat } from '../composables/useChat'
import { useSession } from '../composables/useSession'
import { getCurrentModel, listTools, isTauri } from '../lib/tauri'
import MessageBubble from './MessageBubble.vue'
import MessageInput from './MessageInput.vue'
import EmptyState from './EmptyState.vue'
import StatusBar from './StatusBar.vue'

const props = defineProps<{
  currentSessionId: string | null
}>()

const sessionIdRef = computed(() => props.currentSessionId) as Ref<string | null>
const { messages, isStreaming, tokenUsage, send, currentTurnSegments } = useChat(sessionIdRef)
const { createNewSession } = useSession()

// 流式时合并 currentTurnSegments 到最后一条 assistant 消息
const displayMessages = computed(() => {
  const msgs = [...messages.value]
  if (isStreaming.value && currentTurnSegments.value.length > 0) {
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        segments: [...(last.segments ?? []), ...currentTurnSegments.value],
      }
    } else {
      msgs.push({
        id: `streaming-${Date.now()}`,
        role: 'assistant',
        content: '',
        segments: [...currentTurnSegments.value],
        timestamp: new Date().toISOString(),
        isStreaming: true,
      })
    }
  }
  return msgs
})

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

// 监听 displayMessages 变化自动滚动
watch(
  [() => displayMessages.value.length, currentTurnSegments],
  async () => {
    await nextTick()
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
    }
  },
)

async function handleSend(content: string) {
  if (!sessionIdRef.value) {
    const newId = await createNewSession()
    if (!newId) return
    await nextTick()
  }
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
          v-for="msg in displayMessages"
          :key="msg.id"
          :message="msg"
          :is-streaming="msg.isStreaming"
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
