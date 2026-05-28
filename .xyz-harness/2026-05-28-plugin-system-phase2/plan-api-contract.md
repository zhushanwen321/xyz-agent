---
verdict: pass
---

# Plugin System Phase 2 — API 接口契约

本文档定义 Phase 2 所有新增/修改模块的接口签名、消息格式和数据流。不含实现代码。

---

## Module: PluginTypes

`plugin-types.ts` 新增/修改的类型定义。

### 枚举扩展

```typescript
// 新增：插件来源标记
export type PluginSource = 'built-in' | 'external'

// 扩展：新增 DEPS_MISSING 状态
export type PluginState =
  | 'UNLOADED' | 'LOADING' | 'ACTIVATING' | 'ACTIVE'
  | 'DEACTIVATING' | 'CRASHED' | 'DEPS_MISSING'
```

### Manifest / Descriptor 扩展

```typescript
export interface XyzAgentManifest {
  manifestVersion: 1
  main: string
  activationEvents: string[]
  trustLevel?: 'trusted' | 'sandbox'
  permissions?: string[]
  source?: PluginSource                // 新增，默认 'external'
  extensionDependencies?: string[]     // 新增，格式 "pluginId@semverRange"
  contributes?: PluginContributes
}

export interface PluginDescriptor {
  // ... 现有字段保持不变
  source: PluginSource                 // 新增，扫描时填充，不允许 undefined
  extensionDependencies: string[]      // 新增，解析自 manifest
}
```

### Tool / Command / Hook 注册类型

```typescript
export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface CommandRegistration {
  name: string
  description: string
}

// 可拦截 hooks — handler 可返回控制指令
export type InterceptorHookType =
  | 'message:beforeSend'
  | 'tool:beforeCall'
  | 'agent:beforeStart'

// 只读 hooks — handler 只接收 data，无返回值
export type ObserverHookType =
  | 'tool:afterResult'
  | 'pi:agent_start' | 'pi:agent_end'
  | 'pi:tool_call' | 'pi:tool_result'
  | 'pi:turn_end' | 'pi:message_end'
  | 'pi:session_start' | 'pi:session_compact'
  | 'pi:session_tree'

export type HookType = InterceptorHookType | ObserverHookType

export interface InterceptorResult {
  blocked?: boolean
  modifiedContent?: unknown
  injectedMessages?: Array<{ role: string; content: string; display?: boolean }>
  reason?: string
}

export interface HookContext {
  hookType: HookType
  pluginId: string
  sessionId: string
  data: Record<string, unknown>
}

export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  modifiedContent?: unknown
  injectedMessages?: Array<{ role: string; content: string; display?: boolean }>
}

export interface HookBlockedResult {
  blocked: true
  reason?: string
  blockedBy: string
}
```

### Bridge 协议类型

```typescript
// Bridge 连接状态
export type BridgeState = 'Disconnected' | 'Syncing' | 'Ready'

// bridge:sync
export interface BridgeSyncRequest {
  method: 'bridge:sync'
}

export interface BridgeSyncResponse {
  tools: ToolRegistration[]
  commands: CommandRegistration[]
}

// bridge:tool_execute
export interface BridgeToolExecuteRequest {
  method: 'bridge:tool_execute'
  toolName: string
  toolCallId: string
  params: Record<string, unknown>
  sessionId: string
}

export interface BridgeToolExecuteResponse {
  content: string
  details?: string
  isError?: boolean
}

// bridge:event（单向，无响应）
export interface BridgeEventNotification {
  method: 'bridge:event'
  eventName: string
  data: unknown
  sessionId: string
}

// bridge:intercept
export interface BridgeInterceptRequest {
  method: 'bridge:intercept'
  eventName: string
  data: Record<string, unknown>
  sessionId: string
}

export interface BridgeInterceptResponse {
  injectedMessages?: Array<{ role: string; content: string; display?: boolean }>
}

// bridge:append_entry
export interface BridgeAppendEntryRequest {
  method: 'bridge:append_entry'
  type: string
  data: Record<string, unknown>
  sessionId: string
}

export interface BridgeAppendEntryResponse {
  success: boolean
}
```

