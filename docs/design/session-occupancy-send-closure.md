# 会话占用状态统一（occupancy）与消息发送闭环

> **一句话结论**：把「会话忙不忙」从三层各自拼装的状态副本，收敛为 runtime 权威广播的单一 occupancy 投影；把「忙时发送被拒」从用户可见错误，降级为系统内部的自动排队（defer 队列）——任何时刻按 Enter，消息都有确定去向、立即可见、投递后气泡必然出现。

**层声明**：本文档是技术方案设计（下一层产物 = 可实现的协议 / 状态机 / 接口），准则 5（物理数据流）/ 6（错误恢复）/ 7（运行时断言探针）全适用。实施拆分见 §5。

---

## 1. 背景目标

**SCQA**：
- **S（情境）**：太极（Electron + Vue renderer + Node runtime + pi 子进程）中，用户在 Agent 忙碌时（上下文压缩、思考、执行命令）发送消息是高频动作。
- **C（冲突）**：这个动作的成功率与时序强相关——同样的「压缩中发消息」，有时正常排队，有时弹出「Agent 正在处理」或英文报错，有时消息发出去却没有自己的气泡，有时提示在处理但对话流毫无进行中状态。
- **Q（问题）**：为什么「忙」在用户眼里是个不可靠的概念？
- **A（答案）**：因为「忙」在系统内有三层各一份的状态副本（pi 4 个 flag / runtime 3 个 flag / renderer 5+ 个标志），靠异步事件链单向同步，同步窗口内每层对「能否发送」给出不同答案；且唯一的排队机制（compact 队列）只覆盖理想时序、重放时绕过了气泡编排。本设计收敛为：pi 保留事实分叉 → runtime 权威 occupancy 投影（state topic，重连可恢复）→ renderer 表现投影 + 统一 defer 队列 + 发送协议闭环。

**系统是什么**（为没接触过本仓的开发者）：用户在 renderer 的 Composer 输入消息，经 WebSocket 到 runtime（Node 子进程），runtime 转发 prompt 给 pi（AI agent 引擎子进程，RPC + stdout 事件流）。pi 的事件流（消息增量、turn 生命周期、compaction 生命周期）经 runtime 的 event-adapter / interpreter 翻译成 WS 广播回到 renderer 驱动 UI。「上下文压缩」（compact）是 pi 在上下文接近上限时把历史折叠为摘要的操作，期间会话不可接收 prompt。

**术语定义**（本文档反复使用，先锚定）：
- **occupancy（会话占用状态）**：一个 session 当前被什么占用——turn 三阶段（dispatching / generating / settling，见 §3.3 D3）+ 压缩 + bash，三维度组合。用户视角即「Agent 在干什么」。
- **defer 队列**：会话被占用、消息暂时无法投递时，renderer 暂存待发消息的队列；占用解除后自动投递。现状的 compactQueue（压缩期专用）是其特例。
- **pending 气泡**：消息入 defer 队列时即在对话流显示的用户气泡（半透明 + 时钟标注），投递后转正常态。
- **腿 1 / 腿 2**：现有 steer 消息气泡确认机制（[docs/design/steer-followup-user-bubble-display.md](steer-followup-user-bubble-display.md)）——腿 1 消费队列差集帧、腿 2 靠 `message_end(user)` 与队列快照文本匹配兜底。

**设计目标**（从使用者体验倒推）：
- **G1 忙时发送永不失败**：任何占用状态下按 Enter，消息都有确定去向（直发 / 追加当前回合 steer / 进 defer 队列），永不出现「忙」类报错。
- **G2 排队消息可见、可撤销、投递必达**：入队即出现 pending 气泡；可撤销；投递后气泡转正常态且重开 session 后一致（live ≡ reload）。
- **G3 进行中状态单一展示位**：对话流尾部统一活动条（压缩 / 命令 / 思考），消灭「提示在处理但界面无任何状态」。
- **G4 占用状态可恢复**：断连重连、切走再切回 session 后，占用状态与队列从快照恢复，不依赖广播时序。

**in-scope**：runtime 拒绝转译与 occupancy 状态机；`session.occupancy` state topic 协议；renderer 统一发送分发器与 defer 队列；pending 气泡；ActivityStrip 展示统一；Composer 发送位四态。
**out-of-scope**：pi 侧任何改动（AGENTS.md 红线）；steer / followUp 的 QueueBubble 短延迟展示语义（维持现状）；bash 的停止入口（现状独立按钮不动）；subagent 定向消息、fork / handoff 流程；compact 队列的跨重启持久化（defer 队列保持内存态，与 pendingBuffer 同档——会话重开由 pi entry 重放恢复已投递部分）。

---

## 2. 现状与问题分析

**首句结论**：三个用户可感知的失败（拒发不入队 / 无气泡 / 无状态提示）是同一结构性缺陷的三种表现——三层状态副本异步同步产生的时序窗口 + 排队机制旁路了气泡编排。

### 2.1 使用者视角的现状与失败模式

现状理想路径：用户看到「压缩中…」浮层 → 按钮变「排队发送」→ 点击 → 消息进 compactQueue → 压缩完成后自动重放。这条路径只在「renderer 已收到压缩广播」的时序下成立。三个真实失败模式：

**失败 A（拒发不入队）**：手动 `/compact` 后的 1~2 秒内发消息，toast 报
> `发送失败: Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.`（pi 原文，runtime 广播 message.error + renderer toast）

或 runtime 预检拒绝广播 `send.rejected`，toast「Agent 正在处理」。消息不进任何队列，需要用户重发。

**失败 B（入队无气泡）**：压缩中正常入队的消息，压缩完成重放后对话流里没有用户气泡；重开 session 后气泡才出现（live 与 reload 不一致）。

**失败 C（有提示无状态）**：turn 结束到自动压缩开始之间发消息，toast「Agent is processing」或英文报错，但对话流没有思考中 / 输出中 / 压缩中任何指示——UI 看起来空闲，系统说在忙。

### 2.2 物理数据流（两条链路 + 三个时序窗口）

发送链路与状态广播链路：

```
[发送链路]
Composer(Enter) → renderer useChat.send
  → appendUser(乐观气泡) + incrementInflight + addPendingSend
  → WS chatApi.send ──→ runtime message-dispatcher.sendPrompt
                          ├─ busy 预检: isGenerating∨isCompacting∨isBashRunning
                          │    └─ 拒 → 广播 send.rejected「Agent 正在处理」(硬编码)
                          └─ 通过 → client.prompt ──RPC──→ pi prompt()
                                   ├─ pi: _compactionAbortController 置位中?
                                   │    └─ 是 → throw "Cannot submit a prompt while compaction..."
                                   ├─ pi: _isAgentRunActive(post-run 含)?
                                   │    └─ 是 → throw "Agent is already processing. Specify streamingBehavior..."
                                   └─ 否 → 正常 turn
                     pi 抛错 → runtime catch → 广播 message.error → renderer 错误气泡 + toast

> **pi 拒绝的两组 controller（实施须区分）**：manual compact 用 `_compactionAbortController`
> （[:1469-1471](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)），
> auto-compact 用独立的 `_autoCompactionAbortController`（:1748-1750）；`prompt()` 只检查前者
> （:837）——所以 **auto 压缩期间**裸 prompt 走的是 isStreaming 分支报 "Agent is already
> processing"（:862），**manual 压缩期间**才报 "Cannot submit a prompt while compaction is in
> progress"。D2 的转译识别必须同时锁这两个字符串（见 P-2 探针）。

[状态广播链路] （决定 renderer 何时知道「忙」）
pi 内部状态变化 → stdout 事件 → event-adapter 翻译 → interpreter
  → 写 runtime activeSession flag + messageBus.publish
  → WS → renderer store（isCompacting / isGenerating / pendingSend ...）

[手动压缩的启动时序] （三个「开始拦」依次滞后 = 三个竞态窗口）
t0 用户敲 /compact ──→ runtime compact() ──RPC──→ pi compact()
t1      pi: await abort()（可秒级）→ _compactionAbortController 置位   ← ① pi 开始拒
t2      pi: emit compaction_start ──stdout──→ interpreter → runtime.isCompacting=true   ← ② runtime 开始拦
t3      interpreter 广播 session.compacting ──WS──→ renderer chatStore.isCompacting=true ← ③ renderer 开始入队
```

