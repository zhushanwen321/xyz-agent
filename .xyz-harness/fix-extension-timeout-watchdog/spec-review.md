# Spec Review：fix-extension-timeout-watchdog

## 审查方法

禁读重建：从 objective + clarifyRecords 源头信息独立重建 FR/AC 清单，与初稿 diff。

## 重建结果 vs 初稿 diff

### FR 对比

| 重建 FR | 初稿 | 覆盖 |
|---------|------|------|
| 取消 extension UI 超时（所有交互方法不 setTimeout） | FR-1 | ✓ |
| extension-ui 事件暂停 watchdog | FR-2 | ✓ |
| watchdog 恢复条件（message/tool-call-start/tool-call-end/turn-end） | FR-3 | ✓ |
| 前端倒计时移除 | FR-4 | ✓ |

### AC 对比

| 重建 AC | 初稿 | 覆盖 |
|---------|------|------|
| ask-user 不回答无「长时间无响应」 | AC-1 | ✓ |
| ask-user 不回答无 cancel | AC-2 | ✓ |
| 用户响应后 watchdog 恢复 | AC-3 | ✓ |
| turn-end 后 watchdog 清除 | AC-4 | ✓ |
| 前端无倒计时元素 | AC-5 | ✓ |

### 决策对比

| 重建决策 | 初稿 | 覆盖 |
|---------|------|------|
| 所有 extension-ui 统一不超时（不只是 ask-user） | D1 | ✓ |
| 所有 extension-ui 统一暂停 watchdog | D2 | ✓ |
| handleExtensionTimeout 保留不删 | D3 | ✓ |

## 三维度审查

### completeness（完整性）
- objective 诉求全部有 FR 覆盖 ✓
- clarifyRecords 结论已沉淀进 spec ✓
- 无遗漏的隐含需求

### consistency（一致性）
- FR 之间无矛盾 ✓
- AC 与 FR 对齐 ✓
- 术语统一（watchdog / extension-ui / pause / resume）

### reasonableness（合理性）
- 所有 AC 可机器判定（unit test） ✓
- 无过度设计 ✓
- 边界场景已覆盖（pause 后恢复、turn-end 清除）

## 审查结论

spec 就绪，无 must-fix / should-fix issue。可直接进入 plan。