### 权限常量

```typescript
export const PermissionConstants = {
  // Tool 相关
  TOOLS_REGISTER: 'tools.register',
  TOOLS_EXECUTE: 'tools.execute',

  // Hook 相关
  HOOKS_REGISTER: 'hooks.register',
  HOOKS_ON_PI_EVENT: 'hooks.onPiEvent',

  // Slash Command
  SLASH_COMMANDS_REGISTER: 'slashCommands.register',

  // Sessions
  SESSIONS_LIST: 'sessions.list',
  SESSIONS_GET: 'sessions.get',
  SESSIONS_SEND_MESSAGE: 'sessions.sendMessage',

  // Config
  CONFIG_GET: 'config.get',
  CONFIG_SET: 'config.set',

  // SessionData
  SESSION_DATA_GET: 'sessionData.get',
  SESSION_DATA_SET: 'sessionData.set',

  // UI
  UI_SHOW_SELECT: 'ui.showSelect',
  UI_SHOW_CONFIRM: 'ui.showConfirm',
  UI_SHOW_INPUT: 'ui.showInput',
  UI_NOTIFY: 'ui.notify',
  UI_STATUS_BAR: 'ui.updateStatusBarItem',

  // Agent（trusted 专属）
  AGENT_SET_MODEL: 'agent.setModel',
  AGENT_SET_THINKING: 'agent.setThinkingLevel',

  // Workspace
  WORKSPACE_FIND_FILES: 'workspace.findFiles',

  // Storage（Phase 1 已有）
  STORAGE_GET: 'storage.get',
  STORAGE_SET: 'storage.set',
} as const
```

---

## Module: PermissionChecker

权限检查器，位于 `plugin-permission.ts`。

```typescript
interface PermissionStorage {
  load(): Promise<Map<string, Set<string>>>
  save(granted: Map<string, Set<string>>): Promise<void>
}

class PermissionChecker {
  private granted: Map<string, Set<string>>
  private storage: PermissionStorage

  /**
   * 检查插件是否持有指定 method 的权限
   * - built-in / trusted 插件始终返回 true
   * - sandbox 插件查询 granted map
   * - 未授权或未知 method 返回 false
   */
  check(pluginId: string, method: string): boolean

  /**
   * 授予插件指定权限列表
   * 追加到已有权限集合，不覆盖
   */
  grant(pluginId: string, permissions: string[]): void

  /**
   * 撤销插件所有权限（卸载时调用）
   */
  revoke(pluginId: string): void

  /**
   * 从 permissions.json 加载持久化权限
   * 文件不存在时初始化为空 map
   */
  load(): Promise<void>

  /**
   * 将当前权限映射持久化到 permissions.json
   */
  save(): Promise<void>

  /**
   * 判断是否为内置或 trusted 插件
   * 从 PluginRegistry 获取 descriptor.trustLevel 和 descriptor.source
   */
  private isTrustedOrBuiltIn(pluginId: string): boolean
}
```

**边界条件**：

| 场景 | 行为 |
|------|------|
| `permissions.json` 不存在 | `load()` 初始化空 map，不报错 |
| `check()` 对未注册 pluginId | 返回 `false` |
| `grant()` 空数组 | no-op |
| `save()` 并发调用 | 串行化（内部锁或 queue） |

---

## Module: PluginRPC

所有 RPC handler 签名。Phase 1 已有：`storage.*`、`notify.*`、`sessions.list`、`events.*`。Phase 2 新增：

### Tool API

```typescript
// plugin.tools.register
tool_register(params: {
  pluginId: string
  name: string
  description: string
  parameters: Record<string, unknown>
}): string  // → toolKey（格式 "pluginId:toolName"）
// 边界：name 重复 → throw TOOL_NAME_CONFLICT

// plugin.tools.unregister
tool_unregister(params: {
  pluginId: string
  toolKey: string
}): void
// 边界：toolKey 不存在 → no-op
```

### Slash Command API

