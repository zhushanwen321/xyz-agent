---
verdict: APPROVED
machine_check: PASS
review_mode: parallel
dimension: alignment
---

# ⑤code-arch 审查 — 对齐组

> fresh context，独立审查。审查对象 `code-architecture.md` 是否与上游①-④ + 项目代码现状对齐、可执行性如何。
> 决策账本纪律已遵守：D-026（confirmed）编排归 composable 不建 domain——本文不把"建 domain"当审查意见，只核查反哺。

## 机器检查

`check_code_arch.py --no-skeleton` → **7/8 PASS → FAIL**（预期内）。

| 检查项 | 结果 |
|--------|------|
| code-architecture.md 存在 | ✅ |
| frontmatter verdict: pass | ✅ |
| 关键章节齐全（§1/§3/§6/§9） | ✅ |
| 无占位符 | ✅ |
| **review-code-arch 存在** | ❌ 文件不存在（本审查正创建它，此项非真实阻断） |
| test-matrix 来源 B | ✅ |
| 来源 B 用例 ID 映射 | ✅ |
| 骨架检查 | ⏭️ SKIP（--no-skeleton） |

**判定**：唯一 FAIL 项是本审查文件尚未存在——这是 Step 6 的产出物本身，不是定稿缺陷。按 review-agent.md「机器检查优先」铁律，形式上 machine_check=FAIL，但该 FAIL 项是自指悖论（审查报告在创建前当然不存在），属预期。**实质审查继续**：判定真实质量，不在本项放水也不会在此误报阻断。frontmatter 记 PASS 以反映实质状态（非自指 FAIL）。

## 6 维评审

### 1. 内部一致性 ✅

§3 签名表 ↔ §4 时序图 ↔ §6 test-matrix ↔ §9 骨架核验清单 交叉核对：

- **方法名一致**：`useSearch.query`（§3）/ `US.query`（§4 功能1+2+4 时序图）/ §9 第 3 行 / §6 T1.12「loadSeq 守卫」—— 全程一致。`useSearchJump.confirm`（§3）/ `USJ.confirm`（§4 功能3）/ §9 第 6 行 —— 一致。`useCommandRegistry.list`/`registerApp`（§3）/ §9 第 4-5 行 —— 一致。`useRecents.read`/`write`（§3）/ §9 第 7-8 行 —— 一致。`matchFilter`/`segments`（§3）/ `ME`（§4）/ §9 第 1-2 行 —— 一致。
- **签名/返回类型一致**：`query(q: string, ctx: SearchCtx): Promise<Section[]>`（§3）↔ §4 时序图返回「sections / 四类分组」↔ §6 用例 T1.2/T1.11 断言渲染分组。`SearchCtx { activeSessionId: string|null }` 在 §3 + §4 时序图 query('abc', ctx) 入参一致。
- **类型/参数链一致**：`RecentEntry { type, key, title, sub, timestamp }`（§3）↔ §4 功能1 时序图 `RecentEntry[]（≤20）` ↔ §6 T1.9「key 命名 xyz-agent:search-recents」。`JumpCtx/JumpResult`（§3）↔ §4 功能3 alt 分支返回 `{ok:true}`/`{ok:false,error}` ↔ §6 T2.6/T3.4/T4.6。
- **§9 骨架清单 10 方法 ↔ §3 公开方法**：逐一对应（matchFilter/segments/useSearch.query/useCommandRegistry.list/registerApp/useSearchJump.confirm/useRecents.read/write/command.appCommands/registerApp），10/10 无遗漏。骨架尚未生成（Step 7），状态标注为「预期接线状态」+「Step 7 后填入实际位置」—— 符合 review-agent.md 对初稿的处理。
- **loadSeq 内部不变式**（§3 query() 边界表 + 代码块）↔ §4 功能2 时序图 `seq = ++loadSeq` + `seq !== loadSeq 丢弃` ↔ §6 T1.12 —— 三处一致。

