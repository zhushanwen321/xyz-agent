# subagent-sync-collect 一致性审查报告

- **审查基线**：HEAD `3b4be4561919f199775274b01d64cede59da2efe`（2026-09-05 02:55:23 +0800）
- **被审对象**：`docs/design/subagent-sync-collect.md`（设计）+ `docs/design/subagent-sync-collect.impl-plan.md`（实施计划）+ 特性代码足迹
- **性质**：对抗式一致性审查——只报告不改代码；`subagent-sync-collect.review.md` 仅作语义参照不属被审对象
- **审查关系**：a) 代码↔设计 b) 现实↔impl-plan c) impl-plan 内部 d) 注释口径 + 机械验证
- **发现编号规则**：F-<关系>-<序号>；direction ∈ doc-right / code-right / contested；severity 按「是否误导后来者」判 must-fix / suggestion / info

## 状态

- [x] 文档全文阅读（设计 333 行 / impl-plan 121 行）
- [x] 代码逐章比对（关系 a：17 项机制清单 + 4 finding）
- [x] 现实 ↔ impl-plan（git 考古：17 commits、偏差行删改、RESULTS.md、日期线）
- [x] impl-plan 内部（章节映射/目标快照/DAG/状态表/偏差表/变更历史交叉）
- [x] 注释口径（collect-coordinator 头 / notifier 预算注释 / 5 个测试文件头）
- [x] 机械验证（36 标识符 + 外围引用 grep，零悬空）

## 审查方法

文档全文精读 → 代码逐文件/逐机制比对（collect-coordinator / notifier / subagent-service / record-store / record-entry / config / types / subagent-actions-core / subagent-tool-schema / subagent-tool / subagent-workflow index / session-reader 三件 / probes 目录）→ git 历史考古（`git log main..HEAD` 17 commits、`git log -S` 追偏差行删改）→ 反引号标识符机械 grep（36 个符号全数命中，见 §机械验证）。

## Findings

### 关系 a：代码 ↔ 设计文档

#### F-a-1 批内失败条目 error 为全文而非设计的「首行」

- **location**：docs/design/subagent-sync-collect.md:143（§3.1.2 失败与逃生路径）、:290（§4 A3 通过标准）vs packages/subagent-core/src/execution/notifier.ts `buildLlmContent` closed/failed 分支（`Subagent "${agent}" (${id}) failed: ${record.error}`，全文拼接、无首行截取）
- **gap**：设计两处明写「失败条目正文为 `Subagent "x" (bg-xx) failed: {error 首行}`」/「失败条目含 error 首行」；实装直接复用 one-shot 异步通知同构的全文 error（`__tests__/notify-batch.test.ts:205-213` 以多行 error `"spawn EPIPE\ndetail line"` 整段断言锁定全文形态）。
- **direction**：code-right——复用 `buildLlmContent` 与 G3「现状零变化」精神一致，「首行」是设计文案的顺手简写，非可执行规格；且测试已按全文锁定。
- **severity**：suggestion——按 A3 验收措辞来审的人会去找不存在的首行截取逻辑。
- **rationale**：机制层（失败计入批头计数、批照常单次唤醒）双方一致；仅 error 呈现口径漂移。错误串实际多为单行，漂移几乎不可观察，但文档措辞与测试锁定的形态矛盾是事实。
- **fix-hint**：改设计 §3.1.2/§4 A3 措辞为「failed: {error 全文，与异步单条通知同构}」；或若确需首行截取则另行立项（不建议，破坏复用同构）。

#### F-a-2 批通知 details 顶层 `notifyId` 键：设计未记载、偏差登记行又被误删（与 F-c-1 联动）

