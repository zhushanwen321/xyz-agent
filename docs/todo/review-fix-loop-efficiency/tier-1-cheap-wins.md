# review-fix-loop 效率优化 梯队 1：轮次归因 + 聚焦验证轮 + 证据门槛 + 全量仪表与 eval

> **一句话结论**：把 review-fix-loop 从「黑盒循环」改造成「可观测、可归因、可评估」的循环——全量仪表（每次 agent 调用的耗时/token/缓存命中落 state.json，持久化到 `~/.review-fix-loop/` 并配 CLI 查询）是所有优化的地基；其上挂四个省成本机制（origin 归因、dirty agent 聚焦审查 + 审计轮、证据门槛、aggregator 降档）；eval 以「状态机客观回填」为权威、aggregator LLM 打分为辅。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 是 subagent-workflow extension 的内置 workflow，结构为「多批串行 × 批内多轮：并行 review → 聚合 must-fix → fix → 重审直到 clean」。状态持久化在 `$TMPDIR/review-fix-loop/<runId>/state.json`——系统清理即丢失，本地 441 个历史 run 全是 e2e fixture，无一真实 run。
- **C（冲突）**：三个互相加重的问题：① 每轮全价（成本与轮次类型无关）；② 轮次构成不可见（state.json 回答不了「R2+ 的 must-fix 是哪来的、每轮花了多少、谁报的准」）；③ 没有 eval 手段（任何优化的效果无法度量，v1/v2 的优先级排序只能靠推断）。
- **Q（问题）**：怎么让每一轮的成本与质量可见、可归因，并在此基础上减少轮数、降低轮内成本？
- **A（答案）**：地基先行——全量仪表 + 持久化存储 + CLI（本文档新增，原为最短板）；然后一条数据传输链（aggregator 聚合条目结构化扩展）供养三个机制（origin 归因 / 证据门槛 / 修复指引）；dirty agent 聚焦审查 + 审计轮压验证轮成本；eval 用「客观回填 + LLM 弱信号打分」双层。

## 1. 背景：被设计的系统是什么

**本章结论：review-fix-loop 是「审查-修复」循环编排器；本次设计 = 可观测性地基 + 四个省成本机制 + eval 方法。**

一次 run 的内部循环：批次串行；批内每轮 `parallel()` 派发多个 reviewer agent → aggregator agent 跨报告去重聚合（`must_fix_ids`，现有条目 `{id, severity}`）→ fix agent 按聚合报告修复 → 下轮重审。关键现状（均经源码核实）：

- reviewer 输出 schema 中 `must_fix` 是 **number 计数**，逐 issue 明细只存在于 reviewer 写盘的 markdown 报告里。
- R2+ reviewer 两类路径：上轮 clean 的 agent 默认跳过（`skipCleanAgents=true`，零成本）；上轮 dirty 的 agent 走 `buildR2ReviewPrompt` 全量重审。`recheckAfterFix`（默认 false）是回归护栏（重派 clean agent 走限定 prompt），不是省 token 机制。
- **资源数据在主线程侧已存在但未透传**：`AgentResult` 含 `usage{input, output, cacheRead, cacheWrite, cost, contextTokens, turns}` + `durationMs` + `sessionId/sessionFile`（`src/orchestration/models/types.ts`）；但 workflow 脚本的 `agent({returnMeta:true})` 只收到 `{value, sessionFile, worktreePath, error}`（`src/orchestration/worker-script-builder.ts` 的 resolve 分支，含 callCache 重放对称路径）——**usage/durationMs 不到脚本层，写不进 state.json**。
- issue 级状态机：`state.issues`（firstSeen/severity/status/history/fixAttempts），status 经 open → fix-attempted → fixed/regressed 流转——**这台状态机本身就是免费的 eval 数据源**（见 §6.8）。

**层声明**：当前层 = 技术方案设计；下一层 = 实现任务。准则 5/6/7 全适用。

