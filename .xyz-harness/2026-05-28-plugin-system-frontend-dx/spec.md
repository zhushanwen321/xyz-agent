---
verdict: pass
---

# Plugin System: 前端集成 + 质量补强 + 后端 Stub 修复

## Background

Phase 1（PR #54）搭建了插件系统骨架：PluginService、PluginRegistry、PluginHost（Worker Thread 池）、PluginRPC（JSON-RPC 2.0 over MessagePort）、PluginActivator（懒激活状态机）、PluginStorage（KV 持久化）。

Phase 2（当前分支）实现了完整 agentAPI（12 个模块）、Pi Bridge Extension、权限检查、Worker 沙箱、内置/外部区分、依赖关系、Goal/Todo 插件转换。

**当前问题：**
1. 前端无法管理插件——没有 Plugin Store（Pinia）、没有 PluginsPane、没有 Settings 表单、没有消息装饰器、没有 SlashMenu 集成
2. 关键后端方法是 stub——`handleBridgeToolExecute` 返回固定 `{ success: true }`，tool 未路由到 Worker；`executeHooks` 是 fire-and-forget，不等待 Worker 响应
3. 质量缺口——无热重载、sessionData 无缓存兜底、Goal/Todo 无独立测试、Bridge 重连无自动化测试

**设计文档参考：**
- `docs/architecture/plugin-system-plan.md` — Phase 3/4 完整路线图
- `docs/architecture/plugin-system-design-part1.md` / `part2.md` — 融合设计报告
- `.xyz-harness/2026-05-28-plugin-system-phase2/spec.md` — Phase 2 spec

## Functional Requirements

### A. 后端 Stub 修复

#### FR-A1: handleBridgeToolExecute 路由到 Worker

`plugin-service.ts` 中的 `handleBridgeToolExecute` 当前返回固定 stub。需改为：
1. 在 `toolRegistry` 中根据 `toolName` 查找注册该 tool 的插件 ID
2. 通过 RPC `invoke` 向对应 Worker 发送 `plugin.tool.execute` 请求（携带 `toolName`、`arguments`、`sessionId`）
3. 等待 Worker 执行结果（超时 30s），返回 `BridgeToolExecuteResponse`
4. Worker 内 tool handler 执行完成后通过 RPC response 返回结果

**错误处理：**
- 找不到 tool → `{ content: 'Tool not found', isError: true }`
- Worker 崩溃 → `{ content: 'Plugin worker crashed', isError: true }`
- RPC 超时（30s）→ `{ content: 'Plugin tool execution timed out', isError: true }`
- Worker 内执行异常 → 捕获并返回 `{ content: error.message, isError: true }`

#### FR-A2: executeHooks 串行化

`executeHooks` 当前通过 `broadcast` 通知所有 Worker 后立即返回 `{ blocked: false }`。需改为：
1. 收集所有注册了该 hookType 的 Worker 列表（按 priority 排序：内置 → trusted → sandbox）
2. 串行 `await` 每个 Worker 的 `plugin.hooks.invoke` RPC 调用
3. 检查每个 Worker 的返回值：若 `blocked: true`，立即终止链并返回 `{ blocked: true, blockedBy: pluginId }`
4. 若 handler 返回 `transformedContent`/`transformedParams`/`transformedOutput`，合并到 context 传递给下一个 handler
5. 全部通过后返回最终结果
6. 单个 Worker 超时（5s）视为放行，不阻塞链

### B. 前端集成（Phase 3）

#### FR-B1: Plugin Pinia Store + WS 消息扩展

**Pinia Store**（`stores/plugin.ts`）：
- `installedPlugins: PluginInfo[]` — 已安装插件列表
- `pluginStatuses: Map<string, string>` — 插件 ID → 状态映射
- `pluginNotifications: PluginNotification[]` — 插件通知队列（最近 50 条）
- `permissionRequests: Map<string, string[]>` — 待审批的权限请求
- Actions：`fetchPlugins()`、`togglePlugin(id, enabled)`、`approvePermissions(id, perms)`、`revokePermissions(id)`
- 初始化时发送 `plugin.list` 获取插件列表，监听 `config.plugins` 更新

**WS 消息扩展**（`shared/src/protocol.ts`）：

Client → Server **已有**（本期前端首次接入）：
- `plugin.list` — `Record<string, never>` → 获取插件列表
- `plugin.toggle` — `{ pluginId: string, enabled: boolean }` → 启用/禁用插件

