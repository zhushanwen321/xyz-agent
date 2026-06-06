# xyz-agent 编码规范与架构标准

> 本文档是项目开发的权威规范参考。CLAUDE.md 中包含核心规则的摘要。

---

## 1. 外部系统对接规范

### 1.1 对接前先写验证脚本

在写任何业务代码之前，先用独立 Node 脚本验证外部系统的接口行为：

- 输入参数的精确字段名和格式
- 输出响应的结构（哪个字段在哪个层级）
- 事件流的时序和嵌套结构
- 错误时的响应格式（`success: false` 还是 throw）

**脚本存放位置**: `tools/verify-<system>.cjs`（如 `tools/verify-pi-rpc.cjs`）

**示例**：验证 pi RPC 的 prompt 和事件流

```js
// tools/verify-pi-rpc.cjs
// 用法: node tools/verify-pi-rpc.cjs
// 验证: prompt 命令格式、事件嵌套结构、tool_execution 字段名
```

### 1.2 为外部协议建类型定义文件

外部系统的消息类型必须集中定义在一个文件中，不要散落在各处用 `as any` 或内联类型。

**文件位置**: `sidecar/src/<system>-types.ts`

类型定义必须和验证脚本的输出保持同步。升级外部系统版本时，先跑验证脚本，再更新类型。

### 1.3 适配层隔离

与外部系统的所有通信必须通过适配层，业务代码不直接处理外部格式：

```
外部系统 → 适配层（翻译）→ 内部协议 → 业务代码
```

适配层职责：
- 字段名映射（外部字段名 → 内部字段名）
- 格式转换（外部数据结构 → 内部数据结构）
- 错误检查（检查 `success` 字段，reject 而非静默 resolve）

---

## 2. Vue 事件与组件规范

### 2.1 emit 只传单个 payload 对象

**禁止**：`emit('confirm-rename', sessionId, newName)` — 多参数在 handler 中极易混淆顺序。

**必须**：`emit('confirm-rename', { sessionId, newName })`

```vue
<!-- 禁止 -->
<EmittingComponent @confirm-rename="(id, name) => handler(id, name)" />

<!-- 必须 -->
<EmittingComponent @confirm-rename="(payload) => handler(payload.sessionId, payload.newName)" />
```

### 2.2 Event Bus listener 必须防重复注册

当组件可能被多次挂载（split mode、keep-alive）时，listener 必须用模块级引用计数保护：

```ts
let listenerRefCount = 0

onMounted(() => {
  if (listenerRefCount === 0) {
    for (const [evt, handler] of Object.entries(eventMap)) {
      on(evt, handler)
    }
  }
  listenerRefCount++
})

onUnmounted(() => {
  listenerRefCount--
  if (listenerRefCount === 0) {
    for (const [evt, handler] of Object.entries(eventMap)) {
      off(evt, handler)
    }
  }
})
```

### 2.3 错误必须重置生成状态

任何错误处理路径都必须重置 `isGenerating` 和 `streamingMessage`，否则 UI 会卡在 "思考中"：

```ts
// 错误处理的标准模式
function onError(msg: ServerMessage) {
  store.setGenerating(false)
  store.setStreaming(null)
  // 将错误作为 assistant 消息插入聊天流，不要用顶部 banner
  store.addMessage({ role: 'assistant', content: `**Error:** ${errMsg}`, status: 'error', ... })
}
```

---

## 3. 聊天 UI 布局范式

### 3.1 消息列表用 flex column + overflow

```css
.chat-msgs {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
```

**禁止**在消息列表内使用 `position: absolute`——这会导致新消息出现在视口顶部而非底部。

### 3.2 自动滚动

消息列表必须监听消息变化并自动滚动到底部：

```ts
watch(
  () => [messages.length, streamingMessage?.content],
  () => nextTick(() => {
    const el = chatMsgsRef.value
    if (el) el.scrollTop = el.scrollHeight
  }),
)
```

### 3.3 Streaming message 生命周期

pi 的一次 agent 调用会产生多个 message（thinking 段、tool call 段、文字回复段）。每个 `message_start` 应完成前一个 streaming message，开始新的：

```
message_start → 完成 current streaming → 创建新 streaming
text_delta × N → appendToStreaming
tool_execution_start → addToolCall to streaming
tool_execution_end → updateToolCall in streaming
message_start → 完成 current streaming → 创建新 streaming
text_delta × N → appendToStreaming
agent_end → 最终 completeStreaming
```

---

## 4. Session 管理规范

### 4.1 活跃 vs 非活跃 session

- **活跃 session**: 有运行中的 pi 进程，可实时通信（prompt, get_messages）
- **非活跃 session**: 只有 `.jsonl` 文件，需要从文件解析历史，需要 restore 后才能发送消息

**所有 session 操作都必须处理两种状态**：先检查是否活跃，不活跃时走文件路径。

### 4.2 Session 文件格式

xyz-agent 的 session 文件存储在 `~/.xyz-agent/sessions/`（通过 pi 的 `--session-dir` 参数隔离）。

