---
verdict: pass
complexity: L1
---

# Plugin System Remaining Phases — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将插件系统从"框架完整但能力断裂"变为"端到端可用"，补齐 10 项 stub/缺失功能。

**Architecture:** 所有修改在现有 plugin-service 架构内完成。核心改动模式：(1) 将 stub handler 替换为对已有 Service 的真实调用；(2) 在 event-adapter 翻译点插入 hook 拦截；(3) 新增 WS 消息类型实现 UI 弹窗路由。无架构变更，无新服务层。

**Tech Stack:** TypeScript, Node.js Worker Threads, WebSocket, fast-glob, Vue 3 + Pinia (前端)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/runtime/src/services/plugin-service/plugin-service.ts` | modify | BG1 | Session/Agent/UI handler stub 替换 + 构造函数注入 services + SessionData flush |
| `src-electron/runtime/src/services/plugin-service/plugin-types.ts` | modify | BG1 | 新增 IPluginServiceDeps + PluginUIRequest 接口 |
| `src-electron/runtime/src/services/plugin-service/api/session-api.ts` | modify | BG1 | Session handler deps 更新 |
| `src-electron/runtime/src/services/plugin-service/api/agent-api.ts` | modify | BG1 | Agent handler deps 更新 |
| `src-electron/runtime/src/services/plugin-service/plugin-storage.ts` | modify | BG1 | SessionData 文件持久化辅助函数（persist/load/delete） |
| `src-electron/runtime/src/index.ts` | modify | BG1 | PluginService 实例化传入 deps + EventAdapter hook 回调注入 |
| `src-electron/runtime/src/services/plugin-service/plugin-activator.ts` | modify | BG2 | 权限检查 + 推送（不修改 plugin-service.ts） |
| `src-electron/runtime/src/services/plugin-service/plugin-host.ts` | modify | BG2 | Worker crash 自动重建 |
| `src-electron/runtime/package.json` | modify | BG3 | 添加 fast-glob 依赖 |
| `src-electron/runtime/src/services/plugin-service/api/workspace-api.ts` | modify | BG3 | findFiles 实现 |
| `src-electron/runtime/src/event-adapter.ts` | modify | BG3 | Hook 事件桥接（新增 onHookExecute 回调到 EventAdapterOptions） |
| `src-electron/runtime/src/services/session-service.ts` | modify | BG3 | onBeforeSendMessage hook 注册（已有 hook 点，PluginService 注册） |
| `src-electron/runtime/src/server.ts` | modify | BG1 | plugin.uiResponse WS 路由（Task 1 中新增 case） |
| `src-electron/renderer/src/composables/usePlugin.ts` | modify | FG1 | 监听 plugin:uiRequest 事件 |
| `src-electron/renderer/src/components/extension/ExtensionUIDialog.vue` | modify | FG1 | 支持 plugin 来源 |
| `src-electron/renderer/src/composables/useExtensionUI.ts` | modify | FG1 | 支持 plugin UI request 类型 |
| `packages/plugin-sdk/package.json` | create | PG1 | SDK 包配置 |
| `packages/plugin-sdk/src/index.ts` | create | PG1 | 类型导出 + mock |
| `packages/plugin-sdk/src/types.ts` | create | PG1 | 从 plugin-types.ts 提取的类型定义 |
| `packages/plugin-sdk/src/mock.ts` | create | PG1 | mock agentAPI 对象 |
| `packages/plugin-sdk/tsconfig.json` | create | PG1 | TypeScript 配置 |
| `src-electron/runtime/src/plugins/demo/manifest.yml` | create | PG1 | Demo 插件 manifest |
| `src-electron/runtime/src/plugins/demo/index.ts` | create | PG1 | Demo 插件实现 |
| `src-electron/runtime/test/plugin-session-real.test.ts` | create | BG1 | Session API 真实调用测试 |
| `src-electron/runtime/test/plugin-agent-real.test.ts` | create | BG1 | Agent API 真实调用测试 |
| `src-electron/runtime/test/plugin-sessiondata-persist.test.ts` | create | BG1 | SessionData 持久化测试 |
| `src-electron/runtime/test/plugin-ui-dialog.test.ts` | create | BG1 | UI 弹窗 WS 路由测试 |
| `src-electron/runtime/test/plugin-permission-push.test.ts` | create | BG2 | 权限推送测试 |
| `src-electron/runtime/test/plugin-worker-rebuild.test.ts` | create | BG2 | Worker 重建测试 |
| `src-electron/runtime/test/plugin-hook-bridge.test.ts` | create | BG3 | Hook 桥接测试 |
| `src-electron/runtime/test/plugin-findfiles.test.ts` | create | BG3 | findFiles 独立测试 |
| `src-electron/runtime/test/plugin-demo-e2e.test.ts` | create | PG1 | Demo 插件端到端测试 |

---

## Interface Contracts

### Module: PluginService

#### Class: PluginService

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| constructor | (registry, broker, deps: IPluginServiceDeps) → void | void | deps 可部分为 undefined（渐进式注入） | FR-1, FR-3 |
| handleUiRequest | (request: PluginUIRequest) → Promise\<unknown\> | 用户选择结果 | 超时 60s 返回 undefined | AC-4 |
| broadcastPluginEvent | (type: string, payload: unknown) → void | void | 无活跃 WS 连接时静默丢弃 | FR-4, FR-5 |

#### Data: IPluginServiceDeps

| Field | Type | Description |
|-------|------|-------------|
| sessionService | ISessionService | Session 生命周期管理 |
| configService | IConfigService | 配置 CRUD（模型、thinking level） |
| broadcastFn | (type: string, payload: unknown) => void | WS 广播函数（从 server.ts 注入） |

#### Data: PluginUIRequest

| Field | Type | Description |
|-------|------|-------------|
| sessionId | string | 来源 session |
| requestId | string | 唯一请求 ID |
| method | 'confirm' \| 'select' \| 'input' | 弹窗类型 |
| title | string | 弹窗标题 |
| message? | string | 弹窗内容 |
| options? | string[] | select 选项列表 |

### Module: SessionDataPersistence

#### Function: persistSessionData

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| persistSessionData | (sessionId: string, data: Map\<string, unknown\>) → Promise\<void\> | void | 超过 10MB 抛出 Error | AC-2 |
| loadSessionData | (sessionId: string) → Promise\<Map\<string, unknown\>\> | Map | 文件不存在返回空 Map | AC-2 |
| deleteSessionData | (sessionId: string) → Promise\<void\> | void | 文件不存在不报错 | — |

### Module: HookBridge

#### Function: bridgeToolEvent

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| bridgeToolStart | (sessionId: string, toolName: string, input: unknown) → Promise\<HookResult\> | { blocked?, transformedParams? } | 无 handler 注册时返回放行 | AC-8 |
| bridgeToolEnd | (sessionId: string, toolCallId: string, output: unknown) → Promise\<HookResult\> | { transformedOutput? } | 无 handler 注册时返回放行 | AC-8 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 Session API | PluginService → ISessionService.listPersistedSessions() | RPC → service → 转换 SessionInfo[] | Task 1 |
| AC-2 SessionData flush | persistSessionData → atomic write → loadSessionData | flush → write temp → rename → load | Task 1 |
| AC-3 Agent API | PluginService → IConfigService.get/set | RPC → configService → 读己之写 | Task 1 |
| AC-4 UI 弹窗 | handleUiRequest → WS broadcast → dialog → response | handler → WS → 前端 → WS → resolve | Task 1, Task 5 |
| AC-5 权限推送 | broadcastPluginEvent → plugin:permissionRequest → dialog | activate → check → push → approve → resume | Task 2 |
| AC-6 findFiles | fastGlob(pattern, { cwd }) → string[] | RPC → fastGlob → 截断 1000 | Task 3 |
| AC-7 Worker 重建 | handleWorkerCrash → 5s cool → createWorker → reload | crash → wait → new worker → activate | Task 2 |
| AC-8 Hook 桥接 | bridgeToolStart/End → executeHooks → result | event → hook → blocked/transform | Task 4 |
| AC-9 SDK 类型 | npm package → type exports + mock | 独立包，从 plugin-types.ts 提取 | Task 6 |
| AC-10 样例插件 | demo plugin → slash command + tool + hook | activate → register → end-to-end | Task 7 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 listSessions 返回真实数据 | adopted | Task 1 |
| AC-2 SessionData 重启恢复 | adopted | Task 1 |
| AC-3 getModel 返回有效模型 | adopted | Task 1 |
| AC-4 showSelect/Confirm/Input 弹窗 | adopted | Task 1 + Task 5 |
| AC-5 权限推送弹窗 | adopted | Task 2 |
| AC-6 findFiles 返回文件列表 | adopted | Task 3 |
| AC-7 Worker crash 自动重建 | adopted | Task 2 |
| AC-8 Hook 桥接生效 | adopted | Task 4 |
| AC-9 SDK 类型包 | adopted | Task 6 |
| AC-10 样例插件端到端 | adopted | Task 7 |
| SessionData 单文件 10MB 上限 | adopted | Task 1 |
| Hook 拦截超时 5s | adopted | Task 4（已有实现保持不变） |
| UI 弹窗 60s 超时 | adopted | Task 1 |
| findFiles 结果截断 1000 条 | adopted | Task 3 |
| Worker 重建最多 3 次 | adopted | Task 2 |
| UI 弹窗串行排队 | adopted | Task 1 |

---

## Task List

### Task 1: Service 注入 + Session/Agent API + SessionData 持久化 + UI 弹窗 (FR-1 + FR-3 + FR-2 + FR-4 backend)

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-types.ts` (新增 IPluginServiceDeps + PluginUIRequest)
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-service.ts` (L76 构造函数, L197-273 handlers, L236-264 UI handlers, L456-496 flush)
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-storage.ts` (新增 persist/load/delete 辅助函数)
- Modify: `src-electron/runtime/src/index.ts` (PluginService 实例化传入 deps)
- Modify: `src-electron/runtime/src/services/plugin-service/api/session-api.ts` (deps 更新)
- Modify: `src-electron/runtime/src/services/plugin-service/api/agent-api.ts` (deps 更新)
- Create: `src-electron/runtime/test/plugin-session-real.test.ts`
- Create: `src-electron/runtime/test/plugin-agent-real.test.ts`
- Create: `src-electron/runtime/test/plugin-sessiondata-persist.test.ts`
- Create: `src-electron/runtime/test/plugin-ui-dialog.test.ts`