Client → Server **新增**：
- `plugin.install` — `{ packageSpec: string }` → 触发 npm install（Phase 4 实现，本期预留 type）
- `plugin.uninstall` — `{ pluginId: string }` → 卸载插件
- `plugin.approvePermissions` — `{ pluginId: string, permissions: string[] }` → 批准权限
- `plugin.revokePermissions` — `{ pluginId: string }` → 撤销全部权限
- `plugin.executeCommand` — `{ pluginId: string, commandId: string, args?: Record<string, unknown> }` → 执行插件命令（slash command 或状态栏点击）
- `plugin.config.get` — `{ pluginId: string, key: string }` → 读取插件配置项
- `plugin.config.set` — `{ pluginId: string, key: string, value: unknown }` → 写入插件配置项

Server → Client **已有**（本期前端首次处理）：
- `config.plugins` — 插件列表响应（sidecar 在 `plugin.list` 回复和初始化推送时使用）
- `plugin:crashed` — 插件崩溃通知
- `plugin:notification` — 插件通知

Server → Client **新增**：
- `plugin:statusChange` — `{ pluginId, oldStatus, newStatus }` — 状态变更推送
- `plugin:permissionRequest` — `{ pluginId, permissions }` — 权限审批请求
- `plugin:statusBarUpdate` — `{ items: StatusBarItem[] }` — 状态栏项更新（替换现有 AppStatusbar 中的 `plugin:status_bar_update`）
- `plugin:messageDecoration` — `{ sessionId, messageId, decorations }` — 消息装饰器数据
- `plugin:config` — `{ pluginId, config: Record<string, unknown> }` — 配置值响应（对应 `plugin.config.get`/`plugin.config.set`）

**WS 消息格式约定**：
- Client → Server：点号分隔（`plugin.list`、`plugin.toggle`、`plugin.install`），与现有 `session.create` 等一致
- Server → Client（plugin 前缀）：冒号分隔（`plugin:crashed`、`plugin:statusChange`），与现有 `plugin:crashed`/`plugin:notification` 一致
- Server → Client（config 前缀）：点号分隔（`config.plugins`），与现有 `config.providers` 等一致
- 不做统一 `plugin:action` 路由

**命名风格**：Server→Client 的 `plugin:` 前缀消息使用 camelCase（如 `plugin:statusChange`，不用 `plugin:status_change`），与 `plugin:notification`/`plugin:crashed` 风格一致。现有 AppStatusbar 中的 `plugin:status_bar_update` 需改为 `plugin:statusBarUpdate`。

#### FR-B2: PluginsPane 插件管理 UI

修改已有的 `ExtensionsPane.vue` 模式，创建 `PluginsPane.vue`：
- 已安装插件列表（名称、版本、状态 badge、信任等级 badge、来源标签）
- 启用/禁用 Toggle（built-in 插件不可操作，灰显）
- 卸载按钮（built-in 不可卸载）+ 确认对话框
- 插件详情展开区（权限列表、激活事件、contributions、错误信息）
- 信任等级切换（sandbox → trusted 需二次确认对话框）
- 空状态（无插件时的引导提示）
- 手动添加路径入口（仅显示，不实现文件选择——Phase 4 做）

#### FR-B3: PluginSettingsForm 动态配置表单

基于 manifest `contributes.settings` schema 动态渲染：
- 支持的字段类型：string（文本）、number（数字）、boolean（Toggle）、enum（Select）、path（文本 + 未来文件选择）
- 配置值通过 `plugin.config.get/set` WS 命令读写（sidecar → Worker RPC）
- 变更即时生效（除非 manifest 标记 `requiresRestart`，此时显示"需重启"提示）
- 无 `contributes.settings` 的插件不显示 Settings 区域

#### FR-B4: 状态栏 + 消息装饰器 + SlashMenu 集成

**状态栏**（`AppStatusbar.vue`）：
- 现有 `plugin:status_bar_update` 事件名需改为 `plugin:statusBarUpdate`（与 FR-B1 定义的 camelCase 约定一致）
- 渲染插件状态栏项（文本 + tooltip + 可选图标）
- 点击触发插件注册的命令（通过 WS `plugin.executeCommand`，需在 protocol.ts ClientMessageType 中新增：`plugin.executeCommand: { pluginId: string, commandId: string, args?: Record<string, unknown> }`）

**消息装饰器**（`MessageDecoration.vue`，新建）：
- 监听 `plugin:messageDecoration` 事件
- 在匹配的消息气泡上渲染插件 tag（小标签，显示插件名 + 装饰文本）
- 点击 tag 触发插件注册的命令

**SlashMenu**（`SlashMenu.vue`，修改）：
- 从 plugin store 获取插件注册的 slash commands（`contributes.slashCommands`）
- 在现有 slash command 列表中合并展示（区分来源：内置 vs 插件）
- 选择插件 slash command 时，通过 `plugin.executeCommand` WS 消息触发（`commandId` 为 slash command name）

