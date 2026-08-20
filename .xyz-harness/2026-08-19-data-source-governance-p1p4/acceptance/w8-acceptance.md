# W8 验收标准：usage / queue 深度 / commands 三实例 + 失效接线 + RPC 频率量化收口

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §3 W8 节（L287-313）是 W8 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W6（已 committed）；W7 committed 后串行（共享 session-service.ts / event-interpreter.ts）。

## 目标（一句话）

usage、queue 深度、commands 三类状态也由 ReplicatedState 实例持有（六实例齐备）；RPC 快照频率量化结论收口（P0.5② 终判）。

## 交付物

1. `packages/runtime/src/services/session/replicated-states.config.ts`（修改：补 3 配置条目）
2. `packages/runtime/src/services/session/session-service.ts`（修改：context 相关事件（turn_end/agent_end）与 compaction 的 usage 失效接线；get_session_stats 快照；commands 的 get_commands 快照与失效；queue 深度接线；既有 5 写点中事件路径写点改实例 markDirty——估算类写点本 wave 保留过渡，W10 收编时删）
3. `packages/runtime/src/infra/pi/event-adapter.ts`（修改：**仅 queue_update 翻译段**（L612/L736 附近）输出附深度信息——pendingMessageCount 深度以 get_state 快照为准，queue_update 只做深度失效信号，D6；**禁碰 entry_appended 段（W18 领地）与 message_end 段（W21 领地）**）
4. equivalence 新增用例：事件风暴（模拟丢 context.update）后实例值收敛到 get_session_stats 快照值
5. 量化收口结论写汇报（禁改登记表——主 agent 落表）

## 配置条目锁定（plan W8 步骤 1）

- **usage**：fetch = `get_session_stats().contextUsage`；失效 = context 相关事件（turn_end / agent_end / compaction）；空值 = 无空值语义
- **queue 深度**：fetch = `get_state().pendingMessageCount`；失效 = `queue_update`（深度权威 = pi，D6）
- **commands**：fetch = `get_commands`；失效 = commands 相关广播事件（对齐 session-service.ts:1323 现有发布路径的事件源）
- 已知事实（W7 发现，同样适用）：get_state 的 model 是 Model 对象需投影；get_session_stats 返回结构以 pi 实测为准，投影函数对齐既有 usagePercent 口径。

## RPC 频率量化收口（P0.5② 终判，plan W8 步骤 3）

基于 W7 采样（5 次 / p95 4.9ms）+ 本 wave 采样：若超阈值（UI 可感知卡顿 / RPC 队列堆积）→ 触发失败预案（防抖窗口拉长 / 批量快照 / 仅活跃 session 拉取，按序评估）且**必须上报主 agent 记录决策，不得静默选择**；未超阈值则结论 =「已量化：无感知，无需降级」。结论写汇报，主 agent 落表。

## 通过命令（builder 自验 + verifier 实跑）

1. 代码级：`grep -c "markDirty" packages/runtime/src/services/session/session-service.ts` ≥4（usage 三失效源 + queue/commands）；`grep -n "get_session_stats\|get_commands\|pendingMessageCount" packages/runtime/src/services/session/replicated-states.config.ts` 全命中
2. `cd packages/runtime && pnpm typecheck && pnpm test` + equivalence 目录通过（骨架 + W7 用例 + 本 wave 新增）
3. 行为级（场景 2 前半完整断连自愈）留 P1 gate；单测层：事件风暴丢 context.update 后实例值收敛 get_session_stats 快照
4. 回归：`grep -n "inputTokens" session-service.ts` 命中数较改前不增（事件路径不再新增直写——改前基线自查记录）
5. 量化收口结论在汇报

## 禁改清单（越界 = 验收失败）

- 验收权威文档；登记表（量化数据主 agent 落表）
- event-adapter.ts 的 entry_appended 段与 message_end 段（W18/W21 领地——只许改 queue_update 段）
- replicated-state.ts 本体（W6）；W16/W17 领地（extensions/）；W20 领地（core chat + message-converter）
- 禁 git 写操作；禁 any

## 备注

- 完成后解锁 W9/W10/W12（W11 依赖 W1/W3/W6 已满足可直接排）。
- 六实例齐备 = P1「runtime owner 收敛」过半。
