---
verdict: pass
---

# Plugin System Phase 2 — 后端详细设计

本文档覆盖 plan.md 中 BG1–BG7 的后端实现细节。每个 section 包含数据流图、关键接口签名和错误处理路径。

---

## §1 Plugin Foundation (BG1: Task 1–3)

### 1.1 类型扩展

`plugin-types.ts` 新增：

```typescript
// 插件来源
export type PluginSource = 'built-in' | 'external'

// PluginState 扩展
export type PluginState =
  | 'UNLOADED' | 'LOADING' | 'ACTIVATING' | 'ACTIVE'
  | 'DEACTIVATING' | 'CRASHED' | 'DEPS_MISSING'

// Manifest 扩展
export interface XyzAgentManifest {
  manifestVersion: 1
  main: string
  activationEvents: string[]
  trustLevel?: 'trusted' | 'sandbox'
  permissions?: string[]
  source?: PluginSource              // 新增，默认 'external'
  extensionDependencies?: string[]   // 新增，格式 "pluginId@semverRange"
  contributes?: PluginContributes
}

// Descriptor 扩展
export interface PluginDescriptor {
  // ... 现有字段
  source: PluginSource               // 新增，扫描时填充
  extensionDependencies: string[]    // 新增
}
```

`PluginDescriptor.source` 不允许 `undefined`——`PluginRegistry.scan()` 扫描内置路径时标记 `'built-in'`，外部路径标记 `'external'`。

### 1.2 Sandbox Require 拦截

在 Worker bootstrap 脚本中，trusted Worker 保持不变；sandbox Worker 执行以下初始化：

```typescript
// sandbox 拦截规则
interface SandboxConfig {
  allowedPrefixes: string[]    // [pluginDir, pluginDir + '/node_modules']
  blockedBuiltins: string[]    // ['fs','child_process','os','net','http','https',
                               //  'crypto','dgram','cluster','worker_threads']
}
```

**拦截机制**：覆盖 `Module._resolveFilename`。原始函数保存为 `_originalResolveFilename`，新函数执行拦截逻辑后调用原始实现。

**判断流程**：

```
require(moduleName)
  → _resolveFilename 拦截
    → 是相对路径（./  ../）？
        → 解析为绝对路径，检查是否在 pluginDir 下
            → 是：放行，调用 _originalResolveFilename
            → 否：throw PERMISSION_DENIED
    → 是 npm 包名？
        → 在 blockedBuiltins 中？
            → 是：throw PERMISSION_DENIED
        → 解析结果在 pluginDir/node_modules 下？
            → 是：放行
            → 否：throw PERMISSION_DENIED
```

**错误路径**：拦截时 throw 带 `code: 'PERMISSION_DENIED'` 和 `message: 'Sandbox: require("${moduleName}") is not allowed'`。PluginHost 的 crash callback 捕获 uncaught exception 并标记 Worker crashed。

`process.env` 替换为空 Proxy（`new Proxy({}, { get: () => undefined })`），阻止环境变量泄露。

### 1.3 PermissionChecker

```typescript
class PermissionChecker {
  // 权限映射：pluginId → 已授权的 permission 集合
  private granted: Map<string, Set<string>>
  // 权限 → 允许调用的 RPC method 前缀
  private static PERMISSION_METHOD_MAP: Map<string, string[]>

  check(pluginId: string, method: string): boolean
  grant(pluginId: string, permissions: string[]): void
  revoke(pluginId: string): void
  load(): Promise<void>   // 读 ~/.xyz-agent/plugins/permissions.json
  save(): Promise<void>   // 写 ~/.xyz-agent/plugins/permissions.json
}
```

**权限映射策略**：

| 插件分类 | 行为 |
|---------|------|
| built-in | `check()` 始终返回 `true`，跳过映射表查询 |
| trusted | `check()` 始终返回 `true` |
| sandbox（外部） | 零默认信任，`check()` 查 `granted` map，无匹配返回 `false` |

**数据流**：

```
PluginRegistry.scan()
  → 产出 PluginDescriptor[]（含 source 字段）
  → PluginService.initialize()
    → PermissionChecker.load()
    → PluginActivator.registerDescriptors(descriptors)
    → 对每个 descriptor 初始化 PermissionChecker：
        built-in/trusted → grant all
        sandbox → 仅加载已持久化的权限
```

