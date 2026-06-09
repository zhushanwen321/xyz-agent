# Phase 1: Hello pi — 规格修正文档

**日期**: 2026-05-06 | **基于**: review-report.md 对 spec.md + plan.md 的审查

---

## 1. Spec Text Changes

### 1a. Section 五 (WS Protocol) — 事件类型名称映射

**Section**: 五.3 Sidecar → 客户端

**问题**: WS 协议使用下划线命名的事件类型（如 `message.tool_call_start`），但 pi SDK 的 `AssistantMessageEvent` 使用驼峰式（如 `toolcall_start`）。Spec 需要在事件表中补充映射关系，使 event-adapter 实现者清楚两层之间的转换。

**Current text** (部分引用):

```
| `message.tool_call_start` | `{ sessionId, toolCallId, toolName, input }` | 工具调用开始 |
| `message.tool_call_end`   | `{ sessionId, toolCallId, output }`           | 工具调用结束 |
| `message.complete`        | `{ sessionId, stopReason, usage }`            | 消息生成完毕 |
```

**Corrected text** — 替换整个五.3表格，增加 "pi SDK 事件源" 列：

```markdown
### 5.3 Sidecar → 客户端

| type | payload | pi SDK 事件源 | 说明 |
|------|---------|-------------|------|
| `session.created` | `{ sessionId, label, cwd }` | — | 会话创建成功 |
| `session.deleted` | `{ sessionId }` | — | 会话已删除 |
| `session.list` | `{ groups: Array<{ cwd, sessions: SessionSummary[] }> }` | — | 会话列表（按 cwd 分组） |
| `session.history` | `{ sessionId, messages: Message[] }` | `sessionManager.getBranch()` | 历史消息 |
| `message.text_delta` | `{ sessionId, delta }` | `message_update` → `assistantMessageEvent.text_delta` | 流式文本片段 |
| `message.thinking_delta` | `{ sessionId, delta }` | `message_update` → `assistantMessageEvent.thinking_delta` | thinking 片段 |
| `message.tool_call_start` | `{ sessionId, toolCallId, toolName, input }` | `tool_execution_start` | 工具调用开始 |
| `message.tool_call_end` | `{ sessionId, toolCallId, output }` | `tool_execution_end` | 工具调用结束 |
| `message.complete` | `{ sessionId, stopReason, usage }` | `turn_end` | 消息生成完毕 |
| `message.error` | `{ sessionId, error }` | pi SDK exception | 生成出错 |
| `config.providers` | `{ providers: ProviderInfo[] }` | — | Provider 列表 |
| `config.providerUpdated` | `{ providerId }` | — | Provider 已更新 |
| `model.list` | `{ models: ModelInfo[] }` | `modelRegistry.getAvailable()` | 模型列表 |
| `model.switched` | `{ sessionId, modelId }` | — | 模型已切换 |
| `pong` | `{}` | — | 心跳响应 |
| `error` | `{ message, code? }` | — | 通用错误 |

**事件适配说明**：
1. pi SDK 的核心事件通过 `session.subscribe()` 获取 `AgentSessionEvent`
2. `AgentSessionEvent` 类型包括：`turn_start` / `turn_end` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `compaction_start` / `compaction_end` / `session_info_changed`
3. 文本/thinking 增量数据通过 `message_update` 事件的 `assistantMessageEvent` 字段获取，该字段为 `AssistantMessageEvent` 联合类型
4. P1 仅处理核心事件（`message_update` / `tool_execution_*` / `turn_end`），其余事件忽略但预留扩展接口

**StopReason 映射**：
| pi SDK `done.reason` | WS 协议 `stopReason` |
|----------------------|---------------------|
| `"stop"` | `"end_turn"` |
| `"length"` | `"max_tokens"` |
| `"toolUse"` | `"tool_use"` |
| `"error"` | `"error"` |
| `"aborted"` | `"aborted"` |
```

**Reason**: pi SDK 使用驼峰式事件名和不同的 StopReason 枚举值，Spec 必须明确映射关系，否则 event-adapter 实现将不正确。

**Priority**: P0

---

### 1b. Section 六 (Sidecar Architecture) — pi SDK 初始化依赖

**Section**: 六.1 模块职责 + 六.2 pi 兼容性策略

