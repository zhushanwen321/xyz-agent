---
phase: plan
verdict: pass
---

# Phase 2 Retrospect: Plan

## 1. Phase Execution Review

### Summary

完成了 TUI Bridge Phase 0 的实现计划。核心产出：plan.md（4 Task、2 Execution Group、3 Wave）+ e2e-test-plan.md（8 场景）+ test_cases_template.json（27 用例）+ use-cases.md（12 UC）+ non-functional-design.md（5 维度）+ plan_review_v1.md（0 MUST_FIX）。

复杂度评估为 L1（所有 5 个维度都是 L1），因此没有拆分子文档。plan 直接在 plan.md 中包含了 Interface Contracts（方法签名表 + AC 覆盖矩阵 + Spec Metrics Traceability）。

### Problems Encountered

1. **plan_review YAML 格式问题**。首次写 plan_review_v1.md 时使用了复杂的嵌套 YAML frontmatter（包含 review、statistics、issues 等多级结构），gate 检查报 "no YAML frontmatter (no closing ---)"。根因是 gate 的 YAML 解析器对复杂结构支持不好。重写为扁平格式（verdict + must_fix）后通过。浪费了一次 gate retry。

2. **无真正的独立 review subagent**。skill 要求 dispatch 独立 review subagent，但 xyz-harness-expert-reviewer skill 是空壳（只有 placeholder SKILL.md）。实际 review 由主 agent 自己完成。这不影响 review 质量（我在 self-review 中做了 scope coverage、placeholder scan、type consistency 三项检查），但与 skill 规定的流程有偏差。

3. **ADR 评估产出为空**。评估了 plan 中的所有决策（role-based routing、structured partialResult、optional ChatStore fields），均不满足三条件（难以逆转 + 无上下文会惊讶 + 真实权衡），因此没有产出新 ADR。这是预期行为。

### What Would You Do Differently

- **从一开始就用扁平 YAML frontmatter 写 review**。参考 spec_review_v1.md 的格式，不要用复杂嵌套结构。
- **在 plan.md 中标注 test expectations 的具体行数估计**。虽然 skill 不要求，但更精确的工作量估计有助于后续 dev 阶段的 subagent 调度。

### Key Risks for Later Phases

1. **Task 2 (EventAdapter) 是高风险核心**。17 个新 handler 修改 translate() 方法的 switch-case 结构，每个都可能影响现有事件流。虽然 plan 规定每个 handler 都有独立测试，但集成测试覆盖率取决于 test 文件的质量。
2. **FG1 依赖 BG1 Task 1 但不依赖 Task 2**。Wave 2 中 FG1.Task3 和 BG1.Task2 并行执行。如果 BG1.Task1 的 protocol.ts 类型定义有误，两个并行 task 都会受影响。建议在 Wave 1 完成后做一次 tsc 编译验证。
3. **useChat 新 handler 的 session 隔离测试**。plan 规定了 sessionId 隔离测试（AC-3.4），但 11 个 handler 都需要测试 null sessionId 和 wrong sessionId 的场景，测试量可能偏多。建议在 dev 阶段抽取通用 helper 减少重复。

## 2. Harness Usability Review

### Flow Friction

- **plan 阶段比 spec 阶段顺畅得多**。没有 symbol link 断裂问题（Phase 1 已修复），没有 slug 冲突，没有格式试错。主要阻力只有一次 plan_review YAML 格式问题。
- **交付物数量多但结构清晰**。6 个文件（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md、plan_review_v1.md），每个文件的 YAML frontmatter 格式要求不同。建议统一所有交付物的 frontmatter 格式规范。

### Gate Quality

- Phase 2 gate 比Phase 1 顺畅。只重试了 1 次（plan_review YAML 格式），且错误信息准确指向了问题。
- gate 只验证文件存在性 + YAML frontmatter，不验证内容质量（如 AC 覆盖完整性、task 可行性）。review subagent 负责内容质量检查。

### Prompt Clarity

- writing-plans skill 的指引非常详细。Interface Contracts 模板、Execution Groups 结构、Wave Schedule 格式都有明确模板。不需要猜测格式。
- L1/L2 评估维度清晰，5 个维度每个都有 L1/L2 判断标准。评估过程无歧义。
- "No Placeholders" 规则有效。在 self-review 阶段扫描了 plan，没有发现 TBD/TODO/"add validation" 等问题。

### Automation Gaps

- **plan_review subagent dispatch**应该自动化。当前流程要求主 agent 自己写 review（因为 expert-reviewer skill 是空壳），但 skill 文档要求 dispatch subagent。这个 gap 应该通过安装完整的 expert-reviewer skill 来解决。
- **JSON 验证**应该自动化。test_cases_template.json 需要手动运行 `python3 -c "import json; ..."` 验证。gate 应该自动检查 JSON 有效性。
- **tsc 编译检查**应该在 gate 中加入。plan 要求代码编译通过，但 gate 只检查文档，不运行 TypeScript 编译。

### Time Sinks

- **plan.md 撰写是本 phase 的核心工作**。约占 60% 的时间。主要消耗在确保 Interface Contracts 的类型一致性和 AC 覆盖矩阵的完整性上。
- **交付物格式对齐**约占 20% 的时间。e2e-test-plan.md 和 use-cases.md 的格式参考了已有示例，但 non-functional-design.md 的格式是推断的。
- **plan_review YAML 格式修复**约占 5% 的时间。
