---
verdict: fail
must_fix: 2
---

# 集成审查报告 v1

- **审查日期**: 2026-05-29
- **审查范围**: Plugin System 前端 DX Phase — 前后端集成点验证
- **审查人**: Integration Reviewer

---

## 1. 审查概要

| 维度 | 评价 |
|------|------|
| WS 消息名对齐 | ✅ 全部匹配 — 8 个 client→server 消息、8 个 server→client 事件均在 protocol.ts 与 server.ts 之间对齐 |
| Payload 结构对齐 | ⚠️ 大部分匹配，存在 payload 结构偏差（见 4.2） |
| IPluginService 接口一致 | ✅ PluginService 实现所有接口方法，签名一致 |
| 数据流完整性 | ❌ handleBridgeIntercept 丢弃 executeHooks 结果，hook 链对 Bridge 无实际作用 |
| 前端事件监听对齐 | ⚠️ 5/8 事件正确接收，3 个事件**从未从服务端广播** |
| BLR 阻断缺陷修复 | ✅ 全部 4 个已修复（togglePlugin、tool_execute 参数、热重载、权限恢复） |
| 协议类型使用 | ❌ 3 个事件定义并接线但无任何 emit 方 |

**判决: fail** — 2 个必须修复项，均为集成层面的功能断点。

---

## 2. BLR 阻断缺陷修复验证

| BLR # | 描述 | 修复状态 | 证据 |
|-------|------|---------|------|
| #1 | `togglePlugin(true)` 激活全部插件 | ✅ **已修复** | `plugin-service.ts` L130: `await this.activator.activatePlugin(pluginId, ...)` — 只激活目标插件 |
| #2 | bridge tool_execute `params` vs `parameters` | ✅ **已修复** | `server.ts` L295: `parameters: params` — 字段名正确 |
| #3 | 热重载 watcher 只对 init 时 ACTIVE 的插件建立 | ✅ **已修复** | `plugin-service.ts` L147-153: `togglePlugin` 激活成功后调用 `watchAndReload` |
| #4 | 权限批准后不恢复激活 | ✅ **已修复** | `plugin-service.ts` L209-215: `approvePermissions` 中检查 `!ACTIVE` 后调用 `activatePlugin` |

所有 4 个 BLR 阻断缺陷已确认修复。

---

## 3. 关键集成点逐项审查

### 3.1 WS 消息名对齐 (protocol.ts ↔ server.ts)

**Client → Server (8 个):**

| protocol.ts 定义 | server.ts handler | 状态 |
|---|---|---|
| `plugin.list` | ✅ `case 'plugin.list'` | ✅ |
| `plugin.toggle` | ✅ `case 'plugin.toggle'` | ✅ |
| `plugin.install` | ✅ `case 'plugin.install'` | ✅ (Phase 4 stub) |
| `plugin.uninstall` | ✅ `case 'plugin.uninstall'` | ✅ |
| `plugin.approvePermissions` | ✅ `case 'plugin.approvePermissions'` | ✅ |
| `plugin.revokePermissions` | ✅ `case 'plugin.revokePermissions'` | ✅ |
| `plugin.executeCommand` | ✅ `case 'plugin.executeCommand'` | ✅ |
| `plugin.config.get` | ✅ `case 'plugin.config.get'` | ✅ |
| `plugin.config.set` | ✅ `case 'plugin.config.set'` | ✅ |

**Server → Client (8 个):**

| protocol.ts 定义 | usePlugin.ts 监听 | 服务端实际广播 | 状态 |
|---|---|---|---|
| `config.plugins` | ✅ `'config.plugins'` | ✅ `broadcastPluginList()` | ✅ |
| `plugin:crashed` | ✅ `'plugin:crashed'` | ✅ crash callback 中 broadcast | ✅ |
| `plugin:notification` | ✅ `'plugin:notification'` | ✅ `plugin.notify` RPC → broadcast | ✅ |
| `plugin:statusChange` | ✅ `'plugin:statusChange'` | ✅ toggle/reload/permission 后广播 | ✅ |
| `plugin:permissionRequest` | ✅ `'plugin:permissionRequest'` | ❌ **从未广播** | **❌ 阻断** |
| `plugin:statusBarUpdate` | ✅ `'plugin:statusBarUpdate'` | ❌ **updateStatusBarItem 是 stub** | **❌ 阻断** |
| `plugin:messageDecoration` | ✅ `'plugin:messageDecoration'` | ❌ **从未广播** | **❌ 阻断** |
| `plugin:config` | ✅ `'plugin:config'` | ✅ `plugin.config.get`/`set` handler 回复 | ✅ |

