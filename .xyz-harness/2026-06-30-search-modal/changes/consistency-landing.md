---
dimension: landing
verdict: INCONSISTENT
---

> 独立一致性终检（组 4：落地审计组）。维 5 NFR 回灌闭环 + 维 6 骨架↔文档一致，合并执行。
> 审计对象：④non-functional-design.md（缓解项回灌登记表）/ ⑤code-architecture.md（§3 签名表 + §6 test-matrix + §9 骨架核验）/ ③issues.md / ⑥execution-plan.md / code-skeleton/src/ 7 个骨架文件。

## Verdict

**INCONSISTENT** — 维 5 NFR 回灌闭环 **基本闭合**（13 缓解项全部落地、6 条全链闭环全通），维 6 骨架↔文档存在 **6 处矛盾**（1 处签名实质冲突 + 2 处依赖图遗漏 + 1 处目录/Wave 缺失 + 1 处骨架验证副作用悬空 + 1 处签名轻微偏差）。其中 **#1（useRecents.read 返回类型）是 §3 签名表与骨架 + §4 时序图自相矛盾的实质问题**，须修文档。

## 维5 NFR 回灌闭环（逐缓解项）

| 缓解项 | 验收方式 | 去向落地 | ⑤字段/用例 | 骨架 stub | ⑥Wave | 闭环 |
|--------|---------|---------|-----------|----------|-------|------|
| MR-3.1 try/catch 降级 | 代码测试 | ⑤test-matrix ✅ | T1.16（⑤§6:592）✅ | useRecents.ts:35-37 JSON.parse catch→[] ✅ | Wave1 T1.16（⑥:124,402）✅ | ✅ |
| MR-3.2 key 命名空间 | 骨架约束 | ⑤骨架约束 ✅ | ⑤§3 useRecents 注释:217 ✅ | search-types.ts:58 `xyz-agent:search-recents` + useRecents.ts:30 引用 ✅ | Wave1 ✅ | ✅ |
| MR-3.3 配额满内存态保留 | 代码测试 | ⑤test-matrix ✅ | T1.17（⑤§6:593）✅ | useRecents.ts:56-59 配额 catch 不回滚 ✅ | Wave1 T1.17（⑥:124,403）✅ | ✅ |
| MR-3.4 FIFO 淘汰时机 | 代码测试 | ⑤test-matrix ✅ | T1.18（⑤§6:594）✅ | useRecents.ts:49(去重)/53(计数器)/54(淘汰) ✅ | Wave1 T1.18（⑥:124,404）✅ | ✅ |
| MR-4.1 loadSeq 守卫迁移 | 骨架约束 | ⑤骨架约束 ✅ | ⑤§3 useSearch:161-165 ✅ | useSearch.ts:41 `let loadSeq`/50 `++loadSeq`/70 `seq!==loadSeq` ✅ | Wave2 ✅ | ✅ |
| MR-4.2 单源 reject 静默 | 代码测试 | ⑤test-matrix ✅ | T3.3,T4.9（⑤§6:595）✅ | useSearch.ts:73-75 rejected 取空 ✅ | Wave2 T3.3(⑥:172)/T4.9(⑥:173) ✅ | ✅ |
| MR-4.3 文件截断提示 | 代码测试 | ③#4 AC-4.7 ✅ | —（已在③）| useSearch 注释占位（截断逻辑实现期填）⚠ | Wave2 T3.5 ✅ | ✅ |
| MR-4.4 缓存失效竞态 | 代码测试 | ③#4 新 AC-4.10 ✅（issues:394） | T3.9（⑤§6:596）✅ | useSearch.ts:92 setupInvalidation **仅注释占位，无实际 watch 绑定** ⚠ | Wave2 T3.9（⑥:172）✅ | ✅（stub 偏薄，见维6 #5） |
| MR-4.5 error 冒泡链 | 代码测试 | ③#4 AC-4.5 ✅ | —（已在③）| useSearch.ts:104 直调 composerApi.getFileCandidates ✅ | Wave2 T3.3 ✅ | ✅ |
| MR-6.1 跳转失败 toast | 代码测试 | ③#6 AC-6.5/6.6/6.7/6.8 ✅ | —（已在③）| useSearchJump.ts:55/74/86 catch→{ok:false} ✅ | Wave2 ✅ | ✅ |
| MR-6.2 file 跳转吞错层 | 代码测试 | ③#6 新 AC-6.9 ✅（issues:515） | ⑤§3 confirm file 分支:197 ✅ | useSearchJump.ts:68 `await fileApi.read`（不经 openPreview）✅ | Wave2 T3.4 ✅ | ✅ |
| MR-7.1 debounce+孤儿守卫 | 代码测试 | ③#7 AC-7.14/7.15 ✅ | ⑤骨架验证副作用:295 标 SearchModal stub | **SearchModal.vue 不在骨架中**（骨架仅 7 个新建/扩展文件）⚠ | Wave3 T1.14 ✅ | ⚠（见维6 #4） |
| MR-8.1 loading setTimeout 清理 | 代码测试 | ③#8 AC-8.4 ✅ | —（已在③）| SearchModal 不在骨架（改造项）⚠ | Wave3 ✅ | ⚠（同 #4） |
| MR-17.1 WS 源超时 race | 代码测试 | ③#17 ✅（issues:746-805, AC-17.1:803） | T4.8（⑤§6:597）✅ | useSearch.ts:123-135 withWsTimeout + :104/:113 引用 ✅ | Wave2 T4.8（⑥:173）✅ | ✅ |

