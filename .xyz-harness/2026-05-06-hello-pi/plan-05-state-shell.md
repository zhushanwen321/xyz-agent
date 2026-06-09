# Task 5 & 6: State Layer + App Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Pinia stores + composables (Task 5) and the App Shell layout (Task 6) with placeholder content.

**Dependencies:** Task 4 (communication layer) complete — `src/lib/ws-client.ts`, `src/lib/event-bus.ts`, `src/lib/protocol.ts`, `src/types/protocol.ts` exist.

**Commit strategy:** Commit after Task 5, commit after Task 6.

**Spec:** `.superpowers/2026-05-06-hello-pi/spec.md`

---

## 前置假设

Task 4 完成后，以下文件已存在且可用：

| 文件 | 导出内容 |
|------|---------|
| `src/lib/ws-client.ts` | `wsClient` 单例：`connect()`, `disconnect()`, `send()`, `onMessage()` |
| `src/lib/event-bus.ts` | `eventBus`：`on(event, handler)`, `off(event, handler)`, `emit(event, data)` |
| `src/lib/protocol.ts` | WS 消息类型定义 + `createMessage()` helper |
| `src/types/protocol.ts` | `ClientMessage`, `ServerMessage`, 及所有 payload 类型 |
| `src/types/message.ts` | `Message`, `ToolCall`, `ThinkingBlock` 类型 |
| `src/types/session.ts` | `Session`, `SessionSummary`, `SessionGroup` 类型 |
| `src/types/provider.ts` | `ProviderInfo`, `ModelInfo` 类型 |

若以上文件名/导出有差异，实施时按实际代码适配。

---

# Task 5: State Layer — Pinia Stores + Composables

## 文件结构

```
src/
├── stores/
│   ├── chat.ts               # useChatStore
│   ├── session.ts            # useSessionStore
│   └── settings.ts           # useSettingsStore
└── composables/
    ├── useChat.ts             # 发送消息 + 流式事件处理 + abort
    ├── useSession.ts          # Session CRUD via WS
    ├── useProvider.ts         # Provider 配置管理
    ├── useModel.ts            # 模型列表 + 切换
    └── useConnection.ts      # WS 连接生命周期 + 重连 + 状态
```

## 类型引用

以下类型假设由 Task 4 的 `src/types/` 提供。若实际名称不同，以 Task 4 产出为准。

```typescript
// src/types/message.ts
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: ToolCall[]
  thinking?: ThinkingBlock[]
  createdAt: number // timestamp
}

export interface ToolCall {
  id: string
  toolName: string
  input: string
  output?: string
  status: 'running' | 'completed' | 'error'
}

export interface ThinkingBlock {
  text: string
}

// src/types/session.ts
export interface SessionSummary {
  id: string
  label: string
  cwd: string
  lastActiveAt: number
  status: 'active' | 'idle'
}

// src/types/provider.ts
export interface ProviderInfo {
  id: string
  name: string
  connected: boolean
  models?: ModelInfo[]
}

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
}
```

---

## Step 1: Install Pinia + persistedstate

- [ ] 安装依赖

```bash
npm install pinia pinia-plugin-persistedstate
```

- [ ] 在 `src/main.ts` 中注册 Pinia（如果 Task 1 未注册）

确认 `src/main.ts` 包含：

```typescript
// src/main.ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

const app = createApp(App)
app.use(pinia)
app.mount('#app')
```

---

## Step 2: `src/stores/settings.ts` — useSettingsStore

- [ ] 创建 `src/stores/settings.ts`

```typescript
// src/stores/settings.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type Theme = 'light' | 'dark' | 'system'
export type Locale = 'zh-CN' | 'en-US'

export const useSettingsStore = defineStore('settings', () => {
  // ── State ──
  const theme = ref<Theme>('system')
  const locale = ref<Locale>('zh-CN')
  const defaultModel = ref<string>('')

  // ── Computed ──
  const effectiveTheme = computed<'light' | 'dark'>(() => {
    if (theme.value !== 'system') return theme.value
    // 系统主题检测在 ThemeProvider 中处理，这里给默认值
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  })

  // ── Actions ──
  function setTheme(value: Theme) {
    theme.value = value
  }

  function setLocale(value: Locale) {
    locale.value = value
  }

  function setDefaultModel(modelId: string) {
    defaultModel.value = modelId
  }

  return {
    theme,
    locale,
    defaultModel,
    effectiveTheme,
    setTheme,
    setLocale,
    setDefaultModel,
  }
}, {
  persist: {
    pick: ['theme', 'locale', 'defaultModel'],
  },
})
```

---

## Step 3: `src/stores/chat.ts` — useChatStore

- [ ] 创建 `src/stores/chat.ts`

