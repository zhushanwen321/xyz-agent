---
verdict: fail
must_fix: 1
---

# Robustness Review v1-2

**审查范围**: AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, message-layout.ts, useLiveTimer.ts, compact-utils.ts
**审查日期**: 2026-06-08
**审查维度**: 错误处理 / 异常管理 / 日志 / Fail-fast / 测试友好 / 调试友好
**基准**: v1-1 MF-1（elapsedMs NaN）验证；全面重审

---

## 总览

| 文件 | 严重问题 | 中等问题 | 建议 |
|------|---------|---------|------|
| AgentRunBlock.vue | 1 | 1 | 1 |
| MergeBlock.vue | 0 | 1 | 1 |
| StandaloneToolCard.vue | 0 | 1 | 1 |
| message-layout.ts | 0 | 1 | 1 |
| useLiveTimer.ts | 0 | 1 | 0 |
| compact-utils.ts | 0 | 0 | 1 |

---

## MUST FIX (1)

### MF-1: AgentRunBlock.elapsedMs — complete 分支 startTimes 为空时返回 NaN

**文件**: `AgentRunBlock.vue` L163-167
**严重度**: 高（UI 显示 "NaN"，v1-1 标记后未修复）

```ts
// Complete: max(endTimes) - min(startTimes)
if (endTimes.length === 0) return 0
return endTimes.reduce((a, b) => a > b ? a : b, endTimes[0])
     - startTimes.reduce((a, b) => a < b ? a : b, startTimes[0])
```

**触发条件**: `endTimes.length > 0` 且 `startTimes.length === 0`。

`ToolCall.startTime` 是 optional（`startTime?: number`）。当 toolCall 有 `endTime` 但无 `startTime` 时，`endTimes` 有值而 `startTimes` 为空。`startTimes.reduce(...)` 的初始值 `startTimes[0]` 为 `undefined`，无迭代时返回 `undefined`。`number - undefined = NaN`。

前置守卫 `if (allTimes.length === 0) return 0` 不拦截——`allTimes = [...startTimes, ...endTimes]` 包含 endTimes 的条目，长度 > 0。

**修复**:

```ts
if (endTimes.length === 0) return 0
const maxEnd = endTimes.reduce((a, b) => a > b ? a : b, endTimes[0])
if (startTimes.length === 0) return maxEnd
const minStart = startTimes.reduce((a, b) => a < b ? a : b, startTimes[0])
return maxEnd - minStart
```

---

## SHOULD FIX (4)

### SF-1: MergeBlock template 中 `resolveToolCall(block.refId)!` 非空断言 + 双重调用

**文件**: `MergeBlock.vue` L37-39

```html
<ToolCallCard
  v-else-if="block.type === 'toolCall' && resolveToolCall(block.refId)"
  :tool-call="resolveToolCall(block.refId)!"
/>
```

两个问题叠加：
1. **非空断言 `!`**：`resolveToolCall` 返回 `ToolCall | undefined`，`!` 绕过 TypeScript 类型安全。虽然 `v-if` 保证 truthiness，但模板中 `!` 掩盖了潜在 undefined 传播
2. **双重调用**：`resolveToolCall` 内部执行 `msg.toolCalls?.find(tc => tc.id === refId)`，同一 `block.refId` 被 find 两次（v-if 一次、bind 一次）

**建议**: 用 computed 缓存 resolved blocks，消除双重调用和非空断言：

```ts
const resolvedBlocks = computed(() =>
  props.blocks.map(b => ({
    ...b,
    tc: b.type === 'toolCall' ? resolveToolCall(b.refId) : undefined,
  }))
)
```

模板改为 `<ToolCallCard v-if="block.tc" :tool-call="block.tc" />`。

### SF-2: message-layout.ts `groupIntoSections` 无 msg null 守卫

**文件**: `message-layout.ts` L70

```ts
export function groupIntoSections(msg: Message, standaloneTools?: Set<string>): AssistantSection[] {
  if (msg.contentBlocks?.length) {
```

纯函数直接访问 `msg.contentBlocks`，若 `msg` 为 `null | undefined` 抛 `TypeError`。当前调用方（AgentRunBlock/AssistantContent computed）保证 msg 来自 props，但纯函数作为公共 API 应防御性编程。

**建议**: 加首行 `if (!msg) return []`。

### SF-3: useLiveTimer 无 intervalMs 下限保护

**文件**: `useLiveTimer.ts` L7

