# v6 视觉稿总览（临时整理文档）

> 日期：2026-07-31
> 用途：汇总 v6 全部设计稿、tokens、design-system、设计目标与原则，供快速查阅
> SSOT：本目录 [`v6-design.md`](./v6-design.md) 为权威主文档，本文档是其索引与摘要

---

## 1. 设计目标

为 xyz-agent（Electron + Vue3 AI Agent 桌面工作台）制作 **v6 视觉规格稿体系**。

- **性质**：全面重新设计，落在**视觉语言层**（架构/色相/字体保留），授权大刀阔斧重构
- **对标**：Codex / Claude / Linear / Figma / Notion / Raycast / Stripe 极简专业风格
- **用户画像**：每天 6h+ 与 AI Agent 协作的开发者
- **一句话哲学**：冷蓝暗色不变，shell 三栏不变，对标极简专业——「层级代替边框、圆角升档、正文提亮、内容收窄、彩色降噪」五原则更彻底地应用到全部页面

### 已确认全局决策（不可变）

| # | 决策 | 取值 |
|---|------|------|
| 1 | 范围 | 全面重新设计，落在视觉语言层 |
| 2 | 架构 | 保留 shell 三栏拓扑（aside/main/drawer + traffic-light 安全区） |
| 3 | 色相 | 保留冷蓝暗色（`--bg #1a1b1f` / `--accent #4f8ef7`） |
| 4 | 字体 | 保留 Inter（正文）+ JetBrains Mono（等宽） |
| 5 | 风格 | 极简专业，对标 Codex/Claude/Linear |
| 6 | 五原则口径 | 以五原则为基，更彻底地应用 |

### 视觉决策（demo 验证后确认）

