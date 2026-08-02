# Renderer 目标架构 + Plugin 渲染机制设计（v6）

> **状态**：目标架构设计（待评审 → 视觉稿联动 → 实施计划）
> **性质**：长期方案。抛开当前架构，按最长期合理方案重新设计 renderer 分层 + plugin 渲染终态。
> **定位**：本文档与 `v6-architecture-refactor.md`（审查+缝补）互补。那份回答「现状有什么问题、怎么修」，本文档回答「终态应该长什么样」。
> **依据**：plugin-sdk 架构审查 + extension-gui-protocol 整合分析 + VSCode 插件调研 + 16 视图挂载点盘点（5 路深度探索交叉验证）。
> **给视觉稿的输入**：§3「终态 plugin 渲染机制」定义了 plugin 可自定义的 5 视图维度 × 3 自定义级别，每个维度列出了「需要视觉稿定义什么」的清单。

---

## §0 核心判定：统一扩展架构

### 0.1 结论

项目有两套扩展机制：①pi 扩展（extension-gui-protocol，已实现，widget/status/tool result/ask-user）②plugin 系统（plugin-sdk，借鉴 VSCode，协议已定义但 renderer 零消费）。

**终态统一方案**：两者正交组合，非二选一。

| 机制 | 终态角色 | 理由 |
|---|---|---|
| **plugin-sdk** | 进程架构**主干**（生命周期/Worker 隔离/JSON-RPC/懒激活/Disposables/权限） | 比 pi extension（同进程无隔离）先进一代；VSCode 核心设计采纳到位 |
| **extension-gui-protocol 的 GuiComponent** | 统一**渲染协议**（pi extension + plugin 共享） | 类型层零 pi 依赖，本就是通用渲染原语；pi extension 和 plugin 在「结构化数据渲染」上面临完全相同问题（都不在 renderer 进程，都只能传可序列化数据） |

**为什么能统一**：pi extension（跑在 pi 子进程）和 plugin（跑在 Worker Thread）都**不在 renderer 进程**，都不能传 Vue 组件，都只能传可序列化数据。GuiComponent 的 7 个结构化原语（card/list-tree/stats-line/progress-bar/columns/tab-bar/ansi-text）本就是为「跨进程结构化渲染」设计的——它天然是两套机制的共享渲染层。

### 0.2 统一需解的 3 个冲突（来自审查）

plugin-sdk 审查发现 3 个致命冲突，统一前必须解决：

1. **三套 UI 接口冲突**：pi 的 `ctx.ui`（select/confirm/input/setWidget/setStatus）+ plugin 的 `api.ui`（showSelect/showConfirm/showInput/notify/updateStatusBarItem）+ GuiComponent——三种抽象并存，消息类型不一（`extension.ui_request` vs `plugin:uiRequest`），renderer 只消费前者。
2. **plugin panels 无渲染链路**：`contributes.panels` 声明了但 renderer 零消费，runtime 注释明确「Phase 3+ 待实现」。
3. **tool/hook 重叠**：plugin 的 toolRegistration + pi 的 registerTool 都注册 tool，两套执行路径。

→ 解决方案见 §7（UI 接口统一）/ §3（panels 渲染）/ §8（tool/hook 适配）。

### 0.3 兼容性铁律

**pi extension 开箱即用**——这是统一的前提，不是可选项。理由：xyz-agent 通过 pi 生态获得海量 pi-extension，破坏兼容性等于自断生态。

具体保证：
- **未引入 extension-protocol 的 pi extension**：走 ANSI 兜底（永留），零改动可用。TUI 输出在 GUI 下按 v6 重设计着色（ANSI 16 色 → 冷蓝暗色映射，§5.7）。
- **已引入 extension-protocol 的 pi extension**：继续产出 `details.__gui__`，renderer 用 GuiComponent 渲染。协议类型不变，只是 7 原语视觉按 v6 重设计（§5）。
- **迁移是渐进的**：协议是「渐进增强，不是强制要求」。v6 视觉重设计改的是前端组件 CSS/模板，不改协议类型，已接入的 extension 零改动自动获得 v6 视觉。

---

## §1 设计原则（6 条）

1. **插件隔离优先（No DOM Access 铁律）**：插件代码绝不进 renderer 进程。所有 UI 经结构化数据（GuiComponent）或声明式元数据驱动，renderer 统一渲染。这是 VSCode 的核心安全边界。
2. **声明式优先于编程式**：contribution 在 manifest 声明（不加载代码即可注册），支持懒激活、静态分析、命令面板在插件未激活时就显示其命令。
3. **数据驱动渲染**：插件提供数据（GuiComponent 原语树 / 声明式元数据），renderer 用统一渲染器渲染。插件无法直接影响渲染层 DOM。
4. **单一渲染协议**：pi extension 和 plugin 共用 GuiComponent，一套原语、一套 v6 视觉、一套降级策略，无论数据源。
5. **API 稳定性分层（stable/proposed/internal）**：主干化即 API 冻结点。借鉴 VSCode 教训1（API 一旦发布无法收回），用 proposed 分层做缓冲，Object.freeze 防篡改。
6. **per-session 隔离内建**：ADR-0049 的 `useSessionScopedState` 工厂是一等公民，所有 per-session 状态默认隔离，不依赖开发者记得清空。

---

## §2 目标分层架构（renderer 七层）

抛开当前 features/panel 巨型桶的现状，按职责重新分层：

```
┌─────────────────────────────────────────────────────────────────┐
│  Shell Layer    应用壳：窗口拓扑 / 全局快捷键 / view 路由        │
│  AppShell · AsideRegion · MainPanel · AppNavControls            │
├─────────────────────────────────────────────────────────────────┤
│  Workspace Layer 工作区：双 panel 主从 / drawer 容器 / overview │
│  Workspace · PanelContainer · Panel · SideDrawer               │
├─────────────────────────────────────────────────────────────────┤
│  Feature Layer   功能域（按业务域切，非按减行）                  │
│  chat · session · sidebar · new-task · settings · search       │
│  每域 = 容器组件 + composable + store（内聚，非散落）           │
├─────────────────────────────────────────────────────────────────┤
│  Extension Host Layer ★ 新增 ★ 扩展宿主                          │
│  ContributionRegistry · ActivationManager · ViewHost           │
│  CommandRegistry · StatusBarController · MessageBusBridge      │
│  消费 plugin/pi-extension 的 contribution，驱动渲染分发          │
├─────────────────────────────────────────────────────────────────┤
│  Rendering Protocol Layer ★ 提升 ★ GuiComponent 统一渲染协议     │
│  GuiComponentRenderer（7 原语）+ Dialog/AskUser/StatusBar 原语   │
│  pi extension + plugin 共享，v6 视觉对齐                        │
├─────────────────────────────────────────────────────────────────┤
│  Transport & Coordination Layer ★ 新增（远程化预留）★           │
│  连接管理 + 可靠投递 + 多客户端协同                              │
│  useConnection · ws-client · lib/remote/(config/parse/probe)   │
│  routeInbound(声明式路由表) · seq gap · auth 握手状态机        │
│  presence store · lease 消费 · ipc-adapter(降级 stub)          │
├─────────────────────────────────────────────────────────────────┤
│  Foundation      store / composable 基础设施 / i18n             │
│  useSessionScopedState · ui 原语(button/dialog)               │
│  Pinia stores(30) · event-bus                                  │
└─────────────────────────────────────────────────────────────────┘
```

