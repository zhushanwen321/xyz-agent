---
verdict: fail
must_fix: 4
---

# 业务逻辑审查报告 v1

- **审查日期**: 2026-05-29
- **审查范围**: Plugin System 前端 DX Phase — 后端 Stub 修复 + 前端集成 + 质量补强
- **审查人**: Business Logic Reviewer

---

## 1. 审查概要

| 维度 | 评价 |
|------|------|
| Use Case 覆盖 | 8/8 UC 有对应代码实现，但存在实现偏差 |
| 关键业务流程正确性 | **2 个阻断级缺陷**（togglePlugin 激活全部、bridge tool_execute 参数丢失） |
| 边界条件处理 | 部分覆盖（Worker crash ✓、timeout ✓、empty state 部分✓） |
| 数据流完整性 | **1 个阻断级缺陷**（bridge:tool_execute 字段名不匹配） |
| 状态一致性 | **1 个缺陷**（热重载不覆盖延迟激活的插件） |

---

## 2. Use Case 逐项审查

### UC-1: 用户查看和管理已安装插件列表 ⚠️ 部分通过

**代码路径**: PluginsPane → PluginStore.fetchPlugins() → WS `plugin.list` → server.ts → PluginService.getDiscoveredPlugins() → WS `config.plugins` → store.setPlugins()

**验证结果**:
- ✅ `plugin.list` 路由正确 → `getDiscoveredPlugins()` 返回正确数据
- ✅ `sendInitialState` 在 sidecar 启动时推送 `config.plugins`（含全部插件）
- ✅ 前端 `usePlugin` composable 监听 `config.plugins` 事件 → `store.setPlugins()`
- ✅ 前端 store 提供 `pluginList`、`activePlugins`、`builtInPlugins`、`externalPlugins` getter
- ⚠️ PluginsPane 空状态——spec 要求「无外部插件时显示空状态引导」，前端 store 的 `externalPlugins` getter 存在，但 **尚未验证 PluginsPane 模板中是否有对应的空状态渲染**（Vue 模板未读）

**状态映射偏差**:
- `PluginService.mapStateForProtocol`: `LOADING`/`UNLOADED` → `discovered`，但 `PluginViewModel.status` union type 包含 `'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'`。`discovered` 对应前端的 `status: 'discovered'`，看起来一致。但 `mapStateForProtocol` 的 `default` 返回 `'inactive'`，这意味着 `DEACTIVATING` / `DEPS_MISSING` 也会被映射为 `inactive`，信息丢失。

### UC-2: 用户启用/禁用外部插件 ❌ 阻断级缺陷

**代码路径**: PluginsPane → PluginStore.togglePlugin() → WS `plugin.toggle` → server.ts → PluginService.togglePlugin() → PluginActivator

**阻断缺陷 #1 — `togglePlugin` 启用时激活全部插件**:

```typescript
// plugin-service.ts: togglePlugin()
if (enabled) {
  // ❌ 错误：调用 handleEvent('onStartupFinished') 会激活所有匹配该事件的插件
  await this.activator.handleEvent({ type: 'onStartupFinished' }, this.host)
} else {
  await this.activator.deactivatePlugin(pluginId, this.host)  // ✅ 正确：只停用一个
}
```

**影响**:
- 用户启用插件 A → ALL 已注册 `onStartupFinished` 的插件被激活（包括用户不想启用的插件）
- 埋没 `deactivatePlugin` 的单插件语义，与 spec UC-2 "用户点击 Toggle 开关启用/禁用**目标插件**" 矛盾

**修复方案**:
```typescript
if (enabled) {
  // ✅ 应直接激活目标插件
  await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
}
```

### UC-3: 用户卸载外部插件 ✅ 通过

**代码路径**: PluginsPane → PluginStore.uninstallPlugin() → WS `plugin.uninstall` → server.ts → PluginService.uninstallPlugin()

**验证结果**:
- ✅ 前端 store 有 `uninstallPlugin()` action，检查 built-in 后发送 WS
- ✅ server.ts 路由到 `pluginService.uninstallPlugin()`
- ✅ 停用 + 从 registry/toolRegistry/hookRegistry 移除
- ✅ 广播更新列表

### UC-4: 插件 Tool 被 LLM 实际调用 ❌ 阻断级缺陷

**代码路径**: pi → Bridge → WS `bridge:tool_execute` → server.ts.handleBridgeRequest() → PluginService.handleBridgeToolExecute() → RPC invoke → Worker handler

