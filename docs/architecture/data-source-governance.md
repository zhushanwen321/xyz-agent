# GUI 数据多源治理：全量修复与预防机制设计

> **一句话结论**：12 类 GUI 数据多源的病根不是缓存本身，而是「权威源之外的第二个写入者」；修复方案是建立「单一 owner + 快照拉取 + 事件失效」结构（缓存按判据分类处置，不整体删除），并同步上线四层预防机制（数据登记表 + lint + pre-commit + 等价性测试），使未来新增第二写入路径在提交前被机器拦截而非靠 review 人眼。

> 层声明：本文档是**技术方案设计**（当前层 = 问题诊断 + 目标架构，下一层 = 可实施的接口/数据模型/迁移计划，P0 阶段可直接开工）。层敏感准则 5/6/7（物理数据流 / 错误恢复 / 运行时断言探针）全适用。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent（Electron + Vue 桌面 AI Agent 工作台）的 GUI 显示 session 列表/标签/模型/思考档位/上下文用量/消息流/队列/subagent/workflow 等 12 类数据，底层权威源只有一个——pi 子进程（持有 session JSONL 文件与 agent 内存态，提供 `get_state` / `get_session_stats` / `get_messages` 等 RPC 快照接口）。
- **C（冲突）**：同一份数据在 runtime 进程与 renderer 进程各建了独立缓存与推导管线，实测 12 类数据平均 3-6 个触点（写入点/缓存/解析管线）；最危险的 session 标签存在**两个互不知情的写方直接写 pi 的 session 文件**，已证实「用户手动命名的 session 会被 auto-rename 静默覆盖」；runtime/renderer 代码注释中记录了至少 4 次同源历史踩坑（inputTokens 竞态、thinkingLevel 恒 undefined、磁盘 modelId 空串覆盖真值、label 旧值覆盖）。
- **Q（问题）**：如何全量修复这 12 类多源问题，并建立机制使未来不会再出现新的多源数据？
- **A（答案）**：不删除缓存层——缓存不是病根，「独立写路径」才是。按「是否存在权威源之外的第二个写入者」判据把现有缓存分成纯派生缓存（保留）与影子状态库（收编）；建立「单一 owner + 快照拉取 + 事件失效」目标结构；预防机制与第一批止血修复同期上线（P0），之后每阶段重构都在守护之下进行。

### 系统是什么

xyz-agent 三进程架构：**renderer**（Vue 前端，Pinia store 持 GUI 状态）↔ WebSocket ↔ **runtime**（Node.js 服务，管理 pi 子进程生命周期、翻译 pi 事件为 WS 广播）↔ stdio RPC ↔ **pi 子进程**（每 session 一个进程，唯一持有 session 文件 `<getDataDir>/sessions/**/*.jsonl` 与 agent 内存态）。

pi 的 RPC 面提供**一站式快照**（本设计调研期已逐一 read 源码核实，见 §3.3 探针）：

- `get_state`（rpc-mode.ts:442）：一次返回 model / thinkingLevel / isStreaming / isCompacting / sessionName / pendingMessageCount / messageCount / sessionFile——session 级状态类数据的真值全在此；
- `get_session_stats`（rpc-mode.ts:566）：contextUsage（上下文用量真值）；
- `get_messages`（rpc-mode.ts:645）：消息列表真值；
- `set_session_name`（rpc-mode.ts:632）：pi 侧正确落盘（sessionManager.appendSessionInfo，agent-session.ts:2718）并广播 `session_info_changed`。

（本文引用的 pi 行号对齐 pi-mono main 0.80.3 源码树；项目实装 `@earendil-works/pi-coding-agent@0.84.1`，上述 API 的存在性与行为已在两版源码核实一致。）

**问题在于 xyz 没有以这些快照为中心组织数据流**，而是把快照拆成事件流、再在 runtime/renderer 各自拼回状态，每类数据自建「事件驱动缓存 + 专属回写路径 + 专属兜底拉取」。

### 关键术语（首次定义，全文通用）

- **权威源（source of truth）**：某数据唯一正确的最终存储。本文中 = pi 进程（session 文件 + agent 内存态）。subagent/workflow 是例外——pi 没有此概念，权威源是 xyz 自带的 pi 扩展内的记录仓库（record-store / RunStore）。
- **owner（数据所有者）**：xyz 侧某类数据唯一的写入者——一个模块、一个状态容器、一个写入口。所有来源（事件/RPC/文件）都汇入 owner 的单一入口，读方只读 owner。
- **纯派生缓存**：只有一个写方（扫描/转换/计算本身）、可随时丢弃并从权威源完整重建的缓存。例：session 目录扫描缓存。
- **影子状态库**：有独立写路径（被多条事件/RPC 回写直写）、承载真值的缓存。它是 12 类问题的载体。例：runtime `sessionMetaCache`（4 个写方）。
- **快照拉取 + 事件失效**（本文推荐的目标模式）：数据只由 owner 从权威源**拉取快照**填充；事件到达只做一件事——标记 dirty 并触发（防抖后的）重拉。事件永远不直接写数据。

