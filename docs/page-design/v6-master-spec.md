# v6 重构完整规格（2026-08）

> **状态**：权威整合主文档（Master Spec）。整合自 28 份 v6 过程文档 + `.tmp/v6/` 可运行 demo（2026-08-02 最新）。
> **性质**：视觉语言层 + 前端架构重构的完整设计。授权大刀阔斧，不考虑兼容性。
> **取代关系**：本文档是 v6 的单一权威源。过程文档（`v6-design.md` / `v6-summary.md` / `v6-review-*.md` / `v6-fix-plan.md` / `v6-spec-*.html`）降级为**实现细节参考**，与本文档冲突时以本文档 + demo 为准。
> **真相源优先级**：本文档（决策与范式） > `.tmp/v6/` demo（token 真值与组件实现） > `v6-spec-*.html`（视觉标注稿，部分已滞后） > 过程文档（审查/修复计划，已收敛进本文档）。

---

## §1 背景

### 1.1 项目

xyz-agent：基于 Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。通过子进程 RPC 调用 pi（AI coding agent CLI）。用户画像：每天 6h+ 与 AI Agent 协作的开发者。

### 1.2 为什么要 v6 重构

**视觉层**：v3 冷蓝暗色设计系统工程化程度不弱于竞品（token SSOT、10 主题预设、20 波视觉验收），但观感「不够现代、不够简洁」。根因不是色相，而是五个「克制」缺失（竞品 Codex/Claude/Linear/分析结论）。v6 不是换色，是把五原则更彻底地应用到全部页面。

**架构层**：renderer 内部复杂度欠债——useChat 违反 per-session 隔离 ADR-0036、stores 间互相 import、Sidebar 上帝组件、settings 与 v6 全屏形态根本冲突。这些欠债影响可维护性，且阻碍 plugin 扩展体系落地。

**扩展层**：项目有两套扩展机制（pi extension 已实现 / plugin-sdk 借鉴 VSCode 但 renderer 零消费），需要统一为可承重的 plugin 渲染体系。

### 1.3 授权与时序

- 用户原话：**全面大胆重构，大刀阔斧，不用考虑成本/兼容性，整体不合理可全部重写**
- 时序：**先架构后视觉**。阶段 0（测试）→ A（整体架构）→ B（renderer 局部）→ C（v6 视觉层）
- 视觉线与架构线可并行（仅 3 个交叉点：设置全屏 / Drawer 二级 tab / token 变更）

### 1.4 文档现状（为什么需要整合）

v6 过程文档已积累 28 份（30000+ 行），存在三类问题：
1. **SSOT 与 spec 互相否定**（review 发现）：如 settings shell spec 回退到 modal，而 v6-design 决策是全屏。
2. **demo（2026-08-02）比 HTML spec 更新**：demo 引入太极阴阳 6 主题、字号上移一档、状态色水墨化、整体明度抬亮，spec 仍是旧冷蓝单主题。
3. **过程文档（review/fix-plan）的裁决已收敛**，但散落各处，无单一查阅入口。

本文档解决这三个问题：裁决已定稿、token 以 demo 为准、过程结论已吸收。

---

## §2 目标

### 2.1 视觉目标

对标 Codex / Claude / Linear / Figma / Notion / Raycast / Stripe 的极简专业风格。一句话哲学：

> **冷蓝暗色不变，shell 三栏不变，对标极简专业——「层级代替边框、圆角升档、正文提亮、内容收窄、彩色降噪」五原则更彻底地应用到全部页面。**

> **v2 演进（2026-08-02）**：色相从「冷蓝」演进为「太极阴阳 6 主题预设」（默认太极·玄，纯灰系）。五原则不变，色相成为可切换的表层。

### 2.2 架构目标

- renderer 六层清晰（Shell / Workspace / Feature / **ExtensionHost** / **RenderingProtocol** / Foundation）
- per-session 状态隔离内建（ADR-0036 工厂范式一等公民）
- stores 零互相 import，事件消费逻辑归 composable 层
- plugin 渲染体系落地（4 视图维度 × 3 自定义级别 × 16 挂载点，见 §7）

### 2.3 扩展目标

- plugin-sdk 作为进程架构主干（生命周期/Worker 隔离/懒激活）
- GuiComponent 作为 pi extension + plugin 共享的统一渲染协议
- pi extension 开箱即用（ANSI 兜底永留）
- tasks(goal/todo) 作为第一个 builtin plugin 验证机制能否跑通

### 2.4 验收基准

| 维度 | 基准 |
|---|---|
| 视觉 | demo（`.tmp/v6/`）目标态为 SSOT；三层背景肉眼可辨；impeccable AI slop test 通过；正文全部过 WCAG AA |
| 架构 | runtime 三层契约名实相符；shared 无运行期实现；IPC 仅 OS 特权；renderer stores 零互相 import |
| 测试 | coverage 启用进 CI；E2E 双轨进 CI；对话流/session 生命周期/设置持久化有 E2E 覆盖 |
| 扩展 | builtin tasks plugin 跑通；core 零 tool name 硬编码特判 |

