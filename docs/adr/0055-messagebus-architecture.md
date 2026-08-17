# ADR-0055: MessageBus 架构 — per-session ring buffer + subscribe/reconcile 消息分发

**状态**: Accepted
**日期**: 2026-07-29
**关联**: ADR-0049（per-session 状态隔离 Map 分区）、ADR-0046（RPC 类型配对 SSOT）、ADR-0043（消息内容 Segments）

## 背景

xyz-agent 的 runtime → renderer 消息分发原先是单一 `broker.broadcast(msg)` 盲广播：runtime 发出的每条 `ServerMessage` 广播给所有已连接的 WebSocket 客户端，renderer 端不区分 session，按 `msg.type` 全局分发。

该模式存在三个结构性问题：

1. **session 隔离缺失**：多 panel/split 模式下，session A 的流式消息广播到所有 panel，renderer 端用 `payload.sessionId` 做软路由。一旦某条消息遗漏了 `sessionId`（违反 AGENTS.md 规则 #7），会广播到所有 panel，污染其他 session 的对话流。

2. **无可靠投递保证**：WS 断连重连期间发出的消息直接丢失，无缓存、无补发、无检测机制。renderer 重连后只能靠主动 RPC（`getHistory`/`getCommands`/`getContext`）全量拉取兜底，每次 `selectSession` 触发 4+ 次 RPC，时序敏感且容易竞态。

3. **状态与事件混杂**：流式增量（`text_delta`，生命周期短、可丢弃）与状态快照（`session.commands`，生命周期长、需 last-value 保证）走同一通道无差别广播，无法实现"新订阅者立即获得当前状态"。

## 决策

引入 **MessageBus**（`packages/runtime/src/services/message-bus/`）作为 runtime 侧的 per-session 消息分发 SSOT，采用 **subscribe + reconcile** 模式：

### 核心架构

```
┌─ Runtime ────────────────────────────────────────────────────┐
│                                                               │
│  EventAdapter/EventInterpreter ──→ send callback ──┐          │
│  MessageDispatcher ──────────────────────────────┐  │          │
│  SessionService (broadcastSessionState 等) ──────┤  │          │
│                                                   ↓  ↓          │
│                                          messageBus.publish(sid, msg)
│                                                   │              │
│                              ┌────────────────────┘              │
│                              ↓                                    │
│                     ┌─ per-session state ──┐                     │
│                     │ seqCounter (单调)     │                     │
│                     │ streamRing (1000 FIFO)│                     │
│                     │ stateSnapshot (last)  │                     │
│                     │ subscribers (Set<ws>) │                     │
│                     └───────────┬───────────┘                     │
│                                 │                                 │
│             WS subscribe/unsubscribe RPC                         │
│                                 │                                 │
└─────────────────────────────────┼─────────────────────────────────┘
                                  │
┌─ Renderer ──────────────────────┼─────────────────────────────────┐
│                                 ↓                                  │
│              routeInbound (useConnection)                         │
│                    │                                              │
│         ┌──────────┴───────────┐                                  │
│         ↓                      ↓                                  │
│  dispatchSession(sid, msg)   dispatchGlobal(msg)                  │
│         │                      │                                  │
│    events.on(sid, ...)    events.onGlobal(...)                    │
│    (message.* handler)    (session.handoff* 等)                   │
└──────────────────────────────────────────────────────────────────┘
```

### id/seq 互斥设计

`ServerMessage` 有两个可选字段：`id?: string` 和 `seq?: number`。**同一条消息要么是 RPC reply（带 id），要么是 server-push live event（带 seq），互斥由 runtime 保证。**

- `id`：RPC 请求-应答配对标识。renderer `sendCommand` 生成唯一 id，runtime reply 时原样回填，renderer pending map 按 id resolve。
- `seq`：server-push 的 per-session 单调递增序号。MessageBus.publish 时分配，renderer `routeInbound` 据此做 gap 检测。

类型层（`ServerMessage` 接口）不强制 id/seq union，互斥是运行时契约。`routeInbound` 先判 `msg.id`（走 RPC reply resolve），再判 `msg.seq`（走 gap 检测 + dispatchSession）。

### subscribe + reconcile 模式

renderer 切换到某 session 时调 `session.subscribe` RPC：

1. **snapshot 回放**：MessageBus 返回该 session ring buffer 内当前事件序列（带 seq），renderer 逐条 `dispatchSession` 回放，让订阅端复现已发生事件。
2. **stateSnapshot 注入**：返回 4 个 state topic（`commands`/`context`/`subagents`/`workflows`）的 last-value，一次性把当前状态灌入 stores，替代旧的主动拉取 RPC。
3. **lastSeq 记录**：记下当前最大 seq 作为 gap 检测基线。
4. **live push 接收**：之后 runtime publish 的消息带 seq 推送，renderer 检测 `seq > lastSeenSeq + 1` 时触发 gap reconcile（回拉缺失段）。

### 双写过渡策略

迁移期间 `send` 回调同时走两条路径（`session-service.ts:911-928`）：

```typescript
const send = (msg: ServerMessage) => {
  const sid = (msg.payload as { sessionId?: string })?.sessionId
  if (sid) this.messageBus?.publish(sid, msg)  // 新路径：定向 session 订阅者
  this.broker.broadcast(msg)                    // 旧路径：盲广播兜底
}
```

