---
phase: issues
tracer: independent-subagent
frame: coverage-reconstruct
round: 1
converged: false
---

# Tracing Round 1 · 覆盖重建（角色 A）

> 重建源：仅 `system-architecture.md`（②，真相源）+ `CONTEXT.md` + `decisions.md`（账本纪律）。
> **重建阶段未读 issues.md**；T_recon 独立从 ② 逐条枚举后，才读 issues.md「上游覆盖核验表」+ 全文做 diff。
> 账本纪律：已 confirmed 决策（D-001~D-019）不当 gap 重报；本期无下游新证据推翻任何 confirmed 决策，故无 `[REVISIT of D-NNN]`。
> 类型约定：**F**=事实/事实归属 · **K**=契约/约束/覆盖归属 · **D**=决策/口径。

---

## T_recon（独立重建覆盖表）

> 4 轴（状态§5 / 模块§7 / 边界§8 / 挑战§10）+ 兜底（§11 AC / §12 BC / §9 swimlane / §1 搭便车 / §4 模型 / §1 系统目标）。每元素独立判断「需不需要 issue / 是什么 issue」。

### 状态轴（§5 状态流转）

> D-014 松散状态机：仅 `closed↔open` 是独立状态变量；open 内视图态是 computed 派生态（query/结果/loading 驱动）。故大部分转换是「派生态，并入承载该态的 issue」，不单开 issue。

| 上游元素（§5） | 需要issue? | 归属 issue | 理由 |
|---------------|-----------|-----------|------|
| closed→open（⌘K/Ctrl+K/搜索按钮） | 是（行为契约） | BC-1 → SearchModal 改造 | 唤起入口，UI 行为须保持 |
| open→closed（Esc/再按⌘K/点遮罩/确认跳转后） | 是 | BC-1 → SearchModal 改造 | 关闭路径多条，须保持 |
| recents（query 空，派生态） | 是（变更） | BC-5 → recents 持久化 + 显示集成 | mock→localStorage 变更项 |
| query-results（query 非空+有命中，派生态） | 是（并入） | SearchModal 改造 | 主渲染态，数据源切 search domain |
| empty（query 非空+无命中，派生态） | 是（保持） | BC-6 → SearchModal 改造 | 空态保持 |
| loading（查询>200ms，transient） | 是（新增） | 独立 issue | 现状无 loading 态，AC-3.4 要求，须新建 |
| error（查询/跳转失败，transient） | 是（新增+拆两路） | 查询失败态 + 跳转失败态分两处 | error 有两个不同来源（查询 catch / 跳转 catch），no-silent-catch 硬阻断 |
| type-filtered（Tab 切类激活，派生态） | 是 | 独立 issue（P2 增强） | spec 状态机有但无独立用例 |
| query_results→recents（清空查询） | 否（派生态） | 并入 SearchModal | computed 派生，query 驱动 |
| query_results→empty（无命中） | 否（派生态） | 并入 SearchModal | computed 派生 |
| empty→query_results（修改查询有命中） | 否（派生态） | 并入 SearchModal | computed 派生 |
| query_results→loading（>200ms） | 是 | loading 态 issue | 触发条件即 loading 态定义 |
| loading→query_results（查询返回） | 否（派生态） | 并入 loading 态 issue | transient 标志清除 |
| loading→empty（查询返回无命中） | 否（派生态） | 并入 loading 态/空态 | transient + 派生 |
| query_results→type_filtered（Tab） | 是 | Tab 切类 issue | type-filtered 态进入 |
| type_filtered→query_results（Tab 回全部） | 否（派生态） | 并入 Tab 切类 issue | activeType=null 派生 |
| Reason 字段（无独立 Reason） | 否 | N/A | ②§5 明示 error 原因由 catch 表达，不进状态机 |

### 模块轴（§7 模块划分）

| 上游元素（§7） | 需要issue? | 归属 issue | 理由 |
|---------------|-----------|-----------|------|
| SearchModal.vue（改造） | 是 | 独立 issue | 新建/改造模块 = issue 候选（②下游衔接明示） |
| search real domain（新建 api/domains/search.ts） | 是 | 独立 issue | 新建模块 + G2 关键路径 |
| 命令注册表（store 扩 + composable 新） | 是 | 独立 issue | 新建+改造，D-016 物理隔离 |
| 匹配引擎（提取 lib/match-engine.ts） | 是 | 独立 issue | 提取纯函数，双消费者 |
| 跳转编排（新建 useSearchJump.ts） | 是 | 独立 issue | 新建模块，BC-3 变更落点 |
| recents composable（新建 useRecents.ts） | 是 | 独立 issue | 新建模块，BC-5 变更落点 |
| api/index.ts（接线改造） | 是 | 独立 issue | 改造，AC-1 grep 验收 |

### 边界轴（§8 Context Map）

| 上游元素（§8） | 需要issue? | 归属 issue | 理由 |
|---------------|-----------|-----------|------|
| runtime 边界（WS file.search/session.list/session.getCommands/file.read） | 是（并入） | search domain + 跳转编排 | 4 个 WS handler 在 domain(查)/JO(跳) 内调用，契约自有可控 |
| pi 边界（经 runtime 透传 getCommands） | 是（并入） | 命令注册表 | slash 命令源，复用现有 handler |
| localStorage 边界（recents） | 是（并入） | recents composable | 浏览器 API，recents 持久化 |

