---
verdict: pass
---

# Statusline — Backend Design

> 本文档是 `plan.md` 的后端设计子文档，覆盖 Task 1-5 的详细设计。
> 前端设计见 `plan-frontend.md`，API 契约见 `plan-api-contract.md`。

---

## §1 Task 1: Extend shared protocol types

**文件:** `src-electron/shared/src/protocol.ts`  
**修改区域:** 行 ~225-237 (StatusBarItem), 行 ~80 (ServerMessageType union)

### 1.1 StatusBarItem 扩展

**当前签名:**
```typescript
export interface StatusBarItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
}
```

**目标签名:**
```typescript
export interface StatusBarItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
  scope: 'per-session' | 'global'        // 新增，默认 'global'
  sessionId?: string                       // 新增，per-session items 绑定的 session
}
```

**修改描述:**
- 在 `StatusBarItem` 接口末尾新增 `scope` 字段（类型 `'per-session' | 'global'`）和 `sessionId` 字段（类型 `string | undefined`）
- `scope` 默认 `'global'`（由调用方填充默认值，协议层不设默认值）
- `sessionId` 仅在 `scope === 'per-session'` 时有值，`global` items 不需要此字段

### 1.2 ServerMessageType 扩展

**当前签名（片段）:**
```typescript
export type ServerMessageType =
  | ...
  | 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
```

**目标签名:**
```typescript
export type ServerMessageType =
  | ...
  | 'plugin:statusBarUpdate' | 'plugin:messageDecoration' | 'plugin:config'
  | 'plugin:statusSetUpdate'    // 新增：event-adapter 翻译的 pi extension setStatus 事件
```

**修改描述:**
- 在 `ServerMessageType` union 中新增 `'plugin:statusSetUpdate'`
- 此类型用于 sidecar 内部消息分发（event-adapter → server → plugin hooks），**不广播到前端**

### 1.3 新增 StatusSetUpdatePayload

**新增接口:**
```typescript
export interface StatusSetUpdatePayload {
  sessionId: string    // 来源 session
  key: string          // pi extension setStatus 的 key（如 'goal', 'todo', 'workflow'）
  text: string         // 状态显示文本（如 '◆ Goal 3/20 | 2/5'）
}
```

**放置位置:** 在 `PluginStatusBarUpdatePayload` 之后，`MessageDecoration` 之前

### 1.4 边界条件

| 场景 | 处理方式 |
|------|---------|
| StatusBarItem 缺少 scope 字段（旧代码） | plugin-service 填充默认 `'global'` |
| per-session item 缺少 sessionId | plugin-service 按调用上下文填充 |
| statusSetUpdate 的 text 为空字符串 | 合法，表示清除该 key 的状态 |
| statusSetUpdate 的 text 为 undefined/null | event-adapter 转为空字符串 `''` |

### 1.5 测试要点

- [ ] StatusBarItem 编译通过，scope/sessionId 为可选语义
- [ ] ServerMessageType 包含 `'plugin:statusSetUpdate'`
- [ ] StatusSetUpdatePayload 类型正确导出
- [ ] 现有使用 StatusBarItem 的代码编译通过（向后兼容）

---

## §2 Task 2: Fix event-adapter to translate setStatus

**文件:** `src-electron/runtime/src/event-adapter.ts`  
**修改区域:** 行 ~197-198 (`extension_ui_request` case 中的 setStatus/setWidget 分支)

### 2.1 当前代码

```typescript
case 'extension_ui_request': {
  const method = event.method as string | undefined
  // setStatus/setWidget are internal-only, discard
  if (method === 'setStatus' || method === 'setWidget') return null
  // ...
}
```

**问题:** setStatus 被 `return null` 丢弃，pi extension 的状态数据无法到达 xyz-agent。

### 2.2 目标逻辑

将 `setStatus` 从统一丢弃改为返回 ServerMessage：

