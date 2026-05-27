# 插件系统实施规划

> 基于 [融合设计报告](docs/architecture/plugin-system-design-part1.md) / [Part 2](docs/architecture/plugin-system-design-part2.md)

---

## 现状盘点

已完成的 Phase 0（2026-05-26 plugin-arch-refactor-phase1）：

- `IExtensionService`：扫描 `~/.xyz-agent/extensions/`、配置 `--extension` 路径
- Extension UI Bridge：`extension_ui_request/response` 协议转发
- Session 生命周期修复（UC-S1 ~ S7）
- pi extension 能力透出到 GUI 层

**Phase 0 不是本项目（feat-plugin-arch-2）的部分**，而是 `refactor-plugin-arch` 分支已合并的内容。本分支从 Phase 1 开始。

---

## Phase 1: 插件基础设施

**目标**：让插件能被发现、加载、激活、停用。搭建 Worker Thread 隔离 + JSON-RPC 通信的骨架。

**工期**：5-7 天

### Task 1.1: PluginService 模块骨架 + 类型定义

侧产出：`src-electron/runtime/src/services/plugin-service/` 目录 + 类型文件

**产出文件**：
- `src-electron/runtime/src/services/plugin-service/plugin-types.ts` — 全部核心类型（XyzAgentManifest、PluginContributes、ActivationEvent 等，按 Part 2 的定义）
- `src-electron/runtime/src/services/plugin-service/index.ts` — PluginService 类骨架
- `interfaces.ts` 中新增 `IPluginService` 接口
- `src-electron/shared/src/` 中新增前端共享类型（PluginDescriptor、PluginStatus 等）

**验证**：TypeScript 编译通过，类型无 any

### Task 1.2: PluginRegistry — 发现 + Manifest 解析

**产出文件**：
- `src-electron/runtime/src/services/plugin-service/plugin-registry.ts`

**功能范围**：
- 三层发现路径扫描（用户级 + 项目级 + Settings 配置）
- `package.json` 中的 `xyzAgent` 字段解析
- `activationEvents` 自动推断（从 `contributes` 推导）
- 插件描述符（PluginDescriptor）的构建和缓存
- 兼容性检查（`engines.xyz-agent` semver 匹配）

**本期不做**：
- npm 安装/卸载
- 版本对照和自动更新

**验证**：单元测试覆盖 manifest 解析各种场景（合法 manifest、缺少字段、不兼容版本、空 contributes）

### Task 1.3: PluginHost — Worker Thread 池

**产出文件**：
- `src-electron/runtime/src/services/plugin-service/plugin-host.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts`（Worker 侧入口文件）

**功能范围**：
- Worker Thread 创建：`new Worker(pluginBootstrapPath, { workerData })`
- 按信任等级分组：trusted 共享 / untrusted 独占
- Worker 生命周期：assignWorker → loadPlugin → activatePlugin → deactivatePlugin → terminateWorker
- 崩溃恢复：`worker.on('error')` → 标记 crashed → 通知前端 → 自动重建（仅 trusted Worker）
- 资源监控：通过 `worker.threadId` 查询内存使用
- Worker 空闲回收（idleTimeout 默认 60s）

**本期不做**：
- sandbox 的 require 净化（先允许所有 Node API，Phase 2 再加限制）
- CPU 时间限制

**验证**：单元测试验证 Worker 创建/销毁、崩溃恢复、插件加载/卸载流程

### Task 1.4: PluginRPC — JSON-RPC 2.0 over MessagePort

**产出文件**：
- `src-electron/runtime/src/services/plugin-service/plugin-rpc.ts`（主线程侧 RPC server + 客户端侧 RPC client）

**功能范围**：
- 请求-响应模式：自增 requestId + pending Map
- 通知模式（fire-and-forget）：不等待响应
- 错误码定义（PERMISSION_DENIED, PLUGIN_NOT_FOUND 等）
- `structuredClone` 序列化（Worker 原生能力）
- 超时机制（默认 30s）
- 类型安全的 method handler 注册

**本期不做**：
- 批量请求（batch request）
- 双向 RPC（主线程调用 Worker 内方法）— 不需要，全部走通知推送

**验证**：单元测试验证请求-响应、通知、超时、错误码、并发请求

### Task 1.5: PluginActivator — 懒激活 + 生命周期管理

**产出文件**：
- `src-electron/runtime/src/services/plugin-service/plugin-activator.ts`

