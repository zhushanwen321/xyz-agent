---
verdict: pass
---

# Session Tree 导航 + Fork/Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 xyz-agent GUI 中实现 pi session tree 的可视化、navigate（移动 leafId 指针）和 fork（从历史节点创建新 session）功能。

**Architecture:** 三层协作——sidecar 读取 pi 的 JSONL 文件构建树结构并通过 WS 推送前端；pi extension 桥接 navigateTree 命令；前端在 PanelBar 下展开扁平+条件缩进的 tree panel。

**Tech Stack:** TypeScript, Vue 3 + Pinia, Node.js (sidecar), WebSocket, pi extension API

**Complexity:** L1 (单文件 plan，不拆子文档)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/shared/src/protocol.ts` | modify | BG1 | 新增 tree 相关的 ClientMessageType + ServerMessageType |
| `src-electron/runtime/src/session-tree-reader.ts` | create | BG1 | JSONL 文件读取、树构建、TreeNode 生成 |
| `src-electron/runtime/src/types.ts` | modify | BG1 | 新增 TreeNode、TreeData 类型定义 |
| `src-electron/runtime/src/server.ts` | modify | BG1 | 新增 session.tree-* WS 消息路由 |
| `src-electron/runtime/src/event-adapter.ts` | modify | BG1 | 新增 navigate-result 拦截逻辑 |
| `src-electron/runtime/src/services/session-service.ts` | modify | BG1 | 新增 getTree、navigateTree、forkFromEntry 方法 |
| `src-electron/runtime/src/interfaces.ts` | modify | BG1 | ISessionService 新增 tree 相关方法签名 |
| `tools/verify-navigate-rpc.cjs` | create | BG1 | 独立验证 sendMessage() 在 RPC 事件流中的格式 |
| `xyz-agent-extension.js` | create | BG1 | pi extension: 注册 xyz-navigate 命令 |
| `src-electron/renderer/src/stores/tree.ts` | create | FG1 | tree 状态管理 (Pinia store) |
| `src-electron/renderer/src/composables/useTree.ts` | create | FG1 | tree WS 事件监听 + 命令发送 |
| `src-electron/renderer/src/components/panel/SessionTreePanel.vue` | create | FG1 | 扁平+条件缩进 tree 面板组件 |
| `src-electron/renderer/src/components/panel/PanelBar.vue` | modify | FG1 | 新增 tree trigger 按钮 + 嵌入 SessionTreePanel |
| `docs/designs/views_session_tree_v2.html` | existing | FG1 | UI 参考设计稿 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC1: Tree 数据读取 (5 条) | adopted | Task 1, Task 2 |
| AC2: Tree 展示 (8 条) | adopted | Task 5 |
| AC3: Navigate (9 条) | adopted | Task 3, Task 2, Task 6 |
| AC4: Fork (6 条) | adopted | Task 2, Task 6 |
| AC5: Clone (2 条) | adopted | Task 2 |
| AC6: Extension 加载与可用性检测 (4 条) | adopted | Task 3, Task 4 |
| FR1: JSONL 读取 | adopted | Task 1 |
| FR2: Tree 展示 UI | adopted | Task 5 |
| FR3: Navigate 调用链 | adopted | Task 3, Task 2, Task 6 |
| FR4: Fork 调用链 | adopted | Task 2, Task 6 |
| FR5: Clone | adopted | Task 2 |
| FR6: Extension 插件 | adopted | Task 3 |
| WS 消息协议 (5 种消息类型) | adopted | Task 1, Task 2 |
| TreeNode 类型定义 | adopted | Task 1 |
| VITE_MOCK mock 数据 | postponed | 后续迭代处理，非核心路径 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 验证脚本 + 类型定义 + JSONL 读取器 | backend | — | BG1 |
| 2 | Sidecar tree 服务方法 + WS 路由 + 事件拦截 | backend | 1 | BG1 |
| 3 | pi Extension 插件 + 可用性检测 | backend | — | BG1 |
| 4 | Extension 启动集成 (ProcessManager 传递 extension 路径) | backend | 3 | BG1 |
| 5 | 前端 Tree Store + Composable + SessionTreePanel 组件 | frontend | 2 | FG1 |
| 6 | PanelBar 集成 + Navigate/Fork 操作流 | frontend | 5 | FG1 |

---

## Dependency Graph & Wave Schedule

```
Task 1 (JSONL读取器) ──┬──→ Task 2 (Sidecar服务) ──→ Task 5 (前端Tree组件) ──→ Task 6 (PanelBar集成)
                       │
