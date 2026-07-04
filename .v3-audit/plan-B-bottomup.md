# 阶段 B · 自底向上审查计划

> **角色**：阶段 B 规划员（只规划，不审查，不改代码）
> **路径**：以 render 实现树为路径，每个文件找设计规范，判定 ✅一致/⚠偏差/🆕多余
> **核心价值**：找"多余"——render 中有但设计已推翻/无对应的遗留代码
> **产出日期**：2026-06-21

---

## 目录

1. [render 完整实现树清单](#1-render-完整实现树清单)
2. [wave 总览表](#2-wave-总览表)
3. [每个 wave 的详细审查计划](#3-每个-wave-的详细审查计划)
4. [全局根因高发区清单](#4-全局根因高发区清单)

---

## 1. render 完整实现树清单

> 文件 → 功能 → 对应设计模块/组件 + 🆕遗留标记

### 1.1 Shell 层（5 个文件）

| # | 文件 | 功能 | 设计对应 | 🆕标记 |
|---|------|------|---------|--------|
| SH-01 | `components/shell/AppShell.vue` | L0 根容器，flex h-screen + gap-3 + bg-bg | `shell/spec.md` §一 拓扑 + `draft-skeleton.html` | — |
| SH-02 | `components/shell/AsideRegion.vue` | 侧栏容器槽，pt-[52px] 安全区，flex-basis 联动 sidebar.collapsed | `shell/spec.md` §一/三 + `draft-overlay-states.html` aside 区 | ⚠ class `aside-region` 为废弃术语（规范名 Sidebar），见 README 术语表 |
| SH-03 | `components/shell/MainPanel.vue` | float-panel 浮起（唯一带 bg/border/radius/shadow），view 路由 chat↔overview | `shell/spec.md` §一 main-panel + `workspace/spec.md` | — |
| SH-04 | `components/shell/AppNavControls.vue` | 三平台导航按钮（收起/←/→），全屏 left 平移 | `shell/spec.md` §二/七-4 + `draft-overlay-states.html` nav-btn | — |
| SH-05 | `components/shell/TrafficLight.vue` | 跨平台窗口控制（mac 占位 / win·linux 自绘 3 圆点 mimic_mac） | `shell/spec.md` §五方案 X + `draft-overlay-states.html` | — |

### 1.2 Sidebar 层（4 个文件）

| # | 文件 | 功能 | 设计对应 | 🆕标记 |
|---|------|------|---------|--------|
| SB-01 | `components/sidebar/Sidebar.vue` | L1 Sidebar 容器，四态（A/B/C/D），分层：Brand→nav→Overview 入口→tab→子视图→用户区 | `sidebar/spec.md` §容器四态 + `draft-five-states.html` | — |
| SB-02 | `components/sidebar/SessionList.vue` | 会话列表（子视图 A），ScrollArea + SessionItem 列表 + 空态 | `sidebar/spec.md` §会话列表 + `draft-five-states.html` 卡 A/D | — |
| SB-03 | `components/sidebar/SessionItem.vue` | 单会话项，grid [dot][main][time]，active accent-soft + 左 2px accent 竖条，5 态状态点 | `sidebar/spec.md` §会话项 + `draft-session-item.html` | — |
| SB-04 | `components/sidebar/SegmentedTab.vue` | segmented 视图切换 tab（会话\|文件），互斥 + 计数 | `sidebar/spec.md` §视图切换 + `draft-five-states.html` §3 | — |

### 1.3 Workspace + Panel 层（10 个文件）

| # | 文件 | 功能 | 设计对应 | 🆕标记 |
|---|------|------|---------|--------|
| WP-01 | `components/workspace/Workspace.vue` | 容器，双 Panel 主从容器承载，空态引导 | `workspace/spec.md` + `panel/spec.md` | — |
| WP-02 | `components/workspace/PanelContainer.vue` | Panel 挂载点 + split 状态机（单/双），中缝 gap+bg-border | `workspace/spec.md` + `draft-dual-panel.html` | — |
| PN-01 | `components/panel/Panel.vue` | 容器，5 zone 编排（header→stream→progress→composer→git），四层激活标识 | `panel/spec.md` §5 zone + `workspace/spec.md` 激活标识 | — |
| PN-02 | `components/panel/PanelHeader.vue` | zone ① header：状态点 + breadcrumb + split/新建+关闭，-webkit-app-region:drag | `panel/spec.md` header + `workspace/spec.md` §Header + `shell/spec.md` §四 breadcrumb | — |
| PN-03 | `components/panel/MessageStream.vue` | zone ② 消息流：groupTurns→Turn 列表，auto-scroll | `panel/spec.md` message-stream + `draft-message-stream.html` | — |
| PN-04 | `components/panel/message-stream/Turn.vue` | 展示组件：回合（user 气泡 + assistant 折叠 trace + summary） | `draft-message-stream.html` §1/§4 | — |
| PN-05 | `components/panel/message-stream/Block.vue` | 展示组件：trace 块（thinking 紫斜体 / tool_call 青色 mono + 失败红框） | `draft-message-stream.html` §4 | — |
| PN-06 | `components/panel/Composer.vue` | zone ④ 输入区：4 态（S1/S2/S5/S6），工具条展示型（容量/模型/thinking-level），发送三态 | `panel/spec.md` composer + `draft-composer-states.html` | — |
| PN-07 | `components/panel/ProgressZone.vue` | zone ③ 进度区（composer 上方），可折叠容器，骨架空壳 | `panel/spec.md` progress-zone + `draft-companion-zones.html` | — |
| PN-08 | `components/panel/GitZone.vue` | zone ⑤ git 区（composer 下方），分支名 + 工作区状态 + Diff 按钮 | `panel/spec.md` git-zone + `draft-companion-zones.html` | — |

### 1.4 Overlays + Overview + Settings 层（4 个文件）

| # | 文件 | 功能 | 设计对应 | 🆕标记 |
|---|------|------|---------|--------|
| OV-01 | `components/overview/Overview.vue` | L1 Overview 容器，卡片网格 + 工具栏（标题/计数/新建）+ 空态 + Esc 退出 | `overview/spec.md` + `draft-overview.html` + `draft-entry.html` + ADR-0022/0005 | — |
| OV-02 | `components/overview/SessionCard.vue` | 单会话卡片：头部(状态点+标题+分支pill) + 摘要(2行ellipsis) + 指标行(改动/回合/时间)，Card-Active inset ring | `overview/spec.md` §卡片 + `draft-overview.html` §2 | — |
| OL-01 | `components/overlays/SearchModal.vue` | ⌘K 全局搜索浮层骨架（Dialog + 输入框 + 四类分组空壳） | `overlays/spec.md` + `draft-search-modal.html` | — |
| ST-01 | `components/settings/SettingsModal.vue` | 设置 modal 骨架（Dialog 居中 + 左 nav 5 菜单 + 右详情空壳） | `settings/spec.md` + `draft-settings-shell.html` | — |

### 1.5 UI 原子组件层（24 个文件，6 组）

| # | 组 | 文件 | 功能 | 设计对应 | 🆕标记 |
|---|-----|------|------|---------|--------|
| UI-01 | button | `ui/button/Button.vue` + `index.ts` | 按钮原语（variant/size） | `design-system.md` §按钮原语 + `ui-skeleton.md` | — |
| UI-02 | dialog | `ui/dialog/`（10 文件：Dialog + Content/Header/Title/Description/Footer/Close/Trigger/ScrollContent + index） | Dialog 浮层体系（shadcn 模式） | `design-system.md` §Dialog + settings/overlays/search 各 spec | — |
| UI-03 | dropdown-menu | `ui/dropdown-menu/`（14 文件：DropdownMenu + Content/Item/Trigger/Sub/SubContent/SubTrigger/Separator/Label/Shortcut/Group/CheckboxItem/RadioGroup/RadioItem + index） | 下拉菜单体系（shadcn 模式，大量 atom） | `design-system.md` §Dropdown + sidebar spec 右键菜单 | — |
| UI-04 | input | `ui/input/Input.vue` + `index.ts` | 输入框原语 | `design-system.md` §Input | — |
| UI-05 | scroll-area | `ui/scroll-area/ScrollArea.vue` + `ScrollBar.vue` + `index.ts` | 滚动容器原语 | `design-system.md` §ScrollArea + sidebar/overview/message-stream 各 spec | — |
| UI-06 | textarea | `ui/textarea/Textarea.vue` + `index.ts` | 多行输入原语 | `design-system.md` §Textarea + `panel/spec.md` composer §输入区 | — |
| UI-07 | tooltip | `ui/tooltip/`（4 文件：Tooltip + Content/Provider/Trigger + index） | Tooltip 体系 | `design-system.md` §Tooltip | — |

### 1.6 Composables 层（6 个文件）

| # | 文件 | 功能 | 🆕标记 |
|---|------|------|--------|
| CO-01 | `composables/useConnection.ts` | WS 连接生命周期 + 入站消息分发器（transport→pending/events 桥） | — |
| CO-02 | `composables/features/useSidebar.ts` | sidebar 业务编排（跨 api+stores 的唯一编排层），含 deriveStatus/D6 + sessionDigest | — |
| CO-03 | `composables/features/useChat.ts` | chat 业务编排（send/hydrate/abort），会话级流式订阅表 | — |
| CO-04 | `composables/effects/usePlatformChrome.ts` | 平台+全屏态注入（data-platform/data-fullscreen），isFullscreen 单例 ref | — |
| CO-05 | `composables/effects/useChatScroll.ts` | auto-scroll 副作用（贴底 + scrollToBottom） | — |
| CO-06 | `composables/logic/formatTime.ts` | 相对时间格式化纯函数 | — |
| CO-07 | `composables/logic/messageTurns.ts` | 消息回合分组纯函数 + thinking/tool 计数 + failed tool 检测 | — |

### 1.7 Stores 层（4 个文件）

| # | 文件 | 功能 | 🆕标记 |
|---|------|------|--------|
| STO-01 | `stores/navigation.ts` | 导航历史栈（entries[]+pointer，view:'chat' \| 'overview' \| 'settings'） | — |
| STO-02 | `stores/chat.ts` | 按 sessionId 分区的消息表 + 流式 chunk 追加 + isStreaming + hydrate | — |
| STO-03 | `stores/panel.ts` | Panel 树（单/双）+ split/close 状态机 + 四层激活标识 | — |
| STO-04 | `stores/session.ts` | Session 列表 + activeId + D6 derivedStatus 占位（骨架返回 'waiting'） | — |
| STO-05 | `stores/sidebar.ts` | tab 切换（sessions\|files）+ collapsed 折叠态 + localStorage 持久化 | — |

### 1.8 style.css + 入口文件

| # | 文件 | 功能 | 🆕标记 |
|---|------|------|--------|
| CSS-01 | `style.css` | v3 冷蓝暗色 design-tokens（:root）+ base reset + shadcn 命名别名 | — |
| APP-01 | `App.vue` | 应用根挂载点，L0 Shell 入口，useConnection 生命周期 | — |
| APP-02 | `main.ts` | Vue 应用初始化（createApp + pinia + 全局注入） | — |
| APP-03 | `types.ts` | 本地类型（NavEntry/DerivedStatus/PanelTreeNode） | — |

### 1.9 其他（lib/api/i18n/mock，不深入审查）

| # | 目录 | 说明 | 是否审查 |
|---|------|------|---------|
| OTH-01 | `lib/` | ws-client.ts, ipc.ts, utils.ts（cn 工具函数） | ❌ 非 UI 组件，归属基础设施 |
| OTH-02 | `api/` | domains/chat.ts, session.ts, transport.ts, events.ts, pending.ts, mock/ | ❌ 非 UI 组件，归属数据层 |
| OTH-03 | `i18n/` | locales/en-US.ts, zh-CN.ts | ❌ 非视觉设计，归属国际化 |
| OTH-04 | `mock/` | mock-ws.ts | ❌ 开发工具 |

---

## 2. wave 总览表

| wave 编号 | 目录/组 | 文件数 | 对应设计层 | 🆕高风险数 | 依赖 |
|----------|---------|--------|-----------|-----------|------|
| **B-PN-W1** | `panel/` + `workspace/`（10 文件：Panel, PanelHeader, MessageStream, Turn, Block, Composer, ProgressZone, GitZone, Workspace, PanelContainer） | 10 | L1-L4（panel spec + 5 draft + workspace spec + draft-dual-panel） | 1 | — |
| **B-SH-W2** | `shell/`（5 文件：AppShell, AsideRegion, MainPanel, AppNavControls, TrafficLight） | 5 | L0-L1（shell spec + 2 draft） | 1（aside-region 废弃术语） | — |
| **B-SB-W3** | `sidebar/`（4 文件：Sidebar, SessionList, SessionItem, SegmentedTab） | 4 | L1-L3（sidebar spec + 4 draft） | 0 | — |
| **B-OV-W4** | `overview/` + `overlays/` + `settings/`（4 文件：Overview, SessionCard, SearchModal, SettingsModal） | 4 | L1-L3（overview spec+2draft / overlays spec+1draft / settings spec+6draft） | 0 | — |
| **B-UI-W5** | `components/ui/` 全部原子组件（24 文件，6 组） | 24（6 组） | 原语层（design-system.md + ui-skeleton.md） | 0 | B-SH-W2, B-SB-W3, B-OV-W4（被业务层依赖） |
| **B-CS-W6** | `style.css` + `stores/` + `composables/` + `App.vue` + `types.ts`（全局根因高发区） | 10 | 全局（design-tokens.md + design-system.md + ADR-0004 + 各 spec 的全局约束） | 2（①主题初值缺失 ② settingsStore 不存在） | B-UI-W5（token 接入依赖 UI 原子层） |

### Wave 拆分解读

- **B-PN-W1** 文件最多（10），但 Panel 是 v3 核心模块（L1-L4），优先排第一。风险：Process Panel 已 v1 删除但需验证无残留。
- **B-SH-W2** 5 文件，Shell 是地基，aside-region 废弃术语是已知脏数据。
- **B-SB-W3** 4 文件，Sidebar 容器最成熟。
- **B-OV-W4** 合并三组低文件数的 overlay 层（Overview/Settings/SearchModal），共 4 文件。
- **B-UI-W5** 原子层 24 文件但全是一行模板（shadcn copy），6 组 = 6 个审查单元，归一个 wave 可行。标注依赖：被业务层依赖，优先审。
- **B-CS-W6** 全局根因高发区：style.css + stores + composables。这是"多余"发现的主力 wave。

---

## 3. 每个 wave 的详细审查计划

### Wave B-PN-W1 · Panel + Workspace 区

**覆盖**：10 文件，对应设计 panel/spec.md + workspace/spec.md + 5 panel draft + draft-dual-panel

**审查文件清单**：

| 子wave | 文件 | 设计来源 | 审查重点 |
|--------|------|---------|---------|
| W1-a | `Workspace.vue` | `workspace/spec.md` + `shell/spec.md` §主区切换 | 验证空态引导与设计一致（"开始你的第一个任务"文案）；空态有无「或按 ⌘N 新建」kbd 键提示 |
| W1-b | `PanelContainer.vue` | `workspace/spec.md` + `draft-dual-panel.html` | 双 panel 中缝 gap+bg-border（draft 同款）；单 panel 默认撑满；双 panel 第二 session 来源 DEFERRED 标注一致性 |
| W1-c | `Panel.vue` | `panel/spec.md` §5 zone 编排 + `workspace/spec.md` 激活标识 | **🆕高风险**：验证无 Process Panel 残留——Panel 内是否只有 5 zone（header/stream/progress/composer/git），是否有多余的独立 Process Panel 引用；四层激活标识（左 2px accent 竖条 + inset accent-ring + bg-surface-hover + opacity 0.5↔1）与 spec 一致 |
| W1-d | `PanelHeader.vue` | `panel/spec.md` header + `workspace/spec.md` §Header + `shell/spec.md` §四 breadcrumb | breadcrumb 三段结构（项目▸会话▸分支）与 shell spec §四 一致；split/新建会话 同槽位互斥 逻辑正确；关闭按钮双 panel 可见、单 panel 隐藏（G-013 DEFERRED）；拖拽区 -webkit-app-region:drag 的正确性 |
| W1-e | `MessageStream.vue` | `panel/spec.md` message-stream + `draft-message-stream.html` | 按 sessionId 分区读消息；groupTurns 分组调用；auto-scroll 行为；空态欢迎语（G2-004）文案 |
| W1-f | `Turn.vue` | `draft-message-stream.html` §1/§4 | user 气泡圆角不对称（右下尖角 14px 14px 4px 14px）；thinking badge/tool badge 色彩语义（reasoning 紫/info 青）；折叠 trace 展开/收起逻辑（working 默认展开）；收尾 summary 拼接逻辑；流式光标动画 |
| W1-g | `Block.vue` | `draft-message-stream.html` §4 | thinking 块（紫斜体，draft 同款）；tool_call 块（青色 mono，draft 同款）；tool 失败红框（danger border + 淡红底）；tool status 3 态（running/completed/error）渲染覆盖 |
| W1-h | `Composer.vue` | `panel/spec.md` composer + `draft-composer-states.html` | 4 态覆盖（S1 空/S2 输入中/S5 发送中/S6 停止）与 spec §8.5 一致；S3/S4 DEFERRED 入口正确 hide（不留 disabled 占位）；工具条 5 元素（上下文/模型/thinking-level 展示型 + 发送三态）与 draft 列对齐；steer ring S6 用中性非 accent（spec 要求） |
| W1-i | `ProgressZone.vue` | `panel/spec.md` progress-zone + `draft-companion-zones.html` | **🆕验证**：确认为空壳骨架非废弃——注释标注 "进度区待实现" + FG5 骨架是对应 spec §8.5 的 DEFERRED，非死代码；折叠/展开态容器结构；无 session 时隐藏 |
| W1-j | `GitZone.vue` | `panel/spec.md` git-zone + `draft-companion-zones.html` | 分支名+状态文案（"工作区干净"）与 draft 对齐；Diff 按钮存在但暂存/提交 hide（DEFERRED）；无 gitBranch 时隐藏 |

**🆕多余高风险标注**：
- **Panel.vue** → 验证无独立的 Process Panel 引用（设计已 v1 删除，走 ProgressZone 内嵌）
- **ProgressZone.vue** → 判定是否是多余空壳（当前 "进度区待实现" 是有意的 DEFERRED 骨架还是废弃占位）

---

### Wave B-SH-W2 · Shell 层

**覆盖**：5 文件，对应设计 shell/spec.md + draft-skeleton.html + draft-overlay-states.html

**审查文件清单**：

| 子wave | 文件 | 设计来源 | 审查重点 |
|--------|------|---------|---------|
| W2-a | `AppShell.vue` | `shell/spec.md` §一拓扑 | base 平铺（bg-bg）+ aside 透明融合 + main float-panel 三层语义；gap-3/p-3 值（12px=--space-3）；全屏态下折叠左缘唤回细条（rail-restore）的存在性与 spec 三路唤回一致性 |
| W2-b | `AsideRegion.vue` | `shell/spec.md` §一/三 | **🆕高风险**：class 名 `aside-region` 为废弃术语（规范名 Sidebar，见 README 术语表 + ui-skeleton.md），虽标注为已知问题但需确认是否影响 CSS 选择器一致性；pt-[52px] 安全区恒定（三平台统一，全屏也保留）；flex-basis 联动 sidebar.collapsed 逻辑 |
| W2-c | `MainPanel.vue` | `shell/spec.md` §一 main-panel | float-panel 唯一带 bg+radius+shadow（shadow-1 + shadow-2 叠加）；border-border + rounded-lg + bg-surface 与 spec 一致；view 路由 chat→Workspace, overview→Overview 正确 |
| W2-d | `AppNavControls.vue` | `shell/spec.md` §二 | 非全屏 left:90px / 全屏 left:20px（320ms transition，与 traffic-light 同步）；三按钮（收起/←/→）disabled 态 opacity-40；按钮尺寸 26×22 = draft 精确值（非 token 化） |
| W2-e | `TrafficLight.vue` | `shell/spec.md` §五方案 X | mac 空占位 ok；win/linux 3 圆点 mimic_mac（红#ff5f57/黄#febc2e/绿#28c840）；hover 整组显符号（X/Minus/Plus）；全屏 opacity:0；定位 left:20px top:20px |

**🆕多余高风险标注**：
- **AsideRegion.vue** → `aside-region` class 名：虽标注为已知废止词（待批量替换），但需确认是否有其他 `aside-region` 引用（如 CSS 选择器、e2e test 选择器）未纳入替换计划

---

### Wave B-SB-W3 · Sidebar 层

**覆盖**：4 文件，对应设计 sidebar/spec.md + 4 draft（five-states/session-item/file-view/collapsed-state）

**审查文件清单**：

| 子wave | 文件 | 设计来源 | 审查重点 |
|--------|------|---------|---------|
| W3-a | `Sidebar.vue` | `sidebar/spec.md` §容器四态 | Brand（xyz-agent logo 22px accent 方块+文字）；主操作 nav（新建 ⌘N，搜索 ⌘K DEFERRED hide）；Overview 入口按钮（独立分层，非 tab，active 转 accent）；segmented tab（会话\|文件）；子视图区（SessionList vs FileView placeholder）；用户区（渐变头像）；⌘N/⌘B 全局快捷键 |
| W3-b | `SessionList.vue` | `sidebar/spec.md` §会话列表 + `draft-five-states.html` 卡 A/D | ScrollArea 包裹；空态（"暂无会话" + 新建按钮）；v-for 渲染 SessionItem |
| W3-c | `SessionItem.vue` | `sidebar/spec.md` §会话项 + `draft-session-item.html` | 状态点 5 态色映射（running/waiting 脉冲，done/stopped/error 静态）；grid [dot][main][time] 布局；active: accent-soft 背景 + 左 2px accent 竖条；hover 时间隐去（draft 行为）；目录末段截取 + gitBranch 显示；重命名/删除按钮 DEFERRED hide |
| W3-d | `SegmentedTab.vue` | `sidebar/spec.md` §视图切换 + `draft-five-states.html` §3 | 两 tab 互斥（sessions\|files）；active 态 accent-soft + accent 文字；tab 计数（N/M）；files tab 计数=0（G2-003 defer 内容） |

---

### Wave B-OV-W4 · Overlays + Overview + Settings

**覆盖**：4 文件，对应设计 overview/spec.md + overlays/spec.md + settings/spec.md + 各 draft

**审查文件清单**：

| 子wave | 文件 | 设计来源 | 审查重点 |
|--------|------|---------|---------|
| W4-a | `Overview.vue` | `overview/spec.md` + `draft-overview.html` + `draft-entry.html` + ADR-0022/0005 | 覆盖整个 workspace（main）区，sidebar 持久（ADR-0022）；工具栏（标题+计数+"新建"按钮）；卡片网格 CSS grid auto-fill minmax(280px,1fr)；空态（dashed border + LayoutGrid 图标 + Primary 按钮）；Esc 退出（canBack 守卫，冷启动 no-op）；⌘N 快捷键（Sidebar 已绑，Overview 内部复用） |
| W4-b | `SessionCard.vue` | `overview/spec.md` §卡片 + `draft-overview.html` §2 | Card-Active inset ring（`ring-1 ring-inset ring-accent`，弃左竖条）；hover border-strong + surface-hover；摘要 2 行 ellipsis（line-clamp-2）；指标行（改动/回合/时间，有数据才渲染）；分支 pill（accent-soft 底 + accent 文字）；状态点 5 态（与 SessionItem 同源） |
| W4-c | `SearchModal.vue` | `overlays/spec.md` + `draft-search-modal.html` | Dialog 全局浮层（非 Sidebar 子组件，归属 overlays/spec.md 裁决）；⌘K 触发入口 DEFERRED hide；四类分组（命令/文件/符号/会话）骨架空壳；Esc 关闭；输入框 autofocus |
| W4-d | `SettingsModal.vue` | `settings/spec.md` + `draft-settings-shell.html` | modal 形态（居中 Dialog + 无模糊背景，spec 要求 backdrop blur）；左 nav 5 菜单（Provider/Skill/Agent/Extension/System）+ 选中态 inset accent ring；右详情区（page-header + 空壳占位）；DEFERRED 触发入口（⌘, / sidebar 头像，G-021） |

---

### Wave B-UI-W5 · UI 原子组件层

**覆盖**：6 组（24 文件），对应设计 `design-system.md` + `ui-skeleton.md`

> **策略**：每组审查为一个审查单元（非每文件），关注 token 接入与 design-system.md 原语层一致性。

**审查文件/组清单**：

| 子wave | 组 | 文件 | 设计来源 | 审查重点 |
|--------|-----|------|---------|---------|
| W5-a | button | `Button.vue` + `index.ts` | `design-system.md` §Button 原语 | variant（default/ghost/outline/destructive/secondary）+ size（sm/default/icon）枚举与 design-system 一致；CSS 变量接入（bg/border/text 各 token 名）；focus-visible ring 色（--ring） |
| W5-b | dialog | `Dialog.vue` + 9 子组件 + `index.ts` | `design-system.md` §Dialog + settings/overlays/search 各 spec | 弹层位置（居中 vs 右滑等）；backdrop 模糊（overlays spec 要求 backdrop blur）；各子组件（Content/Header/Title/Description/Footer/Close/Trigger/ScrollContent）完整性与 shadcn 一致性 |
| W5-c | dropdown-menu | 14 子组件 + `index.ts` | `design-system.md` §Dropdown + sidebar spec 右键菜单 | shadcn 模式完整性；各子组件（Content/Item/Trigger/Sub/Separator/Label/Shortcut/Group/CheckboxItem/RadioGroup/RadioItem）token 接入；实际业务使用（无使用=🆕多余风险） |
| W5-d | input | `Input.vue` + `index.ts` | `design-system.md` §Input | 尺寸变体；border/ring token 接入；placeholder 色（--muted） |
| W5-e | scroll-area | `ScrollArea.vue` + `ScrollBar.vue` + `index.ts` | `design-system.md` §ScrollArea | 滚动条样式（thumb background/border-radius）；与 message-stream scoped scrollbar 样式冲突检查 |
| W5-f | textarea | `Textarea.vue` + `index.ts` | `design-system.md` §Textarea + composer spec | 尺寸/ring token 接入；composer 使用的 Textarea 覆盖样式是否冲突 |
| W5-g | tooltip | 4 子组件 + `index.ts` | `design-system.md` §Tooltip | Provider/Content/Trigger 体系完整性；token 接入 |

**🆕多余高风险标注**：
- **dropdown-menu** 组 14 子组件——当前业务代码无右键菜单实现，需确认是 shadcn 全量复制还是按需引入。若 RadioGroup/RadioItem/CheckboxItem 等无使用场景，标记为 🆕多余待清理。

---

### Wave B-CS-W6 · 全局根因高发区（style.css + stores + composables + 入口文件）

**覆盖**：10 文件，对应 design-tokens.md + design-system.md + ADR-0004 + 各 spec 全局约束

**这是"多余"发现的主力 wave**。

**审查文件清单**：

| 子wave | 文件 | 设计来源 | 审查重点 |
|--------|------|---------|---------|
| W6-a | `style.css` | `design-tokens.md`（SSOT，不在 v3-demo 内但在 docs/designs/ 根）+ ADR-0018 + ADR-0004 | **① 确认只含 v3 冷蓝 token，无 Warm & Soft 遗留**（旧 design-system.md 的 `--brand`/`--amber`/`--rose`/`--teal` 等 Warm 色板已在 v3 推翻）；**② 命名一致性**：`--fg`/`--muted`/`--subtle`/`--border`（非旧 `--text*`/`--divider`）；**③ shadcn 命名别名**是否正确映射、有无语义分歧（已知 `--muted` 分歧已文档化）；**④ design-tokens.md 同步性**：CSS 变量名/值与 design-tokens.md（`docs/designs/design-tokens.md`）是否一致——SSOT 是 design-tokens.md 文件，style.css 是落地。若 SSOT 有 `--radius-sm:3px`/`--radius:8px`/`--radius-lg:12px`，CSS 是否全；**⑤ 是否有 `data-theme` 切换机制**（亮/暗切换），还是完全硬编码 :root |
| W6-b | `stores/navigation.ts` | `ui-skeleton.md` §3 view + D1 | view 枚举 `'chat' \| 'overview' \| 'settings'` 与设计三 view 一致；MAX_ENTRIES=50 合理；指针分支截断逻辑；empty stack fallback `{view:'chat'}` 合理 |
| W6-c | `stores/chat.ts` | panel spec G2-006 块类型契约 + draft-message-stream §4 | 块类型覆盖（text/thinking/tool_call/error）与 draft 7 类块一致；message.error 处理遵循 CLAUDE.md 规则 #3（不卡思考中）；stream_error 合成 error 消息逻辑；appendAssistantChunk 各 case 完整性 |
| W6-d | `stores/panel.ts` | `workspace/spec.md` + `panel/spec.md` 状态机 | 单/双 panel 状态机（split/close）与 workspace spec 一致；四层激活标识无 store 层耦合（标识属面板 [Panel.vue] 的 CSS class，store 只管数据）；ROOT_PANEL_ID 命名；第二 session 来源 G-023 DEFERRED 标注 |
| W6-e | `stores/session.ts` | `sidebar/spec.md` §会话项 + D6 | derivedStatus 骨架返回 'waiting'（合法默认，非 'idle' 废弃词）；active 派生 computed；store 间隔离（不 import 其他 store） |
| W6-f | `stores/sidebar.ts` | `sidebar/spec.md` §视图切换 + §折叠态 | activeTab 持久化（localStorage `xyz-agent-sidebar`）与 spec 一致；VALID_TABS 白名单防篡改；折叠态 toggleCollapsed |
| W6-g | `composables/features/useSidebar.ts` | D6 + UC-2/UC-3 + `panel/spec.md` 状态与交互 | **🆕高风险：验证 features 层是唯一跨 api+stores 的编排层**（R2 铁律 1）；deriveStatus 五态优先级（waiting>running>error>stopped>done）；loadSessions 全量预 hydrate（TODO 联调标注）；selectSession 的 panelId opts 路径（支持待机侧替换） |
| W6-h | `composables/features/useChat.ts` | G2-006 + UC-2 数据流链 | 会话级流式订阅表（避免 per-send 订阅被提前拆除 [HISTORICAL]）；send 的 isStreaming 守卫 + 非空检验；message_start/complete/error 驱动的 streaming 状态 |
| W6-i | `composables/effects/usePlatformChrome.ts` | `shell/spec.md` §七-3/4 | detectPlatform UA 解析（mac/win/linux）覆盖；isFullscreen 单例 ref（跨 TrafficLight+AppNavControls 共享）；Electron API 降级（web/mock 环境） |
| W6-j | `App.vue` + `types.ts` | `shell/spec.md` + D1/D6/P3 类型定义 | App.vue 根挂载：AppShell 单挂载点正确（无多余全局组件）；types.ts：DerivedStatus 五态（running/waiting/done/stopped/error）与 D6 契约一致；NavEntry.view 枚举 `'chat' \| 'overview' \| 'settings'` 完整 |

**🆕核心多余高风险标注**：

1. **🎯 settingsStore 缺失**（ADR-0004-B 已裁决暗色冷蓝为真默认，但 render 仓库中**根本没有 settingsStore**）：
   - `style.css` 硬编码 `:root {}` token，无 `[data-theme="light"]` 等亮色变体
   - `stores/` 目录无 settings store（theme/themePreset 等字段）
   - SettingsModal.vue 是纯骨架——无 System 菜单表单（语言/外观/配色主题）
   - ADR-0004 设计的 `theme: 'dark'` / `themePreset: 'cold-blue'` 在 render 中未落地
   - **判定**：🆕这既不是实现的缺失（style.css 确实只有暗色且设计就是暗色为默认），也不是设计的缺失——而是 **settingsStore 不存在** → 无主题切换机制 → 与 system draft/handoff 的完整表单预期有鸿沟。设计 doc 要求有 settings store 管理主题且在 System 菜单中可配置，实现没有。

2. **🎯 style.css 无亮色变体**（与 ① 联动）：
   - 设计 tokens 是暗色 SSOT，但 design-tokens.md 可能已给出部分亮色值（`[data-theme="light"]`）
   - style.css 的注释说 "亮色变体待 settingsStore 接入，design-tokens 仅给出部分亮色值，未给全前不臆造落地" —— 这与 ADR-0004-B 裁决一致，但需确认亮色值在 SSOT 中是否已给全、style.css 是有意不落地还是未接入。

3. **dropdown-menu 原子组 14 文件**（无业务使用）：需确认是否全为 shadcn 按需引入还是全量复制。无使用的子组件（RadioGroup/RadioItem/CheckboxItem/Sub*）标记 🆕多余。

---

## 4. 全局根因高发区清单

> 以下是从渲染树探查中识别的全局性问题，跨多个 wave。

### 4.1 style.css 配色体系

| 检查项 | 当前状态 | 设计要求 | 风险 |
|--------|---------|---------|------|
| Warm & Soft 遗留色 | **未发现** — CSS 只有 v3 冷蓝 token，`--text*`/`--divider` 注释中明确标记为"非旧" | 不应有任何 Warm token（--brand/#d97706 等）| 低。预检已干净 |
| 命名体系 | `--fg`/`--muted`/`--subtle`/`--border`（SSOT 名） | ADR-0018 裁决归一 | 低。已对齐 |
| shadcn 别名 | `--primary:var(--accent)`, `--secondary:var(--surface)` 等 10 个别名 | design-tokens.md §shadcn 命名映射 | 中。已知 `--muted` 语义分歧（v3=文字色 / shadcn=背景色）已文档化，需确认业务代码无误用 |
| `--section-bg`/`--divider`/`--accent-light` | **未发现** — ADR-0004 说 impl 用了这三个自造名，但 render 仓库 style.css 中不存在 | ADR-0004-B 裁决：迁移到 SSOT 名 | 低。这些是 main worktree 的遗留，非当前 worktree。但需确认 render 仓库无类似自造 token |
| 亮色变体 | **无** — `:root` 硬编码暗色，无 `[data-theme]` 切换 | ADR-0004 要求暗色为真默认但需有 settingsStore 管理切换 | **高**。需 B-CS-W6 审查 |
| design-tokens SSOT 同步性 | 需逐项对比 | `docs/designs/design-tokens.md`（不在 v3-demo 内）是 SSOT | **高**。需 B-CS-W6 审查：CSS 变量是否与 SSOT 完全一致 |

### 4.2 主题默认值与 settingsStore

| 检查项 | 当前状态 | 设计要求 | 风险 |
|--------|---------|---------|------|
| 主题默认值 | **无** — 暗色硬编码，无主题概念 | ADR-0004-B：暗色冷蓝为真默认 | **高** |
| settingsStore 存在性 | **不存在** — `stores/` 无 settings.ts | System 菜单需读写 theme/themePreset/locale 等 | **高** |
| System 菜单表单 | SettingsModal.vue 骨架注释 "配置项待联调阶段实现" | settings spec + handoff-system.md §2/§11a | **高** |

### 4.3 Process Panel 遗留

| 检查项 | 当前状态 | 设计决策 | 风险 |
|--------|---------|---------|------|
| Process Panel 残留 | **未发现** — Panel.vue 5 zone 无独立 Process Panel | panel/spec.md line 59/100：v1 删除，进度走 ProgressZone | 低。免审查 |
| "Process" 关键词 | 仅在注释中出现（ui-skeleton.md 章名） | — | 低。注释无副作用 |

### 4.4 废弃术语残留

| 废弃词 | 规范词 | 当前残留位置 | 风险 |
|--------|--------|------------|------|
| `aside-region` | Sidebar（侧栏容器） | `AsideRegion.vue` class 名 + Template 注释 | 中。已知待批量替换（README §清理计划），需确认 CSS 选择器/测试无硬编码 `aside-region` |
| `ChatView` | Panel/Workspace | **未发现** — 代码 clean | 无 |
| `会话列表视图 / session panel` | Session List | **未发现** — 代码 clean | 无 |

### 4.5 Components UI 原子组件冗余

| 检查项 | 当前状态 | 风险 |
|--------|---------|------|
| dropdown-menu 14 子组件 | 大量子组件无业务使用（RadioGroup/RadioItem/CheckboxItem/Sub*） | **高**。shadcn CLi 全量 copy 的可能 |
| dialog 10 子组件 | 部分子组件无使用（DialogFooter/DialogScrollContent 等） | 中 |

---

## 附录：设计源文件索引（快速查阅）

| 设计层 | spec | draft |
|--------|------|-------|
| L0 Shell | `v3-demo/shell/spec.md` | `draft-skeleton.html`, `draft-overlay-states.html` |
| L0 总纲 | `v3-demo/ui-skeleton.md` | `skeleton-chain.html` |
| L1 Sidebar | `v3-demo/sidebar/spec.md` | `draft-five-states.html`, `draft-session-item.html`, `draft-file-view.html`, `draft-collapsed-state.html` |
| L1 Workspace | `v3-demo/workspace/spec.md` | `draft-dual-panel.html` |
| L2 Panel | `v3-demo/panel/spec.md` | `draft-message-stream.html`, `draft-composer-states.html`, `draft-companion-zones.html`, `draft-detail-pane.html`, `draft-breadcrumb-popovers.html` |
| L1 Overlays | `v3-demo/overlays/spec.md` | `draft-search-modal.html` |
| L1 Overview | `v3-demo/overview/spec.md` | `draft-overview.html`, `draft-entry.html` |
| L1 Settings | `v3-demo/settings/spec.md` | `draft-settings-shell.html`, `draft-provider.html`, `draft-extension.html`, `draft-system.html`, `draft-settings-agent.html`, `draft-settings-skill.html` |
| Global | `docs/designs/design-tokens.md`（不在 v3-demo 内）, `docs/designs/design-system.md` | — |
| ADR | `adr-0001`~`0005` | — |

---

## 审查执行说明

1. **每个 wave 产出一份** `wave-<编号>-<区域>.md`，遵守 `audit-template.md` 模板
2. **B-UI-W5 优先于 B-PN-W1**（原子层被业务层依赖，先审原子层可减少业务层审查时的 token 噪声）
3. **B-CS-W6 最后审**（全局根因依赖前 5 个 wave 的发现来聚类）
4. **推荐执行顺序**：W5 → W2 → W3 → W4 → W1 → W6
5. **每个 wave 由独立的执行 subagent 负责**（阶段 C）
