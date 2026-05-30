---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-30T18:00:00"
  target: "feat-statusline full diff (54f68e6..HEAD)"
  verdict: fail
  summary: "业务逻辑审查完成，第1轮，5条MUST FIX，需修改后重审"

statistics:
  total_issues: 9
  must_fix: 5
  must_fix_resolved: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "resources/plugins/statusline/index.ts:L51"
    title: "setStatus(key, undefined) 清除逻辑失效——显示文本 'undefined'"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L17; src-electron/runtime/src/server.ts:L417"
    title: "session.setThinkingLevel WS 命令无服务端处理——前端发出但服务端返回 unknown_type 错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L112"
    title: "outputTokens 始终为 0——tokenUsage 从未被设置，↓0 永远显示"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/chat/SessionStrip.vue; src-electron/renderer/src/components/chat/InputToolbar.vue:L121-218; src-electron/renderer/src/components/layout/AppStatusbar.vue:L20-66"
    title: "Branch 显示位置错误——spec 要求 SessionStrip 显示 branch，实际放在 InputToolbar + AppStatusbar"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "src-electron/renderer/src/components/layout/AppStatusbar.vue"
    title: "AppStatusbar 缺少 pi 版本号——spec FR-5 要求左侧显示连接状态 + pi 版本"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "src-electron/runtime/src/services/plugin-service/api/agent-api.ts:L440"
    title: "setThinkingLevel agent RPC handler 是空函数——plugin 调用也不会生效"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "src-electron/runtime/src/index.ts:L64-88"
    title: "onContextUpdate 回调在 index.ts 中内联实现（~25行），逻辑应提取到独立方法"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "src-electron/renderer/src/components/chat/InputToolbar.vue:L50-70"
    title: "THINKING_BAR_HEIGHTS 硬编码了特定 level 名称（off/minimal/low/medium/high/xhigh），与 spec '不硬编码枚举' 的要求有轻微冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "resources/plugins/statusline/index.ts:L51-53"
    title: "statusline plugin 的 text==='' 清除逻辑与 plugin-service 的 empty-text-remove 逻辑重复"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 业务逻辑编码评审 v1

## 评审记录
- 评审时间：2026-05-30 18:00
- 评审类型：编码评审（业务逻辑专项）
- 评审对象：feat-statusline 全量 diff (54f68e6..HEAD)，17 files changed, +1327/-94

## UC 覆盖验证

### UC-1: 用户在 goal 模式下实时查看任务进度

**数据流路径验证**：

| 步骤 | 路径点 | 验证结果 |
|------|--------|---------|
| pi goal extension → ctx.ui.setStatus("goal", "◆ Goal 1/20") | pi 进程内 | ✅ 不在本次修改范围 |
| RPC extension_ui_request { method: "setStatus" } | event-adapter.ts:L210-216 | ✅ 正确翻译为 onStatusSetUpdate 回调 |
| event-adapter → server.handleStatusSetUpdate() | server.ts:L752-757 | ✅ 路由到 pluginService.handleBridgeEvent |
| pluginService.handleBridgeEvent('plugin:statusSetUpdate', payload, sessionId) | plugin-service.ts:L589-597 | ✅ 调用 executeHooks |
| executeHooks → hookRegistry lookup → Worker RPC invoke | plugin-service.ts:L474-500 | ✅ 找到 statusline plugin 的 handler |
| statusline plugin handler 收到 data | index.ts:L46-69 | ✅ 正确解构 bridgeData.data |
| 查映射表 + updateStatusBarItem | index.ts:L55-67 | ✅ 使用 pi-key 前缀，附加 metadata |
| plugin-service 广播 plugin:statusBarUpdate | plugin-service.ts:L410-426 | ✅ Map 注册式管理，变更后广播 |
| 前端 pluginStore.setStatusBarItems | usePlugin.ts:L51-53 | ✅ 替换 items |
| SessionStrip 按 sessionId 过滤显示 | SessionStrip.vue:L12-14 + plugin.ts:L73-76 | ✅ getSessionStatusBarItems 正确过滤 |

