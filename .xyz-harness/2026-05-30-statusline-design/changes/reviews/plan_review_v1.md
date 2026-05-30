---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-30T22:00:00"
  target: ".xyz-harness/2026-05-30-statusline-design/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，3条MUST FIX，需修改后重审"

statistics:
  total_issues: 8
  must_fix: 3
  must_fix_resolved: 0
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md → File Structure table + BG1 section"
    title: "缺少 index.ts 文件追踪 — setStatus 管道将断裂"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plan-frontend.md §2.1 Data Sources → contextOutputTokens"
    title: "contextOutputTokens 无数据源，tokenUsage 代理可能语义错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "plan.md → Context Discovery Notes #1 + BG1 Tasks"
    title: "context.update 后端未实现但无 Task 解决 — InputToolbar context bar 永远显示 0%"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan-frontend.md §3.1 → SessionStrip branch data source"
    title: "gitBranch 字段不存在，cwd 目录名是分支名的弱代理"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "plan-frontend.md §4.3 → piVersion data source"
    title: "piVersion 数据源未确认"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "plan-backend.md §1.2 + §2.2 方案A"
    title: "plugin:statusSetUpdate 加入 ServerMessageType 但实际是死代码"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "test_cases_template.json → AC-5, AC-2 边界"
    title: "测试用例缺少 AC-5 chip 路由规则和 AC-2 模型切换失败 toast 的显式验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "plan.md → Wave Schedule"
    title: "FG1 依赖 BG1 Task 1 的 protocol types，但 Task 6 同时需要 BG1 Task 4 的广播格式确定"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-30 22:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-30-statusline-design/plan.md` + 子文档（plan-backend.md, plan-frontend.md, plan-api-contract.md）

## 逐维度检查结果

### 1. Spec-Plan 一致性

逐条对照 spec FR/AC 与 plan Task 覆盖：

| Spec 项 | Plan Task(s) | 覆盖状态 |
|---------|-------------|---------|
| FR-1 (event-adapter setStatus) | Task 1, 2, 3 | ✅ 覆盖 |
| FR-2 (statusline plugin) | Task 5 | ✅ 覆盖 |
| FR-3 (Input Toolbar) | Task 7 | ✅ 覆盖 |
| FR-4 (Session Strip) | Task 8 | ✅ 覆盖 |
| FR-5 (Global Statusbar) | Task 9 | ✅ 覆盖 |
| FR-6 (statusBarUpdate 增强) | Task 4 | ✅ 覆盖 |
| FR-7 (开发指南) | Task 11 | ✅ 覆盖 |
| AC-1 (setStatus→frontend) | Tasks 1-5 | ✅ 覆盖 |
| AC-2 (Input Toolbar 功能) | Task 7 | ⚠️ 部分风险（contextOutputTokens 数据源） |
| AC-3 (Session Strip) | Tasks 6, 8 | ✅ 覆盖 |
| AC-4 (Global Statusbar) | Tasks 6, 9 | ✅ 覆盖 |
| AC-5 (信息不重复) | Tasks 6, 8, 9 | ✅ 覆盖（scope routing 设计完整） |
| AC-6 (statusBarUpdate 增强) | Task 4 | ✅ 覆盖 |
| AC-7 (开发指南) | Task 11 | ✅ 覆盖 |
| AC-8 (bridge:event 修复) | Task 3 | ✅ 覆盖 |

**结论**：FR 和 AC 均有对应 Task 覆盖，无遗漏。AC-2 存在数据源风险（见 Issue #2）。

---

### 2. Task 可行性

**文件路径验证**：plan 中引用的所有 13 个文件均已确认存在 ✅

**代码位置验证**：
- event-adapter.ts setStatus 丢弃逻辑：行 199-200 ✅
- server.ts bridge:event：行 715 ✅
- plugin-service updateStatusBarItem：行 404 ✅
- provider.ts thinkingLevelMap：行 21 ✅
- chatStore contextUsagePercent/contextInputTokens：行 46-48 ✅

**问题**：见 Issues #1-3。

---

### 3. Execution Groups 合理性

| Group | 文件数 | Task 数 | 判定 |
|-------|--------|---------|------|
| BG1 | **6（实际应为 7）** | 4 | ⚠️ 遗漏 index.ts（Issue #1） |
| BG2 | 2 | 1 | ✅ |
| FG1 | 6 | 5 | ✅ |
| FG2 | 1 | 1 | ✅ |

所有组文件数 ≤ 10 ✅。前端 Task 和后端 Task 正确分组，无混合 ✅。

Wave 编排：Wave 2 中 BG2 和 FG1 可并行（无文件冲突）✅。

Subagent 配置：每组均包含 Agent、注入上下文、读取文件、修改/创建文件 ✅。

---

### 4. API 契约完整性

**plan.md ↔ plan-api-contract.md 一致性**：

| 接口 | plan.md | plan-api-contract.md | 一致 |
|------|---------|---------------------|------|
| StatusBarItem (scope/sessionId) | ✅ | ✅ | ✅ |
| StatusSetUpdatePayload | ✅ | ✅ | ✅ |
| StatusBarItemOptions | ✅ | ✅ | ✅ |
| PluginService.updateStatusBarItem | ✅ | ✅ | ✅ |
| PluginService.getStatusBarItems | ✅ | ✅ | ✅ |
| PluginService.clearStatusBarItems | — | ✅ (§5.7 建议) | ✅ (plan 不冲突) |
| EventAdapterOptions.onStatusSetUpdate | — | ✅ (§5.1) | ✅ |
| Server.handleStatusSetUpdate | — | ✅ (§5.2) | ✅ |

**AC 覆盖矩阵**：plan.md Spec Coverage Matrix 包含所有 8 个 AC ✅。

**前端-后端接口对齐**：
- shared `StatusBarItem` → 前端 `PluginStatusItem`：字段对应（scope/sessionId 新增）✅
- WS `plugin:statusBarUpdate` payload：前后端一致 ✅
- RPC `plugin.ui.updateStatusBarItem`：Worker proxy ↔ 主线程 handler 签名对齐 ✅

---

### 5. 前端-后端接口对齐

**StatusBarItem 数据流**：
```
shared/protocol.ts (StatusBarItem)
  → plugin-service.ts (Map<pluginId:id, StatusBarItem>)
  → WS plugin:statusBarUpdate { items: StatusBarItem[] }
  → frontend types/plugin.ts (PluginStatusItem) — 独立扩展 scope/sessionId
  → plugin store → computed routing
