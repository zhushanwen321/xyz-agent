# xyz-agent 设计方向

> 基于：竞品分析 + 设计方法论研究 + 用户需求澄清
> 日期：2026-05-10

---

## 一、产品定位

xyz-agent 是一个 AI Agent 桌面工作台，核心差异是 **SubAgent 并行执行的可视化**。

设计方向：**默认极简，按需展开**。

- 默认界面像 Codex 一样干净（只有 sidebar + chat + statusbar）
- SubAgent 信息通过 Drawer 按需弹出
- 任务树是特点功能，但也是按需弹出

### 目标用户的使用场景

> 开发者在多个屏幕上同时处理多个任务。每个屏幕两列窗口，并行工作。

这意味着设计必须：
1. **单窗口足够完整**：一个窗口就能完成所有操作（sidebar + chat + drawer）
2. **多窗口互不干扰**：每个窗口可以独立绑定不同 session
3. **紧凑但不拥挤**：两列并排时每个窗口约 700-900px 宽

---

## 二、主题策略

### 暗色为默认

理由：
- 开发者工具用户主流偏好暗色（Claude Code / Codex / Cursor 都是暗色默认）
- 长时间使用不疲劳
- 暗色背景上代码高亮更醒目

### 亮色完整支持

不是反色，而是独立调色的 Light 变体。保持 OKLCH 暖色调。

### 自定义主题

支持 5 种预设 accent 色（通过 `data-accent` 属性切换）：

| Accent | 色值 | 气质 |
|--------|------|------|
| Terracotta（默认） | oklch(68% 0.13 28) | 温暖、独特、有辨识度 |
| Rose | oklch(70% 0.14 350) | 柔和、现代、区别于蓝紫色 |
| Amber | oklch(72% 0.15 65) | 明亮、活力、适合需要高能量的用户 |
| Blue | oklch(68% 0.15 250) | 经典、熟悉、开发者认知负担最低 |
| Violet | oklch(68% 0.15 280) | 高端、差异化、Linear 风格 |

参考 demo：`docs/templates/dark-theme-options.html`

### 暗色主题三原则

1. **三级背景**：bg(15%) → surface(22%) → border(30%)，每级间距 ≥7%
2. **不用纯黑**：所有中性色带微弱色相（hue 50 暖调 或跟随 accent 色相）
3. **边框隐形**：边框足够暗（接近 bg），surface 分隔靠亮度差而非边框

---

## 三、窗口架构

### 方案：混合模式（主窗口 + 可 pop-out 的子窗口）

```
主窗口（默认）
├── Header: logo + 4-5 个精简按钮
├── Sidebar: session 列表（220px）
├── Chat: 当前活跃 session
├── Drawer: 任务树（按需弹出）
└── Statusbar: 连接状态 + 模型名

子窗口（从主窗口 pop-out）
├── 简化 Header: session 标题 + 关闭按钮
├── 无 Sidebar
├── Chat: 绑定特定 session
├── Drawer: 任务树（按需弹出）
└── 无 Statusbar（或精简版）
```

### 交互方式

- 主窗口 sidebar 右键 session → "在新窗口中打开"
- 子窗口关闭不影响主窗口和其他子窗口
- 主窗口关闭时弹出确认（如果有子窗口在运行）
- 子窗口可以通过拖拽标签栏回到主窗口（未来）

### 默认窗口尺寸

| 窗口类型 | 尺寸 | 启动行为 |
|---------|------|---------|
| 主窗口 | 1200×800 | **窗口模式启动**（不 maximize） |
| 子窗口 | 900×700 | 窗口模式 |
| 设置窗口 | 900×700 | 窗口模式 |

用户两列并排时每个窗口约 700-900px，所以主窗口默认不最大化。

---

## 四、界面层次

### 从外到内：4 层结构

```
┌─ Header (48px) ──────────────────────────────────────────┐
│  logo    [bell] [grid] [view] [settings] [theme]          │  ← 5 个按钮
├──────────┬───────────────────────────────────────────────┤
│ Sidebar  │  Panel Bar (36px)                              │
│ (220px)  │  ├─ anchor dropdown                            │
│          │  ├─ [done chip] [alert chip]                    │
│ session  │─────────────────────────────────────────────── │
│ list     │  Chat Messages                                 │  ← max-width 800px 居中
│          │  ├─ user bubble (accent bg, white text)         │
│ grouped  │  ├─ bot message (transparent bg)                │
│ by cwd   │  ├─ tool call card (surface bg, accent name)   │
│          │  └─ system message (semantic color border)      │
│          │                                                 │
│          │─────────────────────────────────────────────── │
│          │  Input (textarea + model label + send btn)      │  ← 单行，无 toolbar
├──────────┴───────────────────────────────────────────────┤
│ Statusbar (28px)                                          │
│  ● Connected  ·  deepseek-v3                              │  ← 只保留 2 项
└──────────────────────────────────────────────────────────┘
```

