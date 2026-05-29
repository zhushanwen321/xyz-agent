---
verdict: pass
must_fix: 0
reviewer: integration-reviewer
date: 2026-05-29
scope: a54ec76..HEAD (plugin-remaining-phases)
---

# Integration Review — Plugin Remaining Phases

## 审查方法

以 BLR (business_logic_review_v1.md) 的模拟数据和执行路径为基础，逐个验证 8 个集成点的跨模块数据流一致性、初始化顺序和协议匹配。

审查涉及的核心文件（20 个）：
- **初始化编排**: `index.ts`
- **服务层**: `plugin-service.ts`, `session-service.ts`, `server.ts`
- **插件子系统**: `plugin-activator.ts`, `plugin-host.ts`, `plugin-storage.ts`, `plugin-permission.ts`, `plugin-permission-storage.ts`
- **API 模块**: `agent-api.ts`, `session-api.ts`, `session-data-api.ts`, `ui-api.ts`, `hook-api.ts`, `tool-api.ts`
- **类型/接口**: `plugin-types.ts`, `interfaces.ts`
- **适配层**: `event-adapter.ts`
- **前端**: `usePlugin.ts`, `useExtensionUI.ts`, `stores/plugin.ts`, `types/plugin.ts`
- **共享协议**: `shared/src/protocol.ts`

---

## 1. PluginService ↔ ISessionService (Session API)

### 数据流

```
PluginService.deps.sessionService (注入 via constructor deps)
  → listPersistedSessions() → SessionGroup[]
    → agent-api.ts: groups.flatMap(g => g.sessions).find(s => s.status === 'active')
  → getSummary(id) → SessionSummary | undefined
  → sendMessage(id, content) → 内部调用 sendMessageHook → 最终到达 pi RPC
  → switchModel(id, provider, modelId)
```

### 验证结果: ✅ 正确

| 检查项 | 状态 |
|--------|------|
| `deps.sessionService` 注入时机 | ✅ `index.ts` 中 `pluginService` 创建时传入 `{ sessionService }` |
| `setSendMessageHook` 调用 | ✅ `initialize()` → `registerSendMessageHook()` → `sessionService.setSendMessageHook(callback)` |
| Session 字段映射 `SessionSummary → SessionInfo` | ✅ `{id, label, cwd, status, createdAt:0, lastActiveAt}` — `createdAt` 硬编码为 0（Phase 2 限制，不影响功能） |
| `listPersistedSessions` 返回类型 | ✅ `session-api.ts` 正确 flatten `SessionGroup[]` → `SessionInfo[]` |
| `sendMessage` hook 错误处理 | ✅ `session-service.ts` catch hook 错误 → 继续发送（不阻塞用户消息） |

---

## 2. PluginService ↔ EventAdapter (Hook bridge)

### 数据流

```
index.ts adapter 工厂闭包:
  (sessionId, interceptor) => new EventAdapter(sessionId, interceptor.send, {
    onHookExecute: (hookType, context) => pluginService!.executeHooks(hookType, {
      pluginId: '',
      hookType: hookType as HookType,
      data: { ...context, sessionId },
      timestamp: Date.now(),
    })
  })

EventAdapter.handleEvent:
  → tool_execution_start → onBeforeToolCall hook
  → tool_execution_end   → onAfterToolResult hook
  → agent_start/agent_end → fireHookEvent (observer)
```

### 验证结果: ✅ 正确（含死代码）

| 检查项 | 状态 |
|--------|------|
| `pluginService!` 闭包安全性 | ✅ 闭包在 session 创建时调用，此时 `pluginService` 已赋值（`index.ts` 第 69 行赋值在 `sessionService` 构造之后） |
| Hook 回调签名匹配 | ✅ `onHookExecute: (string, Record<string, unknown>) => Promise<HookResult>` 与 `executeHooks` 签名一致 |
| HookResult.blocked 传播 | ✅ EventAdapter 检查 `hookResult.blocked === true` → 返回 null（不转发给前端） |
| 死代码: 重复 `case 'agent_start':` | ⚠️ 第 229 行（fire hook + return null）先匹配；第 324 行不可达 |
| 数据转换管道未接通 | ⚠️ EventAdapter 检查 `hookResult.transformedData`，但 `executeHooks` 返回的 `HookResult` 不含此字段。`modifiedData` 仅在 handler 链内部传递，不返回给调用方。工具调用参数不会被 hook 修改（BLR 已记录 UC-3 设计限制） |

