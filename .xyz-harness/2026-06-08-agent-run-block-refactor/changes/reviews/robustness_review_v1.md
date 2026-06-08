---
verdict: fail
must_fix: 2
---

# Robustness Review v1

**审查范围**: AgentRunBlock.vue, MergeBlock.vue, StandaloneToolCard.vue, message-layout.ts, useLiveTimer.ts
**审查日期**: 2026-06-08
**审查维度**: 错误处理 / 异常管理 / 日志 / Fail-fast / 测试友好 / 调试友好

---

## 总览

| 文件 | 严重问题 | 中等问题 | 建议 |
|------|---------|---------|------|
| AgentRunBlock.vue | 1 | 2 | 1 |
| MergeBlock.vue | 1 | 1 | 1 |
| StandaloneToolCard.vue | 0 | 1 | 2 |
| message-layout.ts | 0 | 1 | 2 |
| useLiveTimer.ts | 0 | 0 | 1 |

---

## MUST FIX (2)

### MF-1: MergeBlock timer 泄漏 — isStreaming 变为 false 后不停止

**文件**: `MergeBlock.vue` L73-75
**严重度**: 高（内存/CPU 泄漏）

```ts
onMounted(() => {
  if (props.isStreaming) startTimer()
})
```

只在 mount 时判断 `isStreaming`，之后 `isStreaming` 变为 `false` 时 **不会停止定时器**。定时器持续触发直到组件卸载。

对比 `AgentRunBlock.vue` 的正确做法：

```ts
watch(() => props.isStreaming, (streaming) => {
  if (streaming) startTimer()
  else stopTimer()
}, { immediate: true })
```

**修复**: 将 `onMounted` 替换为带 `{ immediate: true }` 的 `watch`，并在 `isStreaming` 变 false 时调用 `stopTimer()`。

---

### MF-2: AgentRunBlock elapsedMs — spread 操作符大数组栈溢出

**文件**: `AgentRunBlock.vue` L108-119
**严重度**: 中（边界条件下崩溃）

```ts
const allTimes = [...startTimes, ...endTimes]
// ...
return Math.max(...endTimes) - Math.min(...startTimes)
```

`Math.min(...arr)` / `Math.max(...arr)` 使用 spread 将数组展开为函数参数。当数组长度超过 JS 引擎的函数参数上限（V8 约 65535），会抛出 `RangeError: Maximum call stack size exceeded`。

正常对话不会有这么多 toolCalls，但代码应健壮处理。同样问题在 streaming 分支：

```ts
return liveNow.value - Math.min(...allTimes)
```

**修复**: 用 `reduce` 替代 spread：

```ts
const minTime = allTimes.reduce((a, b) => Math.min(a, b), Infinity)
const maxEnd = endTimes.reduce((a, b) => Math.max(a, b), -Infinity)
```

---

## SHOULD FIX (5)

### SF-1: StandaloneToolCard 重复实现定时器，未复用 useLiveTimer

**文件**: `StandaloneToolCard.vue` L37-60
**维度**: 测试友好 / 一致性

组件自建 `setInterval` 逻辑（100ms 间隔），但项目已有 `useLiveTimer` composable（200ms）。两个实现并存导致：
- 行为不一致（100ms vs 200ms 刷新率）
- 维护成本翻倍（两处 timer 逻辑）
- 无法统一测试

**建议**: 替换为 `useLiveTimer(100)`，保持与 MergeBlock/AgentRunBlock 相同的模式。

---

### SF-2: AgentRunBlock 模板中非空断言 `!` 绕过类型安全

**文件**: `AgentRunBlock.vue` L32-34, L39-41

```html
<StandaloneToolCard
  v-else-if="section.type === 'standalone' && resolveToolCall(section.blocks[0]?.refId)"
  :tool-call="resolveToolCall(section.blocks[0].refId)!"
/>
```

`section.blocks[0]?.refId` 在 v-if 中用了 optional chain，但在 `:tool-call` 绑定中用 `section.blocks[0].refId`（无 `?.`）。虽然 v-if 保证了不会进入此分支，但 `refId` 传给 `resolveToolCall` 时，TypeScript 类型期望 `string` 而非 `string | undefined`。

更根本的问题：`resolveToolCall` 签名为 `(refId: string)` 但调用点传入了可能为 `undefined` 的值（`section.blocks[0]?.refId`），TypeScript 在模板中的类型检查可能遗漏。

**建议**: 两种方案选一：
1. 在 `resolveToolCall` 中加 `if (!refId) return undefined` 防护（推荐）
2. 用 computed 缓存 resolved toolCall，模板直接引用

---

### SF-3: message-layout.ts 无输入校验，null msg 直接崩溃