- [ ] **Step 1: 定义 IPluginServiceDeps 和 PluginUIRequest 接口**

在 `plugin-types.ts` 中新增：
```typescript
export interface IPluginServiceDeps {
  sessionService?: ISessionService
  configService?: IConfigService
  broadcastFn?: (type: string, payload: unknown) => void
}

export interface PluginUIRequest {
  sessionId: string
  requestId: string
  method: 'confirm' | 'select' | 'input'
  title: string
  message?: string
  options?: string[]
}
```

- [ ] **Step 2: 修改 PluginService 构造函数**

`plugin-service.ts` 构造函数新增 `deps` 参数，存储为 `this.deps`。初始化 pending UI request 管理：
```typescript
private activeUiRequest: string | null = null
private uiRequestQueue: Array<{params: unknown, resolve: (v: unknown) => void}> = []
private pendingUiRequests: Map<string, {resolve, timer}> = new Map()
```

- [ ] **Step 3: 更新 index.ts 实例化调用**

修改 `index.ts` 中 `new PluginService(pluginRegistry, server)` 为：
```typescript
new PluginService(pluginRegistry, server, {
  sessionService,
  configService,
  broadcastFn: (type, payload) => server.broadcast({ type, payload }),
})
```

- [ ] **Step 4: 替换 Session handlers**