---

## §3 设计原则

### 3.1 视觉五原则（不可变）

| # | 原则 | 具体含义 |
|---|------|---------|
| 1 | **层级代替边框** | 静态容器只用一个表面色，不叠加 border；靠 bg 层级浮起分隔。border 仅保留给浮起可交互容器（popover/dialog/composer）和 focus 态 |
| 2 | **圆角升档** | `--radius-sm` 6px（全局默认档）；卡片 10px；浮层/composer 12px；徽章/pill 999px 胶囊 |
| 3 | **正文提亮** | `--neutral-dim` 抬亮一档；正文位置统一用 `--neutral-mid`（过 WCAG AA ≥4.5:1）；仅装饰/极弱位置保留 dim/faint |
| 4 | **内容收窄** | assistant 居中 720px（整 turn 居中，UserBubble 列内右浮）；设置内容列同 720px 左对齐；Composer 非 landing 对齐同列 |
| 5 | **彩色降噪** | 保留 git 语义色（M/A/D 降为极小圆点或单字）+ accent + 真 failure 的 danger，其余降灰阶。从色块/pill 降级为极小圆点或单字 badge |

### 3.2 impeccable 禁令（违反必返工）

- **禁 >1px 彩色侧边条**做选中/强调/分隔（改用 bg 实色块 + 蓝字）
- **禁嵌套卡片**（一个表面色容器不叠加 border；嵌套层级不超过 3 层明度递进）
- **禁 AI slop**：uppercase tracking-wider 装饰文字、emoji（用内联 SVG）、无意义渐变、装饰性 pill
- **禁自创组件样式**：必须用 SSOT class（`.btn-*`）或 token；**class 名正确不代表 CSS 值正确，需逐字核对视觉值**
- **禁硬编码视觉值**：颜色/间距/圆角全部 token 化（stage 底色等声明项例外）

### 3.3 架构原则

| # | 原则 | 含义 |
|---|------|------|
| 1 | **插件隔离优先（No DOM Access 铁律）** | 插件代码绝不进 renderer 进程，经结构化数据或声明式元数据驱动 |
| 2 | **声明式优先于编程式** | contribution 在 manifest 声明，支持懒激活、静态分析 |
| 3 | **数据驱动渲染** | 插件提供数据，renderer 统一渲染，插件无法直接影响 DOM |
| 4 | **单一渲染协议** | pi extension 和 plugin 共用 GuiComponent |
| 5 | **API 稳定性分层** | stable/proposed/internal，主干化即冻结点，Object.freeze 防篡改 |
| 6 | **per-session 隔离内建** | useSessionScopedState 工厂一等公民，默认隔离 |

### 3.4 选中态二分规则（D8 裁决，统一全局）

v6 审查发现「被选中」出现三种视觉语言，统一为二分：

| 类型 | 适用组件 | 范式 |
|---|---|---|
| **tab 型** | SegmentedTab / drawer L1-L2 tab / AskUserOverlay au-tab / plugin seg-tab | `bg-bg-elevated` + `text-neutral-fg`（中性浮起） |
| **列表项型** | SessionItem / FileTree / SearchModal sm-item / au-opt / wf-call / CommandPopover 项 / SettingsNavItem | `bg-surface` + `text-accent`（实色块 + 蓝字，无 ring 无左条） |

**accent-soft 仅留瞬时高亮**（fresh 新增项 / is-current popover 项），不作持久选中态。

> **demo 落地偏差**：SideDrawer L1 icon tab active 用了 `bg-surface-hover` 而非 `bg-bg-elevated`（因 drawer 与 main 同 surface，bg-elevated 会过亮）。这是实现取舍，范式以 bg-elevated 为准。

---

## §4 Design Tokens

> **真相源**：`.tmp/v6/src/styles/tokens.css`（2026-08-02 太极·玄定稿值）。以下值与该文件逐字对齐。
> 本节取代 `v6-design.md §2` / `v6-summary.md §3` / `v6-spec-tokens.html`（三者均滞后于 demo）。

### 4.1 背景层级（阶梯上抬 + 加宽级差，暗端防糊）

```css
--bg:           #131316;   /* 画布色（侧栏/drawer/settings 内容区底）*/
--bg-sunken:    var(--bg); /* 同画布色（语义变更：不往黑推，靠主面板 surface 浮起分隔）*/
--bg-input:     #17171a;   /* 输入框/凹陷区（比 bg 更深）*/
--bg-card:      #1b1b1e;   /* 设置分组卡片（介于 bg 与 surface）*/
--surface:      #1f1f22;   /* 主面板/drawer 浮起表面 */
--surface-2:    #27272a;   /* 次级表面（header 浮起分层 / SegmentedTab 内项 active）*/
--bg-elevated:  #2b2b2e;   /* tab 型选中态浮起 / popover 浮层 */
--surface-hover:#303033;   /* hover 态 */
```

