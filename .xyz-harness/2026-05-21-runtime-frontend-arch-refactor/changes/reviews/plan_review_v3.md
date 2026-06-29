---
review:
  type: plan_review
  round: 3
  timestamp: "2026-05-22T18:00:00"
  target: ".xyz-harness/2026-05-21-/plan.md"
  summary: "计划评审完成，第3轮通过，0条MUST FIX（v2的6条已解决/保留LOW，v3新增1条LOW）"

statistics:
  total_issues: 13
  must_fix: 0
  must_fix_resolved: 3
  low: 7
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

  - id: 12
    severity: LOW
    location: "test_cases_template.json:全文"
    title: "E2E Scenario 5 (Scanner Base / AC-7) 在 test_cases_template.json 中无对应测试用例"
    status: open
    raised_in_round: 3
    resolved_in_round: null

  - id: 13
    severity: LOW
    location: "test_cases_template.json:全文"
    title: "test_cases_template.json 中 TC 编号与 E2E Scenario 编号不对应"
    status: open
    raised_in_round: 3
    resolved_in_round: null

verdict: "pass"
must_fix: 0
---

# 计划评审 v3

## 评审记录
- 评审时间：2026-05-22 18:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-21-/plan.md` + `e2e-test-plan.md` + `test_cases_template.json`（对照 `spec.md`）
- 评审轮次：第 3 轮（最终轮，循环上限 ≤ 3 轮）

---

## 1. v2 verdict 验证

v2 verdict: **pass**（0 MUST FIX open）。v2 已确认：
- 3 条 MUST FIX 全部 resolved（id 1, 2, 3）
- 2 条 LOW resolved（id 7, 8）
- 5 条 LOW/INFO 未解决（id 4, 5, 6, 9, 10）
- 1 条新增 LOW（id 11: Scenario 6 编号重复）

本轮 v3 在此基础上做最终复核，确认 v2 结论有效，并检查是否有新问题引入。

---

## 2. v2 MUST FIX 修复最终确认

### Issue #1: AC-3 构造函数签名 — RESOLVED (v2)

Spec AC-3 已更新为：
> `SessionService` 构造函数接受 `IProcessManager`、`IMessageBroker`、`IEventAdapter` 工厂参数（adapter factory: `(sessionId: string) => IEventAdapter`）。不直接接受 `IRpcClient` — 通过 `IProcessManager.createSession()` 间接获取

Plan 中 SessionService 构造函数签名与 spec AC-3 完全对齐。

### Issue #2: E2E session compact/clear/restore/history — RESOLVED (v2)

E2E Scenario 2 现包含 10 个步骤，完整覆盖 session CRUD。步骤 5 (history)、6 (compact)、7 (clear)、9 (restore) 为 v1 后新增。

### Issue #3: E2E AC-7 测试场景 — RESOLVED (v2)

新增 Scenario 5 "Scanner Base Dedup"（6 个验证步骤），覆盖结构验证（grep 检查提取是否完成）和功能验证（scan 操作正常）。

**本轮复核结论**：三个修复仍然有效。无需本轮调整。

---

## 3. v2 遗留 LOW/INFO 问题状态

| # | 严重性 | 描述 | 当前状态 | 说明 |
|---|--------|------|---------|------|
| 4 | LOW | BG2/BG3/FG1 文件数超 5 上限 | open | 保持 LOW。变更多为机械性，实际风险可控。执行时可视 subagent 上下文大小决定是否拆分 |
| 5 | LOW | FG1 可提前到 Wave 1 | open | 保持 LOW。Wave 2 调度保守但正确，不阻塞 |
| 6 | LOW | Task 4/5 对 Task 3 依赖过度 | open | 保持 LOW。过度指定不导致错误，执行时 subagent 可并行处理 |
| 9 | INFO | adapterFactory 设计优于 spec 单例 | open | 观察记录，已反映在 spec AC-3 中 |
| 10 | INFO | IConfigService ReturnType 编译兼容性 | open | 执行时需验证，无需预先处理 |
| 11 | LOW | Scenario 6 编号重复 | open | 仍存在（见下方 §6） |

---

## 4. 新发现问题

### Issue #12: test_cases_template.json 缺少 AC-7 (Scanner Base) 测试用例

**问题**：E2E test plan 的 Scenario 5 覆盖 AC-7 (Scanner Base)，但 `test_cases_template.json` 中对应的 TC-5-XX 指向的是 Scenario 6 (Type Safety Verification)。AC-7 在测试用例模板中无对应条目。

**影响**：如果测试实现仅参照 `test_cases_template.json` 生成自动化用例，会遗漏 scanner base 提取的验证。

**风险评估**：
- E2E test plan（权威测试规格文档）在 Scenario 5 中详细定义了 6 个验证步骤
- `test_cases_template.json` 是测试用例的结构化摘要，实际测试编写仍会参照 E2E plan
- 不会导致测试遗漏，但降低了下游流程的安全性（若测试工具只解析 JSON 模板）

**优先级**：LOW（E2E plan 已覆盖，不影响测试行为正确性）

**修复方向**：在 `test_cases_template.json` 中新增 TC-5-03（或重新编号以对齐 E2E Scenario 编号），描述 scanner base 验证步骤。

### Issue #13: test_cases_template.json TC 编号与 E2E Scenario 编号不对应

**问题**：`test_cases_template.json` 的 TC 编号与 E2E Scenario 编号存在不一致映射：

| E2E Scenario | 对应 TC ID | 是否对齐 |
|-------------|-----------|---------|
| S1 | TC-1-01 | ✅ |
| S2 | TC-2-01/02/03 | ✅ |
| S3 | TC-3-01/02/03 | ✅ |
| S4 | TC-4-01/02 | ✅ |
| **S5 (Scanner Base)** | **无** | ❌ 缺失 |
| S6 (Type Safety) | TC-5-01/02 | ❌ 编号偏移 |
| S6 (Dead Code) | TC-6-01/02 | ❌ 编号偏移 |
| S7 | TC-7-01/02/03 | ✅ |
| S8 | TC-8-01 | ✅ |
| S9 | TC-9-01 | ✅ |
| S10 | TC-10-01 | ✅ |
| S11 | TC-11-01 | ✅ |

根因是 E2E Scenario 5 (Scanner Base) 插入后未调整后续编号，且有两个 Scenario 6。这导致 TC-5 和 TC-6 的语义与对应的 E2E Scenario 编号错位。

**优先级**：LOW（不影响测试行为，维护性问题）

**修复方向**：E2E plan 的 Scenario 6 重编号为 Scenario 6 和 Scenario 7（或 6a/6b），后续顺延。同时 test_cases_template.json 补充 TC-5-03 并考虑重新对齐编号。

---

## 5. 最终完整性复核

### 5.1 FR ↔ Plan Task 覆盖矩阵

| FR | Plan Task | 覆盖 | 验证 |
|----|-----------|------|------|
| FR-1 Service Layer | T7 + T8 | ✅ | interfaces.ts + 3个 Service + server.ts 路由化 |
| FR-2 Type Safety | T3 + T6 | ✅ | types.ts 重命名 + event-adapter 绑定 PiEvent 联合类型 |
| FR-3 DI Interfaces | T7 + T8 | ✅ | 7个接口 + 构造函数注入 |
| FR-4 Dead Code | T1 + T9 | ✅ | Runtime 4 处 + 前端 3 个 composable |
| FR-5 Message Converter | T2 | ✅ | convertPiHistory 提取到独立模块 |
| FR-6 Config Store Split | T4 | ✅ | config-store.ts → config-store + skill-store + agent-store |
| FR-7 Scanner Base | T5 | ✅ | expandHome/inferSourceType 提取到 scanner-base.ts |
| FR-8 Notification Factory | T9 | ✅ | createSystemNotification 工厂函数 |
| FR-9 refCount | T10 | ✅ | useSession/useProvider 模块级 refCount |

**全部 9 个 FR 都有对应 Task。无遗漏。**

### 5.2 AC ↔ E2E 覆盖矩阵

| AC | E2E Scenario | TC ID | 覆盖 |
|----|-------------|-------|------|
| AC-1 Service Layer | S2, S3, S4, S7 | TC-2-XX, TC-3-XX, TC-4-XX, TC-7-XX | ✅ |
| AC-2 Type Safety | S6 (Type Safety) | TC-5-01/02 | ✅ |
| AC-3 DI | S7 | TC-7-01/02/03 | ✅ |
| AC-4 Dead Code | S6 (Dead Code) | TC-6-01/02 | ✅ |
| AC-5 Message Converter | S8 | TC-8-01 | ✅ |
| AC-6 Config Store | S3 | TC-3-01/02/03 | ✅ |
| AC-7 Scanner Base | S5 | **缺失** | ⚠️ E2E plan 覆盖，test_cases_template 缺失 |
| AC-8 Notification | S9 | TC-9-01 | ✅ |
| AC-9 refCount | S10 | TC-10-01 | ✅ |
| AC-General | S1, S11 | TC-1-01, TC-11-01 | ✅ |

**AC-7 是唯一有 gap 的项。** E2E plan 有 Scenario 5 覆盖，但 `test_cases_template.json` 缺对应 TC。标 LOW 不阻塞。

### 5.3 执行组依赖关系最终检查

```
BG1 ──→ BG2 ──→ BG3
  │
  └──→ FG1 (独立，可并行)
