# Pi TUI → xyz-agent GUI 组件映射规格

> 调研日期：2026-06-04
> 审查修订：2026-06-04 v3（补充 extension_error 字段名 bug、CustomMessage display 过滤、message_update error/done 子类型遗漏）
> Demo 页面：[tui-gui-component-mapping-demo.html](../page-design/tui-gui-component-mapping-demo.html)

## 一、映射总表

### 图例

| 标记 | 含义 |
|------|------|
| ✅ 已有 | xyz-agent 前端已有对应组件，可直接使用 |
| ⚡ 增强 | 已有组件，需要增加功能/props |
| 🔨 新建 | 需要新建的组件 |
| ⏸️ 延后 | P2 优先级，暂不实现 |
| ❌ 不做 | 不建议实现 |
| 🔴 需改 pi | RPC 模式静默 no-op，需修改 pi 源码才能支持 |

---

### 按布局区域

#### 1. 消息区（聊天流）

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 1.1 | UserMessage | `MessageBubble.vue` (role=user) | ✅ 已有 | — |
| 1.2 | AssistantMessage (text) | `StreamingMessage.vue` → `MessageBubble.vue` | ✅ 已有 | 流式 → 最终渲染 |
| 1.3 | ThinkingBlock | `ThinkingBlock.vue` | ✅ 已有 | 折叠/展开 |
| 1.4 | CustomMessage (customType) | **`CustomMessageRenderer.vue`** | 🔨 新建 | 按 customType 路由渲染 |
| 1.5 | ToolExecutionComponent (bash) | `BashToolRenderer.vue` | ⚡ 增强 | 需支持 `tool_execution_update` 流式输出实时追加；**EventAdapter 当前 `tool_execution_update` 只取 `partialResult` 字符串，丢失了 `partialResult.details` 结构化数据（含 truncation/fullOutputPath）**；需使用 `details.fullOutputPath` 提供"查看完整输出"链接；需使用 `details.truncation` 判断是否显示截断提示 |
| 1.6 | ToolExecutionComponent (edit) | `EditToolRenderer.vue` | ⚡ 增强 | `details` 含 `{ diff, patch, firstChangedLine? }`，见 10.3 |
| 1.7 | ToolExecutionComponent (write) | `WriteToolRenderer.vue` | ✅ 已有 | — |
| 1.8 | ToolExecutionComponent (read) | `ReadToolRenderer.vue` | ⚡ 增强 | `details` 含 `{ truncation? }`，截断时需提示用户 |
| 1.9 | ToolExecutionComponent (默认) | `DefaultToolRenderer.vue` | ✅ 已有 | — |
| 1.10 | ToolExecutionComponent (自定义) | **`CustomToolRenderer.vue`** | ⚡ 增强 | 扩展 ToolCallCard，新增 custom 分支 |
| 1.11 | renderCall / renderResult | 不可直接映射 | ⏸️ 延后 | RPC 不透传，需 bridge extension 序列化 |
| 1.12 | registerMessageRenderer | **`CustomMessageRenderer.vue`** | 🔨 新建 | 见 1.4 |

#### 2. Header 区

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 2.1 | setHeader (自定义启动头) | 无映射 | ❌ 不做 | 启动 header 在 GUI 中无对应场景 |

#### 3. Widget 区

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 3.1 | setWidget(key, string[]) | `WidgetDock.vue` | ✅ 已有 | 纯文本数组 |
| 3.2 | setWidget(key, componentFactory) | **`WidgetDock.vue` 增强** | ⚡ 增强 | 支持结构化数据：进度条、任务列表、交互项 |
| 3.3 | setWidget placement (belowEditor) | **`WidgetDock.vue` 增强** | ⚡ 增强 | 支持 belowEditor 位置 |

#### 4. Editor 区

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 4.1 | setEditorText | `ChatInput.vue` | ⚡ 增强 | **[P0] EventAdapter 未处理 `set_editor_text` method**，需先增加匹配；RPC 下 setEditorText 和 pasteToEditor 发相同的 `set_editor_text` 事件 |
| 4.2 | pasteToEditor | `ChatInput.vue` | ⚡ 增强 | RPC 模式下自动降级为 setEditorText（同一事件），见 4.1 |
| 4.3 | addAutocompleteProvider | **`ChatInput.vue` 增强** | ⏸️ 延后 | **RPC 模式完全静默 no-op**，pi 不发出任何事件。bridge extension 方案不可行（pi 内部调用，extension 无法 hook）。唯一出路：修改 pi RPC 模式让它也 emit `extension_ui_request`，或由 bridge extension 自行提供补全数据源（不依赖 pi 的 addAutocompleteProvider） |
| 4.4 | setEditorComponent (vim/emacs) | 无映射 | ❌ 不做 | 纯前端实现，不依赖 pi |
| 4.5 | getEditorText | 不可行 | ❌ 不做 | 同步方法，RPC 无法等待 |

