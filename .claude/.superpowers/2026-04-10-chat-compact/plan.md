# Chat 紧凑化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将聊天消息区域改为紧凑布局 — 头像/标签与消息同行，容器接近全宽，统一紧凑字体行距。

**Architecture:** 3 个任务按依赖顺序执行：先改 CSS token（基础设施），再改 MessageBubble（核心组件），最后改 ToolCallCard 和 ChatView（关联调整）。无 TDD（纯 UI 变更），通过视觉验证。

**Tech Stack:** Vue 3, Tailwind CSS v4, TypeScript

**Spec:** [spec.md](spec.md) | **Design System:** [docs/design-system.md](../../docs/design-system.md)

---

## Task 1: CSS 排版 Token 与 Markdown 样式

**Files:**
- Modify: `src/assets/main.css`

- [ ] **Step 1: 在 @theme 中新增排版 token**

在 `@theme { }` 块的 `--radius-lg` 之后添加：

```css
/* 排版 — 紧凑模式 */
--font-size-message: 0.8125rem;
--font-size-code: 0.75rem;
--font-size-label: 0.625rem;
--line-height-message: 1.5;
```

- [ ] **Step 2: 调整 .prose 全局样式**

在文件末尾 `}` 之前，修改现有 `.prose` 规则：

```css
/* 正文 */
.prose {
  font-size: var(--font-size-message);
  line-height: var(--line-height-message);
}

.prose code {
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
  background-color: var(--color-bg-inset);
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-sm);
}

.prose pre {
  background-color: var(--color-bg-inset);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-md);
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-code);
}

.prose blockquote {
  border-left: 3px solid var(--color-accent);
  background: var(--color-accent-muted);
  padding: 0.375rem 0.75rem;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
}

.prose th,
.prose td {
  border: 1px solid var(--color-border-default);
  padding: 0.25rem 0.5rem;
}
```

- [ ] **Step 3: 视觉验证**

Run: `npm run tauri dev`
Expected: Markdown 渲染字体变小，代码块/表格/blockquote 间距收紧

- [ ] **Step 4: Commit**

```bash
git add src/assets/main.css
git commit -m "style: 添加紧凑排版 token，调整 prose 渲染尺寸"
```

---

## Task 2: MessageBubble 核心重构

**Files:**
- Modify: `src/components/MessageBubble.vue`

- [ ] **Step 1: 重写 User 消息模板**

将当前 User 消息（第 31-39 行）替换为内联标签式布局：

```vue
<!-- User 消息 — 右对齐，内联标签 -->
<div v-if="isUser" class="flex w-[95%] flex-row-reverse items-start self-end">
  <!-- 头像 + 标签 -->
  <div class="flex shrink-0 items-center gap-1.5 px-1">
    <div class="flex h-4 w-4 items-center justify-center rounded bg-bg-inset text-[10px] font-mono font-bold text-text-secondary">U</div>
    <span class="font-mono text-[10px] text-text-tertiary">User</span>
  </div>
  <!-- 消息内容 -->
  <div class="flex-1 rounded-md border border-border-default border-l-[3px] border-l-[#a1a1aa] bg-bg-elevated px-3 py-1.5">
    <div class="prose max-w-none text-text-primary" v-html="renderMarkdown(message.content)" />
  </div>
</div>
```

- [ ] **Step 2: 重写 Assistant 消息模板**

将当前 Assistant 消息（第 50-88 行）替换为内联标签式布局。segments 和无 segments 两种情况都需要处理：

