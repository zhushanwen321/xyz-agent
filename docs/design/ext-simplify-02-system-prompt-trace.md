# ext-simplify-02：taiji/system-prompt-trace 过度设计收敛（删自持久化 baseline + Like\*Event 归一）

> **一句话结论**：删除 system-prompt-trace 为「拿不到 session 文件路径」场景平行再造的自持久化 baseline 子系统（约 120 行），onSessionStart 基线解析收敛为「stash → getSessionFile() 直读」两档；Like\*Event 三接口与 SessionStartReason/normalizeSessionStartReason 归一到 pi SDK 已导出类型；顺带修复 persisted 路径 parentVersionDiffSummary 永远缺省的数据层缺口。执行前有一次 pi CLI 探针门槛（⛔ 见 §6.4）。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-system-prompt-trace`（v0.1.5）是 xyz-agent 的 taiji 组 builtin extension——每当 effective system prompt 建立或变化时向 session JSONL 追加一条 `xyz:system-prompt` 留痕 entry，供 GUI Trace 视图与排查使用。为跨重启去重（同一 prompt 重开后不重复写），它维护一个「hash 基线」，解析路径共三路：switch stash 直读 / fork previousSessionFile 直读 / **agentDir 自持久化小文件**（`system-prompt-trace-baseline.json`，含原子写、tmp 唯一化、RMW 竞态论证、64-session 剪枝，约 120/201 行 baseline.ts）。
- **C（冲突）**：2026-09-11 过度设计审计（候选 2/11，taiji 单元）证实该自持久化层的存在前提是假的——它赌「app 重启直 spawn resume / reload 等无 switch 事件的链路拿不到 session 文件路径」，而 pi 0.84.4 的 `ExtensionContext.sessionManager`（`ReadonlySessionManager`）本就含 `getSessionFile()`，且留痕 entry 自身完整落盘 fullText，直读 session JSONL 最后一条留痕即得比小文件更强的基线（hash+version+**fullText**）。同时本包自定的 3 个 `Like*Event` 接口 + `SessionStartReason`/`SESSION_START_REASONS`/`normalizeSessionStartReason` 全链冗余于 SDK 已导出类型。
- **Q（问题）**：如何在不损失留痕主链路（switch 去重、version 续接、reload 去重）的前提下，删掉这个自产自销的持久化子系统与冗余类型层，并把「fork 基线语义」这个挂着「暂定，待 P2 实测定」的悬置点一并关闭？
- **A（答案）**：基线解析收敛为两档——stash（resume 主链路，保留）→ `getSessionFile()` 直读 JSONL 最后留痕（覆盖 reload / 直启 resume / fork / 兜底）；类型层全部 `import type` SDK 具名类型。一次本地 pi CLI 探针（四 reason × getSessionFile 矩阵）作为实施期门。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单），准则 5/6/7 全适用。

**证据基线**：pi SDK 断言全部核对自本 worktree 实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4` 的 dist 编译产物（npm ls 确认版本），非 clone 参照。审计报告四问全文见 taiji 单元导出（sa-dea80496）；本文化引的行号均为 2026-09-12 实读值。

---

## 1. 背景：被设计的系统是什么

**system-prompt-trace 解决的问题是「effective system prompt 的变化不可见」**：xyz-agent 的 system prompt 由多源拼装（builtin 注入、`--append-system-prompt`、skill、AGENTS.md 等），跨 turn 可能变化，但变化本身不落任何痕迹。本 extension 以 custom entry（不进 LLM context，零模型侧影响）形式向 session JSONL 追加留痕：每次建立或变化时写 `{version, hash, reason: initial|resume|change, fullText, charCount, parentVersionDiffSummary?}`，version 在 session 内单调递增。GUI Trace 视图（`packages/core/src/domain/session-trace/trace-rows.ts` 的 `summarizeSystemRow` 投影 version/reason/hash/charCount）与排查流程消费它。

「hash 基线」是去重的依据：session 重开（switch/reload/重启）时先恢复上次的 hash+version，首个 turn_start 对比当前 prompt hash——相同则不写（避免重开一次多一条重复留痕），不同则写 `resume` 并续接版本号。

关键消费链路（本次必须全部不回归的面）：