Task 3 (Extension)  ───┤
                       │
Task 4 (Extension集成) ─┘ (Task 4 depends on Task 3 only)
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1, Task 3 | 后端基础：JSONL 读取器 + Extension 插件，可并行 |
| Wave 2 | Task 2, Task 4 | 后端服务：sidecar tree 服务 + Extension 启动集成 |
| Wave 3 | Task 5 | 前端：Tree 组件开发 |
| Wave 4 | Task 6 | 前端：PanelBar 集成 + 端到端联调 |

---

### Task 1: 验证脚本 + 类型定义 + JSONL 读取器

**Type:** backend

**Files:**
- Create: `tools/verify-navigate-rpc.cjs`
- Create: `src-electron/runtime/src/session-tree-reader.ts`
- Modify: `src-electron/runtime/src/types.ts`
- Modify: `src-electron/shared/src/protocol.ts`

**Context 注入:**
- Spec FR1, FR3 (前置验证), AC1, WS 消息协议章节
- CLAUDE.md 规则 #4（外部系统对接先验证再编码）
- pi JSONL session 文件格式：`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`，首行 `type: "session"` header，后续行每行一个 JSON entry 含 `parentId`

- [ ] **Step 1: 写 verify-navigate-rpc.cjs 验证脚本**

  独立 Node.js 脚本，连接运行中的 pi 进程 RPC：
  1. 发送 `get_commands` 确认 extension 是否加载
  2. 发送 `/xyz-navigate test-id` 作为 prompt
  3. 监听 RPC 事件流，记录 message_start/content_block_delta/message_end 的完整结构
  4. 验证 `sendMessage()` 输出是否包含 `__xyz_type: "navigate-result"` 标记
  5. 输出完整的事件格式报告

  用法: `node tools/verify-navigate-rpc.cjs [--session-id <id>]`

- [ ] **Step 2: 在 protocol.ts 新增 tree 消息类型**

  在 `ClientMessageType` 追加：
  ```
  | 'session.tree-data' | 'session.tree-navigate' | 'session.tree-navigate-result'
  | 'session.tree-fork' | 'session.tree-fork-result'
  | 'session.tree-capability'
  ```

  在 `ServerMessageType` 追加对应类型。

- [ ] **Step 3: 在 types.ts 新增 TreeNode 等类型**

  ```
  interface TreeNode {
    id: string
    parentId: string | null
    type: string  // pi entry type
    role?: 'user' | 'assistant'
    text: string  // 首行截断，max 100 chars
    label?: string
    timestamp: string
    children: TreeNode[]
  }

  interface TreeData {
    sessionId: string
    tree: TreeNode[]
    leafId: string
    branchCount: number
    navigateCapable: boolean  // extension 是否加载
  }
  ```

- [ ] **Step 4: 实现 session-tree-reader.ts**

  导出函数：
  - `buildTreeFromFile(filePath: string): { byId: Map<string, TreeNode>, rootNodes: TreeNode[], labelsById: Map<string, string> }`
  - `computeActivePath(byId, leafId): Set<string>` — 计算 leaf 到 root 的路径节点 ID 集合
  - `countBranches(rootNodes): number` — 统计有多个 children 的节点数

  读取 JSONL 时逐行 try-catch，跳过格式错误行。跳过 `type: "session"` 的 header。

- [ ] **Step 5: 运行验证脚本，确认 RPC 事件格式**

  运行: `node tools/verify-navigate-rpc.cjs`
  将验证结果记录为后续 EventAdapter 拦截逻辑的输入。

- [ ] **Step 6: Commit**

  ```
  git add tools/verify-navigate-rpc.cjs src-electron/runtime/src/session-tree-reader.ts
  git add src-electron/runtime/src/types.ts src-electron/shared/src/protocol.ts
  git commit -m "feat: add session tree reader + navigate RPC verification"
  ```

---

