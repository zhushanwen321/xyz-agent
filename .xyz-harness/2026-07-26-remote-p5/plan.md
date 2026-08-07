# 远程化 P5 实施计划：操作互斥升级（租约锁 + busyOwner 定向广播 + presence）

**日期**: 2026-07-26 | **spec**: [spec.md](spec.md)（决策编号 D1-D10 在此引用） | **前置**: P0（`Map<clientId, ConnectionCtx>` 握手 + auth 门）+ P2（seq + ring buffer，本阶段不动）已实施

> 所有 Task 遵守：vitest（各包内 `npx vitest run`）；lint/hook 问题正面修复；**不主动 git commit**。

---

## 任务清单

### T1 — 核实前置 + protocol/types 扩展（无 fence）

**核实先行**（spec §八.1 已决）：
- 确认 `message.abort`（protocol.ts:41）现状存在，复用，不新增 session.abort
- 核实 isGenerating 翻转点（message-dispatcher :118-128 sendPrompt 失败【R3-m3】/ event-interpreter turn-end）

**文件**：
- `packages/shared/src/protocol.ts`：
  - ServerMessageType 联合新增 `session.busy` / `session.idle` / `presence.update`
  - **send.rejected payload 改为判别联合**（审查 C4）：`{ sessionId, message } & ({ reason:'busy'; busyOwnerId; busyOwnerDevice; leaseExpiresAt } | { reason:'other' })`，注释更新「投递语义从 broadcast 变 reply（发起方专属）」
  - `auth.ok` payload 加可选 `presence?` 字段
  - **ClientMessageType 不新增 session.abort**（审查 C2）
- `packages/runtime/src/services/session/types.ts:26-85`：IManagedSessionView 新增 `busyOwnerId?/leaseExpiresAt?`（**无 leaseFence**，审查 M1）
- `packages/shared/src/session.ts`：**【R1-C2】SessionSummary 同步加 `busyOwnerId?/leaseExpiresAt?`**（toSummary 透传，冷启动 config.sessions 段才能带 lease 状态）
- `packages/shared/src/protocol.ts`：**【R1-C3】ClientMessageType 加 `session.setActive`/`presence.list`**；ClientMessageMap/ReplyPayloadMap 登记；**【R1-M3】send.rejected 注释更新**（reply 型发起方专属）；**【R1-M2】auth.ok payload 注释累积结构**（继承 P2 字段 + presence）

**测试**：无（类型定义，tsc 编译通过即可）

---

### T2 — clientId 透传链 + onDisconnect 新增 + ALS 注入（spec §3.1，审查 C3/P7 D6）

**前置约束**：本地模式（P0 D5 clientId='local'）透传链同样生效。

**文件**（按依赖顺序）：
1. `packages/runtime/src/infra/async-context.ts`（新建，审查 P7 §2.0 需求）：
   ```ts
   import { AsyncLocalStorage } from 'node:async_hooks'
   export const sessionContext = new AsyncLocalStorage<{ clientId?: string }>()
   ```
2. `packages/runtime/src/interfaces.ts:54-59` IMessageBroker 接口加 `sendToClient/broadcastExcept`
3. `packages/runtime/src/transport/message-broker.ts`：实现 sendToClient（从 Map 查 ctx.ws）+ broadcastExcept（遍历跳过 excludeClientId）
4. `packages/runtime/src/transport/connection-manager.ts:30-34` ConnectionCallbacks：
   - **onConnect/onMessage 签名扩展**为 `(ws, clientId)`
   - **onDisconnect 新增**（审查 C3：现状无此回调，close 在 :97-101 内联）：`onDisconnect(ws: WsType, clientId: string): void`
   - handleConnection close 处理改为调 `callbacks.onDisconnect(ws, clientId)`（clientId 从 Map 反查）
5. `packages/runtime/src/transport/server.ts:75,83`：
   - 路由签名加 clientId：`handleMessage(msg, ws, clientId)`
   - **【ALS 注入】handleMessage 入口加 `sessionContext.run({ clientId }, () => ...)` 包裹**（审查 P7 D6 反向需求）
6. 6 个 handler 的 ctx 接口 + handle 方法签名加 clientId；MessageHandlerContext 加 getClientId/getClient/broadcastExcept/sendToClient

**测试**：
- `transport/connection-manager.test.ts`（扩展）：onConnect/onMessage 收到 clientId；**onDisconnect 在 close 时被调**（审查 C3 验证）；本地模式 clientId='local'
- `transport/message-broker.test.ts`（扩展）：sendToClient 命中/未命中；broadcastExcept 排除指定 clientId
- `infra/async-context.test.ts`（新建）：ALS run 内 getStore 返回 {clientId}；run 外返回 undefined；异步链路透传（Promise.then/setTimeout）

---

### T3 — LeaseManager + reaper（spec §3.2，无 fence，审查 M1/M4）

