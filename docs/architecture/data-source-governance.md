# GUI 数据多源治理：全量修复与预防机制设计

> **一句话结论**：12 类 GUI 数据多源的病根不是缓存，而是「权威源之外的第二个写入者」与「派生在多个进程独立发生」。终态架构由五条原则构成：① **绝对写规则**——xyz 任何代码永不写 pi 的文件，pi 持有状态的读写只发生在 pi 内部，能力缺口由 pi 扩展在 pi 内补齐（`appendEntry` 是官方通道），runtime 只经 RPC 存取；② **投影只发生一次**——runtime 是唯一投影宿主，renderer 零派生；③ 标量状态走**通用快照复制原语**（快照拉取 + 事件只做失效），日志数据走**单一 reducer 双路喂入**；④ 队列等无 pi 通道的数据**按字段分权威**并登记；⑤ **治理即代码**——登记表是可执行配置，护栏 = 机器检查（pre-commit/lint/等价性测试）+ pr-cr-fix 语义审查 agent 双层。缓存按「是否存在第二写入者」判据分类处置，不整体删除。

> 层声明：本文档是**技术方案设计**（当前层 = 问题诊断 + 目标架构，下一层 = 可实施的接口/数据模型/迁移计划，P0 阶段可直接开工）。层敏感准则 5/6/7（物理数据流 / 错误恢复 / 运行时断言探针）全适用。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent（Electron + Vue 桌面 AI Agent 工作台）的 GUI 显示 session 列表/标签/模型/思考档位/上下文用量/消息流/队列/subagent/workflow 等 12 类数据，底层权威源只有一个——pi 子进程（持有 session JSONL 文件与 agent 内存态，提供 `get_state` / `get_session_stats` / `get_messages` 等 RPC 快照接口）。
- **C（冲突）**：同一份数据在 runtime 进程与 renderer 进程各建了独立缓存与推导管线，实测 12 类数据平均 3-6 个触点（写入点/缓存/解析管线）；最危险的 session 标签存在**两个互不知情的写方直接写 pi 的 session 文件**，已证实「用户手动命名的 session 会被 auto-rename 静默覆盖」；runtime/renderer 代码注释中记录了至少 4 次同源历史踩坑（inputTokens 竞态、thinkingLevel 恒 undefined、磁盘 modelId 空串覆盖真值、label 旧值覆盖）。
- **Q（问题）**：如何全量修复这 12 类多源问题，并建立机制使未来不会再出现新的多源数据？
- **A（答案）**：不删除缓存层——缓存不是病根，「独立写路径 + 多处独立派生」才是。把系统按本质重新组织为一个**状态复制系统**：pi 是唯一权威源，runtime 是唯一投影宿主（一级副本），renderer 是零派生的视图终端（二级副本）；写路径收敛为「只有 pi 写 pi 的文件」，读模型收敛为「每类数据恰好一份派生代码」；再用机器检查 + skill 语义审查的双层护栏保证结构不回退。

### 系统是什么

xyz-agent 三进程架构：**renderer**（Vue 前端，Pinia store 持 GUI 状态）↔ WebSocket ↔ **runtime**（Node.js 服务，管理 pi 子进程生命周期、翻译 pi 事件为 WS 广播）↔ stdio RPC ↔ **pi 子进程**（每 session 一个进程，唯一持有 session 文件 `<getDataDir>/sessions/**/*.jsonl` 与 agent 内存态）。

这个问题的本质是**状态复制**：pi 是权威源，runtime 与 renderer 是两级副本。可靠副本同步只有两种成熟形态——快照 + 失效信号（权威事件流不可靠时），或带序号的日志复制（权威事件流可靠时）。xyz 当前的畸形在于走了第三条路：把**不可信的事件流当数据载体**，再在两个进程各自拼回状态。

pi 的能力面（本设计调研期已逐一 read 源码核实，见 §3.3 各决策的探针标注；行号对齐 pi-mono main 0.80.3，项目实装 `@earendil-works/pi-coding-agent@0.84.1`，两版行为一致）：

**快照 / 写接口（RPC，命令面是固定 switch，扩展不可注册新命令——rpc-mode.ts:385 起）**：

- `get_state`（rpc-mode.ts:442）：一次返回 model / thinkingLevel / isStreaming / isCompacting / sessionName / pendingMessageCount / messageCount / sessionFile——session 级状态类数据的真值全在此；
- `get_session_stats`（rpc-mode.ts:566）：contextUsage（上下文用量真值）；
- `get_messages`（rpc-mode.ts:645）：消息列表真值；
- `get_entries`（rpc-mode.ts:609）：entry 列表，支持 `since=<entryId>` 增量游标；游标失效（entry 不存在）返回错误，调用方退化为全量重拉——**扩展数据的官方增量拉取通道**；
- `set_session_name`（rpc-mode.ts:632）：pi 侧正确落盘（sessionManager.appendSessionInfo，agent-session.ts:2718）并广播 `session_info_changed`。

**扩展在 pi 内的持久化与上报通道（extension-in-pi 的官方机制）**：

- `pi.appendEntry(customType, data)`（core/extensions/types.ts:1261）→ `sessionManager.appendCustomEntry` 把 `type:"custom"` entry **由 pi 自己持久化**进 session JSONL（agent-session.ts:2264-2271）。session-manager.ts:92-95 的注释明言这就是扩展状态重建的官方通道（"scan entries for their customType and reconstruct internal state"）；custom entry 持久化但不进 LLM context（session-manager.ts:377-385）；
- `entry_appended` 事件经 `session.subscribe((event) => output(event))` **全量转发**到 RPC 客户端（rpc-mode.ts:354-356）——扩展数据的实时失效信号已经存在，xyz 当前只是在 event-adapter 的 NULL_EVENTS 里忽略了它（event-adapter.ts:710-715）；
- `pi.sendMessage` 的 custom message（customType）走消息流到达 GUI（event-adapter.ts:517-527 已消费，如 subagent-bg-notify）——适合用户可见通知，不适合状态记录。

