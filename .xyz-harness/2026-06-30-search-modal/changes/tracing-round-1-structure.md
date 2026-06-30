---
phase: execution
frame: structure
converged: false
---

# 编排结构审计（组 A）— tracing-round-1-structure

> 审计对象：⑥execution-plan.md（执行计划初稿）
> 审计视角：切片独立性 / 依赖闭合 / 并行安全
> 上游依据：⑤code-architecture.md §2 包依赖图 + §4 时序图 + §7 现有代码映射 + §8 Wave DAG；③issues.md（P0/P1/P2 + blocked_by）；decisions.md（confirmed 决策账本）
> 原则依据：vertical-slice.md + wave-template.md
> 注：本文件原为 architecture-phase structure 帧追踪（已归档并入历史），本轮 overwrite 为 **execution-phase** 编排结构审计。

## 审计结论

**verdict: GAP_FOUND**

发现 **4 个 gap**（3 个事实性 F + 1 个知识性 K）。核心问题集中在 DAG 图内部画出了与「并行组」声明直接矛盾的串行依赖边，使 DAG 与调度表两份「真相源」互相打架——执行者无法判断 Wave1/Wave2 到底是并行还是串行。其余视角（切片独立性、文件冲突、Prefactor 判定、验收 Wave、P3 延后、性能混沌）经核对**成立**。

## gap 清单

### GAP-S1
- **类型**：F（事实性矛盾）
- **位置**：execution-plan.md「Wave 编排总览 → 依赖 DAG 图」（L26-45 mermaid）vs「调度表」（L51-57）vs TL;DR（L15）
- **问题**：DAG 图内部画出 4 条 Wave 内部串行边——Wave1 内 `W1a[#1] --> W1b[#2]`（L38）、`W1a --> W1c[#3]`（L39）、`W1b --> W1c`（L40）；Wave2 内 `W2a[#4] --> W2b[#6]`（L41）。这些边把 Wave1 三模块和 Wave2 两 composable **串成链**。但调度表（L53）声明 Wave1 =「组 A（3 并行）……叶子模块无依赖」，TL;DR（L15）声明「Wave1（P0 基础设施，3 并行）→ Wave2（P1 编排层，2 并行）」，调度表 L54 声明「#4‖#6 二者并行」。**同一文件内，DAG 画串行、调度表/TL;DR 声明并行，两份真相源直接冲突**。对照上游 ⑤§8「Wave 依赖 DAG」明确写「Wave1（P0，无依赖并行）：#1 / #2 / #3」，③issues #1/#2/#3 三者 `Blocked by: 无`（彼此无依赖），⑤§2 包依赖图 match-engine / useCommandRegistry / useRecents 三个新文件互不 import——三重上游均支持并行，无 Wave 内部依赖。DAG 的 W1a→W1b→W1c 三条边与 W2a→W2b 一条边系**初稿杜撰，偏离上游**。
- **影响**：执行者读 DAG 会把 Wave1 当串行（#1 完成才能 #2 才能能 #3），丧失并行加速；或读调度表当并行，与 DAG 不符。两组判断都对不了，是结构噪声。
- **建议修订**：删除 DAG 内 L38/L39/L40（Wave1 内部 #1→#2/#3、#2→#3 边）与 L41（Wave2 内部 #4→#6 边）。保留跨 Wave 边（Wave1 子节点 → Wave2 子节点的真实依赖）。使 DAG 的图语义 = 调度表的并行声明 = ⑤§8 上游 DAG。

### GAP-S2
- **类型**：F（事实性矛盾 / 虚假依赖）
- **位置**：execution-plan.md DAG 图 L42 `W1a[#1 match-engine] --> W2b[#6 useSearchJump]`
- **问题**：DAG 声明 #6（useSearchJump）blocked_by #1（match-engine）。对照上游：③issues #6 `Blocked by: #2, #3`（无 #1）；⑤§4 功能3（选中跳转）时序图参与者含 useSearchJump/useRecents/composer/file domain/useDetailPane/useSidebar，**无 match-engine**（跳转不做子串过滤）；⑤§2 包依赖图 useSearchJump 节点出边为 commandStore/composer/session/file domain + useRecents + useDetailPane + useSidebar，**无 match-engine 边**。三重上游均证明 #6 不依赖 #1。该边是虚假依赖，会（配合 GAP-S1 的串行语义）进一步误导执行者。
- **建议修订**：删除 L42。#6 的真实 blocked_by = Wave1 #2 + #3（已在 L30 `W1b-->W2b`、L32 `W1c-->W2b` 正确体现），无需 #1。

