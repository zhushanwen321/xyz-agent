<template>
  <ChatPanel
    :agent-options="agentOptions"
    :active-agent-id="chatStore.activeAgentId"
    :agent-views="agentViews"
    :messages="chatStore.completedMessages"
    :streaming-message="chatStore.streamingMessage"
    :is-streaming="chatStore.isGenerating"
    :pending-approval="pendingApproval"
    :done-count="0"
    :alert-count="0"
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
import { useChat } from '../../composables/useChat'
import { send } from '../../lib/ws-client'
import { on, off } from '../../lib/event-bus'
import type { PendingToolCall } from './ApprovalCard.vue'
import ChatPanel from '../panel/ChatPanel.vue'
import type { AgentOption, AgentView } from '../panel/ChatPanel.vue'

const chatStore = useChatStore()
const settingsStore = useSettingsStore()
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

function openDrawer(_tab: string) { // eslint-disable-line @typescript-eslint/no-unused-vars
  settingsStore.openDrawer('right')
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