### 3.2 Payload 结构对齐

**Store 发起的 WS 消息 → protocol.ts payload:**

| store action | 实际发送 payload | protocol 定义 | 匹配 |
|---|---|---|---|
| `togglePlugin` | `{ pluginId, enabled }` | `{ pluginId, enabled, trustLevel? }` | ⚠️ 未发 trustLevel（可选字段） |
| `executeCommand` | `{ pluginId, commandId, ...(args && { args }) }` | `{ pluginId, commandId, args? }` | ✅ 功能等价 |
| `approvePermissions` | `{ pluginId, permissions }` | `{ pluginId, permissions }` | ✅ |
| `plugin.config.get` | `{ pluginId, ...(key !== undefined && { key }) }` | `{ pluginId, key? }` | ✅ |

**注意**: `togglePlugin` 的 `trustLevel` 是可选字段，前端未发送不影响现有功能，但为后续扩展预留。

### 3.3 IPluginService 接口一致性

| 接口方法 | PluginService 实现 | 签名一致 |
|---|---|---|
| `initialize()` | ✅ 实现 | ✅ |
| `getDiscoveredPlugins()` | ✅ 实现 | ✅ |
| `togglePlugin()` | ✅ 实现 | ✅ |
| `shutdown()` | ✅ 实现 | ✅ |
| `uninstallPlugin()` | ✅ 实现 | ✅ |
| `approvePermissions()` | ✅ 实现 | ✅ |
| `revokePermissions()` | ✅ 实现 | ✅ |
| `executeCommand()` | ✅ 实现 | ✅ |
| `getPluginConfig()` | ✅ 实现 | ✅ |
| `setPluginConfig()` | ✅ 实现 | ✅ |
| `clearSessionData()` | ✅ 实现 | ✅ |
| `getToolSchemas()` (optional) | ✅ 实现 | ✅ |
| `handleBridgeToolExecute()` (optional) | ✅ 实现 | ✅ |
| `handleBridgeEvent()` (optional) | ✅ 实现 | ✅ |
| `handleBridgeIntercept()` (optional) | ✅ 实现 | ✅ |

`handleBridgeRequest` 在接口中声明为 optional，PluginService 未实现该方法。这是正确的——server.ts 直接通过 `bridge:sync/tool_execute/event/intercept` 分支路由，不需要统一的 `handleBridgeRequest` 入口。

### 3.4 跨层数据流验证

**Tool Execute (UC-4):**
```
pi → Bridge (extension_ui_request: bridge:tool_execute)
  → EventAdapter.onBridgeUIRequest → server.ts.handleBridgeRequest()
    → PluginService.handleBridgeToolExecute({ toolName, parameters, toolCallId, sessionId })
      → toolRegistry.find(schema.name === toolName) ✅
      → host.getWorkerHandle(entry.pluginId) ✅
      → rpcServer.invoke('plugin.tool.execute', { pluginId, toolName, arguments: request.parameters, ... })
        → timeout 30s ✅
      → return BridgeToolExecuteResponse
    → extension_ui_response → pi
```

✅ 数据流完整，错误处理覆盖（tool not found / Worker crash / timeout / exception）。

**Toggle Plugin (UC-2):**
```
PluginsPane → store.togglePlugin(id, enabled) → WS(plugin.toggle)
  → server.ts → PluginService.togglePlugin()
    → activator.activatePlugin(pluginId, event, host) ✅ 单个插件
    → OR activator.deactivatePlugin(pluginId, host)
    → broadcastPluginList() → config.plugins 推送
  → usePlugin 监听 config.plugins → store.setPlugins() 替换全量列表
```

✅ 数据流完整，乐观更新 + 服务端全量纠正。
✅ togglePlugin 中 `catch` 块确保即使激活失败也返回当前列表，前端 UI 回滚。

**Permission Approval (UC-8):**
```
PluginsPane → store.approvePermissions(id, permissions) → WS(plugin.approvePermissions)
  → server.ts → PluginService.approvePermissions()
    → permissionChecker.grant() ✅
    → pluginService.save() ✅
    → 若 !ACTIVE: activator.activatePlugin() ✅ 修复
    → broadcastPluginList()
```

✅ 数据流完整，BLR 缺陷 #4 已修复。

