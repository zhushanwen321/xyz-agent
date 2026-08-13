# Plugin 渲染体系落地总纲（2026-08）

> 本目录是「plugin 前端渲染体系」从现状到终态的实现设计文档集。主文档给出背景、现状、方案总览、验收与拆分；各挂载点的详细设计见子文档。
>
> 关联文档：
> - `docs/architecture/renderer-target-architecture.md` §3-§10（16 挂载点 / 4 维度架构 SSOT，本设计是其执行展开）
> - `docs/page-design/v6-spec-plugin-rendering.html`（plugin 渲染视觉规格，唯一组件级权威）
> - `docs/page-design/v6-plugin-max-demo.html`（16 挂载点全景 mockup，缩放版仅作形态参考）
> - `.cw/renderer-rebuild-v2/`（renderer 四包拓扑重构 cw 树，P4 extension-host 七 slice 已交付）

## §1 背景与目标

### 背景（SCQA）

**情境**：xyz-agent 的 plugin 体系经历两轮建设——2026-05 的 plugin-sdk/runtime 协议成熟（Worker 隔离 / RPC / 声明式 contribution），2026-07-08 的 renderer-rebuild-v2 大重构（P0-P6 全 closed）把前端渲染体系主体落地：`packages/core/src/extension-host/` 8 个 headless 模块、`packages/ui/src/extension-host/` 13 个渲染件、`commands.register` / `views.update` 两 API 三端一致、contribution schema v2、builtin tasks plugin 骨架、SDK freeze、sandbox 硬锁。

**冲突**：V6 设计文档（`v6-spec-plugin-rendering.html` + `renderer-target-architecture.md` §3-§10）承诺的 16 个挂载点 / 4 维度体系中，**结构容器维度（A）只有骨架没有内容**——todo/goal 等 pi extension 的 widget/status 推送虽已归一进新体系（MessageBusBridge → ViewHostStore / StatusBarController），但 sidebar plugins tab 的 ViewHost 只查固定 viewId `'sidebar.tab'`，与 todo/goal 的实际 viewId（`'todo'` / `'goal'`）**路由断裂**，内容进了 store 却无展示位。同时 drawer 的旧 widget/status 适配（`widget-buffers.ts` 的 unknownWidget / mapWidgetKeyToTab、DrawerPanel widget 区 + status footer）仍在运行，与新体系**双通道重复消费**同一批 WS 帧。

**疑问**：为什么「用 todo、goal 这些 extension 都没有内容展示」？——extension 侧在发（本地 pi 实测 setStatus/setWidget 均发出），新体系在收，但**展示位没接上**：侧栏 plugins tab 查的 viewId 与推送的 widgetKey 不匹配；drawer 旧通道内容藏在 terminal tab 的 unknownWidget 槽位且被终端输出遮蔽。

### 目标（从使用者体验倒推）

| # | 使用者看到什么 | 对应挂载点 |
|---|---|---|
| G1 | 对话流里 todo/goal 工具结果渲染为结构化卡片（list-tree / card+stats-line+progress-bar） | M4（已实现，保持） |
| G2 | 侧栏第 5 tab（Puzzle）内有**二级 view tab**（任务 / 目标…），点击切换，todo/goal 内容常驻可见 | M1+M2（本次补齐） |
| G3 | main-panel 底部状态栏聚合显示 todo 数量、goal 状态行（带优先级排序） | M8（已实现，视觉对齐） |
| G4 | composer `/` 菜单里 /goal /todo 正常出现（来自 plugin 声明，非 pi 硬编码双轨） | M10（本次收编） |
| G5 | drawer 不再展示任何 extension widget/status 内容（旧适配废弃），terminal/browser/git/doc/detail 固定 tab 不受影响 | M6/M7（本次废弃旧适配） |
| G6 | 未来外部 plugin 声明 `contributes.views` 后，侧栏自动出现新二级 tab；声明 `contributes.statusBarItems` 后底栏自动出现状态项 | A 维度全链路 |

