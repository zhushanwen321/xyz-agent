# xyz-agent 窗口管理系统设计规格

> 版本: v1 | 日期: 2026-05-10
> 参考: Ghostty 终端的 split 模型

---

## 一、核心模型

### 两层结构：Window > Pane

```
App
├── Window A (BrowserWindow)
│   ├── Pane 1 (session: refactor-auth)    ← 聚焦
│   └── Pane 2 (session: db-migration)
├── Window B (BrowserWindow)
│   ├── Pane 3 (session: add-retry)
│   ├── Pane 4 (session: write-tests)
│   ├── Pane 5 (session: fix-ci)
│   └── Pane 6 (session: update-deps)
└── Window C (BrowserWindow)
    └── Pane 7 (session: new-chat)          ← 空/新对话
```

### 数据结构

```typescript
type PaneTree =
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: [PaneTree, PaneTree]; ratio: number }
  | { type: 'pane'; id: string; sessionId: string | null }

interface AppState {
  windows: WindowState[]
}

interface WindowState {
  id: string
  paneTree: PaneTree
  focusedPaneId: string
}
```

### 硬性约束

- 每个 Window 最多 **4 个 Pane**（叶子节点）
- 超限时 toast 提示"已达面板上限(4)"

---

## 二、窗口 (Window)

### 默认视图（无 sidebar）

```
┌─ Header (48px) ────────────────────────────────────────────┐
│ [≡] xyz-agent              [bell] [grid] [view] [⚙] [☀]   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Pane (session chat)                                       │
│  ├── PanelBar (36px)                                       │
│  ├── Chat Messages                                         │
│  └── ChatInput                                             │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ Statusbar (28px)                                           │
└────────────────────────────────────────────────────────────┘
```

Header 中的 `[≡]` 按钮打开 Sidebar Drawer。默认无 sidebar，主区域占满。

### 创建窗口

| 触发 | 行为 |
|------|------|
| Cmd+N | 新建 BrowserWindow，1 个空 Pane |
| Sidebar 中点击 session（当前窗口已有 2+ Pane） | 新建 BrowserWindow，1 个 Pane 绑定该 session |
| 右键 PanelBar → "移动到新窗口" | 将当前 Pane pop-out 为新 BrowserWindow |

### 关闭窗口

- 所有 Pane 都通过 Cmd+W 或关闭按钮清空后，窗口仍然存在（显示空 Pane）
- 关闭 macOS 原生窗口（点击红绿灯 ×）→ 关闭窗口，销毁所有 Pane
- 最后一个窗口的 macOS 关闭 → 退出 app（现有行为）

---

## 三、面板 (Pane)

### 面板结构

每个 Pane 是一个独立的 ChatPanel，包含：
- **PanelBar** (36px)：Anchor 下拉 + 通知 chip + 关闭按钮（hover 显示）
- **Chat Messages**：当前 session 的对话
- **ChatInput**：输入框 + 模型选择

### 聚焦状态

- **聚焦 Pane**：PanelBar 有微妙的 accent-light 背景
- **非聚焦 Pane**：PanelBar 为默认 surface 色
- 点击 Pane 内任意区域 → 聚焦切换
- Cmd+方向键 → 键盘导航切换聚焦

### 空面板 (sessionId = null)

Cmd+W 关闭最后一个 Pane 的 session 后，Pane 变为空面板：

```
┌─────────────────────────────┐
│                             │
│    选择一个会话开始          │
│                             │
│  ┌─────────────────────┐    │
│  │ refactor-auth       │    │
│  │ db-migration        │    │
│  │ add-retry           │    │
│  └─────────────────────┘    │
│                             │
│  [+ 新建对话]               │
│                             │
└─────────────────────────────┘
```

空面板显示：
- 最近 5 个 session 列表（可点击）
- "新建对话"按钮
- 点击后 Pane 绑定 session，开始对话

### Split 操作

| 操作 | 快捷键 | 行为 |
|------|-------|------|
| 左右分栏 | Cmd+D | 聚焦 Pane 一分为二（水平 split），右侧为新空 Pane |
| 上下分栏 | Cmd+Shift+D | 聚焦 Pane 一分为二（垂直 split），下方为新空 Pane |

Split 后聚焦转移到新 Pane。

### 关闭面板

| 操作 | 行为 |
|------|------|
| Cmd+W | 清空当前 Pane 的 session（变为空面板） |
| PanelBar × 按钮（hover 显示） | 同上 |
| 右键 PanelBar → "关闭面板" | 同上 |

如果关闭的 Pane 有 split 兄弟：
- 移除当前 Pane 和父 SplitNode
- 兄弟 Pane 占满释放的空间
- 聚焦转移到兄弟 Pane

如果关闭的是窗口中唯一的 Pane：
- Pane 变为空面板（不销毁窗口）

### 移动面板

| 操作 | 行为 |
|------|------|
| 右键 PanelBar → "移动到新窗口" | 将当前 Pane pop-out 为新 BrowserWindow，原窗口的 split 自动合并 |

### 调整大小

拖拽 SplitDivider 调整 ratio（现有 SplitDivider 组件可复用）。

---

## 四、Sidebar → Drawer

### 触发方式

