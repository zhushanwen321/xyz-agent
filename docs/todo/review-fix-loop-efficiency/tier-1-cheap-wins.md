# review-fix-loop 效率优化 梯队 1：全量仪表与 eval + 轮次归因 + 证据裁决落盘

> **一句话结论**：把 review-fix-loop 从「黑盒循环」改造成「可观测、可归因、可评估」的循环——全量仪表（每次 agent 调用的耗时/token/缓存命中落 state.json，持久化到 `~/.review-fix-loop/` 并配 rfl CLI）是地基；其上一条数据传输链（聚合条目结构化扩展，含 normalizeAggregatorResult 透传修复）供养归因/指引/裁决落盘三个机制；质量评估用「4 维度 × 10 分制 + 加权综合总分」，权威层是状态机客观回填；R2+ 保持全量重扫（聚焦审查回退为数据门槛触发的决策记录）。**v6 起并入梯队 2 的 prompt 前缀稳定化**（模板/schema 跨轮逐字节对齐 + 快照守护，两个前置探针已探明）；梯队 2 其余机制（diff 指纹、持久会话）已分别否决与标记暂时不做，见该文档附录。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 是 subagent-workflow extension 的内置 workflow，结构为「多批串行 × 批内多轮：并行 review → 聚合 must-fix → fix → 重审直到 clean」。状态存 `$TMPDIR/review-fix-loop/<runId>/state.json`——系统清理即丢失，本地 441 个历史 run 全是 e2e fixture。
- **C（冲突）**：① 每轮全价；② 轮次成本与质量不可见（state.json 无 token/耗时/质量字段）；③ 无 eval 手段，优化效果不可度量；④ 审查发现 clean 终止路径有数据黑洞（所有 agent clean 时在聚合/对账**之前** break——最后一轮 fix 的对账与打分永远不发生）。
- **Q（问题）**：怎么让每一轮的成本与质量可见、可归因、可评估，同时只做风险可控的省成本改动？
- **A（答案）**：地基先行（仪表 + 持久化 + CLI + 引擎 runId/usage 透传）；聚合条目扩展打通数据链；证据裁决复用现有 adjudication 机制、只补落盘与复活通道；打分弱信号 + 客观回填权威；clean 路径补确定性对账回填，堵住黑洞。

## 1. 背景：被设计的系统是什么

**本章结论：review-fix-loop 是「审查-修复」循环编排器；本次设计 = 可观测性地基 + 三个省成本机制 + 打分与 eval 方法 + clean 路径数据黑洞修复。**

一次 run 的内部循环：批次串行；批内每轮 `parallel()` 派发多个 reviewer → aggregator 去重聚合 → fixer 修复 → 下轮重审。关键现状（均经源码核实）：

- reviewer 输出 schema 中 `must_fix` 是 **number 计数**，逐 issue 明细只存在于 reviewer 写盘的 markdown 报告。
- **R2+ reviewer 全量重审**（本设计不改变）：上轮 clean 的 agent 默认跳过；dirty 的走 `buildR2ReviewPrompt` 全量重扫。
- **资源数据主线程侧已存在但未透传**：`AgentResult` 含 `usage{input, output, cacheRead, cacheWrite, cost, contextTokens, turns}` + `durationMs` + `sessionId/sessionFile`（`src/orchestration/models/types.ts`）；`agent({returnMeta:true})` 只收到 `{value, sessionFile, worktreePath, error}`（`worker-script-builder.ts` resolve 分支）。重放路径（`_callCache`）缓存全量 `msg.result`，但重建 returnMeta 对象时同样只挑四字段——**两个对称改动点**（live resolve + 重放重建，已核实无第三条绕过路径：workflow() 嵌套 / retry / DataCloneError fallback 均不经过）。
- **引擎生产路径不注入 `_runId`**（全 src/ 仅 worker 模板读取 + 测试显式传）——脚本的 `RUN_ID = $ARGS._runId || "run-"+Date.now()` 在 worker rebuild（错误恢复重建）时会**漂移**，同一逻辑 run 的 state 可能碎裂到多个目录。这是现实现的潜在 bug，存储迁移时必须一并修。
- **聚合归一化白名单截断**：`normalizeAggregatorResult`（utils.cjs:638-672）对 `must_fix_ids` 条目只保留 `{id, severity}`、对顶层只挑已知字段——任何新增条目字段（files/evidence/guidance/scores）会在此被**静默丢弃**。
- **证据裁决已存在**：aggregator prompt 模板（buildAggregatorPrompt，utils.cjs:320 起；adjudication 段在 364-375）已有 adjudication 段——逐条 must-fix 裁决证据（evidence / unverified / downgraded+reason）+ fixes_caution。**缺的是裁决结果的落盘与复活通道**（downgraded 条目去哪了无人记录）。
- **clean 路径黑洞**：`reviewResults.every(must_fix===0)` 时在聚合与 reconcile 之前直接 break——该轮 reviewer 提交的 reconciliation 数据已解析但被丢弃，上一轮的 fix-attempted 永不转 fixed，末轮 fix 的回归维度永不回填。
- issue 状态机：`state.issues`（firstSeen/severity/status/history/fixAttempts），open → fix-attempted → fixed/regressed——**免费的 eval 数据源**（§6.7）。

