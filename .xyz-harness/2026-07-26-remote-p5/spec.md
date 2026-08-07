# 远程化 P5 设计：操作互斥升级（租约锁 + busyOwner 定向广播 + presence）

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§九 P5 阶段、§8.4 P1 协同改造、§4.2 备注） | **前置设计**: [P0](../2026-07-26-remote-p0/spec.md)（clientId 握手 + `Map<clientId, ConnectionCtx>` + auth 门）、[P2](../2026-07-26-remote-p2/spec.md)（seq + per-session ring buffer，本阶段不动）

> P5 范围（feature-map §九）：操作互斥升级——把现状 `message-dispatcher.ts:93-100` 的「无差别广播 send.rejected + isGenerating 布尔标志」升级为**带 TTL 的租约锁 + fencing token + busyOwner 定向广播 + presence.update**。feature-map 预估「runtime 中改 + 前端小改」。
>
> **代码核实后的关键发现**：
> 1. P0 spec D5 已设计 `Map<clientId, ConnectionCtx>` 握手地基，但**有意保留 `ConnectionCallbacks(ws)` 旧签名**——handler 仍按 ws 工作，clientId 仅存在 connection-manager 内部。P5 必须把 clientId 从 connection-manager 内部**透传到 handler ctx**，否则 busyOwner 定向广播无法实现。
> 2. 现状 `IMessageBroker` 只有 `send/broadcast/sendError` 三方法，**无定向/排除 API**。P5 必须给 broker 加 `sendToClient/broadcastExcept`。
> 3. 现状 `IManagedSessionView`（types.ts:26-85）只有 `isGenerating: boolean`，**无 busyOwnerId/leaseExpiresAt**。P5 是新增字段。
> 4. 现状 ADR-0035 ping loop（event-interpreter.ts，turn 内每 60s 一次 `get_state`）可作为 lease TTL 续租的挂载点。
> 5. **【审查 C2 修正】abort 现状是 `message.abort`**：grep `ClientMessageType`（protocol.ts:41）确认现有 `message.abort`（非 `session.abort`），message-dispatcher.ts abort() 路径在 :161-194。P5 复用 `message.abort`，**不新增** `session.abort`。
> 6. **【审查 C3 修正】ConnectionCallbacks 现状无 onDisconnect**：connection-manager.ts:30-34 只有 `onConnect/onMessage/sendError`，close 在 handleConnection 内联处理（:97-101）。P5 需**新增** onDisconnect 回调（不是签名扩展），供 presence 推送和 P6 terminal resize owner 清理订阅。
> 7. **【审查 C4 修正】send.rejected 现状是 broadcast**：message-dispatcher.ts:95-98 用 `broker.broadcast`。P5 改为 `ctx.reply` 只发发起方是**投递语义变更**（广播→点对点），需在 protocol.ts 注释更新。
> 8. **【审查 M1 修正】fence 推迟到真正消费方**：feature-map §4.2 说 fence 是为「跨客户端严格因果序」预留，但 P5-P7 都不做因果序（P5 明确不做）。P6 config CAS 用独立 version 字段（不用 fence）。**fence 在 P5-P7 无消费方，按 YAGNI 推迟**。P5 只做 lease（busyOwnerId + leaseExpiresAt），不引入 fence。未来真需要因果序时再设计 fence。
>
> 本 spec **不再回答 feature-map §十二.5「跨客户端消息顺序」的长期方案**——fencing token 推迟到真正需要它的阶段（未来多用户/严格因果序）。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 / 证据 |
|---|---|---|---|
| D1 | **clientId 透传** | P0 的 `ConnectionCallbacks(ws)` 签名扩展为 `(ws, clientId)`；handler ctx 新增 `getClientId()` / `getClient(clientId)` / `broadcastExcept(clientId, msg)` / `sendToClient(clientId, msg)` | P0 D5 保守不动 handler 签名是为降低 P0 风险（避免大面积签名级联）；P5 是第一个真正消费 clientId 的阶段，必须打通透传链。透传链涉及 6 层签名（见 §3.1），但每层都是机械加参数 |
| D2 | **lease 数据结构** | session 级别：`IManagedSessionView` 新增 `busyOwnerId?: string`（持有 lease 的 clientId）/ `leaseExpiresAt?: number`（unix ms，TTL 到期时间）。无 lease 时两字段 undefined | 字段可选，向后兼容现有消费方（不持 lease 的 session 视图与现状一致）。**审查 M1 修正：不引入 leaseFence**（fence 推迟到真正消费方） |
| D3 | **【审查 M1 删除】fencing token 推迟** | ~~fencing token~~ **不引入**。P5-P7 无任何 fence 消费方（P6 config CAS 用独立 version 字段，不用 fence）。按 YAGNI，fence 推迟到未来真正需要「跨客户端严格因果序」或「带版本校验的写入保护」时再设计 | feature-map §4.2 原文「seq 不能复用为 fencing token，P5 需独立设计」——审查发现这是「为可能的未来铺路」，但 P5-P7 都不做因果序，fence 建了无人用。推迟到真有消费方时再设计，避免引入无人使用的复杂度（单调计数器、字段、协议扩展、客户端持久化预期）。feature-map §十二.5 的长期方案标注「fence 推迟」 |
| D4 | **lease TTL 与续租** | **TTL = 90s**（`XYZ_AGENT_LEASE_TTL_MS`，default 90000）；**续租信号 = ADR-0035 ping loop 的 pingTick 成功路径**（turn 内每 60s 一次 `get_state`，成功 → `renew(sessionId)`，续 90s）；token delta / tool-call-start/end 这些更细粒度事件**不挂续租**（避免 event-interpreter 改动面过大） | **TTL 必须 > 2 × PING_INTERVAL_MS（60s）**：setInterval 首次回调在间隔后（非立即），首次续租最早在 turn-start+60s。若 TTL ≤ 60s，turn 开始后到首次 ping 之间 lease 会被 reaper 误释放。取 90s 余量：首次 ping（最晚 turn-start+60s）前 lease 不过期（90>60），且 ping 偶发失败一次后还有 30s 余量等下次 ping 补续（90-60=30）。原 30s 基于「崩溃检测窗口 = TTL = 30s」设想，忽略了 ping 首次回调在间隔后——30s<60s 必然导致正常 turn 内 lease 被 reaper 误释放（MAJOR bug，已修）。详见 §3.7。续租挂 ping 不挂 token delta：token delta 高频（每秒多次）会浪费 renew 调用；ping 60s 一次 + 90s TTL 已足够区分「正常 turn」与「客户端失联」 |
| D5 | **lease 获取语义** | **隐式 acquire**：客户端发 `message.send`（pi prompt），message-dispatcher 检查 `activeSession.busyOwnerId`：① 无 owner → 当前客户端自动 acquire lease（设 busyOwnerId/leaseExpiresAt）→ 继续 sendPrompt；② 有 owner 且 ≠ 当前 clientId → reject（D6）；③ 有 owner 且 = 当前 clientId（同客户端重复发，如 follow_up）→ renew 后继续 | 不引入显式 `lease.acquire` RPC——pi 操作是隐式互斥的自然时机，多一个 RPC 反而增加客户端复杂度。隐式 acquire 把 lease 与 sendPrompt 原子绑定，语义干净 |
| D6 | **busy 拒绝语义（投递语义变更）** | 客户端 B 发消息，session 已被 A 持有 → **只对 B 定向 reply** `send.rejected { sessionId, reason:'busy', busyOwnerId:A, busyOwnerDevice:'Mac', leaseExpiresAt:T }`；**同时广播** `session.busy { sessionId, clientId:A, deviceName:'Mac', expiresAt:T }` 给所有客户端 | **【审查 C4 修正】现状 send.rejected 是 `broker.broadcast`（message-dispatcher.ts:95-98），P5 改为 `ctx.reply` 只发发起方——这是投递语义变更（广播→点对点），需在 protocol.ts 注释更新**。send.rejected 扩展 busyOwnerId/busyOwnerDevice/leaseExpiresAt 让 B 的 UI 显示「Mac 正在占用，剩余 X 秒」。session.busy 是新增广播类型让其他客户端更新 presence UI。**send.rejected 用判别联合**：`reason==='busy'` 时必有 busyOwnerId/busyOwnerDevice/leaseExpiresAt（非全可选，避免类型歧义） |
| D7 | **lease 释放** | 四路径释放：① **turn-end 正常释放**（event-interpreter `agent_end` / `turn_end` → release，reason 'turn_end'）；② **TTL 超时自动释放**（reaper 定时器每 5s 扫描 `leaseExpiresAt < now` 的 session，release + 广播 `session.idle { sessionId, reason:'lease_expired' }`）；③ **abort 释放**（任一客户端发 `message.abort`，message-dispatcher abort 路径 :161-194 补 release，reason 'aborted'）；④ **【审查 M3 新增】sendPrompt 失败释放**（message-dispatcher :118-128 catch 块【R3-m3 行号修正】，补 `leaseManager.release(sessionId, 'send_failed')`，reason 'send_failed'）。**release 广播 `session.idle { sessionId, reason }`** | 四路径覆盖所有 lease 终结场景，含 acquire 后 sendPrompt 失败（M3 修复：避免失败后 lease 持有 30s 锁死 session）。reaper 5s 扫描间隔决定「TTL 过期后多久被清理」（最多 5s 延迟），可接受 |
| D8 | **【审查 M1 修正】fence 不引入** | ~~P5 仅落地 fence 字段 + acquire 时分配~~ **不引入 fence**（见 D3） | 审查发现 fence 无消费方，按 YAGNI 推迟。原 D8 的「P5 建 fence，P6 消费」假设不成立（P6 D4 config CAS 用独立 version） |
| D9 | **presence 协议** | 新增 `presence.update` 广播（连接上线/下线/切换 active session 时触发）：`{ type:'presence.update', payload:{ connections: Array<{clientId, deviceName, activeSessionId|null, isOperating}> } }`。**全量列表推送**（非增量 diff）——客户端本地 diff 渲染 | 全量推送简单可靠（连接规模 ≤10，单用户自托管）；增量 diff 在重连/补发场景复杂。客户端收全量直接替换 store，无合并逻辑 |
| D10 | **协议消息新增** | **【审查 C2 修正】ClientMessage 不新增 `session.abort`，复用现有 `message.abort`（protocol.ts:41）**；ServerMessage 新增：`session.busy` / `session.idle` / `presence.update`；`send.rejected` payload 扩展（判别联合，见 D6）；`auth.ok` payload 扩展 `presence` 全量列表（首次推送） | session.busy/idle 是 lease 状态广播；presence.update 是连接列表变化；send.rejected 扩展让被拒方拿到 owner 信息；auth.ok 顺带推 presence 省一次 round-trip |
| D11 | **【审查 C3 新增】onDisconnect 回调** | ConnectionCallbacks 接口**新增** `onDisconnect(ws: WsType, clientId: string): void`（现状 connection-manager.ts:30-34 无此回调，close 在 handleConnection :97-101 内联处理）。P5 抽出 close 处理为回调，供 presence 推送（D9 触发点 2）和 P6 terminal resize owner 清理订阅 | 现状 close 处理只清 clients Set + 心跳定时器。P5/P6 需要感知连接下线（presence 重推、terminal resize owner 释放）。**新增回调不是签名扩展**——是接口方法的新增。本地模式（clientId='local'）同样触发 |

