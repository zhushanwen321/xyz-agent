---
verdict: pass
---

# Markdown 渲染增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI 对话输出的 Markdown 渲染从极简实现升级为完整的渲染管线，包含 Shiki 代码高亮、KaTeX 数学公式、Mermaid 图表、GitHub 风格排版，以及流式/完成两阶段渲染策略。

**Architecture:** 重构 `lib/markdown.ts` 为双阶段渲染管线（`renderLightweight` + `renderFull`）。MessageBubble.vue 根据 `message.status` 选择渲染阶段。Markdown 排版样式用 `<style scoped>` 覆盖（Tailwind 无法作用于 v-html 动态内容）。Mermaid 通过 Vue 组件的 `onMounted`/`watch` 在客户端懒加载渲染。

**Tech Stack:** markdown-it + Shiki + markdown-it-texmath + KaTeX + Mermaid + DOMPurify

---

## Tasks

### Task 1: 安装依赖

**Type:** infra

**Files:**
- Modify: `src-electron/renderer/package.json`

- [ ] **Step 1: 安装 npm 依赖**

```bash
cd src-electron/renderer
npm install shiki markdown-it-texmath katex mermaid
```

- [ ] **Step 2: 验证安装**

```bash
cd src-electron/renderer
node -e "require('shiki'); require('markdown-it-texmath'); require('katex'); require('mermaid'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/package.json src-electron/renderer/package-lock.json
git commit -m "chore: add shiki, markdown-it-texmath, katex, mermaid dependencies"
```

---

### Task 2: 重构渲染管线 — `lib/markdown.ts`

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/lib/markdown.ts`

当前文件 ~15 行。重构为双阶段渲染管线：

**导出 API：**
```typescript
// 流式阶段：轻量渲染（纯文本代码块、跳过 KaTeX/Mermaid、跳过 Shiki）
export function renderLightweight(text: string): string

// 完成阶段：完整渲染（Shiki 高亮 + KaTeX + Mermaid 占位 + 全排版）
export function renderFull(text: string, theme: 'light' | 'dark'): Promise<string>
```

**markdown-it 配置：**
```typescript
import MarkdownIt from 'markdown-it'
import texmath from 'markdown-it-texmath'
import katex from 'katex'

// 两个实例：轻量（无插件）和完整（全插件）
const mdLight = new MarkdownIt({ html: false, linkify: true, typographer: true })
  .enable('strikethrough')  // ~~text~~
  .enable('table')          // GFM 表格

const mdFull = new MarkdownIt({ html: false, linkify: true, typographer: true })
  .use(texmath, { engine: katex, delimiters: 'dollars', katexOptions: { throwOnError: false } })
  .enable('strikethrough')
  .enable('table')
```

**Mermaid fence renderer（仅 mdFull）：**
```typescript
// 将 ```mermaid 代码块渲染为 <div class="mermaid-source" data-mermaid> 原文 </div>
// 由 Vue 组件在客户端用 mermaid.run() 渲染
const defaultFence = mdFull.renderer.rules.fence!
mdFull.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token.info.trim() === 'mermaid') {
    const escaped = token.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    return `<div class="mermaid-source" data-mermaid>${escaped}</div>`
  }
  return defaultFence(tokens, idx, options, env, self)
}
```

**Shiki 高亮（仅 renderFull）：**
```typescript
import { codeToHtml } from 'shiki'

// 任务列表渲染器
// 将 - [x] / - [ ] 转为 <li class="task-list-item"><input type="checkbox" checked/disabled> text</li>
```

**代码块后处理：**
- `renderFull` 需要后处理 Shiki 输出，添加代码块头部（语言标签 + 文件名 + 复制按钮）和行号
- 使用正则匹配 `<pre ...><code ...>` 块，替换为包含头部的结构

**DOMPurify 配置更新：**
```typescript
import DOMPurify from 'dompurify'