**问题**: Spec 说 sidecar 的 `pi-bridge.ts` 封装 pi SDK，但完全没有描述 `createAgentSession` 所需的三个依赖的初始化：`AuthStorage`、`ModelRegistry`、`SessionManager`。这是创建任何 Session 的前置条件。

**Current text** (六.1):

```markdown
| `pi-bridge.ts` | pi SDK 封装：`createSession()`、`sendMessage()`、`abort()`、`switchModel()` |
```

**Current text** (六.2):

```markdown
配置读取优先级：
1. ~/.xyz-agent/config.toml      ← xyz-agent 自己的配置
2. ~/.pi/config.toml             ← pi 已有配置（复用，不覆盖）
3. 环境变量                       ← ANTHROPIC_API_KEY 等
```

**Corrected text** — 替换六.1中 pi-bridge 行 + 替换六.2整个子节：

```markdown
（六.1 中 pi-bridge 行替换为：）
| `pi-bridge.ts` | pi SDK 封装：初始化 AuthStorage/ModelRegistry/SessionManager，暴露 `createSession()`、`sendMessage()`、`abort()`、`switchModel()`、`disposeSession()` |
```

```markdown
### 6.2 pi SDK 初始化与兼容性策略

**初始化链**（Sidecar 启动时在 `pi-bridge.ts` 中完成）：

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

// 1. 认证存储 — 读取/写入 API Key
const authStorage = AuthStorage.create();  // 默认 ~/.pi/agent/auth.json

// 2. 模型注册表 — 获取可用模型列表
const modelRegistry = ModelRegistry.create(authStorage);  // 默认 ~/.pi/agent/models.json

// 3. 会话管理器 — 管理 Session 持久化
const sessionManager = SessionManager.create(cwd);  // 默认 ~/.pi/agent/sessions/
// 或使用内存模式（不持久化）：
// const sessionManager = SessionManager.inMemory();
```

**Session 创建**：

```typescript
const { session } = await createAgentSession({
  sessionManager,
  authStorage,
  modelRegistry,
});
```

**配置策略**：
- API Key：使用 pi SDK 的 `AuthStorage`（存储在 `~/.pi/agent/auth.json`），不自建配置管理
- 模型列表：使用 pi SDK 的 `ModelRegistry`（`modelRegistry.getAvailable()`），不自建模型列表
- 模型切换：需要先通过 `ModelRegistry` 查找 `Model` 对象，再调用 `session.setModel(model)`，不能直接传 string modelId
- Session 存储：使用 pi SDK 的 `SessionManager`，Session 文件存放在 pi 默认位置
- xyz-agent 自己的设置（语言、主题、默认模型）：使用 JSON 存储在 `~/.xyz-agent/settings.json`

**注意**：
- pi 没有 `~/.pi/config.toml`，设置存储在 `~/.pi/agent/auth.json` 和 `~/.pi/agent/models.json`
- 不要自建 TOML 解析器，使用 pi SDK 提供的配置管理能力
```

**Reason**: `createAgentSession` 需要 `AuthStorage`、`ModelRegistry`、`SessionManager` 三个依赖，当前 Spec 完全没有描述初始化过程，且引用了不存在的 `~/.pi/config.toml`。

**Priority**: P0

---

### 1c. Section 六 (Sidecar Architecture) — Sidecar 通信方式

**Section**: 六.3 Sidecar 生命周期

**问题**: Spec 没有明确说明 sidecar 是 import pi SDK 作为库，还是 spawn pi 作为子进程。这两种方式的差异很大，影响架构决策。

**Current text** (六.3):

```markdown
1. Tauri 启动时 `sidecar.rs` spawn Node.js 进程，通过 CLI 参数传递 WS 端口
```

**Corrected text** — 在六.3之前插入新的六.2.5子节，并在六.3中补充说明：

```markdown
### 6.2.5 Sidecar 集成方式

**P1 方案：Sidecar import pi SDK 作为库**

Sidecar 是一个独立的 Node.js 进程，通过 `import { ... } from "@mariozechner/pi-coding-agent"` 直接使用 pi SDK。

优点：
- 实现简单，直接调用 SDK API
- 共享进程内存，事件订阅无序列化开销
- 可以深度访问 SDK 内部类型

缺点：
- Sidecar 和 pi SDK 版本强耦合
- 需要用户安装 Node.js（开发模式）或打包为单二进制（生产模式）
- 后续 Phase 切换到 RPC 模式需要重构

