# review-fix-loop 效率优化 梯队 1：消灭轮次 + 验证轮轻量化

> **一句话结论**：用五个低成本改动把「每轮都贵」变成「轮次变少、验证轮变便宜」——轮次归因度量、scoped recheck 默认化、reviewer 输出修复指引、must-fix 证据门槛、aggregator 换便宜模型；全部不依赖 provider 缓存特性。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 是 subagent-workflow extension 的内置 workflow（`extensions/subagent-workflow/workflows/review-fix-loop.js`），结构为「多批串行 × 批内多轮：并行 review → 聚合 must-fix → fix → 重审直到 clean」。调用方（如 pr-cr-fix 流程或用户手动 `workflow run`）拿它做「审查并迭代修复至干净」。
- **C（冲突）**：每一轮都是全价——新 reviewer agent 重新侦查代码库、aggregator 用与 reviewer 同档模型去重、fix agent 重新读文件找修复点；轮数一多，wall-clock 与 token 随轮数线性膨胀。
- **Q（问题）**：怎么在不损失审查质量的前提下，减少轮数 + 让不可避免的轮次更便宜？
- **A（答案）**：先量化轮次构成（origin 归因），再把业界已验证的四个机制以最低成本落地：验证轮只审增量（scoped recheck 默认化）、reviewer 顺带产出修复指引让 fixer 免侦查、must-fix 必须附客观证据挡噪声轮、aggregator 降档模型。

## 1. 背景：被设计的系统是什么

**本章结论：review-fix-loop 是「审查-修复」循环编排器，本次设计聚焦它每轮的四个成本中心。**

review-fix-loop 的一次 run 形如：

```
workflow run review-fix-loop --args targetType=git-diff target=main \
  batch1="/path/reviewer-a.md,/path/reviewer-b.md" autoCommit=true
```

内部循环（摘自脚本头注释与主循环）：批次串行；批内每轮 `parallel()` 派发多个 reviewer agent（各自独立上下文）→ aggregator agent 去重聚合出 must-fix 清单 → fix agent 按聚合报告修复 → 下一轮重审。已有机制：clean agent 跳轮（`skipCleanAgents` 默认 true）、issue 级追踪（`state.issues`：firstSeen/severity/status/history/fixAttempts）、收敛/stuck/needs-redesign 三种结构化终止、可选的限定范围重审（`recheckAfterFix`，默认 false，scope = 上轮 `modifiedFiles ∪ fixImpactFiles`）。状态持久化在 `$TMPDIR/review-fix-loop/<runId>/state.json`。

**层声明**：当前层 = 技术方案设计（接口/数据模型/决策）；下一层 = 实现任务清单（改 review-fix-loop.js / review-fix-loop-utils.cjs / schema / prompt 模板）。准则 5/6/7 全适用。

## 2. 设计目标

**本章结论：改造后，一次典型 run 的轮数与每轮成本双双下降，且运维者能从 state.json 直接读出「钱花在哪类轮次上」。**

1. **可归因**：任何一轮结束后，state.json 里每个 R2+ 新 issue 带 `origin` 标记（regression / missed / severity-drift），运维者跑 5-10 个真实 run 即可统计三类占比，后续优化不再靠猜。
2. **验证轮便宜**：修复后的重审只读「上轮改动文件 + 受影响文件」，不再全量重扫——wall-clock 与输入 token 同步下降。
3. **fixer 免侦查**：fix agent 拿到的每条 must-fix 自带修复指引（文件 + 位置 + 改法），无需重新探索代码库。
4. **噪声轮被挡**：无客观证据（测试输出 / lint 报错 / grep 命中）支撑的问题进不了修复队列。
5. **聚合便宜**：aggregator 步骤可用低一档模型运行。

**In-scope**：review-fix-loop.js / review-fix-loop-utils.cjs / 三个 schema / prompt 模板 / state.json 字段。**Out-of-scope**：持久 reviewer 会话、prompt 缓存前缀稳定化、diff 指纹去重（梯队 2）；沙箱验证、审查-修复流水化（梯队 3）；pr-cr-fix skill 自身流程。

## 3. 现状：使用者眼里是什么样的