**三层明度**（D2 一体化后）：
- **stage 最深底**：`#131316`（ShellView 硬编码，等于 bg；spec 原三层在玄主题下退化为两层，靠 surface 浮起分隔）
- **画布层**：`--bg` `#131316`（aside/drawer/settings 内容区）
- **surface 浮起**：`--surface` `#1f1f22`（main-panel + drawer 一体化共享，唯一带 border + shadow）

### 4.2 文字 neutral 谱系（上抬，dim ~4.4:1）

```css
--neutral-fg:    #dedee2;  /* 主前景 */
--neutral-mid:   #96969c;  /* 正文（过 AA）*/
--neutral-dim:   #74747a;  /* 次要（提亮一档）*/
--neutral-faint: #46464c;  /* 极弱/装饰 */
--neutral-ico:   #86868c;  /* 图标默认色 */
--neutral-ico-hover: #dedee2;
```

### 4.3 边框 / 分隔（v6 慎用，静态容器不叠加）

```css
--border:        rgba(255,255,255,0.07);
--border-strong: rgba(255,255,255,0.13);
--hairline:      rgba(255,255,255,0.05);  /* demo 新增：行分隔 / drawer L1 栏底线 */
```

### 4.4 主色 / 状态色（太极·玄默认：水墨降饱和，克制放开档）

```css
/* 主色（玄 = 纯灰系）*/
--accent:        #cfcfd4;
--accent-hover:  #e0e0e4;
--accent-soft:   color-mix(in oklch, var(--accent) 10%, transparent);  /* 派生 */
--accent-ring:   color-mix(in oklch, var(--accent) 30%, transparent);  /* 派生 */
--accent-fg:     #1a1a1c;  /* accent 实色上的文字（玄主题用深字）*/

/* 状态色（水墨降饱和：饱和度/明度 +15~20%，保留水墨感不艳）*/
--success: #78a87e;  --warn: #b79c54;  --danger: #bf6b6b;
--info:    #6d99a5;  --reasoning: #8e85ab;
--danger-fg: #f0f0f2;  /* danger 实色上的文字（玄主题用浅字）*/

/* soft 派生（自动跟随，主题切换无需单独覆盖）*/
--success-soft:   color-mix(in oklch, var(--success) 12%, transparent);
--warn-soft:      color-mix(in oklch, var(--warn) 14%, transparent);
--danger-soft:    color-mix(in oklch, var(--danger) 12%, transparent);
--info-soft:      color-mix(in oklch, var(--info) 12%, transparent);
--reasoning-soft: color-mix(in oklch, var(--reasoning) 12%, transparent);
```

### 4.5 diff 着色（柔化 12%）

```css
--diff-add-bg:     color-mix(in oklch, var(--success) 12%, transparent);
--diff-del-bg:     color-mix(in oklch, var(--danger) 12%, transparent);
--diff-add-strong: color-mix(in oklch, var(--success) 45%, transparent);
--diff-del-strong: color-mix(in oklch, var(--danger) 45%, transparent);
```

### 4.6 字体 / 字号 scale（2026-08-02 整体上移一档 + 自适应）

```css
--font-sans: Inter, 'SF Pro Display', 'PingFang SC', system-ui, sans-serif;
--font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;

/* 字号 scale（base 13→14 上移，calc 自适应）*/
--font-scale-u: 1;   /* 用户档位（TokenDebugPage 选：紧凑0.92/标准1.0/偏大1.08/大1.16）*/
--font-scale-mq: 1;  /* 视口档位（媒体查询：≥2100px ×1.08 / <1400px ×0.95）*/
--text-2xs: calc(11px * var(--font-scale-u) * var(--font-scale-mq));
--text-xs:   calc(12px * var(--font-scale-u) * var(--font-scale-mq));
--text-sm:   calc(13px * var(--font-scale-u) * var(--font-scale-mq));
--text-base: calc(14px * var(--font-scale-u) * var(--font-scale-mq));
--text-md:   calc(15px * var(--font-scale-u) * var(--font-scale-mq));
```

### 4.7 圆角 / 间距 / 阴影 / z-index / 动效

```css
/* 圆角 */
--radius-sm: 6px;   --radius: 8px;   --radius-lg: 12px;   --radius-card: 10px;

/* 间距（4px 栅格）*/
--space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
--space-6:24px; --space-8:32px; --space-12:48px; --space-16:64px;

/* 阴影 */
--shadow-1: 0 0 0 1px rgba(0,0,0,0.2);
--shadow-2: 0 8px 24px rgba(0,0,0,0.4);
--shadow-drawer: -12px 0 24px rgba(0,0,0,0.16);  /* 弱投影（D2 一体化分隔）*/
--shadow-glow: 0 0 0 3px color-mix(in oklch, var(--accent) 25%, transparent);

/* z-index 语义化 */
--z-sticky: 1;  --z-popover: 10;  --z-overlay: 20;  --z-modal: 1000;

/* 动效 */
--ease: cubic-bezier(0.4,0,0.2,1);
--duration-fast: 120ms;  --duration: 200ms;  --duration-slow: 320ms;

/* 组件尺寸 */
--content-max-w: 720px;  --composer-btn-size: 30px;
--bash-output-max-height: 240px;  --bar-fill-soft: 55%;
--panel-bg: var(--surface);  /* panel 内 sticky 浮层底色契约 */
```

