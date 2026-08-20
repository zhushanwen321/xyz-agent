# W21 Verifier Report：实时 feed 喂入（message_end 重构 entry）+ 等价性断言升级

> verifier 独立对抗式验收，2026-08-19。基线 commit `962e51c5e`；工作区 = W9（已 PASS、commit 延迟）+ W21 未提交叠加态，越界扫描基准 HEAD `a87831c3a`（验收期间主 agent 追加 commit `9382ccb57` 纯预置基线，见 §1 备案）。

## 总结论：PASS

## 1. 防篡改

| 项 | 结果 |
|---|---|
| `git diff 962e51c5e -- .xyz-harness/.../w21-acceptance.md` | 空 |
| `git diff 962e51c5e -- docs/architecture/data-source-governance-plan.md` | 空 |
| w21-acceptance.md sha256 | `57f1e3c983505c4df9509b5350d1506058329f258d4a985ac9b6aa99000c43b0` |
| plan sha256 | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` |

越界扫描（HEAD..工作区 39 文件 + 3 个非豁免 untracked，逐 diff 核对）：

- W21 范围内：shared pi-entry.ts（新增）/ index.ts / protocol.ts；runtime event-adapter.ts、message-converter.ts、types.ts、event-interpreter.ts（W21 段）、live-reload.test.ts、8 个测试文件 payload 形态适配（均带 `[w21]` 标注，仅断言改 entry 形态，无功能越界）；core apply-entry.ts（类型下沉 re-export）/ store.ts / registry.ts / effect-types.ts / useChat.ts（仅注释）/ 3 个测试文件；renderer mock run-send-stream.ts 重写 + run-send-stream-branches.ts（新增）+ 6 个测试适配；history-rebuild-cache.ts 仅注释更新。
- W9 豁免集吻合：session-meta-cache 两文件删除、runtime index.ts（sessionMetaCache import/回调删）、session-lifecycle.ts、session-service.ts、scalar-state-invalidation.test.ts、event-adapter-test-fixture.ts、session-lifecycle-rename.test.ts、session-service.test.ts、event-interpreter.ts 删回调段、event-adapter-new-events.test.ts U-adapter-1 段。
- 禁改清单核验：TOPIC_TABLE 与 STATE_TYPE_KEY_MAP 零改动（diff 内无命中）；COALESCED_TYPES（delta-coalescer.ts）零改动；entry_appended 相关段零代码改动（仅 NULL_EVENTS 注释补写 + TODO(W18) 锚点，见 §5.3）；无 git 写操作、无 mock pi。
- 备案（非 W21 越界，不判 FAIL）：验收期间主 agent 自行 commit `9382ccb57`（pre-stage W15/W18/W19/W22 基线，+124 行纯新增），验收开始时这些文件为 untracked——归属已由该 commit 确认（w18 文件头自述「W21 committed 后才可派发」，与 pre-stage 模式一致）；`w9-report.md` 为 W9 verifier 报告（豁免）。verifier 全程零 git 写操作，越界扫描基准 HEAD 取验收开始时的 `a87831c3a`，该 commit 不影响任何扫描结论。

## 2. 四包全量 + 专项（verifier 实跑，2026-08-19 08:40-08:43）

| 包 | typecheck | 测试 |
|---|---|---|
| shared | tsc 通过 | 16 files / **162 passed** |
| core | tsc 通过 | 76 files / **984 passed, 6 todo** |
| renderer | vue-tsc 通过 | 293 passed + 1 skipped / **3054 passed, 3 skipped** |
| runtime | tsc 通过 | 269 files / **3111 passed** |

与 builder 自报数字逐包一致（984/3111/3054/162），W9 补跑确认全绿。

等价性专项 `pnpm exec vitest run src/__tests__/equivalence/`（真实 pi 子进程，mimo-v2.5-pro）：**3 files / 16 tests 全绿**，其中 W21 三用例：store 级同构（工具调用）6.27s、bash 双通道合并 5.22s、混沌注入 5.62s（混沌用例的 `[apply-entry] toolResult has no matching toolCall in window` warn 为乱序注入的预期孤儿收集）。

## 3. 通过命令条款对照

1. `grep -n "applyEntry" store.ts`：8 命中，含 `applyEntryFrame` 内真实调用 `entryStates.set(sessionId, applyEntry(cur, entry))`（store.ts:408-411）。`grep -A3 "NULL_EVENTS = "`：无 `message_end`，`entry_appended` 仍在列。protocol typecheck 过（shared/runtime/core 三侧 tsc 全绿）。CORE/RUNTIME/RENDERER_TEST 全绿（§2）。**通过**
2. live≡reload 断言对象为 store 级快照（liveState.messages/clientUuidMap/orphanToolResults/lastAssistantWithToolCalls 四字段逐项 deep equal = ChatViewState 全字段；用例 2 归一后全 state toEqual）；混沌注入（乱序/丢失/重复）通过。**通过**
3. 行为级场景 3 留 P3 gate（acceptance 自述），单测/等价层已覆盖。**按验收条款豁免**
4. message-dispatcher 4 测试文件（bash-race/bash/compact/precheck）零改动复跑 **25/25 绿**；text_delta overlay 链零改动（TOPIC_TABLE 'transient' 与 COALESCED_TYPES 均未动）。**通过**

## 4. 真实性抽查

### 4.1 wire 收口定案（成立）
- protocol.ts：`'message.message_end': { sessionId; entry: PiMessageEntry }`、`tool_call_start: { sessionId; entry: PiToolCallEntryForm }`、`tool_call_end: { sessionId; entry: PiMessageEntry }`——payload 收紧，旧平铺字段从类型移除。
- tsc 强制核实：`send: (msg: ServerMessage) => void` 有类型约束；全仓生产构造点仅 3 处——event-interpreter.ts:386（start）、:442（end）、event-adapter.ts:627（message_end 经 translate）——均已对齐 `{ sessionId, entry }`，缺 entry 即编译错。中间事件 PiTranslatedEvent 保留平铺字段（hook 上下文契约），WS 帧只发 entry，替换不并存。
- 渲染链闭环：useChat `startsWith('message.')` → coalescer（非 delta 同步 dispatch）→ store.applyMessageEvent → registry → applyEntryFrame。TOPIC_TABLE 未收 message_end，走 R-07 fallback='stream'（入 ring 可回放，行为正确；显式登记更稳，留 W22 顺手，本 wave 禁改 TOPIC_TABLE）。

### 4.2 store 纯累积定案（成立，撕裂论证成立）
- store.ts:408-411 `applyEntryFrame` 仅 `entryStates.set(applyEntry(...))`，不触 messages ref；entryStates 为非响应式 Map（ADR-0049 例外，disposeSession/LRU 同点清理，store.test 锁定）。
- registry tool_call_end：`ctx.applyEntryFrame` 先于 `findToolCallOwner`/`idx<0` 早退——ref 无 owner 时 reducer 照常喂入，overlay 收口失败不丢权威状态。撕裂论证成立：messages ref 在 streaming 窗口由 overlay 持有（乐观 user / running toolCall / delta），直接投影会双写撕裂；store.test 断言 message_end 后 ref 仍为 0（overlay 不动）。

### 4.3 turnId 定案（成立）
- `PiToolCallEntryForm.turnId?: string` 类型在（pi-entry.ts:142）；构造点 grep 仅注释与类型声明，无一处赋值。
- pi 源码抽验（~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/core/extensions/types.ts:726）：`MessageEndEvent = { type; message }`，无 turn 字段；`ToolExecutionStartEvent`（:727-733）/`ToolExecutionEndEvent`（:749-755）同样无 turn 信息且 end 无 args——「pi 事件无 turn 边界」属实，不填是事实约束。
- 持久化时序佐证：agent-session.ts:545-561 emit message_end → appendMessage（id 在 emit 后分配），live 事件拿不到 entry id——与 adapter 注释一致。

### 4.4 legacy 删除（成立）
- `convertPiHistoryLegacy`/`parseSkillBlockLegacy`/`extractHistoryFileChangesLegacy` 全仓零残留（diff 中只见删除行）；message-converter.ts 433→176 行。仓内其余 "Legacy" 命中（project.ts/workspace-detector/migration 等）均为 W21 之前既存无关代码，不在本 diff。
- `fillToolCallOutput` 保留（message-converter.ts:162）且 `applyOrphanToolResults` 生产在用（session-service.ts:694 调用）。

### 4.5 等价断言语义（成立）
- store 级同构：断言 ChatViewState 全部 4 字段；非空守卫（live ≥2 entries）+ 工具链路守卫（assistant 带 toolCalls、output 含探针串、孤儿为 0）防 0==0 空转。
- bash timestamp 归一有注释声明（live bash 走 RPC reply 无 message_end 通道、timestamp 非同源，两侧同规则归一后对比）——pi 源码 agent-session.ts:2672/2705 佐证 bash 直接 appendMessage 不 emit。
- 混沌注入形态：乱序（toolResult 提前 → 孤儿收集，断言分叉）/ 丢失（drop 中间 entry）/ 重复（同 entry 双喂 → messages +1 可检测）+ 不变量 0（同序列两次重放 deep equal）。

## 5. 行为对抗抽查

### 5.1 红性验证 A（equivalence）
破坏：handleMessageEnd 对 `role==='toolResult'` 返回 noop（注入一行）。结果：用例 1 红（liveState.messages ≠ reloadState.messages，toolResult 缺失致配对不回填）。还原：shasum `d1378174...3e26c` 与破坏前一致，git diff 恢复 108+/11-。

### 5.2 红性验证 B（store）
破坏：applyEntryFrame 对 `entry.type==='message'` 早退。结果：store.test W21 段 3/4 红（user 累积、assistant+toolResult 回填、dispose 清理均失败；异常帧丢弃用例按预期仍绿）。还原：shasum `1dfd83ab...95f7c` 一致，store.test 复跑 40/40 绿。

### 5.3 entry_appended 警戒线
NULL_EVENTS 集合 `entry_appended` 成员未动；无 entry_appended handler 注册；TODO(W18) 注释锚点在位（event-adapter.ts:812-815）；该段 diff 仅注释补写。

### 5.4 dispatcher 回归
4 文件零改动 + 复跑 25/25；text_delta transient（TOPIC_TABLE）与 COALESCED_TYPES 零改动。

## 6. 四项定案裁决

| # | 定案 | 裁决 | 依据 |
|---|---|---|---|
| 1 | wire 上收 entry 形态 | **合理，维持** | plan 步骤 2「payload 换 entry 形态」的忠实实现；构造点收口由 tsc 强制；toolCall 侧用 PiToolCallEntryForm（overlay 载体、不进 reducer）与 plan 映射表字面略偏，但 pi SessionEntry 联合确无 toolCall entry 类型（session-manager.ts:140-149 核实，toolCall 是 assistant message 的 content block）——是对 pi schema 的忠实映射非偷工减料 |
| 2 | store 纯累积不投影 | **合理，维持，需主 agent 知悉** | plan 字面「applyMessageEvent 内部改喂 reducer」已满足（入口确实喂 reducer）；plan 未要求 ref 立即投影。撕裂论证成立（streaming 窗口 overlay 与投影双写必撕裂）。代价：W21 后实时渲染仍走 overlay、reducer state 是无消费方镜像（仅测试读口）——**W22 broadcast≡get_state 对账是硬前置，若 W22 不落地则 live 侧 reducer 成死重**，请主 agent 在 ledger 标注依赖 |
| 3 | turnId 类型在不填值 | **合理，维持** | pi 事件无 turn 边界（源码核实），填值即投机代码，违反 plan 步骤 5 精神；类型契约已稳定存在，后续 wave 只改构造点 |
| 4 | 断言改 reducer 确定性 | **合理，维持** | 断言不变量（同 reducer 同序列必同 state）强于双实现对照；legacy 参照删除符合「替换不是并存」；真实 pi fixture 契约遵守 |

无需打回；定案 2 建议 W22 派发时带上「ref 收敛 + 死重清理」验收项。

## 7. 备忘（非阻塞，供 W22 参考）

1. 等价测试 live 侧只收集 message_end 流；生产 registry 中 tool_call_end 帧会额外把 toolResult entry 喂 reducer（同一 toolResult 双喂：tool_call_end + message_end）。因 applyEntry toolResult 分支为覆盖式配对回填（非 append），双喂收敛——非缺陷，但建议 W22 chaos 全量化补「双喂收敛」显式用例。
2. message.message_end 未显式入 TOPIC_TABLE（走 R-07 stream fallback，可回放）——W22 顺手显式登记。
3. 行为级场景 3（steer/bash/subagent/重启对照 + 截图）按 acceptance 条款留 P3 gate。

## 8. 完成度声明

验收动作 5/5 全部执行（防篡改/命令实跑/真实性抽查/行为对抗/四项裁决）；无跳过项。行为级场景 3 为 acceptance 条款明示的 gate 留项，非 verifier 跳过。