### Out of Scope

- **E 维度（M14 独立 view 路由）**：L3 预编译组件仅 built-in 可用，external 强制 L1/L2；本次以 custom 逃生口 + 现有 chat/overview 路由覆盖，不做 plugin 可声明的独立 view 路由（设计文档 `renderer-target-architecture.md` §3.2 亦标注"未实现（仅 built-in）"）
- **drawer tab（A2/M6）开放给 plugin**：v2 决策"proposed 暂不开放，避免一级 tab 泛滥"，维持
- **runtime 侧 pi extension 改动**：todo/goal 的 widget/status 推送逻辑（`extensions/goal|todo/src/`）不动，消费侧前端承接
- **2026-08 架构审查 C1-C7 波次**（useSidebar 死壳 / summarizeTurn / composables 平铺等）：独立于本设计，不并入
- **C3 overlay 窗口化的完整视觉**（最小化 badge 拖动还原）：OverlayLifecycle 状态机已就绪，视觉精修归视觉线，本次只保证状态机闭环

### 层声明

当前层 = 前端 plugin 渲染体系（core/ui/renderer 三包）；下一层产物 = 可实现的接口 / 组件 / 数据流改动（最严格层，全适用 tech-design 准则 5/6/7）。

## §2 现状与问题分析

### 2.1 现状：已完成的主体（事实，均经代码核实）

**ExtensionHost core**（`packages/core/src/extension-host/`，8 模块 + 11 测试文件，s2 交付）：
ContributionRegistry（schema v2 解析 + builtin 静态声明）/ MountPointRegistry（壳注册制，4 挂载点已注册）/ CommandRegistry（定义完整但**零实例化**）/ ActivationManager / StatusBarController（聚合 plugin:statusBarUpdate + plugin:status-set-update + extension:status 三源，per-session/global 两 scope）/ ViewHostStore（per-viewId per-session GuiComponent 树缓存）/ MessageBusBridge（extension:widget/widgetGui/status + plugin:viewUpdate 归一为 bus 事件）/ OverlayLifecycle / NotificationHostController。

**UI 渲染件**（`packages/ui/src/extension-host/`，13 文件 + 6 测试，s4 交付）：ViewHost / StatusBar / CompanionBand / AskUserForm / PermissionRequestDialog / DialogRequestQueue / PluginSettingsPage（存在但未接线到 Settings）。

**壳接线**（P5，`packages/renderer/src/composables/shell/useExtensionHostBridge.ts`）：WS 消息流 → events 双订阅 → MessageBusBridge → bus → ViewHostStore/StatusBarController → app.provide 三注入 key。挂载点注册：sidebar.tab / panel.header / composer.toolbar / statusbar。

**挂载点接线现状**：

| 挂载点 | 现状 | 证据 |
|---|---|---|
| M1/M2 sidebar 第 5 tab | ✅ 已接线（声明式空壳）：SegmentedTab 5 tab（Puzzle icon），plugins tab → ViewHost `view-id="sidebar.tab"` | `Sidebar.vue:122-141` |
| M4 tool result | ✅ 闭环：Block.vue extractGui → GuiComponentRenderer | `Block.vue:411-429` |
| M5 custom message | ✅ 闭环（__gui__ 通路） | 同上 |
| M8 底栏 | ✅ 已接线：PanelContainer → StatusBar（A4） | `PanelContainer.vue:121` |
| M9 composer.toolbar | ✅ 已接线（空壳）：Composer → ViewHost `view-id="composer.toolbar"` | `Composer.vue:87-92` |
| M10 slash | ⚠️ 双轨：CommandPopover 消费 session.commands；contributes.slashCommands 已解析未并入 | `CommandPopover.vue:151-186` |
| M11 companion | ✅ 闭环：Workspace → CompanionBand + OverlayLifecycle | `Workspace.vue:11` |
| M12 panel.header | ✅ 已接线（空壳）：PanelHeader → ViewHost `view-id="panel.header"` | `PanelHeader.vue:117-122` |
| M14 独立 view | ❌ 未实现（仅 built-in chat/overview） | `MainPanel.vue:10-11` |
| M16 settings | ❌ PluginSettingsPage 未接线到 Settings | `components/settings/extension/` 无引用 |

