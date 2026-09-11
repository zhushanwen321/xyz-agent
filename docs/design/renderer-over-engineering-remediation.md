# renderer 过度设计审计修复方案

> 来源审计：[renderer-over-engineering-audit-20260911.md](./renderer-over-engineering-audit-20260911.md)（over-engineering-audit skill 产物，证据等级：完整——可计算信号全跑 + 6 分区语义四问 + 业务文档映射，11 条关键断言主 agent 实读抽验、2 条推翻复核）。
> 执行计划：[renderer-over-engineering-remediation.impl-plan.md](./renderer-over-engineering-remediation.impl-plan.md)
> 日期：2026-09-11

## 1 背景/目标

2026-09-11 对 `packages/renderer`（约 5.2 万行生产代码）的过度设计审计识别出 10 个简化候选与 12 处代码级清理点。用户裁决按 7 组分组执行全部候选（本设计文档 §4 裁决记录）。

目标：

1. 删除迁移残留死代码与孤儿脚手架（约 1500 行），消除「哪份是 SSOT」的双轨辨析成本
2. 收敛孪生/镜像/转发结构（fork 通知链路、listSync 孪生、settings 双转发层、popover 微包装）
3. 退役未兑现的依赖赌注（vee-validate / @vee-validate / zod + ui/table + ui/form）
4. 修复 settings 域 mock 旁路（mock 模式下 19 方法打真实 WS，与全应用背离）
5. 完成 12 处语句级清理点

Out-of-scope：审计「已核实非过度」清单（见审计报告同名节）一律不动；`packages/core`、`packages/ui` 本体不在本轮范围（候选 1 仅触及 core 内 1 个死文件，候选 D 不触及 ui 包——`components/ui/` 是 renderer 包内目录，与 `packages/ui` 无关）。

## 2 终态/机制

各候选落地形态（详细证据 file:line 见审计报告对应候选节）：

### 2.1 组 A：死代码纯删除（候选 1、2、8）

- 候选 1（search 残留，约 621 行）：删 `packages/renderer/src/composables/features/search/useSearch.ts`、`useSearchJump.ts`、`composables/features/new-task/useRecents.ts`、`composables/features/command/useCommandRegistry.ts` 及配套测试（`useSearch.test.ts`、`useSearchJump.test.ts`、`useRecents.test.ts`、`__tests__/i18n/section-kind.test.ts` 中的引用）。core 侧收口见 §4 裁决 1。
- 候选 2（markdown 交互，约 284 行）：删 `composables/panel/useMarkdownInteractions.ts`、`useCodeblockCopy.ts`、`useToolMeta.ts`、`__tests__/composables/useMarkdownInteractions-fallback.test.ts`；修正 `composables/logic/markdown.ts:284` 误导注释（实际点击处理在 `packages/ui/src/features/chat/MarkdownRenderer.vue:144-190`）。
- 候选 8（shell 孤儿，约 57 行）：删 `shell/sessions-entry.ts`、`__tests__/shell/sessions-entry.test.ts`、`shell/index.ts` 与 `workspace/index.ts` 中的死脚手架常量；「未来替换挂载实现」意图一行注释挂 `useSidebar.ts`。

### 2.2 组 B：语句级清理点（#1-#6、#9、#10、#12）

审计报告「另有 12 处代码级清理点」节全量落地，其中 #7 随候选 2、#8 随候选 10、#11 随候选 9。#1（约 40 个零引用导出收窄）按域分 3 批执行；fork/popover 域符号（ApplyDeltaFn、FinalizeStreamFn、SetMessagesFn、BackgroundTask*、CwdFileFetchStatus）不在独立批次执行，随组 E/G 的文件级改动顺带收窄，避免同文件跨组冲突。

### 2.3 组 C：usage 颜色归属（候选 9 + #11）

`components/settings/usage/aggregate.ts` 的模块级可变 `PROVIDER_COLORS` 并入 `AggregatedData` 返回值（派生数据已在返回值内），5 个有取色调用的消费组件（UsagePage/UsageDetailTable/UsageDailyChart/UsageModelRank/UsageProjectRank）改从结果对象取色；`AggregatedData` 投机导出去 export（#11 落地）；`newMetrics` [修正 2026-09-11 阶段 3] 保留 export——执行时核实 4 个（改造后 5 个）测试文件真实 import，符合偏差登记表 D2/§5 D8，非漏做。

### 2.4 组 D：依赖与表单库退役（候选 5）

