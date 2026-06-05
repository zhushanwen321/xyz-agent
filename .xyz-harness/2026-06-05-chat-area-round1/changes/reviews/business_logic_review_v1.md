---
verdict: fail
must_fix: 6
review_metrics:
  files_reviewed: 22
  issues_found: 11
  must_fix_count: 6
  low_count: 4
  info_count: 1
  duration_estimate: "90m"
---

# Dev Business Logic Review v1

## 审查记录

- 审查时间：2026-06-05 16:55
- 审查模式：Dev (L1 + L2)
- 审查对象：`use-cases.md` (UC-1 ~ UC-8) + `git diff 218b973^..5858876` (30 commits, 32 source/test files) + 实际源码
- 模拟数据路径数：2 (UC-1 copy single message with thinking/tool; UC-8 fork with -fork label)

## 范围摘要

| 维度 | 数据 |
|------|------|
| Commit 范围 | 30 commits (`218b973 docs: plan phase retrospect` → `5858876 fix(chat-area-round1): remove unused declarations`) |
| 源文件 diff | 32 个 (renderer 21 + runtime 5 + main 1 + preload 2 + tests 3) |
| 新增 LOC | +1523, -96 |
| 涉及 FR | FR1–FR9 |
| 涉及 AC | AC1–AC12 |
| 涉及 UC | UC-1 ~ UC-8 |

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|----------|----------|-----------|
| UC-1 | 复制单条消息 | ⚠️ 部分 | `MessageBubble.onActionBtnClick → MessageActionMenu.handleCopy → collectMessageContent(el) → copyWithToast → emit('toast:show')` | M#1 缺 Esc 关闭菜单 (A3 路径断) |
| UC-2 | 批量选择 & 复制多条 | ❌ 未覆盖 | `PanelBar.batch-select-trigger → emit('toggle-batch-select')` → **无消费者** | M#2 `BatchSelectBar` 创建但未挂载；AC3、AC4 用户路径断裂 |
| UC-3 | 分支导航 | ❌ 未覆盖 | `MessageBubble → BranchIndicator` 渲染正常，但 `branchTabs` 硬编码返回 `[]`；且 `<MessageBubble>` 未监听 `@navigate` | M#3 分支数据未接通 + 事件无下游消费者 |
| UC-4 | Utility Rail 滚动导航 | ⚠️ 部分 | `ChatPanel.onChatScroll → showScrollTop/Bottom → UtilityRail` | M#4 滚动非平滑 (spec 要求"平滑") |
| UC-5 | 侧边栏折叠 | ❌ 未覆盖 | `useSidebarStore` + `SidebarCollapseHandle` + `SidebarHeader` 三个产物都未被 `AppSidebar.vue` 引用 | M#5 折叠入口断链 (AC8 全部 3 入口失效) |
| UC-6 | macOS 全屏适配 | ⚠️ 部分 | `window-manager enter-full-screen → preload onFullscreenChanged → App.vue toggle .is-fullscreen on appContainer → style.css overrides` | M#6 AppSidebar 的 Vue 模板 `v-if="isFullscreen"` 永不触发 (本地 ref 硬编码 false)；CSS 兜底只能隐藏 Row2 brand，Row1 brand 永远不渲染 |
| UC-7 | Steer / Queue 发送模式 | ✅ 完整 | `ChatInput.sendMode computed → emit('send', {sendMode}) → PanelSessionView.handleSend → send({type: message.steer/follow_up}) → server.ts handler → sessionService.abort/sendMessage` | — (LOW: send 按钮颜色非红；LOW: skill/agent 命令未走 sendMode 路由) |
| UC-8 | Fork / Clone 命名 | ✅ 完整 | `MessageActionMenu.handleFork → useTree.fork → session.tree-fork → tree-message-handler → forkFromEntry(sid, entryId, '-fork') → rebindAfterFork(sid, newId, originalLabel+'-fork')` | — (INFO: Clone 走 `renameSession` 而非 `rebindAfterFork`，对未落盘的克隆 session 静默失败) |

