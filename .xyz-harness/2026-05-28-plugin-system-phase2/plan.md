---
verdict: pass
complexity: L2
---

# Plugin System Phase 2: API + Bridge + Security + Built-in Plugins

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the plugin system's backend capabilities — full agentAPI, Pi Bridge for cross-process tool/event proxy, permission system, Worker sandbox — and validate by converting goal and todo from pi extensions to xyz-agent built-in plugins.

**Architecture:** Three-layer decoupling:
1. **Pi Bridge Extension** (pi-side): Registers proxy tools/commands with pi, forwards execute requests to sidecar via `extension_ui_request`
2. **Sidecar PluginRPC** (routing): Receives requests from Bridge and Workers, routes tool execute to the correct Worker, manages hook execution pipeline
3. **Worker Thread** (execution): Plugin code runs here, calls agentAPI which proxies back to PluginRPC via MessagePort

Bridge is the ONLY module that knows about pi. Everything else is pi-agnostic.

**Tech Stack:** TypeScript, Node.js Worker Threads, JSON-RPC 2.0 over MessagePort, pi ExtensionAPI (bridge only)

---

## Sub-documents

| Document | Content |
|----------|---------|
| `plan-backend.md` | Detailed backend design per task, data flows, protocol specs |
| `plan-api-contract.md` | Interface signatures, message formats, AC coverage matrix |
| `plan-frontend.md` | Component specs for permission dialog + status bar |

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `runtime/src/services/plugin-service/plugin-types.ts` | modify | BG1 | 扩展 source 字段、DEPS_MISSING 状态、权限类型 |
| `runtime/src/services/plugin-service/plugin-registry.ts` | modify | BG1 | built-in 扫描路径、source 标记 |
| `runtime/src/services/plugin-service/plugin-host.ts` | modify | BG1 | sandbox bootstrap 脚本 |
| `runtime/src/services/plugin-service/plugin-permission.ts` | create | BG1 | PermissionChecker 类 |
| `runtime/src/services/plugin-service/plugin-permission-storage.ts` | create | BG1 | permissions.json 读写 |
| `test/plugin-service/plugin-foundation.test.ts` | create | BG1 | types + registry + permission 测试 |
| `test/plugin-service/plugin-sandbox.test.ts` | create | BG1 | sandbox require 拦截测试 |
| `runtime/src/services/plugin-service/api/tool-api.ts` | create | BG2 | tool register RPC handler + Worker proxy |
| `runtime/src/services/plugin-service/api/hook-api.ts` | create | BG2 | hook RPC handlers + Worker proxy |
| `runtime/src/services/plugin-service/plugin-rpc-server.ts` | modify | BG2 | 注册新 tool/hook RPC handlers |
| `runtime/src/services/plugin-service/plugin-bootstrap.ts` | modify | BG2 | 新增 tool/hook 代理对象 |
| `test/plugin-service/plugin-api-tools.test.ts` | create | BG2 | tool API 测试 |
| `test/plugin-service/plugin-api-hooks.test.ts` | create | BG2 | hook API 测试 |
| `resources/pi/agent/extensions/bridge/index.ts` | create | BG3 | Bridge 入口 + 连接状态机 |
| `resources/pi/agent/extensions/bridge/src/sync-protocol.ts` | create | BG3 | bridge:sync 请求/响应协议 |
| `resources/pi/agent/extensions/bridge/src/tool-proxy.ts` | create | BG3 | 代理 tool 注册 + execute 转发 |
| `resources/pi/agent/extensions/bridge/src/event-forwarder.ts` | create | BG3 | pi 事件监听 + 转发到 sidecar |
| `resources/pi/agent/extensions/bridge/src/session-data-proxy.ts` | create | BG3 | appendEntry 代理 |
| `runtime/src/server.ts` | modify | BG3 | Bridge 消息路由（sync/execute/event/intercept/append_entry） |
| `runtime/src/event-adapter.ts` | modify | BG3 | Bridge 事件类型处理 |
| `test/plugin-service/bridge-sync.test.ts` | create | BG3 | Bridge 同步协议测试 |
| `test/plugin-service/bridge-tool-proxy.test.ts` | create | BG3 | Bridge tool 代理测试 |
| `runtime/src/services/plugin-service/api/session-api.ts` | create | BG4 | sessions RPC handler + Worker proxy |
| `runtime/src/services/plugin-service/api/config-api.ts` | create | BG4 | config RPC handler + Worker proxy |
| `runtime/src/services/plugin-service/api/session-data-api.ts` | create | BG4 | sessionData RPC handler + Worker proxy |
| `runtime/src/services/plugin-service/api/ui-api.ts` | create | BG4 | ui RPC handler + Worker proxy |
| `runtime/src/services/plugin-service/api/agent-api.ts` | create | BG4 | agent RPC handler + Worker proxy |
| `runtime/src/services/plugin-service/api/workspace-api.ts` | create | BG4 | workspace RPC handler + Worker proxy |
| `runtime/src/services/plugin-service/plugin-rpc-server.ts` | modify | BG4 | 注册 extended API handlers |
| `runtime/src/services/plugin-service/plugin-bootstrap.ts` | modify | BG4 | 新增 extended API 代理对象 |
| `test/plugin-service/plugin-api-extended.test.ts` | create | BG4 | sessions/config/sessionData/ui/agent/workspace 测试 |
| `runtime/src/services/plugin-service/plugin-service.ts` | modify | BG5 | hook 执行管道 + bridge 路由方法 |
| `runtime/src/services/plugin-service/plugin-activator.ts` | modify | BG5 | 拓扑排序 + 循环检测 + DEPS_MISSING |
| `runtime/src/services/session-service.ts` | modify | BG5 | beforeSend hook 集成 |
| `test/plugin-service/plugin-hooks-integration.test.ts` | create | BG5 | hook 执行管道集成测试 |
| `test/plugin-service/plugin-dependencies.test.ts` | create | BG5 | 依赖排序 + 循环检测测试 |
| `resources/plugins/goal/package.json` | create | BG6 | Goal plugin manifest |
| `resources/plugins/goal/index.ts` | create | BG6 | Goal plugin 入口 |
| `resources/plugins/goal/src/goal-tool.ts` | create | BG6 | goal_manager tool handler（10 actions） |
| `resources/plugins/goal/src/goal-hooks.ts` | create | BG6 | beforeAgentStart + agentEnd hooks |
| `resources/plugins/goal/src/goal-state.ts` | create | BG6 | sessionData 状态管理 |
| `test/plugin-service/plugin-goal.test.ts` | create | BG6 | Goal plugin 端到端测试 |
| `resources/plugins/todo/package.json` | create | BG7 | Todo plugin manifest |
| `resources/plugins/todo/index.ts` | create | BG7 | Todo plugin 入口 |
| `resources/plugins/todo/src/todo-tool.ts` | create | BG7 | todo tool handler（5 actions） |
| `resources/plugins/todo/src/todo-state.ts` | create | BG7 | sessionData 状态管理 |
| `test/plugin-service/plugin-todo.test.ts` | create | BG7 | Todo plugin 端到端测试 |
| `renderer/components/plugin/PluginPermissionDialog.vue` | create | FG1 | 插件权限审批对话框 |
| `renderer/components/layout/AppStatusBar.vue` | modify | FG1 | 新增 plugin 状态栏项 slot |
| `renderer/test/PluginPermissionDialog.test.ts` | create | FG1 | 权限对话框测试 |

