# Phase 1 Architecture Review Report

**Date**: 2026-05-06 | **Reviewer**: Architecture Review | **Scope**: spec.md + plan.md + plan-00 through plan-10 + pi SDK API Reference

---

## 1. pi SDK API 兼容性问题

### 1.1 AgentSession 方法名全部不匹配 [P0]

Plan-10 `pi-bridge.ts` 使用推测性 API 调用名称，与 pi SDK 实际 API 完全不一致：

| Plan 中的调用 | pi SDK 实际 API | 说明 |
|--------------|----------------|------|
| `piAgent.sendMessage(session, content)` | `session.prompt(text)` 或 `session.sendUserMessage(content)` | prompt 是主入口 |
| `piAgent.abortSession(session)` | `session.abort()` | 直接在 session 上调用 |
| `piAgent.switchModel(session, modelId)` | `session.setModel(model)` 其中 model 是 `Model<Api>` 对象 | 不能直接传 string modelId |
| `piAgent.listModels()` | `modelRegistry.getAvailable()` | 需要先初始化 ModelRegistry |
| `piAgent.destroySession(session)` | `session.dispose()` | 方法名不同 |
| `piAgent.createAgentSession({ cwd })` | `createAgentSession({ cwd })` — 命名导出 | 调用方式不同 |

**修正建议**：
- `sidecar/src/pi-bridge.ts` 需要完全重写
- 使用 `import { createAgentSession } from '@mariozechner/pi-coding-agent'` 而非动态 import
- 维护 `AgentSession` 实例的 Map，直接调用实例方法
- 模型切换需要先从 `ModelRegistry.find(provider, modelId)` 获取 `Model` 对象

### 1.2 事件类型映射不正确 [P0]

Plan 定义的 WS 协议事件类型与 pi SDK 的 `AgentSessionEvent` 映射关系：

| WS 协议事件 | pi SDK AgentEvent | pi SDK AssistantMessageEvent |
|------------|-------------------|------------------------------|
| `message.text_delta` | `message_update` (需解析) | `text_delta` |
| `message.thinking_delta` | `message_update` (需解析) | `thinking_delta` |
| `message.tool_call_start` | `tool_execution_start` | `toolcall_start` (注意无下划线) |
| `message.tool_call_end` | `tool_execution_end` | `toolcall_end` |
| `message.complete` | `turn_end` | `done` (reason: `toolUse` 而非 `tool_use`) |

**问题**：
1. `event-adapter.ts` 需要订阅 `session.subscribe()` 获得的 `AgentSessionEvent`，但 plan-10 的 `EventAdapter` 是手工构造的，没有实际连接到 pi SDK 事件系统
2. pi SDK 的 `toolcall_start/end` 使用驼峰式（无下划线），WS 协议使用下划线
3. pi SDK `done` 事件的 `reason: "toolUse"` 需要映射到 WS 协议的 `stopReason`

**修正建议**：
- `event-adapter.ts` 需要实现为 `AgentSessionEventListener`
- 订阅 `session.subscribe()` 并映射事件类型
- 处理 `AssistantMessageEvent` 的嵌套事件（通过 `message_update` 中的 `assistantMessageEvent` 字段）

### 1.3 Session 创建依赖链不完整 [P1]

`createAgentSession` 的完整初始化链：

```
createAgentSession()
  → 默认: AuthStorage.create(~/.pi/agent/auth.json)
  → 默认: ModelRegistry.create(authStorage, ~/.pi/agent/models.json)
  → 默认: SessionManager.create(cwd, ~/.pi/agent/sessions/)
  → 返回: { session, extensionsResult, modelFallbackMessage? }
```

Plan-10 的 `pi-bridge.ts` 没有初始化 `AuthStorage` 和 `ModelRegistry`，导致无法获取模型列表和 API Key。

**修正建议**：
- 在 `PiBridge` 构造函数中初始化 `AuthStorage` 和 `ModelRegistry`
- 将它们传递给 `createAgentSession` 的 options
- 或者依赖默认行为（读取 `~/.pi/agent/` 目录）

### 1.4 配置文件格式完全不对 [P1]

Plan-10 `config-store.ts` 读取 `~/.xyz-agent/config.toml` 和 `~/.pi/config.toml`，但：

1. **pi 没有 `~/.pi/config.toml`** — 设置存储在 `~/.pi/agent/auth.json` 和 `~/.pi/agent/models.json`
2. pi 的 Provider 配置在 `models.json` 的 `providers` 字段中
3. API Key 在 `auth.json` 中
4. Plan 自己写了一个简易 TOML 解析器 — 脆弱且不必要

