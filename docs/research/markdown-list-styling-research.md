# Markdown 列表样式调研报告

> 调研日期：2026-06-06
> 目标：对比主流项目的 markdown 列表（ul/ol/li）样式实现，为 xyz-agent 聊天消息渲染提供参考

---

## 1. 候选项目清单

| 项目 | Stars | 方案类型 | 为什么选 | 关键文件 |
|------|-------|---------|---------|---------|
| tailwindlabs/tailwindcss-typography | 6,388 | Tailwind 插件（`.prose`） | 事实标准，多数 Tailwind 项目的基础 | `src/styles.js` |
| ChatGPTNextWeb/ChatGPT-Next-Web | 88,179 | 手写 `.markdown-body` CSS（GitHub 风格） | 老牌 chat 客户端，直接面向 chat 场景 | `app/styles/markdown.scss` |
| vercel/ai-chatbot | 20,446 | streamdown + Tailwind 类名 | Vercel 官方 AI chatbot demo，最新方案 | `components/ai-elements/message.tsx` |
| vercel/streamdown | 5,268 | React 组件内联 Tailwind 类名 | ai-chatbot 的底层渲染库，列表样式直接写在组件中 | `packages/streamdown/lib/components.tsx` |
| lobehub/lobe-chat | 78,242 | `@lobehub/ui` Markdown 组件 | 国内知名 chat 客户端（样式在外部 UI 包，monorepo 中不可见） | `src/features/Conversation/Markdown/index.tsx` |
| shuding/nextra | 13,820 | `@tailwindcss/typography` + 自定义补充 | Next.js 文档站，文档场景标杆 | `packages/nextra-theme-docs/src/style.css` |

**注意**：
- shadcn/ui 没有独立的 markdown 样式，不提供 `.prose` 或列表样式
- lobe-chat 的 markdown 样式在独立 npm 包 `@lobehub/ui` 中，monorepo 里找不到 CSS 源码
- nextra 使用 `@tailwindcss/typography` 的 prose 类作为基础，仅在 task list 等处做自定义补充

---

## 2. 列表样式的具体代码

### 2.1 @tailwindcss/typography（`src/styles.js`）

typography 的核心策略：**不使用 `list-style-position`**，而是通过 `paddingInlineStart`（ol/ul）+ `paddingInlineStart`（li）控制缩进。所有单位用 `em`，基于父元素字号自适应。

#### base 修饰符（16px 基准字号）

```js
// src/styles.js — base modifier（默认 .prose 不带修饰符时）
ol: {
  marginTop: em(20, 16),       // 1.25em
  marginBottom: em(20, 16),   // 1.25em
  paddingInlineStart: em(26, 16),  // 1.625em ≈ 26px
},
ul: {
  marginTop: em(20, 16),      // 1.25em
  marginBottom: em(20, 16),   // 1.25em
  paddingInlineStart: em(26, 16),  // 1.625em ≈ 26px
},
li: {
  marginTop: em(8, 16),      // 0.5em
  marginBottom: em(8, 16),   // 0.5em
},
'ol > li': {
  paddingInlineStart: em(6, 16),  // 0.375em — 数字/符号与文字间距
},
'ul > li': {
  paddingInlineStart: em(6, 16),  // 0.375em — bullet 与文字间距
},
// 嵌套列表
'ul ul, ul ol, ol ul, ol ol': {
  marginTop: em(12, 16),     // 0.75em
  marginBottom: em(12, 16),  // 0.75em
},
```

#### 全局默认样式（DEFAULT，应用在所有 prose 上）

```js
// src/styles.js — DEFAULT（合入 base 之前的全局层）
ol: {
  listStyleType: 'decimal',
},
ul: {
  listStyleType: 'disc',
},
'ol > li::marker': {
  fontWeight: '400',
  color: 'var(--tw-prose-counters)',
},
'ul > li::marker': {
  color: 'var(--tw-prose-bullets)',
},
```

#### sm 修饰符（14px 基准字号）

```js
ol: {
  paddingInlineStart: em(22, 14),  // ≈1.571em
},
ul: {
  paddingInlineStart: em(22, 14),  // ≈1.571em
},
li: {
  marginTop: em(4, 14),   // ≈0.286em
  marginBottom: em(4, 14),
},
'ol > li': { paddingInlineStart: em(6, 14) },
'ul > li': { paddingInlineStart: em(6, 14) },
```

**关键设计**：
- **不设 `list-style-position`**（默认 `outside`），依靠 `paddingInlineStart` 把标记推出容器
- `::marker` 颜色通过 CSS 变量控制，与主题联动
- 所有尺寸是 `em` 函数计算，响应字号变化
- 不同 size 修饰符（sm/base/lg/xl/2xl）各自计算，不互相继承

