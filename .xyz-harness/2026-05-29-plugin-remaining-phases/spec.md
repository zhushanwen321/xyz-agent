---
verdict: pass
---

# Plugin System Remaining Phases — Spec

## Background

xyz-agent 插件系统已完成 Phase 1-3 + P0 补完（基础设施、API+安全、前端集成、P0 bugfix）。当前 4076 行后端代码、6535 行测试、完整前端 store/UI。

核心问题：**API 层存在大量 stub**——接口定义完整但 handler 返回空值/undefined。插件系统的核心能力（session 交互、持久化、用户交互、权限管理）不可用。同时部分 hook 事件桥接点缺失，前端已有组件未被充分消费。

本 spec 定义 10 项待实现功能，分三档优先级，目标是将插件系统从"框架完整但能力断裂"变为"端到端可用"。

## Functional Requirements

### 第一档：核心断裂修复（必须完成）

#### FR-1: Session API 真实对接

**现状**: `listSessions` 返回 `[]`，`getSession`/`getActiveSession` 返回 `undefined`，`sendMessage` 空操作。

**要求**: 将 4 个 stub handler 替换为对 `ISessionService` 的真实调用。

- `listSessions()` → `sessionService.listPersistedSessions()` 转换为 `SessionInfo[]`
- `getSession(id)` → `sessionService.getSummary(id)` 转换为 `SessionInfo | undefined`
- `getActiveSession()` → 遍历 `sessionService.hasActiveSession()` 找到活跃 session
- `sendMessage(sessionId, role, content)` → `sessionService.sendMessage(sessionId, content)`

**依赖**: PluginService 需接收 `ISessionService` 引用（构造函数注入）。

**涉及文件**: `plugin-service.ts` 中 `registerRpcMethods()` 的 Session handlers 段。

#### FR-2: SessionData 持久化

**现状**: 内存缓存完整（get/set/delete/keys/dirty 跟踪/定时 flush），但 3 处 `flushSessionData` 调用是 `Promise.resolve()` TODO，sidecar 重启后数据丢失。

**要求**: 实现本地文件持久化方案——将 sessionData 写入 `~/.xyz-agent/plugins/session-data/{sessionId}.json`。

- `flushSessionData()`: 遍历 dirty entries，序列化为 JSON 写入对应 session 文件
- `flushSessionDataForSession(sessionId)`: 单 session flush（deactivate 时调用）
- 启动时从文件恢复已有 sessionData 缓存
- 单文件大小上限 10MB（与现有容量限制一致）
- 写入使用 atomic write（write-to-temp + rename）

**不依赖 pi bridge**。原始设计是通过 `pi.appendEntry()` 持久化在 JSONL 中，但该 API 当前不可用。本地文件方案作为独立持久化层，后续 bridge 就绪后可切换。

#### FR-3: Agent API 真实对接

**现状**: `getModel` 返回 `''`，`setModel` 空操作，`getThinkingLevel`/`setThinkingLevel` 返回 `''`，`getActiveTools` 返回 `[]`。

**要求**: 将 5 个 stub handler 替换为对已有服务的真实调用。

- `getModel()` → 从 `IConfigService` 读取默认模型配置（`configService.get('defaultModel')`），无活跃 session 时也返回有效值
- `setModel(provider, modelId)` → 写入 `IConfigService`（`configService.set('defaultModel', { provider, modelId })`），同时如果有活跃 session 则调用 `sessionService.switchModel()`
- `getThinkingLevel()` → 从 `IConfigService` 读取（`configService.get('thinkingLevel')`），默认 `'high'`
- `setThinkingLevel(level)` → 写入 `IConfigService`（`configService.set('thinkingLevel', level)`）
- `getActiveTools()` → 从 `PluginService.toolRegistry` 收集已注册的 tool schema 列表

**依赖**: PluginService 需接收 `IConfigService` 引用。

#### FR-4: UI 弹窗 RPC 路由

**现状**: `showSelect`/`showConfirm`/`showInput` 返回 undefined/true。前端已有 `ExtensionUIDialog.vue` 组件（用于 pi extension 的 confirm/select/input），但 plugin 走不同的 WS 通道。

**要求**: 实现插件 UI 弹窗的完整 RPC 路径。

- PluginService handler 发送 `plugin:uiRequest` WS 消息到前端（包含 sessionId、requestId、method、title/message/options）
- 前端 `usePlugin` composable 监听 `plugin:uiRequest`，复用 `ExtensionUIDialog` 组件渲染弹窗
- 用户响应后发送 `plugin.uiResponse` WS 消息回 sidecar
- PluginService 收到响应后 resolve 对应的 pending Promise
- 超时 60s 未响应自动 resolve 为 undefined（用户无感）
- 同一时刻只允许一个 pending UI request（后来的排队）