```typescript
// plugin.slashCommands.register
slash_command_register(params: {
  pluginId: string
  name: string
  description: string
}): string  // → cmdKey（格式 "pluginId:cmdName"）
```

### Hook API

```typescript
// plugin.hooks.register
hook_register(params: {
  pluginId: string
  hookType: HookType
  handlerId: string
}): void

// plugin.hooks.invoke（主线程 → Worker 方向）
hook_invoke(params: {
  handlerId: string
  context: HookContext
}): InterceptorResult | void  // 可拦截 hook 返回 InterceptorResult，只读 hook 返回 void
```

### Sessions API（扩展）

```typescript
// plugin.sessions.get
sessions_get(params: {
  sessionId: string
}): SessionInfo | undefined

// plugin.sessions.getActive
sessions_getActive(): SessionInfo | undefined

// plugin.sessions.sendMessage
sessions_sendMessage(params: {
  sessionId?: string   // 缺省为当前活跃 session
  role: 'user' | 'system'
  content: string
}): Promise<void>
// 边界：无活跃 session 且 sessionId 缺省 → throw PLUGIN_NOT_FOUND
// 边界：Bridge 未连接 → throw BRIDGE_NOT_READY
```

### Config API

```typescript
// plugin.config.get
config_get(params: {
  pluginId: string
  key: string
}): Promise<unknown>

// plugin.config.getAll
config_getAll(params: {
  pluginId: string
}): Promise<Record<string, unknown>>

// plugin.config.set
config_set(params: {
  pluginId: string
  key: string
  value: unknown
}): Promise<void>
// 边界：key 未在 contributes.settings 声明 → throw INVALID_CONFIG_KEY
```

### SessionData API

```typescript
// plugin.sessionData.get
sessionData_get(params: {
  sessionId: string
  key: string
}): Promise<unknown>  // key 不存在 → undefined

// plugin.sessionData.set
sessionData_set(params: {
  sessionId: string
  key: string
  value: unknown
}): Promise<void>
// 边界：Bridge 未连接 → throw BRIDGE_NOT_READY；缓存不更新

// plugin.sessionData.delete
sessionData_delete(params: {
  sessionId: string
  key: string
}): Promise<void>

// plugin.sessionData.keys
sessionData_keys(params: {
  sessionId: string
}): Promise<string[]>  // 无数据 → []
```

### UI API

```typescript
// plugin.ui.showSelect
ui_showSelect(params: {
  pluginId: string
  title: string
  options: string[]
}): Promise<string | undefined>  // 用户取消 → undefined

// plugin.ui.showConfirm
ui_showConfirm(params: {
  pluginId: string
  title: string
  message: string
}): Promise<boolean>

// plugin.ui.showInput
ui_showInput(params: {
  pluginId: string
  title: string
  defaultValue?: string
}): Promise<string | undefined>  // 用户取消 → undefined

// plugin.ui.notify
ui_notify(params: {
  pluginId: string
  level: 'info' | 'warn' | 'error'
  message: string
}): Promise<void>

// plugin.ui.updateStatusBarItem
ui_updateStatusBarItem(params: {
  pluginId: string
  id: string
  text: string
}): Promise<void>
```

### Agent API（trusted 专属）

```typescript
// plugin.agent.setModel
agent_setModel(params: { model: string }): Promise<void>
// 边界：sandbox 插件调用 → PERMISSION_DENIED

// plugin.agent.getModel
agent_getModel(): Promise<string>

// plugin.agent.getThinkingLevel
agent_getThinkingLevel(): Promise<string>

// plugin.agent.setThinkingLevel
agent_setThinkingLevel(params: { level: string }): Promise<void>

// plugin.agent.getActiveTools
agent_getActiveTools(): Promise<string[]>
```

### Workspace API

```typescript
// plugin.workspace.rootPath（getter）
workspace_rootPath(): string

// plugin.workspace.name（getter）
workspace_name(): string

// plugin.workspace.findFiles
workspace_findFiles(params: {
  pattern: string
}): Promise<string[]>
```

---

## Module: BridgeProtocol