#### FR-B5: 权限审批对话框

修改已有的 `PluginPermissionDialog.vue` 骨架：
- 安装新插件或插件首次激活需要权限时，sidecar 推送 `plugin:permissionRequest`
- 前端弹出对话框，展示权限列表（每个权限有描述文本）
- 用户逐项批准/拒绝（Toggle 开关）
- 确认后发送 `plugin.approvePermissions` 到 sidecar
- 已批准的权限在 PluginsPane 插件详情中可见，可撤销（发送 `plugin.revokePermissions`）

### C. 质量补强

#### FR-C1: Bridge 重连自动化测试

创建 `runtime/test/bridge-reconnect.test.ts`：
- 测试 Bridge Disconnected → Syncing → Ready 状态转换
- 测试 sidecar 重启后 Bridge 自动重连并重新注册 tool
- 测试同步超时（30 次重试后放弃）
- 需要 mock pi 进程的 extension_ui_request/response 协议

#### FR-C2: Goal/Todo 插件独立单元测试

创建 `resources/plugins/goal/__tests__/` 和 `resources/plugins/todo/__tests__/`：
- Goal：测试 create_tasks、update_tasks、list_tasks、complete_goal 等 action 的纯逻辑
- Todo：测试 add、update、delete、clear 等 action 的纯逻辑
- 测试 sessionData 读写（mock RPC）
- 测试 hooks 注册和 handler 行为

#### FR-C3: executeHooks 串行化（同 FR-A2）

#### FR-C4: sessionData 本地缓存兜底

在 `plugin-service.ts` 中增强 `sessionDataCache`：
- Worker 写入 sessionData 时，先写入内存缓存 Map，再异步 flush 到 bridge
- Worker 读取 sessionData 时，先查缓存，命中则直接返回；未命中则走 bridge RPC
- 定时 flush（每 5s 或缓存脏时）将缓存数据写入 bridge
- 插件 deactivate 时强制 flush
- 缓存容量限制：每插件 10MB（复用 PluginStorage 的限制）

#### FR-C5: 插件热重载

在 `plugin-activator.ts` 中新增 `watchAndReload()`：
- 监听 `~/.xyz-agent/plugins/` 目录变更（`fs.watch`）
- 检测到插件 `index.js`（或 `main` 指定的文件）变更时：
  1. 对该插件执行 `deactivatePlugin(pluginId)`
  2. 等待 deactivate 完成（超时 5s）
  3. 重新执行 `activatePlugin(pluginId, event)`
  4. 推送 `plugin:statusChange` 通知前端
- built-in 插件（`resources/plugins/`）不监听（生产环境不应修改）
- 防抖：300ms 内多次变更只触发一次重载

### D. 文档化

#### FR-D1: 插件架构写入 CLAUDE.md

在 CLAUDE.md 中新增"插件系统"章节：
- 架构概览（PluginService → Worker Thread → agentAPI → Pi Bridge → pi）
- Extension vs Plugin 的区分（已有术语，需在 CLAUDE.md 中也明确写出）
- 开发规范：后续所有可扩展功能应优先通过插件实现，而非硬编码
- 插件开发约束（manifest 格式、权限声明、trustLevel）
- 指向 `docs/architecture/plugin-system-plan.md` 的链接

#### FR-D2: 更新 README.md

在 README.md 中补充插件系统说明：
- 插件系统简介（一段话）
- 内置插件列表（Goal、Todo）
- 指向开发者文档的链接（Phase 4 写）

## Acceptance Criteria

### AC-A: 后端 Stub 修复

- **AC-A1**: 创建测试插件注册一个 tool → LLM 调用该 tool → Worker 内代码实际执行 → 结果返回 pi → 验证非 stub 结果
- **AC-A2**: 创建两个测试 hook handler（一个 trusted 阻止，一个 sandbox 放行）→ 发送消息 → trusted handler 阻止生效 → sandbox handler 未被调用 → 消息不发送
- **AC-A3**: hook handler 返回 `transformedContent: 'MODIFIED'` → 下一个 handler 收到的 context 包含修改后的内容
- **AC-A4**: `plugin.executeCommand` WS 消息已定义在 protocol.ts 中，前端 SlashMenu 和状态栏点击能正确发送

### AC-B: 前端集成

