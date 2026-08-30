# steer/followUp 用户气泡显示链路修正

> **一句话结论**：streaming 中追加消息（steer/followUp）的用户气泡显示，当前由 pi 队列状态机的边沿事件（`queue_update` 帧差集）驱动——消息真实投递了但气泡可能永不出现；本设计把显示的存在性改为由**消息数据帧**（`message_end(user)`，携带完整 entry）驱动，队列帧退化为队列气泡（QueueBubble）状态与暂存对账，使四个已核实的丢失路径（含混合提交常态路径 F4）全部不再触发。

**设计层声明**：本文档是技术方案设计（当前层：架构修正方案；下一层：可实现的代码单元）。§3 按"接口/数据流/错误规格/选型对比"侧重，§4 验收要求真实环境跑通关键路径。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent GUI 中，agent 正在 streaming 输出时，用户在 composer 追加补充消息，前端按 pi 的 steering / followUp 机制排队，等 turn 边界投递。
- **C（冲突）**：消息实际投递成功（agent 收到并回复），但对话流中用户自己的气泡**偶发永不显示**；且一旦丢失，实时链路没有任何自愈手段，只有重开 session 才从落盘 entry 恢复。
- **Q（问题）**：为什么消息投递成功气泡却会丢？这是实现 bug 还是架构问题？如何让"我发的消息必然出现在对话流"与普通发送（send）同级确定？
- **A（答案）**：气泡显示被耦合在 pi 队列状态机的边沿事件链上（六个串行必要条件，跨进程、可丢帧、依赖第三方内部文本匹配），任何一环断裂即丢。修正方向：显示由消息数据帧驱动，队列帧只服务队列可视化与暂存对账。

### 系统是什么

xyz-agent 是 Electron + Vue 3 桌面 AI Agent 工作台。渲染进程（renderer）经 WebSocket 连 Node.js runtime，runtime 管理若干 pi 子进程（`@earendil-works/pi-coding-agent`，RPC 模式，stdin/stdout JSONL）。对话流数据分两层：渲染层 `messages` ref（实际渲染的数据分区）与 reducer 累积态 `entryStates`（W21 引入的权威镜像，live 事件与文件重放喂同一个 `applyEntry`，两者目前**无对账收敛**，W22 待做）。

用户在 streaming 中追加消息时，composer 按 `isActive` 分流为 steer（当前回合工具调用结束后、下次 LLM 调用前投递，不打断回合）或 followUp（回合结束后另起一轮）。注意 `send()` 在 busy 时也自动转 steer（`packages/core/src/domain/chat/useChat.ts:421` B 策略 D-001）——**所有 streaming 期间的追加输入都走本设计涉及的链路**。

### 设计目标（从使用者体验倒推）

1. **G1 消息必然可见**：streaming 中追加的每条消息，投递后其用户气泡必然出现在对话流——不依赖任何单条控制帧的到达（队列帧丢失、延迟、pi 侧队列事件缺失都不影响存在性）。
2. **G2 内容不降级**（尽力）：正常路径下气泡保留原始 segments（文件/mention/skill 徽章），仅在前端暂存确已丢失时降级为 pi 落盘纯文本——降级可见但不静默。
3. **G3 live ≡ reload**：投递后的气泡与重开 session 从 entry 重放的投影逐字段一致（项目关键规则 9，现有等价性测试守卫）。
4. **G4 本地快照操作不抹除已投递消息**：切入 session 的历史刷新（reconcile/hydrate）不得把已投递的用户气泡抹掉。

### in-scope / out-of-scope

**In**：steer/followUp 用户气泡的存在性链路；queue_update handler 职责重划；pendingBuffer 生命周期闭合；reconcileHistory/hydrate 合并规则；send 路径零回归。

**Out**：
- 显示时机提前（"提交即显示 pending 气泡"的 S7 原设计复活）——独立的体验增强，另立设计（见 §3.2 方案 A 被否理由）。
- W22 全量对账（ref ← reducer state 全类型投影收敛）——本设计是它的 user 消息前置切片，不替它做。
- steer/followUp 消息重开后的 badge 回填（msg-id-mapper 标记机制接入）——现状限制（重开降级纯文本）维持，见 D5。
- QueueBubble UI 形态、compact 队列（useCompactQueue）、subagent 定向消息（custom 通路）——不受影响。
- pi 侧任何改动——项目规约不修改 pi 源码，pi 的队列 splice 行为按黑盒对待。

---

## §2 现状与问题分析

### 使用者视角的现状（真实例子）

用户在 GUI 对话，agent 正在输出（streaming 气泡打字中）。用户在 composer 输入「并且看看现在配置执行的模型是什么模型？」按追加（steer）或下一轮（followUp）：

- composer 上方出现 QueueBubble，提示有消息待进入对话（数据源 `queueStates`，pi 队列镜像）；
- 当前回合结束后 agent 回复了这条消息的内容——**消息确实投递了**；
- 但对话流中，用户这条消息的气泡没有出现。它夹在上一条 assistant 回复与下一条 assistant 回复之间，应该是 user 气泡的位置是空的。

真实日志样本（`~/.xyz-agent/logs/pi-2026-08-30-f9282969-*.jsonl`，3436/5261 行）：pi 侧事件序完整——`queue_update(入队帧)` → ……turn 结束…… → `queue_update(drain帧,清空)` → `message_start{role:user}` → `message_end{role:user}` → `message_start{assistant}`。pi 侧无异常；问题在 runtime→renderer 的消费链。

### 当前显示链路：六个串行必要条件

steer/followUp 提交后，消息**不直接进对话流**（`store.ts:479` pushPending 只写 pendingBuffer 暂存，注释明确"pending 不进对话流"）。气泡出现的唯一路径：

```
① pi 投递时 message_start(user) 内部按 indexOf(展开后文本) 匹配 splice 队列成功
   （pi dist agent-session.js:365-386；空文本守卫 if(messageText) 直接跳过）
② splice 触发 queue_update(drain 帧) 广播（pi → runtime → renderer WS）
③ 帧到达 renderer 时 queueStates 里上一帧快照（prev）仍存在
   （瞬态：断连收口被 clearIndependentTransient 清、message_start 无条件清）
④ countDrained(prev文本数组, 本帧文本数组) 差集 > 0（registry.ts:86-98 计数差集，queue_update handler :609-652 调用）
⑤ pendingBuffer 有匹配 sendMode 的存货（drainN 计数 FIFO 取出 segments）
⑥ 期间不被切入 session 的 getHistory 旧快照整量替换抹掉（reconcileHistory）
```

每一环都是必要条件。runtime 侧把 user 的 `message_start` 过滤为 noop（`event-adapter.ts:635`），user 消息实时显示**没有第二条通路**；`message_end(user)` 帧虽正常转发（`MESSAGE_END_ALLOWED_ROLES` 含 user，`event-adapter.ts:696`）且携带完整 entry，但前端只喂 reducer（`registry.ts:453` applyEntryFrame），**从不投影回 messages ref**——投递事实权威侧一直知道，UI 侧无人核对。

