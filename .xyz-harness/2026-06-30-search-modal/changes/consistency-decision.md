---
dimension: decision
verdict: INCONSISTENT
---

# 决策一致性审计（维 4 · 决策守护）

> 权威索引：`decisions.md`（D-001~D-027）。逐决策对账①~⑥。
> 审计维度：confirmed 决策是否在①~⑥各 .md 中被静默偏离；revisit 链是否完整；D-不可逆决策在④⑤⑥是否被守护。

## Verdict

**INCONSISTENT**（4 处矛盾，均为⚠️级「措辞残留/未完成反哺」，无❌级静默推翻）。

- **0 处❌ 静默推翻**：无任何 D-不可逆 confirmed 决策被实质性推翻。所有 D-026（最重的 D-不可逆 REVISIT）的核心立场在④⑤⑥均已落地，①②已同步反哺。
- **4 处⚠️ 残留**：③ issues.md 在 D-026 后**正文未做系统性措辞修订**，仍大量沿用「search domain / domain query()」旧称；④ NFR 缓解项表/骨架验证表的「回灌去向」列仍指向「⑤骨架 search domain query()」未随 D-026 改写；这些有部分 `[BACKFED]` 标注但未穷尽。另有 1 处 D-026 的「recents/命令聚合提取为 lib 纯函数」细节在⑤未落地（轻微）。
- **revisit 链完整**：D-019→D-020、原 #4 domain→D-026 两条 revisit 链 superseded_by 指向 + 新决策 confirmed_by=ask_user（D-026 不可逆已 ask_user）齐备。✅
- **D-027（5-Wave 细化）与⑤§8 一致**：⑤§8 授权⑥推导（3-Wave 粗粒度→5-Wave 工程细化），D-027 明示「非推翻⑤§8」，⑤§8 与⑥ Wave DAG 在 P 级分层上一致，⑥只在文件冲突/消费依赖上细化。✅

**结论**：无决策被静默推翻，设计意图未被篡改，但③ issues.md 对 D-026 的反哺**不完整**（正文残留 domain 旧称未清零），与「反哺纪律：事实性矛盾必修订」存在张力——是文档卫生问题，非决策失守。建议 Step 6b 补一轮③措辞清扫。

## decisions.md 对账（逐决策 D-001~D-027）

| ID | 分类 | confirmed_by | ①req | ②arch | ③issues | ④nfr | ⑤code-arch | ⑥exec | 备注 |
|----|------|-------------|------|-------|---------|------|-----------|-------|------|
| D-001 四类范围（符号降级） | 不可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 全链一致（符号占位不调 api）|
| D-002 符号占位 UI 保留 | 可逆 | agent | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-003 文件只搜路径不搜内容/不引 rg | 不可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-004 统一命令注册表 | 不可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | useCommandRegistry + command store 扩展全链一致（见专项核验）|
| D-005 会话全局跨项目 | 不可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-006 三类真实跳转 | 不可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-007 recents localStorage/每类5/共20 | 可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-008 不做危险命令分级 | 可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-009 命令按 name 去重 | 可逆 | agent | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-010 会话跳转不进概览 | 可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-011 三层不建 DDD 四层 | 不可逆 | ask_user | ✅ | ✅ | ✅(N/A) | ✅ | ✅ | ✅ | ③/④无 domain 议题，⑤§2 三层一致 |
| D-012 不做 port | 不可逆 | ask_user | ✅ | ✅ | ✅(N/A) | ✅ | ✅ | ✅ | |
| D-013 纯 DTO/无 aggregate | 不可逆 | ask_user | ✅ | ✅ | ✅(N/A) | ✅ | ✅ | ✅ | |
| D-014 浮层松散状态机 | 可逆 | ask_user | — | ✅ | ✅ | ✅ | ✅ | ✅ | ①未涉及（正常）|
| D-015 搭便车 3 项候选 | 可逆 | ask_user | — | ✅ | ✅ | ✅ | ✅ | ✅ | 被 D-019 revisit（debounce 升级）|
| D-016 两区物理隔离 appCommands+slash | 不可逆 | agent | — | ✅ | ✅ | ✅ | ✅ | ✅ | ⑤§3+⑥Wave1#2 一致（见专项核验）|
| D-017 P0/P1 划线基础设施先行 | 可逆 | ask_user | — | — | ✅ | ✅ | ✅ | ✅ | ⑥Wave1=P0 一致 |
| D-018 loading/error P1 / Tab P2 | 可逆 | ask_user | — | — | ✅ | ✅ | ✅ | ✅ | |
| D-019 搭便车3项 P2（含debounce） | 可逆 | ask_user | — | — | ✅ | — | — | — | **revisited** → superseded_by D-020 |
| D-020 debounce 提前到 #7 | 可逆 | ask_user | — | — | ✅ | ✅ | ✅ | ✅ | AC-7.15+⑥Wave3 一致（见专项核验）|
| D-021 5000 截断 | 可逆 | ask_user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 全链 5000 一致（见专项核验）|
| D-022 loadSeq 骨架约束不单列 NFR-AC | 可逆 | ask_user | — | ✅ | ✅ | ✅ | ✅ | — | |
| D-023 #17 独立 issue（WS 超时 race） | 不可逆 | ask_user | — | — | ✅ | ✅ | ✅ | ✅ | ⑥Wave2「#17 物理合并入 #4」与 issue 独立性不冲突（见专项核验）|
| D-024 AC-6.9 直调 fileApi.read | 可逆 | agent | — | — | ✅ | ✅ | ✅ | ✅ | ⑤§3+⑥Wave2#6 一致（见专项核验）|
| D-025 DTO 映射（real 异构 DTO） | 可逆 | agent | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| D-026 编排归 composable 不建 search domain | 不可逆 | ask_user | ✅(BACKFED) | ✅(BACKFED) | ⚠️(残留) | ✅(影响说明) | ✅(按D-026设计) | ✅ | **核心矛盾**：③正文残留「search domain」旧称（见专项核验）|
| D-027 5-Wave 细化 | 可逆 | agent | — | — | — | — | ✅(授权) | ✅ | ⑥推导自⑤§8，一致（见专项核验）|