**关键变化**：
- **Extension Host 是新增层**：当前 renderer 没有「扩展宿主」概念，pi extension 的 UI 消费散落在 useExtensionUI/useDrawerWidgetBuffers/extensions/registry.ts 等。新架构把扩展消费收敛为独立层。
- **Rendering Protocol 从「pi extension 专用片段」提升为「共享层」**：当前 GuiComponentRenderer 只服务 tool result/widget，新架构下 plugin 面板也走它。
- **Transport & Coordination（T&C）层是远程化预留**：当前 `feat-optimize-ui` 分支是单进程桌面 SPA，连接逻辑（useConnection/ws-client）散落在 Foundation 层一行。远程化（`feat-remote-use` 分支）引入双模式（本地+远程）+ 多客户端协同（lease/presence/seq 可靠投递）+ auth 握手，这些逻辑跨 renderer+runtime，复杂度远超 Foundation 一行能容纳。T&C 层为远程化提供**归位点**——合并时连接/协同逻辑全部归位此层，不散落 Foundation/Feature。
- **Feature Layer 按业务域切**：解决当前 features(41)/panel(37) 两巨型桶无业务域分组的问题。每个功能域（chat/session/sidebar/...）是容器+composable+store 的内聚单元。

### 2.1 层间依赖铁律

> 合并远程化或新增功能时，先按此规则判定代码归属哪层，再动手。

1. **单向依赖**：上层可依赖下层，**下层不可依赖上层**。依赖方向严格自上而下（Shell → Workspace → Feature → ExtensionHost → RenderingProtocol → T&C → Foundation）。
2. **同层禁止循环**：同层模块可互相引用，但不能形成环。
3. **跨层直连反例**（禁止）：
   - Feature 层组件**不应**直接调 Foundation 的 `ws-client`（应经 T&C 层 `useConnection`）
   - Foundation 层 store **不应** import Feature 层 composable（倒置依赖）
   - T&C 层 routeInbound 分发消息**应**经事件消费层（B2 的 useMessageEffects），不直接触达 Feature 层 store 的内部方法

### 2.2 功能归属规则表

> 判定一个文件/模块归属哪层，按「状态作用域 + 依赖方向」两个维度查表。

| 判定维度 | → 归属层 | 典型例子 |
|---|---|---|
| **跨 session 全局协同态**（多客户端共享、连接生命周期、断线重连） | **T&C 层** | presence store · lease 消费 · auth 握手 · seq 可靠投递 · ws-client · useConnection · routeInbound · lib/remote/ |
| **per-session 隔离状态**（每 session 独立分区，切 session 切分区） | **Foundation** | useSessionScopedState 工厂 · chat 流 · streaming 状态 · composer 草稿 |
| **全局 store 基础设施**（跨功能域共享、本身无业务逻辑） | **Foundation** | settings/panel/navigation store · ui 原语 · event-bus |
| **业务域容器+交互**（有 UI、用户直接操作、按域内聚） | **Feature 层** | chat 组件树 · session 列表 · sidebar · settings 页 · search |
| **plugin/pi-extension 渲染消费**（扩展贡献的 UI 接入） | **ExtensionHost 层** | ViewHost · CommandRegistry · StatusBarController · MessageBusBridge |
| **结构化数据→原语渲染**（GuiComponent 7 原语） | **RenderingProtocol 层** | GuiComponentRenderer · Dialog/AskUser/StatusBar 原语 |
| **窗口拓扑/路由**（应用级骨架、全局视图切换） | **Shell 层** | AppShell · view 路由 · 全局快捷键 |
| **双 panel 容器编排**（多 panel 布局、drawer 收展） | **Workspace 层** | PanelContainer · SideDrawer · SplitterGroup |

**模糊归属判定**（一功能可属多层时，按主要职责归一层）：
- `useConnection`：虽是 composable，但核心职责是连接管理（非业务域交互）→ **T&C 层**（不进 Feature 层 composables/features/）
- `routeInbound`：消息路由分发，是 T&C 层的「入口路由器」→ **T&C 层**（不进 Foundation）
- `stores/presence.ts`：全局协同态 → **T&C 层**（不进 Foundation 的通用 store 桶）
- `stores/session.ts` 的 lease 字段：数据存 Foundation store，但 lease 的**消费逻辑**（acquire/release/过期清理）归 T&C 层

**归属速查表**（已知文件按层归类，合并时直接查）：

| 文件/模块 | 归属层 | 备注 |
|---|---|---|
| `composables/useConnection.ts` | T&C | 连接编排 + routeInbound；MANUAL_FORK（mobile 砍本地分支） |
| `lib/ws-client.ts` | T&C | WS 状态机（远程化后 +auth/seq/RTT/presence） |
| `lib/remote/*` | T&C | 远程化新增（connection-config/parse-connect-info/probe/ws-origin/types） |
| `lib/ipc.ts` | T&C | Electron IPC 桥接 + 降级 stub（mobile 全 no-op） |
| `stores/presence.ts` | T&C | 远程化新增，全局协同态 |
| `components/remote/*` | T&C | 远程连接 UI（RemoteConnectModal 等） |
| `stores/chat.ts` · `stores/session.ts` · `stores/panel.ts` | Foundation | 通用 store 基础设施（session.ts 含 lease 字段但 store 本身属 Foundation） |
| `composables/useSessionScopedState.ts` | Foundation | per-session 隔离工厂（ADR-0049） |
| `components/ui/*` | Foundation | xyz-ui 原语 |
| `composables/features/chat/*` · `components/panel/*` | Feature | 业务域（chat/session/sidebar/settings/search） |
| `extensions/registry.ts` · `composables/useExtensionUI.ts` | ExtensionHost | 扩展消费（当前散落，合并时归位） |
| `components/panel/message-stream/GuiComponentRenderer.vue` | RenderingProtocol | 7 原语统一渲染器 |
| `components/panel/message-stream/gui/*` | RenderingProtocol | 7 原语组件（Card/TabBar/ProgressBar 等） |
| `components/shell/AppShell.vue` · `AppNavControls.vue` | Shell | 窗口拓扑 |
| `components/workspace/*` | Workspace | 双 panel 容器 |

### 2.3 远程化合并指引（feat-remote-use → main 后）

> `feat-remote-use` 分支（86 commits，P0-P7 全交付）引入远程化功能。合并时按本节归位。

**T&C 层是远程化的归位点**——以下远程化新增/扩展全部归 T&C 层：

| 远程化改动 | 归位到 T&C 层的什么位置 |
|---|---|
| `lib/remote/`（5 文件，新增） | 直接进 T&C 层（已在速查表） |
| `ws-client.ts` auth 握手 / seq / RTT / presence 扩展（+516 行） | T&C 层 ws-client（原地扩展，不拆文件） |
| `useConnection.ts` routeInbound 远程分支（5 类新增消息） | T&C 层 routeInbound 的 ROUTE_TABLE 条目（见 B3） |
| `useConnection.ts` 双模式 init() + retryRuntime 分支 | T&C 层 useConnection（本地/远程分支由 connection-mode 驱动） |
| `stores/presence.ts`（新增） | T&C 层 presence store |
| `stores/session.ts` lease 字段 + busy/idle 消费 | store 留 Foundation，**消费逻辑**（acquire/release/过期）归 T&C 层 |
| `components/remote/*`（4 组件，新增） | T&C 层连接 UI |
| `lib/ipc.ts` 降级机制 | T&C 层 ipc-adapter |

**合并顺序**：remote 先进 main，v6 重构在 remote 之上做。B3 的 routeInbound 声明式路由表重构必须在远程化之上做——先把远程化的 5 类消息分支纳入 ROUTE_TABLE，而非回退 if-else。

**sync 兼容纪律**：被 `sync-mobile-from-renderer.sh` COPY_MAP 覆盖的文件（composables/stores/components/message-stream 等），v6 重构改路径/合并/删除时必须同步更新 sync 脚本。MANUAL_FORK 的 `useConnection.ts` 路径锁定不移动（保持在 `composables/useConnection.ts`），否则 sync 的 `--force` 会误覆盖 mobile 侧的 fork 版本。