**修正建议**：
- 使用 pi SDK 的 `AuthStorage` 读取/写入 API Key
- 使用 pi SDK 的 `ModelRegistry` 管理 Provider 和模型配置
- 如果 xyz-agent 需要自己的配置，使用 JSON（与 pi 保持一致）而非 TOML
- 删除自定义 TOML 解析器

### 1.5 StopReason 枚举不匹配 [P2]

pi SDK: `"stop" | "length" | "toolUse" | "error" | "aborted"`
WS 协议: `"end_turn"` (plan 中未定义枚举)

**修正建议**：在 protocol.ts 中定义 `StopReason` 枚举并在 event-adapter 中做映射。

---

## 2. 架构设计缺陷

### 2.1 Sidecar 集成方式：应考虑 RPC 模式 [P2]

当前方案：直接 import pi SDK 到 Node.js sidecar → 启动 WS 服务器。
设计总纲提到后续 Phase 使用 `--mode rpc` 进行进程隔离。

**问题**：P1 直接 import 的方式在 P6 引入 RPC 模式时需要大量重构。

**建议**：P1 保持当前方式（import SDK），但在 `pi-bridge.ts` 中建立清晰的抽象层，使后续切换到 RPC 模式只需替换 bridge 实现。当前 plan 的 `PiBridge` 接口设计已经做到了这一点，但需要确保所有调用都通过接口而非直接访问 pi SDK 对象。

### 2.2 协议类型前后端手工同步 [P1]

`src/types/protocol.ts` 和 `sidecar/src/protocol.ts` 包含相同的类型定义，需要手工保持同步。

**修正建议**：
- 将共享类型提取到 `packages/protocol/` 或使用 symlinks
- 或者在 sidecar 中直接引用前端类型（如果 tsconfig paths 支持）
- 最低要求：在 CI 中添加类型一致性检查脚本

### 2.3 错误处理策略缺失 [P1]

所有 plan 中没有统一的错误处理策略：

1. pi SDK 调用失败时没有重试逻辑
2. WS 断连期间发出的消息没有队列缓冲
3. 前端 `useChat.ts` 的 `handleError` 将错误作为 assistant 消息显示，但格式不规范
4. Sidecar 没有全局错误边界（process uncaughtException 处理）

**修正建议**：
- 在 `ws-client.ts` 中添加消息发送队列（离线缓冲）
- 在 `pi-bridge.ts` 中添加自动重试（API 限流、网络超时）
- 在 sidecar `index.ts` 中注册 `process.on('uncaughtException')`
- 定义 `AppError` 类型替代字符串错误

### 2.4 WebSocket 端口发现机制缺失 [P0]

**严重不一致**：
- Plan-01 `sidecar/src/index.ts`：默认端口 `9250`
- Plan-04 `sidecar/src/index.ts`：默认端口 `17777`
- Plan-10 `sidecar/src/index.ts`：默认端口 `3210`
- Plan-05 `useConnection.ts`：连接 `ws://localhost:3210`
- Plan-10 `sidecar.rs`：`DEFAULT_SIDECAR_PORT = 3210`

前端如何知道 sidecar 监听在哪个端口？如果端口被占用怎么办？

**修正建议**：
- 统一默认端口（建议 `3210`）
- Rust sidecar 启动时动态选择可用端口
- 通过 Tauri event 将端口号传递给前端
- 或使用固定端口 + 端口文件（`~/.xyz-agent/sidecar.port`）

### 2.5 Tauri Sidecar 生命周期管理缺陷 [P1]

Plan-10 `sidecar.rs` 的问题：

1. 使用 `Command::new("node")` 而非 Tauri 的 sidecar API — 生产环境用户可能没装 Node.js
2. 没有处理 sidecar 崩溃重启
3. 健康检查用 TCP 连接测试，但 WS 服务器可能还没 ready
4. `check_health` 使用同步 `TcpStream::connect` 在 `start_sidecar` 中，但后者被 `spawn_blocking` 调用
5. 生产环境需要 bundled sidecar 二进制（通过 pkg 或 nexe 编译 Node.js）

**修正建议**：
- 开发模式用 `node sidecar/dist/index.js`
- 生产模式用 pkg 编译为单二进制 + Tauri sidecar API
- 添加 sidecar 崩溃检测和自动重启
- 使用 HTTP health check 替代 TCP（`GET /health`）
- 将 `tauri-plugin-shell` 添加到 `Cargo.toml` 的 dependencies

---

## 3. 前端架构遗漏

### 3.1 Tailwind v4 CSS-first 配置不完整 [P0]

Plan-03 设计系统组件使用 shadcn-vue 风格的 utility class（`bg-primary`, `text-primary-foreground`, `bg-destructive` 等），但这些 class 在 Tailwind v4 中**默认不存在**。