**关键错误路径**：
- PluginRPC dispatch 在执行 handler 前调用 `permissionChecker.check(pluginId, method)`
- `check()` 返回 `false` → 返回 `{error: {code: -32001, message: 'PERMISSION_DENIED'}}`
- `permissions.json` 不存在 → `load()` 初始化空 map，不报错

---

## §2 AgentAPI Tools + Hooks (BG2: Task 4)

### 2.1 Tool Register 流程

```typescript
// Worker 侧代理对象
interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  handler: (params: Record<string, unknown>) => Promise<ToolResult>
}

interface ToolResult {
  content: string
  isError?: boolean
}
```

**数据流**：

```
Worker: api.tools.register(tool)
  → JSON-RPC: {method: 'plugin.tools.register', params: {name, description, parameters}}
    → PluginRPC.tool_register handler
      → 验证 name 唯一性（全局 toolRegistry 查重）
      → 记录到 PluginService.toolRegistry: Map<toolKey, {pluginId, handlerId, schema}>
      → 返回 toolKey 给 Worker
      → 调用 syncToolsToBridge()
        → 通知 Bridge 重新同步 tool 列表
```

`syncToolsToBridge()` 触发条件：tool register / unregister / 插件激活 / 插件停用。Bridge 不在 Ready 状态时该调用为 no-op，等待 Bridge 下次主动 `bridge:sync` 时获取全量。

**错误路径**：
- tool name 重复 → 返回 `TOOL_NAME_CONFLICT` 错误码
- Bridge 未连接 → `syncToolsToBridge()` no-op，不报错

### 2.2 Hook 类型分类

```typescript
// 可拦截 hooks — handler 可返回控制指令
type InterceptorHookType = 'message:beforeSend' | 'tool:beforeCall' | 'agent:beforeStart'

// 只读 hooks — handler 只接收 data，无返回值
type ObserverHookType =
  | 'tool:afterResult'
  | 'pi:agent_start' | 'pi:agent_end'
  | 'pi:tool_call' | 'pi:tool_result'
  | 'pi:turn_end' | 'pi:message_end'
  | 'pi:session_start' | 'pi:session_compact'
  | 'pi:session_tree'

type HookType = InterceptorHookType | ObserverHookType

// 可拦截 hook 返回值
interface InterceptorResult {
  blocked?: boolean
  modifiedContent?: unknown
  injectedMessages?: Array<{role: string; content: string; display?: boolean}>
}
```

**可拦截 vs 只读的区别**：

| 维度 | 可拦截 | 只读 |
|------|--------|------|
| handler 返回值 | `InterceptorResult` | `void` |
| 可阻止操作 | 是（`blocked: true`） | 否 |
| 可修改内容 | 是（`modifiedContent`） | 否 |
| 可注入消息 | 是（`injectedMessages`） | 否 |
| 执行方式 | 串行，handler 链依次执行 | 并行广播 |

### 2.3 Hook Register 流程

```typescript
// Worker 侧代理对象
interface HookAPI {
  onBeforeSendMessage(handler: (ctx: MessageContext) => Promise<InterceptorResult>): Disposable
  onBeforeToolCall(handler: (ctx: ToolCallContext) => Promise<InterceptorResult>): Disposable
  onBeforeAgentStart(handler: (ctx: AgentStartContext) => Promise<InterceptorResult>): Disposable
  onAfterToolResult(handler: (ctx: ToolResultContext) => Promise<void>): Disposable
  onPiEvent(eventName: string, handler: (data: unknown) => Promise<void>): Disposable
}
```

**数据流**：

```
Worker: api.hooks.onBeforeSendMessage(handler)
  → JSON-RPC: {method: 'plugin.hooks.register', params: {hookType: 'message:beforeSend', handlerId}}
    → PluginRPC.hook_register handler
      → PluginService.hookRegistry 记录 {pluginId, handlerId, hookType, priority}
      → 返回 {registered: true}

执行时：
pi event → Bridge → sidecar → PluginService.executeHooks(hookType, context)
  → 按 priority 排序（内置 > trusted > sandbox）
  → 串行对每个 handler：
    → RPC 到对应 Worker: {method: 'plugin.hooks.invoke', params: {handlerId, context}}
    → Worker 内调用 handler(context)
    → 返回 InterceptorResult
  → blocked: true → 终止链，返回
  → 汇总结果返回 Bridge
```

---

## §3 Pi Bridge Extension (BG3: Task 5)

### 3.1 Bridge 架构

Bridge 位于 `resources/pi/agent/extensions/bridge/`，是 pi extension（非 xyz-agent plugin）。它是 xyz-agent 插件系统与 pi 之间的唯一适配层——所有其他模块都是 pi-agnostic 的。

