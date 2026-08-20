# subagent-workflow-post-merge-residual-fixes-review (R7)

> **审查对象**：`docs/todo/subagent-workflow-post-merge-residual-fixes.md` v7
> **基线**：`fix-chat-flow-order` HEAD（commit 3af2baa71），代码核实于 worktree `/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/`
> **审查身份**：对抗式审查（adversarial reviewer），默认假设方案有问题，逐项找证据反驳
> **审查依据**：`rubric-design-doc.md` P0/P1 清单
> **前序报告**：R1（`...-review.md`，2 MF / 2 SG / 2 INFO）、R2（3 MF / 1 SG）、R3（2 MF / 2 SG）、R4（2 MF / 3 SG）、R5（1 MF / 2 SG）、R6（2 MF / 1 SG）
> **日期**：2026-08-20

---

## Summary

**0 must-fix, 2 suggestions（其一为确认性 N/A）。审查循环收敛。**

v7 是七轮中最强的版本：R6-MF1 四类型字段矩阵正确补全（四类型全覆盖，每行「缺则」失败模式准确）；R6-MF2+SG wave 拆分修复（U2 显式跨包范围）。三个缺口范围正确、决策有充分方案对比、四形态公式经 R4/R5 穷举验证、验收全部真实 E2E 且通过标准具体。**设计已就绪可实施。**

rubric P0 清单完整核对全部通过（P0-1 至 P0-18），无 P0 违规。自包含性确认：正文不依赖 v11 前版文档（附录 A 明确标注为历史参考）。附录 A 八条裁决与正文一致。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §6.2 矩阵行 2 | P1-8 事实 | **extension SubagentRecord 位置引用错误**。矩阵引 `types.ts:590-607` 为 extension SubagentRecord，但该区间实际是 `SubagentListItem` 接口（TUI 列表展示用，另一个类型，且它 :602 已有 `resumable?` 字段——R6 审查者把 SubagentListItem.resumable 误认成 SubagentRecord 的既有字段，错误位置经 R6「已核实」引用链带入 v7 未复检）。真正的 extension `SubagentRecord` 在 `types.ts:668-716`。矩阵内容正确（668-716 确实 resumable/chatMode 都缺），决策不受影响。附带发现：`SubagentListItem.resumable`（:602）是 TUI 层既有同名字段先例，语义一致，设计新字段与之同名共存不冲突 | 矩阵行 2 位置改 `types.ts:668-716`；可加注 SubagentListItem 同名先例 |
| SUGGESTION | §8 U3 | P1-8 事实 | R6-SG「两点小改 vs 实际 4 处」——v7 U3 已写「四处改动跨两文件」，**已修复**，无需动作 | N/A |

## v7 修复验证（R6-MF1 + R6-MF2+SG）

### R6-MF1：四类型字段矩阵

v7 §6.2 扩为四行矩阵。逐行核实：

1. Extension `ExecutionRecord`（types.ts:345-474）：+resumable，chatMode 已有（:373）。**核实**：源码确认无 resumable 字段、`chatMode?: boolean` 在 :373。✅
2. Extension `SubagentRecord`（标注 590-607，实际 668-716）：+resumable +chatMode。**核实**：types.ts:668-716 两字段均缺。✅（行号错，见 SG1）
3. `SubagentRecordEntryData`（record-entry.ts:38-77）：+resumable +chatMode。**核实**：两字段均无。✅
4. shared `SubagentRecord`（packages/shared/src/subagent.ts:38-93）：+resumable +chatMode。**核实**：两字段均无。✅

每行「缺则」列映射具体编译失败。**闭环**（行 2 行号偏差见 SG1）。

### R6-MF2+SG：wave 拆分补全

U2 扩为显式跨包（extension record-store/index.ts + types.ts + record-entry.ts + shared subagent.ts + runtime subagent-extractor.ts）；U3 扩四处两文件。覆盖核对：§6.1.1→U1、§6.1.2→U2、§6.1.3→U3、§6.1.4→U4、§6.2→U2、§6.3→U3、§6.4→U2——§6 全部条目有明确 wave 归属。**闭环**。

## rubric P0 全清单核对

| 检查 | 判定 | 证据 |
|------|------|------|
| P0-1~3 | 通过 | 五段骨架完整 + SCQA 开篇 + 每章首句结论 |
| P0-4/5/6 | 通过 | 根因级问题定义（S1/S3 到代码行）；SCQA/S4.1 使用者例子；resumable/chatMode/四形态均有首次定义 |
| P0-7/8/9 | 通过 | 决策 2/4 各三方案，含长期/短期/风险列 + 明确裁决 |
| P0-10 | 通过 | 因果链核实：save→appendEntry→runtime 失效→收敛；孤儿→分支 4 读 JSONL→archive→entry→收敛——均打根因 |
| P0-11 | 通过 | 关键事实全部源码核实（见下），无影响决策的错误 |
| P0-12 | 通过 | 四类型矩阵覆盖全部副作用；向后兼容（防御式守卫 + 可选字段 + 不升 schema 版本）；buildRecord 重建路径经 base 类型（IdentityHeaderRecon :509 / ReconstructedRecord :157 已携带 chatMode）覆盖 |
| P0-13/14/15 | 通过 | 5 真实 E2E 场景 + 1 回归，通过标准具体、回溯目标；改动面与验收投入相称 |
| P0-16 | 通过 | V1-V4 覆盖全部静态不可确证断言 |
| P0-17 | 通过 | 开篇物理数据流图 |
| P0-18 | 通过 | §4.2 错误恢复表（4 失败场景 + 恢复动作） |
| 自包含 | 通过 | 正文无 v11 依赖（附录 A 标注历史参考）；变更历史是正规记录非 delta 链 |
| 附录 A | 通过 | 8 条裁决与正文一致 |

## 源码核实汇总（R7 新增）

36. **buildRecord（record-store.ts:756-847）**：full/light 两路都带 `sessionFile: base.sessionFile`（:785/:811）——分支 4 可经 rec.sessionFile 定位子 JSONL。`IdentityHeaderRecon`（:498-515）与 `ReconstructedRecord`（:139-165）均携带 `chatMode?: boolean` 与 `sessionFile: string`。
37. **reportRecordTransition（record-store.ts:271）**：收 ExecutionRecord，内部 recordToSubagent → toSubagentRecordEntry。分支 4 数据源是重建的 SubagentRecord——设计的「新增 SubagentRecord 入口方法」必要性确认。
38. **session_start 初始化顺序（index.ts:308-517）**：service.initSession（:384）→ store.setPi（subagent-service.ts:320）；workflow 域从 :448 开始；恢复循环 :466-476。collectRecords 在 :384 之后任意时点可调——session_start 主动触发可行。
39. **doFinalizeRoundToIdle（finalize-record.ts:187-248）**：设 result/status/closedReason/round/idleSince，**当前不设 resumable**，:244 调 reportRecordTransition——设计「在 :244 前补 record.resumable = true」正确。
40. **冷路径续轮（subagent-service.ts:810-813）**：:811 status="running"、:813 reportRecordTransition，**当前不清 resumable**——设计「:813 前补 record.resumable = undefined」正确。
41. **SubagentListItem（types.ts:581-607）**：:602 已有 `resumable?: boolean`，无 chatMode——与 SubagentRecord（:668-716）是不同类型；R6 的「extension SubagentRecord 在 590-607」引用有误（本报告 SG1）。
