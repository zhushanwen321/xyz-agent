# D1+D5：Session 级消息分发单通道化 + MessageBus topic 三分类

> **一句话结论**：session 级消息目前「双写」——`MessageBus.publish`（按订阅定向）+ `broker.broadcast`（盲广播所有连接），每 token 事件被序列化 2 次、盲发全部客户端。定案：**MessageBus 成为 session 级消息唯一分发通道，删除盲广播的 session 级路径**；前置是把 6 类「只走盲广播」的消息接进 bus，并用 topic 三分类（state / stream / transient）决定每条消息的 seq/ring/快照语义。这是全 runtime 最大的常数倍放大点（每 token 省 50% 序列化 + 消除 O(clients) 盲发）。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的接口/数据模型/topic 分类表）。涉及运行时行为与数据流，准则 5/6/7 全适用。

---

## §1 背景目标

### SCQA

- **情境**：runtime 把 pi 引擎的事件流（每个 token 一条 `message.text_delta`、每个工具调用多条事件）翻译成 ServerMessage 推给渲染进程。渲染进程可能同时打开多个 session panel，靠 `payload.sessionId` 路由。
- **冲突**：ADR-0055 引入 MessageBus（per-session 订阅 + seq + ring buffer + state 快照）作为新分发通道，但为了平滑迁移保留了旧盲广播，形成「双写」过渡态。分析发现双写在每 token 热路径上放大 2 倍序列化 + 盲发所有连接；且 bus 的 ring 用 `Array.shift()` 做 O(n) 淘汰、把流式 delta 无差别塞进 ring。
- **问题**：**过渡态未收敛。** 每 token 事件 = 2 次 `JSON.stringify` + 2 轮客户端遍历；ring 满 1000 后每条消息 O(1000) 内存搬移；6 类 session 级消息（terminal.* 等）甚至还没接进 bus。收敛需要先回答「哪些消息该进 ring、哪些该直传、哪些该留快照」——即 topic 分类。
- **答案**：先定 D5（topic 三分类）再执行 D1（单通道收敛）。两者联动设计：terminal.data 这类高频流归 transient 类才能安全接进 bus 而不压垮 ring。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| MessageBus | `services/message-bus/message-bus.ts`：per-session 状态 = `seqCounter`（单调）+ `streamRing`（1000 条 FIFO）+ `stateSnapshot`（last-value Map）+ `subscribers`（Set<ws>）。`publish` 分配 seq → 入 ring → 更新快照 → 推给订阅者。 |
| 订阅 | renderer 调 `session.subscribe` RPC → 返回 ring 快照 + state 快照 + lastSeq；之后 live 消息带 seq 推送；renderer 按 seq 做 gap 检测（`core/coordination/route-inbound.ts`）。**订阅是 session 级幂等、切 session 不退订、dispose 才退**。 |
| 盲广播 | `transport/message-broker.ts` 的 `broadcast()`：遍历全部 ws 发送。当前 `session-service.ts:955-965` 的 send 回调对每条带 sessionId 的消息「publish + broadcast」双写。 |
| stateTypeKey | `message-bus.ts:40-48`：消息 type → state 快照 key 的映射，当前只有 4 个占位条目。 |

### 设计目标

1. **每 token 只序列化一次、只发给该 session 的订阅者**（消除 2× 序列化与盲发）。
2. **高频流不污染 ring**：delta / terminal 输出直传，不进 ring、不占 seq、不触发 O(n) 淘汰。
3. **断线重连不丢状态**：state 类消息的 last-value 快照覆盖重连 reconcile；stream 类消息按 seq 回放。
4. **不破坏既有行为**：session.exited / message.complete / subagents / workflowUpdate 对非活跃 session 的兜底仍生效（ROUTE_TABLE 无条件兜底语义）。

### In / Out scope

- **In**：topic 三分类表（D5）、6 类消息接 bus、删除盲广播的 session 级路径、ring 改 O(1)、stateTypeKey 补全、IMessageBroker 接口统一。
- **Out**：全局消息（无 sessionId 的 config.* / app.info / handoffComplete 等）仍走 broadcast，不在本设计范围；renderer 消费逻辑重构（只改订阅前提，不改分发语义）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

一个用户在 agent streaming 时：每个 token 都要经过「runtime 序列化两次（bus 一次、broadcast 一次）→ 发给所有连接（哪怕其他 panel 根本不关心这个 session）→ 前端按 sessionId 过滤丢弃」。在 4k token 回复中约 8000 帧（text + thinking delta）都这样。多 session 同时跑时 CPU 与网络开销成倍放大。用户感知：streaming 时 CPU 高、多 panel 时消息延迟。