**全链闭环核查（6 条 `验收方式=代码测试` → ⑤§6 来源B → ⑥Wave）：**
- MR-3.1 → T1.16 → Wave1 ✅
- MR-3.3 → T1.17 → Wave1 ✅
- MR-3.4 → T1.18 → Wave1 ✅
- MR-4.2 → T3.3/T4.9 → Wave2 ✅
- MR-4.4 → T3.9 → Wave2 ✅
- MR-17.1 → T4.8 → Wave2 ✅

**④回灌到③的新 issue #17 实际出现**：issues.md #17（:746-805）实际存在，AC-17.1/17.2/17.3 三条 AC 齐全 ✅。③#4 新 AC-4.10（:394）/ #6 新 AC-6.9（:515）也实际出现 ✅。

**维 5 结论**：13 缓解项去向全部落地（⑤test-matrix 4 + ⑤骨架约束 2 + ③issues 7），6 条代码测试全链闭环全通，#17 新 issue 真实存在。唯一缺口是 MR-7.1/MR-8.1/MR-4.4 的副作用验证依赖 SearchModal 骨架 stub（见维6 #4/#5）。

## 维6 骨架↔文档（逐方法签名 + import + 叶子→Wave）

### 逐方法签名核对（§3 签名表 ↔ 骨架）

| §3 方法 | §3 签名 | 骨架签名 | 一致性 |
|---------|---------|----------|--------|
| match-engine.matchFilter | `matchFilter(items: SearchItem[], q): SearchItem[]`（:130） | `matchFilter<T extends {title:string;sub:string}>(items: T[], q): T[]`（:29） | ⚠ 见#6（泛型化，结构兼容） |
| match-engine.segments | `segments(text, q): MatchSegment[]`（:131） | `segments(text: string, q: string): MatchSegment[]`（:50） | ✅ 完全一致 |
| useSearch.query | `query(q, ctx: SearchCtx): Promise<Section[]>`（:139） | `async function query(q: string, ctx: SearchCtx): Promise<Section[]>`（:49） | ✅ 一致 |
| useCommandRegistry.list | `list(): AppCommand[] \| SessionCommand[]`（computed 包装）（:171） | `function list(): ComputedRef<UnifiedCommand[]>`（:29） | ⚠ 见#7（文档类型不精确） |
| useCommandRegistry.registerApp | `registerApp(cmds: AppCommand[]): void`（:172） | `function registerApp(cmds: AppCommand[]): void`（:41） | ✅ 一致 |
| useSearchJump.confirm | `confirm(item: SearchItem, ctx: JumpCtx): Promise<JumpResult>`（:180） | `async function confirm(item: SearchItem, ctx: JumpCtx): Promise<JumpResult>`（:33） | ✅ 一致 |
| useRecents.read | `read(): SearchItem[]`（:203） | `function read(): RecentEntry[]`（:28） | ❌ 见#1（实质冲突） |
| useRecents.write | `write(entry: RecentEntry): void`（:204） | `function write(entry: RecentEntry): void`（:45） | ✅ 一致 |
| command.appCommands | `appCommands: Ref<AppCommand[]>`（:222） | `const appCommands = ref<AppCommand[]>([])`（:43） | ✅ 一致 |
| command.slashCommandsOf | `slashCommandsOf(sessionId): ComputedRef<SessionCommand[]>`（:228） | `function slashCommandsOf(sessionId: string)` → commandsOf computed（:60） | ✅ 一致 |
| command.registerApp | `registerApp(cmds: AppCommand[]): void`（:229） | `function registerApp(cmds: AppCommand[]): void`（:83） | ✅ 一致 |

