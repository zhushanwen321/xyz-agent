# over-engineering-audit：xyz-agent / packages/renderer 2026-09-11

范围：`packages/renderer` 非测试代码（778 文件生产+测试 / 约 5.2 万行生产；packages/core、packages/ui 本轮未覆盖，建议下轮增量）｜证据等级：完整（第一层可计算信号全跑 + 第二层 6 分区 subagent 语义四问 + 第三层业务文档映射；11 条关键断言主 agent 实读抽验实锤、2 条推翻复核）｜步骤 0 豁免汇总：0 条（renderer 内无 `oe-exempt:` 标记），无既有基线。

**审计方法说明**：主审对象为 renderer 包本体。第一层扫描 624 个导出符号的引用计数；第二层 6 个分区 subagent 逐字核对 Parnas/Ousterhout/YAGNI 四问 + 反模式清单；第三层以 `docs/architecture/renderer-rebuild-architecture.md`（现行 SSOT）为业务证据源——该文档确认「逐域绞杀」迁移进行中（P3-P6 未走完），renderer 包内新旧共存属有意中间态，本报告已据此豁免 strangler 过渡类结构（如 useSideDrawer 兼容层、stores/chat.ts 注册壳）。

---

# 候选 1（高杠杆）｜search 域迁移残留死代码链（约 621 行）

- 位置：`composables/features/search/useSearch.ts`(323) + `useSearchJump.ts`(178) + `new-task/useRecents.ts`(80) + `command/useCommandRegistry.ts`(40)；反向残留 `packages/core/src/domain/new-task-search/app-commands.ts:38`（registerAppCommands 全仓 0 调用方）
- 复杂度来源：搜索域已迁 core/ui（SSOT = `packages/core` 的 useSearch/useSearchJump，真实消费方 `packages/ui/src/overlays/SearchModal.vue:159` 从 `@xyz-agent/core` import），renderer 侧旧实现未随迁移删除。core `search.ts:5` 注释自证「迁自 renderer composables/features/useSearch.ts(313 行)，语义逐条等价」；renderer useCommandRegistry.ts 与 core command-registry.ts 逐行同构（仅变量名差异）。
- 简化方案：删除 renderer 侧 4 个死文件及配套测试（useSearchJump.test.ts / useRecents.test.ts / section-kind.test.ts 中的引用）；core app-commands 与 renderer useAppCommands 二选一收口。
- 功能取舍：0 个调用方/场景受影响——生产引用为零（含测试也仅是死代码自身的测试）。
- 核心价值影响：搜索功能本体在 core/ui 活跃且健康，删除的是同域双轨的旧半边。
- 三段论证：小取舍=牺牲「renderer 内还有一份搜索编排」的错觉（无人需要）｜大简化=删 4 文件 621 行 + 1 个 core 死导出，消除「哪份是 SSOT」的双轨辨析成本（UnifiedCommand/isAppCommand/mapCommandsToItems 符号双份）｜核心无损锚=调用方证据（git grep 全仓生产引用 0，主 agent 已实读复核）
- 推荐强度：Strong
- 评分：投机 3｜热度 1｜收益代价差 3

# 候选 2（高杠杆）｜markdown 交互死代码链 + 误导注释（约 284 行）

- 位置：`composables/panel/useMarkdownInteractions.ts`(165) + `useCodeblockCopy.ts`(52) + `useToolMeta.ts`(67)；误导注释 `composables/logic/markdown.ts:284`
- 复杂度来源：W4/T7 迁移把 MarkdownRenderer 移入 ui 包并在包内原生重实现了同款交互（`packages/ui/src/features/chat/MarkdownRenderer.vue:144-190`），renderer 侧旧实现未清场。useToolMeta 连测试都没有；useMarkdownInteractions 内还嵌投机字段（`MetaItem.tone` 自注「保留枚举字段以备后续状态色扩展」——为 0 个变体预留）。
- 简化方案：删 3 文件 + `useMarkdownInteractions-fallback.test.ts` + 修正 markdown.ts:284 注释（实际点击处理在 ui 包内）。
- 功能取舍：0 调用方受影响。
- 核心价值影响：markdown 渲染/复制/文件路径点击在 ui 包全部正常工作。
- 三段论证：小取舍=无（纯清场）｜大简化=删 3 文件 284 行 + 1 个测试 + 修正 1 处会引后来者修错文件的活注释｜核心无损锚=调用方证据（git grep 全仓生产引用 0，5 处命中全为注释；主 agent 已实读复核）
- 推荐强度：Strong
- 评分：投机 3｜热度 1｜收益代价差 2