| 链路 | 入口 | 现状基线路径 |
|---|---|---|
| GUI 内 switch session | runtime `switch_session` RPC（`packages/runtime/src/infra/pi/rpc-client.ts:1016`，恢复 session 唯一入口）→ pi `switchSession` | 路径 1：旧 runtime 在 `session_before_switch` 直读目标文件存 stash（模块级单例跨 runtime 传递） |
| TUI `/resume`、`/new` | pi `agent-session-runtime.js` 同款 switchSession/newSession | 同上（new 档无基线） |
| fork | pi `fork()`（TUI fork / GUI 经 switchSession 走 resume） | 路径 2：读 `previousSessionFile`（源 session 文件）——**types.ts/trace.ts 注释自认「暂定语义，待 P2 实测定」** |
| skill 变更 reload | SkillRegistry → `ReloadOrchestrator`（`packages/runtime/src/services/session/reload-orchestrator.ts:22-24`）→ `/__xyz_reload__` → agent-ext 调 `ctx.reload()`；TUI 侧 `/reload`（interactive-mode.js:2487） | 路径 3：**自持久化小文件**（本设计删除对象） |
| app 重启直 spawn resume | `pi --resume/--session` 或 xyz-agent runtime spawn | 路径 3：同上。**注意：该链路 session_start 的 reason 实为 `"startup"` 且不带 previousSessionFile**（main.js:570 `isInitialRuntime` 分支 + agent-session.js:152 默认值；SDK 类型注释也声明 previousSessionFile 仅 new/resume/fork 存在） |

## 2. 设计目标

1. **主链路零回归**：GUI switch / TUI resume / fork / skill reload / 重启直启五链路的留痕行为（去重、version 续接、reason 语义）与现状一致或更准。
2. **删自持久化子系统**：baseline.ts 中 PersistedBaselineEntry/File、readPersistedBaseline、writePersistedBaseline、loadBaselineFileForWrite、uniqueTmpPath、pruneSessions、MAX_BASELINE_SESSIONS 及 TraceEnv/types/index 的对应 wiring 整体移除，包内不再有第二个持久化状态源。
3. **数据层缺口修复**：`parentVersionDiffSummary` 在「重启直启 resume 后 prompt 变化」场景不再缺省（现状 persisted 只有 hash+version 无 fullText，见 baseline.a12.test.ts:190 的 `toBeUndefined()` 断言自证）。
4. **类型层归一**：Like\*Event 三接口与 SessionStartReason/SESSION_START_REASONS/normalizeSessionStartReason 删除，事件接入直接用 SDK 具名类型（与同组 msg-id-mapper/system-prompt 的既有风格一致）。
5. **悬置关闭**：fork 基线的「暂定语义，待 P2 实测定」注释随直读方案定案，不再有待验证标记。

**In-scope**：`extensions/taiji/system-prompt-trace/`（src + tests）+ `docs/architecture/data-source-registry.md` §6 对应条目回写（C-proc-10 同步纪律）。
**Out-of-scope**：
- goal / smart-context / rename-session 的同模式 Like\* 归一（审计候选 3/11 的跨包部分，见各自包设计文档）；
- GUI Trace 视图对 `parentVersionDiffSummary` 的投影（该字段现状仅扩展自身测试消费，`summarizeSystemRow` 未读它——本次只保证数据层可产出，投影是独立产品决策）；
- stash 机制本身的删除（见 §6.1 被否谱系）；
- handler `async` 标记等 suggestion 级清理（不在审计覆盖面内）。

---

## 3. 现状：使用者眼里是什么样的

### 3.1 现状的真实样子（取自代码与测试）

一次 GUI 内 switch session 的留痕轨迹（现状正确路径，来自 a12 测试「路径 1」场景）：

```
session A：turn1 写 xyz:system-prompt {version:1, reason:"initial", hash:H1, fullText:...}
用户切到 session B 再切回 A：
  旧 runtime onSessionBeforeSwitch("resume", A的文件) → 直读 A 最后留痕 → stash{H1,v1}
  switchSession: emitBeforeSwitch → SessionManager.open(A文件) → teardownCurrent
               → createRuntime(新 manager, session_start{reason:"resume", previousSessionFile:切换前B文件})
  新 runtime onSessionStart("resume") → 消费 stash{H1,v1} → baseline 命中
  turn_start：hash(A当前prompt)==H1 → 不写。JSONL 仍 1 条留痕，Trace 视图 version 不变 ✓
```

persisted 路径的真实样子（本设计要消灭的路径，来自 a12 测试「路径 3」场景）：

```
app 重启直 spawn resume session A（session_start reason:"startup"，无 switch 事件）：
  onSessionStart 落到第三档 → readPersistedBaseline(agentDir/system-prompt-trace-baseline.json, A的sessionId)
  → 只有 {hash:H1, version:1}，无 fullText
  turn_start：prompt 已变为 H2 → 写 {version:2, reason:"resume", hash:H2}
             → parentVersionDiffSummary 缺省（无 parent 全文可 diff）
             → 同时 writePersistedBaseline(RMW + tmp唯一化 + 剪枝) 刷新小文件
```

### 3.2 真实失败模式