**退出条件**（未实现，phase-2 待办）：所有 renderer 消费路径迁移到 subscribe 后，删除 `broker.broadcast` 的 session 级路径。判定标准：`routeInbound` 的 gap 检测对所有已 subscribe session 生效，且 `remove-bandaids` wave 完成后无 renderer 路径依赖盲广播。

## 架构审查发现的缺口

以下是基于 2026-07-28 三维审查（回归影响 / 设计对齐 / 架构完整性）发现的问题，按 phase 划分。

### phase-1 必修（阻塞交付，已修复）

| 编号 | 问题 | 严重性 | 修复 |
|------|------|--------|------|
| **C1** | `message-bus.ts` publish 不写 `message.seq`，seq/gap/去重/reconcile 整套机制空转 | 严重 | commit `fcfbacb7`：publish 后 `message.seq = state.seqCounter` |
| **A1** | `message-dispatcher.ts` 零 `bus.publish`，19 处 broker.broadcast 绕过 bus，session 级命令事件不进 ring | 高 | commit `2216f967`：注入 MessageBus，19 处补 publish |
| **M1** | `selectSession` 不调 `subscribeSession`，切会话后到首条消息前 commands/context 空白 | 高 | commit `0a127294`：selectSession 内调 subscribeSession |

### phase-2 可延后（已记录，未修复）

| 编号 | 问题 | 严重性 | 说明 |
|------|------|--------|------|
| **1b** | `session.exited` 不进 bus，重连后无法 reconcile session 已 dead | 中 | 兜底机制（routeInbound 无条件处理）当前可用 |
| **2a** | dual-write 退出策略无 issue / 无判定标准 / 无排期 | 中 | 需开 issue 记录退出条件 |
| **3b** | `session.state_changed` 不在 stateTypeKey，modelId/thinkingLevel/usagePercent 不进 stateSnapshot | 中 | 重连后 Composer 工具条回 fallback 默认值 |
| **3c** | `session.workflows`（state topic）运行时无 publish 点，stateSnapshot 的 workflows 键永远空 | 中 | stateTypeKey 映射了 RPC reply 类型而非广播类型（`session.workflowUpdate`） |
| **3d** | `message.compactionSummary` 非 state topic，ring 溢出后重连 reconcile 丢失 | 低 | 规则 #7.5 要求重开可见，当前靠 JSONL 持久化兜底 |
| **4a** | `getSubagents`/`getWorkflows` RPC 仍在调用，设计声称"删除 RPC 靠 stateSnapshot"不准确 | 中 | subagents/workflows 数据回流仍完全靠 RPC |
| **5a** | subscribe 失败对用户不可见（console.warn 后 UI 静默缺数据） | 中 | 需加可观测性 |
| **5b** | ring overflow（>1000）后旧消息被驱逐，`reply.gap` 被生成但 renderer 不消费 | 中 | gap=true 的消费逻辑需补 |
| **5c** | 长期活跃 session 的 ring 无 LRU 淘汰，内存持续增长 | 低 | 每 session 最多 1000 条 + stateSnapshot Map |
| **7c** | `useMessageBusSubscription` / `useSessionEvents` / `useChat.ensureStreamSubscription` 三模块都碰 `events.dispatchSession`，去重责任分散 | 低 | 技术债，remove-bandaids wave 统一治理 |
| **7d** | `IMessageBroker` 接口与 `MessageBus` API 不统一（broadcast vs publish），无法用同一抽象替换 | 中 | 退出 dual-write 时需统一接口 |
| **7e** | `HandoffService` 只注入 broker 不注入 bus，handoff 广播绕过 bus | 低 | handoff 相关广播是否需进 bus 待评估 |

## 与 AGENTS.md 规则的对齐

| 规则 | 对齐情况 |
|------|----------|
| #6 pi delayed flush | 无冲突 — MessageBus 纯内存，不读 session 文件 |
| #7 session 隔离 | bus per-session Map 隔离正确，依赖上游消息带 sessionId |
| #7.5 状态可重开恢复 | bus 纯内存重开后 stateSnapshot 空，持久化靠独立 JSONL 链路，不矛盾 |
| #7.6 per-session 状态隔离范式 | `useMessageBusSubscription` 用模块级 Map 符合 Map 分区派范式 |
| #16 禁止硬编码路径 | MessageBus 是纯协议层，无路径 |

## 关键文件

| 文件 | 职责 |
|------|------|
| `packages/runtime/src/services/message-bus/message-bus.ts` | 核心实现：per-session ring buffer + seq 分配 + subscribe |
| `packages/runtime/src/services/message-bus/types.ts` | 类型定义：SessionBusState、BusClient |
| `packages/runtime/src/services/session/session-service.ts:911-928` | send 回调双写（bus.publish + broker.broadcast） |
| `packages/runtime/src/transport/session-message-handler.ts` | subscribe/unsubscribe RPC handler |
| `packages/renderer/src/composables/useMessageBusSubscription.ts` | renderer 端订阅管理 + gap 检测 |
| `packages/renderer/src/composables/useConnection.ts` | routeInbound 统一入站分发 |
| `packages/shared/src/protocol.ts` | id/seq 互斥类型定义（line 1030-1041） |

## 设计标记说明

本 ADR 的"架构审查发现的缺口"章节内容来自 2026-07-28 三维审查报告，该审查由 reviewer subagent 对 PR #125（MessageBus 重构）执行。phase-1 必修项已在 `slice:fix-message-bus-seq`（3 个 wave）中修复。phase-2 项需后续 slice 处理。
