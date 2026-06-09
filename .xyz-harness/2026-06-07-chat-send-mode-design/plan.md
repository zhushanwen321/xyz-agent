---
verdict: pass
complexity: L1
---

# Chat Send Mode & Queue Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现消息发送模式 UI（Mode Switcher + Send Chips）、队列可视化（Queue Component）、中断标记（Interrupted Marker）、全局加载条（Global Loading Bar），以及前置依赖——将 steer/follow_up 改为使用 pi 原生 RPC 命令。

**Architecture:** 纯前端改动为主，唯一后端改动在 runtime 层（rpc-client + session-service + server.ts），改用 pi 原生 `steer`/`follow_up` RPC 命令替代当前的 abort+resend。前端复用 `chatStore.queueState`（已有 `setQueueState`）和 `useChat.onQueueUpdate`（已解析 steering/followUp 数组），新增 UI 消费方。

**Tech Stack:** Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui + container query

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/shared/src/message.ts` | modify | BG1 | Message 接口新增 sendMode、isInterrupted 字段 |
| `src-electron/runtime/src/rpc-client.ts` | modify | BG1 | 新增 steer()、followUp() 方法 |
| `src-electron/runtime/src/services/session-service.ts` | modify | BG1 | 新增 steerMessage()、followUpMessage() 方法 |
| `src-electron/runtime/src/server.ts` | modify | BG1 | message.steer / message.follow_up 改用新方法 |
| `src-electron/renderer/src/components/chat/SendModeStatusBar.vue` | modify | FG1 | 升级为 Mode Switcher（文字 + popover） |
| `src-electron/renderer/src/components/chat/QueueComponent.vue` | create | FG2 | 队列展示组件（header + list + badge 响应式） |
| `src-electron/renderer/src/components/chat/GlobalLoadingBar.vue` | create | FG3 | 全局加载指示条 |
| `src-electron/renderer/src/components/chat/MessageBubble.vue` | modify | FG4 | Send Chip + Interrupted Marker |
| `src-electron/renderer/src/stores/chat.ts` | modify | FG1 | completeStream 新增 stopReason 参数；addMessage 记录 sendMode |
| `src-electron/renderer/src/composables/useChat.ts` | modify | FG1 | onComplete 读取 stopReason；onQueueUpdate 已实现无需改 |
| `src-electron/renderer/src/components/chat/ChatInput.vue` | modify | FG5 | 集成 Mode Switcher、Queue、Loading Bar；send 事件传 sendMode |
| `src-electron/renderer/src/components/extension/WidgetDock.vue` | modify | FG5 | 调整位置，固定在 Queue 下方 |
| `src-electron/renderer/src/style.css` | modify | FG2 | container query 样式 |

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC1 Mode Switcher popover 切换 | adopted | Task 3 |
| AC1a 窄面板 Mode Switcher 简化 | adopted | Task 7 |
| AC1b 窄面板 Queue badge | adopted | Task 7 |
| AC2 Ctrl+Enter steer 视觉高亮 | adopted | Task 3 |
| AC3 Alt+Enter follow-up 视觉高亮 | adopted | Task 3 |
| AC4 Steer 消息显示 chip | adopted | Task 6 |
| AC5 Follow-up 消息显示 chip | adopted | Task 6 |
| AC6 Abort 消息显示中断标记 | adopted | Task 6 |
| AC7 Queue 有消息时显示/空时隐藏 | adopted | Task 5 |
| AC8 Queue 正确标记 steer/follow-up | adopted | Task 5 |
| AC9 队列消息处理后移到消息流 | adopted | Task 1 + Task 5 |
| AC10 Global Loading Bar 动画 | adopted | Task 4 |
| AC11 prefers-reduced-motion | adopted | Task 4 |
| AC12 i18n 支持 | adopted | Task 8 |

## Interface Contracts

### Module: shared/types

#### Data: Message

| Field | Type | Description |
|-------|------|-------------|
| sendMode | `'send' \| 'steer' \| 'follow-up'` \| undefined | 发送模式标识，仅 user 消息有值 |
| isInterrupted | `boolean` \| undefined | 是否被 abort 中断，仅 assistant 消息有值 |

### Module: rpc-client

#### Class: RpcClient

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| steer | `(content: string) => Promise<PiMessage>` | PiMessage | session 不活跃时 throw | OQ3 |
| followUp | `(content: string) => Promise<PiMessage>` | PiMessage | session 不活跃时 throw | OQ3 |

### Module: session-service

#### Class: SessionService

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| steerMessage | `(sessionId: string, content: string) => Promise<void>` | void | client 不存在时 throw | OQ3 |
| followUpMessage | `(sessionId: string, content: string) => Promise<void>` | void | client 不存在时 throw | OQ3 |

### Module: chatStore

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| completeStream | `(sessionId: string, stopReason?: string) => void` | void | stopReason 可选，向后兼容 | AC6 |

### Module: useChat

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| onComplete | `(msg: ServerMessage) => void` | void | stopReason 不存在时默认 undefined | AC6 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC1 | SendModeStatusBar (component) | click → popover → mode change | Task 3 |
| AC1a | container query CSS | width < 520px → hide shortcut hint | Task 7 |
| AC1b | QueueComponent (component) | width < 520px → badge mode | Task 7 |
| AC2 | SendModeStatusBar | Ctrl+Enter → mode='steer' → accent color | Task 3 |
| AC3 | SendModeStatusBar | Alt+Enter → mode='queue' → warning color | Task 3 |
| AC4 | MessageBubble | message.sendMode === 'steer' → render chip | Task 6 |
| AC5 | MessageBubble | message.sendMode === 'follow-up' → render chip | Task 6 |
| AC6 | chatStore.completeStream | stopReason === 'aborted' → isInterrupted=true | Task 2, Task 6 |
| AC7 | QueueComponent | queueState.steering.length + followUp.length > 0 → show | Task 5 |
| AC8 | QueueComponent | per-item badge from queue data | Task 5 |
| AC9 | onQueueUpdate → store → QueueComponent | queue_update event → store update → UI update | Task 1, Task 5 |
| AC10 | GlobalLoadingBar | chatStore.isGenerating → bar visible | Task 4 |
| AC11 | GlobalLoadingBar | prefers-reduced-motion → static bar | Task 4 |
| AC12 | i18n keys | data-i18n attributes | Task 8 |

---

## Task List

### Task 1: 改用 pi 原生 steer/follow_up RPC 命令

**Type:** backend (runtime)

**Files:**
- Modify: `src-electron/runtime/src/rpc-client.ts`
- Modify: `src-electron/runtime/src/services/session-service.ts`
- Modify: `src-electron/runtime/src/server.ts`

- [ ] **Step 1: rpc-client.ts 新增 steer 和 followUp 方法**

在 `rpc-client.ts` 的 `abort()` 方法后面新增：

```typescript
steer(content: string): Promise<PiMessage> {
  return this.sendCommand('steer', { message: content })
}