# 候选 3（高杠杆）｜≤300 行门禁驱动的单消费者碎片拆分（规则层根因 + 4 个 pass-through 微包装）

- 位置：根因 `.githooks/vue_rules_checker.py:48`（`MAX_SCRIPT_LINES = 300`）；碎片样本：`command-popover-delivery.ts`(25)、`command-popover-file-candidates.ts`(28)、`command-popover-open-fetch.ts` 内 `useCommandPopoverCwdFileView`(:144-192)、`useForkNoticeStream.ts`(55，一行派生+两个一行转发)、`composer-injection-store.ts:22-24`（3 行兼容函数，函数/const 双形态 3+4 文件并存）。证据注释遍布：`MessageStream.vue:239,287,370,380`、`command-popover-symbols.ts:123,208,230` 等十余处自述「≤300 行规范拆分」。
- 复杂度来源：行数门禁（形状度量）驱动机械拆分（非语义域驱动），每个拆缝留缝合注释——注释量即拆分成本的账单；同域数据获取被切成 panel/landing/推路三文件互相引用注释对齐。
- 简化方案：两步。① 代码层：delivery 并回 useCommandSync（同「命令投递」域）、file-candidates 内联回 CommandPopover.vue 或并入 open-fetch 的 file 分支、CwdFileView 并入 open-fetch 删回调缝、composer-injection-store 统一为 const 形态。② 规则层：给 vue_rules_checker 增加「单消费者同域拆分」豁免通道（如文件头 `<!-- split-justified: <语义域> -->` 登记），否则合并后会被门禁再次弹回。
- 功能取舍：无行为变化（全部是行为不变的合并）；规则层豁免需要团队对「行数门禁的例外管理方式」达成一致。
- 核心价值影响：keyboard/symbols/skill-candidates/source/trigger 五个语义域清晰或有测试锁定回归史的模块全部保留，不动本质复杂度。
- 三段论证：小取舍=门禁豁免通道引入少量「拆分理由」登记成本｜大简化=合并 4-5 个微包装、消除「一个 popover 心智模型跨 7 文件拼图」的跳转税，panel 是全仓最高频变更区（MessageStream 近 30 天 27 commits），收益持续兑现｜核心无损锚=调用方证据（每个微包装删除后调用方直调目标行为不变，两个独立 subagent 交叉验证一致 + 主 agent 实读 useForkNoticeStream/composer-injection-store 复核）
- 推荐强度：Worth exploring（代码层 Strong；规则层需用户裁决豁免机制形态）
- 评分：投机 2｜热度 3｜收益代价差 2

# 候选 4｜settings-transport-adapter 纯转发层 + mock 开关旁路双轨