在 `registerSessionRpcHandlers()` 的 deps 传入中：
- `listSessions` → `deps.sessionService.listPersistedSessions()` 转换为 `SessionInfo[]`
- `getSession` → `deps.sessionService.getSummary(id)` 转换
- `getActiveSession` → 遍历已知 sessionId 调用 `hasActiveSession()`
- `sendMessage` → `deps.sessionService.sendMessage(sessionId, content)`

sessionService 为 undefined 时 fallback 到原 stub 行为。

- [ ] **Step 5: 替换 Agent handlers**

- `getModel` → `deps.configService.get('defaultModel')` 返回 `{ provider, modelId }`
- `setModel` → `deps.configService.set('defaultModel', { provider, modelId })`
- `getThinkingLevel` → `deps.configService.get('thinkingLevel')` 默认 `'high'`
- `setThinkingLevel` → `deps.configService.set('thinkingLevel', level)`
- `getActiveTools` → `this.toolRegistry.getSchemas()`

configService 为 undefined 时 fallback 到原 stub。

- [ ] **Step 6: 实现 SessionData 文件持久化**

在 `plugin-storage.ts` 中新增 3 个辅助函数：
- `persistSessionData(sessionId, data)` → atomic write 到 `~/.xyz-agent/plugins/session-data/{sessionId}.json`
- `loadSessionData(sessionId)` → 从文件恢复，文件不存在返回空 Map
- `deleteSessionData(sessionId)` → 删除文件