**层声明**：当前层 = 技术方案设计，含开发可直接依据的数据结构规格（§7）；下一层 = 实现任务。准则 5/6/7 全适用。

## 2. 设计目标

**本章结论：每次 run 每轮「花了多少、报得准不准、修得好不好」全部落盘可查，包括 clean 终止轮（黑洞堵上）。**

1. **可观测**：每次 `agent()` 记录耗时、token 四分量、模型、prompt 模式；state.json 持久化到 `~/.review-fix-loop/<repo-slug>/`；rfl CLI 直接查询。
2. **可归因**：R2+ 新 issue 带 origin（regression / new）。
3. **fixer 免侦查**：每条 must-fix 带修复指引，落聚合报告与 state.json。
4. **裁决可追踪**：现有 adjudication 的降级结果落 dormant 清单，注入下轮 R2+ prompt 可复活——不再是「降级即消失」。
5. **质量可评**：10 分制分维度打分 + 综合总分落 state.json；客观回填（含 clean 轮的确定性对账回填）为权威层。
6. **聚合便宜**：`aggregatorModel` 参数支持降档（模型选择写用户 AGENTS.md）。
7. **run 完整性**：一个逻辑 run 一个 state 目录（引擎注入稳定 _runId，rebuild 不漂移）。
8. **prompt 前缀稳定**（v6 并入自梯队 2）：同一 reviewer 跨轮的完整 prompt（system 段含 schema 指令 + user 段静态文本）逐字节稳定，变化内容全部后置到动态段；快照测试守护。

**In-scope**：review-fix-loop.js / utils / aggregator schema 与 prompt / state.json 结构与存储 / rfl CLI / 引擎两处透传（returnMeta 字段、_runId 注入）/ reviewer prompt 模板与 reviewerSchema required 统一（6.9 前缀稳定化）。**Out-of-scope**：reviewerSchema 其他破坏性变更；R2+ 聚焦/审计轮（6.5 回退记录）；持久会话（梯队 2 已标记暂时不做，见该文档 §6.3）；可执行验证（梯队 3，暂时不做）；recheckAfterFix 语义。

## 3. 现状：使用者眼里是什么样的

**本章结论：每轮全价、数据随 /tmp 消失、裁决结果蒸发、clean 轮数据黑洞——优化没有仪表。**

### 3.1 现状的真实样子

- state.json 在 `$TMPDIR`（macOS 定期清理）——真实 run 数据活不下来。
- 仅 `meta.startedAt` 一个时间字段，无 token/耗时/缓存/质量记录。
- 聚合条目 `{id, severity}` 无文件/证据/指引维度；且归一化层白名单截断，加字段也会被丢。
- R2+ dirty agent 全量重扫（e2e 实测 modifiedFiles 与 R1 全量相同，17 个文件）。

### 3.2 怎么出错

- **A 验证轮全价**：fix 只动 2 个文件，R2+ dirty agent 仍全量重读全部 17 个变更文件。
- **B fixer 重复侦查**：聚合报告只有问题现象，fixer 重新 grep/读文件定位修复点，与 reviewer 的侦查成本重复支付。
- **C 噪声轮**：无客观证据的问题进修复队列 → 改 → 下轮再报 → 轮数膨胀质量不升（Huang et al.：无外部信号多轮互评退化）。现实现的 adjudication 能降级，但降级条目没有任何记录与复活通道。
- **D 盲优化**：提效改动无数据证明有效或有害。
- **E clean 轮黑洞**：最 canonical 的成功路径（修完 → 全 clean）上，末轮 fix 的对账、回归回填、打分全部不发生——eval 数据在最重要的样本上失真。

### 3.3 根因

state.json 被定位为「断点恢复的状态」而非「运行观测数据集」——存储位置、字段集、查询手段、质量维度、终止路径的数据完整性，五者都是这一定位的产物。

## 4. 根因方案 + 物理数据流

**本章结论：一条主干（仪表 + 持久化 + CLI + runId/usage 透传）+ 一条数据链（聚合条目扩展，含归一化层透传修复）+ 三个消费机制（归因/指引/裁决落盘）+ 一个打分与 eval 层（含 clean 轮回填）。**

> **聚合条目结构化扩展** = aggregatorSchema 的 `must_fix_ids` 条目扩为 `{id, severity, files?, evidence?, guidance?}`，顶层加可选 `scores`（§7.2）。**配套修复 `normalizeAggregatorResult` 白名单透传**——否则数据链在归一化层断掉。
> **origin 归因** = R2+ 新 issue：`files ∩ (lastModifiedFiles ∪ fixImpactFiles) ≠ ∅ → regression`，否则 `new`（漏检/新引入不可再分，如实标注）。
> **dormant 清单** = adjudication 判 downgraded/unverified 的条目落 `state.dormant[]`（含裁决理由），注入下轮 R2+ prompt 可复活。**裁决本身是现实现，本设计只补落盘与复活。**
> **客观回填** = reconcile 状态机固有输出：fixed → 报准了；regressed → 没修好/修复引入。clean 轮也要跑（§6.6 黑洞修复）。

