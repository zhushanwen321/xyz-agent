---
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-07T21:45:00"
  target: ".xyz-harness/2026-06-07-streaming-collapse/spec.md"
  verdict: pass
  summary: "Spec review v2 增量审查完成，6 项 Resolved Ambiguities 均与 FR 一致，无新增 MUST_FIX"

statistics:
  total_issues: 5
  must_fix: 0
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: LOW
    location: "spec.md — FR-2/FR-4「多个 chip 可同时选中（AND 关系）」"
    title: "AND 关系措辞歧义"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "spec.md — AC#9"
    title: "lint 0 errors 作为功能验收标准不恰当"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md — Out of Scope"
    title: "未提及 keyboard a11y（Tab 导航、Enter/Space 触发展开）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "spec.md — 当前实现状态"
    title: "Tool renderer 集成标记为 ❌ Missing，与 FR-4/Constraints 存在实现差距但 spec 需求本身清晰"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "spec.md — 当前实现状态「验证/测试 ❌ Missing」"
    title: "验证/测试的归属应在 plan 中明确为 task"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec Review v2 — Streaming Collapse（增量审查）

## 评审记录
- 评审时间：2026-06-07 21:45
- 评审类型：计划评审（spec 完整性，增量审查模式）
- 评审对象：`.xyz-harness/2026-06-07-streaming-collapse/spec.md`
- 前置版本：v1 review（verdict: pass, 0 MUST_FIX）

## 增量审查范围

v1 review 后 spec 新增了 **Resolved Ambiguities** 章节（6 项），逐条检查：

| # | 澄清内容 | 与 FR 一致性 | 判定 |
|---|---------|-------------|------|
| 1 | compactStreaming 展开后 block 遵循 autoExpandThinking/autoExpandToolCalls | 与 FR-4 "展开后复用 ToolCallCard/ThinkingBlock" 一致，组件本身遵循设置 | ✅ 无问题 |
| 2 | "+N more" overflow 在 v1 实现 | 与 FR-5 "chip 数量超过 4 种" 对齐 | ✅ 无问题 |
| 3 | Chip 数值统一用 tool call 调用次数 | 与 FR-2 "显示 toolName N" 一致 | ✅ 无问题 |
| 4 | 操作行展开复用 ToolCallCard/ThinkingBlock（不做纯文本降级） | 与 Constraints "复用现有渲染链" 完全一致，强化了已有约束 | ✅ 无问题 |
| 5 | overflow "还有 N 个" 点击后就地展开全部操作行 | 与 FR-5 "点击后就地展开该类型全部操作行" 一致 | ✅ 无问题 |
| 6 | streaming bubble 在 streaming 结束时自动收回为 CompactSummaryBar | 与 FR-4 交互模型表 "streaming 结束 → 自动收回" 一致 | ✅ 无问题 |

**结论：6 项澄清均与现有 FR/Constraints 一致，未引入矛盾或新问题。**

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | spec.md — FR-2/FR-4 | **[NEW] "AND 关系"措辞歧义**：「多个 chip 可同时选中（AND 关系）」—— AND 可能被理解为逻辑与（交集过滤），实际意图是"可多选且效果叠加（并集）"。FR 文本与 Resolved Ambiguities 均未澄清这一点 | 改为"可多选，效果叠加"或"多选模式（union）"，消除 AND 的歧义 |
| 2 | LOW | spec.md — AC#9 | **[CARRIED]** "lint 0 errors, 0 warnings" 是开发质量门禁，不是功能验收标准 | 将 AC#9 从功能 AC 中移出，单独列为质量门禁 |
| 3 | LOW | spec.md — Out of Scope | **[CARRIED]** 未提及 keyboard a11y，但 chip/操作行的交互本质是 toggle，Tab + Enter 支持成本极低 | 在 Out of Scope 中显式声明"keyboard a11y 暂不在范围"或纳入 v1 |
| 4 | INFO | — | **[CARRIED]** Tool renderer 集成 gap 已在 spec 中正确标注（❌ Missing），需求本身（FR-4）清晰，plan task 应覆盖 | — |
| 5 | INFO | — | **[CARRIED]** 验证/测试归属应在 plan 中明确 | — |

> 无 MUST_FIX 问题。所有问题均为 LOW/INFO 级别。

### 等级判定理由

- **#1 AND 关系措辞**：虽然存在歧义，但从上下文（chip 是不同操作类型的分类标签）可合理推断意图是"多选叠加"而非"交集过滤"。实际开发中不太可能误解为交集。标 LOW。
- **#2-#5**：延续 v1 的 OBSERVATION 判定，未升级为 MUST_FIX，因为不影响功能正确性。

### 结论

**PASS** — Spec 完整性检查通过，6 项新增澄清内容与 FR/Constraints 保持一致，无 MUST_FIX 问题。

### Summary

Spec review v2 增量审查完成，第 2 轮通过，0 条 MUST_FIX。
