---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-28T12:00:00"
  target: ".xyz-harness/2026-05-28-plugin-system-phase2/spec.md, plan.md, plan-backend.md, plan-api-contract.md, plan-frontend.md, e2e-test-plan.md, use-cases.md, non-functional-design.md"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 8
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:File Structure 表 + '路径前缀' 注释"
    title: "路径前缀映射错误：runtime/src/ 路径导致双重 src/，tests/ 应为 test/"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-2.9 → plan-backend.md §4 + plan-api-contract.md UI API"
    title: "FR-2.9 showEditor 在 plan 中缺失，spec-plan 不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

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
---

# 计划评审 v1

## 评审记录

- 评审时间：2026-05-28 12:00
- 评审类型：计划评审
- 评审对象：`2026-05-28-plugin-system-phase2/` — spec.md, plan.md, plan-backend.md, plan-api-contract.md, plan-frontend.md, e2e-test-plan.md, use-cases.md, non-functional-design.md

---

## 1. Spec 完整性

| 维度 | 评价 |
|------|------|
| **目标明确性** | ✅ 清晰—"插件系统后端能力完整化"一句话概括 |
| **范围合理性** | ✅ 边界明确—后端就绪，UI 管理放 Phase 3 |
| **验收标准可量化性** | ✅ AC-1 到 AC-9 均可写测试验证，无模糊表述 |
| **[待决议] 项** | ✅ 未发现 TBD/placeholder 标记 |
| **错误场景覆盖** | ✅ Worker 崩溃、Bridge 断连、并发 tool 调用、插件连续失败、extension_ui_request 无响应均有说明 |

**结论：Spec 完整性合格。**

---

## 2. Plan 可行性

### 2.1 Task 拆分粒度

| Task | 功能 | 文件数 | 评价 |
|------|------|--------|------|
| 1 | Plugin types + built-in scan + registry | 7 | ✅ 合理 |
| 2 | Worker sandbox | 7 | ✅ 合理 |
| 3 | Permission checker | 7 | ✅ 合理 |
| 4 | AgentAPI: tools + hooks RPC handlers | 6 | ⚠️ 偏大（见 Issue #3） |
| 5 | Pi Bridge Extension | 9 | ⚠️ 偏大（见 Issue #3） |
| 6 | AgentAPI: extended APIs | 9 | ⚠️ 偏大（见 Issue #3） |
| 7 | Hook pipeline + plugin dependencies | 5 | ✅ 合理 |
| 8 | Goal plugin conversion | 6 | ✅ 合理 |
| 9 | Todo plugin conversion | 5 | ✅ 合理 |
| 10 | Frontend minimal | 3 | ✅ 合理 |

### 2.2 依赖关系

依赖图正确，拓扑清晰：

```
BG1 ──┬──→ BG2 ──→ BG4 ──┬──→ BG6 (Goal)
      │                   │
      ├──→ BG3 ──→ BG5 ──┤
      │                   │
      └──→ FG1           └──→ BG7 (Todo)
```

- Wave 1: BG1（无依赖）✅
- Wave 2: BG2/BG3/FG1 依赖 BG1，彼此无文件冲突 ✅
- Wave 3: BG4 依赖 BG2，BG5 依赖 BG2+BG3，互不冲突 ✅
- Wave 4: BG6/BG7 独立文件，可并行 ✅

### 2.3 工作量估算

10 个 Task，L2 复杂度，覆盖后端 3 个进程协同（pi、sidecar 主线程、Worker Thread），预估工期 10-15 天与 spec Complexity Assessment 一致。

**结论：Plan 可行性总体合格，Task 4/5/6 拆分粒度需关注。**

---

## 3. Spec-Plan 一致性

### 3.1 FR 覆盖矩阵

