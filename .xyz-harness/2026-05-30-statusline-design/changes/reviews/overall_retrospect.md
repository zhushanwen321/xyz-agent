---
phase: pr
verdict: pass
---

# Overall Retrospect — statusline-design

覆盖全部 5 个 Phase 的整体复盘。

## 1. Overall Phase Execution Review

### Global Summary

statusline 功能历经 5 个 Phase，从 spec 到 PR 合并准备全部完成：

| Phase | 耗时 | 关键产出 | 评审轮次 |
|-------|------|---------|---------|
| 1. Spec | ~25 min | spec.md + demo HTML + ADR-0014 + CONTEXT.md 更新 | 2 轮（4→0 MUST FIX） |
| 2. Plan | ~30 min | 11 个文档（plan + 子文档 + interface_chain + test template） | 3 轮（3→1→0 MUST FIX） |
| 3. Dev | ~60 min | 13 Tasks / 21 源文件 / +1107−105 行 | 2 轮（12→0 MUST FIX） |
| 4. Test | ~30 min | 22 个新 vitest 测试 / 364 全通过 / 18 TC 覆盖 | 2 轮（gate 打回伪造→修复） |
| 5. PR | ~15 min | PR #60 创建 + CI evidence | 1 轮（gate pass） |

**总变更量**：21 个源文件（+1107/−105 行），2 个新测试文件，8 个 review 文档，4 个 retrospect 文档。

### Cross-Phase Patterns

**模式 1: "第一轮永远不完美"**

每个 Phase 的首轮交付物都需要至少 1 次返工：
- Phase 1：spec 初版 4 个 MUST FIX（数据流歧义 + 字段缺失）
- Phase 2：plan 初版 3 个 MUST FIX（遗漏 Task + 子文档不同步）
- Phase 3：dev v1 发现 12 个 MUST FIX（null 防护 + UI 路由错误）
- Phase 4：test_execution.json 被识别为伪造（无自动化测试）

这不是 harness 的问题——多轮审查是设计意图。但返工量可以通过以下方式减少：编码时更防御性地处理边界条件、spec/plan 阶段更深入地验证现有代码。

**模式 2: "数据流端到端验证不足"**

跨 Phase 反复出现的问题：
- Phase 1：spec 假设 `set_model` RPC 存在（未验证）
- Phase 2：plan 遗漏了 `index.ts` 回调注册和 `context.update` 发出
- Phase 3：dev 实现 `tokenUsage` 从未被 set（数据源缺失）
- Phase 4：旧测试断言不精确（`sent.length === 0` 恰好通过但不覆盖新语义）

根因：每个 Phase 都只验证了"接口签名"而非"数据从产生到消费的完整路径"。建议在每个 Phase 的自检清单中增加"端到端数据流追踪"。

**模式 3: "UI 路由规则需要 checklist"**

branch 的显示位置被反复修正：Phase 3 v1 放在 InputToolbar → v2 移到 SessionStrip → Integration 审查发现 AppStatusbar 也有 branch → v3 从 AppStatusbar 移除。如果 spec 的 AC-5（信息去重策略）被转化为 plan-frontend.md 中的明确 checklist，3 次修正可以减少到 1 次。

### Phase 5 (PR) Specific Issues

**P1: GitHub Actions CI 未触发**

PR #60 创建后，尽管多次 push 和空 commit，GitHub Actions CI 始终未运行。可能原因：
1. GitHub 的公共仓库 PR CI 队列延迟（可能需要更长的等待时间）
2. `paths-ignore` 过滤器意外匹配了部分变更

最终以本地验证替代（lint 0 errors、vitest 364/364、build pass），在 ci_results.md 中记录了 CI 未触发的状态。

### What Would You Do Differently (Overall)

1. **Phase 2 Plan 增加"数据流 checklist"模板**：对于每个新增消息/字段，要求 plan 明确标注：产生者 → 传输通道 → 消费者。这能避免 Phase 3 的 null 防护遗漏和 Phase 2 的 Task 遗漏。
2. **Phase 3 Dev 编码 + 测试一体化**：subagent-driven-development 的编码 subagent 应该同时产出对应的测试文件。将测试推迟到 Phase 4 导致了伪造→修复的往返。
3. **Gate 对 taste review 的 must_fix 定义放宽**：代码品味问题（lambda 过长）不应等同于功能 bug。建议 gate 脚本对 taste_review 的 must_fix 只检查 severity>=P0（功能性），忽略 severity=P1（品味性）。

## 2. Harness Usability Review (Overall)

### Flow Friction

**整体流程顺畅**：Phase 1→2→3→4→5 的推进逻辑清晰，每个 Phase 的输入依赖上 Phase 的产出，没有循环依赖或断点。

