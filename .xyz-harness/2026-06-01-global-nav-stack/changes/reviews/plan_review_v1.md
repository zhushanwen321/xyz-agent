---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-01T22:30:00"
  target: ".xyz-harness/2026-06-01-global-nav-stack/plan.md"
  verdict: fail
  summary: "计划评审第1轮，2条MUST FIX（activeTab watcher 时序 bug + 非存在属性引用），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 3 Step 2 (activeTab watch)"
    title: "SettingsView activeTab 恢复 watcher 缺少 { immediate: true }"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 4 Step 3 (standard/focus case)"
    title: "panelStore.focusedSessionId 属性不存在，引用了非 existent API"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 5 Files 列表"
    title: "Task 5 文件列表包含 AppSidebar.vue 但无显式修改步骤"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 4 Step 3 (standard shortcut)"
    title: "Cmd+J standard 快捷键 push 新 entry 的语义待确认"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Task 5 (AppHeader.vue)"
    title: "AppHeader.vue L35 class binding 的 settingsStore.currentView 引用未显式列出迁移"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md:FR-3 vs plan.md:Task 4"
    title: "FR-3 Settings 按钮行为 spec 写 push，plan 实现 toggle，语义一致但表述不同"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-01 22:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-01-global-nav-stack/plan.md` + `spec.md` + 关联源码文件

## 检查维度逐项结论

### 1. spec 完整性

**结论：通过**

- 目标明确：用浏览器式导航历史栈替代 `settingsStore.currentView` 的 toggle 切换，统一 Chat ↔ Settings 视图切换并激活 ◀▶ 按钮
- 范围合理：纯前端状态管理，不侵入 PanelStore/SessionStore，明确列出了 OS-1~OS-6 的排除项
- AC 可量化：AC-1~AC-6 全部可写测试验证（导航序列、截断、tab 恢复、按钮状态、快捷键）
- AMBIGUOUS 5 项全部标记并在 plan 中给出决议

### 2. plan 可行性

**结论：有条件通过（2 条 MUST FIX）**

- 任务拆分合理：5 个 Task，粒度适中（每个 Task 可由一个 subagent 独立完成）
- 依赖关系正确：Task 1 → Tasks 2,3,4 → Task 5
- 工作量现实：L1 复杂度，1 个新 store + 4 个文件修改，符合 spec 评估
- 代码行号引用已与实际源码逐一对照验证，全部准确（settings.ts:11/48, AppSidebar.vue:59-62/64/90-94, SettingsView.vue:9/20-33/57, App.vue:7/11/231-249, AppHeader.vue:94-95）

### 3. spec 与 plan 一致性

**结论：通过**

逐条对照：

| Spec 需求 | Plan 覆盖 | Task |
|-----------|----------|------|
| FR-1 导航历史栈 | ✅ NavigationStore push/back/forward | Task 1 |
| FR-2 Settings tab 保留 | ✅ updateCurrentTab + getLastSettingsTab | Task 1 + Task 3 |
| FR-3 侧边栏按钮映射 | ✅ AppSidebar ◀▶ + session click | Task 2 |
| FR-4 键盘快捷键 | ✅ ESC + Cmd+, | Task 3 + Task 4 |
| FR-5 Panel 行为不变 | ✅ panelStore 只读 | All |
| AC-1 基本导航序列 | ✅ | Task 1 + Task 2 |
| AC-2 截断行为 | ✅ push truncate | Task 1 |
| AC-3 Settings tab 恢复 | ✅ watcher + updateCurrentTab | Task 1 + Task 3 |
| AC-4 后退关闭 Settings | ✅ back() | Task 2 + Task 4 |
| AC-5 按钮状态 | ✅ canGoBack/canGoForward + :disabled | Task 2 |
| AC-6 快捷键 ESC | ✅ back() | Task 3 |
| C-1~C-5 约束 | ✅ | All |

AMBIGUOUS 决议覆盖：ID-1~ID-5 全部采用 Option A，在 Interface Contracts 和 Task 描述中均有体现。

### 4. Execution Groups 合理性

**结论：通过**

| 检查项 | 结果 |
|--------|------|
| 分组合理性 | FG1: 1 task / 2 files, FG2: 3 tasks / 3 files, FG3: 1 task / 3 files — 均 ≤ 10 文件，✅ |
| 类型划分 | 全部为 frontend task，无混合类型，✅ |
| 功能关联度 | FG1(store) → FG2(UI) → FG3(cleanup) 功能关联紧密，✅ |
| 依赖关系 | FG1 → FG2 → FG3，被依赖 Group 排在前面，✅ |
| Wave 编排 | 3 个 Wave 串行，无并行，无文件冲突，✅ |
| Subagent 配置 | 每组含 Agent、Model、注入上下文、读取/修改文件，✅ |
| 上下文充分性 | Task 描述含具体行号和方法签名，subagent 可独立执行，✅ |

### 5. 接口契约审查

**结论：有条件通过（1 条 MUST FIX）**

- Types（ChatEntry/SettingsEntry/NavEntry）：完整且与 spec 一致
- Store State（entries/pointer）：完整，pointer 初始值 -1 合理
- Computed（currentEntry/currentView/canGoBack/canGoForward）：签名完整，边界条件覆盖（empty → null/false）
- Actions（push/back/forward/updateCurrentTab/getLastSettingsTab）：签名完整，Edge Cases 列出
- Data Flows：7 条用户操作全部映射到 store action → view effect
- Spec Coverage Matrix：AC-1~AC-6 全部有对应行
- Spec Metrics Traceability：所有 FR/AC/C/OS 项都有 adopted 标记和对应 Task

### 6. 前端编码规范

**结论：通过**

- NavEntry 类型定义使用 discriminated union，无 `any`
- 不引入原生 HTML 元素（修改现有组件）
- 无 v-model 相关修改（无表单输入）
- 无硬编码颜色（修改的是逻辑，不是样式）
- Task 1 测试使用 vitest（非 node:test），命令正确 `npx vitest run`

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 3 Step 2 | **SettingsView activeTab 恢复 watcher 缺少 `{ immediate: true }`。** 场景复现：用户 push Settings → 切到 Skills tab → push Chat(A) → `back()` → pointer 回到 Settings entry(activeTab='skills') → `navStore.currentView` 变为 'settings' → v-if 渲染 SettingsView → 组件 mount 时 `const activeTab = ref('providers')` → watcher 注册时 `currentEntry` 已是 Settings entry（在 push/back 过程中已改变）→ watcher 不触发（Vue 的 watch 只观测注册后的变化）→ activeTab 停留在 'providers' 而非 'skills'。 | 在 Task 3 Step 2 的 watcher 描述中增加 `{ immediate: true }` 选项。改为：`watch(() => navStore.currentEntry, cb, { immediate: true })`。这样组件 mount 时 watcher 立即执行一次，从 currentEntry 中恢复 activeTab。 |
| 2 | MUST FIX | plan.md:Task 4 Step 3 | **`panelStore.focusedSessionId` 属性不存在。** Plan 写道 `navStore.push({ view: 'chat', sessionId: panelStore.focusedSessionId ?? '' })`。经 grep 验证，`focusedSessionId` 在整个代码库中不存在（`grep -rn "focusedSessionId" src-electron/renderer/src/` 返回空）。Panel store 的正确 API 是 `panelStore.focusedPanel?.sessionId`（见 AppHeader.vue:72 和 panel.ts:78）。使用不存在的属性会导致 TypeScript 编译错误。 | 将 `panelStore.focusedSessionId ?? ''` 替换为 `panelStore.focusedPanel?.sessionId ?? ''`。 |
| 3 | LOW | plan.md:Task 5 Files 列表 | **Task 5 文件列表包含 AppSidebar.vue 但无显式修改步骤。** Files 列表写了 3 个 modify 文件（settings.ts, AppSidebar.vue, AppHeader.vue），但 Step 1~4 只涉及 AppHeader（Step 1）、settings.ts（Step 2）、grep 验证（Step 3）、lint（Step 4）。AppSidebar.vue 的修改在哪里？如果在 Task 2 中已完成，应从 Task 5 Files 列表中移除。 | 明确 Task 5 是否需要修改 AppSidebar.vue。如果不需要（Task 2 已完成所有修改），从 Files 列表中移除。如果需要（例如清理残留引用），添加显式 Step。 |
| 4 | LOW | plan.md:Task 4 Step 3 | **Cmd+J (standard) 快捷键使用 push 的语义可能不符合用户预期。** 原始行为是 `settingsStore.currentView = 'chat'`（直接赋值，不创建历史）。Plan 改为 `navStore.push({ view: 'chat', ... })`。如果用户在 Settings 中按 Cmd+J 想合并面板回 Chat，push 会在栈中新增一个 Chat entry，而不是简单地回到 Chat。这可能导致用户后续按后退时发现多了一个"意外"的 Chat entry。 | 考虑改用更轻量的方式：如果已在 Chat 中则 no-op；如果在 Settings 中，可以用 `back()`（回到上一个 Chat entry）而非 push。但这是 UX 判断，push 方案也有合理性（ID-2 允许连续重复）。建议保持 push 但在 plan 中记录这个决策理由。 |
| 5 | LOW | plan.md:Task 5 | **AppHeader.vue L35 的 class binding 未显式列入迁移范围。** 当前代码：`{ 'text-accent': settingsStore.currentView === 'settings' }`（AppHeader.vue:35）。Task 5 Step 1 只说更新 `openSettings` 函数，未提到更新这个 class binding。虽然 Step 3 的 grep 应该能捕获，但依赖 grep 发现问题不如显式列出。 | 在 Task 5 Step 1 中增加一条：更新 Settings 按钮的 active class binding，从 `settingsStore.currentView` 改为 `navStore.currentView`。 |
| 6 | INFO | spec.md:FR-3 vs plan.md | **FR-3 写 Settings 按钮 → push，plan 实现 toggle（push/back）。** Spec FR-3 说 `push({ view: 'settings', activeTab: lastTab })`，未明确"已在 Settings 时按 Settings 按钮怎么办"。Plan 在 App.vue @toggle-settings handler 中实现了 toggle 语义（在 Settings 时 back()，不在时 push）。这与当前 UX（toggle button）一致，是合理的。仅记录 spec 措辞不够精确，不影响实现正确性。 | 无需操作。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 等级判定校准

- Issue #1（activeTab 不恢复）：生产环境中 Settings tab 恢复功能失效 → MUST FIX ✓
- Issue #2（引用不存在属性）：编译错误，功能完全不可用 → MUST FIX ✓
- Issue #3~5：文档准确性和 UX 判断，不影响功能正确性 → LOW ✓
- Issue #6：观察记录 → INFO ✓

## 结论

需修改后重审

## Summary

计划评审完成，第1轮，2条MUST FIX（activeTab watcher 时序 bug 导致 tab 恢复失效 + 引用不存在的 panelStore.focusedSessionId 导致编译错误），需修改后重审。