### 3.2 连接状态机

```
┌──────────────┐    bridge:sync 成功    ┌───────────┐
│ Disconnected │ ──────────────────────→ │  Syncing  │
└──────────────┘                        └─────┬─────┘
       ↑                                       │ pi.registerTool() 完成
       │                                       ↓
       │                                 ┌───────────┐
       └── 连接断开 / 同步失败 ←────────  │   Ready   │
                                         └───────────┘
```

**启动序列**：

```
pi 启动 → Bridge extension activate
  → state = Disconnected
  → 启动 syncLoop (setInterval 2s, max 30 次)
    → 发送 extension_ui_request({method: 'bridge:sync'})
    → sidecar 返回 {tools: ToolSchema[], commands: CommandSchema[]}
    → state = Syncing
    → 对每个 tool: pi.registerTool(name, description, parameters, executeHandler)
    → 对每个 command: pi.registerCommand(name, handler)
    → state = Ready
    → clearInterval
```

Bridge Ready 后代理 tool 被调用时：

```
LLM 调用代理 tool → Bridge executeHandler
  → state === Ready ?
      → 是：发 extension_ui_request({method: 'bridge:tool_execute', toolName, toolCallId, params, sessionId})
      → 否：返回 {content: 'plugin system initializing', isError: true}
```

### 3.3 Bridge 协议

所有 Bridge ↔ sidecar 通信复用 `extension_ui_request` / `extension_ui_response` 协议，通过 `method` 字段区分子类型：

| method | 方向 | 请求 | 响应 |
|--------|------|------|------|
| `bridge:sync` | Bridge → sidecar | `{method: 'bridge:sync'}` | `{tools: ToolSchema[], commands: CommandSchema[]}` |
| `bridge:tool_execute` | Bridge → sidecar | `{method, toolName, toolCallId, params, sessionId}` | `{content, isError?}` |
| `bridge:event` | Bridge → sidecar | `{method, eventName, data, sessionId}` | 无响应（单向通知） |
| `bridge:intercept` | Bridge → sidecar | `{method, eventName, data, sessionId}` | `{injectedMessages?}` |
| `bridge:append_entry` | sidecar → Bridge | `{method, type, data, sessionId}` | `{success: boolean}` |

### 3.4 与 server.ts 集成

`server.ts` 的 `extension.ui_response` case 需要扩展，识别 Bridge 子类型：

```
extension.ui_response
  → 解析 msg.payload.result.method
    → 'bridge:sync'      → 路由到 PluginService.syncToolsToBridge()
    → 'bridge:tool_execute' → 路由到 PluginService.handleBridgeToolExecute()
    → 'bridge:intercept' → 路由到 PluginService.executeHooks() + 返回结果
    → 其他 → 走原有 extension.ui_response 逻辑（confirm/select/input）
```

### 3.5 与 event-adapter.ts 集成

`event-adapter.ts` 的 `extension_ui_request` case 需要扩展：

```
extension_ui_request
  → method 以 'bridge:' 开头？
      → 是：识别为 Bridge 协议消息
        → 'bridge:sync'：转发到 server.ts 处理（不弹前端 UI）
        → 'bridge:event'：路由到 PluginService.executeHooks（不弹前端 UI）
        → 'bridge:append_entry'：转发到 server.ts → Bridge 处理
        → 这些 Bridge method 不触发 onExtensionUIRequest timeout
      → 否：走原有 confirm/select/input 逻辑（弹前端 UI）
```

**关键点**：Bridge 的 `extension_ui_request` 不走前端的 `extension.ui_request` UI 弹窗流程，它们是 sidecar 内部路由，需要一个新的处理分支。

---

## §4 AgentAPI Extended (BG4: Task 6)

### 4.1 API 模块总览

| 模块 | RPC method 前缀 | Bridge 依赖 |
|------|----------------|-------------|
| sessions | `plugin.sessions.*` | sendMessage 需 bridge:append_entry |
| config | `plugin.config.*` | 无 |
| sessionData | `plugin.sessionData.*` | 需要 bridge:append_entry |
| ui | `plugin.ui.*` | 需要 extension_ui_request 到前端 |
| agent | `plugin.agent.*` | 无（trusted 专属） |
| workspace | `plugin.workspace.*` | 无 |

### 4.2 关键接口签名