**本章结论：每轮全价重跑，且 state.json 回答不了「R2+ 的 must-fix 是哪来的」。**

### 3.1 现状的真实样子

R2+ 的 reviewer prompt 由 `buildR2ReviewPrompt` 生成（review-fix-loop-utils.cjs），要求 reviewer 做 verify-first 对账 + known-remaining + 收敛 hunt——但 reviewer 仍是**新 spawn 的 agent**，要重新读目标文件才能干活。聚合步骤（脚本内联）：

```js
const aggRaw = await agent({
  prompt: buildAggregatorPrompt({...}),
  model: MODEL,          // ← 与 reviewer 同档，run 级模型
  schema: aggregatorSchema,
  ...
});
```

fix agent 的输入是聚合报告全文（`buildFixPrompt({ reportContent, ... })`）——报告里有什么 fixer 就看什么，缺指引就得自己重新读文件。

state.json 里 issue 追踪的实际形态（本地 e2e run 实测）：

```
MF-1: R1 open → fix-attempted → R2 fixed → R3 regressed → fix-attempted → R4 regressed
```

——有轨迹，但没有「这个 issue 是回归还是漏检」的判定字段。

### 3.2 怎么出错（成本失控的三种真实形态）

- **A 验证轮全价**：fix 只动了 2 个文件，下一轮 reviewer 仍重读全部 17 个变更文件（e2e run 实测 modifiedFiles 列表与 R1 相同，全量）。
- **B fixer 重复侦查**：聚合报告只描述问题现象，fixer 为定位修复点重新 grep/读文件，与 reviewer 的侦查成本重复支付。
- **C 噪声轮**：reviewer 报出没有客观证据的问题 → fixer 改 → 下轮又报 → 轮数膨胀但质量不升。业界反面证据：无外部 ground truth 的纯 LLM 互评循环会退化（Huang et al., ICLR 2024, https://proceedings.iclr.cc/paper_files/paper/2024/hash/8b4add8b0aa8749d80a34ca5d941c355-Abstract-Conference.html ）。
- **D aggregator 高价**：去重 + 格式化工作占用与 reviewer 同档的推理模型额度。

### 3.3 本地实测基线（441 个 e2e run 的 state.json，343 个有效）

- R1 平均 must-fix 1.29，R2+ 平均每轮 0.78（验证轮发现量 ≈ 发现轮的 60%）。
- issue 级：25% 曾 regressed（修复引入/修复失败），17% 是 R2+ 才首次出现。
- 注意：这些是 mock agent 的 fixture 数据，反映测试场景设计假设，**不能**当真实分布——这正是目标 1「可归因」要解决的问题。

## 4. 根因 + 物理数据流

**本章结论：共同根因是「轮次成本与轮次类型无关」——发现轮、验证轮、噪声轮走同一条全价路径，且没有数据能区分它们。**

> **发现轮** = 以召回新问题为目的的轮次（通常 R1）；**验证轮** = 以确认上轮修复 + 捕捉回归为目的的轮次（R2+ 主体）。就是 §3.2 例子里「fix 后那次重审」。
> **origin 归因** = 对每个 R2+ 新 issue 判定来源：regression（涉及文件 ∈ 上轮 `modifiedFiles ∪ fixImpactFiles`）/ missed（在审查范围内但上轮没报）/ severity-drift（与上轮某 issue 重叠但严重度变化）。

物理数据流（以 origin 判定为例，全部数据已存在）：

```
磁盘 $TMPDIR/review-fix-loop/<runId>/state.json
  ├─ batches[].rounds[].modifiedFiles   ← fix 阶段 git diff --name-only 实测写入（脚本已有）
  ├─ fixImpactFiles                     ← fix schema 的 affected_files 并入（脚本已有）
  └─ issues{ <id>: {firstSeen, severity, status, history[]} }
        ↓ 本轮聚合产出 must_fix_ids 后（新增步骤）
  对每个 id 做集合运算：涉及文件 ∩ (modifiedFiles ∪ fixImpactFiles) ≠ ∅ → origin=regression
        ↓ 写入
  state.json issues[id].origin  ← 运维者用 jq/python 直接统计（§8 验收）
```

