---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-28T16:30:00"
  target: "src-electron/runtime/src/services/plugin-service/ + server.ts + index.ts + interfaces.ts"
  verdict: fail
  summary: "集成审查完成，第1轮，6条MUST FIX（含1条CRITICAL），核心RPC响应路径完全断裂"

statistics:
  total_issues: 11
  must_fix: 6
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plugin-rpc-server.ts:79(dispatch) + plugin-types.ts HostToWorkerMessage"
    title: "PluginRpcServer.dispatch() 发送的 RPC 响应未被包裹 type:'rpc'，Worker 侧静默丢弃"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plugin-service.ts:32-36 constructor"
    title: "PluginRpcServer 实例未注入 PluginStorage，registerRpcMethods 的 workspace 存储委托到 global cache 而不是独立 scope"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "server.ts:sendInitialState + plugin.list handler + plugin.toggle handler"
    title: "plugin.list/plugin.toggle WS 消息和 sendInitialState 未调用 mapStateForProtocol，返回 UPPER_CASE 状态值"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "plugin-storage.ts:87(flush), :103(flushAll), :139(onExternalChange)"
    title: "PluginStorage 的 flush/flushAll/onExternalChange 硬编码 'global' scope，workspace 数据无法正确持久化"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "plugin-host.ts:116-125 handleWorkerCrash()"
    title: "Worker 崩溃后 PluginActivator 中插件状态未从 ACTIVE 更新为 CRASHED"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: MUST_FIX
    location: "plugin-registry.ts:110-119 inferActivationEvents()"
    title: "inferActivationEvents() 仅处理 slashCommands，遗漏 tools/hooks/panels/statusBarItems 的隐式事件推断"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "plugin-bootstrap.ts:82-96 createAgentAPI notify"
    title: "Notify 使用 rpcClient.request()（等待响应）而非 rpcClient.notify()（fire-and-forget），与 spec 设计不符"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "plugin-host.ts:76-98 createWorker worker.on('message')"
    title: "worker.on('exit') 和 worker.on('error') 在已触 handleWorkerCrash 后重复调用 onCrash，可能导致重复通知"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "plugin-host.ts:116-125 handleWorkerCrash()"
    title: "Trusted Worker 崩溃后重建逻辑未实现（标记 Phase 2），与 spec FR-3 崩溃恢复要求不符"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "plugin-service.ts:20 + plugin-host.ts:14"
    title: "PluginHost 类已通过 implements 正确实现 PluginActivator.PluginHost 接口，business_logic_review 中 ISSUE #1 在代码中已修复"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "plugin-service.ts:70-98 registerRpcMethods() + server.ts:plugin.toggle handler"
    title: "Workspace RPC 方法和生命周期消息路由（activated/deactivated）在代码中已实现，business_logic_review 中 ISSUE #2/#4/#6/#8 已修复"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 集成审查 v1

## 评审记录

- **评审时间**: 2026-05-28 16:30
- **评审类型**: 集成审查（模块间集成点验证 + business_logic_review 交叉验证）
- **评审对象**: PluginService / PluginHost / PluginActivator / PluginRegistry / PluginStorage / PluginRpcServer / PluginRpcClient / plugin-bootstrap / server.ts / index.ts / interfaces.ts / plugin-types.ts
- **依据**: business_logic_review_v1.md 的 8 条 UC 执行路径 + 类型定义 + 代码逐行追踪

## 方法说明

1. **接口契约验证**：逐方法检查 interface 声明与实现的一致性
2. **消息格式追溯**：Worker→Host→Server 全链路消息格式，包括 JSON-RPC 请求/响应包络格式
3. **数据流追踪**：workspace storage 数据的完整路径（RPC method → handler → PluginStorage.cache → flush → 磁盘）
4. **状态同步验证**：跨组件状态一致性（PluginActivator.pluginStates ↔ PluginHost.workers ↔ server.ts 广播）
5. **business_logic_review 交叉验证**：对 8 条 MUST_FIX 逐条验证其在当前代码中的状态

---

## 一、集成点映射