### 4.8 主题系统（太极阴阳 6 预设）

demo 引入完整多主题系统（spec 无，demo 重大扩展）。机制：改 CSS 变量（resetToken 清空 → writeToken 批量写入），派生色自动跟随。

**阴 · 暗色族（3 个）**——背景近中性，色相只做「依稀相」(S≤6%)，靠明度阶梯说话：
| 主题 | accent | 特色 |
|---|---|---|
| **太极·玄（默认）** | `#cfcfd4` 纯灰 | 暗端防糊，阶梯上抬+加宽级差 |
| 太极·黛蓝 | `#9ca9c9` 依稀蓝相 | S≈8% |
| 太极·暖墨 | `#cbc3b3` 暖相 | 宣纸暖 |

**阳 · 亮色族（3 个）**——宣纸为底，彩色只做小面积 accent（朱印点睛）：
| 主题 | accent | 特色 |
|---|---|---|
| **太极·皓** | `#36332f` 墨黑 | 亮·宣纸墨黑 |
| 太极·青墨 | `#3d6b6b` 花青 | 亮·宣纸花青 |
| 太极·朱印 | `#9c4335` 朱砂 | 亮·宣纸朱砂（danger 错开玫红 `#b23855` 防撞色）|

**设计原理**：暗底彩色必须提亮才可读（提亮即荧光），故靠明度阶梯说话而非色相；亮底允许低饱和低明度「颜料 accent」。亮色族共用同一套宣纸阶梯，只换 accent 颜料不换纸。

---

## §5 Design System（组件范式）

> **真相源**：`.tmp/v6/src/styles/base.css`（SSOT 全局范式）+ demo 组件实现。

### 5.1 `.btn` SSOT（base + 4 variant × 尺寸 + focus + disabled + svg）

```css
/* base */
.btn { inline-flex; items-center; gap: var(--space-2); white-space: nowrap;
  border-radius: var(--radius); font-weight: 500;
  transition: all var(--duration-fast) var(--ease); user-select: none; }
.btn:disabled { pointer-events: none; opacity: 0.5; }
.btn:focus-visible { outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,0.4); }  /* 双环 */
.btn svg { width: 16px; height: 16px; flex-shrink: 0; }

/* 4 variant */
.btn-default   { background: var(--accent); color: var(--accent-fg); }       /* Primary */
.btn-secondary { background: transparent; border: 1px var(--border); color: var(--neutral-fg); }
.btn-ghost     { background: transparent; color: var(--neutral-fg); }        /* hover: bg-surface-hover */
.btn-danger    { background: transparent; color: var(--danger); }            /* hover: bg-danger-soft */

/* 尺寸 */
.btn-sm   { height: 36px; padding: 0 12px; font-size: var(--text-sm); }
.btn-md   { height: 32px; padding: 0 12px; }  /* 过渡兼容，新代码用 btn-dense */
.btn-dense{ height: 32px; padding: 0 12px; font-size: var(--text-xs); }  /* 新代码首选 */
.btn-icon { width: 40px; height: 40px; padding: 0; }
.btn-icon-sm { width: 28px; height: 28px; padding: 0; }
```

**focus 裁决**（全局统一）：
- Button / Switch / Checkbox = accent 双环（`0 0 0 2px accent` + `0 0 0 4px black/0.4`）
- Input / Textarea = **inset 单环**（`inset 0 0 0 1px var(--accent-ring)`）
- 链接/行级可点元素 = inset 单环（与 Input 一致）
- composer-box focus = 3px 外环（对齐真实代码，非 inset 单环）

### 5.2 控件范式（独立 .vue 组件，用 scoped + token）

| 控件 | 规格 |
|---|---|
| `UiInput` | h40（dense h32）；`bg-bg-input`；focus = inset 单环；error class `.err` |
| `UiSwitch` | 36×20；translateX=18px；focus 双环；无 hover 变色 |
| `UiCheckbox` | 16×16；focus 双环 |
| `SelectTrigger` | 去 border，`bg-bg-input`，圆角 8px（spec 画目标态，不改 .vue 源码留实施） |

### 5.3 SegmentedTab 新范式（§3.1）

```
外层容器: bg-bg-input rounded-lg(12px) p-[3px]
内项: 无边框
active(tab 型): bg-bg-elevated text-neutral-fg, 6px 圆角（中性浮起，去 accent-soft 蓝染底）
hover: text-neutral-fg
```

### 5.4 列表项选中态（§3.2）

```
列表项 active: bg-surface 实色块 + text-accent 蓝字，无 ring 无左条
```

### 5.5 分隔策略（层级 > 留白 > hairline > 边框）

