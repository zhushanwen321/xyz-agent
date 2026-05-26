---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-25T15:30:00"
  target: "slash-commands feature (full diff: 10 files, ~550 lines changed)"
  verdict: fail
  summary: "编码评审完成，第1轮，4条MUST FIX，需修改后重审"

statistics:
  total_issues: 9
  must_fix: 4
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "src-electron/renderer/src/composables/useTree.ts:71"
    title: "session.tree-capability 字段名不匹配：前端读 capable 但后端发 navigateCapable"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "src-electron/renderer/src/composables/useChat.ts:203-215"
    title: "navigate-result 后未处理 editorText，user message 无法预填到输入框"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "src-electron/renderer/src/composables/useChat.ts:216-222"
    title: "fork-result 后未自动切换到新 session，违反 AC4"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "src-electron/runtime/src/event-adapter.ts:82-98"
    title: "navigate-result 拦截仅处理 text_delta，未覆盖 content_block_start 等事件类型"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "src-electron/runtime/src/event-adapter.ts:82-98"
    title: "navigate-result 拦截器未做 text_delta 分块缓存，JSON 跨 chunk 时无法解析"
    status: open
    raised_in_round: 1
    resolved_in_round: null

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
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "src-electron/shared/src/protocol.ts:13"
    title: "session.tree-data 列入 ClientMessageType 与 spec 单方向描述不符，但符合已有代码模式（session.history 双向）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码评审 v1

## 评审记录
- 评审时间：2026-05-25 15:30
- 评审类型：编码评审
- 评审对象：slash-commands feature，涉及 10 个文件（~550 行变更）
  - 后端：session-tree-reader.ts, event-adapter.ts, server.ts, session-service.ts, interfaces.ts, types.ts
  - 前端：tree.ts (store), useTree.ts, useChat.ts, SessionTreePanel.vue, PanelBar.vue
  - 协议：protocol.ts
  - Extension：xyz-agent-extension.js

---

## AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 说明 |
|----|------|---------|------|
| AC1 | Tree 数据读取（5 条） | ✅ | JSONL 读取、parentId 树构建、labelsById Map、leafId 获取、空文件处理均实现 |
| AC2 | Tree 展示（8 条） | ✅ | 展开/关闭面板、扁平布局、分支缩进、高亮、绿点、label、filter、操作栏均实现 |
| AC3 | Navigate（9 条） | ⚠️ | editorText 未处理、EventAdapter 拦截仅覆盖 text_delta |
| AC4 | Fork（6 条） | ⚠️ | 自动切换到新 session 未实现 |
| AC5 | Clone（2 条） | ✅ | 通过现有 RPC 处理 |
| AC6 | Extension 加载与可用性检测（4 条） | ⚠️ | navigateCapable 字段名不匹配，前端始终为 false |

---

## 检查维度

### 1. Spec 合规

#### AC1 — Tree 数据读取 ✅
`buildTreeFromFile()` 正确实现了两阶段解析（先收集 labels，再构建节点树）。Orphan 节点被提升为 root。空文件/最后一行不完整均被 try-catch 优雅处理。leafId 通过 `get_state` RPC 获取。

#### AC2 — Tree 展示 ✅
SessionTreePanel 实现了 spec 要求的全部 8 条 AC：面板展开/关闭、扁平+条件缩进、路径高亮、绿色脉冲指示器、label 标签、filter 切换、Node/Fork 操作栏。

#### AC3 — Navigate ❌（2 条 MUST FIX）
**问题 1：editorText 未处理** — 成功 navigate 后，`editorText` 被服务器返回（从 extension handler 的 `result.editorText` 传递），但 `useChat.ts` 的 `session.tree-navigate-result` 处理函数完全忽略 `msg.payload.editorText`。结果：navigate 到 user message 后，文本不会放入输入框。

**问题 2：EventAdapter 拦截脆弱** — 仅在 `text_delta` 子事件中检查前缀 `{"__xyz_type":"navigate-result"`。如果 pi 通过 `content_block_start`、`message_stop` 或其他事件类型传递结果，拦截完全失效。同时未做跨 text_delta chunk 缓冲。

