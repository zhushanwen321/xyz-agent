# 阶段 A 审查计划 · 自顶向下（v3 Design Spec → Render 实现）

> 规划日期：2026-06-21
> 方法论：以设计 spec 树为 checklist，自顶向下逐叶对照 render 实现，判定 ✅一致/⚠偏差/❌缺失/🆕多余。
> 阶段 A 只规划，不审查（不填判定、不改代码）。

---

## 一、设计完整锚点树（L0→L4，全部 6 个 L1 区域）

```
App (窗口)
│
├── L0 · Shell ──────────────────────────────────────────────────────
│   │  shell/spec.md + draft-skeleton.html + draft-overlay-states.html
│   │
│   ├── 拓扑三层语义
│   │   ├── base 平铺 (bg-base #0d0d0f)
│   │   ├── aside-region 透明（无 background，继承 base）
│   │   └── main-panel 浮起（唯一带 bg-panel/border/radius:12px/shadow）
│   │
│   ├── Traffic Light 安全区
│   │   ├── padding-top: 52px（安全区 32 + 呼吸 20，三平台统一）
│   │   ├── --tl-safe-width: 72px, --tl-safe-height: 32px
│   │   ├── mac: titleBarStyle:'hiddenInset'，OS 绘制红黄绿
│   │   └── win/linux: frame:false + 自绘 mimic_mac 圆点
│   │
│   ├── App Nav Controls（三按钮：收起 / ← / →）
│   │   ├── 非全屏 left: 90px，全屏 left: 20px（320ms 平移）
│   │   ├── 收起 → toggle sidebar 宽度
│   │   └── ←/→ → 导航历史栈（浏览器模型，与 Flow 4 解耦）
│   │
│   ├── 两态（非全屏 / 全屏）
│   │   ├── traffic-light opacity 1→0（320ms = --duration-slow）
│   │   ├── app-nav-controls left 90→20（同曲线同步）
│   │   └── 全屏 hover 红黄绿由 mac 系统提供，应用不画第三态
│   │
│   ├── Z-index 分层（traffic 10 / main auto / aside auto / base 0）
│   ├── 全局快捷键：⌘N / ⌘K / ⌘B（三态优先级）
│   └── [评审锚点: 8]
│
├── L1 · Sidebar ────────────────────────────────────────────────────
│   │  sidebar/spec.md + draft-five-states.html + draft-session-item.html
│   │  + draft-file-view.html + draft-collapsed-state.html
│   │
│   ├── L2 · 容器结构
│   │   ├── 纵向分层：Brand → 主操作 nav（新建⌘N/搜索⌘K）→ Overview 入口
│   │   │   → segmented tab（会话|文件）→ 子视图区 → 用户区
│   │   ├── segmented tab：互斥切换 A↔B，持久化，计数角标
│   │   └── Overview 入口按钮 ≠ tab（外部 L1 Region 入口）
│   │
│   ├── L2 · 容器四态（A/B/C/D）
│   │   ├── A 会话列表（默认子视图）
│   │   ├── B 文件视图（与 A 互斥）
│   │   ├── C 收起态（容器整体隐藏，三路唤回：按钮/⌘B/左缘条）
│   │   └── D 空状态（会话数=0）
│   │
│   ├── L3 · 收起态细节（draft-collapsed-state）
│   │   ├── 唤回三路冗余 + 语义重排（各司其职不冲突）
│   │   ├── Header 接管 chrome：折叠+非全屏时 P1 header 接管 traffic light 区域
│   │   ├── 面板分割差异：仅 P1 header 受影响，P2 保持原状
│   │   ├── 动画 320ms 多轨同步
│   │   └── 状态保留（tab/active session/scroll/视图节点/chrome 状态）
│   │
│   ├── L3 · 会话项 SessionItem（draft-session-item）
│   │   ├── 信息结构：状态圆点 + 标题 + 目录·分支 pill + 时间
│   │   ├── 状态点 5 态：running/waiting(脉冲)/done/stopped/error
│   │   ├── 激活态：左侧竖条 + bg-elevated（与 workspace 四层激活标识呼应）
│   │   ├── hover：时间隐去 → 浮现 2 个操作按钮（重命名/删除）
│   │   └── 右键菜单：重命名/复制/归档/删除/在新 Panel 打开
│   │
│   └── L3 · 文件视图 FileView（draft-file-view）
│       ├── 文件树：目录折叠 + 层级缩进 + 当前编辑文件高亮
│       ├── git 状态标注：M/A/D/冲突（颜色对齐 git-zone）
│       ├── 文件树内过滤搜索框（实时过滤，非 ⌘K 全局搜索）
│       └── 与 message-stream file-changes 块联动：点文件→跳 Panel 高亮
│
│   [评审锚点: 16]
│
├── L1 · Workspace-Panel ────────────────────────────────────────────
│   │  workspace/spec.md + draft-dual-panel.html
│   │  panel/spec.md + 5 draft（message-stream / composer-states /
│   │  companion-zones / detail-pane / breadcrumb-popovers）
│   │
│   ├── L2 · Workspace 容器
│   │   ├── 双 Panel 主从模式（非对等）
│   │   │   ├── 单 session：Panel-1 撑满，无 Panel-2
│   │   │   └── 双 session：active panel 对话区永不被压缩遮挡
│   │   ├── 四层激活标识
│   │   │   ├── 左侧 2px accent 竖条
│   │   │   ├── inset 1px accent-ring（30% 透明）
│   │   │   ├── bg-elevated 微亮
│   │   │   └── whole opacity（1 / 0.5 / hover 0.78）
│   │   └── Side Drawer 方向：单 Panel 从右；双 Panel 时 active-1 从右覆盖 P2
│   │
│   ├── L2 · Panel 内部 5 Zone（panel/spec.md）
│   │   ├── ① panel-header（per-session 元信息）
│   │   ├── ② message-stream（消息流 + 回合折叠）
│   │   ├── ③ progress-zone（composer 上方，单 session 进度）
│   │   ├── ④ composer（输入区 + 工具区视觉一体）
│   │   └── ⑤ git-zone（composer 下方，暂存/提交/Diff）
│   │
│   ├── L3 · PanelHeader + Breadcrumb（draft-breadcrumb-popovers）
│   │   ├── 结构：状态圆点 + session 名 + 目录 + …三点 + ×关闭
│   │   ├── split / 新建会话按钮（同槽位互斥）
│   │   ├── Breadcrumb：项目名 ▸ 会话名 ▸ 分支名（仅分支段可点击）
│   │   ├── 分支 popover：切换分支（git ahead/behind 前置）+ 新建分支（内联表单）
│   │   └── ⌘B 集成（三态优先级矩阵）
│   │
│   ├── L3 · MessageStream 7 类块（draft-message-stream）
│   │   ├── 回合折叠机制
│   │   │   ├── 默认折叠：只显 Summary + File Changes
│   │   │   └── "已工作 X · N reasoning · M tool" pill → 点击展开
│   │   ├── ① UserMessage：纯文本 + @-mention chip + 附件
│   │   ├── ② OutputText：Markdown 渲染 + 流式光标
│   │   ├── ③ ReasoningBlock：thinking 折叠 + 计时
│   │   ├── ④ ToolCallCard：工具名/目标文件/状态（running/done/failed）
│   │   │   └── 失败：整块红框
│   │   ├── ⑤ FileChanges（变更集聚合）
│   │   │   └── Flow 2 变更集卡 5 态：accumulating/ready/partially-reviewed/resolved/superseded
│   │   ├── ⑥ Steer/Followup（pending 气泡，distinguish steer vs followup）
│   │   └── ⑦ SystemNotice（错误/断网/完成提示）
│   │
│   ├── L3 · Composer 8+ 态（draft-composer-states）
│   │   ├── 空 / 输入中 / @浮层 / 附件 / 发送中 / 停止 / steer-pending / followup-pending
│   │   ├── 输入区 + 工具区视觉一体（同容器、弱分隔）
│   │   ├── 工具区 5 项：+添加内容 / 上下文状态 / 模型 / thinking-level / 发送（右锚定）
│   │   └── @浮层在 composer 内（非 Overlay）
│   │
│   ├── L3 · Companion Zones（draft-companion-zones）
│   │   ├── progress-zone 4 态：待办/进行/完成/阻塞
│   │   │   └── Flow 3 升级为多进度聚合
│   │   ├── git-zone 4 态：干净/已暂存/有 diff/冲突
│   │   │   └── 单行 38px：分支名 + `+N −M · K 文件` + 操作按钮
│   │   └── 与 composer 视觉关系（共享上下带，不割裂）
│   │
│   └── L3 · Side Drawer（draft-detail-pane）
│       ├── header 多 tab 容器（非单实体视图切换）
│       ├── 文件×N tab（内含 Diff/预览 view-toggle）
│       ├── ChangeSet Detail + SubAgent Detail 两 Tab
│       ├── 反向联动：源块点击 → drawer 打开 + 反向高亮
│       └── 单/双 Panel 方向正确（dir-right/left）
│
│   [评审锚点: 35]
│
├── L1 · Overlays ───────────────────────────────────────────────────
│   │  overlays/spec.md + draft-search-modal.html
│   │
│   └── L2 · Search Modal (⌘K)
│       ├── 归属：L0 Overlay 级（不属任何 Region），z-index 1000
│       ├── 入口：⌘K/Ctrl+K / Sidebar「搜索」nav 项
│       ├── 四类分组：命令/文件/符号/会话（固定顺序）
│       ├── 键盘契约：↑↓/Enter/Esc/Tab/Home/End
│       ├── 5 态：默认(recents)/查询分组/类型过滤/空结果/加载
│       ├── 匹配高亮（<mark class="hl">，color:accent，无背景）
│       └── 与 FileView 树内过滤严格区分（全局跨项目 vs 当前 session）
│
│   [评审锚点: 7]
│
├── L1 · Overview ───────────────────────────────────────────────────
│   │  overview/spec.md + draft-overview.html + draft-entry.html
│   │
│   ├── L2 · 定位与入口
│   │   ├── 独立 L1 Region（与 Sidebar/Workspace 并列）
│   │   ├── 入口：sidebar「Overview」按钮（带 session 计数角标）/ ⌘⇧O
│   │   └── 激活后覆盖整个 workspace（main）区，sidebar 持久
│   │
│   ├── L2 · 布局三层：工具栏 → 卡片网格 → 空状态
│   │
│   ├── L3 · 工具栏
│   │   ├── 新建会话（⌘N）+ 筛选多选 chip + 排序下拉 + 视图密度切换
│   │   └── 筛选：状态(running/waiting/done/stopped/error) + 项目 + 标记(未读/冲突/后台agent)
│   │
│   ├── L3 · Session 卡片信息结构
│   │   ├── 头：状态圆点(5态) + 标题 + 分支 pill
│   │   ├── 摘要：最后 assistant 消息 1-2 行
│   │   ├── 指标：改动文件数/消息回合/运行时长
│   │   ├── 后台 agent：进度条 + 计数
│   │   ├── 时间：相对时间
│   │   └── 角标：未读/错误/冲突待解决
│   │
│   └── L3 · 交互
│       ├── 卡片 click → workspace 载入 session
│       ├── 卡片右键：同 SessionItem 右键菜单
│       └── 空状态（session=0）
│
│   [评审锚点: 9]
│
└── L1 · Settings ───────────────────────────────────────────────────
    │  settings/spec.md + draft-settings-shell.html
    │  + 5 per-menu draft（provider/extension/system/agent/skill）
    │
    ├── L2 · Modal 骨架（公共特质）
    │   ├── 形态：居中 modal + backdrop blur(10px)，宽 ~900px / 高 ~540px
    │   ├── 结构：.modal-head（搜索+保存pill+✕）→ .modal-body（左nav ~190px + 右detail scroll）
    │   └── 公共横切：内置搜索(⌘K) + 自动保存(800ms debounce) + 关闭恢复
    │
    ├── L2 · 三种布局模式
    │   ├── A · Setting Row：标签左 + 控件右 + 帮助文字下
    │   ├── B · Setting Card：Card 包多个语义相关 Setting Row
    │   └── C · Entity List：每行一实体 + 来源/版本pill + 状态点 + 开关 + 展开配置
    │
    └── L3 · 5 菜单页
        ├── Provider：API key 加密显隐 + 连接测试 + 模型下拉
        ├── Extension：MCP 连接状态点 + 工具列表展开
        ├── System：语言/外观模式/配色主题（两块，draft 移除聊天显示）
        ├── Agent：层 A 加载路径 + 只读列表 + badge 多源·最优先标生效
        └── Skill：层 A 加载路径 + 只读列表（与 Agent 同构，差异：pi-install 只读 pill）

    [评审锚点: 13]

总锚点数: 88
```

