# Spec Review: message-content-segments

## 审查方法

采用"禁读重建"：派 fresh subagent 不读 specSections/confirmSpec，只从 objective + clarifyRecord 重建应有 FR/AC，与初稿 diff 找遗漏。

## 重建 diff 结果

初稿 6 个 FR，重建 8 个 FR。差异：

| 条目 | 初稿 | 重建 | 处理 |
|------|------|------|------|
| findPendingIndex 适配 | 未提及 | FR-5 独立列出 | **must-fix**：补入 spec |
| 归一化函数 | FR-6 segmentsToText | FR-7 normalizeUserContent 统一 string\|Segment[] | should-fix：命名统一为 segmentsToText + 扩展处理联合类型 |
| AC | 完全缺失 | 25+ 个 AC | **must-fix**：补 AC |
| session-history 路径缺口 | FR-4 称"两条路径都解析" | 重建怀疑 JSONL 路径有独立缺口 | **已排除**：验证 session-history.ts:85 调 convertPiHistory，两条路径共用同一解析函数，无独立缺口 |
| chip DOM data 属性 | FR-2 未提 | 重建指出需补 data-skill-name/data-skill-location | should-fix：FR-2 补充 data 属性要求 |
| 空格问题修复 | 未作为 AC | AC-2.4 显式断言空格修复 | should-fix：补 AC 显式防回归 |

## 审查结论

spec 整体方向正确，但有 2 个 must-fix（pending 匹配遗漏 + AC 缺失）和 3 个 should-fix。修复后可进 plan。

## Issues

| ID | severity | dimension | description | ref |
|----|----------|-----------|-------------|-----|
| SR1 | must-fix | completeness | 遗漏 findPendingIndex 适配：content 改 Segment[] 后 m.content===text 匹配断裂，steer/followUp pending→complete 投递会卡住 | FR |
| SR2 | must-fix | completeness | 完全缺失 AC：plan 阶段需 AC 做 tdd_plan 映射，无 AC 无法验收 | AC |
| SR3 | should-fix | reasonableness | FR-2 未提 chip DOM data 属性：getSegmentsFromEl 需从 data-skill-name/data-skill-location 重建 skill segment，当前 insertSlashChip 不存这些属性 | FR-2 |
| SR4 | should-fix | reasonableness | 归一化函数命名/职责：segmentsToText 只处理 Segment[]，但消费点收到的是 string\|Segment[] 联合类型，需统一处理函数 | FR-6 |
| SR5 | should-fix | reasonableness | 空格问题修复无显式 AC：/skill:name 与用户文字间空格是核心 bug，应有 AC 显式断言防回归 | AC |