```vue
<!-- Assistant 消息 — 左对齐，内联标签 -->
<div v-else class="flex w-[95%] flex-row items-start self-start">
  <!-- 头像 + 标签 -->
  <div class="flex shrink-0 items-center gap-1.5 px-1">
    <div class="flex h-4 w-4 items-center justify-center rounded bg-[#22c55e22] text-[10px] font-mono font-bold text-accent">&lambda;</div>
    <span class="font-mono text-[10px] text-accent">Assistant</span>
  </div>

  <!-- 内容区 -->
  <div class="flex-1">
    <!-- 有 segments 时逐段渲染 -->
    <template v-if="segments.length > 0">
      <template v-for="(seg, idx) in segments" :key="idx">
        <!-- text segment -->
        <div
          v-if="seg.type === 'text' && seg.text"
          class="rounded-md border border-border-default border-l-[3px] border-l-accent bg-bg-elevated px-3 py-1.5"
          :class="{ 'mb-2': idx < segments.length - 1 }"
        >
          <div class="prose max-w-none text-text-primary" v-html="renderMarkdown(seg.text)" />
        </div>

        <!-- tool segment -->
        <div v-else-if="seg.type === 'tool'" class="mb-2">
          <ToolCallCard :tool-call="seg.call" />
        </div>
      </template>

      <!-- 流式闪烁光标 -->
      <span
        v-if="isStreaming"
        class="mt-1 ml-1 inline-block h-3 w-1.5 bg-accent animate-cursor-blink"
      />
    </template>

    <!-- 无 segments 时用 content 渲染 -->
    <div
      v-else-if="message.content"
      class="rounded-md border border-border-default border-l-[3px] border-l-accent bg-bg-elevated px-3 py-1.5"
    >
      <div class="prose max-w-none text-text-primary" v-html="renderMarkdown(message.content)" />
    </div>
  </div>
</div>
```

- [ ] **Step 3: 视觉验证**

Run: `npm run tauri dev`
检查项：
- AI 消息左对齐，User 消息右对齐
- 头像图标 + 标签与消息内容在同一行
- 容器接近全宽
- segments 间距为 mb-2
- System 消息保持不变

- [ ] **Step 4: Commit**

```bash
git add src/components/MessageBubble.vue
git commit -m "feat: MessageBubble 紧凑化 — 内联标签式布局，全宽容器"
```

---

## Task 3: ChatView 间距 + ToolCallCard 紧凑化

**Files:**
- Modify: `src/components/ChatView.vue:87`
- Modify: `src/components/ToolCallCard.vue`

- [ ] **Step 1: ChatView 消息列表间距**

`src/components/ChatView.vue` 第 87 行：

```diff
-       <div v-else class="mx-auto max-w-[720px] space-y-6">
+       <div v-else class="mx-auto max-w-[720px] space-y-2">
```

- [ ] **Step 2: ToolCallCard header 紧凑化**

`src/components/ToolCallCard.vue` 第 54 行 header padding：

```diff
-     <div class="flex items-center justify-between px-3 py-2" :class="colors.bg">
+     <div class="flex items-center justify-between px-2.5 py-1" :class="colors.bg">
```

第 61 行状态标签字体：

```diff
-         <span v-else class="font-mono text-xs font-bold" :class="colors.text">
+         <span v-else class="font-mono text-[10px] font-bold" :class="colors.text">
```

第 66 行状态标签字体：

```diff
-       <span class="font-mono text-[11px]" :class="colors.text">{{ statusLabel }}</span>
+       <span class="font-mono text-[10px]" :class="colors.text">{{ statusLabel }}</span>
```

- [ ] **Step 3: ToolCallCard 参数摘要与输出区紧凑化**

第 72 行参数摘要字体：

```diff
-       class="px-3 mt-1.5 whitespace-pre-wrap font-mono text-xs text-text-secondary"
+       class="px-2.5 mt-1 whitespace-pre-wrap font-mono text-[10px] text-text-secondary"
```

第 78 行输出区：

```diff
-       class="mx-3 mt-2 mb-3 max-h-[300px] overflow-y-auto rounded-md border border-border-default bg-bg-inset p-2.5"
+       class="mx-2.5 mt-1.5 mb-2 max-h-[200px] overflow-y-auto rounded-md border border-border-default bg-bg-inset p-2"
```

第 80 行输出区字体：

```diff
-       <pre class="whitespace-pre-wrap font-mono text-xs text-text-secondary">{{ toolCall.output }}</pre>
+       <pre class="whitespace-pre-wrap font-mono text-[10px] text-text-secondary">{{ toolCall.output }}</pre>
```

- [ ] **Step 4: 视觉验证**

Run: `npm run tauri dev`
检查项：
- 消息间距为 8px（space-y-2）
- ToolCallCard header 更紧凑
- 输出区高度限制为 200px
- 所有字体为 10px

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatView.vue src/components/ToolCallCard.vue
git commit -m "style: ChatView 间距 + ToolCallCard 紧凑化"
```