> 路径前缀说明：`runtime/` = `src-electron/runtime/`（展开如 `runtime/src/services/...` → `src-electron/runtime/src/services/...`）。`renderer/` = `src-electron/renderer/src/`（展开如 `renderer/components/...` → `src-electron/renderer/src/components/...`）。`resources/` = 项目根目录下。`test/` = `src-electron/runtime/test/`

---

## Task List

| # | Task | Type | Depends on | Group | Wave |
|---|------|------|-----------|-------|------|
| 1 | Plugin types expansion + built-in scan + registry | backend | — | BG1 | 1 |
| 2 | Worker sandbox (require restriction) | backend | — | BG1 | 1 |
| 3 | Permission checker service | backend | 1 | BG1 | 1 |
| 4 | AgentAPI: tools + hooks RPC handlers | backend | 1 | BG2 | 2 |
| 5 | Pi Bridge Extension | backend | 1 | BG3 | 2 |
| 6 | AgentAPI: extended APIs (sessions, config, sessionData, ui, agent, workspace) | backend | 4 | BG4 | 3 |
| 7 | Hook execution pipeline + plugin dependencies | backend | 4, 5 | BG5 | 3 |
| 8 | Goal plugin conversion | backend | 5, 6, 7 | BG6 | 4 |
| 9 | Todo plugin conversion | backend | 5, 6, 7 | BG7 | 4 |
| 10 | Frontend: permission dialog + status bar plugin item | frontend | 3 | FG1 | 4 |

