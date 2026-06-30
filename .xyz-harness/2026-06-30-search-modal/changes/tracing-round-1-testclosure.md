---
phase: execution
frame: testclosure
converged: false
---

# 测试闭环审计 + 实现闭环审计 — execution-plan.md

> 审计视角：测试闭环（Wave→test-matrix 用例 ID 覆盖）+ 实现闭环（验收 Wave / 测试验收清单 / 交接硬契约）。
> 审计对象：⑥execution-plan.md（被追踪）vs ⑤code-architecture.md §6 test-matrix + §4 异常路径 / ④NFR 缓解项回灌表 / ③issues.md AC。
> 决策账本纪律：status=confirmed 的决策不当 gap 重报；仅标下游新证据证伪的为 `[REVISIT of D-NNN]`。

## 审计结论

**verdict: GAP_FOUND（gap 数：4）**

测试验收清单的**集合完整性 + 实现闭环骨架 PASS**（清单 47 条 = ⑤test-matrix 全量，MISSING=0/PHANTOM=0/MISMATCH=0；Wave5 存在/blocked_by Wave1-4/DAG 末端；交接为硬契约 DoD=清单全绿；功能归属 Wave × 测试执行层双列清晰）。

**4 个 gap 均为 F（事实）类**，集中在「⑤§4 时序图异常路径表 ↔ §6 用例 ID 映射标签系统性错位」——映射关系本身（哪个 alt 分支映射哪个用例）正确（用例被覆盖），但⑤§4 异常路径表的「异常用例」列引用的 ID 系统性指向了语义不符的用例（多为偏移 ±1 或邻位混淆）。这不阻塞执行计划本身（执行计划 Wave 覆盖用的是正确的 §6 ID），但会误导 Wave5 验收 subagent 按⑤§4 异常路径表的 ID 做断言核对时落错用例。建议执行计划内显式覆盖⑤§4 的错误标签（执行计划是唯一真相源），或标注「以执行计划清单 ID 为准，⑤§4 异常路径表 ID 仅供溯源」。

## 集合比对结果

### 三方集合比对：⑤test-matrix 全量 vs execution-plan 清单 vs 各 Wave 覆盖

**⑤test-matrix 全量用例（47 唯一 ID）**：
- UC-1：T1.1~T1.18（18，其中 T1.16/17/18 来源 B）
- UC-2：T2.1~T2.7（7）
- UC-3：T3.1~T3.9（9，其中 T3.3/T3.9 双源）
- UC-4：T4.1~T4.9（9，其中 T4.8/T4.9 双源）
- UC-5：T5.1~T5.4（4）
- 合计 47 唯一 ID（来源 A 44 + 来源 B 专属 3 = T1.16/17/18）

**execution-plan 测试验收清单（47 行，L388-436）**：逐行收集 → 47 唯一 ID。

**集合比对结论**：
- **MISSING（清单有 ⑤有 但无 Wave 覆盖）= 0**
- **PHANTOM（Wave 覆盖了但 ⑤没有）= 0**
- **MISMATCH（ID 集合不一致）= 0**

清单用例 ID 集合 ⊆ 各 Wave「覆盖的 test-matrix 用例 ID」并集，且并集 = ⑤test-matrix 全量（47=47）。三方集合完全一致。

### 各 Wave 覆盖核验（独立重新统计）

| Wave | 清单声称 | 独立重数 | 具体 ID | 一致 |
|------|---------|---------|---------|------|
| Wave1 | 7 | 7 | T1.8, T1.9, T1.16, T1.17, T1.18, T2.4, T2.5 | ✅ |
| Wave2 | 26 | 26 | T1.10, T1.12, T2.1, T2.2, T2.3, T2.6, T2.7, T3.1~T3.6, T3.9, T4.1~T4.9, T5.1~T5.3 | ✅ |
| Wave3 | 13 | 13 | T1.1, T1.2, T1.3, T1.4, T1.6, T1.7, T1.11, T1.13, T1.14, T1.15, T3.7, T3.8, T5.4 | ✅ |
| Wave4 | 1 | 1 | T1.5 | ✅ |
| 合计 | 47 | 47 | — | ✅ |

