---
verdict: pass
---

# Use Cases — Plugin System Phase 2

## UC-1: 内置 Goal 插件为 LLM 提供任务追踪

- **Actor:** LLM（代表用户意图）
- **Preconditions:** xyz-agent 已启动，Goal built-in plugin 已激活
- **Main Flow:**
  1. 用户输入复杂任务描述（如"帮我实现用户认证模块"）
  2. LLM 调用 `goal_manager` tool（action=create_tasks），传入任务列表
  3. Goal plugin 通过 `api.sessionData.set()` 持久化任务状态
  4. 前端通过 RenderDescriptor 渲染任务列表
  5. 下一 turn 开始时，Goal 的 onBeforeAgentStart hook 注入 steering prompt
  6. LLM 根据 steering prompt 按计划执行
  7. 任务完成后 LLM 调用 `goal_manager` tool（action=update_tasks）标记完成
- **Alternative Paths:**
  - 用户暂停 goal：LLM 调用 action=pause，hook 停止注入 steering prompt
  - 用户更新任务：LLM 调用 action=add_tasks/remove_tasks
  - Session 恢复后：Goal 的 onPiEvent('session_start') 从 sessionData 恢复状态
- **Postconditions:** 任务进度持久化在 pi session 文件中，跨 turn 可追踪
- **Module Boundaries:** Goal Worker Thread ↔ PluginRPC ↔ Pi Bridge ↔ pi 进程

**AC 覆盖:** AC-1（Bridge tool proxy）, AC-8（Goal 验证）

## UC-2: 第三方插件注册自定义 Tool

- **Actor:** 插件开发者
- **Preconditions:** 插件已安装到 `~/.xyz-agent/plugins/`，manifest 正确
- **Main Flow:**
  1. xyz-agent 启动，PluginRegistry 扫描外部插件目录
  2. PluginActivator 激活插件（trusted 模式），Worker Thread 启动
  3. 插件代码调用 `api.tools.register({name, description, parameters, execute})`
  4. PluginRPC 将 tool schema 注册到 PluginService
  5. PluginService 通过 Bridge sync 将 tool 注册给 pi
  6. Bridge 调用 `pi.registerTool()` 注册代理 tool
  7. LLM 在 function call 时看到新 tool，调用它
  8. Bridge execute handler 转发到 sidecar → PluginRPC → Worker execute
  9. 结果原路返回给 pi LLM
- **Alternative Paths:**
  - 插件依赖缺失：PluginActivator 标记 DEPS_MISSING，不激活
  - 权限不足（sandbox 插件）：PermissionChecker 拒绝，返回 PERMISSION_DENIED
- **Postconditions:** LLM 可调用插件注册的 tool，结果正确返回
- **Module Boundaries:** Worker Thread ↔ PluginRPC ↔ PluginService ↔ Pi Bridge ↔ pi

**AC 覆盖:** AC-1（Bridge）, AC-2（agentAPI）, AC-4（权限）

## UC-3: 插件拦截消息发送

- **Actor:** 安全审计插件（sandbox 模式）
- **Preconditions:** 插件已安装并持有 `hooks:beforeSend` 权限
- **Main Flow:**
  1. 用户输入包含 API key 的消息
  2. SessionService.sendMessage 触发 beforeSend hook 管道
  3. PluginService.executeHooks('message:beforeSend', {content, sessionId})
  4. 安全插件 hook handler 检测到敏感信息
  5. Handler 返回 `{blocked: true, reason: '消息包含 API key'}`
  6. PluginService 停止 hook 链，消息不发送
  7. 通知用户消息被阻止及原因
- **Alternative Paths:**
  - 无敏感信息：handler 返回 `{blocked: false}`，消息正常发送
  - Handler 修改内容：返回 `{blocked: false, transformedContent: '...'}`
  - Handler 超时（5s）：视为放行
- **Postconditions:** 敏感消息不发送到 pi，用户收到通知
- **Module Boundaries:** SessionService → PluginService → Workers（hook handlers）

**AC 覆盖:** AC-3（事件桥接）

## UC-4: 插件依赖安装检查

- **Actor:** 用户（手动安装插件）
- **Preconditions:** 插件 A 声明依赖插件 B（`extensionDependencies: ["B@^1.0.0"]`）
- **Main Flow:**
  1. 用户将插件 A 复制到 `~/.xyz-agent/plugins/`
  2. PluginRegistry 扫描新插件，解析 manifest
  3. PluginActivator 检查 extensionDependencies
  4. 插件 B 未安装，记录 warning 日志
  5. 插件 A 标记为 DEPS_MISSING 状态
  6. 插件 A 不被激活
- **Alternative Paths:**
  - 依赖已安装：正常激活，拓扑排序保证 B 先于 A 激活
  - 循环依赖（A→B→A）：两者都拒绝激活
- **Postconditions:** 缺失依赖的插件不激活，日志有 warning
- **Module Boundaries:** PluginRegistry → PluginActivator（依赖图）

**AC 覆盖:** AC-7（依赖验证）

## UC 覆盖映射表

| UC | AC 覆盖 |
|----|---------|
| UC-1 | AC-1, AC-8 |
| UC-2 | AC-1, AC-2, AC-4 |
| UC-3 | AC-3 |
| UC-4 | AC-7 |
| (AC-5 sandbox) | 不需要独立 UC（通过 AC-5 单元测试验证） |
| (AC-6 built-in) | 被 UC-1 覆盖（Goal 是 built-in） |
| (AC-9 Todo) | 被 UC-1 类似覆盖（Todo 也是 built-in） |