---

## Interface Contracts

### Module: PluginTypes

| Type | Fields | Spec Ref |
|------|--------|----------|
| `PluginSource` | `'built-in' \| 'external'` | FR-6.1 |
| `PluginState` (扩展) | 新增 `'DEPS_MISSING' \| 'CRASHED'` | FR-7.4 |
| `XyzAgentManifest` (扩展) | `source?: PluginSource`, `extensionDependencies?: string[]` | FR-6.1, FR-7.1 |
| `Permission` | string literal union — 具体 permission 常量 | FR-4.1 |

### Module: PermissionChecker

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| check | `(pluginId: string, method: string) => boolean` | boolean | built-in/trusted → true; unknown method → false | AC-4 |
| grant | `(pluginId: string, permissions: string[]) => void` | void | — | FR-4.3 |
| revoke | `(pluginId: string) => void` | void | — | — |
| load | `() => Promise<void>` | void | file not exist → empty map | FR-4.3 |
| save | `() => Promise<void>` | void | — | FR-4.3 |

### Module: PluginRPC (新增 handlers)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| tool_register | `(pluginId: string, tool: ToolRegistration) => string` | toolKey | permission denied → PERMISSION_DENIED | AC-2 |
| slashCommand_register | `(pluginId: string, cmd: CommandRegistration) => string` | cmdKey | — | AC-2 |
| hook_register | `(pluginId: string, hookType: HookType, handlerId: string) => void` | void | — | AC-3 |
| sessionData_get | `(sessionId: string, key: string) => Promise<unknown>` | T \| undefined | key not exist → undefined | AC-8/9 |
| sessionData_set | `(sessionId: string, key: string, value: unknown) => Promise<void>` | void | — | AC-8/9 |
| sessionData_delete | `(sessionId: string, key: string) => Promise<void>` | void | — | — |
| sessionData_keys | `(sessionId: string) => Promise<string[]>` | string[] | no data → [] | — |

### Module: BridgeProtocol (extension_ui_request 子类型)

| Method | Request Format | Response Format | Edge Cases | Spec Ref |
|--------|---------------|----------------|------------|----------|
| bridge:sync | `{method: 'bridge:sync'}` | `{tools: ToolSchema[], commands: CommandSchema[]}` | sidecar not ready → empty arrays | FR-1.2 |
| bridge:tool_execute | `{method: 'bridge:tool_execute', toolName, toolCallId, params, sessionId}` | `{content, details?, isError?}` | plugin not found → INTERNAL_ERROR | FR-1.3 |
| bridge:event | `{method: 'bridge:event', eventName, data, sessionId}` | 无响应（单向） | — | FR-1.4 |
| bridge:intercept | `{method: 'bridge:intercept', eventName, data, sessionId}` | `{injectedMessages?}` | handler not found → null | FR-2.6b |
| bridge:append_entry | `{method: 'bridge:append_entry', type, data, sessionId}` | `{success: boolean}` | — | FR-1.5 |