```
┌─────────────────────────────────────────────────────────────────┐
│                      PluginService (orchestrator)              │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ PluginHost   │  │PluginActivator│  │PluginRegistry│           │
│  │ (Worker 池)  │◄─┤ (状态机)       │  │ (扫描+缓存)  │           │
│  └──────┬──────┘  └──────────────┘  └──────────────┘           │
│         │                                                        │
│  ┌──────▼──────┐  ┌──────────────┐  ┌──────────────┐           │
│  │PluginRpcSrv │  │PluginStorage  │  │IMessageBroker│           │
│  │(JSON-RPC)   │  │(KV 持久化)    │  │(WS 广播)     │           │
│  └──────┬──────┘  └──────────────┘  └──────────────┘           │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                               │
│  │  Worker 池    │                                               │
│  │  (Worker 1)  │── PluginRpcClient ──► plugin-rpc-server       │
│  │  (Worker n)  │── bootstrap ──► plugin-host.on('message')     │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────┐
│  SidecarServer     │
│  (WS 消息路由)      │
│  plugin.list       │
│  plugin.toggle     │
│  config.plugins    │
└────────────────────┘
```

### 消息路径总图

```
[Worker]                            [Main Thread]                  [Frontend]
    │                                     │                            │
    │── {type:'load', pluginId} ────────► PluginHost.on('message')     │
    │                                     │── loadPlugin()             │
    │◄── {type:'loaded'} ────────────────┤                            │
    │                                     │                            │
    │── {type:'activate',...} ───────────► PluginActivator             │
    │                                     │── assignWorker()           │
    │                                     │── loadPlugin()             │
    │                                     │── getWorkerHandle()        │
    │◄── {type:'activate'} ──────────────┤                            │
    │                                     │                            │
    │── ★ RPC request ──────────────────► PluginHost.on('message')    │
    │   {type:'rpc', jsonrpc:2.0, id,    │──► PluginRpcServer.dispatch│
    │    method, params}                  │                            │
    │                                     │── handler(params)          │
    │◄── ★ RPC response? ───────────────┤                            │
    │   {jsonrpc:2.0, id, result}        │                            │
    │   ▲▲▲ 无 type:'rpc' 包裹 ▲▲▲       │                            │
    │   bootstrap handleMessage()        │                            │
    │   中 switch(msg.type) 不匹配       │                            │
    │   → 静默丢弃！                     │                            │
    │                                     │                            │
    │── {type:'deactivate',...} ────────► PluginActivator             │
    │                                     │                            │
    │── pluginService.shutdown() ────────► deactivateAll()            │
    │                                     │── flushAll()              │
    │                                     │── host.shutdown()         │
    │                                     │                            │
    │                                     │── broadcastPluginList()   │
    │                                     │──► config.plugins (mapped)│
    │                                     │── WS request plugin.list  │
    │                                     │──► config.plugins (raw!)  │
```

---

## 二、business_logic_review 交叉验证

### 已修复的 ISSUE（代码已不同于审查时的版本）

| 原 ID | 标题 | 当前状态 | 验证依据 |
|-------|------|---------|---------|
| **#1** | `ActivatorHost.assignWorker()` 返回类型不兼容 | ✅ **已修复** | `PluginHost` class 声明 `implements ActivatorHost`且所有方法签名匹配，`plugin-service.ts` 无任何 `as unknown as` 桥接。`assignWorker()` 所有返回路径都返回 `.workerId`（string），非 WorkerHandle |
| **#2** | Worker 生命周期消息被静默丢弃 | ✅ **已修复** | `plugin-host.ts createWorker()` 中 `worker.on('message')` 处理器已添加 `m.type === 'activated' / 'deactivated' / 'error'` 分支，通过 `this.onReply?.(msg)` 转发到 `PluginActivator.handleWorkerReply()` |
| **#4** | Workspace 存储 RPC 方法未注册 | ✅ **已修复** | `registerRpcMethods()` 已注册 `plugin.storage.workspace.{get,set,delete,keys}` 四个方法 |
| **#6** | 崩溃通知 payload 格式不匹配 | ✅ **已修复** | `setCrashCallback()` lambda 中广播使用 `payload: { pluginId, workerId, error }`，匹配 `PluginCrashedPayload` 定义 |
| **#8** | PluginDescriptor.status 与协议 PluginInfo 不匹配 | ✅ **部分修复** | `mapStateForProtocol()` 已添加并在 `broadcastPluginList()` 中使用。但 `plugin.list`/`plugin.toggle` WS handler 和 `sendInitialState` 未使用——见 ISSUE #3 |

### 仍存在的 ISSUE

