# 审查报告：conversation-history-unified-converter.md

## Summary

6 must-fix, 5 suggestions。**总判定：需修订**（方案方向成立，关键事实核实通过，但 6 处 must-fix 阻塞按现状实施）。

三问回答：

1. **目标问题明确且为真问题**：覆盖倒挂经源码逐条核实属实（RPC 路径 `entry-tree-builder.ts:92-116` 只放行 message + client-msg-id custom；文件路径 `session-history.ts:24-77` 放行四类）；auto-compaction 隐形属实（`event-adapter.ts:667-671` NULL_EVENTS 吞掉 compaction_start/end）；get_messages 死代码属实（`rpc-client.ts:511` 零生产调用方）。根因定位准确：两份独立 entry 筛选 + 事件吞噬，非 convertPiHistory 缺陷。
2. **方案架构合理但 4 处设计缺口**：共享 mapper 单点符合项目「判别前置到数据入口」哲学，方向正确；但 (a) `PiSessionEntry` 联合缺 `custom_message`，(b) 失败路径双广播无去重设计，(c) P-dedup 只有探针没有机制，(d) 文件路径接入破坏 session-history.ts 的 port 层不变量。
3. **关键事实 3 条断言全部核实为真**：「compaction_end.result 自带 summary/tokensBefore/estimatedTokensAfter」✅（agent-session.js:1452-1468 手动 / 1688-1694 自动）；失败路径带 errorMessage/aborted ✅（:1472-1478）；手动 compact 同样发 compaction_start{reason:'manual'} ✅（rpc-mode.js:416-418 → session.compact → agent-session.js:1370）。pi dist 行号引用精确无误。xyz 侧行号有少量漂移（见 INFO）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3.1 + §5 改动地图 | P0-11 事实 / P0-12 遗漏 | `PiSessionEntry` 联合（pi-protocol.ts:540-545）**不含 `custom_message`**（仅 message/custom/label/compaction/branch_summary；头注释 536-538 明言 custom_message 未建模）。文档称「pi-protocol.ts:540 已含…全联合」并让 `mapSessionEntries(entries: PiSessionEntry[])` 映射 custom_message——按该签名类型上无法判别 custom_message。pi-protocol.ts 也不在文件改动地图。 | M1 给联合补 `PiSessionCustomMessageEntry`（type:'custom_message' + customType/content/display/details，pi 侧 appendCustomMessageEntry 已核实 session-manager.js:866）；pi-protocol.ts 补入改动地图 |
| MUST_FIX | §3.3.4 失败路径 | P0-10 / P0-12 | **失败路径双广播，无去重设计**。pi 手动 compact 失败时 catch 分支**必然** emit `compaction_end{result:undefined, errorMessage, aborted:false}` 再 rethrow（agent-session.js:1472-1478，已核实）→ RPC error reply 同流后到。设计让 interpreter 从事件广播 `session.compacted{error}` + 对话流错误提示，同时保留 dispatcher「RPC 失败复位 + session.compacted{error} 兜底」——失败时双 session.compacted{error}；再加 dispatcher throw → error envelope → 前端 useChat compact() catch toast（useChat.ts:498-508），共三路失败反馈。文档「pi 未发事件的路径」前提错误：只有 transport 级失败（RPC 未达 pi）才不发事件，LLM 失败/abort 都发。 | 明确去重机制：dispatcher 兜底仅在「未观察到本 session 对应 compaction_end 事件」时触发（需 dispatcher 侧跟踪），或删 dispatcher 错误广播只保留 isCompacting 复位；错误提示通道与 toast 通道二选一并写明理由 |
| MUST_FIX | §3.3.4 P-dedup | P0-10 / P0-12 | **双发去重无机制，只有探针**。dispatcher compact busy 预检（message-dispatcher.ts:436-446）只查 isBashRunning/isGenerating，**不查 isCompacting**——compact 进行中再次 compact、或 auto-compaction 进行中手动 compact，均通过预检。pi 侧每次 compact() 调用都 emit compaction_start（:1370），且第二次调用 `this._compactionAbortController = new AbortController()` 覆盖第一次的引用、`abort()` 只 abort agent loop 不 abort 在跑的 compaction（agent-session.js:1366-1370）——双 compaction 会真实并发，产生双 compaction_start/双压缩记录。P-dedup 探针（§3.3.6）只验证不提供机制，验收「compacting 只出现一次」无设计支撑。 | 预检补 `isCompacting` 拒绝；文档写明 auto/manual 并发窗口处理（runtime 侧 active.isCompacting 是否由 compaction_start 事件驱动、auto 期间 manual 请求的拒绝语义） |
| MUST_FIX | §3.3.4「前端零改动」 vs §4 场景 2 | P0-13 / P0-10 自相矛盾 | 场景 2 通过标准要求「正在自动压缩上下文…」（reason 区分手动/自动文案），但现前端 compacting 浮层渲染固定 i18n `t('panel.message.compressing')`（MessageStream.vue:88-100），store 只有 boolean `setCompacting`（packages/core/src/domain/chat/store.ts:467-474），`session.compacting` handler 忽略 payload.reason（useChat.ts:186-188）。改动地图零 renderer 文件 + 声称「前端零改动」→ G2 验收按现状不可达成。 | 二选一：reason 文案需求入 scope（store 记 reason + MessageStream 文案 + i18n + 对应文件入改动地图），或场景 2 删除 reason 区分文案，只要求「压缩中」浮层 |
| MUST_FIX | §3.3.3 + §5 改动地图 | P0-12 遗漏 | **文件路径接入 mapper 破坏层不变量**。session-history.ts 头注释明言「经 ISessionStore port 访问…不直接 import infra」；`ISessionStore.convertHistory(raw: unknown[])`（ports/session.ts:92）**无 entryIds 参数**（实现 PiSessionStore.convertHistory 直调 convertPiHistory(raw)，session-store.ts:67）。M3 删 `__entryId` 注入后必须让 convertPiHistory 收到平行 entryIds，否则 fork 定位丢 piEntryId——要么扩 port 签名，要么 session-history 直连 infra（违反其自身不变量）。ports/session.ts 与 session-store.ts 均不在改动地图。 | 扩 `ISessionStore.convertHistory(raw, entryIds?)` 并同步 PiSessionStore 实现（透传 convertPiHistory 第二参），两文件补入改动地图；mapper 调用点经 port 而非直连 infra |
| MUST_FIX | §4 场景 1 | P0-13 不可执行 | 场景 1 通过标准「等 pi 进程退出再重开（文件路径），两路内容逐行一致」在 **>20 turn 会话上必然假失败**：离线重开走 `getHistoryTailFromFile`（DEFAULT_MAX_TURNS=20，session-history.ts:15；session-service.ts:516 降级链），会话超 20 turns 时文件路径截断，与 RPC 全量天然不一致。场景未约束会话规模或对比口径。 | 限定测试会话 ≤20 turns（compact/fork/bg-notify 记录都在窗口内），或对比口径改为「文件路径『加载更多』全量加载后 diff」 |
| SUGGESTION | §3.3.5 | P1-4 / 事实 | agent_start 死分支裁决理由错误：「删分支（前端无消费方）」——该分支产 `kind:'hook'` → interpreter `executeHooks('onPiEvent')`（event-interpreter.ts:257-259），消费方是**插件系统**而非前端。分支确不可达（NULL_EVENTS 先吞，:668/:736 已核实），但删除会静默移除插件对 agent_start 的观测。 | 裁决改为「从 NULL_EVENTS 移除让分支可达」或「删除但注明牺牲插件 onPiEvent(agent_start) 观测」，理由以插件消费为准 |
| SUGGESTION | §3.3.4 + §4 场景 3 | P1-5 / P0-12 | **aborted 语义未设计**。pi 的 compaction_end 有三种非成功形态：(a) extension cancel：result:undefined, aborted:true, **无 errorMessage**（agent-session.js:1625）；(b) signal abort：同 aborted:true 无 errorMessage（:1662）；(c) 真失败：aborted:false + errorMessage（:1472-1478/:1715）。文档一刀切「{result:undefined, errorMessage, aborted} → session.compacted{error} + 错误提示」——aborted:true 时 error 字段填什么未定义；而前端 session.compacted 的 error 字段决定 compact queue flush（useChat.ts:190-208：error undefined → flush）。abort 场景传 undefined → 误 flush（压缩未发生）；传 error → 用户看到「压缩失败」实为干净取消。 | 设计 aborted vs failed 分叉：aborted 广播不带 error（不提示失败），failed 带 error + 提示；场景 3 相应只覆盖 failed |
| SUGGESTION | §4 场景 3 | P0-13 构造不可行 | 「压缩进行中 abort」无法构造：xyz-agent 无任何 abortCompaction 暴露（runtime/renderer/core 全仓 grep 零命中，dispatcher 只有 compact()），用户无法主动触发 abort。可行构造仅「模型请求失败」（如切换坏模型配置）。 | 场景 3 给出可复现的失败构造步骤（坏模型 key / 断网），删除 abort 构造或标注需额外暴露 abortCompaction RPC |
| SUGGESTION | §3.3.4 + G2 | P0-12 副作用 | auto-compaction 可见化后的行为链未分析：auto compaction_start → 前端 setCompacting(true) → Composer 切 queueSend（Composer.vue:116-118）→ 用户消息进 compact queue → auto compaction_end（无 error）→ flush 重放。用户消息在 auto 期间的路径从「pi 内部 followUp/steering 排队」变为「xyz 前端 queue + flush 重放」——真实行为变更，文档只字未提。另 runtime 侧 active.isCompacting 仅 dispatcher manual 路径设置，auto 期间 sendPrompt 预检不拦截。 | 文档补一节：auto compaction 可见化对 compact queue / 提交互斥的连锁影响及裁决（接受 pi 内部排队 vs 走前端队列） |
| SUGGESTION | §3.3.4 / pi-protocol | P0-16 探针配套 | `PiCompactionEndEvent.result` 声明为 `unknown` 且注释「xyz-agent 不消费其字段」（pi-protocol.ts:350-360）——M4 起 interpreter 消费 result.summary/tokensBefore/estimatedTokensAfter，需同步收紧类型（可复用 ports/pi-engine.ts:50-55 已存在的 PiCompactionResult 形状）。文档未列入。 | M4 一并改 pi-protocol 事件类型（result 改为 CompactionResult 镜像），补入改动地图 |
| INFO | 全文行号引用 | P0-11 次要 | xyz 侧行号少量漂移（内容均核实无误）：session-history.ts:22-83→实际 24-77、:72→74、:210-220/:203-218→实际 239-244；entry-tree-builder.ts:93-115→实际 84/92-116；session-manager.js:805/822/868→实际 803/820/866（各差 2）；「useChat.ts:191/195」→实际 packages/core/src/domain/chat/useChat.ts:186/190（chat store 已迁 @xyz-agent/core）；「pi 0.80.3」两处（§3.3.5）→实际依赖 0.84.1（package.json:32），行为已在 0.84.1 dist 核实无误。pi dist 关键行号（1370/1448-1463/1470-1476/1608/1690-1694）精确。 | 实施前按现源重刷行号 |