**❌ 发现问题 #1**：goal 完成后 pi extension 调用 `setStatus("goal", undefined)` 清除状态。event-adapter 将 `event.text`（undefined）通过 `String(undefined)` 转换，得到字符串 `"undefined"`（不是空字符串）。statusline plugin 的 `text === ''` 检查不匹配，会向 statusbar 写入显示文本为 `"undefined"` 的 chip。根据 UC-1 步骤 11 "goal 完成后 chip 消失" 的要求，此路径失败。

**修复方向**：event-adapter 应区分 `undefined`/`null`（清除）和实际文本。或在 statusline plugin 中增加对 `text === 'undefined'` 的过滤。建议在 event-adapter 中将 `text` 为 `undefined`/`null` 时转为空字符串。

### UC-2: 用户在 split panel 时区分不同 session 状态

**scope 路由逻辑验证**：

| 路由点 | 验证结果 |
|--------|---------|
| statusline plugin 附加 scope=per-session + sessionId | ✅ index.ts:L65 正确传递 |
| plugin-service StatusBarItem 包含 scope + sessionId | ✅ plugin-service.ts:L424-425 |
| 前端 PluginStatusItem 类型包含 scope + sessionId | ✅ types/plugin.ts:L16-17 |
| pluginStore.getSessionStatusBarItems(sessionId) 过滤 | ✅ plugin.ts:L74-76 正确过滤 per-session + sessionId 匹配 |
| pluginStore.globalStatusBarItems 过滤 | ✅ plugin.ts:L71-73 正确过滤 scope===global |
| SessionStrip 使用 getSessionStatusBarItems | ✅ SessionStrip.vue:L12-14 |
| AppStatusbar 使用 globalStatusBarItems | ✅ AppStatusbar.vue:L23 |

**✅ UC-2 的 scope 路由逻辑正确实现。**

### UC-3: 用户切换模型和思考级别

**模型切换逻辑验证**：

| 路径点 | 验证结果 |
|--------|---------|
| ModelPicker 显示当前 modelId | ✅ InputToolbar.vue:L28 + ModelPicker.vue |
| 用户选择新 model → emit select-model | ✅ InputToolbar:L147 |
| ChatInput → emit select-model | ✅ ChatInput.vue:L50 |
| ChatPanel → emit select-model | ✅ ChatPanel.vue:L88 |
| PanelSessionView handleSelectModel | ✅ PanelSessionView.vue:L132-138 |
| settingsStore.defaultModel 更新 | ✅ PanelSessionView.vue:L137 |
| switchModel(sessionId, providerId, modelId) | ✅ useModel.ts:L8 |
| server model.switch handler | ✅ server.ts:L515-520 |
| sessionService.switchModel → pi RPC | ✅ 调用链完整 |

**❌ 发现问题 #2**：Thinking level picker 选择新级别后，InputToolbar emit `select-thinking-level`，ChatInput 将其包装为 `{ type: 'session.setThinkingLevel', payload: { sessionId, level } }` 发送。但 `session.setThinkingLevel` **不在 ClientMessageType 联合类型中**（protocol.ts:L7-19），server.ts 的 message handler 也**没有此 case**。消息会落入 default 分支，返回 `unknown_type` 错误。spec UC-3 步骤 10 "发送 session.setThinkingLevel 命令" 的要求无法满足。

**修复方向**：在 server.ts 中添加 `session.setThinkingLevel` 的处理，将 level 通过 pi RPC `set_thinking_level` 传递给 pi 进程。或在 protocol.ts 的 ClientMessageType 中注册此类型。

**❌ 发现问题 #3**：InputToolbar 的 `outputTokens` 取自 `sessionState.value.tokenUsage`（InputToolbar.vue:L112），而 `tokenUsage` 在 ChatSessionState 中初始化为 0（chat.ts:L70），但 `setTokenUsage()` 函数（chat.ts:L223）**从未被任何 composable 或事件处理器调用**。`message.complete` handler（useChat.ts:L161-164）只调用 `store.completeStream(sid)`，不提取 outputTokens。结果是 `↓0` 永远显示。

