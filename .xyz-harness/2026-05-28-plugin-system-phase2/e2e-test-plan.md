---
verdict: pass
---

# E2E Test Plan — Plugin System Phase 2

## Test Environment

**前置条件：**
- xyz-agent dev 模式运行（`npm run dev`）
- pi 进程正常启动（可通过 sidecar WS 连接）
- 测试用插件已放置到 `~/.xyz-agent/plugins/` 或 `resources/plugins/`

**测试工具：**
- sidecar 内单元测试（vitest）— 覆盖 PluginRPC、PermissionChecker、PluginActivator 等
- 集成测试脚本（`tools/verify-*.cjs`）— 验证 Bridge ↔ sidecar ↔ Worker 完整链路
- 手动验证 — LLM 实际调用 plugin tool

## Test Scenarios

### TS-1: Bridge Tool Proxy 端到端（AC-1）

**目标：** 验证 LLM 调用 plugin tool 的完整链路

**Steps:**
1. 启动 xyz-agent，确认 Bridge extension 加载成功（检查 pi stderr 日志）
2. 确认 Bridge 进入 Ready 状态（检查 sidecar 日志）
3. 在聊天界面输入"列出当前可用的工具"
4. 验证 LLM 响应中包含 plugin 注册的 tool 名称
5. 输入触发 tool 调用的指令
6. 验证 tool 调用正确路由到 Worker 并返回结果

### TS-2: Goal Plugin 端到端（AC-8）

**目标：** 验证 Goal plugin 的完整功能

**Steps:**
1. 确认 Goal plugin 激活（source=built-in, status=ACTIVE）
2. 输入"创建一个目标：实现用户登录功能，任务：设计数据库、写 API、写测试"
3. 验证 `goal_manager` tool 被调用（action=create_tasks）
4. 验证任务列表在 UI 中渲染（RenderDescriptor _render.type=task-list）
5. 输入"完成了第一个任务"
6. 验证 LLM 调用 goal_manager（action=update_tasks）
7. 重启 session，验证 goal 状态从 sessionData 恢复

### TS-3: Todo Plugin 端到端（AC-9）

**目标：** 验证 Todo plugin 的完整功能

**Steps:**
1. 确认 Todo plugin 激活
2. 输入"添加一个待办：检查代码风格"
3. 验证 `todo` tool 被调用（action=add）
4. 输入"列出所有待办"
5. 验证返回的 todo 列表包含新添加的项
6. 重启 session，验证 todo 状态恢复

### TS-4: Permission System（AC-4）

**目标：** 验证权限检查机制

**Steps:**
1. 安装一个 sandbox 模式的测试插件
2. 插件尝试调用 `api.storage.get()`
3. 验证返回 PERMISSION_DENIED
4. 在 `permissions.json` 中添加插件权限
5. 重试调用，验证成功

### TS-5: Worker Sandbox（AC-5）

**目标：** 验证 sandbox Worker 的 require 限制

**Steps:**
1. 安装一个 sandbox 模式插件，代码中包含 `require('fs')`
2. 确认插件激活时 Worker 不崩溃（捕获异常）
3. 验证 `api.storage.get()` 仍可用
4. 验证 `process.env` 返回空 proxy

### TS-6: Plugin Dependencies（AC-7）

**目标：** 验证依赖检查和拓扑排序

**Steps:**
1. 安装插件 A（依赖 B@^1.0.0），不安装 B
2. 验证 A 标记为 DEPS_MISSING
3. 安装插件 B
4. 重启 xyz-agent
5. 验证 B 先于 A 激活（日志时间戳）
6. 安装两个互相依赖的插件
7. 验证两者都拒绝激活

## Coverage Matrix

| Test Scenario | AC Covered |
|---------------|------------|
| TS-1 | AC-1 |
| TS-2 | AC-8 |
| TS-3 | AC-9 |
| TS-4 | AC-4 |
| TS-5 | AC-5 |
| TS-6 | AC-7 |
| (AC-2 covered by unit tests) | AC-2 |
| (AC-3 covered by unit tests) | AC-3 |
| (AC-6 covered by unit tests) | AC-6 |
