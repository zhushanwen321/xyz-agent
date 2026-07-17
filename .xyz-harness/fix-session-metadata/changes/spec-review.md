# Spec Review: fix-session-metadata

## 审查方法

禁读重建：派 fresh subagent 从 objective + clarifyRecords 重建 FR/AC/决策，与初稿 diff。

## 重建结果

重建产出 FR-1~FR-6（6 条功能需求）、AC-1~AC-10（10 条验收标准）、D1~D5（5 条决策）、outOfScope（5 项）。

## Diff 分析

初稿为 clarify records（CL1 sidecar 方案 + CL2 重命名方案），未展开为结构化 FR/AC。重建结果覆盖了所有 clarify 结论，无遗漏。

### 发现的问题

| # | severity | dimension | 描述 | ref |
|---|----------|-----------|------|-----|
| SR1 | should-fix | consistency | AC-2 字段名 `sessionOutcome` 与实际实现 `outcome`（SessionOutcome 类型）不一致，需修正为 `outcome` | AC-2 |
| SR2 | should-fix | reasonableness | AC-7 的 grep 验收条件过于宽泛——`session.list` 在 store 属性引用（session.list.length）和注释中仍存在，grep 会误报。应限定为 WS 协议字面量 grep，或改为 TypeScript 编译检查（类型系统已约束） | AC-7 |

### 审查结论

无 must-fix。2 个 should-fix 可在 plan/dev 阶段修正。spec 就绪，可进 plan。