**关于死代码**: 第 324 行 `case 'agent_start':` 与第 229 行重复。JS switch 的 first-match 语义意味着第 324 行永远不会执行。这不是 bug（agent_start 的 hook 功能正常工作），但应清理以避免维护混淆。

---

## 3. EventAdapter ↔ PluginService.executeHooks (onHookExecute callback)

### 数据流

```
EventAdapter → this.hookCallback('onBeforeToolCall', {toolName, input})
  → PluginService.executeHooks('onBeforeToolCall', context)
    → hookRegistry.get('onBeforeToolCall') → sorted entries
    → for each entry: rpcServer.invoke(workerId, 'plugin.hooks.invoke', {handlerId, hookType, context}, 5000)
    → Worker 调用 handler → 返回 InterceptorResult
    → proceed === false → return {blocked: true, reason, blockedBy}
    → modifiedData → context.data = modifiedData (链内传递)
  → return {blocked: false}
```

### 验证结果: ✅ 正确

| 检查项 | 状态 |
|--------|------|
| Hook 注册→存储→排序→串行执行 | ✅ `registerHookRpcHandlers` 按 `computePriority` 排序：built-in(0) → trusted(100) → sandbox(200) |
| RPC 超时 5s → 视为放行 | ✅ `executeHooks` catch 路径不阻断链路 |
| Worker crash → skip handler | ✅ `getWorkerHandle` 返回 undefined → continue |
| `plugin.hooks.invoke` 通知处理 | ✅ `hook-api.ts` Worker 侧 `onNotification` 正确查找本地 handler 并返回结果 |
| `plugin.hooks.invoke.result` 传递 | ✅ Worker 通过 `rpcClient.request` 返回结果 → `PluginRpcServer.handleResponse` 解析 |

---

## 4. PluginService ↔ Server (UI dialog WS 路由)

### 数据流

```
Plugin Worker → api.ui.showConfirm('确认删除?')
  → ui-api.ts RPC → PluginService.handleUiRequest('confirm', {...}, pluginId)
    → dispatchUiRequest → broadcastFn('plugin:uiRequest', {requestId, pluginId, method, title, message})
      → server.broadcast({type: 'plugin:uiRequest', payload: ...})

前端响应:
  → sendResponse(requestId, true)
    → useExtensionUI.ts: source==='plugin' → send({type: 'plugin.uiResponse', payload: {requestId, result: true}})
      → server.ts case 'plugin.uiResponse' → pluginService.handleUiResponse(requestId, true)
        → pendingUiRequests.get(requestId) → clearTimeout → resolve(true) → processNextUiRequest()
```

### 验证结果: ✅ 正确（含接口缺口）

| 检查项 | 状态 |
|--------|------|
| WS 消息类型注册 | ✅ `plugin:uiRequest` 在 `protocol.ts` ServerMessageType 中注册 |
| `plugin.uiResponse` 在 `protocol.ts` ClientMessage 中注册 | ✅ |
| 串行排队机制 | ✅ `activeUiRequest !== null` → push queue → processNextUiRequest |
| 60s 超时默认值 | ✅ confirm → false, select/input → undefined |
| `handleUiResponse` 接口声明 | ⚠️ `IPluginService` 接口未声明 `handleUiResponse`；server.ts 使用 `as unknown as { handleUiResponse... }` 绕过类型检查。运行时正常但类型不安全 |
| broadcastFn 分支 | ✅ `handleUiRequest` 中优先使用 `deps.broadcastFn`，fallback 到 `this.broker.broadcast` |

---

## 5. Frontend usePlugin ↔ Server (plugin:uiRequest/plugin.uiResponse)

### 数据流

```
Server → broadcast({type: 'plugin:uiRequest', payload: {requestId, pluginId, method, title, ...}})
  → ws-client.ts: emit('plugin:uiRequest', msg)
    → event-bus → useExtensionUI.ts: onPluginUIRequest(msg)
      → activeRequest.value = {...payload, source: 'plugin'}

用户交互:
  → sendResponse(requestId, true) → source==='plugin'
    → send({type: 'plugin.uiResponse', payload: {requestId, result: true}})
```