## 2. 设计目标

**本章结论：改造后每次 run 的每一轮「花了多少、报得准不准、修得好不好」全部落盘可查；四个省成本机制的效果用落盘数据说话。**

1. **可观测**：每次 `agent()` 调用记录耗时、token（输入/输出/缓存读/缓存写）、模型、prompt 模式；state.json 持久化到 `~/.review-fix-loop/`（按 git repo 建子目录，非 git 用 cwd），不被 /tmp 清理；配简易 CLI 直接查询，不用手写 jq。
2. **可归因**：R2+ 新 issue 带 origin（regression / new）。
3. **验证轮聚焦**：dirty agent 的 R2+ 默认聚焦（范围 = 自身未决问题文件 ∪ 上轮改动文件 ∪ 受影响文件），每 K 轮全量审计轮兜底。
4. **fixer 免侦查**：聚合报告每条 must-fix 带修复指引，且指引写入 state.json。
5. **噪声被挡**：无客观证据的条目聚合阶段降级 dormant，下轮可带证据复活。
6. **聚合便宜**：aggregator 支持降档模型（模型选择不写死在 workflow，走用户 AGENTS.md 路由）。
7. **可评估**：eval 双层——状态机客观回填（免费、权威）+ aggregator LLM 打分（弱信号、抽查）。

**In-scope**：review-fix-loop.js / utils / aggregator schema 与 prompt / state.json 结构与存储位置 / CLI 脚本 / 引擎 returnMeta 透传小改动。**Out-of-scope**：reviewerSchema 破坏性变更；持久会话与缓存前缀（梯队 2）；可执行验证（梯队 3，其 verify 结果落盘复用本文档仪表）；recheckAfterFix 语义（维持现状）。

## 3. 现状：使用者眼里是什么样的

**本章结论：每轮全价、数据随 /tmp 消失、想分析只能靠手写 jq 翻残存 fixture——优化没有仪表。**

### 3.1 现状的真实样子

- run 结束后 state.json 在 `$TMPDIR`（macOS 定期清理）——本地 441 个历史 run 全是 e2e fixture 就是这个原因的真实写照：**真实 run 的数据活不下来**。
- 现有 state.json 只有 `meta.startedAt` 一个时间字段，无任何 token/耗时/缓存记录——想回答「审查段占时长比多少」「缓存命中率多少」无从谈起。
- 聚合条目 `{id, severity}` 无文件/证据/指引维度（梯队 1 v2 已分析）。
- R2+ dirty agent 全量重扫（e2e 实测：modifiedFiles 与 R1 全量相同，17 个文件）。

### 3.2 怎么出错

- **A 验证轮全价**、**B fixer 重复侦查**、**C 噪声轮**（v2 已述，不重复）。
- **D 盲优化**：任何「提效」改动上线后，没有数据能证明它有效或有害——v2 审查发现的多个设计错误（如 scoped 语义误读），若早在真实数据上跑过就不会犯。

### 3.3 根因

设计时把 state.json 定位为「断点恢复的状态」，没定位为「运行观测的数据集」——存储位置（易失 tmp）、字段集（只有流程状态无资源用量）、查询手段（无 CLI）三者都是这一定位的产物。

## 4. 根因方案 + 物理数据流

**本章结论：一条主干（全量仪表 + 持久化 + CLI）+ 一条数据链（聚合条目结构化扩展）+ 三个消费机制（归因/门槛/指引）。**