```typescript
if (method === 'setStatus') {
  return {
    type: 'plugin:statusSetUpdate',
    payload: {
      sessionId: sid,
      key: String(event.key ?? ''),
      text: String(event.text ?? ''),
    },
  }
}
if (method === 'setWidget') return null  // 保持不处理
```

**修改描述:**
- 将 `if (method === 'setStatus' || method === 'setWidget') return null` 拆为两个独立分支
- `setStatus` 分支：返回 `{ type: 'plugin:statusSetUpdate', payload: { sessionId, key, text } }`
  - `key` 取自 `event.key`（pi extension `ctx.ui.setStatus(key, text)` 的第一个参数）
  - `text` 取自 `event.text`（pi extension 的第二个参数）
  - 缺失时 fallback 为空字符串
- `setWidget` 保持 `return null`（本次不实现）
- **关键**: setStatus 翻译后由 `handleEvent` 调用 `this.send(msg)` 发出，走的是 WsSender 通道。但 `plugin:statusSetUpdate` 是 sidecar 内部消息，不应发送到前端。因此需要额外的路由机制（见 §3）

### 2.3 setStatus 事件的 pi RPC 数据结构

pi extension 调用 `ctx.ui.setStatus(key, text)` 时，pi RPC 发出的事件结构为：
```typescript
{
  type: 'extension_ui_request',
  method: 'setStatus',
  id: '<request-id>',
  key: string,     // 如 'goal'
  text: string,    // 如 '◆ Goal 3/20 | 2/5'
}
```

**注意**: `key` 和 `text` 是 setStatus 特有字段，不在通用 `extension_ui_request` schema 中。需通过 `event.key` / `event.text` 读取（而非 `event.data.key`）。

### 2.4 消息路由设计

`EventAdapter.send` 原本只连接到 `NavigateInterceptor.send`（WsSender），所有消息都发往前端。为支持 sidecar 内部消息路由，有两种方案：

**方案 A（推荐）: 新增 EventAdapterOptions 回调**

在 `EventAdapterOptions` 新增 `onStatusSetUpdate` 回调：
```typescript
export interface EventAdapterOptions {
  onExtensionUIRequest?: (...) => void
  onBridgeUIRequest?: (...) => void
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string }) => void  // 新增
}
```

setStatus 分支调用回调而非返回 ServerMessage：
```typescript
if (method === 'setStatus') {
  const payload = { sessionId: sid, key: String(event.key ?? ''), text: String(event.text ?? '') }
  this.options?.onStatusSetUpdate?.(payload)
  return null  // 不走 WsSender 通道
}
```

在 `index.ts` 的 adapter factory 中连接到 server：
```typescript
onStatusSetUpdate: (payload) => {
  server.handleStatusSetUpdate(payload)
}
```

**方案 B: 返回 ServerMessage，server.ts 拦截** — 需要在 NavigateInterceptor 或 server 中拦截 `plugin:statusSetUpdate` 类型，侵入性更大。

**选择方案 A**，理由：
1. 与现有 `onBridgeUIRequest` 模式一致（bridge 方法也是通过回调路由，不走 WsSender）
2. NavigateInterceptor 不需要改动
3. 职责清晰：event-adapter 只做翻译 + 回调通知

### 2.5 server.ts 新增 handleStatusSetUpdate

在 `server.ts` 新增方法：
```typescript
handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string }): void
```

**行为:**
1. 构造 `StatusSetUpdatePayload`
2. 调用 `pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, payload.sessionId)`
3. 此方法会触发 statusline plugin 注册的 `onPiEvent('plugin:statusSetUpdate')` hook

### 2.6 边界条件

| 场景 | 处理方式 |
|------|---------|
| event.key 为 undefined | fallback 为空字符串 `''` |
| event.text 为 undefined/null | fallback 为空字符串 `''`（pi extension `setStatus('goal')` 清除状态时 text 为 undefined） |
| sessionId 无效 | 正常传递，由 plugin hook 层决定是否处理 |
| pluginService 未初始化 | handleBridgeEvent 内部检查，静默忽略 |