### 设计目标（从使用者体验倒推）

- **G1**（用户）：手动命名的 session 永不被 auto-rename 覆盖；断网重连后模型/用量/队列显示与断连前一致（队列**内容**依赖 renderer 本地副本存活 + 深度与 `get_state.pendingMessageCount` 对账——pi 无队列内容快照接口，RPC 命令全集已核实，owner 分工见 §3.3 D1）；重开 session 后对话分组、subagent 状态与重开前一致。
- **G2**（开发者）：动手改任何 GUI 数据前，能在一张登记表里查到该数据的 owner、权威源、唯一写入口与已知例外。
- **G3**（质量）：「实时视图 ≡ 重开视图」「广播状态 ≡ pi 快照」成为 CI 可执行的等价性测试，任何回归（代码偷偷直写状态）会让等价性破功并报警。
- **G4**（预防）：开发者新增数据项/新事件 handler/新缓存时，若违反单一 owner 原则（如给 store 加第二个写方法调用点、直写 session 文件、新建无注解缓存），pre-commit / lint 直接报错并指向登记表条目。

### Scope

- **In-scope**：§2 清单中 12 类数据的修复路径；runtime/renderer 的 owner 结构重组；四层预防机制；分五阶段（P0-P4）的迁移计划。
- **Out-of-scope**：修改 pi 源码（项目铁律 [MANDATORY]，pi 没有的能力由 xyz 自实现）；消息分组的渲染语义重构（turnId 分组归 `fix-chat-flow-order` 分支的设计，本文只覆盖其数据层前提——entry 序号与单一来源）。

---

## §2 现状与问题分析

**结论：12 类数据的病根是同一件事——没有 owner 结构。每类数据有多条写路径（事件直写、RPC 回写、绕过 pi 直写文件、双管线重建），没有「谁是对的」的仲裁；缓存只是这些写路径的载体。**

### 2.1 使用者视角的真实失败模式

**失败模式 A（已证实，label 覆盖）**：用户新建 session 发第一条消息。首个成功 turn 结束后，`rename-session` 扩展（运行在 pi 进程内）用 LLM 生成标题（耗时 2-30s），生成后执行防覆盖守卫：

```ts
// extensions/rename-session/src/index.ts（callRenameLLM .then 分支）
if (pi.getSessionName()) { debugLog("skip: name exists"); return }  // 检查的是 pi 内存态
pi.setSessionName(title)
```

用户在这 2-30s 窗口内手动改名。xyz 的手动 rename 路径（`session-lifecycle.ts renameSession` → `persistSessionName`）**直接 append `session_info` entry 到 session JSONL + 改 runtime 内存，全程不通知 pi 进程**（runtime 的 rpc-client 从未接线 `set_session_name`）。于是 pi 内存里 sessionName 仍为空 → 守卫必过 → `setSessionName(title)` 在文件尾部追加新 entry → last-write-wins **覆盖用户手动名**，且经 `session.renamed` 广播把 UI 也翻回 LLM 标题。

**失败模式 B（已证实，断连/重开后状态漂移）**：对话中断 WS 重连后，用量/模型/队列等显示依赖「断连期间丢失的事件是否被 ring 快照回放覆盖」——ring 溢出即永久丢失（renderer `subscription-state.ts` 注释自认该风险）。重开 app 后 session 列表来自磁盘扫描，`scannedToSummary` 硬编码 `modelId: ''`、`tokenCount: 0`（`session-scanner.ts`），renderer `setGroups` 全量覆盖曾把真值抹成空串（`session/store.ts:70` 注释记录的踩坑史）。

**失败模式 C（已证实，双管线解析漂移）**：subagent 后台任务完成后，侧栏状态、主对话注入 turn、重开后的 extractor 解析可能不一致——实时路径（event-interpreter 内存 Map）与磁盘路径（subagent-extractor 重新解析 JSONL）是两条独立管线，各自演进；文件改动展示同样双管线（实时 git baseline diff vs 历史从 toolCall 参数静态解析，`message-converter.ts` 注释自认「两条路径实现不同、bash 无法覆盖」）。

### 2.2 12 类多源数据清单