| Spec FR | 对应 Task | 覆盖状态 |
|---------|----------|---------|
| FR-1 (Pi Bridge) | Task 5 | ✅ 完全覆盖 |
| FR-2 (agentAPI) — tools, slashCommands, hooks(5种) | Task 4 | ✅ |
| FR-2 (agentAPI) — sessions, config, sessionData, ui, agent, workspace | Task 6 | ❌ **`showEditor` 缺失** |
| FR-3 (事件桥接) | Task 7 | ✅ |
| FR-4 (权限检查) | Task 3 | ✅ |
| FR-5 (Worker 沙箱) | Task 2 | ✅ |
| FR-6 (内置/外部) | Task 1 | ✅ |
| FR-7 (依赖关系) | Task 7 | ✅ |
| FR-8 (Goal 插件) | Task 8 | ✅ |
| FR-9 (Todo 插件) | Task 9 | ✅ |

### 3.2 AC 覆盖矩阵

| AC | 采纳 | 对应 Task | 覆盖状态 |
|----|------|----------|---------|
| AC-1 (Bridge) | adopted | Task 5 | ✅ |
| AC-2 (agentAPI) | adopted | Task 4, 6 | ✅ |
| AC-3 (事件桥接) | adopted | Task 7 | ✅ |
| AC-4 (权限) | adopted | Task 3 | ✅ |
| AC-5 (沙箱) | adopted | Task 2 | ✅ |
| AC-6 (内置/外部) | adopted | Task 1 | ✅ |
| AC-7 (依赖) | adopted | Task 7 | ✅ |
| AC-8 (Goal) | adopted | Task 8 | ✅ |
| AC-9 (Todo) | adopted | Task 9 | ✅ |

**结论：除 `showEditor`（见 Issue #2）外，所有 FR/AC 均有对应 Task。**

---

## 4. Execution Groups 合理性

### 4.1 文件数检查

| Group | Tasks | 文件数 | ≤10? |
|-------|-------|--------|------|
| BG1 | 1-3 | 7 | ✅ |
| BG2 | 4 | 6 | ✅ |
| BG3 | 5 | 9 | ✅ |
| BG4 | 6 | 9 | ✅ |
| BG5 | 7 | 5 | ✅ |
| BG6 | 8 | 6 | ✅ |
| BG7 | 9 | 5 | ✅ |
| FG1 | 10 | 3 | ✅ |

### 4.2 类型划分

- BG1–BG7 均为 backend，FG1 为 frontend ✅
- 无混合类型 Group ✅

### 4.3 Wave 编排

| Wave | Groups | 并行可行性 |
|------|--------|-----------|
| 1 | BG1 | 串行，三个 Task 间有依赖 |
| 2 | BG2, BG3, FG1 | 可并行—修改不同文件 |
| 3 | BG4, BG5 | 可并行—修改不同文件 |
| 4 | BG6, BG7 | 可并行—完全独立文件 |

### 4.4 Subagent 配置完整性

每个 Group 均包含 Agent、Model、注入上下文、读取文件、修改/创建文件定义 ✅

**结论：Execution Groups 总体合理，但路径映射存在错误（见 Issue #1）。**

---

## 5. 接口契约审查（L2）

### 5.1 plan.md ↔ plan-api-contract.md 一致性

所有接口签名在 plan.md Interface Contracts 和 plan-api-contract.md 间一致 ✅

检查内容：
- PluginRPC 方法签名（tool_register, hook_register, sessionData_* 等）✅
- BridgeProtocol 消息格式（bridge:sync, bridge:tool_execute 等）✅
- PermissionChecker 接口 ✅
- PluginService 新增方法 ✅

### 5.2 Data Flows Cross-Reference

plan-api-contract.md 的 Data Flows 中所有引用的方法名均存在于 methods 表中 ✅

| Data Flow | 引用方法 | 存在? |
|-----------|---------|-------|
| Flow 1 (Tool Execute) | handleBridgeToolExecute, toolRegistry | ✅ |
| Flow 2 (Event Forward) | handleBridgeEvent, hookRegistry | ✅ |
| Flow 3 (Intercept) | handleBridgeIntercept, executeHooks | ✅ |
| Flow 4 (SessionData) | sessionData_set, sessionData_get | ✅ |
| Flow 5 (SendMessage Hook) | executeHooks('message:beforeSend') | ✅ |

