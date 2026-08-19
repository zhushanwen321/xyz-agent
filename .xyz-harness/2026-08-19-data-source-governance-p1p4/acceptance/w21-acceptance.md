# W21 验收标准：实时 feed 喂入（message_end 重构 entry）+ 等价性断言升级

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §5 W21 节（L644-670）是 W21 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W20（reducer 就位）。**执行警戒：与 W18 同碰 event-adapter.ts——W18 与 W21 必须串行（谁先 committed 谁先派发），主 agent 调度保证**。
> **探针定论（禁止重开）**：message entry 不发射 `entry_appended`（父文档 D5：pi 源码唯一发射点 agent-session.ts:2269 仅扩展路径 + W5 实测 25 事件 0 条）——实时 feed 的 message 部分由 `message_end` 等事件重构 entry，**禁止采用「直接订阅 entry_appended 拿 message entry」方案**。

## 目标（一句话）

实时路径与文件重放喂同一个 reducer——实时 feed 由 message_end 等事件重构 entry；`live ≡ reload` 断言升级为 store 级同构（断言不变量而非两个实现的等价）。

## 交付物

1. `packages/runtime/src/infra/pi/event-adapter.ts`（修改：`message_end` / tool_execution_start/end 等事件翻译时**重构出 entry 形态**（字段对齐 pi entry schema：messageId/contentIndex/turnId 等）作为实时 feed 载体——**替换不是并存**；**把 message_end 移出 NULL_EVENTS**（Set 字面量 :712-716 现含 'turn_start','message_end',…——只加 handler 不移出集合则事件被 short-circuit、实时 feed 静默为空，r3/r4 已核正此坑））
2. `packages/core/src/domain/chat/effects/registry.ts`（修改：effect handler 输入从「事件 payload」改为「重构 entry 经 applyEntry 后的 state 增量」——effects 退化为 reducer 薄封装（副作用类如 toast 保留 effect，状态类全走 reducer）；改动量大允许分两 commit：先 message_end 路径后 tool 路径）
3. `packages/core/src/domain/chat/store.ts`（修改：applyMessageEvent 入口内部改喂 reducer）
4. `packages/shared/src/protocol.ts`（修改：message.* payload 类型与 entry 形态同步——协议变更须同步类型）
5. `packages/runtime/src/__tests__/equivalence/live-reload.test.ts`（修改：断言升级为 store 级——实时累积 state == 文件重放 state）

## 核心规格锁定（plan W21 步骤 1-5）

1. 事件→entry 重构映射表：message_end → message entry（含 turnId 分组字段，分组语义归 fix-chat-flow-order，本 wave 只保证字段稳定存在）；tool_execution_start/end → toolCall/toolResult entry；message_update 的 partial content 不进 reducer（临时 UI overlay，entry 提交时丢弃，D5）。
2. 实时链路：message_end 移出 NULL_EVENTS → event-adapter 重构 entry → message-bus（stream 话题 wire 形态不变，payload 换 entry 形态，protocol.ts 类型同步）→ chat store applyMessageEvent → applyEntry。streaming delta 渲染走 overlay（transient 类话题不动，TOPIC_TABLE 不改）。
3. 扩展 entry：entry_appended（W18 接线后）→ 直接构 entry 喂 reducer；若 W18 尚未 committed，本 wave 此子项以「预留接线位 + TODO(W18)」处理，不阻塞主链验收。
4. 等价性断言升级：fixture 跑操作序列（steer + bash + 后台 subagent 完成），断言实时 store 快照 == get_entries 重放喂 reducer 快照（同构断言）；混沌注入（乱序/丢失/重放 message_end）→ state 收敛（reducer 确定性 + 快照对账）。
5. pi 上游未来若补发射 entry_appended：只换喂入源头 reducer 不动——event-adapter 留一行注释锚点，**不写投机代码**。

## 通过命令（builder 自验 + verifier 实跑）

1. 代码级：`grep -n "applyEntry" packages/core/src/domain/chat/store.ts` ≥1；`grep -A3 "NULL_EVENTS = " packages/runtime/src/infra/pi/event-adapter.ts` 输出无 message_end；protocol.ts typecheck 过 = 类型对齐；`CORE_TEST` + `RUNTIME_TEST` + `RENDERER_TEST` 全绿
2. 等价性：`cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` live≡reload 用例断言对象为 store 级快照且通过；混沌注入用例通过
3. 行为级（场景 3 全量——steer + bash + 后台 subagent + 重启对照）留 P3 gate 真实环境；本 wave 单测/等价性层覆盖
4. 回归：streaming 渲染不回归（行为级留 gate，单测层 message-dispatcher 既有测试全绿——命令副作用编排不受影响，规则 #9）

## 禁改清单（越界 = 验收失败）

- 验收权威文档；登记表
- **并行警戒**：W18 未 committed 前本 wave 禁动 event-adapter 的 entry_appended 相关段（仅 message_end 段）；主 agent 调度保证两 wave 串行
- W6/W16 领地；TOPIC_TABLE 与 STATE_TYPE_KEY_MAP（传输层分类不动，越界即 fail——同 W12 边界）
- 禁 git 写操作；禁 mock pi（等价性用真实 fixture）

## 备注

- 完成后解锁 W22（broadcast≡get_state + chaos 全量化）与 W25。
- 这是 P3 最重 wave，允许按 plan 分两 commit（message_end 路径 → tool 路径），但一个 wave 一个 verifier。
