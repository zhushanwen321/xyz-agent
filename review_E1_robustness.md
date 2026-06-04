# 健壮性审查报告：runtime test 覆盖评估

**分支**: `feat-integration-pi-extension` (main...HEAD)
**日期**: 2026-06-04
**审查范围**: `src-electron/runtime/test/` 变更 + 对应源码

---

## 一、总览

| 维度 | 状态 |
|------|------|
| 新增/修改源文件 | 30 个 |
| 新增/修改测试文件 | 8 个 |
| 有直接测试的源文件 | 4 个（extension-resolver, extension-service, event-adapter, protocol types） |
| **无测试的新源文件** | **11 个** |

测试全部通过（8 files, 116 tests, vitest）。

---

## 二、无测试覆盖的新源文件（MUST_FIX）

### 1. `extension-timeout-manager.ts` (101 行)
- **优先级**: MUST_FIX
- **文件**: `src-electron/runtime/src/extension-timeout-manager.ts`
- **描述**: 新增的 `ExtensionTimeoutManager` 类，管理 extension UI 请求超时。包含 `registerTimeout`、`clearTimeout`、`clearForSession`、`isBridgeRequest` 等关键方法。现有测试仅通过 `server` 的内部属性间接验证了 `isBridgeRequest`，但核心逻辑（超时触发、定时器清理、session 级批量清理、bridge 请求不设超时）没有直接单元测试。
- **缺失场景**:
  - 超时实际触发 → `onTimeout` 回调被调用
  - `clearTimeout` 在超时前清除 → `onTimeout` 不被调用
  - `clearForSession` 清理多个请求
  - `notify` 方法跳过注册
  - `bridge:` 前缀方法只加入 bridgeRequestIds 不设超时