**统计**：✅ 27/27 决策核心立场未被推翻；⚠️ 1 条（D-026 在③残留），连带④缓解表措辞 1 处、⑤lib 提取细节 1 处未落地，共展开为 4 条矛盾。

## revisit 链核验

| revisit | 旧决策 | superseded_by | 新决策 | confirmed_by | 不可逆是否 ask_user | 闭环 |
|---------|--------|---------------|--------|--------------|--------------------|------|
| debounce 归属 | D-019（status=revisited） | → D-020 | D-020（status=confirmed） | ask_user | 可逆，ask_user 满足 | ✅ |
| #4 编排归属 | 原 #4 方案A「domain 编排」 | → D-026 | D-026（status=confirmed） | ask_user | **不可逆，ask_user 满足** | ✅ |

- D-019 `superseded_by=D-020` 字段存在 ✅；D-020 `source` 含 `[REVISIT of D-019]` ✅；D-020 confirmed_by=ask_user ✅（D-020 是 D-可逆，ask_user 高于必要门槛）。
- D-026 `source` 含 `[REVISIT of issues #4 方案A]` ✅；D-026 confirmed_by=ask_user ✅；D-026 是 D-不可逆，**正确触发 ask_user**（满足「D-不可逆的 NEEDS_USER_CONFIRM」）✅。
- **无 dangling revisit**：无 status=revisited 但 superseded_by 为空的决策；无被引用为 REVISIT 但未登记的决策。

**revisit 链结论**：✅ 完整，无断裂。

## 矛盾清单

### 矛盾 #1（⚠️）— D-026 在③ issues.md 正文系统性残留「search domain」旧称

- **涉及决策**：D-026（D-不可逆，confirmed）
- **文档**：③ issues.md
- **偏离描述**：D-026 明确「**不新建 api/domains/search.ts**，编排归 composables/features/useSearch.ts」。但③ issues.md 正文在 D-026 反哺后仍**大量沿用旧称**，未做系统性措辞修订：
  - `#4 问题描述`（L329）：「架构 §7 要求新建 `api/domains/search.ts`（real domain），编排 4 数据源查询」——**直接与 D-026 矛盾**（仍主张新建 search domain）。
  - `#4 方案A`（L349-358）：方案 A 全文基于「新建 api/domains/search.ts，导出 query(q)」「domain 合并全量候选」「分组逻辑内聚（GAP-E1 归 domain）」——方案 A 标题/正文是 D-026 前的 domain 方案，**未改写为 useSearch composable 方案**（仅取舍决策/AC 有 BACKFED 注释，方案正文未同步）。
  - L337/339/388/389/394：BC-9 loadSeq 守卫、AC-4.5 error 冒泡链、AC-4.10 缓存竞态——AC 正文均写「search domain query() / domain catch / domain 编排」，应为「useSearch.query() / useSearch catch」。
  - L530/550/586/616/623/656：#7 SearchModal 改造、#8 loading/error——多处「改调 #4 search domain」「loadSeq 守卫迁移到 search domain 内」「search domain catch 错误」。
  - #17（L755/763/794/803）：AC-17.1 正文「domain query() 对 file/session WS 源加超时 race」，取舍决策「方案 A（domain query() 超时 race）」——应为 useSearch.query()（仅方案 A 标题旁有 BACKFED 注释 D-026，正文未改）。
  - L341 关联：「system-architecture.md §7（search domain 模块）」——§7 已 BACKFED 为 useSearch composable。
