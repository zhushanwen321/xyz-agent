---
verdict: reviewed
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

升级现有的 `SendModeStatusBar` 组件，增加点击切换交互，替代三段式按钮方案。

```
输入框上方：
Send · Enter

点击后 popover：
┌─────────────────────┐
│ ● Send        ⏎     │
│   Steer       ⌘⏎    │
│   Follow-up   ⌥⏎    │
└─────────────────────┘
```

工具栏行（不变）：
```
[Model] [Thinking ▴] [▌32%]  [↑12.4k/↓3.2k]  [↑发送]
```

**设计原则**：Send 占 ~90% 使用率。不需要三种模式同等视觉权重。默认状态是一行轻量文字（与当前 `SendModeStatusBar` 一致），需要切换时点击展开 popover。

**交互行为**：
- 输入框上方显示当前模式文字 + 快捷键提示（与现有 `SendModeStatusBar` 相同位置和样式）
- 点击文字区域展开一个底部向上的小型 popover，列出三种模式
- popover 中当前模式显示圆点标记（●），其他模式无圆点
- popover 中每项显示模式名 + 快捷键提示
- 选中后 popover 关闭，文字更新为新模式 + 对应快捷键
- **键盘快捷键仍然有效**：Enter=Send、Ctrl/Cmd+Enter=Steer、Alt+Enter=Follow-up，按下时文字同步更新
- 切换到 Steer 时文字变为 accent 色（`text-accent`），Follow-up 变为 warning 色（`text-warning`），Send 保持 muted
- 模式切换同步影响发送按钮的 `sendMode` 参数

**Popover 样式**：
- 背景 `--surface`，1px `--border` 边框，`shadow-md`
- 底部对齐，紧贴文字区域下方
- 每项高度 28px，左对齐模式名，右对齐快捷键
- 点击外部关闭（click-outside）

**窄面板（<520px）行为**：
- 文字区域缩短，只显示当前模式名（不显示快捷键提示）
- Popover 功能不变

#### 三种模式的定义

| 模式 | 触发 | 后端 WS 消息 | AI 忙碌时行为 |
|------|------|--------------|-------------|
| **Send** | Enter / 点击 Send | `message.send` | 直接发送，pi 内部决定排队行为 |
| **Steer** | Ctrl+Enter / 点击 Steer | `message.steer` | 排入 pi 的 `_steeringMessages[]`，在当前 turn 的工具调用间隙注入 |
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

被用户显式 abort（点击停止按钮或 `message.abort`）的 AI 消息底部显示中断标记：

```
  ┌─────────────────────────┐
  │ 这个项目使用了 Vue 3... │
  └─────────────────────────┘
        ──── 已中断 ────
```

- 被中断消息整体 opacity 降低至 0.65
- 文字 `已中断` 居中，两侧带等长横线
- 使用 `--muted` 色，不抢夺注意力

**数据来源**：pi 的 `message.complete` 事件中 `stopReason === 'aborted'` 标识消息被中断。前端 `onComplete` 需读取此字段并存入消息数据（`isInterrupted: stopReason === 'aborted'`）。

**注意**：改用 pi 原生 steer RPC 后，steer 不再 abort 当前 turn，而是在工具调用间隙注入新消息。因此 Interrupted Marker 只适用于显式 abort 场景。

### FR4: Queue Component（消息队列组件）

位于 ChatInput 上方、Global Loading Bar 下方的固定区域，用于展示 pi 端排队中的消息。

**数据源**： `chatStore.queueState`（由 `message.queue_update` 事件更新）

```
┌─────────────────────────────────────────────────┐
│ ☰ 队列: 2 条待处理                               │ ← header
├─────────────────────────────────────────────────┤
│  [follow-up] 然后也看看 tools/ 目录下有...  ◌    │ ← 排队项
│  [steer]     检查一下 vite.config.ts 配置  ◌      │
│                                    [Widget ⚡] │ ← plugin widget 标签
└─────────────────────────────────────────────────┘
```

**布局规则**：
- 宽度由 `queue-inner` 约束，与输入框保持一致（`max-width: 960px; margin: 0 auto; padding: 0 24px`）
- 背景 `--surface` 色，与输入框背景一致
- header 显示队列状态 + 消息总数（**无清除按钮**，pi RPC 不支持 `queue_clear`）
- 每条排队消息显示：
  - 类型 badge（`steer` / `follow-up`），用对应语义色
  - 消息内容预览（单行省略，最大宽度约束确保 badge + 文本不超出容器）
  - 等待状态指示（pulsing dot）
