# subagent-workflow 侧边栏状态同步设计 — 对抗式审查报告

> 审查对象：`docs/todo/subagent-workflow-sidebar-sync-design.md`（v1，commit e2ba11be0 基准）
> 审查依据：`rubric-design-doc.md`（对抗式清单）+ 项目 AGENTS.md 约定
> 审查方式：全部事实引用逐一 read 源码核实（runtime / renderer / core / extensions / pi dist 0.84.0，workspace 捆绑 0.84.1）
> 本报告只报告不修改待审文档。

## Summary

4 must-fix, 5 suggestions.

总体判断：文档结构完整（五段骨架 / SCQA / 结论先行 / 方案四选一对比 / 探针表 / 物理数据流图齐备），F1-F5 失败模式与绝大多数行号引用经源码核实**属实且精确**。方案 B「无状态信号 + RPC 重拉」对 F1-F3、F5 的因果链成立。**但「地基事实」A2 的探针锚在了 bg-notify 实际不可达的代码分支上，真实路径是 emit 先于落盘**；subagent 域的 pi 崩溃场景构成三个对账点都兜不住的反例；决策 6.2 复用 notifyDone 会带来未评估的自发 LLM turn 副作用；§8 验收遗漏设计核心机制（信号丢失收敛）。以上四项修复前不建议进入实施。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.1 A2 / §6.1 方案 B 风险栏 / §5.1 | P0-11 事实 | **A2 探针引用的代码路径对 bg-notify 不可达，「先写盘后发事件」不成立**。`agent-session.js:1068-1097` 的 `sendCustomMessage`：文档引用的 1092-1097 else 分支（`appendCustomMessageEntry` → `_emit`）仅在「非 nextTurn 且非 streaming 且非 triggerTurn」时执行；bg-notify 恒带 `triggerTurn:true, deliverAs:'steer'`（notifier.ts:223-234 已核）→ 空闲走 1089-1090 `_runAgentPrompt` 分支、streaming 走 steer 分支，**永远到不了 else**。实际持久化点在 `_handleAgentEvent`（agent-session.js:369-374）：`message_end{role:'custom'}` 时先 `await _emitExtensionEvent` + `_emit`，**之后**才 `appendCustomMessageEntry`。而 runtime 的 bg-notify 信号源自 `message_start`（event-adapter.ts:520-534 翻译为 `message.customStart`），`message_end` 在 NULL_EVENTS 不转发（event-adapter.ts:709）——**信号到达 renderer 时，entry 结构上尚未落盘**。「信号到达那一刻磁盘已经是新的」这一被称为「地基」的断言在机制层面是错的；实际安全性来自（a）pi 侧同一同步任务内完成 appendFileSync、（b）跨进程 RPC 往返时序、（c）turn 结束对账兜底——三者都是隐式不变量，文档一个都没写。影响：notify 信号立即重拉可能读到写前快照（`applyRecords` 用旧全集替换），§5.1「立即收敛」无保证；且方案 B 只给 `kind:'started'` 配了 500ms 重试，`kind:'notify'` 无兜底 | 重跑 A2 探针并改锚：验证 `_handleAgentEvent` 的 emit→persist 顺序 + event-adapter `message_start` 派生路径；A2 结论改写为「notify 信号的重拉存在窄竞态，收敛由 message.complete 对账保证（有界）」，或给 notify 也加迟滞/空结果重试；§5.1 时间线的「立即收敛」降级为「通常立即、保证有界」 |
| MUST_FIX | §2 目标 1 / §3.2 / §5.2 / §6.5 / §8 | P0-10 + P0-12 对抗/遗漏 | **subagent 域 pi 崩溃（kill-9）场景：三个对账点全部失效，目标 1 的绝对断言存在反例**。反例链：后台 subagent 运行中 pi 进程 kill -9 → 终态写主 session JSONL 的**唯一通路**是 extension 内 notifier 的 bg-notify（父进程死则永不再写）；`.finalized` sidecar 也由父扩展写（finalize-record.ts:24 → finalized-marker.ts），孤儿子进程完成也无法补；extractor 无 notify/listItem 时 `normalizeSubagentStatus(falsy)` 回落 **running**（subagent-extractor.ts:227-229 + subagent-status.ts）→ 磁盘真相源永无终态 → `message.complete`/`session.exited`/重连三个对账点重拉到的都是 running → **永久 running**。决策 5 只豁免 graceful 级联关闭（/new、/fork、session_shutdown 的 `disposeAllRecords`，subagent-service.ts:402-434 + record-store.ts:822-826 均已核实），**kill-9/crash 不在豁免范围**；决策 6 只修 workflow 域；§5.2 失败表第 3 行只有 workflow；§8 场景 4 只测 workflow。目标 1「任何场景不会永久卡 running」按字面不成立 | 二选一：(a) 收窄目标 1 措辞（排除「磁盘真相源自身无终态记录」场景），决策 5 豁免范围显式扩展到「pi 崩溃后 subagent 终态缺失」，把「进程已不存在的 running」UI 弱化从 out-of-scope 升级为该场景的显式兜底指向；(b) 类比决策 6 补 subagent 恢复落盘缺口（session 重开时 extension 重建发现 pid 已死 → 补写终态/补发信号）。无论选哪个，§5.2 与 §8 补 subagent kill-9 行/场景 |
| MUST_FIX | §6.6 决策 6.2 / §7.4 / §8 场景 4 | P0-12 副作用 | **恢复路径复用 `notifyDone` 会在 session 重开时自动触发一个主 agent LLM turn**。`notifyDone` 以 `{triggerTurn:true, deliverAs:'steer'}` 发送（helpers.ts:271-279 已核）；kill-9 恢复发生在 `session_start`（index.ts:466-475），此时 agent 空闲 → pi `sendCustomMessage` 走 triggerTurn 分支 `await _runAgentPrompt`（agent-session.js:1089-1090）→ **用户只是重开 session，agent 就自发跑一轮**（token 消耗 + 未请求的自主行为；failed reason 还会附带「This is NOT task completion. Summarize…」收尾指令，helpers.ts:213-220）。文档只论证了「通知语境成立」，未评估 turn 副作用。且 sidebar 收敛真正需要的只是 entry 落盘 + `message_start` 事件（runtime `handleWorkflowResult` 的信号源）——`triggerTurn:false` 的注入同样满足，还顺带走的是真正「先写盘后发事件」的 else 分支 | 恢复路径补发改用不带 `triggerTurn` 的 `pi.sendMessage`（或经 `display` 通道），与「唤醒 agent 继续编排」的正常完成通知分离；§8 场景 4 通过标准补充「重开 session 后主 agent 无自发 turn」 |
| MUST_FIX | §8 | P0-15 + P0-13 验收 | **验收遗漏设计核心机制，且场景 5 验证的是错误路径**。① 六个场景全部是「正常信号到达」路径，没有一个端到端验证「信号/帧丢失后靠对账点收敛」——这是整个设计的核心主张（§6.3 决策 3 的存在理由），§10 U2 只在单元层提了「杀 WS 帧」方式，§8 无对应场景。② 场景 5「重启 dev（模拟 runtime 重启/重连）」会同时重启 Electron/renderer：renderer store 全新、重开首拉本身就会拉数据，**第三个对账点「重连成功后对存活 store 全量重拉」根本没有被行使**——场景通过不能证明该机制工作（重开首拉混淆了通过条件） | §8 增加「信号丢失收敛」场景：在 notify 信号发出前后断开 renderer↔runtime WS（或只杀 runtime 子进程）保持 renderer 存活，验证侧栏在下一对账点（turn 结束/重连）有界收敛；场景 5 改为只杀 runtime 子进程（保 Electron/renderer 存活）验证重连全量重拉 |
| SUGGESTION | §7.1 / §7.2 | P0-12（不阻塞）遗漏连带 | 删除 `'session.subagents'` push 类型的连带改动未列全：`protocol.ts:1271` 的 RPC reply `'session.getSubagents'` **复用** `ServerMessageMap['session.subagents']` 形状，直接删类型会破坏 reply 映射；`STATE_TYPE_KEY_MAP`（message-bus.ts:131-137）、core 层 `ROUTE_TABLE`/`InboundEffects`（route-inbound.ts:173-219 / 90-96）与 `useMessageEffects.handleSubagents` 需同步改 | §7 补连带清单，或注明「RPC reply 形状与 push 类型解耦后才能删」；顺带确认新 transient 类型必须显式入 `TOPIC_TABLE`（未入表 fallback 是 'stream'，违背设计意图，message-bus.ts:109-115） |
| SUGGESTION | §8 场景 1 | P1-8 事实（可执行性） | 观测路径写死 `~/.pi/agent/logs/`：桌面应用数据目录隔离（项目 AGENTS.md 约定 `~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离），extension-logger 写 `<getAgentDir()>/logs/`（extension-logger/src/index.ts:179-199），桌面内为 `~/.xyz-agent/pi/agent/logs/`（pi-paths.ts:66-69）；执行者按文档会找错位置导致通过标准里的观测项失败 | 观测路径改为从 `getDataDir()`/`getPiAgentDir()` 动态推导的表述（项目排查规则也禁止写死绝对路径） |
| SUGGESTION | §7.3 | P0-12（不阻塞）边界 | extractor 空数组语义合并：`readFileSync` 失败返回 `[]`（subagent-extractor.ts:107-110）、`scanSessions` 找不到 session 也返回 `[]`（session-service.ts:660-662/687-689）——「读取失败」与「无记录」不可区分；`applyRecords` 全量替换会把已有历史瞬时清空到下一对账点。现状 M1 错误语义只防 RPC reject，防不了「成功返回空」 | 下一层设计时区分 error/empty（如 RPC 层带 error 字段），或对「prior 非空且新结果为空」做守卫/仅日志；至少在 §11 检查点记录该边界 |
| SUGGESTION | §9 M1 / §10 U1 | P1-5 | M1 过渡期 runtime「新旧并播」（全集广播仍在），F1 症状（内存全集覆盖磁盘历史）在 M1→M2 之间仍会短暂出现；§9 只说「renderer 双保险就位」，未注明过渡症状窗口 | M1 行补一句过渡症状说明（列表仍可能闪退回退，M2 消除），避免实施期误判回归 |
| SUGGESTION | §3.1 / §7.3 | P1-8 事实（细节） | 三处归属/行号不精确（不影响决策）：① `session-service.ts:1117` 是 `adapterFactory` 调用点，`new EventInterpreter` 实际在 `runtime/src/index.ts:224`（组合根），「初始化为空且不回放」的实质正确；② §7.3 把 `routeInbound` 列在 Renderer 小节，实际在 `packages/core/src/coordination/route-inbound.ts`；③ `message-bus.ts:97-106` 是 transient 表条目位置，三分类语义描述在模块头（L7-9）与 `publish()`（L218-223） | 按源码修正锚点；routeInbound 移到 core 层改动清单 |

## 已核实为准确的关键引用（抽样）

对抗审查同时确认了以下高频引用**属实**（防止实施者重复怀疑）：`broadcastSubagents`（event-interpreter.ts:628-636）、`if (!existing) continue`（同文件:603）、`subagentRecords`/`pendingStartParams` 内存态（:151/:153）、`applyRecords` 全量替换（subagent.ts:117-119）、RPC 失败保留旧数据（subagent.ts:145-149）、`triggerWorkflowReload` + `RUNNING_RETRY_MS=500`（workflow.ts:161/:176-191）、getWorkflows/getSubagents 无缓存现读磁盘（session-service.ts:656-663/685-690）、kill-9 恢复循环无 `store.save`（index.ts:466-475）、`terminateRunningRuns` 落盘不通知（lifecycle.ts:291-330，rationale 注释 304-306）、`disposeAllRecords` 不落盘（subagent-service.ts:402-434，archive 仅内存删除 record-store.ts:250-253）、重建回落 running（record-store.ts:822-826）、notifier 60s 滑窗与立即 flush（notifier.ts:76/:126-156/:150-153）、A1 同步落盘（session-manager.js:739-752 `_appendEntry`→`_persist`→`appendFileSync`）、A3 triggerTurn（notifier.ts:223-234；steer 入队场景由 drain-then-agent_end 兜底，turn 结束必有 message.complete，结论成立）。

## 调用方四个特别审查点的结论

1. **方案 B 是否真解决 F1-F5**：F1（删平行真相源，结构上消除）、F2（无内存可 miss，信号无状态转发 + 重拉）、F3 workflow 半（磁盘已对，靠 focus/重连对账刷新）、F5（≤60s 窗口 + turn 对账，有界）——因果链成立。F3 subagent 半与 F4 靠决策 5 豁免 / 决策 6 修复成立，**但 subagent 崩溃场景滑出五类失败模式之外**（见 MUST_FIX 2）。另：方案 B 风险栏对 notify 信号重拉竞态的自我评估依赖了错误的 A2（见 MUST_FIX 1）。
2. **§8 是否真实可执行非 mock**：场景 1-4、6 真实可执行（真实 pi 子进程 / 真实磁盘 / 真实 kill -9），非 mock；但场景 1 观测路径写死错误目录（SUGGESTION），场景 5 验证路径失真、核心「信号丢失收敛」无场景（MUST_FIX 4）。
3. **三个对账点是否覆盖所有信号丢失场景**：覆盖「信号延迟/丢失但磁盘已新」的全部场景（turn 内丢失→message.complete；切走→focus 首拉；断连→重连重拉；帧级丢失在本地 loopback 仅伴随断连发生）。**反例 = 磁盘真相源自身无终态**：subagent 域 pi 崩溃后终态 entry 永缺，三个对账点重拉结果相同（running），无法收敛（MUST_FIX 2）。
4. **A1/A2 探针引用是否属实**：A1 属实（`_appendEntry` → `_persist` → `appendFileSync`，同步）；A2 结论侥幸成立但**机制引用错误**——cited else 分支对 bg-notify 不可达，真实路径 emit 先于落盘且 runtime 信号源自 `message_start`（MUST_FIX 1）。另注：已核 dist 为 0.84.0，workspace 捆绑 0.84.1，A7 实施期门设置正确且必要。

## 附：M0 阶段建议增补的探针

基于上述发现，M0 除 A5/A7 外应增加：A2'（bg-notify 实际路径的 emit→persist 时序探针：事件到达 runtime 瞬间读主 JSONL 是否已含 entry）；A8（决策 6.2 恢复通知是否触发 LLM turn 的行为探针）。
