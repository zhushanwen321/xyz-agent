# renderer 过度设计审计修复 实施计划

基线: 6bd34d6c029573797f9c5cc1a76f189f13a1ebb2 | 来源设计: docs/design/renderer-over-engineering-remediation.md | 日期: 2026-09-11
审计证据: docs/design/renderer-over-engineering-audit-20260911.md

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1 背景/目标（含 Out-of-scope） |
| 终态/机制 | §2 终态/机制（2.1-2.7 按组） |
| 验收场景表 | §3 验收场景表（V1-V11） |
| 下一层拆分 | §2 各小节 → 本文 §2 单元列表（u01-u20） |
| 待验证检查点 | §4 裁决记录 1-6（1-5 计划建立期，6 为阶段 3 补录）；§3 V8（mock 接回行为验证） |

## 1 目标快照

逐字摘录设计文档 §1：

> 目标：
> 1. 删除迁移残留死代码与孤儿脚手架（约 1500 行），消除「哪份是 SSOT」的双轨辨析成本
> 2. 收敛孪生/镜像/转发结构（fork 通知链路、listSync 孪生、settings 双转发层、popover 微包装）
> 3. 退役未兑现的依赖赌注（vee-validate / @vee-validate / zod + ui/table + ui/form）
> 4. 修复 settings 域 mock 旁路（mock 模式下 19 方法打真实 WS，与全应用背离）
> 5. 完成 12 处语句级清理点
>
> Out-of-scope：审计「已核实非过度」清单（见审计报告同名节）一律不动；`packages/core`、`packages/ui` 本体不在本轮范围。

## 2 单元列表