// 允许 KaTeX/Mermaid 需要的属性
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  // 保留 data-mermaid 属性
  // 保留 style 属性（Shiki inline styles, KaTeX styles）
  // 保留 aria-* 属性（KaTeX accessibility）
  // 保留 class 属性（KaTeX CSS classes）
})
```

- [ ] **Step 1: 重写 `lib/markdown.ts`**

实现 `renderLightweight()` 和 `renderFull()` 两个导出函数。`renderLightweight` 是同步的，`renderFull` 是异步的（因为 Shiki `codeToHtml` 是异步的）。

注意：
- `renderFull` 内部对每个 fenced code block 调用 `codeToHtml()`，拿到高亮 HTML 后组装完整输出
- Shiki 使用 `createHighlighter` 或 `codeToHtml` API，按 `theme` 参数选择亮/暗主题
- 任务列表需要自定义 markdown-it renderer：将 `- [x] done` → `<li class="task-list-item"><input type="checkbox" checked disabled>done</li>`
- KaTeX CSS 由 `katex` 包自带，需要在入口引入（见 Task 4）
- 行号通过在 `<pre>` 内添加 `<span class="line-numbers">` 实现，每行一个 `<span>`
- 文件名从 fence info 解析：`` ```python:main.py `` → info = `python:main.py`，拆分为 lang = `python`, filename = `main.py`
- 折叠功能通过 CSS class 控制：超过 20 行的代码块加 `class="code-block-collapsed"`，通过 `<button class="code-expand-btn">` 切换

- [ ] **Step 2: 验证编译**

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-markdown-render
npx vue-tsc --noEmit --project src-electron/renderer/tsconfig.json 2>&1 | head -30
```

Expected: 无类型错误（可能有 markdown-it/texmath 的 @ts-expect-error，可接受）

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/lib/markdown.ts
git commit -m "feat: refactor markdown rendering pipeline with dual-stage support"
```

---

### Task 3: 代码块 UI 组件

**Type:** frontend

**Files:**
- Create: `src-electron/renderer/src/components/chat/CodeBlock.vue`
- Create: `src-electron/renderer/src/components/chat/MermaidBlock.vue`

这两个组件不直接被 markdown-it 调用，而是通过 MessageBubble 在 `renderFull` 完成后，对渲染结果中的特殊标记做二次处理。

**CodeBlock.vue — 不需要，代码块 UI 全部在 markdown.ts 的 HTML 后处理中完成**

实际上代码块的头部（语言标签 + 文件名 + 复制按钮）、行号、折叠按钮都在 `lib/markdown.ts` 的 HTML 后处理中直接生成。但复制按钮和折叠按钮需要 JS 交互，这通过事件委托处理（见 Task 4 MessageBubble 改造）。

**MermaidBlock.vue — 不需要独立组件**

Mermaid 渲染通过 `mermaid.run()` API 统一处理，不需要独立 Vue 组件。

**结论：此 Task 简化为确认 markdown.ts 的 HTML 后处理输出正确的结构。**

- [ ] **Step 1: 确认 markdown.ts 输出的 HTML 结构**

每个代码块输出结构：
```html
<div class="code-block" data-lang="python" data-filename="main.py" data-lines="25">
  <div class="code-block-header">
    <span class="code-block-lang">python</span>
    <span class="code-block-filename">main.py</span>
    <button class="code-copy-btn" data-action="copy">复制</button>
  </div>
  <div class="code-block-body">
    <span class="line-numbers">1\n2\n3...</span>
    <!-- Shiki 高亮 HTML -->
  </div>
  <button class="code-expand-btn" data-action="expand" style="display:none">展开</button>
</div>
```

- [ ] **Step 2: Commit**

如果 Step 1 发现 markdown.ts 需要调整：
```bash
git add src-electron/renderer/src/lib/markdown.ts
git commit -m "feat: code block HTML structure with header, line numbers, copy button"
```

---

### Task 4: MessageBubble 改造 + 事件委托

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/MessageBubble.vue`

**改造内容：**

1. **双阶段渲染**：根据 `message.status` 选择 `renderLightweight` 或 `renderFull`
2. **复制按钮事件委托**：在 `.msg__body` 上监听 `click` 事件，委托处理 `.code-copy-btn`
3. **折叠按钮事件委托**：委托处理 `.code-expand-btn`
4. **Mermaid 客户端渲染**：`renderFull` 完成后，用 `mermaid.run()` 渲染 mermaid 代码块
5. **主题切换响应**：监听 theme 变化，重新调用 `renderFull`

```typescript
import { renderLightweight, renderFull } from '../../lib/markdown'
import { useSettingsStore } from '../../stores/settings'
import mermaid from 'mermaid'

const settings = useSettingsStore()

// 双阶段渲染
const renderedContent = computed(() => {
  if (props.message.status === 'streaming') {
    return renderLightweight(props.message.content)
  }
  return renderFullCache.value // 由 watch 异步更新
})

