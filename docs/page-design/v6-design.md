# v6 视觉与架构设计规范（2026-07）

> 日期：2026-07-30
> 状态：定稿（决策已确认，待架构重构后实施视觉层）
> 关联 demo：[`v6-demo.html`](./archive/v6-demo.html)（综合交互 demo，已归档）
> 取代：visual-modernization-2026-07.md（已合并进本文档，见 design-evolution.md）
> 性质：**全面重新设计**。落在视觉语言层（架构/色相/字体保留），授权大刀阔斧重构。

---

## 0. 设计哲学

**一句话**：冷蓝暗色不变，shell 三栏不变，对标 Codex/Claude/Linear 的极简专业——「层级代替边框、圆角升档、正文提亮、内容收窄、彩色降噪」五原则更彻底地应用到全部页面。

与 visual-modernization 的关系：**承继五原则为基，更彻底地应用**。五原则是 Codex/Claude/Linear 竞品分析的共同方向，没理由推翻；v6 把覆盖从「对话流+设置 40%」扩展到全页面，并融合 impeccable 禁令（禁 >1px 彩色侧边条）。

**执行时序**：阶段 0（测试基础设施）→ 阶段 A（整体架构重构）→ 阶段 B（renderer 局部重构）→ 阶段 C（v6 视觉层）。详见 §8。

---

## 1. 已确认决策（不可变）

### 1.1 全局方向

| # | 决策 | 取值 |
|---|------|------|
| 1 | 范围 | 全面重新设计，落在视觉语言层 |
| 2 | 架构 | 保留 shell 三栏拓扑（aside/main/drawer + traffic-light 安全区） |
| 3 | 色相 | 保留冷蓝暗色（`--bg #1a1b1f` / `--accent #4f8ef7`） |
| 4 | 字体 | 保留 Inter（正文）+ JetBrains Mono（等宽） |
| 5 | 风格 | 极简专业，对标 Codex/Claude/Linear |
| 6 | 五原则口径 | 以五原则为基，更彻底地应用 |
| 15 | plugin 渲染体系扩展授权 | M1 侧栏第 5 tab / M8 main-panel 底栏 + StatusBarController / M11 companion-band 统一交互出口 / M15 降级仅致命错误 / C1-C3 companion/overlay 窗口化 / §9 ExtensionHost 层 + commands.register/views.update API 缺口，属 renderer-target-architecture 路线，与 v6 视觉层并列推进 |
| 16 | GitPanel 三功能 MVP 授权 | per-file stage/unstage toggle / BranchSelectPopover 分支切换 / CreateBranchModal 新建分支 / commit 快捷键 Cmd+Enter，零后端改动的纯前端能力，属 v6 范围 |

### 1.2 视觉决策（demo 验证后确认）

