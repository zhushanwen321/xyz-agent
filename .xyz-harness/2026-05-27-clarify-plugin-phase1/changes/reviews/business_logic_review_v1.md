---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-28T14:00:00"
  target: "src-electron/runtime/src/services/plugin-service/"
  verdict: fail
  summary: "业务逻辑审查完成，第1轮，8条MUST FIX，核心激活链路（UC-3）因类型桥接断裂和消息路由丢失而完全不可用"

statistics:
  total_issues: 10
  must_fix: 8
  must_fix_resolved: 0
  low: 1
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plugin-activator.ts:ActivatorHost interface"
    title: "ActivatorHost 接口与 PluginHost.assignWorker() 返回类型不兼容"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plugin-host.ts:76-98 worker.on('message') handler"
    title: "Worker 生命周期消息（activated/deactivated/loaded）被 PluginHost 静默丢弃，未转发给 PluginActivator"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "plugin-registry.ts:110-119 inferActivationEvents()"
    title: "activationEvents 自动推断仅处理 slashCommands，遗漏 tools/hooks/panels/statusBarItems"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "plugin-service.ts:70-75 registerRpcMethods()"
    title: "Workspace 存储 RPC 方法（plugin.storage.workspace.*）未注册，workspaceState 完全不可用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "plugin-host.ts handleWorkerCrash()"
    title: "Trusted Worker 崩溃后自动重建未实现，与 spec FR-3 崩溃恢复要求不符"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: MUST_FIX
    location: "plugin-service.ts:42-47 setCrashCallback lambda"
    title: "崩溃通知 payload 字段名和结构不匹配 protocol.ts 定义的 PluginCrashedPayload"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: MUST_FIX
    location: "plugin-service.ts:42-47 setCrashCallback lambda"
    title: "Worker 崩溃后 Activator 插件状态未更新，getState() 返回值被丢弃"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: MUST_FIX
    location: "plugin-types.ts PluginState enum + protocol.ts PluginInfo.status"
    title: "PluginDescriptor.status 使用 UPPER_CASE 值（UNLOADED/ACTIVE/CRASHED），而协议 PluginInfo.status 定义 lower_case 值（discovered/active/crashed），数据契约不匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "plugin-bootstrap.ts:82-96 createAgentAPI notify"
    title: "Notify 使用 rpcClient.request()（等待响应）而非 rpcClient.notify()（fire-and-forget），与 spec 设计不符"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "use-cases.md UC-2"
    title: "Use-cases 文档中 toggle 消息 payload 使用 name 字段，但实现和协议使用 pluginId 字段"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 业务逻辑审查 v1

## 评审记录

- **评审时间**: 2026-05-28 14:00
- **评审类型**: 编码评审（业务逻辑追踪，逐 UC 验证）
- **评审对象**: 插件系统 Phase 1 全部 12 个源文件
- **依据文档**: spec.md, plan.md, use-cases.md, CLAUDE.md, protocol.ts

## 方法说明

1. 模拟了业务数据（插件 manifest、RPC payload、生命周期事件）
2. 逐 UC（UC-1 到 UC-8）追踪代码执行路径
3. 对照 spec.md 的 AC 和 FR 逐条验证
4. 用实际类型信息评估 TypeScript 类型安全性

---

## 模拟业务数据

### Sample Plugin 1: hello-world（测试插件）

```json
{
  "pluginId": "hello-world",
  "version": "1.0.0",
  "displayName": "Hello World",
  "main": "index.js",
  "trustLevel": "trusted",
  "activationEvents": ["onStartupFinished", "onSlashCommand:hello"],
  "status": "UNLOADED",
  "pluginPath": "~/.xyz-agent/plugins/hello-world/",
  "contributes": {
    "slashCommands": [{ "name": "hello", "description": "Say hello" }]
  }
}
```

### Sample Plugin 2: code-reviewer（假设）

```json
{
  "pluginId": "code-reviewer",
  "version": "0.1.0",
  "displayName": "AI Code Reviewer",
  "main": "dist/index.js",
  "trustLevel": "sandbox",
  "activationEvents": ["onToolCall:reviewCode"],
  "status": "UNLOADED",
  "pluginPath": "~/.xyz-agent/plugins/code-reviewer/",
  "permissions": ["workspace.read"],
  "contributes": {
    "tools": [{ "name": "reviewCode", "description": "Review code", "parameters": { "type": "object" } }]
  }
}
```