**Hook Chain (UC-5):**
```
pi → Bridge (extension_ui_request: bridge:intercept)
  → server.ts.handleBridgeRequest() → bridge:intercept case
    → PluginService.handleBridgeIntercept(eventName, data, sessionId)
      → executeHooks(eventName, context)  ⚠️ 串行执行正确
        → hookRegistry.get(hookType) ✅
        → sorted by priority ✅
        → for each: rpcServer.invoke('plugin.hooks.invoke', { handlerId, hookType, context }, 5s)
          → Worker 返回 { proceed, reason?, modifiedData? }
          → blocked? → terminate chain ✅
          → modifiedData? → merge into context ✅
          → timeout 5s → continue ✅
        → return HookResult { blocked: true/false, blockedBy?, reason? }
      → return { injectedMessages: [] }  ❌ 丢弃 executeHooks 结果
    → extension_ui_response({ injectedMessages: [] })
```

**❌ 阻断问题**: `handleBridgeIntercept` 调用了 `executeHooks` 但不检查其返回值。即使 hook 返回 `blocked: true`，Bridge 收到的响应始终是 `{ injectedMessages: [] }`，pi 认为未被阻止，继续发送消息。

### 3.5 前端 Store ↔ 组件集成

| 组件 | Store 依赖 | 数据流 | 状态 |
|---|---|---|---|
| `PluginsPane.vue` | `pluginList`, `externalPlugins`, `loading`, `error` | `fetchPlugins()` → WS → `setPlugins()` | ✅ 完整 |
| `AppStatusbar.vue` | `allStatusBarItems` (from `statusBarItems`) | ❌ 纯前端展示，无服务端数据 | ⚠️ 代码正确但无数据 |
| `SlashMenu.vue` | `allSlashCommands`, `pluginById()` | `executeCommand()` → WS | ✅ 完整 |
| `PluginPermissionDialog.vue` | `permissionRequests` | `approvePermissions()` → WS | ✅ 完整 |
| `PluginSettingsForm.vue` | `pluginConfigs`, `getConfig()`, `setConfig()` | WS → `plugin:config` 事件 | ✅ 完整 |
| `MessageDecoration.vue` | `messageDecorations` | ❌ 纯前端展示，无服务端数据 | ⚠️ 代码正确但无数据 |

---

## 4. 集成缺陷

### 4.1 阻断级缺陷

#### #1: `handleBridgeIntercept` 丢弃 `executeHooks` 结果

- **文件**: `src-electron/runtime/src/services/plugin-service/plugin-service.ts`
- **方法**: `handleBridgeIntercept()`
- **严重度**: **阻断**

**问题描述**:
`handleBridgeIntercept` 调用 `executeHooks(eventName, context)` 但不检查其返回值。`executeHooks` 正确串行执行 hook handlers、检查 `proceed` 字段、在 blocked 时终止链，但 `handleBridgeIntercept` 将这些结果完全丢弃，始终返回 `{ injectedMessages: [] }`。

```typescript
// plugin-service.ts — handleBridgeIntercept()
async handleBridgeIntercept(...): Promise<BridgeInterceptResponse> {
  const context: HookContext = { ... }
  await this.executeHooks(eventName, context)  // ⚠️ 结果被丢弃
  return { injectedMessages: [] }              // 永远返回空
}
```

**影响**:
- Hook handler 返回 `proceed: false` → `executeHooks` 返回 `{ blocked: true, ... }` → 但 Bridge 收到 `{ injectedMessages: [] }` → pi 认为没被阻止 → 消息继续发送
- 整个 hook 阻止机制对 Bridge 触发的拦截事件 (`before_agent_start`) 无效
- 修复后所有 hook chain 的功能性才能正常工作

**修复方案**:
```typescript
async handleBridgeIntercept(eventName, data, sessionId): Promise<BridgeInterceptResponse> {
  const context: HookContext = { pluginId: '', hookType: eventName, data: { eventName, data, sessionId }, timestamp: Date.now() }
  const hookResult = await this.executeHooks(eventName, context)

  if (hookResult.blocked) {
    return { blocked: true, blockedBy: hookResult.blockedBy, reason: hookResult.reason, injectedMessages: [] }
  }

  // 如果 hooks 修改了 context 数据，将修改后的数据返回
  return { injectedMessages: [], /* modifiedData from context if available */ }
}
```

#### #2: 三个 server→client 事件从未广播

- **严重度**: **阻断** (功能声明与实际不匹配)

**受影响的 3 个事件**:

