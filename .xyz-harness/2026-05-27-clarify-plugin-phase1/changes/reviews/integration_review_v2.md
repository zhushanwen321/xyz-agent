---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-28T19:15:00"
  target: "plugin-rpc-server.ts + plugin-storage.ts + plugin-service.ts + server.ts + plugin-activator.ts + plugin-registry.ts"
  verdict: fail
  summary: "集成审查第2轮，6条 MUST_FIX 中4条完全修复（含CRITICAL），2条部分修复。发现1条新回归缺陷（broadcastPluginList 双映射）。仍需修复后第3轮审查。"

statistics:
  total_issues: 7
  must_fix: 2
  must_fix_resolved: 4
  low: 1
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plugin-rpc-server.ts:65-75 dispatch()"
    title: "RPC 响应已被正确包裹 { type: 'rpc', response }"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "plugin-service.ts registerRpcMethods() + plugin-storage.ts"
    title: "Workspace scope 已正确传递，PluginStorage API 支持 scope 参数"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "server.ts sendInitialState + plugin.list/plugin.toggle handlers"
    title: "WS handler 已使用 getDiscoveredPlugins() 获取映射后状态"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "plugin-storage.ts flush()"
    title: "flushAll()/onExternalChange() 已修复，但 flush() 仍硬编码 'global' scope"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "flush() 的 cacheKey 仍写死 `${pluginId}:global`。scheduleFlush 为 workspace scope 设置的定时器回调调用 flush(pluginId) 时只 flush global cache，workspace dirty data 不会自动持久化——仅靠 shutdown 时 flushAll() 兜底，进程崩溃场景有数据丢失风险。"

  - id: 5
    severity: MUST_FIX
    location: "plugin-service.ts crash callback + plugin-activator.ts"
    title: "markCrashed() 已添加到 PluginActivator，crash callback 正确调用"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: MUST_FIX
    location: "plugin-registry.ts inferActivationEvents()"
    title: "tools/hooks 已补充推断，panels/statusBarItems 仍缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "contributes.tools → onToolCall:xxx ✅ | contributes.hooks → onHook:xxx ✅ | panels 和 statusBarItems 仍不会触发 onStartupFinished，声明了 panels/statusBarItems 但无其他 activationEvents 的插件不会被懒激活。"

  - id: 7
    severity: LOW
    location: "plugin-service.ts broadcastPluginList()"
    title: "新回归：broadcastPluginList() 对已映射状态二次调用 mapStateForProtocol，所有广播 status 变为 'inactive'"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    note: "broadcastPluginList() 调用 getDiscoveredPlugins()（已映射状态如 'active'/'crashed'/'discovered'）后再调用 mapStateForProtocol() 二次映射。已映射的 lower_case 值不匹配任何 case，全部返回 default→'inactive'。影响：initialize() 后广播、togglePlugin() 后广播中的 status 字段全部为 'inactive'。直接 WS 响应（sendInitialState / plugin.list / plugin.toggle）不受影响，因它们直接调用 getDiscoveredPlugins()。"

---

# 集成审查 v2

## 评审记录

- **评审时间**: 2026-05-28 19:15
- **评审类型**: 集成审查第2轮 — v1 六条 MUST_FIX 修复验证
- **评审对象**: plugin-rpc-server.ts / plugin-storage.ts / plugin-service.ts / server.ts / plugin-activator.ts / plugin-registry.ts
- **依据**: v1 报告 6 条 MUST_FIX 逐条对照代码验证

---

## 一、修复验证结果总览

