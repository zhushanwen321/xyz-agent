---
phase: issues
tracer: independent-subagent
frame: convergence-review
round: 2
converged: true
---

# Tracing Round 2 · 收敛复核

> 复核源：system-architecture.md（②）+ requirements.md + **修订后 issues.md** + tracing-round-1.md + decisions.md（账本纪律）。
> 账本纪律：已 confirmed 决策（D-001~D-020）不当 gap 重报。本轮无下游新证据推翻任何 confirmed 决策，无 `[REVISIT of D-NNN]`。
> 类型约定：**F**=事实/事实归属 · **K**=契约/约束/覆盖归属 · **D**=决策/口径。
> 源码核验：AH-E1（useFileSearch.ts:39-43 `catch{return []}`）、AH-B1（file-service.ts:52 `MAX_SEARCH_RESULTS=500` / :174-186 横向截断 / file-message-handler.ts:70 file.search payload 仅 `{sessionId,showIgnored}` 无 query）、AH-C5（Sidebar.vue:236 `searchOpen.value=true` 非 toggle）、composer.ts:28-33 getFileCandidates 经 pending 透传 error、api/index.ts:42 `search = mockApi.search` 硬编码、command.ts:48 per-session Map——均经独立核验属实。
> 注：本文件原为 clarity 阶段 Round 2（requirements 追踪），已超被架构/issue 阶段取代（其 R2-01 缺口「searchFiles 误标新增」已在架构 D-003「复用现有」解决）；本轮为 **issues 阶段收敛复核**，文件名与 tracing-round-1.md（issues 阶段）对齐。

## CONVERGED

**本轮收敛判定：CONVERGED。** Round 1 的 22 条 gap 经逐条核对均已在修订后 issues.md 中正面解决（补 AC / 澄清 / 拆分 / 溯源标注，非敷衍）。独立失败帧扫描未发现修订引入的新矛盾或新的需处理死角。error 冒泡链跨 #4/#6/#8 三 issue 已端到端闭合（见 §端到端闭合核验）。

**追踪核对的维度：**
1. Round 1 覆盖重建（角色 A）4 条 gap（M-1/M-2/M-3/P-1）
2. Round 1 异常猎手（角色 B）18 条 gap（AH-E1~E5 / AH-B1~B5 / AH-C1~C5 / AH-S1~S3）
3. 修订后独立失败帧扫描（异常路径 / 边界值 / 并发时序 / 状态机死角 / 删除测试）
4. 修订 AC 间一致性检查（#6 AC-6.7 跳转失败保持打开 vs #7 关闭逻辑；D-020 提前后依赖图；error 冒泡链跨 #4/#6/#8）
5. 源码核验（6 个源文件 + 2 个 runtime 文件，验证 Round 1 关键事实声明）

---

## Round 1 gap 逐条核对（22 条）

### 覆盖重建（角色 A）— 4 条

| gap_id | 修订位置 | 核对结果 |
|--------|---------|---------|
| M-1（error 态归属错配，中） | 覆盖核验表「§5 error 态」拆为两行：「error 态——查询失败（search domain catch）→ #8（AH-S2 说明查询路径因 allSettled 吞单源错误，error 实际仅跳转可达）」「error 态——跳转失败（file.read/session.switch）→ #6（AC-6.5/6.6）」 | ✅ 已解决。覆盖表 error 行已正确拆分，查询失败与跳转失败两路归属分别指向 #8/#6，并附 AH-S2 机制说明。归属真实可见。 |
| M-2（状态转换枚举不全，中） | 覆盖核验表状态轴补全：closed↔open、recents→query_results、query_results→recents（清空）、query_results→empty、empty→query_results、query_results→loading、loading→query_results、loading→empty、query_results→type_filtered、type_filtered→query_results——11 条显式转换全覆盖（含 D-014 派生态并入说明） | ✅ 已解决。状态轴现列 11 条转换（含清空回 recents / empty→results / loading 双出口 / type_filtered 回退），每条标归属 issue + 派生态并入说明（D-014）。枚举完整。 |
| M-3（BC-5 覆盖指针漏 #7，低） | 覆盖核验表 BC-5 行改为「#3, #7 ✅」，备注「持久化→#3，显示集成→#7（AC-7.11）」 | ✅ 已解决。BC-5 归属补「#3（持久化）+ #7（显示集成）」，并点明 AC-7.11 落点。指针完整。 |
| P-1（P3 项脱锚无 source 列，低） | P3 后续迭代表 6 项均补 source 列（#11→D-001+②§1 G1.4 / #12→D-003 / #13→D-008 / #14→D-010 / #15→requirements §8 / #16→requirements §8） | ✅ 已解决。P3 表每项均有 source 列指向 requirements §8 或 decisions D-xxx，脱锚可追溯。 |

