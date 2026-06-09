# Plan 05: State Layer + App Shell v3

> **Tasks 5 & 6**: Pinia Stores + Composables + App Shell with streaming architecture
> **Prerequisite**: Task 4 (communication layer) complete — WS client, event bus, protocol types exist.
> **Based on**: plan-05-state-shell.md + plan-patches.md §2 + arch-optimization-v2.md §2.2 (Stable List + Streaming)
> **Supersedes**: plan-05-state-shell.md + plan-patches.md §2

---

## Key Changes from v2

1. **Chat store split** — `messages[]` → `completedMessages[]` + `streamingMessage` (stable list pattern)
2. **State-driven view switching** — `settingsStore.currentView` + `focusMode` (no vue-router)
3. **Streaming architecture in App.vue** — wires stable list + streaming container
4. **Connection status composable** — `useConnection` with reconnect + statusbar integration
5. **Context percentage tracking** — `useContext` composable for context bar display
6. **Shared type imports** — all types from `@xyz-agent/shared`
7. **Tauri global shortcuts** — Rust-side placeholder + frontend keydown listeners

---

## File Structure

```
src/
├── stores/
│   ├── chat.ts               # useChatStore — stable list + streaming message
│   ├── session.ts            # useSessionStore
│   └── settings.ts           # useSettingsStore — currentView + focusMode + persisted
├── composables/
│   ├── useChat.ts             # Send/abort + stream event → store (uses rAF batching)
│   ├── useSession.ts          # Session CRUD via WS
│   ├── useProvider.ts         # Provider config management
│   ├── useModel.ts            # Model list + switch + grouped
│   ├── useConnection.ts      # WS lifecycle + reconnect + status for statusbar
│   └── useContext.ts          # Context window usage tracking + compact trigger
├── components/
│   ├── layout/
│   │   ├── AppHeader.vue     # Logo + connection dot + view modes + settings + theme
│   │   ├── AppSidebar.vue    # Session groups (placeholder, Task 7 fills in)
│   │   └── AppStatusbar.vue  # Connection + cwd + model + token + shortcuts
│   └── chat/
│       └── ChatView.vue      # Stable list + streaming container
├── App.vue                    # State-driven view switching + keyboard shortcuts
└── main.ts                    # Pinia + i18n + slash commands (from plan-02)
```

---

# Task 5: State Layer — Pinia Stores + Composables

## Step 1: Install remaining deps (if not done in plan-02)

- [ ] Confirm `pinia`, `pinia-plugin-persistedstate` installed

```bash
npm ls pinia pinia-plugin-persistedstate
```

## Step 2: `src/stores/settings.ts` — useSettingsStore

- [ ] Create settings store with `currentView` + `focusMode`

```ts
// src/stores/settings.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type Theme = 'light' | 'dark' | 'system'
export type Locale = 'zh-CN' | 'en-US'
export type AppView = 'chat' | 'settings'

export const useSettingsStore = defineStore('settings', () => {
  // ── Persisted state ──
  const theme = ref<Theme>('system')
  const locale = ref<Locale>('zh-CN')
  const defaultModel = ref<string>('')

  // ── Session state (not persisted) ──
  const currentView = ref<AppView>('chat')
  const focusMode = ref(false)

  // ── Computed ──
  const effectiveTheme = computed<'light' | 'dark'>(() => {
    if (theme.value !== 'system') return theme.value
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  })

  // ── Actions ──
  function setTheme(value: Theme) { theme.value = value }
  function setLocale(value: Locale) { locale.value = value }
  function setDefaultModel(modelId: string) { defaultModel.value = modelId }

  return {
    theme, locale, defaultModel,
    currentView, focusMode,
    effectiveTheme,
    setTheme, setLocale, setDefaultModel,
  }
}, {
  persist: {
    pick: ['theme', 'locale', 'defaultModel'],
    // currentView and focusMode NOT persisted — default to 'chat' + standard on each launch
  },
})
```

## Step 3: `src/stores/chat.ts` — useChatStore (Stable List + Streaming Split)

> **Core change from v2**: Messages split into `completedMessages` (frozen, never re-rendered) and `streamingMessage` (single reactive point). This eliminates the jank caused by re-rendering the entire message list on every text delta.

- [ ] Create chat store with stable list pattern