| # | 决策点 | 取值 | 含义 |
|---|--------|------|------|
| 7 | 选中态范式 | **bg 实色 + 蓝字** | `bg-surface` 实色块 + `text-accent`，无 ring 无左条 |
| 8 | 彩色降噪 | **保留语义但缩小** | git M黄/A绿/D红 等保留，但从色块/pill 降级为极小圆点或单字 |
| 9 | 信息密度 | **现状** | meta 保持可见，不改密度 |
| 10 | 背景层次 | **三层明度** | stage 深底(#131316) → 侧栏/drawer=画布色(--bg) → 主面板=surface 浮起 |

### 结构决策

| # | 决策点 | 取值 |
|---|--------|------|
| 11 | 对话流列宽 | **仅 assistant 居中 720px**，UserBubble 保持右浮窄气泡 |
| 12 | files 紧凑 | 缩进 `INDENT_STEP` 14→10px，icon-文字 gap 6→4px |
| 13 | 设置形态 | **全屏覆盖**（非居中 modal），左右分栏 |
| 14 | 设置改造 | **彻底重构**：新建 `FullSettingsOverlay`；ProviderEditModal 改嵌入式面板 |

---

## 2. 五设计原则

| # | 原则 | 具体含义 |
|---|------|---------|
| 1 | **层级代替边框** | 静态容器只用一个表面色（`--surface`/`--bg-input`/`--bg-card`），不叠加 border；靠 bg 层级浮起分隔。border 仅保留给浮起可交互容器（popover/dialog/composer）和 focus 态 |
| 2 | **圆角升档** | `--radius-sm` 3px→6px（全局默认档）。148 处 `rounded-sm` 消费点自动跟随。卡片 8-10px，浮层/composer 12px，徽章/pill 999px 胶囊，kbd 6px |
| 3 | **正文提亮** | `--neutral-dim` #6b7280→#7d8494，正文位置统一迁 `--neutral-mid`（#9ca3af，过 WCAG AA）。仅装饰/极弱位置保留 dim/faint |
| 4 | **内容收窄** | assistant 居中 720px（`--content-max-w`）；设置内容列宽同 720px；Composer 非 landing 对齐同列 |
| 5 | **彩色降噪** | 保留 git 语义色（M黄/A绿/D红）+ accent + 真 failure 的 danger，其余降灰阶。从色块/pill 降级为极小圆点或单字 badge |

### impeccable 禁令（违反必返工）

- **禁 >1px 彩色侧边条**做选中/强调/分隔（改用 bg 实色块 + 蓝字）
- **禁嵌套卡片**（一个表面色容器不叠加 border）
- **禁 AI slop**：uppercase tracking-wider 装饰文字、emoji（用 SVG）、无意义渐变、装饰性 pill
- **禁自创组件样式**：必须用 SSOT class（`.btn-*` / `.ui-*`）或 xyz-ui 组件库
- **关键经验**：class 名正确不代表 CSS 值正确，需**逐字核对视觉值**

---

## 3. Design Tokens

### 3.1 颜色 Tokens（暗色主题 SSOT）

```css
/* 背景层级（三层明度）*/
--bg:           #1a1b1f;   /* 画布色（侧栏/drawer 底）*/
--bg-sunken:    var(--bg); /* 同画布色，不往黑推（语义变更）*/
--bg-elevated:  #313239;   /* 大卡片浮起 */
--bg-input:     #1e1f24;   /* 输入框/凹陷区 */
--bg-card:      #22242c;   /* 设置分组卡片（新增，介于 bg 与 surface）*/
--surface:      #272830;   /* 主面板浮起表面 */
--surface-2:    #2e2f38;   /* 次级表面（header 浮起分层）*/
--surface-hover:#363740;   /* hover 态 */

/* 文字（neutral-dim 提亮一档）*/
--neutral-fg:    #e5e7eb;  /* 主前景 */
--neutral-mid:   #9ca3af;  /* 正文（过 AA）*/
--neutral-dim:   #7d8494;  /* 次要（提亮自 #6b7280）*/
--neutral-faint: #4b5563;  /* 极弱/装饰 */
--neutral-ico:   #8b8d94;  /* 图标默认色 */

/* 边框（v6 慎用，静态容器不叠加）*/
--border:        rgba(255,255,255,0.08);
--border-strong: rgba(255,255,255,0.15);

/* 强调 / 语义色 */
--accent:        #4f8ef7;  /* 主蓝 */
--accent-hover:  #6ba3ff;
--accent-soft:   color-mix(in oklch, var(--accent) 12%, transparent);
--accent-ring:   rgba(79,142,247,0.5);  /* focus ring */

/* 状态语义 */
--success: #22c55e;
--warn:    #b08a3e;   /* 提亮自饱和黄 */
--danger:  #ef4444;
--info:    #38bdf8;
--reasoning: #a78bfa; /* thinking 紫 */
```

### 3.2 Token 变更清单（v6 相对现状）

| Token | 现值 | v6 值 | 说明 |
|-------|------|-------|------|
| `--radius-sm` | `3px` | **`6px`** | kbd/tag/小按钮/chip 全局默认档升档 |
| `--neutral-dim` | `#6b7280` | **`#7d8494`** | 提亮一档（暗色），亮色同步提亮保持一致 |
| `diff-add-bg`/`diff-del-bg` | color-mix 18% | **12%** | diff 着色柔化 |
| `--content-max-w` | — | **`720px`**（新增） | 对话流 + 设置内容列宽 |
| `--bg-sunken` | `color-mix(bg 97%, black)` | **`var(--bg)`** | 语义变更：同画布色，靠主面板 surface 浮起分隔 |
| `--bg-card` | — | **`#22242c`**（新增） | 设置分组卡片层级 |

`tailwind.config.ts` `borderRadius.sm` 同步 `3px→6px`。

### 3.3 字体 / 间距 / 动效

```css
--font-sans: Inter;
--font-mono: 'JetBrains Mono';

--radius-sm: 6px;   /* v6 升档 */
--radius:    8px;   /* 按钮/卡片 */
--radius-lg: 12px;  /* 面板/弹层/composer */

--z-sticky: 1;      /* sticky 元素 */
--z-popover: 10;    /* popover/dropdown */
--z-overlay: 20;    /* SearchModal 等覆盖层 */
--z-modal:   1000;  /* ConfirmDialog 等 modal */

--content-max-w: 720px;  /* v6 新增 */
```

动画 easing `--ease`；transition `duration-fast` 120ms（hover/折叠）/ `duration` 200ms（focus）；reduced-motion 全局兜底。icon stroke-width 统一 **1.75**。

---

## 4. Design System（组件范式）

### 4.1 按钮范式（settings spec §6）

**base `.btn`**：`font-size: 13px`（字面量）；`font-family: inherit`；`border: none`；`border-radius: var(--radius)`；`gap: 8px`；transition 带 `var(--ease)`；`.btn svg` = `16×16`。

| Variant | 样式 |
|---------|------|
| `.btn-default` | `bg-accent` `text-white` |
| `.btn-secondary` | 透明 + border |
| `.btn-ghost` | 透明，`color: var(--neutral-fg)` 非 inherit |
| `.btn-danger` | `text-danger` hover:`bg-danger-soft` |

| Size | 尺寸 |
|------|------|
| `.btn-default-size` | h36, padding 0 16px |
| `.btn-dense` | h32, padding 0 12px, font-size 12px |
| `.btn-sm` | h36, padding 0 12px |
| `.btn-icon` | 40×40 |
| `.btn-icon-sm` | 28×28 |

**focus-visible 裁决**：
- Button / Switch / Checkbox = accent 双环（`box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,0.4)`）
- Input / Textarea = **inset 单环**（`box-shadow: inset 0 0 0 1px var(--accent-ring)`）
- disabled = `opacity: 0.5; pointer-events: none`

### 4.2 控件范式

| 控件 | 规格 |
|------|------|
| Input `.ui-input` | h40；focus = inset 单环；error class `.err` |
| Checkbox `.ui-checkbox` | 16×16；focus = 双环（同按钮） |
| Switch `.ui-switch` | 36×20；translateX=18px；focus = 双环 |
| SelectTrigger | 去 border，`bg-bg-input`，圆角 8px |

### 4.3 SegmentedTab 新范式（§3.1）

```
外层容器: bg-bg-input rounded-lg p-[3px]
内项: 无边框
active: bg-bg-elevated text-neutral-fg, 6px 圆角（中性浮起，去 accent-soft 蓝染底）
hover: text-neutral-fg
```

### 4.4 选中态范式（Card-Active §3.2）

- **列表项激活**（SessionItem/SessionCard/SettingsModal nav）：`bg-surface` 实色块 + `text-accent` 蓝字，**无 ring 无左条**
- **面板激活**（Panel active）：维持 inset accent-ring
- **SessionCard active**：大卡片用 `bg-bg-elevated`，窄列表项用 `bg-surface`
- **文件树选中态**：属列表项，`bg-surface` + 蓝字

### 4.5 状态指示统一（§3.3）

- **会话/任务状态**：7px 圆点替换 15px 饱和图标
  - done = success (90% opacity) / running = accent / waiting = warn / error = danger
- **工具失败（exit≠0）**：图标统一 `--neutral-ico`（删 warn 着色），行尾加 mono `exit N` 中性标签
- **彩色边界**：保留彩色 = 真 failure 的 danger / 待行动 accent / git 语义色（降为极小圆点）；降中性 = workflow done 态、GoalCard badge、±stats、目录改动数

### 4.6 分隔策略（§3.4 层级 > 留白 > hairline > 边框）

- 静态信息容器只用一个表面色，**不叠加 border**
- border 仅保留给：浮起可交互容器 + focus 态
- drawer 内 header 分隔：去 `border-b`，改 `bg-surface-2` 浮起分层
- 侧栏/drawer 与主面板间：去硬 border，靠三层明度 + SplitterResizeHandle 透明化（仅 hover/drag 显 accent）

### 4.7 图标 scale（§5.3）

| 用途 | size |
|------|------|
| badge | 10px |
| trace | 12px |
| block header / header | 13-14px |
| 操作按钮 | 16px |

lucide-vue v1.23.0，重命名映射：Loader2→LoaderCircle, FileEdit→FilePen, TerminalSquare→SquareTerminal, AlertTriangle→TriangleAlert, Layers3→Layers, Wand2→Wand。

**block icon**：thinking=Brain / tool-bash=SquareTerminal / tool 兜底=SquareFunction / subagent=Bot / workflow=Workflow。

---

## 5. 设计稿完整清单

所有规格 HTML 位于 `docs/page-design/` 根目录（**无 v6 子目录**，平铺）。共 **20 个 v6-* 文件**（1 MD + 19 HTML）。

### 5.1 设计文档（MD）

| 文件 | 用途 | 状态 |
|------|------|------|
| [v6-design.md](./v6-design.md) | **SSOT 主文档**：五原则 + token 变更 + 组件范式 + 分视图设计 + 架构重构 + 实施波次 | 定稿 |
| [design-tokens.md](./design-tokens.md) | 原子 SSOT（色/字/距/影/动效） | 待 v6 反写 |
| [design-system.md](./design-system.md) | 组件原语层 | 待 v6 反写 |
| [visual-modernization-2026-07.md](./visual-modernization-2026-07.md) | v6 输入，被 v6-design.md 取代 | 保留追溯 |
| [README.md](./README.md) | 索引（⚠️ 仍以 v3 为准，未提及 v6，待更新） | 滞后 |

### 5.2 核心布局 / 对话流视觉稿

| 文件 | 覆盖范围 | 行数 |
|------|----------|------|
| [v6-spec-tokens.html](./v6-spec-tokens.html) | Token 集 + 标注规范 + 页面骨架 CSS（**所有 spec 引用的 token SSOT**） | 1,128 |
| [v6-demo.html](./v6-demo.html) | 综合交互 demo（视觉验收 SSOT） | 1,276 |
| [v6-spec-container.html](./v6-spec-container.html) | §1 MessageStream / §1.5 瞬时覆盖层 / §2 PanelHeader / §3 TurnMeta / §3.5 TurnRail | 1,269 |
| [v6-spec-blocks.html](./v6-spec-blocks.html) | §4-7, §10, §10.5, §11, §11.5 消息块（thinking/bash/tool/subagent/workflow） | 1,569 |
| [v6-spec-content.html](./v6-spec-content.html) | assistant 正文 markdown / 代码块 / 表格 / TurnSummary hover actions | 1,081 |
| [v6-spec-input.html](./v6-spec-input.html) | §8, §8.5, §9 输入区（Composer 6 区 / QueueBubble / CommandPopover） | 1,161 |

> 原 `v6-spec-conversation.html` 已拆分为上述 blocks/container/content/input 四个 cluster 文件，作为骨架基准（`.doc-sub` 820px / `.spec-desc` 860px / `.page` 1320px / `.doc-title` 28px 600）。

### 5.3 Shell / 侧栏 / Drawer 视觉稿

| 文件 | 覆盖范围 | 行数 |
|------|----------|------|
| [v6-spec-shell.html](./v6-spec-shell.html) | Shell 三栏 + 三层明度 + traffic-light + 折叠态 | 1,368 |
| [v6-spec-sidebar.html](./v6-spec-sidebar.html) | 4 tab / SegmentedTab / SessionItem / ForkGroup / FileTree | 1,442 |
| [v6-spec-drawer.html](./v6-spec-drawer.html) | Drawer 9 sections（§1-§5 W3-A + §6-§9 W3-B），**含新增 subagent/workflow tab**（形态 B：icon 一级 + 各 tab 自治二级） | 2,552 |
| [v6-spec-drawer-tabs-demo.html](./v6-spec-drawer-tabs-demo.html) | Drawer 二级 tab 形态 B 交互 demo | 333 |

### 5.4 Overlays 视觉稿

| 文件 | 覆盖范围 | 行数 |
|------|----------|------|
| [v6-spec-overlays.html](./v6-spec-overlays.html) | SearchModal / AskUserOverlay / ConfirmDialog / MermaidRenderer（companion-band 视觉定义） | 1,225 |

### 5.5 Settings 视觉稿（6 个，最近完成三阶段闭环）

| 文件 | 覆盖范围 | 行数 | 备注 |
|------|----------|------|------|
| [v6-spec-settings-shell.html](./v6-spec-settings-shell.html) | **SSOT 基准**（tokens / design-system / 按钮范式唯一真相源，§6 控件范式 L334-367） | 1,467 | 权威 |
| [v6-spec-settings.html](./v6-spec-settings.html) | 旧版总览 | 1,289 | ⚠️ 过时 |
| [v6-spec-settings-provider.html](./v6-spec-settings-provider.html) | Provider 设置页（改动最大，ProviderEdit 改嵌入式面板） | 2,063 | |
| [v6-spec-settings-resources.html](./v6-spec-settings-resources.html) | 资源页（LoadPaths 双分组范式参考） | 1,292 | |
| [v6-spec-settings-system-prompt.html](./v6-spec-settings-system-prompt.html) | System Prompt 页 | 1,322 | |
| [v6-spec-settings-extension.html](./v6-spec-settings-extension.html) | 扩展页（§9 新增扫描目录管理） | 1,539 | |

### 5.6 Plugin 视觉稿（2 个）

| 文件 | 覆盖范围 | 行数 |
|------|----------|------|
| [v6-spec-plugin-rendering.html](./v6-spec-plugin-rendering.html) | 插件渲染 spec（5 维度 × 3 级别 × 16 挂载点 × 7 原语 / ANSI） | 2,000 |
| [v6-plugin-max-demo.html](./v6-plugin-max-demo.html) | 插件最大化 demo（虚构 Pipeline Commander，16 挂载点全亮） | 1,181 |

### 5.7 关联设计文档

| 路径 | 用途 |
|------|------|
| [docs/architecture/renderer-target-architecture.md](../architecture/renderer-target-architecture.md) | 渲染器目标架构 SSOT（§3/§5/§9.2/§10） |
| [docs/architecture/adr/0018-*.md](../architecture/adr/) | 冷蓝暗色视觉方向 ADR（2026-06-18，推翻 Warm & Soft） |

---

## 6. 分视图设计摘要

### 6.1 对话流（assistant 居中 720）

- **MessageStream**：assistant 区套 `mx-auto max-w-[var(--content-max-w)]`；UserBubble 右浮窄气泡（max-w-76%）；滚动条贴右缘
- **TurnMeta**：pill 默认可见；删 turn 间 `hr` 分隔线改加大 turn gap；重试中态 RetryIndicator 迁入（label 切「重试中 N/M」+ warn 色 spinner）
- **Block·thinking**：收起态预览 `text-neutral-mid`；1 行 ellipsis（60 字符截断）
- **Block·bash**：区分 BashOutputBlock（composer `!` 前缀，不可折叠）vs tool-bash（agent 调用，嵌 §6 tool 块，可折叠）
- **Block·tool**：状态矩阵 collapsed/expanded × running/done/failed/unfinished；failed 不切 icon（保留原 tool icon），exit≠0 加 mono `exit N` 中性标签
- **Block·subagent**：collapsed only，点击 → drawer subagent tab 嵌套只读对话流
- **Block·workflow**：collapsed only，点击 → drawer workflow tab agent call 列表
- **UserBubble**：删 border，仅 `bg-surface-hover`；删 pending 态（迁 QueueBubble）；skill/file badge 与 composer chip 同风格
- **QueueBubble**：内嵌 composer-box 顶部，去脉冲，前 2-3 条 +「+N」
- **Composer**：6 区（QueueBubble / staging chip / ContextChipsBar / landing meta-row / Input / composer-bar）；chip 统一纯文字+前缀 icon+加粗；CommandPopover 单行布局
- **ChangeSetCard**：去 border，`bg-surface` + 10px 圆角；状态 badge 降灰阶
- **PanelHeader**：去 `border-b`，用 bg-elevated 浮起分层

### 6.2 侧栏（4 tab + 容器）

- 底色 `bg-bg`（画布色）；SegmentedTab 见 §3.1；SessionItem 选中态 §3.2；组标题去 uppercase（AI slop）；ForkGroup 去 border 改缩进；FileTree 缩进 14→10px gap 6→4px

### 6.3 右侧 Drawer（8 tab，新增 subagent + workflow）

- 底色 `bg-bg`；去硬 border-l 改投影分隔 `shadow: -12px 0 24px rgba(0,0,0,.25)`；SplitterResizeHandle 透明化
- **形态 B**：icon 一级 + 各 tab 自治二级
  - detail：多文件 tab（点文件新开/切换/关闭）
  - terminal：多实例 tab + 新增按钮占位
  - git/doc/tasks：无二级 tab
  - subagent（新增）：嵌套只读对话流（无 composer）
  - workflow（新增）：phase 分组 + agent call 列表，点 agent call 切 subagent tab

### 6.4 设置页（全屏覆盖重构）

- **FullSettingsOverlay**：新建，手写 `fixed inset-0`（不用 reka Dialog），无遮罩/无模糊，左 nav w-220px + 右内容滚动
- nav 选中态 §3.2；内容区左对齐 + max-w-720px
- 10 个分组卡片去 border 改 `bg-card` + 10px 圆角；行分隔 hairline 降 `rgba(255,255,255,.04)`
- 每行 label 下加 12px `--neutral-dim` 描述文字
- ProviderEditModal → 嵌入式面板（点编辑→右侧内容交换 + 返回，不再双层 modal）
- 表单 label 去 uppercase tracking-wider

### 6.5 Overlays

- **SearchModal**：保持手写覆盖层；去 border-b 靠 padding；高亮改 font-semibold
- **AskUserOverlay**：内联（非 modal）；context 降中性
- **ConfirmDialog**：圆角 12px；danger 三角 icon 降 size-4
- **MermaidRenderer**：保持现状

### 6.6 Plugin（16 挂载点 / 7 原语）

- **5 维度**：A 结构注入 / B 对话流注入 / C 交互对话框（降级）/ D 命令配置 / E 独立 view
- **16 挂载点（M1-M16）**：M8 底栏从跨全宽改 main-panel 内局部底栏；M11 companion-band 成为统一交互出口（ask-user + confirm/select/input）；M15 降级（仅致命错误）
- **7 原语**：card / stats-line / progress-bar / list-tree / columns / tab-bar / ansi-text
- **交互闭环**：6 个完整闭环（M4/M5/M7/M8/M11/M15）+ 6 个声明式空壳 + 2 个 API 缺口（`commands.register` / `views.update`）

---

## 7. 架构与实施（摘要，详见 v6-design.md §6-§8）

### 执行时序

```
阶段 0：测试基础设施（coverage + E2E 进 CI + dev-smoke + TEST-STRATEGY.md）
  ↓
阶段 A：整体架构重构（runtime 三层契约 / shared 瘦身 / IPC 收敛）
  ↓
阶段 B：renderer 局部重构（useChat 状态范式 / Composer 合并 / Sidebar 拆分）
  ↓
阶段 C：v6 视觉层（token 反写 → 对话流 → 侧栏 → Drawer → 设置 → Overlays → 横切清理 → 全量验收）
```

### 验收基准

- **视觉**：`v6-demo.html` 目标态为 SSOT；三层背景肉眼可辨；impeccable AI slop test 通过；正文全部过 WCAG AA
- **架构**：整体架构图进程职责/通信机制/包依赖在代码中一致；runtime 三层契约名实相符；shared 无运行期实现；IPC 仅 OS 特权
- **测试**：coverage 启用进 CI；E2E 双轨进 CI；对话流/session 生命周期/设置持久化有 E2E 覆盖
