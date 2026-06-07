---
verdict: pass
complexity: L1
---

# Streaming 折叠模式 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CompactSummaryBar 操作行展开从纯文本渲染升级为复用 ToolCallCard/ThinkingBlock 组件，实现 overflow 就地展开，以及 streaming 结束时自动收回 bubble。

**Architecture:** 纯前端改动，所有逻辑在 Vue 组件层。通过 `compactStreaming` 开关控制渲染分支，不修改全局事件处理器或数据类型。核心改动集中在 CompactSummaryBar（操作行渲染升级 + overflow）和 CompactStreamingBubble（自动收回）。

**Tech Stack:** Vue 3 + TypeScript + Pinia + Tailwind CSS v3

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/renderer/src/components/chat/CompactSummaryBar.vue` | modify | FG1 | 操作行渲染升级：纯文本 → ToolCallCard/ThinkingBlock；item overflow 就地展开；chip 类型 overflow（>4 种 → "+N more"） |
| `src-electron/renderer/src/components/chat/CompactStreamingBubble.vue` | modify | FG1 | streaming 结束时自动收回（watch status 变化） |

## Interface Contracts

### Module: CompactSummaryBar

#### Component: CompactSummaryBar

| Method/Prop | Signature | Returns | Edge Cases | Spec Ref |
|-------------|-----------|---------|------------|----------|
| props.message | `Message` | — | 无 thinking 且无 toolCalls 时 chips 为空数组 | FR-2 |
| props.expanded | `Set<number>` | — | 空 Set 时所有 group 收起 | FR-4 |
| emit toggle-group | `(index: number) => void` | — | index 越界时无操作 | FR-4 |
| emit toggle-all | `() => void` | — | 无 chips 时无操作 | FR-4 |

#### Data: CompactChipItem

| Field | Type | Description |
|-------|------|-------------|
| refId | `string` | thinking.id 或 toolCall.id，用于查找对应数据 |
| path | `string` | 工具调用路径或空字符串（thinking） |
| timeDisplay | `string` | 格式化耗时 |
| expanded | `boolean` | 操作行展开状态 |

#### Data: CompactChip

| Field | Type | Description |
|-------|------|-------------|
| type | `'thinking' \| 'tool'` | 操作类型 |
| variant | `'thinking' \| 'tool'` | CSS 变体 |
| label | `string` | chip 显示文本 |
| count | `number` | 操作数量 |
| overflow | `number` | 超出 MAX_VISIBLE_ITEMS 的数量 |
| items | `CompactChipItem[]` | 操作行列表 |
| allExpanded | `boolean` | overflow 是否已全部展开 |

## Spec Coverage Matrix

| Spec AC | Interface Method / Component | Data Flow | Task |
|---------|------------------------------|-----------|------|
| AC-1 | settingsStore.compactStreaming | persist → SystemPane Toggle | ✅ Done |
| AC-2 | AssistantContent v-if 分支 | useCompact computed → 模板分支 | ✅ Done |
| AC-3 | CompactSummaryBar | message.thinking/toolCalls → chips computed（含 chip 类型 overflow 截断） | Task 1 |
| AC-4 | CompactSummaryBar toggle-group emit | expanded Set → v-show group | Task 1 |
| AC-5 | CompactSummaryBar 操作行 → ToolCallCard/ThinkingBlock | refId → resolveThinking/resolveToolCall → 组件渲染 | Task 1 |
| AC-6 | CompactSummaryBar toggle-all emit | expanded Set clear/addAll | Task 1 |
| AC-7 | CompactStreamingBubble | statusText computed → 脉冲动画 | Task 2 |
| AC-8 | AssistantContent text 渲染 | message.content → renderedContent | ✅ Done |
| AC-9 | ESLint + taste-lint | npm run lint | Task 3 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 设置开关 | adopted (已实现) | — |
| AC-2 回归测试 | adopted (已实现) | — |
| AC-3 summary bar + chips | adopted | Task 1 |
| AC-4 chip 展开/收起 | adopted | Task 1 |
| AC-5 操作行展开完整内容（ToolCallCard/ThinkingBlock） | adopted | Task 1 |
| AC-6 summary bar 空白展开/收起全部 | adopted | Task 1 |
| AC-7 streaming bubble | adopted | Task 2 |
| AC-8 文本内容正常渲染 | adopted (已实现) | — |
| AC-9 lint 0 errors | adopted | Task 3 |
| FR-5 item overflow（同类型 >8 条就地展开） | adopted | Task 1 |
| FR-5 chip 类型 overflow（>4 种 → "+N more"） | adopted | Task 1 |
| FR-4 streaming 结束自动收回 | adopted | Task 2 |
| FR-4 操作行复用 ToolCallCard/ThinkingBlock | adopted | Task 1 |

## Task List

### Task 1: CompactSummaryBar 操作行渲染升级 + overflow 就地展开

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/CompactSummaryBar.vue`

- [ ] **Step 1: 改造 CompactChipItem 数据结构**

