---
phase: execution
frame: convergence
converged: true
---

# 收敛复核 — tracing-round-2-convergence

> 收敛复核（Round 2）。独立收敛 subagent，上下文与主 agent 隔离。
> 追踪对象：⑥execution-plan.md（修订稿）+ ⑤code-architecture.md（§4 ID 已回流）。
> 上游依据：vertical-slice.md + wave-template.md + ③issues.md + decisions.md（confirmed 不当 gap 重报）。
> Round 1 来源：tracing-round-1-structure.md（组 A，4 gap: GAP-S1~S4）+ tracing-round-1-testclosure.md（组 B，4 gap: GAP-TC-1~4）。
> 追踪视角：编排结构（切片独立性/依赖闭合/并行安全）+ 测试闭环（Wave 覆盖并集 = ⑤test-matrix 全量）+ 实现闭环（验收 Wave/blocked_by/硬契约）。

## 收敛判定

**CONVERGED**

- Round 1 的 8 个 gap（GAP-S1/S2/S3/S4 + GAP-TC-1/2/3/4）**全部已修复**（8/8 ✅）。
- 三个视角（编排结构 + 测试闭环 + 实现闭环）重新追踪**无新 gap**。
- 修订未引入破坏执行契约的新问题：DAG 已改为 Wave 级且与调度表/⑤§8 一致；⑤§4 异常路径表 ID 已回流修正并与 execution-plan 清单完全一致；issue 级依赖网络作为「非 DAG 主图」的派遣参考，对执行关键路径（DAG + Wave 调度 + 测试清单）无阻断影响。
- 已追踪的视角：编排结构 / 测试闭环 / 实现闭环。

> **附注（低优先级观察，非 gap、不阻断收敛）**：execution-plan L40 的 issue 级依赖网络将 #7（SearchModal）blocked_by 列为 `#1 + #4 + #5 + #6`，未显式列 #3（useRecents）。按 ⑤§2 包依赖图存在 `SM --> UR` 直达边，理论上 #3 亦是 #7 直达依赖；⑤§4 功能1 时序图则显示 recents 经 useSearch 间接读取（SM→US→UR）。两种读法并存，属⑤§2 图 vs ⑤§4 时序图的既有张力（非本轮修订引入）。此网络注释已自我声明为「非 DAG 主图、供 subagent 派遣参考」，且 Wave 级调度（Wave3 blocked_by Wave2 blocked_by Wave1，#3 在 Wave1）已传递性覆盖 #3，故对执行无影响。记此观察备查，不上升为 gap。

## Round 1 gap 修复验证（8 个逐一 ✅/❌）

### 组 A（编排结构）

| Gap | 类型 | 位置 | 验证结果 | 证据 |
|-----|------|------|---------|------|
| **GAP-S1** | F（DAG 画 Wave 内部串行边）| execution-plan DAG mermaid | ✅ 已修复 | 修订后 DAG（L26-33）纯 Wave 级：`W1→W2→W3`、`W3→W4`、`W3→W5`、`W4→W5`。Wave 内部并行关系仅在节点标签内标注（`#1 ‖ #2 ‖ #3` / `#4 ‖ #6`），**无 Wave 内部串行边**。L35 注释显式声明「DAG 为 Wave 级（与调度表粒度一致）……不画 Wave 内部边——它们无相互依赖」。Wave1 串成链（#1→#2→#3）、Wave2 串成链（#4→#6）的虚假结构已消除。 |
| **GAP-S2** | F（虚假 #1→#6 边）| execution-plan DAG | ✅ 已修复 | DAG 不再画 #1→#6 边。issue 级依赖网络（L39）正确说明 #6 blocked_by #2+#3，**不含 #1**，并补实证依据「跳转不做子串过滤」「⑤§2 包依赖图无 USJ→US 边」「不含 #4」。三重上游（③issues #6 blocked_by 无 #1、⑤§4 功能3 时序图无 match-engine 参与者、⑤§2 图无 USJ→ME 边）一致。 |
| **GAP-S3** | F（子节点/Wave 双粒度混用）| execution-plan DAG | ✅ 已修复 | DAG 统一为 **Wave 级**（节点为 W1/W2/W3/W4/W5，非 #1/#2... 子节点），消除「既画子节点直达边又画 Wave 级边」的粒度混用。子节点级真实依赖（#4 依赖 #1/#2/#3 等）下放到调度表注释（L47-51）+ 各 Wave 详情正文 + issue 级依赖网络（L37-41），不入顶层 DAG。 |
| **GAP-S4** | K（T4.8 测试桩提示易漏）| Wave2 验收标准 | ✅ 已修复 | execution-plan Wave2 #4 验收标准（L211）已补 T4.8 测试桩提示：「T4.8（WS 断连超时 race）需 mock WS pending **永不 settle**（非普通立即 reject mock）——模拟真实 WS 断连场景……验证 withWsTimeout 的 10s timeout 触发 reject。普通 reject mock 无法覆盖此路径（#17 是最晚进 issues 的 P1，易漏）」。明确区分了「pending 永不 settle」与「普通 reject」两种 mock。 |