| # | GUI 数据 | 权威源 | xyz 侧触点 | 已踩坑记录 |
|---|---------|--------|-----------|-----------|
| 1 | session 标签 | pi（session_info entry + 内存） | 6：xyz 直写文件 / pi 扩展 setSessionName / metaCache / 磁盘扫描 / renderer 局部更新 / 全量覆盖 | label 旧值覆盖（meta-cache 文件头注释） |
| 2 | session 列表（status/modelId/tokenCount） | pi session 文件 + agent 态 | 内存 Map + 磁盘扫描合并，磁盘侧空值 | modelId '' 覆盖真值（core/src/domain/session/store.ts:70） |
| 3 | 上下文用量 | `get_session_stats` | 5 写点：turn_end / agent_end / compaction 估算 / switchModel 重算 / restore 拉取 | inputTokens 竞态（session-service.ts:461、:837） |
| 4 | thinkingLevel | `get_state` | 事件 + 主动查询 + 双层缓存 + renderer 字段 | 恒 undefined（session-service.ts:450：pi 同档位切换不 emit 事件） |
| 5 | modelId | pi agent 态 | 缓存 + 广播 + 全局默认 + 磁盘空串 | 同 #2 |
| 6 | 消息队列（steer/followUp） | pi `_steering/_followUp` 队列 | pi 快照 + renderer pendingBuffer，文本匹配对接 | 展开失配丢消息（decoupling 文档 P-fifo 风险项） |
| 7 | 消息列表/内容 | session 文件 entries | 事件流累积 + agent_end 权威覆盖 + 文件重放 | 分组错乱（fix-chat-flow-order 分支主题） |
| 8 | subagent 列表/状态 | xyz 扩展 record-store（pi 无概念） | 实时事件 Map + JSONL extractor 双管线；状态 6+ 命名出口 | normalizeSubagentStatus 注释（历史 bug） |
| 9 | workflow 记录 | xyz 扩展 RunStore | 5 环节：内存 → state 文件 → link entry → 信号广播 → extractor | 文件 lag 重试（workflow.ts:171） |
| 10 | 文件改动（FileChanges） | git 工作区 | 实时 baseline diff + 历史静态解析 | 两管线语义不同（message-converter.ts:44） |
| 11 | session 活跃态 | `get_state.isStreaming` | 5 状态源派生（chat 消息态/pendingSend/queue/retry/forceWorking） | — |
| 12 | slash 命令列表 | `get_commands` | 广播 + RPC 拉取 + stateSnapshot | broadcast/订阅时序（AGENTS.md 已修） |

### 2.3 四种多源模式（根因的四种表现）

1. **双写方直写 pi JSONL**（现存实例只有 #1 label）：xyz runtime 与 pi 进程互不知情地写同一文件，靠 last-write-wins。最危险——**现行有一个已证实的覆盖 bug**。（session 终态 session_end 曾属此类：ADR-0042 原版 append JSONL，后经 W1 修订改为 runtime 单写 sidecar `.meta.json`，已非双写方——见 §3.3 D3 的重新评估。）
2. **内存态 vs 磁盘扫描双管线**（#2/#7/#8/#10）：live 一套解析、reload 一套解析，语义漂移是常态。
3. **多事件 + 多缓存重组**（#3/#4/#5/#11）：把 pi 单一快照拆成事件流再拼回去，每条事件的丢失/乱序/不发射特例各需一个兜底，兜底之间再竞态。
4. **扩展借 pi 文件当数据库**（#8/#9 + label 的 session_info 直写）：pi 无概念的数据被编码成 pi entry 类型持久化，读取方要逆向理解扩展的编码约定。

### 2.4 根因分析

四种模式指向同一个根因：**xyz 缺少数据治理结构——没有「每类数据必须声明唯一 owner、权威源、唯一写入口」的约束，也没有任何自动化手段检测「第二写入路径」的出现**。于是每类新数据进来都自然长成多源（事件直写最顺手），每类把同样的时序坑各自踩一遍。这解释了为什么 #12（commands）修过一次时序坑后，同样的坑在 #1-#11 上重复出现——修复是逐点的，结构没有变。

### 2.5 现状物理数据流（以 label 为例，物理位置标注）

```
[renderer 进程]                         [runtime 进程]                      [pi 子进程]              [磁盘]
session store.updateLabel  ◄── session.renamed 广播 ◄── event-interpreter ◄── session_info_changed ◀──┤
        ▲                                                              ▲                              │ session.jsonl
        └── setGroups 全量覆盖（来自 RPC list） ◄── SessionScanner ◄── 内存 Map + scanSessions ◀────────┤
                                                （内存 Map label ◄── metaCache.setLabel ◄─ 3 个写方）    │
                                                                                                      │
手动 rename: session-lifecycle.renameSession ──persistSessionName 直写───────────────────────────────►│ ⚠ 写方 1
auto-rename: rename-session 扩展 ──pi.setSessionName──► sessionManager.appendSessionInfo ────────────►│ ⚠ 写方 2
```