### 异常猎手（角色 B）— 18 条

| gap_id | 修订位置 | 核对结果 |
|--------|---------|---------|
| AH-E1（file.search 静默吞错，致命） | #4 问题描述补「错误冒泡链（AH-E1/E2，关键）」段：domain 必须直调 `composer.getFileCandidates`（经 pending reject 透传 error envelope），不经 `useFileSearch.load`（:39-43 静默 catch 吞错降级空数组） | ✅ 已解决。机制级缺陷已写进 #4 问题描述，明确 domain 直调 composer.getFileCandidates 不经吞错层。AC-4.5 正面承载。 |
| AH-E2（#8 验收假性 PASS 风险，高） | #4 AC-4.5「error 冒泡链——file 源错误必须从 runtime reject 一路冒泡到 search domain catch（domain 直调 composer.getFileCandidates，不经 useFileSearch.load 吞错层），中途不得有 catch 降级空数组吞错；到 domain catch 后转 toast，不静默」+ #8 AC-8.2 前置「file 源须直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层（见 #4 AC-4.5），否则 error 永不到 domain catch 致假性 PASS」 | ✅ 已解决。端到端 AC 跨 #4/#8 闭合——#4 AC-4.5 定义冒泡链机制，#8 AC-8.2 标前置依赖防假性 PASS。双向引用。 |
| AH-E3（跳转失败恢复路径未定义，高） | #6 AC-6.7「跳转先 await 成功再关浮层，失败保持打开让用户重选（符合「失败可重试」直觉，而非先关后跳致 toast 在关闭后弹出用户无法重选）」 | ✅ 已解决。明确「先 await 成功再关浮层，失败保持打开」语义。 |
| AH-E4（应用命令 action 抛错无 AC，中） | #6 AC-6.8「应用命令 action 抛错→toast 反馈（与 file.read/session.switch 异常 AC 对称，命令路径不再只覆盖正常执行）」 | ✅ 已解决。命令路径异常 AC 已补（AC-6.8），与 file/session 对称。 |
| AH-E5（无 active session 查询降级，中） | #4 AC-4.8「无 active session 时 file 源（需 sessionId 取 cwd）+ slash 源（per-session 分区为空）返空 section，应用命令源仍工作，查询不报错降级为「仅应用命令」结果」 | ✅ 已解决。无 session 降级表现有 AC 覆盖。 |
| AH-B1（500 截断无提示，致命） | #4 AC-4.7「文件数超 MAX_SEARCH_RESULTS=500（file-service.ts:52 横向截断）时，文件分组显示截断提示（如「仅显示前 500 项，请细化查询」），避免用户误以为深层文件不存在」 | ✅ 已解决。截断提示 AC 已补，引用真实常量。（独立核验 file-service.ts:52/174-186 确认 500 横向截断属实，file.search payload 确无 query 服务端过滤） |
| AH-B2（RecentEntry.key 规则缺失，中） | #3 AC-3.5「RecentEntry.key 生成规则=`type:title`（title 作稳定标识；文件/会话 sub 是路径/branch 可变，不入 key）。同 key 重复确认时更新 timestamp 而非新增条目，FIFO 淘汰依据 key 相等性」 | ✅ 已解决。key 规则已定义（type:title），去重/淘汰相等性有依据。 |
| AH-B3（两种空态混为一谈，中） | #7 AC-7.13「区分两种空态——recents 库空（首用，空查询）显示专属引导文案（「输入关键词开始搜索」），复用「未找到」模板但不带 query 引号；查询无结果（非空 query 无命中）显示「未找到「查询词」」带引号。两者不混用」 | ✅ 已解决。两种空态显式区分。 |
| AH-B4（Tab 切类 selIdx 越界，低） | #9 AC-9.3「Tab 切类时 selIdx 重置为 0（或 clamp 到可见范围），避免选中被过滤隐藏的项」 | ✅ 已解决。selIdx 重置/clamp 已约束。 |
| AH-B5（极大查询串性能，低） | #1 AC-1.5「极大查询串（>200 字符）早退——segments/matchFilter 对超长 q 截断或直接返回未命中，避免 O(text×q) 重复计算拖慢渲染」 | ✅ 已解决。超长查询早退已约束。 |
| AH-C1（loadSeq 守卫归属层未定，中） | #4 AC-4.4 + #4 问题描述补「loadSeq 守卫在 domain query() 内部维护，SearchModal 只 await，不重复守卫（AH-C1）」+ #7 AC-7.6「loadSeq 乱序响应保护保持（守卫在 #4 search domain 内部，SearchModal 只 await）」 | ✅ 已解决。守卫归属层明确（domain 内部），跨 #4/#7 一致。 |
| AH-C2（debounce 顺序倒挂，中） | D-020（REVISIT of D-019，confirmed）：debounce(120ms) 从 #10(P2) 提前到 #7(P1)。#7 AC-7.15「watch query 改 debounce(120ms) 后调 loadResults」。#4 AC-4.9 协同（file 源复用 useFileSearch session 级缓存）。#10 减为 2 项 | ✅ 已解决。D-020 正式走 REVISIT 流程且 confirmed。#7 AC-7.15 + #4 AC-4.9 协同。#10 已减为 2 项。 |
| AH-C3（timestamp 同毫秒单调性，低） | #3 AC-3.6「timestamp 用计数器兜底（Math.max(stored)+1）而非裸 Date.now()，避免同毫秒连续 write 的 FIFO 排序不确定」 | ✅ 已解决。计数器兜底已定义。 |
| AH-C4（浮层快速 open/close 交替，低） | #7 AC-7.14「浮层快速 open/close 交替时，loadResults 与 query 清空不产生竞态（loadSeq 守卫已覆盖结果竞态；open/close 副作用不残留 pending 定时器）」 | ✅ 已解决。快速交替竞态已约束（明确 pending 定时器不残留）。 |
| AH-C5（⌘K toggle 事实错误，高） | #7 AC-7.1 拆「再按⌘K 关闭」为变更项（非保持）+ #7 问题描述补「变更项（非保持，AH-C5）：「再按⌘K 关闭」不是现状行为——Sidebar.vue:236 现为 searchOpen.value=true（无条件置 true，非 toggle）」+ #10 AC-10.1 协同（⌘K 从 =true 改为 toggle） | ✅ 已解决。事实漂移已揭穿（Sidebar.vue:236 确为 =true 非 toggle，独立核验属实），AC-7.1 拆为变更项。跨 #7/#10 一致。 |
| AH-S1（error 孤岛 / ref 生命周期，中） | #8 AC-8.5「error ref 生命周期明确——新查询成功时清除 error ref / 组件 close 时重置 error ref（error 是 transient 标志，不持久跨查询）」 | ✅ 已解决。error ref 清除时机有 AC。 |
| AH-S2（error 态查询路径不可达，中） | #8 AC-8.6「error 态可达性对齐实现机制——查询路径因 allSettled 吞单源错误实际不进全局 error 态（单源失败由对应分组空态表达）；全局 error 态仅由跳转失败（file.read/session.switch，非 allSettled）触发。§5「查询/跳转失败」描述据此对齐」 | ✅ 已解决。状态机描述与 allSettled 机制对齐，§5 描述已被标注对齐。 |
| AH-S3（type_filtered 与 recents 正交，低） | #9 AC-9.4「空查询（recents 态）+ Tab 切类时，显示该类型的 recents 子集（type_filtered 与 recents 正交，非互斥）」 | ✅ 已解决。正交规则已定义。 |

