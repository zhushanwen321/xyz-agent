# v6 视觉稿审查 → 改进任务计划（2026-07-31）

> 输入：[`v6-review-2026-07-31.md`](./v6-review-2026-07-31.md)（五路审查报告，676 行）
> 核实：22 条抽样断言 → 21 完全属实 / 1 部分成立 / 0 错误（审查质量高，可作可信依据）
> 裁决：4 个 P0 方向已由用户确认（见 §1）
> 本文档：把审查意见转成**有依赖顺序的可执行任务**，按阶段编排

---

## 0. 核实结论摘要

审查报告抽样核实结果：**审查意见可信**。

| 子报告 | 抽样 | 属实 | 部分成立 | 错误 |
|--------|------|------|---------|------|
| Tokens/Shell/Demo | 5 | 5 | 0 | 0 |
| 对话流 | 5 | 4 | 1 | 0 |
| 侧栏/Drawer | — | （并入上） | — | — |
| Settings | 4 | 4 | 0 | 0 |
| Overlays/Plugin | 7 | 7 | 0 | 0 |
| **合计** | **22** | **21** | **1** | **0** |

**唯一部分成立**：drawer browser 二级 tab（矛盾真实存在，但离群点描述反了——是 §6 anno :1509 离群，矩阵与 mock 同阵营）。不影响任何 P0 结论。

**核实额外发现**（审查未提）：
- `v6-design.md` §4.5 标题在 `:210` 与 `:212` 重复两次（小 bug）
- plugin §9.4 闭环计数矛盾比审查描述更深：`:1987` 把已降级的 M15 仍计为闭环，而 `:792-793` 已声明 M15 并入 M11

---

## 1. 四项裁决（用户已确认）

| # | 裁决点 | 决定 | 影响 |
|---|--------|------|------|
| D1 | 设置形态（决策 #13） | **全屏覆盖** | 重写 settings shell spec §1/§2（搬旧文件 .fso 结构）；旧文件删除前先吸收其正确性 |
| D2 | Drawer 模型 | **一体化生长** | **反向修订 v6-design** §4.3 + §4.1 决策 #10；shell spec §7 按 §3.4 重做（去 border） |
| D3 | tasks tab | **移除（回归对话流）** | **反向修订 v6-design** §4.3 补决策声明（含 HIDDEN_TOOL_NAMES 迁移）；同步 drawer spec §9 |
| D4 | plugin 范围 | **补登记为架构授权** | v6-design §1 补决策 #15；plugin spec 内容保留但标注阶段归属 |

**关键认知**：D2/D3 是 design 追认 spec 的演进（不是 spec 适应 design）。裁决后 **SSOT 本身要变**。

---

## 2. 任务编排原则

1. **裁决优先**：所有需要方向判断的，先定再改（已完成 §1）
2. **SSOT 先行**：v6-design.md 是所有 spec 的源头，先改它，再改 spec 对齐
3. **先结构后细节**：先解决"两份定稿互相否定"（结构性），再修"anno/CSS 失配"（细节）
4. **复制漂移根治**：对话流四文件的共享 CSS 必须先抽基线，否则修一处漏三处
5. **每阶段独立可验收**：不混合结构改动与降噪收尾

---

## 阶段 0：SSOT 修订（v6-design.md）—— 阻塞所有后续

> 目标：让 v6-design.md 反映四项裁决，消除"SSOT 与 spec 互相否定"的根因。
> 性质：文档修订，无代码改动。所有后续阶段以此版 design 为基准。

### 任务 0.1 — Drawer 模型改一体化（D2）
- [ ] §4.3 SideDrawer 容器行：删「去硬 border-l 改投影分隔 shadow: -12px 0 24px...」，改「drawer 与 main 共享同一 surface 浮起体，从 main 右缘生长挤占 main 宽度，底色同为 --surface，无投影无 border 分隔」
- [ ] §4.1 决策 #10「背景层次」表：drawer 从「画布色 --bg」改为「与 main 同体 --surface」；同步修订三层明度表述（stage 深底 → 画布 --bg → **main+drawer 共享 surface 浮起**）
- [ ] §3.4 分隔策略：补「drawer 与 main 之间无分隔元素，靠共享 surface 一体化；内部 header 用 bg-surface-2 浮起分层」
- [ ] **消除 shell spec §1 与 §7 的自相矛盾**：§1 `:680`「drawer=画布色」改为一体化表述（或在阶段 1 改 shell spec 时统一）
- [ ] 验收：design 全文搜「shadow-drawer」「-12px 0 24px」「bg-sunken.*drawer」，确认无残留旧方案

