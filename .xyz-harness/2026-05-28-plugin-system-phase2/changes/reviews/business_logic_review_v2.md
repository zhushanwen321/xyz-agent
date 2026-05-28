---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-28"
  target: "Plugin System Phase 2 — 后端实现（BG1-BG7）"
  verdict: fail
  summary: "BLR 第2轮审查完成。7 条 MUST FIX 中仅 1 条（MF-4 PermissionChecker 实例化）修复，其余 6 条未修复。新增 1 条 STRUCTURAL 问题：bridge 相关方法未在 IPluginService 接口暴露，server.ts 无法调用。加总：7 条 MUST FIX 未修复 + 1 条新增 STRUCTURAL = 8 条待修复。"

statistics:
  total_issues: 14
  must_fix: 8
  must_fix_resolved: 1
  low: 3
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "src-electron/runtime/src/server.ts:630-654"
    title: "bridge:sync 读取 manifest contributes.tools 而非运行时 toolRegistry"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    v2_note: "未修复。仍读 plugin.contributes?.tools，未调用 this.pluginService?.getToolSchemas()"

  - id: 2
    severity: MUST_FIX
    location: "src-electron/runtime/src/server.ts:658-667"
    title: "bridge:tool_execute 是 stub，未路由到 PluginService"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    v2_note: "未修复。仍返回 'Tool execution not implemented'。且 handleBridgeToolExecute 不在 IPluginService 接口中，无法通过接口调用"

  - id: 3
    severity: MUST_FIX
    location: "src-electron/runtime/src/server.ts:680-689"
    title: "bridge:intercept 是 stub，未路由到 PluginService"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    v2_note: "未修复。仍返回 {}，未调用 PluginService.handleBridgeIntercept()"

  - id: 4
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:47-71"
    title: "PluginPermissionChecker 从未被用于检查（已实例化但未调用）"
    status: open
    raised_in_round: 1
    resolved_in_round: 2
    v2_note: "实例化 + load 已完成 ✅。但 checker.check() 未被任何调用者引用（RPC dispatch/tool-api/hook-api 均未调用），属于部分修复——实例化修复完成，调用链未接入"

  - id: 5
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-activator.ts:292-327"
    title: "activateWithDeps/topologicalSort/detectCycle 是死代码"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    v2_note: "未修复。initialize() 仍走 handleEvent 逐个激活，不检查 extensionDependencies"

  - id: 6
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:204-215 (executeHooks)"
    title: "executeHooks broadcast 后忽略 Worker invoke 结果"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    v2_note: "未修复。broadcast 后立即返回 { blocked: false }，不等待 Worker 响应"

  - id: 7
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:226-232 (handleBridgeToolExecute)"
    title: "handleBridgeToolExecute 用 bare toolName 查找但 registry 使用 ${pluginId}:${name} 作 key"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    v2_note: "未修复。但 bridge:tool_execute 仍然是 stub（MF-2），该 bug 尚未暴露"

  - id: 8
    severity: STRUCTURAL
    location: "src-electron/runtime/src/server.ts + interfaces.ts"
    title: "bridge 操作方法未在 IPluginService 接口暴露，server.ts 无法调用"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    v2_note: "handleBridgeToolExecute/handleBridgeIntercept/handleBridgeEvent/syncToolsToBridge/getToolSchemas 方法定义在 PluginService class 上但不在 IPluginService 接口中。server.ts 的 this.pluginService 类型为 IPluginService，能调用的只有 4 个方法（initialize/getDiscoveredPlugins/togglePlugin/shutdown）。即使 server.ts 想路由 bridge 请求到 PluginService，也无法通过接口调用 bridge 相关方法。需要在 IPluginService 中添加这些方法签名，或在 server.ts 中做类型窄化"

  - id: 9
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-types.ts:365-368"
    title: "InterceptorHookType/ObserverHookType 定义与 hook-api.ts 实际使用的 hook name 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "resources/plugins/goal/src/goal-tool.ts (handleCancelGoal) + goal-hooks.ts"
    title: "pendingMessage 从未被设为非 null，pause/resume 备选路径无效"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: LOW
    location: "src-electron/runtime/src/server.ts:bridge:sync"
    title: "sync 未包括 getToolSchemas() 的运行时工具（即使修复读源，还需考虑合并两套）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 12
    severity: INFO
    location: "src-electron/runtime/src/event-adapter.ts:272"
    title: "extension_ui_response 在 event-adapter 中 return null 被丢弃"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 13
    severity: INFO
    location: "src-electron/runtime/src/services/plugin-service/api/session-data-api.ts:appendEntry"
    title: "sessionData.set 的 bridge:append_entry 持久化是 no-op"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 14
    severity: INFO
    location: "resources/pi/agent/extensions/bridge/index.ts:60-63"
    title: "bridge extension 的 extension_ui_response handler (bridge:append_entry) 是死代码"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# BLR 审查报告 v2 — Plugin System Phase 2