### 2.2 现状：todo/goal 的数据流（物理数据流图）

```
pi extension (todo/goal)
  ctx.ui.setStatus("todo"/"goal", text)   → RPC extension_ui_request{method:setStatus}
  ctx.ui.setWidget("todo"/"goal", lines)  → RPC extension_ui_request{method:setWidget}
        │
        ▼
runtime event-adapter（packages/runtime/src/infra/pi/event-adapter.ts:268-355）
  setStatus → extension:status WS 帧（text + textRaw）
  setWidget → extension:widget WS 帧（widgetKey, lines）；GUI marker → extension:widgetGui
        │
        ▼  （双通道并行消费 ⚠️）
┌───────┴───────────────────────────────┬──────────────────────────────┐
│ 通道 A（旧，drawer 适配）              │ 通道 B（新，ExtensionHost）    │
│ PanelContainer 订阅 extension:*       │ useExtensionHostBridge 双订阅  │
│   → createDrawerBuffers               │   → MessageBusBridge 归一      │
│   → unknownWidget（todo/goal 落此）    │   → ViewHostStore（viewId=     │
│   → DrawerPanel widget 区              │      widgetKey='todo'/'goal'） │
│     （terminal tab，被 terminalLines   │   → StatusBarController        │
│       遮蔽 + 位置隐蔽）                │      （extensionStatus）        │
│   → status footer（drawer 底部小字）   │   → StatusBar（A4 底栏）✅      │
└──────────────────────────────────────┘   → plugins tab ViewHost 查      │
                                            viewId='sidebar.tab' ❌ 空     │
                                            （todo/goal 在 'todo'/'goal'） │
                                            └──────────────────────────────┘
```

### 2.3 问题清单（按严重度）

| # | 问题 | 根因 | 影响 |
|---|---|---|---|
| P1 | **todo/goal 无常驻展示位**：widget 进 ViewHostStore 的 `'todo'`/`'goal'` viewId，plugins tab 查 `'sidebar.tab'`，路由断裂 | 挂载点命名（`'sidebar.tab'`）被当作 viewId 使用，未区分"挂载点"与"plugin 声明的 view"两个概念（V6 模型：placement='sidebar.tab' 的多个 view 在 tab 内二级切换） | 用户看不到 todo/goal 面板（用户报告的直接根因） |
| P2 | **drawer 双通道重复消费**：extension:widget/status 同时进旧 drawer 适配和新体系 | renderer-rebuild-v2 未清理旧通道（P6 只删了孤儿 composables） | 维护双份状态源，旧通道位置隐蔽且遮蔽；用户看到的"无展示"部分源于旧通道 UX 极差 |
| P3 | **D1 slash 双轨未收编**：core CommandRegistry 零实例化，contributes.slashCommands（builtin tasks 已声明 goal/todo）不生效 | s2 交付了注册表但壳未实例化 + CommandPopover 未改消费源 | /goal /todo 显示依赖 pi session.commands 通道，plugin 声明的元数据（icon/category/keybinding）无处落地 |
| P4 | **M16 设置页未接线**：PluginSettingsPage 存在但 Settings 无入口 | P5 壳接线未覆盖 settings | 用户无法管理插件 contribution 可用性 |
| P5 | **V6 视觉未对齐**：7 原语、A1 二级 tab、A4 底栏视觉仍是 re-home 前的旧样式 | C7 波次（plugin 渲染 v6 视觉）在设计文档层未实施 | 与 v6 整体视觉不一致 |
| P6 | 死残留：SideDrawerTab 类型死成员 `'tasks'`、i18n tasksHint 死 key | 删除 tasks 域时未清理 | 轻微技术债 |