| 原 ID | 标题 | 当前状态 | 备注 |
|-------|------|---------|------|
| **#3** | `inferActivationEvents()` 不完整 | ❌ 未修复 | 仍只处理 `contributes.slashCommands` |
| **#5** | Trusted Worker 崩溃后自动重建未实现 | ❌ 未修复 | 代码中有 TODO 标记为 Phase 2（见 ISSUE #9 降级说明） |
| **#7** | Activator 插件状态未在崩溃时更新 | ❌ 未修复 | `getState()` 返回值仍被丢弃 |
| #9 | Notify 使用 request() 而非 notify() | LOW | 见 ISSUE #7 |
| #10 | UC-2 文档 name vs pluginId | INFO |  |

---

## 三、新发现的集成缺陷

### ISSUE #1 — [CRITICAL] RPC 响应响应未被包裹 `type:'rpc'`，Worker 侧静默丢弃

**严重性：CRITICAL MUST_FIX**

**位置**：`plugin-rpc-server.ts:79-92 (dispatch)` + `plugin-types.ts:HostToWorkerMessage`

**问题描述**：

`PluginRpcServer.dispatch()` 的响应发送路径：

```typescript
// plugin-rpc-server.ts:79 — 成功响应
worker.postMessage(this.makeSuccessResponse(message.id, result))
// 发送：{ jsonrpc: '2.0', id, result }   ← 无 type 字段

// plugin-rpc-server.ts:83-84 — 方法未找到错误
worker.postMessage(
  this.makeErrorResponse(message.id, ...)  // 同：{ jsonrpc: '2.0', id, error: {...} }
)

// plugin-rpc-server.ts:86-88 — handler 异常
worker.postMessage(
  this.makeErrorResponse(message.id, ...)  // 同
)
```

**全部三次 `worker.postMessage()` 调用都发送裸的 `RpcResponse` 对象，没有 `type:'rpc'` 包裹。**

而 Worker 侧 `bootstrap.ts` 的 `handleMessage()` 通过 switch 匹配 `msg.type`：

```typescript
// bootstrap.ts:38
switch (msg.type) {
  case 'rpc': {
    if (msg.response) rpcClient.handleResponse(msg.response)
    break
  }
  // ...
}
```

接收到 `{ jsonrpc: '2.0', id, result }` 时，`msg.type === undefined`，switch 无匹配分支 —— **响应被静默丢弃**。

**影响范围**：

| 受影响功能 | 路径 | 后果 |
|-----------|------|------|
| `context.globalState.get(key)` | bootstrap → rpcClient.request → ... → 丢弃 | **30s 超时后 reject** |
| `context.globalState.set(key, value)` | 同上 | **30s 超时后 reject** |
| `context.api.notify.info(msg)` | 同上 | **30s 超时后 reject** |
| `context.api.sessions.list()` | 同上 | **30s 超时后 reject** |
| `context.api.storage.workspace.*` | 同上 | **30s 超时后 reject** |

所有插件在 `activate()` 期间使用任何存储 API 都会因超时失败。bootstrap 的 catch 分支会将超时转换为 `{ type: 'error' }`，导致 `handleWorkerReply` resolve(false)，activator 将插件状态设为 `UNLOADED`。

**根本原因**：`HostToWorkerMessage` 类型要求 RPC 响应必须包裹在 `{ type: 'rpc', response: RpcResponse }` 结构中，但 `dispatch()` 直接发送裸对象。

**修复方向**：
```typescript
// plugin-rpc-server.ts dispatch() 中：
worker.postMessage({ type: 'rpc', response: this.makeSuccessResponse(message.id, result) })
// 以及 error 路径同样包裹
worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(...) })
```

---

### ISSUE #2 — [MUST_FIX] Workspace RPC handler 委托到 `PluginStorage.get(pluginId, key)` 硬编码 global cache

**位置**：`plugin-service.ts:70-98 (registerRpcMethods)`

**模拟业务数据验证**：

```
插件 code-reviewer 调用：context.workspaceState.set('repoPath', '/my/project')

1. bootstrap createStateStorageProxy('code-reviewer', 'workspace')
   → rpcClient.request('plugin.storage.workspace.set', {
       pluginId: 'code-reviewer', key: 'repoPath', value: '/my/project'
     })

2. PluginRpcServer dispatch → handler('plugin.storage.workspace.set')
   → this.storage.set('code-reviewer', 'repoPath', '/my/project')
     → PluginStorage.set() 调用 this.getCache('code-reviewer', 'global') ← HARDCODED!
     → cacheKey = 'code-reviewer:global'
     → filePath = ~/.xyz-agent/plugins/code-reviewer/globalState.json

3. 另一个插件调用：context.workspaceState.get('repoPath')
   → same cache 'code-reviewer:global'
   → 返回正确值（因为共用同一个 cache）
```

