# W17 验收标准：workflow 自描述记录收敛

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §5 W17 节（L543-565）是 W17 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W16（同包顺序改造；customType 命名与版本约定沿用 W16 模式）。

## 目标（一句话）

workflow 持久化形态从「state 文件 + workflow-state-link 指针 entry」收敛为自描述完整记录 `workflow-record`（统一 #8/#9 同一形态，D4）；state 文件降级为纯性能缓存（读序 = entry > state 文件 > 空）。

## 交付物

1. `extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts`（修改：L455 现有 `pi.appendEntry("workflow-state-link", ...)` 指针条目改为 append 自描述完整 WorkflowRunRecord（customType `workflow-record`）；run 状态迁移点 append（对齐 W16 迁移点定位法）；重建路径 loadAll/JSONL 重建（L539 现状扫 link）改优先扫 workflow-record，旧 link 兼容读取（优先级低，存量 run 不静默丢失）；版本 guard（D-5 snapshotVersion）对 state 文件保持，entry 重建自带 v1 检查）
2. `extensions/subagent-workflow/src/orchestration/__tests__/jsonl-run-store-session-file.test.ts`（修改：重建路径用例改从自描述 entry 重建 + 旧 link 兼容用例 ≥1 + 新 entry 重建用例 ≥1）
3. 登记表 #9 形态描述更新——**仅 #9 条目，且由主 agent 落表**（builder 汇报中给出更新文案草稿）

## 通过命令（builder 自验 + verifier 实跑）

1. `grep -n "workflow-record" extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts` ≥2 命中；`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连通过
2. 行为级：本地 pi CLI 实测一个 workflow run 生命周期 → JSONL 出现 `workflow-record` 自描述 entry 序列（含终态）；存量 session（含 workflow-state-link entry + state 文件）在新代码下 workflow 列表正常重建（兼容读用例在测试层覆盖；真实存量 session 兼容由 verifier 抽验 fixture）
3. 回归：jsonl-run-store-session-file.test.ts 全绿（新旧两形态用例都在）

## 禁改清单（越界 = 验收失败）

- 验收权威文档；登记表（builder 禁改，文案草稿进汇报）
- extensions/ 其他包与 extensions/shared/；W6/W20 领地（runtime / core）
- **W16 交付物**（record-store.ts / record-entry.ts——发现缺陷上报不擅改）
- 禁 git 写操作；禁 any；[MANDATORY] 本地 pi CLI 实测（同 W16 流程）

## 备注

- 完成后（与 W12 汇合）解锁 W18。