### 2.4 根因分析

三句话：
1. **挂载点 ≠ view 的概念混淆**导致 P1——`bootstrap.ts registerMountPoints` 把 `'sidebar.tab'` 当挂载点注册，`Sidebar.vue` 把 `'sidebar.tab'` 当 viewId 查，而数据侧（widgetKey）是开放字符串。V6 的模型是挂载点内聚合多个 plugin view（二级 tab），当前实现只支持"挂载点 = 单一 view"。
2. **双通道并存是重建的中间态**——新体系（ExtensionHost）建成时旧通道（drawer widget）未随 tasks 域一起删除，因为 terminal/browser widget 通道还有潜在消费方，删除决策被推迟。
3. **声明式 contribution 消费面不完整**——schema v2 定义了 views/menus/commands/configuration，但消费侧只接了 views（挂载点级）+ statusBarItems，menus/commands/configuration 的渲染与接线未落地，D1/D2 半完成。

## §3 解决方案总览

### 3.1 方案对比（总体架构路径）

| 方案 | 说明 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|---|
| **A（推荐）补齐式** | 在新体系基础上补 4 块：① plugins tab 二级 view tab + viewId 路由修正 ② 废弃 drawer 旧适配 ③ CommandRegistry 实例化 + CommandPopover 收编 ④ M16 接线 + V6 视觉对齐 | ★★★★★ 与 renderer-target-architecture 终态一致，单一数据源（ViewHostStore/StatusBarController） | 中（4 块独立可并行） | 低（新体系已有测试护栏：core extension-host 224 it + ui extension-host/rendering-protocol 101 it，2026-08-13 快照） |
| B 推倒重建 | 废弃现有 ExtensionHost，重写 16 挂载点体系 | ★★★ 方向一致但浪费已交付的 s1-s7 | 极高 | 高（已交付 108 core + 51 ui 测试全丢） |
| C 维持现状 | 只修 viewId 路由（P1），不动 drawer/slash/settings | ★★ 双通道永久并存，D1 双轨永久 | 低 | 中（技术债持续，每加一个挂载点都要在双通道里选） |

**推荐 A**：renderer-rebuild-v2 的主体方向经 9 FR/13 AC 验证成立，缺的是"消费面闭环"而非"架构再设计"。方案 A 的每块都有独立验收信号，且与 V6 视觉线 C7 波次天然衔接（视觉对齐正好补 C7 未实施的缺口）。

被否方案说明：若用 B，s1-s7 已交付的 9 FR/13 AC（含 sandbox 硬锁、SDK freeze）全部作废重做，三个月后回看是纯浪费；若用 C，"没有内容展示"的用户问题不解决，且双通道状态源分裂会持续制造"为什么这里改了那里没变"类 bug。

### 3.2 终态（使用者视角，交互样例）

**场景 1：agent 建 todo 列表**
```
用户: "用 todo 工具添加 3 个任务：写设计文档、实现、测试"
agent: [调用 todo tool → tool_call_end details.__gui__ = list-tree]
对话流: ╭─────────────────────────────╮
        │ ✓ 写设计文档    ⏸ 实现    ○ 测试 │  ← M4 list-tree 卡片
        ╰─────────────────────────────╯
侧栏:   [sessions|files|subagents|workflows|🔲]  ← 点 Puzzle tab
        ╭─ 任务 │ 目标 ───────────────╮  ← M1+M2 二级 view tab（builtin tasks 声明）
        │ ✓ 写设计文档                │
        │ ⏸ 实现                      │  ← 来自 pi widget 推送（viewId='todo'）
        │ ○ 测试                      │
        ╰─────────────────────────────╯
底栏:   [📋 2 pending]   ← M8 status（extension:status 聚合）
```

