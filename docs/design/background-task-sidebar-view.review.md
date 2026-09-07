# background-task-sidebar-view.md 对抗式审查报告

> 审查对象：`docs/design/background-task-sidebar-view.md`（R4 修订版：D10 ①-⑤ 二级筛选 + 术语改「后台命令」+ item 两行式用户裁决）
> 本轮（R4）审查面：① D10 新增机制（含 demo 评审后追加的 ⑤ 两行式）逐子决策对抗 + 事实主张源码核实；② R4 增量与既有 D1-D9/探针/验收/拆分/改动地图交叉引用复检；③ R3 修复落地确认。R1-R3 已确认项不重查。

## Summary（R4）

0 must-fix, 2 suggestions.

- **D10（①-⑤）机制成立**：三桶筛选/分桶 SSOT/reactive 容器分区/空态三分/行内两段式/两行式 SessionItem 同构，逐项与实装锚点核对吻合；R4 新增的全部关键事实主张经源码验证为真（清单见附录）——**含 dev-0.9.15 先例锚点：在兄弟 worktree 中逐项核实通过**（凹陷槽参数/SSOT 纪律注释/reactive 容器契约/两段式 cancel/空桶自适应/计数同源导出面，见附录），R4-I2 的「不可核实」判定推翻。R3 三处修复（改动地图补齐 spawn-background.ts / D2 三触发面标题 / 加固改善既有行为说明）确认落地。
- **⑤ 的语义色归并机制自洽但欠精度**：timeout 任务的 exitCode 实际是 **null**（SIGKILL 终止，非「非零」）——「exit≠0（含 timeout）= danger」的归并依赖 `exitCode !== 0` 编程语义吸 null + reason==='killed' 优先分流，文档未写明判定顺序与 null 显示形态，且色映射未收进 D10① 自己立的 bucket SSOT（R4-S1）。
- 交叉引用五处联动：D10 正文/U4/S1/S2/G3 基本同步到位；**验收层两处「徽标」措辞未随 ⑤「徽标移除」裁决同步**（R4-S2）。

## R4 Findings

| 编号 | 级别 | P0-N 引用 | 文档位置 | 问题描述 | 证据 | 修复建议 |
|------|------|-----------|----------|----------|------|----------|
| R4-S1 | SUGGESTION | P0-12（边界/精度）/ P1-9（纪律自洽） | §3.3 D10 ⑤（色映射句）；对照 D10 ① | **icon 色映射是第四判定面但未入 bucket SSOT，且判定顺序/null 形态未定义**：① D10 ① 立「列表过滤、FilterBar 计数、L2 角标三方同源消费，禁两处各写判定」，⑤ 新增的 state×reason×exitCode→色档映射（item icon + tooltip 文字 + drawer 潜在消费）是第 4/5 处判定面，`background-task-bucket.ts` 导出面（bucket/filter/count）未含它——实施期会散写在 item 组件；② 判定顺序未写明：killed 的 exitCode 也是 null（SIGKILL），若先判 exitCode 再判 reason 会把 killed 误入 danger——必须 `state 先分流 → exited 内 reason==='killed' → dim → exitCode===0 ? success : danger`；③ 「exit≠0（含 timeout）」的归并实际依赖 `exitCode !== 0` 吸 null（timeout/外部手杀 natural 的 exitCode 是 null 不是非零数——poller `child?.exitCode ?? null`），自然语言读法「退出码非零」不含 null，歧义未消除；④ 第二行「终态附 · exit C」在 C=null 时的显示形态未定义（timeout/外部手杀场景必现） | `poller.ts:79`（`exitCode = task.child?.exitCode ?? null`，signal 终止 = null）；`notify.ts` buildNotificationContent（exitCode ?? "unknown" 先例）；D10 ① SSOT 导出面清单无色映射 | ⑤ 补一句判定顺序（如上）+ null 显示形态（建议「exit –」或省略，对齐 notify "unknown" 先例）；bucket.ts 导出面加 `backgroundTaskStatusIcon(entry)`（返回色档/IconKind），item icon、tooltip、drawer 同源消费 |
| R4-S2 | SUGGESTION | P0-13（验收与裁决同步） | §4 S1「翻转 **exited 徽标**（成功绿/失败红）」；§4 S4「显示 **orphaned 徽标**」 | **⑤「状态文字徽标不进列表（icon 即状态）」的用户裁决未同步到验收层**：S1/S4 仍以「徽标」为通过标准——icon 化后不存在「exited 徽标」「orphaned 徽标」元素，验收按字面执行会找不存在的 DOM（testid/断言形态错位），且 S1 的「成功绿/失败红」应转为 icon 语义色（success/danger 点）；S4 应为「orphaned info 色 icon」 | D10 ⑤（「状态文字徽标不进列表」「成功/失败徽标与 exit 码信息重复，只留 exit 码」）vs §4 S1/S4 措辞 | S1 改「结束 ≤3s icon 翻转为 exited 语义色（成功=success 点 / 失败=danger 点）并归入已结束桶」；S4 改「显示 orphaned（info 色 icon）」；impl-plan 的 testid 按 icon 元素登记 |

