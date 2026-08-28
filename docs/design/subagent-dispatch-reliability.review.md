# 对抗式审查报告：subagent-dispatch-reliability.md

> 审查对象：`docs/design/subagent-dispatch-reliability.md`（2026-08-27 初稿 + 一轮方向性修订后版本）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（P0-1..P0-18 / P1-1..P1-10）· `references/doc-structure.md`
> 事实核实基线：`node_modules/@earendil-works/pi-coding-agent@0.84.1` 与 `@earendil-works/pi-agent-core@0.84.1` dist 直读（`npm ls` 核对版本一致）；`extensions/universal/subagent-workflow/src` 与 `packages/session-delivery/src` 直读；基线 session 与子 session 文件实读。所有「实测」字样均指本次审查实际 read 的结果。

## Summary

4 must-fix, 5 suggestions.

三域方案的骨架成立：F1/F2/F3 根因认定与源码证据总体扎实（本文档引用的绝大多数文件：行号经逐一核实**准确**），零宽容口径在正文/决策/验收/拆分四处**贯彻一致，未发现宽容采纳语义残留**。但存在 4 处必须修复的问题：D5 对 nextTurn 消费窗的**事实性错误**（唯一 drain 点是用户驱动的 `session.prompt()`，不是「下个 turn」）、A-strict 恒等式存在**未声明的成立前置条件**（registry 大小写孪生使 canonical 串往返不等值）、账本**销账持久化形态与 fork/branch 场景未定义**、G2「恰好一次」与 B-ledger「at-least-once」的**目标/验收自相矛盾**。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D5 / §3.2 B-ledger 选定列 | P0-11 事实 + P0-16 探针 | **nextTurn 的消费窗事实错误，动摇 D5 busy 分支选型理由。** 文档声称「streaming → deliverAs:'nextTurn'（入 _pendingNextTurnMessages，实装在**下一个 turn 的消息组装点**批量注入上下文并清空——完全避开 steeringQueue 的窄消费窗）」。实测：`_pendingNextTurnMessages` 在 `pi-coding-agent/dist/core/agent-session.js` 全文仅 3 处——声明（:95）、注入并清空（:880-883），而该注入点**只在 `session.prompt()` 内**，即仅当用户/扩展**主动提交新 prompt** 时才消费；`_runAgentPrompt`（triggerTurn 直达路径，:1089-1090）、auto-compaction 续跑（:748-750 → `agent.continue()`）、loop 内部 turn 边界均**不**消费它。失败模式：G2 的目标场景恰是「主 agent 连轴转 streaming、用户长时间不输入」——nextTurn 消息**无限期滞留内存且不落盘**（重启即灭，账本可重放但实时性承诺失真）；更危险的组合态：pending 未消费期间 settled 边沿兜底补推走 triggerTurn 直达（:1089-1090），直达**不经过 prompt() 组装点** → 旧 pending 既不注入也收不到销账事件 → 超时重放再入队 → 用户下一次 prompt 时**多条重复通知一次性涌入**且顺序倒置（旧消息在新通知之后才入上下文）。P-B1 探针只查「注入时机与完整性」，未把「prompt() 是唯一 drain 点」作为验证前提；降级路径（settled 统一直达）虽存在，但选定路径赖以成立的事实模型是错的 | 改写 D5 对 nextTurn 的行为描述为「仅在下一次有新 prompt 提交时注入」；将「主 agent 长 streaming 且无用户输入」定为 busy 主场景，把 settled 边沿直達升为 busy **主路径**（nextTurn 降为可选优化或删除）；P-B1 增加反向探针：验证 triggerTurn 直达不消费 pending 的行为与重复注入风险 |
| MUST_FIX | §3.2 域 A / §3.3 D1 / §3.1 成功路径 | P0-11 事实 + P0-10 因果链 | **「通过校验 = 子进程必然按此模型执行」恒等式有未声明的成立前置条件。** 实测 pi 实装 `resolveCliModel`（model-resolver.js:291-463）：canonical 串进 `--model` 后仍要重过 pattern 引擎，其「往返等值」并非恒等——`findExactModelReferenceMatch` 的 id 匹配是 `toLowerCase()` 相等（:97），registry 若同时存在 `GLM-5.3-Flash` 与 `glm-5.3-flash`（大小写孪生）则 idMatches=2 → 判歧义返回 undefined（:98）→ 落入 `tryMatchModel` 模糊分支（:110-127）按 localeCompare 取最大，结果不受扩展侧控制。当前 `~/.pi/agent/models-store.json` 实测 zai-coding-cn 组 ids 全为小写（glm-4.6v…glm-5.3 等 8 个）但**尚无** GLM-5.3-Flash 的小写孪生，故今日往返等值成立；然而 §2.3 自述 models-store 周期刷新会引入「小写全家桶」——孪生一旦出现，扩展侧 case-sensitive 全等校验仍命中 1 条而放行，子进程却可能解析到别的条目，G1 恒等式**静默破产**。这正是文档自己的 F1 叙事（case 漂移）的残余攻击面，方案未设防也未声明 | D1 增加孪生守卫：`assertCanonicalModelRef` 全等命中后对 registry 做 case-insensitive 复扫，存在同 id 异 case 其他条目时**拒绝放行**并在报错中说明（仍符合零宽容：不放行、不代改）；或最低限度在 D1 证据节补 P-A2 探针实证 canonical 往返等值，并把「registry 无同 id 大小写孪生」声明为恒等式的前置条件；S1 补对应负向场景 |
| MUST_FIX | §3.3 D4 / §5 U2 | P0-12 遗漏 | **账本销账状态的持久化形态与 fork/branch 场景未定义，S4「已销账号零重发」无实现锚点。** ① D4 第④步「扫未销账重放」依赖「未销账」可持久判定，但全文未写明销账记录落在哪：若仅内存（Set/LRU），重启重放会把历史已送达通知**全部重发**，S4 直接不可满足；若落主 session（追加销账 entry 或 sidecar），则需写明扫描协议。② 主 session 的 `/fork`（扩展已有 `session_before_fork` 钩子，index.ts:655）会复制 session 文件——账本与销账记录随之复制，分身与本体各自扫描重放/各自销账的语义未定义（分身要不要补投？幂等键按 session 域还是全局域？）。③ 附带核实结论（对设计**有利**，应写进文档替代推测）：经 `session-manager.js:165-186 sessionEntryToContextMessages` 实测，`pi.appendEntry` 产生的 plain custom entry（type=custom）**不参与** LLM 上下文投影（函数对非 custom_message 类型返回 []），故 ledger 本体无上下文污染问题；进入上下文的是 `appendCustomMessageEntry` 产生的 custom_message（已送达通知），两者边界值得在 D4 显式声明，避免实施者误用通道 | D4 补销账持久化设计（建议销账也走 appendEntry，重放 = 全量扫描差集）；列 fork/branch/compact 三场景的账本归属与幂等键作用域规则；显式声明「ledger 用 plain appendEntry（不进上下文）、送达通知用 sendCustomMessage（进上下文）」的通道分工 |
| MUST_FIX | §1 G2 / §4 S3、S4 vs §3.2 B-ledger 风险栏 | P0-13 + P0-10 一致性 | **「恰好一次」目标与 at-least-once 架构自相矛盾，验收按不可满足口径写死。** §1 G2 写「恰一条完成通知……重试不双发」，S3 写「grep 该 notifyId 恰 1 条 custom_message」，S4 写「累计出现次数恒为 1」；而 §3.2 B-ledger 风险栏自认「若回执扫描遗漏会出现重复注入，幂等键保证 LLM 侧可识别」——架构是 at-least-once + 幂等。JSONL 追加（pi 内部 `appendCustomMessageEntry`）与销账（扩展侧）分属两个存储、无事务，崩溃窗口（S4 恰好强杀应用）内第 2 条 entry 的出现是**构造上可能**的；把「恒为 1」当硬验收，S4 在真实竞态下会随机翻车，且与方案自身的幂等设计直接冲突（正文、决策、验收三处口径不一致，正是任务约束里定义的 must-fix 类矛盾） | G2 改述为「at-least-once 送达 + notifyId 幂等可识别 + 已销账号不重发」；S3/S4 的「恰 1 条」改为「无崩溃注入时恰 1 条；若出现重复，重复条目携带同一 notifyId 且主 agent/GUI 可识别为同一条」，把崩溃窗口例外显式化 |
| SUGGESTION | §3.2 推荐组合行 + C-raw 行 | P1-8 事实 | 推荐组合写「**A-ref** + B-ledger + C-outcome」，域 A 选定方案名实为 **A-strict**——初稿命名残留，与「A-lenient（初稿方案，已否）」同源。另：C-raw 行三栏内容错位（长期架构列写「无中间层、看起来直白」，短期成本列装的全是风险内容：「推翻 v4 B-1……30 处消费点连锁」）；「menifest」应为 manifest | 统一为 A-strict；C-raw 行内容按三栏归位；改拼写 |
| SUGGESTION | §3.2 域 A A-lenient 行 | P0-2 边界 | 「（初稿方案，已否）」是版本链指称，新读者无锚点（本判定项整体为通过：正文无「参见上版/变更摘要」；「v4 B-1」是已登记决策编号且附录自包含解释，不构成 delta 链违规） | 改为自描述：「大小写宽容采纳（已否）」 |
| SUGGESTION | §3.3 D1/D2、§2.1、§2.3 | P1-8 细节 | 四处不影响决策的细节偏差：① D1 称「resolveCliModel 第 298-462 行」，实测函数体 291-463（298 起是函数中段）；② D2 称「session-runner.ts:640 buildSpawnArgs」，函数签名确在 ~638-640，但引文 `if (params.model) args.push("--model", params.model)` 实际在 **670 行**；③ §2.3 称 models-store「本机 2026-08-27 19:20 刷新」，实测该文件 mtime 为 14:57（19:20 刷新不可复核，建议改为可验证表述）；④ §2.1 称失败子 session「首行 model_change」，实测第 1 行是 session header，model_change 在第 2 行 | read 源核准后顺手改正 |
| SUGGESTION | §2.2 通知链路图 / §2.3 F2 | P0-4 深度（不动摇选型） | 「run 收尾窗口入队 = 永久滞留内存」的丢失归因不完整：实测 `_runAgentPrompt` 的 post-run 循环（agent-session.js:748-750 + `_handlePostAgentRun` :781 `return this.agent.hasQueuedMessages()`）会在 run 结束时**自动 continue 消费残留 steering/followUp**——真正的 steer 丢失窗比文档描述更窄（最终 hasQueuedMessages 检查之后的落队窗口）；同时现状 delivery 内核还有文档未画的丢失点：busy parked 期间退避达上限 settle rejected（delivery.ts:9）、`mergeHoldActive=hasRunningBackground` 期间合批无限顺延。这些不改变 F2「内存态、at-most-once、无回执」的根因认定，B-ledger 对全部候选机制均免疫，故不阻塞；但「十余次仅 1 次」的完整机理（kernel parked/rejected 与 steer 窄窗各占多少）未钉死，会削弱 U4 观测面的设计针对性 | §2.2 补画 post-run auto-continue 与 kernel parked/rejected 两条路径；U4 的 eventLog 计数建议按丢失路径分桶（parked 拒绝 / steer 滞留 / 销账超时） |
| SUGGESTION | §3.3 D6 | P1-5/P1-8 | outcome 映射「failed = closed && error≠null」会令 parent-shutdown 合成关闭（subagent-service.ts:464-472 实测合成 result 恒写 `error: "closed due to ${reason}"`）落 failed——语义上可辩护（未完成即 failed），但这是隐式取舍；实施者可能把它当 bug「修」成 cancelled，造成与 closedReason 的派生矛盾 | D6 补一行显式声明该取舍及其与 closedReason 的对应关系 |

