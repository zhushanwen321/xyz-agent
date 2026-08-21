# rfl-m1：M1 聚合数据链（T5-T6，设计文档 §9 里程碑 M1）

## 任务背景

聚合条目现为 `{id, severity}`（白名单截断，加字段会被 normalizeAggregatorResult 静默丢弃）；R2+ 新发现无归因（regression/new 不分）；adjudication 裁决降级的条目无记录无复活通道（降级即消失）；fixer 拿不到 reviewer 的修复指引（重复侦查）。

设计文档：`docs/todo/review-fix-loop-efficiency/tier-1-cheap-wins.md` §4（数据流）、§6.1（origin 归因）、§6.2（修复指引链）、§6.3（adjudication 落盘，裁决是现实现、只补落盘与复活）、§7.2（schema 规格）。

## 目标

交付目标 2（可归因）+ 3（fixer 免侦查）+ 4（裁决可追踪）：
- T5：aggregatorSchema must_fix_ids 条目扩展为 `{id, severity, files?, evidence?, guidance?, adjudication?}` + 顶层可选 `scores`（M2 消费的 schema 先落）+ `normalizeAggregatorResult` 白名单透传修复（v4 审查发现的断点）+ buildAggregatorPrompt 的 JSON shape 与 adjudication 输出说明更新。
- T6：computeOrigin 纯函数（R2+ 新 issue：files ∩ (lastModifiedFiles ∪ fixImpactFiles) ≠ ∅ → regression，否则 new；files 缺失 → undefined + WARN）+ dormant 落盘（adjudication ∈ {downgraded, unverified} 条目落 `state.dormant[]`，含理由，不占 must_fix 计数）+ buildR2ReviewPrompt 注入 dormant 清单（复活通道，动态段内容）+ guidance/evidence 落 `state.issues[id]`。

## 关键约束

- 条目 `adjudication` 字段随 T5 落地 schema，T6 只消费不改动 schema（m8 归属裁定）。
- 不新增裁决逻辑（6.3：adjudication 段是现实现，deltas 只有结构化输出/落盘/注入三个）。
- downgraded/unverified 条目不进 must_fix_ids 修复队列（与现状「降级到 minor」语义一致）——aggregator prompt 说明。
- reviewer 报告「修复建议」必填列属 T9（模板改动），M1 不动 reviewer 模板。
- 兼容：旧格式 string[] 与 {id, severity} 条目继续可用（e2e 现有用例回归守护）。

## 改动点

`extensions/subagent-workflow/workflows/review-fix-loop.js`（aggregatorSchema / issues 写入 / dormant 状态 / R2+ 归因）+ `review-fix-loop-utils.cjs`（normalizeAggregatorResult / buildAggregatorPrompt / buildR2ReviewPrompt / computeOrigin / recordDormant 纯函数）+ `src/__tests__/review-fix-loop-utils.test.ts` + `src/orchestration/__tests__/review-fix-loop-e2e.test.ts`。

## 验收标准

见 spec.json（B1-B6）：归一化透传（旧实现丢弃=红）、computeOrigin 三分支、dormant 落盘、R2+ prompt 注入、aggregator prompt 更新、e2e 全链路（issues 带 origin/guidance/evidence + dormant 有记录 + R2 prompt 含 dormant 清单）。