- 静态容器只用一个表面色，**不叠加 border**
- border 仅保留：浮起可交互容器（popover/dialog/composer）+ focus 态
- drawer 内 header 分隔：去 `border-b`，改 `bg-surface-2` 浮起分层
- drawer 与 main 间：D2 一体化（同 surface）+ 弱投影 `--shadow-drawer`（0.16）+ SplitterResizeHandle 透明化（仅 hover/drag 显 accent）
- 行分隔 hairline：`--hairline`（0.05）

### 5.6 状态指示统一（§3.3）

- **状态一律 7px 圆点**（`7px; border-radius: 999px`）+ 语义色：done=`--success`(90% opacity) / running=`--accent` / waiting=`--warn` / error=`--danger`
- **工具失败**（exit≠0）：图标统一 `--neutral-ico`，行尾加 mono `exit N` 中性标签（`bg-bg-elevated` 胶囊）
- **彩色边界**：保留 = 真 failure danger / 待行动 accent / git 语义色（降极小圆点）；降中性 = workflow done / GoalCard badge / ±stats / 目录改动数
- **GitPanel badge 中性化**：M/A/D 统一 `neutral-dim`，仅 U（冲突）染 `danger + font-weight 700`

### 5.7 图标 scale（§5.3）

| 用途 | size |
|---|---|
| badge | 10px |
| trace | 12px |
| block header / header | 14px |
| 操作按钮 | 16px |

lucide-vue 内联 SVG，stroke-width 统一 **1.75**。block icon：thinking=Brain / tool-bash=SquareTerminal / tool 兜底=SquareFunction / subagent=Bot / workflow=Workflow。

### 5.8 GroupCard（设置分组卡片）

```
.group-card { background: var(--bg-card); border-radius: 10px; padding: 10px; }  /* 去 border */
.group-head { background: var(--surface-2); padding: 10px 16px; border-top: 1px rgba(255,255,255,0.04); }  /* 首张 border-top:0 */
```

### 5.9 动效（全局 keyframes）

`spin` / `pulse-accent`（2s box-shadow 涟漪）/ `pulse-dot` / `blink` / `shimmer`（骨架屏）。`@media (prefers-reduced-motion: reduce)` 把所有 animation/transition 压到 `0.01ms !important`。

---

## §6 分区设计（逐视图：v6 方案）

> 详细视觉标注见 `v6-spec-*.html`（实现细节参考），本节给架构关键决策。

### 6.1 对话流（assistant 居中 720）

- **MessageStream**：整 turn 居中 `max-w-content-max-w`(720) + `margin:0 auto`；UserBubble 列内右浮（max-w-76%）；隐藏原生滚动条由 TurnRail 接管
- **TurnMeta**：pill 默认可见（`bg-surface-2` 浮起，解决主面板 surface 上「面上面」不可见）；删 turn 间 `hr` 改加大 turn gap
- **Block·tool**：状态矩阵 collapsed/expanded × running/done/failed；running 双环 loader（13px）；exit≠0 加 mono 标签
- **Block·thinking**：收起态 1 行 ellipsis（60 字符截断）；expanded body 用 `neutral-mid`（过 AA）
- **Block·bash**：区分 BashOutputBlock（composer `!` 前缀，不可折叠）vs tool-bash（嵌 tool 块，`bg-bg-input` 无 border）
- **Block·subagent/workflow**：collapsed only，点击 → drawer tab
- **UserBubble**：删 border，仅 `bg-surface-hover`；删 pending 态（迁 QueueBubble 内嵌）
- **Composer**：6 区（QueueBubble / staging chip / inline chip bar / landing meta / input / composer-bar）；宽度对齐 720 居中
- **ChangeSetCard**：去 border 改 `bg-surface` + 10px 圆角；5 态 badge 用 `*-soft` 底 + 实色字
- **PanelHeader**：去 `border-b`，用 `bg-elevated` 浮起分层
- **goal/todo 回归对话流**（D3）：移除 tasks tab + `HIDDEN_TOOL_NAMES`，走 GuiComponent 统一渲染

### 6.2 侧栏（5 tab + 容器）

- 底色 `bg-bg`；SegmentedTab 见 §5.3；SessionItem 选中态见 §5.4
- **4 内置 tab**（sessions/files/agents/flows）+ **第 5 独立 plugin tab**（Puzzle icon，plugin view 收口于此）
- 组标题去 uppercase；ForkGroup 去 border 改缩进；FileTree 缩进 10px gap 4px
- 状态点统一 7px

### 6.3 右侧 Drawer（D2 一体化 + 7 tab）

- **一体化生长**：drawer 与 main 共享 `--surface` 浮起体，从 main 右缘生长挤占 main 宽度；保留弱投影 `--shadow-drawer`(0.16) 分隔；去 border-l
- **形态 B**：icon 一级 + 各 tab 自治二级
  - detail：多文件 tab（点文件新开/切换/关闭）—— **阶段 B 衔接点**（useDetailPane 单值→map 重构）
  - terminal：多实例 tab + 新增按钮占位 —— **阶段 B 衔接点**（单 PTY→多 PTY）
  - git/doc：无二级 tab
  - subagent（新增）：嵌套只读对话流（无 composer）
  - workflow（新增）：phase 分组 + agent call 列表
