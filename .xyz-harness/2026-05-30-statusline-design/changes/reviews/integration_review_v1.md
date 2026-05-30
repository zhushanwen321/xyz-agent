---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T19:30:00"
  target: "feat-statusline full diff (54f68e6..HEAD) — integration review"
  verdict: fail
  summary: "集成审查完成，第1轮，4条MUST FIX，需修改后重审"

statistics:
  total_issues: 10
  must_fix: 4
  must_fix_resolved: 0
  low: 3
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "resources/plugins/statusline/index.ts:L53"
    title: "Statusline plugin 清除逻辑断裂——空 text 时跳过 updateStatusBarItem，chip 永远不消失"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/layout/AppStatusbar.vue:L30; src-electron/renderer/src/components/chat/SessionStrip.vue:L46"
    title: "Branch 同时出现在 SessionStrip 和 AppStatusbar——违反 AC-5 信息不重复"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L76-80"
    title: "Thinking level picker 可见但 emit 被注释——用户选级别无任何效果"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "src-electron/renderer/src/composables/useChat.ts:L164-166; src-electron/renderer/src/components/chat/InputToolbar.vue:L112"
    title: "↓ output tokens 实际显示 totalTokens——语义数据不匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "src-electron/shared/src/protocol.ts:L167"
    title: "plugin:statusSetUpdate 注册在 ServerMessageType 但从未作为 WS 消息发送——仅为内部 hook 事件名"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "src-electron/renderer/src/components/layout/AppStatusbar.vue:L19"
    title: "PI_VERSION 硬编码常量——pi 升级后需手动同步"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "resources/plugins/statusline/index.ts:L53; docs/plugin/built-in-plugin-guide.md §5.2"
    title: "Plugin guide 文档错误——声称"不要发送空字符串给 updateStatusBarItem"，但 plugin-service 的 empty-text 路径正是 chip 清除机制"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "src-electron/runtime/src/server.ts:L719"
    title: "bridge:event handler 中 data.data as Record<string, unknown> ?? {} — ?? 在 as 断言后永远不触发（运行时正确但代码意图不清晰）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "src-electron/renderer/src/composables/useChat.ts:L164-166"
    title: "setTokenUsage 每次 message.complete 覆盖（非累加）——显示的是最后一条消息的 totalTokens 而非会话累计"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "src-electron/renderer/src/types/plugin.ts:PluginStatusItem vs src-electron/shared/src/protocol.ts:StatusBarItem"
    title: "两个结构相同的类型（PluginStatusItem / StatusBarItem）分处不同文件——使用 as 断言桥接，类型安全依赖结构一致性"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# 集成审查 v1

## 评审记录
- 评审时间：2026-05-30 19:30
- 评审类型：编码评审（集成审查专项）
- 评审对象：feat-statusline 全量 diff (54f68e6..HEAD)，23 files changed, +2245/-94
- 评审重点：前后端接口对齐、数据流完整性、跨组件通信、BLR 问题修复验证、typecheck

---

## 1. Typecheck 验证

| 检查项 | 结果 |
|--------|------|
| `src-electron/` tsc --noEmit | ✅ 通过 (exit 0) |
| `src-electron/renderer/` vue-tsc --noEmit | ✅ 通过 (exit 0) |

**结论**：TypeScript 编译零错误。

---

## 2. 前后端接口对齐

### 2.1 protocol.ts 类型对齐

| 类型 | protocol.ts (共享) | plugin-types.ts (runtime) | types/plugin.ts (前端) | 对齐状态 |
|------|-------|-------|-------|---------|
| StatusBarItem | `{ id, pluginId, text, tooltip?, commandId?, priority, scope, sessionId? }` | — | PluginStatusItem: 结构相同 | ✅ |
| StatusBarItemOptions | — | `{ tooltip?, commandId?, priority?, scope?, sessionId? }` | — | ✅ |
| PluginStatusBarUpdatePayload | `{ items: StatusBarItem[] }` | — | 前端 `as` 断言消费 | ✅ |
| StatusSetUpdatePayload | `{ sessionId, key, text }` | — | 内部使用，不直接消费 | ✅ |