```ts
// src/stores/chat.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Message, ToolCall, Usage } from '@xyz-agent/shared'

/**
 * The single streaming assistant message.
 * Only this object is reactive during generation — completedMessages stays frozen.
 */
export interface StreamingAssistantMessage {
  id: string
  textContent: string
  thinkingContent: string
  toolCalls: ToolCall[]
  startedAt: number
}

export const useChatStore = defineStore('chat', () => {
  // ── State: Stable List ──
  /** Completed messages — frozen, never updated after being pushed. */
  const completedMessages = ref<Message[]>([])

  /** The single streaming assistant message. Null when not generating. */
  const streamingMessage = ref<StreamingAssistantMessage | null>(null)

  /** Whether the agent is currently generating. */
  const isGenerating = ref(false)

  /** Token usage for current session. */
  const tokenUsage = ref(0)

  /** Context window usage percentage (0–100). Updated by context events. */
  const contextUsagePercent = ref(0)

  // ── Computed ──
  const allMessageCount = computed(() => {
    return completedMessages.value.length + (streamingMessage.value ? 1 : 0)
  })

  // ── Actions: Streaming ──

  /** Start a new streaming assistant message. */
  function startStreaming(messageId: string): void {
    streamingMessage.value = {
      id: messageId,
      textContent: '',
      thinkingContent: '',
      toolCalls: [],
      startedAt: Date.now(),
    }
    isGenerating.value = true
  }

  /** Append text delta to streaming message. Called from rAF batcher. */
  function appendTextDelta(delta: string): void {
    if (streamingMessage.value) {
      streamingMessage.value.textContent += delta
    }
  }

  /** Append thinking delta to streaming message. */
  function appendThinkingDelta(delta: string): void {
    if (streamingMessage.value) {
      streamingMessage.value.thinkingContent += delta
    }
  }

  /** Add a tool call to the streaming message. */
  function addStreamingToolCall(toolCall: ToolCall): void {
    if (streamingMessage.value) {
      streamingMessage.value.toolCalls = [...streamingMessage.value.toolCalls, toolCall]
    }
  }

  /** Update a streaming tool call by ID. */
  function updateStreamingToolCall(toolCallId: string, update: Partial<ToolCall>): void {
    if (!streamingMessage.value) return
    const idx = streamingMessage.value.toolCalls.findIndex((tc) => tc.id === toolCallId)
    if (idx !== -1) {
      const updated = { ...streamingMessage.value.toolCalls[idx], ...update }
      streamingMessage.value.toolCalls = [
        ...streamingMessage.value.toolCalls.slice(0, idx),
        updated,
        ...streamingMessage.value.toolCalls.slice(idx + 1),
      ]
    }
  }

  /** Finalize streaming message → move to completedMessages. */
  function finalizeStreamingMessage(usage: Usage, stopReason: string): void {
    const streaming = streamingMessage.value
    if (!streaming) return

    const finalMessage: Message = {
      id: streaming.id,
      role: 'assistant',
      content: streaming.textContent,
      thinking: streaming.thinkingContent ? [{ text: streaming.thinkingContent }] : undefined,
      toolCalls: streaming.toolCalls.length > 0 ? streaming.toolCalls : undefined,
      usage,
      stopReason,
      timestamp: Date.now(),
    }
    completedMessages.value = [...completedMessages.value, finalMessage]
    streamingMessage.value = null
    isGenerating.value = false
    if (usage.totalTokens) {
      tokenUsage.value = usage.totalTokens
    }
  }

  // ── Actions: General ──

  /** Add a user message directly. */
  function addUserMessage(content: string): void {
    const msg: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }
    completedMessages.value = [...completedMessages.value, msg]
  }

  /** Update context usage percentage. */
  function setContextUsagePercent(pct: number): void {
    contextUsagePercent.value = pct
  }

  /** Clear all messages (e.g., on session switch). */
  function clearMessages(): void {
    completedMessages.value = []
    streamingMessage.value = null
    isGenerating.value = false
    tokenUsage.value = 0
    contextUsagePercent.value = 0
  }

  return {
    // State
    completedMessages,
    streamingMessage,
    isGenerating,
    tokenUsage,
    contextUsagePercent,
    // Computed
    allMessageCount,
    // Actions
    startStreaming,
    appendTextDelta,
    appendThinkingDelta,
    addStreamingToolCall,
    updateStreamingToolCall,
    finalizeStreamingMessage,
    addUserMessage,
    setContextUsagePercent,
    clearMessages,
  }
})
```

## Step 4: `src/stores/session.ts` — useSessionStore

- [ ] Create session store (unchanged from v2, but shared type imports)

```ts
// src/stores/session.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SessionSummary } from '@xyz-agent/shared'

export interface SessionGroup {
  cwd: string
  label: string
  sessions: SessionSummary[]
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<SessionSummary[]>([])
  const currentSessionId = ref<string | null>(null)

  const currentSession = computed<SessionSummary | null>(() => {
    if (!currentSessionId.value) return null
    return sessions.value.find((s) => s.id === currentSessionId.value) ?? null
  })

  const groupedSessions = computed<SessionGroup[]>(() => {
    const groupMap = new Map<string, SessionSummary[]>()
    for (const session of sessions.value) {
      const cwd = session.cwd || '/unknown'
      if (!groupMap.has(cwd)) groupMap.set(cwd, [])
      groupMap.get(cwd)!.push(session)
    }

    const groups: SessionGroup[] = []
    for (const [cwd, items] of groupMap) {
      const sorted = [...items].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      const parts = cwd.split('/').filter(Boolean)
      const label = parts.length > 0 ? parts[parts.length - 1] : cwd
      groups.push({ cwd, label, sessions: sorted })
    }

    groups.sort((a, b) => {
      const aLatest = a.sessions[0]?.lastActiveAt ?? 0
      const bLatest = b.sessions[0]?.lastActiveAt ?? 0
      return bLatest - aLatest
    })

    return groups
  })

  function loadSessions(list: SessionSummary[]) { sessions.value = list }
  function addSession(session: SessionSummary) {
    sessions.value = [...sessions.value, session]
  }
  function removeSession(sessionId: string) {
    sessions.value = sessions.value.filter((s) => s.id !== sessionId)
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = sessions.value.length > 0 ? sessions.value[0].id : null
    }
  }
  function switchSession(sessionId: string) { currentSessionId.value = sessionId }
  function clearSessions() { sessions.value = []; currentSessionId.value = null }

  return {
    sessions, currentSessionId, currentSession, groupedSessions,
    loadSessions, addSession, removeSession, switchSession, clearSessions,
  }
})
```