```typescript
// src/stores/chat.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Message, ToolCall } from '../types/message'

export const useChatStore = defineStore('chat', () => {
  // ── State ──
  const messages = ref<Message[]>([])
  const isGenerating = ref(false)
  const streamingText = ref('')
  const currentToolCalls = ref<ToolCall[]>([])

  // ── Computed ──
  const lastMessage = computed(() => {
    return messages.value.length > 0
      ? messages.value[messages.value.length - 1]
      : null
  })

  // ── Actions ──
  function addMessage(message: Message) {
    messages.value.push(message)
  }

  function appendDelta(delta: string) {
    streamingText.value += delta
  }

  function addToolCall(toolCall: ToolCall) {
    currentToolCalls.value.push(toolCall)
  }

  function updateToolCall(toolCallId: string, update: Partial<ToolCall>) {
    const index = currentToolCalls.value.findIndex(tc => tc.id === toolCallId)
    if (index !== -1) {
      currentToolCalls.value[index] = { ...currentToolCalls.value[index], ...update }
      // 触发响应性更新
      currentToolCalls.value = [...currentToolCalls.value]
    }
  }

  function clearStream() {
    streamingText.value = ''
  }

  function setGenerating(value: boolean) {
    isGenerating.value = value
  }

  function clearMessages() {
    messages.value = []
    streamingText.value = ''
    currentToolCalls.value = []
    isGenerating.value = false
  }

  /** 将流式文本 finalize 为一条 assistant 消息 */
  function finalizeStream(content: string, toolCalls?: ToolCall[]) {
    if (content || (toolCalls && toolCalls.length > 0)) {
      const message: Message = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        toolCalls: toolCalls?.length ? toolCalls : undefined,
        createdAt: Date.now(),
      }
      messages.value.push(message)
    }
    streamingText.value = ''
    currentToolCalls.value = []
    isGenerating.value = false
  }

  return {
    messages,
    isGenerating,
    streamingText,
    currentToolCalls,
    lastMessage,
    addMessage,
    appendDelta,
    addToolCall,
    updateToolCall,
    clearStream,
    setGenerating,
    clearMessages,
    finalizeStream,
  }
})
```

---

## Step 4: `src/stores/session.ts` — useSessionStore

- [ ] 创建 `src/stores/session.ts`

```typescript
// src/stores/session.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SessionSummary } from '../types/session'

export interface SessionGroup {
  cwd: string
  label: string
  sessions: SessionSummary[]
}

export const useSessionStore = defineStore('session', () => {
  // ── State ──
  const sessions = ref<SessionSummary[]>([])
  const currentSessionId = ref<string | null>(null)

  // ── Computed ──
  const currentSession = computed<SessionSummary | null>(() => {
    if (!currentSessionId.value) return null
    return sessions.value.find(s => s.id === currentSessionId.value) ?? null
  })

  /** 按 cwd 分组，每组内按 lastActiveAt 倒序 */
  const groupedSessions = computed<SessionGroup[]>(() => {
    const groupMap = new Map<string, SessionSummary[]>()

    for (const session of sessions.value) {
      const cwd = session.cwd || '/unknown'
      if (!groupMap.has(cwd)) {
        groupMap.set(cwd, [])
      }
      groupMap.get(cwd)!.push(session)
    }

    const groups: SessionGroup[] = []
    for (const [cwd, items] of groupMap) {
      // 每组内按最后活动时间倒序
      const sorted = [...items].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      // label 取 cwd 最后一段路径
      const parts = cwd.split('/').filter(Boolean)
      const label = parts.length > 0 ? parts[parts.length - 1] : cwd
      groups.push({ cwd, label, sessions: sorted })
    }

    // 组间按组内最新 session 的时间倒序
    groups.sort((a, b) => {
      const aLatest = a.sessions[0]?.lastActiveAt ?? 0
      const bLatest = b.sessions[0]?.lastActiveAt ?? 0
      return bLatest - aLatest
    })

    return groups
  })

  // ── Actions ──
  function loadSessions(list: SessionSummary[]) {
    sessions.value = list
  }

  function addSession(session: SessionSummary) {
    sessions.value.push(session)
    // 触发响应性
    sessions.value = [...sessions.value]
  }

  function removeSession(sessionId: string) {
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    if (currentSessionId.value === sessionId) {
      currentSessionId.value = sessions.value.length > 0 ? sessions.value[0].id : null
    }
  }

  function switchSession(sessionId: string) {
    currentSessionId.value = sessionId
  }

  function clearSessions() {
    sessions.value = []
    currentSessionId.value = null
  }

  return {
    sessions,
    currentSessionId,
    currentSession,
    groupedSessions,
    loadSessions,
    addSession,
    removeSession,
    switchSession,
    clearSessions,
  }
})
```

---

## Step 5: `src/composables/useConnection.ts` — WS 连接管理

- [ ] 创建 `src/composables/useConnection.ts`

```typescript
// src/composables/useConnection.ts
import { ref, computed, onUnmounted } from 'vue'
import { wsClient } from '../lib/ws-client'

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting'

export function useConnection() {
  const status = ref<ConnectionStatus>('disconnected')
  const reconnectCount = ref(0)
  const maxReconnectAttempts = 10
  const baseDelay = 1000 // ms

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
    const wsUrl = url ?? defaultWsUrl()
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

  function defaultWsUrl(): string {
    return 'ws://localhost:3210'
  }

  onUnmounted(() => {
    clearReconnectTimer()
  })

  return {
    status,
    isConnected,
    statusText,
    connect,
    disconnect,
  }
}
```

