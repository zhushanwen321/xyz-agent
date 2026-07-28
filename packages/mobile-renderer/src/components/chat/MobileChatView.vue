<script setup lang="ts">
/**
 * MobileChatView —— 移动端 chat 主视图（spec P4 §3.2 + C1）。
 *
 * 简化版：header（返回按钮 + session label）+ 消息列表（chat store messages，normalizeContent 提取文本）+ MobileComposer。
 * 不引入桌面 MessageStream.vue（445 行 + useSideDrawer 桌面依赖）。P4 验证远程 chat 链路（消息文本可见，AC5）。
 * markdown/tool call/thinking 折叠留 P9（spec D11）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft } from '@lucide/vue'
import { normalizeContent } from '@xyz-agent/shared'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat } from '@/composables/features/useChat'
import { textToSegments } from '@xyz-agent/shared'
import MobileComposer from './MobileComposer.vue'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const chatStore = useChatStore()
const sessionStore = useSessionStore()
const { send } = useChat()

const session = computed(() => sessionStore.list.find((s) => s.id === props.sessionId) ?? null)
const sessionLabel = computed(() => session.value?.label ?? props.sessionId)
const messages = computed(() => chatStore.getMessages(props.sessionId) ?? [])

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

    <!-- 消息列表 -->
    <div class="flex-1 overflow-y-auto p-4" data-testid="mobile-chat-messages">
      <div
        v-if="messages.length === 0"
        class="flex h-full items-center justify-center text-sm text-subtle"
        data-testid="mobile-chat-empty"
      >
        {{ t('mobile.chat.empty') }}
      </div>
      <ul v-else class="flex flex-col gap-4">
        <li
          v-for="m in messages"
          :key="m.id"
          :data-testid="`mobile-chat-message-${m.id}`"
          class="flex flex-col gap-1"
          :class="m.role === 'user' ? 'items-end' : 'items-start'"
        >
          <span class="text-[10px] font-semibold" :class="m.role === 'user' ? 'text-accent' : 'text-success'">
            {{ m.role === 'user' ? t('mobile.chat.roleUser') : t('mobile.chat.roleAssistant') }}
          </span>
          <div
            class="max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm"
            :class="m.role === 'user' ? 'bg-accent text-white' : 'bg-surface text-fg'"
          >{{ normalizeContent(m.content) }}</div>
        </li>
      </ul>
    </div>

    <!-- composer -->
    <MobileComposer @send="handleSend" />
  </div>
</template>