### Sample RPC Payload

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "plugin.storage.global.get",
  "params": { "pluginId": "hello-world", "key": "activated" }
}
```

### Sample Host→Worker Message

```json
{
  "type": "activate",
  "pluginId": "hello-world",
  "pluginDir": "~/.xyz-agent/plugins/hello-world/",
  "event": { "type": "onStartupFinished" }
}
```

---

## UC 逐路径追踪

### UC-1: 插件发现与列表展示 — ⚠️ 部分通过

**执行链路：**
```
Frontend plugin.list → server.ts handleMessage
  → pluginService.getDiscoveredPlugins()
    → registry.getAllDescriptors()
```

**正常路径验证：**
- `plugin.list` 消息路由 ✓
- `getDiscoveredPlugins()` 返回 `registry.getAllDescriptors()` ✓
- `sendInitialState` 在 WS 连接时也发送 `config.plugins` ✓

**异常路径验证：**
- A1: 目录不存在 → `readdir` throw → catch → continue → 空数组 ✓
- A2: 缺少 xyzAgent → `parsePlugin` 返回 null ✓
- A3: manifestVersion ≠ 1 → `parsePlugin` 返回 null ✓

**← FOUND ISSUE #3**: `inferActivationEvents()` 只处理 `contributes.slashCommands`。
  - `code-reviewer` 插件的 `contributes.tools` 不会被推断
  - 导致 `onToolCall:reviewCode` 不会出现在 activationEvents 中
  - 即使插件被启用，工具调用时也不会懒激活

**← FOUND ISSUE #8**: `PluginDescriptor.status` 值为 `'UNLOADED'`（UPPER_CASE），
  而共享协议 `PluginInfo.status` 定义为 `'discovered'`（lower_case）。
  前端收到的 `status: "UNLOADED"` 与其类型定义 `'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'` 不匹配。

---

### UC-2: 插件启用/禁用 — ⚠️ 部分通过（启用路径有缺陷）

**执行链路：**
```
Frontend plugin.toggle({ pluginId, enabled: true })
  → server.ts → pluginService.togglePlugin(id, true)
    → activator.handleEvent({ type: 'onStartupFinished' })  // 启用
    → activator.deactivatePlugin(id)                         // 禁用
  → broadcastPluginList()
```

**正常路径验证：**
- toggle 消息路由 ✓
- enable 时调用 `handleEvent({ onStartupFinished })` ✓
- disable 时调用 `deactivatePlugin()` ✓
- 返回 PluginDescriptor[] ✓
- 插件存在性检查 ✓

**异常路径验证：**
- A1: 启用已启用插件 → handleEvent 内部 filter 跳过 ACTIVE ✓
- A2: 禁用正在运行的插件（Worker terminate）→ deactivatePlugin 发送 deactivate 消息 ✓
  - 但：A3（trusted 共享 Worker 中仅 deactivate）→ 未实现，activator 没有 Worker 级别操作

**← FOUND ISSUE #1**: `togglePlugin` 通过 `as unknown as ActivatorHost` 调用 activator。
  `ActivatorHost.assignWorker` 声明返回 `Promise<string>`，但 `PluginHost.assignWorker` 返回 `WorkerHandle`。
  这将在 UC-3 的实际激活中导致 `loadPlugin` 查找 Worker 失败。

**问题：toggle 状态不持久化**。重新启动 sidecar 后，所有之前禁用的插件都会被重新启用。
  spec 中 UC-2 提到 extension-state.json 但实现中没有添加。由于 Phase 1 scope 未明确要求，
  标记为 INFO 级别的观察项。

---

### UC-3: 插件懒激活（首次使用） — ❌ 完全不可用

**执行链路：**
```
SlashCommand event → activator.handleEvent()
  → resolveCandidates() 匹配 onSlashCommand:hello
  → activatePlugin(hello-world)
    → host.assignWorker()
    → host.loadPlugin(workerId, pluginPath)
    → sendAndWaitReply({ type: 'activate', ... })
    → [Worker bootstrap] import → module.activate(ctx) → postMessage({ type: 'activated' })
    → [PluginHost] on('message') → ???
    → [Activator] handleWorkerReply() → resolve sendAndWaitReply