所有 bridge `extension_ui_request` 子类型的请求/响应格式。Bridge 是 pi extension，通过 pi 的 `extension_ui_request` / `extension_ui_response` 机制与 sidecar 通信。

### bridge:sync — 初始同步

```
请求：Bridge → sidecar
{
  method: 'bridge:sync'
}

响应：sidecar → Bridge
{
  tools: ToolRegistration[]      // 所有已注册插件的 tool schema
  commands: CommandRegistration[] // 所有已注册插件的 slash command schema
}
```

边界：sidecar 未就绪 → 返回空数组 `{tools: [], commands: []}`

### bridge:tool_execute — Tool 执行代理

```
请求：Bridge → sidecar
{
  method: 'bridge:tool_execute'
  toolName: string               // 注册时的 tool name
  toolCallId: string             // pi 分配的调用 ID
  params: Record<string, unknown>
  sessionId: string
}

响应：sidecar → Bridge
{
  content: string
  details?: string
  isError?: boolean
}
```

边界：plugin 未找到 → `{content: 'plugin not found', isError: true}`；plugin 已崩溃 → `{content: 'plugin crashed', isError: true}`

### bridge:event — 事件转发（单向通知）

```
通知：Bridge → sidecar（无响应）
{
  method: 'bridge:event'
  eventName: string              // pi 事件名
  data: unknown                  // 事件数据
  sessionId: string
}
```

### bridge:intercept — 可拦截事件

```
请求：Bridge → sidecar
{
  method: 'bridge:intercept'
  eventName: string              // 'before_agent_start' 等
  data: { sessionId, systemPrompt?, ... }
  sessionId: string
}

响应：sidecar → Bridge
{
  injectedMessages?: Array<{ role: string; content: string; display?: boolean }>
}
```

边界：无 handler 注册 → 返回 `{}`；handler 异常 → 返回 `{}`（视为放行）

### bridge:append_entry — SessionData 持久化

```
请求：sidecar → Bridge
{
  method: 'bridge:append_entry'
  type: string                   // 如 'plugin-data'
  data: { key: string, value: unknown }
  sessionId: string
}

响应：Bridge → sidecar
{
  success: boolean
}
```

---

## Module: PluginService

`plugin-service.ts` 新增方法。

```typescript
class PluginService {
  // ── Hook 注册表（新增）──
  private hookRegistry: Map<HookType, Array<{
    pluginId: string
    handlerId: string
    priority: number   // 0=内置, 100=trusted, 200=sandbox
  }>>

  // ── Tool 注册表（新增）──
  private toolRegistry: Map<string, {
    pluginId: string
    handlerId: string
    schema: ToolRegistration
  }>

  // ── SessionData 缓存（新增）──
  private sessionDataCache: Map<string, Map<string, unknown>>  // sessionId → key → value

  /**
   * 执行指定类型的所有 hook handler
   * 可拦截 hook：串行执行，blocked: true 终止链
   * 只读 hook：并行广播
   * handler 异常/超时(5s)：log + 视为放行
   */
  executeHooks(hookType: HookType, context: HookContext): Promise<HookResult>

  /**
   * 将当前 tool/command schema 同步到 Bridge
   * Bridge 非 Ready 时 no-op
   */
  syncToolsToBridge(): Promise<void>

  /**
   * 处理 Bridge 转发来的 tool execute 请求
   * 路由到对应 Worker 执行
   */
  handleBridgeToolExecute(request: BridgeToolExecuteRequest): Promise<BridgeToolExecuteResponse>

  /**
   * 处理 Bridge 转发的只读 pi 事件
   * 广播给所有注册了对应 hookType 的 Worker
   */
  handleBridgeEvent(eventName: string, data: unknown, sessionId: string): void

  /**
   * 处理 Bridge 转发的可拦截事件
   * 串行执行 handler，收集 injectedMessages
   */
  handleBridgeIntercept(
    eventName: string,
    data: Record<string, unknown>,
    sessionId: string
  ): Promise<BridgeInterceptResponse>

  /**
   * 切换插件启用/禁用（扩展现有方法）
   * built-in 插件调用此方法 → throw Error('built-in plugins cannot be disabled')
   */
  togglePlugin(id: string, enabled: boolean): Promise<PluginDescriptor[]>

  /**
   * 带依赖解析的批量激活（委托 PluginActivator）
   */
  activateWithDeps(descriptors: PluginDescriptor[]): Promise<void>
}
```