---

### 2.2 ChatGPT-Next-Web（`app/styles/markdown.scss`）

直接使用 GitHub 的 `.markdown-body` CSS。**最简单直接的方案**。

```scss
// 列表基础
.markdown-body ul,
.markdown-body ol {
  margin-top: 0;
  margin-bottom: 0;
  padding-left: 2em;   // 32px（基于 16px 字号）
}

// 嵌套列表样式变化
.markdown-body ol ol,
.markdown-body ul ol {
  list-style-type: lower-roman;
}
.markdown-body ul ul ol,
.markdown-body ul ol ol,
.markdown-body ol ul ol,
.markdown-body ol ol ol {
  list-style-type: lower-alpha;
}

// 任务列表
.markdown-body .task-list-item {
  list-style-type: none;
}
.markdown-body .task-list-item-checkbox {
  margin: 0 0.2em 0.25em -1.4em;  // 负左边距把 checkbox 拉回
  vertical-align: middle;
}

// li 间距
.markdown-body li + li {
  margin-top: 0.25em;
}
.markdown-body li > p {
  margin-top: 16px;
}

// 列表与周围元素间距
.markdown-body p,
.markdown-body blockquote,
.markdown-body ul,
.markdown-body ol,
.markdown-body dl,
.markdown-body table,
.markdown-body pre,
.markdown-body details {
  margin-top: 0;
  margin-bottom: 16px;
}

// 无序列表（嵌套时 disc → circle → square）
.markdown-body ul ul,
.markdown-body ul ol,
.markdown-body ol ol,
.markdown-body ol ul {
  margin-top: 0;
  margin-bottom: 0;
}
```

**关键设计**：
- `padding-left: 2em`（32px），直接用固定 em 值
- **不设 `list-style-position`**（默认 `outside`）
- 任务列表用 `list-style-type: none` + 负 margin checkbox 回拉
- `li + li` 用 `0.25em` 紧凑间距
- 完全复制 GitHub markdown CSS，久经考验

---

### 2.3 vercel/streamdown（`packages/streamdown/lib/components.tsx`）

streamdown 是 ai-chatbot 的底层渲染库。它**不用 `.prose` 类**，直接在 React 组件上写 Tailwind 类名。

```tsx
// 有序列表
const MemoOl = memo<OlProps>(({ children, className, node, ...props }: OlProps) => {
  const cn = useCn();
  return (
    <ol
      className={cn(
        "list-inside list-decimal whitespace-normal [li_&]:pl-6",
        className
      )}
      data-streamdown="ordered-list"
      {...props}
    >
      {children}
    </ol>
  );
});

// 无序列表
const MemoUl = memo<UlProps>(({ children, className, node, ...props }: UlProps) => {
  const cn = useCn();
  return (
    <ul
      className={cn(
        "list-inside list-disc whitespace-normal [li_&]:pl-6",
        className
      )}
      data-streamdown="unordered-list"
      {...props}
    >
      {children}
    </ul>
  );
});

// 列表项
const MemoLi = memo<LiProps>(({ children, className, node, ...props }: LiProps) => {
  const cn = useCn();
  return (
    <li
      className={cn("py-1 [&>p]:inline", className)}
      data-streamdown="list-item"
      {...props}
    >
      {children}
    </li>
  );
});
```

**关键设计**：
- **`list-inside`**（即 `list-style-position: inside`）— 这是唯一用 `inside` 的项目
- `[li_&]:pl-6`（嵌套时 `padding-left: 1.5rem = 24px`）
- `py-1`（`padding-top/bottom: 0.25rem = 4px`）— li 垂直间距
- `[&>p]:inline` — li 内的 p 标签设为 inline，避免段间距撑开

**`list-inside` 的含义**：标记（bullet/number）在内容流内，标记和文字在同一条基线上。这意味着不需要额外的 `padding-inline-start` 在 li 上。

---

### 2.4 nextra（`packages/nextra-theme-docs/src/style.css`）

nextra 的列表样式**完全依赖 `@tailwindcss/typography` 的 prose 类**，仅对 task list 做了补充：

```css
/* 唯一的列表相关自定义 */
.contains-task-list {
  @apply x:mt-[1.25em];
}

.contains-task-list input[type='checkbox'] {
  @apply x:me-1;  /* margin-right: 0.25rem */
}
```

nextra 在 `nextra-theme-blog` 中使用 `prose` 类：
```tsx
// packages/nextra-theme-blog/src/components/layout.tsx
className="x:container x:px-4 x:prose x:max-md:prose-sm x:dark:prose-invert"
```

---

## 3. 跨项目对比

### 3.1 核心数值对比