### Module: PluginService (新增方法)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| executeHooks | `(hookType: string, context: HookContext) => Promise<HookResult>` | HookResult | handler throws → log + continue; blocked → stop chain | FR-3.1 |
| syncToolsToBridge | `() => Promise<void>` | void | bridge not ready → no-op | FR-1.2 |
| handleBridgeToolExecute | `(request: BridgeToolRequest) => Promise<BridgeToolResult>` | BridgeToolResult | plugin crashed → INTERNAL_ERROR | FR-1.3 |
| togglePlugin | `(id: string, enabled: boolean) => Promise<void>` | void | built-in → throw error | AC-6 |

### Module: PluginActivator (扩展)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| activateWithDeps | `(plugins: PluginDescriptor[]) => Promise<void>` | void | cycle → reject all; missing deps → DEPS_MISSING | AC-7 |
| topologicalSort | `(plugins: PluginDescriptor[]) => PluginDescriptor[]` | sorted array | cycle detected → throw | FR-7.2 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 (Bridge) | BridgeProtocol.bridge:sync/execute | Bridge → sidecar → PluginRPC → Worker → back | Task 5 |
| AC-2 (agentAPI) | PluginRPC.tool_register/hook_register | Worker → PluginRPC → handler | Task 4, 6 |
| AC-3 (event bridge) | PluginService.executeHooks | pi event → Bridge → sidecar → executeHooks → Workers | Task 7 |
| AC-4 (permissions) | PermissionChecker.check | Worker RPC → PluginRPC dispatch → PermissionChecker | Task 3 |
| AC-5 (sandbox) | PluginHost sandbox bootstrap | Worker require → _resolveFilename → block/allow | Task 2 |
| AC-6 (built-in) | PluginRegistry.scan + PluginService.togglePlugin | scan → mark source → toggle guard | Task 1 |
| AC-7 (deps) | PluginActivator.topologicalSort | scan → build graph → sort → activate | Task 7 |
| AC-8 (Goal) | goal_manager tool + onBeforeAgentStart hook | goal Worker → tool RPC → bridge → pi | Task 8 |
| AC-9 (Todo) | todo tool + sessionData | todo Worker → tool RPC → bridge → pi | Task 9 |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1 Bridge 验证 | adopted | Task 5 |
| AC-2 agentAPI 验证 | adopted | Task 4, 6 |
| showEditor (FR-2.9) | postponed | Phase 3：需要专用编辑器面板前端组件，超出 Phase 2 前端最小改动范围。api.ui 的 showSelect/showConfirm/showInput/notify 在 Phase 2 实现 |
| AC-3 事件桥接验证 | adopted | Task 7 |
| AC-4 权限验证 | adopted | Task 3 |
| AC-5 沙箱验证 | adopted | Task 2 |
| AC-6 内置/外部区分 | adopted | Task 1 |
| AC-7 依赖验证 | adopted | Task 7 |
| AC-8 Goal 插件验证 | adopted | Task 8 |
| AC-9 Todo 插件验证 | adopted | Task 9 |

---

## Execution Groups

#### BG1: Plugin Foundation

**Description:** 类型系统扩展 + built-in 扫描 + sandbox + 权限检查器。这些是所有后续 Task 的基础依赖。

**Tasks:** Task 1, Task 2, Task 3

**Files (预估):** 7 个文件（2 create src + 3 modify + 2 test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity 自动选择（executor: high, tdd-coder: medium） |
| 注入上下文 | Task 1-3 描述 + spec FR-4/5/6/7 + plugin-types.ts 全文 |
| 读取文件 | `runtime/src/services/plugin-service/plugin-types.ts`, `plugin-registry.ts`, `plugin-host.ts`, `plugin-rpc-server.ts`, `plugin-bootstrap.ts` |
| 修改/创建文件 | 见 File Structure 表 BG1 行 |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1 (types + registry):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (sandbox):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

  Task 3 (permission, depends on Task 1):
    1. general-purpose → 写失败测试
    2. general-purpose → 写实现代码
    3. general-purpose → spec 合规检查

**Dependencies:** 无

**设计细节:** 见 plan-backend.md §1