**Wave 详情覆盖 vs 清单双向一致核验**：
- Wave1 详情（L128-130）= 清单 Wave1 = 7 条 ✅
- Wave2 #4（16）+ #6（10）= 26，无重叠 ✅；Wave2 详情 = 清单 Wave2 ✅
- Wave3 详情（L246-251）= 清单 Wave3 = 13 条 ✅
- Wave4 详情（L311）= 清单 Wave4 = 1 条 ✅

### 来源 B NFR 用例归属 Wave 核验

| 来源 B 用例 | ⑤§6 强制层级 | 清单归属 Wave | 清单测试执行层 | 一致 |
|------------|--------------|--------------|---------------|------|
| T1.16（MR-3.1） | unit | Wave1 | unit | ✅ |
| T1.17（MR-3.3） | unit | Wave1 | unit | ✅ |
| T1.18（MR-3.4） | unit | Wave1 | unit | ✅ |
| T3.3（MR-4.2） | integration | Wave2 | integration | ✅ |
| T3.9（MR-4.4） | integration | Wave2 | integration | ✅ |
| T4.8（MR-17.1） | integration | Wave2 | integration | ✅ |
| T4.9（MR-4.2） | integration | Wave2 | integration | ✅ |

7/7 NFR 用例归属 Wave + 测试执行层全部与⑤§6 强制层级一致。

### 测试执行层整体核验

执行计划清单「测试执行层」列分布：unit（Wave1 全 7 + Wave2 的 T1.10/T1.12/T2.1/T3.1/T3.2/T3.5/T4.1/T4.2/T4.5/T5.1/T5.2 = 18）/ integration（其余 29）。与⑤§6 来源 B 强制层级无冲突（来源 B 标 integration 的全为 integration，标 unit 的全为 unit）。来源 A 用例⑤未标强制层级，执行计划自行划层（模块叶子/容错=unit，UC 集成断言=integration），分层合理（叶子模块单测 + 集成 mount SearchModal）。

## gap 清单

### GAP-TC-1 [F 事实]：⑤§4 功能2 异常路径表「异常用例」列 ID 系统性错位（6/8 错）

- **位置**：⑤code-architecture.md §4 功能2 异常路径表（L350-359）。
- **问题**：异常分支本身被 Wave 覆盖（用例存在），但⑤§4 表「异常用例」列引用的 ID 与⑤§6 用例语义不符，系统性偏移：
  - session 源 WS reject → 标「T4.3 异常」；**应= T4.4**（T4.3 是「选中会话切换」正常态，T4.4 才是 session 源 WS reject→分组空态）
  - WS 断连永不 settle → 标「T4.7 异常（NFR）」；**应= T4.8**（T4.7 是「跳转成功 active session 切换」，T4.8 才是 WS 超时 race NFR）
  - 全源失败 → 标「T4.8 异常（NFR）」；**应= T4.9**（T4.8 是超时 race，T4.9 才是全源失败 toast）
  - activeSessionId=null → 标「T1.4 边界」；**应= T1.10**（T1.4 是选中态视觉，T1.10 才是无 active session）
  - 乱序响应 → 标「T1.5 并发」；**应= T1.12**（T1.5 是 Tab 切类，T1.12 才是乱序响应 loadSeq）
  - （正确）file WS reject → T3.3；文件数>5000 → T3.5
- **风险**：执行计划 Wave 覆盖用的是正确的 §6 ID（无继承错误），但 Wave5 验收 subagent 若以⑤§4 异常路径表为溯源做断言核对，会落错用例。
- **建议修订**：执行计划在「测试验收清单」或各 Wave「覆盖的 test-matrix 用例 ID」节追加一句「⑤§4 异常路径表的『异常用例』列 ID 与本清单不一致处以本清单为准，⑤§4 仅供分支语义溯源」。或回流⑤修订§4 异常用例列。

### GAP-TC-2 [F 事实]：⑤§4 功能3 异常路径表「异常用例」列 ID 错位（3/5 错）

- **位置**：⑤code-architecture.md §4 功能3 异常路径表（L423-429）。
- **问题**：
  - command action 抛错 → 标「T2.5 异常」；**应= T2.6**（T2.5 是需 active session 命令无 session，T2.6 才是 action 抛错）
  - session.switch reject → 标「T4.5 异常」；**应= T4.6**（T4.5 是会话库空，T4.6 才是 switch 失败）
  - symbol 选中 → 标「T5.2 边界」；**应= T5.3**（T5.2 是占位不随查询变化，T5.3 才是 symbol 选中不跳转）
  - 跳转成功路径 → 标「T2.6/T3.6/T4.6 状态」；语义应为「先 await 成功再关浮层」对应 T2.7/T3.6/T4.7（成功关闭）+ T2.6/T4.6（失败保持打开），混列了成功与失败路径（T2.6/T4.6 是失败非成功）
  - （正确）file.read reject → T3.4
