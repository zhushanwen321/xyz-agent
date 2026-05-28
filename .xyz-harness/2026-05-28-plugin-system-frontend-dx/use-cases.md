---
verdict: pass
---

# Use Cases — Plugin System Frontend + Quality

## UC-1: 用户查看和管理已安装插件列表

- **Actor**: 终端用户
- **Preconditions**: xyz-agent 已启动，至少有 Goal 和 Todo 两个 built-in 插件
- **Main Flow**:
  1. 用户打开 Settings
  2. 用户点击 "Plugins" tab
  3. 系统发送 `plugin.list` WS 消息
  4. Sidecar 返回插件列表
  5. PluginsPane 渲染插件卡片列表（名称、版本、状态 badge、信任等级 badge、来源标签）
- **Alternative Paths**:
  - AP-1: 无外部插件时显示空状态引导（"Install a plugin to get started"）
  - AP-2: WS 断连时显示最后已知状态 + 离线提示
- **Postconditions**: 用户看到完整的插件列表
- **Module Boundaries**: PluginsPane → PluginStore.fetchPlugins() → WS → server.ts → PluginService
- **Spec AC Coverage**: AC-B1

## UC-2: 用户启用/禁用外部插件

- **Actor**: 终端用户
- **Preconditions**: 至少有一个已安装的外部插件（status: inactive）
- **Main Flow**:
  1. 用户在 PluginsPane 找到目标插件
  2. 用户点击 Toggle 开关
  3. PluginStore 发送 `plugin.toggle { pluginId, enabled: true }` WS 消息
  4. Sidecar 调用 PluginService.toggle → PluginActivator.activate
  5. Sidecar 推送 `plugin:statusChange { oldStatus: 'inactive', newStatus: 'active' }`
  6. 前端更新状态 badge
- **Alternative Paths**:
  - AP-1: built-in 插件的 Toggle 灰显，点击无效果
  - AP-2: 激活失败（缺少依赖）→ 显示错误信息
  - AP-3: 激活需要权限 → 触发 UC-5
- **Postconditions**: 插件状态变更，UI 同步更新
- **Module Boundaries**: PluginsPane → PluginStore.togglePlugin() → WS → server.ts → PluginService → PluginActivator
- **Spec AC Coverage**: AC-B2

## UC-3: 用户卸载外部插件

- **Actor**: 终端用户
- **Preconditions**: 至少有一个外部插件
- **Main Flow**:
  1. 用户在 PluginsPane 点击插件卸载按钮
  2. 弹出确认对话框
  3. 用户确认
  4. PluginStore 发送 `plugin.uninstall { pluginId }` WS 消息
  5. Sidecar 调用 PluginService.uninstall → deactivatePlugin → deletePluginFiles
  6. Sidecar 推送 `plugin:statusChange { newStatus: 'removed' }`
  7. 前端从列表移除该插件
- **Alternative Paths**:
  - AP-1: built-in 插件无卸载按钮
  - AP-2: 卸载失败（文件锁定）→ 显示错误信息
- **Postconditions**: 插件文件删除，从列表消失
- **Module Boundaries**: PluginsPane → PluginStore → WS → server.ts → PluginService → PluginStorage
- **Spec AC Coverage**: AC-B2

## UC-4: 插件 Tool 被 LLM 实际调用

- **Actor**: LLM（代表用户意图）
- **Preconditions**: 一个注册了 tool 的插件已激活，LLM 在处理用户请求时决定调用该 tool
- **Main Flow**:
  1. LLM 生成 tool_call 请求（如 `goal_manager`）
  2. Pi Bridge Extension 收到 tool execute 请求
  3. Bridge 通过 `bridge:tool_execute` 发送到 sidecar
  4. server.ts 调用 PluginService.handleBridgeToolExecute
  5. PluginService 在 toolRegistry 中查找注册该 tool 的插件
  6. PluginService 通过 RPC `invoke` 向对应 Worker 发送 `plugin.tool.execute`
  7. Worker 内 tool handler 执行业务逻辑
  8. Worker 返回执行结果
  9. PluginService 将结果通过 Bridge 返回给 pi
  10. LLM 收到 tool 执行结果，继续对话
- **Alternative Paths**:
  - AP-1: Tool 未注册 → 返回 `{ content: 'Tool not found', isError: true }`
  - AP-2: Worker 崩溃 → 返回 `{ content: 'Plugin worker crashed', isError: true }`
  - AP-3: 执行超时（30s）→ 返回 `{ content: 'Execution timed out', isError: true }`
- **Postconditions**: Tool 执行结果返回 pi，LLM 继续处理
- **Module Boundaries**: pi → Bridge → server.ts → PluginService → Worker RPC → Worker handler
- **Spec AC Coverage**: AC-A1

## UC-5: 插件 Hook 阻止消息发送

- **Actor**: 安全审计插件（自动触发）
- **Preconditions**: 一个 trusted 插件注册了 `onBeforeSendMessage` hook，handler 返回 `blocked: true` 当检测到 API key
- **Main Flow**:
  1. 用户发送包含 API key 的消息
  2. server.ts 调用 PluginService.executeHooks('onBeforeSendMessage', context)
  3. PluginService 按 priority 排序 hook handler（trusted 优先）
  4. PluginService 串行 invoke Worker A（trusted）
  5. Worker A 检测到 API key，返回 `{ blocked: true, reason: 'Contains API key' }`
  6. PluginService 终止 hook 链
  7. 返回 `{ blocked: true, blockedBy: 'plugin-a' }` 给 server.ts
  8. server.ts 通知前端消息被阻止
  9. sandbox 插件的 handler 不被调用