> **注意：** `wsClient.onOpen()`, `wsClient.onClose()`, `wsClient.onError()` 的 API 以 Task 4 实际导出为准。若 Task 4 使用 event-bus 模式，则改为 `eventBus.on('ws:open', ...)` 等。

---

## Step 6: `src/composables/useChat.ts` — 消息收发 + 流式处理

- [ ] 创建 `src/composables/useChat.ts`

```typescript
// src/composables/useChat.ts
import { onUnmounted } from 'vue'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import type { ToolCall } from '../types/message'

export function useChat() {
  const chatStore = useChatStore()
  const sessionStore = useSessionStore()

  // ── 事件监听（在 composable 生命周期内自动清理） ──
  function setupListeners() {
    eventBus.on('message.text_delta', handleTextDelta)
    eventBus.on('message.thinking_delta', handleThinkingDelta)
    eventBus.on('message.tool_call_start', handleToolCallStart)
    eventBus.on('message.tool_call_end', handleToolCallEnd)
    eventBus.on('message.complete', handleComplete)
    eventBus.on('message.error', handleError)
  }

  function cleanupListeners() {
    eventBus.off('message.text_delta', handleTextDelta)
    eventBus.off('message.thinking_delta', handleThinkingDelta)
    eventBus.off('message.tool_call_start', handleToolCallStart)
    eventBus.off('message.tool_call_end', handleToolCallEnd)
    eventBus.off('message.complete', handleComplete)
    eventBus.off('message.error', handleError)
  }

  // ── 发送消息 ──
  function sendMessage(content: string) {
    const sessionId = sessionStore.currentSessionId
    if (!sessionId) return

    // 添加用户消息到 store
    chatStore.addMessage({
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      createdAt: Date.now(),
    })

    // 开始生成
    chatStore.setGenerating(true)
    chatStore.clearStream()

    // 发送到 Sidecar
    wsClient.send({
      type: 'message.send',
      id: `req-${Date.now()}`,
      payload: { sessionId, content },
    })
  }

  // ── 中断生成 ──
  function abort() {
    const sessionId = sessionStore.currentSessionId
    if (!sessionId || !chatStore.isGenerating) return

    wsClient.send({
      type: 'message.abort',
      id: `req-${Date.now()}`,
      payload: { sessionId },
    })

    // 将已流式的内容 finalize
    chatStore.finalizeStream(chatStore.streamingText, [...chatStore.currentToolCalls])
  }

  // ── 事件处理器 ──
  function handleTextDelta(data: { sessionId: string; delta: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.appendDelta(data.delta)
  }

  function handleThinkingDelta(data: { sessionId: string; delta: string }) {
    // P1 暂不实现 thinking 渲染，只保留接口
    if (data.sessionId !== sessionStore.currentSessionId) return
  }

  function handleToolCallStart(data: { sessionId: string; toolCallId: string; toolName: string; input: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    const toolCall: ToolCall = {
      id: data.toolCallId,
      toolName: data.toolName,
      input: data.input,
      status: 'running',
    }
    chatStore.addToolCall(toolCall)
  }

  function handleToolCallEnd(data: { sessionId: string; toolCallId: string; output: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.updateToolCall(data.toolCallId, {
      output: data.output,
      status: 'completed',
    })
  }

  function handleComplete(data: { sessionId: string; stopReason: string; usage?: { totalTokens: number } }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.finalizeStream(chatStore.streamingText, [...chatStore.currentToolCalls])
  }

  function handleError(data: { sessionId: string; error: string }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.setGenerating(false)
    // 错误消息也作为 assistant 消息显示
    chatStore.addMessage({
      id: `msg-error-${Date.now()}`,
      role: 'assistant',
      content: `⚠️ ${data.error}`,
      createdAt: Date.now(),
    })
  }

  // ── 生命周期 ──
  setupListeners()
  onUnmounted(cleanupListeners)

  return {
    sendMessage,
    abort,
  }
}
```

---

## Step 7: `src/composables/useSession.ts` — Session CRUD

- [ ] 创建 `src/composables/useSession.ts`