### 任务 0.2 — tasks tab 移除声明（D3）
- [ ] §4.3 标题「右侧 Drawer（6 tab）」改「（7 tab）」——移除 tasks、新增 subagent/workflow
- [ ] §4.3 二级 tab 策略表：删 tasks 行；§4.3 组件表删 TasksPanel/GoalCard 行
- [ ] §4.3 补决策声明：「tasks tab 移除，goal/todo 走 gui-protocol 统一渲染回归对话流；移除 HIDDEN_TOOL_NAMES 对 todo/goal_control 的特判（迁移影响见 blocks spec §12）」
- [ ] §4.3 C4 实施波次：「git·doc·tasks 无二级」改「git·doc 无二级」
- [ ] 验收：design 全文 tasks/TasksPanel/GoalCard 引用与「7 tab」一致

### 任务 0.3 — plugin 架构授权（D4）
- [ ] §1.1 决策表新增 #15：「plugin 渲染体系扩展授权——M1 侧栏第 5 tab / M8 main-panel 底栏 / M11 companion-band 统一交互出口 / M15 降级 / §9 ExtensionHost 层 + commands.register/views.update API 缺口，属 renderer-target-architecture 路线，与 v6 视觉层并列推进」
- [ ] §1.3 结构决策补注：「sidebar 第 5 tab（plugin）授权新增，突破决策 #2 的 4 tab 拓扑——仅 plugin tab 例外」
- [ ] plugin spec §9 交互闭环标注「属架构路线内容，阶段 B 衔接点，非阶段 C 视觉层」

### 任务 0.4 — §4.5 重复标题修复 + 小修
- [ ] `:210` 与 `:212` 的「### 4.5 设置页」重复标题删除其一
- [ ] §4.5 desc 文字色：`--neutral-dim` → `--neutral-mid`（消除与 §5.1 的矛盾；spec 已按 §5.1 执行且 AA 论证充分）
- [ ] block icon 尺寸：§4.1「13px」与 §5.3「14px」二选一统一（建议 14px 对齐 §5.3 scale）

---

## 阶段 1：结构性 spec 修复（消除"两份定稿互否定"）

> 依赖：阶段 0 完成。目标：每个视图只有一份权威 spec，内部不自相矛盾。

### 任务 1.1 — settings shell spec 重写为全屏（D1，最高优先）
- [ ] §1 `.fs-scrim`/`.fs-modal` 改纯不透明全屏（参考旧文件 `:112-117` 的 `.fso`）：删 scrim bg/blur，`fixed inset-0 bg-bg z-modal`，无 max-width 居中
- [ ] §2 nav：`w-200 bg-surface border-r` → `w-220 bg-sunken` 无 border-r
- [ ] nav 选中态：`surface-hover + neutral-fg + inset ring` → `bg-surface + text-accent` 无 ring（直接搬旧文件 `:161`）
- [ ] `:276` 内容列 `margin: 0 auto` → `margin: 0`（与 anno「mx-0 左对齐」一致）
- [ ] §1 anno `:631` 与 spec-desc 同步改全屏表述
- [ ] **删除旧 `v6-spec-settings.html`**（结构正确性已吸收进新 shell，控件范式过时会误导——按审查建议不留归档）
- [ ] 验收：shell spec 全文无 scrim/blur/900px/inset ring 残留

### 任务 1.2 — drawer spec 内部一致性（D3 同步）
- [ ] §9 移除 tasks 声明保留（符合 D3），但**消除 mock 矛盾**：
  - `:755` §1 mock 的 tasks icon 删除
  - `:815` anno「icon-only 8 个…tasks」改为 7 个（terminal/browser/git/doc/detail/subagent/workflow）
  - `:1995` §9 mock 的 tasks icon（on 态）删除或改为「已移除」灰显
  - `:684` doc-sub「5 个一级 tab」与 `:732` 注释「6 个」统一为 7 个
- [ ] browser 二级 tab（`:1509` 离群点）：按 D2+design 决策，anno 改为「多页面 tab（已授权，plugin/view 体系）」与矩阵 `:874`、mock `:1340-1347` 对齐
- [ ] GitPanel MVP 三功能（per-file stage / BranchSelect / CreateBranch）：保留但 anno 标注「产品功能决策，待 PRD 追认」（或按 D4 思路进决策表）
- [ ] 验收：drawer spec 内部 tab 计数、tasks 去留、browser 二级 tab 三处表述统一