### 挑战轴（§10 挑战与决策）

| 上游元素（§10） | 需要issue? | 归属 issue | 理由 |
|---------------|-----------|-----------|------|
| D-011 三层 vs DDD 四层 | 否 | N/A | 已 confirmed 决策，非未决挑战 |
| D-012 port 边界 | 否 | N/A | 已 confirmed 决策 |
| D-013 领域模型深度 | 否 | N/A | 已 confirmed 决策 |
| D-016 命令注册表归属（扩展 vs 新建）+ 物理隔离 | 是（并入） | 命令注册表 issue | 决策落点须 issue 承载（两区隔离 AC） |
| 特化决策「符号占位不建 port」 | 是（并入） | search domain | 占位逻辑在 domain 内（不调 api） |
| 特化决策「recents 用 localStorage 不走 runtime」 | 是（并入） | recents composable | 决策落点 |
| §4 降级决策「SearchSession aggregate 不建模」 | 否 | N/A | D-013 已 confirmed，主动不建模 |
| §4 降级决策「MatchStrategy port 不建」 | 否 | N/A | D-012 已 confirmed |
| §4 降级决策「SearchSource port 不建」 | 否 | N/A | D-012 已 confirmed |

### 兜底（4 轴外其余章节）

| 上游元素 | 轴 | 需要issue? | 归属 issue | 理由 |
|---------|----|-----------|-----------|------|
| §11 AC-1 search 不再常驻 mock | grep AC | 是（验收） | api 接线 issue | AC 落 api/index.ts |
| §11 AC-2 应用命令不硬编码 keydown | grep AC | 是（变更/搭便车） | 搭便车 issue | 待⑤确认 |
| §11 AC-3 无伪 port | grep AC | 否 | N/A | 实现期 grep 检查即可，D-012 已排除 |
| §11 AC-4 匹配引擎纯函数 | grep AC | 是（验收） | 匹配引擎 issue | AC 落 match-engine.ts |
| §12 BC-1 ⌘K 唤起+Esc 关闭 | 行为契约 | 是（保持） | SearchModal 改造 | 保持等价 |
| §12 BC-2 ↑↓ 键盘导航 | 行为契约 | 是（保持） | SearchModal 改造 | 保持 |
| §12 BC-3 Enter 确认（变更→跳转编排） | 行为契约变更 | 是（独立 ticket） | 跳转编排 + SearchModal | 变更项，须 JO 骨架先建 |
| §12 BC-4 segments 高亮 | 行为契约 | 是（保持/提取） | 匹配引擎 | 提取为纯函数 |
| §12 BC-5 空查询 recents（变更 mock→localStorage） | 行为契约变更 | 是（独立 ticket） | recents composable + SearchModal 显示 | 变更项，持久化+显示两处 |
| §12 BC-6 空结果态 | 行为契约 | 是（保持） | SearchModal 改造 | 保持 |
| §12 BC-7 scrollIntoView（变更→IfNeeded，搭便车） | 行为契约变更 | 是（条件独立） | 搭便车（待⑤确认） | 变更项条件性 |
| §12 BC-8 四类图标映射 | 行为契约 | 是（保持） | SearchModal 改造 | 保持（symbol 占位仍渲染图标） |
| §12 BC-9 乱序响应保护 loadSeq | 行为契约 | 是（保持/迁移） | search domain（迁移）+ SearchModal | 正确性不变式，迁移落点 domain |
| §12 BC-10 鼠标交互路径 | 行为契约 | 是（保持） | SearchModal 改造 | 保持 |
| §12 BC-11 查询/开关生命周期副作用 | 行为契约 | 是（保持） | SearchModal 改造 | 保持 |
| §12 BC-12 边缘不变式（空结果禁键/循环包裹/Clock/a11y） | 行为契约 | 是（保持） | SearchModal 改造 | 保持 |
| §9 swimlane：并行查 3 源（allSettled 容错） | 控制流 | 是（并入） | search domain | allSettled 容错须 AC 验收 |
| §9 swimlane：matchFilter 前端过滤 | 控制流 | 是（并入） | 匹配引擎 + search domain | file.search 返回全量→前端过滤 |
| §9 swimlane：按类型分组（输出整形） | 控制流 | 是（并入） | search domain | 分组归属 domain（GAP-E1 已决策） |
| §9 swimlane：Enter 选中 alt 三分发（command/file/session） | 控制流 | 是（并入） | 跳转编排 | 三条分发路径 |
| §9 swimlane：写 recents FIFO | 控制流 | 是（并入） | 跳转编排 + recents composable | 跳转后写 |
| §9 swimlane：关闭浮层 + toast | 控制流 | 是（并入） | 跳转编排 + SearchModal | 跳转后关闭+反馈 |
| §9 swimlane：debounce(120ms) | 控制流 | 是（搭便车） | 搭便车 issue | 待⑤确认 |
| §1 搭便车①Sidebar keydown 接入注册表 | 搭便车 | 是（条件） | 搭便车 issue | 候选，待⑤确认 |
| §1 搭便车②scrollIntoView→scrollIntoViewIfNeeded | 搭便车 | 是（条件） | 搭便车 issue | 候选，待⑤确认 |
| §1 搭便车③查询 debounce(120ms) | 搭便车 | 是（条件） | 搭便车 issue | 候选，待⑤确认 |
| §4 模型：AppCommand（新增，含 action） | 模型 | 否（并入） | 命令注册表 | 模型随模块落地，非独立 issue |
| §4 模型：RecentEntry（新增） | 模型 | 否（并入） | recents composable | 模型随模块落地 |
| §4 模型：SearchItem/SessionCommand/MatchSegment（已有） | 模型 | 否 | N/A | 复用已有 DTO |
| §1 系统目标 G1/G1.1~G1.4/G2 | 目标 | 否（映射） | 各模块 issue | 目标非 issue，由模块 issue 达成（G2→#4/#5 AC-1） |