### Task 2: Sidecar tree 服务方法 + WS 路由 + 事件拦截

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/src/services/session-service.ts`
- Modify: `src-electron/runtime/src/interfaces.ts`
- Modify: `src-electron/runtime/src/server.ts`
- Modify: `src-electron/runtime/src/event-adapter.ts`

**Context 注入:**
- Spec FR3 (Navigate 调用链 8 步), FR4 (Fork 调用链), FR5 (Clone), AC3, AC4, AC5
- Spec WS 消息协议表
- server.ts 现有 session.* handler 模式（switch-case + payload 提取 + sendError）
- event-adapter.ts 现有 translate() 方法和 payload.sessionId 模式
- session-service.ts 现有 sendCommand 调用模式和 getCommands() 已有实现

- [ ] **Step 1: 在 ISessionService 接口新增 tree 方法**

  ```
  getTree(sessionId: string): Promise<TreeData>
  navigateTree(sessionId: string, targetEntryId: string): Promise<{ success: boolean, newLeafId?: string, editorText?: string, error?: string }>
  forkFromEntry(sessionId: string, entryId: string): Promise<{ success: boolean, newSessionId?: string, error?: string }>
  cloneSession(sessionId: string): Promise<{ success: boolean, newSessionId?: string, error?: string }>
  isNavigateCapable(sessionId: string): boolean
  ```

- [ ] **Step 2: 在 SessionService 实现 tree 方法**

  `getTree(sessionId)`:
  1. 通过 `processManager.getClient(sessionId)` 获取 RpcClient
  2. 调用 `client.sendCommand('get_state')` 获取 leafId 和 cwd
  3. 根据 cwd 推导 JSONL 文件路径（`~/.pi/agent/sessions/<encoded-cwd>/`）
  4. 调用 `session-tree-reader.ts` 的 `buildTreeFromFile()` 构建树
  5. 返回 TreeData

  `navigateTree(sessionId, targetEntryId)`:
  1. 如果 targetEntryId === 当前 leafId → return `{ success: true }` (no-op)
  2. 通过 `client.prompt('/xyz-navigate ' + targetEntryId)` 发送 RPC prompt
  3. 启动 5s 超时计时器（Promise.race）
  4. 结果由 EventAdapter 拦截后通过回调解析
  5. 超时 → 返回 `{ success: false, error: 'Navigate 超时' }`

  `forkFromEntry(sessionId, entryId)`:
  1. 调用 `client.sendCommand('fork', { entryId })`
  2. 检查 `success` 字段
  3. 成功后调用 `client.sendCommand('get_state')` 获取新 sessionId
  4. 返回结果

  `isNavigateCapable(sessionId)`:
  1. 检查缓存的 extension 状态（Task 4 中 getCommands 的结果）

- [ ] **Step 3: 在 server.ts 新增 WS 路由**

  在 `handleMessage` switch-case 中新增：

  `session.tree-data`: 调用 `sessionService.getTree(sid)` → `send(ws, { type: 'session.tree-data', payload })`

  `session.tree-navigate`: 调用 `sessionService.navigateTree(sid, targetEntryId)` → `send(ws, { type: 'session.tree-navigate-result', payload })`

  `session.tree-fork`: 调用 `sessionService.forkFromEntry(sid, entryId)` → `send(ws, { type: 'session.tree-fork-result', payload })` + 成功时 `broadcastSessionList()`

  `session.tree-capability`: 查询 navigate 是否可用 → `send(ws, { type: 'session.tree-capability', payload: { sessionId, navigateCapable } })`

- [ ] **Step 4: 在 event-adapter.ts 新增 navigate-result 拦截**

  **机制**：EventAdapter 当前是纯 `(pi event → WS message)` 翻译器，不支持回调注册。需要扩展为支持“拦截+路由”模式：

  1. EventAdapter 新增 `private navigateResolve: ((result: unknown) => void) | null = null` 和 `setNavigateResolver(fn)` 方法
  2. SessionService.navigateTree() 在调用 `client.prompt()` 之前，通过 EventAdapter 的 `setNavigateResolver(resolve)` 注入 resolve 函数
  3. SessionService 用 `Promise.race([navigatePromise, timeoutPromise(5000)])` 实现超时
  4. EventAdapter.translate() 在处理 text_delta 时检查 delta 文本是否以 `{"__xyz_type":"navigate-result"` 开头
  5. 如果匹配 → 调用 `navigateResolve(parsedResult)` + 清除 resolver + 不翻译为 WS 消息（吞掉）
  6. 不匹配 → 正常翻译为 `message.text_delta`
  7. 超时后 → resolve 被清除，后续到达的 navigate-result 被忽略（因为 resolver 已为 null）

  **时序安全**：resolve 只能被调用一次。setNavigateResolver 每次调用覆盖上一次，同时 pending promise 有超时兜底，不存在竞态。

  注意：实际拦截逻辑依赖 Task 1 验证脚本确认的 RPC 事件格式。

- [ ] **Step 5: Commit**

  ```
  git add src-electron/runtime/src/services/session-service.ts
  git add src-electron/runtime/src/interfaces.ts
  git add src-electron/runtime/src/server.ts
  git add src-electron/runtime/src/event-adapter.ts
  git commit -m "feat: add session tree service + WS routing + navigate interception"
  ```

---

### Task 3: pi Extension 插件 + 可用性检测

**Type:** backend

**Files:**
- Create: `xyz-agent-extension.js`

**Context 注入:**
- Spec FR6, AC6
- pi extension API: `onInit(pi)`, `pi.registerCommand(name, { description, handler })`, handler 接收 `(args, ctx)`
- `ctx.navigateTree(entryId, options)`, `ctx.sendMessage(jsonStr)`, `ctx.sessionManager.getLeafId()`
- pi 源码路径: `~/GitApp/pi-mono/packages/coding-agent/src/`

- [ ] **Step 1: 创建 xyz-agent-extension.js**

  ```javascript
  export default {
    onInit(pi) {
      pi.registerCommand("xyz-navigate", {
        description: "Navigate session tree (xyz-agent internal)",
        handler: async (args, ctx) => {
          const entryId = args.trim();
          if (!entryId) return;
          const result = await ctx.navigateTree(entryId, { summarize: false });
          ctx.sendMessage(JSON.stringify({
            __xyz_type: "navigate-result",
            cancelled: result.cancelled,
            newLeafId: ctx.sessionManager.getLeafId(),
            editorText: result.editorText,
          }));
        }
      });
    }
  };
  ```

- [ ] **Step 2: 手动测试 extension 加载**

  启动 pi 进程并传递 `--extension` 参数，确认：
  1. 无报错
  2. `get_commands` 返回的列表包含 `xyz-navigate`（source: "extension"）
  3. `/xyz-navigate test-id` 命令被正确触发

- [ ] **Step 3: Commit**

  ```
  git add xyz-agent-extension.js
  git commit -m "feat: add pi extension for xyz-navigate command"
  ```

---

### Task 4: Extension 启动集成

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/src/services/session-service.ts` (getCommands 缓存)
- Modify: `src-electron/runtime/src/process-manager.ts` (传递 extension 路径)

**Context 注入:**
- Spec AC6 (Extension 加载与可用性检测)
- process-manager.ts `createSession` 方法接受 `extensionPaths?: string[]` 参数
- session-service.ts 已在 restore session 时调用 `getCommands()` 并缓存结果

- [ ] **Step 1: 在 ProcessManager.createSession 中传递 extension 路径**

  解析 xyz-agent-extension.js 的绝对路径，作为 `extensionPaths` 参数传递给 pi 进程。

- [ ] **Step 2: 在 SessionService 缓存 extension 可用性**

  扩展现有的 `getCommands()` 调用逻辑：
  1. 检查返回的命令列表是否包含 `xyz-navigate`
  2. 缓存 `{ sessionId: boolean }` 的 navigateCapable 状态
  3. 缓存结果供 `isNavigateCapable()` 和 tree capability 查询使用

- [ ] **Step 3: Commit**

  ```
  git add src-electron/runtime/src/process-manager.ts
  git add src-electron/runtime/src/services/session-service.ts
  git commit -m "feat: integrate extension loading into session startup"
  ```

---

### Task 5: 前端 Tree Store + Composable + SessionTreePanel 组件

**Type:** frontend

**Files:**
- Create: `src-electron/renderer/src/stores/tree.ts`
- Create: `src-electron/renderer/src/composables/useTree.ts`
- Create: `src-electron/renderer/src/components/panel/SessionTreePanel.vue`

**Context 注入:**
- Spec FR2 (Tree 展示), AC2
- UI 参考: `docs/designs/views_session_tree_v2.html`
- 前端编码规范: 禁止原生 HTML、禁止 Emoji、Tailwind 类、xyz-ui 组件库
- stores/chat.ts 的 Map<sessionId, State> 分区模式
- composables/useChat.ts 的全局事件监听模式 (event-bus.on)
- PanelBar.vue 的 props/emits 接口

- [ ] **Step 1: 创建 tree store (stores/tree.ts)**

  Pinia store，按 sessionId 分区：
  - `treeSessions: Map<string, TreeSessionState>`
  - `TreeSessionState = { tree, leafId, branchCount, activePath, selectedId, filterMode, isOpen, navigateCapable }`
  - 操作方法: `setTreeData`, `selectNode`, `setFilterMode`, `togglePanel`, `setNavigateCapable`
  - 计算属性: `flatNodes` (扁平化 + 条件缩进的渲染列表)

  `flatNodes` 算法：
  1. 从 root 开始深度遍历
  2. 如果当前节点只有 0-1 个 children → 扁平追加（无缩进）
  3. 如果当前节点有 >1 个 children → 扁平追加后，每个 child 递归时增加一级 indent
  4. 输出 `FlatNode[]`，每项包含 `{ node, depth, onPath, isLeaf, hasSiblings }`

- [ ] **Step 2: 创建 useTree composable (composables/useTree.ts)**

  WS 事件监听 + 命令发送：
  - `on('session.tree-data')` → `treeStore.setTreeData(sid, payload)`
  - `on('session.tree-navigate-result')` → 处理结果，触发 chatStore 重新加载消息
  - `on('session.tree-fork-result')` → 处理结果，触发 sessionStore 更新
  - `on('session.tree-capability')` → `treeStore.setNavigateCapable(sid, payload.navigateCapable)`
  - `fetchTree(sessionId)` → `send({ type: 'session.tree-data', payload: { sessionId } })`
  - `navigate(sessionId, targetEntryId)` → `send({ type: 'session.tree-navigate', payload: { sessionId, targetEntryId } })`
  - `fork(sessionId, entryId)` → `send({ type: 'session.tree-fork', payload: { sessionId, entryId } })`
  - `requestCapability(sessionId)` → `send({ type: 'session.tree-capability', payload: { sessionId } })`

- [ ] **Step 3: 创建 SessionTreePanel.vue**

  Props: `sessionId: string`
  Emits: `navigate(entryId)`, `fork(entryId)`, `close`

  结构:
  - 顶部 toolbar: title "Session Tree" + leaf 信息 + filter 按钮
  - 中间 tree-list: 虚拟滚动列表，渲染 `flatNodes`
  - 底部 action-bar: 选中节点时显示 Navigate / Fork 按钮

  每个节点的渲染:
  - 条件缩进（depth > 0 时左侧缩进 24px * depth）
  - 类型图标: U(用户) / A(助手) / S(摘要)
  - 消息文本首行截断
  - label 标签
  - leaf 指示器（绿色脉冲点）
  - on-path 高亮 vs 非活跃灰色

- [ ] **Step 4: Commit**

  ```
  git add src-electron/renderer/src/stores/tree.ts
  git add src-electron/renderer/src/composables/useTree.ts
  git add src-electron/renderer/src/components/panel/SessionTreePanel.vue
  git commit -m "feat: add frontend tree store, composable, and panel component"
  ```

---

### Task 6: PanelBar 集成 + Navigate/Fork 操作流

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/panel/PanelBar.vue`
- Modify: `src-electron/renderer/src/composables/useChat.ts` (全局 tree 事件监听)

**Context 注入:**
- Spec FR2 (Tree 入口), FR3 (Navigate 后操作), FR4 (Fork 后操作)
- AC3 (navigate 后刷新), AC4 (fork 后 sidebar 更新)
- PanelBar.vue 现有结构: AnchorDropdown + breadcrumb + notifChips + closeButton
- useChat.ts 全局监听注册模式

- [ ] **Step 1: 在 PanelBar.vue 新增 tree trigger**

  在 breadcrumb 和 notifChips 之间插入：
  - 树形图标按钮（SVG git-branch 图标）
  - 分支数 badge（仅 branchCount > 1 时显示）
  - 点击触发 `treeStore.togglePanel(sessionId)` + `useTree().fetchTree(sessionId)`
  - SessionTreePanel 作为 PanelBar 子组件，通过 v-if="treeStore.isOpen(sessionId)" 控制显示

- [ ] **Step 2: 在 useChat.ts 注册 tree 事件监听**

  在 `createGlobalHandlers()` 中新增：
  - `session.tree-navigate-result`: 成功后触发 `chatStore.replaceMessages([], sid)` 清空 + 重新发送 `session.history` 获取最新消息 + 如果有 editorText 则设置到输入框
  - `session.tree-fork-result`: 成功后触发 sidebar 更新 + 自动切换到新 session
  - `session.tree-data`: 路由到 treeStore
  - `session.tree-capability`: 路由到 treeStore

- [ ] **Step 3: Navigate 后刷新流程**

  1. 收到 navigate-result 成功
  2. 清空当前 chatStore 分区的 completedMessages
  3. 发送 `{ type: 'session.history', payload: { sessionId } }` 重新加载消息（触发 pi get_messages，刷新当前 session 的消息列表到新 leaf 路径）
  4. 如果 editorText 非空，设置到 chat input 组件
  5. 重新发送 `{ type: 'session.tree-data', payload: { sessionId } }` 刷新树

  注意：navigate 在同一 session 内移动 leafId 指针，不创建新 session。使用 `session.history`（对应 pi 的 `get_messages`）刷新消息，而非 `session.switch`（用于切换不同 session）。

- [ ] **Step 4: Fork 后流程**

  1. 收到 fork-result 成功
  2. 触发 `sessionStore` 更新 session 列表（发送 `session.list`）
  3. 自动切换到新 session（通过 `session.switch`）
  4. 如果选中的是 user message，预填输入框

- [ ] **Step 5: Commit**

  ```
  git add src-electron/renderer/src/components/panel/PanelBar.vue
  git add src-electron/renderer/src/composables/useChat.ts
  git commit -m "feat: integrate tree panel into PanelBar + navigate/fork flows"
  ```

---

## Execution Groups

#### BG1: 后端 Tree 基础 + 服务 + Extension

**Description:** 后端全部工作——JSONL 读取、tree 服务方法、WS 路由、事件拦截、Extension 插件、Extension 启动集成。

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 10 个文件（3 create + 7 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium、reviewer: medium） |
| 注入上下文 | Task 1-4 描述、Spec FR1-FR6 + AC1-AC6 + WS 协议表、CLAUDE.md 规则 #4/#5、pi JSONL 格式 |
| 读取文件 | `src-electron/runtime/src/server.ts`, `src-electron/runtime/src/rpc-client.ts`, `src-electron/runtime/src/event-adapter.ts`, `src-electron/runtime/src/services/session-service.ts`, `src-electron/runtime/src/interfaces.ts`, `src-electron/runtime/src/types.ts`, `src-electron/shared/src/protocol.ts`, `src-electron/runtime/src/process-manager.ts` |
| 修改/创建文件 | 见 Task 1-4 的 Files 列表 |

**Execution Flow (BG1 内部):** Wave 串行派遣。

  Wave 1 (并行):
    Task 1 (JSONL 读取器 + 验证):
      1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
      2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
      3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

    Task 3 (Extension 插件):
      1. general-purpose → 创建 extension 文件
      2. general-purpose → 手动验证

  Wave 2 (依赖 Wave 1):
    Task 2 (Sidecar 服务):
      1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
      2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
      3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

    Task 4 (Extension 集成, depends on Task 3):
      1. general-purpose → 修改 process-manager + session-service
      2. general-purpose → spec 合规检查

**Dependencies:** 无外部依赖

**设计细节:** 见各 Task 描述

---

#### FG1: 前端 Tree UI + PanelBar 集成

**Description:** 前端全部工作——tree store、composable、SessionTreePanel 组件、PanelBar 集成、Navigate/Fork 操作流。

**Tasks:** Task 5, Task 6

**Files (预估):** 5 个文件（3 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: medium） |
| 注入上下文 | Task 5-6 描述、Spec FR2 + AC2-AC4、UI 设计稿路径 `docs/designs/views_session_tree_v2.html`、前端编码规范 |
| 读取文件 | `src-electron/renderer/src/stores/chat.ts`, `src-electron/renderer/src/composables/useChat.ts`, `src-electron/renderer/src/components/panel/PanelBar.vue`, `src-electron/renderer/src/components/panel/AnchorDropdown.vue`, `src-electron/shared/src/protocol.ts` |
| 修改/创建文件 | 见 Task 5-6 的 Files 列表 |

**Execution Flow (FG1 内部):** 串行派遣。

  Task 5 (Tree 组件):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能→美化
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 6 (PanelBar 集成, depends on Task 5):
    1. general-purpose (read xyz-harness-frontend-dev) → 集成实现
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1（依赖后端 WS 路由和 session-tree-reader）

**设计细节:** 见各 Task 描述
