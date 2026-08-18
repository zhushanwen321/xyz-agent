# data-source-governance 父子文档对抗式审查报告（r3 · 确认轮）

> 审查人：tech-design-review（对抗式，rubric `P0-N`/`P1-N` 判定）。审查对象：父文档 `docs/architecture/data-source-governance.md`（ace14329d 版，技术方案层）+ 子文档 `docs/architecture/data-source-governance-plan.md`（794 行，实现计划层），完整重审非仅 diff。
> 事实核实基准：xyz-agent 工作区源码（runtime/core/extensions/githooks/taste-lint/scripts 逐一 read/grep/实测）+ pi 上游 main（`~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`，真实路径 modes/rpc/rpc-mode.ts 与 core/agent-session.ts、core/session-manager.ts）。
> 防复发输入：r2 报告 `data-source-governance.review.r2.md`（2 MUST_FIX + 5 SUGGESTION + 2 INFO，九条逐条复验见专节）；r1 基线 `data-source-governance.review.md`（13 条，抽查 3 条）。
> 已定论探针（按任务约定不重开）：pi 冷启动 ~500ms 逐次冷起；entry_appended 对 message entry 不发射（D5 = message_end 重构形态）。
> 本轮重点核实上轮修复新增的事实声明（W1 扩围、W5 净新增基建、D1b 空值归一等）——全部 read 源码实证，见事实核实清单。

## Summary

1 must-fix, 5 suggestions, 2 info.