物理数据流（含采集点）：

```
agent() 调用（reviewer × N / aggregator / fixer）
  ↓ 主线程 AgentResult（usage/durationMs/sessionId 已存在）
  【引擎透传 1：returnMeta resolve + _callCache 重放重建，两个对称点加 usage/durationMs】
  【引擎透传 2：run 启动时生成稳定 runId 注入 _runId（rebuild 不漂移）】   ← 采集点 1
  ↓
~/.review-fix-loop/<repo-slug>/<runId>/state.json
  ├─ calls[]   : 每次调用资源与耗时（§7.3）
  ├─ issues[id]: {..., origin, guidance, evidence}
  ├─ rounds[]  : {..., phaseTimings{review,aggregate,fix}}
  ├─ dormant[] : adjudication 降级条目 + 理由 + 复活状态
  └─ scores[]  : 10 分制分维度打分（§6.6，弱信号）
  ↓ rfl CLI 读取（不经 LLM）：派生指标现算不落盘
```

## 5. 终态：使用者眼里将是什么样的

**本章结论：run 完一条命令看到成本与质量全景；R2+ 行为不变（全量）；clean 终止轮的对账与回归回填不再缺失。**

### 5.1 成功路径

```
[用户] workflow run review-fix-loop --args targetType=git-diff target=main batch1="..." \
         aggregatorModel=xiaomi-token-plan-cn/mimo-v2.5-pro
[run] R1 全量审查 → 聚合（4 must-fix；1 条 adjudication 判 downgraded → dormant）→ fix
      R2 全量重审 → 1 must-fix（origin=regression）→ fix
      R3 全 clean → 【新增】确定性对账回填：R2 的 fix-attempted → fixed；R2 fix 的回归维度回填
[用户] rfl stats latest
       run rfl-2026...（repo: xyz-agent-workspace-main）  terminated: clean, rounds: 3
       tokens: input 412k (cacheRead 73%)  output 31k  cost $0.41  wall 11m20s
       per-role: reviewer ×6 298k │ aggregator ×2 (mimo) 9k │ fixer ×2 105k
       issues: new 4 → fixed 4（含 R3 回填 1）│ dormant 1（未复活）
       scores: reviewer-a 8.2/10（证据 9/严重度 7/可操作 8/对账 9）
               fix R1 8.5/10 │ fix R2 --（LLM 维度无聚合承载，回归维度 10 已回填）
```

### 5.2 失败路径（带恢复指引）

- **usage/runId 透传缺失**（引擎改动未上线）：calls[] 跳过 usage + WARN；RUN_ID 回退 `"run-"+Date.now()`（维持现状语义）。👉 确认 subagent-workflow 版本含透传。
- **~/.review-fix-loop 不可写**：降级 $TMPDIR + WARN。👉 `mkdir -p ~/.review-fix-loop` 后重跑。
- **扩展字段缺失**（aggregator 未按新 schema 输出或归一化丢失）：对应机制 WARN 降级。👉 先查归一化透传（`normalizeAggregatorResult`）再查 aggregatorModel 档位（⛔ P-agg）。
- **真问题被裁决误降级**：dormant 下轮可复活；复活率持续偏高 → 👉 检查 aggregator prompt 的 adjudication 段是否过激并做代码层调整（无运行期开关——`evidenceGate` 参数不存在，v7 已移除该引用）；最后手段 = 临时移除 adjudication prompt 段（代码改动）。

## 6. 关键决策与权衡

**本章结论：七个机制决策 + 一个回退记录 + 一个黑洞修复。**

### 6.1 origin 归因（数据源 = 聚合条目扩展）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| aggregator 条目带 files + computeOrigin 纯函数（选） | 数据链唯一；reviewer schema 零破坏 | 中（含归一化透传修复） | 文件级粒度粗，regression 偏高估；缺失 WARN | ✅ |
| reviewer 自报 | 有语义潜力 | 中 | 自报不可信 | ❌ |

### 6.2 修复指引：报告列 → 聚合条目 → fixer → state.json

reviewer 报告逐 issue 表增加「修复建议」必填列（**任务归属 v7 明确**：模板改动随 T9 三模板重连同批执行，提取归 T5、落盘归 T6）；aggregator 提取进 `guidance`；fixer 按指引定位（冲突以代码为准）；guidance 写 `state.issues[id].guidance`。

### 6.3 证据裁决落盘：复用现有 adjudication，只补 dormant + 复活通道

