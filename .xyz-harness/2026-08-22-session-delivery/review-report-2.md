# 第二轮对抗式审查报告：Session 消息投递层统一设计（delivery kernel）

> 审查对象：`.xyz-harness/2026-08-22-session-delivery/design.md`（验证信息补充版，2026-08-23）
> 核实资源：`probes/` 六个归档文件全量核对 + 本仓源码与 pi 0.84.1 dist 逐锚点 read（pi 版本经 package.json 确认为 0.84.1，探针 BIN 指向该实装）
> 审查重点：① 实测记录真实性（对照 events.json 原始事件流）② 新增代码锚点复核 ③ 新结论与正文一致性 ④ 验收可操作性 ⑤ 全文 P0 例行 + 上轮处置回退检查

## Summary

**0 must-fix, 1 should-fix, 2 suggestion, 1 nit, 1 INFO。**

总判定：**可进入实施**。本轮新增的三类验证信息经逐项对抗核实全部成立——实测记录与原始事件流逐毫秒吻合、六个代码锚点行号精确命中、one-at-a-time 新事实与既有推演无矛盾；上轮 11 项处置无一回退。方案的核心风险面（pi 语义）已被真机探针压实，剩余问题集中在验收驱动模式的可操作性（1 should-fix）与实测记录的诚实性细节（2 suggestion），均不触及架构。

## 五个重点方向逐项结论

### 方向 1：实测记录真实性核验 —— 属实（附一处未交代的作废探针）

亲自 read `probes/events.json`（2847 行）、`events-p3.json`（1461 行）、`entries.json`、`entries-p3.json`，逐项核对：

| 文档声称 | events 数据 | 判定 |
|---|---|---|
| P1 streaming 中发 steer-prompt | get_state id=2 t=5507 `isStreaming=true, pending=0` | 属实 |
| P1 response `success=true` rtt=1ms | response id=3 t=5508 `success=true`（前一命令 t=5507，rtt≤1ms） | 属实 |
| P1 turn_end(7257)→turn_start(7259) 注入 | turn_end t=7257 → turn_start t=7259 + user message PROBE-P1 t=7259；entries.json entry 7（user PROBE-P1）/ entry 9（assistant 回 P1-ACK） | 属实 |
| P1 settled 后 pending=0 | settled t=9158 → get_state id=4 t=9249 `pending=0`；run 总时长 3004→9158 ≈6.15s（文档「~6s」） | 属实 |
| P3' pending 0→1 | get_state t=3824 `pending=0` → steer success → t=3825 `pending=1` | 属实 |
| P3' turn_end(6934)→turn_start(6937) 注入 | turn_end t=6934 → turn_start t=6937 + PROBE-P3B user message t=6937；entries-p3.json entry 7/9（P3B 注入 + P3B-ACK） | 属实 |
| P3' settled 后 pending=0 | settled t=9127 → get_state t=9131 `pending=0` | 属实 |
| P2 静置 12s 零 agent_start | idle steer t=11752；窗口 [11752, 23752] 内 agent_start 零增量；get_state t=23755 `pending=2` | 属实 |
| P2 逐 turn FIFO drain | prompt t=23756 → turn 1（t=23756-26382）注入滞留 PROBE-P3（t=23757）→ turn 2（t=26382-29432）注入 PROBE-P2 → settled t=29432 → pending=0（t=29517）；entries.json entry 12/13（Say OK + 滞留）/ 15（PROBE-P2）/ 16（P2-ACK） | 属实 |

**关键发现（第一次 P3 作废，文档未交代）**：events.json 铁证显示 probe-delivery.mjs 的 P3 段实际没测到目标行为——P3 prompt 响应 t=9249，run 在 t=11444 就 settled（数 25 实测仅 2.19s），固定 `sleep(2500)` 醒来后 get_state t=11751 `isStreaming=false`、`pending=0`，steer t=11752 是 idle 状态发出的。该作废 steer 成为 P2 段「pending=2（含前序滞留 1 条）」的那条滞留。P3'（probe-p3.mjs 改用 `waitUntil(assistantStreaming)` 事件同步）重跑本身严格有效，但其存在原因文档只字未提（SUGGESTION #2）。