- **tasks tab 移除**（D3）：goal/todo 回归对话流
- SplitterResizeHandle 透明化（仅 hover/drag 显 accent）

### 6.4 设置页（D1 全屏覆盖重构）

- **FullSettingsOverlay**：手写 `fixed inset-0 bg-bg z-modal`（不用 reka Dialog）；无遮罩/无模糊（纯不透明全屏）
- 左 nav `w-220px bg-sunken` 无 border-r；右内容区底色 `--bg`（卡片才能浮起），内容列 `max-w-content-max-w`(720) **左对齐**（非居中）
- nav 选中态见 §5.4（列表项型）；nav-brand `uppercase 0.08em`（例外）
- 10 个分组卡片 `bg-card` + 10px 圆角 + 去 border；行分隔 hairline 0.05；每行 label 下加 12px `neutral-mid` 描述
- **ProviderEdit**：展开就地编辑（手风琴，取代 ProviderEditModal 双层 modal）
- 表单 label 去 uppercase tracking-wider
- **交互状态机**（有编辑态的页面）：dirty 快照 diff（净零翻转恢复 clean）/ 保存流（mock 延迟 + 已保存反馈）/ 离开守卫（dirty 拦截切页 + 放弃先还原快照防重入）/ beforeunload

### 6.5 Overlays

- **SearchModal**：手写覆盖层；选中态对齐 §5.4（bg-surface+蓝字，与 hover 区分）；分组 header 去 uppercase；高亮 font-semibold
- **AskUserOverlay**：内联（非 modal），companion-band 统一交互出口（B3）
- **ConfirmDialog**：圆角 12px；danger 三角 icon 降 size-4
- **MermaidRenderer**：保持现状

### 6.6 Plugin 渲染（4 维度 × 3 级别 × 16 挂载点）

详见 §7。

---

## §7 Plugin 渲染体系（架构层）

> 详见 `docs/architecture/renderer-target-architecture.md`（架构 SSOT）。本节给摘要。

### 7.1 统一架构判定

- **plugin-sdk** 作进程架构主干（生命周期/Worker 隔离/JSON-RPC/懒激活/Disposables）
- **GuiComponent** 作 pi extension + plugin 共享的统一渲染协议（7 原语 + custom 逃生口）
- 兼容铁律：pi extension 开箱即用（ANSI 兜底永留）

### 7.2 4 视图维度 × 3 自定义级别

| 维度 | 挂载点 | 级别 | 当前状态 |
|---|---|---|---|
| **A 结构容器** | A1 侧栏第 5 tab / A2 drawer tab(proposed) / A3 工具条按钮 / A4 底栏状态 | L1 | panels 声明未消费 |
| **B 对话流+companion** | B1 tool result / B2 消息卡 / B3 companion(统一出口：dialog+ask-user) | L2/L1 | **已实现**（5 闭环） |
| **D 命令配置** | D1 slash / D2 settings 区段 | L1 | D1 已实现（双轨待统一） |
| **E 独立 view** | E1 独立 view 路由 | L3 | 未实现（仅 built-in） |

| 级别 | 含义 | external 可用 |
|---|---|---|
| L1 元数据+数据驱动 | plugin 给 {id,icon,title,data,command}，renderer 固定宿主 | ✅ |
| L2 结构化原语树 | plugin 给 GuiComponent 组合，renderer 原语渲染器 | ✅ |
| L3 预编译组件 | plugin 给 Vue 组件，编译期打包 | ❌ 仅 built-in |

### 7.3 16 挂载点 Tier 分层

- **Tier 1（12 活注入点）**：M1/M2/M4/M5/M7/M8/M9/M10/M11/M12/M14/M16
- **Tier 2（4 边缘）**：M3（不改结构）/ M6（drawer proposed）/ M13（低优浮层）/ M15（降级仅致命错误）
- **关键阻塞**：6 个声明式空壳变闭环，差 2 个 API（`commands.register` / `views.update`）

### 7.4 7 原语 v6 视觉

| 原语 | v6 视觉 |
|---|---|
| card | 去边框靠 bg 层级（bg-card→surface→surface-2）；header 去 border-b 改 bg 浮起；圆角 8-10px；variant 靠 dot+badge |
| stats-line | severity 收窄（danger 保留，ok/warn 降中性）；border-l hairline 保留 |
| progress-bar | fill 柔化 color-mix；done 降中性；圆角 6px |
| list-tree | 缩进 16px 留白档；icon 12px；status 7px 圆点替换文字 |
| columns | gap-3(12px) 标准 scale |
| tab-bar | 强制迁移 SegmentedTab 范式（去 accent-soft 去底线） |
| ansi-text | ANSI 16 色→v6 语义色映射（丢弃 bg 只用 fg）；暗/亮双主题 |

