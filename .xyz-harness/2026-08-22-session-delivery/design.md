# Session 消息投递层统一设计（delivery kernel）

> **一句话结论**：不新建任何 mailbox 通道——pi 0.84.1 的投递原语（`sendMessage`/`prompt(streamingBehavior)`）已经完整；要统一的是散落在 5 处的「投递时状态冲突处理」策略，收敛为一个零 pi 依赖的策略内核包 `@xyz-agent/session-delivery`（packages 层），extension 与 runtime 两侧各做薄装配。内核对外讲**投递意图**（intent），pi 词汇（steer/followUp/streamingBehavior）封闭在两侧适配器内；冲突解决以 `agent_settled` 事件驱动为主、退避轮询兜底。session-manager 的 send 排队与子 session 完成回流是第一批新消费者。

**层声明**：本文档是**技术方案层**设计——下一层产物是实现单元（包接口 + 迁移步骤），不跨到具体实现代码。涉及运行时行为/数据流/错误处理，红线准则 5/6/7 全适用。

---

## 1. 背景目标

### SCQA

- **Situation**：xyz-agent 里「把一条消息送进某个 session 的 LLM 上下文」这个动作，现在有 5 处独立实现（subagent-workflow 通知器、scheduler 派发、workflow 完成通知、compact 队列重放、MessageDispatcher 用户消息），每处都自己解决了同一组问题：目标 session 正在 streaming 怎么办、idle 时怎么唤醒、怎么防丢防重。
- **Complication**：这些实现的竞态知识靠注释互相引用对齐（如 notifier 里写着「与 workflow helpers.ts:151 同语义对齐，commit d214d0d83」），不是靠共享代码。历史上同一类坑在不同包里各自复发（followUp 永远排不上、agent_end→finishRun 窄窗口丢消息）。session-manager（agent-managed session）即将新增两个投递场景——send 排队、子 session 完成回流——不统一就会复制出第 6、7 份实现。
- **Question**：如何给「向 session 投递消息」提供一个统一入口：调用方声明投递意图（turn 边界抢占 / run 结束后注入），内部处理与目标 session 运行状态的冲突，idle 时唤醒？
- **Answer（本设计的）**：策略内核包放 packages 层（两侧可消费），窄端口注入运行时能力（isIdle / hasPendingMessages / send / 可选 subscribeSettled），调用方只声明 intent；intent → pi 参数的翻译在适配器内（extension 侧 `pi.sendMessage`、runtime 侧 `RpcClient.prompt(streamingBehavior)`）；现有 5 处实现逐个切换。

### 系统是什么（受众假设：会用 xyz-agent 但不了解投递内幕的开发者）

xyz-agent 的一个 session = 一个 pi 子进程（runtime 经 RpcClient 持有）。**「投递」指把一条消息注入某 session 的 LLM 上下文**——区别于「写盘」（appendEntry，不进 LLM）。

一个 session 的运行状态决定投递时机：

- **idle**（无 run 进行中）：消息可作为新 turn 的 prompt，立即被 LLM 处理。
- **streaming**（run 进行中）：消息不能直接进上下文，只能入队，等 turn 边界（steer 队列）或整个 run 结束（followUp 队列）再注入。
- **特殊窗口**：run 刚结束但 runtime 侧状态标志尚未翻转（agent_end → finishRun 窗口，毫秒级）：此刻探测「busy」会误判，直接入队可能无人消费。

两类投递者（进程位置不同，能力不同——这是本设计最重要的结构性事实）：

- **extension 层**（与 pi 同进程）：可用 `pi.sendMessage(custom message, {triggerTurn, deliverAs})` + `ctx.isIdle()` / `ctx.hasPendingMessages()`。
- **runtime 层**（跨进程，经 RpcClient）：可用 RPC `prompt`（带 `streamingBehavior`）/ `steer` / `follow_up`；**没有** custom message 注入命令（RPC 命令全集核实，见 §2.2）。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者体验 |
|---|------|-----------|
| G1 | session-manager 的 `send_to_session` 在目标 busy 时排队而非拒绝 | agent 调 send 不再收到 `rejected: true` 后自己琢磨重试；目标 session 存活且可达期间，消息在其下一 turn 边界注入（pi 进程死亡/卡死的丢局面见 §3.1 失败路径表，不用「保证」一词） |
| G2 | 子 session 完成后结果自动回流父 session | 父 agent 被 steering 唤醒，上下文出现完成通知（含 sessionFile 指针），无需轮询 `get_session_status` |
| G3 | 投递竞态知识有代码级 SSOT | notifier / scheduler / workflow / session-manager 共用同一份带测试的冲突处理实现；修一处坑全部生效 |
| G4 | 迁移零行为回归 | subagent 后台完成通知、scheduler 到期唤醒、workflow 完成通知与迁移前行为一致 |

### In / Out of scope

**In**：
- 策略内核包的接口与职责边界（§3.3）
- RpcClient 补 `streamingBehavior` 透传
- session-manager send 排队 + 完成回流两个新场景
- notifier（subagent-workflow）、scheduler 两处迁移；workflow helpers 评估迁移
- extension / runtime 两侧装配方式

**Out**：
- 文件式 mailbox（zcode zsub 模式）——已否决，理由见 §3.2 方案 D
- pending-notifications 的重构——它是记账层（register/unregister 差集），与投递正交，只组合不合并（§3.3 D6）
- MessageDispatcher.sendMessage（用户在 UI 里发消息的路径）行为变更——busy 拒绝语义对人类用户是正确产品行为（防误发），不在本设计改动范围
- compact 队列（renderer 侧形态不同）——仅在 §5 留评估项
- goal 的 before_agent_start 注入——它是「turn 开始时读记账」的消费方式，不是投递器

---

## 2. 现状与问题分析

**结论：同一组投递竞态知识有 5 份独立实现，靠注释互相引用对齐而非共享代码；pi 0.84.1 两层投递原语已完整，缺的是统一收口。**

### 2.1 现有 5 处投递实现盘点（代码事实）

