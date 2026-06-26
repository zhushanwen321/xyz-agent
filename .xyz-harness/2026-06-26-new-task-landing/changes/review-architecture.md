---
verdict: APPROVED
machine_check: PASS
---

# 审查报告 — architecture（Round 2 终审）

## Verdict
**APPROVED**

机器检查实质项 7/7 全过（唯一 FAIL 是本报告自身 verdict 元问题，写入即解除）；上轮 7 条「必须修改」逐条闭合；6 维审查无新实质问题，仅剩 cosmetic 级残留（§3 统一语言 RecentWorkspace 措辞、TL;DR 冗余条），不阻断交接。

## 上轮必须修改闭合验证（7 条逐条 ✅）

| # | 上轮必须修改 | 闭合状态 | 证据 |
|---|------------|---------|------|
| 1 | 占位符 `{session}` → 非花括号形式 | ✅ | md/html §9 泳道图均改 `session.created (SessionSummary)`；machine-check「无占位符 PASS」 |
| 2 | §1 G1.1「LRU 缓存」→ 派生函数措辞 | ✅ | md §1 G1.1 行 + html §1 G1.1 行均改「`recentWorkspaces(sessions)` 派生（distinct cwd top10）+ `resolveDefaultCwd` 纯函数 + sessionApi.create 透传 cwd」 |
| 3 | Status 枚举补 cancelled（8 态） | ✅ | md §5 枚举列 8 值 `...completed | cancelled`（8 态）；html §5 卡片「8 个阶段」同列 |
| 4 | 转换边数 12→17 | ✅ | md §10 D-4 + html §10 D-4 + html TL;DR 三处统一「8 态 + ~17 转换」 |
| 5 | GitInfo 类型 md/html 双源一致（技术读模块） | ✅ | md §4 + html §4 GitInfo 行均标「**技术读模块（分层债）**（非值对象，已有复用）」+「services 层裸 execSync 的读服务，非纯值对象，也非 port」 |
| 6 | UC-7 非 git 目录架构层覆盖（§5+§7+BC-12） | ✅ | §5 不变式加「非 git 目录约束（UC-7）：`gitInfo==null` 时 branch-popover/branch-modal 不可达、chip 隐藏」；§7 landing 职责加「按 gitInfo 派生 branch chip 可见性」；§12 BC-12 md+html 双源补「git-info 非 git 返回 null → chip 隐藏」既有行为保持（源码位置精确到行号） |
| 7 | T2 降级为打回（与 T3 同处置） | ✅ | §1 搭便车表 T2 状态改 `打回` + 红队终裁说明；§10 D-5 标题「git 服务维持分离，不合并（T2 打回）」决策「维持分离，v1 不补 port」；§待确认「[T2 已打回]」；下游衔接「T2/T3 已打回」；html 同步（status--reject） |

**7 条全部闭合。**

## 机器检查结果

`check_architecture.py` → **7/8 passed, exit 1**（FAIL，但唯一失败为元问题）

| 检查项 | 结果 | 详情 |
|--------|------|------|
| system-architecture.md 存在 | ✅ | — |
| frontmatter verdict: pass | ✅ | — |
| 关键章节（4 个必须） | ✅ | 齐全 |
| 无占位符 | ✅ | `{session}` 已改括号形式 |
| **review-architecture verdict** | ❌（元问题） | 期望 APPROVED，实际 CHANGES_REQUESTED（上轮残留，**本报告写入即解除**） |
| 设计立场回答核心计算 | ✅ | 「核心计算 = 技术流程编排」已明确 |
| 核心模型类型标注 | ✅ | 含技术实体/值对象/派生视图/纯函数/技术读模块标注 |
| 状态机 Status/Reason 正交 | ✅ | Status 8 态枚举 + Reason 不引入论证 |

> 唯一 FAIL 项是本报告 frontmatter 的 verdict 字段（上轮判 CHANGES_REQUESTED 的元问题）。本报告 verdict 改为 APPROVED 后此项自动 PASS，机器检查将达 8/8 exit 0。其余 7 项（结构性 + 引用闭环）全过。

## 维度评估（6 维 ✅⚠️❌）

- **内部一致性**：⚠️（实质矛盾全修，仅 cosmetic 残留）
  - 上轮 4 处实质矛盾（G1.1 LRU 措辞 / Status 漏 cancelled / 转换边数 12 vs 17 / GitInfo 类型双源不一致）**全部闭合**。
  - 残留 cosmetic 1：md §3 统一语言 RecentWorkspace (DTO) 定义仍写「LRU 10 缓存」，html §3 同行已改「从 session list 派生」——md/html 双源此处仍有措辞差。但 §4 核心模型表已统一为「派生视图（DTO）」，§7/§10 D-6 均为派生函数，设计整体自洽，§3 属局部措辞滞后。
  - 残留 cosmetic 2：html TL;DR 第 4 条（「T2/T3 双双打回」）与第 5 条（「T3 交叉验证打回」）信息冗余，第 5 条可删。
  - 两项均不影响正确性与可交接性。