### 组 B（测试闭环 / ID 错位）

| Gap | 类型 | 位置 | 验证结果 | 证据 |
|-----|------|------|---------|------|
| **GAP-TC-1** | F（⑤§4 功能2 异常路径表 ID 错位 6/8）| code-architecture.md §4 功能2 异常路径表 | ✅ 已修复 | ⑤§4 功能2 异常路径表（L352-360）每条错位 ID 均修正并附 `[BACKFED from execution tracing-round-1 on 2026-06-30]` 标记：session reject `T4.3→T4.4`✅、WS 断连 `T4.7→T4.8`✅、全源失败 `T4.8→T4.9`✅、无 session `T1.4→T1.10`✅、乱序 `T1.5→T1.12`✅；file reject T3.3、文件数>5000 T3.5 原本正确保留。 |
| **GAP-TC-2** | F（⑤§4 功能3 异常路径表 ID 错位 3/5）| code-architecture.md §4 功能3 异常路径表 | ✅ 已修复 | ⑤§4 功能3 异常路径表（L426-430）错位 ID 均修正并附 BACKFED 标记：command 抛错 `T2.5→T2.6`✅、session.switch reject `T4.5→T4.6`✅、symbol 选中 `T5.2→T5.3`✅、跳转成功路径 `T2.6/T3.6/T4.6→T2.7/T3.6/T4.7`（成功关闭）修正成功/失败混列✅；file.read reject T3.4 原本正确保留。 |
| **GAP-TC-3** | F（⑤§4 功能4 异常路径表 ID 错位 3/5 + phantom）| code-architecture.md §4 功能4 异常路径表 + ⑤frontmatter | ✅ 已修复 | ⑤§4 功能4 异常路径表（L469-473）错位 ID 均修正并附 BACKFED 标记：open/close 交替 `T1.6→T1.13`✅、close 孤儿查询 `T1.7→T1.14`✅、组件卸载资源清理 `T1.8 phantom→无独立用例（AC-8.4 属 MR-8.1「已在③」）`✅。**⑤frontmatter backfed_from 已追加 `execution`**（L5 `backfed_from: [execution]`）✅。 |
| **GAP-TC-4** | F（T2.5 措辞歧义）| execution-plan 清单 T2.5 断言摘要 | ✅ 已修复 | execution-plan 测试验收清单 T2.5 断言摘要（L409）已澄清：「无 active session 时 slash 命令不进列表（**列表层保证选不到，故无『选中静默失败』执行路径**），AC-2.4」。消除了「执行失败」措辞带来的跨 Wave（#2 列表 vs #6 执行）误读，归属 Wave1 维持不变。 |

**修复验证汇总：8/8 ✅（GAP-S1/S2/S3/S4 + GAP-TC-1/2/3/4 全部已修复）。**

## 新 gap

**无新 gap。**