**核对统计：22/22 条已正面解决。**

> 修订方式分布：补 AC（17 条）/ 问题描述澄清（AH-E1、AH-C1 走问题描述 + AC 双承载）/ 覆盖表拆分溯源（M-1/M-2/M-3/P-1）/ 决策走 REVISIT（AH-C2→D-020）。均非敷衍标注。

---

## 端到端闭合核验（重点项）

### 1. error 冒泡链跨 #4/#6/#8 三 issue

| 链路环节 | issue | AC/描述 | 核对 |
|---------|-------|---------|------|
| error 产生源（runtime reject） | — | composer.getFileCandidates 经 pending reject 透传 error envelope（composer.ts:28-33 核验属实） | ✅ 源码属实 |
| 冒泡机制（不经吞错层） | #4 | AC-4.5 + 问题描述「错误冒泡链」段：domain 直调 composer.getFileCandidates，不经 useFileSearch.load 的 :39-43 `catch{return []}` | ✅ 闭合 |
| 查询路径 error 归宿 | #8 | AC-8.2 前置「file 源须直调 composer.getFileCandidates」（引用 #4 AC-4.5）+ AC-8.6「allSettled 吞单源错误，查询不进全局 error，由分组空态表达」 | ✅ 闭合（防假性 PASS） |
| 跳转路径 error 归宿 | #6 | AC-6.5（file.read 失败 toast）+ AC-6.6（session.switch 失败 toast+刷新）+ AC-6.7（失败保持打开）+ AC-6.8（命令 action 抛错 toast） | ✅ 闭合 |
| error ref 生命周期 | #8 | AC-8.5（新查询成功清除 / close 重置） | ✅ 闭合 |

