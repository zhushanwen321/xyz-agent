---
verdict: fail
must_fix: 3
review_metrics:
  files_reviewed: 18
  boundaries_checked: 15
  issues_found: 7
  must_fix_count: 3
  low_count: 3
  info_count: 1
  duration_estimate: "75"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-05 17:58
- 上游 BLR: business_logic_review_v2.md
- 上游 spec: spec.md (FR1-FR9, AC1-AC12)
- 上游 use-cases: use-cases.md (UC-1 ~ UC-8)
- 模块边界点数：15
- 模拟数据验证路径数：5 (UC-1 Esc 关闭, UC-2 batch copy, UC-3 branch navigate, UC-5 sidebar collapse, UC-6 fullscreen toggle)
- Git 范围：`218b973^..HEAD` (3511 行 diff, 12 modify + 3 new + 2 new test files)
- 审查方法：SKILL.md Step 1-3, D1-D4 维度

## 范围摘要

| 维度 | 数据 |
|------|------|
| 审查文件 | 18 个源文件（10 renderer Vue/TS + 3 runtime TS + 1 shared TS + 2 new stores + 2 new test files） |
| 模块边界 | 15 处（main ↔ preload ↔ renderer ↔ sidecar WS ↔ 跨组件 props/emit 链） |
| 模拟数据路径 | 5 条（BLR v2 路径 1-5）+ 3 条补充（steer/follow_up, fork/clone label, batch session switch） |

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|---------|--------|------------|------------|------------|----------|------|
| UC-1 | MessageBubble → MessageActionMenu (props/emit) | ✅ | ⚠️ | ✅ | — | I#1 toast:show 未消费 |
| UC-1 | MessageActionMenu → collectMessageContent → clipboard (event-bus) | ❌ | ❌ | ✅ | — | M#1 toast:show 未消费, M#3 markdown 源码丢失 |
| UC-2 | ChatPanel → BatchSelectBar (v-if/props) | ✅ | ✅ | ⚠️ | — | L#1 双重 v-if |
| UC-2 | PanelBar → ChatPanel (emit toggle-batch-select) | ✅ | ✅ | ✅ | — | — |
| UC-2 | ChatPanel batch copy → DOM querySelector → collectBatchContent → clipboard | ❌ | ❌ | ✅ | — | M#1 toast 未消费, M#3 markdown 丢失 |
| UC-2 | ChatPanel batchMode across session switch | ❌ | — | ❌ | — | M#2 batch mode 未重置 |
| UC-3 | ChatPanel.computed → MessageBubble.props → BranchIndicator.props → emit → useTree | ✅ | ✅ | ✅ | — | — |
| UC-5 | SidebarCollapseHandle/SidebarHeader/→ sidebarStore → AppSidebar v-if → CSS | ✅ | ✅ | ✅ | — | — |
| UC-6 | Electron main → preload IPC → App.vue → layoutStore + CSS class | ✅ | ✅ | ✅ | — | — |
| UC-7 | ChatInput → PanelSessionView.handleSend → ws-client send (mode routing) | ✅ | ⚠️ | ✅ | ✅ | L#3 message.status 空 handler |
| UC-7 | WS message.steer → server.ts abort+sendMessage → message.status response | ✅ | ✅ | ✅ | ✅ | — |
| UC-8 | MessageActionMenu → useTree.fork → WS → tree-message-handler → tree-service | ✅ | ✅ | ⚠️ | ✅ | L#2 未使用的 labelSuffix 参数 |
| UC-8 | WS tree-fork-result → useTree.ts event handler → session.list + session.switch | ✅ | ✅ | ✅ | ✅ | — |
| UC-8 | tree-message-handler fork/clone label → rebindAfterFork / renameSession | ✅ | ✅ | ✅ | ✅ | — |
| IPC | preload → renderer (onFullscreenChanged, onShortcut) | ✅ | ✅ | ✅ | — | — |

