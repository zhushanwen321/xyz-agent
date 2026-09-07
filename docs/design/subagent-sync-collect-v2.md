# subagent 同步收集 v2：取回通道与崩溃恢复断链修复

> **层声明**：本文是**技术方案层**设计——当前层 = v1 残留问题的根因分析 → 定点修复方案；下一层产物 = 可实现的接口/数据模型/错误规格 + 拆分清单（交付给 `subagent-sync-collect-v2.impl-plan.md`）。不跨层到具体测试代码。

**一句话结论**：v1 的两条承诺链路（指针行取回、崩溃恢复补发）断在四个代码级断点——manifest 在成功成员路径上**永不产生**（不是惰性延迟）、orphan 恢复覆写 entry 时**抹掉批标记导致 E1 候选集恒空**（v1 A6 探针 FAIL 的真根因）、E1 判定口径与协调器**分岔**（含成功成员的批即使候选非空也永不补发）、恢复触发**仅 session_start 一次**——修复为四个定点手术（批成员 manifest 落盘 / orphan 覆写保留批标记 / E1 口径对齐 / 有界 settled 重扫），全部是「读侧或写侧对齐真实形态」，不动 v1 任何架构决策（隐式批 / 账本幂等 / 预算算法 / golden 字节锁）。

## 1. 背景目标

**SCQA**：

- **S（情境）**：v1（`docs/design/subagent-sync-collect.md`）已交付：`start` 的 `collect:"sync"` 批收集、两段式预算截断、`session_read result` 取回 action、E1 崩溃恢复钩子全部实装，测试全绿。验收探针留下两处登记残留（impl-plan §7）：批指针行 sa- id 真实 CLI 下反查报「无匹配 record」；A6 kill -9 崩溃恢复探针 FAIL（补发 240s 零到达）。
- **C（冲突）**：v2 前置侦查把两处残留追到代码级断点，并新发现「E1 判定口径分岔」确定性缺陷；首轮对抗式审查再击穿一处——orphan 恢复覆写 entry 抹掉 `collectMode`，E1 候选集恒空，是 A6 的真根因（v1 归因的 stale-read 竞态经 pi 实装核实**不存在**）。
- **Q（问题）**：如何在不动 v1 架构决策的前提下，把「取回通道」与「崩溃恢复」两条承诺链路真正修通？
- **A（答案）**：四个定点修复，全部在 subagent-core 执行层与装配层，零进程模型变更：①批成员离开批时（落标唯一出口）补写 record manifest；②orphan 恢复覆写 entry 时保留批标记字段；③E1 的 running 判定口径与协调器闭合判定对齐（resumable 豁免）+ 重建投影补 `resumable`/`sessionFile`；④E1 等待分支注册有界 agent_settled 重扫。

### 1.1 系统是什么（受众背景补足）

v1 建立的 sync collect 闭环（细节见 v1 设计 §1.1/§3.1）：

```
start(collect:"sync") → 批缓冲（collectCoordinator，隐式 pending 集）
  成员各自终态 → notifyComplete → 协调器缓冲
  全员离跑（hasRunningSync()==false）→ flushBatch：
    notifyBatch 写账（notifyId = sync-batch:<sha1(sorted ids)>，账本幂等）
    → markMembersBatchFinalized → appendBatchFinalizedEntry（落标唯一出口，
       主 session 文件 appendEntry {…快照, collectMode:"sync", batchFinalized:true}）
  → settled 边沿投递 → 主 agent 单次唤醒，批内容按预算截断，
     超预算条目尾接指针行 session_read {"action":"result","session":"<sa- id>"}
```

两条 v1 承诺链路，即本次要修的对象：