**文件**：
- `packages/runtime/src/services/session/lease-manager.ts`（新建）：
  - `acquire(sessionId, clientId, deviceName): { kind:'acquired', expiresAt } | { kind:'busy', owner, expiresAt }`（**无 fence**；**【R4-M3】同时检查 busyOwnerId 与 isGenerating**，任一为 true 且 owner≠当前 clientId 即拒绝；isGenerating=true 但 busyOwnerId=undefined 时 owner 返回 `'<orphan-pi>'`）
  - `renew(sessionId): boolean`（**只传 sessionId**，审查 M4：内部从 busyOwnerId 反查；busyOwnerId 空时 return false）
  - `release(sessionId, reason: 'turn_end'|'lease_expired'|'aborted'|'send_failed'): void`（**加 send_failed**，审查 M3）
  - `sweepExpired(): string[]`
  - `getBusySession(clientId): {sessionId}|undefined`（P7 用）
- `packages/runtime/src/index.ts`（组合根）：实例化 + `setInterval(sweepExpired, 5000)` + 进程退出 clear
- `session-service.ts`：updateSession 支持 undefined 清字段（或 clearLease 辅助方法）

**测试**（`services/session/lease-manager.test.ts` 新建）：
- acquire 冲突返回 busy；同 owner 返回 acquired；无 owner 返回 acquired
- **renew 只传 sessionId**：owner 有值时续租成功；owner 空时 return false（M4 验证）
- release 清 busyOwnerId/leaseExpiresAt（**无 leaseFence**）+ 广播 session.idle
- `vi.useFakeTimers`：advance 31s → sweepExpired 返回该 session；advance 29s → 不释放
- reaper 5s 间隔：advance 5s 触发一次 sweep

---

### T4 — message-dispatcher 改造（spec §3.3，审查 M3 send_failed + C2 message.abort + M4 renew）

**文件**：
- `packages/runtime/src/services/session/message-dispatcher.ts:91-100`：busy 检查改为 leaseManager.acquire
  - acquire 返回 busy → ctx.reply send.rejected（判别联合 reason='busy' 分支，含 busyOwnerId/busyOwnerDevice/leaseExpiresAt，**无 leaseFence**）+ ctx.broadcastExcept(clientId, session.busy)
  - acquire 返回 acquired → 继续 sendPrompt
- **【审查 M3】message-dispatcher :118-128 sendPrompt catch 块**：补 `leaseManager.release(sessionId, 'send_failed')`（失败立即释放，避免锁死 30s）
- **【审查 C2】message-dispatcher :161-194 message.abort 路径**（确认是 message.abort 非 session.abort）：补 `leaseManager.release(sessionId, 'aborted')`
- `packages/runtime/src/services/session/event-interpreter.ts`：
  - turn-end 复位点（:377,569-582）补 `leaseManager.release(sessionId, 'turn_end')`
  - **【审查 M4】pingTick 成功路径（:561-637）补 `leaseManager.renew(sessionId)`**（只传 sessionId，不传 clientId）
- message-dispatcher / event-interpreter 构造函数注入 LeaseManager

**测试**：
- `services/session/message-dispatcher.test.ts`（扩展）：
  - A 持有 lease，B 发消息：B 收到 reply send.rejected（含 busyOwnerId）；ctx.broadcastExcept 被调（排除 B）；A 不收到 send.rejected
  - 无 owner 时 A 发消息：acquire 成功 + sendPrompt 调用 + session.busy 广播
  - **sendPrompt 抛错 → leaseManager.release('send_failed') 被调**（M3 验证）
  - message.abort → leaseManager.release('aborted') 被调（C2 验证）
- `services/session/event-interpreter.test.ts`（扩展）：
  - agent_end → release('turn_end') 被调
  - pingTick 成功 → renew(sessionId) 被调（M4：只传 sessionId）；pingTick 失败 → 不调

---

### T5 — presence 推送 + session.setActive RPC（spec §3.4）

**文件**：
- `packages/runtime/src/transport/connection-manager.ts`：
  - 新增 `activeSessions: Map<clientId, sessionId|null>` 字段（per-client 活跃 session 记录，**R1-M4 命名统一**）
  - `setActiveSession(clientId, sessionId|null)` 方法
  - 触发 presence 全量重推的三个点：onConnect（上线）、onDisconnect（下线）、setActiveSession（切换）
  - auth.ok payload 顺带带 presence 字段（首连省一次 round-trip）
- 新增 RPC handler `session.setActive { sessionId: string|null }`：
  - 路由到 connection-manager.setActiveSession(clientId, sessionId)
  - 触发 presence.update 广播
  - reply ack
- presence 列表构造函数：遍历 `clients: Map<clientId, ctx>` + `activeSession Map` + session lease 状态（isOperating = session.busyOwnerId === clientId）

**测试**：
- `transport/connection-manager.test.ts`（扩展）：连接上线/下线/setActive 触发 presence.update 全量推送；payload 含所有在线客户端
- `transport/session-message-handler.test.ts`（扩展）：session.setActive RPC 调用后 presence.update 广播

