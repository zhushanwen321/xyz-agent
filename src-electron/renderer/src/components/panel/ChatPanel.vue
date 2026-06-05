<template>
  <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
    <PanelBar
      :agent-options="agentOptions"
      :active-agent-id="localActiveAgentId"
      :panel-id="panelId"
      :session-id="sessionId"
      :done-count="doneCount"
      :alert-count="alertCount"
      @switch-agent="switchAgent"
      @open-inspector="$emit('open-inspector', $event)"
      @close-pane="$emit('close-pane')"
    />

    <PanelBody>
      <!-- chat-content: flex column for messages + input -->
      <div class="flex-1 flex flex-col min-w-0">
        <div
          ref="chatMsgsRef"
          class="flex-1 overflow-y-auto overflow-x-hidden p-5 px-6 flex flex-col gap-[6px] relative max-w-[960px] mx-auto w-full"
          @scroll="onChatScroll"
        >
          <!-- Loading history state -->
          <div v-if="isLoadingHistory" class="flex flex-col items-center justify-center h-full p-20 px-10 gap-3 text-muted">
            <div class="flex items-center gap-2">
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0 animate-thinking-pulse motion-reduce:opacity-60 motion-reduce:animate-none"></span>
              <span class="font-mono text-[11px] leading-snug text-muted">加载对话历史...</span>
            </div>
          </div>
          <!-- Empty state (only when not loading) -->
          <div v-else-if="messages.length === 0" class="flex flex-col items-center justify-center h-full p-20 px-10 gap-3 text-muted">
            <svg class="text-border mb-2" width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
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
                  <SystemNotification
                    v-if="msg.role === 'system'"
                    :type="isSystemNotification(msg) ? (msg.notificationType || (msg.status === 'error' ? 'alert' : 'done')) : 'done'"
                    :title="isSystemNotification(msg) ? (msg.notificationTitle || '') : ''"
                    :content="msg.content ?? ''"
                    :description="isSystemNotification(msg) ? msg.notificationDescription : undefined"
                    :action-label="isSystemNotification(msg) ? msg.notificationAction : undefined"
                    @action="$emit('notification-action', msg)"
                  />
                  <!-- User / Assistant messages -->
                  <MessageBubble v-else :message="msg" />
                </template>
              </template>
            </template>

            <!-- Thinking indicator: waiting for first token -->
            <div v-if="isStreaming && !streamingMessage" class="self-start w-full p-3 px-4 bg-surface border border-border rounded-none leading-relaxed text-sm">
              <div class="text-[10px] font-semibold uppercase tracking-[0.04em] leading-[1.4] mb-[3px] text-muted">助手</div>
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
          </template>
        </div>

        <!-- Widget Dock -->
        <WidgetDock :widgets="extensionWidgets" />

        <!-- Approval card overlays ChatInput when pending -->
        <div v-if="pendingApproval" class="relative">
          <ApprovalCard
            :pending="pendingApproval"
            @approve="$emit('approve', $event)"
            @deny="$emit('deny', $event)"
            @always-allow="$emit('always-allow', $event)"
          />
        </div>
        <ChatInput
          v-else
          :is-streaming="isStreaming"
          :is-compacting="isCompacting"
          :session-id="sessionId ?? ''"
          @send="$emit('send', $event)"
          @cancel="$emit('cancel')"
          @select-model="$emit('select-model', $event)"
          @send-command="$emit('send-command', $event)"
          @local-action="$emit('local-action', $event)"
        />
      </div>

      <!-- utility-rail: scroll navigation -->
      <UtilityRail
        :show-scroll-top="showScrollTop"
        :show-scroll-bottom="showScrollBottom"
        @scroll-to-top="handleScrollToTop"
        @scroll-to-bottom="handleScrollToBottom"
      />
    </PanelBody>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import type { Message, ExtensionWidgetPayload } from '@xyz-agent/shared'
