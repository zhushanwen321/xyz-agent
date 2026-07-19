# Code Review：fix-extension-timeout-watchdog

## 审查范围

- W1: extension-timeout-manager.ts + event-interpreter.ts
- W2: AskUserOverlay.vue + event-adapter.ts
- W3: 3 个测试文件

## 审查维度

### design-consistency（设计一致性）

用禁读重建法核对 spec FR/AC：

| FR/AC | 实现状态 | 验证 |
|-------|---------|------|
| FR-1 取消超时 | registerTimeout 不建 timer ✓ | extension-timeout-manager.ts:45-50 |
| FR-2 暂停 watchdog | pauseWatchdog + watchdogPaused ✓ | event-interpreter.ts:376-380 |
| FR-3 恢复 watchdog | resetWatchdog 检测 paused ✓ | event-interpreter.ts:382-394 |
| FR-4 前端倒计时删除 | Clock/import/countdown 全移除 ✓ | AskUserOverlay.vue |
| AC-1 无 stream_warn | WD6 测试覆盖 ✓ | event-interpreter-watchdog.test.ts |
| AC-2 无 cancel | extension-timeout-manager 测试覆盖 ✓ | extension-timeout-manager.test.ts |
| AC-3 watchdog 恢复 | WD7 测试覆盖 ✓ | event-interpreter-watchdog.test.ts |
| AC-4 watchdog 清除 | WD8 测试覆盖 ✓ | event-interpreter-watchdog.test.ts |
| AC-5 无倒计时 UI | 模板无 countdown 元素 ✓ | AskUserOverlay.vue |

### plan-completeness（plan 完成度）

dev-plan.json 的 3 个 wave 全部 committed，changes 列表全部落地。

### edge-case（边界条件）

- watchdogPaused 在 turn-end 时复位 ✓（clearWatchdog）
- 用户不响应时 pi 永挂：设计意图，非 bug
- notify/bridge 分支行为不变 ✓

### test-coverage（测试质量）

- 40 个测试全部通过
- 覆盖：超时取消、watchdog 暂停/恢复/清除、前端无倒计时
- E1 real 层 case 定义（需手动验证）

## 审查结论

无 must-fix / should-fix issue。代码质量通过。
