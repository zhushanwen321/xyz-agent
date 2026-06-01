---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-01-global-nav-stack"
harness_issues:
  - "plan review subagent 发现了主 agent 遗漏的两个真实 bug（watcher immediate:true、focusedSessionId 属性名错误），证明独立审查的价值。但 review 只能通过 dispatch subagent 触发，主 agent 无法在写 plan 时自我检测这类问题。建议 brainstorming skill 在 Step 5（Assumption Audit）增加'前端组件生命周期与 watcher 交互'的检查项。"
  - "L1 plan 的 interface_chain.json 是可选的，但 plan.md 中的 Interface Contracts 章节仍然需要手写大量方法签名表。对于纯前端 store（无 API 契约），方法签名表的价值有限——TypeScript 编译器就能捕获类型错误。建议 L1 纯前端 plan 允许简化 Interface Contracts 为'类型定义 + action 列表'而非完整签名表。"
---

# Plan Phase Retrospect — global-nav-stack

## 1. Phase Execution Review

### Summary

Phase 2 产出 6 个交付物（plan.md / e2e-test-plan.md / test_cases_template.json / use-cases.md / non-functional-design.md / 2 轮 review），覆盖 spec 的全部 5 个 FR 和 6 个 AC。Complexity 评估为 L1（纯前端状态管理），不需要后端/API 拆分。5 个 AMBIGUOUS 决议在 plan 中全部落实。

关键设计决策：
- NavigationStore 作为独立 Pinia store，不修改现有 panelStore/sessionStore
- 3 个 Execution Group（FG1: store + 测试, FG2: UI 接入, FG3: 清理）串行执行
- Settings activeTab 通过 watcher + `{ immediate: true }` 同步（处理 v-if 重建）

### Problems Encountered

1. **Review v1 发现 2 个 MUST_FIX：**
   - `watcher` 缺少 `{ immediate: true }`：SettingsView 用 `v-if` 渲染，每次 back 到 Settings 时组件重建，`watcher` 注册时 `currentEntry` 已是 Settings entry，不触发回调。这是组件生命周期与响应式系统交互的边界问题，在 plan 阶段不容易自检。
   - `panelStore.focusedSessionId` 不存在：正确 API 是 `panelStore.focusedPanel?.sessionId`。这个错误是对 panel.ts API 的记忆偏差——Assumption Audit 验证了 `openSessionSmart` 的存在性，但没验证 `focusedSessionId`。

2. **Review v1 的 3 个 LOW 级问题保持 open**：Task 5 Files 列表包含 AppSidebar.vue 但无显式修改步骤、Cmd+J 的 UX 判断、AppHeader.vue class binding 迁移。这些都是实现细节，留到 dev 阶段处理。

### What Would I Do Differently

- **Assumption Audit 扩大验证范围**：Phase 1 只验证了 spec 引用的接口。Plan 阶段引用了更多 API（`panelStore.focusedPanel?.sessionId`），应该在写 plan 时即时 grep 验证，而不是等 review subagent 发现。
- **先写 Interface Contracts 再写 Task**：这次先写了 Task 再补充签名表，导致 Task 4 的代码引用跟签名表有细微不一致（focusedSessionId）。正确顺序应该是先定义接口，再基于接口写 Task。

### Key Risks for Later Phases

- **SettingsView v-if 重建的完整影响**：watcher 的 `{ immediate: true }` 解决了 activeTab 恢复，但 Settings 内部各 Pane 组件（ProviderPane, SkillsPane 等）是否有自己的 mount 副作用需要在每次导航回来时重新执行？dev 阶段需验证。
- **IPC 'standard'/'focus' 快捷键的 push 逻辑**：当前 plan 在 standard 快捷键触发时尝试 push Chat entry，但 `panelStore.focusedPanel?.sessionId` 可能为空（panel 正在 unbind）。dev 阶段需要处理这个边界。
- **AppHeader.vue 的其他 currentView 引用**：review 指出 AppHeader 的 class binding 可能引用了 currentView，Task 5 需要仔细 grep 清理所有残留。

## 2. Harness Usability Review

### Flow Friction

- **writing-plans skill 对 L1 纯前端项目略显重**：需要产出 use-cases.md、non-functional-design.md、test_cases_template.json 三个辅助文档。对于"1 个新 store + 4 个文件修改"的低复杂度需求，这些文档的 ROI 偏低。尤其是 non-functional-design.md 的"业务安全"和"数据安全"维度明确标注"不适用"。
- **AMBIGUOUS 决议环节顺畅**：Phase 1 的 5 个 AMBIGUOUS 都有推荐方案，plan 阶段直接采用 Option A 即可，不需要额外与用户确认。

### Gate Quality

- Gate 准确检查了所有 6 个交付物的存在性和 YAML frontmatter。无 false positive。
- Anti-fraud review subagent 工作正常（Phase 1 修复 statusline 后环境恢复）。

### Prompt Clarity

- writing-plans skill 的 L1/L2 判断标准清晰，5 个维度表格好用。
- Execution Groups 模板过于后端导向（BG/FG 前缀、TDD subagent 链）。纯前端项目用 FG 前缀但走 TDD 流程（FG1 store 测试）+ 前端流程（FG2 UI 接入），Group 模板的 Agent 链描述需要手动调整。
- Interface Contracts 模板的"方法签名表"对 Pinia store 来说粒度过细——store 的 actions 本身就是 TypeScript 函数，编译器能检查类型。建议对纯 TS store 允许简化为"类型定义 + action 列表"。

### Automation Gaps

- **Self-review 缺乏自动工具支持**：plan 写完后需要手动检查 placeholder、类型一致性、spec 覆盖。如果能自动 grep "TBD/TODO" + 验证引用的文件路径是否存在，可以减少人工检查。
- **Test cases JSON 需手动验证**：`python3 -c "import json; ..."` 验证有效 JSON 是手动的。建议 gate 脚本自动验证 JSON 有效性。

### Time Sinks

- **plan review 的两轮迭代**：v1 发现 2 个 MUST_FIX，修复后 dispatch v2。两轮 review 用了约 10 turn（含 subagent dispatch）。如果主 agent 在写 plan 时即时 grep 验证所有引用的 API，可以一轮通过。
- **Interface Contracts 签名表编写**：对于 L1 纯前端项目，手动写方法签名表的时间约占 plan 编写总时间的 30%，但实际 dev 阶段 TypeScript 编译器就能捕获类型错误。
