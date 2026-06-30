---
dimension: terminology
verdict: INCONSISTENT
---

# 术语一致性审计（维 1）

> 范围：①requirements ②system-architecture ③issues ④non-functional-design ⑤code-architecture ⑥execution-plan + CONTEXT.md（统一语言）+ decisions.md。
> 权威源：CONTEXT.md 统一语言（领域术语 SSOT）；本 topic 新增术语以 ⑤code-architecture（D-026 已 backfed、Step7 骨架已落地）为代码层 SSOT。

## Verdict

**INCONSISTENT** — 9 条矛盾。

决定性矛盾是 **D-026「domain→composable」术语残留**：⑤（SSOT）/⑥/② 全部已统一用「composable / useSearch / useSearch.query()」，但 ③issues #4 的**正文**（问题描述 + 方案A/B/C + 取舍决策 + AC-4.4/4.5/4.10）仍整段写「search domain / api/domains/search.ts / domain query()」，且**只有标题被 backfed、正文未洗**，导致 ③#4 内部自相矛盾（标题=composable，正文=domain）。③#8、③#17 有同类部分残留；④NFR 正文有大面积残留（但 ④ 顶部已加解释性桥接声明，属「已声明漂移」，严重度低于 ③ 的静默残留）。

其余为次要漂移：Status 枚举连字符/下划线不统一（②prose vs ②mermaid+③⑤）、D-014 用「query」、②§7 三处 composable 路径漏 `features/`、②§4 未列举 `Section` 模型、decisions D-003 仍写「上限 500」（D-021 已校正 5000）。

> 说明：下列「✅」=①-⑥ 用词一致；「⚠️」=存在漂移但不阻断理解；「❌」=跨文档直接冲突/内部自相矛盾。

## 术语核对记录（逐术语）

| # | 术语 | 状态 | 核对结论 |
|---|------|------|---------|
| 1 | **SearchModal** | ✅ | 组件名 + 路径 `components/overlays/SearchModal.vue` 全文档一致 |
| 2 | **搜索浮层** | ✅ | 中文指称 ①-⑥ 一致（与 spec.md 「overlay」语义对齐） |
| 3 | **useSearch（D-026 后 composable 非 domain）** | ❌ | ①②⑤⑥ 一致（composable）。但 **③#4 正文**（问题描述/方案A·B·C/取舍决策/AC-4.4·4.5·4.10）、**③#8**（P级理由/AC-8.2）、**③#17**（取舍决策/AC-17.1）、**④NFR 正文**（#4 全节 + #5「三元切换」+ MR-4.1/4.4/4.5/17.1 + 骨架验证表）仍写「search domain / api/domains/search.ts / domain query()」。③#4 标题已 backfed 而正文未洗，**内部自相矛盾** |
| 4 | **命令注册表 / Command Registry** | ✅ | ①②③⑤⑥ 一致（D-004/D-016） |
| 5 | **useCommandRegistry** | ✅ | 命名一致；路径漂移见 #19（②§7 漏 `features/`） |
| 6 | **match-engine** | ✅ | `lib/match-engine.ts` 文件名/模块名一致 |
| 7 | **matchFilter** | ✅ | 纯函数导出名 ②③⑤⑥ 一致 |
| 8 | **segments** | ✅ | 纯函数导出名 ②③⑤⑥ 一致；返回 `MatchSegment[]` 一致 |
| 9 | **useRecents** | ✅ | 命名一致；路径漂移见 #19 |
| 10 | **useSearchJump** | ✅ | 命名一致（「跳转编排」= Jump Orchestrator，②§3 定义）；路径漂移见 #19 |
| 11 | **recents**（+ RecentEntry） | ✅ | 概念 + 值对象模型（type/key/title/sub/timestamp）④⑤一致，①-⑥ 用词一致 |
| 12 | **SearchItem** | ✅ | DTO 形态 SSOT（api/mock/search-data.ts，⑤§3 明确）①-⑥ 一致 |
| 13 | **SearchType** | ✅ | 类型源一致（⑤§1 明确 SearchType/SearchItem 类型源） |
| 14 | **Section**（query 返回 `Section[]`） | ⚠️ | ③#4（line 354）+ ⑤（useSearch.query 签名）使用大写 `Section` 类型；但 **②§4 核心模型表未列举 Section**（仅列 SearchItem/SessionCommand/AppCommand/RecentEntry/MatchSegment，§7 正文用小写「section」）。模型层缺定义 |
| 15 | **AppCommand** | ✅ | 模型 `{id,name,shortcut?,action}` ②④⑤一致 |
| 16 | **SessionCommand** | ✅ | DTO ②③⑤一致（pi slash 命令归一化模型） |
| 17 | **loadSeq** | ⚠️ | 术语本身一致（乱序响应守卫）。但 ③④ 多处仍把守卫挂在「domain query()」上（见 #3），措辞与 ⑤「useSearch.query()」不符 |
| 18 | **withWsTimeout**（#17 超时 race） | ⚠️ | ⑤⑥ 命名 `withWsTimeout`（useSearch.ts:131）；③#17 描述为 `Promise.race([wsCall, timeout(10s)])` 未命名 helper——属 ⑤ 命名细化，可接受。但 ③#17 取舍决策(line794)+AC-17.1(line803) 仍写「domain query()」残留（见 #3） |
| 19 | **composable 路径 `composables/features/`** | ⚠️ | ⑤§1 目录树 + ⑥ 统一 `composables/features/`；②§7 模块表 useSearch 写 `composables/features/useSearch.ts`（含 features/），但 useCommandRegistry/useSearchJump/useRecents（②line203/205/206）**漏 `features/`**，与 ⑤⑥ 不一致 |
| 20 | **Status 枚举**（closed/open/recents/query_results/empty/loading/error/type_filtered） | ⚠️ | 下划线为规范。**②§5 散文用连字符** `query-results`(line120)/`type-filtered`(line123)，而 ②自身 mermaid(line138/146/147)+③(line68-78)+⑤(line604) 用下划线——②内部散文↔图不一致。decisions D-014(line25) 用「query」且漏 type_filtered |
| 21 | **domain vs composable（D-026 总判）** | ❌ | 见 #3。⑤ SSOT=composable；①②(backfed)=composable；③#5(backfed 完整)=composable；但 **③#4/#8/#17 正文 + ④正文** 残留 domain。见矛盾 C1-C4 |