两个写方物理上互不知道对方存在；读取方（pi sessionManager / xyz extractSessionName / renderer store）各自取「最后一条 session_info」，谁后写谁赢。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**终态样例 1（用户改名，成功路径）**：用户右键 session 改名"重构计划"→ renderer 乐观显示新名 → runtime 调 pi RPC `set_session_name` → pi 落盘并广播 `session_info_changed` → renderer 确认显示。此后 auto-rename 的守卫 `pi.getSessionName()` 读到非空 → skip（守卫日志 "skip: name exists"）。用户再发 10 条消息，名字保持"重构计划"。

**终态样例 2（断连自愈）**：对话中 WiFi 断开 30s 重连。renderer 收到重连信号 → 对活跃 session 重拉快照（`get_state` + `get_session_stats`）→ 模型/思考档位/用量/队列深度与断连前一致——不依赖任何「断连期间事件是否补发成功」。（队列项文本显示来自 renderer 本地副本——断连 ≠ renderer 重启，副本存活；副本与 pi 队列的偏差由 queue_update 对账清空，深度由 `pendingMessageCount` 对账。）

**终态样例 3（开发者新增数据被拦）**：开发者在 feature 分支给 session store 加了第二个写方法调用点（绕过 owner）。`git commit` 时 pre-commit 检查报错：`store mutation "updateModelId" 只允许在 <owner 文件> 调用（登记表条目 #5）`。开发者查登记表，改为经 owner 写入。

**失败路径与恢复指引**：

- **快照拉取失败**（pi 忙 / RPC 超时）：owner 保留 dirty 标记不清除，按 1s/5s/15s 退避重试；WS 重连时 `resubscribeAll` 附带全量重拉。UI 显示上一次快照值（可能短暂陈旧但不会错乱）。恢复动作：无需人工干预；若 pi 进程死亡，session 标 dead 态走既有 revive 流程。
- **扩展上报通道失败**（subagent/workflow 自描述 entry 未到达）：owner 回退读磁盘 entry（既有 extractor 路径降级为兜底），UI 正常但标注数据可能滞后。恢复动作：`session.getSubagents` RPC 手动刷新即自愈。
- **rename RPC 失败**（pi 进程死）：非活跃 session（无 pi 进程）本就无并发写方，允许文件直写白名单路径；活跃 session rename 失败则 toast 报错保留旧名，用户重试。恢复动作：session revive 后重试 rename。

### 3.2 方案对比

| | 方案 A：全删缓存，全量直读 | 方案 B：单一 owner + 快照拉取 + 事件失效（**推荐 ✅**） | 方案 C：保留多写路径 + 版本号同步协议 |
|---|---|---|---|
| 长期架构 | 差：无本地状态层，事件增量推送失去意义；每次 UI 刷新全量拉取/全量扫描磁盘 | 好：owner 唯一；事件丢失免疫（重拉自愈）；断连/重连/重开三场景天然一致；「事件只做失效」可被等价性测试证伪 | 差：多写方依旧存在，只是加了仲裁；版本协议本身成为新 bug 源（分布式里都没便宜解，单体内更不值） |
| 短期成本 | 高：全链路重写 + 性能回退（session 列表每次全量读 JSONL、用量每次 RPC） | 中高：runtime 重组（SessionStateService）+ renderer 写入口收敛；分五阶段可控，P0 一天可交付止血 | 中：每条写路径加版本逻辑 |
| 风险 | UI 闪烁、IO 放大 | 拉取防抖窗口内 UI 滞后百毫秒级；pi RPC 频率上升（快照很小，预期影响可忽略，实施期 P0 量化证实） | 时序/时钟问题解决成本高于收益 |

**被否方案的反例推演**：若选 A，§3.1 样例 1 的 rename 在 pi 进程死后无法落盘（无本地状态可写），样例 2 的断连自愈变成「断连期间所有显示冻结」；若选 C，失败模式 A 的两个写方各带版本号，但版本只在「双方都读到对方版本」时有效——rename-session 扩展读不到 xyz 的写（这正是现状 bug 的本质），版本协议无法修复它，等于没修。

**推荐 B 的核心理由**：它把「一致性」从运行时时序约定（注释里的「缓存写入先于读取」）变成结构性质（只有一条写路径，且以权威源为终点收敛），而结构性质可以用等价性测试持续断言——这是 G3/G4 的前提。

### 3.3 关键决策与权衡

**D1 缓存处置判据（回应「缓存是否先全删」）**：判据一句话——**缓存里是否存在权威源之外的第二个写入者？有 → 收编或删除（影子状态库）；没有 → 保留（纯派生缓存）**。

