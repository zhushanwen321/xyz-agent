---
verdict: pass
---

# E2E Test Plan — Plugin System Frontend + Quality

## Test Environment

- **Runtime**: xyz-agent dev mode (`npm run dev`), sidecar + renderer + Electron
- **Mock**: `VITE_MOCK=false`（需要真实 sidecar WS 通信）
- **Test Plugins**: 使用 `resources/plugins/goal/` 和 `resources/plugins/todo/` 作为 built-in 插件，创建临时 external 测试插件
- **Test Runner**: Vitest（后端单元/集成测试），Playwright（前端 UI 测试，可选）

## Test Scenarios

### TS-1: Backend Tool Execution (AC-A1)

**Scope**: handleBridgeToolExecute RPC routing to Worker

1. 启动 sidecar，激活 Goal 插件
2. 模拟 Bridge 发送 `bridge:tool_execute { toolName: 'goal_manager', arguments: { action: 'create_tasks', tasks: ['test'] } }`
3. 验证 PluginService 将请求路由到 Goal Worker
4. 验证 Worker 返回非 stub 结果
5. 验证结果通过 Bridge 返回

**Failure Scenarios**:
- 6. 发送未注册的 tool name → 返回 `{ isError: true }`
- 7. Worker 执行超时（模拟 Worker hang 30s）→ 返回 timeout error
- 8. Worker 崩溃（模拟 Worker process exit）→ 返回 crash error

### TS-2: Hook Serialization (AC-A2, AC-A3)

**Scope**: executeHooks serial execution with block and transform

1. 注册两个 hook handler：Handler A（priority 1, trusted）和 Handler B（priority 2, sandbox）
2. 发送消息触发 hook chain
3. 验证 Handler A 先执行，Handler B 后执行
4. 验证 Handler A 返回 `blocked: true` 时，Handler B 不被调用

**Transform Scenarios**:
- 5. Handler A 返回 `transformedContent: 'MODIFIED'` → Handler B 收到修改后的 context
- 6. Handler A 超时（模拟 6s 响应）→ 视为放行，Handler B 继续执行

### TS-3: Frontend Plugin List (AC-B1)

**Scope**: Plugin Store + PluginsPane rendering

1. 启动 xyz-agent，确保 sidecar 运行
2. 打开 Settings → Plugins tab
3. 验证 PluginsPane 显示 Goal 和 Todo 插件
4. 验证每个插件卡片包含：名称、版本、状态(active)、信任等级(trusted)、来源(built-in)

### TS-4: Plugin Toggle (AC-B2)

**Scope**: Enable/disable plugin via UI

1. 安装一个 external 测试插件（status: active）
2. 在 PluginsPane 点击 Toggle 禁用
3. 验证 WS 发送 `plugin.toggle { pluginId, enabled: false }`
4. 验证 UI 更新为 inactive 状态
5. 点击 Toggle 启用
6. 验证恢复 active 状态
7. 验证 built-in 插件的 Toggle 灰显不可操作

### TS-5: Plugin Settings Form (AC-B3)

**Scope**: Dynamic config form rendering and persistence

1. 创建一个带 `contributes.settings` 的测试插件
2. 激活插件
3. 在 PluginsPane 展开该插件详情
4. 验证 PluginSettingsForm 渲染了正确的字段类型（string → Input, boolean → Toggle, enum → Select）
5. 修改一个配置值
6. 验证 WS 发送 `plugin.config.set`
7. 刷新页面后验证值保留

### TS-6: Status Bar + SlashMenu (AC-B4, AC-B5)

**Scope**: Plugin contributions to status bar and slash commands

1. 创建一个注册了 `statusBarItems` 和 `slashCommands` 的测试插件
2. 激活插件
3. 验证 AppStatusBar 显示插件状态栏项
4. 输入 `/` 打开 SlashMenu
5. 验证插件 slash command 出现在列表中
6. 选择插件 slash command
7. 验证发送 `plugin.executeCommand`

### TS-7: Message Decoration (AC-B6)

**Scope**: Plugin message decorations

1. 创建一个会推送 `plugin:messageDecoration` 的测试插件
2. 激活插件
3. 发送消息触发插件推送 decoration
4. 验证对应消息气泡上出现插件 tag
5. 验证 tag 显示 pluginName 和 text
6. 点击 tag 触发 plugin.executeCommand（如有 commandId）

### TS-8: Permission Dialog (AC-B7)

**Scope**: Permission approval flow

1. 安装一个需要权限（如 `file:read`）的 external 插件
2. 尝试激活
3. 验证弹出 PluginPermissionDialog
4. 验证显示权限列表
5. 批准 `file:read`，拒绝 `network:fetch`
6. 验证插件以部分权限激活
7. 在 PluginsPane 查看权限列表，验证只有 `file:read`
8. 撤销权限 → 验证插件回到 inactive

### TS-9: SessionData Cache (AC-C4)

**Scope**: Cache fallback when bridge unavailable

1. 激活一个使用 sessionData 的插件
2. 写入 sessionData `{ key: 'test', value: 123 }`
3. 验证缓存中有值
4. 断开 bridge（模拟 pi 进程退出）
5. 读取 sessionData `{ key: 'test' }` → 验证返回缓存值 123
6. 恢复 bridge
7. 验证缓存 dirty 数据被 flush

### TS-10: Hot Reload (AC-C5)

**Scope**: Plugin hot reload on file change

1. 创建 external 测试插件
2. 激活插件
3. 修改插件 `index.js`
4. 等待 300ms debounce
5. 验证插件自动 deactivate + activate
6. 验证前端收到 `plugin:statusChange`
7. 验证新代码生效

**Failure Scenario**:
- 8. 修改为有语法错误的代码 → 验证 status 变为 crashed

### TS-11: Bridge Reconnect (AC-C1)

**Scope**: Bridge extension reconnection after pi restart

1. 启动 pi 进程，Bridge 进入 Ready 状态
2. 模拟 pi 进程崩溃/重启
3. 验证 Bridge 进入 Disconnected 状态
4. 等待 pi 重启完成
5. 验证 Bridge 自动重连并重新注册 tool
6. 验证 Bridge 回到 Ready 状态
7. 验证同步超时场景（pi 30 次重试未响应 → Bridge 停止同步）

### TS-12: Goal/Todo Plugin Tests (AC-C2)

**Scope**: Unit tests for built-in plugins

1. Goal plugin: 测试 `create_tasks`、`update_tasks`、`list_tasks`、`complete_goal`、`cancel_goal`、`report_blocked`
2. Todo plugin: 测试 `add`、`update`、`delete`、`clear`、`list`
3. 验证 sessionData 读写（mock RPC）
4. 验证 hooks 注册和 handler 行为

## Test Priority

| Priority | Scenarios | Rationale |
|----------|-----------|-----------|
| P0 (Must) | TS-1, TS-2, TS-3, TS-8 | Core functionality: tool execution, hook chain, UI rendering, permissions |
| P1 (Should) | TS-4, TS-5, TS-6, TS-9 | Standard features: toggle, settings, status bar, cache |
| P2 (Nice) | TS-7, TS-10, TS-11, TS-12 | Quality features: decoration, hot reload, reconnect, plugin tests |