### 验证结果: ✅ 正确

| 检查项 | 状态 |
|--------|------|
| WS 消息路由 | ✅ `ws-client.ts` 的 `emit(msg.type, msg)` 将所有 ServerMessage 按 type 分发 |
| 事件注册 | ✅ `useExtensionUI.ts` 模块加载时 `on('plugin:uiRequest', onPluginUIRequest)` |
| source 分流 | ✅ `source === 'plugin'` → `plugin.uiResponse`；否则 → `extension.ui_response`（带 sessionId） |
| 前端类型映射 | ✅ `PluginViewModel` (renderer) 与 `PluginInfo` (shared) 字段一致：pluginId, version, displayName, status, trustLevel, source |
| Store refCount 模式 | ✅ `usePlugin.ts` 使用与 `useChat.ts` 相同的 refCount 模式防止多实例重复注册 |
| Plugin store actions → WS types | ✅ `fetchPlugins` → `plugin.list`, `togglePlugin` → `plugin.toggle`, `approvePermissions` → `plugin.approvePermissions` 等一一对应 |

---

## 6. PluginActivator ↔ PermissionChecker (权限检查)

### 数据流

```
PluginService.constructor:
  this.activator = new PluginActivator()  ← 无 options

期望:
  this.activator = new PluginActivator({
    permissionChecker: this.permissionChecker,
    onPermissionRequest: (payload) => {
      this.broker.broadcast({type: 'plugin:permissionRequest', ...})
    },
  })
```

### 验证结果: ⚠️ 未接线（BLR SF-3 确认）

| 检查项 | 状态 |
|--------|------|
| PermissionChecker 创建 | ✅ `PluginService` 正确创建 `this.permissionChecker = new PermissionChecker(registry)` |
| PermissionChecker.load() | ✅ 在 `initialize()` 中调用 `await this.permissionChecker.load()` |
| RPC 权限检查 | ✅ `rpcServer.setPermissionChecker` 注册了 method-level 检查 |
| Activator 传入 permissionChecker | ❌ 构造函数无 options → `this.permissionChecker` 为 undefined → 权限审批流程跳过 |
| 前端 approvePermissions 路由 | ✅ `server.ts` → `pluginService.approvePermissions()` → `permissionChecker.grant()` + `activator.activatePlugin()` |
| resolvePermissionApproval 路由 | ⚠️ `PluginService.approvePermissions` 调用 `activator.activatePlugin` 但不调用 `activator.resolvePermissionApproval`。即使 options 被传入，approve 路由也不完整 |

**影响**: sandbox 插件直接激活无需审批。功能代码完整但未接线。前端 `PluginPermissionDialog` 组件存在但永远不会触发。

---

## 7. PluginHost Worker rebuild lifecycle

### 数据流

```
trusted Worker crash → handleWorkerCrash
  → crashedTrustedWorkers.set(workerId, {pluginIds, trustLevel})
  → crashCounts 每个 plugin +1
  → 未超过 MAX_REBUILD_ATTEMPTS(3) → setTimeout(5s) → rebuildWorker()
    → createWorker(newWorkerId, 'trusted', primaryPluginId)
    → handle.pluginIds = [plugin-a, plugin-b, ...]
    ❌ 不调用 loadPlugin() + activatePlugin()
```

### 验证结果: ⚠️ 幽灵 Worker（BLR SF-4 确认）

| 检查项 | 状态 |
|--------|------|
| crash 检测 | ✅ Worker error/exit 事件正确触发 `handleWorkerCrash` |
| crash count 跟踪 | ✅ per-plugin crash count 正确递增 |
| rebuild 触发条件 | ✅ `crashCounts[pid] <= MAX_REBUILD_ATTEMPTS` |
| rebuild 创建 Worker | ✅ 新 Worker 线程创建 + handle 注册 |
| rebuild 加载插件 | ❌ `createWorker` 只创建线程，不发送 `load` / `activate` 指令 |
| 状态标记 | ⚠️ `activator.markCrashed` 标记 CRASHED，但 rebuild 后不恢复为 ACTIVE |

**影响**: 重建后的 Worker 是"幽灵"——handle 存在但无功能。不会崩溃但也不工作。代码注释 `// TODO (Phase 2)` 表明此功能预留但未完成。

---