> **聚合条目结构化扩展** = aggregatorSchema 的 `must_fix_ids` 条目从 `{id, severity}` 扩展为 `{id, severity, files?, evidence?, guidance?}`。aggregator 本来就通读各 reviewer 报告做去重，顺手提取。origin 归因、证据门槛、修复指引三个机制共用这条链。
> **origin 归因** = R2+ 新 issue 判定：`files ∩ (lastModifiedFiles ∪ fixImpactFiles) ≠ ∅ → regression`，否则 `new`（漏检与全新引入不可再分，如实标注）。
> **休眠清单（dormant list）** = 被降级条目（无证据 / 梯队 3 验证失败）写入 `state.dormant[]`，注入下轮 R2+ prompt 可复活。
> **客观回填** = reconcile 状态机的固有输出：上轮报的 issue 本轮转 fixed → reviewer 报准了；转 regressed → fix 没修好或修复引入。这是不需要任何额外 LLM 调用的质量信号。

物理数据流（含仪表采集点）：

```
agent() 调用（reviewer × N / aggregator / fixer）
  ↓ 主线程 AgentResult（usage/durationMs/sessionId 已存在）
  【引擎透传改动：returnMeta resolve 增加 usage + durationMs】      ← 采集点 1
  ↓ 脚本层收到后写入
state.json（新位置 ~/.review-fix-loop/<repo-slug>/<runId>/state.json）
  ├─ calls[]: {batch, round, role, name, model, durationMs, usage{input,output,cacheRead,cacheWrite,cost}, promptMode, promptBytes}
  ├─ issues[id]: {..., origin, guidance, evidence}                ← 采集点 2（聚合条目扩展）
  ├─ rounds[]: {..., phaseTimings{review,aggregate,verify,fix}}   ← 梯队 3 复用此字段
  ├─ dormant[]: 降级条目 + 复活状态
  └─ scores[]: aggregator 打分（弱信号）                          ← 采集点 3
  ↓ CLI 读取（不经 LLM）
 rfl stats <runId> / rfl trends <repo> —— 派生指标由 CLI 现算，不落盘防双写不一致
```

## 5. 终态：使用者眼里将是什么样的

**本章结论：run 完一条命令看到成本与质量全景；省成本机制的行为与 v2 一致（聚焦审查/证据门槛/指引/降档）。**

### 5.1 成功路径

```
[用户] workflow run review-fix-loop --args targetType=git-diff target=main batch1="..." \
         aggregatorModel=xiaomi-token-plan-cn/mimo-v2.5-pro        ← 模型来自 AGENTS.md 路由，非 workflow 写死
[run 结束后]
[用户] rfl stats latest
       run rfl-2026...（repo: xyz-agent-workspace/main）
       rounds: 3 (R1 full → R2 focused → R3 audit)  terminated: clean
       tokens: input 412k (cacheRead 301k = 73%)  output 31k  cost $0.41  wall 11m20s
       per-role: reviewer ×6 calls 298k │ aggregator ×2 (mimo) 9k │ fixer ×2 105k
       issues: R1 new 4 → fixed 3, regressed 1 (origin=regression) │ dormant 1 (无证据，未复活)
       scores(弱信号): reviewer-a precision 3/4 │ fix round-1 质量 2/2
```

### 5.2 失败路径（带恢复指引）

- **usage 透传缺失**（引擎改动未上线而 workflow 先上线）：calls[] 记录跳过 usage 字段并 WARN，不断流。👉 确认 subagent-workflow 版本含 returnMeta 透传（`rg "usage" src/orchestration/worker-script-builder.ts`）。
- **~/.review-fix-loop 不可写**：降级回 $TMPDIR 并 WARN（数据易失）。👉 `mkdir -p ~/.review-fix-loop && chmod u+rwx` 后重跑。
- **打分/归因字段缺失**（aggregator 未按新 schema 输出）：对应字段空 + WARN，主流程不断。👉 检查 aggregatorModel 是否过低配（P-agg 探针）。
- 其余失败路径（证据误降级/聚焦漏检/回退开关）与 v2 一致：`evidenceGate=false`、`scopedR2=false`、审计轮兜底。

## 6. 关键决策与权衡

**本章结论：八个决策——一个地基（仪表）、一条数据链、三个省成本机制、一个 eval 方法、一个存储迁移。**