**明确不在 P5**：
- ~~fence 的实际消费（→ P6）~~ **【审查 M1】fence 不引入**（D3），无消费方可言
- git/config/worktree/terminal 的并发锁（→ P6）：P5 只动 pi 操作互斥
- 插件 per-client active session（→ P7）：P5 的 presence 不涉及插件 API
- 移动端 push 通知（→ P12）
- 跨客户端严格因果序（feature-map §十二.5 提到的「长期方案」：**未来**真需要时再设计 fencing token；P5-P7 不做）

**对 P0 的依赖**：clientId 握手已落地（P0 D2/D5），`Map<clientId, ConnectionCtx>` 可用。P5 在此之上扩展透传。
**对 P2 的依赖**：本阶段不依赖 seq/ring buffer（lease 消息是实时广播，不需要回放——见 §6 取舍）。

---

## 二、协议变更

### 2.1 ClientMessage 新增

**【审查 C2 修正】不新增 session.abort，复用现有 `message.abort`（protocol.ts:41）**。message-dispatcher abort() 路径（:161-194）已存在，P5 只在该路径补 lease release（§3.3）。

**【R1-C3 修正】新增两个 RPC type**（登记入 `ClientMessageType`/`ClientMessageMap`/`ReplyPayloadMap`）：

```ts
// 客户端切 panel 时上报活跃 session（D9 presence 依赖）
| { type: 'session.setActive'; payload: { sessionId: string | null } }
// reply: session.setActive:result { ok: true }（ack）

// resume 路径主动拉 presence（§五 presence 全量重推）
| { type: 'presence.list'; payload: {} }
// reply: presence.list:result { connections: PresenceConnection[] }（同 presence.update.connections）
```

