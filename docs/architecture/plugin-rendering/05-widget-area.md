# 05 · 对话流 widget 面板（M17）——todo/goal 常驻状态渲染

> 主文档：`README.md`（§3 方案总览）
> 视觉规格：`docs/page-design/v6-spec-plugin-rendering.html` §2b（维度 B4 · M17）
> 协议 SSOT：`docs/architecture/extension-gui-protocol.md` §4.1/§4.3/§15（setWidget → M17）

## §1 背景与决策记录

### 问题

todo/goal 的 TUI 渲染走 `ctx.ui.setWidget`（editor 上方**常驻面板**，同 key 覆盖更新）。pi 官方文档（tui.md Pattern 5）明确此通道定位："Show **persistent** content above or below the input editor. **Good for todo lists, progress.**"

xyz-agent 此前把 setWidget 映射到 **M7 drawer**（SSOT §4.1 旧映射），后又经 widget bridge 暴露为 **M2 sidebar tab**。用户明确拒绝 drawer/sidebar 两个方向（"不是 sidebar、不是 tab、不是 drawer"），要求 todo/goal 的常驻状态展示落在**对话流**。

M5（custom message）看似候选，但 pi 0.84.1 的 `sendMessage` 是 **append-only**（每次创建新 entry，无更新 API）——消息语义无法承载"常驻 + 覆盖更新"的面板语义。

### 决策（2026-08-14 用户拍板）

| # | 决策 | 说明 |
|---|---|---|
| D1 | **新增 M17 对话流 widget 面板**挂载点 | TUI setWidget 的 GUI 对应：常驻 + 同 key 覆盖更新 + undefined 清除，位置在 MessageStream 与 composer 之间 |
| D2 | **todo/goal 走 M17** | extension 侧用 `guiSetWidget(key, GuiComponent)`（GUI 模式）/ `setWidget(key, lines)`（TUI 模式），前端在对话流渲染 |
| D3 | **不走 M5** | todo/goal 不推 custom message（append-only 是消息语义，不承担面板语义）。M5 渲染接通（SystemNotice 消费 `__gui__`）保留为独立能力，与 M17 正交 |
| D4 | **不走 M4** | todo/goal 的 tool result 不再带 `__gui__`（移除），状态展示由 M17 单一承载，避免双份 |
| D5 | **M2 完全废弃** | widget 不进 sidebar：动态 widget view 发现（ViewHostStore getViewIds → views-source 动态 tab）移除；PluginViewContainer 保留（服务 plugin 静态 view 声明，M1/M2 目标架构），但不再承接 setWidget 推送 |
| D6 | **通用承接** | 前端只认 widgetKey + GuiComponent，不特化 todo/goal。任何 extension 推 widget 都在 M17 渲染 |

### 为什么 M17 而不是改造 M5

| 通道 | 常驻 | 覆盖更新 | 对话流位置 | 结论 |
|---|---|---|---|---|
| setWidget（M17 目标） | ✅ persistent | ✅ 同 key 覆盖 | ✅（新挂载点） | **采用** |
| sendMessage（M5） | ❌ 每次新消息 | ❌ 无更新 API | ✅ | 拒绝（语义错位） |
| tool result（M4） | ❌ 依附 tool 调用 | ❌ 只渲染一次 | ✅ | 拒绝（被动渲染） |
| sidebar/drawer（M2/M7） | ✅ | ✅ | ❌ 侧栏 | 拒绝（用户明确不要） |

## §2 挂载点定义

### 2.1 位置

```
Panel#main（自上而下）
├─ MessageStream（对话流）
├─ ★ M17 对话流 widget 面板（MessageStream 与 companion-band 之间）
├─ companion-band（M11，顶替 composer 的阻塞交互位）
├─ Composer（M9/M10）
└─ main-panel 底栏（M8 status）
```