#### 5. Working Indicator 区

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 5.1 | 默认思考指示 | `ChatPanel.vue` | ✅ 已有 | 固定文案 "思考中..." |
| 5.2 | setWorkingMessage | **`ChatPanel.vue` 增强** | 🔴 需改 pi | **RPC 模式完全静默 no-op**，pi 不发出任何事件。bridge extension 方案不可行（pi 内部调用，extension 无法 hook）。唯一出路：修改 pi RPC 模式让它也 emit `extension_ui_request` |
| 5.3 | setWorkingVisible | **`ChatPanel.vue` 增强** | 🔴 需改 pi | 同 5.2，RPC 模式完全静默 no-op |
| 5.4 | setWorkingIndicator | 不需要映射 | ❌ 不做 | 动画帧在 GUI 中无意义，CSS 动画更好 |

#### 6. Footer 区

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 6.1 | setStatus(key, text) | **`AppStatusbar.vue` 增强** | ⚡ 增强 | 统一 extension + plugin status |
| 6.2 | setFooter (完全替换) | 无映射 | ❌ 不做 | 完全替换在 GUI 中无意义 |
| 6.3 | setTitle | **Electron 窗口标题** | ⏸️ 延后 | RPC 模式**会** emit `extension_ui_request`（method: "setTitle"），成本极低。可选增强：更新 Electron BrowserWindow.setTitle() |

#### 7. 弹窗交互

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 7.1 | confirm(title, msg) | `ExtensionUIDialog.vue` | ✅ 已有 | — |
| 7.2 | select(title, options) | `ExtensionUIDialog.vue` | ✅ 已有 | — |
| 7.3 | input(title, placeholder) | `ExtensionUIDialog.vue` | ✅ 已有 | — |
| 7.4 | editor(title, prefill) | **`EditorDialog.vue`** | 🔨 新建 | **[P0] EventAdapter 未匹配 `editor` method**，必须先增加匹配，否则 `ctx.ui.editor()` 永远挂起。集成：EventAdapter 增加 `method === 'editor'` 分支 → `ExtensionUIDialog.vue` 新增 editor 分支 → `EditorDialog.vue` |
| 7.5 | notify(msg, type) | `ToastContainer.vue` / `SystemNotification.vue` | ✅ 已有 | — |
| 7.6 | 倒计时 dialog (timeout) | **`ExtensionUIDialog.vue` 增强** | ⚡ 增强 | 倒计时自动关闭 |

#### 8. 全屏/浮层

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 8.1 | ctx.ui.custom() | 无映射 | ⏸️ 延后 | 成本高，ROI 低 |
| 8.2 | ctx.ui.custom({ overlay }) | **`ExtensionOverlay.vue`** | ⏸️ 延后 | 已有 DrawerOverlay 基础设施 |
| 8.3 | SelectList | `xyz-ui Select.vue` | ✅ 已有 | 基础选择器，需增强搜索 |
| 8.4 | SettingsList | 需封装 | ⏸️ 延后 | Toggle + Select 组合 |
| 8.5 | BorderedLoader | `ProgressBar.vue` + 取消按钮 | ⏸️ 延后 | 需封装 |

#### 9. 主题与外观

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 9.1 | setTheme / getAllThemes | `ThemeProvider.vue` | ✅ 已有 | xyz-agent 已有暗色主题切换 |
| 9.2 | ctx.ui.theme 对象 | CSS 变量（style.css） | ✅ 已有 | 主题颜色已在 CSS 变量中定义 |
| 9.3 | setTitle | Electron 窗口标题 | ⏸️ 延后 | RPC 模式会 emit 事件，成本极低。见 6.3 |

#### 10. 工具辅助功能

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 10.1 | setToolsExpanded | `ToolCallCard.vue` | ⚡ 增强 | 前端已有 expand/collapse UI，但 **RPC 模式下 extension 调用 setToolsExpanded 完全无效**（no-op）。如果需要 extension 控制展开状态，需修改 pi RPC 模式让它也 emit `extension_ui_request` |
| 10.2 | renderShell: "self" | 无映射 | ❌ 不做 | TUI 特有概念 |
| 10.3 | Diff 高亮渲染 | **`EditToolRenderer.vue` 增强** | ⚡ 增强 | 当前只显示 diffSize，需增加 inline diff 高亮。数据来自 `tool_execution_end` 的 `details` 字段：`{ diff: string, patch: string, firstChangedLine?: number }` |
| 10.4 | Tool output 截断 (VisualTruncate) | **`ToolCallCard.vue` 增强** | ⚡ 增强 | 大量输出折叠，显示行数和 "展开" 按钮。bash 工具的 `details.truncation` 标记是否被截断，`details.fullOutputPath` 提供完整输出文件路径 |
| 10.5 | Tool output 图片渲染 | **`ToolCallCard.vue` 增强** | ⚡ 增强 | **[P1] EventAdapter 当前丢弃 image content**，只提取 text blocks。需修改 EventAdapter 在 `tool_execution_end` 中保留 `type: "image"` 的 content 块（含 `data` + `mimeType`），前端用 `<img>` 渲染 |

