---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 2
  dimensions_checked: 6
  issues_found: 3
  must_fix_count: 0
  low_count: 2
  info_count: 1
  duration_estimate: "8"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-06-07 22:14
- 审查文件数：2（CompactSummaryBar.vue, CompactStreamingBubble.vue）
- 审查维度：D1-D6（全量）

## 变更摘要

本次 diff 涉及两个 Vue 组件：

1. **CompactStreamingBubble.vue** — 新增 `watch(message.status)` 自动折叠逻辑（streaming 结束时 collapse）
2. **CompactSummaryBar.vue** — 重构 chips/items 为 refId 懒解析模式；新增 chip 类型 overflow（>4 类型折叠）、item overflow（>8 项折叠）；body 渲染从 inline text 改为 ThinkingBlock/ToolCallCard 组件

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 5 | 5 | 0 | 10/10 |
| D2 异常处理 | 4 | 4 | 0 | 10/10 |
| D3 日志 | 3 | 3 | 0 | 10/10 |
| D4 Fail-fast | 4 | 3 | 1 | 8/10 |
| D5 测试友好性 | 3 | 2 | 1 | 7/10 |
| D6 调试友好性 | 3 | 3 | 0 | 10/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | LOW | D4 | `resolveToolCall()` 可能返回 `undefined`，模板中用非空断言 `!` | CompactSummaryBar.vue | L55 | 改为条件渲染或提供 fallback，消除 TS 非空断言 |
| 2 | LOW | D5 | `itemOverflowExpanded` 用 reactive Set + 索引号，chip 顺序变化时索引失效 | CompactSummaryBar.vue | L131 | 可接受（chip 列表是 computed 每次重建、expanded Set 短生命周期），但纯函数方案更易测试 |
| 3 | INFO | D4 | `visibleItems()` 中 `index` 参数在非 overflow 分支下未使用 | CompactSummaryBar.vue | L142 | 仅代码气味，不影响健壮性 |

## 逐文件详情

### CompactStreamingBubble.vue（+7 行）

变更：新增 `watch(() => props.message.status)` 当 status 变为 `'complete'` 时自动折叠。

**D1 错误处理:**
- ✅ `newStatus` 只在 `'complete'` 时操作，其他状态值（`'error'`、`'streaming'`）安全忽略
- ✅ timer 清理已在 `onBeforeUnmount` 中处理，不泄漏

**D2 异常处理:**
- ✅ 无 try/catch，watch 回调是简单赋值操作，无需异常保护

**D3 日志:**
- ✅ 无需日志（纯 UI 状态变更）

**D4 Fail-fast:**
- ✅ `message.status` 类型为 `MessageStatus = 'streaming' | 'complete' | 'error'`，watch 检查 `=== 'complete'` 严格匹配
- ✅ `expanded.value = false` 不依赖前置状态，幂等安全

**D5 测试友好性:**
- ✅ watch 逻辑简单，可直接通过修改 props.message.status 触发验证

**D6 调试友好性:**
- ✅ 行为语义明确（streaming 结束 → collapse），有注释说明

### CompactSummaryBar.vue（+114/-17 行）

变更核心：
1. `CompactChipItem` 移除 `body` 字段，新增 `refId` 字段
2. 新增 `resolveThinking`/`resolveToolCall` 按 refId 查找原始数据
3. 模板从 `item.body` 改为 ThinkingBlock/ToolCallCard 组件渲染
4. 新增 chip 类型 overflow（`MAX_VISIBLE_CHIPS=4`）和 item overflow（`MAX_VISIBLE_ITEMS=8`）

**D1 错误处理:**
- ✅ `resolveThinking()` 返回 `ThinkingBlockType | undefined`，`resolveThinkingText()` 用 `?? ''` 安全降级
- ✅ `toolPath()` 解析 input 时有 try/catch + `console.warn` + fallback 到原始字符串截断
- ✅ chipData 中 `msg.thinking?.length` 和 `msg.toolCalls` 可选链安全
- ✅ `formatTime()` 参数为 0 时返回空字符串，不会 NaN
- ✅ `visibleChips`/`visibleItems` 数组 slice 不会越界

**D2 异常处理:**
- ✅ `toolPath()` 的 catch 块有 `console.warn` 输出 + eslint-disable 注释说明原因（优雅降级）
- ✅ 无其他可能抛异常的代码路径

**D3 日志:**
- ✅ `toolPath()` 解析失败时 `console.warn('[CompactSummaryBar] toolPath parse error:', e)` — 包含组件名和错误对象
- ✅ 无敏感数据泄露风险（path/command 不含认证信息）

**D4 Fail-fast:**
- ⚠️ **#1** L55 模板中 `:tool-call="resolveToolCall(item.refId)!"` 使用 TS 非空断言。如果 refId 因数据不一致（thinking 数组或 toolCalls 数组在 computed 缓存后被修改）找不到对应元素，`ToolCallCard` 将收到 `undefined`。运行时 Vue 不会因此崩溃（prop 验证会发出 warning），但语义上不够严谨。建议改为条件渲染 `v-if="tc"` 或在 resolver 中提供空对象 fallback
- ✅ chipData 中 thinking blocks 和 tool calls 均从 `msg` 中提取，refId 指向同一条 message 的数据，理论上不丢失
- ✅ `chipOverflowCount` 和 `overflow` 计算使用 `Math.max(0, ...)` 确保非负

**D5 测试友好性:**
- ⚠️ **#2** `itemOverflowExpanded` 使用 `reactive(new Set<number>())` 存储已展开的 chip 索引。索引号依赖 `visibleChips` computed 的顺序。如果 chip 来源顺序变化（例如新增 thinking block 后 computed 重建），索引可能错位。实际风险低（expanded Set 是组件局部状态、用户交互短生命周期），但纯函数 + key-based（如 chip.type + chip.typeLabel）更稳健且更易测试
- ✅ `chipData()` 是纯函数，可独立测试
- ✅ `formatTime()`/`toolPath()` 是纯函数，可独立测试
- ✅ resolve 函数依赖 `props.message`，可通过 mock props 测试

**D6 调试友好性:**
- ✅ `console.warn` 包含组件名前缀 `[CompactSummaryBar]`，便于定位
- ✅ chip 溢出显示 `+N more`，item 溢出显示 `还有 N 个`，信息充分
- ✅ refId 机制保留了从 chip item 到原始数据对象的引用链

## 结论

**通过。** 两个组件的健壮性良好。错误处理路径完整（可选链、try/catch + 降级、Math.max 防负数），无静默吞异常、无敏感数据泄露、无未清理资源。两处 LOW 级建议（非空断言和索引键）是代码质量改进而非健壮性风险，可在后续迭代中处理。
