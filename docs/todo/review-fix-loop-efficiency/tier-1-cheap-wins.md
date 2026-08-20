# review-fix-loop 效率优化 梯队 1：轮次归因 + 聚焦验证轮 + 证据门槛

> **一句话结论**：用五个低成本改动解决「每轮全价、轮次构成不可见」——aggregator 条目结构化扩展（一条传输链供养 origin 归因/证据门槛/修复指引三个机制）、dirty agent 的 R2+ 聚焦审查 + 定期全量审计轮、must-fix 证据门槛（含休眠-复活通道）、aggregator 降档模型；全部不依赖 provider 缓存特性。

## 开篇（SCQA）

- **S（情境）**：review-fix-loop 是 subagent-workflow extension 的内置 workflow（`extensions/subagent-workflow/workflows/review-fix-loop.js`），结构为「多批串行 × 批内多轮：并行 review → 聚合 must-fix → fix → 重审直到 clean」。
- **C（冲突）**：每轮成本与轮次类型无关——发现轮、验证轮、噪声轮走同一条全价路径：R2+ 的 dirty agent 全量重扫目标、fixer 重新侦查定位、aggregator 用与 reviewer 同档模型、且 state.json 回答不了「R2+ 的 must-fix 是哪来的」。
- **Q（问题）**：怎么在不损失审查质量的前提下，减少轮数 + 让不可避免的验证轮更便宜 + 让轮次构成可观测？
- **A（答案）**：先修一条数据链路（aggregator 聚合条目从「只有 id」扩展为带 files/evidence/guidance 的结构化条目），然后三个机制都挂在上面：origin 归因、dirty agent 聚焦审查、证据门槛。审计轮兜底聚焦审查的漏检不可观测问题。

## 1. 背景：被设计的系统是什么

**本章结论：review-fix-loop 是「审查-修复」循环编排器，本次设计聚焦它每轮的四个成本中心与一条缺失的数据链。**

一次 run 的内部循环：批次串行；批内每轮 `parallel()` 派发多个 reviewer agent → aggregator agent 跨报告去重聚合出 must-fix 清单（`must_fix_ids`，现有条目形态 `{id, severity}`）→ fix agent 按聚合报告修复 → 下轮重审。关键现状（均经源码核实）：

- reviewer 输出 schema 中 `must_fix` 是 **number 计数**，逐 issue 明细只存在于 reviewer 写盘的 markdown 报告里——**schema 层没有「must-fix 条目」对象**（review-fix-loop.js reviewerSchema）。
- aggregator 的 `must_fix_ids` 条目为 `{id, severity}` 对象（M1 起支持），**没有文件维度信息**。
- R2+ reviewer 分两类路径：上轮 clean 的 agent 默认跳过（`skipCleanAgents=true`，零成本）；上轮 dirty 的 agent 走 `buildR2ReviewPrompt` 全量重审（verify-first 对账 + known-remaining + 收敛 hunt）。`recheckAfterFix=true`（默认 false）是「fix 后重派全批、上轮 clean 的走 scoped 限定 prompt」的**回归护栏**——它给本来零成本的 clean agent 增加了一次限定审查，不是省 token 机制（源码：scopedClean = 上轮 cleanNames 快照）。
- issue 级追踪在 `state.issues`（firstSeen/severity/status/history/fixAttempts）；fix 触及文件落盘两处：批内即时字段 `state.lastModifiedFiles` 与跨批 `batches[].rounds[].modifiedFiles`；fixer 自报受影响文件并入 `state.fixImpactFiles`。

**层声明**：当前层 = 技术方案设计；下一层 = 实现任务（workflow 脚本 / utils / schema / prompt 模板）。准则 5/6/7 全适用。

## 2. 设计目标

**本章结论：改造后，轮次构成从 state.json 直接可读、验证轮只审该审的、must-fix 带证据与修复指引、聚合降档。**