| 缓存 | 判定 | 处置 |
|---|---|---|
| session 目录扫描缓存 / git-info 缓存 / quota 缓存 / history-rebuild-cache / turn-render-cache | 纯派生（写方=扫描/转换本身） | 保留不动 |
| runtime `sessionMetaCache` | 影子状态（label/thinkingLevel 各 3-4 写方） | 收编进 SessionStateService，删除 |
| runtime `session.inputTokens/tokenCount` | 影子状态（5 写点） | 收编；switchModel 重算改在 owner 内部读自己的缓存，竞态从「注释约定」变「结构不可能」 |
| event-interpreter `subagentRecords` Map | 影子状态（双管线之一） | 收编：扩展自描述上报为唯一源，Map 变纯缓存 |
| renderer summary 字段（updateLabel/updateSessionState/setGroups 三路写） | 影子状态 | 收编为单一 `applySnapshot` 入口（合并规则见 D1b） |
| renderer `pendingBuffer` | 职责错位（承担投递定位） | 保留但改**计数 FIFO**：queue_update 差集已算出被投递条数，按条数顺序取 segments，删除文本相等匹配。queue 的 owner 分工：**深度走 `get_state.pendingMessageCount` 快照对账，内容走 renderer 本地副本 + queue_update 对账清空**（pi RPC 无队列内容快照接口，已核实 rpc-mode.ts 命令全集） |

被否：全删（同方案 A）。「先干掉再重建」的过渡态成本极高且不解决独立写路径问题。

**D1b 快照合并规则（两条，不可混用）**：

- **owner 快照合并 = 权威源整字段覆盖，含显式空值**。反例（对抗审查逼出）：pi `get_state.thinkingLevel` 的合法值含 undefined（切到不支持思考档位的模型时，权威真值就是空）——若一刀切「空值不覆盖非空值」，owner 将永远保留旧档位，影子状态复活，恰是本方案要消灭的东西。
- **空值守卫仅用于磁盘扫描占位值路径**：`scannedToSummary` 硬编码的 `modelId:''`/`tokenCount:0` 是「无数据」占位符而非权威空值，P2.3 守卫语义是「占位符不覆盖已知真值」。
- 落实到登记表：按字段登记空值语义——label 空 = 未设置（可守卫）；thinkingLevel 空 = 合法态（必须整字段覆盖）。

**D2 label 写路径**：手动 rename → runtime rpc-client 接线 pi `set_session_name` RPC（✅ 已验证存在于 pi rpc-mode.ts:632，内部 `sessionManager.appendSessionInfo` 落盘 + emit `session_info_changed`，agent-session.ts:2718）→ pi 成为该文件唯一活跃写方。删除 `persistSessionName` 对**活跃 session** 的直写。**唯一白名单例外**：非活跃 session（无 pi 进程 = 无并发写方）的 rename 保留文件直写，收口到单一 util 并在登记表登记。探针：✅ pi RPC 命令存在性与行为（本设计调研期 read 源码核实）；⛔ rename-session 守卫日志 "skip: name exists" 在真实链路出现（实施期 P0 用 `pi --mode rpc` 实测，复用 AGENTS.md 的扩展实测流程）。

**D3 session 终态（session_end）存储——现状修正与重新评估**：现状核实（对抗审查纠错）：ADR-0042 原版决策是 append JSONL，但其后 **W1 修订已改为 runtime 单写 sidecar `.meta.json`**（`persistSessionEnd`，session-file-utils.ts:111-157，注释明言「不污染 JSONL——pi 的 _persist 永远只写 message/session_info」+ 规则 #6 规避 pi `openSync("wx")` 竞态）。因此 session_end **现状不是双写方**，本方案最初「D3 = pi 文件唯一活跃写方的最后一块」的论证基础不成立，重新评估如下：

- **选项 a（维持 sidecar，默认推荐 ✅）**：sidecar 已是单写方、无并发冲突、无 pi 兼容性风险；W1 的两个原始动机（不污染 JSONL、规避创建竞态）依然成立。且扩展 `appendEntry`（pi core/extensions/types.ts:1261）写的是 custom entry，形态与 `{"type":"session_end"}` 不同，改造反而引入新 entry 形态的读取约定。选 a 时 D3 的工作收窄为：sidecar 读写收口到登记表声明的单一 util（现状已是），并在登记表登记「sidecar 是 pi 体系外数据的合法形态」。
- **选项 b（改扩展 appendEntry 统一进 pi 文件）**：动机只剩「所有持久化集中在 pi 文件」的整齐性。若未来因真实需求（如终态必须在 pi export/restore 中可见）选 b，必须先补三件迁移设计：① 存量 sidecar `.meta.json` 兼容读取（历史 session 终态优先级 custom entry > sidecar > 旧直填）；② sidecar 退役时间表；③ 显式修订 ADR-0042 + W1 决策并落档（项目惯例：推翻 ADR 需显式登记）。
- 探针：✅ sidecar 实现已 read 核实（原子写 tmpfile+rename + 写后失效 meta 缓存）；⛔ 选项 b 的实际收益场景当前不存在，不做投机改造。