| 触发 | 行为 |
|------|------|
| Header `[≡]` 按钮 | 切换 Sidebar Drawer |
| Cmd+B | 切换 Sidebar Drawer |
| Esc（Drawer 打开时） | 关闭 Drawer |

### 表现

- 从左侧滑入，覆盖在 Pane 上方
- 宽度 280px
- **无 backdrop 遮罩**，Pane 仍可见
- 点击 Pane 区域自动关闭 Drawer

### 内容

与现有 Sidebar 相同：
- Session 列表，按 cwd 分组
- 搜索框
- 新建对话按钮

### 点击 Session 的行为

```
点击 session
├── 当前窗口 Pane 数 === 1
│   └── Split Right → 新 Pane 绑定该 session → 关闭 Drawer
├── 当前窗口 Pane 数 >= 2 && < 4
│   └── 新建 Window → 新 Window 的 Pane 绑定该 session → 关闭 Drawer → 聚焦新 Window
└── 当前窗口 Pane 数 === 4
    └── Toast "已达面板上限(4)" → 关闭 Drawer
```

特殊情况：
- 如果点击的 session 已经在某个 Pane 中显示 → 聚焦该 Pane（不创建新 Pane/Window）

---

## 五、窗口总览 (Overview)

### 触发

| 触发 | 行为 |
|------|------|
| Header grid 按钮 | 打开 Overview |
| Cmd+J | 切换 Overview |

### 表现

全屏覆盖，显示所有窗口的缩略图卡片：

```
┌───────────────────────────────────────────────────────────┐
│  窗口总览                                          Esc 返回 │
│                                                           │
│  ┌───────────────────┐  ┌───────────────────┐             │
│  │ Window 1          │  │ Window 2          │             │
│  │ ┌──────┬────────┐ │  │ ┌───────────────┐ │             │
│  │ │auth  │ db-    │ │  │ │ write-tests   │ │             │
│  │ │      │ migr.  │ │  │ │               │ │             │
│  │ └──────┴────────┘ │  │ └───────────────┘ │             │
│  │ 2 panes           │  │ 1 pane            │             │
│  └───────────────────┘  └───────────────────┘             │
│                                                           │
│  [+ New Window]                                           │
│                                                           │
│  Enter 聚焦窗口 · ←→ 选择 · Esc 返回                      │
└───────────────────────────────────────────────────────────┘
```

每张卡片：
- 缩略图展示 split 布局（每个 Pane 显示 session 标题前几个字）
- 窗口标题（可选编辑）
- Pane 数量
- 点击 → 聚焦该 macOS 窗口 + 关闭 Overview

---

## 六、完整快捷键表

| 快捷键 | 作用域 | 行为 |
|--------|-------|------|
| Cmd+N | 全局 | 新建窗口 |
| Cmd+W | 当前 Pane | 清空 session / 合并 split |
| Cmd+D | 当前 Pane | 左右分栏 |
| Cmd+Shift+D | 当前 Pane | 上下分栏 |
| Cmd+B | 全局 | 切换 Sidebar Drawer |
| Cmd+J | 全局 | 切换 Overview |
| Cmd+←/→/↑/↓ | 当前 Window | 切换聚焦 Pane |
| Cmd+1 | 全局 | 标准模式（单 Pane，关闭所有 split） |
| Cmd+, | 全局 | 设置 |

---

## 七、实现路径

### Phase 1：数据层 + 单窗口内 Split

1. 新增 `paneTree` 状态到 store
2. 将现有 `splitMode` boolean 迁移为 PaneTree 二叉树
3. 支持水平 split（左右），Pane 独立绑定 session
4. PanelBar 增加 hover 关闭按钮
5. Cmd+D / Cmd+W 快捷键

### Phase 2：Sidebar → Drawer

1. Sidebar 改为 Drawer 模式（左侧滑入）
2. 点击 session 的分流逻辑（split / new window）
3. Cmd+B 触发

### Phase 3：多窗口

1. Electron 侧：`createWindow()` 工厂函数
2. 窗口间通信（IPC 广播）
3. "移动到新窗口" 右键菜单
4. Cmd+N 创建窗口

### Phase 4：Overview 改造

1. Overview 从 session 卡片改为窗口管理面板
2. 缩略图渲染（CSS 缩放）
3. 窗口间点击聚焦

### Phase 5：垂直 Split + 拖拽

1. Cmd+Shift+D 上下分栏
2. 跨窗口拖拽 Pane（v2）

---

## 八、与现有代码的映射

| 现有组件 | 改造 |
|---------|------|
| `AppSidebar.vue` | 改为 Drawer 模式，加滑入动画 |
| `settingsStore.splitMode` | 移除，替换为 `paneTree: PaneTree` |
| `App.vue` 中两个 `ChatView` | 改为递归渲染 `PaneTree` 组件 |
| `SplitDivider.vue` | 保留，每个 SplitNode 渲染一个 |
| `PanelBar.vue` | 增加 hover 关闭按钮，去掉 `showClose` prop（每个面板都有关闭能力） |
| `Overview.vue` | 从 session 网格改为窗口卡片 |
| `main.ts` | 增加 `createWindow()` 工厂函数 |
| `ipc-handlers.ts` | 增加窗口间通信 IPC |
| `sessionStore` | 增加 `paneId → sessionId` 映射 |