核心结论：r2 九条 finding 中 8 条真实修复、1 条（W11 验收 grep）修复不彻底（改形残留）；上轮修复引入的新事实声明（pi `_persist` pre-flush 内存缓冲、`set_session_name` 拒空名、basename(cwd) 显示 fallback、process-manager.ts:52 命令形态、sessionMetaCache 写点计数、.githooks/taste-lint 基线数字）经本轮逐一 read 源码**全部为真**，无新引入的事实错误。五条终态原则、方案 B、D1-D8 决策维持成立。但本轮对抗攻击在 r2 MUST_FIX 1 的同类攻击面上找到**新的写方集合遗漏**：绝对写规则宣告覆盖的 xyz 直写 pi JSONL 路径仍缺 3 条生产链路（`persistHandedOff` 直写 handoff_marker、`patchSessionCwd` 整文件重写、`createForkedSessionFile` 新建 session 文件写入 sessions 目录）——W11「直写归零」「R1 exit 0」的验收在真实代码下不成立，登记表例外集再次失真。属 r2 MF1 同类病的新实例，修复成本低（枚举 + 处置 + 验收同步）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | 父文档 §2.3 模式 1（「现存实例只有 #1 label」）/ §2.5（「xyz 的三个直写方」）/ 原则 1（「无白名单、无例外」）；子文档 W1 目标、W2 步骤 3（「历史三个直写点全部有着落」）、W3 步骤 2/验收 1 与 4、W11 目标/验收 1 与 3 | P0-12 遗漏 + P0-11 事实 | **绝对写规则的直写方集合仍缺 3 条生产写链路**（源码逐一核实）：① `persistHandedOff`（`packages/runtime/src/infra/pi/session-file-utils.ts:464` `openSync(filePath,'a')` 直接 append `handoff_marker` entry 到 pi JSONL；生产调用链 `handoff-service.ts:286` → `session-service.ts:1080 markHandedOff`，活跃 session 交接时必经）；② `patchSessionCwd`（session-file-utils.ts:518，readFileSync + 改首行 + `atomicWrite` 整文件重写 session JSONL；生产调用 `session-lifecycle.ts:405` restoreSession；其 docstring 自认「patchSessionCwd 与 _persist() 之间存在写写竞态」——恰是设计定义的「最危险」时序约定模式）；③ `createForkedSessionFile`（`packages/session/session-fork.ts:175` `writeFile(newFilePath,…)`，newFilePath = `join(getSessionsDir(), …)`（调用点 session-lifecycle.ts:532 传 `getSessionsDir()`），xyz 直接生成 pi 格式 session 文件；失败分支还有 `unlink(forkedFilePath)` 删 pi 文件）。后果：(a) W11 目标「xyz runtime 对 pi session JSONL 的直接写入代码归零」为假——三条路径 W1+W11 均不删除；(b) W11 验收 1「ALLOWLIST 空时 check_pi_direct_write exit 0（全仓已无直写模式）」不成立——persistHandedOff 的 `openSync('a')` 是 session-file-utils.ts 内的字面量直呼形态，R1 首版即可命中，且登记表无该例外（按 W3 自身规则「发现未登记写方 = 停止上报，禁止登记放行」将造成执行死锁）；(c) W11 验收 3 的 grep 实测命中 session-file-utils:464 与 session-fork.ts:175，且均指向 sessions 目录，「无一指向 sessions 目录写路径」不成立；(d) 父 §2.3 模式 1「现存实例只有 #1 label」失真（patchSessionCwd 是带时序守卫的同文件双写方）；W2「三个直写点全部有着落」的反向承诺（防 review 误判「另有未登记写方」）被证伪——确实另有未登记写方 | 补全写方全集并逐条处置：handoff_marker → 扩展 `appendEntry`（D4 通道）或 sidecar（D3 形态，与 persistSessionEnd 同构）；patchSessionCwd → 改经 pi（switch_session 容错 cwd）或登记为带期限例外并写明竞态边界；fork 文件创建 → 显式裁决（pi 侧 fork / 登记为「文件创建型」合法形态，与 sidecar 同级登记）；同步修正 W1 目标表述、W2 例外集、W3 allowlist 预期、W11 验收、父 §2.3/§2.5 |
| SUGGESTION | 子文档 W11 验收 1（stage-①） | P0-13 验收精度 + P1-8 | **r2-S2 修复不彻底（改形残留）**：`grep -rn "persistSessionName" packages/ --include="*.ts" \| grep -v "^\s*//" \| grep -v "^\s*\*" \| grep -v "\.test\.ts"` 的前两个过滤器对 `grep -rn` 输出**永不匹配**（输出行以 `packages/…` 路径前缀开头，不以 `//` 或 `*` 开头；实测 jsonl.ts:60 注释行穿透过滤器原样输出）。stage-①「输出为空」在不删 [HISTORICAL] 注释的前提下不可达成，与同段「最终以无过滤全量 grep 复核：命中仅剩注释」及注释保留惯例自相矛盾——照单执行要么验收永红、要么逼实施者删历史注释 | 过滤器改为匹配路径后的注释形态（如 `grep -vE ':[[:space:]]*(//\|\*)'`），或删掉 stage-① 的「输出为空」要求、仅保留「代码引用清零（排除注释后）+ 注释逐条人工核对」两段式 |
| SUGGESTION | 子文档 W1 步骤 2 + 涉及文件清单 | P0-12 边界 | 两处执行层缺口：① `this.svc.getRpcClient(sessionId)` 返回类型是 `IPiEngine`（`services/ports/pi-engine.ts:131`，实证 `session-service.ts:522`），W1 只在 rpc-client.ts 加 `setSessionName`、文件清单不含 pi-engine.ts——按清单实施 typecheck 必失败（接口无该方法）；② 处方用可选链 `?.setSessionName(newName)`，client 缺失（pi 崩溃窗口）时静默 no-op，而 `session.label`/metaCache 已先更新 → UI 显示新名、零持久化、无 toast，与同步骤「RPC 失败时抛错给上层 toast」自相矛盾 | W1 涉及文件补 `services/ports/pi-engine.ts`（接口声明，与「文件数 6-7」说明同步）；rename 处方改为显式 guard：client 缺失即 throw（走既有失败路径） |
| SUGGESTION | 子文档 W6 步骤 1 vs W7 步骤 1（thinkingLevel 条目）/ 父文档 §3.0 原则 4、D7 | P1-5 一致性 | **原语能力面与实例需求错配**：W6 的构造配置 `{fetchSnapshot, debounceMs, backoffSchedule, merge, fieldsNullSemantics}` 无周期重拉字段；W7 thinkingLevel 条目要求「配置同时登记周期兜底重拉，间隔取 30s」（pi 同档位切换不发射事件，无法纯事件失效）；父文档原则 4/D7 明言原语形态含「周期/重连兜底重拉」。W6 实施者按规格交付的原语满足不了 W7 的配置需求 | W6 步骤 1 构造配置补 `pollIntervalMs?: number`（可选，默认关闭），与父文档「周期/重连兜底」声明对齐 |
| SUGGESTION | 子文档 W14 验收 3 | P0-13 验收精度 | `grep -n "drainPending" packages/renderer/src -r` 命中数 = 0——实测 **6 命中**（`__tests__/fg5-message-stream.test.ts` 注释 ×2、`__tests__/stores/chat-chunk-content-blocks.test.ts` 注释 + `vi.fn` ×2、`api/mock/index.ts` 注释 ×2）。「renderer 无直接依赖」的结论本身成立（生产代码 0 命中），但验收命令按字面必失败 | 验收命令补过滤（`\| grep -v __tests__ \| grep -v api/mock`）或改为只扫生产目录（composables/components） |
| SUGGESTION | 子文档 W1 验收 3（回归第 3 条） | P0-13 场景精度 | 「新建 session 带显式名 → 重启 app 后名字保留」未写明前提「已发消息并触发 pi 首次 flush」。本轮实证 pi `_persist`（session-manager.ts:934-946）：首条 assistant 消息前 session_info 只进内存缓冲、session 文件不存在——零消息窗口下重启，session 整体不在磁盘，名字无从保留（与现状等价、非回归，但照字面测试会误判实现失败） | 验收步骤补前提：「发送至少一条消息等 turn 完成后重启」；handoff 场景天然满足（创建后立即注入 doc 跑 turn） |
| INFO | 子文档 W21（涉及文件/步骤 1/验收） | P1-8 | `message_end` 现也在 NULL_EVENTS（event-adapter.ts:712-718 实测，Set 含 `'turn_start','message_end',…,'entry_appended'`）；W18 对 `entry_appended` 显式写了「移出 NULL_EVENTS」，W21 对 `message_end` 只写「翻译时重构 entry 形态」未显式写移出、验收也无 NULL_EVENTS 断言——实施者若只加 handler 不移出集合，事件被 short-circuit、实时 feed 静默为空 | W21 步骤补一句「message_end 移出 NULL_EVENTS」+ 验收加 grep 断言（对齐 W18 的写法） |
| INFO | 父/子多处 | P1-8 | 细节漂移汇总（均不影响决策，实证行号）：`persistSessionName` 活跃调用 :297（文档 296）/非活跃 :304（文档 302）；tryPersistLabel agent_end 调用 :901（文档 902）；tryPersistLabel docstring :1275-1281、函数 :1283（W11 注释集写 :1279，属注释块内，勉强成立）；父 §1「NULL_EVENTS 710-715」实际 Set 字面量 712-718（子 W18 写 712-716 亦略偏）；W3 步骤 2 称 check_sidecar_session.py 有「移除期限」注释先例——该文件仅有通用例外注释（:42），无期限式先例；W5 fixture 定位用 `command -v pi` 而生产 process-manager.ts:52 用 `which pi`，「命令形态对齐」表述不准 | 顺手修正；不阻塞 |