**修复方向**：在 message.complete handler 中，从 usage 提取 outputTokens 并调用 store.setTokenUsage。或在 context.update 广播时同时传递 outputTokens。

### UC-4: 插件开发者参考 statusline plugin 编写自己的 built-in plugin

**验证结果**：

| 检查点 | 验证结果 |
|--------|---------|
| docs/plugin/built-in-plugin-guide.md 存在 | ✅ 720 行，内容详实 |
| 覆盖 manifest 结构 | ✅ §2.2 package.json 必填字段 |
| 覆盖 activationEvents | ✅ §2.2 激活事件类型表 |
| 覆盖 hooks 注册 | ✅ §3.4 api.hooks — Hooks API |
| 覆盖 statusBarUpdate API（含新增参数） | ✅ §3.3 updateStatusBarItem |
| 以 statusline plugin 为案例 | ✅ §4 案例走读 |
| 覆盖数据流图 | ✅ §4.5 事件数据流 |

**✅ UC-4 完整实现。**

---

## spec 合规逐条检查

### FR-1: Event-adapter 接入 pi extension setStatus
- ✅ setStatus 不再丢弃，翻译为 onStatusSetUpdate 回调
- ✅ setWidget 保留丢弃
- ✅ bridge:event 修复：server.ts 调用 pluginService.handleBridgeEvent

### FR-2: statusline built-in plugin
- ✅ activationEvents: onStartupFinished
- ✅ 注册 hook 监听 plugin:statusSetUpdate
- ✅ 查映射表获取 metadata
- ✅ 未知 key 使用默认值
- ❌ **空/undefined text 清除逻辑有 bug**（见 Issue #1）

### FR-3: Input Toolbar
- ✅ Model picker 功能完整
- ❌ Thinking level picker 无法实际切换（Issue #2）
- ✅ Context bar 颜色三档逻辑正确
- ❌ Token stats 的 outputTokens 永远为 0（Issue #3）
- ❌ Branch name 出现在 InputToolbar（Issue #4，spec 要求在 SessionStrip）

### FR-4: Session Strip
- ❌ **缺少 branch 显示**（spec 要求 branch + extension chips）
- ✅ Extension chips 按 per-session 过滤
- ✅ split panel 独立显示

### FR-5: Global Statusbar
- ❌ **缺少 pi 版本号**（Issue #5）
- ✅ 右侧仅显示 global scope items
- ✅ 按 priority 排序
- ✅ commandId 可点击
- ❌ Branch 不应出现在此（Issue #4）

### FR-6: Plugin statusBarUpdate 增强
- ✅ 新增 tooltip/commandId/priority/scope/sessionId 均为 optional
- ✅ 向后兼容
- ✅ plugin-service 维护注册式 Map 管理
- ✅ deactivation 时清理 statusbar items

### FR-7: Built-in Plugin 开发指南
- ✅ 文档完整，覆盖全流程

### AC 验证矩阵

