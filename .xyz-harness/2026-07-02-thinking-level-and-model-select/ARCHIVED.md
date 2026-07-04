# Archived: 2026-07-02-thinking-level-and-model-select

思考等级映射 key/value 语义对齐 pi + landing 态模型选择联动修复。事后追溯（代码已实施 commit 2a117341/607d19f6/3bbe3399）。

## 沉淀去向

| 源 deliverable | 目标文档 | 内容 |
|---------------|---------|------|
| §nfr N2 | NFR.md S-9 | thinkingLevelMap 按 key 判定可用档位 |
| §nfr N3 | NFR.md S-10 | useThinkingLevelSync watch immediate |
| §nfr N4 | NFR.md S-11 | popover 只渲染可用档位 |
| §decisions D1/D4 | docs/adr/0001 | key-based 判定 + watch immediate |
| §execution | TEST-STRATEGY.md §4 | 切模型后思考等级自动重置基线用例 |

## 未沉淀（[UNVERIFIED]）

- §nfr N1（前端直接发 key 不做 value 映射）：代码实际发 value（`resolveThinkingValue`），与 N1 约束不符。记 closeout-report 待补。

## 保留文件

- decisions.md（决策审计链，5 条决策 D1-D5）
