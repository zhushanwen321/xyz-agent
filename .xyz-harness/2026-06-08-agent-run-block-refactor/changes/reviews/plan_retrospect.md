---
phase: plan
verdict: pass
absorbed: false
topic: "2026-06-08-agent-run-block-refactor"
harness_issues:
  - "gate check 不区分新旧 review 文件版本：旧 plan_review_v3(fail) 和新 plan_review_v5(pass) 同时存在时，gate 读到 v3 就判定 fail。建议 gate 取最新版本（按编号排序取最大值）而不是扫描到第一个 fail 就停"
  - "plan review 需要 dispatch subagent 产出 pass verdict 后 gate 才能通过，但 gate 自身不自动触发 review——需要用户手动意识到这一点并 dispatch。建议 gate FAIL 时自动附带提示：请 dispatch 新一轮 review subagent"
  - "Phase 1→2 transition 时 coding-workflow 找不到 xyz-harness-retrospect skill（报 Skill not found），但手动读取 SKILL.md 并写 retrospect 文件后就能继续。skill resolver 的搜索路径应覆盖 npm node_modules 下的 skills"
---

# Plan Phase Retrospect

## 1. Phase Execution Review

**Summary**: 完成 AgentRunBlock 重构的实施计划，包含 8 个 Task、依赖图、E2E 测试计划、22 条测试用例、4 个业务用例、非功能性设计文档。经过 5 轮 review 最终通过（v1-v3 是 gate 自动 dispatch 但 plan 尚未写入导致的空跑，v4 发现 3 个 MUST_FIX，v5 通过）。

**Problems encountered**:
- gate 自动 dispatch 了 v1-v3 三轮 review，但当时 plan.md 还未创建，导致 3 轮都报"交付物缺失"且 must_fix 停滞在 5。这是 gate 和 review 的执行顺序问题：gate 应该在交付物存在后才 dispatch review
- v4 review 发现 3 个实质性问题：(1) T7 streaming 路径架构空白，只说"可能需要调整"而没有具体方案；(2) groupIntoSections API 变更缺少兼容策略；(3) E2E 测试序列与 AC-5 不精确匹配。这 3 个问题都反映了 plan 初版对现有架构理解不够深入

**What would you do differently**:
- 写 T7（streaming 集成）时应该先 grep ChatPanel.vue 的实际渲染逻辑，而不是用模糊语言描述。ChatPanel 的 CompactStreamingBubble 是独立分支、不经过 AssistantContent——这是一个关键的架构事实，不能忽略
- E2E 测试场景应该直接从 spec AC-5 复制精确时序序列，而不是用自己的措辞重述，避免语义偏移

**Key risks**:
- T7（移除 CompactStreamingBubble）涉及 ChatPanel 的 streaming 渲染路径变更，是本 plan 中风险最高的 task。需要在 dev 阶段先验证 StreamingMessage → MessageBubble → AssistantContent 路径在 streaming 状态下工作正常
- standaloneTools 设置的 persist 机制复用现有 settings store，但需确认 Pinia persist 插件的 pick 数组更新后能正确读取旧数据（用户升级后首次加载）

## 2. Harness Usability Review

**Flow friction**:
- gate 的 untracked files 检查在 Phase 1 中误报了旧 .xyz-harness 目录（2026-05-06 等），需要手动 git add 并 commit 无关文件。Phase 2 中此问题已不再出现（Phase 1 时已处理）
- gate FAIL 时只显示旧 review 的 verdict，不提示需要 dispatch 新 review subagent。需要手动理解 gate 的检查逻辑并 dispatch

**Gate quality**: gate 正确检查了 review verdict 和 must_fix 值。但取 review 文件的策略有问题：目录中存在多个版本的 review（v3 fail, v5 pass），gate 读到 v3 就判定 fail。应该取最新版本。

**Prompt clarity**: writing-plans skill 的 Task 模板清晰，依赖图和执行顺序指引有用。L1/L2 复杂度评估标准明确。

**Automation gaps**: retrospect 需要手动写（coding-workflow 找不到 skill），review 需要 dispatch subagent 产出 pass verdict 但 gate 不会自动触发。

**Time sinks**: v1-v3 三轮空跑 review（plan 未创建时就触发审查）消耗了 3 次 subagent 调用。如果 gate 能检测到 plan.md 不存在就直接提示"请先创建交付物"，可以避免这些空跑。
