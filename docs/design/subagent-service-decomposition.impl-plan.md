# SubagentService 上帝类拆分 实施计划
基线: 37a53dbb7 | 来源设计: docs/design/subagent-service-decomposition.md（tech-design 对抗审查收敛版） | 日期: 2026-09-12

## 0 章节映射
| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1 背景目标（1.1 SCQA / 1.3 设计目标 G1-G4 / 1.4 in-out scope） |
| 现状域表 | §2 现状与问题分析（2.1 十九职责域全表——R0 以重测域表取代，行号仅审查期参照 / 2.2 痛点 / 2.3 根因） |
| 终态/机制 | §3 解决方案（3.1 终态结构 / 3.2 多方案对比 / 3.3 关键决策 D1-D6 / 3.4 风险与守门） |
| 验收场景表 | §4 验收（S1-S5 真实场景 + 硬指标表） |
| 下一层拆分 | §5 下一层拆分（R0-R6 单元表 + 文件改动地图 + 待验证检查点①-③） |
| 决策溯源 | 附录（决策溯源与被否谱系 5 条） |

对抗式审查证据：tech-design 对抗审查 4 轮收敛（v1 首轮双审击穿 → v2 口径修正 → v3 补归属与对账 → v4 删转发判据改绑定 R0 重生成清单），被否谱系 5 条在设计文档附录；实施期规则以 §3.3 D1-D6 为准，边界命名可微调。

## 1 目标快照

**背景/目标（§1.3 逐字摘录）**：
- **G1 尺寸与聚焦（v2 口径修正）**：壳**类体**行数 ≤ 500（`wc -l` 减去 imports / 模块常量 / 接口声明——外移后残余非类体行 ~150，文件口径不可达，见 S2 算术）；每聚合 ≤ 700 行（附算术：RunOrchestration ≈ 680 + 注入接口样板，600 不可达）；每聚合单一职责域族；改一个域不再通读其余。
- **G2 依赖单向显式**：壳组合聚合；聚合间禁止互调私有方法（需要协作的经壳编排或显式接口）；service 实例字段所有权单一（单写者）——共享 ExecutionRecord 对象内部字段的写点收口归 H4（见 D1 两级归属）。
- **G3 测试随聚合迁移**：每聚合自持测试面；God-class 级测试拆散归属；深绑内部结构的测试改写不降低断言强度（见 D6）。
- **G4 零行为变化**：纯结构重构；全量测试全绿是每步合并门槛；前置 = R0 前确认基线绿（存量红先归档豁免清单——2026-09-11 单次实测 workflow-state-root.test.ts GC 写回用例红、复跑全绿 2849 用例，疑似环境相关，R0 前归档定性）。

**Out-of-scope（§1.4）**：任何行为/语义变化（含日志文案）；跨模块的搬迁（record-store / notifier 等已是独立模块不动）；H1/H2/H4 的改动内容；orchestration/（H2 已清，S5 grep 门零命中维持）；renderer / runtime / shared（不涉本设计）。

## 2 单元表

实测基线锚定（HEAD 37a53dbb7，详见 §7 残留风险①）：壳文件 3588 物理行 / 类体 :333-:3412 / 方法 grep 口径 91 + 字段声明 17（含 queries/chatActions 聚合面 2 个）/ max-lines warning 折算 1842/1700。**下表「域 #N」指设计 §2.1 域编号，行区间为实测值**。