三个视角重新追踪均无新 gap。唯一发现是附注的低优先级观察（#7 issue 级依赖网络未显式列 #3），属⑤§2 图与⑤§4 时序图的既有张力、非本轮修订引入、且自我声明为参考性注释，Wave 级调度已传递性覆盖，不构成阻断收敛的 gap。

## 视角追踪记录

### 视角 1：编排结构（切片独立性 / 依赖闭合 / 并行安全）

#### 1.1 切片独立性 — ✅ 成立（复核 Round 1 结论维持）

- **Wave1 基础设施切片合理**：#1 match-engine（纯函数叶子）/ #2 命令注册表（store+composable 叶子）/ #3 recents（localStorage 叶子）三者无调用依赖（⑤§2 图三模块互不 import）、可独立单测验证。D-017「基础设施先行」成立。⑤§4 功能1/2 时序图消费此三模块，Wave1 解锁 Wave2 #4/#6。
- **Wave2 垂直切片**：#4 useSearch 切穿 matchFilter+commandStore+fileSearchStore+composer/session domain+WS transport；#6 useSearchJump 切穿 commandStore+composer/file/session domain+useRecents+useSidebar。两者完成后可独立 composable 级单测验证。
- **Wave3 单切片（集成点）合理**：⑤§4 功能1/2/3/4 UI 落地点同在 SearchModal.vue，必须同 subagent 同 PR 改。
- **Wave1 非纯垂直切片（叶子不切穿 UI）已透明声明**（L120「覆盖的是模块单元/容错用例，非端到端 UC 用例——后者归消费方 Wave3」），符合 vertical-slice.md「基础设施/prefactor Wave 可不交付端到端 demo」弹性。非 gap（Round 1 已确认 ⚠️）。
- **Wave4 串行合理**：#9 与 #10.2 同改 SearchModal.vue 必须串行。

#### 1.2 依赖闭合 — ✅ 成立（DAG 修订后更清晰）

- **Wave2 #4 blocked_by Wave1 #1+#2+#3 闭合**：⑤§4 功能2 时序图 useSearch.query 调 matchFilter(#1)+commandStore(#2)+fileSearchStore+composer/session domain+recents(#3)。③issues #4 `Blocked by: #1, #2, #3`。DAG（Wave 级 W1→W2）+ issue 网络（L38 #4 blocked_by #1+#2+#3）+ 调度表（Wave2 blocked_by Wave1）三处一致。
- **Wave2 #6 blocked_by Wave1 #2+#3 闭合**：⑤§4 功能3 时序图 useSearchJump.confirm 调 commandStore(#2)+useRecents.write(#3)+composer/file/session domain+useSidebar。③issues #6 `Blocked by: #2, #3`。issue 网络（L39）正确标注「不含 #1（跳转不做子串过滤）也不含 #4（⑤§2 图无 USJ→US 边）」。
- **Wave3 #7 blocked_by Wave2（#4+#6）+ Wave1 直达（#1）闭合**：⑤§4 功能4 时序图 SearchModal 调 useSearch(#4)+useSearchJump(#6)+match-engine(#1，跨 Wave 直达)。调度表 Wave3 blocked_by Wave2（隐含 Wave1 已完成）。⑤§2 图 `SM-->US, SM-->ME, SM-->USJ, SM-->UR`。
- **#17 物理合并入 #4 合理**：⑤骨架 useSearch.ts:131 `withWsTimeout`（D-023 confirmed）。同文件合并消除冲突。
- **#5 并入 Wave3 #7 原子性成立**：api/index 删 search 导出 + SearchModal 改 import useSearch 操作同一消费链。拆两 Wave 会编译断裂中间态（L79 论证充分）。③issues #5 blocked_by #4（Wave2），#7 在 Wave3，时序满足。
- **#8 并入 Wave3 #7 合理**：loading/error 态在 SearchModal.vue（⑤§4 功能4 时序图 setTimeout/error ref 都在 SM 节点）。

#### 1.3 并行安全 — ✅ 成立（DAG 修订后与调度表完全对齐）

