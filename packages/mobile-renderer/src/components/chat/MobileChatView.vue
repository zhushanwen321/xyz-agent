<script setup lang="ts">
/**
 * MobileChatView —— 移动端 chat 主视图（spec P4 §3.2 + C1 + D5）。
 *
 * 结构：header（返回按钮 + session label）+ MessageStream（复用桌面端 message-stream 渲染链路，
 * 含 markdown、代码块、tool call 卡片、thinking 折叠）+ MobileComposer。
 *
 * D5：消息渲染复用桌面 message-stream 组件（@/components/panel/MessageStream.vue），
 * 保证 markdown / 代码块 / tool call 结果 / 流式渲染与桌面端一致；仅做移动端宽度适配
 * （全宽容器，触摸友好）。不自行用纯文本渲染（避免丢失 markdown 格式 / 代码高亮 / 工具结果展示）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft } from '@lucide/vue'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/useChat'
import { textToSegments } from '@xyz-agent/shared'
import MessageStream from '@/components/panel/MessageStream.vue'
import MobileComposer from './MobileComposer.vue'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const sessionStore = useSessionStore()
const { send } = useChat()

const session = computed(() => sessionStore.list.find((s) => s.id === props.sessionId) ?? null)
const sessionLabel = computed(() => session.value?.label ?? props.sessionId)

async function handleSend(text: string): Promise<void> {
  const segments = textToSegments(text)
  await send(props.sessionId, segments)
}
</script>

<template>
  <div class="mobile-chat-view flex h-full flex-col" data-testid="mobile-chat-view">
    <!-- header：返回 + session label -->
    <header class="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-3">
      <button
        type="button"
        class="flex items-center justify-center rounded-md p-1 text-muted"
        data-testid="mobile-chat-back"
        :aria-label="t('mobile.chat.back')"
        @click="emit('back')"
      >
        <ArrowLeft :size="20" />
      </button>
      <span class="flex-1 truncate text-sm font-semibold">{{ sessionLabel }}</span>
    </header>

    <!-- 消息流：复用桌面 message-stream 渲染链路（markdown / 代码块 / tool call / thinking 折叠）。 -->
    <MessageStream :session-id="sessionId" />

    <!-- composer -->
    <MobileComposer @send="handleSend" />
  </div>
</template>