- 队列为空时整个组件高度归零（`height: 0; overflow: hidden`），使用 `transition: height 150ms var(--ease)` 平滑收起
- 队列展开/收起不改变 WidgetDock 的位置（WidgetDock 始终在 Queue 正下方）
- 队列最多显示 5 条消息，超出部分显示 `+N 更多`

**消息流转**：
1. 用户发送 follow-up 消息 → pi 排入 `_followUpMessages[]` → `queue_update` 推给前端 → 消息出现在 Queue Component
2. pi 处理完当前任务 → 处理排队消息 → `queue_update` 更新 → 消息从队列移除
3. 消息从队列移出后，出现在消息流中作为普通用户消息（带 Send Chip 标识它是 follow-up）
4. 队列全部处理完后显示绿色 `队列已完成` banner，3 秒后自动消失

**i18n**：所有标签使用 `data-i18n` 属性，提供中英文参考映射。

#### WidgetDock 的关系

Queue Component 与 WidgetDock 共用一个区域，但 **WidgetDock 始终固定在 Queue 下方**，不随队列状态移动位置：

```
┌─ Global Loading Bar (3px) ─────────────────────────┐  ← 全宽
├─ Queue Component ─────────────────────────────────┤  ← 仅队列有消息时可见
│  [follow-up] 消息预览...  ◌                       │
│  [steer]     消息预览...  ◌                       │
├─ WidgetDock ──────────────────────────────────────┤  ← 始终在此位置
│  [Widget ⚡]                                       │
├─ ChatInput ──────────────────────────────────────┤  ← 输入框
│  ...                                              │
└──────────────────────────────────────────────────┘
```

- Queue 为空时，Queue Component 高度归零，WidgetDock 紧贴 Loading Bar 下方
- Queue 有消息时，Queue 展开在 Loading Bar 和 WidgetDock 之间
- WidgetDock 永远不跳变位置，不管队列状态如何
- 窄面板下，Queue 退化为 inline badge，WidgetDock 位置仍不变

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
| `mode.send` | 发送 | Send | Popover 选项 |
| `mode.steer` | 中断发送 | Steer | Popover 选项 |
| `mode.followup` | 排队发送 | Follow-up | Popover 选项 |
| `chip.steer` | steer | steer |
| `chip.followup` | follow-up | follow-up |
| `interrupted` | 已中断 | Interrupted |
| `queue.pendingCount` | {N} 条消息待处理 | {N} pending | Queue header |
| `queue.badge.steer` | steer | steer | Queue badge |
| `queue.badge.followup` | follow-up | follow-up | Queue badge |
| `queue.waiting` | 等待中 | Waiting | Pulsing dot tooltip |
| `queue.itemPending` | 待处理 | Pending | 单个队列项状态 |
| `queue.done` | 队列已完成 · {N} 条已处理 | Queue completed · {N} done | Banner（3s auto-dismiss） |

### Accessibility

- Mode Switcher popover 触发区域使用原生 `<button>`（含 `aria-haspopup="listbox"` + `aria-expanded`），可通过 Tab 键聚焦
- Popover 内容使用 `role="listbox"`，每项使用 `role="option"` + `aria-selected`
- Queue 列表项使用 `role="listitem"` + `aria-label`
- Send Chips 提供 `aria-label` 说明发送模式
- Global Loading Bar 使用 `role="status"` + `aria-live="polite"`（非 `aria-hidden`），确保屏幕阅读器可感知 AI 状态
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
- 队列消息的重新排序 / 编辑 / 删除
- 队列消息的持久化（刷新后队列丢失，由 pi 端行为决定）
- 发送历史（↑ 恢复上一条消息）
- 键盘快捷键的自定义配置

## Relationship to Existing Features

| 现有组件 | 关系 |
|---------|------|
| `SendModeStatusBar.vue` | 被 Mode Switcher 升级替代，保留组件文件但重构交互 |
| `WidgetDock.vue` | 与 Queue Component 共享区域，优先级：queue > widget |
| `ChatInput.vue` | 集成 Mode Switcher，send 事件参数新增模式信息 |
| `MessageBubble.vue` | 新增 Send Chip 渲染 + Interrupted Marker |
| `AssistantContent.vue` | 新增被中断状态的视觉处理 |
| `chatStore.queueState` | 新增 UI 消费方（Queue Component） |
| `InputToolbar.vue` | Mode Switcher 不在工具栏内（在输入框上方） |

