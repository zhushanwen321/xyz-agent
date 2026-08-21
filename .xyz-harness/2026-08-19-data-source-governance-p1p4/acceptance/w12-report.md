# W12 验收报告：5 个 state 话题数据源切换为 ReplicatedState 发布

**结论：PASS**（7 个 minor 观察项移交，无 must-fix；设计细化形态裁决成立）

- 验收对象：工作区未提交改动（基线 996063a6f 之后，W11/W19 已 commit 之外的 11 文件）
- verifier：独立对抗验收，未信任 builder 自报，全部读码 + 实跑 + 红性证伪
- 行为级场景（断连 30s 重连）按验收文档留 P1 gate，本验收不覆盖

## 1. 防篡改

```
$ git diff 996063a6f -- .xyz-harness/.../w12-acceptance.md docs/architecture/data-source-governance-plan.md
（空输出，exit 0）
$ git status --porcelain -- docs/ .xyz-harness/
（空——登记表未被 builder 改动）
```

验收文档 + plan §3 W12 节（L402-432）相对基线零改动。通过。

## 2. 范围

`git status --porcelain -uall` 恰 11 项，与 builder 自报一致：

| 文件 | 判定 |
|---|---|
| packages/runtime/src/services/session/session-service.ts | 核心（阶段 1/2/3） |
| packages/runtime/src/services/session/event-interpreter.ts | 核心（阶段 4/5） |
| packages/runtime/src/services/session/replicated-states.config.ts | 顺带（死代码删除） |
| packages/runtime/src/__tests__/equivalence/w12-owner-snapshot-publish.test.ts | 新增（14 用例） |
| packages/runtime/src/__tests__/equivalence/w10-usage-switchmodel-race.test.ts | 测试适配 |
| packages/runtime/src/__tests__/session-service-w07-bus.test.ts | 测试适配 |
| packages/runtime/test/runtime-wiring.test.ts | 测试适配 |
| packages/runtime/test/session-service.test.ts | 测试适配 |
| packages/shared/src/protocol.ts | W8 minor 顺带（queue_update 契约） |
| packages/renderer/src/api/mock/index.ts | mock 连带 |
| packages/runtime/src/index.ts | 注释修正（W10 minor） |

无 extensions/、无 core chat 域、无 event-adapter（W21 领地）改动。`message-bus.ts` 与 `session-message-handler.ts` 相对基线 996063a6f（含已 commit 部分）双零 diff。通过。

## 3. 5 阶段 publish 数据源逐一核实

`grep -n "session.commands\|session.state_changed\|context.update" session-service.ts` 命中 3 个 publish 点，全部读实例快照：

| 阶段 | publish 点 | 数据源 |
|---|---|---|
| 1 session.commands | session-service.ts:1402（publishCommandsSnapshot） | `replicatedStates.get(sid)?.commands.get()?.commands` |
| 2 context.update | session-service.ts:1370（publishContextFromSnapshot） | `replicatedStates.get(sid)?.usage.get()` 三字段 + 字段齐全守卫 |
| 3 session.state_changed | session-service.ts:1455（publishStateChangedFromSnapshot） | modelId/thinkingLevel/usage 三实例 `.get()` 组合 + 快照缺失 fallback 过渡期缓存（session.modelId/thinkingLevel，W13 收编后删） |
| 4 session.subagents | event-interpreter.ts:723（broadcastSubagents） | `subagentsState.snapshot()`（新建包装类，浅拷贝数组） |
| 5 session.workflowUpdate | event-interpreter.ts:786（broadcastWorkflowUpdate） | `workflowUpdatesState.snapshot()`（新建包装类） |

三个 publish 均有 `sessions.has(sessionId)` 守卫（防 session 销毁后 bus 重建已 clearSession 的 entry）。

**旧直写路径清零**（生产代码，排除注释/测试）：
- `fetchAndBroadcastCommands`：函数已删，全仓命中仅注释（renderer mock index.ts:134 / session-service.ts:1275 / protocol.ts:844）
- `broadcastSessionState`：函数已删，命中仅注释（useChat.ts:274 / model-service.ts:83 / session-service.ts 注释）
- `fetchAndBroadcastContext`：函数壳保留但收敛——内部改为只调 `fetchContext`（markDirty 失效），不再自己 publish；session-lifecycle.ts 两调用点（:548 restore / :730 fork）语义随之为「触发失效」。直写转发中间层已删，符合 plan 步骤 3；函数名残留见观察项 ①