路径根：`packages/renderer/src/`（简写 `R/`）；其余仓库根相对。

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|---------------------|------|------|---------|
| u01 | 候选1：search 死链全删 + core app-commands 收口（留 renderer 版） | R/composables/features/search/useSearch.ts、useSearchJump.ts；R/composables/features/new-task/useRecents.ts；R/composables/features/command/useCommandRegistry.ts；R/__tests__/composables/useSearch.test.ts、useSearchJump.test.ts、useRecents.test.ts；R/__tests__/i18n/section-kind.test.ts（仅清引用）；packages/core/src/domain/new-task-search/app-commands.ts（删）、index.ts（删 re-export 行） | 无 | plain | 删除文件 grep 零残留引用；renderer+core typecheck 绿；既有测试绿 |
| u02 | 候选2+8：markdown 交互死链 + shell 孤儿删除 + #7 注释修正 | R/composables/panel/useMarkdownInteractions.ts、useCodeblockCopy.ts、useToolMeta.ts；R/composables/logic/markdown.ts（仅 :284 注释）；R/__tests__/composables/useMarkdownInteractions-fallback.test.ts；R/shell/sessions-entry.ts；R/shell/index.ts；R/workspace/index.ts；R/__tests__/shell/sessions-entry.test.ts；R/composables/features/sidebar/useSidebar.ts（+1 行意图注释） | 无 | plain | 同 u01 验收方式 |
| u03 | 清理点#1 批次a：settings/oauth/import/toast 域零引用导出收窄 | ToastOptions、SPINNER_STATUSES、NEUTRAL_ENGINE_ICON、ProviderOAuth* 四类型、AuthedModelOption、ImportState、IMPORT_* 四常量（执行时核实均有活引用，不收窄）的定义文件（执行时 grep 定位，预计 ≤5 文件） | 无 | plain | typecheck 绿（含 typecheck:test）；每符号 grep 生产引用 0 |
| u04 | 清理点#1 批次b：chat/stream 域零引用导出收窄 | TraceJumpResult、AttachedContextItem、NEW_SUBAGENT_ITEM_ID、SymbolCandidate、SlashCandidateInput、SkillCandidate*、SlashCommandSource、LineStats、LoadStatus、MAX_ENTRIES 定义文件（≤5 文件，超则上报切批） | 无 | plain | 同 u03 |
| u05 | 清理点#1 批次c：panel 域零引用导出收窄 | DetailPaneState、PreviewStatus、ROOT_PANEL_ID、SubagentBucket、EmptyResultStrikeGuard、PartitionedRecords、ResolvePreviewPathResult、DetectedPlatform 定义文件（≤5 文件） | 无 | plain | 同 u03 |
| u06 | 清理点#3+#4：useAccordionGuard 三态收敛 + useBackgroundTasks 删防御分支 | R/composables/features/settings/useAccordionGuard.ts；R/composables/features/sidebar/useBackgroundTasks.ts | 无 | plain | 既有测试绿；typecheck 绿 |
| u07 | 清理点#5+#6+#12：useMessageStreamNotices 空壳改名 + useGlobalShortcuts 悬空注释 + useCompactQueue 双契约注释 | R/composables/panel/useMessageStreamNotices.ts（改名）；R/components/panel/MessageStream.vue、message-stream/ActivityStrip.vue（import 同步）；R/composables/shell/useGlobalShortcuts.ts（:31 注释）；R/composables/panel/useCompactQueue.ts（注释） | 无 | plain | typecheck 绿；grep 旧名零残留 |
| u08 | 清理点#9：useExtensionHostBridge 返回对象瘦身 + `__*ForTest` 后门归整 | R/composables/shell/useExtensionHostBridge.ts（:283-293）；关联测试文件（grep `ForTest` 定位，≤2 文件） | 无 | plain | 既有测试绿；生产调用方无需改动（grep main.ts/App.vue 核对） |
| u09 | 清理点#10：PanelLeaf 单成员判别字段与 panels merge 兼容残迹清理（跨包） | packages/shared/src/panel.ts；R/stores/panel.ts；packages/core/src/domain/session/api-port.ts；R/composables/effects/useMessageEffects.ts（:80 消费方同步） | 无 | plain | renderer+core+shared typecheck 绿；runtime 相关测试不受影响（shared 改动跑 shared 测试） |
| u10 | 组C：aggregate.ts PROVIDER_COLORS 并入 AggregatedData + #11 去 export | R/components/settings/usage/aggregate.ts | 无 | plain | typecheck 绿；颜色映射数据随返回值可取（测试或类型证明） |
| u11 | 组C：usage 消费组件取色迁移 批次1 | R/components/settings/usage/UsagePage.vue、UsageDetailTable.vue（UsageLedger.vue、UsageCacheMix.vue 经阶段 3 核实零取色调用、零改动 [校准]） | u10 | plain | typecheck 绿；V4（配色与改前一致） || u12 | 组C：usage 消费组件取色迁移 批次2 | R/components/settings/usage/UsageDailyChart.vue、UsageModelRank.vue、UsageProjectRank.vue（UsageHeatCalendar.vue 零取色调用、零改动 [校准]） | u10 | plain | 同 u11 |
| u13 | 组D1：RenameSessionDialog 直连改写 + 删 ui/form 整目录 | R/components/sidebar/RenameSessionDialog.vue；R/components/ui/form/（7 文件整目录 [校准 阶段 3]） | 无 | plain | V5 校验判定等价（空/超60/换行拒绝、合法成功）；错误可见时机差异=已登记偏差 D7；grep vee-validate 在 renderer 内零 import |
| u14 | 组D2：删 ui/table + popover 旧副本 + package.json 依赖清理 | R/components/ui/table/（7 文件整目录）；R/components/ui/popover/PopoverListItem.vue、PopoverActionItem.vue；packages/renderer/package.json；pnpm-lock.yaml | u13 | plain | build 成功且产物无 vee-validate；grep 零残留引用 |
| u15 | 组E1：listSync 孪生合并（裁决5：删 workflow 版冗余 immediate 后归一） | R/composables/features/chat/useSubagentListSync.ts、useWorkflowListSync.ts（合并为单参数化模块）；R/components/sidebar/Sidebar.vue（:281-282 调用点）；R/__tests__/composables/useSubagentListSync.test.ts | 无 | plain | V6（挂载首拉一次、切 tab 首拉一次）；测试绿（断言 immediate 行为对齐后形态） |
| u16 | 组E2：fork 通知链路收敛（模块级单例 + 删镜像层/多播 Set/'waiting' 死分支）+ #1 fork 域符号顺带收窄 | R/composables/features/fork-handoff/useForkBranchNotify.ts；R/composables/effects/useForkNoticeEffect.ts；useForkBranchBadges 及直接消费方（执行时定位，≤3 文件）；#1 fork 符号（ApplyDeltaFn、FinalizeStreamFn、SetMessagesFn、BackgroundTask*）定义文件 | 无 | plain | V7（角标产生/清除等价）；fork 相关既有测试绿 |
| u17 | 组F1：settings-transport-adapter 接回 @/api 门面三元 + 坍缩（裁决3） | R/composables/shell/settings-transport-adapter.ts；R/composables/shell/useSettingsShell.ts（:63 注入点）；R/composables/shell/__tests__/useSettingsShell.test.ts；R/__tests__/settings/settings-modal-smoke.test.ts；grep `SettingsTransport` 命中的其余测试（≤2 文件） | 无 | plain | V8（mock 模式 settings 走 mock）；real 模式功能等价；settings 相关测试绿 |
| u18 | 组F2：api/domains/settings.ts 登记测试接缝（裁决2-B）+ useAppUpdate 路径统一 + #2 restore* 挪移 | R/api/domains/settings.ts（文件头）；R/composables/features/settings/useAppUpdate.ts（import 路径 + :787-788）；useAppUpdate*.test.ts 中 mock 目标同步（grep 定位，≤4 文件） | 无 | plain | V9（IPC import 全经 api/domains/settings）；useAppUpdate 全部测试绿 |
| u19 | 组G1：vue_rules_checker 豁免通道（裁决1） | .githooks/vue_rules_checker.py（:48 门禁处 + 豁免解析）；checker 自测样例（临时文件验证不入库） | 无 | plain | 带 `<!-- split-justified: <域> -->` 的超 300 行文件放行；无登记超 300 行仍拦截（正反两向验证输出）；无登记文件行为不变 |
| u20 | 组G2：popover 微包装合并 + split-justified 登记 + #1 popover 符号顺带 | R/components/panel/command-popover-delivery.ts；command-popover-file-candidates.ts；command-popover-open-fetch.ts；R/composables/panel/useForkNoticeStream.ts；R/composables/panel/composer-injection-store.ts；R/components/panel/CommandPopover.vue；直接消费方（DetailPane/GitPanel/MessageStream/TerminalView/SessionItem/composer-shell 中受 import 变更影响者）；CwdFileFetchStatus 定义文件 | u19 | plain | V10（门禁正反验证 + popover 全功能等价）；panel 相关既有测试绿（command-popover-landing/registry-merge/symbols-format-age） |