- **location**：docs/design/subagent-sync-collect.md §3.1.4 数据流图「details {batch:true, items:[...]}（复用现有批量渲染）」vs notifier.ts `notifyBatch`：`const details = { batch: true as const, notifyId: batchNotifyId, items: payloads }`
- **gap**：实装批 entry 的 details 比设计多一个顶层 `notifyId` 键（回执销账匹配 `collectDeliveredNotifyIds` 读 `details.notifyId` / `details.items[].notifyId`——批身份键必须顶层可达否则批 entry 永不销账、重投至放弃）。这是真实且必要的实施期增量，曾在 impl-plan 偏差 #7 登记（commit 2099e2b69），后在 739718be4 被误删（详见 F-c-2）。设计本身从未更新此键。
- **direction**：code-right（键是账本回执机制的硬需求，notifier.ts 注释已自证）；设计 §3.1.4 details 形状描述不完整。
- **severity**：must-fix——销账通路键缺失即「重投至放弃」级后果，后来者按设计文档实现/审计批 details 时会漏掉此键，且唯一记录它的偏差行已丢失，双重漂移。
- **rationale**：设计是机制 SSOT；details 形状是 ledger 回执匹配契约的一部分，不在文档出现 = 契约漂移。
- **fix-hint**：设计 §3.1.4（及 §3.1.3 批通知段）补写 details = `{batch:true, notifyId:"sync-batch:<hash>", items:[...]}` 并注明顶层键的回执匹配动机；同步恢复 impl-plan 偏差 #7 行（见 F-c-1）。

#### 关系 a 已核对一致（未发现漂移）的机制清单

以下逐项 read 到行级，代码与设计条文一致，显式声明「未发现」：

| 设计条文 | 代码证据 | 结论 |
|---|---|---|
| §3.1.3 `collect` 参数（拍平顶层、StringEnum async/sync、缺省 config 兜底） | subagent-tool-schema.ts:111-123；subagent-actions-core.ts:356 `input.collect ?? service.getCollectSyncDefault()` | 一致 |
| §3.1.3 config `collectSync` 三键 + E5 sanitize 回默认不炸启动 | config.ts:54-60 `DEFAULT_COLLECT_SYNC`、:183-193 `sanitizeCollectSync`（逐字段回默认、非对象整节 undefined） | 一致 |
| §3.1.3 `DEFAULT_CONFIG` 不含 collectSync 键（偏差 #2 对应） | config.ts:36-44 注释 + DEFAULT_CONFIG 本体 | 一致 |
| §3.1.3 ExecutionRecord `collectMode`/`batchFinalized` 字段（不落盘旧记录零迁移） | types.ts:482/:502；record-entry.ts:151-152 序列化白名单 | 一致 |
| §3.1.3 pendingSyncCount 口径（未闭合批 sync 总数含本条、跨轮续累） | subagent-actions-core.ts:416-428 `countPendingSyncRecords`（collectMode=sync && !batchFinalized，root 过滤经 service.collectRecords） | 一致 |
| §3.1.2/§3.1.3 两段式预算 `effectivePerItem = clamp(floor(totalChars/n),200,perItemChars)`、200 下限纯清单退化、n>120 演算例、总量口径仅计正文、指针行逐字符格式 | notifier.ts `computeBatchBudget`/`buildTruncationPointer`/`buildBatchLlmContent`（`LIST_ONLY_FLOOR=200`；格式串与设计样例逐字符一致）；collect-budget.test.ts 头注释同款 | 一致 |
| §3.1.3 notifyId = `sync-batch:<sha1(sorted ids)>` | notifier.ts `buildBatchNotifyId`（BATCH_NOTIFY_ID_PREFIX） | 一致 |
| §3.1.4 collectCoordinator 路由（async 直通字节不变 / sync 缓冲 / 闭合=缓冲非空且无非终态 sync） | collect-coordinator.ts `route`/`hasRunningSync`；subagent-service.ts:395-433 接线（listAllActive 原始态） | 一致 |
| §3.1.3 两出口落 batchFinalized（①批 flush 写账成功后 ②E9 转换逐条写 async 账后，appendEntry 持久化） | subagent-service.ts `flushBatch` 闭包（accepted 才落标）+ `convertPendingSyncBufferToAsync`（notify 后 markMembersBatchFinalized）+ `appendBatchFinalizedEntry`（reportSubagentRecord 单写点） | 一致 |
| §3.1.3 标记读取通路钉死（E1 走主 session 末条 entry、禁 collectRecords light 路径；投影扩展含终态五字段） | record-store.ts:736-748 `scanLastRecordEntries` + :255-293 `rebuildEntryRecord`（status/endedAt/closedReason/result/error/collectMode/batchFinalized 全投影） | 一致 |
| §3.1.5 E1 恢复钩子（只收无标记 sync、root 过滤、全终态→notifyBatch 补发、running 等自然终态、无论账本接受/拒绝统一补标） | subagent-service.ts:767-803 `recoverSyncCollectBatch`；index.ts:492-507 session_start 接线（晚于 initSession + ledger bind，best-effort） | 一致 |
| §3.1.5 E9 dispose 转换（缓冲终态成员逐条转 async 写账+落标、在跑成员走现有退出路径）、E8 fork-from 新成员默认 async | subagent-service.ts:817-845 `convertPendingSyncBufferToAsync` + dispose() 顺序（abort/kill → E9 转换 → disposeAllRecords → flush）；fork-from 不传 collect → 兑底 async | 一致 |
| §3.1.3 幂等窗口（写账成功落标前崩溃→E1 同 hash 重建→账本幂等拒绝→统一补标自愈；E9 跨键残余窗披露） | notifyBatch 返回 false 不落标 / recoverSyncCollectBatch accepted 与否都补标；impl-plan §7 残留风险段与设计披露对应 | 一致 |
| §3.1.3 `session_read` result action（单/批量≤10、limit 默认 8000、与 record.result 同源、manifest 反查零新目录） | session-reader result-action.ts（RESULT_MAX_BATCH=10、RESULT_DEFAULT_LIMIT=8000、extractFinalAssistantText 同源语义注释）；index.ts schema/description | 一致 |
| §5 U7 工具 prompt（collect 用法、You cannot 节、skill 文档 collectSync 节） | subagent-tool.ts:191-215；skills/subagent-ext-config/SKILL.md:45-63 | 一致 |
| G3/A5 异步零回归（旧 golden 11/11、响应字节不变） | notifier-golden-snapshot.test.ts（SW 包，fixtures 在 core）；start-collect-guard.test.ts「async 响应字节零变化」 | 一致 |
| U2「notifyComplete 全部调用点统一过协调器」 | subagent-service.ts 5 个调用点（:1459 kickOffBackground.then / :2168 engine run / :2469 CAS 抢占 / :2549 cancelBackground / :2747 chatMode 轮次）全经 `notifyComplete → collectCoordinator.route` | 一致 |
| §1.1/§2.1 现状锚点（mergeItems 合批、mergeWindowMs 60s 内核降级、helpers.ts MAX_RESULT_LENGTH=8000 预算先例、session-delivery delivery.ts） | notify-ledger.ts:313/:459 mergeItems；notifier.ts mergeWindowMs:60_000；helpers.ts:29；packages/session-delivery/src/delivery.ts 存在 | 一致 |

