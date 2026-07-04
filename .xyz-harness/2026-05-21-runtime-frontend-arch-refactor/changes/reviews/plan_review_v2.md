---
verdict: pass
must_fix: 0
---

<!--
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-22T16:30:00"
  target: ".xyz-harness/2026-05-21-/plan.md"
  verdict: pass
  summary: "计划评审完成，第2轮通过，3条MUST FIX已全部修复，0条open MUST FIX"

statistics:
  total_issues: 11
  must_fix: 0
  must_fix_resolved: 3
  low: 5
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:BG3/Task8 → SessionService constructor"
    title: "AC-3 要求 SessionService 构造函数接受 IRpcClient 和 IEventAdapter，但 plan 使用 IProcessManager 和 adapterFactory"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "e2e-test-plan.md:Scenario 2"
    title: "E2E 缺少 session compact/clear/restore/history 操作的测试场景"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "e2e-test-plan.md:全文"
    title: "E2E 缺少 AC-7 (Scanner Base) 测试场景"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "plan.md:BG2/BG3/FG1 Execution Groups"
    title: "多个 Group 的单 subagent 文件数超过 5 个建议上限"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "plan.md:Wave Schedule"
    title: "FG1 独立于 Runtime 工作，可提前到 Wave 1 并行执行"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "plan.md:BG2 Execution Flow"
    title: "Task 4/5 对 Task 3 的依赖过度指定"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md:AC-1"
    title: "AC-1 handler 计数 '28' 与列出的分类汇总 (9+2+10+2+3+1=27) 不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 8
    severity: LOW
    location: "spec.md:AC-5"
    title: "AC-5 引用 session-pool.ts import convertPiHistory，但 session-pool.ts 在 BG3 被整体删除"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 9
    severity: INFO
    location: "plan.md:BG3/Task8 → SessionService constructor"
    title: "adapterFactory 模式是比 spec 直接注入 IEventAdapter 更好的设计（每个 session 需要独立 adapter 实例）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "plan.md:BG3/Task7 → IConfigService"
    title: "IConfigService 使用 ReturnType<import(...)> 惰性类型引用，需执行时验证编译兼容性"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: LOW
    location: "e2e-test-plan.md:Scenario 6"
    title: "E2E 有两个 Scenario 6（Type Safety Verification 和 Dead Code Verification），编号重复"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-22 16:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-21-/plan.md` + `e2e-test-plan.md`（对照 `spec.md`）
- 评审轮次：第 2 轮（v1 的 3 条 MUST FIX 修复后重审）

---

## 1. v1 MUST FIX 修复验证

### MF-1 (Issue #1): AC-3 SessionService 构造函数签名 — RESOLVED

**v1 问题**：Spec AC-3 要求 SessionService 构造函数直接接受 `IRpcClient` 和 `IEventAdapter`，但 plan 使用 `IProcessManager`（间接获取 client）和 `adapterFactory`（工厂模式）。

**修复验证**：Spec AC-3 已更新为：
> `SessionService` 构造函数接受 `IProcessManager`、`IMessageBroker`、`IEventAdapter` 工厂参数（adapter factory: `(sessionId: string) => IEventAdapter`）。不直接接受 `IRpcClient` — 通过 `IProcessManager.createSession()` 间接获取

Plan 的 SessionService 构造函数：
```typescript
constructor(
  private pm: IProcessManager,
  private broker: IMessageBroker,
  private adapterFactory: (sessionId: string) => IEventAdapter,
) {}
```

**结论**：Spec 和 Plan 完全对齐。spec 主动采用了 plan 的设计（通过 IProcessManager 间接获取 IRpcClient + adapter 工厂模式），并在 AC-3 中明确说明了理由。

### MF-2 (Issue #2): E2E session compact/clear/restore/history 场景 — RESOLVED

**v1 问题**：E2E Scenario 2 仅覆盖 create/list/switch/rename/delete，缺少 compact/clear/restore/history。

**修复验证**：Scenario 2 现包含 10 个步骤，完整覆盖所有 session 操作：

| 步骤 | 操作 | 覆盖项 |
|------|------|--------|
| Step 1 | `session.create` | create |
| Step 2 | `session.list` | list |
| Step 3 | `session.switch` | switch |
| Step 4 | `session.rename` | rename |
| Step 5 | `session.history` | **history (新增)** |
| Step 6 | `session.compact` | **compact (新增)** |
| Step 7 | `session.clear` | **clear (新增)** |
| Step 8-9 | `session.create` + `session.restore` | **restore (新增)** |
| Step 10 | `session.delete` | delete |

**结论**：4 个缺失操作全部补充。Scenario 2 现在完整覆盖 AC-1 的所有 session 生命周期方法。

### MF-3 (Issue #3): E2E AC-7 Scanner Base 测试场景 — RESOLVED

**v1 问题**：Scanner Base 提取（FR-7）无任何 E2E 测试场景。

**修复验证**：新增 Scenario 5 "Scanner Base Dedup"，包含 6 个验证步骤：

1. `grep "expandHome" runtime/src/scanner-base.ts` → 有匹配
2. `grep "inferSourceType" runtime/src/scanner-base.ts` → 有匹配
3. `grep "expandHome" runtime/src/skill-scanner.ts runtime/src/agent-scanner.ts` → 无匹配
4. `grep "import.*scanner-base"` → 有匹配
5. 功能测试：`config.scanSkills` 正常
6. 功能测试：`config.scanAgents` 正常

**结论**：覆盖了结构验证（grep 检查提取是否完成）和功能验证（scan 操作走 scanner-base 路径），映射到 AC-7。

---

## 2. v1 LOW/INFO 问题状态

### 已解决 (v1 → v2)

| # | 问题 | 修复方式 |
|---|------|---------|
| #7 | AC-1 handler 计数 28→27 | Spec 已修正为 "27 个消息 handler case"，9+2+10+2+3+1=27 一致 |
| #8 | AC-5 引用 session-pool.ts | 已更新为 "session-service.ts（替代已删除的 session-pool.ts）import convertPiHistory" |

### 未解决（LOW/INFO，不阻塞）

| # | 问题 | 评估 |
|---|------|------|
| #4 | BG2/BG3/FG1 文件数超 5 上限 | LOW，变更多为机械性，实际风险可控 |
| #5 | FG1 可提前到 Wave 1 | LOW，Wave 2 调度保守但正确 |
| #6 | Task 4/5 对 Task 3 依赖过度 | LOW，过度指定不导致错误，只是保守 |

---

## 3. 新发现问题

### Issue #11: E2E Scenario 6 编号重复

E2E test plan 中有两个 "Scenario 6"：
- 第一个 Scenario 6: Type Safety Verification（AC-2）
- 第二个 Scenario 6: Dead Code Verification（AC-4）

后续 Scenario 7-11 编号正常。Dead Code Verification 应为 Scenario 7，后续依次顺延。

这是文档编号问题，不影响测试覆盖完整性，标为 LOW。

---

## 4. 完整性复核

### 4.1 AC 覆盖矩阵（v2 更新）

| AC | E2E Scenario | 覆盖状态 |
|----|-------------|---------|
| AC-1 (Service Layer) | S2 (Session CRUD), S3 (Config CRUD), S4 (Model), S7 (DI Structure) | ✅ 完整 |
| AC-2 (Type Safety) | S6a (Type Verification) | ✅ |
| AC-3 (DI) | S7 (DI Structure) — 含构造函数签名 grep 检查 | ✅ |
| AC-4 (Dead Code) | S6b (Dead Code Verification) | ✅ |
| AC-5 (Message Converter) | S8 (Message Converter) | ✅ |
| AC-6 (Config Store) | S3 (Config CRUD) | ✅ |
| AC-7 (Scanner Base) | S5 (Scanner Base Dedup) | ✅ |
| AC-8 (Notification) | S9 (System Notification) | ✅ |
| AC-9 (refCount) | S10 (refCount) | ✅ |
| AC-General | S1 (Start/Stop), S11 (Build) | ✅ |

**所有 AC 都有对应 E2E 场景，无遗漏。**

### 4.2 FR 覆盖矩阵（v2 确认）

| FR | Plan Task | 覆盖 |
|----|-----------|------|
| FR-1 | Task 7 + Task 8 | ✅ |
| FR-2 | Task 3 + Task 6 | ✅ |
| FR-3 | Task 7 + Task 8 | ✅ |
| FR-4 | Task 1 + Task 9 | ✅ |
| FR-5 | Task 2 | ✅ |
| FR-6 | Task 4 | ✅ |
| FR-7 | Task 5 | ✅ |
| FR-8 | Task 9 | ✅ |
| FR-9 | Task 10 | ✅ |

### 4.3 Spec-Plan 一致性（v2 确认）

v1 中唯一的 spec-plan 不一致（AC-3 构造函数签名）已通过对齐 spec 解决。当前无其他不一致项。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | ~~MUST FIX~~ | plan.md:BG3/Task8 | ~~AC-3 构造函数签名不一致~~ | 已修复：spec AC-3 已更新 |
| 2 | ~~MUST FIX~~ | e2e-test-plan.md:Scenario 2 | ~~缺少 compact/clear/restore/history 测试~~ | 已修复：Scenario 2 补充至 10 步 |
| 3 | ~~MUST FIX~~ | e2e-test-plan.md | ~~缺少 AC-7 Scanner Base 测试~~ | 已修复：新增 Scenario 5 |
| 4 | LOW | plan.md:BG2/BG3/FG1 | 文件数超 5 上限 | 可在执行时视情况拆分 |
| 5 | LOW | plan.md:Wave Schedule | FG1 可提前到 Wave 1 | 可优化但不阻塞 |
| 6 | LOW | plan.md:BG2 | Task 4/5 对 Task 3 依赖过度 | 可并行但不影响正确性 |
| 7 | ~~LOW~~ | spec.md:AC-1 | ~~handler 计数 28≠27~~ | 已修复：修正为 27 |
| 8 | ~~LOW~~ | spec.md:AC-5 | ~~引用已删除的 session-pool.ts~~ | 已修复：改为 session-service.ts |
| 11 | LOW | e2e-test-plan.md:Scenario 6 | Scenario 6 编号重复（Type Safety 和 Dead Code 都是 S6） | Dead Code 改为 S7，后续顺延 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

**通过。**

v1 的 3 条 MUST FIX 全部修复：
1. AC-3 已对齐 spec 和 plan 的 SessionService 构造函数签名（spec 采用 plan 的 adapter factory 设计）
2. E2E Scenario 2 补充了 compact/clear/restore/history 4 个操作
3. E2E 新增 Scenario 5 覆盖 AC-7 Scanner Base

剩余 4 条 LOW（#4 文件数、#5 Wave 优化、#6 依赖过度、#11 编号重复）均不阻塞执行。

### Summary

计划评审完成，第2轮通过，3条MUST FIX已全部修复，0条open MUST FIX。