---

## Module: PluginActivator

`plugin-activator.ts` 新增方法。

```typescript
class PluginActivator {
  /**
   * 带依赖解析的批量激活
   * 1. topologicalSort 排序
   * 2. 检查缺失依赖 → 标记 DEPS_MISSING
   * 3. 按序激活每个插件
   */
  activateWithDeps(descriptors: PluginDescriptor[]): Promise<void>

  /**
   * 拓扑排序（Kahn's algorithm）
   * 解析 extensionDependencies，被依赖的插件排在前面
   * 检测到循环 → throw CIRCULAR_DEPENDENCY
   */
  topologicalSort(descriptors: PluginDescriptor[]): PluginDescriptor[]

  /**
   * 循环检测
   * 返回参与循环的 pluginId 列表，无循环返回 null
   */
  detectCycle(descriptors: PluginDescriptor[]): string[] | null
}
```

**边界条件**：

| 场景 | 行为 |
|------|------|
| 循环依赖 | `detectCycle` 返回循环涉及的 ID 列表；`topologicalSort` throw；所有涉及插件标记 `DEPS_MISSING` |
| 依赖未安装 | 依赖不在 descriptors 中 → 标记为 `DEPS_MISSING`，不激活 |
| 空数组 | 返回空数组 |
| 单插件无依赖 | 直接激活 |

---

## Data Flows

### 1. Tool Execute 流

LLM 调用代理 tool → Bridge → sidecar → PluginService → Worker → back

```
pi LLM function_call(goal_manager, {action: 'create_tasks', ...})
  → Bridge executeHandler
    → extension_ui_request({method: 'bridge:tool_execute', toolName: 'goal_manager', toolCallId, params, sessionId})
  → event-adapter.ts 识别 bridge: 前缀，不弹前端 UI
  → server.ts 路由到 PluginService.handleBridgeToolExecute(request)
    → 查 toolRegistry → 找到 pluginId + handlerId
    → PluginHost.sendRpc(pluginId, {method: 'plugin.hooks.invoke', params: {handlerId, context}})
    → Worker 内执行 tool handler
    → 返回 ToolResult {content, isError}
  → handleBridgeToolExecute 组装 BridgeToolExecuteResponse 返回 Bridge
  → Bridge 返回给 pi
```

### 2. Event Forward 流

pi 事件 → Bridge → sidecar → PluginService.executeHooks → Workers broadcast

```
pi 触发 agent_end 事件
  → Bridge event-forwarder 监听 pi.on('agent_end', handler)
    → extension_ui_request({method: 'bridge:event', eventName: 'agent_end', data, sessionId})
  → server.ts 路由到 PluginService.handleBridgeEvent('agent_end', data, sessionId)
    → 查 hookRegistry['pi:agent_end']
    → 并行广播给所有注册的 Worker
      → Worker 内调用 api.hooks.onPiEvent handler
```

### 3. Intercept 流

pi before_agent_start → Bridge → sidecar → executeHooks → Workers 串行 → injectedMessages 返回

```
pi 触发 before_agent_start 事件
  → Bridge 监听 pi.on('before_agent_start', handler)
    → extension_ui_request({method: 'bridge:intercept', eventName: 'before_agent_start', data: {sessionId, systemPrompt}, sessionId})
  → server.ts 路由到 PluginService.handleBridgeIntercept('before_agent_start', data, sessionId)
    → PluginService.executeHooks('agent:beforeStart', context)
      → hookRegistry 中按 priority 排序
      → 串行 RPC 到 Worker: {method: 'plugin.hooks.invoke', params: {handlerId, context}}
      → 收集 InterceptorResult（含 injectedMessages）
      → blocked: true → 终止链
    → 汇总 injectedMessages 返回 BridgeInterceptResponse
  → Bridge 将 injectedMessages 注入 pi context
```