---

## 二、Wave 总览表

| Wave 编号 | 层级范围 | 区域 | 锚点数 | 依赖 | 标题 |
|-----------|---------|------|--------|------|------|
| A-SH-W1 | L0-L2 | Shell | 8 | — | Shell 拓扑 + 三层语义 + 两态 + 跨平台 |
| A-SB-W1 | L2-L3 | Sidebar | 6 | — | Sidebar 容器结构 + 四态 + 收起 |
| A-SB-W2 | L3-L4 | Sidebar | 5 | A-SB-W1 | SessionItem 5 态 + 激活 + 右键 |
| A-SB-W3 | L3-L4 | Sidebar | 5 | A-SB-W1 | FileView 文件树 + git 标注 + 过滤 |
| A-WP-W1 | L1-L2 | Workspace | 6 | — | Workspace 双 Panel 主从 + 四层激活标识 |
| A-WP-W2 | L2-L3 | Panel | 5 | A-WP-W1 | PanelHeader + Breadcrumb Popovers |
| A-WP-W3 | L2-L4 | Panel | 10 | A-WP-W2 | MessageStream 7 类块 + 回合折叠 + 变更集卡 |
| A-WP-W4 | L2-L4 | Panel | 9 | A-WP-W1 | Composer 8+ 态 + 工具区 + @浮层 |
| A-WP-W5 | L3-L4 | Panel | 8 | A-WP-W1 | Companion Zones（progress + git） |
| A-WP-W6 | L3-L4 | Panel | 7 | A-WP-W3 | Side Drawer（detail-pane）+ 反向联动 |
| A-OL-W1 | L1-L3 | Overlays | 7 | — | SearchModal ⌘K 全局搜索浮层 |
| A-OV-W1 | L1-L3 | Overview | 9 | A-SB-W2 | Overview 卡片网格 + 筛选 + 入口 |
| A-ST-W1 | L2-L3 | Settings | 7 | — | Settings Modal 骨架 + 三模式 + 公共横切 |
| A-ST-W2 | L3-L4 | Settings | 6 | A-ST-W1 | Settings 5 菜单页详细内容 |

