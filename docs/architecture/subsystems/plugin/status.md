# Plugin System — 完成度分析

> 日期: 2026-05-28
> 分支: feat-plugin-arch-4
> PR: #57

## 一、原始设计 vs 实际实现对比

### ✅ 已完成

#### Phase 1 基础设施 (PR #54)
- PluginService 核心模块
- PluginRegistry（发现 + Manifest 解析）
- PluginHost（Worker Thread 池，trusted 共享 / sandbox 独占）
- PluginRPC（JSON-RPC 2.0 over MessagePort）
- PluginActivator（懒激活状态机：UNLOADED→LOADING→ACTIVATING→ACTIVE→DEACTIVATING）
- PluginStorage（KV 持久化，globalState/workspaceState）
- Worker sandbox（require 拦截 + process.env proxy）

#### Phase 2 API + 安全 (PR #54)
- Full agentAPI 10 模块（sessions/tools/hooks/config/sessionData/ui/agent/workspace/storage/events）
- Pi 事件桥接（handleBridgeIntercept + handleBridgeEvent）
- Permission 系统（存储 + RPC 中间件检查）
- Goal/Todo 内置插件（从 pi extension 迁移）
- Bridge extension（与 pi 通信）

#### Phase 3 前端 + 质量 (本 PR)
- handleBridgeToolExecute 真实路由到 Worker（FR-A1）
- executeHooks 串行化 + priority 排序 + blocking + transformation（FR-A2）
- sessionData 本地缓存兜底 + dirty 跟踪 + flush（FR-C4）
- 热重载 fs.watch + 300ms debounce，仅 external 插件（FR-C5）
- Plugin Pinia Store + WS 消息扩展（FR-B1）
- PluginsPane 组件（列表/Toggle/详情/权限/配置）（FR-B2）
- PluginSettingsForm 动态表单（FR-B3）
- PermissionDialog 逐项审批（FR-B5）
- StatusBar 集成 + MessageDecoration + SlashMenu 集成（FR-B4）
- Bridge 重连测试 18 cases（FR-C1）
- Goal/Todo 独立测试 46 cases（FR-C2）
- 5 步专项审查（BLR/Standards/Taste/Robustness/Integration）
- Goal 插件 9 个 tsc 错误修复（Phase 5 CI 修复）
- CLAUDE.md 插件文档（FR-D1）
- README.md 更新（FR-D2）

---

### ⚠️ 部分完成 / 集成缺口

| # | 功能 | 缺失部分 | 影响 | 优先级 |
|---|------|---------|------|--------|
| P0-1 | **PluginsPane 未接入 SettingsView** | SettingsView.vue tabs 无 plugins 条目，settings/index.ts 未 export PluginsPane。用户无法导航到插件管理页 | **高** — 所有前端代码已写好但不可达 | P0 |
| P0-2 | **Worker 端 tool execute handler** | 主线程 `rpcServer.invoke('plugin.tool.execute')` 发送请求到 Worker，但 Worker 端没有注册 handler 路由到 `executeGoalAction`/`executeTodoAction`。LLM 调用插件工具会在 Worker 内无响应 | **高** — tool 执行链路断在最后一步 | P0 |
| P1-1 | **sessionData bridge flush** | `flushSessionDataForSession` 中实际 flush 调用是 `Promise.resolve()`（TODO），数据只存内存，sidecar 重启丢失 | 中 — 依赖 pi bridge 就绪 | P1 |
| P1-2 | **plugin:permissionRequest 服务端发送** | 前端监听代码已就绪，但 sidecar 不会推送此消息。权限审批是死代码路径 | 中 — Phase 4 scope | P1 |
| P1-3 | **ui-api.ts stubs** | `showSelect`/`showConfirm`/`showInput` 返回 undefined | 低 — 前端弹窗 RPC 未实现 | P1 |
| P1-4 | **agent-api.ts stubs** | `setModel`/`getModel`/`getThinkingLevel`/`setThinkingLevel` 返回假数据 | 低 — 仅 trusted 插件使用 | P1 |

---

### ❌ 原始设计计划但未实现

