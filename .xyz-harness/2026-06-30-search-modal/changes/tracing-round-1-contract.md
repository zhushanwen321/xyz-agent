---
frame: contract
verdict: GAP_FOUND
gap_count: 12
---

# 契约帧追踪 — Round 1

## 审查覆盖

**AC 逐条核对**：issues.md 全部 11 issue 的 AC（AC-1.1~1.4 / AC-2.1~2.4 / AC-3.1~3.6 / AC-4.1~4.10 / AC-5.1~5.3 / AC-6.1~6.9 / AC-7.1~7.15 / AC-8.1~8.6 / AC-9.1~9.4 / AC-10.1~10.2 / AC-17.1~17.3），共 ~50 条 AC 逐一在 §3 签名表 / §4 时序图查找落点。

**时序图调用链核对**：§4 功能 1/2/3/4 共 4 张 mermaid 时序图，逐一核入口→底层每跳方法签名是否存在（含 session 源、file 源、跳转 3 分支、close 守卫）。

**NFR④ 回灌核对**：MR-3.1 / MR-3.2 / MR-3.3 / MR-3.4 / MR-4.1 / MR-4.2 / MR-4.4 / MR-4.5 / MR-6.1 / MR-6.2 / MR-7.1 / MR-8.1 / MR-17.1 共 13 条缓解项，核对是否在签名表/时序图体现。

**类型定义核对**：SearchCtx / JumpCtx / JumpResult / RecentEntry / AppCommand / SearchType / SearchItem / MatchSegment 新增+复用类型。

**源码交叉验证**（用于 F 类判断）：已读 `SearchModal.vue`、`useDetailPane.ts`、`useFileSearch.ts`、`useSidebar.ts`、`stores/session.ts`、`stores/command.ts`、`stores/sidebar.ts`、`api/index.ts`、`api/domains/{session,file,composer}.ts`、`api/mock/search-data.ts`、`shared/src/session.ts`。

---

## 发现的 gap

### GAP-C-1 [F] 时序图「session 源」调用链虚构——session domain 无 list()，session 数据是 server-push 非 WS pull

- **位置**：code-architecture.md §4 功能 2 时序图（L322-327）+ §3 useSearch.query 边界表（L154「session（WS）」）+ query() 签名注释（L138「调...session domain」）
- **问题**：时序图写
  ```
  US->>SES: list()
  SES->>RT: session.list（WS）
  RT-->>SES: SessionGroup[]
  SES-->>US: SessionGroup[]
  ```
  把 session 源画成「useSearch → session domain.list() → transport WS pull」。但源码核查：
  1. `api/domains/session.ts` **只有** `switchSession / getCommands / rename / remove / setThinkingLevel`，**没有 `list()` 函数**——`SES.list()` 是虚构方法，签名表（§3）也无对应行。
  2. session 全量列表的真实来源是 **server-push 广播**：`useSidebar.bindSessionListBroadcast` 调 `events.onGlobalType('session.list', msg => setGroups(msg.payload.groups))`（useSidebar.ts:78-85），数据落 `sessionStore.groups`（stores/session.ts:23-24），`list` 是 `groups.flatMap` 的 computed。
  3. 即 session 源对 useSearch 而言**不是一次 WS 拉取**，而是**读 sessionStore.groups/list**（已由 useSidebar 在 App 启动时订阅广播填充）。
- **证据**：
  - `api/domains/session.ts:49,62,70,78,89`（无 list 导出）
  - `useSidebar.ts:81` `sessionListUnsub = events.onGlobalType('session.list', ...)`
  - `stores/session.ts:23` `groups = ref<SessionGroup[]>([])`，`:31-33` `list = computed(() => groups.flatMap(...))`