## Step 5: `src/composables/useConnection.ts` — WS Connection Lifecycle

- [ ] Create connection composable with reconnect + status for statusbar

```ts
// src/composables/useConnection.ts
import { ref, computed, onUnmounted } from 'vue'
import { wsClient } from '../lib/ws-client'
import { useI18n } from 'vue-i18n'

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting'

/**
 * Provides connection status for AppHeader (dot) and AppStatusbar (text).
 * Manages WS lifecycle: connect, disconnect, exponential backoff reconnect.
 */
export function useConnection() {
  const status = ref<ConnectionStatus>('disconnected')
  const reconnectCount = ref(0)
  const maxReconnectAttempts = 10
  const baseDelay = 1000

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const isConnected = computed(() => status.value === 'connected')

  const statusText = computed(() => {
    switch (status.value) {
      case 'connected': return '已连接'
      case 'disconnected': return '未连接'
      case 'reconnecting': return `重连中 (${reconnectCount.value}/${maxReconnectAttempts})`
    }
  })

  function connect(url?: string) {
    const wsUrl = url ?? 'ws://localhost:3210'
    status.value = 'disconnected'
    reconnectCount.value = 0

    wsClient.connect(wsUrl)

    wsClient.onOpen(() => {
      status.value = 'connected'
      reconnectCount.value = 0
    })

    wsClient.onClose(() => {
      status.value = 'disconnected'
      scheduleReconnect(wsUrl)
    })

    wsClient.onError(() => {
      status.value = 'disconnected'
      scheduleReconnect(wsUrl)
    })
  }

  function disconnect() {
    clearReconnectTimer()
    wsClient.disconnect()
    status.value = 'disconnected'
  }

  function scheduleReconnect(url: string) {
    if (reconnectCount.value >= maxReconnectAttempts) return
    clearReconnectTimer()

    const delay = baseDelay * Math.pow(2, reconnectCount.value)
    reconnectCount.value++
    status.value = 'reconnecting'

    reconnectTimer = setTimeout(() => {
      wsClient.connect(url)
    }, delay)
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  onUnmounted(() => { clearReconnectTimer() })

  return { status, isConnected, statusText, connect, disconnect }
}
```

## Step 6: `src/composables/useContext.ts` — Context Usage Tracking

> **NEW**: Tracks context window usage percentage and provides compact trigger.

- [ ] Create context usage composable

```ts
// src/composables/useContext.ts
import { computed } from 'vue'
import { useChatStore } from '../stores/chat'
import { wsClient } from '../lib/ws-client'

/**
 * Context window usage tracking.
 * Reads contextUsagePercent from chatStore (updated by WS events).
 * Provides color classification for ContextBar and compact trigger.
 */
export function useContext() {
  const chatStore = useChatStore()

  /** 0–100 percentage of context window used. */
  const usagePercent = computed(() => chatStore.contextUsagePercent)

  /** Color variant for ContextBar. */
  const usageColor = computed<'accent' | 'warning' | 'danger'>(() => {
    const pct = chatStore.contextUsagePercent
    if (pct > 95) return 'danger'
    if (pct > 80) return 'warning'
    return 'accent'
  })

  /** Whether to show a "compact recommended" hint. */
  const compactRecommended = computed(() => chatStore.contextUsagePercent > 80)

  /** Trigger manual context compaction via WS command. */
  function triggerCompact(): void {
    wsClient.send({
      type: 'session.compact',
      id: `req-${Date.now()}`,
      payload: {},
    })
  }

  return { usagePercent, usageColor, compactRecommended, triggerCompact }
}
```

## Step 7: `src/composables/useChat.ts` — Send/Abort + Stream Events (with rAF batching)

- [ ] Create chat composable using rAF batching for text deltas