### GAP-S3
- **类型**：F（事实性矛盾 / 粒度不自洽）
- **位置**：execution-plan.md DAG 图 L36 `W1a[#1] --> W3[Wave3]`、L37 `W1b[#2] --> W4[Wave4]`
- **问题**：这两条边依赖关系本身成立（Wave3 #7 SearchModal 用 segments/matchFilter 确实依赖 #1；Wave4 #10.1 Sidebar 用命令注册表确实依赖 #2），但**调度表（L55-56）的 Blocked by 列**写的是 Wave3 =「Wave2」、Wave4 =「Wave3」——调度表采用**Wave 粒度**（只标跨 Wave 依赖，不标子节点→Wave 的直达边），而 DAG 采用**子节点粒度**（混标子节点直达边）。DAG 与调度表粒度不一致，且 DAG 既画子节点级边（W1a→W3）又画 Wave 级边（W3→W4），**两种粒度混用**，读者难以判断 Wave3 的真实 blocked_by 是「仅 Wave2」还是「Wave1 #1 + Wave2」。这不是错误依赖（边本身合理），是**表达粒度不自洽的结构噪声**。
- **影响**：与 GAP-S1/S2 叠加，DAG 看上去既有大量内部串行边又有跨 Wave 边，整体拓扑复杂度被人为放大，掩盖了真实的「Wave1 并行 → Wave2 并行 → Wave3 单切片 → Wave4 单切片」线性结构。
- **建议修订**：统一 DAG 粒度——要么全部子节点级（Wave3 也拆 W3a[SearchModal]，边标到子节点），要么全部 Wave 级（删子节点直达边，仅留 Wave→Wave）。推荐 **Wave 级**（与调度表/⑤§8 对齐最简），仅保留：W1→W2, W2→W3, W3→W4, W1→W4（#10.1 依赖 #2，属 Wave1 全体就绪后；可省，因 Wave4 主依赖是 Wave3），W3→W5, W4→W5。子节点级真实依赖（#4 依赖 #1/#2/#3 等）已在调度表注释 + 各 Wave 详情正文充分说明，不必入顶层 DAG。

### GAP-S4
- **类型**：K（知识性 / 验收闭环易漏点提示）
- **位置**：execution-plan.md「测试验收清单」T4.8（L431）+ Wave5 验收标准（L363）+ Wave2 #4 验收标准（L213）
- **问题**：wave-template.md「测试闭环检查」第 9 条要求「⑤每张时序图的 alt/else 异常分支 → 落在某个 Wave 的 test-matrix 覆盖」。⑤§4 功能2 异常路径表列有一条「**WS 断连 file/session 源永不 settle**（#17 超时 race）→ T4.8」。验收清单（L431）T4.8 标注「Wave2 / integration / 待验」——这条归属正确。但 Wave5 验收标准（L363）与 Wave2 验收标准（L213）均未显式提示 T4.8 这条 **integration 层** 用例需 mock WS 断连（pending 永不 settle）这一特殊测试桩，是较易在实现期被漏掉的高风险用例（#17 是反哺新增的、最晚进 issues 的 P1，需 mock pending 永不 settle 而非普通 reject）。虽不构成 gap（用例已入清单、归属正确），但作为**验收 Wave 易漏点**提请强化。
- **建议修订**：在 Wave2 #4 验收标准或 Wave5 执行流补充一行提示：「T4.8（WS 断连超时 race）需 mock pending 永不 settle 的测试桩，非普通 reject mock——这是 #17 反哺新增的高风险用例」。非阻断，属加固建议。

## 逐视角审计记录

### 子视角 1：切片独立性