**问题在于 xyz 没有以这些快照与官方通道为中心组织数据流**，而是把快照拆成事件流、再在 runtime/renderer 各自拼回状态，每类数据自建「事件驱动缓存 + 专属回写路径 + 专属兜底拉取」。

### 关键术语（首次定义，全文通用）

- **权威源（source of truth）**：某数据唯一正确的最终存储。本文中 = pi 进程（session 文件 + agent 内存态）。subagent/workflow 是例外——pi 没有此概念，权威源是 xyz 扩展经 `appendEntry` 写入 pi 文件的自描述 custom entry（存储由 pi 执行，语义归 xyz 扩展）。
- **绝对写规则**：xyz 的任何代码（runtime / renderer / 脚本）永不打开 pi 的 session JSONL 进行写操作。对 pi 持有状态的修改只发生在 pi 内部（内置 RPC 或扩展 API）。这条规则的力量在于绝对性——一旦有例外，例外就会衰变（label 双写方就是前车之鉴）。
- **pi 内操作原则**：pi 没有而 xyz 需要的能力，默认解法是开发 pi 扩展在 pi 进程内实现（经 `appendEntry` 持久化、经 `entry_appended`/`get_entries` 上报），runtime 只经 RPC 存取。禁止 runtime 绕过 pi 直接读改 pi 的内部数据。
- **owner（数据所有者）**：xyz 侧某类数据唯一的写入者——一个模块、一个状态容器、一个写入口。所有来源（事件/RPC/文件）都汇入 owner 的单一入口，读方只读 owner。
- **投影宿主**：runtime 是唯一的投影发生地——所有派生（merge/normalize/计数对齐/状态推导）在 runtime（或 core 包的唯一实现）发生一次；**renderer 零派生**，stores 只是视图模型容器，经单一 `applySnapshot` 入口接收 view-ready 数据。
- **纯派生缓存**：只有一个写方（扫描/转换/计算本身）、可随时丢弃并从权威源完整重建的缓存。例：session 目录扫描缓存。
- **影子状态库**：有独立写路径（被多条事件/RPC 回写直写）、承载真值的缓存。它是 12 类问题的载体。例：runtime `sessionMetaCache`（4 个写方）。
- **快照拉取 + 事件失效**：标量状态的复制模式——数据只由 owner 从权威源拉取快照填充；事件到达只做一件事：标 dirty 并触发（防抖后的）重拉。事件永远不直接写数据。
- **单一 reducer 双路喂入**：append-only 日志数据（消息流）的复制模式——renderer 的消息列表是 entry 日志的纯函数，一个 `applyEntry` reducer 同时被实时事件流与文件重放喂入。「live ≡ reload」从构造上成立，而非两个独立实现靠纪律保持等价。
- **按字段分权威**：当权威源对某数据只覆盖部分字段（已核实：队列深度有快照、内容无任何 pi 通道），按字段拆分权威并显式登记，而不是虚构一个单一权威。

### 设计目标（从使用者体验倒推）

- **G1**（用户）：手动命名的 session 永不被 auto-rename 覆盖；断网重连后模型/用量/队列显示与断连前一致（队列**内容**依赖 renderer 本地副本存活 + 深度与 `get_state.pendingMessageCount` 对账——pi 无队列内容通道，RPC 命令全集与 ExtensionAPI 均已核实，owner 分工见 §3.3 D6）；重开 session 后对话分组、subagent 状态与重开前一致。
- **G2**（开发者）：动手改任何 GUI 数据前，能在一张登记表里查到该数据的 owner、权威源、唯一写入口与已知例外。
- **G3**（质量）：「实时视图 ≡ 重开视图」「广播状态 ≡ pi 快照」成为 CI 可执行的等价性测试，任何回归（代码偷偷直写状态）会让等价性破功并报警。
- **G4**（预防，双层）：语义层——pr-cr-fix 的 review agent 携带数据治理 checklist，任何 PR 引入第二写路径/绕过 owner/pi 文件直写时在 review 阶段被拦（现状唯一可用的护栏，因为 pre-commit 对该类问题零覆盖）；机器层——pre-commit / lint 落地后拦截模式级违规并指向登记表条目。

### Scope

- **In-scope**：§2 清单中 12 类数据的修复路径；runtime/renderer 的 owner 与投影结构重组；双层预防机制；分五阶段（P0-P4）的迁移计划。
- **Out-of-scope**：修改 pi 源码（项目铁律 [MANDATORY]，pi 没有的能力由 xyz 自实现——自实现的默认形态是 pi 扩展，见「pi 内操作原则」）；消息分组的渲染语义重构（turnId 分组归 `fix-chat-flow-order` 分支的设计，本文只覆盖其数据层前提——entry 级单一来源与单一 reducer）。

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

**失败模式 B（已证实，断连/重开后状态漂移）**：对话中断 WS 重连后，用量/模型/队列等显示依赖「断连期间丢失的事件是否被 ring 快照回放覆盖」——ring 溢出即永久丢失（renderer `subscription-state.ts` 注释自认该风险）。重开 app 后 session 列表来自磁盘扫描，`scannedToSummary` 硬编码 `modelId: ''`、`tokenCount: 0`（`session-scanner.ts:79-80`），renderer `setGroups` 全量覆盖曾把真值抹成空串（`packages/core/src/domain/session/store.ts:70` 注释记录的踩坑史）。

**失败模式 C（已证实，双管线解析漂移）**：subagent 后台任务完成后，侧栏状态、主对话注入 turn、重开后的 extractor 解析可能不一致——实时路径（event-interpreter 内存 Map）与磁盘路径（subagent-extractor 重新解析 JSONL）是两条独立管线，各自演进；文件改动展示同样双管线（实时 git baseline diff vs 历史从 toolCall 参数静态解析，`message-converter.ts:44` 注释自认「两条路径实现不同、bash 无法覆盖」）。

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

四种模式指向同一个根因：**xyz 缺少数据治理结构——没有「每类数据必须声明唯一 owner、权威源、唯一写入口」的约束，也没有任何自动化/流程化手段检测「第二写入路径」的出现**。于是每类新数据进来都自然长成多源（事件直写最顺手），每类把同样的时序坑各自踩一遍。这解释了为什么 #12（commands）修过一次时序坑后，同样的坑在 #1-#11 上重复出现——修复是逐点的，结构没有变。

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