**14 waves · 88 锚点 · 6 区域全覆盖**

---

## 三、每个 Wave 的详细审查计划

---

### A-SH-W1 · Shell 拓扑 + 三层语义 + 两态 + 跨平台

- **层级范围**：L0-L2
- **预估锚点数**：8
- **依赖**：无

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| SH-L0-01 | 三层语义（base 平铺 + sidebar 透明 + main 浮起） | shell/spec.md §一 | shell/AppShell.vue + shell/AsideRegion.vue + shell/MainPanel.vue |
| SH-L0-02 | safe area padding-top: 52px（三平台统一） | shell/spec.md §三 | shell/AsideRegion.vue |
| SH-L0-03 | Traffic Light（mac 系统绘制，win/linux mimic_mac 自绘） | shell/spec.md §五 | shell/TrafficLight.vue |
| SH-L0-04 | App Nav Controls（收起/←/→，三平台统一） | shell/spec.md §二 | shell/AppNavControls.vue |
| SH-L0-05 | 两态（非全屏/全屏）：traffic light opacity + 按钮 left 位移 320ms | shell/spec.md §二 | shell/AppShell.vue + shell/AppNavControls.vue |
| SH-L0-06 | Breadcrumb 位置（main-header 内，非横跨顶栏） | shell/spec.md §四 | shell/MainPanel.vue（或 panel/PanelHeader.vue） |
| SH-L0-07 | Z-index 分层（traffic 10 / main auto / aside auto / base 0） | shell/spec.md §六 | shell/AppShell.vue + shell/TrafficLight.vue |
| SH-L0-08 | 全局快捷键 ⌘B 三态优先级 | shell/spec.md §二（⌘B） | shell/AppShell.vue（键盘监听入口） |

#### 审查重点

- **三层语义是视觉命门**：base 平铺、sidebar 透明（无 background）、main 是唯一带 bg-panel/border/radius/shadow 的 float-panel。主视觉层次靠这些属性浮起，不靠 z-index。
- **52px 安全区三平台统一**：全屏 hover 时 mac 系统下拉覆盖层落进此留白，win/linux mimic_mac 圆点也落此区。实现是否遗漏全屏态也保留 52px？
- **Traffic light 跨平台差异**：mac 用 `titleBarStyle:'hiddenInset'`，win/linux 用 `frame:false` + 自绘 mimic_mac。render 是否已处理？
- **App-nav-controls 位移**：全屏/非全屏切换时 left 从 90px → 20px，320ms 过渡曲线需与 traffic-light 同步。
- **Breadcrumb 不在横跨顶栏**：初版 Overlay C 方案 breadcrumb `padding-left:80px` 横跨顶栏，现版进 main-header。检查 render 是否存在旧方案的横跨残留。

---

### A-SB-W1 · Sidebar 容器结构 + 四态 + 收起