**§9 骨架覆盖核验表**：10/10 方法有对应行，无 ❌ 未定义。但 §9 标 useRecents.read 为 `✅ 签名(叶子)` 未发现返回类型冲突（§9 自称双向核验，实际漏掉 #1）。

### import 关系核对（§2 包依赖图 ↔ 骨架）

| 边 | §2 图 | 骨架 import | 一致性 |
|----|-------|-------------|--------|
| ME→（无依赖）| 独立 ✅ | match-engine.ts 无 import ✅ | ✅ |
| US→ME | :97 ✅ | useSearch.ts:22 import matchFilter ✅ | ✅ |
| US→CS | :98 ✅ | 经 useCommandRegistry 间接（骨架未直 import commandStore）⚠ | ⚠ 见#3 |
| US→UCR | **缺失** | useSearch.ts:28 `import { useCommandRegistry }` + :37/:55 调 list() | ❌ 见#2 |
| US→UR | **缺失** | useSearch.ts:29 `import { useRecents }` + :38/:54 调 read() | ❌ 见#2 |
| US→FSS | :98 ✅ | useSearch.ts:30 import useFileSearchStore ✅ | ✅ |
| US→CMP | :99 ✅ | useSearch.ts:31 `composer as composerApi` + :104 getFileCandidates ✅ | ✅ |
| US→SES | :100 ✅ | useSearch.ts:31 `session as sessionApi` + :113 list() ✅ | ✅ |
| UCR→CS | :102 ✅ | useCommandRegistry.ts:14 import useCommandStore ✅ | ✅ |
| USJ→CMP | :103 | 骨架未直 import（注释标"实现期填"）⚠ | ⚠ 占位 |
| USJ→SES | :104 | 骨架未直 import（实现期填）⚠ | ⚠ 占位 |
| USJ→FIL | :105 ✅ | useSearchJump.ts:22 `file as fileApi` + :68 read() ✅ | ✅ |
| USJ→UR | :106 ✅ | useSearchJump.ts:23 import useRecents + :27/:99 write() ✅ | ✅ |

### 叶子作用域 → Wave 映射

| 骨架文件 | 类型 | §1 目录 | ⑥文件→Wave 映射 | 一致性 |
|---------|------|---------|----------------|--------|
| lib/match-engine.ts | 新建 | :18 ✅ | Wave1 #1（⑥:63）✅ | ✅ |
| composables/features/useCommandRegistry.ts | 新建 | :22 ✅ | Wave1 #2（⑥:64）✅ | ✅ |
| composables/features/useRecents.ts | 新建 | :24 ✅ | Wave1 #3（⑥:66）✅ | ✅ |
| composables/features/useSearch.ts | 新建 | :21 ✅ | Wave2 #4（⑥:67）✅ | ✅ |
| composables/features/useSearchJump.ts | 新建 | :23 ✅ | Wave2 #6（⑥:68）✅ | ✅ |
| stores/command.ts | 扩展 | :26 ✅ | Wave1 #2（⑥:65）✅ | ✅ |
| **lib/search-types.ts** | **新建（Tier 0 类型）** | **缺失** | **缺失** | ❌ 见#5 |

**无骨架代码没被 Wave 覆盖**：除 search-types.ts 外，其余 6 文件均映射到 Wave。search-types.ts 是 7 文件中唯一既不在 §1 目录、也不在 ⑥ 文件影响表的叶子（见#5）。

## 矛盾清单

**共 6 处矛盾（1 ❌ 实质 + 5 ⚠）。**

---

### #1 ❌ [⑤§3 签名表 ↔ 骨架 + ⑤§4 时序图] useRecents.read 返回类型三处不一致

- **涉及**：⑤code-architecture.md §3（:203）+ §4 功能1 时序图（:265）+ code-skeleton/src/composables/features/useRecents.ts（:28）+ useSearch.ts（:54）
- **描述**：
  - §3 签名表：`read(): SearchItem[]`（:203）
  - §4 时序图：`UR-->>US: RecentEntry[]（≤20）`（:265）
  - 骨架：`function read(): RecentEntry[]`（:28），且 useSearch.ts:54 `mapRecentsToItems(recents.read())` 把 RecentEntry[] 映射成 SearchItem[]
  - §9 核验表（:654）标 useRecents.read `✅ 签名(叶子)` 未发现此冲突