- **Wave1 组 A（#1‖#2‖#3）文件无交集**：#1 `lib/match-engine.ts`（新）/ #2 `composables/features/useCommandRegistry.ts`（新）+`stores/command.ts`（扩展）/ #3 `composables/features/useRecents.ts`（新）。文件冲突分析表（L62-66）标独占，与⑤§1 工程目录一致。⑤§2 图三模块互不 import。**DAG 修订后不再画 Wave1 内部串行边**（GAP-S1 修复），与调度表「组 A 3 并行」声明一致。
- **Wave2 组 B（#4‖#6）文件独立**：#4 `useSearch.ts`（新）/ #6 `useSearchJump.ts`（新）。⑤§2 图 USJ 不依赖 US。**DAG 修订后不再画 #4→#6 边**（GAP-S1/S2 修复），与调度表「组 B 2 并行」声明一致。
- **Wave4 串行（#9‖#10.2 同改 SearchModal）判断正确**：文件冲突表（L70）标串行「#7 先改造，#9/#10.2 后扩展」。
- **SearchModal.vue 无并行冲突**：Wave1/Wave2 不碰 SearchModal（#1 segments 提取为独立文件 match-engine.ts，SearchModal 内调用点改造归 Wave3 #7）；Wave3 单点改造；Wave4 串行扩展。
- **Sidebar.vue 独占 Wave4 #10.1**，无其他 Wave 改 Sidebar。⌘K toggle 跨 Wave3/Wave4 协同（T1.6 主 Wave3 + Sidebar 侧 Wave4 #10.1）已显式登记（L447），属协同非文件冲突。

#### 1.4 编排结构其他子项 — ✅ 成立

- **Prefactor Wave 必要性判定成立**（L75-88）：不设独立 Prefactor，理由「⑤§7 move/replace/extend/delete 项与功能 Wave 一一对应，move 即目标态」。逐条核对⑤§7 映射表成立。D-017 Wave1 已起 prefactor 铺路作用。
- **末尾验收 Wave（Wave5）齐全**（L328-361）：存在、切片类型「验收（非功能切片）」、Blocked by Wave1-4、DAG 末端（W3→W5, W4→W5）、必须最后。符合 wave-template「末尾验收 Wave 模板（强制）」全部要求。
- **P3 延后项齐全**（L363-374）：#11~#16 共 6 项，逐条标「后续迭代」+ 延后理由 + source 溯源，与③issues §后续迭代一致。
- **性能混沌类缓解项编排成立**（L449-459）：声明「本 topic 无性能混沌类缓解项」，④缓解项验收方式分布逐条核对无性能混沌类，无需独立 perf/chaos Wave 或 pre-prod gate。

### 视角 2：测试闭环（Wave 覆盖并集 = ⑤test-matrix 全量）

#### 2.1 集合比对 — ✅ 完全一致（MISSING=0/PHANTOM=0/MISMATCH=0）

- ⑤test-matrix 全量 47 唯一 ID（UC-1 T1.1~T1.18 / UC-2 T2.1~T2.7 / UC-3 T3.1~T3.9 / UC-4 T4.1~T4.9 / UC-5 T5.1~T5.4，来源 A 44 + 来源 B 专属 3）。
- execution-plan 测试验收清单 47 行（L385-433），逐行收集 47 唯一 ID。
- 清单用例 ID 集合 ⊆ 各 Wave 覆盖并集，且并集 = ⑤test-matrix 全量（47=47）。

#### 2.2 各 Wave 覆盖核验（独立重新统计）— ✅ 一致

| Wave | 清单声称 | 独立重数 | 具体 ID | 一致 |
|------|---------|---------|---------|------|
| Wave1 | 7 | 7 | T1.8, T1.9, T1.16, T1.17, T1.18, T2.4, T2.5 | ✅ |
| Wave2 | 26 | 26 | T1.10, T1.12, T2.1, T2.2, T2.3, T2.6, T2.7, T3.1~T3.6, T3.9, T4.1~T4.9, T5.1~T5.3 | ✅ |
| Wave3 | 13 | 13 | T1.1, T1.2, T1.3, T1.4, T1.6, T1.7, T1.11, T1.13, T1.14, T1.15, T3.7, T3.8, T5.4 | ✅ |
| Wave4 | 1 | 1 | T1.5 | ✅ |
| 合计 | 47 | 47 | — | ✅ |