---

### T6 — 客户端消费（spec §四）

**文件**：
- `packages/renderer/src/stores/presence.ts`（新建）：
  ```ts
  interface PresenceConnection {
    clientId: string
    deviceName: string
    activeSessionId: string | null
    isOperating: boolean
  }
  export const usePresenceStore = defineStore('presence', () => {
    const connections = ref<PresenceConnection[]>([])
    return { connections }
  })
  ```
- `packages/renderer/src/composables/useConnection.ts`（routeInbound :78-144 已自动按 sessionId 分流，无需改路由）：
  - global 通道订阅 `presence.update` → 替换 presence store
  - auth.ok 处理时取 presence 字段 → 替换 presence store
- `packages/renderer/src/composables/features/useChat.ts:88-95`（send.rejected 消费升级）：
  - toast 文案改为「{busyOwnerDevice} 正在处理（剩余 {剩余秒数}s）」
  - 用 `leaseExpiresAt - Date.now()` 算剩余秒数（payload 新字段）
- `packages/renderer/src/stores/session.ts`（session.busy/idle 消费）：
  - session.busy → 该 session 标记 busyOwnerId/busyOwnerDevice
  - session.idle → 清除
  - 冷启动 config.sessions 段消费时也读 lease 字段（types.ts 已扩展）
- `packages/renderer/src/composables/features/useSidebar.ts`（session.setActive 调用时机）：
  - selectSession 时调 `sessionApi.setActive(sessionId)`
  - 切到非 session 视图（settings）调 `sessionApi.setActive(null)`
- `packages/renderer/src/components/sidebar/`（UI 显示，最小实现）：
  - sidebar 底部新增「在线设备」列表（图标 + deviceName + 占用指示器）
  - session 标题旁占用指示器（busyOwnerId≠自己时显示 deviceName）

**测试**：
- `stores/presence.test.ts`（新建）：presence.update 全量替换；auth.ok presence 字段消费
- `composables/features/useChat.test.ts`（扩展）：send.rejected payload 含 busyOwnerDevice 时 toast 文案含 deviceName（用户可见断言）
- 首屏冒烟（spec 测试计划「首屏渲染」模板）：mount sidebar，断言「在线设备」区域存在（即使为空）

---

### T7 — feature-map 同步 + verify 脚本

**文件**：
- `docs/feature-map/2026-07-26-remote.md`：
  - §九 P5 阶段描述更新：加 presence.update（从 P6 移过来）
  - §九 P6 阶段描述更新：移除 presence.update，只剩「并发保护扩展」
  - §十一索引追加 P5 spec/plan 链接
  - §十二.5「跨客户端消息顺序」标注：**【R2-M1 修正】fencing token 仍推迟（P5 D3，P5-P7 无消费方），未来真需要跨客户端因果序时再设计**
- `tools/verify-lease.cjs`（新建）：真 runtime 场景
  - 场景 1：A acquire → B 被 reject（断言 B 收到 send.rejected 含 busyOwnerId）→ A 断网 31s → reaper 释放（断言 session.idle 广播）→ B 再发成功
  - 场景 2：A acquire → 手动 abort → release 被 broadcast

---

## 依赖与顺序

```
T1（types/protocol）─→ T2（透传链）─→ T3（LeaseManager）─→ T4（dispatcher 改造）
                                          │
                                          └→ T5（presence）─→ T6（客户端消费）
T7（文档+verify）依赖 T1-T6 全部完成
```

T2 是地基，必须先做（T3/T4/T5 都依赖 ctx.getClientId/broadcastExcept）。
T3 与 T5 可并行（LeaseManager 不依赖 presence）。
T6 依赖 T1（types）+ T5（presence RPC）。

**【R2-m2 跨阶段契约】** `LeaseManager.getBusySession(clientId)`（T3）+ `connectionManager.getActiveSession(clientId)`（T5）是 **P7 resolver 的对外契约**——P7 D3 fallback 第二级依赖这两个方法。签名变更需同步 P7 spec §2.1/§2.3。

## DoD

0. **【R2-m4 前置 gate】** P0（Map<clientId, ConnectionCtx> + auth 门控）已实施——P5 的 clientId 透传链 + lease + presence 都建在 P0 握手地基上
1. vitest 全绿（runtime + renderer，新增 + 现有）
2. `tools/verify-lease.cjs` exit 0（两场景）
3. spec §七测试计划全覆盖（clientId 透传 / broker 定向 / lease acquire-renew-release / TTL 过期 / busy 拒绝定向 / presence 推送 / 续租挂 ping / turn-end 释放）
4. feature-map §九 P5/P6 描述更新（presence 从 P6 移到 P5）
5. `npm run lint` + pre-commit 全过
6. **客户端可见断言**（spec 测试视角规则 5）：toast 文案含 deviceName + 剩余秒数；sidebar 在线设备区域 DOM 存在；session 占用指示器 DOM 存在