**阻断缺陷 #2 — bridge tool_execute 参数丢失**:

```typescript
// server.ts handleBridgeRequest() — bridge:tool_execute 分支
const params = data.params as Record<string, unknown> ?? {}
const result = await this.pluginService.handleBridgeToolExecute({
  toolName,
  params,           // ❌ 字段名是 "params"，但 BridgeToolExecuteRequest 期望 "parameters"
  toolCallId: data.toolCallId as string ?? '',
  sessionId,
} as unknown as BridgeToolExecuteRequest)  // as unknown 绕过了类型检查
```

**影响**: `handleBridgeToolExecute` 中 `request.parameters` 为 `undefined` → Worker 收到的 `arguments` 为空对象 → **tool 收到的参数全部丢失**。这是一个运行时数据损坏 bug。

**修复方案**: 将 `params` 改为 `parameters`。

**其他验证**:
- ✅ tool 查找（按 `schema.name` 匹配）
- ✅ Worker 不可用 → `'Plugin worker crashed'`
- ✅ RPC 超时 → `'Plugin tool execution timed out'`
- ✅ 执行异常 → catch + isError
- ✅ Tool not found → isError

### UC-5: 插件 Hook 阻止消息发送 ⚠️ 部分通过

**代码路径**: server.ts.handleBridgeRequest(bridge:intercept) → PluginService.handleBridgeIntercept → PluginService.executeHooks() → RPC invoke(plugin.hooks.invoke)

**验证结果**:
- ✅ `executeHooks` 串行执行（不是 fire-and-forget）
- ✅ 按 priority 排序（built-in → trusted → sandbox）
- ✅ blocked 终止链 → `{ blocked: true, blockedBy }`
- ✅ 5s 超时 → 视为放行
- ✅ Worker crash → skip
- ✅ `modifiedData` 支持 context 传递

**数据流缺陷 — `handleBridgeIntercept` 聚合不完整**:
```typescript
// 简化实现：插件可注入的消息暂不聚合（Phase 2 末期完善）
return { injectedMessages: [] }
```
- 虽然 spec 中标注了"Phase 2 末期完善"，但 `handleBridgeIntercept` 调用了 `executeHooks` 但**完全丢弃了所有 hooks 的执行结果**（既不检查 blocked 也不聚合 injectedMessages）。
- 这意味着 `before_agent_start` 事件虽然触发了 plugin hooks，但 hooks 的返回值（包括 blocked 和 injectedMessages）被忽略。

**类型命名不一致（非阻断，但需后续统一）**:
- 插件 handler 返回 `InterceptorResult`（`{ proceed, reason?, modifiedData? }`）
- `executeHooks` 读取 `result.modifiedData` ✓
- 但 `HookResult` 接口中声明 `transformedData`（与 `modifiedData` 不同名）
- 当前调用方未使用这个字段，所以无运行时影响，但代码健壮性差

### UC-6: 开发者热重载插件 ⚠️ 缺陷

**代码路径**: fs.watch → PluginActivator.watchAndReload() → deactivatePlugin() → activatePlugin() → broadcast

**缺陷 #3 — 热重载不覆盖延迟激活的插件**:

```typescript
// plugin-service.ts initialize() 第 9 步
for (const desc of this.registry.getAllDescriptors()) {
  if (desc.source === 'external' && this.activator.getState(desc.pluginId) === 'ACTIVE') {
    this.activator.watchAndReload(...)
  }
}
```
- 该循环在 `initialize()` 阶段执行
- 只有在 `initialize()` 时**已经** ACTIVE 的 external 插件才获得热重载监听
- 通过 `togglePlugin` 稍后激活的插件不会建立 watcher

**修复方案**: 将 hot-reload 逻辑与 activate 流程绑定，在 `activatePlugin` 成功后按需启动 watcher。

**其他验证**:
- ✅ Built-in 跳过
- ✅ 300ms debounce
- ✅ deactivate 超时 5s → force terminate
- ✅ JS/TS 文件过滤
- ✅ 状态变更广播

### UC-7: 用户修改插件配置 ✅ 通过

**代码路径**: PluginSettingsForm → PluginStore.setConfig() → WS `plugin.config.set` → server.ts → PluginService