- **AC-B1**: 前端启动后 `plugin.list` 返回数据，PluginsPane 正确渲染插件列表（名称、版本、状态、信任等级）
- **AC-B2**: 点击 Toggle 禁用插件 → `plugin.toggle` 发送 → sidecar 返回更新列表 → UI 状态同步
- **AC-B3**: 安装一个带 `contributes.settings` 的测试插件 → PluginsPane 中该插件展开区显示配置表单 → 修改值 → 刷新后值保留
- **AC-B4**: 测试插件注册状态栏项 → AppStatusBar 显示该项 → 文本和 tooltip 正确
- **AC-B5**: 测试插件注册 slash command → SlashMenu 中出现该命令 → 选择后触发执行
- **AC-B6**: 消息装饰器：测试插件推送 `plugin:messageDecoration` → 对应消息气泡出现 tag
- **AC-B7**: 安装需要权限的插件 → 弹出权限对话框 → 批准后插件激活 → 拒绝后插件不激活

### AC-C: 质量补强

- **AC-C1**: `bridge-reconnect.test.ts` 全部通过，覆盖 Disconnected→Ready 和超时放弃
- **AC-C2**: `goal/__tests__/` 和 `todo/__tests__/` 全部通过，覆盖核心 action
- **AC-C3**: executeHooks 串行化测试：验证 trusted handler 阻止后 sandbox handler 不执行
- **AC-C4**: sessionData 缓存测试：bridge 断开时 `sessionData.get` 仍返回缓存值
- **AC-C5**: 热重载测试：修改 external 插件文件 → 自动 deactivate + activate → 状态变更通知前端

### AC-D: 文档化

- **AC-D1**: CLAUDE.md 包含"插件系统"章节，明确 Extension vs Plugin 区分和开发规范
- **AC-D2**: README.md 包含插件系统说明

## Constraints

- **TypeScript 严格模式**：所有新增代码无 `any` 类型
- **前端编码规范**：遵循 `docs/standards.md` 和 CLAUDE.md 中的前端规范（禁止原生 HTML 表单元素、禁止 Emoji、Tailwind 类样式、组件 ≤ 400 行 template / 300 行 script）
- **WS 消息格式**：flat type 模式（`plugin.xxx`），不做统一 action 路由
- **前端状态管理**：使用 Pinia store，遵循现有 `chat.ts`/`session.ts` 的模式
- **事件监听防重复注册**：Plugin store 和组件中监听 WS 事件时，必须使用模块级 refCount 保护（CLAUDE.md 规则 2），防止组件多实例时事件处理翻倍
- **组件复用**：PluginPermissionDialog 复用现有 xyz-ui 组件（Dialog、Button、Toggle）
- **不破坏现有接口**：PluginService 公开 API 不做 breaking change，只增强内部实现
- **pi 版本**：使用 fork 版 `xyz-pi@0.75.5-xyz-0.1`
- **Phase 1/2 兼容**：不破坏已通过的 17 个后端测试
- **运行环境**：前端在 Electron renderer（Vue 3 + Vite），后端在 Node.js Worker Thread（sidecar 内部）

## 范围边界

### 本期实施（In Scope）

| 类别 | 项目 |
|------|------|
| 后端修复 | handleBridgeToolExecute 路由到 Worker（FR-A1） |
| 后端修复 | executeHooks 串行化（FR-A2 = FR-C3） |
| 前端 | Plugin Pinia Store + WS 消息扩展（FR-B1） |
| 前端 | PluginsPane 插件管理 UI（FR-B2） |
| 前端 | PluginSettingsForm 动态配置（FR-B3） |
| 前端 | 状态栏 + 消息装饰器 + SlashMenu（FR-B4） |
| 前端 | 权限审批对话框（FR-B5） |
| 质量 | Bridge 重连测试（FR-C1） |
| 质量 | Goal/Todo 独立测试（FR-C2） |
| 质量 | sessionData 缓存兜底（FR-C4） |
| 质量 | 插件热重载（FR-C5） |
| 文档 | CLAUDE.md 插件架构（FR-D1） |
| 文档 | README.md 更新（FR-D2） |

### 延后实施（Out of Scope — 记录于 spec，未来实现）

| 项目 | 说明 | 预计阶段 |
|------|------|----------|
| npm install 集成（Phase 4.1） | `plugin-installer.ts`，`npm install <pkg> --prefix ~/.xyz-agent/plugins/` | Phase 4 |
| 脚手架 create-xyz-plugin（Phase 4.2） | `npx create-xyz-plugin my-plugin` 生成项目骨架 | Phase 4 |
| SDK 包 xyz-agent-plugin-sdk（Phase 4.2） | TypeScript 类型 + 本地 mock | Phase 4 |
| 开发者文档（Phase 4.3） | `docs/plugins/developer-guide.md`、`api-reference.md`、`examples/` | Phase 4 |
| 样例插件 + 集成测试（Phase 4.4） | hello-world 测试插件、安装→激活→执行→停用→卸载全流程、100 并发压力测试 | Phase 4 |
| contributes.panels 面板系统 | Part 2 设计中定义了 `panels` 字段，面板渲染系统（侧边栏/抽屉面板）未实现 | Phase 5+ |
| 插件市场 / Registry | 在线插件浏览、搜索、评分、一键安装 | 远期 |
| 插件版本自动更新 | 检测已安装插件的新版本并提示更新 | 远期 |