### Drawer（按需弹出）

从右侧滑出，宽 380px：

```
┌─ Drawer ──────────────────┐
│  [Tasks] [Done] [Alerts]   │  ← tab 切换
│────────────────────────────│
│  Task Tree                 │
│  ├─ refactor-auth          │
│  │  ├─ analyze ✓           │
│  │  ├─ edit interfaces ◉   │  ← ◉ = running
│  │  └─ write tests         │
│  └─ db-migration           │
└────────────────────────────┘
```

---

## 五、视觉设计规则

### 排版（4 级足够）

| 层级 | 字号 | 字重 | 用途 |
|------|------|------|------|
| Display | 16px | 700 | Logo（serif） |
| Body | 14px | 400 | 消息正文 |
| Small | 12-13px | 400-500 | sidebar 项、panel bar、按钮 |
| Caption | 10-11px | 600 | 角色标签、时间戳、mono 内容 |

不再区分 Title / Headline / Overline 等更多层级。4 级够了。角色标签从 uppercase 改为正常大小写。

### 间距（8px 基数）

| 元素 | 间距 |
|------|------|
| 消息之间 | 14px |
| 消息内 padding | 12px 16px |
| 工具调用 margin | 8px 0 |
| 工具调用 body padding | 8px 10px |
| 聊天区 padding | 20px 24px |
| sidebar 项 padding | 7px 14px 7px 24px |

### 动画

- 统一 200ms ease-out
- 禁止 bounce / elastic
- 尊重 prefers-reduced-motion
- 只用于状态转换（hover、展开收起、drawer 滑入），不用于装饰

### 消息气泡

- **用户**：accent 色背景 + 白色文字，右对齐，max-width 75%
- **助手**：透明背景，左对齐，全宽
- **系统消息**：semantic 色边框 + light 背景，全宽
- **角色标签**：正常大小写（不 uppercase），10px，600 weight

---

## 六、信息密度控制

### 默认极简

| 元素 | 默认 | 按需 |
|------|------|------|
| 任务树 | 隐藏 | 点击 panel bar chip 或快捷键打开 Drawer |
| SubAgent 状态 | 不在主界面显示 | Drawer 中查看 |
| 通知 | Header 一个铃铛图标 | 点击打开 Drawer |
| Token 使用量 | 不显示 | 未来可在 Drawer 或 tooltip 中 |
| 工作目录 | sidebar 分组头显示 | 不在 statusbar 重复 |
| Git 分支 | 不显示 | 未来可在 tooltip 中 |

### 同屏决策项控制

每个区域同时可见的可交互元素不超过 7 个：
- Header: 5 个按钮
- Panel bar: anchor + 2 个 chip = 3 个
- Sidebar: 每个可见分组 3-5 个 session
- 输入框: model label + send button = 2 个

---

## 七、实施优先级

### P0 — 立即（视觉基础）

已完成：
- [x] 暗色主题三级背景
- [x] 侧边栏降噪（静态圆点、去掉色条）
- [x] Header 精简（通知合并、视图合并）
- [x] 用户消息 accent 色背景
- [x] 输入框精简（去掉加号和上下文条）
- [x] Statusbar 精简

### P1 — 近期（核心体验）

- [ ] 角色标签从 uppercase 改为正常大小写
- [ ] 窗口默认不最大化（去掉 win.maximize()）
- [ ] 暗色主题 accent 可切换（5 种预设）
- [ ] pop-out 子窗口功能
- [ ] 空状态改为提问式引导

### P2 — 中期（体验提升）

- [ ] 工具调用增加执行时间显示
- [ ] 窄宽适配（sidebar 折叠到 48px icon-only）
- [ ] 消息间距根据相邻类型动态调整
- [ ] 快捷键提示出现在相关操作 hover 时

### P3 — 远期（锦上添花）

- [ ] 自定义主题编辑器
- [ ] 窗口 tab 拖拽回主窗口
- [ ] Mission Control 全局鸟瞰优化

---

## 参考文档

- [竞品 UI 分析](competitor-ui-analysis.md)
- [UI/UX 设计原则与参考](ui-design-principles-and-references.md)
- [暗色主题选项 demo](dark-theme-options.html)