**后续 Phase（P6+）：RPC 模式**

Spawn `pi --mode rpc` 作为子进程，通过 stdin/stdout JSONL 通信。

优点：
- 与 pi 版本解耦，只需兼容 RPC 协议
- 进程隔离，崩溃不影响主进程
- 无需 Node.js 运行时

缺点：
- 需要维护 RPC 协议适配层
- 所有数据需要序列化/反序列化

**设计原则**：
- `pi-bridge.ts` 作为抽象层，所有 pi SDK 调用都通过 `PiBridge` 接口
- 后续切换到 RPC 模式只需替换 `PiBridge` 实现，上层代码不变
- 不要在 pi-bridge 之外直接 import pi SDK
```

**六.3 补充说明**（在现有第1步后添加）：

```markdown
5. Sidecar 以 `node sidecar/dist/index.js --port <port>` 方式启动（开发模式）
6. 生产模式使用 pkg 编译为单二进制，通过 Tauri sidecar API 管理
```

**Reason**: 明确集成方式是架构设计的基础决策，影响所有后续实现。

**Priority**: P1

---

### 1d. Missing — Tauri Sidecar 配置

**Section**: 新增六.5（在六.4之后）

**问题**: Spec 没有描述 Tauri 如何声明、启动和监控 sidecar 进程。`tauri.conf.json` 的 sidecar 配置、端口传递机制、健康检查、崩溃重启都需要文档化。

**Corrected text** — 新增六.5子节：

```markdown
### 6.5 Tauri Sidecar 配置

**tauri.conf.json 配置**：

```json
{
  "bundle": {
    "externalBin": ["binaries/sidecar"]
  },
  "plugins": {
    "shell": {
      "sidecar": true,
      "scope": [{ "name": "binaries/sidecar", "sidecar": true }]
    }
  }
}
```

**Cargo.toml 依赖**：

```toml
[dependencies]
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
```

**Sidecar 启动流程**（`sidecar.rs`）：

1. 分配可用端口（从 `DEFAULT_PORT = 3210` 开始尝试）
2. 将端口号作为 CLI 参数传给 sidecar：`--port 3210`
3. 使用 Tauri sidecar API（`Shell::sidecar()`）启动进程
4. 通过 HTTP health check（`GET /health`）确认 sidecar 就绪
5. 通过 Tauri event 将端口号通知前端：`app.emit("sidecar-port", port)`
6. 前端监听 `sidecar-port` 事件，使用收到的端口创建 WS 连接

**端口发现机制**：

- Rust sidecar 启动时动态选择可用端口
- 如果默认端口 `3210` 被占用，递增尝试 `3211`、`3212` …（最多尝试 10 个）
- 选定端口后通过 Tauri event 传递给前端
- 不使用固定端口文件

**健康检查**：

- 使用 HTTP `GET /health` 而非 TCP connect（WS 服务器可能已绑定但未 ready）
- Sidecar `index.ts` 注册 Express/Fastify HTTP health endpoint
- Rust 侧每 200ms 重试，最多等待 10 秒

**崩溃重启**：

- Rust 侧监听 sidecar child process 的 exit 事件
- 非正常退出（code != 0）时自动重启，最多重试 3 次
- 重启时重新分配端口并通知前端
- 前端收到新端口后自动重连
```

**Reason**: Sidecar 的生命周期管理是 P1 的核心基础设施，没有明确配置会导致实现混乱。端口不一致是 review 发现的 P0 问题。

**Priority**: P0

---

### 1e. Missing — View Switching Mechanism

**Section**: 新增四.1.5子节（在四.1 App Shell 布局中视图模式表格之后）

**问题**: Spec 说 Chat 和 Settings 是同级全屏视图，但没有 vue-router，也没有描述切换机制。Cmd+1/3 快捷键也没有注册方式。

**Corrected text** — 新增四.1.5子节：

```markdown
#### 视图切换机制

**无 vue-router**：项目不使用 vue-router，通过响应式状态驱动视图切换。

**状态定义**（在 `App.vue` 中）：

```typescript
type AppView = 'chat' | 'settings'
const currentView = ref<AppView>('chat')
const focusMode = ref(false)
```

**切换规则**：

