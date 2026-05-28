---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-28T18:00:00"
  target: "Plugin System Phase 2 — 后端实现（BG1-BG7）"
  verdict: fail
  summary: "BLR 审查完成，第1轮，7条 MUST FIX，需修改后重审。Bridge↔sidecar 集成层大面积 stub，4个业务用例均不能端到端工作。"

statistics:
  total_issues: 13
  must_fix: 7
  must_fix_resolved: 0
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

  - id: 2
    severity: MUST_FIX
    location: "src-electron/runtime/src/server.ts:658-667"
    title: "bridge:tool_execute 是 stub，未路由到 PluginService"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "src-electron/runtime/src/server.ts:680-689"
    title: "bridge:intercept 是 stub，未路由到 PluginService.executeHooks"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:54-80 (initialize)"
    title: "PluginPermissionChecker 从未实例化/加载/调用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-activator.ts:292-327"
    title: "activateWithDeps/topologicalSort/detectCycle 是死代码，activate 路径不检查依赖"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:204-215 (executeHooks)"
    title: "executeHooks broadcast 后忽略 Worker invoke 结果，钩子拦截/注入均不生效"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: MUST_FIX
    location: "src-electron/runtime/src/services/plugin-service/plugin-service.ts:226-232 (handleBridgeToolExecute)"
    title: "handleBridgeToolExecute 用 bare toolName 查找但 registry 使用 ${pluginId}:${name} 作 key"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/plugin-types.ts:365-368"
    title: "InterceptorHookType/ObserverHookType 定义与 hook-api.ts 实际使用的 hook name 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "resources/plugins/goal/src/goal-tool.ts (handleCancelGoal) + goal-hooks.ts"
    title: "pendingMessage 从未被设为非 null，pause/resume 备选路径无效"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "src-electron/runtime/src/server.ts:630-654"
    title: "bridge:sync 未包括 plugService.getToolSchemas() 的运行时工具"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "src-electron/runtime/src/event-adapter.ts:272"
    title: "extension_ui_response 在 event-adapter 中 return null 被丢弃，bridge 响应通过 server.ts 直接处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 12
    severity: INFO
    location: "src-electron/runtime/src/services/plugin-service/api/session-data-api.ts:appendEntry"
    title: "sessionData.set 的 bridge:append_entry 持久化是 no-op，状态仅存内存，sidecar 重启后丢失"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 13
    severity: INFO
    location: "resources/pi/agent/extensions/bridge/index.ts:60-63"
    title: "bridge extension 的 extension_ui_response handler (bridge:append_entry) 是死代码，无人发送该请求"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# BLR 审查报告 v1 — Plugin System Phase 2

## 审查记录
- 审查时间：2026-05-28 18:00
- 审查类型：BLR 业务逻辑审查
- 审查对象：Plugin System Phase 2 后端实现（BG1–BG7）

## 审查范围

| 文件组 | 文件数 | 说明 |
|--------|--------|------|
| plugin-service/ | 21 | 插件系统核心服务 |
| resources/plugins/goal/ | 5 | Goal 内置插件 |
| resources/plugins/todo/ | 4 | Todo 内置插件 |
| resources/pi/agent/extensions/bridge/ | 1 | Pi Bridge 扩展 |
| runtime/src/server.ts | 1 | Bridge 请求路由 |
| runtime/src/event-adapter.ts | 1 | Pi 事件适配层 |

## 一、业务用例覆盖分析

### UC-1: 内置 Goal 插件为 LLM 提供任务追踪

| 步骤 | 实现状态 | 证据 |
|------|---------|------|
| LLM 调用 `goal_manager` tool | ✅ | `goal-tool.ts:createGoalTool()` 注册 10 个 action handler |
| `create_tasks` 拆分任务 | ✅ | `handleCreateTasks()` 验证状态 + 创建任务 |
| `api.sessionData.set()` 持久化 | ✅ | 每个 action 结束后调用 `api.sessionData.set('goal-state', state)` |
| onBeforeAgentStart 注入 steering prompt | ❌ **断路** | hook 注册了 (`goal-hooks.ts:32`)，但结果在 `bridge:intercept` 被 stub 丢弃 (`server.ts:686`) |
| `update_tasks` 标记完成 | ✅ | `handleUpdateTasks()` 验证终态/evidence |

**失败路径**：steering prompt 注入链条断裂

```
Goal onBeforeAgentStart handler → executeHooks broadcast → Worker 执行 → Worker 发 result RPC
  → ❌ plugin.hooks.invoke.result 无注册 handler → ❌ handleBridgeIntercept 返回 {}
  → ❌ bridge:intercept 返回 {} (server.ts L686)
```