**数据隔离缺陷**：

虽然是功能正确的（workspace 和 global 共享同一内存 cache），但：
1. **重启后数据混乱**：同一插件下次启动时先加载 `globalState.json` 作为 global 数据。如果 workspace write 的数据恰好在之前的 global flush 中一并写入了 `globalState.json`，重启后这些数据会出现在 global cache 中
2. **文件路径已预留但未使用**：`getFilePath()` 对 workspace scope 生成正确路径 `workspace-{cwdHash}.json`，但从不被写入
3. **cwdHash 隔离不存在**：不同 projectRoot 下的 workspace 数据本应隔离，但现在全部混合

**修复方向**：
1. 让 `PluginStorage` 的 public API (get/set/delete/keys) 接受 scope 参数，或
2. 在 `registerRpcMethods()` 的 workspace handler 中直接调用 `this.storage['get']()` 需要 scope 认知的私有方法

---

### ISSUE #3 — [MUST_FIX] `plugin.list`/`plugin.toggle` WS handler 和 `sendInitialState` 未调 `mapStateForProtocol`

**位置**：`server.ts:110(sendInitialState)` `server.ts:247(plugin.list)` `server.ts:255(plugin.toggle)`

**问题描述**：

有两种平行的 `config.plugins` 发送路径，但状态值格式不同：

| 发送路径 | 位置 | 状态值 | 格式 |
|---------|------|--------|------|
| WS 连接初始状态 | `server.ts sendInitialState:110` | `'UNLOADED'` | ❌ **UPPER_CASE** |
| `plugin.list` 请求 | `server.ts:247-249` | `'UNLOADED'` | ❌ **UPPER_CASE** |
| `plugin.toggle` 响应 | `server.ts:255-257` | `'UNLOADED'` | ❌ **UPPER_CASE** |
| 插件初始化后广播 | `PluginService.broadcastPluginList()` | `'discovered'` | ✅ **lower_case** |
| toggle 后广播 | `togglePlugin()` → `broadcastPluginList()` | `'discovered'` | ✅ **lower_case** |

前端 WebSocket 客户端的 `config.plugins` 消息处理器收到格式不一致的 status 值。同一消息类型 `config.plugins` 下的 `status` 字段可能是 `'UNLOADED'` 或 `'discovered'`。

**影响**：当 Phase 2 实现前端 Plugin UI 时，状态值比较（如 `p.status === 'active'`）在从 `plugin.list` 获取的数据上会错误失效。前端需要加兼容层，增加了不必要的复杂度。

**修复方向**：在 `server.ts` 的 `plugin.list` / `plugin.toggle` handler 和 `sendInitialState` 中对 `plugins` 应用 `mapStateForProtocol()`。或在 `plugin-service.ts` 中提供一个公用方法 `getPluginsForProtocol()` 统一返回映射后的格式。

---

### ISSUE #4 — [MUST_FIX] `PluginStorage.flushAll()` 和 `onExternalChange` 硬编码 `'global'` scope

**位置**：`plugin-storage.ts:87(flush)` `:103(flushAll)` `:139(onExternalChange)`

**问题描述**：

`PluginStorage` 的三个生命周期方法中 scope 处理不一致：

```typescript
// flush():87
const cacheKey = `${pluginId}:global`  // ← 硬编码 'global'

// flushAll():103
const [pluginId] = cacheKey.split(':')  // ← 丢弃 scope
// ...
this.writeToDisk(pluginId, 'global', cache)  // ← 硬编码 'global'

// onExternalChange():139
this.caches.delete(`${pluginId}:global`)  // ← 硬编码 'global'
```

当前由于 ISSUE #2（所有 API 用 `'global'` cache），实际只有 `pluginId:global` 的 cache entry 存在。但如果 ISSUE #2 修复后让 workspace 使用独立 cache entry（如 `code-reviewer:workspace`），`flushAll()` 的 `cacheKey.split(':')[0]` 只会取到 `code-reviewer`，丢失了 `workspace` scope，导致 workspace 数据要么不 flush，要么被 flush 到错误的文件路径。