| 触发 | 效果 |
|------|------|
| 点击 Header 齿轮按钮 | `currentView = 'settings'` |
| Settings 内点击关闭/返回 | `currentView = 'chat'` |
| `Cmd+,` | `currentView = 'settings'` |
| `Esc`（在 Settings 中） | `currentView = 'chat'` |
| `Cmd+1` | `focusMode = false`（标准模式） |
| `Cmd+3` | `focusMode = true`（专注模式） |

**渲染逻辑**（`App.vue` template）：

```vue
<template>
  <div class="h-screen flex flex-col" :class="{ 'focus-mode': focusMode }">
    <AppHeader v-if="!focusMode" @open-settings="currentView = 'settings'" />
    <div class="flex-1 flex overflow-hidden">
      <AppSidebar v-if="currentView === 'chat' && !focusMode" />
      <ChatView v-if="currentView === 'chat'" />
      <SettingsView v-if="currentView === 'settings'" @close="currentView = 'chat'" />
    </div>
    <AppStatusbar v-if="!focusMode" />
  </div>
</template>
```

**快捷键注册（P1）**：
- P1 使用前端 `document.addEventListener('keydown')` 监听
- 不使用 Tauri `tauri-plugin-global-shortcut`（后续 Phase 再迁移）
- 注意：`Cmd+,` 是浏览器/系统保留快捷键，P1 改用 `Cmd+Shift+,` 或 Header 按钮触发
```

**Reason**: 没有路由库的情况下，状态驱动的视图切换需要明确文档化，否则实现者不知道如何组织 App.vue。

**Priority**: P1

---

### 1f. Missing — Tailwind v4 Configuration

**Section**: 新增三.1.5子节（在三.1 Design System 的 token 列表之后）

**问题**: Spec 说使用 Tailwind v4 但没有描述 CSS-first 配置方式。Tailwind v4 不使用 `tailwind.config.ts`，而是通过 `@theme` 指令在 CSS 中定义。Spec 的项目结构中列了 `tailwind.config.ts`，这在 Tailwind v4 中不需要。

**Corrected text** — 新增三.1.5子节：

```markdown
#### Tailwind v4 CSS-first 配置

**Tailwind v4 不使用 `tailwind.config.ts`**。删除项目结构中的该文件。

配置通过 `src/assets/main.css` 的 `@theme` 指令完成：

```css
@import "tailwindcss";

@theme {
  /* Design token 颜色 — 使 bg-*/text-*-*/ 等 utility class 可用 */
  --color-bg-base: oklch(97% 0.018 70);
  --color-surface: oklch(99% 0.008 70);
  --color-text-primary: oklch(22% 0.02 50);
  --color-text-muted: oklch(50% 0.018 50);
  --color-border: oklch(90% 0.014 70);
  --color-accent: oklch(64% 0.13 28);
  --color-accent-light: oklch(92% 0.04 28);
  --color-success: oklch(70% 0.18 145);
  --color-warning: oklch(78% 0.15 85);
  --color-danger: oklch(62% 0.2 25);

  /* shadcn-vue 别名 — 组件库期望的标准色名 */
  --color-primary: oklch(64% 0.13 28);
  --color-primary-foreground: oklch(98% 0.005 70);
  --color-destructive: oklch(62% 0.2 25);
  --color-destructive-foreground: oklch(98% 0.005 70);
  --color-muted: oklch(96% 0.01 70);
  --color-muted-foreground: oklch(50% 0.018 50);
  --color-background: oklch(99% 0.008 70);
  --color-foreground: oklch(22% 0.02 50);
  --color-ring: oklch(64% 0.13 28);
  --color-input: oklch(90% 0.014 70);
  --color-border: oklch(90% 0.014 70);
  --color-accent: oklch(92% 0.04 28);
  --color-accent-foreground: oklch(22% 0.02 50);

  /* 字体 */
  --font-display: 'Tiempos Headline', 'Newsreader', Georgia, serif;
  --font-body: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace;

  /* 圆角 */
  --radius-lg: 12px;
  --radius-md: 8px;
  --radius-sm: 4px;
}

/* 暗色主题覆盖 */
@media (prefers-color-scheme: dark) {
  :root[data-theme="dark"] {
    --color-bg-base: oklch(20% 0.015 50);
    --color-surface: oklch(25% 0.015 50);
    /* ... 其余暗色 token ... */
  }
}
```