## 四大审查方向结论

1. **对抗式（P0-7/8/9/10）**：五条终态原则与方案 B 的对比-推荐结构维持成立（本轮未找到推翻终态的反例；A/C 被否推演、D3 sidecar 合法性、D6 按字段分权威、D5 message_end 形态均经本轮源码复核为真）。本轮攻击命中的仍是**迁移期写方集合**：r2 MF1 修了 tryPersistLabel，但同一枚举动作没有穷尽——persistHandedOff / patchSessionCwd / createForkedSessionFile 三条生产写链路漏网（MUST_FIX 1）。这印证了设计自己的论断「例外会衰变」：写方集合靠逐轮审查补丁维护，恰说明 R1 机器检查 + 登记表全集才是正解——方向不变，清单要补全。
2. **问题定义与根因（P0-4/5/6）**：通过（维持 r2 结论）。SCQA 忠实使用者问题；§2.4 根因（无 owner 结构）证据链完整；12 类清单 + 四模式归类 MECE。注：§2.3 模式 1 的「现存实例只有 #1 label」表述被 MUST_FIX 1 部分证伪（patchSessionCwd 属时序守卫下的同文件双写方），但模式分类学本身不受影响。
3. **副作用/遗漏/关键事实（P0-11/12/16/17/18）**：pi 侧事实全真（含本轮重点复核的上轮修复新声明：`_persist` pre-flush 内存缓冲 + `openSync("wx")` 首 flush、`set_session_name` 拒空名 rpc-mode.ts:633-637、agent-session 全部锚点、extensions/types.ts appendEntry/SendUserMessageHandler）；xyz 侧新声明（W1 行号群、scanner fallback `s.name ?? basename(s.cwd)`、process-manager.ts:52、sessionMetaCache 2 写点 0 读者、.githooks 13 py / 生成体 16 CHECKER= / taste-lint 13 规则）逐一实证为真。**唯一影响决策的事实/遗漏问题 = MUST_FIX 1（写方集合）**；其余为验收命令精度（SUGGESTION 1/4）与执行层缺口（SUGGESTION 2/3）。物理数据流图（P0-17）、错误恢复指引（P0-18）、探针标注诚实性（P0-16）维持通过。
4. **验收（P0-13/14/15）**：整体框架维持通过——父 §4 五场景全部真实环境无 mock、回溯 G1-G4、可证伪；子 25 wave 三段式验收（代码级 grep + 行为级 pnpm dev 真实验证 + 回归）结构优秀。但**验收命令的可执行性存在 4 处缺陷**：W11 stage-① 过滤器无效（SUGGESTION 1）、W11 验收 1/3 被 MUST_FIX 1 的漏网写方击穿、W14 grep 误报（SUGGESTION 4）、W1 验收 3 缺 flush 前提（SUGGESTION 5）。W5 的「断言非空转」对照验证维持好评；W1 验收 1 的 `grep tryPersistLabel\|labelPersisted = 0` 经核实现状命中（session-service.ts:1191/1280/1283/1285、types.ts:110、lifecycle:290-294）确实可清零，可用。

