# Spec Review — lru-panel-exempt-fix

## 审查方法

禁读重建：派 fresh subagent（agent_dc6c2035），仅给 objective + clarifyRecord（源头信息），不读任何 spec/confirm 文档、不读源码、不读测试文件，从零重建 spec 清单。将重建结果与初稿 specSections diff，差异点即审查发现。

## diff 结果

### 初稿遗漏（重建补出，需补进 spec）

| 重建条目 | 初稿状态 | severity | dimension | 说明 |
|---------|---------|----------|-----------|------|
| streaming/generating/compacting 豁免不回归 AC | 初稿 AC 无显式锁定 | should-fix | completeness | clarify 明确「streaming 态仍豁免」是必须保留语义。初稿 FR-3 + AC-3 间接覆盖（deleteSession 不动 isLruExempt），但 streaming 豁免语义本身的回归保护未独立成条。补 AC-6 显式锁定，防修复时顺手破坏。 |

### 初稿多出（重建未想到，初稿正确，保留）

| 初稿条目 | 重建状态 | 评估 |
|---------|---------|------|
| AC-2 单 panel LRU 基线不退化（最旧被驱逐） | 重建漏 | 保留——防过度保护把 LRU 完全架空，重要的反向验收 |
| AC-4 panel close/unbind 后不再被保护 | 重建漏 | 保留——生命周期边界，确认保护随 panel 解绑自然衰减 |

### 重建与初稿一致（验证通过）

- FR-1/FR-2/FR-3/FR-5 核心功能需求完全对齐
- FR-4 store 隔离（不互 import）初稿虽未独立成条，但「store 间不互 import」隐含在 D1 + background + 方案 C 描述中，可保留隐式
- D1 决策（方案 C vs 方案 A）完全一致
- complexity=low 一致
- outOfScope 范围一致

## nit（不进 issues，仅记录）

1. 初稿 FR 按「需求粒度」分（FR-1 保护、FR-2 注释、FR-3 deleteSession），重建按「实现约束粒度」分（FR-1 selectSession 编排、FR-2 覆盖 standby、FR-3 不改 isLruExempt、FR-4 store 隔离、FR-5 注释）。两者覆盖等价，初稿粒度更简洁，保留初稿。

## 审查结论

spec 就绪进 plan。1 个 should-fix（补 AC-6 streaming 豁免回归）需在 tdd_plan 阶段补进 test.json，不影响 plan 结构。无 must-fix。
