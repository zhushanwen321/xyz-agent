---
verdict: pass
---

# Statusline — API Contract

> 本文档是 `plan.md` 的 API 契约子文档，定义前后端集成点的完整接口签名。
> 后端设计细节见 `plan-backend.md`，前端设计细节见 `plan-frontend.md`。

---

## 1. 共享类型 (shared/protocol.ts)

### 1.1 StatusBarItem（扩展后）

```typescript
export interface StatusBarItem {
  id: string                              // 唯一 item ID（如 'pi-goal'）
  pluginId: string                        // 所属 plugin ID（如 'statusline'）
  text: string                            // 显示文本（如 '◆ Goal 3/20'）
  tooltip?: string                        // hover 提示
  commandId?: string                      // 点击执行的 command ID
  priority: number                        // 排序优先级（越小越靠前）
  scope: 'per-session' | 'global'        // 路由范围（NEW）
  sessionId?: string                      // per-session 绑定的 session ID（NEW）
}
```

**变更说明:**
- 新增 `scope` 字段，决定前端路由到 SessionStrip 还是 GlobalStatusbar
- 新增 `sessionId` 字段，per-session items 绑定到具体 session
- 现有代码中未填充 scope/sessionId 的 StatusBarItem，由 plugin-service 填充默认值

### 1.2 StatusSetUpdatePayload（新增）

```typescript
export interface StatusSetUpdatePayload {
  sessionId: string     // 来源 session
  key: string           // pi extension setStatus key（如 'goal'）
  text: string          // 状态文本（如 '◆ Goal 3/20 | 2/5'）
}
```

### 1.3 ServerMessageType 扩展

```typescript
export type ServerMessageType =
  | ...  // 现有类型不变
  | 'plugin:statusBarUpdate'      // 现有，广播 status bar items 到前端
  | 'plugin:statusSetUpdate'      // 新增，sidecar 内部：event-adapter 翻译的 setStatus 事件
  | ...
```

**注意:** `plugin:statusSetUpdate` 仅用于 sidecar 内部消息路由（event-adapter → server → plugin hooks），不广播到前端 WebSocket。前端唯一消费的 plugin 消息是 `plugin:statusBarUpdate`。

---

## 2. WebSocket 消息契约

### 2.1 Server → Client 消息

#### plugin:statusBarUpdate（现有，payload 扩展）

```
type: 'plugin:statusBarUpdate'
payload: {
  items: StatusBarItem[]    // 完整的 items 列表（替换式）
}
```

**payload.items 变更:**
- 每个 StatusBarItem 新增 `scope` 和 `sessionId` 字段
- 前端需要处理旧消息（无 scope/sessionId）的兼容：默认 scope='global'

**广播时机:**
- 任意 plugin 调用 `updateStatusBarItem()` 后
- plugin deactivate 清理 items 后

**前端处理:**
- 替换式更新：`pluginStore.statusBarItems = payload.items`
- 按 scope 路由：
  - `scope === 'per-session' && sessionId === currentPanelSessionId` → SessionStrip
  - `scope === 'global'` → GlobalStatusbar

#### plugin:statusSetUpdate（内部消息，不广播到前端）

```
type: 'plugin:statusSetUpdate'
payload: StatusSetUpdatePayload { sessionId, key, text }
```

**路由:** event-adapter → server → pluginService.handleBridgeEvent → plugin hooks

### 2.2 Client → Server 消息

无新增消息类型。现有 `plugin.executeCommand` 用于 status bar chip 的点击交互。

---

## 3. RPC 方法契约（Plugin Worker ↔ 主线程）

### 3.1 plugin.ui.updateStatusBarItem（修改）

**方法名:** `plugin.ui.updateStatusBarItem`

**请求参数:**
```typescript
{
  pluginId: string
  id: string
  text: string
  options?: StatusBarItemOptions    // 新增
}
```

**响应:** `void`（无返回值）

**变更说明:**
- 新增可选 `options` 参数
- 不传 options 时行为与修改前完全一致（priority=100, scope='global'）

### 3.2 StatusBarItemOptions（新增类型）

```typescript
export interface StatusBarItemOptions {
  tooltip?: string                         // hover 提示
  commandId?: string                       // 点击执行的 command
  priority?: number                        // 排序优先级，默认 100
  scope?: 'per-session' | 'global'        // 路由范围，默认 'global'
  sessionId?: string                       // per-session 绑定
}
```

**默认值:**
| 字段 | 默认值 |
|------|--------|
| tooltip | undefined |
| commandId | undefined |
| priority | 100 |
| scope | 'global' |
| sessionId | undefined |