## 问题清单

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | MUST_FIX | UC-1, UC-2 | clipboard → event-bus → App.vue | D2 | **`toast:show` 事件被 emit 但从未被消费。** `copyWithToast()` (clipboard.ts:28,35) 和 `MessageActionMenu.vue` (handleCopy 错误路径:96,113) 均 emit `'toast:show'` 事件，但 App.vue 仅监听 `'extension.ui_timed_out'` 和 `'error'` 事件。所有复制操作的 Toast 反馈（成功/失败）全部丢失，违反 AC2。 | `src-electron/renderer/src/lib/clipboard.ts` (emitter), `src-electron/renderer/src/App.vue` (miss consumer) | clipboard.ts:28,35; App.vue:330-345 | 在 App.vue `onMounted` 中添加 `on('toast:show', (payload) => { toasts.value.push({ id: crypto.randomUUID(), ...payload }); setTimeout(() => dismissToast(id), TOAST_DURATION_MS) })`，与现有 `extension.ui_timed_out` 处理模式一致 |
| 2 | MUST_FIX | UC-2 | ChatPanel batchMode (session switch) | D1 | **切换 session 时 batchMode 未重置。** `ChatPanel.vue` 的 `batchMode` ref 和 `selectedIds` Set 在 `sessionId` prop 变化时不被清理。ChatPanel 组件跨 session 保持挂载（PanelSessionView 不销毁/重建），导致：切换到新 session 时 checkboxes 仍然可见（`selectable=batchMode`），且 `selectedIds` 可能包含旧 session 的过期 message ID。 | `src-electron/renderer/src/components/panel/ChatPanel.vue` | — | 添加 `watch(() => props.sessionId, () => exitBatchMode())`，与新消息自动滚动 watch 并列 |
| 3 | MUST_FIX | UC-1, UC-2 | collectMessageContent → DOM textContent | D1 | **"复制"（markdown 源码格式）实际输出的是渲染后的纯文本。** `collectMessageContent()` 通过 `body.textContent` 读取 `.msg__body` 内容。但 `.msg__body` 经由 `v-html="renderedContent"` 填充——`renderedContent` 已是 HTML（markdown → HTML 渲染结果）。`textContent` 提取的仅是纯文本，所有 markdown 格式（`#`, `**`, `-`, `[]()` 等）在从 `message.content` → HTML → textContent 的两次转换中永久丢失。导致 "复制" 和 "复制纯文本" 产生实质相同的输出，违反 spec "默认 markdown 源码格式" 约束。 | `src-electron/renderer/src/lib/collectMessageContent.ts` | 57-59 | 方案 A（推荐）：在 `MessageBubble.vue` 的 `.msg__body` 上添加 `:data-markdown-source="message.content"`，`collectMessageContent` 优先读取 `data-markdown-source` 后备退到 `textContent`。方案 B：重构 `collectMessageContent` 接口接受可选 `overrideContent` 参数，由调用方（`MessageActionMenu` / `ChatPanel.collectBatchContent`）传入 `message.content`。 |
| 4 | LOW | UC-2 | BatchSelectBar 内部 v-if | D1 | **BatchSelectBar 双重 v-if 导致进入 batch 模式时存在不可见元素。** ChatPanel.vue 用 `v-if="batchMode"` 控制组件挂载，但 BatchSelectBar.vue 内部根 div 又用 `v-if="selectedIds.length > 0"`。进入 batch 模式时组件实例已存在但内容不可见。BLR 已标记为 LOW #1，不阻塞。 | `src-electron/renderer/src/components/chat/BatchSelectBar.vue` | 2 | 可选：移除内部 `v-if`，始终渲染 `<Transition>` 内的 bar，让 CSS transition 处理出入动画 |
| 5 | LOW | UC-8 | tree-service fork/clone → labelSuffix 参数 | D3 | **`tree-service.ts` 的 `forkFromEntry` 和 `cloneSession` 方法声明了 `labelSuffix` 参数但从未使用。** 参数用 `@typescript-eslint/no-unused-vars` 抑制 lint 警告。实际的 label 命名在 `tree-message-handler.ts` 中通过 `rebindAfterFork`/`renameSession` 完成。`labelSuffix` 虽传入 pi 后端但无实际作用，属于死代码。 | `src-electron/runtime/src/services/tree-service.ts` | 150-175 | 移除未使用的 `labelSuffix` 参数，或将 label 逻辑统一到 tree-service 中由 handler 调用 |
| 6 | LOW | UC-7 | useChat.ts message.status handler | D2 | **`message.status` 事件处理器是空操作。** `useChat.ts` 的 `onStatus` 函数体为 `void _msg`，对 `message.steer` 成功后服务端返回的 `{ status: 'sent' }` 及 `message.follow_up` 返回的 `{ status: 'queued' }` 不做任何处理。这虽然是成功路径（错误由 `message.error` 处理），但 `'queued'` 状态从未传递给 UI。 | `src-electron/renderer/src/composables/useChat.ts` | 148 | 添加 `'queued'` 状态处理（可暂不展示 UI，至少保留日志跟踪）；添加 `'sent'` 状态日志 |
| 7 | INFO | UC-1 | MessageActionMenu error toast (event-bus) | D2 | **MessageActionMenu 错误路径直接 emit `'toast:show'`，与 M#1 同一根因。** `handleCopy` 和 `handleCopyPlain` 在消息元素未找到时通过 `emitEvent('toast:show', ...)` 发送错误提示，与 `clipboard.ts` 模式一致。修复 M#1 后自动修复此问题。 | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 96, 113 | 同 M#1 修复方案 |