```ts
// src/composables/useChat.ts
import { onUnmounted } from 'vue'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import { useRafBatch } from './useRafBatch'
import { useToast } from './useToast'
import type { ToolCall } from '@xyz-agent/shared'

/**
 * Chat message send/abort + stream event processing.
 * Uses rAF batching for text deltas (from plan-02 useRafBatch).
 */
export function useChat() {
  const chatStore = useChatStore()
  const sessionStore = useSessionStore()
  const { error: showError } = useToast()
  const { flushed, append, reset } = useRafBatch()

  // ── Event handlers ──
  function handleTextDelta(data: { sessionId: string; delta: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    // Batch delta through rAF — flushed.value updates once per frame
    append(data.delta)
  }

  function handleThinkingDelta(data: { sessionId: string; delta: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.appendThinkingDelta(data.delta)
  }

  function handleToolCallStart(data: { sessionId: string; toolCallId: string; toolName: string; input: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    const toolCall: ToolCall = {
      id: data.toolCallId,
      toolName: data.toolName,
      input: data.input,
      status: 'running',
    }
    chatStore.addStreamingToolCall(toolCall)
  }

  function handleToolCallEnd(data: { sessionId: string; toolCallId: string; output: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.updateStreamingToolCall(data.toolCallId, {
      output: data.output,
      status: 'completed',
    })
  }

  function handleComplete(data: { sessionId: string; stopReason: string; usage?: { totalTokens: number } }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    // Flush any remaining buffered text before finalizing
    chatStore.appendTextDelta(flushed.value.slice(chatStore.streamingMessage?.textContent.length ?? 0))
    chatStore.finalizeStreamingMessage(
      data.usage ?? { totalTokens: 0 },
      data.stopReason,
    )
    reset()
  }

  function handleError(data: { sessionId: string; error: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.finalizeStreamingMessage({ totalTokens: 0 }, 'error')
    reset()
    showError(data.error)
  }

  // ── rAF flush sync ──
  // Watch flushed.value and sync to chatStore on each frame
  let lastFlushedLength = 0
  function syncFlushed() {
    const current = flushed.value
    if (current.length > lastFlushedLength) {
      const newDelta = current.slice(lastFlushedLength)
      chatStore.appendTextDelta(newDelta)
      lastFlushedLength = current.length
    }
  }

  // Use a watcher to sync flushed text into store on each rAF
  // This is called from the rAF callback in useRafBatch
  const originalAppend = append
  // Override: after each append, schedule a sync
  // Actually, the sync should happen inside the rAF flush.
  // We modify our approach: instead of double-buffering, we directly update the store
  // but only once per rAF.

  // ── Simplified: use rAF to coalesce updates ──
  // The rAF batcher accumulates text. On each frame, we read flushed.value
  // and push the new portion to chatStore.

  // Watch for changes to flushed and sync
  let rafSyncId: number | null = null
  function scheduleSync() {
    if (rafSyncId === null) {
      rafSyncId = requestAnimationFrame(() => {
        syncFlushed()
        rafSyncId = null
      })
    }
  }

  // ── Public API ──
  function sendMessage(content: string) {
    const sessionId = sessionStore.currentSessionId
    if (!sessionId) return

    chatStore.addUserMessage(content)
    chatStore.startStreaming(`msg-${Date.now()}`)
    lastFlushedLength = 0
    reset()

    wsClient.send({
      type: 'message.send',
      id: `req-${Date.now()}`,
      payload: { sessionId, content },
    })
  }

  function abort() {
    const sessionId = sessionStore.currentSessionId
    if (!sessionId || !chatStore.isGenerating) return

    wsClient.send({
      type: 'message.abort',
      id: `req-${Date.now()}`,
      payload: { sessionId },
    })

    chatStore.finalizeStreamingMessage({ totalTokens: 0 }, 'aborted')
    reset()
    lastFlushedLength = 0
  }

  // ── Lifecycle ──
  function setupListeners() {
    eventBus.on('message.text_delta', handleTextDelta)
    eventBus.on('message.thinking_delta', handleThinkingDelta)
    eventBus.on('message.tool_call_start', handleToolCallStart)
    eventBus.on('message.tool_call_end', handleToolCallEnd)
    eventBus.on('message.complete', handleComplete)
    eventBus.on('message.error', handleError)
    eventBus.on('context.update', (data: { percent: number }) => {
      chatStore.setContextUsagePercent(data.percent)
    })
  }

  function cleanupListeners() {
    eventBus.off('message.text_delta', handleTextDelta)
    eventBus.off('message.thinking_delta', handleThinkingDelta)
    eventBus.off('message.tool_call_start', handleToolCallStart)
    eventBus.off('message.tool_call_end', handleToolCallEnd)
    eventBus.off('message.complete', handleComplete)
    eventBus.off('message.error', handleError)
  }

  setupListeners()
  onUnmounted(cleanupListeners)

  return { sendMessage, abort }
}
```

## Step 8: `src/composables/useSession.ts` — Session CRUD

- [ ] Create session composable (shared type imports)

```ts
// src/composables/useSession.ts
import { onUnmounted } from 'vue'
import { useSessionStore } from '../stores/session'
import { useChatStore } from '../stores/chat'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import type { SessionSummary } from '@xyz-agent/shared'
import type { Message } from '@xyz-agent/shared'

export function useSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  function setupListeners() {
    eventBus.on('session.list', handleSessionList)
    eventBus.on('session.created', handleSessionCreated)
    eventBus.on('session.deleted', handleSessionDeleted)
    eventBus.on('session.history', handleSessionHistory)
  }

  function cleanupListeners() {
    eventBus.off('session.list', handleSessionList)
    eventBus.off('session.created', handleSessionCreated)
    eventBus.off('session.deleted', handleSessionDeleted)
    eventBus.off('session.history', handleSessionHistory)
  }

  function requestSessionList() {
    wsClient.send({ type: 'session.list', id: `req-${Date.now()}`, payload: {} })
  }

  function createSession(cwd?: string) {
    wsClient.send({ type: 'session.create', id: `req-${Date.now()}`, payload: { cwd } })
  }

  function deleteSession(sessionId: string) {
    wsClient.send({ type: 'session.delete', id: `req-${Date.now()}`, payload: { sessionId } })
  }

  function switchSession(sessionId: string) {
    wsClient.send({ type: 'session.switch', id: `req-${Date.now()}`, payload: { sessionId } })
    sessionStore.switchSession(sessionId)
    chatStore.clearMessages()
  }

  function handleSessionList(data: { sessions: SessionSummary[] }) {
    sessionStore.loadSessions(data.sessions)
    if (!sessionStore.currentSessionId && data.sessions.length > 0) {
      sessionStore.switchSession(data.sessions[0].id)
    }
  }

  function handleSessionCreated(data: { sessionId: string; label: string; cwd: string }) {
    const session: SessionSummary = {
      id: data.sessionId, label: data.label, cwd: data.cwd,
      lastActiveAt: Date.now(), status: 'active',
    }
    sessionStore.addSession(session)
    sessionStore.switchSession(data.sessionId)
    chatStore.clearMessages()
  }

  function handleSessionDeleted(data: { sessionId: string }) {
    sessionStore.removeSession(data.sessionId)
    if (sessionStore.currentSessionId === null) chatStore.clearMessages()
  }

  function handleSessionHistory(data: { sessionId: string; messages: Message[] }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.clearMessages()
    for (const msg of data.messages) {
      // History messages go directly into completedMessages
      chatStore.completedMessages = [...chatStore.completedMessages, msg]
    }
  }

  setupListeners()
  onUnmounted(cleanupListeners)

  return { requestSessionList, createSession, deleteSession, switchSession }
}
```