- **Alternative Paths**:
  - AP-1: 所有 handler 返回放行 → 消息正常发送
  - AP-2: handler 超时（5s）→ 视为放行，继续链
  - AP-3: handler 返回 transformedContent → 修改后的内容传递给下一个 handler
- **Postconditions**: 消息被阻止或被修改后放行
- **Module Boundaries**: server.ts → PluginService.executeHooks → Worker RPC (serial)
- **Spec AC Coverage**: AC-A2, AC-A3

## UC-6: 开发者热重载插件

- **Actor**: 插件开发者
- **Preconditions**: 开发者有一个 external 插件在 `~/.xyz-agent/plugins/my-plugin/`
- **Main Flow**:
  1. 开发者修改 `~/.xyz-agent/plugins/my-plugin/index.js`
  2. PluginActivator 的 fs.watch 检测到变更（300ms debounce）
  3. PluginActivator 调用 PluginService.deactivatePlugin('my-plugin')
  4. deactivate 完成（超时 5s）
  5. PluginActivator 调用 PluginService.activatePlugin('my-plugin', event)
  6. 新代码加载到 Worker Thread
  7. Sidecar 推送 `plugin:statusChange { oldStatus: 'active', newStatus: 'active' }`（先 inactive 再 active）
  8. 前端短暂显示 refreshing 状态后恢复 active
- **Alternative Paths**:
  - AP-1: 新代码有语法错误 → activate 失败 → status: crashed → 前端显示错误
  - AP-2: deactivate 超时 → force terminate → 重新 activate
  - AP-3: built-in 插件不监听（跳过）
- **Postconditions**: 插件使用新代码重新激活
- **Module Boundaries**: fs.watch → PluginActivator → PluginService → Worker Thread
- **Spec AC Coverage**: AC-C5

## UC-7: 用户修改插件配置

- **Actor**: 终端用户
- **Preconditions**: 一个有 `contributes.settings` 的插件已激活
- **Main Flow**:
  1. 用户在 PluginsPane 展开插件详情
  2. 系统渲染 PluginSettingsForm（基于 manifest schema）
  3. PluginStore 发送 `plugin.config.get { pluginId }` 获取当前值
  4. 表单填充当前值
  5. 用户修改某个配置项
  6. PluginStore 发送 `plugin.config.set { pluginId, key, value }`
  7. Sidecar 通过 RPC 转发到 Worker
  8. Worker 更新配置并返回确认
  9. 配置即时生效
- **Alternative Paths**:
  - AP-1: 配置项标记 `requiresRestart` → 显示"需要重启插件"提示
  - AP-2: 无 `contributes.settings` → 不显示 Settings 区域
- **Postconditions**: 配置值更新并持久化
- **Module Boundaries**: PluginSettingsForm → PluginStore → WS → server.ts → PluginService → Worker RPC
- **Spec AC Coverage**: AC-B3

## UC-8: 插件请求权限审批

- **Actor**: 终端用户
- **Preconditions**: 一个插件首次激活，需要 `file:read` 和 `network:fetch` 权限
- **Main Flow**:
  1. PluginActivator 检测到权限请求
  2. Sidecar 推送 `plugin:permissionRequest { pluginId, permissions }`
  3. 前端弹出 PluginPermissionDialog
  4. 用户逐项查看权限并批准/拒绝
  5. 前端发送 `plugin.approvePermissions { pluginId, permissions: ['file:read'] }`
  6. Sidecar 更新权限存储
  7. 插件激活继续
- **Alternative Paths**:
  - AP-1: 用户全部拒绝 → 插件不激活，status: discovered
  - AP-2: 用户部分批准 → 仅授予已批准的权限
- **Postconditions**: 权限状态持久化，插件基于授权权限运行
- **Module Boundaries**: PluginActivator → PluginService → server.ts broadcast → PluginPermissionDialog → WS approve → PluginPermissionStorage
- **Spec AC Coverage**: AC-B7

## UC-Coverage Matrix

| UC | Spec AC |
|----|---------|
| UC-1 | AC-B1 |
| UC-2 | AC-B2 |
| UC-3 | AC-B2 |
| UC-4 | AC-A1 |
| UC-5 | AC-A2, AC-A3 |
| UC-6 | AC-C5 |
| UC-7 | AC-B3 |
| UC-8 | AC-B7 |

**未覆盖的 AC**（非交互性，测试覆盖）:
- AC-A4 (plugin.executeCommand) → T3 测试覆盖
- AC-B4 (status bar) → T12 测试覆盖
- AC-B5 (slash commands) → T12 测试覆盖
- AC-B6 (message decoration) → T12 测试覆盖
- AC-C1 (bridge reconnect test) → T6 测试覆盖
- AC-C2 (goal/todo test) → T7 测试覆盖
- AC-C3 (hooks serial test) → T2 测试覆盖
- AC-C4 (sessionData cache) → T4 测试覆盖
- AC-D1/D2 (documentation) → T13 验证