### 2.2 WS 消息类型注册

新增 `plugin:statusSetUpdate` 注册在 `ServerMessageType` 联合类型中，但**从未作为 WS 消息广播到前端**。该类型名仅在 plugin hooks 系统内部使用（`handleBridgeEvent('plugin:statusSetUpdate', ...)` → `executeHooks` → Worker RPC）。前端不会收到此消息类型。

**影响**：无功能错误，但误导开发者以为有新的 WS 消息通道。建议移除或添加注释说明。（Issue #5, LOW）

### 2.3 plugin-service 构造的 StatusBarItem 对齐

plugin-service.ts `updateStatusBarItem` handler 正确构造 StatusBarItem：

```typescript
const item: StatusBarItem = {
  id, pluginId, text,
  tooltip: options?.tooltip,
  commandId: options?.commandId,
  priority: options?.priority ?? 100,
  scope: options?.scope ?? 'global',
  sessionId: options?.sessionId,
}
```

与 protocol.ts 的 `StatusBarItem` 接口完全匹配。✅

---

## 3. 数据流完整性验证

### 3.1 UC-1: pi extension setStatus → 前端 chip

| 步骤 | 路径点 | 验证结果 |
|------|--------|---------|
| 1 | pi extension: `ctx.ui.setStatus("goal", "◆ 3/20")` | ✅ 触发 extension_ui_request |
| 2 | event-adapter.ts:L210: `method === 'setStatus'` | ✅ 正确捕获 |
| 3 | `String(event.text ?? '')` 转换 | ✅ undefined/null → '' |
| 4 | `options.onStatusSetUpdate` 回调 | ✅ 传递 `{ sessionId, key, text }` |
| 5 | index.ts → `server.handleStatusSetUpdate()` | ✅ 路由到 pluginService |
| 6 | server.ts:L757 → `pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, sessionId)` | ✅ |
| 7 | plugin-service → `executeHooks('plugin:statusSetUpdate', context)` | ✅ |
| 8 | Worker RPC invoke → statusline plugin handler | ✅ |
| 9 | plugin 提取 key/text, 查映射表, 调用 `api.ui.updateStatusBarItem` | ✅ |
| 10 | plugin-service Map 更新 + broadcastStatusBarItems | ✅ |
| 11 | WS `plugin:statusBarUpdate` → 前端 pluginStore.setStatusBarItems | ✅ |
| 12 | SessionStrip: `getSessionStatusBarItems(sessionId)` 过滤 | ✅ |

**❌ Issue #1**: 当 pi extension 调用 `setStatus("goal", undefined)` 清除状态时：
- event-adapter 正确将 undefined 转为 `text: ''`
- statusline plugin 的 `if (text === '') return` 直接返回
- **从不调用** `api.ui.updateStatusBarItem('pi-goal', '')` 清除
- plugin-service Map 中的旧 chip 条目永远不被删除
- **UC-1 验收失败**："goal 完成后 chip 自动消失"

**根因**：plugin 的 `if (text === '') return` 跳过了清除路径。plugin-service 的 `text === ''` 删除逻辑（L418-419）设计上是正确的清除机制，但 plugin 从未触发它。

**修复方向**：空 text 时调用 `api.ui.updateStatusBarItem('pi-goal', '')` 让 plugin-service 执行删除，而非跳过。

### 3.2 UC-2: Split panel scope 路由

| 路由点 | 验证结果 |
|--------|---------|
| statusline plugin 附加 scope + sessionId | ✅ per-session key 正确传 sessionId |
| plugin-service StatusBarItem 包含 scope + sessionId | ✅ |
| pluginStore.getSessionStatusBarItems(sessionId) 过滤 | ✅ `scope === 'per-session' && item.sessionId === sessionId` |
| pluginStore.globalStatusBarItems 过滤 | ✅ `scope === 'global'` |
| SessionStrip 使用 getSessionStatusBarItems | ✅ |
| AppStatusbar 使用 globalStatusBarItems | ✅ |

**✅ UC-2 scope 路由逻辑正确。**

### 3.3 UC-3: 模型切换 + Thinking Level