### 任务 1.3 — shell spec §7 一体化重做（D2）
- [ ] §7 drawer 一体化方案保留（符合 D2），但**按 §3.4 重做消除 border**：
  - `.wf-drawer-inline` `:480` border-left 删除
  - header `:488` border-bottom 删除，改 bg-surface-2 浮起
  - `.dd-drawer` `:545` border-left 删除
  - `.dd-main-header` `:522` border-bottom 删除
- [ ] §1 `:680` drawer 表述与 §7 统一（一体化，阶段 0.1 已改 design，此处 spec 跟齐）
- [ ] traffic-light 方案 E（折叠态位移 `:854/:1060/:1105/:1138`）：**删除**——mac OS 绘制的红黄绿无法随折叠移动，技术上不可行（AGENTS.md #11 硬约束）
- [ ] 方案 A/G：保留但回写 design 决策表（阶段 0 未含，补到 §1.3）
- [ ] 验收：§7 全文无 border-l/border-b，§1 与 §7 drawer 表述一致

### 任务 1.4 — v6-demo 决策同步（否则不配做验收 SSOT）
- [ ] `:684` 默认态 `data-color="calm" data-density="lean"` → `semantic` + `legacy`（决策 #8/#9 目标态）
- [ ] `:582` 修 CSS 语法错误（`padding: var(--space-3) var(--space-4)`）
- [ ] 删 Overview 视图与侧栏入口（`§4.4` 已 DEPRECATED）
- [ ] settings 改全屏覆盖（与 D1 一致）
- [ ] 对齐 shell 稿值：traffic top 18→26（`:168`）、app-shell gap 8→12（`:154`）、radius 12→10（`:155`）、main-panel 补 border+shadow
- [ ] 清 AI slop：terminal #000→bg-input（`:560`）、avatar/logo 渐变→纯色（`:174/:265`）、group header 去 uppercase（`:229/:636`）、todo-verify 8px→9px 去 bg（`:557`）
- [ ] 验收：demo 首屏 == design 目标态

---

## 阶段 2：对话流四文件根治（复制漂移 + 三处冲突）

> 依赖：阶段 0。目标：消除 7 处复制漂移，裁决 3 处 spec↔design 冲突。
> **前置必做**：抽共享 base CSS，否则修一处漏三处。

### 任务 2.1 — 抽共享 base CSS（最高优先）
- [ ] 新建共享 CSS（`<link>` 或 build 注入），含四文件复制的 ~450 行产品 CSS
- [ ] 四文件（container/blocks/content/input）只保留各节独有样式
- [ ] 消除 7 处漂移：QueueBubble 内嵌化、ChangeSetCard badge、md-codeblock head、md 表格、RetryIndicator 删除、CommandPopover 单行、pulse 时长
- [ ] 清死 CSS：subagent/workflow `.sa-task-preview`/`.sa-bgstatus`/`.wf-action`、旧 `.retry-v6`、旧 `.qb-v6`
- [ ] 清残留引用：blocks 两套复制按钮并一、content `:982` 断裂注释、content `:1004` 过时 §10 引用
- [ ] 验收：四文件 grep 漂移点零命中

### 任务 2.2 — 裁决 3 处 spec↔design 冲突
- [ ] **TurnMeta hr**：design §4.1 明写删 → spec §3 `:967/970`「决策待定」改为「已删」，sticky 演示 `:1100-1108` 删 hr 渲染
- [ ] **ChangeSetCard badge**：blocks `:194` rounded-sm 5 态 vs 其余三文件 999px 3 态 → 统一为一版（建议对齐真实代码 ChangeSetCard.vue:22 的 rounded-sm），回写 design §4.1「胶囊 accent-soft」条文
- [ ] **PanelHeader status icon**：design §4.1「灰阶化」→ spec CSS `:135-138` 删 `s-running=accent`，running 改 neutral-ico；spec desc `:898` 与 CSS 对齐
- [ ] git M badge 色：design #8「M 黄」vs spec info 蓝 → 裁决（建议保留 git 语义色 M 黄，回写 spec）
- [ ] 验收：3 处冲突各自只在单一文档出现一种说法