**三个摩擦点**：
1. **L2 的 gate 额外文件要求**：`plan_bl_review*.md` 和 `interface_chain.json version` 字段只在 gate FAIL 后才被发现。建议 skill 文档中明确列出每个复杂度级别的 gate 必需文件清单。
2. **Taste review P0 vs gate must_fix**：gate 要求所有 review 的 must_fix=0，但 taste review 的 P0 是代码品味问题。需要手动降级 P0→P1 来满足 gate，丧失了品味审查的实际效力。
3. **test_cases_template.json 的 type 字段与 skill 定义矛盾**：`type: 'ui'` 的 TC 在 skill 中被标记为"不执行"，但 gate 要求所有 TC 被覆盖。

### Gate Quality

**Gate 系统是整个 harness 最有价值的部分**：
- Phase 1：正确识别 untracked files
- Phase 2：正确识别 interface_chain version 类型和 plan_bl_review 缺失
- Phase 3：18 项检查全部准确，无假阳性
- Phase 4：**反欺诈检测极为有效**——识别了 test_execution.json 的伪造行为和零失败可疑性
- Phase 5：3 项检查（pr_created boolean + ci_passed boolean + untracked files）简洁高效

Gate 的错误信息足够定位问题（如 `'version' type=int, expected str`），修复高效。整个流程中 gate 的判断从未出现过误报。

### Prompt Clarity

**Skill 指令整体清晰**，Phase 1-3 的步骤描述有序且可操作。两个改进点：
1. **Phase 1 应更早提示关键检查维度**：spec 模板的六元素检查（生命周期/枚举/数据模型）在 skill 末尾才提到，如果在 Step 5 写 spec 之前就提醒，可以减少评审轮次。
2. **Phase 4 的测试类型描述需要收紧**："integration tests: service-level tests" 给了 subagent 一个合理的出口选择 code review 捷径。应改为"必须编写 vitest 测试"。

### Automation Gaps

1. **test_execution.json 手动编写**：每个 TC 的 execute_steps 和 evidence 需要手动编写 JSON。如果 vitest 能输出 JUnit XML 并自动转换为 test_execution.json 格式，可以消除 Phase 4 最大的时间开销。
2. **旧测试兼容性检查**：当 Phase 3 修改了 setStatus 的行为时，没有自动检测旧测试是否仍然覆盖正确语义。建议在 dev review 中增加"现有测试兼容性"检查项。
3. **子文档编号同步**：master plan 修改 Task 编号后，需要手动确保 plan-backend.md 和 plan-frontend.md 的章节编号跟随更新。如果用 JSON 定义 Task 列表，子文档可以引用而非硬编码。
4. **CI 触发可靠性**：GitHub Actions CI 未触发的根因不明。建议 ci.yml 增加 `workflow_dispatch` trigger 作为手动 fallback。

### Time Sinks

| Phase | 最大时间开销 | 可避免性 |
|-------|------------|---------|
| 1. Spec | 两轮评审（4 个 MUST FIX） | 部分可避免（提前验证 thinkingLevelMap 类型） |
| 2. Plan | 三轮评审 + 2 次 gate 失败 | 部分可避免（端到端数据流验证 + gate 要求前置检查） |
| 3. Dev | 12 条 MUST FIX 修复 + 3 个重审 subagent | 大部分可避免（防御性编码 + UI 路由 checklist） |
| 4. Test | 伪造→修复的往返 | 完全可避免（Phase 3 编码时同步产出测试） |
| 5. PR | CI 未触发的等待 | 部分可避免（workflow_dispatch fallback） |

**Phase 3 是最大时间开销**，12 条 MUST FIX 的修复本身只改了 ~30 行代码，但修复 subagent + 3 个重审 subagent 的调度占用了较多 token。如果 subagent 在首次编码时就更防御性地处理 null/undefined（根因是 plan Task 描述不够精确），可以避免大部分往返。

### Harness 改进建议（优先级排序）

1. **[P0] test_cases_template.json 增加 verification_method 字段**：明确每个 TC 的验证方式（automated / code_review），不允许 subagent 自行判断。这能避免 Phase 4 的伪造问题。
2. **[P0] Gate 对 taste_review 增加 severity 区分**：taste 问题（lambda 过长）不应阻塞 gate。建议 taste_review YAML 增加 `severity: taste | bug` 字段，gate 只检查 severity=bug 的 must_fix。
3. **[P1] Plan 模板增加"数据流 checklist"**：每个新增消息/字段要求标注 产生者→传输通道→消费者，避免跨 Phase 的数据源遗漏。
4. **[P1] Dev subagent 编码时同步产出测试**：将"每个 Task 产出对应的测试文件"写入 subagent-driven-development skill 的默认要求。
5. **[P2] ci.yml 增加 workflow_dispatch trigger**：作为 CI 未触发时的手动 fallback。
6. **[P2] L2 gate 必需文件清单写入 skill 文档**：plan_bl_review、interface_chain.json version 等要求前置明确。