## 问题清单

| # | 严重度 | UC/AC | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|-------|------|------|----------|---------|
| 1 | MUST_FIX | UC-1 / AC1 A3 | `MessageActionMenu` 注释写 "Close on Escape" 但无 `keydown.esc` 监听；用户按 Esc 菜单不关闭 | `src-electron/renderer/src/components/chat/MessageActionMenu.vue` | 126–132 (watch) | 添加 `onMounted`/`onUnmounted` 监听 document keydown，匹配 `Escape` 时 emit('close')；或迁移到 `Teleport` 内的 backdrop 上加 `@keydown.esc` |
| 2 | MUST_FIX | UC-2 / AC3 AC4 | `BatchSelectBar.vue` 创建并通过单测（8 个 vitest），但 **未被任何父组件 import**；`PanelBar` emit 的 `toggle-batch-select` 无消费者；`MessageBubble` 也无 `checkbox` 渲染路径 | `src-electron/renderer/src/components/chat/BatchSelectBar.vue` (整文件)；`src-electron/renderer/src/components/panel/PanelBar.vue:170` | — | 在 `ChatPanel` 中：1) 维护 `batchMode: boolean` + `selectedIds: Set<string>`；2) batchMode=true 时给每条消息加 checkbox (MessageBubble 新 prop)；3) 渲染 `<BatchSelectBar :selected-ids="..." @copy-markdown="..." />`；4) 实现 `collectMessageContent` 多消息版本（按 spec 格式拼接）并调用 `copyWithToast` |
| 3 | MUST_FIX | UC-3 / AC5 | `BranchIndicator.branchTabs` 硬编码 `return []`（注释承认"will be populated when integrated with MessageList"）；且 `MessageBubble` 三个位置的 `@navigate` emit 在 `ChatPanel.vue:57` 没有 `@navigate` 监听；store 端的 `getActivePath` + `branchTabs` 数据流完全没接 | `src-electron/renderer/src/components/chat/BranchIndicator.vue:43-51`；`src-electron/renderer/src/components/panel/ChatPanel.vue:57` | — | 1) `BranchIndicator` 接受 `:branch-tabs="..."` prop（由 `useTreeStore` 查找当前 entryId 对应 `PathNode.branchTabs`）；2) `MessageBubble` 接收 `branchTabs` prop；3) `ChatPanel` 监听 `@navigate="targetId => useTree().navigate(sessionId, targetId)"` |
| 4 | MUST_FIX | UC-4 / AC6 | Utility Rail 滚动按钮点击使用 `el.scrollTop = 0` / `el.scrollTop = el.scrollHeight`（瞬移），spec 明确要求"**平滑**滚动"（FR5: "平滑滚动到消息列表底部"） | `src-electron/renderer/src/components/panel/ChatPanel.vue` | 245-253 (`handleScrollToTop`/`handleScrollToBottom`) | 改为 `el.scrollTo({ top: 0, behavior: 'smooth' })` / `el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })`；`forceScrollToBottom` 也建议加 smooth 选项（首次加载、session 切换） |
| 5 | MUST_FIX | UC-5 / AC8 | `SidebarCollapseHandle.vue` + `SidebarHeader.vue` 创建（FG3 task 10/11/12），barrel 导出到 `index.ts`，但 **`AppSidebar.vue` 完全没引用它们**；`useSidebarStore` 也没在 `AppSidebar` 中 import；侧边栏宽度 `--sidebar-w: 260px` 是硬编码且无 transition | `src-electron/renderer/src/components/layout/AppSidebar.vue`；`src-electron/renderer/src/style.css:42` | — | 1) `AppSidebar.vue` 引入 `useSidebarStore` 并用 `v-if/v-else` 控制侧边栏挂载/卸载；2) 渲染 `<SidebarHeader />` 替换自带的 row1 折叠按钮；3) 渲染 `<SidebarCollapseHandle />` 作为边沿把手；4) `--sidebar-w` 改为响应式 CSS 变量（`collapsed ? 0 : 260px`），并加 `transition: width 0.2s ease` 到 `.app-container` |
| 6 | MUST_FIX | UC-6 / AC9 | `AppSidebar.vue:33` 的 `const isFullscreen = ref(false)` 是 **硬编码且永不更新** 的本地 ref（TODO 注释承认"通过 Electron API 检测全屏状态"）；IPC fullscreen 事件只 toggle 了 `appContainer.classList`，对 `AppSidebar` 内部 `v-if="isFullscreen"` 无效；导致：全屏时 Row1 brand `v-if="isFullscreen"` 永远 false → **不渲染**；Row2 brand 被 CSS `display: none !important` 隐藏 → **两边都看不到品牌** | `src-electron/renderer/src/components/layout/AppSidebar.vue` | 33, 77, 106 | 1) 删除本地 `isFullscreen` ref；2) 改用 Pinia store（如 `useSettingsStore.fullscreen` 或新建 `useLayoutStore`）；3) `App.vue` 的 IPC 监听器同时更新 store；4) AppSidebar 用 `storeToRefs` 订阅；或彻底改为 CSS-only（删 v-if，行内 brand 默认隐藏，靠 `.is-fullscreen` 显示 Row1 brand、隐藏 Row2 brand） |
| 7 | LOW | UC-7 / FR8 | spec FR8 要求"发送按钮变红色 ■（stop 图标）"，当前 InputToolbar 在 isStreaming 时使用 `variant="ghost"` + `text-muted`（灰色），hover 才 `bg-danger-light text-danger`——稳态颜色不是红色 | `src-electron/renderer/src/components/chat/InputToolbar.vue` | 258-266 | streaming 时改用 `bg-danger text-white` 或 `variant="danger"` 样式，让稳态即可见红色 |
| 8 | LOW | UC-1 内部 | `MessageBubble.vue:62` `let renderVersion = 0` 是**模块级**变量，注释却说"组件级闭包"；多个 MessageBubble 实例共享同一个计数器，A 实例的迟来 render 会**被 B 实例的新 render 覆盖**（guard 失效） | `src-electron/renderer/src/components/chat/MessageBubble.vue` | 62 (let), 81-90 (watch) | 把 `renderVersion` 移到 `setup()` 内： `const renderVersion = ref(0)`，watch 闭包内 `renderVersion.value++` |
| 9 | LOW | UC-7 | `ChatInput.handleSend` 在 `activeCommand.value` 路径下 emit 的 payload **不包含 `sendMode`**（`content` + `skillName`/`subagent`），意味着用户在流式状态下用 `/skill:foo` 命令无法走 Steer 路径——被 spec FR8 "发送按钮始终一个 + 状态栏" 的设计意图绕过 | `src-electron/renderer/src/components/chat/ChatInput.vue` | 200-235 (handleSend) | activeCommand 路径也 emit `sendMode: sendMode.value`，让 `PanelSessionView.handleSend` 统一走 steer/queue 路由 |
| 10 | LOW | UC-7 | `ChatInput` 的 Alt 键检测监听 `document` 全局 keydown，`if (e.key === 'Alt') isAltPressed.value = true` 无条件触发。Alt 键按下时即使用户焦点在 textarea 之外（甚至在另一个应用通过 Alt+Tab 切走再切回），`isAltPressed` 仍可能为 true，造成状态栏闪烁或误判 | `src-electron/renderer/src/components/chat/ChatInput.vue` | 141-152 | 1) 加 `e.altKey === true` 的二次校验；2) 在 `blur` 事件中 reset `isAltPressed`；3) 用 `keydown.alt` 显式 modifier key 而非 `e.key === 'Alt'` |
| 11 | INFO | UC-8 | Clone 路径用 `sessionService.renameSession(newSessionId, originalLabel + '-clone')`（`tree-message-handler.ts:79-81`），但 `renameSession` 走 `findScannedSession`（磁盘扫描）路径，因为 clone 后新 sessionId **不在 runtime 的 active sessions map 中**，且如果 pi 尚未落盘，`scanPiSessions` 也找不到——静默无错。Fork 路径正确使用 `rebindAfterFork` 注入 label | `src-electron/runtime/src/tree-message-handler.ts` | 79-82 | 选项 A：clone 也走 `rebindAfterFork`（需要新设计：让 clone 保留同一 pi 进程的子 id，或在 `cloneSession` 后主动 `pm.createSession` 给新 id）；选项 B：在 `renameSession` 找不到时主动 `pm.createSession` 重新挂载；至少应在测试中加一个"clone 后立即 label 不正确"的回归测试 |