### 2.7 测试要点

- [ ] setStatus 事件被翻译为 `plugin:statusSetUpdate` payload
- [ ] `onStatusSetUpdate` 回调被正确调用
- [ ] setWidget 仍被丢弃（return null）
- [ ] key/text 为 undefined 时 fallback 为空字符串
- [ ] 回调未注册时（options.onStatusSetUpdate 为 undefined）不崩溃

---

## §3 Task 3: Fix server.ts bridge:event + route statusSetUpdate

**文件:** `src-electron/runtime/src/server.ts`  
**修改区域:** 行 ~715-719 (`bridge:event` case)

### 3.1 当前代码（bridge:event）

```typescript
case 'bridge:event': {
  const eventName = data.eventName as string
  console.log(`[server] bridge event: ${eventName} from session ${sessionId}`)
  // Events are fire-and-forget — no meaningful response expected
  await client.sendCommand('extension_ui_response', { id: requestId, response: null })
  return
}
```

**问题:** 只打日志，不调用 `pluginService.handleBridgeEvent()`，导致 pi 生命周期事件无法触发 plugin hooks。

### 3.2 目标逻辑

```typescript
case 'bridge:event': {
  const eventName = data.eventName as string
  const eventData = data.data as Record<string, unknown> ?? {}
  if (this.pluginService?.handleBridgeEvent) {
    this.pluginService.handleBridgeEvent(eventName, eventData, sessionId)
  }
  await client.sendCommand('extension_ui_response', { id: requestId, response: null })
  return
}
```

**修改描述:**
- 在 `console.log` 之后、`sendCommand` 之前，调用 `this.pluginService.handleBridgeEvent(eventName, eventData, sessionId)`
- `eventData` 取自 `data.data`（pi bridge:event 的 payload 在 data 字段中）
- 保持 fire-and-forget 语义：不 await handleBridgeEvent（异步执行，不阻塞 pi RPC 响应）
- 先发送 RPC 响应（`extension_ui_response`）再触发 hooks，避免 pi 端超时
- pluginService 为可选依赖，需要 null check

### 3.3 新增 handleStatusSetUpdate 方法

在 `server.ts` 新增方法：

```typescript
handleStatusSetUpdate(payload: { sessionId: string; key: string; text: string }): void {
  if (this.pluginService?.handleBridgeEvent) {
    this.pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, payload.sessionId)
  }
}
```

**路由链路:**
```
pi extension setStatus → event-adapter (translate) → onStatusSetUpdate callback
→ server.handleStatusSetUpdate() → pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, sessionId)
→ executeHooks('plugin:statusSetUpdate', context) → statusline plugin hook handler
```

### 3.4 bridge:event 与 setStatus 的区别

| 特征 | bridge:event | setStatus |
|------|-------------|-----------|
| 来源 | pi bridge 扩展协议 | pi extension `ctx.ui.setStatus()` |
| 路径 | event-adapter → onBridgeUIRequest → server.handleBridgeRequest | event-adapter → onStatusSetUpdate → server.handleStatusSetUpdate |
| pi RPC 响应 | 需要（`extension_ui_response`） | 不需要（pi 不等 setStatus 响应） |
| 触发 plugin hooks | `handleBridgeEvent(eventName, data, sid)` | `handleBridgeEvent('plugin:statusSetUpdate', payload, sid)` |

### 3.5 边界条件

| 场景 | 处理方式 |
|------|---------|
| pluginService 未初始化 | `this.pluginService?.handleBridgeEvent` 可选链，静默跳过 |
| eventName 为空/undefined | 正常传递，hook handler 自行决定是否处理 |
| handleBridgeEvent 内部异常 | executeHooks 已有 catch 逻辑，console.error 输出 |
| sessionId 对应的 session 已销毁 | handleBridgeEvent 不检查 session 状态，hook handler 可忽略 |

### 3.6 测试要点