### 2.2 根因：双写过渡态 + topic 语义缺失

1. **双写**（`session-service.ts:961-965`）：
```ts
const sid = (msg.payload as { sessionId?: string } | null)?.sessionId
if (sid) this.messageBus?.publish(sid, msg)   // 序列化 #1 + 定向
this.broker.broadcast(msg)                     // 序列化 #2 + 盲发全部连接
```
`message-dispatcher.ts` 另有 14 处同形双写（error/rejected/complete/bashResult 等）。ADR-0055 明确定义了退出条件（phase-2 待办），但无排期。

2. **6 类「只走盲广播、从未接 bus」的 session 级消息**（探明清单，删除盲广播后必丢）：
   - `terminal.data/alive/exit`（`terminal-service.ts:99-122`）——PTY 高频输出流，完全依赖盲广播；
   - `context.update` 的 turn-end 路径（`session-service.ts:693` 的 `applyContextUpdate` 只 broadcast）；
   - `plugin:viewUpdate/uiRequest`（plugin-service 只 broadcast；**payload 已在广播点注入 `sessionId: active?.id`**——`plugin-service.ts:151-157` 经 ActiveSessionResolver 求值注入，无活跃 session 时为 undefined，D1-1 按此分支接法）；
   - `extension.ui_timeout`（`extension-message-handler.ts:70` 只 broadcast）；
   - `session.exited`（`session-service.ts:216` 只 broadcast，但有 ROUTE_TABLE 无条件兜底，只要消息有源就安全）；
   - `session.handoffStarted`（前端已无消费方，可直接删除广播）。

3. **topic 语义缺失**：`stateTypeKey` 只有 4 个占位映射；ADR-0055 phase-2 记录了缺口（3b：`session.state_changed` 不在快照；3c：`session.workflows` 映射了 RPC reply 类型、无 publish 点、快照键永远空；3d：compactionSummary 非 state topic）。所有消息（含 delta）无差别占 seq + 入 ring，ring 满后每消息 `shift()` O(1000)。

4. **ring 数据结构**（`message-bus.ts:92-96`）：`streamRing.push()` + `while (len > capacity) shift()`——数组头部删除 O(n)。

### 2.3 renderer 依赖面（探明结论）

- renderer 已实现「session 进列表即全量订阅」（`useSessionStreamSync` 监听 sessionStore.list，added → `ensureStreamSubscription`），且**订阅持久**（切走不退订、dispose 才退、session 级幂等）——删除盲广播的 renderer 前提大体就绪。
- `routeInbound` 对**无 seq 消息不做 gap 检测、直接 dispatch**（`route-inbound.ts` / `seq-gap.ts:37-39`：`!state || !state.subscribed → pass`）——transient 类（不分配 seq）天然兼容，无需改 renderer。
- 跨 session 全局消费者（ExtensionHost / DialogRequestQueue）不随 session 切换退订，靠 renderer `route-inbound.ts` FALLBACK 的 **CROSS_SESSION_TYPES 白名单**（`route-inbound.ts:227-238`）在 dispatchSession 后额外 dispatchCrossSession：`extension:widget/widgetGui/status/notify`、`extension.ui_request`、`extension.ui_timeout`、`plugin:uiRequest`、`plugin:viewUpdate`。**该白名单是 renderer 侧、传输无关的路由机制**——单通道化后这些消息改经 bus 定向推送，只要目标 session 处于订阅态（「session 进 list 即全量订阅」覆盖），dispatchSession + dispatchCrossSession 照常触发，全局消费者语义不变；对未订阅 session 的覆盖分析归入 D1-3。
- 残余风险（探明清单 R6/R8）：未订阅 session 的 message.error/send.rejected、subagent 虚拟 session 的 stream_delta——依赖「全量订阅」覆盖，其中虚拟 session 订阅情况标注待验证。

### 2.4 物理数据流（现状）

```
pi 事件流 → EventAdapter/Interpreter → send(msg)
          ├─ messageBus.publish(sid, msg)  → stringify#1 → 发给订阅 sid 的 ws（若有）
          └─ broker.broadcast(msg)         → stringify#2 → 发给【所有】ws
                                                  ↓
                              renderer routeInbound → dispatchSession(sid) 分发
                              （未订阅 session 的消息靠盲广播才到得了）
```

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**streaming 场景**：用户发消息后，每个 token 的 `message.text_delta` 在 runtime 只序列化一次，只发给订阅了该 session 的 ws（通常 1 个）；其他 panel 连接完全不受打扰。断线重连时，renderer 重新 subscribe，拿到 4+ 类 state 快照 + ring 内 stream 消息回放，token 级 delta 不回放（transient，本就该丢）。

