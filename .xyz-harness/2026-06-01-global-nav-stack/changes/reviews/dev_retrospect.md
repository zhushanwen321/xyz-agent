---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-01-global-nav-stack"
harness_issues:
  - "五步专项审查对预存在代码的判定标准不清晰。BLR/Standards/Robustness 的 v1 都将预存在问题标记为 MUST_FIX，导致需要 re-review。建议在 reviewer skill 中增加明确的 scope 判定规则：只审查本次 diff 涉及的代码变更，预存在问题标记为 INFO 或 LOW 并注明 pre-existing。这样可以避免无意义的 re-review 循环。"
  - "复杂路径（5+ tasks）下 subagent 并行 dispatch 效率很高，但缺少中间验证点。Wave 2 的 3 个并行 subagent 全部成功，但如果其中一个写错了行号或漏改了引用，Wave 3 才能发现。建议在 FG2 完成后、FG3 开始前加一个快速 lint 验证（不提交），及早发现跨 task 的引用问题。"
  - "防护预检的 hook 检查逻辑不兼容 bare repo + worktree 模式。检查 `.git/hooks/pre-commit` 时找不到文件（worktree 的 .git 是指向 .bare 的文件），但实际 hook 是通过 prepare 的 husky 或 .githooks 安装的。statusline 报告'hook 未安装'是误报。建议检查逻辑增加 `git config core.hooksPath` 和 `.husky` 目录的 fallback。"
---

# Dev Phase Retrospect — global-nav-stack

## 1. Phase Execution Review

### Summary

Phase 3 用 4 个 commit 实现了完整的导航历史栈功能：

1. **60819c1** — NavigationStore 创建（9 unit tests，FG1）
2. **2335aaa** — UI 组件接入（AppSidebar/SettingsView/App.vue，FG2 并行 3 subagent）
3. **2bf5d64** — settingsStore.currentView 清理 + AppHeader 迁移（FG3）
4. **0411a6c** — 修复 lint unused variable
5. **2f3c2cc** — 修复 BLR #1 edge case + Standards 按钮替换
6. **3b0e225** — 审查报告 + 测试结果

最终状态：10/10 unit tests passing，0 lint errors，5 步专项审查全部 pass。

### Problems Encountered

1. **BLR v1 发现 back() 边界 bug**：Settings 作为栈唯一条目时，`canGoBack = pointer > 0` 为 false，back() 不生效，用户无法从 Settings 回到 Chat。这是 plan 阶段 Phase 2 review 没发现的逻辑漏洞（Phase 2 只检查了 watcher immediate 和 focusedSessionId，没检查 canGoBack 的边界条件）。修复：`canGoBack = pointer >= 0`，`back()` 在 pointer=0 时 pop entry 回到空栈。

2. **Lint unused variable**：Wave 3 的 subagent 清理了 settingsStore 的 currentView/setView，但 AppSidebar.vue 中的 `const settingsStore = useSettingsStore()` 变成了 unused import。Subagent 没有运行 lint 验证自己的修改。我手动修复。

3. **Standards Review 将预存在代码标记为 MUST_FIX**：AppSidebar L79/L87 的原生 button 和 SettingsView 的 `py-[9px]` 都是本次改动之前的代码。Standards reviewer 没有区分"本次引入"和"预存在"，导致 5 个 MUST_FIX 中 3 个是误报。v2 审查确认后标记为 out_of_scope。

### What Would I Do Differently

- **在 subagent task prompt 中要求 post-modification lint**：Wave 3 的 subagent 只检查了 grep 残留引用，没有运行 eslint。如果 task prompt 加上 "修改后运行 `npx eslint <file>` 验证 0 errors"，可以避免 unused variable 漏检。
- **BLR 的边界场景应覆盖在 plan 的 test cases 中**：Plan 的 TC 集合有"空栈 push/back"但没有"单条目 back"。如果 Phase 2 test_cases_template.json 包含这个 case，BLR 不需要到 review 阶段才发现。
- **预存在代码的 scope 判定前置**：在 dispatch review subagent 时，明确在 task prompt 中列出本次 diff 涉及的文件和行范围，要求 reviewer 区分 in-scope 和 pre-existing。