**与现实现的关系（v5 修正）**：aggregator prompt 已有 adjudication 段（逐条裁决 evidence/unverified/downgraded+reason）。本决策**不新增裁决逻辑**， deltas 只有三个：① 裁决结果结构化输出（aggregatorSchema 条目增加 `adjudication` 状态字段，downgraded/unverified 条目不占 must_fix 计数——与现状语义一致）；② 降级条目落 `state.dormant[]`（含理由）；③ `buildR2ReviewPrompt` 注入 dormant 清单（复活通道）。省 token 机制：噪声条目被裁决降级后**不再驱动整轮 fix + 后续 review 轮**——省的是轮次不是单条 token。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| adjudication 结果落盘 + dormant 复活通道（选） | 现实现的形式化延续，无平行机制 | 低-中：schema 字段 + dormant 状态 + R2+ 注入 | 误降级（复活通道 + 复活率观测缓释） | ✅ |
| 全新证据门槛机制（v1-v4 的隐含假设） | — | 中 | 与 adjudication 双机制冲突，语义漂移 | ❌ |

### 6.4 aggregator 降档：模型路由在 AGENTS.md，workflow 只给提示

`aggregatorModel` 参数 + usage 提示「参考全局/项目 AGENTS.md 模型路由；无条目请先与主人确认并写入」。当前用户全局 AGENTS.md 已有条目（`xiaomi-token-plan-cn/mimo-v2.5-pro`，thinking 开非 max）。叠加风险：条目提取 + 打分比纯计数吃模型能力 → ⛔ P-agg（能力下限已实测通过，真实 run 填充率待 S1）。

### 6.5 【回退记录】R2+ 聚焦审查：暂缓，数据门槛触发再评估

v3 曾设计「dirty agent R2+ 聚焦 + 每 K 轮审计轮」。**回退理由**：聚焦模式的漏检敞口不可观测（漏掉的问题不进任何统计），无真实数据时引入该风险不值得。R2+ 保持全量重扫。
再评估触发器（可计算性经 v4 审查修正——「非问题文件 token 占比」从定义字段算不出来，弃用）：M0/M1 上线后 ≥10 个真实 run，同时满足 ① R2+ reviewer 单轮 `usage.input` 均值不随轮次下降（calls[] 可算，turn 累积含工具读）；② R2+ 新发现中 origin=new 占比 < 20%（全量重扫的边际产出低）——则聚焦审查重新立项（届时有真实基线对照）。

### 6.6 质量打分：4 维度 × 10 分制 + 加权综合 + clean 轮黑洞修复

**Reviewer 发现质量**（每 reviewer 每轮一条，aggregator 顺手输出）：

| 维度 | 权重 | 0-10 锚定 |
|---|---|---|
| 证据强度 evidence | 40% | 10=每条 must-fix 附可复核证据；0=普遍空断言 |
| 严重度校准 severity | 20% | 10=与影响面相符；0=轻症报 critical 或反之 |
| 可操作性 actionability | 25% | 10=每条带文件/位置/改法；0=只描述现象 |
| 对账诚信 reconciliation | 15% | R2+：10=逐条如实对账；0=漏/假对账。**R1 无上轮**：按「与其他 reviewer 的重复度」评（10=无重复报他人已报） |

**Fix 修复质量**（每 fix 轮一条；输入 = `state.fixResults` 已有的上轮 fixResult，**v5 修正：buildAggregatorPrompt 增加 prevFixResult 入参**，否则 aggregator 没有打分材料）：

| 维度 | 权重 | 0-10 锚定 |
|---|---|---|
| 覆盖完整 coverage | 30% | 10=每条 must-fix 有对应 fixes[] 且 description 对应问题 |
| 自检强度 self-check | 30% | 10=每条附 grep/测试命令+命中数；0=空自检 |
| 最小性 minimality | 20% | 10=affected_files 全与问题相关；0=夹带重构 |
| 回归回填 regression | 20% | **workflow 确定性计算**（非 LLM）：10 − 10×(下轮 regressed 数 / fixes 数) |

**clean 轮黑洞修复（v5 新增，审查发现）**：all-clean 轮现状在聚合/reconcile 前 break。修复 = clean 路径增加**确定性回填**（不调 LLM）：用该轮已解析的 reconciliation 数据跑一次 `reconcileIssues`（fix-attempted → fixed）+ 为上轮 fix 回填 regression 维度。末轮 fix 的 LLM 三维度分（覆盖/自检/最小性）因无聚合调用而**缺省**——如实标注为已知缺口（权威层回归回填不受影响）。R1 无 fix 打分（无上轮 fix）。

### 6.7 eval 设计：客观回填为权威，LLM 打分为弱信号

aggregator 打分单独承担 eval 的两个结构缺陷：自评冲突 + 无 ground truth。权威层是状态机客观回填（含 clean 轮回填修复后的完整数据）：reviewer precision = fixed/所报；fix 质量 = 1 − regressed/fix-attempted；dormant 复活率；轮数/token 分布——CLI 现算。机制改动 A/B 对照：前后各 ≥3 真实 run，`rfl trends` 对比；决策只信客观层。打分留在降档 aggregator 顺带做，定位弱信号。

### 6.8 全量仪表 + 存储迁移 + CLI（含 runId 修复）