### INFO（不计入 suggestion 数）

| 编号 | 位置 | 说明 |
|------|------|------|
| R4-I1 | D10 ⑤ 色档 | **orphaned=info 是侧边栏 7px icon 词汇的词汇扩展**（SessionItem IconKind 8 种无 info 档），但 token 合法（`--info: #6d99a5` 存在，ForkNotice/FileTreeRow 在用）且与 killed=dim 区分度足够（青蓝 vs neutral-dim 50% 灰——killed=dim 有 dead 同款先例 `bg-neutral-dim opacity-50`）。攻击点 结论：区分度成立，无阻塞；实施时色映射入 SSOT（见 R4-S1）即可 |
| R4-I2 | D10 证据 | ~~dev-0.9.15 先例锚点本分支不可核实~~ **已核实（续作轮）**：兄弟 worktree `xyz-agent-workspace/dev-0.9.15` 存在，四个实装文件全部命中且与文档主张逐项吻合——SubagentFilterBar.vue 凹陷槽参数逐字命中（`bg-bg-input` 底 + active `bg-bg-elevated` + `h-6`，:45/:54/:56）、subagent-bucket.ts 纯函数 SSOT 及「判据只写这一处，禁止重复实现」纪律注释（与 D10① 同款）、useSubagentBucketFilter.ts 的 reactive 容器契约注释（「plain object 的 mutate 不触发任何下游重算」——D10② 主张逐句对应）+ 卸载重置语义、SubagentList.vue inline 两段式 cancel（cancellingId + Check 确认态）+「进行中」空桶查看全部一键跳转、计数 countSubagents 与 bucket 判据同模块导出（D10① 计划的 `backgroundTaskBucket/filter/count` 导出面与先例形态精确同构）；done 投影陷阱（isDoneProjection）确认存在于 subagent 域且本设计确免疫。待验证检查点的「合入时序」条目仍保留（跨分支复用评估属实施期决策） |
| R4-I3 | D10 ⑤ | 「icon tooltip 提供文字后备」——SessionItem 同构先例是根元素 **aria-label**（无障碍语义拼入，见 ariaLabel computed）而非 title tooltip；建议双轨（aria-label 无障碍 + title 视觉 hover），与「SessionItem 同构」主张完全对齐 |

## R4 攻击面核验记录（委托指定 a-d）

