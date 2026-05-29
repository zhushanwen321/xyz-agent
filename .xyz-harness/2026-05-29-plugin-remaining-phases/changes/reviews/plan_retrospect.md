---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — plugin-remaining-phases

## 1. Phase Execution Review

### Summary

完成了插件系统剩余功能的实施计划。L1 复杂度，7 个 Task，3 个 Wave，5 个 Execution Group（BG1/BG2/BG3/FG1/PG1）。关键决策：

1. **BG1 成为 plugin-service.ts 唯一 owner**——将 Session API、Agent API、SessionData 持久化、UI 弹窗 backend 全部合并到一个 Group，避免并行写同一文件
2. **EventAdapter hook 注入走 EventAdapterOptions 回调模式**——复用已有的 onExtensionUIRequest 模式，不直接引用 PluginService
3. **SessionData 持久化放在 plugin-storage.ts**——与现有 PluginStorage 模式统一

产出 5 个文档：plan.md（含 Interface Contracts + Spec Coverage Matrix）、e2e-test-plan.md（10 个 TS）、use-cases.md（5 个 UC）、non-functional-design.md（5 个维度）、test_cases_template.json（21 个 TC）。

### Problems Encountered

1. **Plan review 三轮才通过**：
   - v1: 7 条 MUST FIX——最严重的是 Wave 1 并行文件冲突（BG1/BG2/BG4 同时修改 plugin-service.ts）和 index.ts 实例化调用点缺失
   - v2: 1 条 MUST FIX——旧 Task 7（UI 弹窗 Backend）与 Task 1 Step 7 重叠，删除旧 Task 后解决
   - v3: 通过
   - **根因**：首次编写 plan 时低估了"多个 Group 修改同一文件"的并行冲突风险。初始设计按功能分 Group（Session/Agent/UI 各一个），但忽略了它们都修改 plugin-service.ts 这一事实。修复方案是将所有 plugin-service.ts 修改集中到 BG1。

2. **Task 编号重组导致大量编辑**：从原始 10 个 Task 合并/重编号为 7 个 Task 时，Execution Groups、Wave Schedule、Spec Coverage Matrix、Spec Metrics Traceability 中的 Task 引用需要全部更新。两次大 edit 操作，容易遗漏。

3. **EventAdapter hook 注入机制初始描述不实**：Task 6（原版）引用了 `onBridgeIntercept` 方法，但代码中不存在此方法。Review subagent 正确识别了这个问题。修复后明确了完整的注入路径：EventAdapterOptions 新增回调 → index.ts 注入 → event-adapter translate() 中调用。

### What Would You Do Differently

1. **先画文件冲突矩阵再设计 Execution Groups**：列出每个 Task 修改的文件，找出冲突点，然后基于冲突矩阵决定 Group 划分。本次是先按功能分组，review 后才发现冲突，被迫重组。
2. **首次编写时就验证方法名是否存在**：`onBridgeIntercept` 是臆造的方法名。写 plan 前应该 grep 确认实际 API。

### Key Risks for Later Phases

1. **BG1 Task 1 是超级 Task（9 steps）**：包含 4 个 FR 的所有 plugin-service.ts 修改。单个 subagent 需要处理大量变更，如果 subagent 上下文不足可能遗漏。
2. **BG3 Task 4（Hook 桥接）仍然最高风险**：EventAdapterOptions 扩展 + 异步 hook 回调 + event-adapter case 修改，涉及运行时消息流的核心路径。
3. **index.ts 被多个 Group 修改**（BG1 Task 1 + BG3 Task 4）：虽然不在同一 Wave，但 Task 4 在 Task 1 之后修改同一文件，需要 subagent 正确处理已有变更。

## 2. Harness Usability Review

### Flow Friction

1. **Review 三轮是正常的，但每轮 edit 量过大**：v1 到 v2 的修复涉及 11 个 edit block（File Structure 6 个 + Task 内容 11 个 + Execution Groups 6 个），单个 edit 调用失败会导致后续全部失败。建议 plan 首次编写时就更仔细地检查文件冲突，减少 review 轮次。

2. **File Structure 表需要在 Task 变更后手动同步**：Task 编号重组后 File Structure 中的 Group 列、Task 文件列表都需要手动更新。没有自动校验机制。

### Gate Quality

Gate check 脚本检查了 10 项（untracked files、verdict、complexity、e2e-test-plan、test_cases、use-cases、non-functional-design、plan_bl_review skip、review verdict、must_fix）。全部正确通过，无 false positive。

### Prompt Clarity

writing-plans skill 的 L1/L2 评估指导清晰。Execution Groups 模板详细。Interface Contracts 模板实用。唯一不足：**没有明确提到"检查同一文件是否被多个 Group 修改"**，这是 plan review 中才发现的问题。

### Automation Gaps

1. **文件冲突检测可以自动化**：扫描 File Structure 表中同一文件出现多次的行，标记为"并行冲突风险"。这应该是 gate check 或 Self-Check 的一部分。

### Time Sinks

1. **11 个 edit block 的修复操作**占了总时间的 ~50%。如果首次编写时就正确处理了文件冲突和 index.ts，可以省掉 v2 和 v3 两轮。
2. **Subagent scan 精确度高但耗时**：深度扫描（行号级别的 stub 定位）对 plan 编写帮助很大，但 scan 本身耗时较长。这是必要的投入。
