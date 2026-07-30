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
6. **per-session 隔离内建**：ADR-0036 的 `useSessionScopedState` 工厂是一等公民，所有 per-session 状态默认隔离，不依赖开发者记得清空。

---

## §2 目标分层架构（renderer 六层）

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
│  Foundation      store / composable 基础设施 / api(WS) / i18n   │
│  useSessionScopedState · useConnection · ui 原语(button/dialog)│
│  Pinia stores(30) · WS client · event-bus                      │
└─────────────────────────────────────────────────────────────────┘
```

**关键变化**：
- **Extension Host 是新增层**：当前 renderer 没有「扩展宿主」概念，pi extension 的 UI 消费散落在 useExtensionUI/useDrawerWidgetBuffers/extensions/registry.ts 等。新架构把扩展消费收敛为独立层。
- **Rendering Protocol 从「pi extension 专用片段」提升为「共享层」**：当前 GuiComponentRenderer 只服务 tool result/widget，新架构下 plugin 面板也走它。
- **Feature Layer 按业务域切**：解决当前 features(41)/panel(37) 两巨型桶无业务域分组的问题。每个功能域（chat/session/sidebar/...）是容器+composable+store 的内聚单元。

---

## §3 终态 plugin 渲染机制 ★ 核心 ★

> 这一章是给视觉稿联动的设计输入。定义「plugin 能往哪些视图注入、注入什么、改到什么程度」。

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
│     ├─ SegmentedTab (4 tab: sessions/files/agents/flows)         ← M1 挂载点
│     ├─ 子视图区 (按 activeTab 切换)                               ← M2 挂载点
│     │  ├─ sessions → SessionList
│     │  ├─ files → FileView
│     │  ├─ agents → SubagentList
│     │  └─ flows → WorkflowList
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
│           │  └─ companion-band
│           │     ├─ ProgressZone
│           │     └─ AskUserOverlay | Composer                      ← M11 挂载点
│           │        └─ Composer
│           │           ├─ CommandPopover (slash 菜单)              ← M10 挂载点
│           │           └─ composer-bar 工具条 (5 按钮)             ← M9 挂载点
│           └─ SideDrawer#drawer (可拖拽)
│              ├─ header tab栏 (terminal/browser/git/doc/detail/tasks) ← M6 挂载点
│              ├─ 内容区 (按 tab 切换)                               ← M7 挂载点
│              │  ├─ widget/widgetGui → GuiComponentRenderer
│              │  └─ 各固定 tab 组件
│              └─ footer status 底栏                                ← M8 挂载点
└─ SettingsModal (⌘, 全局 Dialog)                                   ← M16 挂载点
   + [全局] ToastContainer
```

### 3.2 5 个视图自定义维度（plugin 能往哪里注入）

16 个挂载点归为 5 个维度。每个维度标注：自定义级别、当前状态、VSCode 对应。

#### 维度 A：结构容器注入（plugin 往固定结构里加槽位）

| 子项 | 挂载点 | 内容 | 级别 | 当前状态 | VSCode 对应 |
|---|---|---|---|---|---|
| **A1** | 侧栏新增 tab（M1+M2） | plugin 声明 view id/icon/title，renderer 渲染 tab + 内容区（数据源契约） | L1 | panels 声明未消费 | viewsContainer + views |
| **A2** | 抽屉新增 tab（M6+M7） | plugin 声明 drawerTab id/icon，内容用 GuiComponent 原语 | L1 | 无 | 无直接对应（近似 panel） |
| **A3** | 工具条/头部新增按钮（M9+M12） | plugin 声明 action button（icon+command），点击触发 command | L1 | 无 | menus (editor/title) |
| **A4** | 底栏状态项（M8） | plugin 推送 statusKey+text+priority，全局底栏聚合 | L1 | pi 已实现（extension:status），plugin 未接入 | statusBarItems |

**当前状态**：维度 A 是 plugin 系统最大的空白——`contributes.panels/statusBarItems` 已在 SDK 声明但 renderer 零消费。pi 侧的 status 已实现但绑死 SideDrawer footer（规划提升全局底栏）。

#### 维度 B：对话流内容注入（agent 特有，最核心）

| 子项 | 挂载点 | 内容 | 级别 | 当前状态 | VSCode 对应 |
|---|---|---|---|---|---|
| **B1** | tool result 渲染（M4） | tool 返回 `details.__gui__`，对话流内渲染 GuiComponent | L2 | **已实现** | 无（agent 特有） |
| **B2** | 自定义消息卡片（M5） | plugin 推送 message，对话流穿插 GuiComponent | L2 | **已实现** | 无（agent 特有） |
| **B3** | composer 上方交互区（M11） | ask-user 富交互占位 | L1/L2 | **已实现** | 无（agent 特有） |

**当前状态**：维度 B 是最成熟的插件注入面——GuiComponent 7 原语 + ask-user 双向交互均已验证可用。

#### 维度 C：交互对话框（plugin 主动弹窗）

| 子项 | 挂载点 | 内容 | 级别 | 当前状态 |
|---|---|---|---|---|
| **C1** | confirm/select/input（M15） | 内置对话框原语 | L1 | **已实现**（pi 侧） |
| **C2** | ask-user 富交互（M11） | 多问题/多选/评论 | L1/L2 | **已实现** |