关键：origin 判定所需的两个集合在现实现里**已经落盘**，本设计只是把既有数据做一次集合运算并多写一个字段——零新依赖、零新 agent 调用。

## 5. 终态：使用者眼里将是什么样的

**本章结论：调用方式不变；变的是 state.json 可归因、R2+ 更便宜、聚合报告自带修复指引、must-fix 必须带证据。**

### 5.1 成功路径

```
[用户] workflow run review-fix-loop --args targetType=git-diff target=main batch1="..." autoCommit=true
[run 日志] --- Batch 1 Round 1 ---  Review: reviewer-a, reviewer-b (2 agents in parallel)...
           Aggregated: 4 must-fix + 2 suggestion(s).
           Fix round 1: fixed_count=4（每条 must-fix 在聚合报告里带 file/line/怎么改，fixer 直接动手）
[run 日志] --- Batch 1 Round 2 ---  Review: reviewer-a, reviewer-b（scoped：只审 R1 fix 触及的 3 个文件）
           Aggregated: 1 must-fix（带 evidence: "vitest run 输出 ..."）
           New findings origin: MF-5 regression（触及文件在 R1 modifiedFiles 内）
[run 日志] Round 3: all agents clean. → terminated=clean
[用户] python3 统计 state.json → R2+ 新 issue 的 origin 分布：regression 1 / missed 0 / severity-drift 0
```

### 5.2 失败路径（带恢复指引）

- **must-fix 缺证据被降级**：reviewer 报告的问题无 evidence 字段 → aggregator 阶段降级为 suggestion 并在报告注明「无客观证据，未进修复队列」。若误降级了真问题，下一轮 reviewer 可附证据重新上报（升级通道：reviewer prompt 明示「上轮被降级条目可带证据复活」）。
- **scoped 审查漏跨文件破坏**：scoped recheck 只审改动文件，漏了依赖方调用点 → 终止后用户发现回归。👉 恢复：`workflow run ... recheckAfterFix=false` 回到全量重审模式跑一轮兜底；并把漏检案例记入 state.json 的 origin=missed（供 §8 验收统计 scoped 漏检率）。
- **origin 判定数据缺失**：aggregator 未返回 must_fix_ids（旧 agent 行为）→ origin 字段跳过写入并 log WARN，不影响主流程。👉 恢复：检查 aggregator prompt 是否被自定义 `reviewPrompt` 覆盖；用 `jq .issues $TMPDIR/review-fix-loop/<runId>/state.json` 确认。

## 6. 关键决策与权衡

**本章结论：五个决策彼此独立、可单独上线回滚，共同构成「省轮次 + 省轮内成本」。**

### 6.1 origin 归因：集合运算自动判定 vs reviewer 自报

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 集合运算自动判定（选） | 归因逻辑收敛在 workflow 一处，reviewer prompt 不变；数据已在 state.json | 低：utils 加一个纯函数 + 单测 | 文件级粒度粗（改过的文件里报的旧问题会误判 regression） | ✅ |
| reviewer 自报 origin | 可利用语义判断（比文件集合准） | 中：改 schema + prompt + 兼容旧 agent | 自报不可信（模型倾向于给自己贴「missed 是他人的错」标签）；校验成本高 | ❌ |

**被否若用**：§5.1 的统计步骤会变成「先校验 reviewer 自报是否诚实」——归因数据本身不可信，量化目的落空。文件级误报 regression 是可接受代价：归因目的是看比例趋势，不是逐 issue 精确。

### 6.2 scoped recheck 默认化：`recheckAfterFix` 默认 false → true

现状注释写明默认 false 的原因（clean agent 下轮跳过即字面语义）。本决策把「fix 后全批重派但 clean agent 走 scoped prompt」变为默认，因为：CodeRabbit 增量审查是产品默认行为（「performs incremental reviews focusing on the new changes」，https://docs.coderabbit.ai/guides/code-review-overview ），且 scope 数据（modifiedFiles ∪ fixImpactFiles）现成。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 默认 true + 显式 opt-out（选） | 与工业界增量审查默认行为对齐；省的是每轮最贵的输入 token | 极低：改默认值 + 文档 | diff-only 漏跨文件破坏（CodeRabbit 竞争者与本方 deep-dive 均承认，https://www.coderabbit.ai/blog/coderabbit-deep-dive ） | ✅ |
| 保持默认 false | 保守不引入新漏检面 | 零 | 继续每轮全价，痛点不变 | ❌ |