```typescript
// sessions
sessions.list(): Promise<SessionInfo[]>
sessions.get(id: string): Promise<SessionInfo | undefined>
sessions.getActive(): Promise<SessionInfo | undefined>
sessions.sendMessage(params: {sessionId?: string; role: 'user'|'system'; content: string}): Promise<void>
sessions.onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
sessions.onDidDestroySession(handler: (session: SessionInfo) => void): Disposable

// config
config.get(key: string): Promise<unknown>
config.getAll(): Promise<Record<string, unknown>>
config.set(key: string, value: unknown): Promise<void>

// sessionData — per-session KV
sessionData.get(sessionId: string, key: string): Promise<unknown>
sessionData.set(sessionId: string, key: string, value: unknown): Promise<void>
sessionData.delete(sessionId: string, key: string): Promise<void>
sessionData.keys(sessionId: string): Promise<string[]>

// ui
ui.showSelect(title: string, options: string[]): Promise<string | undefined>
ui.showConfirm(title: string, message: string): Promise<boolean>
ui.showInput(title: string, default?: string): Promise<string | undefined>
ui.notify(level: 'info'|'warn'|'error', message: string): Promise<void>
ui.updateStatusBarItem(id: string, text: string): Promise<void>

// agent（trusted 专属）
agent.setModel(model: string): Promise<void>
agent.getModel(): Promise<string>
agent.getThinkingLevel(): Promise<string>
agent.setThinkingLevel(level: string): Promise<void>
agent.getActiveTools(): Promise<string[]>

// workspace
workspace.rootPath: string
workspace.name: string
workspace.findFiles(pattern: string): Promise<string[]>
```

### 4.3 sessionData 完整数据流

sessionData 是 goal/todo 插件的核心依赖。底层通过 bridge:append_entry 走 pi.appendEntry()，数据存储在 pi session 文件中，天然跟随 session 生灭。

```
Worker: api.sessionData.set('goal-state', serializedState)
  → JSON-RPC: {method: 'plugin.sessionData.set', params: {sessionId, key: 'goal-state', value}}
    → PluginRPC.sessionData_set handler
      → sidecar 发 extension_ui_request 到 pi:
          {method: 'bridge:append_entry', type: 'plugin-data', data: {key, value}, sessionId}
        → Bridge 收到后调用 pi.appendEntry({type: 'plugin-data', data: {key, value}})
        → Bridge 返回 {success: true}
      → sidecar 收到响应，返回给 Worker

读取：
Worker: api.sessionData.get('goal-state')
  → JSON-RPC: {method: 'plugin.sessionData.get', params: {sessionId, key}}
    → PluginRPC 从内存缓存读取（sidecar 维护一份 sessionData 的内存 mirror）
    → 返回缓存值或 undefined
```

**内存 mirror 机制**：sidecar 维护 `Map<sessionId, Map<string, unknown>>` 作为 sessionData 缓存。`set` 操作同时更新缓存和写 pi（bridge:append_entry）。`get` 操作直接读缓存，不经过 pi。这避免了每次 get 都走跨进程 RPC。

**错误路径**：
- Bridge 未连接 → sessionData.set 返回 `BRIDGE_NOT_READY` 错误码，缓存不更新
- Bridge 未连接 → sessionData.get 仍可工作（读缓存），但缓存可能过时

---

## §5 Integration + Dependencies (BG5: Task 7)

### 5.1 Hook 执行管道

完整链路（以 `before_agent_start` 事件为例）：

```
1. pi 触发 before_agent_start 事件
2. Bridge 监听 pi.on('before_agent_start', handler)
   → handler 发 extension_ui_request({method: 'bridge:intercept',
       eventName: 'before_agent_start', data: {sessionId, systemPrompt}, sessionId})
3. event-adapter.ts 识别 bridge:intercept，不弹前端 UI
4. server.ts 路由到 PluginService.executeHooks('agent:beforeStart', context)
5. PluginService.executeHooks 执行流程：
   → 从 hookRegistry 取该 hookType 的所有 handler
   → 按 priority 排序：内置(0) → trusted(100) → sandbox(200)
   → 串行执行：
     a. RPC 到 Worker: {method: 'plugin.hooks.invoke', params: {handlerId, context}}
     b. Worker 内调用 handler(context)
     c. 收集 InterceptorResult
     d. 如果 blocked: true → 终止链
6. 汇总 InterceptorResult
   → 如果有 injectedMessages: [{role, content}]
   → 返回给 Bridge
7. Bridge 将 injectedMessages 转发给 pi（在 before_agent_start handler 中修改 context）
```