- **层级范围**：L2-L3
- **预估锚点数**：6
- **依赖**：无

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| SB-L2-01 | 容器纵向分层（Brand→nav→Overview入口→segmented tab→子视图区→用户区） | sidebar/spec.md §视图切换机制 | sidebar/Sidebar.vue |
| SB-L2-02 | Segmented Tab（会话\|文件）互斥切换 + 计数 + 持久化 | sidebar/spec.md §视图切换机制 | sidebar/SegmentedTab.vue |
| SB-L2-03 | Overview 入口按钮 ≠ tab（外部 L1 Region 入口，激活时 accent 态） | sidebar/spec.md §视图切换机制 + overview/spec.md | sidebar/Sidebar.vue |
| SB-L2-04 | 容器四态（A 会话列表 / B 文件视图 / C 收起 / D 空） | sidebar/spec.md §容器四态 | sidebar/Sidebar.vue |
| SB-L2-05 | 收起态：三路唤回冗余 + 320ms 同步 + 状态保留 | sidebar/draft-collapsed-state.html | sidebar/Sidebar.vue + shell/AppNavControls.vue |
| SB-L2-06 | 搜索模态入口（nav 项 + ⌘K）— 仅入口，本体归 Overlay | sidebar/spec.md §背景 + overlays/spec.md | sidebar/Sidebar.vue |

#### 审查重点

- **容器 vs 列表**：Sidebar 是多视图容器（非单一 SessionList），内部承载两个互斥子视图。旧实现可能只是 SessionList 组件，需确认是否已升级为容器模式。
- **Overview 入口按钮位置**：在 nav 和 segmented tab 之间，不是 tab 的第三个选项。激活时 accent 态。render 是否正确分层？
- **收起态唤回**：三路唤回（顶栏按钮 / ⌘B / 左缘条），都是应用级别行为。左缘细条 hover 唤回是否实现？
- **搜索归属**：搜索入口在 sidebar，但浮层本体在 Overlay 层。两者不可混淆。

---

### A-SB-W2 · SessionItem 5 态 + 激活 + 右键

- **层级范围**：L3-L4
- **预估锚点数**：5
- **依赖**：A-SB-W1（容器结构）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| SB-L3-01 | 信息结构：状态圆点 + 标题 + 目录·分支 pill + 时间 | sidebar/spec.md §会话项 | sidebar/SessionItem.vue |
| SB-L3-02 | 状态点 5 态：running/waiting(脉冲)/done/stopped/error | sidebar/draft-session-item.html | sidebar/SessionItem.vue |
| SB-L3-03 | 激活态：左侧竖条 + bg-elevated（与 workspace 四层激活呼应） | sidebar/spec.md §会话项 + handoff-session-item §3 | sidebar/SessionItem.vue |
| SB-L3-04 | hover 行为：时间隐去 → 浮现 2 个操作按钮（重命名/删除） | sidebar/spec.md §会话项 | sidebar/SessionItem.vue |
| SB-L3-05 | 右键菜单：重命名/复制/归档/删除/在新 Panel 打开 | sidebar/spec.md §遗留 + handoff-session-item §3 | sidebar/SessionItem.vue |

#### 审查重点

- **状态点与 PanelHeader 一致性**：SessionItem 的状态圆点 5 态需要和 panel/PanelHeader.vue 中的状态圆点完全一致（同一套 5 态枚举和视觉）。
- **激活态呼应**：左侧竖条 + bg-elevated，与 Workspace 的四层激活标识（左侧 2px accent 竖条 + bg-elevated）视觉呼应。是否一致？
- **hover 操作按钮**：方形按钮出现时机是 hover 时时间隐去后。实现是否正确处理过渡？
- **分支 pill**：mono + accent 样式是否正确？

---

### A-SB-W3 · FileView 文件树 + git 标注 + 过滤

- **层级范围**：L3-L4
- **预估锚点数**：5
- **依赖**：A-SB-W1（容器结构）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| SB-L3-06 | 文件树：目录折叠 + 层级缩进 + 当前编辑文件高亮 | sidebar/draft-file-view.html | sidebar/（若未独立文件则以 sidebar/Sidebar.vue 内条件渲染） |
| SB-L3-07 | git 状态标注：M/A/D/冲突（颜色对齐 git-zone） | sidebar/draft-file-view.html | 同上 |
| SB-L3-08 | 树内过滤搜索框（实时过滤，非 ⌘K 全局） | sidebar/draft-file-view.html + overlays/spec.md §归属与边界 | 同上 |
| SB-L3-09 | 与 message-stream file-changes 块联动：点文件→跳 Panel 高亮 | sidebar/draft-file-view.html | 同上（EventBus 联动） |
| SB-L3-10 | active session 联动：切 session 时 FileView 自动刷新 | sidebar/spec.md §视图切换机制 | sidebar/Sidebar.vue |

#### 审查重点

- **FileView 作为独立子视图**：是否作为独立组件存在，不与 SessionList 混排？
- **内过滤 vs ⌘K**：树内过滤搜索框是内联的、只过滤当前 session 树；⌘K 是全局浮层。两者不能混为一谈。检查是否有把 ⌘K 当作树过滤的误实现。
- **git 标注颜色对齐**：M/A/D/冲突 的色值必须与 panel/GitZone.vue 中的 git 状态色一致。
- **Fake data**：render 是否已对接实际数据，还是仍用 mock 数据？

---

### A-WP-W1 · Workspace 双 Panel 主从 + 四层激活标识

- **层级范围**：L1-L2
- **预估锚点数**：6
- **依赖**：无

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| WP-L1-01 | Workspace 作为容器（Panel 挂其内） | workspace/spec.md §拓扑决策 | workspace/Workspace.vue |
| WP-L2-01 | 双 Panel 主从模式（非对等） | workspace/spec.md §拓扑决策 | workspace/PanelContainer.vue |
| WP-L2-02 | 单 Panel 默认态：Panel-1 撑满 | workspace/spec.md §状态与交互 | workspace/Workspace.vue + workspace/PanelContainer.vue |
| WP-L2-03 | 四层激活标识（左侧竖条 + inset ring + bg + opacity） | workspace/spec.md §Panel激活标识系统 | workspace/PanelContainer.vue（或 panel/Panel.vue） |
| WP-L2-04 | 双 Panel 下 Side Drawer 方向：active-1 从右覆盖 P2 | workspace/spec.md §边缘状态 | workspace/PanelContainer.vue + panel/（detail pane） |
| WP-L2-05 | PanelHeader split/新建会话按钮（同槽位互斥） | workspace/spec.md §状态与交互 | panel/PanelHeader.vue |

#### 审查重点