## 模拟数据验证详情

### 路径 1：UC-1 Esc 关闭菜单（同 BLR 路径 1）

**模拟数据：** `{ scenario: "用户打开消息操作菜单后按 Esc" }`
**执行路径：** `User presses Escape → keydown Event → MessageActionMenu @keydown.esc → $emit('close')` (菜单内 focus 路径) 或 `document-level handleKeydown → e.key === 'Escape' && props.visible → $emit('close')` (全局兜底)
**调用方传递：** 双监听器均已注册（`@keydown.esc`: template:15-16; `document.addEventListener('keydown', handleKeydown)`: onMounted:139-140）
**被调用方期望：** `props.visible === true` 时 Emit close
**结论：** ✅ 匹配 — 双监听器完整，onUnmounted 正确清理

### 路径 2：UC-2 批量选择 & 复制 markdown（同 BLR 路径 2）

**模拟数据：** `{ selection_order: ["entry-u1", "entry-a1", "entry-a2"], roles: ["user", "assistant", "assistant"] }`
**执行路径：** `PanelBar ≡ → toggle-batch-select → ChatPanel.toggleBatchMode() → batchMode=true → MessageBubble selectable=true → click checkbox → toggleSelect(id) → selectedIds Set → BatchSelectBar → copyBatchAs('markdown') → collectBatchContent → collectMessageContent → copyWithToast`
**调用方传递：** `elements = document.querySelector([data-entry-id="..."])` (DOM query)
**被调用方期望：** collectMessageContent 从 DOM `textContent` 读取 → markdown 源码
**结论：** ⚠️ 部分不匹配 — `collectMessageContent` 读取的 `textContent` 是渲染后的 HTML 文本，非 markdown 源码（M#3）。`copyWithToast` emit 的 `'toast:show'` 未被消费（M#1）。batchMode 在 session 切换时不重置（M#2）。

### 路径 3：UC-3 分支导航（同 BLR 路径 3）

**模拟数据：** `{ entryId: "entry-a1", siblingCount: 3, branchTabs: [{ label: "默认路径", targetId: "...", isActive: true }, ...] }`
**执行路径：** `ChatPanel.branchTabsMap (computed) → MessageBubble :branch-tabs + :sibling-count → BranchIndicator pill → click → toggleDropdown → onSelectBranch → emit('navigate') → ChatPanel.onNavigate → useTree.navigate → WS session.tree-navigate → tree-message-handler → treeService.navigateTree`
**调用方传递：** `targetEntryId: "entry-a1-py"` (string)
**被调用方期望：** tree-message-handler `if (!targetEntryId) return` fail-fast + navigateTree
**结论：** ✅ 匹配 — 4 段数据链完整贯通，payload 校验到位