### 3.0 终态架构原则（五条，全方案的判断准绳）

1. **绝对写规则**：xyz 代码永不写 pi 的文件。pi 持有状态的所有修改发生在 pi 内部——内置 RPC（`set_session_name` 等）或扩展 API（`appendEntry` 等）。无白名单、无例外；迁移期唯一的 legacy 例外必须登记并带移除期限。
2. **pi 内操作原则**：pi 能力缺口由 pi 扩展在 pi 进程内补齐（持久化经 `appendEntry`，上报经 `entry_appended` + `get_entries`），runtime 只经 RPC 存取。runtime 对 pi 数据只有两种动作：调 RPC 命令、订阅事件。
3. **投影只发生一次**：runtime 是唯一投影宿主。所有派生逻辑（merge / normalize / 计数对齐 / 状态推导）在 runtime（或 core 包唯一实现）发生一次；renderer 零派生，stores 是视图模型容器，唯一写入口是 `applySnapshot`。多 pane / 多窗口是 runtime 副本的下游扇出，绝不出现两个消费者各自从 pi 独立推导。
4. **两种复制模式按数据形态分流**：标量 session 状态走通用快照复制原语 `ReplicatedState<T>`（快照拉取 + 事件只做失效 + 周期/重连兜底重拉）；append-only 日志（消息流）走单一 `applyEntry` reducer 双路喂入（实时 feed 与文件重放共用一份派生代码）。不发明第三种模式；权威源能力缺失处（队列内容）降级该通道为对账信号 + 按字段重划权威，而非绕过权威源另起炉灶。
5. **治理即代码**：数据登记表的终态是可执行配置——驱动 `ReplicatedState` 实例、lint/pre-commit 许可表、契约测试参数，人读文档由它生成。护栏是双层：机器检查（模式级）+ pr-cr-fix review agent（语义级，长期存在，因为跨文件语义「第二写方」机器只能拦直呼形态）。

### 3.1 终态（使用者视角）

**终态样例 1（用户改名，成功路径）**：用户右键活跃 session 改名"重构计划"→ renderer 乐观显示新名 → runtime 调 pi RPC `set_session_name` → pi 落盘并广播 `session_info_changed` → renderer 确认显示。此后 auto-rename 的守卫 `pi.getSessionName()` 读到非空 → skip（守卫日志 "skip: name exists"）。用户再发 10 条消息，名字保持"重构计划"。对**非活跃** session（无 pi 进程）改名：runtime 短命拉起一个 pi 进程附着该 session 文件 → 同样走 `set_session_name` → 关闭进程。全程 xyz 代码零次打开 JSONL 写。

**终态样例 2（断连自愈）**：对话中 WiFi 断开 30s 重连。renderer 收到重连信号 → 对活跃 session 重拉快照（`get_state` + `get_session_stats`）→ 模型/思考档位/用量/队列深度与断连前一致——不依赖任何「断连期间事件是否补发成功」。（队列项文本显示来自 renderer 本地副本——断连 ≠ renderer 重启，副本存活；副本与 pi 队列的偏差由 queue_update 对账清空，深度由 `pendingMessageCount` 对账。）

**终态样例 3（开发者新增数据被拦，双层护栏）**：开发者在 feature 分支给 session store 加了第二个写方法调用点（绕过 owner）。第一层：PR 阶段 pr-cr-fix 的 review-data-governance agent 按 checklist 检出「事件直写 store，绕过登记表条目 #5 的唯一写入口」，报 MUST_FIX；第二层（机器检查落地后）：`git commit` 时 pre-commit/taste-lint 报错并指向登记表条目。开发者查登记表，改为经 owner 写入。

**终态样例 4（扩展数据单源）**：后台 subagent 完成 → 扩展在 pi 内 `appendEntry('subagent-record', {...完整自描述记录})` → pi 持久化并广播 `entry_appended` → runtime 收到失效信号，经 `get_entries(since=cursor)` 增量重拉 → 更新纯派生缓存 → 向 renderer 广播 view-ready 快照。重开 session 后走同一份 entry 扫描代码重建——实时与重放是同一条管线。

**失败路径与恢复指引**：

- **快照拉取失败**（pi 忙 / RPC 超时）：owner 保留 dirty 标记不清除，按 1s/5s/15s 退避重试；WS 重连时 `resubscribeAll` 附带全量重拉。UI 显示上一次快照值（可能短暂陈旧但不会错乱）。恢复动作：无需人工干预；若 pi 进程死亡，session 标 dead 态走既有 revive 流程。
- **get_entries 游标失效**（since 指向的 entry 不存在，如文件被外部截断）：RPC 返回错误（rpc-mode.ts:615），owner 退化为全量重拉自愈——游标只是优化，不是正确性依赖。
- **扩展上报失败**（自描述 entry 未到达）：owner 回退读磁盘 entry（既有 extractor 路径降级为兜底），UI 正常但标注数据可能滞后。恢复动作：`session.getSubagents` RPC 手动刷新即自愈。
- **rename RPC 失败**（pi 进程死）：活跃 session rename 失败则 toast 报错保留旧名，用户重试；非活跃 rename 的短命 pi 拉起失败同样报错重试。恢复动作：session revive 后重试 rename。

### 3.2 方案对比

| | 方案 A：全删缓存，全量直读 | 方案 B：绝对写规则 + 投影一次 + 两种复制模式（**推荐 ✅**） | 方案 C：保留多写路径 + 版本号同步协议 |
|---|---|---|---|
| 长期架构 | 差：无本地状态层，事件增量推送失去意义；每次 UI 刷新全量拉取/全量扫描磁盘 | 好：写路径一条（pi 内部）；派生一份（runtime 投影宿主）；事件丢失免疫（重拉自愈）；断连/重连/重开三场景天然一致；「事件只做失效」可被等价性测试证伪；一致性是结构性质而非时序纪律 | 差：多写方依旧存在，只是加了仲裁；版本协议本身成为新 bug 源（分布式里都没便宜解，单体内更不值） |
| 短期成本 | 高：全链路重写 + 性能回退（session 列表每次全量读 JSONL、用量每次 RPC） | 中高：runtime 重组（ReplicatedState 原语）+ renderer 写入口收敛 + 扩展自描述上报；分五阶段可控，P0 一天可交付止血 | 中：每条写路径加版本逻辑 |
| 风险 | UI 闪烁、IO 放大 | 拉取防抖窗口内 UI 滞后百毫秒级；pi RPC 频率上升（快照很小，预期影响可忽略，实施期 P0 量化证实）；非活跃 rename 增加 pi 冷启动延迟（实施期 P0 量化） | 时序/时钟问题解决成本高于收益 |