## 已核实的事实清单（对抗式验证结论）

| 文档断言 | 判定 | 证据 |
|---|---|---|
| RPC 路径丢 compaction/branch_summary/custom_message | ✅ 属实 | entry-tree-builder.ts:92-116 第一遍扫描仅处理 custom/client-msg-id 与 message，其余「跳过（未来扩展点）」 |
| 文件路径放行四类 + 伪消息映射 | ✅ 属实 | session-history.ts:24-77 mapEntriesToPiMessages |
| convertPiHistory 两路共用、role 分支完整 | ✅ 属实 | message-converter.ts:189/196/231/253/283/308 |
| auto-compaction 事件被 NULL_EVENTS 吞 | ✅ 属实 | event-adapter.ts:667-671 |
| dispatcher 手动编排 compacting→summary→compacted | ✅ 属实 | message-dispatcher.ts:423-498 |
| get_messages 零生产调用方 | ✅ 属实 | rpc-client.ts:511；全仓仅 port 声明与测试引用 |
| P-compaction-end-result（result 含 summary/tokensBefore/estimatedTokensAfter） | ✅ 属实 | agent-session.js:1452-1468（手动）、1688-1694（自动），另含 firstKeptEntryId/usage/details |
| P-manual-reason（RPC 手动 compact 同样发事件） | ✅ 属实 | rpc-mode.js:416-418 `case "compact": session.compact()` → agent-session.js:1370 `compaction_start{reason:'manual'}` |
| 失败路径带 errorMessage/aborted | ✅ 属实 | agent-session.js:1472-1478；自动侧 :1715（overflow 特殊文案） |
| 四类 entry 的 pi 写入点存在 | ✅ 属实 | session-manager.js:803/820/866/1059（行号差 2） |
| message_start 从不为 compactionSummary/branchSummary 发 | ✅ 属实 | agent-session.js:380「persisted elsewhere」为 dist 全文唯一命中 |
| entry_appended 未登记（会刷 warn） | ✅ 属实 | pi 侧 emit agent-session.js:1868；xyz 侧 pi-protocol.ts:400 已声明但 adapter 无 handler 无登记（translate :747-749 warn 路径） |
| agent_start hook 分支不可达 | ✅ 属实（裁决理由错，见 SUGGESTION） | NULL_EVENTS :668 先吞，translate :736 先 return，:739 分支永不触发 |
| 「前端已有 session.compacting/compacted handler」 | ✅ 属实（位置引用过期） | packages/core/src/domain/chat/useChat.ts:186-208 |
| convertPiHistory 只给 user/assistant 填 piEntryId | ✅ 属实 | message-converter.ts:128-135 + entryIds 仅 user/assistant 分支消费 |