Tailwind v4 的颜色 class 来自 `@theme` 中定义的 `--color-*` 变量。例如 `bg-primary` 需要 `--color-primary` 存在。

Plan-02 的 tokens 注入了 `--color-bg-base`, `--color-text-primary` 等变量，但没有创建 `--color-primary`, `--color-destructive`, `--color-ring`, `--color-background`, `--color-foreground` 等 shadcn-vue 期望的变量。

**修正建议**：
- 在 `src/assets/main.css` 的 `@theme` 块中添加所有 shadcn-vue 需要的颜色映射
- 或者在 `tokens/colors.ts` 中添加 shadcn 别名 token：
  ```typescript
  'primary': { light: 'oklch(64% 0.13 28)', dark: 'oklch(68% 0.13 28)' },
  'destructive': { light: 'oklch(62% 0.2 25)', dark: 'oklch(62% 0.2 25)' },
  'foreground': { light: 'oklch(22% 0.02 50)', dark: 'oklch(92% 0.008 70)' },
  'background': { light: 'oklch(99% 0.008 70)', dark: 'oklch(20% 0.015 50)' },
  // ... etc
  ```
- Plan-03 的 Badge 组件使用 `bg-emerald-500/15` 是硬编码颜色（违反自己的 taste-lint 规则）

### 3.2 视图切换机制不完整 [P1]

Plan-05 定义了标准/专注两种视图模式，但缺少：
- 专注模式的状态管理（`focusMode` ref 只在 Plan-08 的 App.vue 注释中提到）
- `Cmd+1` / `Cmd+3` 快捷键注册
- 专注模式下隐藏 Sidebar 和 Statusbar 的条件渲染

**修正建议**：在 App.vue 中添加 `focusMode` ref 和键盘监听：
```typescript
const focusMode = ref(false)
function handleKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === '1') focusMode.value = false
  if ((e.metaKey || e.ctrlKey) && e.key === '3') focusMode.value = true
}
```

### 3.3 虚拟滚动配置缺失 [P2]

Plan-07 的 `MessageList.vue` 使用 `@tanstack/vue-virtual`，但：
- `estimateSize` 函数的估算过于粗糙（60px vs 120px）
- 消息高度变化大（短消息 ~40px，长消息 ~300px，工具调用卡片 ~80-200px）
- 虚拟滚动需要 `measureElement` 来动态测量高度
- 没有处理 Markdown 渲染后高度变化

**修正建议**：使用 `measureElement` 动态测量：
```typescript
const virtualizer = useVirtualizer({
  get count() { return props.messages.length },
  getScrollElement: () => scrollRef.value,
  estimateSize: () => 80,
  overscan: 5,
  measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
})
```

### 3.4 Markdown 渲染管线未在 main.ts 初始化 [P2]

Plan-07 创建 `src/lib/markdown.ts`，但：
- `markdown-it` 和 `dompurify` 在 Plan-01 已安装
- 代码块样式（`<pre>` 的黑白底色）没有在 CSS 中定义
- `prose` class（来自 Tailwind Typography）未安装

**修正建议**：
- 安装 `@tailwindcss/typography` 或手动定义 `.prose` 样式
- 在 `main.css` 中添加代码块样式

### 3.5 Toast 通知系统未集成 [P1]

Plan-01 安装了 `vue-sonner`，但没有任何 plan 展示如何集成：
- 没有在 `App.vue` 中添加 `<Toaster />` 组件
- 没有创建 toast 工具函数
- 错误提示（`useChat.ts` 的 `handleError`）应该使用 toast 而非将错误作为消息显示

**修正建议**：在 `App.vue` 中添加：
```vue
<script setup>
import { Toaster } from 'vue-sonner'
</script>
<template>
  <Toaster position="top-right" />
  <!-- rest of app -->
</template>
```

### 3.6 Tauri 全局快捷键未注册 [P2]

`Cmd+J`（总览）、`Cmd+1`（标准）、`Cmd+3`（专注）等快捷键需要通过 Tauri 的 `tauri-plugin-global-shortcut` 注册，但没有任何 plan 提到。

**修正建议**：P1 可以先用前端 `document.addEventListener('keydown')` 处理，后续 Phase 再迁移到 Tauri global shortcuts。

### 3.7 Pinia persist 插件配置位置 [P2]

Plan-02 的 `main.ts` 和 Plan-05 的 `main.ts` 内容冲突。Plan-02 注册了 i18n + injectTokens，Plan-05 注册了 pinia + persist。需要合并为同一个 main.ts，确保两个插件都注册。

---

## 4. 后端架构遗漏

### 4.1 pi-bridge 实际初始化依赖链 [P0]

`createAgentSession` 的实际依赖初始化：