（关系 a 的待裁决项 F-a-3 见下——list 逃生口，与关系 b 偏差 #12 的裁决移交对应）

#### F-a-3 list 逃生口：设计宣称「list 可见 collect:sync 与 pending 计数」，实装 list 不投影任何 collect 信息

- **location**：docs/design/subagent-sync-collect.md §3.1.2 失败与逃生路径（「逃生：`list` 可见 `collect:sync` 与 pending 计数」）、§3.3 D2 代价段（「逃生 = `list` 观察 pendingSyncCount + 对已有条目 cancel/close 逼闭合（list 输出含 collect 段即为此场景的指定逃生口）」）vs extensions/universal/subagent-workflow/src/interface/subagents.ts:231-233（list 数据源 collectRecords 投影无 collectMode/pendingSyncCount——list-shared/list-component/gui-mappers grep 零命中）
- **gap**：设计把「list 输出含 collect 段」写为批饥饿场景的**指定逃生口**；实装 pendingSyncCount 仅存在于 start 响应（subagent-actions-core.ts:397-400），list 完全不显示 collect 信息。impl-plan 偏差 #12 已如实登记（「计数只在 start 响应，list 未投影 collect 信息」「转一致性审查阶段裁决（补实装或改设计措辞）」）；U7 工具 description 按实装落笔（「action:"list" shows what is still running; action:"cancel" it」），用户面引导自洽。
- **direction**：contested——逃生机制本体（list 看谁还在跑 + cancel 逼闭合）实装可用且 D6/E6 行为一致；缺的是「在 list 里辨识 sync 成员与待收计数」的可观测性增量。补实装（list 投影 collect 段）与改措辞（设计逃生口描述降为「list 看在跑成员 + start 响应计数」）都说得通；v1 已按后者运行、文案已按实装发布，推荐**改设计措辞 + 保留偏差登记**，list 投影作为 v2 候选功能另立。
- **severity**：suggestion——偏差 #12 已登记、工具文案已按实装校准，误导面已被控制；但设计文档原文不更新则永远描述一个不存在的行为。
- **rationale**：设计 SSOT 与实装的差距已有登记与裁决路径（本条即裁决记录），机制层 G1-G5 无一依赖 list 投影。
- **fix-hint**：设计 §3.1.2/D2 逃生措辞改为「list 可见仍 running 的成员（不含 collect 标识；pendingSyncCount 见各 start 响应）+ cancel 逼闭合」；或 v2 立 list 投影小项。