---

#### BG2: AgentAPI — Tools + Hooks

**Description:** 核心 agentAPI 模块：tool 注册/执行、slash command 注册、5 种 hook 类型。这些是 Bridge 代理和内置插件的基础。

**Tasks:** Task 4

**Files (预估):** 6 个文件（2 create src + 2 modify + 2 test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity 自动选择 |
| 注入上下文 | Task 4 描述 + spec FR-2.1/2.2/2.3/2.4/2.5/2.6/2.6b + Interface Contracts 中 PluginRPC 和 BridgeProtocol 章节 |
| 读取文件 | `plugin-rpc-server.ts`, `plugin-bootstrap.ts`, `plugin-types.ts` |
| 修改/创建文件 | 见 File Structure 表 BG2 行 |

**Execution Flow:** 单 Task，TDD 流程。

**Dependencies:** BG1（需要新的类型定义）

**设计细节:** 见 plan-backend.md §2

---

#### BG3: Pi Bridge Extension

**Description:** 最关键的架构组件——连接 pi 和 xyz-agent 的唯一适配层。包含连接状态机、tool proxy、event forwarder、sessionData proxy。

**Tasks:** Task 5

**Files (预估):** 9 个文件（7 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: high（架构关键组件） |
| 注入上下文 | Task 5 描述 + spec FR-1 全部 + BridgeProtocol 接口签名 + event-adapter.ts 中 extension_ui_request 处理逻辑 + server.ts 中 extension.ui_response 处理逻辑 |
| 读取文件 | `server.ts`, `event-adapter.ts`, `session-service.ts`（getExtensionPaths）, `rpc-client.ts`（spawn args）, `resources/pi/agent/extensions/goal/index.ts`（pi extension 入口参考） |
| 修改/创建文件 | 见 File Structure 表 BG3 行 |

**Execution Flow:** 单 Task，TDD 流程。

**Dependencies:** BG1（需要类型定义）

**设计细节:** 见 plan-backend.md §3

---

#### BG4: AgentAPI — Extended APIs

**Description:** 剩余 agentAPI 模块：sessions、config、sessionData、ui、agent、workspace。这些 API 不直接依赖 Bridge，但 sessionData 和 ui 的 RPC handler 需要与 Bridge 通信。

**Tasks:** Task 6

**Files (预估):** 9 个文件（7 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity 自动选择 |
| 注入上下文 | Task 6 描述 + spec FR-2.7/2.8/2.9/2.10/2.11/2.12 + Interface Contracts 中 PluginRPC 章节 |
| 读取文件 | `plugin-rpc-server.ts`（BG2 修改后版本）, `plugin-bootstrap.ts`（BG2 修改后版本） |
| 修改/创建文件 | 见 File Structure 表 BG4 行 |

**Execution Flow:** 单 Task，TDD 流程。

**Dependencies:** BG2（需要 RPC server 和 bootstrap 的 tool/hook 注册已完成）

**设计细节:** 见 plan-backend.md §4

---

#### BG5: Integration + Dependencies

**Description:** 将所有组件集成：hook 执行管道（pi event → PluginService → Workers）、sendMessage beforeSend 拦截、插件依赖拓扑排序。

**Tasks:** Task 7

**Files (预估):** 5 个文件（0 create src + 3 modify + 2 test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: high |
| 注入上下文 | Task 7 描述 + spec FR-3 + FR-7 + PluginService.executeHooks 接口签名 + PluginActivator.topologicalSort 接口签名 + BridgeProtocol 事件格式 |
| 读取文件 | `plugin-service.ts`, `plugin-activator.ts`, `session-service.ts`, `server.ts`（BG3 修改后版本） |
| 修改/创建文件 | 见 File Structure 表 BG5 行 |

**Execution Flow:** 单 Task，TDD 流程。

**Dependencies:** BG2（hook RPC handlers）+ BG3（Bridge event forwarding）

**设计细节:** 见 plan-backend.md §5

---

#### BG6: Goal Plugin Conversion