### 任务 2.3 — TurnRail 重评估（范围扩张项）
- [ ] 评估 TurnRail（§3.5）是否保留：与滚动条语义重复、fixed h-340px 魔数、active 节点违反 §3.2、indicator 2px border-l 踩禁令
- [ ] 若保留：active 节点改 §3.2 范式（bg-surface+蓝字）、indicator 去 border-l-2、按 turn 数阈值显示
- [ ] 若删除：移除 §3.5 全部
- [ ] **先回写 design §4.1** 登记 TurnRail 决策（当前 design 未列此元素）

### 任务 2.4 — goal/todo 回归对话流（D3 落地到 blocks spec）
- [ ] blocks §12「goal/todo 回归对话流」保留（符合 D3），但 `.gt-goal-card` `:471-473` 去 border+bg 改 bg-surface（与 design §4.3「GoalCard 去 border」一致）
- [ ] 确认依赖 design 阶段 0.2 已声明移除 tasks

### 任务 2.5 — 浮层归一 + 细节修正
- [ ] popover 圆角 8→12px（`§3.5`）、z-[1100] 归语义 scale（新增 `--z-top` 或并入 modal 档）、shadow 用 `--shadow-2`
- [ ] 修 anno/CSS 失配：content mm-dialog 70%/92vh、blocks bn-fullcontent 120/200、input qb border /40·/60、container 瞬时浮层 border/50 vs border-strong
- [ ] uppercase 产品区全改 normal-case：`.tk-label`/`.sa-prefix`/`.wf-prefix`/`.model-group`/`.pop-head`/`.cap-stat .lbl`/`.gui-card-hd`
- [ ] loader svg stroke-width 1.7→1.75 统一

---

## 阶段 3：Settings 六文件统一（漂移值 + 缺口）

> 依赖：阶段 1.1（shell 重写）。目标：六个 settings spec 数值统一、缺口补齐。

### 任务 3.1 — 统一四漂移值
- [ ] 分组卡片圆角：shell `:302`/provider `:351` 8px → 10px（§4.5 基准）
- [ ] hairline：shell `:319`/provider `:375/423/446`/resources `:212`/extension `:190` 0.08 → 0.04（统一含组头）
- [ ] `.ui-input` 字号：provider `:225` 12px / resources `:162` 14px → 13px 统一；padding 统一 0 12px；dense 类名二选一（`.ui-input.dense`）；checkbox 态类二选一（`.checked`）
- [ ] ConfirmDialog 圆角：shell `:1379` 8px → 12px

### 任务 3.2 — SegmentedTab 三实现归一（§3.1）
- [ ] provider `.input-seg` `:413-419`：去 1px border、容器 8→12px、p-2→3px
- [ ] resources `.rp-tabs` `:263-271`：active surface-hover → bg-elevated
- [ ] extension `.seg-tabs` `:482-493`：容器 8→12px、内项 5px → var(--radius-sm) 6px
- [ ] 验收：三处 SegmentedTab 逐字符合 §3.1

### 任务 3.3 — 补缺口
- [ ] 补 SystemPage spec（或在 shell 增 §9）承载 i18n P0 五 key（soundTitle/successSound/errorSound/soundDefault/soundPreview）
- [ ] 修 shell nav 7 个死链（删链接或补页面）
- [ ] content 列宽：provider 放弃 720 是否追认 → 回写 design 或恢复消费

### 任务 3.4 — ProviderEdit 结构裁决
- [ ] design #14「嵌入式面板+返回」vs provider spec「展开就地编辑」二选一
- [ ] 若选展开编辑：回改 design #14 + v6-summary §6.4
- [ ] 若选嵌入式：改 provider spec `:342-346`

### 任务 3.5 — SelectTrigger 裁决
- [ ] design §4.5「去 border + bg-bg-input」（改 xyz-ui 组件本身）vs spec「复刻 xyz-ui 现状值」二选一
- [ ] 影响范围：shell `:399-406` + provider `:235-241`

### 任务 3.6 — 降噪收尾
- [ ] provider-card `:289-291` 去 border 改 bg-card（当前 bg+border 双重分隔 + 用画布色 --bg 凹陷方向）
- [ ] 状态类 pill 统一 999 胶囊（§3.5）：provider `.pill-default`/`.thinking-pill`/`.cv` 等 6 处
- [ ] resources 来源 badge 5 色 → 中性底 + 彩色小点（对齐决策 #8）
- [ ] nav icon 17→16px、extension `.seg-tab` 5→6px
- [ ] 定义「链接/行级 focus」裁决补进 shell §6（现只有控件两级）

---

## 阶段 4：侧栏/Drawer/Overlays/Plugin 降噪收尾