### 2.2 ServerMessage 新增/扩展

```ts
// 新增（无 fence 字段，审查 M1）
| { type: 'session.busy'; payload: {
    sessionId: string
    clientId: string        // 持有 lease 的 clientId（= busyOwnerId）
    deviceName: string
    expiresAt: number       // unix ms，lease TTL 到期时间
  }}
| { type: 'session.idle'; payload: {
    sessionId: string
    reason: 'turn_end' | 'lease_expired' | 'aborted' | 'send_failed'   // 审查 M3 加 send_failed
  }}
| { type: 'presence.update'; payload: {
    connections: Array<{
      clientId: string
      deviceName: string
      activeSessionId: string | null
      isOperating: boolean  // 持有某 session 的 lease
    }>
  }}

// send.rejected 扩展（审查 C4：判别联合，非全可选）
| { type: 'send.rejected'; payload: {
    sessionId: string
    message: string
    // 审查 C4 + R1-m2：判别联合只保留 busy 分支（不预留 'other' 空分支，未来扩展再加字面量强制两端同步）
  } & { reason: 'busy'; busyOwnerId: string; busyOwnerDevice: string; leaseExpiresAt: number } }

// 扩展 auth.ok（顺带推 presence 全量）
// 【R1-M2 修正】完整累积结构（继承 P2 §2.2 全部字段 + P5 新增 presence）
| { type: 'auth.ok'; payload: {
    serverVersion: string
    clientId: string
    // P2 字段（继承，非 P5 新增）
    bootId: string
    serverSeq: number
    resumed: boolean
    replayedCount?: number
    seqReset?: boolean
    // P5 新增
    presence?: PresenceConnection[]  // 同 presence.update.connections
  }}
```

**【R1-M2】auth.ok 字段累积说明**：P5 在 P2 auth.ok（含 bootId/serverSeq/resumed/seqReset/replayedCount）基础上追加 presence 字段。实施时 runtime 构造 auth.ok 必须同时填 P2 字段（否则 P2 回放逻辑失效：客户端拿不到 serverSeq 基线、bootId 无法比对）。

