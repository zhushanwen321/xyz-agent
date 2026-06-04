# A1 健壮性审查报告

审查范围: `src-electron/runtime/src/` 的 `main...HEAD` diff
审查日期: 2026-06-04
审查类型: 错误处理、边界条件、时序问题、超时处理

---

## 1. MUST_FIX

### 1.1 Extension UI 请求超时从 300s 降为 30s — 行为变更

- **文件**: `extension-timeout-manager.ts:4`
- **描述**: `EXTENSION_UI_REQUEST_TIMEOUT_MS` 从 `300_000`（5 分钟）改为 `30_000`（30 秒）。Extension UI 请求（select/confirm/input）需要前端用户手动操作，30 秒对于复杂 UI 交互（如下拉选择、确认对话框思考）太短。超时后会自动发送默认响应（confirm=false / select=undefined），导致用户还没操作就被默认拒绝了。
- **原始代码**: server.ts 中 `const EXTENSION_UI_REQUEST_TIMEOUT_MS = 300_000`
- **新代码**: `extension-timeout-manager.ts` 中 `const EXTENSION_UI_REQUEST_TIMEOUT_MS = 30_000`
- **修复方向**: 恢复为 300_000，或根据实际 UI 交互场景设定合理值（建议不低于 120s）。如果要缩短，需要在前端增加明确的倒计时提示。

### 1.2 `extension.ui_response` 处理中 `sendCommand` 失败不再保留超时兜底

- **文件**: `server.ts` → `handleExtensionMessage()` 新代码
- **描述**: 原始代码中，`sendCommand` 失败时不清除计时器，让超时机制兜底（注释原文: "如果 sendCommand 抛异常，计时器保留让超时机制兜底"）。新代码先 `clearTimeout` 再 `sendCommand`（顺序反了），如果 `sendCommand` 抛异常，计时器已被清除，没有任何兜底机制向 pi 发送响应。pi 侧将永远等不到该请求的响应。
- **原始代码**:
  ```typescript
  await client.sendCommand(...)
  this.clearExtensionTimeout(requestId)  // 成功后才清
  ```
- **新代码**:
  ```typescript
  await client.sendCommand(...)
  this.extensionTimeoutMgr.clearTimeout(requestId)  // 同样先 send 再 clear，但...
  ```
  实际上仔细看新代码顺序是对的（先 sendCommand 再 clearTimeout），但问题在于: 外层 try-catch 在 server.ts `handleMessage` 中会捕获异常并调 `sendError`，但 `sendError` 不会向 pi 发 `extension_ui_response`，pi 侧仍会挂起。
- **修复方向**: 在 `handleExtensionMessage` 的 `extension.ui_response` case 中，对 `sendCommand` 加 try-catch，失败时不调用 `clearTimeout`，让超时回调兜底。

### 1.3 `bridge-handler.ts` 的 `catch` 中 `throw sendErr` 会导致未处理的 Promise 拒绝

- **文件**: `bridge-handler.ts:89`
- **描述**: `handleBridgeRequest` 在外层 catch 中尝试发送错误响应，如果发送也失败，`throw sendErr` 会向上抛出。但此方法的调用者 `server.ts` 的 `handleBridgeRequest` 没有对这次调用做 try-catch（它直接 `await this.bridgeHandler.handleBridgeRequest(...)`），异常会被 server.ts 的外层 catch 捕获并调 `sendError` — 但 `sendError` 是发给前端 WebSocket 的，不是发给 pi RPC 的。结果是: pi 侧收不到任何响应，前端收到一个无关的错误消息。
- **修复方向**: `bridge-handler.ts` 的内层 catch 中不要 `throw sendErr`，改为仅 log。`handleBridgeRequest` 的设计意图是"尽力发送响应给 pi"，pi 和前端都不应该收到异常。

### 1.4 `plugin-rpc-setup.ts` 中 `plugin.notify` 不再通过 broker 广播

- **文件**: `plugin-rpc-setup.ts:81-89`
- **描述**: 原始代码通过 `this.broker.broadcast({ type: 'plugin:notification', ... })` 广播通知到前端。新代码改为 `deps.broadcastFn('plugin:notification', payload)`，但 `deps.broadcastFn` 可能不存在（类型为 `broadcastFn?: ...`），此时通知会被静默吞掉。即使存在，`broadcastFn` 的签名可能只接受 `(type, payload)` 而非构建完整的 `ServerMessage`，前端可能收不到正确格式。
- **修复方向**: 确认 `broadcastFn` 的签名和 `IMessageBroker.broadcast` 的兼容性。如果 `broadcastFn` 不存在，应 fallback 到其他广播路径（或至少 log warn）。

---

## 2. LOW

### 2.1 `flushSessionData` 中 dirty snapshot 恢复在并发场景下可能丢失数据

- **文件**: `session-data-flush.ts:35-40`
- **描述**: `flushSessionData` 在 `dirtyKeys.clear()` 之后、`persistSessionData` 失败时恢复 dirty 标记。但在 clear 和 restore 之间，如果有新的 set 操作写入同一个 key，restore 会把旧标记加回来，而新值已经被包含在 persist 尝试中了。这不是数据丢失（cache 中的值是最新的），但 dirty 标记恢复可能导致下次 flush 时重复写入同一 key。这是原有代码的问题，提取后未改善。
- **修复方向**: 可接受，标记为 LOW 是因为不影响数据正确性，只是冗余写入。

