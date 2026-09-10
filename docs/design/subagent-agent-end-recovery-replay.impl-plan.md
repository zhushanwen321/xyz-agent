# subagent-agent-end-recovery-replay 实施计划

基线: (待基线 commit 后回填) | 来源设计: `docs/design/subagent-agent-end-recovery-replay.md`（设计就绪版，commit 41d475737） | 日期: 2026-09-10

对抗审查证据: `.review/design-review-replay-r1~r5.md`（主审五轮：5+3+2+1+0 MF 收敛）+ `design-review-replay-r1~r4-impact.md`（影响面审：R4 起 0 MF 收敛）。终局 = R5 主审 0/0 + R4 影响面 0 MF。

## 0 章节映射

所有 subagent task 的坐标唯一来源，禁止自猜编号。

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1（1.1 SCQA / 1.2 系统认知与关键协议事实 / 1.3 设计目标 G1-G3 / 1.4 in-out scope） |
| 现状与根因 | §2（2.1 六环链重放 / 2.2 S2 现场 / 2.3 下游代价 / 2.4 兜底核验含 M3 缺口 / 2.5 数据流 / 2.6 根因类抽象） |
| 终态/机制 | §3（3.1 终态 / 3.2 D1-D4 移植判定表 / 3.3 决策 1-9 / 3.4 错误规格表） |
| 验收场景表 | §4（V1-V7 + V5b/V5c；章首验收分层声明：V2-V4 协议脚本对端、V1 真实 pi 端到端） |
| 下一层拆分 | §5.1 单元 M0-M5（含文件改动地图） |
| 待验证检查点 | §5.2 K1-K6 |
| 超时哲学合规 | §5.4 |

## 1 目标快照（逐字摘录设计 §1.3 / §1.4）

**G1（根除不通知）**：任何 subagent run——无论握手成败、进程死活、引擎崩否——终态必然到达主 agent（完成/失败/终止通知三选一），不存在无限等待。

**G2（通知质量）**：完成通知携带结果正文与 `session_read` 截断指针行；sessionFile 尽最大努力获取（它决定 chat 域「Full transcript」指针、冷续 resume 锚点、session-reader 取证能力），但其缺失不得阻塞通知。

**G3（防复发）**：失败类抽象为「一次性获取 + 失败不可恢复 + 下游无限保守等待」——新架构每环都必须有不依赖运气的外部熔断，且本文档把判定证据固化，防止未来重构时旧病根借尸还魂。

**Out-of-scope**（设计 §1.4）：keep-alive 后代保活编排迁回（W7 裁决域）；runtime rpc-client 双轨调和机制改造；W 系列机制任何改动；NotifyDomainPorts 加固（遗留①）；carbon 升级（遗留④，部署侧）。

## 2 单元列表

无独立 u-foundation：M1-M4 均为包内小改动，无跨单元新增共享类型/接口模块（M3 复用 subagent-core 既有 settled-watchdog 原语，M2 消费 pi-subagent-cli 既有 `requestGetStateOnce` 死导出）——M0 既是 DAG 根。