```

**← FOUND ISSUE #1 (CRITICAL): `assignWorker` 返回类型不匹配**

```
ActivatorHost.assignWorker 声明: (pluginId, trustLevel) => Promise<string>
PluginHost.assignWorker 实际:   (pluginId, trustLevel) => WorkerHandle
```

在 `activatePlugin()` 中：
```typescript
const workerId = await host.assignWorker(pluginId, descriptor.trustLevel)
// workerId 实际是 WorkerHandle 对象，不是 string！

await host.loadPlugin(workerId, descriptor.pluginPath)
// loadPlugin(workerId: string) 用 WorkerHandle 对象查 Map<string, Worker>
// this.workerInstances.get(workerId) —— 对象引用 vs 字符串 key → 找不到
// 抛出 "Worker not found: [object Object]"
```

**影响**: 整个 UC-3 激活链路在此断裂。插件无法 load，相当于懒激活完全不可用。

**根本原因**: `PluginService` 中使用 `this.host as unknown as ActivatorHost` 桥接，
  跳过了 TypeScript 类型检查，把不兼容的接口强转过去。违反 CLAUDE.md 关键规则 #5
  "pi 适配层不信任外部格式" 的精神：as unknown as 是一种更危险的信任。

**← FOUND ISSUE #2 (CRITICAL): Worker 生命周期消息路由丢失**

即使修复了 ISSUE #1，下一个阻塞问题是消息路由。`PluginHost.createWorker()` 的
`on('message')` 处理器只处理三种类型：

```typescript
worker.on('message', (msg) => {
  if (m.type === 'rpc') { ... }
  else if (m.type === 'fatal_error') { ... }
  else if (m.type === 'error') { ... }
  // 'activated', 'deactivated', 'loaded' → 全部静默丢弃！
})
```

Bootstrap 在 `module.activate(ctx)` 成功后发送 `{ type: 'activated', pluginId }`，
但这个消息被 PluginHost 丢弃，从未到达 `PluginActivator.handleWorkerReply()`。
`sendAndWaitReply` 的 pending promise 只能等待 30 秒超时后 resolve(false)。

**影响**: 即使 worker 成功创建、模块成功加载、activate() 成功调用，activator 永远
  不会收到成功信号。插件状态卡在 'ACTIVATING'，30 秒后超时回退到 'UNLOADED'。

**设计问题**: PluginHost 和 PluginActivator 之间的消息路由只有单向（Worker→PluginHost）。
  PluginHost 没有将 Worker 的 lifecycle 消息转发给 Activator 的机制。需要的设计是：

```
Worker → (message) → PluginHost
  → type === 'rpc' → PluginRpcServer.dispatch()
  → type === 'activated' | 'deactivated' → PluginActivator.handleWorkerReply()
  → type === 'error' | 'fatal_error' → error handling / crash recovery
```

当前实现的 PluginHost 是一个消息黑洞——除了 RPC 和错误，其他消息都被吞没。

**← FOUND ISSUE #3 影响**: `inferActivationEvents` 不完整进一步缩减了懒激活的覆盖范围。
  即使 ISSUE #1 和 #2 修复，通过 `contributes.tools` 声明的插件仍然无法被懒激活触发。

---

### UC-4: 插件使用 KV 存储 — ⚠️ 部分通过（global 可用，workspace 不可用）

**执行链路：**
```
Plugin context.globalState.set(key, value)
  → [bootstrap] createStateStorageProxy()
    → rpcClient.request('plugin.storage.global.set', { pluginId, key, value })
    → [PluginHost] on('message') type === 'rpc'
      → rpcServer.dispatch(workerId, request)
        → handler('plugin.storage.global.set')
          → PluginStorage.set(pluginId, key, value)