| 事件 | protocol 定义 | usePlugin 监听 | 服务端广播 | 影响 |
|------|:---:|:---:|:---:|------|
| `plugin:permissionRequest` | ✅ | ✅ | ❌ 无 emit 方 | 权限审批对话框不会自动弹出 |
| `plugin:statusBarUpdate` | ✅ | ✅ | ❌ `updateStatusBarItem` 是 stub | 插件状态栏项永不显示 |
| `plugin:messageDecoration` | ✅ | ✅ | ❌ 无 emit 方 | 消息装饰器 tag 永不渲染 |

**详细分析**:

**`plugin:statusBarUpdate`**:
- 协议定义 `PluginStatusBarUpdatePayload { items: StatusBarItem[] }`
- 前端 `usePlugin.ts` 注册了 `'plugin:statusBarUpdate'` 监听器 → `store.setStatusBarItems()`
- 前端 `AppStatusbar.vue` 中 `pluginStatusBarItems` 读取 `pluginStore.allStatusBarItems`
- **但服务端 `updateStatusBarItem` 是空实现**:
  ```typescript
  // plugin-service.ts L404
  updateStatusBarItem: async () => {
    // Phase 2: stub
  },
  ```
  不广播任何 `plugin:statusBarUpdate` 事件。
- 插件 manifest 中声明 `contributes.statusBarItems` 也**不会**自动转换为广播。

**`plugin:messageDecoration`**:
- 协议定义 `PluginMessageDecorationPayload { sessionId, messageId, decorations }`
- 前端 `usePlugin.ts` 注册了 `'plugin:messageDecoration'` 监听器 → `store.setMessageDecorations()`
- **服务端没有任何代码 broadcast 此事件**。

**`plugin:permissionRequest`**:
- 协议定义 `PluginPermissionRequestPayload { pluginId, permissions }`
- 前端 `usePlugin.ts` 注册了监听器 → `store.setPermissionRequest()`
- **服务端没有任何代码 broadcast 此事件**。权限审批仅通过主动的 `plugin.approvePermissions` WS 消息进行，无被动弹出。

**方案**:
修复 #2a (`plugin:statusBarUpdate`):
- 在 `plugin-service.ts` 的 `registerRpcMethods` 中实现 `updateStatusBarItem` handler:
  ```typescript
  updateStatusBarItem: async (pluginId, id, text) => {
    this.broker.broadcast({
      type: 'plugin:statusBarUpdate',
      id: `sbar_${Date.now()}`,
      payload: { items: [{ id, pluginId, text, priority: 100 }] }
    })
  },
  ```
- 或者将 manifest `contributes.statusBarItems` 在插件激活时转换为广播。

修复 #2b (`plugin:messageDecoration`):
- 这是纯 server-driven 的事件，由 Bridge 在消息处理过程中触发。需在 `handleBridgeRequest` 或别处添加适当的 broadcast 调用。

修复 #2c (`plugin:permissionRequest`):
- 需在 `PluginActivator` 激活流程中添加权限检查环节。当插件声明了 `permissions` 但尚未获批准时，broadcast `plugin:permissionRequest` 并等待用户响应。
- 或在 `PluginRpcServer.dispatch()` 中权限校验失败时 broadcast。

---

### 4.2 高危缺陷

#### #3: `handleBridgeIntercept` 只处理 `before_agent_start`

- **文件**: `src-electron/runtime/src/server.ts`
- **方法**: `handleBridgeRequest()` → `bridge:intercept` case
- **严重度**: **高**

```typescript
if (this.pluginService?.handleBridgeIntercept && eventName === 'before_agent_start') {
  // ... 处理
}
```

只有 `eventName === 'before_agent_start'` 会被路由到 `handleBridgeIntercept`。其他可拦截的 hook 类型（如 `onBeforeSendMessage`、`onBeforeToolCall`）即使注册了 handler 也不会被触发。这与 spec UC-5 "插件 Hook 阻止消息发送" 的语义不匹配。

**影响**: 只有 agent 启动前这一个 hook 点可用。pi 的其他消息事件（如消息发送前、tool call 前）无法被插件拦截。这限制了 UC-5 的能力范围。

#### #4: `HookResult.transformedData` 死代码

- **文件**: `src-electron/runtime/src/services/plugin-service/plugin-types.ts`
- **严重度**: **高**（数据流断裂）

