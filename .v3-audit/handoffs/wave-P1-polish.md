# Wave P1 · token 与组件精细度打磨

> 自包含 handoff。新 session 只读本文档即可开工。先读完"项目与全局上下文"。

## 项目与全局上下文（所有 Wave 共享，必读）

**项目**：xyz-agent（Electron + Vue3 + TS + Tailwind v3 + Pinia）。v3 冷蓝暗色设计（ADR-0018），暗色为真默认（ADR-0021-B）。
**工作目录**：`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`
**渲染层源码根**：`src-electron/renderer/src/`（审计文档误写 `components/workspace/panel/`，实际是 `components/panel/`）
**编码规范**：`docs/standards.md` + worktree 根 `CLAUDE.md`（禁止 scoped 自定义 CSS、禁止原生 HTML 表单元素、禁止 any、Ponytail 模式）

**设计稿 SSOT**（路径含空格，bash 必须整体加引号）：
`"/Users/zhushanwen/Library/Application Support/Open Design/namespaces/release-stable/data/projects/5c80f187-ed73-415b-8c81-f825302eacbc/docs/designs/v3-demo/"`
下称 `$V3`。结构：`{shell,sidebar,workspace,panel,overlays,overview,settings}/spec.md` + 同目录 `draft-*.html`；根 `README.md` + `ui-skeleton.md`。

**审计产出**：`.v3-audit/`（`results/wave-W01~W19.md` + `batch-{1,2,3-4}-summary.md` + `decisions.md`）

**Phase D 已完成（6 commit）**：token SSOT（`e2b386ea`）/ 删零引用组件（`39eee5da`）/ UI 原子对齐（`373f33d6`）/ settingsStore（`c5723efa`）/ Shell+Sidebar+Panel 布局（`462e878e`）/ Composer steer（`3a4a33e5`）。详见 `git log --oneline -6` 或 `.v3-audit/handoffs/wave-V-visual-verify.md` 顶部的 commit 清单。

**3 裁决**（`.v3-audit/decisions.md`）：DEC-01 SessionItem=inset ring/Panel=四层；DEC-02 min-h=40px；DEC-03 S6=steer 长期方案。

**硬禁忌（必守）**：
1. ★ **AI 自身绝对禁止直接 read 图片，会卡死整个会话**。视觉对比走 subagent + 视觉模型（`minimax/MiniMax-M3` 或 `zai mimo-v2.5-pro`），返回文本结论。
2. dev server 等长跑进程必须**异步后台启动**（bash `background:true`）。
3. 禁 `SKIP_LINT=1`/`--no-verify`/`eslint-disable`/`any`。禁 scoped 自定义 CSS（keyframes 归 `tailwind.config.ts`）。
4. 路径含空格 bash 加引号。审计行号/路径会漂移，改前先读真实代码。

**模型路由**：subagent 需指定模型。读代码/规划→`kimi-coding/kimi-k2-thinking` 或 `deepseek/deepseek-v4-pro`；纯机械→`deepseek/deepseek-v4-flash`；视觉→`minimax/MiniMax-M3`。

---

## 本 Wave 目标

处理 Phase D 登记的待收敛项 + 各 wave 报告里的 P2 级精细度问题。这些都是确定性、小规模、不依赖 flow-2 数据源的问题。

## 前置

**先跑 Wave V**（`.v3-audit/handoffs/wave-V-visual-verify.md`）。Wave V 的视觉验证报告 `.v3-audit/verify/phase-D-visual.md` 会确认哪些 P2 项真的需要改、哪些视觉可接受。若 Wave V 未跑，先跑或自行做最小视觉确认。

## 任务清单（6 项，按依赖排）

### P1-1 · `--surface-2` 与 `--surface-hover` 同值决策
- **现状**：`style.css` 中 `--surface-hover: #1b1b20` 与 `--surface-2: #1b1b20` 同值（Phase D 按"设计稿原值不臆造"落地，但设计稿两处独立取同值未协调）。
- **影响**：Input/Textarea（用 `--surface-2`）在 hover 时无视觉变化；`--surface-hover` 用于面板/卡片 hover。
- **决策依据**：Wave V 视觉确认。若 Input/Textarea 容器边界感不足→插值中间值（如 `#18181e`，介于 `--surface #151519` 与 `--surface-hover #1b1b20`）打破同值；若视觉可接受→仅在 `docs/designs/design-tokens.md` 登记已知裂缝。
- **改**：`src-electron/renderer/src/style.css` + `docs/designs/design-tokens.md`（三处保持一致：style.css / tailwind.config.ts 映射 / design-tokens.md）。