**修复方向**：将 `flush()/flushAll()/onExternalChange()` 改为 scope-aware：
```typescript
async flushAll(): Promise<void> {
  for (const [cacheKey, cache] of Array.from(this.caches)) {
    if (cache.dirty) {
      const idx = cacheKey.lastIndexOf(':')
      const pluginId = cacheKey.slice(0, idx)
      const scope = cacheKey.slice(idx + 1) as 'global' | 'workspace'
      promises.push(this.writeToDisk(pluginId, scope, cache))
    }
  }
}
```

---

### ISSUE #5 — [MUST_FIX] Worker 崩溃后 PluginActivator 状态未同步

**位置**：`plugin-host.ts:116-125(handleWorkerCrash)` → `plugin-service.ts:42-47 crash callback`

**模拟执行路径**：

```
Worker crash (code-reviewer Worker 退出)
  → PluginHost handleWorkerCrash('sandbox-code-reviewer', 'out of memory')
    → handle.status = 'crashed'
    → rpcServer.unregisterWorker(workerId)
    → this.onCrash?.('sandbox-code-reviewer', ['code-reviewer'], 'out of memory')

  → PluginService crash callback:
    for (const pid of pluginIds) {
      this.activator.getState(pid)  // ← 返回 'ACTIVE'，返回值被丢弃！
    }
    → broadcast({ type: 'plugin:crashed', payload: { pluginId, ... } })

  → 前端收到 crash 通知，但后续 plugin.list 返回 status: 'ACTIVE'（未映射）
  → 用户看到插件状态为 "active" 但无法使用
  → handleEvent() 过滤掉 state==='ACTIVE'的插件，不再尝试激活
```

**后果**：
1. 崩溃后 Activator 不重新激活该插件（`handleEvent()` 跳过 `state === 'ACTIVE'`）
2. 即使自动重建 Worker，activator 也不会重新 load/activate
3. 前端插件列表中 status 为 `'ACTIVE'`，与实际状态不一致
4. 用户无法通过 toggle disable/enable 恢复（不会触发重新激活路径）

**修复方向**：在 `PluginActivator` 添加 `markCrashed(pluginId: string): void` 方法，在 crash callback 中调用：
```typescript
// PluginActivator:
markCrashed(pluginId: string): void {
  this.pluginStates.set(pluginId, 'CRASHED')
  this.disposeContext(pluginId)
}
```

---

### ISSUE #6 — [MUST_FIX] `inferActivationEvents()` 不完整

**位置**：`plugin-registry.ts:110-119`

**代码验证**：

```typescript
private inferActivationEvents(declared: string[], contributes?: PluginContributes): string[] {
  const events = [...declared]
  if (contributes?.slashCommands) {
    for (const cmd of contributes.slashCommands) {
      const event = `onSlashCommand:${cmd.name}`
      if (!events.includes(event)) events.push(event)
    }
  }
  return events
}
```

**问题**：`PluginContributes` 类型定义了 `tools`/`hooks`/`panels`/`statusBarItems` 四个额外字段，但 `inferActivationEvents()` 只处理 `slashCommands`。

**模拟业务数据** —— code-reviewer 插件：
```json
{
  "activationEvents": [],
  "contributes": {
    "tools": [{ "name": "reviewCode", "description": "Review code" }]
  }
}
```

当前处理结果：`activationEvents = []`（空）。预期：`activationEvents = ['onToolCall:reviewCode']`。

**影响**：声明 `contributes.tools` 但未显式声明 `onToolCall:*` 事件的插件无法通过懒激活触发。用户需要在 manifest 中重复声明 `activationEvents: ['onToolCall:reviewCode']`，违背了 spec 中"声明 contributes 即可自动绑定"的设计意图。

**修复方向**：参照 `slashCommands` 的处理模式，补充：
```typescript
if (contributes?.tools) {
  for (const tool of contributes.tools) {
    const event = `onToolCall:${tool.name}`
    if (!events.includes(event)) events.push(event)
  }
}
if (contributes?.hooks) {
  for (const hook of contributes.hooks) {
    const event = `onHook:${hook}`
    if (!events.includes(event)) events.push(event)
  }
}
if (contributes?.panels?.length || contributes?.statusBarItems?.length) {
  if (!events.includes('onStartupFinished')) events.push('onStartupFinished')
}
```

---

## 四、集成关键路径分析

