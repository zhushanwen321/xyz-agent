# Chat 紧凑化重设计

## 目标

将聊天消息区域改为紧凑布局：头像/标签与消息同行，消息容器接近全宽，统一紧凑字体和行距。

## 参照

- Design System: `docs/design-system.md`

## 变更范围

### MessageBubble.vue — 核心重构

**当前结构**（独立标签行 + 限宽气泡）：
```
[Role Label]                    ← 独立行，mb-1
[  max-w-[75%] 气泡容器        ]
[    消息内容 prose prose-sm     ]
```

**新结构**（内联标签 + 全宽行）：

AI 消息（左对齐）：
```
[λ icon] [Assistant label]  [消息内容 prose 紧凑...]
                         [续行内容...]
```

User 消息（右对齐）：
```
           [消息内容 prose 紧凑...]  [U icon] [User label]
           [续行内容...]
```

具体实现：
- 消息行使用 `flex flex-row items-start`
- AI: `flex-row`，头像 + 标签在左，内容在右
- User: `flex-row-reverse`，头像 + 标签在右，内容在左
- 容器宽度: `w-[95%]`，取代 `max-w-[75%]` / `max-w-[85%]`
- 消息内 padding: `px-3 py-1.5`
- 头像: 16x16 的文字图标（AI=`λ` 绿色, User=`U` 灰色），带 bg-inset 背景
- 标签: 10px font-mono，与头像同行

### ChatView.vue — 间距调整

- 消息列表间距: `space-y-6` → `space-y-2`
- 容器 max-width: `max-w-[720px]` 保留（整体宽度约束）

### main.css — 排版 token

在 `@theme` 中新增：
```css
--font-size-message: 0.8125rem;    /* 13px */
--font-size-code: 0.75rem;         /* 12px */
--font-size-label: 0.625rem;       /* 10px */
--line-height-message: 1.5;
```

Markdown 渲染样式调整：
- `.prose` 正文 font-size → 13px, line-height → 1.5
- 代码块 font-size → 12px, padding → `0.5rem 0.75rem`
- 行内代码 font-size → 12px
- blockquote padding → `0.375rem 0.75rem`
- table th/td padding → `0.25rem 0.5rem`

### ToolCallCard.vue — 紧凑化

- Header padding: `px-3 py-2` → `px-2.5 py-1`
- 标签/状态字体: `text-[11px]` → `text-[10px]`
- 输出区 padding: `p-2.5` → `p-2`
- 输出区 max-height: `300px` → `200px`
- 参数摘要 font-size: `text-xs` → `text-[10px]`

### MessageBubble segments 间距

- segment 间距: `mb-3` → `mb-2`

## 不变更

- StatusBar.vue
- MessageInput.vue
- EmptyState.vue
- Sidebar.vue
- 色彩体系
- 动画定义