- **F1（数据缺口）**：上述重启直启场景，`parentVersionDiffSummary` 永远 undefined——留痕声称记录「与上一版的 diff 摘要」但该路径物理上拿不到 parent 全文（小文件只存 hash+version）。测试以 `expect(...parentVersionDiffSummary).toBeUndefined()`（baseline.a12.test.ts:190）把缺陷固化为契约。
- **F2（认知负担）**：为这一个场景维护约 120 行持久化子系统（原子写/tmp 唯一化/逐 entry 校验/64-session 剪枝），外加 data-source-registry.md §6:114 一整段跨进程锁豁免论证（PR #186 MF2）——而它自产自销：写方=本包 writePersistedBaseline，读方=本包 readPersistedBaseline，包外零引用（审计实跑 `rg "readPersistedBaseline|writePersistedBaseline"` 全仓仅定义/消费/wiring 三处）。
- **F3（类型双轨）**：同包内两种事件接入风格并存——msg-id-mapper/system-prompt 直接 import SDK 类型，本包却自定 `SessionStartLikeEvent { reason: string }`（SDK 是五值字面量联合）再靠运行时 `normalizeSessionStartReason` 归一。SDK 类型演进（如 reason 新增值）时本地 `string` 静默放行而非编译报错——负防腐。
- **F4（悬置语义）**：fork 档读 `previousSessionFile`（源 session 文件全文），拿到的是**源文件最后**一条留痕；而 fork 到早期 turn 时正确基线应是**fork 截断点前**最后一条。现状注释自认「暂定，待 P2 实测定」（trace.ts onSessionStart 注释、types.ts mapReasonForFirstWrite 注释）。

### 3.3 根因

**对 pi SDK 能力的过时假设。** persisted 子系统赌「无 switch 事件的链路拿不到 session 文件路径」——实读 pi 0.84.4 dist 证伪：
- `ExtensionContext.sessionManager: ReadonlySessionManager`（extensions/types.d.ts:219），其 Pick 成员含 `getSessionFile(): string | undefined`（session-manager.d.ts:140 与 :208，实现直接返回 `this.sessionFile`，session-manager.js:723-725）；
- **session_start 事件触发时 ctx.sessionManager 已指向当前 session**：switchSession 在 `SessionManager.open(sessionPath)` 之后才 createRuntime（agent-session-runtime.js:126-144，新 manager 与 sessionStartEvent 同批传入）；fork 三分支同理（:174-253）；reload 不重建 manager（agent-session.js:2216-2232）；直启时 main.js 的 createRuntime 传入 createSessionManager 产物（main.js:536/:655）；
- 留痕 entry 落盘含 fullText（trace.ts write() 全量写入），直读 JSONL 最后一条即得完整基线——`readLastPromptFromSessionFile`（baseline.ts:57）就是现成函数，stash/fork 档已在用。

类型层同理：pi 0.84.4 包根具名导出 `SessionStartEvent`/`SessionBeforeSwitchEvent`/`TurnStartEvent`（dist/index.d.ts:7），`on()` 按事件名重载、handler 参数即 SDK 事件类型（extensions/types.d.ts:909/:911/:929），`SessionStartEvent.reason` 已是五值字面量联合（:419）。Like 簇的「逆变匹配更稳」理由声明不成立（同组两包直接用 SDK 类型工作正常）。

## 4. 物理数据流（现状 vs 终态）

> **基线（baseline）** = 跨重启恢复的 `{hash, version, fullText?}` 三元组，是「首个 turn_start 是否写留痕、version 从几续接」的判定依据。就是 §3.1 例子里 stash 那个 `{H1, v1}`。

现状（三路解析，其中路径 3 为本设计删除对象）：

```
                         ┌─ 路径1 stash：session_before_switch(旧runtime) ─直读目标JSONL─┐
session_start(reason) ───┤─ 路径2 fork：readLastPromptFromSessionFile(previousSessionFile) ├→ baseline
                         └─ 路径3 persisted：readPersistedBaseline(agentDir小文件[无fullText])┘
写留痕时(write)：appendEntry(JSONL) + writePersistedBaseline(小文件双写) ←── 第二个持久化状态源
```

终态（两路解析，单一持久化源 = session JSONL 自身）：

```
                         ┌─ 档1 stash：session_before_switch(旧runtime) 直读目标JSONL（resume 主链路，保留）
session_start(reason) ───┤
                         └─ 档2 直读：ctx.sessionManager.getSessionFile() → readLastPromptFromSessionFile
                                   （覆盖 reload / 直启resume / fork / new兜底；文件不存在或无留痕 → null）
写留痕时(write)：仅 appendEntry(JSONL) ←── 唯一持久化源；小文件不再有写方
```

四 reason 下档 2 的行为矩阵（源码依据见 §6.4 探针 P1–P3）：

