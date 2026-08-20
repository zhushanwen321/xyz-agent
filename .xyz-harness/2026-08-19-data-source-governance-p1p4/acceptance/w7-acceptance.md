# W7 验收标准：label / thinkingLevel / modelId 三实例 + 失效接线

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §3 W7 节（L257-285）是 W7 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W6（ReplicatedState 原语已 committed）。

## 目标（一句话）

label、thinkingLevel、modelId 三类标量状态由三个 `ReplicatedState` 配置实例持有，pi 事件（session_info_changed / thinking_level_changed）与 switchModel RPC 响应只做失效（markDirty），快照来自 `get_state`。

## 交付物

1. `packages/runtime/src/services/session/replicated-states.config.ts` [新增]：3 个配置条目（每条 = 登记表条目的代码化）
2. `packages/runtime/src/services/session/session-service.ts`（修改：实例注册、switchModel 响应后 markDirty、get_state 快照拉取接线）
3. `packages/runtime/src/services/session/event-interpreter.ts`（修改：session_info_changed / thinking_level_changed 处理改为实例 markDirty——现状 L87 附近回写 sessionMetaCache，回写点本 wave 保留、W9 删；翻译输出广播形态维持现状 type 名，W12 统一切 state 话题）
4. `packages/runtime/src/index.ts`（修改：L298 附近 sessionMetaCache.setLabel 直写点，改读实例）
5. equivalence 测试新增用例（W5 骨架挂载：发 session_info_changed 后实例值最终与 get_state 一致）

## 配置条目锁定（plan W7 步骤 1）

- **label**：fetch = `get_state().sessionName`；失效源 = `session_info_changed`；空值语义 = sessionName 缺失 = 未命名 = 覆盖（label 与 sessionName 同一数据链，无独立可守卫语义——D1b 归一）
- **thinkingLevel**：fetch = `get_state().thinkingLevel`；失效源 = `thinking_level_changed`（pi 同档位切换不发射事件——session-service.ts:450 既有记录——**配置周期兜底 `pollIntervalMs: 30_000`**）
- **modelId**：fetch = `get_state().modelId`；失效源 = switchModel RPC 响应（RPC 响应驱动是「事件只做失效」的补充合法形态，D7 登记）

## 关键边界

- 本 wave 是**双写过渡**：实例与旧缓存（sessionMetaCache 等）并存，读方逐步切实例；旧缓存删除在 W9。
- RPC 频率采样（plan W7 验收 4，P0.5② 首次采样）：测试中记录典型操作序列（3 轮对话 + 1 次切模型）触发的 get_state RPC 次数与 p95 延迟——**数字写进 builder 汇报（草稿），落登记表由主 agent 串行处理**（防与并行 wave 的登记表改动冲突）；本 wave 只记录不决策。

## 通过命令（builder 自验 + verifier 实跑）

1. 代码级：`grep -n "markDirty" packages/runtime/src/services/session/event-interpreter.ts` ≥2 命中（两事件改失效）；`grep -n "sessionMetaCache.setLabel\|sessionMetaCache.setThinkingLevel" packages/runtime/src/services/session/event-interpreter.ts` 命中数 = 0（interpreter 不再直写缓存——注意 W1 后 setLabel 直写点在 index.ts，interpreter 侧本就无；以实测为准如实记录）
2. `cd packages/runtime && pnpm typecheck && pnpm test` + `cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/` 通过（骨架 + 本 wave 新增用例）
3. 行为级（真实环境部分留 P1 gate）：本 wave 单测层断言 = switchModel 成功后 modelId 实例 markDirty 被调（mock RPC 层）；session_info_changed 到达只 markDirty 不直写
4. 采样数字在汇报中给出

## 禁改清单（越界 = 验收失败）

- 验收权威文档；**登记表（本 wave 禁改——采样数字由主 agent 落表）**
- event-adapter.ts（W18/W21 领地）；message-converter.ts（W20 领地）；extensions/（W16 领地）
- session-meta-cache.ts 本体（W9 删，本 wave 不碰文件本身，只改读写点）
- 禁 git 写操作；禁 any

## 备注

- 完成后解锁 W8（共享 session-service.ts 串行）与 W9。
