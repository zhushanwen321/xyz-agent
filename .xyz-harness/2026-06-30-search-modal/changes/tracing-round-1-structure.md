---
phase: architecture
tracer: independent-subagent
frame: structure
round: 1
---

# 结构帧追踪（视角 3 分层纪律 + 视角 4 依赖边界）

> 4 视角（含建模帧的视角1/2，本帧按指令一并扫）。fresh context，仅读源码与文档对齐。
> 已 confirmed 决策（D-011~D-016）不当 gap 重报；初稿与决策冲突记为「初稿偏离」。

## 视角1 模型完整性

### 逐模型标注核对

| 模型（初稿§4） | 初稿标型 | 源码事实 | 判定 |
|------|------|--------|------|
| `SearchItem` | DTO（已有） | `api/mock/search-data.ts:9` 纯 `{type,title,sub}`，无行为 | ✅ 类型正确，纯净 |
| `SessionCommand` | DTO（已有） | `stores/command.ts:21` 纯结构 + iconKeyForSource 纯函数 | ✅ 类型正确 |
| `AppCommand` | 值对象（新增） | 字段含 `action: () => void`（§4 mermaid + §7） | ⚠️ 见 GAP-S1 |
| `RecentEntry` | 值对象（新增） | `{type,key,timestamp}` | ✅ 纯净 |
| `MatchSegment` | 值对象（已有） | `SearchModal.vue:141` segments 返回 `{text,hit}` | ✅ 纯净 |

### 检查项过

- **空壳模型**：无 aggregate（D-013 主动不建模），降级决策表 §4 列了 3 个「主动不建模」概念及理由（SearchSession aggregate / MatchStrategy port / SearchSource port）——建模粒度匹配良好，无空壳。✅
- **散落概念未建模**：未发现同一概念散落 3+ 文件。匹配逻辑（segments）目前在 `SearchModal.vue:141`，初稿 §7 已计划提取到 `lib/match-engine.ts`。✅
- **「装着行为的对象」反模式**：命令注册表把命令「数据 + action」打包（见 GAP-S1），但这正是命令注册表的职责内聚（Sidebar/SearchModal 共享单一权威源 D-004），不是反模式。模型本身无可守不变式（无领域规则），故仍是 DTO/值对象，合理。✅
- **不变式守卫**：DTO/值对象无 aggregate 级不变式可守（D-013），不变式栏写的都是结构约束（type∈枚举、非空、唯一），这些约束由 TS 类型 + 调用侧收口即可，不需要模型方法。建模粒度与系统性质（技术编排）匹配。✅

### GAP

**GAP-S1**（D，视角1）：`AppCommand` 含 `action: () => void` 却标为「值对象」。
- 事实：初稿 §4 mermaid 与 §7 均把 `AppCommand` 定义为 `{id,name,shortcut?,action}` 且标型「值对象（新增）」。
- 问题：值对象的判据是「纯净、无状态 mutate、不可变」。`action: () => void` 是行为闭包（捕获副作用），把行为与数据打包更接近「命令对象」而非值对象。这与 §4 同时把无行为的 `RecentEntry` 也标「值对象」造成同一名词指代两种性质不同的结构（一个纯数据、一个带行为闭包）。
- 建议：`AppCommand` 改标为「命令对象 / DTO（含 action 引用）」并显式说明它不是不可值对象；或在命令注册表文档里说明 action 是引用注入（注册时传入，不在 store 里 mutate）。这不与 D-013 冲突（D-013 说无 aggregate，命令对象仍是扁平结构），纯属类型标注精确度问题。

## 视角2 状态正交性

### Status / Reason 拆分核对

初稿 §5 明确：
- Status 枚举只有两态：`closed` / `open`，只描述生命周期阶段。✅
- open 内的视图态（recents/query-results/empty/loading/error/type-filtered）显式标注为「派生态，非独立状态变量」。✅
- Reason：显式声明「无独立 Reason——error 态原因由 catch 表达，不进状态机」。✅

### 检查项过

