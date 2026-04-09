# 批量代码分析汇总报告

## 概述
- 批次名称：20260409-frontend-redesign
- 分析范围：前端重设计变更文件及其上下游依赖
- 变更文件数：11（9 个修改 + 2 个新增）
- 关联文件数：5（composables, types, UI 组件）
- 分析批次：4 批
- 成功完成：4/4

## 文件清单

| 文件 | 分析范围 | 关键问题 | 状态 |
|------|---------|---------|------|
| ChatView.vue | App → ChatView → MessageBubble/Input/EmptyState/useChat | 0 严重, 2 一般 | 通过 |
| Sidebar.vue | App → Sidebar → useSession/ScrollArea/Separator | 0 严重, 0 一般 | 通过 |
| MessageBubble.vue + ToolCallCard.vue | 类型匹配、status 值一致性、CSS Token | 0 严重, 2 一般 | 通过 |
| StatusBar.vue + MessageInput.vue + ContextIndicator.vue | App → StatusBar、ChatView → MessageInput | **1 严重**, 1 一般 | 需修复 |

## 问题汇总

### 严重问题（1 个）

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| S1 | StatusBar `isStreaming` 硬编码为 `false` | App.vue:19, StatusBar.vue | ChatView 内部持有真实 isStreaming 状态，但未传递到 App 层的 StatusBar，导致状态栏永远显示 "ready" |

### 一般问题（5 个）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| M1 | 自动滚动打断用户回看历史消息 | ChatView.vue | 用户向上滚动查看历史时，新消息到来会强制跳到底部 |
| M2 | ToolCallCard status switch 缺 default 分支 | ToolCallCard.vue | TypeScript exhaustive check 不完整 |
| M3 | loadHistory 中 toolCalls 缺显式类型标注 | useChat.ts | 类型推断可能不精确 |
| M4 | ContextIndicator percentage 和 token 数硬编码 | StatusBar.vue | 占位数据，需后续接入 |
| M5 | 消息气泡默认 id 硬编码为 'streaming' | ChatView.vue | 仅在极端情况下可能产生 key 冲突 |

### 轻微问题（8 个）
- Sidebar 底部 Active Context 区域硬编码项目名/分支名（占位）
- `onMounted` 中未 await async 函数（内部已 catch）
- ToolCallCard 类型断言 `as Record<string, unknown>` 安全性
- MessageBubble 空字符串 output 的显示行为
- MessageInput textarea 缺少 `min-h`/`max-h` 高度限制（原 shadcn Textarea 有）
- 流式气泡边界闪烁风险
- CSS `hover:bg-bg-inset/50` 透明度修饰符（语法正确）
- Separator class 覆写可能不生效（shadcn 内部样式）

## 接口匹配矩阵

| 接口 | 匹配状态 |
|------|---------|
| App.vue → ChatView (`currentSessionId`) | 匹配 |
| ChatView → MessageBubble (`message`, `streamingText`) | 匹配 |
| ChatView → MessageInput (`isStreaming`, `send`) | 匹配 |
| ChatView → EmptyState (无 props) | 匹配 |
| Sidebar → useSession (6 个字段) | 匹配 |
| MessageBubble → ToolCallCard (`toolCall`) | 匹配 |
| StatusBar → ContextIndicator (`percentage`) | 匹配 |
| **App.vue → StatusBar (`isStreaming`)** | **不匹配（硬编码 false）** |

## CSS Token 覆盖检查

| Token 类名 | @theme 定义 | 使用位置 |
|-----------|------------|---------|
| `bg-bg-base` | `--color-bg-base: #0a0a0b` | StatusBar, MessageInput |
| `bg-bg-surface` | `--color-bg-surface: #111113` | App, ChatView |
| `bg-bg-elevated` | `--color-bg-elevated: #18181b` | Sidebar, MessageBubble, ToolCallCard |
| `bg-bg-inset` | `--color-bg-inset: #1f1f23` | Sidebar, ToolCallCard |
| `text-accent` | `--color-accent: #22c55e` | 全局 |
| `border-border-default` | `--color-border-default: #27272a` | 全局 |
| `bg-accent-muted` | `--color-accent-muted: rgba(34,197,94,0.15)` | Sidebar, MessageInput |
| `text-accent-red` | `--color-accent-red: #ef4444` | MessageBubble, ToolCallCard |
| `animate-cursor-blink` | `@keyframes cursor-blink` | EmptyState, MessageBubble |
| `animate-pulse-dot` | `@keyframes pulse-dot` | StatusBar |

所有自定义 CSS 类名均有对应的 Token 定义。