### 物理数据流图（现状）

```
用户 composer 提交 steer
  │
  ├─ renderer useChat.steer() ── pushPending ──→ pendingBuffer（暂存，不渲染）
  │        └─ RPC steer ─→ runtime dispatcher ─→ pi session.steer()
  │                                            ├─ 文本展开后入 pi 队列
  │                                            └─ queue_update(入队帧) ──→ queueStates ──→ QueueBubble 显示
  │
  └─ pi turn 边界投递
       ├─ message_start(user) ─[runtime 过滤 noop]              ✂ 不达 renderer
       ├─ splice 队列（文本 indexOf 匹配，可能失败）
       ├─ queue_update(drain帧) ──→ renderer：
       │      prev 存在? ─→ countDrained>0? ─→ drainN ─→ appendUser ──→ 气泡 ✅
       │      prev 缺失  ─→ 跳过插入 ─→ 同帧 reconcilePending 把 buffer 裁到 0（不可逆）❌
       ├─ message_end(user) ──→ renderer applyEntryFrame（只喂 reducer，不投影 ref）
       │                        【投递事实已知但无 UI 出口——本设计的接入点】
       └─ message_start(assistant) ──→ renderer 清 queueStates（G-023，QueueBubble 消失）
```

### 已核实的四个失败模式

| # | 失败模式 | 断在哪一环 | 触发条件 |
|---|---------|-----------|---------|
| F1 | pi 侧 splice 文本不匹配 → drain 帧永不发出；投递照常发生 | ① | 入队文本（skill/prompt 模板展开后）与投递时 `message_start(user)` 的 contentText 任何差异；或 contentText 为空（`if(messageText)` 守卫）。随后 assistant `message_start` 清掉 queueStates，QueueBubble 消失，气泡永不出现。机制实锤（pi dist 源码），具体诱因待实跑复现 |
| F2 | reconcileHistory 旧快照整量替换抹掉已插入的气泡 | ⑥ | 切走再切回 session：getHistory RPC 发出时消息未投递、返回前 pi 恰好投递（drain 帧 → appendUser 入流）、随后旧快照（不含该 user entry）替换分区。窗口 = 一次本地 RPC 往返（`use-session.ts:233-243`、`store.ts:400-418` 只保留尾部 streaming assistant） |
| F3 | 断连 + message-bus ring（容量 1000）溢出 | ②③ | streaming 中每 token 一帧 delta，断连稍长入队帧即被覆盖；重连回放若缺入队帧，queueStates 无法重建；若断连收口已清 queueStates，drain 帧 prev 缺失 → 不插入 + reconcilePending 裁 buffer（内容永久删除） |
| F4 | G-023 清快照 → followUp 投递两腿全断 + 暂存被裁 | ③⑥ | **常态操作路径**（触发条件 = 快照非空时出现任意 `message_start(assistant)`，不限显式混合提交——turn 内多轮工具调用引发的重复 assistant start 同样触发，纯 followUp 在多轮工具调用 turn 内一样中招）：s1(steer) 投递 → drain 帧显示 s1 ✓ → steering 点的 `message_start(assistant)` 触发 G-023 **无条件删 queueStates 快照**（registry.ts:151）——此时 `{followUp:[f1]}` 快照（f1 未投递）被一并删除；turn 结束后 f1 投递：drain 帧 prev 缺失（③断）→ reconcilePending 以本帧深度 0 把 buffer [f1] 裁空（⑥，暂存不可逆删除）→ `message_end(f1)` 到达时腿 2 includes 无快照可查 → f1 永久漏显。这是用户可见概率最高的丢失路径（AC-1 主路径即此场景），final gate review 轮反例重演发现 |

### 根因分析（从症状到架构）

**症状层**：四个触发条件迥异的路径（pi 内部行为 / 用户切换操作 / 网络断连 / 正常混合提交操作序列）造成同一种丢失，且丢失后无自愈——连正常操作（F4）都能触发，这是"多个症状、同一根因"的架构问题特征，不是散落的实现 bug。

**根因四条**：

1. **显示信号源错位**：消息数据的入流由**队列元状态的边沿事件**驱动，而非**消息数据事件**。queue_update 是 pi 为队列可视化设计的信号，被复用为数据入流触发器——UI 正确性从此依赖另一个进程内部状态机的每次变迁都被完整观测。F4 是其显影：显示链的判据（腿 1 的 prev 快照 / 腿 2 的 includes 快照）寄生在 QueueBubble 的 UI 显示态上，G-023 的 UI 清理动作（清显示态）顺带摧毁了数据判据。
2. **level 信号被降级为 edge 信号**：queue_update 帧本身携带全量状态（完整数组 + `pendingMessageCount` 深度），handler 却只做帧间差集。边沿协议要求看到每次变迁，丢一帧即永久错乱；水平协议丢帧后下一帧自动收敛。
3. **S7 设计与实现背离**：`useChat.ts:518` 注释仍是 S7 原设计"steer 发出后立即入流，投递时转 complete"；实现却是"pending 不进对话流"（`store.ts:157`）。这一改把气泡的存在性（而非状态转换）押上了事件链。
4. **overlay 无权威出口**：`appendUser` 是 overlay-only 不喂 reducer；`message_end(user)` 帧只喂 reducer 不投影 ref。两条平行状态无对账（W22 未做），投递事实在权威侧已知却无法回流 UI。

**佐证**：同一 user 消息，send 路径乐观插入（提交即显示，从不丢）、steer/followUp 路径悲观延迟显示（六环链路）——同一数据两条显示语义，不对称本身即设计未收敛。补丁考古亦然：W14 计数 FIFO（绕 pi 文本匹配）、B1 计数差集、PR #185 深度对账——每个补丁修一个场景，都保留了"队列事件边沿驱动显示"的核心假设；同一不可靠假设前端绕过了一半，另一半仍留在 pi 内部（splice 文本匹配），F1 即其显影。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**：streaming 中用户追加消息「注意用中文回复」。composer 清空、QueueBubble 显示 1 条待进入。当前回合结束，消息投递：

- 用户气泡出现在上一条 assistant 回复之后（文件/mention 徽章保留，因为 segments 暂存在投递前未被裁剪）；
- QueueBubble 消失；agent 开始回复，一切如常。