## 3 DAG 图

```mermaid
graph TD
  subgraph 波1（零行为变化）
    u01[u01 search死链]:::w1
    u02[u02 markdown/shell死链]:::w1
    u03[u03 #1a settings符号]:::w1
    u04[u04 #1b chat符号]:::w1
    u05[u05 #1c panel符号]:::w1
    u06[u06 #3+#4]:::w1
    u07[u07 #5+#6+#12]:::w1
    u08[u08 #9 bridge瘦身]:::w1
    u09[u09 #10 PanelLeaf跨包]:::w1
  end
  subgraph 波2（域改造）
    u10[u10 aggregate主改]:::w2
    u11[u11 usage迁移a]:::w2
    u12[u12 usage迁移b]:::w2
    u13[u13 D1 form退役]:::w2
    u14[u14 D2 table+依赖]:::w2
    u15[u15 E1 listSync合并]:::w2
    u16[u16 E2 fork收敛]:::w2
  end
  subgraph 波3（含行为/规则变更）
    u17[u17 F1 adapter接回]:::w3
    u18[u18 F2 IPC接缝B案]:::w3
    u19[u19 G1 门禁豁免]:::w3
    u20[u20 G2 popover合并]:::w3
  end
  u10 --> u11
  u10 --> u12
  u13 --> u14
  u19 --> u20
```

并行度：波 1 九单元全独立（分 3 批×3 滚动派发）；波 2 两条串行链 + 两独立单元（≤4 并发）；波 3 三独立 + 一依赖（≤4 并发）。

## 4 测试策略

- 增量（单元开发期）：`cd packages/renderer && pnpm vitest run <受影响测试路径>`；涉及 core/shared 的单元加跑对应包 vitest；`cd packages/renderer && pnpm typecheck`（vue-tsc --noEmit）为每单元硬门
- 全量（阶段 5）：`cd packages/renderer && pnpm test`；u09/u14 触及 shared/core/lock，加跑 `packages/core`、`packages/shared` 测试与 `pnpm install --frozen-lockfile` 校验；根 `pnpm run lint`
- 测试框架红线：vitest（禁 node:test），timer 用 fake timers；删除类单元不新增测试，改造类单元按三视角补/改断言
- 门禁验证（u19/u20）：临时样例文件正反两向跑 `python3 .githooks/vue_rules_checker.py`（或其 CLI 入口），验证输出后删除样例

## 5 合理偏差登记表