**被否方案的反例推演**：若选 A，§3.1 样例 1 的 rename 在 pi 进程死后无法落盘（无本地状态可写），样例 2 的断连自愈变成「断连期间所有显示冻结」；若选 C，失败模式 A 的两个写方各带版本号，但版本只在「双方都读到对方版本」时有效——rename-session 扩展读不到 xyz 的写（这正是现状 bug 的本质），版本协议无法修复它，等于没修。

**推荐 B 的核心理由**：它把「一致性」从运行时时序约定（注释里的「缓存写入先于读取」）变成三个结构性事实——写只有一条路（pi 内部）、派生只有一份码（runtime 投影宿主）、对账通道永远存在（快照重拉 / get_entries 全量）。结构性质可以用等价性测试持续断言，也可以被 review checklist 逐项核对——这是 G3/G4 的前提。

### 3.3 关键决策与权衡

**D1 缓存处置判据（回应「缓存是否先全删」）**：判据一句话——**缓存里是否存在权威源之外的第二个写入者？有 → 收编或删除（影子状态库）；没有 → 保留（纯派生缓存）**。

| 缓存 | 判定 | 处置 |
|---|---|---|
| session 目录扫描缓存 / git-info 缓存 / quota 缓存 / history-rebuild-cache / turn-render-cache | 纯派生（写方=扫描/转换本身） | 保留不动 |
| runtime `sessionMetaCache` | 影子状态（label/thinkingLevel 各 3-4 写方） | 收编进 ReplicatedState 实例，删除 |
| runtime `session.inputTokens/tokenCount` | 影子状态（5 写点） | 收编；switchModel 重算改在 owner 内部读自己的缓存，竞态从「注释约定」变「结构不可能」 |
| event-interpreter `subagentRecords` Map | 影子状态（双管线之一） | 收编：扩展自描述 entry（经 get_entries 拉取）为唯一源，Map 变纯派生缓存 |
| renderer summary 字段（updateLabel/updateSessionState/setGroups 三路写） | 影子状态 | 收编为单一 `applySnapshot` 入口（合并规则见 D1b） |
| renderer `pendingBuffer` | 职责错位（承担投递定位） | 保留但改**计数 FIFO**：queue_update 差集已算出被投递条数，按条数顺序取 segments，删除文本相等匹配。queue 的 owner 分工见 D6 |

被否：全删（同方案 A）。「先干掉再重建」的过渡态成本极高且不解决独立写路径问题。

**D1b 快照合并规则（两条，不可混用）**：

- **owner 快照合并 = 权威源整字段覆盖，含显式空值**。反例（对抗审查逼出）：pi `get_state.thinkingLevel` 的合法值含 undefined（切到不支持思考档位的模型时，权威真值就是空）——若一刀切「空值不覆盖非空值」，owner 将永远保留旧档位，影子状态复活，恰是本方案要消灭的东西。
- **空值守卫仅用于磁盘扫描占位值路径**：`scannedToSummary` 硬编码的 `modelId:''`/`tokenCount:0` 是「无数据」占位符而非权威空值，P2.3 守卫语义是「占位符不覆盖已知真值」。
- 落实到登记表：按字段登记空值语义——label 空 = 未设置（可守卫）；thinkingLevel 空 = 合法态（必须整字段覆盖）。字段空值语义是 `ReplicatedState` 配置的一部分。

**D2 label 写路径——绝对写规则的落地**：

- **活跃 session**：手动 rename → runtime rpc-client 接线 pi `set_session_name` RPC（✅ 已验证存在于 rpc-mode.ts:632，内部 `sessionManager.appendSessionInfo` 落盘 + emit `session_info_changed`，agent-session.ts:2718）→ pi 成为该文件唯一写方。删除 `persistSessionName` 对活跃 session 的直写。
- **非活跃 session**（无 pi 进程）：终态机制 = runtime 短命拉起 pi 进程附着该 session 文件 → `set_session_name` RPC → 关闭。复用既有 spawn/revive 机制，无新子系统。⛔ 探针：pi 冷启动延迟对侧栏改名交互的实际感知（P0 量化；若不可接受，候选缓解 = 改名请求排队到一个 warm 的 utility pi 进程，而非为每次改名冷起）。
- **迁移期唯一 legacy 例外**：P0 只消灭活跃 session 直写（并发危险所在）；非活跃直写若未能同阶段切换，必须在登记表登记为「唯一 legacy 例外 + P1 移除期限」，并在 pre-commit R1 的 allowlist 里单独列出——例外是带期限的债务，不是制度。
- 探针：✅ pi RPC 命令存在性与行为（read 源码核实）；⛔ rename-session 守卫日志 "skip: name exists" 在真实链路出现（实施期 P0 用 `pi --mode rpc` 实测，复用 AGENTS.md 的扩展实测流程）。

**D3 session 终态（session_end）存储——维持 sidecar，且在绝对写规则下合法**：现状核实（对抗审查纠错）：ADR-0042 原版决策是 append JSONL，但其后 **W1 修订已改为 runtime 单写 sidecar `.meta.json`**（`persistSessionEnd`，session-file-utils.ts:111-157，注释明言「不污染 JSONL」+ 规则 #6 规避 pi `openSync("wx")` 竞态）。sidecar 是 **xyz 自有文件**，不是 pi 的文件——runtime 单写 sidecar **不违反绝对写规则**（规则管的是 pi 的 JSONL）。裁决：