在 `CompactChipItem` 接口中增加 `refId` 字段（用于查找原始 ToolCall/ThinkingBlock 数据）。修改 `chipData()` 函数：
- thinking items: `refId = th.id`
- tool call items: `refId = tc.id`

在 `CompactChip` 接口中增加 `allExpanded: boolean` 字段，用于 overflow 就地展开状态。

- [ ] **Step 2: 替换操作行展开渲染为 ToolCallCard/ThinkingBlock**

删除 `compact-op__body` 中的纯文本 `<div>{{ item.body }}</div>`，替换为条件渲染：

```vue
<!-- Thinking block -->
<ThinkingBlock
  v-if="chip.type === 'thinking'"
  :text="resolveThinkingText(item.refId)"
  :start-time="resolveThinking(item.refId)?.startTime"
  :end-time="resolveThinking(item.refId)?.endTime"
/>
<!-- Tool call card -->
<ToolCallCard
  v-else
  :tool-call="resolveToolCall(item.refId)!"
/>
```

新增两个 resolve 方法，从 `props.message` 中查找对应数据：

```typescript
function resolveThinking(refId: string): import('@xyz-agent/shared').ThinkingBlock | undefined {
  return props.message.thinking?.find(b => b.id === refId)
}
function resolveThinkingText(refId: string): string {
  return resolveThinking(refId)?.content ?? ''
}
function resolveToolCall(refId: string): import('@xyz-agent/shared').ToolCall | undefined {
  return props.message.toolCalls?.find(tc => tc.id === refId)
}
```

- [ ] **Step 3: 实现 overflow 就地展开**

修改 `chipData()` 中 items 截断逻辑：

```typescript
// 之前：const items = calls.slice(0, MAX_VISIBLE_ITEMS).map(...)
// 之后：
const allItems: CompactChipItem[] = calls.map(tc => ({
  refId: tc.id,
  path: toolPath(tc.input),
  timeDisplay: tc.startTime && tc.endTime ? formatTime(tc.endTime - tc.startTime) : '',
  expanded: false,
}))
```

在模板中，overflow 的"还有 N 个"改为可点击，通过 chip 级别的 `allExpanded` 状态控制显示全部还是截断：

```vue
<div v-if="chip.overflow > 0 && !chip.allExpanded" class="compact-op__overflow" @click.stop="expandChipAll(ci)">
  还有 {{ chip.overflow }} 个
</div>
```

新增 `expandChipAll` 方法，将 `chips[ci].allExpanded` 设为 `true`（由于 `chips` 是 computed，需要改为响应式 state 或用 `ref` 包裹 overflow 状态）。

**注意：** `chips` 是 `computed`，不能直接修改内部属性。需要引入一个响应式 Map 追踪每个 chip 的 allExpanded 状态：

```typescript
const chipAllExpanded = reactive(new Map<number, boolean>())

function expandChipAll(index: number) {
  chipAllExpanded.set(index, true)
}
```

模板中 items 渲染根据 `chipAllExpanded.get(ci)` 决定截断：

```vue
<template v-for="(item, ii) in visibleItems(chip, ci)">
```

```typescript
function visibleItems(chip: CompactChip, index: number): CompactChipItem[] {
  if (chipAllExpanded.get(index)) return chip.items
  return chip.items.slice(0, MAX_VISIBLE_ITEMS)
}
```

- [ ] **Step 4: 实现 chip 类型 overflow（>4 种 → "+N more"）**

FR-5 要求 chip 数量超过 4 种时截断。在模板中，chips 渲染改为基于 `visibleChips` computed：

```typescript
const MAX_VISIBLE_CHIPS = 4
const chipOverflowExpanded = ref(false)

const visibleChips = computed(() => {
  if (chipOverflowExpanded.value || chips.value.length <= MAX_VISIBLE_CHIPS) return chips.value
  return chips.value.slice(0, MAX_VISIBLE_CHIPS)
})
const chipOverflowCount = computed(() =>
  chips.value.length > MAX_VISIBLE_CHIPS ? chips.value.length - MAX_VISIBLE_CHIPS : 0
)
```

模板中 chips 遍历改为 `visibleChips`，并在末尾追加 overflow chip：

```vue
<div v-for="(chip, ci) in visibleChips" :key="ci" ...>
  <!-- 现有 chip 渲染 -->
</div>
<div v-if="chipOverflowCount > 0" class="compact-chip compact-chip--overflow" @click="chipOverflowExpanded = true">
  +{{ chipOverflowCount }} more
</div>
```

overflow chip 使用 `--overflow` variant 样式（muted 色背景）。

同步更新 `onToggleAll()` 方法中的 count 计算逻辑，改用 `chips.value.length` 而非重新计算。

- [ ] **Step 5: 添加 ThinkingBlock / ToolCallCard import**

在 `<script setup>` 中 import 组件：

```typescript
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'
```

- [ ] **Step 6: 调整样式**

