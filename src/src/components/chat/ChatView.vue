<template>
  <ChatPanel
    :agent-options="agentOptions"
    :active-agent-id="chatStore.activeAgentId"
    :agent-views="agentViews"
    :messages="chatStore.completedMessages"
    :streaming-message="chatStore.streamingMessage"
    :is-streaming="chatStore.isGenerating"
    :pending-approval="pendingApproval"
    :error="chatStore.error"
    :done-count="chatStore.doneCount"
    :alert-count="chatStore.alertCount"
    :show-close="settingsStore.splitMode"
    @send="handleSend"
    @cancel="handleCancel"
    @select-model="handleSelectModel"
    @approve="handleApprove"
    @deny="handleDeny"
    @always-allow="handleAlwaysAllow"
    @open-drawer="openDrawer"
    @close-split="settingsStore.toggleSplit()"
    @switch-agent="chatStore.switchAgent($event)"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useSettingsStore } from '../../stores/settings'
import { useSessionStore } from '../../stores/session'
import { useChat } from '../../composables/useChat'
import { send } from '../../lib/ws-client'
import { on, off } from '../../lib/event-bus'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PendingToolCall } from './ApprovalCard.vue'
import ChatPanel from '../panel/ChatPanel.vue'
import type { AgentOption, AgentView } from '../panel/ChatPanel.vue'

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const sessionStore = useSessionStore()
const { sendMessage, abort } = useChat()

const pendingApproval = ref<PendingToolCall | null>(null)

const agentOptions = computed<AgentOption[]>(() => chatStore.allAgentOptions)

const agentViews = computed<AgentView[]>(() => {
  const views: AgentView[] = [
    {
      agentId: 'main',
      messages: chatStore.completedMessages,
    },
  ]
  for (const [id, msgs] of Object.entries(chatStore.agentViews)) {
    views.push({ agentId: id, messages: msgs })
  }
  return views
})

function handleSend(content: string) {
  const sid = sessionStore.currentSessionId
  if (!sid) {
    console.error('[ChatView] Cannot send: no active session')
    chatStore.setError('No active session. Please create a session first.')
    return
  }
  chatStore.setError(null)
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content,
    status: 'complete',
    timestamp: Date.now(),
  })
  console.log('[ChatView] Sending message to session:', sid)
  sendMessage(content)
}

function handleCancel() {
  abort()
}

function handleSelectModel(modelId: string) {
  const sid = sessionStore.currentSessionId
  settingsStore.defaultModel = modelId
  if (!sid) {
    console.warn('[ChatView] Model selected but no active session, will apply on next session')
    return
  }
  // modelId may be "provider/model" format, parse provider from it
  const parts = modelId.split('/')
  const provider = parts.length > 1 ? parts[0] : ''
  const model = parts.length > 1 ? parts.slice(1).join('/') : modelId
  console.log('[ChatView] Switching model:', { provider, model, sessionId: sid })
  send({ type: 'model.switch', payload: { sessionId: sid, provider, modelId: model } })
}

function handleApprove(toolCallId: string) {
  const sid = sessionStore.currentSessionId
  send({ type: 'tool.approve', payload: { sessionId: sid, toolCallId } })
  pendingApproval.value = null
}

function handleDeny(toolCallId: string) {
  const sid = sessionStore.currentSessionId
  send({ type: 'tool.deny', payload: { sessionId: sid, toolCallId } })
  pendingApproval.value = null
}

function handleAlwaysAllow(toolName: string) {
  const sid = sessionStore.currentSessionId
  send({ type: 'tool.always_allow', payload: { sessionId: sid, toolName } })
  pendingApproval.value = null
}

function openDrawer(_tab: string) { // eslint-disable-line @typescript-eslint/no-unused-vars
  settingsStore.openDrawer('right')
}

function handleToolApprovalRequest(msg: { payload: PendingToolCall }) {
  pendingApproval.value = msg.payload
}

function handleErrorMessage(msg: ServerMessage) {
  const payload = msg.payload as { message?: string; code?: string }
  console.error('[ChatView] Error from server:', payload)
  if (payload.message) {
    chatStore.setError(payload.message)
  }
}

onMounted(() => {
  on('tool.approval_request', handleToolApprovalRequest)
  on('error', handleErrorMessage)
  on('message.error', handleErrorMessage)
})

onUnmounted(() => {
  off('tool.approval_request', handleToolApprovalRequest)
  off('error', handleErrorMessage)
  off('message.error', handleErrorMessage)
})
</script>
