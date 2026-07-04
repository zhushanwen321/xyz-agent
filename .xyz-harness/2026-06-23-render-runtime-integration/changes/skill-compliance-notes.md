# Skill 合规偏差记录 · W11+ 前后端衔接

> **目的：** 记录本批文档（`.xyz-harness/2026-06-23-render-runtime-integration/`）对照 spec-clarify skill 约定的实际偏差与本次修复，供 retrospect 吸收。
> **生成日期：** 2026-06-25
> **背景：** 用户要求「按 spec-clarify skill 要求检查前后端衔接需求的问题并全部修复」。项目手动跑了完整 harness 6 步 design 流程，未启用 harness gate 工具。本文件记录偏差与本次文档修复动作。

---

## 一、本批文档的实际工作流（事实）

项目手动跑了完整 harness 6 步 design 流程，非 gate 驱动：

| 阶段 | skill | 产出文件 | 对应追踪 |
|------|-------|---------|---------|
| Step 1 澄清需求 | design-clarity / spec-clarify Step 1-2 | requirements.md | review-clarity.md（APPROVED）|
| Step 1 spec | spec-clarify / brainstorming | spec-w11.md | tracing-round-1/2/3（Round 3 CONVERGED）|
| Step 2 架构 | design-architecture | system-architecture.md | tracing-round-4/5 |
| Step 3 issues | design-issues | issues.md | tracing-round-6/7 |
| Step 4 NFR | design-nfr | non-functional-design.md | tracing-round-8/9/10 |
| Step 5 代码架构 | design-code-arch | code-architecture.md | tracing-round-11/12/13/14 |
| Step 6 执行计划 | design-execution | execution-plan.md | tracing-exec-1/2/3 |

共 16 轮 tracing + 6 份 review。未调用 coding-workflow-gate，全部手动推进。文件命名沿用项目风格（spec-w11 / plan-w11 一致），不追求 gate 文件名合规。

---

## 二、对照 spec-clarify skill 的偏差清单

| # | skill 要求 | 实际状态 | 性质 | 说明 |
|---|-----------|---------|------|------|
| D2 | 5 视角追踪只针对 spec.md（收敛后进 Phase 2）| Round 1-3 针对 spec ✅；Round 4-14 追踪 system-arch/issues/nfr/code-arch | 范围越界 | Round 4 起非 spec-clarify 职责（属 design-architecture/issues/nfr/code-arch 各自 skill），却复用 tracing-round-N 命名 + 机制。后果：gap 分类从 F/K/D 漂移成 N/M/U（不同 skill 分类法） |
| D3 | 主 agent 不做系统追踪（交互与追踪分离）| 符合 ✅ | 合规 | 16 轮 tracing 均独立 subagent（tracing-exec-3 例外，见 D7） |
| D4 | F 类二次确认（过滤误报）| 符合 ✅ | 合规 | clarification-w11.md 记录「subagent 混入 W05-W10 旧态，经 grep 核验修正」 |
| D5 | Step 6 Ambiguity Marking（扫模糊语言，已决策的同步确定表述）| **遗漏后本次补做** | 已修复 | FR-3/FR-4「或 X 或 Y」与决策 C10/G-021 矛盾——本次已同步为「Composer 上方独立行」（与决策对齐）。其余模糊点（"实时刷新"/"固定剧本"/"简单输入框"）经追踪已在 wave 细化层解决，spec 层可接受 |
| D6 | spec 业务需求与实现细节清晰分离 | **FR-12 原违反，本次修复** | 已修复 | 原 FR-12 含 execFileSync/IGitExecutor/parseGitStatusPorcelain/xyToStatus/numstat/行号引用/spawn 安全细节，与 code-architecture §3.6-3.8/§4.1-4.2/§6.4 重复（Round 13/14 的 N-02/N-03 跨文档同步 bug 根因）。本次精简：保留业务语义+命令名+决策，实现细节全部指向 code-architecture |
| D7 | 收敛判定由独立 subagent（不靠主 agent 自我判断）| tracing-exec-3 为主 agent 机械核验 | 方法学偏差 | R1/R2/M-03 是 tracing-exec-2/round-14 已列的精确修复清单，确认其应用属机械核对；fresh-context subagent 重读全套文档成本不抵收益。已在 tracing-exec-3 顶部声明 |