- [ ] `bridge:event` 调用 `pluginService.handleBridgeEvent()`
- [ ] 事件名和 data 正确传递
- [ ] RPC 响应仍正常返回 `null`
- [ ] pluginService 为 undefined 时不崩溃
- [ ] `handleStatusSetUpdate` 正确路由到 `handleBridgeEvent`
- [ ] pi 生命周期事件（agent_start/agent_end）能触发 plugin hooks

---

## §4 Task 4: Extend plugin-service + ui-api statusBarUpdate

**文件:**
- `src-electron/runtime/src/services/plugin-service/plugin-service.ts`（行 ~404-410, 新增 Map 字段）
- `src-electron/runtime/src/services/plugin-service/api/ui-api.ts`（RPC handler + Worker proxy）
- `src-electron/runtime/src/services/plugin-service/plugin-types.ts`（Phase2AgentAPI.ui 签名）

### 4.1 plugin-service.ts: 注册式 StatusBarItem 管理

**当前代码:**
```typescript
updateStatusBarItem: async (pluginId: string, id: string, text: string) => {
  this.broker.broadcast({
    type: 'plugin:statusBarUpdate',
    id: `sb_${pluginId}_${Date.now()}`,
    payload: { items: [{ id, pluginId, text, priority: 100 }] },
  })
}
```

**问题:** 每次调用只广播一个 item，多个 plugin 并发更新时互相覆盖。

**目标设计:**

新增 `StatusBarItemOptions` 类型（在 plugin-service.ts 或 ui-api.ts 中定义）：
```typescript
interface StatusBarItemOptions {
  tooltip?: string
  commandId?: string
  priority?: number          // 默认 100
  scope?: 'per-session' | 'global'  // 默认 'global'
  sessionId?: string
}
```

新增实例字段：
```typescript
private statusBarItems = new Map<string, StatusBarItem>()  // key = `${pluginId}:${id}`
```

修改 `updateStatusBarItem`:
```typescript
updateStatusBarItem: async (pluginId: string, id: string, text: string, options?: StatusBarItemOptions) => {
  const itemKey = `${pluginId}:${id}`
  const item: StatusBarItem = {
    id,
    pluginId,
    text,
    tooltip: options?.tooltip,
    commandId: options?.commandId,
    priority: options?.priority ?? 100,
    scope: options?.scope ?? 'global',
    sessionId: options?.sessionId,
  }
  this.statusBarItems.set(itemKey, item)
  this.broadcastStatusBarItems()
}
```

新增广播方法：
```typescript
private broadcastStatusBarItems(): void {
  const items = Array.from(this.statusBarItems.values())
  this.broker.broadcast({
    type: 'plugin:statusBarUpdate',
    id: `sb_${Date.now()}`,
    payload: { items },
  })
}
```

**新增 `getStatusBarItems()` 公开方法:**
```typescript
getStatusBarItems(): StatusBarItem[] {
  return Array.from(this.statusBarItems.values())
}
```

**删除/清除逻辑:**
- 当 `text` 为空字符串时，从 Map 中删除该 item（`this.statusBarItems.delete(itemKey)`）
- 这是 pi extension 清除状态的方式（`setStatus('goal', undefined)` → event-adapter 将 undefined 转为 `''` → statusline plugin 调用 `updateStatusBarItem('goal', '')` → plugin-service 检测空文本并删除）

### 4.2 ui-api.ts: RPC handler 扩展

**当前 handler:**
```typescript
rpcServer.registerMethod('plugin.ui.updateStatusBarItem', async (params) => {
  const pluginId = params.pluginId as string
  const id = params.id as string
  const text = params.text as string
  await deps.updateStatusBarItem(pluginId, id, text)
})
```

**目标 handler:**
```typescript
rpcServer.registerMethod('plugin.ui.updateStatusBarItem', async (params) => {
  const pluginId = params.pluginId as string
  const id = params.id as string
  const text = params.text as string
  const options: StatusBarItemOptions | undefined = params.options as StatusBarItemOptions | undefined
  await deps.updateStatusBarItem(pluginId, id, text, options)
})
```