**探针脚本逻辑缺陷评估**：P1/P2 段有效（P1 有 get_state isStreaming 前提确认）；P3 段有已实际踩中的时序缺陷；两个脚本对前提都是「console.log 打印、不 assert」——该特性在方向 4 构成验收风险。

### 方向 2：代码核实锚点复核 —— 全部属实（六锚点行号精确命中）

| 文档锚点 | 实测 | 判定 |
|---|---|---|
| `packages/runtime/src/index.ts:372` onAgentSettled 注入 | :372 `onAgentSettled: (sid) => { sessionService.flushPendingBashResults(sid) }`，单播，语义吻合 | 属实 |
| `rpc-client.ts:520` onEvent 多播返回 unsubscribe | :520-523 `onEvent(listener): () => void`，`listeners` Set（:135），分发点 :405 | 属实 |
| `event-interpreter.ts:378-381` agent-settled 消费 | :378 `case 'agent-settled':` → :381 `this.opts.onAgentSettled?.(this.sessionId)` | 属实 |
| `event-adapter.ts:943-994` translate | 注释块 :944 起 + `handleAgentSettled` :954 返回 `[{kind:'agent-settled'}]`，区间涵盖 | 属实 |
| `session-lifecycle.ts:379-383` 打标 | :379-380 spawnSource / :382-383 parentAgentSessionId；:387-388「spawnSource 单独成立」注释（文档引 :388） | 属实 |
| `process-manager.ts:367` onSessionExit | :367 签名含 `(sessionId, code, stderr)`，函数体返回 unsubscribe | 属实 |

抽查上轮已核实、本轮仍引用的 pi 侧锚点同样吻合：rpc-mode.js:265-270 全事件流转发（`output(toJsonEvent(event))`，且 events.json 中 agent_settled 事件实际存在，双重实证）；agent-session.js:327-336 `_emitAgentSettled` 先置 `_isAgentRunActive=false` 再 emit；:744-757 `_runAgentPrompt` finally 中 flush→settled、while 循环 `_handlePostAgentRun` drain。

### 方向 3：新结论与正文一致性 —— 基本属实

- **one-at-a-time 默认值属实**：settings-manager.js:460 `this.settings.steeringMode || "one-at-a-time"`；P2 实测两条排队消息分两个 turn 注入直接实证。
- **与既有推演无矛盾**：S1 单条排队场景两种 steeringMode 行为无差异，「下一 turn 开头出现第二条」成立；D4 合批在内核 merge 成一条消息入队，不受逐 turn 语义影响；U5 连发多条「连续多个 turn 开头逐条出现」与 P2 实测一致；D8「残余窗口由 pi 队列下次活动 drain 兜底」与 one-at-a-time 自洽。未发现被该事实推翻的既有断言。
- **「探针门已过」与降级路径自洽**：§3.3 row6、§5 残余风险两处均「门已过 + 降级路径保留为 pi 升级行为变化时的防御备案」，无悄悄删弱。
- **⛔ 残留核查（4 处全合法）**：§5 :428（hasPendingMessages 一期 false，S5 后评估）、:430（合并文案格式）、:432（U5 异步失败可见性依赖 U6）均为设计留白非探针状态；:452 是 §6 对上轮 should-fix #6 原文的引用（历史记录）。
- **两处小瑕**：①「推论 1/2 已升级为真机实测」过强半边——推论 1 是两侧等价声明，P1 只实测了 RPC 半边，extension 侧 `sendMessage` 半边仍是代码核实（row5 自标「用例未逐一核对」）；§4「pi 侧投递原语行为全部实测确认」同样把 row5 包了进去。② steeringMode 是用户可配置项（setSteeringMode 持久化到全局 settings），followUpMode 默认也是 one-at-a-time（:468）——文档只覆盖了 steer 队列一半（INFO 级，S1 单条排队无行为差异）。

### 方向 4：验收章节（P0-13/14/15）—— 通过，一处可操作性风险