**场景 2：/goal create**
```
用户: "/goal create 完成 plugin 体系落地"
对话流: ╭─ ◆ 完成 plugin 体系落地 ─────────╮
        │ Turn 1 | 0% tokens | 0m           │  ← M4 card + stats-line + progress-bar
        ╰──────────────────────────────────╯
侧栏 plugins tab: 二级 tab「目标」显示 goal 状态卡（进度/预算/耗时）
底栏:   [◆ 完成 plugin 体系落地 Turn 1 | 0% tokens]  ← M8
```

**场景 3：drawer 行为（旧适配废弃后）**
```
用户点 drawer 按钮: terminal/browser/git/doc/detail 五个固定 tab 正常
                  （terminal = PTY 交互终端，browser = WebContentsView，均不依赖 widget 数据）
不再出现: ✗ widget 内容区（drawer-widget-gui/lines）✗ status footer（drawer-status-footer）
          ✗ unknownWidget「todo」标记
```

**场景 4（未来 external plugin）**
```
plugin A 安装后声明 contributes.views[{id:'deploy', title:'部署', placement:'sidebar.tab'}]
+ activate 中 api.views.update('deploy', guiTree)
→ 侧栏 plugins tab 出现「部署」二级 tab，点开显示其 GuiComponent 树
plugin A 声明 contributes.statusBarItems[{id:'pipeline', priority:10, alignment:'left'}]
+ api.ui.updateStatusBarItem('pipeline', 'running')
→ 底栏显示「pipeline: running」（priority 排序，左段）
```

### 3.3 四块子设计（详见子文档）

| 子文档 | 内容 | 核心决策 |
|---|---|---|
| [01-view-host-routing.md](01-view-host-routing.md) | plugins tab 二级 view tab + 挂载点/view 概念分离 + builtin tasks views 声明 + 空态/无 session 语义 | 挂载点（placement）与 viewId 分离；tab 列表 = ContributionRegistry 中 placement='sidebar.tab' 的 views；内容 = ViewHostStore.getView(viewId) |
| [02-drawer-widget-deprecation.md](02-drawer-widget-deprecation.md) | 废弃 drawer 旧适配（widget-buffers/DrawerPanel widget 区/status footer/PanelContainer 旧订阅） | 全删（含 terminal/browser widget 通道评估——固定 tab 不依赖 widget 数据）；status 显示完全移交 StatusBar |
| [03-slash-command-unify.md](03-slash-command-unify.md) | CommandRegistry 实例化 + CommandPopover 消费归一 + builtin tasks slashCommands 生效 | plugin 声明提供元数据、session.commands 提供执行清单，合并去重；执行仍由 pi extension 承担 |
| [04-settings-and-visual.md](04-settings-and-visual.md) | M16 设置页接线 + 7 原语/A1 二级 tab/A4 底栏 V6 视觉对齐 | PluginSettingsPage 挂 Settings；视觉数值以 v6-spec-plugin-rendering.html 为权威 |

### 3.4 关键决策与权衡

**D1：挂载点与 view 概念分离（P1 根因修复）**
- 选择：挂载点（`'sidebar.tab'` 等，壳注册制）是**宿主位置**；view 是 plugin 声明的 `{id, title, icon, placement}`，一个挂载点聚合多个 view。plugins tab 内渲染二级 tab bar + 按 active viewId 渲染 ViewHost。
- 被否：维持"挂载点 = 单一 view"（viewId='sidebar.tab' 查数据）——无法承载多个 plugin view，V6 视觉（l2-tabbar）无法落地。
- 证据：V6 spec §2 A1（"plugin view 统一收口 sidebar 第 5 独立 tab（Puzzle icon）" + l2-tabbar 定义）；`contributes.views[].placement` 开放字符串设计（schema v2）。