`HookResult` 接口声明了 `transformedData?: unknown` 字段，但：
1. `executeHooks` 从不返回 `transformedData`（只返回 `blocked`/`blockedBy`/`reason`）
2. `executeHooks` 内部在 handler 返回 `modifiedData` 时，将其合并到 `context` 供后续 handler 使用，但**不传递给调用方**
3. 调用方（`handleBridgeIntercept`、`handleBridgeEvent`）无法获取最终的转换后数据

这意味着 data transform（handler 返回 `modifiedData`）功能对 Bridge 完全不可用。

---

### 4.3 低危缺陷/建议

#### S1: `plugin.executeCommand` 返回纯 pong

- **文件**: `src-electron/runtime/src/server.ts`
- **问题**: `plugin.executeCommand` handler 在 `PluginService.executeCommand()` 成功后发送 `{ type: 'pong', ... }`，**不携带任何执行结果**。如果命令执行失败（如 Worker crash、RPC timeout），前端无法得知。

```typescript
case 'plugin.executeCommand': {
  // ...
  await this.pluginService.executeCommand(msg.payload.pluginId, msg.payload.commandId, msg.payload.args)
  return this.send(ws, { type: 'pong', id: msg.id, payload: {} })  // 总是成功
}
```

`executeCommand` 若抛出异常，会进入外层 catch 返回 `handler_error` error。所以失败路径有反馈。但成功路径没有确认信息（只有 `pong`），前端无法区分"已执行"和"已收到"。

**影响**: 低。SlashMenu 选择插件命令后立即关闭，结果不重要。

#### S2: SlashMenu `mergedCommands` 无去重

- **文件**: `src-electron/renderer/src/components/chat/SlashMenu.vue`
- **问题**: `mergedCommands` 直接将 `props.commands` 与 `pluginCommands` 拼接，不使用 `useSlashCommands.ts` 中的 `mergeSkillCommands()` 去重逻辑。如果插件 slash command 与内置命令同名，会显示重复项。

---

## 5. 集成健康评分

| 维度 | 分数 (1-10) | 说明 |
|------|:----------:|------|
| WS 消息路由对齐 | 9 | 所有消息名精确匹配，server.ts switch 分支完整 |
| Payload 结构一致性 | 8 | 大部分匹配，部分可选字段未发送（无影响） |
| 接口实现完整性 | 10 | PluginService 实现所有 IPluginService 方法，签名一致 |
| 前端事件监听覆盖 | 4 | 5/8 事件正确接收且能收到数据，3 个事件永远不会被触发 |
| 数据流功能性 | 5 | tool_execute 完整，toggle 完整，hook chain 执行但结果被丢弃 |
| BLR 修复验证 | 10 | 全部 4 个阻断缺陷已修复 |
| **综合** | **6** | 核心功能（list/toggle/uninstall/config/permissions）端到端可用，但 hook 阻止功能和 3 个 server→client 事件存在断点 |

---

## 6. 结论

**判决: fail** — 必须修复 2 项后方可进入下一阶段。

### 必须修复 (Must Fix)

| # | 文件 | 描述 | 预估工作量 |
|---|------|------|-----------|
| **1** | `plugin-service.ts` | `handleBridgeIntercept` 使用 `executeHooks` 返回结果，检查 `blocked` 并返回给 Bridge | 约 10 行 |
| **2** | 多文件 | 实现至少 `plugin:statusBarUpdate` 的 broadcast（`updateStatusBarItem` stub → 真实 broadcast），另两个事件（`plugin:messageDecoration`、`plugin:permissionRequest`）如果本阶段不实现，需在 protocol 和 spec 中标记为 Phase 4，否则视为功能断点 | 约 20 行 + 文档更新 |

### 建议修复 (Should Fix)

| # | 文件 | 描述 |
|---|------|------|
| **S1** | `server.ts` | `bridge:intercept` 增加对 `onBeforeSendMessage`/`onBeforeToolCall` 等 hook 类型的支持 |
| **S2** | `plugin-types.ts` | 清理 `HookResult.transformedData`（死字段）或在 `executeHooks` 中实现返回 |
| **S3** | `SlashMenu.vue` | `mergedCommands` 添加去重逻辑 |

### 已确认修复 (BLR)

| 缺陷 | 状态 |
|------|------|
| togglePlugin 激活全部 → 改为激活单个 | ✅ |
| bridge tool_execute params→parameters | ✅ |
| 热重载 watcher 对延迟激活插件缺失 | ✅ |
| 权限批准后不恢复激活 → 增加重试 | ✅ |
