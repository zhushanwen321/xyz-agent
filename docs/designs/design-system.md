# Design System · 组件原语层（zcode 冷蓝暗色）

> **定位**：`design-tokens.md` 定义**原子值**（色/字/距/影/动效），本文件定义**组件原语如何使用这些值**——形态、状态、边界。不重复 token 值。所有 draft 的组件必须从本文件原语派生，禁止各稿自造变体。

## 1. 三层关系

```
design-tokens.md   ← 原子：存在哪些值
design-system.md   ← 原语：值如何拼成可复用部件（本文件）
各 spec.md / draft ← 模块：原语如何组合成一个功能
```

## 2. 卡片族（Card Family）★最高频复用

本产品几乎所有信息块都是"卡片变体"。统一骨架，差异在密度与强调方式：

| 原语 | 场景 | 背景 | 边框 | 圆角 | 内边距 | 关键差异 |
|---|---|---|---|---|---|---|
| Card | 默认信息容器 | `--surface` | `--border` | `--radius` | 12–16 | 基准 |
| Card-Elevated | 浮起（抽屉/浮层内） | `--surface-2` | `--border-strong` | `--radius-lg` | 16–20 | +阴影，脱离背景 |
| Card-Inline | 消息流内嵌（ToolCall/ChangeSet） | `--surface` | `--border` | `--radius` | 10–12 | 紧凑，左缘可加状态色条 |
| Card-Active | 当前焦点（选中 Item/Panel） | `--surface-2` | `1px accent-ring` inset | `--radius` | 12 | inset ring 不改盒模型、不抖动；半透明避免中缝双线 |

**反模式**：禁止用「左色条 + 亮底卡片」做强调（典型 AI slop）。强调走 Card-Active 的 inset ring，或非焦点态整体 opacity 退后。

> **边界澄清**：此反模式针对的是**卡片强调**（用左色条替代 Card-Active inset ring 做焦点/选中态）。编辑式 admonition（`.note` / `.warn` callout）用左色条区分类型（note=accent / warn=danger）是 callout 标准范式，**不属此反模式**——它是文档内联提示的分类标记，不是卡片选中手段。settings shell + 5 份 per-menu draft 的 `.note` 均沿用此范式（`border-left:2px solid` + surface 底），与 Card-Active 并存不冲突。

## 3. 按钮（Button）

| 变体 | 用途 | 样式 |
|---|---|---|
| Primary | 主操作（发送/确认/提交） | `--accent` 实色底 + 白字 |
| Secondary | 次操作（暂存/取消） | 透明底 + `--border` + `--fg` |
| Ghost | 图标操作（关闭/更多/展开） | 透明，hover 出 `--surface-hover` |
| Danger | 删除/终止/拒绝 | `--danger` 字 + hover soft 底 |

高度 32（dense）/ 36（默认）/ 44（移动命中区）。圆角 `--radius`。禁用 opacity 0.4 + not-allowed。

> **focus ring 语境说明（P1-2 裁决）**：Button 用 shadcn 外环 + offset（`focus-visible:ring-2 ring-ring ring-offset-2`），与实色/透明底视觉分离，是 shadcn 惯例。本节**不要求** Button 改 inset ring——§4 的"聚焦 inset ring，同 Card-Active 手法"是 Input/Textarea 专属（容器型原语，inset 表达边界聚焦）。Button 是操作型原语，外环表达可点击焦点，两语境故意不同，不统一。

## 4. 输入（Input / Textarea）

背景 `--surface-2`，边框 `--border`，聚焦 `--accent` 1px ring（inset，同 Card-Active 手法）。placeholder `--subtle`。错误态 `--danger` 边框 + 下方错误文案。Composer 多行自动高，最小 40，shift+enter 换行。Textarea 原语默认 min-height 40px，Composer 场景沿用；如需更大可 class 覆写。

> **错误文案职责分层（P1-3 裁决）**：原子 Input/Textarea 只负责 `error?: boolean` 触发 `border-danger`（边框态）。"下方错误文案"归**表单层** FormMessage（shadcn 体系惯例），由包裹 Input 的 Form/FormItem 提供。项目当前无 `components/ui/form/` 表单层，待引入表单场景（如 Settings 校验）时补 FormMessage；在此之前 Input 仅暴露 `error` border 态，不自带文案 prop。

## 5. 标签族（Pill / Chip / Badge / Status Dot）★强制区分

四者极易混用，按语义强制区分：

| 原语 | 语义 | 形态 | 例 |
|---|---|---|---|
| Pill | 分类/状态标签 | 圆角 999，soft 底，mono 字 | `running` `done`、分支名 |
| Chip | 引用实体（@mention） | 圆角 999，带前缀图标 | `@file.ts` `@skill` |
| Badge | 计数角标 | 小圆，`--accent`/`--danger` 底白字 | "3 待审" |
| Status Dot | 极简状态 | 6–8px 圆点，状态色 | 会话运行中绿点 |

## 6. 图标系统

统一 SVG `<symbol>` + `<use>`（sidebar draft 已采用），不自造 img。stroke-width 1.5，size 16/20/24，currentColor 继承。状态图标用状态色填充，操作图标 `--muted`、hover `--fg`。禁止 emoji 作功能图标。

## 7. 空状态（Empty State）

三要素：图标（subtle）+ 一句说明 + 一个 Primary 入口。禁止纯"暂无数据"。

## 8. 加载（Loading）

首屏内容区用骨架屏（shimmer）；按钮/异步动作用行内 spinner（14px accent）；流式内容用光标脉冲，不用 spinner。

## 9. 文案语气

- 操作按钮：动词开头（"发送"/"暂存"/"终止"），不用"确认"/"好的"。
- 错误：说原因 + 下一步（"网络断开，已暂停 · 重连"），不只报错码。
- 空状态：指向动作（"新建一个会话开始"）。

## 10. 暗色为主，亮色为辅

暗色（`--bg #0d0d0f`）是默认与优先打磨对象。亮色为备选，token 已备但**视觉未校准**（见 design-tokens 待办）。新 draft 一律暗色优先；亮色稿在暗色全部定稿后再做。

---

**关联**：原子值见 `design-tokens.md` · 术语见 `v3-demo/architecture-and-terminology.html` · 视觉决策见 `v3-demo/adr-0001-visual-direction.md`
