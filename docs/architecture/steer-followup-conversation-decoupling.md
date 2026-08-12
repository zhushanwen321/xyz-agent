# steer/followup：对话流与队列关注点分离

> **一句话结论**：steer/followup 的 pending 状态不该作为消息塞进对话流（messages 数组），应归属到 composer 队列（QueueBubble）；drain（agent 投递）时才以普通 complete 消息进入对话流，使对话流回归"通用对话逻辑"——只认通知，不为触发源造组件。

## §1 背景目标

- **S（情境）**：xyz-agent 的对话流由 `messages` 数组驱动渲染（user 气泡 + assistant 消息 + 状态栏）；composer 在 agent streaming 期间支持两种"插话"——steer（追加当前回合）/ followUp（回合后开新轮）。
- **C（冲突）**：steer/followup 发送后，对话流里立即冒出一个**虚线框 pending 气泡**，与 composer 上方已有的 QueueBubble 队列**重复表达**同一件事（"已发出待投递"），且 V6 spec 已明确判该虚线框为废弃实现债。
- **Q（问题）**：如何让对话流保持纯净的"通用对话逻辑"（user 气泡 + assistant + 状态栏，与普通多轮对话完全一致），把 steer/followup 的 pending 归属到 queue，而非为 steer/followup 造一种特殊的对话流组件？
- **A（答案）**：对话流与队列彻底分离——steer/followup 发送时**不碰 messages 数组**，segments 暂存到 pendingBuffer；pi drain（投递）时才 `appendUser` 以 complete 消息进入对话流，紧接着 agent 新 turn streaming。对话流全程感知不到 steer/followup 的存在。

### 系统是什么

xyz-agent 前端对话流由三层协作渲染：

- **`packages/core`（领域层）**：`store.ts` 维护 `messages: Map<sessionId, Message[]>`；`message-turns.ts` 的 `groupTurns()` 把扁平 messages 分组成 `MessageTurn[]`（每个 user message 开一个新 turn，后续 assistant 归入同 turn）。
- **`packages/ui`（展示层）**：`Turn.vue` 编排单个 turn（`<UserBubble v-if="turn.user">` + assistant 区）；`UserBubble.vue` 渲染 user 气泡。
- **`packages/renderer`（壳层）**：`Composer.vue` 内嵌 `QueueBubble.vue`（composer-box 顶部，展示 pi 队列待投递项）。

steer/followup 的底层流转：前端发 RPC → pi 入队 → pi 推 `message.queue_update`（队列快照）→ pi drain（投递）→ pi 推 `message.queue_update`（出队）+ `message.start`（新 turn streaming）。

### 设计目标（从使用者体验倒推）

1. **G1 对话流纯净**：对话流里只有"已发生的对话"（complete user + assistant），不为 steer/followup 渲染特殊气泡。用户看到的 steer/followup 消息气泡与普通消息气泡完全一致。
2. **G2 队列归属清晰**：steer/followup 的"待投递"状态只由 QueueBubble 表达，对话流不参与。
3. **G3 状态栏自然**：状态栏跟随对话流的 turn 生命周期（streaming/done），queue 不干预它——steer/followup 在 queue 期间不改变状态栏，drain 触发新 turn 时自然切换。
4. **G4 富文本不降级**：steer/followup 消息的 @mention 高亮/附件等富文本与普通 send 一致。

### Scope

- **当前层**：架构方案设计（对话流与队列的关注点分离）。
- **下一层**：实现拆分（store/useChat/effects/ui/mock/tests 的具体改动）。
- **In-scope**：删除 pending message 机制，引入 pendingBuffer，drain 时 appendUser。
- **Out-of-scope**：QueueBubble 的视觉调整（已符合 V6 §8.5）；状态栏 9 态派生逻辑（不改，G3 自然满足）；pi 侧 drain 语义（不改 pi）。

---

## §2 现状与问题分析

