# W12 验收标准：5 个 state 话题数据源切换为 ReplicatedState 发布

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §3 W12 节（L402-432）是 W12 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W7、W8（六实例就位，均已 committed）。
> **执行纪律：5 话题各独立 commit**（主 agent 保证 commit 粒度——builder 按 5 个阶段交付并在汇报分阶段自验，主 agent 分 5 次 commit）。

## 目标（一句话）

renderer 重连时 stateSnapshot 回放的 last-value 从影子缓存快照变为 owner 快照——「投影一次」不被现有 subscribe/ring 通道架空（D7 补漏裁决：通道复用不重写）。

## 交付物（5 阶段）

- 阶段 1 `session.commands`：session-service.ts（:1323 附近）publish 点数据源切 commands 实例快照
- 阶段 2 `context.update`：session-service.ts（:1378 附近）切 usage 实例快照
- 阶段 3 `session.state_changed`：session-service.ts（:1254 附近）载荷字段全部来自实例快照（modelId/thinkingLevel 等）
- 阶段 4 `session.subagents`：event-interpreter 的 publish 点切**新建包装实例**（写入口 = 现有事件流经单入口写入；W18 再换底层源为 entry 扫描）
- 阶段 5 `session.workflowUpdate`：同上新建包装实例
- 辅助：`transport/session-message-handler.ts` stateSnapshot 组装处（L314-352）确认读实例快照；`services/message-bus/message-bus.ts` 接线说明（**TOPIC_TABLE（L55）/ STATE_TYPE_KEY_MAP（L131）结构不动**——传输层语义）
- **W8 minor 顺带**：`packages/shared/src/protocol.ts` queue_update payload 契约补 `pendingMessageCount: number` 声明（W8 verifier 实锤 renderer 窄化读不到）
- **过渡态例外登记**：阶段 4/5 的「W12-W18 过渡：写入口 = 事件流（已登记例外），W18 起源 = entry 扫描」——builder 交登记表草稿，主 agent 落表（防 S1 review 窗口期误报）

## 通过命令（builder 每阶段自验 + verifier 实跑）

1. 每阶段后 `git show --stat` 为单话题改动（主 agent commit 时验证）；全 5 阶段后 `grep -n "session.commands\|session.state_changed" session-service.ts` 的 publish 全部以实例快照为数据源（人工核对 diff）
2. 等价性断言：每阶段附「切换前后同场景 stateSnapshot 内容一致」断言（W5 fixture 跑操作序列对比）或 mock 层对比断言
3. 回归：`cd packages/runtime && pnpm typecheck && pnpm test` 全量 + equivalence；`packages/core` 的 message-bus 相关测试（subscription-state.test.ts + runtime 侧 message-bus.test.ts）通过；重连 ring 补发行为不变（session-message-handler 既有测试绿）
4. 边界断言：`git diff <本 wave 起点>..HEAD -- packages/runtime/src/services/message-bus/message-bus.ts` 中 TOPIC_TABLE 与 STATE_TYPE_KEY_MAP 无改动
5. 行为级（场景 2 前半收口：断连 30s 重连后六状态与 pi 快照一致）留 P1 gate

## 禁改清单（越界 = 验收失败）

- 验收权威文档；登记表（草稿制）；TOPIC_TABLE / STATE_TYPE_KEY_MAP
- replicated-state.ts 本体；W21 领地（core chat 域 + event-adapter message_end 段——若 W21 并行中）；extensions/
- stream 类话题（message.* / queue_update）ring 语义不动（D7：改动面仅 5 个 state 话题，越界即偏离）
- 禁 git 写操作；禁 any

## 备注

- 完成后解锁 W13/W14（P2）与 W18（与 W17 汇合）。