- **修复方向**: 新建 `extension-timeout-manager.test.ts`，用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()` 测试超时逻辑。

### 2. `bridge-handler.ts` (95 行)
- **优先级**: MUST_FIX
- **文件**: `src-electron/runtime/src/bridge-handler.ts`
- **描述**: `BridgeHandler` 处理 4 种 bridge 方法（sync、tool_execute、event、intercept）+ 错误恢复。没有单元测试。现有 `bridge-reconnect.test.ts` 和 `bridge-sync.test.ts` 测试的是 `SidecarServer` 的集成路径，不是 `BridgeHandler` 本身。
- **缺失场景**:
  - `bridge:sync` → 收集 toolSchemas 返回 tools/commands
  - `bridge:tool_execute` → 路由到 PluginService
  - `bridge:event` → 触发 handleBridgeEvent
  - `bridge:intercept` → before_agent_start 拦截
  - pluginService 为 null 时的降级处理
  - `sendCommand` 抛异常时的错误恢复
  - 未知 bridge 方法的 warn + error response
- **修复方向**: 新建 `bridge-handler.test.ts`，mock `IRpcClient` 和 `IPluginService`。

### 3. `session-file-utils.ts` (139 行)
- **优先级**: MUST_FIX
- **文件**: `src-electron/runtime/src/session-file-utils.ts`
- **描述**: 提供 `parseSessionHeader`、`extractSessionName`、`ensureSessionFile`、`persistSessionName` 四个纯函数。全部涉及文件 I/O 和 JSON 解析，边界条件多（空文件、损坏 JSON、EEXIST 竞态），零测试覆盖。
- **缺失场景**:
  - `parseSessionHeader`: 空文件、非 JSON、非 session type entry、正常 header
  - `extractSessionName`: 无 session_info、多条 session_info 取最后一条、中间有损坏行
  - `ensureSessionFile`: 文件已存在跳过、目录不存在自动创建、EEXIST 竞态不报错
  - `persistSessionName`: 文件存在时追加、文件不存在时创建（带/不带 id+cwd）
- **修复方向**: 新建 `session-file-utils.test.ts`，用 `vi.mock('node:fs')` mock 文件操作。

### 4. `settings-message-handler.ts` (120 行)
- **优先级**: MUST_FIX
- **文件**: `src-electron/runtime/src/settings-message-handler.ts`
- **描述**: 从 `SidecarServer` 提取的 settings/model/session 配置消息路由。处理 17+ 种消息类型。零测试覆盖。原有 `server.test.ts` 可能覆盖了部分集成场景，但该 handler 的独立逻辑没有验证。
- **缺失场景**:
  - `config.discoverModels` 成功/失败路径
  - `model.switch` → sessionService.switchModel 调用
  - `session.setThinkingLevel` → sessionService 调用
  - `config.setProvider` / `config.deleteProvider` → 广播
  - 未知 type → 返回 false
- **修复方向**: 新建 `settings-message-handler.test.ts`，mock `SettingsHandlerContext`。

### 5. `tree-message-handler.ts` (96 行)
- **优先级**: MUST_FIX
- **文件**: `src-electron/runtime/src/tree-message-handler.ts`
- **描述**: Session tree 相关 5 种消息路由，含 auto-restore 降级逻辑。零测试。
- **缺失场景**:
  - `session.tree-data` 正常返回 / not found → auto-restore / restore 也失败
  - `session.tree-navigate` 正常 / not found
  - `session.tree-fork` → rebindAfterFork + broadcastSessionList
  - `session.tree-clone` → broadcastSessionList
  - `session.tree-capability` → isNavigateCapable 结果
- **修复方向**: 新建 `tree-message-handler.test.ts`，mock `TreeHandlerContext`。

### 6. `plugin-message-handler.ts` (80 行)
- **优先级**: MUST_FIX
- **文件**: `src-electron/runtime/src/plugin-message-handler.ts`
- **描述**: `plugin.*` 消息路由（11 种消息类型）。零测试。
- **缺失场景**:
  - pluginService 为 null → sendError
  - 各种消息类型的路由正确性
  - `plugin.install` 缺少 packageSpec → sendError
  - `plugin.uiResponse` → handleUiResponse 调用
- **修复方向**: 新建 `plugin-message-handler.test.ts`。

### 7. `services/git-info.ts` (39 行)
- **优先级**: LOW
- **文件**: `src-electron/runtime/src/services/git-info.ts`
- **描述**: `readGitInfo` 调用 `git rev-parse` + 检测 worktree。纯 I/O，相对简单。零测试。
- **缺失场景**: 非 git 目录返回 undefined、worktree 检测、git 超时
- **修复方向**: mock `execSync` + `statSync`/`readFileSync`

### 8. `services/plugin-service/bridge-interop.ts` (90 行)
- **优先级**: LOW
- **文件**: `src-electron/runtime/src/services/plugin-service/bridge-interop.ts`
- **描述**: `handleBridgeToolExecute`、`handleBridgeEvent`、`handleBridgeIntercept` 三个函数。注意：**旧版** `plugin-tool-execution.test.ts` 和 `plugin-hooks-integration.test.ts` 测试的是 `PluginService` 上的同名方法，这些方法现在委托到 `bridge-interop.ts` 的独立函数。旧测试仍然有效（通过 PluginService 间接覆盖），但新提取的函数本身没有直接测试。
- **修复方向**: 如果旧集成测试持续通过且覆盖了关键路径，可接受。否则新建 `bridge-interop.test.ts` 直接测试。

### 9. `services/plugin-service/session-data-flush.ts` (87 行)
- **优先级**: LOW
- **文件**: `src-electron/runtime/src/services/plugin-service/session-data-flush.ts`
- **描述**: 从 PluginService 提取的 flush 逻辑。`plugin-session-data-cache.test.ts` 通过 PluginService 的内部接口间接覆盖了 `flushSessionData`、`flushSessionDataForSession`、`startFlushTimer`、`stopFlushTimer`。间接覆盖可接受。

### 10. `services/plugin-service/plugin-rpc-setup.ts` (246 行)
- **优先级**: LOW
- **文件**: `src-electron/runtime/src/services/plugin-service/plugin-rpc-setup.ts`
- **描述**: 从 PluginService 提取的 RPC 方法注册。原有 plugin-rpc.test.ts 和其他 plugin API 测试通过 PluginService 间接覆盖。但新增的 `updateStatusBarItem` 逻辑（empty text = remove item）和 `agent.setModel`（从 model 字符串解析 provider/modelId）没有专门测试。
- **修复方向**: 低优先级，但 `setModel` 的 `split('/')` 解析逻辑建议添加边界测试。

### 11. `services/session-history.ts` (56 行)
- **优先级**: LOW
- **文件**: `src-electron/runtime/src/services/session-history.ts`
- **描述**: `getHistoryFromFile` 从 .jsonl 文件解析消息历史。零测试。
- **缺失场景**: 文件不存在（ENOENT）、空文件、无 message entry、损坏行跳过

---

## 三、已有测试的问题

### 12. `extension-service.test.ts` 使用真实文件系统
- **优先级**: LOW
- **文件**: `src-electron/runtime/test/extension-service.test.ts`:39-50
- **描述**: 测试在 `/tmp/xyz-agent-test/extensions` 下创建真实文件目录。旧版测试使用 `vi.mock('node:fs/promises')` 的纯 mock 方案。新方案：
  - 在 `/tmp` 写真实文件 → 并发测试可能冲突
  - `afterEach` 用 `require('node:fs')` 混合导入（已顶部导入 `existsSync` 等）
  - `beforeEach` 每次重建目录但不清理旧状态 → 残留文件可能影响下次测试
- **修复方向**: 改用 `vi.mock('node:fs')` + `vi.mock('node:child_process')` 纯 mock 方案，与 `extension-resolver.test.ts` 风格一致。

### 13. `extension-resolver.test.ts` mock 过于宽松
- **优先级**: INFO
- **文件**: `src-electron/runtime/test/extension-resolver.test.ts`
- **描述**: `mockDir` 辅助函数的 `statSync` mock 对所有非 `shared` 路径都返回 `isDirectory: true`，不检查完整路径匹配。这可能导致扫描到不该扫描的路径时不报错，隐藏 bug。
- **修复方向**: `statSync` mock 增加路径白名单校验。

### 14. `event-adapter-bridge.test.ts` 类型断言使用 `unknown` 强转
- **优先级**: INFO
- **文件**: `src-electron/runtime/test/event-adapter-bridge.test.ts`:25
- **描述**: `const listener = client.onEvent.mock.calls[0][0] as (event: unknown) => void` — 绕过了 pi 事件类型检查，如果事件结构变化不会编译报错。
- **修复方向**: 定义 pi event 的测试 fixture type，保持类型安全。

---

## 四、覆盖度总结

### 有充分测试的新增/修改源文件

| 源文件 | 测试文件 | 覆盖评价 |
|--------|----------|----------|
| `extension-resolver.ts` | `extension-resolver.test.ts` (419 行, 14 tests) | 覆盖 5 个 scan 方法 + deduplicate + resolve 集成。`normalizeExtName` 和 `isValidPiExtension` 通过集成间接覆盖。良好 |
| `extension-service.ts` | `extension-service.test.ts` (178 行, 9 tests) | 覆盖 scan/toggle/install/uninstall/getPaths。install 成功路径缺失。中等 |
| `event-adapter.ts` (setWidget/setStatus 部分) | `event-adapter-bridge.test.ts` (139 行) + `statusline-event-adapter.test.ts` + `event-adapter-extension.test.ts` | 覆盖 setWidget/setStatus 正常+边界。良好 |
| `@xyz-agent/shared` protocol types | `protocol-extension.test.ts` | 类型编译验证，extension.install/uninstall/source 字段。基本 |

### 服务器路由层覆盖

`server.ts` 新增的 `extension.install` 和 `extension.uninstall` 消息路由**没有在 `server-extension.test.ts` 中测试**。该测试文件只覆盖了 `extension.ui_response`、`extension.list`、`extension.toggle`。

---

## 五、优先级排序建议

1. **MUST_FIX — `extension-timeout-manager.ts`**: 超时逻辑是 UI 交互的核心，延迟写入或定时器泄漏会导致用户卡死。建议第一个补。
2. **MUST_FIX — `session-file-utils.ts`**: 4 个纯函数，边界条件多，最容易写也最容易出 bug。
3. **MUST_FIX — `bridge-handler.ts`**: bridge 路由是 plugin ↔ pi 通信的关键路径，错误恢复逻辑需要独立验证。
4. **MUST_FIX — `settings-message-handler.ts` + `tree-message-handler.ts` + `plugin-message-handler.ts`**: 提取的 handler mixin，建议至少覆盖核心路径。
5. **LOW — `extension-service.test.ts` 真实文件系统**: 当前可用，但应改为 mock 风格与项目一致。
6. **LOW — `git-info.ts`, `session-history.ts`**: 简单工具函数，优先级最低。