| # | 偏差 | 理由 | 状态 |
|---|------|------|------|
| D1 | 纯文件删除批次（rm + 引用核验，零行逻辑修改）允许 ≤10 文件/批 | 全局约束「每子任务 ≤5 文件」意图为防认知过载；纯删除无此风险 | 预登记 |
| D2 | #1 符号清单以执行时 grep 实际命中为准；发现真实引用的符号保留并登记 | 审计快照时点偏差（审计过程曾有 2 条断言被推翻的先例） | 预登记 |
| D3 | u15 合并后模块名/形态由 dev 按参数化最小面定（`useListSync(store, {tab, load})` 或收内联），允许偏离「单参数化模块」字面 | 两个变体仅 2 处，若内联更简则内联（Rule of Three 未达，不强留抽象） | 预登记 |
| D4 | u20 合并后文件若超 300 行，以 split-justified 登记放行 | 组 G 设计的组成部分（规则层豁免通道） | 预登记 |
| D5 | usage 域 u10（类型面）与 u11/u12（消费面）同批 commit——全包 typecheck 门禁要求类型与消费点同编译单元落地，独立 commit 必红；u15 已核验待 commit，排在 u10 域自洽后 | 单元独立 commit 让位于可编译性门禁；域内批 commit 不改变领地互斥与逐单元核验 | 2026-09-11 登记 |
| D6 | 阶段 3 审查确认的合理偏差（3 区报告聚合去重，共 20 条并入本表） | 见下方「阶段 3 合理偏差聚合」小节 | 2026-09-11 登记 |
| D7 | RenameSessionDialog 错误可见时机：新实现「输入即显示」vs 旧 vee-validate「blur/提交后显示」 | 校验判定结果四类边界逐条等价，仅反馈时机提前（清空输入框即刻提示）；补 blur 门需新增 touched 状态与测试改写，成本高于收益——设计 §4 裁决 6 | 2026-09-11 登记 |
| D8 | newMetrics 保留 export（#11 原计划去 export） | 4→5 个测试文件真实 import（含新建 UsageProjectRank.test.ts），符合 D2 精神；AggregatedData 已按计划去 export | 2026-09-11 登记 |

### 阶段 3 合理偏差聚合（3 区报告去重后）

**A. 删除类完整性（u01-u05，分区 1 R1-R7）**：领地内文件全部删净（u01 11 文件 -1985 行、u02 7 文件 -430 行）；候选 1 双轨消除实证（UnifiedCommand/isAppCommand/mapCommandsToItems 归一为 core 单份，`features/search/useSearch` 等路径全仓代码级零命中）；D2 偏差机制三次兑现且经审查方全量复验（IMPORT_* 四常量 / ROOT_PANEL_ID 19 个测试文件引用 / SubagentBucket 专测 / buildSkillCandidates 被 CommandPopover 消费）；25 个 un-export 符号采用「定义保留、仅去 keyword」最小 diff，全仓零外部 import；u02 局部优于设计（markdown.ts:284 注释比设计更可操作、useSidebar docblock 4 行信息量更足）；AppCommandActionsPort 观察项表述精确（限定词「core 内」准确，跨包消费仍活于 renderer useSearchModalDeps.ts:80 与 core/ui 测试）。

**B. 状态收敛等价性（u06/u08/u09/u15/u16，分区 2 R1-R5）**：u06 四态矩阵与存在性哨兵逐点等价、Array.isArray 删除有协议 SSOT 双重佐证（api domain 全形返回注释 + protocol.ts:1722）；u08 void 化唯一调用方恒丢弃返回值属实、保留 2 字段均有真实测试消费；u09 判别字段删除消费链完整（含测试零残留）、core api-port 零 diff 正确（opaque 返回类型）、panels 注释从假差异（PR #100 merge 兼容）改为真实消费方引用；u15 双 watch 逐点等价且裁决 5 双重成立（触发场景生产不可达——activeTab 不持久化恒 'sessions' 起步 + 假想可达时被 watch1 immediate 覆盖）；u16 ADR-0049 例外语义保住（文件头论证 + W24-EX-A 豁免 + ADR 登记表同步）、'waiting' 死分支/多播 Set/4 镜像桥删除全部 grep 确证、V7 4 用例走真实链路。红线复验：4 个关键测试文件 49/49 绿。

**C. 接缝与门禁（u17-u20，分区 4 R1-R8）**：u19 豁免通道正反 12 场景实测全过（含 501/520 拦截、空域/窗口外/非注释语境/跨行未闭合拦截、无标记 301 文案与基线逐字一致）；u18 接缝登记与 9 个新增转发函数签名 1:1（与 lib/ipc.ts:247-283 逐字对照）；V9 达成（useAppUpdate 10 IPC 函数全经本层，@/lib/ipc 零残留）；#2 挪移只改暴露面不改运行时路径；u20 五个合并点逐字对照等价、五语义域红线未碰（command-popover 三文件改动系 u04 授权的 export 收窄）、D4 判断正确（script 267 行 ≤300）；u17 缺失被计划层如实登记（非静默丢失）。

