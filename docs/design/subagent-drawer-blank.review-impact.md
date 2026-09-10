# subagent-drawer-blank.md 影响面审查报告（副作用/遗漏专审）

> 审查对象：`docs/design/subagent-drawer-blank.md`（v1）
> 归口：P0-12（副作用/遗漏）/ P0-19（宿主投影面）/ P0-20（代价量化）——主审领地（P0-1~11/13~18/21、P1）不在此重复判定，交接线索见 INFO-3。
> 审查方法：全部事实锚点经 `read` 源码核实（文件:行号见各 finding），未采信文档自述。

## Summary

2 must-fix, 3 suggestions.

两处 MUST_FIX 同属一个根因簇：**设计的实际辐射面大于它声明的「仅 pi 首开空白」**——①②与既有非 pi outcome 兜底在同一函数内的组合语义自相矛盾（含既有测试断言碰撞），②③实质性改变了文档声明「保持现状仅兼容」的非 pi 引擎 drawer 行为但零分析零判定。core/runtime 协议面、分区生命周期（LRU/deleteSession）、ActivityStrip 主会话消费方经核实均无未声明影响。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §7.2 | P0-12 副作用 | **outcome 兜底 × task 种入组合语义矛盾，字面机制下非 pi result/error 展示回归丢失**。现行 outcome 兜底守卫是 `chatStore.getMessages(vid).length === 0`（`useSubagentTabData.ts:103-109`）。文档规定 seed 在前（「空历史时查 getMessages(vid)…种入 task 气泡」）、outcome「保持在其后」——按此字面顺序，seed 已使分区非空 ⇒ outcome 守卫永假 ⇒ **outcome 兜底死代码化**：非 pi record 异常空历史（③级合成失效场景，`runtime/src/services/session/subagent-engine-history.ts` 三级降级全失败）时用户只见 task 气泡、丢 result/error 展示，较改前倒退。这与文档同句自声明「outcome 有值时仍整体替换，优先级高于 task 气泡」直接矛盾——「优先级高于」要求 outcome 判定先行或守卫改写，但 §7「三处改动」未列出对现行守卫的任何修改。**既有断言碰撞实证**：`subagent-tab.test.ts:431`（「RPC 返回空结果 + engine=zcode 有 result → 客户端 outcome 兜底投影渲染」）断言首 turn 同屏含 task 文本与 result 文本，字面机制下必红 | 在 §7.2 写明机制级消解语义（二选一并写死）：outcome 判定移到 seed 之前（分区空 + outcome 有值 → 整体替换，seed 自然跳过）；或 outcome 守卫改为「分区为空 **或** 分区仅含本设计种入的 task 气泡」时整体替换。同步在 §8.2 补非 pi 空历史真实场景验收（现 S1-S4 全为 pi 场景） |
| MUST_FIX | §2 Out-of-scope / §5.1 / §7.3 | P0-12 遗漏面 | **非 pi 引擎叠加面未分析，与自身 Out-of-scope 声明矛盾**。Out-of-scope 写「非 pi 引擎既有 coarse 提示与 outcome 兜底（保持现状，仅兼容）」，但：① `MessageStream.vue:232-239` 的 forceWorking **无引擎过滤**（对照 `SubagentTab.vue` coarseHintVisible 显式排除 pi——两处判据不同源是既有事实），文档 §7.3 的 subagentThinking 直接派生自 forceWorking 且未加引擎条件 ⇒ 非 pi 同样获得 task 气泡与思考行；② 非 pi 无实时腿（SubagentTab 模板注释权威：「非 pi 引擎 running 任务不支持实时流，如实提示不伪造流」）⇒ 非 pi running **全程**叠加：coarse 提示条 + task 气泡 + 「思考中…」活动行三重进行中指示，且 §5.1「产出到达后自然过渡为真实内容」对非 pi 不成立——无内容可到，思考行挂满整轮直到轮终 forceWorking 翻 false，无过渡终态。该面文档零分析、零显式判定 | §7.3 补非 pi 叠加分析并显式判定：要么给 subagentThinking 加引擎过滤（与非 pi「不伪造流」的产品语义对齐），要么接受叠放但写明量级（整轮时长）与消失条件（轮终 result 落 record）；同步修正 Out-of-scope 措辞，承认非 pi drawer 初始态被本设计改变 |
| SUGGESTION | §5.2 / §10 T5 | P0-12 邻接（AGENTS.md 关键规则 9） | **seed 气泡与 live≡reload 等价性不变量的关系未声明**。等价性守卫现覆盖主会话 applyEntry 域（`apply-entry-equivalence.test.ts` 头注：reducer 确定性 + steer 乐观气泡 E5 组 vs 文件重放；`runtime/src/__tests__/equivalence/live-reload.test.ts` 同为主会话）——subagent 虚拟分区不在守卫范围。seed 是 live 内存制造物（`task-u-<id>` 直写分区、绕过 reducer），机制上「重开必重放同判定」构造性一致（空→重种、非空→真实、E-4 基线投影自 entryStates 整体替换确定性清 seed——`store.ts:833-853` 已核），**实质不违反不变量**，但文档未做此论证，后续维护者无法分辨「例外」与「违例」 | §6.4 补一段显式论证（seed 可重放、收敛语义、与 steer 气泡先例的异同）；T5 增补「空历史下切走切回/关开重开」自动化等价断言（S2 目前仅手工场景） |
| SUGGESTION | §5.2 | P1-8 表述 | 「task 为空的 record：不种气泡，维持空白」与修复③自相矛盾：分区空 + forceWorking true ⇒ 无 turn ⇒ subagentThinking = true ⇒ 「思考中…」行**会**出现，并非维持空白。行为本身更优（指示行优于纯空白），但失败路径描述会误导验收者 | 改述为「无 task 气泡，仅思考活动行」 |
| SUGGESTION | §10 T5 | P0-12 邻接 | 「现有 subagent-tab / streaming 相关测试全绿」按字面不可达成：`subagent-tab.test.ts:447`（pi 空历史断言 0 turn、无气泡）在新行为下必然翻转；`:431`（zcode outcome 同屏断言）须按 MUST_FIX 1 的消解结果改写。T1/T2 未列出这两个已知碰撞点的更新义务 | T1/T2 注明含改写 `subagent-tab.test.ts:431/:447` 两处既有断言；T5 表述改为「更新后全绿」 |