---

## Diff 结果（T_recon vs 主 agent 覆盖核验表）

> 主 agent 覆盖核验表共 38 行。逐行比对后，模块轴/边界轴/挑战轴/§11 AC/§12 BC 主体覆盖完整。gap 集中在**状态轴转换枚举不全**、**error 态覆盖归属错配**、**P3 项脱锚** 三处。

### MISSING（漏项）

> **无实质性 MISSING（② 有元素没被拆）。** 模块轴 7 模块、边界轴 3 边界、§11 4 AC、§12 12 BC 均有对应 issue 或 N/A 理由。loading/error/type-filtered 三个需独立 issue 的状态均有对应（#8/#8/#9）。
>
> 唯一**枚举完整性**缺口见 MISMATCH-M2（状态轴转换未逐行全覆盖，但均已并入对应 issue，未漏拆 issue）。

### PHANTOM（脱锚）

**P-1（F，低）**：**P3 后续项 #13/#14/#15/#16 根在 requirements §8 / decisions D-008/D-010，② 查不到根**。
- 事实：issues.md「后续迭代」列 6 项 P3，其中 #11（符号真实数据→D-001，②§1 G1.4+§10 特化可查）、#12（ripgrep→D-003，②§1 G1.2 路径匹配可隐证）在 ② 有弱根；但 **#13（危险命令二次确认→D-008）、#14（会话 overview→D-010）、#15（⌘1…⌘5→spec 遗留②）、#16（跨项目 scope 过滤条→requirements §8）** 在 ② system-architecture **全文无对应元素**——D-008/D-010 是 clarity 阶段决策，②§10 仅记 architecture 阶段 D-011~D-016。
- 判定：**非真假冒**——这是「已决策 Out-of-Scope 项登记」的合理下游行为（记录已知排除），属合理脱锚而非越界捏造。但严格按「从 ② 逐条枚举」的重建范围，这 4 项无法追溯到 ②。
- 建议：issues.md「后续迭代」表为这 4 项补 `source` 列指向 `requirements §8 Out of Scope` / `decisions D-008/D-010`，使脱锚可追溯（当前仅正文文字提及，表格无源列）。属溯源标注完整性，不删 issue。

### MISMATCH（虚覆盖）

**M-1（F，中）**：**error 态覆盖归属错配——覆盖表把所有 error 态归 #8，但跳转失败错误实际在 #6**。
- 事实 A：覆盖核验表行「§5: error 态（查询/跳转失败） → #8 ✅」。
- 事实 B：issues.md #8（loading+error 态）的 AC-8.2/8.3 只处理 **search domain 查询失败**（catch→toast+分组空态）；而 **跳转失败**（file.read 失败 / session.switch 失效）在 **#6 跳转编排** 的 AC-6.5（file.read 失败→toast）+ AC-6.6（session.switch 失败→toast+刷新列表）。
- 问题：覆盖表「查询/跳转失败」两源都标 →#8 是**虚覆盖**——#8 实际不覆盖跳转路径错误，跳转错误是 #6 的契约。读者照覆盖表会误以为 error 态全在 #8，遗漏 #6 的跳转错误闭环。
- 建议：覆盖表「error 态」行拆为两行——「查询失败 error → #8」「跳转失败 error → #6（AC-6.5/6.6）」，使错误处理分布真实可见。

**M-2（K，中）**：**状态轴转换枚举不全——覆盖表只列 6 个转换，漏 §5 图中 5 个显式转换**。
- 事实 A：§5 stateDiagram-v2 明确画了 11 条转换（含 recents↔query_results 双向、empty↔query_results、loading→query_results、loading→empty、type_filtered→query_results）。
- 事实 B：覆盖表状态轴只列 6 行（closed↔open / recents→query_results / query_results→empty / query_results→loading / query_results→type_filtered / error 态），**漏列**：query_results→recents（清空）、empty→query_results、loading→query_results、loading→empty、type_filtered→query_results。
- 判定：因 D-014 松散状态机，这些漏列转换是 computed 派生态、已并入 #7/#8/#9，**不构成漏拆 issue**（非 MISSING）。但覆盖表作为「逐条不漏」核验表，转换枚举不完整使读者无法验证「所有合法转换的承载 issue」——属**覆盖核验的枚举虚覆盖**（标了状态轴全覆盖，实则只验主转换未验返向/分支转换）。
- 建议：覆盖表状态轴补返向转换行（或显式声明「派生态转换并入对应 issue，仅列触发态」），消除「逐条不漏」与实际枚举的口径差。