文件格式（`.jsonl`）：
```
{type: "session", id: "...", cwd: "...", timestamp: "..."}
{type: "model_change", ...}
{type: "message", message: {role: "user", content: [{type: "text", text: "..."}]}}
{type: "message", message: {role: "assistant", content: [{type: "thinking", ...}, {type: "toolCall", ...}]}}
{type: "message", message: {role: "toolResult", toolCallId: "...", content: [{type: "text", text: "..."}]}}
{type: "session_info", name: "用户自定义名称"}
```

**扁平文件结构**，不按 cwd 子目录组织。

### 4.3 消息格式转换

pi 的消息 content 是数组，xyz-agent 的 Message.content 是字符串。转换规则：

| pi content part | xyz-agent 字段 |
|-----------------|---------------|
| `{type: "text", text: "..."}` | `content`（拼接为字符串） |
| `{type: "thinking", thinking: "..."}` | `thinking: [{content: "..."}]` |
| `{type: "toolCall", name, arguments}` | `toolCalls: [{toolName, input}]` |
| `role: "toolResult"` | 合并到前一条 assistant 消息的对应 `toolCall.output` |

---

## 5. 文件持久化与运行时状态同步

当系统同时存在**文件持久化**和**内存 Store** 时，两者必须保持同步。文件是 source of truth，内存是运行时缓存。

### 三条规则

**1. 启动时加载** — 初始化时从文件加载到 Pinia store
**2. 写后刷新** — 修改文件后立即更新 store 状态
**3. 防竞争** — 异步操作用队列串行化，避免并发写入丢失

---

## 6. Electron 架构约定

### 6.1 进程间通信

- 主进程管理 sidecar 生命周期和窗口
- Preload 暴露 `window.electronAPI` 给渲染进程
- 渲染进程通过 WebSocket 与 sidecar 通信（不走 IPC）
- 禁止渲染进程直接使用 `ipcRenderer`

### 6.2 目录结构

```
src-electron/
  main/           Electron 主进程
  preload/        Preload 脚本
  renderer/src/   Vue 前端（组件、composables、stores、lib）
  sidecar/src/    Node.js WebSocket 服务
  shared/src/     共享 TypeScript 类型
```

---

## 7. 样式规范

### 7.1 Border-radius 约束

**项目全局只允许 1px 和 2px 两种 border-radius 值。1px 是默认值，2px 仅用于特殊场景。**

| 场景 | 使用值 | Tailwind class |
|------|--------|----------------|
| 所有默认元素（气泡、卡片、按钮、面板、session、输入框等） | 1px | `rounded-sm` 或 `rounded-xs` |
| 特殊场景（需要更大圆角时） | 2px | `rounded-md` 或 `rounded-lg` |
| 圆形指示器、头像（不受限） | 50% | `rounded-full` |
| 无圆角（强制） | 0 | `rounded-none` |

**Tailwind 配置（tailwind.config.ts）：**
```ts
borderRadius: {
  DEFAULT: '1px',  // rounded
  sm: '1px',        // rounded-sm (默认)
  xs: '1px',        // rounded-xs (同 sm)
  md: '2px',        // rounded-md (特殊)
  lg: '2px',        // rounded-lg (特殊)
}
```

**CSS 变量（style.css）：**
```css
--radius: 1px;
--radius-sm: 1px;     /* 默认 */
--radius-xs: 1px;
--radius-lg: 2px;     /* 特殊 */
--radius-md: 2px;     /* 特殊 */
```

**设计意图：** 1px 的锐利几何风格是 xyz-agent 的视觉标识。接近零但不为零的圆角提供微小软化的同时保持整体锋利感。

### 7.2 Markdown 文本元素样式规范

**适用于 `.msg__body`（聊天消息体、v-html 渲染的 markdown 容器）。** 参照 `@tailwindcss/typography` 和 `ChatGPT-Next-Web` 的主流范式。完整调研：`docs/research/markdown-list-styling-research.md`。

#### 7.2.1 v-html 包装陷阱（必读）

`<MessageBubble>` 的 markdown 容器结构是：

```html
<div class="msg__body">
  <span v-html="renderedContent">   <!-- 多了一层 <span> -->
    <ul>...</ul>
  </span>
</div>
```

**因此 `.msg__body > ul` 不匹配**，必须用后代选择器 `.msg__body ul`。这是其他 Chat UI（lobe-chat、shadcn）也普遍存在的结构。

#### 7.2.2 列表样式范式

```css
/* 主流选择: outside + padding-left，不用 inside */
.msg__body ul, .msg__body ol {
  margin-top: 0;
  margin-bottom: 12px;
  padding-left: 1.5em;   /* 12px 聊天气泡下 = 18px，介于 GitHub (2em) 和 typography (1.625em) 之间 */
}
.msg__body ol { list-style-type: decimal; }  /* Tailwind preflight 重置了 list-style: none，需显式恢复 */
.msg__body ul { list-style-type: disc; }
.msg__body li { margin-top: 0.15em; margin-bottom: 0.15em; }
.msg__body li + li { margin-top: 0.25em; }
.msg__body li > p { margin-top: 0; margin-bottom: 0; }  /* 关键: li 内的 p (markdown-it 输出) 不撑开间距 */
.msg__body li ul, .msg__body li ol { margin-top: 0.25em; margin-bottom: 0.25em; }
```