| Unit | 内容 | 领地（允许触碰） | 依赖 | 难度 | 验收 |
|------|------|------------------|------|------|------|
| R0 | 壳内分区整理（纯移动零抽取）：按设计 §2.1 域重排类成员 + 分区注释（实测域区间见 §7 注记，#9/#16 已随 H1 消亡、#14 已增 H2 workflow 族）；**产出三清单：①实例字段逐个归属表（实测类字段声明 17 个 + 构造器 :507 内 this.* 赋值 12 处为盘点起点）②record 字段写点通道边界表（D1 第二级，含 SyncCollect 直调 store 的落标/E1 重建投影写通道——不得改道 RecordLifecycle）③深绑测试全集（D6；实测 grep `as unknown as\|ServiceInternals` 在 execution/__tests__ 命中 28 文件，含非深绑用途，R0 重收敛）**；同时登记已知跨聚合边：壳 dispose 直改 SyncCollect 内部态 settledRescanState（收敛为显式接口）；R0 前基线绿核对（G4 前置，含 workflow-state-root.test.ts 环境红定性归档） | `packages/subagent-core/src/execution/subagent-service.ts`（纯移动）+ `packages/subagent-core/src/execution/__tests__/`（只读盘点，零改动） | 无 | medium | 三清单落盘（建议写入设计文档附录或 `docs/design/subagent-service-decomposition.r0-inventory.md`，命名建议实施可调）+ **两条机械对账通过：①清单行数 vs 类字段声明 grep 计数一致 ②写点通道表 vs record 字段赋值 grep 计数一致** + 全量测试绿（基线已先核对） |
| R1 | 抽取 SessionBaselines（域 #2，实测 :613-:730）：initSession / initForkDepthBaseline / initExecContextBaseline + 字段 pi/sessionId/mainSessionFile/sessionRootId/forkDepthBaseline/rootCwd/streamSink/isIdleFn/dialogQueue/uiRequestHandler（归属以 R0 ①清单为准）；抽取后壳委托转发，对外方法签名不变；模式打样（深绑测试改写面首次落地——运行时字段替换语义依赖「闭包经 this 读取」的用例按 D6 改写） | 壳文件 + 新增 `packages/subagent-core/src/execution/service/session-baselines.ts` + `execution/__tests__/` 对应用例改写 | R0 | medium | S2/S5 + assertReady 下沉（D4：late-bound getter 注入形态 `() => ({pi, disposed})`）不破 session 复活（initSession 后复活用例） |
| R2 | 抽取 SyncCollectDomain（域 #5，实测 :986-:1234）：collectCoordinator 装配 + E9 转账 + getCollectSyncBudget / markMembersBatchFinalized / recoverSyncCollectBatch / armSettledRescan + settledRescanState 字段；**待验证检查点①：flushBatch 依赖 service 闭包——抽取时改显式依赖注入**；D1 v3 约束：SyncCollect 直调 store 通道不改道；壳 dispose 直改 settledRescanState 跨聚合边收敛为显式接口（R0 登记项兑现） | 壳文件 + 新增 `packages/subagent-core/src/execution/service/sync-collect-domain.ts`（不动 collect-coordinator.ts——已独立模块） | R1 | medium | S2/S5 + sync 批恢复用例 + E9 先于批量 archive 时序断言 |
| R3 | 抽取 RecordLifecycle（域 #3/#4/#8/#10/#11/#13/#17/#18，实测 :731-:871 / :872-:985 / :1235-:1334 / :1419-:1503 / :1504-:1709 / :2036-:2089 / :2090-:2177 身份段 / :3200 cancel / :3277-:3412 finalize 簇）：孤儿与 manifest 恢复 / 回收面（disposeAllRecords/onParentFork/onParentNew/startGcTimer）/ 查询面 / action 网关 / close 分流 / 身份解析与 record 创建 / cancel / finalize 簇；**含域 #4 回收面（被否谱系 #3——漏列即破所有者声明）**；本聚合 = store 与终态迁移入口的唯一宿主（H4 落点，D5）——本单元只搬不改 | 壳文件 + 新增 `packages/subagent-core/src/execution/service/record-lifecycle.ts`（不动 record-store.ts / finalize-record.ts / manifest-store.ts——已独立模块） | R2 | high | S2/S5 + S1 的 close/重启链路 + 待验证检查点③：壳 dispose 编排对 RecordLifecycle 的调用顺序与现状等价（E9 先于批量 archive 时序保持） |
| R4 | 抽取 RunOrchestration（域 #6/#7/#12/#14/#15，实测 :1335-:1418 / :1710-:1829 / :1830-:2177 workflow 族 / :2250-:2760 引擎编排 / :2745-:2800 pool/worktree）+ 删过渡期冗余转发：model 解析 / execute / executeAndAwait / **H2 workflow 族整段（executeWorkflowAgent :1830 + runWorkflowEngineTask :1918 + 类外模块级 helper :3415-:3550——armWorkflowNoProgressWatchdog / bindWorkflowStreamRefresh / noteIfWorkflowNoProgressFired / outcomeToWorkflowResult / workflowCallToExecuteOptions 随族迁入）** / executeViaEngine / kickOffEngineRun / runEngineTask / adopt / finalizeEngineOutcome / settleOneShotOutcome（含 finalizeRoundToIdle wrapper）/ acquirePoolOrFinalize / resolveWorktreeHandle / releaseRoundResources；删转发判据绑定 R0 时重生成的 grep 清单（D3+：壳终态永久保留面含 getStreamSink / getSessionRootId 两个漏列活消费点）；notifyGateAllowsDelivery 壳保留 re-export（实测 :84-85 现状即 re-export notifier.ts，机制不变）；**壳化后重测 max-lines warning（§7 ④）** | 壳文件 + 新增 `packages/subagent-core/src/execution/service/run-orchestration.ts`（import 已外置的 `execution/engine/common/run-signals.ts` 仅迁移引用，文件本身不动） | R3 | high | S2/S3/S5 + workflow 派发链用例（executeWorkflowAgent 注册面/守护 arm 键/D7 收口）+ max-lines warning 消解确认（壳折算行 ≤1700） |
| R5 | 测试归位 + 守卫：God-class 级测试按聚合拆散归属（每聚合至少一个同名域测试文件，S4）；三方向循环依赖守卫（聚合间 / 聚合→壳 / 壳→聚合）+ 私有互调 grep 门（参照既有 services 循环依赖检查先例，subagent-core 侧新建；守卫落点建议 `.githooks/` 或包内 lint 规则，实施定）；assertReady 反向边（聚合→壳）三方向覆盖（D4） | `packages/subagent-core/src/execution/__tests__/`（迁移与改写）+ 守卫脚本新增落点（`.githooks/` 或 `scripts/`，实施定） | R4 | medium | S3/S4 + 守卫对存量结构零误报 + 深绑改写断言强度对照表（D6：spyOn 内部 / 字段替换 / ServiceInternals 逐文件声明改写形态） |
| R6 | 外移 Init 接口 / 模块常量 / 单例访问器至 `execution/service/` 独立文件（壳类体 ≤500 门槛达成单元，S2 口径：imports/模块常量/接口声明三类外移后残余非类体行 ~150）：SubagentQueries :156 / SubagentChatActions :178 / SubagentServiceInit :223 / SubagentServiceSessionInit :235 / 模块常量（:265-:307 段）/ 单例访问器 :3552-:3588（SERVICE_SLOT_KEY / getServiceSlot / getSubagentService / setSubagentService / createSubagentService）；**import 纪律（v4）：Init 接口 type-only；单例访问器经 barrel 直接改指向 service-bootstrap、不做壳 re-export（防壳↔bootstrap 值环）**；barrel 导出面不变（`packages/subagent-core/src/index.ts` :205/:209/:212 现状 re-export 链保持符号面）；R5 守卫扩壳侧支撑文件方向 | 壳文件 + 新增 `packages/subagent-core/src/execution/service/service-bootstrap.ts` + `packages/subagent-core/src/index.ts`（仅改 import 指向，导出符号面不变） | R5 | low | S2（壳类体 ≤500 行 + 单类成员 ≤40）+ barrel 导出面不变断言（对外消费方 subagent-actions-core ×23 处 / subprocess-agent-runner / extensions session-lifecycle / workflow index.ts 零改动）+ R5 守卫扩方向后仍绿 |

