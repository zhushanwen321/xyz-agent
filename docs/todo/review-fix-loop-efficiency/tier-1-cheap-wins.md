# review-fix-loop 效率优化 梯队 1：全量仪表与 eval + 轮次归因 + 证据门槛

> **一句话结论**：把 review-fix-loop 从「黑盒循环」改造成「可观测、可归因、可评估」的循环——全量仪表（每次 agent 调用的耗时/token/缓存命中落 state.json，持久化到 `~/.review-fix-loop/` 并配 CLI 查询）是地基；其上挂三个省成本机制（origin 归因、证据门槛、修复指引）与一套 10 分制分维度质量打分；R2+ 保持全量重扫（聚焦审查经数据门槛暂缓）；eval 以状态机客观回填为权威、LLM 打分为弱信号。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 是 subagent-workflow extension 的内置 workflow，结构为「多批串行 × 批内多轮：并行 review → 聚合 must-fix → fix → 重审直到 clean」。状态持久化在 `$TMPDIR/review-fix-loop/<runId>/state.json`——系统清理即丢失，本地 441 个历史 run 全是 e2e fixture，无一真实 run。
- **C（冲突）**：① 每轮全价；② 轮次构成不可见（每轮花了多少、谁报的准、修得好不好，state.json 都回答不了）；③ 没有 eval 手段，任何优化的效果无法度量；④ v3 曾设计的「R2+ 聚焦审查」漏检敞口不可观测，风险过大。
- **Q（问题）**：怎么让每一轮的成本与质量可见、可归因、可评估，同时只做风险可控的省成本改动？
- **A（答案）**：地基先行——全量仪表 + 持久化存储 + CLI；一条数据传输链（aggregator 聚合条目结构化扩展）供养三个机制（origin 归因 / 证据门槛 / 修复指引）；打分用「4 维度 × 10 分制 + 加权综合总分」，落 state.json；聚焦审查不实施，改为数据门槛触发的再评估决策记录。

## 1. 背景：被设计的系统是什么

**本章结论：review-fix-loop 是「审查-修复」循环编排器；本次设计 = 可观测性地基 + 三个省成本机制 + 打分与 eval 方法。**

一次 run 的内部循环：批次串行；批内每轮 `parallel()` 派发多个 reviewer agent → aggregator agent 跨报告去重聚合（`must_fix_ids`，现有条目 `{id, severity}`）→ fix agent 按聚合报告修复 → 下轮重审。关键现状（均经源码核实）：

- reviewer 输出 schema 中 `must_fix` 是 **number 计数**，逐 issue 明细只存在于 reviewer 写盘的 markdown 报告里。
- **R2+ reviewer 全量重审**：上轮 clean 的 agent 默认跳过（`skipCleanAgents=true`）；上轮 dirty 的 agent 走 `buildR2ReviewPrompt` 全量重扫。`recheckAfterFix`（默认 false）是回归护栏。本设计**不改变此行为**。
- **资源数据主线程侧已存在但未透传**：`AgentResult` 含 `usage{input, output, cacheRead, cacheWrite, cost, contextTokens, turns}` + `durationMs` + `sessionId/sessionFile`（`src/orchestration/models/types.ts`）；workflow 脚本 `agent({returnMeta:true})` 只收到 `{value, sessionFile, worktreePath, error}`（`src/orchestration/worker-script-builder.ts` resolve 分支，含 callCache 重放对称路径 9b/9c）——usage/durationMs 不到脚本层。
- issue 级状态机：`state.issues`（firstSeen/severity/status/history/fixAttempts），status 经 open → fix-attempted → fixed/regressed 流转——**这台状态机本身就是免费的 eval 数据源**（§6.7）。

**层声明**：当前层 = 技术方案设计，含足够指导开发的数据结构规格（§7）；下一层 = 实现任务。准则 5/6/7 全适用。

## 2. 设计目标

**本章结论：每次 run 的每一轮「花了多少、报得准不准、修得好不好」全部落盘可查；三个低风险机制省成本；eval 有权威数据源。**

