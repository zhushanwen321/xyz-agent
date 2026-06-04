# Pi TUI → xyz-agent GUI 组件映射规格

> 调研日期：2026-06-04
> Demo 页面：[tui-gui-component-mapping-demo.html](../designs/tui-gui-component-mapping-demo.html)

## 一、映射总表

### 图例

| 标记 | 含义 |
|------|------|
| ✅ 已有 | xyz-agent 前端已有对应组件，可直接使用 |
| ⚡ 增强 | 已有组件，需要增加功能/props |
| 🔨 新建 | 需要新建的组件 |
| ⏸️ 延后 | P2 优先级，暂不实现 |
| ❌ 不做 | 不建议实现 |

---

### 按布局区域

#### 1. 消息区（聊天流）

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 1.1 | UserMessage | `MessageBubble.vue` (role=user) | ✅ 已有 | — |
| 1.2 | AssistantMessage (text) | `StreamingMessage.vue` → `MessageBubble.vue` | ✅ 已有 | 流式 → 最终渲染 |
| 1.3 | ThinkingBlock | `ThinkingBlock.vue` | ✅ 已有 | 折叠/展开 |
| 1.4 | CustomMessage (customType) | **`CustomMessageRenderer.vue`** | 🔨 新建 | 按 customType 路由渲染 |
| 1.5 | ToolExecutionComponent (bash) | `BashToolRenderer.vue` | ✅ 已有 | — |
| 1.6 | ToolExecutionComponent (edit) | `EditToolRenderer.vue` | ✅ 已有 | — |
| 1.7 | ToolExecutionComponent (write) | `WriteToolRenderer.vue` | ✅ 已有 | — |
| 1.8 | ToolExecutionComponent (read) | `ReadToolRenderer.vue` | ✅ 已有 | — |
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
| 4.1 | setEditorText | `ChatInput.vue` | ✅ 已有 | 预填充 |
| 4.2 | pasteToEditor | `ChatInput.vue` | ⚡ 增强 | 降级为 setEditorText，丢失 paste/collapse |
| 4.3 | addAutocompleteProvider | **`ChatInput.vue` 增强** | ⚡ 增强 | 叠加 extension 自定义补全 |
| 4.4 | setEditorComponent (vim/emacs) | 无映射 | ❌ 不做 | 纯前端实现，不依赖 pi |
| 4.5 | getEditorText | 不可行 | ❌ 不做 | 同步方法，RPC 无法等待 |

#### 5. Working Indicator 区

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 5.1 | 默认思考指示 | `ChatPanel.vue` | ✅ 已有 | 固定文案 "思考中..." |
| 5.2 | setWorkingMessage | **`ChatPanel.vue` 增强** | ⚡ 增强 | 支持外部文案覆盖 |
| 5.3 | setWorkingVisible | **`ChatPanel.vue` 增强** | ⚡ 增强 | 控制指示器显隐 |
| 5.4 | setWorkingIndicator | 不需要映射 | ❌ 不做 | 动画帧在 GUI 中无意义，CSS 动画更好 |

#### 6. Footer 区

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 6.1 | setStatus(key, text) | **`AppStatusbar.vue` 增强** | ⚡ 增强 | 统一 extension + plugin status |
| 6.2 | setFooter (完全替换) | 无映射 | ❌ 不做 | 完全替换在 GUI 中无意义 |
| 6.3 | setTitle | 不需要映射 | ❌ 不做 | Electron 窗口标题由 app 控制 |

#### 7. 弹窗交互

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 7.1 | confirm(title, msg) | `ExtensionUIDialog.vue` | ✅ 已有 | — |
| 7.2 | select(title, options) | `ExtensionUIDialog.vue` | ✅ 已有 | — |
| 7.3 | input(title, placeholder) | `ExtensionUIDialog.vue` | ✅ 已有 | — |
| 7.4 | editor(title, prefill) | **`EditorDialog.vue`** | 🔨 新建 | 多行编辑 dialog |
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
| 9.3 | setTitle | Electron 窗口标题 | ❌ 不做 | 由 app 层控制 |

#### 10. 工具辅助功能

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 10.1 | setToolsExpanded | `ToolCallCard.vue` | ✅ 已有 | 已有 expand/collapse 功能 |
| 10.2 | renderShell: "self" | 无映射 | ❌ 不做 | TUI 特有概念 |
| 10.3 | Diff 高亮渲染 | **`EditToolRenderer.vue` 增强** | ⚡ 增强 | 当前只显示 diffSize，需增加 inline diff 高亮 |
| 10.4 | Tool output 截断 (VisualTruncate) | **`ToolCallCard.vue` 增强** | ⚡ 增强 | 大量输出折叠，显示行数和 "展开" 按钮 |
| 10.5 | Tool output 图片渲染 | **`ToolCallCard.vue` 增强** | ⚡ 增强 | tool result 中 image 类型的内容渲染为 `<img>` |

