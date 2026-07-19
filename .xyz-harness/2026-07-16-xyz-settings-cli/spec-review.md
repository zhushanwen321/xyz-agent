# Spec Review: xyz-settings-cli

## 审查范围

禁读重建：从 objective + 7 条 clarifyRecords 重建 FR/AC 清单，与初稿 specSections diff。

## Diff 结果

初稿 10 条 FR 与重建结果基本对齐。发现 1 个 should-fix 问题：

| # | severity | dimension | description | ref |
|---|----------|-----------|-------------|-----|
| 1 | should-fix | consistency | CL7 明确说 Phase 1 做 5 个命令验证链路、Phase 2 补全。但 FR-8（空闲时 reload）、FR-9（apiKey 安全）、FR-10（tsup 打包）是 Phase 2 的功能，却和 Phase 1 的 FR-1~FR-7 混在同一个 spec 里，没有分层标注。建议给 FR 标注所属 Phase，让 plan 阶段能按 Phase 拆 wave。 | FR-8/9/10 |

## 无 must-fix 问题

- objective 的每个诉求都有 FR 覆盖（progressive disclosure → FR-7, 代码复用 → FR-2/10, 实时生效 → FR-8, skill 路径 → FR-7）
- 7 条 clarifyRecords 的结论全部沉淀进 spec（CL1→FR-7, CL2→FR-1/2, CL3→FR-10, CL4→FR-7, CL5→FR-8, CL6→FR-10, CL7→分层）
- 术语一致（CLI/runtime/ConfigService/skill）

## 审查结论

Spec 就绪进 plan。1 个 should-fix 问题在 plan 阶段拆 wave 时解决（给 FR 标注 Phase）。