### 3.3 不变的 RPC 方法

| 方法名 | 签名 | 说明 |
|--------|------|------|
| plugin.ui.showSelect | `(title, options, pluginId) → string \| undefined` | 不变 |
| plugin.ui.showConfirm | `(title, message, pluginId) → boolean` | 不变 |
| plugin.ui.showInput | `(title, defaultValue?, pluginId) → string \| undefined` | 不变 |
| plugin.ui.notify | `(pluginId, level, message) → void` | 不变 |

---

## 4. Plugin API 签名（Phase2AgentAPI）

### 4.1 ui.updateStatusBarItem（修改）

**调用侧（Worker proxy）:**
```typescript
updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
```

**与修改前的差异:**
```diff
- updateStatusBarItem(id: string, text: string): Promise<void>
+ updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
```

**向后兼容:** `options` 为可选参数，不传时行为不变。

### 4.2 hooks.onPiEvent（现有，本次新增使用场景）

**签名（不变）:**
```typescript
onPiEvent(eventName: string, handler: PiEventCallback): Promise<Disposable>
```

**新增使用场景:**
- statusline plugin 注册 `onPiEvent('plugin:statusSetUpdate', handler)` 监听 setStatus 事件

**hook handler 接收的数据结构:**
```typescript
// PiEventCallback 的 data 参数
data: {
  eventName: string           // 'plugin:statusSetUpdate'
  data: StatusSetUpdatePayload  // { sessionId, key, text }
  sessionId: string           // 来源 session
}
```

### 4.3 不变的 Phase2AgentAPI 方法

| 模块 | 方法 | 签名 |
|------|------|------|
| tools | register | `(registration: ToolRegistration) → Promise<string>` |
| tools | unregister | `(toolKey: string) → Promise<void>` |
| hooks | onBeforeSendMessage | `(handler) → Promise<Disposable>` |
| hooks | onBeforeToolCall | `(handler) → Promise<Disposable>` |
| hooks | onBeforeAgentStart | `(handler) → Promise<Disposable>` |
| hooks | onAfterToolResult | `(handler) → Promise<Disposable>` |
| hooks | onPiEvent | `(eventName, handler) → Promise<Disposable>` |
| config | get/set/getAll | 不变 |
| sessionData | get/set/delete/keys | 不变 |
| ui | showSelect/showConfirm/showInput/notify | 不变 |
| agent | setModel/getModel/getThinkingLevel/setThinkingLevel/getActiveTools | 不变 |
| workspace | rootPath/name/findFiles | 不变 |

---

## 5. Sidecar 内部方法契约

### 5.1 EventAdapterOptions（扩展）

```typescript
export interface EventAdapterOptions {
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string) => void
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string }) => void    // 新增
}
```

### 5.2 Server.handleStatusSetUpdate（新增）

```typescript
handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string }): void
```

**行为:** 调用 `pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, payload.sessionId)`

### 5.3 Server.handleBridgeRequest（修改 bridge:event 分支）

**修改前:**
```typescript
case 'bridge:event': {
  const eventName = data.eventName as string
  console.log(`[server] bridge event: ${eventName} from session ${sessionId}`)
  await client.sendCommand('extension_ui_response', { id: requestId, response: null })
  return
}
```

**修改后:** 在 console.log 和 sendCommand 之间插入 `pluginService.handleBridgeEvent(eventName, eventData, sessionId)`

### 5.4 PluginService.handleBridgeEvent（现有，不修改签名）

```typescript
handleBridgeEvent(eventName: string, data: unknown, sessionId: string): void
```

**行为:** 构造 HookContext → executeHooks → 通知所有注册了对应 eventName 的 plugin hooks

### 5.5 PluginService.updateStatusBarItem（修改）

```typescript
// 修改前
updateStatusBarItem(pluginId: string, id: string, text: string): Promise<void>

// 修改后
updateStatusBarItem(pluginId: string, id: string, text: string, options?: StatusBarItemOptions): Promise<void>
```

### 5.6 PluginService.getStatusBarItems（新增）

```typescript
getStatusBarItems(): StatusBarItem[]
```

### 5.7 PluginService.clearStatusBarItems（新增，建议）

```typescript
clearStatusBarItems(pluginId: string): void
```

**行为:** 从 Map 中删除所有 `pluginId` 匹配的 items，广播更新

---

## 6. 前后端集成点

### 6.1 前端需要处理的 WS 消息

