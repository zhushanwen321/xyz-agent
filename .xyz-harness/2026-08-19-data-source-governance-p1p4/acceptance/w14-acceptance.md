# W14 验收标准：pendingBuffer 计数 FIFO

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §4 W14 节（L465-488）是 W14 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W8、W12。与 W13 可并行（不同文件）——但若 W13 并行中，core domain/session 与 domain/chat 领地分界遵守。

## 目标（一句话）

queue 内容的投递定位从「文本相等匹配」改为「计数 FIFO」——queue_update 差集算出被投递条数，按条数顺序取 segments（D1 表末行 + D6）。

## 交付物（实际位置：core 包 chat store，renderer 是薄壳——附录 A #3/#4）

1. `packages/core/src/domain/chat/store.ts`（修改：新增 `drainN(sessionId, sendMode, n): Segment[][]`——按 pendingBuffer 入队顺序取前 n 条 FIFO；drainPending 的 `normalizeContent(text).trim() === target` 文本匹配删除；abortPending 保留文本匹配（RPC 失败回滚有准确原文，renderer 自己的提交——登记表 D6 条目标注此差异））
2. `packages/core/src/domain/chat/effects/registry.ts`（修改：queue_update effect（L508 附近）——countDrained（L65-84 已有 [B1] 计数差集）返回数组的 length 为 N 调 drainN；深度对账 = pendingMessageCount，偏差则全量重对（D6：深度结构性对账））
3. `packages/core/src/domain/chat/__tests__/` 用例

## 核心回归用例（plan W14 步骤 3）

- 相同文本多次提交（['A','A'] drain 1 条）取最早一条
- **展开后文本 ≠ 提交原文**（skill 展开——pi 入队存展开后文本，父文档 D6 核实）时仍能按条数取出（文本匹配在此场景必挂、计数 FIFO 必过——本 wave 核心回归用例）
- 深度对账：pendingBuffer 与 pendingMessageCount 偏差 1（模拟扩展注入例外）→ 下一次 queue_update 到达后偏差收敛

## 通过命令（builder 自验 + verifier 实跑）

1. `grep -n "findIndex" store.ts` 在 drainPending 相关命中 = 0 或函数已删；`grep -n "drainN" registry.ts` ≥1；`cd packages/core && pnpm typecheck && pnpm test` 通过
2. renderer 生产代码无直接依赖：`grep -rn "drainPending" packages/renderer/src | grep -v __tests__ | grep -v api/mock` 命中 = 0（r3 实测要求带过滤）
3. 行为级（steer skill 命令消息不丢）留 P2 gate；单测层三组核心回归用例绿

## 禁改清单

- 验收权威文档；登记表（D6 差异标注草稿制）；W13 领地（core domain/session）；runtime（W8 已交付 queue 实例禁改）；chat store 其余入口（W21 已交付 applyMessageEvent 链）
- 禁 git 写操作；禁 any

## 备注

- 完成后 P2 剩 W15。