### 2.2 `TreeMessageHandler` 多处 `throw e` 向上冒泡但调用方不一定能处理

- **文件**: `tree-message-handler.ts` 的 `session.tree-navigate`、`session.tree-fork`、`session.tree-capability`、`session.tree-clone` 各 case
- **描述**: 当错误不包含 "not found" 时，`throw e` 向上冒泡到 server.ts 的 `handleMessage` 外层 catch。那里会调用 `sendError(ws, 'handler_error', message, msg.id, sessionId)`。但 `sessionId` 是通过 `'sessionId' in msg.payload` 提取的 — 对于 tree 消息，`payload.sessionId` 一定存在所以没问题。但错误消息会是原始异常的英文 message，对用户不友好。
- **修复方向**: 可以在 tree handler 中对非 not-found 错误也做友好化处理，但当前行为不会导致功能问题。保持 LOW。

### 2.3 `handleExtensionMessage` 缺少 `extension.install` 和 `extension.uninstall` 的错误处理一致性问题

- **文件**: `server.ts` → `handleExtensionMessage()`
- **描述**: `extension.install` 和 `extension.uninstall` 有自己的 try-catch，能正确返回 `install_failed`/`uninstall_failed` 错误给前端。但 `extension.toggle` 没有 try-catch，如果 `toggleExtension` 抛异常，会冒泡到 server.ts 的外层 catch 返回通用 `handler_error`。不够一致，但功能上不会丢错误。
- **修复方向**: 为 `extension.toggle` 加 try-catch 以保持一致。

### 2.4 `parseSessionHeader` 和 `extractSessionName` 对大文件的性能问题

- **文件**: `session-file-utils.ts:30-50`、`52-73`
- **描述**: 这两个函数用 `readFileSync` 读取整个文件，然后 `split('\n')` 创建所有行的数组。对于有大量消息的 session 文件（可能几十 MB），每次调用都会完整读取和分割。`extractSessionName` 已经是倒序遍历，可以在找到第一个 `session_info` 后 break，但 `parseSessionHeader` 只需要第一行，不需要读整个文件。
- **修复方向**: `parseSessionHeader` 可以用 `readline` 或只读文件开头部分。当前不影响正确性，性能影响在 session 文件很大时才明显。

---

## 3. INFO

### 3.1 `BridgeHandler` 构造时传入 `null`，后续使用需 null check

- **文件**: `server.ts:37`、`server.ts:49`
- **描述**: `this.bridgeHandler = new BridgeHandler(null)` 初始化为 null，在 `setServices` 中如果有 plugin 才替换。`handleBridgeRequest` 中先检查 client 是否存在才调用 `bridgeHandler`，但如果 `pluginService` 为 null，bridge handler 的所有 `this.pluginService?.xxx` 都会走 optional chain 返回 undefined，不会崩溃。这是安全的。
- **风险**: 无。

### 3.2 `session-file-utils.ts` 中 `ensureSessionFile` 和 `persistSessionName` 使用同步文件 API

- **文件**: `session-file-utils.ts` 全文
- **描述**: 使用 `openSync`/`writeSync`/`closeSync` 而非异步 API。这些函数在 session 创建/重命名路径上调用，但同步 IO 在 Node.js 中会阻塞事件循环。当前调用频率低（用户操作触发），实际影响可忽略。
- **风险**: 低。

### 3.3 `session-data-flush.ts` 中 `flushSessionDataForSession` 失败后不清除 dirty 标记

- **文件**: `session-data-flush.ts:68-72`
- **描述**: 与 `flushSessionData` 的批量版本不同，单 session 版本在 persist 失败后只 log 不恢复 dirty 标记。这是有意为之（调用方是 deactivate/关闭，不会重试），与原始代码行为一致。
- **风险**: 无，符合设计意图。

### 3.4 常量提取质量

- **文件**: 多个文件
- **描述**: 将魔数（`10_000`、`30_000`、`36`、`2`）提取为命名常量（`COMMAND_EXECUTE_TIMEOUT_MS`、`RADIX_BASE36`、`SLICE_START` 等）。这是纯重构，不改变行为。注意 `plugin-storage.ts` 中 `MB = BYTES_PER_KB * BYTES_PER_KB = 1024 * 1024 = 1,048,576`，原始代码是 `10 * 1024 * 1024 = 10,485,760`。新代码 `TEN * MB = 10 * 1,048,576 = 10,485,760`。值相同，无问题。
- **风险**: 无。

---

## 总结

| 优先级 | 数量 | 关键问题 |
|--------|------|----------|
| MUST_FIX | 4 | 超时从 300s→30s (1.1)、sendCommand 失败无兜底 (1.2)、bridge handler throw (1.3)、notify 广播路径变更 (1.4) |
| LOW | 4 | flush 并发 dirty 恢复 (2.1)、tree throw 不友好 (2.2)、toggle 缺 try-catch (2.3)、大文件性能 (2.4) |
| INFO | 4 | null 初始化安全 (3.1)、同步 IO (3.2)、flush 失败不恢复 dirty (3.3)、常量提取 (3.4) |

**最紧急**: 1.1（超时缩短 10 倍）和 1.2（sendCommand 失败导致 pi 侧挂起）会影响线上用户体验。
