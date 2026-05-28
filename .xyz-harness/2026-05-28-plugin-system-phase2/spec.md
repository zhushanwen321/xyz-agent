---
verdict: pass
---

# Plugin System Phase 2: API 完整化 + 安全模型 + 内置插件

## Background

Phase 1（已合并，PR #54）搭建了插件系统骨架：PluginService、PluginRegistry（发现 + Manifest 解析）、PluginHost（Worker Thread 池）、PluginRPC（JSON-RPC 2.0 over MessagePort）、PluginActivator（懒激活状态机）、PluginStorage（KV 持久化）。Phase 1 的 agentAPI 只暴露了最小集（storage、notify、sessions.list、events）。

Phase 2 的目标：让插件能做真正有用的事——注册 tool、slash command、事件 hooks；让 xyz-agent 能区分内置/外部插件并管理依赖关系；用 goal 和 todo 两个真实插件的完整转换验证系统的通用性。

### 关键约束：goal/todo 现状

goal 和 todo 目前是 **pi extension**，运行在 pi 进程内部，直接使用 pi ExtensionAPI（`pi.registerTool()`、`pi.registerCommand()`、`pi.on()`、`pi.appendEntry()`）。转为 xyz-agent plugin 意味着它们需要通过 Worker Thread + RPC 桥接回 pi，这要求建立一个完整的 **Pi Bridge** 适配层。

### 已确认的设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Tool 代理架构 | Pi Bridge Extension | 解耦：插件系统内部 pi-agnostic，bridge 是唯一适配层 |
| 数据持久化 | `sessionData` API（底层通过 bridge 走 pi.appendEntry） | per-session 数据天然跟随 session 生灭，LLM 可直接引用 |
| 内置/外部分类 | `source` 字段：built-in / external | 不改变架构，仅加标记 |
| 插件依赖 | `extensionDependencies` + 安装/激活/卸载时检查 | 最小可行方案，不做依赖解析引擎 |
| 验收范围 | 后端能力就绪，不含前端 UI 管理 | Phase 3 做前端 |

## Functional Requirements

### FR-1: Pi Bridge Extension

**FR-1.1** Bridge 是一个特殊的 pi extension，随 xyz-agent 打包，在 pi 启动时通过 `--extension` 参数注入。

**FR-1.2** Bridge 维护连接状态机：`Disconnected` → `Syncing` → `Ready` → `Disconnected`。启动时 Bridge 异步发起 `extension_ui_request`（method=`bridge:sync`）向 sidecar 请求当前所有已注册插件的 tool/slash command schema，收到响应后进入 `Ready` 状态并调用 `pi.registerTool()` / `pi.registerCommand()` 注册"代理 tool"。sidecar 未就绪时 Bridge 进入 `Disconnected` 状态，pi 正常启动但不注册代理 tool。Bridge 定期重试同步（间隔 2s，最多 30 次）。运行时连接断开后自动降级到 `Disconnected`，sidecar 恢复后重新同步。代理 tool 被调用时若 Bridge 非 Ready 状态，返回错误 "plugin system initializing"。

**FR-1.3** 当 pi LLM 调用代理 tool 时，bridge 的 execute handler 通过 `extension_ui_request` 发出 `bridge:tool_execute` 请求，sidecar 收到后路由到对应 Worker Thread 的插件代码执行，结果原路返回。

**FR-1.4** Bridge 监听 pi 的关键事件（`before_agent_start`、`turn_end`、`message_end`、`agent_end`、`tool_call`、`tool_result`），通过 `extension_ui_request` 的 `bridge:event` 类型转发给 sidecar，sidecar 再广播给所有 Worker。

**FR-1.5** Bridge 提供 `appendEntry` 代理能力，sidecar 通过 `bridge:append_entry` 请求让 bridge 调用 `pi.appendEntry()`，实现插件的 session-scoped 数据持久化。

### FR-2: 完整 agentAPI

在 Phase 1 最小集基础上，扩展 agentAPI 到全部模块。所有新 API 通过 Worker bootstrap 中的代理对象实现，底层走 JSON-RPC 到 sidecar 主线程。

**FR-2.1** `api.tools.register(tool)` — 动态注册 tool，返回 Disposable。Bridge 代理 tool 的 schema 给 pi，execute 请求路由到 Worker。

**FR-2.2** `api.slashCommands.register(cmd)` — 动态注册 slash command。前端 SlashMenu 中出现命令后，用户选择触发 PluginService → Worker 的 execute 调用。

**FR-2.3** `api.hooks.onBeforeSendMessage(handler)` — 消息发送前钩子，可修改内容或阻止发送。

**FR-2.4** `api.hooks.onBeforeToolCall(handler)` — tool 调用前钩子，可修改参数或阻止调用。

**FR-2.5** `api.hooks.onAfterToolResult(handler)` — tool 返回后钩子，可修改结果。

