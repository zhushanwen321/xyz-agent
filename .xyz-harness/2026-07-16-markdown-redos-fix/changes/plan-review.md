# Plan Review: markdown-redos-fix

## 审查范围

plan 为单 Wave（W1）单文件（markdown.ts）结构，改动高度内聚。因 FR 数量少（4 条）且映射关系直接，采用主 agent 自审（禁读重建对单 Wave 任务 diff 价值低，4 个 FR 到 changes 的映射一目了然）。

按 coverage / architecture / feasibility 三维度审查。

## FR 覆盖映射

| FR | 落地 change | 验证 |
|----|------------|------|
| FR-1 消除回溯 | change 1（FILEPATH_RE 线性化）+ change 2（BASENAME_RE 线性化） | AC-1/AC-7 性能断言 + AC-9 静态结构断言 |
| FR-2 含分隔符路径识别 | change 1（保留前瞻/边界符/可选前缀/无扩展名） | AC-3/AC-4 识别断言 |
| FR-3 裸 basename 识别 | change 2（BASENAME_RE 同构修复） | AC-3 basename 子断言 |
| FR-4 误识别防御 | change 1（保留扩展名前瞻） | AC-5 误识别断言 |

4 个 FR 全覆盖。AC 验收路径在 tdd_plan 的 test.json 留出。

## 架构合理性

- 单 Wave 单文件：改动集中，无跨文件耦合，不需拆分
- 无 dependsOn：W1 无前置依赖
- changes 粒度：三条 changes 分别对应两条正则 + 注释，职责清晰不混淆

## 可行性

三条 changes 均可在一个 dev cycle 完成，无未识别的外部依赖（纯前端 TS 文件，vitest 可直接跑）。

## 审查结论

plan 就绪进 tdd_plan。无 must-fix，无 should-fix。