### 6.1 origin 归因（与 v2 一致，数据源 = 聚合条目扩展）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| aggregator 条目带 files + computeOrigin 纯函数（选） | 数据链唯一；reviewer schema 零破坏 | 中 | 文件级粒度粗，regression 偏高估；缺失时 WARN 兜底 | ✅ |
| reviewer 自报 | 有语义潜力 | 中 | 自报不可信 | ❌ |

如实声明：文件级粒度高估 regression（fixImpactFiles 含「仅检查未改」参考文件）；origin=new 不再区分漏检/新引入——观测窗口边界如实标注。

### 6.2 验证轮聚焦（大白话版）

**先解释机制本身**（v2 表述被反馈看不懂）：

- **dirty agent** = 上一轮报过问题的 reviewer。现状它下一轮要把所有变更文件**重新完整审一遍**（17 个文件全读）。
- **聚焦** = 下一轮它只细读两类文件：① 它自己报的问题所在的文件（确认修好没）；② fixer 这轮改动的文件（检查改出新毛病没）。其他文件跳过。
- **风险**：只盯局部可能漏掉别处的新问题（而漏掉的不会出现在任何统计里——你看不到你没发现的东西）。
- **审计轮** = 兜底：每 K 轮（默认 3）安排一轮**全量**审查（回到现状的重扫模式），另外宣布 clean 前最后一轮也必须全量。漏检在审计轮会以 origin=new 浮出，可统计——「用数据判断聚焦是否太窄」因此成立。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| dirty 聚焦 + 每 K 轮审计 + clean 前强制全量（选） | scope 数据来自 6.1 同一条链；审计轮给漏检开观测窗 | 中：buildR2ReviewPrompt 聚焦变体 + 轮次计数 | 聚焦轮漏 scope 外新问题（审计轮兜底）；K=3 拍脑袋待校准（P-audit） | ✅ |
| 每轮全量（现状） | 召回最大化 | 零 | 验证轮全价 | ❌ |
| recheckAfterFix 翻默认（v1） | — | 极低 | 源码证实语义相反：scoped 只服务上轮 clean agent，翻转是增支换护栏 | ❌ |

### 6.3 修复指引：报告列 → 聚合条目 → fixer → state.json

reviewer 报告逐 issue 表增加「修复建议（文件/位置/改法）」必填列；aggregator 提取进条目 `guidance`；fixer prompt 要求按指引定位（指引与代码冲突以代码为准）；**guidance 同时写入 state.json 的 issues[id].guidance**——事后分析「哪类指引 fixer 跟得住」有数据。对齐 AlphaCodium 定向修复。

### 6.4 证据门槛：省 token 的机制说明（针对「它到底省什么」）

**作用机制**：噪声问题（reviewer 猜测/幻觉的问题）一旦进修复队列，成本不是「处理这一条」而是**整轮**——fixer 改一个不需要改的地方（烧一轮 fix 的输入输出 + 可能改出新问题），下轮 reviewer 对新代码再报（再烧一轮 review）。证据门槛在聚合处把「拿不出客观证据（测试输出/lint 报错/grep 命中+行号）」的条目降级为 suggestion（进 dormant，可复活），**省的是噪声驱动的整轮 fix + 后续 review 轮**，这是轮数维度的节省，不是单条 token。依据：CRITIC（证据驱动 critique）+ Huang et al.（无外部信号多轮互评退化）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| aggregator 端门槛 + dormant 复活通道（选） | 门槛在唯一聚合点；schema 零破坏 | 中 | 真问题误降级（复活通道 + 复活率观测缓释） | ✅ |
| reviewer schema 加必填 evidence（v1） | — | — | must_fix 是 number 计数，无条目可挂字段 | ❌ |

