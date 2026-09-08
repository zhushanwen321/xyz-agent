# 对抗式审查报告：subagent-drawer-blank.md

> 审查对象：`docs/design/subagent-drawer-blank.md`（v1）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（主审条目，跳过 P0-12/19/20）
> 交叉参照：`/tmp/subagent-drawer-blank-analysis.md`（已对抗审查的根因分析）+ 项目 AGENTS.md 约定
> 事实核验方式：文档声称的 15 项源码事实逐一 `read`/`rg` 源码核实（见附录核验清单）

## Summary

1 must-fix, 3 suggestions.

方案主体成立：三决策（兜底种 task 气泡 / 空历史不擦分区 / ActivityStrip 加 subagentThinking 条件）各自命中 §3.2 三个失败模式的根因，源码事实声称全部核实为真，验收章节真实场景、回溯目标、投入匹配。唯一的 must-fix 是 §7.2 的兜底种入与既有非 pi outcome 兜底的优先级声称与自身列出的机制矛盾——按文档字面实施会让非 pi 引擎丢 result/error 摘要（既有行为回归）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §7.2（兼 §10 T2） | P0-10 对抗 | **兜底种入使既有 outcome 兜底被短路，声称的优先级按自身机制无法达成**。文档机制：①task 气泡种入条件「空 history × 分区空 × task 非空」无引擎限定（T2 矩阵「× pi/非 pi × outcome 有/无 全组合」佐证覆盖非 pi）；②既有非 pi outcome 兜底「保持在其后」；③而 outcome 兜底的执行条件含 `chatStore.getMessages(vid).length === 0`（useSubagentTabData.ts 已核）。三者组合：非 pi + task 非空 + outcome 有值时，task 气泡先种入 → 分区非空 → outcome 兜底条件恒假 → result/error 摘要永久丢失。文档声称「outcome 有值时仍整体替换，优先级高于 task 气泡」的意图与其列出的实现机制直接矛盾——实施者按字面顺序写代码即引入非 pi 回归。T2 矩阵列了 outcome 有/无组合但全文未给该组合的期望输出，矩阵语义不完整 | 明确优先级的落地机制（三选一并写死）：a) task 种入条件排除「非 pi 且 outcome 有值」（让 outcome 兜底独占该场景）；b) outcome 兜底判定移到种入之前；c) outcome 兜底的分区空判定放宽为「分区仅含 task 兜底气泡」。同时在 §10 T2 补每个组合的期望输出（尤其「非 pi × task 非空 × outcome 有」一行） |
| SUGGESTION | §1 / §4 | P1-8 事实 | stream_delta 描述为「打字机增量，**append 语义**」、§4 图「push/**续写**」，与源码不符：applySubagentStreamDelta 头注明确「lines 每次**都是完整文本 → 用替换而非追加**」（streaming-state-machine.ts，已核）。视觉呈打字机，机制是 replace-with-fulltext。不影响决策（§6.4「无 streaming 实体时 push 新实体」的声称正确），但「append/续写」措辞会误导读者对实时腿语义的理解 | 措辞改为「替换式打字机（每帧携带累积全文）」或对齐 streaming-state-machine 头注表述 |
| SUGGESTION | §1–§7 全文 | P1-3 受众 | 内部决策编号黑话密集且无出处：E-4 / U4 A8 / u6a / D7 / W16 / OCC / D6 首现即用，未标注出自哪份设计文档；「基线投影」§1 首现无定义（语义要到 §4 图「整体替换分区」才绑定）。项目历史语境内的读者可解码，新读者不可 | 首现处补一句出处或括注（如「E-4，见 docs/design/subagent-realtime-channel」）；「基线投影」首现加半句定义（reducer 状态对分区 ref 的整体替换投影） |
| SUGGESTION | §11 ⛔1 | P0-16（降级） | 实施期验证点「双 user 过渡是否视觉平滑」有探针（S1 等待观察）但**无降级路径**——不平滑时方案怎么调整未写；对比 ⛔2 有明确降级（「超范围则登记 follow-up」）。降级为 suggestion 的理由：该点非方案成立单点依赖（替换语义已源码级确定，最坏是视觉小跳变），不构成 P0 级单点风险 | 补一句降级指引：视觉跳变不可接受时登记 follow-up（过渡动画/截断策略），不阻塞本设计交付 |

## 通过项（对抗走查后放行）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-1/2/3 结构与可读性 | 通过 | 五段齐全（§1/§2 背景 → §3 现状 → §4–§7 方案 → §8 验收 → §10 拆分）；初版无 delta 链；SCQA 开篇 + 一句话结论，§6 决策四件套（采用/被否/证据/效果） |
| P0-4 问题定义 | 通过 | §3.2 三失败模式（A 首开空白 / B 无思考指示 / C 重开擦除）忠实覆盖用户抱怨的全部现象，未停留在「体验差」表象；§3.3 根因（初始态无本地兜底 + forceWorking 已算出不消费）与已对抗审查的根因分析一致，且识别了用户未表达的隐藏问题（重开擦除是 reload 腿自伤） |
| P0-5 使用者视角 | 通过 | §3.1 现状 ASCII 图 / §5.1 终态 ASCII 图，先体验后机制 |
| P0-6 抽象术语 | 通过（主体） | forceWorking §4 给出窄口径完整定义并与源码逐字一致；遗留黑话归 SUGGESTION P1-3 |
| P0-7/8/9 方案对比 | 通过 | §6.1/6.2/6.4 每决策有被否方案 + 证据；§6.3 三方案 × 两维度（长期架构/短期成本）对比表 + 明确裁决 + 被否若用的代价推演 |
| P0-10 因果链（主体） | 通过 | 三修复各自打到根因层，非表象遮蔽。时序攻击面逐一走查成立：E-4 帧先到（分区非空 → 不种，保留真实内容）、stream_delta 先到不可能（subscribeStream 在 fetchAndInject 之后）、重开（不擦不重种）、轮终后（fetch 非空 → setMessages 权威替换，天然清兜底）、子进程零产出崩溃（气泡保留如实呈现 + forceWorking 随 cancelled/closed 翻 false 思考行消失）。唯一缺口即上述 MUST_FIX |
| P0-11 关键事实 | 通过 | 15 项声称逐一核实为真（见附录）；方案成立依赖的行为（push 新实体 / finalize 幂等 no-op / 基线投影整体替换 / setMessages 无守卫 / 帧 pre-drawer 写分区 / task=prompt）全部源码确认 |
| P0-13 验收存在且 testable | 通过 | §4（文档 §8）存在；S1–S4 均有明确通过标准（秒开即显气泡+思考行 / 内容持续在屏无闪空白 / 无残留无思考行 / 活动条行为不变），可在真实环境执行 |
| P0-14 真实场景非 mock | 通过 | 全部为 `pnpm dev` 起真实 app + 真实派发 subagent 的端到端流程；单测矩阵明确放在 §10（验收 ≠ 单测）；S1–S3 各回溯 §2 目标编号 |
| P0-15 投入匹配 | 通过 | §8.1 自评「中」改动 + 4 个真实场景 + 5 组单测矩阵，与小改大险的行为变更匹配 |
| P0-16 运行时断言探针 | 通过（主体） | §5.2/§6.4 的行为断言均附源码核验证据（✅ 形态）；§11 两个 ⛔ 实施期探针；⛔1 缺降级已单列 SUGGESTION |
| P0-17 物理数据流图 | 通过 | §4 标出全部物理位置（subagentStore 分区 / chatStore messages Map / runtime JSONL）与两条数据腿 |
| P0-18 错误恢复指引 | 通过 | §5.2 三失败路径各配具体动作（重试按钮 / 如实呈现无需动作 / 自动消失机制说明） |
| P0-21 宿主/邻居表面不变 | 通过 | S4 即反向场景：主会话 ActivityStrip 行为不变（机制上主会话 sessionId 非 virtual id → forceWorking 恒 false → subagentThinking 恒 false，源码核实 isSubagentVirtualId 前置判定）；本设计不触 renderer 之外共享系统 |
| P1-2 拆分 justification | 通过 | §10 每单元有 justification 列 |
| P1-5 MECE | 通过 | 失败模式 A/B/C 互斥（首开 / 指示 / 重开），修复①②③与之一一对应 |
| P1-6 减法优先 | 通过 | §6.4 明确拒绝给兜底气泡加标记/去重机制，依赖既有替换路径——审查曾提示的「替换会清兜底」风险被正确反转为期望终态 |
| P1-9 决策可读性 | 通过 | 三决策均「采用/被否/证据/效果」四件套 item 化 |
| P1-10 负面行为验收 | 通过 | 不擦除（S2）/ 无残留（S3）/ 无重复（S1）/ 主会话零回归（S4）均有反向验证场景 |

## 附录：事实核验清单（文档声称 → 源码证据）

| # | 文档声称 | 核验结果 |
|---|---|---|
| 1 | fetchAndInject 现状无条件 `setMessages(vid, history)`、返回 `Promise<void>` | ✅ stores/subagent.ts（`const history = await …; setMessages(virtualId, history)` 无守卫） |
| 2 | fetchAndInject 调用方仅 drawer 编排层一处 | ✅ 全仓 grep：实际调用仅 useSubagentTabData.ts:96，余为注释引用 |
| 3 | 非 pi outcome 兜底（U4 A8）存在、条件含「分区空」 | ✅ useSubagentTabData.ts `recordEngine(record) !== DEFAULT_ENGINE_ID && getMessages(vid).length === 0 && (result/error)` |
| 4 | applySubagentStreamDelta 无 streaming 实体时 push 新实体 | ✅ streaming-state-machine.ts `next.push({ id: 'sa-…', status: 'streaming', … })` |
| 5 | finalizeSubagentStream 无 streaming 实体时幂等 no-op | ✅ `if (lastAssistantIdx < 0 \|\| prev[...].status !== 'streaming') return` |
| 6 | TurnMeta 空 turn 不渲染（`v-if assistants.length > 0`） | ✅ TurnMeta.vue 模板 + u6a 头注「思考中指示迁 ActivityStrip」 |
| 7 | ActivityStrip thinking 行条件 `!compacting && !executingBash && turn === 'dispatching'` | ✅ ActivityStrip.vue rows computed |
| 8 | ActivityStrip 头注「收编三处分散的进行中指示」 | ✅ 组件头注逐字命中 |
| 9 | forceWorking = isStreamingSubagent 窄口径（running + result undefined + resumable≠true），内部 isSubagentVirtualId 前置 | ✅ MessageStream.vue + subagent store 实现 |
| 10 | setMessages「直接覆盖…不受 hydrated 守卫」 | ✅ store.ts:609 注释逐字命中 |
| 11 | 「帧先于 drawer 打开到达时也写分区」 | ✅ useMessageEffects.ts:92 注释命中 |
| 12 | i18n `panel.message.dispatching` zh「思考中…」/ en「Thinking…」 | ✅ locales/zh-CN/panel.ts:81 + en-US/panel.ts:81 |
| 13 | SubagentRecord.task 必填（「start 必带 task」） | ✅ shared/src/subagent.ts `task: string`（非 Optional） |
| 14 | 子进程首轮真实 user 消息 = task 文本 | ✅ session-runner.ts `childEnv.PI_SUBAGENT_TASK = record.task` + `sendPromptCommand(child, task)`（task 即 opts.task，record.task = opts.task） |
| 15 | 基线投影「整体替换分区」「定稿是权威」 | ✅ store.ts applySubagentEntries 注释 + reducer 整体替换实现 |
| 16 | §1「stream_delta append 语义」 | ❌ 与源码「替换而非追加」不符 → SUGGESTION（P1-8，不影响决策） |

---

# Round 2 终审（v3 修订与两个 R2 攻击点裁决）

> 审查对象：`docs/design/subagent-drawer-blank.md`（v3）
> 审查范围：**轻量终审**——只裁决 v3 修订与 R2 期两个攻击点（非 pi 叠加 / 思考行残留），禁止重查 R1 已确认项（三层根因/引用代码/派发链路/既有测试断言碰撞均已两轮核验，本轮不复核）。
> 审查依据：rubric P0-10（逼方案自证）/ P0-13/14/15（验收真实场景），本轮全部判定引用之。
> 事实核验方式：对 v3 两条新事实做源码抽查（不只重推）——下溯到 R2 核实未覆盖的三层：①级 native reader 投影语义、runtime 读取路由分支、engineHandle 运行中回填时点。

## Summary

1 must-fix, 1 suggestion.

**Verdict：有条件通过。** renderer 机制本身（§7 三处改动：空不擦 / seed 守卫 / 判定顺序）经对抗走查后**依然成立**——守卫式顺序对「哪条分支可达」不敏感，反例场景下行为恰好正确（seed + 思考行如实兜住非 pi 空白窗口）。但 v3 的核心事实链「③级永不空 ⇒ 非 pi 历史恒非空 ⇒ seed/思考行对非 pi 实际不参与」**被反例击穿**：①级 native reader 可返回 defined-but-empty 视图且不降级③级，该窗口恰是本设计要修的 drawer-blank 窗口本身。§5.1 / §2 Out-of-scope / S5 / T2 / T3 的 v3 改写建立在该错误事实上，须重写。思考行残留声明（§6.6）经抽查属实，放行。

## 三点裁决

### 裁决① v3「非 pi 实际不参与 seed/思考行」——**被反例击穿**（P0-10/P0-11，MUST_FIX）

对 task prompt 指定的三个攻击分支逐一源码走查（`session-records.ts:302` / `session-view-service.ts:473`）：

| 指定攻击分支 | 源码事实 | v3 是否被击穿 |
|---|---|---|
| runtime `!record` 分支 | `getSubagentHistory` 先 `getSubagents()`（扫主 session JSONL 提取）→ `if (!record) return []`（session-records.ts:306）；且 `getSubagents` 内 `if (!target) return []`（:295）——两处对**任意引擎**返回 `[]` | ⚠️ 次级击穿：主 session 文件未落盘/提取滞后时非 pi 也得 `[]` → seed 参与 |
| `isStrictlyUnder` 分支 | core 内仅用于 `readZcodeNativeTier` dbPath 白名单拒绝与 `readJournalTier` journalPath 白名单拒绝——拒绝都是 `return undefined` 降下一级，**从不产出空数组** | ✅ v3 在此分支成立 |
| engineHandle 缺失分支 | `handle === undefined` → `return outcomeOnlyMessages(record)`（session-view-service.ts:481）——返回③级非空结果，**不是 `[]`**（攻击前提「返回 []」不成立） | ✅ v3 在此分支成立 |

**但本轮发现决定性反例（R2 核实未覆盖的第④条路径）——①级 native reader 的 defined-empty 视图：**

1. `backfillEngineHandle`（subagent-service.ts:2157，R4 §3.4 不变量 3）：create 应答后**运行中**即回填 `record.engineHandle` 并 `reportRecordTransition` → `pi.appendEntry("subagent-record", …)` 落主 JSONL（record-store.ts:557）——注释明言「详情页中途打开可见当时进度快照」。**⇒ 运行中的 zcode record 在主 JSONL 里已带 engineHandle，读取链走①级而非③级。**
2. `collectTurns`（zcode/reader.ts:296）：「SessionView.turns 是 assistant 视角——**user 消息（任务 prompt）不进 turns**」。send 后即使 user 消息已持久化，turns 仍为空；首个 assistant content part 持久化之前恒为 `[]`。
3. `buildView` 对零消息 session 正常返回 `{ turns: [], source: 'native' }`（不抛错）→ 编排层 `if (native !== undefined) return sessionViewToMessages(native, record)`（session-view-service.ts:496）——**defined 即返回，不检查空、不降级②③级** → `turnsToMessages([])` → `[]`。

**反例时间线（可达性）**：zcode subagent 派发 → register entry 上侧边栏卡片（无 engineHandle，此时 drawer 打开走③级非空——v3 在此窗口成立）→ create 应答，engineHandle 运行中回填落盘 → subscribe/send/模型首 token 冷启动（与 §SCQA 引用的「数十秒」同量级）→ **此窗口内 drawer 打开：runtime 恒返回 `[]`**。这正是本设计要修的 drawer-blank 窗口本身，也是 S1 要求的「卡片出现后立即点击」的 zcode 对应场景。

**对 renderer 的影响（行为层无恙，叙事层崩塌）**：`[]` 回到 renderer → §7.2 判定顺序：outcome 守卫失败（running 无 result/error）→ seed 守卫命中（分区空 + task 非空）→ **非 pi 的 seed 与思考行真实参与**（task 气泡 + 思考行，UX 恰好正确）。但 v3 据错误事实做的五处改写全部失真：§5.1「恒非空/不参与/运行中无空白窗口」、§2 Out-of-scope「纯防御性兼容」（且与同节「task 气泡与思考行同适用于非 pi」自相矛盾）、S5「无 seed 参与（runtime 数据先行）」通过标准（实测必失败）、T2「实际不可达」标注、T3「非 pi 实际不触发」标注。现状（修复前）非 pi mid-run drawer **同样是空白的**——非 pi 从来不是「无空白窗口」，本设计对非 pi 是**真实修复**而非纯防御。

**修复方向**：以「③级永不空 ⇒ 恒非空」的三段论中段为假——①级 defined-empty 不降级是断点。二选一路线并全文对齐：**(a) 接受 renderer seed 为非 pi 的真实场景**（零代码改动）：§5.1 改写为「非 pi 分两窗口：engineHandle 回填前 runtime ③级给出 task+占位；回填后到首个 assistant part 持久化前 runtime 返回空 → renderer seed + 思考行接管（与 pi 同机制）」，S5 通过标准改行为导向（「drawer 秒开有 task 气泡 + 思考行，无论数据来自 runtime 还是 renderer seed」），T2/T3 标注从「不可达/防御性」改为「可达（mid-run 窗口）/主场景之一」；**(b) 修 core 读取链**（①级空 view 降级②③级，一处判空）恢复「恒非空」——但超出本设计 renderer-only scope，须登记 follow-up + §11 ⛔ 探针，且 seed 仍保留为防御。两路线都须消除 §2 Out-of-scope 与 §5.1 的自相矛盾。

### 裁决② §7.2「判定顺序即优先级」自洽性——**机制层通过**（P0-10 走查放行）

「outcome 判定先行（守卫：非 pi && 分区空 && result/error 有值）→ seed 判定随后（守卫：分区空 && task 非空，复用同一分区空守卫）」：两守卫各自独立复检分区状态，先后顺序只由代码位置决定——**该机制对「哪条分支可达」不敏感**：①级-empty 反例下 outcome 守卫自然失败（running 无 outcome）、seed 自然接管；`!record` 空返回且 record 已有 outcome 时 outcome 先行、seed 因分区非空自然跳过。已核实现有 outcome 兜底代码（useSubagentTabData.ts U4 A8 块）与 §7.2 描述的插入点一致，「既有 outcome 分支代码零改动」声称属实。关于「outcome 兜底是否死代码」：在 v3 的（错误）事实下会被判死代码，v3 也确实给了防御性定位声明（§5.1「仅在③级失效异常形态触发」）——内部自洽；但事实修正（裁决①）后 outcome 兜底与 seed 对非 pi **都是活代码**，声明无需新增、只需随裁决①的修复重新锚定（「防御性」措辞改为「真实场景」或双窗口表述）。机制本身零修改。

### 裁决③ 验收 S1–S5 真实场景可达性——**S1–S4 通过；S5 场景可达但通过标准错误**（P0-13/14，并入 MF）

- S1（pi 首开）/ S2（重开不擦除）/ S3（轮终后打开）/ S4（主会话零回归）：均为 `pnpm dev` 真实 app + 真实派发的端到端流程，窗口期真实存在（pi 首轮无 sessionFile → runtime `[]`，session-records.ts:312 `!record.sessionFile return []` 已核），通过标准可观察、回溯 §2 目标——放行。
- S5（zcode running 打开）：场景本身真实可达（即裁决①反例），但通过标准按 v3 事实书写——「runtime ③级即时给出非空历史」「无 seed 参与」在 engineHandle 回填后的主窗口内**实测必失败**（实际行为：runtime 空 → renderer seed + 思考行）。按 P0-13，期望结果与真实行为矛盾的验收不是有效验收。修复随裁决①：按所选路线改写通过标准（路线 a 为行为导向判据；路线 b 则标准成立但须先落 core 修复并把该修复纳入 S5 前置）。「③级失效模拟」子句属异常形态注入验证，作为防御路径的辅助检查可接受（主路径已是真实场景），不单独立项。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §5.1 / §2 Out-of-scope / §8.2 S5 / §10 T2 T3 | P0-11 事实（兼 P0-13 验收有效性） | v3 核心推断「③级永不空 ⇒ 非 pi 历史恒非空 ⇒ seed/思考行对非 pi 实际不参与」被反例击穿：①级 zcode native reader 对零 assistant 内容的 session 返回 defined-empty 视图（`collectTurns` 排除 user 消息 + `buildView` 不抛错），编排层 `native !== undefined` 即返回、不检查空不降级③级（session-view-service.ts:496）；且 engineHandle 经 R4 运行中回填落盘（subagent-service.ts:2157 + record-store.ts:557），mid-run record 恰好带①级钥匙——空历史窗口与本设计目标窗口重合。次级同向反例：runtime `!target`/`!record` 空返回（session-records.ts:295/306）。v3 据此改写的五处（§5.1 变体、Out-of-scope「纯防御性」、S5 通过标准、T2/T3「不可达」标注）失真，且 §2「同适用于非 pi」与 §5.1「不参与非 pi」自相矛盾 | 按裁决①路线 (a) 或 (b) 二选一并全文对齐：(a) 承认非 pi mid-run 空历史为真实场景，§5.1 改双窗口表述、S5 改行为导向通过标准、T2/T3 标注改「可达」；(b) 登记 core ①级空 view 降级修复为 follow-up + ⛔ 探针后保留现表述，seed 保留为防御。消除 §2 与 §5.1 矛盾 |
| SUGGESTION | §6.6 / §11 | P0-16（探针补强，降级 suggestion） | core 读取链潜在缺陷未登记：①级 defined-empty 不降级使③级自身注释「①②级都不可达时兜底…详情页至少有 task/结果」（session-view-service.ts:426）的意图在 mid-run 窗口失效——修复前非 pi mid-run drawer 同样空白。本设计 renderer seed 已在症状层兜住，但缺陷本体在 subagent-core，其他③级消费方（摘要卡数据源）同受影响，文档未登记 | §11 增一条 ⛔ 实施期探针/登记：向 core 维护方登记「①级空 view 应降级②③级」缺陷与证据链（本轮核验的三个源码点），独立于本设计排期 |

## 通过项（本轮攻击走查后放行）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-10 因果链（renderer 机制层） | 通过 | 三修复打到根因层（§3.3），对抗走查含本轮新增反例场景：①级-empty 窗口 → seed+思考行如实兜住（守卫复检分区态）；`!record` 窗口 → renderer 本地 record（state topic 供给）使 seed 守卫照常工作；E-4 先到/reload 非空/轮终后等 R1 已核场景不重查 |
| §6.6 思考行残留声明（R2 攻击点之二） | 通过 | `'session.subagents': 'subagents'` 确在 STATE_TYPE_KEY_MAP（message-bus.ts:153，last-value 快照 + stateSnapshot 回放）；与侧边栏 spinner 同判据同数据源，「同源同级、不新增兜底」的声明与既有架构接受度一致 |
| 指定攻击分支之 isStrictlyUnder / engineHandle | 通过（v3 成立） | 两分支均不产出空数组：白名单拒绝 = `return undefined` 降级；handle 缺失 = ③级非空投影。task prompt 攻击前提「返回 []」经核不成立 |
| §7.2 判定顺序机制 | 通过 | 裁决②：守卫式顺序对可达性不敏感，现有 outcome 代码插入点核实一致，「既有分支零改动」属实 |
| S1–S4 验收 | 通过 | 裁决③：真实场景、testable、回溯目标、投入匹配（R1 已核部分不重查） |

## 附录：本轮事实核验清单（新增声称 → 源码证据）

| # | 本轮声称 | 核验结果 |
|---|---|---|
| 1 | ③级 `outcomeOnlyMessages` 恒 push ≥1 条 assistant（`(no outcome recorded)` 占位），永不返回空数组 | ✅ session-view-service.ts:431 assistant push 无条件（`record.result ?? record.error ?? "(no outcome recorded)"`）——R2 事实本体属实 |
| 2 | engineHandle 缺失分支返回③级非空结果而非 `[]` | ✅ session-view-service.ts:481 `return outcomeOnlyMessages(record)` |
| 3 | ①级 `native !== undefined` 即返回，不检查空、不降级 | ✅ session-view-service.ts:496；`sessionViewToMessages` 对 `turns: []` 返回 `[]` |
| 4 | `collectTurns` 排除 user 消息（user 不进 turns） | ✅ zcode/reader.ts:296 注释 + `role !== 'assistant'` continue |
| 5 | `buildView` 对零消息 session 正常返回空 turns 视图（不抛错） | ✅ reader.ts:315 `collectTurns(messages=[], …)` → `turns: []` |
| 6 | engineHandle 运行中回填并落主 JSONL（mid-run record 带①级钥匙） | ✅ subagent-service.ts:2157 backfillEngineHandle（「远早于 run resolve」「详情页中途打开可见当时进度快照」）+ record-store.ts:557 `pi.appendEntry("subagent-record", …)` |
| 7 | runtime `!target` / `!record` / pi `!sessionFile` 三处空返回 | ✅ session-records.ts:295 / :306 / :312 |
| 8 | ②级 journal tier 空内容返回 undefined 降③级（不产空数组） | ✅ session-view-service.ts replayEventsToHistory「全空 → undefined」 |
| 9 | zcode mid-run 窗口真实存在（create → send → 首个 assistant part 持久化） | ✅ session-channel.ts:637 runTurn 时序（createSession → onSessionCreated → subscribe → send）+ zcode-engine.ts:447 onHandleReady 时点 |
| 10 | `session.subagents` 是 state topic（STATE_TYPE_KEY_MAP last-value 快照） | ✅ message-bus.ts:153 |
| 11 | 现有 outcome 兜底代码位置与条件（U4 A8）与 §7.2 描述一致 | ✅ useSubagentTabData.ts `recordEngine !== DEFAULT_ENGINE_ID && getMessages(vid).length === 0 && (result/error)`；注释「③级保底失效等异常形态」——既有注释本就承认空历史可达，与 v3「恒非空」表述相悖（佐证本轮裁决） |

---

# Round 2 终审补记（v4 复核：分歧裁决 + 三窗口模型 + 五处改写一致性）

> 复核范围：①v4 三窗口模型事实准确性（含对 R2 终审报告「runtime 恒返回 []」判定的分歧裁决）；②五处改写与修正后事实的一致性（v3 残留）；③S5 行为导向判据有效性。已确认项不重查。
> 复核方式：`turnsToMessages` 完整实现重读（分歧点）+ v4 文档逐节比对 + 全文残留 grep。

## 分歧裁决：v4 对 R2 终审的细节修正——**成立，本报告原判定有误**

重读 `turnsToMessages` 完整实现（session-view-service.ts:361-385）：`if (record.task.length > 0)` 的 user 消息 push 位于 **turn 循环之前**（头注明言「①②级共用投影；**user task 前置一条**」）。因此窗口 B（①级 defined-empty 视图）的投影结果是 **`[task 气泡]` 而非 `[]`**——R2 终审报告裁决①中「此窗口内 drawer 打开：runtime 恒返回 `[]`」及由此推演的「outcome 守卫失败 → seed 守卫命中 → seed 与思考行真实参与」链路，**就窗口 B 而言是错的**；impact 审查员「仅 task 一条」的判断正确，v4 修正采纳有据。据此校正后的事实面：

| 命题 | R2 终审原判 | 校正后 |
|---|---|---|
| 窗口 B runtime 返回 | `[]` | `[task user 消息]`（task 空时才为 `[]`） |
| 窗口 B seed 是否触发 | 触发 | **不触发**（history 非空 → setMessages → 分区非空 → seed 守卫失败） |
| 窗口 B 思考行是否触发 | 触发 | 触发（不变——末位无 assistant） |
| 非 pi seed 可达路径 | 窗口 B + 滞后窗口 | **仅磁盘扫描滞后窗口**（`!target`/`!record`，任意引擎）+ task 空边缘不触发 |
| v3 的 MF 是否仍成立 | 成立 | **方向成立但收窄**：v3「思考行对非 pi 实际不参与」在窗口 B 仍被击穿（触发）；「runtime ③级给出 task+占位」对窗口 B 误归属（实为①级 [task]、无占位）；「seed 不参与」仅在滞后窗口被击穿。UX 终态结论（task 气泡 + 思考行、无空白）两叙事恰好一致，机制归属不同 |

对本报告误判的成因如实登记：R2 终审对 `turnsToMessages` 只核了 turn 循环段（sed 片段起于循环体内），未回读函数头部的 task 前置 push——「事实必须 read 源码核实」的纪律在本报告自身身上失守了一次，v4 修订者的反查是对的。

## 复核① 三窗口模型事实准确性——**通过**（MF 关闭）

| 窗口 | v4 声称 | 源码核验 |
|---|---|---|
| A（register → create 应答） | 无 engineHandle → ③级 `[task, 占位 assistant]` → 思考行不触发，TurnMeta 接管 | ✅ ③级投影恒含 assistant（:431）；末位有 assistant → subagentThinking false；非空 turn → TurnMeta 渲染（u6a，前轮已核） |
| B（create 应答 → 首个 assistant content 持久化） | engineHandle 运行中回填 → ①级 defined-empty → `turnsToMessages([])` = `[task]` → seed 不触发、思考行触发 | ✅ 回填落盘（subagent-service.ts:2157 + record-store.ts:557）；`collectTurns` 排除 user 消息（reader.ts:296）；`turnsToMessages` task 前置（:364，本轮分歧点已核）；seed 守卫/思考行条件推演如上表 |
| C（content 持久化后） | ①级真实内容 | ✅ — |
| 磁盘扫描滞后（跨引擎） | `!target`/`!record` → `[]` → seed 真实触发 | ✅ session-records.ts:295/306；renderer record 由 state topic 供给，seed 守卫照常工作 |

结论段「task 气泡由 runtime ①③级投影或 renderer seed 三者之一供给，无空白窗口」「修复前窗口 B 存在仅 task 无思考行的欠佳初态，本设计思考行是真实改进」——与源码事实逐点相符。INFO 级备注（不立项）：A/B 边界存在亚秒级子情形——create 应答若先于 session 行对读者可见（正常时序不会：app-server 先建行后应答），①级抛「session 不存在」→ ②级空 → ③级 `[task+占位]`，该瞬间思考行不触发。两种子情形 task 气泡均在屏，行为导向判据天然吸收路径歧义，无需修订。

## 复核② 五处改写一致性——**通过，无 v3 残留**

全文 grep「恒非空/实际不参与/纯防御/防御性/③级即时/三重叠加」：操作节（§2/§5.1/§8.2/§10/§11）零命中；命中仅为变更历史 v3/v4 条目（v3 条目已带「【后被 R2 终审反例击穿，v4 纠正】」标注，历史不可改、标注已到位）。逐处：§2 Out-of-scope 自相矛盾已消除（「多窗口路径真实参与」+ ⛔3 范围外声明）；§5.1 三窗口模型 + 已知遗留段与 ⛔3 呼应；T2 滞后窗口标注准确（经本轮校正，滞后窗口确为非 pi seed 唯一现实路径）；T3 多窗口钉死与窗口模型一致；⛔3 证据链三点与本轮核验一致、修复方向（①级返回前判空降级）与独立排期声明齐备。

## 复核③ S5 行为导向判据——**有效验收，一处稳健性缺口（SUGGESTION）**

判据「无论数据来自 runtime ①③级投影还是 renderer seed，三要素同屏即通过」方向正确：可观察、真实场景、对数据来源路径不敏感（正是多窗口模型需要的形态）。缺口：三要素中的「思考行」是**窗口 B 特有**形态——测试者在窗口 A 点击（冷启动 app-server 时窗口 A 可达秒级，卡片出现即窗口 A 起点，「立即点击」在冷启动首任务上很可能落 A）时，屏幕为 task 气泡 + TurnMeta「工作中」行、**无思考行**——这是设计内的正确行为（窗口 A 由 TurnMeta 接管），但按字面判据 S5 判败 → 假阴性、验收 flaky。测试者无日志无法区分自己落在哪个窗口。

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §8.2 S5 | P0-13（验收确定性） | 三要素中的「思考行」绑定窗口 B 形态，冷启动首任务「立即点击」大概率落窗口 A（TurnMeta 接管、无思考行），按字面判据产生设计内正确的假阴性；测试者无日志不可区分窗口 | 中间要素改为「进行中指示（**思考行或 TurnMeta「工作中」行**，窗口 A/B 各有其一）」，或注明「若观察到 TurnMeta 形态（窗口 A）视为该要素通过」——一字之改即消除 flaky，不改场景与流程 |

「窗口 C 后重开显示真实内容」「③级失效模拟 outcome 投影不变」两个子判据维持 R2 终审已接受的结论（后者为异常形态辅助检查，主路径已真实场景）。

## 本轮判定汇总

- R2 终审 MF（P0-11）：**关闭**——v4 三窗口模型经源码逐点核验准确，五处改写与修正后事实全文一致，对 R2 报告的细节修正成立且本报告原判定已在上文如实更正。
- R2 终审 S（⛔3 登记）：**采纳确认**。
- 新增 SUGGESTION ×1（S5 判据窗口 A 假阴性），不阻塞实施。
- **Verdict：通过（0 must-fix, 1 suggestion）——设计可进入实施。**