```typescript
// 需要在 PiBridge 初始化时完成：
import { createAgentSession } from '@mariozechner/pi-coding-agent'

// 方案 A：使用默认值（依赖 ~/.pi/agent/ 目录结构）
const { session } = await createAgentSession({ cwd })

// 方案 B：自定义 AuthStorage + ModelRegistry
import { AuthStorage } from '@mariozechner/pi-coding-agent'
import { ModelRegistry } from '@mariozechner/pi-coding-agent'

const authStorage = AuthStorage.create('~/.pi/agent/auth.json')
const modelRegistry = ModelRegistry.create(authStorage, '~/.pi/agent/models.json')
const { session } = await createAgentSession({ cwd, authStorage, modelRegistry })
```

**Plan-10 完全没有展示这些初始化步骤。**

**修正建议**：在 `PiBridge` 构造函数中初始化 `AuthStorage` 和 `ModelRegistry`，并在创建 session 时传入。

### 4.2 event-adapter 需要处理的事件完整列表 [P1]

Plan-04 定义了 6 种事件，但 pi SDK 的 `AgentSessionEvent` 包含更多：

| pi SDK 事件 | WS 协议对应 | Plan 是否处理 |
|------------|-----------|-------------|
| `turn_start` | 无 | ❌ |
| `turn_end` | `message.complete` | ✅ (间接) |
| `message_start` | 无 | ❌ |
| `message_update` | text_delta/thinking_delta/tool_call_* | ✅ (间接) |
| `message_end` | 无 | ❌ |
| `tool_execution_start` | `message.tool_call_start` | ✅ |
| `tool_execution_update` | 无 | ❌ |
| `tool_execution_end` | `message.tool_call_end` | ✅ |
| `compaction_start` | 无 | ❌ |
| `compaction_end` | 无 | ❌ |
| `queue_update` | 无 | ❌ |
| `session_info_changed` | 无 | ❌ |
| `auto_retry_start` | 无 | ❌ |
| `auto_retry_end` | 无 | ❌ |

**修正建议**：
- P1 只处理核心事件（text/thinking/tool_call/complete/error），通过 `message_update` 事件中的 `assistantMessageEvent` 字段获取增量数据
- 为后续 Phase 预留 compaction/retry 事件的处理接口

### 4.3 config-store 应使用 pi SDK 而非自建 [P1]

Plan-10 的 `config-store.ts` 自己写 TOML 解析器和配置管理，但 pi SDK 已经提供：
- `AuthStorage`：管理 API Key 和 OAuth
- `ModelRegistry`：管理 Provider 和模型配置
- 配置存储在 `~/.pi/agent/auth.json` 和 `~/.pi/agent/models.json`

**修正建议**：
- 删除自定义 TOML 解析器
- 使用 pi SDK 的 `AuthStorage` 管理 API Key
- 使用 pi SDK 的 `ModelRegistry` 管理模型列表
- xyz-agent 自己的设置（语言、主题、默认模型）使用 JSON 存储

### 4.4 Session History JSONL 类型映射缺失 [P1]

Plan-10 的 `session.history` 路由返回空数组。pi SDK 的 JSONL 格式：

```jsonl
{"type":"session","id":"...","timestamp":"...","cwd":"..."}
{"type":"message","id":"...","parentId":null,"message":{"role":"user","content":"..."}}
{"type":"message","id":"...","parentId":"...","message":{"role":"assistant","content":[...]}}
{"type":"model_change","provider":"anthropic","modelId":"claude-sonnet"}
```

需要将这些 entry 映射为前端的 `Message` 类型。

**修正建议**：
- 使用 `sessionManager.getBranch()` 获取当前分支的 entries
- 将 `SessionMessageEntry` 映射为前端 `Message` 类型
- 处理 `toolResult` role（前端没有对应类型）

---

## 5. Plan 步骤缺失

### Plan-00 (Cleanup) — 完整，无重大遗漏

### Plan-01 (Scaffold)

| # | 问题 | 优先级 | 修正 |
|---|------|--------|------|
| 1 | `sidecar/src/index.ts` 默认端口 9250，与后续 plan 的 3210/17777 不一致 | P0 | 统一为 3210 |
| 2 | 没有安装 `@tailwindcss/typography`（Plan-07 的 `prose` class 需要） | P2 | 在 Step 3 安装 |
| 3 | `src/App.vue` 使用 `bg-base` 和 `text-foreground` class，但这些 token 还没定义 | P2 | 先使用 `var(--color-*)` 或等 Task 2 完成 |
| 4 | 缺少 `vue-sonner` 的 `<Toaster>` 集成位置说明 | P2 | 在 App.vue 添加 |

### Plan-02 (Foundation)