## Responsive Strategy

xyz-agent 支持 split panel（左右/上下分屏），split 时单个 panel 宽度可低至 5% ratio。实际的可用宽度范围：

| 布局 | 估算宽度 | 判断 |
|------|----------|------|
| 全屏单 panel（sidebar 折叠） | ~1200px+ | **宽** |
| 全屏单 panel（sidebar 展开） | ~940px | **宽** |
| 左右 split 50/50（sidebar 折叠） | ~600px | **窄** |
| 左右 split 50/50（sidebar 展开） | ~340px | **极窄** |
| 左右 split 不均匀（5%/95%） | ~60px / ~1140px | 极端情况 |

采用两级响应策略，通过 container query（而非 viewport media query）实现，因为宽度取决于 panel 容器而非窗口：

### 宽面板（container width ≥ 520px）

与 spec 正文描述一致：
- **Mode Switcher**：输入框上方文字 + popover 展开选择
- **Queue Component**：完整 header + list 展示
- **InputToolbar**：所有元素可见（Model、Thinking、Context Bar、Token Stats）

### 窄面板（container width < 520px）

#### Mode Switcher → 简化文字

文字区域只显示当前模式名，不显示快捷键提示：

```
Steer
```

Popover 功能不变，点击仍可展开选择。

#### Queue Component → Inline Badge

队列不展开完整 list，改为输入框上方的一行文字：

```
☰ 2 条待处理
```

- 无 header、无 list、无清除按钮（窄面板空间不够展示队列详情）
- 点击可展开完整 Queue（overlay 或 popover 方式），但默认折叠
- 队列为空时完全隐藏

#### InputToolbar 精简

- Token Stats（`↑12.4k/↓3.2k`）隐藏，释放空间
- Context Bar 保留（它有功能价值：提醒用户上下文快满了）
- Model Picker 保留（下拉不占常驻宽度）
- Thinking Picker 保留（同上）

### Container Query 实现

```css
.queue-container {
  container-type: inline-size;
  container-name: panel;
}

/* 窄面板 */
@container panel (max-width: 519px) {
  .mode-shortcut-hint { display: none; }
  .queue-full { display: none; }
  .queue-compact { display: flex; }
  .token-stats { display: none; }
}

/* 宽面板 */
@container panel (min-width: 520px) {
  .mode-shortcut-hint { display: inline; }
  .queue-full { display: block; }
  .queue-compact { display: none; }
  .token-stats { display: inline-flex; }
}
```

### 降级原则

1. **功能不丢失**：窄面板下所有功能仍可操作，只是形式变化（文字缩短，list→badge）
2. **键盘路径不受影响**：Enter / Ctrl+Enter / Alt+Enter 在任何宽度下都直接生效
3. **不使用 viewport media query**：panel 宽度 ≠ viewport 宽度，用 container query
4. **过渡无动画**：宽度变化时组件切换用 `display` 切换而非动画，避免 split 拖拽时的连续闪烁
5. **默认态最轻量**：Mode Switcher 默认是一行文字，不是常驻的 UI 控件

## Open Questions — 深度调研结论

以下问题已通过 pi 源码（`~/Code/pi-mono-fix-workspace/main/`）和 xyz-agent 代码完整调研。

### OQ1: 中断标记的数据来源 — ✅ 可实现

pi 的 `message.complete` 事件（由 `agent_end` 转换）包含 `stopReason` 字段，值包括 `'stop'` | `'toolUse'` | `'aborted'` | `'error'`。steer 中止时为 `'aborted'`。event-adapter 的 `STOP_REASON_MAP` 已正确映射 `aborted → 'aborted'`。

**当前问题**：前端 `onComplete`（`useChat.ts` L168）只取 `usage`，不读 `stopReason`。

**实现要求**：
1. `onComplete` 读取 `msg.payload.stopReason`
2. `chatStore.completeStream()` 新增 `stopReason` 参数
3. 消息数据中记录 `isInterrupted: stopReason === 'aborted'`
4. MessageBubble 根据此字段渲染 Interrupted Marker

### OQ2: 队列清除/修改 — ⚠️ 部分支持，需要改造