| 路径点 | 验证结果 |
|--------|---------|
| ModelPicker → emit select-model | ✅ |
| ChatInput → emit select-model | ✅ |
| ChatPanel → PanelSessionView → handleSelectModel | ✅ |
| switchModel → server model.switch → pi RPC | ✅ |
| ThinkingLevel picker → pickThinking | ⚠️ emit 已注释 |

**❌ Issue #3**: `pickThinking` 中 `emit('select-thinking-level', level)` 被注释。虽然后续链路（ChatInput → PanelSessionView → handleSendCommand → WS send → server）完整接线，但：
- server.ts 无 `session.setThinkingLevel` 处理 case
- protocol.ts `ClientMessageType` 无此类型
- 消息会落入 `unknown_type` 分支

当前状态：picker 可见但完全无效。应隐藏 picker 或实现完整路径。

### 3.4 Context 数据流

| 数据流 | 验证结果 |
|--------|---------|
| event-adapter agent_end → onContextUpdate callback | ✅ 计算 usagePercent |
| index.ts → server.broadcast `context.update` | ✅ 包含 usagePercent, inputTokens, contextLimit |
| useChat onContextUpdate → store.updateContextInfo | ✅ |
| InputToolbar contextUsagePercent → context bar | ✅ 三档颜色正确 |
| InputToolbar contextInputTokens → ↑ 显示 | ✅ |

**❌ Issue #4**: `↓` 标签显示 `tokenUsage`，但：
- `message.complete` handler 提取 `usage.totalTokens`（非 `outputTokens`）
- `store.setTokenUsage(totalTokens, sid)` 每次覆盖非累加
- `↓` 语义上是 output tokens，实际是最后一条消息的 totalTokens

### 3.5 bridge:event 修复验证

```
server.ts bridge:event case:
  eventData = data.data as Record<string, unknown> ?? {}
  pluginService.handleBridgeEvent(eventName, eventData, sessionId)
```

✅ 正确调用 `handleBridgeEvent`，不再只打日志。pi 生命周期事件（agent_start/agent_end/tool_call 等）现在能触发 plugin hooks。

---

## 4. 跨组件通信验证

### 4.1 InputToolbar ↔ ChatInput

| 通信方向 | 数据/事件 | 验证 |
|----------|-----------|------|
| ChatInput → InputToolbar | props: sessionId, isStreaming, canSend | ✅ |
| InputToolbar → ChatInput | emit: select-model, select-thinking-level, send, cancel | ✅ (thinking-level emit 被注释) |
| ChatInput → PanelSessionView | emit: select-model, send-command, send, cancel | ✅ |

### 4.2 ChatInput ↔ SessionStrip

| 通信方向 | 数据 | 验证 |
|----------|------|------|
| ChatInput → SessionStrip | prop: sessionId | ✅ |
| SessionStrip → pluginStore | getSessionStatusBarItems(sessionId) | ✅ |
| SessionStrip → sessionStore | sessions.find → branchName | ✅ |

### 4.3 AppStatusbar 独立消费

| 数据源 | 数据 | 验证 |
|--------|------|------|
| ws-client | connState (连接状态) | ✅ |
| sessionStore | branchName (focused panel session) | ⚠️ |
| pluginStore | globalStatusBarItems | ✅ |

**❌ Issue #2**: AppStatusbar 计算了 `branchName` 并渲染。而 SessionStrip 也计算并渲染 branchName。branch 同时出现在两个组件中。

spec FR-4: Session Strip 显示 branch + extension chips
spec FR-5: Global Statusbar 显示 连接状态 + pi 版本 + global chips（**无 branch**）

**修复方向**：从 AppStatusbar 移除 branchName 逻辑和渲染。

---

## 5. BLR 问题修复验证