## Step 9: `src/composables/useProvider.ts` — Provider Config

- [ ] Create provider composable

```ts
// src/composables/useProvider.ts
import { ref, onUnmounted } from 'vue'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import type { ProviderInfo } from '@xyz-agent/shared'

export function useProvider() {
  const providers = ref<ProviderInfo[]>([])
  const loading = ref(false)

  function setupListeners() {
    eventBus.on('config.providers', handleProviders)
    eventBus.on('config.providerUpdated', handleProviderUpdated)
  }
  function cleanupListeners() {
    eventBus.off('config.providers', handleProviders)
    eventBus.off('config.providerUpdated', handleProviderUpdated)
  }

  function requestProviders() {
    loading.value = true
    wsClient.send({ type: 'config.getProviders', id: `req-${Date.now()}`, payload: {} })
  }

  function setProvider(providerId: string, config: Record<string, unknown>) {
    wsClient.send({ type: 'config.setProvider', id: `req-${Date.now()}`, payload: { providerId, ...config } })
  }

  function deleteProvider(providerId: string) {
    wsClient.send({ type: 'config.deleteProvider', id: `req-${Date.now()}`, payload: { providerId } })
  }

  function handleProviders(data: { providers: ProviderInfo[] }) {
    providers.value = data.providers
    loading.value = false
  }

  function handleProviderUpdated(data: { providerId: string }) {
    requestProviders()
  }

  setupListeners()
  onUnmounted(cleanupListeners)

  return { providers, loading, requestProviders, setProvider, deleteProvider }
}
```

## Step 10: `src/composables/useModel.ts` — Model List + Switch

- [ ] Create model composable

```ts
// src/composables/useModel.ts
import { ref, computed, onUnmounted } from 'vue'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../stores/settings'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import type { ModelInfo } from '@xyz-agent/shared'

export function useModel() {
  const sessionStore = useSessionStore()
  const settingsStore = useSettingsStore()

  const models = ref<ModelInfo[]>([])
  const currentModelId = ref<string>(settingsStore.defaultModel)
  const loading = ref(false)

  const modelsByProvider = computed(() => {
    const groupMap = new Map<string, ModelInfo[]>()
    for (const model of models.value) {
      if (!groupMap.has(model.providerId)) groupMap.set(model.providerId, [])
      groupMap.get(model.providerId)!.push(model)
    }
    return groupMap
  })

  const currentModel = computed<ModelInfo | null>(() => {
    if (!currentModelId.value) return null
    return models.value.find((m) => m.id === currentModelId.value) ?? null
  })

  const currentModelLabel = computed(() => {
    const model = currentModel.value
    if (!model) return '未选择模型'
    return `${model.name} @ ${model.providerName}`
  })

  function setupListeners() {
    eventBus.on('model.list', handleModelList)
    eventBus.on('model.switched', handleModelSwitched)
  }
  function cleanupListeners() {
    eventBus.off('model.list', handleModelList)
    eventBus.off('model.switched', handleModelSwitched)
  }

  function requestModels() {
    loading.value = true
    wsClient.send({ type: 'model.list', id: `req-${Date.now()}`, payload: {} })
  }

  function switchModel(modelId: string) {
    const sessionId = sessionStore.currentSessionId
    if (!sessionId) return
    currentModelId.value = modelId
    wsClient.send({ type: 'model.switch', id: `req-${Date.now()}`, payload: { sessionId, modelId } })
  }

  function handleModelList(data: { models: ModelInfo[] }) {
    models.value = data.models
    loading.value = false
    if (!currentModelId.value && data.models.length > 0) {
      currentModelId.value = settingsStore.defaultModel || data.models[0].id
    }
  }

  function handleModelSwitched(data: { sessionId: string; modelId: string }) {
    if (data.sessionId === sessionStore.currentSessionId) {
      currentModelId.value = data.modelId
    }
  }

  setupListeners()
  onUnmounted(cleanupListeners)

  return {
    models, currentModelId, currentModel, currentModelLabel, modelsByProvider, loading,
    requestModels, switchModel,
  }
}
```

## Task 5 Verification

- [ ] `npx vue-tsc --noEmit`
- [ ] `npm run lint`
- [ ] `ls -la src/stores/ src/composables/`

## Task 5 Commit

- [ ] `git add -A && git commit -m "feat(p1): state layer — stores (stable list + streaming) + composables + connection + context tracking"`