1. **可归因**：R2+ 每个新 issue 带 `origin` 标记（regression / new），运维者跑若干真实 run 可统计占比。
2. **验证轮聚焦**：dirty agent 的 R2+ 默认聚焦审查（范围 = 自身未决问题文件 ∪ 上轮改动文件 ∪ 受影响文件），定期全量审计轮兜底漏检。
3. **fixer 免侦查**：聚合报告每条 must-fix 自带修复指引（文件 + 位置 + 改法）。
4. **噪声被挡**：无客观证据的条目在聚合阶段降级为 suggestion，进入休眠清单，下轮 reviewer 可带证据复活。
5. **聚合便宜**：aggregator 可用低一档模型。

**In-scope**：review-fix-loop.js / review-fix-loop-utils.cjs / aggregator schema 与 prompt / R2+ prompt 模板 / state.json 字段。**Out-of-scope**：reviewerSchema 的破坏性变更（`must_fix` 保持 number 计数，逐 issue 明细走报告 markdown + aggregator 结构化）；持久会话与缓存前缀（梯队 2）；可执行验证（梯队 3）；recheckAfterFix 语义（维持现状）。

## 3. 现状：使用者眼里是什么样的

**本章结论：R2+ 的 dirty agent 全量重扫、fixer 重复侦查、噪声条目不耗证据就进修复队列，且没有任何数据能区分一轮是「发现」还是「验证」还是「空转」。**

### 3.1 现状的真实样子

聚合与修复衔接（脚本真实逻辑）：

```js
const aggRaw = await agent({ prompt: buildAggregatorPrompt({...}), model: MODEL, schema: aggregatorSchema, ... });
// aggregatorSchema.must_fix_ids 条目：{id, severity}——没有文件、没有证据、没有指引
// ...
const fxRaw = await agent({ prompt: buildFixPrompt({ reportContent, fixPrompt, ... }), ... });
// fixer 输入 = 聚合报告全文；报告缺指引时 fixer 自行重新读文件定位
```

issue 轨迹实测（本地 e2e run 的 state.json）：

```
MF-1: R1 open → fix-attempted → R2 fixed → R3 regressed → fix-attempted → R4 regressed
```

有状态轨迹，但没有「这个 regressed 是修复引入还是本来就漏」的归因字段。

### 3.2 怎么出错（成本失控的三种形态）

- **A 验证轮全价**：fix 只动了 2 个文件，R2+ 的 dirty agent 仍按 `buildR2ReviewPrompt` 全量重读目标（e2e run 实测 modifiedFiles 与 R1 全量相同，17 个文件）。
- **B fixer 重复侦查**：聚合报告只有问题现象，fixer 为定位修复点重新 grep/读文件，与 reviewer 的侦查成本重复支付。
- **C 噪声轮**：无客观证据的问题进修复队列 → 改 → 下轮再报 → 轮数膨胀质量不升。业界反面证据：无外部 ground truth 的纯 LLM 互评循环会退化（Huang et al., ICLR 2024）。

### 3.3 本地实测基线（441 个 e2e run，343 个有效 state.json）

- R1 平均 must-fix 1.29，R2+ 平均每轮 0.78（验证轮发现量 ≈ 发现轮 60%）。
- issue 级：25% 曾 regressed，17% 是 R2+ 才首次出现。
- 注意：mock fixture 数据，只反映测试场景设计假设，**不能**当真实分布——这正是目标 1 要解决的。

## 4. 根因 + 物理数据流

**本章结论：共同根因是「逐 issue 数据在 schema 层不存在」——明细锁在 markdown 报告里，workflow 引擎侧拿不到文件/证据/指引，于是归因、聚焦、门槛三个机制全都无数据可挂。修补方法不是三个机制各自造数据，而是把 aggregator 的聚合条目扩展成结构化载体，三个机制共用一条传输链。**