**terminal 场景**：用户跑 `npm install` 刷屏输出，每个 chunk 作为 transient 消息直传给订阅者，不进 ring、不占 seq；其他 session 的 ring 不受影响。

**多 session 场景**：后台 session 的 `message.complete`/`session.exited`/`session.subagents` 到达 renderer（订阅持久保证有源），ROUTE_TABLE 兜底 effect 照常触发提示音/侧栏状态。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：完全单通道（选）**：bus 成为 session 级唯一通道，删除盲广播 session 级路径 | ✅ 分发模型唯一、接口统一（ADR-0055 7d）；每 token 省 50% 序列化 | 中：6 类消息接 bus + 删 ~15 处双写点（send 回调 + dispatcher ×14）+ 接口收敛 + renderer 验证 | 中：依赖「6 类消息全部有源 + renderer 全量订阅」两前提，探明已大体就绪 | ✅ |
| B：保留 lifecycle 4 类（exited/complete/subagents/workflowUpdate）走全局广播，其余单通道 | ⚠️ 类型分裂、两套通道长期并存，新消息类型永远要问「走哪条」 | 中 | 低 | ❌ 若用它：§3.1 终态变成「大部分消息单通道 + 4 类特殊全局」，每加一种消息类型都要查一遍白名单 |
| C：双写状态共享一次序列化结果（publish 与 broadcast 复用同一字符串） | ❌ 双通道仍在，只是少一次 stringify；架构问题未解决 | 低 | 低 | ❌ 若用它：每 token 仍盲发所有连接，多 panel 放大依旧 |

**推荐 A**。理由：项目无真实用户，不需要渐进迁移窗口；ADR-0055 已把退出条件、缺口清单、接口统一（7d）都设计好了，直接执行退出是长期最优；B 的白名单心智负担会永久存在；C 只解决一半问题。

### 3.3 关键决策与权衡

**D5-1：topic 三分类表（本次设计的核心数据模型）**

| 类 | 语义 | seq | ring | state 快照 | 消息全集（session 级 push 型 ServerMessageType，含 D1-1 接 bus 的 6 类） |
|---|---|---|---|---|---|
| **state** | last-value 状态，新订阅者必须立即拿到当前值 | 分配 | 不入 | 写快照（同 key 覆盖） | session.commands、context.update、session.subagents、session.workflowUpdate、session.state_changed（补，修 3b） |
| **stream** | 可回放的消息型事件 | 分配 | 入（O(1) 环形） | 不写 | message.message_start、message.complete、message.tool_call_start/end、message.tool_call_update、message.error、message.status、send.rejected、message.bashStart/bashResult、message.compactionSummary、message.branchSummary、message.customStart、message.changeSetInvalidated、message.file_changes、message.auto_retry_start/end、message.queue_update、message.stream_error、session.compacting/compacted、session.exited、terminal.alive/exit/ack、plugin:uiRequest、extension.ui_request、extension.ui_timeout、extension:widget/widgetGui/status/notify/setEditorText |
| **transient** | 高频瞬时流，丢失可接受 | **不分配** | 不入 | 不写 | message.text_delta、message.thinking_delta、message.thinking_start/end、subagent.stream_delta、terminal.data（新接 bus 后归此类）、message.stream_warn、plugin:viewUpdate |

- **不参与分类（Out of scope，逐类已核实来源）**：
  - **RPC reply 型**走 `reply` 通道不经 publish/broadcast，无 seq/ring 语义：`*.result`、session.subscribe、session.history/fullHistory、session.created/deleted/deletedByCwd（session-message-handler.ts:110/195/212）、session.subagentHistory（:267）、session.agentCallHistory（:275）、session.agentCallFilePath（:279）、session.workflowActionDone（:283）、session.subagentActionDone（:287）、session.renamed（:385）、session.setProject（:392）、session.thinkingLevelSet（settings-message-handler.ts:381）、model.switched（:306）、project.loaded（project-message-handler.ts:26）。
  - **全局消息（payload 无 sessionId 字段）**仍走 `broker.broadcast`，不进 bus：config.*、app.info、plugin:statusBarUpdate、plugin:permissionRequest（payload 仅 `{pluginId, permissions}`，plugin-activator.ts:180）、plugin:statusChange/crashed/notification/messageDecoration/config/statusSetUpdate、extension.discovered/installCancelled/recommended/pendingRequests/error、config.extensions、session.forkNotice（payload 仅 src/newSessionId，session-message-handler.ts:116-120）、session.handoffComplete/handoffAborted（W5 显式无 sessionId 走 dispatchGlobal，handoff-service.ts:300-315）。**D1-2 只删「带 sessionId 的 broadcast」，这些广播全部保留。**
  - `session.handoffStarted`：D1-1 定案删除该广播（前端无消费方），不进分类表。