| # | 实现 | 位置 | 通道 | 自带的冲突处理 |
|---|------|------|------|---------------|
| 1 | subagent-workflow `notifier.ts` | extension（`extensions/universal/subagent-workflow/src/execution/notifier.ts`） | `host.sendMessage(msg, {triggerTurn: true, deliverAs: "steer"})` | isIdle gate + 退避重试（达上限强制发送）+ 合批窗口（多条通知合并）+ shutdown flush + dispose 短路 |
| 2 | scheduler `runtime.ts` | extension（`extensions/universal/scheduler/src/runtime.ts`） | `backend.sendMessage`（委托 `pi.sendMessage`，现配 `deliverAs:'followUp', triggerTurn:true`，runtime.ts:319） | `!ctx.isIdle() \|\| ctx.hasPendingMessages()` **跳过延迟到下个 tick（30s 重试）**（runtime.ts:307-309）+ force 任务绕过 gate 直投 + `dispatchesInFlight` Map 防双派发 + `await backend.sendMessage` **抛错驱动失败记账**（标 failed；once 任务失败不删持久化 = at-least-once，runtime.ts:316-343） |
| 3 | workflow `helpers.ts` notifyDone | extension（`extensions/universal/subagent-workflow/src/interface/helpers.ts`） | `pi.sendMessage` | runId 去重窗口（`MAX_NOTIFIED_RUN_IDS = 1000`，LRU 挤出） |
| 4 | `useCompactQueue` | renderer → runtime RPC | `client.steer()` | 手动快照队列 + 重放（compact 完成后逐条 steer） |
| 5 | `MessageDispatcher.sendMessage` | runtime（`packages/runtime/src/services/session/message-dispatcher.ts:119-127`） | `client.prompt()` | busy 预检（`isGenerating \|\| isCompacting \|\| isBashRunning`）**直接拒绝**，返回 `{blocked: true, rejected: true}` + `send.rejected` 广播 |

session-manager 的 `send_to_session` 当前复用 #5 的路径（`SessionManagerHandler.handleSend` → `sessionService.sendMessage` → dispatcher）——所以 agent 调 send 遇到目标 busy 会收到拒绝，且工具返回里没有重试指引。

**知识靠注释对齐的证据**（漂移风险的现实凭证）：

- notifier.ts:228-231：「与 workflow helpers.ts:151 同语义对齐（commit d214d0d83 验证 steer 能避免 'Agent is already processing' 错误）」
- scheduler runtime.ts:278：「参照 subagent-workflow resumesInFlight 模式：入口同步置位、finally 清除」

这是文档级对齐而非代码级对齐——每处独立演化，修坑不互通。

### 2.2 pi 0.84.1 投递能力矩阵（node_modules 实装核实，`@earendil-works/pi-coding-agent@0.84.1`）

**extension 层**（`dist/core/extensions/types.d.ts:924-933`）：

```ts
sendMessage<T>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
              options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void
sendUserMessage(content, options?: { deliverAs?: "steer" | "followUp" }): void  // always trigger turn
// 状态探测：ctx.isIdle() / ctx.hasPendingMessages()
```

**RPC 层**（`dist/modes/rpc/rpc-mode.js` 命令全集 grep）：

| RPC 命令 | idle 时 | streaming 时 | 唤醒能力 |
|---|---|---|---|
| `prompt`（支持 `streamingBehavior` 参数，rpc-mode.js:302 透传） | 立即开新 turn | 按 `streamingBehavior` 入队，不抛错 | **主动唤醒** |
| `steer` | **纯入队**（agent-session.js:984-993 只 `_queueSteer`，不判 idle） | 入 steer 队列，turn 边界 drain | 惰性 |
| `follow_up` | 纯入队 | run 结束后注入 | 惰性 |
| `send_message` | **不存在**——custom message 注入只在 extension 层可用 | — | — |

streaming 语义的 pi 侧权威定义（`agent-session.js:826-838`）：`prompt(text)` 无 `streamingBehavior` 且 streaming → throw `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."`。

三个直接推论：

1. **RPC `prompt + streamingBehavior: 'steer'` ≈ extension `sendMessage({triggerTurn: true, deliverAs: 'steer'})`**——idle 立即 turn / streaming 入队，两侧语义等价（差别仅在消息形态：前者 user message 文本，后者 custom message）。runtime 侧的智能投递能力**已经存在**，只是 `RpcClient.prompt`（`packages/runtime/src/services/ports/pi-engine.ts:142`）没暴露这个参数。
2. **RPC `steer` 对 idle session 是「下次活动才注入」**——消息躺队列直到下一个 prompt/turn 来 drain。单独使用就是 zcode mailbox 的边界（见 §3.2 方案 D），是已知陷阱不是能力。
3. **runtime 侧拿不到 custom message 形态**——回流通知若要结构化渲染（customType + details 走前端渲染器），须借道 extension（§3.3 D5）。

### 2.3 真实失败模式（历史事故，均有代码注释存证）

- **F1 followUp 永远排不上**：主 agent 处于「轮询 subagent_list 的 processing 状态」时 followUp 排不出（W2 修复：followUp → steer，notifier.ts:228-231）。
- **F2 agent_end → finishRun 窄窗口**：此刻 `isStreaming` 仍为 true，消息走 steer 入队，但 runLoop 已结束无人 drain → 静默丢失（notifier.ts:168-178，isIdle gate + 退避重试修复）。
- **F3 双注入**：tick 为 fire-and-forget，tick1 的 sendMessage 挂起超过 TICK_INTERVAL 时 tick2 对同一任务并发派发 → 同一 prompt 注入两次（scheduler runtime.ts:275-283，`dispatchesInFlight` 修复）。
- **F4（现行，非事故是设计缺陷）**：session-manager send 对 busy 目标直接拒绝，agent 拿到 `rejected: true` 无重试指引（G1 要解决的）。
- **F5（现行缺口）**：子 session 完成后无任何回流机制，父 agent 只能轮询 status（G2 要解决的）。

### 2.4 根因分析

表面问题 = 「多处重复实现」；根本问题 = **投递时序/竞态知识没有代码级 SSOT**。F1/F2/F3 三类事故的知识散落三处，各自修复、互不继承——F1 在 notifier 修复时 scheduler 已经独立踩过类似时序问题，workflow 的去重窗口又是第三份独立答案。每个新投递场景（session-manager 回流是第 6 个）都要重新发现一遍同一组约束：

1. idle 判定必须与 send 同步链一致（否则 F2）
2. busy 时按意图入队而非拒绝/丢失（否则 F4）
3. 并发投递需 in-flight 防重（否则 F3）
4. 意图选 steer 还是 followUp 有实战结论（否则 F1）

统一入口的本质：把这 4 条约束连同退避/合批/flush 策略，收敛为一份带单测的实现。

### 2.5 物理数据流图（统一后的两条投递通路）

```
【extension 通路】（同进程，custom message 可达）
  subagent-workflow notifier / scheduler / workflow / goal
    └→ delivery.send(msg)                           # 统一入口（内核）
         └→ [内核] gate(isIdle / settled 边沿) → 合批/去重
              └→ port.send(msg, intent)              # intent→pi 参数翻译在适配器内
                   └→ pi.sendMessage(custom msg)       # extension 装配注入
                        └→ idle: 新 turn / streaming: steer|followUp 队列

【runtime 通路】（跨进程，RPC）
  SessionManagerHandler（send 排队 / 完成回流）
    └→ delivery.send(msg)                           # 同一内核
         └→ [内核] gate(isIdle / settled 边沿) → 合批/去重
              └→ port.send(msg, intent)
                   └→ RpcClient.prompt(content, {streamingBehavior})   # runtime 装配注入
                        └→ pi RPC → idle: 新 turn / streaming: 入队
```