- **主从模式命门**：active panel 对话区永不被压缩遮挡。双 Panel 同时活跃时附属信息覆盖对侧是已知限制（v1 不处理）。检查实现是否真的保证对话区不被压缩。
- **四层激活标识防双线**：用 inset box-shadow（不改盒模型）+ opacity 整体退后，而非整圈实线——避免中缝双线打架。检查 ring 实现是否正确。
- **opacity 校准点**：非激活 0.5 可能偏暗，需真机验证可读性。
- **单 Panel → 双 Panel 过渡**：Panel-2 出现/消失的动画是否正确？

---

### A-WP-W2 · PanelHeader + Breadcrumb Popovers

- **层级范围**：L2-L3
- **预估锚点数**：5
- **依赖**：A-WP-W1（Workspace 拓扑）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| WP-L2-06 | Header 结构：状态圆点 + session 名 + 目录 + …三点 + ×关闭 | workspace/spec.md §Header结构 | panel/PanelHeader.vue |
| WP-L3-01 | Breadcrumb：项目名 ▸ 会话名 ▸ 分支名（仅分支段可点击） | panel/draft-breadcrumb-popovers.html | panel/PanelHeader.vue |
| WP-L3-02 | 分支切换 popover（git 状态前置：ahead/behind） | panel/draft-breadcrumb-popovers.html | panel/PanelHeader.vue（popover 子组件） |
| WP-L3-03 | 新建分支 popover（内联表单，不开新弹层） | panel/draft-breadcrumb-popovers.html | 同上 |
| WP-L3-04 | ⌘B 三态优先级集成（sidebar 折叠 + 未保存编辑时触发分支 popover） | shell/spec.md §⌘B + panel/draft-breadcrumb-popovers.html §6 | panel/PanelHeader.vue + shell/AppShell.vue |

#### 审查重点

- **仅分支段可点击**：L1（仓库名）/L2（工作区名）为只读静态文本，不响应点击。render 是否错误地把所有 breadcrumb 段都做了可点击？
- **git 状态前置**：切换分支 popover 必须先显示 ahead/behind 状态，防止同步坑。这是关键的 UX 决策，检查是否遗漏。
- **新建分支 inline**：用内联表单，不弹出独立弹窗。检查是否用了 dialog/modal 组件。
- **PanelHeader ×关闭**：hover 变红，关闭语义。单 Panel 关闭主会话需确认流。
- **⌘B 集成**：sidebar 折叠 + 有未保存编辑 → ⌘B 触发分支 popover（非 toggle sidebar）。这个优先级逻辑是否正确实现？

---

### A-WP-W3 · MessageStream 7 类块 + 回合折叠 + 变更集卡

- **层级范围**：L2-L4
- **预估锚点数**：10
- **依赖**：A-WP-W2（PanelHeader 结构）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| WP-L3-05 | 回合折叠机制：默认折叠（只显 Summary + File Changes） | panel/spec.md §message-stream + draft-message-stream | panel/MessageStream.vue + panel/message-stream/Turn.vue |
| WP-L3-06 | "已工作 X · N reasoning · M tool" pill → 点击展开完整时序 | panel/draft-message-stream.html | panel/message-stream/Turn.vue |
| WP-L3-07 | ① UserMessage（靠右气泡） | panel/draft-message-stream.html | panel/message-stream/Block.vue |
| WP-L3-08 | ② OutputText（Markdown + 流式光标） | panel/draft-message-stream.html | panel/message-stream/Block.vue |
| WP-L3-09 | ③ ReasoningBlock（thinking 折叠 + 计时） | panel/draft-message-stream.html | panel/message-stream/Block.vue |
| WP-L3-10 | ④ ToolCallCard（工具名/目标文件/状态 + 失败红框） | panel/draft-message-stream.html | panel/message-stream/Block.vue |
| WP-L3-11 | ⑤ FileChanges（变更集聚合 5 态：accumulating/ready/partially-reviewed/resolved/superseded） | flow-2-code-review/spec.md + draft-message-stream | panel/message-stream/Block.vue |
| WP-L3-12 | ⑥ Steer/Followup pending 气泡 | panel/draft-message-stream.html | panel/message-stream/Block.vue |
| WP-L3-13 | ⑦ SystemNotice（错误/断网/完成提示） | panel/draft-message-stream.html | panel/message-stream/Block.vue |
| WP-L3-14 | 消息操作菜单（hover user msg → 编辑并重发/复制/引用/删除） | flow-2-code-review/spec.md §状态机·消息操作菜单 | panel/message-stream/Block.vue |

#### 审查重点

- **回合折叠是核心交互**：Summary 恒存在（Agent 行为契约），中间 reasoning/tool call 折叠为 pill。render 是否正确实现默认折叠 + pill 展开？
- **7 类块的视觉差异**：user 靠右气泡，assistant 与背景融合，tool 卡片式，reasoning 可独立折叠。每类块的样式是否正确区分？
- **变更集卡 5 态状态机**：accumulating（加载指示）/ready（等待审查）/partially-reviewed/resolved/superseded。render 是否完整实现了 5 态？
- **Steer vs Followup 区分**：steer = AI 工作中提交（排队不打断），followup = AI 完成后提交（开新一轮）。两者 visual 都是 pending 气泡，但上下文不同。
- **流式状态**：tool call 状态从 running→done/failed 的实时更新，streaming 光标的正确渲染。
- **消息操作菜单**：critique P0 短板——hover 用户消息 → … → 编辑并重发（触发 Flow 4 分支）。是否实现？

---

### A-WP-W4 · Composer 8+ 态 + 工具区 + @浮层