### 5.3 AC 覆盖矩阵完整性

plan-api-contract.md 的 AC Coverage Matrix 包含所有 9 个 AC ✅

---

## 6. 发现的问题

### MUST FIX

| # | 问题描述 | 位置 | 修改建议 |
|---|---------|------|---------|
| 1 | **路径前缀映射错误**：<br><br>(a) plan.md 备注 "`runtime/` = `src-electron/runtime/src/`"，但文件结构表中路径写为 `runtime/src/services/...`。按此规则组合后的实际路径为 `src-electron/runtime/src/src/services/...`（双重 `src/`）。<br><br>(b) 测试目录名为 `test/`（单数）而非 `tests/`（复数）。<br><br>验证：`src-electron/runtime/src/services/plugin-service/` 下有所有源文件；`src-electron/runtime/test/` 下有测试文件。 | `plan.md:File Structure 表` | 修正路径：<br>(a) `runtime/src/services/...` → `runtime/services/...`（去掉 `src/`），或修改前缀映射为 `runtime/` = `src-electron/runtime/`。<br>(b) `tests/plugin-service/...` → `test/plugin-service/...`。<br>(c) 更新 plan-frontend.md 中同样使用 `tests/` 前缀的 test 文件路径。 |
| 2 | **FR-2.9 `showEditor` 在 plan 中缺失**：<br><br>spec FR-2.9 列出的 `api.ui` 方法包含 `showEditor`，但 plan-backend.md §4 的 UI API 实现清单和 plan-api-contract.md 的 UI API 签名表中均未包含 `showEditor`。<br><br>这是明确的 spec-plan 不一致。 | spec.md:FR-2.9 → plan-backend.md §4.2, plan-api-contract.md UI API | 二选一：<br>(a) 在 plan 中补充 `showEditor` 的 RPC handler 和 Worker proxy（补充到 Task 6/BG4）。<br>(b) 在 spec 中明确将 `showEditor` 标记为 postponed to Phase 3（在 FR-2.9 末尾加注）。 |

### LOW

| # | 问题描述 | 位置 | 修改建议 |
|---|---------|------|---------|
| 3 | **Task 4/5/6 单 Task 文件数偏多**：<br><br>Task 4（6 个文件）、Task 5（9 个文件）、Task 6（9 个文件）每个涉及大量文件。虽然用 TDD 三阶段（test → impl → review）可在同文件内迭代，但 9 个文件超出典型 subagent 上下文舒适区（建议 ≤5 个）。特别是 Bridge (BG3) 包含 7 个 create 文件 + 2 个 modify，且修改涉及 server.ts 和 event-adapter.ts 两个关键路由文件。 | plan.md:BG2/BG3/BG4 | 考虑将 Task 5 (Bridge) 拆为 2 个 Task：BG3a (Bridge 核心：状态机 + sync + tool proxy) 和 BG3b (Bridge 集成：event-adapter.ts + server.ts 路由修改)。Task 6 也可按 RPC handler 维度拆分。 |
| 4 | **executeHooks 总超时逻辑缺乏绝对上限**：<br><br>plan-backend.md §5.1 定义："可拦截 hook 的 executeHooks 总超时 = handler 数量 × 5s"。没有绝对上限。若 10 个插件各注册一个 handler，总超时达 50s。spec FR-3.3 只说 "hook 执行超时 5s"，语义不够清晰。<br><br>建议增加总超时绝对值上限（如 max 15s），防止多 handler 场景下 sendMessage 被 block 过久。 | plan-backend.md §5.1 | 明确总超时上限 min(count × 5s, 15s) 或类似的约束，并在 spec FR-3.3 中补充。 |
| 5 | **sessionData.set 失败场景 spec 层面未定义**：<br><br>plan-backend.md §4.3 定义了 Bridge 未连接时返回 `BRIDGE_NOT_READY` 错误码、缓存不更新。但这个边界行为在 spec FR-2.10 中没有描述。虽然 plan 处理了，但 spec 未反映这一点。 | spec.md:FR-2.10 | 在 spec FR-2.10 中补充一行说明：Bridge 未连接时 sessionData.set 返回错误、数据不写入。 |