替换 `plugin-service.ts` L456-496 中 3 处 `TODO: bridge flush` 为调用 `persistSessionData`。启动时调用 `loadSessionData` 恢复缓存。

- [ ] **Step 7: 实现 UI 弹窗 RPC 路由（含串行排队）**

替换 L236-264 中 showSelect/showConfirm/showInput stub。

串行排队机制：
```typescript
async handleUiRequest(method, params): Promise<unknown> {
  const requestId = generateId()
  const promise = new Promise((resolve) => {
    if (this.activeUiRequest !== null) {
      // 排队等待
      this.uiRequestQueue.push({ params: { requestId, method, ...params }, resolve })
      return
    }
    this.activeUiRequest = requestId
    this.dispatchUiRequest(requestId, method, params, resolve)
  })
  return promise
}

dispatchUiRequest(requestId, method, params, resolve) {
  this.pendingUiRequests.set(requestId, { resolve, timer: setTimeout(() => {
    this.finalizeUiRequest(requestId, undefined)
  }, 60_000) })
  this.deps.broadcastFn('plugin:uiRequest', { ...params, requestId, method })
}

handleUiResponse(requestId, result) {
  this.finalizeUiRequest(requestId, result)
}

finalizeUiRequest(requestId, result) {
  const entry = this.pendingUiRequests.get(requestId)
  if (!entry) return
  clearTimeout(entry.timer)
  this.pendingUiRequests.delete(requestId)
  entry.resolve(result)
  this.activeUiRequest = null
  // 处理队列中的下一个
  const next = this.uiRequestQueue.shift()
  if (next) {
    this.activeUiRequest = next.params.requestId
    this.dispatchUiRequest(next.params.requestId, next.params.method, next.params, next.resolve)
  }
}
```

在 `server.ts` 新增 `plugin.uiResponse` case 路由到 `pluginService.handleUiResponse()`。

- [ ] **Step 8: 写测试**

- `plugin-session-real.test.ts`: Mock ISessionService，验证 listSessions/getSession/sendMessage 调用
- `plugin-agent-real.test.ts`: Mock IConfigService，验证 setModel 后 getModel 读己之写
- `plugin-sessiondata-persist.test.ts`: 写入→清内存→恢复→10MB 限制→atomic write
- `plugin-ui-dialog.test.ts`: showConfirm WS 往返 + 60s 超时 + 串行排队

- [ ] **Step 9: Commit**

```
feat(plugin): wire Session/Agent API, SessionData persistence, UI dialog RPC
```

---

### Task 2: Permission 推送 + Worker Crash 重建 (FR-5 + FR-7)

**Type:** backend

**说明**：FR-5 和 FR-7 合并在同一 Task 是因为二者共享插件状态管理基础设施（broadcastFn、状态标记），且都不修改 plugin-service.ts（由 Task 1 完成）。

**Files:**
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-activator.ts` (L107-146)
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-host.ts` (L259-274)
- Create: `src-electron/runtime/test/plugin-permission-push.test.ts`
- Create: `src-electron/runtime/test/plugin-worker-rebuild.test.ts`

- [ ] **Step 1: 插入权限检查到激活流程**

在 `activatePlugin()` 的 ACTIVATING 阶段、`assignWorker` 之前：
1. 获取 manifest.permissions
2. 调用 `permissionChecker.getUnapproved(pluginId, permissions)`
3. 如有未授权权限 → 通过 `onStatusChange` 回调通知外部广播 `plugin:permissionRequest` → 等待审批（返回 Promise）
4. 审批通过 → 继续；超时/拒绝 → 状态设为 UNLOADED

**注意**：plugin-activator.ts 不直接引用 broadcastFn。它通过构造函数已有的 `onStatusChange` 回调通知 plugin-service.ts，由后者执行广播。

- [ ] **Step 2: 实现 Worker crash 自动重建**

在 `handleWorkerCrash()` 中：
1. 保留现有 crash 标记逻辑
2. 新增：检查 `handle.trustLevel === 'trusted'`
3. trusted Worker → 记录 crash 计数器（per-plugin，Map）
4. 计数器 < 3 → setTimeout 5s 后重建（createWorker + reloadPlugin）
5. 计数器 ≥ 3 → 放弃，广播 `plugin:crashed`（含 `givingUp: true` 标志）
6. sandbox Worker → 不重建（保持现有逻辑）
7. sidecar 重启时 crash 计数器清零