## 防复发检查（r2 九条逐条复验）

| # | r2 finding（摘要） | 本轮验证结论 |
|---|---------------------|-------------|
| MF1 | tryPersistLabel 扩围（W1/W2/W3/父图） | **已修复**。W1 步骤 3 全链删除（方法 1283-1287、调用 :878 精确/:901≈902、init :1191 精确、types.ts:110 精确、两 handler docstring 改写）；W2 步骤 3 补三写点处置去向；W3 allowlist 预期含 tryPersistLabel 排除；父 §2.5 补写方 3、D2/P0.1 扩围同步。**但同类新实例复发**：fork/handoff/patchCwd 三条写链路仍漏（本轮 MUST_FIX 1，非上轮修复的副作用，是同一枚举动作未穷尽） |
| MF2 | W5 虚假先例 | **已修复**。W5 现为「净新增基建」重述；实证 rpc-client-bash.test.ts:45 `vi.mock('node:child_process')` 全 mock；`skipIf` 实际使用全仓仅 `test/e1-e3-real-verify.test.ts:71`（tokens.test.ts:27 仅注释提及，不构成反例）；process-manager.ts:52 `which pi`/`where pi` 实证存在；规模复核（M 档 ~250-300 行）已补 |
| S1 | sessionMetaCache 计数失真 | **已修复**。父文档三处（§1 C/术语表/D1 表）统一为「生产写点仅 2 处 setLabel（index.ts:298 / session-lifecycle.ts:289）、setThinkingLevel 0 处、getLabel/getThinkingLevel 无生产读者」——本轮 grep 实证完全一致（生产命中恰 2 处，getLabel 仅测试调用） |
| S2 | W11 验收 grep 误伤注释 | **修复不彻底（改形残留）**。两段式框架引入，但 stage-① 的注释过滤器对 `grep -rn` 输出（带路径前缀）永不匹配，实测注释行穿透；「输出为空」与「最终仅剩注释」复核自相矛盾 → 本轮 SUGGESTION 1 |
| S3 | 单元计数 17≠19 | **已修复**。子 §0 首句 19（P0 5 + P1 5 + P2 3 + P3 3 + P4 3），映射表 19 行齐全 |
| S4 | .githooks/pre-commit 基线数字 | **已修复**。W3 现写 13 个 .py checker（实测 13）、16 行 CHECKER=（实测生成体 16） |
| S5 | D1b label/sessionName 双登记相反语义 | **已修复**。父 D1b 末条 + 子 W2 步骤 2 + W7 步骤 1 三处一致：「label 与 sessionName 同一数据链、不单独登记可守卫语义」；「用户清空名字」反例叙事已改为「set_session_name 拒绝空名（rpc-mode.ts:633-637 实证）+ undefined 真实来源 = 未命名初始态」 |
| INFO1 | W12 包装实例过渡态登记 | **已修复**。W12 步骤 1 commit 4/5 注记「W12-W18 过渡：写入口 = 事件流（已登记例外），W18 起源 = entry 扫描」+ 登记表同步要求 |
| INFO2 | 行号漂移汇总 | **已修复**。W10 锚点 L842（applyContextUpdate 实证 :842）/L467（switchModel 实证 :467）；scannedToSummary 实证 :81-82。本轮新汇总的 ±1-2 行漂移见 INFO 2（量级不升） |