1. **可观测**：每次 `agent()` 调用记录耗时、token（输入/输出/缓存读/缓存写）、模型、prompt 模式；state.json 持久化到 `~/.review-fix-loop/`（按 git repo 建子目录，非 git 用 cwd）；配简易 CLI（`rfl`）直接查询。
2. **可归因**：R2+ 新 issue 带 origin（regression / new）。
3. **fixer 免侦查**：每条 must-fix 带修复指引，落聚合报告与 state.json。
4. **噪声被挡**：无客观证据条目聚合阶段降级 dormant，可复活。
5. **质量可评**：aggregator 对 reviewer 发现质量与 fix 修复质量按 10 分制分维度打分 + 综合总分，落 state.json；客观回填（状态机流转）为 eval 权威层。
6. **聚合便宜**：`aggregatorModel` 参数支持降档（模型选择写用户 AGENTS.md，不写死 workflow）。

**In-scope**：review-fix-loop.js / utils / aggregator schema 与 prompt / state.json 结构与存储 / rfl CLI / 引擎 returnMeta 透传小改动。**Out-of-scope**：reviewerSchema 破坏性变更；**R2+ 聚焦/审计轮（回退，见 6.5 决策记录）**；持久会话与缓存前缀（梯队 2）；可执行验证（梯队 3）；recheckAfterFix 语义。

## 3. 现状：使用者眼里是什么样的

**本章结论：每轮全价、数据随 /tmp 消失、无打分无 eval——优化没有仪表。**

### 3.1 现状的真实样子

- state.json 在 `$TMPDIR`（macOS 定期清理）——真实 run 数据活不下来（441 个历史 run 全是 fixture 的实证）。
- 现有 state.json 只有 `meta.startedAt` 一个时间字段，无 token/耗时/缓存/质量记录。
- 聚合条目 `{id, severity}` 无文件/证据/指引维度。
- R2+ dirty agent 全量重扫（e2e 实测：modifiedFiles 与 R1 全量相同，17 个文件）。

### 3.2 怎么出错

- **A 验证轮全价**、**B fixer 重复侦查**、**C 噪声轮**（前两版已述）。
- **D 盲优化**：任何提效改动无数据证明有效或有害——v2 审查发现的多个设计错误（如 scoped 语义误读），早在真实数据上跑过就不会犯。

### 3.3 根因

state.json 被定位为「断点恢复的状态」而非「运行观测数据集」——存储位置（易失 tmp）、字段集（只有流程状态）、查询手段（无 CLI）、质量维度（无打分）四者都是这一定位的产物。

## 4. 根因方案 + 物理数据流

**本章结论：一条主干（仪表 + 持久化 + CLI）+ 一条数据链（聚合条目扩展）+ 三个消费机制（归因/门槛/指引）+ 一个打分与 eval 层。**

> **聚合条目结构化扩展** = aggregatorSchema 的 `must_fix_ids` 条目从 `{id, severity}` 扩展为 `{id, severity, files?, evidence?, guidance?}`（精确 JSON 见 §7.2）。origin 归因、证据门槛、修复指引共用这条链。
> **origin 归因** = R2+ 新 issue 判定：`files ∩ (lastModifiedFiles ∪ fixImpactFiles) ≠ ∅ → regression`，否则 `new`（漏检与全新引入不可再分，如实标注）。
> **休眠清单（dormant list）** = 降级条目（无证据 / 梯队 3 验证失败）写入 `state.dormant[]`，注入下轮 R2+ prompt 可复活。
> **客观回填** = reconcile 状态机的固有输出：上轮报的 issue 本轮转 fixed → 报准了；转 regressed → 没修好或修复引入。零额外 LLM 调用的质量信号。

物理数据流（含采集点）：

```
agent() 调用（reviewer × N / aggregator / fixer）
  ↓ 主线程 AgentResult（usage/durationMs/sessionId 已存在）
  【引擎透传改动：returnMeta resolve 增加 usage + durationMs】      ← 采集点 1
  ↓ 脚本层写入
~/.review-fix-loop/<repo-slug>/<runId>/state.json
  ├─ calls[]   : 每次调用的资源与耗时（§7.3 精确结构）            ← 采集点 1
  ├─ issues[id]: {..., origin, guidance, evidence}                ← 采集点 2（聚合条目扩展）
  ├─ rounds[]  : {..., phaseTimings{review,aggregate,fix}}
  ├─ dormant[] : 降级条目 + 复活状态
  └─ scores[]  : aggregator 打分（§6.6 rubric，弱信号）           ← 采集点 3
  ↓ CLI 读取（不经 LLM）
rfl list / stats / trends / clean —— 派生指标 CLI 现算，不落盘防双写不一致
```

## 5. 终态：使用者眼里将是什么样的