- [ ] **Step 3: 写权限推送测试**

Mock broadcastFn，验证未授权权限触发推送，审批后继续激活。

- [ ] **Step 4: 写 Worker 重建测试**

模拟 Worker exit，验证 5s 后重建。验证 3 次后放弃。

- [ ] **Step 5: Commit**

```
feat(plugin): add permission push on activation and worker crash rebuild
```

### Task 3: findFiles 实现 (FR-6)

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/package.json` (添加 fast-glob)
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-service.ts` (L281-284 handler)
- Modify: `src-electron/runtime/src/services/plugin-service/api/workspace-api.ts` (deps 更新)
- Create: `src-electron/runtime/test/plugin-findfiles.test.ts`

- [ ] **Step 1: 添加 fast-glob 依赖**

```bash
cd src-electron/runtime && npm install fast-glob
```

- [ ] **Step 2: 实现 findFiles handler**

替换 L281-284 stub：
```typescript
// deps.findFiles = async (pattern: string) => {
//   const entries = await fastGlob(pattern, {
//     cwd: process.cwd(),
//     ignore: ['**/node_modules/**', '**/.git/**'],
//     absolute: true,
//   })
//   return entries.slice(0, 1000)
// }
```

- [ ] **Step 3: 写测试验证**

测试 `**/*.ts` 返回匹配文件，测试 1000 条截断，测试忽略 node_modules/.git。

- [ ] **Step 4: Commit**

```
feat(plugin): implement findFiles with fast-glob
```

---

### Task 4: Hook 事件桥接补全 (FR-8)

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-service.ts` (构造函数中注册 sessionService hook)
- Modify: `src-electron/runtime/src/event-adapter.ts` (EventAdapterOptions 新增 onHookExecute + tool_execution_start/end case 插入 hook 调用)
- Modify: `src-electron/runtime/src/index.ts` (EventAdapter 工厂函数注入 hook 回调)
- Create: `src-electron/runtime/test/plugin-hook-bridge.test.ts`

- [ ] **Step 1: 扩展 EventAdapterOptions 添加 hook 回调接口**

在 `event-adapter.ts` 的 `EventAdapterOptions` 中新增：
```typescript
onHookExecute?: (hookType: string, context: Record<string, unknown>) => Promise<{ blocked?: boolean, reason?: string, transformedContent?: string, transformedParams?: unknown, transformedOutput?: unknown }>
```

在 `index.ts` 的 EventAdapter 工厂函数中注入回调：
```typescript
new EventAdapter(sessionId, interceptor.send, {
  ...existingOptions,
  onHookExecute: (hookType, context) => pluginService.executeHooks(hookType, { ...context, sessionId }),
})
```

- [ ] **Step 2: 在 event-adapter 的 tool_execution_start 前插入 hook**

修改 event-adapter.ts `tool_execution_start` case（~L110）：
- 在翻译事件之前，调用 `this.options.onHookExecute('onBeforeToolCall', { sessionId, toolName, input })`
- 如果返回 `blocked: true` → 不转发前端，改为广播取消事件
- 如果返回 `transformedParams` → 用修改后的 input 替换原始 input
- 如果 `onHookExecute` 未注册（undefined）→ 跳过 hook，直接翻译（保持现有行为）

- [ ] **Step 3: 在 tool_execution_end 后插入 hook**

修改 `tool_execution_end` case（~L120）：
- 翻译事件之后，调用 `this.options.onHookExecute('onAfterToolResult', { sessionId, toolCallId, output })`
- 如果返回 `transformedOutput` → 替换 output
- 如果 `onHookExecute` 未注册 → 跳过

- [ ] **Step 4: 添加 onPiEvent 广播**

在 event-adapter 的 agent_start、agent_end、tool_execution_start、tool_execution_end case 中（翻译后），添加 `this.options.onHookExecute('onPiEvent', { event: eventName, ...data })` 调用。这是 fire-and-forget（不等待返回），不阻塞事件流。

- [ ] **Step 5: 注册 onBeforeSendMessage hook**

在 PluginService 构造函数中：
```typescript
if (deps.sessionService) {
  deps.sessionService.setSendMessageHook(async (sessionId, content) => {
    const result = await this.executeHooks('onBeforeSendMessage', { sessionId, content })
    if (result.blocked) return { blocked: true, reason: result.reason }
    return { content: result.transformedContent ?? content }
  })
}
```

session-service.ts L97-110 已有 hook 执行框架，此处只需注册。

- [ ] **Step 6: 写测试验证**

测试 onBeforeSendMessage 能拦截消息、onBeforeToolCall 能阻止 tool 执行、onAfterToolResult 能修改输出、onPiEvent 能收到事件广播。

- [ ] **Step 7: Commit**

```
feat(plugin): bridge hook events via EventAdapterOptions and sessionService hook
```

---

### Task 5: UI 弹窗 Frontend (FR-4 frontend)

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/composables/usePlugin.ts` (新增 plugin:uiRequest 监听)
- Modify: `src-electron/renderer/src/composables/useExtensionUI.ts` (支持 plugin 来源)
- Modify: `src-electron/renderer/src/components/extension/ExtensionUIDialog.vue` (支持 plugin request)