- 归类修正记录（相对初稿）：`plugin:viewUpdate` 从 stream 改归 transient——高频 UI 流，与 terminal.data 同判据（高频瞬时、丢失可接受、ExtensionHost 不靠 ring 回放重建状态）；`plugin:uiRequest` 保留 stream——对话框请求丢失会让插件等满 60s 超时走默认值，属可见退化，且频率低不构成 ring 压力。`extension:*` 全族归 stream：widget 是 per-widgetKey 行累积语义（event-adapter.ts:302-370），state 快照模型是「每 type 单 key last-value」，硬塞快照会丢非最新 widgetKey 的内容，重连回放需 ring 保序。
- 补录（W06-M1）：`extension:setEditorText` 补入 stream 类全集——event-adapter 译出的 session 级 push 型消息，实施时随 TOPIC_TABLE 落地（`message-bus.ts:96` `'extension:setEditorText': 'stream'`，归类与 `extension:*` 全族同判据）。

- 选择：transient 不分配 seq。被否：transient 分配 seq 但不入 ring——seq 语义是「gap 检测 + 回放序」，瞬态消息两者都不需要，分配只会让 renderer 基线推进逻辑复杂化。
- 证据：routeInbound 对无 seq 消息直接 dispatch（`seq-gap.ts:37-39` 兼容路径），无 seq 是安全的；`terminal.data` 若占 seq 会把 seq 计数器与 gap 检测混入 PTY 高频流。
- 实现约束：`publish` 增加 topic 判定（`topicOf(type)` 查表）；state 类写快照不写 ring；transient 类不分配 seq 直接推送；`subscribe` 的 `snapshot`/`lastSeq` 语义随之调整（lastSeq 只随 stream/state 类推进）。

**D5-2：stateTypeKey 补全与修正**。
- 补 `session.state_changed → state_changed`（修 ADR-0055 3b：重连后 Composer 工具条回 fallback 默认值的问题）。
- 修正 `session.workflows → workflows` 的映射错误（3c）：当前映射的是 RPC reply 类型，运行时无 publish 点、快照键永远空。选择：**改为映射 `session.workflowUpdate`**（有真实 publish 点的广播类型）；workflow 全量数据仍靠 RPC loadWorkflows 回流（ADR-0055 4a 现状，不在本设计范围改变）。
- 保留 compactionSummary 不进快照（3d：靠 JSONL 持久化兜底，符合规则 #7.5）。

**D5-3：streamRing 改 O(1) 环形缓冲**。
- 选择：定长数组 + head/tail 索引（覆盖写）或等价双端结构；`subscribe` 的 snapshot 按 seq 顺序导出。
- **gap 判定机制核实（初稿在此处写错，已修正）**：renderer 真正消费的 gap 不是 bus 内部 gauge，而是 handler 侧 `session.subscribe` 的 `fromSeq < snapshot[0].seq` 比较（`session-message-handler.ts:333-349`：`let gap = false`，`fromSeq !== undefined` 时取 `oldestSeq = snapshot[0]?.seq ?? 0`，`fromSeq < oldestSeq → gap = true`）。`message-bus.ts:146` 的 `seqCounter > streamRing.length` gauge 被 handler 用 `let gap = false` **覆盖丢弃，是死代码**——且 D5 的 transient 不分配 seq 后，该 gauge 的分子分母语义分裂（seqCounter 只计 stream/state，ring 只存 stream），任何 ≥1 条 state 消息都会使 `seqCounter > ring.length` 恒真，假 gap 必发。定案：**删除 bus 内该死 gauge**，gap 只由 handler 的「fromSeq < ring 最旧 seq」判定（基于 ring 拓扑，D5 下不受影响、语义正确）。实施 U1 以探针验证：对含 state 消息的 session 调 subscribe，断言 gap===false 且 snapshot 完整。
- 证据：transient 移除后 ring 只存 stream 类，容量压力大减，但 stream 类在高频 turn 下仍会满载，O(n) shift 每消息一次仍不可接受。
- 风险：`message-bus.test.ts` 已覆盖 FIFO/seq/快照语义，重构数据结构需同步更新 snapshot 导出。

