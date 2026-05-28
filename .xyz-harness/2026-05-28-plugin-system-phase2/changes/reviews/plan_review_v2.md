---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-28T14:30:00"
  target: ".xyz-harness/2026-05-28-plugin-system-phase2/plan.md"
  verdict: fail
  summary: "计划评审完成，第2轮，1条MUST FIX（renderer路径映射同MF-1类bug），需修改后重审"

statistics:
  total_issues: 11
  must_fix: 1
  must_fix_resolved: 2
  low: 4
  info: 4

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:File Structure 表 + '路径前缀' 注释"
    title: "路径前缀映射错误：runtime/src/ 路径导致双重 src/，tests/ 应为 test/"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-2.9 → plan-backend.md §4 + plan-api-contract.md UI API"
    title: "FR-2.9 showEditor 在 plan 中缺失，spec-plan 不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "plan.md: BG2/BG3/BG4 Task 描述"
    title: "Task 4/5/6 单 Task 文件数偏多（6-9 个文件），建议进一步拆分"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan-backend.md:§5.1"
    title: "executeHooks 总超时逻辑缺乏绝对上限"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:FR-2.10 + plan-backend.md §4.3"
    title: "sessionData.set 在 Bridge 未连接时的行为 spec 层面未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "e2e-test-plan.md:Coverage Matrix"
    title: "E2E test plan 缺少 AC-6 (built-in/external) 的专属测试场景"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "non-functional-design.md → plan-backend.md §1.2"
    title: "non-functional-design 提及的 eval/Function 拦截未在 plan-backend 中约定实现"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "plan-backend.md:§§1-7 vs plan-api-contract.md:Data Flows"
    title: "子文档间数据流描述部分冗余，不影响实现但增加维护成本"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: MUST_FIX
    location: "plan.md:路径前缀注释 + File Structure 表 FG1 行"
    title: "renderer/ 路径前缀映射同样存在双重 src/ 问题：renderer/ = src-electron/renderer/src/ 导致 renderer/src/components/... 展开为 src-electron/renderer/src/src/components/..."
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "spec.md:FR-2.9"
    title: "spec.md FR-2.9 仍完整列出 showEditor 未标示 postpone，v1 评审要求 spec 显式标注"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "plan.md:路径前缀注释 → 'resources/'"
    title: "resources/ 前缀注释'项目根目录下'存在歧义：runtime 实际通过 projectRoot(=src-electron/) 解析，并非 repo root"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录

- 评审时间：2026-05-28 14:30
- 评审类型：计划评审（增量模式—基于 v1 MUST_FIX 验证）
- 评审对象：`.xyz-harness/2026-05-28-plugin-system-phase2/plan.md`
- 验证目标：MF-1（路径映射错误）、MF-2（showEditor 缺失）修复验证 + 回归检查

---

## 1. MF-1 修复验证：路径前缀映射错误

| 子项 | v1 问题 | 修复后 | 状态 |
|------|---------|--------|------|
| (a) | `runtime/` = `src-electron/runtime/src/` + 路径写 `runtime/src/services/...` → 双重 `src/` | `runtime/` = `src-electron/runtime/`，`runtime/src/services/...` → `src-electron/runtime/src/services/...` | ✅ 已修复 |
| (b) | `tests/`（复数）与实际目录 `test/`（单数）不匹配 | 路径注释明确写 `test/`（单数，非 tests），所有文件路径也使用 `test/` | ✅ 已修复 |

**文件系统验证：**
- `src-electron/runtime/src/services/plugin-service/` — 存在 ✅
- `src-electron/runtime/test/` — 存在 ✅
- `src-electron/runtime/tests/` — 不存在 ✅（单数正确）

**结论：MF-1 完全修复。**

---

## 2. MF-2 修复验证：showEditor 缺失

### 2.1 plan.md 的处理

plan.md 的 **Spec Metrics Traceability** 表包含以下行：

| showEditor (FR-2.9) | postponed | Phase 3：需要专用编辑器面板前端组件，超出 Phase 2 前端最小改动范围。api.ui 的 showSelect/showConfirm/showInput/notify 在 Phase 2 实现 |

### 2.2 子文档一致性验证