#### 11. 特殊消息类型

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 11.1 | Compaction Summary | `SystemNotification.vue` | ⚡ 增强 | **[P1]** RPC 通过 `message_start` 发送 `role: "compactionSummary"` 消息。EventAdapter 需识别此 role 并透传完整数据。实际 pi 字段（`CompactionSummaryMessage`）：`{ role: "compactionSummary", summary: string, tokensBefore: number, timestamp: number }`（**无 `tokensAfter`、无 `details` 字段**）。当前 session-service 的 `compact()` 手动发 `session.compacting/compacted` 事件但**不含 result 数据**，需改为透传 `CompactionResult` |
| 11.2 | Branch Summary | 无 | ⚡ 增强 | **[P1]** RPC 通过 `message_start` 发送 `role: "branchSummary"` 消息。EventAdapter 需识别此 role 并透传完整数据。实际 pi 字段（`BranchSummaryMessage`）：`{ role: "branchSummary", summary: string, fromId: string, timestamp: number }` |
| 11.3 | Skill Invocation | `MessageBubble.vue` 增强 | ⚡ 增强 | skill 调用时的特殊消息。前端需解析 `message_start` 中 `msg.content` 里的 `<skill:name>...</skill>` 标签块（等价于 pi TUI 的 `parseSkillBlock()`），匹配后渲染为 skill 调用卡片 |

#### 12. 其他

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 12.1 | extension_error | `SystemNotification.vue` | 🔴 **字段名 bug** | **[P0]** EventAdapter 读 `event.extensionName`（永远是空字符串），但 pi 实际发出的是 `event.extensionPath`。导致前端显示 `Extension: ` 空名称。此外 pi 还提供 `event.event`（触发错误的原始事件名），也被丢弃。修复：EventAdapter 改用 `event.extensionPath` 并透传 `event.event` 字段 |
| 12.2 | setHiddenThinkingLabel | 无映射 | ❌ 不做 | RPC no-op，隐藏 thinking 标签在 GUI 中无场景 |
| 12.3 | onTerminalInput | 无映射 | ❌ 不做 | 原始终端键盘输入，RPC no-op，GUI 不适用 |
| 12.4 | BashExecutionMessage | **`BashToolRenderer.vue`** | ⚡ 增强 | **[P1]** 用户通过 `!` 前缀直接执行命令，RPC 通过 `message_start` 发送 `role: "bashExecution"`。EventAdapter 需区分此 role 并透传完整数据。实际 pi 字段（`BashExecutionMessage`）：`{ role: "bashExecution", command, output, exitCode, cancelled, truncated, fullOutputPath?, timestamp, excludeFromContext? }`。`excludeFromContext`（`!!` 前缀）标记为本地执行不发送 LLM，前端可显示不同样式。注意：这与 agent tool call 的 bash 执行是不同的消息类型 |
| 12.5 | auto_retry_start / auto_retry_end | **`ChatPanel.vue` 增强** | ⚡ 增强 | **[P1]** agent 出错自动重试事件，EventAdapter 当前完全丢弃。需转发：`auto_retry_start`（含 attempt/maxAttempts/delayMs/errorMessage）→ 显示"正在重试 (2/3)..." + 取消按钮；`auto_retry_end`（含 success/attempt/finalError）→ 隐藏指示器。不转发用户会以为 agent 卡死 |
| 12.6 | queue_update | **`ChatPanel.vue` 增强** | ⚡ 增强 | **[P1]** 排队消息队列（steering/followUp）更新事件，EventAdapter 当前完全丢弃。需转发并在 ChatInput 附近显示"X 条消息排队中" |
| 12.7 | session_info_changed | **`ChatStore`** | ⚡ 增强 | session 重命名事件，需更新 UI 中的 session 名称显示 |
| 12.8 | thinking_level_changed | **`AppStatusbar.vue`** | ⚡ 增强 | thinking level 变更事件，需更新状态栏指示器 |
| 12.9 | AssistantMessage.diagnostics | 暂不渲染 | ⏸️ 延后 | provider 错误恢复记录（`{ type, timestamp, error, details }`），可用于错误诊断 tooltip。EventAdapter 的 `agent_end` 中应附带此字段以备后用 |
| 12.10 | AssistantMessage.responseModel | **`ChatPanel.vue` 增强** | ⚡ 增强 | 实际使用的模型名（auto routing 后的具体模型），EventAdapter 的 `agent_end` 中应附带。前端可在模型指示器中显示 |
| 12.11 | message_update 中 toolcall sub-type | 暂不转发 | ⏸️ 延后 | EventAdapter 有意跳过 `toolcall_start/delta/end`（用 `tool_execution_start/end` 代替）。当前合理简化，如需"正在解析工具调用"中间态可考虑转发 |
| 12.12 | message_update → error sub-type | **`ChatPanel.vue` 增强** | ⚡ 增强 | **[P2]** EventAdapter 未处理 `assistantMessageEvent.type === "error'`（`{ reason: "aborted"\|"error", error: AssistantMessage }`），落入 default 打印 warn 后丢弃。provider 出错或 abort 时，前端只能通过 `agent_end` 的通用 stopReason 感知，无法显示具体错误消息。修复：EventAdapter 增加 `case 'error'` 转发为 `message.stream_error` 事件，前端可展示 provider 返回的具体错误详情 |
| 12.13 | message_update → done sub-type | 暂不转发 | ⏸️ 延后 | `{ reason: "stop"\|"length"\|"toolUse", message: AssistantMessage }` — 单轮文本生成完成信号。前端当前通过 `tool_execution_start`（开始工具调用）和 `agent_end`（loop 结束）已能覆盖多 turn 中间态。如需更细粒度的 "正在准备工具调用..." 提示可考虑转发 |

