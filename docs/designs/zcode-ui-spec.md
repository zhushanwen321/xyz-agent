# ZCode 风格 Chat UI/UX 规格

本文档描述 xyz-agent 聊天界面应遵循的 ZCode 风格布局与交互规则。重点标记反复讨论、实现时容易出错的边界情况。

## 1. 整体视觉层级（Layered Float）

### 1.1 三层结构

| 层级 | 元素 | 视觉处理 |
|------|------|----------|
| 底层 | 应用背景 | 统一深色画布 `base #0d0d0f`，无边框、无分割线 |
| 中层 | 侧边栏 | 直接坐在底层背景上，无独立面板背景，靠 hover/selected 状态区分 |
| 顶层 | 主内容区 | 浮动圆角面板 `panel #151519`，四周带 margin，有细微外边框 |

### 1.2 主面板

- 与窗口四边保留固定间距（如 `12px`）。
- 圆角统一为 `12px`。
- 外边框 `1px solid rgba(255,255,255,0.06)`。
- 内部不再嵌套多层边框。

## 2. Chat Area 布局（核心规则）

Chat Area 内部采用**固定两栏布局**，总宽度等于主面板内容区宽度。

```
┌─────────────────────────┬─────────────────────────┐
│                         │                         │
│   Message Stream (50%)  │     Right Zone (50%)    │
│                         │                         │
│  ┌───────────────────┐  │  ┌───────────────────┐  │
│  │ messages          │  │  │ Process Panel     │  │
│  │                   │  │  │   or              │  │
│  │ ┌───────────────┐ │  │  │ Right Drawer      │  │
│  │ │ Composer      │ │  │  │                   │  │
│  │ └───────────────┘ │  │  └───────────────────┘  │
│  └───────────────────┘  │                         │
└─────────────────────────┴─────────────────────────┘
```

### 2.1 Message Stream

- **宽度固定为 Chat Area 的 50%**，位于左侧。
- 抽屉打开或关闭时，**stream 宽度不变**，不缩放、不拉伸。
- 内容在 stream 容器内水平居中（或按设计选择占满内边距）。
- 垂直方向可滚动。

### 2.2 Composer / Input

- **必须与 Message Stream 同宽**，视觉上属于同一列。
- 位于 stream 容器底部，与消息列表不重叠。
- 抽屉状态变化时，composer 随 stream 一起保持固定宽度。

### 2.3 Right Zone（右侧 50% 区域）

右侧区域是**互斥容器**，同一时间只显示以下两种状态之一：

| 状态 | 显示内容 | 触发条件 |
|------|----------|----------|
| 默认 | 完整进程卡片（Process Panel） | 抽屉关闭 |
| 抽屉打开 | Diff / 浏览器 / 终端 抽屉 | 用户点击 header 工具栏按钮 |

## 3. 进程面板（Process Panel）

### 3.1 抽屉关闭时

- 完整进程卡片占据 Right Zone 的可用空间。
- 不遮挡 Message Stream。
- 显示完整列表、进度统计、完成项。

### 3.2 抽屉打开时

- 完整进程卡片**隐藏**。
- 在 Message Stream 右上角显示一个 **mini chip**：
  - 内容：`✓ 进程 9/9 ▾`
  - 带展开按钮 `▾`（或类似图标）。
  - 点击后展开一个**临时浮层卡片**，显示完整进程信息。
  - 再次点击关闭按钮或点击其他区域可关闭浮层。

### 3.3 关键注意点

> **[CRITICAL]** 抽屉打开时，进程面板**不能**仍然以完整卡片形式占据 Right Zone，否则会和抽屉重叠或导致布局混乱。
>
> **[CRITICAL]** mini chip 必须位于 Message Stream 内部右上角，而不是 drawer 内部或 header 上。
>
> **[CRITICAL]** 从完整卡片切换到 mini chip 必须有平滑过渡动画（scale/opacity），不能生硬跳变。