| # | 问题 | 优先级 | 修正 |
|---|------|--------|------|
| 1 | CSS token 注入通过 JS (`injectTokens()`)，但 Tailwind v4 的 `@theme` 块才能让 utility class 工作 | P0 | 将 color tokens 移到 `@theme` 块中，或添加 shadcn 别名映射 |
| 2 | `useTheme.ts` 与 `settings.ts` store 中的 theme 管理冲突 — 两个地方都在管理主题 | P1 | 统一为 store 管理，ThemeProvider 读取 store |
| 3 | 步骤 2D-7 的 `eslint.config.mjs` 仅 `import tasteConfig` 但 taste-lint 可能依赖不存在的 plugins | P1 | 需要先验证 taste-lint 是否能独立运行 |

### Plan-03 (Design System)

| # | 问题 | 优先级 | 修正 |
|---|------|--------|------|
| 1 | 组件使用 `bg-primary`, `text-primary-foreground` 等 class 但这些未在 Tailwind v4 @theme 中定义 | P0 | 添加 `@theme { --color-primary: ...; --color-destructive: ...; }` |
| 2 | Badge.vue 使用 `bg-emerald-500/15 text-emerald-700` — 硬编码 Tailwind 默认颜色，违反 taste-lint | P1 | 改用 design token：`bg-success/15 text-success` |
| 3 | Input.vue 的 `aria-label` 使用 `t('common.inputError')` 但 i18n schema 中没有这个 key | P2 | 添加到 i18n 或改用已有 key |
| 4 | Textarea.vue 使用 `ref<HTMLTextAreaElement>()` 但没 import `ref` | P1 | 添加 `import { ref, onMounted } from 'vue'` |

### Plan-04 (Communication)

| # | 问题 | 优先级 | 修正 |
|---|------|--------|------|
| 1 | `ws-client.ts` 的 `WsClient` 类没有 `onOpen()`, `onClose()`, `onError()` 方法，但 Plan-05 的 `useConnection.ts` 调用了它们 | P0 | 在 WsClient 中添加这些方法，或修改 useConnection 使用 `onStateChange()` |
| 2 | `eventBus.on()` 的 handler 签名是 `(message: ServerMessage) => void`，但 Plan-05 的 handlers 直接解构 payload | P0 | 统一签名：要么 eventBus 传递 payload，要么 handlers 接收 ServerMessage |
| 3 | `sidecar/src/index.ts` 默认端口 `17777`，与 Plan-01/10 不一致 | P0 | 统一为 3210 |
| 4 | `config-store.ts` (Step 18) 使用 JSON 格式 (`config.json`)，但 Plan-10 (Step 16) 使用 TOML 格式 | P1 | 统一格式 |

### Plan-05 (State Layer + Shell)

| # | 问题 | 优先级 | 修正 |
|---|------|--------|------|
| 1 | `useConnection.ts` 调用不存在的 `wsClient.onOpen/onClose/onError` | P0 | 改用 `wsClient.onStateChange()` |
| 2 | `useChat.ts` event handlers 期望解构后的 payload，但 eventBus 传递 `ServerMessage` | P0 | handlers 需要改为 `(msg: ServerMessage) => { const data = msg.payload as X ... }` |
| 3 | `useSession.ts` 的 `handleSessionList` 期望 `data.sessions` 但 protocol 定义 payload 为 `groups` | P1 | 统一 payload 结构 |
| 4 | `settings.ts` store 的 `Theme` 类型是 `'light' | 'dark' | 'system'`，但 `useTheme.ts`（Plan-02）是 `'light' | 'dark'` | P1 | 统一类型定义 |
| 5 | `chat.ts` store 的 `ToolCall.status` 使用 `'completed'` 但 protocol/message.ts 用 `'done'` | P1 | 统一为 `'completed'` 并更新 protocol.ts |
| 6 | App.vue 缺少 `<Toaster />` 组件（vue-sonner） | P2 | 添加 |
| 7 | App.vue 的 Settings 关闭按钮使用原生 `<button>` | P2 | 改用 design-system Button |
| 8 | i18n 补充的 key 与 Plan-02 创建的 schema 结构不匹配（header/sidebar/chat/statusbar 是扁平的还是嵌套的） | P1 | 确保 MessageSchema 接口包含所有需要的 key |

### Plan-07 (Chat)

