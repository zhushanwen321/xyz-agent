# W8 验收报告（verifier 对抗式独立验收）

> 验收对象：usage / queue 深度 / commands 三实例 + 失效接线 + RPC 频率量化收口
> 基线 commit：`ebc6f6991`（W7，w8-acceptance.md 随该 commit 入库）
> 规格 SSOT：`docs/architecture/data-source-governance-plan.md` §3 W8 节（L287-313）
> 验收日期：2026-08-19 · verifier 独立实跑，builder 自报一律待证实

## 总结论：**PASS**（附 2 个 minor 观察项 + 1 个 wave 切片遗留，均不阻塞）

---

## 1. 防篡改

| 项 | 结果 |
|---|---|
| `git diff ebc6f6991 -- .xyz-harness/.../w8-acceptance.md` | **空** |
| `git diff ebc6f6991 -- docs/architecture/data-source-governance-plan.md` | **空** |
| w8-acceptance.md sha256 | `63755d47ea8926b58afea36e7fe9930daa30424054d2d323e5d95c5a7522aad9`（= 基线 `git show ebc6f6991:...` 同值） |
| plan sha256 | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4`（= 基线同值） |
| 越界扫描（`git status --porcelain`） | 改动 = W8 五文件 + W17 四文件（extensions/subagent-workflow，豁免）。无其他越界；pnpm-lock.yaml 干净（主 agent 已还原）；replicated-state.ts（W6 领地）零改动 |
| 基线后 commit | `b8db5afe7` 为主 agent 预置 W9/W10 验收基线（+2 新文件），未触碰 W8 面。builder 无 git 写操作 |

**event-adapter.ts 段级核验（W18/W21 领地警戒线）**：`git diff ebc6f6991` 仅 1 个 hunk——`handleQueueUpdate`（L612 注释块 + L631 payload 增 `pendingMessageCount: event.steering.length + event.followUp.length`）。`NULL_EVENTS`（含 entry_appended / message_end，L735 区域）与 DISPATCHER 注册表零改动；全文件其余部分与基线字节一致。plan 所指 L736 = DISPATCHER.set('queue_update') 注册行（无需改）。**段级警戒线完好。**

## 2. 命令实跑（verifier 复跑）

| 通过命令 | 结果 |
|---|---|
| `grep -c "markDirty" session-service.ts` | **15**（≥4 过）。实际调用 6 处：L527 modelId（W7）、L531 usage@switchModel、L915 usage@applyContextUpdate、L1246 queue@send 闭包、L1465 commands@getCommands、L1509 usage@fetchContext；余 9 处为注释 |
| `grep -n "get_session_stats\|get_commands\|pendingMessageCount" replicated-states.config.ts` | **全命中**（L23/29/32/74/110-112/189/199/202/220/227/254/277 等） |
| `pnpm typecheck`（packages/runtime） | **通过**（exit 0） |
| `pnpm test`（packages/runtime） | **270 文件 / 3131 用例全绿**（与 builder 自报 3131 一致） |
| equivalence 目录 | **3 文件 / 14 用例全绿**（live-reload 1 + W7 scalar 6 + W8 新增 7 = mock 5 + 真实 pi 2） |
| `grep -n "inputTokens" session-service.ts` 回归 | 改后 **28** = 改前基线 **28**（不增，事件路径无新增直写） |
| 新增行禁 any | diff 新增行中 `: any` / `as any` / `<any>` 零命中 |

## 3. 真实性抽查

1. **usage 三失效源汇聚 applyContextUpdate（设计关键）——链路逐段读码证实**：
   - interpreter `turn-usage`（turn_end 路径，event-interpreter.ts:298）→ `onContextUpdate`
   - interpreter `handleTurnEnd`（agent_end 路径，:469，`if (ev.inputTokens)` 守卫内）→ `onContextUpdate`
   - interpreter compaction 成功估算（:779，`estimatedTokensAfter > 0` 守卫内）→ `onContextUpdate`
   - index.ts:273-278 组合根把 `onContextUpdate` 唯一收敛到 `sessionService.applyContextUpdate`
   - applyContextUpdate:915 首行 `usage.markDirty()`（在 `!inputTokens` 早退守卫**之前**，零值更新也失效）
   - 另两个 usage 失效源独立接线：switchModel L531（contextWindow 随模型变）、fetchContext L1509（restore 拉取）。
2. **queue 失效在 send 闭包识别帧**：`message.queue_update` 全仓唯一构造点 = event-adapter `handleQueueUpdate`（L626）；唯一流经路径 = adapter.attach → translate → interpreter `case 'message'` → `opts.send` → session-service `initializeManagedSession` 内 `send` 闭包（L1245：`msg.type === 'message.queue_update' && sid` → `queue.markDirty()`）。无第二条帧路径。
3. **事件风暴用例断言细节**（usage-queue-commands-invalidation.test.ts it 1）：20 次 markDirty 后 `isDirty()=true` 且 `get()` 不变（失效瞬间不直写）；防抖到期 `fetchStats` 恰被调 **2 次**（播种 1 + 风暴聚合 1）；收敛后 `isDirty()=false`；tokens=null 投空快照保持旧值。真实 pi 用例（it 6）刻意丢弃 turn 事件制造失真窗口，风暴后终态逐字段对照**此刻新拉的**权威 `get_session_stats` 投影（含同式 `Math.min(Math.round(percent ?? 0), 100)`）。
4. **W7 minor 修复**：scalar-state-invalidation.test.ts `makeState` model 形态 `{ id: 'test-model', provider: 'test-provider' }`（原 `{ id: 'test-provider/test-model' }` 缺 provider）——修复后 W7 六用例本轮全绿（复跑证实）。
5. **rpc-client 真实方法**：`getCommands()`（rpc-client.ts:585，归一返回数组）、`getSessionStats()`（:592，返回 `msg.data ?? {}`）与 config 的 Array/Object 断言吻合；端口 IPiEngine L166/168 已声明。

## 4. 行为对抗抽查（3 条，全部执行）

1. **红性验证**：临时把 applyContextUpdate 的 `usage.markDirty()`（L915）改回旧缓存直写 → 接线用例**红**（`expected "markDirty" to be called 1 times, but got 0 times`）→ 从备份字节还原，sha256 复核一致（`2bae8522...`），diff 恢复 110 insertions/25 deletions。**用例确有抓回归能力。**
2. **pendingMessageCount 公式独立核实（读 pi-mono 源码）**：`agent-session.ts:1428-1430` `get pendingMessageCount() { return this._steeringMessages.length + this._followUpMessages.length }`；`rpc-mode.ts:455` get_state 透出同值；`agent-session.ts:503-509` `_emitQueueUpdate` payload 就是这两数组的拷贝。event-adapter 的 `steering.length + followUp.length` **与 pi 同源，公式正确**（事件发射时刻值）。
3. **ServerMessageMap 联合类型探针**（临时探针文件，已删 + typecheck 复跑干净）：
   - 正例：宽泛型 `ServerMessage` 构造 queue_update payload 附 `pendingMessageCount: number` **编译通过**（联合含 `Record<string, unknown>` 兜底成员）——builder 自报属实；
   - 负例：`type: 'message.bogus_never_exists'` **TS2322 拒绝**——类型安全未被破坏；
   - 附加发现（见 minor-1）：消费侧窄化 `ServerMessage<'message.queue_update'>` 读 `pendingMessageCount` 报 **TS2353**。

## 5. 三项裁决

**① 三处接线落法——无绕过，裁决通过。**
- usage 汇聚 applyContextUpdate：三事件路径在 interpreter 内本就汇成 onContextUpdate 回调，index.ts 组合根已唯一收敛到该方法（单一 owner，注释明示），在此 markDirty = 失效信号随既有数据链汇聚，不新增散落写点。旧缓存直写保留 = plan W7 步骤 4 / W8 验收项 2 明示的双写过渡（W10 收编删），不构成绕过。
- queue 在 send 闭包：帧构造点唯一 + 流经路径唯一，识别后仅 markDirty，payload 永不直写深度（D6 遵守）。
- commands 在 getCommands：renderer RPC（session-message-handler.ts:376）与激活发布（fetchAndBroadcastCommands → session-service.ts:1474）两路径全部经此汇聚，查询即失效，无遗漏调用路径。
- 第二写路径排查：replicated-state.ts 无公开数据写 API（数据唯一入口 = fetch→apply 快照链，W6 本体零改动）；全仓 markDirty 调用分布 = interpreter 2（W7 label/thinkingLevel）+ session-service 6，无残留直写实例路径。

**② 量化终判——支持「无需降级」。**
verifier 实跑 W8 采样：合计 **7 次**快照 RPC（get_session_stats 3 + get_state 2 + get_commands 2），合并 **p95 0.7ms**、max 0.7ms；W7 采样复跑 5 次 p95 0.4ms。操作序列（2 轮对话 + 失效风暴）RPC 个位数、延迟亚毫秒级，远低于 UI 可感知阈值，无队列堆积迹象。builder 自报 p95 1.7ms 与 verifier 复跑 0.7ms 为计时方差，「7 次」计数一致，结论同向。**结论：已量化，无感知，无需降级**（登记表落字归主 agent）。

**③ 接口改名——完成。**
`ScalarReplicatedStates` 类型名全仓零残留；`SessionReplicatedStates` 六字段齐备（label/thinkingLevel/modelId/usage/queue/commands），注册 / dispose / 幂等重注册三处同步。方法名 `getScalarReplicatedStates` 保留（diff 注释明示理由：组合根接线稳定），方法名/类型名不一致已文档化，可接受。

## 6. 观察项（不阻塞 PASS）

- **minor-1（wave 切片遗留）**：`packages/shared/src/protocol.ts:1149` 的 `'message.queue_update'` payload 契约未声明 `pendingMessageCount`。runtime 已在线上发射该字段（运行时正确），但 renderer 窄化类型读它会 TS2353（探针证实）。W8 允许文件清单不含 shared，builder 不改是对的；需后续 wave（建议 W12 state 话题统一时）补契约，或在首个消费方接入时补。
- **minor-2（边界行为）**：usage config 注释称「contextUsage 恒在」，但 pi `agent-session.ts:3007-3012` `getContextUsage()` 在 `!model` 或 `contextWindow <= 0` 时返回 undefined → 此时 `get_session_stats` 无 contextUsage → config 抛 `WireSnapshotSchemaError` 走快照失败退避（而非「无值」空快照）。影响有界（保留旧值 + 退避序列耗尽即停，等下次 markDirty），常规活跃 session 不触发；建议 W10 收编时把「缺 contextUsage」改归无值语义或修正注释。
- **观察**：builder 自报 p95 1.7ms vs verifier 复跑 0.7ms（同结论，纯计时方差，记录备查）。

## 7. 验收条款对照

| 验收标准（w8-acceptance.md） | 结果 |
|---|---|
| 交付物 1-4（config 三条目 / session-service 接线 / event-adapter 仅 queue_update 段 / equivalence 用例） | 全部达成（见 §2-§4） |
| 交付物 5（量化结论写汇报、禁改登记表） | 登记表未被 builder 触碰（越界扫描干净）；量化数字入本报告 §5② |
| 通过命令 1-5 | 全部通过（§2） |
| 禁改清单 | 验收权威文档 / 登记表 / entry_appended 段 / message_end 段 / replicated-state.ts / W16-17 领地 / W20 领地均零触碰；无 git 写操作；无 any |
| 六实例齐备 | label / thinkingLevel / modelId / usage / queue / commands——注册点 registerReplicatedStates 六实例 + 六 refetch 播种，销毁点 removeSessionEntry 六 dispose |