```typescript
// src/composables/useSession.ts
import { onUnmounted } from 'vue'
import { useSessionStore } from '../stores/session'
import { useChatStore } from '../stores/chat'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import type { SessionSummary } from '../types/session'
import type { Message } from '../types/message'

export function useSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  // ── 事件监听 ──
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

  // ── 请求 ──
  function requestSessionList() {
    wsClient.send({
      type: 'session.list',
      id: `req-${Date.now()}`,
      payload: {},
    })
  }

  function createSession(cwd?: string) {
    wsClient.send({
      type: 'session.create',
      id: `req-${Date.now()}`,
      payload: { cwd },
    })
  }

  function deleteSession(sessionId: string) {
    wsClient.send({
      type: 'session.delete',
      id: `req-${Date.now()}`,
      payload: { sessionId },
    })
  }

  function switchSession(sessionId: string) {
    // 先请求历史消息
    wsClient.send({
      type: 'session.switch',
      id: `req-${Date.now()}`,
      payload: { sessionId },
    })
    sessionStore.switchSession(sessionId)
    chatStore.clearMessages()
  }

  // ── 事件处理器 ──
  function handleSessionList(data: { sessions: SessionSummary[] }) {
    sessionStore.loadSessions(data.sessions)
    // 如果没有当前会话且有可用会话，自动选择第一个
    if (!sessionStore.currentSessionId && data.sessions.length > 0) {
      sessionStore.switchSession(data.sessions[0].id)
    }
  }

  function handleSessionCreated(data: { sessionId: string; label: string; cwd: string }) {
    const session: SessionSummary = {
      id: data.sessionId,
      label: data.label,
      cwd: data.cwd,
      lastActiveAt: Date.now(),
      status: 'active',
    }
    sessionStore.addSession(session)
    sessionStore.switchSession(data.sessionId)
    chatStore.clearMessages()
  }

  function handleSessionDeleted(data: { sessionId: string }) {
    sessionStore.removeSession(data.sessionId)
    // 如果删除的是当前会话，清空聊天
    if (sessionStore.currentSessionId === null) {
      chatStore.clearMessages()
    }
  }

  function handleSessionHistory(data: { sessionId: string; messages: Message[] }) {
    if (data.sessionId !== sessionStore.currentSessionId) return
    chatStore.clearMessages()
    for (const msg of data.messages) {
      chatStore.addMessage(msg)
    }
  }

  // ── 生命周期 ──
  setupListeners()
  onUnmounted(cleanupListeners)

  return {
    requestSessionList,
    createSession,
    deleteSession,
    switchSession,
  }
}
```

---

## Step 8: `src/composables/useProvider.ts` — Provider 配置管理

- [ ] 创建 `src/composables/useProvider.ts`

```typescript
// src/composables/useProvider.ts
import { ref, onUnmounted } from 'vue'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import type { ProviderInfo } from '../types/provider'

export function useProvider() {
  const providers = ref<ProviderInfo[]>([])
  const loading = ref(false)

  // ── 事件监听 ──
  function setupListeners() {
    eventBus.on('config.providers', handleProviders)
    eventBus.on('config.providerUpdated', handleProviderUpdated)
  }

  function cleanupListeners() {
    eventBus.off('config.providers', handleProviders)
    eventBus.off('config.providerUpdated', handleProviderUpdated)
  }

  // ── 请求 ──
  function requestProviders() {
    loading.value = true
    wsClient.send({
      type: 'config.getProviders',
      id: `req-${Date.now()}`,
      payload: {},
    })
  }

  function setProvider(providerId: string, config: Record<string, unknown>) {
    wsClient.send({
      type: 'config.setProvider',
      id: `req-${Date.now()}`,
      payload: { providerId, ...config },
    })
  }

  function deleteProvider(providerId: string) {
    wsClient.send({
      type: 'config.deleteProvider',
      id: `req-${Date.now()}`,
      payload: { providerId },
    })
  }

  // ── 事件处理器 ──
  function handleProviders(data: { providers: ProviderInfo[] }) {
    providers.value = data.providers
    loading.value = false
  }

  function handleProviderUpdated(data: { providerId: string }) {
    // Provider 更新后重新请求列表
    requestProviders()
  }

  // ── 生命周期 ──
  setupListeners()
  onUnmounted(cleanupListeners)

  return {
    providers,
    loading,
    requestProviders,
    setProvider,
    deleteProvider,
  }
}
```

---

## Step 9: `src/composables/useModel.ts` — 模型列表 + 切换

- [ ] 创建 `src/composables/useModel.ts`