**功能范围**：
- `activatePlugin(pluginId, event)` — 触发激活
- Worker bootstrap 中调用 `import(pluginEntry)` → `module.activate(context)`
- PluginContext 的构造（注入 agentAPI 代理对象最小集）
- `deactivatePlugin(pluginId)` → `module.deactivate()` → dispose subscriptions
- 状态机管理（UNLOADED → LOADING → ACTIVATING → ACTIVE → DEACTIVATING）
- server.ts 集成：PluginService 在 startup 时初始化，注册发现结果

**本期 agentAPI 最小集**（Phase 1 只暴露）：
- `api.storage.global` / `api.storage.workspace`（基本 KV 读写）
- `api.notify.info/warning/error`（通知到前端）
- `api.sessions.list()`（查看 session 列表）

**本期不做**：
- 完整 agentAPI（Phase 2）
- 热重载/热更新

**验证**：端到端测试——创建一个简单的 test plugin，验证 discover → activate → execute → deactivate 完整流程

### Task 1.6: PluginStorage — KV 持久化

**产出文件**：
- `src-electron/runtime/src/services/plugin-service/plugin-storage.ts`

**功能范围**：
- globalState.json / workspaceState.json 的读写
- 内存缓存 + 延迟批量写入（500ms debounce）
- 每插件 10MB 总存储限制 + 单值 1MB 限制
- 工作区哈希隔离（不同 workspace 的 workspaceState 互不影响）

**验证**：单元测试验证读写、debounce、限制检查

---

## Phase 2: API 完整化 + 安全模型

**目标**：实现完整 agentAPI，插件可以真正做有用的事（注册 tool、监听事件、响应 slash 命令）。添加安全层（权限检查和 Worker 沙箱）。

**工期**：5-7 天

### Task 2.1: 完整 agentAPI 实现

**产出文件**：
- Plugin bootstrap 中 agentAPI 代理对象全部模块

**功能范围**：
- `api.tools.register()` + tool execute 管道（插件 Worker 内执行 → RPC 返回结果）
- `api.slashCommands.register()` + 命令管道（前端 SlashMenu → PluginService → Worker execute）
- `api.hooks.onBeforeSendMessage()` — 消息钩子管道
- `api.hooks.onBeforeToolCall()` — tool 调用前拦截
- `api.hooks.onAfterToolResult()` — tool 返回后修改
- `api.sessions.list/get/sendMessage()`
- `api.config.get/set/getAll()`
- `api.ui.showSelect/showConfirm/showInput/notify/updateStatusBarItem`
- `api.events.on/emit()`（Worker 内 EventBus）
- `api.agent.setModel/getModel/getThinkingLevel/setThinkingLevel`（仅 trusted）
- `api.workspace.rootPath/name/findFiles`

**验证**：为每个 API 模块写集成测试，验证 RPC 往返正确性

### Task 2.2: Pi 事件桥接

**产出文件**：
- `session-service.ts` 中新增钩子执行点（在消息发送/tool 调用/tool 返回的合适位置调用 PluginService.executeHooks）
- `event-adapter.ts` 中新增 pi 事件 → PluginService 的只读事件广播

**功能范围**：
- `message:beforeSend` → 调用 `api.hooks.onBeforeSendMessage` handler
  - 可修改消息内容（transformedContent）
  - 可阻止发送（blocked: true）
- `tool:beforeCall` → 调用 `api.hooks.onBeforeToolCall` handler
  - 可修改参数（transformedParams）
  - 可阻止调用（blocked: true）
  - 可替换 handler（replacedHandler）
- `tool:afterCall` → 调用 `api.hooks.onAfterToolResult` handler
  - 可修改返回结果（transformedOutput）
- Pi 只读事件 → `api.hooks.onPiEvent()` handler 广播
  - agent_start/end, tool_execution_start/end/update, turn_start/end, session_compact

**钩子执行顺序**：内置 handlers → trusted 插件 → untrusted 插件。任意 handler 返回 `blocked: true` 则终止链。

**验证**：集成测试验证钩子链的拦截和修改效果

### Task 2.3: 安全层 — 权限检查

**产出文件**：
- `src-electron/runtime/src/services/plugin-service/plugin-security.ts`
- `~/.xyz-agent/plugins/permissions.json` 的读写逻辑

**功能范围**：
- 权限声明解析（manifest.permissions）
- 安装时权限审批（通过 `extension_ui_request` 协议推给前端确认）
- 权限映射表持久化（permissions.json）
- RPC 层每次调用的权限检查中间件
- 安装时审批对话框（前端通过现有 extension_ui_request 协议渲染）
- 默认权限（零默认信任——sandbox 插件默认无任何权限）