- **窗口 1（t1→t2）**：pi 已拒、runtime 预检通过 → 失败 A 的英文报错。
- **窗口 2（t2→t3）**：runtime 已拦、renderer 不入队 → 走普通 send → `send.rejected` → 失败 A 的「Agent 正在处理」。且此时 `useChat.send` 已 `appendUser`（[useChat.ts:442 附近](../../packages/core/src/domain/chat/useChat.ts)），`send.rejected` 处理只 `clearPendingSend` + toast（[useChat.ts:206-209](../../packages/core/src/domain/chat/useChat.ts)）——**气泡残留无人回应 + `incrementInflight` 悬空**（后续 steer 气泡确认被错抵，[registry.ts:186-221](../../packages/core/src/domain/chat/effects/registry.ts)）。
- **窗口 3（agent_end→compaction_start）**：pi 的 agent 循环 emit `agent_end` **之后**才做 post-run 收尾（retry 判定 / auto-compaction 准备，[agent-session.js:773-783, 895](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)），期间 `_isAgentRunActive=true`（`isStreaming` getter 含 post-run）。xyz runtime 收到 agent_end 即复位 isGenerating（[event-interpreter.ts:537](../../packages/runtime/src/services/session/event-interpreter.ts)）→ 预检通过 → pi 拒「Agent is already processing」→ **失败 C**。renderer 侧 turn 已收口、压缩浮层未出 → 无任何状态。

**失败 B 根因**（与窗口无关，是机制旁路）：compactQueue 的 flush 直接调 `chatApi.send` / `chatApi.steer` 裸 API（[useCompactQueue.ts:148-152](../../packages/renderer/src/composables/panel/useCompactQueue.ts)），绕过 core 发送编排器——无 `appendUser`、无 `incrementInflight`、无 `pushPending`。pi 落盘后广播 `message_end(user)`，renderer 的气泡判定双腿都不命中（[registry.ts:186-221](../../packages/core/src/domain/chat/effects/registry.ts)：inflight=0 且队列快照 includes 不命中 → 跳过），首条 send 的气泡永久缺失。

**展示层散乱**（失败 C 的另一半）：「进行中」指示分散在 6 处（compacting 浮层 / TurnMeta 思考占位 / executing bash 行 / QueueBubble / CompactQueueBadge / retry 行），各自判定各自渲染，状态归属不清晰。Composer 发送按钮的优先级链 `isActive > isCompacting`（[Composer.vue:127-146](../../packages/renderer/src/components/panel/Composer.vue)）与键盘路由 `isActive → onSteer`（[Composer.vue:426](../../packages/renderer/src/components/panel/Composer.vue)）导致「turn 内压缩」时 Enter 走 steer 而非排队（优先级倒挂）。

### 2.3 状态副本清单（根因的结构视图）

| 层 | 状态 | 置位源 | 复位源 |
|---|---|---|---|
| pi | `_isAgentRunActive`（含 post-run） | `_runAgentPrompt` | `_emitAgentSettled` |
| pi | `_compactionAbortController` | `compact()` 置位先于事件 emit（[:1470-1472](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)） | compact finally |
| runtime | `isGenerating` | sendPrompt 预检通过 | turn-end（agent_end） |
| runtime | `isCompacting` | interpreter 收 compaction_start（晚于 pi 置位） | compaction_end |
| runtime | `isBashRunning` | sendBash | bashResult |
| renderer | `isGenerating` / `isCompacting` / `pendingSend` / `queueStates` / compactQueue | 各自 WS 事件 | 各自 WS 事件 |

每层都是对的（各自生命周期管理），错在**消费方跨层各取一撮自行拼装**：Composer 拼前两个决定按钮态，useChat 拼 isActive 决定路由，MessageStream 拼 isCompacting 决定浮层。任何一层的知识滞后都让拼装结果与真实状态不符。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 1：手动压缩中发消息（最常见）**

```
用户：/compact（长会话，压缩约 30s）
  ├─ 对话流尾部活动条：◌ 压缩中…
  └─ Composer 发送位：↑（带时钟角标，title「排队发送 · ⏎」）
用户：输入「继续重构 auth 模块」+ Enter
  ├─ 对话流出现半透明用户气泡 + 时钟标注「压缩结束后发送」（hover 可见）
  ├─ 输入框清空；无任何 toast
  └─ 35s 后压缩完成 → 活动条消失 → 气泡转正常态 → Agent 开始回复（思考中… → 输出）
```

**场景 2：竞态窗口内发消息（原失败 A/C）**

```
用户：/compact 后 300ms 内立即 Enter「下一步计划」
  ├─ renderer 尚未收到压缩广播（走直发路径）→ runtime 预检或 pi 拒绝
  └─ 拒绝被转译为 send.rejected{reason:'compacting'|'processing'|'busy'（P3 前）}
     → renderer 兜底自动入 defer 队列（'compacting'；P3 起全 reason）
     → 半透明气泡出现 → 压缩完成后照常投递。全程无报错、无感知。
     （300ms 档常落在 manual compact 的 abort 进行中——controller 置位前、
       pi isStreaming 分支拦截 → 转译 'processing'，见 §2.2 controller 注记）
```

**场景 3：自动压缩期间发消息（两种触发形态，路由不同）**

pi 的自动压缩有两个触发点，占用组合不同、路由不同（「turn 活跃」的精确定义见 D6：= dispatching | generating，**不含** settling）：

```
形态 a（threshold 模式，turn 内）：Agent 正在多轮工具调用中，下一轮 LLM 调用前触发压缩
  （pi prepareNextTurnWithContext 钩子内，agent run 未结束）
  ├─ occupancy：turn=generating + compacting=true（唯一 generating+compacting 可达形态）
  ├─ 活动条：◌ 自动压缩中…（与工具调用状态并存）
  ├─ 发送位：■ stop（turn 活跃，压缩后 turn 继续跑）
  └─ 用户 Enter「补充：别忘了加测试」→ 走 steer（压缩完成后的下一次 LLM 调用前投递）
     → QueueBubble 显示队列深度（维持现有短延迟语义）

形态 b（overflow 模式 / smart-context 工具触发，turn 结束边界）：
  pi 的 compact() 第一行 await abort() 先中止在跑 turn（[:1469](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)），
  overflow 触发于 agent_end 之后的 post-run —— streaming 输出在压缩开始前已停止
  ├─ occupancy：turn=settling + compacting=true（或 turn=idle + compacting）
  ├─ 活动条：◌ 自动压缩中…
  ├─ 发送位：↑ queue（turn 不活跃）
  └─ 用户 Enter → 走 defer（pending 气泡）→ 压缩完成 + agent_settled 后自动投递
```

**场景 4：失败路径（真错误不静默）与恢复**

```
用户：defer 队列有 2 条消息时 WS 断连
  ├─ flush 的 RPC reject → toast「发送失败: 连接断开」（真错误保留）
  ├─ 2 条气泡保持半透明态，队列保留不清空
  └─ 恢复：重连后 occupancy 从 state topic 快照恢复 → 广播 idle → 自动重放成功
     若 pi 进程已死：走现有 session.exited → dead 态 → 用户重开 session（restore）后队列仍在分区，继续投递
```

**场景 5：切走再切回（状态恢复）**

