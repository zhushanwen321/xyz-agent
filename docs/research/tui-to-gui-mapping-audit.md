# Pi Agent 执行渲染 → xyz-agent GUI 映射审查报告

> 审查日期：2026-06-04
> 审查范围：pi RPC 模式下发送的所有事件/数据 vs 映射文档覆盖度

## 1. Agent Entry 类型清单

从 pi 源码提取的完整 AgentMessage 类型（`AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`）：

| # | 类型 | role 值 | 来源 |
|---|------|---------|------|
| 1 | **UserMessage** | `"user"` | pi-ai types.ts |
| 2 | **AssistantMessage** | `"assistant"` | pi-ai types.ts |
| 3 | **ToolResultMessage** | `"toolResult"` | pi-ai types.ts |
| 4 | **BashExecutionMessage** | `"bashExecution"` | coding-agent messages.ts（CustomAgentMessages 扩展） |
| 5 | **CustomMessage** | `"custom"` | coding-agent messages.ts（CustomAgentMessages 扩展） |
| 6 | **CompactionSummaryMessage** | `"compactionSummary"` | coding-agent messages.ts（CustomAgentMessages 扩展） |
| 7 | **BranchSummaryMessage** | `"branchSummary"` | coding-agent messages.ts（CustomAgentMessages 扩展） |

### AssistantMessage content 子类型

| # | content.type | 说明 |
|---|-------------|------|
| 1 | `"text"` | 文本内容 |
| 2 | `"thinking"` | 思考/推理内容 |
| 3 | `"toolCall"` | 工具调用 |

### AssistantMessage 特殊字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `stopReason` | `"stop"\|"length"\|"toolUse"\|"error"\|"aborted"` | 停止原因 |
| `errorMessage` | `string?` | 错误信息 |
| `diagnostics` | `AssistantMessageDiagnostic[]?` | 诊断信息（provider 错误/恢复记录） |
| `usage` | `Usage` | token 使用统计 |
| `responseModel` | `string?` | 实际使用的模型名（如 OpenRouter auto → 具体模型） |

## 2. RPC 事件清单

### 2.1 AgentEvent（核心事件，全部通过 `output(event)` 发送到 stdout）

| # | 事件类型 | 说明 | 前端 EventAdapter 处理 |
|---|---------|------|----------------------|
| 1 | `agent_start` | agent 开始处理 | ❌ return null |
| 2 | `agent_end` | agent 结束处理（含 `willRetry`） | ✅ → `message.complete` |
| 3 | `turn_start` | 单轮开始 | ❌ return null |
| 4 | `turn_end` | 单轮结束（含 message + toolResults） | ❌ return null |
| 5 | `message_start` | 消息开始（含完整 message） | ✅ → `message.message_start`（部分处理 customType） |
| 6 | `message_update` | 消息更新（含 `assistantMessageEvent`） | ✅ → thinking/text delta |
| 7 | `message_end` | 消息结束 | ❌ return null |
| 8 | `tool_execution_start` | 工具开始执行（含 toolName, args） | ✅ → `message.tool_call_start` |
| 9 | `tool_execution_update` | 工具执行中间更新（含 partialResult） | ✅ → `message.tool_call_update` |
| 10 | `tool_execution_end` | 工具执行结束（含 result, details, isError） | ✅ → `message.tool_call_end` |

### 2.2 AgentSessionEvent（Session 扩展事件）

| # | 事件类型 | 说明 | 前端处理 |
|---|---------|------|---------|
| 11 | `queue_update` | 排队消息更新（steering/followUp 列表） | ❌ EventAdapter 未处理 |
| 12 | `compaction_start` | 压缩开始（含 reason: manual/threshold/overflow） | ❌ EventAdapter 丢弃，由 session-service 手动发 |
| 13 | `compaction_end` | 压缩结束（含 result/aborted/willRetry/errorMessage） | ❌ EventAdapter 丢弃，由 session-service 手动发 |
| 14 | `session_info_changed` | session 名称变更 | ❌ 未处理 |
| 15 | `thinking_level_changed` | thinking level 变更 | ❌ 未处理 |
| 16 | `auto_retry_start` | 自动重试开始（含 attempt/maxAttempts/delayMs/errorMessage） | ❌ EventAdapter 未处理 |
| 17 | `auto_retry_end` | 自动重试结束（含 success/attempt/finalError） | ❌ EventAdapter 未处理 |

### 2.3 Extension UI 事件（`extension_ui_request`）