**协同状态在 ADR-0049 隔离模型中的位置**：presence（全局协同态）和 lease（runtime TTL 管控，非 renderer 发起）是 ADR-0049 per-session 隔离的**显式例外**——它们不进 `useSessionScopedState` 分区。`triggerSessionCleanups(id)` 必须订阅 `session.deleted` 广播，确保其他客户端删 session 时本地 lease 同步清除。

---

## §3 终态 plugin 渲染机制 ★ 核心 ★

> 这一章是给视觉稿联动的设计输入。定义「plugin 能往哪些视图注入、注入什么、改到什么程度」。
>
> **v2 修订（2026-07-31，基于视觉规格线 v6-spec-plugin-rendering 实践反馈）**：
> 1. **维度收缩 5→4**：C 维度（对话框）并入 B 维度（companion-band 已在渲染层统一出口，C 仅因 API 不同才单列，不再独立）
> 2. **挂载点分 Tier**：16 个分 Tier 1（12 个活注入点）/ Tier 2（4 个边缘：M3/M6/M13/M15）
> 3. **A2 drawer tab 标 proposed**：plugin view 收口 sidebar 第 5 tab，drawer 暂不开放
> 4. **补 C3 overlay lifecycle + 原语扩展路线**（视觉线发现的 2 个盲区）

### 3.1 真实视图拓扑（设计依据）

从源码读出的完整嵌套（修正了「drawer 是 AppShell 顶层区域」的错误假设——drawer 实际在 PanelContainer 内，与 Panel 并排可拖拽）：

```
AppShell (flex h-screen)
├─ [浮层] AppNavControls (折叠/←/→ 三按钮)
├─ AsideRegion (<aside>, 留 traffic-light 安全区)
│  └─ Sidebar (w-300px)
│     ├─ Brand 区 (logo + 版本 + UpdateButton)
│     ├─ 主操作 nav (新建⌘N / 搜索⌘K)
│     ├─ Overview 入口 Button
│     ├─ SegmentedTab (4 tab: sessions/files/subagents/workflows)  ← M1 挂载点
│     ├─ 子视图区 (按 activeTab 切换)                               ← M2 挂载点
│     │  ├─ sessions → SessionList
│     │  ├─ files → FileView
│     │  ├─ subagents → SubagentList
│     │  └─ workflows → WorkflowList
│     └─ footer (头像 + Settings 齿轮)
├─ MainPanel (<main>, 唯一浮起面板)
│  └─ [view 路由: chat / overview]                                  ← M14 挂载点
│     └─ Workspace
│        ├─ [全局] ExtensionUIDialog                                ← M15 挂载点
│        └─ PanelContainer (SplitterGroup)
│           ├─ Panel#main (5 zone)
│           │  ├─ PanelHeader (按钮组)                              ← M12 挂载点
│           │  ├─ MessageStream (对话流)
│           │  │  ├─ Turn → Block (tool/text/thinking)              ← M4 挂载点
│           │  │  ├─ custom message (__gui__)                       ← M5 挂载点
│           │  │  └─ [浮层: load-more/fork-notice/jump]             ← M13 挂载点
│           │  ├─ companion-band
│           │  │  ├─ ProgressZone
│           │  │  └─ AskUserOverlay | Composer（含 confirm/select/input） ← M11 挂载点
│           │  │     └─ Composer
│           │  │        ├─ CommandPopover (slash 菜单)              ← M10 挂载点
│           │  │        └─ composer-bar 工具条 (6 元素：+添加/spacer/上下文/模型/思考强度/send-slot) ← M9 挂载点
│           │  └─ main-panel 局部底栏 (composer 下方，不跨 sidebar/drawer) ← M8 挂载点
│           └─ SideDrawer#drawer (可拖拽)
│              ├─ header tab栏 (terminal/browser/git/doc/detail/tasks) ← M6 挂载点
│              └─ 内容区 (按 tab 切换)                               ← M7 挂载点
│                 ├─ widget/widgetGui → GuiComponentRenderer
│                 └─ 各固定 tab 组件
└─ SettingsModal (⌘, 全局 Dialog)                                   ← M16 挂载点
   + [全局] ToastContainer
```

### 3.2 4 个视图自定义维度（plugin 能往哪里注入）

> v1 是 5 维度（A/B/C/D/E）。v2 收为 4 维度——**C（对话框）并入 B**。
>
> **为什么 C 并入 B**：视觉规格线的 companion-band 统一出口已在渲染层把 confirm/select/input（原 C1）+ ask-user（原 C2）+ composer 上方交互（原 B3）压到**同一位置（M11）、同一机制**（plugin await + 顶替 composer + 阻塞）。C 维度之所以还单列，仅因 API 不同（DialogRequest / ask-user 双向 vs `__gui__` 单向），不再是位置或视觉的区别。既然渲染层已统一，架构层跟上即可——C 是 B 的 companion 交互子项，不是独立维度。
>
> M15（全局 modal）降级为「全局致命错误浮层」（接近 Toast 性质），不再是原 C 的主出口。

16 个挂载点归为 4 个维度。每个维度标注：自定义级别、当前状态、VSCode 对应。

#### 维度 A：结构容器注入（plugin 往固定结构里加槽位）

| 子项 | 挂载点 | 内容 | 级别 | 当前状态 | VSCode 对应 |
|---|---|---|---|---|---|
| **A1** | 侧栏新增 tab（M1+M2） | plugin 声明 view id/icon/title，renderer 渲染 tab + 内容区（数据源契约）。**plugin view 统一收口 sidebar 第 5 独立 tab（Puzzle icon）** | L1 | panels 声明未消费 | viewsContainer + views |
| **A2** | 抽屉新增 tab（M6+M7） | plugin 声明 drawerTab。**proposed/未来——当前不开放，避免一级 tab 泛滥**（视觉线决策） | L1 | proposed | 无直接对应（近似 panel） |
| **A3** | 工具条/头部新增按钮（M9+M12） | plugin 声明 action button（icon+command），点击触发 command | L1 | 无 | menus (editor/title) |
| **A4** | 底栏状态项（M8） | plugin 推送 statusKey+text+priority，**main-panel 局部底栏**聚合（composer 下方，不跨 sidebar/drawer） | L1 | pi 已实现（extension:status），plugin 未接入 | statusBarItems |

**当前状态**：维度 A 是 plugin 系统最大的空白——`contributes.panels/statusBarItems` 已在 SDK 声明但 renderer 零消费。pi 侧的 status 已实现但绑死 SideDrawer footer（规划挂到 main-panel 局部底栏，位于 composer 下方，不跨 sidebar/drawer）。

#### 维度 B：对话流 + companion 交互注入（agent 特有，最核心）

| 子项 | 挂载点 | 内容 | 级别 | 当前状态 | VSCode 对应 |
|---|---|---|---|---|---|
| **B1** | tool result 渲染（M4） | tool 返回 `details.__gui__`，对话流内渲染 GuiComponent | L2 | **已实现** | 无（agent 特有） |
| **B2** | 自定义消息卡片（M5） | plugin 推送 message，对话流穿插 GuiComponent | L2 | **已实现** | 无（agent 特有） |
| **B3** | companion 交互（M11，统一出口） | **顶替 composer、阻塞式交互**，三种子形态：B3a 单向原语（进度提示）/ B3b dialog 原语（confirm/select/input）/ B3c ask-user 双向富交互（多问题/多选/评论） | L1（主，dialog 原语）兼容 L2（ask-user） | **已实现** | 无（agent 特有） |
| ~~C~~ | ~~全局 modal（M15）~~ | **降级**：仅致命错误/系统级强阻断（接近 Toast），非交互主出口 | L1 | 已实现（pi 侧），已降级 | window/dialogs |

