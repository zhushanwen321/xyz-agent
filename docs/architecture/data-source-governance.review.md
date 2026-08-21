# data-source-governance.md 对抗式审查报告（复审）

> 审查人：tech-design-review（对抗式）。审查对象：`docs/architecture/data-source-governance.md`（c8def4a0c「revise data-source-governance to end-state architecture」修订版）。
> 事实核实基准：xyz-agent 工作区源码 + pi 上游 main（0.80.3，`~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`）+ 项目实装 `@earendil-works/pi-coding-agent@0.84.1` dist（worktree node_modules 内逐一 grep 核实关键 API 存在性与行为，两版一致）。
> 与上一轮审查的关系：上一轮 3 个 MUST_FIX 中，session_end 归类错误（D3 改判 sidecar 单写方合法）、sidecar 迁移遗漏（选项 a 维持 sidecar）、空值合并规则反例均已在本版正面处理；但「空值合并规则」的反例本身引用了错误事实（见 MUST_FIX #1），该错误源自上一轮审查报告并被本版照单吸收，本轮以源码核实纠正。

## Summary

3 must-fix, 9 suggestions.

核心结论：本修订版的根因诊断（缺 owner 结构）、五条终态原则、方案对比与验收设计整体成立，D2/D4/D5/D6/D7 的关键事实经源码核实全部为真（核实清单见附录）。但存在 1 处影响决策的事实错误（D1b 的支撑反例 thinkingLevel 永不为 undefined，该反例是规则 1 的论证支柱且将进登记表）、1 处现状机制描述失真（失败模式 B 的引文与机制描述与当前代码不符）、1 处方案级遗漏（现有 session.subscribe/ring/stateSnapshot 快照机制的去留未处置）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D1b | P0-11 事实 | **「thinkingLevel 合法值含 undefined」反例不成立，规则 1 的论证支柱是虚构的**。核实依据：pi `ThinkingLevel` 类型（0.80.3 `packages/ai/src/types.ts:74-75`；0.84.1 `pi-agent-core/dist/types.d.ts:260`）= `"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"\|"max"` 具体字符串联合，**不含 undefined**；`AgentState.thinkingLevel` 必填（agent.ts:76 初始化 `initialState?.thinkingLevel ?? "off"`）；`setThinkingLevel` 对不支持思考的模型经 `clampThinkingLevel` 钳到 `"off"` 或可用档位，恒为具体值。即「切到不支持思考档位的模型时权威真值就是空」不成立——权威真值是 `"off"`，不是空。文档（含上一轮审查）把 xyz 侧缓存签名 `string \| undefined`（session-service.ts 的踩坑症状）误当成了 pi 权威值域，恰是本文档自己要消灭的「把影子状态当权威」的混淆。影响决策：D1b 明确要求「字段空值语义是 ReplicatedState 配置的一部分」，该错误将使登记表登记一条**权威值域中不存在**的语义条目（thinkingLevel 空 = 合法态），误导 P1.1 实现者写死代码处理不可能出现的状态。规则 1 本身正确（真实反例存在，见下），但论证支柱须换 | 用真实反例替换：`get_session_stats` 之外，`get_state.sessionName` 的合法值为 `string \| undefined`（未命名 session，agent-session.ts:892 / session-manager.ts:1067），且 session-manager 注释明言「Empty names explicitly clear the session title」——空名是显式语义而非占位。登记表条目改为「sessionName 空 = 合法态（未命名），必须整字段覆盖；thinkingLevel 无空值语义，永不 guard」 |
| MUST_FIX | §2.1 失败模式 B | P0-11 事实 | **失败模式 B 的机制描述与引文失真**。(a) 引文「renderer `subscription-state.ts` 注释自认该风险」——该文件实际是 `packages/core/src/coordination/subscription-state.ts`（已从 renderer 迁移，IF5），其「永久丢失」注释（:293）讲的是 **W09 删除 broadcast 兜底后订阅不重建**导致的丢失，不是 ring 溢出自认；(b) 当前 runtime 已有 `session.subscribe` RPC + ring snapshot + **state 类 last-value stateSnapshot** + gap→全量重拉机制（session-message-handler.ts:316-326；message-bus.ts:80 话题分类表）：用量/模型属 state 类，重连由 stateSnapshot last-value 兜底，**不存在「ring 溢出即永久丢失」**；只有 stream 类（消息流、queue_update）受 ring 溢出影响，且溢出时 gap=true 触发全量重拉。「断连期间丢失的事件是否被 ring 快照回放覆盖」作为现状主机制的描述与代码不符。影响决策：失败模式 B 是问题定义的三大证据之一，机制描述失真会误导实施者认为「重连自愈是全新机制」，而实际上现有基础设施已部分具备快照语义 | 按源码改写失败模式 B：state 类数据靠 stateSnapshot last-value（数据源是 runtime 影子缓存——缓存自身多写方才是漂移根源）；stream 类受 ring 覆盖窗口限制。把论证重心放回真正的问题：stateSnapshot 兜底的是**影子缓存**而非 pi 权威，这正是 ReplicatedState 直拉 pi 快照的动因 |
| MUST_FIX | §3.4 / §3.3 D7 / §5 P1/P2 | P0-12 遗漏 | **现有 session.subscribe / ring / stateSnapshot / gap 检测机制的去留未处置**。§2.2 #12 承认 stateSnapshot 是触点之一，但 §3 五条原则与 §5 P1-P4 单元对这套现有快照机制（订阅、ring、话题分类、last-value 兜底）只字未提。P1/P2 落地时实施者将面临未规划的双通道决策：旧的事件广播管道（含 stateSnapshot 重连兜底）与新的 ReplicatedState 快照推送并存——若不收编，renderer 重连仍会从 stateSnapshot 收到 runtime 影子缓存快照，恰是设计要消灭的通道，「投影一次」原则被架空；若收编，哪些话题、哪些 handler、stateSnapshot 的数据源如何切到 ReplicatedState 均无计划。这是方案成立依赖的关键衔接 | 在 D7 或 §5 增加一个单元：声明 subscribe/ring 机制作为 ReplicatedState 快照的**推送通道复用**（state 话题数据源从事件直写切换为 ReplicatedState 发布），还是退役重写；列出受影响话题清单（session.state_changed、context.update 等 state 类）与迁移顺序 |
| SUGGESTION | §3.3 D1b | P0-12 补充 | **wire 层空值语义未定义**：`get_state` 的 `sessionName` 为 undefined 时 JSON.stringify 丢弃该键（RPC 响应中 key 缺失），「整字段覆盖含显式空值」在 wire 层实际是「key 缺失」。ReplicatedState 合并必须定义「缺失 key = 显式空值覆盖」还是「缺失 key 不动」，否则换用真实反例（sessionName）后仍会在实现层制造歧义 | D1b 补一条：快照解析时按字段 schema 归一（缺失 key 按该字段登记的空值语义处理），与 MUST_FIX #1 的登记表条目联动 |
| SUGGESTION | §1 G1 / §3.1 样例 2 / §4 场景 2 | P0-10 对抗 | **G1 队列目标表述与验收标准矛盾**：G1 说「断网重连后队列显示与**断连前**一致」，但若断连期间 followUp 被 pi 消费（场景 2 步骤即含「期间 pi 完成一轮回复」），正确目标是与**pi 当前队列**一致；§4 场景 2 通过标准正是「队列深度与 get_state.pendingMessageCount 一致」（与 G1 表述冲突）。且 D6 内容对账仍依赖 queue_update 事件——已核实 `message.queue_update` 属 stream 类（message-bus.ts:80），入 ring、溢出即丢、重连不重发；深度有 pendingMessageCount 结构性对账，**内容没有**，偏差只能等下一次队列活动自愈 | G1 措辞改为「队列深度与 pi 当前值对账一致，内容基于 renderer 本地副本」；样例 2 明示内容对账的残余风险边界（事件丢失且队列静默期间，条目列表可能有界陈旧，深度始终正确） |
| SUGGESTION | §3.3 D6 | P0-10 对抗 | **计数 FIFO 差集假设可被扩展注入破坏**：pi ExtensionAPI 的 `sendUserMessage(content, {deliverAs: "steer"\|"followUp"})`（types.ts:1545 附近）允许扩展向 pi 队列注入 steer/followUp，这些项不在 renderer 提交日志中，差集算术（提交数 − pi 队列数 = 已投递数）失效。另核实到 pi 队列存的是**展开后文本**（steer() 内先 `_expandSkillCommand` + `expandPromptTemplate` 再入队，agent-session.ts:1243-1280）——这印证了删除文本匹配的必要性（展开后文本与提交原文对不上），计数方向正确，但需堵扩展注入的洞 | D6/登记表补一条规则：「queue 内容唯一提交方 = renderer（经 WS steer/followUp）」，扩展 deliverAs 注入路径或禁止、或按已知写方计入差集（推荐前者，登记为已知例外） |
| SUGGESTION | §3.3 D3 / §5 P4.2 | P0-12 遗漏 | **ADR-0042 正文与实现矛盾，修订未安排**：ADR-0042（docs/adr/0042-runtime-session-end-entry.md）正文仍是原决策「runtime append session_end 到 JSONL」，sidecar 列为被否替代方案；W1 修订只存在于代码注释（session-file-utils.ts:107）。P4.2 只安排新增 ADR-0062，未安排修订 ADR-0042——「治理即代码」原则下决策记录与实现矛盾，未来 reviewer 拿 ADR 当准绳会误判 sidecar 为违规 | P4.2（或 P3.2）增加「修订 ADR-0042 落档（W1 sidecar 修订）」，对齐项目「推翻 ADR 需显式落档」惯例 |
| SUGGESTION | §2.2 清单 / §3.6 第 4 层 | P0-12 遗漏 | **12 类清单缺 plugin sessionData**：plugin 系统的 per-session KV（runtime/services/plugin-service/session-data-store.ts，configDir/session-data/ 持久化，WriteBackCache + 定时 flush + 磁盘恢复）+ plugin:statusBarUpdate 等 WS 推送是用户可见 GUI 数据，不在 12 类清单中（现状为单写路径、已 owner 化，非多源病灶，但登记表 SSOT 不覆盖它）。G2 承诺「任何 GUI 数据可查 owner」对插件数据落空 | 清单补第 13 类或登记表声明「plugin sessionData：权威 = SessionDataStore（单写路径，已 owner 化）」，维持 G2 的完整性 |
| SUGGESTION | §3.5 / §5 | P0-12 回滚 | **「每阶段独立可验收可回滚」无回滚计划**：各阶段回滚触发条件、回滚验证方式（尤其 P1.3 删 sessionMetaCache 类删除性变更、P2.1 renderer 写入口收敛后等价性测试基线如何跟随回滚）未定义 | §5 补每阶段一句话回滚方式（revert 该阶段 commit + 等价性测试基线对应回退） |
| SUGGESTION | §5 P0.5 | P0-16 探针 | **「RPC 快照频率影响」探针无失败预案**：冷启动探针有候选缓解（warm utility pi），RPC 频率探针没有——而 P1.1 的防抖重拉机制在 P0.5 量化前已定型，若量化不达标（RPC 频率过高 / 延迟感知明显），调整点（防抖窗口、批量快照、仅活跃 session 拉取）未声明。另回答任务提问：P0.5 未量化**不阻塞** P1.4——P1.4 是 P1 末单元，P1.1-1.3 不依赖探针结果，且冷启动形态已有候选缓解 | P0.5 补 RPC 频率探针的失败预案（量化超阈值的降级选项），并在 P1.4 注明依赖关系为软依赖 |
| SUGGESTION | §5 待验证检查点 D5 | P0-16 探针诚实性 | **D5 探针（entry_appended 对 message entry 是否发射）设计阶段即可从源码回答**：已核实 0.80.3 `entry_appended` 全库仅两处——类型定义（agent-session.ts:140）与扩展 appendEntry 路径发射（:2269）；0.84.1 dist 同样只有 appendEntry 路径。答案确定：message entry 的 `_persist` **不发射**。标「设计阶段无法确定」不诚实，且 P3.3「按 D5 探针结果定形态」是不必要的开放问题——形态可提前决策（文档自己已写了 fallback：message_end 等事件重构 entry + 等价性测试断言同构） | D5 探针改 ✅ 已核实（不发射），P3.3 直接定形态并保留「若 pi 上游补发射则无缝切换」的演进说明 |
| SUGGESTION | §3.6 S1 / §5 P0.3 / 文件改动地图 | P1-8 事实 | **S1 接入状态表述过时**：review-data-governance.md 与 SKILL.md 8 维表已在本文档同一提交（c8def4a0c）落地（此前为 7 维），P0.3「S1 接入 pr-cr-fix（7 维 → 8 维）」与文件改动地图「维度表 7 → 8（S1 接入）」把已完成工作列为待交付，实施 P0 时可能重复交付或产生歧义 | P0.3 改为「S1 已随本文档接入；P0 剩余工作 = R1/R2/R3 机器检查 + 登记表」，文件改动地图标注已落地 |
| SUGGESTION | §2.2 #9 / §2.1 | P1-8 事实 | **引文细节失真（不影响决策，汇总列出）**：①「workflow.ts:171（文件 lag 重试）」——extensions/subagent-workflow/src 下无 workflow.ts，state 文件现为 orchestration/jsonl-run-store.ts（deserializeRun 处为 D-5 version guard），引文失效；②「pi 无 model_changed 事件」（D7）结论正确但表述可精确化：pi 有 `model_select` 扩展事件（agent-session.ts:1459-1470），但只经 `_extensionRunner.emit` 发送、**不经 session.subscribe 转发**（RPC 客户端不可见）——「RPC 层无 model 事件」才是准确表述；③ 其余 pi 行号已逐一核实，均在 ±3 行内（get_state~443、get_entries~608、set_session_name~632、appendSessionInfo:2719、queue_update:503-508），0.84.1 dist 关键 API 存在性与行为一致，可保留 | ①补 workflow 引文的真实位置或删除该引文；②D7 表述精确化；③行号无需修改 |