**现状是：steer/followup 发送后，对话流里冒出一个虚线框气泡，它和 composer 顶部的 QueueBubble 在说同一件事。**

### 2.1 使用者视角的现状（真实例子）

用户在 agent streaming 期间按 `⏎`（steer）或 `Alt+⏎`（followUp）发送一条消息，例如"先处理这个：把 PanelHeader 的 border-b 去掉"。发送后用户同时看到：

1. **对话流底部**冒出一个虚线框气泡（steer=蓝色虚线+脉冲点+"STEER"标签；followUp=青色虚线+脉冲点+"FOLLOW-UP"标签），气泡里是消息文本。
2. **composer 输入框顶部**（QueueBubble）出现一行：⚡（Zap icon，蓝色）+ 截断的消息文本。

两个反馈在屏幕上同时存在，表达的是同一件事："这条消息已入 pi 队列，等 agent 投递"。

### 2.2 物理数据流（现状）

```
用户按 ⏎(steer)
  → Composer.vue onKeydown (line 363: isActive → onSteer)
  → useChat.steer(sid, segments)
       → store.appendPending(sid, segments, 'steer')     ← 【问题根源】RPC 前就往 messages 插 pending 消息
       → chatApi.steer(text)                              ← RPC 发出
  → messages: [..., { role:'user', status:'pending', sendMode:'steer' }]
  → groupTurns: 开新 turn { user: pendingMsg, assistants: [] }
  → Turn.vue: <UserBubble v-if="turn.user">
  → UserBubble.vue:178 isPendingUser (status==='pending') → 渲染 border-dashed 虚线框  ← 虚线框出现

  （并行）pi queue_update 入队
  → queueStates[sid] = { steering:[text] }
  → QueueBubble.vue: v-if="state && hasAny" → 显示 ⚡+text                              ← 队列也出现

  pi drain（投递）
  → queue_update 出队 → registry.ts:546 countDrained → markPendingDelivered
  → messages 里 pendingMsg.status = 'complete'                                          ← 虚线框变正常气泡
  → queueStates 移除 → QueueBubble 消失
  → message.start → assistant streaming 进入同 turn
```

### 2.3 根因分析

**根因不是"虚线框样式丑"，而是 `appendPending` 把两个关注点混进了同一个数据结构（messages 数组）。**

| 关注点 | 该归属的数据结构 | 现状归属 |
|---|---|---|
| 已发生的对话（user 问 + assistant 答） | `messages`（对话流） | `messages` ✓ |
| 待投递的排队输入（steer/followup 未被 agent 处理） | `queueStates`（队列） | **也塞进 `messages`（status:'pending'）** ✗ |

`store.appendPending`（store.ts:257）在 RPC **之前**就把 steer/followup 当 `status:'pending'` 消息插入 messages 数组。后果沿渲染链路放大：

- `groupTurns` 给这条 pending 消息开一个新 turn（`{ user: pendingMsg, assistants: [] }`）。
- `Turn.vue` 的 `<UserBubble v-if="turn.user">` 渲染它。
- `UserBubble.vue` 被迫加 `isPendingUser` 特判分支（line 26-35），渲染 `border-dashed` 虚线框 + sendMode 配色 + 脉冲点 + 标签。

这条 pending message 是 steer/followup **为对话流专门造的组件态**——正是"对话逻辑感知到触发源、为它造了对应组件"。它违反了对话流应是"通用对话逻辑"的原则：对话流只该认"通知"（appendUser 了一条 complete 消息 / assistant 开始 streaming），不该知道消息来自 steer 还是 followUp。

**队列视角的完整现状：排队状态实际是三处分裂，不止 pending 消息一处。** 本设计只解决第一处，但拆分边界必须先看清全貌：