**pi Agent 层**（`packages/agent/src/agent.ts`）：
- `PendingMessageQueue` 只有 `enqueue` / `drain` / `clear` / `hasItems`，**无单条删除或修改**
- `agent.clearAllQueues()` = `clearSteeringQueue()` + `clearFollowUpQueue()`
- **结论：只支持全部清除，不支持修改/删除单条**

**pi Session 层**（`agent-session.ts`）：
- `clearQueue()` 调用 `agent.clearAllQueues()` + `_emitQueueUpdate()`，返回被清除的消息
- 只在 interactive mode 的 abort 流程中调用（恢复队列到编辑器）

**pi RPC 层**（`rpc-mode.ts`）：
- 命令列表中 **无** `queue_clear` / `queue_modify` / `steering_clear`
- RPC 不暴露任何队列管理能力

**可行的方案**：
- 方案 A：给 pi RPC 新增 `clear_queue` 命令（需改 pi 源码）
- 方案 B：xyz-agent 不清队列，Queue Component 纯只读
- 方案 C（推荐）：**xyz-agent 前端维护独立的队列状态**。前端收到 `queue_update` 时缓存消息列表。"清除" = 前端清空缓存 + 发 `abort` 给 pi（清空当前处理）+ 后续消息通过 pi `steer`/`follow_up` 重新发送

**决策**：Queue Component **不显示清除按钮**，纯只读。理由：
1. pi RPC 不支持队列管理
2. 修改 pi 源码增加 RPC 命令超出了本 spec 范围
3. 队列通常 0-1 条消息，清除的 ROI 很低

### OQ3: xyz-agent 应该改用 pi 的 steer/follow_up RPC 命令 — ✅ 强烈建议

**当前实现的问题**（`server.ts` L303-338）：

| 方面 | xyz-agent 当前实现 | pi 原生 steer/follow_up RPC |
|------|-------------------|---------------------------|
| steer | `abort()` + `prompt()` | `session.steer()` → `_queueSteer()` |
| follow_up | `prompt()`（streaming 时报错） | `session.followUp()` → `_queueFollowUp()` |
| queue_update | 不触发 | 触发 `_emitQueueUpdate()` |
| 消息传递 | abort 后作为新 turn | 排入队列，在 turn 的工具调用间隙插入 |
| 当前消息 | 被 abort 终止，`stopReason: 'aborted'` | 继续完成当前工具调用，steer 消息在下一个 LLM 调用前插入 |

**关键源码路径**：

1. `rpc-mode.ts` L414-422：pi RPC 原生支持 `steer` 和 `follow_up` 命令
2. `agent-session.ts` L986-1040：`prompt()` 在 streaming 时**必须**传 `streamingBehavior`，否则抛错。xyz-agent 的 `sendMessage()` → `client.prompt()` **没传 `streamingBehavior`**，所以 AI 忙碌时 `message.follow_up` 会直接报错
3. `agent-session.ts` L1244/1261：`_queueSteer()` 和 `_queueFollowUp()` 向 `_steeringMessages[]` / `_followUpMessages[]` push 文本，然后 `_emitQueueUpdate()` 触发 `queue_update` 事件
4. `agent.ts` L169：`steeringQueue: PendingMessageQueue`，agent loop 的 `getSteeringMessages()` 在每次 LLM 调用间隙 drain
5. `agent-session.ts` L482-492：agent `message_start` 时从 `_steeringMessages` 中移除对应条目，触发 `queue_update`

**当前 steer 的 bug**：xyz-agent 的 steer 用 abort+resend，相当于把 steer 消息当作全新的普通消息发送。这丢失了 pi 的语义——steer 应该在当前 turn 的工具调用间隙注入，而不是 abort 整个 turn。

**推荐改造**（本 spec 范围外，但应作为 Queue Component 的前置依赖）：

1. `rpc-client.ts` 新增 `steer(content)` → `sendCommand('steer', { message: content })`
2. `rpc-client.ts` 新增 `followUp(content)` → `sendCommand('follow_up', { message: content })`
3. `session-service.ts` 新增 `steerMessage(sessionId, content)` → `client.steer(content)`
4. `session-service.ts` 新增 `followUpMessage(sessionId, content)` → `client.followUp(content)`
5. `server.ts` 的 `message.steer` 改为调用 `sessionService.steerMessage()`（去掉 abort）
6. `server.ts` 的 `message.follow_up` 改为调用 `sessionService.followUpMessage()`