结论：Goal 插件的 onBeforeAgentStart hook **正确注册并执行**，但其结果被两层 stub 丢弃（`executeHooks` 不收集结果 + `handleBridgeIntercept` 返回空 + `server.ts bridge:intercept` 返回空），steering prompt 无法注入。

### UC-2: 第三方插件注册自定义 Tool

| 步骤 | 实现状态 | 证据 |
|------|---------|------|
| PluginRegistry 扫描 | ✅ | `plugin-registry.ts` 扫描 3 个目录 |
| PluginActivator 激活 | ✅ | `plugin-activator.ts:handleEvent()` |
| `api.tools.register()` | ✅ | `tool-api.ts` 注册到 `toolRegistry` |
| PluginRPC 接收 | ✅ | `tool-api.ts:registerToolRpcHandlers()` |
| PluginService.syncToolsToBridge() | ✅ | 更新 `bridgeToolSchemas` 数组 |
| Bridge sync loop 拉取 | ⚠️ | bridge extension 每 2s 发 `bridge:sync` ✅ |
| **server.ts bridge:sync 返回** | ❌ **读错源** | 读取 `contributes.tools` 而非 `getToolSchemas()` |
| Bridge 注册代理 tool | ✅ | `api.registerTool()` for each tool |
| LLM 调用代理 tool | ✅ | pi 调用 bridge handler |
| **bridge handler 转发** | ❌ **stub** | `bridge:tool_execute` 返回 `'Tool execution not implemented'` |

**断点**：
1. `server.ts:630` `bridge:sync` 读 `contributes.tools`，Goal/Todo 的 manifest 无 contributes.tools（运行时注册）
2. `server.ts:663` `bridge:tool_execute` 是 TODO stub，未路由到 `PluginService.handleBridgeToolExecute()`

结论：即使 bridge:sync 正确拉取，bridge:tool_execute 也是 stub，工具执行永远失败。

### UC-3: 插件拦截消息发送

| 步骤 | 实现状态 | 证据 |
|------|---------|------|
| Hook 注册 | ✅ | `hook-api.ts` 支持 5 种 hook |
| Hook 执行管道 | ❌ **无结果收集** | `executeHooks()` 仅 broadcast，忽略 invoke result |
| `handleBridgeIntercept` | ❌ **始终返回空** | 不收集 worker 注入消息 |
| `server.ts bridge:intercept` | ❌ **stub** | 不调用 PluginService |

结论：消息拦截和 onBeforeAgentStart 注入都不可用。

### UC-4: 插件依赖安装检查

| 步骤 | 实现状态 | 证据 |
|------|---------|------|
| Manifest 解析 extensionDependencies | ✅ | `plugin-types.ts` 定义字段，`plugin-registry.ts` 解析 |
| 依赖缺失检测 | ❌ **死代码** | `activateWithDeps()` 含缺失检查但从未调用 |
| 拓扑排序 | ❌ **死代码** | `topologicalSort()` 实现正确但未接入 |
| 循环依赖检测 | ❌ **死代码** | `detectCycle()` 未调用 |
| DEPS_MISSING 标记 | ❌ | 未触发 |

## 二、权限检查流程分析

**设计规格**：

| 插件类型 | check() 行为 |
|---------|-------------|
| built-in | 始终 true（信任） |
| trusted | 始终 true（信任） |
| sandbox | 检查 granted map |

**实际状态**：`PluginPermissionChecker` 类完整编写（`plugin-permission.ts`），**但从未在 `PluginService.initialize()` 中实例化**：

```typescript
// plugin-service.ts:initialize() — 缺少：
// const permissionChecker = new PluginPermissionChecker(this.registry)
// await permissionChecker.load()
```

- PluginRPC dispatch (`plugin-rpc-server.ts`) 也不调用 `check()`
- `PermissionConstants` 定义正确但无人引用
- `permissions.json` 的 load/save 实现正确但无人调用

**结论**：权限检查层是完整的死代码——类结构全部实现，但在服务端未接入任何调用点。

## 三、Pi Bridge 执行流程分析

### 状态机完整性

Bridge 有三种状态：`Disconnected → Syncing → Ready`。

```typescript
// bridge/index.ts
syncAttempts++ / MAX_SYNC_ATTEMPTS=30 → 60s 超时断连
bridgeState: 'Disconnected' | 'Syncing' | 'Ready'
```

