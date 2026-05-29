---
verdict: pass
must_fix: 0
reviewer: robustness-expert
date: 2026-05-29
scope: git diff a54ec76..HEAD (plugin-remaining-phases)
---

# 健壮性审查报告

## 审查范围

| 维度 | 文件 |
|------|------|
| UI 弹窗 60s 超时 | `plugin-service.ts` (handleUiRequest/dispatchUiRequest/handleUiResponse/processNextUiRequest), `useExtensionUI.ts` |
| Worker 重建 | `plugin-host.ts` (handleWorkerCrash/rebuildWorker) |
| SessionData 持久化 | `plugin-storage.ts` (persistSessionData/loadSessionData/deleteSessionData), `plugin-service.ts` (flushSessionData) |
| Hook 执行 | `plugin-service.ts` (executeHooks), `event-adapter.ts` (translate) |
| 权限审批超时 | `plugin-activator.ts` (waitForPermissionApproval/resolvePermissionApproval) |
| Session/Agent RPC | `plugin-service.ts` (registerRpcMethods → session/agent/workspace handlers) |
| 前端 | `useExtensionUI.ts`, `ExtensionUIDialog.vue`, `protocol.ts` |
| 服务组装 | `index.ts` (main → DI wiring) |

## 六维度评估

### 1. 错误处理 — ✅ 良好

| 检查点 | 评价 |
|--------|------|
| SessionData flush 失败恢复 dirty | ✅ `flushSessionData` 先快照 dirty 数据，`persistSessionData` 失败后恢复 dirty 标记，下次定时器周期重试。正确。 |
| loadSessionData ENOENT 静默 | ✅ 返回空 Map，非 ENOENT 错误输出 warn 日志。 |
| deleteSessionData ENOENT 静默 | ✅ 同上。 |
| findFiles 动态 import 失败 | ✅ `try/catch` 返回空数组，不崩溃。 |
| executeHooks handler 失败放行 | ✅ catch 中输出 warn 日志，不终止 hook 链路。 |
| event-adapter hook 异常 | ✅ `onBeforeToolCall` / `onAfterToolResult` 的 hook 回调用 `try/catch` 包裹，异常时使用原始数据继续。 |
| handleEvent 异步错误 | ✅ `attach` 中用 `void ... .catch()` 捕获异步异常，输出 `console.error`。 |
| Worker 创建失败 | ✅ `createWorker` 捕获异常并 re-throw，调用方 `assignWorker` 传播错误。 |
| rebuildWorker 失败 | ✅ `setTimeout` 调度时 `.catch()` 捕获异常，输出 `console.error`。 |

### 2. 异常安全 — ✅ 良好

| 检查点 | 评价 |
|--------|------|
| flushSessionData 先 clear 后 persist | ✅ 先清除 dirty（测试友好），失败时从 `dirtySnapshot` 恢复。无数据丢失风险。 |
| Worker crash 状态保护 | ✅ `handleWorkerCrash` 开头检查 `handle.status === 'crashed'`，幂等不重复处理。 |
| UI 请求队列异常安全 | ✅ `dispatchUiRequest` 设置 timeout 兜底。即使前端永远不响应，60s 后自动 resolve 默认值。 |
| 权限审批超时 | ✅ `waitForPermissionApproval` 30s 超时自动 resolve(false)，不泄漏 Promise。 |
| plugin-service shutdown | ✅ 停止 flush timer → 停止 watcher → 停用所有插件 → flush 存储 → 终止 worker。有序清理。 |

### 3. 日志完整性 — ✅ 良好

| 检查点 | 评价 |
|--------|------|
| 错误日志包含上下文 | ✅ flush 失败包含 sessionId、error message。Worker 重建包含 workerId。Hook 失败包含 handlerId。 |
| warn vs error 区分 | ✅ 可恢复错误（flush 失败、hook 超时）用 `console.warn`；不可恢复（rebuild 失败、worker 创建失败）用 `console.error`。 |
| 前端日志 | ✅ `handleEvent` 的 catch 输出 `[EventAdapter] handleEvent error:`。 |

### 4. Fail-Fast — ✅ 良好

| 检查点 | 评价 |
|--------|------|
| 权限未通过 → 立即 UNLOADED | ✅ 拒绝或超时后状态设为 UNLOADED，不分配 Worker。 |
| SessionData 超过 10MB → 立即抛错 | ✅ `persistSessionData` 在写入前检查 `Buffer.byteLength`，超出上限立即 throw。 |
| setModel 无 active session → 静默返回 | ✅ 不抛错，不调用 switchModel。 |
| setModel 格式无效 → 静默返回 | ✅ `parts.length < 2` 时 return。 |
| sessionService 缺失 → 降级 | ✅ 所有依赖 sessionService 的 handler 都有 `if (!this.deps.sessionService)` 守卫，缺失时返回空值/stub。 |

### 5. 测试友好 — ✅ 良好

| 检查点 | 评价 |
|--------|------|
| 依赖注入 | ✅ `IPluginServiceDeps` 允许注入 sessionService/configService/broadcastFn。 |
| 可覆盖超时 | ✅ `ActivatorOptions.permissionTimeoutMs`、`PluginHost.setRebuildCooldownMs()`。 |
| 测试覆盖全面 | ✅ 新增测试 7 个文件，覆盖：UI 弹窗串行/超时、Worker 重建/sandbox 不重建/超过 3 次放弃、SessionData 持久化 roundtrip/10MB/ENOENT、权限审批/拒绝/超时、Agent RPC、findFiles、demo E2E。 |