**D1-1：6 类消息接 bus（删除盲广播的前置，逐类定案）**：

| 消息 | 归属 topic | 接法 |
|---|---|---|
| terminal.data / alive / exit | transient（data）/ stream（alive、exit） | terminal-service 注入 bus（或经 send 回调同款封装），data 直传、alive/exit 入 ring |
| context.update（turn-end 路径） | state | `applyContextUpdate` 补 publish（对齐 restore 路径 `fetchAndBroadcastContext` 的双写） |
| plugin:viewUpdate / uiRequest | viewUpdate=transient、uiRequest=stream（归类修正见 D5-1） | plugin-service 广播点补 publish：payload 已注入 `sessionId: active?.id`（`plugin-service.ts:151-157`）——**sid 为 string 时走 bus.publish(sid, msg) 且不再 broadcast；sid 为 undefined 时保持全局 broadcast**（无活跃 session 的弹窗仍须必达全部连接）。两者均在 CROSS_SESSION_TYPES，renderer 侧 dispatchCrossSession 不受传输方式影响 |
| extension.ui_timeout | stream | extension-message-handler 补 publish |
| session.exited | stream | session-service 补 publish（ROUTE_TABLE 无条件兜底仍生效） |
| session.handoffStarted | — | **删除该广播**（前端已无消费方，探明确认） |

**D1-2：删除 `broker.broadcast(msg)` 的 session 级路径**。
- 在 `session-service.ts` send 回调与 `message-dispatcher.ts` 14 处双写点中，删除 broadcast 调用，只留 publish；`broadcast()` 退化为纯全局消息通道。
- 接口统一（ADR-0055 7d）：`IMessageBroker` 与 MessageBus 收敛为同一「发布」抽象——SessionService / Dispatcher / HandoffService 只依赖 `publish`；broker 只服务无 sessionId 的全局消息。
- **删除广播的前置 DoR：type → 投递路径全集审计表**（本表即「全集已枚举」的证据，实施 U4 前逐行 ✅ 复核；任一 push 型 session 级消息不在本表 → 不删其 broadcast）：

| 投递路径（现状） | 覆盖的 type | 证据位置 | 单通道后 |
|---|---|---|---|
| send 回调双写（publish+broadcast，覆盖 pi 事件流转发的全部 session 级 push） | message.*（含 delta/complete/error/file_changes 等）、session.compacting/compacted、session.subagents、session.workflowUpdate、subagent.stream_delta、session.exited 等 | `session-service.ts:956-965`（send 回调）；`message-bus.ts` publish 实现 | 只留 publish |
| dispatcher 命令副作用双写 ×14 | send.rejected、message.error、message.complete、message.bashStart/bashResult 等命令编排消息 | `message-dispatcher.ts:101/115/143/165/173/193/208/239/259/275` 等 | 只留 publish |
| 6 类「只走盲广播」（D1-1 逐类接法） | terminal.data/alive/exit、context.update（turn-end）、plugin:viewUpdate/uiRequest、extension.ui_timeout、session.exited | `terminal-service.ts:99-122`、`session-service.ts:693`、`plugin-service.ts:151-157`、`extension-message-handler.ts:70`、`session-service.ts:216` | 补 publish（D1-1 表） |
| R-08 审计新增：只走盲广播（原清单外，实施期发现并追认） | message.changeSetInvalidated | `server.ts` setServices 的 gitMessageHandler ctx（broadcastChangeSetInvalidated，git.commit 触发） | 补 publish（stream 类：分配 seq + 入 ring）——W09 实施定案追认，见 plan.md R-08 |
| 只广播、且删除（非桥接） | session.handoffStarted | `handoff-service.ts:249-255` | 删除广播 |
| 全局广播（无 sessionId 字段，保留 broadcast） | config.*、app.info、plugin:statusBarUpdate/permissionRequest/statusChange/crashed/notification/messageDecoration/config/statusSetUpdate、extension.discovered/installCancelled/recommended/pendingRequests/error、config.extensions、session.forkNotice、session.handoffComplete/handoffAborted | 见 D5-1 排除清单各证据位置 | 保留 broadcast |
| RPC reply（不走 publish/broadcast，无改动） | `*.result`、session.subscribe/history/fullHistory/created/deleted/deletedByCwd/subagentHistory/agentCallHistory/agentCallFilePath/workflowActionDone/subagentActionDone/renamed/setProject/thinkingLevelSet、model.switched、project.loaded | 见 D5-1 排除清单各证据位置 | 无改动 |

  - renderer 侧前提：全量订阅 + 持久订阅（`useSessionStreamSync`，§2.3）已就绪；未订阅 session 的残余风险见 D1-3。

