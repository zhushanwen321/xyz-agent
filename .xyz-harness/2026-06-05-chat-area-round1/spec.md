---
verdict: pass
---

# Chat Area — 第一轮优化

## Background

当前聊天区域在功能完整性上存在明显缺口：用户无法对已发送消息执行任何操作（复制、编辑、分支管理等），缺少批量操作能力，长对话缺乏滚动导航工具，分屏模式下缺少伸缩布局支持。设计评审（`docs/chat-area-critique-and-features.md`）识别出这些问题，并经过多轮交互式 demo 验证，确定了本轮优化范围。

本轮覆盖 9 项高影响力、低至中复杂度的改进，不涉及架构重构或新子系统。

## Functional Requirements

### FR1: 消息操作菜单

每条消息右上角提供 `⋯` 按钮，hover 显现，点击展开下拉菜单。

对齐规则：
- **助手消息**（左对齐）：`⋯` 在气泡**右侧** `right: -34px`
- **用户消息**（右对齐）：`⋯` 在气泡**左侧** `left: -34px`

菜单包含：
1. **复制**（默认 markdown 源码格式，含 thinking + tool call 内容）
2. **复制纯文本**（strip markdown 语法）
3. — 分割线 —
4. **Navigate** — 跳转到树中当前 entry
5. **Fork** — 从当前 entry 分支出新会话，命名追加 `-fork` 后缀
6. **Clone** — 克隆当前会话，命名追加 `-clone` 后缀

菜单关闭：点击菜单外区域 或 按 `Esc`。

### FR2: 单条复制

实现 `collectMessageContent()` 函数，从消息 wrapper 中收集：
- 同组 thinking block 内容（展开后的文本）
- 同组 tool call card 内容（工具名 + 状态 + 路径）
- 气泡正文

复制到剪贴板时使用 `navigator.clipboard.writeText()`。成功/失败通过 Toast 反馈（> 已复制 样式，1.5s 自动消失）。

### FR3: 批量选择 & 复制

交互流程：
1. 点击 panel header 的 `≡` 按钮进入**选择模式**
2. 所有消息（user + assistant）左侧出现 hover 显现的 checkbox
3. 点击消息切换选中状态（选中后 outline + accent 边框 + ✓ 标记）
4. 顶部 sticky 浮动栏显示「已选 N 条消息」
5. 浮动栏提供「复制 Markdown」和「复制纯文本」按钮
6. 点击「取消」退出选择模式
7. 批量复制时每条消息输出格式：
   ```
   --- 助手 14:23 ---
   [Thinking: ...]
   [Tool: read ✓ src/file.ts]
   消息正文...
   ```

### FR4: 分支指示器

每条消息气泡底部显示分支情况：

- **无分支**（children ≤ 1）：半透明 pill，显示 `1`，不可点击
- **有分支**（children > 1）：完整 pill，显示分支数，hover 高亮
- 点击展开分支列表 dropdown：
  - 每项：状态圆点 + 分支名
  - 当前活跃分支高亮（accent 色 + active 标记）
  - 点击分支 → 触发 navigate 到目标 entry
- 点击外部关闭 dropdown

数据来源：`stores/tree.ts` 的 `BranchTab[]`，通过 `getActivePath()` 获取。

### FR5: Utility Rail

每个 panel 右侧的独立 36px 列，与 `chat-content`（消息 + 输入框）同级，**全高贯穿 panel-body**：

```
panel-body (flex row)
├── chat-content (flex column, flex:1) ← 消息 + 输入框
└── utility-rail (36px, flex-shrink:0) ← 全高
```

内含（由底向上）：
- 底部分隔线
- **↓ 回到底部**按钮（scroll > 40px 时 visible，否则隐藏）
- **↑ 回到顶端**按钮（scrollHeight - scrollTop - clientHeight > 40px 时 visible）
- 分隔线
- 3 个 indicator 小圆点（占位，opacity 0 → hover 时 0.6）

按钮 hover 显现：panel-body 整体 hover 时 opacity 0→1。

### FR6: 侧边栏折叠

三种折叠/展开入口：
1. 侧边栏 **右边缘手柄**（窄条，hover 高亮）
2. 侧边栏 **header 右上角** `◀` 按钮
3. 折叠后 **左边缘** `▸` 按钮（fixed 定位）

折叠时 `sidebar { width: 0; border-right: none }`，整体 `transition: width 0.2s ease`。
展开时恢复原始宽度。

### FR7: macOS 全屏布局适配

布局分两种状态，通过 `isFullscreen` class 控制：

**窗口化：**
```
Row1: [padding-left: 68px 给交通灯] [nav buttons] [◀ 折叠]
Row2: [xyz-agent v0.x.x] [                      + New Session]
```
- Row1 左侧 `padding-left: 68px` 留出 3 个 macOS 交通灯空间
- 品牌标识在 Row2

**全屏：**
```
Row1: [xyz-agent v0.x.x] [nav buttons] [◀ 折叠]
Row2: [              + New Session (100% width)              ]
```
- 品牌标识上移 Row1，占据交通灯位置
- New Session 按钮变为 `width: 100%` 通栏宽按钮
- Row1 不再需要交通灯 padding