| 属性 | typography (base) | ChatGPT-Next-Web | streamdown | 浏览器默认 |
|------|------------------|-------------------|------------|-----------|
| **ol/ul padding-left** | `1.625em` (26px) | `2em` (32px) | 0（顶层）/ `1.5rem` (24px)（嵌套） | `40px` |
| **list-style-position** | 不设（默认 `outside`） | 不设（默认 `outside`） | **`inside`** | `outside` |
| **li padding-inline-start** | `0.375em` (6px) | 无 | 无 | 0 |
| **li margin-top** | `0.5em` (8px) | `0.25em`（li+li） | `0`（用 py-1） | 0 |
| **嵌套缩进** | 依赖父级 paddingInlineStart 重叠 | 依赖 CSS 默认嵌套缩进 | `[li_&]:pl-6` (24px) | 约 40px |
| **嵌套列表间距** | `0.75em` (12px) margin | 0 | 无特殊处理 | 0 |
| **任务列表** | 无特殊处理 | `list-style: none` + 负 margin checkbox | 无特殊处理 | N/A |

### 3.2 策略分类

| 策略 | 代表项目 | 适用场景 |
|------|---------|---------|
| **A. `outside` + `paddingInlineStart` 在 ol/ul** | typography、ChatGPT-Next-Web | 文档、聊天消息。标记在容器外，文字对齐好 |
| **B. `inside` + 无额外 padding** | streamdown | 流式聊天。代码最简洁，但多行 li 时标记可能不对齐 |
| **C. 完全自定义组件** | lobe-chat（@lobehub/ui） | 需要 UI 组件库级别控制 |

### 3.3 `outside` vs `inside` 对比

```
outside（typography / NextChat）：
┌──────────────────────────────────────┐
│  •  Item text that might wrap        │
│     to a second line and align       │
│     perfectly at the left edge       │
│  1. Numbered item text wraps         │
│     and aligns here too              │
└──────────────────────────────────────┘
标记在 padding 区域，文字换行后左对齐

inside（streamdown）：
┌──────────────────────────────────────┐
│  • Item text that might wrap         │
│  to a second line and starts under   │
│  the bullet, not at the left edge    │
│  1. Numbered item text wraps         │
│  and starts under the number         │
└──────────────────────────────────────┘
标记在内容流内，换行文字缩进到标记后
```

对于 chat 场景，`outside` 更适合：消息宽度窄，列表项文字经常换行，`outside` 确保换行后文字左对齐。

---

## 4. 针对 xyz-agent 的建议

### 4.1 不要引入 @tailwindcss/typography

xyz-agent 的聊天消息渲染用的是自定义 markdown CSS（`<style scoped>` 或 `style.css` 中的后代选择器），不是给容器加 `.prose` 类。引入 typography 会：
- 增加约 20KB CSS 产出
- 带来大量不需要的样式（h1-h6、table、figure 等 chat 场景不需要的元素）
- 与现有 Tailwind 类名和 CSS 变量体系冲突

### 4.2 推荐方案：参考 ChatGPT-Next-Web + streamdown 的混合方案

**核心原则**：`list-style-position: outside` + `padding-left` 控制。

#### style.css 中应添加的规则

```css
/* ===== Markdown 列表样式 ===== */

/* 基础：ol/ul 缩进 */
.markdown-body ul,
.markdown-body ol {
  margin-top: 0;
  margin-bottom: 0;
  padding-left: 1.5em;  /* 24px，比 typography 的 1.625em 略小，适合 chat 窄宽度 */
}

/* 顶层列表与周围元素的间距 */
.markdown-body > ul,
.markdown-body > ol {
  margin-top: 0.5em;
  margin-bottom: 0.5em;
}

/* 列表项间距 */
.markdown-body li {
  margin-top: 0.15em;
  margin-bottom: 0.15em;
}
.markdown-body li + li {
  margin-top: 0.25em;
}

/* li 内的 p 标签不产生额外间距 */
.markdown-body li > p {
  margin-top: 0;
  margin-bottom: 0;
}
.markdown-body li > p + p {
  margin-top: 0.5em;
}

/* 嵌套列表 */
.markdown-body ul ul,
.markdown-body ul ol,
.markdown-body ol ol,
.markdown-body ol ul {
  margin-top: 0.25em;
  margin-bottom: 0.25em;
}

/* 任务列表 */
.markdown-body .task-list-item {
  list-style-type: none;
}
.markdown-body .task-list-item-checkbox {
  margin: 0 0.2em 0.25em -1.3em;
  vertical-align: middle;
}
```

#### 关键参数说明

