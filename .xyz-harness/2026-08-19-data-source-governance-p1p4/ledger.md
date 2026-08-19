# data-source-governance P1-P4 状态账本

> 协调机制：cw-orchestrator（同 P0 账本 `../2026-08-19-data-source-governance-p0/ledger.md`，P0 已完成封存：W1-W5 + gate PASS）。
> 规格 SSOT = `docs/architecture/data-source-governance-plan.md` §3-§6（W6-W25 节）；父文档 = `docs/architecture/data-source-governance.md`；登记表 = `docs/architecture/data-source-registry.md`。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（打回原 builder 修复后针对性复审）。
> 并发上限 3；subagent 一律禁 git 写；每 wave 完成即 commit（主 agent 唯一 commit 出口，精确路径 add）。

## 依赖图（执行顺序依据）

- 主链：W6 → W7 → W8 → W9 → W10 → W11 → W12 → {W13 ∥ W14} → W15
- 旁链 extensions：W16 → W17（可与 P1/P2 并行，不同包）；W18 = W12 + W16 + W17 汇合
- 旁链 chat 域：W20 → W21（可与 W16-W18 并行，禁与 W13/W14 并行——同碰 core domain/chat）
- 尾部：W19（W2+W11）、W22（W21）、W23（W11+W13+W18）、W24（W2+W13）、W25（W5+W21）
- 共享文件警戒：登记表（W16/W8/W19/W23 都会改）——同波次禁止两个 wave 同时改登记表

## P1 wave 表（W6-W12）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W6 | ReplicatedState<T> 原语 | committed | 763d76e40 | verifier PASS（报告 w6-report.md：防篡改/13 用例/3118 全绿/真实性 4 项/红性验证 4 篡改全红字节还原——事件直写退化、空值跳过、去 epoch、无条件 pollTimer）。契约外增量 2 项裁决合理（dispose=ADR-0049 定时器清理必需 / isDirty=可证伪观测点）。观察：doFetch 空 catch 吞错无失败可观测通道（W7 接线补 onError）；dispose 后在途 fetch 仍写 snapshot（纯内存，JSDoc 已声明） |
| W7 | label/thinkingLevel/modelId 三实例 + 失效接线 | committed | 962e51c5e | verifier PASS（报告 w7-report.md：3124 全绿 + equivalence 7/7 含真实 pi 2 用例/红性事件直写回退变红/三值差异化手法核实/**modelId 投影事实独立证实**——pi get_state.model 是 Model 对象 `${provider}/${id}` 投影正确/WireSnapshotSchemaError 防线探针实跑/dispose ADR-0049 双路径汇入）。采样（P0.5② 首采）：5 次 get_state（播种 3 + 失效 2）恒定、p95 0.7-4.9ms 数量级——远低于阈值，与 W8 终判一并落登记表。2 minor：markDirty 计数自报 11 实测 10；mock makeState 缺 provider 字段（W8 补齐） |
| W8 | usage/queue/commands 三实例 + 频率量化 | committed | ebc6f6991 | verifier PASS（报告 w8-report.md：3131 全绿 + equivalence 14/14/**event-adapter 段级核验警戒线完好**/红性直写回退红/深度公式与 pi agent-session.ts:1428 同源/三接线无第二写路径）。量化终判（P0.5② 收口）：7 次快照 RPC 合并 p95 0.7ms——无需降级，已落登记表表头第 5 条。2 minor：protocol.ts queue_update 契约未声明 pendingMessageCount（W12 补）；usage config「contextUsage 恒在」注释不准（影响有界） |
| W9 | 删除 sessionMetaCache | committed (09a1da745) | b8db5afe7 | verifier PASS 限定范围模式（报告 w9-report.md：删除性/保留性 grep 全过 + **session-file-utils 0 行改动防误删完好** + scanner 45/45 + 三判定实证（setLabelCache 保留防 label bug 复活 / thinkingLevelSet 直发帧 / 只写不读死影子）+ 红性 TS2304）。**commit 延迟**：event-adapter-new-events.test.ts diff 混合 W21 半成品（U-adapter-1=W9 / [w21] 段=W21），主 agent 裁决等 W21 完成后按归属分两次 commit。观察：event-adapter.ts:722 过期注释 W21 收尾清理 |
| W10 | applyContextUpdate 收编 + switchModel 入 owner | committed (59c9b3137) | b8db5afe7 | verifier PASS（报告 w10-report.md：3119 一次全绿/五写点收编逐点核实/红性注入 tokenCount 直写即红/pi 侧 getContextUsage 用 this.model 窗口核实/三裁决全过——超清单 3 文件机械连带、tokenCount 恒 0 基线零 UI 消费、竞态未复现）。2 minor：index.ts:273-276 过时注释（W12 顺带清理）；session-service 两处 eslint-disable no-silent-catch 与规范张力（留 W24 评估规则误报面） |
| W11 | 非活跃 rename 短命 pi + 直写全删 + R1 allowlist 清空 | building | — | 依赖 W1/W3/W6；builder 后台运行中（L 档最重 wave：withEphemeralPi + persistHandedOff/patchSessionCwd 迁移 + R1 allowlist 清空） |
| W12 | 5 个 state 话题切实例快照发布 | pending | — | 依赖 W7/W8；5 话题各独立 commit |