**WS 协议**:
- Server→Client: `{ type: 'plugin:uiRequest', payload: { sessionId, requestId, method, title, message?, options? } }`
- Client→Server: `{ type: 'plugin.uiResponse', payload: { requestId, result } }`

**涉及文件**: `plugin-service.ts`（UI handlers）、`server.ts`（WS 路由）、`usePlugin.ts`（前端监听）、`ExtensionUIDialog.vue`（直接复用，通过 props 区分 extension/plugin 来源）。不新建 PluginUIDialog 组件。

#### FR-5: Permission Request 服务端推送

**现状**: 前端 `PermissionDialog` 已就绪（监听 `plugin:permissionRequest` 事件），但 sidecar 从未发送此消息。

**要求**: 在插件激活时检查权限，如缺少权限则推送审批请求。

- `activatePlugin()` 中，加载 manifest.permissions 后检查 `PermissionChecker`
- 如果有未授权的权限，广播 `plugin:permissionRequest` 到前端
- 前端弹窗审批后调用 `plugin.approvePermissions`（已有 handler）
- 审批通过后继续激活；拒绝则标记为 `UNLOADED` + 记录拒绝原因
- 已授权的权限不再重复请求

**涉及文件**: `plugin-activator.ts`（激活流程插入权限检查）、`plugin-service.ts`（broadcast）。

### 第二档：功能补全（推荐完成）

#### FR-6: Workspace findFiles

**现状**: `findFiles(pattern)` 返回空数组 `[]`。

**要求**: 引入 `fast-glob` 依赖，实现项目工作区内的文件搜索。

- `findFiles(pattern)` → `fastGlob(pattern, { cwd: workspaceRoot, ignore: ['**/node_modules/**', '**/.git/**'] })`
- workspace root 从 `process.cwd()` 获取
- 结果限制最多 1000 条（防大项目卡顿）
- pattern 使用 glob 语法（`**/*.ts`、`src/**` 等）

**依赖**: 在 `src-electron/runtime/package.json` 中添加 `fast-glob` 依赖。

#### FR-7: Worker Crash 自动重建

**现状**: trusted Worker 崩溃后仅标记 `CRASHED`，需要重启 sidecar 恢复。两处 TODO（L101、L275）。

**要求**: trusted Worker 崩溃后自动重建并重新加载插件。

- Worker `error`/`exit` 事件触发后：
  1. 标记该 Worker 上所有插件为 `CRASHED`
  2. 推送 `plugin:crashed` 到前端
  3. 等待 5s 冷却期
  4. 创建新 Worker
  5. 重新加载所有 trusted 插件
  6. 标记为 `ACTIVE`，推送 `plugin:statusChange`
- 同一 plugin 在一次 sidecar 生命周期内最多重建 3 次（per-plugin 计数器），超过后该 plugin 标记 `CRASHED` 不再重试，直到 sidecar 重启计数器清零
- sandbox Worker 崩溃不重建（安全考量）

#### FR-8: Hook 事件桥接补全

**现状**: EventAdapter 中只有 `before_agent_start` 通过 `handleBridgeIntercept` 桥接。`onBeforeSendMessage`、`onBeforeToolCall`、`onAfterToolResult`、`onPiEvent` 的触发点未接入。

**要求**: 在 4 个位置插入 hook 拦截调用。

- `onBeforeSendMessage`: 在 `ISessionService.sendMessage()` 内部，调用 pi prompt 前插入 `executeHooks('onBeforeSendMessage', context)`
  - context 包含 `{ sessionId, content }`
  - 支持 `blocked: true`（阻止发送）和 `transformedContent`（修改消息）
- `onBeforeToolCall`: 在 `EventAdapter.translate()` 的 `tool_execution_start` case 前插入
  - context 包含 `{ sessionId, toolName, toolCallId, input }`
  - 支持 `blocked: true`（阻止执行）和 `transformedParams`（修改参数）
- `onAfterToolResult`: 在 `tool_execution_end` case 后插入
  - context 包含 `{ sessionId, toolCallId, output }`
  - 支持 `transformedOutput`（修改返回结果）
- `onPiEvent`: 在 EventAdapter 的每个事件翻译点广播到 plugin 系统
  - 事件：`agent_start`、`agent_end`、`turn_start`、`turn_end`、`tool_execution_start`、`tool_execution_end`、`session_compact`
  - 只读广播，不支持拦截

**涉及文件**: `session-service.ts`（beforeSend）、`event-adapter.ts`（beforeToolCall/afterToolResult/onPiEvent）。

### 第三档：开发者体验（有限实现）

#### FR-9: SDK 类型包

**要求**: 从 `plugin-types.ts` 提取 TypeScript 类型定义，发布为 `xyz-agent-plugin-sdk` npm 包。