- **选项 a（维持 sidecar，默认推荐 ✅）**：sidecar 已是单写方、无并发冲突、无 pi 兼容性风险；W1 的两个原始动机依然成立。工作收窄为：sidecar 读写收口到登记表声明的单一 util（现状已是），登记表登记「sidecar 是 pi 体系外 xyz 自有数据的合法形态」。
- **选项 b（改扩展 appendEntry 进 pi 文件）**：技术上已可行（appendEntry 通道已核实，见 D4），动机是「session 导出/迁移时终态随文件走」。若未来因真实需求选 b，必须先补三件迁移设计：① 存量 sidecar 兼容读取（优先级 custom entry > sidecar > 旧直填）；② sidecar 退役时间表；③ 显式修订 ADR-0042 + W1 并落档。
- 探针：✅ sidecar 实现已 read 核实（原子写 tmpfile+rename + 写后失效 meta 缓存）；⛔ 选项 b 的实际收益场景当前不存在，不做投机改造。

**D4 subagent/workflow 单一来源——extension-in-pi 官方通道**：pi 无 subagent/workflow 概念，但提供了扩展持久化的官方机制（§1「系统是什么」已核实）：`appendEntry` 由 pi 持久化 custom entry + `entry_appended` 全量转发 + `get_entries(since)` 增量拉取。终态：

- 扩展侧 record-store/RunStore 保持内存权威；**状态变更时扩展 `appendEntry` 一条自描述完整记录**（字段即 SubagentRecord/WorkflowRunRecord，不依赖读取方逆向解析 toolCall/toolResult 编码）——pi 文件成为扩展数据的持久化权威，写方是 pi（符合绝对写规则），语义归扩展；
- runtime 消费：`entry_appended` 作失效信号 → `get_entries(since=cursor)` 增量重拉 → 内存 Map 重建为**纯派生缓存**（唯一写方 = entry 扫描）；实时与重开走同一份扫描代码，模式 2 双管线结构性消亡；
- `subagent-extractor`/`workflow-extractor` 降级为「冷启动旧 session（无自描述 entry）兜底」并标注 legacy；扩展的 state 文件退役或降级为纯性能缓存（可从 entry 完整重建时才允许存在）；
- workflow 现有 link entry 形态向自描述记录收敛（统一 #8/#9 为同一形态）。
- 探针：⛔ 自描述 entry 的大小与 append 频率（长 workflow 的 trace 全量快照可能膨胀——实施期 P3 量化，必要时 trace 增量 append + 状态全量 append 两种 customType 分流）；✅ appendEntry 持久化 / entry_appended 转发 / get_entries since 语义均已 read 源码核实（agent-session.ts:2264-2271、rpc-mode.ts:354-356、:609-619；session-manager.ts:92-95 官方状态重建通道）。

**D5 消息流——单一 reducer 双路喂入**：消息是 append-only 日志，不适合快照重拉（streaming 太重）。终态：

- renderer 消息列表是 entry 日志的纯函数：core 包内单一 `applyEntry(state, entry)` reducer，**实时 feed 与文件重放喂同一个 reducer**——「live ≡ reload」从构造上成立（等价性测试仍保留为哨兵，但断言的是不变量而非两个独立实现的等价）；
- 实时 feed 的数据载体向 pi 的 entry 级通道收敛：`entry_appended` 携带完整 entry 对象（agent-session.ts:140）；streaming 中的 partial content（message_update 流）是临时 UI overlay，entry 提交时丢弃，不进权威状态；
- 分组语义（turnId 分组）归 fix-chat-flow-order 分支，本决策只提供其数据层前提：entry 序号稳定、来源单一。
- 探针：⛔ `entry_appended` 当前只在扩展 appendEntry 路径发射（agent-session.ts:2269），message entry 的 `_persist` 路径是否同样发射需核实（若不发射，实时 feed 的 message 部分暂由 message_end 等事件重构 entry， reducer 输入的同构性由等价性测试断言；长期若 pi 上游补发射则无缝切换）。

**D6 队列——按字段分权威（已核实为终态，非妥协）**：pi 侧能力面已穷尽核实：RPC 命令全集（rpc-mode.ts:385-653）无队列内容快照，`get_state` 仅 `pendingMessageCount`；完整队列数组只在 `queue_update` 事件（agent-session.ts:503-508）；ExtensionAPI 无队列内容读口（types.ts 仅 `hasPendingMessages()` 布尔），扩展也拿不到内容。因此：

- **深度**权威 = pi：走 `get_state.pendingMessageCount` 快照对账；
- **内容**权威 = renderer 提交日志（它提交过所以它有）：queue_update 差集算被投递条数 → 计数 FIFO 取 segments（删文本匹配）；queue_update 是对账信号而非数据载体；
- 登记表按字段登记该分工，防止后来人误以为「缺一个队列快照接口」而发明新写路径。

**D7 投影一次——renderer 零派生**：runtime 是唯一投影宿主（长寿命进程：后台 subagent/workflow 在窗口关闭后继续存活，副本必须活在这里；session 目录扫描横跨无 pi 进程的历史文件；多 pane 扇出需要去重）。落地形态：

- 所有派生逻辑（merge / normalizeSubagentStatus 类状态归一 / 计数 FIFO / 空值守卫）从 renderer 上移到 runtime 或 core 包唯一实现；renderer stores 退化为视图模型容器，唯一写入口 `applySnapshot`，WS 消息必须是 view-ready DTO；
- `ReplicatedState<T>` 通用原语承载六类标量 session 状态（label/thinkingLevel/modelId/usage/queue 深度/commands）：配置三元组 = `(快照 RPC, 失效触发源, 合并策略含字段空值语义)`。六类同构，不允许各写各的缓存——**新数据 = 新配置条目，不存在「顺手加个缓存」的物理路径**。登记表因此从 markdown 演进为可执行配置（人读文档由配置生成/双向校验）；
- modelId 无 pi 事件可依赖（已核实 pi 无 model_changed 事件），其失效源 = switchModel RPC 响应后主动拉快照（RPC 响应驱动）——这是「事件只做失效」的补充合法形态，登记在配置里。
- 被否的更激进选项「runtime 彻底无状态化变纯 WS↔RPC 桥」：不成立——runtime 寿命长于 renderer，必须持有副本；但它的副本从手写缓存变成通用原语的实例。