// 异步完整渲染
const renderFullCache = ref('')
watch(
  () => [props.message.content, props.message.status, settings.theme],
  async () => {
    if (props.message.status !== 'streaming') {
      const isDark = settings.theme === 'dark' ||
        (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      renderFullCache.value = await renderFull(props.message.content, isDark ? 'dark' : 'light')
      await nextTick()
      renderMermaidBlocks()
    }
  },
  { immediate: true }
)

// Mermaid 懒加载渲染
async function renderMermaidBlocks() {
  const mermaidEls = document.querySelectorAll('.mermaid-source[data-mermaid]')
  if (mermaidEls.length === 0) return
  // mermaid.initialize 和 mermaid.run
}

// 事件委托：复制 + 折叠
function handleBodyClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.matches('.code-copy-btn')) {
    const codeBlock = target.closest('.code-block')
    const code = codeBlock?.querySelector('code')?.textContent ?? ''
    navigator.clipboard.writeText(code)
    target.textContent = '已复制'
    setTimeout(() => { target.textContent = '复制' }, 1500)
  }
  if (target.matches('.code-expand-btn')) {
    const codeBlock = target.closest('.code-block')
    codeBlock?.classList.toggle('code-block-expanded')
    target.textContent = codeBlock?.classList.contains('code-block-expanded') ? '收起' : '展开'
  }
}
```

**template 改造：**
```html
<!-- Markdown content -->
<div v-if="message.content" class="msg__body select-text" @click="handleBodyClick">
  <!-- ... skillName tag ... -->
  <span v-html="renderedContent"></span>
</div>
```

**Mermaid 懒加载策略：**
- 在 `renderMermaidBlocks()` 中检测是否存在 `.mermaid-source` 元素
- 存在则动态 `import('mermaid')`，首次加载后缓存模块引用
- Mermaid 错误处理：`try { await mermaid.run() } catch { fallback 显示原文 }`

- [ ] **Step 1: 改造 MessageBubble.vue**

替换 `renderedContent` computed 为双阶段渲染逻辑，添加事件委托和 Mermaid 渲染。

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit --project src-electron/renderer/tsconfig.json 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/components/chat/MessageBubble.vue
git commit -m "feat: dual-stage markdown rendering with event delegation"
```

---

### Task 5: GitHub 风格 Markdown 排版 CSS

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/MessageBubble.vue`（`<style scoped>` 部分）

在 MessageBubble 的 `<style scoped>` 中添加完整的 GitHub 风格 Markdown 排版样式。所有样式通过 `.msg__body` 前缀限定作用域。

**必须覆盖的元素：**

| 元素 | 样式要求 |
|------|---------|
| `h1, h2` | 底部边框 `border-bottom: 1px solid var(--border)` |
| `h1` | `font-size: 1.5em; font-weight: 700` |
| `h2` | `font-size: 1.25em; font-weight: 600` |
| `h3` | `font-size: 1.1em; font-weight: 600` |
| `h4` | `font-size: 1em; font-weight: 600` |
| `ul, ol` | `padding-left: 2em; margin-bottom: 16px` |
| `li` | `margin-bottom: 4px` |
| `blockquote` | `border-left: 0.25em solid var(--border); padding: 0 1em; color: var(--muted)` |
| `table` | `border-collapse: collapse; width: 100%` |
| `th` | `background: var(--section-bg); font-weight: 600` |
| `th, td` | `border: 1px solid var(--border); padding: 6px 13px` |
| `tr:nth-child(2n)` | `background: var(--section-bg)`（斑马纹） |
| `hr` | `border: none; border-top: 2px solid var(--border); margin: 24px 0` |
| `a` | `color: var(--accent); text-decoration: none; hover: underline` |
| `del` | `text-decoration: line-through; color: var(--muted)` |
| `.task-list-item` | `list-style: none; margin-left: -1.5em` |
| `.task-list-item input` | `margin-right: 6px` |

**代码块样式：**

| 元素 | 样式 |
|------|------|
| `.code-block` | `margin-bottom: 16px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border)` |
| `.code-block-header` | `display: flex; justify-content: space-between; background: var(--section-bg); padding: 6px 12px; font-size: 12px; color: var(--muted); font-family: var(--font-mono)` |
| `.code-block-body` | `display: flex; overflow-x: auto` |
| `.line-numbers` | `padding: 12px 8px 12px 12px; text-align: right; user-select: none; color: var(--muted); border-right: 1px solid var(--border); font-family: var(--font-mono); font-size: 13px; line-height: 1.5` |
| `.code-block pre` | `margin: 0; padding: 12px; background: transparent; flex: 1` |
| `.code-block pre code` | `font-size: 13px; line-height: 1.5; font-family: var(--font-mono)` |
| `.code-copy-btn` | `background: none; border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 2px 8px; cursor: pointer; font-size: 11px; color: var(--muted)` |
| `.code-expand-btn` | `width: 100%; padding: 6px; background: var(--section-bg); border: none; border-top: 1px solid var(--border); color: var(--muted); cursor: pointer; font-size: 12px` |

**折叠 CSS：**
```css
.code-block[data-lines="collapsed"] .code-block-body {
  max-height: calc(13px * 1.5 * 10 + 24px); /* 10 行 + padding */
  overflow: hidden;
}
.code-block.code-block-expanded .code-block-body {
  max-height: none;
}
```

**Mermaid 样式：**
```css
.mermaid-source {
  margin: 16px 0;
  padding: 16px;
  background: var(--section-bg);
  border-radius: var(--radius-sm);
  text-align: center;
}
.mermaid-error {
  color: var(--danger);
  font-size: 13px;
}
```

- [ ] **Step 1: 在 MessageBubble.vue 的 `<style scoped>` 中添加所有排版样式**

- [ ] **Step 2: 启动 dev 模式视觉验证**

```bash
npm run dev
```

在聊天中发送包含代码块、表格、引用、列表、KaTeX 公式、Mermaid 图表的消息，验证渲染效果。

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/components/chat/MessageBubble.vue
git commit -m "feat: GitHub-flavored markdown typography styles"
```