- 包含内容：`XyzAgentManifest`、`PluginModule`、`PluginContext`、`AgentAPI`、`HookContext`、`ToolRegistration` 等完整类型
- 包含 `agentAPI` mock 对象（用于本地开发不启动 xyz-agent 即可调试类型）
- 发布到 npm registry（`xyz-agent-plugin-sdk@0.1.0`）
- 包目录结构：`packages/plugin-sdk/`（monorepo 内或独立 repo）

**最小范围**: 类型定义 + mock。不含脚手架、不含文档站。

#### FR-10: 端到端样例插件

**要求**: 创建一个 test plugin 验证完整生命周期。

- 功能：注册 `/demo` slash command + 注册 `demo_search` tool + 监听 `onBeforeSendMessage` hook
- `/demo` 命令：调用 `api.ui.showConfirm('确认执行?')`，确认后调用 `api.sessions.sendMessage()` 发送消息
- `demo_search` tool：调用 `api.workspace.findFiles('**/*.ts')` 返回文件列表
- hook：在消息发送前检查是否包含 `!important`，包含则 `transformedContent` 转大写
- 使用 `api.storage`、`api.config`、`api.sessionData` 存储状态
- 放置在 `src-electron/runtime/src/plugins/demo/`（built-in plugin）

**用途**: 集成测试 + 新开发者参考。

## Acceptance Criteria

### AC-1 (FR-1): Session API 可用性
- `listSessions()` 返回 `ISessionService.listPersistedSessions()` 转换后的 `SessionInfo[]`（无 session 时返回空数组是正确行为）
- `getSession(knownId)` 返回完整的 `SessionInfo | undefined`（找到时非 undefined）
- `sendMessage(sessionId, 'user', 'hello')` 触发 `sessionService.sendMessage()` 调用（可通过 spy 验证调用）
- Session API 的 RPC 往返延迟 < 50ms（有 session 时）

### AC-2 (FR-2): SessionData 持久化
- 写入 sessionData 后重启 sidecar，数据恢复
- flush 写入的 JSON 文件存在于 `~/.xyz-agent/plugins/session-data/`
- 超过 10MB 限制的写入返回错误
- 并发写入不产生数据损坏（atomic write）

### AC-3 (FR-3): Agent API 可用性
- `getModel()` 始终从 `IConfigService` 读取，返回格式 `{ provider: string, modelId: string }` 或默认值
- `setModel('provider', 'model-id')` 写入 config 后 `getModel()` 立即返回新模型（读己之写一致性）
- `getActiveTools()` 返回 `toolRegistry` 中已注册 tool 的 schema 列表（无注册 tool 时返回空数组是正确行为）

### AC-4 (FR-4): UI 弹窗交互
- `showSelect('选择', ['A', 'B'])` 弹出选择对话框，用户选择后返回选中项
- `showConfirm('确认?')` 弹出确认对话框，返回 boolean
- `showInput('输入')` 弹出输入框，返回用户输入
- 60s 超时未响应返回 undefined
- 多个并发请求排队不丢失

### AC-5 (FR-5): 权限审批推送
- 安装需要权限的 sandbox 插件时，前端弹出 PermissionDialog
- 用户批准后插件正常激活
- 用户拒绝后插件标记为 UNLOADED
- 已授权权限不重复请求

### AC-6 (FR-6): findFiles 可用性
- `findFiles('**/*.ts')` 返回工作区内所有 .ts 文件路径
- 忽略 node_modules 和 .git 目录
- 超过 1000 条结果截断

### AC-7 (FR-7): Worker Crash 恢复
- 模拟 trusted Worker 崩溃，5s 后自动重建并恢复插件到 ACTIVE 状态
- 连续崩溃 3 次后停止重试，保持 CRASHED 状态
- sandbox Worker 崩溃不触发重建

### AC-8 (FR-8): Hook 桥接生效
- `onBeforeSendMessage` hook 能拦截/修改用户消息
- `onBeforeToolCall` hook 能拦截/修改 tool 调用参数
- `onAfterToolResult` hook 能修改 tool 返回结果
- `onPiEvent` 能接收到 agent_start/end、tool_execution_start/end 事件

### AC-9 (FR-9): SDK 类型包
- `npm install xyz-agent-plugin-sdk` 后 IDE 自动补全所有类型
- mock agentAPI 的方法签名与真实 API 一致
- 包体积 < 50KB

### AC-10 (FR-10): 样例插件端到端
- demo plugin 在 xyz-agent 启动后自动激活
- `/demo` slash command 出现在 SlashMenu
- 执行 `/demo` 后 UI 弹窗正常交互
- `demo_search` tool 被 LLM 正确调用
- hook 拦截 `!important` 消息并转换