| 消息类型 | 方向 | payload | 前端处理 |
|---------|------|---------|---------|
| `plugin:statusBarUpdate` | Server→Client | `{ items: StatusBarItem[] }` | 替换 pluginStore.statusBarItems，按 scope 路由 |

**前端不需要处理** `plugin:statusSetUpdate`（这是 sidecar 内部消息）。

### 6.2 前端发送的 WS 消息

| 消息类型 | 方向 | payload | 用途 |
|---------|------|---------|------|
| `plugin.executeCommand` | Client→Server | `{ pluginId, commandId, args? }` | 点击有 commandId 的 status bar chip |

### 6.3 前端 store 数据结构

**pluginStore 新增 computed:**

```typescript
// 获取指定 session 的 per-session status bar items
getSessionStatusBarItems(sessionId: string): StatusBarItem[]

// 获取所有 global status bar items（按 priority 排序）
globalStatusBarItems: ComputedRef<StatusBarItem[]>
```

### 6.4 前端组件数据消费

| 组件 | 数据来源 | 过滤条件 |
|------|---------|---------|
| SessionStrip.vue | `pluginStore.getSessionStatusBarItems(sessionId)` | `scope === 'per-session' && sessionId === props.sessionId` |
| AppStatusbar.vue | `pluginStore.globalStatusBarItems` | `scope === 'global'`，按 priority 排序 |
| InputToolbar.vue | chatStore / sessionStore / modelStore | 不消费 plugin:statusBarUpdate |

### 6.5 完整数据流图

```
┌─────────────────── pi 进程 ───────────────────┐
│  pi extension                                    │
│  ctx.ui.setStatus('goal', '◆ 3/20')            │
└──────────────┬──────────────────────────────────┘
               │ pi RPC (stdin/stdout)
               ▼
┌─────────────────── Sidecar ────────────────────┐
│                                                  │
│  event-adapter.ts                                │
│  setStatus → onStatusSetUpdate callback          │
│                                                  │
│  server.ts                                       │
│  handleStatusSetUpdate(payload)                  │
│                                                  │
│  plugin-service.ts                               │
│  handleBridgeEvent('plugin:statusSetUpdate')     │
│  executeHooks() → Worker RPC                     │
│                                                  │
│  ┌──── statusline plugin (Worker) ─────┐         │
│  │ hook handler                         │         │
│  │ → api.ui.updateStatusBarItem(...)   │         │
│  └────────────────┬────────────────────┘         │
│                   │ Worker RPC                    │
│                   ▼                               │
│  plugin-service.ts                                │
│  updateStatusBarItem() → Map + broadcast          │
│  broker.broadcast({ type: 'plugin:statusBarUpdate', │
│    payload: { items: StatusBarItem[] } })         │
└──────────────┬──────────────────────────────────┘
               │ WebSocket
               ▼
┌─────────────────── Frontend ───────────────────┐
│  usePlugin.ts                                    │
│  handler: pluginStore.statusBarItems = items     │
│                                                  │
│  pluginStore.ts                                  │
│  getSessionStatusBarItems(sid) → scope=per-sess  │
│  globalStatusBarItems → scope=global, sorted     │
│                                                  │
│  SessionStrip.vue ← getSessionStatusBarItems     │
│  AppStatusbar.vue ← globalStatusBarItems         │
└─────────────────────────────────────────────────┘
```

---

## 7. 消息类型汇总

### 7.1 新增

| 消息/RPC | 方向 | 类型 |
|---------|------|------|
| `plugin:statusSetUpdate` | event-adapter → server → plugin hooks | Sidecar 内部 ServerMessage |
| `plugin.ui.updateStatusBarItem` (options 扩展) | Worker → 主线程 RPC | Plugin RPC |
| `plugin:statusBarUpdate` (payload 扩展) | Server → Client WS | WebSocket 消息 |

### 7.2 修改

| 消息/RPC | 变更内容 |
|---------|---------|
| `plugin:statusBarUpdate` | StatusBarItem 新增 scope/sessionId 字段 |
| `plugin.ui.updateStatusBarItem` | 新增可选 options 参数 |
| `bridge:event` (server.ts) | 从只打日志改为调用 handleBridgeEvent |

### 7.3 不变

| 消息/RPC | 说明 |
|---------|------|
| `plugin:statusBarUpdate` 的消息类型名 | 不变 |
| `plugin.ui.updateStatusBarItem` 的方法名 | 不变 |
| 所有其他 WS 消息类型 | 不变 |
| 所有其他 Plugin RPC 方法 | 不变 |
