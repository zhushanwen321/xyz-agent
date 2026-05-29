---
verdict: pass
---

# E2E Test Plan — Plugin Remaining Phases

## Test Environment

- 本地开发环境（macOS）
- `npm run dev` 启动 Electron + Vite
- `src-electron/runtime/test/` 目录下的 Vitest 单元测试
- Demo 插件作为端到端验证载体

## Test Scenarios

### TS-1: Session API 真实调用

**覆盖 AC**: AC-1

1. Mock `ISessionService`，验证 `listSessions` handler 调用 `sessionService.listPersistedSessions()`
2. 验证 `getSession(knownId)` 返回转换后的 SessionInfo
3. 验证 `sendMessage(sessionId, 'user', 'hello')` 调用 `sessionService.sendMessage()`
4. 验证 sessionService 为 undefined 时 fallback 到 stub 行为

### TS-2: SessionData 持久化

**覆盖 AC**: AC-2

1. 写入 sessionData → 验证 JSON 文件生成
2. 清空内存缓存 → 从文件恢复 → 验证数据一致
3. 写入超过 10MB 数据 → 验证抛出 STORAGE_LIMIT_EXCEEDED
4. 并发写入同一 session → 验证无数据损坏（atomic write）

### TS-3: Agent API 真实调用

**覆盖 AC**: AC-3

1. `getModel()` 返回 configService 中的默认模型
2. `setModel('anthropic', 'claude')` → `getModel()` 返回新值（读己之写）
3. `getActiveTools()` 返回已注册 tool schema 列表

### TS-4: UI 弹窗完整 RPC 路径

**覆盖 AC**: AC-4

1. `showSelect` 发送 WS `plugin:uiRequest`（method: 'select'）
2. 模拟前端响应 `plugin.uiResponse` → Promise resolve 为选中项
3. `showConfirm` / `showInput` 类似路径
4. 60s 超时 → resolve undefined
5. 多个并发请求 → 排队串行处理

### TS-5: 权限审批推送

**覆盖 AC**: AC-5

1. 激活需要权限的 sandbox 插件 → 广播 `plugin:permissionRequest`
2. 模拟审批 → 插件继续激活为 ACTIVE
3. 模拟拒绝 → 插件标记 UNLOADED
4. 已授权权限 → 不重复请求

### TS-6: findFiles

**覆盖 AC**: AC-6

1. `findFiles('**/*.ts')` 返回匹配文件列表
2. 验证忽略 node_modules 和 .git
3. 超过 1000 条结果截断

### TS-7: Worker Crash 重建

**覆盖 AC**: AC-7

1. 模拟 trusted Worker exit → 等待 5s → 新 Worker 创建 → 插件恢复 ACTIVE
2. 连续 3 次 crash → 放弃重建，保持 CRASHED
3. sandbox Worker crash → 不触发重建

### TS-8: Hook 桥接

**覆盖 AC**: AC-8

1. 注册 `onBeforeSendMessage` handler → 发送消息 → 验证 handler 被调用，transformedContent 生效
2. handler 返回 `{ blocked: true }` → 消息不发送
3. 注册 `onBeforeToolCall` handler → tool 调用被拦截/修改
4. 注册 `onAfterToolResult` handler → 返回结果被修改
5. `onPiEvent` 收到 agent_start/end 等事件广播

### TS-9: Demo 插件端到端

**覆盖 AC**: AC-10

1. Demo 插件激活 → 注册 `demo_search` tool
2. 调用 `demo_search` tool → findFiles 返回文件列表 → storage 写入成功
3. 发送包含 `!important` 的消息 → hook 拦截并转换为大写
4. sessionData 读写验证

### TS-10: SDK 类型包

**覆盖 AC**: AC-9

1. `npm pack` 成功
2. 导入 `xyz-agent-plugin-sdk` → IDE 类型补全正常
3. mock agentAPI 方法签名与真实 API 一致