- 位置：`composables/shell/settings-transport-adapter.ts:21-59`（59 行 19 方法，17 个纯 lambda 转发 + 1 个 await-return 噪音）；注入点 `useSettingsShell.ts:63`
- 复杂度来源：adapter 直 import `core/transport/api/domains/{config,model,extension}`，绕过 `@/api` 门面的 `VITE_MOCK` 三元切换（`api/index.ts` 头注释确认门面 real 侧聚合的就是同一批 core transport 模块）——mock 模式下 settings 域 19 方法全部打真实 WS，与全应用其它域 mock 行为背离（leaky）。注释自述「P1 transport 迁移完成后换 core/transport 直连」的过渡未发生。
- 简化方案：接口缝（core `SettingsTransport` + provide）保留——5 个测试文件真实注入，这是豁免；adapter 坍缩：内联对象字面量进 useSettingsShell 或由 core 直连 + discoverModels 的 8 行 guard 移入域内；mock 旁路要么接入门面三元要么注释登记为已知偏差。
- 功能取舍：测试 stub 构造方式变化（settings-modal-smoke 等测试的 stubTransport 需同步改）；mock 模式下 settings 域行为二选一（修 = 走 mock；不修 = 登记）。
- 核心价值影响：core 零 renderer import 铁律不受影响（接口缝才是铁律的承载）。
- 三段论证：小取舍=5 个测试文件的 stub 目标调整｜大简化=删 59 行转发层、SettingsTransport 实现路径从「门面+adapter」两条归一、消除「必须同时知道 @/api 有 mock 开关而 settings 不走它」的隐藏知识｜核心无损锚=替代路径（接口缝保留，测试注入能力不变）
- 推荐强度：Worth exploring（mock 旁路修/登记需裁决）
- 评分：投机 2｜热度 2｜收益代价差 2

# 候选 5｜ui/table 整目录 + ui/form 全套 + vee-validate 双运行时依赖

- 位置：`components/ui/table/`（7 文件约 107 行，全仓零引用含测试）；`components/ui/form/`（6 文件约 103 行，唯一消费方 `RenameSessionDialog.vue:53-59` 校验一个字段）；`package.json:19,43,47`（@vee-validate/zod + vee-validate + zod 三个依赖）
- 复杂度来源：table 是「未来会有表格需求」的预留（用量明细表等实际全部手写布局）；form 是为单字段（label: min1/max60/无换行）引入 vee-validate + 四层上下文链（Field slotProps → componentField → FormControl → useFormField inject），而全仓其他表单全部手写校验（UpdatePage、SystemLlmRetrySection、ImportSessionDialog）——赌注被现有代码惯例反向证伪。
- 简化方案：删 ui/table 整目录；删 ui/form 整目录 + vee-validate/@vee-validate/zod 依赖（renderer 内 zod 仅 RenameSessionDialog 一处 import），RenameSessionDialog 改直连 Input + 3 行内联校验。顺带删 `ui/popover/PopoverListItem.vue` + `PopoverActionItem.vue`（零消费陈旧副本，活版本在 ui 包且已出现 import 路径漂移）。
- 功能取舍：RenameSessionDialog 校验逻辑重写（约 10 行，行为等价）；失去「未来表格/表单库」的预留（从未兑现）。
- 核心价值影响：重命名会话对话框行为不变；包体积与供应链面下降。
- 三段论证：小取舍=一个对话框改写内联校验｜大简化=删 15 文件约 260 行 + 3 个 npm 依赖（概念数：删掉「vee-validate slot 约定」「form 上下文链」「table 原语」三套读者本无需理解的概念）｜核心无损锚=调用方证据（table/popover 副本 0 调用；form 全仓惯例已是手写校验）
- 推荐强度：Worth exploring
- 评分：投机 3｜热度 1｜收益代价差 2

# 候选 6｜fork 通知链路：镜像双轨状态 + 不可达分支 + 单回调多播注册表