- **层级范围**：L2-L4
- **预估锚点数**：9
- **依赖**：A-WP-W1（Workspace 拓扑）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| WP-L3-15 | 输入区 + 工具区视觉一体（同容器、弱分隔） | panel/spec.md + handoff-composer-states | panel/Composer.vue |
| WP-L3-16 | 空态（composer 无内容） | panel/draft-composer-states.html | panel/Composer.vue |
| WP-L3-17 | 输入中态（多行 + 自动高 + shift+enter 换行） | panel/draft-composer-states.html | panel/Composer.vue |
| WP-L3-18 | @浮层（上下文候选列表，composer 内部状态，非 Overlay） | panel/draft-composer-states.html | panel/Composer.vue |
| WP-L3-19 | 附件态（图片/文件拖拽） | panel/draft-composer-states.html | panel/Composer.vue |
| WP-L3-20 | 发送中 / 停止态 | panel/draft-composer-states.html | panel/Composer.vue |
| WP-L3-21 | Steer pending 态（AI 工作中提交引导，排队不打断） | panel/draft-composer-states.html | panel/Composer.vue |
| WP-L3-22 | Followup pending 态（AI 完成后提交追问，开新一轮） | panel/draft-composer-states.html | panel/Composer.vue |
| WP-L3-23 | 工具区 5 项：+添加内容 / 上下文状态 / 模型 / thinking-level / 发送（右锚定） | panel/draft-composer-states.html | panel/Composer.vue |

#### 审查重点

- **输入区+工具区一体化**：视觉为同一个容器（同一背景/边框/圆角），中间无强分割线。检查 render 是否有硬分隔线破坏一体感。
- **@浮层归属**：在 composer 内部浮起，非独立 Overlay 层。检查 z-index 和定位是否正确（不能比 ⌘K 高）。
- **Steer/Followup pending 区分**：两者 visual 都是 composer 顶部 pending 气泡，但需要视觉可区分（文案/图标不同）。
- **工具区 5 项布局**：水平排列，发送右锚定。检查是否多/少/错位。
- **发送状态**：发送中时输入区状态（禁用/清空/保留），停止按钮的显示/隐藏时机。

---

### A-WP-W5 · Companion Zones（progress-zone + git-zone）

- **层级范围**：L3-L4
- **预估锚点数**：8
- **依赖**：A-WP-W1（Workspace 拓扑）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| WP-L3-24 | progress-zone 4 态：待办/进行/完成/阻塞 | panel/draft-companion-zones.html | panel/ProgressZone.vue |
| WP-L3-25 | progress-zone 展开/收起（chevron 切换） | workspace/spec.md §进度区 | panel/ProgressZone.vue |
| WP-L3-26 | progress-zone 空态（无进度时折叠/隐藏） | panel/draft-companion-zones.html | panel/ProgressZone.vue |
| WP-L3-27 | git-zone 4 态：干净/已暂存/有 diff/冲突 | panel/draft-companion-zones.html | panel/GitZone.vue |
| WP-L3-28 | git-zone 常量 38px 单行：分支名 + +N −M · K 文件 + 操作按钮 | workspace/spec.md §git-zone | panel/GitZone.vue |
| WP-L3-29 | 与 composer 视觉连贯（共享上下带，不割裂） | panel/draft-companion-zones.html | panel/Composer.vue + panel/ProgressZone.vue + panel/GitZone.vue |
| WP-L3-30 | Flow 3：progress-zone 多进度聚合升级 | flow-3-subagent/spec.md | panel/ProgressZone.vue |
| WP-L3-31 | git Diff 入口 → Side Drawer | panel/draft-companion-zones.html | panel/GitZone.vue |

#### 审查重点

- **两 zone 与 composer 视觉一体**：progress 在 composer 上方、git 在下方，三者共享上下带。检查是否有独立背景/边框割裂 composer 上下区域。
- **git-zone 常量高度 38px**：不随内容撑高。分支名超长省略号。
- **干净工作区态**：显示"工作区干净"，只留 Diff 按钮。检查 render 是否处理此空态。
- **progress-zone 多进度**：Flow 3 升级后支持多子 agent 并行进度聚合。v1 是否只有单 progress？
- **Process Panel v1 已删除**：progress-zone 阻塞态不应再出现"展开 Process Panel"入口（那是旧设计）。

---

### A-WP-W6 · Side Drawer（detail-pane）+ 反向联动

- **层级范围**：L3-L4
- **预估锚点数**：7
- **依赖**：A-WP-W3（MessageStream — 反向联动源）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| WP-L3-32 | Drawer 结构：header 多 tab 容器（非单实体视图切换） | panel/draft-detail-pane.html | panel/（detail pane 组件） |
| WP-L3-33 | 文件×N tab（内含 Diff/预览 view-toggle） | panel/draft-detail-pane.html | 同上 |
| WP-L3-34 | ChangeSet Detail tab（变更集详情 + Accept/Reject） | panel/draft-detail-pane.html + flow-2-code-review/spec.md | 同上 |
| WP-L3-35 | SubAgent Detail tab（子 agent 完整消息流） | panel/draft-detail-pane.html + flow-3-subagent/spec.md | 同上 |
| WP-L3-36 | 反向联动：源块点击 → drawer 打开 + 源块高亮 | panel/draft-detail-pane.html | 同上（EventBus 联动 message-stream） |
| WP-L3-37 | Tab 切换动效（dd-tabs + view-toggle Diff/预览） | panel/draft-detail-pane.html | 同上 |
| WP-L3-38 | 单/双 Panel 下方向正确（dir-right/left → 单 session 收窄并排 50%） | panel/draft-detail-pane.html | workspace/PanelContainer.vue + panel/（drawer） |

#### 审查重点

- **Drawer 浮起形态**：workspace-body 级 absolute，单 session 收窄 50% 并排（不盖对话区），双 session 覆盖对侧（已知限制）。render 是否使用了错误的全覆盖/浮层方式？
- **反向联动**：message-stream 中点 file-changes 或 subagent 块 → drawer 打开并高亮对应 tab。双向联动是否都正确？
- **Diff/预览 view-toggle**：文件 tab 内部切换（不是切换 Drawer tab）。Diff 视图 vs 文件预览。
- **Accept/Reject 交互**：Diff tab 底部审批栏 + 计数 -1 + 自动跳下一个未审查文件。是否实现完整流程？
- **SubAgent Detail**：子 agent 的完整消息流在 Drawer 内，不影响主消息流。v1 是否有此实现？

---

### A-OL-W1 · SearchModal ⌘K 全局搜索浮层