## 4. 右侧抽屉（Right Drawer）

### 4.1 尺寸与位置

- 宽度固定为 Chat Area 的 **50%**。
- 从右侧滑入滑出，使用 `translate-x` 动画，**禁止通过改变 width 实现**。
- 抽屉关闭时位于可视区域右侧外（`translate-x-full`）。

### 4.2 内容标签

抽屉顶部有标签栏，至少支持：

- **Diff**：代码 diff 视图。
- **浏览器**：网页预览区。
- **终端**：命令行输出。

### 4.3 打开/关闭触发

- Chat Area header 右上角有三个工具按钮：浏览器、Diff、终端。
- 点击任一按钮：打开抽屉并切换到对应标签。
- 点击抽屉右上角 `✕` 或再次点击当前高亮按钮：关闭抽屉。

### 4.4 动画要求

| 元素 | 动画属性 | 说明 |
|------|----------|------|
| Drawer | `transform: translateX(...)` | 左右平移，固定宽度 |
| Process Panel | `opacity + transform(scale/translate)` | 展开/收起 |
| Message Stream | 无动画或仅背景色过渡 | 宽度不变，不需要移动 |

## 5. 消息流细节

### 5.1 消息气泡

- 用户消息：右对齐，最大宽度 80%，圆角气泡。
- AI 消息：左对齐，带头像，文本占满 stream 内容区。
- 代码、工具调用卡片使用等宽字体和深色嵌套背景。

### 5.2 Reasoning Block

- 可折叠的思考过程块。
- 标题左侧显示状态图标（运行中 spin / 完成 ✓）。
- 内部可嵌套 Tool Call Card。

## 6. 颜色与间距 Token

```css
--base: #0d0d0f;
--panel: #151519;
--panel-hover: #1b1b20;
--accent: #4f8ef7;
--success: #22c55e;
--border: rgba(255,255,255,0.06);
--text-primary: #f0f0f5;
--text-secondary: #8a8a95;
--text-tertiary: #5a5a65;
```

- 主面板外边框 `1px solid var(--border)`。
- Header 底部分隔线 `1px solid var(--border)`。
- Drawer 左侧分隔线 `1px solid var(--border)`。
- 其他区域尽量不添加额外边框。

## 7. 常见实现误区

以下问题在 demo 迭代中反复出现，开发时必须避免：

1. **Message Stream 宽度随抽屉变化**
   - 错误：抽屉打开时 stream 变窄或居中偏移。
   - 正确：stream 始终占 Chat Area 50% 宽度。

2. **Composer 与 stream 不同宽**
   - 错误：composer 通栏或宽度独立。
   - 正确：composer 必须和 stream 同一列、同宽度。

3. **进程面板在抽屉打开时仍显示完整卡片**
   - 错误：完整卡片与抽屉重叠。
   - 正确：切换为 mini chip，点击展开浮层。

4. **抽屉动画使用 width 变化**
   - 错误：抽屉宽度从 0 到 50% 动画。
   - 正确：固定 50% 宽度，使用 translate-x 平移。

5. **进程面板切换无动画**
   - 错误：完整卡片直接消失，mini chip 突然出现。
   - 正确：使用 opacity/scale 过渡。

6. **Sidebar 添加独立背景面板**
   - 错误：sidebar 有圆角卡片背景。
   - 正确：sidebar 与底层背景融为一体。

## 8. 参考实现

当前目录下 `zcode-demo/` 为可运行 HTML demo，使用 Vue 3 CDN + Tailwind CDN 实现。实现真实项目组件时，以此为视觉与交互参考。

```
docs/designs/zcode-demo/
├── index.html
├── main.js
├── App.js
├── ChatView.js
├── SettingsView.js
├── components/
│   ├── NavItem.js
│   ├── ProcessPanel.js
│   ├── ReasoningBlock.js
│   ├── RightDrawerContent.js
│   └── ToolCallCard.js
├── style.css
└── README.md
```