| session_start reason | 触发链路 | getSessionFile() 指向 | 直读结果 | 后续 turn 行为 |
|---|---|---|---|---|
| startup（新会话） | 直启无 --session | 新文件路径（`_persist` 延迟：首条 assistant 前不落盘，文件不存在） | null | 写 initial v1 |
| startup（直启 resume） | `pi --resume/--session` / runtime spawn | open 的目标文件 | 最后留痕（含 fullText） | hash 命中不写；变化写 resume v+1 带 diff 摘要（**修复 F1**） |
| resume | switchSession（GUI switch_session RPC / TUI /resume） | open 的目标文件（与 stash 同源同值，stash miss 时兜底） | 同 stash | 同现状 |
| fork | fork() 三分支 | fork 后新文件（targetLeafId 分支含截断点前 entry；无 targetLeafId 分支未 flush） | 截断点前最后留痕（**修复 F4**） | version 从截断点续接 |
| reload | ctx.reload()（skill 编排 / TUI /reload） | 当前文件（不换 manager） | 当前最后留痕（**替代 persisted**） | hash 命中不写 |

---

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径（重启直启场景，即现状 F1 缺口场景的修复后形态）

```
前置：session A 已有留痕 {v1, initial, hash:H1, fullText:P1}，app 重启。
$ pi --resume（或 xyz-agent runtime spawn 直启 A）
  session_start(reason:"startup") → 档2 直读 A 文件 → baseline{H1, v1, fullText:P1}
  turn_start：当前 prompt == P1 → hash 命中 → 不写，留痕仍 1 条
用户修改 system prompt append 配置后继续对话：
  turn_start：hash 变为 H2 → 写 {v2, resume, hash:H2, fullText:P2,
            parentVersionDiffSummary:"+2 -1 lines ..."}   ← 不再缺省
  Trace 视图重开 A：v1 → v2 两条留痕，v2 带 diff 摘要（数据层就绪；GUI 投影 out-of-scope）
磁盘面：agentDir 下不再出现 system-prompt-trace-baseline.json 的写动作；
       旧文件若存在则成为无读方孤儿（见 D3）。
```

reload 场景（GUI skill 变更链路）在终态下与上同构：`/reload` → session_start(reason:"reload") → 档 2 直读当前文件 → 命中不写。

### 5.2 失败路径（带恢复指引）

- **JSONL 读取失败/损坏**（文件被截断、单行 JSON 损坏）：`readLastPromptFromSessionFile` 逐行倒序扫描 + `parseTraceEntryData` 运行时 guard（types 校验不符返回 null），坏行跳过、全坏返回 null → 无基线 → 首个 turn 按 reason 兜底写（resume 必写）。恢复：无需动作——留痕是诊断性旁路，多写一条是设计 D2 已接受语义；要排查损坏原因看 `~/.pi/agent/logs/`（XYZ_AGENT_DEBUG=1）。
- **getSessionFile() 返回 undefined**（session 从未 flush，如纯内存 session 或首 assistant 前）：视为无基线 → initial/resume 兜底。恢复：同上，无需动作。
- **类型层**（Like 归一后）：pi 升级新增 reason 枚举值时，`mapReasonForFirstWrite` 的 switch 将出现编译期 non-exhaustive 报错（五值联合穷尽性检查）→ 负防腐生效，修复动作明确（补 case），替代现状的运行时静默归一为 "startup"。

## 6. 关键决策与权衡

**本章结论：4 个决策——两档基线解析（B 方案）、fork 基线取截断点、persisted 残留不主动清理、类型层 import type 归一。**

### 6.1 D1：基线解析收敛形态（选定：方案 B 两档）

- **采用**：`onSessionStart(reason, ctx)` 解析基线两档——①stash 命中（reason=resume 且 stash.pending 非空，cancelled 残照旧消费防污染）优先；②否则 `ctx.sessionManager.getSessionFile()` 直读 JSONL 最后留痕，miss → null。`previousSessionFile` 参数从 onSessionStart 签名与 wiring 中整体移除（SDK 事件类型里该字段仍存在，只是不再消费）。
- **被否**：
  - **方案 C（保留 persisted，声称 forward-ready）**——审计已否：120 行子系统自产自销（包外零引用）、无 fullText 导致 F1、RMW/tmp/剪枝全是自引复杂度；「未来基线丢失代价不可接受时升格 file-lock 正规锁」的 registry 登记恰恰证明它在为一个可避免的状态买保险。若用它，§5.1 的例子继续保持 diff 缺省，§4 数据流继续双持久化源。
  - **方案 A（审计原案三档：stash → fork previousSessionFile → getSessionFile 兜底）**——与 B 唯一实质差异在 fork 档。A 保留「读源文件」路径即保留 F4 语义偏差（fork 到早期 turn 时基线指向 fork 点**之后**的版本：hash 命中则漏写本应记录的重开点快照，hash 不中则 version 相对 fork 文件跳号）。若用 A，§4 矩阵 fork 行退化为「源文件最后留痕」，F4 悬置只能靠注释续命。
  - **方案 B+（连 stash 也删，onSessionBeforeSwitch handler 整体移除）**——stash 与档 2 在 resume 场景同源同值（switchSession 源码 :126-144，before_switch 时读与 session_start 时读指向同一目标文件、单进程顺序执行其间无写方），理论可删。但 stash 是审计明确保留的主链路保险（before_switch 时序 100% 先于 teardown，且 cancelled 语义已测试覆盖），删除收益（-1 概念 -1 handler）小于把主链路押在「session_start 时 manager 已就位」这一断言上的风险放大。**登记为后续审计机会，不在本次实施**。