**原语扩展路线**（盲区补齐）：按需补 `rows`（垂直 stack，解跨栏 footer）/ `kv-list` / `table`，不放开 custom。

### 7.5 Builtin Plugin 第一实践：tasks(goal/todo)

经核实为首选——v6 已定决策顺势落地 + 管线就绪（extension 已产 GuiComponent）+ 独立性高 + 验证信号纯。subagent/workflow 暂缓（耦合虚拟 session），search 不纳入（核心导航）。

---

## §8 落地改动点（前端整体架构重构）

> 结合 `v6-architecture-refactor.md`（现状审查+缝补）+ `renderer-target-architecture.md`（终态架构）。
> 时序：阶段 0 → A → B → C。

### 8.1 阶段 0：测试基础设施（最先，为重构护航）

- 启用 coverage + 设观察门槛
- E2E 进 CI（mock 轨 + real 轨独立 job）
- 补建 dev-smoke 闸门
- 重写 TEST-STRATEGY.md

### 8.2 阶段 A：整体架构（3 项）

| 项 | 动作 | 优先级 |
|---|---|---|
| **A1 runtime 缝补** | 补全 ISessionStore port（2 处真业务直连）+ logger 豁免声明 + pi-paths 归 kernel | 暖身（最机械） |
| **A2 shared 瘦身** | git-status-parser/ignore-parser 下沉 runtime（机械移动） | 中 |
| **A3 IPC 收敛** | proxy 命名修正 + 业务持久化（writeSessionImage/Segments）迁 WS | 中 |

### 8.3 阶段 B：renderer 局部重构（重点）

| 项 | 动作 |
|---|---|
| **B1 useChat 状态隔离** | per-session 状态迁 useSessionScopedState 工厂；删 reset*ModuleState（6 个） |
| **B2 stores 契约修复** | 抽独立事件消费层；stores 零互相 import、零 store→composable 倒置 |
| **B3 routeInbound 路由表** | 104 行 if-else → 声明式路由表 + seq gap 中间件 + error envelope 下沉 |
| **B4 Composer 合并** | 20 个 composable → 3 个（Input/Dispatch/Context）；useContenteditableInput 873 行拆解 |
| **B5 Sidebar 拆分** | 全局快捷键 88 行抽出 + tab 计数抽出 + session handler 抽出 |
| **B6 chat store 重组** | 流式消息状态机内聚；消除 *Impl（6 个） |
| **B7 settings 重构** | 目录按域分层 + 数据文件移出 + 全屏覆盖形态（D1）+ ProviderEdit 嵌入式（R4） |
| **B8 ui/ 双名清洗** | bg-accent 98 处双义消除 + ui/ 内 shadcn 命名清洗 |
| **B9 composables 分层** | features(41)/panel(37) 按域分子目录；顶层只留全局基础设施 |

### 8.4 阶段 C：v6 视觉层（token 反写 → 分视图）

| 波次 | 内容 |
|---|---|
| C1 | token 反写（style.css + tailwind.config.ts 同步 demo tokens.css 值） |
| C2 | 对话流（MessageStream/Block/Composer 6 区/ChangeSetCard） |
| C3 | 侧栏（SegmentedTab/SessionItem/FileTree/第 5 plugin tab） |
| C4 | Drawer（一体化 + 形态 B + 7 tab + GitPanel MVP） |
| C5 | 设置页（FullSettingsOverlay + 10 page + GroupCard） |
| C6 | Overlays（SearchModal/AskUserOverlay/ConfirmDialog） |
| C7 | Plugin 渲染（7 原语 v6 视觉 + ExtensionHost + builtin tasks） |
| C8 | 横切清理（正文提亮/彩色降噪/uppercase 清除/z-index）+ 全量验收 |

### 8.5 plugin-sdk 必修致命缺陷（主干化前置）

1. **sandbox ESM 漏洞**（import 绕过 require 拦截）→ vm 模块或真进程隔离
2. **panels 渲染链路 + UI 接口统一**（§7 目标态）
3. **API 稳定性分层 + Object.freeze**

---

## §9 已裁决清单（全部定稿，无待确认）

> 这些裁决来自 v6-review/fix-plan 的 37 项（D1-D11 + R1-R26），已全部定稿。实施时直接遵循。

### 9.1 结构裁决

| # | 裁决 | 决定 |
|---|---|---|
| D1 | 设置形态 | 全屏覆盖（FullSettingsOverlay） |
| D2 | Drawer 模型 | 一体化生长 + 保留弱投影(0.16) |
| D3 | tasks tab | 移除（goal/todo 回归对话流，删 HIDDEN_TOOL_NAMES） |
| D4 | plugin 范围 | 补登记架构授权（v6-design 决策 #15） |
| D8 | 选中态冲突 | 按组件类型二分（tab 型 bg-elevated / 列表项型 bg-surface+蓝字） |

### 9.2 数值裁决