- **引擎透传**（两处）：① returnMeta resolve + 重放重建各加 usage/durationMs（两个对称点，已核实无第三路径）；② run 启动生成稳定 runId 注入 `_runId`——修复 rebuild 漂移导致的 run 碎裂（现实现潜在 bug）。
- **存储**：`~/.review-fix-loop/<slug>/<runId>/`，slug = git toplevel 路径 slug 化，非 git 用 cwd，home 不可写降级 $TMPDIR + WARN。**跨版本兼容**：旧 $TMPDIR run 不做迁移（易失数据不抢救）；loadState 只从新位置读。
- **CLI**（`extensions/subagent-workflow/scripts/rfl.mjs`，零依赖；新建 extension 下 scripts/ 目录，若随 npm 分发需加入 package.json `files`）：`rfl list [repo]` / `rfl stats <runId|latest>` / `rfl trends [repo]` / `rfl clean --older-than 30d`（默认干跑，`--yes` 执行）。

### 6.9 prompt 前缀稳定化：三层对齐 + 快照守护（v6 并入自梯队 2）

**机制**：① reviewerSchema.required 恒含 `reconciliation`（R1 prompt 明示「首轮无前轮对账，返回空数组」）——消除 R1↔R2+ schema 分叉导致的 system 段字节差异（schema JSON 逐字嵌入 appendSystemPrompt，agent-opts-resolver.ts）；② R1/R2+/scoped 三个 prompt 模板共享单一静态段文本来源，变化内容（轮次 header/roundDir/对账数据/fix 结果）全部后置到 `--- ROUND CONTEXT ---` 动态段起点标记之后；③ 快照单测守护「动态段起点标记之前逐字节相同」。

**前提已探明**（梯队 2 §11，两个探针均 ✅）：本环境主用 provider 消息级缓存命中 97-99%（前缀稳定化收益前提成立）；env block 无逐 spawn 动态因子（session-runner.ts buildEnvBlock，无时间戳/随机数）。**收益边界**（P-shared）：批内不同 reviewer 的 system prompt 不同，前缀无法跨 reviewer 共享——收益 = 「同一 reviewer 跨轮」。

方案对比与三层（引擎 system 段 / 脚本 user 段 / provider 缓存判定）对齐的详细论证见梯队 2 文档 §4/§6.1，本文不重复。改动文件：`review-fix-loop-utils.cjs`（三模板重构）+ `review-fix-loop.js`（schema required 统一 + R1 空数组说明）+ `src/__tests__/review-fix-loop-utils.test.ts`（快照测试）。

## 7. 数据结构规格（开发可直接依据）

### 7.1 引擎透传（worker-script-builder.ts + run 启动路径）

returnMeta resolve 与 `_callCache` 重放重建各扩 `{usage, durationMs, sessionId}`（两个对称点；sessionId 补入零成本——AgentResult 已含（types.ts），§7.3 calls[] 需要它）；引擎 run 启动生成 runId 并注入 `_runId`（worker rebuild 沿用同一值；注入点覆盖两个 args 入口——runAndWait（launcher.ts:180）与 executeNestedWorkflow（launcher.ts:290），或在 workerData.args 单一 choke point 注入）。⛔ P-replay：重放 run 的 calls[] 同样含 usage——验收用「注入错误触发 rebuild」而非「同参数重跑」（v4 的 S3 写法错误：新引擎 run 无缓存可重放）。

### 7.2 aggregatorSchema 扩展 + 归一化透传

```jsonc
// must_fix_ids 条目（现 {id,severity} 扩为）
{ "id": "MF-1", "severity": "critical|major|minor",
  "files": ["src/a.ts"], "evidence": "…", "guidance": "…",
  "adjudication": "evidence|unverified|downgraded" }
// 顶层新增（可选）
"scores": [{ "round": 1, "targetKind": "reviewer|fix", "targetName": "…",
             "dimensions": {"evidence": 9, "...": 0}, "total": 8.2, "note": "…" }]
```

**实施增补（M1 spec-review 裁决，2026-08-20）**：条目增加 `note` 可选字段（裁决理由载体，adjudication 为 unverified/downgraded 时必填）——设计原文的「降级条目落 dormant（含理由）」在原条目结构中无理由数据源（理由只在 aggregated.md 表格），spec-review 发现后增补此字段；dormant.detail = note ?? evidence（理由优先、证据兜底）。消费侧过滤语义同场裁决明确：降级条目**保留在 must_fix_ids 数组**（带 adjudication 标记，数据链闭合的前提），由脚本主循环 `filterActiveIds` 过滤出修复队列；must_fix 计数由 aggregator 按非降级条目报（与 6.3「不占 must-fix 计数」一致）。