| # | 严重度 | 标题 | v1 状态 | v2 状态 | 证据 |
|---|--------|------|---------|---------|------|
| 1 | CRITICAL | RPC 响应未被包裹 `type:'rpc'` | ❌ 断裂 | ✅ **已修复** | 三条 `worker.postMessage()` 全部包裹 `{ type: 'rpc', response }` |
| 2 | MUST_FIX | workspace scope 硬编码 global | ❌ 断裂 | ✅ **已修复** | RPC handler 传入 `'workspace'`，Storage API 支持 scope 参数 |
| 3 | MUST_FIX | WS handler 未映射状态 | ❌ 断裂 | ✅ **已修复** | `sendInitialState`/`plugin.list`/`plugin.toggle` 全部使用 `getDiscoveredPlugins()` |
| 4 | MUST_FIX | `flush`/`flushAll`/`onExternalChange` 硬编码 scope | ❌ 断裂 | ⚠️ **部分修复** | `flushAll()` ✅、`onExternalChange()` ✅、`flush()` ❌ 仍硬编码 `'global'` |
| 5 | MUST_FIX | Worker 崩溃后 Activator 状态未更新 | ❌ 断裂 | ✅ **已修复** | `markCrashed()` 方法已添加，crash callback 正确调用 |
| 6 | MUST_FIX | `inferActivationEvents()` 不完整 | ❌ 断裂 | ⚠️ **部分修复** | tools/hooks ✅、panels/statusBarItems ❌ |
| 7 | LOW | `broadcastPluginList()` 双映射回归（新发现） | — | ❌ **新增** | 第162-166行对已映射状态二次调用 `mapStateForProtocol` |

---

## 二、逐条验证

### ISSUE #1 — [CRITICAL] RPC 响应格式 ✅ 已修复

**验证方法**：逐行检查 `plugin-rpc-server.ts` 的 `dispatch()` 方法三条消息路径。

**当前代码**：

```typescript
// dispatch() 方法中的三条 worker.postMessage() 调用

// 1. 方法未找到 (line 65)
worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, PluginRpcErrorCodes.METHOD_NOT_FOUND, ...) })

// 2. 成功响应 (line 71)
worker.postMessage({ type: 'rpc', response: this.makeSuccessResponse(message.id, result) })

// 3. handler 异常 (line 75)
worker.postMessage({ type: 'rpc', response: this.makeErrorResponse(message.id, code, errorMessage) })
```

**验证结果**：三次调用全部包裹在 `{ type: 'rpc', response: RpcResponse }` 结构中。

**额外验证**：`notify()` 和 `broadcast()` 的 `worker.postMessage` 使用 `{ type: 'rpc', notification }` 格式，与 v1 一致，格式正确。

**结论**：✅ 已修复。Worker 侧 `bootstrap.ts` 的 `handleMessage()` switch 分支现在能匹配所有来自主线程的消息类型。

---

### ISSUE #2 — [MUST_FIX] Workspace scope 委托到 global cache ✅ 已修复

**验证方法**：
1. 检查 `plugin-service.ts` 中 workspace RPC handler 是否传递 scope 参数
2. 检查 `plugin-storage.ts` 的 public API 是否接受 scope 参数

**当前代码 `plugin-service.ts registerRpcMethods()`**：

```typescript
// workspace 四个方法全部传入 'workspace' scope
this.rpcServer.registerMethod('plugin.storage.workspace.get', async (params) => {
  return this.storage.get(params.pluginId as string, params.key as string, 'workspace')
})
this.rpcServer.registerMethod('plugin.storage.workspace.set', async (params) => {
  await this.storage.set(params.pluginId as string, params.key as string, params.value, 'workspace')
})
this.rpcServer.registerMethod('plugin.storage.workspace.delete', async (params) => {
  await this.storage.delete(params.pluginId as string, params.key as string, 'workspace')
})
this.rpcServer.registerMethod('plugin.storage.workspace.keys', async (params) => {
  return this.storage.keys(params.pluginId as string, 'workspace')
})
```

**当前代码 `plugin-storage.ts` public API**：

```typescript
async get(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): Promise<...>
async set(pluginId: string, key: string, value: unknown, scope: 'global' | 'workspace' = 'global'): Promise<void>
async delete(pluginId: string, key: string, scope: 'global' | 'workspace' = 'global'): Promise<void>
async keys(pluginId: string, scope: 'global' | 'workspace' = 'global'): Promise<string[]>
```