**【R1-M3】send.rejected 投递语义变更注释**：现状 protocol.ts:500-503 注释「runtime 预检拦截 busy 时发送」未标注投递方式。P5 改为 reply（发起方专属），protocol.ts 注释需更新为「**reply 型，发起方专属，不广播**（P5 C4 从 broadcast 改为 ctx.reply）；其他客户端的 busy 感知由新增的 session.busy 广播承担」。

**【审查 C4】send.rejected 投递语义变更**：现状 message-dispatcher.ts:95-98 用 `broker.broadcast`（无差别广播）。P5 改为 `ctx.reply` 只发发起方——**这是广播→点对点的投递语义变更**，需在 protocol.ts 注释更新（send.rejected 不再是广播，是发起方专属 reply）。其他客户端的「busy 感知」由新增的 `session.busy` 广播承担。

### 2.3 IManagedSessionView + SessionSummary 扩展（无 leaseFence，R1-C2）

```ts
// packages/runtime/src/services/session/types.ts:26-85
interface IManagedSessionView {
  // ... 现有字段 ...
  isGenerating: boolean
  isCompacting: boolean
  // P5 新增（审查 M1：无 leaseFence）
  busyOwnerId?: string       // 持有 lease 的 clientId；无 lease 时 undefined
  leaseExpiresAt?: number    // unix ms；无 lease 时 undefined
}

// 【R1-C2 修正】SessionSummary（packages/shared/src/session.ts）同步加字段
// toSummary 返回 SessionSummary，若不同步加字段，冷启动 config.sessions 段带不上 lease 状态
interface SessionSummary {
  // ... 现有字段（isBareWorkspace? 透传范式）...
  busyOwnerId?: string
  leaseExpiresAt?: number
}
```

**【R1-C2】SessionSummary 同步是 P5 plan T1 必做项**：`sessionService.toSummary()` 返回 SessionSummary，P5 让它带上 busyOwnerId/leaseExpiresAt，但 SessionSummary 类型本身不加字段则 tsc 报错或字段被丢弃。与现有 `isBareWorkspace?` 的透传范式一致（IManagedSessionView → SessionSummary 透传）。

---

## 三、实现

### 3.1 clientId 透传链（6 层签名扩展 + onDisconnect 新增 + ALS 注入）

P0 D5 保守保留 `ConnectionCallbacks(ws)` 签名。P5 扩展为 `(ws, clientId)`，链路：

| 层 | 文件 | 改动 |
|---|---|---|
| 1. ConnectionCallbacks | `connection-manager.ts:30-34` | **onConnect/onMessage 签名扩展**为 `(ws, clientId)`；**onDisconnect 新增**（审查 C3：现状无此回调，close 在 :97-101 内联，P5 抽出为回调 `onDisconnect(ws, clientId)`） |
| 2. handleConnection 内部 | `connection-manager.ts:97-101` | close 处理改为调 `callbacks.onDisconnect(ws, clientId)`（ clientId 从 `clients` Map 反查）；onConnect/onMessage 触发处从 `clients.get(clientId)` 取 ctx 传 clientId |
| 3. RuntimeServer 路由 | `server.ts:75,83` | 路由表 `Map<ClientMessageType, (msg, ws, clientId) => Promise>`；`handleMessage(msg, ws, clientId)`；**【审查 P7 D6 反向需求】handleMessage 入口加 `sessionContext.run({ clientId }, () => ...)` 包裹**（ALS 注入，供 P7 plugin RPC 取 clientId） |
| 4. 各 handler 入口 | `session-message-handler.ts:12-19` 等 6 个 handler | ctx 构造时传 clientId；handle 方法签名加 clientId |
| 5. MessageHandlerContext | `message-context.ts:24-43` | 新增 `getClientId(): string` / `getClient(clientId): WsType \| undefined` / `broadcastExcept(clientId, msg): void` / `sendToClient(clientId, msg): void` |
| 6. IMessageBroker | `interfaces.ts:54-59` + 实现 `message-broker.ts` | 新增 `sendToClient(clientId, msg)` / `broadcastExcept(excludeClientId, msg)`；遍历 `clients: Map<clientId, ConnectionCtx>` 取 ctx.ws 发送 |

**ALS 基础设施**（审查 P7 §2.0 提出需求，本层落地）：新建 `packages/runtime/src/infra/async-context.ts`，`export const sessionContext = new AsyncLocalStorage<{ clientId?: string }>()`。server.ts handleMessage 用 `sessionContext.run({ clientId }, () => this.handleMessage(...))` 包裹。P7 plugin RPC handler 通过 `sessionContext.getStore()?.clientId` 取 clientId（P7 不改 server.ts，复用 P5 注入的 ALS）。

**本地模式兼容**（P0 D5 `clientId='local'`）：本地 Electron 连接走旧路径自动认证，clientId 固定为 `'local'`。透传链对本地模式透明——单连接、broadcastExcept('local', msg) 在单连接场景等价 broadcast（无其他客户端可排除）。ALS 同样注入 clientId='local'。

### 3.2 lease 状态机（无 fence，审查 M1）

新增 `packages/runtime/src/services/session/lease-manager.ts`：