## 执行路径详情（Dev 模式）

### UC-1: 复制单条消息（含 thinking + tool call）

**模拟数据：**
```json
{
  "uc_id": "UC-1",
  "scenario": "用户复制一条含 thinking + tool call 的助手消息",
  "input_data": {
    "entryId": "entry-7",
    "messageId": "msg-9",
    "dom": {
      "thinking": "<div class='thinking-block' data-expanded='true'>Let me check the file...</div>",
      "toolCard": "<div class='tool-call-card' data-tool-name='read' data-tool-status='success' data-tool-path='src/order.ts'>read</div>",
      "body": "<div class='msg__body'>订单已创建，total=$99.90</div>"
    }
  },
  "user_action": "hover message → click ⋯ → click 复制"
}
```

**执行路径：**
```
MessageBubble.onActionBtnClick (line 96)
  → actionMenuAnchor = btn.getBoundingClientRect()
  → showActionMenu = true
  → Teleport renders <MessageActionMenu :visible="true" :anchor-rect="..." :entry-id="entryId" :session-id="sessionId" />
MessageActionMenu.menuStyle computed → left/top calculated from anchorRect
User clicks "复制"
  → handleCopy (line 102)
  → getMessageEl(): document.querySelector(`[data-entry-id="${entryId}"]`)  ✓
  → collectMessageContent(el, { format: 'markdown' })
       → querySelectorAll('.thinking-block[data-expanded="true"]')  → "[Thinking: Let me check the file...]"
       → querySelectorAll('.tool-call-card')
         → "[Tool: read ✓ src/order.ts]"  (TOOL_STATUS_SYMBOLS[success]='✓')
       → querySelector('.msg__body')  → "订单已创建，total=$99.90"
       → parts.join('\n\n')  → "[Thinking: ...]\n\n[Tool: ...]\n\n订单已创建..."
  → copyWithToast(text, {format:'markdown'})
       → navigator.clipboard.writeText(text)  ✓
       → emit('toast:show', { type:'success', title:'已复制' })
  → emit('close')  → closeActionMenu
```