#### F-a-4 工具 description 的 Actions 参数表缺 `collect`（U7 验收条款「description 参数表 = schema 实际」未满足）

- **location**：extensions/universal/subagent-workflow/src/interface/subagent-tool.ts Actions 节（`Optional: agent, model, thinkingLevel, skillPath, appendSystemPrompt, schema, maxTurns, graceTurns, fork, worktree, cwd, conversation, idleTimeoutMs.`）vs subagent-tool-schema.ts:111（`collect` 参数本体）；impl-plan §2 U7 验收条款「文案与实装一致性核对（description 参数表 = schema 实际）」
- **gap**：description 的 Actions 枚举不含 `collect`（同列也不含先前置入的 `engine`——engine 缺失属 engine-awareness 特性的存量缺口，非本特性引入，仅附带指出）。collect 在 Examples/「Batch collection」专节/「You cannot」节均有覆盖，但参数清单枚举遗漏。
- **direction**：doc-right——impl-plan U7 验收条款本身正确，实装文案未校齐。
- **severity**：suggestion——pi 会向模型展示 schema 本体（参数不缺失），且专节覆盖充分；但按验收条款核对即不通过，且枚举遗漏会稀释「参数面」认知。
- **rationale**：U7 的意义就是 LLM 可发现性；参数枚举是 description 中最高权重的参数面。
- **fix-hint**：Actions 节 Optional 列表补 `collect`（顺带补 `engine`，另立存量缺口不强行与本特性绑定）。

### 关系 b：现实 ↔ impl-plan

#### F-b-1 U8 宣称 committed 但设计 DoD（A1/A4/A6 真实 CLI 实测）未执行且未披露

> **状态（2026-09-05）**：执行中，由主 agent 负责（按 fix-hint ① 补跑 A1/A4/A6 + A2/A3/A5/A7/A8 落 RESULTS.md 后回写状态表）。文档修复轮不动 impl-plan 状态表结论。

- **location**：impl-plan §6 状态表 U8 行（「committed … node --check 10/10 + dry-run 5/5」）+ §7 变更历史末条（「阶段 2 全部 8 单元 committed，进阶段 3（design-code-sync）」）vs scripts/probes/subagent-sync-collect/RESULTS.md（仅一条 2026-09-04T18:44 的**空白** A7 模板，全部字段无值，无 A1-A6/A8 任何执行记录；工作区 clean 无未提交结果）+ U8 commit 94c706656 message（「long-running scenarios not auto-executed (main agent runs them at acceptance)」）+ 其后仅有 2c1f47d8d/3b4be4561 两个非验收 commit
- **gap**：设计 §4 明定「A1/A4/A6 为实施完成门（DoD）」，impl-plan U8 验收条款亦写「DoD：A1/A4/A6 CLI 实测通过 + A2/A3/A5/A7/A8 执行记录」；现实中真实 CLI 探针从未跑过。A6 的 kill -9 面可依设计 D5 降级条款以 sync-collect-recovery.test.ts 集成测试替代门（该测试真实文件通路 6 场景在盘），但 A1（错峰单唤醒）/A4（超预算截断+取回）无任何降级条款。状态表/变更历史均未披露此缺口，反而宣告进入阶段 3。
- **direction**：doc-right——DoD 是设计/计划的承诺，现实未兑现且未标注。
- **severity**：must-fix——后来者会相信「真实场景验收已过」；本特性核心卖点（单唤醒/预算截断/取回逐字节一致）从未在真实 pi CLI 上验证过。
- **rationale**：探针脚本本身交付且 dry-run 验证过可执行性（脚本层 U8 交付物成立）；缺的是执行与记录，以及状态表的诚实披露。
- **fix-hint**：二选一并回写：① 补跑 A1/A4/A6（+A2/A3/A5/A7/A8 记录）落 RESULTS.md；② 状态表 U8 与变更历史明确标注「DoD CLI 实测未执行，脚本就绪待验收」并撤回阶段 3 进入声明。

#### F-b-2 偏差 #5 已在 HEAD 修复闭合，impl-plan 仍列为未清残留风险且变更历史无记录