| # | 攻击点 | 结论 |
|---|---|---|
| a | 两行式与 SessionItem 实装锚点一致性 | **吻合**。`SessionItem.vue`：7px icon（`size-[7px]` + `mt-[6px]`）+ 主体两行（label 行 text-xs + sub 行 `mt-0.5 font-mono text-3xs text-neutral-dim`）+ 右侧时间（mono text-3xs dim）+ hover ghost 操作（absolute bottom-0.5 right-1 ≈ 第二行右侧）+ 两段式确认（confirming 红底 ✓ Button，mouseleave/Esc/click-outside/失焦四路复位）——⑤ 全部结构参数可对号 |
| b | icon 语义色归并自洽性（timeout 归 danger） | **机制自洽、精度欠佳 → R4-S1**。自洽性推演：killed 按 reason 优先分流 dim（其 exitCode 也是 null）；剩余 exited 中 exitCode===0 → success，其余（非零 + null（timeout/外部手杀 natural））→ danger，覆盖无遗漏无重叠。缺口：判定顺序、null 语义歧义、exit 码显示形态、SSOT 归属（详见 R4-S1） |
| c | killed=dim 与 orphaned=info 区分度 | **成立**（R4-I1）：dim = neutral-dim 50% 实心圆（dead 同款先例）；info = 青蓝实心圆（token 存在，侧边栏 icon 词汇新档）。色相+明度双重区分；语义上「用户主动终止（低权重灰）」vs「属主异常收殓（提示性蓝）」分层合理 |
| d | 其余 R4 审查面 | 通过：i18n 冲突主张**精确命中**（`zh-CN/sidebar.ts:136` `subagentList.empty: '暂无后台任务'`——术语裁决证据为真）；reactive 容器契约与 use-session-scoped-state.ts 文件头契约一致（R1 已核）；SegmentedTab badge 先例成立（`badge: boolean` + running>0 亮蓝点，与 D4 ④ 语义同源）；bg-bg-input/bg-bg-elevated token 存在且 SegmentedTab 在用；badge「亮=运行中桶>0」与 SegmentedTab 注释「仅 running>0 亮」语义一致；L2TabItem 无 badge 字段（R1 已核）需扩展 ✓ 已列改动地图 |

## 交叉引用五处联动复检（R4）

| 联动点 | D10 正文 | §3.4 探针 | §4 验收 | §5 拆分/地图 | 判定 |
|---|---|---|---|---|---|
| 三桶筛选+SSOT+分区 | ✓ ①② | —（P6 覆盖分区不变） | ✓ S1 计数/归桶、S6 空桶三分 | ✓ U4 + background-task-bucket.ts/useBackgroundTaskBucketFilter.ts 入地图 | 一致 |
| badge 同源（D4 ④↔D10 ①） | ✓「与 D10 分桶判据同源函数派生」 | — | ✓ S1「角标随消」 | ✓ L2TabBar.vue + l2-tab-item.ts 入地图 | 一致 |
| 行内两段式终止（④） | ✓ | — | ✓ S2 前半 | ✓ U4 | 一致 |
| item 两行式（⑤） | ✓ | — | **✗ S1/S4「徽标」残留**（→ R4-S2） | ✓ U4「两行式 SessionItem 同构 item」 | 一处缺口 |
| 术语「后台命令」 | ✓ §1 裁决 + viewId 不变 | — | ✓ S1 步骤「后台命令 tab」 | ✓ D4 title / U7 i18n | 一致 |
| 先例不照搬声明 | ✓ §2.2「不照搬三行卡片：SessionItem 两行同构」 | — | — | — | 一致 |

**结论**：R4 增量结构成立，两条 suggestion 均为精度/同步级（不阻塞 impl-plan）；R4-S1 建议随 impl-plan 前置补入 ⑤，R4-S2 为验收措辞同步。

---

## R3 结论存档

R3：0 must-fix + 1 suggestion 全修。五处 R2 修复全部准确落地；自检相容性（自写自检走共享 last-seen 判定，无双发）与口径自洽（G3/D6-en/P7/S2 主路径口径五处一致）两个指定检查点通过。R3-S1（改动地图补 spawn-background.ts 加固落点 + task-store.ts 注释落点）与 R3-I2（加固改善既有 bash_kill×timeout 行为说明）已确认写入。

## R2 结论存档

