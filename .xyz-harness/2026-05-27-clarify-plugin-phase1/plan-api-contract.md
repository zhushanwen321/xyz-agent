---
verdict: pass
---

# Plugin System Phase 1 — API Contract

> spec.md / plan.md / plan-backend.md 中所有跨模块边界的接口协议定义。实施时按此文档的签名和消息格式编码，不做额外推测。

---

## 目录

1. [RPC 方法注册表](#1-rpc-方法注册表)
2. [主线程 ↔ Worker Thread 通信协议](#2-主线程--worker-thread-通信协议)
3. [Worker Bootstrap 生命周期消息序列](#3-worker-bootstrap-生命周期消息序列)
4. [前端 ↔ Sidecar WebSocket 消息定义](#4-前端--sidecar-websocket-消息定义)
5. [错误码表](#5-错误码表)

---

## 1. RPC 方法注册表

所有 RPC 调用遵循 JSON-RPC 2.0 规范，通过 Worker 的 `parentPort.postMessage()` 传输。方法分两类：

- **主线程侧方法**：Worker 内插件通过 `PluginRpcClient.request()` / `PluginRpcClient.notify()` 调用，主线程 `PluginRpcServer` 分发到对应 handler。
- **Worker 侧通知方法**：主线程通过 `PluginRpcServer.notify()` / `PluginRpcServer.broadcast()` 推送到 Worker，Worker 内 `PluginRpcClient` 分发到已注册的 handler。

### 1.1 主线程侧方法

#### plugin.storage.global.get

| 字段 | 值 |
|------|---|
| Method | `plugin.storage.global.get` |
| 方向 | Worker → 主线程（request-response） |
| 描述 | 读取插件的 globalState 值 |

**Params：**

```typescript
{
  pluginId: string   // 由 RPC 代理自动注入，插件不传
  key: string
}
```

**Result（成功）：**

```typescript
unknown | null   // key 不存在时返回 null（非 undefined，JSON 序列化安全）
```

**可能错误码：** `-32010`（PLUGIN_NOT_FOUND）

---

#### plugin.storage.global.set

| 字段 | 值 |
|------|---|
| Method | `plugin.storage.global.set` |
| 方向 | Worker → 主线程（request-response） |
| 描述 | 写入插件的 globalState 值 |

**Params：**

```typescript
{
  pluginId: string
  key: string
  value: unknown   // 必须 JSON-serializable
}
```

**Result（成功）：**

```typescript
null
```

**可能错误码：** `-32021`（PAYLOAD_TOO_LARGE）、`-32040`（STORAGE_FULL）、`-32010`（PLUGIN_NOT_FOUND）

---

#### plugin.storage.global.delete

| 字段 | 值 |
|------|---|
| Method | `plugin.storage.global.delete` |
| 方向 | Worker → 主线程（request-response） |
| 描述 | 删除插件的 globalState 键 |

**Params：**

```typescript
{
  pluginId: string
  key: string
}
```

**Result（成功）：**

```typescript
null
```

**可能错误码：** `-32010`（PLUGIN_NOT_FOUND）

---

#### plugin.storage.global.keys

| 字段 | 值 |
|------|---|
| Method | `plugin.storage.global.keys` |
| 方向 | Worker → 主线程（request-response） |
| 描述 | 列出插件 globalState 的所有键 |

**Params：**

```typescript
{
  pluginId: string
}
```

**Result（成功）：**

```typescript
string[]
```

**可能错误码：** `-32010`（PLUGIN_NOT_FOUND）

---

#### plugin.storage.workspace.get

同 `plugin.storage.global.get`，scope 切换为 workspaceState。方法名：`plugin.storage.workspace.get`。

#### plugin.storage.workspace.set

同 `plugin.storage.global.set`，scope 切换为 workspaceState。方法名：`plugin.storage.workspace.set`。

#### plugin.storage.workspace.delete

同 `plugin.storage.global.delete`，scope 切换为 workspaceState。方法名：`plugin.storage.workspace.delete`。

#### plugin.storage.workspace.keys

同 `plugin.storage.global.keys`，scope 切换为 workspaceState。方法名：`plugin.storage.workspace.keys`。

> **实现说明**：plan-backend.md 中 RPC 注册时使用 `plugin.storage.get/set/delete/keys`（含 scope 参数）。此处按实际代理实现展开为 `plugin.storage.global.*` 和 `plugin.storage.workspace.*` 两组方法。两者等价——注册时可以是 4 个带 scope 参数的 handler，也可以是 8 个独立方法。由 BG2 Task 4 实现时决定，此处按代理实现展开。

---

#### plugin.notify

| 字段 | 值 |
|------|---|
| Method | `plugin.notify` |
| 方向 | Worker → 主线程（notification，无 response） |
| 描述 | 插件向前端发送用户通知 |

**Params：**

```typescript
{
  pluginId: string
  level: 'info' | 'warning' | 'error'
  message: string
}
```

**Result：** 无（notification）

**主线程处理流程：**
1. PluginRpcServer 收到 notification → 分发到 handler
2. Handler 通过 `IMessageBroker.sendEvent()` 向前端广播 `plugin:notification` 消息
3. 不返回响应

---

#### plugin.sessions.list

| 字段 | 值 |
|------|---|
| Method | `plugin.sessions.list` |
| 方向 | Worker → 主线程（request-response） |
| 描述 | 列出当前所有 session 信息 |

**Params：**

```typescript
{
  pluginId: string
}
```

**Result（成功）：**

```typescript
SessionInfo[]
```

其中 `SessionInfo`：

```typescript
interface SessionInfo {
  id: string
  label: string
  cwd: string
  status: 'active' | 'idle' | 'error'
  createdAt: number      // epoch ms
  lastActiveAt: number   // epoch ms
}
```

**可能错误码：** `-32603`（INTERNAL_ERROR，如果 sessionService 未就绪）

---

### 1.2 Worker 侧通知方法

主线程向 Worker 推送的通知。Worker 内 `PluginRpcClient.onNotification()` 注册 handler。

#### plugin.events.onSessionCreate

| 字段 | 值 |
|------|---|
| Method | `plugin.events.onSessionCreate` |
| 方向 | 主线程 → Worker（notification） |
| 触发 | 新 session 创建时 |

**Params：**

```typescript
{
  sessionId: string
  cwd: string
}
```

---

#### plugin.events.onShutdown

| 字段 | 值 |
|------|---|
| Method | `plugin.events.onShutdown` |
| 方向 | 主线程 → Worker（notification） |
| 触发 | Sidecar 关闭前广播给所有 Worker |

**Params：**

```typescript
Record<string, never>   // 空 payload
```

> Phase 1 中此通知为预留。插件可通过 `context.subscriptions` 注册清理逻辑，`onShutdown` 不需要插件显式处理。

---

## 2. 主线程 ↔ Worker Thread 通信协议

### 2.1 消息格式

Worker Thread 通过 `parentPort.postMessage()` 与主线程通信。消息分两类：

**生命周期消息**（非 JSON-RPC，由 PluginHost / PluginBootstrap 直接处理）：

```typescript
// 主线程 → Worker
type HostToWorkerLifecycle =
  | { type: 'load'; pluginId: string; pluginPath: string }
  | { type: 'activate'; pluginId: string; pluginDir: string; event: ActivationEvent }
  | { type: 'deactivate'; pluginId: string }

// Worker → 主线程
type WorkerToHostLifecycle =
  | { type: 'loaded'; pluginId: string }
  | { type: 'activated'; pluginId: string }
  | { type: 'deactivated'; pluginId: string }
  | { type: 'error'; pluginId: string; error: string }
  | { type: 'fatal_error'; error: string; stack?: string }
```

**RPC 消息**（JSON-RPC 2.0，由 PluginRpcServer / PluginRpcClient 处理）：

```typescript
// Worker → 主线程（RPC 请求 / 通知）
// 消息体就是标准 JSON-RPC 2.0 消息，外层包裹 { type: 'rpc' }
type HostToWorkerRpc = {
  type: 'rpc'
} & (RpcRequest | RpcNotification)

// 主线程 → Worker（RPC 响应 / 通知）
type WorkerToHostRpc = {
  type: 'rpc'
  response?: RpcResponse
  notification?: RpcNotification
}
```

**完整消息联合类型：**

```typescript
// 主线程 → Worker（parentPort.postMessage 的消息类型）
type HostToWorkerMessage =
  | HostToWorkerLifecycle
  | WorkerToHostRpc

// Worker → 主线程（parentPort.postMessage 的消息类型）
type WorkerToHostMessage =
  | WorkerToHostLifecycle
  | HostToWorkerRpc
```

### 2.2 消息路由规则

Worker Bootstrap 的 `parentPort.on('message')` 处理逻辑：

```
收到消息 msg
  │
  ├─ msg.type === 'load'      → handleLoad(msg)
  ├─ msg.type === 'activate'  → handleActivate(msg)
  ├─ msg.type === 'deactivate'→ handleDeactivate(msg)
  ├─ msg.type === 'rpc'
  │     ├─ msg.id 存在（response）→ rpcClient.handleResponse(msg)
  │     └─ msg.id 不存在（notification）→ rpcClient.handleNotification(msg)
  └─ 其他 → console.warn + 忽略
```

主线程 `worker.on('message')` 处理逻辑：

```
收到消息 msg
  │
  ├─ msg.type === 'loaded'      → resolve pendingLoadPromise
  ├─ msg.type === 'activated'   → resolve pendingActivatePromise
  ├─ msg.type === 'deactivated' → resolve pendingDeactivatePromise
  ├─ msg.type === 'error'       → reject pendingPromise
  ├─ msg.type === 'fatal_error' → handleWorkerError()
  ├─ msg.type === 'rpc'         → rpcServer.dispatch(workerId, msg)
  └─ 其他 → 忽略
```

### 2.3 序列化规则

| 项目 | 规则 |
|------|------|
| 传输层 | `parentPort.postMessage()`，Node.js 自动使用 `structuredClone` |
| 支持的类型 | JSON-serializable + ArrayBuffer + SharedArrayBuffer + Error 对象 |
| 不支持的类型 | 函数、DOM 对象、类实例（除 Error）、循环引用 |
| 限制 | 单条消息大小无硬性限制，但单个 storage value 不超过 1MB |
| 编码 | UTF-8，JSON 字符串内部使用 `\uXXXX` 转义非 ASCII 字符 |

### 2.4 超时策略

| 操作类型 | 默认超时 | 可配置 | 超时行为 |
|---------|---------|-------|---------|
| RPC request | 30,000ms | 是（`timeoutMs` 参数） | Worker 侧 reject + 返回 `RPC_TIMEOUT (-32000)` 错误 |
| load 操作 | 10,000ms | 否（硬编码） | 主线程侧 reject pendingLoadPromise |
| activate 操作 | 15,000ms | 否（硬编码） | 主线程侧 reject pendingActivatePromise |
| deactivate 操作 | 10,000ms | 否（硬编码） | 超时后继续清理（best-effort），不阻塞 shutdown |
| Storage flush | 5,000ms | 否（硬编码） | 失败时 console.error + 继续下一个 |
| Worker terminate | 5,000ms | 否（硬编码） | 强制 `worker.terminate()` |

**超时实现：**
- RPC request：`PluginRpcClient` 内部 `setTimeout` + `pending` Map
- Lifecycle 操作：`PluginHost` 内部 `pendingPromises` Map + `setTimeout`
- 超时后清理 pending entry，resolve/reject 对应的 Promise

### 2.5 并发模型

| 场景 | 行为 |
|------|------|
| 同一插件并发 RPC 请求 | 允许，每个请求独立 ID 和 Promise |
| 不同插件共享 Worker 的并发请求 | 允许，按 request ID 路由响应 |
| 同一插件重复 activate | 幂等——`PluginActivator` 检测到 ACTIVE 状态直接 return |
| 同一插件 activate 进行中收到新 activate | 幂等——检测到 ACTIVATING 状态直接 return |
| Worker crash 时有 pending RPC 请求 | 全部 reject + `RPC_TIMEOUT`（dispose 时清理） |

---

## 3. Worker Bootstrap 生命周期消息序列

### 3.1 Worker 创建 → 插件加载 → 激活（完整序列）

```
主线程                                     Worker Thread
  │                                           │
  │  new Worker(bootstrapPath, { workerData }) │
  │ ──────────────────────────────────────────>│
  │                                           │ bootstrap 初始化：
  │                                           │   parentPort.on('message', ...)
  │                                           │   创建 PluginRpcClient
  │                                           │   注册 uncaughtException handler
  │                                           │
  │  { type: 'load',                          │
  │    pluginId: 'hello-world',               │
  │    pluginPath: '/path/to/index.js' }      │
  │ ──────────────────────────────────────────>│
  │                                           │ import(pluginPath)
  │                                           │ 缓存 module 对象
  │                              { type: 'loaded', pluginId: 'hello-world' }
  │<────────────────────────────────────────── │
  │                                           │
  │  { type: 'activate',                      │
  │    pluginId: 'hello-world',               │
  │    pluginDir: '/path/to/',                │
  │    event: { type: 'onStartupFinished' } } │
  │ ──────────────────────────────────────────>│
  │                                           │ 创建 PluginContext:
  │                                           │   - agentAPI (frozen proxy)
  │                                           │   - globalState (RPC proxy)
  │                                           │   - workspaceState (RPC proxy)
  │                                           │   - subscriptions: []
  │                                           │
  │                                           │ Object.freeze(context)
  │                                           │ await module.activate(context)
  │                                           │
  │                           { type: 'activated', pluginId: 'hello-world' }
  │<────────────────────────────────────────── │
  │                                           │
  │  ← 插件进入 ACTIVE 状态，可处理 RPC →      │
```

### 3.2 插件 RPC 调用序列

```
Worker Thread                              主线程
  │                                           │
  │  插件代码调用:                             │
  │  context.api.storage.global.set('k', 'v') │
  │                                           │
  │  PluginRpcClient.request(                 │
  │    'plugin.storage.global.set',            │
  │    { pluginId, key: 'k', value: 'v' }     │
  │  )                                        │
  │                                           │
  │  { type: 'rpc', jsonrpc: '2.0',           │
  │    id: 1, method: 'plugin.storage.global.set',
  │    params: { pluginId, key: 'k', value: 'v' } }
  │ ──────────────────────────────────────────>│
  │                                           │ PluginRpcServer.dispatch()
  │                                           │   → handler(params)
  │                                           │   → PluginStorage.set()
  │                                           │   → 标记 dirty + scheduleFlush
  │                                           │
  │  { type: 'rpc', jsonrpc: '2.0',           │
  │    id: 1, result: null }                  │
  │<────────────────────────────────────────── │
  │                                           │
  │  PluginRpcClient.handleResponse()         │
  │  → resolve promise                        │
  │  → 插件代码 await 完成                     │
```

### 3.3 插件停用序列

```
主线程                                     Worker Thread
  │                                           │
  │  { type: 'deactivate',                    │
  │    pluginId: 'hello-world' }              │
  │ ──────────────────────────────────────────>│
  │                                           │ try {
  │                                           │   await module.deactivate?.()
  │                                           │ } catch { /* log */ }
  │                                           │
  │                                           │ for sub of context.subscriptions:
  │                                           │   sub.dispose()
  │                                           │
  │                                           │ loadedPlugins.delete(pluginId)
  │                                           │
  │                          { type: 'deactivated', pluginId: 'hello-world' }
  │<────────────────────────────────────────── │
  │                                           │
  │  主线程:                                   │
  │  - sandbox Worker → terminateWorker()     │
  │  - trusted Worker → 保留（其他插件可能在用）│
```

### 3.4 Worker 崩溃序列

```
Worker Thread                              主线程
  │                                           │
  │  uncaughtException / fatal error          │
  │                                           │
  │  { type: 'fatal_error',                   │
  │    error: '...', stack: '...' }           │
  │ ──────────────────────────────────────────>│
  │                                           │ PluginHost.handleWorkerError()
  │                                           │   handle.status = 'crashed'
  │                                           │
  │                                           │ 通过 broker 广播:
  │                                           │   { type: 'plugin:crashed',
  │                                           │     payload: { pluginIds: [...],
  │                                           │                reason: '...' } }
  │                                           │
  │  ← Worker 进程退出 →                      │
  │                                           │
  │                                           │ 如果 trusted Worker:
  │                                           │   terminate 旧 Worker
  │                                           │   创建新 Worker
  │                                           │   重新 loadPlugin × N
  │                                           │
  │                                           │ 如果 sandbox Worker:
  │                                           │   等待下次激活时重建
```

### 3.5 Sidecar 关闭序列

```
主线程                                     Worker Thread(s)
  │                                           │
  │  pluginService.shutdown()                  │
  │                                           │
  │  ├─ activator.deactivateAll()             │
  │  │   for each active plugin:              │
  │  │                                       │
  │  │  { type: 'deactivate', pluginId }      │
  │  │ ─────────────────────────────────────> │
  │  │                                       │ module.deactivate()
  │  │                                       │ dispose subscriptions
  │  │                      { type: 'deactivated' }
  │  │ <───────────────────────────────────── │
  │  │                                       │
  │  ├─ host.shutdown()                       │
  │  │   for each worker:                    │
  │  │     worker.terminate()                │
  │  │                                       │ ← Worker 进程终止
  │  │                                       │
  │  ├─ storage.flushAll()                    │
  │  │   逐个 flush 脏数据到磁盘              │
  │  │                                       │
  │  └─ rpcServer.dispose()                   │
  │      reject 所有 pending 请求             │
```

---

## 4. 前端 ↔ Sidecar WebSocket 消息定义

### 4.1 Client → Sidecar 新增消息

#### plugin.list

| 字段 | 值 |
|------|---|
| type | `plugin.list` |
| 方向 | 前端 → Sidecar |
| 描述 | 请求插件列表 |

```typescript
{
  type: 'plugin.list'
  id?: string
  payload: Record<string, never>
}
```

**Sidecar 响应：** `config.plugins`

---

#### plugin.toggle

| 字段 | 值 |
|------|---|
| type | `plugin.toggle` |
| 方向 | 前端 → Sidecar |
| 描述 | 启用/禁用指定插件 |

```typescript
{
  type: 'plugin.toggle'
  id?: string
  payload: {
    pluginId: string
    enabled: boolean
  }
}
```

**Sidecar 响应：** `config.plugins`

**Sidecar 处理：**
- `enabled: true` → `pluginService.togglePlugin(pluginId, true)` → 触发激活流程
- `enabled: false` → `pluginService.togglePlugin(pluginId, false)` → 触发停用流程
- 成功/失败均返回最新插件列表

---

### 4.2 Sidecar → 前端新增消息

#### config.plugins

| 字段 | 值 |
|------|---|
| type | `config.plugins` |
| 方向 | Sidecar → 前端 |
| 触发 | 初始化完成后广播 / `plugin.list` 响应 / `plugin.toggle` 响应 |
| 描述 | 推送插件列表 |

```typescript
{
  type: 'config.plugins'
  id?: string
  payload: {
    plugins: PluginInfo[]
  }
}
```

其中 `PluginInfo`：

```typescript
interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  enabled: boolean
}
```

**推送时机：**
1. `sendInitialState()` — 新 WebSocket 连接建立时
2. `pluginService.initialize()` 完成 — 扫描结束后
3. `plugin.toggle` 处理完成 — toggle 操作后

---

#### plugin:crashed

| 字段 | 值 |
|------|---|
| type | `plugin:crashed` |
| 方向 | Sidecar → 前端 |
| 触发 | Worker Thread 崩溃时 |
| 描述 | 通知前端一个或多个插件因 Worker 崩溃而失效 |

```typescript
{
  type: 'plugin:crashed'
  id?: string
  payload: {
    pluginIds: string[]
    reason: string
    workerId: string
  }
}
```

**触发流程：**
1. Worker `uncaughtException` / `worker.on('error')`
2. `PluginHost.handleWorkerError()` → 标记 crashed
3. `PluginService` 通过 `IMessageBroker.sendEvent()` 广播到前端

**前端处理建议：**
- 显示 toast / 通知：`插件 X 因崩溃已停止运行`
- 更新插件列表中的状态显示
- 不需要自动重试（后端 trusted Worker 会自动重建）

---

#### plugin:notification

| 字段 | 值 |
|------|---|
| type | `plugin:notification` |
| 方向 | Sidecar → 前端 |
| 触发 | 插件通过 `context.api.notify.*()` 发送通知时 |
| 描述 | 插件向用户展示的信息通知 |

```typescript
{
  type: 'plugin:notification'
  id?: string
  payload: {
    pluginId: string
    level: 'info' | 'warning' | 'error'
    message: string
  }
}
```

**触发流程：**
1. 插件代码：`context.api.notify.info('任务完成')`
2. Worker `PluginRpcClient.notify('plugin.notify', { pluginId, level, message })`
3. 主线程 `PluginRpcServer` 收到 notification → handler → `IMessageBroker.sendEvent()`
4. 前端收到 `plugin:notification` 消息

---

### 4.3 protocol.ts 变更汇总

以下为需要新增到 `src-electron/shared/src/protocol.ts` 的类型定义：

#### ClientMessageType 新增

```typescript
// 追加到 ClientMessageType union:
| 'plugin.list'
| 'plugin.toggle'
```

#### ClientMessageMap 新增

```typescript
// 追加到 ClientMessageMap interface:
'plugin.list': Record<string, never>
'plugin.toggle': { pluginId: string; enabled: boolean }
```

#### ClientMessage discriminated union 新增

```typescript
// 追加到 ClientMessage union:
| { type: 'plugin.list'; id?: string; payload: ClientMessageMap['plugin.list'] }
| { type: 'plugin.toggle'; id?: string; payload: ClientMessageMap['plugin.toggle'] }
```

#### ServerMessageType 新增

```typescript
// 追加到 ServerMessageType union:
| 'config.plugins'
| 'plugin:crashed'
| 'plugin:notification'
```

#### 新增 Payload Interface

```typescript
// ── Plugin payload interfaces ────────────────────────────────────

export interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  enabled: boolean
}

export interface PluginCrashedPayload {
  pluginIds: string[]
  reason: string
  workerId: string
}

export interface PluginNotificationPayload {
  pluginId: string
  level: 'info' | 'warning' | 'error'
  message: string
}
```

---

## 5. 错误码表

### 5.1 完整错误码定义

```typescript
export const PluginRpcErrorCodes = {
  // ── JSON-RPC 2.0 标准错误码 ────────────────────────
  PARSE_ERROR:      -32700,  // 服务端收到无效 JSON
  INVALID_REQUEST:  -32600,  // 发送的 JSON 不是有效请求对象
  METHOD_NOT_FOUND: -32601,  // 方法不存在或未注册
  INVALID_PARAMS:   -32602,  // 方法参数无效
  INTERNAL_ERROR:   -32603,  // JSON-RPC 内部错误

  // ── Plugin 自定义错误码 (-32000 ~ -32099) ──────────
  RPC_TIMEOUT:        -32000,  // RPC 请求超时
  PERMISSION_DENIED:  -32001,  // 权限不足（Phase 2 预留）
  PLUGIN_NOT_FOUND:   -32010,  // 插件未发现（pluginId 不在 registry 中）
  PLUGIN_NOT_ACTIVE:  -32011,  // 插件未激活（对未激活插件发起操作）
  MANIFEST_INVALID:   -32012,  // Manifest 解析失败
  ENGINE_INCOMPATIBLE:-32013,  // engines.xyz-agent 版本不兼容
  PAYLOAD_TOO_LARGE:  -32021,  // 单个 storage value 超过 1MB
  STORAGE_FULL:       -32040,  // 插件总存储超过 10MB
  WORKER_CRASHED:     -32050,  // Worker 已崩溃（操作无法完成）
  WORKER_TERMINATED:  -32051,  // Worker 已终止
  SHUTTING_DOWN:      -32060,  // Sidecar 正在关闭
} as const

export type PluginRpcErrorCode = typeof PluginRpcErrorCodes[keyof typeof PluginRpcErrorCodes]
```

### 5.2 错误码详细说明

| 错误码 | 常量 | 触发场景 | 传播方向 | 恢复策略 |
|--------|------|---------|---------|---------|
| -32700 | `PARSE_ERROR` | parentPort 收到无法解析的消息 | 主线程 → Worker | 修复序列化代码 |
| -32600 | `INVALID_REQUEST` | 消息缺少 `jsonrpc: "2.0"` 或 `method` 字段 | 主线程 → Worker | 修复 RPC 客户端代码 |
| -32601 | `METHOD_NOT_FOUND` | RPC 方法名未在 `PluginRpcServer` 注册 | 主线程 → Worker | 检查方法名拼写或确认注册 |
| -32602 | `INVALID_PARAMS` | params 类型不是 `Record<string, unknown>` | 主线程 → Worker | 修复调用参数 |
| -32603 | `INTERNAL_ERROR` | RPC handler 内部抛出未预期异常 | 主线程 → Worker | 检查 handler 逻辑 |
| -32000 | `RPC_TIMEOUT` | Worker 侧 request 超过 30s 未收到响应 | Worker 内部 | 检查主线程 handler 是否阻塞；可重试 |
| -32001 | `PERMISSION_DENIED` | Phase 2 预留，当前不触发 | — | — |
| -32010 | `PLUGIN_NOT_FOUND` | RPC handler 中 `pluginId` 不在 registry 中 | 主线程 → Worker | 检查 pluginId 是否正确 |
| -32011 | `PLUGIN_NOT_ACTIVE` | 对未激活的插件发起需要 ACTIVE 状态的操作 | 主线程 → Worker | 先激活插件 |
| -32012 | `MANIFEST_INVALID` | `validateManifest()` 校验失败（缺少 main、manifestVersion ≠ 1 等） | 主线程日志 | 修复 manifest 文件 |
| -32013 | `ENGINE_INCOMPATIBLE` | `engines.xyz-agent` semver range 不满足当前版本 | 主线程日志 | 升级插件或 Sidecar |
| -32021 | `PAYLOAD_TOO_LARGE` | `storage.set()` 的 value 序列化后超过 1MB | 主线程 → Worker | 减小数据量或分包存储 |
| -32040 | `STORAGE_FULL` | 插件所有 key 的 value 总序列化大小超过 10MB | 主线程 → Worker | 删除旧数据释放空间 |
| -32050 | `WORKER_CRASHED` | 对 crashed Worker 发起操作 | 主线程内部 | 等待自动恢复或重新触发激活 |
| -32051 | `WORKER_TERMINATED` | 对已 terminate 的 Worker 发起操作 | 主线程内部 | 不应发生（调用前检查 status） |
| -32060 | `SHUTTING_DOWN` | Sidecar 关闭期间收到新请求 | 主线程 → Worker | 不重试 |

### 5.3 错误码分配规则

| 范围 | 用途 |
|------|------|
| -32768 ~ -32700 | JSON-RPC 2.0 标准保留 |
| -32699 ~ -32600 | JSON-RPC 2.0 标准定义（当前使用 -32700, -32600, -32601, -32602, -32603） |
| -32099 ~ -32000 | Plugin 系统自定义（当前使用 -32000 ~ -32060） |
| -31999 ~ -32000 | 预留扩展空间 |

分配策略：按功能域分段，中间留空隙方便后续插入。

- **-3200x**：通信层（timeout、permission）
- **-3201x**：插件状态（not found、not active、manifest、engine）
- **-3202x**：数据大小（payload、quota）
- **-3204x**：存储（storage full）——留了 gap 以防后续增加更多 quota 相关错误
- **-3205x**：Worker 生命周期（crash、terminate）
- **-3206x**：系统状态（shutdown）

### 5.4 错误传播路径汇总

```
┌─────────────────────────────────────────────────────────────────────┐
│ 错误源                │ 错误码              │ 传播路径               │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ RPC handler throw     │ -32603              │ Server → Worker       │
│                       │                     │ (error response)      │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ Method 未注册         │ -32601              │ Server → Worker       │
│                       │                     │ (error response)      │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ RPC request 超时      │ -32000              │ Worker 内部           │
│                       │                     │ (Promise reject)      │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ storage.set value >1MB│ -32021              │ Server → Worker       │
│                       │                     │ (error response)      │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ 插件总存储 >10MB      │ -32040              │ Server → Worker       │
│                       │                     │ (error response)      │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ pluginId 不存在       │ -32010              │ Server → Worker       │
│                       │                     │ (error response)      │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ Worker crash          │ -32050              │ 主线程内部            │
│                       │                     │ + 前端 plugin:crashed │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ Manifest 校验失败     │ -32012 / -32013     │ 主线程日志            │
│                       │                     │ (scan 时跳过)         │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ activate() throw      │ 无 RPC 错误码       │ Worker → 主线程       │
│                       │                     │ (lifecycle error msg) │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ import() 失败         │ 无 RPC 错误码       │ Worker → 主线程       │
│                       │                     │ (lifecycle error msg) │
├───────────────────────┼─────────────────────┼───────────────────────┤
│ Sidecar 关闭          │ -32060              │ rpcServer.dispose()   │
│                       │                     │ reject pending        │
└───────────────────────┴─────────────────────┴───────────────────────┘
```

### 5.5 RpcError 类

```typescript
export class RpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }

  /** 转换为 JSON-RPC 2.0 error object */
  toJSON(): { code: number; message: string; data?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined ? { data: this.data } : {}),
    }
  }
}
```