**UiHandlers 接口扩展:**
```typescript
export interface UiHandlers {
  // ... existing methods ...
  updateStatusBarItem(pluginId: string, id: string, text: string, options?: StatusBarItemOptions): Promise<void>
}
```

**Worker 侧 proxy 扩展:**
```typescript
updateStatusBarItem: (id: string, text: string, options?: StatusBarItemOptions) =>
  rpcClient.request('plugin.ui.updateStatusBarItem', { pluginId, id, text, options }).then(() => {}),
```

### 4.3 plugin-types.ts: Phase2AgentAPI.ui 签名扩展

**当前签名:**
```typescript
readonly ui: {
  // ... existing methods ...
  updateStatusBarItem(id: string, text: string): Promise<void>
}
```

**目标签名:**
```typescript
readonly ui: {
  // ... existing methods ...
  updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
}
```

**新增类型导出:**
```typescript
export interface StatusBarItemOptions {
  tooltip?: string
  commandId?: string
  priority?: number
  scope?: 'per-session' | 'global'
  sessionId?: string
}
```

**放置位置:** `Phase2AgentAPI` 之前，`HookType` 之后

### 4.4 向后兼容性

| 场景 | 行为 |
|------|------|
| 旧 plugin 调用 `updateStatusBarItem(id, text)` | options undefined → 默认 priority=100, scope='global' |
| 新 plugin 调用 `updateStatusBarItem(id, text, {})` | 同上，空 options 使用默认值 |
| 新 plugin 传 options | 按指定值覆盖默认值 |
| 前端收到旧格式消息（无 scope/sessionId） | plugin store 填充默认 scope='global' |

### 4.5 边界条件

| 场景 | 处理方式 |
|------|---------|
| 同一 pluginId:id 对多次 update | Map 覆盖旧值，广播最新列表 |
| text 为空字符串 | 从 Map 中删除该 item，广播更新后的列表 |
| scope='per-session' 但未传 sessionId | scope 生效但 sessionId 为 undefined，前端按 scope 路由 |
| 并发 updateStatusBarItem | Node.js 单线程，Map 操作原子性无竞争 |

### 4.6 测试要点

- [ ] `updateStatusBarItem(id, text)` 无 options 时默认 priority=100, scope='global'
- [ ] `updateStatusBarItem(id, text, { scope: 'per-session', sessionId: 'xxx' })` 正确存储
- [ ] 多次 update 同一 id 覆盖旧值
- [ ] text 为空字符串时从 Map 中删除
- [ ] 广播的 items 数组包含所有已注册的 items
- [ ] RPC handler 正确解包 options 参数
- [ ] Worker proxy 正确传递 options

---

## §4a Task 5: Emit context.update from event-adapter

**问题:** 前端 `useChat.ts` 已注册 `context.update` 消息处理器（行 225），`chatStore` 有 `contextUsagePercent`、`contextInputTokens`、`contextLimit` 字段。但后端从未发出 `context.update` 消息，导致这些字段永远为默认值。

**修改文件:**
- `src-electron/runtime/src/event-adapter.ts`（modify，agent_end case）

**数据源分析:**
- `message.complete` payload 已包含 `usage.inputTokens`（event-adapter.ts 行 189-190）
- `ModelInfo.contextWindow` 从 `model-service.ts` 获取，是当前模型的上下文窗口大小
- 计算公式: `usagePercent = Math.round((inputTokens / contextWindow) * 100)`

**修改描述:**

EventAdapter 的 agent_end case（行 ~178-195），在返回 `message.complete` 之后，需要额外发送一个 `context.update` 消息。

但 EventAdapter 当前无法访问 ModelService（没有 model 信息）。两种方案:

**方案 A（推荐）: EventAdapterOptions 增加 onContextUpdate 回调**
- 类似 `onBridgeUIRequest` 回调模式
- EventAdapter 在 agent_end 时计算 inputTokens，调用 `this.options?.onContextUpdate?.(sessionId, { inputTokens, totalTokens })`
- 回调在 server.ts 或 index.ts 中实现，由该处查询 modelService 获取 contextWindow 并计算百分比，然后 broadcast `context.update`

**方案 B: event-adapter 直接接受 contextWindow 参数**
- 在创建 EventAdapter 时传入当前 model 的 contextWindow
- event-adapter 自行计算百分比并在 agent_end 时额外返回 context.update 消息
- 缺点：模型切换时需要更新 EventAdapter 的 contextWindow

**采用方案 A 的理由:** 与 onBridgeUIRequest 模式一致，EventAdapter 不直接依赖 ModelService。

**context.update payload 结构:**

```typescript
interface ContextUpdatePayload {
  usagePercent: number   // Math.round((inputTokens / contextWindow) * 100), 上限 100
  inputTokens: number    // usage.inputTokens from pi
  contextLimit: number   // model.contextWindow
}
```

**修改位置:**
1. `event-adapter.ts` — agent_end case 增加回调调用
2. `event-adapter.ts` — EventAdapterOptions 接口增加 `onContextUpdate` 可选回调
3. `server.ts` 或 `index.ts` — 注册回调，查询 modelService 获取 contextWindow，计算百分比，broadcast

**边界条件:**
- `usage` 为 undefined 或 inputTokens 为 0 → 不发送 context.update
- `contextWindow` 为 undefined 或 0 → usagePercent = 0
- `usagePercent > 100` → 上限为 100

**测试要点:**
- agent_end 事件带 usage 数据时 → context.update 消息正确发出
- agent_end 事件不带 usage → 不发出 context.update
- contextWindow = undefined → usagePercent = 0
- inputTokens > contextWindow → usagePercent = 100（上限）

---

## §5 Task 7: Create statusline built-in plugin

**文件:**
- `resources/plugins/statusline/package.json`（create）
- `resources/plugins/statusline/index.ts`（create）

### 5.1 package.json manifest

参考 `resources/plugins/todo/package.json` 的结构：

```json
{
  "name": "statusline",
  "version": "0.1.0",
  "displayName": "Statusline",
  "description": "Bridges pi extension setStatus events to xyz-agent status bar system",
  "xyzAgent": {
    "manifestVersion": 1,
    "main": "index.js",
    "activationEvents": [
      "onStartupFinished"
    ],
    "trustLevel": "trusted",
    "source": "built-in",
    "permissions": [
      "hooks.onPiEvent"
    ]
  }
}
```

**说明:**
- `activationEvents: ['onStartupFinished']` — sidecar 启动后自动激活
- `trustLevel: 'trusted'` — 内置插件，完全信任
- `source: 'built-in'` — 不可卸载不可禁用
- `permissions: ['hooks.onPiEvent']` — 只需要注册 pi event hook 的权限
- 不需要 `sessionData` 权限（statusline plugin 无持久化需求）
- 不需要 `tools.register` 权限（不注册自定义工具）

### 5.2 index.ts 实现

**整体结构:**