- **location**：impl-plan §5 偏差表 #5（「不入本特性 scope，残留风险登记」）+ §7 残留风险（「偏差表 #5 存量测试环境敏感缺口（PI_SUBAGENT_*/RELAY_* 泄漏即红）」）vs HEAD commit 3b4be4561（2026-09-05 02:55，message 明写「deviation #5 closure」——relay-env 断言改 sanitized copy、pi-invocation 剥 5 键、根聚合测试由 6 红转绿，A/B 实证）
- **gap**：修复发生在 impl-plan 最后一次更新（2c1f47d8d，02:45）之后 10 分钟，但计划未回写：偏差 #5 行与残留风险段均过时，变更历史无该条目。
- **direction**：doc-right（现实修复正确，登记债未清账）。
- **severity**：must-fix——AGENTS.md C-proc-10 明定「登记即债务修复即清账（同 commit 回写）」；后来者按残留风险段会继续回避这两个测试文件或重复排查。
- **rationale**：commit message 与计划登记的直接矛盾是最硬的漂移形态。
- **fix-hint**：偏差表 #5 理由列补「已闭合（3b4be4561）」；§7 残留风险删该句；变更历史补一行。

#### F-b-3 impl-plan 全部日期系统性错误：文档写 2026-02-11，真实提交为 2026-09-04/05

- **location**：impl-plan 头部「日期: 2026-02-11」+ §7 变更历史全部 7 条均缀 2026-02-11（全文 9 处）vs git log：设计提交 1612e2f37（09-04 12:00）→ U1 faab2a3cc（09-04 20:14）→ … → HEAD 3b4be4561（09-05 02:55），全部工作压缩在 ~15 小时内
- **gap**：计划日期与逐波次变更历史 7 条同日期，全部早于真实时间约 7 个月。
- **direction**：现实正确、文档错——文档必须改（裁决归 doc 侧义务）。
- **severity**：must-fix——变更历史是单元级审计轨迹，错误日期使其不可信且与 git 历史交叉验证即穿帮；「每条可回溯」验收目标被削弱。9 处一致错是系统性错（疑似模板拷贝/时钟错置），非笔误。
- **fix-hint**：头部日期改 2026-09-04；变更历史 7 条按 git log 逐条改 09-04/09-05。

#### F-b-4 ⛔1（gui-mappers 批量映射）宣称「全部闭合（4 个检查点清零）」但 §7 无闭合结论记录

- **location**：impl-plan §7 变更历史 W3 条（「⛔1/⛔2 全部闭合（4 个检查点清零）」）vs §7 残留风险区仅有 ⛔2/⛔3/⛔4 三条「已核实」bullet——⛔1 无任何结论记录
- **gap**：变更历史宣称四检查点全闭合，但 ⛔1（gui-mappers 对 `{batch:true, items}` details 的 GUI 映射完整性）的核实结论在任何地方都无记载。本次审查独立旁证：TUI 侧 bg-notify-render.ts:269-272 `extractBatch` 已消费批量形态；GUI/renderer 侧 fg5-message-stream.test.ts:647-669 证明 subagent-bg-notify 的原始 details 整体保留——闭合大概率真实，但计划自身不可追溯。
- **direction**：doc-right（记录义务未履行，非结论错误）。
- **severity**：suggestion——结论可独立重建，误导面小；但「宣称闭合无证据」违反计划自身的证据指针纪律。
- **fix-hint**：§7 残留风险区补一条「⛔1 已核实（U3）：GUI 链路 details 原样透传（renderer 不拆批量细节），TUI extractBatch 已支持；无需改动，不属本特性缺口」。

#### 关系 b 已核对一致（未发现漂移）

- 状态表 U2-U8 的 commit hash（77de9c02d / a53271c70 / a39505d1e / 4c63d9fb9 / 895f9da2a / 33601d35c / 94c706656）全部真实存在且 message 与单元职责吻合；波次流转（W2-W6）与 git 提交顺序一致——**未发现**（除 F-b-1/2/3/4 所列）。
- 残留风险段其余两条（E9 跨键残余窗 PS-17 同族、⛔检查点处理原则）与设计披露一致——**未发现**。

### 关系 c：impl-plan 内部

#### F-c-1 偏差登记表缺 #7 行：W3 明确登记、W4 被 #8-#11 行顶掉，变更历史仍引用 #7

