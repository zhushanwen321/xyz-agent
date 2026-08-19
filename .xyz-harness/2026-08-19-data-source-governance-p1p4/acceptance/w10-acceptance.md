# W10 验收标准：applyContextUpdate 收编 + switchModel 重算入 owner

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §3 W10 节（L343-364）是 W10 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W8（usage 实例就位）。

## 目标（一句话）

usage 的「applyContextUpdate 五写点」收编为 owner 单入口；switchModel 重算改在 owner 内部读自己的快照，inputTokens 竞态从「注释约定」变「结构不可能」（D1 表第 3 行）。

## 交付物

1. `packages/runtime/src/services/session/session-service.ts`（修改：applyContextUpdate（L842 附近）与 switchModel 重算（L467 附近）两块；setInputTokens（L824 附近）删除；五写点处置——turn_end / agent_end / compaction / restore 四点 = usage 实例 markDirty（W8 已接的事件失效保持）；switchModel 重算 = 移入 usage 实例的 merge/fetch 配置内部（owner 内读自己的 contextWindow + 最新快照，外部不得再传 inputTokens 进来））
2. session.inputTokens / tokenCount 字段的直接外部写删除（getInputTokens 读点改读实例快照；sessions Map 内字段迁移为实例持有的派生值）
3. `packages/runtime/src/__tests__/` 竞态回归用例：模拟「switchModel 与 context.update 乱序到达」（fake timers 控制防抖窗口），断言最终 usagePercent 与 get_session_stats 快照一致（结构自愈，不依赖写入顺序）
4. 时序约定注释改写：`grep -n "缓存写入先于" session-service.ts` 命中的注释改写为 owner 结构说明（注释与结构同步，不留过时纪律注释）

## 通过命令（builder 自验 + verifier 实跑）

1. 代码级：`grep -n "setInputTokens\|s.inputTokens =" session-service.ts` 命中 = 0；`grep -n "inputTokens" session-service.ts` 仅剩实例配置内部与注释（逐处人工核对归属）
2. 行为级（3 轮对话切模型用量重算 / 快速连切无闪烁）留 P1 gate；单测层：竞态回归用例绿 + usage 相关既有测试绿
3. `cd packages/runtime && pnpm typecheck && pnpm test` 通过；equivalence 目录通过
4. 注释改写完成（grep 验证旧时序约定注释零残留）

## 禁改清单（越界 = 验收失败）

- 验收权威文档；replicated-state.ts 本体（W6）；replicated-states.config.ts 的 label/thinkingLevel/modelId/queue/commands 条目（W7/W8——usage 条目本 wave 可改）
- session-meta-cache.ts 已删（W9）；extensions/；event-adapter（W18/W21 段）
- 禁 git 写操作；禁 any；竞态用例用 fake timers

## 备注

- 完成后 P1 主链剩 W11、W12。