- **Status 只描述阶段**：✅ closed/open 只描述阶段；error/loading 是 transient 标志（ref+setTimeout/catch 驱动），不进 status 枚举。正交性好。
- **终态不可逆 / 合法转换图**：§5 画了 stateDiagram-v2，closed↔open 转换有触发条件。✅
- **死状态**：图里 `recents --> loading :（空查询不触发）` 是防误连的注释，recents 本身可达（query 清空回到）。`type-filtered`（Tab 切类）在状态图里**没画**——它被列为 open 内视图态之一，但 stateDiagram-v2 未含其转换。

### GAP

**GAP-S2**（K，视角2）：`type-filtered` 视图态在状态图中缺转换。
- 事实：§5 列出 `type-filtered`（Tab 切类激活时）为 open 内视图态之一，但紧随的 stateDiagram-v2 中只画了 recents/query_results/empty/loading 四态，未含 type-filtered 的进入/退出转换。
- 影响：可达性跑不全；读者无法判断 type-filtered 与 query_results 的叠加关系（是替换查询结果、还是在其上过滤）。
- 建议：在状态图补 type-filtered 的进入（Tab 按下）/退出（Shift+Tab 回全类 或 Esc）转换，或显式说明 type-filtered 是 query_results 的修饰态（查询结果的子集视图）而非并列终态。属文档完整性，松散状态机（D-014）本身不需收紧。

## 视角3 分层纪律

### 核心计算 & 分层深度

- §2 明确回答「核心计算是什么」：技术流程编排（聚合 4 数据源 → 子串匹配 → 分组渲染 → 跳转分发）。✅
- 分层深度 = 三层（Interface/Service/Infra），匹配「无业务规则，纯编排」（D-011）。✅ 无 DDD 四层的空壳 Domain 层。
- 核心层（Service 层 search domain / 匹配引擎）零外部 SDK 依赖——匹配引擎是纯函数（源码 SearchModal.vue:141 的 segments 无 ref/import api 验证可提取），search domain 只依赖 transport+pending（与现有 file/session/composer 域同构）。✅

### Port 价值定位

- §6 Port 清单明示「（无）— D-012 不做 port」。降级决策表对 MatchStrategy port、SearchSource port 各做删/翻/挪证伪（§10 D-012 + §4 降级表）。✅ 无伪 port。

### GAP