**关键点**：
1. `@theme` 中的 `--color-*` 变量自动生成 `bg-*`、`text-*`、`border-*` 等 utility class
2. shadcn-vue 组件期望 `--color-primary`、`--color-destructive`、`--color-background` 等标准色名，必须定义
3. 不需要 `tailwind.config.ts`，不使用 `tokens/colors.ts` 中的 JS 注入方式
4. 暗色主题通过 `[data-theme="dark"]` 选择器覆盖变量值

**项目结构修正**：
- 删除 `tailwind.config.ts`
- `design-system/tokens/` 目录可以保留作为 token 值的 single source of truth（TypeScript 对象），但最终必须同步到 `@theme` 块
```

**Reason**: Tailwind v4 的配置方式与 v3 完全不同。Spec 项目结构中的 `tailwind.config.ts` 会导致实现者走错方向。shadcn-vue 组件需要的颜色别名必须明确。

**Priority**: P0

---

### 1g. Missing — Keyboard Shortcuts

**Section**: 新增四.8子节

**问题**: Spec 多处提到快捷键（Cmd+1/3 切换视图、Cmd+, 打开设置、Cmd+J 总览），但没有描述注册机制。

**Corrected text** — 新增四.8子节：

```markdown
### 4.8 快捷键

| 快捷键 | 功能 | P1 实现 |
|--------|------|---------|
| `Cmd+1` | 标准模式 | ✅ 前端 keydown 监听 |
| `Cmd+3` | 专注模式 | ✅ 前端 keydown 监听 |
| `Cmd+,` | 打开设置 | ⚠️ 系统保留，改用 `Cmd+Shift+,` 或仅按钮触发 |
| `Cmd+J` | 总览模式 | ❌ P4 实现 |
| `Cmd+2` | 分屏模式 | ❌ P4 实现 |
| `Cmd+4` | 任务树模式 | ❌ P4 实现 |
| `Esc` | 退出设置/取消生成 | ✅ 前端 keydown 监听 |
| `Enter` | 发送消息 | ✅ ChatInput 内部处理 |
| `Shift+Enter` | 换行 | ✅ ChatInput 内部处理 |

