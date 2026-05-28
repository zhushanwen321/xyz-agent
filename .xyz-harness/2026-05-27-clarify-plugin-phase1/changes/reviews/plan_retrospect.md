---
phase: plan
verdict: pass
---

# Phase Retrospect — Phase 2 (Plan)

## Phase Execution Review

### Summary

Phase 2 产出 11 个交付物：plan.md 总纲（20KB）、plan-backend.md（1714 行）、plan-frontend.md（144 行）、plan-api-contract.md（34KB）、use-cases.md（8 个 UC）、non-functional-design.md（5 维度）、e2e-test-plan.md（6 TS）、test_cases_template.json（16 TC）、interface_chain.json（35 methods + 7 data flows）、plan_bl_review_v1.md，以及 plan_review_v1.md（通过，0 MUST_FIX / 5 LOW）。

L2 复杂度评估正确——插件系统涉及新领域建模（Plugin 生命周期）、新存储引擎（KV file-based）、跨进程异步通信（Worker Thread RPC），多维度命中 L2。

ADR 评估执行完毕，结论为无需新增 ADR（spec 阶段已记录全部关键决策）。

### Problems Encountered

1. **plan-backend subagent 标记 failed 但文件实际写完**：并行派发的 2 个 subagent 中，plan-backend 那个输出 token 过多触发 limit，被系统标记为 terminated/failed。但文件实际已完整写入（1714 行，10 个章节覆盖全部 FR）。如果盲目重试会浪费时间。正确做法是先检查文件是否存在且内容完整，再决定是否重试。

2. **Gate 要求 plan_bl_review 但 skill 未明确列出**：L2 plan 多了一个 gate 检查项 `plan_bl_review`（backlog review），这在 writing-plans skill 的"交付物验证"清单中未提及。我只有看到 gate FAIL 的错误消息才知道需要这个文件。这是 skill 文档和 gate 实现之间的 gap。

3. **并行 subagent 调度效率**：plan-backend + plan-frontend 本可以并行，但 plan-backend 因输出过大而 failed，plan-frontend 成功。实际效果是 backend 文件写了但被标记失败，frontend 正常。后来 plan-api-contract.md 改用 background 模式成功完成。

### What Would You Do Differently

- 对于大输出 subagent（>1000 行文档），直接用 background 模式而非 parallel 模式，避免 output token limit 导致的 false failure
- 先读 gate check 脚本的完整检查项（`check_gate.py` Phase 2 部分），再开始写交付物，避免漏掉 plan_bl_review 这类 L2 特有要求
- plan.md 总纲可以更精简——当前 20KB 包含了完整的 Interface Contracts，这些在 plan-backend.md 和 plan-api-contract.md 中有更详细的版本。总纲只需保留 summary level

### Key Risks for Later Phases

| 风险 | 说明 | 可能影响 Phase |
|------|------|---------------|
| plan-backend.md 1714 行，subagent 上下文可能装不下 | BG2-BG3 的 subagent 需要读取 plan-backend.md 相关章节，但文件太大 | Phase 3 dev |
| 5 条 LOW 问题未修复 | 包括 BG4 文件数标注错误、签名跨文档不一致等 | Phase 3 dev（可能造成 subagent 困惑） |
| 测试中 Worker Thread 行为在 CI vs 本地差异 | CI 环境可能没有 Worker Thread 的完整支持 | Phase 3 dev |

## Harness Usability Review

### Flow Friction

1. **L2 gate 检查项未在 skill 文档中完整列出**：`plan_bl_review` 是 L2 特有的 gate 检查，但 writing-plans skill 的"交付物验证"清单和"Phase 2 Additional Deliverables"章节都未提及。需要读 gate 脚本源码才知道。建议在 skill 文档中补充 L2 的额外 gate 要求。

2. **subagent parallel 模式的 false failure**：输出 token 超限导致 subagent 被标记为 failed，但文件已成功写入。这让主 agent 需要额外判断"是真失败还是假失败"。建议 subagent 工具在 output truncated 时给出明确提示（如"output truncated but file written"）。

### Gate Quality

- Gate 正确识别了 plan_bl_review 缺失，错误消息清晰
- Gate 的检查项覆盖全面：plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md、plan_review、plan_bl_review（L2）
- 无 false positive

### Automation Gaps

- **L2 特有交付物的自动提示缺失**：当 plan.md 的 YAML frontmatter 中 `complexity: L2` 时，应自动提示需要产出 plan_bl_review
- **文件一致性检查未自动化**：plan_review 发现的 5 条 LOW 问题中有 3 条是跨文档签名不一致，这可以通过脚本自动检测

### Time Sinks

- 等待并行 subagent 结果 + 判断 false failure：约占总时间 10%
- 手写 plan_bl_review（如果 gate 提示更明确，可以更快产出）：约 5 分钟
- 产出 11 个交付物文件本身占主要时间（~60%），这是正常的规划工作量

### Summary

Phase 2 的核心问题不是规划质量（plan review 0 MUST_FIX），而是 L2 流程的文档完整性——gate 要求和 skill 指导之间有 gap。一次 gate retry 的代价不大，但如果能在写交付物前就知道全部检查项，效率会更高。