**本章结论：run 完一条命令看到成本与质量全景；R2+ 仍是全量重扫（行为不变）；省成本改动集中在聚合与 fix 环节。**

### 5.1 成功路径

```
[用户] workflow run review-fix-loop --args targetType=git-diff target=main batch1="..." \
         aggregatorModel=xiaomi-token-plan-cn/mimo-v2.5-pro        ← 模型来自 AGENTS.md 路由
[run] R1 全量审查 → 聚合（4 must-fix，1 条无证据降级 dormant）→ fix（按 guidance 定位）
      R2 全量重审（行为与现状一致）→ 1 must-fix（origin=regression）→ fix → R3 clean
[用户] rfl stats latest
       run rfl-2026...（repo: xyz-agent-workspace/main）  terminated: clean, rounds: 3
       tokens: input 412k (cacheRead 301k = 73%)  output 31k  cost $0.41  wall 11m20s
       per-role: reviewer ×6 calls 298k │ aggregator ×2 (mimo) 9k │ fixer ×2 105k
       issues: new 4 → fixed 3, regressed 1 │ dormant 1（未复活）
       scores: reviewer-a 8.2/10（证据 9 / 严重度 7 / 可操作 8 / 对账 9）
               fix R1 8.5/10（覆盖 9 / 自检 8 / 最小性 9 / 回归回填 8）
```

### 5.2 失败路径（带恢复指引）

- **usage 透传缺失**（引擎改动未上线）：calls[] 跳过 usage 并 WARN，不断流。👉 确认 subagent-workflow 版本含透传（`rg "durationMs" src/orchestration/worker-script-builder.ts`）。
- **~/.review-fix-loop 不可写**：降级 $TMPDIR + WARN（数据易失）。👉 `mkdir -p ~/.review-fix-loop` 后重跑。
- **打分/归因字段缺失**（aggregator 未按新 schema 输出）：对应字段空 + WARN。👉 检查 aggregatorModel 档位（⛔ P-agg）。
- **真问题被证据门槛误降级**：dormant 清单下轮可复活；复活率持续偏高 → 👉 `evidenceGate=false`。

## 6. 关键决策与权衡

**本章结论：七个决策 + 一个回退记录（聚焦审查，数据门槛触发再评估）。**

### 6.1 origin 归因（数据源 = 聚合条目扩展）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| aggregator 条目带 files + computeOrigin 纯函数（选） | 数据链唯一；reviewer schema 零破坏 | 中 | 文件级粒度粗，regression 偏高估（fixImpactFiles 含「仅检查未改」参考文件）；缺失时 WARN | ✅ |
| reviewer 自报 | 有语义潜力 | 中 | 自报不可信 | ❌ |

如实声明：origin=new 不再区分漏检/新引入——观测窗口边界如实标注。

### 6.2 修复指引：报告列 → 聚合条目 → fixer → state.json

reviewer 报告逐 issue 表增加「修复建议（文件/位置/改法）」必填列；aggregator 提取进条目 `guidance`；fixer prompt 要求按指引定位（与代码冲突以代码为准）；guidance 写入 `state.issues[id].guidance`——事后可分析「哪类指引 fixer 跟得住」。对齐 AlphaCodium 定向修复。

### 6.3 证据门槛：省 token 的机制说明

**省的是整轮轮次，不是单条 token**：噪声问题进修复队列后，fixer 改一个不需要改的地方（烧一轮 fix + 可能引入新问题），下轮 reviewer 对新代码再报（再烧一轮 review）。门槛在聚合处把拿不出客观证据（测试输出/lint 报错/grep 命中+行号）的条目降级 dormant，把噪声挡在修复队列外。依据：CRITIC + Huang et al.（无外部信号多轮互评退化）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| aggregator 端门槛 + dormant 复活通道（选） | 门槛在唯一聚合点；schema 零破坏 | 中 | 真问题误降级（复活通道 + 复活率观测缓释） | ✅ |
| reviewer schema 加必填 evidence（v1） | — | — | must_fix 是 number 计数，无条目可挂字段 | ❌ |

### 6.4 aggregator 降档：模型路由在 AGENTS.md，workflow 只给提示

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| `aggregatorModel` 参数 + usage 提示「参考全局/项目 AGENTS.md 模型路由；无条目请先与主人确认并写入」（选） | 模型选择权属用户配置层；换模型不改代码 | 低 | 无配置时退回 run 级模型（安全默认） | ✅ |
| workflow 写死 mimo（已否决） | — | 极低 | 模型更迭改代码；对用户环境越权 | ❌ |