- 位置：`composables/features/fork-handoff/useForkBranchNotify.ts`(204) + `composables/effects/useForkNoticeEffect.ts`(286)；镜像点 useForkNoticeEffect.ts:243-244,248,285
- 复杂度来源：① 实例返回的 trackedBranches/unreadByBranch 被两个 watch 逐值拷进模块级 ref——同一份状态物理两处 + 三层间接（实例 → 模块 ref → useForkBranchBadges 再包装）；② `classifyChange` 的 'waiting' 分支自注「保留扩展点」，但 `SessionStatus` 联合类型（`packages/shared/src/session.ts:18`）无 'waiting'——分支永不可达（主 agent 实读类型定义复核）；③ onBranchStatusChange 是 Set 多播注册表，全仓恰 1 个调用方注册 1 个回调；④ trackedBranches 三处导出零 UI 消费。
- 简化方案：feed/追踪态直接做模块级单例（同文件 feedMap 已是此范式，ADR-0049 例外注释已论证），删实例化+镜像层与多播 Set，删 'waiting' 死分支；预计 490 行缩约三分之一，概念数 -3（镜像层/多播协议/waiting 状态）。
- 功能取舍：无行为变化（侧栏角标/反馈行功能本体保留）；唯一注意：合并时需裁决 subagent/workflow 孪生 watch 的 `{ immediate: true }` 漂移是否有意（见代码级清理点 #8）。
- 核心价值影响：FR-19 后台分支角标功能多消费方（App.vue/ForkGroup.vue/MessageStream/useForkActions）全部保留。
- 三段论证：小取舍=无行为变更，仅结构收敛｜大简化=删 3 个概念 + 约 160 行，读「一个侧栏角标」从穿 3 文件降为 1 文件｜核心无损锚=调用方证据（唯一实例化方/唯一注册方/零 UI 消费的导出均实证；功能多消费方不受影响）
- 推荐强度：Worth exploring
- 评分：投机 2｜热度 1｜收益代价差 2

# 候选 7｜api/domains/settings.ts 第二转发层 + 双路径泄漏

- 位置：`api/domains/settings.ts:18-43`（5 函数逐字 1:1 转发 `@/lib/ipc`，零附加行为）
- 复杂度来源：不在 `api/index.ts` 的 mock 三元里（index.ts 的 `settings` 指 core 域），“平行门面形状”论不成立；electronAPI 唯一适配点规范的真实落点是 lib/ipc.ts（其文件头自述），本文件叠在其上。泄漏已发生：`useAppUpdate.ts:27-38` 直取 `@/lib/ipc`（主 agent 实读复核，10 个函数）——同一能力两条官方路径并存。
- 简化方案：二选一。A 删：UpdatePage 改 import 源 + 9 个测试文件 vi.mock 目标改 `@/lib/ipc`，净删 43 行；B 留：文件头改写唯一正当理由「测试 mock 接缝」并统一 useAppUpdate 路径回本层。
- 功能取舍：A 方案 9 个测试文件的 mock 目标改动；B 方案承认双轨其一。
- 核心价值影响：更新/设置功能行为不变。
- 三段论证：小取舍=测试 mock 目标迁移（机械）｜大简化=删一层 middle man，settings IPC 路径归一｜核心无损锚=调用方证据（生产仅 UpdatePage 一个消费文件 + 已存在绕过者证明该层非受控接缝）
- 推荐强度：Worth exploring
- 评分：投机 2｜热度 2｜收益代价差 1

# 候选 8｜shell 脚手架孤儿：sessions-entry 契约 + shell/workspace 常量

- 位置：`shell/sessions-entry.ts`(53 行 9 方法接口 + 常量)、`shell/index.ts:1`、`workspace/index.ts:1`（两个死脚手架常量）
- 复杂度来源：2026-08-03 提交 8776683e7 的包拆分预留，38 天零消费方；sessions-entry 押注「P4 会经 'sessions' 挂载点注入」——P4 实际以 `core/bootstrap.ts:73-76` 的 sidebar.tab/panel.header/composer.toolbar/statusbar 四挂载点落地（主 agent 实读复核），无 'sessions'，契约锚点孤儿化；且测试文件在为占位符形状写断言（二次成本）。
- 简化方案：删 3 文件 + sessions-entry.test.ts；「未来替换挂载实现」意图一行注释挂 useSidebar.ts 即可。
- 功能取舍：0（无生产调用方）。
- 核心价值影响：ExtensionHost 真实挂载点体系（bootstrap 注册表）不受影响。
- 三段论证：小取舍=无｜大简化=删 57 行 + 1 个误导性接口概念 + 1 个为占位符服务的测试文件｜核心无损锚=调用方证据（git grep 生产引用仅定义文件，主 agent 复核）
- 推荐强度：Strong
- 评分：投机 3｜热度 0｜收益代价差 1