**判定：error 冒泡链端到端闭合。** #4 定义机制 + #8 验收前置依赖（双向引用 #4 AC-4.5）+ #6 跳转错误独立闭环。查询路径与跳转路径 error 归属无交叉遗漏。

### 2. #6 AC-6.7（跳转失败保持打开）vs #7 关闭逻辑——一致性

- #6 AC-6.7：跳转**先 await 成功再关浮层，失败保持打开**。
- #7 AC-7.1：关闭路径为 Esc/点遮罩/再按⌘K（用户主动关闭）；AC-7.8「close 清空 query」。
- **核对**：#6.7 的「跳转成功后关闭」是**跳转编排侧**语义（useSearchJump.confirm 成功后 emit close）；#7 的关闭是**用户主动关闭路径**。两者正交不冲突——#6.7 说的是「跳转失败时不自动关」，而非「禁止关」，用户仍可 Esc 手动关。AC-7.8 close 清空 query 不受 #6.7 影响（失败保持打开期间 query 不清空，用户可重选）。
- **判定：一致，无矛盾。**

### 3. D-020 debounce 提前后依赖图一致性

| 核对点 | 核对结果 |
|--------|---------|
| #7 AC-7.15 标「D-020 + AH-C2」 | ✅ |
| #4 AC-4.9「file 源复用 useFileSearch session 级缓存…与 #7 debounce(120ms) 协同避免每次按键全量拉取」 | ✅ 协同声明 |
| #10 问题描述「D-020 修订后 debounce(120ms) 提前到 #7，本 issue 剩 2 项」 | ✅ 减为 2 项（Sidebar keydown + scrollIntoView） |
| #10 AC-10.1 不再含 debounce（AC-10.1 是 Sidebar keydown，AC-10.2 是 scrollIntoView） | ✅ |
| decisions.md D-019 status=revisited/superseded_by=D-020；D-020 status=confirmed | ✅ 账本一致 |
| 依赖图（mermaid）#10 依赖 #2，#7 不依赖 #10 | ✅ debounce 不引入 #7→#10 反向依赖 |

**判定：D-020 提前后依赖图一致。** debounce 从 #10 移到 #7 未破坏拓扑序（#7 本就依赖 #1-#6，不依赖 #10），#10 减项后仍合法。

---

## 独立失败帧扫描（修订后）

> 戴失败帧重新扫，假设修订后 issues.md 仍可能有死角。扫描维度：异常路径 / 边界值 / 并发时序 / 状态机死角 / 删除测试。