**验证**：测试权限拒绝场景（PERMISSION_DENIED error），批准后权限生效

### Task 2.4: Worker 沙箱（sandbox 模式）

**产出文件**：
- static bootstrap 中 sandbox Worker 的 `require()` 净化逻辑

**功能范围**：
- 禁止 `require('fs')`、`require('child_process')` 等 Node.js builtins
- 禁止 `process.env` 访问
- 允许 require 插件自身目录下的模块
- 所有外部能力只能通过 agentAPI 代理访问

**本期不做**：
- CPU 时间限制
- 网络请求频率限制

**验证**：测试 sandbox Worker 中 `require('fs')` 抛异常，agentAPI 正常可用

---

## Phase 3: 前端集成

**目标**：前端能管理插件（启用/禁用/安装）、渲染插件 UI（Settings 面板、状态栏、消息装饰器）。

**工期**：5-7 天

### Task 3.1: Plugin Store + WS 消息扩展

**产出文件**：
- `src-electron/renderer/src/stores/plugin.ts` — Pinia store
- `src-electron/shared/src/` — 补充 plugin 相关消息类型

**功能范围**：
- Plugin store：installedPlugins、disabledPlugins、pluginStatuses
- WS 消息扩展：
  - `plugin:list` → 获取已安装插件列表
  - `plugin:statusChange` → 插件状态变更通知
  - `plugin:notification` → 插件发出的通知（来自 api.ui.notify）
  - `plugin:crashed` → 插件崩溃通知
  - `plugin:panelData` → 面板数据更新
  - `plugin:statusBarUpdate` → 状态栏更新
  - `plugin:messageDecoration` → 消息装饰器数据
  - `plugin:permissionRequest` → 权限审批请求
- 命令行：`plugin.install`、`plugin.uninstall`、`plugin.enable`、`plugin.disable`

**验证**：前端能获取插件列表、启用/禁用插件

### Task 3.2: 插件管理 UI

**产出文件**：
- `src-electron/renderer/src/components/settings/PluginsPane.vue`（修改已有）

**功能范围**：
- 已安装插件列表（名称、版本、状态、信任等级）
- 启用/禁用开关
- 卸载按钮（确认对话框）
- 手动添加路径
- 插件详情 popover（权限列表、激活事件、配置项）
- 信任等级切换（untrusted → trusted 需要二次确认）

**验证**：UI 交互（启用/禁用/卸载）后状态同步

### Task 3.3: 插件 Settings 面板

**产出文件**：
- 动态渲染 Settings 表单组件（基于 manifest `contributes.settings` 的 schema）

**功能范围**：
- 根据 manifest 中的 setting 声明动态渲染表单（文本、数字、下拉框、路径选择）
- 配置值通过 `api.config.set/get` 读写
- 变更即时生效（除非 marked `requiresRestart`）

**验证**：安装 test plugin → Settings 面板自动显示配置项 → 修改后持久化

### Task 3.4: 状态栏 + 消息装饰器渲染

**产出文件**：
- AppStatusbar.vue 中渲染插件状态栏项
- MessageList.vue 中渲染插件消息装饰器

**功能范围**：
- 状态栏项：根据 `plugin:statusBarUpdate` 消息动态更新文本/tooltip
- 消息装饰器：在匹配的消息气泡上添加 tag（小标签），点击触发插件命令
- SlashMenu 中显示已注册插件的 slash 命令

**验证**：安装 test plugin → 状态栏显示插件项 → 消息中出现插件装饰器

### Task 3.5: 权限审批对话框

**产出文件**：
- `PluginPermissionDialog.vue`

**功能范围**：
- 安装时弹出权限列表
- 用户确认/拒绝
- 已批准的权限在 Settings / Plugins / <plugin> 中可见可撤销

**验证**：安装需要权限的插件 → 弹出对话框 → 批准后插件可用

---

## Phase 4: 分发 + 开发者体验

**目标**：插件可以被分发、安装、更新。提供开发者脚手架和文档。

**工期**：3-5 天

### Task 4.1: npm install 集成

**产出文件**：
- runtime 中新增 `plugin:install` 和 `plugin:uninstall` 命令处理

**功能范围**：
- 前端触发安装 → runtime 执行 `npm install <package> --prefix ~/.xyz-agent/plugins/`
- 卸载 → `npm uninstall` + 清理 data 目录
- 版本兼容检查（engines.xyz-agent）
- 安装时自动触发权限审批

**验证**：`xyz-agent plugin install xyz-plugin-web-search` → 安装 → 激活

### Task 4.2: 插件脚手架 + SDK 包