对应 TUI：transcript → widget 面板 → editor → footer。M17 物理位置在 Panel.vue（MessageStream 与 composer-band 之间），逻辑上属对话流区域（维度 B4）。

### 2.2 语义

| 能力 | 行为 |
|---|---|
| 常驻 | 有 widget 数据时面板常驻显示（per-session 分区）；无数据隐藏 |
| 覆盖更新 | 同 widgetKey 重复推送原地替换内容（不新增消息） |
| 清除 | `guiSetWidget(key, undefined)` / `setWidget(key, undefined)` 移除该卡（已有 gui:null 清除语义） |
| 多 widget | 多 widgetKey **分栏并排**（flex wrap：单 widget 占满，多 widget 等分/按内容），卡片高度拉伸对齐 |
| 重开恢复 | extension 在 session_start 重新推 widget（todo handlers.ts / goal session-start.ts 已有），重开即恢复 |

### 2.3 视觉

- 每卡 = **widgetKey 标签行**（mono 9px，对齐 demo tool-label 风格）+ 内容（GuiComponentRenderer）
- 卡片容器 v6 风格（bg-surface + rounded-md，无 border 靠层级，对齐 gcard）
- 宽度跟随对话流内容区（max-w 对齐 MessageStream）
- **多 widget 分栏**：多 widgetKey 并排（flex wrap，gap 10px），单 widget 占满整行，多 widget 等分/按内容；卡片高度拉伸对齐（align-items:stretch）

## §3 数据链路（全复用，零新协议）

```
extension（todo/goal）
  ├─ ctx.ui.setWidget(key, lines)          TUI 文本行（RPC 模式原样透传）
  └─ guiSetWidget(key, component)          GUI 结构化（marker 编码进 string[]，协议已有）
        → pi RPC extension_ui_request{method:'setWidget'}
        → runtime event-adapter 解码（extension:widget / extension:widgetGui，已有）
        → renderer useExtensionHostBridge 订阅（已有）
        → ViewHostStore per-session 缓存（已有：widget:lines 窄化 ansi-text / gui:null 清除）
        → ★ WidgetArea.vue 渲染（新：替代 sidebar 动态 view 作为 widget 消费端）
```

**不需要改**：extension-protocol 类型、event-adapter、shared 协议类型、ViewHostStore 核心。

## §4 实现要点

### 4.1 前端（renderer + ui）

| 改动 | 文件 | 内容 |
|---|---|---|
| 新增 | `packages/ui/src/features/chat/WidgetArea.vue`（或 `rendering-protocol/` 旁） | 对话流 widget 面板：per-session 数据经 provide 注入（VIEW_HOST_SOURCE_KEY 扩展 getViewIds），多 key 卡片堆叠，每卡 = widgetKey 标签 + GuiComponentRenderer；gui:null 清除隐藏 |
| 改造 | `packages/renderer/src/composables/shell/useExtensionHostBridge.ts` | VIEW_HOST_SOURCE_KEY 的 provide 值扩展 `getViewIds(sessionId)`（WidgetArea 枚举该 session widget 用）；widget 不再注入 sidebar 动态 view |
| 改造 | `packages/renderer/src/core/extension-host/views-source.ts`（如存在） | 移除动态 widget view 发现（getViews 只返回静态声明） |
| 改造 | `packages/renderer/src/components/panel/Panel.vue` | MessageStream 与 composer-band 之间挂 `<WidgetArea :session-id="...">` |
| 改造 | `packages/ui/src/extension-host/PluginViewContainer.vue` | 移除动态 view 分支（若有），只渲染静态声明 view |

### 4.2 extension 侧