**验证结果**:
- ✅ `plugin.config.get`/`plugin.config.set` WS 消息定义完整
- ✅ server.ts 正确路由：get 返回全部/单个配置，set 返回更新后的全部配置
- ✅ `getPluginConfig(key?)`: undefined → 全部; 具体 key → 单值
- ✅ 前端 store 有 `getConfig()`/`setConfig()` action
- ✅ `plugin:config` 事件处理 → `store.setPluginConfig()`

### UC-8: 插件权限审批 ❌ 功能缺口

**代码路径**: PluginActivator → server.ts broadcast → PluginPermissionDialog → WS `plugin.approvePermissions` → server.ts → PluginService.approvePermissions()

**验证结果**:
- ✅ WS 消息 `plugin.approvePermissions`/`plugin.revokePermissions` 定义完整
- ✅ server.ts 路由正确
- ✅ `approvePermissions()` 更新 descriptor + permission checker + 持久化
- ✅ `revokePermissions()` 清除
- ✅ 前端 store 有 `approvePermissions()`/`revokePermissions()` action
- ✅ `plugin:permissionRequest` 事件处理

**缺口 — 权限审批后不恢复插件激活流程**:
- `approvePermissions` 只保存了权限到存储，但**没有触发任何激活重试**
- PluginActivator 的 `activatePlugin` 流程中没有检查权限的环节——权限检查由 PluginRpcServer 的 `dispatch` 阶段（即 Worker 发起 RPC 时）完成
- spec UC-8 预期 "用户批准后插件继续激活"，但实际流程中：sidecar 推送 permissionRequest → 用户批准 → 权限已保存 → **插件状态仍为 DISCOVERED**（没有自动 RESUMING ACTIVATION）
- 需要 PluginActivator 支持 "等待权限 → 收到批准后继续激活" 的状态机

---

## 3. 数据流完整性分析

### 3.1 Tool Execute 数据流（UC-4）

```
pi → Bridge → WS(bridge:request) → server.ts.handleBridgeRequest()
  → PluginService.handleBridgeToolExecute()
    → toolRegistry.find()        ✅ 正确
    → host.getWorkerHandle()     ✅ 正确
    → rpcServer.invoke(plugin.tool.execute, { toolName, arguments: request.parameters, ... })
      → Worker handler 执行业务逻辑
      → Worker 返回结果
  → extension_ui_response → pi
```

**阻断问题**: `request.parameters` 永远为 `undefined`（见缺陷 #2）

### 3.2 Hook Chain 数据流（UC-5）

```
server.ts.handleBridgeRequest(bridge:intercept)
  → PluginService.handleBridgeIntercept()
    → executeHooks()
      → hookRegistry.get(hookType)     ✅
      → sorted by priority              ✅
      → for each: rpcServer.invoke(plugin.hooks.invoke, { handlerId, hookType, context }, 5s)
        → Worker 返回 { proceed, reason?, modifiedData? }
        → blocked? → 终止链            ✅
        → modifiedData? → 合并 context  ✅
        → timeout 5s → 继续             ✅
      → return { blocked: false }
    → return { injectedMessages: [] }
  → extension_ui_response → pi
```

**问题**: `handleBridgeIntercept` 不检查 `executeHooks` 返回的 `blocked` 结果，也不聚合 injectedMessages。

### 3.3 Permission Approval 数据流（UC-8）

```
PluginActivator.activatePlugin()
  → ... 激活流程中无权限检查环节
  → 如果有 pending permissions:
    server.ts broadcast(plugin:permissionRequest)
    → 前端显示对话框
    → 用户批准 → WS plugin.approvePermissions
    → PluginService.approvePermissions()
      → 保存权限 ✅
      → 激活不恢复 ❌
```

---

## 4. 缺陷汇总

| # | 严重度 | 文件 | 行(约) | 描述 | 关联 UC |
|---|--------|------|--------|------|---------|
| **1** | **阻断** | `plugin-service.ts` | `togglePlugin()` | `togglePlugin(true)` 调用 `handleEvent('onStartupFinished')` 激活**全部**插件，应改为 `activatePlugin()` 单插件激活 | UC-2 |
| **2** | **阻断** | `server.ts` | `bridge:tool_execute` 分支 | 传入 `params` 但 `BridgeToolExecuteRequest` 用 `parameters`，`as unknown` 绕过类型检查，参数全部丢失 | UC-4 |
| **3** | **高** | `plugin-service.ts` | `initialize()` step 9 | 热重载 watcher 仅在 init 时为已 ACTIVE 插件建立，延迟激活的插件不触发 hot reload | UC-6 |
| **4** | **中** | `plugin-service.ts` | `approvePermissions()` | 权限批准后不恢复插件激活流程，插件停留在 `discovered` 状态 | UC-8 |