**FR-2.6** `api.hooks.onPiEvent(eventName, handler)` — 只读 pi 事件监听（agent_start/end、tool_execution_start/end、turn_start/end、session_compact）。不可修改事件上下文，handler 仅接收 data 参数无返回值。

**FR-2.6b** `api.hooks.onBeforeAgentStart(handler)` — 可拦截钩子，对应 pi 的 `before_agent_start` 事件。handler 接收 `{ sessionId, systemPrompt }`，可返回 `{ injectedMessages?: Array<{role, content}> }` 向 LLM context 注入额外消息。goal 插件用此注入 steering prompt。

**FR-2.7** `api.sessions` 完整化：
- `list()` — 返回当前所有 session 信息数组
- `get(id)` — 返回指定 session 信息
- `getActive()` — 返回当前活跃 session
- `sendMessage(params: { sessionId?: string, role: 'user' | 'system', content: string })` — 向指定 session（缺省为当前活跃 session）注入消息。role=system 用于插件向 LLM 注入系统提示（不展示给用户），role=user 用于模拟用户输入（触发 LLM 响应）。通过 bridge → pi RPC 转发。
- `onDidCreateSession` — session 创建事件
- `onDidDestroySession` — session 销毁事件

**FR-2.8** `api.config` — get(key)、getAll()、set(key, value)。读写 manifest 中 contributes.settings 声明的配置项。

**FR-2.9** `api.ui` — showSelect、showConfirm、showInput、notify（info/warning/error）、updateStatusBarItem、showEditor。通过 bridge → extension_ui_request → 前端渲染。

**FR-2.10** `api.sessionData` — get(key)、set(key, value)、delete(key)、keys()。Per-session KV 存储，底层通过 bridge 走 pi.appendEntry()。

**FR-2.11** `api.agent`（trusted 专属）— setModel、getModel、getThinkingLevel、setThinkingLevel、getActiveTools。

**FR-2.12** `api.workspace` — rootPath、name、findFiles(pattern)。

### FR-3: Pi 事件桥接

**FR-3.1** PluginService 新增 `executeHooks(hookType, context)` 方法，按顺序执行注册的 hook handler：内置 handlers → trusted 插件 → untrusted 插件。任意 handler 返回 `blocked: true` 终止链。

**FR-3.2** Bridge 转发的 pi 事件通过 PluginService 广播给所有 Worker，Worker 内通过 `api.hooks.onPiEvent()` 通知插件。

**FR-3.3** message:beforeSend 钩子在 session-service.ts 的 sendMessage 流程中执行，允许插件在消息到达 pi 之前修改或阻止。hook 执行超时 5s，超时视为放行（不阻止）。

**FR-3.4** tool:beforeCall 和 tool:afterCall 钩子在 bridge 的 tool execute 代理流程中执行（bridge → sidecar → hooks → Worker execute）。

### FR-4: 安全层 — 权限检查

**FR-4.1** PluginManifest 新增 `permissions: string[]` 字段（Phase 1 类型已有，未使用）。

**FR-4.2** PluginRPC 的 dispatch 方法在调用 handler 前检查调用插件是否持有该 method 对应的权限。无权限返回 `PERMISSION_DENIED` 错误码。

**FR-4.3** 权限映射持久化到 `~/.xyz-agent/plugins/permissions.json`。安装新插件时，PluginService 通过 `extension_ui_request` 推送权限审批请求给前端，用户批准后写入。

**FR-4.4** 零默认信任：sandbox 插件默认无任何权限，所有 API 调用均需显式权限声明。

**FR-4.5** built-in 插件和 trusted 插件默认授予全部权限，无需审批。

### FR-5: Worker 沙箱

**FR-5.1** sandbox 模式 Worker 的 bootstrap 脚本中，覆盖 `require()` 函数：禁止 `fs`、`child_process`、`os`、`net`、`http`、`https`、`crypto`、`dgram`、`cluster`、`worker_threads` 等 Node.js builtins。

**FR-5.2** 允许 require 插件自身目录及其子目录下的模块（包括插件自己的 `node_modules/`）。

**FR-5.3** 所有外部能力只能通过 agentAPI 代理访问。`process.env` 替换为空 proxy。

**FR-5.4** trusted Worker 不做 require 限制（和 Phase 1 行为一致）。

### FR-6: 内置/外部插件区分

**FR-6.1** XyzAgentManifest 新增 `source?: 'built-in' | 'external'` 字段，默认 `external`。

**FR-6.2** PluginRegistry 新增内置扫描路径：`<appResources>/plugins/`（随 app 打包的目录）。

**FR-6.3** built-in 插件不可卸载、不可禁用。PluginService 的 togglePlugin 方法对 built-in 插件返回错误。

**FR-6.4** built-in 插件自动 trusted，不检查 trustLevel 声明。