| 文档 | showEditor 处理 | 状态 |
|------|----------------|------|
| plan-backend.md §4.2 | 仅列出 showSelect/showConfirm/showInput/notify/updateStatusBarItem，不含 showEditor | ✅ 一致 |
| plan-api-contract.md | UI method 常量：UI_SHOW_SELECT/CONFIRM/INPUT/NOTIFY/STATUS_BAR，无 UI_SHOW_EDITOR | ✅ 一致 |
| plan-frontend.md | 未引用 showEditor | ✅ 一致 |

### 2.3 延期理由评估

**主观判断：合理。** 理由分析：
- `showEditor` 需要专用编辑器面板前端组件，这属于完整的 UI 功能（编辑器面板、工具栏、状态管理等），不是简单对话框
- Phase 2 约束明确："前端最小改动，仅新增权限审批对话框和状态栏插件项"
- spec 中的 "Phase 3 做前端" 总体边界也适用于此
- 其余 `api.ui` 方法（showSelect/showConfirm/showInput/notify）复用现有 ExtensionUIDialog 即可实现

**建议**：虽然延期在 plan 层面已标注，但 spec.md FR-2.9 仍完整列出 showEditor 未标注 postpone（见 Issue #10）。

**结论：MF-2 在 plan 层已修复，延期理由合理。**

---

## 3. 回归检查：修复是否引入新问题

### 3.1 发现：`renderer/` 路径前缀同样存在双重 `src/` 问题 [MUST FIX]

MF-1 修复时只修正了 `runtime/` 前缀，但 `renderer/` 前缀存在完全相同的 bug：

```
当前注释：renderer/ = src-electron/renderer/src/
文件路径：renderer/src/components/plugin/PluginPermissionDialog.vue
展开结果：src-electron/renderer/src/src/components/plugin/PluginPermissionDialog.vue  ← 双重 src/
```

**文件系统验证：**
- `src-electron/renderer/src/components/` — 存在，是实际的组件目录 ✅
- `src-electron/renderer/src/src/components/` — 不存在 ❌

**修复方向**：将 `renderer/` 前缀改为 `src-electron/renderer/`（去掉末尾 `src/`），与 `runtime/` 的修复方式一致。

**关联影响**：
- FG1 测试路径 `renderer/tests/PluginPermissionDialog.test.ts`：修正后展开为 `src-electron/renderer/tests/PluginPermissionDialog.test.ts`。但项目内现有 renderer 测试惯例是 co-located（如 `src/composables/useSlashCommands.test.ts` 或 `src/components/chat/__tests__/xxx.test.ts`）。建议将测试文件改为 co-located 位置，例如 `renderer/src/components/plugin/__tests__/PluginPermissionDialog.test.ts`。

### 3.2 `resources/` 路径前缀存在歧义 [INFO]

当前注释：`resources/` = 项目根目录下

但实际上，运行时 session-service 扫描 pi extensions 的路径是：
```
join(this.projectRoot, 'resources', 'pi', 'agent', 'extensions')
```
其中 `this.projectRoot` = `effectiveRoot` = `process.cwd()`（运行时在 dev 模式下为 `<repo>/src-electron/`）。

这意味着 Bridge extension 文件必须在 `src-electron/resources/pi/agent/extensions/bridge/index.ts` 才能被运行时发现。如果 `resources/` 被理解为 repo root，则文件会创建在错误位置。

而对比来看，`runtime/`、`renderer/`、`test/` 前缀都显式包含 `src-electron/`，只有 `resources/` 没写。建议统一为 `resources/` = `src-electron/resources/`。

---

## 4. 发现的问题

### MUST FIX

| # | 问题描述 | 位置 | 修改建议 |
|---|---------|------|---------|
| 9 | **`renderer/` 路径前缀映射同样存在双重 `src/` 问题**：<br><br>当前注释：`renderer/` = `src-electron/renderer/src/`。但文件路径已包含 `src/`（如 `renderer/src/components/...`），导致展开为 `src-electron/renderer/src/src/components/...`。<br><br>这与已修复的 MF-1 是同一类 bug。 | plan.md:路径前缀注释 | 将 `renderer/` = `src-electron/renderer/src/` 改为 `renderer/` = `src-electron/renderer/`。<br><br>测试路径 `renderer/tests/PluginPermissionDialog.test.ts`：修正后展开为 `src-electron/renderer/tests/...`。建议改为 co-located 位置 `renderer/src/components/plugin/__tests__/PluginPermissionDialog.test.ts`，遵循现有项目惯例。 |

### LOW