风险缓释：scope 不限于 modifiedFiles，而是并上 `fixImpactFiles`（fix agent 自报的受影响引用点）；再配 6.1 的 origin=missed 统计做事后校验——若真实 run 中 missed 占比上升，说明 scope 过窄，回退默认值即可（参数仍在）。

### 6.3 reviewer schema 增加 fix 指引字段

reviewerSchema 的 must_fix 计数不变，新增可选数组字段 `fix_guidance: [{issue_id, file, location, how}]`，aggregator 透传进聚合报告。fixer prompt 强调「按指引定位，禁止整文件重写」——对齐 AlphaCodium 定向修复（按失败信息修靶点，https://arxiv.org/pdf/2401.08500 ）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| reviewer 产出指引（选） | 侦查成本只付一次（reviewer 读过文件，指引是它的副产物） | 低：schema + prompt | 指引质量参差 → fixer 被误导 | ✅ |
| fixer 自行侦查（现状） | 职责干净分离 | 零 | 每轮重复支付侦查成本（§3.2-B） | ❌ |

风险缓释：指引是 hint 不是命令，fixer prompt 保留「指引与实际代码冲突时以代码为准」。

### 6.4 must-fix 证据门槛（CRITIC 模式）

reviewerSchema 每条 must-fix 要求 `evidence` 字段（测试输出 / lint 报错 / grep 命中 + 文件行号）；aggregator 把无证据条目降级 suggestion。依据：CRITIC（工具交互 critique 带客观证据，https://arxiv.org/abs/2305.11738 ）+ Huang et al. 反方证据（无外部信号多轮退化）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 证据门槛 + 降级通道（选） | 把「客观信号权威」固化为 schema 契约 | 低-中：schema + aggregator prompt + 复活通道 | 真问题被误降级（漏修） | ✅ |
| 不加门槛 | reviewer 自由度大 | 零 | 噪声轮持续（§3.2-C） | ❌ |

风险缓释：降级不等于丢弃——条目留在报告 suggestion 区，下轮可带证据复活（§5.2）；origin 统计单独跟踪「复活率」，复活率高说明门槛过苛。

### 6.5 aggregator 降档模型

aggregator 工作 = 跨报告去重 + 严重度归并 + 格式化，不需要深度推理。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 新增参数 `aggregatorModel` 缺省低一档（选） | 成本与任务复杂度匹配；模型路由权在调用方 | 低：一个参数透传 agent() | 去重质量下降（同义 issue 合并不全） | ✅ |
| 维持 run 级统一模型（现状） | 简单 | 零 | 每轮固定高价开销（§3.2-D） | ❌ |

⛔ 探针 P-agg：实施后用一个真实 run 对比 aggregatorModel 降档前后的聚合报告——must_fix_ids 去重结果与人工判断一致率 ≥ 高档基线，不一致则回退。缺省档位在调用方（pr-cr-fix 等）的模型路由里定，不在 workflow 内硬编码。

## 7. 实现机制（把终态落到代码层）

**本章结论：改动集中在四个文件，schema 三处加字段，无新 agent、无新依赖。**

| 文件 | 改动 |
|---|---|
| `workflows/review-fix-loop-utils.cjs` | 新增 `computeOrigin(issueFiles, modifiedFiles, fixImpactFiles)` 纯函数；`buildAggregatorPrompt` 增加证据降级规则与 fix_guidance 透传说明；`buildFixPrompt` 增加「按指引定位」段 |
| `workflows/review-fix-loop.js` | `recheckAfterFix` 默认值翻转为 true；聚合后调用 computeOrigin 写 `state.issues[id].origin`；aggregator 的 `model:` 改为 `$ARGS.aggregatorModel ?? MODEL`；@pi-meta parameters 增加 `aggregatorModel` |
| reviewerSchema（脚本内） | must_fix 条目增加 `evidence`（必填）与 `fix_guidance`（可选）——具体形态在下一层定（schema 兼容旧 agent：旧 agent 无 evidence → 一律降级 suggestion 并 WARN） |
| `src/__tests__/review-fix-loop-utils.test.ts` | computeOrigin 单测（regression/missed/drift 三例 + 空集合边界） |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模中等（行为变更 + schema 变更），用真实 PR 审查场景验证五条目标。**