**GAP-S3**（D，视角3）：分层图（§6 mermaid）把「命令注册表」画在 Service 层且 `CR --> TR`（依赖 transport+domains），与项目 store 依赖铁律 + D-016 决策措辞张力。
- 事实 A：§6 层级图把 CR（命令注册表）置于 Service 层，箭头 `CR --> TR`（→ transport+domains/*，含 session.getCommands）。
- 事实 B：`stores/command.ts:10` 明文铁律「依赖方向：无（stores 间禁止互相 import；跨 store 协调由 composables/features 做）」。D-016 措辞「扩展 command store——增加全局应用命令注册区」也暗示命令注册表 = store 扩展 + 新 composable。
- 张力：store 层与 transport 之间有 composables/features 层（见 AGENTS.md「跨 store 协调由 composables/features 做」、`useConnection.ts` 现状）。若 CR 直接 `--> TR`，等于 store 跨过 composable 直连 transport，违反现有铁律；若 CR 中的 slash 命令数据来自 composable（订阅 session.commands / 调 getCommands）再写回 store，则 §6 图的 `CR --> TR` 箭头是错的（应改为 composable --> TR，store 只被动收 applyCommands）。
- 不与 D-016 冲突：D-016 决定「扩展 command store」是对的；问题是 §6 分层图把 store 画进了 Service 层并给了直达 transport 的箭头，模糊了 store/composable/transport 三者的依赖层次。
- 建议：§6 层级图区分——命令注册表的「数据持有」属 store（无外部依赖，被动收 applyCommands），「pi slash 命令的拉取/订阅」属 composable（依赖 transport，写回 store）。把 CR 拆为 store（Store 层）+ composable（Service 层）两节点，或至少把 `CR --> TR` 箭头改为经 composable，使依赖方向与 AGENTS 铁律一致。这是初稿对依赖图的画法偏离，不是决策回退。

**GAP-S4**（K，视角3）：分层图缺 SearchModal ←（命令注册表）依赖边。
- 事实：§9 泳道图显示 SearchModal 通过 search domain 查 3 源（file/session.getCommands），命令分组的命中候选来自命令注册表。但 §6 分层图只有 `SM --> SD / ME / JO / RC`，没有 `SM --> CR`（命令注册表）边。
- 张力：搜索浮层的命令分组数据源 = 命令注册表（D-004 单一权威源），SearchModal（或 search domain）必然读 CR。分层图漏画这条边会让「命令数据从哪来」不可见。
- 建议：§6 补 SearchModal/search domain → 命令注册表的读边（或说明 search domain 内部调 CR 读取应用命令 + pi slash 聚合）。属依赖图完整性。

## 视角4 依赖边界

### 循环依赖 / 上帝对象 / 生命周期打包

- **循环依赖**：架构新增模块（search domain / match-engine / useSearchJump / useRecents / useCommandRegistry）依赖方向均向下（renderer → transport → runtime），未发现环。现有 `command.ts` 已声明「stores 间禁止互 import」。✅
- **上帝对象**：初稿 §7 各模块 LOC 预估（SearchModal ~250、search domain ~120、注册表 ~100、引擎 ~40、跳转 ~80、recents ~60）均远低于 400 行警戒。现 SearchModal.vue 实测 186 行，Sidebar.vue 242 行。✅
- **扁平 struct 打包不同生命周期字段**：见 GAP-S5。
- **boolean flag 控制清理**：未发现。recents 用 timestamp 单调 + FIFO 淘汰（由数据推导），非 boolean flag 驱动清理。✅
- **interface 过度抽象**：D-012 明确不做 port，无 interface 过度抽象风险。✅

### deletion test（对疑似 shallow 模块）

对「search real domain」做删/翻/挪：
- **删**：若删掉 search domain，SearchModal 须直接调 4 个 api（file.search/session.list/session.getCommands + 读 recents）并自己聚合分组——聚合逻辑（合并候选、四类分组）会散进组件，复杂度未塌缩成一块而是散落 → **边界真实**。
- **翻**：依赖方向 renderer→transport→runtime，runtime 是稳定的数据源（已有 handler），renderer 依赖它天然；翻不了（runtime 不反向依赖 renderer）。✅ 真边界。
- **挪**：search domain 卡在「renderer 编排」与「transport 通道」的接缝，不可平移到 runtime（4 数据源中 3 个是 runtime WS、1 个是 localStorage/recents、1 个是前端命令注册表——混合生命周期，必须在 renderer 侧聚合）。✅ 真接缝。

结论：search real domain 边界成立，非伪层。

### GAP

**GAP-S5**（D，视角4）：`command store` 双区（全局应用命令区 + sessionId 分区 slash 命令区）打包不同生命周期字段，建模内聚度待核。
- 事实：D-016 决定「扩展 command store——增加全局应用命令注册区，与 sessionId 分区的 slash 命令并列，同 store 两区」。
- 张力（视角4 检查项「扁平 struct 打包不同生命周期的字段」）：应用命令是**全局 + 静态**（启动注册一次，不随 session 变），slash 命令是**per-session + 动态**（随 session 切换/创建变化，session 删除要 clear）。两者生命周期完全不同：一个是 app-scope 单例，一个是 session-scope 多实例。塞进同一个 store（同一 `defineStore`）会让「应用命令永不失效」与「slash 命令需按 session 增删」两种失效语义揉在一个响应式根里。
- 不与 D-016 冲突：D-016 的理由（复用 SessionCommand 模型 + 同属「命令」概念内聚）成立，但「同 store 两区」是建模粒度选择，需在初稿显式说明两区如何隔离失效（如 `appCommands: ref<...>` 与 `commandsBySession: Map` 两个独立 ref，互不触发；clearCommands 只动 slash 区，不碰应用命令区）。
- 建议：§10 D-016 决策补一句「两区物理隔离：appCommands（静态 ref）与 commandsBySession（动态 Map）分开声明，FIFO/失效逻辑互不影响」，证明这不是 boolean-flag 式的混打包。属建模精确度，不是决策回退。如实现时真用一个扁平结构混装，才触发 [REVISIT of D-016]。

**GAP-S6**（F，视角4）：源码 `file.search` 不做服务端子串过滤，初稿 §2/§9 与 requirements F6 对「runtime 查询后子串匹配」的描述需对齐落点。
- 事实：`runtime/src/transport/file-message-handler.ts:67-73` 的 `file.search` handler 直接 `fileService.searchFiles(sessionId, showIgnored)` 返回**全量递归 FileNode[]**，无 path 子串过滤参数；`domains/file.ts` 也无 query 入参（file.ts 只有 tree/expand/read，file.search 在 composer.ts:28 `getFileCandidates(sessionId)` 单参）。
- 含义：文件搜索的「路径子串匹配」**完全在 renderer 前端内存过滤**（由匹配引擎做），不是 runtime 查询时过滤。requirements §3 数据清单写「文件树...按相对路径子串匹配（runtime 查询）」措辞有歧义，初稿 §2「经统一子串匹配引擎过滤」实际正确（前端过滤），但 §9 泳道图 `SD --> RT: file.search` 后直接 `SD --> ME: 匹配(合并候选, q)`，未体现「file.search 返回全量 → 前端再过滤」的两段式。
- 建议：明确写出 file.search 返回全量 FileNode[]、子串过滤在 renderer 匹配引擎（与命令/会话的前端内存过滤同处）；泳道图 `file.search` 那条箭头标注「返回全量树」。属事实对齐（K 倾向，但 swimlane 漏了过滤步骤标 F）。这也回应了匹配引擎为何必须提取为纯函数模块（§7 ~40 行）——它承担文件全量结果的前端过滤，不是可有可无。

## Gap 汇总

| gap_id | 类型 | 视角 | 描述 | 建议 |
|--------|------|------|------|------|
| GAP-S1 | D | 1 | `AppCommand` 含 `action:()=>void`（行为闭包）却标「值对象」，与无行为的 RecentEntry 同名不同质 | 改标「命令对象/DTO（含 action 引用）」并说明 action 是注册时注入引用 |
| GAP-S2 | K | 2 | `type-filtered`（Tab 切类）视图态列在 §5 但 stateDiagram-v2 缺其转换，可达性跑不全 | 状态图补 type-filtered 进入/退出，或说明它是 query_results 的修饰态非并列态 |
| GAP-S3 | D | 3 | §6 分层图把命令注册表（store）画进 Service 层且 `CR-->TR` 直连 transport，违反 command.ts:10 的「stores 无外部依赖、跨 store 由 composable 做」铁律，模糊 store/composable/transport 层次 | CR 拆 store（数据持有，无依赖）+ composable（依赖 transport 写回 store）；`CR-->TR` 箭头改经 composable |
| GAP-S4 | K | 3 | §6 分层图漏画 SearchModal/search domain → 命令注册表的读边，命令分组数据源不可见 | 补该读边或说明 search domain 内部聚合命令注册表 |
| GAP-S5 | D | 4 | D-016「同 store 两区」把 app-scope 静态应用命令与 session-scope 动态 slash 命令（不同生命周期/失效语义）揉进一个响应式根，疑似混打包 | D-016 补「两区物理隔离（appCommands ref 与 commandsBySession Map 分开，失效互不影响）」；实现若真混装才标 [REVISIT of D-016] |
| GAP-S6 | F | 4 | `file.search` handler（file-message-handler.ts:67）返回全量 FileNode[] 无服务端子串过滤，子串匹配全在 renderer；§9 泳道图未体现「file.search 返回全量 → 前端过滤」两段式，requirements §3「runtime 查询」措辞歧义 | 泳道图 file.search 箭头标注「返回全量树」；明确前端过滤落点（佐证 match-engine 提取必要性） |

> 无 [REVISIT of D-NNN]：6 项均为初稿偏离/精确度问题，无下游新证据推翻 D-011~D-016。GAP-S5 是对 D-016 实现落点的精确化要求，非回退。
> 无 [CROSS-VALIDATED]：本帧独立扫描，待与建模帧/演进帧交叉汇总。