### Key Risks for Later Phases

- **SettingsView v-if 重建的 pane 副作用**：每次 back/forward 到 Settings 时组件重建。watcher `{ immediate: true }` 解决了 activeTab 恢复，但 ProviderPane/SkillsPane 等 sub-pane 是否有自己的 mount 副作用（如重新 fetch 数据），Phase 4 手动测试时需验证。
- **AppHeader settings 按钮始终 push**：AppHeader 的齿轮按钮始终 push 新 Settings entry，不会 toggle。这是有意设计（按钮语义 = "打开设置"，不是"切换"），但与 App.vue Cmd+, 的 toggle 行为不一致。Integration review 标记为 LOW，Phase 4 需确认 UX 是否可接受。
- **pointer -= 1 在 capacity 淘汰时的死代码**：BLR 指出 `push()` 中 `pointer.value -= 1` 后紧接 `pointer.value = entries.value.length - 1`，前者被覆盖。逻辑正确（因为 shift 后 length 也减 1），但代码有误导性。可作为 Phase 4 或后续优化项。

## 2. Harness Usability Review

### Flow Friction

- **Subagent dispatch 的 commit 粒度**：Wave 2 的 3 个并行 subagent 各改了不同文件，但都在同一个 git add -A + commit 中提交。这意味着如果需要 revert 某个 subagent 的修改，无法按 subagent 粒度回退。更好的做法是每个 subagent 独立 commit（但并行 subagent 难以做到）。
- **Wave 间的串行等待**：FG1 → FG2 → FG3 严格串行。FG2 的 3 个 task 互不依赖，可以并行，但 FG3 必须等 FG2 全部完成。整体调度是合理的，但 Wave 2 的 3 个 subagent 都成功，总等待时间约等于最长那个 subagent 的执行时间（~30s），效率尚可。

### Gate Quality

- Gate 准确检查了 test_results.md（all_passing: true）和 5 个 review 文件的 verdict。无 false positive。
- 唯一的摩擦是 review v1→v2 的 re-review 循环（3 个 review 需要 v2），增加了约 2 turn 的开销。

### Prompt Clarity

- **Dev skill 的路径判断规则清晰**：5 tasks + 3 Execution Groups → 复杂路径，触发 subagent dispatch。判断无歧义。
- **五步审查的 subagent task prompt 编写耗时**：每个 review subagent 的 task prompt 需要手动指定 read 哪些文件、写入哪个路径、YAML frontmatter 格式。4 个并行 review 的 prompt 编写约占 1 turn 的工作量。如果 skill 能自动从 plan.md 的 File Structure 表中提取文件列表注入 review prompt，可以减少手动工作。
- **Standards Review 的 pre-existing 判定**：reviewer skill 没有明确的 scope 规则。实际执行中，reviewer 将所有发现的问题（包括 pre-existing）都标记为 MUST_FIX，导致不必要的 re-review。

### Automation Gaps

- **缺少 diff scope 自动注入**：review subagent 的 task prompt 需要手动说明哪些文件是本次改动。如果有工具自动运行 `git diff --name-only` 并注入到 review prompt，可以避免手动列举。
- **缺少 post-subagent lint 自动化**：subagent 完成后没有自动 lint 验证。如果 orchestrator 层在 subagent 完成后自动运行 `eslint --no-error-on-unmatched-pattern`，可以在 commit 前发现 unused variable。
- **Re-review dispatch 缺少增量模式**：v2 review 的 task prompt 需要手动指定"验证 v1 的 MUST_FIX #1 已修复"。如果有工具自动从 v1 提取 MUST_FIX 列表生成 v2 prompt，可以减少手动工作。

### Time Sinks

- **Re-review 循环（3 个 review × 2 轮）**：BLR、Standards、Robustness 各需要 v1→v2。主要原因是 v1 将 pre-existing 问题标记为 MUST_FIX。如果 reviewer skill 有 scope 规则区分 pre-existing，至少 2 个 review 可以一轮通过。
- **手动修复 lint unused variable**：1 个 commit + 1 次 lint 重新运行。如果 subagent 自带 post-lint，这部分时间可以省掉。