**验证结果**：
- 四个 workspace RPC handler 全部传入 `'workspace'` scope ✅
- `PluginStorage` 的 public API 方法全部声明了可选的 scope 参数 ✅
- `getFilePath()` 方法已为 workspace scope 生成独立文件路径 `workspace-{cwdHash}.json` ✅

**结论**：✅ 已修复。Workspace 存储调用链完整：`RPC handler → storage.set/get/delete/keys(..., 'workspace') → getCache(pluginId, 'workspace') → 独立文件路径`。

---

### ISSUE #3 — [MUST_FIX] WS handler 未映射状态 ✅ 已修复

**验证方法**：检查 `server.ts` 中的三个 WS 交互点是否使用映射后的状态。

**当前代码 `server.ts`**：

1. **`sendInitialState()`** (line ~145):
```typescript
if (this.pluginService) {
  const plugins = this.pluginService.getDiscoveredPlugins()  // ✅ 获取已映射状态
  this.send(ws, { type: 'config.plugins', ..., payload: { plugins } })
}
```

2. **`plugin.list` handler** (line ~270):
```typescript
case 'plugin.list': {
  const plugins = this.pluginService.getDiscoveredPlugins()  // ✅ 获取已映射状态
  return this.send(ws, { type: 'config.plugins', ..., payload: { plugins } })
}
```

3. **`plugin.toggle` handler** (line ~278):
```typescript
case 'plugin.toggle': {
  const toggledPlugins = await this.pluginService.togglePlugin(...)  // 返回 getDiscoveredPlugins() ✅
  return this.send(ws, { type: 'config.plugins', ..., payload: { plugins: toggledPlugins } })
}
```

**当前代码 `plugin-service.ts getDiscoveredPlugins()`** (line 79-83):
```typescript
getDiscoveredPlugins(): PluginDescriptor[] {
  return this.registry.getAllDescriptors().map(p => ({
    ...p,
    status: this.mapStateForProtocol(p.status) as PluginDescriptor['status'],
  }))
}
```

**验证结果**：三条 WS 路径全部通过 `getDiscoveredPlugins()` 获取已映射状态，不再直接返回 raw UPPER_CASE 状态值。

**结论**：✅ 已修复。前端收到 `config.plugins` 消息中的 `status` 字段统一为 lower_case 格式。

---

### ISSUE #4 — [MUST_FIX] flush/flushAll/onExternalChange 硬编码 scope ⚠️ 部分修复

**验证方法**：检查三个方法的 scope 处理逻辑。

**1. `flushAll()`** (line 97-113):

```typescript
async flushAll(): Promise<void> {
  for (const [cacheKey, cache] of Array.from(this.caches)) {
    if (cache.dirty) {
      const parts = cacheKey.split(':')
      const pluginId = parts[0]
      const scope = (parts[1] ?? 'global') as 'global' | 'workspace'  // ✅ 从 cacheKey 提取 scope
      promises.push(this.writeToDisk(pluginId, scope, cache))
    }
  }
}
```

**结论**：`flushAll()` ✅ 已修复。正确从 `cacheKey` 提取 scope。

**2. `onExternalChange()`** (line 115-117):

```typescript
onExternalChange(pluginId: string): void {
  this.caches.delete(`${pluginId}:global`)
  this.caches.delete(`${pluginId}:workspace`)    // ✅ 同时清理两个 scope
}
```

**结论**：`onExternalChange()` ✅ 已修复。同时删除 global 和 workspace 两个 cache 条目。

**3. `flush()`** (line 85-95):

```typescript
async flush(pluginId: string): Promise<void> {
  const cacheKey = `${pluginId}:global`          // ❌ 仍硬编码 'global'
  const cache = this.caches.get(cacheKey)
  if (!cache || !cache.dirty) return
  ...
  await this.writeToDisk(pluginId, 'global', cache)
  cache.dirty = false
}
```

