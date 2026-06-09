# Frontend Architecture — Phase 1: Hello pi

**Date**: 2026-05-06 | **Phase**: P1 | **Status**: Design Spec

> xyz-agent Tauri + Vue 3 前端架构详细设计文档。本文档定义 P1 范围内的组件树、数据流、状态管理、Design Token 映射、Composable 依赖图和 i18n 键空间。

---

## Table of Contents

1. [Component Hierarchy Tree](#1-component-hierarchy-tree)
2. [Component Dependency Graph](#2-component-dependency-graph)
3. [Data Flow Diagrams](#3-data-flow-diagrams)
4. [State Management Map](#4-state-management-map)
5. [Composable Dependency Graph](#5-composable-dependency-graph)
6. [Design Token → Component Mapping](#6-design-token--component-mapping)
7. [i18n Key Structure](#7-i18n-key-structure)

---

## 1. Component Hierarchy Tree

```
App.vue
├── ThemeProvider.vue                         # theme: 'light' | 'dark' | 'system'
│   │                                         # provides: { theme, setTheme, toggleTheme }
│   │
│   ├── AppHeader.vue                         # props: { viewMode, showSettings }
│   │   │                                     # emits: ['update:viewMode', 'toggle-settings', 'toggle-theme']
│   │   │
│   │   ├── .header__logo                     # static: "xyz-agent"
│   │   ├── .header__spacer
│   │   ├── .notif-group  (P5 预留, v-if="false")
│   │   ├── .h-divider
│   │   ├── Button variant="ghost" size="sm"  # Cmd+J 总览 (P4 disabled)
│   │   ├── Button variant="ghost" size="sm"  # Cmd+1 标准
│   │   │   └── icon: SquareSplit1x2
│   │   ├── Button variant="ghost" size="sm"  # Cmd+2 分屏 (disabled)
│   │   │   └── icon: SquareSplit2x2
│   │   ├── Button variant="ghost" size="sm"  # Cmd+3 专注
│   │   │   └── icon: Maximize
│   │   ├── .h-divider
│   │   ├── Button variant="ghost" size="sm"  # ⚙ 设置
│   │   │   └── icon: Settings
│   │   └── Button variant="ghost" size="sm"  # 🌙 主题切换
│   │       └── icon: Moon / Sun
│   │
│   ├── <template v-if="viewMode !== 'settings'">
│   │   │
│   │   ├── AppSidebar.vue                    # props: { collapsed: boolean }
│   │   │   │                                 # emits: ['update:collapsed', 'create-session']
│   │   │   │
│   │   │   ├── .sidebar__hd
│   │   │   │   ├── span.sidebar__hd-title   # "会话"
│   │   │   │   └── Button variant="ghost"    # "+" 新建
│   │   │   │
│   │   │   ├── ScrollArea :auto-hide="true"
│   │   │   │   │
│   │   │   │   ├── SessionGroup.vue          # v-for="group in sessionGroups"
│   │   │   │   │   │                         # props: { group: SessionGroup }
│   │   │   │   │   │                         # emits: ['select-session']
│   │   │   │   │   │
│   │   │   │   │   ├── .s-group__hd          # 可折叠目录头
│   │   │   │   │   │   ├── span.s-group__toggle  # ▾ chevron
│   │   │   │   │   │   └── span              # group.cwd basename
│   │   │   │   │   │
│   │   │   │   │   └── .s-group__items
│   │   │   │   │       └── SessionItem.vue   # v-for="session in group.sessions"
│   │   │   │   │             │               # props: { session: SessionSummary, active: boolean }
│   │   │   │   │             │               # emits: ['select', 'delete', 'rename']
│   │   │   │   │             │
│   │   │   │   │             ├── Badge :variant="status" :dot="true"  # 🟢/⚪ 状态点
│   │   │   │   │             ├── span.s-item__title               # 会话标题
│   │   │   │   │             ├── span.s-item__meta                 # 相对时间
│   │   │   │   │             └── Dropdown trigger="contextmenu"    # 右键菜单
│   │   │   │   │                 └── items: [rename, delete]
│   │   │   │   │
│   │   │   │   └── SessionSearch.vue        # props: { modelValue: string }
│   │   │   │        │                       # emits: ['update:modelValue']
│   │   │   │        └── Input placeholder="搜索会话…"
│   │   │   │            └── icon: Search (prefix)
│   │   │   │
│   │   │   └── .sidebar__footer
│   │   │       └── Button variant="ghost"    # "+ 新建会话"
│   │   │
│   │   ├── .main-area
│   │   │   │
│   │   │   ├── ChatView.vue                  # 核心对话容器
│   │   │   │   │
│   │   │   │   ├── .panel-bar                # anchor 预留位 (P1 仅显示当前 session 标题)
│   │   │   │   │
│   │   │   │   ├── MessageList.vue           # 虚拟滚动容器
│   │   │   │   │   │                         # props: { messages: Message[] }
│   │   │   │   │   │
│   │   │   │   │   └── 动态组件 (per message)
│   │   │   │   │       │
│   │   │   │   │       ├── MessageBubble.vue  # v-if="msg.type === 'user' | 'assistant'"
│   │   │   │   │       │   │                  # props: { message: Message }
│   │   │   │   │       │   │
│   │   │   │   │       │   ├── .msg__role     # "用户" / "助手"
│   │   │   │   │       │   └── .msg__body
│   │   │   │   │       │       └── StreamingText.vue  # v-if="message.isStreaming"
│   │   │   │   │       │           │                   # props: { text: string, streaming: boolean }
│   │   │   │   │       │           └── 渲染 markdown-it + dompurify
│   │   │   │   │       │
│   │   │   │   │       ├── ToolCallCard.vue   # v-if="msg.type === 'tool_call'"
│   │   │   │   │       │   │                  # props: { toolCall: ToolCall }
│   │   │   │   │       │   │                  # emits: ['toggle-expand']
│   │   │   │   │       │   │
│   │   │   │   │       │   ├── .tool__hd      # 折叠态标题栏
│   │   │   │   │       │   │   ├── icon: Wrench
│   │   │   │   │       │   │   ├── span.tool__name
│   │   │   │   │       │   │   ├── span.tool__path
│   │   │   │   │       │   │   └── Badge :variant="status"  # ✅/❌ 状态
│   │   │   │   │       │   │
│   │   │   │   │       │   └── .tool__bd      # 展开态详情
│   │   │   │   │       │       └── pre         # 工具输出内容
│   │   │   │   │       │
│   │   │   │   │       └── ThinkingBlock.vue   # v-if="msg.type === 'thinking'"
│   │   │   │   │           │                   # props: { content: string, streaming: boolean }
│   │   │   │   │           │
│   │   │   │   │           ├── .thinking__hd   # "思考中…" / "查看思考过程"
│   │   │   │   │           │   ├── icon: Brain
│   │   │   │   │           │   └── Button variant="ghost" size="sm"  # 展开/折叠
│   │   │   │   │           └── .thinking__bd   # 折叠内容 (Collapsible)
│   │   │   │   │               └── StreamingText :text="content" :streaming="streaming"
│   │   │   │   │
│   │   │   │   └── ChatInput.vue              # 输入区
│   │   │   │        │                         # emits: ['send', 'abort']
│   │   │   │        │
│   │   │   │        ├── .chat-input-container
│   │   │   │        │   │
│   │   │   │        │   ├── Textarea                          # 自适应高度
│   │   │   │        │   │   :auto-resize="true"
│   │   │   │        │   │   :max-height="140"
│   │   │   │        │   │   v-model="inputText"
│   │   │   │        │   │
│   │   │   │        │   └── .chat-input-toolbar
│   │   │   │        │       │
│   │   │   │        │       ├── Button variant="ghost" size="sm"  # [+] 上传 (disabled P1)
│   │   │   │        │       │   └── icon: Plus
│   │   │   │        │       │
│   │   │   │        │       ├── ModelPicker.vue                 # 模型选择
│   │   │   │        │       │   │                               # emits: ['select']
│   │   │   │        │       │   │
│   │   │   │        │       │   ├── .tb-model (trigger)
│   │   │   │        │       │   │   ├── span                    # model name
│   │   │   │        │       │   │   ├── span.separator          # "@"
│   │   │   │        │       │   │   └── span.provider           # provider name
│   │   │   │        │       │   │
│   │   │   │        │       │   └── Dropdown (弹出层)
│   │   │   │        │       │       └── 分组列表
│   │   │   │        │       │           ├── .model-dd-section   # "常用"
│   │   │   │        │       │           │   └── .model-dd-item  (v-for)
│   │   │   │        │       │           └── .model-dd-section   # "Anthropic"
│   │   │   │        │       │               └── .model-dd-item  (v-for)
│   │   │   │        │       │
│   │   │   │        │       ├── ContextBar.vue                  # token 用量条
│   │   │   │        │       │   │                               # props: { usage: number, limit: number }
│   │   │   │        │       │   └── ProgressBar :value="pct" :variant="barVariant"
│   │   │   │        │       │
│   │   │   │        │       ├── .tb-spacer
│   │   │   │        │       │
│   │   │   │        │       ├── Button variant="primary" size="sm"  # [⬆] 发送
│   │   │   │        │       │   v-if="!isGenerating"
│   │   │   │        │       │   └── icon: ArrowUp
│   │   │   │        │       │
│   │   │   │        │       └── Button variant="ghost" size="sm"    # [■] 中断
│   │   │   │        │           v-else
│   │   │   │        │           └── icon: Square
│   │   │   │        │
│   │   │   │        └── SlashMenu.vue         # / 命令浮层 (P1 空菜单)
│   │   │   │            │                     # props: { visible: boolean, items: SlashItem[] }
│   │   │   │            │                     # emits: ['select', 'close']
│   │   │   │            └── .slash-item (v-for)
│   │   │   │
│   │   │   └── (P4: SplitDivider + Panel B 预留位)
│   │   │
│   │   └── SettingsView.vue              # v-if="viewMode === 'settings'"
│   │       │
│   │       ├── .settings-sidebar
│   │       │   ├── .settings-sidebar__hd  # "设置"
│   │       │   └── .settings-sidebar__list
│   │       │       ├── Tabs
│   │       │       │   └── items: [
│   │       │       │     { key: 'providers', label: '供应商' },
│   │       │       │     { key: 'skills',    label: 'SKILL' },
│   │       │       │     { key: 'agents',    label: 'AGENT' },
│   │       │       │   ]
│   │       │       │   v-model:activeKey="activeTab"
│   │       │       │
│   │       │       └── (Tab icons via slots)
│   │       │
│   │       └── .settings-content
│   │           │
│   │           ├── .settings-content__pane  # v-if="activeTab === 'providers'"
│   │           │   │
│   │           │   ├── .settings-section    # "已配置的供应商"
│   │           │   │   └── ProviderList.vue
│   │           │   │       │                # props: { providers: ProviderInfo[] }
│   │           │   │       │                # emits: ['edit', 'delete', 'add']
│   │           │   │       │
│   │           │   │       ├── ProviderForm.vue   # v-if="editing" (inline or dialog)
│   │           │   │       │   │                   # props: { provider?: ProviderInfo }
│   │           │   │       │   │                   # emits: ['save', 'cancel']
│   │           │   │       │   │
│   │           │   │       │   ├── Input label="API Key" type="password"
│   │           │   │       │   ├── Input label="Base URL"
│   │           │   │       │   └── Button variant="primary"          # 保存
│   │           │   │       │
│   │           │   │       └── .provider-card (v-for)
│   │           │   │           ├── span.provider-card__name
│   │           │   │           ├── span.provider-card__models
│   │           │   │           ├── Badge :variant="connected ? 'success' : 'idle'"
│   │           │   │           ├── Button variant="ghost" size="sm"  # 编辑
│   │           │   │           └── Button variant="ghost" size="sm"  # 删除
│   │           │   │
│   │           │   ├── .settings-section    # "默认配置"
│   │           │   │   ├── Select label="默认模型" :options="modelOptions"
│   │           │   │   ├── Select label="思考模式" :options="thinkingOptions"
│   │           │   │   └── Input label="温度" type="number"
│   │           │   │
│   │           │   └── .settings-section    # "界面"
│   │           │       ├── Select label="语言" :options="localeOptions"
│   │           │       └── Select label="主题" :options="themeOptions"
│   │           │
│   │           ├── .settings-content__pane  # v-if="activeTab === 'skills'"
│   │           │   └── .coming-soon         # "即将推出" 占位
│   │           │
│   │           └── .settings-content__pane  # v-if="activeTab === 'agents'"
│   │               └── .coming-soon         # "即将推出" 占位
│   │
│   └── AppStatusbar.vue                     # props: { connection, cwd, model, tokenUsage }
│       │                                    # v-if="viewMode !== 'settings' && viewMode !== 'focus'"
│       │
│       ├── Badge :variant="connectionStatus" :dot="true"  # 🟢/🔴/🟡
│       ├── span {{ cwd }}
│       ├── span {{ modelLabel }}
│       ├── span {{ formattedTokens }}
│       ├── span.spacer
│       └── span.shortcuts                   # 快捷键提示文字
```

---

## 2. Component Dependency Graph

Each application component depends on the following design-system components:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Design System Components (12)                                           │
│                                                                         │
│  Button │ Input │ Textarea │ Select │ ScrollArea │ Tooltip             │
│  Dropdown │ Dialog │ Tabs │ Badge │ Toggle │ ProgressBar               │
└─────────────────────────────────────────────────────────────────────────┘

AppHeader ──────────── depends on: Button
AppSidebar ─────────── depends on: Button, ScrollArea, Input, Dropdown
SessionSearch ──────── depends on: Input
SessionGroup ───────── depends on: (none — structural only)
SessionItem ────────── depends on: Badge, Dropdown
ChatView ───────────── depends on: (none — layout container)
MessageList ────────── depends on: ScrollArea
MessageBubble ──────── depends on: (none — uses markdown-it directly)
StreamingText ──────── depends on: (none — pure text renderer)
ToolCallCard ───────── depends on: Badge
ThinkingBlock ──────── depends on: Button
ChatInput ──────────── depends on: Textarea, Button, ProgressBar
ModelPicker ────────── depends on: Dropdown
ContextBar ─────────── depends on: ProgressBar
SlashMenu ──────────── depends on: (none — custom floating list)
SettingsView ───────── depends on: Tabs, Select, Input, Button, Badge
ProviderList ───────── depends on: Button, Badge
ProviderForm ───────── depends on: Input, Button
AppStatusbar ───────── depends on: Badge
ThemeProvider ──────── depends on: Toggle (internal theme switch preview)
```

**Design system component → used-by summary:**

| Design Component | Used By |
|-----------------|---------|
| `Button` | AppHeader, AppSidebar, ThinkingBlock, ChatInput, SettingsView, ProviderList, ProviderForm |
| `Input` | SessionSearch, ProviderForm, SettingsView |
| `Textarea` | ChatInput |
| `Select` | SettingsView |
| `ScrollArea` | AppSidebar, MessageList |
| `Tooltip` | AppHeader (on icon buttons), ToolCallCard (on status) |
| `Dropdown` | AppSidebar (SessionItem context menu), ModelPicker |
| `Dialog` | SettingsView (delete confirmation), SessionItem (rename) |
| `Tabs` | SettingsView |
| `Badge` | SessionItem, ToolCallCard, AppStatusbar, ProviderList |
| `Toggle` | ThemeProvider (internal) |
| `ProgressBar` | ContextBar (via ChatInput) |

---

## 3. Data Flow Diagrams

### 3a. Send Message Flow

```
User types in ChatInput Textarea
  │
  ▼
ChatInput emits 'send' with { content: string }
  │
  ▼
useChat.sendMessage(content)
  │  1. chatStore.addMessage({ type: 'user', content })     ← optimistic local append
  │  2. chatStore.startGenerating()                          ← set isGenerating = true
  │  3. wsClient.send('message.send', { sessionId, content })
  │
  ▼
WebSocket ────────────────────────────────► Sidecar
  │                                          │
  │                                          ▼ pi-bridge.sendMessage()
  │                                          │   → pi SDK stream
  │                                          │
  │   Sidecar streams back events:
  │
  ◄── WS: message.text_delta ───────────────┤
  │   { sessionId, delta: "你" }
  │
  ▼
ws-client.ts receives → eventBus.emit('message.text_delta', payload)
  │
  ▼
useChat composable handler:
  │  chatStore.appendDelta(payload.delta)     ← appends to current streaming message
  │
  ▼
Vue reactivity → StreamingText.vue updates   ← character-by-character render
  │
  ... (repeat for each delta)
  │
  ◄── WS: message.tool_call_start ──────────┤
  │   { sessionId, toolCallId, toolName, input }
  │
  ▼
useChat handler → chatStore.addToolCall(payload)
  │
  ▼
Vue reactivity → ToolCallCard.vue appears    ← "🔧 read src/auth.ts ⏳ 运行中"
  │
  ◄── WS: message.tool_call_end ────────────┤
  │   { sessionId, toolCallId, output }
  │
  ▼
useChat handler → chatStore.updateToolCall(payload)
  │
  ▼
Vue reactivity → ToolCallCard.vue updates    ← status: ✅ 完成
  │
  ◄── WS: message.complete ─────────────────┤
  │   { sessionId, stopReason, usage }
  │
  ▼
useChat handler:
  │  chatStore.stopGenerating()
  │  chatStore.updateUsage(payload.usage)
  │
  ▼
ChatInput.vue → send button replaces stop button
AppStatusbar.vue → token count updates
```

### 3b. Session Switch Flow

```
User clicks SessionItem in sidebar
  │
  ▼
SessionItem emits 'select' with { sessionId }
  │
  ▼
useSession.switchSession(sessionId)
  │  1. sessionStore.setCurrentId(sessionId)              ← highlight sidebar item
  │  2. chatStore.clearMessages()                         ← clear current view
  │  3. chatStore.startLoading()                          ← show loading state
  │  4. wsClient.send('session.switch', { sessionId })
  │
  ▼
WebSocket ────────────────────────────────► Sidecar
  │                                          │
  │                                          ▼ session-pool.activate(sessionId)
  │                                          │   → loads session from pi SessionManager
  │                                          │
  ◄── WS: session.history ──────────────────┤
  │   { sessionId, messages: Message[] }
  │
  ▼
ws-client.ts → eventBus.emit('session.history', payload)
  │
  ▼
useSession handler:
  │  chatStore.replaceMessages(payload.messages)          ← full history load
  │  chatStore.stopLoading()
  │
  ▼
Vue reactivity:
  │  MessageList.vue → renders message history
  │  AppStatusbar.vue → updates cwd, model from session metadata
  │  ChatInput.vue → resets input, shows current model
```

### 3c. Model Switch Flow

```
User picks model in ModelPicker dropdown
  │
  ▼
ModelPicker emits 'select' with { modelId, providerId }
  │
  ▼
useModel.switchModel(modelId, providerId)
  │  1. wsClient.send('model.switch', { sessionId, modelId })
  │
  ▼
WebSocket ────────────────────────────────► Sidecar
  │                                          │
  │                                          ▼ pi-bridge.switchModel(sessionId, modelId)
  │                                          │
  ◄── WS: model.switched ──────────────────┤
  │   { sessionId, modelId }
  │
  ▼
ws-client.ts → eventBus.emit('model.switched', payload)
  │
  ▼
useModel handler:
  │  sessionStore.updateSessionModel(sessionId, modelId)
  │
  ▼
Vue reactivity:
  │  AppStatusbar.vue → model label updates
  │  ModelPicker.vue → selected model indicator updates
  │  ChatInput.vue → toolbar label updates
```

### 3d. Provider Config Flow

```
User clicks "编辑" on provider card in SettingsView
  │
  ▼
ProviderList emits 'edit' with { providerId }
  │
  ▼
ProviderForm opens (inline or Dialog)
  │
  ▼
User edits API Key / Base URL → clicks "保存"
  │
  ▼
ProviderForm emits 'save' with { providerId, apiKey, baseUrl, ... }
  │
  ▼
useProvider.saveProvider(payload)
  │  1. wsClient.send('config.setProvider', payload)
  │
  ▼
WebSocket ────────────────────────────────► Sidecar
  │                                          │
  │                                          ▼ config-store.write(providerId, config)
  │                                          │   → writes to ~/.xyz-agent/config.toml
  │                                          │   → validates API Key (optional ping)
  │                                          │
  ◄── WS: config.providerUpdated ───────────┤
  │   { providerId }
  │
  ▼
ws-client.ts → eventBus.emit('config.providerUpdated', payload)
  │
  ▼
useProvider handler:
  │  Re-fetch provider list via wsClient.send('config.getProviders')
  │
  ◄── WS: config.providers ────────────────┤
  │   { providers: ProviderInfo[] }
  │
  ▼
useProvider handler:
  │  settingsStore.updateProviders(providers)              ← reactive update
  │
  ▼
Vue reactivity:
  │  ProviderList.vue → re-renders with updated status badges
  │  ModelPicker.vue → model list may update (new provider = new models)
  │
  │  (toast: "供应商配置已更新" on success)
```

### 3e. Session Create Flow

```
User clicks "+ 新建会话" in sidebar footer
  │
  ▼
AppSidebar emits 'create-session'
  │
  ▼
App.vue handles:
  │  → Tauri dialog.open({ directory: true })             ← native folder picker
  │  → receives selected cwd path
  │
  ▼
useSession.createSession(cwd)
  │  1. wsClient.send('session.create', { cwd })
  │
  ▼
WebSocket ────────────────────────────────► Sidecar
  │                                          │
  │                                          ▼ pi-bridge.createSession(cwd)
  │                                          │   → creates new AgentSession
  │                                          │
  ◄── WS: session.created ──────────────────┤
  │   { sessionId, label, cwd }
  │
  ▼
ws-client.ts → eventBus.emit('session.created', payload)
  │
  ▼
useSession handler:
  │  sessionStore.addSession(payload)                     ← adds to list, groups by cwd
  │  sessionStore.setCurrentId(payload.sessionId)         ← auto-switch to new session
  │  chatStore.clearMessages()                            ← empty chat view
  │
  ▼
Vue reactivity:
  │  AppSidebar → new SessionGroup/SessionItem appears
  │  ChatView → empty, ready for input
```

### 3f. Connection Lifecycle Flow

```
App mounts
  │
  ▼
useConnection.init()
  │  1. Read sidecar port from Tauri invoke('get_sidecar_port')
  │  2. wsClient.connect(`ws://localhost:${port}`)
  │
  ▼
WebSocket connects
  │
  ▼
useConnection handler:
  │  settingsStore.setConnectionStatus('connected')
  │  → request initial data:
  │    wsClient.send('session.list', {})
  │    wsClient.send('config.getProviders', {})
  │    wsClient.send('model.list', {})
  │
  ▼
Responses populate all stores → UI renders
  │
  ... (normal operation)
  │
  WS onerror / onclose
  │
  ▼
useConnection reconnect logic:
  │  settingsStore.setConnectionStatus('reconnecting')
  │  → exponential backoff: 1s, 2s, 4s, 8s, max 30s
  │  → wsClient.connect() retry
  │
  ▼
AppStatusbar.vue → shows 🟡 "重连中…"
  │
  ... (reconnect succeeds)
  │
  ▼
settingsStore.setConnectionStatus('connected')
AppStatusbar.vue → shows 🟢 "已连接"
```

---

## 4. State Management Map

### 4.1 `useChatStore` (Pinia — `stores/chat.ts`)

**Responsibility**: Current conversation messages, streaming state, tool calls, usage tracking.

```typescript
// ── State ──
interface ChatState {
  messages: Message[]              // Current session's message list
  isGenerating: boolean            // Whether agent is currently generating
  isLoading: boolean               // Whether history is being loaded
  streamingText: string            // Buffer for current streaming text delta
  currentToolCalls: Map<string, ToolCall>  // Active tool calls keyed by toolCallId
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  error: string | null             // Last error message (null = no error)
}

// ── Actions ──
function addMessage(msg: Message): void                    // Append a message
function replaceMessages(msgs: Message[]): void            // Replace all (on session switch)
function appendDelta(delta: string): void                  // Append streaming text
function clearStream(): void                               // Reset streaming buffer
function addToolCall(tc: ToolCall): void                   // Add new tool call
function updateToolCall(id: string, output: string): void  // Update tool call result
function startGenerating(): void                           // Set isGenerating = true
function stopGenerating(): void                            // Set isGenerating = false
function startLoading(): void                              // Set isLoading = true
function stopLoading(): void                               // Set isLoading = false
function updateUsage(usage: Usage): void                   // Update token counts
function setError(error: string | null): void              // Set error state
function clearMessages(): void                             // Reset for session switch

// ── Getters ──
const messageCount: ComputedRef<number>                    // messages.length
const lastMessage: ComputedRef<Message | undefined>        // messages.at(-1)
const hasError: ComputedRef<boolean>                       // error !== null
const contextPercent: ComputedRef<number>                  // usage.totalTokens / contextLimit * 100

// ── Consumers ──
// MessageList.vue       → messages, isLoading
// MessageBubble.vue     → message (from list)
// ToolCallCard.vue      → currentToolCalls
// StreamingText.vue     → streamingText
// ChatInput.vue         → isGenerating, contextPercent
// ContextBar.vue        → contextPercent
// AppStatusbar.vue      → usage.totalTokens
```

**Persistence**: None. Chat state is ephemeral — history comes from Sidecar via `session.history`.

### 4.2 `useSessionStore` (Pinia — `stores/session.ts`)

**Responsibility**: Session list, current session, grouping by cwd.

```typescript
// ── State ──
interface SessionState {
  sessions: SessionSummary[]       // All known sessions (max 50 recent)
  currentSessionId: string | null  // Active session
  searchQuery: string              // Sidebar search filter
}

// ── Derived (computed) ──
interface SessionGroup {
  cwd: string                      // Working directory path
  label: string                    // Directory basename
  sessions: SessionSummary[]       // Sessions in this directory
}

// ── Actions ──
function loadSessions(sessions: SessionSummary[]): void     // Full replace from Sidecar
function addSession(session: SessionSummary): void          // Add new session
function removeSession(sessionId: string): void             // Delete session
function setCurrentId(id: string | null): void              // Switch active session
function updateSession(sessionId: string, patch: Partial<SessionSummary>): void
function setSearchQuery(query: string): void                // Filter sessions
function updateSessionModel(sessionId: string, modelId: string): void

// ── Getters ──
const currentSession: ComputedRef<SessionSummary | undefined>  // sessions.find by currentSessionId
const sessionGroups: ComputedRef<SessionGroup[]>               // Grouped by cwd, sorted by lastActivity
const filteredGroups: ComputedRef<SessionGroup[]>              // sessionGroups filtered by searchQuery
const currentCwd: ComputedRef<string | undefined>              // currentSession?.cwd
const currentModel: ComputedRef<string | undefined>            // currentSession?.modelId

// ── Consumers ──
// AppSidebar.vue       → filteredGroups, searchQuery
// SessionGroup.vue     → group (from filteredGroups)
// SessionItem.vue      → session (from group), active (=== currentSessionId)
// AppStatusbar.vue     → currentCwd, currentModel
// ChatView.vue         → currentSession (for panel bar label)
// ChatInput.vue        → currentSessionId (for ws send)
```

**Persistence**: `currentSessionId` persisted to localStorage via `pinia-plugin-persistedstate`. Session list always reloaded from Sidecar on connect.

### 4.3 `useSettingsStore` (Pinia — `stores/settings.ts`)

**Responsibility**: Global UI settings, connection status, provider/model metadata.

```typescript
// ── State ──
interface SettingsState {
  // UI preferences (persisted)
  theme: 'light' | 'dark' | 'system'         // Theme mode
  locale: 'zh-CN' | 'en-US'                   // Language
  viewMode: 'standard' | 'focus' | 'settings' // Current view mode

  // Provider/model config (from Sidecar, not persisted locally)
  providers: ProviderInfo[]                    // All configured providers
  models: ModelInfo[]                          // All available models
  defaultModel: string                         // Default model ID
  thinkingMode: 'low' | 'medium' | 'high'     // Thinking budget
  temperature: number                          // Generation temperature

  // Connection status (ephemeral)
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting'
}

// ── Actions ──
function setTheme(theme: 'light' | 'dark' | 'system'): void
function setLocale(locale: 'zh-CN' | 'en-US'): void
function setViewMode(mode: 'standard' | 'focus' | 'settings'): void
function setProviders(providers: ProviderInfo[]): void
function setModels(models: ModelInfo[]): void
function setDefaultModel(modelId: string): void
function setThinkingMode(mode: 'low' | 'medium' | 'high'): void
function setTemperature(temp: number): void
function setConnectionStatus(status: ConnectionStatus): void
function updateProvider(providerId: string, patch: Partial<ProviderInfo>): void

// ── Getters ──
const effectiveTheme: ComputedRef<'light' | 'dark'>       // Resolved theme (system → actual)
const recentModels: ComputedRef<ModelInfo[]>              // Top 4 recently used models
const modelsByProvider: ComputedRef<Map<string, ModelInfo[]>>  // Grouped models for ModelPicker
const isConnected: ComputedRef<boolean>                   // connectionStatus === 'connected'
const providerById: (id: string) => ComputedRef<ProviderInfo | undefined>

// ── Consumers ──
// ThemeProvider.vue     → theme, effectiveTheme
// AppHeader.vue         → viewMode, theme
// AppStatusbar.vue      → connectionStatus, currentModel
// SettingsView.vue      → providers, models, defaultModel, theme, locale, temperature
// ModelPicker.vue       → recentModels, modelsByProvider
// ChatInput.vue         → defaultModel (initial selection)
// useConnection         → setConnectionStatus
// useProvider           → setProviders
// useModel              → setModels
// useTheme              → theme, setTheme
```

**Persistence**: Via `pinia-plugin-persistedstate`, persisting only:
```typescript
// Persistence config
{
  paths: ['theme', 'locale', 'viewMode', 'defaultModel', 'thinkingMode', 'temperature'],
  storage: localStorage,
}
```

### 4.4 Store → Component Consumption Map

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   useChatStore   │     │  useSessionStore  │     │  useSettingsStore │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                         │
    ┌────┼────────────────────────┼─────────────────────────┼────┐
    │    │                        │                         │    │
    ▼    ▼                        ▼                         ▼    ▼
 MessageList                  AppSidebar               AppHeader
 MessageBubble                SessionGroup              AppStatusbar
 ToolCallCard                 SessionItem               SettingsView
 StreamingText                SessionSearch             ModelPicker
 ChatInput                    ChatView                  ProviderList
 ContextBar                                            ProviderForm
```

---

## 5. Composable Dependency Graph

### 5.1 Composable Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          Composables Layer                                │
│                                                                           │
│  useChat.ts          useSession.ts         useModel.ts                   │
│  useProvider.ts      useConnection.ts      useTheme.ts (from design/)   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Dependency Matrix

```
composable          │ depends on stores           │ calls ws-client  │ used by components
────────────────────┼─────────────────────────────┼──────────────────┼──────────────────────────
useChat             │ useChatStore                │ send()           │ ChatView, ChatInput
                    │                             │ on('message.*')  │ MessageList
────────────────────┼─────────────────────────────┼──────────────────┼──────────────────────────
useSession          │ useSessionStore             │ send()           │ AppSidebar
                    │ useChatStore (clear/replace)│ on('session.*')  │ SessionItem, SessionGroup
────────────────────┼─────────────────────────────┼──────────────────┼──────────────────────────
useModel            │ useSettingsStore (models)   │ send()           │ ModelPicker
                    │ useSessionStore (model)     │ on('model.*')    │ ChatInput
────────────────────┼─────────────────────────────┼──────────────────┼──────────────────────────
useProvider         │ useSettingsStore (providers)│ send()           │ SettingsView
                    │                             │ on('config.*')   │ ProviderList, ProviderForm
────────────────────┼─────────────────────────────┼──────────────────┼──────────────────────────
useConnection       │ useSettingsStore (status)   │ connect()        │ App.vue (root)
                    │ useSessionStore (init load) │ on('open/close') │
                    │ useChatStore (clear)        │ reconnect loop   │
────────────────────┼─────────────────────────────┼──────────────────┼──────────────────────────
useTheme            │ useSettingsStore (theme)    │ (none)           │ ThemeProvider, AppHeader
────────────────────┼─────────────────────────────┼──────────────────┼──────────────────────────
```

### 5.3 Composable → ws-client Call Map

```
useChat:
  wsClient.send('message.send', { sessionId, content })
  wsClient.send('message.abort', { sessionId })
  listens: 'message.text_delta', 'message.thinking_delta',
           'message.tool_call_start', 'message.tool_call_end',
           'message.complete', 'message.error'

useSession:
  wsClient.send('session.create', { cwd })
  wsClient.send('session.delete', { sessionId })
  wsClient.send('session.list', {})
  wsClient.send('session.switch', { sessionId })
  listens: 'session.created', 'session.deleted', 'session.list', 'session.history'

useModel:
  wsClient.send('model.list', {})
  wsClient.send('model.switch', { sessionId, modelId })
  listens: 'model.list', 'model.switched'

useProvider:
  wsClient.send('config.getProviders', {})
  wsClient.send('config.setProvider', { providerId, ... })
  wsClient.send('config.deleteProvider', { providerId })
  listens: 'config.providers', 'config.providerUpdated'

useConnection:
  wsClient.connect(url)
  wsClient.disconnect()
  sends initial: 'session.list', 'config.getProviders', 'model.list'
  sends periodic: 'ping'
  listens: 'pong', 'error'
```

### 5.4 ws-client / event-bus Architecture

```
┌──────────────────────────────────────────────┐
│  ws-client.ts  (lib/ws-client.ts)            │
│                                              │
│  Responsibilities:                           │
│  • WebSocket connection lifecycle            │
│  • JSON message serialization/deserialization │
│  • Request ID generation for req/res pairing │
│  • Outbound message queue (buffer during     │
│    reconnect)                                │
│  • Routes all inbound messages to event-bus  │
│                                              │
│  API:                                        │
│  ┌─────────────────────────────────────────┐ │
│  │ connect(url: string): void              │ │
│  │ disconnect(): void                      │ │
│  │ send(type: string, payload: any): void  │ │
│  │ sendWithResponse<T>(type, payload):     │ │
│  │   Promise<T>                            │ │
│  │ on(type: string, handler: Function):    │ │
│  │   () => void  // returns unsub fn      │ │
│  │ get status(): ConnectionStatus          │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────┬────────────────────────┘
                      │ all inbound messages
                      ▼
┌──────────────────────────────────────────────┐
│  event-bus.ts  (lib/event-bus.ts)            │
│                                              │
│  Type-safe event emitter:                    │
│  ┌─────────────────────────────────────────┐ │
│  │ emit(event: WSEventType, payload): void │ │
│  │ on(event, handler): () => void          │ │
│  │ off(event, handler): void               │ │
│  │ once(event, handler): () => void        │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  WSEventType = union of all protocol types   │
│  (defined in lib/protocol.ts)                │
└─────────────────────┬────────────────────────┘
                      │ composables subscribe
                      ▼
┌──────────────────────────────────────────────┐
│  Composables (useChat, useSession, ...)      │
│                                              │
│  Each composable:                            │
│  1. Subscribes to relevant events in setup() │
│  2. Unsubscribes in onUnmounted()            │
│  3. Transforms payload → store action call   │
└──────────────────────────────────────────────┘
```

---

## 6. Design Token → Component Mapping

### 6.1 Color Tokens

| Token | Light Value | Dark Value | Used By |
|-------|-------------|------------|---------|
| `--color-bg-base` | `oklch(97% 0.018 70)` | `oklch(20% 0.015 50)` | App background, ToolCallCard body |
| `--color-surface` | `oklch(99% 0.008 70)` | `oklch(25% 0.015 50)` | Header, Sidebar, Statusbar bg; MessageBubble (assistant); Settings panels |
| `--color-text-primary` | `oklch(22% 0.02 50)` | `oklch(92% 0.008 70)` | All primary text: message body, sidebar titles, settings labels |
| `--color-text-muted` | `oklch(50% 0.018 50)` | `oklch(65% 0.015 50)` | Secondary text: timestamps, provider names, toolbar labels, Statusbar text |
| `--color-border` | `oklch(90% 0.014 70)` | `oklch(35% 0.015 50)` | All borders: header bottom, sidebar right, card borders, input border |
| `--color-accent` | `oklch(64% 0.13 28)` | `oklch(68% 0.13 28)` | Primary accent: send button bg, active sidebar item border, model picker selected, link color, focused input border |
| `--color-accent-light` | `oklch(92% 0.04 28)` | `oklch(30% 0.06 28)` | Hover/active bg: sidebar item hover, active session bg, button hover, MessageBubble (user) bg |
| `--color-success` | `oklch(70% 0.18 145)` | same | Connected status dot, tool call "done" badge, provider "connected" badge, done notification chips |
| `--color-warning` | `oklch(78% 0.15 85)` | same | Reconnecting status, context bar at >60%, paused session dot |
| `--color-danger` | `oklch(62% 0.2 25)` | same | Error status, disconnected dot, context bar at >90%, error messages, delete confirmations |

### 6.2 Component → Token Usage Detail

```
MessageBubble.vue
├── user message bg       → --color-accent-light
├── user message text     → --color-text-primary
├── assistant message bg  → --color-surface
├── assistant border      → --color-border
├── assistant text        → --color-text-primary
├── code inline bg        → --color-bg-base
└── role label            → --color-text-muted

ToolCallCard.vue
├── outer border          → --color-border
├── card bg               → --color-bg-base
├── tool name             → --color-accent
├── file path             → --color-text-muted
├── status "done"         → --color-success (via Badge)
├── status "running"      → --color-accent (via Badge, animated)
├── status "error"        → --color-danger (via Badge)
├── expanded body text    → --color-text-muted
└── header hover bg       → --color-accent-light

ThinkingBlock.vue
├── collapsed label       → --color-text-muted
├── "思考中…" animated    → --color-accent
├── expanded bg           → --color-surface
├── border-left           → --color-accent
└── thinking text         → --color-text-primary

ChatInput.vue
├── container bg          → --color-surface
├── container border      → --color-border
├── focused border        → --color-accent
├── textarea text         → --color-text-primary
├── placeholder           → --color-text-muted
├── send button bg        → --color-accent
├── ghost button hover    → --color-accent-light + --color-accent text
└── toolbar text          → --color-text-muted

ContextBar.vue
├── bar track bg          → --color-border
├── fill < 60%            → --color-accent
├── fill 60-90%           → --color-warning
└── fill > 90%            → --color-danger

ModelPicker.vue
├── trigger text          → --color-text-primary
├── provider label        → --color-text-muted
├── dropdown bg           → --color-surface
├── dropdown border       → --color-border
├── item hover bg         → --color-accent-light
├── selected text         → --color-accent
└── section title         → --color-text-muted

SessionItem.vue
├── hover bg              → --color-accent-light
├── active border-left    → --color-accent
├── active bg             → --color-accent-light
├── status dot idle       → --color-border (via Badge)
├── status dot running    → --color-success (via Badge, animated)
├── title text            → --color-text-primary
└── time text             → --color-text-muted

AppStatusbar.vue
├── bg                    → --color-surface
├── border-top            → --color-border
├── text                  → --color-text-muted
├── connected dot         → --color-success (via Badge)
├── disconnected dot      → --color-danger (via Badge)
└── reconnecting dot      → --color-warning (via Badge)

ProviderList → provider-card
├── card bg               → --color-surface
├── card border           → --color-border
├── hover border          → --color-accent
├── connected badge       → --color-success-light bg + --color-success text
└── disconnected badge    → --color-border bg + --color-muted text
```

### 6.3 Typography Tokens

| Token | Value | Used By |
|-------|-------|---------|
| `--font-display` | `'Tiempos Headline', 'Newsreader', Georgia, serif` | AppHeader logo, Settings sidebar title |
| `--font-body` | `-apple-system, BlinkMacSystemFont, system-ui, sans-serif` | All UI text (default body font) |
| `--font-mono` | `'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace` | ToolCallCard name/path, code blocks, ModelPicker item names, Statusbar model label |

### 6.4 Spacing & Layout Tokens

| Token | Value | Used By |
|-------|-------|---------|
| `--sidebar-width` | `260px` | AppSidebar default width |
| `--header-height` | `48px` | AppHeader fixed height |
| `--statusbar-height` | `32px` | AppStatusbar fixed height |
| `--radius-lg` | `12px` | ChatInput container, MessageBubble, Dialog |
| `--radius-md` | `8px` | Button, ProviderCard, SettingsTab |
| `--radius-sm` | `4px` | Badge, small buttons, input corners |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | All transitions (theme switch, hover, collapse) |

---

## 7. i18n Key Structure

Complete key namespace for P1, supporting `zh-CN` and `en-US`.

### 7.1 Key Tree

```typescript
// i18n/types.ts — Schema type for type-safe key completion
export interface MessageSchema {
  common: {
    send: string
    cancel: string
    save: string
    delete: string
    edit: string
    close: string
    search: string
    loading: string
    confirm: string
    retry: string
    copied: string
    error: string
    success: string
    yes: string
    no: string
  }

  header: {
    logo: string                    // "xyz-agent"
    viewStandard: string            // "标准模式"
    viewSplit: string               // "分屏模式" (disabled)
    viewFocus: string               // "专注模式"
    settings: string                // "设置"
    toggleTheme: string             // "切换主题"
    notifications: string           // "通知" (P5 预留)
  }

  sidebar: {
    sessions: string                // "会话"
    newSession: string              // "新建会话"
    searchPlaceholder: string       // "搜索会话…"
    deleteConfirm: string           // "确定删除此会话？"
    rename: string                  // "重命名"
    delete: string                  // "删除"
    noSessions: string              // "暂无会话"
    statusActive: string            // "活跃"
    statusIdle: string              // "闲置"
  }

  chat: {
    inputPlaceholder: string        // "输入消息… (Enter 发送, Shift+Enter 换行)"
    send: string                    // "发送"
    stop: string                    // "中断"
    thinking: string                // "思考中…"
    thinkingComplete: string        // "查看思考过程"
    toolRunning: string             // "运行中"
    toolDone: string                // "完成"
    toolError: string               // "出错"
    userRole: string                // "用户"
    assistantRole: string           // "助手"
    systemRole: string              // "系统"
    contextUsage: string            // "上下文"
    uploadFile: string              // "上传文件"
    slashPlaceholder: string        // "输入 / 查看命令…"
    noMessages: string              // "开始对话"
    generating: string              // "生成中…"
    aborted: string                 // "已中断"
    errorMessage: string            // "生成出错"
  }

  settings: {
    title: string                   // "设置"
    providers: string               // "供应商"
    skills: string                  // "SKILL"
    agents: string                  // "AGENT"
    providersTitle: string          // "已配置的供应商"
    addProvider: string             // "添加供应商"
    editProvider: string            // "编辑供应商"
    deleteProvider: string          // "删除供应商"
    deleteProviderConfirm: string   // "确定删除此供应商配置？"
    apiKey: string                  // "API Key"
    apiKeyPlaceholder: string       // "输入 API Key"
    baseUrl: string                 // "Base URL"
    baseUrlPlaceholder: string      // "https://api.example.com"
    connected: string               // "已连接"
    disconnected: string            // "未连接"
    defaultModel: string            // "默认模型"
    thinkingMode: string            // "思考模式"
    thinkingLow: string             // "低"
    thinkingMedium: string          // "中"
    thinkingHigh: string            // "高"
    temperature: string             // "温度"
    language: string                // "语言"
    theme: string                   // "主题"
    themeLight: string              // "浅色"
    themeDark: string               // "深色"
    themeSystem: string             // "跟随系统"
    defaultConfig: string           // "默认配置"
    interfaceSection: string        // "界面"
    comingSoon: string              // "即将推出"
    providerSaved: string           // "供应商配置已保存"
    providerDeleted: string         // "供应商配置已删除"
  }

  status: {
    connected: string               // "已连接"
    disconnected: string            // "已断开"
    reconnecting: string            // "重连中…"
    tokens: string                  // "{count} tokens"
    shortcuts: string               // "Cmd+J 总览 · Cmd+1 标准 · Cmd+3 专注"
  }

  overview: {
    title: string                   // "窗口总览"
    comingSoon: string              // "即将推出 (Phase 4)"
    enter: string                   // "进入"
    splitEnter: string              // "分屏进入"
  }
}
```

### 7.2 `zh-CN.ts` Locale File

```typescript
export const zhCN: MessageSchema = {
  common: {
    send: '发送',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    edit: '编辑',
    close: '关闭',
    search: '搜索',
    loading: '加载中…',
    confirm: '确认',
    retry: '重试',
    copied: '已复制',
    error: '出错',
    success: '成功',
    yes: '是',
    no: '否',
  },
  header: {
    logo: 'xyz-agent',
    viewStandard: '标准模式',
    viewSplit: '分屏模式',
    viewFocus: '专注模式',
    settings: '设置',
    toggleTheme: '切换主题',
    notifications: '通知',
  },
  sidebar: {
    sessions: '会话',
    newSession: '新建会话',
    searchPlaceholder: '搜索会话…',
    deleteConfirm: '确定删除此会话？此操作不可撤销。',
    rename: '重命名',
    delete: '删除',
    noSessions: '暂无会话',
    statusActive: '活跃',
    statusIdle: '闲置',
  },
  chat: {
    inputPlaceholder: '输入消息… (Enter 发送, Shift+Enter 换行)',
    send: '发送',
    stop: '中断',
    thinking: '思考中…',
    thinkingComplete: '查看思考过程',
    toolRunning: '运行中',
    toolDone: '完成',
    toolError: '出错',
    userRole: '用户',
    assistantRole: '助手',
    systemRole: '系统',
    contextUsage: '上下文',
    uploadFile: '上传文件',
    slashPlaceholder: '输入 / 查看命令…',
    noMessages: '发送消息开始对话',
    generating: '生成中…',
    aborted: '已中断',
    errorMessage: '生成出错，请重试',
  },
  settings: {
    title: '设置',
    providers: '供应商',
    skills: 'SKILL',
    agents: 'AGENT',
    providersTitle: '已配置的供应商',
    addProvider: '添加供应商',
    editProvider: '编辑供应商',
    deleteProvider: '删除供应商',
    deleteProviderConfirm: '确定删除此供应商配置？',
    apiKey: 'API Key',
    apiKeyPlaceholder: '输入 API Key',
    baseUrl: 'Base URL',
    baseUrlPlaceholder: 'https://api.example.com',
    connected: '已连接',
    disconnected: '未连接',
    defaultModel: '默认模型',
    thinkingMode: '思考模式',
    thinkingLow: '低',
    thinkingMedium: '中',
    thinkingHigh: '高',
    temperature: '温度',
    language: '语言',
    theme: '主题',
    themeLight: '浅色',
    themeDark: '深色',
    themeSystem: '跟随系统',
    defaultConfig: '默认配置',
    interfaceSection: '界面',
    comingSoon: '即将推出',
    providerSaved: '供应商配置已保存',
    providerDeleted: '供应商配置已删除',
  },
  status: {
    connected: '已连接',
    disconnected: '已断开',
    reconnecting: '重连中…',
    tokens: '{count} tokens',
    shortcuts: '⌘J 总览 · ⌘1 标准 · ⌘3 专注',
  },
  overview: {
    title: '窗口总览',
    comingSoon: '即将推出 (Phase 4)',
    enter: '进入',
    splitEnter: '分屏进入',
  },
}
```

### 7.3 `en-US.ts` Locale File

```typescript
export const enUS: MessageSchema = {
  common: {
    send: 'Send',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    close: 'Close',
    search: 'Search',
    loading: 'Loading…',
    confirm: 'Confirm',
    retry: 'Retry',
    copied: 'Copied',
    error: 'Error',
    success: 'Success',
    yes: 'Yes',
    no: 'No',
  },
  header: {
    logo: 'xyz-agent',
    viewStandard: 'Standard',
    viewSplit: 'Split',
    viewFocus: 'Focus',
    settings: 'Settings',
    toggleTheme: 'Toggle theme',
    notifications: 'Notifications',
  },
  sidebar: {
    sessions: 'Sessions',
    newSession: 'New session',
    searchPlaceholder: 'Search sessions…',
    deleteConfirm: 'Delete this session? This cannot be undone.',
    rename: 'Rename',
    delete: 'Delete',
    noSessions: 'No sessions',
    statusActive: 'Active',
    statusIdle: 'Idle',
  },
  chat: {
    inputPlaceholder: 'Type a message… (Enter to send, Shift+Enter for new line)',
    send: 'Send',
    stop: 'Stop',
    thinking: 'Thinking…',
    thinkingComplete: 'View thinking',
    toolRunning: 'Running',
    toolDone: 'Done',
    toolError: 'Error',
    userRole: 'User',
    assistantRole: 'Assistant',
    systemRole: 'System',
    contextUsage: 'Context',
    uploadFile: 'Upload file',
    slashPlaceholder: 'Type / for commands…',
    noMessages: 'Send a message to start',
    generating: 'Generating…',
    aborted: 'Aborted',
    errorMessage: 'Generation error, please retry',
  },
  settings: {
    title: 'Settings',
    providers: 'Providers',
    skills: 'SKILL',
    agents: 'AGENT',
    providersTitle: 'Configured providers',
    addProvider: 'Add provider',
    editProvider: 'Edit provider',
    deleteProvider: 'Delete provider',
    deleteProviderConfirm: 'Delete this provider configuration?',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'Enter API Key',
    baseUrl: 'Base URL',
    baseUrlPlaceholder: 'https://api.example.com',
    connected: 'Connected',
    disconnected: 'Disconnected',
    defaultModel: 'Default model',
    thinkingMode: 'Thinking mode',
    thinkingLow: 'Low',
    thinkingMedium: 'Medium',
    thinkingHigh: 'High',
    temperature: 'Temperature',
    language: 'Language',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',
    defaultConfig: 'Default configuration',
    interfaceSection: 'Interface',
    comingSoon: 'Coming soon',
    providerSaved: 'Provider configuration saved',
    providerDeleted: 'Provider configuration deleted',
  },
  status: {
    connected: 'Connected',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting…',
    tokens: '{count} tokens',
    shortcuts: '⌘J Overview · ⌘1 Standard · ⌘3 Focus',
  },
  overview: {
    title: 'Overview',
    comingSoon: 'Coming in Phase 4',
    enter: 'Enter',
    splitEnter: 'Split enter',
  },
}
```

### 7.4 i18n Usage Patterns

```vue
<!-- In components: use $t() or t() from useI18n() -->
<template>
  <Button>{{ t('common.send') }}</Button>
  <Input :placeholder="t('sidebar.searchPlaceholder')" />
  <span>{{ t('status.tokens', { count: formattedTokens }) }}</span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MessageSchema } from '@/i18n/types'

// Type-safe: only valid keys from MessageSchema are accepted
const { t } = useI18n<{ message: MessageSchema }>()
</script>
```

---

## Appendix A: File → Module Responsibility

```
src/
├── App.vue                         # Root: viewMode routing, composable init
├── main.ts                         # Vue app create, Pinia/i18n/router plugins
│
├── design-system/                  # Shared component library
│   ├── tokens/                     # CSS custom property definitions
│   ├── theme/                      # ThemeProvider.vue, useTheme.ts
│   └── components/                 # 12 design-system components
│
├── i18n/                           # Internationalization
│   ├── index.ts                    # vue-i18n plugin config
│   ├── types.ts                    # MessageSchema type export
│   └── locales/                    # zh-CN.ts, en-US.ts
│
├── components/
│   ├── layout/                     # App shell components
│   │   ├── AppHeader.vue           # Header bar
│   │   ├── AppStatusbar.vue        # Status bar
│   │   ├── AppSidebar.vue          # Sidebar container
│   │   └── SettingsView.vue        # Full-screen settings
│   ├── sidebar/                    # Sidebar content
│   │   ├── SessionSearch.vue       # Search input
│   │   ├── SessionGroup.vue        # cwd-grouped list
│   │   └── SessionItem.vue         # Single session row
│   ├── chat/                       # Chat area
│   │   ├── ChatView.vue            # Chat layout container
│   │   ├── MessageList.vue         # Virtual scroll wrapper
│   │   ├── MessageBubble.vue       # User/assistant message
│   │   ├── ToolCallCard.vue        # Tool call display
│   │   ├── ThinkingBlock.vue       # Thinking fold block
│   │   ├── StreamingText.vue       # Streaming markdown renderer
│   │   ├── ChatInput.vue           # Input area + toolbar
│   │   ├── ModelPicker.vue         # Model selector dropdown
│   │   ├── ContextBar.vue          # Token usage indicator
│   │   └── SlashMenu.vue           # / command palette (P1 scaffold)
│   └── settings/                   # Settings content
│       ├── ProviderList.vue        # Provider card list
│       └── ProviderForm.vue        # Add/edit provider form
│
├── composables/                    # Business logic composables
│   ├── useChat.ts                  # Message send/receive/streaming
│   ├── useSession.ts               # Session CRUD + switching
│   ├── useModel.ts                 # Model list + switching
│   ├── useProvider.ts              # Provider config management
│   └── useConnection.ts            # WS connection lifecycle
│
├── stores/                         # Pinia state stores
│   ├── chat.ts                     # useChatStore
│   ├── session.ts                  # useSessionStore
│   └── settings.ts                 # useSettingsStore
│
├── lib/                            # Infrastructure
│   ├── ws-client.ts                # WebSocket client
│   ├── event-bus.ts                # Frontend event bus
│   └── protocol.ts                 # WS message type definitions
│
└── types/                          # TypeScript type definitions
    ├── message.ts                  # Message, ToolCall, Thinking
    ├── session.ts                  # Session, SessionSummary, SessionGroup
    ├── provider.ts                 # Provider, Model, ProviderInfo
    └── protocol.ts                 # WS protocol types (mirrors lib/protocol.ts)
```

## Appendix B: Key Type Definitions

```typescript
// types/message.ts
interface Message {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_call' | 'thinking'
  content: string
  timestamp: number
  isStreaming?: boolean
  metadata?: Record<string, unknown>
}

interface ToolCall {
  id: string
  toolName: string
  input: string
  output?: string
  status: 'running' | 'done' | 'error'
  timestamp: number
}

// types/session.ts
interface SessionSummary {
  id: string
  label: string
  cwd: string
  modelId: string
  status: 'active' | 'idle'
  lastActivity: number           // Unix timestamp
  messageCount: number
  tokenUsage: number
}

interface SessionGroup {
  cwd: string
  label: string                  // basename(cwd)
  sessions: SessionSummary[]
}

// types/provider.ts
interface ProviderInfo {
  id: string
  name: string
  isConnected: boolean
  models: string[]
  apiKeySet: boolean
  baseUrl?: string
}

interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
}
```

## Appendix C: Keyboard Shortcuts (P1)

| Shortcut | Action | Context |
|----------|--------|---------|
| `Cmd+1` | Switch to Standard view | Global |
| `Cmd+3` | Switch to Focus view | Global |
| `Cmd+,` | Open Settings | Global |
| `Enter` | Send message | ChatInput focused |
| `Shift+Enter` | New line | ChatInput focused |
| `Escape` | Close settings / cancel | Global |
| `/` | Open slash menu | ChatInput focused |
| `Cmd+J` | Overview (P4, disabled) | Global |

## Appendix D: Virtual Scroll Strategy

`MessageList.vue` uses `@tanstack/vue-virtual` for efficient rendering of long conversation histories.

```
MessageList.vue
├── Uses useVirtual() from @tanstack/vue-virtual
├── Each MessageBubble/ToolCallCard/ThinkingBlock has estimated height:
│   ├── User message: ~60px base + content
│   ├── Assistant message: ~80px base + content (markdown may be long)
│   ├── Tool call (collapsed): ~36px
│   ├── Tool call (expanded): ~200px (max-height capped)
│   └── Thinking (collapsed): ~32px
├── Dynamic height measurement via ResizeObserver
├── Auto-scroll to bottom on new message (unless user scrolled up)
└── Scroll anchoring: maintain position when prepending history
```