#### AC4 — Fork ❌（1 条 MUST FIX）
Fork 成功后，`session.tree-fork-result` 处理函数仅调用 `send({ type: 'session.tree-data' })` 刷新数据，但未发送 `session.switch` 切换到新 session。AC4 明确要求「自动切换到新 session」。

#### AC5 — Clone ✅
Clone 通过现有 RPC `/clone` 处理，无需新增代码。

#### AC6 — Extension 加载与可用性检测 ❌（1 条 MUST FIX）
**字段名不匹配**：服务端 `session.tree-capability` 响应发送 `{ navigateCapable: boolean }`，但前端 `useTree.ts:71` 读取 `msg.payload.capable as boolean`。字段名 `capable` ≠ `navigateCapable`，导致前端始终读到 `undefined`（cast 为 `false`）。Navigate 按钮永远不显示。同时 `session.tree-data` 响应的 payload 也包含 `navigateCapable`，但 `onTreeData` 只读取 `tree` 和 `leafId`，未提取 `navigateCapable`。

---

### 2. 代码质量

**可读性**：整体良好。函数命名清晰（`buildTreeFromFile`、`computeActivePath`、`flattenTree`），「为什么」有注释（如 flattenTree 算法注释）。`session-tree-reader.ts` 的 JSDoc 完整。

**错误处理**：
- JSONL 读取有 try-catch 跳过格式错误行 ✅
- navigate 有 5s 超时 ✅
- fork 检查 `success` 字段 ✅
- 但：`session-service.ts` navigate 中 `client.prompt()` 的 `.catch()` 处理异常，但若有 `.then()` 路径无人消费 ✅（Promise 结果通过 adapter resolver 回传，不通过 prompt return value）

**边界条件**：
- 空文件处理 ✅
- navigate 到当前 leaf (no-op) ✅
- orphan 节点处理 ✅
- 已过滤节点的 children 仍需遍历（filter mode） ✅

---

### 3. 架构合规

**分层正确性**：
- Sidecar 直接读取 JSONL 文件（非 pi RPC），与 spec FR1 一致 ✅
- EventAdapter 是 pi 协议适配点，navigate-result 拦截在这里做 ✅
- 前端 store 使用 `Map<sessionId, TreeSessionState>` 分区模式，与 chatStore 一致 ✅

**依赖方向**：
- 前端不直接访问后端 `session-tree-reader.ts` ✅
- WS 协议扩展在 `protocol.ts` 和 `server.ts` 中 ✅

**CLAUDE.md 规则遵守**：
- emit 传单 payload → 无触发场景（新增代码中无 emit 调用） ✅
- Event bus listener 防重复 → `useTree.ts` 使用 `globalEventMap` 保护 ✅
- pi 适配层不信任外部格式 → 拦截器有 try-catch ✅
- Session 隔离 → 所有消息提取 sessionId 分区 ✅

---

### 4. 安全和性能

**安全**：
- 无注入风险 — 所有类型由 protocol 约束 ✅
- JSONL 读取使用 `readFileSync`（同步，single session 场景可接受） ✅
- 不需要检查的输入验证（entryId 为内部 ID） ✅

**性能**：
- 树构建为全量 O(n)，n 为 JSONL 行数（通常 < 10^4） ✅
- `flattenTree` 和 `buildPathToRoot` 每次 `getFlatNodes` 调用时重新计算 → 小规模数据 OK ✅
- 虚拟滚动未实现 → 树节点较多（>500）时可能卡顿，但首版可接受 ✅

---

### 5. 集成验证

**Hook/Event 组件调用链**：

Navigate 完整链路：
```
前端 send('session.tree-navigate')
  → server.ts 'session.tree-navigate' handler
    → sessionService.navigateTree()
      → setNavigateResolver()
      → client.prompt('/xyz-navigate <id>')
        → pi extension handler
          → ctx.navigateTree()
          → ctx.sendMessage() → events
      ← EventAdapter.translate() intercepts text_delta
      ← resolve NavigateResult
  → server sends 'session.tree-navigate-result'
  → useChat.ts handler → send('session.history') + send('session.tree-data')
```