**D1-3：renderer 残余风险处理**。
- R6（未订阅 session 的 error/rejected）：「session 进 list 即订阅」已覆盖 list 内全部 session；「刚 create 未进 list」窗口的消息靠 ring 回放兜底（stream 类）。接受。
- R8（subagent 虚拟 session 订阅）：**待验证**——实施时确认 `subagent.stream_delta` 的消费路径是否在订阅覆盖内；若不在，将 `subagent.stream_delta` 的 publish 目标改为 `mainSessionId` 的订阅者集合（消息本身带 mainSessionId 字段）。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 大仓库中 agent 做多工具任务，同时开 2 个 panel | 观察 streaming 全程 + ws 层打点 | token 连续输出；**确定性断言：同一 session 级消息在 send/bus 层只被 `JSON.stringify` 一次、且只推给订阅该 sid 的连接（ws 层计数 = 1 序列化 / 1 订阅者，可直接复核）**；runtime CPU 较改造前显著下降作为辅助参考（受 GC/后台任务噪声影响，不作唯一标准）；每个 panel 只收到自己 session 的消息 | 目标 1 |
| V2 | 用户在 panel A 开着 terminal 跑 `npm install`，panel B 正在 streaming | 观察两个 panel | terminal 输出正常到达 A；B 的 streaming 不受影响；B 的 ring 未被 terminal 数据填充（通过 subscribe snapshot 长度验证） | 目标 2 |
| V3 | streaming 中断开 renderer WS，5 秒后重连 | 重连后观察对话流与状态 | 重连后：state 快照（commands/context/subagents/workflowUpdate/state_changed）立即恢复；stream 类消息按 seq 回放；delta 类不回放但后续 delta 正常继续；无重复消息（seq 去重生效） | 目标 3 |
| V4 | 后台 session 的 agent 跑完（当前用户正在看另一个 panel） | 观察提示音/侧栏状态 | message.complete 提示与 subagent 终态照常到达（ROUTE_TABLE 兜底 + 订阅持久生效） | 目标 4 |
| V5 | 删除一个 session | 观察侧栏与相关 panel | session.exited 兜底照常工作（标记 dead + toast）；handoffStarted 广播删除后无前端报错 | 目标 4 |

---

## §5 下一层拆分

实施路径：分两阶段（先 topic 分类，后删广播），每阶段可独立验证：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | topic 分类表 + publish 分流（state 写快照 / transient 免 seq 直传）+ O(1) ring | 分类是后续一切的前提，先落地且独立可测 | `message-bus.ts`（topicOf、publish 分流、环形缓冲、subscribe 导出）；`message-bus.test.ts`（同步更新） |
| U2 | stateTypeKey 补全/修正 | 重连 reconcile 完整性，独立小改动 | `message-bus.ts`（映射表） |
| U3 | 6 类消息接 bus（逐类） | 删除盲广播的安全前置，每类可单独提交 | `terminal-service.ts`、`session-service.ts`（applyContextUpdate/exited）、`plugin-service.ts`、`extension-message-handler.ts` |
| U4 | 删除双写 + 接口统一 | 收益主体 | `session-service.ts`（send 回调）、`message-dispatcher.ts`（14 处）、`interfaces.ts`/`message-broker.ts`（接口收敛）、`handoff-service.ts`（如涉） |
| U5 | renderer 订阅前提验证 + R8 验证 | 收尾风险项 | `useSessionStreamSync`、`subagent.ts`（如需调整 publish 目标） |

**待验证检查点**：
- subagent 虚拟 session 的订阅覆盖（U5）。
- transient 消息不占 seq 后，renderer 是否有任何逻辑隐式依赖「所有 push 都有 seq」（实施时 grep renderer 对 msg.seq 的消费点确认）。
- ring 改数据结构后 gap 判定的等价性（现有测试覆盖 + 新增溢出场景测试）。