### 6.5 aggregator 降档：模型路由在 AGENTS.md，workflow 只给提示

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| workflow 暴露 `aggregatorModel` 参数 + usage 提示「可传便宜模型，参考全局/项目 AGENTS.md 模型路由；若无条目请先与主人确认并写入 AGENTS.md」（选） | 模型选择权属用户配置层（AGENTS.md），workflow 不写死——换模型不改代码 | 低：参数透传 + @pi-meta usage 文案 | 无人配置时退回 run 级模型（现状行为，安全默认） | ✅ |
| workflow 内写死 mimo（用户明确否决） | — | 极低 | 模型更迭要改代码；对用户环境越权 | ❌ |

当前用户的全局 AGENTS.md 已有路由条目：`aggregatorModel=xiaomi-token-plan-cn/mimo-v2.5-pro`（thinking 开，非 max——聚合是机械工作）。主 agent 派发 workflow 时按此传参；读不到该条目时（其他环境/项目）询问用户后写入 AGENTS.md。
叠加风险声明（与 6.1/6.3/6.4 共用传输链）：条目结构化提取比纯计数吃模型能力。⛔ P-agg：同一真实 run 对比降档/高档的字段填充率与去重一致率。

### 6.6 全量仪表：引擎透传 + calls[] 落盘

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 引擎 returnMeta 透传 usage/durationMs + 脚本写 calls[]（选） | 一次引擎小改动，所有 workflow 受益（不止本 loop） | 中：worker-script-builder resolve 分支 + callCache 重放对称（9b/9c 注释约束）+ 脚本采集 | 重放对称破坏（透传字段必须进缓存，否则重放 run 数据缺角）——⛔ P-replay 探针 | ✅ |
| 脚本侧自行估算 token | 不动引擎 | 低 | 估算不准（尤其 cacheRead 不可估算），数据失真误导 eval | ❌ |

✅ 已核实（源码）：主线程 `AgentResult.usage`（input/output/cacheRead/cacheWrite/cost/contextTokens/turns）+ `durationMs` 存在；returnMeta 现状只透传 `{value, sessionFile, worktreePath, error}`。**额外记录项**（用户问题 4 的清单）：model/thinkingLevel/promptMode（full/focused/audit/scoped）/promptBytes（前缀稳定性观测）/sessionId/sessionFile（事后深挖可定位 pi session JSONL）/各阶段 phaseTimings（梯队 3 流水化触发器复用）/终止原因。派生指标（缓存命中率、per-role 汇总）由 CLI 现算不落盘，防双写不一致。

### 6.7 state.json 持久化：`~/.review-fix-loop/<slug>/<runId>/` + CLI

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| home 下持久目录 + repo slug 子目录 + CLI（选） | 数据活下来才有 eval；按 repo 分目录支持跨 run 趋势 | 低-中：路径推导（`git rev-parse --show-toplevel` slug 化，非 git 用 cwd slug）+ 简易 CLI | 磁盘缓慢增长（CLI 提供 clean 子命令） | ✅ |
| 维持 $TMPDIR | 零 | 零 | 真实 run 数据随系统清理消失（现状实证） | ❌ |

CLI（`extensions/subagent-workflow/scripts/rfl.mjs`，node 直接跑）：`rfl list [repo]` / `rfl stats <runId|latest>` / `rfl trends [repo]`（跨 run 指标趋势）/ `rfl clean --older-than 30d`。零依赖纯 node。

### 6.8 eval 设计：客观回填为权威，LLM 打分为弱信号

**aggregator 打分是否足够？不够，单独承担有两个结构缺陷**：① 自评冲突——它聚合完同一份数据再打分，既当运动员又当裁判；② 无 ground truth——LLM 对「这个发现是不是真问题」的判断不比 reviewer 本身更权威。但它有存量状态机提供的**免费客观信号**：reconcile 流转（fixed/regressed）+ origin + verify 结果（梯队 3）就是质量真值的近似。