| 排队机制 | 数据结构 | UI 表达 | 可取消 | 来源 |
|---|---|---|---|---|
| ① pending 消息（本设计删除） | `messages` 内 `status:'pending'`（store.ts:257） | UserBubble 虚线框 | 否（drain 前只能等） | 前端 RPC 前注入 |
| ② pi 队列快照 | `queueStates`（store.ts:87，`{steering?, followUp?}`） | QueueBubble（composer 顶部） | **否**（pi 无 clear_queue RPC） | pi `queue_update` 事件回流 |
| ③ compact 排队 buffer | `useCompactQueue`（`packages/renderer/src/composables/panel/useCompactQueue.ts`，模块级单例 `queueInstance`，`composer-shell.ts:136` 实例化后经 `deps.getCompactQueue()` 注入 useChat，接口仅暴露 `flush`） | CompactQueueBadge（composer 上方） | **是**（逐条取消） | compact 期间用户输入前端暂存 |

方案 A 落地后②③仍并存："排队"仍有两个数据结构、两种 affordance（②只读 / ③可取消），同类信息不同能力。②与③的统一（queue 子域）属后续独立设计，不在本文 scope，登记于此避免"队列问题已解决"的错觉。

### 2.4 V6 spec 已判该虚线框废弃

V6 spec（`docs/page-design/v6-spec-input.html`）对 UserBubble pending 分支的裁决：

> **§8 anno（line 212）**：[v6 目标] 虚线气泡（steer=accent/followup=info 分色 + 脉冲点 + label + content）→ **删除，排队态统一归 §8.5 QueueBubble**。[现状] UserBubble.vue 仍渲染 pending 分支，属**待落地实现债**。
>
> **§8 change-point（line 113）**：删 pending 态（虚线气泡）→ 迁 QueueBubble [v6 目标 · 代码待清理]。

本设计与 V6 spec 完全一致，是 spec 标记的"待清理"的落地。

---

## §3 解决方案

**终态：steer/followup 发送后对话流无任何气泡，只有 QueueBubble 显示队列；drain 时消息以普通气泡进入对话流并紧跟 assistant streaming——与普通多轮对话一模一样。**

### 3.1 终态（使用者视角）

**场景：steer 成功路径**

```
[agent 正在 streaming（状态栏=菊花）]
[用户] 按 ⏎ 发送 "先处理这个：去掉 PanelHeader 的 border-b"（steer）
  → 对话流：无任何变化（没有虚线框，没有新气泡）             ← G1/G2
  → composer 顶部 QueueBubble：⚡ 去掉 PanelHeader 的 border-b  ← 队列反馈
  → 状态栏：保持菊花（streaming 不变）                       ← G3

[agent 当前回合工具调用结束，drain steer]
  → QueueBubble 消失（队列清空）
  → 对话流：出现一条普通 user 气泡 "先处理这个：去掉 PanelHeader 的 border-b"（无虚线框，无 STEER 标签）← G1
  → 紧接着 assistant 开始 streaming 回复（同一 turn）
  → 状态栏：保持菊花（新 turn 继续 streaming）               ← G3
```

**场景：followUp 成功路径**

```
[agent 正在 streaming（状态栏=菊花）]
[用户] 按 Alt+⏎ 发送 "回合结束后再做 X"（followUp）
  → 对话流：无变化
  → composer 顶部 QueueBubble：🕐 回合结束后再做 X
  → 状态栏：菊花

[agent 当前回合结束]
  → 状态栏：done（turn 结束的自然生命周期）                  ← G3，queue 不干预
[pi drain followUp → 新 turn]
  → QueueBubble 消失
  → 对话流：普通 user 气泡 "回合结束后再做 X" + assistant streaming
  → 状态栏：菊花（新 turn streaming）                        ← G3
```

**场景：RPC 失败（恢复指引）**