### 次要建议

| # | 类型 | 说明 |
|---|------|------|
| S1 | 类型不一致 | `HookResult.transformedData` vs `InterceptorResult.modifiedData`，调用方实际使用 `modifiedData` |
| S2 | 功能缺口 | `handleBridgeIntercept` 丢弃 `executeHooks` 的 blocked/injectedMessages 结果 |
| S3 | 信息丢失 | `mapStateForProtocol()` 将 `DEACTIVATING`/`DEPS_MISSING` 都映射为 `'inactive'`，前端无法区分 |
| S4 | 状态缺失 | `plugin.executeCommand` 仅返回 `pong`，前端无法得知命令执行成功/失败 |

---

## 5. 关键模拟业务数据

### 5.1 Tool Execute — 当前（错误）

```typescript
// Bridge 发送（正确）
{ toolName: 'goal_manager', params: { action: 'create_tasks', tasks: ['task1'] }, toolCallId: 'call_123', sessionId: 'sess_1' }

// server.ts 转换后（错误：字段名不匹配）
const request = {
  toolName: 'goal_manager',
  params: { action: 'create_tasks', tasks: ['task1'] },  // ❌ 应为 parameters
  toolCallId: 'call_123',
  sessionId: 'sess_1',
}

// handleBridgeToolExecute 收到
request.parameters === undefined  // ❌ 参数丢失！
// Worker 收到: { pluginId, toolName, arguments: undefined, sessionId, toolCallId }
```

### 5.2 Tool Execute — 修正后

```typescript
// server.ts 应改为
const result = await this.pluginService.handleBridgeToolExecute({
  toolName,
  parameters: data.params as Record<string, unknown> ?? {},  // ✅ 字段名匹配
  toolCallId: data.toolCallId as string ?? '',
  sessionId,
})

// handleBridgeToolExecute 收到
request.parameters = { action: 'create_tasks', tasks: ['task1'] }
// Worker 收到: { pluginId, toolName, arguments: { action: 'create_tasks', tasks: ['task1'] }, sessionId, toolCallId }
```

### 5.3 Toggle Plugin — 当前（错误）

```typescript
// 用户启用 plugin-b
await pluginService.togglePlugin('plugin-b', true)
// → activator.handleEvent('onStartupFinished')
// → 激活 ALL onStartupFinished 插件（包括 plugin-a, plugin-b, plugin-c）
// ❌ 用户只期望 plugin-b 被激活
```

### 5.4 Toggle Plugin — 修正后

```typescript
await this.activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, this.host)
// → 仅激活 pluginId 对应的插件
// ✅ 符合 UC-2 语义
```

### 5.5 Hook Chain — 正常

```typescript
// 输入：context = { pluginId: '', hookType: 'onBeforeSendMessage', data: { content: 'Hello' }, timestamp }
// handler-1 (built-in, priority=0): 返回 { proceed: true }
// handler-2 (trusted, priority=100): 返回 { proceed: false, reason: 'Blocked by filter' }
// → 终止链，返回 { blocked: true, reason: 'Blocked by filter', blockedBy: 'plugin-a' }
```

### 5.6 Hook Chain — 超时

```typescript
// handler-1 正常 → handler-2 5s 超时 → 视为放行 → handler-3 执行
// → 最终返回 { blocked: false }
```

---

## 6. 结论

**判决: fail** — 必须修复 4 个缺陷后方可进入下一阶段。

阻断级缺陷 #1 (togglePlugin 激活全部) 和 #2 (bridge tool_execute 参数丢失) 是严重的功能正确性问题，修正后 **所有 8 个 UC 的核心路径应能正常运行**。

建议修复顺序:
1. 缺陷 #2（server.ts `bridge:tool_execute` 分支 `params`→`parameters`）— 3 行改动
2. 缺陷 #1（`togglePlugin` 启用路径改为 `activatePlugin` 单插件）— 1 行改动
3. 缺陷 #3（`initialize()` 热重载注册 + `activatePlugin` 成功时调用 `watchAndReload`）— 约 10 行
4. 缺陷 #4（`approvePermissions` 后恢复激活，需在 `PluginActivator` 增加等待权限→继续激活的状态机）— 需设计