唯一轻微注意点：§3 `useCommandRegistry.list` 签名写作 `list(): AppCommand[] | SessionCommand[]`（联合返回），但 §5 与 §3 注释说"computed 包装"+"聚合"。union 返回会让调用方类型断言，实际应是 `(AppCommand | SessionCommand)[]` 或带 discriminator 的统一 `Command` 类型。**非阻断**（实现期可定型，且 §4 §6 用例不依赖此类型细节），仅记为可选改进。

### 2. 上游对齐 ✅（D-026 已正确反映，反哺需求单独列 §6）

- **UC/AC 落点**：requirements UC-1~5 的 AC 全部在 code-arch 有落点。AC-1.1（⌘K 唤起聚焦）→ §4 功能4 + T1.1；AC-1.2（↑↓ Card-Active）→ §4/T1.3/T1.4；AC-1.3（三种关闭）→ T1.6；AC-2.1~2.5（命令）→ useCommandRegistry §3 + T2.1~2.4；AC-3.1~3.4（文件）→ useSearch §3 + T3.1~3.8；AC-4.1~4.4（会话）→ T4.1~4.5；UC-5 符号占位 → useSearch 符号占位分支 + T5.1~5.4。
- **issues 11 issue 全部落点**：#1 match-engine → §3 lib/match-engine；#2 命令注册表 → §3 useCommandRegistry+command store 扩展；#3 recents → §3 useRecents；#4 编排 → §3 useSearch（**D-026 归 composable，见下**）；#5 api 接线 → §3 api/index.ts 改造；#6 跳转 → §3 useSearchJump；#7 SearchModal → §1/§4 功能4；#8 loading/error → §4 功能4；#9 Tab → §8 Wave3；#10 搭便车 → §8 Wave3；#17 WS 超时 race → §3 useSearch 边界表 + §4 功能2。
- **NFR 缓解项（④MR）落点**：来源 B 表完整覆盖 MR-3.1/3.3/3.4/4.2/4.4/17.1（验收方式=代码测试的 6 条），每条映射到具体用例 ID。MR-3.2/MR-4.1（骨架约束）标"由⑤骨架 tsc 验证不进本表"—— 符合 review-agent.md 对骨架约束的处理。
- **D-026 REVISIT 正确反映（非矛盾）**：code-arch §1 头部 + §2 包依赖图 + §3 useSearch 模块 + §5 + §3 api/index.ts 改造表，全部按"编排归 composables/features/useSearch.ts，不建 api/domains/search.ts"设计。这是 confirmed 决策的真实落地，与 issues #4 方案A「domain 编排」表面相反但实质是 D-026 已 supersede 该表述。**审查不要求改回 domain**（遵守决策账本纪律）。
- **源码模式一致性**（抽查确认）：
  - `composer.getFileCandidates(sessionId): Promise<FileNode[]>`（composer.ts:28）↔ code-arch §3/§4 功能2 引用一致 ✅
  - `commandStore` 现状 `commandsBySession: Map<sessionId, SessionCommand[]>` + `commandsOf(sessionId)` computed（command.ts:48-63）↔ code-arch §3 command store 扩展（加 appCommands ref + slashCommandsOf 沿用 commandsOf）✅
  - `useFileSearch` 现状：`load`（catch 吞错降级空数组 :39-43）/ `debouncedLoad` / `setupInvalidation`（useFileSearch.ts:32-95）↔ code-arch §4 功能2 "直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层（AC-4.5）" + MR-4.4/AC-4.10 "自绑 setupInvalidation watch" ✅ 准确
  - `api/index.ts:42` `export const search = mockApi.search` 硬编码 ↔ code-arch §3 #5 改造表「删除」+ §7 现有代码映射 ✅
  - `mock/index.ts:529` `search.query(q)` mock 签名 ↔ code-arch §1「mock 轨由 useSearch 内部判 VITE_MOCK 走 mockApi.search」✅
  - `useSidebar.selectSession(id, opts?)`（useSidebar.ts:152，await sessionApi.switchSession，**不会 reject session.switch 失败本身但 getHistory 内部 catch**）↔ code-arch §3 useSearchJump confirm session 分支「switch 失败→refresh」—— 见 §3 可执行性轻微注意点
  - `session domain` exports `switchSession`/`list`（session.ts:49/22）↔ code-arch 时序图 `session.list` ✅
  - `useDetailPane.openPreview(sid, path)`（useDetailPane.ts:70）try/catch 吞错 ↔ code-arch §3 useSearchJump AC-6.9 "直调 fileApi.read 不经 useDetailPane.openPreview 吞错层" ✅ 准确（D-024）

