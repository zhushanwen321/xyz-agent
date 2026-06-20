# 工作区 · 双 Panel 主从模式（设计探索）

**类型**: 工作区拓扑设计稿（探索性）
**关联**: PRODUCT.md、0001-visual-direction-zcode-cold、design-tokens
**配套 HTML**: `html/workspace-dual-panel.html`

## 背景

早期设计是**单工作区三栏**：消息流（50%）+ 底部 composer + 右侧 zone（50%，进程面板/抽屉互斥容器），见 zcode-ui-spec.md。本稿把它改成**双 panel 双 session**，贴合用户"单屏左右分离两个 terminal"的真实工作习惯。左侧边栏（aside）单独设计，本稿不涉及。

## 与 Overview 的关系

Overview（独立 L1 Region）激活时**覆盖整个工作区**——本稿的 main-panel 区域被 Overview 卡片网格取代，双 Panel / composer 暂时隐去，工作区内容不销毁、退出即恢复。入口在 **sidebar「Overview」按钮**（⌘⇧O），不在工作区顶栏。点 Overview 任意卡片 → 载入该 session → Overview 退出 → 工作区双 Panel 恢复。详见 `overview/spec.md` 与 `overview/draft-entry.html`。

## 拓扑决策 · 主从模式

双 panel 各自承载一个独立 session。运行模式定为**主从**而非对等：

- 同一时刻默认只有一个 panel 在"真干活"，另一个是待机/参考。
- active panel 的对话区**永不被压缩、不被遮挡**——所有附属信息（进度、diff）往非 active panel 推或内嵌。
- 代价：两 session 同时活跃时，开 diff 抽屉会盖住对侧。这是已知限制，v1 不处理。

**为什么主从而非对等**：对等模式下"附属信息覆盖对侧"会摧毁双 panel 的核心价值（同时看两 session）。主从贴合真实习惯（一主一辅），状态机更简单。

## 屏幕布局

```
┌──────────────────────────────────────────┐
│  main-panel（工作区，可视为一整屏）        │
│  ┌──────────────────┬───────────────────┐ │
│  │  Panel-1 active  │  Panel-2          │ │
│  │ [header]         │ [header]          │ │
│  │ 对话流           │ 对话流             │ │
│  │ progress-zone ▲  │ progress-zone     │ │
│  │ composer         │ composer          │ │
│  │ git-zone      ▼  │ git-zone          │ │
│  └──────────────────┴───────────────────┘ │
└──────────────────────────────────────────┘
```

- **单 session**：Panel-2 自动隐藏（Panel-1 撑满整个工作区）。开第二个 session 才 split。
- **进度浮层方案已废弃**：早期方案是 active panel 的进度 card 浮到对侧顶部展开，会引发"两 panel 打架"。改为 composer 上下内嵌 zone，彻底消除冲突（见下）。

## 进度区 · composer 上下内嵌 zone

进度信息从浮层 card 改为**两个等宽内嵌组件**，固定在 composer 上下，不外推、不覆盖对侧：

### progress-zone（composer 上方）
- 展开态：todo / goal 列表 + 汇总进度条（height 略高）
- 收起态：点右上 chevron 收成**单行**（标题 + 简化进度条 + 百分比）
- 每 panel 独立，跟随本 session

### git-zone（composer 下方）
- 单行 38px，常驻
- 左：分支名 + `+N −M · K 文件`
- 右：`暂存 / 提交 / Diff` 操作按钮
- 干净工作区态：显示"工作区干净"，只留 Diff 按钮

## Panel 激活标识系统（四层叠加）

单层都不抢眼，合起来一眼认出焦点。设计取向是"被选中的光晕"而非"硬框"，匹配冷蓝调性。