### 8.1 改动规模

中：schema 变更 + 一个默认值翻转 + 一个纯函数新增 + prompt 文案调整。不改循环骨架。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 真实 PR 全跑 | 目标 1/2/3/4 | 在 xyz-agent 仓选一个真实改动 PR（≥5 文件），`workflow run review-fix-loop --args targetType=git-diff target=main batch1=<reviewer 路径> autoCommit=false` 跑到终止 | 正常终止（clean/converged）；state.json 中 R2+ 新 issue 全带 origin 字段；R2+ reviewer 日志显示 scoped prompt（只列 R1 修改文件） |
| S2 归因统计可读 | 目标 1 | S1 的 state.json 用 jq/python 统计 origin 分布 | 输出三类计数，总和 = R2+ 新 issue 数；无 undefined |
| S3 证据门槛生效 | 目标 4 | 对 S1 的 R1 聚合报告人工抽查 must-fix 条目 | 每条带 evidence；若有被降级条目，报告 suggestion 区可见且注明「无客观证据」 |
| S4 修复指引可用 | 目标 3 | 观察 S1 的 fix 轮日志与产出 diff | fix 改动落点与 fix_guidance 指向文件一致；fixer 无大面积无关重写 |
| S5 opt-out 兜底 | 目标 2 的回归护栏 | 同一 PR 加 `recheckAfterFix=false` 重跑一轮 | 行为回到全量重审（日志显示 reviewer 收全量 prompt），证明回退路径可用 |

单测（computeOrigin 等）只作回归辅助，不计入验收。

## 9. 实施

**本章结论：分两个里程碑，度量先行（先能观测，再上节省手段）。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | origin 归因（6.1）+ 单测 | 目标 1：可归因 |
| M2 | scoped 默认化（6.2）+ fix_guidance（6.3）+ 证据门槛（6.4）+ aggregatorModel（6.5） | 目标 2-5 |

M1 先行的理由：M2 上线后需要用 M1 的数据判断 scoped 是否过窄、证据门槛是否过苛——没有 M1，M2 的效果与风险都不可观测。

## 10. 下一层拆分

**本章结论：拆成 5 个实现任务，每个对应一个决策、可独立验收。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 computeOrigin + state 写入 + 单测 | utils 纯函数 + 脚本集成 | 独立可测，不依赖 prompt 变更 |
| T2 recheckAfterFix 默认翻转 | 一行默认值 + 头注释更新 | 最小变更；单独拆出便于出问题单独回滚 |
| T3 fix_guidance 字段链路 | schema + reviewer prompt + aggregator 透传 + fixer prompt | 一条数据链路上的三处变更必须同批，否则断链 |
| T4 evidence 门槛 + 降级/复活 | schema + aggregator prompt 规则 | 与 T3 分开：降级策略需要独立权衡 |
| T5 aggregatorModel 参数 | 参数白名单 + @pi-meta + agent() 透传 | 独立参数，独立探针 P-agg |

## 11. 待验证检查点

- ⛔ P-agg：降档 aggregator 的去重质量（见 6.5）。
- ⛔ P-scope：scoped recheck 在真实 run 中的 missed 率——需要 M1 数据积累 5-10 个 run 后判断，设计阶段无法预知。
- ⛔ P-evidence：旧 reviewer agent（无 evidence 输出习惯）接入后 must-fix 是否被全量误降级——若是，需要 reviewer prompt 同步更新（T4 内完成）。
- ✅ 已核实（源码）：modifiedFiles/fixImpactFiles 在 state.json 已存在；scoped recheck 机制（buildScopedRecheckPrompt）已实现，本设计只动默认值。

## 附录：变更历史

- v1：初版，基于两路业界调研（学术循环结构 + token 效率工程实践）与 441 个本地 e2e run state.json 实测基线。