**预测输出：**
```
[Thinking: Let me check the file...]

[Tool: read ✓ src/order.ts]

订单已创建，total=$99.90
```

**异常路径 A1（纯文本）：**
```
handleCopyPlain → format='plain'
  → collectMessageContent → stripMarkdown()
  → MARKDOWN_STRIP_RE: /[#*_~`>\[\]()]|!\[.*?\]\(.*?\)|\[([^\]]*)\]\([^)]*\)/g
  → 保留 [Thinking:...] 文本内容（"["和"]"被 strip，但 inner text "Thinking: Let me check..." 保留）
  → ⚠️ 注：此 strip 逻辑会把外层 [Thinking: ...] 和 [Tool: ...] 的方括号去掉——结果变成 "Thinking: ...\n\nTool: read ✓ ..."
```
（这是 strip 设计的有意行为，spec 提到"strip markdown 符号"，方括号属于 markdown 语法。需要确认是否符合用户预期。LOW）

**异常路径 A2（剪贴板失败）：**
```
copyWithToast → try { writeText } catch { emit('toast:show', {type:'danger', title:'复制失败', description:'无法访问剪贴板'}) }
```
✓ 路径完整。

**异常路径 A3（Esc 关闭菜单）：**
```
User presses Escape
  → ❌ MessageActionMenu 无 keydown 监听
  → 菜单保持显示
  → 用户只能点 backdrop 关闭