```ts
class LeaseManager {
  private readonly ttlMs: number  // D4 90000（TTL > 2 × PING_INTERVAL_MS，见 §3.7）

  acquire(sessionId: string, clientId: string, deviceName: string): Lease {
    const session = sessionService.getSession(sessionId)
    if (session.busyOwnerId && session.busyOwnerId !== clientId) {
      return { kind: 'busy', owner: session.busyOwnerId, expiresAt: session.leaseExpiresAt! }
    }
    // 同 owner 或无 owner → acquire/renew
    const expiresAt = Date.now() + this.ttlMs
    sessionService.updateSession(sessionId, { busyOwnerId: clientId, leaseExpiresAt: expiresAt })
    return { kind: 'acquired', expiresAt }
  }

  renew(sessionId: string): boolean {
    // 【审查 M4 修正】renew 的 clientId 来源 = session.busyOwnerId（不是外部传入）
    // event-interpreter pingTick 调用 renew 时只知 sessionId，不知 clientId，从 session 反查
    const session = sessionService.getSession(sessionId)
    if (!session.busyOwnerId) return false   // 无 owner 不续（防 undefined !== undefined 误续）
    sessionService.updateSession(sessionId, { leaseExpiresAt: Date.now() + this.ttlMs })
    return true
  }

  release(sessionId: string, reason: 'turn_end' | 'lease_expired' | 'aborted' | 'send_failed'): void {
    sessionService.updateSession(sessionId, { busyOwnerId: undefined, leaseExpiresAt: undefined })
    broker.broadcast({ type: 'session.idle', payload: { sessionId, reason } })
  }

  // reaper 每 5s 调用（D7 ②）
  sweepExpired(): string[] {
    const now = Date.now()
    const expired: string[] = []
    for (const [sid, session] of sessionService.allSessions()) {
      if (session.leaseExpiresAt && session.leaseExpiresAt < now) {
        this.release(sid, 'lease_expired')
        expired.push(sid)
      }
    }
    return expired
  }

  // P7 用（D3 fallback 第二级）
  getBusySession(clientId: string): { sessionId: string } | undefined {
    for (const [sid, session] of sessionService.allSessions()) {
      if (session.busyOwnerId === clientId) return { sessionId: sid }
    }
    return undefined
  }
}
```

**【审查 M4 修正】renew 签名简化**：原 `renew(sessionId, clientId)` 改为 `renew(sessionId)`，clientId 从 `session.busyOwnerId` 反查（event-interpreter 只知 sessionId）。null 检查：busyOwnerId 为空时 return false（防 undefined !== undefined 误续空 lease）。

**reaper 启动**：runtime 组合根（`index.ts`）`setInterval(() => leaseManager.sweepExpired(), 5000)`，进程退出时 clear。

### 3.3 message-dispatcher 改造

现状（`message-dispatcher.ts:91-100`）：无差别 broadcast send.rejected。

P5 目标：

```ts
// P5：lease 检查 + 定向 reject（审查 C4：reply 而非 broadcast）+ busy 广播
const lease = leaseManager.acquire(sessionId, clientId, deviceName)
if (lease.kind === 'busy') {
  // D6：只对发起方 reply send.rejected（审查 C4：投递语义从 broadcast 变 reply）
  ctx.reply(msg.id, 'send.rejected', {
    sessionId, reason: 'busy', message: `${lease.owner === clientId ? '本设备' : '其他设备'}正在处理`,
    busyOwnerId: lease.owner, busyOwnerDevice: ..., leaseExpiresAt: lease.expiresAt,
  })
  // D6：广播 session.busy 让其他客户端更新 presence UI。
  // **【文档修正】用 broker.broadcast（非 broadcastExcept）**：session.busy 是 session 级可靠消息，
  // 入 P2 ring buffer 桶（断线重连回放覆盖，§五）。发起方同时收到 send.rejected（reply）+
  // session.busy（broadcast）冗余但无害（前端两路各自消费，无重复副作用）。dispatcher 实现已有注释。
  this.broker.broadcast({ type: 'session.busy', payload: { sessionId, clientId: lease.owner, deviceName: ..., expiresAt: lease.expiresAt } })
  return { blocked: true, rejected: true }
}
// lease acquired/renewed → 继续 sendPrompt
// ... 现有 sendPrompt 逻辑 ...
```

**【审查 M3 新增】sendPrompt 失败释放 lease**：message-dispatcher :118-128 的 `client.prompt()` catch 块现状只复位 isGenerating + 广播 message.error。P5 补 `leaseManager.release(sessionId, 'send_failed')`——避免 acquire 后 sendPrompt 失败导致 lease 持有 30s 锁死 session：

```ts
try {
  await client.prompt(promptText)
} catch (e) {
  if (activeSession) activeSession.isGenerating = false
  leaseManager.release(sessionId, 'send_failed')   // 【M3 新增】失败立即释放 lease
  this.broker.broadcast({ type: 'message.error', payload: { sessionId, message: errMsg } })
  return { blocked: true }
}
```

**turn-end 释放（R3-m2 行号修正）**：现状 isGenerating 复位不在 event-interpreter，而在 `index.ts:188 onTurnFinalize → sessionService.handleTurnEndSideEffects`（event-interpreter 的 `handleAgentEnd` :377 只是 stopPingLoop）。P5 在 onTurnFinalize 回调路径补 `leaseManager.release(sessionId, 'turn_end')`。