session-message-handler.ts stateSnapshot 组装（L334-352）：`stateSnapshot: result.stateSnapshot` 纯透传 `bus.subscribe` 返回值，零改动。builder 自报属实。

## 4. 设计细化裁决（核心）：挂钩形态成立

**裁决：成立。** 偏离 plan 字面（「publish 点数据源切换」原地换读）但服务 plan 目标（last-value 恒 == owner 快照），论证如下。

### 4a. 挂钩形态对 fetch 触发路径的完整覆盖

所有 fetch 均经 config.fetchSnapshot 单入口（replicated-state.ts doFetch L231 `await this.config.fetchSnapshot()` 是唯一数据写路径）：

| 实例 | config.fetch | 覆盖的触发路径 |
|---|---|---|
| usage | fetchSessionStatsSnapshot（fetch 成功后 setTimeout 0 排 publishContextFromSnapshot + publishStateChangedFromSnapshot） | 播种 refetch（registerReplicatedStates :1315）/ 事件失效（applyContextUpdate :912 markDirty）/ 查询失效（fetchContext :1551 markDirty）/ switchModel 失效（:525 markDirty）/ 失败退避重试（doFetch catch → backoff → doFetch，仍经同入口） |
| commands | fetchCommandsSnapshot（setTimeout 0 排 publishCommandsSnapshot） | 播种 refetch（:1317）/ 查询即失效（getCommands :1520 markDirty，W12 起唯一失效源）/ 退避重试 |
| modelId / thinkingLevel | fetchStateSnapshotWithStatePublish（finally 排 publishStateChangedFromSnapshot——失败也排，payload 走快照缺失 fallback，对齐旧 get_state 失败回退语义） | 播种 refetch / switchModel 三实例 markDirty（:522/:529）/ thinking_level_changed 事件失效（event-interpreter :388）/ thinkingLevel 30s 周期兜底 poll（config pollIntervalMs=30_000）/ 退避重试 |
| label / queue | 裸 fetchState（无发布需求，正确——非 5 话题） | — |

四类路径（播种/事件失效/查询失效/周期兜底）+ 失败重试全部经带挂钩入口，无旁路。

### 4b. 独立验证「原地换读会滞留旧值」

- 防抖窗口实存：`SCALAR_STATE_DEBOUNCE_MS = 300`（replicated-states.config.ts:52，W7 配置），markDirty → 300ms 防抖 → doFetch（replicated-state.ts:182-185）。
- 旧 publish 位置在事件驱动路径上是「markDirty 后同步执行」（如旧 applyContextUpdate：markDirty 后立即组 payload publish；旧 switchModel：markDirty 后 await broadcastSessionState）。若原地换读 `usage.get()`，读到的是 markDirty 之前的旧快照（doFetch 尚未跑）。
- 事件路径此后若无人再触发 fetch（防抖窗口内的最后一次事件后确实还有防抖到点的重拉——但重拉完成后**没有再 publish 的代码点**，因为 publish 点还在旧位置已执行过）→ last-value 滞留旧值，恰违背 W12「last-value == owner 快照」。builder 论证成立。
- 替代形态「原地换读 + refetch 立即拉」会失去防抖聚合（每事件全量 RPC）且需重新论证 W10 竞态保护，改动面更大。

### 4c. setTimeout 0 挂钩时序正确性

fetchCommandsSnapshot 形态：`const result = await client.getCommands(); setTimeout(publish, 0); return result`。事件循环顺序：client.getCommands() resolve → fetch 函数同步段（排宏任务 + return）→ 外层 promise resolve → **doFetch 的 await 在微任务恢复 → normalizeWireSnapshot → applySnapshot 写 snapshot**（replicated-state.ts:231-233）→ 微任务队列清空 → timer 阶段执行 setTimeout 回调 → publish 读 `.get()` 必为已应用快照。Node.js「微任务队列清空后才进宏任务」保证该序严格成立，非概率性。fetchStateSnapshotWithStatePublish 用 finally（成功/失败都排）同理。