| Unit | 职责 | 领地（精确文件路径，基于本 worktree） | 依赖 | 隔离 | 验收条款 |
|------|------|--------------------------------------|------|------|----------|
| **M0 合并基底** | `git merge dev-0.9.16` → 解冲突 → 整树重置代码面（设计决策 7：`git checkout dev-0.9.16 -- packages/ && git checkout dev-0.9.16 -- eslint.config.mjs`，覆盖内容冲突 2 件/自动合并陷阱 2 件/自动保留面 5 件）；文档冲突保两套；对照 K5 预演清单 | 无新改动（纯合并+重置+归位）；**主 agent 亲自执行**（git 写操作 subagent 禁止） | — | plain | 合并后全量测试三连绿（本计划 §4 全量组）+ K5 冲突面对照无清单外意外 |
| **M1 S2 契约修复** | 设计决策 1：`get-state-handshake.ts:82-91` 两个 clearTimeout 均移入 sessionFile 命中分支（应答不完整视同未应答，保留全部既有驱动）；改写锁行为专测 `:163-192` 为契约断言（缺 sessionFile 应答 → 剩余重试照发 → 3 轮耗尽 resolve） | `packages/pi-subagent-cli/src/get-state-handshake.ts`；`packages/pi-subagent-cli/src/__tests__/get-state-handshake.test.ts` | M0 | plain | V2（协议脚本对端）+ 契约单测绿；头注「最多重试 3 次」与实现一致 |
| **M2 agent_end 惰性回补** | 设计决策 2：`spawn-runner.ts:274-276` 非 chatMode `onAgentEnd` 分支改 async 编排——同步段先置 `runEnd.endedCleanly=true`，回补段整体 try / `killChild()` 放 finally 必达；`requestGetStateOnce` 接线（K1：优先 identity tracker 的 `addStateListener`，核对签名）；K2 killChild 幂等核验 | `packages/pi-subagent-cli/src/spawn-runner.ts`；`packages/pi-subagent-cli/src/get-state-handshake.ts`（仅 K1 接线需要时，M1 已合入后串行无冲突）；新增测试 `packages/pi-subagent-cli/src/__tests__/`（agent-end 补查 fake timers 用例 + 回补链抛错 kill 仍达用例） | M1（串行：同包同文件潜在接线面，避免并行冲突） | plain | V3（spawn 期三轮不应答 + agent_end 恢复应答 → outcome.sessionFile 非空 + ≤1s）；回补链抛错用例证明 kill finally 必达 |
| **M3 workflow 域守护补挂** | 设计决策 9：SAR.run（`subprocess-agent-runner.ts:235` 起）try 块内 engine.run 派发前 arm per-run no-progress watchdog（30min）；刷新源 = journal.onEvent 包装 ∪ stream.onDelta 包装；fire = watchdog AbortController 并入 mergeTimeoutSignal 合流（:214 扩一源）→ wireAbortSignal 阶梯；disarm = finally + 桥接 listener 移除；fire 回调同步段只 abort+warn 不抛；重试语义保留（executeAgentCall 通用重试面） | `packages/subagent-core/src/execution/subprocess-agent-runner.ts`；新增测试 `packages/subagent-core/src/execution/__tests__/`（楔死 fire 链 fake timers + 产出刷新不 fire + killAll 组杀邻接 V5c + chat 域守护回归零变化 V5b）；若原语抽取需新文件归本单元领地 | M0 | plain | V5①（fire 链断言 + 刷新不 fire + agent() 收敛/journal close/重试面）+ V5b 全绿 + V5c；V5② 视 K6 核验结果降级 |
| **M4 close 兜底扫描** | 设计决策 4：新建 prompt 头键扫描器（mtime ∈ [spawnStartedAtMs, close] 候选 + 前 ~64KB 头读 + `includes(promptHead ~200字符)` + 单命中才采纳/零多命中放弃 + 采纳 warn 附审计证据 + 降级门 >64 候选或 >100ms）；close finalizer 接线（`spawn-run-pump.ts:201-216` LC-4 之后、resolveExit 之前）；整体 try-catch / resolveExit 必达；K3① prompt 逐字落盘验证 | `packages/pi-subagent-cli/src/session-file-locator.ts`（新）；`packages/pi-subagent-cli/src/spawn-run-pump.ts`（close finalizer 插入）；`packages/pi-subagent-cli/src/index.ts`（barrel）；新增测试（单命中/零命中/多命中/坏行容错/fs 异常降级） | M0 | plain | V4（全程不应答 → 扫描补上单命中；多命中构造 → 放弃+warn+run 正常终态）；fs 异常用例证明 resolveExit 必达 |
| **M5 文档与守卫** | 设计决策 8：线 B 三份文档头部修订记录（D1-D4 判定结论 + 新落点 M1-M4 + 旧实现文件已随 engines/pi 删除）；troubleshooting §12 同步；replay.md 登记 `DOC_MODULE_MAP` → `packages/pi-subagent-cli/src` 映射（drift 守卫真检查）；replay.md §4 回填验收结果 | `docs/design/subagent-agent-end-recovery.md`；`docs/design/subagent-agent-end-recovery.impl-plan.md`；`docs/design/subagent-core-unbounded-wait-audit.md`；`docs/troubleshooting.md`；`scripts/check-doc-symbol-drift.mjs`；`docs/design/subagent-agent-end-recovery-replay.md` | M1-M4 全 committed | plain | V7 机器门全绿 + drift 守卫对 replay.md 真检查非恒真 |

| **M6 mid-round 窗测试注入口**（阶段 3 审查后追加） | 补完决策 9 的验收：给 `settled-watchdog` 的 mid-round 阈值加**仅测试可达**的注入口（模块级覆盖钩子，先例 `_resetSettledWatchdogsForTest`）——**不做 env**（设计明文「中段阈值 v1 不开 env」，每个 knob 都是误配置通道；用户调短会误杀正常长任务），生产路径恒 30min。目的：让 V5② 用**秒级窗真跑全链**，把 M3 被拆成两段的 fire 链（V5① 计时→abort、V5c abort→killAll）焊成一条测试 | `packages/subagent-core/src/execution/settled-watchdog.ts`；`packages/subagent-core/src/execution/subprocess-agent-runner.ts`（仅在透传需要时）；新增测试 `packages/subagent-core/src/execution/__tests__/` | M3（**与 M3 修复条目同领地，必须串行同批**） | plain | V5② 真跑全链（秒级窗）：同一条测试内闭环「窗口到点 → fire → abort → 合流 → 取消帧 → 3s 宽限 → killAll」，且断言验的是**同一 AbortController 实例**；默认值 = 30min 有断言守护；注入后必须复位（防污染其他用例）；chat 域回归 V5b + subagent-core 全包绿 |

**领地互斥说明**：M1 与 M2 串行因同包同文件（get-state-handshake.ts 的 K1 接线面）；M1∥M3∥M4 无文件交集（pi-subagent-cli 两文件 / subagent-core 一文件）；M4 的 spawn-run-pump.ts 与 M2 的 spawn-runner.ts 是不同文件（pump≠runner），barrel index.ts 仅 M4 触碰（M2 新增函数不进 barrel，lazy 回补是 spawn-runner 内部编排）。M6 与 M3 同领地（`settled-watchdog.ts` / `subprocess-agent-runner.ts`）→ 阶段 4 必须合并为一组串行修，不得并行派发。

## 3 DAG 图