**D. 补充登记（分区 1 U2 / 分区 4 U2）**：u04 实改 8 文件超 5 文件预算（11 符号分布 8 个定义文件、每处 1 行 export 改动，未切批）；u18 实改 5 个测试文件超预估 4（机械 mock 目标迁移）。两条均低风险、无行为影响，按 D2 精神补录本表。

**E. usage/表单域（u10-u14，分区 3 R1-R6）**：u10 颜色归属机制完整落地（模块级可变 PROVIDER_COLORS 删除、buildProviderColors 纯函数、getProviderColor 双参纯化、aggregate 无隐藏副作用——V4「双实例互相覆盖」结构性不可能）；消费方迁移完整（全仓 getProviderColor 仅 5 个真实消费组件、全部经 UsagePage 传 prop）；V4 有组件级 DOM 断言（9 文件 74 tests 实跑绿）；u13 校验规则与旧 zod schema 逐条等价（min1/max60/换行）、旧「schema 副本双轨测试」升级为挂载组件 DOM 断言（漂移面消除）；u14 三类删除零消费方（ui/table 与 popover 副本 grep 零命中、活版本在 packages/ui 未触碰）；lock 自洽（importer 40 键双向一致，zod 转 optional peer 非孤儿）。

### 阶段 3 unreasonable 修复清单（待配额恢复后派发）

| 组 | 条目 | 领地 | 严重度 |
|----|------|------|--------|
| 修-1 | 悬空注释 3 处：useAppCommands.ts:5（指向已删 renderer useCommandRegistry/useSearchJump）、api/index.ts:60-61（指向已删 renderer useSearch）、useFileSearchStore.ts:6（同上）——补 core 包归属或改写指向现执行者 | R/composables/features/command/useAppCommands.ts；R/api/index.ts；R/composables/features/search/useFileSearchStore.ts | Low |
| 修-2 | u15 V6-a 测试守卫盲区：测试注释自认 activeTab 非目标 tab 时「即使 tab watch 带 immediate 也不命中」——补一条 tab 已激活场景的「恰一次」断言钉死裁决 5 的核心场景 | R/__tests__/composables/useListSync.test.ts | Low |
| 修-3 | u06 useAccordionGuard 改造类无测试化证据（「6 场景等价」仅存 commit message）——补最小行为断言（4 态矩阵 + dirty 守卫开合） | R/composables/features/settings/useAccordionGuard.ts 或其新测试文件 | Low |
| 记-1 | u16 commit message 行数误差（490→388 实为 489→390）、u06 message 引 protocol.ts:1720 实为 :1722 | 已 commit，不做历史改写；本条登记为已知不精确 | Info |
| 记-2 | 存量残留（非本批引入）：useAppUpdate.pending.test.ts:59 mock 工厂无效键 performUpdate + 缺 getLaunchResult；UpdateCheckCard.vue:236 直取 @/lib/ipc（不在设计 10 函数清单内） | 留待后续触碰时清理 | Info |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|---------|
| u01 | committed | 1 | 987697d34（双包 typecheck 绿 + core 261 tests；2 项偏差见变更历史） |
| u02 | committed | 1 | f3fd77063（typecheck 绿 + markdown/shell 77 tests） |
| u03 | committed | 1 | e790ceac0（typecheck 绿 + 8 suites 78 tests；IMPORT_* 4 符号有活引用跳过=D2，ImportState 转批 b） |
| u04 | committed | 1 | d1ed46251（局部 suites 76 tests 绿；实改 8 文件超 5 文件预算——执行时 11 符号分布于 8 个定义文件、每处 1 行 export 改动，未切批，§5 补录；buildSkillCandidates 有真实引用保留=CommandPopover.vue:155,360 按 D2 跳过） |
| u05 | committed | 1 | f4ad994d7（typecheck:test 绿 + 8 suites 39 tests；ROOT_PANEL_ID/SubagentBucket 有测试引用跳过=D2） |
| u06 | committed | 2 | e65f893e8（两阶段验证 18/18；#3 undefined 哨兵偏差、#4 协议对齐循环打破） |
| u07 | committed | 1 | d5f35c82a（rename 检测 91%；typecheck 绿 + panel/shell 633 tests） |
| u08 | committed | 2 | 874f89068（void 化 + __testing 2 字段快照；18/18 tests） |
| u09 | committed | 2 | 2e7bccd4e（独占 4 文件；shared 335 + core session 68 tests；交叠文件随 u15 落地） |
| u10 | committed | 2 | 74b31c928（D5 同批：usage 域 11 文件；typecheck 0 error + 67 tests） |
| u11 | committed | 1 | 74b31c928（同上） |
| u12 | committed | 1 | 74b31c928（同上；新建 UsageProjectRank.test.ts 2 用例已登记） |
| u13 | committed | 1 | 57945a4ff（form 7 文件整删 + 直连改写 7 tests 绿；a11y 正向修正 3 处） |
| u14 | committed | 1 | 53f875e5c（table 7 文件 + popover 2 副本 + index re-export 同步 + 3 依赖删除；build 级 V5 验证 + sidebar 181 tests；lock 聚焦 2+/34-） |
| u15 | committed | 1 | 39e3a212f（16 文件含与 u09 交叠 4 测试文件全量；9 用例参数化 + V6 断言） |
| u16 | committed | 2 | 8824c7076（489→390 行（见 §5 记-1 更正，`wc -l` 复核 134+256）、概念数 -5；V7 真实链路 4 tests + 12 套件 118 tests；data-owner 拦截按 feedMap W24-EX-A 前例补豁免后过闸） |
| u17 | committed | 1 | 209bd3808（adapter import 源切至 @/api 门面三元 + V8 自动化断言 stubEnv/防回退 spy + core mock 补 listModels 追认领地外；hooks 环境错位修复后落地） |
| u19 | committed | 1 | 32211e76e（7 场景正反验证 + 3 文件回归 diff 空；500 上限纠偏已登记） |
| u18 | committed | 2 | 830048962（settings.ts 接缝登记 + 10 个 IPC fn 统一回本层 + restore* 挪 __testing；67+153 tests 绿；9 个 update 家族 fn 按设计「统一回本层」并入转发层=settings 域豁免条款，5 测试文件超预估 4 未登记——阶段 3 补录） |
| u20 | committed | 1 | 22bb84649（5 合并点落地、3 文件+1 直测删除；panel 625/625 绿 + typecheck 0；D4 未触发 script 267 行） |