### 关键路径 1：插件懒激活（UC-3）

```
plugin.toggle({pluginId:'hello-world', enabled:true})
  → server.ts → pluginService.togglePlugin(id, true)
    → activator.handleEvent({ type: 'onStartupFinished' }, host)
      → resolveCandidates() → 匹配 onSlashCommand:hello
      → activatePlugin('hello-world', event, host)
        → host.assignWorker(pluginId, 'trusted')  ✓ 返回 string
        → host.loadPlugin(workerId, pluginPath)    ✓
          → bootstrap import → postMessage({type:'loaded'}) ✓
        → host.getWorkerHandle(pluginId) → {workerId, postMessage} ✓
        → sendAndWaitReply(handle, {type:'activate',...}) ✓
          → bootstrap activate → mod.activate(ctx) ✓
          → postMessage({type:'activated'}) ✓
        → PluginHost.onReply → activator.handleWorkerReply(msg) ✓
        → state → ACTIVE ✓
  → broadcastPluginList() → status: 'active' ✓
```

**路径状态**：✅ 通过（得益于 #1 类型匹配和 #2 消息路由已修复）

### 关键路径 2：Worker RPC 存储（UC-4）

```
context.globalState.set('key', 'value')
  → rpcClient.request('plugin.storage.global.set', {pluginId, key, value})
    → parentPort.postMessage({type:'rpc', jsonrpc:'2.0', id, method, params})
      → PluginHost.on('message') → type='rpc' → rpcServer.dispatch()
        → handler('plugin.storage.global.set')
          → this.storage.set('hello-world', 'key', 'value')  ✓
          → worker.postMessage(makeSuccessResponse(id, undefined))
            → Worker 收到: {jsonrpc:'2.0', id, result: undefined}
            → switch(msg.type) 不匹配 ← ❌ **响应丢弃**
            → 30s 后 RPC timeout
```

**路径状态**：❌ **断裂**（ISSUE #1）

### 关键路径 3：Workspace 隔离存储

```
context.workspaceState.set('repo', '/my/project')
  → rpcClient.request('plugin.storage.workspace.set', {...})
    → rpcServer.dispatch → handler('plugin.storage.workspace.set')
      → this.storage.set('code-reviewer', 'repo', '/my/project')
        → getCache('code-reviewer', 'global')  ← ❌ 硬编码
        → 写入 globalState.json（应写入 workspace-{hash}.json）
```

**路径状态**：❌ 隔离失败（ISSUE #2 + #4）

### 关键路径 4：关闭流程（UC-7）

```
SIGTERM → index.ts shutdown()
  → server.stop()
    → pluginService.shutdown()
      → activator.deactivateAll(host)  ✓（所有插件串行）
      → storage.flushAll()  ✓（仅 global scope 的 dirty cache）
      → host.shutdown() → terminate all workers ✓
```

**路径状态**：⚠️ 部分通过（workspace dirty data 不 flush）

### 关键路径 5：崩溃处理（UC-6）

```
Worker exit code 1 → handleWorkerCrash()
  → status='crashed', 通知 broadcast ✓
  → Activator 状态未更新 ← ❌（ISSUE #5）
  → Trusted Worker 不重建 ← ❌（ISSUE #9 LOW, Phase 2 scope）
  → RPC Server 反注册 ✓
```

**路径状态**：❌ 状态同步失败（ISSUE #5）

---

## 五、集成依赖图

```
ISSUE #1 (CRITICAL)          ISSUE #6 (孤立)
    │                            │
    ▼                            ▼
  Worker RPC               tools/hooks 懒激活
  全部超时                    事件无法触发
    │                            │
    ▼                            ▼
  storage 不可用            code-reviewer 插件
  notify 不可用             无法 onToolCall 激活
  sessions.list 不可用
    │
    ▼
  ISSUE #2 + #4 (叠加)
    │
    ▼
  workspace 隔离失效
  flush/scoping 问题
    │
    ▼
  ISSUE #3 (叠加)
    │
    ▼
  前端收到不一致状态格式
```

### 阻塞链判定

| 链 | 描述 | 严重度 |
|----|------|--------|
| #1→全部 | RPC 响应丢失导致所有 Worker→Host 通信失效 | **CRITICAL** — 阻塞所有存储和通知 |
| #2+#4→workspace | workspace 数据与 global 混合 | HIGH — 数据隔离失败 |
| #3→前端 | 状态值格式不一致 | HIGH — 接口不兼容 |
| #5→崩溃恢复 | 崩溃后 Activator 状态不同步 | HIGH — 状态不一致 |