> **聚合条目结构化扩展** = aggregatorSchema 的 `must_fix_ids` 条目从 `{id, severity}` 扩展为 `{id, severity, files?, evidence?, guidance?}`。aggregator 本来就通读各 reviewer 的 markdown 报告做去重——它顺手把每条目的文件引用、证据、修复建议提取进条目，一次读取多方受益。
> **origin 归因** = 对 R2+ 新 issue 判定来源：`files ∩ (lastModifiedFiles ∪ fixImpactFiles) ≠ ∅ → regression`，否则 `new`（在审查范围内但上轮没报/全新引入，两者不可再分，如实标注）。severity 变化经 reconciliation 表观测，不单列类别。
> **休眠清单（dormant list）** = 被降级的条目（无证据 / 梯队 3 验证失败）写入 `state.dormant[]`，注入下一轮 R2+ prompt；reviewer 可带证据复活。这是降级不等于丢弃的通道。

物理数据流：

```
reviewer markdown 报告（逐 issue 表：id/严重度/文件/现象/证据/修复建议）
  ↓ aggregator 通读去重（现有职责不变）
must_fix_ids: [{id, severity, files[], evidence, guidance}]   ← 扩展点
  ├─→ origin 判定（纯函数 computeOrigin，读 state.lastModifiedFiles ∪ fixImpactFiles）→ state.issues[id].origin
  ├─→ 证据门槛：evidence 空 → 降级 suggestion + state.dormant[]
  ├─→ guidance 透传进聚合报告 → fixer prompt（按指引定位）
  └─→ files 并集 → 下轮 dirty agent 的聚焦审查范围（6.2）
state.dormant[] → 下轮 buildR2ReviewPrompt 注入 → reviewer 带证据复活 → 条目回正常流程
```

## 5. 终态：使用者眼里将是什么样的

**本章结论：调用方式不变；变的是 state.json 可归因、R2+ dirty agent 默认聚焦、聚合报告自带指引、无证据条目进休眠清单可复活。**

### 5.1 成功路径

```
[用户] workflow run review-fix-loop --args targetType=git-diff target=main batch1="..." autoCommit=true
[run 日志] Round 1: reviewer-a, reviewer-b 全量审查 → Aggregated: 4 must-fix + 2 suggestion(s).
           （每条带 files/evidence/guidance；1 条无证据 → 降级 dormant）
           Fix round 1: fixed_count=4（fixer 按 guidance 定位，无重新侦查）
[run 日志] Round 2: reviewer-a 聚焦审查（范围：open 问题文件 2 个 ∪ R1 改动文件 3 个）→ 1 must-fix（origin=regression）
[run 日志] Round 3: 审计轮（K=3 到期）→ 全量审查 → 0 must-fix → all clean, terminated=clean
[用户] jq 统计 state.json → R2+ 新 issue：regression 1 / new 0；dormant 1 条未被复活
```

### 5.2 失败路径（带恢复指引）

- **真问题被证据门槛误降级**：条目在聚合报告 suggestion 区可见（标注「无客观证据」）且入 dormant 清单，下轮 R2+ prompt 明示 reviewer「以下条目可带证据复活」。复活率高 = 门槛过苛 → 👉 观察 state.json 的 dormant 复活率，或临时 `evidenceGate=false` 关闭。
- **聚焦审查漏了 scope 外新问题**：审计轮（每 K 轮 + clean 判定前最后一轮）全量兜底，漏检在审计轮以 origin=new 浮出并可统计。若审计轮 new 发现持续偏高 → 👉 `scopedR2=false` 回到每轮全量。
- **aggregator 未返回扩展字段**（旧行为/模型未遵循）：`files/evidence/guidance` 全部可选，缺失时 origin 跳过写入（log WARN）、证据门槛不生效（log WARN），主流程不断。👉 检查 aggregatorModel 降档是否过猛（P-agg 探针）。

## 6. 关键决策与权衡

**本章结论：五个决策共享一条传输链（聚合条目扩展），可独立开关、独立回滚。**