- **是否有反哺记录**：**部分有**。③ issues.md 在 #4 标题旁（L318）有 `[BACKFED from code-arch on 2026-06-30] D-026` 注释，#5（L398/409/419-433）方案 A 已完整改写为「删除 search 导出 + 改调 useSearch」，上游覆盖核验表（L62/67/79/87/89）有 BACKFED 标注。但 **#4 问题描述/方案A正文、#7/#8/#17 的 AC 正文**未跟随改写，BACKFED 注释只在标题/个别行，未渗透到正文。
- **建议**：Step 6b 对③ issues.md 做一轮 D-026 措辞清扫——#4 问题描述 + 方案 A 正文改写为 useSearch composable（或在方案 A 顶部加醒目 D-026 覆盖声明：「以下 domain 措辞统一理解为 useSearch composable，D-026 已 confirmed」），#7/#8/#17 的 AC 正文「search domain / domain query()」全文替换为「useSearch / useSearch.query()」。当前④ NFR 已采用后一策略（开头「影响说明」统一改写），③ 应对齐④的做法。

### 矛盾 #2（⚠️）— D-026 在④ NFR 缓解项表/骨架验证表的「回灌去向」列未随改写

- **涉及决策**：D-026（D-不可逆，confirmed）
- **文档**：④ non-functional-design.md
- **偏离描述**：④开头有完整 `[BACKFED from code-arch D-026 影响说明]`（L8），声明「文中 search domain / domain query() 措辞应理解为 useSearch composable」——**正文叙述层**靠「影响说明」整体覆盖，可接受。但 **表格的「回灌去向/落点」列是硬指针**，仍指向已不存在的实体：
  - L263 MR-4.1「loadSeq 字段 + 守卫逻辑存在于 **search domain query() 内部**」——应为 useSearch.query()。
  - L266 MR-4.4「**search domain** 消费 session 级缓存时须自绑 setupInvalidation watch」——应为 useSearch。
  - L272 MR-17.1「**domain query()** 对 file/session WS 源加超时 race」——应为 useSearch.query()。
  - L291「⑤骨架 **search domain query()** 含 loadSeq 字段」、L294「⑤骨架 **search domain query()** 含超时 race」——⑤骨架实际是 `composables/features/useSearch.ts`，⑤§9 已确认（useSearch.ts:49/50/131）。落点指针与⑤骨架真实位置脱节。
- **是否有反哺记录**：**有**（开篇影响说明全局覆盖），但落点指针（「search domain query()」）未逐条改写，是「靠读者自行翻译」的软覆盖，非硬指针同步。
- **建议**：将 MR-4.1/4.4/17.1 + 骨架验证表 2 行的「search domain query()」落点措辞改写为「useSearch.query()（composables/features/useSearch.ts）」，与⑤§9 骨架位置对齐。否则⑤反向核对「来源 B」时落点指针对不上实际文件。

### 矛盾 #3（⚠️）— D-026「recents 读写 + 命令聚合 + DTO 映射提取为 lib 纯函数」在⑤未落地

- **涉及决策**：D-026（D-不可逆，confirmed）
- **文档**：⑤ code-architecture.md（落地侧）
- **偏离描述**：D-026 决策正文明确「recents 读写 + 命令聚合 + DTO 映射**提取为 lib 纯函数供 composable 调用**」。但⑤ code-arch §1 工程目录 + §3 API 契约：
  - recents：放在 `composables/features/useRecents.ts`（含 localStorage 读写 + FIFO），**未提取为 lib 纯函数**（read/write 是 composable 方法，非 lib）。
  - 命令聚合：在 `composables/features/useCommandRegistry.ts`（list computed），未提取 lib。
  - DTO 映射：⑤§4 功能2 时序图「DTO 映射 + 分组」在 useSearch composable 内（L341），未提取 lib（D-026 说「提取为 lib 纯函数」，⑤说「在 composable 内」）。
  - ⑤§9 骨架核验也无对应 lib 文件（lib/ 只有 match-engine.ts）。