## P0 检查项四态判定（覆盖度）

| # | 判定 | 依据 |
|---|------|------|
| P0-1 五段骨架 | 通过 | §1(行10-33)/§2(36-94)/§3(97-211)/§4(214-240)/§5(244-279) + 附录，层声明与证据基线齐备 |
| P0-2 delta 链引用 | 通过（附残留） | 无「参见上版/变更摘要」；「v4 B-1」为已登记决策编号且附录自解释。残留一处「初稿方案，已否」→ SUGGESTION |
| P0-3 结论先行 | 通过 | 篇首一句话结论；§2 章首「本章结论」；D1-D6 标题带（选定）四件套 |
| P0-4 问题定义 | 通过 | §2.3 三根因为结构性缺失（无单一权威形态/无受理确认/写入即坍缩），非表象复述；基线 session 真实数据支撑。§2.2 丢失归因有缺口 → SUGGESTION（不动摇根因） |
| P0-5 重实现轻体验 | 通过 | §2.1 使用者视角结局表；§3.1 终态对话样例先行于机制 |
| P0-6 抽象术语 | 通过 | 账本/销账/courier/受理确认在 D4/D5/§2.3 有操作化定义并锚定实例 |
| P0-7 方案对比数量 | 通过 | 域 A 4 案 / 域 B 3 案 / 域 C 2 案 |
| P0-8 双维度评估 | 通过 | 每案长期架构+短期成本两维度齐备（C-raw 行内容错位 → SUGGESTION） |
| P0-9 明确推荐 | 通过 | 每域标注（选）+ 否因；§3.2 末推荐组合（名称笔误 → SUGGESTION） |
| P0-10 解决目标问题 | **不通过（部分）** | F2→B-ledger、F3→C-outcome 因果链成立且达根因；F1→A-strict 的核心恒等式存在未声明前置条件（registry 大小写孪生，见 MF-2）；G2 目标与 B-ledger 架构口径矛盾（见 MF-4） |
| P0-11 关键事实 | **不通过** | 逐条核实结果：**准确**——completeRecord execution-record.ts:701（gc 兜底 :708）、notifier.ts「顺序与三处同构契约一致」（:110-111）、steeringQueue 全文仅 2 个 drain 点（agent.js:243/321 精确命中）、sendCustomMessage agent-session.js:1068-1098、_emitAgentSettled 先复位 `_isAgentRunActive=false` 再 emit（:327-331）、ctx.isIdle()（extension types.d.ts:232/1213）、pi.on("message_end")（types.d.ts:890）、IDENTITY_CUSTOM_TYPE="subagent-identity" appendEntry 先例（index.ts:405）、record-store appendEntry 先例（:396/410/423/558）、THINKING_ORDER（model-resolver.ts:72）、buildSpawnArgs 直传任意串（session-runner.ts:670）、model-resolver.ts lookupModel 精确 find + paramOverride 同步抛错（:112-118/211-215）、`_pendingNextTurnMessages` 入队（:1078-1080）、session-delivery types.ts/delivery.ts 存在、基线 session 文件及 11:02:56Z toolResult / 子 session model_change→glm-5.3-highspeed + 2 条 429 全部实读命中、chatMode dedupe key `id:round`（notifier.ts:37-38/228）。**错误**——nextTurn「下一个 turn 注入」表述（唯一 drain 点 = session.prompt()，见 MF-1）；canonical 往返等值无探针且条件性成立（见 MF-2） |
| P0-12 副作用/遗漏 | **不通过** | 销账持久化形态未定义 + fork/branch 场景遗漏（MF-3）；已排除项：ledger plain appendEntry 不进 LLM 上下文（session-manager.js:165-186 实测），无污染问题 |
| P0-13 验收存在且 testable | 通过（口径矛盾另计） | S1-S5 均有场景/步骤/通过标准、真实环境无 mock、逐条标注回溯 G1/G2/G3；S3/S4「恒为 1」口径与架构矛盾 → MF-4 |
| P0-14 单测/mock/抽象断言 | 通过 | 「全部不含 mock」明示；单测定位为防回归护栏（§4 回归底线）；反向验证齐备：S2 零宽松放行、S3 cancelled 无 result、S4 已销账号零重发 |
| P0-15 投入匹配 | 通过 | 三域行为变更 + 5 个真实场景 + 反向 + 回归底线，投入与改动规模匹配 |
| P0-16 运行时断言探针 | 可能不完整 | 探针体系存在且全部 ⛔ 项带降级路径（P-A1 in-source 降级、P-B1 settled 直达、P-B2 nextTurn 自路径、P-B3 sidecar 强化）；缺口：canonical 往返等值无探针（MF-2）、P-B1 未覆盖「triggerTurn 直达不消费 pending」交互（MF-1） |
| P0-17 物理数据流图 | 通过 | §2.2 两条链路，物理位置标注（内存 steeringQueue / 主子 session JSONL / models-store.json / API） |
| P0-18 错误恢复指引 | 通过 | 失败路径 A 错误文案自带恢复动作（问句候选 + 可复制合法串 + 省略 model 继承指引）；终态铁律③明示 |