删 `components/ui/table/` 整目录（7 文件 97 行，全仓零引用）、`components/ui/form/` 整目录（7 文件 116 行 [修正 2026-09-11 阶段 3] 原记「6 文件」漏计 index.ts barrel）、`components/ui/popover/PopoverListItem.vue` 与 `PopoverActionItem.vue`（零消费陈旧副本，107 行）；`RenameSessionDialog.vue` 改直连 Input + 10 行内联校验（判定结果等价：label min1/max60/无换行；错误可见时机差异见 §4 裁决 6/偏差 D7）；`package.json` 删 `vee-validate`、`@vee-validate/zod`（zod 若 renderer 内无其他 import 一并删）+ lock 更新。

### 2.5 组 E：孪生/镜像收敛（候选 6、10 + #8）

- listSync（候选 10）：`useSubagentListSync.ts` 与 `useWorkflowListSync.ts` 合并为单参数化模块。合并前置裁决见 §4 裁决 2：workflow 版 tab watch 的 `{ immediate: true }` 是冗余（其全部触发场景被首个 watch 的 immediate 覆盖），删除之，两文件行为归一后合并。
- fork 通知链路（候选 6）：`useForkBranchNotify.ts`（204 行）+ `useForkNoticeEffect.ts`（286 行）——feed/追踪态改模块级单例（同文件 feedMap 既有范式，ADR-0049 例外注释已论证），删实例化+镜像层与 onBranchStatusChange 多播 Set（全仓恰 1 注册方），删 `classifyChange` 的 'waiting' 死分支（`SessionStatus` 联合类型无该值，永不可达）。预计 490 行缩约三分之一。FR-19 角标功能多消费方（App.vue/ForkGroup.vue/MessageStream/useForkActions）全部保留。

### 2.6 组 F：settings 传输路径归一（候选 4、7）

- 候选 4：接口缝（core `SettingsTransport` + provide）保留（5 个测试文件真实注入，豁免）；`settings-transport-adapter.ts` 坍缩——import 源从 `core/transport/api/domains/{config,model,extension}` 直连改为 `@/api` 门面三元导出（§4 裁决 3：mock 模式下 settings 域走 mock，与全应用一致），或内联进 `useSettingsShell.ts` + `discoverModels` 8 行 guard 移入域内。涉改测试：stubTransport 相关（settings-modal-smoke.test.ts 等，执行时 grep `SettingsTransport` 精确定位）。
- 候选 7（§4 裁决 4：留作测试接缝）：`api/domains/settings.ts` 文件头改写唯一正当理由「测试 mock 接缝」并统一 `useAppUpdate.ts` 的 10 个 IPC 函数 import 路径回本层（消除已发生的绕过泄漏）；顺带 #2（`useAppUpdate.ts:787-788` restore* 两函数移出生产返回对象）。

### 2.7 组 G：command-popover 域合并 + 门禁豁免（候选 3）

两步同批（缺一会被门禁弹回）：

- 规则层：`.githooks/vue_rules_checker.py` 增加豁免通道——文件头 `<!-- split-justified: <语义域> -->` 登记后 `MAX_SCRIPT_LINES` 上限放行（具体形态：登记文件仍受一个更高的绝对上限约束，防止无限膨胀；门禁无登记的超限文件依旧拦截）。规则本体改动按项目规范附 `[HISTORICAL]` 式说明注释。
- 代码层：`command-popover-delivery.ts` 并回同域（命令投递）、`command-popover-file-candidates.ts` 内联回 `CommandPopover.vue` 或并入 `command-popover-open-fetch.ts` 的 file 分支、`useCommandPopoverCwdFileView` 并入 open-fetch 删回调缝、`composer-injection-store.ts:22-24` 3 行兼容函数统一为 const 形态、`useForkNoticeStream.ts`（一行派生+两个一行转发）并回消费方。合并后的超行文件加 split-justified 登记。语义域清晰或有测试锁定回归史的 keyboard/symbols/skill-candidates/source/trigger 五模块不动。

## 3 验收场景表

| # | 真实流程 | 通过标准 |
|---|---------|---------|
| V1 | 删除后 `pnpm dev` 启动应用，⌘K 搜索全流程：搜命令/file/会话 + jump 跳转 | 功能与删除前等价（本体在 core/ui）；`vue-tsc --noEmit` 绿；全仓 grep 无悬空 import |
| V2 | markdown 渲染页：代码块复制按钮、文件路径点击 | 功能等价（本体在 ui 包 MarkdownRenderer）；grep 无对已删 3 文件的引用 |
| V3 | 会话列表/侧栏/settings 页正常打开 | 无 console 报错；sessions-entry 删除无残留引用 |
| V4 | usage 页打开：各 provider 配色显示 | 颜色与改动前一致；两个 UsagePage 实例不互相覆盖（代码审阅：颜色随 AggregatedData 返回） |
| V5 | 重命名会话对话框：空名/超 60 字/含换行拒绝，合法名成功 | 行为与改写前等价；`pnpm --filter @xyz-agent/frontend build` 成功且产物无 vee-validate |
| V6 | 侧栏 subagents/workflows tab：挂载即首拉一次（不重复拉）、切 tab 首拉一次 | 行为与合并前一致（workflow 版冗余 immediate 已删）；既有 listSync 测试绿 |
| V7 | 后台分支产生 fork 角标 → 读后清零；切会话角标保持 | FR-19 功能等价；fork 相关既有测试绿 |
| V8 | `VITE_MOCK=true` 构建/启动：settings 域操作 | 走 mock（不再打真实 WS），与全应用其它域 mock 行为一致；real 模式 settings 全功能正常 |
| V9 | settings IPC：更新检查/设置读写 | 行为不变；useAppUpdate 的 IPC import 全部经 `api/domains/settings` |
| V10 | 合并后超 300 行且带 split-justified 登记的文件提交 | pre-commit 通过；构造一个无登记超 300 行样例仍被拦截（门禁回归自测）；popover 触发/键盘/投递/文件候选手测等价 |
| V11 | 清理点全部落地 | `vue-tsc --noEmit` + renderer vitest 全绿；去 export 符号 grep 无生产引用残留 |