### 异常路径
- session.list 全量失败（runtime 断连）：#4 AC-4.5 覆盖 file 源冒泡；session 源失败经 allSettled 吞为空 section（AC-8.6 已说明单源失败=分组空态）。✅ 已覆盖（allSettled 语义）。
- 多源同时失败：allSettled 全部 rejected → 各源空 section → 整体 empty 态（AC-7.13 覆盖）。✅
- toast 渲染本身失败：toast 是基础设施，非本期 issue 范围。✅ Out of scope。

### 边界值
- query 恰好 200 字符：AC-1.5 是 >200 早退，边界 200 属临界（实现期细节，早退行为已约束）。✅
- recents 恰好每类 5 项时第 6 次确认：AC-3.2 FIFO 淘汰最旧 + AC-3.5 同 key 更新 timestamp。✅
- 无 active session 且无应用命令（启动早期）：AC-4.8 覆盖「仅应用命令」，应用命令注册表也空 → 整体 empty 态（AC-7.13 库空引导覆盖）。✅

### 并发时序
- debounce(120ms) 期间用户快速 Enter：Enter 走 confirmSel（不触发 loadResults）。debounce pending 的 loadResults 若在 confirm 后 resolve，loadSeq 守卫（AC-4.4）保护结果不被覆盖；confirm 后浮层已关（成功）或保持打开（失败 AC-6.7）——pending 结果到达后若浮层仍开会更新 remoteSections，是合理行为非竞态。✅
- 跳转 await 期间用户按 Esc：AC-6.7 聚焦「跳转失败保持打开」，但未显式约束「跳转 await 中用户主动 Esc 关闭」的交叉路径（跳转 promise 后续 resolve/reject 时浮层已关）。

  **→ R2-N1（D，低，备忘非 gap）**：AC-6.7 未覆盖「跳转 await 中用户主动 Esc」交叉路径。跳转通常快（file.read/session.switch），用户在此窗口主动 Esc 概率低，最坏是「关闭后 toast 弹」（非崩溃）。主语义（失败保持打开）已正确，此交叉路径可在实现期以「跳转中忽略已关闭后的 promise」处理。**不阻断收敛。**

### 状态机死角
- type_filtered 态 + 跳转：Tab 切类后选中跳转，AC-9.3 selIdx 重置覆盖切类瞬间。但跳转后重开浮层时 activeType 是否重置未显式约束。

  **→ R2-N2（D，低，备忘非 gap）**：close 时 activeType 未明确重置。用户重开期望「全部」是合理默认，实现期 close 时 `activeType.value=null` 即可（与 query 清空 AC-7.8 同处）。**不阻断收敛。**

### 删除测试
- 修订未新增 issue，无新增伪 issue 需测。Round 1 已结论 #5（~5 LOC 接线）可考虑并入 #4（供主 agent 权衡，非阻断）——主 agent 未采纳（#5 仍独立），#5 独立有价值（G2 grep AC-1 硬验收独立可见），不构成 gap。✅

---

## 新 gap

**无新 gap（无 F/K/D 类需主 agent 处理）。**

独立失败帧扫描发现 2 处低优实现期边界（R2-N1 跳转 await 中 Esc 交叉 / R2-N2 close 时 activeType 重置），均为「主语义已正确，交叉细节实现期处理即可」性质，**记为参考备忘，不标为 gap，不阻断收敛**。

---

## 收敛结论

**CONVERGED。**

- Round 1 的 22 条 gap 逐条核对：**22/22 已正面解决**（17 补 AC + 1 问题描述澄清 + 4 覆盖表拆分溯源 + 1 决策 REVISIT 走 D-020）。
- 端到端闭合核验 3 项重点（error 冒泡链跨 #4/#6/#8 / #6.7 vs #7 一致性 / D-020 提前后依赖图）均通过。
- 独立失败帧扫描未发现修订引入的新矛盾或新的需处理死角（2 处低优实现期边界记备忘，非 gap）。
- 无 `[REVISIT of D-NNN]`——无下游新证据推翻任何 confirmed 决策（D-001~D-020）。
- 源码核验：Round 1 的 6 处关键事实声明（useFileSearch 吞错 / file-service 500 截断 / file.search 无 query / Sidebar 非 toggle / composer error 透传 / api/index.ts 硬编码 mock）均经独立核验属实，修订基于真实事实。

**issues.md 可进入下游（non-functional-design / 执行）。**
