---
verdict: pass
---

# E2E Test Plan — 插件系统 Phase 1

## Test Scenarios

### TS-1: 插件发现与 Manifest 解析 (AC-1)
- 放置 3 个测试插件（valid manifest, missing xyzAgent field, incompatible manifestVersion）
- 调用 PluginRegistry.scan()
- 验证只有 valid 插件被返回，其他两个被跳过且记录了 warn 日志
- 验证 activationEvents 从 contributes 自动推断正确

### TS-2: Worker Thread 隔离 (AC-2)
- 创建 2 个插件（1 trusted + 1 sandbox）
- 验证 trusted 插件分配到同一个 Worker，sandbox 插件独占一个 Worker
- 在 sandbox Worker 中 throw uncaught exception
- 验证 trusted Worker 不受影响
- 验证前端收到 `plugin:crashed` 消息，包含正确的 pluginId

### TS-3: JSON-RPC 通信 (AC-3)
- 激活 hello-world 插件
- 通过 agentAPI proxy 调用 storage.global.set('key', 'value')
- 验证 RPC request/response 往返成功
- 模拟 30s 超时：设置 100ms 超时，不注册 handler，验证超时错误码 -32000
- 并发 10 个 RPC request，验证每个 response 的 id 正确对应

### TS-4: 懒激活 (AC-4)
- 创建声明 `onStartupFinished` 的插件 → 验证 initialize() 后自动激活
- 创建声明 `onSlashCommand:hello` 的插件 → 验证首次 `/hello` 前不加载
- 触发 `/hello` → 验证 activate() 被调用
- 调用 deactivate() → 验证 subscriptions 数组中的所有 Disposable 被 dispose

### TS-5: KV 持久化 (AC-5)
- set('key', { nested: true }) → 验证 globalState.json 写入磁盘
- 重启 PluginStorage → get('key') 返回 { nested: true }
- 写入超过 10MB 的数据 → 验证抛出 STORAGE_FULL (-32040)
- 两个插件并发 set 各 100 个 key → 验证互不干扰
- delete('key') → 验证 get('key') 返回 undefined

### TS-6: 现有功能不受影响 (AC-6)
- 运行已有 extension 测试套件（protocol-extension, event-adapter-extension, server-extension, extension-service）
- 验证全部通过
- 验证 session create/restore/switch 功能正常
- 验证 ExtensionService.scanExtensions() 仍然返回正确结果

## Test Environment

### 测试框架
- Node.js 内置 test runner (`node:test` + `node:assert`)
- 与现有测试一致（`src-electron/runtime/test/` 目录）

### 测试插件
- `test/fixtures/plugins/hello-world/` — 标准 manifest + activate/deactivate
- `test/fixtures/plugins/bad-manifest/` — 缺少 xyzAgent 字段
- `test/fixtures/plugins/incompatible-version/` — manifestVersion = 999
- `test/fixtures/plugins/trusted-plugin/` — trustLevel: trusted

### Mock 依赖
- **MockBroker**: 实现 IMessageBroker，捕获 sendEvent 参数
- **MockWorkspaceContext**: 提供 cwd hash
- **临时目录**: `os.tmpdir() + '/xyz-agent-test-' + Date.now()`，测试后清理

### 验证命令
```bash
cd src-electron && node --test test/plugin-*.test.js
```

### 现有测试回归
```bash
cd src-electron && node --test test/protocol-extension.test.js test/event-adapter-extension.test.js test/server-extension.test.js test/extension-service.test.js
```