```

**正常路径验证：**
- RPC 消息路由（type === 'rpc' → dispatch）✓
- PluginStorage.set 的 debounce + 原子写入 ✓
- 10MB 总限制和 1MB 单值限制 ✓
- PluginStorage.get 从内存缓存返回 ✓

**异常路径验证：**
- A1/A2: 存储超限 → throw STORAGE_FULL → RPC 错误响应 ✓
- A3: 重启后从磁盘加载 → init() 时文件解析 ✓

**← FOUND ISSUE #4: workspace 存储 RPC 方法缺失**

bootstrap 的 `createStateStorageProxy` 对两个 scope 都创建 proxy：
```typescript
globalState: createStateStorageProxy(pluginId, 'global')
workspaceState: createStateStorageProxy(pluginId, 'workspace')
```

但 `PluginService.registerRpcMethods()` 只注册了 `global.*` 方法：
```typescript
plugin.storage.global.get ✓
plugin.storage.global.set ✓
plugin.storage.global.delete ✓
plugin.storage.global.keys ✓
// plugin.storage.workspace.* — 全部缺失！
```

**影响**: `context.api.storage.workspace.set('key', value)` 将返回
  `METHOD_NOT_FOUND` 错误。workspace 隔离的 KV 存储完全不可用。

**`getFilePath` 中 workspace 路径已实现**（基于 cwd hash），但缺少 RPC 方法注册。
  只需要在 `registerRpcMethods()` 中添加对应的 4 个 workspace 方法即可。

---

### UC-5: 插件发送通知 — ⚠️ 部分通过（功能正常但非最优）

**执行链路：**
```
Plugin context.api.notify.info('msg')
  → rpcClient.request('plugin.notify', { pluginId, level, message })
  → [PluginRpcServer] handler('plugin.notify')
    → this.broker.broadcast({ type: 'plugin:notification' })
```

**正常路径验证：**
- RPC 路由到 `plugin.notify` handler ✓
- `broker.broadcast()` 发送 `plugin:notification` ServerMessage ✓
- 前端收到 toast 通知 ✓

**异常路径验证：**
- A1: 前端未连接 → send 静默失败 ✓

**← FOUND ISSUE #9 (LOW)**: spec FR-5 要求 "Worker 侧通过 PluginRpcClient.notify() 发送通知"
  （fire-and-forget），但 bootstrap 使用了 `rpcClient.request()`（等待响应）。
  功能上正确，但每次通知都多一次不必要的请求-响应往返。对于高频通知（如进度更新），
  这会增加延迟。

---

### UC-6: Worker 崩溃恢复 — ❌ 未实现

**执行链路：**
```
Worker crash
  → [PluginHost] on('error') | on('exit', non-zero)
    → handleWorkerCrash()
      → mark handle.status = 'crashed'
      → unregisterWorker from rpcServer
      → onCrash?.()
  → [PluginService] setCrashCallback lambda
    → broker.broadcast('plugin:crashed')
```

**正常路径验证：**
- Worker error/exit 监听 ✓
- WorkerHandle.status 更新为 'crashed' ✓
- RPC Server 反注册 ✓
- 通知广播 ✓

**← FOUND ISSUE #5: Trusted Worker 崩溃自动重建未实现**

spec FR-3 崩溃恢复明确要求：
> trusted Worker → 自动重建，重新加载所有 trusted 插件
> untrusted Worker → 等待下次激活时重建

`handleWorkerCrash()` 只做了 crashed 标记和通知，没有任何重建 Worker 的逻辑。
Trusted Worker 崩溃后，其中的所有插件不会自动恢复。

**← FOUND ISSUE #6: 崩溃通知 payload 格式不匹配**

```typescript
// PluginService 实际发送：
this.broker.broadcast({
  type: 'plugin:crashed',
  payload: { _workerId, pluginIds, error }  // 下划线前缀 + 数组
})

// protocol.ts 定义的 PluginCrashedPayload：
export interface PluginCrashedPayload {
  pluginId: string    // 单个 string，不是数组
  workerId: string    // 无下划线
  error: string
}
```

字段名（`_workerId` vs `workerId`）和类型（`pluginIds: string[]` vs `pluginId: string`）都不匹配。
前端无法正确解析崩溃通知。

**← FOUND ISSUE #7: Activator 插件状态未更新**

```typescript
// PluginService crash callback:
this.host.setCrashCallback((_workerId, pluginIds, error) => {
  for (const pluginId of pluginIds) {
    this.activator.getState(pluginId)  // ← 返回值被丢弃！没有更新状态
  }
  this.broker.broadcast({...})
})
```

`getState()` 被调用但返回值未使用。崩溃后 `Activator.pluginStates` 仍标记插件为 `'ACTIVE'`。
这意味着：
- 后续 `handleEvent()` 会跳过这些插件（`state === 'ACTIVE' → filter out`）
- 即使自动重建 Worker，activator 也不会重新激活插件
- 前端收到的 `config.plugins` 广播中 status 仍然是 `'ACTIVE'`

需要的是 `this.activator.markCrashed(pluginId)` 之类的方法来同步状态。

---

### UC-7: Sidecar 关闭时插件清理 — ⚠️ 部分通过（有超时问题）

**执行链路：**
```
SIGINT/SIGTERM → index.ts shutdown()
  → server.stop()
    → pluginService.shutdown()
      → activator.deactivateAll(host)
        → [每个插件] deactivatePlugin(pid, host)
          → sendAndWaitReply({ type: 'deactivate' }, timeout=5s)
      → host.shutdown()
        → terminate all workers
      → storage.flushAll()