| # | method | 说明 | EventAdapter 处理 |
|---|--------|------|-----------------|
| 18 | `select` | 列表选择 | ✅ → `extension.ui_request` |
| 19 | `confirm` | 确认弹窗 | ✅ → `extension.ui_request` |
| 20 | `input` | 单行输入 | ✅ → `extension.ui_request` |
| 21 | `notify` | 通知 | ✅ → `extension.ui_request` |
| 22 | `editor` | 多行编辑 | ❌ **未处理**（EventAdapter 无匹配） |
| 23 | `setStatus` | 状态指示器 | ✅ → `extension:status` |
| 24 | `setWidget` | Widget 内容 | ✅ → `extension:widget` |
| 25 | `set_editor_text` | 预填充编辑器 | ❌ **未处理**（EventAdapter 无匹配） |
| 26 | `setTitle` | 设置标题 | ❌ **未处理**（EventAdapter 无匹配，但 GUI 意义不大） |

### 2.4 其他 RPC 事件

| # | 事件类型 | 说明 | EventAdapter 处理 |
|---|---------|------|-----------------|
| 27 | `extension_error` | extension 错误 | ✅ → `extension.error` |
| 28 | `status` | pi 状态消息 | ✅ → `message.status` |
| 29 | `error` | pi 错误 | ✅ → `message.error` |

## 3. 映射文档已覆盖的项目

映射文档在以下方面覆盖良好：

1. **基础消息渲染**：UserMessage(1.1)、AssistantMessage(1.2)、ThinkingBlock(1.3) — ✅
2. **工具渲染**：bash(1.5)、edit(1.6)、write(1.7)、read(1.8)、默认(1.9) — ✅
3. **Extension UI 弹窗**：confirm(7.1)、select(7.2)、input(7.3)、notify(7.5) — ✅
4. **Extension UI 渠道**：setWidget(3.1-3.3)、setStatus(6.1)、setEditorText(4.1) — ✅
5. **Widget/Status/Header/Footer** 布局区域映射 — ✅（表格层面）
6. **Compaction Summary**(11.1)、Branch Summary(11.2)、Skill Invocation(11.3) — ✅（在特殊消息类型中提及）
7. **CustomMessage**(1.4) — ✅
8. **Tool output 截断**(10.4)、Diff 高亮(10.3)、图片渲染(10.5) — ✅
9. **Tool execution lifecycle**：start/update/end — ✅（EventAdapter 已翻译）

## 4. 遗漏项（按严重度排序）

### 🔴 P0 — 事件完全未处理，影响核心功能

#### 4.1 `editor` extension UI method 未在 EventAdapter 中处理

- **事件**：`extension_ui_request` + `method: "editor"`
- **pi 源码**：`rpc-mode.ts` 的 `createExtensionUIContext()` 中有完整的 `editor()` 实现，发送 `{ method: "editor", title, prefill }` 并等待 `RpcExtensionUIResponse`
- **TUI 渲染**：`ExtensionEditorComponent` — 多行文本编辑器（等宽字体、syntax highlighting）
- **当前问题**：EventAdapter 只匹配 `confirm/select/input/notify`，`editor` method 落入 return null 分支，**前端完全收不到**，extension 的 `ctx.ui.editor()` 调用会永远挂起
- **映射文档状态**：映射文档 7.4 标记为 🔨 新建 `EditorDialog.vue`，但遗漏了**关键的前置条件**：EventAdapter 需要增加 `editor` method 的匹配和转发
- **修复**：EventAdapter 的 `extension_ui_request` case 中增加 `method === 'editor'` 分支

#### 4.2 `set_editor_text` extension UI method 未处理

- **事件**：`extension_ui_request` + `method: "set_editor_text"` + `text` 字段
- **pi 源码**：`rpc-mode.ts` 中 `setEditorText()` 通过 fire-and-forget 发出
- **TUI 渲染**：预填充编辑器内容
- **当前问题**：EventAdapter 不处理 `set_editor_text`，前端收不到预填充指令
- **映射文档状态**：4.1 提到了 `setEditorText` 映射到 `ChatInput.vue`，但**没有指出 EventAdapter 缺失**这一前置条件
- **修复**：EventAdapter 增加 `set_editor_text` 匹配，转发为新的 WS 事件

### 🟡 P1 — 事件/数据已到达前端但映射文档未详细说明渲染方案

#### 4.3 `tool_execution_update` 的 bash 流式输出

