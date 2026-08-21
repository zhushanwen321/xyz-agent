# data-source-governance 父子文档对抗式审查报告（r2）

> 审查人：tech-design-review（对抗式，rubric `P0-N`/`P1-N` 判定）。审查对象：父文档 `docs/architecture/data-source-governance.md`（b8b67a5d6 版，技术方案层）+ 子文档 `docs/architecture/data-source-governance-plan.md`（783 行，实现计划层），一次审查。
> 事实核实基准：xyz-agent 工作区源码（runtime/core/extensions/githooks/taste-lint 逐一 read/grep）+ pi 上游 main（`~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`，注意真实路径为 `modes/rpc/rpc-mode.ts` 与 `core/agent-session.ts`）+ 实装 `@earendil-works/pi-coding-agent@0.84.1`（node_modules dist 已复核关键 API）。
> 防复发输入：上轮报告 `docs/architecture/data-source-governance.review.md`（3 MUST_FIX + 10 SUGGESTION），逐条复验见下文专节。
> 已定论探针（按任务约定不重开）：pi 冷启动中位数 ~500ms；`entry_appended` 对 message entry 不发射（D5 形态 = message_end 重构）。

## Summary

2 must-fix, 5 suggestions, 2 info.

核心结论：上轮 13 条 finding **全部真实修复**（无复发、无表面改字，见防复发表）；父子一致性总体成立（19 个单元全映射、决策承接无曲解、仅 1 处登记语义歧义）；五条终态原则、方案 B、D1-D8 的关键事实经本轮重新独立核实全部为真。但本轮新发现 **2 个影响执行决策的遗漏/事实错误**：① `tryPersistLabel`（turn_end/agent_end 对活跃 session 的 session_info 直写兜底路径）未被 W1 处置、未进登记表例外、未进 R1 allowlist，W1「pi 成为 session 文件唯一写方」的目标在既定步骤下不成立；② 子文档 W5 声称复用 `rpc-client-bash.test.ts` 的「真实 spawn 先例 + pi binary 缺席 skip 惯例」，该文件实为全 mock 测试（`vi.mock('node:child_process')`），仓库内不存在任何真实 pi spawn 测试先例——「已核实」引用不实，W5/W22 的执行指引建立在虚假先例上。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | 子文档 W1（目标/任务步骤 2/验收 1）+ W2 步骤 3 + W3 步骤 2 与验收 4；父文档 §2.5 数据流图 / §3.3 D2「迁移期唯一 legacy 例外」/ §5 P0.1 | P0-12 遗漏 + P0-11 事实 | **活跃 session 的第二条直写路径 `tryPersistLabel` 被整方案遗漏**。源码核实：`packages/runtime/src/services/session/session-service.ts:1282-1285` `tryPersistLabel` 在 turn_end（`:878` `handleTurnUsageSideEffects`）与 agent_end（`:902` `handleTurnEndSideEffects`）兜底调 `sessionStore.persistSessionName` → `session-file-utils.ts:415-433` `openSync(filePath,'a')` 直接 append `session_info` 到 pi JSONL（该函数 L420 注释自认此兜底）。后果：(a) W1 只替换 `renameSession`（L296）一处调用，完成后活跃 session 仍存在 xyz 直写（首个 turn_end/agent_end 窗口），W1 目标「pi 成为 session 文件唯一写方」为假、父 D2「P0 只消灭活跃 session 直写」未达成；(b) W2 登记表「已知例外两条：① 非活跃 rename 直写」与现存写点集合不符（漏登活跃 session 兜底直写），登记表 SSOT 失真；(c) W3 R1 allowlist「初始唯一条目 = 非活跃 rename 的 persistSessionName」与验收 4「allowlist 覆盖现存唯一例外」按真实调用点集不成立——R1 要么误报 tryPersistLabel 调用点，要么因 allowlist 覆盖实现行而静默放行一个未登记的活跃写方；(d) 「label 旧值覆盖」竞态类别（事件晚到时内存 label 落后于 pi 已 append 的名字，xyz 再 append 旧值到文件尾）在 W1→W11 窗口对活跃 session 结构性残留，恰是本方案要消灭的模式 | W1 扩围：turn_end/agent_end 兜底直写与手动 rename 直写同源同性质，应同 wave 切换（label 持久化责任整体移交 pi——未命名 session 的 xyz 侧初始 label 退役为显示派生）或明确保留并登记；至少：W1 目标改为「rename 路径切换」，W2 例外登记补第二条（带 W11 期限），W3 allowlist 枚举全部真实调用点；父 §2.5 图补该写方 |
| MUST_FIX | 子文档 W5（前置依赖说明/涉及文件/步骤 1/步骤 3）、W22（步骤 3 依赖「W5 约定」） | P0-11 事实 | **「已核实的真实 spawn 先例」引用不实**。`packages/runtime/src/__tests__/rpc-client-bash.test.ts` 是全 mock 测试：L45 `vi.mock('node:child_process', () => ({ spawn: () => fakeProc }))`，文件头 docstring 自述「沿用 test/rpc-client.test.ts 的 mock node:child_process + readline 模式……投递伪造 pi response」；且该文件（及全仓测试）无任何「pi binary 不存在时 skip」的环境检测（`skipIf` 全仓零命中，`--mode rpc` 字面量在测试目录零命中）。仓库内不存在真实 pi spawn 测试先例。W5 步骤 1「可执行文件定位方式复用 rpc-client-bash.test.ts 现状」与步骤 3「沿用 rpc-client-bash.test.ts 的环境检测写法」把实施者指向不存在的模式；W22「pi binary 缺席环境的 skip 语义保持（W5 约定）」依赖一个需净新增的约定。等价性测试是本方案 G3 与 P0.4/W5/W22 的验收地基，其基建规模的「复用现成」前提不成立 | W5 改为「无既有先例，fixture 为净新增基建（spawn 命令形态按 workspace AGENTS.md 的 pi CLI 实测流程：`pi --mode rpc --session-dir <tmp>` + stdin JSONL）」，skip-if-no-pi 语义在 W5 步骤内自行定义；据此复核 W5 规模估计（M 是否需上调） |
| SUGGESTION | 父文档 §1 C / §2.5 图注 / §3.3 D1 表 | P1-8 事实 | **sessionMetaCache 写方/读者计数失真**。父文档三处分别称「4 个写方」「3 个写方」「label/thinkingLevel 各 3-4 写方」；实际生产写点仅 2 处 `setLabel`（`packages/runtime/src/index.ts:298`、`session-lifecycle.ts:289`），`setThinkingLevel` 生产调用 0 处，且 `getLabel`/`getThinkingLevel` 无任何生产读者（仅测试调用）——该缓存接近「只写死代码」。不影响处置结论（W9 删除更成立、风险更低），但「12 类问题载体」的例证强度与 W9「收编」表述应校准（实为纯删除；W9 自身的写点清单反而是准确的） | 父文档三处计数改为实际值，并注明该缓存当前无生产读者、W9 属删除性清理 |
| SUGGESTION | 子文档 W11 验收 1 | P0-13 验收精度 | `grep -rn "persistSessionName" packages/ --include="*.ts" \| wc -l = 0` 会把纯注释命中也计入（现存注释引用：`utils/jsonl.ts:60`、`session-service.ts:1279`、`session-file-utils.ts:96/443`、`types.ts:104`、`session-store.ts:5` 等）。照单执行要么验收误报失败，要么逼实施者删除解释设计缘由的历史注释——与项目「[HISTORICAL] 注释保留」惯例冲突 | 验收命令改为过滤注释（或「代码引用清零 + 注释命中逐条人工核对归属」两段式） |
| SUGGESTION | 子文档 §0 首句 | P1-8 事实 | 「父文档 §5 的 17 个单元」计数错误：实际 19 个（P0 5 + P1 5 + P2 3 + P3 3 + P4 3），§0 映射表自身 19 行齐全、无遗漏 | 改 19（映射完整性本身无问题） |
| SUGGESTION | 子文档 W3 涉及文件注 / 验收 3 | P1-8 事实 | 两处计数失真：①「.githooks/ 已有 check_path_whitelist.py 等 14 个 checker」——实有 13 个 .py checker；② 验收 3「既有 7 个 checker 段」——生成的 pre-commit 内实有 16 行 `CHECKER=`（842 行 heredoc 实测）。差分断言「比改前多 1」本身仍可执行，但基线数字错会误导核对 | 两处数字按实测改（13 / 16） |
| SUGGESTION | 父文档 §3.3 D1b 末条 + 子文档 W2 步骤 2 / W7 步骤 1 | P0-6 + P1-5 | **同一数据链登记了相反的空值语义**：「sessionName 空 = 合法态（未命名，必须整字段覆盖）」与「label 空 = 未设置（可守卫）」同时落登记表；但 W7 的 label 实例配置 fetch = `get_state().sessionName`、语义 = 覆盖——label 是 sessionName 的投影，两条相反语义未说明各自适用域。P1.1 实现者写 ReplicatedState 配置时将面对矛盾登记。另：D1b 论证句「用户清空名字后 owner 将永远保留旧名」机制不准——pi `set_session_name` RPC 显式拒绝空名（rpc-mode.ts:633-637「Session name cannot be empty」），「清空」无法经 RPC 到达 pi；sessionName 为 undefined 的真实来源是未命名初始态与文件级空 session_info，规则本身仍成立但反例叙事应改 | 删除「label 空 = 可守卫」或明确其仅指磁盘扫描占位语境（该语境已由第三条规则覆盖，应合并）；「用户清空名字」改为「未命名 session 的初始快照为 undefined」 |
| INFO | 子文档 W12 步骤 1（commit 4/5） | P1-6 | `session.subagents` / `session.workflowUpdate` 的「包装实例」在 W12→W18 窗口写入口仍是事件流（事件直写数据，非「事件只做失效」）——两文档均已明示为过渡结构（W18 换底层源为 entry 扫描），不算父子矛盾；建议登记表为这两个条目标注过渡态与切换 wave，防止 S1 review 在窗口期误报 | 登记表条目加「W12-W18 过渡：写入口=事件流（已登记例外），W18 起源=entry 扫描」 |
| INFO | 父/子多处行号 | P1-8 | 行号漂移汇总（均不影响决策）：`scannedToSummary` 占位值实为 session-scanner.ts:81-82（文档写 79-80）；`applyContextUpdate` 实为 session-service.ts:842（W10 写「L830 附近」）；`switchModel` 实为 :467（W10 写「L453 附近」）；`persistSessionEnd` 实为 session-file-utils.ts:137（父写 111-157，注释块起点≈110，勉强成立）。锚点行 `setInputTokens:826`/`getInputTokens:822`/`renameSession:284`/`persistSessionName:296`/`updateLabel:56`/`updateSessionState:73`/`setGroups:109`/`pendingBuffer:123`/`drainPending:335`/`countDrained 65-84`/queue_update effect `:508` 均逐一核实精确命中 | 无需逐一修改；若顺手修 W10 两处「附近」锚点更佳 |