- 六场景仍全部真实场景：S1/S2/S4/S5 本地 pi CLI 真机、S3 现有 e2e + golden 快照 diff、S6 桌面 `pnpm dev` 实机；S5 的单测仅作 fake timers 回归锁、送达验证走真机（上轮已判达标，维持）。
- 回溯完整无孤儿：G1→S1/S6、G2→S2、G3→S5（+S3/S4 间接）、G4→S3/S4。
- **「probes/ 驱动模式复用」存在假通过风险（SHOULD_FIX #1）**：S1 通过标准「下一 turn 开头出现第二条消息」在 idle 前提下同样满足（idle prompt 直接开 turn，第二条照样出现）——即该标准不能区分「streaming 排队路径被验证」与「目标早已 idle」。而文档点名的复用对象 probe-delivery.mjs 恰恰是：前提只打印不断言 + P3 段固定 sleep 2.5s 已实际作废过一次。照抄驱动模式而不改造，S1 可能在目标 session 早已 idle 时“通过”，恰好漏掉 G1 要验证的 busy 排队路径。

### 方向 5：全文 P0 例行 —— 无新引入的 P0 问题，上轮处置零回退

逐项核对上轮 11 项处置在当前文档的现状：must-fix #1（mergeHoldActive 谓词，§3.1/D4/§3.4 三处齐）、must-fix #2（disposed 包装，§3.1/D8）、should-fix #3（watch-dog 30s + §5「与通路存在性无关」明确保留）、#4（goal 论据限定 + U7 评估项）、#5（golden 快照）、#6（探针状态升级为真「已实测」且有数据支撑）、4 nit（G1 限定 / maxKeys / plugin 声明 / compaction 失败行）——全部在位，无本轮改动引入的回退或削弱。问题定义（§1 SCQA + §2.4 根因）、方案对比（4 方案）、失败路径恢复指引（5 行表）例行抽查通过。§6 审查记录与 review-report.md 逐条一致。

## Findings

| 级别 | 位置 | 维度 | 描述（证据） | 修复方向 |
|---|---|---|---|---|
| SHOULD_FIX | §4「S1/S2/S5 的真机操作复用 `probes/probe-delivery.mjs` 的驱动模式」 | P0-13/14 验收可测性 | 驱动模式含两个已知缺陷：①前提「打印不断言」（P1/P3 段的 `isStreaming` 只 console.log，不 assert）；②P3 段固定 `sleep(2500)` 已实际作废。而 S1 通过标准「下一 turn 开头出现第二条」在目标 idle 时同样满足——照抄复用则 busy 排队路径（G1 核心）未被验证也可能通过 | 验收驱动明示采 probe-p3.mjs 的事件同步模式（waitUntil assistantStreaming / get_state isStreaming 轮询）并对 streaming 前提做结构化断言；文档警示 probe-delivery.mjs 的 P3 段不可照抄 |
| SUGGESTION | §3.3 实测记录表 | P0-16 诚实性 | 第一次 P3 作废原因未交代；P2 行「含前序滞留 1 条」的滞留来源未解释，读者无法从文档复现该数字的来历 | 实测记录补作废说明：P3 首跑因固定 sleep 2.5s 晚于 run 结束（数 25 实测 2.19s）作废，P3' 改事件同步重跑，P2 的前序滞留即该次 idle steer |
| SUGGESTION | §2.2 / §4 | P0-16 探针状态用语 | 「推论 1/2…已升级为真机实测」「pi 侧投递原语行为全部实测确认」均过强：推论 1 是两侧等价声明，P1 只实测 RPC 半边，extension `sendMessage` 半边仍为代码核实。与上轮 should-fix #6 同类问题的轻微复发 | 两处限定为「RPC 半边已实测；extension 侧维持代码核实 + U3 迁移期 e2e 覆盖」 |
| NIT | §3.3 P1 实测记录 | P1-8 措辞 | 「turn_start(7259ms) PROBE 消息注入 → 下一 turn assistant 回 P1-ACK」与事件流不符：PROBE-P1 注入 turn 2 开头（t=7259），P1-ACK 是 turn 2 内的 assistant 回复（message_end t=9156 / turn_end t=9157），无 turn 3 | 改「注入后的同 turn 内 assistant 回 P1-ACK」 |
| INFO | §2.2 | 事实完备性 | steeringMode 为用户可配置项（settings-manager.js:460 默认 one-at-a-time，setSteeringMode 持久化全局 settings），followUpMode 默认同为 one-at-a-time（:468）——文档以「默认」措辞成立但未提示可配置性 | 可选：注记 steeringMode/followUpMode 属 pi 全局设置、默认值方为本推演前提 |