# 候选 9｜aggregate.ts PROVIDER_COLORS 模块级可变全局（隐藏顺序契约）

- 位置：`components/settings/usage/aggregate.ts:26,29-35,38-40,327`
- 复杂度来源：模块级 `const PROVIDER_COLORS = {}` 由 `aggregate()` 内部写入、子组件经 `getProviderColor` 读取——`aggregate()` 因此不是纯函数（隐藏副作用），消费方读到的是「最近一次 aggregate() 调用」的全局态，时序靠渲染顺序隐式保证；两个 UsagePage 实例会互相覆盖。`AggregatedData` 已携带 perProvFull 等全部切片，颜色本可搭车返回。
- 简化方案：颜色映射并入 `AggregatedData` 返回值（或由调用方从 perProvFull 派生），删模块级可变态。注：此条本质是「欠考虑的状态归属」而非投机抽象，因 leaky 契约实锤列为低分候选。
- 功能取舍：无行为变化（usage 家族 8 文件改从结果对象取色）。
- 核心价值影响：配色逻辑不变，仅归属层移动。
- 三段论证：小取舍=usage 家族 8 文件的取色调用点机械改动｜大简化=消除「必须先 aggregate() 再取色」的未成文契约 + 多实例覆盖隐患｜核心无损锚=替代路径（颜色派生数据已在返回值内）
- 推荐强度：Worth exploring
- 评分：投机 2｜热度 1｜收益代价差 1

# 候选 10｜useSubagentListSync / useWorkflowListSync 孪生模块（已漂移）

- 位置：`composables/features/chat/useSubagentListSync.ts`(56) + `useWorkflowListSync.ts`(58)，消费方均仅 `Sidebar.vue:281-282`
- 复杂度来源：两文件除 (store, tab, load) 三槽位外逐字同构，且已漂移——useWorkflowListSync.ts:49-57 的 watch 带 `{ immediate: true }`，孪生没有，是否故意无注释。抽取动机是 Sidebar.vue 行数门禁非复用（真实变体数=2，低于 Rule of Three）。
- 简化方案：合并为单参数化模块 `useListSync(store, { tab, load })`，或收回 Sidebar 内联；合并前先裁决 immediate 漂移是否有意。
- 功能取舍：首拉时序行为需按裁决对齐（drift 有意则参数化 `{ immediate }`，无意则统一）。
- 核心价值影响：侧栏 tab 首拉行为不变（对齐后）。
- 三段论证：小取舍=一条时序行为显式裁决｜大简化=2 文件 → 1 文件，消除孪生同步维护税（漂移即其兑现）｜核心无损锚=调用方证据（各 1 个消费方，合并后调用面更窄）
- 推荐强度：Speculative（低体量，顺手项）
- 评分：投机 1｜热度 2｜收益代价差 1

---

# 已核实非过度（四问通过 / 豁免成立，不可砍）

- `composables/panel/useCompactQueue.ts`(413)：defer 队列+投递确认+per-entry 通道，6 个真实消费方（App.vue:98、composer-shell.ts:163、useChat.ts:78,99、useSidebarSessionActions.ts:69、MessageStream.vue:240、core provider 注册）
  - 不可砍理由：本质复杂度（领域本身难）；「CompactQueue≠压缩队列」保名是 C-proc-10 裁决登记
  - 证据快照：调用方计数 6 + 审计日期 20260911
- `composables/panel/composer-shell.ts`(511)+`composer-keydown.ts`：壳层装配模式（14 个 shim 收编），键盘分发优先级每条对应已发生回归（composer-keydown.test.ts 用例组锁定）
  - 不可砍理由：core←renderer 依赖方向正确（ADR-0058/W4），删层有行为变化；35+ 字段返回面建议文档分组导览而非改码
  - 证据快照：生产调用方 Composer.vue:211,264,303,306,399（唯一，收编前有 14 shim 变体史）+ 审计日期 20260911
