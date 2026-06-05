# TUI 转 GUI 对现有架构的影响分析

> 评估 TUI→GUI 转换工作对当前 xyz-agent 代码架构的冲击、风险和副作用
> 日期：2026-06-05

---

## 目录

1. [冲击等级定义](#一冲击等级定义)
2. [总体评估](#二总体评估)
3. [EventAdapter 修改的影响](#三eventadapter-修改的影响)
4. [useChat 事件路由的影响](#四usechat-事件路由的影响)
5. [ChatStore 状态扩展的影响](#五chatstore-状态扩展的影响)
6. [ChatPanel 组件膨胀的影响](#六chatpanel-组件膨胀的影响)
7. [ExtensionUIDialog 架构的影响](#七extensionuidialog-架构的影响)
8. [Tool Renderer 增强的影响](#八tool-renderer-增强的影响)
9. [AppStatusbar 数据源合并的影响](#九appstatusbar-数据源合并的影响)
10. [WidgetDock 多位置渲染的影响](#十widgetdock-多位置渲染的影响)
11. [与已有功能的冲突点](#十一与已有功能的冲突点)
12. [性能风险](#十二性能风险)
13. [测试回归风险](#十三测试回归风险)
14. [副作用总表与处置方案](#十四副作用总表与处置方案)

---

## 一、冲击等级定义

| 等级 | 含义 | 代码量 | 测试要求 |
|------|------|--------|---------|
| 🟢 无冲击 | 纯新增，不修改现有代码 | < 50 行 | 单元测试 |
| 🟡 低冲击 | 修改少量现有代码，兼容旧逻辑 | 50-200 行 | 单元测试 + 回归 |
| 🟠 中冲击 | 修改核心数据流/架构，需要重构 | 200-500 行 | 单元测试 + 集成测试 + 人工测试 |
| 🔴 高冲击 | 修改数据流核心，影响多个模块 | > 500 行 | 全量回归 + 人工测试 |

---

## 二、总体评估

### 2.1 整体冲击等级：🟠 中冲击

此次 TUI→GUI 转换涉及 3 个核心架构文件（EventAdapter、useChat、ChatStore）+ 6 个 UI 组件的改动，整体冲击属于**可控范围内的中冲击**。

**核心特征**：
- ✅ 绝大部分改动是**增量式**（新增事件类型、新增 handler、新增 UI 组件）
- ✅ 现有数据流不受影响（旧事件继续按原路径处理）
- ⚠️ 需要修改 3 个共享类型（`protocol.ts` 的 `ServerMessageType` 和 `ExtensionUIRequestPayload`）
- ⚠️ ChatStore 分区状态需要新增 5 个字段（每个字段可能影响 JSON 序列化/反序列化）
- ⚠️ Sidecar 的 server.ts 需要处理新增的 WS 消息类型

### 2.2 各模块冲击分布

| 模块 | 文件数 | 冲击等级 | 说明 |
|------|--------|---------|------|
| EventAdapter | 1 | 🔴 高冲击 | 核心翻译层，修改 15 处 case |
| protocol.ts (shared) | 1 | 🟠 中冲击 | ServerMessageType 扩展 + 新 payload 类型 |
| useChat.ts | 1 | 🟠 中冲击 | 全局事件路由新增 10+ handler |
| ChatStore | 1 | 🟠 中冲击 | 分区状态新增 5 个字段 + 操作方法 |
| ChatPanel.vue | 1 | 🟡 低冲击 | 新增 auto_retry/queue/responseModel 渲染 |
| ExtensionUIDialog.vue | 1 | 🟡 低冲击 | 新增 editor 分支 |
| EditorDialog.vue | 1（新建） | 🟢 无冲击 | 全新组件，不修改现有 |
| CustomMessageRenderer.vue | 1（新建） | 🟢 无冲击 | 全新组件，不修改现有 |
| AppStatusbar.vue | 1 | 🟡 低冲击 | 新增 extension status + thinking level |
| WidgetDock.vue | 1 | 🟢 低冲击 | 新增 placement prop |
| BashToolRenderer.vue | 1 | 🟢 低冲击 | 新增流式输出 live update |
| EditToolRenderer.vue | 1 | 🟢 低冲击 | 新增 diff 高亮 |
| ToolCallCard.vue | 1 | 🟢 低冲击 | 新增 image/truncation 渲染 |
| SystemNotification.vue | 1 | 🟢 低冲击 | 新增 compaction/branch/skill 分支 |
| server.ts (sidecar) | 1 | 🟡 低冲击 | 可能需处理新 WS 消息类型 |

---

## 三、EventAdapter 修改的影响

### 3.1 修改规模

| 编号 | 修改 | 新增行 | 修改行 | 删除行 |
|------|------|--------|--------|--------|
| 2.1 | editor method 匹配 | ~15 | 0 | 0 |
| 2.2 | set_editor_text method 匹配 | ~12 | 0 | 0 |
| 2.3 | extension_error 字段名修复 | ~5 | 2 | 0 |
| 2.4 | message_start role 路由 | ~30 | 10 | 0 |
| 2.5 | tool_execution_end 保留 image | ~15 | 5 | 0 |
| 2.6 | tool_execution_update details | ~15 | 3 | 0 |
| 2.7 | auto_retry_start/end | ~25 | 0 | 0 |
| 2.8 | queue_update | ~12 | 0 | 0 |
| 2.9 | session_info_changed | ~8 | 0 | 0 |
| 2.10 | thinking_level_changed | ~8 | 0 | 0 |
| 2.11 | agent_end 附带 responseModel | ~8 | 3 | 0 |
| 2.12 | message_start 补传 details/display | ~8 | 3 | 0 |
| 2.13 | message_update error 子类型 | ~12 | 0 | 0 |
| 2.14 | setTitle matcher | ~8 | 0 | 0 |
| **合计** | | **~181** | **~26** | **0** |

### 3.2 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| 代码结构 | 🟡 低冲击 | EventAdapter 已有完善的 switch-case 结构，新增 case 不破坏现有结构 |
| 数据流 | 🟡 低冲击 | 所有修改都是*新增*或*增强*，没有修改或删除现有事件路由 |
| 并发安全 | 🟢 无影响 | EventAdapter 是单线程事件循环，无并发问题 |
| 错误处理 | 🟢 无影响 | 新增 case 都有 return，不影响现有 fallback 逻辑 |
| 可测试性 | 🟡 低冲击 | 现有测试不受影响，新增 case 需补充单元测试 |

### 3.3 风险点

**风险 1：ServerMessageType 类型膨胀**
- 当前 `ServerMessageType` 约 60 个值，新增 ~10 个后将到 ~70 个
- 前端 `event-bus.ts` 的 `on()` 函数接受 `ServerMessageType`，需要同步更新
- **影响**：类型定义文件编译检查会 catch 未引用的新类型，安全
- **缓解**：改完 protocol.ts 后全局搜索 `ServerMessageType` 的使用处，更新相关 switch-case

**风险 2：EventAdapter 单元测试覆盖**
- 当前 EventAdapter 测试文件 `event-adapter-bridge.test.ts` 和 `event-adapter-extension.test.ts` 可能要更新
- 新增的 case 如果没有测试覆盖，未来重构可能有回归
- **缓解**：每个新 case 至少写一个输入→输出的单元测试

**风险 3：extension_error 字段名修正是 break change**
- 当前前端 `ExtensionErrorPayload.extensionName` 收到的是 `event.extensionName`（空字符串）
- 修改为 `event.extensionPath` 后，前端显示从 "" 变为完整路径
- **影响**：前端显示效果改变，但这是修复 bug 不是 break change
- **缓解**：可在前端截取 path 的最后部分显示（如 basename）

---

## 四、useChat 事件路由的影响

### 4.1 修改规模

| 修改 | 新增行 | 修改行 |
|------|--------|--------|
| onBashExecution handler | ~20 | 0 |
| onCompactionSummary handler | ~10 | 0 |
| onBranchSummary handler | ~10 | 0 |
| onAutoRetryStart/End handler | ~25 | 0 |
| onQueueUpdate handler | ~15 | 0 |
| onSessionRenamed handler | ~8 | 0 |
| onThinkingLevelSet handler | ~8 | 0 |
| onSetEditorText handler | ~10 | 0 |
| onStreamError handler | ~15 | 0 |
| onExtensionSetTitle handler | ~8 | 0 |
| 注册到 eventMap | ~10 | 1 |
| **合计** | **~139** | **~1** |

### 4.2 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| 代码结构 | 🟠 中冲击 | useChat.ts 当前 ~260 行，新增 ~140 行后约 400 行，接近 300 行上限 |
| 数据流 | 🟡 低冲击 | 新增 handler 路由到 ChatStore 已有或新增的操作 |
| 全局注册机制 | 🟢 无影响 | `createGlobalHandlers` 使用对象映射注册，新增 entry 不影响现有 |

### 4.3 风险点

**风险 1：行数上限逼近**
- `useChat.ts` 当前 ~260 行，新增 ~140 行后约 400 行，超过 `script setup ≤ 300 行` 规范
- **影响**：违反前端编码规范的"行数上限"规则
- **缓解**：考虑将 handler 拆分到独立文件（如 `src/composables/chat-handlers/`），useChat.ts 只做注册

**风险 2：测试覆盖**
- `useChat.test.ts` 需新增新增 handler 的测试 cases
- **缓解**：单测必须补，尤其是 auto_retry 和 queue_update 的边界 case

---

## 五、ChatStore 状态扩展的影响

### 5.1 修改规模

| 新增字段 | 影响范围 |
|---------|---------|
| `pendingEditorText?: string` | ChatInput 预填充 |
| `autoRetryState?: AutoRetryState` | 重试指示器 |
| `queueState?: QueueState` | 排队消息 |
| `thinkingLevel?: ThinkingLevel` | 状态栏显示 |
| `responseModel?: string` | 模型指示器 |

### 5.2 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| JSON 序列化 | 🟢 无影响 | 所有新字段都是 `?:` 可选，不存在时不出现在序列化结果中 |
| Pinia 响应式 | 🟢 无影响 | Vue 3 reactive Proxy 自动追踪新字段 |
| session 恢复 | 🟡 低冲击 | `restoreSession` 方法需处理这些新字段（如果持久化） |
| ChatStore 方法膨胀 | 🟢 低冲击 | ChatStore 当前已按 sessionId 分区操作方法，新增 setter 不会破坏现有 |

### 5.3 风险点

**风险 1：session 持久化/恢复时字段不完整**
- 如果 ChatStore 的 session 状态被持久化到 localStorage 或 IndexedDB，新字段缺失会导致恢复后状态不一致
- **缓解**：1）所有新字段可选；2）`restoreSession` 中提供默认值兜底

**风险 2：多 panel 竞争 autoRetryState**
- 如果 autoRetryState 写入 ChatSessionState（按 sessionId 分区），同一个 sessionId 在多 panel 中显示同一个重试状态
- **影响**：这是期望行为（重试是 session 级事件，不是 panel 级）
- **缓解**：无需处理，分区设计天然解决

---

## 六、ChatPanel 组件膨胀的影响

### 6.1 当前 ChatPanel 分析

- `ChatPanel.vue` 当前约 250 行（包含 `<template>` + `<script setup>`）
- 新增：
  - auto_retry 指示器：~30 行
  - queue 排队提示：~20 行
  - responseModel 显示：~10 行
  - WidgetDock placement 区分：~20 行
  - **合计增加**：~80 行 → 约 330 行

### 6.2 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| 行数上限 | 🟡 低冲击 | ~330 行，在 `<template> ≤ 400 行` 上限内 |
| 数据流 | 🟢 无影响 | 新增的渲染区域完全独立于现有消息流 |
| 可维护性 | 🟡 低冲击 | 组件变大，但划分清晰（思考态 / 流式态 / 重试态 / 排队态） |

### 6.3 缓解方案

如果 ChatPanel 继续膨胀（后续 Phase），应考虑：

```
ChatPanel.vue
├── PanelBar.vue               # 已有
├── MessageList.vue            # 提取消息列表区域
│   ├── MessageBubble.vue
│   ├── StreamingMessage.vue
│   └── SystemNotification.vue
├── ChatStatusArea.vue         # 🔨 提取：思考中 + 重试 + 排队 + 流式消息
│   ├── ThinkingIndicator      # 思考中...
│   ├── AutoRetryIndicator     # 正在重试 (2/3)...
│   ├── QueueIndicator         # X 条消息排队中
│   └── StreamingMessage
├── WidgetDock (above)         # 已有
├── ChatInputArea.vue          # 提取：输入框 + 审批卡
│   ├── ApprovalCard
│   └── ChatInput
└── WidgetDock (below)         # 新增
```

> 提取 `ChatStatusArea.vue` 可以在 ChatPanel 达到 400 行时再做，当前不急。

---

## 七、ExtensionUIDialog 架构的影响

### 7.1 当前架构问题

`ExtensionUIDialog.vue` 当前设计上是**单体 Dialog**——一个 Dialog 组件内部用 `v-if` 切换 confirm/select/input/notify。

这种架构在添加 `editor` 分支时没有架构冲击。但有一个潜在问题：

**问题**：`editor` 分支需要 `textarea`，而当前 Dialog 使用 `xyz-ui` 的 `Input` 组件（单行）。如果需要多行编辑，要么在 Dialog 内嵌原生 `<textarea>`（违反"禁止原生 HTML 表单元素"规范），要么让 xyz-ui 提供 `Textarea` 组件。

### 7.2 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| 架构 | 🟡 低冲击 | EditorDialog 可独立于 ExtensionUIDialog，不破坏现有 Dialog 逻辑 |
| 组件间通信 | 🟢 无影响 | 使用与现有 Dialog 相同的 `useExtensionUI` composable |
| 规范合规 | 🟡 低冲击 | 需要 xyz-ui 的 Textarea 组件 |

### 7.3 风险点

**风险 1：xyz-ui 缺少 Textarea 组件**
- 当前 `EditorDialog.vue` 需要使用多行文本编辑器
- 如果 xyz-ui 没有 Textarea 组件，需要要么新增，要么用 `<textarea>`（违反规范）
- **缓解**：在 xyz-ui 中新增 Textarea 组件（单文件，较简单）

---

## 八、Tool Renderer 增强的影响

### 8.1 修改清单

| Renderer | 修改 | 冲击 |
|---------|------|------|
| BashToolRenderer.vue | 流式输出实时追加 + fullOutputPath 链接 | 🟢 |
| EditToolRenderer.vue | Diff 高亮（颜色区分 + 折叠） | 🟢 |
| ToolCallCard.vue | Image 渲染 + 自定义工具 fallback + 截断 | 🟢 |
| ReadToolRenderer.vue | 截断提示 | 🟢 |

### 8.2 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| 组件间接口 | 🟢 无影响 | 所有 Tool Renderer 通过 props 接收数据，新增/增强字段不影响现有渲染 |
| 流式 update | 🟡 低冲击 | BashToolRenderer 需从 `tool_call_update` 事件实时追加输出，与现有 `tool_call_end` 并行渲染 |
| 状态管理 | 🟢 无影响 | tool_call_update 已在 useChat 中处理后写入 store，Tool Renderer 只读 |

**唯一重要注意**：BashToolRenderer 的流式更新可能导致**DOM 频繁刷新**。如果 bash 输出很长（1000+ 行），`tool_execution_update` 每 100ms 推送一次完整快照，可能导致渲染卡顿。

**缓解**：在 BashToolRenderer 中使用 `requestAnimationFrame` 节流，或差值更新（只追加新行，不替换全部）。

---

## 九、AppStatusbar 数据源合并的影响

### 9.1 当前架构

`AppStatusbar.vue` 当前只有 plugin 的 `statusBarItems` 作为数据来源。

### 9.2 修改方案

需要合并三个数据源：
1. Plugin statusBarItems（现有）
2. Extension status（新增，来自 `extension:status` WS 事件）
3. Thinking level（新增，来自 `session.thinkingLevelSet` WS 事件）

### 9.3 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| 数据结构 | 🟡 低冲击 | 需要设计统一的 `StatusBarItem` 模型，或保持两个独立数组并用 `<slot>` 渲染 |
| 数据源 | 🟡 低冲击 | `extension:status` 事件通过 event-bus 订阅，不会打断现有 plugin 数据流 |
| 样式 | 🟢 无影响 | 现有 chip 样式可复用 |

### 9.4 风险点

**风险 1：per-session vs global status 混淆**
- Plugin statusBarItems 有 `scope: 'per-session' | 'global'` 字段
- Extension `setStatus` 当前按 sessionId 分区（每个 session 有自己的 EventAdapter 实例），但 `AppStatusbar.vue` 在 panel-grid 层是全局组件
- **问题**：多 panel 模式下，哪个 session 的 extension status 应该显示在全局状态栏？
- **缓解**：
  1. 当前简化：只显示当前 active session 的 extension status
  2. 或：extension status 统一设计为全局（不按 session 分区），如果 extension 需要 session 级别的状态，用 plugin 机制

---

## 十、WidgetDock 多位置渲染的影响

### 10.1 当前架构

`WidgetDock.vue` 在 `ChatPanel.vue` 的消息列表下方、ChatInput 上方渲染。只支持 `aboveEditor` 一个位置。

### 10.2 修改方案

需要支持 `placement: 'aboveEditor' | 'belowEditor'`，在 ChatPanel 中渲染两次。

### 10.3 冲击分析

| 维度 | 评价 | 理由 |
|------|------|------|
| WidgetDock 改造 | 🟢 低冲击 | 新增 placement prop，不影响现有 aboveEditor 渲染 |
| ChatPanel 布局 | 🟡 低冲击 | 两个 WidgetDock 实例之间夹着 ChatInput 区域 |
| 数据路由 | 🟡 低冲击 | 前端需要按 placement 字段过滤：`aboveEditorWidgets = widgets.filter(w => w.placement !== 'belowEditor')` |

### 10.4 风险点

当前 EventAdapter 的 setWidget 转发没有透传 `widgetPlacement` 字段。

**修复**：EventAdapter setWidget handler 现在只转发 `widgetKey` 和 `lines`，需要增加 `placement`：

```typescript
if (method === 'setWidget') {
  return {
    type: EXTENSION_EVENTS.WIDGET as ServerMessageType,
    payload: {
      sessionId: sid,
      widgetKey: String(event.widgetKey ?? ''),
      lines: ...,
      placement: String(event.widgetPlacement ?? 'aboveEditor'), // 新增
    },
  }
}
```

---

## 十一、与已有功能的冲突点

### 11.1 session-service 的 compaction 事件 vs EventAdapter 的 compaction 透传

**冲突**：当前 session-service 手动发送 `session.compacting` / `session.compacted` 事件给前端。如果 EventAdapter 也开始转发 pi 的 `compaction_start` / `compaction_end` 事件，会导致前端收到**两套 compaction 事件**。

**当前避免**：EventAdapter 已有 `case 'compaction_start'` / `case 'compaction_end'` → `return null`（丢弃）。未来如果要透传，必须有明确的去重策略。

**建议**：维持现状，EventAdapter 丢弃 compaction 事件，由 session-service 统一管理。未来如果要透传 compaction result 数据（tokensBefore、summary 等），在 session-service 的 `compacted` 事件中增加这些数据。

### 11.2 extension_error 的 SystemNotification 插入 vs 现有逻辑

**冲突**：当前 `onExtensionError` 使用 `store.addMessage` + `createSystemNotification` 在聊天流中插入 extension 错误消息。

EventAdapter 2.3 修改后，`extensionName` 从此前的空字符串变为完整路径（如 `/path/to/extension/index.ts`），可能导致 system notification 的标题从"Extension: " 变为 "Extension: /usr/.../index.ts"。

**影响**：UI 显示效果改变，但不影响功能。

**建议**：前端截取 basename 显示：

```typescript
const extName = payload.extensionName.split('/').pop()?.replace('.ts', '') ?? 'unknown'
```

### 11.3 SlashMenu 的 get_commands 接入 vs 当前硬编码

**冲突**：当前 SlashMenu 硬编码命令列表。如果改为从 pi 的 `get_commands` RPC 获取，需要：
1. 在 session 启动时调用 `get_commands`
2. 缓存命令列表
3. 更新 SlashMenu 的搜索/分类逻辑

**影响**：SlashMenu 数据源变化，但 UI 逻辑不变，属于内部实现重构。

**建议**：可以作为 Phase 2 的独立 task，不在此次 TUI→GUI 范围中。

### 11.4 排队消息 vs steering/follow_up 模式设置

**冲突**：`queue_update` 显示的排队消息数量依赖于 `set_steering_mode` / `set_follow_up_mode` 的设置。如果用户设置了 `'one-at-a-time'`，排队消息有限。如果设置了 `'all'`，所有 steer/follow_up 都会排队。

前端需要处理：
1. Queue 显示数量 → 超过 3 条时折叠显示 "+N more"
2. Queue 取消 → 用户可取消排队中的消息
3. Queue mode 设置 → 需在 Settings 或 ChatPanel 中提供设置入口

**建议**：当前只做"显示排队数量"，不做"取消排队中消息"和"mode 设置"。

---

## 十二、性能风险

### 12.1 Bash 流式输出渲染

**风险等级**：🟠 中

`tool_execution_update` 在 bash 工具长时间运行时每 100-500ms 推送**完整输出快照**。如果输出很长（10000+ 行），每次 update 都重新渲染整个 DOM 会严重卡顿。

**缓解方案**：

| 方案 | 实现成本 | 效果 |
|------|---------|------|
| rAF 节流 | 低（~30 行） | 限制每秒最多 60 帧更新 |
| 差值更新（只追加新行） | 中（~80 行） | 避免全量替换 |
| virtual scrolling（虚拟列表） | 高（~300 行） | 只渲染可见区域 |

**建议**：先用**差值更新 + rAF 节流**，如果 5000+ 行才考虑 virtual scrolling。

### 12.2 ChatStore 状态频繁更新

**风险等级**：🟡 低

`queue_update` 和 `auto_retry_start/end` 事件可能频繁触发（但实际场景不多见）。ChatStore 的 state 更新会触发依赖追踪。

**缓解**：Vue 3 的 reactive Proxy 已做批处理，正常情况下不担心。但如果 queue_update 每秒触发多次，可考虑 `shallowRef` 替换或节流。

### 12.3 ExtensionUI Dialog timeout

**风险等级**：🟢 无

editor dialog 的 timeout 由 pi 侧控制（超时后自动 resolve 默认值），前端不需要处理超时。如果前端自行实现倒计时，使用 `setTimeout` 即可，无性能风险。

---

## 十三、测试回归风险

### 13.1 需要回归的测试文件

| 测试文件 | 覆盖范围 | 是否受影响 | 影响程度 |
|---------|---------|-----------|---------|
| event-adapter-bridge.test.ts | EventAdapter | ✅ 是 | 🔴 新增 case 需要测试 |
| event-adapter-extension.test.ts | EventAdapter extension | ✅ 是 | 🟡 Extension 新增 method |
| useChat.test.ts | useChat 事件路由 | ✅ 是 | 🟠 新增 handler 需要测试 |
| useChat-subagent.test.ts | subagent 相关 | ❌ 不直接受影响 | 🟢 无需修改 |
| useChat-subagent-boundary.test.ts | subagent 边界 | ❌ 不直接受影响 | 🟢 无需修改 |

### 13.2 回归策略

| 阶段 | 测试 |
|------|------|
| Phase 0（EventAdapter 修改） | 每个新 case 一个单元测试 + 运行全部现有 EventAdapter 测试 |
| Phase 1（新建组件） | EditorDialog 渲染测试 |
| Phase 2（增强已有组件） | useChat.test.ts 新增 handler 测试 + ChatPanel 手动测试 |
| Phase 3（bridge extension） | 无需前端测试 |

---

## 十四、副作用总表与处置方案

### 14.1 可控副作用（有明确方案）

| # | 副作用 | 严重度 | 处置方案 |
|---|--------|-------|---------|
| 1 | ServerMessageType 类型膨胀 60→70 | 🟢 | 类型安全，编译检查自动拦截 |
| 2 | useChat.ts 行数突破 300 | 🟡 | 拆分 handler 到独立文件 |
| 3 | ChatStore 新增 5 个可选字段 | 🟢 | 可选字段不触发序列化，restoreSession 提供默认值 |
| 4 | ChatPanel 达到 330 行 | 🟢 | 在 400 行上限内，后续提取 ChatStatusArea |
| 5 | ExtensionUIDialog 需 textarea 组件 | 🟡 | 在 xyz-ui 新增 Textarea 组件 |
| 6 | BashToolRenderer 流式渲染性能 | 🟠 | 差值更新 + rAF 节流 |
| 7 | compaction 事件双通道 | 🟢 | 维持现状（EventAdapter 丢弃，session-service 管理） |
| 8 | extension_error 从空路径变完整路径 | 🟢 | 前端截取 basename 显示 |
| 9 | 两个 WidgetDock 实例 | 🟢 | 用 placement prop 区分数据源 |

### 14.2 需后续决策的副作用

| # | 副作用 | 决策点 | 建议 |
|---|--------|--------|------|
| 1 | AppStatusbar 在多 panel 模式下显示谁的 extension status | 显示 active session 的 status | 先简化，后续如果 extension 有 session 级状态改用 plugin |
| 2 | auto_retry 取消按钮的 RPC 命令 | 需要 `abort_retry` 命令 | 在 server.ts 增加 `abort_retry` WS 命令转发给 pi |
| 3 | queue 取消排队消息 | 需要 `cancel_queue` 或 `clear_queue` 命令 | 当前不做，只显示数量 |
| 4 | SlashMenu 从 pi 动态获取 vs 硬编码 | 改为 `get_commands` RPC | Phase 2 单独 task |
| 5 | xyz-ui Textarea 组件是新增还是复用 Input | 新增 Textarea 组件 | 单文件，可复用现有 Dialog CSS |

### 14.3 无影响的 TUI 渠道（确认不影响现有 GUI）

| TUI 渠道 | 为什么不影响 |
|---------|-------------|
| setHeader | EventAdapter 不处理，GUI 无对应，无影响 |
| setFooter | EventAdapter 不处理，GUI 有固定 AppStatusbar |
| setEditorComponent | EventAdapter 不处理，GUI 使用自带 ChatInput |
| onTerminalInput | EventAdapter 不处理，GUI 不适用 |
| setHiddenThinkingLabel | EventAdapter 不处理，GUI 不需要 |
| setWorkingMessage/Indicator/Visible | EventAdapter 不处理，前端自动推算 |
| setToolsExpanded | EventAdapter 不处理，用户手动控制 |
| registerMessageRenderer | RPC no-op，前端按 customType 自行路由 |
| registerTool renderShell/renderCall/renderResult | RPC no-op，前端按 toolName 自行渲染 |
| setTheme/getAllThemes | RPC 返回空，前端自有 ThemeProvider |
| custom() 全屏组件 | RPC 返回 undefined，不执行 |

---

## 总结

### 可安全增量实施的改动顺序

```
EventAdapter 修改（Phase 0） ← 必须先做
└─→ protocol.ts 类型扩展（轻微，编译安全）
    └─→ useChat.ts 新增 handler + ChatStore 新增字段
        ├─→ ExtensionUIDialog editor 分支 + EditorDialog 新建（独立，不冲突）
        ├─→ ChatPanel 新增 auto_retry/queue/responseModel（模板增强，不影响现有消息流）
        ├─→ AppStatusbar 新增 extension status + thinking level（独立区域）
        ├─→ WidgetDock placement 支持（兼容旧用法）
        └─→ Tool Renderer 细节增强（纯新增 props/条件渲染）
```

### 核心结论

1. **整体冲击中低**，没有架构层面的 break change
2. **EventAdapter 是最大风险点**，因为它是所有事件翻译的入口，必须确保每个新 case 正确
3. **useChat.ts 行数控制**是规范性风险，建议在 Phase 2 完成后做代码拆分
4. **ChatStore 新增字段**安全（可选、分区、不破坏持久化）
5. **性能风险**只在 Bash 流式输出场景，有明确缓解方案
6. **所有 TUI no-op 渠道**不需要处理，不影响现有 GUI
