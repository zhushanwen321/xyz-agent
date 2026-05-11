# xyz-agent 设计系统

**版本**: 1.0 | **更新日期**: 2026-05-07 | **方向**: Warm & Soft

---

## 一、设计理念

### 核心原则

| 原则 | 含义 | 在 xyz-agent 中的体现 |
|------|------|----------------------|
| **默认极简** | 不需要的东西不展示 | 默认只有左 Session 列表 + 中间对话，无 Tab 栏、无右侧常驻面板 |
| **通知驱动** | 让 Agent 来通知用户，而不是用户去翻找 | Header 通知按钮 + Toast 弹出 + 对话内联系统消息 |
| **渐进展开** | 更深层信息按需展示 | Anchor 下拉切换 SubAgent → 右抽屉展示任务树 → Overview 全局鸟瞰 |
| **数据隔离** | 每个面板 + 它的抽屉是一个完整单元 | 左面板开右抽屉，右面板开左抽屉，抽屉只展示本面板的任务树 |
| **克制** | 一个 accent 颜色，一个装饰性 flourish | Terracotta accent 仅用于激活态、主 CTA、danger 警告 |

### 视觉基调

Warm & Soft — 奶油色暖调背景，衬线体品牌标识，柔和圆角，温润不冷硬。参考 Stripe pre-2020、Mercury、Substack 的视觉感受。不是冰冷的开发者工具，而是**有温度的 AI 工作台**。

---

## 二、Design Tokens

### 2.1 色彩系统

所有颜色使用 OKLch 色彩空间定义，确保感知均匀。

#### 语义色（Light Theme）

| Token | 用途 | 值 | 预览 |
|-------|------|-----|------|
| `--bg` | 页面底色、输入框背景 | `oklch(97% 0.018 70)` | 温暖米白 |
| `--surface` | 卡片/面板/侧边栏/头部底色 | `oklch(99% 0.008 70)` | 近白，略带暖调 |
| `--fg` | 主文本色 | `oklch(22% 0.02 50)` | 深棕黑 |
| `--muted` | 次级文本、时间戳、描述 | `oklch(50% 0.018 50)` | 中灰棕 |
| `--border` | 分隔线、边框 | `oklch(90% 0.014 70)` | 浅暖灰 |
| `--accent` | 主强调色（CTA、激活态、链接） | `oklch(64% 0.13 28)` | 赤陶色 |
| `--accent-light` | accent 的淡色版（hover 背景） | `oklch(92% 0.04 28)` | 淡粉橘 |
| `--success` | 运行中、已完成、连接状态 | `oklch(70% 0.18 145)` | 翠绿 |
| `--success-light` | success 的淡色背景 | `oklch(95% 0.06 145)` | 薄荷白 |
| `--warning` | 暂停、等待确认 | `oklch(78% 0.15 85)` | 琥珀黄 |
| `--warning-light` | warning 的淡色背景 | `oklch(95% 0.06 85)` | 奶黄白 |
| `--danger` | 终止、请求回应、错误 | `oklch(62% 0.2 25)` | 红色 |
| `--danger-light` | danger 的淡色背景 | `oklch(93% 0.06 25)` | 淡红 |

#### 语义色（Dark Theme）

| Token | 值 | 说明 |
|-------|-----|------|
| `--bg` | `oklch(20% 0.015 50)` | 深棕黑底 |
| `--surface` | `oklch(25% 0.015 50)` | 略亮的深色面板 |
| `--fg` | `oklch(92% 0.008 70)` | 近白文本 |
| `--muted` | `oklch(65% 0.015 50)` | 中灰文本 |
| `--border` | `oklch(35% 0.015 50)` | 深灰分隔线 |
| `--accent` | `oklch(68% 0.13 28)` | 稍亮的赤陶色 |
| `--accent-light` | `oklch(30% 0.06 28)` | 深赤陶背景 |
| `--success` | `oklch(70% 0.18 145)` | 同 Light（保证对比度） |
| `--warning` | `oklch(78% 0.15 85)` | 同 Light |
| `--danger` | `oklch(62% 0.2 25)` | 同 Light |

#### 色彩使用规则

