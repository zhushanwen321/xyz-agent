<template>
  <div class="chat-view">
    <!-- Message area: scrollable -->
    <div class="chat-messages">
      <!-- Empty state -->
      <div v-if="chatStore.completedMessages.length === 0 && !chatStore.streamingMessage" class="chat-empty">
        <h2 class="chat-empty__title">{{ t('chat.emptyTitle') }}</h2>
        <p class="chat-empty__subtitle">{{ t('chat.emptySubtitle') }}</p>
      </div>

      <template v-else>
        <!-- Zone 1: Completed messages (static) -->
        <MessageList :messages="chatStore.completedMessages" />

        <!-- Zone 2: Streaming message (reactive) -->
        <div v-if="chatStore.streamingMessage" class="chat-streaming">
          <StreamingMessage
            :message="chatStore.streamingMessage"
            :is-streaming="chatStore.isGenerating"
          />
        </div>

        <!-- Approval card (if pending) -->
        <div v-if="pendingApproval" class="chat-approval">
          <ApprovalCard
            :pending="pendingApproval"
            @approve="handleApprove"
            @deny="handleDeny"
            @always-allow="handleAlwaysAllow"
          />
        </div>
      </template>
    </div>

    <!-- Input area: fixed at bottom -->
    <ChatInput
      :is-streaming="chatStore.isGenerating"
      @send="handleSend"
      @cancel="handleCancel"
      @select-model="handleSelectModel"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { useChat } from '../../composables/useChat'
import { send } from '../../lib/ws-client'
import { on, off } from '../../lib/event-bus'
import type { PendingToolCall } from './ApprovalCard.vue'
import MessageList from './MessageList.vue'
import StreamingMessage from './StreamingMessage.vue'
import ChatInput from './ChatInput.vue'
import ApprovalCard from './ApprovalCard.vue'

const { t } = useI18n()
const chatStore = useChatStore()
const { sendMessage, abort } = useChat()

const pendingApproval = ref<PendingToolCall | null>(null)

function handleSend(content: string) {
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content,
    status: 'complete',
    timestamp: Date.now(),
  })
  sendMessage(content)
}

function handleCancel() {
  abort()
}

function handleSelectModel(modelId: string) {
  send({ type: 'model.switch', payload: { modelId } })
}

function handleApprove(toolCallId: string) {
  send({ type: 'tool.approve', payload: { toolCallId } })
  pendingApproval.value = null
}

function handleDeny(toolCallId: string) {
  send({ type: 'tool.deny', payload: { toolCallId } })
  pendingApproval.value = null
}

function handleAlwaysAllow(toolName: string) {
  send({ type: 'tool.always_allow', payload: { toolName } })
  pendingApproval.value = null
}

function handleToolApprovalRequest(msg: { payload: PendingToolCall }) {
  pendingApproval.value = msg.payload
}

onMounted(() => {
  on('tool.approval_request', handleToolApprovalRequest)
})

onUnmounted(() => {
  off('tool.approval_request', handleToolApprovalRequest)
})
</script>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

.chat-messages {
  flex: 1 1 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--color-text-muted);
}

.chat-empty__title {
  margin: 0;
  font-family: var(--font-body);
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.chat-empty__subtitle {
  margin: 0;
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--color-text-muted);
}

.chat-streaming {
  padding: 0 20px 12px;
}

.chat-approval {
  padding: 0 20px 12px;
}
</style>