- **事件**：`tool_execution_update`，bash 工具通过 `onUpdate` 回调定期推送 `{ content, details }` 含当前输出快照
- **TUI 渲染**：`BashExecutionComponent.appendOutput()` 实时显示命令输出，带 spinner/loader
- **EventAdapter 处理**：转发为 `message.tool_call_update`，`payload.detail` = `event.partialResult`
- **映射文档状态**：10.4 提到了截断，但**没有专门说明 bash 工具的流式输出渲染**。当前 xyz-agent 的 `BashToolRenderer.vue` 是否支持实时追加输出？
- **GUI 建议**：`BashToolRenderer.vue` 需要在收到 `tool_call_update` 时实时显示部分输出（而非只在 `tool_call_end` 后一次性显示）

#### 4.4 `message_start` 中 `customType` 消息类型路由

- **事件**：`message_start` 事件的 `msg` 可含 `customType` 字段（值为 `"compactionSummary"`, `"branchSummary"`, `"custom"`, 或 extension 自定义值如 `"plan-mode"`）
- **EventAdapter**：当前只检测 `msg.customType` 存在就转发 `message.message_start`，但**没有区分消息类型**
- **映射文档状态**：1.4 提到了 CustomMessageRenderer，11.1-11.3 提到了 compaction/branch/skill，但**没有说明这些消息通过哪个 WS 事件到达前端、如何区分**
- **问题**：前端收到 `message.message_start` 后，需要从 payload 中提取 `customType` 来路由到正确的渲染组件。当前 EventAdapter 的 payload 只传了 `customType` 和 `content`（字符串），但缺少 `details`、`display` 等字段
- **修复建议**：EventAdapter 应按 `message.role` 而非 `message.customType` 来路由，将完整的 `CompactionSummaryMessage`（含 `tokensBefore`、`summary`）和 `BranchSummaryMessage`（含 `fromId`、`summary`）数据转发给前端

#### 4.5 `AssistantMessage.diagnostics` 字段

- **数据**：`AssistantMessage.diagnostics: AssistantMessageDiagnostic[]`，包含 provider 错误恢复的详细记录（`{ type, timestamp, error, details }`）
- **TUI 渲染**：TUI 不直接渲染 diagnostics，但它记录了 provider API 错误、自动恢复等对调试有用的信息
- **EventAdapter**：不提取 diagnostics
- **映射文档状态**：**完全未提及**
- **GUI 建议**：暂不渲染，但 `message.complete` 事件中可以附带 diagnostics 数据，用于错误诊断 UI（如 tooltip 显示 provider 错误详情）

#### 4.6 `AssistantMessage.responseModel` 字段

- **数据**：实际使用的模型名（当请求模型是 `auto` 等 routing 模型时，provider 返回具体模型名）
- **TUI 渲染**：Footer 显示实际模型名
- **EventAdapter**：`agent_end` 事件处理中只提取 `stopReason` 和 `usage`，**不提取 `responseModel`**
- **映射文档状态**：**未提及**
- **GUI 建议**：`message.complete` 事件 payload 中应包含 `responseModel`，前端可在模型指示器中显示实际使用的模型

### 🟡 P1 — Session 级事件未映射

#### 4.7 `queue_update` 事件

- **事件**：`queue_update`，包含 `steering: string[]` 和 `followUp: string[]` 排队消息列表
- **TUI 渲染**：Footer 区域显示排队消息数量和预览
- **EventAdapter**：**完全丢弃**，前端收不到
- **映射文档状态**：**完全未提及**排队消息队列
- **GUI 建议**：需要在 ChatPanel 或 ChatInput 附近显示排队消息的数量和预览。用户通过 steer/follow_up 发的消息在 agent 忙时会排队，前端应该展示"X 条消息排队中"

#### 4.8 `auto_retry_start` / `auto_retry_end` 事件

- **事件**：
  - `auto_retry_start`：`{ attempt, maxAttempts, delayMs, errorMessage }`
  - `auto_retry_end`：`{ success, attempt, finalError? }`
- **TUI 渲染**：倒计时 Loader + 可取消重试（Escape 键）+ 重试次数显示
- **EventAdapter**：**完全丢弃**（注释："auto-retry 事件暂不转发"）
- **映射文档状态**：**完全未提及**自动重试
- **GUI 建议**：
  - `auto_retry_start` → 显示重试倒计时指示器（"正在重试 (2/3)..."），带取消按钮
  - `auto_retry_end` → 隐藏指示器，失败时显示最终错误
  - 这是一个**用户可感知的状态**（agent 出错后自动重试），不显示会让用户以为卡住了