- ✅ **Wave1 作基础设施 Wave 合理**：#1 match-engine（纯函数叶子）/ #2 命令注册表（store+composable 叶子）/ #3 recents（localStorage 叶子）三者无调用依赖、可独立单测验证（⑤§3 三者接线层级均标「叶子」或「跨模块读」无同层互调）。⑤§4 功能1 时序图（query('')→useRecents.read + useCommandRegistry.list）+ 功能2（matchFilter 过滤）确实消费这三模块，Wave1 先行解锁 Wave2 #4/#6，符合 D-017「基础设施先行」。
- ✅ **Wave2 是垂直切片**：#4 useSearch 切穿 matchFilter + commandStore + fileSearchStore + composer/session domain + WS transport（⑤§4 功能2 时序图）；#6 useSearchJump 切穿 commandStore + composer/file/session domain + useRecents + useSidebar（⑤§4 功能3 时序图）。两者完成后均可独立单测验证（composable 级）。
- ✅ **Wave3 单切片合理**：⑤§4 功能1/2/3/4 时序图的 UI 落地点都在 SearchModal.vue 同一文件（渲染分组/高亮/confirmSel 改调/生命周期），必须同一 subagent 同 PR 改，合为单切片符合「同文件不拆 Wave」原则。
- ⚠️ **Wave1 切片类型标注为「基础设施（叶子模块，可独立验证）」而非纯垂直切片**：vertical-slice.md 强调「每 Wave 切穿所有层可独立 demo」。Wave1 三模块是叶子，**不切穿 UI 层**（无 SearchModal 渲染），完成时无法端到端 demo（用户可见行为在 Wave3 才闭合）。这是合理的工程权衡（基础设施 Wave 不要求端到端 demo，模块单测即完成判定），execution-plan 已在 L126 显式声明「Wave1 是叶子基础设施，覆盖的是模块单元/容错用例（非端到端 UC 用例——后者归消费方 Wave3）」，声明透明、判定合理。记为 ⚠️ 非 ❌——符合 vertical-slice.md 的「Prefactor/基础设施 Wave 可不交付端到端 demo」弹性（规则 3 prefactor Wave 不交付业务功能）。
- ✅ **Wave4 串行合理**：#9 与 #10.2 同改 SearchModal.vue，必须串行（详并行安全视角）。

### 子视角 2：依赖闭合

- ✅ **Wave2 #4 blocked_by Wave1 #1+#2+#3 成立**：⑤§4 功能2 时序图 useSearch.query 调 matchFilter（#1）+ 读 commandStore（#2）+ 读 fileSearchStore（store，#2 间接）+ composer/session domain + recents（#3 空 query 时）。③issues #4 `Blocked by: #1, #2, #3`。闭合。
- ✅ **Wave2 #6 blocked_by Wave1 #2+#3 成立**：⑤§4 功能3 时序图 useSearchJump.confirm 调 commandStore（#2）+ useRecents.write（#3）+ composer/file/session domain + useSidebar。③issues #6 `Blocked by: #2, #3`。闭合。
- ❌ **Wave2 内 #4 ‖ #6 并行安全成立，但 DAG 画了 #4→#6 串行边（GAP-S1）**：⑤§2 包依赖图 useSearchJump 不依赖 useSearch（无 US→USJ 边），③issues #6 blocked_by 不含 #4。**并行本身安全**（见并行安全视角 ✅），是 DAG 图（L41）画错——记入 GAP-S1。
- ✅ **Wave3 #7 blocked_by Wave2（#4+#6）完整**：⑤§4 功能4 时序图 SearchModal 调 useSearch.query（#4）+ useSearchJump.confirm（#6）+ useRecents + match-engine（#1，跨 Wave 直达）。③issues #7 `Blocked by: #1, #2, #3, #4, #5, #6`。调度表 Wave3 Blocked by = Wave2 是 Wave 粒度表达（隐含 Wave1 已完成），实际 #7 依赖链完整。DAG 的 W1a→W3 边（#1→Wave3）反映 #1 直达 #7 的真实依赖（⑤§2 SM→ME 边），边本身正确（见 GAP-S3 粒度问题）。
- ✅ **#17 物理合并入 #4 合理**：⑤骨架确认 useSearch.ts:131 `withWsTimeout`（§9 骨架覆盖核验 L667「WS 超时 race useSearch.ts:131」）。③issues #17 方案A「useSearch.query() 内对 WS 源包 Promise.race」。同文件合并消除冲突，D-023 confirmed。合理。
- ✅ **#5 并入 Wave3 #7 原子性论证成立**：⑤§3 api/index.ts「删 search 导出」+ SearchModal「改 import useSearch」操作同一消费链（api.search→useSearch）。execution-plan L79 论证充分：拆两 Wave 会产生「导出删了但 SearchModal 仍调 api.search」编译断裂中间态。③issues #5 `Blocked by: #4`，#4 在 Wave2，#7 在 Wave3（#5 随 #7），依赖时序满足（Wave2→Wave3）。原子性成立。
- ✅ **#8 并入 Wave3 #7 合理**：#8 loading/error 态在 SearchModal.vue 实现（⑤§4 功能4 时序图 setTimeout/error ref 都在 SM 节点）。③issues #8 `Blocked by: #4`（error 挂载点在 useSearch catch，#4 Wave2 就绪）。#8 随 #7 同文件改，合理。注意 AH-S2（error 态可达性：查询路径不进全局 error，仅跳转失败触发）——跳转 error 在 useSearchJump（#6 Wave2 已覆盖），SearchModal 只接跳转结果 toast，分层清晰（L273 已说明）。