| # | 问题 | 优先级 | 修正 |
|---|------|--------|------|
| 1 | `MessageBubble.vue` import `ChatMessage`, `AssistantSegment`, `TaskNode` from `@/types` — 这些类型不存在 | P0 | 要么在 `types/` 中定义这些类型，要么重写 MessageBubble 使用 Plan-04 定义的 `Message` 类型 |
| 2 | `ChatInput.vue` import `Button` from `@/components/ui/button` — 应该从 `@/design-system` import | P0 | 修正 import 路径 |
| 3 | `ModelPicker.vue` import `useModelManager` from `@/composables/useModelManager` — 不存在 | P0 | 改用 `useModel` from `@/composables/useModel` |
| 4 | `ModelPicker.vue` 使用 `ModelTier` 类型 — 未在任何 plan 中定义 | P1 | 在 `types/provider.ts` 中添加或删除 |
| 5 | `ToolCallCard.vue` import `getToolDangerLevel` from `@/types` — 不存在 | P1 | 在 types 中定义或删除 |
| 6 | `SlashMenu.vue` 有重复的 `defineProps` 调用 | P1 | 删除第二个 |
| 7 | `MessageBubble.vue` 使用 `v-html="renderMarkdown()"` — 安全风险虽然已通过 DOMPurify 缓解，但需确保所有路径都经过消毒 | P2 | 已有，确认 DOMPurify 配置正确 |

### Plan-08-09-10 (Session + Settings + Integration)

| # | 问题 | 优先级 | 修正 |
|---|------|--------|------|
| 1 | `AppSidebar.vue` 传递 `@close` 给 Dialog，但 Dialog 组件使用 `@update:open` | P0 | 修改为 `@update:open="cancelDelete"` |
| 2 | `ProviderList.vue` 使用 `provider.connected: boolean` 但 `ProviderInfo` 类型有 `status: ProviderStatus` | P0 | 统一为 `status` 字段或修改类型定义 |
| 3 | `ProviderForm.vue` 传递 `options` prop 给 Select，但 Plan-03 的 Select 使用 `groups` prop | P0 | 修改 ProviderForm 使用 Select 的正确 API |
| 4 | `sidecar.rs` 使用 `libc::kill()` 但 `libc` 不在 `Cargo.toml` 的通用 dependencies 中 | P1 | 添加到 unix target dependencies（Plan-10 Step 28 已有，但 Step 22 引用更早） |
| 5 | `dialog.rs` 使用 `tokio::sync::oneshot` 但 `tokio` 在 Step 28 才添加到 dependencies | P1 | 将 tokio 添加时间提前，或改用 std::sync::mpsc |
| 6 | `main.rs` 使用 `tauri_plugin_shell` 和 `tauri_plugin_dialog` 但 `Cargo.toml` 没有这些依赖 | P0 | 在 Cargo.toml 中添加 |
| 7 | `pi-bridge.ts` 的所有 pi SDK 调用都是推测性的，与实际 API 不匹配 | P0 | 根据 §1.1 的映射表重写 |
| 8 | `server.ts` 的 `SidecarServer` 完全重写了 Plan-04 的 `server.ts`，但没有说明是替换还是增量更新 | P1 | 明确标注为"替换" |
| 9 | SessionItem.vue 右键菜单使用原生 `<div>` + Teleport，没有使用 design-system 的 Dropdown 组件 | P2 | 改用 Dropdown 组件 |
| 10 | Plan-10 Step 16 的 `config-store.ts` 使用同步 fs API (`readFileSync`)，而 Step 15 的 `config-store.ts` 使用异步 API | P1 | 统一为异步或同步 |

---

## 6. 类型一致性问题

### 6.1 ToolCall.status 枚举不一致 [P1]

| 文件 | 定义 |
|------|------|
| `src/types/message.ts` (Plan-04) | `'running' \| 'done' \| 'error'` |
| `src/stores/chat.ts` (Plan-05) | `'running' \| 'completed' \| 'error'` |
| `sidecar/src/protocol.ts` (Plan-10) | `'running' \| 'completed' \| 'error'` |
| `ToolCallCard.vue` (Plan-07) | `'running' \| 'error' \| 'completed'` |

**修正**：统一为 `'running' | 'completed' | 'error'`，更新 `src/types/message.ts`。

### 6.2 SessionSummary.lastActiveAt 类型冲突 [P1]

| 文件 | 类型 |
|------|------|
| `src/types/session.ts` (Plan-04) | `string` (ISO 8601) |
| `sidecar/src/session-pool.ts` (Plan-04) | `string` (ISO from `new Date().toISOString()`) |
| `src/stores/session.ts` (Plan-05) | 当作 `number` 使用（`Date.now() - session.lastActiveAt`） |
| `src/composables/useSession.ts` (Plan-05) | `lastActiveAt: Date.now()` (number) |
| `SessionItem.vue` (Plan-08) | `Date.now() - props.session.lastActiveAt` (期望 number) |

**修正**：在 `src/types/session.ts` 中将 `lastActiveAt` 改为 `number`（时间戳），所有创建/比较处统一使用 `Date.now()`。

### 6.3 ProviderInfo 字段名不一致 [P0]