**当前状态**：维度 B 是最成熟的插件注入面——GuiComponent 7 原语 + ask-user 双向交互均已验证可用。companion-band 统一出口后，B3 是 plugin 交互的主入口（confirm/select/input/ask-user 都走这里）。

#### 维度 D：命令与配置注入

| 子项 | 挂载点 | 内容 | 级别 | 当前状态 |
|---|---|---|---|---|
| **D1** | slash command（M10） | composer `/` 菜单 | L1 | **已实现但双轨**（session.commands 通道 vs contributes.slashCommands） |
| **D2** | settings page 区段（M16） | schema 驱动表单 | L1 | 未实现（声明式 settings 未落地） |

#### 维度 E：独立全屏 view（最高自由度，仅内置）

| 子项 | 挂载点 | 内容 | 级别 | 当前状态 |
|---|---|---|---|---|
| **E1** | 独立 view 路由（M14） | 预编译 Vue 组件，完整 view | L3 | 未实现（仅 built-in，如 Overview） |

**当前状态**：未实现。L3 逃生口（`GUI_CUSTOM_REGISTRY_KEY` provide/inject）已预留。

### 3.3 3 个自定义级别（plugin 改到什么程度）

| 级别 | 含义 | 适用 | 安全性 | external 可用 |
|---|---|---|---|---|
| **L1 元数据+数据驱动** | plugin 给 `{id, icon, title, data, command}`，renderer 用固定宿主渲染 | 维度 A、D、B3 的 dialog 原语 | 高（plugin 不控制渲染） | ✅ |
| **L2 结构化原语树** | plugin 给 GuiComponent 原语组合，renderer 用原语渲染器渲染 | 维度 B1/B2、B3c ask-user | 中（原语集合受限） | ✅ |
| **L3 预编译自定义组件** | plugin 给 Vue 组件定义，编译期打包 | 维度 E + 复杂 view 逃生口 | 低（需 trust） | ❌ 仅 built-in |

**设计依据**：用户已定「面板渲染用结构化原语组合」（L2）。L1 用于结构性容器（tab/按钮/底栏/dialog，renderer 有固定宿主），L3 仅作内置逃生口（external 插件强制走 L1/L2）。

### 3.4 挂载点 Tier 分层（v2 新增）

> 16 个挂载点不必都同等对待。视觉线实践暴露 4 个边缘挂载点（M3/M6/M13/M15），显式分层让视觉稿和实施聚焦。

| Tier | 挂载点 | 数量 | 处理 |
|---|---|---|---|
| **Tier 1（活注入点）** | M1/M2/M4/M5/M7/M8/M9/M10/M11/M12/M14/M16 | **12** | 视觉稿重点设计 + 实施优先 |
| **Tier 2（边缘/未来/降级）** | M3（plugin 不改结构，只是 Settings 入口）/ M6（drawer tab proposed 暂不开放）/ M13（低优浮层）/ M15（降级仅致命错误） | **4** | 标「未来/降级」，视觉稿不必做完整设计 |

其中 Tier 1 的闭环状态（来自 v6-spec-plugin-rendering §9.4 交叉验证）：
- **完整闭环 5 个**（入口+handler+推送全通）：M4/M5/M7/M8/M11
- **声明式空壳 6 个**（入口能渲染，点击无 handler/无推送）：M1/M2/M9/M12/M14/M16
- **已闭环双轨 1 个**：M10（slash command）

**关键阻塞**：6 个声明式空壳变闭环，只差 **2 个 API**（`api.commands.register` 让按钮点击有响应 + `api.views.update` 让 view tab 有内容）。这是 ExtensionHost 层（§6）的 P0。

### 3.5 给视觉稿的具体需求清单

> 视觉稿需为以下每项定义 v6 目标视觉。标注「✅ 已定义」的见 v6-design.md / v6-spec-*，需对齐；「待定义」的是视觉稿要补充的。

**维度 A（结构容器）**：
- A1 plugin tab：✅ v6-spec-plugin-rendering 已定义（第 5 独立 Puzzle tab + 二级 view tab）；待定义：二级 tab 的 pin/close/overflow 行为
- A2 drawer tab：**proposed 暂不开放，视觉稿不必设计**（v2 决策）
- A3 plugin 按钮：待定义——icon size / 位置分组（composer-bar vs panel-header）/ hover / disabled
- A4 底栏 status item：✅ v6-spec-plugin-rendering §A4 已定义（main-panel 局部底栏）

**维度 B（对话流 + companion）**：
- B1/B2 七个 GuiComponent 原语：✅ v6-spec-plugin-rendering §3 已定义全部 v6 视觉（详见 §5）
- B3 companion 统一出口：✅ v6-spec-plugin-rendering §4 + v6-spec-overlays 已定义（B3b dialog / B3c ask-user 同位置）
- **C3 overlay 窗口化**（最小化 badge / 拖动 / 还原）：✅ v6-spec-plugin-rendering §4 已定义视觉；**待架构层定 lifecycle 约定**（见 §7.3）

**维度 D（命令配置）**：
- D1 slash command：✅ CommandPopover 已定义
- D2 settings 区段：待定义——schema 驱动表单的控件样式（复用 settings page 控件）

**维度 E（独立 view）**：
- E1 独立 view 容器规范：待定义——padding / max-width / header / 滚动区 / 与 chat view 的视觉区分

---

## §4 Contribution 体系（声明式 manifest schema）

扩展现有 `PluginContributes`（plugin-sdk/src/types.ts），定义完整 contribution：

```typescript
interface XyzAgentContributes {
  // ── 维度 A 结构容器 ──
  /** 侧栏 view（M1+M2）：plugin 声明，renderer 渲染 tab + 数据宿主 */
  views?: Array<{
    id: string                    // 唯一标识，如 'my-ext.explorer'
    title: string                 // tab 显示名
    icon: string                  // lucide icon name 或内联 SVG path
    placement?: 'sidebar' | 'drawer'  // A1 侧栏 / A2 抽屉
    viewType?: 'tree' | 'list' | 'gui'  // L1 数据宿主类型；'gui' = plugin 推送 GuiComponent
    activationEvent?: string      // 展开 view 时激活（onView:id）
    initialVisibility?: 'visible' | 'hidden'  // 默认是否显示 tab
  }>

  /** 底栏状态项（M8，A4） */
  statusBarItems?: Array<{
    id: string
    text?: string                 // 初始文本（可被 updateStatusBarItem 动态更新）
    priority?: number             // 排序（大→左/前）
    alignment?: 'left' | 'right'
    scope?: 'per-session' | 'global'
    commandId?: string            // 点击触发命令
    tooltip?: string
  }>

  // ── 维度 A3 按钮 ──
  /** 工具条/头部按钮（M9+M12，A3） */
  menus?: {
    'composer.toolbar'?: MenuEntry[]    // composer-bar 工具条
    'panel.header'?: MenuEntry[]        // panel-header 按钮组
    'sidebar.footer'?: MenuEntry[]      // sidebar footer
  }

  // ── 维度 D 命令配置 ──
  /** 命令（统一来源：命令面板 + 快捷键 + 菜单） */
  commands?: Array<{
    id: string
    title: string
    icon?: string
    keybinding?: string           // 快捷键，如 'mod+shift+p'
    when?: string                 // 上下文条件（VSCode when clause 子集）
    category?: string             // 命令面板分组
  }>

  /** slash 命令（D1，统一双轨） */
  slashCommands?: Array<{
    name: string                  // 不含 /，如 'review'
    description: string
    when?: string
  }>

  /** 设置页区段（D2，schema 驱动） */
  configuration?: {
    title: string
    properties: Record<string, ConfigProperty>  // VSCode configuration schema
  }

  // ── 维度 B/C（编程式注册，非声明式）──
  // messageRenderers / askUser / tool gui 经 api 在 activate() 中动态注册

  // ── 保留 ──
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks?: string[]
}
```