- `composables/features/settings/useAppUpdate.ts`(815)：9 态状态机映射真实 Electron 两阶段更新协议；约 10 个模块级守卫 flag 各有已发生缺陷编号背书（RC1/RM2.3/Q1-6/W05/ES4/ES5/D2）
  - 不可砍理由：本质复杂度 + 近 30 天热点（17 commits）；唯一动作点是 restore* 两函数移出生产返回对象（见代码级清理点）
  - 证据快照：3 组件消费（UpdateCheckCard:239、UpdateButton:179、Sidebar:245,284）+ 审计日期 20260911
- `composables/shell/useExtensionHostBridge.ts`(458)：工厂链各层有第二宿主证据（mobile-renderer adapter、core mock）与事故编号背书（MF-1/MF-4、ADR-0060、2026-08-04 死锁）
  - 不可砍理由：有变更证据的隐藏决策（core headless ↔ 壳 reactive 化边界）；仅接口面瘦身（候选外，见清理点）
  - 证据快照：main.ts:8,28,32 + App.vue + 4 组件经 provide 消费 + 审计日期 20260911
- `composables/panel/usePinBottomGuard.ts`(180)：dev-only 护栏（生产透传原 API），双采样/沿触发有 chat-pin-bottom-fix 修复波逐条背书
  - 不可砍理由：护栏类设施赌注已被真实回归史兑现；生产调用面零改动
  - 证据快照：MessageStream.vue:188,360（唯一）+ 专测存在 + 审计日期 20260911
- `composables/panel/command-popover-keyboard.ts`(157)+`useCommandPopoverTrigger.ts`(284)+`command-popover-symbols.ts`(259)+`skill-candidates.ts`(97)+`source.ts`(19)：语义域清晰（键盘状态机有缺陷 A/B 回归史；bareSkillCommandName 是 3 文件消费的前缀剥离 SSOT；provide/inject 双方契约真实）
  - 不可砍理由：本质复杂度 / ≥2 真实变体（F1+F0 双分区独立裁定一致）
  - 证据快照：CommandPopover.vue:153-159 + Composer.vue:209,264 + 审计日期 20260911
- stores 全域（chat.ts 注册壳 / sidebar.ts 真状态 / project/fileTree/navigation/panel/subagent/workflow）：strangler 终态或真 store，非转发壳
  - 不可砍理由：chat.ts 是 core createChatStore 的 pinia 注册壳（约 30 消费方零 churn）；sidebar.ts 4 组件消费
  - 证据快照：分区 D 逐文件核对 + 审计日期 20260911
- `api/session-api-port.ts`：有证据的依赖倒置（renderer buildSessionApiPort 2 生产调用方曾各持同构副本；mobile-renderer adapter + core mock 宿主变体真实）
  - 不可砍理由：Parnas 合法隐藏（有真实变体）
  - 证据快照：useNewTaskFlow.ts:127、useSidebar.ts:87 + 审计日期 20260911
- `composables/features/settings/useQuotaConfigure.ts`(475)：24 返回成员各对应 UI 元素/门控；readiness 判定逐条落地设计文档 §7.2
  - 不可砍理由：表单本质宽度；密文去掩码/RPC 前快照均为已发生正确性问题
  - 证据快照：CodingPlanSection 单页消费 + 审计日期 20260911
- `useProviderOAuth`+`useProviderPageOauth` 双层：协议状态机 vs 页面编排，删除任一层会吞并两种变更原因
  - 不可砍理由：本质分层（分区 C 判定）
  - 证据快照：ProviderPage.vue:147,218 + 审计日期 20260911
- trace/ 子目录（10 文件 1319 行）、detail-renderers/（无注册表，分发即 v-if）、容器层级（MainPanel→Workspace→PanelContainer→Panel 每层有独占逻辑）、`components/ui/` 框架封装（hover-card/textarea/scroll-area 等均有 2-10+ 消费方）、`lib/` 各模块（2-5 消费方的三副本收敛产物）、platform 端口（desktop/mobile/mock ≥3 宿主）、`useSidebar.ts`(403 strangler 完成态组合根)、`useSideDrawer.ts`(已登记过渡债，删除前置清单在文件头)、ProviderPage 四伴生模块、`SystemLlmRetrySection.vue`、`ImportSessionDialog.vue`、`SessionItem.vue`、`useTaijiThemes.ts`
  - 不可砍理由：本质复杂度 / Fowler 框架豁免 / 已登记的绞杀中间态（架构 SSOT §11 逐域绞杀策略背书）
  - 证据快照：各分区报告逐条 git grep 调用方清单（附录）+ 审计日期 20260911