- **location**：impl-plan §5 偏差表（现行编号 1,2,3,4,5,6,8,9,10,11,12,13,14——**无 #7**）vs §7 变更历史 W3 条（「偏差 #6/#7 登记（真链 bug 修复 + 回执匹配 notifyId 键）」）+ commit 2099e2b69 message（「deviations 6/7」）
- **gap**：git 考古实证（`git log -S`）：#7 行「批 details 需带顶层 `notifyId` 键（投递回执匹配 collectDeliveredNotifyIds 读 details.notifyId，否则批 entry 永不销账）」在 2099e2b69 加入，随后在 739718be4（W4）被新增 #8-#11 行替换时误删（diff：删 #7 增 #8-#11）。现行文档自相矛盾：变更历史引用一个表中不存在的编号。
- **direction**：doc-right（变更历史正确，偏差表缺行）。
- **severity**：must-fix——与 F-a-2 联动：被删的恰是「与设计不同的实装必要增量」的唯一登记；丢行后后来者无法从计划得知批 details 顶层键的动机，且编号断档会让后续偏差错位引用。
- **rationale**：append-only 登记表被就地覆写的编辑事故，非有意裁剪。
- **fix-hint**：恢复 #7 行（原文见 2099e2b69 diff），置于 #6 与 #8 之间。

#### F-c-2 状态表 U1 证据指针为未回填占位符「commit <本条>」

- **location**：impl-plan §6 状态表 U1 行（「commit <本条>; subagent-core 3038 绿…」）vs git log：U1 实际 commit = faab2a3cc（2026-09-04 20:14，「feat(subagent-core): U1 collect contract surface」）
- **gap**：占位符从未回填，而 U2-U8 各行均有真实 hash；实际 commit 存在且可填。
- **direction**：doc-right。
- **severity**：suggestion——U1 可追溯性断链，但 git message 可检索补全。
- **fix-hint**：占位符替换为 `faab2a3cc`。

#### F-c-3 基线哈希 92b977b68 不在当前分支历史（悬空对象）

- **location**：impl-plan 头部「基线: 92b977b68」vs `git branch --contains 92b977b68` 空结果；其 parent = 1612e2f37（设计提交），与现行基线 commit fb66e8ec3 同位（rebase 前身）
- **gap**：哈希当前仅靠对象库存活，git gc 后可能不可达，「基线」锚点会断裂。
- **direction**：contested（写时真实，rebase 后悬空）。
- **severity**：info——短期内对象可达，误导面几乎为零。
- **fix-hint**：基线改写为现行链上的 fb66e8ec3，或保留并注明「rebase 前身哈希，现行对应 fb66e8ec3」。

#### 关系 c 已核对一致（未发现漂移）

- §0 章节映射五行 vs 设计实际目录结构、§1 目标快照 vs 设计 §1.2 逐字、§2 单元表依赖列 vs §3 DAG vs 波次划分（W1-W6 并行判据）、§2 领地说明 vs 代码落点（collect-coordinator.ts 新建属实、types.ts:416 行锚实测命中 ExecutionRecord 本体、record-entry.ts 白名单归 U1 属实）——**未发现**。

### 关系 d：注释口径

#### F-d-1 notifier.ts 头部「sync 不用」与 collect:sync 术语撞车，且头部职责清单不含 notifyBatch

- **location**：packages/subagent-core/src/execution/notifier.ts:1-15 头部（「Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）」+「职责（U2 后）」仅列 buildLlmContent / createNotifier）vs 同文件 notifyBatch / buildBatchLlmContent / computeBatchBudget / buildBatchNotifyId（本特性核心承载者）
- **gap**：头部「sync 不用」指旧的前台 sync 执行模式，但本特性引入 `collect:"sync"` 后该句可直接误读为「sync collect 不经 notifier」——与事实相反（notifyBatch 正是 sync 批通知实现）。头部职责清单未随 U3/U4 更新，未提批通知能力。
- **direction**：code-right（机制正确，注释口径滞后）。
- **severity**：suggestion——审计 collect 特性的人从文件第一屏得到的信号是错的；但下方 400+ 行密集的 U2-U4 注释可纠偏。
- **rationale**：命名撞车（sync ≠ sync collect）是本特性引入的新歧义，头部是每个读者的第一站。
- **fix-hint**：头部改写为「（前台 sync 执行不用本模块——结果直接随 tool result 返回；collect:"sync" 批通知走 notifyBatch）」并把 notifyBatch / buildBatchLlmContent / computeBatchBudget 纳入职责清单。

