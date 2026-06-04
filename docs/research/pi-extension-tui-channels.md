# Pi Extension 修改 TUI 的渠道清单

> 调研日期：2026-06-04
> 来源：Pi 官方文档 `extensions.md` + `tui.md`

## 概述

Pi extension 通过 `ExtensionAPI` 和 `ExtensionContext` 提供全面的 TUI 定制能力，覆盖消息区、Header、Widget、Editor、Working Indicator、Footer 六个布局区域，加上全屏/浮层组件、弹窗交互、主题系统三条横切通道。

---

## 一、消息区（聊天流）

| 渠道 | API | 说明 |
|------|-----|------|
| 自定义消息渲染 | `pi.registerMessageRenderer(customType, renderer)` | 按 `customType` 匹配消息，自定义渲染为 `Component`。配合 `pi.sendMessage({ customType, content, display: true })` |
| 自定义工具渲染（调用态） | `registerTool({ renderCall })` | 工具调用时的渲染，返回 `Component` |
| 自定义工具渲染（结果态） | `registerTool({ renderResult })` | 工具执行完成后的渲染，支持 `expanded`/`isPartial` 状态 |
| 工具 Shell 自渲染 | `registerTool({ renderShell: "self" })` | 完全接管工具行的外框/背景/布局，绕过默认 Box 包装 |
| 工具展开状态 | `ctx.ui.setToolsExpanded(true/false)` | 控制所有工具输出是否展开 |

### renderCall / renderResult 的 context 对象

```typescript
{
  args,              // 当前工具调用参数
  state,             // call ↔ result 跨 slot 共享状态
  lastComponent,     // 上一次返回的 Component（可复用）
  invalidate(),      // 请求重新渲染
  toolCallId, cwd, executionStarted, argsComplete, isPartial, expanded, showImages, isError
}
```

## 二、Header 区

| 渠道 | API | 说明 |
|------|-----|------|
| 启动 Header | `ctx.ui.setHeader` | 替换启动时显示的头部信息 |

## 三、Widget 区（编辑器上方/下方）

| 渠道 | API | 说明 |
|------|-----|------|
| Widget（编辑器上方） | `ctx.ui.setWidget("id", ["line1", "line2"])` | 默认 placement |
| Widget（编辑器下方） | `ctx.ui.setWidget("id", lines, { placement: "belowEditor" })` | 编辑器下方 |
| Widget（组件模式） | `ctx.ui.setWidget("id", (tui, theme) => ({ render, invalidate }))` | 主题感知的组件式渲染 |

## 四、Editor 区

| 渠道 | API | 说明 |
|------|-----|------|
| 自定义编辑器 | `ctx.ui.setEditorComponent(factory)` | 替换输入编辑器（vim 模式等），继承 `CustomEditor` |
| 编辑器文本 | `ctx.ui.setEditorText(text)` / `ctx.ui.getEditorText()` | 预填充/读取编辑器内容 |
| 粘贴到编辑器 | `ctx.ui.pasteToEditor(text)` | 触发粘贴处理（大内容自动折叠） |
| Autocomplete 扩展 | `ctx.ui.addAutocompleteProvider(fn)` | 在内置补全之上叠加自定义补全（如 `#issue` 编号） |

### CustomEditor 要点

- 继承 `CustomEditor`（不是基础 `Editor`）获取 app keybindings
- 未处理的 key 调用 `super.handleInput(data)`
- factory 接收 `(tui, theme, keybindings)`
- 用 `ctx.ui.getEditorComponent()` 获取当前 factory 以包装/组合

## 五、Working Indicator 区（流式输出时）

| 渠道 | API | 说明 |
|------|-----|------|
| Working 文案 | `ctx.ui.setWorkingMessage("...")` | 替换流式输出时的等待文案 |
| Working 动画帧 | `ctx.ui.setWorkingIndicator({ frames, intervalMs })` | 自定义动画帧（颜色/样式/速度），空数组则隐藏 |
| Working 可见性 | `ctx.ui.setWorkingVisible(bool)` | 控制整个 working loader 行的显隐 |

## 六、Footer 区

| 渠道 | API | 说明 |
|------|-----|------|
| 状态指示器 | `ctx.ui.setStatus("id", text)` | Footer 中持久状态标记，多个 extension 各自占位 |
| 自定义 Footer | `ctx.ui.setFooter((tui, theme, footerData) => Component)` | 完全替换 Footer |

### footerData 提供

- `getGitBranch(): string | null`
- `getExtensionStatuses(): ReadonlyMap<string, string>`
- `onBranchChange(callback): () => void`（响应式）

## 七、全屏/浮层组件

| 渠道 | API | 说明 |
|------|-----|------|
| 全屏自定义组件 | `ctx.ui.custom(factory)` | 临时替换编辑区为自定义组件，直到 `done()` 被调用 |
| 浮层 Overlay | `ctx.ui.custom(factory, { overlay: true })` | 不清屏，浮层叠加在现有内容之上 |
| Overlay 定位 | `overlayOptions` | 见下表 |