**改造后的效果**：
- `queue_update` 事件正常触发，前端 Queue Component 能拿到真实数据
- steer 消息在工具调用间隙插入，不 abort 当前 turn
- follow_up 不再在 streaming 时报错
- steer 的语义与 pi 原生行为一致

**关于 Interrupted Marker 的影响**：改用 pi 原生 steer 后，当前 assistant 消息**不会被 abort**，而是在工具调用间隙自然完成。这意味着 `stopReason` 不会是 `'aborted'`，Interrupted Marker（FR3）不再适用于 steer 场景。FR3 只保留给用户显式 `message.abort` 操作。

**Key Decisions 更新**：
- steer/follow_up 改造是 Queue Component 的前置依赖
- FR3 Interrupted Marker 仅适用于 `message.abort`，不适用于 steer
- 如果改造不在本次 spec 范围内，Queue Component 只能显示空状态

## Key Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| Mode Switcher 方案 | 升级版 SendModeStatusBar（文字 + popover） | Send 占 ~90%，三段式给低频模式过高视觉权重 |
| Mode Switcher 位置 | 输入框上方（复用现有位置） | 与现有组件位置一致，减少改动范围 |
| Queue 响应式 | ≥520px 完整 list，<520px inline badge | 队列通常 0-1 条，窄面板下完整 list 重量级 |
| Send Chip 位置 | 时间戳旁，消息气泡外 | 遵循现有时间戳布局，不改变消息气泡尺寸 |
| Queue 宽度 | 与输入框一致（`max-w-[960px] mx-auto px-6`） | 视觉对齐，用户明确要求 |
| Global Loading Bar 位置 | ChatInput 顶部，全宽 | 始终在视口底部附近，不抢占消息区域空间 |
| Queue 外围背景 | 全宽 `--surface`，内容缩进 | header 背景色贯穿，与消息区/输入区形成三个清晰的横向分区 |
| Steer/Follow-up 术语 | 保留英文原文作为 chip 文字 | 用户习惯术语，i18n 翻译后可能太长；chip 处用英文，tooltip 提供中文说明 |
| FR3 数据来源 | `message.complete.stopReason === 'aborted'`，仅适用于 abort | steer 改用 pi 原生 RPC 后不再 abort，FR3 只保留给显式 abort |
| 队列清除按钮 | 不显示（pi RPC 不支持，且 `PendingMessageQueue` 无单条删除） | 只读展示比虚假的清除按钮更好 |
| steer/follow_up 实现 | 改用 pi 原生 `steer`/`follow_up` RPC 命令（前置依赖） | 当前 abort+resend 绕过队列，queue_update 不会触发 |
| queue.done banner | 3 秒后自动消失 | 长驻 banner 干扰输入区域 |

## Acceptance Criteria

| # | 条件 | 验证方式 |
|---|------|---------|
| AC1 | Mode Switcher 三种模式可通过 popover 切换，UI 实时反映 | 手动测试 |
| AC1a | 窄面板（<520px）Mode Switcher 省略快捷键提示，popover 功能完整 | 手动测试 |
| AC1b | 窄面板 Queue 退化为 inline badge，点击可展开 | 手动测试 |
| AC2 | Ctrl+Enter 触发的 steer 模式视觉高亮 Steer 按钮 | 手动测试 |
| AC3 | Alt+Enter 触发的 follow-up 模式视觉高亮 Follow-up 按钮 | 手动测试 |
| AC4 | Steer 消息气泡显示 `steer` chip | 检查消息列表 |
| AC5 | Follow-up 消息气泡显示 `follow-up` chip | 检查消息列表 |
| AC6 | 被 abort 的 AI 消息显示 `— 已中断 —` 标记 | 手动测试 |
| AC7 | Queue Component 在队列有消息时显示，空时消失 | 手动测试 |
| AC8 | Queue 中的消息正确标记 steer/follow-up | 检查 UI |
| AC9 | 队列消息被处理后从队列移除，出现在消息流中 | 手动测试端到端 |
| AC10 | Global Loading Bar 在 AI 执行时动画，空闲时隐藏 | 视觉检查 |
| AC11 | `prefers-reduced-motion` 关闭所有动画 | 设置检查 |
| AC12 | 所有文案通过 `data-i18n` 支持切换语言 | 代码检查 |