## 四大审查方向结论

1. **对抗式（找反例/攻击面）**：D1b 规则对的结构自洽（两条规则适用域不同：owner 快照 vs 磁盘扫描占位），但支撑反例被源码击穿（MUST_FIX #1）；D6「按字段分权威」的「无 pi 通道」宣称经穷尽核实成立（RPC 命令全集无队列内容、ExtensionAPI 仅 hasPendingMessages、queue_update 是唯一内容出口但不可拉取），但内容对账仍残留事件依赖 + 扩展注入可破坏计数假设（SUGGESTION #3/#4）；D3 sidecar 合法性论证成立（sidecar 是 xyz 自有文件、单写方、pi 不读不写，绝对写规则管的是 pi 文件）；五阶段依赖链成立且 P0.5→P1.4 为带候选缓解的软依赖（SUGGESTION #8）。
2. **问题定义与根因（P0-4/P0-10）**：通过。SCQA 忠实于使用者问题，§2.4 根因（无 owner 结构）有 #12 修复后同类坑复发的证据链支撑；方案 B 的三大结构性事实（写只有一条路/派生一份码/对账通道恒在）直接命中根因。例外：失败模式 B 的机制描述失真（MUST_FIX #2）——根因方向仍对，证据表述须改。
3. **事实核实（P0-11）**：D2/D4/D5/D6/D7 引用的 pi API 与项目文件位置全部属实（见附录核实清单），0.84.1 dist 逐一复核一致；仅 D1b 反例（MUST_FIX #1）与失败模式 B 引文（MUST_FIX #2）两处事实错误影响决策。
4. **验收（P0-13/14/15）**：通过。§4 五个场景全部真实 pi 子进程 + 真实文件、无 mock；每个场景回溯 G1-G4；用具体业务例子（改名「重构计划」、followUp 对账、后台 subagent 注入）；通过标准可证伪可执行。场景 2 步骤「杀掉 WS 连接」手段未具体化、部分通过标准依赖人工对照 RPC——可加强但达到 testable 门槛。