- **上游对齐**：✅
  - UC-1..UC-7 全覆盖（上轮 UC-7 零覆盖缺口已修）；G1/G1.1/G1.2/G2 系统目标映射清晰。
  - requirements F1–F8 功能全覆盖：F6（非 git 容忍）经 §5 不变式 + §7 landing 职责 + BC-12 三处落实；F8（unborn HEAD 空态）经 §7 BranchSelect 职责补充。
  - requirements §7 约束「最近 workspace LRU 上限 10」被 D-6 推翻为派生函数——§1 G1.1 行已显式标注派生，未留下「仍写 LRU 缓存」的目标层矛盾。

- **可执行性**：✅
  - §7 模块粒度合理（LOC 预估 0–200，含 0 改动项的明确标注）；§12 BC 源码位置精确到文件:行号。
  - §11 AC：AC-2 已从 `grep -n ... **` 改为 `grep -rn ... --include=useNewTaskFlow*`（采纳上轮可选改进）；AC-4 补全目录前缀；AC-1/3/5/6 可直接跑。6 条 AC 均可执行。

- **完整性**：✅
  - UC-7 缺口（§5+§7+BC-12）、F8 unborn HEAD（§7）均已补。
  - 搭便车 T1/T2/T3 追源完整，T2/T3 打回论证充分（红队终裁 + 交叉验证），移交下游项（Obs-B 实例模型 / git-info 分层债 / T1 工作量）清单明确。

- **可视化质量**：✅
  - Hero 双图（分层架构 + 状态机）置顶，符合「主角图」要求；4 层分色 + 箭头=依赖方向。
  - 5 张图（2 Hero + Context Map + 2 泳道）均带 zoom/pan + diagram-source；状态机 flowchart 转换有注释说明（stateDiagram-v2 标签括号/加粗触发解析陷阱，按 SKILL HISTORICAL 规则转换）。
  - TL;DR + callout + 卡片网格信息密度合理，色彩语义（reject/keep/change/new/candidate）一致。

- **必要性与比例性（红队）**：✅（特别复核通过）
  - **T2 打回红队复核**：T2 证伪三连证据（轻量高频读 vs 重操作是两个变化轴，合并是制造耦合）充分，降级为打回与 T3 同处置，处置标准对齐。打回是减法非过度设计。D-5 额外澄清「分层债修复价值独立于合并决策」——正确分离了「模块合并」与「层边界泄漏」两个正交问题，未因打回 T2 而忽视 git-info 分层债（留 ⑤评估）。
  - **useNewTaskFlow ~200 LOC 上帝对象风险复核**：4 项职责（状态机/overlay 嵌套/Esc 优先级/cwd 解析调度）是 UI 交互流程单一变化轴的不同切面；cwd 解析已外置 `resolveDefaultCwd` 纯函数（§7 单列 ~10 LOC），Esc 优先级可拆但收益有限。核心 ~200 LOC 是状态机 + overlay 同一变化轴，§7 callout 显式论证「非上帝对象」。结论维持：**非上帝对象，~200 LOC 合理，无过度设计**。
  - Port 清单 deletion test 4 项全过（OS DirectoryPicker / pi RpcClient / git CLI 经 IGitExecutor / WS Transport 均真 seam）；分层深度三层合理（D-1 论证）；D-不可逆决策（D-2~D-6）均可逆。无新的过度设计问题。

## 剩余问题（cosmetic，不阻断交接，建议 ⑤code-arch 或后续修订顺手处理）

1. **md §3 统一语言 RecentWorkspace (DTO) 措辞滞后**：仍写「LRU 10 缓存」，与 D-6 打回（降为派生函数）及 html §3（「从 session list 派生」）双源不一致。建议 md §3 改为「纯数据（path + lastUsedAt），**非 aggregate**（Q1=A），从 session list 派生 distinct cwd top10」。
2. **html TL;DR 冗余条**：第 5 条「T3 交叉验证打回」与第 4 条「T2/T3 双双打回」信息重复，建议删第 5 条。
3. **md §7 useNewTaskFlow 行职责描述**仍列 4 项，靠 §7 callout 解释「单一变化轴不同切面」——可接受，若追求极致自洽可将行内职责收敛为「NewTaskFlowState 状态机 + overlay 嵌套编排（单一变化轴）」。

以上 3 项均为措辞级，不影响 Step 3 issue 拆分、不影响代码架构决策、不影响验收可执行性。**本报告判 APPROVED，文档可交接下游。**