**D4 subagent/workflow 单一来源**：扩展侧 record-store/RunStore 本就是权威。终态：状态变更时扩展 append 一条**自描述完整记录**的 custom entry（字段即 SubagentRecord/WorkflowRunRecord，不依赖读取方逆向解析 toolCall/toolResult 编码）；runtime 内存 Map 变纯缓存转发；`subagent-extractor`/`workflow-extractor` 降级为「冷启动旧 session（无自描述 entry）兜底」并标注 legacy。探针：⛔ 自描述 entry 的大小与 append 频率（长 workflow 的 trace 全量快照可能膨胀——实施期 P3 量化，必要时 trace 增量 + 状态全量）。

**D5 消息流 entry 序号**：实时广播携带 pi entry 序号，renderer 按序插入而非盲尾插；「实时分组 ≡ 文件重放分组」成为等价性测试断言。详细设计归 `fix-chat-flow-order` 分支（本方案 P3 衔接）。

**D6 预防四层（详见 §3.6）**：登记表（治理 SSOT）+ taste-lint 写入点检查 + pre-commit pi 文件直写检查 + 等价性测试族。被否：仅靠 ADR 文字约束与 review 人眼——#12 修复后同类坑在别处复发已证明人眼不可靠。

### 3.4 目标物理数据流（以 label 为例）

```
[renderer 进程]                    [runtime 进程]                       [pi 子进程]              [磁盘]
session store.applySnapshot  ◄── 快照 diff 广播  ◄── SessionStateService ◄── RPC get_state / set_session_name
（唯一写入口）                          ▲  │（唯一 owner：一个 Map + 一个写入口）        │                    │
                                       │  └── session_info_changed 事件 = 仅标 dirty 触发防抖重拉            │
                                       └── 断连重连 / 定时兜底 → 全量快照重拉                             ▼
                                                                                  sessionManager.appendSessionInfo（唯一写方）
                                                                                                    [session.jsonl]
非活跃 session rename（白名单例外）：runtime 单一 util 直写文件（无 pi 进程，无并发写方，登记表登记）
```

与 §2.5 对比：写方从 2 个（互不知情）变为 1 个（pi）+ 1 个显式白名单例外（物理上不可能并发）；renderer 从 3 路写变为 1 个写入口。

### 3.5 分阶段迁移（概览，详见 §5）

P0 止血 + 守护先行（rename 接 RPC 修覆盖 bug + 预防三件套上线）→ P1 runtime owner 收敛（六类 session 级状态）→ P2 renderer 写入口收敛 → P3 扩展数据单源 + 消息流 entry 序号 → P4 等价性测试全量化 + ADR 落档。**预防机制在 P0 与止血同期上线**——先立守护再动大刀，重构过程本身被守护。

### 3.6 预防机制四层（对应 G4，本方案的核心增量）

**第 1 层 静态拦截（提交前，零成本拦住大部分）**

- **R1 pi 文件直写检查**（pre-commit 脚本，复用现有 `check-domain-boundaries` 同体系）：runtime 代码对 session JSONL 的写操作（`openSync('a')` / `appendFile` 指向 sessions 目录）只允许出现在唯一白名单 util；例外（非活跃 rename）显式登记。直接预防最危险的模式 1 复发。**检出边界**：拦字面量/已知 util 形态的直写模式；变量拼接路径静态不可判定——拦模式，不承诺拦刻意绕过的语义。
- **R2 store 写入口检查**（taste-lint 自定义规则，项目已有 no-native-html 等先例）：每个 store 的 mutation 方法只能被其 owner 文件调用，许可表来自登记表。**实现路线**：跨文件调用图分析（复用 check-domain-boundaries 的 import 边分析思路）；首版可降级为「拦直呼形态」（import 目标 store 后直调 mutation），登记表条目驱动逐步收紧。
- **R3 新缓存强制注解**：新增模块级 Map/ref 缓存必须带 `@data-owner <登记表条目>` 注解，lint 校验注解存在且条目真实。没有「顺手加个缓存」这回事。
- **误报豁免闭环**：R1/R2/R3 拦到合法写入时，豁免路径 = 先在登记表补条目/例外 + 豁免 allowlist 登记（对齐 check-domain-boundaries 既有 allowlist + 注释先例），禁止在代码里静默绕过——预防机制自身不能成为无出口的阻塞源。

**第 2 层 动态断言（CI 等价性测试族）**——对「事件只做失效」的可证伪断言，任何回归会让等价性破功：