### 路径 4：UC-5 侧边栏折叠三入口（同 BLR 路径 4）

**模拟数据：** `{ initial_state: "sidebarStore.collapsed = false" }`
**执行路径：** `SidebarCollapseHandle.click (右边缘/左边缘) 或 SidebarHeader.click → sidebarStore.toggle() → AppSidebar v-if="!isCollapsed" 切换 → CSS class app-container--sidebar-collapsed → --sidebar-w: 0px + transition`
**调用方传递：** 三个入口均调用 `sidebarStore.toggle()`
**被调用方期望：** collapsed state 翻转 + CSS 过渡
**结论：** ✅ 匹配 — 三入口统一数据源，v-if + CSS 双驱动

### 路径 5：UC-6 macOS 全屏切换（同 BLR 路径 5）

**模拟数据：** `{ initial_state: "layoutStore.isFullscreen = false" }`
**执行路径：** `Electron main → enter-full-screen → preload IPC → App.vue IPC handler → layoutStore.setFullscreen(true) + classList.add('is-fullscreen') → AppSidebar computed → Row1 brand v-if="isFullscreen" → Row2 brand v-if="!isFullscreen" → CSS .is-fullscreen .sidebar-row1 { padding-left: 14px }`
**调用方传递：** `isFullscreen: boolean` (来自 Electron)
**被调用方期望：** layoutStore 响应式 + CSS class 冗余路径
**结论：** ✅ 匹配 — 双保险（store + CSS class），AppSidebar computed 响应正确

### 补充路径 6：UC-7 Steer 发送模式

**模拟数据：** `{ sessionId: "sid-1", content: "继续", sendMode: "steer" }`
**执行路径：** `ChatInput Enter → PanelSessionView.handleSend → if (mode === 'steer') abort() + setGenerating(true) + send({ type: 'message.steer', payload: { sessionId, content } }) → ws-client → server.ts message.steer → try abort() best-effort → sendMessage → message.status { status: 'sent' }`
**边界检查：**
- 客户端先 `abort()` 后 `send('message.steer')` — 可能产生竞争：`message.abort` 和 `message.steer` 背靠背发送，服务端 `message.steer` 中冗余 `abort()` 为 best-effort 设计，无有害影响 ✅
- 服务端 `message.steer` catch 块返回 `message.error` 类型 — 前端 `useChat.ts` `onError` 正确处理 ❓但 `message.status` 成功响应被 `onStatus` 空函数吞掉（L#3）
**结论：** ⚠️ 主要路径匹配，status 处理有 LOW 问题

### 补充路径 7：UC-8 Fork/Clone label 命名

**模拟数据：** `{ sessionId: "sid-1", entryId: "entry-5", originalLabel: "my-session" }`
**执行路径：** `MessageActionMenu.handleFork → useTree.fork(sid, eid) → WS session.tree-fork → tree-message-handler: getSummary(sid).label → 'my-session-fork' → forkFromEntry(sid, eid, '-fork') → rebindAfterFork(sid, newSid, 'my-session-fork', sessionFile)`
**调用方传递：** `rebindAfterFork(oldSessionId, newSessionId, label, sessionFilePath)` — 4 参数，interface 已更新
**被调用方期望：** `ISessionService.rebindAfterFork` 签名匹配 `(oldSessionId: string, newSessionId: string, label: string, sessionFilePath?: string)`
**结论：** ✅ 匹配 — label 参数正确传递并写入 `initializeManagedSession`。Clone 路径通过 `renameSession(newSessionId, 'my-session-clone')` 同样正确。接口契约一致（`ISessionService` 已更新）。`tree-service.ts` 中 `labelSuffix` 参数未使用（L#2）。