## 矛盾清单

### C1 ❌ ③issues #4 正文整段残留「search domain」，与 ⑤SSOT / ② / ③#5 / D-026 冲突，且 ③#4 自相矛盾
- **文档+位置**：
  - ③issues.md #4 **问题描述**（line 329）「架构 §7 要求新建 `api/domains/search.ts`（real domain），编排 4 数据源查询」；(line 335)「GAP-E1 归 domain」；(line 337)「loadSeq 守卫在 domain query() 内部维护」；(line 339)「domain 编排 file 源…file 源失败永不冒泡到 domain catch」；(line 341)「关联 system-architecture.md §7（**search domain 模块**）」
  - ③ #4 **方案对比** 方案A(line 349)「单 **domain** 函数 query(q) 内编排 3 源」；(line 353)「新建 `api/domains/search.ts`，导出 query(q)」；方案B(line 362-365)「domain 只编排查询 / search domain 定位」；方案C(line 369)「每数据源独立 domain 函数」；**取舍决策**(line 376-377)「方案 A（单 **domain** 函数 + allSettled + 分组）…domain 封装编排」
  - ③ #4 **AC**：AC-4.4(line 388)「loadSeq 守卫在 **domain** query() 内部」；AC-4.5(line 389)「冒泡到 **search domain** catch」；AC-4.10(line 394)「**search domain** 消费 session 级缓存时须自绑」
- **矛盾描述**：③ #4 **标题**(line 318) 已 backfed 为「useSearch composable…[D-026：search 编排归 composable 非 domain]」，但其正文（问题描述/方案A·B·C/取舍决策/AC）仍整段按 **D-026 之前** 的「新建 api/domains/search.ts（real domain）」方案写。
  - vs ⑤code-architecture（代码 SSOT，D-026 已 backfed）：§3 useSearch.query 为 `composables/features/useSearch.ts` composable，明确「**不新建 api/domains/search.ts**」；
  - vs ②system-architecture（已 backfed：§7 line 202「不新建 api/domains/search.ts」）；
  - vs **③#5**（同文档，已**完整** backfed：line 409「D-026 确认…不新建 api/domains/search.ts」+ 方案A/B 重写为删导出+改调 useSearch）；
  - vs decisions D-026。
  - 最严重的是 **③#4 标题=composable 而正文=domain，内部自相矛盾**；且 ③#5 完整 backfed 而 ③#4 仅标题 backfed，同文档内 backfed 不对称，可证 #4 正文系遗漏。
