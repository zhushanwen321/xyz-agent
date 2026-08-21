# W20 验收标准：applyEntry reducer 本体 + 文件重放喂入

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §5 W20 节（L618-642）是 W20 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W5（已 committed）。可与 W16-W18 并行；**禁与 W13/W14 并行**（同碰 core domain/chat——本波次无 W13/W14，安全）。

## 目标（一句话）

core 包内单一 `applyEntry(state, entry)` reducer 就位，文件重放路径（getHistory → hydrate）改喂这个 reducer——消息列表 = entry 日志纯函数的第一半（D5）。**本 wave 只收历史/重放侧，实时侧 W21 做**。

## 交付物

1. `packages/core/src/domain/chat/apply-entry.ts` [新增]：`applyEntry(state: ChatViewState, entry: PiEntry): ChatViewState` 纯函数 reducer——转换规则 = 现 message-converter.ts 重放路径的规则迁移/收敛
2. `packages/runtime/src/infra/pi/message-converter.ts`（修改：历史路径 entry → messages 转换改调 core reducer（或经 core 导出函数）——收历史侧；runtime 保留 wire 层职责（RPC reply → entry 列表），派生规则全部进 core reducer，D7 投影一次）
3. `packages/core/src/domain/chat/useChat.ts`（修改：hydrate（L611 `getHistory` 附近）路径接 reducer 产物；getHistory RPC 链不变）
4. `packages/core/src/domain/chat/__tests__/`（新增 reducer 用例）

## 核心规格锁定（plan W20 步骤 1-4）

1. state = `{ messages, queueDepth, subagents, ... }` chat 视图态切片；entry 逐条 apply；**纯函数**（无副作用、无时序依赖——同 entry 序列必得同 state）。
2. 规则迁移源：message-converter.ts 现有 entry 树 → messages 转换逻辑（bash/write/edit 历史静态解析、toolCall 归属等）迁为 reducer 的 entry case。
3. 重放接线：useChat hydrate 消费 getHistory entry 序列逐条 applyEntry 重建（替代现转换路径）。
4. 等价性断言（本 wave 只断言重放侧）：同 entry 序列两次喂入 state 全等（确定性）；**全 entry 类型覆盖**（父文档规则 #9：converter 不丢弃任何 pi entry 类型——每类型 ≥1 用例）。
5. 已知事实（附录 A #10）：`get_messages` RPC 已标 DEAD（rpc-client.ts:511），getHistory 实际走 getEntries entry 树重建——重放路径以此为准。

## 通过命令（builder 自验 + verifier 实跑）

1. `test -f packages/core/src/domain/chat/apply-entry.ts`；`grep -c "case '" packages/core/src/domain/chat/apply-entry.ts` ≥ pi entry 类型数（message/toolCall/toolResult/custom/compaction 等以 pi 协议类型清单为准，逐类型有用例）；`cd packages/core && pnpm typecheck && pnpm test` + `cd packages/runtime && pnpm typecheck && pnpm test` 通过。
2. 行为级（重开半段）：重开含 bash 命令 / 文件改动 / subagent turn 的历史 session 消息流一致——**留 P3 gate 真实环境验收**，本 wave 单测层断言 reducer 输出与旧转换路径输出等价（迁移不改变行为：对既有测试 fixture 的 entry 序列，新路径 messages 与旧路径 messages deep equal——这是本 wave 最重要的回归防线）。
3. 回归：message-converter 既有测试（message-converter-bash.test.ts / message-converter-order.test.ts 等）迁移后全绿或等价断言迁到 reducer 用例（**用例数不减少**——覆盖不许缩水）。

## 禁改清单（越界 = 验收失败）

- 两个验收权威文档；登记表（本 wave 零登记表改动）
- **并行领地**：W6（packages/runtime/src/services/session/ + src/__tests__/replicated-state*）、W16（extensions/）一律不碰
- event-adapter.ts（实时侧 = W21 领地，本 wave 禁碰——只动 message-converter 历史路径）
- equivalence/live-reload.test.ts（W21 升级断言对象，本 wave 不动）
- 禁 git 写操作；禁 mock 框架（真实数据 fixture）；禁 any

## 备注

- 完成后解锁 W21（实时 feed 喂入）。W20 与 W21 是 P3 最重的两波，若 builder 发现 reducer 迁移规模超单会话预算，停下上报拆分方案（plan 允许按 entry 类型分批 commit），不得压缩测试覆盖。