**文件**: `message-layout.ts` L50 `groupIntoSections`

```ts
export function groupIntoSections(msg: Message, standaloneTools?: Set<string>): AssistantSection[] {
  if (msg.contentBlocks?.length) {
```

如果 `msg` 为 `null | undefined`，直接访问 `msg.contentBlocks` 会抛 `TypeError`。当前调用方（AgentRunBlock 的 computed）保证 msg 来自 props，但纯函数应防御性编程。

**建议**: 加首行守卫：

```ts
if (!msg) return []
```

---

### SF-4: formatTime 对负数输入无防护

**文件**: `compact-utils.ts` → 被 AgentRunBlock/MergeBlock/StandaloneToolCard 使用

```ts
export function formatTime(ms: number): string {
  if (ms < MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(1)}s`
```

当 `ms < 0`（理论上可能：`endTime < startTime` 数据异常），输出 `-0.5s` 等负时间字符串。

**建议**: 加 `ms = Math.max(0, ms)` 或在调用点 `formatTime(Math.max(0, elapsedMs.value))`。

---

### SF-5: useLiveTimer 无 intervalMs 参数校验

**文件**: `useLiveTimer.ts`

```ts
export function useLiveTimer(intervalMs = 200) {
```

如果传入 `0` 或负数，`setInterval` 仍会执行但频率极高，可能卡死主线程。

**建议**: 加 `intervalMs = Math.max(16, intervalMs)` 确保不低于一帧。

---

## NICE TO HAVE (4)

### NH-1: AgentRunBlock 步数统计包含 'customTool' 但不计入工具操作数

**文件**: `AgentRunBlock.vue` L91-92, L95-99

`stepCount` 过滤 `s.type !== 'text'`，意味着 `merge`、`standalone`、`customTool` 都算"步"。但 `standaloneToolCount` 只统计 `standaloneToolsSet` 中的工具名，custom tools 被排除。UI 语义上可能造成困惑：显示 "5 步 · 2 次工具操作"，但实际可能有 3 个 custom tool 调用未被计入。

### NH-2: MergeBlock streamStatusText 中 toolPath 可能返回 "undefined" 字符串

**文件**: `MergeBlock.vue` L89

```ts
const p = toolPath(runningTc.input)
return p ? `${runningTc.toolName} ${p}` : `${runningTc.toolName}...`
```

`toolPath` 在解析失败时返回 `String(input ?? '').slice(0, maxLen)`。如果 `input` 是 `undefined`，返回空字符串，三元判断走 else 分支——行为正确。但如果 `input` 是字符串 `"undefined"`，会返回 `"undefined"` 并拼接到状态文本中。`StandaloneToolCard` 中有额外检查 `if (!raw || raw === 'undefined') return ''`，但 `MergeBlock` 没有。

### NH-3: 无 data-* 调试属性

所有三个组件的根元素均无 `data-*` 属性（如 `data-agent-run-id`、`data-merge-block`、`data-tool-call-id`）。调试时无法通过 DOM 快速定位消息/工具对应的组件实例。

AgentRunBlock 中 text section 有 `data-message-id` 和 `data-markdown-source`，但组件根 div 和其他 section 类型没有。

### NH-4: groupByContentBlocks 中两次 find 同一个 toolCall

**文件**: `message-layout.ts` L79-82

```ts
} else if (block.type === 'toolCall') {
  const tc = msg.toolCalls?.find(t => t.id === block.refId)
  const isCustom = tc ? !(ALL_PI_TOOLS as readonly string[]).includes(tc.toolName) : false
```

`isMergeBlock` 已经 `find` 过一次，非 merge 的 toolCall 分支又 `find` 一次。虽然 `find` 性能可接受（数组小），但可以优化为一次查找同时决定 merge/standalone/customTool。

---

## 维度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 错误处理 | 6/10 | optional chaining 使用良好，但 null msg、负数时间、非空断言有遗漏 |
| 异常管理 | 7/10 | 无 async 操作需要 try-catch（均为同步计算），formatTime/compact-utils 有降级 |
| 日志 | 3/10 | 几乎无 console.warn/error，异常状态静默处理 |
| Fail-fast | 5/10 | `groupIntoTurns` 有空数组守卫，`groupIntoSections` 缺 null 守卫 |
| 测试友好 | 6/10 | `message-layout.ts` 为纯函数，易测试；组件逻辑与 composable 耦合适中 |
| 调试友好 | 3/10 | 几乎无 data-* 属性，无调试日志，组件状态不可从 DOM 观察 |

---

## Verdict

```yaml
verdict: fail
must_fix: 2
```

MF-1（timer 泄漏）和 MF-2（spread 栈溢出）为必须修复项。修复后可重新提交审查。
