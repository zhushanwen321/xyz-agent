---
verdict: pass
---

# E2E Test Plan — Runtime + Front-end Architecture Refactoring

## Test Strategy

纯重构项目，E2E 测试的核心目标是**行为不变性验证**：重构前后所有功能表现一致。不测新功能（因为无新功能），只测回归。

## Test Scenarios

### Scenario 1: Runtime Start/Stop
- **AC覆盖**: AC-General
- **步骤**: 启动 Runtime (`node runtime/src/index.js --port 3210`)，确认日志输出 `[runtime] ready`，连接 WS 客户端，断开，发送 SIGTERM，确认进程退出
- **预期**: Runtime 正常启动、接受 WS 连接、优雅关闭

### Scenario 2: Session Lifecycle (Full CRUD)
- **AC覆盖**: AC-1
- **步骤**:
  1. WS 发送 `session.create`，验证返回 `session.created` + `session.list` 广播
  2. WS 发送 `session.list`，验证包含新建 session
  3. WS 发送 `session.switch`，验证返回 `session.history`
  4. WS 发送 `session.rename`，验证返回 `session.renamed`
  5. WS 发送 `session.history`，验证返回消息数组（从活跃 session 获取）
  6. WS 发送 `session.compact`，验证返回 `session.compacted`（或超时）
  7. WS 发送 `session.clear`，验证返回 `session.deleted`
  8. 创建另一个 session，获取 sessionId
  9. WS 发送 `session.restore`，验证返回 `session.restored`
  10. WS 发送 `session.delete`，验证返回 `session.deleted`
- **预期**: 所有 session CRUD 操作（create/delete/rename/switch/history/compact/clear/restore）行为与重构前一致

### Scenario 3: Config CRUD (Provider/Skill/Agent)
- **AC覆盖**: AC-1, AC-6
- **步骤**:
  1. WS 发送 `config.getProviders`，验证返回 provider 列表
  2. WS 发送 `config.setProvider`，验证返回 `config.providerUpdated` + 广播
  3. WS 发送 `config.scanSkills`，验证返回 `config.scannedSkills`
  4. WS 发送 `config.setSkill`，验证返回 `config.skillUpdated`
  5. WS 发送 `config.deleteSkill`，验证返回 `config.skillDeleted`
  6. WS 发送 `config.scanAgents`，验证返回 `config.scannedAgents`
  7. WS 发送 `config.setAgent`，验证返回 `config.agentUpdated`
  8. WS 发送 `config.deleteAgent`，验证返回 `config.agentDeleted`
- **预期**: 所有配置操作走 Service 层，行为不变

### Scenario 4: Model Operations
- **AC覆盖**: AC-1
- **步骤**:
  1. WS 发送 `model.list`，验证返回模型聚合列表
  2. WS 发送 `config.discoverModels`，验证返回发现模型列表（或错误）
- **预期**: 模型聚合和发现走 ModelService，行为不变

### Scenario 5: Scanner Base Dedup
- **AC覆盖**: AC-7
- **步骤**:
  1. `grep "expandHome" runtime/src/scanner-base.ts` → 有匹配（共享实现）
  2. `grep "inferSourceType" runtime/src/scanner-base.ts` → 有匹配
  3. `grep "expandHome" runtime/src/skill-scanner.ts runtime/src/agent-scanner.ts` → 无匹配（已提取）
  4. `grep "import.*scanner-base" runtime/src/skill-scanner.ts runtime/src/agent-scanner.ts` → 有匹配
  5. 功能测试：WS 发送 `config.scanSkills`，验证返回结果正常
  6. 功能测试：WS 发送 `config.scanAgents`，验证返回结果正常
- **预期**: expandHome/inferSourceType 只在 scanner-base.ts 中定义，skill-scanner 和 agent-scanner 通过 import 使用