1. **accent 仅用于**：发送按钮、激活态 Tab 下划线、链接、Session 列表激活态左边框、锚点下拉当前项。不超过每屏 2 处。
2. **success 用于**：运行中圆点动画、已完成 SubAgent 标记、连接状态。
3. **warning 用于**：暂停状态、简单提问类通知。
4. **danger 用于**：终止按钮 hover、请求回应通知、内联告警消息。
5. **不使用渐变**。不使用 `box-shadow` 作为装饰（仅用于下拉菜单、Toast、Overview 卡片的浮起效果）。

---

### 2.2 字体系统

| Token | 字体栈 | 用途 |
|-------|--------|------|
| `--font-display` | `'Tiempos Headline', 'Newsreader', 'Iowan Old Style', Georgia, serif` | Logo、抽屉标题、Overview 标题、设置页标题 |
| `--font-body` | `-apple-system, BlinkMacSystemFont, system-ui, sans-serif` | 所有 UI 文本、按钮、消息、描述 |
| `--font-mono` | `'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace` | 代码、工具调用、文件路径、模型名、元数据、状态栏 |

#### 字号规范

| 层级 | 大小 | 字重 | 行高 | 场景 |
|------|------|------|------|------|
| H1 / Logo | 16px | 700 | 1.2 | Header logo、设置页标题 |
| H2 / Drawer 标题 | 15px | 600 | 1.3 | 抽屉标题 |
| H3 / 卡片标题 | 13–14px | 600 | 1.4 | Session 卡片标题、done/alert 项目名 |
| Body | 14px | 400 | 1.6 | 消息正文、对话内容 |
| Small | 12–13px | 400 | 1.5 | Session 列表项、Tab、Anchor、按钮文字 |
| Caption | 10–11px | 400–600 | 1.4 | 时间戳、状态、元数据、角色标签、Header 按钮 |
| Overline | 10–11px | 600 | 1.4 | 分组标题、区域标签（`text-transform: uppercase; letter-spacing: 0.04–0.06em`） |
| Mono body | 11–12px | 400 | 1.5 | 工具调用内容、树节点元数据 |
| Code | 10px | 400 | 1.6 | Overview 卡片预览、文件路径 |

#### 字体使用规则

1. **display 仅用于品牌标识和页面标题**——不超过每屏 3 处。
2. **mono 不用于正文段落**——仅用于代码、路径、ID、数值、时间。
3. **overline 层级必须有** `text-transform: uppercase` + `letter-spacing: 0.04em` 以上。

---