**M-3（K，低）**：**BC-5（空查询 recents 变更）覆盖指针只指 #3，漏 #7 显示集成**。
- 事实 A：覆盖表「BC-5 空查询 recents（变更 mock→localStorage）→ #3 ✅」。
- 事实 B：BC-5 实为两处——持久化机制在 #3（useRecents），**渲染/显示集成在 #7**（AC-7.11「空查询 recents 改用 #3 useRecents 替代 mock」）。覆盖表只指 #3，未点 #7 的显示集成角色。
- 判定：两 issue 实际都覆盖了 BC-5，非真虚覆盖；但覆盖指针不完整（漏 #7），读者无法从覆盖表看到显示侧落点。
- 建议：BC-5 行归属补「#3（持久化）+ #7（显示集成）」。

---

## gap 汇总（带 F/K/D 分类）

| gap_id | 类型 | 轴/来源 | 严重度 | 描述 | 建议 |
|--------|------|---------|--------|------|------|
| M-1 | F | 状态轴 §5 | 中 | error 态覆盖表全归 #8，但跳转失败错误（file.read/session.switch）实际在 #6 AC-6.5/6.6；#8 只覆盖查询失败 | 覆盖表 error 态行拆「查询失败→#8 / 跳转失败→#6」 |
| M-2 | K | 状态轴 §5 | 中 | 状态轴转换枚举不全，漏 §5 图中 5 条显式转换（清空回 recents / empty→results / loading 出口×2 / type_filtered 回退）；D-014 派生态故不漏拆 issue，但「逐条不漏」核验口径虚覆盖 | 补返向转换行或显式声明派生态转换的并入规则 |
| M-3 | K | 兜底 §12 BC-5 | 低 | BC-5 覆盖指针只指 #3（持久化），漏 #7（显示集成 AC-7.11） | BC-5 归属补「#3 + #7」 |
| P-1 | F | 后续迭代 P3 | 低 | #13/#14/#15/#16 根在 requirements §8 / D-008/D-010，② 无对应元素；属合理 Out-of-Scope 登记但脱锚 | P3 表补 source 列指向 requirements §8 / decisions |

> **MISSING（漏项）：0 条** —— 模块/边界/挑战/§11 AC/§12 BC 主体覆盖完整，无 ② 元素未被拆成 issue。
> **PHANTOM（脱锚）：1 条（P-1，低，合理脱锚）** —— P3 后续项根在上游 requirements 非 ②。
> **MISMATCH（虚覆盖）：3 条（M-1 中 / M-2 中 / M-3 低）** —— 集中在状态轴 error 归属与转换枚举、BC 覆盖指针完整性。
>
> **未触发 [REVISIT of D-NNN]**：扫描未见下游新证据推翻任何 confirmed 决策（D-001~D-019）。M-1~M-3/P-1 均为覆盖核验表的归属/枚举/溯源标注问题，非决策回退。
> **最严重 3 条**：M-1（error 态错配，中）/ M-2（状态转换枚举虚覆盖，中）/ M-3（BC-5 指针不全，低）。

---
---
phase: issues
tracer: independent-subagent
frame: anomaly-hunter
round: 1
converged: false
---

# Tracing Round 1 · 异常猎手（角色 B）

> 戴失败帧扫死角：假设 issues.md 错且不全。已 confirmed 决策（D-001~D-019）不当 gap 重报；仅当下游新证据推翻时标 `[REVISIT of D-NNN]` 走反哺。事实均经源码核验（路径+行号已标注）。
> **结论：未触发任何 [REVISIT of D-NNN]——无新证据推翻已 confirmed 决策。** 以下均为 issues.md 未覆盖的实现期死角（F/K/D 类）。
> 注：与角色 A（reconstruct 帧）的 M-1（error 归属错配）正交印证——角色 A 指覆盖表归属错，本帧（AH-E1/E3/S2）进一步定位 error 冒泡链与状态可达性的机制级缺陷。

## 未处理清单（失败帧扫描）

### 异常路径

- **AH-E1（致命，跨 #4/#8）**：`file.search` 失败在现有链路里被**静默吞掉**。`useFileSearch.load`（`useFileSearch.ts:35-43`）`catch { return [] }`——降级空数组、不抛、不 toast、不缓存失败。而 `composer.getFileCandidates`（`composer.ts:28`）经 pending reject 透传 error envelope（code 透传到 Error.code）。**问题**：#4 search real domain 若复用 `useFileSearch.load`，则 file 源失败 → 永远静默成空 section（用户误以为「没有匹配文件」），与 #8 AC-8.2「search domain catch→toast 不静默」**直接矛盾**。#8 把 error catch 挂在 search domain，但只要 domain 调的是已吞错的 useFileSearch.load，domain 永远拿不到 error（load 已在更下游吞了）。**建议**：#4 domain 编排应**直接调 composer.getFileCandidates**（或新建 file.search 透传），不经 useFileSearch.load 的吞错层。