当前 `isFullscreen` 通过 Electron 的 fullscreen change 事件检测（TODO 项），demo 中使用 toggle 模拟。

### FR8: 发送模式状态栏

输入框上方 20px 高的状态栏，展示当前发送模式：

```
┌──────────────────────────────────────┐
│  Steer · AI 处理中，消息将中断流程   Alt+Enter 排队 │ (20px)
├──────────────────────────────────────┤
│  [textarea]                          │
└──────────────────────────────────────┘
```

三种模式：

| 模式 | 触发 | 状态栏显示 | 发送动作 |
|------|------|-----------|---------|
| **Send** | 默认（Enter） | `Send · Enter 发送`（灰色） | `message.send` |
| **Steer** | 流式时自动切换 | `Steer · 将中断当前 AI 处理`（accent 色） | `message.steer` |
| **Queue** | 按住 Alt 键 | `Queue · Alt+Enter 排队`（warning 色） | `message.follow_up` |

发送按钮始终一个：
- 空闲时：accent 背景，↑ 图标
- 流式时：红色背景，■ 图标（stop）

### FR9: Fork / Clone 命名

后端 `rebindAfterFork` 时修改 session label：
- Fork：`原名称-fork`
- Clone：`原名称-clone`

通过 `session-service.ts` 的 `rebindAfterFork` 方法传递修改后的 label。

## Acceptance Criteria

| # | 条件 | 验证方式 |
|---|------|---------|
| AC1 | 每条消息 hover 显示 `⋯`，点击弹出操作菜单 | 手动测试 |
| AC2 | 复制消息写入剪贴板，Toast 反馈成功/失败 | 手动测试 |
| AC3 | 批量选择模式切换正确，选中/取消/计数正常 | 手动测试 |
| AC4 | 批量复制包含 thinking block 和 tool call 内容 | 比较输出文本 |
| AC5 | 分支 pill 数字正确，点击展开分支列表，点击分支触发 navigate | 手动测试 |
| AC6 | Utility rail 出现在每个 panel 右侧，全高贯穿，按钮 hover 显隐正确 | 视觉检查 |
| AC7 | 滚动按钮仅在非顶端/底端时可见 | 手动测试 |
| AC8 | 侧边栏折叠/展开流畅，三种入口都有效 | 手动测试 |
| AC9 | macOS 窗口化/全屏两种布局各元素位置正确 | 视觉检查 |
| AC10 | Fork 后 session 名为 `原名称-fork`，Clone 后为 `原名称-clone` | 检查 session 列表 |
| AC11 | 流式时发送模式自动切换 Steer，Alt 键切换 Queue | 手动测试 |
| AC12 | 分屏模式下每个 panel 有独立 rail | 视觉检查 |

## Constraints

- **设计系统**：必须遵循 `style.css` 的 CSS 变量体系（Warm & Soft 主题），不使用硬编码颜色
- **组件库**：使用现有 xyz-ui 或 design-system 组件（Button/Textarea/Dropdown），不新增原生 HTML 表单元素
- **状态管理**：遵循现有 Pinia store 模式，按 `sessionId` 分区
- **协议**：sidecar WS 协议需新增 `message.steer` 和 `message.follow_up` 类型（参考 `rpc-types.ts` 中 pi 的 `steer` / `follow_up` RPC 命令）
- **复制格式**：默认 markdown 源码，纯文本模式 strip markdown 符号（`# * [ ]` 等）
- **无 Emoji**：所有图标使用 inline `<svg>` 或 `lucide-vue-next`
- **Fork/Clone 命名**：追加 `-fork` / `-clone` 后缀，不做其他修改

## Out of Scope

以下功能明确不在本轮范围：

- 消息搜索 / 全文搜索
- 摘要目录导航（TOC）
- 缩略树视图（side-tree miniview）
- 编辑已发送消息
- 输入历史（↑ 恢复上一条）
- 草稿持久化
- 批量选择拖拽/框选
- Queue 排队消息的 UI 展示（仅后端排队，无前端显示）
- 动画/过渡效果（仅限于 sidebar collapse 的基础 transition）

## Complexity Assessment

**整体评估：Medium** — 9 项功能彼此独立，单功能复杂度低至中。主要风险点：
1. Fork/Clone 命名后端的修改涉及 `session-service.ts` 的 `rebindAfterFork`
2. WS 协议扩展需对齐 `shared/src/protocol.ts` 和 `runtime/src/server.ts`
3. macOS fullscreen 检测需在 Electron 主进程或 preload 中实现
4. Utility rail 的布局改动涉及 `PanelBody` 组件的 flex 结构调整

## Key Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| Rail 布局 | `chat-content` + `utility-rail` 同级 flex | 不与输入框视觉冲突，全高贯穿 |
| 发送模式指示 | 输入框上方 20px 状态栏 | 不占用 toolbar 空间，键盘无切换冲突 |
| 复制数据范围 | 含 thinking + tool call | 用户明确要求 |
| Queue UI | 不展示 | 用户明确要求暂时不做 |
| Fork/Clone 后缀 | `-fork` / `-clone` | 用户确认 |
| 侧边栏折叠宽度 | `width: 0`（非 `display: none`） | 保持 transition 动画 |
