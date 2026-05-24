---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-25T16:30:00"
  target: "slash-commands feature (v2 diff: 10 files changed, ~1100 lines added/modified)"
  verdict: fail
  summary: "编码评审完成，第2轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 10
  must_fix: 1
  must_fix_resolved: 3
  low: 5
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "src-electron/renderer/src/composables/useTree.ts:71"
    title: "session.tree-capability 字段名不匹配：前端读 capable 但后端发 navigateCapable"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "src-electron/renderer/src/composables/useChat.ts:213-229 + ChatInput.vue"
    title: "navigate-result 后 editorText 已捕获但未传递到 ChatInput 组件"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "src-electron/renderer/src/composables/useChat.ts:233-249"
    title: "fork-result 后未自动切换到新 session，违反 AC4"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "src-electron/runtime/src/event-adapter.ts:93-139"
    title: "navigate-result 拦截仅处理 text_delta，未覆盖 content_block_start 等事件类型"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "src-electron/runtime/src/event-adapter.ts:82-98"
    title: "navigate-result 拦截器未做 text_delta 分块缓存，JSON 跨 chunk 时无法解析"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: LOW
    location: "src-electron/renderer/src/components/panel/SessionTreePanel.vue"
    title: "scoped CSS 中使用硬编码 rgba 颜色值，违反禁止硬编码颜色规则"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "src-electron/runtime/src/interfaces.ts:107"
    title: "ISessionService 未声明 cloneSession 方法，与 plan 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "src-electron/renderer/src/components/panel/PanelBar.vue:125"
    title: "使用原生 <button> 元素（与现有 panel-close 保持一致）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 9
    severity: INFO
    location: "src-electron/shared/src/protocol.ts:13"
    title: "session.tree-data 列入 ClientMessageType 与 spec 单方向描述不符，但符合已有代码模式"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 10
    severity: LOW
    location: "src-electron/runtime/src/services/session-service.ts:42"
    title: "xyz-agent-extension.js 路径硬编码为项目根路径，无配置化手段"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 编码评审 v2（增量审查）

## 评审记录
- 评审时间：2026-05-25 16:30
- 评审类型：编码评审（增量模式，验证第1轮 4 条 MUST FIX 修复）
- 评审对象：v2 diff（10 个文件变更，涉及 event-adapter, useTree, useChat, tree store, server, session-service, session-tree-reader, PanelBar, SessionTreePanel, types, protocol, extension）

---

## 增量审查：4 条 MUST FIX 修复验证

### [FIXED] MUST FIX #1: navigateCapable 字段名不匹配

**修复内容**：
- `useTree.ts:63-66` `onTreeCapability`：从 `msg.payload.capable` 改为 `msg.payload.navigateCapable`
- `useTree.ts:47-55` `onTreeData`：新增 `navigateCapable` 提取并写入 store
- `tree.ts:137-140` `setTreeData`：接受 `navigateCapable` 参数

**验证结论**：✅ 充分。字段名对齐，`onTreeData` 和 `onTreeCapability` 两个路径都正确提取 `navigateCapable`。后端 `session-service.ts` 的 `getTree` 也正确返回该字段。

---

### [REMAINS OPEN] MUST FIX #2: navigate-result 中 editorText 未传递到输入框

**修复内容**：
- `useChat.ts:22-27`：新增模块级 `pendingEditorText` 变量和 `consumePendingEditorText()` 导出函数
- `useChat.ts:220-224`：`session.tree-navigate-result` 处理器中将 `msg.payload.editorText` 存入 `pendingEditorText`

**评估**：修复方向正确——数据在 useChat 层被捕获并存储。但**数据链路仅延伸到模块级变量，未到达 UI 层**。

**关键缺失**：没有任何组件调用 `consumePendingEditorText()`。`ChatInput.vue`（`src-electron/renderer/src/components/chat/ChatInput.vue`）未被修改，其 `text` ref 不会从 `pendingEditorText` 初始化。navigate 到 user message 后，文本存入了内存但永远不会出现在 textarea 中。

**判断**：这是一个真正的功能缺失。用户 navigate 到 user message 后，文本应当出现在输入框中。当前实现捕获了数据但管道断了。

**修改方向**：
- 在 `ChatInput.vue` 中导入 `consumePendingEditorText`，在挂载或 watch sessionId 变化时调用
- 或者将 `text.value = editorText` 逻辑直接放在 `useChat.ts` 的处理函数中（通过 Pinia store 或注入的方式）

**状态**：❌ 未解决。**保持 MUST FIX。**

---

### [FIXED] MUST FIX #3: fork-result 未自动切换 session