### 6.1 origin 归因：数据来自 aggregator 扩展，而非 reviewer 自报或悬空集合运算

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| aggregator 条目带 files + workflow 纯函数判定（选） | 数据链唯一（报告→聚合→归因），reviewer schema 零破坏 | 中：aggregator prompt/schema + computeOrigin 纯函数 + 单测 | 文件级粒度粗：改动文件里的旧问题复燃会误判 regression；aggregator 不填 files 时归因缺失（WARN 兜底） | ✅ |
| reviewer 自报 origin | 有语义判断潜力 | 中 | 自报不可信（模型有归因倾向性）；校验成本高 | ❌ |
| （v1 否决项）直接从 state.issues 集合运算 | — | — | state.issues 无文件维度，函数无数据源——**审查证实不可行** | ❌ |

**如实声明的限制**：① 文件级粒度会高估 regression（fixImpactFiles 含 fixer 自报的「仅检查未改」参考文件，并集会偏大——归因目的是看趋势而非逐 issue 精确，可接受）；② scope 外的漏检在聚焦轮观测不到——由 6.2 审计轮兜底，这不是归因机制的缺陷而是观测窗口问题；③ origin=new 无法再区分「上轮漏检」与「修复间接引入」，如实标注语义边界。

### 6.2 验证轮聚焦：dirty agent 聚焦 + 审计轮兜底（替换 v1 的「recheckAfterFix 默认翻转」）

v1 方案经审查翻案：`recheckAfterFix=true` 的 scoped prompt 只作用于上轮 clean 的 agent（回归护栏语义），dirty agent 仍全量——翻转默认是增支不是节省。真正烧 token 的是 dirty agent 的全量重扫，新方案直接对它动刀：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| dirty agent R2+ 聚焦 + 每 K 轮审计轮全量（选） | 范围数据来自 6.1 的同一条链（files 并集）；审计轮给「漏检不可观测」一个 ground-truth 通道 | 中：buildR2ReviewPrompt 增加聚焦变体 + 轮次计数器 + clean 判定前强制审计轮 | 聚焦轮漏 scope 外新问题——审计轮兜底；K 值拍脑袋（默认 3）需真实数据校准 | ✅ |
| 维持每轮全量（现状） | 召回最大化 | 零 | §3.2-A 全价验证轮持续 | ❌ |
| recheckAfterFix 翻默认（v1 方案） | — | 极低 | **审查证实语义相反**：给零成本的 clean agent 加审查，增支换护栏 | ❌ |

审计轮双重职责：漏检兜底 + clean 判定的最终确认（若上一轮是聚焦轮，宣布 clean 前必须过一次全量审计轮）。被否方案（维持全量）若用：§5.1 的 Round 2 会是 reviewer-a 重读全部 17 个文件而非聚焦 5 个。

### 6.3 reviewer 报告增加修复指引列，aggregator 透传

reviewer 报告 markdown 的逐 issue 表增加「修复建议（文件/位置/改法）」必填列（prompt 级要求，非 schema 变更）；aggregator 提取进条目 `guidance` 字段；fixer prompt 强调「按指引定位，禁止整文件重写；指引与实际代码冲突时以代码为准」。对齐 AlphaCodium 定向修复（按失败信息修靶点）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 报告列 + aggregator 透传（选） | 侦查成本只付一次（reviewer 副产物） | 低：prompt 模板 + 条目字段 | 指引质量参差误导 fixer（「以代码为准」条款缓释） | ✅ |
| fixer 自行侦查（现状） | 职责干净分离 | 零 | §3.2-B 重复支付 | ❌ |

### 6.4 must-fix 证据门槛：在 aggregator 生效 + 休眠-复活通道