Wave 详情覆盖 = 清单归属（4 个 Wave 双向一致）。

#### 2.3 来源 B NFR 用例归属 — ✅ 一致

7/7 NFR 用例（T1.16/T1.17/T1.18 Wave1 unit；T3.3/T3.9/T4.8/T4.9 Wave2 integration）归属 Wave + 测试执行层全部与⑤§6 强制层级一致。

#### 2.4 ⑤§4 异常路径表 ID 回流后与 execution-plan 清单一致性 — ✅ 完全一致（GAP-TC-1/2/3 修复验证）

这是本轮收敛复核的**特别检查项**。逐条核验⑤§4 异常路径表（回流修正后）的异常用例 ID 是否与 execution-plan 测试验收清单完全一致：

**功能2 异常路径表（⑤§4 L352-360）↔ 清单**：
- T3.2（file 缓存命中）✅ 清单 T3.2 Wave2 ✅ 一致
- T3.3（file WS reject）✅ 清单 T3.3 Wave2 ✅ 一致
- **T4.4（session reject，原 T4.3 已修正）** ✅ 清单 T4.4 Wave2 ✅ 一致
- **T4.8（WS 断连超时 race，原 T4.7 已修正）** ✅ 清单 T4.8 Wave2 ✅ 一致
- **T4.9（全源失败，原 T4.8 已修正）** ✅ 清单 T4.9 Wave2 ✅ 一致
- **T1.10（无 session，原 T1.4 已修正）** ✅ 清单 T1.10 Wave2 ✅ 一致
- **T1.12（乱序响应，原 T1.5 已修正）** ✅ 清单 T1.12 Wave2 ✅ 一致
- T3.5（文件数>5000）✅ 清单 T3.5 Wave2 ✅ 一致

**功能3 异常路径表（⑤§4 L426-430）↔ 清单**：
- **T2.6（command 抛错，原 T2.5 已修正）** ✅ 清单 T2.6 Wave2 ✅ 一致
- T3.4（file.read reject）✅ 清单 T3.4 Wave2 ✅ 一致
- **T4.6（session.switch reject，原 T4.5 已修正）** ✅ 清单 T4.6 Wave2 ✅ 一致
- **T5.3（symbol 选中，原 T5.2 已修正）** ✅ 清单 T5.3 Wave2 ✅ 一致
- **T2.7/T3.6/T4.7（跳转成功路径，原 T2.6/T3.6/T4.6 混列已修正）** ✅ 清单 T2.7/T3.6/T4.7 Wave2 ✅ 一致

**功能4 异常路径表（⑤§4 L469-473）↔ 清单**：
- **T1.13（open/close 交替，原 T1.6 已修正）** ✅ 清单 T1.13 Wave3 ✅ 一致
- **T1.14（close 孤儿查询，原 T1.7 已修正）** ✅ 清单 T1.14 Wave3 ✅ 一致
- T3.7（>200ms loading）✅ 清单 T3.7 Wave3 ✅ 一致
- T3.8（<200ms loading）✅ 清单 T3.8 Wave3 ✅ 一致
- 无独立用例（组件卸载资源清理，原 phantom T1.8 已修正）✅ 清单无 T1.8 资源清理行 ✅ 一致

**⑤§4 异常路径表回流修正后与 execution-plan 清单 ID 完全一致，无残留错位。** execution-plan 同时在清单头部（L383）声明「ID 真相源声明：本清单 ID 为唯一验收真相源，⑤§4 异常路径表 ID 仅供 alt/else 分支语义溯源」——双保险，即使⑤§4 有残留误差也不影响 Wave5 验收。

