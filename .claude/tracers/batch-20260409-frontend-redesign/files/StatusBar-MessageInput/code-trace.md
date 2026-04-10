# 代码链路分析报告

## 概述

- 分析文件：StatusBar.vue, MessageInput.vue, ContextIndicator.vue
- 分析时间：2026-04-09
- 语言类型：Vue 3 (TypeScript + Composition API)

## 调用链路图

```
App.vue
├── StatusBar.vue          [:is-streaming, :model-name]
│   └── ContextIndicator.vue [:percentage="30"]
└── ChatView.vue
    └── MessageInput.vue    [:is-streaming, @send]
```

## 验证结果总表

| # | 验证项 | 状态 | 说明 |
|---|--------|------|------|
| 1 | StatusBar props 匹配 | **不匹配** | 见下方详述 |
| 2 | ContextIndicator props 匹配 | 匹配 | percentage: number 与 :percentage="30" 类型一致 |
| 3 | MessageInput isStreaming 匹配 | 匹配 | boolean 与 reactive boolean ref 绑定 |
| 4 | MessageInput emit(send) 匹配 | 匹配 | emit 签名 [content: string] 与 handleSend(content: string) 一致 |
| 5 | MessageInput 无残留 shadcn 引用 | 通过 | 模板使用原生 textarea/button，无 shadcn 组件 |
| 6 | CSS 类名在 @theme 中有定义 | **部分缺失** | 见下方详述 |
| 7 | 自定义动画类已定义 | 通过 | animate-cursor-blink 和 animate-pulse-dot 均在 main.css 中定义 |

## 链路详情

### 检查项 1: StatusBar props 与 App.vue 传值

**StatusBar.vue props 声明：**
```typescript
defineProps<{
  isStreaming: boolean
  modelName: string
}>()
```

**App.vue 传值：**
```html
<StatusBar
  :is-streaming="false"
  model-name="claude-sonnet-4-5"
/>
```

**问题：isStreaming 硬编码为 `false`。**

App.vue 中 `:is-streaming="false"` 是字面量 false，而非绑定到任何 reactive 状态。这意味着 StatusBar 永远显示 "ready" 状态，无法反映实际的 LLM streaming 状态。

App.vue 应当从某个 composable（如 useChat）获取 isStreaming 状态，或由 ChatView 通过事件冒泡传递上来。目前 App.vue 没有引入 useChat，也没有监听任何 streaming 状态变化。

**严重程度：8/10** -- 功能性缺陷，streaming 状态指示器完全失效。

### 检查项 2: ContextIndicator props 匹配

**ContextIndicator.vue props 声明：**
```typescript
defineProps<{
  percentage: number
}>()
```

**StatusBar.vue 传值：**
```html
<ContextIndicator :percentage="30" />
```

类型匹配，无问题。但 percentage 硬编码为 30，与旁边的 `"1.2k tokens"` 文本一样是占位数据，需要后续接入实际的 context 用量数据。

### 检查项 3: MessageInput isStreaming 匹配

**MessageInput.vue props：**
```typescript
defineProps<{
  isStreaming: boolean
}>()
```

**ChatView.vue 传值：**
```html
<MessageInput :is-streaming="isStreaming" @send="handleSend" />
```

ChatView 中 `isStreaming` 来自 `useChat(sessionIdRef)` 的返回值，是 reactive ref。Vue 会自动解包 ref，传递给 props 时得到 boolean 值。类型和语义均匹配。

### 检查项 4: MessageInput emit 与 ChatView 处理函数

**MessageInput.vue emit：**
```typescript
const emit = defineEmits<{
  send: [content: string]
}>()
// 调用: emit('send', trimmed)
```

**ChatView.vue 监听：**
```html
@send="handleSend"
```
```typescript
function handleSend(content: string) {
  send(content)
}
```

emit 签名 `[content: string]` 与 handleSend 的 `(content: string)` 参数完全匹配。handleSend 内部调用 useChat 的 send 方法，形成完整的数据流。

### 检查项 5: MessageInput 模板无残留 shadcn 引用

MessageInput.vue 模板使用原生 HTML 元素：
- `<textarea>` -- 原生，非 shadcn Textarea
- `<button>` -- 原生，非 shadcn Button
- `<svg>` -- 内联 SVG 图标

没有对 `Textarea` 或 `Button` 组件的引用，移除 shadcn import 后无残留。

### 检查项 6: CSS 类名在 @theme 中的定义情况