**handler 异常处理**：单个 handler throw → log error，视为放行（不阻止），继续执行链中下一个 handler。这保证一个插件的 bug 不影响其他插件。

**超时**：每个 handler 执行超时 5s。超时视为放行。可拦截 hook 的 `executeHooks` 总超时 = handler 数量 × 5s。

### 5.2 拓扑排序算法

使用 Kahn's algorithm（BFS 拓扑排序）：

```typescript
// 输入：待激活的 PluginDescriptor[]
// 输出：激活顺序数组
// 异常：检测到循环时 throw CIRCULAR_DEPENDENCY

function topologicalSort(descriptors: PluginDescriptor[]): PluginDescriptor[]
```

**算法步骤**：

```
1. 构建 adjacency list: Map<pluginId, dependentIds[]>
   解析 extensionDependencies 中每个 "pluginId@semverRange"
2. 计算入度: Map<pluginId, inDegree>
3. BFS queue: 入度为 0 的 pluginId 入队
4. 循环出队：
   a. 当前 pluginId 加入结果数组
   b. 对其所有依赖者入度 -1
   c. 入度归零的依赖者入队
5. 结果数组长度 === 输入长度？→ 是：返回排序结果
                              → 否：存在循环，throw CIRCULAR_DEPENDENCY
```

**循环依赖处理**：throw 后，`activateWithDeps` 的 catch 块将所有涉及循环的插件标记为 `DEPS_MISSING`，不激活。涉及的 pluginId 集合 = 输入 pluginId - 结果数组 pluginId。

### 5.3 beforeSend 拦截点

在 `session-service.ts` 的 `sendMessage` 中插入 hook 执行：

```
sendMessage(content, sessionId)
  → PluginService.executeHooks('message:beforeSend', {content, sessionId})
    → hook 返回 blocked: true ?
        → 是：返回 HookBlockedResult，sendMessage 不执行
        → 否：使用 modifiedContent（如果有）替换原 content
  → 继续原有 sendMessage 流程
```

**HookBlockedResult** 结构：

```typescript
interface HookBlockedResult {
  blocked: true
  reason?: string   // 插件提供的阻止原因
  blockedBy: string // pluginId
}
```

前端收到 `HookBlockedResult` 后展示为 assistant 消息：`"消息被插件 ${blockedBy} 拦截：${reason}"`。

---

## §6 Goal Plugin (BG6: Task 8)

### 6.1 原始 pi extension → agentAPI 映射

| 原始 pi API | agentAPI 等价 |
|-------------|--------------|
| `pi.registerTool('goal_manager', ...)` | `api.tools.register({name: 'goal_manager', description, parameters, handler})` |
| `pi.registerCommand('goal', ...)` | `api.slashCommands.register({name: 'goal', description, handler})` |
| `pi.appendEntry('goal-state', data)` | `api.sessionData.set('goal-state', serializedState)` |
| `pi.on('before_agent_start', handler)` | `api.hooks.onBeforeAgentStart(handler)` |
| `pi.on('agent_end', handler)` | `api.hooks.onPiEvent('agent_end', handler)` |
| `pi.on('agent_start', handler)` | `api.hooks.onPiEvent('agent_start', handler)` |
| `pi.on('turn_end', handler)` | `api.hooks.onPiEvent('turn_end', handler)` |
| `pi.on('message_end', handler)` | `api.hooks.onPiEvent('message_end', handler)` |
| `pi.on('session_start', handler)` | `api.hooks.onPiEvent('session_start', handler)` |
| `ctx.sessionManager.getEntries()` | `api.sessionData.get('goal-state')` |

### 6.2 goal_manager Tool 注册

10 个 action 复用原始 extension 的 `GoalManagerParams` schema：

```typescript
api.tools.register({
  name: 'goal_manager',
  description: 'Goal mode task manager...',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create_tasks', 'add_tasks', 'update_tasks', 'list_tasks',
               'complete_goal', 'cancel_goal', 'report_blocked',
               'add_sub_todos', 'update_sub_todos', 'delete_sub_todos']
      },
      // ... 其余参数与原始 GoalManagerParams 完全一致
    },
    required: ['action']
  },
  handler: async (params) => { /* 路由到对应 action handler */ }
})
```

### 6.3 onBeforeAgentStart Hook

这是 goal 插件的核心 hook，用于在每次 LLM turn 开始时注入 steering prompt：