**结论**：`flush()` ❌ **仍硬编码 `'global'`**。`flush()` 方法不接受 scope 参数，cacheKey 固定为 `${pluginId}:global`。

**影响分析**：

`scheduleFlush()` 为 workspace scope 设置 debounce 定时器的逻辑:

```typescript
private scheduleFlush(pluginId: string, scope: 'global' | 'workspace'): void {
  const cacheKey = `${pluginId}:${scope}`        // ✅ 正确 cacheKey
  const cache = this.caches.get(cacheKey)        // ✅ 找到正确的 cache
  cache.flushTimer = setTimeout(() => {
    this.flush(pluginId)                          // ❌ 只 flush global cache
  }, FLUSH_DEBOUNCE_MS)
}
```

workspace scope 的 debounce 定时器：
- ✅ 正确标注 workspace cache entry 为 dirty
- ✅ 正确查找 workspace cache entry
- ❌ 定时器回调 `flush(pluginId)` 只读取 global cache entry，workspace dirty data 不写入
- ✅ `flushAll()` 在 shutdown 时正确 flush 所有 scope

**修复建议**：

选项 A：让 `flush()` 同时 flush 所有 scope 的 dirty cache：
```typescript
async flush(pluginId: string): Promise<void> {
  for (const scope of ['global', 'workspace'] as const) {
    const cacheKey = `${pluginId}:${scope}`
    const cache = this.caches.get(cacheKey)
    if (!cache || !cache.dirty) continue
    await this.writeToDisk(pluginId, scope, cache)
    cache.dirty = false
  }
}
```

选项 B：改为 scope-aware 的 flush（保留按 scope flush 能力）：
```typescript
async flush(pluginId: string, scope?: 'global' | 'workspace'): Promise<void> {
  const scopes: Array<'global' | 'workspace'> = scope ? [scope] : ['global', 'workspace']
  for (const sc of scopes) {
    const cacheKey = `${pluginId}:${sc}`
    const cache = this.caches.get(cacheKey)
    if (!cache || !cache.dirty) continue
    await this.writeToDisk(pluginId, sc, cache)
    cache.dirty = false
  }
}
```

---

### ISSUE #5 — [MUST_FIX] Worker 崩溃后 Activator 状态未同步 ✅ 已修复

**验证方法**：
1. 检查 `plugin-activator.ts` 是否新增 `markCrashed()` 方法
2. 检查 `plugin-service.ts` 的 crash callback 是否调用 `markCrashed()`

**当前代码 `plugin-activator.ts`** (line ~136):

```typescript
/** 将插件状态标记为 CRASHED（由 PluginService crash callback 调用） */
markCrashed(pluginId: string): void {
  this.pluginStates.set(pluginId, 'CRASHED')
}
```

**当前代码 `plugin-service.ts` crash callback** (line 42-56):

```typescript
this.host.setCrashCallback((workerId, pluginIds, error) => {
  for (const pluginId of pluginIds) {
    this.activator.markCrashed(pluginId)   // ✅ 调用 markCrashed 更新状态
  }
  for (const pluginId of pluginIds) {
    this.broker.broadcast({
      type: 'plugin:crashed',
      id: `crash_${pluginId}_${Date.now()}`,
      payload: { pluginId, workerId, error },
    })
  }
})
```

**强制路径验证**：

```
Worker exit(code=1)
  → PluginHost.handleWorkerCrash(workerId, pluginIds)
    → host map 删除 worker,status='crashed',rpcServer.unregisterWorker
    → onCrash(workerId, pluginIds, error)
  → PluginService crash callback
    → activator.markCrashed(pid) → states.set(pid, 'CRASHED')  ✅
    → broadcast({ type: 'plugin:crashed', payload })
```