**与现有 PluginContributes 的差异**：
- `panels` 拆为 `views`（明确 placement + viewType，renderer 知道用什么宿主渲染）
- `statusBarItems` 扩展（alignment/scope/commandId）
- 新增 `menus`（A3 按钮注入点）
- 新增 `commands`（统一命令来源，含快捷键 + when clause）
- 新增 `configuration`（D2 schema 驱动设置）
- `slashCommands` 保留但语义统一（驱动 CommandPopover，替代 session.commands 双轨）

---

## §5 统一渲染协议（GuiComponent 提升为共享层）

### 5.1 提升判定

GuiComponent 从「pi extension 专用」提升为「pi extension + plugin 共享渲染协议」。

**事实**：类型层已就绪——`extension-protocol/src/core/types.ts` 的 GuiComponent/GuiComponentProps/子类型是纯结构化数据，零 pi 依赖（注释提 pi 但类型签名通用）。提升成本低，主要是命名/文档/注册机制，非类型重塑。

**不建议物理改名** `@xyz-agent/extension-protocol` → 包名是公共 API，已 6+ 处依赖，改名成本 > 收益。改 `package.json` description + 文档定位即可。

### 5.2 7 原语的 v6 视觉重设计

> 当前 7 原语组件**已实现**（文档滞后标 P2 待实现，但 `components/panel/message-stream/gui/` 下 Card/TabBar/ProgressBar 等 7 个原语 + `GuiComponentRenderer.vue` 均存在）。v6 重设计是改 CSS/模板，**不改协议类型**——已接入的 extension 零改动自动获得 v6 视觉。

依据 v6-design.md §2（token）/§3（组件范式）/§5（横切）：

| 原语 | 当前违规点 | v6 目标 | 视觉稿需定义 |
|---|---|---|---|
| **card** | `rounded-lg`(12px) 过大 + `border` 双重违反 §3.4 | 去边框靠背景层级（`bg-surface`/`bg-surface-2`）；header 去 `border-b` 改背景浮起；圆角降档 8-10px；variant 状态靠 badge/dot 非边框 | 三层明度背景语义（stage/画布/surface）/ variant 配色 / header-body 分隔 / 嵌套组合态 |
| **stats-line** | severity 全彩色 | severity 收窄：`danger` 保留（真失败），`ok`/`warn` 纯统计降中性 `neutral-fg`；分隔 `border-l` hairline 保留 | severity 颜色映射规则 / 字号字重 / 分隔 hairline |
| **progress-bar** | fill 实色 `bg-success/warn/danger` | fill 柔化（`color-mix` 低透明，复用 §2.3 diff 柔化思路）；done 态降中性 `neutral-dim`；圆角 6px | severity 柔化透明度 / done 态降级 / track 凹陷语义 |
| **list-tree** | depth 缩进 20px（无引导线）；icon 11px 不在 scale | 缩进收 14-16px（留白档优于 border-l）；icon 对齐 trace 档 12px（`size-3`）；status 用 7px 圆点替换文字 | depth 分隔策略（留白 vs 引导线）/ icon scale / status 圆点语义 |
| **columns** | `gap-3` 合理 | 保留 `gap-3`(12px) 对齐标准 scale；容器内出现时对齐 SegmentedTab 间距 | gap 标准 / 嵌套容器间距 |
| **tab-bar** | `bg-accent-soft` 蓝染底 + `border-b`，违反 §3.1 SegmentedTab | 强制迁移 SegmentedTab 范式：外层 `bg-bg-input rounded-lg p-[3px]`，active 中性浮起（去 accent-soft），去底部 border | 完全复用 SegmentedTab（§3.1 已定义） |
| **ansi-text** | 默认 ansi_up 调色板，未映射冷蓝暗色 | ANSI 16 色 → v6 语义色（red→danger/green→success/blue→accent 冷蓝/yellow→warn/灰阶→neutral-*）；不自加背景 | ANSI 16 色到 v6 语义色的完整映射表 / 暗/亮双主题 |

### 5.3 统一渲染器收敛

当前渲染入口分散在 4 处（各自 import GuiComponentRenderer），收敛为统一渲染器：

```
GuiComponentRenderer.vue（统一渲染器，7 原语 + custom 降级）
   ▲
   │ 所有挂载点共享
   ├── Block.vue           (tool result, B1)
   ├── MessageStream.vue   (custom message, B2)
   ├── SideDrawer.vue      (widget, A2 抽屉内容)
   └── ViewHost.vue ★新增★ (plugin view, A1 侧栏内容 / E1 独立 view)
```

**降级策略**：未注册的 type 一律降级 AnsiText（JSON 序列化展示，不崩渲染、不丢信息）。

### 5.4 custom 逃生口分层

`custom` 类型（`{component: string, props}`）的注册口 `GUI_CUSTOM_REGISTRY_KEY`（provide/inject）分层：
- **内置 extension（built-in）**：可用 `custom`，编译期 `provide` 注册 Vue 组件。
- **external plugin**：**不可用 `custom`**，强制走 7 原语。理由：Vue 组件需编译期打包，不能 WS 传输；与 plugin 动态加载、Worker 隔离特性一致。

**缓解**：7 原语 + 嵌套组合覆盖面足够（spec §14.3 已论证 columns+card+list-tree 可表达 workflow 的 sidebar+main+footer）。若 7 原语不够，**补原语**（如 table/kv-list）而非放开 custom。

### 5.5 原语扩展路线（v2 新增，来自视觉线盲区分析）

视觉规格线系统分析发现 7 原语的表达力盲区（v6-spec-plugin-rendering §3 末尾）：
- 无**垂直原语**（rows/stack）——columns 只水平
- 无**二维 grid** / flex-wrap / align / justify
- **tab-bar 非容器**（只展示状态圆点，不切换内容）
- **三栏带 footer** 无法表达（columns 能做三列，但跨栏 footer 需垂直 stack，协议暂无）

**扩展原则**：按需补原语，不放开 custom。候选扩展原语：
| 原语 | 解决的盲区 | 优先级 |
|---|---|---|
| `rows`（垂直 stack） | 跨栏 footer / 纵向布局 | 高（解三栏带 footer 盲区） |
| `kv-list`（键值对列表） | 配置展示场景 | 中 |
| `table`（二维表格） | 结构化数据 | 中 |

补一个 `rows` 原语即可解掉视觉线指出的「跨栏 footer」盲区。**新增原语需同步 extension-protocol 类型 + renderer 组件 + v6 视觉 + ANSI 降级**，属于协议演进，要走 proposed → stable 流程（§9.3）。

### 5.5 ANSI 兜底永留

未引入 extension-protocol 的 pi extension 走 ANSI 兜底（`outputRaw` → AnsiText）。这是渐进迁移的安全网，**永远保留**。v6 下需把 ANSI 颜色映射到冷蓝暗色（§5.7 ansi-text 行），否则旧 extension 输出在 v6 界面「颜色脏」。

---

## §6 ExtensionHost 层（renderer 新增核心层）

### 6.1 职责

ExtensionHost 是 renderer 侧**全新的层**，负责消费 plugin/pi-extension 的 contribution 并驱动渲染分发。当前这些逻辑散落在 useExtensionUI/useDrawerWidgetBuffers/extensions/registry.ts 等，新架构收敛为独立层。