```typescript
import type { PluginContext, Disposable } from '../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'

interface StatusKeyMetadata {
  priority: number
  tooltip?: string
  scope: 'per-session' | 'global'
}

const KEY_METADATA_MAP: Record<string, StatusKeyMetadata> = {
  goal:     { priority: 10, tooltip: 'Goal task progress',  scope: 'per-session' },
  todo:     { priority: 20, tooltip: 'Todo list progress',  scope: 'per-session' },
  workflow: { priority: 15, tooltip: 'Workflow status',     scope: 'per-session' },
  preset:   { priority: 30, tooltip: 'Active preset',       scope: 'global' },
  ssh:      { priority: 40, tooltip: 'SSH connection',      scope: 'global' },
  model:    { priority: 50, tooltip: 'Current model',       scope: 'global' },
}

const DEFAULT_METADATA: StatusKeyMetadata = {
  priority: 100,
  tooltip: undefined,
  scope: 'global',
}

export async function activate(context: PluginContext): Promise<void> {
  const { api } = context

  const disposable = await api.hooks.onPiEvent('plugin:statusSetUpdate', async (_eventName, data) => {
    // data 由 handleBridgeEvent 包装: { eventName, data, sessionId }
    // 实际 payload 在 data.data 中
    const payload = data as { eventName: string; data: { sessionId: string; key: string; text: string }; sessionId: string }

    const { sessionId, key, text } = payload.data
    const meta = KEY_METADATA_MAP[key] ?? DEFAULT_METADATA

    await api.ui.updateStatusBarItem(
      `pi-${key}`,       // id: 前缀 'pi-' 区分 pi extension 来源
      text,
      {
        tooltip: meta.tooltip,
        priority: meta.priority,
        scope: meta.scope,
        sessionId,
      },
    )
  })

  context.subscriptions.push(disposable)
}
```

### 5.3 hook 事件数据流

```
pi extension: ctx.ui.setStatus('goal', '◆ 3/20')
  → pi RPC: extension_ui_request { method: 'setStatus', key: 'goal', text: '◆ 3/20' }
  → event-adapter: onStatusSetUpdate({ sessionId, key: 'goal', text: '◆ 3/20' })
  → server.handleStatusSetUpdate(payload)
  → pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, sessionId)
  → executeHooks('plugin:statusSetUpdate', { data: { eventName, data: payload, sessionId } })
  → statusline plugin hook handler:
      payload.data = { sessionId, key: 'goal', text: '◆ 3/20' }
      → updateStatusBarItem('pi-goal', '◆ 3/20', { priority: 10, scope: 'per-session', sessionId })
  → plugin-service: Map.set + broadcastStatusBarItems()
  → WS: plugin:statusBarUpdate { items: [...] }
```

### 5.4 handleBridgeEvent 的 data 包装结构

`handleBridgeEvent` 构造的 HookContext.data 结构为：
```typescript
{
  eventName: string,          // 'plugin:statusSetUpdate'
  data: StatusSetUpdatePayload,  // { sessionId, key, text }
  sessionId: string
}
```

statusline plugin 的 hook handler 接收到的 `data` 参数就是这个结构。

### 5.5 key→metadata 映射表

| key (pi extension) | priority | tooltip | scope | 说明 |
|---|---|---|---|---|
| `goal` | 10 | 'Goal task progress' | per-session | goal extension 任务进度 |
| `todo` | 20 | 'Todo list progress' | per-session | todo extension 任务计数 |
| `workflow` | 15 | 'Workflow status' | per-session | workflow 阶段状态 |
| `preset` | 30 | 'Active preset' | global | 当前活跃 preset |
| `ssh` | 40 | 'SSH connection' | global | SSH 连接状态 |
| `model` | 50 | 'Current model' | global | 当前模型信息 |
| *(未知 key)* | 100 | undefined | global | 默认处理 |

**设计决策:**
- priority 数值越小越靠前显示
- 未知 key 使用默认 metadata，不报错，不跳过
- mapping 表是静态的（hardcoded），不支持运行时扩展
- id 前缀 `pi-` 区分 pi extension 来源和 xyz-agent plugin 来源

### 5.6 dispose 清理逻辑

Plugin deactivate 时：
1. `context.subscriptions` 中的 disposable 被 dispose，取消 hook 注册
2. plugin-service 的 Map 中该 plugin 注册的 items 需要清理
3. **当前 plugin-service 没有 plugin 级别的批量清理机制**，需要新增：
   - 在 plugin-service 的 `deactivatePlugin` 流程中，遍历 Map 删除所有 `pluginId === 'statusline'` 的 items
   - 调用 `broadcastStatusBarItems()` 通知前端

或者更简单的方案：statusline plugin 的 items 在 deactivate 时通过遍历已知 key 调用 `updateStatusBarItem('pi-goal', '')` 逐个清除。