#### F-d-2 start-collect-guard.test.ts 头部公式仍描述已移除的「manual +1」补偿

- **location**：packages/subagent-core/src/execution/__tests__/start-collect-guard.test.ts:8-10（「pendingSyncCount = … + 本条（U1 阶段 record 落点未接线，manual +1，U2 接线后去除）」）vs 同文件测试体（「reports the enumeration verbatim … (如实反映，无补偿)」断言零补偿；subagent-actions-core.ts:397-400 注释明言「枚举天然含本条，无需补偿」）
- **gap**：头部公式描述的 +1 补偿已被 U2 接线移除，测试体已按新语义断言，头部公式未更新（括注自标了历史，但公式本体仍是旧语义）。
- **direction**：code-right（实现/测试体正确，注释滞后）。
- **severity**：info——括注「U2 接线后去除」自我说明了历史性，细心读者不会实施错误逻辑。
- **fix-hint**：头部公式改为现行口径「= 枚举原样计数（record 已带 collectMode，无补偿）」。

#### 关系 d 已核对一致（未发现漂移）

- **collect-coordinator.ts 头部注释 vs 当前实现**（任务点名项）：职责/闭合判定（⛔3 口径 + resumable 补丁）/跨轮续累/U8 拆批盲窗修复（setTimeout(0) 去抖 + 触发重验闭合）/E9 cancelScheduledFlush 取消语义/E1 直走 notifyBatch 不经协调器/三个不变量——逐段与类实现比对：**未发现**。
- **notifier.ts 预算注释 vs 当前实现**（任务点名项）：「budget（可选）= service flushBatch/E1 补发接线传入的 config 热读值（U4 deviation #8 由 U5 接线）」「预算在写账时刻生效（flush 时热读语义）」vs getCollectSyncBudget（subagent-service.ts:696-699）在 flushBatch 与 recoverSyncCollectBatch 两调用点传入：**未发现**（与偏差 #8「已闭环 4c63d9fb9」互证成立）。
- **测试文件头 vs 当前实现**（任务点名项）：sync-collect-recovery（六场景含 U4 deviation #8 budget 断言）/ collect-budget（两段式算法 + 指针行格式 + 纯清单阈值）/ notify-batch（六条含幂等与去抖合批 + 偏差#5 同族 env 剥离）/ collect-mixed-dispatch（背靠背盲窗精确复现 + 三视角）——除 F-d-2 外：**未发现**。

## 机械验证（反引号标识符 grep）

对两份文档及其注释中出现的代码标识符逐一 grep 项目源码（含 node_modules pi dist）：

- **36/36 全部命中，零悬空引用**：CollectScanRecord、getCollectSyncDefault、scanLastRecordEntries、convertPendingSyncBufferToAsync、recoverSyncCollectBatch、cancelScheduledFlush、sanitizeCollectSync、DEFAULT_COLLECT_SYNC、collectLastRecordEntries、rebuildEntryRecord、buildBatchLlmContent、computeBatchBudget、buildBatchNotifyId、notifyBatch、buildLlmContent、collectRecords、listAllActive、getFullRecord、reportSubagentRecord、toSubagentRecordEntry、markMembersBatchFinalized、appendBatchFinalizedEntry、syncRebuildToNotifyMember、countPendingSyncRecords、e9ConvertedIds、pendingMembers、flushIfClosed、closeDetected、hasRunningSync、buildTruncationPointer、formatChars、withMaterializedOutcome、extractFinalAssistantText、doResult、parseResultSessionList、resolveResultLimit。
- **外围引用亦全部解析**：recordToSubagent / orphanJudged / settled-watchdog / boundedPrettySerialize（helpers.ts:29 `MAX_RESULT_LENGTH = 8000` 预算先例属实）/ startupConfig（偏差 #2 所引 startup-config-declaration.test.ts 存在于 SW 包）/ mergeItems（notify-ledger.ts:459）/ PendingMessageQueue（pi dist chunk-OMWWHBTG.js 命中——「0.84.4 实装」断言成立）/ C-ext-19・C-ext-13・C-ext-17・C-sw-01（docs/constraints.json 全部在册）/ notifier-golden-snapshot.test.ts（SW 包 __tests__，fixtures 在 core __fixtures__）。
- **唯一行号锚漂移（info 级，不计 finding）**：设计 §2.1 引「notifier.ts:113-157」为 buildLlmContent 设计时位置，现位于 ~297 行——设计时快照的自然漂移，该句属「现状分析」非终态断言，不误导。

