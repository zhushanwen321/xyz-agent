# Overview · 多会话鸟瞰（设计规范）

**类型**: L1 Region · 独立视图区（与 Sidebar / Workspace 并列）
**关联**: architecture-and-terminology §1（Overview = Mission Control）、ui-skeleton.md、workspace/spec.md、sidebar/spec.md、design-tokens.md
**配套 HTML**: `draft-overview.html`（卡片网格 + 筛选排序稿）
**术语源**: 规范名以 architecture-and-terminology §1 为准。废弃词：Mission Control（v1 删，用 Overview）、dashboard（歧义）。

## 背景

早期 `ui-skeleton.md` 把 Overview 当作 workspace 内的一个 view（与 ChatView / DiffView 同级），而术语表把它定为独立 L1 Region。两者触发路径不冲突——一个说"层级归属"，一个说"从哪进"。**裁决（已定）**：按**独立 L1 Region** 定，与 Sidebar、Workspace 并列；**入口从 sidebar「Overview」按钮进入，激活后覆盖整个 workspace（main）区**，sidebar 持久不变——不挤进 workspace view 切换器，也不是 sidebar 的子视图。触发落点冲突已于 2026-06-20 收口（见 ADR-0022）。

Overview 解决的问题：当 session 数量超过 Sidebar Session List 的舒适承载（日常 3–5 个），用户需要**鸟瞰**全局——尤其同时跑多个后台 agent 时。Session List 是"导航/切换"取向（紧凑、单列、快速点选）；Overview 是"统筹/监控"取向（卡片、网格、信息密集、可筛选排序）。两者**不重复**，是同一批 session 数据的两种呈现密度。

## 触发与定位

| 场景 | 用 Session List | 用 Overview |
|---|---|---|
| 日常 3–5 session 切换 | ✅ 主用 | — |
| 10+ session 找某个 | 滚动累 | ✅ 网格 + 筛选 |
| 监控多个后台 agent | 徽标可见但分散 | ✅ 进度聚合鸟瞰 |
| 新建会话 | ⌘N 即可 | ✅ 顶部入口 + 模板 |

**入口：sidebar「Overview」入口按钮**（主操作区，带 session 计数角标）/ 快捷键 **⌘⇧O** / session 数超阈值时提示。激活后 Overview **覆盖整个 workspace（main）区**，sidebar 持久。**退出**：点任意卡片 → 载入该 session 回 workspace，或 Esc。

**配套 demo**：`draft-entry.html`（入口+覆盖关系）+ `draft-overview.html`（卡片网格内容、筛选排序、后台 agent 聚合）。

## 布局

自上而下三层：**工具栏**（新建 + 筛选 + 排序 + 视图密度切换）→ **卡片网格**（响应式，默认 3–4 列）→ **空状态**（session=0）。

- 网格列数随视口：宽屏 4 列 / 笔记本 3 列 / 窄屏 2 列 / 移动 1 列。卡片最小宽度 ~280px，等高对齐。
- 卡片间距 16px（`--space-4`），无分隔线，靠间距与 surface 底区分。

## Session 卡片信息结构

卡片 = Session Item（<code>sidebar/draft-session-item</code>）的**鸟瞰放大版**，复用同一信息原子，密度上调一档：

| 区 | 内容 | 来源 |
|---|---|---|
| 头部 | 状态圆点（5 态，同 Session Item）+ 标题 + 分支 pill | Session Item §1/§2 |
| 摘要 | 最后一条 assistant 消息摘要（1–2 行 ellipsis） | message-stream |
| 指标 | 改动文件数 / 消息回合数 / 运行时长 | file-changes + stream |
| 后台 agent | 若有子 agent 在跑：进度条 + 计数（复用 flow-3 progress 聚合） | flow-3 |
| 时间 | 最后活动时间（相对：2 分钟前） | Session Item |
| 角标 | 未读 / 错误 / 冲突待解决（Badge） | Session Item §5 |

卡片用 design-system **Card** 原语（surface 底 + border + radius）。激活/选中态走 **Card-Active**（inset accent ring，与 Session Item 激活一致，弃左竖条）。hover 走 surface-hover + 轻微 shadow-2。

## 筛选与排序

**筛选**（工具栏左侧，多选 chip）：
- 状态：running / waiting / done / stopped / error（5 态，同 Session Item）
- 项目：按 repo / worktree 分组
- 标记：未读 / 有冲突 / 有后台 agent

**排序**（下拉）：
- 最近活动（默认）· 活跃度（消息频率）· 创建时间 · 标题字母序

筛选 + 排序状态持久化（同 Session List tab 持久化惯例）。

## 交互

- **点卡片** → workspace 载入该 session（双 Panel），Overview 退出。卡片在载入前有 1 帧激活反馈。
- **新建会话**：工具栏 Primary 按钮 + ⌘N。可选模板（空白 / 复制当前 / 从 issue）。
- **卡片右键**：复用 Session Item 右键菜单（重命名/复制/归档/删除/在新 Panel 打开）——同一份操作集。
- **批量**：shift 多选 → 批量归档/删除（低频，可后置）。

## 边缘状态

| 场景 | 处理 |
|---|---|
| session=0 | 空状态（design-system §7）：图标 + "新建一个会话开始" + Primary 入口 |
| 单个 session | 仍可进 Overview，但建议直接用 Session List（Overview 价值在多） |
| 50+ session | 卡片网格虚拟滚动；默认折叠"已完成超 7 天"的 |
| 后台 agent 失败 | 卡片角标 danger + 摘要标红，点入见 error 详情 |
| 跨项目 | 项目筛选 chip 分组，默认显示当前项目 |

## 遗留

- 入口快捷键（⌘⇧O 候选）与 OS 冲突待核。
- 卡片是否展示最后一条消息的代码片段预览（信息密度 vs 噪音）待定。
- "活跃度"排序的算法（消息频率窗口）待定。
- 视图密度切换（紧凑/舒适）是否必要，或固定一档——初版固定舒适档，观察后再加。
- 移动端：Overview 在窄屏退化为单列列表，与 Session List 视觉差异缩小，需确认是否仍独立（或移动端直接用 Session List）。

## 与 Session List 的分工（核心约束）

**禁止**让 Overview 退化成"放大版 Session List"。两者必须保持取向差异：

- Session List = 单列、紧凑、导航优先、常驻 Sidebar
- Overview = 网格、信息密集、统筹优先、独立 Region、按需进入

若某信息只在一个地方有意义（如后台 agent 进度聚合只在 Overview，单个未读角标两者都有），不要为"对称"而复制。卡片复用 Session Item 的**信息原子**，但**呈现密度与用途**必须不同。