### 2.3 间距与圆角

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius` | 12px | 主圆角：消息气泡、输入框容器、Toast、卡片 |
| `--radius-sm` | 8px | 次级圆角：工具调用卡片、done/alert 项、Header 按钮 |
| `--radius-xs` | 4px | 最小圆角：树节点内的按钮、内联回复按钮、toggle 开关 |

#### 间距系统（8px 基础网格）

| 名称 | 值 | 场景 |
|------|-----|------|
| xs | 4px | 图标与文字间距、紧凑元素内边距 |
| sm | 6–8px | 列表项内边距、组间距 |
| md | 10–14px | 消息气泡内边距、面板内边距 |
| lg | 16–20px | 面板外边距、Header 内边距、区域间距 |
| xl | 24–32px | 对话区外边距、设置页内边距 |

---

### 2.4 布局常量

| Token | 值 | 说明 |
|-------|-----|------|
| `--header-h` | 48px | 顶部导航栏高度 |
| `--statusbar-h` | 32px | 底部状态栏高度 |
| `--sidebar-w` | 240px | 左侧 Session 列表宽度 |
| `--drawer-w` | 380px | 右/左侧抽屉宽度 |

---

### 2.5 动画与缓动

| Token | 值 | 用途 |
|-------|-----|------|
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | 全局缓动函数（Material Design standard easing） |

#### 动画时长规范

| 时长 | 用途 |
|------|------|
| 0.1s | 微交互：hover 背景、toggle 状态 |
| 0.15s | 快速过渡：边框颜色、opacity |
| 0.2s | 常规过渡：hover 背景变色 |
| 0.25s | 中等过渡：sidebar 展开/折叠、overview 显隐、toast 显隐 |
| 0.3s | 慢过渡：抽屉滑入/滑出 |
| 0.35s | Toast 入场动画 |
| 0.4s | 进度条宽度变化 |
| 2s | 循环动画：圆点脉冲（pulse-dot） |
| `0.03s × n` 递增 | Overview 卡片交错入场动画（每张卡延迟 30ms） |

---

### 2.6 阴影

| 级别 | 值 | 用途 |
|------|-----|------|
| 微阴影 | `0 1px 6px rgba(0,0,0,0.04)` | 输入框容器默认 |
| 浮起阴影 | `0 2px 12px rgba(0,0,0,0.08)` | 输入框 focus |
| 菜单阴影 | `0 4px 16px rgba(0,0,0,0.08)` | Anchor 下拉、模型选择器 |
| 弹出阴影 | `0 4px 20px rgba(0,0,0,0.1)` | Toast |
| 卡片浮起 | `0 8px 30px rgba(0,0,0,0.15)` | Overview 卡片 hover |
| 遮罩 | `oklch(15% 0.02 50/0.65)` + `blur(20px)` | Overview 背景遮罩 |
| 抽屉遮罩 | `rgba(0,0,0,0.15)` | Drawer overlay |

---

## 三、组件库

### 3.1 App Shell

```
┌─ header (48px, surface bg, border-bottom) ──────────────────┐
│ Logo │ spacer │ notifications │ view buttons │ theme toggle │
├──────┼────────────────────────────────────────────────────────┤
│      │                                                        │
│ side │ main-area (flex: 1)                                    │
│ bar  │                                                        │
│      │                                                        │
├──────┴────────────────────────────────────────────────────────┤
│ statusbar (32px, surface bg, border-top)                      │
└───────────────────────────────────────────────────────────────┘
```

- **sidebar**: `z-index: 55`（高于抽屉的 50，确保左抽屉不覆盖）
- **main-area**: `position: relative`（抽屉在此内部定位）
- **overview**: `position: fixed; z-index: 100`（全局遮罩）
- **toast**: `position: fixed; z-index: 60; top: 60px; left: 20px`

---

### 3.2 Header

| 元素 | 规范 |
|------|------|
| Logo | font-display, 16px, bold, `-agent` 部分用 accent 色 |
| 通知按钮 | 药丸形（`border-radius: 100px`），带绝对定位圆点角标（`top: -4px; right: -4px`） |
| 视图按钮 | 34×34px 方形，`border-radius: 8px`，含 SVG 图标 16×16 |
| 分隔线 | 1px 宽，24px 高，border 色 |
| 主题按钮 | 同视图按钮 |

---

### 3.3 Sidebar（Session 列表）

| 元素 | 规范 |
|------|------|
| 宽度 | 240px（固定，不可拖拽） |
| 分组标题 | 11px, uppercase, letter-spacing 0.04em, muted 色, 带 ▾ toggle |
| Session 项 | 左内缩 24px，带 3px 左边框（激活态为 accent） |
| 状态圆点 | 7×7px，运行中带脉冲动画（2s cycle） |
| 时间标注 | 11px, muted, 右对齐 |

---

### 3.4 Panel Bar（面板顶栏）

替代传统 Tab 栏的轻量化设计。

| 元素 | 规范 |
|------|------|
| 高度 | 36px |
| Anchor | 药丸形，12px bold，带 6px 彩色圆点 + ▾ chevron |
| Anchor 下拉 | 绝对定位，`min-width: 220px`，`z-index: 30`，`box-shadow` |
| 下拉选项 | 12px，当前项加粗 accent 色，hover 显示 accent-light 背景 |
| 内联通知 | 右对齐，药丸形 chip（done 用 success-light，alert 用 danger-light） |
| 关闭按钮 | 文字按钮，`border-radius: 4px`，hover 变 accent |

---

### 3.5 Chat Messages（对话消息）

| 类型 | 对齐 | 背景 | 圆角 | 左边框 |
|------|------|------|------|--------|
| 用户消息 | 右对齐 | accent-light | 12px（右下 4px） | 无 |
| 助手消息 | 左对齐 | surface + border | 12px（左下 4px） | 无 |
| 系统消息（完成） | 全宽 | surface + border | 8px | 3px success |
| 系统消息（告警） | 全宽 | surface + border | 8px | 3px danger |

- 消息最大宽度：80%
- 角色标签：10px, uppercase, letter-spacing 0.04em, muted
- 代码：`<code>` 用 bg 背景 + 4px 圆角

---

### 3.6 Tool Call（工具调用卡片）

| 元素 | 规范 |
|------|------|
| 容器 | border 1px, radius-sm, bg 底色，默认折叠 |
| Header | mono 字体 11px，工具名 accent 加粗，路径 muted，状态右对齐 |
| Chevron | 9px，折叠时旋转 -90deg |
| Body | mono 11px，max-height 160px 可滚动，border-top 分隔 |
| 进度条 | 3px 高，border 底色，accent 填充，`transition: width 0.4s` |

---

### 3.7 Chat Input（输入区域）

上下分区结构，共享背景色：

```
┌──────────────────────────────────────────────┐
│  textarea (默认 2 行，最多 10 行，自适应高度)   │  ← 上区：纯输入
│  placeholder: "输入消息… / 命令"               │
├──────────────────────────────────────────────┤
│ [+] sonnet @ anthropic ▾ │ 上下文 ████░ 34% │ ↑ ■ │  ← 下区：工具栏
└──────────────────────────────────────────────┘
```

| 元素 | 规范 |
|------|------|
| 容器 | margin: 0 16px 12px, border + radius, 微阴影, focus 时阴影加深 |
| Textarea | 无边框，14px body 字体，line-height 1.45, min 2 行, max 10 行 |
| `+` 按钮 | 28×28px 方形，SVG 图标 14px |
| 模型选择器 | mono 11px, `model @ provider` 格式，hover 变 accent |
| 模型下拉 | 从底部弹出（`bottom: 100%`），`z-index: 200`，分区：常用 + 按 Provider 分组 |
| 上下文指示 | mono 11px, 40px 宽进度条，百分比文本 |
| 发送按钮 | 28×28px，accent 背景，白色图标 |
| 停止按钮 | 28×28px，透明背景，bold ■ 字符 |
| Slash 命令 | 绝对定位在输入区上方，mono 命令名 + 描述，支持键盘导航 |

---

### 3.8 Drawer（抽屉）

| 元素 | 规范 |
|------|------|
| 宽度 | 380px |
| 方向 | 右抽屉从右滑入，左抽屉从左滑入 |
| z-index | 50（overlay 40），sidebar 55 确保不被左抽屉遮挡 |
| 定位 | `position: absolute`，相对于 main-area |
| 头部 | display font 15px bold，28px 关闭按钮 |
| Tabs | 3 个：任务树、已完成（+count）、请求回应（+count） |
| 任务树 | 根节点无左侧竖线，子节点 16px 缩进 + 1px 竖线，hover 显示终止按钮 |
| Alert 项 | 左 3px danger/warning 边框，简单问题可直接内联回复，复杂问题显示"查看详情"链接 |
| Done 项 | 左 3px success 边框，标题 + 2 行摘要 + 耗时/Token |

---

### 3.9 Task Tree（任务树）

```
主线对话 (coordinator)
├─ 分析代码结构              1.2k tok    [终止]
├─ 重构模块A                 2.3k tok    [终止]
│  └─ 重构子模块A1           等待确认     [终止]
└─ 编写测试                  pending     [终止]
```

| 元素 | 规范 |
|------|------|
| 根节点 | 无竖线，bold 加粗，coordinator 标记 |
| 子节点 | 16px 缩进，1px 竖线连接（border-left），7px 状态圆点 |
| Hover | 终止按钮出现在最右侧（`display: none` → `inline-flex`） |
| Toggle | 14×14px，8px chevron，折叠时旋转 -90deg |
| 元数据 | mono 10px，右对齐（token 数 / pending / 等待确认） |
| 点击节点 | 关闭抽屉 + 切换到对应 SubAgent 对话 + 更新 Anchor |

---

### 3.10 Overview（Mission Control）

| 元素 | 规范 |
|------|------|
| 背景 | `oklch(15% 0.02 50/0.65)` + `backdrop-filter: blur(20px)` |
| 布局 | 3 列 grid，gap 20px，max-width 960px |
| 卡片入场 | `translateY(20px) scale(0.95)` → 原位，交错延迟 30ms/张 |
| 卡片预览 | 110px 高，mono 10px，4 行最近对话摘要 |
| 卡片标题 | 13px bold，带状态 Badge（药丸形，小圆点 + 文字） |
| 卡片元数据 | 10px muted，显示模型、Token、SubAgent 状态摘要 |
| 键盘导航 | 方向键选择，Enter 进入，Shift+Enter 分屏进入，Esc 返回 |
| 高亮态 | accent 边框 + 外发光 `box-shadow: 0 0 0 3px oklch(64% 0.13 28/0.4)` |

---

### 3.11 Toast（通知弹出）

| 元素 | 规范 |
|------|------|
| 位置 | 左上角，`top: 60px; left: 20px` |
| 宽度 | 340px |
| 入场 | 从左侧滑入 `translateX(-120%)` → `translateX(0)`，0.35s |
| 退场 | 滑回左侧，0.25s |
| 自动消失 | 8 秒后自动退场 |
| 内容 | 8px 彩色圆点 + 标题（13px bold）+ 描述（12px muted） |
| 操作按钮 | 回复（accent 主按钮）+ 稍后 + 忽略（ghost 按钮） |

---

### 3.12 Status Bar（底部状态栏）

| 元素 | 规范 |
|------|------|
| 高度 | 32px |
| 内容 | 连接状态圆点 + 工作目录 + Git 分支 + 模型 + Token 消耗 |
| 右侧 | 快捷键提示（低 opacity） |
| 专注模式 | 隐藏 |

---

### 3.13 Settings View（设置视图）

| 元素 | 规范 |
|------|------|
| 布局 | 左侧 Tab（200px）+ 右侧内容区 |
| Tab | 3 个：供应商、SKILL、AGENT |
| 供应商卡片 | 卡片式，名称 + 连接状态（药丸 badge）+ 可用模型列表 |
| SKILL 行 | 名称 + 描述 + toggle 开关（36×20px，accent 色） |
| Agent 卡片 | 名称 + 模型 + 参数行（info-row：label mono value） |
| 触发 | Header 齿轮按钮 或 `Cmd+,` |

---

## 四、视图状态机

### 4.1 主视图

| 视图 | Sidebar | Panel | 状态栏 | 快捷键 |
|------|---------|-------|--------|--------|
| 标准 | 显示 | 单 Panel A | 显示 | `Cmd+1` |
| 分屏 | 显示 | Panel A + B | 显示 | `Cmd+2` |
| 专注 | 隐藏 | 单 Panel A，max-width 720px | 隐藏 | `Cmd+3` |
| 设置 | 显示 | 设置视图 | 显示 | `Cmd+,` |

### 4.2 Overlay 层级

| z-index | 内容 |
|---------|------|
| 20 | Header |
| 30 | Anchor 下拉 |
| 40 | Drawer overlay |
| 50 | Drawer |
| 55 | Sidebar（确保不被左抽屉遮挡） |
| 60 | Toast |
| 100 | Overview 遮罩 |
| 200 | 模型选择器下拉 |

---

## 五、交互规范

### 5.1 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+1` | 标准模式 |
| `Cmd+2` | 分屏模式 |
| `Cmd+3` | 专注模式 |
| `Cmd+J` | Mission Control 总览 |
| `Cmd+,` | 设置视图 |
| `Cmd+W` | 关闭分屏（分屏模式下） |
| `Esc` | 关闭抽屉 → 关闭分屏 → 回到标准模式 |
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `/` | 打开 Slash 命令菜单 |
| `↑` `↓` | Slash 命令菜单中选择 / Overview 中选择卡片 |
| `←` `→` | Overview 中选择卡片 |