- **建议修订**：按 ③#5 的 backfed 范式重洗 ③#4 正文——
  1. 问题描述 line 329/335/337/339/341：`api/domains/search.ts`→`composables/features/useSearch.ts`，`domain`→`useSearch composable`，`domain query()`→`useSearch.query()`，`domain catch`→`useSearch catch`，`search domain 模块`→`useSearch composable 模块`，`GAP-E1 归 domain`→`GAP-E1 归 composable`；
  2. 方案A/B/C + 取舍决策：方案A 改述为「单 composable 函数 useSearch.query() 内编排 3 源」；方案B/C 的「domain」替换为「composable」，或如 #5 方案B 标注「（D-026 前原方案，已弃）」；
  3. AC-4.4/4.5/4.10：`domain query()`→`useSearch.query()`，`search domain catch`→`useSearch catch`，`search domain 消费缓存`→`useSearch 消费缓存`。

### C2 ❌ ④NFR 正文大面积残留「search domain / domain query()」，与 ⑤SSOT 冲突
- **文档+位置**：④non-functional-design.md #4 标题(line 99)「search real domain — 方案 A（单 **domain**…）」；line 107「domain 是只读查询编排」；line 109「domain 编排 file 源…冒泡到 domain catch」；line 123「domain query() 内部维护自增 seq」；line 131「domain query() 永久 await…domain query() 对 WS 源加超时 race」；line 138「domain catch 错误须 toast」；line 146-147「search domain 消费缓存…在 domain query() 调用前校验」；#5(line 151-163) 仍框定为「方案 A（三元切换）」+「与现有 9 个 domain 切换模式 100% 一致」；MR-4.1(line 263)/MR-4.4(line 266)/MR-4.5(line 267)/MR-17.1(line 272) 均写「search domain query()」；骨架验证表(line 291/294)「search domain query() 含 loadSeq/超时 race」。
- **矛盾描述**：④ 正文仍按 D-026 前「search real domain」框架撰写，与 ⑤code-architecture（composable SSOT）不符。但 ④**顶部 line 8 已加显式桥接声明**——「"search domain / domain query()" 措辞应理解为 "useSearch composable / useSearch.query()"（D-026 归 composable）」，并声明「NFR 分析全部仍然有效」。故 ④ 属**已声明漂移**（有解释性桥接），严重度低于 ③ 的静默残留，但术语层面仍与 ⑤ 不一致，且 #5「与现有 9 个 domain 一致」在 D-026 后已不成立（search 无 domain）。
- **建议修订**：将 ④ 正文 domain 措辞批量替换为 useSearch composable（或保留顶部桥接声明的同时，至少把 #5「三元切换 / 与 9 个 domain 一致」改为 D-026 后的真实态——删 search 导出 + 改调 useSearch，消除「search 是 domain」的误导）。建议同 ③#4 一起洗，因 ④ 多处直接引用 ③#4 的 AC。

### C3 ⚠️ ③issues #17 部分残留「domain query()」，与自身 backfed 的方案A 标题 + ⑤ 冲突
- **文档+位置**：③issues.md #17 方案A 标题(line 767) 已 backfed 为「useSearch.query() 对 WS 源加超时 race…[D-026：domain query() → useSearch.query()]」；但 **取舍决策**(line 794)「选择: 方案 A（**domain query()** 超时 race）」、**AC-17.1**(line 803)「**domain query()** 对 file/session WS 源加超时 race」未洗。
- **矛盾描述**：#17 方案A 标题已 backfed 为 useSearch.query()，但取决策与 AC-17.1 仍写「domain query()」，与 ⑤（withWsTimeout 在 useSearch.ts:131）及自身标题不一致。
- **建议修订**：line 794、line 803 的 `domain query()` → `useSearch.query()`。

### C4 ⚠️ ③issues #8 残留「search domain 的 catch」，与 ⑤ 冲突
- **文档+位置**：③issues.md #8 为什么是这个P级(line 616)「依赖 #4（error 挂载点在 **search domain 的 catch**）」；AC-8.2(line 656)「**search domain catch** 错误→toast 反馈」。
- **矛盾描述**：D-026 后 error 挂载点在 useSearch catch（⑤§3 useSearch.query），③#8 仍写「search domain 的 catch」。
- **建议修订**：line 616、line 656 的 `search domain catch`/`search domain 的 catch` → `useSearch catch`/`useSearch 的 catch`。

### C5 ⚠️ Status 枚举连字符/下划线不一致（②散文 vs ②图 + ③⑤）
- **文档+位置**：②system-architecture.md §5 散文 line 120「`query-results`」、line 123「`type-filtered`」（**连字符**）；②同节 mermaid line 138/146/147「`query_results`/`type_filtered`」（**下划线**）；③issues.md line 68-78「`query_results`/`type_filtered`」（下划线）；⑤code-arch line 604「`type_filtered`」（下划线）。
- **矛盾描述**：规范枚举值用下划线（closed/open/recents/query_results/empty/loading/error/type_filtered）。②散文用连字符 query-results/type-filtered，与②自身 mermaid 图及 ③⑤ 不一致——**②内部散文↔图自相矛盾**。
- **建议修订**：②§5 散文 line 120/123 连字符改下划线（query-results→query_results，type-filtered→type_filtered），与 mermaid 图 + ③⑤ 统一。