```mermaid
graph TD
    M0["M0 合并基底<br/>(主agent: merge+整树重置+三连绿)"]
    M1["M1 S2 契约修复<br/>(pi-subagent-cli)"]
    M2["M2 agent_end 惰性回补<br/>(pi-subagent-cli)"]
    M3["M3 workflow 域守护补挂<br/>(subagent-core SAR)"]
    M4["M4 close 兜底扫描<br/>(pi-subagent-cli)"]
    M5["M5 文档与守卫<br/>(docs+drift登记)"]
    M0 --> M1
    M1 --> M2
    M0 --> M3
    M0 --> M4
    M2 --> M5
    M3 --> M5
    M4 --> M5
```

并行批次：**批次 1** = M1 ∥ M3 ∥ M4（3 并发，符合 ≤5 约束）；**批次 2** = M2（M1 合入后立即开工，与批次 1 剩余并行）；**批次 3** = M5。

## 4 测试策略

命令从各包 package.json 实读（dev-0.9.16 树，M0 后在本 worktree 生效）。红线：vitest（禁 node:test），从子包目录运行；timer 测试用 fake timers；测试写删目标 mkdtempSync 自建自删，禁碰真实数据目录（fs-guard 已挂 pi-subagent-cli 与 subagent-core vitest）。

**增量（单元开发期）**：

| 包 | 命令 |
|----|------|
| pi-subagent-cli | `cd packages/pi-subagent-cli && pnpm test`（vitest run）+ `pnpm typecheck` |
| subagent-core | `cd packages/subagent-core && pnpm test` + `pnpm typecheck` |

**全量（M0 基底验收 + 收尾 Gate A / V7 机器门）**：

```bash
pnpm run lint                                   # root ESLint
pnpm --filter @zhushanwen/pi-subagent-cli test && pnpm --filter @zhushanwen/pi-subagent-cli typecheck
pnpm --filter @zhushanwen/subagent-core test && pnpm --filter @zhushanwen/subagent-core typecheck
pnpm --filter @zhushanwen/runtime test          # M0 基底重点（5 件自动保留面在其领地）
node scripts/check-doc-symbol-drift.mjs         # M5 后
```

**端到端（Gate B，阶段 5）**：V1（真机 dev app 6 路并发 workflow subagent）+ V6（常规单路 + chat 域冷续）按设计 §4 步骤执行；V2-V4 协议脚本对端在单元验收期随做随验，脚本用完归档移除。对端 sessionDir 必须 mkdtempSync 或继承测试进程已重定向的 `XYZ_AGENT_DATA_DIR`（设计 §4 分层声明）。

## 5 合理偏差登记表