**FR-6.5** PluginDescriptor 和 WS 消息中携带 `source` 字段，前端可据此区分展示。

### FR-7: 插件依赖关系

**FR-7.1** XyzAgentManifest 新增 `extensionDependencies?: string[]` 字段，格式为 `pluginId@semverRange`（如 `["xyz-plugin-web-search@^1.0.0"]`）。

**FR-7.2** 激活时拓扑排序：PluginActivator 在批量激活前解析依赖图，被依赖的插件先激活。循环依赖检测到后拒绝激活，记录错误。

**FR-7.3** 卸载时检查：若插件 A 依赖插件 B，卸载 B 前检查是否有其他已安装插件依赖 B，有则返回错误提示。

**FR-7.4** 安装时（手动复制目录后 scan）检查：新插件的依赖是否已安装。缺失依赖记录 warning，插件仍可加载但标记状态为 `DEPS_MISSING`。

### FR-8: 内置插件转换 — Goal

**FR-8.1** 将现有 `resources/pi/agent/extensions/goal/` 从 pi extension 重写为 xyz-agent plugin，遵循 plugin manifest 格式。

**FR-8.2** Goal plugin 注册 `goal_manager` tool（10 个 action），通过 `api.tools.register()` + Pi Bridge 代理给 pi。

**FR-8.3** Goal plugin 注册 `/goal` slash command（set/status/pause/resume/clear/update），通过 `api.slashCommands.register()` + Pi Bridge 代理给 pi。

**FR-8.4** Goal plugin 使用 `api.sessionData` 替代 `pi.appendEntry()` 持久化状态。

**FR-8.5** Goal plugin 使用 `api.hooks.onBeforeAgentStart(handler)` 替代 `pi.on('before_agent_start', ...)` 注入 context。handler 返回 injectedMessages，通过 bridge 转发给 pi。

**FR-8.6** Goal plugin 使用 `api.hooks.onPiEvent('agent_end', ...)` 替代 `pi.on('agent_end', ...)` 实现 continuation steering。

**FR-8.7** 前端渲染不变：tool result 仍然通过 `RenderDescriptor` 组件展示 `_render.type === 'task-list'`。

### FR-9: 内置插件转换 — Todo

**FR-9.1** 将现有 `resources/pi/agent/extensions/todo/` 从 pi extension 重写为 xyz-agent plugin。

**FR-9.2** Todo plugin 注册 `todo` tool（5 个 action：list、add、update、delete、clear）。

**FR-9.3** Todo plugin 使用 `api.sessionData` 替代 session entry 恢复机制。

**FR-9.4** Todo plugin 使用 `api.hooks.onPiEvent('session_start', ...)` 替代 `pi.on('session_start', ...)` 恢复状态。

**FR-9.5** 前端渲染不变：复用 `RenderDescriptor` 组件。

## Acceptance Criteria

### AC-1: Bridge 验证
- Bridge extension 在 pi 启动时自动加载，无报错
- Bridge 向 pi 注册代理 tool 后，pi LLM 能在 function call 列表中看到该 tool
- LLM 调用代理 tool 时，请求正确路由到 Worker Thread，插件代码执行，结果返回 pi

### AC-2: agentAPI 验证
- 每个新增 API 模块（tools、slashCommands、hooks、sessions、config、ui、sessionData、agent、workspace）有对应的 RPC handler 注册
- Worker bootstrap 中代理对象构造正确，插件调用能到达主线程 handler
- 所有新增 RPC method 在无权限时返回 `PERMISSION_DENIED`（sandbox 插件场景）

### AC-3: 事件桥接验证
- `message:beforeSend` hook 能修改消息内容（sidecar 验证 transformedContent）
- `message:beforeSend` hook 能阻止消息发送（blocked: true）
- pi 只读事件（agent_start/end、tool_execution_start/end 等）能通过 bridge → sidecar → Worker 到达插件 handler

### AC-4: 权限验证
- sandbox 插件调用需要权限的 API 时返回 `PERMISSION_DENIED` 错误码
- trusted 插件和 built-in 插件不受权限限制
- `permissions.json` 正确持久化和加载

### AC-5: 沙箱验证
- sandbox Worker 中 `require('fs')` 抛异常
- sandbox Worker 中 `process.env` 返回空 proxy
- sandbox Worker 中 `api.storage.get('key')` 正常可用

### AC-6: 内置/外部区分验证
- PluginRegistry 扫描内置路径，产出的 descriptor 含 `source: 'built-in'`
- built-in 插件的 togglePlugin(id, false) 返回错误
- built-in 插件自动 trusted

### AC-7: 依赖验证
- 两个有依赖关系的插件，被依赖者先激活（拓扑排序正确）
- 循环依赖的两个插件都拒绝激活
- 卸载被依赖的插件时返回错误
- `DEPS_MISSING` 作为 PluginState 新枚举值正确加入类型定义，缺失依赖的插件标记此状态

