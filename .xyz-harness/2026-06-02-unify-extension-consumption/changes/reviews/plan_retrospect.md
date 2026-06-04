---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-02-unify-extension-consumption"
harness_issues:
  - "writing-plans skill 要求 plan 中包含完整实现代码（'Every step must contain the actual content'），但 Self-Check Checklist 又说'禁止实现代码'。两条规则直接矛盾，需要明确边界——建议区分类别：interface 签名允许，函数体禁止"
  - "L1 plan 的 Execution Groups 模板对 Task 3 这种 backend+frontend 混合任务没有明确指导。skill 应补充：遇到跨层 Task 时，必须在 plan 阶段就拆分为 a/b 子 Task，而非留到 Execution Groups 时才发现冲突"
---

# Phase 2 Retrospect: Plan

## 1. Phase Execution Review

### Summary

完成了 L1 复杂度的实施计划，产出 6 个交付物：plan.md（5 个 Task、3 个 Execution Group、2 Wave）+ e2e-test-plan.md + test_cases_template.json（11 个用例）+ use-cases.md（5 个 UC）+ non-functional-design.md。2 轮 review 通过（v1 发现 5 个 MUST_FIX，v2 全部解决）。

关键拆分决策：将 Task 3（setWidget/setStatus 桥接）拆为 3a（backend：shared types + event-adapter）和 3b（frontend：composable + 组件），解决了 Execution Groups 的文件归属冲突。

### Problems Encountered

1. **deduplicate() 逻辑写反**。plan 的实现代码中，deduplicate 方法先按优先级升序排列，然后从高索引到低索引遍历（bundled→npm），配合 first-write-wins，导致低优先级胜出。这是典型的"写代码时想当然"错误。review #1 准确抓住了。修复：改为正向遍历（npm→bundled），高优先级先写入。

2. **Task 3 跨组归属冲突**。原始设计中 Task 3 同时包含 backend（event-adapter）和 frontend（Vue 组件）文件，但被声明在 BG1 中，FG1 又声称包含其前端部分。两个 subagent 会操作同一组文件。修复：拆为 3a/3b。

3. **Interface Contract 签名与实现不一致**。resolve() 在表格中写 1 参数，实现代码中是 3 参数。这种不一致会在 subagent 执行时产生编译错误。根因是先写了接口表格，后写实现代码时增加了参数但没有回同步。

4. **composable 缺 refCount 保护**。plan 中 useExtensionWidget 的 listener 注册放在 onMounted/onUnmounted 中，split mode 下多实例会重复注册。CLAUDE.md Rule #2 明确要求 refCount 保护，plan 阶段就应该体现。

5. **preflight 传递依赖检查是 TODO stub**。FR-7.4b 要求检查传递依赖存在性，但 plan 中只写了注释 `# TODO: ...`。review 正确标记为 MUST_FIX。

### What Would You Do Differently

- **先写 Interface Contract 表格，再写实现代码，最后交叉验证**。这次是先写实现代码片段（Task 1 的 ExtensionResolver），后填表格。导致签名不同步。正确顺序应该是：表格定义契约 → 实现代码遵循契约 → 交叉检查。
- **混合类型 Task 立即拆分**。当发现 Task 同时涉及 backend 和 frontend 文件时，应该立即拆分，而不是在 Execution Groups 阶段才发现冲突。
- **对照 CLAUDE.md 编码规范逐条检查 plan 代码**。refCount 保护是 CLAUDE.md 明确要求，plan 中的代码片段应该从一开始就遵循。

### Key Risks for Later Phases

1. **event-adapter 的 send 方法名未确认**。plan 中引用 `this.sendToClients`，但 review 指出 event-adapter 实际使用 `this.send`（WsSender）。subagent 执行时需确认实际方法名。
2. **传递依赖列表需要在 Task 5 执行时动态生成**。plan 中的 electron-builder.yml 修改需要先运行扫描命令确定具体依赖名称，不能预设。
3. **pi-ext 的 tsc 构建和 npm publish 时序**。FR-4 被标注为 postponed，但 Task 4 的 npm install 依赖 pi-ext 已发布。Phase 3 开始前需确认 pi-ext 是否已 publish。

## 2. Harness Usability Review

### Flow Friction

- **writing-plans skill 的"禁止实现代码"与"No Placeholders"规则矛盾**。一方面说"Every step must contain the actual content...code blocks required for code steps"，另一方面 Self-Check 说"plan 中是否包含函数体、完整类定义或其他实现代码？如包含：删除"。对于一个 TypeScript 项目，interface 签名 + 示例代码片段的边界非常模糊。实际执行中选择了保留代码片段（因为 plan 需要给 subagent 足够的指导），但这个矛盾造成了不必要的犹豫。

### Gate Quality

- Phase 2 gate 检查项从 Phase 1 的 4 项增加到 10 项，覆盖全面：plan.md verdict、complexity、e2e-test-plan、test_cases JSON 有效性、use-cases、non-functional-design、plan_review。没有误报。
- **complexity=L1 时自动跳过 plan_bl_review** 是合理的。避免了不必要的审查轮次。

### Prompt Clarity

- writing-plans skill 的 L1/L2 评估维度清晰。5 个维度都是 L1 → 整体 L1，判定逻辑简单明确。
- Execution Groups 模板详细，但缺少对"跨层 Task"的处理指导。建议补充。

### Automation Gaps

- **plan review 的多轮编排仍然是手动的**（dispatch → 检查结果 → 修复 → 重新 dispatch）。与 Phase 1 相同的自动化缺口。
- **传递依赖扫描命令**需要在 Phase 3 执行时运行。plan 中给出了命令模板但没有自动化脚本。可以考虑在 Phase 3 中先写一个小工具脚本。

### Time Sinks

- **deduplicate 逻辑修复**虽然只改了几行代码，但分析优先级方向花了较多思考时间（升序 + first-write-wins vs 降序 + last-write-wins 的排列组合）。
- **Task 3 拆分影响范围广**。拆分后需要同步更新：File Structure、Spec Coverage Matrix、Spec Metrics Traceability、Execution Groups（BG1/FG1 任务列表、文件数、读取文件列表）、Wave Schedule。一个拆分触发 5+ 处更新。