- [ ] **Step 1: usePlugin.ts 添加 plugin:uiRequest 事件监听**

在 `createPluginHandlers()` 中新增：
```typescript
'plugin:uiRequest': (msg) => {
  extensionUIStore.setActiveRequest({ ...msg.payload, source: 'plugin' })
}
```

- [ ] **Step 2: useExtensionUI.ts 扩展 request 类型**

在 `ExtensionUIRequest` 类型中添加 `source?: 'extension' | 'plugin'` 字段。`sendResponse` 方法根据 source 发送到不同 WS 通道：
- `source === 'plugin'` → 发送 `plugin.uiResponse`
- 默认 → 发送 `extension.ui_response`（现有行为）

- [ ] **Step 3: ExtensionUIDialog.vue 适配**

组件本身不需要大改——它已经支持 confirm/select/input 三种方法。只需确保 dialog 标题/内容能区分 plugin 来源（可选：在标题前缀"插件请求"标识）。

- [ ] **Step 4: Commit**

```
feat(plugin): add frontend UI dialog support for plugin requests
```

---

### Task 6: SDK 类型包 (FR-9)

**Type:** backend

**Files:**
- Create: `packages/plugin-sdk/package.json`
- Create: `packages/plugin-sdk/src/index.ts`
- Create: `packages/plugin-sdk/src/types.ts`
- Create: `packages/plugin-sdk/src/mock.ts`
- Create: `packages/plugin-sdk/tsconfig.json`

- [ ] **Step 1: 创建包结构**

`packages/plugin-sdk/package.json`:
- name: `xyz-agent-plugin-sdk`
- version: `0.1.0`
- main: `src/index.ts`（或编译后 dist/）

- [ ] **Step 2: 从 plugin-types.ts 提取类型**

将 `XyzAgentManifest`、`PluginModule`、`PluginContext`、`Phase2AgentAPI`、`HookContext`、`ToolRegistration`、`PluginStatus` 等类型复制到 `src/types.ts`，重新导出。

- [ ] **Step 3: 创建 mock agentAPI**

`src/mock.ts`: 基于类型的 mock 对象，所有方法返回安全的默认值（undefined/空数组/空字符串），用于本地开发类型检查。

- [ ] **Step 4: 写 README**

简短的安装和使用说明（< 50 行）。

- [ ] **Step 5: Commit**

```
feat(plugin): create xyz-agent-plugin-sdk type package
```

---

### Task 7: Demo 端到端样例插件 (FR-10)

**Type:** backend

**Files:**
- Create: `src-electron/runtime/src/plugins/demo/manifest.yml`
- Create: `src-electron/runtime/src/plugins/demo/index.ts`
- Create: `src-electron/runtime/test/plugin-demo-e2e.test.ts`

- [ ] **Step 1: 创建 manifest.yml**

```yaml
id: xyz-agent-demo
name: Demo Plugin
version: 0.1.0
description: End-to-end demo plugin for testing the plugin system
main: ./index.js
trustLevel: trusted
permissions:
  - storage
  - sessions
  - workspace
  - agent
activationEvents:
  - onStartup
contributes:
  slashCommands:
    - id: demo
      title: /demo
      description: Run demo plugin interaction
  tools:
    - id: demo_search
      name: demo_search
      description: Search for TypeScript files in the workspace
      inputSchema:
        type: object
        properties:
          pattern:
            type: string
            description: Glob pattern to search
        required: [pattern]
```

- [ ] **Step 2: 实现插件**