### AC-8: Goal 插件验证
- Goal plugin 在 xyz-agent 启动时自动激活（built-in + onStartupFinished）
- 用户通过 LLM 调用 `goal_manager` tool，action=create_tasks 成功创建任务
- goal state 通过 `api.sessionData` 正确持久化，session 恢复后状态保留
- before_agent_start hook 正确注入 steering prompt，LLM 行为与原 pi extension 一致

### AC-9: Todo 插件验证
- Todo plugin 在 xyz-agent 启动时自动激活
- 用户通过 LLM 调用 `todo` tool，action=add 成功添加 todo
- todo state 通过 `api.sessionData` 持久化，session 恢复后状态保留

## Constraints

- **TypeScript 严格模式**：所有新增代码无 `any` 类型
- **运行环境**：Node.js Worker Thread（Sidecar 内部），非 Electron 主进程
- **通信协议**：JSON-RPC 2.0 over MessagePort（Worker ↔ 主线程），extension_ui_request（bridge ↔ sidecar）
- **pi 版本**：使用 fork 版 xyz-pi@0.75.5-xyz-0.1，不支持原版 pi
- **Phase 1 兼容**：不破坏 Phase 1 已有接口（PluginService、PluginStorage、PluginHost 等）
- **Bridge 通信**：复用现有 extension_ui_request/response 协议，不发明新的跨进程通信方式
- **前端最小改动**：Phase 2 前端仅新增（不改动现有组件）：(1) 插件权限审批对话框（PluginPermissionDialog），(2) 状态栏插件项渲染（AppStatusBar 中新增 plugin 项 slot）。其余 UI 功能（插件管理页面、Settings 面板、消息装饰器）放 Phase 3。api.ui 的 showSelect/showConfirm/showInput 复用现有 ExtensionUIDialog 组件（已支持 confirm/select/input 三种交互），无需新增前端代码
- **sandbox Worker 的 require 净化不使用 VM 模块**：通过覆盖 Module._resolveFilename 实现，保持和 Worker Thread 的兼容性

## 业务用例

### UC-1: 内置 Goal 插件为用户提供任务追踪
- **Actor**: LLM（代表用户意图）
- **场景**: 用户要求 AI 完成一个多步骤任务，LLM 调用 goal_manager tool 创建任务列表
- **预期结果**: 任务列表出现在聊天界面（通过 RenderDescriptor），后续 turn 中 goal hook 注入 steering prompt 引导 LLM 按计划执行

### UC-2: 第三方插件注册自定义 Tool
- **Actor**: 插件开发者
- **场景**: 开发者安装 web-search 插件到 `~/.xyz-agent/plugins/`，插件注册 `webSearch` tool
- **预期结果**: LLM 在 function call 时能看到 webSearch tool，调用后插件 Worker 执行搜索逻辑并返回结果

### UC-3: 插件拦截消息发送
- **Actor**: 安全审计插件
- **场景**: 用户消息包含敏感信息（API key），插件 hook 检测到并阻止发送
- **预期结果**: 消息被阻止，用户收到通知说明原因

### UC-4: 插件依赖安装检查
- **Actor**: 用户（通过手动安装）
- **场景**: 安装插件 A，A 依赖插件 B（尚未安装）
- **预期结果**: PluginService 日志中输出 warning，插件 A 标记为 `DEPS_MISSING`，不激活

## Complexity Assessment

**高复杂度**。Phase 2 涉及 3 个独立进程（pi、sidecar 主线程、Worker Thread）的协同，需要新建 Pi Bridge 适配层、扩展 12 个 API 模块、实现权限系统和沙箱、转换 2 个真实插件。预计工期 10-15 天。

### 错误场景覆盖

| 场景 | 处理方式 |
|------|----------|
| Worker 崩溃（执行 tool 时） | PluginHost crash callback 标记 crashed，tool 调用返回 INTERNAL_ERROR，trusted Worker 自动重建 |
| Bridge 断连（运行时） | Bridge 降级到 Disconnected，代理 tool 返回 "plugin system disconnected"，自动重连 |
| 并发 tool 调用（同一 Worker） | PluginHost 维护请求队列，同一 Worker 内串行执行（按 toolCallId 排队） |
| 插件激活连续失败（3 次） | 标记为 CRASHED，不再自动重试，记录 error log |
| extension_ui_request 无响应（Bridge → sidecar） | 复用现有 5min 超时机制，超时后返回默认错误响应 |

主要风险点：
- Bridge 通过 extension_ui_request 做 tool 代理的延迟和可靠性
- goal 插件重度依赖 pi 内部事件（before_agent_start 的 context 注入），桥接时序可能出问题
- sandbox Worker 的 require 净化可能影响某些合法的 npm 包