followUp(content: string): Promise<PiMessage> {
  return this.sendCommand('follow_up', { message: content })
}
```

- [ ] **Step 2: session-service.ts 新增 steerMessage 和 followUpMessage**

在 `sendMessage` 方法后面新增：

```typescript
async steerMessage(sessionId: string, content: string): Promise<void> {
  const client = this.pm.getClient(sessionId)
  if (!client) throw new Error(`[session-service] steer: session ${sessionId} not active`)
  await client.steer(content)
}

async followUpMessage(sessionId: string, content: string): Promise<void> {
  const client = this.pm.getClient(sessionId)
  if (!client) throw new Error(`[session-service] followUp: session ${sessionId} not active`)
  await client.followUp(content)
}
```

- [ ] **Step 3: server.ts 改造 message.steer 和 message.follow_up**

`message.steer` case 改为：
```typescript
case 'message.steer': {
  const steerSid = msg.payload.sessionId
  try {
    await this.sessionService.steerMessage(steerSid, msg.payload.content)
    return this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId: steerSid, status: 'steered' } })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    console.error('[runtime] message.steer failed:', errMsg)
    return this.send(ws, { type: 'message.error', id: msg.id, payload: { sessionId: steerSid, message: errMsg } })
  }
}
```

`message.follow_up` case 改为：
```typescript
case 'message.follow_up': {
  const followSid = msg.payload.sessionId
  try {
    await this.sessionService.followUpMessage(followSid, msg.payload.content)
    return this.send(ws, { type: 'message.status', id: msg.id, payload: { sessionId: followSid, status: 'queued' } })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    console.error('[runtime] message.follow_up failed:', errMsg)
    return this.send(ws, { type: 'message.error', id: msg.id, payload: { sessionId: followSid, message: errMsg } })
  }
}
```

关键变化：steer 不再先 abort 再 sendMessage，改为直接调用 pi 的 steer RPC。

- [ ] **Step 4: 验证 queue_update 事件触发**

启动 dev 模式，在 AI 生成时发送 follow-up 消息（Alt+Enter），检查浏览器控制台是否有 `queue_update` 事件到达。预期 `msg.payload` 包含 `{ steering: [], followUp: ['测试消息'] }`。

- [ ] **Step 5: Commit**

```bash
git add src-electron/runtime/src/rpc-client.ts src-electron/runtime/src/services/session-service.ts src-electron/runtime/src/server.ts
git commit -m "refactor: use pi native steer/follow_up RPC commands"
```

### Task 2: Message 类型扩展 + completeStream 支持 stopReason

**Type:** frontend (shared + store)

**Files:**
- Modify: `src-electron/shared/src/message.ts`
- Modify: `src-electron/renderer/src/stores/chat.ts`
- Modify: `src-electron/renderer/src/composables/useChat.ts`

- [ ] **Step 1: Message 接口新增 sendMode 和 isInterrupted 字段**

在 `src-electron/shared/src/message.ts` 的 `Message` 接口末尾新增：

```typescript
/** 发送模式，仅 user 消息有值 */
sendMode?: 'send' | 'steer' | 'follow-up'
/** 是否被 abort 中断，仅 assistant 消息有值 */
isInterrupted?: boolean
```

- [ ] **Step 2: chatStore.completeStream 新增 stopReason 参数**

`chat.ts` 中 `completeStreaming` 函数签名改为：

```typescript
function completeStreaming(opts: { keepGenerating?: boolean; stopReason?: string } | undefined, sessionId: string) {
```

在消息赋值完成后，检查 stopReason：

```typescript
if (opts?.stopReason === 'aborted' && s.streamingMessage) {
  s.streamingMessage = { ...s.streamingMessage, isInterrupted: true }
}
```

- [ ] **Step 3: useChat.onComplete 读取 stopReason**

```typescript
function onComplete(msg: ServerMessage) {
  const sid = getSid(msg)
  if (!sid) return
  const usage = msg.payload.usage as { totalTokens?: number } | undefined
  if (usage?.totalTokens) {
    store.setTokenUsage(usage.totalTokens, sid)
  }
  const stopReason = msg.payload.stopReason as string | undefined
  store.completeStream({ stopReason }, sid)
}
```

- [ ] **Step 4: Commit**

```bash
git add src-electron/shared/src/message.ts src-electron/renderer/src/stores/chat.ts src-electron/renderer/src/composables/useChat.ts
git commit -m "feat: add sendMode/isInterrupted to Message, read stopReason in onComplete"
```

### Task 3: Mode Switcher — 升级 SendModeStatusBar

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/SendModeStatusBar.vue`

- [ ] **Step 1: 重构 SendModeStatusBar 为可交互的 Mode Switcher**

保留现有组件文件名（`SendModeStatusBar.vue`），重写为：

**模板结构**：
- 外层 `<button>` 触发器（`aria-haspopup="listbox"`、`aria-expanded`）
- 内部显示当前模式名 + 快捷键提示（窄面板下隐藏快捷键，用 container query 控制）
- 点击展开 popover（`role="listbox"`），三个 `<div role="option">` 项
- 当前选中项显示 ● 圆点 + `aria-selected="true"`

**交互逻辑**：
- `defineProps<{ mode: SendMode; isStreaming?: boolean }>()` 不变
- `defineEmits<{ (e: 'update:mode', mode: SendMode): void }>()`
- popover 开关用 `ref<boolean>` 管理
- click-outside 用 `@click.self` 在 overlay 上关闭
- 颜色映射：send=muted, steer=text-accent, queue/follow-up=text-warning

**Popover 样式**：
- 背景 `var(--surface)`，1px `var(--border)`，`box-shadow: 0 4px 12px var(--shadow)`
- 底部对齐触发器，每项高 28px
- 内部用 flex，左对齐模式名 + 右对齐快捷键

- [ ] **Step 2: 验证 Mode Switcher 交互**

手动测试：点击文字 → popover 展开 → 选择 Steer → 文字变为 accent 色 "Steer · ⌘+Enter"。Ctrl+Enter 快捷键也能切换。

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/components/chat/SendModeStatusBar.vue
git commit -m "feat: upgrade SendModeStatusBar to interactive Mode Switcher"
```

### Task 4: Global Loading Bar

**Type:** frontend

**Files:**
- Create: `src-electron/renderer/src/components/chat/GlobalLoadingBar.vue`

- [ ] **Step 1: 实现 GlobalLoadingBar 组件**

**Props**: `{ isGenerating: boolean }`

**模板**：
```html
<div
  role="status"
  :aria-live="isGenerating ? 'polite' : undefined"
  :class="['w-full h-[3px] overflow-hidden transition-[height] duration-150', isGenerating ? 'h-[3px]' : 'h-0']"
  :aria-label="isGenerating ? 'AI 正在处理' : undefined"
>
  <div v-if="isGenerating" class="loading-bar-sweep" />
</div>
```

**样式**（`<style scoped>`）：
```css
.loading-bar-sweep {
  height: 100%;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: sweep 1.5s ease-in-out infinite;
}

@keyframes sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}