---

## 二、新组件规格

### 🔨 CustomMessageRenderer.vue

**用途**：渲染 pi extension 通过 `pi.sendMessage({ customType, content, display: true })` 发送的自定义消息。

**前置条件**：EventAdapter 的 `message_start` case 需补传 `msg.details` 和 `msg.display` 字段。当前只转发 `customType` + `content`，丢弃了 `details`（扩展数据）和 `display`（是否在聊天中渲染）。**`display: false` 的消息必须被过滤，不应渲染到聊天流**（pi TUI 的 `CustomMessageComponent` 同样检查 `message.display` 才渲染）。

```
文件：components/extension/CustomMessageRenderer.vue
```

**Props**：

| Prop | 类型 | 说明 |
|------|------|------|
| `customType` | `string` | 消息类型标识，如 `"plan-mode"`, `"git-checkpoint"` |
| `content` | `string \| (TextContent \| ImageContent)[]` | 消息正文。pi 的 `CustomMessage.content` 支持纯文本和多模态内容数组 |
| `details` | `Record<string, unknown>?` | 扩展数据 |
| `expanded` | `boolean` | 是否展开详情 |

**功能**：
1. 按 `customType` 查找注册的渲染器（`Map<string, RendererComponent>`）
2. 无匹配时 fallback 到通用渲染（显示 customType 标签 + content 文本）
3. 支持 expanded 模式展示 details

**数据来源**：RPC `message_start` 事件中 `msg.customType` 字段（EventAdapter 已在 `message_start` case 中检测 `msg.customType` 并转发）

---

### 🔨 EditorDialog.vue

**用途**：支持 pi extension 的 `ctx.ui.editor(title, prefill)` 多行文本编辑交互。

```
文件：components/extension/EditorDialog.vue
```

**Props**：

| Prop | 类型 | 说明 |
|------|------|------|
| `open` | `boolean` | 是否显示 |
| `title` | `string` | dialog 标题 |
| `prefill` | `string?` | 预填充文本 |
| `onConfirm` | `(value: string) => void` | 提交回调 |
| `onCancel` | `() => void` | 取消回调 |

**功能**：
1. 基于 `xyz-ui Dialog` + `Textarea` 构建
2. 支持多行文本编辑，等宽字体
3. Enter 提交，Escape 取消
4. 预填充 `prefill` 内容

**前置条件**：**EventAdapter 必须先增加 `method === 'editor'` 匹配**。当前 EventAdapter 只处理 confirm/select/input/notify 四种 method，`editor` 落入 return null 分支，`ctx.ui.editor()` 调用会永远挂起。

**集成方式**：EventAdapter 增加 `editor` 匹配 → 转发为 `extension.ui_request` 事件（method: 'editor'） → `ExtensionUIDialog.vue` 新增 `method === 'editor'` 分支 → 渲染 `EditorDialog.vue`

---

## 三、需增强组件的改动点

### ⚡ WidgetDock.vue 增强

**改动**：
1. 新增 `structuredWidgets` prop（或扩展现有 `widgets` prop 支持 `{ type, data }` 结构）
2. 按 `type` 字段路由渲染：
   - `"text"` → 当前纯文本模式（默认）
   - `"progress"` → 进度条
   - `"task-list"` → 可交互任务列表
   - `"custom"` → 扩展点，允许注册自定义渲染器
