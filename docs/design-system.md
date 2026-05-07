# Design System — xyz-agent

全局设计规范，所有 UI 组件必须遵循。定义于 `src/assets/main.css` 的 `@theme` 中。

## 1. 色彩体系

### 背景层级（3 层深度）

| Token | 值 | 用途 |
|-------|-----|------|
| `--color-bg-base` | `#0a0a0b` | 最底层背景 |
| `--color-bg-surface` | `#111113` | 页面/面板背景 |
| `--color-bg-elevated` | `#18181b` | 卡片/气泡/弹出层 |
| `--color-bg-inset` | `#1f1f23` | 凹陷区域（代码块、输入框） |
| `--color-bg-ai` | `#131517` | AI 消息背景（微蓝冷调） |
| `--color-bg-user` | `#1c1a14` | User 消息背景（微暖调） |

### 边框

| Token | 值 |
|-------|-----|
| `--color-border-default` | `#27272a` |
| `--color-border-hover` | `#3f3f46` |

### 文本

| Token | 值 | 用途 |
|-------|-----|------|
| `--color-text-primary` | `#fafafa` | 正文 |
| `--color-text-secondary` | `#a1a1aa` | 次要信息、说明 |
| `--color-text-tertiary` | `#71717a` | 占位符、禁用态 |
| `--color-text-inverse` | `#0a0a0b` | 反色文本 |

### 功能色

| Token | 值 | 语义 |
|-------|-----|------|
| `--color-accent` | `#22c55e` | 主强调（AI/成功） |
| `--color-accent-hover` | `#16a34a` | 主强调悬停 |
| `--color-accent-muted` | `rgba(34,197,94,0.15)` | 主强调弱化背景 |
| `--color-accent-blue` | `#3b82f6` | 信息/链接 |
| `--color-accent-yellow` | `#eab308` | 警告/注意 |
| `--color-accent-red` | `#ef4444` | 错误/危险 |

## 2. 排版体系

### 字体栈

| Token | 值 |
|-------|-----|
| `--font-sans` | `'Inter', 'SF Pro Text', system-ui, sans-serif` |
| `--font-mono` | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace` |

### 字号层级

| 层级 | 大小 | 用途 |
|------|------|------|
| 消息正文 | `0.8125rem` (13px) | 聊天消息、主要内容 |
| 代码 | `0.75rem` (12px) | 代码块、行内代码 |
| 标签 | `0.625rem` (10px) | 角色标签、状态标签、时间戳 |
| 小号 | `0.6875rem` (11px) | ToolCallCard 参数摘要、StatusBar |

### 行高

| 层级 | 值 |
|------|-----|
| 消息正文 | `1.5` |
| 代码 | `1.6` |
| 标签 | `1` |

## 3. 间距体系

### 消息区域

| 属性 | 值 |
|------|-----|
| 消息列表间距 | `0.5rem` (8px) |
| 消息容器宽度 | `95%` |
| 消息容器内 padding | `0.75rem 0.75rem` (12px 12px) |
| 色条宽度 | `3px` |

### 组件内间距

| 属性 | 值 |
|------|-----|
| ToolCallCard header padding | `0.25rem 0.625rem` (4px 10px) |
| ToolCallCard 输出区 padding | `0.5rem` (8px) |
| segment 间距 | `0.5rem` (8px) |

## 4. 圆角

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius-sm` | `0.25rem` | 小元素（标签、内联代码） |
| `--radius-md` | `0.375rem` | 卡片、代码块 |
| `--radius-lg` | `0.5rem` | 大容器 |

## 5. Markdown 渲染

| 元素 | font-size | padding | 备注 |
|------|-----------|---------|------|
| 代码块 | 12px | `0.5rem 0.75rem` | bg-inset, border-default |
| 行内代码 | 12px | `0.125rem 0.375rem` | bg-inset |
| blockquote | — | `0.375rem 0.75rem` | 左色条 3px accent |
| table th/td | — | `0.25rem 0.5rem` | border-default |
| table th | — | — | bg-inset |

## 6. 动画

| 名称 | 用途 | 参数 |
|------|------|------|
| `cursor-blink` | 流式光标 | 1s step-end infinite |
| `pulse-dot` | 状态指示灯 | 1.5s ease-in-out infinite |

## 7. 对齐规则

- AI 消息：左对齐，左侧绿色色条
- User 消息：右对齐，左侧灰色色条
- System 消息：全宽，红色警告样式

## 8. 设计原则

1. **终端 × IDE 风格** — 深色背景、等宽字体标签、色条指示器
2. **紧凑优先** — 最小化不必要的空白，最大化信息密度
3. **一致性** — 所有组件使用同一套 token，禁止硬编码颜色/尺寸
4. **功能色即信息** — 绿色=AI/成功、黄色=警告、红色=错误，不用于装饰