Gate A = 全量测试（`cd packages/renderer && pnpm test` + 受影响包测试）；Gate B = 上表逐行签收。

## 4 裁决记录（2026-09-11 用户拍板）

1. **组 G 门禁豁免**：加豁免通道，组 G 完整做（`vue_rules_checker.py` 增加 `split-justified` 登记）
2. **候选 7**：B 留作测试接缝——`api/domains/settings.ts` 文件头登记「测试 mock 接缝」，useAppUpdate 路径统一回本层（[修正 2026-09-11 阶段 3] 原注「9 个测试文件 mock 目标不动」与实况不符：仓库任一时点均无「9 个 mock 本层」的集合（基线仅 3 个 vi.mock 本层），且路径统一必然要求 useAppUpdate 的测试 mock 目标随 import 源从 `@/lib/ipc` 迁至本层——实际同步 5 个测试文件，落地见 u18 commit 830048962；另 9 个 update 家族 IPC 函数按本节「统一 10 个 IPC 函数回本层」一并并入转发层）
3. **候选 4 mock 旁路**：接回门面三元——mock 模式下 settings 域走 mock。前置可行性已核实：`api/index.ts:47` 已有 `settings` 三元且 `mockApi.settings` 实现存在（门面注释「两套实现签名一致」）
4. **组 A 二选一**（主 agent 机械判定，非用户裁决）：renderer `useAppCommands.ts` 被 `useSidebar.ts:295` 真实调用（活）；core `app-commands.ts` 生产引用 0、测试引用 0（仅 `domain/new-task-search/index.ts:24` re-export）——**删 core 版**。若未来 search 域彻底绞杀归 core，届时按需重迁（YAGNI）
5. **immediate 漂移裁决**（主 agent git 考古判定）：`useWorkflowListSync` tab watch 的 `{ immediate: true }` 创建即带（commit 704013b52）且有注释论证，但其触发场景（挂载时 tab=workflows 且 sid 存在）被首个 watch 的 immediate 完全覆盖——判定为冗余而非有意行为差异。对齐方向：删 workflow 版冗余 immediate（subagent 版无 immediate 的行为是完备的），归一后合并
6. **RenameSessionDialog 错误可见时机**（主 agent 阶段 3 裁决）：改写后错误改为「输入即显示」（`(label !== initialValue || submitAttempted) && validationError`），旧 vee-validate 实现是 blur/提交后才显示（`touched && !valid`）。**校验判定结果完全等价**（空/超 60/换行/合法四类边界逐条一致），仅反馈时机提前——判定为正向 UX 变化（用户清空输入框即刻得到「不能为空」提示），登记为合理偏差 D7。不补 blur 门（引入额外 touched 状态与测试改写成本高于收益）；vite 测试注释已按新语义校准（修-4）。

## 5 执行约束

- 审计「已核实非过度」清单所有条目（useCompactQueue、composer-shell、useAppUpdate 主体、useExtensionHostBridge、usePinBottomGuard、popover 五语义域、stores 全域、session-api-port、useQuotaConfigure、OAuth 双层、trace/、detail-renderers/、容器层级、`components/ui/` 框架封装、lib/、platform 端口、useSidebar、useSideDrawer 等）不可砍
- 「三视角缺一不可」测试红线沿用 TEST-STRATEGY.md；删除类单元以「既有测试绿 + typecheck 绿 + grep 零残留」为验收，不要求为新删行为补测试
- 纯文件删除批次（rm + 引用核验，零行逻辑修改）允许单批 ≤10 文件——对全局 subagent 约束「每子任务 ≤5 文件」的显式登记豁免（规则意图为防认知过载，纯删除无此风险），已在 impl-plan 合理偏差登记表固化