## 四大审查方向结论

1. **对抗式（P0-10/P0-7/8/9）**：五条终态原则与方案 B 的对比-推荐结构成立（A/C 的反例推演可复核：方案 C 的「版本协议只在双方都读到对方版本时有效」论证与 rename-session 守卫读不到 xyz 写的现状机制吻合）。本轮攻击找到的两个洞都在**迁移期**：W1 的写方集合遗漏（MUST_FIX 1）与 W5 的先例虚构（MUST_FIX 2）——终态不被推翻，但「P0 止血即达成的声明」与「等价性基建成本」需修正。D3 sidecar 合法性、D6 按字段分权威（RPC 全集无队列内容 + ExtensionAPI 仅 `hasPendingMessages()` + `deliverAs` 注入例外已堵）、D5 message_end 重构形态，均经本轮源码复核成立。
2. **问题定义与根因（P0-4/P0-5/P0-6）**：通过。SCQA 忠实使用者问题；§2.4 根因（无 owner 结构）有 #12 修复后同类坑复发的证据链；12 类清单 + 四模式归类 MECE（plugin sessionData 的排除有覆盖说明）。使用者视角失败模式 A/B/C 均为真实链路且引文与代码相符（B 的重写经本轮对 message-handler/topic 表/subscription-state 注释复核为准确）。
3. **副作用/遗漏/关键事实（P0-11/P0-12/P0-16/17/18）**：pi 侧事实全真（见附录清单）；xyz 侧事实两处影响执行（MUST_FIX 1/2），其余为计数/行号级漂移。物理数据流图（P0-17）父文档两版均有，但 §2.5 现状图漏 tryPersistLabel 写方（并入 MUST_FIX 1 修复）。错误恢复指引（P0-18）齐备（§3.1 四条失败路径 + 各 wave 失败分支）。运行时断言探针标注（P0-16）诚实：✅/⛔ 区分清晰，开放项都有 wave 归属（W8 量化、W16 探针落表、W18 历史降级）。
4. **验收（P0-13/14/15）**：通过。父 §4 五场景全部真实环境（真实 pi 子进程/真实文件/`pnpm dev` + Playwright），无 mock 验收；每场景回溯 G1-G4；通过标准具体可证伪（`tail` JSONL 核对、扩展日志字符串——`skip: name exists`/`renamed to` 已核实真实存在于 rename-session 源码 L68/L74）。子文档 25 wave 验收普遍含代码级 grep 断言 + 行为级真实验证 + 回归三段，可证伪性整体优秀；个别验收命令精度问题见 SUGGESTION（W11 grep=0 误伤注释、W3 基线数字）。W5 的「断言非空转」对照验证（临时改断言看变红）是好实践。