#### 2.5 跨 Wave 协同用例 — ✅ 显式登记

T1.3（scrollIntoViewIfNeeded 算法 Wave4 #10.2 + 渲染 Wave3）、T1.6（⌘K toggle 主 Wave3 + Sidebar 侧 Wave4 #10.1）、T1.7（segments 算法 Wave1 #1 + DOM 渲染 Wave3）协同关系透明，主归属清晰（L443-445）。

### 视角 3：实现闭环（验收 Wave / blocked_by / 硬契约）

#### 3.1 实现闭环骨架 — ✅ 全部 PASS

| 审计项 | 结论 | 证据 |
|--------|------|------|
| 「测试验收清单」章节存在 | ✅ | execution-plan L376-447「测试验收清单（Test Acceptance Manifest）— [MANDATORY]」 |
| 清单用例 ID 集合 = ⑤test-matrix 全量（A+B） | ✅ | 47 行，MISSING=0/PHANTOM=0/MISMATCH=0 |
| 末尾验收 Wave（Wave5）存在 | ✅ | L328「Wave 5: 验收 Gate」 |
| Wave5 blocked_by 所有功能 Wave | ✅ | L332「Blocked by: Wave1, Wave2, Wave3, Wave4」 |
| Wave5 在 DAG 末端 | ✅ | 修订后 DAG `W3→W5, W4→W5`；W5 无出边 |
| 每个功能 Wave 覆盖的用例 ID 在验收清单出现（双向一致） | ✅ | Wave 详情覆盖 = 清单归属（4 Wave 全核验，见视角 2.2） |
| 清单「功能归属 Wave」×「测试执行层」双列清晰 | ✅ | L385 表头两列独立，未混用 |
| 交接措辞为硬契约（DoD = 清单全绿） | ✅ | L20 + L463「编码完成的定义 = 测试验收清单全绿（47 条全 PASS）」+ L465「末尾验收 Wave 未绿 = 实现未完成」 |
| 偏离通道（[DEVIATED] 登记）存在 | ✅ | L469「编码中发现用例设计错误/不可行，走 [DEVIATED] 登记」 |

#### 3.2 DAG 修订对实现闭环的影响 — ✅ 无破坏

- DAG 改为 Wave 级后，Wave5 仍为 DAG 末端（W3→W5, W4→W5），blocked_by Wave1-4 关系不变。
- 验收 Wave 的硬契约（清单全绿 = 实现完成）不依赖 DAG 的内部画法，DAG 修订仅澄清 Wave 间依赖，不改变 Wave5 的闭环闸门地位。
- Wave5 验收以测试验收清单（唯一真相源）为基线，不受⑤§4 异常路径表 ID 错位影响（清单 L383 已声明 ID 真相源）。

#### 3.3 decisions.md confirmed 决策核对 — 无 REVISIT 触发

- D-017（P0/P1 划线）/ D-018（loading+error P1）/ D-019 revisited by D-020（debounce 提前）/ D-021（5000 校正）/ D-022（loadSeq 骨架约束）/ D-023（#17 WS race）/ D-024（AC-6.9 直调）/ D-025（DTO 映射）/ D-026（编排归 composable）均 confirmed，与本次追踪发现无冲突。
- 本轮修订（DAG Wave 级化、⑤§4 ID 回流、T4.8 桩提示、T2.5 措辞澄清）均不触发新 REVISIT——它们是 Round 1 gap 的修复执行，非推翻既有决策。

## 收敛结论

**converged: true。** Round 1 的 8 个 gap 全部已修复（8/8 ✅），三个视角重新追踪无新 gap，修订未引入破坏执行契约的新问题。执行计划（⑥）+ 代码架构（⑤）在编排结构、测试闭环、实现闭环三个视角已收敛一致，可进入编码实现阶段。

附注的低优先级观察（#7 issue 级依赖网络未显式列 #3）属⑤§2 图与⑤§4 时序图的既有张力，已被 Wave 级调度传递性覆盖，不影响收敛判定。