- **证据**：session-manager.d.ts:140/:208（getSessionFile 存在性）；agent-session-runtime.js:126-144/:174-253（switchSession/fork 时 manager 先 open 后 createRuntime）；agent-session.js:2216-2232（reload 不换 manager）；main.js:536/:655/:570（直启传 open 的 manager）；session-manager.js:726-754（`_persist`：首条 assistant 前 entry 不落盘——档 2 对新 session 安全返回 null）；同包 stash 消费/取消残留语义见 trace.ts onSessionStart 现状实现。
- **效果**：目标 2（删子系统）、目标 1（五链路零回归——resume/fork/reload/直启全部落在矩阵内）、§5.1 成立。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| B 两档（选） | 单一持久化源（session JSONL 自身）；fork 语义 by construction 正确；删 ~120 行 + 4 概念 | 中：trace.ts/baseline.ts/index.ts/types.ts 四文件联动 + 3 个测试文件改写 + registry 回写 | reload/直启依赖 getSessionFile 时序（探针 P1–P3 把关，均有源码依据） | ✅ |
| A 三档（审计原案） | 同 B 但保留 fork 特判与 F4 | 低：改动面略小 | fork 语义偏差永续 + 「暂定待实测」悬置无法关闭 | ❌ |
| C 保留 persisted | 双持久化源，为已证伪的赌注持续缴税 | 零 | F1 缺口永续；每次全仓动作携带维护义务 | ❌ |

### 6.2 D2：fork 基线语义定案（选定：fork 文件截断点）

- **采用**：fork 档并入档 2 直读 `getSessionFile()`——读到的是 fork 后新文件（`createBranchedSession` 复制截断点前 entry），基线 = 截断点前最后一条留痕，version 从截断点续接；无 targetLeafId 的 fork（`newSession(parentSession)`，新文件不含历史 entry 且未 flush）→ 直读 null → 无基线 → 按 `mapReasonForFirstWrite("fork")="resume"` 写 v1 重开（该形态下 fork 文件本无留痕历史，v1 重开是诚实语义而非缺陷）。
- **被否**：读 `previousSessionFile`（源文件全文）——语义偏差见 D1 方案 A 否决理由。
- **证据**：agent-session-runtime.js fork 三分支（:174-253）——targetLeafId 分支 `SessionManager.open(currentSessionFile)` + `createBranchedSession(targetLeafId)` 后的 manager 即新 runtime 的 ctx.sessionManager；无 targetLeafId 分支 `SessionManager.create` + `newSession`（新文件 flushed=false）。
- **效果**：目标 5（悬置关闭——trace.ts/types.ts 的「暂定，待 P2 实测定」注释随实现删除）；§4 矩阵 fork 行成立（探针 P2 实证文件内容）。

### 6.3 D3：persisted 残留清理方式（选定：不主动删除旧文件）

- **采用**：发布后旧 agentDir 中可能存在 `system-prompt-trace-baseline.json`——新版本无任何读方/写方，成为孤儿文件。**不写迁移/清理代码**，仅做两件登记：①`docs/architecture/data-source-registry.md` §6:114 条目改标「已废弃（无读写方，可安全手动删除）」；②同表 :120 engines.json 条目中「参照上行 system-prompt-trace-baseline.json PR #186 MF2 先例」的参照锚点改为直接引用或历史标注，避免悬空引用（check-doc-symbol-drift.mjs 必须跑过，C-proc-10）。
- **被否**：主动删除（extension 启动时 unlink）——为一次性残留写永久代码，且对用户 agentDir 做写删除违反最小侵入。
- **证据**：孤儿文件量级实测上界 = 每 agentDir 1 个、≤64 session 条目、典型 < 10KB；无读方 = D1 删除面即全部读写方。
- **效果**：已接受代价四要素——量级：一次性 ≤10KB/agentDir；恢复路径：用户手动删或永留（无任何行为影响）；重审触发：无（一次性残留，不增长）；显式判定：可接受。

### 6.4 D4：类型层归一方式（选定：import type SDK 具名类型 + 删归一化链）

