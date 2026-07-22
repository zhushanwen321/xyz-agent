# Review: fix-scroll-jump-during-streaming

## 审查范围

- commit: ba26c322（W1）
- 文件：packages/renderer/src/components/panel/MessageStream.vue（补偿 watch + useChatScroll 解构）+ packages/renderer/src/__tests__/effects/message-stream-scroll-guard.test.ts（新增测试）
- 方法：fresh subagent 禁读重建（design-consistency）+ 主 agent 直读实现核验其他维度

## Standards 组（代码符合规范吗）

### 维度核验

| dimension | 发现 |
|-----------|------|
| type-safety | `stickToBottom` 是 `Ref<boolean>`，回调内读 `.value` 得 boolean，`if (stickToBottom.value)` 类型正确。无 any。通过 |
| error-handling | 回调内无 catch/throw 场景，无需错误处理。通过 |
| edge-case | `delta !== 0 && scrollEl.value` 守卫保留（delta=0 或 scrollEl 未挂载不进入）。清零在 if 外层，两分支都执行。通过 |
| test-coverage | AC1 红灯转绿（真 bug 防线）+ AC2/AC3 回归保护。flushHeightReports 生产侧补偿逻辑已有 use-virtual-turn-list.test.ts 14 单测覆盖。通过 |
| plan-completeness | W1 changes（MessageStream.vue modify）已落地，解构补 stickToBottom ✓，watch 加 guard ✓。通过 |

### Fowler 12 smell

无命中。改动是给既有 watch 加一个 guard 分支 + 解构补一个字段，无重复代码/特性嫉妒/数据泥团等。

### Standards 组发现数：0

## Spec 组（代码忠实实现 spec 吗）

### 禁读重建 checklist 对照（6 FR + 3 AC）

| ref | 期望（subagent 重建） | 实现（384-410 行） | 结论 |
|-----|----------------------|-------------------|------|
| FR1 | guard 读实时 stickToBottom.value，false 时不走 +=delta | `if (stickToBottom.value) { scrollTop += delta }` | ✓ |
| FR2 | false 分支清零（不延后） | 清零在 if 外层，两分支都清零 | ✓ |
| FR3 | true 分支保留原语义 | true 分支 scrollTop+=delta，清零两分支都做 | ✓ |
| FR4 | 不写 stickToBottom/unreadBelow/rafId，不碰 cancelAnimationFrame | 回调只写 scrollTop 和 scrollAdjustDelta | ✓ |
| FR5 | 回调内读 .value 非缓存 | `stickToBottom.value` 在回调内直接读 | ✓ |
| FR6 | 解构 stickToBottom，guard 留 MessageStream 不下沉 | 解构已补，guard 在 MessageStream watch 内 | ✓ |
| AC1 | 代码能证明 false+delta≠0 不施加 | if 包裹证明 | ✓ |
| AC2 | 清零无条件于 delta 符号 | 清零在 if 外，对正负 delta 都执行 | ✓ |
| AC3 | git diff 仅加 if 包裹语义未改 | diff 确认仅 if 包裹 | ✓ |

### subagent concerns 核验（6 条）

| concern | severity | 核验结论 |
|---------|----------|---------|
| watch self-trigger（清零再触发自身） | should-fix | 回调开头 `if (delta !== 0 && scrollEl.value)` 守卫，清零后 delta=0 下次触发直接跳过。无重入。**非问题** |
| flush:'post' 与 stickToBottom 写入时序 | should-fix | onWheel 同步写 stickToBottom=false，wheel 事件（task 阶段）先于 flush:'post' watch（DOM flush 后）同帧执行。FR5 满足。**非问题** |
| scrollAdjustDelta 其他写入点旁路 | should-fix | grep 确认：useVirtualTurnList.flushHeightReports（生产）+ resetSession（清零）+ MessageStream watch（消费清零）。无其他写入点，无旁路。**非问题** |
| 测试盲区 AC1/AC2 无自动化 | should-fix | subagent 禁读实现未知：message-stream-scroll-guard.test.ts 已覆盖 AC1/AC2/AC3。**非问题** |
| watch 改自己监听的源（坏味道） | nit | 这是既有模式（原实现就如此清零），清零必要。加注释已说明。**非问题** |
| delta NaN/Infinity 兜底 | nit | 源头是 RO borderBoxSize（DOM 产出有限数），useVirtualTurnList.totalHeight 已有 Number.isFinite 兜底。**非本次范围** |

### Spec 组发现数：0

## 总结

- **Standards 组**：0 个发现
- **Spec 组**：0 个发现（6 FR + 3 AC 全部正确实现，6 个 concerns 经核验均为 subagent 禁读导致的误判或既有保护已覆盖）

实现忠实于 spec，无 must-fix / should-fix。进 test。