```
**路径断裂 → MUST_FIX #1**

---

### UC-8: 用户从某 entry Fork 出新会话

**模拟数据：**
```json
{
  "uc_id": "UC-8 (Fork)",
  "scenario": "用户 hover 助手消息 → click ⋯ → click Fork",
  "input_data": {
    "sessionId": "sid-orig",
    "entryId": "entry-5",
    "originalLabel": "feat-user-auth"
  }
}
```

**执行路径：**
```
MessageBubble.onActionBtnClick
MessageActionMenu.handleFork (line 122)
  → sessionId='sid-orig', entryId='entry-5' 均非空
  → useTree().fork('sid-orig', 'entry-5')
       → send({ type:'session.tree-fork', payload:{ sessionId, entryId } })
Server receives message
  → server.ts handleMessage → treeMessageHandler.handleTreeMessage
  → case 'session.tree-fork': (tree-message-handler.ts:64)
       → originalLabel = sessionService.getSummary('sid-orig')?.label ?? 'session'
         → 'feat-user-auth'
       → newLabel = originalLabel + '-fork'  → 'feat-user-auth-fork'
       → treeService.forkFromEntry('sid-orig', 'entry-5', '-fork')
            → client.sendCommand('fork', { entryId:'entry-5' })
            → client.sendCommand('get_state')  → newSessionId='sid-fork', sessionFile='/.../fork.jsonl'
            → return { success:true, newSessionId:'sid-fork', sessionFile:'/.../fork.jsonl' }
       → sessionService.rebindAfterFork('sid-orig', 'sid-fork', 'feat-user-auth-fork', '/.../fork.jsonl')
            → pm.rekey('sid-orig', 'sid-fork')
            → detachSession(old)  → unregister old tree
            → sessions.delete('sid-orig')
            → initializeManagedSession('sid-fork', ..., label='feat-user-auth-fork', sessionFilePath='/.../fork.jsonl')
              → treeService.registerSession('sid-fork', ...)
              → attach usage listener
       → broadcastSessionList()  → 所有 client 收到新列表
  → return { type:'session.tree-fork-result', payload:{ sessionId:'sid-orig', success:true, newSessionId:'sid-fork' } }
Client receives 'session.tree-fork-result'
  → useTree global handler: onTreeForkResult
       → setLoading=false, setPanelOpen=false
       → send({ type:'session.list', payload:{} })
       → send({ type:'session.switch', payload:{ sessionId:'sid-fork' } })
```

**预测结果：**
- ✅ 后端测试 `tree-message-handler.test.ts:54-77` 验证 `rebindAfterFork` 被以 `'feat-user-auth-fork'` 调用
- ✅ session 列表刷新，label 正确显示为 `feat-user-auth-fork`
- ✅ 视图自动切换到新 session

**异常路径（fork 失败）：**
```
client.sendCommand('fork') returns success=false
  → return { success:false, error:'Fork failed' }
  → client handler: setError(sid, 'Fork failed')
  → ❌ 无 UI toast 提示（仅 store.error，需检查 store 是否被任何组件 watch + 渲染）
```
LOW（不在 UC-8 范围）

**异常路径（pi 进程 crash）：**
```
fork 成功后 pi 进程 crash
  → pm.onSessionExit callback → adapter.detach, sessions.delete, treeService.unregisterSession, broadcast session.list
  → 新 session 从 active map 消失，扫描盘后应仍可见（sessionFile 已落盘）
```
✓ 路径完整

---

### 旁路验证：UC-2（批量选择）—— 已断裂

**模拟数据：**
```json
{
  "uc_id": "UC-2",
  "scenario": "用户点击 panel header ≡ 按钮进入批量选择模式",
  "user_action": "click PanelBar.batch-select-trigger"
}
```

**执行路径：**
```
PanelBar.batch-select-trigger (PanelBar.vue:170)
  → $emit('toggle-batch-select')