**实施增补（v7.1，实施后对抗式审查裁决，2026-08-20）**：① **rebuild 幂等**——`loadState` 读到同 `_runId` 既有 state 视为上一 attempt 残留（engine script-error rebuild 后同 RUN_ROOT 重跑），重置全部易变累积字段（calls/fixResults/fixCount/issues 等），仅保留 `meta.previousAttempts` 计数供事后观测区分 rebuild——否则 attempt-2 重放的 recordCall/fixResults 全部双记。② **dormant 批作用域**——dormant 与 issues 同点批作用域重置；理由 = aggregator id 空间每批从 MF-1 重新编号，跨批残留的 dormant id 会与后续批活跃同号 id 冲突，经 `filterDormantFromRecon` 把活跃条目从对账 seen 剥离、误反转 fixed。③ **guidance 到 fixer 的确定性通道**（方案①）——`buildFixPrompt` 新增可选 `guidance` 入参（`[{id, guidance}]`），per-issue 修复指引经 wrapUntrusted 包裹独立渲染（reportContent 正文之外直达 fixer），兑现 §2 目标 3「fixer 免侦查」。④ **全降级轮不再驱动 fix/后续 review 轮**（§6.3 省轮次的兑现）——reviewer 报 must-fix 但 aggregator 裁决全部降级（mustFix===0 且活跃条目为 0）时视同 clean 终止该批当前轮（含 round>1 的确定性对账回填），不空转派发 fixer。⑤ **severity 枚举回退 major + scores 逐条形状校验落地**——normalizeAggregatorResult 对非 `critical|major|minor` 的 severity 单点回退 major（schema 同步加 enum 约束生成侧）；scores 落盘提取 `landScores` 纯函数逐条校验（targetKind 非空字符串 + round 为 number + dimensions 为 plain object），畸形计数进 WARN 不再静默落盘/丢弃。

**配套修复**：`normalizeAggregatorResult` 白名单放行条目扩展字段与顶层 scores（v4 审查发现：现实现只保留 `{id,severity}`，扩展字段被静默丢弃）。

scores 的 `round` 语义 = 被打分对象所在轮（R2 聚合给 R1 的 fix 打分则 round=1）；clean 轮无聚合调用，regression 回填 entry 由 workflow 确定性创建（round=被打分轮，LLM 三维度为 null，total 缺省标注）。条目 `adjudication` 字段随 T5 落地 schema，T6 只消费不改动。

### 7.3 state.json 新增字段

```jsonc
{
  "calls": [{ "batch": 1, "round": 1, "role": "reviewer|aggregator|fixer",
              "name": "…", "model": "…", "durationMs": 83000,
              "usage": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},
              "promptMode": "full|scoped", "promptBytes": 12345, "sessionId": "…" }],
  "dormant": [{ "id": "MF-7", "reason": "adjudication-downgraded|unverified",
                "detail": "裁决理由", "round": 1, "revived": false }],
  "scores": ["见 7.2 scores 结构；regression 维度由 workflow 下轮（含 clean 轮）回填"],
  "issues": { "MF-1": { "…现有字段": "…", "origin": "regression|new", "guidance": "…", "evidence": "…" } },
  "batches[].rounds[].phaseTimings": { "review": [t0,t1], "aggregate": [t0,t1], "fix": [t0,t1] }  // [t0,t1] = ms epoch number 对（Date.now()），与 calls[].durationMs 同单位
}
```

### 7.4 rfl CLI 命令

| 命令 | 输出 |
|---|---|
| `rfl list [repoSlug]` | run 清单（runId/时间/终止原因/轮数） |
| `rfl stats <runId\|latest>` | 单 run 全景（§5.1 形态）：token 汇总 + 缓存命中率 + per-role 分布 + origin 分布 + dormant + scores 表 + 轮次时间线 |
| `rfl trends [repoSlug]` | 跨 run 趋势表（轮数/token/regression 率/缓存命中率） |
| `rfl clean --older-than 30d` | 清理（默认干跑，`--yes` 执行） |

### 7.5 存储路径

`~/.review-fix-loop/<slug>/<runId>/state.json`；slug 化规则：`git rev-parse --show-toplevel`（失败用 cwd）→ 路径分隔符替换为 `-`；reports 目录随 RUN_ROOT 迁移；home 不可写降级 $TMPDIR + WARN。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：中大改动；核心验收是数据落地正确 + clean 轮回填生效 + 打分结构符合 rubric。**

### 8.1 改动规模