### 5.2 通知层级

| 层级 | 触发 | 表现 | 用户动作 |
|------|------|------|---------|
| Header 角标 | SubAgent 状态变化 | 数字角标（已完成/请求回应） | 点击 → 打开抽屉 |
| Panel 内联通知 | 分屏模式下当前面板的 SubAgent 事件 | 面板顶栏的 chip | 点击 → 打开对应方向抽屉 |
| Toast | SubAgent 主动请求用户回答 | 左上角弹出卡片 | 回复/稍后/忽略 |
| 对话内联消息 | SubAgent 完成或暂停 | 系统消息样式（左边框） | 点击"查看结果"/"立即回复" |

### 5.3 抽屉方向规则

| 面板 | 抽屉方向 | 原因 |
|------|---------|------|
| Panel A（左） | 右抽屉 | 不遮挡 Panel B |
| Panel B（右） | 左抽屉 | 不遮挡 Panel A |
| 标准模式（全局） | 右抽屉 | 默认向右 |
| Sidebar | 不被遮挡 | `z-index: 55` > 抽屉的 50 |

---

## 六、文案规范

### 6.1 语言

- 界面文案统一使用**中文**
- 技术术语保持英文：model、provider、token、SubAgent、session
- 代码/文件路径使用等宽字体英文

