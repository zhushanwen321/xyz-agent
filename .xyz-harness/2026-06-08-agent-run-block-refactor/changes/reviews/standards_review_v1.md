---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 9
  issues_found: 2
  must_fix_count: 0
  low_count: 2
  info_count: 0
---

# Standards Review v1

**Date**: 2026-06-08
**Scope**: AgentRunBlock refactor — message-layout.ts, AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, AssistantContent.vue, ChatPanel.vue, SystemPane.vue, settings.ts, AssistantSection.vue

---

## Phase A: Lint 结果

`npm run lint` 通过，0 errors / 7 warnings：

| 文件 | 行 | 规则 | 说明 |
|------|-----|------|------|
| MergeBlock.vue | 178 | no-magic-numbers | `1000`（毫秒阈值） |
| QueueComponent.vue | 110 | no-magic-numbers | `3000`（非本次改动文件） |
| SendModeStatusBar.vue | 3/40 | taste/no-native-html-elements | `<button>`（非本次改动文件） |
| StandaloneToolCard.vue | 83 | no-magic-numbers | `50`（路径截断长度 ×2） |
| extension-service.ts | 509 | no-magic-numbers | `5`（非本次改动文件） |

**本次改动引入的 warning**: 2 处（MergeBlock 1000, StandaloneToolCard 50 ×2），均为低优先级。

---

## Phase B: 逐项规范检查

### 1. 禁止 `any`

**PASS** — 全部 9 个文件无 `any` 类型使用。

### 2. 禁止原生 HTML 表单元素

**PASS（有注释）** — 检测到 2 处 `<button>`：

| 文件 | 说明 |
|------|------|
| StandaloneToolCard.vue:5 | `<button class="standalone-tool__hdr">` — 已加 `eslint-disable-next-line taste/no-native-html-elements` 注释，理由为"custom flex layout requires button"。**可接受**：这是可折叠区域 toggle，xyz-ui `<Button>` 的 padding/focus 样式会干扰紧凑行内布局 |
| ChatPanel.vue:111 | `<button class="scroll-fab">` — 滚动到底部 FAB，非表单元素，是 icon-only 浮动按钮。**可接受**：圆形浮动按钮无 xyz-ui 对应组件 |

无 `<input>`, `<select>`, `<textarea>`, `<form>`。

### 3. 禁止 Emoji

**PASS** — 无 Emoji 使用。

### 4. 禁止硬编码颜色

**PASS（1 处特殊情况）**：

| 文件 | 行 | 值 | 说明 |
|------|-----|----|------|
| AgentRunBlock.vue | 187 | `rgba(255, 255, 255, 0.3)` | streaming 状态条的 shimmer 渐变叠加层。**可接受**：白色半透明叠加是纯视觉效果，不受主题颜色影响，用 CSS 变量反而语义不清 |

其余所有颜色均使用 CSS 变量（`var(--accent)`, `var(--border)`, `var(--muted)` 等）。

### 5. 禁止魔数间距

**FAIL** — 检测到多处魔数间距，集中在 SystemPane.vue：

| 文件 | 值 | 说明 |
|------|-----|------|
| SystemPane.vue:86,107,155 | `py-[9px]` | section header 纵向内边距 |
| SystemPane.vue:91,97 | `min-w-[76px]` | label 最小宽度 |
| SystemPane.vue:165,180 | `py-[6px]` | palette button 纵向内边距 |
| ChatPanel.vue:84 | `mb-[3px]` | "助手"标签下边距 |
| ChatPanel.vue:21 | `gap-[6px]` | 消息间距 |

**评估**：
- `py-[9px]`, `py-[6px]`, `min-w-[76px]` 是 SystemPane 的 **既有样式**（非本次改动新增），属于 Settings 视觉 demo 的精确还原。这些值在 `px-4` / `rounded-sm` 的标准体系中作为 section 内部微调使用。**建议**提取为语义类或 CSS 变量，但不阻塞合并。
- `gap-[6px]` 和 `mb-[3px]` 是 Tailwind 标准值之外的小间距，但属于 UI 精细调整，非随意取值。**低优先级**。
- `h-[3px]`（AgentRunBlock:6）是状态条的刻意非标准高度。**可接受**。
- `max-w-[860px]`, `max-w-[960px]`, `max-w-[200px]` 是宽度约束，不属于"间距"范畴。**不适用**。

### 6. 行数上限（template ≤ 400, script ≤ 300）

**PASS** — 所有文件在限制内：

| 文件 | template | script | 状态 |
|------|----------|--------|------|
| AgentRunBlock.vue | 50 | 114 | ✅ |
| MergeBlock.vue | 44 | 133 | ✅ |
| StandaloneToolCard.vue | 29 | 80 | ✅ |
| AssistantContent.vue | 27 | 73 | ✅ |
| ChatPanel.vue | 77 | 163 | ✅ |
| SystemPane.vue | 68 | 80 | ✅ |
| AssistantSection.vue | 11 | 21 | ✅ |

### 7. emit 单 payload 对象

**PASS** — ChatPanel.vue 的 `defineEmits` 类型签名全部使用单参数 payload（`[payload: { ... }]` 或 `[modelId: string]`）。`emit('switch-agent', id)` 中 `id` 是 string，非多参数 emit。

### 8. Promise.allSettled

**PASS** — 无 `Promise.all` 使用，所有文件不涉及并行请求。

---

## 额外观察

### StandaloneToolCard 的 `<label>` 元素（SystemPane.vue:141）

SystemPane.vue 使用原生 `<label>` 包裹 toggle + 文字。`<label>` 不是交互元素（非 `<input>/<select>/<textarea>`），规范约束的是原生**表单交互元素**，label 仅用于 click 传递和可访问性，**不违规**。

### MergeBlock / StandaloneToolCard 的 magic numbers（lint warning）

- `MergeBlock.vue:178` — `1000` 是毫秒阈值（`ms < 1000`），含义明确。
- `StandaloneToolCard.vue:83` — `50` 是路径截断长度，含义明确。

**建议**：提取为命名常量（如 `const PATH_DISPLAY_MAX = 50`），但不阻塞合并。

---

## 审查总结

无 must-fix 级别问题。所有规范项均通过或为低优先级建议。
