---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — plugin-arch-remaining-and-ci-fix

## 1. Phase Execution Review

### Summary

Phase 2 产出 5 个交付物（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md），通过 2 轮 review。

plan 评估为 L1 复杂度——4 个独立修复点，无跨系统新概念，无并行前后端设计需求。Execution Groups 分为 FG1（前端接线）、BG1（RPC handler）、BG2（CI 修复），三个 Group 完全独立可并行。

### Problems Encountered

1. **MUST_FIX #1: ToolRegistration.execute 可选性**：初版 plan 将 `execute` 定义为必填字段，忽略了主线程侧 schema 不可序列化 execute 函数的事实（tool-api.ts:62 构造 `{ name, description, parameters }` 对象字面量会触发 TS 编译错误）。Review 正确指出，改为 `execute?: ToolExecuteHandler`。这个遗漏本应在写 plan 时就发现——spec 中已明确"execute 函数不可序列化，仅留在 Worker 进程内"。

2. **MUST_FIX #2: handleMessage 未 export**：plan 要求测试 import `handleMessage` 但未声明需要将其从内部函数改为 export。这是一个 plan 步骤遗漏。

3. **LOW: Windows chmod 缺失**：`elif` 分支只有 `mv` 没有 `chmod +x`，与其他分支行为不一致。第一轮 review 捕获，已修复。

### What Would You Do Differently

- 在写 Task 2 时应该同步考虑"谁调用"和"类型是否兼容"两个维度，而不是只写实现代码。MUST_FIX #1 和 #2 都是"考虑了实现但没考虑调用方"的问题。

### Key Risks for Later Phases

- **Task 2 测试 mock 复杂度**：plugin-bootstrap.ts 顶层有副作用（import parentPort、创建 PluginRpcClient 实例），测试需要 mock `node:worker_threads` 和 `plugin-rpc-client`。实际执行时可能遇到 ESM mock 兼容性问题。
- **Task 4 参数名假设**：extension-service.test.ts 的 `mockImplementation` 回调参数名可能不是 `path`，执行时需要确认实际参数名。

## 2. Harness Usability Review

### Flow Friction

- plan 交付物数量多（5 个文件），但每个内容量不大。对于 L1 复杂度的任务，use-cases.md 和 non-functional-design.md 有点重——大部分内容是"不适用"或简单的 2-3 句话。可以考虑根据复杂度级别调整交付物要求：L1 可以合并 use-cases.md 和 non-functional-design.md 到 plan.md 的附录章节。

### Gate Quality

- Gate 检查完整，无 false positive。

### Prompt Cliction

- writing-plans SKILL.md 对 L1/L2 分级的标准清晰，Execution Groups 模板格式明确。Step-by-step 任务模板也很实用。

### Automation Gaps

- **Self-Review checklist 可以自动化**：placeholder scan（grep TBD/TODO）、type consistency（对比多个 step 中的类型签名）可以做成脚本。当前需要人工扫描。

### Time Sinks

- 无明显时间浪费。Plan 编写和 review 总共约 3 轮迭代，每轮改动量小。