reviewer 报告逐 issue 表增加「证据（测试输出/lint 报错/grep 命中 + 文件行号）」必填列；aggregator 组装 must_fix_ids 时把 evidence 为空的条目降级到 suggestion 区，同时写入 `state.dormant[]`；`buildR2ReviewPrompt` 注入 dormant 清单（复活通道）。依据：CRITIC（工具交互 critique 带客观证据）+ Huang et al. 反方证据。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| aggregator 端门槛 + dormant 复活通道（选） | reviewerSchema 零破坏（must_fix 保持计数）；门槛在唯一聚合点生效 | 中：aggregator prompt + dormant 状态 + R2+ prompt 注入 | 真问题误降级（复活通道缓释 + 复活率观测） | ✅ |
| reviewer schema 加必填 evidence（v1 方案） | — | — | **审查证实破坏现状**：must_fix 是 number 计数，无条目可挂字段；且复活通道依赖的 R2+ prompt 改动 v1 未列入任务 | ❌ |
| 不加门槛 | reviewer 自由度大 | 零 | §3.2-C 噪声轮持续 | ❌ |

### 6.5 aggregator 降档模型

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 新增 `aggregatorModel` 参数，缺省低一档（选） | 成本与任务复杂度匹配 | 低：参数透传 agent() | 去重质量下降（同义 issue 合并不全）；**与 6.1/6.4 的能力需求叠加**——条目结构化提取比纯计数更吃模型能力 | ✅（带探针） |
| 维持 run 级统一模型 | 简单 | 零 | §3.2-D 固定高价 | ❌ |

叠加风险如实声明：6.1/6.4 让 aggregator 从「数数+去重」变成「提取结构化字段」，降档模型的失败面变大。⛔ P-agg：同一真实 run 分别用降档/高档 aggregator，对比 must_fix_ids 的 files/evidence 填充率与去重一致率；降档组填充率显著低则回退参数默认值。

## 7. 实现机制（把终态落到代码层）

**本章结论：改动集中四个文件；核心是一个 schema 扩展 + 三个消费点；reviewerSchema 不动。**

| 文件 | 改动 |
|---|---|
| `workflows/review-fix-loop-utils.cjs` | 新增 `computeOrigin(entry, fixTouchedFiles)` 纯函数；aggregator prompt 模板增加条目提取规则与证据降级规则；`buildR2ReviewPrompt` 增加聚焦变体（scope 参数）与 dormant 注入段；`buildFixPrompt` 增加「按 guidance 定位」段 |
| `workflows/review-fix-loop.js` | aggregatorSchema.must_fix_ids 条目扩展 `{files?, evidence?, guidance?}`；聚合后：证据降级（写 state.dormant）+ computeOrigin 写 state.issues[id].origin；R2+ 轮按 6.2 选择聚焦/审计 prompt；clean 判定前强制审计轮；新增参数 `scopedR2`（默认 true）、`auditEvery`（默认 3）、`evidenceGate`（默认 true）、`aggregatorModel` |
| reviewer prompt 模板（脚本内 reviewPrompt 默认值） | 报告逐 issue 表增加「证据」「修复建议」必填列说明 |
| `src/__tests__/review-fix-loop-utils.test.ts` | computeOrigin（regression/new/无 files 边界）、dormant 注入、聚焦 scope 并集、审计轮触发逻辑 |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模中等，用真实 PR 审查场景验证五条目标；验收预期按修正后的机制语义书写。**

### 8.1 改动规模

中：aggregator schema 扩展 + R2+ prompt 变体 + 状态字段 + 四个新参数。不改循环骨架，不动 reviewerSchema。

### 8.2 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 真实 PR 全跑 | 目标 1/2/3/4 | xyz-agent 仓选一个真实改动 PR（≥5 文件），`workflow run review-fix-loop --args targetType=git-diff target=main batch1=<reviewer> autoCommit=false` 跑到终止 | 正常终止；R2+ 新 issue 带 origin 或 WARN；R2+ dirty agent 日志显示聚焦 prompt（范围列出来自 R1 的文件）；审计轮（第 K 轮与 clean 判定前轮）日志显示全量 prompt |
| S2 归因统计可读 | 目标 1 | jq/python 统计 S1 的 state.json | regression/new/dormant 三类计数输出；origin 缺失时有对应 WARN 日志（而非静默） |
| S3 证据门槛生效 | 目标 4 | 抽查 S1 聚合报告 | must-fix 区每条带证据列；若有降级条目，suggestion 区可见 + state.dormant 有记录 + 下轮 R2+ prompt 含复活清单 |
| S4 指引可用 | 目标 3 | 观察 S1 fix 轮的产出 diff | fix 改动文件与 guidance 指向文件一致，或 fixer 在 fixes[] 的 description 中说明了偏离理由（替代 v1 「无大面积无关重写」抽象断言） |
| S5 双 opt-out 护栏 | 目标 2/4 的回退路径 | 同一 PR 分别加 `scopedR2=false`、`evidenceGate=false` 重跑 | 前者每轮全量（无聚焦 prompt），后者无证据条目也进修复队列——两条回退路径都可用 |