**失败路径 A（控制帧丢失）**：用户网络闪断 30 秒，期间恰好投递。重连后对话流补齐：agent 的回复气泡出现，**用户气泡也在**——重连 ring 回放按 seq 保序，两腿各需「帧 + 快照」成对成立：腿 1 = drain 帧 + 前置快照（回放先入队帧再 drain 帧，prev 重建，countDrained 正常差集）；腿 2 = `message_end(user)` 数据帧 + 入队帧快照（includes 在重建快照上命中 → 消费插入）。**已知降级形态**：ring 逐出旧帧优先，入队帧（老）被冲掉而 drain 帧（新）存活的断连下，腿 1 缺 prev、腿 2 缺快照，气泡短暂缺失——但 pendingBuffer 未被裁剪，用户切入切出触发 reconcile 刷新后由快照（含已落盘 entry）补齐——恢复动作：切走再切回该 session 即可，无需重启。

**失败路径 B（abort 丢弃）**：用户追加消息后点了停止。pi 丢弃队列中未投递消息，QueueBubble 消失，气泡不出现（未投递的消息不进对话流——与现状语义一致）。前端在同一信号（`message.complete{stopReason:'aborted'}`）清理暂存，无残留错位。

**失败路径 C（RPC 失败）**：追加提交时 WS 已断，steer RPC 失败 → toast 报错 + 暂存回滚（现状 W1 机制，不变）。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|--------------|-------------|------|------|
| **A：提交即显示**（S7 原设计复活：steer 提交时插入 pending 气泡，投递时转正） | 体验最优（立即看到）；但"转正"需要 abort/丢弃的回滚 UI，且提交序 ≠ 投递序（steer 全部先于 followUp 投递）破坏 live≡reload 顺序，需重排收敛机制——引入新的复杂度 | 高：appendUser 语义改造 + 气泡状态机 + 顺序重排 + abort 回滚 | 顺序收敛与双状态（pending/complete）的新 bug 面；与 QueueBubble 双展示需协调 | ❌ 体验增强另立设计 |
| **B-pure：单一数据帧驱动**（`message_end(user)` 是唯一显示源，删除 queue_update 的 drain 腿） | 信号源最纯粹 | 中：删 countDrained/drainN/reconcilePending 一族 + 重写 | 数据帧同样会丢（F3 的 ring 溢出对 message_end 帧一样成立）——**单一信号源无论选谁都不是可靠信号源**；删除现有已验证链路的回归面大 | ❌ 纯粹≠可靠 |
| **B-hybrid：数据帧主升 + 队列帧降级为对账腿**（双腿互斥 + reconcile 快照保护 + buffer 生命周期闭合） | 双腿任一到达即可显示（无单点）；数据帧腿是 W22 对账的前置切片；队列帧回归 QueueBubble 本职——三条根因（信号源/降级/覆盖）都正面处理 | 低-中：一个 handler 增强 + 一个 handler 减法 + 合并规则扩展，send 显示语义零改动（仅外围 inflight 计数挂钩，见 D2） | 双腿幂等边界需精确（见 D2）；两条腿都是现有机制的延伸，回归面可控 | ✅ **推荐** |
| **C：修补边沿链**（prev 缺失兜底 + 深度差补 drain，不动信号源） | 保留根因 1/2，边沿协议的下一个暴露面仍会出现 | 低 | 已被 W14→B1→PR#185 三层补丁史证伪：同病复发 | ❌ 对照组 |

**B-hybrid 被选理由**：G1 要求"不依赖任何单条控制帧"——可靠性只能来自冗余信号 + 水平对账，不来自换一个单一信号源。B-hybrid 同时是三根因的正面解：数据帧腿解根因 1（信号源），深度对账保留 level 语义解根因 2，快照保护解 F2（根因 4 的 UI 侧缓解）。

**若用被否方案，§3.1 的例子会怎样**：方案 A 下失败路径 A（断连）不再依赖投递事件（提交即显示），但引入"abort 丢弃已显示气泡"的回滚闪烁与混合提交时的乱序重排——把正确性风险从"显示时机"挪到"顺序与回滚"，问题没消失只是换了形态。方案 C 下 §2 的 F2/F3 原样保留——补丁只修被点名的场景。

### 3.3 关键决策与权衡

**D1：显示存在性 = 双腿信号，任一到达即插入（选定）**
- **采用**：腿 1（现有）queue_update drain 帧 → countDrained → drainN → appendUser，保留不动；腿 2（新增）`message_end(user)` 帧到达时做**条件消费**（判定见 D2）——判定腿 1 未处理时 drainN(1) 取暂存回填 segments 插入，暂存空时用 entry 纯文本降级插入；判定腿 1 已处理则仅作幂等校验、零动作。
- **被否**：单一信号源（B-pure）——任何单帧都可丢（ring 容量 1000 对高频 delta 是现实约束），单点必留丢失窗口；修补边沿（C）——三层补丁史已证伪。
- **证据**：`message_end(user)` 帧正常转发且携带完整 entry（`event-adapter.ts:696` MESSAGE_END_ALLOWED_ROLES、handleMessageEnd 构造 entry）；pi 保证投递时序 splice(queue_update) 先于 message_end（agent-session.js `_handleAgentEvent`：splice + emitQueueUpdate 在 `_emit(message_start)` 之前，message_end 紧随）——两腿有确定先后，互斥判定可靠。
- **效果**：G1 成立。F1（drain 帧不发）由腿 2 兜住；F3（任一帧被 ring 冲掉）由另一腿兜住；F4（G-023 清快照断链）由 D4 条件清在源头消除（followUp 投递时 prev 在场，腿 1 直接恢复）；两腿全丢且消息已投递的场景由 D3 的快照收敛兜底。