| # | 问题描述 | 位置 | 修改建议 |
|---|---------|------|---------|
| 3 | **Task 4/5/6 单 Task 文件数偏多**：<br>BG2 6 个、BG3 9 个、BG4 9 个文件。超出 subagent 典型舒适区（≤5 个）。 | plan.md:BG2/BG3/BG4 | 未调整。考虑将 Bridge (BG3) 拆为 BG3a (核心) + BG3b (集成)。BG4 按 RPC handler 维度拆分。 |
| 4 | **executeHooks 总超时无绝对上限**：<br>handler 数量 × 5s，无 max。10 handler → 50s block sendMessage。 | plan-backend.md:§5.1 | 未修复。建议增加 min(count × 5s, 15s) 限制。 |
| 5 | **sessionData.set 失败场景 spec 未定义**：<br>Bridge 未连接返回错误，但 spec FR-2.10 未描述此边界。 | spec.md:FR-2.10 | 未修复。建议 spec FR-2.10 补充说明。 |
| 10 | **spec.md FR-2.9 仍完整列出 showEditor 未标示 postpone**：<br>v1 评审建议 "在 spec 中明确将 showEditor 标记为 postponed to Phase 3"。plan.md 已标注，但 spec.md 未同步更新。访问者仅读 spec.md 时仍以为 showEditor 在 Phase 2 实现。 | spec.md:FR-2.9 | 在 spec.md FR-2.9 末尾追加注记，例如："`showEditor` 推迟到 Phase 3 实现（需要专用编辑器面板前端组件）"。 |

### INFO

| # | 问题描述 | 位置 | 说明 |
|---|---------|------|------|
| 6 | E2E test plan 缺少 AC-6 专属场景 | e2e-test-plan.md | 未处理。 |
| 7 | non-functional-design 的 eval/Function 拦截未在 plan 中体现 | non-functional → plan-backend | 未处理。 |
| 8 | 子文档数据流重复 | plan-backend / plan-api-contract | 未处理。 |
| 11 | `resources/` 前缀注释 "项目根目录下" 存在歧义 | plan.md:路径前缀注释 | 运行时实际通过 `projectRoot(=src-electron/)` 解析，建议改为 `resources/` = `src-electron/resources/`，与其他前缀保持一致格式。 |

---

## 5. 修复后 Spec Metrics Traceability 检查

| AC | 采纳状态 | 对应 Task | v2 状态 |
|----|---------|----------|---------|
| AC-1 Bridge | adopted | Task 5 | ✅ 无变动 |
| AC-2 agentAPI | adopted | Task 4, 6 | ✅ 无变动 |
| AC-3 事件桥接 | adopted | Task 7 | ✅ 无变动 |
| AC-4 权限 | adopted | Task 3 | ✅ 无变动 |
| AC-5 沙箱 | adopted | Task 2 | ✅ 无变动 |
| AC-6 内置/外部 | adopted | Task 1 | ✅ 无变动 |
| AC-7 依赖 | adopted | Task 7 | ✅ 无变动 |
| AC-8 Goal | adopted | Task 8 | ✅ 无变动 |
| AC-9 Todo | adopted | Task 9 | ✅ 无变动 |
| showEditor | postponed | Phase 3 | ✅ plan 已标注，spec 未同步（Issue #10） |

---

## 6. Execution Groups 验证（增量）

| Group | 文件数 | ≤10? | 路径问题 |
|-------|--------|------|---------|
| BG1 | 7 | ✅ | ✅ 已验证路径正确 |
| BG2 | 6 | ✅ | ✅ 路径正确 |
| BG3 | 9 | ✅ | ✅ 路径正确（需注意 resources/ 歧义 Issue #11） |
| BG4 | 9 | ✅ | ✅ 路径正确 |
| BG5 | 5 | ✅ | ✅ 路径正确 |
| BG6 | 6 | ✅ | ✅ 路径正确 |
| BG7 | 5 | ✅ | ✅ 路径正确 |
| FG1 | 3 | ✅ | ❌ **renderer/ 前缀双重 src/（Issue #9）** |

---

## 结论

**需修改后重审。** 存在 1 条 MUST FIX：

1. **`renderer/` 路径前缀映射错误（Issue #9）** — 与 MF-1 同类型 bug。`renderer/` = `src-electron/renderer/src/` 导致 renderer 文件路径出现双重 `src/`。必须修正后编码才能开始。

其余 LOW 和 INFO 问题同 v1，不构成阻塞。

### Summary

计划评审完成，第2轮，1条MUST FIX，需修改后重审。