当前用户全局 AGENTS.md 已有路由条目（`xiaomi-token-plan-cn/mimo-v2.5-pro`，thinking 开非 max）。叠加风险：条目结构化提取 + 打分比纯计数吃模型能力 → ⛔ P-agg 探针守门。

### 6.5 【回退记录】R2+ 聚焦审查：暂缓，数据门槛触发再评估

v3 曾设计「dirty agent R2+ 只细读自身问题文件 ∪ fix 改动文件 + 每 K 轮全量审计轮兜底」。**经风险重估回退**：聚焦模式的漏检敞口不可观测（漏掉的问题不进任何统计），在缺乏真实数据时引入该风险不值得。R2+ 保持全量重扫。

再评估触发器（M0/M1 上线后用 `rfl trends` 观察 ≥10 个真实 run）：若同时满足 ① R2+ reviewer 输入 token 中非问题文件占比显著（calls[].promptBytes + files 分布可估算）；② R2+ 新发现里 origin=new 占比 < 20%（即新发现主要是修复回归而非全量扫描的功劳）——则聚焦审查重新立项（届时有真实漏检基线可对照）。此决策记录替代实施。

### 6.6 质量打分：4 维度 × 10 分制 + 加权综合总分

**结构**：aggregator 在聚合调用中顺手输出（不增加调用次数），写 `state.scores[]`。打分对象是「本轮每个 reviewer 的报告」与「上一轮的 fix 结果」。

**Reviewer 发现质量（每 reviewer 每轮一条）**：

| 维度 | 权重 | 0-10 锚定 |
|---|---|---|
| 证据强度 evidence | 40% | 10=每条 must-fix 附可复核证据（输出+行号）；5=部分有；0=普遍无证据空断言 |
| 严重度校准 severity | 20% | 10=critical/major/minor 与影响面相符；0=轻症报 critical 或反之 |
| 可操作性 actionability | 25% | 10=每条带文件/位置/具体改法；0=只描述现象 |
| 对账诚信 reconciliation | 15% | 10=逐条如实对账（fixed/not-fixed 与代码一致）；0=漏对账/假对账/重复报已修问题 |

综合总分 = Σ(维度×权重)，权重依据：证据是假阳性的主防线（权重最高）；可操作性直接决定 fixer 是否免侦查。

**Fix 修复质量（每 fix 轮一条）**：

| 维度 | 权重 | 0-10 锚定 |
|---|---|---|
| 覆盖完整 coverage | 30% | 10=每条 must-fix 有对应 fixes[] 且 description 对应问题 |
| 自检强度 self-check | 30% | 10=每条附 grep/测试命令+命中数+同步动作；0=空自检 |
| 最小性 minimality | 20% | 10=affected_files 全与问题相关；0=夹带重构/无关格式化 |
| 回归回填 regression | 20% | **workflow 确定性计算**（非 LLM）：10 − 10×(下轮 regressed 数 / fixes 数)，下轮回填 |

综合总分 = Σ(维度×权重)。LLM 打前三个维度，回归维度由 workflow 在下轮 reconcile 后回填——**LLM 不打自己无法观测的东西**。
每条 score 记录：`{round, targetKind: "reviewer"|"fix", targetName, dimensions: {…}, total, note}`（note ≤ 一句话，供人工抽查打分依据）。

### 6.7 eval 设计：客观回填为权威，LLM 打分为弱信号

**aggregator 打分单独承担 eval 的两个结构缺陷**：① 自评冲突（聚合完同一份数据再打分）；② 无 ground truth。权威层是状态机客观回填：

| 层 | 内容 | 成本 | 权威性 |
|---|---|---|---|
| 客观回填（权威） | reviewer precision = 所报 issue 后续 fixed 占比；fix 质量 = 1 − regressed/fix-attempted；dormant 复活率；轮数/收敛/token 分布——CLI 现算 | 零 | 高（行为证据） |
| aggregator LLM 打分（弱信号） | §6.6 的 10 分制分维度打分 | 顺带 | 低-中（趋势抽查用） |

**用法**：机制改动 A/B 对照——改动前后各 ≥3 个真实 run，`rfl trends` 对比确定性指标；决策只信客观层。
**降档模型能否承担打分**：聚合（机械）可降档；打分要判断力——裁决：打分留在降档 aggregator 里顺带做但只当弱信号；重要 eval 决策不用它。