**已定义的类名（通过 @theme CSS 变量）：**

| 使用的类名 | 对应 @theme 变量 | 状态 |
|-----------|-----------------|------|
| bg-bg-base | --color-bg-base: #0a0a0b | 有 |
| bg-bg-surface | --color-bg-surface: #111113 | 有 |
| bg-bg-elevated | --color-bg-elevated: #18181b | 有 |
| text-accent | --color-accent: #22c55e | 有 |
| text-text-primary | --color-text-primary: #fafafa | 有 |
| text-text-tertiary | --color-text-tertiary: #71717a | 有 |
| border-border-default | --color-border-default: #27272a | 有 |
| bg-accent-muted | --color-accent-muted: rgba(34, 197, 94, 0.15) | 有 |
| bg-accent-red | --color-accent-red: #ef4444 | 有 |
| bg-accent-yellow | --color-accent-yellow: #eab308 | 有 |

**结论：所有 CSS 自定义颜色类名在 @theme 中均有对应变量定义。** Tailwind v4 的 @theme 指令会自动将 `--color-xxx-yyy` 映射为 `bg-xxx-yyy` / `text-xxx-yyy` / `border-xxx-yyy` 等工具类。

### 检查项 7: 自定义动画类

| 动画类名 | main.css 定义 | 状态 |
|---------|-------------|------|
| animate-pulse-dot | 第 114-116 行，基于 pulse-dot keyframes | 有 |
| animate-cursor-blink | 第 104-106 行，基于 cursor-blink keyframes | 有 |

StatusBar 使用了 `animate-pulse-dot`（streaming 状态灯），MessageInput 当前模板未直接使用 `animate-cursor-blink`，但该动画已定义备用。

## 数据链路图

```
App.vue
  │
  ├─ isStreaming: false (硬编码，无 reactive 来源)
  │   └─→ StatusBar.isStreaming
  │         └─→ 状态灯颜色 + 文本
  │
  └─ currentSessionId (来自 useSession)
      └─→ ChatView.currentSessionId
            └─→ useChat(sessionIdRef)
                  ├─→ messages, streamingText, isStreaming
                  │     ├─→ MessageInput.isStreaming (控制禁用状态)
                  │     └─→ MessageBubble.streamingText
                  └─→ send(content)
                        ↑
                  MessageInput @send → handleSend → send(content)
```

## 问题清单

### 严重问题（8-10 分）

**[P1] StatusBar isStreaming 硬编码为 false -- 8/10**

- 位置：App.vue 第 19 行 `:is-streaming="false"`
- 影响：StatusBar 永远显示 "ready"，streaming 状态灯永远不会脉冲
- ChatView 已经有正确的 isStreaming 状态（来自 useChat），但该状态没有传递到 App 层级的 StatusBar
- 修复建议：在 App.vue 引入 useChat 或创建共享状态，将实际 isStreaming 传递给 StatusBar；或者将 StatusBar 移入 ChatView 内部，直接使用 ChatView 的 isStreaming

### 一般问题（5-7 分）

**[P2] ContextIndicator percentage 和 token 数硬编码 -- 5/10**

- 位置：StatusBar.vue 第 28 行 `:percentage="30"` 和第 30 行 `1.2k tokens`
- 影响：上下文用量显示永远不变，用户无法感知实际 context window 消耗
- 修复建议：StatusBar 需要接收 contextUsage 相关 props，或在 App.vue 层面从 agent 状态获取

### 轻微问题（1-4 分）

**[P3] modelName 硬编码 -- 3/10**

- 位置：App.vue 第 20 行 `model-name="claude-sonnet-4-5"`
- 影响：模型名不会随实际使用的模型变化
- 修复建议：从配置或 agent 状态读取实际模型名

## 建议

1. **将 StatusBar 移入 ChatView 内部**（推荐方案）。ChatView 已持有 useChat 的 isStreaming 状态，可以自然地将 streaming 状态、context usage 传给 StatusBar。这避免了在 App.vue 层级重复引入 useChat 或创建额外的事件传递链。

2. 如果保持当前结构，App.vue 需要从 ChatView 通过事件冒泡（`@streaming-change`）传递 isStreaming 状态，或引入一个全局状态 store。

3. StatusBar 的 context usage 数据源需要从后端 Agent 状态获取。当前后端是否通过 Tauri Event 推送 context usage 信息，需要确认后端事件定义。