```

**正常路径验证：**
- `server.stop()` → `pluginService.shutdown()` ✓
- `deactivateAll()` 遍历所有 ACTIVE 插件 ✓
- `flushAll()` 刷脏数据到磁盘 ✓
- `host.shutdown()` terminate workers ✓

**异常路径验证：**
- A1: deactivate() 超时（>5s）→ `sendAndWaitReply` 超时 resolve(false) ✓
  - 但由于 **ISSUE #2**，'deactivated' 消息不会到达 Activator
  - deactivatePlugin 总是等待 5s 超时 → 每个插件关闭至少 5s
  - 如果有 N 个插件，关闭时间 ≥ 5N 秒（串行 Promise.allSettled 实际会并发）
- A2: flushAll() 失败 → 日志记录 ✓

**← ISSUE #2 对关闭流程的影响**: 由于生命周期消息路由丢失，deactivate 也受影响。
  `module.deactivate()` 在 Worker 中会被调用（消息被 bootstrap 接收处理），
  但回复的 `{ type: 'deactivated' }` 被 PluginHost 丢弃。Activator 等待 5s 超时。

---

### UC-8: 前端接收插件列表更新 — ✅ 通过

**执行链路：**
```
PluginService.initialize() 完成
  → broadcastPluginList()
    → broker.broadcast({ type: 'config.plugins', payload: { plugins } })
  → [WS Server] → [WS Client] → [Event Bus] → [PluginStore]
```

**正常路径验证：**
- `initialize()` 末尾调用 `broadcastPluginList()` ✓
- `sendInitialState` 中 WS 连接时也发送 ✓
- `togglePlugin()` 每次操作后广播 ✓

**异常路径验证：**
- A1: 前端未连接 → broadcast 发送到空 clients set → 无操作 ✓

**潜在问题（因 ISSUE #8 影响前端解析）**:
- `plugin.list` 请求后返回的 `PluginDescriptor` 中 `status: 'UNLOADED'`
- 前端期望的 `PluginInfo.status` 为 `'discovered' | 'active'` 等
- 当 Phase 2 前端 UI 实现时，状态映射会出错

---

## 关键问题总结

### 阻塞性缺陷（Blocking Chain）

```
ISSUE #1 ──→ ISSUE #2 ──→ UC-3 (懒激活) 完全不可用
                              ↓
                          UC-2 (启用) ──→ 启用后也无法真正激活
                              ↓
                          UC-7 (关闭) ──→ deactivate 必超时 5s