## 审查记录
- 审查时间：2026-05-28
- 审查类型：BLR 第2轮审查（修复验证）
- 审查对象：Plugin System Phase 2 后端实现（BG1–BG7）
- 审查依据：第1轮报告 7 条 MUST FIX 修复情况

## 修复验证

### [MF-4] PluginPermissionChecker 实例化 ✅ 部分修复

从 V1 的「从未实例化」变为**已实例化但未使用**：

```typescript
// constructor 实例化 ✅
this.permissionChecker = new PermissionChecker(registry)

// initialize() 加载 ✅
await this.permissionChecker.load()
```

**但 checker.check() 从不被调用**：

| 潜在调用点 | 是否调用 check() | 证据 |
|-----------|----------------|------|
| `plugin-rpc-server.ts:dispatch()` | ❌ | 直接执行 handler，无任何权限检查 |
| `tool-api.ts:registerToolRpcHandlers()` | ❌ | 无 permissionChecker 引用 |
| `hook-api.ts:registerHookRpcHandlers()` | ❌ | 无 permissionChecker 引用 |
| `session-api.ts` | ❌ | 无 permissionChecker 引用 |

**结论**：`PluginPermissionChecker` 实例化修复完成，但权限检查层仍然是**功能上的死代码**。需要将 `check()` 接入 RPC dispatch 路径才算真正修复。

### [MF-1] bridge:sync 读错源 ❌ 未修复

`server.ts:630-654` 的 `bridge:sync` handler 仍然：

```typescript
const plugins = this.pluginService.getDiscoveredPlugins()
for (const plugin of plugins) {
  if (plugin.contributes?.tools) {     // ← 仍读静态 manifest
    // ...
  }
}
```

应该改为读取 `this.pluginService.getToolSchemas()`（或合并两套来源），但 `getToolSchemas()` **不在 IPluginService 接口中**（见新增 STRUCTURAL issue）。

### [MF-2] bridge:tool_execute 未路由 ❌ 未修复

`server.ts:662-667` 仍然是：
```typescript
await client.sendCommand('extension_ui_response', {
  id: requestId,
  response: { content: 'Tool execution not implemented', isError: true }
})
```
注释 `TODO (Phase 2 BG4)` 未消除。

`PluginService.handleBridgeToolExecute()` 方法已实现，但它 **不在 IPluginService 接口中**，server.ts 无法通过 `this.pluginService.handleBridgeToolExecute(...)` 调用（TypeScript 编译错误）。

### [MF-3] bridge:intercept 未路由 ❌ 未修复

`server.ts:680-689` 仍然是 stub：
```typescript
if (this.pluginService && eventName === 'before_agent_start') {
  // TODO (Phase 2 BG4)
  await client.sendCommand('extension_ui_response', { id: requestId, response: {} })
  return
}
```

`PluginService.handleBridgeIntercept()` 已实现，但同样**不在 IPluginService 接口中**。

### [MF-5] activateWithDeps/topologicalSort 死代码 ❌ 未修复

`plugin-service.ts:initialize()` 仍然直接调用 `activator.handleEvent()`，未改用 `activateWithDeps()`。依赖安装检查从未触发。

### [MF-6] executeHooks 忽略 Worker 结果 ❌ 未修复

`executeHooks()` 的 `broadcast` 后立即返回 `{ blocked: false }`。没有注册 `plugin.hooks.invoke.result` 的 handler，Worker 的 hook 执行结果全部丢弃。

### [MF-7] handleBridgeToolExecute key 不匹配 ❌ 未修复

`handleBridgeToolExecute()` 中使用 `this.toolRegistry.get(request.toolName)`（bare name），但 registry key 是 `${pluginId}:${name}`。该 bug 目前被 MF-2 掩盖（bridge 请求从未到达此方法）。

## 新增 STRUCTURAL 问题

### [MF-8] IPluginService 接口缺少 bridge 操作方法

`interfaces.ts` 中定义的 `IPluginService` 仅有 4 个方法：

```typescript
export interface IPluginService {
  initialize(): Promise<void>
  getDiscoveredPlugins(): PluginDescriptor[]
  togglePlugin(pluginId: string, enabled: boolean): Promise<PluginDescriptor[]>
  shutdown(): Promise<void>
}
```