- **风险**：同 GAP-TC-1，Wave5 溯源落错用例。
- **建议修订**：同 GAP-TC-1。

### GAP-TC-3 [F 事实]：⑤§4 功能4 异常路径表「异常用例」列 ID 错位（3/5 错）

- **位置**：⑤code-architecture.md §4 功能4 异常路径表（L466-472）。
- **问题**：
  - 快速 open/close 交替 → 标「T1.6 并发」；**应= T1.13**（T1.6 是三种关闭，T1.13 才是快速 open/close 交替）
  - close 孤儿查询 → 标「T1.7 并发（NFR）」；**应= T1.14**（T1.7 是高亮，T1.14 才是 close 孤儿查询守卫）
  - 组件卸载资源清理 → 标「T1.8 资源（NFR）」；**应= 无直接对应用例**（T1.8 是 recents 库空；资源清理 AC-8.4/MR-8.1 未在 test-matrix 单列用例，属「已在③」类）→ 标注为 phantom 引用
  - （正确）查询>200ms → T3.7；查询<200ms → T3.8
- **风险**：同 GAP-TC-1。
- **补充**：组件卸载资源清理（AC-8.4）在⑤§6 无独立用例 ID（属 MR-8.1「已在③」类），⑤§4 引用「T1.8 资源」是 PHANTOM 引用（T1.8 不是资源清理用例）。这暴露 test-matrix 对「组件卸载 clearTimeout」缺独立用例——但⑤已自检覆盖（MR-8.1 回灌③issues #8 AC-8.4，属接受的不单列）。归为标注瑕疵非覆盖缺失。
- **建议修订**：同 GAP-TC-1。

### GAP-TC-4 [F 事实]：T2.5 归属 Wave1 但其「执行失败保护」语义跨 Wave1(#2 列表) + Wave2(#6 执行)

- **位置**：execution-plan.md L129（Wave1 #2 覆盖列含 T2.5）+ L412（清单 T2.5 归 Wave1）。
- **问题**：T2.5「需 active session 命令无 session 时不静默执行失败」语义含两部分——① 列表层（useCommandRegistry.list 无 session 时 slash 区返空，Wave1 #2）② 执行层（选中时若仍命中需 session 的命令不静默失败，Wave2 #6 useSearchJump.confirm）。当前 T2.5 主归属 Wave1，但 Wave2 #6 覆盖列（L182-186）**未列 T2.5**。⑤§3 useCommandRegistry.list 边界表确含「无 session→slash 区空」，故 T2.5 主归 Wave1 合理（列表层是行为主战场）；但若用例断言含「选中执行不静默失败」，则执行侧需 Wave2 #6 协同标注。
- **风险**：低。T2.5 关联 AC-2.4（③issues #2 AC-2.4 = appCommands 静态注册 + slash 随 session 刷新，是列表/注册语义非执行语义），故主归 Wave1 与 AC-2.4 一致。无 session 时 slash 区直接返空（列表层就不出现该命令），「执行失败」分支实际不可达（选不到）——故 Wave1 单归属可自洽。
- **建议修订**：建议在 T2.5 断言摘要显式注明「无 session 时 slash 命令不进列表（列表层保证），故不存在『选中后静默失败』执行路径」，消除「执行失败」措辞带来的跨 Wave 误读。无需改归属。

## 逐视角审计记录

### 测试闭环审计

