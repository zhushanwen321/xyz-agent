<template>
  <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
    <PanelBar
      :agent-options="agentOptions"
      :active-agent-id="localActiveAgentId"
      :pane-id="paneId"
      :session-id="sessionId"
      :done-count="doneCount"
      :alert-count="alertCount"
      @switch-agent="switchAgent"
      @open-drawer="$emit('open-drawer', $event)"
      @close-pane="$emit('close-pane')"
    />

    <div ref="chatMsgsRef" class="flex-1 overflow-y-auto overflow-x-hidden p-5 px-6 flex flex-col gap-[14px] relative max-w-[960px] mx-auto w-full" @scroll="onChatScroll">
      <!-- Empty state -->
      <div v-if="messages.length === 0" class="flex flex-col items-center justify-center h-full p-20 px-10 gap-3 text-muted">
        <svg class="text-muted mb-2 opacity-50" width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 10C8 8.89543 8.89543 8 10 8H38C39.1046 8 40 8.89543 40 10V30C40 31.1046 39.1046 32 38 32H22L14 40V32H10C8.89543 32 8 31.1046 8 30V10Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M16 18H32" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M16 24H26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <h2 class="m-0 text-lg font-semibold leading-tight text-fg">开始新对话</h2>
        <p class="m-0 text-sm leading-relaxed text-muted text-center">向 AI 助手发送消息，开始一段新的对话</p>
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
        <div v-if="isStreaming && !streamingMessage" class="self-start w-full p-3 px-4 bg-surface border border-border rounded-lg leading-relaxed text-sm">
          <div class="text-[10px] font-semibold uppercase tracking-[0.04em] leading-snug text-muted mb-1.5">助手</div>
          <div class="flex items-center gap-2">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0 animate-thinking-pulse motion-reduce:opacity-60 motion-reduce:animate-none"></span>
            <span class="font-mono text-[11px] leading-snug text-muted">思考中...</span>
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
      :session-id="sessionId ?? ''"
      @send="$emit('send', $event)"
      @cancel="$emit('cancel')"
      @select-model="$emit('select-model', $event)"
      @send-command="$emit('send-command', $event)"
      @local-action="$emit('local-action', $event)"
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
    paneId?: string
    sessionId?: string | null
    agentViews: AgentView[]
    messages: ChatMessage[]
    streamingMessage: Message | null
    isStreaming: boolean
    pendingApproval: PendingToolCall | null
    doneCount: number
    alertCount: number
  }>(),
  {
    agentOptions: () => [],
    agentViews: () => [],
    messages: () => [],
    paneId: '',
    sessionId: null,
    doneCount: 0,
    alertCount: 0,
  }
)

const emit = defineEmits<{
  send: [payload: { content: string; skillName?: string }]
  cancel: []
  'select-model': [modelId: string]
  approve: [toolCallId: string]
  deny: [toolCallId: string]
  'always-allow': [toolName: string]
  'open-drawer': [tab: string]
  'close-pane': []
  'system-action': [msg: ChatMessage]
  'switch-agent': [agentId: string]
  'send-command': [payload: { type: string; payload: Record<string, unknown> }]
  'local-action': [payload: { action: string; data?: unknown }]
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

// 智能自动滚动：底部时跟随新内容，用户上滚后不强制拉回
function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

// 记录用户是否在底部
const userAtBottom = ref(true)

function onChatScroll() {
  const el = chatMsgsRef.value
  if (el) userAtBottom.value = isNearBottom(el)
}

watch(
  () => [props.messages.length, props.streamingMessage?.content],
  () => {
    nextTick(() => {
      if (!userAtBottom.value) return
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

