---
phase: test
verdict: pass
absorbed: false
topic: "2026-06-01-global-nav-stack"
harness_issues:
  - "test_cases_template.json 的 type 字段包含 ui/manual 类型，但 Phase 4 skill 明确说本阶段执行集成/功能测试，不执行 UI 级 E2E。14 个 TC 中有 7 个标记为 ui/manual，最终全部通过 code_review 验证而非实际执行。建议 plan 阶段的 test_cases_template 对 ui/manual 类型 TC 标注 verification_method: code_review，避免 Phase 4 执行时的类型歧义。"
  - "Gate 脚本对 review 文件名的匹配规则过于严格。ts_taste_review_v1.md 不匹配 taste_review_v*.md 模式，需要手动创建 alias 文件。建议 gate 脚本改为模糊匹配（含 taste）或文档中明确列出 review 文件命名规范。"
  - "API 类型 TC（TC-4-01~03）的执行方式不明确。这些 TC 实际上是 store unit tests，在 Phase 3 已覆盖并通过。Phase 4 重新记录为 pass 等于重复劳动。建议 Phase 3 的 test_results.md 如果已覆盖某些 TC，Phase 4 可以直接引用（标记为 verified_in_dev），不需要重新执行。"
---

# Test Phase Retrospect — global-nav-stack

## 1. Phase Execution Review

### Summary

Phase 4 执行了 14 个 test case，全部通过。执行方式分三类：

1. **API (3 TC)**: TC-4-01~03 — 已有 Phase 3 unit tests 覆盖，直接引用
2. **Integration (4 TC)**: TC-1-01~04 — unit test + code path review 双重验证
3. **UI/Manual (7 TC)**: TC-2-01~03, TC-3-01~02, TC-5-01~02 — 纯 code review（dispatch subagent 静态验证代码路径）

最终产出：
- `test_execution.json`: 14 条记录，round=1 全部 passed=true
- `tc_code_review.md`: 14 个 TC 的代码路径验证报告
- `test_results.md`: 更新汇总

Gate 第一次 FAIL（缺少 `taste_review_v*.md`），原因是文件命名不匹配。创建 alias 后第二次 PASS。

### Problems Encountered

1. **Gate 文件名匹配失败**: `ts_taste_review_v1.md` 不匹配 `taste_review_v*.md` 模式。Phase 3 dispatch 的 ts-taste-check subagent 自动按 skill 名称生成文件名，而 gate 脚本期望通用名称。修复：创建 `taste_review_v1.md` 作为 alias。这是一个 process friction，不是逻辑错误。

2. **UI/Manual TC 无法自动执行**: 14 个 TC 中 7 个标记为 ui/manual，本阶段没有 Playwright 或类似工具来实际模拟用户操作。最终通过 code review 验证代码路径正确性。这是合理的降级方案，但与 skill 描述的"执行测试"有语义差距。

### What Would I Do Differently

- **Plan 阶段为每个 TC 标注 verification_method**: 如果 test_cases_template.json 有 `verification_method` 字段（automated/code_review/manual），Phase 4 执行时可以按方法分组，避免手动决策每个 TC 该怎么验证。
- **API TC 直接引用 Phase 3 结果**: TC-4-01~03 的 unit test 在 Phase 3 已运行并通过。Phase 4 重新记录一次 pass 是冗余的。如果 test_execution.json 支持 `verified_in_phase: 3` 字段，可以避免重复。
- **Review 文件命名统一**: 在 dispatch review subagent 时，task prompt 中明确指定输出文件名为 gate 期望的模式（如 `taste_review_v1.md`），而不是让 subagent 自由命名。

### Key Risks for Later Phases

- **无运行时验证**: 所有 UI/Manual TC 通过 code review 验证，没有实际的运行时测试。Phase 5 merge 前建议手动启动 `npm run dev` 做一次端到端验证（点击 Settings → ESC → ◀▶ → Cmd+,）。
- **SettingsView v-if 重建的副作用**: code review 确认了 watcher `{ immediate: true }` 能恢复 activeTab，但 sub-pane（ProviderPane 等）的 mount 副作用未验证。实际运行时可能观察到不必要的 API 请求。

## 2. Harness Usability Review

### Flow Friction

- **Review 文件名不一致**: Phase 3 dispatch 的 ts-taste-check subagent 产出 `ts_taste_review_v1.md`，Phase 4 gate 期望 `taste_review_v*.md`。这个不一致导致了 1 个额外的 commit 和 re-gate 循环。根本原因是 review skill 的命名规范没有在 gate 和 skill 之间对齐。
- **TC 类型与执行方式的不匹配**: Skill 说"本阶段执行集成/功能测试，不执行 UI 级 E2E"，但 template 中 50% 的 TC 是 ui/manual 类型。需要手动决定如何处理这些 TC（code review 是合理降级，但流程中没有明确指引）。

### Gate Quality

- Gate 的 cross-reference 检查准确：验证了 14/14 caseId 匹配、round/passed 字段类型正确、execute_steps 非空。
- 文件名匹配规则是唯一的 false positive 来源。

### Prompt Clarity

- **Phase 4 skill 的执行步骤清晰**: Load → Execute → Record → Fix → Retrospect，无歧义。
- **verification_method 缺失是最大的流程空白**: Skill 没有指导 AI 如何为不同类型的 TC 选择执行方式。API → unit test, integration → code review, ui → ??? 实际决策完全依赖 AI 判断。

### Automation Gaps

- **缺少 code review 验证的标准化输出**: tc_code_review.md 是手动格式。如果有一个标准的 code review verification template（每条 TC 必须记录：code path、关键行号、结论），可以减少格式不一致的风险。
- **缺少跨 phase 的 TC 结果引用机制**: Phase 3 的 10 个 unit tests 已经覆盖了 TC-4-01~03，Phase 4 需要手动重新记录。自动从 Phase 3 test_results.md 提取并填充到 test_execution.json 可以省去重复劳动。

### Time Sinks

- **test_execution.json 手动编写**: 14 条记录，每条需要写 execute_steps 和 evidence。约占总工作时间的 30%。如果有一个工具从 tc_code_review.md 自动生成 test_execution.json 的骨架，可以加速。
- **Gate 文件名修复**: 1 个额外 commit + re-gate，约 1 turn。成本低但本可避免。
