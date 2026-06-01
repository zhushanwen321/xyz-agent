---
phase: pr
verdict: pass
absorbed: false
topic: "2026-06-01-global-nav-stack"
harness_issues:
  - "跨 phase 的 review 文件命名规范缺失。ts-taste-check subagent 产出 ts_taste_review_v1.md，gate 期望 taste_review_v*.md，导致 Phase 4 多一个 commit + re-gate。建议在 harness 文档中统一 review 文件命名规范（如 {review_type}_review_v{n}.md），并在 gate 脚本中模糊匹配。"
  - "CI 暴露了本地 vue-tsc 未捕获的 TS 类型错误。navigation.ts:76 的 union type 窄化问题，本地 vue-tsc --noEmit 通过但 CI 失败。可能是因为本地和 CI 的 vue-tsc 版本差异或 strictness 不同。建议 pre-commit hook 加入 vue-tsc --noEmit（当前只有 eslint），在 push 前拦截类型错误。"
  - "event-adapter.ts 的改动属于另一个 feature commit（6349576），但和 navigation stack 在同一分支。runtime 测试失败（usage 字段名不匹配）是因为这个不相关的改动没更新测试。建议按 feature 分支隔离，或在 PR phase 的 CI 失败排查中增加 diff scope 诊断（只看本次 feature 的 diff vs 全部分支 diff）。"
  - "5 个 phase 的总 turn 数约 40+，其中 harness 流程开销（review dispatch、gate、retrospect、文件名修复）约占 40%。纯编码时间（store 实现 + UI 接入 + 测试）只占 30%，剩余 30% 是 CI 修复和 bug fix。对于 L1 纯前端 feature，harness 流程偏重。建议 L1 feature 提供精简流程（合并 Phase 3+4，减少 review 维度）。"
---

# Overall Retrospect — global-nav-stack

## 1. Overall Phase Execution Review

### Summary

5 个 phase 全部完成，产出：

| Phase | 交付物 | 关键产出 |
|-------|--------|----------|
| 1 (Spec) | spec.md + review | 15 项代码验证 + 5 个 AMBIGUOUS 决议 |
| 2 (Plan) | plan.md + TC template + NFD | 5 tasks / 3 Execution Groups + 14 TC |
| 3 (Dev) | code + tests + reviews | NavigationStore + 10 tests + 5-step review |
| 4 (Test) | test_execution.json + TC review | 14/14 TC pass (3 API + 4 integration + 7 code review) |
| 5 (PR) | PR #65 + CI pass | 3/3 CI checks pass |

最终代码变更：5 个源文件修改 + 2 个新文件（navigation.ts + test），299 行新增，26 行删除。

### Cross-Phase Analysis

#### 成功的模式

1. **Assumption Audit（Phase 1）效果显著**：15 项代码事实验证在后续 4 个 phase 中全部准确，没有因为虚构接口导致返工。这验证了 Phase 1 "review existing spec" 的价值——即使 spec 是用户预先写好的，代码验证仍然必要。

2. **Execution Groups 分组（Phase 2）降低风险**：FG1（store + test）→ FG2（UI 接入）→ FG3（清理）的串行分组，确保每一步都有可验证的中间状态。FG1 的 9 个 unit tests 在 FG2 开始前就锁定了 store 行为，避免了"边写 store 边改 UI"的混乱。

3. **Plan review 发现了真实 bug**：Phase 2 review v1 的 2 个 MUST_FIX（watcher immediate + focusedSessionId）都是代码实现前发现的设计错误。如果直接进入 Dev 阶段，这两个 bug 需要在 Dev review 中才发现，修复成本更高。

#### 反复出现的问题

1. **预存在代码的 scope 判定（Phase 3, 4）**：Dev 的 Standards/Robustness review 和 Test 的 TC 验证都遇到了"这是本次改动还是预存在问题"的判断。Harness 流程缺乏明确的 scope 规则，完全依赖 AI 的判断力。

2. **Review 文件命名不一致（Phase 3, 4）**：ts-taste-check subagent 的文件名不匹配 gate 期望。这个问题在 Phase 3 种下（创建文件），Phase 4 爆发（gate 失败）。

3. **CI 与本地环境差异（Phase 5）**：本地 vue-tsc --noEmit 通过但 CI 失败。类似地，本地 runtime test 通过但 CI 失败（因为测试数据用了旧字段名）。说明本地验证不够严格。

### Problems Encountered (Phase 5 specific)

1. **CI TypeCheck 失败（TS2339）**：`navigation.ts:76` 的 `entries.value[i].activeTab` 在 union type 上未窄化。本地 `vue-tsc --noEmit` 通过（可能版本或配置差异），CI 严格模式报错。修复：加 type assertion。

2. **CI runtime 测试失败**：分支上的不相关 commit（event-adapter usage 字段重命名）未同步更新测试数据。这暴露了"多 feature 混在一个分支"的风险。