### INFO

| # | 问题描述 | 位置 | 说明 |
|---|---------|------|------|
| 6 | **E2E test plan 缺少 AC-6 的专属测试场景**：<br><br>e2e-test-plan.md 的 Coverage Matrix 中将 AC-6 (built-in/external 区分) 标记为 "covered by unit tests"。但 AC-6 包含可端到端验证的行为——例如 built-in 插件无法通过 API 禁用（`togglePlugin(id, false)` 应返回错误），以及 WS 消息中携带 `source` 字段的验证。 | e2e-test-plan.md | 建议在 e2e-test-plan.md 中添加 TS-7 场景：启动后查询插件列表，验证 Goal/Todo 的 source=built-in；尝试禁用一个 built-in 插件，验证返回错误。 |
| 7 | **non-functional-design 的 eval/Function 拦截未在 plan-backend 中约定实现**：<br><br>non-functional-design.md §4 提到 "eval/Function 构造 in sandbox 中也被拦截（bootstrap 脚本覆盖 global.eval 和 global.Function）"。但 plan-backend.md §1.2 (Worker Sandbox) 只描述了 `Module._resolveFilename` 覆盖，未提及 eval/Function 拦截。 | non-functional-design.md → plan-backend.md §1.2 | 如果 eval/Function 拦截是需求的一部分，应在 plan-backend.md §1.2 中补充实现约定；如果不是，non-functional design 中不应承诺 plan 未覆盖的行为。 |
| 8 | **子文档间数据流部分重复**：<br><br>plan-backend.md §§1-7 包含大量数据流描述，plan-api-contract.md 的 Data Flows 章节又以流程图形式重复描述。两者一致性好，但增加后续维护负担——修改一个数据流需要同步两处。 | plan-backend.md §§1-7, plan-api-contract.md Data Flows | 建议保持 plan-api-contract.md 的 Data Flows 章节作为权威定义，plan-backend.md 数据流部分简化为关键接口调用关键接口的格式。 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | plan.md:File Structure + 路径注释 | 路径前缀映射错误：`runtime/src/` 产生双重 `src/`，`tests/` 应为 `test/` | 修正路径映射或去掉 `src/` 段 |
| 2 | **MUST FIX** | spec.md:FR-2.9 → plan-backend/plan-api-contract | FR-2.9 `showEditor` 在 plan 中完全缺失 | 补充实现 or spec 显式 postpone |
| 3 | LOW | plan.md:BG2/BG3/BG4 | Task 4/5/6 文件数 6-9 个，偏大 | 考虑拆分 |
| 4 | LOW | plan-backend.md:§5.1 | executeHooks 总超时无绝对上限 | 增加 max 约束 |
| 5 | LOW | spec.md:FR-2.10 | sessionData.set Bridge 未连接时行为未定义 | spec 补充说明 |
| 6 | INFO | e2e-test-plan.md | 缺少 AC-6 专属 E2E 测试场景 | 可选补充 |
| 7 | INFO | non-functional → plan-backend | eval/Function 拦截未在 plan 中体现 | 统一两处文档 |
| 8 | INFO | 子文档重复 | 数据流描述跨文档重复 | 可选精简 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

**需修改后重审。** 存在 2 条 MUST FIX：

1. **路径前缀映射错误** — 直接影响 subagent 执行时的文件定位，必须在编码开始前修复。
2. **FR-2.9 `showEditor` 缺失** — spec-plan 不一致，必须在编码前解决（补充实现或显式 postpone）。

其余 LOW 和 INFO 问题不影响流程通过，但建议在实现前或实现时一并处理。

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。