| 文件 | 字段 |
|------|------|
| `src/types/provider.ts` (Plan-04) | `status: ProviderStatus` (`'connected' \| 'not_configured' \| 'error'`) |
| `src/composables/useProvider.ts` (Plan-05) | 不直接引用，通过 WS 获取 |
| `ProviderList.vue` (Plan-09) | `provider.connected: boolean` |
| `sidecar server.ts` (Plan-10) | `connected: !!p.apiKey` (boolean) |

**修正**：选择一种方案：
- 方案 A：`status: ProviderStatus` — 所有使用处检查 `status === 'connected'`
- 方案 B：`connected: boolean` — 简化类型，删除 `ProviderStatus`

建议方案 A，因为保留更多语义。

### 6.4 Message 类型在 Plan-07 中被完全替换但未同步 [P0]

Plan-04 定义的 `Message` 类型：
```typescript
interface Message {
  id: string; role: MessageRole; content: string; status: MessageStatus;
  toolCalls?: ToolCall[]; thinking?: ThinkingBlock[]; usage?: Usage; timestamp: number;
}
```

Plan-07 `MessageBubble.vue` 使用的类型：
```typescript
interface ChatMessage {
  id: string; role: string; content: string; segments?: AssistantSegment[];
  // segments 包含 text/tool/thinking 类型的联合
}
```

这两个类型完全不兼容。Plan-07 假设 messages 有 `segments` 字段（类似 Claude Code 的 segmented rendering），但 Plan-04/05 使用的是扁平的 `content` + `toolCalls` + `thinking` 字段。

**修正**：选择一种消息模型：
- 方案 A：保留 Plan-04 的扁平模型，重写 Plan-07 的 MessageBubble
- 方案 B：引入 segments 模型，更新 Plan-04/05 的类型定义和 store 逻辑

建议方案 A（P1 保持简单），plan-07 的 MessageBubble 需要重写以使用 `content` + `toolCalls` + `thinking`。

### 6.5 event handler 签名不匹配 [P0]

`eventBus.emit(message: ServerMessage)` 传递完整的 ServerMessage 对象。

但所有 composable 中的 handler 期望直接的数据对象：
```typescript
// useChat.ts
handleTextDelta(data: { sessionId: string; delta: string })
// 实际应该是：
handleTextDelta(msg: ServerMessage) {
  const data = msg.payload as TextDeltaPayload
  ...
}
```

**修正**：所有 eventBus handler 统一接收 `ServerMessage`，在内部解析 `msg.payload`。

### 6.6 Session List Payload 结构不一致 [P1]

| 文件 | 结构 |
|------|------|
| `protocol.ts` (Plan-04) `SessionListPayload` | `{ groups: Array<{ cwd, sessions }>` } |
| `useSession.ts` (Plan-05) `handleSessionList` | `data.sessions: SessionSummary[]` (flat) |
| `sidecar server.ts` (Plan-10) `sendSessionList` | `sessions: SessionSummary[]` (flat) |
| `sidecar session-pool.ts` (Plan-04) | `groupSessionsByCwd()` returns grouped |

**修正**：统一为 grouped 格式（与 protocol.ts 一致），更新 `useSession.ts` 和 sidecar server。

---

## 7. 修正建议汇总

### P0 — 阻塞实现的问题（必须修复后才能开始编码）

| # | 问题 | 修复位置 | 具体修改 |
|---|------|---------|---------|
| 1 | pi SDK API 调用名全部错误 | `sidecar/src/pi-bridge.ts` | 根据 §1.1 映射表重写，使用 `session.prompt()`, `session.abort()`, `session.setModel()`, `session.dispose()`, `session.subscribe()` |
| 2 | ws-client 缺少 onOpen/onClose/onError | `src/lib/ws-client.ts` 或 `src/composables/useConnection.ts` | 要么在 WsClient 添加事件方法，要么 useConnection 改用 `onStateChange()` |
| 3 | eventBus handler 签名不匹配 | `src/composables/*.ts` | 所有 handler 统一接收 `ServerMessage`，内部解析 `msg.payload` |
| 4 | 端口不一致 (9250/17777/3210) | Plan-01, Plan-04, Plan-05, Plan-10 | 全部统一为 `3210` |
| 5 | Tailwind v4 utility class 不存在 | `src/assets/main.css` | 在 `@theme` 块中添加 `--color-primary`, `--color-destructive`, `--color-foreground`, `--color-background`, `--color-muted`, `--color-ring`, `--color-input`, `--color-border`, `--color-accent` 等 shadcn-vue 需要的变量 |
| 6 | Plan-07 使用不存在的类型/imports | `src/components/chat/*.vue` | 修正 import 路径（design-system 而非 ui/），删除对 ChatMessage/AssistantSegment/TaskNode 的引用，使用 Plan-04 定义的 Message 类型 |
| 7 | ProviderInfo 字段不一致 | `src/types/provider.ts` + 所有使用处 | 统一为 `status: ProviderStatus`，修改 Plan-09 组件使用 `provider.status === 'connected'` 而非 `provider.connected` |
| 8 | Dialog 事件名不匹配 | `AppSidebar.vue` | `@close` → `@update:open` |
| 9 | Select prop 不匹配 | `ProviderForm.vue` | `options` → `groups`（或为 Select 添加 `options` 简化 prop） |
| 10 | Cargo.toml 缺少 plugin 依赖 | `src-tauri/Cargo.toml` | 添加 `tauri-plugin-shell` 和 `tauri-plugin-dialog` |