## 3 DAG 图

```mermaid
graph TD
    R0[R0 分区整理+三清单+两条机械对账] --> R1[R1 SessionBaselines]
    R1 --> R2[R2 SyncCollectDomain]
    R2 --> R3[R3 RecordLifecycle]
    R3 --> R4[R4 RunOrchestration+删过渡转发+max-lines 消解]
    R4 --> R5[R5 测试归位+三方向守卫]
    R5 --> R6[R6 外移 Init/常量/单例访问器+barrel 改指向]
```

串行主线（R0→R1→R2→R3→R4→R5→R6）。判定说明：

- **R1-R4 之间硬串行**：四个聚合抽取全部以同一物理文件 `subagent-service.ts` 为唯一操作面，strangler 式每步委托转发，并行必然 diff 冲突；且 D2 抽取序 = 依赖最少先（SessionBaselines 几乎零依赖 → SyncCollect 注入面窄 → RecordLifecycle 含回收面与 SyncCollect 时序硬耦合 → RunOrchestration 依赖前三者），顺序颠倒会造成后续单元引用未抽取的依赖。
- **R5 依赖 R4**：守卫建在终态聚合结构上（三方向 import 图在 R4 后才完整）；测试归位需各聚合文件落位后才能按域拆散。
- **R6 依赖 R5**：设计 §5 明文「R5 守卫扩壳侧支撑文件方向」——R6 产物（service-bootstrap.ts）需纳入 R5 守卫范围，R5 先建、R6 后扩。
- **R5 与 R6 理论弱并行**（R5 主领地 `__tests__`、R6 主领地壳尾部支撑符号，交集小），但守卫扩展的先后耦合（R6 需 R5 守卫存在）与同文件系改动风险，保守串行（单 dev 顺跑成本已低）。
- R0 是全部后续单元的实施依据（三清单），无依赖可立即启动。

## 4 验收场景
见设计文档 §4 S1-S5（真机阶段执行）。执行注记：S1 全功能回归（真实 GUI + 真实 LLM，六条链路含 H2 后形态的 message 冷启 resume）时点 = **R4 后终验 + 全部合并前复跑**，判据 = 与拆分前逐项一致；S2 尺寸硬指标（壳类体 ≤500 / 每聚合 ≤700 / 成员 ≤40）在 R1-R4 每步与 R6 达标时点分别机器核算；S5 全量测试（subagent-core 全量，基线 2849 用例 17s 量级 + extension 三连）为每 PR 合并门槛；S3 依赖单向由 R5 守卫机械检查接管。

## 5 偏差登记表