- **AH-E2（#8 验收假性 PASS 风险）**：#8 AC-8.2 要求「lint 通过（no-silent-catch）」。但 #4/#5 的依赖链 composer domain→useFileSearch **本身就是 silent-catch**（AH-E1）。若实现者照搬现状复用 useFileSearch，#8 AC-8.2 会**假性 PASS**（domain 自己 try/catch 了，但下游已先吞，error 永远不到 domain 的 catch）。**建议**：#4 补显式 AC「file 源错误必须从 runtime reject 一路冒泡到 search domain catch，中间不得有吞错层；domain 直调 composer.getFileCandidates 不经 useFileSearch.load」。

- **AH-E3（#6 跳转失败恢复路径未定义，高）**：AC-6.5/AC-6.6 只说「file.read 失败→toast」「session.switch 失败→toast+刷新列表」。**但跳转失败后浮层状态机无恢复定义**——§5 状态图 `open` 子态没有「跳转失败后回到哪」的转移。现 `confirmSel`（`SearchModal.vue:171-177`）是「emit select + 立即 close」：跳转与关浮层解耦，若 file.read 异步失败，浮层**已关闭**，toast 在关闭后弹出，用户无法在浮层内重选。**问题**：跳转失败时是否应**不关浮层**（让用户重选）？现状设计是先关后跳，失败只能事后 toast。requirements UC-3 异常「文件读取失败→toast」未约束浮层是否重开。**建议**：#6 补 AC「跳转失败时浮层保持打开 OR 关闭+toast 二选一」明确语义（推荐：跳转先 await 成功再关浮层，失败保持打开，符合「失败可重试」直觉）。

- **AH-E4（#6 命令执行失败无异常 AC）**：#6 三类跳转里 command 路径只有 AC-6.1（正常执行+关闭+toast），**无异常 AC**。但 command 分两子类：pi slash 注入 composer（需 active session，UC-2 异常 AC-2.4 已覆盖「无 session 提示」）+ 应用命令 action（如 newSession，可能 reject）。应用命令 action 抛错时无 AC 覆盖（与 file.read/session.switch 的异常 AC 不对称）。**建议**：#6 补 AC「应用命令 action 抛错→toast 反馈」。

- **AH-E5（#4 无 active session 查询降级未定义）**：UC-2 异常 AC-2.4「需 active session 的命令在无 session 时置灰或提示」，但 #2 命令注册表（appCommands + slashCommands）+ #4 search domain 编排里，**slash 命令是 per-session 的**（command store 按 sessionId 分区，`command.ts:48`）。当**无 active session**时：slashCommands 该 session 分区为空 → 命令分组只有应用命令；且 requirements UC-3 前置「文件搜索限当前 active session 的 cwd」，#4 domain 编排 file.search 也需 sessionId（`composer.ts:31` payload 含 sessionId）。**问题**：无 active session 时 #4 domain 的 file 源 + slash 源都无数据，整个查询退化。issues #4 无 AC 覆盖「无 active session 时的查询降级表现」。**建议**：#4 补 AC「无 active session 时 file/slash 源返空 section（应用命令源仍工作），不报错」。

### 边界值

- **AH-B1（#4 致命边界）**：`searchFiles` 是**全量递归截断**，`MAX_SEARCH_RESULTS=500`（`file-service.ts:52`「达上限停止收集，横向截断」），`MAX_SEARCH_DEPTH=8`。`file.search` handler **不接受 query 参数**（payload 仅 `{sessionId}`，`composer.ts:31`）——服务端无过滤，前端 matchFilter 全量过滤。**问题**：大项目（>500 文件）文件分组**系统性丢失**深层/后半文件，且 requirements UC-3 异常提到「>10000 文件」却无任何 AC 覆盖「结果被 500 上限截断」的提示。用户搜 `session.ts` 命中不到（因被截断在 500 之外）会以为是 bug。**建议**：#4 补 AC「文件数超 500 上限时文件分组显示截断提示（如『仅显示前 500 项，请细化查询』）」，否则是隐性数据丢失。requirements 数据清单声称「全量递归」与 500 截断事实存在漂移。

- **AH-B2（#3/#6 recents 去重键缺失）**：`RecentEntry`（§4 模型）= `{type, key, timestamp}`，但**现状 `SearchItem`（`search-data.ts:9-12`）只有 `{type, title, sub}`，无稳定 `id`/`key`**。#6 跳转后写 recents（AC-6.4 调 useRecents.write），#3 FIFO 淘汰（AC-3.2「超 5 项淘汰最旧」）。**问题**：FIFO 去重/淘汰的「相等性」依据什么？同文件不同 sub（路径）算同一 recent 吗？同会话 title 改名后算新还是旧 recent？RecentEntry.key 从哪来——用 `title`？`title+sub`？`type+title`？**issues #3/#6 均未定义 RecentEntry.key 的生成规则**。D-009（命令去重按 name）只管命令，不管 recents。**建议**：#3 补 AC「RecentEntry.key 生成规则（推荐 `type:title`，title 作稳定标识；文件/会话 sub 是路径/branch 可变，不入 key）」。