| 审计项 | 结论 | 证据 |
|--------|------|------|
| 每个 Wave 标注覆盖的⑤test-matrix 用例 ID（含来源 B） | ✅ PASS | Wave1/2/3/4 各有「覆盖的 test-matrix 用例 ID」节；来源 B 用例（T1.16/17/18/T3.3/T3.9/T4.8/T4.9）均显式标「来源B」 |
| 各 Wave 覆盖并集 = ⑤test-matrix 全量 | ✅ PASS | 47=47，MISSING=0/PHANTOM=0/MISMATCH=0（见集合比对） |
| ⑤§4 异常分支都落在某 Wave 覆盖 | ⚠️ PARTIAL | 分支被覆盖（正确 §6 ID），但⑤§4 异常路径表自身 ID 标签错（GAP-TC-1/2/3） |
| 来源 B NFR 用例归属 Wave 正确 | ✅ PASS | 7/7 与⑤§6 强制层级一致（见来源 B 核验表） |
| 清单「测试执行层」列 vs⑤§6 来源 B 强制层级 | ✅ PASS | 7/7 一致；来源 A 分层合理 |

### 实现闭环审计

| 审计项 | 结论 | 证据 |
|--------|------|------|
| 「测试验收清单」章节存在 | ✅ PASS | execution-plan L381-450「测试验收清单（Test Acceptance Manifest）— [MANDATORY]」 |
| 清单用例 ID 集合 = ⑤test-matrix 全量（A+B） | ✅ PASS | 47 行，MISSING=0/PHANTOM=0（与⑤集合比对一致） |
| 末尾验收 Wave（Wave5）存在 | ✅ PASS | L333-366「Wave 5: 验收 Gate」 |
| Wave5 blocked_by 所有功能 Wave | ✅ PASS | L337「Blocked by: Wave1, Wave2, Wave3, Wave4」 |
| Wave5 在 DAG 末端 | ✅ PASS | mermaid L43-44「W3-->W5; W4-->W5」；W5 无出边 |
| 每个功能 Wave 覆盖的用例 ID 在验收清单出现（双向一致） | ✅ PASS | Wave 详情覆盖 = 清单归属（4 个 Wave 全核验通过，见各 Wave 覆盖核验） |
| 清单「功能归属 Wave」×「测试执行层」双列清晰非混用 | ✅ PASS | L388 表头「功能归属 Wave | 测试执行层」两列独立；未混用 |
| 交接措辞为硬契约（DoD=测试验收清单全绿） | ✅ PASS | L20「测试验收清单全绿」；L466「编码完成的定义 = 测试验收清单全绿（47 条全 PASS）」；L468「末尾验收 Wave 未绿 = 实现未完成」 |
| 偏离通道（[DEVIATED] 登记）存在 | ✅ PASS | L472「编码中发现用例设计错误/不可行，走 [DEVIATED] 登记」 |

## 用例归属核验记录（逐条特别核验）

### T1.3 归 Wave3（主）+ scrollIntoViewIfNeeded 在 Wave4 #10.2 — 协同标注合理性

**判定：合理 ✅**
- T1.3 核心是「↑↓ 跨组扁平化导航 + 循环包裹」UI 集成行为，主属 SearchModal 渲染层（Wave3 #7）。
- scrollIntoViewIfNeeded 是搭便车 spec 合规修复（BC-7，D-019 确认留 P2=Wave4 #10.2）。
- execution-plan L446 明确标「T1.3（↑↓导航 + scrollIntoViewIfNeeded）：主 Wave3，scrollIntoViewIfNeeded 算法在 Wave4 #10.2」——跨 Wave 协同标注已显式声明，无歧义。
- **注意**：T1.3 断言摘要含「scrollIntoViewIfNeeded 滚动到选中项」（⑤§6 L522）。这意味着 T1.3 完整 PASS 需 Wave4 #10.2 先落地（scrollIntoView→IfNeeded 改造）。但 T1.3 主归 Wave3。**潜在顺序约束**：Wave5 验收 T1.3 全绿需 Wave3（导航骨架）+ Wave4（scroll API 改造）均完成——Wave5 blocked_by Wave1-4 已覆盖此约束，故闭环成立。建议 T1.3 断言拆分（Wave3 验导航+循环包裹，Wave4 验 scrollIntoViewIfNeeded）以避免 Wave3 单独验收时假性 PASS，但归属本身合理。

### T1.6 归 Wave3（主）+ ⌘K toggle 的 Sidebar 侧在 Wave4 #10.1 — 协同标注合理性