### 4d. 行为面变化核实（builder 声明的 4 项全部属实）

1. publish 时机延后 ~防抖窗口（300ms）+ 快照 RPC——w10 测试从「防抖前即时断言」改「advance 后断言」即此变化的测试侧体现；
2. context.update 帧频：事件风暴经防抖聚合，每次防抖到点的 fetch 挂钩发一帧（不高于旧每事件一帧）；
3. state_changed 新增播种/周期发布 + lastPublishedStateChanged per-session Map 同值 diff 抑制（removeSessionEntry 一并清除，session-service.ts:1185）——30s 周期 poll 不放大帧量（测试用例 8 实证：95s 内仍 1 帧，权威变化后恢复发帧）；
4. resolver 与事件参数不再进任何 payload（resolveContextWindow 生产零调用方实证）。

## 5. 等价性断言真实性（14 用例逐条）

用例分布：阶段 1（2）/ 阶段 2（3）/ 阶段 3（3）/ 阶段 4（3）/ 阶段 5（3）= 14。两层结构非恒真：

- **阶段 2 数据源层（重点抽查 ①）**：`applyContextUpdate(sid, 9999, 9999)`（事件即时值 ≠ 权威 7000），断言 stateSnapshot last-value `toEqual {inputTokens: 7000, contextLimit: 128000, usagePercent: 5}`。若事件直转发复活（旧路径），last-value 为 9999 → 红。真证伪。
- **阶段 3 数据源层（重点抽查 ②）**：`setModelContextWindowResolver(() => 999999)`（resolver 错窗口 ≠ pi 快照 64000），断言 payload `contextLimit: 64000 / usagePercent: 8`。若 payload 读 resolver 重算（旧 broadcastSessionState 口径），contextLimit 为 999999、percent 为 1 → 红。真证伪。
- 其余等价层用例断言「切换前后同值」均在 mock 权威翻新后成立（新旧口径同公式同值，依赖「pi getContextUsage 天然按当前模型窗口」的 W10 已验收论证）；守卫类用例（bg-notify 未命中不发 / workflow 无 runId 不发）锁旧行为零变化；无值态用例锁「compact 空快照不覆盖旧值」。
- 阶段 4 的快照隔离断言（第二次写入不打穿第一次已发布 payload）实质验证 snapshot() 浅拷贝。

## 6. 红性验证（临时改动 → 红 → 还原，cp 备份还原，非 git 操作）

**红性 a（数据源层）**：publishStateChangedFromSnapshot 的 `contextLimit: usage?.contextLimit ?? 0` 改为 `this.resolveContextWindow(modelId)`（resolver 影子路径复活模拟）：
```
npx vitest run w12-owner-snapshot-publish.test.ts -t "resolver"
→ Tests  1 failed | 1 passed | 12 skipped
→ 失败点 :221 payload 断言（contextLimit 999999 ≠ 64000）
```
**红性 b（等价层）**：删 fetchCommandsSnapshot 的 `setTimeout(() => this.publishCommandsSnapshot(sessionId), 0)`：
```
npx vitest run w12-owner-snapshot-publish.test.ts -t "W12 阶段 1"
→ Tests  2 failed | 12 skipped
→ 失败点 :384/:404 stateSnapshot 无 session.commands 帧（last-value 滞留旧值形态）
```
**还原完整性**：cp 备份还原后 md5 与基线一致（094f7fb1a5f0860b136a117e88c054c2），w12 全文件复跑 14/14 绿，临时文件已清理。两组红性均确证断言非恒真。

## 7. 边界断言 + 回归

- `git diff 996063a6f -- message-bus.ts session-message-handler.ts` 双空；TOPIC_TABLE / STATE_TYPE_KEY_MAP 零改动（message-bus.ts 全文件零 diff）。
- stream ring 语义：runtime message-bus.test.ts **31/31 绿**；core subscription-state.test.ts **12/12 绿**。
- runtime：`pnpm typecheck` 通过 + `pnpm test` **277 files / 3150 tests 全绿**（35.8s，与 builder 自报 277/3150 一致，无并行抖动需隔离复跑）。
- shared `npx tsc --noEmit` exit 0；renderer `npx vue-tsc --noEmit` exit 0。
- W12 diff 无 `any`（新增行 grep 0 命中）。