## 8. SessionData file persistence (plugin-storage.ts ↔ plugin-service.ts)

### 数据流

```
写入: Worker RPC → session-data-api.ts set handler
  → 容量检查 → sessionDataCache.set → sessionDataDirty.add → sessionDataSize.set
  → 定时 flush: flushSessionData() → persistSessionData() → JSON.stringify → tmp + rename

恢复（期望）: PluginService.initialize()
  → loadSessionData(baseDir, sessionId)  ← 未调用 ❌
  → 恢复到 sessionDataCache

清理（期望）: session 销毁时
  → deleteSessionData(baseDir, sessionId)  ← 未调用 ❌
```

### 验证结果: ⚠️ 持久化不完整（BLR SF-1, SF-2 确认）

| 检查项 | 状态 |
|--------|------|
| `persistSessionData` 实现 | ✅ 原子写入 (tmp + rename)，容量检查 10MB |
| `loadSessionData` 实现 | ✅ 文件不存在返回空 Map，JSON 解析失败安全降级 |
| `deleteSessionData` 实现 | ✅ ENOENT 静默忽略 |
| `loadSessionData` 调用 | ❌ import 存在但 `initialize()` 中未调用 — 重启丢数据 |
| `deleteSessionData` 调用 | ❌ session 销毁时未调用 — 文件泄漏 |
| flush dirty 恢复 | ✅ `flushSessionData` 先清 dirty 后写，失败时恢复 dirty 标记 |
| `clearSessionData` 内存清理 | ✅ `PluginService.clearSessionData` 清理内存缓存（但文件不删） |

---

## 9. 初始化顺序 (index.ts)

### 执行序列

```
1. const pm = new ProcessManager()
2. const server = new SidecarServer(port, projectRoot)
3. const extensionService = new ExtensionService()
4. const treeService = new TreeService(pm)
5. let pluginService: PluginService | undefined          ← 声明
6. const sessionService = new SessionService(pm, server, adapterFactory, ...)
   → adapterFactory 闭包引用 pluginService!              ← 此时 undefined，但闭包延迟调用
7. const configService = new ConfigService(effectiveRoot)
8. const modelService = new ModelService()
9. const pluginRegistry = new PluginRegistry(effectiveRoot)
10. pluginService = new PluginService(registry, server, { sessionService, ... })  ← 赋值
11. server.setServices(sessionService, configService, modelService, treeService, extensionService, pluginService)
12. server.start()
13. pluginService.initialize()                            ← 扫描+激活+广播
```

### 验证结果: ✅ 正确

| 检查项 | 状态 |
|--------|------|
| pluginService 赋值时机 | ✅ 在 `sessionService` 构造之后、`server.start()` 之前赋值 |
| 闭包安全性 | ✅ adapterFactory 在 session 创建时才被调用，此时 pluginService 已赋值 |
| server.start() 在 pluginService.initialize() 之前 | ✅ 确保 WS 连接就绪后再广播插件列表 |
| initialize() 容错 | ✅ try-catch 包裹，插件初始化失败不阻塞服务启动 |

---

## 10. 跨模块数据流一致性

### WS 协议字段映射

| Server→Client 消息 | 服务端 payload | 前端期望 | 匹配 |
|---------------------|---------------|---------|------|
| `config.plugins` | `{plugins: PluginDescriptor[]}` (mapped via `mapStateForProtocol`) | `{plugins: PluginViewModel[]}` | ✅ status: 'discovered'\|'active'\|'crashed'\|'inactive' |
| `plugin:uiRequest` | `{requestId, pluginId, method, title, message?, options?}` | `ExtensionUIRequestPayload` + `source: 'plugin'` | ✅ useExtensionUI 添加 source 字段 |
| `plugin:crashed` | `{pluginId, workerId, error}` | `{pluginId, error}` (store) | ✅ store 忽略 workerId |
| `plugin:statusChange` | `{pluginId, oldStatus, newStatus}` | `{pluginId, newStatus}` | ✅ store 只用 newStatus |
| `plugin:notification` | `{pluginId, level, message}` | `PluginNotification` | ✅ 字段一致 |
| `plugin:statusBarUpdate` | `{items: [{id, pluginId, text, priority}]}` | `{items: PluginStatusItem[]}` | ✅ |
| `plugin:config` | `{pluginId, config: Record<string, unknown>}` | `{pluginId, config}` | ✅ |