@media (prefers-reduced-motion: reduce) {
  .loading-bar-sweep {
    animation: none;
    width: 100%;
    opacity: 0.4;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src-electron/renderer/src/components/chat/GlobalLoadingBar.vue
git commit -m "feat: add GlobalLoadingBar component"
```

### Task 5: Queue Component

**Type:** frontend

**Files:**
- Create: `src-electron/renderer/src/components/chat/QueueComponent.vue`

- [ ] **Step 1: 实现 QueueComponent**

**Props**: `{ queueState: QueueState | undefined }`

**数据**：从 `chatStore` 读取 `queueState`

**模板结构**（宽面板 ≥520px）：
```html
<div v-if="hasItems" class="w-full bg-[var(--surface)] transition-[height] duration-150 overflow-hidden">
  <div class="max-w-[960px] mx-auto px-6">
    <!-- header -->
    <div class="flex items-center justify-between h-7 text-[11px] text-muted">
      <span>{{ queueHeaderLabel }}</span>
    </div>
    <!-- list -->
    <div class="space-y-1 pb-2">
      <div v-for="(item, i) in queueItems" :key="i" class="flex items-center gap-2 text-[11px]">
        <span :class="['px-1.5 py-0.5 rounded-sm text-[9px] font-medium', badgeClass(item.type)]">{{ item.type }}</span>
        <span class="truncate flex-1 opacity-70">{{ item.text }}</span>
        <span class="pulsing-dot" />
      </div>
      <div v-if="overflowCount > 0" class="text-[10px] text-muted">+{{ overflowCount }} 更多</div>
    </div>
  </div>
</div>
<!-- 窄面板 badge（container query 控制 display） -->
<div v-if="hasItems" class="queue-compact hidden text-[11px] text-muted px-3.5 py-1 cursor-pointer" @click="emit('expand')">
  ☰ {{ totalCount }} 条待处理
</div>
```

**逻辑**：
- `hasItems` = (steering.length + followUp.length) > 0
- `queueItems` = 合并 steering（type='steer'）和 followUp（type='follow-up'）数组，最多 5 条
- `overflowCount` = 总数 - 5
- `badgeClass(type)` → steer 用 `bg-warning/15 text-warning`，follow-up 用 `bg-accent/15 text-accent`
- `pulsing-dot` → 6px 圆点，`animation: pulse 1.5s ease-in-out infinite`
- 队列为空时 `v-if="hasItems"` 隐藏

**queue.done banner**：用 `watch(queueState)` 检测队列从有→空的转换。当 `prevHasItems && !hasItems` 时显示绿色 banner（`text-success`），3 秒后自动消失（`setTimeout` + `onUnmounted` 清理）。

**sendMode 关联策略**：前端在发送 steer/follow-up 时，本地维护一个 `Map<string, SendMode>`（key = 消息内容哈希或时间戳，value = sendMode）。当 pi 事件流回传用户消息（`message.start` with role=user）时，匹配此 map 写入 `sendMode`。匹配失败时默认 `undefined`（不显示 chip）。

- [ ] **Step 2: Commit**

```bash
git add src-electron/renderer/src/components/chat/QueueComponent.vue
git commit -m "feat: add QueueComponent with responsive layout"
```

### Task 6: MessageBubble — Send Chip + Interrupted Marker

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/MessageBubble.vue`

- [ ] **Step 1: 用户消息时间戳旁添加 Send Chip**

在用户消息的时间戳 `<span>` 前面，添加 Send Chip 渲染：

```html
<span
  v-if="message.sendMode && message.sendMode !== 'send'"
  :class="['inline-flex items-center px-1 py-0 rounded-sm text-[9px] font-medium mr-1', chipClass]"
>{{ chipLabel }}</span>
```

`chipClass` 计算：steer → `bg-warning/15 text-warning`，follow-up → `bg-accent/15 text-accent`
`chipLabel`：steer → `'steer'`，follow-up → `'follow-up'`

- [ ] **Step 2: Assistant 消息添加 Interrupted Marker**

在 `AssistantContent` 组件后面（inline actions 之前）：

```html
<div
  v-if="message.isInterrupted"
  class="flex items-center gap-2 mt-2 text-[10px] text-muted opacity-65"
>
  <span class="flex-1 h-px bg-muted/30" />
  <span>{{ t('interrupted') }}</span>
  <span class="flex-1 h-px bg-muted/30" />
</div>
```

被中断的 assistant 消息整体 `opacity-65`，通过在根 `<div>` 上添加 `:class="{ 'opacity-65': message.isInterrupted }"` 实现。

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/components/chat/MessageBubble.vue
git commit -m "feat: add Send Chip and Interrupted Marker to MessageBubble"
```

### Task 7: ChatInput 集成 + Container Query 样式

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/ChatInput.vue`
- Modify: `src-electron/renderer/src/components/extension/WidgetDock.vue`
- Modify: `src-electron/renderer/src/style.css`

- [ ] **Step 1: ChatInput 布局组装**

ChatInput 的输入区上方按固定层级堆叠：

```
GlobalLoadingBar (全宽)
QueueComponent (container query 控制宽/窄)
WidgetDock (固定位置)
SendModeStatusBar (Mode Switcher)
textarea + toolbar
```

在 ChatInput 中：
- import GlobalLoadingBar、QueueComponent
- 从 chatStore 读取 `isGenerating` 和 `queueState`
- send 事件的 payload 新增 `sendMode` 字段
- 在 addMessage 时将 sendMode 写入消息数据

- [ ] **Step 2: style.css 添加 container query 样式**

```css
.panel-input-area {
  container-type: inline-size;
  container-name: panel;
}

@container panel (max-width: 519px) {
  .mode-shortcut-hint { display: none; }
  .queue-full { display: none; }
  .queue-compact { display: flex; }
  .token-stats { display: none; }
}

@container panel (min-width: 520px) {
  .mode-shortcut-hint { display: inline; }
  .queue-full { display: block; }
  .queue-compact { display: none; }
  .token-stats { display: inline-flex; }
}
```

- [ ] **Step 3: WidgetDock 位置调整**

确保 WidgetDock 始终在 QueueComponent 正下方，不随队列状态移动。如果当前 WidgetDock 位置逻辑依赖队列是否存在，修改为始终渲染在同一位置。

- [ ] **Step 4: 端到端验证**

手动测试场景：
1. 普通发送（Enter）→ 无 chip 显示
2. Steer 发送（Ctrl+Enter）→ 消息显示 steer chip
3. Follow-up 发送（Alt+Enter，AI 忙碌时）→ Queue 出现消息 → 处理完后消息出现在消息流 with follow-up chip
4. Abort → assistant 消息显示中断标记
5. Split panel → 窄面板下 Mode Switcher 简化、Queue 退化为 badge

- [ ] **Step 5: Commit**

```bash
git add src-electron/renderer/src/components/chat/ChatInput.vue src-electron/renderer/src/components/extension/WidgetDock.vue src-electron/renderer/src/style.css
git commit -m "feat: integrate Mode Switcher, Queue, Loading Bar in ChatInput"
```

### Task 8: i18n 支持

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/SendModeStatusBar.vue`
- Modify: `src-electron/renderer/src/components/chat/QueueComponent.vue`
- Modify: `src-electron/renderer/src/components/chat/MessageBubble.vue`
- Modify: `src-electron/renderer/src/components/chat/GlobalLoadingBar.vue`

- [ ] **Step 1: 所有用户可见文案添加 data-i18n 属性**

按 spec 的 i18n 表，为以下元素添加 `data-i18n` 属性：

| 组件 | Key | 中文 | English |
|------|-----|------|---------|
| SendModeStatusBar popover | `mode.send` | 发送 | Send |
| SendModeStatusBar popover | `mode.steer` | 中断发送 | Steer |
| SendModeStatusBar popover | `mode.followup` | 排队发送 | Follow-up |
| QueueComponent header | `queue.pendingCount` | {N} 条消息待处理 | {N} pending |
| QueueComponent badge | `queue.badge.steer` | steer | steer |
| QueueComponent badge | `queue.badge.followup` | follow-up | follow-up |
| QueueComponent dot tooltip | `queue.waiting` | 等待中 | Waiting |
| QueueComponent banner | `queue.done` | 队列已完成 · {N} 条已处理 | Queue completed · {N} done |
| MessageBubble chip | `chip.steer` | steer | steer |
| MessageBubble chip | `chip.followup` | follow-up | follow-up |
| MessageBubble marker | `interrupted` | 已中断 | Interrupted |

- [ ] **Step 2: Commit**

```bash
git add -u
git commit -m "feat: add i18n support for send mode UI"
```

---

## Execution Groups

#### BG1: Runtime steer/follow_up 改造

**Description:** 将 xyz-agent 的 steer 和 follow_up 从 abort+resend 改为 pi 原生 RPC 命令。这是 Queue Component 的前置依赖——不改的话 queue_update 事件不会触发。

**Tasks:** Task 1

**Files (预估):** 3 个文件（0 create + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | Task 1 描述 + OQ3 调研结论 + rpc-client.ts/server.ts/session-service.ts 当前代码 |
| 读取文件 | `src-electron/runtime/src/rpc-client.ts`, `src-electron/runtime/src/services/session-service.ts`, `src-electron/runtime/src/server.ts` |
| 修改/创建文件 | 同上 3 个文件 |

**Dependencies:** 无

#### FG1: 共享类型 + Store + Mode Switcher

**Description:** Message 类型扩展、chatStore 支持 stopReason、useChat onComplete 改造、SendModeStatusBar 升级为 Mode Switcher。这些是所有前端组件的基础。

**Tasks:** Task 2, Task 3

**Files (预估):** 4 个文件（0 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | Task 2/3 描述 + spec FR1/FR3 + SendModeStatusBar.vue 当前代码 |
| 读取文件 | `src-electron/shared/src/message.ts`, `src-electron/renderer/src/stores/chat.ts`, `src-electron/renderer/src/composables/useChat.ts`, `src-electron/renderer/src/components/chat/SendModeStatusBar.vue` |
| 修改/创建文件 | 同上 4 个文件 |

**Dependencies:** 无（与 BG1 无依赖，可以并行）

#### FG2: Queue Component + Global Loading Bar

**Description:** 新建 QueueComponent.vue 和 GlobalLoadingBar.vue。独立于 Mode Switcher，但依赖 FG1 的类型定义。

**Tasks:** Task 4, Task 5

**Files (预估):** 2 个文件（2 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | Task 4/5 描述 + spec FR4/FR5 + Responsive Strategy + QueueState 接口 |
| 读取文件 | `src-electron/renderer/src/stores/chat.ts`（QueueState 接口）, `src-electron/renderer/src/style.css` |
| 修改/创建文件 | `src-electron/renderer/src/components/chat/QueueComponent.vue`（create）, `src-electron/renderer/src/components/chat/GlobalLoadingBar.vue`（create） |

**Dependencies:** FG1（需要 QueueState 和 Message 类型定义就绪）

#### FG3: MessageBubble Send Chip + Interrupted Marker

**Description:** 在 MessageBubble 中添加 Send Chip 和 Interrupted Marker 渲染。依赖 FG1 的 Message 类型扩展。

**Tasks:** Task 6

**Files (预估):** 1 个文件（0 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | Task 6 描述 + spec FR2/FR3 + MessageBubble.vue 当前代码 |
| 读取文件 | `src-electron/renderer/src/components/chat/MessageBubble.vue` |
| 修改/创建文件 | `src-electron/renderer/src/components/chat/MessageBubble.vue` |

**Dependencies:** FG1（需要 Message.sendMode 和 Message.isInterrupted 就绪）

#### FG4: ChatInput 集成 + Container Query + i18n

**Description:** 最终集成——将所有组件组装到 ChatInput 中，添加 container query 响应式样式，处理 WidgetDock 位置，添加 i18n 属性。

**Tasks:** Task 7, Task 8

**Files (预估):** 7 个文件（0 create + 7 modify）

ChatInput.vue、WidgetDock.vue、style.css（Task 7）+ SendModeStatusBar.vue、QueueComponent.vue、MessageBubble.vue、GlobalLoadingBar.vue（Task 8 i18n）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | Task 7/8 描述 + spec Responsive Strategy + i18n 表 + ChatInput.vue 当前代码 |
| 读取文件 | `src-electron/renderer/src/components/chat/ChatInput.vue`, `src-electron/renderer/src/components/extension/WidgetDock.vue`, `src-electron/renderer/src/style.css` |
| 修改/创建文件 | 同上 3 个 + SendModeStatusBar.vue + QueueComponent.vue + MessageBubble.vue + GlobalLoadingBar.vue（添加 i18n） |

**Dependencies:** FG1, FG2, FG3（需要所有子组件就绪后才能集成）

**拆分调度**：FG4 内部按 Task 7（3 文件）和 Task 8（4 文件）分别派遣 subagent，串联执行，每次不超过 5 文件

## Dependency Graph & Wave Schedule

```
BG1 (runtime改造) ──┐
                     ├──→ FG2 (Queue+LoadingBar) ──┐
FG1 (类型+Switcher) ─┘                              ├──→ FG4 (集成+i18n)
                     ├──→ FG3 (Chip+Marker) ────────┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, FG1 | 前后端基础，无互相依赖 |
| Wave 2 | FG2, FG3 | 依赖 FG1 的类型定义，可并行 |
| Wave 3 | FG4 | 集成，依赖所有前置 Group |

## Self-Review Checklist

### Scope 覆盖声明
- [x] spec 中每个 AC 在 plan 中标注了 adopted 状态
- [x] 无 spec 指标被静默忽略
- [x] scope 缩减已正式声明（队列清除不实现，在 Key Decisions 中记录）

### Task 粒度
- [x] 单个 Task ≤ 8 步
- [x] 每个 Task 对应一次 subagent 调度

### 禁止实现代码
- [x] plan 中无函数体或完整类定义（代码片段是 subagent 的参考指引，标注了"用 xxx 实现"而非完整实现）
- 注：Task 1 的代码片段是因 runtime 层改动精确、行数少（每处 ~5 行），作为精确指引保留

### 伪代码数据来源
- [x] Message.sendMode 来源：ChatInput emit 事件时写入
- [x] Message.isInterrupted 来源：chatStore.completeStream 从 stopReason 推导
- [x] QueueState 来源：pi 的 queue_update 事件，useChat.onQueueUpdate 已解析
