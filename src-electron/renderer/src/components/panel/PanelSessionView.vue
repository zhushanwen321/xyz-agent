<template>
  <ChatPanel
    :agent-options="agentOptions"
    :active-agent-id="sessionState.activeAgentId"
    :panel-id="panelId"
    :session-id="sessionId"
    :agent-views="agentViews"
    :messages="sessionState.completedMessages"
    :streaming-message="sessionState.streamingMessage"
    :is-streaming="sessionState.isGenerating"
    :pending-approval="pendingApproval"
    :done-count="sessionState.doneCount"
    :alert-count="sessionState.alertCount"
    :is-compacting="sessionState.isCompacting"
    :is-loading-history="sessionState.isLoadingHistory"
    @send="handleSend"
    @cancel="handleCancel"
    @select-model="handleSelectModel"
    @approve="handleApprove"
    @deny="handleDeny"
    @always-allow="handleAlwaysAllow"
    @open-inspector="handleOpenDrawer"
    @close-pane="handleClosePane"
    @switch-agent="handleSwitchAgent"
    @send-command="handleSendCommand"
    @local-action="handleLocalAction"
  />
</template>

<script setup lang="ts">
import { ref, computed, toRef, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '../../stores/chat'
import { usePanelStore } from '../../stores/panel'
import { useProviderStore } from '../../stores/provider'
import { useSettingsStore } from '../../stores/settings'
import { useChat } from '../../composables/useChat'
import { useTree } from '../../composables/useTree'
import { useToolApproval } from '../../composables/useToolApproval'
import { useModel } from '../../composables/useModel'
import { on, off } from '../../lib/event-bus'
import type { ServerMessage, ClientMessageType } from '@xyz-agent/shared'
import type { PendingToolCall } from '../chat/ApprovalCard.vue'
import type { AgentOption, AgentView } from './ChatPanel.vue'
import ChatPanel from './ChatPanel.vue'
import { createSystemNotification } from '../../lib/system-notification'
import { send } from '../../lib/ws-client' // 仅用于 handleSendCommand 的动态消息路由

const props = defineProps<{
  panelId: string
  sessionId: string
}>()

const chatStore = useChatStore()
const panelStore = usePanelStore()
const providerStore = useProviderStore()
const settingsStore = useSettingsStore()

const sessionIdRef = toRef(props, 'sessionId')
const { sendMessage, abort } = useChat(sessionIdRef)
const { approve: approveTool, deny: denyTool, alwaysAllow: alwaysAllowTool } = useToolApproval()
const { switchModel } = useModel()

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

function handleSend(payload: { content: string; skillName?: string; subagent?: { agent: string; task: string } }) {
  const sid = props.sessionId
  if (!sid) return
  chatStore.setError(null, sid)
  chatStore.addMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content: payload.content,
    status: 'complete',
    timestamp: Date.now(),
    ...(payload.skillName ? { skillName: payload.skillName } : {}),
  }, sid)
  sendMessage(payload.content, payload.subagent)
}

function handleSendCommand(payload: { type: string; payload: Record<string, unknown> }) {
  const sid = props.sessionId
  if (!sid) return
  // 动态路由：slash command 的通用消息转发，需绕过 discriminated union 收窄
  const msg = { type: payload.type, payload: { ...payload.payload, sessionId: sid } } as ClientMessage
  send(msg)
}

function handleLocalAction(payload: { action: string; data?: unknown }) {
  const sid = props.sessionId
  if (!sid) return

  if (payload.action === 'clear') {
    chatStore.clearMessages(sid)
  } else if (payload.action === 'help') {
    const commands = payload.data as Array<{ name: string; description: string; source: string }> ?? []
    const lines = commands.map(c => `  /${c.name} — ${c.description} [${c.source === 'builtin' ? 'CMD' : 'SK'}]`)
    chatStore.addMessage({
      ...createSystemNotification('done', '可用命令', lines.join('\n')),
      content: '',
      status: 'complete',
    }, sid)
  }
}