```
[用户] 发 steer "做 X"
  → QueueBubble 短暂显示后消失（RPC 失败，abortPending 清理 buffer）
  → 对话流：无气泡（pendingBuffer 清理，没进 messages）      ← 不污染对话流
  → composer 错误提示："steer 发送失败" 👉 检查 agent 是否在线后重试
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. pendingBuffer + drain 时 appendUser（推荐）** | ✅ 对话流彻底纯净（只含 complete 消息），pending 不进 messages；queue 与对话流关注点分离彻底 | 中：新增 pendingBuffer 数据结构 + 扩展 effect ctx 接口 + 改 store/useChat/effects/ui/mock/tests | buffer 清理边界（disposeSession 注册，见 §3.3.4）；drain→message_start 时序已确认是 pi 硬保证（见 §3.4 P-order ✅） | ✅ |
| B. 渲染层隐藏 pending（UserBubble 不渲染 pending） | ❌ 治标：pending message 仍在 messages 数组，只是不显示；数据污染未消除，markPendingDelivered/findPendingIndex 仍在维护这条隐式消息 | 小：只改 UserBubble + 测试 | messages 数组含不可见噪音；未来维护者困惑"为何有 pending message 但不显示"；G1 表面达成实质未达 | ❌ |
| C. drain 时用纯 text 重建 Segment（砍 pendingBuffer） | ◐ 对话流纯净（同 A），但 steer/followup 消息丢失 @mention 高亮/附件富文本 | 小：无 pendingBuffer，drain 时 text→Segment | G4 富文本降级；与普通 send 体验不一致（普通 send 保富文本，steer/followup 不保） | ❌ |

**推荐 A 的理由**：架构最干净（对话流 messages 物理上不可能含 pending，by construction 正确），且体验无降级——更进一步，**方案 A 相对现状是 G4 改进**：当前 pending 气泡渲染的是 `normalizeContent(content)` 纯文本（UserBubble.vue pending 分支），complete 态才渲染富文本 segments；方案 A 消除 pending 阶段，消息直接以 complete 富文本进入对话流，@mention/附件从一开始就完整渲染。

**pendingBuffer 是必要的最小结构，非 clever 机制（准则 8）**：pi drain 回流的是 text（string），但 appendUser 需要 Segment[]（保富文本）；text→Segment 不可逆（正是方案 C 的硬伤），故必须在前端暂存原始 segments——pendingBuffer（`Map<sid, PendingItem[]>`）就是这个暂存的最小载体，无更简替代。成本可接受——虽然涉及 3 包改动，但每处改动都是机械替换（appendPending→pushPending、markPendingDelivered→drainPending+appendUser）。

**若用方案 B（§2.2 的例子会怎样）**：虚线框不显示了，但 messages 数组里仍有一条 `status:'pending'` 的隐式消息在发送→drain 期间游荡，groupTurns 仍为它开一个空 turn（user:pending, assistants:[]），只是 UserBubble 不渲染。这条隐式 turn 占用 turnSeq 编号，且 markPendingDelivered 仍要按 text 匹配改它。数据结构的污染没消除，只是视觉上藏起来——下次有人碰这块代码仍会困惑。

**若用方案 C**：steer 发了 `@file 改下这个`，drain 后对话流里只有纯文本"@file 改下这个"，@mention 不高亮、文件附件丢失。与普通 send（`@file` 会高亮可点击）体验不一致，用户会感知到 steer/followup 是"二等消息"。

### 3.3 关键设计

#### 3.3.1 pendingBuffer：segments 的暂存与恢复

`pendingBuffer: Map<sessionId, PendingItem[]>`，每项：

```ts
interface PendingItem {
  text: string          // segmentsToText(segments).trim()，drain 时按 text 匹配（复用现有 countDrained）
  segments: Segment[]   // 原始富文本，drain 时 appendUser 用（保留 G4 富文本）
  sendMode: SteerFollowUpMode  // 'steer' | 'follow-up'
}
```

三个操作（替代现有的 appendPending/markPendingDelivered/removePending）：

| 操作 | 时机 | 行为 |
|---|---|---|
| `pushPending(sid, segments, sendMode)` | steer/followUp 发送时（RPC 前） | 暂存到 buffer，**不碰 messages** |
| `drainPending(sid, text, sendMode)` | queue_update 检测到 drain | FIFO 取出匹配项的 segments 并移除，返回 segments |
| `abortPending(sid, text, sendMode)` | RPC 失败 catch | 移除匹配项（不进 messages） |

**drainPending 的 FIFO 匹配**复用现有 `countDrained`（registry.ts:78）的计数差集逻辑——countDrained 返回 N 条同 text，pendingBuffer 按入队顺序逐条 drainPending 取出，与现有 markPendingDelivered 的 findPendingIndex FIFO 语义一致。

#### 3.3.2 effect ctx 接口扩展

当前 `MessageEffectContext`（effect-types.ts）暴露了 `markPendingDelivered` 但**没有 appendUser**。queue_update handler 需要在 drain 时调 appendUser，故 ctx 新增：

```ts
// MessageEffectContext 新增
appendUser: (sessionId: string, segments: Segment[]) => string
drainPending: (sessionId: string, text: string, sendMode?: SteerFollowUpMode) => Segment[] | undefined
```

#### 3.3.3 queue_update handler 改造

```ts
// registry.ts queue_update handler（现状：markPendingDelivered）
for (const text of countDrained(prev.steering ?? [], steering ?? [])) {
  markPendingDelivered(sid, text, 'steer')
}
// 改造后：drainPending 取 segments + appendUser
for (const text of countDrained(prev.steering ?? [], steering ?? [])) {
  const segments = drainPending(sid, text, 'steer')
  if (segments) appendUser(sid, segments)   // ← messages 第一次出现这条消息，且直接 complete
}
```

#### 3.3.4 错误处理与恢复指引

| 失败场景 | 行为 | 恢复指引 |
|---|---|---|
| steer/followUp RPC 失败 | `abortPending` 清 buffer；messages 不受污染；composer 报错 | 错误提示带"👉 检查 agent 是否在线后重试" |
| drain 到达但 pendingBuffer 无匹配（buffer 已被 abort） | `drainPending` 返回 undefined，跳过 appendUser（幂等） | 无需用户动作，状态自洽 |
| session 切换/关闭时 buffer 残留 | `disposeSession`（store.ts:500）的 per-session 清理遍历 `mapRefs=[messages, retryStates, queueStates]` 做 Map.delete；**pendingBuffer 必须显式加入该清理列表**（与 queueStates 对称），否则旧 sid 的 drain 迟到消息会误 appendUser | 无需用户动作 |
| drain 后 message_start 未到（pi 卡死） | user 消息已进 messages（complete），但无 assistant 回复 | 与普通 send 的 pi 卡死同处理（streaming 超时 timer 兜底） |

### 3.4 运行时断言探针清单（准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-order | drain（queue_update 出队）先于 assistant message.start 到达；drain 与 assistant message_start 间隔一整个 LLM 往返（非紧邻） | 两段时序分开看，避免误以为 drain 与 assistant streaming 同步紧邻：① drain **同步先于 user message_start**——pi `agent-session.js` `_handleAgentEvent` 收 `message_start{role:'user'}` 时，在同一 handler 内先 `_steeringMessages.indexOf(messageText)`→`splice`+`_emitQueueUpdate()`（drain 出队），再 `_emit(event)`（user message_start）；② xyz-agent `event-adapter.ts` 把 user role message_start `noop`（`if (role === 'user') return [{ kind: 'noop' }]`），前端不感知 user message_start；③ **assistant message_start 在 LLM 首 token 后**——pi `agent-loop.js` inner loop 先 `emit` 掉 user message（触发①的 drain），再调 `streamAssistantResponse` 发起 LLM 请求，assistant `message_start` 要等 `streamAssistantResponse` 内 `response` 的 `start` 事件才 emit，与 drain 间隔一整个 LLM 往返（数秒）。现有 registry.ts 注释 + fg5-message-stream.test.ts:426 已依赖此时序 | ✅ 已验证（pi 硬保证：drain 同步先于 user message_start，assistant message_start 在 LLM 往返后；非竞态） |
| P-turn | drain 时 appendUser 的消息与随后的 assistant 进入同一 turn | 真实 dev app drain 后检查 groupTurns 输出，断言新 turn 含 user+assistant（P-order 已保证 appendUser 先于 assistant message_start） | ⛔ 实施期 M2 |
| P-fifo | 多条同 text steer 连发，drainPending FIFO 顺序与 countDrained 一致；且 contentText 归一化失配不致丢消息 | 连发 2 条同 text steer，检查 drain 后两条消息顺序；另覆盖「含图片/特殊空白/@mention 的 steer」：pi drain 触发点是 `agent-session.js` `_steeringMessages.indexOf(messageText)` **纯文本匹配**，除「多条同 text」外，`contentText` 提取的文本与入队文本归一化不一致（空白/图片等）也会 `indexOf` 失配 → 不 drain → 消息成孤儿 turn（无对应 user 气泡） | ⛔ 实施期 M2（pre-existing 风险：现状 `markPendingDelivered` 同源 indexOf 匹配，方案 A 不恶化，登记此场景） |
| P-derived-independent | DerivedStatus 的 'pending'（session 级 pendingSend 空窗态）不受 MessageStatus 删 'pending' 影响 | read `renderer/src/types.ts:16` DerivedStatus（session 级）vs `shared/message.ts` MessageStatus（消息级）；read `sessionStatus.ts:150-182` deriveStatus 确认 'pending' 由 isActive(pendingSend) 派生，不读 message.status | ✅ 已验证（两者同名异义、互不引用；DerivedStatus 的 'pending' 显式保留） |
| P-groupturns-user | groupTurns 对每个 user message 开新 turn | 读 message-turns.ts:78 `if (msg.role === 'user') turnSeq += 1` | ✅ 已验证 |
| P-no-pending-leak | 重开 session 后 messages 无残留 pending（pi JSONL 不记录 pending message） | 发 steer 后重开 session，检查对话流无虚线框/无幽灵消息 | ⛔ 实施期 M2 |
| P-placeholder | drain→appendUser→assistant message_start 间隔整个 LLM 往返（见 P-order），TurnMeta `isPendingPlaceholder` 空 turn 占位（`isPendingPlaceholder = sessionActive && turn.assistants.length === 0`，"思考中"spinner）**持续该往返时长（数秒）**，不闪烁、不错位 | dev app drain 后观察新 turn：appendUser 后空 turn 立即显示占位 spinner（复用既有 dispatching 占位机制 TurnMeta `isPendingPlaceholder`），持续至 assistant message_start 到达后原地转 working 态（spinner→working 平滑过渡、同一 DOM 延续）。断言 turn 视觉无「先空 turn 再跳变占位」的割裂——**而非断言「一闪而过」**（P-order 已证间隔数秒，占位必然持续可见） | ⛔ 实施期 M2 |

---

## §4 验收

**改动规模：中等（跨 3 包的行为变更 + 数据结构调整）。验收用真实场景，非单测非 mock。**

> P-order 已由 pi 源码确认是硬保证（§3.4）。mock 当前限制：mock 的 steer/followUp drain 不 emit message_start（见 §5 M4），故 P-turn 及验收场景 1/2 须在真实 dev app（`pnpm dev` 连真实 pi）验证。单测仅作回归辅助。

### 场景 1：steer 成功路径（回溯 G1/G2/G3）

- **上下文**：dev app 连真实 pi，agent 正在 streaming（跑一个长任务，如读多文件）
- **步骤**：
  1. 按 `⏎` 发一条 steer（如"顺便看下 utils.ts"）
  2. 观察对话流底部、composer 顶部、状态栏
  3. 等 agent drain（当前回合工具调用结束）
- **通过标准**：
  - 发送瞬间：对话流**无虚线框、无新气泡**；composer 顶部 QueueBubble 显示 ⚡+文本；状态栏保持菊花
  - drain 后：QueueBubble 消失；对话流出现**普通 user 气泡**（无虚线框、无 STEER 标签）；紧跟 assistant streaming；状态栏保持菊花

### 场景 2：followUp 成功路径（回溯 G3，验证状态栏 turn 切换）

- **上下文**：同上，agent streaming
- **步骤**：
  1. 按 `Alt+⏎` 发 followUp（如"回合后总结一下"）
  2. 等 agent 当前回合结束
  3. 等 pi drain followUp → 新 turn
- **通过标准**：
  - 发送瞬间：对话流无变化；QueueBubble 显示 🕐+文本；状态栏菊花
  - 当前回合结束：状态栏→done（自然生命周期，queue 不干预）
  - drain 新 turn：QueueBubble 消失；普通 user 气泡 + assistant streaming；状态栏→菊花

### 场景 3：富文本保留（回溯 G4）

- **上下文**：dev app，agent streaming
- **步骤**：发一条含 `@文件名` 的 steer（如"@utils.ts 改下这个"），drain 后观察对话流
- **通过标准**：drain 后的 user 气泡里 `@utils.ts` **高亮可点击**，与普通 send 的 @mention 表现一致（非纯文本）

### 场景 4：RPC 失败不污染对话流（回溯 G1）

- **步骤**：构造 steer RPC 失败（如 agent 进程已退出时发 steer）
- **通过标准**：对话流**无任何气泡**；composer 报错提示带恢复指引；无幽灵 pending 消息残留

### 场景 5：重开 session 无残留（回溯 G1，P-no-pending-leak）

- **步骤**：发 steer 后（drain 前）关闭 session 再重开
- **通过标准**：重开后对话流无虚线框、无幽灵消息（pendingBuffer 是内存态不持久化；pi JSONL 不记录 pending message）
- **已知限制（pre-existing，本设计不恶化）**：若重开时 pi 子进程仍活、steer 仍在 pi 内存队列里，drain 会因前端 pendingBuffer 已空而漏 appendUser，导致 assistant 进对话流但无对应 user 气泡（孤儿 turn）。此为当前 markPendingDelivered 找不到 pending 时 no-op 的同源行为，本设计不修复，记为已知限制

---

## §5 下一层拆分

### 实施路径

按"先数据层 → 事件层 → 展示层 → 清理"分 4 步，每步可独立验证：

| 步骤 | 交付 | 验证 |
|---|---|---|
| M1 数据层 | store 新增 pendingBuffer + push/drain/abort；useChat 改用新方法；effect ctx 扩展 appendUser/drainPending | 单测 pendingBuffer 的 push/drain/abort + 集成测 steer 发送不进 messages |
| M2 事件层 | registry queue_update handler 改 drainPending+appendUser；跑 P-order/P-turn 探针 | 场景 1/2（真实 dev app） |
| M3 展示层 | UserBubble 删 pending 分支 + 相关 computed | 虚线框不再出现 |
| M4 清理 + mock | 删 appendPending/markPendingDelivered/removePending/findPendingIndex；删 MessageStatus 'pending'；mock drain 后 emit message_start（**配套生成 mock assistant 内容**，否则留下 dangling streaming 气泡；回归所有 mock steer/followUp 用例，补 message_start 会改变其语义）；删/改 7 个测试文件 | 全场景回归 |

### 文件改动地图

| 层 | 文件 | 改动 |
|---|---|---|
| shared types | `packages/shared/src/message.ts` | `MessageStatus` 删 `'pending'`（M4，P-derived-independent 已确认安全） |
| core store | `packages/core/src/domain/chat/store.ts` | 删 appendPending/markPendingDelivered/removePending/findPendingIndex；加 pendingBuffer + pushPending/drainPending/abortPending |
| core useChat | `packages/core/src/domain/chat/useChat.ts` | steer: appendPending→pushPending，catch removePending→abortPending；followUp 同理。**send() 的 `isActive`→steer 改道是既有 D-001 决策**（`send()` 内 `if (chat.isActive(sid)) { await steer(sid, segments); return }`，注释标 `[B 策略 D-001]`），**本次不改 send()**——方案 A 只改 steer() 内部实现（appendPending→pushPending）；且 Composer.vue busy 时普通⏎ 在 UI 层就直走 `onSteer()`（`else if (isActive.value) { onSteer() }`）。两条路径都进 steer()→pushPending，busy 时普通⏎ 的反馈随之从「虚线框 pending 气泡」变为「QueueBubble 排队」（与 G1/G2 一致）——这是方案 A 把 D-001 既有改道的反馈统一到 queue，非新增改道行为 |
| core effects | `packages/core/src/domain/chat/effect-types.ts` | MessageEffectContext 加 appendUser + drainPending |
| core effects | `packages/core/src/domain/chat/effects/registry.ts` | queue_update handler(546-551): markPendingDelivered → drainPending+appendUser |
| core store（ctx 组装） | `store.ts` `applyMessageEvent` | 把 appendUser + drainPending 加入 ctx 对象字面量（当前已注入 markPendingDelivered，同位置追加）。组装点已确认，非待验证 |
| ui | `packages/ui/src/features/chat/UserBubble.vue` | 删 pending 分支(line 26-35) + isPendingUser/pendingBubbleClass/pendingLabelClass/pendingDotClass/pendingLabel/isSteerMode computed |
| mock | `packages/renderer/src/api/mock/index.ts` | steer/followUp drain 后 emit message_start（补全 mock，使 P-order 可在 mock 初验） |
| tests（renderer） | `packages/renderer/src/__tests__/fg5-message-stream.test.ts` | **改动量最大**：6+ 用例直接调 `store.appendPending` + 断言 `status==='pending'`（line 358/375/426/447 等），删 appendPending / 删 MessageStatus 'pending' 后全部失败，需改为 drainPending+appendUser 断言 |
| tests（renderer） | `packages/renderer/src/__tests__/panel/turn-pending-bubble.test.ts` | 删除（pending 气泡不再存在）。注：实际路径在 renderer 非 ui |
| tests（ui） | `packages/ui/src/features/chat/__tests__/UserBubble.test.ts` | 11 处 pending/STEER/FOLLOW 断言（line 91/103/112/123），pending 分支删除后需删/改 |
| tests（core） | `packages/core/src/domain/chat/__tests__/store.test.ts` | pending→complete 用例改为 drainPending+appendUser |
| tests（core） | `packages/core/src/domain/chat/__tests__/effects.test.ts` | line 39 mock `markPendingDelivered`；queue_update 用例需随 ctx 扩展加 appendUser/drainPending mock |
| tests（core） | `packages/core/src/domain/chat/__tests__/useChat.test.ts` | line 179 steer 失败用例 removePending→abortPending 同步 |
| tests（新增） | `pendingBuffer.test.ts` | push/drain/abort + FIFO + 幂等 |

### 待验证检查点

1. **P-turn（drain→message_start 落到同一 turn）**：P-order 时序已由 pi 源码确认为硬保证（§3.4 ✅），故 appendUser 必然先于 assistant message_start 进 messages，groupTurns 会把它们归入同一 turn。仍需 M2 在真实 dev app 实测确认 turn 视觉无分裂。**无需 fallback**——groupTurns 按数组顺序遍历，appendUser 在前保证 user 先入 turn（reactivity 不是重排序器，时序保证靠 pi 源码而非 Vue 重算）。
2. **mock 补全**：当前 mock drain 不发 message_start，M4 补全时需**配套生成 mock assistant turn 内容**（否则留下 dangling streaming 气泡），并回归所有 mock-based steer/followUp 用例（补 message_start 会改变其语义）。
3. **disposeSession 清理**：pendingBuffer 必须加入 `store.ts:500 disposeSession` 的 mapRefs 清理列表（§3.3.4），否则 session 销毁后旧 sid drain 迟到消息误 appendUser。