## 8. 顺带项核实

1. **protocol.ts queue_update 契约**：`pendingMessageCount: number` 必填声明在位（:1155），不动 ring 语义（仅类型声明，TOPIC_TABLE 分类/环缓冲行为零改动），且为验收文档明确列出的交付物。
2. **renderer mock 连带**：emitQueueUpdate 补 `pendingMessageCount: (q?.steering.length ?? 0) + (q?.followUp.length ?? 0)`，与 event-adapter 翻译口径（event-adapter.ts:721 `event.steering.length + event.followUp.length`，同源公式 pi agent-session pendingMessageCount）一致。正确。
3. **index.ts L272-278 注释修正**：onContextUpdate 注释更新为「W12 起 context.update 广播退役为快照挂钩发布」，与实现（applyContextUpdate 只失效）一致。准确。
4. **死代码移交核实**：`resolveContextWindow` 生产零调用方（grep 仅定义 :1407）；`setModelContextWindowResolver` 注入链在位（index.ts:421 注入 TTL resolver）但下游无人消费；`setThinkingLevelCache` 生产零调用方（interfaces.ts:227 声明 + 实现 :541，仅测试播种用）。builder 自报属实，移交 W13/W15 处置合理。

## 9. 登记表草稿核对

- data-source-registry.md 未被 builder 改动（正确——登记表草稿制，落表归主 agent）。
- 草稿内容（event-interpreter 注释内：「W12-W18 过渡：写入口 = 事件流（applyStart/applyNotify / apply），W18 起源 = entry 扫描」）与代码实现一致；#8/#9 条目已有 W16-W18 目标描述，W12 过渡例外**待主 agent commit 时落表**（见观察项 ⑦）。

## 10. 超清单 4 文件裁决

| 文件 | 裁决 |
|---|---|
| replicated-states.config.ts（-26 行） | **接受**。recomputeUsageWithWindow 两调用方（switchModel/applyContextUpdate 即时广播）随 W12 删除而死，属本 wave 直接后果非越界清理；[HISTORICAL] 注释交代沿革，符合惯例 |
| runtime-wiring.test.ts / session-service.test.ts / w10-usage-switchmodel-race.test.ts / session-service-w07-bus.test.ts | **接受**。生产行为变化（publish 时机延后 + payload 数据源换）的必要连带；「resolver 缺省 0 → 快照真值」两处断言口径修正是 W12 语义修正本身（方向为更强断言，非放松） |
| renderer mock index.ts | **接受**。queue_update 契约必填字段的编译/行为连带，公式与 runtime 翻译同源 |

## 11. Minor 观察项（移交，无 must-fix）

1. `fetchAndBroadcastContext` 函数名与语义不符（已不 broadcast，只 markDirty 失效）——建议 W13 更名（如 triggerContextRefresh）或内联进两调用点。
2. `resolveContextWindow` + `setModelContextWindowResolver` 注入链（含 index.ts:421 的 TTL resolver 构造）整体死代码，移交 W13/W15 处置（builder 已自报）。
3. `setThinkingLevelCache` 生产死代码（interfaces.ts:227 声明保留），同上移交。
4. protocol.ts:844 注释仍写「fetchAndBroadcastCommands 广播」——所指机制已删，注释过时。
5. session-service.test.ts 的 `waitForSnapshotPublish` 用真 timers 400ms sleep（该文件无 fake timers）——慢 CI 有 flaky 风险，后续可改 fake timers。
6. publishContextFromSnapshot/publishCommandsSnapshot 的守卫注释「对齐旧路径失败不发」与旧实现「catch 后 warn 不发」一致，行为等价；但旧 fetchAndBroadcastCommands 失败是静默 warn，新路径 fetch 失败同样静默（ReplicatedState 退避重试）——无日志观测点，排查时靠 XYZ_AGENT_DEBUG 层，可接受。
7. **登记表 W12-W18 过渡态例外待落表**（主 agent commit 时执行，防 S1 review 窗口期误报）——event-interpreter 注释自称「已登记」与登记表实际状态有窗口期不同步，落表后闭合。