### 6. 调试友好 — ✅ 良好

| 检查点 | 评价 |
|--------|------|
| UI requestId 唯一 | ✅ `${pluginId}_${Date.now()}_${Math.random().toString(36).slice(2)}` 三段式，可追溯来源。 |
| Worker ID 递增 | ✅ `trusted-${counter}` 便于追踪重建历史。 |
| 状态变更广播 | ✅ crash/permissionRequest/statusChange/notification 均通过 WS 广播前端可见。 |

## 重点检查结论

### ✅ UI 弹窗 60s 超时清理

`dispatchUiRequest` 设置 `setTimeout(60_000)`，回调内：
1. 从 `pendingUiRequests` Map 删除
2. 调用 `processNextUiRequest()` 处理队列中下一个
3. resolve 默认值（confirm → false, select/input → undefined）

`handleUiResponse` 正常响应时：
1. `clearTimeout(pending.timer)`
2. 从 Map 删除
3. resolve 实际值
4. 调用 `processNextUiRequest()`

**结论**: 超时和正常路径都正确清理 timer 和 Map entry，无泄漏。

### ✅ Worker 重建失败安全处理

`rebuildWorker` 的调用链：
- `handleWorkerCrash` 通过 `setTimeout(cooldown)` 调度
- `rebuildWorker` 本身 `.catch()` 捕获异常
- 超过 3 次 crash → 输出 warn 日志，不再重建
- `crashedTrustedWorkers` Map 在 rebuild 开始时 delete，防止重复重建
- sandbox worker crash 不触发重建逻辑

**结论**: 重建失败不影响其他 worker，crash 计数防循环崩溃。

### ✅ SessionData 持久化 atomic write

`persistSessionData` 流程：
1. `JSON.stringify` → 检查 10MB 限制
2. `writeFile(tmpPath, content)` 写临时文件
3. `rename(tmpPath, filePath)` 原子重命名

`rename` 在同文件系统上是原子操作。`tmpPath` 包含时间戳和随机后缀，避免并发冲突。

**结论**: Atomic write 实现正确。极端情况：如果 `.tmp` 文件写入后进程崩溃，`tmp` 文件残留不影响正常读取（`loadSessionData` 只读最终路径）。

### ✅ Hook 执行失败放行

`executeHooks` 中：
- 每个 handler 用 `try/catch` 包裹
- 超时 5s（由 `rpcServer.invoke` 的 timeout 参数控制）
- 异常时输出 `console.warn` 并继续执行下一个 handler
- Worker crashed（`handle` 为 undefined）时 `continue` 跳过

`event-adapter.ts` 中的 hook 调用：
- `onBeforeToolCall` / `onAfterToolResult` 均有 `try/catch`
- 异常时使用原始 input/output，不阻止正常事件流

**结论**: Hook 失败不影响主流程，符合 fail-open 设计。

### ✅ 权限审批超时清理

`waitForPermissionApproval`:
- 设置 `setTimeout(permissionTimeoutMs)`
- 超时回调：删除 Map entry + resolve(false)
- 正常路径（`resolvePermissionApproval`）：`clearTimeout` + 删除 Map entry + resolve(approved)
- `pluginId` 作为 Map key，同一插件不会重复注册（每次激活时才注册）

**结论**: 无 timer/Promise 泄漏。

## 低风险观察（非阻塞）

| # | 观察点 | 风险等级 | 说明 |
|---|--------|---------|------|
| O1 | `index.ts` 中 `pluginService!` 非空断言 | 低 | `pluginService` 在 `sessionService` 构造时尚为 undefined，但 EventAdapter 的 `onHookExecute` 只在 session 创建后的运行时调用，此时 `pluginService` 已赋值。注释已解释此设计。 |
| O2 | `rebuildWorker` 重建后不触发 activate | 低 | 重建仅创建新 Worker，不重新执行 activate 流程。插件需要在下次事件触发时重新激活，或通过 crash callback 的 `markCrashed` → 前端手动触发。当前行为与 Phase 设计一致。 |
| O3 | `handleUiRequest` 使用 `Math.random()` | 低 | requestId 唯一性依赖 Date.now() + Math.random()，在极端并发下理论上可能碰撞。实际使用中 plugin RPC 是串行处理，风险可忽略。 |
| O4 | `findFiles` 结果截断 1000 条 | 低 | 合理的保护性限制，防止 glob 意外返回海量结果。 |
| O5 | `getActiveSession` 线性扫描 | 低 | 当前 session 数量级下无性能问题，未来可优化为维护 active 引用。 |

## 总结

| 维度 | 评分 |
|------|------|
| 错误处理 | A |
| 异常安全 | A |
| 日志完整性 | A- |
| Fail-Fast | A |
| 测试友好 | A |
| 调试友好 | A- |

**verdict: pass** — 所有五个重点检查项通过，无 must-fix 问题。实现健壮性良好，错误路径均有合理兜底。