**D2：双腿互斥 = 「inflight 确认计数 + includes 兜底校验 + send 乐观挂钩」（选定）**
- **采用**：per-session 维护**单一计数 inflight**（语义 = 已显示待确认的投递数，不变式 inflight ≥ 0，正常路径逐投递归零——无欠账可累积），三个维护点：
  1. **腿 1 消费**：queue_update drain 帧 → countDrained 差集 N → drainN 实际取出 m 条 → 消费显示后 `inflight += m`（drain 帧是投递证据，这些气泡"已显示待 message_end 确认"）。按实取数 m 计（m < N 的差额 = 扩展注入等 buffer 无货条目，未显示即不确认，其 message_end 到达时走第 3 点兜底）。
  2. **message_end(user) 确认**：帧到达时 `inflight > 0` → 本帧对应已显示的投递 → `inflight -= 1`，跳过（不查 includes——同文本下数组可能还剩未投递条目的同文本，includes 不可判定，inflight 计数优先裁决）；`inflight == 0` → 本帧无已显示投递可对应 → 进入第 3 点。**send 挂钩**：send 乐观 appendUser 时 `inflight += 1`（乐观插入即"已显示"，其自身投递的 message_end 到达时被正常确认抵消，不落入第 3 点）；**send RPC 失败回滚**：send 的 catch（清 pendingSend 处，useChat.ts:435-443 现状逻辑）同步 `inflight -= 1`——pi 侧无消息、message_end 永不到来，不回滚则配额永久悬空、下一次 F1 投递的 message_end 被错抵。**挂钩位置约定**：+1/−1 挂在 useChat send 调用点（与 appendUser 相邻但不在其内）——appendUser 函数保持纯净零挂钩，防腿 1 的 drainN→appendUser 路径与函数内 +1 双计、防 editAndResend 等其他 appendUser 调用方被误挂钩。
  3. **腿 2 兜底消费**（仅 inflight == 0 时）：includes 校验——帧内 entry.contentText ∈ 最后 queue_update 帧数组 → 命中（该文本曾入队且队列还有同文本快照 = pi 已 splice 但 drain 帧未达的 F1/丢帧场景）→ **消费 1 条**：drainN(1, sendMode 由命中数组维度推导) 回填 segments，暂存空（扩展注入）则帧内 entry 纯文本插入；未命中（send 文本从不在数组）→ 跳过。消费后不加 inflight（显示即完成，本帧就是自己的确认帧）。**消费后从快照剔文本**（命中文本从 queueStates 对应维度数组移除一个实例）：F1 场景快照停留于入队帧（含已被腿 2 消费的文本），不剔则下一条提交的 countDrained(prev, new) 差集会错算出虚假 drain 数 → 腿 1 提前取出未投递条目；剔后快照深度与实际待投递对齐，D4 的 G-023 条件清与僵尸清理读到的深度才是真实值。**边界披露**：剔快照仅覆盖「无新 queue_update 帧」窗口——F1 时 pi 侧 `_steeringMessages` 镜像同样残留该文本（splice 失败未移除），下一次任何全量帧会把残留带回前端快照；带回后同文本碰撞 splice 消掉 pi 残留的虚假差集场景仍可能出现，与现状行为等同（非回归）。pi 侧残留的根治需 pi 修 splice，out-of-scope 约束下不做。
  - 无快照可用（断连清了 queueStates 且重连回放未重建，或 drain 空帧已删条目）→ includes 无据 → 跳过，漏显由 D3 快照收敛兜底（AC-3 恢复动作）。
- **被否**：
  - 无条件 `drainN(1)`（初版）——多提交反例：腿 1 消费 s1 后 message_end(s1) 错取未投递的 f1（未投递先显示、abort 无法回收、真投递时双插）。
  - 纯 includes 判定（第二版）——同文本多次提交下不可判定：「drain 帧未达（快照 [T]、buffer 含 T，应消费）」与「drain 帧已达且剩同文本（快照 [T]、buffer 含 T，应跳过）」本地观测完全同构。
  - 双计数对账 delivered/consumed（第三版）——**量纲欠账**：delivered 仅 includes 命中时递增，而正常路径（drain 帧先达）includes 恒失配 → delivered 恒不增；consumed 统计全部消费 → 正常路径每条投递制造一份永久欠账（consumed 增、delivered 不增，仅 abort/disposeSession 清零），一次正常投递后该 session 所有 F1 投递满足 delivered ≤ consumed 被跳过——**腿 2 在最常见的 session（有过正常投递历史）上静默失效**，且恰好能通过 AC-1 主路径验收而不被发现。修复方向"消费点双增"亦被否：同一投递产生两份证据（drain 帧 + message_end 帧）双计入 delivered，同文本 [T,T] 场景第一条 T 的 message_end 仍会命中剩余同文本 → 误判新投递 → 错吃第二条。**病根是两计数独立维护允许漂移，正确解是合并为单一差值计数（inflight）并让每份证据恰好消费一次**。
  - 按 piEntryId 去重——腿 1 插入的消息 piEntryId 被剥除（乐观 id 是客户端 `u-<uuid>`，`store.ts:466`），帧侧 entry.id 恒缺省（pi 在 emit 之后才 appendMessage 分配 uuidv7，`event-adapter.ts:706-708`），两侧结构性异源。
- **证据**：pi 入队文本、投递 message contentText、queue_update 帧数组文本**三者同源恒等**（agent-session.js：`steer(text)` 展开后 `_queueSteer(expandedText)` 同时写入队列数组与 agent 消息 content；splice 按 indexOf 同文本匹配）——第 3 点的 includes 是 **pi 帧文本 ↔ pi 帧文本** 同源比对，与 W14 否决的「前端提交原文 ↔ pi 展开文本」跨源匹配（`store.ts:50-52`）不是同一命题；且 includes 只作 inflight==0 时的兜底校验（唯一职责 = 排除 send 与确认曾入队），不再承担同文本裁决。pi 投递时序保证 drain 帧先于 message_end（`_handleAgentEvent`：splice + emitQueueUpdate 先于事件广播）→ 确认制成立。
- **效果**：G1/G2 成立且不错插：正常路径逐投递 inflight 归零（无欠账，任何 session 状态下腿 2 都活着）；同文本/跨 mode 由 inflight 计数裁决（与文本无关）；send 由乐观挂钩抵消（零干扰）；扩展注入获得纯文本显示能力。**已知边界**：①跨 mode 同文本 + 腿 1 全失效时，sendMode 推导可能误指另一 mode → 该 mode 暂存取空 → 走纯文本降级插入（内容同质无视觉差、数量不差）；②时序倒置（message_end 先于 drain 帧，P1 探针假设外）→ 腿 2 先消费后 drain 帧到达，腿 1 countDrained 会错取下一条——P1 降级路径给腿 1 加守卫（见 §5 P1）。

**D3：reconcileHistory/hydrate 尾部保护 + user 正序-尾窗对齐去重（选定）**
- **采用**：两步合并规则：
  1. **尾部保护段收集**（现规则扩展）：从分区尾向前收集「streaming assistant **或** user（piEntryId 缺失或不在基线 id 集）」的连续段，遇其他已确认消息即停——快照滞后时已投递消息先被保留。记保护段中 user 数为 n，基线尾部连续 user 数为 k。
  2. **user 正序-尾窗对齐去重**（新增，解决 live id 异源的双计）：对齐数 a = min(n, k)；**保护段正数第 1..a 条 ↔ 基线尾部正数第 k−a+1..k 条**逐位对齐，对齐上的保护段 user 从保留集中剔除（基线版本已含该消息）；保护段其余 n−a 条保留。方向依据：**投递序 = 落盘序**，先投递的先落盘——基线滞后时缺的是尾部新消息（后缀），对齐必然从保护段头部（先投递）与基线尾部窗口的后缀前缘对起。**不能倒序对齐**：k < n 时倒数第 1 会把保护段最新条（基线没有）错配到基线最新条（较旧），剔掉基线没有的、留下基线已有的——恰好双计反转。