```typescript
// src/composables/useModel.ts
import { ref, computed, onUnmounted } from 'vue'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../stores/settings'
import { wsClient } from '../lib/ws-client'
import { eventBus } from '../lib/event-bus'
import type { ModelInfo } from '../types/provider'

export function useModel() {
  const sessionStore = useSessionStore()
  const settingsStore = useSettingsStore()

  const models = ref<ModelInfo[]>([])
  const currentModelId = ref<string>(settingsStore.defaultModel)
  const loading = ref(false)

  // ── Computed ──
  /** 按 provider 分组的模型列表 */
  const modelsByProvider = computed(() => {
    const groupMap = new Map<string, ModelInfo[]>()
    for (const model of models.value) {
      if (!groupMap.has(model.providerId)) {
        groupMap.set(model.providerId, [])
      }
      groupMap.get(model.providerId)!.push(model)
    }
    return groupMap
  })

  /** 当前模型信息 */
  const currentModel = computed<ModelInfo | null>(() => {
    if (!currentModelId.value) return null
    return models.value.find(m => m.id === currentModelId.value) ?? null
  })

  /** 用于显示的模型标签，如 "sonnet @ anthropic" */
  const currentModelLabel = computed(() => {
    const model = currentModel.value
    if (!model) return '未选择模型'
    return `${model.name} @ ${model.providerName}`
  })

  // ── 事件监听 ──
  function setupListeners() {
    eventBus.on('model.list', handleModelList)
    eventBus.on('model.switched', handleModelSwitched)
  }

  function cleanupListeners() {
    eventBus.off('model.list', handleModelList)
    eventBus.off('model.switched', handleModelSwitched)
  }

  // ── 请求 ──
  function requestModels() {
    loading.value = true
    wsClient.send({
      type: 'model.list',
      id: `req-${Date.now()}`,
      payload: {},
    })
  }

  function switchModel(modelId: string) {
    const sessionId = sessionStore.currentSessionId
    if (!sessionId) return

    currentModelId.value = modelId
    wsClient.send({
      type: 'model.switch',
      id: `req-${Date.now()}`,
      payload: { sessionId, modelId },
    })
  }

  // ── 事件处理器 ──
  function handleModelList(data: { models: ModelInfo[] }) {
    models.value = data.models
    loading.value = false
    // 如果没有当前模型，使用默认模型或第一个
    if (!currentModelId.value && data.models.length > 0) {
      currentModelId.value = settingsStore.defaultModel || data.models[0].id
    }
  }

  function handleModelSwitched(data: { sessionId: string; modelId: string }) {
    if (data.sessionId === sessionStore.currentSessionId) {
      currentModelId.value = data.modelId
    }
  }

  // ── 生命周期 ──
  setupListeners()
  onUnmounted(cleanupListeners)

  return {
    models,
    currentModelId,
    currentModel,
    currentModelLabel,
    modelsByProvider,
    loading,
    requestModels,
    switchModel,
  }
}
```

---

## Task 5 验证

- [ ] TypeScript 编译通过

```bash
npx vue-tsc --noEmit
```

- [ ] ESLint 通过

```bash
npm run lint
```

- [ ] 确认所有 store 和 composable 文件存在

```bash
ls -la src/stores/ src/composables/
```

## Task 5 提交

- [ ] 提交

```bash
git add -A
git commit -m "feat(p1): state layer — Pinia stores (chat, session, settings) + composables (useChat, useSession, useProvider, useModel, useConnection)"
```

---

---

# Task 6: App Shell — 布局组件

## 文件结构

```
src/
├── App.vue                          # 更新：根布局
├── components/
│   ├── layout/
│   │   ├── AppHeader.vue            # 顶栏
│   │   ├── AppSidebar.vue           # 侧边栏容器
│   │   └── AppStatusbar.vue         # 底栏
│   └── chat/
│       └── ChatView.vue             # 聊天区域壳
```

## 设计 Token 引用

布局使用 spec 定义的结构尺寸：

| Token | 值 |
|-------|----|
| `--sidebar-width` | 260px |
| `--header-height` | 48px |
| `--statusbar-height` | 32px |

通过 Tailwind class 消费，不硬编码数值。

---

## Step 10: `src/components/layout/AppHeader.vue`

- [ ] 创建 `src/components/layout/AppHeader.vue`

```vue
<!-- src/components/layout/AppHeader.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../../design-system'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const settingsStore = useSettingsStore()

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
    <!-- 左侧：Logo + 侧边栏切换 -->
    <div class="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        :aria-label="t('header.toggleSidebar')"
        @click="emit('toggleSidebar')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </Button>
      <span class="font-display text-lg font-semibold text-primary">
        xyz-agent
      </span>
    </div>

    <!-- 中间：通知区域占位（P1 隐藏但保留 DOM 结构） -->
    <div class="flex items-center gap-2 invisible">
      <!-- P5: 通知按钮 -->
      <Button variant="ghost" size="sm">
        <span class="text-sm text-muted">{{ t('header.notifications') }}</span>
      </Button>
    </div>

    <!-- 右侧：视图切换 + 设置 + 主题 -->
    <div class="flex items-center gap-1">
      <!-- 视图模式按钮 -->
      <Button
        variant="ghost"
        size="sm"
        :aria-label="t('header.standardView')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </Button>
      <!-- 分屏模式占位（P4 实现，当前 disabled） -->
      <Button
        variant="ghost"
        size="sm"
        disabled
        :aria-label="t('header.splitView')"
        class="opacity-30"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M12 3v18" />
        </svg>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :aria-label="t('header.focusView')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
        </svg>
      </Button>

      <!-- 分隔线 -->
      <div class="w-px h-5 bg-border mx-1" />

      <!-- 设置 -->
      <Button
        variant="ghost"
        size="sm"
        :aria-label="t('header.settings')"
        @click="emit('openSettings')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </Button>

      <!-- 主题切换 -->
      <Button
        variant="ghost"
        size="sm"
        :aria-label="t('header.toggleTheme')"
        @click="toggleTheme"
      >
        <!-- 太阳/月亮图标 -->
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          v-if="settingsStore.effectiveTheme === 'light'"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          v-else
        >
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
      </Button>
    </div>
  </header>
</template>
```