R2：0 must-fix + 5 suggestion 全修。M1/M2（R1）修复验证成立：intent 读回时序构造性安全（预写→发令→死亡→读回 + 4 调用点不变量）、五分支矩阵补齐（锁内重查防 stale 覆盖）、timeout 交叉残余窗口经 armBackgroundTimeout 加固构造性关闭、Windows 两档探测 + fail-closed、watched 订阅生命周期定案。攻击面 a-e（bash_kill 并发 RMW / 分支③双写 / 读回窗口 / Get-Process / watched 累积）全部核验。

## R1 结论存档

R1：2 must-fix（M1 UI kill 唤醒 AI——sendMessage steer triggerTurn 实证；M2 kill 分支矩阵三分支缺失——poller 冻结悬挂/Windows 失效/写失败恢复）+ 7 suggestion 全修。20+ 事实锚点源码核实（registry 契约/锁互斥协议/reaper 范式/drawer 4 点/GuiComponent 9 类型/widget 链路/force-patterns/message-bus snapshot/customType 透传等），核实记录见 git 历史本文件 R1 版；后续轮次抽查与现行文档表述一致。

## 附：R4 轮事实主张核实清单

| 文档主张 | 核实结果 |
|---|---|
| 术语冲突：`zh-CN/sidebar.ts:136` subagentList.empty「暂无后台任务」 | ✓ 精确命中（块起点 :132，empty 恰在 :136） |
| SessionItem 两行结构（7px icon + mt-6px + label/sub 两行 + 右侧时间 + hover ghost bottom-right） | ✓ 逐参数吻合 `SessionItem.vue` |
| 语义色先例：accent 旋转环 / warn / success / danger / dim 点 | ✓ spinning(bg-accent border)/waiting(bg-warn)/done(bg-success)/error(bg-danger)/dead(bg-neutral-dim 50%) 全存在 |
| hover 两段式确认（红底 ✓） | ✓ confirming 模式（Trash→Check 红底，四路复位） |
| `--info` token 存在 | ✓ style.css:63（暗）/240、408（亮/主题），ForkNotice/FileTreeRow 在用；侧边栏 7px icon 词汇为新档（I1） |
| SegmentedTab badge 视觉范式 | ✓ `badge: boolean` + `v-if="tab.badge"` + running>0 亮蓝点注释 |
| bg-bg-input/bg-bg-elevated 凹陷槽参数 | ✓ token 存在（style.css:28-29），SegmentedTab/ProjectSwitcher 在用 |
| reactive 容器契约（标量对象包装 + 必须 reactive） | ✓ 与 use-session-scoped-state.ts 文件头契约一致（R1 核）；dev-0.9.15 useSubagentBucketFilter.ts:10-12 同款契约注释实测存在（续作轮核） |
| timeout exitCode = null（R4-S1 依据） | ✓ poller.ts:79 `child?.exitCode ?? null`，SIGKILL 终止即 null |
| 契约谓词 isActive/isTerminalBackgroundTaskState（D10① 分桶依据） | ✓ `isActive = running‖killing`、`isTerminal = exited‖orphaned`（background-task.ts:99-106）——「运行中 = running+killing、已结束 = exited+orphaned」主张精确成立 |
| dev-0.9.15 SubagentFilterBar 凹陷槽参数 | ✓ 兄弟 worktree 实测：`bg-bg-input` 底（:45）+ active `bg-bg-elevated`（:56）+ `h-6`（:54）逐字命中 |
| dev-0.9.15 bucket SSOT 纪律与导出面 | ✓ 「判据只写这一处，禁止消费方重复实现 status 判定（D3）」注释 + bucket/filter/countSubagents 同模块导出（:42）——与 D10① 计划导出面同构 |
| dev-0.9.15 两段式 cancel / 空桶自适应 / badge 计数同源 | ✓ SubagentList.vue:87-99（cancellingId + Check 确认）+ :119-126（进行中空桶查看全部）+ useSidebarCounts.ts:16 消费 bucket 判据 |