### P1-2 · Button focus ring 统一性决策
- **现状**：`button/index.ts` 基础 class 仍是 `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`（外环+offset）；Input/Textarea 已改 `ring-1 ring-inset ring-accent-ring`。
- **判断**：design-system.md §4 的 inset ring 要求针对 Input/Textarea（"同 Card-Active 手法"），未要求 Button。Button 外环有 ring-offset 与实色底分离的视觉效果，是 shadcn 惯例。
- **决策**：读 `docs/designs/design-system.md` §3（Button）确认是否要求 Button 也 inset。若未要求→保持现状（语境差异合理），在 design-system.md 补注说明；若要求→统一改 inset。
- **改**：视决策，`button/index.ts` + 可能 `design-system.md`。

### P1-3 · Input error 文案机制
- **现状**：Phase D 的 T06 给 Input 加了 `error?: boolean` prop（error 时 `border-danger`），但未加错误文案（BUI-IP-03）。
- **design-system.md §4 原文**："错误态 `--danger` 边框 + 下方错误文案"。
- **判断**：shadcn 体系错误文案通常由表单层 `FormMessage` 处理（项目有 `components/ui/form/`）。需确认 design-system 的"下方错误文案"是原子 Input 职责还是表单层职责。
- **决策**：读 `docs/designs/design-system.md` §4 + 项目 `components/ui/form/FormMessage.vue`（若存在）。若表单层已有 FormMessage→Input 只管 border（现状正确），在 design-system 补注；若要求 Input 自带→加 `errorMessage?: string` prop + slot。
- **改**：视决策，`Input.vue` 或 `design-system.md`。

### P1-4 · ScrollBar thumb 色过淡
- **审计**：W02 BUI-SA-01。`ScrollBar.vue` thumb 用 `bg-border`（`rgba(255,255,255,0.06)`，6%），暗色背景几乎不可见。
- **改**：`src-electron/renderer/src/components/ui/scroll-area/ScrollBar.vue`，thumb 改 `bg-border-strong`（12%）或读 design-system 是否有 scroll-thumb 专用 token。
- **注意**：Sidebar SessionList 有 scoped 自定义 scrollbar（W02 提到），核对是否需统一。

### P1-5 · GitZone 分支名 truncate
- **审计**：W13 WP-L3-28。`GitZone.vue` 分支名 `{{ gitBranch }}` 无 truncate，超长溢出。
- **改**：`src-electron/renderer/src/components/panel/GitZone.vue`，分支名 span 加 `truncate max-w-[120px]`。

### P1-6 · ProgressZone 空态判断
- **审计**：W13 WP-L3-26。`ProgressZone.vue` 用 `v-if="sessionLabel"` 判断显示，但设计要求"无任务时整区隐藏"（依据 hasTasks 非 sessionLabel）。
- **现状**：FG4 骨架阶段无任务数据，用 sessionLabel 做 proxy。
- **决策**：无 runtime 进度数据源（T00 确认 Flow3 DEFERRED）。短期：保持骨架显示但加注释说明 proxy；长期等 Flow3。
- **改**：`ProgressZone.vue` 加 TODO 注释明确空态判断是 proxy（不改逻辑，避免无数据时 UI 空洞）。

## 执行方式

任务独立、文件无交集（P1-1 style.css / P1-2 button / P1-3 Input / P1-4 ScrollBar / P1-5 GitZone / P1-6 ProgressZone），可 5 并行 subagent。P1-1/P1-2/P1-3 含决策，用 `kimi-coding/kimi-k2-thinking`；P1-4/P1-5/P1-6 纯机械，用 `deepseek/deepseek-v4-flash`。

## 必读文档

- 审计详情：`.v3-audit/results/wave-W02-ui.md`（BUI-IP-03/SA-01）、`wave-W13-companion-zones.md`（WP-L3-26/28）
- 设计规范：`docs/designs/design-system.md` §3（Button）§4（Input/Textarea）、`docs/designs/design-tokens.md`
- Wave V 产出（若已跑）：`.v3-audit/verify/phase-D-visual.md`
- 现状代码：先 `git show 373f33d6`（UI 原子改动）+ `git show 462e878e`（Panel 改动）

## 验证

每项改后：`cd src-electron/renderer && npx vue-tsc --noEmit` + 根目录 `npm run lint`。视觉项（P1-1/P1-4）改后异步启 dev:mock 截图给 minimax subagent 对比（禁忌第 1 条）。

## 边界（不做）

- 不做 MessageStream 块扩展（Wave P2）
- 不做 flow-2 相关（FileChanges/状态机，DEFER）
- 不重构已有正确逻辑