- **影响**：① §3 签名表无 `session.list` 方法行却时序图引用，调用链不闭合（orphan）；② 时序图 `par allSettled 并行查 3 源` 把 session 当 WS 源包进 `Promise.race([wsCall, timeout(10s)])`（#17 超时 race），但 session 源是同步读 store 内存，**不应/不能被超时 race 包裹**——否则 race 语义错配（一个永不 reject 的同步读与 10s timeout race，timeout 永不赢）；③ AC-4.3「query 关键词命中跨项目会话」的可达路径（sessionStore.groups）未在契约体现。
- **建议**：修订 session 源为「读 `sessionStore.groups`/`list`（server-push 已填充，内存同步读，与 command 源同属内存源，不进 WS 超时 race）」。时序图删 `SES->>RT` 这一跳，改为 `US->>sessionStore: 读 groups/list`。§3 useSearch.query 注释「调...session domain」改为「读 sessionStore」。这同时让 #17 超时 race 只覆盖 file 源（唯一真 WS pull），语义正确。

---

### GAP-C-2 [F] command store 签名表方法名 `slashCommandsOf` 源码不存在，与自标注矛盾

- **位置**：code-architecture.md §3 stores/command.ts 表（L225）
- **问题**：表格列「方法 `slashCommandsOf(sessionId): ComputedRef<SessionCommand[]>`（沿用现有 commandsOf）」。但：
  1. 源码 `stores/command.ts:61` 实际导出名是 **`commandsOf`**（非 `slashCommandsOf`）；return 块（:84）导出 `{commandsBySession, getCommands, findCommandByName, commandsOf, applyCommands, clearCommands}`，无 `slashCommandsOf`。
  2. 表格自己括号里写「沿用现有 commandsOf」却又把方法名列写成 `slashCommandsOf`——**自相矛盾**，且与源码不符。
  3. `useCommandRegistry.list` 注释（L170）写「读 commandStore 两区」，但「slash 区」读取方法名未定义清楚。
- **证据**：`stores/command.ts:61` `function commandsOf(sessionId: string)`、`:84` return 块。
- **影响**：D-016 两区物理隔离的「slash 区读取入口」契约名错，骨架生成会按 `slashCommandsOf` 写导致与现有 `commandsOf` 重复或编译错；useCommandRegistry.list 调用点 orphan。
- **建议**：统一改为 `commandsOf(sessionId)`（沿用现有名），或显式声明「新增 `slashCommandsOf` 作为 `commandsOf` 的语义别名包装」并说明理由。表头方法名列与括号注释必须一致。

---

### GAP-C-3 [F] `fileApi.read` 签名标注 sessionId 必传，源码是可选参数

- **位置**：code-architecture.md §3 useSearchJump.confirm file 分支表（L194）+ §4 功能 3 时序图（L393）+ JumpCtx 注释（L184）
- **问题**：多处写 `fileApi.read(path, activeSessionId)` 暗示双必传参数，JumpCtx 注释（L184）写「file 跳转需 cwd（AC-6.9 直调 fileApi.read）」并把 activeSessionId 列为跳转必需 ctx。但源码 `api/domains/file.ts:45` 实际签名是 `read(path: string, sessionId?: string)`——**sessionId 可选**。
- **证据**：`api/domains/file.ts:45` `export function read(path: string, sessionId?: string)`
- **影响**：① JumpCtx 定义把 `activeSessionId: string | null` 列为 file 跳转硬依赖，但实际 file.read 不传 sid 也能调（fallback 当前 active）；② AC-6.9 验收措辞「直调 fileApi.read」若骨架按「必传 sid」写，null session 时 file 跳转会 throw 而非走 AC-4.8 降级——与 AC-4.8「无 active session 降级」语义冲突；③ 签名表未列 fileApi.read 的真实签名行，调用链缺叶子签名。
- **建议**：§3 补 `fileApi.read(path, sessionId?)` 真实签名行（标注 sessionId 可选）；JumpCtx 注释改为「file 跳转传 activeSessionId（若非空）以校验 cwd，null 时 file.read fallback」。AC-6.9 措辞补「sessionId 可选」。

---

### GAP-C-4 [F] AC-6.9 提议的「独立 setPreview 方法」源码不存在，绕过吞错层的备选方案无契约支撑

