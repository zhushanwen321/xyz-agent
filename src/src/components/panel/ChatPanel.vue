<template>
  <div class="chat-panel">
    <PanelBar
      :agent-options="agentOptions"
      :active-agent-id="localActiveAgentId"
      :done-count="doneCount"
      :alert-count="alertCount"
      :show-close="showClose"
      @switch-agent="switchAgent"
      @open-drawer="$emit('open-drawer', $event)"
      @close-split="$emit('close-split')"
    />

    <div ref="chatMsgsRef" class="chat-msgs">
      <!-- Empty state -->
      <div v-if="messages.length === 0" class="chat-empty">
        <h2 class="chat-empty__title">开始新对话</h2>
        <p class="chat-empty__subtitle">输入消息以开始</p>
      </div>

      <template v-else>
        <!-- Only render the active agent's messages -->
        <template v-for="view in agentViews" :key="view.agentId">
          <template v-if="view.agentId === localActiveAgentId">
            <template v-for="msg in view.messages" :key="msg.id">
              <!-- System messages -->
              <SystemMessage
                v-if="msg.role === 'system'"
                :type="msg.systemType || 'done'"
                :title="msg.systemTitle || ''"
                :description="msg.systemDescription"
                :action-label="msg.systemAction"
                @action="$emit('system-action', msg)"
              />
              <!-- User / Assistant messages -->
              <MessageBubble v-else :message="msg" />
            </template>
          </template>
        </template>

        <!-- Thinking indicator: waiting for first token -->
        <div v-if="isStreaming && !streamingMessage" class="thinking-indicator">
          <div class="thinking-indicator__role">助手</div>
          <div class="thinking-indicator__bar">
            <span class="thinking-indicator__dot"></span>
            <span class="thinking-indicator__text">思考中...</span>
          </div>
        </div>

        <!-- Streaming message -->
        <StreamingMessage
          v-if="streamingMessage"
          :message="streamingMessage"
          :is-streaming="isStreaming"
        />

        <!-- Approval card -->
        <ApprovalCard
          v-if="pendingApproval"
          :pending="pendingApproval"
          @approve="$emit('approve', $event)"
          @deny="$emit('deny', $event)"
          @always-allow="$emit('always-allow', $event)"
        />
      </template>
    </div>

    <ChatInput
      :is-streaming="isStreaming"
      @send="$emit('send', $event)"
      @cancel="$emit('cancel')"
      @select-model="$emit('select-model', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { Message } from '@xyz-agent/shared'
import type { PendingToolCall } from '../chat/ApprovalCard.vue'

export interface SystemChatMessage {
  id: string
  role: 'system'
  systemType?: 'done' | 'alert'
  systemTitle?: string
  systemDescription?: string
  systemAction?: string
  timestamp: number
}

/** Chat panel message: either a real Message or a local system notification */
export type ChatMessage = Message | SystemChatMessage

import PanelBar from './PanelBar.vue'
import SystemMessage from '../chat/SystemMessage.vue'
import MessageBubble from '../chat/MessageBubble.vue'
import StreamingMessage from '../chat/StreamingMessage.vue'
import ApprovalCard from '../chat/ApprovalCard.vue'
import ChatInput from '../chat/ChatInput.vue'

export interface AgentOption {
  id: string
  label: string
  color?: string
}

export interface AgentView {
  agentId: string
  messages: ChatMessage[]
}

const props = withDefaults(
  defineProps<{
    agentOptions: AgentOption[]
    activeAgentId: string
    agentViews: AgentView[]
    messages: ChatMessage[]
    streamingMessage: Message | null
    isStreaming: boolean
    pendingApproval: PendingToolCall | null
    doneCount: number
    alertCount: number
    showClose: boolean
  }>(),
  {
    agentOptions: () => [],
    agentViews: () => [],
    messages: () => [],
    doneCount: 0,
    alertCount: 0,
    showClose: false,
  }
)

const emit = defineEmits<{
  send: [content: string]
  cancel: []
  'select-model': [modelId: string]
  approve: [toolCallId: string]
  deny: [toolCallId: string]
  'always-allow': [toolName: string]
  'open-drawer': [tab: string]
  'close-split': []
  'system-action': [msg: ChatMessage]
  'switch-agent': [agentId: string]
}>()

// Local mirror of activeAgentId so PanelBar can react instantly
const localActiveAgentId = ref(props.activeAgentId)
const chatMsgsRef = ref<HTMLElement | null>(null)

watch(
  () => props.activeAgentId,
  (v) => {
    localActiveAgentId.value = v
  }
)

// Auto-scroll to bottom when new messages arrive or streaming updates
watch(
  () => [props.messages.length, props.streamingMessage?.content],
  () => {
    nextTick(() => {
      const el = chatMsgsRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

function switchAgent(id: string) {
  localActiveAgentId.value = id
  emit('switch-agent', id)
}
</script>

<style scoped>
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.chat-panel + .chat-panel {
  border-left: 1px solid var(--border);
}
.chat-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: relative;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--muted);
}
.chat-empty__title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--fg);
}
.chat-empty__subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--muted);
}

/* Thinking indicator: shown while waiting for first token */
.thinking-indicator {
  align-self: flex-start;
  width: 80%;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  border-bottom-left-radius: var(--radius-xs);
  line-height: 1.6;
  font-size: 14px;
}
.thinking-indicator__role {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 3px;
}
.thinking-indicator__bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.thinking-indicator__dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: thinking-pulse 1.4s ease-in-out infinite;
}
.thinking-indicator__text {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.3; transform: scale(0.85); }
}
@media (prefers-reduced-motion: reduce) {
  .thinking-indicator__dot { animation: none; opacity: 0.6; }
}
</style>
