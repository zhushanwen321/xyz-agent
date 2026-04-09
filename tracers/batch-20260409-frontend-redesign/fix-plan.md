# 修复计划

## 概述
- 严重问题：1 个
- 一般问题：5 个
- 轻微问题：8 个

## 优先修复（严重）

| 优先级 | 问题 | 文件 | 修复建议 |
|--------|------|------|----------|
| P0 | StatusBar isStreaming 硬编码 false | App.vue:19 | 将 StatusBar 移入 ChatView 内部，直接使用 useChat 的 isStreaming 状态。App.vue 只保留 Sidebar + ChatView 两块布局 |

## 计划修复（一般）

| 优先级 | 问题 | 文件 | 修复建议 |
|--------|------|------|----------|
| P1 | 自动滚动打断回看 | ChatView.vue | 检测用户是否在底部附近（距底部 < 100px），仅此时自动滚动 |
| P1 | textarea 缺高度限制 | MessageInput.vue | 添加 `min-h-[52px] max-h-[200px]` 和 `@input` 自动高度调整 |
| P2 | ToolCallCard switch 无 default | ToolCallCard.vue | 添加 `default: return 'unknown'` 分支 |
| P2 | 消息 id 硬编码 | ChatView.vue | 使用 `crypto.randomUUID()` 生成唯一 id |
| P3 | StatusBar 数据硬编码 | StatusBar.vue | 后续接入 useChat 的 token 使用数据（依赖后端事件） |

## 可选优化（轻微）

- Active Context 区域硬编码 → 后续从 AppState 读取
- Separator class 覆写 → 检查 shadcn-vue Separator 是否接受 class prop