### 4. SessionData 流

Worker → RPC → PluginRPC → 内存缓存 + bridge:append_entry → pi.appendEntry

```
Worker: api.sessionData.set('goal-state', serializedState)
  → JSON-RPC: {method: 'plugin.sessionData.set', params: {sessionId, key: 'goal-state', value}}
  → PluginRPC.sessionData_set handler
    → 更新内存缓存: sessionDataCache[sessionId][key] = value
    → sidecar 发 extension_ui_request 到 pi:
        {method: 'bridge:append_entry', type: 'plugin-data', data: {key, value}, sessionId}
      → Bridge 收到后调用 pi.appendEntry({type: 'plugin-data', data: {key, value}})
      → Bridge 返回 {success: true}
    → 返回给 Worker

读取：
Worker: api.sessionData.get('goal-state')
  → JSON-RPC: {method: 'plugin.sessionData.get', params: {sessionId, key}}
  → PluginRPC 从 sessionDataCache 读取，不走跨进程 RPC
```

### 5. SendMessage Hook 流

前端 sendMessage → session-service → executeHooks('message:beforeSend') → Workers 串行 → blocked/modified

```
用户发送消息 → session-service.sendMessage(content, sessionId)
  → PluginService.executeHooks('message:beforeSend', {content, sessionId})
    → hookRegistry['message:beforeSend'] 按 priority 排序
    → 串行 RPC 到 Worker: {method: 'plugin.hooks.invoke', params: {handlerId, context}}
      → Worker handler 返回 InterceptorResult
    → blocked: true → 终止链
  → 返回 HookResult
    → blocked: true → 返回 HookBlockedResult，sendMessage 不执行
    → modifiedContent → 用修改后内容替换原 content
    → 无修改 → 使用原 content
  → 继续原有 sendMessage 流程（WS → sidecar → pi）
```

---

## AC Coverage Matrix

| AC 编号 | AC 描述 | 涉及方法 | 涉及数据流 | Task 编号 |
|---------|---------|---------|-----------|----------|
| AC-1 | Bridge 验证 | `BridgeSyncRequest/Response`, `BridgeToolExecuteRequest/Response`, `syncToolsToBridge()` | Flow 1 (Tool Execute) | Task 5 |
| AC-2 | agentAPI 验证 | `tool_register()`, `slash_command_register()`, `hook_register()`, `sessions_*()`, `config_*()`, `sessionData_*()`, `ui_*()`, `agent_*()`, `workspace_*()` | Worker → PluginRPC → handler | Task 4, 6 |
| AC-3 | 事件桥接验证 | `executeHooks()`, `hook_register()`, `InterceptorResult` | Flow 2 (Event Forward), Flow 3 (Intercept), Flow 5 (SendMessage Hook) | Task 7 |
| AC-4 | 权限验证 | `PermissionChecker.check()`, `grant()`, `load()`, `save()`, `PERMISSION_DENIED` 错误码 | Worker RPC → PluginRPC dispatch → PermissionChecker | Task 3 |
| AC-5 | 沙箱验证 | Sandbox `_resolveFilename` 拦截, `process.env` Proxy | Worker require → 拦截 → block/allow | Task 2 |
| AC-6 | 内置/外部区分验证 | `PluginSource`, `PluginRegistry.scan()`, `togglePlugin()` built-in guard | scan → mark source → toggle guard | Task 1 |
| AC-7 | 依赖验证 | `PluginActivator.activateWithDeps()`, `topologicalSort()`, `detectCycle()`, `DEPS_MISSING` | scan → build graph → sort → activate | Task 7 |
| AC-8 | Goal 插件验证 | `tool_register(goal_manager)`, `hook_register(agent:beforeStart)`, `sessionData_set/get` | Flow 1 (Tool Execute), Flow 3 (Intercept), Flow 4 (SessionData) | Task 8 |
| AC-9 | Todo 插件验证 | `tool_register(todo)`, `hook_register(pi:session_start)`, `sessionData_set/get` | Flow 1 (Tool Execute), Flow 4 (SessionData) | Task 9 |