**问题**：Bridge 没有错误恢复机制。一旦进入 `Ready` 后侧边服务断连，bridge 卡在 Ready 但实际不可用。sync loop 的 `clearInterval` 只在 `Ready` 或达到 MAX_SYNC_ATTEMPTS 时调用。断连后不会重试。

### 数据流完整路径

```
LLM tool_call → pi → bridge registerTool handler
  → send bridge:tool_execute via extension_ui_request
    → event-adapter.ts (startsWith 'bridge:') → onBridgeUIRequest callback
      → server.ts handleBridgeRequest('bridge:tool_execute')
        → ❌ STUB: 返回 "Tool execution not implemented"
```

`server.ts` 的 `bridge:tool_execute` case 注释为 `TODO (Phase 2 BG4)`，未连接到 `PluginService.handleBridgeToolExecute()`。

即使连接上，`handleBridgeToolExecute` 也有工具 key 格式不匹配：
- Bridge 发送 `toolName: tool.name`（bare name）
- Registry 存储 `toolKey = "${pluginId}:${name}"`（prefixed key）
- 两者不匹配，`toolRegistry.get(toolName)` → `undefined`

### Bridge 事件转发

Bridge 注册了 11 个 pi 事件的 listener，通过 `bridge:event` / `bridge:intercept` 转发：

| 事件 | 转发方式 | 实际处理 |
|------|---------|---------|
| `before_agent_start` | `bridge:intercept` | ❌ stub |
| `agent_start/end` | `bridge:event` | ❌ stub（仅 console.log） |
| `tool_call/result` | `bridge:event` | ❌ stub |
| `turn_end/message_end` | `bridge:event` | ❌ stub |
| `session_start/compact/tree` | `bridge:event` | ❌ stub |

`server.ts` 的 `bridge:event` handler 仅打了 log，未转发到 `PluginService.handleBridgeEvent()`。

## 四、Goal/Todo 插件状态管理

### Goal 状态完整性

所有状态变更路径：

| 操作 | 更新字段 | 持久化 |
|------|---------|--------|
| create_tasks | `tasks`, `nextTaskId` | ✅ sessionData.set |
| add_tasks | `tasks`, `nextTaskId` | ✅ sessionData.set |
| update_tasks | `tasks[].status/evidence` | ✅ sessionData.set |
| complete_goal | `goal=null`, `pendingMessage=null` | ✅ sessionData.set |
| cancel_goal | 重置全部状态 | ✅ sessionData.set |
| report_blocked | 仅返回文本，不更新状态 | ⚠️ 不修改 state |
| add_sub_todos | `tasks[].subTodos` | ✅ sessionData.set |
| update_sub_todos | `tasks[].subTodos[].status` | ✅ sessionData.set |
| delete_sub_todos | `tasks[].subTodos` | ✅ sessionData.set |

**业务逻辑验证点**：

1. ✅ `handleCreateTasks()` 阻止已有未完成任务时重复创建（防止 LLM 错误覆盖）
2. ✅ `handleUpdateTasks()` 检查重复 taskId、终态不可变更、completed 必须带 evidence
3. ✅ `handleCompleteGoal()` 要求所有任务完成或说明跳过原因
4. ✅ `handleAddSubTodos()` 阻止向已终态任务添加 sub-todo
5. ❌ **pendingMessage 从未被设值**：Goal 的暂停/恢复备选路径依赖 `pendingMessage` 字段，但没有代码将其设为非 null。`onBeforeAgentStart` 检查 pendingMessage 的分支永远不会执行。

### Todo 状态完整性

| 操作 | 更新字段 | 持久化 |
|------|---------|--------|
| list | 只读 | — |
| add | `todos`, `nextId` | ✅ sessionData.set |
| update | `todo.status/text` | ✅ sessionData.set |
| delete | `todos` | ✅ sessionData.set |
| clear | `todos=[], nextId=1` | ✅ sessionData.set |

✅ Todo 有 `session_start` handler 恢复状态（`todo-tool.ts:restoreTodoState()`）
❌ Goal 没有 `session_start` handler——但因为 Goal 每次操作都从 sessionData 重新加载，恢复是隐式的

## 五、集成验证

### 工具注册 → sync → bridge 注册 → 执行（关键路径）