> 依赖：阶段 1.2/1.3。目标：选中态范式统一、规范违反清零。

### 任务 4.1 — 统一「选中」视觉语言（§3.1/§3.2 只统一一半）
- [ ] drawer 一级 icon tab active（`:210`）：accent-soft → bg-elevated 中性浮起
- [ ] drawer 二级 tab `.b-l2`（`:254`）：去 border-bottom
- [ ] `.wf-call.selected`（drawer `:621`）：accent-soft → bg-surface（§3.2）
- [ ] DetailPane toggle（`:276/292`）：p-2→3px；`.dt-btn.diff.on`（`:294`）accent-soft → bg-elevated
- [ ] AskUserOverlay `.au-tab.active`/`.au-opt.sel`（overlays `:282/299`）：accent-soft → 中性浮起（或登记例外）
- [ ] plugin 第 5 tab `.plugin-primary.active`（`:447`）：accent-soft → bg-elevated
- [ ] SearchModal `.sm-item.sel`（overlays `:243`）：surface-hover → bg-surface+蓝字（或登记「popover 键盘选中例外」）——当前 sel 与 hover `:242` 同色，键盘导航不可见
- [ ] 验收：产品内「被选中」只有一种视觉语言（除登记例外）

### 任务 4.2 — Splitter + 投影
- [ ] Splitter CSS（drawer `:176-181`）：默认真透明（去 `::before` border 竖线），hover/drag 显 accent（与文档一致）
- [ ] drawer 投影：若 D2 一体化已去投影则跳过；若保留独立投影则强度可降到 `rgba(0,0,0,.15-.18)`

### 任务 4.3 — 规范违反清零
- [ ] 圆角升档例外：`.tr-git` 硬编码 3px → 6px、`.fg-pill`/`.tr-dirbadge` 的 `--radius-sm-old` → `--radius-sm`、`.tt-close` 3px → 6px
- [ ] 状态点统一 7px：`.sa-dot`/`.wf-dot` 8px、`.wf-status` 9px → 7px（§3.3）
- [ ] uppercase 产品区：`.gc-badge`/`.ts-verify`/`.gp-po-head` 去 uppercase
- [ ] emoji：drawer `:1976` ⚠ → TriangleAlert SVG；max-demo `:797` ⚠ → SVG
- [ ] max-demo 头像 `:144` 渐变 → 纯色 bg-accent
- [ ] max-demo M6 灰化（drawer 暂不开放 plugin tab，全景却点亮 `:692`）；M15 去 emoji 补 SVG
- [ ] 静态容器 bg+border 双重分隔：`.b-l2`/`.cd-source`/`.provider-card`/`.sa-readonly-hint` 去 border
- [ ] 硬编码色：`.gc-resume #1a1b1f` → var(--bg)、`.pop-v6` shadow → --shadow-2、inline error border → token

### 任务 4.4 — plugin spec 硬伤修复
- [ ] §2 desc `:770` M8 陈旧描述「跨全宽」→「main-panel 局部」
- [ ] `.dc-btn primary`（`:1384`）未定义 → 改 `.dc-btn default`（max-demo `:801` 同修）
- [ ] §9.4 闭环计数（`:1962/1964/1987`）：统一为 5 个完整闭环（M4/M5/M7/M8/M11），M15 已降级不计
- [ ] C1/C2 companion demo（`:1375/1404`）：替换为 overlays 稿真实范式（bg-input/12px/无边），别「声称对齐却画错」
- [ ] SegmentedTab 圆角 `:218/351`：8px → 与 sidebar 12px 对齐（或全局裁决 8px 并回改 design §3.1）
- [ ] note-box 3px 彩条（`:466/567`）→ bg-soft 整块 + icon（自我实践禁令）

### 任务 4.5 — demo 文件标注
- [ ] `v6-drawer-tabs-demo.html` 头部加 SUPERSEDED 横幅（形态 B 已选定，头部还在问「你倾向哪种」误导后来者）
- [ ] `v6-plugin-max-demo.html` 文档头注明「缩放 mockup 不承载组件级 CSS 范式」

---

## 阶段 5：v6-summary.md 修正 + 验收

> 依赖：以上阶段。目标：summary 自身错误修正，整体一致性验收。