**P1 注册方式**：在 `App.vue` 的 `onMounted` 中注册 `document.addEventListener('keydown')`，`onUnmounted` 中移除。不使用 Tauri global shortcut plugin（后续 Phase 按需迁移）。
```

**Reason**: 快捷键分散在多个 section 提及但没有统一说明，且 Cmd+, 的系统冲突需要提前发现。

**Priority**: P1

---

## 2. Plan Task Changes

### Plan-01 (Scaffold)

| # | Step | Change | Priority |
|---|------|--------|----------|
| 1 | Step 1 (sidecar/src/index.ts) | 默认端口从 `9250` 改为 `3210` | P0 |
| 2 | Step 3 (npm install) | 添加 `@tailwindcss/typography`（Plan-07 的 prose class 需要） | P2 |
| 3 | Step 5 (src/App.vue) | 初始版本直接使用 `var(--color-*)` CSS 变量，不依赖尚未创建的 token 系统 | P2 |
| 4 | Step 5 (src/App.vue) | 添加 `<Toaster /> from 'vue-sonner'` 组件 | P2 |
| 5 | 项目结构 | 删除 `tailwind.config.ts`，Tailwind v4 不需要 | P0 |
| 6 | 新增 Step | sidecar/src/index.ts 中添加 HTTP `/health` endpoint | P0 |

### Plan-02 (Foundation)

| # | Step | Change | Priority |
|---|------|--------|----------|
| 1 | Step 2D (CSS tokens) | 不要用 JS `injectTokens()` 注入 CSS 变量。改为在 `main.css` 的 `@theme` 块中定义所有颜色变量（含 shadcn 别名） | P0 |
| 2 | useTheme.ts | 统一主题类型为 `'light' \| 'dark' \| 'system'`，与 Plan-05 settings store 保持一致。ThemeProvider 读取 store 值而非自管理 | P1 |
| 3 | Step 2D-7 (eslint.config.mjs) | 验证 taste-lint 规则能否独立运行（不依赖未安装的 ESLint plugins）。如果不行，先降级为 warn | P1 |
| 4 | main.ts | 与 Plan-05 的 main.ts 合并：同时注册 i18n、pinia（含 persist 插件）、injectTokens（如果保留 JS 方式） | P2 |

### Plan-03 (Design System)

| # | Step | Change | Priority |
|---|------|--------|----------|
| 1 | 所有组件 | 确保 `bg-primary`、`text-primary-foreground` 等 class 在 `@theme` 中有对应变量定义（见 1f 修正） | P0 |
| 2 | Badge.vue | 将 `bg-emerald-500/15 text-emerald-700` 替换为 `bg-success/15 text-success`（design token） | P1 |
| 3 | Textarea.vue | 添加 `import { ref, onMounted } from 'vue'` | P1 |
| 4 | Input.vue | 确认 `t('common.inputError')` 的 i18n key 已在 schema 中定义，否则改用已有 key | P2 |
| 5 | Select.vue | 添加 `options` 简化 prop（除 `groups` 外），兼容 Plan-09 ProviderForm 的使用方式 | P1 |

### Plan-04 (Communication)

| # | Step | Change | Priority |
|---|------|--------|----------|
| 1 | ws-client.ts | 添加 `onOpen()`、`onClose()`、`onError()` 回调方法，或改为统一的 `onStateChange(callback: (state) => void)` 方法 | P0 |
| 2 | eventBus handler 签名 | 统一为 `(message: ServerMessage) => void`，所有 composable handler 内部解析 `msg.payload` | P0 |
| 3 | sidecar/src/index.ts | 默认端口从 `17777` 改为 `3210` | P0 |
| 4 | config-store.ts | 统一使用 JSON 格式而非 TOML，或直接使用 pi SDK 的 AuthStorage/ModelRegistry | P1 |
| 5 | SessionListPayload | 统一为 `{ groups: Array<{ cwd, sessions }> }` 分组格式，所有使用处对齐 | P1 |

### Plan-05 (State Layer + Shell)

| # | Step | Change | Priority |
|---|------|--------|----------|
| 1 | useConnection.ts | 改用 `wsClient.onStateChange()` 而非调用不存在的 `wsClient.onOpen/onClose/onError` | P0 |
| 2 | useChat.ts handlers | 所有 handler 改为接收 `(msg: ServerMessage)`，内部 `const data = msg.payload as X` | P0 |
| 3 | useSession.ts | `handleSessionList` 处理 grouped 格式 `{ groups: [...] }` 而非 flat `{ sessions: [...] }` | P1 |
| 4 | settings.ts store | Theme 类型改为 `'light' \| 'dark' \| 'system'`，与 useTheme 对齐 | P1 |
| 5 | chat.ts store | `ToolCall.status` 从 `'done'` 改为 `'completed'`，与 protocol.ts 和 ToolCallCard 对齐 | P1 |
| 6 | App.vue | 添加 `<Toaster />` 组件 | P2 |
| 7 | App.vue Settings 关闭按钮 | 改用 design-system Button 组件 | P2 |
| 8 | i18n keys | 确保 MessageSchema 接口包含 Plan-05/08/09 所有引用的 key（header/sidebar/chat/statusbar） | P1 |

### Plan-07 (Chat) — 需要重写

| # | Step | Change | Priority |
|---|------|--------|----------|
| 1 | **MessageBubble.vue** | 删除对 `ChatMessage`、`AssistantSegment`、`TaskNode` 的引用。改用 Plan-04 定义的 `Message` 类型（`content` + `toolCalls` + `thinking` 字段）。整体基于扁平消息模型重写 | P0 |
| 2 | **ChatInput.vue** | `import Button from '@/components/ui/button'` 改为 `import { Button } from '@/design-system'` | P0 |
| 3 | **ModelPicker.vue** | `import useModelManager` 改为 `import { useModel } from '@/composables/useModel'` | P0 |
| 4 | ModelPicker.vue | 删除对 `ModelTier` 类型的引用，或在 `types/provider.ts` 中定义 | P1 |
| 5 | ToolCallCard.vue | `import getToolDangerLevel from '@/types'` 不存在。要么定义该 helper，要么内联判断逻辑 | P1 |
| 6 | SlashMenu.vue | 删除重复的 `defineProps` 调用 | P1 |
| 7 | MessageList.vue | 虚拟滚动添加 `measureElement` 动态高度测量 | P2 |

### Plan-08-09-10 (Session + Settings + Integration)

| # | Step | Change | Priority |
|---|------|--------|----------|
| 1 | AppSidebar.vue (08) | Dialog 的 `@close` 改为 `@update:open`（匹配 Dialog 组件 API） | P0 |
| 2 | ProviderList.vue (09) | `provider.connected: boolean` 改为 `provider.status === 'connected'`（匹配 ProviderInfo 类型） | P0 |
| 3 | ProviderForm.vue (09) | Select 组件的 `options` prop 改为 `groups`（匹配 Plan-03 Select API），或为 Select 添加 `options` 简化 prop | P0 |
| 4 | Cargo.toml (10) | 添加 `tauri-plugin-shell` 和 `tauri-plugin-dialog` 到 dependencies | P0 |
| 5 | **pi-bridge.ts (10)** | 根据 1b 修正重写：初始化 AuthStorage/ModelRegistry/SessionManager，使用正确的 SDK API | P0 |
| 6 | event-adapter.ts (10) | 根据 1a 修正重写：实现 `session.subscribe()` 事件监听，正确映射 AgentSessionEvent | P0 |
| 7 | config-store.ts (10) | 删除自建 TOML 解析器，使用 pi SDK 的 AuthStorage/ModelRegistry | P1 |
| 8 | sidecar.rs (10) | 使用 HTTP health check 替代 TCP connect；添加 sidecar 崩溃重启逻辑 | P1 |
| 9 | main.rs (10) | 使用 `Shell::sidecar()` API 而非 `Command::new("node")`；动态分配端口并通过 Tauri event 通知前端 | P1 |
| 10 | server.ts (10) | 明确标注为"替换 Plan-04 的 server.ts"而非增量更新 | P1 |
| 11 | SessionItem.vue (08) | 右键菜单改用 design-system Dropdown 组件 | P2 |

---

## 3. New Tasks Needed

### 3.1 pi SDK 初始化验证任务

**建议位置**: 在 Task 4 (Communication) 之前或内部增加一个验证步骤

**原因**: pi SDK 的 `createAgentSession` 依赖链（AuthStorage → ModelRegistry → SessionManager → Session）需要先验证能否正常工作，否则 Task 10 集成时会发现整条链路不通。

**验证内容**:
```typescript
// 在 sidecar 中创建一个最小验证脚本
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// 验证事件订阅
session.subscribe((event) => {
  console.log("Event:", event);
});