```
Step 1: Plugin calls api.tools.register({name: 'goal_manager', ...})
        → toolRegistry.set('goal:goal_manager', entry)    ✓
        → syncToolsToBridge() → bridgeToolSchemas 更新       ✓

Step 2: Bridge sync loop → bridge:sync request
        → server.ts reads contributes.tools (不是 getToolSchemas())
        → Goal/Todo manifest 没有 contributes.tools
        → ❌ goal_manager/todo 工具不在 sync 响应中

即使修正 Step 2:
Step 3: Bridge calls api.registerTool('goal_manager', ..., handler)
Step 4: LLM calls goal_manager → Bridge handler → bridge:tool_execute request
Step 5: server.ts → ❌ STUB ("not implemented")

即使修正 Step 5:
Step 6: handleBridgeToolExecute({toolName: 'goal_manager'})
        → toolRegistry.get('goal_manager') → ❌ key是 'goal:goal_manager'
```

**结论**：该路径有三层故障，任意一层阻断都会导致功能不可用。

### 钩子触发到产出（关键路径）

```
Step 1: pi emits before_agent_start event
Step 2: Bridge listener → bridge:intercept request
Step 3: server.ts → ❌ STUB (returns {})
        → 不调用 PluginService.executeHooks()
        → Goal hook 从未执行

即使修正 Step 3:
Step 4: executeHooks('onBeforeAgentStart', context)
        → broadcast to all workers ✓
        → Worker hook handler runs ✓
        → Worker sends plugin.hooks.invoke.result RPC →
        → ❌ 无 handler 注册，结果丢弃
Step 5: handleBridgeIntercept() → ❌ 总是返回 {injectedMessages: []}
```

**结论**：钩子注入路径有两层故障。

## 六、模拟业务数据执行路径

供后续 integration review 消费。使用 Goal plugin 的 `goal_manager` 工具的完整业务路径：

```
=== 场景: LLM 为用户创建和管理一个目标 ===

[precondition] Goal plugin (built-in, trusted) → PluginRegistry scans → 
  PluginActivator.activatePlugin('goal', ...) → Worker loads → activate() called →
  createGoalTool() → api.tools.register({name:'goal_manager', ...}) → 
  PluginRPC → toolRegistry.set('goal:goal_manager', ...) → syncToolsToBridge()

=== 断路 1: bridge:sync 读错源 ===
  step工具 注册到 toolRegistry，但 server.ts bridge:sync 只读 contributes.tools
  → Bridge 注册代理 tool 的行为不会发生

  [如果修复] Bridge 注册代理 tool → pi.registerTool('goal_manager', ...)
  → LLM 在 function_call 中看到 goal_manager 工具

=== 断路 2: bridge:tool_execute 是 stub ===
  LLM 调用 goal_manager({action:'create_tasks', tasks:[...]})
  → pi → Bridge handler → extension_ui_request({method:'bridge:tool_execute',
    toolName:'goal_manager', params:{action:'create_tasks',...}})
  → server.ts → ❌ "Tool execution not implemented"

  [如果修复] server.ts → PluginService.handleBridgeToolExecute()
  → toolRegistry.get('goal_manager') → ❌ key 是 'goal:goal_manager'
  → 返回 {success: false, error: 'Tool not found: goal_manager'}

  [如果修复 key 匹配] toolRegistry.get('goal:goal_manager')
  → entry found → ... (stub implementation: returns {success: true, result: {}})
  
=== 断路 3: onBeforeAgentStart 注入断路 ===
  第2轮 LLM 调用开始前，pi 触发 before_agent_start
  → Bridge → bridge:intercept({eventName:'before_agent_start',...})
  → server.ts → ❌ STUB 返回空

  [如果修复] server.ts → PluginService.handleBridgeIntercept()
  → executeHooks('before_agent_start', ...)
  → broadcast → Worker goal hook → {injectedMessages: [steeringPrompt]}
  → Worker 发 plugin.hooks.invoke.result
  → ❌ 无 handler → 结果丢弃
  → handleBridgeIntercept 返回未聚合的 {injectedMessages: []}
  
=== 断路 4: sessionData.set 无持久化 ===
  handleCreateTasks → api.sessionData.set('goal-state', state)
  → session-data-api.ts set handler:
    → 更新内存缓存 ✓
    → appendEntry (no-op) → ❌ 未持久化到 pi session
  
  sidecar 重启后 → sessionDataCache 为空
  → api.sessionData.get('goal-state') → undefined → goal 任务丢失

=== 结果 ===
  当前代码: LLM 调 goal_manager → "Tool execution not implemented"
  steering prompt: 永远不会注入
  sessionData: 仅内存，重启丢失
```

## 七、已发现的问题