| 层 | 内容 | 成本 | 权威性 |
|---|---|---|---|
| 客观回填（权威） | reviewer precision = 所报 issue 后续 fixed 占比；fix 质量 = 1 − regressed/fix-attempted；dormant 复活率；verify-failed 率；轮数/收敛速度/token 分布——CLI 从 state.json 现算 | 零（状态机固有输出） | 高（行为证据，非意见） |
| aggregator LLM 打分（弱信号） | 聚合时顺手输出 per-reviewer 0-2 质量注记 + 上轮 fix 0-2 注记 + 「哪些是修复引入」判断，写 state.scores[] | 顺带（同一调用） | 低-中（用于趋势抽查，不作决策依据） |

**eval 怎么用**：机制改动做 A/B 对照——改动前后各跑 ≥3 个真实 run，`rfl trends` 对比确定性指标（轮数、token、regression 率、缓存命中率）。决策只信客观层；LLM 打分只做异常线索。
**降档模型能否承担打分**：聚合（去重/格式化，机械）可降档；打分要判断力，与降档方向冲突——裁决：打分留在降档 aggregator 里（顺带、零额外成本）但**明确定位为弱信号**；若未来要强 LLM 评判，单独立 evaluate 步骤用 run 级模型抽查（本设计不做）。

## 7. 实现机制（把终态落到代码层）

**本章结论：一处引擎透传 + workflow 脚本采集与消费 + 一个 CLI 脚本 + schema/prompt 模板。**

| 文件 | 改动 |
|---|---|
| `src/orchestration/worker-script-builder.ts`（引擎） | returnMeta resolve 增加 `usage` + `durationMs`；callCache 重放路径对称包含（9b/9c 约束） |
| `workflows/review-fix-loop.js` | 每次 agent() 结果写 `state.calls[]`；RUN_ROOT 改 `~/.review-fix-loop/<slug>/<runId>/`（git toplevel slug，非 git 用 cwd slug，失败降级 $TMPDIR + WARN）；聚合条目扩展消费（origin/dormant/guidance 落 issues）；聚焦/审计轮逻辑；新参数 `scopedR2`（默认 true）/`auditEvery`（3）/`evidenceGate`（true）/`aggregatorModel`；@pi-meta usage 增加降档提示文案 |
| `workflows/review-fix-loop-utils.cjs` | computeOrigin / dormant 注入 / 聚焦 scope 并集 / 审计轮触发 / slug 化 / calls[] 记录器，全部纯函数 |
| `scripts/rfl.mjs`（新增） | list/stats/trends/clean 四子命令，零依赖 |
| `src/__tests__/review-fix-loop-utils.test.ts` | 上述纯函数单测 + prompt 静态段快照 |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：中大改动（引擎透传 + 存储迁移 + 行为变更），核心验收是「数据真的落下来且算得对」。**

### 8.1 改动规模

中大：引擎透传 + 新存储位置 + schema 扩展 + prompt 变体 + CLI。不改循环骨架。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 真实 PR 全跑 + 数据落地 | 目标 1/2/3/4/5 | xyz-agent 仓真实 PR（≥5 文件）跑 review-fix-loop 到终止，`aggregatorModel` 按 AGENTS.md 传 mimo | state.json 在 `~/.review-fix-loop/xyz-agent-workspace-main/<runId>/`；calls[] 每次调用含 durationMs+usage 四字段；issues 带 origin/guidance；R2+ dirty agent 聚焦、审计轮全量；dormant 记录存在 |
| S2 CLI 可用 | 目标 1 | `rfl stats latest` 与 `rfl trends` | 输出 per-role token 汇总、缓存命中率、origin 分布、轮次时间线；数字与 state.json 手工抽查一致 |
| S3 引擎重放对称 | 目标 1（护栏） | 同一 run 中断后重跑（kill 后同参数重启） | 重放的调用在 calls[] 中同样含 usage（⛔ P-replay——缓存路径不漏字段） |
| S4 证据门槛与复活 | 目标 5 | 抽查 S1 聚合报告与 state.dormant | 无证据条目降级可见；下轮 R2+ prompt 含 dormant 清单 |
| S5 opt-out 与降级 | 目标 3/5 护栏 | `scopedR2=false`、`evidenceGate=false` 各重跑一次；非 git 目录跑一次 | 回退路径行为正确；非 git 时 state 落在 cwd slug 目录 |
| S6 eval 首份报告 | 目标 7 | S1+S5 共 3 个 run 后 `rfl trends` | 客观层指标（轮数/token/regression 率/缓存命中率）成表；scores[] 标注为弱信号 |