中大：引擎两处透传 + 存储迁移 + schema/归一化扩展 + dormant + 打分 + CLI。不改循环骨架，R2+ 保持全量。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 真实 PR 全跑 + 数据落地 | 目标 1/2/3/4 | xyz-agent 仓真实 PR（≥5 文件）跑到终止 | state.json 在新位置；calls[] 每条含 durationMs+usage 五字段；issues 带 origin/guidance；R2+ 为全量 prompt |
| S2 clean 轮回填（黑洞修复） | 目标 5/7 | S1 的 run（终止=clean） | 末轮 fix 的 issues 从 fix-attempted 转 fixed（history 可查）；末轮 fix 的 regression 维度已回填；LLM 三维度缺省有标注 |
| S3 CLI 可用 | 目标 1 | `rfl stats latest` + `rfl trends` | 输出 §5.1 形态；数字与 state.json 抽查一致 |
| S4 引擎重放 + runId 稳定 | 目标 7 | 受控脚本故障注入：临时脚本副本注入一次 throw（对齐 script-error → rebuild 既定恢复路径，error-recovery.ts 重试矩阵）。注意 agent 错误**不**触发 rebuild——B1 起 agent() 失败一律 resolve 容错（worker-script-builder.ts:150-156），不能用 agent 错误注入 | rebuild 后 _runId 不变（state 目录唯一）；重放调用在 calls[] 含 usage（⛔ P-replay） |
| S5 dormant 与复活 | 目标 4 | 抽查 S1：若 adjudication 产生降级条目 | dormant 有记录含理由；下轮 R2+ prompt 含 dormant 清单。**若 S1 未产生降级**：以首个产生降级的真实 run 补验（⛔ P-dormant-first），不构造人工场景 |
| S6 打分结构 | 目标 5 | S1 的 state.scores | 每轮每 reviewer 一条；fix 轮一条（R1 除外）；维度齐全；total=加权和抽查一致；regression 为下轮回填 |
| S7 存储降级与回退 | 护栏 | 非 git 目录跑一次；模拟 home 不可写（只读挂载或权限）跑一次 | 非 git 落 cwd slug；home 不可写降级 $TMPDIR + WARN（v7 已移除 evidenceGate 引用——该参数不存在） |
| S8 首份 eval 报告 | 目标 5 | 累计 ≥3 个真实 run（S1 + 后续两个真实 PR run）后 `rfl trends` | 客观层指标成表；scores 标注弱信号 |
| S9 跨轮字节稳定（6.9） | 目标 8 | S1 的 run（≥2 轮）：从引擎 run store `<sessionDir>/workflow-state/<runId>.jsonl` 提取同一 reviewer 相邻两轮 call opts（jsonl-run-store.ts 逐 call 持久化完整 opts：prompt 全文 + appendSystemPrompt 数组 + schema）。注：pi stdout jsonl 与 session jsonl 均不含 system 段，append-system-prompt 临时文件 run 后即删（temp-prompt.ts）——run store 是唯一可行提取路径 | system 段（appendSystemPrompt 拼接）与 user 段（opts.prompt）在动态段起点标记之前逐字节相同；快照单测通过；R1 报告含 reconciliation 空数组字段且下游对账逻辑无异常 |

## 9. 实施

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | 引擎两处透传（usage/durationMs + _runId）+ calls[] + 存储迁移 + CLI | 目标 1/7 |
| M1 | 聚合条目扩展（含归一化透传修复）+ origin + adjudication 落盘 + dormant + guidance | 目标 2/3/4 |
| M2 | 打分 + clean 轮回填 + aggregatorModel + 首份 eval | 目标 5/6 |
| MP（T6 之后串行，或与 M1 同分支） | T9 prompt 前缀稳定化（模板/schema 统一 + reviewer 报告「修复建议」列 + 快照测试） | 目标 8（兼 6.2 第一环） |

## 10. 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| T1 引擎透传 usage/durationMs（两个对称点）+ P-replay | worker-script-builder | 仪表地基；引擎改动独立审查 |
| T2 引擎 _runId 稳定注入 | run 启动路径（覆盖两个 args 入口：runAndWait launcher.ts:180 / executeNestedWorkflow launcher.ts:290，或 workerData.args 单一 choke point） | 修 run 碎裂；与 T1 同为引擎但独立关注点 |
| T3 RUN_ROOT 迁移 + slug + 降级 | utils + 脚本 | 依赖 T2（路径含 runId） |
| T4 calls[] 采集 + rfl.mjs CLI | 采集点 + 新 CLI | 依赖 T1/T3 |
| T5 聚合条目扩展 + normalizeAggregatorResult 透传修复 + scores 字段 | schema + prompt + utils | 数据链前提；归一化透传是 v4 审查发现的断点 |
| T6 computeOrigin + dormant 落盘/复活注入 + guidance 落盘 | utils + 集成 | 依赖 T5 |
| T7 打分 rubric 进 aggregator prompt（含 prevFixResult 入参）+ scores 落盘 + clean 轮确定性回填 | 6.6 | 依赖 T5；黑洞修复独立关注点 |
| T8 aggregatorModel 参数 + usage 提示 + P-agg 复测 | 参数与文案 | 独立 |
| T9 prompt 前缀稳定化（6.9） | utils 三模板共享静态段 + 动态后置 + reviewerSchema.required 恒含 reconciliation + R1 空数组说明 + 快照单测；连带（v7 声明）：删除 R2+/scoped 冗余 required spread（review-fix-loop.js:427/447）、更新 reconciliation 的 stale description 文案（:219 附近，逐字嵌进 system prompt）、reviewer 报告指令加「修复建议」必填列（6.2 第一环）；dormant 清单（T6 注入）属动态段内容 | 逻辑无依赖但文件级重叠真实：与 T5/T7 同改 utils.cjs、与 T6 同函数 buildR2ReviewPrompt——T6 之后串行或与 M1 同分支；设计细节见梯队 2 文档 §6.1/§7 |