| # | 决策点 | 取值 | 含义 |
|---|--------|------|------|
| 7 | 选中态范式 | **bg 实色 + 蓝字** | `bg-surface` 实色块 + `text-accent`，无 ring 无左条。最贴近 Claude/Linear |
| 8 | 彩色降噪 | **保留语义但缩小** | git M黄（注：M 色对齐代码 info 蓝，非 warn 黄）/A绿/D红 等语义彩色保留，但从色块/pill 降级为极小圆点或单字 |
| 9 | 信息密度 | **现状** | meta（turn meta/工具参数/subagent 摘要）保持可见，不改密度 |
| 10 | 背景层次 | **三层明度** | stage 深底(#131316) → 侧栏=画布色(--bg) → **main+drawer 共享 surface 浮起**。不嵌套第四层 |

### 1.3 结构决策

| # | 决策点 | 取值 |
|---|--------|------|
| 11 | 对话流列宽 | **整 turn 居中 720px**，UserBubble 在列内右浮窄气泡（对齐 mixer/demo 实现） |
| 12 | files 紧凑 | 缩进 `INDENT_STEP` 14→10px，icon-文字 gap 6→4px |
| 13 | 设置形态 | **全屏覆盖**（非居中 modal），左右分栏（左 nav tab 菜单，右内容左对齐 + max-width 720px） |
| 14 | 设置改造 | **彻底重构**：新建 `FullSettingsOverlay`（不用 reka Dialog，类似 SearchModal 手写 inset-0）；ProviderEditModal 改展开就地编辑（手风琴）（点编辑→卡片下方展开，不再双层 modal） |
| 15 | sidebar 第 5 tab | plugin tab 授权新增（突破决策 #2 的 4 tab 拓扑，仅 plugin tab 例外） |

---

## 2. Token 变更（反写到 style.css / design-tokens.md / tailwind.config.ts）

### 2.1 圆角修订

| Token | 现值 | v6 值 | 影响 |
|-------|------|-------|------|
| `--radius-sm` | `3px` | `6px` | kbd/tag/小按钮/chip 全局默认档升档。148 处 `rounded-sm` 消费点自动跟随 |
| `--radius` | `8px` | 不变 | 按钮/卡片 |
| `--radius-lg` | `12px` | 不变 | 面板/弹层/composer |

`tailwind.config.ts` `borderRadius.sm` 同步 `3px→6px`。

### 2.2 文字灰度修订一档

| Token | 现值（暗） | v6 值（暗） | 备注 |
|-------|-----------|------------|------|
| `--neutral-dim` | `#6b7280` | `#7d8494` | 提亮一档（对比度只升不降，WCAG AA 仍满足），配合「使用面积减少」消除灰蒙蒙感 |

亮色 `--neutral-dim`（现 `#8a8a95`）**同步提亮一档**保持主题一致（v6 新增决定，visual-modernization 未提亮色）。

`--neutral-fg`/`--neutral-mid`/`--neutral-faint`/`--neutral-ico*` 不变。

### 2.3 diff 着色柔化

| Tailwind 派生色 | 现值 | v6 值 |
|----------------|------|-------|
| `diff-add-bg` / `diff-del-bg` | color-mix 18% | **12%** |
| `diff-add-strong` / `diff-del-strong` | 45% | 不变（字符级精度保留辨识度） |

### 2.4 新增 token

| Token | 值（暗） | 用途 |
|-------|---------|------|
| `--content-max-w` | `720px` | 对话流 assistant 内容列宽 + 设置内容列宽 + Composer 非 landing 对齐同列 |
| `--bg-sunken` | `var(--bg)` | 侧栏/drawer 画布色（**不往黑推**，与画布同色融合，靠主面板 surface 浮起分隔） |
| `--bg-card` | `#22242c` | 设置分组卡片（介于 bg 与 surface 之间，解决现状 `bg-bg` 卡片无层级问题） |

> `--bg-sunken` 的语义变更：原 visual-modernization 用 `color-mix(bg 97%, black)` 把侧栏往黑推，导致比画布还暗、发脏。v6 改为与画布同色，靠 stage 深底(#131316) + 主面板 surface(#272830) 浮起表达三层明度。

---

## 3. 组件范式（跨视图统一）

### 3.1 SegmentedTab 新范式（侧栏/DetailPane 复用；tab 型选中态通用规则）

```
外层容器: bg-bg-input rounded-lg p-[3px]（rounded-lg = 12px，非 8px）
内项: 无边框
active: bg-bg-elevated text-neutral-fg, 6px 圆角
hover: text-neutral-fg
```

去所有 tab 的独立边框盒，active 用中性浮起（去 accent-soft 蓝染底）。

### 3.2 选中态范式（Card-Active）

- **列表项激活**（SessionItem/SessionCard/SettingsModal nav）：`bg-surface` 实色块 + `text-accent` 蓝字，**无 ring 无左条**
- **面板激活**（Panel active）：维持 inset accent-ring
- impeccable 禁令落实：禁止 >1px 彩色侧边条做选中强调

### 3.3 状态指示统一

- **会话/任务状态**：7px 圆点替换 15px 饱和图标（统一 7px，含 fg-dot / seg-badge / au-tab-dot / rp-badge 等所有状态点/内联标记，无 4/5/6px 例外）。done=success(90% opacity) / running=accent / waiting=warn / error=danger
- **工具失败（exit≠0）**：图标统一 `--neutral-ico`（删 warn 着色），行尾加 mono `exit N` 小标签（中性，非 danger）
- **彩色边界**（保留语义但缩小）：
  - 保留彩色：真失败块 danger、待行动状态 accent、git 语义色 M黄/A绿/D红（降为极小圆点或单字 badge）
  - 降中性：workflow 进度条 done 态、GoalCard badge、±stats 降单色、目录改动数徽章

### 3.4 分隔策略（层级 > 留白 > hairline > 边框）

- 静态信息容器只用一个表面色（`--surface`/`--bg-input`/`--bg-card`），**不叠加 border**
- border 仅保留给：浮起可交互容器（popover/dialog/composer）和 focus 态
- drawer 内 header 分隔：header 同 `surface` 底色 + 底部 `hairline`（rgba(255,255,255,0.04)）分隔（方案 G：暗色下 surface-2 浮起不可见，改 hairline 分层；DetailPane/CommandDocPanel/GitPanel/TerminalView/BrowserPane 统一）
- 侧栏与主面板间：去硬 border，靠三层明度（stage 深底 + 主面板 surface 浮起）+ SplitterResizeHandle 透明化。**drawer 与 main 间靠弱投影 0.16 + 同色体分隔**（非 border）

### 3.5 圆角档位

- 默认档：6px（`--radius-sm` 升档后）
- 卡片：8-10px（ChangeSetCard 10px 用任意值）
- 浮层/composer：12px
- popover 圆角 12px（非 8px）
- 徽章/pill/状态标签：999px 胶囊
- kbd：6px（保留小圆角矩形语义）
- tt-close 关闭按钮保留 3px 例外（图标按钮锐利感），其余 radius-sm-old 全删升 6px

### 3.6 文档 chrome 规范（D7）

spec 文档自身的标注元素（state-tag / anno 彩条 / 表头 th）**同样遵守 impeccable 禁令**：uppercase tracking-wider → normal-case；彩色侧边条注释框 → bg-soft 整块 + icon。不豁免。

### 3.7 选中态判定规则（D8）

- **tab 型**（SegmentedTab / drawer l1-l2 tab / AskUserOverlay au-tab / plugin seg-tab / **plugin 第 5 tab**）= §3.1 `bg-bg-elevated text-neutral-fg`（中性浮起，去 accent-soft 蓝染底；plugin 第 5 tab 不用 accent 身份色，统一中性）
- **列表项型**（SessionItem / FileTree / SearchModal sm-item / AskUserOverlay au-opt / wf-call / CommandPopover 项）= §3.2 `bg-surface + text-accent`（蓝字）
- accent-soft 仅留瞬时高亮（fresh / is-current popover 项）

### 3.8 行级 focus 裁决（R25）

链接/行级可点元素（非 Button/Switch/Checkbox/Input）focus = `inset 0 0 0 1px var(--accent-ring)`（与 Input 一致的单环）。Button/Switch/Checkbox 维持 accent 双环。

---

## 4. 分区设计（逐视图：v6 方案）

### 4.1 对话流（assistant 居中 720）

| 组件 | v6 方案 |
|------|---------|
| MessageStream | assistant 区（TurnMeta+trace+summary+ChangeSet）套 `mx-auto max-w-[var(--content-max-w)]`；UserBubble 保持右浮窄气泡（max-w-76%）；滚动条贴右缘 |
| TurnMeta | pill 默认可见（密度=现状）；删 turn 间 `hr border-border` 分隔线，改加大 turn gap 做层级；sticky 底色绑定内容列背景；**重试中态**：RetryIndicator 从 composer 移除，重试期间 TurnMeta label 切「重试中 N/M」+ warn 色 spinner（区别 streaming 的 accent）。详见 v6-spec-container.html §3 |
| TurnMeta pill | bg-bg-elevated（主面板 surface 上浮起一档，解决"面上面"不可见；bg-elevated 比 surface-2 浮起更明确） |
| Block·thinking | 收起态预览提亮 `text-neutral-mid`（过 AA）；**行数维持 1 行 ellipsis**（60 字符截断，推翻原「显 2 行」决策——2 行破坏 turn 视觉节奏）；**展开态正文用 neutral-mid**（过 AA，非 dim） |
| Block·bash | **区分两类来源**：① BashOutputBlock（composer `!` 前缀执行，独立系统消息，不可折叠，exit 标签：0→success/N→warn/timeout→dim）② tool-bash（agent 调用，嵌 §6 tool 块，可折叠，border 容器）。详见 v6-spec-blocks.html §5 |
| Block·tool | 状态矩阵：collapsed/expanded × running(双环 loader)/done/failed/unfinished。**failed 统一不切 icon**（保留原 tool icon，与 subagent/workflow 一致，靠 toolName 降 `neutral-mid` 表达，无红框）；exit≠0 加 mono `exit N` 中性标签；unfinished「未结束」标签 |
| Block·subagent | background 异步。**v6：collapsed only（去 expanded）**，只显 `[Bot] subagent agent · slug (model · thinking X)`，点击 → drawer 打开 subagent tab 展示嵌套只读对话流（详见 v6-spec-drawer §10）。failed 不切 icon（Bot + neutral-mid）。完成通知由 §10.5 BgNotifyCard 承载 |
| Block·workflow | **v6：collapsed only（去 expanded）**，只显 `[Workflow] workflow name · slug`，点击 → drawer 打开 workflow tab 展示 agent call 列表（复用 WorkflowDetail phase 分组，点 agent call 切 subagent tab，详见 v6-spec-drawer §11）。failed 不切 icon（Workflow + neutral-mid）。GUI 渲染迁 drawer/extension |
| Block icon | **v6 全更新**：thinking=Brain / tool-bash=SquareTerminal / tool 通用兜底=SquareFunction / subagent=Bot / workflow=Workflow。stroke-width 统一 1.75。size：block header 14px 统一。展开态统一复制按钮（icon 下、与文字水平对齐、hover 显、复制全部、Check 反馈）。详见 v6-spec-blocks.html |
| assistant 正文 markdown | `<p>` 恢复段间距 0.5em；h3 提档 1.12em 区分 h4；代码块容器 `bg-input` token 化；行内 code bg 统一 `bg-input`。**表格圆角化**（rounded-lg + thead surface-2 底 + 行间细 border）；blockquote 不动。**内容容器 head 统一**（代码块/mermaid/bash/ChangeSetCard）：轻量 head 栏 h-7 + 半透明背景优化 + 复制按钮右侧统一 + mermaid 按钮右侧归拢。**TurnSummary hover actions 方案 A**：3 扁平 icon button（Copy/GitFork/HandHelping），去 split-button 和 MD/+Q badge；fork/handoff 点击=+Q 带提问变体，composer 直接 enter=无内容变体。详见 v6-spec-content.html §12/§12.5/§12.6 |
| 动画 | 状态指示（双环 loader 1.4s / 单环 spinner 1s / 脉冲点 1.8s / blink 1s）+ 微交互（hover/折叠 `duration-fast` 120ms，focus `duration` 200ms，easing `--ease`）。reduced-motion 全局兜底。大动效后出 |
| ChangeSetCard | 去 border，`bg-surface` + 10px 圆角；状态 badge 保留 5 态彩色（accumulating/ready/partially-reviewed/resolved/superseded，贴代码 ChangeSetCard.vue:22，rounded-sm 非胶囊）——git/审查流程的状态语义色信息密度高，与 git M/A/D badge 同语义体系，彩色降噪不吞功能性状态色 |
| UserBubble | 删 `border-border-strong`，仅 `bg-surface-hover` 做层级；保持 14px/4px 不对称圆角；**删 pending 态**（排队消息不再进对话流渲染，迁 QueueBubble）；**skill/file badge 与 composer chip 同风格**（纯文字+前缀 icon+无底无边+加粗，skill=Wand紫无斜杠 / file=FileText绿） |
| QueueBubble | **v6 内嵌 composer-box 顶部**（不再独立卡片）：去独立 border/bg/收起，仅 `border-b` 分隔融入 bg-input；**去脉冲闪烁**，保留 Zap(steer/accent)/Clock(followup/info) icon + truncate 文本，多条显前 2-3 条 +「+N」。详见 v6-spec-input.html §8.5 |
| Composer | **6 区构成**（RetryIndicator 已移除→迁 TurnMeta）：QueueBubble(内嵌) / staging chip / ContextChipsBar(仅 image) / landing meta-row / Input / composer-bar。**chip 统一风格**：纯文字+前缀 icon+无底无边+文字加粗（skill=Wand紫 / file=FileText绿 / image=Image紫 / @=AtSign蓝）。**CommandPopover**：单行布局（icon+粗体名+·隔开+desc，file 也单行），width=composer，14 命令各配专属 icon（详见 v6-spec-input.html §9H 命令 icon 表）。staging fork/handoff 互斥。发送位 4 态状态机。详见 v6-spec-input.html §9 |
| Composer focus | composer-box focus = 3px 外环 `box-shadow: 0 0 0 3px var(--accent-ring)`（对齐代码，非 inset 单环） |
| PanelHeader | 去 `border-b`，用 bg-elevated 浮起分层；status icon 灰阶化，仅 git 点保留 danger/warn |
| TurnRail（§3.5）| 保留既有组件。active 用 §3.2 范式（bg-surface+蓝字 无 ring）；viewport indicator 用 accent 短粗线（非 border-l-2，避 impeccable 禁令）；高度=turn 数×行高（renderer 实现，spec 画 1/5/20 turn 变体示意，无固定上限）。属阶段 B/C 衔接。 |
| BgNotifyCard | 系统级通知（subagent 完成/fork/compact），保留 border 作为原则 #1 例外（需与普通消息块视觉区分）。 |

### 4.2 侧栏（5 tab + 容器，第 5 tab 为 plugin）

| 组件 | v6 方案 |
|------|---------|
| Sidebar 容器 | 底色 `bg-bg`（画布色，= `--bg-sunken` 新值），与主面板靠 surface 浮起分隔 |
| SegmentedTab | 见 §3.1 新范式 |
| SessionItem | 状态 14px 图标→7px 圆点；选中态见 §3.2（bg+蓝字）；hover 操作按钮去方框改 ghost icon 无框 |
| SessionList 组标题 | 去 uppercase tracking（AI slop tell），改 normal-case `text-[11px] font-medium` |
| ForkGroup | 去 border+accent/5 染底（嵌套卡片），改缩进+折叠头 accent 文字；「分支 N」pill 降 `text-neutral-dim` 无底 |
| FileView/FileTreeRow | **缩进 14→10px**，icon-文字 **gap 6→4px**；git badge 保留语义色但缩小；目录改动数徽章降中性；branch 文本降 `text-neutral-mid`（去 accent） |
| SubagentList | 卡片 py 统一 6px；cancel 确认态去 border 仅 bg-danger |
| WorkflowList | 进度条仅 running 用 accent，done 改 bg-neutral-dim；abort 确认态去 border |
| 底部用户区 | 头像渐变改纯色 bg-accent（去装饰渐变） |

### 4.3 右侧 Drawer（7 tab）

| 组件 | v6 方案 |
|------|---------|
| SideDrawer 容器 | 与 main 共享同一 surface 浮起体（底色同为 `--surface`），从 main 右缘生长挤占 main 宽度；**保留弱投影 `shadow: -12px 0 24px rgba(0,0,0,0.16)` 做视觉分隔**；去 border-l 硬分隔；SplitterResizeHandle 透明化（仅 hover/drag 显 accent）。v6 调整：移除 tasks tab（goal/todo 回归对话流，见下），新增 subagent（Bot icon）+ workflow（Workflow icon），共 7 个一级 tab |
| **二级 tab 架构** | 形态 B：icon 一级 + 内层二级（按需出现）。**每个一级 tab 是独立页面，二级 tab 由各 tab 组件自行定制**（drawer 框架不统一管二级）。详见下方二级 tab 策略表 |
| DetailPane | header 同 surface 底 + hairline 分隔（方案 G）；**二级 tab：支持多文件 tab**（用户点文件→新开/切换 tab，可关闭），预览/变更 toggle 作为当前 tab 的视图切换。参考 `v6-drawer-tabs-demo.html` 形态 B |
| DiffView | 行背景 12%（token 自动生效）；canvas `bg-bg-input rounded-lg` + py-2 内距；hunk header 去 bg-surface-2 仅 text-neutral-dim；删 lineRowClass hunk 死代码分支 |
| TerminalView | 黑色底改 `bg-bg-input`（与画布同源凹陷语义，非纯黑割裂）；工具栏去 border-white/10 改 bg-bg-input 同色；**二级 tab：支持多实例 tab**（点 + 新开终端实例），二级 tab 栏放新增按钮（本期仅放按钮，新增功能后续实现） |
| BrowserPane | 三处 border-b 全去（guide/nav/login wall），靠各自 bg 分层；guide banner 改中性；登录墙 warn 收敛到单点 |
| GitPanel | pill 去 bg 改纯色文字 pill（语义靠字色）；**冲突态去 danger 左竖条**（impeccable side-stripe 禁令）改 bg-danger-soft 整块；badge 统一 text-neutral-dim 仅 U 保留 danger；**无二级 tab**（git 状态全局唯一） |
| CommandDocPanel | header 去 border-b；source 标签圆角升 6px 去 bg；元信息区去 border-t 改 mt-4 空白分层；无二级 tab |
| **SubagentTab**（新增） | 嵌套渲染该 subagent session 的**只读对话流**（MessageStream，无 composer/输入区——subagent 是 background 任务）。从对话流 subagent block 点击或 workflow tab 的 agent call 进入。标题栏显 agent·slug(model·thinking)，从 workflow 进入有 ← 返回按钮。详见 v6-spec-drawer.html §10 |
| **WorkflowTab**（新增） | 复用 WorkflowDetail 结构：phase 分组 + agent call 列表（状态点 + agent 名 + tokens/turns/duration 摘要）。点击 agent call → 切 subagent tab 展示对话流。标题栏显 scriptName·slug + pause/resume/abort 操作。详见 v6-spec-drawer.html §11 |

**二级 tab 策略表**（按需出现，各 tab 自治）：

| 一级 tab | 二级 tab | 多实例 | 新增按钮 | 说明 |
|----------|---------|--------|---------|------|
| detail | 多文件 tab | 是 | 否（文件从 git/文件树点开） | 点文件→新开/切换 tab，可关闭；预览/变更是当前 tab 的视图切换 |
| terminal | 多终端实例 | 是 | **是**（本期仅放按钮，功能后续） | 每个 tab 一个独立 PTY 实例 |
| browser | 单实例（暂） | 否 | 否 | 当前单 view + URL 替换；多 tab 作为后续扩展 |
| git | 无 | — | — | 全局唯一状态，无需二级 |
| doc | 无 | — | — | 单文档，无需二级 |
| subagent | 无 | 否 | 否 | 嵌套只读对话流（MessageStream 无 composer），单实例=当前选中 subagent |
| workflow | 无 | 否 | 否 | agent call 列表（phase 分组），点 agent call 切 subagent tab |

**架构含义**：当前 `useDetailPane.state` 是单例（`fileTreeStore.selectedPath` 单值驱动），要多文件 tab 需把单值改为按 tab id 索引的 map。terminal 同理需从 per-session 单 PTY 改为多 PTY 实例管理。这属于阶段 B（renderer 局部重构）/ 阶段 C（视觉层）的衔接点。

**tasks tab 移除决策**：tasks tab 移除，goal/todo 走 gui-protocol 统一渲染回归对话流；移除 HIDDEN_TOOL_NAMES 对 todo/goal_control 的特判（迁移影响见 v6-spec-blocks §12）。原 TasksPanel 的 GoalCard 视觉范式（去 border 仅 bg-surface）迁移至对话流 goal/todo 渲染。

**drawer 静默新增元素登记**：sd-unread 未读角标保留（accent pill + 计数）；主面板:drawer 默认宽度比 1:1，可拖拽调整（D2 一体化后 drawer 挤占 main）。**形态 B 数据模型重构**：detail 多文件 tab / terminal 多实例涉及 useDetailPane 单值→map、单 PTY→多 PTY 重构，属阶段 B renderer 局部重构，v6 spec 仅保留视觉态。

### 4.4 Overview（已移除）

> **DEPRECATED 2026-07-31**：Overview 概览页整体移除。有了左侧栏（sidebar sessions tab 列表），不再需要独立的概览/首页视图。MainPanel 的 view 路由简化为仅 chat（Workspace），去掉 overview 分支。原 `v6-spec-overview.html` 已删除。

### 4.5 设置页（全屏覆盖重构）

| 组件 | v6 方案 |
|------|---------|
| SettingsModal → FullSettingsOverlay | 新建，不用 reka Dialog，手写 `fixed inset-0`（类似 SearchModal）。无遮罩/无模糊（纯不透明全屏）。左 nav w-220px 固定 + 右内容滚动。ESC + 右上角 X 关闭 |
| nav | 底色 bg-sunken；选中态 bg-surface + 蓝字（§3.2）；count badge 去彩色改中性圆点 |
| 内容区 | 左对齐（mx-0）+ max-w-720px；页面标题作为左对齐内容块顶部（非固定栏）；**内容区底色 = `--bg`**（非 surface——bg-card 卡片才能浮起，surface 会让卡片下沉） |
| 10 个 *Page 分组卡片 | 去 border（双重分隔 AI slop），改 `bg-card` 层级 + 10px 圆角；行分隔 hairline 降 `rgba(255,255,255,.04)` |
| 设置行 | 每行 label 下加 12px `--neutral-mid` 描述文字（i18n 新增 `*.desc` keys；mid 过 AA，dim 仅装饰位） |
| ProviderEdit 手风琴展开 | 点编辑→卡片下方手风琴展开编辑区（取代双层 modal），适合密集表单 |
| 表单 label | 所有 uppercase tracking-wider 改大小写混合 font-medium |
| SelectTrigger | spec 画目标态：去 border + bg-bg-input + 圆角 8px（对齐本决策；真实 xyz-ui 组件改造留实施阶段，v6 不改 .vue 源码） |
| LoadPaths/SourceImportSection | 扁平化嵌套卡片为单列表；强制目录自绘 ✓ 改 Checkbox 原生组件 |

### 4.6 Overlays

| 组件 | v6 方案 |
|------|---------|
| SearchModal | 保持手写覆盖层（非 reka Dialog）；浮层圆角已 12px 合规；输入区去 border-b 靠 padding；分组 header 去 uppercase；高亮改 font-semibold 去彩色 |
| AskUserOverlay | 保持内联（非 modal）；tab/选项圆角统一 6px；context 降中性 bg-surface-hover（去 reasoning 软底彩色）；hover 的 `white/[0.04]` 改 `bg-surface-hover` token |
| ConfirmDialog | 圆角 12px（依赖 DialogContent）；danger 三角 icon 降 size-4；默认 cancel/confirm 文案改 i18n |
| MermaidRenderer | 保持现状（95vw 图像查看器，缩放动画合适） |

---

## 5. 横切清理

### 5.1 正文提亮（neutral-dim/faint 对比度）
- thinking 预览、bash 截断标记、meta 条属正文范畴，当前用 `neutral-dim`/`neutral-faint`（#6b7280/#4b5563，部分不过 AA）
- v6：正文位置统一提亮到 `neutral-mid`（#9ca3af，过 AA）；仅装饰/极弱位置保留 dim/faint

### 5.2 z-index 语义化
- 当前混用 `z-[1]`/`z-10`/`z-[1000]` 任意值
- v6：定义语义 scale `--z-sticky:1 / --z-popover:10 / --z-overlay:20 / --z-modal:1000`，逐处替换（映射：SearchModal/FullSettingsOverlay=z-modal 1000；AskUserOverlay=z-overlay 20；SideDrawer 与 main 同体不单列 z；**Toast 例外**：z-9999 固定值保留，跨 modal 层级在最顶层瞬时显示）

### 5.3 图标 size scale
- 当前 trace icon/badge icon/header icon 混用 10/12/13/14px
- v6：定义 scale（badge 10px / trace 12px / header 14px / 操作 16px）

### 5.4 i18n P0 修复
- 补齐 5 个缺失声音 key（soundTitle/successSound/errorSound/soundDefault/soundPreview，中英双语）
- ConfirmDialog 默认文案改 i18n

### 5.5 SSOT 链文档同步（D9）

v6 修订需同步：README.md（加 v6 章节+索引）、design-system.md（Card/Button/选中态原语同步 v6 §3）、visual-modernization-2026-07.md（标注被 v6-design 追认/修订）。详见 v6-fix-plan.md L1.7/L1.8/L5.5。

---

## 6. 架构重构（先整体后局部，先于视觉层）

> 用户授权全面重写，不考虑成本/兼容性。**审查方法纠正**：初版架构报告直接跳进 renderer 的 useChat/store 细节，是局部视角；重新从最顶层审查后，整体架构其实设计扎实，真正的问题在整体层。renderer 局部问题降级。

### 6.1 整体架构图（跨进程/跨包）

```
┌─────────────────────────── Electron App ───────────────────────────┐
│                                                                     │
│  MAIN PROCESS (Node)          PRELOAD (contextBridge)               │
│  apps/electron/main/           apps/electron/preload/               │
│   ├ WindowManager              window.electronAPI {40+ methods}     │
│   ├ ShortcutRegistry              │                                 │
│   ├ BrowserViewManager ◄──IPC─────┘                                 │
│   ├ ipc-handlers                                                   │
│   └ RuntimeSupervisor ──spawn runtime subprocess                   │
│                                                                     │
│  RENDERER (Chromium, Vue3) ◄────── WebSocket ──────►  RUNTIME (Node)│
│  packages/renderer/                                    packages/runtime│
│   ├ api/ (业务门面)            ClientMessage ◄──WS──► ServerMessage │
│   ├ composables/ (编排)                              ├ transport/    │
│   ├ stores/ (Pinia)                                  ├ services/     │
│   └ components/                                      └ infra/pi/     │
│                                                        │ stdin/stdout │
│                                                        ▼ JSONL RPC    │
│                                                  PI SUBPROCESS        │
│                                                  (AI agent CLI)       │
│                                                        │              │
│                                   services/plugin ──spawn Worker─────┤
│                                                       PLUGIN WORKER   │
│                                                                     │
│  数据隔离: ~/.xyz-agent/ (xyz-agent) ↔ ~/.pi/agent/ (系统 pi, 隔离) │
└─────────────────────────────────────────────────────────────────────┘

包依赖（pnpm workspace, 无循环）:
  shared (零上游) ◄── runtime ◄── electron(app)
                   ◄── renderer ──┘
  extension-protocol ◄── renderer + runtime（GUI 渲染协议类型）

四套通信机制（各有不可替代场景）:
  1. IPC (preload↔main): OS 特权/窗口/runtime 端口
  2. WebSocket (renderer↔runtime): 全部业务数据
  3. stdin/stdout JSONL RPC (runtime↔pi): prompt/abort/bash
  4. Worker postMessage RPC (runtime↔plugin): 插件隔离
```

**整体评价**：跨进程/跨包这一最顶层设计扎实、边界清晰、文档详尽。进程职责干净（main 是壳、runtime 是唯一 pi 适配点、renderer 不碰 Node API），包依赖单向无环，四套通信机制各有不可替代场景。问题集中在以下整体层。

### 6.2 整体架构问题（优先级最高）

| # | 整体问题 | 现状证据 | 重构方向 |
|---|---------|---------|---------|
| **整体-1** | runtime 三层契约名实不符：services 直连 infra（文档声称零直连） | 12 处 services 直连 infra（`session-service.ts` 连 5 个 infra、`migration/provider-importer.ts` 调 infra 写操作） | 纯路径/纯类型（pi-paths/pi-protocol）归"kernel"层合法依赖；有 pi 格式知识的模块收到 ports 接口后由 infra 实现注入；logger 构造函数注入。修正代码或修正文档使一致 |
| **整体-2** | shared 包职责膨胀：混入运行期实现 | shared/src/ 含 git-status-parser/migration/pi-preset/quota-presets 等运行期逻辑，非纯类型常量 | shared 只留 protocol/message/session/paths/constants 等纯类型+常量；Node-only 解析器下沉到 runtime infra 或新建 node-utils 包（仅 main+runtime 依赖），renderer 依赖图可证明无 Node 逻辑 |
| **整体-3** | IPC 边界过宽：混入业务持久化 + 命名错配 | electronAPI 40+ 方法含 writeSessionImage/writeSegmentsMetadata（业务持久化走 IPC 非 WS）、proxy 配置挂 update:* 通道 | IPC 收敛为纯 OS 特权；session 数据持久化迁到 runtime（WS 单一出口）；至少先修正 update:* 命名错配 |

### 6.3 renderer 局部问题（整体修完后处理）

> 这些是 renderer 内部的复杂度，不影响整体架构判断。之前误判为 P0，现降为局部。

| # | 局部问题 | 重构方向 |
|---|---------|---------|
| 局部-1 | useChat 模块级单例状态违反 ADR-0049（`useChat.ts:45,52,66-83` + 8 个同类 composable） | per-session 状态迁入 useChatStore 或 useSessionScopedState 工厂；删除 `reset*ModuleState` |
| 局部-2 | stores 间依赖契约被破坏（`chat-message-effects.ts:55,60` store 互相 import） | 抽独立事件消费层；store 回归纯职责 |
| 局部-3 | routeInbound 100 行巨型 if-else 路由器 | 改声明式路由表 |
| 局部-4 | Composer 被 16 个 composable 过度拆碎 | 按变化轴合并为 3 个（Input/Dispatch/Context） |
| 局部-5 | chat store 11 文件碎片化 | 流式消息状态机内聚为深模块；消除绕 lint 的 *Impl |
| 局部-6 | Sidebar 耦合 22 个 store/composable | 退化为纯布局容器，功能域抽子组件 |
| 局部-7 | settings/ 22 文件无分层 | 按域分子目录 |
| 局部-8 | ui/(shadcn-vue) 双名体系 | fork 改用 v3 原生命名 |
| 局部-9 | composables 分层不一致 | 统一规则：顶层只留基础设施 |

---

## 7. 测试规范（重写 TEST-STRATEGY.md + 补工程门）

> 现状盘点：505 文件 / ~4750 case / vitest 统一。最严重痛点——零 coverage + E2E 不进 CI（全绿无护栏）；大量测试断言内部调用而非用户可见行为；规范与实现脱节（规范说要测但实际没测，如对话流零 E2E）。

### 7.1 测试规范核心三条（能发现问题的测试，非大厂规范）

1. **测行为不测实现**：断言用户可见结果（DOM/文案/状态变化），不断言内部调用/mock spy/payload 形状。重构时测试红 = 可能真有 bug，而非"调用方式变了"。
2. **分层有明确职责不交叉**：单测测纯函数/纯逻辑（零外部依赖）、集成测组件树交互（mount 入口 + DOM 断言）、E2E 测真实用户旅程。禁止"放大版单测冒充集成"。
3. **有护栏门**：coverage 门槛 + E2E 进 CI。全绿必须有度量意义。

### 7.2 分层与断言标准

| 层 | 职责 | mock 程度 | 断言标准 | 进 CI |
|----|------|----------|---------|-------|
| **单测** | 纯函数/纯逻辑（转换器/parser/纯 store 逻辑） | 零 mock（真实 fs/tmpdir 可用） | 输入→输出 + 边界 | 是 |
| **集成** | 组件树交互、WS 协议链路 | mock pi，**真 WS**（runtime↔renderer 真协议） | mount 入口 + DOM 断言（每条至少一个用户可见断言） | 是 |
| **E2E mock 轨** | Vue 组件树真实渲染 | 不起 runtime（VITE_MOCK） | DOM 断言（明确标注非端到端） | 是 |
| **E2E real 轨** | 真实用户旅程（真 runtime+pi） | 真实 LLM 或受控 fixture | 每步 DOM 断言 | 是（独立慢 job） |

### 7.3 低价值测试处理

- **删了不重写**（用户决策）：断言内部调用/payload 形状的低价值测试（api/ 10 文件、断言 spy 的 composables）删除
- **删除时机**：随重构同步（重构到哪个模块，删该模块旧测试 + 写新行为测试，模块级原子化，无覆盖空窗）
- **合并重复**：跨包重复的纯函数测试（git-status-parser 在 shared+runtime 各一份）收敛到一处
- **保留高价值样本**：零 mock + 真实 fs 的测试（json-store/tasks/updater-script）作为新规范样板

### 7.4 护栏门（工程保障）

| 门 | 现状 | v6 要求 |
|----|------|---------|
| coverage | 零配置（装了没用） | 启用 `@vitest/coverage-v8`，设 line/branch 门槛（起步观察，逐步设阈值） |
| E2E 进 CI | 完全不在 CI | CI 加 E2E job（mock 轨快跑 + real 轨独立慢 job） |
| dev 冒烟闸门 | `dev-smoke.mjs` 标"待建"从未实现 | 补建（堵 mock 盲区，关键功能首屏渲染验证） |
| pre-commit | 只跑 eslint+vue-tsc 不跑测试 | 维持（测试在 CI/pre-push 而非 commit，避免开发卡顿） |

### 7.5 关键功能 E2E 补建（现状零覆盖）

- **对话流 chat-flow**：现状 `chat-flow.spec.ts` 不存在，核心功能零 E2E。补 testid + 写 spec
- **session 生命周期**：创建/切换/fork/重开/销毁全链路
- **设置持久化**：修改→重启→恢复（跨进程数据一致性）

### 7.6 规范落地

- 重写 `TEST-STRATEGY.md` 为可执行规范（分层 + 断言标准 + 护栏门）
- 更新 `docs/testing/` 盘点表（现状已滞后：列 6 spec 实际 10 spec）
- 新测试遵循 §7.1 三条 + §7.2 断言标准

---

## 8. 实施波次

### 阶段 0：测试基础设施（最先，为后续护航）
- 0.1: 启用 coverage + 设观察门槛
- 0.2: E2E 进 CI（mock 轨 + real 轨独立 job）
- 0.3: 补建 dev-smoke 闸门
- 0.4: 重写 TEST-STRATEGY.md

### 阶段 A：整体架构重构（先整体）
- A1: 整体-1 runtime 三层契约对齐（services/ports/infra 名实一致）
- A2: 整体-2 shared 包瘦身（运行期实现下沉）
- A3: 整体-3 IPC 边界收敛
- 每步随重构同步删旧测试 + 写新行为测试（§7.3）

### 阶段 B：renderer 局部重构（整体干净后）
- B1: 局部-1~3 chat 编排层（useChat 状态范式 + 事件消费层 + routeInbound 路由表）
- B2: 局部-4~6 模块级（Composer 合并 + chat store 重组 + Sidebar 拆分）
- B3: 局部-7~9（settings 分层 + shadcn 双名 + composables 规则）
- 每步同步删旧 + 写新测试

### 阶段 C：v6 视觉层（架构干净后）
- C1: §2 token 变更（style.css + tailwind.config.ts + 文档同步）
- C2: §4.1 对话流
- C3: §4.2 侧栏
- C4: §4.3 Drawer（含二级 tab，形态 B：icon 一级 + 各 tab 自治二级；detail 多文件 tab / terminal 多实例 tab+新增按钮占位 / git·doc 无二级）
- C5: §4.5 设置页（全屏覆盖重构）
- C6: §4.6 Overlays（§4.4 Overview 已移除）
- C7: §5 横切清理
- C8: 全量视觉验收

每波独立 commit + 对应层级验收（架构波过测试门，视觉波过视觉验收）。

---

## 9. 验收基准

**视觉**：
- `v6-demo.html` 的「目标态」（选中态=bg+蓝字 / 彩色=保留语义缩小 / 密度=现状）为视觉验收 SSOT
- 三层背景（stage→画布→surface）肉眼可辨
- impeccable AI slop test：无明显 AI tell
- 对比度：正文位置全部过 WCAG AA（≥4.5:1）

**架构**：
- 整体架构图（§6.1）的进程职责/通信机制/包依赖方向在实际代码中一致
- runtime 三层契约名实相符（services 不越层连 infra，或文档与代码一致）
- shared 包无运行期实现污染
- IPC 仅 OS 特权，业务数据走 WS 单一出口

**测试**：
- coverage 启用并进 CI
- E2E（mock + real 双轨）进 CI
- 删除的测试对应功能有新行为测试覆盖（随重构同步，无空窗）
- 对话流/session 生命周期/设置持久化有 E2E 覆盖

---

## 10. 文档同步清单（实施时更新）

- `docs/page-design/design-tokens.md`：§2 全部变更 + 变更日志
- `docs/page-design/design-system.md`：组件范式修订（§3）+ 新增分隔策略/内容列宽条文
- `AGENTS.md`：前端编码规范 #10（圆角规则）受影响条文；v6 归档后 v3/ 引用更新
- `docs/standards.md`：圆角/边框条目
- `style.css` + `tailwind.config.ts`：token 反写