---

## 3. 解决方案

**结论：采用方案 A——packages 层策略内核 `@xyz-agent/session-delivery` + 窄端口注入 + 两侧薄装配；内核 API 讲投递意图（intent），pi 词汇封闭在适配器内（D3），策略默认值从现有实现继承而非新发明。**

### 3.1 终态（使用者视角）

**调用方 A——extension 作者（以迁移后的 subagent-workflow notifier 为例）**：

```ts
// 装配（extension index.ts，一次性）——适配器持有 pi 词汇，内核只见 intent
const delivery = createDelivery({
  supportedPayloads: ['custom'],                   // D9：声明本通路支持 custom message 形态
  isIdle: () => ctx.isIdle(),                      // pi ExtensionContext
  hasPendingMessages: () => ctx.hasPendingMessages(),
  subscribeSettled: (cb) => {                    // D8：pi.on 返回 void 且无 off（types.d.ts:884）——disposed 标志包装兑现退订语义
    let disposed = false
    pi.on('agent_settled', () => { if (!disposed) cb() })
    return () => { disposed = true }
  },
  send: (msg, intent) => host.sendMessage(
    msg.payload,                                   // kind:'custom' 与 pi sendMessage 入参同形
    intent === 'interrupt-at-turn-boundary'
      ? { triggerTurn: true, deliverAs: 'steer' }        // pi 词汇只出现在适配器内
      : { triggerTurn: true, deliverAs: 'followUp' }),
}, {
  intent: 'interrupt-at-turn-boundary',            // 默认意图：turn 边界抢占（F1 教训内化，D3）
  mergeWindowMs: 60_000,                           // 完成通知合批（现状 MERGE_WINDOW_MS=60s，滑动窗口）
  mergeHoldActive: () => host.hasRunningBackground(),  // D4：合批依赖谓词——后台 subagent 在跑才等窗口（承接 notifier.ts:149-153 语义）
})

// 使用（subagent 完成回调处，一行；格式化在调用方完成——内核只拼接）
delivery.send({ payload: { kind: 'custom', customType: 'subagent-bg-notify',
                           content: buildLlmContent(record), display: true, details } })
```

busy 窗口内的合批、去重、settled 边沿唤醒与丢消息防护全部由内核处理；`send()` 永不 throw（错误消化为内部 warn + 计数）。

**调用方 B——runtime（session-manager 的 send 排队）**：

```ts
// SessionManagerHandler 内按 sessionId 惰性装配（runtime 适配器：payload 仅支持 text）
const delivery = getOrCreateDelivery(sessionId, () => createDelivery({
  supportedPayloads: ['text'],                     // D9：runtime 通路拿不到 custom message（§2.2）
  isIdle: () => { const s = getSession(sessionId)
                  return !!s && !s.isGenerating && !s.isCompacting && !s.isBashRunning },
  hasPendingMessages: () => false,               // RPC get_state 有 pendingMessageCount（rpc-mode.js:358），
                                                  // 但端口是同步签名拿不到异步 RPC 结果——一期保守 false，见 §5 待验证
  subscribeSettled: (cb) => subscribePiEvent(sessionId, 'agent_settled', cb),  // D8：RPC 转发事件（rpc-mode.js:266-269）
  send: async (msg, intent) => { await client.prompt(msg.payload.content, {
    streamingBehavior: intent === 'interrupt-at-turn-boundary' ? 'steer' : 'followUp' }) },
    // 注：streamingBehavior 同时是 runtime 通路的安全网——gate 的 isIdle 读的是 runtime 侧
    // 状态标志，与 pi 实际 isStreaming 存在 TOCTOU；竞态命中时由 pi 队列兜底（不抛错）
}, { intent: 'interrupt-at-turn-boundary' }))

// handleSend 改为（sendChecked：入队 + 可达性同步确认，失败同步抛给 select 通道）：
try {
  await delivery.sendChecked({ payload: { kind: 'text', content: prompt } })
  return { queued: true }
} catch (e) {
  return { error: toErrorMessage(e), hint: 'target session unreachable; retry send_to_session after checking get_session_status' }
}
```

agent 视角的变化：`send_to_session` 返回 `{queued: true}`（不再出现 `{blocked: true, rejected: true}`）；消息保证在目标 session 下一 turn 边界进入其上下文。

**调用方 C——runtime（完成回流）**：

```ts
// session-lifecycle 检测 spawnSource === 'agent' 且 parentAgentSessionId 存在的子 session 到达终态
// （spawnSource 可单独成立无父 id——session-lifecycle.ts:388 注释；无父 id 的完成不回流，跳过）
parentDelivery.send({
  payload: { kind: 'text',                          // 一期 runtime 直投 text 形态（D5/D9）
             content: `Managed session "${label}" (${sid}) finished with status "${status}".` +
                     `\nFull transcript: ${sessionFile}` },
})
```

父 session 若 idle → 被唤醒开新 turn，通知进入其 LLM 上下文（G2 达成）；若 streaming → steer 入队，turn 边界注入。

**失败路径与恢复指引**（准则 6）：

| 失败 | 现象 | 恢复 |
|------|------|------|
| 目标 pi 进程已死 | `port.send` 内 ensureActive 抛错 | 入口即拦：`sendChecked` 同步抛给调用方（U5 的 agent 立即看到错误 + hint）；已入队消息由内核 send 重试（达上限 settle rejected，经 onSettled 上报） |
| 退避达上限仍 busy | 强制发送（fallthrough 到 pi 队列） | **预期**（⛔ 实施期探针门，见 §3.3 探针表末行）：pi 的 steer 队列在 run 循环内 drain；探针若证伪按降级路径收紧为丢弃+计数 |
| 目标正在 compaction（TOCTOU：gate 判 idle 后 compaction 恰开始） | pi `prompt` 无条件 throw（agent-session.js:808-810，**先于** streaming 分支，streamingBehavior 不救） | gate 的 `!isCompacting` 拦主路径；残余由内核错误重试自愈（backoff 窗口内 compaction 通常完成）；真机探针（row 3）附带覆盖该窗口 |
| port.send 持续抛错（pi 卡死） | send 重试达上限 | settle rejected + onSettled 回调；U5 场景经回流通道（U6）告知父 agent，U6 未落地窗口期 console.warn（§5 待验证第 3 条） |
| session 关闭中 isIdle 抛 | 内核捕获 → 丢弃队列 | 语义与 notifier 现状一致（dispose 短路）；调用方无需动作 |

### 3.2 方案对比

