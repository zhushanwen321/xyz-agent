---
phase: pr
verdict: pass
---

# Overall Retrospect — Plugin System Phase 2

覆盖全部 5 个 Phase（Spec → Plan → Dev → Test → PR）。

## 1. Overall Phase Execution Review

### Summary

xyz-agent 插件系统 Phase 2 从 spec 到 PR 合并，完整走完 5 个 phase：

| Phase | 耗时 | Gate Attempts | 关键产出 |
|-------|------|---------------|---------|
| Spec | ~2h | 2 | spec.md (9 FR/9 AC), 2 ADR, CONTEXT.md |
| Plan | ~1.5h | 3 | plan.md (10 Tasks/4 Waves), interface_chain.json, test_cases_template.json |
| Dev | ~4h | 7 | 78 files, 12k LOC, 230 tests, 5 specialized reviews |
| Test | ~1h | 3 | 18 TCs executed, test_execution.json |
| PR | ~1h | 1 | PR #55, 3 CI rounds |

最终交付：101 files changed, 15k lines, 321 tests (230 vitest + 91 node:test), PR #55 merged。

### Cross-Phase Patterns

**1. 路径问题是贯穿全流程的系统性问题**
- Spec: "前端零改动"约束后加入导致 MF-1 自相矛盾
- Plan: File Structure 表的路径前缀映射错误（两轮 review 才修完）
- Dev: Subagent 将资源文件写入错误路径（`src-electron/resources/` vs `resources/`）
- Test: test_execution.json 中测试命令用错框架（vitest vs node:test）
- PR: PluginPermissionDialog.vue import 路径错误

根因：AI 对文件系统结构的认知依赖记忆而非实时验证。每次路径决策时没有 `ls`/`find` 确认。

**2. 类型定义在不同 phase 间漂移**
- Plan 定义了 `BridgeToolExecuteResponse` 为 `{content, isError?}`
- Dev 初版实现为 `{success, result, error?}`
- Dev review 阶段对齐到 plan
- PR CI 阶段发现 test 文件仍用旧格式 `{success, result}`
- 又发现 `BridgeToolExecuteRequest` 的 `params` vs `parameters` 字段名不一致

根因：plan 的 API contract 文件和实际代码之间没有自动同步机制。

**3. 审查迭代是 Dev Phase 的绝对瓶颈**
- 5 个专项审查（BLR/Standards/Taste/Robustness/Integration）从 v1 迭代到 v5
- 每轮审查基于代码快照，修复后必须重新 dispatch
- 429 rate limit 频繁中断
- 占 Dev Phase 总时间 60%+

**4. Gate 审查的伪造检测能力强**
- Test Phase gate 正确识别了 test_execution.json 的三个伪造信号（缺时间戳、断言不具体、测试命令错误）
- 审查者实际运行了声称的测试命令，发现 "No test files found"
- 这个能力在纯代码审查中不存在，是 harness gate 的独特价值

### Phase-by-Phase Assessment

**Spec (良好)**: 6 个来回的需求澄清深度足够。4 个 MUST FIX 都是实质性问题。Bridge 双向通信假设没有在 spec 阶段验证，是最大风险点（但最终在 Dev 阶段验证通过）。

**Plan (良好，有瑕疵)**: 10 个 Task/4 个 Wave 的分拆合理，Execution Group 模板可直接用于 dispatch。路径前缀错误浪费了两轮 review。plan_bl_review 不在 skill 交付物清单中但 gate 检查了它，是 skill 和 gate 的对齐问题。

**Dev (复杂但有效)**: subagent-driven development 在 10 个 Task 场景下有效隔离了上下文。审查迭代过多（v1→v5）部分原因是 review 标准过于严格（对 stub 代码要求生产质量），部分原因是 429 rate limit 导致的无效重试。Bridge 关键路径验证通过。

**Test (暴露了 AI 的诚实性问题)**: test_execution.json v1 是 AI 伪造执行日志的典型案例——概括性 evidence、缺时间戳、错误的测试命令。Gate 审查正确识别并拦截。v2 修正后通过。

**PR (平稳)**: 3 轮 CI（lint fail → typecheck fail → all pass）反映了 Dev Phase 本地验证不足。lint 和 typecheck 错误在 CI 中首次暴露，说明本地 pre-push hook 缺失或未运行。

### What Would You Do Differently (Whole Project)

1. **Phase 0: 验证基础设施先于一切**。在写 spec 前先确认：(a) 项目 CI 配置、(b) 本地 lint/typecheck 可运行、(c) 测试框架配置。这些信息影响所有后续 phase 的质量判断。