| AC | 描述 | 状态 | 备注 |
|----|------|------|------|
| AC-1 | pi extension setStatus 到达前端 | ❌ | Issue #1: undefined→"undefined" 显示 bug |
| AC-2 | Input Toolbar 完整功能 | ❌ | Issue #2: thinking level 无服务端处理; Issue #3: outputTokens 永远为 0 |
| AC-3 | Session Strip 信息展示 | ❌ | Issue #4: 缺少 branch 显示 |
| AC-4 | Global Statusbar 聚合 | ❌ | Issue #5: 缺少 pi 版本号 |
| AC-5 | 信息不重复（chip 路由规则） | ⚠️ | scope 路由正确，但 branch 同时出现在 InputToolbar 和 AppStatusbar |
| AC-6 | statusBarUpdate 增强 | ✅ | |
| AC-7 | Built-in Plugin 开发指南 | ✅ | |
| AC-8 | bridge:event 修复 | ✅ | server.ts:L716-719 正确调用 handleBridgeEvent |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | resources/plugins/statusline/index.ts:L51 + event-adapter.ts:L215 | pi extension 调用 setStatus("goal", undefined) 清除状态时，event-adapter 中 `String(undefined)` = `"undefined"` 字符串，绕过了 statusline plugin 的 `text === ''` 检查，导致 chip 显示文本 "undefined" | 在 event-adapter 中将 `event.text` 为 `undefined`/`null` 时转为空字符串 `''`。或同时在 statusline plugin 中过滤 `text === '' || text === 'undefined'` |
| 2 | MUST FIX | InputToolbar.vue:L17; server.ts:L417; protocol.ts | `session.setThinkingLevel` 不在 ClientMessageType 中，server 无对应 handler。前端发出后服务端返回 unknown_type 错误。thinking level 切换完全失效 | 在 server.ts 添加 `session.setThinkingLevel` case，通过 pi RPC `set_thinking_level` 传递 level。同时更新 protocol.ts 的 ClientMessageType |
| 3 | MUST FIX | InputToolbar.vue:L112; chat.ts:L223 | `tokenUsage`（outputTokens）初始化为 0 且 `setTokenUsage()` 从未被调用。message.complete handler 不提取 outputTokens。↓0 永远显示 | 在 message.complete handler 中从 usage 提取 outputTokens 并调用 setTokenUsage。或在 context.update 广播中包含 outputTokens |
| 4 | MUST FIX | SessionStrip.vue; InputToolbar.vue:L121-218; AppStatusbar.vue:L20-66 | spec FR-4 要求 SessionStrip 显示 branch，实际 branch 在 InputToolbar + AppStatusbar 中，SessionStrip 完全没有 branch | 将 branch 从 InputToolbar 和 AppStatusbar 移到 SessionStrip。SessionStrip 应始终显示 branch + 条件显示 extension chips |
| 5 | MUST FIX | AppStatusbar.vue | spec FR-5 要求左侧显示"连接状态 + pi 版本"，实际只有连接状态，无 pi 版本号 | 添加 pi 版本号显示（从 sessionStore 或配置中获取） |
| 6 | LOW | plugin-service.ts:L440 | agent RPC handler `setThinkingLevel: () => {}` 是空函数，即使通过 plugin 调用也不会生效 | 留待后续实现，当前 WS 路径更优先 |
| 7 | LOW | index.ts:L64-88 | onContextUpdate 回调包含 ~25 行逻辑（provider 查找、model 匹配、百分比计算），直接内联在 main() 中，违反单一职责 | 提取为独立方法如 `handleContextUpdate(sid, ctxData)` |
| 8 | INFO | InputToolbar.vue:L50-70 | THINKING_BAR_HEIGHTS 硬编码了 off/minimal/low/medium/high/xhigh 的视觉高度。spec 要求"不硬编码枚举"，但这里仅为视觉映射，level 名称来自 thinkingLevelMap 动态 keys | 可考虑基于 level index 动态计算高度（fallback 路径已有此逻辑） |
| 9 | INFO | statusline/index.ts:L51-53 + plugin-service.ts:L418 | statusline plugin 的 `text === ''` guard 和 plugin-service 的 empty-text-remove 逻辑形成双重防护。两者功能重叠但方向不同（plugin 阻止发送 vs service 执行删除） | 当前无功能问题，但可统一为一处处理 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

#### 等级判定校准规则对照

| 规则 | 适用 Issue |
|------|-----------|
| 数据丢失 | #1 (清除状态→chip 不消失), #3 (outputTokens 数据从未写入) |
| 功能失效 | #2 (thinking level 切换完全无效), #4 (branch 位置错误), #5 (pi 版本缺失) |
| 时序错误 | N/A |
| 数据语义错误 | #1 (text="undefined" 不是有效显示文本) |

### 结论

需修改后重审。

### Summary

业务逻辑编码评审完成，第1轮，5条MUST FIX（status清除bug、thinking level无服务端处理、outputTokens永远为0、branch位置错误、pi版本缺失），需修改后重审。