**产出文件**：
- npm 包 `create-xyz-plugin`（脚手架）
- npm 包 `xyz-agent-plugin-sdk`（TypeScript 类型定义 + agentAPI mock）

**功能范围**：
- `npx create-xyz-plugin my-plugin` → 生成项目骨架
  - package.json（含 xyzAgent 字段示例）
  - src/index.ts（activate/deactivate 模板）
  - tsconfig.json
- `xyz-agent-plugin-sdk` 包：
  - PluginModule、PluginContext、AgentAPI 等完整类型定义
  - 本地测试 mock（无需在 xyz-agent 中运行即可开发插件）

**验证**：`npx create-xyz-plugin` → 生成的项目能编译通过

### Task 4.3: 开发者文档

**产出文件**：
- `docs/plugins/developer-guide.md`
- `docs/plugins/api-reference.md`
- `docs/plugins/examples/` (示例插件)

**功能范围**：
- Quick Start（5 分钟创建第一个插件）
- API 参考（完整 agentAPI 文档）
- 示例：
  - `hello-world` — 最简插件（注册一个 slash command）
  - `web-search` — 完整插件（tool + slash command + settings + hooks）
  - `code-review` — 事件钩子插件（监听消息 + tool 拦截）

**验证**：按文档指导能创建并运行一个插件

### Task 4.4: 样例插件 + 集成测试

**产出文件**：
- `src-electron/tests/plugins/hello-world/`（测试用插件）
- 集成测试脚本

**功能范围**：
- hello-world 插件：注册 `/hello` slash 命令，返回 "Hello from plugin!"
- 集成测试覆盖：安装 → 激活 → 执行命令 → 停用 → 卸载
- 性能测试：100 个并发插件的 Worker 池压力测试

**验证**：集成测试全部通过

---

## 执行顺序

```
Phase 1 (基础设施)
  ├── 1.1 类型定义 + Service 骨架
  ├── 1.2 PluginRegistry (发现 + Manifest)
  ├── 1.3 PluginHost (Worker Thread 池)
  ├── 1.4 PluginRPC (JSON-RPC over MessagePort)
  ├── 1.5 PluginActivator (懒激活 + 生命周期)
  └── 1.6 PluginStorage (KV 持久化)
        │
        ▼
Phase 2 (API + 安全)
  ├── 2.1 完整 agentAPI
  ├── 2.2 Pi 事件桥接
  ├── 2.3 权限检查
  └── 2.4 Worker 沙箱
        │
        ▼
Phase 3 (前端集成)
  ├── 3.1 Plugin Store + WS 消息
  ├── 3.2 插件管理 UI
  ├── 3.3 插件 Settings
  ├── 3.4 状态栏 + 消息装饰器
  └── 3.5 权限审批 UI
        │
        ▼
Phase 4 (分发 + DX)
  ├── 4.1 npm install 集成
  ├── 4.2 脚手架 + SDK
  ├── 4.3 开发者文档
  └── 4.4 样例插件 + 集成测试
```

**总工期**：18-26 天

## 风险与依赖

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Worker Thread 在 Electron 环境中的兼容性 | Phase 1.3 阻塞 | Phase 1 早期写 PoC 脚本验证 |
| JSON-RPC 序列化性能（大 payload） | 钩子/Tool 调用延迟 | 默认超时 + payload 大小限制 |
| Pi 事件桥接的时序问题 | Phase 2.2 钩子执行顺序不可靠 | 基于 EventEmitter 的顺序保证 + 单元测试 |
| 插件热重载的复杂度 | Phase 1.5 实现困难 | Phase 1 不做热重载，后续 Phase 单独处理 |
| npm install 的跨平台兼容 | Phase 4.1 可能延迟 | 降级到手动 copy 目录 |
| 前端 UI 开发量大 | Phase 3 可能被压缩 | 优先做 Settings 面板和管理 UI，其他延后 |

## 验收标准

**Phase 1**：type 能定义一个合法插件的 manifest，插件能被发现、加载到 Worker Thread、激活并执行最简 API（storage + notify）。

**Phase 2**：插件能注册 tool 和 slash command，能被 LLM 调用，能通过 hooks 拦截消息和 tool 调用。未授权操作返回 PERMISSION_DENIED。

**Phase 3**：用户能在 Settings 中看到已安装插件列表，能启用/禁用/卸载。插件配置项渲染为表单。状态栏显示插件项。

**Phase 4**：用户能通过 npm 安装插件，开发者能用脚手架创建插件，按照文档写出一个可运行的插件。