#### 4.9 `session_info_changed` 事件

- **事件**：`session_info_changed`，包含 `name: string | undefined`
- **TUI 渲染**：更新终端标题、Footer 显示
- **EventAdapter**：**未处理**
- **映射文档状态**：**未提及**
- **GUI 建议**：session 重命名后需要更新 UI 中的 session 名称显示

#### 4.10 `thinking_level_changed` 事件

- **事件**：`thinking_level_changed`，包含 `level: ThinkingLevel`
- **TUI 渲染**：Footer 和 editor 边框颜色更新
- **EventAdapter**：**未处理**
- **映射文档状态**：**未提及**
- **GUI 建议**：thinking level 变更后更新 UI 状态指示器

### 🟢 P2 — 已覆盖但细节不足

#### 4.11 Skill Invocation 的数据来源不明确

- **数据**：`UserMessage` 的 text 内容中包含 `<skill:name>...</skill>` 块，TUI 通过 `parseSkillBlock()` 解析后渲染为 `SkillInvocationMessageComponent`
- **RPC 模式**：`message_start` 事件中的 `msg.content` 是纯文本（string），前端需要自行解析 skill block
- **映射文档状态**：11.3 提到了 Skill Invocation，但**没有说明前端如何检测和解析** skill block（需匹配 `<skill:xxx>` 标签）
- **修复建议**：映射文档应注明前端需要 `parseSkillBlock()` 的等价逻辑

#### 4.12 BashExecutionMessage 在 RPC 模式下的传输方式

- **数据**：`BashExecutionMessage` 包含 `command, output, exitCode, cancelled, truncated, fullOutputPath, excludeFromContext`
- **RPC 模式**：通过 `message_start` 事件发送（`role: "bashExecution"`）
- **EventAdapter**：`message_start` case 中只检查 `msg.customType`，**不区分 `role: "bashExecution"`**
- **映射文档状态**：1.5 提到了 bash 工具渲染，但 bash execution message（`!command` 用户输入执行的命令）和 tool execution（agent 调用的 bash 工具）是两个不同的概念
- **问题**：`BashExecutionMessage` 是用户通过 `!` 前缀直接执行的命令，不是 agent 的工具调用。在 RPC 模式下，`message_start` 中 `role: "bashExecution"` 的消息会被 EventAdapter 作为普通 `message.message_start` 转发，前端可能无法正确渲染
- **修复建议**：EventAdapter 应识别 `role: "bashExecution"` 并转发完整数据（command, output, exitCode, cancelled, truncated）

#### 4.13 Tool details 字段未完整透传

- **数据**：`tool_execution_end` 事件的 `result` 包含 `details` 字段：
  - `BashToolDetails`：`{ truncation?, fullOutputPath? }`
  - `EditToolDetails`：`{ diff, patch, firstChangedLine? }`
  - `ReadToolDetails`：`{ truncation? }`
- **EventAdapter**：**已提取 `details`** 并放入 `message.tool_call_end` 的 payload 中 ✅
- **映射文档状态**：10.3 提到了 diff 高亮增强，但**没有列出 details 的完整结构**（特别是 `BashToolDetails.truncation/fullOutputPath` 和 `ReadToolDetails.truncation`）
- **GUI 建议**：前端 `BashToolRenderer` 应使用 `details.fullOutputPath` 提供"查看完整输出"链接，`details.truncation` 决定是否显示截断提示

#### 4.14 ToolResultMessage 中的 image 内容

- **数据**：`ToolResultMessage.content` 可包含 `ImageContent`（`{ type: "image", data, mimeType }`）
- **TUI 渲染**：`ToolExecutionComponent` 使用 Kitty protocol / Sixel / iTerm2 渲染内联图片
- **EventAdapter**：`tool_execution_end` 处理时只提取 `type: "text"` 的内容，**丢弃 image blocks**
- **映射文档状态**：10.5 提到了图片渲染，但**没有指出 EventAdapter 会丢弃 image 内容**
- **修复建议**：EventAdapter 应将 `content` 中的 image blocks 序列化传递（如 base64 data URL），前端用 `<img>` 渲染

#### 4.15 `compaction_end` 事件的完整数据未透传

- **事件**：`compaction_end` 含 `{ reason, result: CompactionResult, aborted, willRetry, errorMessage? }`
  - `CompactionResult` 含 `{ summary, firstKeptEntryId, tokensBefore, details? }`