| 参数 | 推荐值 | 来源 |
|------|-------|------|
| `padding-left` (ol/ul) | `1.5em` (24px) | streamdown 的嵌套缩进值，兼顾窄宽度和美观 |
| `list-style-position` | 不设（默认 `outside`） | 所有项目的一致选择 |
| `li` 间距 | `0.15em` ~ `0.25em` | streamdown 的 `py-1` 折算 |
| `li > p` 处理 | `margin: 0` | streamdown 的 `[&>p]:inline` 思路，但 chat 中用 margin 更安全 |
| 嵌套缩进 | 依赖 CSS 默认（padding-left 叠加） | NextChat 的策略，最简单 |

### 4.3 如果当前 bug 是标记和文字不对齐

最常见的 bug 是：
1. **`list-style-position: inside`** 导致多行换行后缩进不一致 → 改为 `outside`
2. **`padding-left: 0`** 导致标记溢出容器 → 加上 `padding-left: 1.5em`
3. **Tailwind 的 `list-inside` / `list-outside` 类名被覆盖** → 检查是否有更高优先级的选择器

### 4.4 总结

| 决策 | 结论 |
|------|------|
| 引入 `@tailwindcss/typography`？ | **否**。过重，与现有体系不兼容 |
| 用 streamdown？ | **否**。xyz-agent 不是 React，用的是 Vue + v-html 渲染 |
| 列表样式来源 | **手写 CSS**，参考 NextChat 的 `.markdown-body` + streamdown 的参数 |
| `list-style-position` | **`outside`**（默认值，不要显式设 `inside`） |
| `padding-left` | **`1.5em`**（ol/ul 层级） |
| 任务列表 | **`list-style-type: none` + 负 margin checkbox** |

---

## 附录：调研素材路径

所有 clone 的仓库在 `~/GitApp/misc/md-css-research/` 下：

```
tailwindcss-typography/  — @tailwindcss/typography 源码
chatbot/                  — vercel/ai-chatbot
streamdown/               — vercel/streamdown（ai-chatbot 底层渲染库）
NextChat/                 — ChatGPTNextWeb/ChatGPT-Next-Web
lobehub/                  — lobehub/lobe-chat
nextra/                   — shuding/nextra
ui/                       — shadcn-ui/ui（无 markdown 样式）
```

---

## 附录 B：实际修复落地

> 修复位置：`src-electron/renderer/src/style.css`（markdown 列表样式区块）

### 调试过程中踩过的坑（避免重复）

1. **`<span v-html>` 拦截直接子选择器**：`MessageBubble.vue` 的 markdown 容器是 `<div class="msg__body"><span v-html>...</span></div>`，所有 ul/ol 被包在 `<span>` 里。**`.msg__body > ul` 不匹配**，必须用后代选择器 `.msg__body ul`。
2. **`list-style-position: outside` 的标记渲染在 li 容器外左边**：`padding-left` 控制的是 li 内容起点，不影响 outside 标记位置。标记始终在 li padding 区域起点。
3. **Vite HMR + computed style 不一致**：style.css 改了之后，必须等 HMR 重载完成才能在 `getComputedStyle` 看到新值。可以用 `document.querySelectorAll('style, link[rel=stylesheet]')` 看实际加载的 CSS 文本。

### 最终方案（已落地，2026-06-06）

```css
/* src-electron/renderer/src/style.css  列表区块 */
.msg__body ul, .msg__body ol {
  margin-top: 0;
  margin-bottom: 12px;
  padding-left: 1.5em;
}
.msg__body ol { list-style-type: decimal; }
.msg__body ul { list-style-type: disc; }
.msg__body li { margin-top: 0.15em; margin-bottom: 0.15em; }
.msg__body li + li { margin-top: 0.25em; }
.msg__body li > p { margin-top: 0; margin-bottom: 0; }  /* 关键: li 内的 p 不撑开间距 */
.msg__body li ul, .msg__body li ol {
  margin-top: 0.25em;
  margin-bottom: 0.25em;
}
```

### 验证

用 Playwright 注入测试 markdown 截图对比：

| 方案 | 触→• 偏移 | 1→• Agent 嵌套偏移 | 评价 |
|------|----------|---------------------|------|
| `margin-left: 0.8em + inside`（前版本） | 27px | 40px | 偏大，多行换行后缩进不一致 |
| `padding-left: 1.5em + outside`（**最终**） | **15px** | 28px | 与用户期望图（15px / 45px）一致 |

### 未来可能需要的改进

- 长内容换行后文字左对齐：已由 `outside` 模式保证
- 任务列表（`- [ ] item`）：当前 task list 插件已用 `list-style: none` 单独处理，不受本规则影响
- 如果后续要切换主题（亮/暗）联动 `::marker` 颜色：参考 `@tailwindcss/typography` 的 `--tw-prose-bullets` / `--tw-prose-counters` CSS 变量方案