### 6.2 标准文案

| 场景 | 文案 |
|------|------|
| 输入框 placeholder | `输入消息… (Enter 发送, Shift+Enter 换行, / 命令)` |
| 新建按钮 | `+` |
| 关闭分屏 | `关闭` |
| 发送 | `↑` 图标 |
| 停止 | `■` 字符 |
| 上传文件 | 铅笔/回形针图标 |
| 状态-运行中 | 绿色圆点（无文字） |
| 状态-暂停 | 黄色圆点 |
| 状态-闲置 | 灰色圆点 |
| 系统消息-完成 | `SubAgent「{name}」已完成` |
| 系统消息-告警 | `SubAgent「{name}」需要确认` |
| Toast 操作 | `回复` / `稍后` / `忽略` |
| Toast-稍后 | 角标保留，不打扰 |
| Overview 标题 | `窗口总览` |
| Overview 提示 | `Enter 进入 · Shift+Enter 分屏进入 · ← → 选择 · Esc 返回` |
| 设置 Tab | `供应商` / `SKILL` / `AGENT` |
| 状态栏 | `已连接 · ~/path · branch · model · tokens` |

---

## 七、文件结构

```
xyz-agent/
├── index.html                 ← 完整原型（内联 CSS + JS，可直接预览）
├── css/
│   └── design-system.css      ← 拆分后的独立 CSS 文件
├── js/
│   └── app.js                 ← 拆分后的独立 JS 文件（待创建）
├── views/
│   ├── standard.html          ← Panel A + Panel B + Drawer HTML
│   ├── settings.html          ← 设置视图 HTML
│   ├── overview.html          ← Mission Control HTML
│   └── drawers.html           ← 左右抽屉 HTML
└── docs/
    ├── DESIGN-SYSTEM.md       ← 本文档
    └── PROTOTYPE-GUIDE.md     ← 原型交互指南
```