- **真相**：骨架返回 `RecentEntry[]`（持久化 DTO）是正确设计——read 读 localStorage 原始结构，由 useSearch 做 DTO→SearchItem 映射。§4 时序图与骨架一致，**§3 签名表的 `SearchItem[]` 是错的**，且 §9 自称双向核验却漏过。
- **建议**：修 ⑤§3 useRecents.read 签名为 `read(): RecentEntry[]`（与 §4 时序图 + 骨架对齐）；§9 补注返回类型已核。

---

### #2 ⚠️ [⑤§2 包依赖图 ↔ 骨架] 依赖图遗漏 US→UCR 和 US→UR 两条边

- **涉及**：⑤code-architecture.md §2 包依赖图（:89-100）+ code-skeleton/src/composables/features/useSearch.ts（:28-29, :37-38, :54-55）
- **描述**：§2 图 US 节点仅画 5 条出边（→ME/CS/FSS/CMP/SES，:96-100），**未画 US→UCR 和 US→UR**。但骨架 useSearch.ts 同时 import useCommandRegistry（:28）和 useRecents（:29），并在 query() 内部调用 `commandRegistry.list()`（:55）和 `recents.read()`（:54）。⑤§3 useSearch 模块说明（:147）也明确"命令源由 useSearch 内部调 useCommandRegistry.list()""recents 源由 useSearch 内部调 useRecents.read()"——文字承认依赖，图却漏画。
- **建议**：⑤§2 包依赖图补 `US --> UCR` 和 `US --> UR` 两条边（composable 层内部编排聚合，符合 §2 "composables/features/* 可 import stores + api/domains + lib" 规则）。

---

### #3 ⚠️ [⑤§2 包依赖图 ↔ 骨架] US→CS 边骨架未直连（经 UCR 间接）

- **涉及**：⑤§2 图（:98 `US --> CS`）+ useSearch.ts（无直 import commandStore）
- **描述**：§2 图画 US→CS 直边，但骨架 useSearch.ts 未直接 import commandStore——它经 useCommandRegistry（UCR）间接读 commandStore。这是 #2 的连带效应：US 实际依赖 UCR（聚合 CS），而非直连 CS。
- **建议**：与 #2 合并修订——补 US→UCR 后，US→CS 可保留为"逻辑依赖"或标注"经 UCR"。非阻断，依赖图语义可接受。

---

### #4 ⚠️ [④需⑤骨架验证的副作用 ↔ 骨架] SearchModal 相关骨架 stub 全部悬空

- **涉及**：④non-functional-design.md「需⑤骨架验证的副作用」表（:292, :295）+ ⑤§9 骨架核验 + code-skeleton/src/（无 SearchModal.vue）
- **描述**：④骨架验证副作用表列 3 条 SearchModal 相关 stub 落点：
  - "debounce + loadSeq 协同" → "⑤骨架 SearchModal watch query 含 debounce"（:292）
  - "close 触发孤儿查询守卫（G1）" → "⑤骨架 SearchModal loadResults 含 open flag 守卫"（:295）
  - （MR-7.1/MR-8.1 也指向 SearchModal 改造点）
  
  但 **code-skeleton/src/ 不含 SearchModal.vue**（骨架仅 6 个新建 composable/lib + 1 个扩展 store，SearchModal 是【改造】项未生成骨架）。这 3 条副作用验证在骨架阶段无法 stub 验证，§9 骨架核验表（:644-657）也只覆盖 §3 的 10 个方法（无 SearchModal 方法行）。
- **影响**：debounce/loadSeq 协同、close 孤儿守卫、loading setTimeout 清理的骨架级验证承诺悬空，只能推迟到 Wave3 实现期验证（⑥ Wave3 覆盖 T1.13/T1.14/T3.7/T3.8）。
- **建议**：要么 ⑤补 SearchModal.vue 骨架 stub（满足④承诺），要么 ④/⑤显式标注"SearchModal 改造项的骨架验证降级为 Wave3 实现期 tsc+测试验证"（承认降级，不留悬空承诺）。当前是隐式降级，建议显式化。

---

### #5 ⚠️ [⑤§1 工程目录 + ⑥文件→Wave 映射 ↔ 骨架] search-types.ts 叶子作用域未登记/未映射 Wave