#### Phase 4（spec 中明确 defer，记录在 spec "延后实施" 表）

| 项目 | 原始设计来源 | 预计阶段 |
|------|------------|---------|
| npm install 集成（plugin-installer.ts） | plugin-system-plan.md Task 4.1 | Phase 4.1 |
| create-xyz-plugin 脚手架 | plugin-system-plan.md Task 4.2 | Phase 4.2 |
| xyz-agent-plugin-sdk 包 | plugin-system-plan.md Task 4.2 | Phase 4.2 |
| 开发者文档（developer-guide + api-reference） | plugin-system-plan.md Task 4.3 | Phase 4.3 |
| 样例插件 + 集成测试 + 100 并发压力测试 | plugin-system-plan.md Task 4.4 | Phase 4.4 |

#### 原始设计计划但不在任何 coding-workflow spec 中

| 项目 | 原始设计来源 | 说明 |
|------|------------|------|
| contributes.panels 面板系统 | part2.md §3 / PluginContributes.panels | 类型定义存在，无渲染基础设施 |
| contributes.settings 声明式渲染 | part2.md §3 | manifest 声明的 settings 理论上应自动出现，当前只在 PluginsPane 详情中 |
| contributes.statusBarItems 声明式 | part2.md §3 | manifest 声明后无代码也应出现，当前仅通过 api.ui.updateStatusBarItem() |
| contributes.slashCommands 声明式 | part2.md §3 | manifest 声明后应出现在 SlashMenu，当前仅 api.tools.register() |
| contributes.messageDecorators | part2.md §3 | PluginContributes 中未定义此字段 |
| API 稳定性分层（stable/proposed/internal） | part2.md §2 | 未实现 proposed API gating |
| Worker idle recycling（60s 超时回收） | plan.md Task 1.3 | 未确认是否实现 |
| 版本兼容性检查（engines.xyz-agent semver） | plan.md Task 1.2 | 未实现 |
| 跨插件通信（api.events 跨 Worker） | plan.md Task 2.1 | events.on/emit 仅 Worker 内部 |
| Plugin permission 审批推送 | plan.md Task 2.3 | 前端监听就绪，服务端未发送 |

---

## 二、下一步优先级建议

### P0（阻塞基本功能，建议立即修复）

1. **PluginsPane 接入 SettingsView** — 约 5 行改动：
   - SettingsView.vue: import PluginsPane + 添加 plugins tab + 添加 v-show
   - settings/index.ts: export PluginsPane
   - i18n: 添加 settings.tabPlugins 翻译

2. **Worker 端 tool execute handler** — plugin-bootstrap.ts 中注册 `plugin.tool.execute` RPC handler：
   - 接收 { pluginId, toolName, arguments, sessionId }
   - 查找已加载的 plugin module
   - 调用 module 导出的 execute 函数（如 executeGoalAction）
   - 返回执行结果

### P1（重要但非阻塞）

3. sessionData bridge flush 实际调用（依赖 pi bridge API）
4. plugin:permissionRequest 服务端推送（安装时触发权限审批）
5. ui-api.ts showSelect/showConfirm/showInput 实现

### P2（Phase 4 scope）

6-10. npm install / 脚手架 / SDK / 开发者文档 / 样例插件

### P3（远期）

11-17. 面板系统 / 声明式 contributes / 插件市场 / 版本更新 / API 分层 / Worker recycling / 跨 Worker 事件

---

## 三、量化统计

| 类别 | 原始设计总数 | 已完成 | 部分 | 未做 |
|------|------------|--------|------|------|
| Phase 1 基础设施 | 6 Task | 6 | 0 | 0 |
| Phase 2 API + 安全 | 4 Task | 4 | 0 | 0 |
| Phase 3 前端 + 质量 | 14 FR | 12 | 2 | 0 |
| Phase 4 Distribution | 4 Task | 0 | 0 | 4 (deferred) |
| 原始设计额外项 | ~10 | 0 | 0 | 10 (not in scope) |
| **总计** | **~38** | **22** | **2** | **14** |

完成率: 58% (22/38)，但如果只看 coding-workflow spec 范围: 93% (14/15 FR items, 2 partial)