```
压缩进行中用户切到另一 session 再切回
  └─ 活动条「压缩中…」+ pending 气泡 + 发送位状态全部恢复（occupancy 是 state topic，
     subscribeSession 的 stateSnapshot 回放，不依赖当时的 live 广播）
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：三层重划**（runtime 权威 occupancy + 协议闭环 + defer 队列 + 展示统一，本设计） | ✓✓ 状态单一权威、重连可恢复；「忙」彻底从用户词汇中消失；后续新占用类型（branch summary 等）只需扩状态机 | 中：shared 协议 + runtime 状态机 + renderer 投影替换 + 组件合并，四阶段可分步交付 | settling 态语义需实测校准（V8 探针门）；迁移期新旧状态源双轨需收口 | ✅ 采用 |
| **B：最小修补**（① runtime 预检补充查询 pi `isCompacting` getter ② flush 改走编排器 ③ isCompacting 入 state topic） | ✗ 只堵已发现的窗口，renderer 拼装模式保留——isActive 优先级倒挂、post-run 窗口、展示散乱依旧；下一个状态类 bug 还在原地等你 | 低：三处局部改动 | 窗口 3（post-run）堵不住——runtime 查 pi 状态需要新 RPC，pi 卡死时同样不可靠 | ❌ 否 |
| **C：pi streamingBehavior 透传**（sendPrompt 传 `'steer'` 让 pi 自动排队） | ✗ 把排队语义交给 pi，但 pi 队列只在 turn 内被消费——纯压缩后无 turn，消息滞留 steeringQueue 到下次交互 | 低（一个参数） | 被窗口 1 直接击穿：pi `prompt()` 先检查 `_compactionAbortController`（[:837](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)）**再**检查 isStreaming（[:862](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)），压缩中直接 throw，根本走不到 streamingBehavior 分支 | ❌ 否 |

**若用方案 B，§3.1 的场景会变成**：场景 2 靠「runtime 二次询问 pi」堵住（多一次 RPC 往返且 pi 卡死时不可靠）；场景 4/5 部分成立；场景 3 的优先级倒挂与失败 C 原样保留——用户仍会遇到「提示在处理但界面无状态」。

### 3.3 关键决策与权衡

**D1：占用状态的权威层 = runtime（选定）**
- **采用**：runtime 从 pi 事件流派生 occupancy（见 D3 状态机），以新增 `session.occupancy` **state topic** 广播（last-value 快照，重连 / 切回 session 自动恢复）。renderer 不再从多个原始事件拼装，只消费这一个投影。
- **被否**：renderer 派生投影（不动协议，renderer 内部建 phase）——切回 / 重连的 compacting 恢复仍靠 ring 回放（容量 1000 内可靠但语义脆弱），且「renderer 自己拼」的模式保留，下一个状态类 bug 原地复发。
- **证据**：state topic 快照机制已存在（[message-bus.ts:147-153 STATE_TYPE_KEY_MAP](../../packages/runtime/src/services/message-bus/message-bus.ts)，`session.state_changed → state_changed` 先例：重连后 Composer 工具条从快照恢复）；AGENTS.md 已登记「renderer 切换 session 后需立即消费的 session 级状态必须主动拉取，不可依赖 broadcast」——state topic 是该问题的机制化解法。
- **效果**：G4（场景 5）成立；G3 的单一数据源成立。

**D2：busy 闭环 = 拒绝转译 + renderer 兜底入队，静默（选定）**
- **采用**：runtime `sendPrompt` 的 catch 识别 pi 两类拒绝原文（manual 压缩的 "Cannot submit a prompt while compaction is in progress" 与 auto 压缩 / post-run 的 "Agent is already processing"，见 §2.2 controller 注记），分别转译为 `send.rejected{reason:'compacting'|'processing'}` 广播（**不**进 message.error 错误气泡）；**runtime 预检拒绝同样分型**：`sendPrompt` 预检命中 `isCompacting` 时广播 `reason:'compacting'`（当前硬编码 `'busy'`，[message-dispatcher.ts:115](../../packages/runtime/src/services/session/message-dispatcher.ts)），命中 `isGenerating` / `isBashRunning` 时维持 `'busy'`（多维度并存时 `isCompacting` 判定优先——threshold 形态竞态直发被拒归 `'compacting'` 以获得入队可达性，一致性审查 R1 确认）——窗口 2（runtime 先知、renderer 后知）的拒绝由此获得与 pi 转译一致的入队语义。`send.rejected` 的 payload reason 从 `'busy'` 扩展为 `'busy' | 'compacting' | 'processing'`，并新增可选 `clientUuid` 字段（renderer 发送时经 message.send RPC 透传，runtime 拒绝广播原样带回——用于 D5 flush 与 D2 兜底的来源消歧，见下）。
  renderer 兜底入队**分阶段生效**（乐观气泡 / inflight 回滚则**对全部 reason 立即生效**——回滚与入队正交，是修复 §2.2 已登记的「气泡残留 + 计数悬空」bug 的纯改善，不分阶段）：
  - **P1/P2 阶段**：仅 `reason='compacting'` 兜底入队（复用现有 compactQueue + badge 展示，flush 触发仍是 `session.compacted`——reason 与触发事件一一对应，不产生等不到触发源的队列）；`'busy'`（bash 忙等）与 `'processing'`（settling 窗口）**不入队**。呈现变化声明：这两类拒绝由现状的 message.error 英文错误气泡 + toast，变为 toast-only 的 send.rejected（中文「Agent 正在处理」，无对话流错误气泡）——反馈形态简化（不再有英文报错气泡）但仍可见，非「字面维持现状」；P3 起才进一步静默入队。
  - **P3 起**：occupancy 协议落地（flush 触发切到 occupancy idle）后，三种 reason 统一静默入队。
  兜底 handler 收到拒绝时的动作：清 pendingSend、回滚 optimistic `appendUser` 与 inflight（接管副作用见下表）；**若 `clientUuid` 命中 defer 队列已有条目则跳过**——该次发送来自 D5 flush（flush 的 S1 窗口订阅已处理失败保留），重入队会造成双条目双投递。
- **被否**：① pi streamingBehavior 透传（方案 C，被窗口 1 击穿且纯压缩后 steer 滞留）；② 保留报错 + 引导用户重试（把系统时序问题转嫁给用户）；③ **全 reason 立即兜底入队（本设计初版）——被中间态击穿**：P1/P2 阶段 flush 触发只有 `session.compacted`，bash 忙 / settling 窗口的拒绝入队后永等不到触发源，消息无限期滞留且无 pending 气泡（P2 才有）——比现状的 toast 报错更差。改为上述分阶段生效。
- **证据**：pi `prompt()` 检查顺序 `_compactionAbortController`(:837) → `isStreaming`(:862)，两处 throw 均为确定性字符串；xyz `client.prompt` 已支持第三参 streamingBehavior（[rpc-client.ts:623](../../packages/runtime/src/infra/pi/rpc-client.ts)）但方案 C 论证其不可行。
- **效果**：G1 成立（场景 2）；三个竞态窗口全部无害化——窗口 1/3 由「转译 + 兜底」收敛，窗口 2 由「预检拒绝同样转译入队」收敛。已知边界：manual compact 启动后 ~100ms 内的发送可能已进入 turn、被 pi `compact()` 开头的 `await this.abort()` 中止且不续跑（pi 文档注释明确 "Manual compaction never retries or continues the interrupted agent turn"，[:1458-1460](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)）——该消息折进压缩摘要、无独立回复，属 pi 行为边界（不可改），设计接受并在此显式登记。
- **接管副作用逐段枚举**（send.rejected 处理接管原「clearPendingSend + toast」后的责任表）：

| 原流程段 | 接管后谁负责 |
|---|---|
| `clearPendingSend`（思考占位复位） | 保留，入队路径继续调用 |
| toast「Agent 正在处理」 | **删除**（静默入队取代）；**孤儿拒绝帧兜底保留**——无未决直发记录且 clientUuid 不命中队列的迟到帧（订阅重建窗口/runtime 异常）无文本可入队，保留既有 toast 反馈（修复轮 A1：孤儿帧静默会丢用户反馈） |
| optimistic `appendUser` 气泡（窗口 2 残留） | **新增回滚**：send.rejected 时若本次 send 有未确认气泡则移除（defer 入队会插入带 defer 标记的新气泡，避免双气泡）；**editAndResend 被拒同样回滚**（修复轮 A2：写 pendingDirectSends、holdsInflight=false 不回收计数，静默兜底入队——与 send 同为 G1 闭环，编辑文本不因竞态拒绝丢失） |
| `incrementInflight` 悬空 | **新增回滚**：与气泡回滚同步 decrement，消除计数漂移 |
| message.error 错误气泡（pi 拒绝路径） | **转译后不再产生**（busy 类不进对话流）；非 busy 的 pi 错误保留现状 |

**D3：occupancy = 三维结构而非单枚举（选定）**
- **采用**：`{ turn: 'idle' | 'dispatching' | 'generating' | 'settling', compacting: boolean, bash: boolean }`。turn 维度：dispatching（prompt 已发、message_start 未到）→ generating（turn-start..turn-end）→ settling（turn-end..agent-settled，即 pi post-run 收尾期）；compacting / bash 为独立布尔（与 turn 可并存，如 turn 内自动压缩）。
- **被否**：单枚举互斥状态机（idle/thinking/generating/compacting...）——现实非互斥：generating+compacting 并存是自动压缩常态，强行互斥要么丢信息要么状态爆炸。
- **证据**：pi `isStreaming = _isAgentRunActive` 含 post-run（[:616-617](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)）；`agent_settled` 事件已被 event-adapter 翻译（`kind:'agent-settled'`，[event-adapter.ts:993](../../packages/runtime/src/infra/pi/event-adapter.ts)）且 interpreter 已有消费点（[event-interpreter.ts:379](../../packages/runtime/src/services/session/event-interpreter.ts)）——settling 态的两个端点事件（agent_end / agent_settled）链路上现成。
- **效果**：窗口 3 显式化为 settling 态（renderer 据此 defer 而非误判 idle）；新占用类型（如 branch summary）只需加维度，不动结构。
- **状态机转移表**（事件 → 转移；**成功路径**挂 interpreter 现有 handler，**失败/终止路径**挂 dispatcher / lifecycle 现有兜底复位点——pi 卡死或异常退出时 `agent_settled` / `compaction_end` 不会发出（二者只从 `_runAgentPrompt` finally / compact finally 触发，[agent-session.js:780-784, 1886](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)），occupancy 的复位**不能只依赖 pi 事件**，必须镜像现状 isGenerating 的全部兜底复位点）：

| # | 事件源（挂点） | 转移 | 类别 |
|---|---|---|---|
| 1 | sendPrompt 预检通过（runtime 本地，[message-dispatcher.ts:120](../../packages/runtime/src/services/session/message-dispatcher.ts)） | turn: *→dispatching | 成功 |
| 2 | turn-start（interpreter） | turn: dispatching→generating | 成功 |
| 3 | turn-end / agent_end（interpreter，[event-interpreter.ts:537](../../packages/runtime/src/services/session/event-interpreter.ts)） | turn: *→settling | 成功 || 4 | agent-settled（interpreter，[event-interpreter.ts:379](../../packages/runtime/src/services/session/event-interpreter.ts)） | turn: *→idle | 成功 |
| 5 | compaction-start（interpreter，现 onCompactingStateChange 挂点 :669） | compacting=true | 成功 |
| 6 | compaction-end（interpreter :733，**成功/失败/aborted 三路均复位**——沿用现有语义） | compacting=false | 成功 |
| 7 | sendBash 置位 / bashResult 复位（dispatcher 现有管理点） | bash=true/false | 成功 |
| 8 | sendPrompt catch（pi prompt 抛非 busy 错：auth / 无模型等，[message-dispatcher.ts:141](../../packages/runtime/src/services/session/message-dispatcher.ts) 现复位 isGenerating 处） | turn: dispatching→idle | **失败** |
| 9 | abort（成功路径 [message-dispatcher.ts:219-229](../../packages/runtime/src/services/session/message-dispatcher.ts) 现复位点；RPC 失败 / RpcTimeout 兜底路径 :186-208 同） | turn: *→idle | **失败** |
| 10 | session.exited / forceQuit / respawn（onSessionExit 收敛链；pi 死亡时 agent_settled 永不到达，靠此复位） | turn→idle, compacting=false, bash=false（全复位） | **失败** |
| 11 | abortBash / bash RPC 失败（dispatcher 现兜底广播 cancelled bashResult 处） | bash=false | **失败** |

  转移实现为**幂等写**（非增量状态机）：每个挂点直接写目标值并广播 occupancy，值未变化不重复广播（三维全等去重，消除 abort 兜底与 agent_settled 撞出双 idle 等无变化帧），乱序 / 重复事件不产生错误状态。表中箭头是**期望前置态**（正常时序注释）而非守卫——retry / followUp 继续跑场景（settling 态收到下一 segment 的 assistant `message_start` → turn-start）由幂等写天然覆盖（settling→generating 直接写入）。两处实现期补强（一致性审查确认，2026-09-05）：#8 的复位范围含**转译拒绝两路**（#1 先于 client.prompt 置 dispatching，转译拒绝不复位则窗口 1 的拒绝令 turn 永卡 dispatching、flush 永不触发，破坏 G2）；#3 挂 handler 抛错兜底（turn-end 事件早段帧抛错时经 interpret 兜底分支同样写入 settling，镜像 #6 的兜底体例，防 turn 卡 generating）。全部 11 个挂点在现状代码中都有对应的 flag 写点（occupancy 与现有三个 flag 同源同点写入，P3 实施时把「写 flag」升级为「写 flag + 广播 occupancy」）。

**D4：defer 队列（compactQueue 泛化）+ 入队即显 pending 气泡（选定）**
- **采用**：compactQueue 重命名并泛化为 defer 队列，入队条件从「isCompacting」扩展为「sendRoute=defer」（见 D6 路由表）；flush 触发从 `session.compacted` 事件改为 **occupancy 广播全 idle 且队列非空**。入队即在对话流插入 pending 气泡（半透明 opacity 0.55 + Clock icon + hover 标注），hover 提供 × 撤销（`remove` API 已存在，补 UI）。条目携带 clientUuid 作为气泡 id。**撤销边界**：× 仅对**未提交**条目开放（in-flight 已提交进 pi 队列的条目无法从 pi 侧撤回——撤销入口禁用，tooltip「已提交，等待投递」；滞留条目同理，pi 队列残余未来仍会投递）。**API 层设防**（修复轮 B2）：`remove` 对已提交（mode 已写）条目 no-op——记账不变量下沉，防调用方绕过 UI 移除已提交条目致 inflight 占位悬空、确认帧匹配作废。
- **被否**：① badge-only（用户已明确要求入队可见气泡）；② defer 队列持久化到磁盘（YAGNI：defer 生命周期 = 单次占用时长，分钟级；重开 session 时已投递部分由 pi entry 重放恢复，未投递部分随内存丢——与 pendingBuffer 同档取舍）。
- **证据**：steer-bubble 设计的 G1 原则「每条消息投递后气泡必然出现」；compactQueue 分区机制（useSessionScopedState）直接复用。
- **效果**：G2 成立（场景 1/4）；三个队列概念（steer/followUp/defer）各归其位：steer/followUp 短延迟（当前回合内消费）维持 QueueBubble，defer 长延迟（占用解除才投递）入流显示。

**D5：flush 走编排器语义 + 投递确认驱动（per-entry 记账），气泡转态闭环（选定）**
- **采用**：flush 不再裸调 `chatApi.send`，出队与气泡转态**由投递确认帧（`message_end(user)`）驱动**，RPC resolve 只表示「已提交」不表示「已投递」：
  1. **逐条提交**：首条经 core `useChat.send` 的等价编排（**挂 inflight** + ensureStreamSubscription + chatApi.send，appendUser 替换为 pending 气泡维持）；后续条目经 steer 等价编排（chatApi.steer，**不 pushPending**——defer 条目的入流已由入队时的 pending 气泡承担）。**flush 重入**（前次提交部分在途时队列再次触发 flush）：存在在途提交或 turn 活跃 → 全部并入 steer 通道（防活跃 run 上重复 send 双投递，实现期演化，审查确认）。
  2. **提交判定**：每 await 一条 RPC 后查该条是否触发 send.rejected（S1 窗口订阅标志，WS FIFO 保证 broadcast 先于 reply）——触发 → 未实际投递，条目留队首、停止提交后续，**并同步 `decrementInflight` 回滚该条目占位计数**（重试提交时重新挂——占位的挂/收/回滚三态闭环，杜绝悬空计数错抵后续 steer 确认，即 §2.2 窗口 2 要消灭的计数漂移经占位通道重生）；未触发 → 条目进 **in-flight 确认表**（未出队，气泡保持 pending）；RPC reject → 留队 + 同步回滚占位 + **原始错误上抛**（doFlush 三态契约：true=提交完成 / false=S1 未投递静默自愈 / reject=传输级真错误，反馈由 useChat occupancy handler 统一 toast「发送失败： {原因}」——修复轮 A1，错误反馈集中在编排层）。
  3. **确认驱动出队与转态**（判据 = `message_end(user)` 到达 = pi 已注入并落盘 = 真投递；**匹配基准 = defer 队列分区本身**——renderer 本地状态（useSessionScopedState），断连收口 / LRU 驱逐均不清除，对齐 steer-bubble 设计 D 节已确立的 pendingBuffer / inflight 豁免惯例。**不依赖** inflight 计数与 queueStates 快照这两个载体——计数无身份、快照断连可清，均非可靠确认载体）：
     - **单一确认机制**：`message_end(user)` 帧的 content 文本与 defer 分区**已提交**条目做 **FIFO 文本匹配**（最早的同文本条目优先；仅已提交条目参与——未提交条目不可能产生确认帧，防被同文本他帧误配出队致投递必达破坏）→ 命中 → 该条目转态（pending→正常）+ 出队 + `removeQueuedTextFromSnapshot` 剔一个同文本实例（若快照含该文本，维持 queueStates 与 pi 队列对账）+ **仅当命中条目是 send 条目时 `decrementInflight` 回收其占位计数**（steer 条目不挂占位，命中不动计数——无条件 decrement 会对纯计数做多余扣减）；帧消费终止；未命中 defer 分区 → 落入现有处理链（见下）。
     - **message_end(user) 处理序（三分支优先级，单一入口内）**：① defer 分区 FIFO 匹配（上述，新增）；② inflight > 0 → 纯计数 decrement → return（**现有路径零改动**——恢复计数语义，不作出队信号）；③ 腿 2 快照 includes 命中（**现有正常 steer 路径零改动**，defer 帧未命中 ① 时的数量守恒兜底：drainN 无货则降级 appendUser，帧不丢气泡不丢）。
     - defer send 条目挂 inflight **占位**（防帧被 ② 误拦后漏配——若不挂，在途直发消息的计数会错抵本条帧）；steer 条目不挂（其文本在 pi queue_update 快照内，③ 是兜底）。
     - **同文本碰撞的守恒声明**：defer 条目与正常 steer / 直发消息同文本并存时，① 的 FIFO 匹配可能把别人的帧配给 defer 条目（归属互换）——但每条 pi 落盘消息最终恰对应一个气泡（转态复用或 ③ 的 appendUser / 降级插入），defer 队列 / queueStates / pendingBuffer 三方按「① 命中即剔一个快照实例」保持数量守恒（守恒由路径分流自动保证：帧数 = 落盘实体数，每帧恰被 ①/②/③ 之一消费一次；暂存侧无需额外交互动作），同文本视觉不可区分，无用户可见差异。
  4. **滞留边界兜底**（同一机制，无需特判）：turn 在下一迭代前 abort / LLM error 时 pi 不 drain steeringQueue（agent-loop :189-192），消息滞留 pi 内存队列——deferred 气泡保持 pending、**defer 分区条目保留（本地态，断连也不清）**（pi `abort()` 不清队列，steer-bubble 设计 Gate B 已核实），未来任一 prompt 的迭代边界 drain 投递时 `message_end(user)` → ① 命中 → 转态收口。断连清 queueStates 快照不影响此路径（匹配基准是 defer 分区，非快照）。
- **被否**：① 维持裸 API 调用（失败 B 根因，双腿都不命中）；② E2 整队保留重发（初版沿用）——被双投递击穿：部分成功重发已投递条目 → pi 重复 + 双气泡；③ **RPC resolve 即出队+转态（第 2 版）——被「入队≠投递」击穿**：pi `steer` resolve 仅表示消息进入**内存** steeringQueue（[agent-session.js:1016-1024](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js) 无落盘），落盘发生在迭代边界 drain（agent-loop.ts:172-181）；abort/error 提前收口（不 drain）时消息滞留 pi 内存而 renderer 已显示已投递 → 重开 session 气泡消失（live≠reload）、关 app 消息彻底丢。send 首条虽然 resolve≈投递（prompt reply 在 preflight 成功时即随 agentLoop 入口落盘，[rpc-mode.js:298-316](../../node_modules/@earendil-works/pi-coding-agent/dist/rpc/rpc-mode.js)），仍统一走确认驱动消除判据分叉；④ **inflight 抵消 FIFO 驱动出队 + 腿 2 快照命中分支内嵌确认（第 3 版）——被「确认载体不可靠」双重击穿**：inflight 计数无身份（registry.ts:188-191 纯计数，帧不携带归属），滞留场景下用户直发消息的确认帧会误驱动队首 steer 条目转态出队，连锁产生「未投递先显示已投递」窗口与双气泡；queueStates 快照断连收口即清（steer-bubble D 节现状），长断连 / ring 冲刷后重建缺失时确认通路断链，已投递消息气泡永久 pending。改为 defer 分区文本 FIFO 匹配（本地态、有身份、不可清）单一载体。
- **证据**：registry.ts:186-221 双腿判定（腿 2 消费点为 steer 条目的自然确认通路，扩展复用而非旁路）；E2 现语义见 [useCompactQueue.ts:153-156](../../packages/renderer/src/composables/panel/useCompactQueue.ts)；pi steer/落盘时序见上。
- **效果**：失败 B 消除；live ≡ reload 恢复（转态时点 = pi entry 落盘时点，live 与 reload 的消息存在性恒一致）；部分失败不重发已投递条目；滞留消息有兜底路径不丢。与 D2 消歧：提交携带 clientUuid（条目 id），D2 兜底 handler 见 uuid 命中队列即跳过重入队，同一拒绝帧不双消费。

**D6：renderer 统一发送分发器（选定）**
- **采用**：Composer 的 onSend / Enter / Alt+Enter 全部汇入单一分发器，按 sessionPhase（occupancy 的 renderer 投影）查路由表。**先显式定义**：「**turn 活跃** = turn ∈ {dispatching, generating}」（settling 是收尾不是活跃 turn——pi `compact()` 会先 abort 在跑 turn，`agent_end` 后 post-run 中的续跑由 `agent_settled` 收口；「generating + compacting 并存」仅在 threshold 模式 turn 内压缩可达，见 §3.1 场景 3 形态 a）：

| # | sessionPhase（由 occupancy 派生） | sendRoute（Enter） | 发送位 | 活动条 |
|---|---|---|---|---|
| 1 | 全 idle | direct（直发） | ↑ send | （无） |
| 2 | turn=dispatching 或 generating（无 compacting） | steer | ■ stop | ◌ 思考中… / streaming 本体 |
| 3 | turn=generating + compacting（threshold turn 内压缩） | steer（turn 将继续，压缩后的 LLM 调用前投递） | ■ stop | ◌ 自动压缩中… |
| 4 | turn=settling（无论是否 compacting；极短窗口） | defer | settling 单独 → ■ stop；settling+compacting → ↑ queue | ◌ 思考中… / 自动压缩中… |
| 5 | turn=idle + compacting（manual / overflow / 工具触发） | defer | ↑ queue | ◌ 压缩中… / 自动压缩中… |
| 6 | bash=true 且 turn=idle | defer | ↑ queue | ◌ 正在执行命令… |

  路由判定的实现顺序即优先级：先看 turn ∈ {dispatching, generating} → steer（行 2/3）；否则任一维度忙（settling / compacting / bash）→ defer（行 4/5/6）；否则直发（行 1）。**投影 RTT 窗口注记**（实现期演化，审查确认）：本地 send 的乐观置位先于 occupancy 广播（RPC RTT 窗口），turn 维度判定取 occupancy 投影与本地乐观视图的**并集**（投影 idle 而本地有在途 send 时按 dispatching 处理），防窗口内 Enter 被守卫拦死（死键回退）；失配的毫秒级窗口落 direct 由拒绝兜底入队自愈，settling/compacting/bash 维度无本地乐观源、由权威帧独占。settling+bash 组合 D6 表未单列，按行 5/6 同构（turn 不活跃 + 任一维度忙）归 queue。settling 的 sendRoute=defer 理由：settling 无 compacting 时极短（P-1 探针校准），defer 后 idle 即 flush ≈ 直发无损；settling+compacting（overflow 常态）时 defer 等 `agent_settled` 后投递，语义单一。（alt+Enter 的 followUp 语义同样经分发器；`/`、`!` 前缀命令在 defer 态的拒绝 toast 保留——命令无法延迟重放，文案按占用维度中性化，见 §3.5。）
- **被否**：① 维持 Composer / onKeydown 各自判断（优先级倒挂根因）；② **本设计初版路由表（「turn 活跃」未定义 + 隐含「手动压缩可与 generating 并存」的错误假设）——被 pi 事实击穿**：pi `compact()` 第一行 `await this.abort()`（[:1469](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)）先中止在跑 turn，手动压缩与 generating 并存不可达；overflow 触发于 agent_end 后的 post-run，是 settling 不是 generating。初版场景 3 的「streaming 中自动压缩 + stop」前提错误，已按 threshold / overflow 两形态重写。
- **效果**：场景 3 成立；发送行为与发送位视觉从同一张表派生，不再漂移。

**D7：展示统一 = ActivityStrip + 发送位四态（选定）**
- **采用**：对话流尾部合并三处进行中指示为单一 ActivityStrip 组件（数据源 = sessionPhase，纵向堆叠、优先级 compacting > bash > generating > thinking；视觉沿用现有 system-notice 形态：spinner + `--text-xs` + hairline）。TurnMeta 的 dispatching「思考中…」占位迁入；CompactQueueBadge 独立行移除（pending 气泡 + QueueBubble 承接）；compacting / executing bash 行迁入。发送位四态见 D6 表。
  **终态注记**（修复轮 B1/审查偏差 17，实现为权威）：实际优先级链 = compacting > bash > thinking/settling（thinking 与 settling 互斥同档，settling 行为 P-1 校准点、文案复用 dispatching key）；**generating 不渲染独立行**——由 TurnMeta streaming 本体承担（D6 活动条列语义，避免双指示）。
- **被否**：仅统一压缩相关（用户已选「全部统一」；同类分散只解决一半下次复发）。
- **接管副作用**：TurnMeta 占位迁移后 `useNoticeStack.forkNoticeBaseTop` 的定位基线变化——迁移时实测 fork notice 定位并同步 `COMPACTING_NOTICE_HEIGHT` 常量与 dev 断言；CompactQueueBadge 的 i18n key 与测试同批清扫（符号删除清扫纪律，C-proc-10）。
- **效果**：G3 成立（场景 4/5）。

### 3.4 协议与数据模型

```
// shared/protocol.ts 新增
ServerMessageType += 'session.occupancy'
ServerMessageMap += {
  'session.occupancy': {
    sessionId: string
    turn: 'idle' | 'dispatching' | 'generating' | 'settling'
    compacting: boolean
    bash: boolean
  }
}
'send.rejected' payload reason: 'busy' → 'busy' | 'compacting' | 'processing'（后两者新增，
  标识「pi 侧拒绝经转译」；renderer 对三种 reason 的兜底入队分阶段生效（见 D2），'busy' 兼容存量）