| 单元 | 条目 | 说明 |
|------|------|------|
| R1 | D-R1-1 SessionInit 接口本体迁聚合 | R6 的 Init 外移范围相应收窄（剩 SubagentServiceInit/常量/单例访问器） |
| R1 | D-R1-2 ENV 常量 SSOT 提前迁聚合 | D4「聚合→壳禁 import」的必然要求，属 R6 常量外移的部分提前 |
| R1 | D-R1-3 R0 清单③深绑口径缺口 | `Reflect.get(service, "字段")` 形态不在原 grep 口径，R1 补录 4 文件 6 处；R5 归位复扫时把该形态纳入口径 |
| R1 | D-R1-4 _seq 死字段删除 | 清单① B-7 兑现（删前全文件零消费复核） |
| R1 | D-R1-5 SessionInit.mode JSDoc 陈旧 | 提及的 this.sessionMode 字段早已不存在；按零行为/注释随迁原则未修，留后续清理 |
| R2 | D-R2-1 清单③三文件改写预判未发生 | flushBatch 晚绑定 deps 现读形态下 FR 深绑语义自然保留（spy 替换壳字段仍生效）；R5 归位复扫按实际形态核销 |
| R2 | D-R2-2 max-lines warning 提前消解 | 折算 1785→1640 < 1700；override 收窄/移除仍留 R4（lint 配置领地外） |
| R2 | D-R2-3 modelService 依赖窄化 | collectSyncSection 改节读取 getter，聚合不感知 ModelConfigService（读取链逐行等价） |
| R2 | D-R2-4 recoverSyncCollectBatch 转发形态 | async 方法 → 非 async 返回 Promise 单行转发（名称/参数/返回类型不变，可观察等价） |
| R3 | D-R3-1 G1 超限拆两文件 | 八域段实测 833 物理行，聚合估算 ~975 超「每聚合 ≤700」；拆 record-lifecycle.ts（终态写面，D5/H4 落点）+ record-access.ts（读建面），边界 = 终态写∣读建、组间零互调零 import。dev agent 停线报告、主 agent 核验追认（拆分边界与 D5 宿主语义吻合）。G1「聚合」计数按两文件各自达标 |
| R3 | D-R3-2 ENV_SELF_RECORD_ID 单向 import | record-access → session-baselines 常量单向引用（SSOT 所在、禁碰冻结文件故不迁）；非环非方法互调，R6 常量外移时归位独立文件 |
| R3 | D-R3-3 六个 async 方法壳转发转非 async | Promise 单行返回（D-R2-4 同款可观察等价） |
| R3 | D-R3-4 源文本守卫测试形态 | readFileSync+正则守卫（robustness-medium-batch2 M6）为清单③ grep 口径外第五类深绑，本单元实改 1 文件（守卫随本体迁聚合文件+正则适配 deps 通道字面）；R5 归位复扫口径纳入 |
| R3 | D-R3-5 聚合化后可见性放宽 | 原壳 private 方法转聚合 public（strangler 壳转发必然，非行为变化；G2 私有互调禁则不涉壳经 public 面转发） |
| R4 | **D-R4-1 G1 容量结构性不可达（主 agent 已裁决：追认超限）** | R4 域段实测 1662 物理行（设计估算 ≈680 基于 H2 workflow 族并入前的旧域表口径，已被实测证伪）> 两文件容量 2×700；拆第三文件（chat-rounds 承接 Continuation 协作面 ~450）后核心编排仍 ~850，G1 在该域不可达。裁决理由：① G1 实质目标已超额达成（壳 964 物理/444 折算 ≤500 类体目标；六个聚合单一职责域族；warning 消解）；② 为凑 700 硬拆需重走 C-5 回调链协作面，违背「聚焦」本意；③ lint 面以单列 override max:800 零余量锁定当前形态（增长即暴露，演化史注释在 eslint.config.mjs），非旧债续命式抬阈。后续若要降容 = Continuation/chat-rounds 独立成聚合的新设计决策（R5/R6 不触碰该文件主体）。设计文档 §1.3 G1 算术注记待阶段 6 回写 |
| R4 | D-R4-2 resolveWorktreeHandle 改删除 | 任务点名迁移，实测全仓零消费死方法（含测试）→ 按 B-7 `_seq` 先例删除（零行为变化），未迁入聚合 |
| R4 | D-R4-3 roundSupervisor 留壳 | B-6 预判兑现：boot 分区（initSession）与 dispose 时序消费在壳、C-6 装配闭包经壳转发 late-bound 零改动；聚合经 deps.getRoundSupervisor() 现读 |
| R4 | D-R4-4 微常量跨文件重复声明 | PRIORITY_BACKGROUND / MS_PER_SECOND / SECONDS_PER_MINUTE 两聚合各自声明（零互调零 import 约束下的值语义纯量，注释互指）；R6 模块常量外移归一 |
| R4 | D-R4-5 assertIdleTimeoutMsSafe 随域迁聚合 | 任务未点名（物理在壳生命周期分区）；唯一消费方 = R4 三入口，留壳即死代码，随域迁入 |
| R4 | D-R4-6 等价形态复刻特例 | 聚合内 `private get sessionRootId()` 转发 deps（TS 对 getter 可 null 收窄、对函数调用不收窄——runCtx 条件 spread 类型推导需属性访问形态）；新旧均为 this.sessionRootId，逐字节一致 |
| R4 | D-R4-7 r0 清单③漏列深绑文件 | workflow-agent-dispatch.test.ts 被清单定性「非深绑」，但 Reflect.get(service,"类方法") 形态是真深绑（D-R1-3 口径只扫字段未扫方法）；R5 归位复扫口径纳入方法形态 |
| R4 | D-R4-8 新聚合对 record-access 的 type-only 单向引用（主 agent 复核补录，dev 漏登记） | run-orchestration:92 / workflow-dispatch:53 各 import `ResolvedIdentity` type from "./record-access.ts"——单向、非环、type-only，与 D-R3-2 常量单向引用同款；G2「聚合间禁止互调私有方法」不涉（type 面）；R5 三方向守卫须把「type-only 单向 import」列为合法形态并纳入方向图 |
| R5 | D-R5-1 派发先例文件名错误 | 主 agent 派发提示词所指 `scripts/check-services-circular-deps.mjs` 不存在；实际先例 = `.githooks/check_no_service_cycle.py`（import 建图 + 三色 DFS）+ doc-symbol-drift 按路径触发模式，dev 正确找到并参照实现 |
| R5 | D-R5-2 同名域测试文件仅新建 1 个 | 其余五聚合沿既有行为描述性域文件为锚点（gc-timer / sync-collect-recovery 等优于模块镜像命名）；不重命名理由 = 重命名在禁碰文件制造悬空注释（subprocess-agent-runner:7 等 4 处）+ workflow-agent-dispatch 拆块需复制 ~120 行共享 harness 违反纯迁移纪律。G3 判据（每聚合自持测试面）按覆盖面达成 |
| R5 | D-R5-3 实际拆散面 = subagent-service.test.ts 单文件 | 25 个 import SubagentService 的测试文件中 24 个本就是单域/黑盒文件（域锚点 R1-R4 期已存在）；真 God-class 混合文件仅此一个（11 describe）。「pending-notifications emit (H4)」块留壳判定 = 跨域集成断言（register/unregister 散布 R3/R4/壳），被测主体是壳公共 API |
| R5 | D-R5-4 hooks 生效位置与安装器写入位置不一致（仓库既有形态，backlog）[阶段3 P3-2 补记风险面] | `core.hooksPath` 指向 worktree 局部 `…/.bare/worktrees/<name>/hooks`，install-hooks.sh 按 `git-common-dir` 写 `.bare/hooks`——不止「重跑安装器写错位置」：实际 = 生效 hook 实例与 git 内源已实质漂移（R6 守卫段注释更新未送达生效实例）+ 安装器任何后续修复永不可达生效位置 + 守卫 pre-commit 生效面 = 仅本 worktree（17 worktree 中 1 个），跨 worktree 拦截依赖 CI invariants 挂载（阶段3 P3-1 已落地 ci.yml）。长期统一方案（安装器检测 hooksPath 已设时改写该路径）超出 H3 范围，登记 backlog 待独立任务 |
| R6 | **D-R6-1 单类成员 ≤40 不可达（主 agent 已裁决：追认；数字经阶段3 P1-1 修正为 63）** | 壳类成员 = **63**（TS AST ClassDeclaration.members 全集口径：20 字段 + 31 方法 + 11 getter + 1 ctor；[阶段3 P1-1] 修正——初登记 52 系 grep 口径盲区：漏 ctor 与 10 个无修饰符 public 方法、误计 1 个括号类型字段；grep 口径若引用须注明盲区）。超限 23（63-40）主体 = strangler 转发面（11 个 baselines/collectCoordinator 转发 getter + 无修饰符转发方法族 + queries/chatActions 聚合面）——保持消费方零改动承诺（25 测试文件 + subagent-actions-core ×23 + SAR）必需；删转发让消费方直连聚合会把聚合公共面升级为跨包 API，破坏分层，更差。G1 成员数意图（防壳积累业务逻辑）实质达成：壳方法几乎全为单行转发/装配编排，「改一个域不再通读其余」已成立。与 D-R4-1 同性质（设计算术 vs 实测形态）。设计 §1.3 G1 注记待阶段 6 回写（用 AST 口径与终态数 63） |
| R6 | D-R6-2 模块常量段被 R1-R5 提前消化 | R6 实得仅 logger 留壳（设计「类体消费的常量留壳或独立叶子模块」明文背书）；ENV 常量族已随 D-R1-2/D-R3-2 在各单元归位 |
| R6 | D-R6-3 验收「全仓一处声明」与领地禁碰冲突 | 四常量在 execution 域 6 文件（dialog-queue 等）+ packages/ui + extensions 3 包的模块私有同名常量为 H3 范围外既有形态；按 D-R4-4 登记范围（两聚合）归一，service/ 域内各仅一处 |
| R6 | D-R6-4 R5 守卫多行 import 解析盲区 | R6 常量归一的多行 import 首次暴露（整块漏检 = 方向门失效）；已修（logicalImportLines 合并解析），红锚双方向复验 |
| R6 | D-R6-5 测试 import 拆行 | subagent-service.test.ts:29 唯一直引单例访问器的测试随 barrel 改指向拆 import，符号消费零变化 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|---------|
| R0 | committed | 1 | （基线后首个 commit）：18 域分区纯移动重排（独立复核 = 非注释行多重集 md5 一致 + 113 块锚点断言）+ r0-inventory.md 三清单（①34 字段重收敛口径 + 12 构造器赋值 + 7 跨聚合边；②16 直写写点通道表；③28 文件/87 命中 → 13 真深绑定性）+ 两条机械对账（34/34、16/16）+ 基线绿 2903/4；偏差 8 条登记于清单 §6（关键：impl-plan「字段 17」口径不可复现重收敛为 34；R1 字段清单漏列 uiObservability/execNesting/forkDepthAls 以清单为准；finalizeRoundToIdle 归 R4） |
| R1 | committed | 1 | 7 文件 +535/-286：session-baselines.ts 397 行聚合（≤700 达标）+ 壳转发化（折算 1842→1785）+ 跨聚合边收敛 2/7（C-2 deps 回调、C-3 disposeSessionUi）+ 深绑改写 13 处全等价（对照表在报告）+ 聚合面零变化（diff 零命中）+ 模式打样固化于聚合文件头（晚绑定 deps/窄结构类型/单写者 getter/常量 SSOT 迁移）。偏差 5 条：D-R1-1 SessionInit 接口本体迁聚合（R6 交叠预告）/ D-R1-2 4 个 ENV 常量 SSOT 提前迁（R6 部分提前）/ D-R1-3 R0 清单③ grep 口径缺 `Reflect.get(service,` 形态，补录 4 文件 6 处（R5 复扫口径纳入）/ D-R1-4 _seq 死字段删除 / D-R1-5 SessionInit.mode JSDoc 陈旧注释随迁留清 |
| R2 | committed | 1 | 2 文件 +570/-377：sync-collect-domain.ts 518 行聚合 + 壳转发化（折算 1785→1640，max-lines warning 提前消解）；检查点① 落地（flushBatch 依赖两分：聚合私有 this + 8 晚绑定 getter，service 整实例零注入）；C-1 收口（lazyDispose）+ R1 回调改接（聚合间零直写，互不 import）；D1 v3 不改道逐行自查过；E9 时序 + flush 屏障断言绿（R3 检查点③前置已锁定）；涉本域 6 个深绑文件零改写（晚绑定现读保 FR 语义）。偏差 4 条：D-R2-1 清单③三文件改写预判未发生（晚绑定形态根因，R5 按实际核销）/ D-R2-2 warning 提前消解（override 收窄仍留 R4）/ D-R2-3 modelService 窄化为节读取 getter / D-R2-4 recoverSyncCollectBatch 转发 async→非 async Promise（可观察等价） |
| R3 | committed | 1 | 62ce78dcf，4 文件 +1264/-752：**D-R3-1 拆两文件**——record-lifecycle.ts 530 行（终态写面 #4/#11/#17/#18，被否谱系#3 回收面完整在内，D5「store 与终态迁移入口唯一宿主」= H4 落点）+ record-access.ts 540 行（读建面 #3/#8/#10/#13），组间零互调零 import 已验证（唯一跨文件 import = record-access 单向引 session-baselines 常量，D-R3-2）；壳 3129→2564 物理（-565），转发全单行。检查点③ 落地：dispose 方法体 HEAD vs 工作区剔注释后逐字节一致（DISPOSE-BODY-IDENTICAL，E9→批量 archive→flush→store.dispose 时序保持）。只搬不改：机械审计 27 方法依赖通道替换后逐字节一致 + onChange 初始化器特例提取（/tmp/r3-move-audit.py 复跑 AUDIT-FINAL-PASS）。跨聚合边：C-5 收敛为 deps 回调（onRecordFinalizedCleanup + abortContinuationQueue）、C-4/C-6 留置（R4 领地/闭包天然兼容，清单①预判兑现）。深绑：7 文件零改写 + robustness-medium-batch2 M6 源文本守卫随本体迁（readFileSync 源文本正则 = 清单③口径外第五类，D-R3-4）。主 agent 独立核验：全量 2903/4 与基线逐项一致 + tsc 0 + eslint 0（max-lines 未触发）+ 三抽查（dispose diff / 零互调 grep / 审计复跑）全过。settleOneShotOutcome 等 12 处 A 通道直写按红线留壳未触碰（R4 领地） |
| R4 | committed | 1 | fa0a2162c，8 文件 +237/-1818：run-orchestration.ts 1514 物理（核心编排 30 方法 + C-4/C-5 兑现——clearContinuations/onRecordFinalizedCleanup/abortContinuationQueue 显式接口）+ workflow-dispatch.ts 536 物理（H2 workflow 族整段 + 5 helper + WorkflowNoProgressGuard）；壳 2564→964 物理（折算 444，G1 壳目标达成）；删 7 个零消费 R3 转发 + resolveWorktreeHandle 死方法（全仓 grep 代码级消费零）；eslint 壳 1700 override 移除（warning 消解）+ run-orchestration 单列 max:800 零余量（D-R4-1 裁决附条件）。审计 37/37 IDENTICAL（D7 CAS 分支 + adopt 双豁免点逐字节在聚合）；深绑改写 4 文件（continuations/settleOneShotOutcome/kickOffChatRound/Reflect.get 方法形态）。主 agent 独立核验：junit 2907 testcase 0 failure、tsc 0、三文件 lint 0/0、审计复跑 PASS、零互引 grep、D7 :969 在聚合、删转发 grep 剩余命中全为装配闭包/注释/dist。**D-R4-1 已裁决：追认超限**（详见 §5） |
| R5 | committed | 1 | eb9f56bfd（测试归位）+ 43a43b144（守卫），5 文件：run-orchestration.test.ts / model-config-service.test.ts 新建（8 用例纯移动，用例名逐字节不变）+ subagent-service.test.ts 拆散瘦身（797→640）+ scripts/check-subagent-service-boundary.mjs 三方向守卫（聚合↔聚合值 import 禁 + ALLOWED_EDGES 台账 3 条合法边 / 聚合→壳 import 禁（D4 deps 注入形态确认）/ 跨聚合私有访问禁（public 导出面白名单）+ 三色 DFS 环检测）+ install-hooks.sh pre-commit 接入（按路径触发）。六聚合域测试面落表（每聚合 ≥1 域锚点，多数沿行为描述性既有命名）；深绑四口径复扫零新欠账（R1-R4 已核销）。**红锚验证 [主 agent 独立复验]**：构造聚合→壳 import 样本守卫捕获（EXIT=2 精确定位+恢复指引）、撤除复绿；存量全绿。pre-commit 接入双形态实证（主 agent 两次 commit：跳过分支 + 守卫本体触发各一次）。主 agent 独立复跑：2903/4 逐项一致（197 文件 +2）、tsc 0、junit 迁移用例新 classname 可见。偏差 4 条：D-R5-1 派发先例文件名错误（实际先例 .githooks/check_no_service_cycle.py）/ D-R5-2 同名域文件仅新建 1（其余沿既有行为命名锚点，重命名制造悬空引用且拆共享 harness 违反纯迁移）/ D-R5-3 实际拆散面 = 单文件（24/25 文件本就单域）/ D-R5-4 hooks 生效位置与安装器写入位置不一致（仓库既有形态，backlog 统一） |
| R6 | committed | 1 | ef8f03719，9 改 + 2 新增：service-bootstrap.ts 111 行（Queries/ChatActions/Init 接口 + 单例访问器族逐字节外移，壳零 re-export 防值环）+ service-constants.ts 27 行（零依赖叶子；D-R4-4 微常量归一 + D-R3-2 ENV 常量归位兑现，守卫 ALLOWED_EDGES 删 ENV 边）；barrel 295 符号面不变（集合差双向空）+ 四消费方零改动；守卫扩支撑文件四方向 + 多行 import 解析修复（D-R6-4）+ 双红锚；壳 964→893 物理/409 折算（G1 ≤500 PASS）；**D-R6-1 主 agent 裁决追认成员 52 > 40**（33 方法含 9 转发 getter + 19 字段，strangler 转发面固有，删转发破坏零改动承诺且把聚合面升级跨包 API；G1 防壳积逻辑的实质已达成）。主 agent 独立核验：2903/4 逐项一致 + junit 2907/0 + tsc 0 + lint 0/0 + 守卫存量绿 + barrel diff 仅指向 + 常量 grep 各一处 + R3 虚构授权注释壳内残留一处顺手修正。偏差 5 条：D-R6-1 成员超限追认 / D-R6-2 常量段被 R1-R5 提前消化仅 logger 留壳（设计明文背书）/ D-R6-3 全仓归一与领地冲突按 D-R4-4 登记范围执行 / D-R6-4 守卫多行 import 盲区修复（红锚双验）/ D-R6-5 测试 import 拆行 |
| 阶段3（一致性对抗审查） | committed | 1+复审 | round-1 三分区 18 findings（2 MF / 7 S / 9 I）+ 修复轮（ce6c0fae6，主 agent 亲执 10 项：2 MF 全修 + 5 S + 3 I；8 项登记 §7 ⑪⑫）+ 聚焦复审 10/10 PASS 独立复证（TS AST 复算 63 / eslint Linter 实跑 798 折算 / YAML 解析 / 回归面全绿）+ 复审新发现 R2-1 info 当轮修（守卫裸星号 export-from + 多行 export 块覆盖，红锚双形态，ce0506700）。**0 must-fix 收口**。分区②行为等价 0 MF 0 S（9 方法逐字节一致 + 转发等价精确成立 + expect 行变更=0）——G4 红线经对抗式检验 |
| Gate A（机器门） | committed | 1 | **全绿（1 环境例外续登记）**：subagent-core 2903/4 + tsc 0｜extensions 三连 exit 0（typecheck/lint/test 22 包全过）｜全仓 pnpm run lint exit 0（eslint.config.mjs 改动后全量复验）｜守卫存量绿 + ci.yml 挂载（P3-1）｜doc-symbol-drift 绿。**抓出并修复 1 条真回归（R6 mock 失配，Gate A 存在意义的实证）**：extensions:test 3 失败——subagent-workflow 三测试文件 vi.mock 旧壳路径，R6 把单例访问器族外移 bootstrap 后 mock 失配（被测侧经 barrel 拿真实未初始化服务）；修复 = 按 barrel 实际取符号路径拆双 mock（壳 mock 留 SubagentService 假类 + bootstrap mock importOriginal 只替 get/set），首修整搬 bootstrap 致 11 失败（丢了类拦截，真实壳类构造撞测试窄桩）后定稿，6ab0d6d37，922/922 全绿。教训：**导出结构改动的连带面 = 生产消费方 + 测试 mock 面**（R6 验收「四消费方零改动」漏了 mock 面）；mock 挂点须跟「符号的 barrel 实际来源路径」而非「符号迁出前的文件」。环境例外（续 H2 Gate A 同款登记不豁免）：runtime thinking-level-effective-e2e 1 失败 = 本机模型清单查找（reasoning:false 候选缺失，47 清单），文件 H3 前最后修改（f482e73b0）、H3 链对 packages/runtime/ 零 commit 触碰、失败形态为清单查找非断言语义——与 H3 改动无因果 |
| Gate B（真机） | pending | - | |