# 另有 12 处代码级清理点（语句级，移交 code-simplify）

1. 零引用导出收窄（约 40 个符号，六分区汇总：ToastOptions、SPINNER_STATUSES、NEUTRAL_ENGINE_ICON、ProviderOAuth* 四类型、AuthedModelOption、ImportState、BackgroundTask* 三类型、IMPORT_* 三常量、DetailPaneState、PreviewStatus、TraceJumpResult、AttachedContextItem、NEW_SUBAGENT_ITEM_ID、SymbolCandidate、SlashCandidateInput、SkillCandidate*、SlashCommandSource、CwdFileFetchStatus、ApplyDeltaFn、FinalizeStreamFn、SetMessagesFn、LineStats、LoadStatus、MAX_ENTRIES、ROOT_PANEL_ID、BackgroundTaskBucketValue、SubagentBucket、EmptyResultStrikeGuard、PartitionedRecords、ResolvePreviewPathResult、DetectedPlatform 等）——去 export 零行为变更，一次机械提交
2. `useAppUpdate.ts:787-788` restorePendingUpdate/restorePreloadedUpdate 移出生产返回对象（生产调用方 0，仅测试消费）
3. `useAccordionGuard.ts:14-19,72-84` PendingAction 三态判别联合 → `pendingTarget: string | null`（三分支收敛为同一赋值，值域被类型重编码）
4. `useBackgroundTasks.ts:129-136` parseListReply 的防「契约回退」Array.isArray 分支（防不存在于任何 roadmap 的场景）
5. `useMessageStreamNotices.ts` 空壳改名（现仅剩常量导出，"use*" 命名遗留，文件头自述）
6. `useGlobalShortcuts.ts:31` 悬空注释「来自 useSidebarNew」（该文件已删，commit af96fa94c）
7. `markdown.ts:284` 误导注释（随候选 2 一并处理）
8. `useSubagentListSync`/`useWorkflowListSync` 的 `{ immediate: true }` 漂移注释裁决（随候选 10 前置）
9. `useExtensionHostBridge.ts:283-293` initExtensionHostBridge 返回 9 字段对象生产恒丢弃 → 瘦身 void 或 `__testing` 命名空间（4 个 `__*ForTest` 后门同批归整）
10. `stores/panel.ts:28,33-35` + `shared/src/panel.ts:8-13` PanelLeaf 单成员判别字段与 `panels` merge 兼容残迹（真实消费仅 useMessageEffects.ts:80 一处；需连带 core api-port.ts:79 端口签名）
11. `aggregate.ts:44,183` newMetrics/AggregatedData 投机导出去 export（随候选 9 一并）
12. `useCompactQueue.ts` 与 core `CompactQueueLike` 双契约注释互指（结构类型 seam，不合并）

# 附录：语义层四问记录

6 个分区 subagent 的结构化返回已由主 agent 归档（本报告候选/非过度/清理点全部源自其带 file:line 的发现记录；11 条关键断言经主 agent 实读抽验：search 死链、markdown 死链、adapter 19 方法、mock 旁路、sessions 挂载点孤儿、useAppUpdate 绕过路径、'waiting' 类型缺位、useSidebarNew 删除提交、门禁 MAX_SCRIPT_LINES、useMessageStreamNotices 空壳自述、ui/table 零引用、vee-validate 单消费——2 条推翻：useSidebarNew 双轨不存在、session-api-port 单实现不成立）。分区报告全文见各 subagent 会话记录；裁决后如需存档基线，可从本报告附录节摘录证据快照。