验证：前三段路径明确，但 EventAdapter 拦截环节依赖 pi 事件格式，未验证。

**数据字段消费者追踪**：
- `navigateCapable` 字段（boolean）：由服务端 `session.tree-data` 和 `session.tree-capability` 两个路径发送 → 前端 `useTree.ts` 的 `onTreeCapability` 消费（但字段名不匹配）→ `SessionTreePanel.vue` 通过 `sessionState.navigateCapable` 控制按钮可见性
- `editorText` 字段（string）：由服务端 `session.tree-navigate-result` payload 携带 → 前端无消费者

---

### 6. Hook 组件专项检查

**EventAdapter navigate-result 拦截**：

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 注册目标 | ✅ | EventAdapter.translate() 方法中，由 `handleEvent` 统一分发 |
| 注册点是否被 emit/trigger | ✅ | pi 事件通过 `client.onEvent` 连接到 `handleEvent` |
| 执行结果传递路径 | ✅ | 通过 `navigateResolve` 回调 → `navigateTree` Promise → WS response |
| 执行时序 | ⚠️ | 见 MUST FIX #4 — 仅 text_delta 类型，缺少跨 chunk 缓冲 |

---

### 7. 数据流合规

Spec 数据流图（Navigate）：
```
前端 WS → sidecar → RPC prompt → pi extension → navigateTree →
sendMessage() → RPC events → EventAdapter 拦截 → WS response → 前端
```

对照消费者验证：
- `newLeafId` → 前端未显式使用（通过重新获取 tree 数据间接消费）✅
- `editorText` → 前端未消费 ❌ MUST FIX
- `cancelled` → 前端通过 `!result.cancelled` 判断 success ❌ 但前端 handler 只检查 `msg.payload.success`（来自 NavigateResult），不直接检查 `cancelled`

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | `src-electron/renderer/src/composables/useTree.ts:71` | `onTreeCapability` 读取 `msg.payload.capable`，但服务端发送字段名为 `navigateCapable`。前端始终读到 undefined → cast false → Navigate 按钮永不可见。同时 `onTreeData` 也未提取 tree-data 响应中的 `navigateCapable`。 | 将 `msg.payload.capable` 改为 `msg.payload.navigateCapable`，并在 `onTreeData` 中也提取 `navigateCapable` 写入 store |
| 2 | **MUST FIX** | `src-electron/renderer/src/composables/useChat.ts:203-215` | `session.tree-navigate-result` 处理函数未读取 `msg.payload.editorText`。Navigate 到 user message 后，文本不会放入输入框。 | 读取 `editorText`，若非空则通过 input store 或 composable 设置到 chat input 组件 |
| 3 | **MUST FIX** | `src-electron/renderer/src/composables/useChat.ts:216-222` | Fork 成功后未自动切换到新 session。AC4 要求「自动切换到新 session」。当前仅刷新 tree 数据。 | 从 `msg.payload.newSessionId` 读取新 session ID，发送 `{ type: 'session.switch', payload: { sessionId: newSessionId } }` |
| 4 | **MUST FIX** | `src-electron/runtime/src/event-adapter.ts:82-98` | navigate-result 拦截只检查 `text_delta` 子事件。若 pi 通过其他事件类型（如 `content_block_start`、`message_stop`）传递 `ctx.sendMessage()` 输出，拦截完全失效。 | 扩展拦截点至 `message_stop`（检查完整 message content）或 `content_block_delta` 的所有变体。Task 1 验证脚本应确认实际事件格式 |
| 5 | LOW | `src-electron/runtime/src/event-adapter.ts:82-98` | 未做跨 text_delta chunk 缓冲。若 pi 将 JSON 串拆成多个 text_delta（如 `{"__x` + `yz_type":...}`），两侧 chunk 均无法匹配前缀或解析。 | 添加字符串缓冲，累计 text_delta 内容直到完整 JSON 可解析或收到 message_stop |
| 6 | LOW | `src-electron/renderer/src/components/panel/SessionTreePanel.vue` | scoped CSS 使用硬编码 rgba 值：`rgba(255, 255, 255, 0.025)`、`rgba(0, 245, 212, 0.03)`、`rgba(0, 245, 212, 0.05)`、`rgba(0, 245, 212, 0.4)`。违反「禁止硬编码颜色」规范。 | 用 CSS 变量替换：`var(--surface-light)`、`var(--success)` 等 |
| 7 | LOW | `src-electron/runtime/src/interfaces.ts:107` | `ISessionService` 未声明 plan 中的 `cloneSession` 方法。Clone 功能依赖现有 RPC 通道，无新增 WS handler，但接口层缺失声明。 | 添加 `cloneSession(sessionId: string): Promise<{ success: boolean; newSessionId?: string; error?: string }>` 声明 |
| 8 | INFO | `src-electron/renderer/src/components/panel/PanelBar.vue:125` | 使用原生 `<button>` 元素，注释标注了 `eslint-disable`。与现有 panel-close 按钮一致。 | 无操作需处理 |
| 9 | INFO | `src-electron/shared/src/protocol.ts:13` | `session.tree-data` 列入 ClientMessageType 与 spec 的描述「sidecar→前端」不完全一致，但符合代码库已有模式（`session.history`、`session.list` 均为双向类型）。 | 无操作需处理 |