## 7 残留风险与变更历史

- mock 接回（u17）的行为验证无自动化 e2e 覆盖，V8 依赖代码审阅 + 手测——若 dev 无法本地验证 mock 构建，上报主 agent 决定是否降级为「登记偏差」
- u16 fork 收敛涉及 FR-19 功能面，回归靠既有测试 + V7 手测；若收敛中发现 ADR-0049 例外注释与单例化冲突，停手上报
- u20 合并行数与门禁的交互需实测；若豁免通道粒度不够（如正则误伤），回 u19 修规则本体
- 变更历史：
  - 2026-09-11 计划建立（裁决 1-5 见设计文档 §4）
  - 2026-09-11 阶段 3 一致性审查第 1 轮：4 分区派出，分区 1/2/4 完成（分区 3 两度因限流/配额中断，待重派）。结论：3 区无阻塞项；doc_errors 4 条已由主 agent 修订（审计 IMPORT_* 断言、设计裁决 2 的 9 文件注记、impl-plan u03 常量数、impl-plan u04 状态行）；reasonable 20 条已聚合登记（§5 D6）；unreasonable 5 条列修复清单（3 条需编码：悬空注释 3 处、V6-a 断言补强、u06 accordion 测试化；2 条 Info 登记）。
  - 2026-09-11 环境阻塞①（hooks 错位）：共享 `.bare/hooks/pre-commit` 于 14:50 被 `feat-optimize-extensions-over-engineering` worktree 用其 install-hooks.sh（14:49 版，含 C-pi-14 数据布局字面量守卫段）覆盖安装。本分支 hooks 源（12:35 版）无该段，且守卫交付物 `scripts/check-layout-literals.mjs` 与 208 处存量清理均在 dev-0.9.17 分支（e7740ca39）而非本分支——守卫在本分支必红且全为基线存量（非本次改动引入）。u17 commit 因此被拦（其余 19 单元已在 hooks 更新前落地）。处置待裁决：A 本分支重装自有 hooks（覆盖共享、其他 worktree 失去该段直到再装）；B 从 dev-0.9.17 搬入守卫交付物（范围大幅越界）；C 其他。
  - 2026-09-11 环境阻塞②（配额）：账户 5h 限额耗尽（1308，2026-09-11 17:40:40 重置），subagent 派发不可用。修复清单（修-1/2/3）、分区 3 审查、阶段 5 验收、阶段 6 同步均排队待恢复。主 agent 已在此期间完成全部非编码项（doc_errors 修订、偏差登记、状态表校准）。
  - 2026-09-11 核验漏洞登记（自纠）：u07 实际改动含 `packages/core/src/domain/chat/use-chat-types.ts`（清理点 #12 的 CompactQueueLike 契约对端注释，属 u07 task 授权的「core 侧注释（若互指需要）」），但该文件未列入其 files_changed 汇报；主 agent 核验时 grep 过滤过窄（仅匹配 MessageStream 相关文件名）未捕获，commit d5f35c82a 因此遗漏该文件——改动仍完好留在工作区，待补 commit。教训：属地 diff 核验必须用 `git status --short` 全量集合比对 files_changed，禁止 grep 过滤后比对。
  - 2026-09-11 当前工作区未提交改动盘存（2 组，均被环境阻塞①拦截）：① u17 三文件（adapter + 新测试 + core mock 补 listModels）；② u07 补漏一文件（use-chat-types.ts 注释）。
  - 2026-09-11 u17 状态：dev 已完成并核验通过（renderer typecheck 0 + 21 tests + core mock 105 tests），含 1 处追认的领地外改动（core mock model 域补 listModels——被 adapter 原直连 real WS 掩盖的缺口）；改动在工作区待 commit（被环境阻塞①拦截）。
  - 2026-09-11 阶段 3 分区 3（usage/表单域）完成：reasonable 6 条（已并入 §5 D6-E 段）；unreasonable 2 条（U1 Medium=错误可见时机→主 agent 裁决为合理偏差 D7 + 测试注释校准修-4；U2 Low=CollapsibleTrigger.vue:12 悬空注释→修-4）；doc_errors 5 条（D1-D4 已由主 agent 修订设计/审计/计划三处文档：newMetrics 保留、form 6→7 文件、usage 8→5 组件、行数 260→320；D5 Info 级=u14 commit message 测试数不可复现，登记为后续 commit 证据须写可复现命令）。
  - 2026-09-11 阶段 4 修复批次执行：修-1（悬空注释 3 处，6f59a0587）、修-2（V6-a2 断言 + 回归敏感性验证，1ae64409c）、修-3（accordion 14 用例 + 反向验证，69eb21b05）、修-4（测试标题校准 + CollapsibleTrigger 注释，6d5377011）。全部带证据核验后提交。
  - 2026-09-11 阶段 3+4 清零判定：unreasonable 全修（修-1~4 落地）；doc_errors 9 条全改（4 条第 1 轮 fcececdeb 前的 dfac124c9 + 5 条第 2 轮 fcececdeb）；reasonable 26 条全登记（§5 D6 聚合 A-E 段）；Info 级 2 条（commit message 不精确 / 存量残留）登记为已知，不阻塞。进入阶段 5。
  - 2026-09-11 环境修复（用户授权）：hooks 根治为 per-worktree 独立（bd521c203）+ ~/.shell/07-git-ws.sh 的 git-cwt/git-ws-add 修复；22 个 worktree 全部迁移；隔离性实测通过。
  - 2026-09-11 阶段 5 Gate A（整体测试验收）：**全绿**。13 条命令 exit 0——renderer 380 文件/4107 用例（3 skipped 基线既有）、core 120/1951、shared 28/335、electron main 52/918（u09 触及故额外纳入）；renderer/core/shared typecheck ×5 + eslint --max-warnings 0 全 0；install --frozen-lockfile 自洽；覆盖率 83/72/81/85（阈值 66/56/60/68）；doc-symbol-drift 绿。零容忍扫描：区间内无新增 SKIP_*/it.skip/todo/eslint-disable/.only/--no-verify。
  - 2026-09-11 阶段 5 Gate B（端到端验收）：**8 pass / 0 fail / 3 blocked**。pass=V4（色阶逐字未变 + 84 tests 精确色值断言）、V5（build exit 0 + dist 零 vee-validate + 7 tests）、V6（11 tests 含 V6-a2）、V7（4 tests 真实链路）、V8（stubEnv mock 断言 + 反回退 spy）、V9（IPC 全经接缝层，绕过零命中）、V10（门禁正反真实 CLI 实测：310 拦截/带标记放行+INFO/520 拦截/299 放行）、V11（renderer 4107 全量 + 28 符号 grep 扫描）。blocked=V1/V2/V3 的**应用内真实交互**部分——根因：唯一 dev 实例属 fix-subagent-no-notification worktree（Vite root 已证），1420/9222 被 strictPort 占用，本 worktree 起不了第二实例；静态与包级替代证据已全通（core search 37 tests + ui 668 tests + 已删文件零残留 + ui 包零改动）。
  - 2026-09-11 Gate B 残余风险（未闭环项，交付时如实呈报）：① V1/V2/V3 GUI 交互未执行（恢复条件：释放 1420/9222 后本 worktree 跑 pnpm dev 手测）；② V8 mock 模式无构建级 e2e（仅单测级，设计 §7 已登记）；③ V9 广义目标未竟——另有 4 个 settings 组件直取 @/lib/ipc（UpdateCheckCard/ExtensionPage/SettingsResourcePage/SystemSoundSection），不在设计枚举的 10 函数清单内（记-2 Info 登记）；④ split-justified 豁免通道零生产使用（仅 /tmp 样例验证，CommandPopover 267 行未触发 D4）；⑤ 存量测试瑕疵（performUpdate 无效键等，非本批引入）；⑥ TEST-STRATEGY.md:138-139 与 docs/testing/06-search-modal.md:125,128,129 的回归基线仍指向 u01 已删测试文件——留阶段 6 同步修订。
  - 2026-09-11 u01 完成：① 偏差登记——useCommandRegistry.test.ts 超领地整删（计划快照遗漏该死代码自测文件，:15 import 被删文件必挂，与已列 3 个配套测试同构，接受）；section-kind.test.ts 整删（任务预留分支，core search.test.ts 有等价覆盖）。② 观察项登记——core AppCommandActionsPort（search-ports.ts）随 app-commands 删除后在 core 内零消费方，属 #1 收窄语义域，待后续批次/阶段 3 裁决。③ u03 观察项兑现——IMPORT_* 四常量有真实引用（ImportSessionDialog + 2 测试文件），审计「三常量零引用」与实况不符，D2 偏差按预期兜住
  - 2026-09-11 阶段 6 终态一致性校准第 1 轮（design-code-sync，全 code-right）：设计文档 §2 对 §4 的交叉引用编号错位修正 3 处——§2.1 core 收口 1→4（A1）、§2.5 immediate 2→5（A2）、§2.6 候选 7 4→2（A3）；连带修正 impl-plan 同因引用 2 处——u18「裁决4-B」→「裁决2-B」、变更历史「设计裁决 4 的 9 文件注记」→「裁决 2」。设计文档另修 5 处：§2.2 补注清理点 #3 落地形态偏离审计字面（`string|null` → 存在性哨兵 `string|null|undefined`，A4）；§2.5 fork 收敛补注实际行数 134+256=390（A10，`wc -l` 复核）；§2.6 候选 4 豁免依据由不可复现的「5 个测试文件」改为可复现枚举（renderer 4 + core 3，useSettingsShell.test.ts 走 vi.mock，A8，`grep -rn provideSettingsTransport` 复核）；§2.7 五模块不动改为「五语义域结构不动（export 收窄见 §2.2 #1）」（A11）；§3 V2 判据由「无对已删文件的引用」收正为「无悬空 import」（A9）。impl-plan 另修：u09 领地路径 `composables/panel/useMessageEffects.ts` → `composables/effects/useMessageEffects.ts`（A5，`find` 复核）；§0 待验证检查点「1-5」→「1-6（6 为阶段 3 补录）」（A6）；§6 u16 行「490→388」→「489→390」（A7）。代码注释悬空符号修正 5 处（renderer 删除引发的连带失效，仅注释零逻辑改动）：useSideDrawer.ts 兼容层消费清单移除已删 `useMarkdownInteractions` 3 处（D1，含测试清单条目；`useCodeblockCopy`/`useToolMeta` 经 grep 确认本不在清单）；markdown-renderer.test.ts 头注释改为「原在 useMarkdownInteractions，已于 2026-09-11 随死代码删除」（D2）；core coordination.ts `browserUrl` docblock 改写为「由 `openDrawerTab(opts.url)` 写入，原设置方已删除、当前无调用方」（D3，grep 复核 renderer 无 url 写入方）；packages/ui AmbiguousFilePopover.vue 改指同包 MarkdownRenderer.vue onClick ③（D4）；command-popover-skill-candidates.ts 删已删文件名、改指 symbols.ts + CommandPopover.vue 内联 file 分支（D5）。验证：11 条 finding 全部有改动，无静默跳过，改动明细见 git status。