## P2 wave 表（W13-W15）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W13 | session store applySnapshot 单入口 + DTO | pending | — | 依赖 W12 |
| W14 | pendingBuffer 计数 FIFO | pending | — | 依赖 W8/W12；与 W13 可并行 |
| W15 | scannedToSummary 空值守卫 | pending | — | 依赖 W13 |

## P3 wave 表（W16-W21）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W16 | subagent 扩展自描述 appendEntry | committed | 763d76e40 | verifier PASS（报告 w16-report.md：防篡改/三连绿/终态路径全景无反例/独立 pi 实测 3 entry 603-961B 复测一致/三裁决全合理）。**P-1 major 移交 W17 修复**：closeChatIdle 合成 text:"" 经 completeRecord 覆盖 record.result（close 终态快照抹空轮终真实 result——entry 重建源缺陷，W18 消费后重开 result 回退空串，verifier 实测复现根因链）。P-2 minor（字面量 vs 常量，测试钉住）/P-3 minor（登记表笔误，主 agent 已修正） |
| W17 | workflow 自描述收敛（含 W16 P-1 修复） | committed | 962e51c5e | verifier PASS（报告 w17-report.md：2230 全绿/loadAll 三分支逐行核实/P-1 修复双对抗——红性 + 反事实选项三必要性证明/**独立 pi 实测 4 条 entry 含终态 done** calls 递增证实每次 flush append/崩溃语义结构性消解）。裁决：每次 flush append（vs plan 字面迁移点）——D4「entry 可完整重建才允许 state 文件存在」硬前提的必要条件，认可。探针落表 #9（4 条/7.9-52.5KB 未触发分流）。W16 P-1 关闭（close entry result 保真 + emptyBody 契约显式化）。2 观察项领域外不阻塞 |
| W20 | applyEntry reducer + 文件重放喂入 | committed | 763d76e40 | verifier PASS（报告 w20-report.md：pi 源码逐项对照 9 类型 + 7 role 无遗漏/红性 3/3 含 legacy 删 4037 字符等价防线全线红/五决策全认可含 tsup 内联 L51298 实证）。pi 事实发现：compactionSummary/custom/branchSummary 双形态存储（message role + 专用 entry），reducer 两路径用例锁定。2 minor 移交 W21（history-rebuild-cache 过时注释顺带更新；fillToolCallOutput 生产共用勿误删） |
| W18 | runtime 消费管线（entry_appended + get_entries） | pending | — | 依赖 W12/W16/W17 |
| W19 | session_end sidecar 登记收口 | pending | — | 依赖 W2/W11；小 wave |
| W20 | applyEntry reducer + 文件重放喂入 | pending | — | 依赖 W5（已满足）；禁与 W13/W14 并行 |
| W20 | applyEntry reducer + 文件重放喂入 | committed | 763d76e40 | verifier PASS（报告 w20-report.md：pi 源码逐项对照 9 类型 + 7 role 无遗漏/红性 3/3 含 legacy 删 4037 字符等价防线全线红/五决策全认可含 tsup 内联 L51298 实证）。pi 事实发现：compactionSummary/custom/branchSummary 双形态存储（message role + 专用 entry），reducer 两路径用例锁定。2 minor 移交 W21（history-rebuild-cache 过时注释顺带更新；fillToolCallOutput 生产共用勿误删）。设计事实：modelId 快照是 `Model` 对象需投影 `${provider}/${id}`（W7 builder 发现，同样适用 W8） |
| W21 | 实时 feed 喂入 + 等价性断言升级 | committed (9bf7c9d45) | 962e51c5e | verifier PASS（报告 w21-report.md：四包全量 984/3111/3054/162 含 W9 补跑/红性双验证（丢 toolResult→等价红、跳 message→store 红）/四定案全维持——wire 上收 entry 形态、store 纯累积不投影（**W22 broadcast≡get_state 对账是硬前置**，ref 收敛项写入 W22 验收）、turnId 类型在不填（pi 无 turn 边界）、断言改 reducer 确定性）。entry_appended 段完好 + TODO(W18) 锚点。混合文件归属注记：event-interpreter W9 段与 U-adapter-1 随本 commit 入库。3 备忘：双喂收敛用例/TOPIC_TABLE 显式登记 message_end/场景 3 留 P3 gate |

## P4 wave 表（W22-W25）

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W22 | 等价性测试族全量化入 CI | committed (331beb627) | ed26b3da8 | verifier PASS（报告 w22-report.md：24 用例 21s/反证 +1000 偏移红/防空调跑对抗——恒真断言下 0 skipped 且语料守卫在位/CI 链条行号实测零改动接线/ref 收敛裁决如实——条数级无缺口、id 形态异源 = W21 定案遗留态）。残余观察：it1 stateSnapshot 手工复刻投影口径（文件头声明，生产公式漂移不复现） |
| W23 | ADR-0062 + ADR-0042 修订 + checklist | pending | — | 依赖 W11/W13/W18 |
| W24 | R2 调用图收紧 | pending | — | 依赖 W2/W13 |
| W25 | pi 升级契约测试 | building | — | 依赖 W5/W21；builder 后台运行中（pi-protocol-contract.test.ts + entry_appended 不发射事实固化 + CI 接线）；验收基线 ed26b3da8 |

## 里程碑 gate

| gate | 内容 | 状态 |
|------|------|------|
| P1 gate | 场景 1 后半（非活跃改名 + R1 归零）+ 场景 2 前半（断连自愈） | pending |
| P2 gate | 场景 2 后半（renderer 一致性） | pending |
| P3 gate | 场景 3（重开一致性）+ 场景 5（subagent 单源 + 混沌） | pending |
| P4 gate | 全场景回归 + 预防机制终态 | pending |

## 事件

- 2026-08-19 P1-P4 协调启动（用户指示「启动后续全部开发，仍然使用 cw-orchestrator 流程」）：读 plan 全 25 wave 详规 + 附录 A 路径核实；P0 已完成（五 wave + gate PASS，账本封存）。首波 W6 + W16 + W20 三并行（领地：runtime services/session/ 新增 vs extensions/subagent-workflow vs core domain/chat + runtime message-converter，互不相交）。账本 + 三份验收基线入 git。
- 2026-08-19 W6 committed（首波首个完成，verifier PASS 一轮过）：ReplicatedState 原语 13 用例 + 红性验证 4 篡改全红。W7 解锁派发（主链推进；W16/W20 builder 仍在运行）。调度警戒记入：W21 与 W18 同碰 event-adapter.ts 必须串行；登记表改动统一由主 agent 串行落表（builder 只交草稿）。
- 2026-08-19 W16 + W20 committed（双 PASS）：W16 探针落表（569-956B / 3 次生命周期，未触发分流）+ P-1 major 移交 W17（close 终态快照抹空 result）；W20 pi 双形态存储发现 + 2 minor 移交 W21。W7 builder 完成（3124 全绿，采样 5 次 get_state / p95 4.9ms 远低于阈值——P0.5② 首采），verifier 派发中。
- 2026-08-19 W21+W9 拆分入库（9bf7c9d45 / 09a1da745）→ W10（59c9b3137）→ W22（331beb627）十 wave committed。W11+W25 双 builder 后台并行派发（用户指示不阻塞等待）。**W12 暂不派**：依赖 W7/W8 虽满足，但主链 W11→W12 串行——W11 builder 在途改动含 session-service.ts（git status 实证），与 W12 领地相交；W13-W15/W18/W19/W23/W24 全部阻塞在 W11→W12 链上，(W11+W25) 即当前最大可运行并发集。W25 TaskOutput 阻塞等待曾被用户取消——后续一律不阻塞轮询，靠完成通知流转。