**推荐: 在 plugin-service 中新增 `clearStatusBarItems(pluginId)` 方法**，由 deactivation 流程自动调用。

### 5.7 边界条件

| 场景 | 处理方式 |
|------|---------|
| 同一 key 多次 setStatus | Map 覆盖，广播最新值 |
| text 为空字符串（清除状态） | plugin-service 从 Map 删除该 item |
| 未知 key（不在映射表中） | 使用 DEFAULT_METADATA，正常转发 |
| sessionId 为空 | scope 仍生效，前端按 scope 路由 |
| plugin 未激活时收到事件 | hook 未注册，事件被忽略 |

### 5.8 测试要点

- [ ] activate 注册 `onPiEvent('plugin:statusSetUpdate')` hook
- [ ] 收到 setStatus 事件后调用 `updateStatusBarItem` 且参数正确
- [ ] key='goal' 映射到 priority=10, scope='per-session'
- [ ] 未知 key 映射到 DEFAULT_METADATA
- [ ] dispose 取消 hook 注册
- [ ] 编译后的 index.js 存在于正确路径

### 5.9 构建步骤

statusline plugin 的 `index.ts` 需要编译为 `index.js`（package.json 中 `main: 'index.js'`）。

**编译方式:** 参考 todo plugin 的构建流程。如果是 tsc 编译，需要在构建脚本中加入 statusline plugin 的路径。

---

## 附录 A: 文件修改汇总

| 文件 | 操作 | 关键修改 |
|------|------|---------|
| `src-electron/shared/src/protocol.ts` | modify | StatusBarItem 增加 scope/sessionId；ServerMessageType 增加 `plugin:statusSetUpdate`；新增 StatusSetUpdatePayload |
| `src-electron/runtime/src/event-adapter.ts` | modify | EventAdapterOptions 增加 onStatusSetUpdate；setStatus 分支调用回调 |
| `src-electron/runtime/src/server.ts` | modify | bridge:event 调用 handleBridgeEvent；新增 handleStatusSetUpdate |
| `src-electron/runtime/src/services/plugin-service/plugin-service.ts` | modify | updateStatusBarItem 扩展参数；新增 Map 管理；新增 broadcastStatusBarItems |
| `src-electron/runtime/src/services/plugin-service/api/ui-api.ts` | modify | RPC handler 和 proxy 扩展 options 参数 |
| `src-electron/runtime/src/services/plugin-service/plugin-types.ts` | modify | Phase2AgentAPI.ui 签名扩展；新增 StatusBarItemOptions 类型 |
| `src-electron/runtime/src/index.ts` | modify | adapter factory 连接 onStatusSetUpdate 回调 |
| `resources/plugins/statusline/package.json` | create | plugin manifest |
| `resources/plugins/statusline/index.ts` | create | plugin 实现 |

## 附录 B: 数据流完整链路

```
pi extension (goal/todo/workflow)
  │ ctx.ui.setStatus(key, text)
  ▼
pi RPC subprocess
  │ extension_ui_request { method: 'setStatus', key, text }
  ▼
event-adapter.ts
  │ method === 'setStatus' → options.onStatusSetUpdate({ sessionId, key, text })
  ▼
server.ts
  │ handleStatusSetUpdate(payload)
  │ → pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, sessionId)
  ▼
plugin-service.ts
  │ executeHooks('plugin:statusSetUpdate', context)
  ▼
statusline plugin (Worker Thread)
  │ hook handler: lookup KEY_METADATA_MAP[key]
  │ → api.ui.updateStatusBarItem('pi-'+key, text, { priority, scope, sessionId })
  ▼
plugin-service.ts
  │ Map.set(pluginId:id, item) → broadcastStatusBarItems()
  ▼
WebSocket
  │ plugin:statusBarUpdate { items: StatusBarItem[] }
  ▼
Frontend
  │ plugin store → scope routing → SessionStrip / GlobalStatusbar
```