| BLR # | BLR 描述 | BLR 诊断 | 集成审查结论 | 状态 |
|-------|---------|---------|-------------|------|
| 1 | setStatus(key, undefined) → chip 显示 "undefined" | `String(undefined)` = `"undefined"` | **BLR 诊断有误**：代码用 `String(event.text ?? '')` 正确处理 undefined→''。但**清除逻辑确实断裂**：plugin 的 `if (text === '') return` 跳过了调用 updateStatusBarItem，chip 无法被移除。BLR 对了症状（清除失效），错了病因。 | **仍为 MUST FIX（不同根因）→ Issue #1** |
| 2 | session.setThinkingLevel WS 命令无服务端处理 | 前端发出但服务端返回 unknown_type | **部分确认**：InputToolbar 已将 emit 注释掉，命令不会发出。但 server handler 确实缺失。功能完全不可用。 | **仍为 MUST FIX → Issue #3** |
| 3 | outputTokens 始终为 0 | setTokenUsage 从未被调用 | **BLR 诊断有误**：diff 已在 `onComplete` 中添加 `store.setTokenUsage(usage.totalTokens, sid)` 调用。值不再为 0。但语义错误：用的是 `totalTokens` 而非 `outputTokens`。 | **仍为 MUST FIX（不同根因）→ Issue #4** |
| 4 | Branch 位置错误——SessionStrip 没有 branch | 完全缺失 | **BLR 诊断有误**：SessionStrip **已有** branch 显示（L46）。但 AppStatusbar **也**有 branch 显示，违反 AC-5。 | **仍为 MUST FIX（不同根因）→ Issue #2** |
| 5 | AppStatusbar 缺少 pi 版本号 | FR-5 要求显示 | **BLR 诊断有误**：代码已添加 `PI_VERSION = '0.75.5-xyz-0.1'` + `pi {{ PI_VERSION }}` 渲染。 | **已修复 ✅** |
| 6 | setThinkingLevel agent RPC handler 空函数 | — | 确认 LOW。不影响当前路径。 | LOW（保留）|
| 7 | onContextUpdate 内联实现 | — | 确认 LOW。 | LOW（保留）|
| 8 | THINKING_BAR_HEIGHTS 硬编码 | — | 确认 INFO。 | INFO（保留）|
| 9 | 清除逻辑双重防护 | — | 需修正：当前**没有**双重防护，plugin 的 guard 阻止了清除路径。 | 合并到 Issue #1 |

---

## 6. spec 合规验证矩阵