- `live ≡ reload`：真实 pi 子进程跑操作序列（steer/followup/bash/后台 subagent 完成），断言实时 store 快照 == 文件重放快照；
- `broadcast ≡ get_state`：事件风暴后断言 renderer 状态 == pi 快照；
- 混沌注入：事件乱序/丢失/重放 → owner 状态必须收敛到权威快照（拉取自愈的结构性验证）。

**第 3 层 数据登记表**：`docs/architecture/data-source-registry.md`，12 类数据的 owner / 权威源 / 唯一写入口 / 已知例外，是 R2/R3 许可表的依据 + review 时的对照 SSOT（对齐 ADR-0049 checklist 先例）。

**第 4 层 ADR + review checklist**：新 ADR（编号顺延，当前最高 0061）「单一数据 owner 原则」：判据、事件只做失效、pi JSONL 唯一活跃写方 = pi 进程（现状唯一违例是 label 的 xyz 直写，P0.1 消除；session_end sidecar 是登记在案的 pi 体系外合法形态，见 D3）。pi 升级时跑 pi-protocol 契约测试（ADR-0037 联合类型 exhaustive 检查已有），防止上游事件语义漂移悄悄制造新分叉。

---

## §4 验收

**结论：五个真实场景验收（全部真实 pi 子进程 / 真实文件，无 mock），分别回溯 G1-G4；P0/P1/P2/P3 各阶段有对应可先行验收的场景。**

### 场景 1：手动命名不被覆盖（P0，回溯 G1）

- **步骤**：`pnpm dev` 起真实环境 → 新建 session 发首条消息 → 等自动命名出现（观察 rename-session 扩展日志 `renamed to`；日志查看方式：`XYZ_AGENT_DEBUG=1` 起环境后看 `~/.pi/agent/logs/`，AGENTS.md 扩展调试约定）→ 侧栏右键手动改名「重构计划」→ 继续对话 3 轮 → 检查侧栏名与 `get_state.sessionName`。
- **通过标准**：3 轮对话后侧栏名仍为「重构计划」；扩展日志出现 `skip: name exists`；session JSONL 尾部无新增 auto 标题的 session_info entry；`get_state` 返回「重构计划」。

### 场景 2：断连自愈（P1/P2，回溯 G1/G3）

- **步骤**：对话进行中（已切过模型、有用量、队列里压一条 followUp）→ 杀掉 WS 连接模拟断网 30s（期间 pi 完成一轮回复）→ 重连。
- **通过标准**：重连 5s 内模型/思考档位/用量百分比/队列深度与 pi `get_state` + `get_session_stats` 逐字段一致（人工对照 RPC 返回），全程无错误 toast；对话流不缺消息（live ≡ reload 断言脚本输出一致）。

### 场景 3：重开一致性（P3，回溯 G1/G3）

- **步骤**：一个 session 内依次执行：steer 一次、`!` bash 一次、启动一个后台 subagent 并等其完成注入 → 重启 app 重新打开该 session。
- **通过标准**：重开后消息分组、subagent 侧栏状态、用量显示与重开前一致（截图对照）；CI 等价性测试 `live ≡ reload` 对该 session 通过。

### 场景 4：预防拦截（P0，回溯 G4）

- **步骤**：在测试分支故意制造两个违规：① 在 owner 文件外调用某 store 的 mutation；② 在 runtime 新增一段直写 session JSONL 的 `appendFileSync`。分别 `git commit`。
- **通过标准**：两次提交都被 pre-commit/taste-lint 拦截，报错信息指向登记表条目；按报错指引修正后提交通过。

### 场景 5：subagent 单源一致（P3，回溯 G1/G3）

- **步骤**：后台 subagent 完成后，对照侧栏 SubagentList 状态、主对话注入的完成 turn、`session.getSubagents` RPC 返回三者；再重开 session 后对照第四次（extractor 兜底路径）。
- **通过标准**：四处状态一致（closed + 相同 result 摘要）；混沌测试（丢失 bg-notify 广播）后 RPC 刷新能收敛到正确状态。

---

## §5 下一层拆分

**结论：五阶段递进，每阶段独立可验收可回滚；P0 把唯一的已证实 bug 修掉并立起守护，P1-P3 在守护下逐域收敛，P4 固化为长期回归基线。**

### P0 止血 + 守护先行（1-2 天；验收：场景 1、4）

| 单元 | 内容 | justification |
|---|---|---|
| P0.1 | rpc-client 接线 `set_session_name`；`renameSession` 活跃分支改走 RPC；删除活跃 session 的 `persistSessionName` 直写；非活跃分支收口白名单 util | 唯一已证实 bug，pi API 现成（✅ 已核实），改动面最小 |
| P0.2 | 数据登记表初版（12 条 + 白名单例外） | 预防机制的 SSOT 依据，先于一切重构 |
| P0.3 | R1 pre-commit 直写检查 + R3 缓存注解规则 + R2 骨架（许可表联动登记表） | 先立守护再动大刀，P1-P3 的每步重构被检查覆盖 |
| P0.4 | 等价性测试骨架（真实 pi 子进程 fixture + `live ≡ reload` 断言脚本雏形） | 后续阶段的验收工具，P0 就绪 |