- **采用**：`index.ts` 删除 `SessionStartLikeEvent`/`SessionBeforeSwitchLikeEvent`/`TurnStartLikeEvent` 三接口，事件 handler 参数直接标注 SDK 导出的 `SessionStartEvent`/`SessionBeforeSwitchEvent`/`TurnStartEvent`；`types.ts` 删除 `SessionStartReason`（本地五值联合）、`SESSION_START_REASONS`、`normalizeSessionStartReason`，`mapReasonForFirstWrite` 保留（真实语义映射）但入参类型改用 `SessionStartEvent["reason"]` 索引访问；trace.ts 内部状态 `sessionStartReason` 同步改型。
- **被否**：
  - 保留 Like 簇仅删 normalize——半吊子：`reason: string` 的降级子集仍在，F3 的负防腐仍在。
  - 先在 SDK 侧提 feature request——项目纪律明确不修改 pi 源码不提 PR；且 SDK 已导出所需类型，无事可提。
- **证据**：dist/index.d.ts:7 具名导出三类型；extensions/types.d.ts:909/:911/:929 `on()` 按事件名重载（handler 参数即 SDK 类型）；:416-422 `SessionStartEvent.reason` 五值字面量联合 + `previousSessionFile?: string` 注释「Present for new/resume/fork」；同包先例 msg-id-mapper/system-prompt 直接 import SDK 事件类型（taiji 单元四问记录证实）。
- **效果**：目标 4；负防腐反转（SDK reason 演进 → 编译期 non-exhaustive 报错，恢复动作明确见 §5.2）；行为零变更（纯类型层——`normalizeSessionStartReason` 删除后「untyped extension 传入非五值」场景由 TS 契约接管，运行时不可达）。

另有两个 export 收敛执行项（审计 low 级，随 D1/D4 顺带）：`parseTraceEntryData`（baseline.ts:45）去 export——全仓仅同文件 :77 内部调用；`computePromptHash`（trace.ts:65）去 export——内部使用保留，测试改为本地 `createHash("sha256")` 计算期望值（纯函数等价引用，一行替代）。

### 6.5 探针清单（⛔ 实施期门，全部通过才允许合入删除提交）

| ID | 验证的行为 | 探针（本地 pi CLI，实装 0.84.4） | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | reload 时序：`/reload` 后 session_start(reason:"reload") 触发时 `getSessionFile()` 指向当前文件且最后留痕可读 → 首 turn hash 命中不写 | `XYZ_AGENT_DEBUG=1 pi --session-dir <tmp> --extension <本包路径>`（TUI）：发消息产生留痕+assistant → `/reload` → 再发一条消息 → 数 JSONL 的 `xyz:system-prompt` 条数应为 1（不增）；日志确认 session_start reason 与直读命中 | ⛔ 合入前 | 失败模式 ①manager 未就位/文件不可读：核对失败输出与 dist 源码断言差异；若 pi 行为与源码不符按版本门禁流程重验（check-pi-semantics）。②仅 reload 档失效且确认 pi 固有限制：fork/resume/直启三档不受影响时可缩为「reload 档保留 readPersistedBaseline 只读不写」的窄保留并回本设计文档重审 D1 |
| P2 | fork 后 `getSessionFile()` 指向 fork 新文件且内容 = 截断点前 entry（非源文件全文） | TUI 内 fork 到早期 turn（`/fork` 或树导航）→ 读 fork 文件最后一条 `xyz:system-prompt` 的 version，应等于截断点前最大 version 而非源文件最大 version；继续对话 → 新留痕 version = 截断点 version + 1 | ⛔ 合入前 | 失败 → fork 档回退读 `previousSessionFile`（即审计方案 A 形态），D2 标注「探针证伪，回退 A」，其余档不受影响 |
| P3 | 直启 resume：`--resume/--session` 启动时 reason="startup"（无 previousSessionFile）且 `getSessionFile()` = 目标文件 → 直读命中 | `pi --resume`（选已有留痕的 session）→ 发一条消息 → JSONL 留痕条数不增；随后改 append 配置再发消息 → 新留痕 `reason:"resume"`、version+1、**parentVersionDiffSummary 有值**（F1 修复实证） | ⛔ 合入前 | 失败 → 按 P1 降级路径 ①处理；此场景是 persisted 的原主场景，探针失败即说明直读替代不成立，D1 整体重审（回滚到方案 C 需重新设计评审） |
| P4（辅助） | Like 归一编译等价性：handler 直接标注 SDK 类型后 `on()` 重载接受、无逆变报错 | 实施时 `pnpm extensions:typecheck`（真实编译器即探针；SDK 类型与 handler 签名兼容性由 tsc 验证） | ⛔ 同提交 | 失败 → 检查是否 SDK 版本漂移（npm ls 核对 0.84.4）；确认无漂移后保留单点 `import type` 过渡并在本节登记 |

> P1–P3 即审计指定的「一次本地 pi CLI 探针验证 reload 事件时序」，扩展为四 reason 矩阵一次跑清。三个探针共用一个临时 session-dir 与脚本化步骤，产物（JSONL 片段 + 日志摘录）贴入实施 PR 描述。

---

## 7. 实现机制（把终态落到代码层）

