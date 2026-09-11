# renderer 过度设计审计修复 实施计划

基线: <待回填> | 来源设计: docs/design/renderer-over-engineering-remediation.md | 日期: 2026-09-11
审计证据: docs/design/renderer-over-engineering-audit-20260911.md

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1 背景/目标（含 Out-of-scope） |
| 终态/机制 | §2 终态/机制（2.1-2.7 按组） |
| 验收场景表 | §3 验收场景表（V1-V11） |
| 下一层拆分 | §2 各小节 → 本文 §2 单元列表（u01-u20） |
| 待验证检查点 | §4 裁决记录 1-5；§3 V8（mock 接回行为验证） |

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
| u03 | 清理点#1 批次a：settings/oauth/import/toast 域零引用导出收窄 | ToastOptions、SPINNER_STATUSES、NEUTRAL_ENGINE_ICON、ProviderOAuth* 四类型、AuthedModelOption、ImportState、IMPORT_* 三常量的定义文件（执行时 grep 定位，预计 ≤5 文件） | 无 | plain | typecheck 绿（含 typecheck:test）；每符号 grep 生产引用 0 |
| u04 | 清理点#1 批次b：chat/stream 域零引用导出收窄 | TraceJumpResult、AttachedContextItem、NEW_SUBAGENT_ITEM_ID、SymbolCandidate、SlashCandidateInput、SkillCandidate*、SlashCommandSource、LineStats、LoadStatus、MAX_ENTRIES 定义文件（≤5 文件，超则上报切批） | 无 | plain | 同 u03 |
| u05 | 清理点#1 批次c：panel 域零引用导出收窄 | DetailPaneState、PreviewStatus、ROOT_PANEL_ID、SubagentBucket、EmptyResultStrikeGuard、PartitionedRecords、ResolvePreviewPathResult、DetectedPlatform 定义文件（≤5 文件） | 无 | plain | 同 u03 |
| u06 | 清理点#3+#4：useAccordionGuard 三态收敛 + useBackgroundTasks 删防御分支 | R/composables/features/settings/useAccordionGuard.ts；R/composables/features/sidebar/useBackgroundTasks.ts | 无 | plain | 既有测试绿；typecheck 绿 |
| u07 | 清理点#5+#6+#12：useMessageStreamNotices 空壳改名 + useGlobalShortcuts 悬空注释 + useCompactQueue 双契约注释 | R/composables/panel/useMessageStreamNotices.ts（改名）；R/components/panel/MessageStream.vue、message-stream/ActivityStrip.vue（import 同步）；R/composables/shell/useGlobalShortcuts.ts（:31 注释）；R/composables/panel/useCompactQueue.ts（注释） | 无 | plain | typecheck 绿；grep 旧名零残留 |
| u08 | 清理点#9：useExtensionHostBridge 返回对象瘦身 + `__*ForTest` 后门归整 | R/composables/shell/useExtensionHostBridge.ts（:283-293）；关联测试文件（grep `ForTest` 定位，≤2 文件） | 无 | plain | 既有测试绿；生产调用方无需改动（grep main.ts/App.vue 核对） |
| u09 | 清理点#10：PanelLeaf 单成员判别字段与 panels merge 兼容残迹清理（跨包） | packages/shared/src/panel.ts；R/stores/panel.ts；packages/core/src/domain/session/api-port.ts；R/composables/panel/useMessageEffects.ts（:80 消费方同步） | 无 | plain | renderer+core+shared typecheck 绿；runtime 相关测试不受影响（shared 改动跑 shared 测试） |
| u10 | 组C：aggregate.ts PROVIDER_COLORS 并入 AggregatedData + #11 去 export | R/components/settings/usage/aggregate.ts | 无 | plain | typecheck 绿；颜色映射数据随返回值可取（测试或类型证明） |
| u11 | 组C：usage 消费组件取色迁移 批次1 | R/components/settings/usage/UsagePage.vue、UsageLedger.vue、UsageDetailTable.vue、UsageCacheMix.vue | u10 | plain | typecheck 绿；V4（配色与改前一致） |
| u12 | 组C：usage 消费组件取色迁移 批次2 | R/components/settings/usage/UsageDailyChart.vue、UsageHeatCalendar.vue、UsageModelRank.vue、UsageProjectRank.vue | u10 | plain | 同 u11 |
| u13 | 组D1：RenameSessionDialog 直连改写 + 删 ui/form 整目录 | R/components/sidebar/RenameSessionDialog.vue；R/components/ui/form/（6 文件整目录） | 无 | plain | V5 校验行为等价（空/超60/换行拒绝、合法成功）；grep vee-validate 在 renderer 内零 import |
| u14 | 组D2：删 ui/table + popover 旧副本 + package.json 依赖清理 | R/components/ui/table/（7 文件整目录）；R/components/ui/popover/PopoverListItem.vue、PopoverActionItem.vue；packages/renderer/package.json；pnpm-lock.yaml | u13 | plain | build 成功且产物无 vee-validate；grep 零残留引用 |
| u15 | 组E1：listSync 孪生合并（裁决5：删 workflow 版冗余 immediate 后归一） | R/composables/features/chat/useSubagentListSync.ts、useWorkflowListSync.ts（合并为单参数化模块）；R/components/sidebar/Sidebar.vue（:281-282 调用点）；R/__tests__/composables/useSubagentListSync.test.ts | 无 | plain | V6（挂载首拉一次、切 tab 首拉一次）；测试绿（断言 immediate 行为对齐后形态） |
| u16 | 组E2：fork 通知链路收敛（模块级单例 + 删镜像层/多播 Set/'waiting' 死分支）+ #1 fork 域符号顺带收窄 | R/composables/features/fork-handoff/useForkBranchNotify.ts；R/composables/effects/useForkNoticeEffect.ts；useForkBranchBadges 及直接消费方（执行时定位，≤3 文件）；#1 fork 符号（ApplyDeltaFn、FinalizeStreamFn、SetMessagesFn、BackgroundTask*）定义文件 | 无 | plain | V7（角标产生/清除等价）；fork 相关既有测试绿 |
| u17 | 组F1：settings-transport-adapter 接回 @/api 门面三元 + 坍缩（裁决3） | R/composables/shell/settings-transport-adapter.ts；R/composables/shell/useSettingsShell.ts（:63 注入点）；R/composables/shell/__tests__/useSettingsShell.test.ts；R/__tests__/settings/settings-modal-smoke.test.ts；grep `SettingsTransport` 命中的其余测试（≤2 文件） | 无 | plain | V8（mock 模式 settings 走 mock）；real 模式功能等价；settings 相关测试绿 |
| u18 | 组F2：api/domains/settings.ts 登记测试接缝（裁决4-B）+ useAppUpdate 路径统一 + #2 restore* 挪移 | R/api/domains/settings.ts（文件头）；R/composables/features/settings/useAppUpdate.ts（import 路径 + :787-788）；useAppUpdate*.test.ts 中 mock 目标同步（grep 定位，≤4 文件） | 无 | plain | V9（IPC import 全经 api/domains/settings）；useAppUpdate 全部测试绿 |
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

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|---------|
| u01-u20 | pending | 0 | — |

## 7 残留风险与变更历史

- mock 接回（u17）的行为验证无自动化 e2e 覆盖，V8 依赖代码审阅 + 手测——若 dev 无法本地验证 mock 构建，上报主 agent 决定是否降级为「登记偏差」
- u16 fork 收敛涉及 FR-19 功能面，回归靠既有测试 + V7 手测；若收敛中发现 ADR-0049 例外注释与单例化冲突，停手上报
- u20 合并行数与门禁的交互需实测；若豁免通道粒度不够（如正则误伤），回 u19 修规则本体
- 变更历史：
  - 2026-09-11 计划建立（裁决 1-5 见设计文档 §4）