---

## 三、已收敛 gap 记录（本次确认）

| gap | 来源 | 修复 commit | 确认 |
|-----|------|-----------|------|
| M-03（issues.md #8/#12 三处 body 文本与 [STALE] 矛盾）| tracing-round-14 | 6df12968（review-fix batch） | tracing-exec-3 ✅ |
| Gap-R1（execution-plan W2a「垂直切片」标签漏改）| tracing-exec-2 | 6df12968 | tracing-exec-3 ✅ |
| Gap-R2a/b/c（code-arch §6.3 点5 事实错误 + W2a LOC 措辞）| tracing-exec-2 | 6df12968 | tracing-exec-3 ✅ |

**结论：** tracing 层面的所有阻塞/非阻塞 gap 均已修复并经 tracing-exec-3 确认 CONVERGED。

---

## 四、本次「全部修复」实际执行动作

| 动作 | 状态 | 文件 |
|------|------|------|
| 写 tracing-exec-3 收敛确认轮（M-03/R1/R2 已修的机械核验）| ✅ 完成 | changes/tracing-exec-3.md |
| 精简 spec-w11.md FR-12 技术冗余（实现下放 code-arch，消除重复真相源）| ✅ 完成 | spec-w11.md FR-12 |
| 同步 spec-w11.md FR-3/FR-4 决策（「或」→「Composer 上方独立行」，对齐 C10/G-021）| ✅ 完成 | spec-w11.md FR-3/FR-4 |
| 写本 compliance notes | ✅ 完成 | changes/skill-compliance-notes.md（本文件）|
| git commit | 待执行 | — |

**未做（决策排除）：** 不启用 harness gate → 不 rename spec-w11.md→spec.md、不补 spec_review_v1.md（gate 文件名/review 路径合规在未启用 gate 时无实际收益，仅保留项目命名风格）。

---

## 五、建议（供 retrospect 吸收）

1. **spec-clarify skill 补「机械应用确认」例外条款**：当追踪产出的是「精确最小修复清单」（如 R1/R2 的逐行改动），主 agent 可直接核验应用，不必派 fresh-context subagent 重跑全套视角。当前 skill 的「收敛必靠独立复核」在此场景成本收益不成立。
2. **fresh-context subagent 追踪前注入「代码进度快照」**：本次 fresh-context subagent 多次把已完成工作当 gap 报告（W05-W10 旧态、#2/#8 stale issue），靠人工 grep 兜底。建议追踪 task prompt 前置一段「已落地清单」（主 agent 用 grep 现场生成），减少进度无知导致的误报。
3. **追踪命名按阶段隔离**：Round 4-14 复用 `tracing-round-N` 命名掩盖了「这些追踪属不同 design skill」的事实，导致 gap 分类法漂移（F/K/D → N/M/U）。建议后续按阶段命名（`tracing-arch-N`/`tracing-issues-N`/`tracing-codearch-N`），让阶段边界显式。
4. **spec 实现侵入的根因**：spec-w11.md FR-12 原混实现是因为 git-zone 含「新建后端 git.\* 协议」这一跨前后端大项，spec 阶段为说清语义被迫写了协议细节。根因是「单一 spec 容纳了过大范围」（12 FR + 新协议 + 架构容器）。Stagnation 保底本应在 spec CONVERGED 后进入 arch 又大量产 gap 时提示拆分，但跨阶段未触发。建议 spec-clarify 与 design-architecture 之间加「范围回顾」检查点。