- **AH-B3（#7 两种空态被混为一谈）**：AC-3.3「recents 为空返回空数组不崩溃」只测 composable 不崩，但**SearchModal 空查询渲染**：现 `sections` computed（`SearchModal.vue:132`）在 remoteSections 为空时 → total=0 → 走 `v-else`「未找到」态（`:80-87`），文案是「未找到「{{query}}」的相关结果」——**但空查询时 query 为空**，会显示「未找到「」的相关结果」+「换个关键词试试」。**问题**：首次使用（recents 全空）+ 空查询，浮层显示**误导性空态**（像查询失败）而非 UC-1 异常流程要求的「空态提示+建议操作（输入关键词开始搜索）」。BC-6「空结果未找到态保持」+ UC-1 异常「recents 空显示空态提示」是**两种不同空态**（查询无结果 vs recents 库空），issues #7 把它们都归 BC-6「保持」，未区分。**建议**：#7 补 AC「recents 库空（非查询无结果）时显示专属引导文案，复用『未找到』模板但不带 query 引号」。

- **AH-B4（#9 selIdx 越界）**：`watch(query, ()=>{selIdx.value=0})`（`:180`），但若用户在 Tab 切类（#9）后 activeType 过滤导致可见项 < selIdx，selIdx 指向不可见项。#9 AC-9.2「activeType 非空只显所选类」未约束 selIdx 重置。快速 Tab 切 + ↑↓ 可能选中隐藏项。**建议**：#9 补 AC「Tab 切类时 selIdx 重置为 0 或 clamp 到可见范围」。

- **AH-B5（#1 极大查询串，低优）**：matchFilter/segments 是 `indexOf` 循环（`SearchModal.vue:148`），对**极大查询串**（如粘贴 10KB 文本）+ 大候选集，segments 每项 O(text×q) 重复计算。无 AC 覆盖「超长查询的性能/截断」。低优但 #1 声称「纯函数可复用」，复用方可能喂任意输入。**建议**（低优）：#1 补「超长 query（>200 字符）截断或早退」。

### 并发时序

- **AH-C1（#4/#7 loadSeq 守卫归属层未定）**：BC-9 守卫 `let loadSeq=0; const seq=++loadSeq; if(seq===loadSeq)`（`:123-128`）。#4/#7 都声称「迁移守卫到 search domain」。**问题**：#4 用 `allSettled([3 源])`——allSettled **等所有源 settle** 才 resolve，而 loadSeq 守卫是「新查询发起时丢弃旧结果」。若新查询在第 2 源 settle 前发起，旧 allSettled promise 仍 pending，旧结果可能在 loadSeq 已 ++ 后才 resolve——此时 `seq===loadSeq` 为 false，旧结果被正确丢弃 ✅。**但**：domain 返回 `Promise<Section[]>`，loadSeq 守卫须在**调用方（SearchModal）侧**还是 domain 内部？issues #4 AC-4.4「乱序响应保护」未指定守卫归属层。若守卫进 domain（domain 内部 loadSeq），则 SearchModal 无法对「用户快速连查」做早取消（domain promise 仍 pending 占资源）。若两层都守卫会冲突。**建议**：#4 明确 AC「loadSeq 守卫在 domain query() 内部维护，SearchModal 只 await，不重复守卫」。

- **AH-C2（#4/#10 顺序倒挂——无 debounce 的性能炸点）**：现状 `watch(query)` **无 debounce**（`:180`，直接 loadResults），每次按键都发 file.search（全量递归 depth8）+ session.list + getCommands 3 个 WS。#4 domain 用 allSettled 每次按键触发 3 源全量拉取——**但 file 源已有 useFileSearch session 级缓存**（`useFileSearch.ts:33` 缓存命中直接返）。**问题**：若 #4 domain 不复用 useFileSearch 缓存，每次按键都全量递归（大项目 500 文件×每次按键），即使 debounce（#10.3 的 120ms）后仍可能连发。requirements UC-2 要求 debounce 120ms 列在 #10（P2 待⑤确认），但 #4（P1 先做）若先落 domain，**P1 阶段就已有无 debounce 的性能炸点**，而 debounce 在 P2。**顺序倒挂**：#4 依赖的防抖在更晚的 #10。**建议**：#4 落地时至少复用 useFileSearch 缓存（file 源不重复全量递归），或将 debounce 从 #10 提前到 #4/#7（P1）。

- **AH-C3（#3 recents 写入并发 FIFO 一致性，低优）**：useRecents.write 是 localStorage 同步操作（§3 数据清单），但快速连续确认跳转（如双击/Enter 抖动）+ FIFO 淘汰，timestamp 单调递增假设在「同毫秒连续 write」时可能撞值（Date.now() 精度 ms）。AC-3.4「timestamp 单调递增」。**问题**：同毫秒两次 write 的 FIFO 排序不确定。低概率但 AC 要求单调。**建议**（低优）：#3 用计数器兜底（`Math.max(stored)+1`）而非裸 Date.now()。

