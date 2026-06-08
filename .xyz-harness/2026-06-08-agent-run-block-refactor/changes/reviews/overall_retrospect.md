---
phase: pr
verdict: pass
absorbed: false
topic: "2026-06-08-agent-run-block-refactor"
harness_issues:
  - "gate check 取 review 文件时读到旧版本就判定 fail，不取最新版本（plan_retrospect 中已记录）。这个问题跨 Phase 2/3 反复出现，应优先修复"
  - "retrospect skill resolver 在 Phase 1→2 transition 时报 Skill not found，但手动读取 SKILL.md 并写文件后就能继续。skill resolver 的搜索路径应覆盖 npm node_modules 下的 skills"
  - "gate 的 YAML frontmatter 解析器对中文特殊字符（引号、加粗符号、反引号）脆弱，报错信息不指出具体解析失败位置，只报 missing verdict"
  - "gate 要求 taste_review_v*.md 文件名模式，不匹配 ts_taste_review_v*.md；要求 rust_taste_review 即使项目无 Rust 代码。文件名匹配和技术栈检查应可配置"
  - "test_execution.json 的 schema（caseId/round/passed/execute_steps）无文档说明，phase-start 注入的指令不包含 schema 示例，开发者只能通过 gate 错误消息反推"
  - "5 步审查（BLR/standards/taste/robustness/integration）应该 BLR 先行、其余 4 步等 BLR pass 后再并行，避免 BLR 的 must_fix 影响其他审查的判断"
  - "review subagent 产出的文件经常缺少正确的 YAML frontmatter，gate 不提示缺少 frontmatter 只报 parse error。应在 subagent task prompt 中硬性要求 frontmatter 模板"
  - "review 修复后需要手动 dispatch 新版本 subagent（v2/v3），不能自动重跑。如果 gate 能检测到文件变更并自动重跑对应 review，效率会更高"
---

# Overall Retrospect (Phase 5: PR)

## 1. Overall Phase Execution Review

**Summary**: 完成了 AgentRunBlock 三层结构重构的全部 5 个 Phase。从 spec 设计到最终 PR #71 创建并 CI 通过，共修改 10 个源文件（6 个新文件 + 4 个修改），新增约 4800 行代码和文档。经过 5 步专项审查修复了 13 个 must-fix（BLR 3, taste 6, robustness 2, standards 0, integration 0），最终 vue-tsc/Vite/ESLint/CI 全部通过。

**Per-Phase 质量评估**:

| Phase | 执行质量 | 核心问题 |
|-------|---------|---------|
| Spec (P1) | 良好 | edit 分类与用户需求矛盾，2 轮 review 修正 |
| Plan (P2) | 良好 | T7 streaming 路径描述模糊，E2E 场景与 AC-5 不精确匹配，5 轮 review |
| Dev (P3) | 中等 | elapsedMs 计算错误、timer 泄漏、spread 溢出 3 个功能性 bug；isCustomTool 过度设计；taste review 3 轮 |
| Test (P4) | 差（流程问题） | 4 轮 gate FAIL 全部是格式/schema 问题，不是测试质量问题 |
| PR (P5) | 良好 | CI 一次通过（Lint/Test/TypeCheck），PR 已存在可直接更新 |

**What went well**:
- Spec 阶段的 10 步 checklist 和 Assumption Audit 有效，4 个验证全部通过
- Plan 的 8 个 Task 依赖关系清晰，按序执行无阻塞
- 5 步审查中 BLR 发现了真正的功能性 bug（elapsedMs 计算），审查价值高
- StandaloneToolCard 的 EnrichedSection 预解析方案优雅地消除了模板中的双次 resolver 调用
- CI pipeline（Lint + Test + TypeCheck）一次性通过，无需返工

**What went wrong**:
- Dev 阶段写了 3 个功能性 bug（elapsedMs 计算、timer 泄漏、spread 溢出），都是"写的时候就该避免"的低级错误
- isCustomTool prop 是过度设计——自定义工具和内置工具的卡片渲染完全相同
- useLiveTimer composable 应该在写第一个 timer 时就抽象出来，而不是写完 3 个再重构
- Test 阶段是纯格式调试阶段，4 轮 gate retry 全部是 schema/frontmatter/file-naming 问题

**What would you do differently**:
- 在 plan 阶段就约定 review 文件的命名模式（`taste_review` 而非 `ts_taste_review`）和 YAML frontmatter 模板，避免 Test 阶段的格式修复
- 在 dev 阶段写第一个 timer 时就抽象 composable，避免后续重构
- 从用户视角而非技术分类出发写 spec 的工具分类（write/edit 一开始就归为同类）
- 提前读 gate 的 schema 要求，一次性写出正确格式的 test_execution.json

**Key risks going forward**:
- 视觉渲染效果（动画、间距、折叠动画）未经过 E2E 测试验证，需要在 dev 模式下手动确认
- Settings standaloneTools 变更会立即重排已渲染消息的 sections（通过 computed 链），大量 toolCalls 时可能有性能问题
- compactStreaming=false 路径完全不受影响（integration review 确认），但需在合入前验证

## 2. Overall Harness Usability Review

**Flow friction**: 5 个 Phase 中 Test (P4) 摩擦最大——4 轮 gate retry 全是格式问题。Dev (P3) 次之——YAML frontmatter 修复和 taste review 3 轮重跑。PR (P5) 最顺畅——CI 一次通过。Phase 1→2 transition 被 skill resolver 错误阻塞。

**Gate quality**: gate 的检查逻辑正确（verdict、must_fix、文件存在性），但有两个系统性问题：(1) 取 review 文件时读到旧版本就判定 fail，不取最新版本；(2) 文件名匹配模式僵化（`taste_review` vs `ts_taste_review`，强制 `rust_taste_review`）。这两个问题在 P2/P3/P4 反复出现。

**Prompt clarity**: brainstorming skill 的 10 步 checklist 和 writing-plans skill 的 Task 模板清晰有效。phase-start 注入的指令在 P4（test）不够详细——缺少 test_execution.json 的 schema 示例。其他 Phase 的指令足够清晰。

**Automation gaps**: (1) review 修复后需手动 dispatch 新版本 subagent；(2) test_execution.json 需手动组装；(3) retrospect 在 P1 需手动处理（skill resolver 失败）；(4) gate 不自动触发 review。这些手动步骤在 5 个 Phase 中消耗了约 30% 的总时间。

**Time sinks**:
- P2: v1-v3 三轮空跑 review（plan 未创建时就触发审查）
- P3: taste review 3 轮（DRY 问题标为 must_fix），YAML frontmatter 修复 5 个文件
- P4: 4 轮 gate retry（格式/schema 调试）
- P5: 无（最顺畅的 Phase）
- 总计约 40% 的时间花在 harness 流程本身（格式修复、空跑 review、gate retry），而非实际的 spec/plan/dev/test 工作

**Overall harness assessment**: harness 的 5 Phase 流程和 5 步审查体系提供了有价值的质量保障（BLR 发现了 3 个功能性 bug）。但 harness 的格式要求和 gate 检查过于僵化，导致大量时间消耗在非核心工作上。建议优先修复 gate 的文件版本选择、文件名匹配、YAML 解析错误信息三个问题，预计可将 Test Phase 的摩擦减少 80%。