| 层 | 激活 panel | 非激活 panel | 说明 |
|---|---|---|---|
| 左侧竖条 | 2px accent 实色 | 无 | 焦点锚点，扫一眼即知焦点在哪侧 |
| 内描边 ring | 1px `accent-ring`（accent 30% 透明）inset | 无 | 用 inset box-shadow 不改盒模型、不抖动；半透明避免中缝双线打架 |
| 背景 | `bg-elevated` 微亮 | `bg-panel` | 极弱差异，营造"浮起"而非"变色" |
| 整体 | opacity 1 | opacity 0.5，hover 回升 0.78 | 文字元素统一退后，主从语义；非激活不逐元素改 color |

**关键取舍**：未用纯 accent 1px 实线整圈——双 panel 共用中间分隔线，整圈实线会在中缝处出现两条 accent 线打架。文字暗淡用整体 opacity 而非逐元素改色，视觉统一、切换过渡顺滑。

**校准点**：opacity 0.5 可能偏暗。真机若非激活 panel 读起来吃力提到 0.6；焦点区分度不够降到 0.4。

## Header 结构 · 单一 panel-header

每个 panel 只有一个 header（无工作区级横跨 header）。因为每个 panel 是独立 session，header 信息属 per-session：

```
[●状态圆点] session名 [📁 目录]              [⋯三点] [×关闭]
```

- 状态圆点：per-session（running / idle / done）
- session 名：主信息（激活态亮、非激活态暗）
- 目录：文件夹图标 + mono 路径，可点击，超长省略号
- 三点更多 / ×关闭（hover 变红，关闭语义）
- 分屏 / 新建会话：panel-header 同槽位互斥按钮（单 panel 显「分屏」开第二会话；双 panel 显「新建会话」替换待机侧为新会话）
- **不含**：模型、进度（这些在 composer 上下 zone 里）

## 状态与交互

| 控件 | 行为 |
|---|---|
| panel-header split 按钮 | 单 panel 显示，点击开第二会话；双 panel 时隐藏（不允许多于 2） |
| panel-header「新建会话」按钮 | 双 panel 显示（与 split 同槽位互斥），替换待机（非 active）侧为新会话并聚焦；单 panel 隐藏（split 已覆盖开第二会话） |
| 点 panel | 切换 active，激活标识四层联动翻转 |
| progress-zone chevron | 展开 / 收起（单行） |
| git-zone 暂存/提交/Diff | git 操作（Diff 当前仍走覆盖对侧的抽屉浮层） |
| header × | 双 panel → 关闭该侧回单；单 panel 关闭主会话需确认流（本稿不处理） |
| aside 图标 | 占位 56px 折叠态，单独设计未涉及 |

## 边缘状态与已知限制

| 场景 | 处理 |
|---|---|
| 单 session | Panel-1 撑满整个工作区，无 Panel-2 |
| 两 session 都活跃 + 开 diff | 对侧被覆盖，无法同看（已知限制，v1 不处理） |
| diff 抽屉方向 | active panel-1 从右滑覆盖 panel-2；active panel-2 从左滑覆盖 panel-1 |
| diff 抽屉宽度 | 当前覆盖对侧单 panel（半宽），diff 横向偏挤。后续可考虑全工作区覆盖 |
| 全局工作区操作（新建会话/布局切换） | 已并入 panel-header（split + 新建会话同槽位互斥），无工作区级横跨 header |

## 遗留

- **diff 抽屉仍是浮层**（覆盖对侧 panel）。若要内嵌化（panel 内抽屉 / 全工作区覆盖），需单独设计。
- ~~**工作区级操作入口**（新建会话 / split-merge）随 main-header 删除一并消失~~ → **已落地**：panel-header 同槽位双按钮——split（单 panel 显，开第二会话）+ 新建会话（双 panel 显，替换待机侧）。无工作区级横跨 header（核心原则「每 panel 只有一个 header」）。
- **TaskTree** 过于复杂，初期不做，本稿不含。
- **subagent 并行进度**（Flow 3）：当前 progress-zone 跟单 session。subagent 回来后需升级为多进度聚合。