P1 抽查：P1-2 通过（U1-U4 均有「为什么这么拆」）；P1-4 通过（各域被否案 + D1-D6 被否栏）；P1-9 通过（四件套 item 化）；P1-10 通过（负面验收齐备）；P1-8 五条 → 见 SUGGESTION。

## 用户约束贯彻核查（任务专项）

零宽容口径四处一致性核查结果：**贯彻到位，无宽容采纳语义残留**。
- 正文：G1「不存在任何宽容采纳/降级改写路径」；§3.1 铁律②「系统永不代改输入」；§2.2 F1a 标注「伪装成合法」为批判性描述，非采纳语义。
- 决策：D1「不自动纠正、不放行变体、不重试」；D2 降级路径「补 source:'inherited' 标记通道**而非恢复宽松校验**」；A-lenient 行明确已否并给出否因。
- 验收：S2「系统全程零宽松放行（若本轮误放行任何非全等串即判不通过）」。
- 拆分：U1 assertCanonicalModelRef 全等校验 + 工具 description 写明大小写敏感。
- 同步期报错约束：D1「校验发生在 start 工具调用的同步期（spawn 之前、返回值之内）」+ S1「同步返回 isError……不产生任何子 session 文件、无 spawn」+ S2「无异步 notify 报错路径」，贯彻一致。
- 纠错候选仅建议：报错文案为问句式 + 「Or omit model to inherit」，无代改语义。
- 唯一残留是命名问题（A-ref 笔误，「初稿方案」指称），见 SUGGESTION。

**D2 ctxModel 继承豁免裁定**：**可接受例外，但文档的豁免理由表述有缺陷**。豁免「扩展侧 registry 复查」成立——ctxModel 是运行时已验证的 ModelInfo 对象而非自由字符串，且「缺省继承」是输入缺省而非变体放行，不违反零宽容。但 D2 的表述「ctxModel 本身就是……已被验证的事实，故豁免」掩盖了真实风险面：继承路径产出的 canonical 串与显式入参**走完全相同的 pi pattern 引擎**（buildSpawnArgs 照样拼 `--model` 字符串），孪生/刷新导致的往返漂移对两条路径同等适用——豁免的只是扩展侧复查，不是 pattern 引擎。P-A1 期门探针已覆盖此路径（值得肯定），但应把豁免理由改写为「输入缺省豁免复查，往返等值由 P-A1 把关」，并将 MF-2 的孪生守卫同样作用于继承路径。

## 结构化结论

```json
{ "report_file": "docs/design/subagent-dispatch-reliability.review.md", "must_fix": 4, "suggestion": 5 }
```