// 验证发送消息
await session.prompt("Hello, what tools do you have?");
```

**Priority**: P1 — 应在 Task 4 或 Task 10 开始前完成验证。

### 3.2 Tailwind v4 + shadcn-vue 色彩集成任务

**建议位置**: Task 2 (Foundation) 内部

**原因**: Tailwind v4 的 CSS-first 配置方式与 v3 的 JS config 完全不同，需要专门验证 `@theme` 块是否能正确生成 shadcn-vue 组件需要的 utility class（`bg-primary`、`text-muted-foreground` 等）。

**验证内容**:
1. 创建 `main.css` 的 `@theme` 块，包含所有 shadcn 别名色
2. 在一个测试组件中使用 `bg-primary text-primary-foreground` 等 class
3. 确认浏览器中渲染结果正确
4. 确认暗色主题切换时颜色跟随变化

**Priority**: P0 — 必须在 Task 3 (Design System) 之前验证。

### 3.3 协议类型共享方案

**建议位置**: Task 4 (Communication) 内部

**原因**: `src/types/protocol.ts` 和 `sidecar/src/protocol.ts` 包含相同类型定义，需要手工保持同步。应该建立一个共享机制。

**建议方案**（按推荐度排序）：
1. **方案 A**: 创建 `packages/protocol/` 共享包，前后端都引用它
2. **方案 B**: 在 sidecar 中通过 tsconfig paths 引用前端的 `src/types/`
3. **方案 C**（最低要求）: 在 CI 中添加 `diff src/types/protocol.ts sidecar/src/protocol.ts` 一致性检查

**Priority**: P2 — 可以先用方案 C 起步，后续重构。

### 3.4 Sidecar 生产模式打包研究

**建议位置**: P1 后期或 P2

**原因**: 开发模式用 `node sidecar/dist/index.js` 可以工作，但生产环境用户不一定有 Node.js。需要研究 pkg/nexe/sea 等方案将 sidecar 编译为单二进制。

**Priority**: P2 — 不阻塞 P1 开发，但需要在 P1 交付前解决。

---

## 4. Priority Classification

### P0 — Must fix before implementation starts (blocks work)

| # | Correction | Section | Impact |
|---|-----------|---------|--------|
| 1 | pi SDK API 调用名全部错误 → 根据 1b 修正重写 pi-bridge.ts | 1b, Plan-10 | 所有 sidecar 代码 |
| 2 | 事件类型映射不正确 → 根据 1a 修正 | 1a, Plan-04/10 | event-adapter, ws-client |
| 3 | WS 默认端口不一致 (9250/17777/3210) → 统一为 3210 | 1d, Plan-01/04/05/10 | 所有 sidecar + 前端连接代码 |
| 4 | Tailwind v4 @theme 配置缺失 → 添加 shadcn 别名色 | 1f, Plan-02/03 | 所有 UI 组件 |
| 5 | Tauri sidecar 配置缺失 → 新增六.5 节 | 1d | sidecar.rs, Cargo.toml |
| 6 | Plan-07 消息模型与 Plan-04/05 不兼容 → 重写 Plan-07 | Plan-07 | 所有 chat 组件 |
| 7 | ws-client 缺少 onOpen/onClose/onError → 补充 API | Plan-04/05 | useConnection |
| 8 | eventBus handler 签名不匹配 → 统一为 ServerMessage | Plan-04/05 | 所有 composable |
| 9 | Cargo.toml 缺少 plugin 依赖 | Plan-10 | Rust 编译 |
| 10 | ProviderInfo 字段不一致 → 统一为 status: ProviderStatus | Plan-04/09 | ProviderList, types |

### P1 — Should fix before the relevant task starts

| # | Correction | Section | Impact |
|---|-----------|---------|--------|
| 1 | pi SDK 初始化依赖链缺失 → 补充六.2 | 1b | pi-bridge.ts |
| 2 | 视图切换机制缺失 → 新增四.1.5 | 1e | App.vue |
| 3 | 快捷键注册缺失 → 新增四.8 | 1g | App.vue |
| 4 | Sidecar 集成方式文档化 → 新增六.2.5 | 1c | 架构决策 |
| 5 | 主题管理冲突 → 统一由 settings store 管理 | Plan-02/05 | useTheme, settings.ts |
| 6 | ToolCall.status 枚举 → `'done'` 改 `'completed'` | Plan-04/05 | types/message.ts |
| 7 | lastActiveAt 类型 → `string` 改 `number` | Plan-04/05 | types/session.ts |
| 8 | Toast 系统未集成 → 添加 Toaster | Plan-05 | App.vue |
| 9 | Textarea.vue 缺少 import | Plan-03 | Textarea.vue |
| 10 | config-store 应使用 pi SDK | Plan-10 | config-store.ts |
| 11 | i18n schema 结构不匹配 | Plan-02/05/08/09 | i18n/types.ts |
| 12 | Dialog 事件名 @close → @update:open | Plan-08 | AppSidebar.vue |
| 13 | Select prop options → groups | Plan-03/09 | ProviderForm.vue |
| 14 | Session list payload grouped vs flat | Plan-04/05/10 | protocol.ts, useSession |
| 15 | 错误处理策略缺失 | 全局 | ws-client, pi-bridge, composables |

### P2 — Can fix during implementation

| # | Correction | Section | Impact |
|---|-----------|---------|--------|
| 1 | 虚拟滚动 height 测量优化 | Plan-07 | MessageList.vue |
| 2 | Markdown prose 样式 | Plan-02/07 | main.css |
| 3 | Badge 硬编码 emerald 颜色 | Plan-03 | Badge.vue |
| 4 | SlashMenu 重复 defineProps | Plan-07 | SlashMenu.vue |
| 5 | SessionItem 右键菜单改用 Dropdown | Plan-08 | SessionItem.vue |
| 6 | 全局快捷键（Cmd+1/3）| 1g | App.vue |
| 7 | StopReason 枚举映射 | 1a | event-adapter.ts |
| 8 | 协议类型共享方案 | 3.3 | protocol.ts |
| 9 | Sidecar 生产模式打包 | 3.4 | build pipeline |
| 10 | Pinia persist 配置合并 | Plan-02/05 | main.ts |
| 11 | Input.vue i18n key | Plan-03 | Input.vue |
| 12 | SessionItem 原生 div 右键菜单 | Plan-08 | SessionItem.vue |