### C6 ⚠️ decisions.md D-014 用「query」且漏 type_filtered
- **文档+位置**：decisions.md D-014(line 25) rationale「UI 状态（closed/open/recents/**query**/empty/loading/error）」。
- **矛盾描述**：D-014 的枚举用「query」而非「query_results」，且未列 type_filtered，与 ②§5 / ③ / ⑤ 的 8 值枚举不一致。
- **建议修订**：decisions 账本 append-only，不删行；建议在 D-014 rationale 补注「（即 ②§5 的 query_results/type_filtered，此处为简写）」或留作已知简写（低优）。规范名以 ②§5/⑤ 为准。

### C7 ⚠️ ②§7 三处 composable 路径漏 `features/`，与 ⑤⑥ SSOT 不一致
- **文档+位置**：②system-architecture.md §7 模块表 line 202 useSearch=`composables/features/useSearch.ts`（含 features/，正确）；但 line 203 useCommandRegistry=`composables/useCommandRegistry.ts`、line 205 useSearchJump=`composables/useSearchJump.ts`、line 206 useRecents=`composables/useRecents.ts`（**均漏 features/**）。⑤§1 目录树 + ⑥(line 112 等) 四者统一 `composables/features/`。
- **矛盾描述**：②§7 对四个 composable 路径写法不统一（useSearch 含 features/，其余三个不含），且与代码 SSOT ⑤⑥（`composables/features/`）不符，可能误导实现者把文件放错目录。
- **建议修订**：②§7 line 203/205/206 补 `features/` → `composables/features/useCommandRegistry.ts` / `useSearchJump.ts` / `useRecents.ts`，与 ⑤⑥ 统一。

### C8 ⚠️ ②§4 核心模型表未列举 `Section`，与 ③⑤ 不一致
- **文档+位置**：③issues.md #4 line 354「模型: **Section** 结构为 label + items:SearchItem[]」；⑤code-arch §3 useSearch.query 签名「`Promise<Section[]>`」；但 ②system-arch §4 核心模型表(line 53-59) 仅列 SearchItem/SessionCommand/AppCommand/RecentEntry/MatchSegment，**无 Section**，§7 正文用小写「section」。
- **矛盾描述**：`Section` 作为 query() 的返回类型在 ③⑤ 是具名模型，但 ②§4 模型清单遗漏，架构层缺定义（小写 section 仅作散文）。
- **建议修订**：②§4 核心模型表补一行 `Section | 值对象（新增）| label + items:SearchItem[] | 四类分组的渲染单元（query 输出整形）`，与 ③⑤ 对齐。

### C9 ⚠️ decisions.md D-003 仍写「上限 500」，与 D-021(5000) + ①-⑥ 不一致（事实性）
- **文档+位置**：decisions.md D-003(line 14) rationale「searchFiles（file-service.ts:161，深度 8/**上限 500**）」；D-021(line 32) 已校正 MAX_SEARCH_RESULTS=5000；①(line 28/191)②③④⑤⑥ 正文均用 5000。
- **矛盾描述**：D-003 rationale 的「上限 500」是 D-021 前的旧值，事实性过期（D-021 已在 AC 层校正为 5000）。账本 append-only 故 D-003 行未改。属事实/数值漂移而非纯术语漂移，列此备查。
- **建议修订**：decisions 账本 append-only 不删行；可在 D-003 rationale 末尾补注「（上限值已被 D-021 校正为 5000）」或依赖 D-021 supersede 关系即可。低优。

---

### 附：核对一致（无需修订）的关键术语
SearchModal、搜索浮层、命令注册表/Command Registry、useCommandRegistry（命名）、match-engine、matchFilter、segments、useRecents（命名）、useSearchJump（命名）、recents/RecentEntry、SearchItem、SearchType、AppCommand、SessionCommand、MatchSegment、useDetailPane、useSidebar.selectSession、composer.getFileCandidates、useFileSearch.setupInvalidation、跳转编排/Jump Orchestrator、匹配引擎/Match Engine —— ①-⑥ 用词一致，无同义词硬冲突。

> 「pi slash 命令 / slash 命令 / pi 命令」三者在 ①-⑥ 交替使用，均指 SessionCommand（带 `/` 前缀的 pi 命令），属可接受的上下文简写，非硬冲突，未单列为矛盾。
