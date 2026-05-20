---
verdict: pass
---

# Markdown 渲染增强

## Background

xyz-agent 的 AI 对话输出当前使用 markdown-it 零插件 + DOMPurify 极简渲染，仅 ~15 行代码。代码块无语法高亮、无样式；标题/列表/引用块/表格全部裸奔；不支持 KaTeX 数学公式和 Mermaid 图表。

这是技术债 #7（Markdown 渲染质量低），也是 Phase 0.4 规划的任务。

## 决策记录

| # | 决策 | 结论 | 理由 |
|---|------|------|------|
| D1 | 代码高亮库 | **Shiki** | VSCode 级高亮质量，支持所有 VSCode 主题，Electron 中包体积可接受 |
| D2 | KaTeX 渲染方式 | **markdown-it-texmath 插件**（解析阶段渲染） | 业界标准做法，KaTeX 输出纯 HTML/CSS 无安全风险，texmath 支持最全的分隔符格式 |
| D3 | Mermaid 渲染方式 | **客户端渲染**（markdown-it 输出 `<div class="mermaid">` 占位，浏览器端 `mermaid.run()`） | 业界标准做法，无可靠的 markdown-it 服务端插件，客户端渲染更可靠且可懒加载 |
| D4 | Shiki 主题 | **跟随应用主题自动切换**（亮色用 GitHub Light，暗色用 One Dark Pro） | 与应用整体视觉一致 |
| D5 | 排版风格 | **GitHub 风格** | 用户选择，干净克制、开发者熟悉 |
| D6 | 流式渲染策略 | **增量渲染**：流式阶段轻量渲染（纯文本代码块、跳过 KaTeX/Mermaid），`complete=true` 后切换完整渲染 | ChatGPT/Claude 的做法，避免 Shiki/KaTeX/Mermaid 计算开销导致掉帧 |
| D7 | DOMPurify 配置 | 需要更新白名单，允许 KaTeX/Mermaid 生成的合法属性 | 当前的 DOMPurify 默认配置可能过滤掉 `class`、`style`、`aria-*` 等合法属性 |

## Functional Requirements

### FR1: 代码块语法高亮（Shiki）

- 所有 fenced code block 使用 Shiki 进行语法高亮
- 自动检测语言（从 fence 标记 `` ```python `` 中提取）
- 无语言标记的代码块使用纯文本渲染（无高亮）
- 输出带内联样式的 HTML（Shiki 的 `inline style` 模式），不依赖外部 CSS 主题文件

### FR2: 代码块 UI 功能

- **语言标签**：代码块右上角显示语言名（如 `python`、`typescript`）
- **复制按钮**：一键复制代码内容，点击后显示"已复制"反馈，1.5s 后恢复
- **行号**：代码块左侧显示行号，不可选中，与代码区有分隔线
- **文件名标签**：支持 `` ```python:main.py `` 格式，文件名显示在代码块头部
- **折叠/展开**：超过 20 行的代码块默认折叠，显示前 10 行 + "展开" 按钮；展开后显示全部 + "收起" 按钮

### FR3: GFM 表格

- 支持 GitHub Flavored Markdown 表格语法
- 表格样式：border-collapse、padding、表头背景、斑马纹
- 长表格横向滚动（overflow-x: auto）

### FR4: 完整排版样式（GitHub 风格）

- **标题 h1-h4**：不同字号/字重，h1/h2 带底部边框
- **有序/无序列表**：正确的缩进层级、list-style、li 间距
- **引用块**：左边框 + 缩进 + 灰色文字
- **行内代码**：背景色 + 等宽字体 + 小圆角
- **链接**：蓝色、无下划线、hover 加下划线
- **分隔线**：2px 实线、上下 margin
- **粗体/斜体**：正确的字重/样式
- **删除线**：`~~text~~` 渲染为删除线 + 灰色

### FR5: 任务列表

- 支持 `- [x]` 和 `- [ ]` 语法
- 渲染为带 checkbox 的列表项
- checkbox 不可交互（只读展示，AI 输出不可编辑）

### FR6: KaTeX 数学公式

- 行内公式：`$...$` 渲染为行内 KaTeX
- 块级公式：`$$...$$` 渲染为居中块级 KaTeX
- 错误处理：`throwOnError: false`，解析失败的公式显示原始 LaTeX 文本（红色）
- 加载 `katex.min.css`（~50KB）

### FR7: Mermaid 图表

- `` ```mermaid `` 代码块渲染为 Mermaid 图表
- 流式阶段显示代码块原文（不渲染图表），完成后渲染
- 安全：`securityLevel: 'sandbox'`，禁止 click 事件和外部 URL
- 主题跟随应用主题（`default` / `dark`）
- 懒加载：只在页面存在 mermaid 代码块时加载 mermaid.js（~3MB）
- Mermaid 渲染失败时 fallback 显示代码块原文 + 错误提示

### FR8: 流式渲染策略

- **流式阶段**（`message.complete === false`）：
  - 代码块：纯文本 `<pre><code>` 渲染，无高亮、无行号、无复制按钮
  - KaTeX/Mermaid：不渲染，显示原始文本
  - 其他 markdown 元素：正常渲染（标题/列表/引用等）
- **完成阶段**（`message.complete === true`）：
  - 一次性替换为完整渲染结果（Shiki 高亮 + 行号 + 复制按钮 + KaTeX + Mermaid）
  - 用 `requestAnimationFrame` 确保不阻塞 UI

### FR9: 主题切换

- Shiki 主题跟随应用主题：
  - 亮色：`github-light`
  - 暗色：`one-dark-pro`
- 排版 CSS 通过 CSS 变量适配亮/暗色（已有 `[data-theme]` 机制）
- Mermaid 主题跟随应用主题
- 主题切换时，已渲染的消息需要重新渲染（Shiki 需要换主题重新生成 HTML）

### FR10: 安全性

- DOMPurify 白名单更新：允许 KaTeX 生成的 `class`、`style`、`aria-*` 属性
- Mermaid `securityLevel: 'sandbox'`
- `markdown-it` 保持 `html: false`
- Mermaid 渲染后的 SVG 需经过 DOMPurify 过滤

## Acceptance Criteria

### AC1: 代码高亮
- [ ] Python 代码块正确高亮关键字、字符串、注释、函数名
- [ ] TypeScript/JavaScript 代码块正确高亮
- [ ] Bash/Shell 代码块正确高亮
- [ ] JSON/YAML 代码块正确高亮
- [ ] 未知语言的代码块显示纯文本（不错误高亮）

### AC2: 代码块 UI
- [ ] 语言标签显示在代码块右上角
- [ ] 复制按钮点击后剪贴板内容与代码块内容一致
- [ ] 行号正确显示（从 1 开始），不可选中
- [ ] `` ```python:main.py `` 文件名显示在头部
- [ ] 超过 20 行的代码块默认折叠，点击展开/收起正常工作