**D8 预防双层护栏（详见 §3.6）**：语义层（pr-cr-fix review-data-governance agent，本文档配套交付，长期存在）+ 机器层（R1/R2/R3 pre-commit/lint + 等价性测试族 + 登记表即代码 + ADR）。被否：仅靠 ADR 文字约束与 review 人眼——#12 修复后同类坑在别处复发已证明人眼不可靠；也否「等机器检查落地再说」——机器检查对跨文件语义只能拦直呼形态，语义层必须独立存在且先生效。

### 3.4 目标物理数据流（以 label 为例）

```
[renderer 进程]                    [runtime 进程]                              [pi 子进程]              [磁盘]
session store.applySnapshot  ◄── 快照 diff 广播  ◄── ReplicatedState<label> 实例 ◄── RPC get_state
（唯一写入口，零派生）                      ▲  │（owner：配置驱动的原语实例）           │                    │
                                           │  └── session_info_changed 事件 = 仅标 dirty 触发防抖重拉      │
                                           └── 断连重连 / 定时兜底 → 全量快照重拉                         ▼
活跃 rename:    rename 请求 ──────────────► rpc-client.set_session_name ──► sessionManager.appendSessionInfo（唯一写方）[session.jsonl]
非活跃 rename:  rename 请求 ──────────────► 短命 pi 进程附着该文件 → 同上 RPC → 关闭（xyz 零次打开 JSONL 写）
auto-rename:    rename-session 扩展在 pi 内 ──► pi.setSessionName（守卫读到全部写，因为所有写都经 pi）
```

与 §2.5 对比：pi 文件的写方从 2 个（互不知情）变为**恒 1 个**（pi 自己，含扩展经 pi API）；xyz 侧写入口从「runtime 直写 + metaCache 3 写方 + renderer 3 路写」变为「ReplicatedState 实例 + applySnapshot」两处单入口。

### 3.5 分阶段迁移（概览，详见 §5）

P0 止血 + 护栏先行（活跃 rename 接 RPC 修覆盖 bug + 登记表 + review agent 与 R1/R3 机器检查同期上线）→ P1 runtime owner 收敛（ReplicatedState 原语落地六类 + 非活跃 rename 切换短命 pi，绝对写规则全线生效）→ P2 renderer 零派生收敛 → P3 扩展数据单源（自描述 entry）+ 消息流 reducer → P4 等价性测试全量化 + ADR 落档。**护栏在 P0 与止血同期上线**——先立守护再动大刀，重构过程本身被守护。

### 3.6 预防机制双层（对应 G4，本方案的核心增量）

**现状诚实声明**：项目现有 pre-commit（`.bare/hooks/pre-commit` + `.githooks/`）覆盖 lint/类型/边界/打包/i18n 等，但**对「数据多源」这一类零覆盖**；且 R2 类跨文件调用图检查即便落地，对变量拼接路径、间接写、语义级第二写方静态不可判定。因此语义层护栏（review agent）不是机器检查的过渡替代品，而是**长期并存的一层**；机器层拦截模式级违规，把 review agent 的注意力留给语义级违规。下文五层中：第 1 层 = 语义层；第 2-5 层 = 机器/流程层。

**第 1 层 语义审查（PR 阶段，立即生效，长期存在）**

- **S1 review-data-governance agent**：`.agents/skills/pr-cr-fix/agents/review-data-governance.md`（本文档配套交付），接入 pr-cr-fix 的 review 维度表（7 维 → 8 维）。checklist 核心：pi 文件直写（含变量拼接路径追形参）/ 第二写入者 / 事件直写状态 / renderer 派生逻辑 / 未登记缓存 / 扩展通道合规 / 登记表同步。登记表落地前以本文档 §2.2 清单为准绳，落地后以登记表为准绳。
- **S2 检出即 MUST_FIX**：数据治理违规等价于架构约束违规（对应 pr-cr-fix 严重度定义的 MUST_FIX 档），不得以 SUGGESTION 降级放过。

**第 2 层 静态拦截（提交前，模式级）**

- **R1 pi 文件直写检查**（新增 `.githooks/check_pi_direct_write.py` + pre-commit 接入，复用现有 checker 同体系）：runtime/scripts 代码对 session JSONL 的写操作（`openSync('a'/'w')` / `appendFile` / `writeFile` 指向 sessions 目录）一律报错；迁移期唯一 legacy 例外（D2 非活跃 rename）显式 allowlist + 期限注释，P1 删除直写代码后 allowlist 清空，规则变为无条件。**检出边界**：拦字面量/已知 util 形态的直写模式；变量拼接路径静态不可判定——拦模式，不承诺拦刻意绕过的语义（语义归 S1）。
- **R2 store 写入口检查**（taste-lint 自定义规则，项目已有 no-native-html 等先例）：每个 store 的 mutation 方法只能被其 owner 文件调用，许可表来自登记表。**实现路线**：跨文件调用图分析（复用 check-domain-boundaries 的 import 边分析思路）；首版降级为「拦直呼形态」（import 目标 store 后直调 mutation），登记表条目驱动逐步收紧。
- **R3 新缓存强制注解**：新增模块级 Map/ref 缓存必须带 `@data-owner <登记表条目>` 注解，lint 校验注解存在且条目真实。没有「顺手加个缓存」这回事。ReplicatedState 原语落地后（P1），标量状态缓存的合法形态收敛为原语实例，R3 检查「原语之外不得新建 session 状态缓存」。
- **误报豁免闭环**：R1/R2/R3 拦到合法写入时，豁免路径 = 先在登记表补条目/例外 + 豁免 allowlist 登记（对齐 check-domain-boundaries 既有 allowlist + 注释先例），禁止在代码里静默绕过——预防机制自身不能成为无出口的阻塞源。

**第 3 层 动态断言（CI 等价性测试族）**——对「事件只做失效」「单一 reducer」的可证伪断言，任何回归会让等价性破功：