## Constraints

1. **不修改 ISessionService/ISessionService 接口签名** — PluginService 通过依赖注入获取已有服务引用，不新增接口方法
2. **不引入新 WS 库** — 复用现有 WebSocket 通信基础设施（ws-client + event-bus + server.ts）
3. **SessionData 持久化独立于 pi bridge** — 使用本地文件，不依赖 `pi.appendEntry()` API 可用性
4. **UI 弹窗直接复用 ExtensionUIDialog** — 通过 props 区分 extension/plugin 来源，不新建 PluginUIDialog 组件
5. **Worker 重建仅限 trusted** — sandbox Worker 崩溃不重建（安全考量）
6. **Hook 拦截超时 5s** — 每个 handler 超时视为放行（已有实现保持不变）
7. **fast-glob 替代手写 glob** — 不造轮子，用成熟库
8. **SDK 类型包独立于主项目** — 放在 `packages/plugin-sdk/`，独立 npm 包
9. **不修改已通过的测试** — 新增测试覆盖新功能，不修改已有的 6535 行测试

## Out of Scope

本期**不做**以下功能（等有外部需求时再做）：

- npm install 集成（plugin-installer.ts）— 当前 0 个外部插件
- create-xyz-plugin 脚手架 — 唯一开发者是自己
- 开发者文档（developer-guide + api-reference）— 无外部受众
- 压力测试（100 并发插件）— 只有 2 个内置插件
- contributes 声明式渲染（panels/settings/statusBarItems/slashCommands/messageDecorators）
- API 稳定性分层（stable/proposed/internal）
- Worker idle recycling（60s 超时回收）
- 版本兼容性检查（engines.xyz-agent semver）
- 跨 Worker 插件通信（api.events 跨 Worker）
- 插件市场/版本更新

## 业务用例

### UC-1: 插件读写 Session 状态
- **Actor**: 插件开发者
- **场景**: Goal 插件需要在 session 中存储目标进度，并在用户恢复 session 时恢复状态
- **预期结果**: `api.sessionData.set(sessionId, 'progress', {...})` 后重启 sidecar，`api.sessionData.get()` 仍能读取到进度数据

### UC-2: 插件与用户交互确认
- **Actor**: 插件开发者
- **场景**: 插件执行高风险操作前需要用户确认（如删除文件）
- **预期结果**: `api.ui.showConfirm('确认删除?')` 弹出 GUI 对话框，用户选择后插件收到 boolean 结果

### UC-3: 插件拦截消息发送
- **Actor**: 插件开发者
- **场景**: 代码规范插件拦截用户消息中的敏感词，在发送前自动替换
- **预期结果**: `api.hooks.onBeforeSendMessage` handler 返回 `{ transformedContent: modifiedMsg }`，pi 实际收到的是修改后的消息

### UC-4: 插件感知 Agent 模型切换
- **Actor**: 插件开发者
- **场景**: 插件根据当前模型调整行为（如 deepseek 不支持某些 tool）
- **预期结果**: `api.agent.getModel()` 返回当前模型 ID，`api.agent.setModel()` 能切换模型

### UC-5: Sandbox 插件权限审批
- **Actor**: 终端用户
- **场景**: 安装第三方插件时，该插件声明了 `storage` 和 `sessions` 权限
- **预期结果**: 弹出 PermissionDialog 展示权限列表，用户批准后插件激活，拒绝后插件不加载

## Complexity Assessment

| FR | 复杂度 | 预计改动量 | 风险点 |
|----|--------|-----------|--------|
| FR-1 Session API | 低 | ~40 行 | ISessionService 注入时机 |
| FR-2 SessionData flush | 中 | ~80 行 | 并发写入安全、启动恢复 |
| FR-3 Agent API | 低 | ~30 行 | 多 session 时 getModel 的语义 |
| FR-4 UI 弹窗 | 中 | ~100 行 | WS 协议设计、超时处理 |
| FR-5 Permission 推送 | 低 | ~30 行 | 激活流程异步改造 |
| FR-6 findFiles | 低 | ~15 行 | 新增依赖 |
| FR-7 Crash 重建 | 中 | ~60 行 | 重建时序、并发状态 |
| FR-8 Hook 桥接 | 中高 | ~120 行 | event-adapter 插入点、异步 hook 结果回传 |
| FR-9 SDK 包 | 中 | ~200 行（新包） | 类型同步维护 |
| FR-10 样例插件 | 低 | ~100 行（新文件） | 端到端集成 |

**总计**: ~775 行新代码 + 新增 1 个 npm 包

**整体复杂度**: 中等。无架构变更，全部是现有框架内的 handler 替换和集成点补全。最高风险项是 FR-8（Hook 桥接），因为涉及 event-adapter 异步改造。
