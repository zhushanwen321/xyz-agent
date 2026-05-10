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

## 5. 文件持久化与运行时 Registry 同步

当系统同时存在**文件持久化**和**内存 Registry** 时，两者必须保持同步。文件是 source of truth，Registry 是运行时缓存。

### 三条规则

**1. 启动时加载** — 初始化时从文件加载到 Registry
**2. 写后刷新** — 修改文件后立即刷新 Registry
**3. 线程安全包装** — `Arc<StdRwLock<Registry>>`，锁内提前 clone

（详细参考见原文档）

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

## 7. 自动化检查

### 7.1 现有检查工具

| 工具 | 覆盖范围 | 触发时机 |
|------|---------|---------|
| taste-lint (ESLint) | 原生 HTML / emoji / v-model / 硬编码颜色 / 魔数间距 / 静默 catch / allSettled | `npm run lint` + pre-commit |
| vue_rules_checker.py | 行数上限 / CSS 选择器 / Tab 缩进 / 原生元素 / emoji / v-model | pre-commit |
| pre-commit hook | ESLint + vue_rules_checker | git commit |

### 7.2 协议相关检查

`tools/check-platform-sync.sh` — 检查 Tauri 和 Electron 的共享文件是否同步：

```bash
# 在 pre-commit hook 中调用
bash tools/check-platform-sync.sh
```

如果检测到不一致，输出差异并阻止 commit。