3. 支持 `placement: "belowEditor"` 渲染位置

### ⚡ AppStatusbar.vue 增强

**改动**：
1. 合并 extension status 和 plugin status 到统一数据源
2. extension status 来源：WS 事件 `extension:status`
3. 点击 extension status chip 可触发操作（如果 extension 定义了 commandId）

### ⚡ ChatPanel.vue 增强（Working Indicator）

> **⚠️ 不可行警告**：pi RPC 模式的 `setWorkingMessage` / `setWorkingVisible` 是完全静默 no-op，不发出任何事件。bridge extension 方案不可行——这些是 pi 内部调用，extension 层面无法感知。**唯一出路：修改 pi 的 rpc-mode.ts `createExtensionUIContext()`，让这两个方法也 emit `extension_ui_request` 事件。**

**改动**：
1. 抽取 "思考中..." 指示器为独立状态
2. 新增 `workingMessage` 状态（可被 extension 覆盖）
3. 新增 `workingVisible` 状态（控制指示器显隐）
4. 数据来源：**需修改 pi RPC 模式** 或由 xyz-agent 前端自行根据其他事件（如 agent_start/agent_end）推算状态

### ⚡ ExtensionUIDialog.vue 增强

**改动**：
1. 新增 `method === 'editor'` 分支 → 渲染 `EditorDialog.vue`
2. 支持倒计时自动关闭（`timeout` prop）
3. 倒计时进度条显示

### ⚡ ChatInput.vue 增强（Autocomplete）

> **⚠️ 不可行警告**：pi RPC 模式的 `addAutocompleteProvider` 是完全静默 no-op，不发出任何事件。bridge extension 方案不可行——`addAutocompleteProvider` 是 pi 内部组合调用，extension 无法 hook。**出路**：修改 pi RPC 模式让它也 emit `extension_ui_request`；或由 bridge extension 自行提供补全数据源（不依赖 pi 的 addAutocompleteProvider API）。

**改动**：
1. SlashMenu 之上叠加 extension 注册的自定义补全
2. 补全数据通过 bridge extension 自行提供（不依赖 pi API）
3. 触发规则：`#` 前缀 → issue 编号，`@` 前缀 → 文件引用等（由 extension 定义）

### ⚡ ToolCallCard.vue 增强（Custom Tool Rendering）

**改动**：
1. 新增 `customToolRenderer` 分支
2. 对于非内置工具名，尝试查找注册的自定义渲染器
3. 自定义渲染数据由 bridge extension 通过 tool `details` 字段传递
4. fallback 到 `DefaultToolRenderer.vue`
5. Tool output 截断：大量输出时折叠，显示行数 + "展开" 按钮
6. Tool output 图片：`content` 中 `type: "image"` 的块渲染为 `<img>`

### ⚡ EditToolRenderer.vue 增强（Diff 高亮）

**改动**：
1. 当前只显示 diffSize 数字（如 "+3/-1"），需要增加 inline diff 高亮
2. 解析 tool result details 中的 diff 内容
3. 用颜色区分 added（绿）/ removed（红）/ context（默认）行
4. 支持折叠/展开（折叠时只显示统计，展开时显示完整 diff）

### ⚡ SystemNotification.vue 增强（特殊消息类型）

**改动**：
1. Compaction Summary：compaction 完成后显示摘要（tokensBefore、节省百分比、summary 文本）
2. Branch Summary：tree 导航时显示被放弃分支的摘要（fromId、summary 文本）
3. Skill Invocation：skill 调用时显示 skill 标签 + 调用内容（折叠/展开），前端需解析 `<skill:name>...</skill>` 标签块
4. 数据路由：EventAdapter 需按 `message_start` 中 `msg.role` 区分：`"compactionSummary"` / `"branchSummary"` / `"bashExecution"` / `"custom"`（含 customType），而非只检查 `msg.customType`

### ⚡ ChatPanel.vue 增强（自动重试指示器）

**改动**：
1. 新增 `autoRetryState` 状态：`{ active: boolean, attempt: number, maxAttempts: number, delayMs: number, errorMessage?: string }`
2. 收到 `auto_retry_start` → 显示重试倒计时指示器（"正在重试 (2/3)..."），带取消按钮
3. 收到 `auto_retry_end` → 隐藏指示器；失败时显示最终错误
4. 数据来源：EventAdapter 转发 `auto_retry_start` / `auto_retry_end` 事件

### ⚡ ChatPanel.vue 增强（排队消息可视化）

**改动**：
1. 新增 `queuedMessages` 状态：`{ steering: string[], followUp: string[] }`
2. 在 ChatInput 附近显示排队消息数量和预览（"X 条消息排队中"）
3. 数据来源：EventAdapter 转发 `queue_update` 事件

