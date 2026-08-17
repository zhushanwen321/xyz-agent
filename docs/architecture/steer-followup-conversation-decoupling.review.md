# steer/followup 解耦设计修订版对抗式审查报告

审查对象：`docs/architecture/steer-followup-conversation-decoupling.md`（commit 78c558a53 修订版，3 处补充）
审查方式：逐条核实源码（行号 + 代码摘录），全部结论附证据。

## Summary

1 must-fix, 4 suggestions. 总判定：**需修订**——方案本身成立，但修订 1 的"排队三处分裂"表存在一处关键事实引用错误（③ 的位置），修正后即可通过。

## 三问结论

### 问题 1：目标问题是否明确、是否为真正的问题？——明确且真实

- 双重表达是真实的：`store.ts:257 appendPending` 在 RPC 前把 steer/followup 以 `status:'pending'` 注入 messages；pi `queue_update` 回流 `queueStates`（store.ts:87）驱动 QueueBubble（Composer.vue:43）。两个反馈确实同时存在。
- 虚线框分支真实存在：`packages/ui/src/features/chat/UserBubble.vue:26-38` pending 分支（`v-else-if="isPendingUser"`，computed 在 177-179 判 `status === 'pending'`）。
- V6 spec 确实已裁决废弃：`docs/page-design/v6-spec-input.html:113` change-point「删 pending 态（虚线气泡）→ 迁 QueueBubble [v6 目标 · 代码待清理]」、line 214 anno「[现状] UserBubble.vue:25-37 仍渲染 pending 分支，属待落地实现债」。
- 问题表述准确：pending message 确为「对话逻辑感知到触发源、为它造了对应组件」，违反对话流通用性原则。

### 问题 2：方案是否可靠、三处修订是否补上缺口、有无新矛盾？——可靠，无新自相矛盾；但 ③ 位置引用错误

**修订 1（三处分裂表）**：补上了"队列全貌"缺口，范围声明诚实（明确 ②③ 留后续独立设计）。但 ③ 的源码位置引用错误（见 MUST_FIX-1）。**范围声明没有使验收失效**：§4 场景 1-5 全部只测 ①（pending 移除），与 scope 声明一致，闭环成立；验收不声称覆盖 ②③，无失配。

**修订 2（P-placeholder 探针）**：补上了视觉竞态缺口。竞态真实存在（见问题 3）。标记实施期 M2 合理。但探针描述只覆盖 steer 情形（见 SUGGESTION-2）。

**修订 3（send 改道说明）**：与源码完全一致（`useChat.ts:344-347`），且与文档其他章节无矛盾：
- Composer 按 `⏎` 走 onSteer 直调（Composer.vue:363-364），send() 的改道服务于其他调用方（重试/compact 重放首条/landing 等），两者不冲突；
- followUp 非活跃退化 send（useChat.ts:406-409）、steer 非活跃早退（useChat.ts:378），与 §5 新说明的语义一致；
- 「G1/G2 目标的覆盖扩展」表述成立：busy-send → steer → pushPending → QueueBubble，与直接 steer 路径同构。

### 问题 3：关键事实是否正确？——① ② 准确；③ 机制准确但位置引用错误（must-fix）；P-placeholder 竞态真实

**「排队三处分裂」对照源码：**

| 表格声称 | 源码核实 | 结论 |
|---|---|---|
| ① `messages` 内 `status:'pending'`（store.ts:257） | `store.ts:257 appendPending` 注入 `status:'pending'` + `sendMode` ✓ | 准确 |
| ② `queueStates`（store.ts:87，`{steering?, followUp?}`） | `store.ts:87` ref 声明 ✓；形状在 `store-types.ts:20-23`（`QueueState { steering?, followUp? }`） | 基本准确（形状定义位置在 store-types.ts，非 store.ts，见 SUGGESTION-1） |
| ② 可取消：否（pi 无 clear_queue RPC） | pi `rpc-mode.js` 命令清单（prompt/steer/followUp/abort/set_steering_mode/compact/set_auto_compaction/abort_retry/abort_bash）无 clear_queue；`clearQueue()` 仅存在于 `agent-session.js:1141`，只被 TUI `interactive-mode.js` 调用（3428/3502），未暴露为 RPC | 准确 |
| ③ `compactQueue`（useChat.ts:199-208，模块级） | `useChat.ts:199-208` 是 `session.compacted` handler 里 `deps.getCompactQueue().flush(sid)` 的**消费点**，非定义点。真实定义：`packages/renderer/src/composables/panel/useCompactQueue.ts`（模块级单例 `queueInstance`，export at 69），实例化于 `composer-shell.ts:136` | **错误（must-fix）** |
| ③ 可取消：是（逐条取消） | `CompactQueueBadge.vue:74` `queue.remove(props.sessionId, id)` 逐条取消 ✓ | 准确 |

**P-placeholder 竞态是否真实发生？——真实。**