## 9. 实施

**本章结论：三个里程碑，仪表地基绝对先行——没有它后面所有机制的效果不可证。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | 引擎 returnMeta 透传 + calls[] 落盘 + 存储迁移 + CLI（6.6/6.7） | 目标 1（可观测） |
| M1 | 聚合条目扩展 + origin + 证据门槛 + dormant + guidance 落盘（6.1/6.3/6.4） | 目标 2/4/5 |
| M2 | 聚焦 + 审计轮 + aggregatorModel 参数（6.2/6.5）+ S6 首份 eval | 目标 3/6/7 |

## 10. 下一层拆分

**本章结论：7 个任务，T1/T2 是引擎与存储地基，T3 是数据链前提。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 引擎 returnMeta 透传 usage/durationMs（含重放对称） | worker-script-builder + 重放缓存 | 全组地基；引擎改动独立审查 |
| T2 RUN_ROOT 迁移 + slug + 降级 | utils + 脚本 | 独立可验 |
| T3 calls[] 采集 + rfl.mjs CLI | 脚本采集点 + 新 CLI | 依赖 T1/T2 |
| T4 聚合条目扩展（schema + aggregator prompt） | `{files?, evidence?, guidance?}` | 三个机制共同数据源 |
| T5 computeOrigin + 证据门槛 + dormant + R2+ 复活注入 | utils + 集成 | 依赖 T4 |
| T6 聚焦 R2+ prompt 变体 + 审计轮 | scope 并集 + 轮次计数 + clean 前强制审计 | 依赖 T4 的 files |
| T7 aggregatorModel 参数 + usage 提示 + P-agg 探针 | 参数与文案 | 独立 |

## 11. 待验证检查点

- ⛔ P-replay：returnMeta 透传后 callCache 重放路径的 usage 完整性（S3）。
- ⛔ P-agg：降档 aggregator 的结构化字段填充率与去重质量（6.5）。
- ⛔ P-audit：K=3 取值与聚焦轮漏检率（审计轮 origin=new 占比校准）。
- ⛔ P-dormant：dormant 复活率（门槛苛度校准）。
- ✅ 已核实（源码）：AgentResult.usage/durationMs 存在于主线程、returnMeta 不透传（worker-script-builder.ts resolve 分支）；reviewerSchema.must_fix 为 number；must_fix_ids 现支持 `{id,severity}`；lastModifiedFiles/fixImpactFiles 已落盘；scoped prompt 只服务上轮 clean agent；state.json 现仅 meta.startedAt 一个时间字段。

## 附录：变更历史

- v1：初版。v2：对抗式审查后重写（origin 数据源改聚合条目扩展；recheckAfterFix 翻案为聚焦+审计轮；证据门槛改 aggregator 端 + dormant 通道；验收重写）。
- v3：新增可观测性地基（全量仪表 + `~/.review-fix-loop/` 持久化 + rfl CLI，含引擎 returnMeta 透传的源码核实结论）与 eval 双层设计（客观回填权威 / aggregator 打分弱信号）；aggregatorModel 模型路由改由 AGENTS.md 承载（workflow 仅提示）；6.2 机制说明大白话化；6.4 补充证据门槛的省成本机制解释；guidance 落 state.json。审查报告见同目录 `tier-1-cheap-wins-review.md`。