| | 方案 A：packages 层策略内核（推荐） | 方案 B：extensions/shared 新包 | 方案 C：runtime 局部排队包装 | 方案 D：文件 mailbox（zcode zsub 模式） |
|---|---|---|---|---|
| 形态 | `@xyz-agent/session-delivery` 纯逻辑内核 + 两侧薄装配 | extension 生态共享包（同 extension-logger） | 只在 SessionManagerHandler 里写一个私有队列类 | `~/.xyz-agent/mailbox/<sid>/unread/` 原子写 + drain |
| 长期架构合理性 | **高**：extension（session-manager import @xyz-agent/extension-protocol）与 runtime 都可消费；竞态知识单点收敛 | 低：runtime 无法消费（现有 4 个 extensions/shared 包 runtime 零依赖先例）→ 回流场景要么复制要么破坏依赖方向 | 低：第 6 份独立实现，F1/F2 类坑要在 runtime 重踩一遍 | 低：为「外部进程无法触达引擎」设计的降级通道；我们有进程内/RPC 直连，绕文件引入原子写/清扫/单调序新机械 |
| 短期实现成本 | 中：内核抽取 + 两处迁移 + 两处新场景 | 中（extension 侧同 A，但回流要另起炉灶） | 低 | 高（新子系统） |
| 风险 | 迁移期行为回归（用「测试搬迁 + 零行为断言」压） | 回流场景复制策略 → 统一目标落空 | 治标：表面症状消失（send 不拒绝了），根本问题（知识无 SSOT）原样存在 | 双写路径（现有 5 处不会迁移过去）→ 永久双轨 |
| 若用它，§2 的 F4/F5 会怎样 | F4/F5 直接解决，F1/F2/F3 知识归一 | F4 解决、F5 需要第二套实现 | F4 解决，F5 还要再写一份 | F5 经文件+下次活动注入解决，但唤醒延迟（idle 不触发）+ F4 不解决 |