## 防复发检查（上轮 13 条逐条复验）

| # | 上轮 finding（摘要） | 修复位置 | 本轮验证结论 |
|---|---------------------|---------|-------------|
| MF1 | D1b thinkingLevel-undefined 反例虚构 | D1b 重写为 sessionName 反例 + 更正注 | **已修复**。复核：0.84.1 dist `types.d.ts:260` `ThinkingLevel` 为 `"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"\|"max"` 具体联合（无 undefined）；`agent-session.ts:891-892` sessionName getter `string \| undefined`；session-manager.ts:1065-1075「Empty names explicitly clear the session title」。论证成立。残留小瑕（反例叙事 + label 双登记）→ 本轮 SUGGESTION 5 |
| MF2 | 失败模式 B 机制描述失真 | §2.1 B 重写 | **已修复**。复核：stateSnapshot/last-value/gap 机制（session-message-handler.ts:314-352）、话题三分类（TOPIC_TABLE:55 起 state 5 项 / stream 含 queue_update）、subscription-state.ts:293 注释确指 W09 订阅重建问题——引文全部与代码一致，论证重心已移至「stateSnapshot 兜底影子缓存」 |
| MF3 | subscribe/ring/stateSnapshot 去留未处置 | D7 补漏段 + P1.5 + 子 W12 | **已修复**。「复用为推送通道不退役重写」+ 5 话题清单（与 TOPIC_TABLE 实测完全一致）+ W12 逐话题 commit + 边界断言（TOPIC_TABLE/STATE_TYPE_KEY_MAP 不动） |
| S1 | wire 层空值语义未定义 | D1b wire 归一条 | **已修复**（key 缺失按字段登记语义处理，禁当「字段不动」；W6 步骤 1 内建该规则） |
| S2 | G1 队列表述与验收矛盾 | G1/样例 2/场景 2 | **已修复**（深度对账 pi 当前值、内容基于 renderer 本地副本 + 残余风险边界括注） |
| S3 | 扩展 deliverAs 注入破坏计数 FIFO | D6 已知例外 + W2 登记 + S1 拦截 | **已修复**。复核 `SendUserMessageHandler` deliverAs 真实存在（extensions/types.ts ~:1482）；W14 验收 4 还加了偏差收敛用例 |
| S4 | ADR-0042 修订未安排 | P4.2 + W23 | **已修复**。复核 ADR-0042 正文确仍为「append JSONL」原决策（与文档描述的现状一致），W23 安排修订落档 |
| S5 | plugin sessionData 缺登记 | §2.2 覆盖说明 + §3.6 第 4 层 + W2 步骤 4 | **已修复**（「已 owner 化声明」条目；SessionDataStore 路径已核实存在） |
| S6 | 回滚计划缺失 | §5 回滚通则 + 各阶段回滚行 | **已修复**（含 P1.3 删除性变更 revert 恢复论证、P2 双入口不共存断言、P3 自描述 entry 无害残留论证） |
| S7 | P0.5 RPC 频率探针无失败预案 | P0.5 失败预案 + W7/W8 分工 | **已修复**（三级降级按序评估 + 决策须上报不静默；W7 只记录、W8 收口且验收禁止备注空白） |
| S8 | D5 探针设计期可回答却标开放 | D5 ✅ 已核实 + P3.3/W21 定形态 | **已修复**（源码唯一发射点 + 实测 25 事件 0 条；W21 明令禁止重开该方案；W25 把契约固化） |
| S9 | S1 接入状态表述过时 | P0.3/文件地图/SKILL | **已修复**。复核 SKILL.md batch2 含 review-data-governance（8 维）、agent 文件存在，「P0 剩余 = R1/R2/R3」表述与现状一致 |
| S10 | 引文细节失真（workflow.ts 不存在 / model 事件表述） | 改引 jsonl-run-store + D7 精确化 | **已修复**。复核：jsonl-run-store.ts D-5 guard 真实存在；D7 现表述「pi 有 model_select 但只经 _extensionRunner.emit、不经 session.subscribe 转发」与 agent-session.ts:1458-1470 逐字相符 |