#### 7.2.3 为什么不用 `list-style-position: inside`

| 模式 | 多行换行后表现 | 主流选择 |
|------|----------------|---------|
| `outside`（默认） | 换行后文字左对齐 li 容器边缘 | typography / NextChat / GitHub |
| `inside` | 换行后文字缩进到标记下方（看起来像两层缩进） | **仅** streamdown（Vercel 流式聊天） |

聊天场景消息宽度窄，文字经常换行，**必须用 `outside`**。仅流式渲染 + li 极短时可考虑 `inside`。

#### 7.2.4 调试陷阱

CSS 改了看不出效果时，按顺序检查：

1. **选择器对了吗？** `document.querySelectorAll('.msg__body > ul').length === 0` 说明 `>` 没匹配（v-html 包装陷阱）
2. **CSS 规则被覆盖？** 遍历 `document.styleSheets` 找所有匹配规则
3. **Vite HMR 重载了？** `style.css` 改了之后需要等 HMR 推送，computed style 才会更新
4. **DOM 实际值？** `getComputedStyle(el).listStylePosition` 看真实生效值（不是源码写的值）

#### 7.2.5 不要引入 @tailwindcss/typography

- 增加 ~20KB CSS 产出
- 带来大量不需要的样式（h1-h6、figure、video 等 chat 场景不需要）
- 与现有 CSS 变量主题系统冲突

聊天 markdown 样式**手写**优于引入 prose 类。

#### 7.2.6 [HISTORICAL] Skill 展开内容必须强制使用 dark Shiki 主题

**这条规则来自 2026-06 的视觉 bug：用户反馈 skill-header 展开时代码块"line 1 占了 2 行"。**

**根因**：

`MessageBubble.vue` 渲染 skill 展开内容时调 `renderFull(payload.content, theme, { codeTheme: theme })` —— `codeTheme` 直接用 app 主题。当 app 是 light 主题时，Shiki 用 `github-light` 主题（黑字白底）。

但 skill 内容**渲染到 `--user-bubble-bg`（深色）容器**里（`MessageBubble.vue:148`）：

```html
<div class="... leading-[1.6] text-xs text-fg ..." 
     style="background:var(--user-bubble-bg); border:1px solid var(--user-bubble-border); border-left:2px solid var(--accent);">
```

Shiki 给的 token 颜色 `#24292E`（黑）在 `--user-bubble-bg`（深色）背景上**几乎不可见**。

**视觉后果**：
- `---` 等带语义颜色的 token 仍然可见（`#005CC5` 蓝色对深色背景有对比度）
- 普通文本 token (`#24292E` 黑字) 不可见
- 眼睛只能看到 `---` 等有颜色的行，line 1 `---` 到下一个有颜色的行（line 4 `---`）之间"看起来空了两行" → 视觉上"line 1 占了 2 行"

**为什么"有时候 2 行有时候 1 行"**：
- **流式阶段**（`renderLightweight`）：markdown-it 默认无 Shiki 高亮 → 文字用 `.msg__body` 的 `text-fg` 变量（深色背景下浅色）→ 文字可见 → 视觉正常
- **完整阶段**（`renderFull`）：Shiki 用 light theme → 黑字 → 不可见 → 视觉异常

切流式↔完整渲染就切视觉。

**修复**：

`MessageBubble.vue:340` skill 渲染调用必须强制 dark codeTheme（与 444 行 user 消息判断的逻辑一致）：

```ts
// skill 容器背景始终是深色（--user-bubble-bg），不论 app 主题都用 dark Shiki 主题
const codeTheme: 'light' | 'dark' | undefined = 'dark'
skillRenderedContent.value = await renderFull(payload.content, theme, { codeTheme })
```

**不要把 codeTheme 改成跟随 app theme** —— skill 容器背景是硬编码的深色，主题不一致必然导致文字不可见。

**未来重构时验证**：如果 skill 容器背景支持跟随 app theme 切换，本规则需要相应调整（dark bg → dark theme, light bg → light theme）。

---

## 8. 自动化检查

### 8.1 现有检查工具

| 工具 | 覆盖范围 | 触发时机 |
|------|---------|---------|
| taste-lint (ESLint) | 原生 HTML / emoji / v-model / 硬编码颜色 / 魔数间距 / 静默 catch / allSettled | `npm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / emoji / v-model | pre-commit |
| pre-commit hook | ESLint + vue_rules_checker | git commit |

### 8.2 共享类型同步

`src-electron/shared/` 中的类型定义是前端与 sidecar 的唯一协议源。修改协议类型时：

1. 先更新 `shared/src/protocol.ts` 中的类型定义
2. 确认前端和 sidecar 的消费方都已适配
3. 运行 `npm -w @xyz-agent/frontend run typecheck` 和 `npm -w @xyz-agent/sidecar run typecheck` 验证