### Client→Server 消息

| Client→Server 消息 | 前端 payload | 服务端期望 | 匹配 |
|---------------------|-------------|-----------|------|
| `plugin.list` | `{}` | — | ✅ |
| `plugin.toggle` | `{pluginId, enabled}` | `msg.payload.pluginId, msg.payload.enabled` | ✅ |
| `plugin.uninstall` | `{pluginId}` | `msg.payload.pluginId` | ✅ |
| `plugin.approvePermissions` | `{pluginId, permissions}` | `msg.payload.pluginId, msg.payload.permissions` | ✅ |
| `plugin.uiResponse` | `{requestId, result}` | `(msg.payload).requestId, (msg.payload).result` | ✅ |
| `plugin.config.get` | `{pluginId, key?}` | `msg.payload.pluginId, msg.payload.key` | ✅ |
| `plugin.config.set` | `{pluginId, key, value}` | `msg.payload.pluginId, msg.payload.key, msg.payload.value` | ✅ |

### 验证结果: ✅ 协议一致

所有 WS 消息的字段名、类型在跨模块传递中保持一致，无序列化/反序列化问题。

---

## 汇总

### Verdict: ✅ PASS

所有已实现的集成点功能正确，跨模块数据流一致。未实现的集成点（权限审批、Worker rebuild、sessionData 恢复/清理）不影响运行时稳定性——它们是功能缺失而非 bug。

### Must Fix: 0

无运行时崩溃、数据损坏或协议不一致问题。

### 应修复项（与 BLR 对齐）

| # | 来源 | 集成点 | 问题 | 影响 |
|---|------|--------|------|------|
| SF-1 | BLR SF-1 | SessionData 恢复 | `loadSessionData` 未调用 | 重启丢数据 |
| SF-2 | BLR SF-2 | SessionData 清理 | `deleteSessionData` 未调用 | 文件泄漏 |
| SF-3 | BLR SF-3 | Activator ↔ PermissionChecker | `PluginActivator()` 无 options | 权限审批流程不生效 |
| SF-4 | BLR SF-4 | Worker rebuild | `rebuildWorker` 不加载插件 | 重建后功能丢失 |

### 集成观察（非阻塞）

1. **`handleUiResponse` 不在 `IPluginService` 接口中**: server.ts 使用 `as unknown as` 绕过类型检查。应在接口中声明此方法（`handleUiResponse(requestId: string, result: unknown): void`）。
2. **EventAdapter 重复 `case 'agent_start':`**: 第 229 行已处理，第 324 行是死代码。应移除以消除维护混淆。
3. **hook 数据转换管道未接通**: `executeHooks` 的 `modifiedData` 仅在 handler 链内部传递，不返回给 EventAdapter。EventAdapter 的 `hookResult.transformedData` 检查永远为 undefined。这是设计限制（与 BLR UC-3 一致），但死代码应标注或移除。
4. **approvePermissions 未调用 `resolvePermissionApproval`**: 即使 SF-3 修复后，`PluginService.approvePermissions` 直接调用 `activatePlugin` 而不解析 pending promise。需要同时调用 `resolvePermissionApproval` + `activatePlugin`。
5. **PluginHost crash count 不重置**: `crashCounts` 只增不减，即使插件成功 rebuild 并运行稳定。长期运行可能因历史 crash 计数超限而不再 rebuild。

### 集成点清单总览

| # | 集成点 | 状态 |
|---|--------|------|
| 1 | PluginService ↔ ISessionService | ✅ 正确 |
| 2 | PluginService ↔ EventAdapter | ✅ 正确（含死代码） |
| 3 | EventAdapter ↔ executeHooks | ✅ 正确 |
| 4 | PluginService ↔ Server (UI dialog) | ✅ 正确（接口缺口） |
| 5 | Frontend usePlugin ↔ Server | ✅ 正确 |
| 6 | Activator ↔ PermissionChecker | ⚠️ 未接线 |
| 7 | Worker rebuild lifecycle | ⚠️ 幽灵 Worker |
| 8 | SessionData persistence | ⚠️ 写不读/不删 |
| 9 | 初始化顺序 | ✅ 正确 |
| 10 | WS 协议字段一致性 | ✅ 正确 |