单测只作回归辅助，不计入验收。

## 9. 实施

**本章结论：两个里程碑，数据链先行。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M1 | 聚合条目扩展 + origin 归因 + 证据门槛 + dormant 通道（6.1/6.4 + 6.3 的传输部分） | 目标 1/4 + 数据链 |
| M2 | 聚焦审查 + 审计轮（6.2）+ fix_guidance 消费（6.3）+ aggregatorModel（6.5） | 目标 2/3/5 |

M1 先行的理由：聚焦审查的 scope 数据（files 并集）来自聚合条目扩展——没有 M1 就没有 M2 的数据源；且 M1 的 origin/复活率数据是 M2 效果的观测仪表。

## 10. 下一层拆分

**本章结论：拆成 5 个实现任务，T1 是全组的数据源前提。**

| 单元 | 说明 | justification |
|---|---|---|
| T1 聚合条目扩展（schema + aggregator prompt） | `{files?, evidence?, guidance?}` 三字段 | 6.1/6.3/6.4 的共同数据源，必须先做 |
| T2 computeOrigin + state 写入 + 单测 | 纯函数 + 集成 | 独立可测 |
| T3 证据门槛 + dormant 状态 + R2+ 复活注入 | aggregator 降级规则 + buildR2ReviewPrompt 改动 | v1 审查发现复活通道不在任何任务里——此处显式立项 |
| T4 聚焦 R2+ prompt 变体 + 审计轮逻辑 | scope 并集 + 轮次计数 + clean 前强制审计 | 依赖 T1 的 files 数据 |
| T5 aggregatorModel 参数 + P-agg 探针 | 参数白名单 + @pi-meta + 透传 | 独立参数，与 6.1/6.4 叠加风险由探针守门 |

## 11. 待验证检查点

- ⛔ P-agg：降档 aggregator 的结构化字段填充率与去重质量（6.5，叠加风险守门）。
- ⛔ P-audit：审计轮 K=3 的取值 + 「聚焦轮漏检率」——M1/M2 上线后 5-10 个真实 run 的 origin=new-at-audit 占比校准。
- ⛔ P-dormant：dormant 复活率——持续偏高说明证据门槛过苛或 reviewer 证据写作指引需改进。
- ✅ 已核实（源码）：reviewerSchema.must_fix 为 number 计数；aggregator must_fix_ids 现支持 `{id,severity}`；lastModifiedFiles/fixImpactFiles 已落盘；buildScopedRecheckPrompt 存在且只服务上轮 clean agent；recheckAfterFix 维持默认 false 不动。

## 附录：变更历史

- v1：初版（基于业界调研 + 441 个 e2e run 基线）。
- v2：对抗式审查后重写——origin 数据源从悬空的 state.issues 改为聚合条目扩展；「recheckAfterFix 翻默认」翻案为「dirty agent 聚焦 + 审计轮」（原方案经源码核实语义相反：scoped 只服务上轮 clean agent，翻转是增支不是节省）；证据门槛从 reviewerSchema 破坏性变更改为 aggregator 端生效 + dormant 复活通道显式立项；验收 S1/S5 按修正后的机制语义重写；missed 不可观测问题由审计轮兜底并如实标注 origin 语义边界。审查报告见同目录 `tier-1-cheap-wins-review.md`。
