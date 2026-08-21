# rfl-mp：MP prompt 前缀稳定化（T9，设计文档 §6.9/§9 MP 里程碑）

## 任务背景

同一 reviewer 跨轮的完整 prompt（system 段含 schema 指令 + user 段静态文本）不稳定：reviewerSchema 的 required 在 R1（无 reconciliation）与 R2+/scoped（spread 补 reconciliation）分叉，schema JSON 逐字嵌入 appendSystemPrompt（agent-opts-resolver）→ system 段字节差异 → 消息级缓存前缀失效。前置探针已探明（设计 §11）：主用 provider 消息级缓存命中 97-99%，前缀稳定化收益前提成立；收益边界 = 同一 reviewer 跨轮（批内不同 reviewer 的 system prompt 不同，无法共享）。

设计文档：`docs/todo/review-fix-loop-efficiency/tier-1-cheap-wins.md` §6.9（机制）、§10 T9（任务定义含 v7 连带清单）、§8.2 S9（验收）；细节论证见 tier-2-context-reuse.md §4/§6.1。

## 目标

交付目标 8（prompt 前缀稳定）：
1. reviewerSchema.required 恒含 `reconciliation`（R1 prompt 明示「首轮无前轮对账，返回空数组」）——消除 R1↔R2+ schema 分叉导致的 system 段字节差异。
2. R1/R2+/scoped 三模板共享单一静态段文本来源；变化内容（轮次 header/roundDir/对账数据/fix 结果/dormant 清单/scope 清单）全部后置到 `--- ROUND CONTEXT ---` 动态段起点标记之后。R1 prompt 函数化（buildR1ReviewPrompt 入 utils，脚本内联段移除）。
3. 快照单测守护：三模板产物在动态段起点标记之前逐字节相同。

## 连带改动（v7 审查裁定，随 T9 同批）

- 删除 R2+/scoped 分支的冗余 required spread（review-fix-loop.js 两处 `schema: { ...reviewerSchema, required: [...] }`）。
- 更新 reconciliation 的 stale description（「MANDATORY for R2+ rounds, optional for R1」→ 统一后语义：R1 返回空数组；该文案逐字嵌进 system prompt）。
- reviewer 报告指令加「修复建议」必填列（设计 6.2 第一环——guidance 数据链的 reviewer 侧源头；模板改动归 T9，提取归 M1 已实现）。
- dormant 清单（M1 注入）属动态段内容（位置约束：必须在 ROUND CONTEXT 标记之后）。

## 边界

- 不改 aggregator/fix prompt（它们无跨轮同 reviewer 场景）。
- tools 清单稳定性（pi base system prompt，子进程内存拼装）快照测试物理不可见——由 S9 真实 run 提取路径覆盖（引擎 run store），不在本单元机器验收。
- 缓存命中收益量化（P-cache-benefit）依赖 M0 calls[] 数据，真实 run 后回填（信息级挂账，不在验收）。

## 验收标准

见 spec.json（D1-D4）：schema 统一 + spread 删除、三模板静态段逐字节快照、R1 空数组说明 + 修复建议列、e2e 回归（R1 reconciliation 空数组下游无异常——normalizeReviewResult 本就缺省 []，reconcile 门控行为不变）。