## 判定四态（归口三项）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-12 副作用/遗漏 | **不通过**（2 MUST_FIX） | ①② 与既有非 pi outcome 兜底的组合语义矛盾且含既有断言碰撞；②③ 实际改变声明「保持现状」的非 pi 面而未分析未判定 |
| P0-19 宿主投影面 | **不适用** | 本设计零宿主/外部持久状态写入：chatStore messages Map 为 renderer 内存态；SubagentRecord 是主 session JSONL 的只读投影（本设计不写回）；无日志/产物/遥测新增写入点。分区生命周期核实无新交互：seed 内容走 `commitMessages`（`mutations.ts:28`，不触 LRU recency），虚拟 key 清理仍走 LRU 级联驱逐（`lru.ts:77` isVirtualKeyOf 前缀匹配）与 deleteSession 既有通路，与「分区 key 是否存在」无关（getMessages 缺 key 返回 `[]`） |
| P0-20 代价量化 | **通过**（附注） | 已声明代价逐条有四要素：§5.2 残留疑虑（机制级保证：E-4 投影/reload 非空两条权威路径确定性清除 + 极端场景显式判定「保留恰呈现任务」+ forceWorking=false 消失条件）；§6.3 主会话零影响（结构性论证成立：forceWorking 对非虚拟 id 恒 false，ActivityStrip 唯一消费方 `MessageStream.vue:114`，已核）；§11 两条 ⛔ 探针带降级方向（超范围登记 follow-up）。附注：非 pi 叠加面属**未声明面**，归 P0-12 处理（见 MUST_FIX 2），不计 P0-20 违反 |

## INFO（交接/备查）

- **INFO-1（agentcall 分支，Out-of-scope 建议补一句）**：本设计改动点 `loadSubagentData` 同时承载 agentcall 两段式分支（`useSubagentTabData.ts:113-121`，快照只读、无条件 `setMessages`）。机制上不受影响（改动限 `isSubagentVirtualId` 分支；agentcall 无实时腿 ⇒ 失败模式 B/C 不可能），但文档 Out-of-scope 未提及同函数的另一分支，建议显式登记防实施者误扩散。agentcall 空历史无兜底为既有缺口，与本设计无关。
- **INFO-2（已排除的影响面，供主审参考）**：以下面经 read 核实**无**未声明影响——fetchAndInject 生产调用方唯一（`useSubagentTabData.ts:96`；其余命中均为测试，忽略返回值向后兼容）；seed id `task-u-<subagentId>` 无碰撞链（虚拟分区只读，不进 msg-id-mapper clientUuid/fork 锚定链）；ActivityStrip 行序/定位无耦合（thinking 行不参与高度断言 `bindRowRef`，subagent drawer 无 composer ⇒ 无 fork notice/PendingBubble 堆叠冲突）；错误链路不变（fetch throw → loadError 面板，seed 不可达，§5.2 一致）。
- **INFO-3（交接主审，P0-11 参考）**：文档事实锚点核实**全部成立**——`setMessages`「不受 hydrated 守卫」注释（`store.ts:609`）；TurnMeta 空 turn v-if 收窄（`TurnMeta.vue:89`）；ActivityStrip thinking 条件 = `turn==='dispatching'`（`ActivityStrip.vue` rows）；isStreamingSubagent 窄口径（`subagent.ts:170-180`，resumable/轮终排除）；i18n `panel.message.dispatching` zh「思考中…」/en「Thinking…」（`i18n/locales/{zh-CN,en-US}/panel.ts:81`）；applySubagentStreamDelta 追加语义 + finalizeSubagentStream 幂等 no-op（`streaming-state-machine.ts:154-198`）；「extension 用 task 作为子进程 prompt」未独立核验（extension 侧源码未读，主审酌情定夺）。