## 汇总统计

| 关系 | must-fix | suggestion | info | 未发现漂移的段落 |
|---|---|---|---|---|
| a 代码↔设计 | 1（F-a-2） | 3（F-a-1/3/4） | 0 | 17 项机制逐条清单（见关系 a 表） |
| b 现实↔impl-plan | 3（F-b-1/2/3） | 1（F-b-4） | 0 | U2-U8 commit hash 全部真实；残留风险其余两条与设计一致 |
| c impl-plan 内部 | 1（F-c-1） | 1（F-c-2） | 1（F-c-3） | 章节映射/目标快照/DAG/波次/领地说明零矛盾 |
| d 注释口径 | 0 | 1（F-d-1） | 1（F-d-2） | collect-coordinator 头、notifier 预算注释、4 个测试文件头零漂移 |
| **合计** | **5** | **6** | **2** | — |

**direction 分布**：doc-right 8 / code-right 4 / contested 2（F-a-3 list 逃生口裁决、F-c-3 基线哈希）。

## 修复执行记录（design-code-sync Step 3 · 第 1 轮 · 2026-09-05）

- **已修（文档侧 9 条）**：F-a-1 / F-a-2 / F-a-3 / F-b-2 / F-b-3 / F-b-4 / F-c-1 / F-c-2 / F-c-3。
  - 设计文档（subagent-sync-collect.md）3 项 7 处：F-a-1 error 全文口径（§3.1.2 + §4 A3）；F-a-2 批 details 顶层 notifyId 键（§3.1.3 notifyId 段 + §3.1.4 数据流图 + §5 拆分清单 U3 联动）；F-a-3 list 逃生口措辞按裁决改写（§3.1.2 + D2 + D6 联动）。
  - impl-plan（subagent-sync-collect.impl-plan.md）7 项 18 处：F-b-2 偏差 #5 闭合回写（偏差表理由列 + §7 残留风险句移除 + 变更历史补行）；F-b-3 日期 9 处按 git 真实提交日（2026-09-04/05）逐条修正；F-c-1 偏差 #7 行按 2099e2b69 原文恢复（置于 #6/#8 之间）；F-c-2 U1 证据指针回填 faab2a3cc；F-c-3 基线改锚现行 HEAD 3b4be4561 + 92b977b68 悬空说明入变更历史；F-b-4 ⛔1 闭合结论补记；偏差 #12 裁决回写（F-a-3 涟漪）。
- **执行中**：F-b-1（探针执行）——由主 agent 负责，状态表结论未动（见 F-b-1 节内标注）。
- **移交代码侧（超出本轮领地「禁碰产线代码与测试」，均为 code-right 单点小改，移交主 agent 后续轮）**：F-a-4（subagent-tool.ts Actions 参数表 Optional 列表补 `collect`，顺带评估补 `engine`）；F-d-1（notifier.ts 头注释「sync 不用」术语消歧 + notifyBatch/buildBatchLlmContent/computeBatchBudget 入职责清单）；F-d-2（start-collect-guard.test.ts 头公式改现行无补偿口径）。
- **五处联动自检**：正文（§3.1.2/§3.1.3/D2/D6）、数据流图（§3.1.4 details 形状）、错误规格表（§3.1.5 E1 依赖 notifyId 已在账语义与 details 顶层键一致，无需改）、拆分清单（U3 notifyId 括注）、验收场景（A3 措辞）——已逐一核对同步。

## 收束意见

机制层（collect 参数 / config collectSync / 批缓冲与闭合 / notifyBatch + sync-batch hash / 两段式预算 / 截断指针 / session_read result / batchFinalized 两出口落标 / E1 恢复钩子 / E9 dispose 转换）实现完整且与设计条文逐项吻合，U8 拆批盲窗修复（setTimeout(0) 去抖 + 触发重验 + E9 cancel）质量高且注释自证——特性本体质量高。全部 5 条 must-fix 集中在**登记与验收纪律**：真实 CLI DoD（A1/A4/A6）未跑而宣称阶段完成（F-b-1）、两处 append-only 登记被误删/未清账（F-c-1+F-a-2 / F-b-2）、系统性日期错误（F-b-3）。均不要求改代码：补跑验收或诚实披露 + 恢复/回写登记 + 修日期即可闭环。