**续租挂载（审查 M4 修正）**：`event-interpreter.ts` 的 `pingTick`（:561-637，60s 一次 `get_state`）成功路径补 `leaseManager.renew(sessionId)`——**renew 只传 sessionId**，内部从 session.busyOwnerId 反查 owner（M4：原 spec 说「clientId 从 session 上下文取」表述不清，实际 event-interpreter 不持有 clientId 上下文，renew 内部反查）。

**abort 释放**：现状 `message.abort` 路径（message-dispatcher.ts:161-194，审查 C2 确认是 message.abort 非 session.abort）补 `leaseManager.release(sessionId, 'aborted')`。

### 3.4 presence 推送

触发点（全量重推 `presence.update`）：
1. **连接上线**（auth.ok 后）：`onConnect(ws, clientId)` 内构造 presence 列表广播
2. **连接下线**（`onDisconnect`）：同上
3. **active session 切换**：客户端发新增 RPC `session.setActive { sessionId|null }` → runtime 更新 `activeSessions: Map<clientId, sessionId>` → 重推 presence
4. **lease 状态变化**（acquire/release）：重推 presence（isOperating 字段变化）

**【R1-M4 命名统一】** `activeSessions: Map<clientId, sessionId | null>`（connection-manager 字段名，复数；feature-map §4.1、P5、P7、P7 §2.3 四方统一用此命名）。方法 `getActiveSession(clientId): sessionId | undefined | null`（P7 resolver 用）。value 类型 `sessionId: string | null`（null = 客户端在看非 session 视图）。

`session.setActive` 是新 RPC（§2.1 已登记，plan T5），客户端切 panel 时调。

**auth.ok 顺带推**：D10 已定，auth.ok payload 加 presence 字段（§2.2 R1-M2 累积结构），省首次 round-trip。

### 3.5 【R4-M3】acquire 与 isGenerating 的协同 guard

**问题**（审查 R4-M3）：P5 D5 的 acquire 只检查 `busyOwnerId`，不检查 `isGenerating`。结合 P3（pi 断线后继续跑、isGenerating 保持 true）出现边界场景：A 持 lease、pi 卡死（180s 内无 ping）→ lease TTL 30s 过期 → reaper 释放 lease（busyOwnerId=undefined）但 isGenerating 仍 true（pi 未 abort）→ B 发消息 → acquire 见无 owner 成功 → 向仍在跑的 session 再发 prompt（双重驱动）。

**决策**：acquire 前置条件**同时检查 busyOwnerId 与 isGenerating**——任一为 true 即拒绝（返回 busy）：

```ts
acquire(sessionId, clientId, deviceName): Lease {
  const session = sessionService.getSession(sessionId)
  // 【R4-M3】busyOwnerId 或 isGenerating 任一为 true 且 owner≠当前 clientId → 拒绝
  const occupied = session.busyOwnerId || session.isGenerating
  if (occupied && session.busyOwnerId !== clientId) {
    return { kind: 'busy', owner: session.busyOwnerId ?? '<orphan-pi>', expiresAt: session.leaseExpiresAt ?? 0 }
  }
  // ... acquire/renew 逻辑 ...
}
```

**`<orphan-pi>` 语义**：isGenerating=true 但 busyOwnerId=undefined（lease 过期但 pi 未 abort）时，返回 owner='<orphan-pi>'，前端显示「Agent 正在处理（无主）」而非「{device} 正在处理」。这是 P3 pi-解耦的边界场景（pi 卡死后 lease 过期），客户端收到 busy 拒绝知道 session 仍被占用。

**lease 过期释放不复位 isGenerating**：reaper 只清 busyOwnerId/leaseExpiresAt，不动 isGenerating（isGenerating 由 pi turn-end/abort 路径复位）。两者独立，acquire guard 同时检查。

### 3.6 【R4-M4】runtime 重启后的 lease/presence 语义

runtime 重启后所有内存态归零（lease、presence、activeSessions Map）。客户端经 P2 bootId 不匹配 → seqReset → location.reload() 冷启动，重新 initial state（lease 字段全空）。

**具体**：
- **lease**：重启后所有 session 的 busyOwnerId/leaseExpiresAt = undefined（内存态）。客户端 reload 后 config.sessions 段显示无 lease。若 pi 在 restart 前正在跑（isGenerating=true），重启后 session 经 restoreSession 恢复（P3 D4），但 isGenerating 复位为 false（pi 进程重建，无 in-flight turn）——客户端看到 session idle。
- **presence**：重启后 activeSessions Map 空，客户端 reload 后重新 auth.ok 带 presence（只有自己），其他设备需各自重连。
- **不补救「重启前正在跑的 session」**：P3 D4 已决（懒恢复，用户点开才 restore），不自动恢复 in-flight turn。lease 随之不恢复。

### 3.7 【R4-m5】审批挂起期间 lease 不过期（交叉声明）

