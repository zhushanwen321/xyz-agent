---
verdict: draft
---

# Chat Area — 消息发送模式与队列展示设计

## Background

当前聊天区域的发送功能存在三个缺口：

1. **发送模式的发现与反馈断层**：三种发送模式（普通 Send / Steer / Follow-up）只靠键盘修饰符切换，缺乏直观的视觉提示。消息发出后，发送模式的身份（"这条是 steer 还是 follow-up？"）完全消失，用户无法从消息列表中回溯。

2. **Pi 端排队消息不可见**：pi 内部维护 `steering[]` 和 `followUp[]` 两套队列，并通过 `message.queue_update` 事件实时推送给前端。但当前前端未展示任何队列状态。用户发送 follow-up 消息后，无法确认消息是"已排队等待"还是"丢失了"。

3. **AI 执行状态缺少统一锚点**：AI 的处理阶段（thinking / tool calling / generating text）分散在各消息组件内部，用户需要扫描整个消息流才能拼凑出"AI 当前在做什么"。缺少一个固定的、全局可感知的状态指示器。

本次设计解决这三个问题，不涉及底层架构重构。

## Design Goals

1. 让用户**在发送前**清晰感知当前发送模式，并可通过鼠标或键盘自由切换
2. 让用户**在发送后**能从消息气泡上识别该消息是以什么模式发出的
3. 让用户**实时看到** pi 端排队消息的状态（steer / follow-up pending）
4. 提供一个**全局、轻量、不侵入**的 AI 执行状态指示器
5. 所有文案支持 i18n

## Functional Requirements

### FR1: Mode Switcher（发送模式选择器）

输入框下方工具栏中的三段式按钮组件，替代当前的 `SendModeStatusBar`。

```
[ Send | Steer | Follow-up ]  [Model] [Thinking ▴] [▌32%]  [↑12.4k/↓3.2k]  [↑发送]
```

- 三段按钮可点击切换，`Send` 为默认
- 当前选中模式使用 `--accent` 色实心背景高亮
- 每段按钮显示对应的键盘快捷提示（⏎ / ⌘⏎ / ⌥⏎）
- **键盘快捷键仍然有效**：Enter=Send、Ctrl/Cmd+Enter=Steer、Alt+Enter=Follow-up，按下时 UI 同步高亮对应按钮
- 模式切换同步影响发送按钮的 `sendMode` 参数

#### 三种模式的定义

| 模式 | 触发 | 后端 WS 消息 | AI 忙碌时行为 |
|------|------|--------------|-------------|
| **Send** | Enter / 点击 Send | `message.send` | 直接发送，pi 内部决定排队行为 |
| **Steer** | Ctrl+Enter / 点击 Steer | `message.steer` | 先 abort 当前生成，再处理本条消息 |
| **Follow-up** | Alt+Enter / 点击 Follow-up | `message.follow_up` | 排入 pi 的 `_followUpMessages[]`，等当前执行完再处理 |

### FR2: Send Chips（消息发送模式标识）

用户消息气泡的时间戳旁显示微型 chip，标识发送模式：

- **普通 Send**：不显示 chip
- **Steer**：橙黄色 `steer` chip（`--warning` 色系）
- **Follow-up**：蓝绿色 `follow-up` chip（`--agent` 色系）

```
  steer · 14:25                  用户
┌──────────────────────────┐
│ 等一下，先看看 src/       │
│ stores/ 下面的文件         │
└──────────────────────────┘
```

### FR3: Interrupted Marker（已中断标记）

被 steer 打断的 AI 消息底部显示中断标记：

```
  ┌─────────────────────────┐
  │ 这个项目使用了 Vue 3... │
  └─────────────────────────┘
        ──── 已中断 ────
```

- 被中断消息整体 opacity 降低至 0.65
- 文字 `已中断` 居中，两侧带等长横线
- 使用 `--muted` 色，不抢夺注意力

### FR4: Queue Component（消息队列组件）

