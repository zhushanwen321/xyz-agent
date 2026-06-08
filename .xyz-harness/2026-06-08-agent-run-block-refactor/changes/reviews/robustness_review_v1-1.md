# Robustness Review v1-1

**审查范围**: AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, message-layout.ts, useLiveTimer.ts, compact-utils.ts
**审查日期**: 2026-06-08
**审查维度**: 错误处理 / 异常管理 / 日志 / Fail-fast / 测试友好 / 调试友好
**基准**: robustness_review_v1.md（v1 MF-1/MF-2 已修复，v1-1 为完整重审）

---

## 总览

| 文件 | 严重问题 | 中等问题 | 建议 |
|------|---------|---------|------|
| AgentRunBlock.vue | 1 | 1 | 1 |
| MergeBlock.vue | 0 | 1 | 1 |
| StandaloneToolCard.vue | 0 | 0 | 1 |
| message-layout.ts | 0 | 1 | 1 |
| useLiveTimer.ts | 0 | 1 | 0 |
| compact-utils.ts | 0 | 0 | 1 |

---

## MUST FIX (1)

### MF-1: AgentRunBlock elapsedMs — complete 分支 startTimes 为空时返回 NaN

**文件**: `AgentRunBlock.vue` `elapsedMs` computed，L108-119
**严重度**: 高（UI 显示 "NaN"，数据模型允许触发）

```ts
// Complete: max(endTimes) - min(startTimes)
if (endTimes.length === 0) return 0
return endTimes.reduce((a, b) => a > b ? a : b, endTimes[0])
     - startTimes.reduce((a, b) => a < b ? a : b, startTimes[0])
```

**触发条件**: `endTimes.length > 0` 且 `startTimes.length === 0`。

`ThinkingBlock` 的 `startTime` 和 `endTime` 均为 optional（`startTime?: number`）。当 thinking block 有 `endTime` 但无 `startTime` 时，`endTimes` 有值而 `startTimes` 为空。`startTimes.reduce(...)` 的初始值 `startTimes[0]` 为 `undefined`，无迭代时返回 `undefined`。`number - undefined = NaN`。

前置守卫 `if (allTimes.length === 0) return 0` 不拦截此场景——`allTimes = [...startTimes, ...endTimes]` 包含 endTimes 的条目，长度 > 0。

**修复**:

```ts
if (endTimes.length === 0) return 0
const maxEnd = endTimes.reduce((a, b) => a > b ? a : b, endTimes[0])
if (startTimes.length === 0) return maxEnd  // 降级：只有 endTime 没有 startTime
const minStart = startTimes.reduce((a, b) => a < b ? a : b, startTimes[0])
return maxEnd - minStart
```

---

## SHOULD FIX (4)

### SF-1: MergeBlock template 中 `resolveToolCall(block.refId)!` 非空断言

**文件**: `MergeBlock.vue` L44-46

```html
<ToolCallCard
  v-else-if="block.type === 'toolCall' && resolveToolCall(block.refId)"
  :tool-call="resolveToolCall(block.refId)!"
/>
```

`v-if` 保证了 truthiness，`!` 在运行时安全。但 `resolveToolCall` 调用了两次（v-if 一次、bind 一次），且 TypeScript 类型推断在模板中可能不严格。若 `resolveToolCall` 内部逻辑变化（如缓存失效），双重调用可能返回不同结果。

**建议**: 用 `v-slot` 或 computed 缓存 resolved toolCall，消除双重调用和非空断言。

### SF-2: message-layout.ts `groupIntoSections` 无 msg null 守卫

**文件**: `message-layout.ts` L50

```ts
export function groupIntoSections(msg: Message, standaloneTools?: Set<string>): AssistantSection[] {
  if (msg.contentBlocks?.length) {
```

纯函数直接访问 `msg.contentBlocks`，若 `msg` 为 `null | undefined` 抛 `TypeError`。当前调用方（AgentRunBlock computed）保证 msg 来自 props，但纯函数应防御性编程。

**建议**: 加首行 `if (!msg) return []`。

### SF-3: useLiveTimer 无 intervalMs 下限保护

**文件**: `useLiveTimer.ts` L8

```ts
export function useLiveTimer(intervalMs = 200) {
```

传入 `0` 或负数时 `setInterval` 仍执行，频率极高可能卡死主线程。当前调用方均传正数（200/100），但 composable 作为公共 API 应自保。

**建议**: `intervalMs = Math.max(16, intervalMs)` 确保不低于一帧。

### SF-4: formatTime 负数输入输出负时间字符串

**文件**: `compact-utils.ts` L12

```ts
export function formatTime(ms: number): string {
  if (ms < MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(1)}s`
```

若 `ms < 0`（理论上：endTime < startTime 数据异常），输出 `-0.5s` 等。当前 AgentRunBlock 的 `elapsedMs` 在 complete 分支修复 MF-1 后不会产生负值，但 `formatTime` 作为公共函数应自保。

**建议**: `ms = Math.max(0, ms)` 或在调用点防护。

---

## NICE TO HAVE (3)

### NH-1: MergeBlock streamStatusText 中 toolPath 可能返回 "undefined" 字符串

**文件**: `MergeBlock.vue` L89

`toolPath` 解析失败时 fallback 为 `String(input ?? '').slice(0, maxLen)`。若 `input` 是字面量字符串 `"undefined"`，toolPath 返回 `"undefined"`，拼接到状态文本中显示为 `read undefined`。`StandaloneToolCard` 有 `if (!raw || raw === 'undefined') return ''` 防护，但 `MergeBlock` 没有。

### NH-2: AgentRunBlock sections computed 多次 find 同一 toolCall

**文件**: `AgentRunBlock.vue` L87-93

`sections` computed 中每个 section 调用 `props.message.toolCalls?.find(tc => tc.id === s.blocks[0].refId)`。`message-layout.ts` 的 `groupByContentBlocks` 已经 find 过一次（`isMergeBlock` 内部）。两处重复查找。当前 toolCalls 数组小，性能可接受，但可优化为一次查找。

### NH-3: 无 data-* 调试属性

三个组件根元素均无 `data-*` 属性（如 `data-agent-run-id`、`data-merge-block`、`data-tool-call-id`）。调试时无法通过 DOM 快速定位消息/工具对应的组件实例。AgentRunBlock 的 text section 有 `data-message-id`，但其他 section 类型和组件根 div 没有。

---

## 维度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 错误处理 | 6/10 | optional chaining 使用良好，但 elapsedMs NaN 路径、null msg、负数时间有遗漏 |
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

MF-1（elapsedMs complete 分支 NaN）为必须修复项。4 个 SHOULD FIX 不阻塞合并但建议本轮处理。修复后可重新提交审查。