**判定：合理 ✅**
- T1.6 核心是「三种关闭方式（Esc/再按⌘K/点遮罩）」，主属 SearchModal 关闭行为（Wave3 #7）。
- ⌘K toggle 的 Sidebar 侧（Sidebar.vue:236 `=true`→toggle）是 AH-C5 变更项，搭便车 Wave4 #10.1（D-004 消除硬编码时顺势改 toggle）。
- execution-plan L447 + L268 明确标协同；AC-7.1（Wave3）与 AC-10.1（Wave4）双向引用「与 AC-7.1 协同」。
- **顺序约束**：T1.6「再按⌘K 关闭」完整 PASS 需 Wave4 #10.1 落地 toggle。同 T1.3，Wave5 blocked_by Wave1-4 覆盖。Wave3 验收时若 ⌘K toggle 尚未实现，T1.6 的「再按⌘K」断言会 FAIL——但这是 Wave5 整体验收的事，Wave3 内验「Esc/点遮罩关闭」即可，归属合理。建议清单 T1.6 状态在 Wave3 阶段标「部分待 Wave4」。

### T1.7 归 Wave3（DOM 渲染）+ segments 算法在 Wave1 #1 — 分工清晰度

**判定：清晰 ✅**
- T1.7 是「命中子串 `<mark>` 高亮」UC 集成断言（mount SearchModal 验渲染），主归 Wave3（integration 层）。
- segments 纯函数（matchFilter + segments）在 Wave1 #1（lib/match-engine.ts，叶子模块单测）。
- execution-plan L128 明确「#1 match-engine：无直接 UC 用例（纯函数由模块单测验，segments/matchFilter 的端到端高亮/过滤断言归 Wave3 #7）」+ L448「segments 算法在 Wave1 #1（Wave1 模块单测覆盖纯函数，UC 集成断言归 Wave3）」——**分工边界清晰**：Wave1 验纯函数（grep 无副作用 + 空查询边界 + 行为等价 BC-4），Wave3 验 UC 渲染（`<mark>` DOM 断言）。
- 两层正交无重叠，符合「叶子模块单测 + 集成 mount」分层原则。

### T2.5 归 Wave1 是否正确（需 active session 的命令无 session，AC-2.4 属命令注册表 #2）

**判定：主归属正确但措辞有歧义 → GAP-TC-4**
- T2.5 关联 AC-2.4（③issues #2 AC-2.4 = 「appCommands 启动一次性注册（静态，无 session 关联）；slashCommands 随 session 切换刷新」）。
- 行为本质：无 session 时 slash 命令区返空（useCommandRegistry.list 边界，Wave1 #2），故列表层就不出现需 session 的 slash 命令——「选中执行」分支不可达。
- 主归 Wave1 与 AC-2.4（注册/列表语义）一致 ✅。
- 但 T2.5 断言措辞「不静默执行失败」暗示执行层（Wave2 #6）参与，而 Wave2 #6 覆盖列未含 T2.5。**实际无矛盾**（列表层保证选不到，执行层不需守），但措辞易误读。见 GAP-TC-4。

### T5.4 归 Wave3（占位渲染失败容错）是否正确

**判定：正确 ✅**
- T5.4「占位渲染失败容错（符号分组隐藏，其他类正常）」是 **UI 渲染容错**断言（mock 符号分组渲染抛错时，命令/文件/会话三类仍正常渲染，不阻断）。
- 这是 SearchModal 渲染层行为，主归 Wave3 #7（SearchModal 改造 + 集成测试 mount SearchModal）✅。
- 与 T5.1/T5.2（符号占位渲染 + 占位不随查询变化，归 Wave2 useSearch 分组逻辑）区分清晰：T5.1/5.2 验「数据/分组层占位存在且恒定」（Wave2 useSearch 插占位 section），T5.4 验「渲染层容错」（Wave3 SearchModal 渲染抛错不阻断）。两层正交。
- **无跨 Wave 协同问题**：T5.4 纯渲染层，Wave3 独立可验。

## 附：覆盖完整性自检交叉确认

- ⑤§6「覆盖完整性自检」7 条 checkbox 全勾——本审计独立复核其「时序图每个 alt/else 映射 ≥1 异常用例」声明：**映射关系成立**（每个分支确有覆盖用例），但**⑤§4 异常路径表自身 ID 标签错**（GAP-TC-1/2/3）。即⑤自检的是「有无映射」非「映射 ID 是否正确」——映射存在性 PASS，映射标签准确性 FAIL。
- decisions.md confirmed 决策（D-001~D-026）均未与本审计发现冲突，无 `[REVISIT]` 触发。