r1 基线抽查（3 条）：MF1（D1b sessionName 反例替换）修复保持 ✅（ThinkingLevel 修正注 + sessionName getter/空名语义实证）；MF3（subscribe/ring 去留）修复保持 ✅（D7 补漏段 5 话题 + P1.5 + W12，话题清单与 TOPIC_TABLE 实测一致）；S5（plugin sessionData 登记）修复保持 ✅（§2.2 覆盖说明 + §3.6 第 4 层 + W2 步骤 4；SessionDataStore 单写路径沿用 r2 核实）。

## 父子一致性结论

- **单元承接**：19 个单元全映射（§0 表 19 行），P0.5 无实施 wave 有理由注明；P1.2 并入 W7/W8、P3.1 三分、P3.3 二分、P4.2 二分均与父文档一致。
- **决策引用**：D1-D8、原则 1-5、场景 1-5、G1-G4 抽查无曲解；D1b 空值语义在父 D1b / 子 W2 / 子 W7 三处归一一致（r2-S5 修复验证）。
- **矛盾清单**：本轮唯一实质性分歧点 = MUST_FIX 1 是**父子共同遗漏**（父 §2.5「三个直写方」与子 W2「三个写点全部有着落」同步失真），非父子互相矛盾。W6/W7 的原语能力面错配（SUGGESTION 3）属子文档内部前后不一致。其余未发现矛盾。
- **规模/依赖图**：W1-W25 依赖边抽查合理；W11 对 W6 的依赖理由仍牵强（rpc-client 在 W1 后即可用）但不产生错误顺序（维持 r2 结论）；并行组与文件互斥约束正确。

## 事实核实清单（本轮新增核实；上两轮已核实且未变化的不再重复）