**修复内容**：
- `useChat.ts:233-249`：`session.tree-fork-result` 处理器新增 `send({ type: 'session.switch', payload: { sessionId: newSessionId } })`

**验证结论**：✅ 充分。从 `msg.payload.newSessionId` 读取新 session ID，发送 `session.switch` 命令。同时发送 `session.list` 刷新侧边栏。

**后端验证**：`session-service.ts:453-476` 的 `forkFromEntry` 通过 pi RPC `sendCommand('fork')` + `sendCommand('get_state')` 获取新 session ID。经核实：
- pi 的 `fork` RPC 响应仅包含 `{ text, cancelled }`，不返回 sessionId
- 但 pi 的 fork 实现会自动调用 `rebindSession()`，将 RPC 上下文切换到新 session
- 因此 fork 后的 `sendCommand('get_state')` 返回的是新 session 的 `RpcSessionState`，其中的 `sessionId` 正确
- 数据流：fork → rebind → get_state → new sessionId → return → broadcast → frontend send switch ✅

---

### [FIXED] MUST FIX #4: EventAdapter 无跨 chunk 缓冲 + 单 delta 假设脆弱

**修复内容**：
- `event-adapter.ts:36-38`：新增 `navigateBuffer`、`isNavigateStream` 私有字段
- `event-adapter.ts:59-71`：`setNavigateResolver` / `clearNavigateResolver` 方法
- `event-adapter.ts:93-129`：`text_delta` 分支中的跨 chunk 缓冲逻辑——累计 delta 内容，JSON 解析失败时等待后续 delta，而不是丢弃
- `event-adapter.ts:282-285`：`message_end` / `turn_start` / `turn_end` 时重置 navigate 流状态

**验证结论**：✅ 充分。实现了一个完整的跨 chunk JSON 缓冲器：

1. 收到 `{"__xyz_type":"navigate-result"` 前缀 → 进入流模式，开始缓冲
2. 后续 delta 追加到缓冲 → 每收到 delta 尝试 JSON.parse
3. 解析成功 → 调用 resolver，清理状态
4. `message_end` → 清理状态（不泄露）

**关于 content_block_start 的担忧**：v1 审查提到可能通过其他事件类型传递。但 `ctx.sendMessage()` 在 pi 中的实现总是产生 `text_delta` 事件（这是 pi 的消息输出标准路径）。Task 1 验证脚本确认了实际事件格式。跨 chunk 缓冲已经覆盖了最关键的脆弱点。再加上 `message_end` 时的清理，当前实现是生产可用的。

---

## 新发现的问题

### [LOW] Issue #10: xyz-agent-extension.js 路径硬编码

**位置**：`src-electron/runtime/src/services/session-service.ts:42`

```
this.extensionPath = resolve(this.projectRoot, 'xyz-agent-extension.js')
```

**问题**：扩展路径硬编码为项目根目录下的 `xyz-agent-extension.js`。如果项目结构变化（如 extension 文件改名或移动），需要改代码。当前首版可接受，但应跟踪为技术债务。

**修改方向**：将来通过配置（如 `xyz.config.json` 或环境变量）指定扩展路径。

---

## MUST FIX #2 修复建议补充

**修复方案**：在 `ChatInput.vue` 的 `onMounted` 或 `watch(props.sessionId, ...)` 中调用 `consumePendingEditorText()`，若返回非空则设置 `text.value = editorText`。

**另一种更简洁的方案**：在 `useChat.ts` 的 `session.tree-navigate-result` 处理器中，直接通过 Pinia store（如 settingsStore 或一个临时的 inputStore）设置文本，ChatInput 通过 store 读取。当前 `pendingEditorText` 模块级变量的方式对 ChatInput 组件不够可见。

**推荐方案**：在 `useChat.ts` 中新增一个 Pinia store action（例如 `setPendingInputText(text: string)`）或复用一个现有的 store（如 `windowStore` 或 `uiStore`），ChatInput 通过 watch 该 store 的值来更新 textarea。模块级变量方案的发现性差。

---

## 结论

**4 条 MUST FIX 中 3 条已完全修复（#1 #3 #4），1 条部分修复但仍未闭合（#2——editorText 被捕获但未到达 ChatInput）。**

**状态**：`fail`（1 条 open MUST FIX）。需修复后提交第 3 轮审查。

### Summary

编码评审完成，第2轮，1条MUST FIX，需修改后重审。Issue #2 的 editorText 管道在 useChat 层中断——数据已捕获但 ChatInput 未消费。其余 3 条 MUST FIX 全部正确修复，无回归。新增 1 条 LOW 问题（extension 路径硬编码）。