### Scenario 6: Type Safety Verification
- **AC覆盖**: AC-2
- **步骤**:
  1. 编译检查：`npx tsc --noEmit`（runtime workspace）
  2. 确认 `event-adapter.ts` 的 `translate()` 入参类型为 `PiEvent` 联合类型
  3. 确认 `types.ts` 被 event-adapter、rpc-client、message-converter import
- **预期**: 编译通过，无 `Record<string, any>` 残留

### Scenario 6: Dead Code Verification
- **AC覆盖**: AC-4
- **步骤**:
  1. `grep -r "approveTool\|denyTool\|alwaysAllowTool" runtime/src/rpc-client.ts` → 无匹配
  2. `grep "sendSessionCreated\|sendSessionDeleted\|sendSessionList\|sendProviderList\|sendModelList\|sendError" runtime/src/event-adapter.ts` → 无匹配（class method 定义，非 handleEvent 中的引用）
  3. `ls runtime/src/session-pool.ts` → 文件不存在
  4. `ls renderer/src/composables/useModel.ts renderer/src/composables/useRafBatch.ts renderer/src/composables/useContext.ts` → 文件不存在
- **预期**: 所有死代码已清除

### Scenario 7: DI + Service Layer Structure
- **AC覆盖**: AC-3, AC-1
- **步骤**:
  1. `grep "interface IRpcClient" runtime/src/interfaces.ts` → 有匹配
  2. `grep "interface IProcessManager" runtime/src/interfaces.ts` → 有匹配
  3. `grep "interface IMessageBroker" runtime/src/interfaces.ts` → 有匹配
  4. `ls runtime/src/services/session-service.ts runtime/src/services/config-service.ts runtime/src/services/model-service.ts` → 文件存在
  5. `grep "constructor" runtime/src/services/session-service.ts` → 包含 IRpcClient/IProcessManager/IMessageBroker/IEventAdapter 参数
  6. `wc -l runtime/src/server.ts` → ≤ 250
  7. `grep "loadSkills\|saveSkills\|loadAgents\|saveAgents" runtime/src/server.ts` → 无匹配
- **预期**: Service 层结构正确，DI 接口存在

### Scenario 8: Message Converter
- **AC覆盖**: AC-5
- **步骤**:
  1. `grep "export function convertPiHistory" runtime/src/message-converter.ts` → 有匹配
  2. `grep "from.*types" runtime/src/message-converter.ts` → import PiHistoryMessage
  3. `grep "convertPiHistory" runtime/src/session-pool.ts` → 无匹配（session-pool 已删除）
- **预期**: convertPiHistory 独立存在，使用 types.ts 类型

### Scenario 9: Frontend System Notification
- **AC覆盖**: AC-8
- **步骤**:
  1. `grep "createSystemNotification" renderer/src/lib/system-notification.ts` → 有匹配
  2. `grep "createSystemNotification" renderer/src/composables/useChat.ts renderer/src/App.vue` → 有匹配（使用工厂）
  3. `grep "crypto.randomUUID.*role.*system" renderer/src/views/PanelSessionView.vue renderer/src/composables/useChat.ts renderer/src/App.vue` → 无匹配（不再手动构造）
- **预期**: 工厂函数存在并被使用

### Scenario 10: Frontend refCount
- **AC覆盖**: AC-9
- **步骤**:
  1. `grep "globalListenerRefCount" renderer/src/composables/useSession.ts` → 有匹配
  2. `grep "globalListenerRefCount" renderer/src/composables/useProvider.ts` → 有匹配
- **预期**: refCount 保护存在

### Scenario 11: Full Build Verification
- **AC覆盖**: AC-General
- **步骤**: `npm run build`（项目根目录）
- **预期**: 前后端 + runtime 全部构建成功

## Test Environment

- **前置条件**: 工作目录为项目 worktree 根目录
- **Runtime 测试**: 需要端口 3210 可用（或使用其他端口），需要 pi CLI 在 PATH 中
- **前端测试**: 需要 Vite 构建通过
- **编译检查**: 需要 TypeScript 编译器（`npx tsc`）