import type { PendingToolCall } from '../chat/ApprovalCard.vue'
import type { ChatMessage } from '../../stores/chat'
import { isSystemNotification } from '../../stores/chat'

import PanelBar from './PanelBar.vue'
import PanelBody from './PanelBody.vue'
import SystemNotification from '../chat/SystemNotification.vue'
import MessageBubble from '../chat/MessageBubble.vue'
import StreamingMessage from '../chat/StreamingMessage.vue'
import ApprovalCard from '../chat/ApprovalCard.vue'
import ChatInput from '../chat/ChatInput.vue'
import WidgetDock from '../extension/WidgetDock.vue'
import UtilityRail from '../chat/UtilityRail.vue'

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
    panelId?: string
    sessionId?: string | null
    agentViews: AgentView[]
    messages: ChatMessage[]
    streamingMessage: Message | null
    isStreaming: boolean
    pendingApproval: PendingToolCall | null
    doneCount: number
    alertCount: number
    isCompacting?: boolean
    isLoadingHistory?: boolean
    extensionWidgets?: ExtensionWidgetPayload[]
  }>(),
  {
    agentOptions: () => [],
    agentViews: () => [],
    messages: () => [],
    panelId: '',
    sessionId: null,
    doneCount: 0,
    alertCount: 0,
    isCompacting: false,
    isLoadingHistory: false,
    extensionWidgets: () => [],
  }
)

const emit = defineEmits<{
  send: [payload: { content: string; skillName?: string }]
  cancel: []
  'select-model': [modelId: string]
  approve: [toolCallId: string]
  deny: [payload: { toolCallId: string; reason?: string }]
  'always-allow': [toolName: string]
  'open-inspector': [tab: string]
  'close-pane': []
  'notification-action': [msg: ChatMessage]
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

/** 距离底部多少 px 以内视为「在底部」 */
const SCROLL_NEAR_BOTTOM_THRESHOLD = 80

// 智能自动滚动：底部时跟随新内容，用户上滚后不强制拉回
function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_THRESHOLD
}

// 强制滚到底部（用于 session 切换、首次加载等场景）
function forceScrollToBottom() {
  nextTick(() => {
    const el = chatMsgsRef.value
    if (el) {
      el.scrollTop = el.scrollHeight
      userAtBottom.value = true
    }
  })
}

// 记录用户是否在底部
const userAtBottom = ref(true)

// Scroll state for UtilityRail
const scrollTop = ref(0)
const scrollHeight = ref(0)
const clientHeight = ref(0)

const SCROLL_BUTTON_THRESHOLD = 40

const showScrollTop = computed(() => scrollTop.value > SCROLL_BUTTON_THRESHOLD)
const showScrollBottom = computed(() =>
  scrollTop.value + clientHeight.value < scrollHeight.value - SCROLL_BUTTON_THRESHOLD
)

function onChatScroll() {
  const el = chatMsgsRef.value
  if (el) {
    userAtBottom.value = isNearBottom(el)
    scrollTop.value = el.scrollTop
    scrollHeight.value = el.scrollHeight
    clientHeight.value = el.clientHeight
  }
}

function handleScrollToTop() {
  const el = chatMsgsRef.value
  if (el) el.scrollTop = 0
}

function handleScrollToBottom() {
  const el = chatMsgsRef.value
  if (el) el.scrollTop = el.scrollHeight
}

// 新消息 / streaming 更新时智能滚动
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

// session 切换或 history 加载完成时，强制滚到底部
watch(
  () => [props.sessionId, props.isLoadingHistory],
  ([sid, loading]) => {
    if (sid && !loading) {
      forceScrollToBottom()
    }
  },
)

// 组件首次挂载，如果已有消息也滚到底
onMounted(() => {
  if (props.messages.length > 0) {
    forceScrollToBottom()
  }
})

function switchAgent(id: string) {
  localActiveAgentId.value = id
  emit('switch-agent', id)
}
</script>