## 集成失败模式分析

### 失败模式 1：WS 消息格式错位

| 风险点 | 评估 | 证据 |
|--------|------|------|
| `message.steer` payload 与 `ClientMessageMap` 一致 | ✅ | `protocol.ts` 定义 `{ sessionId: string; content: string }`，`PanelSessionView.vue` 发送 `{ sessionId: sid, content: payload.content }`，`server.ts` 读取 `msg.payload.sessionId` 和 `msg.payload.content` 一致 |
| `message.follow_up` 同 | ✅ | 同上 |
| `session.tree-fork` payload | ✅ | `ClientMessageMap` 定义 `{ sessionId: string; entryId: string }`，`useTree.fork` 发送匹配，`tree-message-handler` 类型断言 `payload as { sessionId?: string; ...; entryId?: string }` 安全 |
| 新 message 类型分支未添加到 server.ts switch | ✅ | `server.ts:175-181` 已将 `message.steer` 和 `message.follow_up` 加入 `handleSessionMessage` switch |

### 失败模式 2：Payload 校验

| 风险点 | 评估 | 证据 |
|--------|------|------|
| `tree-message-handler` 缺少 sessionId 时 fail-fast | ✅ | `if (!sid) return send(error)` — 对 `tree-data`, `navigate`, `fork`, `capability`, `clone` 全部统一处理 |
| `tree-message-handler` 缺少 targetEntryId | ✅ | `if (!targetEntryId) return send(error)` |
| `tree-message-handler` 缺少 entryId | ✅ | `if (!entryId) return send(error)` |
| server.ts `message.steer` 缺少 sessionId | ⚠️ | 无显式校验，`msg.payload.sessionId` 为 undefined 时 `abort(undefined)` 和 `sendMessage(undefined, content)` 由下游处理。`abort` 对 undefined 可能抛出类型错误。**建议添加 fail-fast。**（LOW） |
| server.ts `message.follow_up` 同 | ⚠️ | 同上 |

### 失败模式 3：错误传播