删除 `compact-op__body` 和 `compact-op__body-inner` 的 CSS 规则（由 ToolCallCard/ThinkingBlock 自带样式替代）。保留 `compact-op` 容器的 `border-left` + `padding` 作为视觉层级标识。新增 `compact-chip--overflow` 样式（muted 背景 + 点击交互）。

- [ ] **Step 7: Commit**

```bash
git add src-electron/renderer/src/components/chat/CompactSummaryBar.vue
git commit -m "feat: upgrade CompactSummaryBar to use ToolCallCard/ThinkingBlock + overflow expand"
```

---

### Task 2: CompactStreamingBubble 自动收回 + ChatPanel 联动

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/chat/CompactStreamingBubble.vue`
- Modify: `src-electron/renderer/src/components/panel/ChatPanel.vue`

- [ ] **Step 1: CompactStreamingBubble watch status 变化**

在 CompactStreamingBubble 中，watch `props.message.status`：

```typescript
watch(() => props.message.status, (newStatus) => {
  if (newStatus === 'complete') {
    expanded.value = false
  }
})
```

当 status 从 `streaming` 变为 `complete` 时，自动收起展开状态。无需 emit——ChatPanel 的 `streamingMessage` ref 会在 streaming 结束时变为 `null`，此时 bubble 组件自然卸载，completed 消息通过 `MessageBubble` → `AssistantContent` → `CompactSummaryBar` 路径渲染。

- [ ] **Step 2: 验证 ChatPanel 现有切换逻辑**

ChatPanel 的现有逻辑：
```vue
<CompactStreamingBubble v-if="streamingMessage && settingsStore.compactStreaming" ... />
<StreamingMessage v-else-if="streamingMessage" ... />
```

`streamingMessage` 在 streaming 结束时变为 `null`，此时该消息进入 `agentViews` 的 messages 列表中，以 `MessageBubble` 渲染。`MessageBubble` → `AssistantContent` 中有 `useCompact && !isStreaming` 分支渲染 `CompactSummaryBar`。

**无需修改 ChatPanel**——现有逻辑已满足"streaming 结束 → 自动切换到 SummaryBar"的需求。Task 1 的 Step 1 只需在 CompactStreamingBubble 内部 watch 即可。

- [ ] **Step 3: Commit**

```bash
git add src-electron/renderer/src/components/chat/CompactStreamingBubble.vue
git commit -m "feat: auto-collapse streaming bubble when status becomes complete"
```

---

### Task 3: Lint 验证 + 回归测试

**Type:** frontend

**Files:**
- 无新文件，仅验证

- [ ] **Step 1: 运行 lint**

```bash
npm run lint
```

预期：0 errors, 0 warnings。如有错误，修复后重新运行。

- [ ] **Step 2: 手动回归验证清单**

在 dev 环境（`npm run dev`）中验证：

1. `compactStreaming` 关闭 → 聊天行为完全不变
2. `compactStreaming` 开启 → completed 消息显示 summary bar + chips
3. 点击 chip → 展开操作行，操作行内显示 ToolCallCard/ThinkingBlock 完整渲染
4. 点击 summary bar 空白 → 展开/收起全部
5. streaming 消息显示为紧凑气泡
6. 点击 bubble → 展开完整 streaming 消息
7. streaming 结束 → bubble 自动消失，消息切换为 summary bar
8. overflow > 8 条 → 显示"还有 N 个"，点击后全部展开
9. 文本内容始终正常渲染

- [ ] **Step 3: Commit（如有 lint 修复）**

```bash
git add -A
git commit -m "fix: lint fixes for streaming collapse feature"
```

---

## Execution Groups

#### FG1: Streaming Collapse 核心实现

**Description:** CompactSummaryBar 操作行渲染升级 + overflow 就地展开 + streaming 自动收回。三个功能关联紧密（共享 CompactSummaryBar 组件），放一组。

**Tasks:** Task 1, Task 2, Task 3

**Files (预估):** 2 个文件（0 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: medium） |
| 注入上下文 | spec FR-2/FR-4/FR-5、前端编码规范（Tailwind + xyz-ui + CSS 变量）、ToolCallCard/ThinkingBlock props 接口 |
| 读取文件 | `components/chat/CompactSummaryBar.vue`、`components/chat/CompactStreamingBubble.vue`、`components/chat/ToolCallCard.vue`、`components/chat/ThinkingBlock.vue`、`shared/src/message.ts` |
| 修改/创建文件 | `CompactSummaryBar.vue`、`CompactStreamingBubble.vue` |

**Execution Flow (FG1 内部):** 串行派遣。

  Task 1:
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能→美化
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (与 Task 1 无代码依赖，可并行但建议串行):
    1. general-purpose (read xyz-harness-frontend-dev) → CompactStreamingBubble 改动
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 3 (depends on Task 2):
    1. 主 agent 直接执行 lint + 手动验证

**Dependencies:** 无

## Dependency Graph & Wave Schedule

```
FG1 (核心实现) ──→ 完成
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | FG1 | 前端核心实现，无依赖 |