P3 D2（审批无限期挂起）+ P5 D4（lease TTL 90s + ping 续租）表面看冲突，但实际兼容：pi 等审批时 ping loop 持续（P3 D6 确认 ping 在审批挂起时穿透）→ leaseManager.renew 持续被调 → lease 持续续租 → 不会因审批等待过期。**此处显式声明此边界保证**（P3/P5 分散的事实集中说明）。
>
> **TTL 与 ping 间隔的约束（MAJOR 修复）**：TTL 必须 > 2 × PING_INTERVAL_MS（60s）。setInterval 首次回调在间隔后，首次续租最早在 turn-start+60s。若 TTL ≤ 60s，turn 开始到首次 ping 之间 lease 会被 reaper 误释放。90s TTL 满足约束（90>60）且留 30s 失败余量。原 30s 违反此约束（30<60），正常 turn 内 lease 必掉，已修为 90s（见 D4）。

### 3.5 【审查 M1 删除】客户端 fence 持久化

~~客户端崩溃恢复后用旧 fence 发起的写要被拒……~~ **fence 推迟到真正消费方（D3），P5 不引入 fence，客户端无需持久化任何 fence**。

---

## 四、客户端改动（小改）

### 4.1 send.rejected 消费升级

现状（`useChat.ts:88-95`）：toast "Agent 正在处理"。

P5：toast 文案升级为「{deviceName} 正在处理（剩余 X 秒）」——payload（判别联合 reason==='busy' 分支）带 busyOwnerDevice/leaseExpiresAt，前端 `leaseExpiresAt - Date.now()` 算剩余秒数。**审查 C4**：消费方需用判别联合收窄（`if (payload.reason === 'busy') { ... payload.busyOwnerDevice ... }`），TypeScript 自动收窄字段。

### 4.2 新增 presence store

```ts
// packages/renderer/src/stores/presence.ts（新增）
interface PresenceState {
  connections: Array<{
    clientId: string
    deviceName: string
    activeSessionId: string | null
    isOperating: boolean
  }>
}
```

订阅 `presence.update`（global 通道，无 sessionId）+ auth.ok 的 presence 字段 → 全量替换 store。

**UI 显示**：sidebar 底部「在线设备」列表（小图标 + 设备名 + 占用指示器）。最小实现：图标 + deviceName 文本，点击无操作（P5 不做"点击切换到对方的 active session"，留给未来）。

### 4.3 session.busy / session.idle 消费

- `session.busy`：session store 标记该 session 为 busy（`busyOwnerId/busyOwnerDevice`），UI 在 session 标题旁显示占用指示器（小图标 + deviceName）
- `session.idle`：清除占用指示器

**冷启动时序**（initial state 补齐）：P0 sendInitialState 的 `config.sessions` 段（`session-service.ts:715` toSummary）已含 `isGenerating`——P5 让 toSummary 也带上 `busyOwnerId/leaseExpiresAt`（**无 leaseFence**），冷启动时 session 列表自带 lease 状态。

### 4.4 session.setActive 调用时机

客户端切 panel（用户点 sidebar 的 session）时调 `session.setActive { sessionId }`；切到非 session 视图（如 settings）调 `session.setActive { sessionId: null }`。

---

## 五、与 P2 seq 的关系（重要取舍）

lease 相关消息（`session.busy`/`session.idle`/`presence.update`）**打 seq 入 ring buffer**（与所有广播一致），但：

- **session.busy/session.idle 是 session 级**（带 sessionId）→ 入对应 session 桶，resume 路径回放
- **presence.update 是全局消息**（无 sessionId）→ 不入桶，resume 路径**会丢**（P2 D2.2 已承认全局消息在 resume 路径丢失）

**取舍**：presence.update 丢失可接受——presence 是瞬态状态（谁在线、谁在操作），断线 10 分钟后旧的 presence 已无意义（设备可能已离线）。客户端重连后：
- auth.ok 顺带推 presence（D10）→ 冷启动路径有
- resume 路径（短断线，无 auth.ok）→ 主动调 `presence.list` RPC（新增，plan T5）拉一次

**lease 消息（busy/idle）必须可靠**：session 级消息，入 session 桶，P2 回放覆盖。客户端重连后 session 视图的 busy 状态完整。

---

## 六、与 feature-map §8.4 P1 原文的对照

| feature-map §8.4 P1 原文要求 | 本设计落点 |
|---|---|
| 升级为带 TTL 的租约锁 | D4 TTL=90s（TTL > 2×ping 间隔，见 §3.7）+ D7 reaper 5s 扫描 |
| ~~fencing token~~ | **【审查 M1】推迟到真正消费方，P5 不引入 fence** |
| `session.lease = { owner, fence, ttl, renewedAt }` | D2 IManagedSessionView 字段（`busyOwnerId/leaseExpiresAt`，**无 leaseFence**） |
| 广播 `session.busy { sessionId, clientId, deviceName }` | D6 + 二.2 协议（**无 fence 字段**） |
| 心跳续租 | D4 挂 ADR-0035 ping loop（renew 签名 M4 修正：只传 sessionId） |
| 租约 TTL 到期自动释放 + 广播 session.idle | D7 ② + reaper（**加 send_failed reason，M3 修正**） |
| send.rejected 只回 B（reply） | D6 ctx.reply 只对发起方（**审查 C4：投递语义从 broadcast 变 reply，protocol 注释更新**） |
| session 状态增加 busyOwnerId/leaseExpiresAt | D2 + 二.3（**无 leaseFence**） |
| presence（在 P6 原文，本 spec 提前到 P5） | D9 + 三.4 |