## 7 残留风险与变更历史

- 残留风险（计划创建时点登记，实施期追加）：
  - ① **设计基线数字已过时，以当前 HEAD 重测为准**：设计头部「3255 行 / 103 类成员 / 19 域」为 H1 前基线（2026-09-10 L 批次后）。HEAD 37a53dbb7 实测：**3588 物理行**（H1 删 chat 域方法族净缩，H2 增 workflow 族净增，净 +333）；**类体 :333-:3412（约 3080 行）**；**方法 grep 口径 91（`^  (private|async|get|public )…\(`）+ 类字段声明 17（含 queries/chatActions 聚合面 2 个 readonly）+ 构造器 :507 内 this.* 赋值 12 处**——设计 103 成员口径与本实测口径不可直接互比，R0 以统一 grep 口径重收敛并落 ①清单；域行区间全面漂移（§2 单元表已逐域注记实测值，如 #5 sync 批 :986-:1234、#18 finalize 簇 :3277-:3412）。**实施一律以符号 grep 锚定，禁止按设计 §2.1 行号或本计划行号直接编辑**。
  - ② **H2 刚落地，壳文件形态有变**：executeWorkflowAgent :1830 / runWorkflowEngineTask :1918（八步迁移 + D7 收口 + D6 gate）/ 类外模块级 helper :3415-:3550（armWorkflowNoProgressWatchdog 等 5 个，WorkflowNoProgressGuard 接口 + 单例访问器前段）/ notifyGateAllowsDelivery 壳内 re-export :84-85（设计 §5 写「:257 保留 re-export」，机制不变行号漂移）/ barrel :205/:209/:212 re-export 链。各单元派发前 dev 必须先 read 当前壳文件对应段现状再动手，禁止按设计文档行号想象；H2 新增段归属已核对：workflow 族全部归 RunOrchestration（域 #14 增项，与设计 §3.1「H2 的 executeWorkflowAgent 归 RunOrchestration 协作面」一致）。
  - ③ **H2 阶段提出的 run-signals.ts 不影响抽取序**：已外置为 `packages/subagent-core/src/execution/engine/common/run-signals.ts`（83 行叶子模块，壳 :53 import mergeRunSignals）——不在类体、无 service 依赖，RunOrchestration 抽取时仅迁移 import 引用，文件本身不动；orchestration/ 亦无残留待清项（H2 W4 grep 门 createRecord 零命中维持）。本设计领地不含 orchestration/、renderer、runtime、shared。
  - ④ **engine-client.ts「545 行 lint 拆分债」口径与实测不符**：实测 `packages/subagent-core/src/execution/engine/client/engine-client.ts` = **732 行，eslint 实跑零告警**（不在任何 max-lines override 清单，折算行在阈值内）；其头部自声明职责内聚（协议客户端单类）。该文件不在本设计领地与单元表内；若实施期发现 R4 引擎编排抽取与它存在强耦合需触碰，按偏差登记表流程上报批准。
  - ⑤ **subagent-service.ts max-lines warning 处置归属 = 本设计 R4**：eslint.config.mjs :489-:495 为该文件单列 override `['warn', { max: 1700, skipBlankLines: true, skipComments: true }]`（旧位 2141 行起的逐次抬升史 + 注释明言「长期拆分（service 门面 / record 子图 / chat 轮次编排 / spawn 编排）待独立重构」= 即本设计）。当前折算 **1842 行，超阈值 142，warning 级**。R4 壳化后重测，预期消解并应同步收窄或移除该 override（移除动作属 lint 配置文件，超出 R4 领地字面，按偏差登记流程处理）；禁止在本设计实施期为它再抬阈值。
  - ⑥ **深绑测试口径膨胀**：设计 D6「≥10 个测试文件」为旧口径；实测 `execution/__tests__/` 83 个文件中 grep `as unknown as|ServiceInternals` 命中 28（含非深绑用途的断言转型）。R0 ③清单逐文件定性收敛，R1-R4 每步按清单声明改写形态，断言强度不降（S4 判据）。
  - ⑦ **待验证检查点①-③（设计 §5 末段）为实施期门**：① flushBatch 闭包拆分（R2）；② R0 三清单（R1-R4 实施依据）；③ dispose 时序等价（R3，E9 先于批量 archive 的时序约束保持）。存量红 baseline：workflow-state-root.test.ts GC 写回用例 2026-09-11 单次红、复跑全绿（2849 用例），R0 前归档定性，可复现则记录复现条件。
  - ⑧ **会话外变更警示**：计划创建时工作区存在非本设计链路的未提交改动 `M docs/design/timeout-zcode-turn-and-settled-watchdog.md`（认知外改动，本计划不触碰、不提交、不撤销）；后续单元实施前若工作区不洁，先按规则 0 请用户裁决。
  - ⑪ **阶段 6 回写清单（阶段3 遗留，主 agent 裁决归档）**：① 设计 §1.3 G1 注记——D-R4-1（run-orchestration 1506 物理/798 折算超限追认）与 D-R6-1（壳成员 63 AST 口径超限追认）的算术证伪与终值回写，**两把折算尺须对照定义**（eslint 口径 = skipBlankLines+skipComments 全文件折算；类体口径 = 减 imports/模块常量/接口声明），报告数字统一标注口径名（P3-8）；② 设计 §3.3 D3 静态清单划去 executeViaEngine（R4 已按删除判据移除，静态清单未跟——P1-2）；③ 设计 §4 S3 补「检查 4 可机械子集 = deps getter 直调形态」注记（守卫注释已先行登记——P3-4）。
  - ⑫ **守卫后续增强 backlog（阶段3 登记，非阻塞）**：① 外部→聚合方向门（execution/ 非壳非测试文件 import service/ 即红——聚合消费面 = 壳 only 的机器化，存量零消费无现实违规，P3-5）；② 守卫 selftest 模式（构造样本断言 6 检查方向全命中，可进 CI 并断言台账快照——一举解决 P3-6 红锚不可审计 + P3-9 自改自过可见性）；③ 守卫自改自过为自含守卫固有限制（P3-9，known boundary：登记须注明依据 + git 审计 + P3-1 CI PR review 面缓解）。
- 变更历史：
  - 2026-09-12 计划创建（来源设计 tech-design 对抗审查收敛版；H2 于 37a53dbb7 交付当日启动，基线 37a53dbb7）。执行依据 = 用户托管指令（H1 → H2 → H3 → H4 串行，dev-flow 全流程）。计划起草前完成现状重测：壳文件 3588 行 / 类体 :333-:3412 / 方法 91 + 字段 17 / max-lines 折算 1842/1700 warning / engine-client.ts 732 行零告警 / run-signals.ts 已外置 83 行——全部实测值已回填 §2 单元表与 §7 残留风险。