- 占位条件：`TurnMeta.vue`（packages/ui）`isPendingPlaceholder = props.sessionActive && props.turn.assistants.length === 0`（实际行 86-88），渲染"思考中"spinner。
- steer drain 时：agent 当前回合仍在 streaming（`isGenerating(sid)` true → derivedStatus='streaming' → `useSessionActive` 的 `SESSION_ACTIVE_STATUSES` 含 streaming → sessionActive=true）。queue_update 与 message_start 是两条独立 WS 消息，中间 Vue 渲染 flush 会插入 → appendUser 造出的空 turn 短暂显示 spinner。竞态窗口真实。
- 佐证：pi 侧 P-order 断言核实无误——`agent-session.js` `_handleAgentEvent`（340-368）：`message_start{role:'user'}` 时**同步**先 `_steeringMessages.splice` + `_emitQueueUpdate()`，再 `_emit(event)`；xyz-agent `event-adapter.ts:483` noop 掉 user role message_start；renderer 侧 `registry.ts` queue_update(drain) 先于 assistant message_start 到达。
- 注：followUp drain 时点不同（message.complete 之后，derivedStatus 可能已 done → sessionActive=false → 占位**不会**出现，空 turn 短暂无 meta），见 SUGGESTION-2。

**其余引用行号抽检**（全部核实通过）：`registry.ts:78 countDrained` ✓、queue_update handler 530 起（markPendingDelivered 循环 ~546-551）✓、`UserBubble.vue:178 isPendingUser` ✓、`Composer.vue:363` ✓、`store.ts:500/506 disposeSession` mapRefs=[messages, retryStates, queueStates] ✓、`types.ts:16 DerivedStatus` ✓、`sessionStatus.ts` deriveStatus `if (isActive) return 'pending'`（~179，文档称 150-182）✓、`message-turns.ts:78` ✓、`fg5-message-stream.test.ts:426` ✓、`effects.test.ts:39` ✓、`useChat.test.ts:179` ✓、`store.test.ts:93` ✓、`turn-pending-bubble.test.ts` 路径 ✓、mock 无 message_start ✓（mock/index.ts steer/followUp 仅 emit queue_update）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2.3 新表 ③ 行 | 关键事实 | `compactQueue（useChat.ts:199-208，模块级）` 引用错误：useChat.ts:199-208 是 `session.compacted` handler 的 flush 调用点（`deps.getCompactQueue().flush(sid)`），非队列定义；真实定义在 renderer 包 `packages/renderer/src/composables/panel/useCompactQueue.ts`（模块级单例，export 于 line 69，实例化于 composer-shell.ts:136）。文件与包归属均错 | 改为「`useCompactQueue`（packages/renderer/src/composables/panel/useCompactQueue.ts，模块级单例，composer-shell.ts:136 实例化）」 |
| SUGGESTION | §2.3 新表 ② 行 | 引用精度 | `{steering?, followUp?}` 形状定义在 `store-types.ts:20-23`（QueueState），store.ts:87 只是 ref 声明。括号引用把两处混为一处 | 拆分引用：ref 在 store.ts:87，形状在 store-types.ts:20 |
| SUGGESTION | §3.4 P-placeholder | 探针精度 | 行号偏移（isPendingPlaceholder 实际 86-88，文档 79-85）且未标包路径；更实质：探针描述只覆盖 steer drain（session 仍 active，占位会闪），followUp drain 发生在 message.complete 之后、derivedStatus 可能已 done → sessionActive=false → 占位根本不会出现，空 turn 是另一种视觉态（无 meta 短暂存在后跳变） | 探针分两种 drain 分别断言：steer 断言"占位一闪而过或不出现"；followUp 断言"空 turn 无占位 meta、message_start 后 TurnMeta 无跳变" |
| SUGGESTION | §4 场景 4 | 验收可执行性 | 触发构造不精确："agent 进程已退出时发 steer"——若 agent 退出后 session 终态（isActive=false），Composer onKeydown（363）不会走 onSteer，steer() 也因 `!chat.isActive(sid)` 早退（useChat.ts:378），根本发不出 RPC。只有"streaming 中杀 pi 子进程、pendingSend 残留使 isActive 保持 true"才可触发 | 给确切构造步骤：streaming 中杀 runtime/pi 子进程（isActive 仍 true）→ 发 steer → 断言 RPC 失败路径 |
| SUGGESTION | §2.4 / §5 | 引用精度 | V6 spec anno 实际 line 214（文档称 212，内容无误）；send 改道块实际 344-347（文档称 337-349 含注释区）。行号随代码漂移 | 建议统一以符号名（函数名/computed 名）检索为准，行号标注"~" |

## 总判定

**需修订**（1 处 must-fix 事实引用 + 4 处建议）。方案核心（pendingBuffer + drain 时 appendUser）成立：目标问题真实、P-order 时序硬保证经 pi 源码核实、验收场景与 scope 声明闭环、三处修订未引入自相矛盾。仅 §2.3 新表 ③ 行位置引用需修正。