- **被否**：
  - 纯 piEntryId 判定（初版）——live 侧 user 消息 piEntryId 恒缺省（D2 证据），「piEntryId ∈ 基线」对 user 消息结构性不可满足 → 快照全含后 streaming 窗口内 reconcile 双气泡。
  - 数量对齐 + 数量不足全保留（第二版）——部分滞后窗口（n > k > 0）双计：两条相继投递、快照在两次落盘之间取得（含 s1 不含 s2），保护段 [s1_ov, s2_ov]、基线尾部 [s1_real]（k=1 < n=2）→ 全保留 → merged = [基线(s1_real), s1_ov, s2_ov, …] → s1 双计。正序-尾窗对齐下 a=1：s1_ov ↔ s1_real 剔除、s2_ov 保留 ✓。
  - 归一化文本比对去重——live 侧 content 是原始 segments、基线是 pi 展开后文本，跨源不等（W14 同款坑）。
- **证据**：id 异源事实链（`store.ts:462-466` 剥除、`event-adapter.ts:706-708` 帧无 id、基线重放带真实 uuidv7 `store.ts:188-190`）；pi 落盘同步且按投递序（session-manager `_persist` appendFileSync）——投递序与基线尾部序列严格同序，正序-尾窗对齐的四类场景（全对齐 n=k / 部分滞后 n>k>0 / 基线多含 n<k / 快照全缺 k=0）逐一验证成立。
- **效果**：G4 成立。F2 不丢消息；D1 双腿全丢的极端场景由切入刷新的快照收敛；部分滞后的中间态不双计。**已知边界**：跨 turn 重发相同文本（旧 turn 已落盘同文本 user、新 overlay 在保护段）时数量对齐可能误剔新 overlay——表现为该消息暂以基线旧版本显示（位置在历史区），下一轮 reconcile（新 entry 落盘后基线含 2 条）自然收敛，不丢消息不重复，列为已知可接受边界（错误规格表）。
- **表述修正**（对初版）：腿 2 插入与重放投影是**形态同构、id 异源**（live 客户端 id / 重放 uuidv7，W21 已裁决差异类），AC-7 等价性断言按字段归一设计，不断言 id 相等。

**D4：pendingBuffer 生命周期闭合 + queueStates 显示语义归正（选定）**
- **采用**：去掉 queue_update handler 中 reconcilePending 的**投递侧裁剪**（drain 后立即裁到深度——它会吃掉腿 2 还没回填的 segments，且是丢消息的不可逆放大器）。裁剪语义改为**只清僵尸**：仅在 `message_start(assistant)`（G-023 时点）时，若 buffer 存量 > 快照深度，清空残量。**G-023 从无条件清快照改为条件清**（F4 修复）：仅当快照深度 == 0（无快照或数组全空）时清 queueStates——QueueBubble 消失语义从「新回合启动」（edge，混合提交时误删未投递 followUp 的快照）归正为「队列深度归零」（level，幂等、丢帧可由下一帧收敛）。此时快照深度 = 未投递 followUp 数（steering 已 drain、followUp 待 turn 边界——混合提交常见非 0）；僵尸清理与条件清同帧同据（先读快照深度，再判定），F1 残留快照由 D2 第 3 点的消费剔快照对齐。abort 场景：`message.complete{stopReason:'aborted'}`（registry.ts:226 现有信号）时清 pendingBuffer **+ inflight 计数 + queueStates**——pi abort 确定性清队列，三者同作废，防 FIFO 错位、确认基线悬挂与 QueueBubble 悬挂（G-023 条件清后 abort 后的 message_start(assistant) 不再兜底清残留快照，abort 信号成为唯一出口）。disposeSession 清分区（现状保留）。
- **刻意保留（跨扰动存活，两条腿的工作前提）**：**LRU 驱逐不清 pendingBuffer / queueStates / inflight 计数**（现状如此，维持）——驱逐重进后腿 2 判定与腿 1 暂存仍可用；**断连收口清 queueStates、保留 pendingBuffer 与 inflight 计数**（现状如此，维持）——重连 ring 回放入队帧可重建 queueStates，buffer 与 inflight 在则两腿可对账消费。注意这与 `store.ts:182`「disposeSession / LRU 驱逐同点清理」的既有清理惯例**不一致，是有意为之**：清理 entryStates/anchors 是重建型状态（hydrate 重放可恢复），pendingBuffer 与 inflight 计数是不可重建状态（segments 与确认基线仅存在于前端），清了即永久丢失/漂移。实施时在 LRU 驱逐回调与 clearIndependentTransient 处加注释声明此豁免，防后续维护按惯例顺手补清。**计数清理挂点**：abort（`message.complete{stopReason:'aborted'}`）与 disposeSession 时同步清 inflight——pi 队列已确定性清空，确认基线作废，防跨生命周期错位（abort 后已显示未确认的条目不会再有 message_end，inflight 残留会吞掉后续投递的确认配额）。
- **被否**：维持"每帧 reconcilePending 裁剪"——pi 时序保证 drain 帧先于 message_end，立即裁剪会让腿 2 的 segments 回填在正常路径下永远失效（D2 依赖 buffer 在两腿间存活到 message_end 到达）；断连等场景的裁剪不可逆丢内容（F3 放大器）。**维持 G-023 无条件清（现状）**——F4 反例：混合提交 [steer s1 + followUp f1] 常态路径下，s1 投递后的 message_start(assistant) 无条件删 `{followUp:[f1]}` 快照 → f1 投递时腿 1 prev 缺失 + reconcilePending 裁空 buffer + 腿 2 无快照可查，f1 永久漏显（AC-1 主路径即此场景）；条件清后 f1 投递时 prev 在场，腿 1 直接恢复。
- **证据**：pi 投递时序（queue_update → message_end(user)，同批事件循环内相邻）；`reconcilePending` 现行为（`registry.ts:640`，drain 后无条件执行）；G-023 无条件 `queueStates.value.delete(sid)`（`registry.ts:151`，注释自述"只清显示态"——但快照同时是腿 2 includes 的判据源与腿 1 的 prev，清显示态 = 断数据链）；空帧删条目（`registry.ts:642-648`，drain 到空自动收敛 QueueBubble——条件清只是让"深度未归零"的快照活下去）；**pi `abort()` 不调 `clearQueue()` 也不 emit queue_update**（pi dist agent-session.js:1222-1227，clearQueue 是独立 API :1191-1201）——abort 后 session 层队列镜像既不清也不通知，前端 abort 信号清快照是唯一出口，且顺带修复现状 abort 后 QueueBubble 悬挂的存量 bug（无 message_start(assistant) 跟随时现状本就无人清）；LRU 驱逐回调现清单（`store.ts:323-334`，不含 queueStates/pendingBuffer）与 clearIndependentTransient 现清单（`streaming-state-machine.ts:115-128`，清 queueStates 不清 pendingBuffer）；混合提交时 G-023 时点深度=1（steering 投递后 followUp 仍在队，final gate review 轮确认）。
- **效果**：G2 成立（buffer 存活到 message_end，正常路径徽章不降级）；**F4 修复**（混合提交常态路径 f1 显示恢复，且 QueueBubble 在 followUp 待投递期间持续显示——比现状语义更正确）；buffer 生命周期出口全闭合：push（提交）→ drain（两腿消费）→ abort 清空（pi 丢弃）/ abortPending（RPC 失败）→ disposeSession（销毁）｜LRU 驱逐与断连收口 = **刻意保留**（见上）。僵尸隔离：G-023 时点清残量防 FIFO 错位污染后续 steer。