```typescript
// index.ts
export async function activate(ctx) {
  // 1. 注册 /demo slash command
  ctx.api.tools.register({
    id: 'demo_search',
    name: 'demo_search',
    description: 'Search for TypeScript files',
    inputSchema: { ... },
    handler: async (input) => {
      const files = await ctx.api.workspace.findFiles(input.pattern || '**/*.ts')
      await ctx.api.storage.set('lastSearch', { pattern: input.pattern, count: files.length })
      return { files: files.slice(0, 50) }
    }
  })

  // 2. 监听 onBeforeSendMessage hook
  ctx.api.hooks.onBeforeSendMessage(async (msg) => {
    if (msg.content.includes('!important')) {
      return { transformedContent: msg.content.toUpperCase() }
    }
  })

  // 3. 写 sessionData
  await ctx.api.sessionData.set('activatedAt', new Date().toISOString())
}
```

- [ ] **Step 3: 写端到端测试**

测试：激活 → tool 注册 → findFiles 调用 → hook 拦截 → sessionData 读写 → storage 读写。

- [ ] **Step 4: Commit**

```
feat(plugin): add demo plugin for end-to-end verification
```

---

## Execution Groups

#### BG1: Core Plugin Service (所有 plugin-service.ts 修改)

**Description:** 将 Session API、Agent API、SessionData 持久化、UI 弹窗 backend 的所有 plugin-service.ts 修改集中在同一个 Group。这样做是因为 plugin-service.ts 是单一文件，不能并行修改。其他 Group 不触碰此文件。

**Tasks:** Task 1

**Files (预估):** 10 个文件（6 modify + 4 create test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose × 3 |
| Model | taskComplexity: high |
| 注入上下文 | Task 1 描述（9 steps）、spec FR-1/FR-2/FR-3/FR-4 backend、AC-1/AC-2/AC-3/AC-4 |
| 读取文件 | plugin-service.ts, plugin-types.ts, plugin-storage.ts, api/session-api.ts, api/agent-api.ts, interfaces.ts, index.ts, server.ts |
| 修改/创建文件 | plugin-service.ts, plugin-types.ts, plugin-storage.ts, index.ts, api/session-api.ts, api/agent-api.ts, server.ts, test files |

**Execution Flow (BG1 内部):** 单个 Task，串行执行 9 个 Steps。

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试（4 个测试文件）
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码（9 steps 按序）
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无（注入已有服务，不创建新服务）

---

#### BG2: Plugin Lifecycle (Permission + Worker Rebuild)

**Description:** 权限推送 (FR-5) 和 Worker crash 重建 (FR-7)。这两个功能修改不同文件（plugin-activator.ts 和 plugin-host.ts），不触碰 plugin-service.ts。

**Tasks:** Task 2

**Files (预估):** 4 个文件（2 modify + 2 create test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose × 3 |
| Model | taskComplexity: high |
| 注入上下文 | Task 2 描述、spec FR-5/FR-7、AC-5/AC-7 |
| 读取文件 | plugin-activator.ts, plugin-host.ts, plugin-types.ts (PluginState enum) |
| 修改/创建文件 | plugin-activator.ts, plugin-host.ts, test files |

**Execution Flow:**

  Task 2:
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现
    3. general-purpose → spec 合规检查

**Dependencies:** 无（不依赖 BG1 的 plugin-service.ts 修改）

---

#### BG3: findFiles + Hook Bridging

**Description:** Workspace findFiles (FR-6) 和 Hook 事件桥接 (FR-8)。findFiles 是简单依赖添加 + handler 实现（修改 plugin-service.ts 的 workspace handler 区域，与 BG1 的修改区域不重叠）；Hook 桥接是本 plan 最高风险项——需要在 event-adapter 的翻译流程中通过 EventAdapterOptions 回调插入 hook 调用，并修改 index.ts 注入回调。

**Tasks:** Task 3, Task 4

**Files (预估):** 8 个文件（4 modify + 1 modify package.json + 3 create test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose × 3 |
| Model | taskComplexity: high（Task 4 是最高风险） |
| 注入上下文 | Task 3-4 描述、spec FR-6/FR-8、AC-6/AC-8、event-adapter.ts EventAdapterOptions 模式 |
| 读取文件 | plugin-service.ts (L281-284 workspace handlers), event-adapter.ts, index.ts, session-service.ts (L97-110) |
| 修改/创建文件 | plugin-service.ts (仅 workspace handler 区域), api/workspace-api.ts, event-adapter.ts, index.ts, package.json, test files |