### P1 runtime owner 收敛（3-5 天；验收：场景 2 前半）

| 单元 | 内容 | justification |
|---|---|---|
| P1.1 | `SessionStateService`：label/thinkingLevel/modelId/usage/queue/commands 六类一个 Map + 一个写入口（快照合并函数：权威源整字段覆盖、含显式空值——规则见 D1b） | §2 模式 3 的收敛点，六类数据同构 |
| P1.2 | 事件改失效信号：session_info_changed/thinking_level_changed/queue_update/context 相关事件 → dirty + 防抖重拉 `get_state`/`get_session_stats`。modelId 无 pi 事件可依赖（已核实 pi 无 model_changed 事件），其失效源 = switchModel RPC 响应后主动拉快照 | 「事件只做失效」落地的第一步 |
| P1.3 | 删除 sessionMetaCache；applyContextUpdate 五写点收编为单入口；switchModel 重算移入 owner | 影子状态库退场 |

### P2 renderer 写入口收敛（3-4 天；验收：场景 2 后半）

| 单元 | 内容 | justification |
|---|---|---|
| P2.1 | 每个 store 单一 `applySnapshot` 入口，setGroups/updateLabel/updateSessionState 收敛 | 模式 3 的 renderer 侧对称收敛 |
| P2.2 | pendingBuffer 计数 FIFO（删除文本匹配） | #6 失联即丢消息的修复，改动小收益确定 |
| P2.3 | scannedToSummary 空值守卫全量路径核查 | #2 空串覆盖的最后防线 |

### P3 扩展数据单源 + 消息流（1-2 周；验收：场景 3、5）

| 单元 | 内容 | justification |
|---|---|---|
| P3.1 | subagent/workflow 自描述 entry 上报 + extractor 降级 legacy | 模式 2/4 的收敛，D4 |
| P3.2 | session_end 维持 sidecar 单写方（D3 裁决选项 a）：读写收口 + 登记表登记 sidecar 为 pi 体系外合法形态；appendEntry 改造（选项 b）仅在出现真实需求时启动，并按 D3 的迁移三件套（存量兼容读取/退役时间表/ADR-0042+W1 修订落档）执行 | W1 sidecar 已消除双写方，重造无净收益 |
| P3.3 | 消息流 entry 序号（衔接 fix-chat-flow-order 分支设计，D5） | #7 的根治，与分组修复协同 |

### P4 预防固化（2-3 天；验收：全部场景回归）

| 单元 | 内容 | justification |
|---|---|---|
| P4.1 | 等价性测试族全量化（broadcast ≡ get_state / 混沌注入）入 CI | G3 的长期回归基线 |
| P4.2 | ADR-0062 落档 + review checklist（对齐 ADR-0049 先例） | 流程层固化 |
| P4.3 | pi 升级契约测试接线（ADR-0037 exhaustive 检查复用） | 上游漂移防线 |

### 文件改动地图（核心，非穷举）

- **新增**：`docs/architecture/data-source-registry.md`；`packages/runtime/src/services/session/state-service.ts`（owner）；`scripts/check-pi-file-direct-write.mjs`（R1）；taste-lint 规则 2 条（R2/R3）；等价性测试 `packages/runtime/src/__tests__/equivalence/`。
- **收敛**：`rpc-client.ts`（+setSessionName）；`session-lifecycle.ts` / `session-file-utils.ts`（直写收口白名单）；`session-meta-cache.ts` 删除；`session-service.ts` applyContextUpdate 收编；`event-interpreter.ts` 事件改失效；renderer/core 两侧 store 写入口（含 `packages/core/src/domain/session/store.ts` 等 core 包真实位置——renderer `stores/session.ts` 是 ADR-0059 薄壳）；`effects/registry.ts` queue_update 计数 FIFO。
- **扩展**：`extensions/subagent-workflow`（自描述上报）。session_end 按 D3 裁决 a 维持 sidecar，不新增 appendEntry 扩展。

### 待验证检查点（设计阶段无法确定，诚实标注）

- ⛔ 快照拉取的 RPC 频率与延迟对 UI 的实际感知（P1 量化，必要时事件做乐观提示、快照为准）。
- ⛔ 自描述 entry 的体积/频率（D4 探针，P3 量化）。
- ⛔ 非 xyz 创建的历史 session（无 xyz 扩展 entry）在新代码下的降级表现（P3 回归）。