位于 ChatInput 上方、Global Loading Bar 下方的固定区域，用于展示 pi 端排队中的消息。

**数据源**： `chatStore.queueState`（由 `message.queue_update` 事件更新）

```
┌─────────────────────────────────────────────────┐
│ ☰ 队列: 2 条待处理                    [清除]    │ ← header
├─────────────────────────────────────────────────┤
│  [follow-up] 然后也看看 tools/ 目录下有...  ◌    │ ← 排队项
│  [steer]     检查一下 vite.config.ts 配置  ◌      │
│                                    [Widget ⚡] │ ← plugin widget 标签
└─────────────────────────────────────────────────┘
```

**布局规则**：
- 宽度由 `queue-inner` 约束，与输入框保持一致（`max-width: 960px; margin: 0 auto; padding: 0 24px`）
- 背景 `--surface` 色，与输入框背景一致
- header 显示队列状态 + 消息总数 + 清除按钮
- 每条排队消息显示：
  - 类型 badge（`steer` / `follow-up`），用对应语义色
  - 消息内容预览（单行省略）
  - 等待状态指示（pulsing dot）
- 队列为空时整个组件高度归零（`height: 0; overflow: hidden`）

**消息流转**：
1. 用户发送 follow-up 消息 → pi 排入 `_followUpMessages[]` → `queue_update` 推给前端 → 消息出现在 Queue Component
2. pi 处理完当前任务 → 处理排队消息 → `queue_update` 更新 → 消息从队列移除
3. 消息从队列移出后，出现在消息流中作为普通用户消息（带 Send Chip 标识它是 follow-up）
4. 队列全部处理完后显示绿色 `队列已完成` banner

**i18n**：所有标签使用 `data-i18n` 属性，提供中英文参考映射。

#### WidgetDock 的关系

Queue Component 与 WidgetDock 共用一个区域。Queue 有消息时，WidgetDock 小标签置于 queue list 尾部（右对齐）；Queue 为空时 WidgetDock 正常展示。两者不重叠。

### FR5: Global Loading Bar（全局加载指示条）

ChatInput 顶部、Queue Component 上方的一条 3px 高的薄条，作为 AI 执行状态的全局锚点。

- **AI 执行中**：`--accent` 色渐变条从左到右/从右到左连续扫动
- **AI 空闲时**：高度归零，不可见
- 不依赖各内部组件的 loading 动画（ThinkingBlock pulse / ToolCallCard spinner 保留不动）
- 使用 `prefers-reduced-motion`：关闭动画，改为静态半透明条

## Non-functional Requirements

### i18n

所有用户可见标签需支持国际化。使用 `data-i18n` 属性标识 key：

| Key | 中文 | English |
|-----|------|---------|
| `mode.send` | 发送 | Send |
| `mode.steer` | 中断发送 | Steer |
| `mode.followup` | 排队发送 | Follow-up |
| `chip.steer` | steer | steer |
| `chip.followup` | follow-up | follow-up |
| `section.steer` | steer 模式 | steer mode |
| `section.followup` | follow-up 模式 | follow-up mode |
| `interrupted` | 已中断 | Interrupted |
| `queue.pending` | N 条消息待处理 | N pending |
| `queue.badge.steer` | steer | steer |
| `queue.badge.followup` | follow-up | follow-up |
| `queue.waiting` | 等待中 | Waiting |
| `queue.pending` | 待处理 | Pending |
| `queue.done` | 队列已完成 · N 条已处理 | Queue completed · N done |
| `queue.clear` | 清除 | Clear |

### Accessibility

- Mode Switcher 按钮使用原生 `<button>`，可通过 Tab 键聚焦
- Queue 列表项使用 `role="listitem"` + `aria-label`
- Send Chips 提供 `aria-label` 说明发送模式
- Global Loading Bar 使用 `aria-hidden="true"` 避免干扰屏幕阅读器
- 所有状态变化适配 `prefers-reduced-motion`

## Constraints