- **层级范围**：L1-L3
- **预估锚点数**：7
- **依赖**：无

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| OL-L1-01 | 归属：L0 Overlay 级，z-index 1000，浮于 Sidebar/Workspace 之上 | overlays/spec.md §归属与边界 | overlays/SearchModal.vue |
| OL-L2-01 | 入口：⌘K/Ctrl+K + Sidebar「搜索」nav 项 | overlays/spec.md §背景 | overlays/SearchModal.vue + sidebar/Sidebar.vue（入口） |
| OL-L2-02 | 四类分组（命令/文件/符号/会话）固定顺序 | overlays/spec.md §四类分组 | overlays/SearchModal.vue |
| OL-L2-03 | 键盘契约：↑↓/Enter/Esc/Tab（跨组扁平化移动） | overlays/spec.md §键盘契约 | overlays/SearchModal.vue |
| OL-L3-01 | 5 态：默认(recents)/查询分组/类型过滤/空结果/加载 | overlays/spec.md §状态 | overlays/SearchModal.vue |
| OL-L3-02 | 匹配高亮（<mark class="hl">，color:accent，无背景） | overlays/spec.md §实现要点 | overlays/SearchModal.vue |
| OL-L3-03 | 无障碍：role="dialog" + aria-modal + focus trap | overlays/spec.md §实现要点 | overlays/SearchModal.vue |

#### 审查重点

- **与 FileView 树过滤严格区分**：这是全局跨项目搜索，树过滤是当前 session 内文件树收窄。两者入口、形态、结果截然不同。检查 render 是否混淆。
- **模态遮罩**：backdrop + 居中浮层 + 点击背景关闭。
- **recents 默认展示**：唤起且查询为空时显示最近项（每类 5 项），输入查询后隐 recents。
- **键盘导航扁平化**：↑↓ 跨组移动，非分组内循环。Tab 切类。
- **危险命令二次确认**：如"终止任务"类命令不直接执行。

---

### A-OV-W1 · Overview 卡片网格 + 筛选 + 入口

- **层级范围**：L1-L3
- **预估锚点数**：9
- **依赖**：A-SB-W2（SessionItem 信息原子复用）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| OV-L1-01 | 定位：独立 L1 Region，与 Sidebar/Workspace 并列 | overview/spec.md §背景 | overview/Overview.vue |
| OV-L2-01 | 入口：sidebar「Overview」按钮 + ⌘⇧O，激活后覆盖 workspace | overview/spec.md §触发与定位 + ADR-0005 | sidebar/Sidebar.vue（入口）+ overview/Overview.vue |
| OV-L2-02 | 布局三层：工具栏 → 卡片网格 → 空状态 | overview/spec.md §布局 | overview/Overview.vue |
| OV-L3-01 | 工具栏：新建(⌘N) + 筛选多选 chip + 排序下拉 + 视图密度 | overview/spec.md §筛选与排序 | overview/Overview.vue |
| OV-L3-02 | Session 卡片信息结构（6 区：头/摘要/指标/后台agent/时间/角标） | overview/spec.md §Session卡片信息结构 | overview/SessionCard.vue |
| OV-L3-03 | 响应式网格：宽屏 4 列 / 笔记本 3 列 / 窄屏 2 列 | overview/spec.md §布局 | overview/Overview.vue |
| OV-L3-04 | 卡片激活态：Card-Active inset accent ring（禁左竖条） | overview/spec.md §Session卡片信息结构 | overview/SessionCard.vue |
| OV-L3-05 | 交互：卡片 click → workspace 载入 session | overview/spec.md §交互 | overview/SessionCard.vue |
| OV-L3-06 | 空状态（session=0）+ 与 Session List 分工明确（鸟瞰 vs 导航） | overview/spec.md §边缘状态 + §与SessionList分工 | overview/Overview.vue |

#### 审查重点

- **独立 Region vs workspace view**：早期 ui-skeleton.md 把 Overview 当作 workspace 内的一个 view，但已被 ADR-0005 推翻——现在 Overview 是独立 L1 Region。render 的 Overview 激活方式是否正确（覆盖整个 main 区，非切换 workspace view）？
- **入口落点**：sidebar 按钮（在 nav 和 segmented tab 之间），非 workspace 顶栏。检查 render 入口位置。
- **Session 卡片复用 SessionItem 信息原子**：卡片是 SessionItem 的"鸟瞰放大版"，复用同一信息原子（状态圆点、标题、分支 pill），但呈现密度不同。检查是否真的复用还是独立实现。
- **Card-Active 禁左竖条**：用 inset accent ring，不用左侧竖条（那是 Sidebar SessionItem 的激活形式）。AI slop 反模式检查。
- **与 Session List 分工**：Overview 是鸟瞰/统筹取向（网格、信息密集），Session List 是导航/切换取向（单列、紧凑）。render 的 Overview 是否退化为"放大版 Session List"？

---

### A-ST-W1 · Settings Modal 骨架 + 三模式 + 公共横切

- **层级范围**：L2-L3
- **预估锚点数**：7
- **依赖**：无

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| ST-L2-01 | Modal 形态：居中 + backdrop blur(10px)，~900×540px，关闭恢复 | settings/spec.md §定位与边界 + §页面骨架 | settings/SettingsModal.vue |
| ST-L2-02 | 结构：.modal-head（搜索+保存pill+✕）→ .modal-body（左nav ~190px + 右detail） | settings/spec.md §页面骨架 | settings/SettingsModal.vue |
| ST-L2-03 | 三布局模式：A Setting Row / B Setting Card / C Entity List | settings/spec.md §三种布局模式 | settings/SettingsModal.vue（模式组件） |
| ST-L2-04 | 内置搜索：跨菜单搜设置项 → 下拉匹配列表（带 menu tag）→ 点选切菜单高亮 | settings/spec.md §公共横切 | settings/SettingsModal.vue |
| ST-L2-05 | 自动保存：debounce 800ms + 状态 pill（已保存/保存中…），无显式 Save 按钮 | settings/spec.md §公共横切 | settings/SettingsModal.vue |
| ST-L2-06 | 导航↔详情联动（切菜单换面板） | settings/spec.md §验收 | settings/SettingsModal.vue |
| ST-L2-07 | 与 Overview 区分：Settings 居中 modal（表单交互），Overview 全屏鸟瞰（数据呈现） | settings/spec.md §定位与边界 | settings/SettingsModal.vue vs overview/Overview.vue |