**D2：todo/goal 数据接入 = 复用 pi widget 推送通道（零 runtime 改动）**
- 选择：builtin tasks plugin 在 `builtin-contributions.ts` 声明两个 view（`{id:'todo', title:'任务'}`、`{id:'goal', title:'目标'}`，placement='sidebar.tab'）。pi extension 的 `setWidget('todo'/'goal', ...)` 推送经 MessageBusBridge 归一为 viewId='todo'/'goal'，恰好落入对应 view。
- 被否：builtin tasks plugin 做成真 Worker plugin 自读 pi 状态——todo/goal 状态机在 pi extension 闭包内，无读取 API，成本高且违背"不动 runtime pi 边界"。
- 证据：`message-bus-bridge.ts` parseWidget 已实现 `viewId ← widgetKey`（`viewId: widgetKey` 直接映射）；本地 pi 实测 todo extension 确实推送 setWidget/setStatus。

**D3：drawer 旧适配全删（含 terminal/browser widget 通道）**
- 选择：删除 widget-buffers.ts 全部（unknownWidget/mapWidgetKeyToTab/statusMap/guiWidgetsByTab）+ DrawerPanel widget 区/status footer + PanelContainer 旧订阅。terminal/browser 固定 tab 的渲染（PTY 终端、WebContentsView）不依赖 widget 数据；subagent streaming 走独立 `subagent-stream` 事件（event-adapter 短路分支），不受影响。
- 被否：保留 terminal/browser widget 通道（未知 extension 可能推送）——与新体系重复，且"可能有人用"是推测性保留，违反最小代码原则；若未来确需，plugin 可用 views.update 显式推送（新规范路径）。
- 证据：widgetKey 匹配 terminal/browser 的推送来源核查（见 02 子文档 §2），当前无活跃生产消费方。

**D4：slash 双轨收编规则**
- 选择：CommandRegistry 实例化于壳，消费 source = builtin/external contributes.slashCommands ∪ session.commands（pi 真源）。同名命令以 plugin 声明元数据（icon/category/keybinding）优先，session.commands 补充执行路径。CommandPopover 改从 CommandRegistry 取数。
- 被否：反向（session.commands 优先）——plugin 声明无法生效；只读 session.commands 不动 CommandRegistry——双轨永久。

**D5：M16 接线形态**
- 选择：PluginSettingsPage 挂入 Settings 的 ExtensionPage（或独立 tab），数据源接 contribution-registry 可用性查询（已实现 PluginSettingsDataSource 契约）。configuration schema 驱动表单为二期（contributes.configuration 的消费面，本次只做插件列表/可用性管理）。
- 证据：`plugin-settings-data-source.ts` 已定义注入契约；`PluginSettingsPage.vue` 已实现四列列表 + 置灰标注。

## §4 验收

> 验收用真实场景：dev 模式（`pnpm dev`）+ 本地 pi 子进程 + 真实 todo/goal extension（staged builtin 版）。每场景标注回溯 §1 目标。

### 场景 A：todo 全链路可见（回溯 G1+G2+G3）

**步骤**：
1. dev 启动（`pnpm dev`），新建 session
2. 对话输入"用 todo 工具添加 3 个任务：写设计文档、实现、测试"
3. agent 调用 todo tool 后，观察：
   - 对话流 tool 块内出现 list-tree 卡片（✓/⏸/○ 状态圆点）——M4
   - 侧栏点 Puzzle tab：出现「任务」「目标」二级 tab，「任务」下显示 3 条 todo（随状态变化刷新）——M1+M2
   - main-panel 底部状态栏出现「📋 N pending」——M8

**通过标准**：三处内容同时可见；todo 状态变更（agent 标记 completed）后三处同步刷新（对话流卡片、侧栏列表、底栏计数）。

### 场景 B：goal 全链路可见（回溯 G1+G2+G3）

**步骤**：
1. 对话输入"/goal create 完成 plugin 体系落地"
2. 观察：
   - 对话流出现 goal card（标题 + Turn 计数 + token 预算进度条）——M4
   - 侧栏 plugins tab「目标」二级 tab 显示 goal 状态卡（progress-bar/stats-line）——M1+M2
   - 底栏显示 goal 状态行（◆ 标题 | Turn N | % tokens）——M8