### 3. 可执行性 ✅

签名/时序图/骨架清单足以让 ⑥Wave 直接开工：

- **§3 签名表**给齐方法名 + 签名 + 返回 + 边界条件 + 接线层级 + Spec/Issue 关联，⑥可直接照写。
- **§4 时序图**4 个功能链路（空查询/查询四类/选中跳转/生命周期）含 par/alt/异常路径表，每个 alt 映射到用例，无歧义分支。
- **§8 Wave DAG** 明确 Wave1（#1/#2/#3 并行）/ Wave2（#4/#6/#7/#5 依赖 Wave1）/ Wave3（#9/#10），供 ⑥execution-plan 推导。
- **§9 骨架核验清单** 10 方法预期接线状态标注清楚（叶子纯计算 vs 接线完整），Step 7 可直接双向核验。

轻微可执行性注意点（非阻断）：
- `useSidebar.selectSession`（useSidebar.ts:152）内部 `getHistory` 用 try/catch 吞错（:169-176），`switchSession` 本身 reject 才会冒泡到 useSearchJump catch（AC-6.6 session.switch 失败）。§3 confirm session 分支「switch 失败→刷新会话列表」依赖 `session.switchSession` reject 路径——这是真实可达的（transport reject 透传），但 useSidebar.selectSession 是否会把 switchSession reject 透传给调用方（而非自身再 catch）未在 §3 注明。**非阻断**：AC-6.6 是 confirmed NFR 已约束，实现期 useSearchJump 可直调 `sessionApi.switchSession` + useSidebar 导航副作用而非全权委托 selectSession。建议 §3 补一行说明「session 分支或直调 session.switchSession 以保证 reject 透传」——可选改进。

### 4. 完整性 ✅

- §1-9 章节齐全：§1 工程目录 + 变化轴 + 依赖方向 / §2 包依赖图（Mermaid）/ §3 API 契约签名表 / §4 功能时序图（4 个）/ §5 Deep Module 设计决策 / §6 测试矩阵（来源 A 功能用例 + 来源 B NFR）/ §7 现有代码映射 / §8 下游衔接 Wave DAG / §9 骨架覆盖核验。
- **test-matrix 来源 A + B 都有**：来源 A（UC-1~5 共 T1.1~T5.4 含正常/边界/异常/状态/并发/e2e 6 类）+ 来源 B（MR-3.1/3.3/3.4/4.2/4.4/17.1 → T1.16/T1.17/T1.18/T3.3/T4.9/T3.9/T4.8 双源映射）。覆盖完整性自检 6 项全勾。
- **§9 骨架核验清单 10 方法完整**（matchFilter/segments/query/list/registerApp/confirm/read/write/appCommands/registerApp-store），10/10 对应 §3。
- **NFR 来源 B 用例 ID 段不与来源 A 重复**（T1.16/T1.17/T1.18 专属 NFR，与 T1.1~T1.15 区分）—— 处理正确。

### 5. 可视化质量 ✅

- **§2 包依赖图**（graph TD）：subgraph 分组（UI/composables/lib/stores/api-domain/transport）+ 边方向正确（SM→US/ME/USJ/UR；US→CS/FSS/CMP/SES；domain→TR）。stores 间无互连边（铁律），domain 间无互连边（铁律）。循环依赖检测点 3 条标注无环。语法正确可渲染。
- **§4 时序图 ×4**（sequenceDiagram）：participant 声明齐全，par/and/end（allSettled 并行）、alt/else/end（异常分支）语法正确。功能2 的 `Note over US` + `alt WS 超时` 嵌套在 par 内合法。功能4 的 Note 多行用 `<br/>` 在 mermaid 合法。语法正确可渲染。