**D5：steer/followUp 的 badge 重开回填不接 msg-id 标记（选定，scope 裁剪）**
- **采用**：本设计不给 steer/followUp 的 promptText 加 `<!--xyz:msg:u-uuid>-->` 标记（send 独有机制）。重开后 steer 消息维持纯文本降级（现状已知限制，`store.ts:444` 注释 textToSegments 已知限制）。
- **被否**：接标记机制——需处理 pi 队列文本含标记后的 QueueBubble 显示过滤、msg-id-mapper 对 steer 路径的适配、正则锚定稳定性，改动面翻倍且与存在性修正正交。
- **证据**：标记机制全链路（`useChat.ts:380` submitSegments + msg-id-mapper input hook 只认 source='rpc' 的 prompt 路径，steer RPC 走 `session.steer()` 不经 input hook）。
- **效果**：scope 收敛，存在性修正独立交付；badge 回填作为后续对齐项挂在 W22。

### 终态数据流图（与 §2 现状图对照，改动点标 ★）

```
用户 composer 提交 steer
  │
  ├─ renderer useChat.steer() ── pushPending ──→ pendingBuffer（暂存，不渲染）
  │        └─ RPC steer ─→ runtime ─→ pi session.steer()
  │                                 ├─ 展开后文本入队 ─→ queue_update(入队帧) ──→ queueStates ──→ QueueBubble
  │
  └─ pi turn 边界投递
       ├─ message_start(user) ─[runtime 过滤 noop]（不变）
       ├─ splice 队列（文本 indexOf，可能失败）
       ├─ queue_update(drain帧) ─★ 腿 1（保留）：prev 差集 → drainN → appendUser → 气泡
       │      prev 缺失 → 跳过（不再触发 reconcilePending 投递侧裁剪 ★ buffer 不被吃）
       ├─ message_end(user，带 entry) ─★ 腿 2（新增，inflight 确认制）：
       │      inflight > 0（腿 1 已消费待确认）→ inflight-- → 跳过（send 乐观挂钩同理抵消）
       │      inflight == 0 → includes 兜底校验：entry.contentText ∈ 最后 queue_update 帧数组？
       │        未命中 → send 路径 → 跳过
       │        命中 → 腿 1 未处理（F1/丢帧）→ 消费 1 条：
       │              drainN(1, 命中数组推导 sendMode) 回填 segments / 暂存空 → entry 纯文本 → 气泡
       │      （同时照旧喂 reducer，不变）
       └─ message_start(assistant) ─★ G-023 条件清：快照深度==0 才清（QueueBubble 随深度归零消失，
                混合提交的未投递 followUp 快照存活 → 其投递时腿 1 prev 在场，F4 修复）
                ★ 新增挂点：buffer 僵尸清理（存量 > 快照深度时清残量，先读后清）

  切入 session（selectSession）─→ getHistory 快照 ─★ reconcileHistory 两步合并：
       ①尾部保护段（streaming assistant ∨ user 未确认）②user 数量对齐去重（基线已含则剔 overlay）

  pendingBuffer 生命周期：push → 两腿 drain → aborted 信号清空 / RPC 失败回滚 → disposeSession 清
                          ｜ LRU 驱逐、断连收口 = 刻意保留（不可重建状态，见 D4）
  inflight 计数：腿 1 消费 +m / send 乐观插入 +1 / message_end 确认 −1 / abort·disposeSession 清零 ★
  queueStates：入队帧/回放重建 → 腿 2 消费剔文本对齐深度 → 深度归零删 / abort 删 ★（其余清理点见 D4 豁免）
```

### 错误规格与恢复指引

| 错误/边界 | 行为 | 恢复 |
|----------|------|------|
| 腿 2 收到 message_end(user) 且 inflight > 0 | 确认抵消（inflight−1），不消费——正常路径与 send 乐观挂钩的确认通道 | 无需恢复（正常跳过） |
| 腿 2 inflight == 0 且 includes 未命中 | send 路径 → 跳过（send 文本从不在数组） | 无需恢复 |
| 腿 2 inflight == 0 且 includes 命中且暂存空（扩展 deliverAs 注入） | entry 纯文本插入（新增能力：注入消息从永不显示变为纯文本显示） | — |
| 腿 2 无快照可用（断连清了 queueStates 且重连回放未重建——入队帧被 ring 溢出冲掉） | includes 无据 → 跳过（漏显） | 切走再切回该 session，快照收敛补齐（AC-3 恢复动作） |
| 跨 mode 同文本且腿 1 全失效 | sendMode 推导误指另一 mode → 该 mode 暂存取空 → 走纯文本降级插入（内容同质、数量不差，D2 已知边界①） | 无需恢复 |
| 时序倒置（message_end 先于 drain 帧，P1 假设外） | 腿 2 先消费后 drain 帧到达，腿 1 错取下一条 | P1 降级路径：腿 1 加守卫（drain 帧处理时若本帧差集文本已被腿 2 消费——per-session 已消费文本 multiset——跳过 drainN） |
| abort 时 buffer/inflight/queueStates 清空后用户重发同文本 | pushPending 新条目 + inflight 从 0 起步，FIFO 无残留干扰 | — |
| G-023（message_start(assistant)）时快照深度 > 0（混合提交，followUp 待投递） | 快照保留，QueueBubble 持续显示待投递条目；该 followUp 投递时腿 1 prev 在场正常差集（F4 修复后的正常路径） | 无需恢复 |
| F1 场景腿 2 消费后快照残留同文本 | 消费时剔快照一个实例（D2 第 3 点），后续提交的 countDrained 不被残留污染（pi 侧镜像残留经全量帧带回的窗口见 D2 边界披露，与现状等同） | 无需恢复（剔快照内建） |
| 清理信号帧丢失（message_start(assistant) / message.complete{aborted} 被 ring 冲掉） | 显示态悬挂：QueueBubble 显示已投递/已作废条目；数据链无损（buffer/inflight 有 D3 与计数兜底） | 无需操作——下一次 queue_update 全量帧自愈或切入刷新收敛 |
| inflight 配额漂移（send 失败未回滚兜底失效 / message_end 帧被 ring 溢出冲掉） | 悬空配额错抵下一次 F1 投递的确认 → 该消息 me_end 被跳过（一次性，错抵后归零自愈，非永久失效——区别于第三版双计数的单调欠账） | 切走再切回该 session，由 D3 快照恢复补显 |
| 跨 turn 重发相同文本（D3 已知边界） | 正序-尾窗对齐可能误剔新 overlay，消息暂以基线旧版本显示（位置在历史区） | 不丢消息不重复；新 entry 落盘后下一轮 reconcile 自然收敛 |
| live 与 reload 投影差异 | **形态同构、id 异源**（live 客户端 id / 重放 uuidv7，W21 已裁决差异类）；等价性测试（apply-entry-equivalence）按字段归一断言，扩用例守卫 | 测试失败 = 设计假设错，回 D1/D2 重审 |