**结论**：✅ 已修复。v1 中 `this.activator.getState(pid)` 返回值被丢弃的问题已替换为 `this.activator.markCrashed(pid)`，崩溃后 Activator 内部状态正确更新为 `CRASHED`。

---

### ISSUE #6 — [MUST_FIX] inferActivationEvents() 不完整 ⚠️ 部分修复

**验证方法**：检查 `plugin-registry.ts` 的 `inferActivationEvents()` 方法是否处理 `PluginContributes` 的所有字段。

**当前代码** (line 107-122):

```typescript
private inferActivationEvents(declared: string[], contributes?: PluginContributes): string[] {
  const events = [...declared]
  if (contributes?.slashCommands) {                     // ✅ 已有
    for (const cmd of contributes.slashCommands) {
      const event = `onSlashCommand:${cmd.name}`
      if (!events.includes(event)) events.push(event)
    }
  }
  if (contributes?.tools) {                             // ✅ 新增 (v2)
    for (const tool of contributes.tools) {
      const event = `onToolCall:${tool.name}`
      if (!events.includes(event)) events.push(event)
    }
  }
  if (contributes?.hooks) {                             // ✅ 新增 (v2)
    for (const hook of contributes.hooks) {
      if (!events.includes(hook)) events.push(hook)
    }
  }
  return events
}
```

**覆盖范围检查**：

| contributes 字段 | 处理状态 | 推断事件 |
|-----------------|---------|---------|
| `slashCommands` | ✅ 已处理 | `onSlashCommand:name` |
| `tools` | ✅ **已新增** | `onToolCall:name` |
| `hooks` | ✅ **已新增** | `onHook:xxx` |
| `panels` | ❌ **缺失** | 应推断 `onStartupFinished` |
| `statusBarItems` | ❌ **缺失** | 应推断 `onStartupFinished` |

**影响**：插件声明 `contributes.panels` 但无显式 `activationEvents` 时，不会被懒激活。需要用户额外声明 `"activationEvents": ["onStartupFinished"]`。

**修复建议**：

```typescript
if (contributes?.panels?.length || contributes?.statusBarItems?.length) {
  if (!events.includes('onStartupFinished')) events.push('onStartupFinished')
}
```

---

### ISSUE #7 — [LOW] 新回归：broadcastPluginList() 双映射 ❌ 需修复

**发现轮次**: v2（新增）

**位置**：`plugin-service.ts:162-166`

**当前代码**：

```typescript
private broadcastPluginList(): void {
  const rawPlugins = this.getDiscoveredPlugins()       // ← 已映射: 'active'/'crashed'/'discovered'
  const plugins = rawPlugins.map(p => ({
    ...p,
    status: this.mapStateForProtocol(p.status),         // ← 二次映射: 'active' → fallback → 'inactive'
  }))
  this.broker.broadcast({
    type: 'config.plugins',
    id: `plugins_${Date.now()}`,
    payload: { plugins },
  })
}
```

**问题**：`getDiscoveredPlugins()` 已通过 `mapStateForProtocol()` 将内部状态（UPPER_CASE）映射为协议格式（lower_case）。`broadcastPluginList()` 又对 lower_case 状态再次调用 `mapStateForProtocol()`，由于 'active'/'crashed'/'discovered' 都不匹配 `mapStateForProtocol` 的任何 case，全部落入 default → 返回 `'inactive'`。

**影响范围**：

| 调用位置 | 受影响 | 说明 |
|---------|--------|------|
| `initialize()` 末尾 line 74 | ❌ **受影响** | 初始化后广播的 plugin list 全部 status='inactive' |
| `togglePlugin()` 内 line 101 | ❌ **受影响** | toggle 后广播的 plugin list 全部 status='inactive' |
| `sendInitialState()` 直接调 `getDiscoveredPlugins()` | ✅ 正常 | 不受影响 |
| `plugin.list` handler 直接调 `getDiscoveredPlugins()` | ✅ 正常 | 不受影响 |
| `plugin.toggle` handler 返回 `togglePlugin()` 结果 | ✅ **正常** | WS 响应直接返回 `togglePlugin()` 结果，不经过 `broadcastPluginList()` |

