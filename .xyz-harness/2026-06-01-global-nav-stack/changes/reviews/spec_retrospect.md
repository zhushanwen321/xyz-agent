---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-01-global-nav-stack"
harness_issues:
  - "skill_state 状态机缺少 in_progress 中间态，长流程 skill（10+ 步骤）被迫用 error 标记进行中，触发异常累积机制（2 次 error 后强制 recorded）。建议新增 in_progress 状态或按 skill 类型设置不同 turn 阈值。"
  - "coding-workflow-init 的 slug 唯一性检查阻止复用已有目录名。当 spec.md 已存在于 .xyz-harness/2026-06-01-global-navigation/ 但 init 需要创建 workspace 时，必须换 slug（用了 global-nav-stack），导致两个目录存同一主题的文件。建议 init 支持 --existing-dir 参数。"
  - "statusline extension 缺失 providers/index.js 导致所有 subagent dispatch 全局失败（spec review subagent + gate anti-fraud subagent 均受影响）。错误信息不够明确，没有指向具体缺失文件。建议 extension 加载失败时给出可操作的修复提示，或支持 per-extension disable。"
---

# Spec Phase Retrospect — global-nav-stack

## 1. Phase Execution Review

### Summary

Spec 是用户预先写好并放入 `.xyz-harness/2026-06-01-global-navigation/spec.md` 的，verdict: pass。Phase 1 的实际工作是 **review + 补充**，不是从零 brainstorm：

- **Assumption Audit**：验证 15 项代码事实（settingsStore.currentView / panelStore.openSessionSmart / 侧边栏 ◀▶ 按钮 / Cmd+, / ESC / activeTab 等），全部 [VERIFIED]，无虚构接口。
- **Implementation Details to Confirm**：发现 5 个 spec 未明确的设计歧义（lastTab 定义 / 连续同 session 去重 / 启动初始化 / 容量 pointer / push Settings activeTab 来源），以 [AMBIGUOUS] 标记并给出推荐方案。
- **Spec Review**：因 statusline extension 环境问题无法 dispatch subagent，手动完成审查（verdict: pass, must_fix: 0）。用户修复 statusline 后 gate anti-fraud subagent 通过。

关键决策：5 个 AMBIGUOUS 点不阻塞 spec 通过，留给 Plan 阶段敲定。

### Problems Encountered

1. **statusline extension 缺失 providers/index.js**：导致所有 subagent dispatch 失败。影响范围：spec review subagent（手动替代）+ gate anti-fraud subagent（gate 脚本通过但整体被阻塞）。用户手动修复后恢复。
2. **coding-workflow-init slug 冲突**：spec 已存在于 `2026-06-01-global-navigation/` 目录，init 创建 workspace 时必须换 slug（`global-nav-stack`），导致同主题存在两个目录。
3. **skill_state 异常累积误触发**：brainstorming skill 有 10 个步骤，执行过程中被系统提示"10 turn / 20 turn 未终态"，被迫用 error 标记进度，2 次后触发"异常累积需记录"机制。实际上 skill 执行正常，是状态机设计问题。

### What Would I Do Differently

- **先检查 subagent 环境**：在 Phase 开始前 `ls ~/.pi/agent/extensions/statusline/providers/` 确认编译产物存在，避免到 dispatch 阶段才发现全局阻塞。
- **直接在已有目录工作**：不用 init 创建新 workspace，而是把 review 文件写入已有的 `2026-06-01-global-navigation/` 目录。

### Key Risks for Later Phases

- **5 个 AMBIGUOUS 必须在 Plan 阶段敲定**：ID-3（启动初始化）影响应用启动行为，ID-1+ID-5（lastTab）影响 Settings entry 的数据结构，Plan 阶段需明确选择。
- **activeTab 当前是 SettingsView 局部 ref**（非 store），Plan 阶段需要决定是提升到 store 层还是通过 NavigationStore 管理。
- **Cmd+, 快捷键当前不在 Chat 视图下生效**（只在 SettingsView 内注册），实现时需上移到 App.vue 或 IPC 侧。
- **AppHeader i18n `(Cmd+)` 文案 bug**：附带可修，但需确认是否在本 feature scope 内。

## 2. Harness Usability Review

### Flow Friction

- **brainstorming skill 对"spec 已存在"场景没有路径**：skill 假设从 Step 1 开始，但实际用户提供了已完成的 spec（verdict: pass）。我不得不跳过 Step 2-4（提问/方案/设计），直接进入 Step 5（Assumption Audit）+ Step 7（6 元素检查）。这导致流程执行不线性，需要自行判断哪些步骤适用。
- **Gate 要求 spec_review_v*.md 文件**：review subagent 失败时没有 fallback 路径。手动写的 review 文件需要在 frontmatter 里加 note 说明原因，否则 gate 可能质疑 review 的独立性。

### Gate Quality

- Gate 脚本检查准确：发现了 untracked files（未 commit 的 harness 目录）和缺失的 spec_review 文件。两项都是真实问题。
- Gate 的 anti-fraud subagent 在 statusline 修复后正常工作，review verdict=pass, must_fix=0。检查质量合理。

### Prompt Clarity

- brainstorming skill 的 Step 5（Assumption Audit）描述清晰，代码验证模板实用。15 项验证均按模板执行，验证结果直接写入 spec 的 Assumption Audit Summary 章节。
- AMBIGUITY 标记流程明确，推荐方案 + 备选格式便于 Plan 阶段快速决策。

### Automation Gaps

- **spec 已存在时的快速路径缺失**：brainstorming skill 没有"review existing spec"分支。建议增加：如果 spec.md 已存在且 verdict=pass，跳过 Step 1-4，直接进入 Assumption Audit + Review。
- **subagent 环境健康检查缺失**：Phase 开始前没有自动检测 extension 加载能力。建议在 Phase 1 开始时 dispatch 一个低成本的 health-check subagent。

### Time Sinks

- **statusline extension 问题排查**：花了 4-5 turn 定位"为什么所有 subagent 都失败"，包括读 extension 源码、检查 providers/ 目录、尝试不同 agent。如果有更好的错误信息或健康检查，这部分可以省掉。
- **skill_state 异常累积处理**：2 turn 用于响应系统提示 + dispatch subagent 记录问题。这是工具层面的问题，不影响 spec 质量，但增加了不必要的工作量。