- `live ≡ reload`：真实 pi 子进程跑操作序列（steer/followup/bash/后台 subagent 完成），断言实时 store 快照 == 文件重放快照；
- `broadcast ≡ get_state`：事件风暴后断言 renderer 状态 == pi 快照；
- 混沌注入：事件乱序/丢失/重放 → owner 状态必须收敛到权威快照（拉取自愈的结构性验证）。

**第 4 层 数据登记表**：`docs/architecture/data-source-registry.md`，12 类数据的 owner / 权威源 / 唯一写入口 / 字段空值语义 / 已知例外（含 legacy 例外的移除期限），是 S1/R2/R3 许可表的依据 + review 时的对照 SSOT（对齐 ADR-0049 checklist 先例）。P1 起演进为可执行配置（ReplicatedState 配置即登记表条目），markdown 由配置生成或双向校验。

**第 5 层 ADR + review checklist**：新 ADR（编号顺延，当前最高 0061）「单一数据 owner + 绝对写规则」：判据、事件只做失效、pi JSONL 唯一写方 = pi 进程（含扩展经 pi API）、sidecar 是登记在案的 xyz 自有合法形态（D3）、队列按字段分权威（D6）。pi 升级时跑 pi-protocol 契约测试（ADR-0037 联合类型 exhaustive 检查已有），防止上游事件语义漂移悄悄制造新分叉。

---

## §4 验收

**结论：五个真实场景验收（全部真实 pi 子进程 / 真实文件，无 mock），分别回溯 G1-G4；P0/P1/P2/P3 各阶段有对应可先行验收的场景。**

### 场景 1：手动命名不被覆盖 + 绝对写规则生效（P0/P1，回溯 G1）

- **步骤**：`pnpm dev` 起真实环境 → 新建 session 发首条消息 → 等自动命名出现（观察 rename-session 扩展日志 `renamed to`；日志查看方式：`XYZ_AGENT_DEBUG=1` 起环境后看 `~/.pi/agent/logs/`，AGENTS.md 扩展调试约定）→ 侧栏右键手动改名「重构计划」→ 继续对话 3 轮 → 检查侧栏名与 `get_state.sessionName`。再对另一个**非活跃** session 执行右键改名（P1 验收）。
- **通过标准**：3 轮对话后侧栏名仍为「重构计划」；扩展日志出现 `skip: name exists`；session JSONL 尾部无新增 auto 标题的 session_info entry；`get_state` 返回「重构计划」。非活跃改名后 JSONL 尾部出现改名 entry（由短命 pi 进程写入）。代码断言（P1）：`git grep -nE "openSync\('(a|w)'|appendFile|writeFile" packages/runtime/src/` 命中中不存在指向 sessions 目录的写路径（R1 检查脚本 exit 0，allowlist 为空）。

### 场景 2：断连自愈（P1/P2，回溯 G1/G3）

- **步骤**：对话进行中（已切过模型、有用量、队列里压一条 followUp）→ 杀掉 WS 连接模拟断网 30s（期间 pi 完成一轮回复）→ 重连。
- **通过标准**：重连 5s 内模型/思考档位/用量百分比/队列深度与 pi `get_state` + `get_session_stats` 逐字段一致（人工对照 RPC 返回），全程无错误 toast；对话流不缺消息（live ≡ reload 断言脚本输出一致）。

### 场景 3：重开一致性（P3，回溯 G1/G3）

- **步骤**：一个 session 内依次执行：steer 一次、`!` bash 一次、启动一个后台 subagent 并等其完成注入 → 重启 app 重新打开该 session。
- **通过标准**：重开后消息分组、subagent 侧栏状态、用量显示与重开前一致（截图对照）；CI 等价性测试 `live ≡ reload` 对该 session 通过。

### 场景 4：预防拦截（P0，回溯 G4）

- **步骤**：在测试分支故意制造三个违规：① 在 owner 文件外调用某 store 的 mutation；② 在 runtime 新增一段直写 session JSONL 的 `appendFileSync`；③ 新增一个事件 handler 直写 store 字段（语义级，绕过形态上不违反 R1/R2 直呼模式）。对①②执行 `git commit`；对③跑 pr-cr-fix review（review-data-governance 维度）。
- **通过标准**：①②被 pre-commit/taste-lint 拦截，报错指向登记表条目；③被 review agent 检出为 MUST_FIX（证明语义层覆盖机器层盲区）；按指引修正后提交通过。

### 场景 5：subagent 单源一致（P3，回溯 G1/G3）

- **步骤**：后台 subagent 完成后，对照侧栏 SubagentList 状态、主对话注入的完成 turn、`session.getSubagents` RPC 返回三者；再重开 session 后对照第四次（entry 扫描路径）；检查 session JSONL 中存在自描述 custom entry。
- **通过标准**：四处状态一致（closed + 相同 result 摘要）；混沌测试（丢失 entry_appended 广播）后 `get_entries` 重拉能收敛到正确状态。

---

## §5 下一层拆分

**结论：五阶段递进，每阶段独立可验收可回滚；P0 把唯一的已证实 bug 修掉并立起双层护栏，P1-P3 在守护下逐域收敛，P4 固化为长期回归基线。**

### P0 止血 + 护栏先行（1-2 天；验收：场景 1 前半、4）

| 单元 | 内容 | justification |
|---|---|---|
| P0.1 | rpc-client 接线 `set_session_name`；`renameSession` 活跃分支改走 RPC；删除活跃 session 的 `persistSessionName` 直写；非活跃分支若暂留直写，登记为唯一 legacy 例外 + P1 移除期限 | 唯一已证实 bug，pi API 现成（✅ 已核实），改动面最小 |
| P0.2 | 数据登记表初版（12 条 + 字段空值语义 + legacy 例外登记） | 护栏的 SSOT 依据，先于一切重构 |
| P0.3 | S1 review-data-governance agent 接入 pr-cr-fix（本文档配套交付）+ R1 pre-commit 直写检查 + R3 缓存注解规则 + R2 骨架（拦直呼形态） | 先立守护再动大刀；语义层（S1）与机器层（R1-R3）同期上线，P1-P3 每步重构被双层覆盖 |
| P0.4 | 等价性测试骨架（真实 pi 子进程 fixture + `live ≡ reload` 断言脚本雏形） | 后续阶段的验收工具，P0 就绪 |
| P0.5 | 探针：pi 冷启动延迟量化（非活跃 rename 的短命 pi 方案可行性）+ RPC 快照频率影响量化 | D2/§3.2 风险栏的待验证项，决定 P1.4 形态 |