---

### Task 6: KaTeX CSS 引入 + 入口修改

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/main.ts`（或 `style.css` 中 `@import`）

KaTeX 渲染需要加载 `katex/dist/katex.min.css`（~50KB），包含数学符号字体和布局样式。

- [ ] **Step 1: 在 style.css 中引入 KaTeX CSS**

在 `src-electron/renderer/src/style.css` 的 `@tailwind` 指令之后添加：
```css
@import 'katex/dist/katex.min.css';
```

或者如果 `@import` 在 Tailwind 之后有问题，改为在 `main.ts` 中：
```typescript
import 'katex/dist/katex.min.css'
```

- [ ] **Step 2: 验证 KaTeX 样式加载**

启动 dev 模式，发送包含 `$E=mc^2$` 的消息，检查公式是否有正确的字体和间距。

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/style.css
git commit -m "feat: import KaTeX CSS for math formula rendering"
```

---

### Task 7: Shiki 主题切换优化

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/lib/markdown.ts`
- Modify: `src-electron/renderer/src/components/chat/MessageBubble.vue`

Shiki 使用 `codeToHtml(code, { lang, theme })` API，每次调用需要指定主题名称。主题切换时需要重新渲染所有已显示的消息。

**方案：**

`renderFull(text, theme)` 已经接受 `theme` 参数。MessageBubble 的 `watch` 已经监听 `settings.theme` 变化。当主题切换时，`watch` 触发重新调用 `renderFull()`，所有消息自动重新渲染。

**Shiki 主题映射：**
```typescript
const SHIKI_THEMES = {
  light: 'github-light',
  dark: 'one-dark-pro',
} as const
```

**性能注意：**
- Shiki `codeToHtml` 首次调用会加载主题和语言 grammar，后续调用有缓存
- 主题切换时可能需要 50-100ms 重新渲染一条长消息，可接受
- 如果 100 条消息全部重渲染导致卡顿，加 `requestAnimationFrame` 分批处理

- [ ] **Step 1: 确认 renderFull 正确使用 Shiki 主题参数**

- [ ] **Step 2: 测试主题切换**

切换亮/暗主题，验证代码块高亮颜色正确切换。

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/lib/markdown.ts src-electron/renderer/src/components/chat/MessageBubble.vue
git commit -m "feat: shiki theme switching with light/dark support"
```

---

### Task 8: 集成测试 + 边界用例

**Type:** frontend

**Files:**
- 无新增文件（在 dev 模式中手动测试）

**测试矩阵：**