```
ExtensionHost
├─ ContributionRegistry    扫描所有插件 manifest，注册声明式贡献（views/menus/commands/...）
├─ ActivationManager       懒激活，响应 activationEvents（onView/onCommand/onSlashCommand/...）加载插件
├─ ViewHost                渲染 plugin 贡献的 sidebar/drawer view，订阅 plugin 推送的 GuiComponent 流
├─ CommandRegistry         命令注册表（命令面板/快捷键/slash 统一来源）
├─ StatusBarController     底栏状态项聚合（pi status + plugin statusBarItems 统一），挂 main-panel 局部底栏（composer 下方，不跨 sidebar/drawer）
└─ MessageBusBridge        plugin:uiRequest/statusBarUpdate/crashed/permissionRequest 等消息族接入 renderer
```

### 6.2 现有雏形

**`extensions/registry.ts` 已是事实上的扩展适配器分流层**——它把 goal/todo/subagents 等特殊扩展从通用 widget/status 管线分流到专属 UI（如 tasks 进 SideDrawer tasks tab，subagents 进 sidebar tab）。这是 ExtensionHost 的雏形，新架构将其升格为正式 ContributionRegistry。

### 6.3 panels 渲染机制（解决 plugin panels 无渲染链路）

plugin 经 RPC 推送 GuiComponent 树，ViewHost 交给 GuiComponentRenderer 渲染。**plugin 代码不进 renderer**。

数据流：
```
plugin (Worker 进程)
  ├─ activate() 中调 api.views.provide('my-ext.explorer', guiComponentTree)
  │  或声明式 contributes.views + 运行时 api.views.update()
  ▼
runtime plugin-service → WS (plugin:viewUpdate 消息族)
  ▼
renderer ExtensionHost.ViewHost
  ├─ 按 viewId 路由到 sidebar tab 或 drawer tab
  └─ 交给 GuiComponentRenderer 渲染（7 原语 + v6 视觉）
```

plugin 的 view 内容与 pi extension 的 widget 走**同一套** GuiComponentRenderer，视觉自动对齐 v6。

---

## §7 三套 UI 接口统一

### 7.1 冲突现状（来自审查）

三套 UI 机制并存，消息类型不一，renderer 只消费 pi 侧：

| 机制 | 来源 | 消息类型 | renderer 消费 |
|---|---|---|---|
| pi `ctx.ui` | pi extension | `extension.ui_request` | ✅ ExtensionUIDialog + AskUserOverlay（confirm/select/input 现走 companion-band / M11，M15 仅致命错误） |
| plugin `api.ui` | plugin-sdk | `plugin:uiRequest` | ❌ 零消费 |
| GuiComponent | extension-protocol | `details.__gui__` / `extension:widgetGui` | ✅ GuiComponentRenderer |

### 7.2 统一方案

**对话框原语统一**：
- pi 的 `ctx.ui.select/confirm/input` + plugin 的 `api.ui.showSelect/Confirm/Input` → 统一为 `DialogRequest` 协议
- 消息类型对齐：plugin 侧 `plugin:uiRequest` 改为复用 `extension.ui_request` 语义（或 renderer 同时消费两者，统一到 useExtensionUI）
- renderer 统一用 ExtensionUIDialog 消费

**状态展示统一**：
- pi 的 `setStatus` + plugin 的 `updateStatusBarItem` → 统一 StatusBarRegistry
- 消息类型对齐到统一 status 协议

**结构化渲染统一**：
- 两者都用 GuiComponent
- pi 经 widget marker 编码（`extension:widgetGui`）
- plugin 经新 RPC 通道（`plugin:viewUpdate` / tool result `details.__gui__`）

**ask-user 保留独立双向通道**：ask-user 是双向交互（等用户回传答案），复用 pi 的 select 双向通道，不并入单向 GuiComponent。

### 7.3 overlay lifecycle 约定（v2 新增，来自视觉线 C3 窗口化）

视觉规格线原创了 **C3 overlay 窗口化**能力：companion-band（M11）或 modal（M15）的交互 overlay 可最小化为角落 badge / 还原 / 拖动（header 手柄）。这是原架构设计里完全空白的一块。

**架构层约定**（避免每个挂载点各搞一套）：
- **窗口化是 renderer 能力，plugin 只管 await 结果**：plugin 调 `api.ui.showConfirm(...)` 后 await Promise，无论 overlay 是全展开、最小化为 badge、还是被拖动，plugin 只关心最终 resolve/reject。
- **lifecycle 状态机**：`expanded`（默认，顶替 composer）→ `minimized`（角落 badge，仍 await）→ `restored`（用户点 badge 还原）。plugin 不感知这些状态转换。
- **超时与取消**：overlay 最小化不暂停超时（沿用 pi select 的 5min 超时）；用户可显式取消（resolve undefined/null）。
- **M15（全局 modal）窗口化范围**：仅致命错误 modal 支持最小化（转为通知 badge），普通 confirm/select/input 走 companion-band（M11）不窗口化。

**renderer 侧实现**：ExtensionHost 的 MessageBusBridge 统一管理 overlay lifecycle 状态（per-session + per-requestId），不散落到各挂载点组件。

---

## §8 tool/hook 适配层

### 8.1 tool 统一

plugin 的 `toolRegistration`（经 `api.tools.register`）与 pi extension 的 `registerTool` 都注册 LLM 可调用的 tool，当前两套执行路径。

**统一方案**：统一 tool 注册表。
- plugin 的 tool 经适配器归一到 pi tool 语义
- `bridge-handler` 作为唯一 tool 执行路由（plugin tool 经 plugin bridge，pi tool 经 pi bridge，但对 LLM 透明）

### 8.2 hook 统一

plugin 的 HookPipeline（串行 + priority + blocked 终止 + 5s 超时）是唯一执行点。pi extension 的 hook 翻译为 plugin hook 语义，统一经 HookPipeline 执行。

---

## §9 plugin-sdk 必修致命缺陷（主干化前置）

plugin-sdk 架构审查发现 3 个致命缺陷，作为「以 plugin-sdk 为主干」的前置任务：

### 9.1 sandbox ESM 漏洞（安全根本）

**问题** [实测]：`plugin-sandbox.ts:254` 只 monkey-patch `Module._resolveFilename`（拦 CJS require），但 `plugin-bootstrap.ts:79` 用 `await import()` 加载插件（ESM）。声明 `trustLevel: 'sandbox'` 的恶意插件用 `import('node:fs')` 即可绕过 BLOCKED_BUILTINS，获得完整 Node 能力。**sandbox 名存实亡**。

**修复方向**：改用 `vm` 模块做真隔离，或 per-plugin 子进程隔离。VSCode 的 ExtHost 是真进程级隔离。

### 9.2 panels 渲染链路 + UI 接口统一

**问题**：`contributes.panels` 零消费 + 三套 UI 接口冲突（§7）。

**修复**：本文档 §3-§7 定义了目标态。panels 渲染经 ExtensionHost.ViewHost → GuiComponentRenderer（§6.3）；UI 接口统一到 DialogRequest + StatusBarRegistry + GuiComponent（§7）。

### 9.3 API 稳定性分层 + Object.freeze

**问题** [实测]：plugin-sdk 所有 API 都是 stable，无 proposed gating（VSCode 教训1 未吸取）。`createAgentAPI` 返回普通对象，插件可 monkey-patch（无 Object.freeze）。

**修复**：
- 引入 stable/proposed/internal 三层（proposed 需白名单，不给第三方）
- 主干化前冻结 stable surface，所有 api 对象 Object.freeze
- VSCode 教训1：API 一旦发布无法收回，主干化即冻结点

### 9.4 其他严重缺口（主干前应补）

- `interfaces.ts` facade 泄漏 plugin-service 内部类型（ToolRegistration/BridgeSyncPayload 缝进 IPluginService 契约）→ 提升到 shared
- 声明式 contributes（slashCommands/settings/statusBarItems）与编程式 API 割裂，声明式未落地 → §4 落地
- agent 域 setModel 等是 stub（agent-api.ts:15 注释明确）→ 对接 IPiEngine
- trusted 共享 Worker 一崩全崩（plugin-host.ts:103）→ 评估 per-plugin worker 选项