- **是否有反哺记录**：**无**。D-026 的「提取为 lib 纯函数」是决策正文里的具体落地指引，⑤选择了「留在 composable 内」，无 BACKFED 注释说明为何偏离、未触发 revisit。
- **严重度评估**：⚠️ 轻微。D-026 的**核心立场**是「编排归 composable 非 domain」，⑤完全守住；「lib 提取」是实现细节（recents 含 localStorage 副作用本就不适合做纯 lib 函数，⑤把含副作用的留 composable、纯算法才提 lib 是更合理的分层）。即⑤的实际选择可能比 D-026 正文更优，但属「未标注的偏离」。
- **建议**：⑤补一句 BACKFED 注释说明「D-026 的 recents/命令聚合含副作用，不提取为纯 lib（仅纯算法 matchFilter 提 lib），与 D-026「domain 纯净」精神一致」，或在 decisions.md 补一条 D-可逆澄清（agent-opinionated，无需 ask_user）。

### 矛盾 #4（⚠️）— D-023「#17 独立 issue」与 D-027「#17 物理合并入 #4」表面张力需澄清

- **涉及决策**：D-023（D-不可逆）+ D-027（D-可逆）
- **文档**：⑥ execution-plan.md（D-027 落地）
- **偏离描述（表面张力，非实质矛盾）**：
  - D-023 rationale：「**并入 #4 会超载单 issue 并发面职责**……新建独立 issue 更清晰」——主张 **issue 独立**。
  - D-027：「**#17 物理合并入 #4**（withWsTimeout 同文件）」——主张 **代码物理合并**。
  - 字面看「合并」与「独立」似冲突。
- **实质判定**：**非矛盾**，是两个不同维度：
  - D-023 维度 = **issue 跟踪独立性**：#17 在③ issues.md 是独立 issue（独立 #17 节、独立 AC-17.1~17.3、独立 P 级判定、独立 blocked_by #4）✅，未裹进 #4 的 AC 清单。issue 独立性成立。
  - D-027 维度 = **物理代码位置/PR 合并**：#17 的 withWsTimeout 代码与 #4 的 useSearch.ts 同文件，由同一 subagent/PR 交付（消除文件冲突中间态）。这是 execution 阶段的物理编排，非 issue 合并。
  - 两者兼容：issue 独立追踪（D-023）+ 代码同文件交付（D-027）= 「独立 issue 但同 PR 实现」，常见模式。⑥ execution-plan 也明示「物理合并：withWsTimeout 在 useSearch.ts 内」+ #17 仍以独立 issue 出现在 Wave2 subagent 配置（#4 含 #17，AC 列 AC-4.1~4.10 + AC-17.1~17.3 分开列）。
- **是否有反哺记录**：D-027 rationale 已解释「物理合并消除文件冲突中间态」，隐含区分了 issue 独立与代码合并，但未明示「与 D-023 的 issue 独立性不冲突」。
- **建议**：在⑥ execution-plan D-027 落地处或 decisions.md D-027 补一句澄清「物理合并 ≠ issue 合并：#17 issue 独立性（D-023）保持，仅 withWsTimeout 代码与 #4 同文件同 PR」，消除读者表面张力。属文档可读性优化，非决策失守。

---

## 专项核验（任务要求逐条）