### 子视角 3：并行安全

- ✅ **Wave1 组 A（#1‖#2‖#3）文件无交集**：#1 改 `lib/match-engine.ts`（新）/ #2 改 `composables/features/useCommandRegistry.ts`（新）+ `stores/command.ts`（扩展）/ #3 改 `composables/features/useRecents.ts`（新）。三组文件互不重叠（execution-plan 文件冲突分析表 L69-72 标独占，与⑤§1 工程目录一致）。⑤§2 包依赖图三模块互不 import。并行安全。
- ✅ **Wave2 组 B（#4‖#6）文件独立**：#4 改 `composables/features/useSearch.ts`（新）/ #6 改 `composables/features/useSearchJump.ts`（新）。两文件不同。⑤§2 包依赖图 USJ 不依赖 US（useSearchJump 出边无 useSearch）。并行安全（注：③issues #6 blocked_by 不含 #4，#6 真不需 #4 先行；DAG 的 #4→#6 边是错误——GAP-S1）。
- ✅ **Wave4 串行（#9‖#10.2 同改 SearchModal）判断正确**：#9（Tab onKeydown + activeType）与 #10.2（scrollIntoViewIfNeeded）都改 `components/overlays/SearchModal.vue`，execution-plan L76 文件冲突表标「串行：#7 先改造，#9/#10.2 后扩展」，L293 声明串行。#10.1 改 Sidebar.vue 独立文件，本可与 #9/#10.2 并行，但 execution-plan L293 选择串行（「P2 不值得并行编排复杂度」）——这是合理工程取舍（P2 增强项，避免为并行增加调度开销），非错误。
- ✅ **⑤§7「同文件被多时序修改」情况均识别并串行化**：⑤§7 现有代码映射表，SearchModal.vue 被「move segments(#1) + rewrite loadResults(#4) + rewrite confirmSel(#6) + refactor 主体(#7) + extend Tab/scroll(#9/#10.2)」多时序修改。execution-plan 处理：#1 segments 在 Wave1 提取为独立文件（match-engine.ts），**SearchModal 内的 segments 调用点改造归 Wave3 #7**（#1 只搬出纯函数，不改 SearchModal）；#4/#6 在 Wave2 各自新文件（不改 SearchModal）；SearchModal 的所有改造（loadResults→useSearch、confirmSel→useSearchJump、recents→useRecents、主体 refactor）集中在 Wave3 #7 单 subagent；Wave4 #9/#10.2 串行扩展。**即 SearchModal.vue 在 Wave1/Wave2 不被碰，Wave3 单点改造，Wave4 串行扩展**——同一文件无并行冲突。识别完整。
- ✅ **Sidebar.vue 同文件**：#10.1 改 Sidebar.vue（keydown 接 useCommandRegistry + ⌘K toggle），Wave4 独占（L77 文件冲突表标独占），无其他 Wave 改 Sidebar。安全。注：Sidebar.vue 的 ⌘K toggle（AC-7.1 变更项）跨 Wave3/Wave4 协同——execution-plan L268/L327 说明「⌘K toggle 在 #7 或搭便车 #10.1 落地」，L447 跨 Wave 协同用例 T1.6 标「主 Wave3，⌘K toggle 的 Sidebar 侧在 Wave4 #10.1」。协同关系已显式登记，非文件冲突（协同 ≠ 同文件并发改）。

## 其他发现（非 gap）

1. **Prefactor Wave 必要性判定成立**：execution-plan L83-94 判定「不设独立 Prefactor」，理由「⑤§7 move/replace/extend/delete 项与功能 Wave 一一对应，move 即目标态」。逐条核对 ⑤§7 映射表：segments move→match-engine（Wave1 #1，提取即终态纯函数）、loadResults move+rewrite→useSearch（Wave2 #4，搬移与改写同步）、SEARCH_RECENTS replace→useRecents（Wave1 #3，replace 本身即改造）、command store extend（Wave1 #2，扩展即交付）、api/index delete（Wave3 #5，删除即终态）。每项「move+目标态」一步到位，独立 prefactor 会重复搬动。判定符合 wave-template「greenfield 无 Prefactor / refactor 若 move 即功能则免」弹性。D-017 Wave1 已起 prefactor 铺路作用。**判定充分**。

2. **末尾验收 Wave（Wave5）齐全**：存在（L333）、切片类型「验收（非功能切片）」、Blocked by「Wave1,2,3,4（所有功能 Wave）」（L338）、DAG 末端（L43-44 `W3-->W5, W4-->W5`，无 W5→后继）、必须最后（L339）。符合 wave-template「末尾验收 Wave 模板（强制）」全部要求。验收标准含「测试验收清单全量 47 条 PASS」「无 DEVIATED 未经确认」「覆盖率报告」三条硬契约。**闭环闸门成立**。

3. **P3 延后项齐全**：execution-plan L372-379 列 #11~#16 共 6 项 P3，逐条标「后续迭代」+ 延后理由 + source 溯源。对照 ③issues §后续迭代（L817-824）#11~#16 完全一致（6 项，理由与溯源逐条对应）。wave-template「P3 标注后续迭代+延后理由」满足。**无遗漏**。

4. **性能混沌类缓解项编排成立**：execution-plan L456-462 声明「本 topic 无性能混沌类缓解项」，逐条核对 ④缓解项验收方式分布：代码测试（MR-3.1/3.3/3.4 unit + MR-4.2/4.4/17.1 integration）→ 已落⑤test-matrix 来源 B 归 Wave1/Wave2；骨架约束（MR-3.2/MR-4.1）→ ⑤骨架 tsc；已在③（MR-4.3/4.5/6.1/8.1）→ 来源 A 覆盖；接受的残余风险（session.list 耗时/大仓库截断/localStorage 配额）→ 非需测试的性能混沌项。**无验收方式=性能混沌的项，声明属实**，无需独立 perf/chaos Wave 或 pre-prod gate。

5. **test-matrix 用例归属与并集核对（顺带，属测试闭环视角但与本审计交叉）**：验收清单 47 条，归属汇总（L439-443）：Wave1=7 / Wave2=26 / Wave3=13 / Wave4=1，合计 47。抽样核对 T1.5（Tab 切类）归 Wave4（AC-9.x 在 #9 Wave4 ✅）、T1.8/T1.16-1.18（recents 容错）归 Wave1（#3 ✅）、T4.8（WS 超时 race）归 Wave2（#4+#17 ✅）。并集 = ⑤test-matrix 全量（来源 A 47 用例，来源 B 专属 T1.16/17/18 已含，双源 T3.3/T3.9/T4.8/T4.9 标 MR 引用）。**无遗漏**（本视角非主责，详核留给测试闭环追踪组）。

6. **跨 Wave 协同用例显式登记**：execution-plan L446-448 登记 T1.3（scrollIntoViewIfNeeded 算法 Wave4 #10.2 + 渲染 Wave3）、T1.6（⌘K toggle 主 Wave3 + Sidebar 侧 Wave4 #10.1）、T1.7（segments 算法 Wave1 #1 + DOM 渲染 Wave3）。协同关系透明，主归属清晰，符合 wave-template「用例 ID 无重复归属导致漏测」要求。