## 7. 数据结构规格（开发可直接依据）

**本章结论：三处 schema 变更 + state.json 新增五个字段 + CLI 四命令，全部精确定义。**

### 7.1 引擎透传（worker-script-builder.ts）

returnMeta resolve 对象从 `{value, sessionFile, worktreePath, error}` 扩为 `{value, sessionFile, worktreePath, error, usage, durationMs}`；callCache 重放路径（9c）对称包含两字段。⛔ P-replay：重放 run 的 calls[] 同样含 usage。

### 7.2 aggregatorSchema.must_fix_ids 条目（现支持 `{id,severity}`，扩展为）

```json
{ "id": "MF-1", "severity": "critical|major|minor",
  "files": ["src/a.ts"], "evidence": "grep 输出摘要+行号", "guidance": "改法一句话" }
```

新增字段全部可选（旧 agent 行为兼容；缺失 → 对应机制 WARN 降级）。scores 输出走 aggregatorSchema 新顶层字段 `scores`（可选数组，结构同 §6.6 记录）。

### 7.3 state.json 新增字段

```jsonc
{
  "calls": [{ "batch": 1, "round": 1, "role": "reviewer|aggregator|fixer",
              "name": "reviewer-a", "model": "…", "durationMs": 83000,
              "usage": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},
              "promptMode": "full|scoped", "promptBytes": 12345, "sessionId": "…" }],
  "dormant": [{ "id": "MF-7", "reason": "no-evidence|verify-failed", "round": 1, "revived": false }],
  "scores": [{ "round": 1, "targetKind": "reviewer|fix", "targetName": "reviewer-a",
               "dimensions": {"evidence": 9, "…": 0}, "total": 8.2, "note": "…" }],
  "issues": { "MF-1": { "…": "现有字段", "origin": "regression|new", "guidance": "…", "evidence": "…" } },
  "batches[].rounds[].phaseTimings": { "review": [t0,t1], "aggregate": [t0,t1], "fix": [t0,t1] }
}
```

### 7.4 rfl CLI（`extensions/subagent-workflow/scripts/rfl.mjs`，零依赖 node）

| 命令 | 输出 |
|---|---|
| `rfl list [repoSlug]` | run 清单（runId/时间/终止原因/轮数） |
| `rfl stats <runId\|latest>` | 单 run 全景（§5.1 示例形态）：token 汇总 + 缓存命中率 + per-role 分布 + origin 分布 + dormant + scores 表 + 轮次时间线 |
| `rfl trends [repoSlug]` | 跨 run 趋势表（轮数/token/regression 率/缓存命中率逐 run 列） |
| `rfl clean --older-than 30d` | 清理旧 run 目录（默认干跑打印，`--yes` 执行） |

### 7.5 存储路径

`~/.review-fix-loop/<slug>/<runId>/state.json`；slug = `git rev-parse --show-toplevel` 路径 slug 化（`/Users/x/repo` → `Users-x-repo`），非 git 用 cwd 同法；home 不可写降级 $TMPDIR + WARN。reports 目录（batch-*/round-*）随 RUN_ROOT 一并迁移。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：中大改动，核心验收是「数据真的落下来且算得对」+「打分结构符合 rubric」。**

### 8.1 改动规模

中大：引擎透传 + 存储迁移 + schema 扩展 + prompt 调整 + CLI。不改循环骨架，R2+ 保持全量。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 真实 PR 全跑 + 数据落地 | 目标 1/2/3/4 | xyz-agent 仓真实 PR（≥5 文件）跑到终止，aggregatorModel 按 AGENTS.md 传 mimo | state.json 在 `~/.review-fix-loop/<slug>/<runId>/`；calls[] 每条含 durationMs+usage 五字段；issues 带 origin/guidance；R2+ 日志为全量 prompt（非聚焦）；dormant 有记录 |
| S2 CLI 可用 | 目标 1 | `rfl stats latest` + `rfl trends` | 输出 §5.1 形态；数字与 state.json 手工抽查一致 |
| S3 引擎重放对称 | 目标 1 护栏 | run 中断后同参数重跑 | 重放调用在 calls[] 同样含 usage（⛔ P-replay） |
| S4 打分结构与回填 | 目标 5 | S1 的 state.scores | 每轮每 reviewer 一条 + 每 fix 轮一条；四维度齐全；total = 加权和（抽查复算一致）；regression 维度在下轮回填（非首轮凭空打分） |
| S5 证据门槛与复活 | 目标 4 | 抽查 S1 聚合报告与 dormant | 无证据条目降级可见；下轮 R2+ prompt 含 dormant 清单 |
| S6 降级与回退 | 护栏 | `evidenceGate=false` 重跑；非 git 目录跑一次 | 门槛关闭行为正确；非 git 落 cwd slug 目录 |
| S7 首份 eval 报告 | 目标 5 | S1+S6 共 3 个 run 后 `rfl trends` | 客观层指标成表（轮数/token/regression 率/缓存命中率）；scores 标注弱信号 |