**当前状态**：已实现，但 pi 侧（`extension.ui_request`）和 plugin 侧（`plugin:uiRequest`）消息类型不一致，renderer 只消费前者。统一见 §7。

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
| **L1 元数据+数据驱动** | plugin 给 `{id, icon, title, data, command}`，renderer 用固定宿主渲染 | 维度 A、D | 高（plugin 不控制渲染） | ✅ |
| **L2 结构化原语树** | plugin 给 GuiComponent 原语组合，renderer 用原语渲染器渲染 | 维度 B、C | 中（原语集合受限） | ✅ |
| **L3 预编译自定义组件** | plugin 给 Vue 组件定义，编译期打包 | 维度 E + 复杂 view 逃生口 | 低（需 trust） | ❌ 仅 built-in |

**设计依据**：用户已定「面板渲染用结构化原语组合」（L2）。L1 用于结构性容器（tab/按钮/底栏，renderer 有固定宿主），L3 仅作内置逃生口（external 插件强制走 L1/L2）。

### 3.4 给视觉稿的具体需求清单

> 视觉稿需为以下每项定义 v6 目标视觉。标注「已定义」的见 v6-design.md，需对齐；「待定义」的是视觉稿要补充的。

**维度 A（结构容器）——全部待定义**：
- A1/A2 plugin tab：icon 规范（lucide name 还是 SVG？size scale？）/ tab 激活态 / 空态 / loading 态 / count badge（复用 SegmentedTab 范式还是独立？）
- A3 plugin 按钮：icon size / 位置分组（composer-bar vs panel-header）/ hover / disabled / 带 count 徽章态
- A4 底栏 status item：排列方向（左/右）/ 分隔符 / priority 排序 / 颜色语义（ok/warn/danger）/ 点击态 / tooltip 态 / 滚动溢出

**维度 B（对话流内容）——B 原语待定义，B3 已定义**：
- B1/B2 七个 GuiComponent 原语的 v6 视觉 + 嵌套组合态（详见 §5）
- B3 ask-user overlay：已定义（v6-design §4.x），需确认 composer 位互斥状态

**维度 C（对话框）——已定义，需对齐 v6**：
- C1 confirm/select/input：ExtensionUIDialog 形态对齐 v6
- C2 ask-user：AskUserOverlay 形态对齐 v6

**维度 D（命令配置）——D1 已定义，D2 待定义**：
- D1 slash command：CommandPopover 已定义，对齐 v6
- D2 settings 区段：待定义——schema 驱动表单的控件样式（复用 settings page 控件还是独立？）

**维度 E（独立 view）——待定义**：
- E1 独立 view 容器规范：padding / max-width / header / 滚动区 / 与 chat view 的视觉区分

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

> 当前 7 原语组件**已实现**（文档滞后标 P2 待实现，但 gui/ 目录下 Card/TabBar/ProgressBar 等均存在）。v6 重设计是改 CSS/模板，**不改协议类型**——已接入的 extension 零改动自动获得 v6 视觉。

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
├─ StatusBarController     底栏状态项聚合（pi status + plugin statusBarItems 统一）
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
| pi `ctx.ui` | pi extension | `extension.ui_request` | ✅ ExtensionUIDialog + AskUserOverlay |
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
| M8 | SideDrawer footer status（规划全局底栏） | 数据驱动 | 是（extension:status） | **P（强）** | statusBarItems | L1 + L2 | A4 |
| M9 | Composer composer-bar 工具条 | 固定 | 否 | — | menus (editor/title) | L1 | A3 |
| M10 | Composer CommandPopover（slash） | 数据驱动 | 是（commandStore） | **P（强）** slash command | commands | L1 | D1 |
| M11 | Composer 上方 companion-band | slot（互斥） | 半（AskUserOverlay） | P（ask-user） | 无（agent 特有） | L2 | B3 |
| M12 | PanelHeader 按钮组 | 固定 | 否 | — | menus (editor/title) | L1 | A3 |
| M13 | MessageStream 浮层 slot | 固定浮层 | 否 | — | 无（agent 特有） | L2（低优） | — |
| M14 | 全局独立 view（chat/overview） | 固定 | 否 | — | webviewPanel | L3（仅内置） | E1 |
| M15 | 全局 modal/dialog | slot | 是（ExtensionUIDialog） | P（confirm/select/input/editor/notify） | window/dialogs | L1 | C1 |
| M16 | SettingsModal 扩展管理页 | 固定 | — | P（LoadPaths） | extensions view | L1 | D2 |

**关键发现**：
- **最成熟的插件注入面**：M4/M5/M7/M8（对话流 + SideDrawer），均为 L2 原语已验证。
- **最大空白**：M1/M6/M9/M12/M14（结构性 contribution：sidebar tab / drawer tab / 工具条按钮 / 独立 view）——`contributes.panels/statusBarItems` 声明但 renderer 零消费。
- **事实雏形**：`extensions/registry.ts` 已是扩展适配器分流层（goal/todo/subagents 经它分流到专属 UI），可升格为正式 ContributionRegistry。

---

## 附录：与现有文档的关系

| 文档 | 关系 |
|---|---|
| `v6-architecture-refactor.md` | 互补。那份是「现状审查+缝补」（runtime/shared/IPC/renderer 编排层），本文档是「renderer 终态架构+plugin 渲染」 |
| `v6-design.md` §6/§7/§8 | 承接。v6-design 的架构决策是本文档的输入；本文档 §3 给 v6-design 视觉稿提供「plugin 需定义什么」清单 |
| `extension-gui-protocol.md` | 兼容。本文档 §5 把它的 GuiComponent 提升为共享渲染协议，7 原语视觉按 v6 重设计 |
| `runtime-three-layer-design.md` | runtime 侧。plugin-sdk 主干化的 runtime 实现基础 |
| `vscode-extension-analysis.md` | 理论依据。本文档的 contribution 体系/隔离/激活借鉴其结论 |
| `ADR-0036` | per-session 隔离范式。本文档 §1 原则 6 引用 |