---

## §10 16 视图挂载点完整清单（设计依据）

> 这一章是 §3 的完整事实依据。16 个挂载点 M1-M16，每个标注：内容形态 / 当前动态性 / 插件痕迹 / VSCode 对应 / 建议级别。

| # | 挂载点 | 内容形态 | 当前动态性 | 插件痕迹 | VSCode 对应 | 建议级别 | 归入维度 |
|---|---|---|---|---|---|---|---|
| M1 | Sidebar SegmentedTab 列表 | 可枚举 | 硬编码 4 tab | — | viewsContainer | L1 | A1 |
| M2 | Sidebar 子视图区 | 固定容器 | 部分（tasks 条件 push） | P（subagents/workflows/files/tasks） | views | L1 + L3 逃生口 | A1 |
| M3 | Sidebar Brand/nav/Overview/footer | 固定 | 否 | — | activitybar | L1 | A3 |
| M4 | MessageStream 对话流 block | 数据驱动 | 是 | **P（强）** tool result GuiComponent | 无（agent 特有） | L2 | B1 |
| M5 | MessageStream custom message | 数据驱动 | 是 | **P（强）** GuiComponent | 无（agent 特有） | L2 | B2 |
| M6 | SideDrawer tab 列表 | 可枚举 | 半动态（tasks 条件 push） | P（tasks 是内置扩展 tab） | 无直接对应 | L1 | A2 |
| M7 | SideDrawer tab 内容区 | 固定+数据驱动 | 是（GuiComponent 兜底） | **P（强）** widget/widgetGui | 无（agent 特有） | L2 + L1 | A2 |
| M8 | main-panel 局部底栏（composer 下方，不跨 sidebar/drawer，bg-bg-elevated） | 数据驱动 | 是（extension:status） | **P（强）** | statusBarItems | L1 + L2 | A4 |
| M9 | Composer composer-bar 工具条 | 固定 | 否 | — | menus (editor/title) | L1 | A3 |
| M10 | Composer CommandPopover（slash） | 数据驱动 | 是（commandStore） | **P（强）** slash command | commands | L1 | D1 |
| M11 | Composer 上方 companion-band（**统一交互出口**：B3a 原语 / B3b dialog / B3c ask-user） | slot（互斥） | 是（AskUserOverlay + confirm/select/input） | P（ask-user + dialog） | 无（agent 特有） | L1（兼容 L2） | B3 |
| M12 | PanelHeader 按钮组 | 固定 | 否 | — | menus (editor/title) | L1 | A3 |
| M13 | MessageStream 浮层 slot（Tier 2 低优） | 固定浮层 | 否 | — | 无（agent 特有） | L2（低优） | — |
| M14 | 全局独立 view（chat/overview） | 固定 | 否 | — | webviewPanel | L3（仅内置） | E1 |
| M15 | 全局 modal（**降级**：仅致命错误/系统级提示，接近 Toast） | slot | 是 | P（致命错误；confirm/select/input 已并入 M11） | window/dialogs | L1 | B（降级） |
| M16 | SettingsModal 扩展管理页 | 固定 | — | P（LoadPaths） | extensions view | L1 | D2 |

**关键发现**：
- **最成熟的插件注入面**：M4/M5/M7/M8/M11（对话流 + SideDrawer + companion），5 个完整闭环，均为 L1/L2 已验证。
- **最大空白**：M1/M2/M9/M12/M14/M16（6 个声明式空壳）——`contributes.panels/statusBarItems` 声明但 renderer 零消费。补 2 个 API（`commands.register` / `views.update`）即变闭环（§3.4）。
- **事实雏形**：`extensions/registry.ts` 已是扩展适配器分流层（goal/todo/subagents 经它分流到专属 UI），可升格为正式 ContributionRegistry。
- **Tier 2 边缘**（§3.4）：M3（plugin 不改结构）/ M6（drawer tab proposed 暂不开放）/ M13（低优浮层）/ M15（降级仅致命错误）。

---

## §11 整体前端架构影响（不只 plugin）

> 前面的章节聚焦 plugin 渲染。这一章回答「v6 视觉稿对整体前端架构有什么影响」。结论：**整体影响正面居多，但暴露 3 个整体层面的简化机会**。

### 11.1 视觉稿验证了的架构判断（正面）

视觉稿实践反向印证了几个整体架构决策的正确性：

| 架构判断 | 视觉稿验证 |
|---|---|
| **renderer 需要独立 ExtensionHost 层**（§6） | 视觉稿 plugin spec §9 自认「ExtensionHost 层 + 2 API 缺口」，与架构设计一致 |
| **GuiComponent 提升为共享渲染协议**（§5） | 7 原语视觉稿已全画，goal/todo/workflow 都能用原语表达，证明通用性 |
| **companion-band 作为交互统一出口** | 视觉稿主动把 confirm/select/input + ask-user 合并到 M11，简化交互种类 |
| **三层明度背景**（v6 决策 #10） | 视觉稿落实，且发现「面上面」问题（主面板 surface 上的 pill 需升一档 surface-2）——架构上对应「嵌套层级不超过 3 层」 |

### 11.2 整体层面的 3 个简化机会

视觉稿实践暴露了 3 个**超出 plugin 范围**的整体架构简化点：

#### 简化 A：goal/todo 回归对话流，删除 tool name 特判（已定决策）

v6 已决策移除 tasks tab，goal/todo 走 GuiComponent 统一渲染。架构上的连锁简化：
- **删除 `HIDDEN_TOOL_NAMES`**（`shared/constants.ts`）——core 不再按 tool name 隐藏特定 tool
- **删除 `Block.vue` 的 isHidden 守卫**——todo/goal_control 落入普通 tool 路径，已有的 `GuiComponentRenderer` 自动接管
- **删除 `chat-message-effects.routeToolResultToTasks`**——不再特殊路由到 tasks store
- **删除 tasks store + GoalCard + TasksPanel + SideDrawer tasks tab + tasks-adapter**
- **GoalCard 的 blocked 视觉/Resume 按钮**：落到对话流 GuiComponent 渲染（card.variant + D 维度 `/goal resume` 命令）

**这是「删特殊路径」为主的简化**，让 core 更通用（§12.1 详述，是 builtin plugin 第一实践）。

#### 简化 B：选中态范式二分规则统一（视觉稿 D8 裁决）

视觉稿审查发现「被选中」在产品里出现**三种视觉语言**（SegmentedTab bg-elevated / 列表项 bg-surface+蓝字 / drawer tab accent-soft 蓝染底）。v6 裁决为二分：
- **tab 型**（SegmentedTab / drawer l1-l2 tab / AskUserOverlay au-tab / plugin seg-tab）= `bg-bg-elevated` 中性浮起
- **列表项型**（SessionItem / FileTree / SearchModal sm-item / au-opt / wf-call / CommandPopover 项）= `bg-surface + text-accent` 蓝字

**架构影响**：这本来是视觉问题，但统一为二分规则后，**ui 原语层可以收敛出两个通用「选中态」原语**（`<SelectableList>` / `<SegmentedGroup>`），业务组件消费原语而非各自硬编码 selected class。减少 Sidebar/SideDrawer/SearchModal 三处的重复实现。

#### 简化 C：features/ 巨型桶按业务域重组 + 提取共享 composable

视觉稿的四文件 CSS 复制漂移（7 处实质漂移，QueueBubble/ChangeSetCard/md-codeblock 等）暴露了一个架构问题：**对话流四文件各复制 ~450 行 CSS**。fix-plan 的解法是抽 `v6-spec-base.css` 共享。