#### 11. 特殊消息类型

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 11.1 | Compaction Summary | `SystemNotification.vue` | ⚡ 增强 | compaction 后摘要消息，当前缺失 |
| 11.2 | Branch Summary | 无 | ⚡ 增强 | tree 导航时的分支摘要，当前缺失 |
| 11.3 | Skill Invocation | `MessageBubble.vue` 增强 | ⚡ 增强 | skill 调用时的特殊消息（带 skill 标签） |

#### 12. 其他

| # | pi TUI 概念 | xyz-agent 组件 | 状态 | 备注 |
|---|------------|---------------|------|------|
| 12.1 | extension_error | `SystemNotification.vue` | ✅ 已有协议 | EventAdapter 已翻译 |
| 12.2 | setHiddenThinkingLabel | 无映射 | ❌ 不做 | RPC no-op，隐藏 thinking 标签在 GUI 中无场景 |
| 12.3 | onTerminalInput | 无映射 | ❌ 不做 | 原始终端键盘输入，RPC no-op，GUI 不适用 |

---

## 二、新组件规格

### 🔨 CustomMessageRenderer.vue

**用途**：渲染 pi extension 通过 `pi.sendMessage({ customType, content, display: true })` 发送的自定义消息。

```
文件：components/extension/CustomMessageRenderer.vue
```

**Props**：

| Prop | 类型 | 说明 |
|------|------|------|
| `customType` | `string` | 消息类型标识，如 `"plan-mode"`, `"git-checkpoint"` |
| `content` | `string` | 消息正文 |
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

**集成方式**：在 `ExtensionUIDialog.vue` 中新增 `method === 'editor'` 分支，渲染 `EditorDialog.vue`

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

**改动**：
1. 抽取 "思考中..." 指示器为独立状态
2. 新增 `workingMessage` 状态（可被 extension 覆盖）
3. 新增 `workingVisible` 状态（控制指示器显隐）
4. 数据来源：bridge extension 通过 WS 传递

### ⚡ ExtensionUIDialog.vue 增强

**改动**：
1. 新增 `method === 'editor'` 分支 → 渲染 `EditorDialog.vue`
2. 支持倒计时自动关闭（`timeout` prop）
3. 倒计时进度条显示

### ⚡ ChatInput.vue 增强（Autocomplete）

**改动**：
1. SlashMenu 之上叠加 extension 注册的自定义补全
2. 补全数据通过 bridge extension 的 `addAutocompleteProvider` 传递
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
1. Compaction Summary：compaction 完成后显示摘要（tokensBefore/After、节省百分比）
2. Branch Summary：tree 导航时显示被放弃分支的摘要
3. Skill Invocation：skill 调用时显示 skill 标签 + 调用内容（折叠/展开）
4. 这些消息类型通过 `message_start` 中的特殊标记区分（customType 或 message.role）

---

## 四、实现路径

### Phase 1：纯前端改动（无需 bridge extension）

| 改动 | 依赖 |
|------|------|
| `EditorDialog.vue` 新建 + `ExtensionUIDialog.vue` 增加 editor 分支 | xyz-ui Dialog + Textarea |
| `AppStatusbar.vue` 合并 extension status | EventAdapter 已有 setStatus 转发 |
| `ExtensionUIDialog.vue` 倒计时支持 | CSS 动画 + setTimeout |
| `ToolCallCard.vue` 截断 + 图片渲染 | 前端独立实现 |
| `SystemNotification.vue` 特殊消息类型 | EventAdapter 已有消息转发 |

### Phase 2：需 bridge extension 配合

| 改动 | bridge extension 需要做的 |
|------|-------------------------|
| `CustomMessageRenderer.vue` | 无需 bridge（EventAdapter 已检测 customType） |
| `ChatPanel.vue` working 文案覆盖 | 拦截 setWorkingMessage，通过 bridge 传递文案 |
| `WidgetDock.vue` 结构化数据 | 拦截 setWidget，序列化组件内容为 JSON |
| `EditToolRenderer.vue` diff 高亮增强 | 拦截 edit tool result，解析 diff 内容为结构化数据 |
| `ChatInput.vue` 自定义补全 | 拦截 addAutocompleteProvider，传递补全数据 |
| `ToolCallCard.vue` 自定义渲染 | 拦截 renderCall/renderResult，序列化渲染数据 |

### Phase 3：延后

| 改动 | 原因 |
|------|------|
| `ExtensionOverlay.vue` | 成本高，Widget + Dialog 可覆盖多数场景 |
| `ctx.ui.custom()` 全屏组件 | 需重建整个 TUI 渲染管线 |