---

# Task 6: App Shell — Layout Components

## Step 11: `src/components/layout/AppHeader.vue`

- [ ] Create header with connection dot, active view states, shortcut hints

```vue
<!-- src/components/layout/AppHeader.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { useConnection } from '../../composables/useConnection'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const { status, isConnected } = useConnection()

const emit = defineEmits<{
  toggleSidebar: []
  openSettings: []
}>()

function toggleTheme() {
  const current = settingsStore.theme
  settingsStore.setTheme(current === 'light' ? 'dark' : current === 'dark' ? 'light' : 'light')
}
</script>

<template>
  <header
    data-slot="app-header"
    :class="cn(
      'flex items-center justify-between h-12 px-4',
      'bg-surface border-b border-border',
      'select-none',
    )"
  >
    <!-- Left: Logo + sidebar toggle -->
    <div class="flex items-center gap-2">
      <button
        class="p-1 rounded-sm hover:bg-bg-base transition-colors"
        :aria-label="t('header.toggleSidebar')"
        @click="emit('toggleSidebar')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </button>
      <span class="font-display text-lg font-semibold text-text-primary">xyz-agent</span>
    </div>

    <!-- Center: Connection status -->
    <div class="flex items-center gap-2">
      <span
        :class="cn(
          'w-2 h-2 rounded-full',
          isConnected ? 'bg-success' : 'bg-danger',
        )"
        :title="isConnected ? t('status.connected') : t('status.disconnected')"
      />
    </div>

    <!-- Right: View modes + Settings + Theme -->
    <div class="flex items-center gap-1">
      <!-- Standard mode -->
      <button
        :class="cn(
          'p-1.5 rounded-sm transition-colors',
          !settingsStore.focusMode ? 'bg-accent-light text-accent' : 'hover:bg-bg-base text-text-muted',
        )"
        :title="`${t('header.standardView')} (⌘1)`"
        @click="settingsStore.focusMode = false"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </button>

      <!-- Split placeholder (P4, disabled) -->
      <button class="p-1.5 rounded-sm opacity-30 cursor-not-allowed" disabled>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M12 3v18" />
        </svg>
      </button>

      <!-- Focus mode -->
      <button
        :class="cn(
          'p-1.5 rounded-sm transition-colors',
          settingsStore.focusMode ? 'bg-accent-light text-accent' : 'hover:bg-bg-base text-text-muted',
        )"
        :title="`${t('header.focusView')} (⌘3)`"
        @click="settingsStore.focusMode = true"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
        </svg>
      </button>

      <!-- Divider -->
      <div class="w-px h-5 bg-border mx-1" />

      <!-- Settings -->
      <button
        class="p-1.5 rounded-sm hover:bg-bg-base transition-colors text-text-muted"
        :title="`${t('header.settings')} (⌘,)`"
        @click="emit('openSettings')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      <!-- Theme toggle -->
      <button
        class="p-1.5 rounded-sm hover:bg-bg-base transition-colors text-text-muted"
        :aria-label="t('header.toggleTheme')"
        @click="toggleTheme"
      >
        <svg v-if="settingsStore.effectiveTheme === 'light'"
          xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <svg v-else
          xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      </button>
    </div>
  </header>
</template>
```

## Step 12: `src/components/layout/AppStatusbar.vue`

- [ ] Create statusbar with 3-state connection dot + cwd + model + shortcuts

```vue
<!-- src/components/layout/AppStatusbar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useConnection, type ConnectionStatus } from '../../composables/useConnection'
import { useSessionStore } from '../../stores/session'
import { useModel } from '../../composables/useModel'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const { status, isConnected, statusText } = useConnection()
const sessionStore = useSessionStore()
const { currentModelLabel } = useModel()

function statusDotClass(s: ConnectionStatus): string {
  return cn(
    'w-2 h-2 rounded-full shrink-0',
    s === 'connected' && 'bg-success',
    s === 'reconnecting' && 'bg-warning',
    s === 'disconnected' && 'bg-danger',
  )
}

function shortCwd(): string {
  const cwd = sessionStore.currentSession?.cwd
  if (!cwd) return '~'
  const parts = cwd.split('/').filter(Boolean)
  return '~/' + parts.slice(-2).join('/')
}
</script>

<template>
  <footer
    data-slot="app-statusbar"
    :class="cn(
      'flex items-center justify-between h-8 px-4',
      'bg-surface border-t border-border',
      'text-xs text-text-muted',
    )"
  >
    <div class="flex items-center gap-3">
      <span class="flex items-center gap-1.5">
        <span :class="statusDotClass(status)" />
        <span>{{ statusText }}</span>
      </span>
      <span class="flex items-center gap-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        {{ shortCwd() }}
      </span>
      <span>{{ currentModelLabel }}</span>
    </div>

    <div class="flex items-center gap-3 text-text-muted">
      <span>
        <kbd class="px-1 py-0.5 rounded bg-surface border border-border text-[10px]">⌘1</kbd>
        {{ t('statusbar.standard') }}
      </span>
      <span>
        <kbd class="px-1 py-0.5 rounded bg-surface border border-border text-[10px]">⌘3</kbd>
        {{ t('statusbar.focus') }}
      </span>
    </div>
  </footer>
</template>
```

## Step 13: `src/components/layout/AppSidebar.vue`