> **注意：** SVG 图标在 P1 先内联。后续可统一迁移到 `lucide-vue-next`。所有用户可见文本走 i18n。

---

## Step 11: `src/components/layout/AppSidebar.vue`

- [ ] 创建 `src/components/layout/AppSidebar.vue`

```vue
<!-- src/components/layout/AppSidebar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../../stores/session'
import { cn } from '../../design-system/utils'
import { Button, ScrollArea } from '../../design-system'

const { t } = useI18n()
const sessionStore = useSessionStore()

defineProps<{
  collapsed?: boolean
}>()

const emit = defineEmits<{
  newSession: []
  selectSession: [sessionId: string]
}>()

function formatTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return t('sidebar.justNow')
  if (minutes < 60) return t('sidebar.minutesAgo', { n: minutes })
  if (hours < 24) return t('sidebar.hoursAgo', { n: hours })
  return t('sidebar.daysAgo', { n: days })
}
</script>

<template>
  <aside
    data-slot="app-sidebar"
    :class="cn(
      'flex flex-col h-full bg-base border-r border-border',
      'transition-[width] duration-200 ease-standard',
      collapsed ? 'w-0 overflow-hidden' : 'w-[260px]',
    )"
  >
    <!-- 搜索框占位 -->
    <div class="px-3 pt-3 pb-2">
      <div class="h-8 rounded-md bg-surface border border-border flex items-center px-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="text-muted mr-2 shrink-0"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span class="text-sm text-muted truncate">
          {{ t('sidebar.search') }}
        </span>
      </div>
    </div>

    <!-- Session 列表 -->
    <ScrollArea class="flex-1 px-2">
      <div v-if="sessionStore.groupedSessions.length === 0" class="px-2 py-8 text-center">
        <p class="text-sm text-muted">{{ t('sidebar.empty') }}</p>
      </div>

      <div
        v-for="group in sessionStore.groupedSessions"
        :key="group.cwd"
        class="mb-3"
      >
        <!-- 分组标题 -->
        <div class="flex items-center gap-1.5 px-2 py-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-muted shrink-0"
          >
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
          <span class="text-xs font-medium text-muted truncate">
            {{ group.label }}
          </span>
        </div>

        <!-- Session 条目 -->
        <button
          v-for="session in group.sessions"
          :key="session.id"
          :class="cn(
            'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left',
            'hover:bg-surface transition-colors duration-150',
            session.id === sessionStore.currentSessionId
              ? 'bg-accent-light text-primary'
              : 'text-primary',
          )"
          @click="emit('selectSession', session.id)"
        >
          <!-- 状态点 -->
          <span
            :class="cn(
              'w-2 h-2 rounded-full shrink-0',
              session.status === 'active' ? 'bg-success' : 'bg-border',
            )"
          />
          <span class="text-sm truncate flex-1">{{ session.label }}</span>
          <span class="text-xs text-muted shrink-0">
            {{ formatTime(session.lastActiveAt) }}
          </span>
        </button>
      </div>
    </ScrollArea>

    <!-- 新建会话 -->
    <div class="p-3 border-t border-border">
      <Button
        variant="ghost"
        size="sm"
        class="w-full justify-center"
        @click="emit('newSession')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
        {{ t('sidebar.newSession') }}
      </Button>
    </div>
  </aside>
</template>
```

> **注意：** Session 条目使用原生 `<button>` 因为 design-system Button 使用 Primitive 渲染，对列表项场景过于重量级。此处的 `<button>` 用于交互语义（无障碍），视觉完全由 Tailwind 控制。如果 taste-lint 报 `no-native-form-elements`，可加 eslint-disable 注释或改用 `Button variant="ghost" as-child`。

---

## Step 12: `src/components/layout/AppStatusbar.vue`

- [ ] 创建 `src/components/layout/AppStatusbar.vue`

```vue
<!-- src/components/layout/AppStatusbar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useConnection, type ConnectionStatus } from '../../composables/useConnection'
import { useSessionStore } from '../../stores/session'
import { useModel } from '../../composables/useModel'
import { cn } from '../../design-system/utils'

const { t } = useI18n()
const { status, statusText } = useConnection()
const sessionStore = useSessionStore()
const { currentModelLabel } = useModel()

const statusDotClass = (s: ConnectionStatus) =>
  cn(
    'w-2 h-2 rounded-full shrink-0',
    s === 'connected' && 'bg-success',
    s === 'reconnecting' && 'bg-warning',
    s === 'disconnected' && 'bg-danger',
  )

const cwd = () => {
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
      'text-xs text-muted',
    )"
  >
    <!-- 左侧：连接状态 + cwd + 模型 -->
    <div class="flex items-center gap-3">
      <span class="flex items-center gap-1.5">
        <span :class="statusDotClass(status)" />
        {{ statusText }}
      </span>
      <span class="flex items-center gap-1">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        {{ cwd() }}
      </span>
      <span>{{ currentModelLabel }}</span>
    </div>

    <!-- 右侧：快捷键提示 -->
    <div class="flex items-center gap-3 text-muted">
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

---

## Step 13: `src/components/chat/ChatView.vue` — 聊天区域壳

- [ ] 创建 `src/components/chat/ChatView.vue`

```vue
<!-- src/components/chat/ChatView.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { cn } from '../../design-system/utils'
import { ScrollArea, Button } from '../../design-system'