`PluginService` 类额外实现了 5 个 bridge 相关方法：
- `getToolSchemas()`
- `handleBridgeToolExecute()`
- `handleBridgeIntercept()`
- `handleBridgeEvent()`
- `syncToolsToBridge()`

**但这 5 个方法不在接口中**。`SidecarServer` 通过 `setServices()` 持有 `IPluginService` 类型引用，调不了 bridge 方法。

**修复方向**：将 5 个 bridge 方法签名加入 `IPluginService` 接口。

## V1 未修复问题汇总

| # | 类型 | 文件名 | 问题 | V1 状态 | V2 状态 |
|---|------|--------|------|---------|---------|
| 1 | MUST_FIX | server.ts | bridge:sync 读错源 | open | **open** |
| 2 | MUST_FIX | server.ts | bridge:tool_execute stub | open | **open** |
| 3 | MUST_FIX | server.ts | bridge:intercept stub | open | **open** |
| 4 | MUST_FIX | plugin-service.ts | PermissionChecker 实例化 | open | **➡ 部分修复（实例化完成，未接入调用）** |
| 5 | MUST_FIX | plugin-activator.ts | 依赖检查死代码 | open | **open** |
| 6 | MUST_FIX | plugin-service.ts | executeHooks 忽略结果 | open | **open** |
| 7 | MUST_FIX | plugin-service.ts | handleBridgeToolExecute key 不匹配 | open | **open（被 MF-2 掩盖）** |
| **8** | **STRUCTURAL** | **interfaces.ts** | **bridge 方法未在接口暴露** | **新增** | **open** |

## 关键数据流验证

### 数据流：工具注册 → sync → bridge → 执行

```
Plugin api.tools.register → toolRegistry.set('goal:goal_manager') ✅
  → syncToolsToBridge() ✓
  → bridgeToolSchemas 已包含 goal_manager

Bridge sync loop → bridge:sync →
  server.ts → ❌ 读 contributes.tools（空）
  → Goal/Todo 工具仍不被 bridge 感知
```

仍断路在 server.ts，`getToolSchemas()` 不被调用。

### 数据流：触发钩子 → bridge:intercept → executeHooks → 注入

```
pi before_agent_start → Bridge → bridge:intercept →
  server.ts → ❌ stub 返回 {}
  → handleBridgeIntercept() 不被调用
  → executeHooks() 不被调用
  → Goal hook 不执行
  → steering prompt 不注入
```

仍断路在 server.ts。

## 模拟业务路径验证（与 V1 对比无变化）

```
=== LLM 调用 goal_manager ===
第 1 轮: "Tool execution not implemented"
第 2 轮: "Tool execution not implemented" ← 无变化

=== before_agent_start 注入 ===
第 1 轮: steering prompt 不注入
第 2 轮: steering prompt 不注入 ← 无变化
```

## 结论

**verdict: fail** — 7 条 MUST FIX 中仅 1 条部分修复（MF-4），其余 6 条完全未动。新增 1 条 STRUCTURAL 问题（MF-8: IPluginService 接口缺失 bridge 方法）。总计 **8 条待修复**，全部 4 个业务用例（UC-1~UC-4）仍然断路。

核心阻塞点仍集中在 `server.ts` 的 bridge 路由层——`bridge:sync`, `bridge:tool_execute`, `bridge:intercept` 三个 handler 全部是 stub，且 `IPluginService` 接口未暴露 bridge 方法导致无法接入。需要同时修复 `interfaces.ts` + `server.ts` 才能打通链路。

### MUST FIX 修复建议顺序

```
Round 2a（server.ts + interfaces.ts 打通链路）:
  [MF-8] IPluginService 添加 bridge 方法签名
  [MF-1] bridge:sync 改用 getToolSchemas()
  [MF-2] bridge:tool_execute 路由到 handleBridgeToolExecute()
  [MF-3] bridge:intercept 路由到 handleBridgeIntercept()

Round 2b（PluginService 内部完善）:
  [MF-6] executeHooks 收集 Worker invoke 结果
  [MF-7] handleBridgeToolExecute 修复 key 匹配
  [MF-4] RPC dispatch 层接入 permissionChecker.check()

Round 2c（依赖检查）:
  [MF-5] initialize() 改用 activateWithDeps()
```

当前代码的 `bridgeToolSchemas` 数据已被正确填充（`syncToolsToBridge()` 在每次工具注册后调用），`handleBridgeToolExecute/handleBridgeIntercept` 方法也已骨架实现——**数据层+逻辑层就绪，仅路由层（server.ts + IPluginService 接口）未连接**。