---

## 八、可访问性

- 所有可交互元素有 `cursor: pointer` 和 `transition`
- Focus 状态：输入框 `border-color: accent`，按钮 `background: accent-light`
- 状态圆点动画：脉冲频率 2s，`opacity: 0.35` 最低值保证可见性
- 对比度：Dark theme 的 `--fg` 与 `--bg` 比值 > 7:1
- 选中色：`::selection` 使用 accent + white
- 抗锯齿：`-webkit-font-smoothing: antialiased`

---

## 九、扩展与维护

### 新增视图
1. 在 `views/` 下创建 HTML 文件
2. 在 `css/design-system.css` 中添加对应的视图样式
3. 在 `js/app.js` 中注册视图切换逻辑
4. 如需 Header 按钮，添加 `.h-btn` 元素并绑定 `setView('view-name')`

### 新增组件
1. 使用 BEM 命名：`.block__element--modifier`
2. 颜色必须引用 CSS 变量，禁止硬编码
3. 圆角必须引用 `--radius` / `--radius-sm` / `--radius-xs`
4. 过渡动画使用 `--ease` 缓动函数

### 新增语义色
1. 定义主色 + light 版本（用于背景 tint）
2. 同时在 Light 和 Dark 的 `:root` 中定义
3. 确保主色与 `--bg` / `--surface` 的对比度 ≥ 3:1