## 11. 待验证检查点

- ⛔ P-replay：重放路径 usage 完整性 + rebuild 后 runId 稳定（S4）。
- 🟡 P-agg：降档 aggregator 能力下限已实测通过（mimo-v2.5-pro 合成探针：去重/空证据/分维度打分正确）；真实 run 填充率与去重一致率待 S1。
- ⛔ P-dormant-first：首个产生 adjudication 降级的真实 run 补验 S5（dormant 记录 + 复活注入）。
- ⛔ P-score-drift：降档模型打分稳定性（同一报告两次打分差异 >2 分则不可用作趋势信号）。
- ✅ P-cache（已探明，2026-08-20）：主用 provider 消息级缓存命中 97-99%，6.9 前缀稳定化收益前提成立。
- ✅ P-sys（已探明，源码）：env block 无逐 spawn 动态因子；残余未知 = tools 清单稳定性（位于 pi base system prompt，子进程内存拼装不落盘，T9 快照测试物理不可见——由修正后的 S9 run store 提取路径覆盖）。
- ⛔ P-shared：6.9 收益边界 = 同一 reviewer 跨轮（不同 reviewer 的 system prompt 不同，无法共享前缀）。
- ℹ️ P-cache-benefit：基线缓存命中已 97-99%，T9 残余收益空间待量化——M0 后用 calls[] 的 cacheRead 占比按轮次拆开即得（6.7 数据链已具备），MP 验收时回填结论。
- ✅ 已核实（源码）：AgentResult.usage/durationMs 存在、returnMeta 不透传（两个对称改动点、无第三路径）；引擎不注入 _runId；normalizeAggregatorResult 白名单截断（utils.cjs:638-672）；adjudication 段已存在于 aggregator prompt（buildAggregatorPrompt，utils.cjs:320 起）；clean 轮在聚合/reconcile 前 break（review-fix-loop.js all-clean 分支）；reviewerSchema.must_fix 为 number；state.json 现仅 meta.startedAt 一个时间字段。

## 附录：变更历史

- v1：初版。v2：首轮对抗审查后重写（19 must-fix 分布在三个梯队）。v3：仪表地基 + 持久化 + CLI + eval 双层。v4：聚焦审查回退（6.5）；打分细化 10 分制；§7 数据规格；四个前置探针探明（P-cache/P-sys/P-replay 点位/P-agg 能力下限）。
- v5：第二轮对抗审查后修 8 must-fix——clean 轮黑洞修复（确定性对账回填，6.6）；normalizeAggregatorResult 白名单透传修复入 T5；6.3 重定位为 adjudication 落盘（裁决是现实现，不新增平行机制）；引擎 _runId 稳定注入入 T2（修 rebuild 漂移碎裂）；6.5 触发器①改可计算指标；fix 打分输入补 prevFixResult 入参 + R1 reconciliation 维度定义；S3 改错误注入法、S5 改条件断言 + P-dormant-first；§3.2 自包含展开。审查报告见同目录 `tier-1-cheap-wins-review-v4.md`。
- v6：并入梯队 2 的前缀稳定化（6.9 / T9 / S9 / MP 里程碑；其前置探针 P-cache/P-sys 已探明随附 §11）。梯队 2 整体处置为「前缀稳定化并入本文档、diff 指纹否决、持久会话暂时不做」（见 tier-2 文档附录 v3）；梯队 3 标记暂时不做、由本文档 M1 仪表数据触发再评估（见 tier-3 文档附录 v3）。
- v7：第三轮对抗审查（开发就绪度，报告见 `tier-1-cheap-wins-readiness-review-v6.md`，裁决「修完 blocker 后可开工」）修 1 blocker + 5 major + 9 minor + 1 info——BLOCKER：`evidenceGate` 参数不存在（全仓零命中），移除 §5.2/S7 引用，S7 改纯存储降级场景，S8 run 来源重述；M1：T9「全无依赖」更正为「逻辑无依赖、文件级与 T5/T6/T7 重叠」，MP 改 T6 后串行/同分支，dormant 清单明确属动态段；M2：S9 提取路径改引擎 run store workflow-state jsonl（pi stdout/session jsonl 无 system 段、临时 prompt 文件 run 后即删，run store 是唯一可行路径）；M3：S4 改受控脚本故障注入（agent 错误 B1 起一律 resolve 容错，不触发 rebuild）；M4：§7.1 透传补 sessionId（§7.3 calls[] 需要）；M5：「修复建议」列归属 T9；minor：行号漂移修正（638-672 / 320 起）、T9 两处连带机械改动声明（冗余 required spread 删除 + stale description 文案）、rfl.mjs 路径归属 extension scripts/、P-sys 残余未知改标 S9 覆盖、scores round 语义与 clean 轮 entry 形态、T2 双入口、adjudication 字段归 T5、phaseTimings 时间戳格式；info：P-cache 残余收益量化挂 6.7 数据链（MP 验收时回填）。