### AC3: 排版
- [ ] h1-h4 有明确的大小和字重区分，h1/h2 有底部边框
- [ ] 有序/无序列表缩进正确，嵌套列表层级正确
- [ ] 引用块有左边框和灰色文字
- [ ] 表格有边框、padding、表头背景、斑马纹
- [ ] `~~text~~` 显示删除线

### AC4: 任务列表
- [ ] `- [x] done` 渲染为勾选的 checkbox + 文字
- [ ] `- [ ] todo` 渲染为空 checkbox + 文字
- [ ] checkbox 为只读，不可点击

### AC5: KaTeX
- [ ] `$E=mc^2$` 正确渲染为行内公式
- [ ] `$$\sum_{i=1}^n i = \frac{n(n+1)}{2}$$` 正确渲染为块级公式
- [ ] 无效公式显示原始 LaTeX 文本（不抛错）

### AC6: Mermaid
- [ ] 简单 flowchart 正确渲染为 SVG
- [ ] sequence diagram 正确渲染
- [ ] 暗色主题下 Mermaid 使用 dark 主题
- [ ] 无效的 mermaid 语法显示错误提示 + 原始代码

### AC7: 流式渲染
- [ ] 流式阶段代码块为纯文本，无闪烁
- [ ] 消息完成后切换到高亮渲染，过渡平滑
- [ ] 流式阶段无 KaTeX/Mermaid 渲染开销

### AC8: 主题切换
- [ ] 从亮切暗后，代码块高亮颜色正确切换
- [ ] 从暗切亮后，代码块高亮颜色正确切换
- [ ] 排版元素（引用/表格/代码背景）颜色跟随主题

### AC9: 性能
- [ ] 单条消息（~5000 字符含 3 个代码块）完成渲染 < 100ms
- [ ] 流式阶段无感知延迟（每帧 < 16ms）
- [ ] 100 条历史消息滚动流畅（Mermaid 懒加载，不一次性渲染所有图表）

## Constraints

### 技术约束
- 使用 markdown-it 生态（不迁移到 remark/rehype）
- 渲染在 Electron renderer 进程中执行（无 Node.js 文件系统访问限制，Shiki 可用 WASM）
- 现有 `renderMarkdown()` API 不能破坏性变更（向后兼容），但可新增参数
- DOMPurify 必须保留，安全不可降级

### 依赖约束
- Shiki: ^3.x（最新稳定版）
- markdown-it-texmath: ^1.0
- katex: ^0.16
- mermaid: ^11
- markdown-it: 已有 14.1.1，不升级

### 范围外（Out of Scope）
- LaTeX 实时预览编辑器（只渲染 AI 输出）
- Mermaid 图表交互（点击节点、缩放）—— `securityLevel: 'sandbox'` 下不支持
- 代码块 diff 高亮（`` ```diff `` 语法高亮是 Shiki 内置支持的，但不做专门的 diff 视图）
- 图片渲染优化（`![](url)` 由 markdown-it 内置支持，不做额外处理）
- 消息重试/编辑功能
- 代码块内的搜索功能

## Complexity Assessment

| 维度 | 评级 | 说明 |
|------|------|------|
| 领域复杂度 | **中** | Markdown 渲染是成熟领域，API 稳定。主要工作是集成和配置，不是算法设计 |
| 存储复杂度 | **低** | 无新增持久化需求，渲染结果不存储（每次 computed 重新生成） |
| 数据流复杂度 | **中** | 流式/完成两阶段渲染需要状态管理，主题切换需要重新渲染 |
| API 复杂度 | **低** | 不新增 API，只修改 `renderMarkdown()` 和 `MessageBubble.vue` |
| 非功能需求 | **中** | 性能（流式不卡顿）、安全（DOMPurify + Mermaid sandbox）、主题切换一致性 |

## 已有基础设施

| 组件 | 文件 | 当前状态 |
|------|------|---------|
| Markdown 渲染 | `src-electron/renderer/src/lib/markdown.ts` | markdown-it 零插件 + DOMPurify，~15 行 |
| 消息气泡 | `src-electron/renderer/src/components/chat/MessageBubble.vue` | `v-html="renderedContent"`，仅行内 code 和 p 的 CSS |
| 设计系统 CSS 变量 | `src-electron/renderer/src/assets/style.css` | 已有 `--bg`、`--fg`、`--accent` 等 CSS 变量和 `[data-theme]` 机制 |
| 主题切换 | `src-electron/renderer/src/composables/useTheme.ts` | 已有明/暗主题切换能力 |
| 流式消息状态 | `src-electron/renderer/src/stores/chat.ts` | `message.complete` 字段已存在 |