- **AH-C4（#7 浮层 open/close 快速交替，低优）**：`watch(props.open, isOpen=>{ isOpen?loadResults():query='' })`（`:182-185`）。快速 open→close→open 会触发 loadResults×N + query 清空×N + loadSeq 累加。无 debounce/节流。#7 BC-11「保持」但未约束快速交替。低优。

- **AH-C5（#7/#10 ⌘K toggle 事实错误——跨 issue 事实漂移，高）**：BC-1/AC-7.1 声称「再按⌘K 关闭」。**现状 `Sidebar.vue:236` 是 `searchOpen.value = true`（无条件置 true，非 toggle）**。即「再按⌘K 关闭」**根本不是现状行为**，是 issues 把 spec 目标当成现状契约。#7 AC-7.1「⌘K 唤起 + Esc/再按⌘K/点遮罩关闭均保持」——但现状「再按⌘K」不会关（只 true）。**这不是保持（现状本就没有），是实现 #7 时要新增 toggle 逻辑**。归类「等价保持」掩盖了它是新增行为。**建议**：#7 AC-7.1 拆出「再按⌘K 关闭」为**变更项**（非保持），避免实现者误以为现状已支持。（注：Sidebar keydown 搭便车 #10.1 会重构此 listener，toggle 应在那时落。）

### 状态机死角

- **AH-S1（#8 §5 error 态在状态图里是孤岛）**：architecture §5 文字列出 `error` 派生态（「查询/跳转失败」），但**状态图 mermaid 里没有 error 节点，也没有任何进入/退出 error 的转移边**（与角色 A 的 M-2 转换枚举缺口印证）。D-014 松散状态机（computed 派生）成立，但「error 态如何恢复」未定义——查下一查询自动清除？手动关闭重开？error 态下用户能否继续 ↑↓ 导航（此时 sections 可能部分有结果部分空）？#8 把 error 当 transient ref，但 ref 的清除时机（新查询成功时清？永不清直到关浮层？）无 AC。**建议**：#8 补 AC「error ref 在新查询成功时清除 / 组件 close 时重置」明确生命周期。

- **AH-S2（#8 error 态查询路径不可达——机制矛盾）**：§5 状态图 `loading→query_results` / `loading→empty` 有，**`loading→error` 缺**。查询中某源失败时，loading 是否继续显示直到 allSettled resolve？allSettled 是「全部 settle 才 resolve」，故 loading 实际持续到全部源完成，失败源返空 section——**这种情况下查询根本不进 error 态**（allSettled 不抛）。即 #8 的 error 态在查询路径上**几乎不可达**（allSettled 吞了单源错误），只有**跳转路径**（file.read/session.switch 非 allSettled）能进 error。**问题**：§5 把 error 态描述为「查询/跳转失败」，但查询路径因 allSettled 不会进 error，只有跳转会。状态机描述与实现机制不符。**建议**：#8 明确「error 态仅由跳转失败触发；查询单源失败由分组空态表达（非全局 error）」，与 §5 描述对齐。

- **AH-S3（#9 type_filtered 态与 recents 态正交未定义）**：Tab 切类（#9）在空查询（recents 态）时是否生效？activeType 非空 + 空查询 → 显示「过滤后的 recents」还是「过滤后的空」？§5 状态图 `recents` 与 `type_filtered` 是正交两个维度但画在同一子状态机里，无交叉规则。**建议**：#9 补 AC「空查询 + Tab 切类：显示该类型的 recents 子集」。

### 删除测试（伪 issue 检查）

> 对每个 issue 问「不做它会怎样」。结论：**无硬伪 issue**（10 个 issue 均有上游架构 §7/§5/§11/§12 或 requirements AC 锚点），但发现 **2 个可降级/合并项** 与 **1 个顺序倒挂**：

- **#5（api 接线，~5 LOC）疑似过细**：#5 单独成 issue 价值是 grep AC-1 硬验收，但实质是 #4（search domain）落地的最后一步接线（`api/index.ts:42` 改三元）。现状它 Blocked by #4 且无独立方案分歧（方案 A 唯一，方案 B「删 mock」被否）。**不做 #5（并入 #4）会怎样**：#4 交付时顺手改 api/index.ts 一行即可，grep AC-1 仍在 #4 验收。**判定**：非伪 issue（G2 硬验收点独立可见有价值），但**可考虑并入 #4 降合并成本**——供主 agent 权衡，非阻断。

- **#1（匹配引擎提取）的「未来复用」论据偏弱**：#1 把 segments 提取为纯函数模块，理由是「两消费者（search domain matchFilter + SearchModal segments）」。**问「不提取会怎样」**：search domain 内重写一遍 matchFilter（子串 indexOf，~10 行），SearchModal 保留 segments——逻辑重复但量极小。#1 选择提取是为「未来复用（composer 候选过滤）」。**判定**：非伪（D-012 已排除伪 port，纯函数提取是合理归位），但「未来复用」论据偏弱（composer 已有自己的 `lib/file-candidates.ts`），主 agent 可留意勿过度抽象。

- **顺序倒挂（非伪 issue，是依赖问题）**：AH-C2——#4（P1）依赖的 debounce 在 #10（P2）。若严格按 Wave，P1 落地的 #4 会带无 debounce 的性能问题直到 P2 才修。**建议**：将 debounce 从 #10 提升到 #4 或 #7（P1）。