---

## 问题详情

### MUST FIX #1: navigateCapable 字段名不匹配

**现象**：
- 服务端 `session.tree-capability` 响应 payload：`{ sessionId, navigateCapable: boolean }`
- 服务端 `session.tree-data` 响应 payload 也包含 `navigateCapable`
- 前端 `useTree.ts:71`：`const capable = msg.payload.capable as boolean`
- 前端 `useTree.ts:49-51`：`onTreeData` 只读取 `tree` 和 `leafId`，未提取 `navigateCapable`

**影响**：`navigateCapable` 在前端始终解析为 `false`，`Navigate here` 按钮永不显示。这是最严重的问题，因为它导致 AC3（Navigate）功能在前端完全被屏蔽。

**修改方向**：
1. `onTreeCapability`：`msg.payload.capable` → `msg.payload.navigateCapable`
2. `onTreeData`：额外提取 `msg.payload.navigateCapable` 并调用 `store.setNavigateCapable(sid, capable)`
3. `session-service.ts` 已验证 `navigateCapable` 查询逻辑正确

### MUST FIX #2: editorText 未处理

**影响**：Navigate 到 user message 后，AC 要求的「文本放入输入框」未实现。属于功能不完整。

**修改方向**：参考 plan Task 6 Step 3 的设计：
- 从 `msg.payload.editorText` 提取文本
- 调用提供的方法设置 chat input 组件的内容（需要确认该方法的接口）

### MUST FIX #3: Fork 后未自动切换

**影响**：新 session 出现在 sidebar 但用户仍停留在旧 session。AC4 明确要求「自动切换到新 session」。

**修改方向**：读取 `msg.payload.newSessionId`，调用 `send({ type: 'session.switch', payload: { sessionId: newSessionId } })`

### MUST FIX #4: EventAdapter 拦截仅覆盖 text_delta

**影响**：Navigate 结果回传依赖 RPC 事件流中的 `text_delta` 事件类型。如果 pi 通过 `content_block_start`（直接携带 content）或 `message_stop`（携带最终内容）传递 `ctx.sendMessage()` 的输出，拦截完全失效，navigate 结果永远不会回到前端 Promise 链。

**风险等级**：由于 Task 1 验证脚本的执行结果不可见，无法确认实际事件格式。拦截器只在 `text_delta` 中检查，且无 fallback 路径。生产中若 pi 内部实现变化（如 sendMessage 的 emit 路径改变），功能静默失效。

**修改方向**：增加 `message_stop` 事件中的 content 检测作为 fallback，或扩展拦截到所有 `content_block_*` 事件类型。最好在已知的事件类型上做双重检查。

---

## 结论

需修改后重审。**4 条 MUST FIX** 中有 1 条极为关键（字段名不匹配，导致 AC6 功能完全不可用），其余 3 条为功能缺失。LOW 级别问题不影响功能但不满足编码规范。

### Summary

编码评审完成，第1轮，4条MUST FIX，需修改后重审。
