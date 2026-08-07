# 远程化 P6 实施计划：并发保护扩展

**日期**: 2026-07-26 | **spec**: [spec.md](spec.md)（决策编号 D1-D11 在此引用） | **前置**: P5（clientId 透传 + broker 定向 API + presence）已实施

> 所有 Task 遵守：vitest（各包内 `npx vitest run`）；lint/hook 问题正面修复；**不主动 git commit**。

---

## 任务清单

### T1 — async-mutex 基础设施（spec §3.1，D1）

**文件**：
- `packages/runtime/src/infra/async-mutex.ts`（新建）：createKeyedMutex + run + 超时
- `packages/runtime/src/infra/async-mutex.test.ts`（新建）

**测试**（spec §六）：
- 同 key 串行（第二个等第一个完成）
- 不同 key 并发（互不阻塞）
- 超时拒绝（timeoutMs 后抛 TimeoutError）
- chain 清理无泄漏（无排队时 Map 条目删除）

---

### T2 — git per-cwd mutex（spec §3.2，D2）

**文件**：
- `packages/runtime/src/services/git-service.ts`：6 个写入命令（commit/add/reset/unstage/checkout/createBranch/checkoutByCwd）包裹 `gitMutex.run(cwd, ..., 10_000)`
- 只读命令（status/diff/log/branch/list）不变
- 超时 → reply error `{ code: 'git_busy' }`（在 git-message-handler.ts 或对应 handler 捕获 TimeoutError）

**测试**（`services/git-service.test.ts` 扩展）：
- 并发两 commit 同 cwd：串行化（第二个等第一个）
- 并发两 commit 不同 cwd：互不阻塞
- 只读 status 与写入 commit 并发：只读不等
- 超时 10s：第二个 commit 被拒（git_busy）

---

### T3 — config CAS（spec §3.3，D3/D4）

**文件**：
- `packages/runtime/src/infra/pi/pi-provider-store.ts`（或 models.json schema）：加 `version: number` 字段，读取旧文件 default 0
- `packages/runtime/src/services/config-service.ts`：setProvider/setDefaultModel/upsertSkill/deleteSkill/setSkillDirs/setAgentDirs/setDefaultBaseBranch 签名加 `expectedVersion: number`
  - 读取 current.version → 对比 → 不等抛 VersionConflictError → 相等 set + version++
- `packages/runtime/src/services/config-message-handler.ts`：set 命令 handler 取 payload.expectedVersion 传给 service；捕获 VersionConflictError → reply error `{ code:'version_conflict', currentVersion }`
- `packages/shared/src/protocol.ts`：config set ClientMessage payload 加 `expectedVersion: number`

**客户端**：
- `packages/renderer/src/stores/settings.ts`：缓存 `version`（每次 config.* 广播/reply 更新）
- `packages/renderer/src/api/domains/config.ts`：setProvider 等 RPC 调用带 `expectedVersion: settings.version`
- 收到 version_conflict → 重新拉 config.list → toast「{device} 已修改配置，已刷新，请重试」（spec §三.3 客户端配合）

**测试**：
- `services/config-service.test.ts`（扩展）：expectedVersion 匹配/不匹配；旧 models.json 读取 version=0
- 客户端 settings store 测试：version 缓存更新；version_conflict 后重新拉取

---

### T4 — worktree in-flight 去重（spec §3.4，D5）

**文件**：
- `packages/runtime/src/services/worktree/worktree-service.ts`：createBareWorktree/createPlainRepoWorktree 包裹 `worktreeMutex.run(${cwd}:${branchName}, ..., 10_000)`
- 超时 → reply error `{ code: 'worktree_busy' }`

**测试**（`services/worktree/worktree-service.test.ts` 扩展）：
- 并发两 create 同分支同 cwd：第二个等第一个完成后报分支已存在
- 并发两 create 不同分支：互不阻塞

---

### T5 — session.delete 广播（spec §3.5，D6）

**文件**：
- `packages/shared/src/protocol.ts`：ServerMessageType 加 `session.deleting`；session.deleted 保持现状（用法从 reply 扩展为 reply + broadcastExcept 广播）
- `packages/runtime/src/transport/session-message-handler.ts:78-84`：delete handler 改为两步广播
  ```ts
  broker.broadcast({ type: 'session.deleting', payload: { sessionId: delSid, byClientId: clientId } })
  await sessionService.delete(delSid)
  reply(ws, msg.id, 'session.deleted', { sessionId: delSid })
  // 【R2-C1 修正】broadcastExcept 排除发起方——发起方已通过 reply 收到，不重复收广播
  broker.broadcastExcept(clientId, { type: 'session.deleted', payload: { sessionId: delSid } })
  return broadcastSessionList()
  ```