| 风险点 | 评估 | 证据 |
|--------|------|------|
| `message.steer` abort 失败 | ✅ | `try/catch` with `console.warn` — best-effort，不影响后续 sendMessage |
| `message.steer` sendMessage 失败 | ✅ | catch → `message.error` 返回前端 + `console.error` |
| `message.follow_up` sendMessage 失败 | ✅ | 同上 |
| clipboard 写入失败 | ❌ | `copyWithToast` emit `'toast:show'` 但未被消费 (M#1) |
| `collectMessageContent` DOM 查询失败 | ⚠️ | `MessageActionMenu` 中 `getMessageEl()` 返回 null 时 emit `'toast:show'` 但未被消费 (M#1, I#1) |

## 兼容性分析

| 系统 | 交互方式 | 兼容性评估 |
|------|----------|-----------|
| 现有 session 系统 | fork/clone 创建新 session + switch | ✅ 通过 `session.list` + `session.switch` WS 消息刷新和切换 |
| 现有 panel 系统 | 批量选择独立于 panel 拆分/合并 | ✅ `batchMode` 是 ChatPanel 本地状态，不影响 panel tree |
| 现有 chat store | 新增 message.steer/follow_up 类型 | ✅ 通过已有的 sessionState 分区管理 |
| 现有 tree store | `branchTabsMap` computed 读取 `getActivePath` | ✅ 兼容现有 pathNodes 结构 |
| 现有 sidebar store | 新建 `useSidebarStore` + CSS modifier | ✅ 独立 store，不冲突 |
| 现有 layout store | 新建 `useLayoutStore` 承载 isFullscreen | ✅ 独立 store，替代本地硬编码 ref |
| 现有 event-bus | clipboard.ts/MessageActionMenu emit toast:show | ❌ **不兼容** — toast:show 事件格式 (`{ type, title, description }`) 与 App.vue 的 ToastItem 接口 (`{ id, type, title, description }`) 不匹配，缺少 `id` 字段。App.vue 需要生成 `id`。**M#1 修复需处理此兼容性差异。** |

## 关键决策验证

| 决策 | 预期 | 实际 | 评估 |
|------|------|------|------|
| Fork/Clone label 通过 `rebindAfterFork` 传递 label 参数 | `session-service.ts` 接收 label 参数 | ✅ `ISessionService.rebindAfterFork` 签名已更新含 `label: string`，`initializeManagedSession` 使用传入 label | ✅ |
| Fork 命名 = `原名称-fork` | `tree-message-handler` 拼接 | ✅ `originalLabel + '-fork'` | ✅ |
| Clone 命名 = `原名称-clone` | `tree-message-handler` 拼接 | ✅ `originalLabel + '-clone'` via `renameSession` | ✅ |
| send mode 路由通过 `payload.sendMode` | `PanelSessionView.handleSend` 分支 | ✅ `mode === 'steer'/'queue'/'send'` 三分支 | ✅ |
| `message.steer` WS 类型 + payload | `protocol.ts` + `server.ts` | ✅ 均已添加 | ✅ |
| `message.follow_up` WS 类型 + payload | 同上 | ✅ 均已添加 | ✅ |
| 侧边栏折叠三个入口统一 store | `useSidebarStore.toggle()` | ✅ 三个组件均调用同一方法 | ✅ |
| 全屏状态 store + CSS 双路径 | `layoutStore.setFullscreen` + `classList.toggle` | ✅ App.vue IPC handler 同时更新两者 | ✅ |
| Toast 反馈通过 event-bus | `copyWithToast` emit `'toast:show'` | ❌ **emit 了但未消费** (M#1) | ❌ |

## 结论

**verdict: fail** — 发现 3 个 MUST_FIX 问题，涉及核心交互路径（复制 Toast 反馈、批量选择 session 切换重置、markdown 源码格式丢失）。

### 必须修复的问题（MUST_FIX）

1. **M#1 — Toast 反馈完全断裂**：`copyWithToast` 和 `MessageActionMenu`  emit 的 `'toast:show'` 事件没有任何消费者。所有复制操作（单条/批量）的成功/失败反馈对用户完全不可见。这是 event-bus 集成缺失，影响 UC-1 和 UC-2 两个核心用例，直接违反 AC2。

2. **M#2 — 批量选择跨 session 污染**：`ChatPanel.batchMode` 不在 session 切换时重置，导致切换到新 session 后残留 UI 状态。虽然不崩溃，但用户体验严重受损。

3. **M#3 — Markdown 源码丢失**：`collectMessageContent` 从 DOM `textContent` 读取正文，但 DOM 中只有渲染后的 HTML（markdown → HTML 转换后），markdown 格式已不可逆丢失。"复制"和"复制纯文本"实际产生相同输出。这是模块边界（message model → DOM rendering → clipboard）的数据格式转换失效。

### 建议修复顺序

1. **M#1** → App.vue 添加 `'toast:show'` 事件监听（最小改动，约 10 行代码）
2. **M#2** → ChatPanel.vue 添加 `watch(sessionId)` 重置（最小改动，约 3 行代码）
3. **M#3** → 推荐方案 A：在 MessageBubble 的 `.msg__body` 添加 `data-markdown-source` 属性（约 5 行 template 改动 + 3 行 collectMessageContent 改动）

### 已通过检查项

- ✅ Fork/Clone label 命名管道完整（`tree-message-handler → rebindAfterFork`）
- ✅ Send mode 路由完整（`ChatInput → PanelSessionView → WS → server`）
- ✅ Sidebar 折叠三入口统一驱动
- ✅ macOS 全屏 store + CSS 双路径
- ✅ BranchIndicator 数据链 4 段贯通
- ✅ WS payload fail-fast 校验（sessionId/targetEntryId/entryId）
- ✅ Utility Rail 布局集成正确（PanelBody flex row）
- ✅ BatchSelectBar DOM query + format 拼接符合 spec FR3
