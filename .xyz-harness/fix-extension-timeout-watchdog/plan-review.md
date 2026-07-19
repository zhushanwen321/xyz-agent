# Plan Review：fix-extension-timeout-watchdog

## 审查方法

禁读重建：从 spec FR/AC 独立重建 wave 拆分，与 dev-plan.json 初稿 diff。

## 重建结果 vs 初稿 diff

### FR → Wave 映射

| 重建 Wave 归属 | 初稿 | 覆盖 |
|---------------|------|------|
| FR-1 取消超时 → runtime timeout manager 改动 | W1 extension-timeout-manager.ts | ✓ |
| FR-2 暂停 watchdog → event-interpreter 改动 | W1 event-interpreter.ts | ✓ |
| FR-3 恢复 watchdog → event-interpreter 改动 | W1 event-interpreter.ts | ✓ |
| FR-4 前端倒计时 → AskUserOverlay.vue | W2 AskUserOverlay.vue | ✓ |

### Wave 结构对比

| 维度 | 重建 | 初稿 | 一致 |
|------|------|------|------|
| runtime 核心逻辑独立 wave | W1 | W1 | ✓ |
| 前端 UI 独立 wave | W2 | W2 | ✓ |
| 测试依赖实现后置 | W3 dependsOn [W1,W2] | W3 dependsOn [W1,W2] | ✓ |

## 三维度审查

### coverage（覆盖度）
- spec 4 个 FR 全部有 wave + changes 落地 ✓
- 5 个 AC 在 W3 测试 wave 中可验证 ✓
- 无遗漏 FR

### architecture（架构合理性）
- W1/W2 并行无依赖 ✓
- W3 依赖 W1/W2（测试需要实现） ✓
- 每个 wave 1-3 个文件 ✓
- 无循环依赖

### feasibility（可行性）
- 所有 changes 描述具体可执行 ✓
- 无外部依赖 ✓
- 每个 wave 可在单个 dev cycle 完成 ✓

## 审查结论

plan 就绪，无 must-fix / should-fix issue。可直接进入 tdd_plan。
