# 对抗式审查报告：Session 消息投递层统一设计（delivery kernel）

> 审查对象：`.xyz-harness/2026-08-22-session-delivery/design.md`
> 审查依据：rubric-design-doc.md（P0/P1 清单）+ 任务指定 5 个重点方向
> 核实方式：pi 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.1`（dist 编译 JS + types.d.ts）与本仓源码逐锚点 read

## Summary

**2 must-fix, 4 should-fix, 4 nit。**

核心结论：方案骨架成立——pi 0.84.1 投递原语的全部关键断言经实装核实**属实**（§2.2/§3.3 逐行判定见附录，无一条虚构）；D8 事件驱动的时序主链自洽；D7 副作用处置表与 dispatcher 实装逐项吻合；验收 6 场景均为真实场景。但发现两处 must-fix：①D4 对 notifier「立即投递触发」的承接语义**不等价**（isIdle ≠ hasRunningBackground），会破坏合批行为、直接违反 G4 且 S3 验收会挂；②§3.1 extension 侧 `subscribeSettled` 装配示例引用的 `pi.on` 实装**不返回 unsubscribe**，与内核端口契约形状不符，照抄即 TypeError。

---

## 五个重点方向结论

### 方向 1：事实锚点核实 —— 核心断言全部属实，1 处 API 形状不符（must-fix #2），行号偏移若干（nit #7）

逐行判定见附录 A/B。要点：

- **pi 侧断言无一虚构**：`_emitAgentSettled` 先置 `_isAgentRunActive=false` 再发事件（agent-session.js:327-336，属实）；settled 在 `_runAgentPrompt` finally、最后一次 `_handlePostAgentRun` drain 检查后发出（:744-757，属实）；`steer` 纯入队不判 idle（:984-993，属实）；prompt streaming 无 streamingBehavior 抛错（:831-834，属实）；RPC preflight 受理即回（rpc-mode.js:298-316 的 `preflightResult` 回调内 `output(success)`，且 agent-session.js:916 `preflightResult?.(true)` 先于 `await this._runAgentPrompt(messages)`——「不等 turn 跑完」有直接代码依据）；RPC 命令全集无 `send_message`（case 清单 :298-522 核实）；`get_state` 含 `pendingMessageCount`（:358，属实）。
- **`pi.on('agent_settled')` 事件存在**（types.d.ts:884）——但签名 `(event, handler): void`，不返回取消函数，见 must-fix #2。
- **本仓锚点全部属实**：notifier MERGE_WINDOW_MS=60_000 / isIdle gate / `"\n\n---\n\n"` join / steer 注释；scheduler gate 跳过 + followUp+triggerTurn + dispatchesInFlight；helpers MAX_NOTIFIED_RUN_IDS=1000（:159）；dispatcher busy 预检拒绝链；pi-engine.ts prompt 签名确无 streamingBehavior（rpc-client.ts:557-562 实现同样没有）；handleCreate/handleSend/catch 面锚点全部吻合。
- **runtime 侧 event-adapter 真能拿到 agent_settled**：`packages/runtime/src/infra/pi/event-adapter.ts:943-994` 将其 translate 为 `{kind:'agent-settled'}`，`event-interpreter.ts:378` 消费（现接 dispatcher 的 onAgentSettled 钩子）；到装配层的订阅通路是 ⛔ 项，文档 §5 待验证第 4 条已诚实标注。
- **isIdle 复核时序（D8 前提）在 runtime 侧成立**：`isGenerating=false` 在 turn_end 处理时翻转（session-service.ts:1404 `handleTurnEndSideEffects`），pi 事件流有序且 turn_end/agent_end 均先于 agent_settled 发出，故 runtime 收到 settled 时标志已翻转——但文档未声明此依赖，见 should-fix #3 的连带说明。

### 方向 2：方案有效性 —— intent 二值对 in-scope 场景覆盖完整；D8 主时序自洽；两处缺口

- **intent 覆盖度**：notifier（steer+triggerTurn）、workflow notifyDone（helpers.ts:271-278 steer+triggerTurn）、send 排队、完成回流 → `interrupt-at-turn-boundary` 可表达；scheduler（followUp+triggerTurn，runtime.ts:322）→ `after-run` 可表达。in-scope 7 场景**全覆盖**。但 D3 的论据「现网无任一 triggerTurn:false 消费者」不准确——goal 有 3 处（should-fix #4），其中 idle 时「append 不唤醒」形态 intent 二值无法表达。
- **D8 点名时序攻击（settled 后 flush 时另一写入者已置 busy）**：内核收到 settled → isIdle 复核 false → 不 flush → 消息留队 → 该新 run 结束再发 settled → 送达。只要 run 有尽头就自愈，无死锁。反向 TOCTOU（gate 判 idle、send 时 pi 已 busy）由适配器恒传 streamingBehavior 兜底（prompt streaming 分支入队不抛错，agent-session.js:836-840）；正向（gate 判 busy、pi 已 idle）走 prompt 正常路径开新 turn（:845+ 无 streaming 分支）。**自洽**。
- **缺口 1**：有 subscribeSettled 装配下 busy 等待纯事件驱动、无 watch-dog 轮询——RPC 断线丢 settled 事件则消息滞留无恢复（should-fix #3）。
- **缺口 2**：extension 侧 unsubscribe 契约无法按 §3.1 示例兑现（must-fix #2）。

### 方向 3：副作用与遗漏 —— D7 表逐项吻合；S3 字节锁声称与实际测试能力不符

- **D7 六步骤逐项核对 dispatcher 实装（message-dispatcher.ts）全部吻合**：BeforeSend hook（:94-97）/ ensureActive（:102-116）/ busy 预检拒绝（:119-127）/ lastActiveAt+isGenerating 置位（:129-130）/ workspaceService.record try-catch warn（:131-141）/ prompt 失败 message.error 广播（:147-158）。handleCreate 直投锚点（session-manager-handler.ts:138-144）与外层 catch 依赖（:74-85）属实。处置声明（放弃/保留/替换/直投）与实装链路一一对应，**无静默绕过**。
- **sendChecked「受理即回 ≠ 可达性确认」**：preflight 成功后 pi 崩溃则 steer 队列（内存态）丢失，agent 已拿 `{queued:true}`。文档 D9 durability 预留 + 失败路径表部分承认，属诚实设计取舍；但 G1 的「保证」一词过强（nit #9）。
- **遗漏**：plugin-service 两处也走 dispatcher.sendMessage（session-api.ts:209、plugin-rpc-setup.ts:131），U5 后保持现状——文档未声明（nit #10）；compaction 窗口 prompt 无条件 throw（agent-session.js:808-810，先于 streaming 分支，streamingBehavior 不救）——gate 的 `!isCompacting` 拦主路径，TOCTOU 残余由错误重试自愈，INFO 级。

### 方向 4：验收 —— 6 场景真实、回溯齐备、S5 达标；S3 有一处不可执行断言

- 6 场景全部真实场景（本地 pi CLI 实测为主 + S6 桌面实机），非单测/mock；每场景回溯 G1-G4，无孤儿；S5「单测（fake timers 锁时序）+ 真机压时序」混合——单测仅作回归锁、真机验证送达，**达标**（P0-13/14 通过）。
- 唯一问题：S3「逐字节一致（notifier 有字节锁测试锚定）」——notifier-flush.test.ts 实际断言是 `toContain`/`endsWith` 关键行锚定（:300-302），**不是字节锁**；「逐字节一致」无验证方法（should-fix #5）。

### 方向 5：内部一致性 —— 无旧 API 残留；两处实质矛盾已列为 must-fix

- D4 入口收敛后全文无 `notify()/deliver()` 旧名残留；§3.1 示例与 §3.4 接口草案字段一致（supportedPayloads/isIdle/hasPendingMessages/send/subscribeSettled + intent/mergeWindowMs）；D5/D9 与调用方 B/C 示例一致；U1-U7 与 §3.3 探针门衔接（「强发 drain 探针必须在 U2 动工前先跑」）。
- 实质矛盾即 must-fix #1（D4 承接语义）与 must-fix #2（pi.on 形状）；探针状态用语不一（should-fix #6）。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.4 D4「立即投递触发」行 | P0-12 副作用/对抗 | 声称 notifier `!hasRunningBackground() → flush` 语义「由 send() 时 `isIdle() && !hasPendingMessages()` 承接」——**两个谓词不等价**：hasRunningBackground 测后台 subagent 生命周期（合批依赖），isIdle/hasPendingMessages 测主 agent LLM 状态。反例：主 agent spawn 后已 settled（idle）+ 2 个后台 subagent 在跑 → 现状第 1 条通知进 60s 合批窗口等第 2 条合并（notifier.ts:149-153）；内核化后 isIdle=true 立即单发，永不合并。直接违反 G4 零回归，S3 合批场景会失败 | 立即投触发不能读 isIdle：或增加调用方可声明的「合批依赖探测」端口谓词，或承认该决策留在调用方（notifier 保留 hasRunningBackground 判断 + 显式 flush()），D4 改写承接声明 |
| MUST_FIX | §3.1 调用方 A `subscribeSettled: (cb) => pi.on('agent_settled', cb)` | P0-11 事实/API 形状 | 实装 `pi.on(event, handler): void`（types.d.ts:884，ExtensionAPI），**不返回 unsubscribe**；内核端口契约 `subscribeSettled?(cb): () => void`。照抄示例则内核 dispose 时调用 undefined → TypeError。事件存在、订阅存在，但示例接线不可落地，且 D8 是核心决策之一。另需核实 pi extension 无运行中注销单 handler 的机制（handler 随 extension 卸载清理），unsubscribe 语义必须靠适配器包装 | 示例改为包装层（handler 内 disposed 标志短路 / 返回 no-op + 依赖 extension 生命周期），D8 补「extension 侧 unsubscribe 语义如何兑现」说明；或内核签名改为容忍 void 返回（并声明 dispose 语义降级） |
| SHOULD_FIX | §3.3 D8 / D4 busyPolicy | P0-16/P0-12 | 有 subscribeSettled 装配下 busy 等待纯事件驱动、无轮询兜底（D4 明言「无订阅时装配退化退避」）。攻击：runtime RPC 断线重连期间 settled 事件丢失（pi 事件流不重放）→ 队列消息滞留，直到同 session 下一次活动才恢复。回流场景（U6）恰跑在长连接上 | 有订阅装配保留低频 watch-dog 轮询（如 30s 复核一次），或声明断线重连事件作为 flush 触发信号 |
| SHOULD FIX | §3.3 D3 | P0-11 事实断言 | 「现网无任一 triggerTurn:false 消费者」不准确：goal 有 3 处 triggerTurn 缺省的 pi.sendMessage 真实调用（ports.ts:84-90 options 只传 deliverAs；command-adapter.ts:307 / agent-end.ts:126 传 "steer"、agent-end.ts:195 传 "followUp"）。前两处借 agent_end post-drain 窗口（isStreaming=true 分支，intent 二值可近似表达）；command-adapter:307 在 idle 时走 append-no-turn 分支（挂上下文不唤醒），intent 二值**无法表达**。goal 虽 Out of scope，砍维度论据建立在不完整盘点上 | D3 论据限定为「in-scope 5 处无 triggerTurn:false 依赖」；§5 补一条评估项：goal sendContextMessage 若迁移需第三意图（append-no-turn）或永久留在 goal 内 |
| SHOULD_FIX | §4 S3 | P0-13/14 验收可测性 | 「单条通知文案与迁移前逐字节一致（notifier 有字节锁测试锚定）」——notifier-flush.test.ts 实际是 toContain/endsWith 关键行锚定（:300-302），非字节锁；「逐字节一致」无验证方法，断言不可执行 | 或降格为「关键内容行一致（沿用现有测试）」，或 S3 步骤补「迁移前固化 golden 全文快照入 fixtures，迁移后 diff」 |
| SHOULD_FIX | §3.3 探针表 row3/row4 | P0-16 探针状态 | 状态标「✅ 已测」但括号自述「代码路径核实……实施期补真机探针」——已测实为已核实（代码级），真机未跑。与 row6 的 ⛔ 语义不一致，读者会误以为有实测证据 | row3/4 状态改为「✅ 代码核实 + ⛔ 真机探针（U1 实施期）」双标 |
| NIT | 全文 | P1-8 行号偏移 | 不影响决策的偏移：streamingBehavior 透传 rpc-mode.js:302（文写 305）；pendingMessageCount :358（文写 357）；MAX_NOTIFIED_RUN_IDS helpers.ts:159（文写 151，notifier.ts 注释引用的 151 也是旧值）；dispatcher busy 预检 :119-127（文写 123-128）；handleCreate sendMessage :138-144（文写 139-145）；_emitAgentSettled :327-336（文写 327-334） | 按实装修正 |
| NIT | §3.4 `dedupe?: { window: number }` | P1-8 歧义 | D4 说「窗口 1000」继承 MAX_NOTIFIED_RUN_IDS（**条数** LRU），但 `window: number` 无单位标注，易误读为毫秒 | 改 `maxKeys` 或注释单位（条） |
| NIT | §1 G1 | P1-8 表述 | 「消息**保证**在目标 session 的下一 turn 边界注入」与失败路径表 settle rejected（pi 死/卡死丢队列）并存——「保证」过强 | 限定「目标 session 存活且可达期间」 |
| NIT | §3.3 D7 | P1-12 影响面 | plugin-service 两处 sendMessage（session-api.ts:209 / plugin-rpc-setup.ts:131）也走 dispatcher，U5 后保持现状——未声明 | D7 或 §1 scope 补一句「plugin 会话 API 路径保持 dispatcher 不变」 |

INFO（不计级）：pi `prompt()` 在 compaction 进行中无条件 throw（agent-session.js:808-810，**先于** streaming 分支，streamingBehavior 不救）——runtime 适配器恒传 streamingBehavior 也挡不住此错。gate 的 `!isCompacting` 拦主路径，TOCTOU 残余（gate 判 idle 后 compaction 恰开始）由内核错误重试自愈（backoff 5s 窗口），可接受；建议真机探针（row3）附带覆盖 compaction 窗口场景，失败路径表可补一行。

---

## 附录 A：§2.2 能力矩阵逐行判定

| # | 断言 | 核实证据 | 判定 |
|---|------|---------|------|
| A1 | extension sendMessage/sendUserMessage 签名（types.d.ts:924-933）+ isIdle/hasPendingMessages | types.d.ts:923-933 签名逐字吻合；ctx.isIdle :232 / ctx.hasPendingMessages :240 | 属实 |
| A2 | RPC prompt 支持 streamingBehavior（rpc-mode.js:305 透传） | rpc-mode.js:302 `streamingBehavior: command.streamingBehavior` | 属实（行号实为 302） |
| A3 | RPC steer 对 idle 纯入队（agent-session.js:986-993 只 _queueSteer 不判 idle） | steer 方法 :984-993 无 idle 分支；_queueSteer :1016-1029 仅 push+emitQueueUpdate，无 drain 触发 | 属实 |
| A4 | follow_up run 结束后注入 | _queueFollowUp :1029-1041 入 followUp 队列 + 方法注释 | 属实 |
| A5 | RPC send_message 不存在 | rpc-mode.js case 全集 :298-522 无 send_message | 属实 |
| A6 | prompt streaming 无 streamingBehavior 抛错（agent-session.js:826-838） | :831-834 throw 原文吻合 | 属实 |
| A7 | 推论 1：prompt(streamingBehavior:'steer') ≈ sendMessage({triggerTurn:true, deliverAs:'steer'}) | prompt streaming 分支 _queueSteer :836-840；idle 走正常路径；sendCustomMessage :1083-1087 triggerTurn idle → `await this._runAgentPrompt`（立即开 turn） | 属实（两侧语义等价成立） |
| A8 | 推论 2：steer 对 idle 惰性（下次活动才 drain） | 同 A3 + `_handlePostAgentRun` :781 hasQueuedMessages 仅在 run 循环内检查 | 属实 |
| A9 | 推论 3：runtime 拿不到 custom message 形态 | 同 A5 | 属实 |

## 附录 B：§3.3 运行时断言清单逐行判定

| # | 断言 | 核实证据 | 判定 |
|---|------|---------|------|
| B1 | RPC prompt 响应 = preflight 受理即回，不等 turn 跑完 | rpc-mode.js:298-316 `preflightResult` 回调内 `output(success(id,"prompt"))`；agent-session.js:913-918 `preflightResult?.(true)` 先于 `await this._runAgentPrompt(messages)` | 属实 |
| B2 | agent_settled 两层可用；_isAgentRunActive=false 先于事件 | agent-session.js:327-336（先置 false → await extension emit → this._emit）；extension 订阅者回调时 isStreaming getter（= _isAgentRunActive，:592-598）已 false；rpc-mode.js:265-270 `output(toJsonEvent(event))` 转发全事件流 | 属实 |
| B3 | prompt(streamingBehavior) streaming 时不抛错且入队 | agent-session.js:836-840 入队分支 + `preflightResult?.(true)`；代码级属实。**「已测」标示不实**（真机探针未跑，见 should-fix #6） | 代码属实；状态标示需改 |
| B4 | steer 对 idle 纯入队不唤醒 | 同 A3 | 属实（同 B3，代码级核实非实测） |
| B5 | sendMessage({triggerTurn:true}) idle 立即开 turn | sendCustomMessage :1083-1087；「现有 e2e 已覆盖」未逐一到测试文件验证（bg-notify 相关测试存在，可信度较高，标注为未逐一验证） | 属实（实装代码直接证实） |
| B6 | 退避强发经 steer 队列被 _handlePostAgentRun drain | ⛔ 实施期门 + 降级路径（丢弃+计数，U6 兜底告知）已声明 | 合规（P0-16 通过：有门有降级） |

## 附：判定与 rubric 对应

- must-fix #1 → P0-12（接管既有流程时对「立即投递」语义的等价性声明错误，read 原实现 notifier.ts:149-153 证伪）
- must-fix #2 → P0-11（API 时序/返回形态：只看事件名不读实装签名即命中——`on(): void` vs 端口要 unsubscribe）
- should-fix #3 → P0-16/P0-12（事件驱动主机制的事件丢失无兜底）
- should-fix #4 → P0-11（D3 事实断言被 goal 源码证伪，影响砍维度论据不影响 in-scope 决策）
- should-fix #5 → P0-13/14（验收断言不可执行）
- should-fix #6 → P0-16（探针状态用语）
