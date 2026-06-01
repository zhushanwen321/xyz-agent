---
verdict: pass
must_fix: 0
note: "Manual review (主 agent 直接执行). subagent dispatch 因 statusline extension 缺失 providers/index.js 失败（环境问题，非本项目）。后续 Phase 如需 subagent 须先修复 statusline。"
---

# Spec Review — global-nav-stack

## Summary

Spec 结构完整，6 元素齐全，FR/AC/UC/Out of Scope/Constraints 自洽。Assumption Audit 验证了 15 项代码事实，事实准确无虚构接口。5 个 [AMBIGUOUS] 标记都已给出推荐方案 + 备选，可在 Plan 阶段敲定。verdict: pass。

## Issues Found

### MUST_FIX（阻塞）

无。

### SHOULD_FIX（建议在 Plan 阶段敲定）

1. **ID-3 启动初始化** — AC-1 步骤 1 与前提矛盾，需在 Plan 阶段明确"应用启动时栈的状态"。推荐选项 A：栈为空 + 不自动 push。
2. **ID-4 容量超限 pointer 处理** — C-4 措辞模糊，需在 Plan 阶段选 A（pointer 减 1）或 B（pointer 不变）。推荐 A。
3. **ID-1 + ID-5 关联** — 这两个问题都涉及 "lastTab" 定义，需在 Plan 阶段统一敲定。推荐方案联动：ID-1 选项 A + ID-5 选项 A。

### NIT（细节）

1. **AC-1 步骤 1 与前提矛盾** — 这是 spec 自己的笔误，AC 写"前提栈为空" + 步骤 1 是 `push Chat(A)`，但 Chat(A) 已经在第 1 步 push，说明前提应该是"应用启动时栈为空 + UI 显示 Chat(A)"。Plan 阶段修正措辞。
2. **AppHeader i18n bug** — `(Cmd+)` 应该是 `(Cmd+,)`，与本 spec 无关，附带可修。
3. **Cmd+, 全局快捷键当前不在 Chat 视图下生效** — Plan 阶段需要把 Cmd+, 的注册上移到 App.vue 或 IPC 侧。

## 6-Element Check

| 元素 | 检查 | 结果 |
|------|------|------|
| Outcomes | UC-1/2/3 描述了具体用户场景和预期结果 | ✅ |
| Scope boundaries | 6 项 Out of Scope 明确划界 | ✅ |
| Constraints | C-1 ~ C-5 全部声明 | ✅ |
| Decisions made | "1 个新 store + 4 个文件修改"明确 | ✅ |
| Task breakdown | Plan 阶段处理 | N/A (spec 阶段) |
| Verification | AC-1 ~ AC-6 全部可测试 | ✅ |
| Business use cases | UC-1/2/3 三个用例 | ✅ |

## Assumption Audit 验证质量

15 项代码事实验证全部 [VERIFIED]。无虚构接口，无凭记忆写出的字段名。验证了：

- `settingsStore.currentView` / `setView` 真实存在（settings.ts:11, 48）
- `panelStore.openSessionSmart` 真实存在（panel.ts:173-184）
- 侧边栏 ◀▶ 按钮存在但无 handler（AppSidebar.vue:90-95）
- handleSessionClick 不调用 setView('chat')，解释了"Settings 无法被导航离开"问题
- Cmd+, 快捷键只在 SettingsView 内部注册，解释了 Chat 视图下快捷键失效

## 与项目架构一致性

- ✅ 不修改 panel tree（OS-1, C-2 双重约束）
- ✅ 不修改 session binding（OS-2, C-1 双重约束）
- ✅ 不修改 PanelStore / SessionStore（C-1）
- ✅ 不持久化（C-5 与 settingsStore.persist.pick 不含 currentView 一致）

## AC 可测试性映射

| AC | 单元测试目标 | 可测试性 |
|----|--------------|----------|
| AC-1 | NavigationStore.push 序列 + back/forward | ✅ 纯逻辑 |
| AC-2 | NavigationStore.push 截断行为 | ✅ 纯逻辑 |
| AC-3 | NavigationStore + SettingsView activeTab 同步 | ⚠️ 需要组件测试 |
| AC-4 | NavigationStore.push + back | ✅ 纯逻辑 |
| AC-5 | NavigationStore.canGoBack / canGoForward getter | ✅ 纯逻辑 |
| AC-6 | SettingsView.ESC 行为 | ⚠️ 需要组件测试 |

AC-3 和 AC-6 需要组件级测试（vue-test-utils），Plan 阶段需考虑是否引入测试工具或仅做 e2e 覆盖。

## Conclusion

Spec 通过。无需 MUST_FIX。建议在 Plan 阶段敲定 3 个 [AMBIGUOUS] 选项（ID-3 / ID-4 / ID-1+ID-5），并修正 AC-1 步骤 1 的措辞问题。

verdict: pass (must_fix: 0)