```

两处类型定义（shared + frontend local）分别扩展，字段一致 ✅。

**关键对齐验证**：
- `scope` 字段：shared 定义 → plugin-service 填充 → WS 传递 → frontend 读取 ✅
- `sessionId` 字段：同上 ✅
- 默认值处理：后端 plugin-service 填充默认值（priority=100, scope='global'），前端 `(item.scope ?? 'global')` 兜底 ✅

---

### 6. Placeholder 扫描

| 位置 | 内容 | 严重程度 |
|------|------|---------|
| plan-frontend.md §2.1 Data Sources | `contextOutputTokens` 标注 "*(needs discovery)*" | **Issue #2** |
| plan.md Context Discovery #1 | 建议 BG1 增加 context.update 子步骤，但无 Task | **Issue #3** |
| plan-frontend.md §4.3 | piVersion 数据源未确认，fallback 方案为省略 | Issue #5 |

无 TBD/TODO 标记 ✅（但有等效的未解决问题）。

---

### 7. 测试覆盖

**test_cases_template.json 格式验证**：18 个测试用例，JSON 格式正确 ✅

**AC → TC 映射**：

| AC | 覆盖 TC | 覆盖状态 |
|----|---------|---------|
| AC-1 (setStatus→frontend) | TC-1-01, TC-1-02, TC-2-02, TC-3-01, TC-3-02, TC-8-01 | ✅ 完整 |
| AC-2 (Input Toolbar) | TC-5-01, TC-5-02, TC-5-03, TC-5-04 | ⚠️ 缺少模型切换失败 toast 验证 |
| AC-3 (Session Strip) | TC-6-01, TC-6-02 | ✅ 完整 |
| AC-4 (Global Statusbar) | TC-7-01 | ✅ 完整 |
| AC-5 (信息不重复/chip 路由) | TC-6-01, TC-7-01（隐含） | ⚠️ 无显式测试验证"同一 chip 不同时出现在两处" |
| AC-6 (statusBarUpdate 增强) | TC-4-01, TC-4-02, TC-4-03 | ✅ 完整 |
| AC-7 (开发指南) | TC-9-01 | ✅ 完整 |
| AC-8 (bridge:event 修复) | TC-2-01 | ✅ 完整 |

**缺失测试场景**（Issue #7）：见下方 Issues 表。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md → File Structure + BG1 Files | **index.ts 文件遗漏**：plan-backend.md §2.4 和 Appendix A 明确要求修改 `src-electron/runtime/src/index.ts` 来连接 `onStatusSetUpdate` 回调到 server。但 plan.md 的 File Structure 表和 BG1 Files（"6 个文件"）均未列出此文件。如果不修改 index.ts，event-adapter 的 `onStatusSetUpdate` 回调无人注册，整个 setStatus 管道断裂。 | 在 File Structure 表新增 `src-electron/runtime/src/index.ts` (modify, BG1)，更新 BG1 文件数为 7。确保 Task 2 或 Task 3 的 subagent 注入上下文中包含此文件的修改说明。 |
| 2 | MUST FIX | plan-frontend.md §2.1 + plan.md Context Discovery #2 | **contextOutputTokens 数据源缺失**：spec FR-3 要求 "Token stats: ↑input ↓output"，AC-2 要求 "Token stats 显示 ↑input ↓output"。chatStore 有 `contextInputTokens` 但无 `contextOutputTokens`。plan-frontend 用 `tokenUsage` 作为代理，但 `tokenUsage` 的语义未经确认——如果是总 token 数，显示为 ↓output 将产生错误数据。 | 方案 A（推荐）：在 BG1 中增加一个验证步骤或 Task，确认 pi RPC 返回的 token 数据结构，确定 output tokens 的来源。如有独立字段，映射为 `contextOutputTokens`；如只有总数，前端计算 `output = tokenUsage - contextInputTokens`。方案 B：明确修改 spec，将 FR-3 改为 "↑input ↓total" 并标注为已知限制。 |
| 3 | MUST FIX | plan.md → Context Discovery Notes #1 | **context.update 后端未实现，无 Task 解决**：plan 明确指出 "context.update 后端未实现" 并 "建议选 A，在 BG1 中增加一个子步骤"，但 BG1 的 Task 1-4 中没有包含实现 context.update 发出逻辑的 Task。这意味着 InputToolbar 的 context bar 将永远显示 0%，AC-2 的 "颜色随 usage 百分比变化" 条件无法被验证。 | 在 BG1 中新增 Task（或扩展 Task 3/4）：实现 pi `context.update` 事件的 event-adapter 翻译，将 contextUsagePercent 和 contextInputTokens 推送到 chatStore。更新 File Structure 和 BG1 文件数。如果决定不实现，需修改 spec AC-2 将 context bar 标记为 "依赖后端实现" 并降低验收标准。 |
| 4 | LOW | plan-frontend.md §3.1 | **gitBranch 数据源**：spec FR-4 要求 "当前 git branch 名称"，但 `SessionSummary` 无 `gitBranch` 字段。plan-frontend 建议用 `cwd` 目录名代理。在 bare repo + worktree 模式下目录名通常等于分支名（`git-cwt feat-statusline` → 目录名 `feat-statusline`），所以作为 MVP 可接受。但如果用户通过 `git-cwt` 创建时指定了不同目录名，显示将不准确。 | 建议在 Task 8 实现时添加注释标明这是临时方案，并在 FR-4 旁标注 [待优化]。后续可通过新增 WS 命令 `session.getGitBranch` 获取真实分支名。 |
| 5 | LOW | plan-frontend.md §4.3 | **piVersion 数据源未确认**：plan 提到从 `settingsStore` 或新 WS query 获取，MVP fallback 是省略显示。这不是核心功能（AC-4 只要求 "连接状态 + pi 版本"），但可能导致 AC-4 部分不满足。 | 在 Task 9 的 subagent 上下文中明确：如果 piVersion 在实现时不可获取，用硬编码或省略作为 fallback，不阻塞 AC-4 验收。 |
| 6 | LOW | plan-backend.md §1.2 + §2.2 | **ServerMessageType 包含死类型**：方案 A 使用 `onStatusSetUpdate` 回调，event-adapter `return null`（不走 WsSender 通道）。但 §1.2 仍在 `ServerMessageType` union 中新增 `'plugin:statusSetUpdate'`。这个类型永远不会被用来创建 ServerMessage，是死代码。 | 二选一：(A) 从 ServerMessageType 中移除 `plugin:statusSetUpdate`（因为回调方案不需要它作为消息类型）；(B) 如果为了文档清晰想保留，加注释说明 "此类型仅用于类型系统参考，实际通过回调路由"。推荐 (A)。 |
| 7 | LOW | test_cases_template.json | **测试覆盖缺口**：(a) AC-5 "信息不重复" 缺少显式测试——应有一个 TC 验证"同一 item 不会同时出现在 SessionStrip 和 GlobalStatusbar"。(b) AC-2 模型切换失败场景缺少 TC——应验证"切换失败时恢复原模型显示 + toast 错误提示"。 | 新增 TC：(a) 创建 chip routing 测试，设置一个 item scope=per-session，验证它只出现在 SessionStrip 而不在 GlobalStatusbar。(b) 创建 model switch failure 测试，模拟 RPC 失败，验证 UI 恢复和 toast。 |
| 8 | INFO | plan.md → Wave Schedule | **FG1 隐含依赖**：plan 说 FG1 依赖 BG1 Task 1（protocol types），这是正确的。但 Task 6（plugin store + usePlugin）消费 `plugin:statusBarUpdate` 的 payload 格式，该格式由 BG1 Task 4（plugin-service broadcastStatusBarItems）确定。如果 Task 4 修改了广播格式（如从单 item 改为 items 数组），Task 6 的 handler 需要匹配。当前 plan 中 Task 4 的设计已明确广播 `items: StatusBarItem[]`，与 Task 6 的 handler 一致，所以实际无冲突。记录为观察。 | 无需操作。记录 FG1 对 BG1 Task 4 的隐含数据格式依赖。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

---

### 结论

需修改后重审。

### Summary

计划评审完成，第1轮，3条MUST FIX，需修改后重审。核心问题：(1) index.ts 文件遗漏导致管道断裂；(2) output tokens 数据源未确认；(3) context.update 后端未实现但无 Task 解决。