## gap 汇总（带 F/K/D 分类）

| gap_id | 分类 | 关联 issue | 严重度 | 摘要 |
|--------|------|-----------|--------|------|
| AH-E1 | F | #4/#8 | **致命** | useFileSearch.load `catch{return []}` 静默吞 file.search 错误（`useFileSearch.ts:35-43`）；#4 若复用则 file 源失败永不冒泡，#8 AC-8.2「不静默」假性 PASS。domain 须直调 composer.getFileCandidates 不经吞错层 |
| AH-B1 | F | #4 | **致命** | searchFiles `MAX_SEARCH_RESULTS=500` 横向截断（`file-service.ts:52`），file.search 无 query 服务端过滤（payload 仅 sessionId）；大项目文件系统性丢失且无截断提示 AC，与 requirements「全量递归」描述漂移 |
| AH-C5 | F | #7/#10 | **高** | 「再按⌘K 关闭」非现状（`Sidebar.vue:236` 是 `=true` 非 toggle）；BC-1/AC-7.1 把它当「保持」掩盖了是**新增行为**，应拆为变更项 |
| AH-E3 | D | #6 | **高** | 跳转失败恢复路径未定义：confirmSel 先 close 后跳，file.read 失败时浮层已关、toast 事后弹、用户无法浮层内重选；#6 须明确「跳转失败保持打开 or 关闭+toast」 |
| AH-E2 | K | #4/#5/#8 | **高** | error 冒泡链跨 3 issue 无人统管：#4 编排 / #5 接线 / #8 验收，须补端到端 AC「error 从 runtime reject 一路到 toast 不得中途吞」 |
| AH-S1 | D | #8 | 中 | §5 状态图缺 error 节点与恢复转移（与角色 A 的 M-2 印证）；error ref 清除时机无 AC |
| AH-S2 | K | #8 | 中 | error 态查询路径不可达（allSettled 吞单源错误），仅跳转可达；§5「查询/跳转失败」描述与 allSettled 机制矛盾，须对齐 |
| AH-E5 | D | #4 | 中 | 无 active session 时 file/slash 源均空，查询退化表现无 AC 覆盖 |
| AH-B2 | D | #3/#6 | 中 | RecentEntry.key 生成规则未定义（SearchItem 无稳定 id），FIFO 去重/淘汰相等性无依据 |
| AH-B3 | D | #7 | 中 | 「recents 库空」与「查询无结果」是两种空态，BC-6 混为一谈；首用+空查询会显误导性「未找到""」 |
| AH-C1 | K | #4/#7 | 中 | loadSeq 守卫归属层未定（domain 内 vs SearchModal 侧），两层守卫会冲突 |
| AH-C2 | K | #4/#7/#10 | 中 | #4(P1) 依赖的 debounce 在 #10(P2)，P1 阶段有无 debounce 性能炸点；顺序倒挂 |
| AH-E4 | D | #6 | 中 | 应用命令 action 抛错无异常 AC（与 file/session 跳转不对称） |
| AH-B4 | D | #9 | 低 | Tab 切类后 selIdx 可能指向被过滤隐藏项，需 clamp |
| AH-C3 | D | #3 | 低 | 同毫秒连续 write 的 FIFO timestamp 单调性（低概率） |
| AH-C4 | D | #7 | 低 | 浮层快速 open/close 交替无节流（BC-11「保持」未约束） |
| AH-B5 | D | #1 | 低 | 极大查询串（>200 字符）segments 性能无截断 AC |
| AH-S3 | D | #9 | 低 | type_filtered 态与 recents 态（空查询）正交规则未定义 |

## 备注

- **未触发 [REVISIT of D-NNN]**：本轮无新证据推翻任何已 confirmed 决策。最相关的 D-003（复用 searchFiles 全递归）经核验**成立**（`file-service.ts:161` searchFiles 确为 depth8 全递归，D-003「已就绪」属实）——但附新事实：500 结果上限截断（AH-B1）是 D-003 未提及的副作用，记为 gap 而非 REVISIT（不推翻「复用 searchFiles」决策，仅补充边界）。D-015/D-019（搭便车 debounce）经核验**现状确实无 debounce**（`SearchModal.vue:180` 直接 loadResults），决策成立，但暴露顺序倒挂（AH-C2）。
- **伪 issue 结论**：无硬伪 issue；#5（~5 LOC 接线）可考虑并入 #4 降合并成本（供主 agent 权衡，非阻断）；#1 的「未来复用」论据偏弱但非伪。
- **与角色 A 印证点**：AH-S1（error 孤岛）与 M-2（状态转换枚举虚覆盖）指向同一缺口；AH-E1/E3/S2（error 机制级缺陷）在角色 A 的 M-1（error 归属错配，覆盖表层）之下挖到实现层。两帧正交互补。
- **最严重 3 条**：①AH-E1（file.search 静默吞错，#8 验收假性 PASS）②AH-B1（500 截断无提示的隐性数据丢失）③AH-C5（⌘K toggle 被误当现状契约，实为新增行为）。
- 所有 F 类均经源码行号核验；K 类为跨 issue 协同缺口；D 类为完整性补遗。