**本章结论：改动收敛在 5 个源文件 + 3 个测试文件 + 1 个登记文档，净删约 170 行（源码 680 行的 ~25%）。**

文件改动地图（实施清单，非代码）：

| 文件 | 动作 | 要点 |
|---|---|---|
| `src/baseline.ts` | 大删 | 删 BASELINE_FILENAME、MAX_BASELINE_SESSIONS、PersistedBaselineEntry/File、readPersistedBaseline、writePersistedBaseline、loadBaselineFileForWrite、emptyBaselineFile、uniqueTmpPath、pruneSessions 及 fs/path/logger 相应 import（约 -120 行）；保留 readLastPromptFromSessionFile（改内聚 source 参数口径，见下）与 parseTraceEntryData（去 export）。文件头注释的「四路径口径」改「两档」 |
| `src/trace.ts` | 改 | TraceEnv 删两方法（readPersistedBaseline/writePersistedBaseline），TraceContext 增 `getSessionFile(): string \| undefined`；onSessionStart 签名去 previousSessionFile 参数，解析逻辑改两档（stash 优先 → ctx.getSessionFile() 直读）；write() 删 env.writePersistedBaseline 双写；onTurnStart 基线命中分支删「续命刷新小文件」调用；mapReasonForFirstWrite 调用点类型随 D4 |
| `src/types.ts` | 删+改 | 删 SessionStartReason、SESSION_START_REASONS、normalizeSessionStartReason；PromptBaseline.source 收敛为 `"target-file" \| "previous-session-file"` 两值（`"persisted"` 随机制删除）；mapReasonForFirstWrite 入参改 `SessionStartEvent["reason"]`；mapReasonForFirstWrite 注释删「暂定待 P2」 |
| `src/index.ts` | 改 | 删三 Like 接口，`import type { SessionStartEvent, SessionBeforeSwitchEvent, TurnStartEvent, ExtensionAPI, ExtensionContext }`；删 baselineFilePath 与 persisted wiring；toTraceContext 增 getSessionFile 适配（`ctx.sessionManager.getSessionFile()`）；三 handler 直接标注 SDK 类型 |
| `src/__tests__/baseline.a12.test.ts` | 改写 | 「路径 3」两用例改写为档 2 直读场景（startup+目标文件直读；diff 摘要从 toBeUndefined 断言反转 toContain 断言）；「路径 4」兜底用例保留（构造 getSessionFile 返回 undefined）；删 persisted 文件读写断言 |
| `src/__tests__/index-wiring.test.ts` | 改 | fork 用例（:187-213）的「直读 previousSessionFile」改为「ctx.sessionManager.getSessionFile() 指向 fork 文件」；「仅刷新自持久化基线版本」断言删除；事件 payload 类型断言随 SDK |
| `src/__tests__/trace.a11.test.ts` | 改 | 删「未知 reason 按 startup」用例（类型收窄后不可达）；computePromptHash 的 import 改本地 sha256 期望值 |
| `docs/architecture/data-source-registry.md` | 回写 | §6:114 条目标废弃 + :120 参照锚点修正（D3；同 commit，C-proc-10） |

错误规格不变量：所有基线读取函数继续不抛错（读失败返回 null）；handler 内 try/catch 顶层兜底保留（留痕是诊断性旁路，失败不得影响 agent 主流程）。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「中-大」（删持久化子系统 + 行为矩阵变化），用 5 个真实场景验收，每个回溯 §2 目标。**

### 8.1 改动规模

机制删除 + 基线解析矩阵重排 + 类型层归一——属「行为变更/接口调整」级，多场景验收；单测（a11/a12/wiring/diff 四套）仅作回归辅助，不计入验收。

### 8.2 验收场景

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | TUI 直用 pi：reload 去重 | 目标 1（reload 链路） | 本地 `pi --session-dir <tmp> --extension <本包 dist>`：发消息（产生 initial v1 + assistant）→ `/reload` → 再发消息 → 读 session JSONL | 留痕仍 1 条（reason/version/hash 不变）；`~/.pi/agent/logs/` 无基线读取报错；tmp agentDir 无 baseline 新写动作 |
| V2 | GUI switch 主链路 | 目标 1（主链路零回归） | `pnpm dev` 起应用：session A 产生留痕 → 切到 B（new，写 initial）→ 切回 A → A 的 Trace 视图与切走前一致 | A 的留痕条数/version 不因往返切换增加；B 为独立 v1（无串基线）；全程无 stash 相关回归 |
| V3 | GUI skill 变更 reload | 目标 1 + 目标 2 | dev 运行中修改 `.agents/skills/` 下某 skill 文件 → 等 ReloadOrchestrator 触发 `/__xyz_reload__` → 继续对话 | reload 后留痕不新增（hash 命中）；改 skill 导致 prompt 实际变化时写 change v+1 且 parentVersionDiffSummary 有值；agents 数据目录无 baseline 小文件写动作 |
| V4 | 重启直启 resume + F1 修复 | 目标 3（diff 缺口） | 有留痕的 session → 完全退出 pi/应用 → `pi --resume` 直启 → 发消息（hash 命中）→ 修改 append 配置再发消息 | 命中轮零新增；变化轮新留痕 reason="resume"、version 续接、parentVersionDiffSummary 含 "+N -M lines" 形态内容（不再 undefined） |
| V5 | 负面行为：孤儿文件无影响 + 新 session 不误写 resume | 目标 1（不该发生的不发生） | 在 agentDir 预置一个旧 baseline 文件（模拟存量用户）→ 跑 V1–V4 全流程；另开全新 session 发首条消息 | 预置文件全程不被读写（mtime 不变）；全新 session 首留痕 reason="initial" v1（不因孤儿文件写成 resume） |