| Unit | 偏差描述 | 判定与依据 | 登记时间 |
|------|----------|-----------|----------|
| M1 | `get-state-handshake.ts` 头注新增「与旧 core `engines/pi/get-state-handshake.ts` 副本分叉」的表述（S2 修复仅限本包，旧副本未同步） | M1 提交前的头注已声明确修仅限本文件；旧副本随 M0 的 `engines/pi` 整目录删除消亡，跨副本漂移面不存在。**此处补登**（§6 曾称「deviation 1 条已登记」但 §5 缺行——阶段 3 审查分区 A 的 doc_error D1 指出该不一致，本次补正） | 2026-09-10 |
| M6 | 恢复指引追注（`withNoProgressRecoveryNote`）收敛到单一出口 `noteIfNoProgressFired`，正常返回与 catch 两路共用 | 阶段 3 审查（B-U2）称 catch 路径「构造性不可达」，实施者复核后**收窄该结论**：审查论证只对 `engine.run` 分支成立（fire 后 reject 走 RemoteEngine 合成 outcome 而非 throw），但 fire 后 try 块内仍有非 engine.run 抛点（探针：返回缺 handle 的 outcome → `journal.backfillHandle` 抛 TypeError 真走进 catch）→ 按最小纵深修复落单一出口。源码注释已按实测改写，不再复述整体不可达 | 2026-09-10 |
| M6 | 中段窗注入口形态 = 模块级覆盖变量 + `_` 前缀导出（`_setMidRoundNoProgressWindowMsForTest`），**刻意不做 env** | 对齐文件既有测试钩子先例 `_resetSettledWatchdogsForTest`（不造第二套模式）；不做 env 是设计明文「中段阈值 v1 不开 env」（每个 knob 都是误配置通道，用户调短会误杀正常长任务）。生产生效值恒 30min，且由单测断言守护默认值；`_resetSettledWatchdogsForTest` 一并复位覆盖值，防用例间污染。注入口不进口包 barrel（execution 层内部符号） | 2026-09-10 |
| M6 | U-B3 只改 warn 文案与注释，不改 env 开关语义 | 设计明文「中段阈值 v1 不开 env」，规则 19 要求有界兜底的处置可解释——故正确处置是让连带后果在 warn 里显式可见（「workflow 域 no-progress 熔断同时失效」），而非改开关行为或新增独立 env | 2026-09-10 |
| M2 | `get-state-handshake.ts` **未改动**（K1 结论：接线不需要） | 既有握手调用点已用 `performGetStateHandshake(child, identity.addStateListener)` 同形态；`requestGetStateOnce` 形参 `AddGetStateResponseListener = (id, resolver) => void \| (() => void)` 与 `addStateListener(id, resolver): void` 直接可赋值——零接线即满足 K1「优先 identity 的 addStateListener」。已核验签名 | 2026-09-10 |
| M2 | `orchestrateAgentEndBackfill` 入参含可注入 `backfill` 实现 | 验收条款明列「构造回补段抛错证明 kill 必达」，需在编排边界注入会抛错的实现；生产路径恒传 `backfillSessionFileAtAgentEnd`（单次 `requestGetStateOnce`），同步段置位与 try/finally 语义与设计决策 2 逐字一致 | 2026-09-10 |
| M2 | `LAZY_GET_STATE_TIMEOUT_MS`（1000）落在 `spawn-runner.ts` 模块内且未导出 | `constants.ts` 在领地之外不可动；测试改为行为断言（假时钟推进 <1s 内收敛）而非引用常量。值域符合设计 §5.4 控制面单请求秒级 | 2026-09-10 |
| M2 | 回补命中后除 `addStateListener` 内部落位外，额外显式调 `identity.applyGetStateFields(fields)` | 与既有握手调用点（`identity.applyGetStateFields(r)`）同款兜底；幂等（同值不重发 handleReady，V3 用例断言 handleReady 恰 1 条） | 2026-09-10 |
| M2 | K2 核验结论：`killChild` **幂等成立**（非偏差，结论登记） | `subagent-engine-sdk/src/kill-chain.ts:95` 首行 `if (child.exitCode !== null \|\| child.signalCode !== null) return "terminated"` 早退；:121-129 safeKill 吞掉「检查与 kill 之间自退」的抛出。本包补组合级用例（回补 finally 经杀链落已退出 child → 不调 child.kill、不注册 exit 监听、可重复） | 2026-09-10 |
| M3 | 新增 `mergeRunSignals`（三源合流，返回 `{signal, dispose}`），`mergeTimeoutSignal` 降为薄包装 | 设计写「`:214` 扩一个信号源」，但既有 7 条纯函数测试锁死 `mergeTimeoutSignal` 返回 `AbortSignal` 且无 timeoutMs 时原样返回 external signal；同时 R4 INFO 要求 finally 移除桥接 listener（否则 run 级 signal 累积 → MaxListenersExceededWarning），需要 dispose 面。**单实现**（mergeTimeoutSignal 委托 mergeRunSignals），无第二套逻辑；顺带修掉原实现「controller 已 abort 后才注册清理 listener → timer 不回收」的既有时序盲区 | 2026-09-10 |
| M3 | **K6 结论：mid-round 30min 窗口不可缩短 → V5② 按设计降级 V1 端到端兜底**（**已被 M6 取代**：原结论仅对 env 路线成立，测试 seam 路线由 M6 打通 → V5② 恢复为可执行并跑通，见 §6 M6 行） | 中段阈值是原语内纯常量 `SETTLED_MID_ROUND_NO_PROGRESS_MS`（`settled-watchdog.ts:32` 注释「中段阈值 v1 不开 env」）；env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS` 只覆盖收尾段或两段全关，无缩短中段窗通道。加测试 seam 需改 `settled-watchdog.ts`（非 M3 领地）——不越界。**M6 修订**：env 路线关闭是刻意的减法设计（knob = 误配置通道），但不构成「测试无从缩短」——仅测试可达的注入口既不暴露给用户又能真跑全链，原结论把「不开 env」误推成「seam 不可行」 | 2026-09-10 |
| M3 | V5c 集成测试直接 abort watchdog 的 AbortController（= fire 回调内唯一同步动作），未真等 30min | 真引擎子进程无法与 fake timers 混跑（连接/IO 依赖真实 timer），且窗口不可缩短（上一条）。计时链路「30min 到点 → abort」由 V5①（fake timers）覆盖，V5c 覆盖「abort → mergedSignal → wireAbortSignal 阶梯 → killAll → 邻接 run 终态」进程链路，两者拼合为完整 fire 链（测试文件头注已声明） | 2026-09-10 |
| M3 | `stream.onDelta` 用「原地包裹 + finally 精确还原」而非原型链代理对象 | 既有锁定测试（`subprocess-agent-runner.test.ts`「U1 stream 透传」断言 `executeAndAwait` 第 4 参 `toBe` 同一 stream 对象）要求保持 identity；该测试文件不在 M3 领地，不修改。还原含 `hadOwnOnDelta` 分支，无残留覆写 | 2026-09-10 |
| M3 | 未修改任何既有测试文件；fire 后的失败结果追加恢复指引后缀（`withNoProgressRecoveryNote`，只对已带 error 的结果追注） | 领地只含 SAR 源码 + 新增测试；错误规格表（设计 §3.4）明文要求「失败结果附『重派 workflow / 检查 subagents』指引」，属设计落地而非新增功能 | 2026-09-10 |
| M4 | **K3① 结论：prompt 非逐字落盘 → 启用「原文 + JSON 转义形态」双 includes（未走设计的降级路径「只 warn 不采纳」）** | 主 agent 独立复核：实装 `@earendil-works/pi-coding-agent@0.84.4` 的 `dist/core/session-manager.js:701/732/753` 逐行 `JSON.stringify(entry)` 落盘 → 引号/反斜杠/制表/换行确为转义形态。JSON 转义是**单射**且逐字符确定性，故转义形态匹配的误配面与原文匹配同强度——设计的降级条件（「非逐字则不可靠匹配」）在转义形态下不成立，双 includes 是比降级更完整的落地，安全底线（单命中才采纳）未放松。反证用例已锁：仅原文 includes 必 miss | 2026-09-10 |
| M4 | locator 入参由 `promptHead`（调用方预截断）改为 `prompt`（全文，locator 内部截 200） | 截断契约留在调用方会让 `PROMPT_HEAD_CHARS` 出现跨文件第二份实现；接线点收缩为一行属性。设计与决策 4 未规定截断方，语义不变 | 2026-09-10 |
| M4 | 截断点落在 UTF-16 高代理时丢弃该半字符 | 半截代理的两种键形态都不匹配文件（`JSON.stringify` 对孤立代理输出 `\udXXX` 转义），会静默 no_match；丢弃后头部仍是全文逐字符前缀，两形态必然命中（用例「代理对边界」锁定） | 2026-09-10 |
| M4 | `candidateCount` 始终 = `candidates.length`（上限门场景报实测值而非 0） | 设计 §3.4 要求 warn 含候选数，而上限门正是最需要该数字的场景（用例断言 65） | 2026-09-10 |
| M4 | warn 由 pump 侧发出，locator 保持纯函数（只回结构化结果 + 16 hex 头哈希） | `recordId` 只在 pump 侧存在；locator 不落 prompt 明文，审计面只给哈希 | 2026-09-10 |
| M4 | 全 miss warn 文案未逐字照抄设计 §3.1 第 4 步（保留 `[sessionfile] unobtainable for <recordId>` 前缀与 `record finalized without transcript anchor` 尾句，增补 reason/candidates/promptHeadHash/error 与 Recovery 指引） | 设计原文的「all 5 acquisition paths missed」在 close 收尾单点判断时未必为真（可能 LC-4 已命中或第 4 路生效），逐字照抄会写出不成立的断言；结构对齐 §3.4「warn 附恢复指引」 | 2026-09-10 |
| M4 | 采纳面只补 `sessionFile`，不由文件名反推 sessionId | 决策 4 采纳面仅 sessionFile；e2e 明确断言 `result.sessionId` 仍为 undefined（已知面，非缺陷） | 2026-09-10 |
| M4 | **领土扩张：`spawn-runner.ts` +1 行**（`sessionFileFallback: { prompt: params.task, spawnStartedAtMs: startTime, sessionDir: params.sessionDir }`） | 计划期领地划分漏项：prompt 只存在于 `runSpawnOnce` 作用域，pump 的 `StdoutPumpDeps` 不含它，设计决策 4 只写了 pump 侧插入未预见此依赖。主 agent 裁定授权（M2 已 commit 042dccec6，无并发写者）；核验确认 diff 恰 1 hunk / 1 行，`index ed2ebaa10` = M2 提交版，M2 逻辑零触碰 | 2026-09-10 |
| M4 | 新增 seam 缺省分支 warn「M4 prompt-head scan not wired」 | 设计未规定；防止缺接线时静默降级（规则 20）。生产已接线，该分支现只覆盖未接线调用方与测试 | 2026-09-10 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| M0 合并基底 | committed | 1/2 | merge 430dacabc + 残留清理 e192dfe4a；K5 冲突面与预演清单完全吻合；全量三连绿（pi-subagent-cli 304 passed / subagent-core 2834 passed / runtime 457 文件 5184 passed / tsc 干净） |
| M1 S2 契约修复 | committed | 1/2 | 9578af7f4；diff ⊆ 领地（2 文件）；契约断言（缺 sessionFile → 重试照发 1→2→3 → 耗尽 resolve）+ 全包 304 绿 + tsc 干净；deviation 1 条已登记（注释分叉表述修正） |
| M2 agent_end 惰性回补 | committed | 1/2 | 042dccec6；diff ⊆ 领地（spawn-runner.ts + 新测试，`get-state-handshake.ts` 按 K1 结论零改动）；6 用例绿（V3 回补 ≤1s 实测 614ms / 回补 reject 与 sync-throw 两路 kill 必达 / K1 接线面 / K2 幂等 / 自退 race）+ 全包 310 passed（基线 304+6）+ tsc 干净；deviation 5 条已登记 |
| M3 workflow 域守护补挂 | committed | 1/2 | bd4404ddf；diff ⊆ 领地（subprocess-agent-runner.ts + 2 新测试，禁区三文件未动）；8 用例绿（V5① 7 + V5c 1，V5c 真引擎 3.06s）+ 全包 2842 passed（基线 2834+8）+ tsc 干净；**K6 结论：mid-round 窗不可缩短 → V5② 降级 V1 兜底**；deviation 5 条已登记 |
| M4 close 兜底扫描 | committed | 1/2 | f737baa7a；diff ⊆ 领地 + 授权的 1 行扩张（核验：spawn-runner.ts 恰 1 hunk/1 行、base hash = M2 提交版）；29 新用例绿（locator 17 + pump 8 + 生产路径 e2e 4，含接线前后反向探针）+ 全包 339 passed（基线 310+29）+ tsc 干净；K3① 已双源复核（探针 + 主 agent 读 pi dist）；**K3② 未执行**，归属改为阶段 5 V1 期（见 §7）；deviation 9 条已登记 |
| M5 文档与守卫 | committed | 1/2 | 4d9a6a703；6 文件（线 B 三文档 + troubleshooting §12 重写 + drift 守卫登记 + replay.md §4/§4.1 回填）；V7 主 agent 独立复现：守卫 exit 0（9 映射文档）+ 反向探针（插 `FAKE_NOT_EXIST_XYZ_SYMBOL` → 报 drift exit 1，还原后 md5 一致、复跑 exit 0）+ 旧特征串在现树 grep 零命中（`backfilled via late get_state` / `no-descendant fast path` / `15s recovery window` 等）；doc 交叉核验：CANCEL_SETTLE_GRACE_MS / MAX_ATTEMPTS 两个跨包符号确在登记的权威模块内 |
| M6 mid-round 窗测试注入口 | committed | 1/2 | 8b78f392a；`settled-watchdog.ts` 注入口（`_setMidRoundNoProgressWindowMsForTest` + 单一读取点 arm/refresh 共用，生产恒 30min 有断言守护，reset 一并复位）+ `subprocess-agent-runner.ts` 恢复指引收敛单一出口；V5② 真引擎秒级窗全链 8.05s 通过（含邻接 run engine_crashed）；全包 2847 passed（基线 2842+5）+ tsc 干净 + V5b 全绿；deviation 3 条（其中 U-B2「构造性不可达」结论被实测收窄，见 §5） |

## 7 残留风险与变更历史

**残留风险**：

- K1-K6 检查点（设计 §5.2）分别挂在：M2（K1 接线签名 / K2 killChild 幂等）、M4（K3① prompt 逐字落盘——非逐字则 M4 降级为「只 warn 不采纳」并登记）、M0（K5 冲突面预演对照——清单外 packages/ 冲突即停下重估）、M5（K4 rpc-client diff 核验无欠账重放）、V5②（K6 mid-round 窗可否缩短——不可则降级 V1 兜底）。
- V1 真机验收需 dev app + 真实 workflow 派发环境（阶段 5 处理，可能需 `pnpm dev` + Playwright 连 9222）。
- K3① 失败时 M4 降级路径已在设计决策 4 预置，不阻塞 M1-M3/M5。
- **M3 的 K6 结论改变了验收姿势**：workflow 域 mid-round 窗不可缩短（原语内纯常量、无 env 通道），故 V5②（缩短窗口的真机验收）不可执行，按设计降级为 V1 端到端兜底——阶段 5 Gate B 不设 V5② 项，workflow 域守护的真实性由 V1（真实 workflow 派发）承接。
- 对 M3「V5c 未真等 30min」的残余风险：**已由阶段 3 分区 B 审查关闭**——审查独立证实 fire 链两段咬合（同一 `AbortController` 实例贯穿 watchdog → mergeRunSignals → `ctx.signal` → `wireAbortSignal`；`dispose` 吞掉待 fire 场景的反例构造失败）。M6 落地后 V5② 将把这条链再收进单条测试。
- **U-A6（工具执行期刷新失明 → 长 bash 误杀）是本次审查最重要的发现**，也是决策 9 引入 workflow 域后暴露的真机风险形态：修复前，单次 bash 调用 >30min（pi 内置 bash 无默认超时）会被判无进展并取消、重试 3 轮后失败。设计 §3.3 决策 9 误杀面与本文档修复待办均已登记，修复并入阶段 4 的 A 组；**该修复完成前不得进入阶段 5 Gate B**（否则 V1/V6 真机验收会把误杀形态带进结论）。
- **K3②（真实 workflow 并发形态下 prompt 头部键区分度实测）归属已裁定到阶段 5 Gate B 的 V1 期**：该检查点需要真实 workflow 派发环境（dev app），单测面无法构造真实并发头部形态。若 V1 期实测发现同模板并发头部同质率高 → M4 兜底在该场景下只会「安全放弃」（不误配，但也无效），届时应按设计决策 4 的升级路径改键策略（全文哈希 / 参数段取样）并回写设计。
- **已接受的测试输出噪音**：M2 的 `agent-end-backfill.test.ts` race① 用例 sessionDir 为空，M4 接线后 close 收尾会多打一行 `[sessionfile] unobtainable ... reason=no_candidates` warn。这是接线后的真实降级留痕（非失败），不改该用例（静音会掩盖真实行为面）。
- 阶段 5 Gate B 需注意 V4 的场景构造：单命中/多命中判定依赖 mtime 窗口内候选数，真机验收时目录里同期并发 run 的 session 文件会天然构成多候选——多命中即安全放弃，验收判据应是「不误配 + run 正常终态」，而非「必须命中」。

**阶段 3 一致性审查结论与修复待办（2026-09-10，两分区均回）**

分区 A（pi-subagent-cli，M1/M2/M4）：3 reasonable + **5 unreasonable** + 4 doc_errors。
分区 B（subagent-core，M3）：8 reasonable + **4 unreasonable** + 1 doc_error。**两分区均明确「实现与设计字面要求逐条相符，M3 无一条要求回退或重做」；fire 链两段咬合经分区 B 独立证实（同一 AbortController 实例贯穿 watchdog → mergeRunSignals → ctx.signal → wireAbortSignal，且 dispose 吞 fire 的反例构造失败）——§7 原列的「两段接口未咬合」残余风险就此关闭。**

doc_errors（4+1 条）已由主 agent 本次修订（doc_errors 归主 agent，非编码）：D1 补 §5 M1 偏差行；D2 设计 §3.1 第 4 步 warn 改结构化模板（删「5 路全 miss」不成立断言）；D3 设计 §3.3 决策 4 补第二类失效面（prompt 不在候选文件前 64KB：fork-from 大源 / `--session` 续写追加）；D4 设计 §3.3 决策 2 ③ 补 chat 域的 M4 兜底；B-doc 设计 §3.3 决策 9 误杀面补 tool_execution_update 形态（见下）。

修复待办（阶段 4 按领地分两组，组间并行、组内串行 ≤5 并发）：

| 组 | 条目 | 来源 | 严重度 | 落点 |
|----|------|------|--------|------|
| **A（pi-subagent-cli）** | U-A1：M1「至多 3 次必 settle」头注契约强于代码（`sendGetStateCommand` 抛错 → promise reject；重试路径抛错 → 定时器回调内 uncaught） | A-U1 | low | `get-state-handshake.ts`（tryOnce 包 try/catch 按「本轮未应答」处理） |
| | U-A2：V2 未执行 + 「缺 sessionFile → 3 轮耗尽 → close 靠 LC-4 补文件」这条 M1 新打通的组合零覆盖 | A-U2 | medium | 新增 e2e（`__tests__/`） |
| | U-A3：M2「≤1s」断言失焦——验的是「应答先到」路径，1s 改 100s 照样绿，超时路径上界未被测量 | A-U3 | medium | `agent-end-backfill.test.ts` 补「回补也不应答」用例 |
| | U-A4：M4 时间门早退时 warn 的 `candidates=N` 是部分计数，与字段语义不符（误导诊断方向） | A-U4 | low | `session-file-locator.ts` |
| | U-A5：close finalizer 的 `resolveExit` 必达只对 M4 自身成立——紧邻其前的 `reportChildExited`（宿主回调）无包裹，抛错即跳过 M4 与 resolveExit = run 永挂（真 G1 破口） | A-U5 | low（但属 G1 破口） | `spawn-run-pump.ts` → finalizer 体整段 try/finally |
| | U-A6：**工具执行期刷新失明 → 单次 bash 调用 >30min 被判无进展取消（真机误杀）** | B-U1 | **中** | `spawn-event-translator.ts`（见下决策，两条硬约束） |
| **B（subagent-core）** | U-B1：`hadOwnOnDelta===false`（生产形态：原型方法）还原分支零覆盖，偏差声称的「无残留覆写」缺证据 | B-U3 | low | 补类实例用例 |
| | U-B2：`withNoProgressRecoveryNote` 不覆盖 catch 路径（构造性不可达，纵深防御） | B-U4 | low（理论） | `subprocess-agent-runner.ts` |
| | U-B3：`XYZ_SUBAGENT_SETTLED_WATCHDOG_MS<=0` 现在会**静默关闭 workflow 域的 G1 熔断**（原语义只关 chat 域），耦合未登记且 warn 文案只提 chat 域 | B-U2 | 中低 | `settled-watchdog.ts`（warn 文案补 workflow 域失效提示 + 设计登记） |
| | **M6**：mid-round 窗测试注入口 + V5② 秒级窗全链测试（§2 M6 行） | 用户裁定 + K6 | — | `settled-watchdog.ts` + 测试 |

**U-A6 的核实与裁定（主 agent 独立复核）**：① pi 内置 bash 无默认超时（`dist/core/tools/bash.js` schema「optional, no default timeout」+ `resolveTimeoutMs(undefined) → undefined`）；② pi 确实发 `tool_execution_update`（`dist/core/agent-session.js:537-539`）；③ pi-subagent-cli 翻译层 switch 无该分支（`spawn-event-translator.ts` 的 `default: return`）——两路刷新同时失明。裁定 = **修**（工具持续产出即「有进展」，计入活性信号既消除误杀又不削弱「静默楔死仍被回收」），修复须在 pi-subagent-cli 内闭环（core 侧刷新面无需改动），硬约束两条：**不得污染聊天记录**（不得把工具输出当正文文本推流）、**不得让楔死工具永续命**。若最小修复无法同时满足两条 → 停下来登记为已知接受风险并回设计评审，不得硬凑。

**变更历史**：

- 2026-09-10：计划创建（对应设计就绪版 41d475737），待用户评审 + 基线 commit。
- 2026-09-10：用户评审确认；基线 commit e12ea80bd。M0 执行完毕：merge 430dacabc（冲突面与 K5 预演完全吻合）+ 残留清理 e192dfe4a（checkout 整树重置碰不到的 3 个线 B 独有测试文件——教训：`git checkout <tree> -- packages/` 只覆盖 dev 树存在文件，不删 merge 自动合入的线 B 独有文件）；全量三连绿。批次 1（M1/M3/M4）派发。
- 2026-09-10：**阶段 4 B 组完成并 commit（8b78f392a）→ M6 落地，V5② 从降级状态恢复**。硬核验：`git diff --name-only -- packages/subagent-core` 恰 3 文件（+1 新测试）⊆ 领地；主 agent 重跑全包 2847 passed（基线 2842+5）+ V5② 单文件 3 passed（真引擎全链 8.05s）+ tsc 干净；逐行读 `settled-watchdog.ts` diff 确认生产路径行为逐点不变（`getMidRoundNoProgressWindowMs()` 无覆盖时返回原常量、`assertSafeTimerDelay` 仍生效、`_resetSettledWatchdogsForTest` 一并复位覆盖值、注入口不进口包 barrel）。B 组三条 deviation 已登记，其中 U-B2 把审查的「构造性不可达」结论**收窄**为「只对 engine.run 分支成立」（实测探针走进 catch）——这是修复者反过来修正审查结论的正常形态，已按实测改写源码注释。文档回写：replay §4 V5② 行 → 可执行 + 证据、§4.1 K6 → env 路线关闭但 seam 路线打通、§5 M3 K6 行标注被 M6 取代。
- 2026-09-10：**M5 核验通过并 commit（4d9a6a703）→ M0-M5 全 committed；阶段 3 一致性审查两分区均回，进入阶段 4**。阶段 3 结论：分区 A 5 unreasonable + 4 doc_errors + 3 reasonable；分区 B 4 unreasonable + 1 doc_error + 8 reasonable，两分区均确认实现与设计字面要求逐条相符、无回退重做项。doc_errors 5 条由主 agent 同批修订（D1 补 M1 偏差行 / D2 warn 模板 / D3 决策 4 第二类失效面 / D4 决策 2 ③ 补 M4 / B-doc 决策 9 误杀面补 tool_execution_update 形态）。unreasonable 9 条 + 用户裁定的 M6 按领地分为 A（pi-subagent-cli 6 条）与 B（subagent-core 4 条，含 M6）两组派修。**本批最重要的发现 = U-A6**：pi 内置 bash 无默认超时且其流式输出事件 `tool_execution_update` 被引擎翻译层丢弃 → 刷新两路失明 → 单次 bash >30min 被误杀；主 agent 已独立复核三项证据并裁定「修」。M5 的 V7 守卫结论由主 agent 独立复现（含反向探针与还原后 md5 校验）。
- 2026-09-10：**M4 核验通过并 commit（f737baa7a）→ M1-M4 全部 committed，DAG 解锁 M5**。硬核验方式：`git diff` 确认 `spawn-runner.ts` 恰 1 hunk/1 行且 base hash = M2 提交版（ed2ebaa10，M2 逻辑零触碰）、领地外零改动、探针与备份文件零残留；主 agent 重跑全包 339 passed + tsc 干净；K3① 结论由主 agent 独立读 pi dist（`session-manager.js:701/732/753` 逐行 JSON.stringify）复核成立。M4 期间发生一次越界阻塞（prompt 只在 runSpawnOnce 作用域，pump 拿不到）——主 agent 裁定为计划期领地划分漏项并授权 1 行扩张，非 dev 违规。K3② 归属裁定到阶段 5 V1 期。
- 2026-09-10：**M2 与 M3 核验通过并 commit**（M2 = `042dccec6`，M3 = `bd4404ddf`；M4 仍在途）。硬核验方式：`git diff --name-only` 确认 M3 只动 1 个源文件（禁区三文件零触碰）、M2 只动 spawn-runner.ts；主 agent 重跑双方核心测试（M2 6/6 绿、M3 8/8 绿、subagent-core 全包 2842 passed）。两单元共 10 条 deviation 已登记 §5，其中两条是有实质影响的结论：M3 的 mergeRunSignals 单实现改造（含修掉原合流函数的 listener 回收时序盲区）、M3 的 K6 mid-round 窗不可缩短 → V5② 降级 V1。
- 2026-09-10：**额度中断后立即重派（不做等待）**。M1 committed（9578af7f4）后批次 2（M2）与批次 1 残余（M3/M4）三个 dev agent 先后返回 `[1308] 已达到 5 小时的使用上限`（provider 声明 18:39:42 重置），全部零产出。停工核验：`git status --short` 仅 1 项未跟踪产物 `packages/pi-subagent-cli/src/session-file-locator.ts`（M4 agent 死前写出的扫描器本体，175 行，无测试无接线，未经核验），`git diff --stat` 为空（M2/M3 零残留）——故 M2/M3/M4 按 pending 重算（无 committed 证据）。用户指示不用定时等待、直接继续：随即以 `u-dev` 后台重派三单元（轮次 1/2），M4 task 内附遗留半成品路径与「先核验再续作、不符则改写并说明」指令。中断期间的前一笔记录（cron 挂起方案）已按用户指示撤销。
- 2026-09-10：**K4 提前核验完毕（结论：无欠账）**——线 B 对 rpc-client.ts 的 112 行改动 = 纯 D4 消费切换（createLineReader import + 本地 LF 读取器删除）+ 注释迁移；线 B 注释提及的「stdout error 吞转发（2026-09-04 事故审计）」在 dev 版同点位存在（`rpc-client.ts:482` 一行防护 + :496 W2 完整监听），决策 5「预期无欠账」证实。M5 无需 rpc-client 相关重放。