ChatPanel.vue: <PanelBar ... @toggle-batch-select="???" />   ← ❌ 未监听
  → 事件丢失
  → batchMode 状态无来源
  → BatchSelectBar 永不渲染
  → 消息无 checkbox
  → 无法进入 UC-2 main flow
```

**结论：UC-2 主流程在 UI 层未实现** → MUST_FIX #2

---

### 旁路验证：UC-5（侧边栏折叠）—— 已断裂

**模拟数据：**
```json
{
  "uc_id": "UC-5",
  "scenario": "用户点击 sidebar header ◀ 按钮",
  "user_action": "click <Button> in SidebarHeader.vue"
}
```

**执行路径：**
```
SidebarHeader (sidebar/SidebarHeader.vue)
  → 自身未被任何父组件 import
  → 永不被实例化
```

**结论：UC-5 所有 3 个折叠入口（手柄、header 按钮、左边缘按钮）都是死代码** → MUST_FIX #5

---

## 边界条件 & 缺失处理

| 场景 | 期望行为 | 当前实现 | 评估 |
|------|----------|----------|------|
| 消息无 thinking block | `collectMessageContent` 跳过该 section | `querySelectorAll` 返回空，循环空跑 | ✅ |
| 消息无 tool call card | 同上 | 同上 | ✅ |
| 消息无 body | 不输出 body section | `if (body)` 守卫，text 为空则跳过 | ✅ |
| Tool call 无 path | 输出 `[Tool: name ✓]`（无 path） | `pathPart = path ? \` ${path}\` : ''` | ✅ |
| Tool call status 未识别 | 用原 status 字符串作 symbol | `TOOL_STATUS_SYMBOLS[status] ?? status` | ✅ |
| Clipboard API 不可用（如非 https） | Toast 错误 | `catch` 块覆盖 | ✅ |
| `messageEl` 为 null（getMessageEl 返回 null） | 静默跳过 vs 报错 | 直接跳过，**无 toast 提示用户** | LOW（应至少 toast "无法定位消息元素"） |
| 剪贴板权限被拒 | Toast danger | ✅ | ✅ |
| 流式时 race condition（多实例 renderFull 互相覆盖） | 各实例独立 render | module-level renderVersion 共享 | LOW #8 |
| Skill/agent 命令在流式时 | 应能 Steer/Queue | 当前强制走 send 模式 | LOW #9 |
| 长消息（contentBlocks 顺序） | 按 spec 顺序：thinking → tool → text | ✅ MessageBubble 渲染逻辑正确 | ✅ |
| 空 session（无消息） | rail 按钮不可见（scrollHeight==clientHeight） | `showScrollTop=scrollTop>40, showScrollBottom=scrollHeight-scrollTop-clientHeight>40` | ✅ |
| 分屏模式多个 panel（AC12） | 每个 panel 独立 rail | ✅ PanelBody 包裹 + 每 ChatPanel 实例独立 ref | ✅ |
| macOS 全屏 | brand 上移、+New Session 100% width | ⚠️ CSS 兜底部分生效，但 Vue 模板 brand 永不渲染 | MUST_FIX #6 |

## 业务数据流审计

### Fork/Clone label 拼接（UC-8）

**Spec 要求：** 后端 `rebindAfterFork` 时修改 label，Fork → `原名称-fork`，Clone → `原名称-clone`。

**实际路径：**
- ✅ Fork 走 `rebindAfterFork` (session-service.ts:392)，label 由 `tree-message-handler.ts:67` 拼接 `originalLabel + '-fork'` 后传入
- ⚠️ Clone 走 `renameSession` (tree-message-handler.ts:79)，label 在 `tree-message-handler.ts:80` 拼接 `originalLabel + '-clone'` 后传入；但 `renameSession` 查找 `sessions.get(newSessionId)`（**必然为空**——clone 是全新 session，未注册到 runtime map），fallback 到 `findScannedSession`（磁盘扫描，依赖 pi 已落盘）