'send.rejected' payload += clientUuid?: string（renderer 发送时经 message.send RPC 透传，
  runtime 拒绝广播原样带回——D2 兜底与 D5 flush 的来源消歧依据）

// message-bus TOPIC_TABLE / STATE_TYPE_KEY_MAP
'session.occupancy': 'state'          // state topic：分配 seq + 写快照（last-value）+ 不入 ring
'session.occupancy': 'occupancy'      // stateSnapshot key，重连/切回回放恢复

// session.compacting / session.compacted 保留（compacting 维度的事件源 + 浮层 reason 文案），
// renderer isCompacting 改由 occupancy 派生（单一来源），setCompacting 通路废弃。
// 注：session.compacting 保留 reason 文案源职责（浮层/活动条区分手动·自动压缩），
// 占用 membership 由 occupancy 派生——事件未整体废弃。断连收口删除 occupancy 分区
// （回落全 idle），重连由 state topic 快照恢复。
```

### 3.5 错误规格表

| 错误场景 | 呈现 | 恢复指引 |
|---|---|---|
| busy 拒绝（reason=busy/compacting/processing，含三窗口） | 静默入 defer 队列 + pending 气泡 | 自动：occupancy 回 idle 时 flush |
| flush 时 WS 断连（RPC reject） | toast「发送失败: {原因}」；气泡回 pending、队列保留 | 自动：重连后 occupancy 快照恢复 → idle 广播 → 重放 |
| flush 时 pi 进程死亡 | 现有 session.exited 链路（dead 态提示） | 手动：重开 session（restore 历史完整）后队列分区仍在，idle 时续投 |
| pi 抛非 busy 错误（模型/auth 失败等） | message.error 错误气泡 + toast（现状保留）；occupancy 经转移 #8 即时回 idle | 按错误内容处理（换模型 / 重新登录） |
| **占用中 pi 死亡**（occupancy 非 idle 时进程退出） | 转移 #10 全复位 + 现有 session.exited 链路（dead 态提示）；活动条消失、defer 队列分区保留 | 手动：重开 session（restore 历史完整）→ idle → 队列续投 |
| **压缩失败 × defer 队列**（compaction_end{error} 后队列有消息） | compacting 经转移 #6 复位（三路均复位）→ occupancy 转 idle → flush 照常投递。行为变化声明：与现状「failed 不 flush」不同，新设计消息**会**投递到未压缩的近满上下文，可能触发 pi 的 pre-prompt auto-compact（[:895](../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js)）由其自治处理；压缩失败本身已有 message.error 气泡提示可重试 | 消息不丢优先；用户可 /compact 重试 |
| **defer steer 条目滞留**（提交后 turn abort/error，pi 不 drain steeringQueue） | 气泡保持 pending、defer 分区条目保留（本地态，断连不清；非错误态）；消息在 pi 内存队列不丢 | 自动：未来任一 prompt 的迭代边界 drain 投递时经 defer 分区 FIFO 匹配收口（D5.4，匹配基准不依赖 queueStates 快照） |
| **message_end(user) 帧永久丢失**（订阅断连窗口 + ring 冲刷级长断连，回放无帧可补） | send 条目占位计数悬空不可自愈：最坏吞一条后续 steer 的腿 2 兜底确认（腿 1 主路径独立覆盖气泡显示，QueueBubble 深度靠 G-023 僵尸清理收敛）——**已知边界非新 bug**；该场景 defer 气泡内存态本身一致失败（out-of-scope 已声明同档取舍） | 常规断连由 ring 回放补帧自愈；ring 冲刷级属极端场景，接受 |
| defer 队列消息含 `/` 或 `!` 前缀 | 拒绝入队 toast「会话占用中，命令请等待完成后使用」（占用维度中性措辞——defer 面含 compacting/bash/settling，压缩专用文案在 bash 场景误导用户；pending 气泡 hover 标注同步泛化为「占用结束后发送」） | 占用结束后直接执行命令 |
| occupancy 广播丢失（极端） | renderer 维持旧投影；state topic 快照在下次 subscribe 时收敛 | 自动（last-value 语义） |

### 3.6 运行时断言与探针

- ✅ 已核实（本设计前，源码级）：pi `prompt()` 双拒绝分支与顺序（agent-session.js:837/:862，manual 走 compaction controller、auto 走 isStreaming 分支——两组 controller 见 §2.2 注记）；pi 手动 `compact()` 先 `await abort()` 再置位再 emit（:1469-1471）；`agent_settled` 已接入 event-adapter（:993）/ interpreter（:379）；state topic 快照机制（message-bus.ts:147）。
- ⛔ 实施期门（探针不过则对应断言不成立，回改设计）：
  - P-1 settling 时长分布：本地真实长会话跑 20 个 turn，统计 agent_end→agent_settled 间隔。若 P95 > 2s 且常态出现，settling 的「stop 按钮 + 思考中」展示需重审（可能需要 pi 侧信息补充——但 pi 不可改，改为接受长 settling 并在活动条显示「收尾中…」）。
  - P-2 转译识别率：pi 拒绝错误文案若跨版本变化（npm 0.84.4 → 未来 bump），识别失效退化为普通 message.error——探针断言锁**两个**字符串（"Cannot submit a prompt while compaction is in progress" 与 "Agent is already processing"，分别对应 manual / auto 路径，见 §2.2 controller 注记）并写进 `check-pi-semantics.mjs` 的语义探针族（版本 bump 门禁，C-proc-08）。
  - P-3 occupancy 广播延迟：sendPrompt 置 dispatching 到 renderer 收到 occupancy 帧 ≤ 100ms（PRODUCT.md「状态即信任」红线）。超标查 WS 广播链路。

---

## 4. 验收

> 全部场景在真实环境执行：`pnpm dev` 起完整 Electron + runtime + 本地 pi（`xiaomi-token-plan-cn/mimo-v2.5-pro`），使用真实长会话（≥50 turn，上下文 ≥60% 窗口）。禁止 mock WS / mock pi。

**V1 手动压缩中发消息（验证 G1/G2，场景 1）**
步骤：长会话执行 `/compact` → 压缩指示出现 → 发送位为 queue 态 → 输入消息 Enter。
通过标准：① 无任何 toast / 错误气泡；② 对话流 2s 内出现半透明用户气泡（带时钟标注）；③ 压缩完成后 ≤5s 气泡转正常态且 Agent 开始回复该消息内容；④ 全程对话流有压缩指示（阶段归属：P2 验收时为现状 compacting 浮层；P4 后为 ActivityStrip 活动条——两个阶段分别截图比对即可）。

**V2 竞态窗口发送（验证 G1，场景 2——回归原失败 A/C）**
步骤：脚本驱动（Playwright 连 9222）：`/compact` 发出后 300ms / 800ms 两档各发一条消息。
通过标准：两档全部无 toast、无英文错误气泡；消息以 pending 气泡呈现并在压缩完成后投递（P1/P2 阶段为 badge 呈现，P3 后 pending 气泡）。
（~100ms 档**不进验收**：该档可能命中「prompt 已入 turn → pi `compact()` 开头 `await abort()` 中止且 manual compact 不续跑 → 消息折进摘要无独立回复」的 pi 行为边界（D2 已登记为已知边界，pi 侧不可改）；边界行为由实施期在真实会话记录一次实际表现，作为文档边界的佐证而非验收判据。）

**V3 多条入队 + live ≡ reload（验证 G2，回归原失败 B）**
步骤：压缩中连发 3 条 → 等压缩完成 → 重开该 session（关闭重进）。
通过标准：① 3 个 pending 气泡按发送序排列；② 投递按序（逐条记账：首条 send 起轮、后两条 steer 并入）；③ 重开后 3 条气泡全部为正常态、内容一致、无重复无丢失。
（两个部分失败回归，实施后在测试 hook 下构造：a) 第 2 条 steer RPC 失败 → 断言第 1 条已转态且不被重发、第 2/3 条保留重投；b) 第 2 条 steer 已提交但 turn 被 abort（pi 不 drain）→ 断言第 2 条气泡**保持 pending**（不误转态，入队≠投递）、第 1 条正常；随后用户直发一条**不同文本**的新消息触发 drain → 断言第 2 条仍 pending（直发帧的 inflight 抵消不误配，D5.3 处理序 ① 文本匹配不命中）→ 第 2 条被 drain 投递后经 defer 分区匹配转态收口——确认驱动身份关联的正向 + 反向验证。）

**V4 自动压缩期间发消息（验证 G3 + D6 路由，场景 3 两形态）**
- V4a（threshold / turn 内压缩，steer 路由）：步骤：关闭 smart-context（设置页，回到 pi 原生 threshold 行为）→ 调低 pi compaction 阈值（**xyz 设置页无此入口**，需直接改 pi 自身 settingsManager 的 settings 文件，具体路径实施期确认并登记）→ 多轮工具调用任务中触发 turn 内压缩 → 压缩期间 Enter 发追加消息。构造条件注明：threshold 形态要求**上一 turn 结束时未超阈值、本 turn 进行中被工具输出推过**——若上一 turn 结束时已超，post-run `_checkCompaction` 先触发、落入形态 b（V4a 会空转；构造方法与实际命中形态在实施期记录，若实测难以稳定构造 threshold 形态，V4a 降级为「机制审查 + 源码时序断言」并登记）。通过标准：① 压缩指示显示「自动压缩中…」（阶段归属：P3 验收路由行为 ③④；①② 的活动条/发送位形态是 P4 视觉断言）；② 发送位为 stop（同 P4）；③ 消息走 steer（QueueBubble 显示）且在压缩完成后的下一轮 LLM 调用被消费（回复体现追加内容）——P3 断言；④ **不出现** pending 气泡（steer 分档正确）——P3 断言。
- V4b（overflow / smart-context 工具触发，turn 结束边界，defer 路由）：步骤：恢复 smart-context 默认配置 → agent 自决调 compact_context（调低提醒阈值诱导）→ 压缩期间 Enter 发消息。通过标准：① 压缩指示「自动压缩中…」（P4 视觉）；② 发送位为 queue（P4 视觉）；③ 消息出现 pending 气泡，压缩完成 + turn 收口后自动投递（P3 断言）；④ 无任何 toast（P1/P2 起即断言）。

**V5 状态恢复（验证 G4，场景 5）**
步骤：压缩中切到另一 session 5s 再切回；再压缩中断开 renderer WS（devtools 断网模拟）3s 恢复。
通过标准：两种情况后活动条、pending 气泡、发送位状态与离开前一致。

**V6 真错误不静默（负面验证，两档）**
- V6a（flush 在途断连）：步骤：defer 队列非空 + 占用中 → 脚本在 occupancy 转 idle 触发 flush 的**瞬间**断开 renderer↔runtime WS——断连时机必须命中 flush RPC 在途（队列非空的稳定态是占用中，idle 即刻 flush，错开时机测不到 RPC reject 路径）。可操作手法：CDP 监听 WS 帧收到 `session.occupancy{全 idle}` 即调 `page.context().setOffline(true)`（P3 后 occupancy 帧存在；P1/P2 阶段可用 runtime 侧临时 flush 延迟 hook 拉宽窗口）。通过标准：① 出现「发送失败: {连接原因}」toast；② 气泡保持半透明、队列保留；③ 恢复网络后 WS 重连 → occupancy 从 state topic 快照恢复 → 自动重放成功（renderer 全程不重启，内存队列不丢）。
- V6b（占用中 pi 死亡）：步骤：压缩进行中 kill pi 子进程。通过标准：① session.exited → dead 态提示（现有链路）；② 活动条消失（转移 #10 全复位，不卡「压缩中…」）；③ 重开 session（restore）后 defer 队列分区仍在、idle 后续投。

**V7 撤销（验证 G2）**
步骤：pending 气泡（未提交态——flush 前）hover → 点 ×。
通过标准：气泡消失；压缩完成后该消息不被投递；其余队列消息不受影响。已提交（in-flight）条目的 × 禁用（tooltip「已提交，等待投递」）。

**V8 settling 探针（运行时断言门，P-1）**
步骤：真实会话 20 turn 采集 agent_end→agent_settled 间隔分布。
通过标准：P95 ≤ 2s（否则按 P-1 回改展示设计后再过）。

---

## 5. 下一层拆分

**实施路径**：四阶段串行交付，每阶段独立可验收 / 可回滚。P1+P2 消除用户痛点（不依赖协议），P3 兑现长期架构，P4 展示收口。

| 阶段 | 内容 | 主要文件改动 | justification | 独立验收 |
|---|---|---|---|---|
| **P1 发送协议闭环** | runtime 拒绝转译（双字符串 → reason 分型）+ send.rejected reason/clientUuid 扩展 + renderer 对 **reason='compacting'** 兜底入队（复用现有 compactQueue + badge；'busy'/'processing' 维持现状 toast——中间态不恶化，见 D2 分阶段） | runtime: message-dispatcher.ts（catch 转译）；shared: protocol.ts（reason 联合类型 + clientUuid 字段 + message.send RPC 透传）；renderer: core useChat.ts（send.rejected handler 改造：compacting 入队 + 乐观气泡/inflight 回滚 + clientUuid 消歧） | 窗口 1（manual 压缩竞态）的用户可见症状由此消除且不依赖 occupancy 协议；窗口 3（settling）与 bash 忙的兜底**必须等 P3 的 occupancy idle 触发**，提前全量入队会静默丢消息（D2 被否③） | V2 / V6a |
| **P2 defer 队列 + pending 气泡** | compactQueue 改名 deferQueue + **flush 机制重写**（投递确认驱动 + per-entry 记账，D5 全量：核心 = message_end(user) 处理序三分支——defer 分区 FIFO 文本匹配优先于现有 inflight 计数与腿 2，后两者零改动）+ pending 气泡组件 + 撤销（未提交态）。**入队条件本阶段仍仅 compacting**（与 P1 一致——sendRoute 全量路由是 P3 产物，提前扩到 settling/bash 会让队列等不到 flush 触发，见 D2 被否③）；flush 触发仍为 session.compacted | renderer: useCompactQueue.ts（重构+改名，符号清扫按 C-proc-10 批量同步 docs 与测试）、useChat.ts、Message/气泡组件、i18n；core: chat/effects/registry.ts（message_end(user) 入口挂三分支处理序） | 失败 B 修复（确认驱动 + 编排器语义）独立于协议；pending 气泡让队列可见性先到位 | V1 / V3 / V7 / V3 两个回归（部分失败 + 滞留边界） |
| **P3 occupancy 状态机 + 协议** | shared 协议 + message-bus state topic + interpreter 状态机（**十一挂点**：成功路径 #1-7 挂 interpreter，失败路径 #8/#9/#11 挂 message-dispatcher、#10 挂 lifecycle/onSessionExit 收敛链，见 D3 表）+ renderer sessionPhase 投影（替换 isActive/isCompacting 拼装，发送分发器 D6 落地；flush 触发切 occupancy idle；D2 兜底扩到全 reason） | shared: protocol.ts；runtime: event-interpreter.ts、message-bus.ts、message-dispatcher.ts（#8/#9/#11 挂点 + bash 维度 #7）、session-service / lifecycle（#10 session.exited/forceQuit/respawn 全复位）；renderer: chat store 投影、composer dispatch | 协议改动全链路一次到位；renderer 拼装模式的替换以 occupancy 可用为前提 | V4 / V5 / P-3 |
| **P4 ActivityStrip 展示统一** | 三处指示合并 + 发送位四态 + TurnMeta 占位迁移 + CompactQueueBadge 移除 + fork notice 基线核对 | renderer: MessageStream.vue、useMessageStreamNotices.ts、ActivityStrip（新）、Composer.vue、useNoticeStack.ts | 展示层收口依赖 P3 的 sessionPhase 单一数据源 | V4 / V5 视觉断言 |

**待验证检查点**（设计阶段无法确定，诚实留给实施期）：
- P-1 settling 时长分布（V8）——settling 展示形态的最终校准。
- P-2 pi 拒绝文案的版本稳定性（双字符串探针写入 check-pi-semantics 后持续受门禁保护）。
- fork notice 定位基线迁移（P4 实施时实测）。
- V2 ~100ms 档的「prompt 已入 turn 被 manual compact 中止、不续跑」实际表现——pi 行为边界（D2 已登记），实施期真实会话记录一次作佐证，不进验收判据。
- V4a threshold 形态的构造方法（pi settings 文件路径 + 「上一 turn 未超阈值、本 turn 内推过」的稳定构造），实测难构造则降级为机制审查 + 源码时序断言。
- 转移 #10（session.exited 全复位）与 respawn 后 occupancy 初值的衔接（P3 实施时定：respawn 恢复的 session 从 idle 起步还是拉取 pi 实际状态——pi 重 spawn 后无活跃 run，idle 起步即可）【Gate B 反例已修复 2026-09-06】：原判定「实施确认无反例」被 V6b 端到端证伪——renderer 的 session.exited 兜底 handler 同步失效本地订阅（invalidateStreamSubscription），随后到达的转移 #10 idle 帧被丢弃，occupancy 分区残留 stale compacting=true；dead 占位吞掉消息流使其暂不可见，restore 后 stale 显形且永无帧修正（bus 快照已随 clearSession 清空、registerSession 不发帧），flush（触发条件 = 收到全 idle 帧）永不触发，defer 队列滞留至 runtime 重启。修复：registerSession 注册汇聚点显式 publish occupancy idle 宣告帧（写 state 快照 + 重订阅回放必达；不走 updateSessionOccupancy——初值即 idle 会被全等去重短路），respawn 后 idle 起步的 renderer 可观测性由宣告帧保证，不再依赖「无帧 = idle 缺省」假设。V6b 端到端重验 pass（压缩中 kill pi（compact failed elapsed=6.4s 命中压缩中）→ dead → 重新打开 → 无压缩行 + 发送位 idle + 队列消息自动续投）。
- `removeQueuedTextFromSnapshot` 对「快照中不存在的实例」的幂等性【已核实 2026-09-05 u4a 期】：includes→filter 模式天然幂等——无快照/无维度/idx===-1 三处早退，命中后 filter 不可变写，对不存在实例调用 no-op 不抛错；ID1-ID3 单测锁定（effects-defer-confirmation.test.ts）。

**迁移期双轨收口**：P3 落地前 renderer 仍消费 session.compacting/compacted（P1/P2 兼容现状）；P3 落地时 isCompacting 判定切到 occupancy 派生、setCompacting 通路废弃；P4 清理 TurnMeta 占位与 CompactQueueBadge。全程每阶段结束跑受影响模块增量测试 + 上述对应验收场景。