补充约束：V1/V4 与探针 P1/P3 共享执行产物（同一临时 session 可复用）；验收记录（JSONL 行摘录）贴 PR。

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 探针门 | 跑 §6.5 P1–P3（可加 P4 预编译验证），产物留档 | ⛔ 门槛：D1/D2 的运行时断言实证，不通过不开工 |
| M1 类型归一（D4） | Like 簇删除 + SDK import + normalize 链删除 + 两 export 收敛 + 对应测试改写；`pnpm extensions:typecheck \|\| extensions:lint \|\| extensions:test` 三连绿 | 纯类型层先行，行为零变更，独立可验收（编译即证） |
| M2 机制删除（D1/D2） | baseline.ts 删 persisted 子系统 + trace.ts 两档解析 + types/index wiring + 测试改写 | §5 终态行为；V1–V5 验收 |
| M3 登记回写（D3） | data-source-registry.md 条目 + 参照锚点，同 commit 随 M2 | C-proc-10 同步纪律闭环 |

M1/M2 分两个 commit（类型层与机制层行为影响分离，review 面清晰）；M3 与 M2 同 commit。包版本 patch bump（taiji 组无独立外部消费者，内部简化无对外行为变化）。

### 9.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| u1 类型归一 | M1 全部 | 独立可验收（typecheck 绿 + 行为零变更），先行避免 M2 机制改动与类型改动交叉 |
| u2 persisted 删除 + 两档解析 | M2 的 src 四文件 | D1/D2 的最小落地面；依赖 u1（onSessionStart 签名已定型） |
| u3 测试改写 | 三个测试文件 | 与 u2 同 commit 才能保持绿；单独拆会留红窗口 |
| u4 登记回写 | registry 文档 | C-proc-10 纪律要求同 commit；独立单元便于 review 核对锚点 |

### 9.3 待验证检查点

- §6.5 探针 P1–P3 结果（设计阶段断言全部有 dist 源码依据，但纪律上仍以实跑为准）。
- xyz-agent runtime spawn 直启链路（V4 的 GUI 侧变体）在 dev 数据目录隔离（`~/.xyz-agent-dev`）下复跑一次——排除打包 staging 层与直连差异（AGENTS.md「extension 改动优先在本地 pi CLI 实测」的交叉验证）。
- 已接受代价 1 的观察口径（见下）：合入后若 Trace 视图观察到 reload/重开场景留痕**成对重复**（同 hash 两条相邻留痕），说明「首 assistant 前中断 + 重开」窗口比预估频繁，回本设计重审档 2 的 flush 语义假设。

**已接受代价汇总**（四要素，承接现状设计 D2 的既有接受面）：
1. **首 assistant 前中断窗口**：留痕写入但 `_persist` 尚未 flush（session-manager.js:726-754 首条 assistant 前不落盘）+ 生成中断 + 之后 reload/重开 → 档 2 读 miss → 多写一条兜底留痕。量级：三重条件叠加，预估 <0.1% session；恢复：无功能损失（version 序列重开仍单调）；重审：见 §9.3 第三条；判定：可接受（与现状 persisted 丢失后果同级——现状 writePersistedBaseline 失败同样走此兜底，trace.ts 现注释自证「设计 D2 已接受」）。
2. **孤儿 baseline 文件**：见 D3（≤10KB/agentDir 一次性，可接受）。
3. **session_start 读大文件**：档 2 从读小文件（persisted）变读 session JSONL 全文（长 session 可达 MB 级）。量级：每 session_start 一次 readFileSync+倒序扫行，MB 级文件毫秒级，非热路径（现状 stash/fork 档本就如此读，仅 reload/直启档从读小文件变读大文件）；恢复：无需（无正确性影响）；重审：若未来观察到 session 启动延迟可加「只读尾部 N KB」优化（记入 backlog，本次不做）；判定：可接受。

---

## 附录：变更历史

- v1（2026-09-12）：初稿。覆盖审计候选 2（C2 high）、候选 11（C11）与两项 low 级 export 收敛；探针 P1–P3 定为实施期门。