- **位置**：code-architecture.md §3 useSearchJump.confirm AC-6.9 注释（L198）+ §4 功能 3 时序图 file 分支（L395-396）
- **问题**：AC-6.9 注释写「read 成功后再调 useDetailPane 渲染内容（**或用独立 setPreview 方法绕过其加载态**）」，时序图写 `USJ->>UDB: 渲染内容（绕过 openPreview 加载态，或独立 setPreview）」。但源码核查 `useDetailPane.ts` return 块（:145-149）只导出 `{ state, openPreview, toggleView, clearPreview }`——**没有 `setPreview` 方法**。
  - 即「独立 setPreview」是**尚不存在的虚构 API**，契约把它当备选项写却未在 §3 签名表登记为「useDetailPane 需新增 setPreview」的改造项。
- **证据**：`useDetailPane.ts:145-149` `return { state, openPreview, toggleView, clearPreview }`
- **影响**：file 跳转的「read 成功后如何渲染」有两条路径但都无完整契约：① 调 openPreview——但它内部会重新 file.read（重复 IO）+ 有 loading 态闪烁 + 自己 try/catch 吞错（与 AC-6.9「直调 read 校验」目的部分抵消）；② 调 setPreview——不存在。骨架生成会卡。
- **建议**：明确二选一并登记契约。推荐：useSearchJump 直调 `fileApi.read` 校验 → 成功后**直接操作 useDetailPane.state**（暴露的 `state` ref）设 `status='content'`+content，**或** §1 工程目录 + §3 显式登记「useDetailPane 新增 `setPreview(path, content, truncated)` 方法」作为 #6 改造项。当前两可措辞使契约不闭合。

---

### GAP-C-5 [F] useSidebar.selectSession 失败不刷新会话列表——AC-6.6「刷新会话列表」无契约支撑方法

- **位置**：code-architecture.md §3 useSearchJump.confirm session 分支表（L195）+ §4 功能 3 时序图（L404-411）+ §6 T4.5（L557）
- **问题**：session 分支失败处理写「AC-6.6: switch 失败→刷新会话列表」，时序图画 `USJ->>USB: 刷新会话列表`。但源码核查 `useSidebar.selectSession`（useSidebar.ts:152-200）：
  1. 它调 `sessionApi.switchSession(id)`，若 reject 会抛出（useSearchJump 可 catch）；
  2. 但 selectSession **内部不刷新会话列表**——session 列表由 server-push `session.list` 广播驱动（bindSessionListBroadcast），useSidebar 没有任何「主动重拉 session 列表」的方法；
  3. useSidebar return（:440 附近）有 `loadSessions`（:341），但 loadSessions 是 App 启动编排用的全量 hydrate（含 history），**不是「刷新列表」语义**，且签名/副作用过重。
- **证据**：`useSidebar.ts:152` selectSession 体（无刷新列表调用）；`:81` session.list 由广播驱动；`:341` loadSessions 是启动 hydrate。
- **影响**：AC-6.6「session.switch 失败→刷新会话列表」的「刷新」动作在契约层无对应方法签名，时序图 `USB` 上的「刷新会话列表」是 orphan 调用。骨架生成无法落地。
- **建议**：明确「刷新会话列表」的实现路径之一并登记：① 复用 `useSidebar.loadSessions()`（标注「重新触发 session.list 订阅/请求」）；或 ② session 失效靠 server-push 自然更新（selectSession 失败时不主动刷新，仅 toast，等下次 session.list 广播）；或 ③ 新增轻量 `refreshSessionList()`。当前契约未闭合。

---

### GAP-C-6 [K] §3 签名表缺 useFileSearch（缓存读/失效绑定）方法行——AC-4.9/AC-4.10 调用链断

- **位置**：code-architecture.md §3（无 useFileSearch 表）vs §4 功能 2 时序图（L312-321）+ AC-4.9/AC-4.10
- **问题**：时序图功能 2 file 源画 `US->>FSS: get(activeSessionId)`、`US->>FSS: set(activeSessionId, nodes)`，且 AC-4.10 要求「search 消费缓存时须自绑 `useFileSearch.setupInvalidation` watch」。但：
  1. §3 签名表**只有** match-engine / useSearch / useCommandRegistry / useSearchJump / useRecents / command store / api.index 七个模块表，**没有 useFileSearch / fileSearchStore 表**——`get`/`set`/`setupInvalidation`/`invalidate` 这些被时序图和 AC 引用的方法，在签名表无对应行。
  2. 时序图 `US->>FSS: get` 把 FSS 当 fileSearch**Store**（stores/fileSearch.ts 的 get/set），但 AC-4.10 的 `setupInvalidation` 是 useFileSearch **composable**（features/useFileSearch.ts:65）的方法——时序图混用了 store 与 composable 两个不同模块（都叫 FSS），调用链归属不清。
- **证据**：§3 无 useFileSearch/fileSearchStore 表；`stores/fileSearch.ts:26,31,36` get/set/invalidate；`features/useFileSearch.ts:65` setupInvalidation、`:32` load。
- **影响**：① AC-4.10「自绑 setupInvalidation watch」是 NFR④ 回灌（MR-4.4）的硬约束，但 setupInvalidation 签名/调用方式在 §3 无落点，骨架无法生成；② 时序图 FSS 节点身份歧义（store vs composable）；③ useSearch 内部到底调 `useFileSearchStore.get` 还是经 `useFileSearch.load`（后者吞错，AC-4.5 禁止）——时序图缓存命中走 store.get（对），缓存未命中走 composer.getFileCandidates（对，绕开 load 吞错），但这一关键区分未在签名表固化为契约。
- **建议**：§3 补 fileSearchStore 表（get/set/invalidate，叶子）+ useFileSearch composable 表（setupInvalidation，标注「AC-4.10 useSearch 须自绑」）。时序图区分 `fileSearchStore` 与 `useFileSearch` 两个 participant。

---

### GAP-C-7 [K] §3 签名表缺 sessionStore 读取方法行——AC-4.3/4.8 session 源调用链断（与 GAP-C-1 联动）

- **位置**：code-architecture.md §3（无 sessionStore 表）vs AC-4.3/4.8 + §4 功能 2 session 源
- **问题**：依 GAP-C-1，session 源真实路径是读 `sessionStore.groups/list`。但 §3 无 sessionStore 表，`groups`/`list`/`activeId` 这些被 useSearch 读取的字段无契约行。session 源的 DTO 映射（SessionSummary → SearchItem，D-025）也无落点。
- **证据**：`stores/session.ts:23,31,43` groups/list/activeId。
- **影响**：session 源调用链从 useSearch 到底层断在 sessionStore（无签名行）；DTO 映射（label/cwd/gitBranch → sub，requirements:137/192）的输入字段来源未契约化。
- **建议**：§3 补 sessionStore 表（groups/list/activeId，只读 ref/computed，标注「useSearch 读 groups 做 session 源 DTO 映射」）。与 GAP-C-1 一并修订。

---

### GAP-C-8 [K] useCommandRegistry.list 返回类型 `AppCommand[] | SessionCommand[]` 是联合类型，无法表达「统一列表」

- **位置**：code-architecture.md §3 useCommandRegistry.list 签名（L170）
- **问题**：签名写 `list(): AppCommand[] | SessionCommand[]`——TS 联合类型语义是「返回 AppCommand[] **或** SessionCommand[]（二选一）」，而注释和 AC-2.1 要求「聚合返回应用命令 + slash 命令**统一列表**」。两者矛盾：联合类型不能表达「两类混合的统一列表」，消费方（useSearch 合并候选）拿到 `AppCommand[] | SessionCommand[]` 无法 map 成统一 SearchItem。
  - AppCommand（`{id,name,shortcut?,action}`）与 SessionCommand（command.ts:21 的形态）字段不同构，混合需要统一基类型或 mapped 类型。
- **证据**：签名表 L170 联合类型；§5 注释 L228 AppCommand 模型；issues AC-2.1「统一列表」。
- **影响**：useSearch.query 把命令源转 SearchItem 时，类型系统无法推导；DTO 映射缺统一输入类型契约。
- **建议**：改为统一形态，如 `list(): Array<AppCommand | SessionCommand>`（仍混合但显式）或定义 `UnifiedCommand` 映射类型（{type:'app'|'slash', name, ...}）。Deep Module「return results」原则要求返回类型可消费。

---

### GAP-C-9 [K] MatchSegment 类型定义缺失——segments 返回类型未定义字段

- **位置**：code-architecture.md §3 match-engine.segments 签名（L130）返回 `MatchSegment[]`
- **问题**：`segments(text, q): MatchSegment[]` 引用 `MatchSegment` 类型，但全文（§3 + §5 + 类型定义块）**未定义 MatchSegment 接口**。现 SearchModal.vue 局部用的是 `{text:string; hit:boolean}[]`（inline），提取为 lib 后应定义具名类型，但契约未登记。
- **证据**：§3 L130 返回 MatchSegment[]；全文 grep 无 `interface MatchSegment` / `type MatchSegment`；现 SearchModal.vue:139 inline `{text:string;hit:boolean}`。
- **影响**：lib/match-engine 导出类型 orphan；消费方（SearchModal 模板 `<mark v-if="seg.hit">`）依赖 `hit` 字段名，若骨架随意命名（如 `isMatch`）破坏渲染契约。
- **建议**：§3 补 `interface MatchSegment { text: string; hit: boolean }`（与现有 inline 形态对齐，BC-4 等价）。

---

### GAP-C-10 [K] useSearch.query 返回 `Section[]` 但 Section 类型定义散落，且与现 remoteSections 形态不一致

- **位置**：code-architecture.md §3 useSearch.query 返回 `Promise<Section[]>`（L138）
- **问题**：query 返回 `Section[]`，但 §3 未集中定义 `Section` 接口。现 SearchModal.vue:117 `remoteSections = ref<{ label: string; items: SearchItem[] }[]>`（inline），issues #4 方案 A 提「Section 结构为 label + items:SearchItem[]」。契约应显式定义 Section 具名类型并标注 label 取值枚举（「最近」/「建议命令」/「命令」/「文件」/「符号」/「会话」）。
  - 另：空查询返回「recents 分组 + 建议命令分组」（功能 1），非空返回「四类分组」，两组场景的 label 集合不同——契约未说明 label 命名规则，骨架可能写出不一致 label 导致 AC-7.13（两种空态区分）难验。
- **证据**：§3 L138 Section[] 无定义；SearchModal.vue:117 inline；issues #4 方案 A。
- **影响**：useSearch 与 SearchModal 间的数据契约（Section 形态）未类型化；渲染层 label 匹配无契约约束。
- **建议**：§3 补 `interface Section { label: string; items: SearchItem[] }` + label 枚举常量（RECENTS_LABEL / SUGGESTED_LABEL / 各类型 label），与 AC-7.13 空态文案对齐。

---

### GAP-C-11 [K] NFR④ MR-4.1「loadSeq 字段」在签名表仅以代码块示例体现，未固化为契约字段

- **位置**：code-architecture.md §3 useSearch.query「内部不变式 loadSeq」代码块（L161-164）vs MR-4.1（nfr 回灌=骨架约束）
- **问题**：MR-4.1 要求「loadSeq 字段 + 守卫逻辑存在于 search domain（现 useSearch）query() 内部，⑤骨架 tsc 验证存在」。当前 §3 用一段 ts 代码块示例（`let loadSeq = 0; ... if (seq !== loadSeq) return`）描述，但：
  1. 它不在签名表的方法行内（不是 query 的可见契约），而是散文式代码块；
  2. §9 骨架覆盖核验清单（L627-638）列了 10 个公开方法，**未包含 loadSeq 字段**作为核验项——尽管 MR-4.1 是「骨架约束」验收方式。
  3. D-022 明确「loadSeq 是字段存在性约束（骨架 tsc 验证）」，但 §9 未把 loadSeq 列入需双向核验的字段清单。
- **证据**：§3 L161-164 代码块；§9 L627-638（10 方法无 loadSeq）；nfr MR-4.1 + decisions D-022。
- **影响**：MR-4.1（骨架约束）的核验落点在 §9 缺失，Step 7 骨架生成后可能漏验证 loadSeq 字段存在性。
- **建议**：§9 骨架核验清单补一行「useSearch 模块级 `loadSeq` 字段存在（tsc 验证，MR-4.1/D-022）」。或将 loadSeq 从散文代码块提升为 §3 useSearch 模块的字段契约行。

---

### GAP-C-12 [D] useSearch.query 把 recents 源（空查询）与命令/文件/session 源（非空查询）揉在同一 query()，但签名表未说明空/非空分支的返回契约差异（可逆，建议）

- **位置**：code-architecture.md §3 useSearch.query 边界表（L150-158）
- **问题**：query() 一个入口承担两种语义截然不同的返回：① 空查询→「recents + 建议命令」分组（功能 1，纯内存/localStorage，无 WS）；② 非空→「四类命中」分组（功能 2，含 WS race）。边界表列了两种场景但 `query(q, ctx): Promise<Section[]>` 单一签名掩盖了内部「空查询走 useRecents.read + useCommandRegistry.list / 非空走 allSettled 3 源」的分叉。
  - 这本身不违法（Deep Module 允许内部分叉），但契约层对消费方（SearchModal）而言，返回的 Section[] 在两种场景下 label 集合/语义不同（见 GAP-C-10），消费方需知道「空查询不会返回 file/session 分组」——此约束未在签名/边界表显式声明。
- **证据**：§3 query 边界表 L150-158；功能 1 vs 功能 2 时序图。
- **影响**：可测性「return results」原则下，消费方对返回形态的预期需契约锁定，否则 AC-7.13（空态区分）/T1.1（空查询显 recents+建议命令）验收时消费方逻辑无依据。
- **建议**（D-可逆）：边界表补一行契约声明「q='' 时返回的 Section[] 仅含 {label:'最近', items:recents} + {label:'建议命令', items:appCommands}，不含 file/session/symbol 分组；q≠'' 时返回四类分组（空组过滤）」。无需拆分 query 为两个方法（保持 Deep Module 单入口）。

---

## 收敛判定

**GAP_FOUND**（12 条：F×5 + K×6 + D×1）

阻断性最高的是 **GAP-C-1**（session 源调用链虚构 + 连带 #17 超时 race 语义错配）和 **GAP-C-6/C-7**（fileSearch/sessionStore 缺签名表致 AC-4.9/4.10/4.3 调用链断）——这三条直接破坏「时序图入口到底层每跳有方法签名」的契约闭合硬要求，且 F 类可源码验证。

其次 **GAP-C-2/C-3/C-4/C-5**（command store 方法名、fileApi.read 可选参、setPreview 虚构、刷新会话列表 orphan）是 F 类事实错误，骨架生成会直接卡或写错。

**GAP-C-8/9/10/11** 是 K 类完整性缺口（联合类型、MatchSegment/Section/loadSeq 未契约化），影响可测性与类型闭合但不阻断主链。

**GAP-C-12** 是 D-可逆设计建议，不阻断。

**未发现违反 D-026**：全文一致遵循「search 编排归 useSearch.ts，不新建 api/domains/search.ts」，无 gap 把编排重塞回 domain。

**契约覆盖正面结论**：AC-1.x/2.x/3.x/5.x/7.x/8.x/9.x/10.x/17.x 在签名表/时序图落点齐全；NFR④ MR-3.1/3.2/3.3/6.2/7.1/8.1/17.1 回灌到位；Deep Module 三原则对 match-engine/useRecents 满足。问题集中在 session/file 源的真实数据流（server-push vs pull、store vs domain）与若干虚构/错名方法签名。