```ts
export function useLiveTimer(intervalMs = 200) {
```

传入 `0` 或负数时 `setInterval` 仍执行，频率极高可能卡死主线程。当前调用方均传正数（200/100），但 composable 作为公共 API 应自保。

**建议**: `intervalMs = Math.max(16, intervalMs)` 确保不低于一帧（16ms）。

### SF-4: StandaloneToolCard.elapsedMs 中 `!start` 将 epoch 0 视为 falsy

**文件**: `StandaloneToolCard.vue` L72

```ts
const elapsedMs = computed(() => {
  const start = props.toolCall.startTime
  if (!start) return 0
```

`!start` 将 `0`（epoch）视为 falsy，返回 0。理论上 startTime=0 是合法值（极早期时间戳），虽然实际不会出现。更精确的写法是 `start == null` 或 `start === undefined`。

**建议**: `if (start == null) return 0`。

---

## NICE TO HAVE (4)

### NH-1: MergeBlock streamStatusText 中 toolPath 可能返回 "undefined" 字符串

**文件**: `MergeBlock.vue` `streamStatusText` computed

`toolPath` 解析失败时 fallback 为 `String(input ?? '').slice(0, maxLen)`。若 `input` 是字面量字符串 `"undefined"`，toolPath 返回 `"undefined"`，拼接后显示 `read undefined`。`StandaloneToolCard` 有 `if (!raw || raw === 'undefined') return ''` 防护，但 `MergeBlock` 没有。

**建议**: 在 `streamStatusText` 的 toolPath 返回值上加相同检查。

### NH-2: formatTime 对负数输入无防护

**文件**: `compact-utils.ts` `formatTime`

当前 `AgentRunBlock.elapsedMs` streaming 分支有 `Math.max(0, ...)` 防护，complete 分支修复 MF-1 后也不会产生负值。但 `formatTime` 作为公共函数，若被其他调用方传入负数，输出 `-0.5s` 等无意义字符串。

**建议**: `ms = Math.max(0, ms)` 作为函数首行。

### NH-3: 无 data-* 调试属性

三个组件根元素均无 `data-*` 属性（如 `data-agent-run-id`、`data-merge-block`、`data-tool-call-id`）。调试时无法通过 DOM 快速定位消息/工具对应的组件实例。AgentRunBlock 的 text section 有 `data-message-id`，但其他 section 类型和组件根 div 没有。

### NH-4: AgentRunBlock sections computed 重复 find 同一 toolCall

**文件**: `AgentRunBlock.vue` L93-96

```ts
const sections = computed<EnrichedSection[]>(() =>
  rawSections.value.map(s => ({
    ...s,
    toolCall: s.blocks[0] && (s.type === 'standalone' || s.type === 'customTool')
      ? props.message.toolCalls?.find(tc => tc.id === s.blocks[0].refId)
      : undefined,
  })),
)
```

`message-layout.ts` 的 `isMergeBlock` 已经 find 过一次（决定是否 merge）。`AgentRunBlock` 又 find 一次（提取 toolCall 引用）。toolCalls 数组通常 ≤50，性能可接受，但属于重复查找。可以考虑在 `groupIntoSections` 返回结果中携带 resolved toolCall，或在 AgentRunBlock 侧预构建 `refId → ToolCall` Map。

---

## 维度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 错误处理 | 6/10 | optional chaining 使用良好，但 elapsedMs NaN 路径、null msg、非空断言有遗漏 |
| 异常管理 | 7/10 | 无 async 操作需 try-catch（均为同步计算），toolPath 有 try-catch 降级 |
| 日志 | 3/10 | 仅 toolPath 有 console.warn，其余异常状态静默处理 |
| Fail-fast | 5/10 | `groupIntoTurns` 有空数组守卫，`groupIntoSections` 缺 null 守卫，elapsedMs 缺 empty-array 降级 |
| 测试友好 | 7/10 | `message-layout.ts` 纯函数易测试，useLiveTimer 可 mock，组件逻辑与 composable 耦合适中 |
| 调试友好 | 3/10 | 几乎无 data-* 属性，无调试日志，组件状态不可从 DOM 观察 |

---

## Verdict

```yaml
verdict: fail
must_fix: 1
```

MF-1（elapsedMs complete 分支 NaN）为 v1-1 标记后仍未修复的回归问题。4 个 SHOULD FIX 不阻塞合并但建议本轮处理。修复后可重新提交审查。