**推荐 A**。核心理由：唯一同时覆盖 extension 与 runtime 两类投递者的落点（依赖方向事实：extension → packages/* 已有先例，runtime → extensions/shared 零先例）；且迁移路径是从最成熟的 notifier「抽取」而非重写，历史踩坑知识直接转化为内核单测。

方案 D 补充说明：zcode zsub 的 mailbox 是外挂进程拿不到引擎内通道时的最优解（「下次活动才注入」是它声明的物理上限）；我们的 runtime 持有 RpcClient、`prompt(streamingBehavior)` 具备主动唤醒——用文件通道等于放着直连不用。**mailbox 一词在本设计的对应物不是文件，是「统一投递入口」本身。**

### 3.3 关键决策与权衡

**D1 内核放 packages 层新包 `@xyz-agent/session-delivery`**（与 extension-protocol 平级）
选择：packages 层。被否：extensions/shared（runtime 消费不了）、packages/shared（那是类型/常量层，不放行为逻辑）。证据：session-manager 已 import `@xyz-agent/extension-protocol`，依赖方向 extension → packages 成立；runtime → packages 是其本体依赖方向。

**D2 端口注入，内核零 pi 依赖**
选择：内核自定义窄端口（`isIdle` / `hasPendingMessages` / `send` / 可选 `subscribeSettled`），不 import pi 类型。被否：直接依赖 pi 的类型定义（内核会随 pi 版本漂移，且 runtime 装配侧拿不到 ExtensionContext）。端口与配置不出现任何 pi 词汇（D3）——steer/followUp/triggerTurn/streamingBehavior 只存在于两侧适配器内。

**D3 内核 API 讲「意图」，pi 词汇封闭在适配器内**
选择：调用方声明 `intent: 'interrupt-at-turn-boundary' | 'after-run'`（turn 边界抢占 / run 结束后注入；两者均含 idle 唤醒语义——**in-scope 5 处投递实现**无任一 `triggerTurn: false` 依赖，不为无人使用的组合保留维度。注：out-of-scope 的 goal 存在 triggerTurn 缺省调用 3 处（ports.ts:84-90 / command-adapter.ts:307 / agent-end.ts:126,195），其中 command-adapter.ts:307 的 idle「append 不唤醒」形态 intent 二值**无法表达**——不构成本期决策依据，其迁移评估见 U7）。intent → pi 参数的映射表由适配器持有：extension 侧 `interrupt-at-turn-boundary → {deliverAs:'steer', triggerTurn:true}`、`after-run → {deliverAs:'followUp', triggerTurn:true}`；runtime 侧 `→ prompt({streamingBehavior:'steer'|'followUp'})`。被否：内核直接复用 pi 三值作 API（本文档初稿方案）——steer/followUp 是 pi 的机制名，runtime 适配器映射到 `streamingBehavior` 时反正在翻译，两侧都是映射、没有谁更原生；且内核持 pi 词汇会随 pi 版本漂移，违背内核的终态定位：**pi 缺失能力的体外补钉，pi 成熟后应能整体删除**（§3.2 方案 A 的长期合理性即系于此——API 越远离 pi 词汇，删除时牵连越小）。实战结论内化为**默认值**：默认 `intent: 'interrupt-at-turn-boundary'`（F1 的教训），after-run 场景（scheduler）显式声明。

**D4 策略项与默认值**（从现有实现继承，不新发明）：

| 策略 | 默认值 | 继承自 | 作用 |
|------|--------|--------|------|
| busy 策略 `busyPolicy` | `'retry-force'`：settled 边沿驱动 flush + watch-dog 30s 复核（D8 主路径）；无订阅装配退化退避 `{backoffMs: 100, max: 50}`（≈5s 上限）后强制发送 | notifier FLUSH_BACKOFF + D8 | F2 窗口不错过唤醒点；达上限强发（pi 队列兜底，⛔ 探针门验证） |
| | 备选 `'park'`：busy 时入队不重试，等下一次 `send()`/`flush()` 外部触发 | scheduler tick 模式（busy 跳过延迟到下个 30s tick） | scheduler 迁移用它保行为等价（避免 5s 强发提前注入正在进行的 run） |
| 合批窗口 | `mergeWindowMs: 0`（关）；notifier 场景显式 `60_000` **滑动窗口**（每次 notify 重置计时） | notifier MERGE_WINDOW_MS=60_000（notifier.ts:76） | 多条通知合并为一条消息 |
| 合批格式归属 | **调用方预格式化**：每条消息的 content 已是终态文案（notifier 的 buildLlmContent 在调用方）；内核只拼接——多条以 `"\n\n---\n\n"` join，details 包装为 `{batch: true, items}` | notifier doSend（notifier.ts:215-221） | 内容锚定测试锁定的输出由「调用方格式化 + 内核固定拼接规则」共同决定，归属清晰 |
| 去重 | 关；workflow 场景显式开（消息自带 `dedupeKey` + `maxKeys` 1000 条 LRU） | workflow MAX_NOTIFIED_RUN_IDS | F3 类双派发抑制（scheduler 任务级 dispatchesInFlight 保留在其调用方） |
| 入口收敛 | **单一 `send(msg, opts?)` 常规入口**（初稿的 `notify()`/`deliver()` 双入口语义微差，连文档自身都未说清——合并）；合批是消息级选项 `opts.merge`（默认跟随 `mergeWindowMs > 0`），`sendChecked` 是「同步确认」变体而非第三入口 | 对抗式自查：双入口会让第 6/7 个消费方猜测该调哪个 | API 面无歧义，新消费方零猜测 |
| 立即投递触发 | `send()` 先探「无合批依赖即 flush」：立即投条件 = `!config.mergeHoldActive?.()`——**合批依赖谓词由调用方声明**（notifier 装配为 `host.hasRunningBackground`）。isIdle/hasPendingMessages **不得**用作立即投条件：二者测主 agent LLM 状态，hasRunningBackground 测后台 subagent 生命周期——主 agent idle + 2 个后台 subagent 在跑时，误用 isIdle 会把 60s 合批变成立即单发（审查 must-fix #1 反例，notifier.ts:149-153 证伪） | notifier notify 入口（notifier.ts:149-153） | 空闲且无后台任务时通知零延迟，不为合批空等 60s；有后台任务时合批语义与现状逐点等价 |
| 投递结果信号 | `sendChecked()` 返回 Promise（resolve=已入队且可达性确认，reject=入队失败）；异步终态经 `onSettled` 回调（delivered / rejected） | scheduler 的 await 失败记账 + at-least-once 语义 | 依赖投递结果的消费者（scheduler once 任务）不丢任务；不关心的调用方（notifier）忽略即可 |
| shutdown flush | 内核提供 `flush()`，由宿主在 session_shutdown / dispose 时调 | notifier flushPendingNotifications | 进程退出前清空队列 |
| 错误重试 | `port.send` 抛错 → 有限重试（同 backoff 参数）→ 达上限 settle rejected | notifier 退避骨架 + scheduler ER-APPEND-FAIL 模式 | 投递失败不炸调用方，也不无限静默积压 |

**D5 回流通知形态：一期 user prompt 文本（runtime 直投），custom message 借道 marker 通道留作二期**
选择：一期 `RpcClient.prompt` 文本直投（payload kind `'text'`，runtime 适配器 `supportedPayloads: ['text']`，见 D9；通知文案对齐 notifier 的 buildLlmContent 模式：label/status/摘要/sessionFile 指针）。被否（一期）：经 session-manager extension 的 marker 通道（runtime → extension_ui_request → extension 内 `pi.sendMessage`）投 custom message——能拿到结构化渲染（customType + details 走前端 bg-notify-render 类渲染器），但要扩展 marker 协议 + 走一圈 UI 请求通道，一期收益不抵复杂度。触发升级条件：前端需要对回流通知做专门渲染（折叠/图标/点击跳转子 session）时再上。

**D6 与 pending-notifications 的关系：组合，不合并**
pending-notifications 是记账层（register/unregister 差集 = 谁在等），本内核是投递层（把消息送进 LLM）。组合协议：通知场景 = `pending.register`（等待态对 goal 可见）→ 终态 → `delivery.send`（唤醒投递）→ `pending.unregister`。两包互不依赖，编排发生在调用方（session-manager 回流场景）。合并的诱惑存在（「通知」一词撞名），但记账要持久化（appendEntry 跨重启）、投递要实时（内存队列跨毫秒），生命周期完全不同。

**D7 U5 接管面：dispatcher 链路副作用的逐项处置（防静默绕过）**
`handleSend` 现走 `sessionService.sendMessage` → `MessageDispatcher.sendPrompt` 完整链路，含 6 个内部步骤；改为 `delivery.send` 后逐一声明：

| dispatcher 内部步骤 | 处置 | 理由 |
|--------------------|------|------|
| BeforeSend hook（插件拦截/改写） | **明确放弃**（agent 路径不过） | agent 消息已经过 marker 协议层校验；插件 hook 的语义是审核「用户手打消息」 |
| `ensureActive`（pi 死则 restore 拉起） | **保留**——runtime 装配的 `send` port 内部先 ensureActive 再 prompt | 投递可达性前提 |
| busy 预检拒绝 | **替换**——由内核 gate（退避 + 排队）接管 | 这正是 U5 的目的（F4） |
| `isGenerating = true` + `lastActiveAt = Date.now()` 标记（前端显示生成中 / session 列表按 lastActiveAt 排序） | **保留**——port 内 prompt 成功后一并置位（lastActiveAt 影响侧栏排序新鲜度，session-scanner.ts:53） | 子 session 收消息后侧栏须显示 working；内核 isIdle 读同源标志，置位晚于 gate 判定不构成矛盾（gate 只在投递前判） |
| `workspaceService.record` | **保留**——port 内 best-effort（沿用 dispatcher 的 try/catch warn 模式） | agent-managed 子 session 的 cwd 应进最近工作区 |
| 错误广播（`send.rejected` / `message.error`） | **替换**——agent 路径失败不走前端 banner | 同步失败经 `sendChecked` reject → select 通道返回错误 + hint（agent 立即可见）；异步失败（queued 后 port.send 抛）经 U6 回流通知告知父 agent；U6 未落地窗口期内仅 console.warn（诚实标注的已知缺口，见 §5 待验证） |
| `handleCreate` 初始 prompt（同文件第二个 sendMessage 调用点，session-manager-handler.ts:138-144） | **直投不走内核队列**——新 session 必然 idle 无竞态，用 port 层同款「ensureActive + prompt」直发；失败照旧 throw（错误对象挂 sessionId + hint） | 保留 create+send 原子性契约（外层 catch 依赖 throw 组装恢复路径，session-manager-handler.ts:73-84）；内核 never-throw 模型不适合此同步确定性场景；与 row1 一致不过 BeforeSend hook |

另：plugin-service 的两处会话消息路径（session-api.ts:209 / plugin-rpc-setup.ts:131）同样走 dispatcher——U5 只改 session-manager 的 `handleSend` 调用点，plugin 路径保持 dispatcher 现状（含 busy 拒绝语义）不变，特此声明防误认遗漏。

**D8 冲突解决：agent_settled 事件驱动为主，watch-dog 与退避轮询双层兜底**
选择：port 增加可选 `subscribeSettled?(cb: () => void): () => void`（返回退订函数；extension 侧 `pi.on('agent_settled', handler)` 存在（types.d.ts:884）但**返回 void、无 off**——适配器用 disposed 标志包装兑现退订语义（见 §3.1 调用方 A 示例），handler 本身随 extension 卸载由 pi 清理）。busy 入队后内核订阅 settled 边沿：事件触发 → `isIdle()` 复核 → 通过即 flush。依据（实装核实）：`_emitAgentSettled` **先把 `_isAgentRunActive = false` 再发事件**（agent-session.js:327-336）——订阅者收到 settled 时 `isIdle()` 已为 true，复核无竞态；事件在 `_runAgentPrompt` 的 finally、最后一次队列 drain 检查之后发出（agent-session.js:744-757），extension 事件与 RPC 转发两层同有（rpc-mode.js:265-270）。settled 边沿正是 F2 死区的关闭点：「退避压概率」升级为「结构上不错过唤醒点」。残余窗口（settled 已发、消息恰在其后由其他写入者 steer 入队）由 pi 队列在下次活动时 drain 兜底（§2.2 推论 2 的反向利用：延迟注入而非丢失）。
**兜底两层**：①有订阅装配仍保留低频 watch-dog（`watchdogMs` 默认 30s 一次 isIdle 复核 flush）——RPC 断线重连期间 settled 事件丢失（pi 事件流不重放）时队列滞留的恢复路径（审查 should-fix #3）；②无订阅装配退化为 D4 退避轮询。被否：纯退避轮询（初稿方案——不利用 pi 已给出的事件信号，引入无谓延迟上限 ≈5s）与纯事件驱动（事件丢失无恢复路径）。

**D9 消息模型分离 envelope 与 payload，适配器声明 payload 能力**
选择：`DeliveryMessage = { payload, intent?, dedupeKey?, durability? }`；payload 为判别联合 `{kind:'text'} | {kind:'custom', customType, content, display, details?}`；适配器以 `supportedPayloads` 声明能力，收到不支持的 kind 时 `send`/`sendChecked` **同步 reject**（fail-fast，禁止静默忽略）。被否：单一同形结构（初稿方案：runtime 侧注释「customType/details 被忽略」）——「同形不同义」把能力差异藏在注释里，第 6 个消费方必然踩坑；判别联合让「runtime 通路拿不到 custom message」（§2.2 结构事实）成为类型级约束而非文档级约定。`durability` 预留 `'at-least-once'`（持久化 outbox：appendEntry 记账 + resume 重投，scheduler 类消费者的终态能力）——一期不实现，接口不留障碍。

**运行时断言清单**（探针状态）：

| 断言 | 探针 | 状态 |
|------|------|------|
| RPC `prompt` 响应时机 = preflight 受理即回（queued 与立即处理均算 success），**不等 turn 跑完** | rpc-mode.js:298-316（preflightResult 回调内 output success）+ agent-session.js:913-918（preflight 先于 _runAgentPrompt） | ✅ 代码核实（`sendChecked`「同步确认可达性」语义成立的前提） |
| `agent_settled` 事件两层可用（extension 事件 + RPC 转发），且 `_isAgentRunActive=false` 先于事件发出（订阅时 isIdle 已 true） | agent-session.js:327-336, 744-757 + rpc-mode.js:265-270 | ✅ 代码核实（D8 事件驱动的前提） |
| RPC `prompt(streamingBehavior)` streaming 时不抛错且入队 | pi CLI `--mode rpc` 手发 streaming 期间 prompt+streamingBehavior | ✅ 代码核实（agent-session.js:836-840 入队分支 + rpc-mode.js:302 透传）+ ⛔ 真机探针（U1 实施期，附带覆盖 compaction 窗口场景） |
| RPC `steer` 对 idle session 纯入队不唤醒 | 同上，idle 时发 steer 观察 turn 不启动 | ✅ 代码核实（agent-session.js:984-993 只 `_queueSteer`，无 idle 分支）+ ⛔ 真机探针（U1 实施期） |
| extension `sendMessage({triggerTurn:true})` idle 时立即开 turn | subagent-workflow 现有 e2e | ✅ 代码核实（sendCustomMessage :1083-1087）+ 现有 e2e 覆盖（用例未逐一核对） |
| 内核退避后强发经 pi steer 队列被 `_handlePostAgentRun` drain | 实施期单测 + 本地 pi 真机 | ⛔ 实施期门（U2/U6）；降级路径：探针失败（强发后无人 drain）→ 收紧为「退避永不强发 + 达上限丢弃并计数」，丢弃面由 U6 回流通知兜底告知（宁可靠知丢失，不可静默积压） |

### 3.4 内核接口草案（下一层实现的对齐基线）

```ts
// packages/session-delivery/src/index.ts —— 形态示意，字段以本节语义为准
export type DeliveryIntent = 'interrupt-at-turn-boundary' | 'after-run'  // D3：turn 边界抢占 / run 结束后注入，均含 idle 唤醒

export type DeliveryPayload =                              // D9：envelope / payload 分离
  | { kind: 'text'; content: string }                      // user prompt 文本（runtime 通路一期唯一支持）
  | { kind: 'custom'; customType: string; content: string; display: boolean; details?: unknown }  // pi custom message（extension 通路）

export interface DeliveryMessage {
  payload: DeliveryPayload
  intent?: DeliveryIntent            // 缺省回落 config.intent
  dedupeKey?: string                 // 开 dedupe 时必填（key 是消息的属性，随消息走，不再是全局 keyOf 函数）
  durability?: 'in-memory'           // 预留 'at-least-once'（D9：持久化 outbox 一期不实现，接口不留障碍）
}

export interface DeliveryPort {
  supportedPayloads: readonly DeliveryPayload['kind'][]    // D9：能力声明；收到不支持的 kind 时 send/sendChecked 同步 reject（fail-fast）
  isIdle(): boolean
  hasPendingMessages(): boolean
  send(msg: DeliveryMessage, intent: DeliveryIntent): Promise<void> | void  // intent → pi 参数的翻译在适配器内部（D3）
  subscribeSettled?(cb: () => void): () => void            // D8：agent_settled 边沿订阅；缺省时内核退化退避轮询
}

export interface DeliveryConfig {
  intent?: DeliveryIntent                     // 默认 'interrupt-at-turn-boundary'（D3）；scheduler 显式 'after-run'
  busyPolicy?: 'retry-force' | 'park'         // 默认 'retry-force'（D4）；scheduler 用 'park'（tick 重触发）
  mergeWindowMs?: number                      // 默认 0（D4）；notifier 显式 60_000（滑动窗口）
  mergeHoldActive?: () => boolean             // D4：合批依赖谓词（notifier 装配 hasRunningBackground）；true 时 send() 走合批窗口，false/缺省时立即投——禁止用 isIdle 代替（must-fix #1）
  backoff?: { ms: number; max: number }       // 默认 {100, 50}（D4；subscribeSettled 装配下仅作 watch-dog 复核失败的重试节拍）
  watchdogMs?: number                         // 默认 30_000（D8：subscribeSettled 装配的断线兑底复核；无订阅装配不使用）
  dedupe?: { maxKeys: number }                // 条数 LRU（继承 MAX_NOTIFIED_RUN_IDS=1000 语义，非毫秒）；key 来自 msg.dedupeKey；workflow 场景显式开
  onSettled?: (msg: DeliveryMessage, outcome: 'delivered' | 'rejected') => void  // 投递终态信号（D4）
}
export interface DeliveryHandle {
  send(msg: DeliveryMessage, opts?: { merge?: boolean }): void  // 唯一常规入口（D4 入口收敛）；合批窗口 + 空闲零延迟立即投
  sendChecked(msg: DeliveryMessage): Promise<void>  // 入队 + 可达性同步确认（RPC preflight 受理即回，不等 turn）；reject = 入队失败（U5 用）
  flush(): void                             // 强制投递尝试（shutdown / park 外部重触发 / settled 边沿内部复用）
  depth(): number                           // 队列深度（诊断/测试）
  dispose(): void
}
export function createDelivery(port: DeliveryPort, config?: DeliveryConfig): DeliveryHandle
```

约束：
- 内核无 timer 依赖注入以外的全局状态（vitest fake timers 可测）；单一投递循环天然 in-flight 防重（send 入队 → 至多一个 flush 在途）。
- **同 session 单例 handle**：U5（send 排队）与 U6（回流）若对同一 session 各自 createDelivery，并发投递竞态回到无保护状态——runtime 装配层必须以 sessionId 为键做单例注册表；extension 侧同理（每 extension 实例一个 handle）。此约束写进包 README 与 JSDoc。

---

## 4. 验收（真实场景）

**结论：6 个真实场景验收（本地 pi CLI 为主 + 桌面实机一个），覆盖全部 4 个目标；单测只作回归锁不算验收。**

> 验证方式遵守项目规约：extension 改动优先本地 pi CLI 实测（`pi --mode rpc --session-dir <dir> --approve --extension <path>` + stdin JSONL），桌面侧在 `pnpm dev` 实机确认。单测只作回归锁，不算验收。

| # | 场景（谁/上下文/做什么/看到什么） | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|--------|---------|
| S1 | agent 在父 session 用 `create_managed_session` 建子 session 并 send 长任务（如「循环 sleep 并汇报」）；任务 streaming 期间再 send 第二条 | 本地 pi CLI 起父 session（挂 session-manager extension）→ create → send 长任务 → 立即 send 第二条 → 读子 session 的 `get_entries` | 第二条返回 `{queued: true}`；子 session 当前 turn 结束后的下一 turn 开头出现第二条消息内容 | G1 |
| S2 | 子 session 跑完短任务（如「执行 ls 并总结」）到终态 | 本地 pi CLI：父 session create+send（带初始 prompt）→ 等待 → 观察父 session | 父 session 无人工输入的情况下自动开新 turn，上下文含完成通知文案（label/status/`Full transcript:` 指针行）；父 session 的下一轮回答能引用子 session 的结果 | G2 |
| S3 | subagent-workflow 迁移后后台 subagent 完成通知（含**多任务合批**：60s 滑动窗口内两个后台 subagent 先后完成） | 跑 subagent-workflow 现有后台通知 e2e（extensions/universal/subagent-workflow 的 bg-notify 用例）+ 新增多任务合并场景；**迁移前固化 golden 全文快照**（单条 + 合批各一条）入 fixtures，迁移后 diff | 用例全过；单条/合批通知全文与 golden 快照逐字节一致（现有测试为 toContain/endsWith 关键行锚定，golden diff 是本场景新增的可执行断言）；合批场景仍合并为一条消息（`---` 分隔、details 为 batch 结构） | G4 |
| S4 | scheduler 迁移后到期唤醒 | 本地 pi CLI 挂 scheduler extension，建 5s 后到期的一次性任务 | 到期后 session 自动开新 turn 收到任务 prompt；同一任务不被双派发（entries 中只出现一次） | G4 |
| S5 | F2 竞态窗口不丢消息 | 内核单测（fake timers 锁 agent_end→finishRun 场景）+ 真机：通知投递与子 session agent_end 同时触发（脚本压时序） | 退避路径命中后消息最终送达（单测断言 + 真机父 session 上下文出现通知） | G3 |
| S6 | 桌面端 send 排队可视 | xyz-agent 桌面 `pnpm dev`：主 session 让 agent 管理子 session 并连发两条 | 子 session 对话流按序出现两条处理结果；侧栏状态不出现错误气泡（对比现状 busy 拒绝路径） | G1 |

验收与目标的对账：G1→S1/S6，G2→S2，G3→S5（+S3/S4 作为共用内核的间接证据），G4→S3/S4。无孤儿场景，无无场景目标。

---

## 5. 下一层拆分

**结论：7 个实现单元（U7 为评估项），U1（RpcClient 透传）/U2（内核抽取）并行先行，notifier 先切（U3）再开新消费方（U5/U6）。**

| 单元 | 内容 | justification | 依赖 | 验收挂钩 |
|------|------|---------------|------|---------|
| U1 | `RpcClient.prompt` 补 `streamingBehavior` 透传（pi-engine.ts 签名 + rpc-client 实现） | 先决：runtime 通路的能力开通，一行透传，独立可验 | — | S1 前置（pi CLI 探针：streaming 期间 prompt+steer 不抛错） |
| U2 | 内核包 `@xyz-agent/session-delivery`（从 notifier 抽取 enqueue/gate/合批/flush 骨架 + 单测搬迁；新增 intent 映射契约测试、subscribeSettled 事件驱动路径测试、payload 能力 fail-fast 测试） | 抽取而非重写：notifier 是竞态知识最全的实现，搬迁测试即继承 F1/F2 教训 | — | S5 |
| U3 | subagent-workflow notifier 切换内核（装配 + 删私有逻辑，现有锚定测试不动） | 第一个消费者，验证内核抽象对最复杂场景的覆盖度 | U2 | S3 |
| U4 | scheduler 切换内核（gate 交内核 + `busyPolicy: 'park'`（tick 重触发）+ `intent: 'after-run'` 保持现状 followUp 语义 + `onSettled` 承接失败记账；dispatchesInFlight 保留） | 第二消费者，验证 park 模式 + after-run 意图形态与 at-least-once 语义等价 | U2 | S4 |
| U5 | session-manager send 排队（SessionManagerHandler 装配 runtime Delivery + `handleSend` 改 `sendChecked`；工具返回 `{queued: true}`；`handleCreate` 初始 prompt 按 D7 末行直投） | G1 主体；同时补 create 带 prompt 的工具 schema 暴露（前序分析的独立缺口，一并落地） | U1, U2 | S1, S6 |
| U6 | session-manager 完成回流（session-lifecycle 终态检测 `spawnSource==='agent' && parentAgentSessionId` + parentDelivery 投递通知文案；runtime 侧 sessionId 单例 handle 注册表） | G2 主体；无父 id 的 agent session 完成不回流（跳过）；单例约束防 U5/U6 并发竞态 | U1, U2 | S2 |
| U7（评估项） | workflow helpers 切换内核 / compact 队列并入 / **goal sendContextMessage 迁移评估**（command-adapter.ts:307 的 idle「append 不唤醒」形态 intent 二值无法表达——迁移需第三意图 `'append-no-turn'` 或永久留在 goal 内） | 非本设计目标必需；U3/U4 落地后评估迁移成本 | U2 | — |

顺序建议：U1、U2 并行 → U3+U5 并行 → U4、U6。U3 完成前不动 U5/U6 的装配代码（避免两个未验证消费方同时压新内核）。

**文件改动地图**（下一层实现的导航）：

- 新增：`packages/session-delivery/`（包骨架 + src/index.ts + tests）
- `packages/runtime/src/services/ports/pi-engine.ts` + `src/infra/pi/rpc-client.ts`（U1）
- `extensions/universal/subagent-workflow/src/execution/notifier.ts`（U3，大幅瘦身）
- `extensions/universal/scheduler/src/runtime.ts`（U4，gate 段删）
- `packages/runtime/src/transport/session-manager-handler.ts` + `extensions/universal/session-manager/src/index.ts` + `packages/extension-protocol/src/extensions/session-manager/types.ts`（U5：SendResult `{blocked, rejected}` → `{queued: true}` + 错误形状；工具 schema/description 同步改「asynchronously queued」语义）
- `packages/runtime/src/services/session/session-lifecycle.ts`（U6，终态钩子）

**待验证检查点**（设计阶段无法确定，诚实标注）：

- ⛔ runtime 装配的 `hasPendingMessages` 一期固定 `false`：`get_state` 虽有 `pendingMessageCount`（rpc-mode.js:358）但端口同步签名拿不到异步 RPC 结果。残余影响：runtime 侧 F2 窗口判定少一个信号（isIdle gate 已覆盖主路径）——S5 真机观察后再评估 get_state 预询。
- ⛔ U6 终态检测的事件源精确位置（session-lifecycle 的状态转移钩子 vs pi exit 回调）——U6 实施时以代码现状为准。
- ⛔ 内核合批的合并文案格式（`"\n\n---\n\n"` 分隔沿用 notifier）在回流场景是否需要按通知类型区分。
- ⛔ runtime 侧 `subscribeSettled` 的事件源接线：runtime event-adapter 已消费 pi 事件流（`agent_settled` 经 rpc-mode.js:266-269 转发为 JSON event），U5 实施时确认从 event-adapter 到装配层的订阅通路；若通路不存在则一期退化退避轮询（D8 兑底路径），在 PR 描述声明。
- ⛔ U5 的异步失败可见性依赖 U6 回流通道：U6 落地前，queued 后 port.send 持续失败仅 console.warn + onSettled 计数（agent 不可见）。U5/U6 若分批合入，此窗口期须在 PR 描述显式声明。

**残余风险**（修复审查 must-fix 后仍存，实施期须警惕）：

- F2 死区在 pi 侧物理存在（run 循环最后一次 `hasQueuedMessages` 检查之后入队的消息无人 drain）——D8 的 settled 边沿 + isIdle 复核把「不错过唤醒点」结构化（settled 发出时 `_isAgentRunActive` 已 false，agent-session.js:327-336）；残余窗口（settled 后由其他写入者 steer 入队的消息）由 pi 队列下次活动 drain 兑底（延迟非丢失）。⛔ 探针（强发后 drain）仍是唯一大门，**必须在 U2 动工前先跑**。
- 内核单 handle 的 in-flight 防重不跨 handle 实例——同 session 必须单例装配（§3.4 约束），U6 的 sessionId 注册表是第一处强制点，code review 按此 checklist 核。

---

## 6. 审查记录

**第一轮对抗式审查**（tech-design-review，报告全文：[review-report.md](review-report.md)）：2 must-fix + 4 should-fix + 4 nit + 1 INFO，全部正面修复，无申诉项。

| 级别 | 问题 | 处置 |
|------|------|------|
| must-fix #1 | D4「立即投递触发」用 isIdle 承接 notifier 的 hasRunningBackground 谓词，语义不等价（主 agent idle + 后台 subagent 在跑时会把 60s 合批变成立即单发，违反 G4） | D4 行重写：新增 `mergeHoldActive` 调用方谓词，明文禁止 isIdle 作立即投条件；§3.4 接口与 §3.1 示例同步 |
| must-fix #2 | `pi.on('agent_settled')` 返回 void 且无 off（types.d.ts:884），§3.1 示例照抄会在 dispose 时 TypeError | D8 与示例改为 disposed 标志包装兑现退订语义 |
| should-fix #3 | 纯事件驱动无事件丢失兑底（RPC 断线丢 settled 则队列滞留） | D8 增加 watch-dog 层（`watchdogMs` 默认 30s），被否项改为「纯轮询与纯事件驱动」双否 |
| should-fix #4 | D3「现网无 triggerTurn:false 消费者」被 goal 3 处调用证伪（command-adapter.ts:307 的 idle append-no-turn 形态 intent 二值无法表达） | D3 论据限定 in-scope 5 处；U7 增加 goal 迁移评估项（需第三意图或永留 goal 内） |
| should-fix #5 | S3「字节锁测试」声称与实际 toContain/endsWith 锚定不符，「逐字节一致」无验证方法 | S3 改为迁移前固化 golden 全文快照入 fixtures、迁移后 diff；全文「字节锁」表述清除 |
| should-fix #6 | 探针表 row3/4「✅ 已测」实为代码核实 | 全表状态改为「✅ 代码核实 + ⛔ 真机探针」双标区分 |
| nit | 行号偏移 6 处 / dedupe window 单位歧义 / G1「保证」过强 / plugin-service 两路径未声明 | 逐项修正（dedupe 改 `maxKeys` 条数语义；G1 限定「存活且可达期间」；D7 补 plugin 路径不变声明） |
| INFO | compaction 进行中 prompt 无条件 throw（agent-session.js:808-810，先于 streaming 分支） | 失败路径表补一行：gate `!isCompacting` 拦主路径 + 错误重试自愈 + 真机探针附带覆盖 |

审查同时确认：§2.2 能力矩阵 9 行与 §3.3 断言 6 行逐行核实**全部属实无虚构**；intent 二值对 in-scope 7 场景覆盖完整；D8 主时序自洽（settled 后另一写入者置 busy 的场景下轮 settled 自愈 + streamingBehavior 双向兑底）；D7 六步骤与 dispatcher 实装逐项吻合。