---

## §4 验收

> 真实依赖（dev app + 真实 pi 子进程 + 真实模型）、真实操作路径；单测只作回归护栏不作为验收。执行环境：`pnpm dev`（Electron 9222 调试端口，browser-automation 连接操作 GUI）。

**AC-1 正常追加显示（验证 G1/G2，主路径回归；本场景即 F4 混合提交——修复前 followUp 漏显是高概率结果）**
- 场景：任一真实 session，agent streaming 中（可让它读几个文件拖长时间），composer 追加一条含 `@文件引用` 的消息（steer），再追加一条普通文本（followUp）。
- 步骤：等当前回合结束、两条消息先后投递、agent 回复完成。
- 通过标准：对话流中用户气泡**总数恰为 2 且逐条内容与提交一一对应**（无多插、无错插——多提交场景是 D2 的反例重点；重点盯防 followUp 气泡——G-023 条件清修复的 F4 就是它在混合提交下漏显）；`@文件引用` 徽章正常渲染（非纯文本）；投递前后无 QueueBubble 与对话流气泡并存撕裂；QueueBubble 出现后消失（混合提交下 followUp 待投递期间持续显示、其投递后消失，属正常）；重开该 session 气泡仍在且无重复（G3）。

**AC-2 切换竞态不丢不重（验证 G4/F2，对应 D3）**
- 场景：agent streaming 中追加 steer 消息后，立即（1 秒内）切到另一 session 再切回，重复 10 轮（每轮重新触发 streaming + 追加 + 切换）；其中 2 轮改为**追加 1 条 steer + 1 条 followUp 后立即切入切回**（构造快照部分滞后窗口 n>k>0，D3 正序-尾窗对齐的命中场景——跨 mode 投递跨越 turn 边界产生真实落盘间隔，快照窗口可命中；同 mode 2 条通常同批投递、落盘间隔为同事件循环内相邻，窗口概率≈0 不可用）。
- 通过标准：10 轮全部——agent 均收到消息且回复可见，用户气泡每轮**恰好等于提交数**（无快照双计、无丢失——单条轮 1 条、双条轮 2 条，切回后逐一对照提交内容）。

**AC-2b 同文本重复与跨 mode 混合（验证 D2 计数对账，负面验证）**
- 场景：streaming 中重发完全相同的文本 2 次（同 mode steer），再以 steer 与 followUp 各提交 1 次另一相同文本（跨 mode 同文本）。
- 通过标准：4 条消息每条恰好显示一次；无"未投递先显示"（投递前 QueueBubble 计数与对话流气泡不并存）；无内容错插（对照提交顺序与内容）。

**AC-3 断连投递不丢（验证 G1/F3，对应 D1/D2）——两个子场景分列（链路不同：断 WS 走 ring 回放保序，杀 runtime 走 restore 全量重建、ring 无回放）**
- 场景 3a（断 WS，ring 回放路径）：streaming 中追加 steer；投递窗口期断开 WS（如断网/阻断 renderer↔runtime 连接）待自动重连，投递恰好发生在断连期间。
  - 通过标准：重连恢复后，agent 对该消息的回复与用户气泡都出现在对话流且无重复（ring 回放保序，两腿按帧+快照成对成立——见 §3.1 失败路径 A 的降级形态）；若气泡短暂缺失，切入切出一次后由快照补齐（恢复动作有效）。
- 场景 3b（杀 runtime，restore 重建路径）：streaming 中追加 steer；投递窗口期杀 runtime 进程触发 supervisor 重拉，session 走 restore 全量重建。
  - 通过标准：runtime 恢复、session 重连后，agent 回复与用户气泡均可见且无重复（本路径不经 ring 回放，显示由 D3 快照收敛与重放投影兜底）；若气泡缺失，切入切出一次后补齐。

**AC-4 pi 队列事件异常不丢（验证 G1/F1，对应 D1 腿 2）**
- 场景与确定性触发：**先做 1-2 轮正常 steer 追加投递**（建立正常投递历史——第三轮审查确认：无正常历史的 session 测不出计数欠账类缺陷），然后 streaming 中追加一条以 `/` 开头触发 skill 展开的长消息（pi 入队文本与提交原文不同）+ 一条含连续空行/首尾空白的消息（trim 边界），各投递。因 F1 自然发生依赖 pi splice 匹配失败（诱因待实跑，可能空转），**需构造确定性触发**：dev 构建加临时开关跳过腿 1 的 drain 消费（模拟 drain 帧丢失，真实链路其余部分不动）跑一遍，验证腿 2 独立承担显示；恢复正常构建再跑一遍回归。
- 通过标准：两遍实跑——腿 1 跳过遍：正常轮 + 测试轮的全部气泡显示且无重复（skill 展开消息允许降级为展开后纯文本——G2 降级可见），证明腿 2 在有正常投递历史的 session 上仍生效；正常遍：无重复、徽章正常。对照 `~/.xyz-agent/logs/pi-*.jsonl` 核对投递时序与 drain 帧有无。

**AC-5 abort 语义不变 + 暂存无残留（负面验证，对应 D4）**
- 场景：streaming 中追加 2 条 steer（未投递），点停止；随后正常发 1 条新消息。
- 通过标准：被丢弃的 2 条不出现气泡、QueueBubble 消失（现状语义保持）；新消息正常显示且徽章正常（FIFO 无残留错位）。

**AC-6 send 路径零回归（负面验证，对应 D2）**
- 场景：正常（非 streaming）发送 5 条消息，其中 2 条带 `@文件引用`。
- 通过标准：5 条气泡一次一条无重复（无双插）、徽章正常、重开 session 回填一致。

**AC-7 等价性守卫（G3，测试资产）**
- 通过标准：`apply-entry-equivalence` 测试族扩展用例（腿 2 插入路径 vs 文件重放路径**按字段归一**断言——id 异源不断言相等，见 D3 表述修正）全部通过；现有 live≡reload 等价性用例零回归。

---

## §5 下一层拆分

### 实施路径（两阶段，各自可独立验证/回滚）