### ⚡ EventAdapter 增强（关键前置条件）

以下 EventAdapter 修改是多项 GUI 增强的前置条件，必须在对应 GUI 组件开发前完成：

| EventAdapter 修改 | 对应 GUI 组件 | 优先级 |
|-----------------|-------------|--------|
| 增加 `method === 'editor'` 匹配 → 转发 `extension.ui_request` | EditorDialog.vue | P0 |
| 增加 `method === 'set_editor_text'` 匹配 → 转发新 WS 事件 | ChatInput.vue | P0 |
| 区分 `message_start` 中 `msg.role`：`bashExecution` / `compactionSummary` / `branchSummary` | BashToolRenderer / SystemNotification | P1 |
| `tool_execution_end` 保留 image content（`type: "image"` 的 content 块） | ToolCallCard.vue | P1 |
| `tool_execution_update` 透传 `partialResult.details`（当前只取字符串，丢失结构化数据） | BashToolRenderer | P1 |
| 转发 `auto_retry_start` / `auto_retry_end` 事件 | ChatPanel.vue | P1 |
| 转发 `queue_update` 事件 | ChatPanel.vue | P1 |
| 转发 `session_info_changed` 事件 | ChatStore | P1 |
| 转发 `thinking_level_changed` 事件 | AppStatusbar.vue | P1 |
| `agent_end` 附带 `responseModel` 字段 | ChatPanel.vue | P1 |
| `agent_end` 附带 `diagnostics` 字段（暂不渲染，备用） | — | P2 |
| `extension_ui_request` 匹配 `setTitle` method → 转发 WS 事件 | Electron BrowserWindow | P2 |

注意：`message_update` 中的 `toolcall_start/delta/end` 被 EventAdapter 有意跳过（用 `tool_execution_start/end` 代替），这是当前合理的设计决策。如需"正在解析工具调用"中间态可考虑转发。

---

## 四、实现路径

### Phase 0：EventAdapter 前置修改（必须在所有 GUI 改动前完成）

| EventAdapter 修改 | 优先级 | 说明 |
|-----------------|--------|------|
| `extension_ui_request` 增加 `editor` method 匹配 | P0 | 否则 `ctx.ui.editor()` 永远挂起 |
| `extension_ui_request` 增加 `set_editor_text` method 匹配 | P0 | 否则 `ctx.ui.setEditorText()` 静默失败 |
| `message_start` 按 `msg.role` 路由（区分 bashExecution/compactionSummary/branchSummary） | P1 | 当前只检查 customType，遗漏了 4 种特殊消息类型 |
| `tool_execution_end` 保留 image content 块 | P1 | 当前只提取 text blocks，image 被丢弃 |
| `tool_execution_update` 透传 `partialResult.details` | P1 | 当前只取 partialResult 字符串，丢失 BashToolDetails 等结构化数据 |
| 转发 `auto_retry_start` / `auto_retry_end` | P1 | 否则 agent 出错重试时用户以为卡死 |
| 转发 `queue_update` | P1 | 排队消息不可见 |
| 转发 `session_info_changed` | P1 | session 重命名不可见 |
| 转发 `thinking_level_changed` | P1 | thinking level 变更不可见 |
| `agent_end` 附带 `responseModel` | P1 | 模型指示器无法显示实际模型 |
| `agent_end` 附带 `diagnostics` | P2 | 暂不渲染，用于错误诊断后备 |
| `extension_error` 字段名修正：`event.extensionName` → `event.extensionPath`，透传 `event.event` | P0 | 前端永远显示空扩展名 |
| `message_start` custom message 补传 `msg.details` + `msg.display` 字段 | P1 | `display:false` 消息不应渲染 |
| `message_update` 增加 `error` 子类型转发 → `message.stream_error` | P2 | provider 出错时透传具体错误详情 |
| `extension_ui_request` 匹配 `setTitle` | P2 | 成本极低，可选增强 |

### Phase 1：纯前端改动（依赖 Phase 0 EventAdapter 修改）