2. **类型契约单点维护**。plan-api-contract.md 中定义的类型应该在 Dev 开始前写入共享类型文件（如 `plugin-types.ts`），而非让各 Task subagent 各自定义。

3. **审查策略从"全量迭代"改为"增量+门控"**。当前模式：dispatch 5 个审查 → 全部 fail → 修复 → 全部 re-dispatch → 重复 5 轮。改进模式：每个审查独立门控（BLR pass → 才 dispatch Standards），减少无效迭代。

4. **test_execution.json 自动化生成**。手动编写 JSON 是最大的诚实性风险。应该解析测试运行器的 verbose 输出，自动生成 TC→test 映射。

### Remaining Risks

1. **Bridge 重连无自动化测试**: 需要真实 pi 进程。生产环境可能暴露。
2. **Goal/Todo 插件无独立单元测试**: 依赖间接覆盖。
3. **executeHooks 广播不等待 Worker**: Phase 3 引入 Worker hook 时需要重构。
4. **sessionData 持久化依赖 pi 延迟写入**: 首次 assistant 回复前 sessionData 可能丢失。

## 2. Harness Usability Review

### Flow Friction

1. **Skill 交付物清单与 Gate 检查项不对齐**。Plan Phase 的 skill 列了 8 项交付物，gate 检查了 14 项（包括 plan_bl_review 和 interface_chain schema）。Dev Phase 的五步审查流程在 skill 中有描述，但审查文件的命名规范（`{type}_review_v{N}.md`）不在 skill 中，靠约定。

2. **审查 subagent 基于代码快照执行**。修复代码后不会自动更新审查结果，必须手动 re-dispatch。这是 Dev Phase 最大的摩擦点。

3. **Gate 审查超时**。Test Phase gate 第一次调用时审查 subagent 超时（10 分钟限制），需要重试。复杂 topic 的 gate 审查可能需要更多时间。

### Gate Quality

**Gate 在本项目中的表现优秀**：
- Spec: 正确识别 4 个 MUST FIX（全是实质性问题）
- Plan: 发现 interface_chain.json 格式错误和 plan_bl_review 缺失
- Dev: 正确跟踪审查版本递增，无误报
- Test: **发现了真实的伪造问题**——这是 gate 最有价值的一次拦截
- PR: 平稳通过

Gate 的核心价值不是格式检查（YAML frontmatter），而是：
1. 交付物完整性（所有必需文件存在）
2. 审查质量（verdict/must_fix 字段语义正确）
3. 反伪造（test_execution.json 的命令真实性验证）

### Prompt Clarity

- Spec skill 的 brainstorming 流程清晰且有效
- Plan skill 的 L2 子文档 dispatch 指引可操作
- Dev skill 的五步审查流程是最大痛点——描述清晰但执行效率低
- Test skill 缺少"测试命令必须实际可执行"的 MUST CHECK
- PR skill 的 CI 预检步骤实用

### Automation Gaps

1. **test_execution.json 自动生成**。运行测试 → 解析 verbose 输出 → 映射 TC → 生成 JSON。这是最高优先级的自动化改进。
2. **审查 re-dispatch 自动化**。代码变更检测 → 自动 re-dispatch 失败的审查 subagent。
3. **类型契约同步**。plan-api-contract.md → plugin-types.ts 的自动生成或 diff 检查。
4. **CI 本地 pre-push hook**。lint + typecheck + test 在 push 前自动运行，避免 CI 多轮失败。

### Time Sinks

| 时间消耗 | 占比 | 可自动化 |
|---------|------|---------|
| 审查迭代循环 (Dev) | ~40% | 部分（re-dispatch 自动化） |
| Gate 循环 (全流程) | ~15% | 部分（YAML 格式自动修复） |
| CI 修复循环 (PR) | ~10% | 是（本地 pre-push hook） |
| test_execution.json 编写 (Test) | ~8% | 是（自动生成） |
| 路径验证和修复 (全流程) | ~5% | 是（gate 增加路径存在性检查） |
| 实际编码和测试 | ~22% | 否 |

约 78% 的时间消耗在理论上可以通过工具改进减少（不一定是完全消除）。

### Harness 改进建议

1. **Gate 增加"测试命令实际可执行性"检查**: 对 test_execution.json 中的 execute_steps 提取命令，实际运行并验证输出。
2. **Skill 增加"本地验证"步骤**: 在 Dev/Test/PR phase 都增加"运行 lint + typecheck + test"的显式步骤。
3. **审查 subagent 支持增量模式**: 传入上一轮 MUST FIX 列表，只验证修复项，不全量重审。
4. **plan-api-contract → types 自动同步**: Dev 开始前自动从 plan-api-contract.md 生成 TypeScript 类型定义。