### 已确认的技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| WS 消息格式 | flat type（`plugin.xxx`） | 与现有 40+ 个消息类型一致，TypeScript union 收窄最好 |
| Plugin Store 状态管理 | Pinia store | 与现有 chat/session/provider store 一致 |
| 权限审批通道 | 复用现有 `extension_ui_request` 协议 | Bridge 已经使用此协议，插件权限审批通过同一通道推送 |
| 热重载监听 | `fs.watch` + 300ms debounce | Node.js 原生 API，无需额外依赖 |
| hook 串行化超时 | 单 Worker 5s，总链无上限（逐个等待） | 平衡响应速度和可靠性 |
| tool 执行超时 | 30s | 与 PluginRPC 默认超时一致 |

## 业务用例

### UC-1: 用户管理已安装插件
- **Actor**: 终端用户
- **场景**: 用户打开 Settings → Plugins tab，查看已安装插件列表
- **预期结果**: 列表显示 Goal（built-in, trusted, active）和 Todo（built-in, trusted, active）及任何外部插件。用户可以启用/禁用外部插件，查看插件详情和权限。

### UC-2: 插件 Tool 被 LLM 实际执行
- **Actor**: LLM（代表用户意图）
- **场景**: 用户要求创建任务，LLM 调用 Goal 插件的 `goal_manager` tool
- **预期结果**: tool 请求通过 Bridge → sidecar → Worker 路由，Goal 插件 Worker 内实际执行 create_tasks 逻辑，结果通过原路返回给 pi。非 stub 结果。

### UC-3: 插件 Hook 阻止消息发送
- **Actor**: 安全审计插件
- **场景**: 用户消息包含 API key，插件 onBeforeSendMessage hook 检测到并阻止
- **预期结果**: 消息被阻止，前端收到通知，LLM 未收到该消息。trusted handler 先执行，sandbox handler 不执行。

### UC-4: 开发者热重载插件
- **Actor**: 插件开发者
- **场景**: 开发者在 `~/.xyz-agent/plugins/my-plugin/` 修改了 index.js
- **预期结果**: 300ms 内插件自动 deactivate + activate，前端状态更新，无需重启 xyz-agent。

### UC-5: 插件配置动态修改
- **Actor**: 终端用户
- **场景**: 用户在 PluginsPane 展开某插件，修改配置项（如 web-search 插件的默认结果数）
- **预期结果**: 配置值通过 `api.config.set` 写入，立即生效。刷新后值保留。

## Complexity Assessment

**高复杂度**。涉及 3 个层面：
1. **后端修复**（2 项）— 核心能力补全，影响整个插件系统的功能性。handleBridgeToolExecute 从 stub 改为真实 RPC 路由，executeHooks 从 broadcast 改为串行 await，两者都是架构级改动。
2. **前端集成**（5 项）— 全新前端模块，涉及 Pinia store、WS 消息协议扩展、4 个新/改组件。工作量最大。
3. **质量补强**（5 项）— 测试编写和缓存/热重载增强，相对独立但需要 mock 复杂的跨进程交互。
4. **文档化**（2 项）— 相对简单。

预计工期 10-15 天（与原规划一致）。

### 错误场景覆盖

| 场景 | 处理方式 |
|------|----------|
| Worker 崩溃（执行 tool 时） | handleBridgeToolExecute 捕获 RPC 错误，返回 `{ content: 'Plugin worker crashed', isError: true }`，PluginHost crash callback 标记 crashed |
| Worker hook 超时（5s） | 视为放行（`{ blocked: false }`），继续下一个 handler |
| 前端 WS 断连 | Plugin store 保持最后已知状态，重连后自动 `plugin.list` 刷新 |
| 热重载 deactivate 超时 | 强制 terminate Worker，重新创建 |
| sessionData bridge 不可用 | 返回缓存值，标记 dirty，bridge 恢复后 flush |
| 权限对话框用户拒绝 | 插件保持 `discovered` 状态不激活，不报错 |
| 测试插件文件不存在 | 热重载 fs.watch 忽略 delete 事件，仅响应 change |