**阶段 1（正确性核心）**：单元 1 + 2 + 4 —— 腿 2 接入与暂存生命周期，覆盖 F1/F3/F4 与 D2/D4。AC-1/4/5/6/7 验收。
**阶段 2（快照保护）**：单元 3 —— reconcile/hydrate 尾部保留规则，覆盖 F2。AC-2/3 验收。阶段 1 已显著缩小 F2 窗口（气泡插入不再依赖 drain 帧），阶段 2 消除残余。

### 拆分清单

| 单元 | 内容 | justification（为什么这么拆） | 对应验收 |
|-----|------|------------------------------|---------|
| U1 registry：`message_end(user)` 腿 2 | handler 增强：user role 时按 D2 确认制——inflight > 0 抵消跳过（含 send 乐观挂钩的确认）；inflight == 0 时 includes 兜底校验（entry.contentText ∈ 最后 queue_update 帧数组），命中消费 1 条（sendMode 由命中数组维度推导）回填 segments，暂存空则 entry 降级插入（applyEntry 空态派生构造）；未命中跳过；**消费后从快照剔命中文本一个实例**（D2 第 3 点，防残留污染后续差集） | 单一 handler 内聚一个信号源；与腿 1（queue_update handler）改动物理隔离，review/回滚边界清晰 | AC-1/2b/4 |
| U2 registry + store：queue_update 减法与 buffer/计数生命周期 | 移除投递侧 reconcilePending 裁剪；**G-023 无条件清改条件清（深度==0 才清，先读快照后清）+ 同点僵尸清理（存量 > 快照深度清残量）**；aborted 信号清 pendingBuffer **+ inflight 计数 + queueStates**；disposeSession 清计数（与 D4 计数清理挂点对齐）；腿 1 消费点 inflight += 实取数、send 乐观插入点 inflight += 1 | "减法 + 生命周期"同属暂存/计数/快照语义，与 U1（加法）分离防一次改动过大 | AC-1/5 |
| U3 store：reconcileHistory/hydrate 两步合并规则 | ①尾部保护段收集（streaming assistant ∨ user 未确认）②user 正序-尾窗对齐去重（a=min(n,k)，保护段正数第 1..a 条 ↔ 基线尾部正数第 k−a+1..k 条逐位剔除），hydrate 复用同规则 | 纯 store 层合并函数，无 handler 依赖，独立可测（构造全对齐/部分滞后/基线多含/全缺四类快照序列） | AC-2/3 |
| U4 测试资产 | apply-entry-equivalence 扩展（腿 2 vs 重放）；queue_update 减法回归；reconcile 快照滞后序列用例 | 等价性是 G3 的构造性守卫，必须与功能改动同 PR | AC-7 |

### 文件改动地图

- `packages/core/src/domain/chat/effects/registry.ts`：message_end handler（腿 2 确认制 + includes 兜底 + 消费剔快照）、queue_update handler（减法 + 腿 1 消费点 inflight 计数）、message_start（G-023 无条件清改条件清 + 僵尸清理挂点）、message.complete（abort 清 buffer + inflight + queueStates）
- `packages/core/src/domain/chat/store.ts`：drainN 调用方签名不变；新增 inflight 计数 state 与 abort 清理 action；reconcileHistory/hydrate 规则；disposeSession 清计数
- `packages/core/src/domain/chat/useChat.ts`：send 调用点 inflight 挂钩（乐观插入 +1 / catch 回滚 −1，不在 appendUser 函数内防双计）；顺带清理 :512-518 / :537-549 的 S7 过时注释（「steer 发出后立即入流」——§2 根因 3 的文档性收尾，与实现背离的注释会误导下一个读者）
- `packages/core/src/domain/chat/__tests__/` + `packages/runtime/src/__tests__/equivalence/`：测试资产
- 零改动：`event-adapter.ts`（帧已转发，无需动）、pi 任何代码、**send 显示语义**（appendUser/乐观插入流程不动，仅外围 inflight 计数挂钩）、QueueBubble 组件

### 待验证检查点（实施期门，不通过则回设计）

- **P1**：pi 0.84.4 投递时序探针——实跑确认 `queue_update(drain)` 先于 `message_end(user)` 且两者总是成对出现（支撑 D2 确认制的时序前提：drain 帧先达 → 腿 1 消费置 inflight → message_end 抵消）。方法：本地 pi rpc 模式（`pi --mode rpc` + stdin JSONL）跑 steer 投递，检查 stdout 事件序。
  - **降级路径**：若实测存在 message_end(user) 先达的序列（时序倒置）——D2 确认制在腿 2 侧仍成立（inflight==0 → includes 兜底消费），但腿 1 后达的 drain 帧会错吃下一条 buffer（乱序版多提交反例）——此时给腿 1 加对称守卫：drain 帧处理时查 per-session 已消费文本 multiset（腿 2 消费时登记），本帧差集文本已被腿 2 消费则跳过 drainN。判定机制不换、腿 1 加一处守卫，U1/U2 内部调整。
- **P2**：腿 2 includes 判定的可达性与同源性——「entry.contentText ∈ 最后 queue_update 帧数组」在 F1 场景（pi splice 失败、drain 帧不发）下确实为真，且入队文本/投递 contentText/数组文本三者在 skill 展开、模板展开、空行 trim 边界下恒等。方法：pi rpc 探针跑 `/skill` 展开与空白边界消息，比对三处文本；无 drain 帧序列构造单元测试 + AC-4 实跑交叉确认。
  - **降级路径**：若同源性在某场景破缺（三处文本不等）——该场景下 includes 不命中 → 不抵消、不消费，跳过 → 退化为现状（该消息漏显，由 D3 快照收敛兜底），G1 的已知失败模式仍被腿 1 + D4 条件清 + D3 覆盖；破缺场景记录为已知边界，等 pi 行为确认后补判定。
- **P3**：G-023 条件清的快照保真不变式——`message_start(assistant)` 时**前端最后 queue_update 帧快照深度 == pi 真实队列深度 == 未投递 followUp 数**（纯 steer/纯 followUp 场景 = 0，混合提交场景 = 在队 followUp 条数；steering 已 drain、followUp 待 turn 边界）。快照保真则条件清保留的快照真实反映待投递条目，僵尸清理读数正确。方法：pi rpc 探针多场景（纯 steer / 纯 followUp / 混合）采样，比对该时点 pi 队列 get_state 深度与最后 queue_update 帧。
  - **降级路径**：若不变式不成立——存在「pi 已清/改队列但相应 queue_update 帧未达」的常态场景（快照深度 ≠ pi 真实深度）——条件清保留的过期快照会让后续差集错算。此时快照出口后移：G-023 条件清保留 + turn 终态后主动 `get_state` RPC 读 `pendingMessageCount` 对账快照（pi session 有该 getter，agent-session.js:1207；偏差则按返回队列全量数组重建），语义不变、时点后移，U2 内部调整。