| # | 优先级 | 文件/位置 | 描述 | 影响 UC |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `server.ts:630-654` | `bridge:sync` 读取 manifest `contributes.tools` 而非 `PluginService.getToolSchemas()`，运行时注册的工具(goal_manager/todo)不会被同步到 bridge | UC-1, UC-2 |
| 2 | MUST FIX | `server.ts:658-667` | `bridge:tool_execute` 是 TODO stub (`"Tool execution not implemented"`)，未路由到 `PluginService.handleBridgeToolExecute()` | UC-1, UC-2 |
| 3 | MUST FIX | `server.ts:680-689` | `bridge:intercept` 是 stub 返回 `{}`，`before_agent_start` 事件不触发 executeHooks，steering prompt 不能注入 | UC-1, UC-3 |
| 4 | MUST FIX | `plugin-service.ts:initialize()` | `PluginPermissionChecker` 从未实例化/加载/调用，权限检查层全部死代码 | UC-2 |
| 5 | MUST FIX | `plugin-activator.ts:292-327` | `activateWithDeps/topologicalSort/detectCycle` 是死代码，`PluginService.initialize()` 走 `handleEvent()` 逐个激活，不检查 `extensionDependencies` | UC-4 |
| 6 | MUST FIX | `plugin-service.ts:executeHooks()` | `executeHooks()` broadcast 后忽略 Worker 的 invoke 结果（无 `plugin.hooks.invoke.result` handler），hook 拦截/注入均不生效 | UC-1, UC-3 |
| 7 | MUST FIX | `plugin-service.ts:handleBridgeToolExecute()` | 用 bare `toolName` 作为 key 查 `toolRegistry`，但 registry 使用 `${pluginId}:${name}` 作 key，查找永远失败 | UC-1, UC-2 |
| 8 | LOW | `plugin-types.ts:365-368` | `InterceptorHookType`/`ObserverHookType` 定义（`onToolCall`/`onSlashCommand`/`onMessageSend`）与 `hook-api.ts` 实际 hook name 字符串（`onBeforeSendMessage`/`onBeforeToolCall`）不一致 | code hygiene |
| 9 | LOW | `goal-tool.ts:handleCancelGoal()` + `goal-hooks.ts` | `pendingMessage` 从未被设为非 null，pause/resume 备选路径不生效；`handleCancelGoal` 清空 state 但 `pendingMessage` 字段已为 null | UC-1 备选 |
| 10 | LOW | `server.ts:bridge:sync` | 即便修复读源问题，也需考虑合并 `contributes.tools`（静态）+ `getToolSchemas()`（动态）两套工具集合 | UC-2 |
| 11 | INFO | `event-adapter.ts:272` | `extension_ui_response` 在 event-adapter 中 return null 被丢弃——这是预期行为（bridge 响应由 server.ts 直接处理），但需注意不与其他 extension 响应冲突 | architecture |
| 12 | INFO | `session-data-api.ts:appendEntry` | sessionData.set 的 bridge:append_entry 持久化是 no-op，数据仅存内存缓存，sidecar 重启后全部丢失。Phase 2 末期需实现 | UC-1 |
| 13 | INFO | `bridge/index.ts:60-63` | `extension_ui_response` handler 处理 `bridge:append_entry` 但无人触发该请求——sidecar 未发送 bridge:append_entry 请求 | UC-1 |

## 八、修改方向

### MUST FIX 修复顺序（按依赖关系）

```
Round 1: server.ts 集成层
  [MF-1] bridge:sync: 合并 contributes.tools + PluginService.getToolSchemas()
  [MF-2] bridge:tool_execute: 路由到 PluginService.handleBridgeToolExecute()
  [MF-3] bridge:intercept: 路由到 PluginService.handleBridgeIntercept()
  [MF-6] executeHooks: 注册 plugin.hooks.invoke.result handler，收集 Worker 结果
  [MF-7] handleBridgeToolExecute: 用工具名遍历 registry 匹配而非 full key

Round 2: 基础设施
  [MF-4] PluginService.initialize(): 实例化 PermissionChecker，加载权限
  [MF-5] PluginService.initialize(): 改用 activateWithDeps(descriptors) 替代 handleEvent

Round 3: 非关键修复
  [LOW-8/LOW-9/LOW-10] 类型对齐 + pendingMessage 逻辑
```

## 九、结论

**verdict: fail** — 7 条 MUST FIX，当前代码存在多处断路，所有 4 个业务用例均无法端到端工作。

核心问题集中在一层：**server.ts 的 bridge 路由层**——`bridge:sync`, `bridge:tool_execute`, `bridge:intercept` 都是 stub，导致 plugin-service 和 Bridge extension 之间的链路完全中断。权限检查和依赖检查作为独立模块实现完整但未接入。需要至少一轮修复后重新评审。
