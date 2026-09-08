# TODO: subagent-core ①级 native reader 空视图判空降级（defined-empty 不降级②③级）

> 创建：2026-09-08。来源：subagent-drawer-blank 设计 §11 ⛔3（R2 终审 SUGGESTION 采纳）——原登记「实施期向 core 维护方登记 follow-up」未产生可追踪物，交付后对抗式总审查出，补登落账。状态：**已实现（2026-09-09，与 subagent-nonpi-terminal-reload 同批提前实施）**——设计 `docs/design/subagent-nonpi-visibility-followups.md`（任务 B，双 reviewer 两轮对抗审查 0 must-fix），实现 commit b329d4149（core 编排层①级判空降级，设计 D3；runtime 契约钉子 + core 降级矩阵测试），Gate A 全量绿 + Gate B S6/S7 真机验证非空壳（7/7 次派发无「仅 task」形态）。**§4 收敛方向剩余半（③级合成推广到 pi `!sessionFile`，session-records.ts:316）仍未做**，保持登记。
> 优先级：中高——非 pi mid-run 详情页退化为仅 task，**摘要卡等其他③级消费方无兜底同受影响**；drawer 表面的症状已被 renderer seed + 思考行兜住（drawer-blank 修复），但缺陷本体在 core 读取链，按消费方各自兜底不可持续。

## 1. 问题现象

非 pi（zcode 等）引擎 subagent 运行中的窗口 B（create 应答已回填 engineHandle、首个 assistant content 尚未持久化），任何走 `readSubagentHistoryMessages` 的消费方：

- runtime 读链①级 native reader 返回 defined-but-empty 视图（`turns: []`），编排层 `native !== undefined` 即返回——**不判空、不降级②③级**（`packages/subagent-core/src/execution/engine/common/session-view-service.ts:496`）。
- 投影层 `turnsToMessages` 虽前置 push record.task（同文件 :362-369，task 非空时恒非空），但**无占位/结果 assistant**——③级 `outcomeOnlyMessages`「详情页至少有 task/结果」的设计意图（:431 注释）在该窗口失效，消费方只拿到 task 一条。
- 受影响面：drawer 历史读取（症状层已由 `docs/design/subagent-drawer-blank.md` 的 renderer seed + 思考行兜住，见该设计 §5.1 窗口 B）；**摘要卡数据源等其他③级消费方同受影响且无兜底**。

## 2. 证据链（R2 终审 + R3 终验逐点源码核验，2026-09-08 复核锚点仍有效）

1. `collectTurns` 排除 user 消息（`packages/subagent-core/src/execution/engine/engines/zcode/reader.ts:289`，注释「user 消息（任务 prompt）不进 turns」:293）——send 后、首个 assistant content 持久化前 turns 恒 `[]`。
2. `buildView` 对零消息 session 正常返回 `{ turns: [], source: 'native' }`，不抛错（reader.ts:307）。
3. 编排层 `if (native !== undefined) return sessionViewToMessages(native, record)`（session-view-service.ts:496）——defined 即返回，无内容检查、不降级。
4. engineHandle 运行中回填落盘（`packages/subagent-core/src/execution/subagent-service.ts:2156` backfillEngineHandle + `record-store.ts:557` reportRecordTransition）——mid-run record 恰好携带①级钥匙，窗口与本缺陷重合。

## 3. 修复方向

①级返回前判空降级：native 视图 turns 为空（或投影后除 task 前置外无任何实质内容）时视为不可用，降级②级（journal replay）→ ③级（`outcomeOnlyMessages` 恒非空，:431）。改动 = 编排层一处判空 + 单测矩阵（空视图降级 / 非空不降级 / ②级亦空落③级）。

## 4. 收敛方向（架构层，建议一并评估）

「已知 record 的读链**永不返回空数组**」应成为 runtime 协议层不变量：本缺陷修复 + ③级合成推广到 pi `!sessionFile` 窗口（`packages/runtime/src/services/session/session-records.ts:316`）。落地后 renderer 两层客户端兜底（outcome 投影 U4 A8 / drawer-blank task seed）守卫恒假、自然死代码化——见 `docs/design/subagent-drawer-blank.md` §6.7。

## 5. 验收标准

1. zcode subagent 窗口 B 调 `session.getSubagentHistory`：返回③级投影（task + 占位/结果 assistant），不再是仅 task 的①级空视图投影。
2. 窗口 C 真实内容持久化后：①级正常返回真实内容，无误降级（非空视图行为逐字不变）。
3. 摘要卡等③级消费方在同一窗口获得一致的非空结果。
4. subagent-core 全量测试绿 + 新增判空降级矩阵用例绿。

## 6. 关联

- 登记来源：`docs/design/subagent-drawer-blank.md` §11 ⛔3；R2 终审 SUGGESTION（`subagent-drawer-blank.review.md` Round 2，反例本体）
- 症状层修复：fix-subagent-drawer-blank 分支（renderer seed + 思考行，commit 4000fe668 / 3bfe6069a）
- 相邻缺口：`docs/todo/subagent-nonpi-terminal-reload.md`（非 pi 终态不回填，drawer-blank 设计 §5.1 变体末互链）

## 7. 排期评估（2026-09-08，drawer-blank 交付后总审待办 #2）

- **优先级：中高**。改动面小（编排层一处判空降级 + 单测矩阵三用例），但影响面含摘要卡数据源（无兜底同受影响），且是设计 §6.7「runtime 读链对已知 record 永不返回空」协议层不变量收敛的第一步——落地后 renderer 两层客户端兑底（outcome 投影 / task seed）守卫恒假、自然死代码化。
- **建议排期**：与 `subagent-nonpi-terminal-reload.md` 同批或紧随（同一 core 读取链主题，验收环境相同）；由 subagent-core 维护方排期，不阻塞 drawer-blank 分支合并。
