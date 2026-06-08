---
verdict: pass
must_fix: 0
---

# Robustness Review v2

**审查范围**: 验证 v1 标记的 2 个 MUST_FIX 修复
**审查日期**: 2026-06-08
**基准**: robustness_review_v1.md

---

## MUST FIX 验证

### MF-1: MergeBlock timer 泄漏 — ✅ 已修复

**修复前**: `onMounted(() => { if (props.isStreaming) startTimer() })` — isStreaming 变 false 后定时器不停止。

**修复后** (MergeBlock.vue):

```ts
const { now, start: startTimer, stop: stopTimer } = useLiveTimer(200)

watch(() => props.isStreaming, (streaming) => {
  if (streaming) startTimer()
  else stopTimer()
}, { immediate: true })
```

验证:
- [x] 替换为 `watch` + `{ immediate: true }`，等价于 onMounted + 响应式
- [x] `isStreaming` 变 false 时调用 `stopTimer()`，定时器不再泄漏
- [x] 与 AgentRunBlock.vue 的模式一致

### MF-2: AgentRunBlock elapsedMs spread 栈溢出 — ✅ 已修复

**修复前**: `Math.max(...endTimes)` / `Math.min(...allTimes)` — 大数组时 RangeError。

**修复后** (AgentRunBlock.vue):

```ts
// streaming 分支
return liveNow.value - allTimes.reduce((a, b) => a < b ? a : b, allTimes[0])

// complete 分支
return endTimes.reduce((a, b) => a > b ? a : b, endTimes[0])
     - startTimes.reduce((a, b) => a < b ? a : b, startTimes[0])
```

验证:
- [x] 所有 `Math.min(...arr)` / `Math.max(...arr)` 替换为 `reduce`
- [x] streaming 和 complete 两个分支均已处理
- [x] 初始值使用数组首元素（`allTimes[0]` / `endTimes[0]` / `startTimes[0]`），语义正确
- [x] 前置守卫 `if (allTimes.length === 0) return 0` 和 `if (endTimes.length === 0) return 0` 保证 reduce 不在空数组上调用

---

## Verdict

```yaml
verdict: pass
must_fix: 0
```

v1 的 2 个 MUST_FIX 均已正确修复，无新增问题。v1 的 5 个 SHOULD FIX 和 4 个 NICE TO HAVE 不阻塞合并，可后续迭代处理。