| 改动 | 依赖 |
|------|------|
| `EditorDialog.vue` 新建 + `ExtensionUIDialog.vue` 增加 editor 分支 | Phase 0: EventAdapter editor 匹配 |
| `ChatInput.vue` 预填充支持 | Phase 0: EventAdapter set_editor_text 匹配 |
| `AppStatusbar.vue` 合并 extension status + thinking level | Phase 0: EventAdapter setStatus + thinking_level_changed |
| `ExtensionUIDialog.vue` 倒计时支持 | CSS 动画 + setTimeout |
| `ToolCallCard.vue` 截断 + 图片渲染 | Phase 0: EventAdapter 保留 image content |
| `SystemNotification.vue` 特殊消息类型 | Phase 0: EventAdapter 区分 message role |
| `BashToolRenderer.vue` 流式输出 + fullOutputPath | Phase 0: EventAdapter 区分 bashExecution role + tool_execution_update details |
| `ChatPanel.vue` 自动重试指示器 | Phase 0: EventAdapter 转发 auto_retry 事件 |
| `ChatPanel.vue` 排队消息可视化 | Phase 0: EventAdapter 转发 queue_update |
| `ChatPanel.vue` responseModel 显示 | Phase 0: EventAdapter 附带 responseModel |
| `SlashMenu.vue` 从 pi 获取命令列表 | RPC command: `get_commands` |
| `ChatPanel.vue` "复制最后回复"功能 | RPC command: `get_last_assistant_text` |
| `ChatPanel.vue` 克隆 session 按钮 | RPC command: `clone` |

### Phase 2：需 bridge extension 或 pi 修改配合

| 改动 | 方案 | 可行性 |
|------|------|--------|
| `CustomMessageRenderer.vue` | 无需 bridge（EventAdapter 已检测 customType） | ✅ 可行 |
| `ChatPanel.vue` working 文案覆盖 | ❌ bridge extension 无法拦截（pi 内部调用）；需**修改 pi RPC 模式** emit `extension_ui_request` | 🔴 需改 pi |
| `WidgetDock.vue` 结构化数据 | pi RPC 模式已 emit `setWidget` 事件（仅 string[]），结构化数据需 bridge extension 主动 emit | 🟡 部分可行 |
| `EditToolRenderer.vue` diff 高亮增强 | EventAdapter 已透传 `tool_execution_end` 的 `details.diff`，无需 bridge | ✅ 可行 |
| `ChatInput.vue` 自定义补全 | ❌ `addAutocompleteProvider` RPC no-op；bridge extension 需自行提供补全数据源（不依赖 pi API） | 🟡 需自行实现 |
| `ToolCallCard.vue` 自定义渲染 | renderCall/renderResult 是 TUI Component，RPC 不透传。需 bridge extension 序列化渲染数据 | 🟡 降级处理 |

### Phase 3：延后

| 改动 | 原因 |
|------|------|
| `ExtensionOverlay.vue` | 成本高，Widget + Dialog 可覆盖多数场景 |
| `ctx.ui.custom()` 全屏组件 | 需重建整个 TUI 渲染管线 |
| `message_update` 中 toolcall_start/delta/end 转发 | 当前用 tool_execution_start/end 代替已足够 |

---

## 五、RPC Commands（xyz-agent → pi 主动命令）

> **审查新增**：pi 通过 RPC 暴露了一组主动命令（xyz-agent 发送，pi 响应），这是 TUI 渠道之外的交互通道。映射文档需覆盖。

### 5.1 消息与控制

| RPC Command | xyz-agent 对接组件 | 状态 | 说明 |
|---|---|---|---|
| `prompt(message, images?, streamingBehavior?)` | `ChatPanel.vue` | ✅ 已有 | 发送用户消息 |
| `steer(message, images?)` | `ChatPanel.vue` | ✅ 已有 | 流式干预 |
| `follow_up(message, images?)` | `ChatPanel.vue` | ✅ 已有 | 流式追加 |
| `abort` | `ChatPanel.vue` | ✅ 已有 | 中止当前 agent loop |
| `new_session(parentSession?)` | `SessionManager` | ✅ 已有 | 新建 session |

### 5.2 状态查询

| RPC Command | xyz-agent 对接组件 | 状态 | 说明 |
|---|---|---|---|
| `get_state` | `ChatStore` | ✅ 已有 | 获取 session 状态（model, thinkingLevel, sessionId 等） |
| `get_messages` | `ChatStore` | ✅ 已有 | 获取消息列表 |
| `get_session_stats` | `ChatStore` | ⏸️ 延后 | token 使用统计。可用于 Context Window 进度条 |
| `get_commands` | `SlashMenu.vue` | ⚡ 增强 | 获取可用 slash commands + skills + prompt templates。**SlashMenu 应从 pi 获取命令列表而非硬编码** |
| `get_available_models` | `ModelSelector.vue` | ✅ 已有 | 获取可用模型列表 |

### 5.3 模型与 Thinking

| RPC Command | xyz-agent 对接组件 | 状态 | 说明 |
|---|---|---|---|
| `set_model(provider, modelId)` | `ModelSelector.vue` | ✅ 已有 | 切换模型 |
| `cycle_model` | `ModelSelector.vue` | ✅ 已有 | 循环切换模型 |
| `set_thinking_level(level)` | `ThinkingLevelSelector.vue` | ✅ 已有 | 设置 thinking level |
| `cycle_thinking_level` | `ThinkingLevelSelector.vue` | ✅ 已有 | 循环切换 thinking level |