结论：**13/13 真实修复，无复发**；修复未引入方案级新问题（新发现的 2 个 MUST_FIX 是本轮新攻击面，非上轮修复的副作用）。

## 父子一致性结论

- **单元承接**：父 §5 全部 19 个单元在子 §0 映射表逐行有 wave（P0.5 无实施 wave 有理由注明）；P0.3 的 S1 拆分、P1.2 并入 W7/W8、P3.1 三分（W16/W17/W18）、P3.3 二分（W20/W21）、P4.2 二分（W23/W24）均与父文档单元内容对得上。唯一错误是计数（17≠19，SUGGESTION 3）。
- **决策编号引用**：D1-D8、原则 1-5、场景 1-5、G1-G4 的引用抽查无曲解；D3（sidecar 选项 a）、D5（message_end 形态 + 禁重开声明）、D6（deliverAs 禁用 + 展开后文本）、D2（~500ms 逐次冷起定型）在子文档的执行化与父文档裁决一致。
- **矛盾清单**：仅 1 处实质性歧义——W2 登记表内容（「label 空 = 可守卫」）与 W7 实例配置（label 语义 = sessionName 覆盖）在「同一字段该用哪条空值语义」上冲突（源自父 D1b 末条自身，见 SUGGESTION 5）。W12 包装实例的过渡态不算矛盾（两文档均明示，见 INFO）。未发现其他互相矛盾。
- **规模/依赖图**：W1-W25 依赖边抽查全部合理（W12←W7/W8、W18←W12/W16/W17、W23←W11/W13/W18、W25←W5/W21）；W11 对 W6 的依赖理由表述牵强（rpc-client 在 W1 后即可用）但不产生错误顺序；并行组划分与文件冲突约束（core chat 域互斥）正确；单 wave ≤5 文件约束仅 W11 超 1 且有正当说明。

