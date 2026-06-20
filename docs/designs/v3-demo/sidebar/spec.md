# 侧栏 · 多视图容器（设计规范）

**类型**: L0 持久区 · 容器设计规范
**关联**: architecture-and-terminology §1/§3、ui-skeleton.md、shell/spec.md、workspace/spec.md、design-tokens.md
**配套 HTML**: `draft-five-states.html`（容器四态探索稿）
**术语源**: 规范名一律以 architecture-and-terminology §1 为准。

## 背景

Sidebar 早期被当成「会话列表」单一组件设计，导致 Search Modal、File View 等挤进同一画板、术语混乱（`session panel` 歧义、`aside-region` 实现名越界）。术语裁决后明确：Sidebar 是 **L0 持久区**里的一个**多视图容器**，内部承载两个互斥子视图 + 一个隐藏态 + 一个数据空态。本 spec 把这层「容器」语义固化，并切割清楚 Search Modal 的归属。

## 容器四态

| 态 | 名称 | 性质 | 触发 |
|---|---|---|---|
| **A** | 会话列表（Session List） | 默认子视图 | 进入应用 / 点「会话」tab |
| **B** | 文件视图（File View） | 子视图（与 A 互斥） | 点「文件」tab |
| **C** | 收起态（Collapsed） | 容器整体隐藏 | ⌘B / 顶栏按钮 / 左缘条 |
| **D** | 空状态（Empty） | 数据空态（非视图切换） | 会话数=0 |

> 原「Sidebar 五态」中的**搜索浮层（Search Modal）已剥离**：它是 ⌘K 触发的独立 Overlay（模糊背景浮于 Sidebar 之上），不归属 Sidebar 容器。视觉设计见 `overlays/draft-search-modal.html`。Sidebar 仅保留「搜索」**触发入口**（nav 项 + ⌘K）。

## 视图切换机制（A ↔ B）

容器自上而下分层：`Brand` → 主操作 nav（新建 ⌘N / 搜索 ⌘K）→ **Overview 入口按钮**（触发 L1 Overview Region，激活后覆盖 workspace；带 session 计数角标 + ⌘⇧O）→ **segmented tab（会话 | 文件）** → 子视图区 → 用户区。

> **Overview 入口按钮 ≠ segmented tab**：tab（会话|文件）是 sidebar **自家子视图**的互斥切换；Overview 按钮是**外部 L1 Region 的入口**（点击后离开 sidebar 语境，main 区被 Overview 覆盖）。二者分层，不可混排进 tab。激活 Overview 时该按钮转 accent 态，sidebar 整体持久不变。详见 `overview/spec.md` 与 `overview/draft-entry.html`。

- **触发**：① 点 segmented tab；② 快捷键 ⌘1（会话）/ ⌘2（文件）（待定，见遗留）。
- **互斥**：Session List 与 File View 同时只显一个，共享同一容器盒。
- **状态保持**：tab 选择持久化，切换 session / 收起再展开 / 刷新均恢复上次 tab。File View 的目录展开态同理持久化。
- **tab 计数**：每 tab 右侧小字计数（会话 N / 文件 M），不切换即知规模。File View 计数 = **当前 active session** 的改动文件数，非全项目。
- **active session 联动**：切 session 时，File View 自动刷新为新 session 改动；Session List 则迁移高亮。
- **分层理由**：主操作是**动作**（点即触发即结束），视图切换是**状态**（点即停留）——性质不同，故 tab 与 nav 分层，不混排。

## 收起态（C）· 导航能力迁移

Sidebar 完全隐藏（非 56px 折叠条），Workspace 占满全宽。导航能力不丢，三路唤回 + 三按钮迁移：

| 能力 | 展开态位置 | 收起态位置 |
|---|---|---|
| 展开 Sidebar | — | Workspace 顶栏「展开侧栏」按钮 / ⌘B / 左缘细条 hover |
| 后退 / 前进 | 顶部 chrome ⌘[ ⌘] | Workspace 顶栏同名按钮 |
| 新建 / 搜索 | Sidebar nav ⌘N ⌘K | 仅快捷键 ⌘N ⌘K（不进顶栏） |
| 视图切换 tab | segmented tab | **不迁移**——恢复后回到隐藏前 tab |

## 会话项（Session Item）信息结构

Session List 内一行 = 状态点 + 标题 + 目录·分支小字 + 时间；hover 时时间隐去、浮现 2 个方形操作按钮（重命名 / 删除）。详见 `draft-five-states.html` §1。状态点 5 态：running / waiting（带脉冲）/ done / stopped / error。

## 边缘状态与已知限制

| 场景 | 处理 |
|---|---|
| 收起态下切 tab | 不支持，恢复后再切（tab 状态已持久化） |
| File View 点击文件 | 当前仅跳转 Workspace；是否在 Right Drawer 预览 diff 待定 |
| 嵌套目录 >3 层 | 横向省略策略待定（当前每层缩进 10px） |
| 收起左缘细条误触 | 实机验证，必要时改为纯 ⌘B + 顶栏按钮 |

## 遗留

- 视图切换快捷键 ⌘1/⌘2 与 OS 或其它面板冲突待核；不冲突则采纳。
- 会话项 hover 操作目前 2 个（重命名/删除），是否补「置顶 / 归档」待观察。
- 收起态顶栏按钮与展开态 nav 的 active 同步（如「文件」高亮在收起后是否延续）待实机。
- 搜索浮层的键盘导航、最近搜索、无结果态、跨项目范围 → `overlays/draft-search-modal.html`。