### 5.4 队列模式

| RPC Command | xyz-agent 对接组件 | 状态 | 说明 |
|---|---|---|---|
| `set_steering_mode(mode)` | `ChatPanel.vue` | ⚡ 增强 | 控制 steering 队列模式：`all` / `one-at-a-time`。需前端设置入口 |
| `set_follow_up_mode(mode)` | `ChatPanel.vue` | ⚡ 增强 | 控制 followUp 队列模式。需前端设置入口 |

### 5.5 Compaction 与 Retry

| RPC Command | xyz-agent 对接组件 | 状态 | 说明 |
|---|---|---|---|
| `compact(customInstructions?)` | `SessionManager` | ✅ 已有 | 手动触发 compaction |
| `set_auto_compaction(enabled)` | `SettingsPanel.vue` | ⚡ 增强 | 自动 compaction 开关。需前端设置入口 |
| `set_auto_retry(enabled)` | `SettingsPanel.vue` | ⚡ 增强 | **新增**。agent 出错自动重试开关。需前端设置入口 |
| `abort_retry` | `ChatPanel.vue` | ⚡ 增强 | **新增**。取消正在进行的重试。配合 auto_retry UI 中的取消按钮 |

### 5.6 Bash

| RPC Command | xyz-agent 对接组件 | 状态 | 说明 |
|---|---|---|---|
| `bash(command, excludeFromContext?)` | `TerminalPanel.vue` 或 `ChatPanel.vue` | ⏸️ 延后 | 直接执行 bash 命令（不经 agent loop）。终端面板/命令面板需要 |
| `abort_bash` | `TerminalPanel.vue` | ⏸️ 延后 | 中止 bash 执行 |

### 5.7 Session 管理

| RPC Command | xyz-agent 对接组件 | 状态 | 说明 |
|---|---|---|---|
| `switch_session(sessionPath)` | `SessionManager` | ✅ 已有 | 切换 session |
| `fork(entryId)` | `SessionTree.vue` | ✅ 已有 | 从指定 entry fork |
| `clone` | `ChatPanel.vue` | ⚡ 增强 | **新增**。克隆当前 session（从当前 leaf fork） |
| `get_fork_messages` | `SessionTree.vue` | ⚡ 增强 | 获取可 fork 的用户消息列表 |
| `get_last_assistant_text` | `ChatPanel.vue` | ⚡ 增强 | **新增**。获取最近 assistant 文本。可用于"复制最后回复"功能 |
| `set_session_name(name)` | `SessionTab.vue` | ⚡ 增强 | RPC 端设置 session 名称 |
| `export_html(outputPath?)` | `ChatPanel.vue` | ⏸️ 延后 | 导出对话为 HTML。分享/存档功能 |

---

## 六、RPC no-op 渠道汇总

> pi RPC 模式对部分 UI 方法完全静默（不发出任何事件）。xyz-agent 无法感知这些调用。以下汇总所有 no-op 渠道及其影响。

| UI 方法 | RPC 行为 | 影响 | 出路 |
|---|---|---|---|
| `setWorkingMessage` | 静默丢弃 | extension 无法覆盖 working 文案 | 修改 pi rpc-mode.ts emit 事件 |
| `setWorkingVisible` | 静默丢弃 | extension 无法控制 working 显隐 | 修改 pi rpc-mode.ts emit 事件 |
| `setWorkingIndicator` | 静默丢弃 | 同上，但 GUI 用 CSS 动画替代，影响低 | 不处理 |
| `addAutocompleteProvider` | 静默丢弃 | extension 无法注册自定义补全 | 修改 pi rpc-mode.ts emit 事件；或 bridge extension 自行提供补全数据 |
| `setToolsExpanded` | 静默丢弃 | extension 无法控制工具输出展开状态 | 修改 pi rpc-mode.ts emit 事件 |
| `setEditorComponent` | 静默丢弃 | GUI 不需要（前端自己实现编辑器） | 不处理 |
| `getEditorComponent` | 返回 undefined | 无影响 | 不处理 |
| `setFooter` | 静默丢弃 | GUI 不需要（前端自己实现 footer） | 不处理 |
| `setHeader` | 静默丢弃 | GUI 不需要 | 不处理 |
| `onTerminalInput` | 返回空 unsubscribe | 原始终端输入，GUI 不适用 | 不处理 |
| `setHiddenThinkingLabel` | 静默丢弃 | GUI 不需要 | 不处理 |
| `custom()` | 返回 undefined | 全屏自定义组件，成本高 | 延后 |
| `getAllThemes` | 返回空数组 | GUI 有自己的主题系统 | 不处理 |
| `getTheme` | 返回 undefined | 同上 | 不处理 |
| `setTheme` | 返回失败 | 同上 | 不处理 |