- **当前实现**：session-service 的 `compact()` 方法手动发 `session.compacting` / `session.compacted`，**不包含 result 数据**（tokensBefore、summary 等）
- **映射文档状态**：11.1 提到了 Compaction Summary，但**没有指出 compaction result 数据缺失**
- **修复建议**：session-service 应将 `CompactionResult` 数据随 `session.compacted` 事件发送给前端，用于渲染 compaction summary 消息

## 5. Entry 字段级遗漏

### 5.1 已覆盖但字段不完整的 entry 类型

| Entry 类型 | 映射文档已覆盖的字段 | 遗漏字段 | 影响 |
|-----------|-------------------|---------|------|
| `AssistantMessage` | content (text/thinking/toolCall), stopReason, usage | `diagnostics`, `responseModel` | P1: 调试信息缺失 |
| `ToolResultMessage` | content (text), toolName, toolCallId, isError | `content` 中的 `ImageContent` | P1: 图片内容被 EventAdapter 丢弃 |
| `tool_execution_end` result | content (text), details (diff) | `details.fullOutputPath`（bash）、`details.truncation`（bash/read）、`details.patch`（edit） | P2: 功能缺失 |
| `BashExecutionMessage` | 映射文档视为普通 bash tool | `command, output, exitCode, cancelled, truncated, fullOutputPath, excludeFromContext` | P1: 完整数据未透传 |
| `CompactionSummaryMessage` | 提到了存在 | `tokensBefore`, `summary` | P1: EventAdapter 不区分此 role |
| `BranchSummaryMessage` | 提到了存在 | `fromId`, `summary` | P1: EventAdapter 不区分此 role |
| `CustomMessage` | customType, content | `display`, `details`, `content` 可为 `ImageContent[]` | P2: 结构化数据未完整传递 |

### 5.2 `message_update` 中 `toolcall_start/delta/end` 子类型

- EventAdapter 明确注释"toolcall sub-types carry incremental info but tool_execution_start/end provide the complete, canonical data — skip these to avoid duplicates"
- 这意味着 `message_update` 中的 `toolcall_start/delta/end` **被有意忽略**，用 `tool_execution_start/end` 代替
- **映射文档未提及这个设计决策**
- **潜在问题**：`toolcall_start` 在 `message_update` 中出现时，工具参数可能还在流式接收中（`argsComplete: false`），而 `tool_execution_start` 在**工具实际执行开始**时才触发。两者时间差内，前端无法显示"正在解析工具调用"的中间状态
- **GUI 建议**：当前跳过是合理的简化，但如果需要更流畅的 UI（如实时显示工具名和部分参数），应考虑转发 `toolcall_start/delta`

## 6. 总体评分

### 映射完整度：**75%**

| 维度 | 评分 | 说明 |
|------|------|------|
| 消息类型覆盖 | 90% | 7 种 AgentMessage 类型全部列举，但部分类型的数据透传细节缺失 |
| RPC 事件覆盖 | 65% | 17 种 AgentSessionEvent 中有 6 种完全未提及（queue_update, auto_retry_*, session_info_changed, thinking_level_changed） |
| Extension UI 覆盖 | 80% | 9 种 method 中 3 种未处理（editor, set_editor_text, setTitle） |
| 字段级覆盖 | 60% | 已覆盖的 entry 类型中，多个关键字段（diagnostics, responseModel, image content, details 子字段）未提及 |
| EventAdapter 前置条件 | 50% | 多个映射文档标记为"✅ 已有"或"⚡ 增强"的项目，实际依赖 EventAdapter 的修改，但文档未指出 |

### 关键修复优先级

1. **🔴 P0**：EventAdapter 增加 `editor` method 匹配（否则 `ctx.ui.editor()` 永远挂起）
2. **🔴 P0**：EventAdapter 增加 `set_editor_text` method 匹配（否则 `ctx.ui.setEditorText()` 静默失败）
3. **🟡 P1**：EventAdapter 转发 `auto_retry_start/end`（否则用户看到 agent 卡死）
4. **🟡 P1**：EventAdapter 区分 `message_start` 中的 `role: "bashExecution"/"compactionSummary"/"branchSummary"`，透传完整数据
5. **🟡 P1**：EventAdapter 在 `tool_execution_end` 中保留 image content
6. **🟡 P1**：EventAdapter 转发 `queue_update`（排队消息可视化）
7. **🟢 P2**：`compaction_end` result 数据透传到前端