- `packages/renderer/src/composables/features/useSidebar.ts`：
  - **抽离** cleanupSession(sessionId) 纯函数（10+ store 清理链从 deleteSession 抽出）
  - deleteSession（发起方 reply 路径）和 handleSessionDeleted（广播路径）都调 cleanupSession

**客户端消费**：
- `packages/renderer/src/composables/useConnection.ts` routeInbound：session.deleting 和 session.deleted 都带 sessionId，自动走 session 通道
- `packages/renderer/src/composables/features/useSidebar.ts`：
  - 订阅 session.deleting → soft close panel（panel unmount，暂不清 store）
  - 订阅 session.deleted → cleanupSession（清 10+ store 分区）

**测试**：
- `transport/session-message-handler.test.ts`（扩展）：
  - 删除时广播 session.deleting（全量）+ session.deleted（**broadcastExcept 排除发起方**，R2-C1）
  - **发起方只收 reply session.deleted，不收广播 session.deleted**（R2-C1 关键断言）
  - **其他客户端收广播 session.deleted**（R2-C1）
- 客户端 useSidebar 测试：session.deleting → panel 收起（DOM 断言）；session.deleted → store 分区清理（chat sessions map 不含该 sid）

---

### T6 — terminal resize owner（spec §3.6，D7；**R4-C1：scrollback 归 P2，本 Task 不含 scrollback**）

**文件**：
- `packages/runtime/src/services/terminal/terminal-service.ts`：
  - 新增 `resizeOwners: Map<sessionId, { clientId, ownerDevice }>`（**R1-m1：字段名 ownerDevice**）
  - resize handler：检查 owner，≠ 当前 clientId 拒绝 reply error `{ code:'resize_locked', owner, ownerDevice }`
  - onDisconnect 钩子：清理该 clientId 持有的所有 resizeOwner
  - destroyPty：清 resizeOwner Map 条目（**scrollback 清理由 P2 已实现**，P6 不重复）
- onDisconnect 钩子注入：terminal-service 需要订阅 connection-manager 的 onDisconnect 事件（P5 已透传 clientId + 新增 onDisconnect 回调）

**测试**（`services/terminal/terminal-service.test.ts` 扩展）：
- resize owner：A 持有 → B 拒绝；A 断开 → B 成功；同 owner 重复成功
- **不含 scrollback 测试**（P2 T5 已覆盖）

---

### T7 — feature-map 同步 + verify 脚本

**文件**：
- `docs/feature-map/2026-07-26-remote.md`：
  - §九 P6 描述确认（presence 已在 P5 移走，P6 只剩并发保护）
  - §十一索引追加 P6 spec/plan 链接
  - §十二.2「多客户端并发冲突」标注：本 spec 落地（D1-D11）
- `tools/verify-concurrency.cjs`（新建）：真 runtime 场景
  - 场景 1：config CAS 冲突（A 改 version 0→1，B 用 expectedVersion=0 改被拒）
  - 场景 2：并发 git commit 同 cwd（串行化验证）
  - 场景 3：session delete 多客户端感知（B 收到 deleting + deleted 广播）

---

## 依赖与顺序

```
T1（mutex 基础设施）─→ T2（git）─→ T4（worktree）
                  └→ T6（terminal，依赖 T1 的 mutex 思路但不直接用 keyed mutex）
T3（config CAS）独立（不依赖 mutex，是乐观锁范式）
T5（session delete 广播）独立（只依赖 P5 broker 广播能力）
T7 依赖 T1-T6 完成
```

T1 是 T2/T4/T6 的地基。
T3/T5 可与 T1-T2 并行（不依赖 mutex）。

## DoD

0. **【R2-m4 前置 gate】** P5（clientId 透传 + broker broadcastExcept/sendToClient + onDisconnect 回调 + presence store）已实施——P6 的 session.delete 广播用 broadcastExcept、terminal resize owner 用 ctx.getClientId + onDisconnect 清理
1. vitest 全绿（runtime + renderer，新增 + 现有）
2. `tools/verify-concurrency.cjs` exit 0（三场景）
3. spec §六测试计划全覆盖（async-mutex / git per-cwd / config CAS / worktree 串行 / session delete 广播 / resize owner）。**不含 scrollback**（R4-C1 归 P2）
4. feature-map §九 P6 描述更新；§十二.2 标注落地
5. `npm run lint` + pre-commit 全过
6. **客户端可见断言**：config version_conflict 后 toast 提示；session.delete 广播后其他客户端 panel 收起（DOM 断言）；terminal resize 被拒时提示