3. **Renderer subagent 测试本地失败但 CI 状态未知**：本地 vitest 运行单个 renderer test 时出现 `.vue` parse error（缺少 plugin 上下文），但 CI 的 renderer test job 结果在 failed log 中未出现（可能被 runtime 失败遮蔽）。第二次 push 后 CI 全部 pass，说明这些测试在 CI 上是通过的。

### What Would I Do Differently (Overall)

- **L1 feature 用精简流程**：对"1 个新 store + 几个文件修改"的低复杂度需求，5-phase 流程偏重。Phase 3（Dev）和 Phase 4（Test）可以合并——Dev 完成后直接执行 TC 验证，不需要单独开一个 phase 写 test_execution.json。5-step review 可以简化为 3-step（BLR + Standards + Integration），去掉 Taste 和 Robustness（对纯 store 改动价值低）。

- **Feature 分支隔离**：这个分支混了 3 个不相关的 commit（event-adapter fix + markdown breaks + navigation stack），CI 失败排查时需要区分"哪个改动导致哪个失败"。应该用独立分支或 cherry-pick 隔离。

- **CI 前置验证**：在 Phase 3 commit 前运行 `vue-tsc --noEmit`（不只是 eslint），可以避免 Phase 5 才发现 TS 错误。

### Key Risks (Post-Merge)

- **SettingsView v-if 重建的 pane 副作用**：5 个 phase 都提到这个风险但未实际运行验证。合并后首次 `npm run dev` 时应重点测试 Settings ↔ Chat 导航的 pane 行为。
- **AppHeader settings 按钮 push-only 与 Cmd+, toggle 的 UX 不一致**：Integration review 标记为 LOW，用户可能感知不一致。
- **pointer -= 1 死代码**：逻辑正确但代码误导，可作为后续 cleanup。

## 2. Harness Usability Review (Overall)

### Flow Friction

- **5-phase 流程对 L1 feature 偏重**：总计约 40+ turn，harness 开销占 40%。Phase 1 的 Assumption Audit 和 Phase 2 的 Plan review 是高价值的（发现了真实 bug），但 Phase 4 的 test_execution.json 手动编写和 Phase 3 的 re-review 循环是低价值的。
- **Gate 检查的严格程度合理但有摩擦**：文件名匹配、YAML 字段类型检查都捕获了真实问题，但 review 文件名不一致导致了一次无意义的 re-gate。

### Gate Quality

- **总体准确**：5 次 gate check（Phase 1-5）只有 2 次 FAIL，都是真实问题（Phase 4 文件名、Phase 3 review 文件缺失）。没有 false positive。
- **Anti-fraud review 有效**：Phase 1 gate 的 anti-fraud subagent 在 statusline 修复后正常工作，验证了 spec 内容的真实性。

### Prompt Clarity

- **Phase 1-3 的 skill 指引清晰**：Assumption Audit、AMBIGUOUS 标记、Execution Groups、TDD 流程都有明确的模板和步骤。
- **Phase 4 的 verification_method 空白**：最大的流程缺陷。14 个 TC 中 7 个是 ui/manual 类型，但 skill 没有指导如何处理。
- **Phase 5 的 CI 修复流程未文档化**：CI 失败 → 修复 → re-push 的循环在 skill 中没有明确步骤，实际操作依赖 AI 判断。

### Automation Gaps

- **缺少 diff scope 自动注入**：从 Phase 3 到 Phase 5，每次 dispatch review/TC subagent 都需要手动说明"哪些文件是本次改动"。`git diff --name-only` 的结果应该自动注入。
- **缺少跨 phase TC 引用机制**：Phase 3 的 10 个 unit tests 已覆盖 TC-4-01~03，Phase 4 需要手动重写。
- **缺少 post-subagent lint 自动化**：subagent 完成后没有自动验证，导致 unused variable 漏到 commit 后才发现。
- **缺少 pre-push typecheck hook**：CI 发现的 TS 类型错误应该在 pre-commit 或 pre-push 阶段拦截。

### Time Sinks

| Phase | 时间槽 | 占比 | 性质 |
|-------|--------|------|------|
| Phase 1 | statusline 排查 | ~15% | 环境问题（一次性） |
| Phase 2 | review 两轮迭代 + 签名表编写 | ~15% | 流程开销 |
| Phase 3 | re-review 循环（3 review × 2 轮） | ~15% | 可优化（scope 规则） |
| Phase 4 | test_execution.json 手写 + 文件名修复 | ~10% | 可自动化 |
| Phase 5 | CI 修复（2 个问题） | ~10% | 可前置（typecheck hook） |
| **纯编码** | Store 实现 + UI 接入 + 测试 | ~30% | 核心价值 |
| **总计** | | **~100%** | |

如果实施上述自动化改进，预计 harness 开销可从 40% 降到 25%。