### P1 — 重要问题（应该修复）

| # | 问题 | 修复位置 | 具体修改 |
|---|------|---------|---------|
| 1 | pi SDK 依赖初始化链缺失 | `sidecar/src/pi-bridge.ts` | 在构造函数中初始化 AuthStorage 和 ModelRegistry |
| 2 | 前后端 protocol 类型手工同步 | `sidecar/src/protocol.ts` | 提取共享包或添加 CI 一致性检查 |
| 3 | 错误处理策略缺失 | 全局 | 定义 AppError 类型，添加消息发送队列，添加重试逻辑 |
| 4 | 主题管理冲突 | Plan-02 `useTheme.ts` vs Plan-05 `settings.ts` | 统一由 settings store 管理主题，ThemeProvider 读取 store |
| 5 | ToolCall status 枚举 | `src/types/message.ts` | `'done'` → `'completed'` |
| 6 | lastActiveAt 类型 | `src/types/session.ts` | `string` → `number` |
| 7 | Toast 系统未集成 | `src/App.vue` | 添加 `<Toaster />` 和 toast 工具函数 |
| 8 | Textarea.vue 缺少 ref import | `src/design-system/components/Textarea.vue` | 添加 `import { ref, onMounted } from 'vue'` |
| 9 | config-store 应使用 pi SDK | `sidecar/src/config-store.ts` | 使用 AuthStorage/ModelRegistry 替代自建 TOML 解析器 |
| 10 | i18n schema 结构不匹配 | `src/i18n/types.ts` | 确保 MessageSchema 包含所有 Plan-05/06/08/09 引用的 key |

### P2 — 锦上添花

| # | 问题 | 修复位置 | 具体修改 |
|---|------|---------|---------|
| 1 | 虚拟滚动 height 测量 | `MessageList.vue` | 使用 measureElement 动态测量 |
| 2 | Markdown prose 样式 | `src/assets/main.css` | 安装 `@tailwindcss/typography` 或手写 prose 样式 |
| 3 | Badge 硬编码 emerald 颜色 | `Badge.vue` | 改用 design token |
| 4 | SlashMenu 重复 defineProps | `SlashMenu.vue` | 删除第二个 |
| 5 | SessionItem 右键菜单用原生 div | `SessionItem.vue` | 改用 Dropdown 组件 |
| 6 | 全局快捷键（Cmd+1/3） | `App.vue` | 添加前端 keydown 监听 |
| 7 | StopReason 枚举映射 | `event-adapter.ts` | 定义 `StopReason` 并映射 pi 的 `"toolUse"` → WS 协议 |

---

## 附录：Plan-07 与 Plan-04/05 的根本矛盾

Plan-07 (Chat Features) 假设的消息渲染模型与 Plan-04/05 (Communication + State) 定义的数据模型**完全不兼容**。这是整个 plan 体系中最严重的结构性问题。

**Plan-04/05 的模型**（扁平消息）：
```
Message { content: string, toolCalls?: ToolCall[], thinking?: ThinkingBlock[] }
```

**Plan-07 的模型**（分段消息，参考 shadcn-vue/Claude Code 风格）：
```
ChatMessage { content: string, segments?: AssistantSegment[] }
AssistantSegment = { type: 'text', text } | { type: 'tool', call } | { type: 'thinking', text }
```

**影响范围**：
- `MessageBubble.vue` — 完全基于 segments 模型编写
- `MessageList.vue` — 传递 ChatMessage 和 TaskNode
- `ChatInput.vue` — 使用不存在的 import 路径
- `ModelPicker.vue` — 使用不存在的 composable
- `ToolCallCard.vue` — 使用不存在的 helper 函数

**建议**：Plan-07 需要重写。保留其 Markdown 渲染、虚拟滚动、输入区等核心组件的思路，但数据模型和 import 路径必须对齐 Plan-04/05。这是开始实现前**最优先**需要解决的问题。
