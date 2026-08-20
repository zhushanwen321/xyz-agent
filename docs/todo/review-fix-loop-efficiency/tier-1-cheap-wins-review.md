# 对抗式审查报告：tier-1-cheap-wins.md

审查对象：`docs/todo/review-fix-loop-efficiency/tier-1-cheap-wins.md`
审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`
事实核实源码：`extensions/subagent-workflow/workflows/review-fix-loop.js`（1044 行）+ `review-fix-loop-utils.cjs`（797 行）

## Summary

6 must-fix, 5 suggestions, 1 info.

核心结论：五个决策中，**6.2（scoped 默认化）的动机论证与机制实际语义相反，6.4（证据门槛）的 schema 载体与复活通道均不成立，6.1（origin 归因）缺一半判定数据与两个判定算法**——梯队 1 里只有 6.3（fix_guidance）与 6.5（aggregatorModel）的方案链路基本完整。验收 S1/S5 的通过标准按错误的机制预期书写，照文档实施后照文档验收会误判。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4 / §7 T1 | P0-11 事实 + P0-12 遗漏 | **origin 归因缺「issue → 涉及文件」数据源，"零新依赖"不成立。** 文档声称"origin 判定所需的两个集合在现实现里已经落盘，本设计只是把既有数据做一次集合运算并多写一个字段"。核实源码：集合的一侧（modifiedFiles / fixImpactFiles）确实落盘（review-fix-loop.js:928 `state.fixImpactFiles = impactFiles`、:990 `state.lastModifiedFiles = modifiedFiles`）；但**另一侧不存在**——`state.issues[id]` 条目只有 firstSeen/severity/status/history/fixAttempts/openStreak/deferredReason（:669/:720），无任何文件信息；aggregator 的 `must_fix_ids` 只含 `{id, severity}`（aggregatorSchema，:243 起）。`computeOrigin(issueFiles, ...)` 的第一个参数在现有数据里无来源。翻车场景：实施 T1 时发现 issueFiles 无数据可取，要么临时给 reviewer/aggregator schema 加 per-issue 文件字段（T1 从"一个纯函数"膨胀为 schema+prompt+解析链路，与 T3 撞车），要么正则解析聚合报告 md 表格（脆弱）；origin 字段大面积缺失 → S2 验收"总和 = R2+ 新 issue 数，无 undefined"必然失败。 | 在 §7 显式设计 issueFiles 的数据源（建议并入 T3 的 fix_guidance 字段：reviewer 报告每条 must-fix 时给 file 列表，aggregator 透传），并修改"零新依赖"的声称。 |
| MUST_FIX | §4 / §6.1 / §7 T1 单测 | P0-12 遗漏 | **missed 与 severity-drift 的判定算法缺失。** §4 只给出 regression 的集合运算；missed = "在审查范围内但上轮没报"——"上轮审查范围" workflow 不可知（reviewer 实际读了什么无记录）；severity-drift = "与上轮某 issue 重叠但严重度变化"——"重叠"是语义匹配，纯文件集合运算判不出来，且 `computeOrigin(issueFiles, modifiedFiles, fixImpactFiles)` 的签名里**没有上轮 issues 输入**，物理上无法判定 drift。§7 却声称单测覆盖"regression/missed/drift 三例"。翻车场景：实施时三分类退化成两分类（regression / 其他），§2 目标 1"统计三类占比"落空，而文档全程按三分类写验收（S2"输出三类计数"）——验收直接不过。 | 补齐两类算法（如 drift 用上轮 must_fix_ids 的 id/severity 比较，missed 定义降级为"非 regression 的 R2+ 新 issue"并承认其语义缩水），或砍成两分类并同步改 §2/S2。 |
| MUST_FIX | §2 目标 2 / §3.2-A / §6.2 / §5.1 | P0-10 因果链 | **scoped 默认化的"省 token"动机与机制实际语义相反。** 核实源码：recheckAfterFix=true 时（:530-534）`scopedClean = 上轮 clean 集合`，只有**上轮 clean 的 agent** 走 scoped prompt；dirty agent（§3.2-A 痛点的主体——R1 报了 must-fix 的 reviewer）R2+ 仍走 `buildR2ReviewPrompt` 全量对账+hunt，不受本决策影响。而现状默认 false + skipCleanAgents=true 下，clean agent 下轮**直接跳过、成本为零**（源码注释 :150 明确称 true 为"可选强回归模式"）。因此翻转默认值的实际效果是：clean agent 从"零成本跳过"变为"scoped 便宜重审"——**相对现状是增支，不是省钱**；相对"true 且全量重派"才省。文档 §6.2"省的是每轮最贵的输入 token"对比基准选错；§3.2-A 定义的痛点（dirty agent 重扫 17 文件）在本设计五个决策中**无任何对应解法**。翻车场景：实施后真实 run 的 R2+ 轮 token 不降反升（多了 clean agent 的重派），目标 2 不可达成；更糟的是决策 6.2 的真实价值（catch 跨文件回归的护栏）被错误叙述掩盖，后续梯队决策基于错误账本。 | 把 6.2 的动机改写为"低成本回归护栏"（花钱换安全），明确 dirty agent 全量对账成本不在梯队 1 范围；或在 scoped 设计上扩展到 dirty agent 的 hunt 范围并讨论召回取舍。 |
| MUST_FIX | §8.2 S1 / S5 | P0-13 验收不可执行 | **S1/S5 通过标准按错误的机制预期书写。** S1 要求"R2+ reviewer 日志显示 scoped prompt（只列 R1 修改文件）"——但按机制（上条），R2 时 R1 报了 must-fix 的 reviewer 全部 dirty，**没有一个 agent 会走 scoped prompt**；只有 R1 就 clean 的 agent 在 R2 才可能 scoped。S5 声称 `recheckAfterFix=false` "行为回到全量重审（日志显示 reviewer 收全量 prompt）"——实际 false 时 clean agent 被 skipCleanAgents 过滤**不重派**，根本收不到任何 prompt。翻车场景：实现完全正确，但按 S1 验收判"scoped 未生效"、按 S5 验收判"回退路径失效"，误打回返工；或实施者为了让验收通过而把机制改错。 | S1 通过标准改为"若 R(n-1) 有 agent clean 且 R(n-1) 有 fix，则 Rn 该 agent 日志显示 scoped prompt"；S5 改为对比两种模式下 clean agent 的派发行为差异。 |
| MUST_FIX | §6.2 缓释 / §11 P-scope | P0-10 风险缓释失效 | **missed 统计兜底存在循环论证，缓释机制不成立。** scoped 模式下 clean agent 只审改动文件；scope 外的漏检问题**永远不会作为"新 issue"出现**（没被发现就进不了 must_fix_ids），origin=missed 只能统计"scope 内被迟报的问题"。因此"若真实 run 中 missed 占比上升说明 scope 过窄"（§6.2）/ P-scope"用 M1 数据判断 scoped 是否过窄"（§11）的观测手段**系统性看不到它要观测的风险**——scoped 越窄，missed 计数反而越低。翻车场景：scoped 上线后 missed 率显示正常，运维者据此确认 scope 合理；真实漏检在 run 终止后被用户发现（正是 §5.2 第二条描述的场景），而 state.json 里没有任何记录能回溯它。 | 缓释改为外部校验：定期 opt-out 全量重审对照（比较同 target 下 scoped vs 全量的终态差异），或在验收中显式构造"跨文件破坏"用例验证 scoped 漏检率；承认 origin=missed 不度量 scope 外漏检。 |
| MUST_FIX | §6.4 / §7 schema 行 / §10 T4 | P0-11 事实 + P0-12 遗漏 | **(a) evidence 字段与现 schema 结构冲突未声明；(b) 复活通道的实现改动整体遗漏。** (a) 现 reviewerSchema 的 `must_fix` 是 **number 计数**（review-fix-loop.js:204），不存在"每条 must-fix"的载体；§7 写"must_fix 条目增加 evidence（必填）"意味着把 number 改成数组或新增平行数组——这是破坏性 schema 变更，文档未声明、未评估对 normalizeReviewResult / recordAgentDirty / R1 初始化 / converge 判定的连带影响。(b) §5.2/§6.4 的风险缓释核心是"降级条目下轮可带证据复活"，这要求 R2+ reviewer prompt 引用上轮聚合报告的降级区——但 §7 实现表只列 buildAggregatorPrompt 与 buildFixPrompt，**buildR2ReviewPrompt / buildScopedRecheckPrompt 的改动不在任何任务里**（T4 只有"schema + aggregator prompt 规则"）。翻车场景：(a) 实施 T4 时二选一：改 schema → 所有存量 reviewer agent（输出 must_fix: 数字）结果校验失败，每轮 review-failure 结构化终止；不改 schema 只把 evidence 留在 md 报告 → "把客观信号权威固化为 schema 契约"（§6.4 长期合理性栏）的声称落空。(b) 被误降级的真问题无任何机制回到下轮 reviewer 视野（新 spawn 的 agent 不知道有降级条目存在），永久滞留 suggestion 区——"降级不等于丢弃"承诺落空，漏修进入交付物。 | (a) 明确 evidence 的载体选型（schema 数组字段 vs 报告内裁决）并写清兼容性路径；(b) T4 增加 R2+ prompt 携带上轮降级清单的改动项。 |
| SUGGESTION | §4 数据流图 | P1-8 事实（偏上） | 数据流图把 origin 判定的 modifiedFiles 来源标为 `batches[].rounds[].modifiedFiles`，但该数组**批终止时才 push 进 state.batches**（:987/:997），批内 R2+ 聚合后执行 origin 判定时读不到本批数据——正确数据源是即时字段 `state.lastModifiedFiles`（:990，源码 M4 注释明确记载此坑）。照图实现会拿到空数组、origin 全判 missed。另 fixImpactFiles 是 run 级字段且**每轮覆盖**（:928），图中层级与语义均未标注。 | 图中标注 lastModifiedFiles（批内）/ batches[].rounds[]（批间）双通道及 fixImpactFiles 的覆盖语义。 |
| SUGGESTION | §6.1"误报可接受" | P0-11 降级（偏 SUGGESTION） | 文档承认文件级粒度误报但未识别一个系统性偏差来源：`fixImpactFiles` 来自 fix agent **自报**的 affected_files，其语义含"只是检查/同步过、并未修改"的参考文件（fixSchema :271 注释 "Files touched by this fix + files checked/synced as reference points"）。交集分母被自报集合膨胀 → regression 占比系统性偏高 → "regression 多 ⇒ 修质量差"的决策被误导。"看比例趋势"的辩护不覆盖方向性偏差。 | 文档补记该偏差方向；实现时可考虑只用 git 实测 modifiedFiles 做 regression 判定、fixImpactFiles 仅用于 scope。 |
| SUGGESTION | §5.2 第三条 | P1-8 事实 | 恢复指引"检查 aggregator prompt 是否被自定义 `reviewPrompt` 覆盖"——reviewPrompt 参数只进入 R1 reviewer 的 prompt（buildReviewCall 默认分支），aggregator 用内置 buildAggregatorPrompt，**reviewPrompt 不影响 aggregator**，指引指错方向。 | 改为检查 aggregator 输出 / normalizeAggregatorResult 兼容性。 |
| SUGGESTION | §8.2 S4 | P0-14 降级（验收抽象断言） | "fixer 无大面积无关重写"是抽象断言——"大面积""无关"无判定标准，两个验收人会得出不同结论。 | 改为可操作判定，如"diff 触及文件 ⊆ fix_guidance 文件 ∪ 聚合报告引用文件"或 diff 行数上限。 |
| SUGGESTION | §6.4 × §6.5 | P0-12 降级（决策叠加风险） | 6.4 给 aggregator 新增"裁决 evidence 是否客观"的智能任务，6.5 同时以"去重+格式化不需要深度推理"为由给 aggregator 降档——两个决策对 aggregator 能力假设相反，叠加风险（降档后裁决质量）未评估。P-agg 探针只覆盖去重一致率，未覆盖证据裁决准确率。 | P-agg 探针增加"降级裁决与人工判断一致率"维度。 |
| INFO | §3.3 | — | "441 个 e2e run 实测基线"自我声明为 mock fixture、不能当真实分布。诚实性达标，但具体数字（1.29/0.78/25%/17%）在文档标题"本地实测基线"下易被后续文档直接引用为真实分布，建议数字旁就地标注或移附录。 | — |

## 查过但无发现的维度

- **P0-1 五段骨架**：背景（§1）/ 目标（§2）/ 现状（§3）/ 方案（§5-7）/ 验收（§8）/ 下一层拆分（§10）齐全。**通过**。
- **P0-2 delta 链**：无"参见上版/Rxx-finding"式引用；附录"变更历史 v1"是版本记录非 delta 链。**通过**。
- **P0-3 结论先行**：每章首句有"本章结论"，开篇有 SCQA。**通过**。
- **P0-4 问题定义**：§3.2 四种成本形态有具体例子（17 文件、2 文件）；§4 根因"轮次成本与轮次类型无关"有挖到层。问题定义本身忠实于真实痛点——但 §3.2-A 痛点的解法缺失已在 MUST_FIX 3 列出。
- **P0-5 使用者视角**：§3.1/§5.1 有完整命令行+日志形态例子。**通过**。
- **P0-6 抽象术语**：发现轮/验证轮/origin 归因在 §4 开头就地定义并绑例子。**通过**。
- **P0-7/8/9 方案对比**：五个决策均有 ≥2 方案对比表，含长期/短期双维度与明确裁决；被否方案记录了"若用会怎样"。**通过**。
- **P0-14 验收形式**：S1-S5 是真实 PR + 真实 workflow run，非单测非 mock，文档明确声明单测不计入验收。形式达标；内容矛盾已在 MUST_FIX 4、SUGGESTION（S4）列出。
- **P0-15 验收投入**：中等改动配 5 个真实场景，投入匹配。**通过**。
- **P0-16 运行时断言探针**：P-agg / P-scope / P-evidence 三个 ⛔ 探针 + 源码已核实项标注 ✅，探针意识达标；P-scope 探针的观测有效性已在 MUST_FIX 5 列出。
- **P0-17 物理数据流图**：§4 有图且标了磁盘路径。**通过**（数据源标注错误见 SUGGESTION 1）。
- **P0-18 错误恢复指引**：§5.2 三条失败路径均有具体恢复动作；其中一条指错方向见 SUGGESTION 3。
- **P1-2 拆分 justification**：§10 五个任务均有"为什么这么拆"。**通过**。

## 事实锚点核实记录（文档声称 vs 源码）

| 文档声称 | 核实结果 |
|---|---|
| recheckAfterFix 默认 false | ✅ 属实（review-fix-loop.js:152；@pi-meta default: false） |
| modifiedFiles 落盘（git diff 实测） | ✅ 属实（:987/:990），但批内需读 lastModifiedFiles（见 SUGGESTION 1） |
| fixImpactFiles 已落盘 | ✅ 属实（:928），run 级、每轮覆盖 |
| buildScopedRecheckPrompt 已存在 | ✅ 属实（utils.cjs:106） |
| aggregator 用 run 级 MODEL | ✅ 属实（:623 `model: MODEL`；reviewer :388 / fix :852 同） |
| "origin 判定所需集合已落盘，零新依赖" | ❌ **不成立**——issue→文件一侧无数据（见 MUST_FIX 1） |
| "每条 must-fix 加 evidence 字段" | ❌ 与现 schema（must_fix: number，:204）冲突未声明（见 MUST_FIX 6） |
| §5.1 R2 两个 reviewer 均 scoped | ❌ 与机制相反——仅上轮 clean 的 agent scoped（:530-534）（见 MUST_FIX 3/4） |
| S5 "recheckAfterFix=false 回到全量重审" | ❌ false 时 clean agent 被跳过不重派（见 MUST_FIX 4） |
