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
      @toggle-batch-select="toggleBatchMode"
    />

    <div class="flex-1 flex flex-col min-w-0 min-h-0 h-0">
      <!-- chat-content: flex column for messages + input -->
      <div class="flex-1 flex flex-col min-w-0 min-h-0 relative">
        <div
          ref="chatMsgsRef"
          class="flex-1 overflow-y-auto overflow-x-hidden p-5 px-6 relative flex flex-col gap-[6px] max-w-[960px] mx-auto w-full"
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
                <div
                  v-for="group in getTurnGroups(view.messages)"
                  :key="group.key"
                  :class="['turn-group', { 'turn-group--system-only': group.messages.every(m => m.role === 'system') }]"
                >
                  <template v-for="msg in group.messages" :key="msg.id">
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
                    <MessageBubble
                      v-else
                      :message="msg"
                      :session-id="sessionId ?? ''"
                      :entry-id="msg.id"
                      :sibling-count="branchTabsMap.get(msg.id)?.length ?? 0"
                      :branch-tabs="branchTabsMap.get(msg.id) ?? []"
                      :selectable="batchMode"
                      :selected="selectedIds.has(msg.id)"
                      @toggle-select="toggleSelect(msg.id)"
                      @navigate="onNavigate"
                      @open-skill="openSkillDrawer"
                      :skill-drawer-open="skillDrawerVisible && skillDrawerName === msg.skillName"
                    />
                  </template>
                </div>
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


        <!-- Floating buttons (outline + scroll-to-bottom), outside scroll container -->
        <div class="chat-fab-container">
          <ChatOutline
            v-if="messages.length > OUTLINE_MIN_MESSAGES"
            :messages="messages"
            @scroll-to-message="scrollToMessage"
          />
          <Transition name="fab">
            <button
              v-if="showScrollBottom"
              class="scroll-fab"
              aria-label="回到底部"
              @click="handleScrollToBottom"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </Transition>
        </div>

        <!-- Widget Dock -->
        <WidgetDock :widgets="extensionWidgets" />

        <!-- Batch select bar (visible when batchMode is on) -->
        <BatchSelectBar
          v-if="batchMode"
          :selected-ids="Array.from(selectedIds)"
          @cancel="exitBatchMode"
          @copy-markdown="copyBatchAs('markdown')"
          @copy-plain="copyBatchAs('plain')"
        />

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

        <!-- Skill drawer (panel-scoped, overlays chat area) -->
        <SkillDrawer
          :visible="skillDrawerVisible"
          :skill-name="skillDrawerName"
          :skill-location="skillDrawerLocation"
          :panel-id="panelId"
          @close="closeSkillDrawer"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Message, ExtensionWidgetPayload } from '@xyz-agent/shared'
import type { PendingToolCall } from '../chat/ApprovalCard.vue'
import type { ChatMessage } from '../../stores/chat'
import { isSystemNotification } from '../../stores/chat'

import PanelBar from './PanelBar.vue'
import SystemNotification from '../chat/SystemNotification.vue'
import MessageBubble from '../chat/MessageBubble.vue'
import StreamingMessage from '../chat/StreamingMessage.vue'
import ApprovalCard from '../chat/ApprovalCard.vue'
import ChatInput from '../chat/ChatInput.vue'
import WidgetDock from '../extension/WidgetDock.vue'
import BatchSelectBar from '../chat/BatchSelectBar.vue'
import ChatOutline from '../chat/ChatOutline.vue'
import SkillDrawer from '../chat/SkillDrawer.vue'
import { useTree } from '../../composables/useTree'
import { useTreeStore } from '../../stores/tree'
import { useChatScroll } from '../../composables/useChatScroll'
import { useBatchSelect } from '../../composables/useBatchSelect'
import { groupIntoTurns } from '../../lib/message-layout'
import type { BranchTab } from '../../stores/tree'

export interface AgentOption {
  id: string
  label: string
  color?: string
}

export interface AgentView {
  agentId: string
  messages: ChatMessage[]
}

const OUTLINE_MIN_MESSAGES = 3

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
  },
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

watch(() => props.activeAgentId, (v) => { localActiveAgentId.value = v })

// ── Scroll management (extracted composable) ──
const {
  showScrollBottom,
  onChatScroll,
  handleScrollToBottom,
  scrollToMessage,
} = useChatScroll(
  () => chatMsgsRef.value,
  () => props.sessionId,
  () => props.messages.length,
  () => props.streamingMessage?.content,
  () => props.isLoadingHistory,
)

// ── Batch selection (extracted composable) ──
const {
  batchMode,
  selectedIds,
  toggleBatchMode,
  exitBatchMode,
  toggleSelect,
  copyBatchAs,
} = useBatchSelect(
  () => props.sessionId,
  () => chatMsgsRef.value,
)

// ── Tree + turn grouping ──
const tree = useTree()
const treeStore = useTreeStore()

function getTurnGroups(viewMessages: ChatMessage[]) {
  return groupIntoTurns(viewMessages)
}

const branchTabsMap = computed<Map<string, BranchTab[]>>(() => {
  if (!props.sessionId) return new Map()
  const pathNodes = treeStore.getActivePath(props.sessionId)
  const map = new Map<string, BranchTab[]>()
  for (const node of pathNodes) {
    if (node.branchTabs && node.branchTabs.length > 0) {
      map.set(node.entryId, node.branchTabs)
    }
  }
  return map
})

function onNavigate(targetId: string) {
  if (props.sessionId) {
    tree.navigate(props.sessionId, targetId)
  }
}

// ── Skill drawer state ──
const skillDrawerVisible = ref(false)
const skillDrawerName = ref('')
const skillDrawerLocation = ref<string | undefined>(undefined)

function openSkillDrawer(payload: { name: string; location?: string }) {
  skillDrawerName.value = payload.name
  skillDrawerLocation.value = payload.location
  skillDrawerVisible.value = true
}

function closeSkillDrawer() {
  skillDrawerVisible.value = false
}

function switchAgent(id: string) {
  localActiveAgentId.value = id
  emit('switch-agent', id)
}
</script>

<style scoped>
/* FAB container: absolute positioned, right column, fills parent height */
.chat-fab-container {
  position: absolute;
  top: 0;
  right: 8px;
  bottom: 0;
  width: 32px;
  z-index: 20;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding: 0 0 12px;
  gap: 8px;
}
.chat-fab-container > * {
  pointer-events: auto;
}
/* Outline button at mid-upper position */
.chat-fab-container > :first-child {
  margin-bottom: auto;
  margin-top: 120px;
}

.scroll-fab {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--muted);
  transition: all 0.2s ease;
}
.scroll-fab:hover {
  color: var(--fg);
  box-shadow: var(--shadow-md);
  border-color: var(--muted);
}

/* FAB transition */
.fab-enter-active,
.fab-leave-active {
  transition: all 0.2s ease;
}
.fab-enter-from,
.fab-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
