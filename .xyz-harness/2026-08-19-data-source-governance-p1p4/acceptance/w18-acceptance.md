# W18 验收标准：runtime 消费管线（entry_appended + get_entries 增量 + extractor 降级）

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §5 W18 节（L567-593）是 W18 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W12（包装实例就位）、W16、W17（均已 committed）。**调度警戒：W21 committed 后才可派发**（同碰 event-adapter.ts——W21 已先完成，entry_appended 段归本 wave）。

## 目标（一句话）

runtime 侧 subagent/workflow 数据消费切换为「entry_appended 失效 → get_entries(since) 增量重拉 → 纯派生缓存」，实时与重开走同一份扫描代码（模式 2 双管线消亡，D4）。

## 交付物

1. `packages/runtime/src/infra/pi/event-adapter.ts`（修改：`entry_appended` 移出 NULL_EVENTS（W21 已留 TODO(W18) 锚点），新增翻译 handler 携带 customType 过滤——只对 `subagent-record` / `workflow-record` 触发失效，其他 custom type no-op）
2. `packages/runtime/src/services/session/event-interpreter.ts`（修改：subagentRecords Map 改纯派生缓存——唯一写方 = entry 扫描；entry_appended 到达 → 对应包装实例 markDirty → 防抖增量拉取）
3. `packages/runtime/src/services/session/session-service.ts`（修改：getEntries(since) 增量拉取编排——per-session cursor（最后已拉 entryId）；游标失效（RPC 错误）退化为全量重拉自愈）
4. `packages/runtime/src/services/session/subagent-extractor.ts` + `workflow-extractor.ts`（修改：重构为 entry 扫描器，导出 `scanSubagentEntries(entries)` / `scanWorkflowEntries(entries)`——实时增量与冷启动全量都调它；旧双管线解析路径的实时侧内联份删除；extractor 标注 legacy 降级为冷启动旧 session（无自描述 entry）兜底——先扫自描述 customType 无命中再走旧解析）
5. equivalence 混沌用例（场景 5 收尾）：丢失 entry_appended 广播 → 防抖/兜底重拉后状态收敛

## 通过命令（builder 自验 + verifier 实跑）

1. `grep -A3 "NULL_EVENTS = " event-adapter.ts` 无 entry_appended；`grep -n "scanSubagentEntries\|scanWorkflowEntries"` 两 extractor 各 ≥1 命中
2. `cd packages/runtime && pnpm typecheck && pnpm test` + equivalence 全绿
3. 行为级（场景 5：四处一致 + JSONL 自描述 entry）留 P3 gate；单测层：增量拉取/游标失效全量自愈/legacy 兜底用例
4. 回归：`grep -rn "getSubagents" packages/runtime/src` 手动刷新 RPC 路径仍可用；旧 session（无自描述 entry）重开列表仍可显示（legacy 兜底用例）

## 禁改清单

- 验收权威文档；登记表（W12-W18 过渡例外撤销的草稿制）；W21 领地（message_end 段/core chat 域——entry_appended 段是本 wave 领地）；extensions（W16/W17 已 committed 禁改）；六实例配置
- 禁 git 写操作；禁 any；禁 mock pi（混沌用例真实 fixture 或 mock RPC 层）

## 备注

- 完成后撤销登记表 #8/#9 的 W12-W18 过渡例外 + W23 解锁。