function handleCancel() {
  abort()
}

function handleSelectModel(modelId: string) {
  const model = providerStore.models.find(m => m.id === modelId)
  if (!model) return
  const provider = providerStore.providers.find(p => p.id === model.providerId)
  if (provider && provider.enabled === false) return
  settingsStore.defaultModel = `${model.providerId}/${model.id}`
  switchModel(props.sessionId, model.providerId, model.id)
}

function handleApprove(toolCallId: string) {
  approveTool(props.sessionId, toolCallId)
  pendingApproval.value = null
}

function handleDeny(payload: { toolCallId: string; reason?: string }) {
  denyTool(props.sessionId, payload)
  pendingApproval.value = null
}

function handleAlwaysAllow(toolName: string) {
  alwaysAllowTool(props.sessionId, toolName)
  pendingApproval.value = null
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handleOpenDrawer(_tab: string) {
  // Placeholder — drawer support for individual panes scheduled for later phase
}

function handleClosePane() {
  panelStore.closeEmptyPanel(props.panelId)
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
  // 没有 sessionId 的错误不属于任何特定 session，跳过
  if (!payload.sessionId) return
  // 使用 Pinia store 中的 sessionId（同步更新），而非 props.sessionId（异步更新）
  const currentSid = panelStore.panels.find(p => p.id === props.panelId)?.sessionId
  if (!currentSid || payload.sessionId !== currentSid) return
  const errMsg = payload.message ?? 'Unknown error'
  chatStore.abortStream(currentSid, errMsg)
}

function handleCompactionState(msg: ServerMessage, value: boolean) {
  const sid = (msg.payload as { sessionId?: string }).sessionId
  if (!sid) return
  // 使用 Pinia store 中的 sessionId（同步更新），而非 props.sessionId（异步更新）
  // 解决 session.restore → session.compacting 时序问题
  const currentSid = panelStore.panels.find(p => p.id === props.panelId)?.sessionId
  if (!currentSid || sid !== currentSid) return
  chatStore.setCompacting(value, sid)
  if (value) {
    chatStore.addMessage({
      ...createSystemNotification('done', '正在压缩上下文…', '压缩完成后会自动通知'),
      content: '',
      status: 'complete',
    }, sid)
  }
}

function handleCompacted(msg: ServerMessage) {
  const payload = msg.payload as { sessionId?: string; error?: string; status?: string }
  const sid = payload.sessionId
  if (!sid) return
  const currentSid = panelStore.panels.find(p => p.id === props.panelId)?.sessionId
  if (!currentSid || sid !== currentSid) return
  chatStore.setCompacting(false, sid)
  if (payload.error) {
    chatStore.addMessage({
      ...createSystemNotification('alert', payload.error),
      content: payload.error,
      status: 'error',
    }, sid)
  } else {
    chatStore.addMessage({
      ...createSystemNotification('done', '上下文压缩完成', '已压缩上下文以减少 token 消耗'),
      content: '',
      status: 'complete',
    }, sid)
  }
}

const onCompacting = (msg: ServerMessage) => handleCompactionState(msg, true)
const onCompacted = (msg: ServerMessage) => handleCompacted(msg)

onMounted(() => {
  chatStore.ensureSession(props.sessionId)
  // 预加载 tree 数据，避免首次打开 tree 面板时的延迟
  const { fetchTree, requestCapability } = useTree()
  fetchTree(props.sessionId)
  requestCapability(props.sessionId)
  on('message.tool_call_pending', handleToolApprovalRequest)
  on('error', handleErrorMessage)
  on('session.compacting', onCompacting)
  on('session.compacted', onCompacted)
})

onUnmounted(() => {
  off('message.tool_call_pending', handleToolApprovalRequest)
  off('error', handleErrorMessage)
  off('session.compacting', onCompacting)
  off('session.compacted', onCompacted)
})
</script>