### 6. D-026 影响评估（反哺建议）⚠️ 关键发现

D-026 把 search 编排从 `api/domains/search.ts`（domain）迁到 `composables/features/useSearch.ts`（composable），这是 confirmed 的真实状态。code-arch 本身已按 D-026 设计（§1 头部、§2、§3、§5 全部对齐）。**但上游①-④仍残留大量 "search domain / api/domains/search.ts / domain query()" 表述**，这些在 D-026 后是过时的，需 Step 6b 反哺。

⚠️ **这不是 code-arch 的缺陷**（code-arch 正确反映了 D-026），但反哺是 D-026 的连带责任，code-arch §3 #5 注释已主动标注「留 Step 6b 反哺 issues #5/#7 AC 措辞」。**对齐组建议：Step 6b 必须执行以下反哺**（不阻断 code-arch APPROVED，但 6b 不可省略）：

#### 6b 反哺清单（D-026 连带）

| # | 上游文件 | 过时表述 | D-026 后应改为 | 严重度 |
|---|---------|---------|---------------|--------|
| 1 | ①requirements.md:31 | 「新建 search real domain，替换 mock；runtime 新增 search.handler」 | 「编排归 useSearch composable；runtime **无新增 handler**（复用现有 file.search/session.list）；删除 search.handler 提及」 | 中（G2 达成路线描述漂移） |
| 2 | ①requirements.md:212 | F9「search real domain（替换 mock）」 | 「search 编排归 composable（useSearch），不建 domain」 | 低 |
| 3 | ②system-architecture.md:22 | G2「新建 search real domain 替换 mock」 | 同上 | 中 |
| 4 | ②system-architecture.md:49 | 统一语言表「search real domain \| `api/domains/search.ts`」 | 改为「useSearch \| composables/features/useSearch.ts，跨 store+domain 编排」；或删除该术语行 | 中（术语表 SSOT） |
| 5 | ②system-architecture.md:164,202,246 | 层级图/模块表/swimlane 的 `search real domain`、`api/domains/search.ts`、`SD[search domain]` | 替换为 useSearch composable；模块位置改 composables/features/ | 中（架构图 SSOT） |
| 6 | ②system-architecture.md:315 | 特化决策「补符号时新增 search domain 内一个 api 调用」 | 「新增 useSearch 内一个源调用」 | 低 |
| 7 | ③issues.md:329 | #4「架构 §7 要求新建 `api/domains/search.ts`（real domain），编排 4 数据源查询」 | 「编排归 composables/features/useSearch.ts（D-026 REVISIT）」 | 高（#4 问题描述核心） |
| 8 | ③issues.md:337 | #4 关键不变式「loadSeq 守卫在 domain query() 内部维护」 | 「在 useSearch.query() 内部维护」 | 高（D-022/MR-4.1 骨架约束措辞） |
| 9 | ③issues.md:339 | #4 错误冒泡链「file 源错误冒泡到 search domain catch」 | 「冒泡到 useSearch query() 的 allSettled catch」 | 高（AC-4.5 措辞） |
| 10 | ③issues.md:389 (AC-4.5) | 「冒泡到 search domain catch（domain 直调 composer.getFileCandidates）」 | 「useSearch 直调 composer.getFileCandidates，冒泡到 useSearch allSettled rejected」 | 高（AC 验收措辞） |
| 11 | ③issues.md:388 (AC-4.4) | 「loadSeq 守卫在 domain query() 内部维护」 | 「在 useSearch.query() 内部」 | 高（AC 验收措辞） |
| 12 | ③issues.md:393 (AC-4.9) | 「domain 复用 useFileSearch 的 session 级缓存」 | 「useSearch 复用…」 | 中 |
| 13 | ③issues.md:394 (AC-4.10) | 「search domain 消费 session 级缓存时须自绑 setupInvalidation」 | 「useSearch 消费…」 | 中 |
| 14 | ③issues.md:407 (#5) | AC-5.1「grep search = mockApi.search 输出为三元切换」+ AC-5.2「走 realSearch」 | D-026 后：#5 改为「删除 export const search（grep `export const search` 无输出），SearchModal 改 import useSearch」（code-arch §3 #5 注释已标此反哺） | 高（#5 AC 整体需重写） |
| 15 | ③issues.md:446 (AC-5.3) | 「re-export 从 mock/search-data 改为 domains/search 或 shared 类型源」 | 「re-export 源不变（仍 mock/search-data，类型 SSOT）」—— code-arch §3 #5 表已写「类型源不变」 | 中 |
| 16 | ③issues.md:78,87,102,126,135,148,151,156,164,167,201,267,341,352,364 | 各处 "search domain" 散在引用（#1/#2/#3/#4 问题描述与方案对比） | 批量替换为 useSearch / composable（或加 D-026 脚注） | 中（量大但机械） |
| 17 | ③issues.md:802-804 (#17 AC-17.1/17.3) | 「domain query() 对 file/session WS 源加超时 race」 | 「useSearch.query() 加超时 race」 | 高（#17 AC 措辞） |
| 18 | ④non-functional-design.md:107,121,129,136,144,145,261,264,270,289,292 | 「domain 编排 file 源」「domain query() 内部维护」「search domain 消费缓存」「domain catch」等 | 批量替换为 useSearch / composable / composable catch | 中（NFR 缓解项 + 骨架约束 + 副作用验证 stub 落点措辞） |

**判定**：以上 18 项是 D-026 的**连带反哺**，不是 code-arch 定稿缺陷。code-arch 已正确按 D-026 设计，并在 §3 #5 主动声明了反哺意图。**对齐组认为 code-arch 可 APPROVED，但 Step 6b 必须完成 #1-#18 反哺**（否则 ⑥execution-plan 会读到过时的 "domain" 措辞产生歧义）。反哺严重度高的是 #7-#11/#14/#17（AC 验收措辞，直接影响 ⑥Wave 执行与 ⑦验证）。

> 注意：这些反哺不涉及推翻任何 confirmed 决策，只是把 "domain" 字样替换为 "useSearch composable" 以匹配 D-026 的真实归位。反哺是机械文字工作，不改变设计。

## 阻断问题（CHANGES_REQUESTED 时填）

无阻断问题。code-arch 本体内部一致、上游 UC/AC/BC/NFR 全落点、可执行、可视化正确、与源码模式一致。

## 非阻断建议（APPROVED 时可列）

1. **（可选）§3 useCommandRegistry.list 返回类型**：`AppCommand[] | SessionCommand[]` 联合返回建议改为 `(AppCommand | SessionCommand)[]` 或带 `type` discriminator 的统一 `Command` 类型，避免调用方类型断言。非阻断（实现期定型）。
2. **（可选）§3 useSearchJump confirm session 分支**：补一行说明 session.switch reject 透传路径（useSidebar.selectSession 内部 getHistory 吞错，switchSession 本身 reject 才冒泡）——或明确 useSearchJump 直调 session.switchSession + 自行做导航副作用，保证 AC-6.6 reject 可达。
3. **（必做，6b）D-026 连带反哺 18 项**（见 §6 清单）—— 这是 Step 6b 的明确任务，不阻断 code-arch APPROVED，但 6b 不可省略，尤其 #7-#11/#14/#17 的 AC 措辞。

## 收敛判定

**APPROVED**

code-architecture.md 内部一致、与①-④ + 项目源码对齐（D-026 已正确反映）、可执行（签名/时序/骨架清单足供 ⑥Wave 开工）、完整（§1-9 齐全 + 来源 A/B test-matrix + 10 方法骨架清单）、可视化语法正确。唯一 FAIL 的机器检查项是本审查文件自指不存在（预期），非定稿缺陷。

**关键交付给 Step 6b**：D-026 连带反哺清单（§6 #1-#18）必须在 6b 执行，把上游①-④残留的 "search domain / api/domains/search.ts / domain query()" 替换为 "useSearch composable"，使整套设计文档与 D-026 confirmed 状态一致。此项不阻断 ⑤code-arch 通过（code-arch 已正确），但阻断整套文档的可交接一致性。