### 任务 5.1 — summary 自身错误
- [ ] `:99` `--accent-ring: 0.5` → `0.30`（与 tokens SSOT + style.css:44 一致）
- [ ] drawer 模型表述：按 D2 一体化更新 §6.3
- [ ] tasks tab：按 D3 移除更新 §6.3 drawer tab 计数
- [ ] 设置形态：确认 §6.4 全屏表述（已正确，无需改）
- [ ] plugin：按 D4 补 §6.6 架构授权说明
- [ ] `.btn svg 16×16`：确认 shell spec 是否有此规则（核实发现 shell `.btn` `:338-347` 缺，需补或修 summary `:148`）

### 任务 5.2 — 整体验收
- [ ] 跨 spec 一致性扫描：grep 关键 token 值（accent-ring 0.30 / radius-sm 6 / hairline 0.04 / card 10px）在所有 spec 一致
- [ ] 设计决策反查：v6-design 每条决策在对应 spec 都有唯一一致的说法
- [ ] impeccable AI slop 扫描：uppercase/emoji/渐变/彩色侧边条/嵌套卡片 零残留（产品 UI 区）
- [ ] 对比度：正文位置全部过 WCAG AA
- [ ] 「面上面」修复验证：demo 的 TurnMeta pill / exit 标签 / ChangeSetCard 在 surface 主面板上肉眼可见（升一档 bg-elevated/surface-2）

---

## 3. 依赖图与并行度

```
阶段 0（SSOT 修订）─────────────────────┐
  0.1 drawer   0.2 tasks   0.3 plugin   0.4 小修
  （四任务可并行，都是改 v6-design.md，注意 merge 冲突）
                                        │
阶段 1（结构性修复）─────────────────────┤
  1.1 settings 重写（依赖 0）            │
  1.2 drawer 一致性（依赖 0.2）          │
  1.3 shell §7 重做（依赖 0.1）          │
  1.4 demo 同步（依赖 0）                │
  （1.1-1.4 可并行，不同文件）           │
                                        │
阶段 2（对话流根治）─────────────────────┤
  2.1 抽 base CSS（最高优先，阻塞 2.2-2.5）│
  2.2 裁决三冲突（依赖 0 + 2.1）         │
  2.3-2.5（依赖 2.1）                    │
                                        │
阶段 3（Settings 统一）──────────────────┤
  3.1-3.2（依赖 1.1）                    │
  3.3-3.6（可并行）                      │
                                        │
阶段 4（降噪收尾）───────────────────────┤
  4.1 选中态统一（依赖 1.2/1.3）         │
  4.2-4.5（可并行）                      │
                                        │
阶段 5（summary + 验收）─────────────────┘
  依赖以上全部
```

**建议执行顺序**：0 → 1.1+1.4（settings/demo 最高优先，是验收 SSOT）→ 2.1（抽 base CSS 阻塞对话流）→ 1.2+1.3 → 其余并行收尾 → 5。

---

## 4. 不在本计划范围（审查标"待人工确认"的非阻塞项）

以下审查意见属"待确认"或低优先，未排入计划，实施时按需处理：

- TurnRail viewport indicator 2px 边条是否豁免 impeccable（任务 2.3 一并评估）
- BgNotifyCard border 是否为「系统级通知」合理例外
- composer focus 3px 外环 vs summary「inset 单环」（两处裁决冲突，建议对齐真实代码）
- `.ph-status` 13/15px、send-slot 15px 与 §5.3 scale 出入
- thinking expanded body 用 dim 处于 WCAG AA 边界
- spec 文档 chrome 的 uppercase/彩条是否豁免 impeccable 禁令（建议严于律己一并改）
- SelectTrigger 是否改 xyz-ui 组件本身（任务 3.5 裁决）
- ProviderEdit 展开编辑 vs 嵌入式（任务 3.4 裁决）

---

## 5. 工作量估算

| 阶段 | 任务数 | 性质 | 估时 |
|------|--------|------|------|
| 0 SSOT 修订 | 4 | 文档改 | 0.5 天 |
| 1 结构性修复 | 4 | spec 重写 | 1.5 天 |
| 2 对话流根治 | 5 | CSS 重构 + 裁决 | 2 天 |
| 3 Settings 统一 | 6 | 数值对齐 + 补缺口 | 1.5 天 |
| 4 降噪收尾 | 5 | 规范违反清零 | 1.5 天 |
| 5 summary + 验收 | 2 | 收尾 | 0.5 天 |
| **合计** | **26** | | **~7.5 天** |

可由 subagent 并行加速：阶段 0 四任务并行、阶段 1 四任务并行（不同文件）、阶段 3/4 多任务并行。串行关键路径（0 → 1.1 → 2.1 → 5）约 3 天。