- 设计系统：必须遵循 `style.css` 的 CSS 变量体系（Warm & Soft 主题），不使用硬编码颜色
- 组件库：使用 xyz-ui/design-system 组件，不新增原生 HTML 表单元素（Mode Switcher 按钮除外，它需要特殊的行内尺寸控制）
- 状态管理：QueueState 已存在于 `chatStore`，复用现有 `setQueueState` 方法
- WS 协议：`message.steer` / `message.follow_up` / `message.queue_update` 路由和事件处理已存在，本次仅做前端 UI
- 发送按钮形态不变：空闲时 accent 背景 ↑ 按钮，流式时红色 ■ stop 按钮
- 无 Emoji：所有图标使用 inline `<svg>`

## Out of Scope

- 修改 ThinkingBlock / ToolCallCard 等小组件的 loading 样式（保留现有动画）
- 队列消息的重新排序 / 编辑 / 删除（仅清除全部）
- 队列消息的持久化（刷新后队列丢失，由 pi 端行为决定）
- 发送历史（↑ 恢复上一条消息）
- 键盘快捷键的自定义配置

## Relationship to Existing Features

| 现有组件 | 关系 |
|---------|------|
| `SendModeStatusBar.vue` | 被 Mode Switcher 替代，删除此组件 |
| `WidgetDock.vue` | 与 Queue Component 共享区域，优先级：queue > widget |
| `ChatInput.vue` | 集成 Mode Switcher，send 事件参数新增模式信息 |
| `MessageBubble.vue` | 新增 Send Chip 渲染 + Interrupted Marker |
| `AssistantContent.vue` | 新增被中断状态的视觉处理 |
| `chatStore.queueState` | 新增 UI 消费方（Queue Component） |
| `InputToolbar.vue` | Mode Switcher 插入工具栏最左侧 |

## Key Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| Mode Switcher 位置 | 工具栏左侧，非输入框上方 | 与发送按钮同一视觉层级，减少上下扫视 |
| Send Chip 位置 | 时间戳旁，消息气泡外 | 遵循现有时间戳布局，不改变消息气泡尺寸 |
| Queue 宽度 | 与输入框一致（`max-w-[960px] mx-auto px-6`） | 视觉对齐，用户明确要求 |
| Global Loading Bar 位置 | ChatInput 顶部，全宽 | 始终在视口底部附近，不抢占消息区域空间 |
| Queue 外围背景 | 全宽 `--surface`，内容缩进 | header 背景色贯穿，与消息区/输入区形成三个清晰的横向分区 |
| Steer/Follow-up 术语 | 保留英文原文作为 chip 文字 | 用户习惯术语，i18n 翻译后可能太长；chip 处用英文，tooltip 提供中文说明 |

## Acceptance Criteria

| # | 条件 | 验证方式 |
|---|------|---------|
| AC1 | Mode Switcher 三种模式可点击切换，UI 实时反映 | 手动测试 |
| AC2 | Ctrl+Enter 触发的 steer 模式视觉高亮 Steer 按钮 | 手动测试 |
| AC3 | Alt+Enter 触发的 follow-up 模式视觉高亮 Follow-up 按钮 | 手动测试 |
| AC4 | Steer 消息气泡显示 `steer` chip | 检查消息列表 |
| AC5 | Follow-up 消息气泡显示 `follow-up` chip | 检查消息列表 |
| AC6 | 被 steer 打断的 AI 消息显示 `— 已中断 —` 标记 | 手动测试 |
| AC7 | Queue Component 在队列有消息时显示，空时消失 | 手动测试 |
| AC8 | Queue 中的消息正确标记 steer/follow-up | 检查 UI |
| AC9 | 队列消息被处理后从队列移除，出现在消息流中 | 手动测试端到端 |
| AC10 | Global Loading Bar 在 AI 执行时动画，空闲时隐藏 | 视觉检查 |
| AC11 | `prefers-reduced-motion` 关闭所有动画 | 设置检查 |
| AC12 | 所有文案通过 `data-i18n` 支持切换语言 | 代码检查 |