| 改动 | 文件 | 内容 |
|---|---|---|
| todo | `extensions/todo/src/index.ts` refreshDisplay | GUI 分支：`guiSetWidget("todo", buildGui(state.todos).component)`（buildGui 已有，model.ts:76）；TUI 分支保留 setWidget 文本行 |
| todo | `extensions/todo/src/tool.ts:226-229` | **移除** tool result 的 `details.__gui__`（M4，D4） |
| goal | `extensions/goal/src/projection/widget.ts` updateWidget | isGui 分支保留（guiSetWidget 推 buildGoalGui——33341c852 协议侧方向正确），挂载点由 M2 改 M17（前端侧完成，extension 零改） |
| goal | `extensions/goal/src/adapters/goal-control-adapter.ts:349` | **移除** tool result 的 `details.__gui__`（M4，D4） |

### 4.3 现状代码处置（c235b22d4 系列）

| commit | 内容 | 处置 |
|---|---|---|
| `c235b22d4` | 删 todo/goal sidebar 硬编码（正确）+ widget bridge 动态 sidebar tab（M2 方向） | 保留删除硬编码部分；**移除**动态 sidebar view 发现（D5），bridge 语义改为"widget → M17" |
| `33341c852` | goal updateWidget 改 guiSetWidget（协议侧正确，挂载点 M2 错误） | 保留协议侧（guiSetWidget），挂载点由前端 M17 修正 |
| `a9e84da87` | 复用 gui.ts buildGoalGui + 单测 | 保留 |

## §5 测试计划

| 层 | 用例 | 基线 |
|---|---|---|
| ui | WidgetArea：gui widget 渲染原语 DOM / 文本 widget ansi-text / 多 key 堆叠 / gui:null 清除隐藏 / 无数据隐藏 | 参照 ChatView.test.ts |
| core | ViewHostStore 不动（已有测试）；如 getViewIds 语义变化补测 | view-host-store.test.ts |
| renderer | views-source 改造后无动态 view（回归）；WidgetArea 挂载链路 | 参照 MessageStream.wire.test.ts |
| todo | refreshDisplay GUI 分支调 guiSetWidget（marker 编码断言）；tool result 无 __gui__ 断言 | gui.test.ts |
| goal | updateWidget GUI 分支（已有 widget.test.ts，微调挂载语义）；tool result 无 __gui__ 断言 | widget.test.ts / ports.test.ts |

## §6 文档同步（本次已完成）

- `extension-gui-protocol.md`：§4.1 映射表（setWidget → M17）、§4.3 挂载说明、§15.1/§15.4、§13 决策日志
- `v6-spec-plugin-rendering.html`：§1 拓扑树（M17）、§2b 新章节（M17 视觉规格）、§3 描述、§9.4 闭环表、§9.5 映射表、维度矩阵 B4
- `v6-plugin-max-demo.html`：§1 全景加 M17 区块（todo list-tree + goal card 示例），17 挂载点
- `renderer-target-architecture.md`：B 维度表加 B4/M17
- `README.md`：目标表 G1-G6 更新（见 §7）

## §7 README 主文档待更新项

README 目标表当前描述 M2 方向（"侧栏第 5 tab 二级 view tab todo/goal 内容常驻可见"），需改为：

| # | 使用者看到什么 | 对应挂载点 |
|---|---|---|
| G1 | 对话流里 todo/goal 工具结果渲染为结构化卡片 | ~~M4~~（移除，D4） |
| G2 | **对话流底部（composer 上方）常驻 widget 面板**：todo 列表 / goal 进度随状态实时更新（同 key 覆盖，不堆积） | **M17（本次新增）** |
| G3 | main-panel 底部状态栏聚合显示 todo 数量、goal 状态行 | M8（已实现） |
| G4 | composer `/` 菜单里 /goal /todo 正常出现 | M10（已收编） |
| G5 | drawer 不再展示任何 extension widget/status 内容（旧适配废弃） | M6/M7（已废弃） |
| G6 | 未来外部 plugin 声明 `contributes.views` 后侧栏自动出现新二级 tab；`contributes.statusBarItems` 后底栏自动出现状态项 | A 维度全链路（sidebar 不再承接 setWidget 推送） |