| AC | 描述 | 状态 | 集成验证 |
|----|------|------|---------|
| AC-1 | setStatus 到达前端 | ❌ | Issue #1: 清除路径断裂 |
| AC-2 | Input Toolbar 完整功能 | ❌ | Issue #3: thinking level 不可用; Issue #4: token 语义错误 |
| AC-3 | Session Strip 信息展示 | ⚠️ | branch ✅, chips ✅, 但 branch 也在 AppStatusbar 重复 (Issue #2) |
| AC-4 | Global Statusbar 聚合 | ❌ | Issue #2: branch 不应在此; pi 版本 ✅ |
| AC-5 | 信息不重复 | ❌ | Issue #2: branch 重复 |
| AC-6 | statusBarUpdate 增强 | ✅ | optional 参数、Map 管理、向后兼容均正确 |
| AC-7 | Built-in Plugin 开发指南 | ⚠️ | Issue #7: guide §5.2 关于空文本的指导与实际 API 行为矛盾 |
| AC-8 | bridge:event 修复 | ✅ | 正确调用 handleBridgeEvent |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | resources/plugins/statusline/index.ts:L53 | 空 text 时 `return` 跳过 updateStatusBarItem 调用，plugin-service Map 中旧 chip 永远不被删除。UC-1 "goal完成后chip消失" 失败 | 删除 `if (text === '') return` guard，让空 text 进入 `api.ui.updateStatusBarItem('pi-${key}', '')`，由 plugin-service 的 `text === ''` 分支执行 Map.delete。同时修正 guide §5.2 |
| 2 | MUST FIX | AppStatusbar.vue:L30 (branchName computed); SessionStrip.vue:L46 | branch 同时出现在 SessionStrip 和 AppStatusbar，违反 FR-5（AppStatusbar 只应有 连接状态 + pi版本 + global chips）和 AC-5 | 从 AppStatusbar 移除 branchName computed 和 `<span v-if="branchName">` 渲染 |
| 3 | MUST FIX | InputToolbar.vue:L76-80 | `emit('select-thinking-level', level)` 被注释，picker 可见但选级别无效果。应隐藏 picker 或实现完整路径 | 方案A：隐藏 picker（`v-if="showThinkingPicker && false"` 或移除 thinking 相关代码）直到 server handler 就绪。方案B：在 server.ts 添加 `session.setThinkingLevel` case + protocol.ts 注册类型 |
| 4 | MUST FIX | useChat.ts:L164-166; InputToolbar.vue:L112 | `onComplete` 存 `usage.totalTokens`，InputToolbar 标签为 `↓`（output 语义）。`totalTokens = input + output`，不是 output | 提取 `usage.outputTokens`（如果 pi 返回此字段）或改标签为 `↕` / `Σ` 表示 total。同时检查 pi usage 结构确认字段名 |
| 5 | LOW | protocol.ts:L167 | `plugin:statusSetUpdate` 在 ServerMessageType 联合类型中，但从不作为 WS 消息广播到前端 | 移除该条目或添加 `// internal hook event name, not a WS message type` 注释 |
| 6 | LOW | AppStatusbar.vue:L19 | `PI_VERSION = '0.75.5-xyz-0.1'` 硬编码，pi 升级后需手动更新 | 从 configService 或 package.json 读取，或从 pi 的 `get_state` 响应中提取版本号 |
| 7 | LOW | built-in-plugin-guide.md §5.2 | 文档声称"不要发送空字符串给 updateStatusBarItem"，但 plugin-service 的 empty-text 路径（`if (text === '') { delete }`)正是唯一的 chip 清除机制 | 修正文档：空 text 是清除机制的一部分，应发送而非跳过 |
| 8 | INFO | server.ts:L719 | `(data.data as Record<string, unknown>) ?? {}` — as 断言后 ?? 永远不触发 | 改为 `data.data as Record<string, unknown> \| undefined ?? {}` 或 `(data.data ?? {}) as Record<string, unknown>` |
| 9 | INFO | useChat.ts:L164-166 | `setTokenUsage(totalTokens, sid)` 每次 message.complete 覆盖而非累加 | 如需会话累计 token，应在 store 中累加。当前行为：显示最后一条消息的 token |
| 10 | INFO | types/plugin.ts vs protocol.ts | `PluginStatusItem` 和 `StatusBarItem` 结构完全相同但分处两文件，靠 `as` 断言桥接 | 考虑统一为 `StatusBarItem`（从 shared 包导入）或建立 type alias |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 7. 架构合规

| 检查项 | 结果 |
|--------|------|
| WS 命名约定（Server→Client 冒号格式） | ✅ plugin:statusBarUpdate, plugin:statusSetUpdate |
| 唯一前端通道 | ✅ 前端只监听 plugin:statusBarUpdate |
| Plugin 封装层 | ✅ statusline plugin 正确适配 setStatus → statusBarUpdate |
| Session 隔离（所有消息带 sessionId） | ✅ handleStatusSetUpdate、broadcastStatusBarItems 均包含 |
| 分层正确（不跨层调用） | ✅ event-adapter → server → plugin-service 分层清晰 |
| emit 单参数对象 | ✅ 所有 emit 使用 payload 对象 |
| event-bus refCount 保护 | ✅ usePlugin 使用 _refCount 模式 |
| 禁止 any | ✅ 未发现 any 使用 |
| 禁止原生 HTML 表单元素 | ✅ 使用 xyz-ui Button 组件 |
| 组件行数限制 | ✅ InputToolbar.vue 226 行, SessionStrip.vue 68 行, AppStatusbar.vue 92 行 |

---

## 结论

需修改后重审。

### Summary

集成审查完成，第1轮，4条MUST FIX（statusline plugin 清除路径断裂、branch 重复显示、thinking level 不可用、outputTokens 语义错误），3条 LOW，3条 INFO。typecheck 通过。BLR 中 3 条 MUST FIX 的根因诊断有误但症状确实存在（均已映射到本轮 Issue #1-#4），BLR #5（pi 版本缺失）已修复。
