# rfl-tier1：review-fix-loop 效率优化 梯队 1（全量仪表与 eval）

## 任务背景

review-fix-loop 是 subagent-workflow extension 的内置 workflow（多批串行 × 批内多轮：并行 review → 聚合 must-fix → fix → 重审直到 clean）。现状是「黑盒循环」：每轮全价、成本与质量不可见、无 eval 手段、clean 终止路径有数据黑洞。

设计文档（权威依据，已过三轮对抗审查裁决可开工）：`docs/todo/review-fix-loop-efficiency/tier-1-cheap-wins.md`（v7）。就绪度审查：同目录 `tier-1-cheap-wins-readiness-review-v6.md`。

## 目标

按设计文档 §2 的 8 个目标交付：全量仪表（calls[] 落 state.json + 持久化到 `~/.review-fix-loop/` + rfl CLI）、轮次归因（origin）、修复指引（guidance）、证据裁决落盘（dormant + 复活通道）、质量打分（4 维度 × 10 分制 + 客观回填权威层 + clean 轮黑洞修复）、aggregator 降档、run 完整性（_runId 稳定）、prompt 前缀稳定化。

## 验收标准

根 unit 不直接持有验收——4 个子 unit（rfl-m0 / rfl-m1 / rfl-m2 / rfl-mp）各自持有可机器验证的验收（详见各 brief）。根 unit 的完成判据 = 4 个子 unit 全部 closed。

设计文档 §8 的真实场景验收（S1 真实 PR 全跑 / S4 故障注入 / S9 run store 提取等）属上线后验证，不在 cw 机器验收范围；机器验收覆盖其可自动化子集（单测 + e2e-mock + CLI smoke）。

## 拆分（依赖顺序）

M0（rfl-m0）→ M1（rfl-m1）→ M2（rfl-m2）→ MP（rfl-mp）。串行执行：M1 依赖 M0 的 calls[] 数据链；MP 的 T9 与 M1 的 T6 同函数（buildR2ReviewPrompt）同文件，必须 T6 之后。