const { t } = useI18n()
const chatStore = useChatStore()
</script>

<template>
  <div
    data-slot="chat-view"
    class="flex flex-col h-full bg-base"
  >
    <!-- 消息列表区域 -->
    <ScrollArea class="flex-1">
      <!-- 空状态 -->
      <div
        v-if="chatStore.messages.length === 0 && !chatStore.isGenerating"
        class="flex flex-col items-center justify-center h-full text-center px-8"
      >
        <div class="mb-6">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-border"
          >
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M2 14h2" />
            <path d="M20 14h2" />
            <path d="M15 13v2" />
            <path d="M9 13v2" />
          </svg>
        </div>
        <h2 class="text-lg font-medium text-primary mb-2">
          {{ t('chat.emptyTitle') }}
        </h2>
        <p class="text-sm text-muted max-w-md">
          {{ t('chat.emptySubtitle') }}
        </p>
      </div>

      <!-- 消息列表占位（Task 7 实现 MessageList + MessageBubble） -->
      <div v-else class="p-4 space-y-4">
        <div
          v-for="msg in chatStore.messages"
          :key="msg.id"
          :class="cn(
            'p-3 rounded-lg text-sm',
            msg.role === 'user'
              ? 'bg-accent-light text-primary ml-12'
              : 'bg-surface text-primary mr-12',
          )"
        >
          <span class="text-xs text-muted block mb-1">{{ msg.role }}</span>
          {{ msg.content }}
        </div>

        <!-- 流式文本占位 -->
        <div
          v-if="chatStore.streamingText"
          class="p-3 rounded-lg bg-surface text-primary mr-12"
        >
          <span class="text-xs text-muted block mb-1">assistant (streaming)</span>
          {{ chatStore.streamingText }}
          <span class="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5" />
        </div>

        <!-- 工具调用占位 -->
        <div
          v-for="tc in chatStore.currentToolCalls"
          :key="tc.id"
          class="p-3 rounded-lg bg-surface border border-border text-sm"
        >
          <div class="flex items-center gap-2 mb-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="text-muted"
            >
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <span class="font-medium text-primary">{{ tc.toolName }}</span>
            <span
              :class="cn(
                'text-xs',
                tc.status === 'running' && 'text-warning',
                tc.status === 'completed' && 'text-success',
                tc.status === 'error' && 'text-danger',
              )"
            >
              {{ tc.status }}
            </span>
          </div>
          <p class="text-muted text-xs truncate">{{ tc.input }}</p>
        </div>
      </div>
    </ScrollArea>

    <!-- 输入区域占位（Task 7 实现 ChatInput） -->
    <div class="border-t border-border p-4">
      <div class="flex flex-col gap-2">
        <div
          :class="cn(
            'w-full min-h-[80px] max-h-[140px] p-3',
            'rounded-lg bg-surface border border-border',
            'text-sm text-muted',
          )"
        >
          {{ t('chat.inputPlaceholder') }}
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-muted">
            <!-- Task 7: ModelPicker 占位 -->
            model-selector-placeholder
          </span>
          <Button variant="primary" size="sm">
            {{ t('chat.send') }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
```

---

## Step 14: 更新 `src/App.vue` — 根布局

- [ ] 更新 `src/App.vue`

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { ThemeProvider } from './design-system/theme/ThemeProvider.vue'
import AppHeader from './components/layout/AppHeader.vue'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppStatusbar from './components/layout/AppStatusbar.vue'
import ChatView from './components/chat/ChatView.vue'

const sidebarCollapsed = ref(false)
const showSettings = ref(false)

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

function openSettings() {
  showSettings.value = !showSettings.value
}

function handleNewSession() {
  // Task 8 完整实现，P1 shell 阶段仅占位
}

function handleSelectSession(sessionId: string) {
  // Task 8 完整实现，P1 shell 阶段仅占位
}
</script>

<template>
  <ThemeProvider>
    <div class="flex flex-col h-screen bg-base text-primary overflow-hidden">
      <!-- Header -->
      <AppHeader
        @toggle-sidebar="toggleSidebar"
        @open-settings="openSettings"
      />

      <!-- 主内容区域 -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Settings 全屏覆盖（P9 完整实现） -->
        <div
          v-if="showSettings"
          class="absolute inset-0 z-50 bg-base"
        >
          <div class="flex items-center justify-center h-full">
            <div class="text-center">
              <h2 class="text-lg font-medium text-primary mb-2">Settings</h2>
              <p class="text-sm text-muted">Task 9 实现完整设置页</p>
              <button
                class="mt-4 text-sm text-accent hover:underline"
                @click="showSettings = false"
              >
                Close
              </button>
            </div>
          </div>
        </div>

        <!-- Sidebar -->
        <AppSidebar
          :collapsed="sidebarCollapsed"
          @new-session="handleNewSession"
          @select-session="handleSelectSession"
        />

        <!-- Chat View -->
        <main class="flex-1 overflow-hidden">
          <ChatView />
        </main>
      </div>

      <!-- Statusbar -->
      <AppStatusbar />
    </div>
  </ThemeProvider>
</template>
```

> **注意：** Settings 占位区的 Close 按钮使用原生 `<button>` 仅因 Task 6 是 shell 阶段。Task 9 实现时替换为 design-system Button。

---

## Step 15: i18n 补充 — 布局相关翻译 key

- [ ] 在 `src/i18n/locales/zh-CN.ts` 中补充 Task 6 需要的翻译 key

```typescript
// 在 zh-CN.ts 的 default 对象中追加：
header: {
  toggleSidebar: '切换侧边栏',
  notifications: '通知',
  standardView: '标准模式',
  splitView: '分屏模式',
  focusView: '专注模式',
  settings: '设置',
  toggleTheme: '切换主题',
},
sidebar: {
  search: '搜索会话…',
  empty: '暂无会话',
  newSession: '新建会话',
  justNow: '刚刚',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
  daysAgo: '{n} 天前',
},
chat: {
  emptyTitle: '开始新对话',
  emptySubtitle: '输入消息与 AI 助手对话，或使用左侧面板新建会话。',
  inputPlaceholder: '输入消息… (Enter 发送, Shift+Enter 换行)',
  send: '发送',
},
statusbar: {
  standard: '标准',
  focus: '专注',
},
```

- [ ] 在 `src/i18n/locales/en-US.ts` 中补充对应英文

```typescript
// 在 en-US.ts 的 default 对象中追加：
header: {
  toggleSidebar: 'Toggle sidebar',
  notifications: 'Notifications',
  standardView: 'Standard view',
  splitView: 'Split view',
  focusView: 'Focus view',
  settings: 'Settings',
  toggleTheme: 'Toggle theme',
},
sidebar: {
  search: 'Search sessions…',
  empty: 'No sessions yet',
  newSession: 'New session',
  justNow: 'just now',
  minutesAgo: '{n}m ago',
  hoursAgo: '{n}h ago',
  daysAgo: '{n}d ago',
},
chat: {
  emptyTitle: 'Start a new conversation',
  emptySubtitle: 'Send a message to chat with the AI assistant, or create a new session from the sidebar.',
  inputPlaceholder: 'Type a message… (Enter to send, Shift+Enter for new line)',
  send: 'Send',
},
statusbar: {
  standard: 'Standard',
  focus: 'Focus',
},
```

---

## Task 6 验证

- [ ] TypeScript 编译通过

```bash
npx vue-tsc --noEmit
```

- [ ] ESLint 通过

```bash
npm run lint
```

- [ ] Dev server 启动并显示可见布局

```bash
npm run dev
```

验证清单：
- [ ] 顶部 Header 显示 "xyz-agent" logo、视图按钮、设置齿轮、主题切换图标
- [ ] 左侧 Sidebar 显示（可折叠/展开）
- [ ] 中间 ChatView 显示空状态占位
- [ ] 底部 Statusbar 显示连接状态、cwd、模型标签
- [ ] 点击主题切换可在 light/dark 之间切换
- [ ] 点击侧边栏切换按钮可折叠/展开 Sidebar

## Task 6 提交

- [ ] 提交

```bash
git add -A
git commit -m "feat(p1): app shell — Header, Sidebar, ChatView shell, Statusbar with placeholder content"
```

---

## 文件总览

| 文件 | Task | 说明 |
|------|------|------|
| `src/stores/settings.ts` | 5 | 主题/语言/默认模型，persisted |
| `src/stores/chat.ts` | 5 | 消息列表 + 流式状态 + 工具调用 |
| `src/stores/session.ts` | 5 | 会话列表 + 分组 + 当前会话 |
| `src/composables/useConnection.ts` | 5 | WS 连接生命周期 + 指数退避重连 |
| `src/composables/useChat.ts` | 5 | 发送/中断 + 流式事件 → store |
| `src/composables/useSession.ts` | 5 | Session CRUD via WS |
| `src/composables/useProvider.ts` | 5 | Provider 配置管理 |
| `src/composables/useModel.ts` | 5 | 模型列表 + 切换 + 分组 |
| `src/components/layout/AppHeader.vue` | 6 | 顶栏：Logo + 视图 + 设置 + 主题 |
| `src/components/layout/AppSidebar.vue` | 6 | 侧边栏：会话分组列表 |
| `src/components/layout/AppStatusbar.vue` | 6 | 底栏：状态 + cwd + 模型 + 快捷键 |
| `src/components/chat/ChatView.vue` | 6 | 聊天壳：消息占位 + 输入占位 |
| `src/App.vue` | 6 | 根布局：ThemeProvider + Header + Sidebar + Chat + Statusbar |