## 附录：事实核实清单（本轮新增核实，上轮已核实的不再重复）

| 文档宣称 | 核实结果 |
|---------|---------|
| rpc-client 从未接线 set_session_name | ✅ `packages/runtime/src/infra/pi/rpc-client.ts` 全文无匹配；getCommands:572 / getSessionStats:579 / getState:~590 / getEntries:~528 / getHistory[DEAD]:~511 全部存在 |
| persistSessionName 直写 JSONL（openSync 'a' append session_info） | ✅ session-file-utils.ts:415-433；调用点三处：session-lifecycle.ts:296（活跃，W1 替换对象）、:302（非活跃）、**session-service.ts:1284（tryPersistLabel，两文档均未覆盖 → MUST_FIX 1）** |
| tryPersistLabel 在 turn_end / agent_end 触发 | ✅ session-service.ts:878（handleTurnUsageSideEffects）/ :902（handleTurnEndSideEffects）；labelPersisted 置位于 :1285 |
| TOPIC_TABLE 5 个 state 话题 / STATE_TYPE_KEY_MAP:131 / queue_update 属 stream | ✅ message-bus.ts:55 起、:131 起、:82 `'message.queue_update': 'stream'` |
| stateSnapshot 组装 session-message-handler.ts:314-326 | ✅ case 块 314-352（stateSnapshot reply 在 ~350） |
| subscription-state.ts:293 注释指 W09 订阅重建 | ✅ :292-293「订阅永不重建……W09 删除 broadcast 兜底腿后升级为 critical」 |
| 0.84.1 ThinkingLevel 无 undefined | ✅ node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:260 |
| pi sessionName `string \| undefined` / 空名清除标题 | ✅ agent-session.ts:891-892 getter；session-manager.ts:1065-1075（`entry.name?.trim() \|\| undefined`） |
| set_session_name 拒绝空名 | ✅ rpc-mode.ts:~633-637「Session name cannot be empty」（D1b 反例叙事需微调 → SUGGESTION 5） |
| appendEntry → appendCustomEntry + entry_appended 发射（agent-session.ts:2264-2271） | ✅ 2264-2271 |
| setSessionName → appendSessionInfo + session_info_changed（:2718） | ✅ 2718-2723 |
| queue_update 携带 steering/followUp 全量数组（:503-508） | ✅ 503-508 |
| steer/followUp 入队前展开 skill/template（:1243-1265） | ✅ 1243-1269 |
| _emitModelSelect 只发扩展不经 subscribe 转发（:1458-1470） | ✅ 1458-1470 |
| RPC 命令面固定 switch（rpc-mode.ts:385 起）/ get_entries since 游标失效报错（~:615） | ✅ |
| rename-session 守卫与日志字符串 | ✅ extensions/rename-session/src/index.ts:68「skip: name exists」、:74 `renamed to "${title}"` |
| core session store 三入口 56/73/109 + :70 踩坑注释 | ✅ 逐行精确命中 |
| pendingBuffer:123 / drainPending:335（findIndex 文本匹配）/ abortPending:351 / countDrained 65-84 / queue_update effect:508 / :132 FIFO 顺序注释 | ✅ 全部精确命中 |
| sessionMetaCache 生产写方 3-4 个 | ❌ 实为 2 处 setLabel、0 处 setThinkingLevel、0 生产读者（SUGGESTION 1） |
| W5「rpc-client-bash.test.ts 真实 spawn 先例 + 环境检测写法」 | ❌ 该测试 vi.mock child_process 全 mock、无 skip 逻辑；全仓无真实 pi spawn 测试（MUST_FIX 2） |
| event-adapter NULL_EVENTS 含 entry_appended（712-716）/ DISPATCHER queue_update:736、session_info_changed:737、thinking_level_changed:738 | ✅（另注：message_end 现也在 NULL_EVENTS，W21 需移出——子文档步骤已覆盖） |
| W12 两个话题 publish 点在 event-interpreter（grep 定位） | ✅ event-interpreter.ts:635（session.subagents）/ :685（session.workflowUpdate） |
| pre-commit 由 install-hooks.sh heredoc 生成到 commondir（--git-common-dir） | ✅ install-hooks.sh:32/:46；生成体 16 行 CHECKER=（W3 写 7 → SUGGESTION 4） |
| taste-lint 经 eslint config 生效（pre-commit npx eslint 可触发 R2/R3） | ✅ eslint.config.mjs:1-4 import taste-lint/vue.mjs |
| jsonl-run-store.ts:455 workflow-state-link / D-5 guard；record-store appendEntry 通道（~175/223）与 manifest-invalid-status（~350） | ✅ |
| ADR 编号最高 0061 / 0042 正文仍为原决策 / 0037 文件名 | ✅ |
| ADR-0059 薄壳、session-data-store、use-session-scoped-state、message-dispatcher、applyMessageEvent（store.ts:368）、两个 extractor 文件、rpc-client-bash.test.ts 存在性 | ✅ 全部存在 |

## 总体裁决

**需修改后通过**。2 个 MUST_FIX 均为迁移期执行层的遗漏/事实错误，不动摇终态架构与方案 B：① W1 写方集合补全（tryPersistLabel）并同步修正登记表/R1 allowlist/父文档现状图；② W5 撤销虚假先例引用、按净新增基建重述。修复成本低（均为范围修正与表述更正），修完即可进入 W1 执行。5 条 SUGGESTION 建议随 MUST_FIX 一并顺手修（登记表语义歧义那条建议优先，直接影响 P1.1 配置编写）。