**Description:** 将现有 pi extension goal 完整转换为 xyz-agent built-in plugin。10 个 tool action + 2 个 hooks + sessionData 状态管理。

**Tasks:** Task 8

**Files (预估):** 6 个文件（5 create + 1 test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: high（最大的单 Task，需要完整理解原 pi extension 逻辑） |
| 注入上下文 | Task 8 描述 + spec FR-8 全部 + 原始 goal extension 完整逻辑描述 + agentAPI tool/hook/sessionData 接口 + pi.registerTool 参数格式 → api.tools.register 映射关系 |
| 读取文件 | `resources/pi/agent/extensions/goal/index.ts`, `resources/pi/agent/extensions/goal/src/*.ts`, `runtime/src/services/plugin-service/api/tool-api.ts`, `api/hook-api.ts`, `api/session-data-api.ts` |
| 修改/创建文件 | 见 File Structure 表 BG6 行 |

**Execution Flow:** 单 Task，TDD 流程。

**Dependencies:** BG3（Bridge tool proxy）+ BG4（sessionData API）+ BG5（hook pipeline）

**设计细节:** 见 plan-backend.md §6

---

#### BG7: Todo Plugin Conversion

**Description:** 将现有 pi extension todo 转换为 xyz-agent built-in plugin。5 个 tool action + sessionData 状态管理。比 goal 简单。

**Tasks:** Task 9

**Files (预估):** 5 个文件（4 create + 1 test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity 自动选择 |
| 注入上下文 | Task 9 描述 + spec FR-9 全部 + 原始 todo extension 逻辑 + agentAPI 接口 |
| 读取文件 | `resources/pi/agent/extensions/todo/index.ts`, `resources/pi/agent/extensions/todo/src/*.ts` |
| 修改/创建文件 | 见 File Structure 表 BG7 行 |

**Execution Flow:** 单 Task，TDD 流程。

**Dependencies:** BG3 + BG4 + BG5（同 BG6）

**设计细节:** 见 plan-backend.md §7

---

#### FG1: Frontend Minimal

**Description:** Phase 2 前端最小改动——权限审批对话框 + 状态栏插件项。复用现有 ExtensionUIDialog 组件，不新增通用组件。

**Tasks:** Task 10

**Files (预估):** 3 个文件（1 create + 1 modify + 1 test）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 10 描述 + xyz-ui 组件库规范 + 现有 ExtensionUIDialog 组件路径 + AppStatusBar 组件结构 |
| 读取文件 | `renderer/components/ExtensionUIDialog.vue`, `renderer/components/layout/AppStatusBar.vue`, `docs/standards.md` |
| 修改/创建文件 | 见 File Structure 表 FG1 行 |

**Execution Flow:** 单 Task，骨架→功能→美化。

**Dependencies:** BG1（PermissionChecker 接口 + WS 消息格式）

**设计细节:** 见 plan-frontend.md §1

---

## Dependency Graph & Wave Schedule

```
BG1 (Foundation) ──┬──→ BG2 (Tools+Hooks API) ──→ BG4 (Extended APIs) ──┬──→ BG6 (Goal)
                    │                                                           │
                    ├──→ BG3 (Pi Bridge) ──────────────────→ BG5 (Integration) ──┤
                    │                                                           │
                    └──→ FG1 (Frontend)                                         └──→ BG7 (Todo)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 基础类型 + sandbox + 权限，无依赖 |
| Wave 2 | BG2, BG3, FG1 | BG2/BG3 依赖 BG1；FG1 仅依赖 BG1 的类型定义。BG2 和 BG3 可并行（不同文件） |
| Wave 3 | BG4, BG5 | BG4 依赖 BG2；BG5 依赖 BG2 + BG3 |
| Wave 4 | BG6, BG7 | 都依赖 BG3 + BG4 + BG5。可并行 |

**并行约束:**
- Wave 2: BG2 和 BG3 修改不同文件，可并行。FG1 也修改不同文件，可并行。最多 3 个 subagent。
- Wave 4: BG6 和 BG7 完全独立文件，可并行。