#### 审查重点

- **Modal vs 全屏覆盖**：Settings 是居中 modal + backdrop blur，非全屏覆盖 Region。Overview 是全屏覆盖。检查 render 的 SettingsModal 是否正确使用 modal 而非全屏覆盖。
- **三布局模式复用性**：Setting Row、Setting Card、Entity List 三个模式应该是可复用的子组件，各菜单页只是组合差异。检查是否有重复造轮子。
- **内置搜索**：⌘K 唤起设置内置搜索（与全局 ⌘K 冲突？spec 未说明，需留意）。跨菜单搜索结果带菜单 tag。
- **自动保存 pill**：右上角状态 pill 的视觉设计是否正确，800ms debounce。

---

### A-ST-W2 · Settings 5 菜单页详细内容

- **层级范围**：L3-L4
- **预估锚点数**：6
- **依赖**：A-ST-W1（Modal 骨架）

#### 审查对象清单

| ID | 组件/锚点 | 设计来源 | 预期 Render 位置 |
|----|----------|---------|-----------------|
| ST-L3-01 | Provider 页面：API key 加密显隐 + 连接测试 + 模型下拉 | settings/draft-provider.html | settings/SettingsModal.vue（Provider 区域） |
| ST-L3-02 | Extension 页面：MCP 连接状态点 + 工具列表展开 | settings/draft-extension.html | settings/SettingsModal.vue（Extension 区域） |
| ST-L3-03 | System 页面：语言/外观模式/配色主题（两块，draft 移除聊天显示） | settings/draft-system.html | settings/SettingsModal.vue（System 区域） |
| ST-L3-04 | Agent 页面：层 A 加载路径 + 只读列表 + badge 多源·最优先标生效 | settings/draft-settings-agent.html + ADR-0003 | settings/SettingsModal.vue（Agent 区域） |
| ST-L3-05 | Skill 页面：层 A 加载路径 + 只读列表 + pi-install 只读 pill（与 Agent 同构） | settings/draft-settings-skill.html + ADR-0003 | settings/SettingsModal.vue（Skill 区域） |
| ST-L3-06 | Plugins 菜单（第 6 菜单）：保留独立，不折叠进 Extension/Skill | settings/spec.md §决策记录 | 检查 render 是否有独立 Plugins 入口 |

#### 审查重点

- **System 页面内容**：draft 已移除"聊天显示"（两块 vs 旧三块）。检查 render 的 System 设置是否还保留旧版"聊天显示"。
- **Agent/Skill 同构**：两者层 A 加载路径 + 只读列表同构，但 Agent 无"强制/原生"目录区分（agent .md pi 原生不扫），Skill 有强制目录+可选目录。render 是否正确处理差异？
- **ADR-0003 依赖**：Agent/Skill 只读子集规范来自 ADR-0003（资源加载策略）。检查 render 是否遵循：Skill 去启用开关和展开配置，加来源 badge 多源·最优先标生效。
- **Plugins 独立菜单**：根据 settings/spec.md §决策记录，Plugins 保留独立菜单不折叠进 Extension。检查 render 的 settings 导航是否有 Plugins 入口。
- **冷蓝 token 一致性**：所有 settings 页面必须统一使用冷蓝 token，无废弃设计系统（Warm & Soft）残留。

---

## 四、总统计

| 指标 | 值 |
|------|----|
| L1 区域覆盖 | 6 / 6（Shell / Sidebar / Workspace-Panel / Overlays / Overview / Settings） |
| Wave 总数 | 14 |
| 锚点总数 | 88 |
| 设计 spec 文件引用 | 24 个（9 spec.md + 15 draft.html） |
| 预期 render 文件 | ~35 个 Vue 组件 |
| 审查重点（命门） | 14 条（每 wave 1 条） |

### 区域分布

| 区域 | Wave 数 | 锚点数 |
|------|---------|--------|
| Shell | 1 | 8 |
| Sidebar | 3 | 16 |
| Workspace-Panel | 6 | 45 |
| Overlays | 1 | 7 |
| Overview | 1 | 9 |
| Settings | 2 | 13 |
| **合计** | **14** | **88** |

### Wave 依赖图（推荐执行序）

```
第一层（无依赖，可并行）：A-SH-W1, A-SB-W1, A-WP-W1, A-OL-W1, A-ST-W1
第二层（依赖第一层）：A-SB-W2 ← A-SB-W1
                      A-SB-W3 ← A-SB-W1
                      A-WP-W2 ← A-WP-W1
                      A-WP-W4 ← A-WP-W1
                      A-WP-W5 ← A-WP-W1
                      A-ST-W2 ← A-ST-W1
                      A-OV-W1 ← A-SB-W2
第三层（依赖第二层）：A-WP-W3 ← A-WP-W2
                     A-WP-W6 ← A-WP-W3
```

---

## 附录 · 设计文件索引速查

| 区域 | spec.md 路径 | draft 文件 |
|------|-------------|-----------|
| Shell | `shell/spec.md` | `draft-skeleton.html`, `draft-overlay-states.html` |
| Sidebar | `sidebar/spec.md` | `draft-five-states.html`, `draft-session-item.html`, `draft-file-view.html`, `draft-collapsed-state.html` |
| Workspace | `workspace/spec.md` | `draft-dual-panel.html` |
| Panel | `panel/spec.md` | `draft-message-stream.html`, `draft-composer-states.html`, `draft-companion-zones.html`, `draft-detail-pane.html`, `draft-breadcrumb-popovers.html`, `draft-project-settings-drawer.html` |
| Overlays | `overlays/spec.md` | `draft-search-modal.html` |
| Overview | `overview/spec.md` | `draft-overview.html`, `draft-entry.html` |
| Settings | `settings/spec.md` | `draft-settings-shell.html`, `draft-provider.html`, `draft-extension.html`, `draft-system.html`, `draft-settings-agent.html`, `draft-settings-skill.html` |
| Flow 2 | `flow-2-code-review/spec.md` | `draft-cases.html` |
| Flow 3 | `flow-3-subagent/spec.md` | `draft-cases.html` |