## 附录：事实核实清单

| 文档宣称 | 核实结果 |
|---------|---------|
| rpc-mode.ts:385 固定 switch，扩展不可注册新命令 | ✅ 385 起 `switch (command.type)`，RpcCommand 为固定联合（rpc-types.ts:20 起） |
| get_state 含 sessionName/thinkingLevel/pendingMessageCount/messageCount | ✅ ~443（0.84.1 dist:357 pendingMessageCount 同） |
| get_session_stats = contextUsage 真值 | ✅ ~569 |
| get_entries 支持 since 游标、失效返回「Entry not found」错误 | ✅ ~608；0.84.1 dist:508 同 |
| set_session_name → appendSessionInfo 落盘 + session_info_changed | ✅ ~632；agent-session.ts:2719-2722 |
| appendEntry（types.ts:1261）→ appendCustomEntry 持久化 custom entry | ✅ 1261/1543 两处声明；agent-session.ts:2262-2273 |
| entry_appended 全量转发 RPC（rpc-mode.ts:354-356） | ✅ 354 `session.subscribe((event) => output(event))` |
| custom entry 不进 LLM context（session-manager.ts:377-385） | ✅ sessionEntryToContextMessages 仅处理 message/custom_message/branch_summary/compaction |
| session-manager.ts:92-95「扩展经扫描 customType 重建状态」官方通道注释 | ✅ 90-98 |
| queue_update 携带完整数组（agent-session.ts:503-508） | ✅ 503-508（steering/followUp 全量数组） |
| ExtensionAPI 无队列内容读口（仅 hasPendingMessages） | ✅ types.ts:325 / agent-session.ts:2306 |
| entry_appended 仅扩展 appendEntry 路径发射 | ✅ 全库仅 :2269 一处发射；0.84.1 dist 同（1 处） |
| pi 无 model_changed 事件 | ✅（model_select 存在但只发扩展，不转发 RPC——SUGGESTION #10） |
| thinkingLevel 可含 undefined | ❌ 不成立（MUST_FIX #1） |
| sessionName 可 undefined、空名清除标题 | ✅ agent-session.ts:892 / session-manager.ts:1067-1075 |
| rename-session 守卫 `if (pi.getSessionName()) { skip }`（index.ts） | ✅ :67-68 |
| runtime rpc-client 从未接线 set_session_name | ✅ 无匹配 |
| persistSessionName 直写 JSONL（session-lifecycle.ts:291-302） | ✅ |
| persistSessionEnd sidecar（session-file-utils.ts:111-157）+ 规则 #6 + 写后失效缓存 | ✅ 全部属实 |
| scannedToSummary 硬编码 modelId:''/tokenCount:0（session-scanner.ts:79-80） | ✅ |
| core store.ts:70 空串覆盖踩坑注释 | ✅ packages/core/src/domain/session/store.ts（updateSessionState 注释） |
| session-service.ts:450/461/837 踩坑注释 | ✅ 全部属实（thinkingLevel 恒 undefined 是 xyz 缓存症状，非 pi 权威） |
| message-converter.ts:44 双管线注释 | ✅ ~40-46 |
| NULL_EVENTS 含 entry_appended（event-adapter.ts:710-715） | ✅ ~703-712 |
| custom message 消费（event-adapter.ts:517-527） | ✅ |
| ADR-0042 原决策 append JSONL、W1 修订改 sidecar | ✅ ADR 正文未更新（SUGGESTION #6） |
| pr-cr-fix 7 维 → 8 维 | ✅ 已在 c8def4a0c 同提交完成（SUGGESTION #9） |
| ADR 最高编号 0061 | ✅ docs/adr/0061-cw-store-repo-level-keying.md |
| session.getSubagents RPC 存在 | ✅ session-message-handler.ts:255 |
| subscription-state.ts 在 renderer | ❌ 实为 packages/core/src/coordination/（MUST_FIX #2） |
| queue_update 属 stream 类（入 ring） | ✅ message-bus.ts:80 |

## 总体裁决

**需修改后通过**。3 个 MUST_FIX 均为可低成本修复的事实/处置问题，不推翻五条终态原则与方案 B 的推荐方向：D1b 换真实反例（sessionName）即可，规则对自洽；失败模式 B 按现有代码机制改写论证重心；现有快照机制的去留补一个 P1/P2 单元。修复后本方案可进入实施。