**通过标准**：三处同时可见；`/goal complete` 后三处同步更新为完成态（对话流 card、侧栏卡、底栏 ✓ Completed）。

### 场景 C：drawer 旧适配废弃（回溯 G5）

**步骤**：
1. 完成场景 A 后（todo 列表存在），打开 drawer
2. 检查 terminal/browser/git/doc/detail 五个 tab 正常（PTY 可输入、git 面板可交互）
3. 检查**不存在**：widget 内容区（drawer-widget-gui/lines 无渲染）、status footer（drawer-status-footer 无 DOM）、unknownWidget 标记

**通过标准**：drawer 五个固定 tab 功能无损；无任何 extension widget/status 内容在 drawer 内渲染；代码层 `grep -rn "createDrawerBuffers\|unknownWidget\|drawer-widget-gui" packages/` 零业务命中（测试断言除外）。

### 场景 D：slash 收编（回溯 G4）

**步骤**：
1. 在 composer 输入 `/`，观察命令列表
2. /goal、/todo 出现且带 plugin 声明元数据（如 icon）
3. 选中 /goal 发送，pi 正常执行（goal 卡片出现在对话流）

**通过标准**：/goal /todo 可见可触发；执行路径与 pi extension 一致（无功能回归）；`grep -rn "getSlashCommands" packages/` 显示 builtin 声明被消费。

### 场景 E：设置页入口（回溯 G6）

**步骤**：
1. 打开 Settings → 扩展页面
2. 可见插件贡献列表（builtin statusline/tasks 等），不可用挂载点的贡献置灰且有原因文案

**通过标准**：列表渲染 + 置灰逻辑正确（与 `contribution-unavailable` testid 断言一致）。

### 场景 F：回归护栏（回溯全部）

**步骤**：跑 `cd packages/renderer && npx vitest run`、`cd packages/ui && npx vitest run`、`cd packages/core && npx vitest run` + `pnpm typecheck`。（注：本次四块改动不触 runtime，`packages/runtime` 测试可保留作全量回归但不作为本设计护栏。）

**通过标准**：全绿；删除 drawer 旧适配后无测试依赖旧通道（widget-buffers.test.ts 随删除，DrawerPanel.test.ts 改为断言无 widget 区）。

## §5 下一层拆分

| 单元 | 子文档 | 独立验收信号 | 依赖 |
|---|---|---|---|
| W1 plugins tab 二级 view tab + viewId 路由 | 01 | 场景 A/B 的侧栏部分 | 无（纯前端） |
| W2 drawer 旧适配废弃 | 02 | 场景 C | W1 之后（先有展示位再删旧通道，避免内容真空） |
| W3 slash 收编 | 03 | 场景 D | 无 |
| W4 M16 接线 + V6 视觉对齐 | 04 | 场景 E + 视觉比对 | W1（二级 tab 视觉依赖 l2-tabbar） |

**依赖关系**：W1 → W2（先建新展示位，再删旧通道，保证任意时刻用户可见 todo/goal 内容）；W1 → W4（视觉对齐在结构落地后）；W3/W4 与 W1/W2 无文件冲突可并行。

**拆分理由**：四块各自有独立的验收信号（场景 A-F 一一对应），可按 cw wave 独立执行与审查；W1 是核心（用户可见性），W2 是清理（零新增逻辑），W3 是收编（行为不变只换数据源），W4 是接线+视觉（低风险）。

**待验证检查点**（诚实标注）：
- [ ] builtin tasks 声明 views 后，`scanContributions` 的消费链路（ContributionRegistry.getViews → tab 列表）需补测试
- [ ] CommandRegistry 实例化后与 ActivationManager 的接线（builtin 免审批路径）
- [ ] terminal/browser widget 通道删除前需最终确认无活跃推送方（探针：dev 运行 30 分钟收集 extension:widget 帧的 widgetKey 分布）