| 核验项 | 结果 | 证据 |
|--------|------|------|
| **D-004 统一命令注册表** ②③⑤⑥ 一致 | ✅ | ②§3 命令注册表术语 + §7 命令注册表模块 + §10 D-016；③#2 方案A（扩 store + useCommandRegistry composable）；⑤§3 useCommandRegistry.list/registerApp 契约 + §1 目录；⑥Wave1#2（stores/command.ts 扩 + composables/useCommandRegistry.ts 新）。useCommandRegistry + command store 扩展全链一致 |
| **D-016 两区物理隔离** ⑤§3 + ⑥Wave1#2 | ✅ | ⑤§3 stores/command.ts：appCommands: Ref<AppCommand[]>（静态独立 ref）+ commandsBySession: Ref<Map>（per-session）「独立 ref 不揉进同一响应式根（D-016）」；⑤§9 骨架 command.ts:43 appCommands ref 定义；⑥Wave1#2 验收标准「#2 两区物理隔离（D-016）：appCommands 独立 ref，session 切换不触发其响应式（AC-2.2）」 |
| **D-020 debounce 提前到 #7** ③AC-7.15 + ⑤ + ⑥Wave3 | ✅ | ③#7 AC-7.15「watch query 改 debounce(120ms)…（debounce 从 #10 提前到 #7）」；③#10 L715「D-020 修订后 debounce(120ms) 提前到 #7（P1），本 issue 剩 2 项」；⑤§4 功能2 时序图「输入查询（debounce 120ms 后触发）」+ 功能4「debounce 120ms 合并」；⑥Wave3 关键改造点「AC-7.15 debounce(120ms)：watch query 改 debounce（D-020 从 #10 提前）」。全链一致 |
| **D-021 5000 截断** ①req + ③AC-4.7 + ④ + ⑤ + ⑥T3.5 | ✅ | ①req G1.2「深度 8/上限 5000」+ 数据清单 L191「上限 5000」；③AC-4.7「MAX_SEARCH_RESULTS=5000（D-021 校正：旧值 500…）」；④NFR L115/117/265/283/301 全 5000；⑤§3 边界表「>MAX_SEARCH_RESULTS(5000)」+ T3.5；⑥T3.5「文件数 >5000 显示截断提示（D-021）」。全链 5000，旧值 500 已清扫 |
| **D-023 #17 独立 issue** ③issues #17 + ⑥Wave2 | ✅（见矛盾#4）| ③issues #17 独立节（L746-805）+ 独立 AC-17.1~17.3 + blocked_by #4；⑥Wave2「#4 含#17」（物理合并但 issue 独立，AC 分列 AC-4.x + AC-17.x）。issue 独立性成立，物理合并见 D-027（矛盾#4 表面张力已澄清）|
| **D-024 AC-6.9 直调 fileApi.read** ③#6 AC-6.9 + ⑤§3 + ⑥Wave2#6 | ✅ | ③#6 AC-6.9「file 跳转须直调 fileApi.read 校验不经 useDetailPane.openPreview 吞错层」（D-024 BACKFED）；⑤§3 useSearchJump.confirm type=file 分支「**直调 fileApi.read（AC-6.9，不经 useDetailPane.openPreview 吞错层）**」+ AC-6.9 关键约束块；⑥Wave2#6 关键约束「AC-6.9 直调 fileApi.read」+ 验收「#6 file 分支直调 fileApi.read（AC-6.9 grep：useSearchJump.ts 不调 useDetailPane.openPreview）」。全链一致 |
| **D-026 编排归 composable** ①②③④⑤⑥ 全同步无残留 | ⚠️ | ①（L21/31/212 BACKFED）✅；②（§3/§6/§7/§10/§11 多处 BACKFED，SD=useSearch composable）✅；⑤（全文按 D-026 设计，§1/§2/§3/§9）✅；⑥（TL;DR + Wave 全程 useSearch）✅；④（开篇影响说明覆盖，但表格落点残留，见矛盾#2）⚠️；**③ 正文残留最严重（见矛盾#1）⚠️**。核心立场未推翻，但③④措辞清扫不完整 |
| **D-027 5-Wave 与⑤§8 一致** | ✅ | ⑤§8 Wave DAG：Wave1(P0:#1/#2/#3) / Wave2(P1:#4含#17/#6/#7含#5#8) / Wave3(P2:#9/#10)，明示「供⑥execution-plan 推导」。⑥ D-027：把⑤§8 的 Wave2（编排+UI 混合）拆为 Wave2(编排 #4‖#6)+Wave3(UI #7)，追加 Wave5 验收 Gate。D-027 rationale 明示「5-Wave 非推翻⑤§8（⑤§8 粗粒度 P 级分层，⑥按文件冲突+消费依赖细化是 execution 阶段职责）」。⑤§8 授权⑥推导成立 ✅ |

## 补充：D-不可逆决策守护核验

| D-不可逆 | 在④⑤⑥是否被静默偏离 | 结论 |
|----------|---------------------|------|
| D-001/003/005/006 | 否 | ④⑤⑥ 全程符号降级/路径搜索/跨项目/三类跳转一致 |
| D-004 | 否 | useCommandRegistry + store 扩展一致 |
| D-011/012/013 | 否 | ⑤§2 三层 + 无 port + 纯 DTO，⑥未引入 domain/aggregate/port |
| D-016 | 否 | ⑤§3 两区物理隔离独立 ref，⑥Wave1#2 验收 |
| D-023 | 否（issue 独立性守住）| ⑥物理合并不破坏 issue 独立（矛盾#4 已澄清）|
| D-026 | **部分偏离（措辞层）** | ④⑤⑥ 核心立场守住；③正文残留 domain 旧称（矛盾#1）、④落点残留（矛盾#2）、⑤ lib 提取未落地（矛盾#3）。**无实质立场推翻**，仅文档卫生 |

**D-不可逆守护结论**：11 条 D-不可逆决策**无一条被实质推翻**；D-026 在③④⑤存在措辞/落点未完全同步的卫生问题，需 Step 6b 补清扫，但不构成决策失守（核心立场「编排归 composable 非 domain」在编码落地侧⑤⑥完全守住）。