| 用例 | 输入 | 预期 |
|------|------|------|
| 纯文本 | `Hello world` | 正常段落 |
| 代码块（有语言） | `` ```python\nprint("hi")\n``` `` | Shiki 高亮 + 语言标签 + 复制按钮 |
| 代码块（无语言） | `` ```\nplain text\n``` `` | 纯文本渲染，无语言标签 |
| 代码块（有文件名） | `` ```ts:main.ts\nexport {}\n``` `` | 显示文件名 `main.ts` |
| 长代码块（>20行） | 30 行代码 | 默认折叠，显示前 10 行 + 展开按钮 |
| GFM 表格 | `\| a \| b \|\n\|---\|---\|\n\| 1 \| 2 \|` | 表格有边框和斑马纹 |
| 任务列表 | `- [x] done\n- [ ] todo` | checkbox（勾选/未勾选） |
| 删除线 | `~~old~~` | 删除线效果 |
| 行内 KaTeX | `$E=mc^2$` | 渲染为数学公式 |
| 块级 KaTeX | `$$\sum_{i=1}^n i$$` | 渲染为居中块级公式 |
| 无效 KaTeX | `$\invalid{$` | 显示原文 |
| Mermaid flowchart | `` ```mermaid\ngraph TD; A-->B\n``` `` | 渲染为 SVG 流程图 |
| 无效 Mermaid | `` ```mermaid\ninvalid{[\n``` `` | 显示错误提示 + 原文 |
| 引用块 | `> quote text` | 左边框 + 灰色文字 |
| 有序/无序列表 | 嵌套列表 | 正确缩进 |
| 分隔线 | `---` | 横线 |
| 流式渲染 | 发送消息观察 | 流式阶段纯文本，完成后高亮 |
| 主题切换 | 切换亮/暗 | 代码块颜色、排版颜色跟随切换 |
| 空 markdown | `""` | 无输出 |

- [ ] **Step 1: 逐项测试上表用例**

- [ ] **Step 2: 修复发现的问题**

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete markdown rendering with shiki, katex, mermaid"
```

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/renderer/package.json` | modify | FG1 | 添加依赖 |
| `src-electron/renderer/src/lib/markdown.ts` | rewrite | FG1 | 双阶段渲染管线 |
| `src-electron/renderer/src/components/chat/MessageBubble.vue` | modify | FG1 | 双阶段渲染 + 事件委托 + 排版 CSS |
| `src-electron/renderer/src/style.css` | modify | FG1 | KaTeX CSS 引入 |

## Execution Order

所有任务属于同一个前端 Group，串行执行：

1. **Task 1**: 安装依赖
2. **Task 2**: 重构 `lib/markdown.ts` 渲染管线（核心）
3. **Task 3**: 确认代码块 HTML 结构
4. **Task 4**: MessageBubble 改造（依赖 Task 2 的 API）
5. **Task 5**: GitHub 排版 CSS（依赖 Task 4 的 DOM 结构）
6. **Task 6**: KaTeX CSS 引入
7. **Task 7**: Shiki 主题切换
8. **Task 8**: 集成测试

## Execution Groups

#### FG1: Markdown 渲染管线

**Description:** 完整的 Markdown 渲染增强，从依赖安装到排版样式到集成测试。

**Tasks:** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8

**Files (预估):** 4 个文件（1 rewrite + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | `harness-frontend-developer` → `harness-reviewer` |
| Model | `llm-simple-router/glm-5.1` |
| 注入上下文 | spec.md 全文 + 前端编码规范（CLAUDE.md 前端部分） |
| 读取文件 | `lib/markdown.ts`, `MessageBubble.vue`, `style.css`, `message.ts`（shared types） |
| 修改/创建文件 | `lib/markdown.ts`, `MessageBubble.vue`, `style.css`, `package.json` |

**Dependencies:** 无

## Dependency Graph & Wave Schedule

```
FG1 (全部任务串行)

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | FG1 | 全部工作，无并行 |
```

## Spec Coverage Check

| Spec FR | Task |
|---------|------|
| FR1: Shiki 代码高亮 | Task 2, 7 |
| FR2: 代码块 UI | Task 2, 3, 4, 5 |
| FR3: GFM 表格 | Task 2（markdown-it enable table）, Task 5（CSS） |
| FR4: GitHub 排版 | Task 5 |
| FR5: 任务列表 | Task 2（自定义 renderer）, Task 5（CSS） |
| FR6: KaTeX | Task 2（texmath 插件）, Task 6（CSS） |
| FR7: Mermaid | Task 2（fence renderer）, Task 4（客户端渲染） |
| FR8: 流式渲染策略 | Task 2（双阶段 API）, Task 4（MessageBubble 逻辑） |
| FR9: 主题切换 | Task 7 |
| FR10: 安全性 | Task 2（DOMPurify 配置）, Task 4（Mermaid sandbox） |