## 9. 实施

**本章结论：三个里程碑，仪表地基绝对先行。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | 引擎透传 + calls[] + 存储迁移 + CLI（§7.1/7.3 calls/7.4/7.5） | 目标 1 |
| M1 | 聚合条目扩展 + origin + 证据门槛 + dormant + guidance（6.1/6.2/6.3） | 目标 2/3/4 |
| M2 | 打分（6.6）+ aggregatorModel（6.4）+ 首份 eval（S7） | 目标 5/6 |

## 10. 下一层拆分

**本章结论：7 个任务，T1/T2 地基先行，T4 是数据链前提。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 引擎 returnMeta 透传 usage/durationMs（含重放对称 + P-replay） | worker-script-builder | 全组地基；引擎改动独立审查 |
| T2 RUN_ROOT 迁移 + slug + 降级 | utils + 脚本 | 独立可验 |
| T3 calls[] 采集 + rfl.mjs CLI | 采集点 + 新 CLI | 依赖 T1/T2 |
| T4 聚合条目扩展（schema + aggregator prompt + scores 输出字段） | §7.2 | 归因/门槛/指引/打分的共同数据源 |
| T5 computeOrigin + 证据门槛 + dormant + R2+ 复活注入 | utils + 集成 | 依赖 T4 |
| T6 打分 rubric 进 aggregator prompt + scores[] 落盘 + 回归回填 | 6.6 | 依赖 T4；regression 回填依赖现有 reconcile |
| T7 aggregatorModel 参数 + usage 提示 + P-agg 探针 | 参数与文案 | 独立 |

## 11. 待验证检查点

- ⛔ P-replay：透传后重放路径 usage 完整性（S3）。**改动点已设计层核实**（✅ 源码）：两个对称点——live resolve 分支与 `_callCache` 重放重建分支（worker-script-builder.ts 9b/9c），缓存存全量 msg.result，两处各加两个字段即可。
- 🟡 P-agg：降档 aggregator 能力下限已实测通过（mimo-v2.5-pro 探针：合成双报告去重合并正确取较高 severity、无证据条目正确留空、分维度打分有校准判断力）；**真实 run 的结构化字段填充率与去重一致率仍须 S1/P-agg 验收**（合成样本 ≠ 真实分布）。
- ⛔ P-dormant：dormant 复活率（门槛苛度校准）。
- ⛔ P-score-drift：降档模型打分的稳定性（同一报告两次打分差异 >2 分则打分不可用作趋势信号）。
- ✅ 已核实（源码）：AgentResult.usage/durationMs 存在于主线程、returnMeta 不透传；reviewerSchema.must_fix 为 number；must_fix_ids 现支持 `{id,severity}`；lastModifiedFiles/fixImpactFiles 已落盘；state.json 现仅 meta.startedAt 一个时间字段。

## 附录：变更历史

- v1：初版。v2：首轮对抗审查后重写（origin 改聚合条目扩展；recheckAfterFix 翻案；证据门槛改 aggregator 端 + dormant）。
- v3：新增仪表地基 + 持久化 + CLI + eval 双层；aggregatorModel 路由改 AGENTS.md 承载。
- v4：R2+ 聚焦/审计轮回退为数据门槛触发的决策记录（6.5，漏检敞口不可观测）；打分机制细化为 4 维度 × 10 分制 + 加权综合总分 + regression 确定性回填（6.6）；新增 §7 数据结构规格（schema/state 字段/CLI 命令精确定义）使开发可直接依据；参数全集收敛为 `evidenceGate`/`aggregatorModel`（scopedR2/auditEvery 随回退移除）。审查报告见同目录 `tier-1-cheap-wins-review.md`。