```

**ISSUE #1**（assignWorker 类型不兼容）和 **ISSUE #2**（生命周期消息路由丢失）
共同构成一个阻塞链，使得插件激活的核心流程在任何场景下都无法完成。

### Spec 覆盖矩阵

| AC | 状态 | 说明 |
|----|------|------|
| AC-1 (PluginService 初始化) | ⚠️ 部分通过 | scan + broadcast 正确，但 status 值不匹配协议 |
| AC-2 (Worker Thread 隔离) | ❌ 未实现 | 崩溃恢复（auto-rebuild）未实现 |
| AC-3 (JSON-RPC 通信) | ⚠️ 部分通过 | request/response 正常工作；workspace 方法缺失 |
| AC-4 (懒激活) | ❌ 完全不可用 | 见 ISSUE #1 和 #2 |
| AC-5 (KV 持久化) | ⚠️ 部分通过 | globalState 正常；workspaceState 不可用 |
| AC-6 (现有功能不受影响) | ✅ 通过 | PluginService 独立，不与现有 Service 耦合 |

### 8 条 MUST FIX 优先修复顺序

| 优先级 | ID | 描述 | 影响 UC |
|--------|----|------|---------|
| P0 | #1 | ActivatorHost.assignWorker 返回类型不兼容 | UC-3, UC-2, UC-7 |
| P0 | #2 | Worker 生命周期消息未转发到 Activator | UC-3, UC-7 |
| P1 | #3 | inferActivationEvents 不完整 | UC-3 (tools/hooks) |
| P1 | #4 | Workspace storage RPC 方法缺失 | UC-4 (workspace) |
| P1 | #5 | Trusted Worker 崩溃自动重建未实现 | UC-6 |
| P1 | #6 | 崩溃通知 payload 格式不匹配 | UC-6 |
| P1 | #7 | Activator 状态未在崩溃时更新 | UC-6 |
| P2 | #8 | PluginDescriptor.status 值与协议 PluginInfo 不匹配 | UC-1, UC-8 |

### 修复方向

**#1（类型桥接）** — 两种修复方向：
- 方向 A：让 `ActivatorHost.assignWorker` 返回 `WorkerHandle`（非 `Promise<string>`）
- 方向 B：去掉 `ActivatorHost` 接口，让 Activator 直接依赖 `PluginHost` 类
- 方向 B 更安全（消除 `as unknown as`）

**#2（消息路由）** — 在 `PluginHost.on('message')` 中增加：
```typescript
if (m.type === 'activated' || m.type === 'deactivated') {
  this.activator.handleWorkerReply(m as WorkerToHostMessage)
}
```
需要 PluginHost 持有 Activator 引用。

**#3（事件推断）** — 扩展 `inferActivationEvents()`：
```typescript
if (contributes?.tools) {
  for (const tool of contributes.tools) events.push(`onToolCall:${tool.name}`)
}
if (contributes?.hooks) {
  for (const hook of contributes.hooks) events.push(`onHook:${hook}`)
}
if (contributes?.panels?.length || contributes?.statusBarItems?.length) {
  if (!events.includes('onStartupFinished')) events.push('onStartupFinished')
}
```

**#4（workspace 方法注册）** — 在 `registerRpcMethods()` 增加：
```typescript
['get', 'set', 'delete', 'keys'].forEach(method => {
  this.rpcServer.registerMethod(`plugin.storage.workspace.${method}`, async (params) => {
    return this.storage[method](params.pluginId as string, ...)
  })
})
```

**#5（崩溃重建）** — 在 `handleWorkerCrash()` 中，对 trusted Worker 调用重建逻辑：
```typescript
if (handle.trustLevel === 'trusted') {
  this.rebuildWorker(workerId, pluginIds)
}
```

**#6（payload 格式）** — 修改 crash callback：
```typescript
for (const pluginId of pluginIds) {
  this.broker.broadcast({ type: 'plugin:crashed', payload: { pluginId, workerId, error } })
}
```

**#7（状态同步）** — 在 Activator 增加 `markCrashed(pluginId)` 方法，或让 Activator 持有
  PluginService 回调。

**#8（协议对齐）** — 两种选择：
- 转换 PluginDescriptor.status 到 lower_case（推荐，与协议一致）
- 修改 protocol.ts PluginInfo.status 定义匹配 PluginState

---

## 结论

**评审结论: 不通过，需修改后重审**

插件系统 Phase 1 的代码在静态结构上基本完整——所有类和方法签名都按 plan 创建。
然而核心执行路径（UC-3 懒激活）存在两项阻塞性缺陷：

1. **类型桥接断裂**：`ActivatorHost` 接口通过 `as unknown as` 强转，
   导致 `PluginHost.assignWorker()` 的返回值类型在运行时被误解。
   Worker 被正确创建，但 Activator 拿到的 `workerId` 是一个 WorkerHandle 对象，
   后续所有 Worker 查找操作（`workerInstances.get()`）全部失败。

2. **消息路由黑洞**：PluginHost 作为消息中转层，只处理了 `rpc`、`error`、`fatal_error` 
   三种消息类型，而 Worker 回复的 `activated`、`deactivated` 生命周期消息被静默丢弃。
   导致 `PluginActivator.sendAndWaitReply()` 永远收不到确认信号。

其他 6 条 MUST FIX 分别涉及功能不完整（事件推断、workspace 存储、崩溃恢复、协议对齐），
虽然单独不阻塞，但累积的业务逻辑缺口需要在 Phase 1 内修复。

**关于 `as unknown as` 的风险**：项目 CLAUDE.md 关键规则 #5 说 "pi 适配层不信任外部格式"，
这里 `as unknown as ActivatorHost` 是相反的做法——它信任了一个未经类型检查的桥接。
任何 `as unknown as` 的使用都应当被审计，最好通过将接口改为真实兼容来消除。