```

**依赖图正确**。BG1（死代码清理）是 BG2（store/adapter/type 重构）的前置条件，BG2 是 BG3（Service 提取）的前置条件。FG1 完全独立于 Runtime 工作。

**Wave 编排**（保守方案，正确）：
| Wave | Groups |
|------|--------|
| Wave 1 | BG1 |
| Wave 2 | BG2, FG1 |
| Wave 3 | BG3 |

Issue #5（FG1 可提前到 Wave 1）仍是有效性优化建议。

---

## 6. 汇总：所有问题列表

| # | 严重性 | 位置 | 描述 | 状态 | 提出轮次 |
|---|--------|------|------|------|---------|
| 1 | ~~MUST FIX~~ | plan.md:BG3/Task8 | AC-3 构造函数签名不一致 | **resolved v2** | 1 |
| 2 | ~~MUST FIX~~ | e2e-test-plan.md:S2 | 缺少 compact/clear/restore/history | **resolved v2** | 1 |
| 3 | ~~MUST FIX~~ | e2e-test-plan.md | 缺少 AC-7 测试场景 | **resolved v2** | 1 |
| **4** | **LOW** | plan.md:Execution | Groups 文件数超 5 上限 | **open** | 1 |
| **5** | **LOW** | plan.md:Wave | FG1 可提前到 Wave 1 | **open** | 1 |
| **6** | **LOW** | plan.md:BG2 | Task 4/5 依赖过度 | **open** | 1 |
| 7 | ~~LOW~~ | spec.md:AC-1 | handler 计数 28≠27 | **resolved v2** | 1 |
| 8 | ~~LOW~~ | spec.md:AC-5 | 引用已删除 session-pool.ts | **resolved v2** | 1 |
| **9** | **INFO** | plan.md:BG3/Task8 | adapterFactory 设计优于 spec | **open** | 1 |
| **10** | **INFO** | plan.md:BG3/Task7 | IConfigService 惰性类型引用 | **open** | 1 |
| **11** | **LOW** | e2e-test-plan.md:S6 | 两个 Scenario 6 编号重复 | **open** | 2 |
| **12** | **LOW** | test_cases_template.json | 缺少 AC-7 (Scanner Base) 测试用例 | **open** | 3 |
| **13** | **LOW** | test_cases_template.json | TC 编号与 E2E Scenario 不对应 | **open** | 3 |

**汇总**：0 MUST FIX / 7 LOW / 2 INFO（总计 13 个问题，3+3 resolved）

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 4 | LOW | plan.md:BG2/BG3/FG1 | 文件数超 5 建议上限 | 执行时视 subagent 上下文压力决定是否拆分 |
| 5 | LOW | plan.md:Wave Schedule | FG1 可提前到 Wave 1 与 BG1 并行 | 若 Wave 1 执行时间受限于 BG1 的纯删除任务，可调度 FG1 并行 |
| 6 | LOW | plan.md:BG2 | Task 4/5 对 Task 3 依赖过度 | Task 4 (config-store split) 和 Task 5 (scanner-base) 可不等待 Task 3 完成 |
| 11 | LOW | e2e-test-plan.md | Scenario 6 编号重复 | 将 Dead Code 重编号为 Scenario 7，后续顺延 |
| 12 | LOW | test_cases_template.json | 缺少 AC-7 (Scanner Base) TC | 新增 TC-5-03 或重新编号映射 |
| 13 | LOW | test_cases_template.json | TC 编号与 E2E Scenario 不对应 | 修复根因（Scenario 6 重编号 + 补齐缺失 TC） |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 7. 最终结论

**通过。**

v1 的 3 条 MUST FIX 已在 v2 全部修复（AC-3 对齐、E2E 补齐 4 个 session 操作、新增 Scanner Base 场景）。v3 未发现新的 MUST FIX 问题。

本轮新增 2 条 LOW：
- **Issue #12**: `test_cases_template.json` 缺少 AC-7 (Scanner Base) 对应的测试用例（E2E plan 已覆盖但在模板 JSON 中未体现）
- **Issue #13**: TC 编号与 E2E Scenario 编号不一致（根因是 Scenario 5 插入后未重编号）

两条均不阻塞执行，因 E2E test plan（权威规格文档）已完整覆盖所有 AC。`test_cases_template.json` 的 gap 是维护性问题而非功能风险。

**已达到循环上限（≤ 3 轮）**。7 条 open LOW 和 2 条 open INFO 可考虑在执行阶段的 gate check 前或之后修复，但不影响 plan 进入执行阶段。

### Summary

计划评审完成，第3轮通过，0条MUST FIX，7条LOW/2条INFO（建议性改进，不阻塞执行）。