**架构层面的对应**：composables 也有同样的复制碎片化问题（features 41 文件 + panel 37 文件两个巨型桶）。这不是视觉问题，是组织问题——按业务域重组 + 提取共享 composable，与 CSS 抽 base 是同构的。详见 `v6-architecture-refactor.md` §B9。

### 11.3 视觉稿无法自己解决、需架构层先行的 2 点

| 点 | 为什么视觉稿做不了 | 架构层先行项 |
|---|---|---|
| **6 个声明式空壳变闭环** | 需要补 `api.commands.register` + `api.views.update` 两个 plugin API，属 runtime + ExtensionHost 层工作 | §6 ExtensionHost P0 |
| **形态 B 数据模型重构**（detail 多文件 tab / terminal 多实例） | 视觉稿只能画视觉态，实现依赖 useDetailPane 单值→map、单 PTY→多 PTY | 阶段 B renderer 局部重构（`v6-architecture-refactor.md` §B） |

---

## §12 Builtin Plugin 实践候选（验证插件机制能否跑通）

> 目的：选 1 个功能做成 builtin plugin，真实验证「plugin 机制能否跑通」。理想候选 = 当前硬编码特殊路径 + UI 能用 GuiComponent 原语表达 + 相对独立 + v6 已定决策顺势落地。

### 12.1 候选评估（3 个，深度核实）

经 explorer 核实代码现状（标注事实）：

| 候选 | 硬编码程度 | 7 原语可表达 | 独立性 | 验证维度 | 改动量 | 综合 |
|---|---|---|---|---|---|---|
| **tasks（goal/todo）** | 中（已收敛为 adapter + 单一 isHidden 守卫） | **是（extension 已在产 card/list-tree/stats-line/progress-bar）** | **高（不碰 session/streaming/tree）** | **B（对话流）+ D（命令）** | **小-中（删特殊路径为主）** | **首选** |
| subagent/workflow | 高且深（runtime + renderer + stores 三层，耦合虚拟 session/streaming） | 否（BlockSubagent 解析裸 input/output；嵌套对话流是完整 MessageStream 需 E 维度） | 低 | A + E（但前置需暴露虚拟 session API，成本巨大） | 大 | 暂缓 |
| search（⌘K） | 高（3 源硬编码，平台导航基础设施） | 否（独立浮层，自有 SearchItem 类型） | 低（所有 plugin 共用的发现入口） | 无干净命中 | 中-大 | 不推荐 |

### 12.2 为什么选 tasks（goal/todo）作为第一个 builtin plugin

**首选理由**（4 条，均经核实为事实）：

1. **它是 v6 已定决策的执行**（非额外架构赌注）：v6-design §4.3 已要求移除 tasks tab + `HIDDEN_TOOL_NAMES` 特判，goal/todo 走 gui-protocol 回归对话流。做 builtin plugin = 顺势落地 v6 决策，一举两得。

2. **管线已就绪**（事实）：
   - goal/todo extension 已产 GuiComponent（`extensions/todo/src/model.ts buildGui` → list-tree；`extensions/goal/src/adapters/goal-control-adapter.ts` → card/stats-line/progress-bar），有测试断言
   - Block.vue 已有 `extractGui` + `GuiComponentRenderer` 通路（普通 tool 的 `details.__gui__` 自动渲染）
   - ExtensionRegistry + tasks-adapter 已证明 adapter 模式可行（`extensions/adapters/tasks-adapter.ts`）

3. **验证信号最纯**：核心验证命题是「core 不再 hardcode `'todo'`/`'goal_control'` tool name，仅凭 `details.__gui__` + 通用渲染器即可让 feature 在对话流呈现」。这同时覆盖 B 维度（tool result 渲染）和 D 维度（/goal /todo 命令）。

4. **独立性最高**（事实）：纯 tool result 详情展示 + widget，不碰虚拟 session / streaming / session tree / runtime event-interpreter。失败不会波及核心 chat/session 流。

### 12.3 builtin plugin 形态（Inferred，实施时确认）

「做成 builtin plugin」的具体形态：把 goal/todo 的 **xyz-agent 侧渲染支持**（识别 + GuiComponent 渲染）从散落的 core 代码，收编为 `resources/plugins/xyz-tasks/` 下的 built-in 插件（`source:'built-in'`，享受最高 hook 优先级 / 免权限审批）。pi extension 侧（`@zhushanwen/pi-goal` / `pi-todo`）不变。

**实践步骤概要**（实施计划另出）：
1. 删除 core 特判：`HIDDEN_TOOL_NAMES` + `Block.vue` isHidden + `routeToolResultToTasks` + tasks store + GoalCard/TasksPanel + SideDrawer tasks tab
2. goal/todo extension 的 `details.__gui__` 落入普通 tool 路径，`GuiComponentRenderer` 自动渲染
3. 验证：回归对话流后 goal/todo 可见、blocked 视觉 + Resume 命令可用
4. 若 GoalCard 的增强视觉（blocked 渐变 + Resume 按钮）7 原语表达不够，用 `custom` 原语（仅 built-in 可用，正好契合 builtin plugin 身份）

### 12.4 验证成功标准

- [ ] core 代码中 `grep -r "todo\|goal_control" packages/renderer/src/` 零硬编码 tool name 特判（除 plugin 注册外）
- [ ] goal/todo 在对话流正常渲染（card/list-tree/stats-line/progress-bar 原语组合）
- [ ] `/goal` `/todo` slash 命令仍可用（经 plugin 声明，非 core 硬编码）
- [ ] builtin plugin 机制跑通：plugin manifest 扫描 → 激活 → 渲染 → 命令注册全链路
- [ ] 删除的 tasks tab / GoalCard 不影响其他功能

**若验证通过**，说明 plugin 机制（至少 B 维度对话流 + D 维度命令）可承载真实功能，为后续 plugin 化更多功能（subagent/workflow 第二阶段）铺路。

---

## 附录：与现有文档的关系

| 文档 | 关系 |
|---|---|
| `v6-architecture-refactor.md` | 互补。那份是「现状审查+缝补」（runtime/shared/IPC/renderer 编排层），本文档是「renderer 终态架构+plugin 渲染」 |
| `v6-design.md` §6/§7/§8 | 承接。v6-design 的架构决策是本文档的输入；本文档 §3 给 v6-design 视觉稿提供「plugin 需定义什么」清单 |
| `extension-gui-protocol.md` | 兼容。本文档 §5 把它的 GuiComponent 提升为共享渲染协议，7 原语视觉按 v6 重设计 |
| `runtime-three-layer-design.md` | runtime 侧。plugin-sdk 主干化的 runtime 实现基础 |
| `vscode-extension-analysis.md` | 理论依据。本文档的 contribution 体系/隔离/激活借鉴其结论 |
| `ADR-0049` | per-session 隔离范式。本文档 §1 原则 6 引用 |

---

## 决策变更记录

- **2026-07-31 · M8 底栏从「全局跨全宽」改为「main-panel 局部」**：原文为 M8 是 AppShell 底部跨 sidebar+main+drawer 全宽的状态栏（VSCode 风格全局底栏，bg-bg-sunken，挂 SideDrawer footer）；现方案为 M8 挂 main-panel 内部、composer 下方，不跨 sidebar/drawer，是 main-panel 的局部组件（bg-bg-elevated）。涉及 §3.1 拓扑树 / §3.2 维度 A4 / §6.1 StatusBarController / §10 M8 行。
- **2026-07-31 · confirm 从 M15 独立 modal 并入 M11 companion-band**：原文为 confirm/select/input 走 M15 ExtensionUIDialog（独立全局 modal）；现方案为 confirm/select/input 合并到 M11 companion-band（与 ask-user 同位置同机制，顶替 composer、阻塞），M15 降级为仅致命错误/系统级提示。涉及 §3.1 拓扑树 / §3.2 维度 B3/C1/C2 / §7.1 / §10 M11、M15 行。