**与 feature-map 的偏离**：
1. **fence 推迟**（审查 M1）：feature-map §4.2/§8.4 P1 提到 fence，但 P5-P7 无消费方，推迟到真有「跨客户端严格因果序」需求时。feature-map §4.2/§十二.5 的 fence 描述标注「推迟」。
2. **presence 提前到 P5**：feature-map §九把 presence 放在 P6，本 spec 提前到 P5。理由：presence.update 的 `isOperating` 字段直接依赖 lease 状态（D9），P5 做 lease 时一并做 presence 更内聚。**plan T7 同步更新 feature-map §九/§8.4**（M2 修复：三方一致）。

---

## 七、测试计划

框架 vitest（`packages/runtime/`、`packages/renderer/`）。

| 测试 | 位置 | 要点 |
|---|---|---|
| clientId 透传 | connection-manager 测试扩展 | onConnect/onMessage/onDisconnect 回调收到 clientId；本地模式 clientId='local' |
| broker 定向 API | message-broker 测试扩展 | sendToClient/broadcastExcept 行为；排除自己/排除不存在的 clientId |
| lease acquire/renew/release | lease-manager 单测 | acquire 冲突返回 busy；renew 只传 sessionId（busyOwnerId 反查）；release 清 busyOwnerId/leaseExpiresAt |
| lease TTL 过期 | lease-manager 测试 + vi.useFakeTimers | advance 31s → sweepExpired 返回该 session；advance 29s → 不释放 |
| message-dispatcher busy 拒绝 | message-dispatcher 测试扩展 | A 持有 lease，B 发消息：B 收到 reply send.rejected（含 busyOwnerId）；所有客户端（含 B）收到 session.busy 广播（走 broker.broadcast 入 P2 桶可靠投递，§3.3）；A 不收到 send.rejected（send.rejected 是发起方 B 专属 reply，§2.2 R1-M3） |
| presence 推送 | connection-manager + presence 测试 | 连接上线/下线/切换 active 触发 presence.update 全量推送；auth.ok 含 presence 字段 |
| 续租挂 ping loop | event-interpreter 测试扩展 | mock pingTick 成功 → leaseManager.renew 被调；pingTick 失败 → 不续租（lease 自然过期） |
| turn-end 释放 | event-interpreter 测试扩展 | agent_end → leaseManager.release('turn_end') 被调 |
| 端到端 | `tools/verify-lease.cjs`（新建） | 真 runtime：A acquire → B 被 reject → A 断网 31s → reaper 释放 → B 再发成功 |
| 客户端 presence store | stores/presence.ts 测试 | presence.update 全量替换；auth.ok presence 字段消费 |
| 客户端 send.rejected UI | useChat 测试扩展 | toast 文案含 deviceName + 剩余秒数（用户可见断言） |

---

## 八、开放问题

1. **【审查 C2 已决】abort 复用 message.abort**：不新增 session.abort。复用现有 `message.abort`（protocol.ts:41），message-dispatcher abort 路径（:161-194）补 lease release。
2. **【审查 M3 已决】lease acquire 失败路径 release**：sendPrompt catch 块（message-dispatcher :118-128【R3-m3】）补 `leaseManager.release(sessionId, 'send_failed')`。lease 与 isGenerating 的关系：保持双字段独立——isGenerating 是 turn 进行态，busyOwnerId 是 lease 持有态。acquire 后 sendPrompt 失败时 isGenerating=false + lease 立即释放（M3 修复），不再出现「锁死 30s」场景。
3. **【审查 M4 已决】renew clientId 来源**：renew(sessionId) 只传 sessionId，内部从 session.busyOwnerId 反查。busyOwnerId 为空时 return false（防误续）。
4. **`session.setActive` RPC 必要性**：presence.update 的 activeSessionId 字段需要客户端主动上报。保留 session.setActive RPC（轻量，语义清晰）——替代方案「runtime 从 send.rejected 推断」只能知道正在操作的 session，不知道正在查看但未操作的 session。
5. **reaper 5s 间隔 vs TTL 90s 的延迟**：lease 过期后最多 5s 才被 reaper 清理。若 5s 内原 owner 重连，会发现自己的 lease 已被释放——崩溃检测窗口 = TTL（90s）+ 清理延迟 5s。原 owner 重连后重新 acquire 即可（D5 隐式 acquire）。TTL=90s 是为满足「TTL > 2×ping 间隔」约束（§3.7），非崩溃检测窗口本身——崩溃检测窗口随 TTL 变长，但 pi 卡死场景由 ADR-0035 ping 连续 3 次失败（180s）触发 abort 兜底，与 lease TTL 解耦。
6. **presence 全量推送的频率**：每次连接上下线/切 session/lease 变化都全量推。单用户自托管连接数 ≤10，全量 payload < 2KB，可接受。未来多用户再改增量 diff。