**注意**：该回归不影响 WS handler 的直接响应（sendInitialState/plugin.list/plugin.toggle），但会导致：
1. 初始化后所有连接客户端收到的 `config.plugins` 广播中 status 为 'inactive'
2. toggle 后广播到所有客户端的更新中 status 为 'inactive'
3. 如果前端仅依赖广播消息维护插件状态列表，会导致状态显示全为 'inactive'

**修复建议**：`broadcastPluginList()` 应直接使用 registry 数据而非已映射的数据：

```typescript
private broadcastPluginList(): void {
  const plugins = this.registry.getAllDescriptors().map(p => ({
    ...p,
    status: this.mapStateForProtocol(p.status),
  }))
  this.broker.broadcast({
    type: 'config.plugins',
    id: `plugins_${Date.now()}`,
    payload: { plugins },
  })
}
```

---

## 三、v1 → v2 修复状态对比

```
ISSUE #1 (CRITICAL):  ✗ → ✓   RPC 响应格式
ISSUE #2 (MUST_FIX):  ✗ → ✓   Workspace scope
ISSUE #3 (MUST_FIX):  ✗ → ✓   WS 状态映射
ISSUE #4 (MUST_FIX):  ✗ → △   flush() 仍硬编码 global (flushAll/onExternalChange 已修复)
ISSUE #5 (MUST_FIX):  ✗ → ✓   Crash 状态同步
ISSUE #6 (MUST_FIX):  ✗ → △   panels/statusBarItems 仍缺失 (tools/hooks 已修复)
ISSUE #7 (LOW):       - → ✗   新回归: broadcastPluginList 双映射
```

### 集成关键路径状态更新

| 关键路径 | v1 状态 | v2 状态 | 变化 |
|---------|---------|---------|------|
| CR-1: 插件懒激活 | ✅ 通过 | ✅ 通过 | — |
| CR-2: Worker RPC 存储 | ❌ **断裂 (#1)** | ✅ **已修复** | RPC 响应格式修正 |
| CR-3: Workspace 隔离存储 | ❌ 隔离失败 (#2+#4) | ⚠️ 提升 | 存储调用正确，但 auto-flush 仍不支持 workspace |
| CR-4: 关闭流程 | ⚠️ 部分通过 | ⚠️ 部分通过 | workspace auto-flush 仍缺失 |
| CR-5: 崩溃处理 | ❌ 状态同步失败 (#5) | ✅ **已修复** | markCrashed 已实现 |

---

## 四、结论

**评审结论：不通过，需修改后第3轮审查**

第2轮集成审查验证了 v1 识别的 6 条 MUST_FIX。核心 **CRITICAL 问题（#1 RPC 响应格式）已修复**——这是阻断所有 Worker RPC 通信的瓶颈，修复后存储、通知、session 列表等功能可以正常工作。

workspace scope 委托（#2）和 WS 状态映射（#3）也已正确修复。

但仍存在 **2 条 MUST_FIX 未完全解决**：
- **#4**：`flush()` 仍硬编码 `'global'` scope，workspace scope 的 debounced auto-flush 失效
- **#6**：`panels`/`statusBarItems` 的隐式激活事件仍未被推断

此外发现 **1 条新回归（#7）**：`broadcastPluginList()` 对已映射状态二次调用 `mapStateForProtocol()`，导致所有 `config.plugins` 广播消息中的 `status` 值全部变为 `'inactive'`。

修复优先级建议：
1. **#7**（回归，影响广播状态显示，修复成本极低） → 删除 `broadcastPluginList()` 中的二次映射
2. **#4**（`flush()` 硬编码 'global'，影响 workspace auto-flush 可靠性） → 让 flush 遍历两个 scope
3. **#6**（panels/statusBarItems 懒激活） → 补充推断逻辑