### overlayOptions 参数

```typescript
{
  anchor?: string,    // 9 个位置：center, top-left, top-center, top-right, right-center, ...
  width?: number | string,    // 绝对值或百分比 "50%"
  minWidth?: number,
  maxHeight?: number | string,
  row?: number | string,      // 百分比或绝对值
  col?: number | string,
  offsetX?: number,
  offsetY?: number,
  margin?: number | { top, right, bottom, left },
  visible?: (termWidth, termHeight) => boolean,  // 响应式显隐
}
```

## 八、弹窗交互（Dialog）

| 渠道 | API | 说明 |
|------|-----|------|
| 选择 | `ctx.ui.select(title, items)` | 列表选择 |
| 确认 | `ctx.ui.confirm(title, msg, { timeout? })` | 确认弹窗，支持倒计时自动关闭 |
| 输入 | `ctx.ui.input(title, placeholder)` | 单行输入 |
| 多行编辑 | `ctx.ui.editor(title, prefill)` | 多行文本编辑 |
| 通知 | `ctx.ui.notify(msg, "info" \| "warning" \| "error")` | 非阻塞通知 |

所有 dialog 支持 `timeout` 和 `AbortSignal`。

## 九、主题与外观

| 渠道 | API | 说明 |
|------|-----|------|
| 切换主题 | `ctx.ui.setTheme(name \| Theme)` | 切换配色方案 |
| 获取主题列表 | `ctx.ui.getAllThemes()` | 所有可用主题 |
| 当前主题对象 | `ctx.ui.theme` | `theme.fg(color, text)` / `theme.bg(color, text)` / `theme.bold()` 等 |
| 终端标题 | `ctx.ui.setTitle(text)` | 设置终端窗口标题 |

### 主题颜色分类

**前景色** (`theme.fg(color, text)`)：
- 通用：`text`, `accent`, `muted`, `dim`
- 状态：`success`, `error`, `warning`
- 边框：`border`, `borderAccent`, `borderMuted`
- 消息：`userMessageText`, `customMessageText`, `customMessageLabel`
- 工具：`toolTitle`, `toolOutput`
- Diff：`toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`
- Markdown：`mdHeading`, `mdLink`, `mdCode`, `mdCodeBlock`, ...
- 语法高亮：`syntaxComment`, `syntaxKeyword`, `syntaxFunction`, ...
- Thinking：`thinkingOff`, `thinkingMinimal`, ..., `thinkingXhigh`

**背景色** (`theme.bg(color, text)`)：
`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`

## 十、内置 TUI 组件库（`@earendil-works/pi-tui`）

| 组件 | 用途 |
|------|------|
| `SelectList` | 带搜索的列表选择 |
| `SettingsList` | 开关/多值设置列表 |
| `BorderedLoader` | 带取消的异步操作 loader |
| `Text` | 多行文本（自动换行） |
| `Box` | 带内边距和背景的容器 |
| `Container` | 垂直布局容器 |
| `Spacer` | 空白间隔 |
| `Markdown` | Markdown 渲染（语法高亮） |
| `Image` | 终端内图片显示 |
| `Input` | 单行输入（IME 支持） |
| `DynamicBorder` | 自适应边框 |

### Component 接口

```typescript
interface Component {
  render(width: number): string[];       // 每行不超过 width
  handleInput?(data: string): void;      // 键盘输入
  wantsKeyRelease?: boolean;             // Kitty 协议 key release
  invalidate(): void;                    // 清除缓存
}
```

### Focusable 接口（IME 支持）

```typescript
interface Focusable {
  focused: boolean;  // TUI 自动设置
}
```

使用 `CURSOR_MARKER` 标记光标位置，实现 IME 候选窗口正确定位。

## 附录：TUI 布局区域示意

```
┌─────────────────────────────────────────┐
│ Header（ctx.ui.setHeader）              │
├─────────────────────────────────────────┤
│                                         │
│ 消息区                                  │
│ - registerMessageRenderer               │
│ - registerTool renderCall/renderResult   │
│ - registerTool renderShell: "self"       │
│                                         │
├─────────────────────────────────────────┤
│ Widget - aboveEditor                    │
│ (ctx.ui.setWidget, placement: default)  │
├─────────────────────────────────────────┤
│ Working Indicator                       │
│ (setWorkingMessage/Indicator/Visible)   │
├─────────────────────────────────────────┤
│ Editor 输入区                           │
│ (setEditorComponent/setEditorText/      │
│  pasteToEditor/addAutocompleteProvider) │
├─────────────────────────────────────────┤
│ Widget - belowEditor                    │
│ (ctx.ui.setWidget, placement: below)    │
├─────────────────────────────────────────┤
│ Footer                                  │
│ (setStatus / setFooter)                 │
└─────────────────────────────────────────┘
```