### P1 runtime owner 收敛（3-5 天；验收：场景 1 后半、2 前半）

| 单元 | 内容 | justification |
|---|---|---|
| P1.1 | `ReplicatedState<T>` 原语 + label/thinkingLevel/modelId/usage/queue 深度/commands 六个配置实例（合并策略含字段空值语义，规则见 D1b）；登记表条目演进为配置 | §2 模式 3 的收敛点，六类数据同构；配置即登记表 |
| P1.2 | 事件改失效信号：session_info_changed/thinking_level_changed/queue_update/context 相关事件 → dirty + 防抖重拉。modelId 失效源 = switchModel RPC 响应后主动拉快照（已核实 pi 无 model_changed 事件） | 「事件只做失效」落地的第一步 |
| P1.3 | 删除 sessionMetaCache；applyContextUpdate 五写点收编为单入口；switchModel 重算移入 owner | 影子状态库退场 |
| P1.4 | 非活跃 rename 切换短命 pi 进程（依 P0.5 探针定形态：逐次冷起 / warm utility pi）；删除 persistSessionName 全部直写代码；R1 allowlist 清空 | 绝对写规则全线生效 |

### P2 renderer 零派生收敛（3-4 天；验收：场景 2 后半）

| 单元 | 内容 | justification |
|---|---|---|
| P2.1 | 每个 store 单一 `applySnapshot` 入口，setGroups/updateLabel/updateSessionState 收敛；派生逻辑（merge/normalize/推导）上移 runtime/core 唯一实现，WS 消息改 view-ready DTO | D7 投影一次的 renderer 侧落地 |
| P2.2 | pendingBuffer 计数 FIFO（删除文本匹配） | #6 失联即丢消息的修复，改动小收益确定 |
| P2.3 | scannedToSummary 空值守卫全量路径核查 | #2 空串覆盖的最后防线 |

### P3 扩展数据单源 + 消息流（1-2 周；验收：场景 3、5）

| 单元 | 内容 | justification |
|---|---|---|
| P3.1 | subagent/workflow 扩展 `appendEntry` 自描述上报 + runtime `entry_appended`（移出 NULL_EVENTS）+ `get_entries(since)` 消费 + 内存 Map 改纯派生缓存 + extractor 降级 legacy + workflow link entry 形态收敛 | 模式 2/4 的收敛，D4；pi 官方通道，已核实 |
| P3.2 | session_end 维持 sidecar 单写方（D3 裁决选项 a）：读写收口 + 登记表登记 sidecar 为 xyz 自有合法形态；appendEntry 改造（选项 b）仅在出现真实需求时启动，并按 D3 的迁移三件套执行 | W1 sidecar 已消除双写方，重造无净收益 |
| P3.3 | 消息流单一 reducer：core 包 `applyEntry` 双路喂入（实时 feed + 文件重放）；entry 级实时通道按 D5 探针结果定形态 | #7 的根治，与 fix-chat-flow-order 分组修复协同 |

### P4 预防固化（2-3 天；验收：全部场景回归）

| 单元 | 内容 | justification |
|---|---|---|
| P4.1 | 等价性测试族全量化（broadcast ≡ get_state / 混沌注入）入 CI | G3 的长期回归基线 |
| P4.2 | ADR-0062 落档 + review checklist（对齐 ADR-0049 先例）；R2 从直呼形态收紧到调用图 | 流程层固化 |
| P4.3 | pi 升级契约测试接线（ADR-0037 exhaustive 检查复用） | 上游漂移防线 |

### 文件改动地图（核心，非穷举）

- **新增**：`docs/architecture/data-source-registry.md`（P0 起为 SSOT，P1 起由配置生成）；`.agents/skills/pr-cr-fix/agents/review-data-governance.md`（S1，本文档配套交付）；`packages/runtime/src/services/session/replicated-state.ts`（原语）+ 配置实例；`.githooks/check_pi_direct_write.py`（R1）；taste-lint 规则 2 条（R2/R3）；等价性测试 `packages/runtime/src/__tests__/equivalence/`；core 包 `applyEntry` reducer。
- **收敛**：`rpc-client.ts`（+setSessionName）；`session-lifecycle.ts` / `session-file-utils.ts`（直写收口 → P1 删除）；`session-meta-cache.ts` 删除；`session-service.ts` applyContextUpdate 收编；`event-interpreter.ts` 事件改失效；renderer/core 两侧 store 写入口（含 `packages/core/src/domain/session/store.ts` 等 core 包真实位置——renderer `stores/session.ts` 是 ADR-0059 薄壳）；`effects/registry.ts` queue_update 计数 FIFO。
- **扩展**：`extensions/subagent-workflow`（自描述 appendEntry 上报）。session_end 按 D3 裁决 a 维持 sidecar，不新增 appendEntry 扩展。
- **skill**：`pr-cr-fix/SKILL.md` 维度表 7 → 8（S1 接入）。

### 待验证检查点（设计阶段无法确定，诚实标注）

- ⛔ pi 冷启动延迟对非活跃 rename 交互的感知（P0.5 量化，决定 P1.4 形态）。
- ⛔ 快照拉取的 RPC 频率与延迟对 UI 的实际感知（P1 量化，必要时事件做乐观提示、快照为准）。
- ⛔ 自描述 entry 的体积/频率（D4 探针，P3 量化；必要时 trace 增量 + 状态全量两种 customType 分流）。
- ⛔ `entry_appended` 对 message entry（非扩展 entry）是否发射（D5 探针，决定 reducer 实时 feed 形态）。
- ⛔ 非 xyz 创建的历史 session（无自描述 entry）在新代码下的降级表现（P3 回归）。