| # | 裁决 | 决定 |
|---|---|---|
| R1 | composer focus | 3px 外环（对齐代码） |
| R2 | git M badge | info 蓝（对齐代码） |
| R4 | ProviderEdit | 展开就地编辑（手风琴） |
| R9 | thinking body | neutral-mid（过 AA） |
| R10 | 列宽 | 整 turn 居中、气泡列内右浮 |
| R11 | block icon | 14px |
| R13 | SegmentedTab 圆角 | 12px（radius-lg） |
| R14 | drawer 投影 | 弱投影 0.15-0.18 |
| R22 | 圆角升档 | tr-git/fg-pill 等升 6px；tt-close 保留 3px 例外 |

### 9.3 文档裁决

| # | 裁决 | 决定 |
|---|---|---|
| D5 | 对话流共享 CSS | 抽取 v6-spec-base.css |
| D7 | 文档 chrome | 不豁免 impeccable（spec 自身也禁 uppercase/彩条） |
| D9 | SSOT 链 | 全部同步更新（README/design-system/visual-modernization） |

---

## §10 文档体系与取代关系

### 10.1 v6 文档分类（28 份 → 整合后）

| 类别 | 文件 | 整合后状态 |
|---|---|---|
| **权威主文档** | **本文档（v6-master-spec.md）** | ✅ 单一权威源 |
| 可运行参考 | `.tmp/v6/`（demo 项目） | ✅ token 真值与组件实现 |
| 设计 SSOT | `v6-design.md` | 降级为决策参考（token 值已被本文档 §4 取代） |
| 设计总览 | `v6-summary.md` | 降级为索引（部分值滞后） |
| 架构 SSOT | `renderer-target-architecture.md` / `v6-architecture-refactor.md` | ✅ 保留（架构细节本文档 §7-§8 摘要引用） |
| HTML spec（18 份） | `v6-spec-*.html` | 降级为视觉标注参考（部分已滞后于 demo） |
| 过程文档 | `v6-review-*.md` / `v6-fix-plan.md` / `v6-review-action-plan.md` | 裁决已收敛进本文档 §9，过程文档归档 |
| 共享 CSS | `v6-spec-base.css` | ✅ 保留（对话流四文件共享） |
| 输入提案 | `visual-modernization-2026-07.md` | 保留追溯（已被 v6-design 取代） |

### 10.2 真相源优先级

```
本文档（v6-master-spec.md，决策与范式）
  > .tmp/v6/ demo（token 真值与组件实现，2026-08-02 最新）
  > v6-spec-*.html（视觉标注稿，部分滞后）
  > 过程文档（review/fix-plan，裁决已收敛）
```

**冲突处理原则**：本文档与任何过程文档冲突时，以本文档为准；token 值与 HTML spec 冲突时，以 demo 为准（demo 比 spec 新，含太极主题/字号上移/水墨状态色等演进）。

---

## 附录 A：demo 项目结构（`.tmp/v6/`）

完整 Vue 3 可运行参考实现，27 张截图覆盖全部视图。技术栈：原生 CSS + tokens + 迷你组件（刻意不绑 Tailwind/xyz-ui，真实实施按 v6-design 阶段 C 映射到项目技术栈）。

```
.tmp/v6/src/
├─ styles/tokens.css（token SSOT，太极玄定稿）
├─ styles/base.css（.btn SSOT + 全局重置 + keyframes）
├─ views/ShellView.vue（三栏布局 + 三层明度 + 折叠态）
├─ composables/useStore.ts（状态管理）
├─ mock/*.ts（8 个 mock 数据文件）
├─ components/
│  ├─ shell/（PanelHeader/SplitterHandle/TrafficLight/AppNavControls）
│  ├─ sidebar/（Sidebar/SegmentedTab/SessionList/PluginPanel/FileTreeView/...）
│  ├─ chat/（MessageStream/ToolBlock/ThinkingBlock/ChangeSetCard/Composer/...）
│  ├─ drawer/（SideDrawer/GitPanel/DiffView/DetailPane/TerminalView/BrowserPane/...）
│  ├─ settings/（SettingsOverlay/GroupCard/ProviderPage/...12 page）
│  ├─ overlays/（SearchModal/AskUserOverlay/ConfirmDialog）
│  └─ composer/（Composer/CommandPopover/QueueBubble）
└─ SETTINGS-DESIGN-CONTEXT.md（设置页实现基准）
```

## 附录 B：impeccable AI slop 检测清单

实施时逐项检查：
- [ ] 产品 UI 无 uppercase tracking-wider 装饰文字
- [ ] 无 emoji（产品 UI，终端输出/示意 SVG 豁免）
- [ ] 无 >1px 彩色侧边条（选中/强调/分隔；拖拽临时态豁免）
- [ ] 无嵌套卡片（静态容器 bg+border 双重分隔）
- [ ] 无无意义渐变（logo/avatar/装饰）
- [ ] 无硬编码色值（应用 token；stage 底色/模拟外部网页豁免）
- [ ] class 名正确 ≠ CSS 值正确（逐字核对视觉值）