- [ ] Create sidebar shell (placeholder content, Task 7 fills in full functionality)

```vue
<!-- src/components/layout/AppSidebar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../../stores/session'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const sessionStore = useSessionStore()

defineProps<{ collapsed?: boolean }>()

const emit = defineEmits<{
  newSession: []
  selectSession: [sessionId: string]
}>()
</script>

<template>
  <aside
    data-slot="app-sidebar"
    :class="cn(
      'flex flex-col h-full bg-base border-r border-border',
      'transition-[width] duration-200',
      collapsed ? 'w-0 overflow-hidden' : 'w-[260px]',
    )"
  >
    <!-- Search placeholder -->
    <div class="px-3 pt-3 pb-2">
      <div class="h-8 rounded-md bg-surface border border-border flex items-center px-2">
        <span class="text-sm text-text-muted">{{ t('sidebar.search') }}</span>
      </div>
    </div>

    <!-- Session list placeholder -->
    <div class="flex-1 overflow-y-auto px-2">
      <div v-if="sessionStore.groupedSessions.length === 0" class="px-2 py-8 text-center">
        <p class="text-sm text-text-muted">{{ t('sidebar.empty') }}</p>
      </div>
      <div v-for="group in sessionStore.groupedSessions" :key="group.cwd" class="mb-3">
        <div class="px-2 py-1 text-xs font-medium text-text-muted truncate">{{ group.label }}</div>
        <button
          v-for="session in group.sessions"
          :key="session.id"
          :class="cn(
            'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-sm',
            'hover:bg-surface transition-colors',
            session.id === sessionStore.currentSessionId
              ? 'bg-accent-light text-text-primary'
              : 'text-text-primary',
          )"
          @click="emit('selectSession', session.id)"
        >
          <span :class="cn('w-2 h-2 rounded-full shrink-0', session.status === 'active' ? 'bg-success' : 'bg-border')" />
          <span class="truncate flex-1">{{ session.label }}</span>
        </button>
      </div>
    </div>

    <!-- New session -->
    <div class="p-3 border-t border-border">
      <button
        class="w-full py-1.5 rounded-md text-sm text-text-muted hover:bg-surface transition-colors"
        @click="emit('newSession')"
      >
        + {{ t('sidebar.newSession') }}
      </button>
    </div>
  </aside>
</template>
```

## Step 14: `src/components/chat/ChatView.vue` — Stable List + Streaming Container

> **Key v3 change**: ChatView now renders two zones: `completedMessages` (static, passed to MessageList) and `streamingMessage` (reactive, rendered by StreamingMessage). Full chat components come in plan-07; this is the shell.

- [ ] Create ChatView with streaming architecture shell

```vue
<!-- src/components/chat/ChatView.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const chatStore = useChatStore()
</script>

<template>
  <div data-slot="chat-view" class="flex flex-col h-full bg-base">
    <!-- Message area -->
    <div class="flex-1 overflow-y-auto">
      <!-- Empty state -->
      <div
        v-if="chatStore.completedMessages.length === 0 && !chatStore.streamingMessage"
        class="flex flex-col items-center justify-center h-full text-center px-8"
      >
        <h2 class="text-lg font-medium text-text-primary mb-2">{{ t('chat.emptyTitle') }}</h2>
        <p class="text-sm text-text-muted max-w-md">{{ t('chat.emptySubtitle') }}</p>
      </div>

      <!-- Completed messages (static, no reactivity churn) -->
      <div v-else class="p-4 space-y-4">
        <div
          v-for="msg in chatStore.completedMessages"
          :key="msg.id"
          :class="cn(
            'p-3 rounded-lg text-sm',
            msg.role === 'user' ? 'bg-accent-light text-text-primary ml-12' : 'bg-surface text-text-primary mr-12',
          )"
        >
          <span class="text-xs text-text-muted block mb-1">{{ msg.role }}</span>
          {{ msg.content }}
        </div>

        <!-- Streaming message (reactive, rendered live) -->
        <div v-if="chatStore.streamingMessage" class="p-3 rounded-lg bg-surface text-text-primary mr-12">
          <span class="text-xs text-text-muted block mb-1">assistant (streaming)</span>
          {{ chatStore.streamingMessage.textContent }}
          <span class="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5" />
        </div>
      </div>
    </div>

    <!-- Input area placeholder (plan-07 fills with ChatInput) -->
    <div class="border-t border-border p-4">
      <div class="w-full min-h-20 max-h-36 p-3 rounded-lg bg-surface border border-border text-sm text-text-muted">
        {{ t('chat.inputPlaceholder') }}
      </div>
    </div>
  </div>
</template>
```

## Step 15: Update `src/App.vue` — State-Driven View Switching + Keyboard Shortcuts

- [ ] Create App.vue with `settingsStore.currentView` / `focusMode` driven rendering

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { Toaster } from 'vue-sonner'
import { ThemeProvider } from './design-system/theme'
import { useSettingsStore } from './stores/settings'
import { useI18n } from 'vue-i18n'
import AppHeader from './components/layout/AppHeader.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import ChatView from './components/chat/ChatView.vue'

const settingsStore = useSettingsStore()
const { t } = useI18n()