**风险：** Clone 完成后若 pi 未立即落盘，rename 静默失败。单元测试通过是因为 mock 了 `renameSession` 直接调用，没有 mock 完整的 scan 流程。INFO #11

### 发送模式路由（UC-7）

**Spec 要求：** 流式时 Steer（中断）、Alt+Enter Queue（排队）、空闲时 Send。

**实际路径：**
```
ChatInput.sendMode computed:
  isStreaming && isAltPressed → 'queue'
  isStreaming                 → 'steer'
  isAltPressed                → 'queue'
  default                     → 'send'

ChatInput.handleSend:
  if (activeCommand) { /* 跳过 sendMode 路由 */ }
  else { emit('send', { content, sendMode: sendMode.value }) }

PanelSessionView.handleSend:
  mode==='steer' → abort() + chatStore.setGenerating(true) + send('message.steer')
  mode==='queue' → send('message.follow_up')
  default         → sendMessage(content)  // session.send RPC

server.ts message.steer handler:
  abort(sessionId)  // 二次保险
  sendMessage(sessionId, content)
  return { type:'message.status', payload:{status:'sent'} }

server.ts message.follow_up handler:
  sendMessage(sessionId, content)  // 不 abort
  return { type:'message.status', payload:{status:'queued'} }
```

**评估：** 路由完整，前端 abort + 后端 abort 双保险。**LOW:** activeCommand 路径未走 sendMode（#9）。

## Key Decisions 落地验证

| Key Decision | 落地状态 | 证据 |
|--------------|----------|------|
| Rail 布局：`chat-content` + `utility-rail` 同级 flex | ✅ | `ChatPanel.vue:42-43` 用 `<PanelBody>` flex-row 包裹；`<div class="flex-1 flex flex-col">` + `<UtilityRail>` 同级 |
| 发送模式指示：输入框上方 20px 状态栏 | ✅ | `ChatInput.vue:79-80` `<SendModeStatusBar :mode="sendMode" />` 在 textarea 之上 |
| 复制数据范围：含 thinking + tool call | ✅ | `collectMessageContent.ts:42-58` 顺序：thinking → tool → body |
| Queue UI：不展示 | ✅ | spec 标注 Out of Scope；无 Queue UI 组件 |
| Fork/Clone 后缀：`-fork` / `-clone` | ✅ | `tree-message-handler.ts:66, 79`；4 个单测全过 |
| 侧边栏折叠宽度：`width: 0`（非 `display: none`） | ❌ | 整个折叠功能未接通；`--sidebar-w: 260px` 硬编码无 transition；MUST_FIX #5 |

## 结论

**Verdict: FAIL** —— 6 个 MUST_FIX 影响 5 个核心 UC（UC-1/2/3/5/6）的主流程或主交互路径。

**必修阻塞（按优先级）：**
1. **M#2** BatchSelectBar 集成（UC-2、AC3、AC4 完全缺失）
2. **M#5** Sidebar 折叠集成（UC-5、AC8 完全缺失）
3. **M#3** BranchIndicator 数据流接通（UC-3、AC5 主流程断）
4. **M#6** AppSidebar fullscreen ref 接通（UC-6、AC9 视觉错乱）
5. **M#4** Utility Rail 平滑滚动（UC-4、AC6 与 spec 不符）
6. **M#1** MessageActionMenu Esc 关闭（UC-1 A3 路径断）

**已验证通过：** UC-7（SendMode 路由）完整、UC-8（Fork/Clone label 命名）通过 4 个单测、协议层 message.steer/follow_up 双向贯通、Test 套件 506 + 104 全绿、Typecheck 全绿、Lint 0 error。

**已知设计偏差（LOW，不阻塞）：** send 按钮颜色、renderVersion 作用域、skill/agent 命令未走 sendMode、Alt 监听粒度、Clone 不 rebind。

**建议下一步：** 进入 v2 修复 6 个 MUST_FIX 后重新审查；LOW 项可并入 v2 或下轮 polish。