- **取回链**：指针行的 sa- id → session-reader result action → manifest 反查（`subagents/**/records/<sa-id>.json`）→ sessionFile → 最终 assistant 正文。
- **恢复链**：批等待中宿主崩溃 → 重启 session_start → **orphan 恢复**把死 worker 成员转终态（closed+gc 覆写 entry）→ **E1** `recoverSyncCollectBatch` 扫描主 session 末条 entry → 全员终态则补发单条批通知（账本幂等防重）。v1 对这两环的编排是「孤儿终态恢复先行收敛 running 成员，『全员终态』判定才可达」（[subagent-service.ts:748-749](../../packages/subagent-core/src/execution/subagent-service.ts#L748) 注释自述）。

一个贯穿全文的背景概念：**主 session 文件里的 `subagent-record` entry 是 append-only 的完整快照序列**（每 id 多笔，末条即最新状态；schema 含 `collectMode`/`batchFinalized`/`resumable`/`result`/`sessionFile` 等字段，[record-entry.ts:42-112](../../packages/subagent-core/src/execution/record-entry.ts#L42)）。E1 与 orphan 恢复都靠「每 id 末条」读它——任何一环写 entry 时丢字段，下游就读不到。

### 1.2 设计目标（使用者体验倒推）

| # | 目标 | 使用者可感知形态 |
|---|------|----------------|
| GV1 | 指针行取回通道**自举可用**——无需人工绕过 | 真实 pi CLI 下超预算批通知后，主 agent 按指针行原文调 `session_read result`（sa- id）即取回全文；v1 探针此处为 FAIL（反查 0 命中，须手工换绝对路径） |
| GV2 | 崩溃恢复承诺**真实兑现** | ①批等待中崩溃且批内**含成功成员**（主场景）→ 重启后单条补发、二次重启零重发；②kill -9 后重启 → 孤儿成员转终态且批标记保留 → E1 补发（v1 探针 A6 FAIL 转 PASS） |
| GV3 | v1 行为**零回归** | 异步路径通知文案逐字节不变（旧 golden）；批通知文案逐字节不变（新 golden 不动）；账本幂等/at-least-once 语义不变；config/预算算法不动 |

**In scope**：F1 批成员 manifest 落盘 + manifest 生命周期注释语义修正；F2 orphan 覆写保留批标记 + E1 判定口径对齐 + 投影扩展 + 有界 settled 重扫；F3 真实通路集成测试 + 探针复跑与文档回写。

**Out of scope（明确不做）**：worker detach（kill -9 下「孤儿自行跑完」的真正兑现——进程模型三重变更，独立长期议题）；zcode appserver 存活成员的崩溃后接回（resume 语义独立域）；嵌套 subagent 的 sync 批崩溃恢复（孙的 entry 在子进程 session 文件域，E1 与 merge 均只覆盖主文件——v1 同盲区，零回归，独立议题）；E9 出口跨键残余重复窗（v1 已接受，PS-17 同族）；批饥饿的 list 投影（另一 v2 候选，F-a-3 裁决）；B 档性能项（countPendingSyncRecords 排序等，v1 code-simplify 已列不动）。

## 2. 现状与问题分析

**首句结论**：四条断链全部是「写侧与读侧在存储域、字段域或判定口径上分岔」——manifest 写在终态路径而成功成员不走终态、orphan 恢复覆写 entry 不知道批域字段、E1 判 running 不看 resumable 而成功成员恒为 running+resumable、恢复链只在 session_start 触发一次。

### 2.1 断链 1（F1）：成功成员的 manifest 永不产生

manifest（`subagents/<enc>/records/<sa-id>.json`，`ManifestStore.writeManifest` 原子写）全仓**唯一写点**在 `doFinalizeRecord` Step 4（[finalize-record.ts:198-212](../../packages/subagent-core/src/execution/finalize-record.ts#L198)）。而 one-shot **成功**成员走 SP-5 语义被改道 `doFinalizeRoundToIdle`（[subagent-service.ts:2438-2441](../../packages/subagent-core/src/execution/subagent-service.ts#L2438)），该方法注释明文「不写 manifest（idle 非终态，manifest 是终态诊断辅助）」（[finalize-record.ts:230](../../packages/subagent-core/src/execution/finalize-record.ts#L230)）。

后果链：

```
成功成员（one-shot + result.success）→ finalizeRoundToIdle → manifest 无写点
  → 磁盘上 records/<sa-id>.json 不存在
  → session-reader result action 反查（m.id === session）0 命中
  → 抛「subagent "<sa-id>" 无匹配 record」（tool-handler.ts:348-354）
```

- **行为倒挂**：失败/取消成员走 `doFinalizeRecord` → **有** manifest → 反而能查到；成功成员（指针行真正引用的对象）查不到。
- **读侧认知错误**：session-reader 发现层注释声称「records/<sa-id>.json manifest（subagent 创建时写入，持久存在）」（[discovery/subagents.ts:22-24](../../extensions/universal/session-reader/src/discovery/subagents.ts#L22)）——与写侧唯一写点矛盾，是读侧对 manifest 生命周期的错误假设。
- **测试为什么测不出**：session-reader 的 result 测试 fixture 手工预写 manifest（`result.test.ts:64-74`），断言的是「manifest 存在时反查正确」；「subagent-core 运行流产出的磁盘状态 × session-reader 反查」这条跨包链路零覆盖。v1 探针 A4 真跑实证断链（探针注释自认「真实 CLI 流下不可解析…改用绝对路径形态断言」，[a4-truncation-and-fetch.mjs:167-172](../../scripts/probes/subagent-sync-collect/a4-truncation-and-fetch.mjs#L167)）。

**根因**：manifest 的真实角色是 **sa- id → sessionFile 的反查索引**（所有 session_read action 的 sa- 形态都依赖它），写侧却把它定位为「终态诊断辅助」（只在终态 finalize 写）。SP-5 把 one-shot 成功完成改道「回 running-resumable 等 message upgrade」后，这个语义漂移从「晚写」变成「永不写」。

### 2.2 断链 2（F2）：orphan 恢复覆写 entry 抹掉批标记——A6 的真根因

恢复链的编排是：initSession 末尾先跑 `recoverOrphanRecords`（[subagent-service.ts:556](../../packages/subagent-core/src/execution/subagent-service.ts#L556) → [record-store.ts:613-621](../../packages/subagent-core/src/execution/record-store.ts#L613)），E1 `recoverSyncCollectBatch` 随后（index.ts:498）。kill -9 后崩溃批成员全部落入 orphan 判定：

- 成功成员：`doFinalizeRoundToIdle` 已删 `.alive` marker（进程回收时）、未走终态 finalize（无 `.finalized` sidecar）→ 重建矩阵**分支 4 兜底**（无 marker、pid 死）→ 命中 `finalizeOrphanRecord`；
- 在跑成员：`.alive` marker 的 pid 已死 → 同分支 4。

`finalizeOrphanRecord` 覆写终态 entry（closed+gc，[record-store.ts:653-659](../../packages/subagent-core/src/execution/record-store.ts#L653)），但它拿到的 `rec` 来自 `reconstructAll` 的 `buildRecord`——**full 与 light 两条重建分支的字段清单均无 `collectMode`/`batchFinalized`**（[record-store.ts:1137-1188](../../packages/subagent-core/src/execution/record-store.ts#L1137)），light 分支连 `result` 都是 undefined（`:1183`）。覆写 entry 经 `toSubagentRecordEntry` 序列化后：

```
collectMode: JSON 缺省（undefined 不序列化）
  → E1 候选过滤 r.collectMode === "sync"（subagent-service.ts:771-776，
     依赖 rebuildEntryRecord :291 的 collectMode 投影）
  → 覆写后恒 undefined → candidates.length === 0 → return（:777）
```

**E1 在真实恢复链上候选集恒空**——不需要任何竞态假设，与 A6 实测「240s 零通知」精确吻合。连带伤害：即使候选非空，覆写 entry 的 `result` 缺失（light 重建丢 result）会让补发正文丢全文。

**v1 集成测试为什么测不出**：`sync-collect-recovery.test.ts` 的种子绕过 orphan 恢复直接写终态 entry（orphan 判定对已 closed 末条跳过），orphan 恢复 × E1 的联动在测试里从未真实发生（v1 侦查自认「无覆盖」）。

**根因**：恢复链有**两个写侧**（orphan 恢复覆写终态、批落标写标记），v1 只对齐了 E1 的读取通路（末条 entry 通路、禁走 light 路径），没意识到 orphan 覆写本身会把批域字段抹掉——覆写方不知道批域字段的存在。

### 2.3 断链 3（F2）：E1 判定口径与协调器分岔——候选非空也永不补发

E1 的等待判定是 `r.status !== "closed"` 即整体不动（[subagent-service.ts:778-782](../../packages/subagent-core/src/execution/subagent-service.ts#L778)）。两个事实叠加击穿它：

1. **成功成员崩溃时的末条 entry 恒为 running+resumable**：轮终写点 `reportRecordTransition` 显式落 entry `{status:"running", resumable:true, result:<全文>, sessionFile}`（[finalize-record.ts:298-308](../../packages/subagent-core/src/execution/finalize-record.ts#L298)）。这是 SP-5 的有意语义（可冷路径 resume），不是缺陷。
2. **重建投影丢 resumable**：`rebuildEntryRecord` 白名单只投影「collectMode/batchFinalized + 终态五字段」（[record-store.ts:249-253](../../packages/subagent-core/src/execution/record-store.ts#L249)），**没有 resumable**（且 `sessionFile` 被硬编码 `undefined`，`:284`）。

而协调器自己的闭合判定有 resumable 豁免（[collect-coordinator.ts:181-193](../../packages/subagent-core/src/execution/collect-coordinator.ts#L181)：`resumable !== true && status !== "closed"` 才算在跑）。E1 与它分岔——即使断链 2 修复、候选集恢复，「批等待中崩溃且成员已成功」的场景（主场景）E1 仍判「仍有 running」永不补发。v1 测试种子全部用 `status:"closed"` 终态形态（[sync-collect-recovery.test.ts:216-229](../../packages/subagent-core/src/execution/__tests__/sync-collect-recovery.test.ts#L216)），而真实链路里只有失败/取消/挂死成员以 closed 收尾——测试测的是主场景（全员成功）下不存在的 entry 形态。

### 2.4 断链 4（F2）：E1 返回后无任何再驱动

E1 判定「仍有 running」时直接 return（`:782`），注释自述「等其自然终态走正常流（下次 session_start 重扫收敛）」——但 `recoverSyncCollectBatch` 全仓仅 session_start 一个调用点；`scanOrphanProcesses` 骨架就位但无生产调用方（index.ts:829 注释「启动时接入待实现」）；idle-gc / settled-watchdog 只覆盖内存活 record。「等」没有任何事件源——重启后主 agent 的活动（message/cancel 一个 resumable 成员使其冷路径 resume → 正常流终态）发生时，无人再触发批闭合判定。

**已排除的假设（诚实记录）**：v1 曾把 A6 归因于「orphan 恢复的 closed entry 进 pi 内存、E1 读文件存在 stale 窗」。经 pi 0.84.4 dist 实装核实（`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` `_persist` :726-755）：attach 既有 session 文件时 `flushed=true`，此后每条 `appendEntry` **同步 `appendFileSync`**——「内存有、文件无」的窗口不存在；新 session 首条 assistant 前不落盘的窗口里主文件不存在，E1 读到 ENOENT 静默空数组（本来也无 entry 可扫）。A6 真根因是断链 2（候选空），不是读竞态。

### 2.5 现状物理数据流（两链合并视图）

```
┌─ 取回链（断链 1）──────────────────────────────────────────────┐
│ subagent 终态成功 → finalizeRoundToIdle ✂️（无 manifest 写点）    │
│   → 批 flush 落标 → 指针行 sa- id → 主 agent session_read        │
│   → listRecordManifests 扫 records/*.json → 0 命中 → 抛错        │
└──────────────────────────────────────────────────────────────┘
┌─ 恢复链（断链 2/3/4）──────────────────────────────────────────┐
│ 崩溃前末条 entry：失败成员 closed ✓ ｜ 成功成员 running+resumable │
│ 重启 session_start：                                            │
│   ① orphan 恢复覆写 closed+gc —— ✂️断链2：collectMode/result 丢  │
│   ② E1 扫末条 entry：候选过滤 collectMode==="sync" → 恒空        │
│      （若候选非空）running 判定无 resumable 豁免 → ✂️断链3：永等待 │
│   ③ E1 return —— ✂️断链4：此后无任何事件再触发批闭合判定          │
└──────────────────────────────────────────────────────────────┘
```

### 2.6 根因归纳

四条断链同源：**v1 的承诺链路横跨「写侧→读侧」边界，但两侧在存储域（文件 vs 内存）、字段域（批标记字段）、判定口径（closed vs resumable 豁免）上从未对齐**。v1 设计时假设的形态（manifest 创建即写 / orphan 覆写保留全部字段 / 成功成员终态 closed / 恢复有再驱动）各自落空。v2 的每个修复都是「把读侧或写侧对齐到真实形态」，而不是新增机制。

## 3. 解决方案

**首句结论**：四个定点手术——manifest 在「离开批」这个通知已定局的时点补写（F1）、orphan 覆写前从主 session 末条 entry 合并批域字段（F2）、E1 判定与协调器同构（F2）、E1 等待分支挂有界 settled 重扫（F2）——零新机制，v1 的架构决策（隐式批/账本幂等/预算/golden）零触碰。

### 3.1 终态（使用者视角先行）

**场景 A：取回通道自举可用（GV1）**——主 agent 派 1 个 collect:sync，task 要求输出 >10K 字符：

```
（批通知，1 次唤醒）
Subagent "big-report" (sa-9f2c…) completed. Result:
{前 4000 字符}…
[truncated 11,234 of 15,234 chars — full result: session_read {"action":"result","session":"sa-9f2c…"}]
主 agent 同 turn 调 session_read {"action":"result","session":"sa-9f2c…"}
→ 返回该 subagent session 的最终 assistant 正文，与 record.result 逐字节一致
（v1 此处报「无匹配 record」，须人工改绝对路径——v2 后指针行原文即指引即通）
```

**场景 B：含成功成员的崩溃批补发（GV2①）**——主 agent 派 3 个 sync，2 成功 1 在跑时宿主进程崩溃（**不触发 dispose 的崩溃形态**——SIGKILL/abort/断电；SIGTERM 会走 E9 dispose 转换路径（成员转 async 单条通知+落标），非本场景）：

```
重启同 session → session_start：orphan 恢复覆写 3 个成员终态 entry（批标记与 result 保留）
→ E1 扫描：候选集非空（collectMode 保留）；成员经覆写转 closed 计入终态
→ 全员离跑 → 补发单条批通知（成功成员正文含 result 全文，来自覆写 merge）
→ 落标 batchFinalized → 二次重启零重发（账本幂等键）
（v1 此处三重断：候选空 / 口径顶死 / 无再驱动）
```

（口径注：成功成员通常同样被覆写转 closed 计入；E1 的 resumable 豁免覆盖的是覆写**不可达**的防御分支残余——子文件 IO 错落 resumable entry、sessionFile 缺失早退——这些形态下末条保持轮终 running+resumable，豁免使它们不被误判「仍在跑」。V2 探针断言按「覆写后 closed」口径打点。）

**场景 C：kill -9 后恢复可达（GV2②）**——派 2 个 sync（sleep 中）→ kill -9 → 重启：

```
重启 session_start：orphan 恢复把死 worker 成员转 closed+gc（覆写 entry 保留批标记，
同步落盘）→ E1 读同一文件 → 全员终态 → 补发批通知
→ 落标 → 用户在重启后的会话里看到批结果（不再 240s 零到达）
```

（批头口径：gc 成员经 deriveOutcome 按子文件末行完整性二选一——末行完整 → 计入 finished（正文含崩溃前 result）；末行截断 → 计入 failed（正文为截断 error 文案）。closedReason="gc" 是 record 层描述，不进通知文案断言。）

**失败与逃生**：补发内容缺 sessionFile 投影（极端：entry 损坏）→ manifest 该成员 sessionFile 缺省 → session-reader 反查仍报错，但错误文案已指引恢复动作——改用 `session_read { action:"family" }` 查该 subagent 的活跃/已完成后代、片段输入换完整 sa- id、或 `action:"find"` 重试（`formatSaIdNotFound`，tool-handler.ts；既有兜底，不新增——不指引绝对路径形态，与 v1 A4 探针期的「手工换绝对路径」人工绕过不是同一路径）；settled 重扫达上限仍有 running → debug 日志留痕，下次 session_start 再收敛（与 v1「下次重扫收敛」语义一致，但不再依赖它作为唯一路径）。

### 3.2 多方案对比

#### F1：manifest 写点

| 维度 | 方案 a：notifyComplete 入缓冲时写 | **方案 b：appendBatchFinalizedEntry 单点写（推荐）** | 方案 c：doFinalizeRoundToIdle 全局写 |
|------|----------------------------------|-----------------------------------------------------|--------------------------------------|
| 机制 | 成员进协调器缓冲时逐条写 manifest | 落标唯一出口（正常 flush / E1 补发 / E9 转换**都经过它**）处补写 | 改 finalize-record.ts:230 决策，所有 one-shot 成功都写 |
| 长期合理性 | 中：与 b 同样覆盖 E9 面，但写点分散在协调器域 | **高**：语义自洽——「离开批 = 通知已/即将送达 = 指针行即将被消费 = 反查索引必须存在」，三出口单点全覆盖 | 高：把「manifest = 反查索引」贯彻到所有 one-shot（async 场景 list 后手动查也受益） |
| 短期成本 | 低 | 低（一个 fire-and-forget best-effort 写） | 中：动 SP-5/v4 B-1 既有语义注释，影响全部 one-shot 路径与既有 manifest 消费方（collectRecords 补充投影） |
| 风险 | E9 转换成员留下 manifest（与 b 等同代价，见下）；写点离开落标域 | E9 转换成员同样落 manifest（E9 也走 markMembersBatchFinalized，subagent-service.ts:739-746）——**与方案 a 等同代价**：E9 后成员已被 async 单条通知（全文注入），指针行未引用它，manifest 属「未被指针行消费的索引」，但 E9 后成员仍可被 sa- 反查（list 可见），索引非纯浪费、体积可忽略 | collectRecords 的 running manifest 补充投影语义要重审（重启后 list 可能多出投影） |

**共同代价的诚实披露**：E9 出口的 manifest 是 a/b 共有（无法靠写点选择避开——E9 与正常 flush 共用落标出口）。**选 b 的差异化理由**是「三出口单点」与「sessionFile 必已回填」（agent_end 惰性回补先于 runAndFinalize resolve，通知消费时点更晚）；a 的写点时机（入缓冲）在协调器域、且缓冲成员随后可能 E9 转换，同样躲不开。
方案 c 是「最根本」形态，但它修复的「async 场景手动反查」不在本次目标内（GV1 只要求指针行链路），且影响面外溢到所有 one-shot——按减法原则列为 v3 候选。若用 a：与 b 行为几乎等价但写点分散两处；若用 c：每台日常派发的 async one-shot 都多一次 manifest 原子写（fsync 开销），换取本次不需要的手动反查能力。

#### F2：恢复链闭环

| 维度 | **方案 A（推荐）：覆写保标记 + 口径对齐 + 有界 settled 重扫** | 方案 B：E1 扫描源换 pi 内存 entries | 方案 C：worker detach |
|------|------------------------------------------------------------------------------------------------|-------------------------------------|----------------------|
| 机制 | ①`finalizeOrphanRecord` 覆写前从主 session 末条 entry 合并 `collectMode`/`batchFinalized`/`result`/`model`（仅补 undefined/空值）；②E1 running 判定加 resumable 豁免（与协调器同构）+ `rebuildEntryRecord` 投影补 `resumable`/`sessionFile`；③E1 等待分支注册 disposed 包装的 `agent_settled` 有界重扫 | initSession 注入 `ctx.sessionManager.getEntries()`，E1 读内存替代文件 | spawn 加 detached + worker 自写终态 |
| 长期合理性 | **高**：每个修复都是对齐（§2.6 根因），零新机制；恢复链两个写侧（orphan 覆写/批落标）字段域对齐 | 低：pi 实装已证 appendEntry 对已 attach 文件同步落盘，「文件读不到刚写的 entry」前提不成立——换内存源解决的是不存在的问题，徒增注入面与适配层 | 高（真正兑现「孤儿自行跑完」） |
| 短期成本 | 低（覆写点 merge + 判定行 + 重扫函数） | 中（注入回调 + 行/对象 normalize 适配 + 装配） | 高：RPC pipe 模型、worker 自 finalize、僵尸管理三重进程模型变更 |
| 风险 | merge 数据源 = 主 session 文件（session_start 时已存在，同步读）；见探针 P-orphan/P-rebuild | 与文件源双轨形态（生产/测试不同源），维护面翻倍 | 孤儿泄漏/僵尸进程/结果自写一致性，风险量级与收益不成比例 |

方案 B 是首轮设计稿的推荐方案，被 pi 实装证据击穿（§2.4 已排除假设），记入被否谱系。方案 C 是唯一能「救结果本体」（成员真跑完）的，但「用户重发即恢复」是 v1 已接受语义，v2 的 GV2 只要求「批闭合可达 + 通知兑现」（成员以 crashed 形态入批也是兑现）。**选 A**，C 独立长期议题。

### 3.3 关键决策与权衡

**D1 manifest 写点 = 批通知路径写账前屏障（时序修订版；原 W3 为落标出口 fire-and-forget）**
选择：批通知路径（flushBatch 正常批 / E1 补发）在 notifyBatch 写账**之前**对每成员并行写 manifest 并 await 全部落盘（Promise.allSettled；失败仅 debug 不阻断写账投递——best-effort 语义与 doFinalizeRecord Step 4 一致），序列为 **manifest（屏障）→ 写账 → 落标**——「通知可达 ⇒ 索引就位」成为构造性保证（by construction）。修订动机：原 W3 在落标唯一出口（appendBatchFinalizedEntry）fire-and-forget 写，与通知投递并发，「通知送达时 manifest 已落盘」只是大概率成立（探针实测 mtime 相对 notify entry ±2/3ms 方向不定），批通知的指针行消费依赖该反查索引——dev-flow 验收 gap 登记为时序竞态。E9 转换路径保持落标后 fire-and-forget：其成员走 async 单条通知（全文注入、无指针行消费），无时序要求（manifest 仍写，作 list 后手动反查的顺带索引）。源序约束不变：「写账先于落标」（v1 幂等窗口语义）保持；幂等窗口内崩溃时 manifest 已提前落盘，行为更优。写后与 doFinalizeRecord 的关系：若成员随后被 message upgrade 走完整 finalize，Step 4 会再写一次 manifest（closed）**原子覆盖**——manifest 语义从「终态诊断辅助」修正为「sa- id 反查索引（最新已知快照）」，读侧注释同步修正（subagents.ts:22-24、finalize-record.ts:230 与文件头 D-017 段）。
被否：方案 a（行为近等价但写点分散两处）、方案 c（影响面外溢，v3 候选）；保持 fire-and-forget（依赖「毫秒级写完」的调度运气，非构造性保证，探针可证伪——本次修订的动因）。
前置依赖：断链 3 的 `sessionFile` 投影扩展（D3）——E1 补发路径的成员来自重建快照，不补投影则该路径写出的 manifest `sessionFile: undefined` 是无用索引。

**D2 manifest.status 取值 = 如实投影**
选择：成功成员落标时 record 实态是 `running`+resumable，manifest.status 写 `"running"`（枚举合法值）；后续 upgrade 覆盖为 `"closed"`。不写 "closed"（撒谎——record 还可 resume）也不扩枚举（resumable 信息在 record/entry 域已有，manifest 不需要）。
风险评估：subagent-core 内 manifest 唯一读方是 `collectRecords` 的孤儿补充路径（`record-store.ts:541-565`，仅补「session.jsonl 重建失败的 orphan」且 `byId.has` 跳过已覆盖项）——running manifest 只在该 id **无子文件锚**（reconstructAll 重建不可达）且不在内存时才会被投影；F1 场景成员必有子文件锚（跑过至少一轮才进批/落标），reconstructAll 先占 byId 使 manifest 补充路径恒跳过（反例边界：子文件被外部删除而主文件 entry 完好时，manifest 补充投影仍会触发——recoverEntryOnlyOrphans 注释记载的已知边界同族）；实施期以测试锁定该不变量（⛔ 探针 P-manifest）。

**D3 orphan 覆写保留批标记 + E1 口径对齐（F2 核心，两修复同批落地）**
选择（两半必须同批——只修覆写不修口径，E1 仍被 running 顶死；只修口径不修覆写，候选恒空）：
- **覆写侧**：`recoverOrphanRecords` 循环前经 `scanLastRecordEntries`（现成函数，E1 同款）建 id → 末条 entry 映射（`recoverOrphanRecords` 增 `mainSessionFile` 参数，与 `recoverEntryOnlyOrphans` 同款传参风格）；`finalizeOrphanRecord` 覆写 entry 前把末条 entry 的 `collectMode`/`batchFinalized`/`result`/`model` 合并进 rec——**仅补 undefined/空值字段、不覆盖已有值**（如 light 重建 result=undefined 则从末条补；覆写自带的 status/closedReason 不受影响）。chatMode 分流分支（:628-631 的 resumable entry）统一走同款 merge。id 域一致性：子进程 identity 由 `PI_SUBAGENT_SELF_RECORD_ID` env（= 父 record.id）自写，主 session entry 与子文件重建的 id 恒同源，merge 不会落空（顶层域；嵌套见局限披露）。
- **判定侧**：E1 running 判定改为 `resumable !== true && status !== "closed"`（协调器 hasRunningSync 同构口径）；`rebuildEntryRecord` 白名单补投影 `resumable`（`d.resumable === true`）与 `sessionFile`（str 守卫）。
被否：E1 扫描改为「按 id 合并全部 entry 的标记字段」（非仅末条）——改 last-writer-wins 语义，影响面大于覆写点补字段；orphan 重建（reconstructAll）直接补投影 collectMode——reconstructAll 数据源（sidecar/子文件）不含批域字段，加读取源改动更大；merge 对 result 加 `collectMode==="sync"` 门——人为保留 async 成员的同款信息丢失（见下），逻辑分叉复杂化。
影响面（诚实口径）：merge 的原则是「覆写是状态迁移不是信息重建，迁移不应丢末条既有信息」——对 async/chat 成员同样生效：**批域字段（collectMode/batchFinalized）对非 sync 成员恒 no-op**（末条 entry collectMode undefined → merge undefined）；**result/model 的修补对 async 成员同样改变覆写 entry 字节**——这是对 v1 light 重建丢 result/model 缺陷的拉齐修复（full 重建分支本就有这些字段，两分支覆写形态本不一致），受益方是覆写 entry 与 full 重建的形态一致性及未来以主文件 entry 为源的读方（如会话内复盘）——现架构 GUI list 走 collectRecords light 路径不读主文件覆写 entry，不受益也不受损。golden 锁通知文案不锁 entry 字节，GV3 不受影响。
局限披露：嵌套 subagent（子进程派发的孙）的 subagent-record entry 写在**子进程自己的 session 文件**域，主 session 文件的末条映射查不到孙 id——merge 落空；且 v1 的 E1 本就只扫主文件（嵌套 sync 批的 E1 恢复同样不可达），零回归，登记 out of scope（独立议题）。

**D4 E1 等待分支 = agent_settled 有界重扫**
选择：E1 判定「仍有 running」时注册 `pi.on("agent_settled", handler)`（pi.on 无 off——disposed 标志包装，scheduler extension 同款先例 `index.ts:89-96`），每次 settled 重扫一次（重读主文件末条 entry，判定可达则补发+落标+disposed）；重扫达上限（默认 8 次）后 disposed + debug 日志留痕。
覆盖场景：重启后主 agent 的活动（message/cancel 一个 resumable 成员使其走冷路径 resume → 正常流终态落 entry）带来的延迟闭合——批 flush 走协调器正常路径，E1 重扫兜「协调器批缓冲未随重启重建」的缝隙（重启后协调器 buffer 为空，终态成员只进 E1 的扫描视野）。kill -9 全灭场景由 D3 + 同步落盘直接覆盖（不需要重扫）。
被否：周期 interval 重扫（重启后空闲 session 挂 timer，收益同 settled 边沿但常驻成本）；无上限重扫（泄漏）；E1 扫描源换 pi 内存 entries（首轮方案 B——pi 实装已证 appendEntry 同步落盘，「文件读不到」前提不成立，见 §2.4）。
局限披露：zcode appserver 存活成员在宿主崩溃后仍活，但新进程无其 runner/终态回调——settled 重扫期间它仍 running，达上限放弃属预期（其终态要等下次重启的 orphan 判定）；「接回存活成员」是 resume 语义独立议题，登记 out of scope。

**D5 异步路径与 golden 零触碰**
F1 写点仅在落标出口（sync 批成员专属路径——async 成员无 batchFinalized 落标）；F2 的批域字段（collectMode/batchFinalized）merge 与 E1 口径只影响 sync 候选集——**对非 sync 成员恒 no-op**；merge 对 result/model 的修补按 D3「信息迁移不丢失」原则对 async/chat 同样生效（拉齐 light/full 分支既有不一致，方向为改进），不触碰任何通知文案。异步单条通知文案（旧 golden）、批通知文案与预算算法（新 golden）、账本 record/attemptDeliver 语义零改动。D2 的 status 如实投影不进任何通知文案。

### 3.4 与登记约束的一致性

| 约束 | 一致性 |
|------|--------|
| C-ext-19 结果通知确认式送达（持久账本+幂等键） | F2 让补发**可达**，防重仍由账本 `sync-batch:<hash>` 幂等键承担（补发→账本拒绝→统一补标，v1 幂等窗口设计原样继承，测试 :328 语义不变） |
| C-ext-13 引擎抽象单向依赖 | F1/F2 全部在引擎无关的 core 执行层与装配层，pi/zcode 一致 |
| C-sw-01 每 session JSONL 单写进程 | manifest 是独立 sidecar json（writeAtomicFile），写方仍是宿主 service 进程，不新增 session JSONL 写入方；覆写 merge 不新增 entry 写入方（复用既有 reportSubagentRecord 通路） |
| C-pi-12/13 pi 语义断言以 node_modules 实装为准 | §2.4 的同步落盘断言锚定 dist 实装（session-manager.js `_persist` :726-755）；首轮 stale-read 假设被实装推翻即改稿——本约束的执行范例 |

## 4. 验收（真实场景，非单测/mock）

实施完成后在**本地 pi CLI**（`pi --mode rpc --extension <path>`，AGENTS.md MANDATORY 通道）复跑 v1 探针框架（`scripts/probes/subagent-sync-collect/`，common.mjs 复用）。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V1 | 指针行取回自举（v1 A4① 复验） | RPC 起 pi，1 个 sync + task 输出 >10K 字符；等批通知后**让主 agent 按指针行原文**调 `session_read {"action":"result","session":"<sa- id>"}` | 取回内容与 record.result 逐字节一致；**不再出现「无匹配 record」**（v1 此处 FAIL，需手工换绝对路径）；磁盘上 `records/<sa-id>.json` 在批通知送达前已存在，且 mtime 严格早于 notify entry timestamp（D1 屏障构造性保证——时序修订后从「大概率」升为严格门） | GV1 |
| V2 | 含成功成员的崩溃批补发 | 3 个 sync（2 个先完成、1 个 sleep 中）→ **SIGKILL** 宿主进程（与 V3 同款信号——SIGTERM 触发 dispose 走 E9 转换，测不到 E1 路径；entry 已同步落盘）→ 重启同 session → 等待 → 再重启一次 | 重启 #1 后收到**单条**补发批通知，含 2 个成功成员正文（result 全文来自覆写 entry 的 merge 保留）；重启 #2 零重发（账本幂等）；批头计数与成员终态形态一致 | GV2① |
| V3 | kill -9 崩溃恢复（v1 A6 复验） | 2 个 sync（sleep 60s）派发后 kill -9 主 pi → 重启同 session → 等待 | 重启后补发单条批通知，240s 内到达（v1 A6 FAIL 转 PASS）；批头计数 0-2 finished / 0-2 failed（gc 成员依子文件末行完整性二选一，kill -9 下截断与否是概率形态，断言容忍两种 outcome），成员正文为 result 或截断 error 文案；二次重启零重发；RESULTS.md 回写 | GV2② |
| V4 | 异步与既有批零回归 | 不传 collect 跑既有单 subagent 流程 + 既有 sync 批流程；全量测试 | 异步单条通知文案与 v1 golden 逐字节一致；批通知 golden 不动全绿；subagent-core / session-reader / subagent-workflow 三包测试基线不降 | GV3 |

**验收就绪判定**：V1-V3 场景全部可执行（探针框架现成）即设计就绪；V1/V2/V3 为实施完成门（DoD），V4 为回归门。

## 5. 下一层拆分

拆分原则：断链 2/3 同链修复必须同批落地（D3 论证了只修一半不可验收），断链 1 独立（其 E1 路径依赖断链 3 的 sessionFile 投影），真实通路验证收尾。

| 单元 | 内容 | 文件改动地图 | justification | 验收挂钩 |
|------|------|-------------|---------------|---------|
| W1 orphan 覆写保标记 + E1 口径对齐 | ①`recoverOrphanRecords` 增 `mainSessionFile` 参数 + `finalizeOrphanRecord` 覆写前 merge（仅补 undefined/空值）；②E1 running 判定加 resumable 豁免；③`rebuildEntryRecord` 投影补 `resumable`/`sessionFile`；④**真实序列种子测试（形态必须同构 kill -9 链路）**：主文件种 register（running+sync）→ 轮终（running+resumable+result）两笔 entry；**sessionsDir 构造子 session 文件**（identity entry + 末行完整 JSON，先例 `sync-collect-recovery.test.ts:399-421` E9 用例手工写子文件）且**不写** `.finalized`/`.cancelled`/`.alive` 三 sidecar（分支 4 命中条件）；`initSession` 后让 orphan 恢复（`finalizeOrphanRecord` 真实跑，不走 entry-born 兜底——无子文件形态测不到 D3 merge 所在路径）与 E1 **真实跑**；**主用例用写文件 pi**（makeWritingPi——种子与覆写均落盘，E1 读覆写后末条 closed entry，与 kill -9 真实链路同构）；断言面 = 覆写 entry 保留 collectMode/batchFinalized/result/model + E1 补发与落标。另配两个用例：①async 对照（同构造无 collectMode）：断言批域字段不出现、result 按 merge 补齐；②豁免路径（断言 pi 不落盘——E1 直读轮终 running+resumable entry 走 resumable 豁免判定，覆盖判定侧另一分支）——v1 教训是种子形态必须取自真实链路 | `record-store.ts`（merge + 投影）、`subagent-service.ts`（E1 判定 + 传参）、`__tests__/sync-collect-recovery.test.ts` | 同链两修复同批才可验收（D3）；「orphan×E1 联动」从 v1 的零覆盖测试盲区升格为本单元的核心验收；子文件 + 无 sidecar 构造保证测的是 `finalizeOrphanRecord` 路径而非 entry-born 兜底（后者 collectMode 投影 v1 已修，测它 = 假绿） | V2/V3 前置 |
| W2 有界 settled 重扫 | E1 等待分支注册 disposed 包装的 `agent_settled` 重扫（上限 8，达限 debug 留痕）；重扫 = 重读主文件末条 entry 走同一 E1 判定 | `subagent-service.ts`（E1 等待分支 + 重扫函数） | 断链 4；scheduler disposed 包装先例复用；pi.on 多注册互扰以探针 P-settled 定谳 | V2 增强 |
| W3 manifest 落盘 + 注释语义修正 | `appendBatchFinalizedEntry` 处 fire-and-forget best-effort 写 manifest（status 如实投影）；修正 manifest 生命周期旧语义注释三处（finalize-record.ts:230、文件头 D-017 段、discovery/subagents.ts:22-24）；不变量测试（collectRecords 不因 running manifest 多投影）（后续时序修订：批通知路径的写点前移为写账前屏障 await 落盘、E9 保持本行形态，见 §3.3 D1） | `subagent-service.ts`（appendBatchFinalizedEntry）、`finalize-record.ts`/`discovery/subagents.ts`（注释）、`__tests__/` | 断链 1；落标唯一出口单点覆盖正常 flush / E1 补发 / E9 转换三路径 | V1 |
| W4 真实通路集成测试 + 探针 + 文档回写 | ①跨包集成测试：subagent-core 真实 tmpdir 产出磁盘状态 → session-reader result action 反查（不 mock manifest 写入）；②探针 V1/V2/V3 复跑 + RESULTS.md 回写；③v1 设计文档 §3.1.5 E1/E3、§4 A6 注记（stale-read 旧归因订正为 orphan 覆写真根因）与 impl-plan §7 残留风险段回写（设计文档同步纪律：登记即债务修复即清账） | `scripts/probes/subagent-sync-collect/`（复用+回写）、`docs/design/subagent-sync-collect.md`、`subagent-sync-collect.impl-plan.md`、跨包测试落 subagent-core 或 session-reader `__tests__/` | v1 的教训：跨包链路与 mock 掩盖的字段丢失正是残留的成因——真实通路测试是防回归的最终形态 | V1-V3 闭环 |

依赖：W1 → W2 串行（同域递进，W2 重扫复用 W1 判定）；W3 依赖 W1 的 sessionFile 投影（E1 路径 manifest），可与 W2 并行；W4 收尾。

**探针清单（运行时断言与检查点；四条已于 2026-09-05 实施回填 ✅，降级路径均未触发）**：

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|----|-----------|------|------|-----------------|
| P-orphan | orphan 覆写 entry 保留 collectMode/batchFinalized/result/model（仅补 undefined/空值，不覆盖覆写自带字段）；批域字段对非 sync 成员恒 no-op | W1 真实序列种子测试（子文件 + 无 sidecar 构造，走 finalizeOrphanRecord 路径）断言覆写 entry 字段 + async 对照用例（批域字段不出现、result 补齐） | ✅ W1（sync-collect-recovery.test.ts:600/:660/:701 + 区1 反向锁定 :678，mutation 验证） | 若 merge 与覆写序列化冲突（如 undefined 字段被序列化为显式 null），merge 改为构造 entry data 后显式 delete undefined 键（与 toSubagentRecordEntry 的自然缺省语义对齐） |
| P-settled | 同一 pi 实例多次 `pi.on("agent_settled")` 注册互不干扰（W2 重扫注册不影响 ledger host 已注册的 settled 分发，反之亦然） | 读 pi dist 事件分发实现 + W2 单测双注册断言 | ✅ W2（dist 定谳列表分发：loader.js handlers.push + runner.js 逐 handler await；用例 :752/:797 + 区1 dispose 惰化 :829，mutation 验证） | 若事件分发为单 handler 覆盖语义，E1 重扫并入 ledger host 的 settled 分发链（host 装配处追加 handler 数组），不独立注册 |
| P-manifest | running 状态 manifest 不触发 collectRecords 孤儿补充投影（有 entry 的成员永不被 manifest 补充覆盖） | W3 不变量测试：落标+写 manifest 后重启重建，断言 list 投影与无 manifest 时一致 | ✅ W3（不变量用例 :906 + E1 路径 manifest 断言 :600/:701；Gate B 独立复核） | collectRecords 补充路径对 status="running" 的 manifest 跳过（补丁位：`record-store.ts:541-565` 循环守卫） |
| P-rebuild | rebuildEntryRecord 新增 resumable/sessionFile 投影对 `recoverEntryOnlyOrphans` 候选过滤行为不变 | 既有 recoverEntryOnlyOrphans 测试复跑 + 新投影字段的用例 | ✅ W1（用例 :877 + 白名单投影可见 :347） | 若行为变化，recoverEntryOnlyOrphans 守卫显式忽略新字段（保持其「只认 running 末条」语义） |

---

### 附：被否谱系汇总（供后续轮次审查者）

| 被否方案 | 击穿反例/理由 |
|---------|--------------|
| manifest 写在 notifyComplete 入缓冲时（F1-a） | 与 b 行为近等价（E9 面代价共有）但写点分散两处；sessionFile 回填保证弱于 b |
| manifest 写在 doFinalizeRoundToIdle 全局（F1-c） | 影响面外溢全部 one-shot 与 collectRecords 补充投影语义；GV1 只需指针行链路（v3 候选：async 手动反查出现真实需求再升格） |
| manifest.status 统一写 closed（D2 备选） | 与 record 实态撒谎（running-resumable 可被 upgrade），掩盖「manifest=最新快照」语义 |
| E1 扫描源换 pi 内存 entries（首轮 F2 方案 B） | pi 实装（session-manager.js `_persist`）已证 attach 既有文件后 appendEntry 恒同步 appendFileSync——「文件读不到刚写 entry」前提不存在，换源解决不存在的问题，徒增注入面 |
| stale-read 竞态假设（v1 A6 旧归因） | 同上被实装推翻——A6 真根因是 orphan 覆写抹 collectMode 致 E1 候选空（§2.2）；首轮设计稿据旧归因设计的「构造性保证」论证随之作废 |
| E1 扫描改按 id 合并全部 entry（D3 备选） | 改 last-writer-wins 语义影响面大于覆写点补字段 |
| E1 保留文件读取 + 周期 interval 重扫（D4 备选） | 重启后空闲 session 常驻 timer，成本同 settled 边沿但无对等收益 |
| worker detach（F2-C） | RPC pipe/自写终态/僵尸管理三重进程模型变更，与「用户重发即恢复」已接受语义的收益不成比例（独立长期议题） |
| 启动接入 scanOrphanProcesses | kill -9 下 worker 已死无进程可扫；要转的是 record 状态不是进程收割 |