**Execution Flow:**

  Task 3 (findFiles):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现
    3. general-purpose → spec 合规检查

  Task 4 (Hook Bridge, depends on BG1 Task 1 for sessionService hook):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现（高风险，需仔细处理异步 hook + EventAdapterOptions 扩展）
    3. general-purpose → spec 合规检查

**Dependencies:** BG1（Task 4 需要 PluginService 已注入 sessionService 和 deps；index.ts 已被 Task 1 修改，Task 4 在同一文件追加 EventAdapter hook 回调）

---

#### FG1: UI Dialog Frontend

**Description:** 前端 UI 弹窗组件扩展，复用 ExtensionUIDialog 支持 plugin 来源的 UI 请求。

**Tasks:** Task 5

**Files (预估):** 3 个文件（3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose × 2 |
| Model | taskComplexity: medium |
| 注入上下文 | Task 5 描述、spec FR-4、AC-4、前端编码规范（CLAUDE.md xyz-ui 组件规则） |
| 读取文件 | usePlugin.ts, useExtensionUI.ts, ExtensionUIDialog.vue |
| 修改/创建文件 | usePlugin.ts, useExtensionUI.ts, ExtensionUIDialog.vue |

**Execution Flow:**

  Task 5 (depends on BG1 Task 1 backend WS 路由就绪):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能→美化
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1（后端 plugin:uiRequest 广播 + plugin.uiResponse 路由在 Task 1 中实现）

---

#### PG1: SDK + Demo Plugin

**Description:** SDK 类型包 (FR-9) 和端到端 Demo 插件 (FR-10)。SDK 包独立于主项目构建；Demo 插件验证所有 API 端到端可用。

**Tasks:** Task 6, Task 7

**Files (预估):** 10 个文件（8 create + 2 create test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose × 3 |
| Model | taskComplexity: medium |
| 注入上下文 | Task 6-7 描述、spec FR-9/FR-10、AC-9/AC-10、plugin-types.ts 类型列表 |
| 读取文件 | plugin-types.ts, 已有内置插件 manifest 作参考 |
| 修改/创建文件 | packages/plugin-sdk/*, src-electron/runtime/src/plugins/demo/*, test files |

**Execution Flow:**

  Task 6 (SDK, independent):
    1. general-purpose → 创建包结构 + 类型 + mock
    2. general-purpose → spec 合规检查

  Task 7 (Demo Plugin, depends on ALL previous BGs + FG1):
    1. general-purpose → 创建 manifest + 实现
    2. general-purpose → 端到端测试
    3. general-purpose → spec 合规检查

**Dependencies:** BG1 + BG2 + BG3 + FG1（Demo 插件使用所有 API）

---

## Dependency Graph & Wave Schedule

```
BG1 (plugin-service.ts 全部修改) ──┬──→ BG3 (findFiles+Hook Bridge) ──┐
                                    │                                   │
BG2 (Permission+Worker rebuild) ──┤                                   │
                                    │                                   │
                                    └──→ FG1 (UI Dialog Frontend) ─────┼──→ PG1 (SDK+Demo)
                                                                         │
                                    PG1 SDK 部分 (可与 FG1 并行) ────────┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG2 | BG1 是所有 plugin-service.ts 修改的唯一 owner；BG2 修改其他文件 |
| Wave 2 | BG3, FG1 | BG3 依赖 BG1（index.ts + hook 注册）；FG1 依赖 BG1（WS 路由就绪） |
| Wave 3 | PG1 | 依赖所有前置 Group |

**并行约束:** Wave 1 中 BG1 和 BG2 可并行（无文件冲突）。Wave 2 中 BG3 和 FG1 可并行。

---

## Self-Review

### Scope 覆盖声明

- ✅ spec AC-1 至 AC-10 全部标注为 adopted
- ✅ 无 spec 指标被静默忽略
- ✅ 无 scope 缩减

### Task 粒度

- ✅ 无单个 Task 超过 10 步
- ✅ 每个 Task 对应一次 subagent 调度

### 禁止实现代码

- ✅ plan 中只有接口签名和伪代码片段，无完整函数体
- ✅ 代码块用于说明 handler 替换策略，非可直接复制粘贴的实现

### Placeholder scan

- ✅ 无 TBD/TODO/fill in details
- ✅ 所有步骤包含具体操作和文件路径