- **涉及**：⑤code-architecture.md §1 工程目录（:16-46）+ ⑥execution-plan.md 文件冲突分析（:63-71）+ code-skeleton/src/lib/search-types.ts（存在）
- **描述**：骨架实际有 7 个文件，其中 `lib/search-types.ts`（Tier 0 共享类型：AppCommand/RecentEntry/Section/SearchCtx/JumpCtx/JumpResult + RECENTS_STORAGE_KEY/WS_SOURCE_TIMEOUT_MS/RECENTS_PER_TYPE 常量）是 5 个模块（useRecents/useSearch/useCommandRegistry/useSearchJump/command）的共同依赖。但：
  - **⑤§1 工程目录未列 `lib/search-types.ts`**（:16-46 只列 lib/match-engine.ts）
  - **⑥文件冲突分析未列 search-types.ts**（:63-71 无此行，故无 Wave 归属）
  - 它是 7 文件中唯一无 Wave 映射的叶子
- **影响**：search-types.ts 是基础类型文件，被 Wave1（useRecents/command/useCommandRegistry）和 Wave2（useSearch/useSearchJump）共用——若 Wave1 三个并行 subagent 各自需要它，无明确归属会产生"谁创建"的协调歧义。
- **建议**：① ⑤§1 目录补 `lib/search-types.ts`（标注【新建】Tier 0 共享类型/常量）；② ⑥文件冲突分析补一行，归属 Wave1（最先创建，或单列"Wave0 类型前置"）；③ 因被多 Wave 共用，建议 ⑥调度表注明 search-types.ts 须在 Wave1 任意 subagent 启动前先落地（或由 #1/#2/#3 共享创建契约）。

---

### #6 ⚠️ [⑤§3 签名表 ↔ 骨架] matchFilter 签名泛型化（轻微，结构兼容）

- **涉及**：⑤code-architecture.md §3 matchFilter（:130）+ code-skeleton/src/lib/match-engine.ts（:29）
- **描述**：§3 签名 `matchFilter(items: SearchItem[], q: string): SearchItem[]`，骨架 `matchFilter<T extends { title: string; sub: string }>(items: T[], q: string): T[]`。骨架用泛型约束（任一含 title/sub 的对象），比文档的 SearchItem[] 更通用。结构上 SearchItem 满足约束（含 title/sub），调用兼容；但签名形态与文档不符。
- **建议**：轻微偏差，可选——要么 ⑤§3 签名改为泛型形式（反映骨架真实签名），要么骨架收窄为 `SearchItem[]`（对齐文档）。功能无影响，优先级低。

---

### #7 ⚠️ [⑤§3 签名表 ↔ 骨架] useCommandRegistry.list 返回类型文档不精确（轻微）

- **涉及**：⑤code-architecture.md §3 useCommandRegistry.list（:171）+ useCommandRegistry.ts（:29）
- **描述**：§3 签名 `list(): AppCommand[] | SessionCommand[]`（computed 包装）——`AppCommand[] | SessionCommand[]` 字面是"纯 AppCommand 数组 或 纯 SessionCommand 数组"（union of arrays），但实际语义是"混合数组"。骨架返回 `ComputedRef<UnifiedCommand[]>` = `ComputedRef<(AppCommand | SessionCommand)[]>`（array of union），语义更准确。§3 已注"computed 包装"，骨架确实包了 ComputedRef，这点一致。
- **建议**：轻微，可选——⑤§3 签名改 `(AppCommand | SessionCommand)[]` 或 `UnifiedCommand[]` 消除歧义。功能无影响。

---

## 总结

- **维 5（NFR 回灌闭环）**：✅ 基本闭合。13 缓解项全落地，6 条代码测试全链闭环（MR→T→Wave）全通，#17 新 issue 真实存在。MR-7.1/MR-8.1/MR-4.4 的骨架验证承诺因 SearchModal 缺骨架而部分悬空（归入维6 #4）。
- **维 6（骨架↔文档一致）**：⚠️ 6 处矛盾。1 处实质（#1 useRecents.read 返回类型，§3 与 §4+骨架自相矛盾，须修文档），2 处依赖图遗漏（#2 US→UCR/UR），1 处目录/Wave 缺失（#5 search-types.ts），1 处骨架验证副作用悬空（#4 SearchModal），2 处签名轻微偏差（#6/#7）。
- **阻断项**：#1（签名实质冲突）建议修 ⑤§3 后再进编码；#2/#5 影响实现期协调清晰度，建议修；#4 建议显式降级；#6/#7 可选。
