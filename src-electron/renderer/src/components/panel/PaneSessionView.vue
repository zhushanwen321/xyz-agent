<template>
  <ChatPanel
    :agent-options="agentOptions"
    :active-agent-id="sessionState.activeAgentId"
    :pane-id="paneId"
    :session-id="sessionId"
    :agent-views="agentViews"
    :messages="sessionState.completedMessages"
    :streaming-message="sessionState.streamingMessage"
    :is-streaming="sessionState.isGenerating"
    :pending-approval="pendingApproval"
    :done-count="sessionState.doneCount"
    :alert-count="sessionState.alertCount"
    @send="handleSend"
    @cancel="handleCancel"
    @select-model="handleSelectModel"
    @approve="handleApprove"
    @deny="handleDeny"
    @always-allow="handleAlwaysAllow"
    @open-drawer="handleOpenDrawer"
    @close-pane="handleClosePane"
    @switch-agent="handleSwitchAgent"
  />
</template>

<script setup lang="ts">
import { ref, computed, toRef, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '../../stores/chat'
import { usePaneStore } from '../../stores/pane'
import { useProviderStore } from '../../stores/provider'
import { useSettingsStore } from '../../stores/settings'
import { useChat } from '../../composables/useChat'
import { send } from '../../lib/ws-client'
import { on, off } from '../../lib/event-bus'
import type { ServerMessage } from '@xyz-agent/shared'
import type { PendingToolCall } from '../chat/ApprovalCard.vue'
import type { AgentOption, AgentView } from './ChatPanel.vue'
import ChatPanel from './ChatPanel.vue'

const props = defineProps<{
  paneId: string
  sessionId: string
}>()

const chatStore = useChatStore()
const paneStore = usePaneStore()
const providerStore = useProviderStore()
const settingsStore = useSettingsStore()

const sessionIdRef = toRef(props, 'sessionId')
const { sendMessage, abort } = useChat(sessionIdRef)

// Session-partitioned state — reads from reactive Map via computed
// Vue tracks reactive accesses inside computed, so changes to Map entries trigger re-evaluation
const sessionState = computed(() =>
  chatStore.getSessionState(props.sessionId)
)

const pendingApproval = ref<PendingToolCall | null>(null)

const agentOptions = computed<AgentOption[]>(() => {
  return chatStore.allAgentOptions
})

const agentViews = computed<AgentView[]>(() => {
  const state = sessionState.value
  const views: AgentView[] = [
    { agentId: 'main', messages: state.completedMessages },
  ]
  for (const [id, msgs] of Object.entries(state.agentViews)) {
    views.push({ agentId: id, messages: msgs })
  }
  return views
})

// --- Event handlers ---

function handleSend(content: string) {
  const sid = props.sessionId
  if (!sid) return
  chatStore.setError(null, sid)
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content,
    status: 'complete',
    timestamp: Date.now(),
  }, sid)
  sendMessage(content)
}

function handleCancel() {
  abort()
}

function handleSelectModel(modelId: string) {
  const model = providerStore.models.find(m => m.id === modelId)
  if (!model) return
  const provider = providerStore.providers.find(p => p.id === model.providerId)
  if (provider && provider.enabled === false) return
  // 乐观更新 UI，后端可能在非活跃 session 上静默成功
  settingsStore.defaultModel = `${model.providerId}/${model.id}`
  send({ type: 'model.switch', payload: { sessionId: props.sessionId, provider: model.providerId, modelId: model.id } })
}

function handleApprove(toolCallId: string) {
  send({ type: 'tool.approve', payload: { sessionId: props.sessionId, toolCallId } })
  pendingApproval.value = null
}

function handleDeny(toolCallId: string) {
  send({ type: 'tool.deny', payload: { sessionId: props.sessionId, toolCallId } })
  pendingApproval.value = null
}

function handleAlwaysAllow(toolName: string) {
  send({ type: 'tool.always_allow', payload: { sessionId: props.sessionId, toolName } })
  pendingApproval.value = null
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handleOpenDrawer(_tab: string) {
  // Placeholder — drawer support for individual panes scheduled for later phase
}

function handleClosePane() {
  paneStore.closeEmptyPane(props.paneId)
}

function handleSwitchAgent(agentId: string) {
  chatStore.switchAgent(agentId, props.sessionId)
}

// --- Global event handlers (not yet fully session-partitioned) ---

function handleToolApprovalRequest(msg: { payload: PendingToolCall }) {
  // TODO Phase 1C: filter by sessionId once server sends it
  pendingApproval.value = msg.payload
}

function handleErrorMessage(msg: ServerMessage) {
  const payload = msg.payload as { message?: string; code?: string; sessionId?: string }
  if (payload.sessionId && payload.sessionId !== props.sessionId) return
  const errMsg = payload.message ?? 'Unknown error'
  chatStore.setGenerating(false, props.sessionId)
  chatStore.setStreaming(null, props.sessionId)
  chatStore.setError(null, props.sessionId)
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `**Error:** ${errMsg}`,
    status: 'error',
    timestamp: Date.now(),
  }, props.sessionId)
}

onMounted(() => {
  chatStore.ensureSession(props.sessionId)
  on('tool.approval_request', handleToolApprovalRequest)
  on('error', handleErrorMessage)
})

onUnmounted(() => {
  off('tool.approval_request', handleToolApprovalRequest)
  off('error', handleErrorMessage)
})
</script>