```
onBeforeAgentStart handler:
  → api.sessionData.get('goal-state')
    → 有活跃 goal？
      → 是：返回 {
          injectedMessages: [{
            role: 'user',
            content: contextInjectionPrompt(goalState),
            display: false   // 不展示给用户
          }]
        }
      → 否：返回 {} (无注入)
```

**数据流**：

```
pi before_agent_start 触发
  → Bridge → bridge:intercept → sidecar → PluginService.executeHooks('agent:beforeStart')
    → goal Worker handler 返回 {injectedMessages: [...]}
    → 结果返回 Bridge
  → Bridge 将 injectedMessages 注入 pi context
```

### 6.4 状态持久化

Goal state 通过 `api.sessionData` 管理，与 pi session 绑定：

```
状态写入：api.sessionData.set('goal-state', JSON.stringify({
  goalId, goalDescription, tasks: [{id, description, status, evidence}], ...
}))

状态恢复：api.hooks.onPiEvent('session_start', handler)
  → handler 调用 api.sessionData.get('goal-state')
  → 解析 JSON，恢复内存状态
```

---

## §7 Todo Plugin (BG7: Task 9)

### 7.1 原始 pi extension → agentAPI 映射

| 原始 pi API | agentAPI 等价 |
|-------------|--------------|
| `pi.registerTool('todo', ...)` | `api.tools.register({name: 'todo', description, parameters, handler})` |
| `pi.registerCommand('todos', ...)` | `api.slashCommands.register({name: 'todos', description, handler})` |
| `ctx.sessionManager.getEntries()` 恢复状态 | `api.sessionData.get('todo-state')` |
| `pi.on('session_start', handler)` | `api.hooks.onPiEvent('session_start', handler)` |
| `pi.on('session_tree', handler)` | `api.hooks.onPiEvent('session_tree', handler)` |

### 7.2 todo Tool 注册

5 个 action，schema 直接复用：

```typescript
api.tools.register({
  name: 'todo',
  description: 'Lightweight todo list manager...',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'update', 'delete', 'clear']
      },
      // texts: string[] (add)
      // id: number (update/delete)
      // status: string (update)
      // ids: number[] (delete)
    },
    required: ['action']
  },
  handler: async (params) => { /* 路由到对应 action handler */ }
})
```

### 7.3 状态持久化

```
写入：api.sessionData.set('todo-state', JSON.stringify({
  todos: [{id, text, status}],
  nextId: number
}))

恢复：api.hooks.onPiEvent('session_start', handler)
  → api.sessionData.get('todo-state')
  → 解析恢复 {todos, nextId}

session_tree 事件：api.hooks.onPiEvent('session_tree', handler)
  → 不需要修改状态，仅用于可能的刷新通知
```

### 7.4 数据流

```
LLM 调用 todo tool (action: add, text: "xxx")
  → Bridge 代理 → bridge:tool_execute → sidecar → PluginService.handleBridgeToolExecute
    → 路由到 todo Worker
    → Worker handler 执行 addTodo("xxx")
    → api.sessionData.set('todo-state', updatedState)
    → 返回 ToolResult {content: JSON.stringify({todos: [...]})}
  → Bridge 返回给 pi
  → LLM 展示结果（或触发 RenderDescriptor）
```

---

## 错误路径汇总

| 场景 | 触发点 | 错误码/行为 |
|------|--------|------------|
| sandbox require 拦截 | Worker bootstrap `_resolveFilename` | throw `PERMISSION_DENIED` |
| API 权限不足 | PluginRPC dispatch | 返回 `{code: -32001, message: 'PERMISSION_DENIED'}` |
| Bridge 未连接 | sessionData.set / sendMessage | 返回 `BRIDGE_NOT_READY` |
| Bridge 未连接 | 代理 tool 调用 | 返回 `{content: 'plugin system initializing', isError: true}` |
| tool name 重复 | PluginRPC.tool_register | 返回 `TOOL_NAME_CONFLICT` |
| 循环依赖 | PluginActivator.topologicalSort | 所有涉及插件标记 `DEPS_MISSING` |
| handler 超时（5s） | executeHooks | 视为放行，继续链 |
| handler 异常 | executeHooks | log error，视为放行，继续链 |
| Worker 崩溃 | PluginHost crash callback | 标记 CRASHED，tool 调用返回 INTERNAL_ERROR |
| built-in 插件禁用 | PluginService.togglePlugin | throw error |
| plugin not found | handleBridgeToolExecute | 返回 `{content: 'plugin not found', isError: true}` |