// ── Keyboard shortcuts (P1: frontend keydown) ──
function handleKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey

  if (mod && e.key === '1') {
    e.preventDefault()
    settingsStore.focusMode = false
  }
  if (mod && e.key === '3') {
    e.preventDefault()
    settingsStore.focusMode = true
  }
  if (mod && e.key === ',') {
    e.preventDefault()
    settingsStore.currentView = settingsStore.currentView === 'settings' ? 'chat' : 'settings'
  }
  if (e.key === 'Escape' && settingsStore.currentView === 'settings') {
    settingsStore.currentView = 'chat'
  }
}

onMounted(() => { document.addEventListener('keydown', handleKeydown) })
onUnmounted(() => { document.removeEventListener('keydown', handleKeydown) })
</script>

<template>
  <ThemeProvider>
    <Toaster position="top-right" />
    <div class="flex flex-col h-screen bg-bg-base text-text-primary font-body overflow-hidden">
      <!-- Header — hidden in focus mode -->
      <AppHeader
        v-if="!settingsStore.focusMode"
        @toggle-sidebar="() => {}"
        @open-settings="settingsStore.currentView = 'settings'"
      />

      <!-- Main content -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Sidebar — chat view + standard mode only -->
        <AppSidebar
          v-if="settingsStore.currentView === 'chat' && !settingsStore.focusMode"
          @new-session="() => {}"
          @select-session="() => {}"
        />

        <!-- Chat view -->
        <ChatView v-if="settingsStore.currentView === 'chat'" />

        <!-- Settings placeholder -->
        <div
          v-if="settingsStore.currentView === 'settings'"
          class="flex-1 flex items-center justify-center bg-bg-base"
        >
          <div class="text-center">
            <h2 class="text-lg font-medium text-text-primary mb-2">{{ t('settings.title') }}</h2>
            <p class="text-sm text-text-muted mb-4">Task 8 implements full settings</p>
            <button
              class="text-sm text-accent hover:underline"
              @click="settingsStore.currentView = 'chat'"
            >
              {{ t('common.close') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Statusbar — hidden in focus mode -->
      <AppStatusbar v-if="!settingsStore.focusMode" />
    </div>
  </ThemeProvider>
</template>
```

## Step 16: Tauri Global Shortcuts Infrastructure (Rust-side placeholder)

- [ ] Add Cargo.toml dependencies for shortcuts

```toml
# src-tauri/Cargo.toml — ensure these are present:
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-global-shortcut = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
```

- [ ] Create `src-tauri/src/shortcuts.rs`

```rust
// src-tauri/src/shortcuts.rs
// P1: Placeholder — shortcuts handled by frontend keydown listeners.
// Future phases register Tauri global shortcuts for system-wide hotkey support.

use tauri::App;

pub fn register_shortcuts(_app: &App) {
    // P4+: Register Cmd+1, Cmd+3, Cmd+J, Cmd+2, Cmd+4
    // Using tauri_plugin_global_shortcut
    // Each shortcut emits a Tauri event that the frontend listens for.
}
```

- [ ] Create `src-tauri/src/main.rs`

```rust
// src-tauri/src/main.rs
mod shortcuts;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::init())
        .setup(|app| {
            shortcuts::register_shortcuts(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Task 6 Verification

- [ ] `npx vue-tsc --noEmit`
- [ ] `npm run lint`
- [ ] `npm run dev` renders visible layout:
  - [ ] Header shows "xyz-agent", view buttons, settings gear, theme toggle
  - [ ] Connection status dot (red = disconnected initially)
  - [ ] Sidebar visible (collapsible via header toggle)
  - [ ] ChatView shows empty state
  - [ ] Statusbar shows connection status, cwd, model label, shortcut hints
  - [ ] Theme toggle switches light/dark
  - [ ] `Cmd+1` / `Cmd+3` switch standard/focus mode
  - [ ] `Cmd+,` opens settings placeholder
  - [ ] `Esc` closes settings

## Task 6 Commit

- [ ] `git add -A && git commit -m "feat(p1): app shell — state-driven views, header, sidebar, statusbar, streaming architecture"`

---

## File Overview

| File | Task | Key Change from v2 |
|------|------|--------------------|
| `src/stores/settings.ts` | 5 | Added `currentView`, `focusMode` |
| `src/stores/chat.ts` | 5 | **Split**: `completedMessages` + `streamingMessage` (stable list) |
| `src/stores/session.ts` | 5 | Shared type imports |
| `src/composables/useConnection.ts` | 5 | 3-state status for statusbar |
| `src/composables/useContext.ts` | 5 | **NEW**: context usage tracking + compact trigger |
| `src/composables/useChat.ts` | 5 | rAF batching for deltas |
| `src/composables/useSession.ts` | 5 | Shared type imports |
| `src/composables/useProvider.ts` | 5 | Shared type imports |
| `src/composables/useModel.ts` | 5 | Shared type imports |
| `src/components/layout/AppHeader.vue` | 6 | Connection dot, active view states, ⌘, hint |
| `src/components/layout/AppStatusbar.vue` | 6 | 3-state dot, proper i18n |
| `src/components/layout/AppSidebar.vue` | 6 | Placeholder for Task 7 |
| `src/components/chat/ChatView.vue` | 6 | **Two-zone**: completed + streaming |
| `src/App.vue` | 6 | State-driven view switching + keyboard shortcuts |
| `src-tauri/src/shortcuts.rs` | 6 | Rust placeholder |
| `src-tauri/src/main.rs` | 6 | Tauri builder with plugins |