| 文档宣称 | 核实结果 |
|---------|---------|
| pi `_persist` pre-flush 内存缓冲、首条 assistant 前 openSync("wx") 全量写出（W1 前置依赖/D2 核心新声明） | ✅ session-manager.ts:934-961（`hasAssistant` 判定 + `flushed` 状态 + `openSync(sessionFile,"wx")`）；`_appendEntry`:963-967 |
| `set_session_name` 拒绝空名 rpc-mode.ts:633-637 | ✅ 逐字「Session name cannot be empty」 |
| getSessionName 空名语义 / appendSessionInfo | ✅ session-manager.ts:1053 / 1066-1076（`entry.name?.trim() \|\| undefined` + "Empty names explicitly clear"）；agent-session.ts:2718-2723 setSessionName → appendSessionInfo + session_info_changed |
| custom entry 不进 LLM context（session-manager.ts:377-385） | ✅ sessionEntryToContextMessages ~380-390 |
| agent-session 锚点群 | ✅ :140 entry_appended 类型 / :503-508 queue_update 全量数组 / :891-892 sessionName getter / :1243-1254 steer 展开（_expandSkillCommand + expandPromptTemplate）/ :1458-1470 _emitModelSelect 仅 extensionRunner / :2264-2271 appendEntry→appendCustomEntry→emit(:2269) |
| rpc-mode 锚点群 | ✅ :354-356 subscribe 全量转发 / :385 固定 switch / :442 get_state / :566 get_session_stats / :609+:615 get_entries+since 失效报错 / :632 set_session_name / :645 get_messages |
| extensions/types.ts | ✅ :325 hasPendingMessages / :1261 appendEntry / :1480-1482 SendUserMessageHandler（deliverAs） |
| pi 事件名 message_end / tool_execution_start / tool_execution_end 存在 | ✅ agent-session.ts:545/676/685/702 等 |
| scanner fallback basename（W1「重启后显示值不变」依据） | ✅ session-scanner.ts:73 `label: s.name ?? basename(s.cwd)`；:81-82 `modelId:''`/`tokenCount:0` |
| W1 行号群 | ✅ getState ~:206 / create `label ?? basename(sessionCwd)` ~:234 / renameSession :284 / setLabel :289 / labelPersisted 重置 :294（精确）/ 活跃 persistSessionName :297 / 非活跃 :304 / fork :635 / tryPersistLabel 1283-1287（调用 :878 精确、:901≈902）/ init :1191（精确）/ types.ts:110（精确）/ getRpcClient :522 / 现有调用方 message-handler:62 + handoff-service:279（均为 create+显式 label，精确） |
| rpc-client 从未接线 set_session_name / 方法锚点 | ✅ 全文无匹配；getHistory[DEAD]:511 / getEntries:527 / getCommands:572 / getSessionStats:579 / getState:591 |
| **persistHandedOff 直写（MUST_FIX 1 证据①）** | ✅ session-file-utils.ts:~455-475（openSync('a') :464）；生产链 handoff-service.ts:286 → session-service.ts:1080（markHandedOff）；ports/session.ts:149 + session-store.ts:88 转发 |
| **patchSessionCwd 整文件重写（证据②）** | ✅ session-file-utils.ts:518-545（readFileSync→改首行→atomicWrite 重写）；调用 session-lifecycle.ts:405（restoreSession）；docstring :511-513 自认与 _persist 写写竞态 |
| **createForkedSessionFile 写 sessions 目录（证据③）** | ✅ session-fork.ts:74/:175（writeFile(join(targetDir,…))）；调用 session-lifecycle.ts:532 传 getSessionsDir()；失败分支 unlink(forkedFilePath)（:611 附近） |
| W11 验收 3 grep 实测 | ✅ 命中含 session-file-utils openSync('a')（:427 persistSessionName / :464 persistHandedOff）与 session-fork.ts:175 writeFile——后两者指向 session 文件，验收「无一指向」不成立 |
| W11 stage-① 过滤器实测 | ✅ `grep -v "^\s*//"` 无法过滤 grep -rn 输出（jsonl.ts:60 注释行穿透） |
| W14 验收 3 grep 实测 | ✅ renderer 6 命中（全在 __tests__/api/mock），生产 0 命中 |
| sessionMetaCache 生产写点 = 2 | ✅ index.ts:298 + session-lifecycle.ts:289；setThinkingLevel 生产 0；getLabel/getThinkingLevel 仅测试 |
| event-adapter | ✅ NULL_EVENTS Set 712-718（含 message_end 与 entry_appended）；DISPATCHER queue_update:736 / session_info_changed:737 / thinking_level_changed:738；custom message ~517-527 |
| message-bus / message-handler | ✅ TOPIC_TABLE:56 起（5 state 话题一致）/ queue_update stream :82 / STATE_TYPE_KEY_MAP:131；message-handler:62（create label）/ :255 getSubagents / :314-326 subscribe+stateSnapshot |
| session-service publish/收编锚点 | ✅ state_changed ~1254 / commands ~1323 / context.update ~1378 / applyContextUpdate :842 / setInputTokens :826 / getInputTokens :822 / getHistory 注释 549-553 / thinkingLevel 注释 ~450 / 竞态注释 ~459-465 与 ~837 |
| core 包锚点 | ✅ session store 56/70/73/109；chat store pendingBuffer:123 / drainPending:335 / abortPending ~351 / applyMessageEvent ~368；registry countDrained 65 区 / queue_update effect ~508 |
| 基建与流程 | ✅ .githooks 13 个 .py；生成 pre-commit 16 行 CHECKER=（commondir）；taste-lint/rules 13 条；check-domain-boundaries-node.mjs 存在；ADR 最高 0061、0042/0037 文件名正确；review-data-governance.md 存在且入 SKILL 8 维；process-manager.ts:52 which/where pi；scripts/ 无 sessions 目录写方（R1 scripts 侧范围干净） |
| extensions 锚点 | ✅ record-store appendEntry 通道 :175/:223、manifest-invalid-status ~350；jsonl-run-store workflow-state-link :455 / 扫描 ~539；rename-session :68 "skip: name exists" / :74 renamed to |
| 测试基建 | ✅ rpc-client-bash.test.ts:45 vi.mock 全 mock；skipIf 实际使用全仓 1 处（e1-e3:71）；test/ 三文件存在，session-service.test.ts rename 断言 ~716、tryPersistLabel 区 248-313 |
| git status | ✅ 两被审文档零改动；r2 修复 commit = ace14329d |

## 总体裁决

**需修改后通过**。1 个 MUST_FIX（直写方集合补全：persistHandedOff / patchSessionCwd / createForkedSessionFile，同步 W1/W2/W3/W11 验收与父 §2.3/§2.5）为 r2 MF1 同类病的残余枚举缺口，不动摇终态架构、方案 B 与 D1-D8；上轮 9 条修复中 8 条经源码级复验为真实修复、新增事实声明全部为真，修复质量整体可信。5 条 SUGGESTION 集中在验收命令可执行性与原语能力面对齐，修复成本均低。MUST_FIX 修完 + SUGGESTION 随手修后即可进入 W1 执行。