---

## 六、Spec 覆盖矩阵（集成层面）

| 集成点 | 覆盖状态 | 说明 |
|--------|---------|------|
| PluginService → PluginActivator (handleEvent) | ✅ 通过 | 接口匹配，setReplyCallback 路由正确 |
| PluginService → PluginHost (crash/reply callback) | ✅ 通过 | 回调注册和调用正确 |
| PluginActivator → PluginHost (assignWorker) | ✅ 通过 | 类型匹配，返回 string |
| PluginActivator → PluginHost (loadPlugin) | ✅ 通过 | Worker 创建和模块导入正确 |
| PluginActivator → PluginHost (getWorkerHandle) | ✅ 通过 | workerId 查找正确 |
| PluginHost → PluginRpcServer (dispatch) | ✅ 通过 | RPC 请求路由到 handler |
| **PluginRpcServer → Worker (RPC response)** | ❌ **断裂** | **裸 RpcResponse 无 type 包裹** |
| PluginRpcClient → PluginRpcServer (request) | ✅ 通过 | 消息格式正确 |
| PluginService → PluginStorage (RPC handlers) | ⚠️ 部分通过 | workspace 方法路由到 global cache |
| PluginStorage → Disk (flush) | ⚠️ 部分通过 | global flush 正确，workspace 丢失 |
| PluginService → SidecarServer (状态广播) | ⚠️ 部分通过 | 广播映射了状态，请求响应未映射 |
| SidecarServer → Frontend (WS message) | ⚠️ 部分通过 | 格式不一致 |
| index.ts → PluginService (initialize) | ✅ 通过 | 注入和初始化顺序正确 |
| index.ts → SidecarServer (shutdown) | ✅ 通过 | 关闭顺序正确 |

---

## 七、必须修复优先级

| 优先级 | ID | 描述 | 影响集成点 | 阻断下游 |
|--------|----|------|-----------|---------|
| **P0** | #1 | RPC 响应无 type 包裹，Worker 静默丢弃 | RPC Server → Worker 响应路径 | 所有存储/通知 |
| **P1** | #2 | Workspace handler 委托到 global cache | Storage → Worker RPC | workspace 数据隔离 |
| **P1** | #3 | WS handler 未映射状态到协议格式 | Server → Frontend | 前端状态解析 |
| **P1** | #4 | flushAll/onExternalChange 硬编码 scope | Storage 生命周期 | 数据持久化 |
| **P1** | #5 | Activator 崩溃后状态未同步 | Activator ↔ Host 状态 | 崩溃恢复 |
| **P2** | #6 | inferActivationEvents 不完整 | Registry → Activator 事件 | tools 懒激活 |

## 八、结论

**评审结论：不通过，需修改后重审**

集成审查发现 **6 条 MUST FIX**（含 1 条 CRITICAL），远多于 business_logic_review 中被修复的剩余问题。

**最严重的发现（ISSUE #1）**：`PluginRpcServer.dispatch()` 的所有响应发送路径（成功响应、方法未找到、handler 异常）都发送裸的 `RpcResponse` 对象，没有包裹 `{ type: 'rpc', response: ... }`。Worker 侧 boostrap 的 `handleMessage()` 通过 `switch(msg.type)` 分派，收到无 `type` 字段的消息后静默丢弃。这导致 **Worker 的所有 RPC 请求（存储 get/set/delete、通知、session 列表）都在 30 秒超时后失败**。

从 business_logic_review 到当前代码，ISSUE #1（类型桥接）、#2（消息路由）、#4（workspace RPC 方法）、#6（payload 格式）、#8（协议映射）已在实现中被修复。但 ISSUE #1 的修复是 **表面性的** —— PluginHost 与 PluginActivator 之间的 `activated`/`deactivated` 消息路由虽已修复，但 **RPC Server 到 Worker 的响应路径完全断裂**，这是 business_logic_review 未覆盖到的集成点。

三个新的 MUST_FIX（ISSUE #2/#4 workspace scope 硬编码、ISSUE #3 状态映射不一致、ISSUE #1 RPC 响应格式）都是纯粹的消息格式/数据流问题，仅在跨组件边界处暴露，验证了集成审查的必要性。
