---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-22T15:00:00"
  target: ".xyz-harness/2026-05-21-/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，3条MUST FIX（AC-3构造函数不一致 + E2E缺2组场景），需修改后重审"

statistics:
  total_issues: 10
  must_fix: 3
  must_fix_resolved: 0
  low: 5
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:BG3/Task8 → SessionService constructor"
    title: "AC-3 要求 SessionService 构造函数接受 IRpcClient 和 IEventAdapter，但 plan 使用 IProcessManager 和 adapterFactory"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "e2e-test-plan.md:Scenario 2"
    title: "E2E 缺少 session compact/clear/restore/history 操作的测试场景"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "e2e-test-plan.md:全文"
    title: "E2E 缺少 AC-7 (Scanner Base) 测试场景"
    status: open
    raised_in_round: 1
    resolved_in_round: null

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
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "spec.md:AC-5"
    title: "AC-5 引用 session-pool.ts import convertPiHistory，但 session-pool.ts 在 BG3 被整体删除"
    status: open
    raised_in_round: 1
    resolved_in_round: null

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
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-22 15:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-21-/plan.md` + `e2e-test-plan.md`（对照 `spec.md`）

---

## 1. Spec 完整性

### 1.1 目标明确性

**通过。** Spec 开头一段话清晰说明了要做什么：从 Runtime 的两个上帝类（server.ts 574L + session-pool.ts 600L）提取 Service 层，绑定类型，引入 DI，清理死代码，前端快速修复。

### 1.2 范围合理性

**通过。** 范围有明确边界 — 9 个 FR 覆盖 Runtime 核心重构 + 前端快速修复。Out of Scope 列出 8 个推迟项（EventRouter 深化、App.vue 拆分等），每个都有推迟理由（依赖 Service Layer 先稳定）。范围不过大不过小。

### 1.3 验收标准可量化

**基本通过，有小问题。** 大部分 AC 可量化（文件存在、行数上限、grep 无匹配、build 通过）。一个问题：AC-9 的 "split mode 下事件 handler 不重复注册" 需要手动功能验证，没有自动化断言。但这在纯重构项目中的 E2E 层面是合理的。

**小问题**：AC-1 提到 "所有 28 个消息 handler case"，但列出的分类汇总为 9+2+10+2+3+1 = 27。计数有误（见 issue #7）。

### 1.4 待决议项

**通过。** 无 `[待决议]` 标记。7 个 Decisions Made 表格均有 rationale。

---

## 2. Plan 可行性

### 2.1 任务拆分

**基本合理。** 10 个 Task 覆盖 9 个 FR，粒度适中。Task 8 是最大的任务（提取 3 个 Service + 重写 server.ts + 删除 session-pool + 更新 index.ts），但 plan 使用 `taskComplexity: high` 并给出了详细的设计步骤（6 个 Step），可由单个 subagent 执行。

**问题**：多个 Group 的单次 subagent 执行文件数超过 5 个建议上限（见 issue #4）。具体：
- BG2: 8 个文件（1 subagent 处理 Task 3-6）
- BG3 Task 8: 6 个文件
- FG1 Task 9: 9 个文件

这不阻塞执行，但增加 subagent 上下文压力和出错风险。如果 BG2/FG1 进一步拆分为多个 subagent 任务，可降低风险。

### 2.2 依赖关系

**基本正确。** 核心链路 BG1 → BG2 → BG3 正确（session-pool 先清理死代码、提取纯函数 → store/adapter 重构 → Service 提取）。FG1 独立于 Runtime，依赖图正确。

**问题**：
1. FG1 可在 Wave 1 开始（见 issue #5）— 当前调度在 Wave 2 是保守但非最优的。
2. Task 4（config-store split）和 Task 5（scanner-base）对 Task 3（rename pi-rpc-types → types.ts）的依赖是过度的 — 这两个任务不涉及 types.ts（见 issue #6）。

### 2.3 工作量估算

**通过。** Spec 估算 3-4 天（1 天清理 + 2 天核心重构 + 0.5 天前端 + 0.5 天集成）。对照任务量和复杂度（1174L 代码重组 + 前端机械修改），估算合理。

### 2.4 遗漏检查

对照 spec 逐条 FR 检查 plan 覆盖：

| FR | Plan Task | 覆盖 |
|----|-----------|------|
| FR-1 Service Layer | Task 7 + Task 8 | ✅ |
| FR-2 Type Safety | Task 3 + Task 6 | ✅ |
| FR-3 DI Interfaces | Task 7 | ✅ |
| FR-4 Dead Code | Task 1 (Runtime) + Task 9 (Frontend) | ✅ |
| FR-5 Message Converter | Task 2 | ✅ |
| FR-6 Config Store Split | Task 4 | ✅ |
| FR-7 Scanner Base | Task 5 | ✅ |
| FR-8 Notification Factory | Task 9 | ✅ |
| FR-9 refCount | Task 10 | ✅ |

**所有 FR 都有对应 Task。无遗漏。**

---

## 3. Spec 与 Plan 一致性

### 3.1 需求覆盖率

逐条 AC 检查 plan 是否覆盖：

| AC | Plan 覆盖 | 一致性 |
|----|-----------|--------|
| AC-1 (Service Layer) | Task 7+8 | ✅ |
| AC-2 (Type Safety) | Task 3+6 | ✅ |
| AC-3 (DI) | Task 7+8 | **⚠️ 见 issue #1** |
| AC-4 (Dead Code) | Task 1+9 | ✅ |
| AC-5 (Message Converter) | Task 2 | **⚠️ 见 issue #8** |
| AC-6 (Config Store Split) | Task 4 | ✅ |
| AC-7 (Scanner Base) | Task 5 | ✅ |
| AC-8 (Notification Factory) | Task 9 | ✅ |
| AC-9 (refCount) | Task 10 | ✅ |
| AC-General (Non-regression) | 各 Task 验证步骤 + E2E | ✅ |

### 3.2 关键不一致

**Issue #1 (MUST FIX): AC-3 vs Plan SessionService 构造函数**

Spec AC-3 明确要求：
> `SessionService` 构造函数接受 `IRpcClient`、`IProcessManager`、`IMessageBroker`、`IEventAdapter` 参数

Plan 中 SessionService 的构造函数为：
```typescript
constructor(
  private pm: IProcessManager,
  private broker: IMessageBroker,
  private adapterFactory: (sessionId: string) => IEventAdapter,
) {}
```

差异：
1. **缺少 IRpcClient 直接注入** — Plan 通过 IProcessManager 间接获取 IRpcClient 实例（`pm.getClient(sid)`），这是合理的架构决策（ProcessManager 管理 client 生命周期），但与 AC-3 矛盾。
2. **adapterFactory 替代 IEventAdapter** — Plan 使用工厂函数为每个 session 创建独立 adapter 实例，比 spec 的单例注入更合理（见 issue #9），但同样与 AC-3 矛盾。

**修复方向**：二选一 —
- (a) 更新 spec AC-3 使其与 plan 一致（推荐，plan 的设计更合理）
- (b) 更新 plan SessionService 构造函数以直接注入 IRpcClient 和 IEventAdapter（不推荐，会引入不必要的复杂性）

**Issue #8 (LOW): AC-5 引用 session-pool.ts**

AC-5 第三条："`session-pool.ts` import `convertPiHistory` 而非内联实现"。BG3 整体删除 session-pool.ts 后，此 AC 变为无意义。Plan 在 Task 2（BG1）中确实让 session-pool 导入 convertPiHistory，满足临时状态，但最终状态不满足。

**修复方向**：更新 AC-5 将 "session-pool.ts import" 改为 "SessionService 通过 message-converter.ts 使用 convertPiHistory"。

### 3.3 Plan 中 spec 未提及的额外工作

无。Plan 严格限定在 spec 9 个 FR 范围内，无额外功能。

---

## 4. Execution Groups 合理性

### 4.1 分组合理性

| Group | Task 数 | 文件数 | 评估 |
|-------|---------|--------|------|
| BG1 | 2 | 5 | ✅ 合理 |
| BG2 | 4 | 8 | ⚠️ 文件数偏高但功能关联紧密 |
| BG3 | 2 | 8 | ⚠️ 文件数偏高但 Task 7 仅 1 文件，Task 8 是核心 |
| FG1 | 2 | 9 | ⚠️ 文件数偏高但 Task 9/10 可并行 |

**Issue #4**: BG2（8 文件）、BG3 Task 8（6 文件）、FG1 Task 9（9 文件）均超过 5 文件建议上限。由于变更多为机械性（函数搬家、import 更新、工厂替换），实际风险可控。但如果要严格遵守规范，建议：
- BG2 拆为 BG2a（Task 3+4, 5 文件）和 BG2b（Task 5+6, 5 文件）
- FG1 Task 9 拆为 Task 9a（创建工厂 + 删除死 composable, 4 文件）和 Task 9b（更新调用方, 5 文件）

### 4.2 前后端分离

**通过。** BG1/BG2/BG3 纯后端 Runtime，FG1 纯前端。无混合类型 Group。

### 4.3 功能关联度

**通过。**
- BG1（死代码清理 + 纯函数提取）：关联紧密，减小 session-pool.ts 体积
- BG2（store/adapter/type 重构）：都是 store 层和 adapter 层的变更，不触及 server.ts
- BG3（Service 提取）：核心重构，逻辑集中
- FG1（前端快速修复）：通知工厂 + refCount，独立于 Runtime

### 4.4 Wave 编排

**基本合理，有优化空间。**

当前：
- Wave 1: BG1
- Wave 2: BG2 + FG1
- Wave 3: BG3

**Issue #5**: FG1 完全独立于 Runtime（无文件冲突、无数据竞争、无 API 依赖变更），可以提前到 Wave 1 与 BG1 并行。这能节省约 0.5 天（前端修复不需要等 Runtime 清理完成）。

### 4.5 Subagent 配置完整性

**通过。** 每个 Group 都有完整的 Agent/Model/注入上下文/读取文件/修改文件配置。

### 4.6 上下文充分性

**通过。** 注入上下文包含具体 Task 描述 + 对应 FR + 编码规范引用。设计细节部分给出了代码示例和方法级指导（如 "删除 L268-280 approveTool()"），足够 subagent 独立完成。

### 4.7 代码示例精确性

**需要执行时验证。** Plan 中的代码示例（方法名、import 路径、行号）基于编写时的源码状态，实际执行时可能因前面的 Task 修改而偏移。关键点：
- `rpc-client.ts` L268-303 行号是 BG1 前的位置，BG1 执行后可能偏移
- `SkillInfo`/`AgentInfo` 从 `@xyz-agent/shared` import 的路径需要在执行时确认
- `SidecarServer` 类名需要在执行时确认是否为当前 server.ts 的实际类名

Plan 已在多处标注 "执行时需微调"，这是合理的。

### 4.8 Placeholder 扫描

**通过。** 全文无 TBD/TODO/FIXME/填空。

---

## 5. E2E Test Plan 评审

### 5.1 AC 覆盖矩阵

| AC | E2E Scenario | 覆盖状态 |
|----|-------------|---------|
| AC-1 (Service Layer) | S2 (Session), S3 (Config), S4 (Model), S7 (DI) | ✅ |
| AC-2 (Type Safety) | S5 (Type Verification) | ✅ |
| AC-3 (DI) | S7 (DI Structure) | ✅ |
| AC-4 (Dead Code) | S6 (Dead Code Verification) | ✅ |
| AC-5 (Message Converter) | S8 (Message Converter) | ✅ |
| AC-6 (Config Store) | S3 (Config CRUD) | ✅ |
| AC-7 (Scanner Base) | — | **❌ 缺失** |
| AC-8 (Notification) | S9 (System Notification) | ✅ |
| AC-9 (refCount) | S10 (refCount) | ✅ |
| AC-General | S1 (Start/Stop), S11 (Build) | ✅ |

**Issue #2 (MUST FIX): E2E 缺少 session compact/clear/restore/history 场景**

Scenario 2 (Session Lifecycle) 仅覆盖 create/list/switch/rename/delete。缺少 4 个核心操作：
- `session.compact` — 触发 session compaction，是 SessionService 的重要方法
- `session.clear` — 清除 session 历史
- `session.restore` — 从磁盘恢复 session
- `session.getHistory` — 获取 session 历史消息

这些都是 SessionService 从 session-pool.ts 提取的关键逻辑，在重构中最容易出错。E2E plan 需要补充对应的测试步骤。

**修复方向**：在 Scenario 2 中补充 compact/clear/restore/history 测试步骤，或在 Scenario 2 和 Scenario 3 之间新增 Scenario 2b 专门覆盖这些操作。

**Issue #3 (MUST FIX): E2E 缺少 AC-7 测试场景**

Scanner Base 提取（FR-7）没有对应的 E2E 测试场景。应添加：
1. `ls runtime/src/scanner-base.ts` → 文件存在
2. `grep "expandHome\|inferSourceType" runtime/src/scanner-base.ts` → 有匹配
3. `grep "export function expandHome\|export function inferSourceType" runtime/src/skill-scanner.ts runtime/src/agent-scanner.ts` → 无匹配（已提取到 scanner-base）
4. `npx tsc --noEmit` 通过

**修复方向**：新增 Scenario "Scanner Base Verification"，映射到 AC-7。

---

## 6. 后端设计充分性（L1 检查）

本 plan 标注为 L1 复杂度（single plan），后端 task 设计充分性检查：

### 6.1 "为什么" vs "做什么"

**基本通过。** 每个 Task 的设计细节解释了变更的原因（如 "假接口，pi 审批走 extension_ui_request/response 协议"）。Service 提取的设计细节说明了为什么这样拆分（SessionService 管理 session 生命周期，ConfigService 是 facade 编排 store 调用，ModelService 聚合模型）。

### 6.2 存储变更选型理由

**不适用。** 本次无存储变更。

### 6.3 API 端点设计

**不适用。** WS 协议不变，无新端点。

### 6.4 边界条件和异常处理

**部分覆盖。** Plan 在 Task 8 Step 4 中保留了 server.ts 的 sendError 处理，但没有详细说明 Service 方法中的错误传播路径。建议在 Task 8 的设计细节中补充：Service 方法抛出异常时，server.ts 的路由层如何 catch 并广播错误。

当前的设计暗示 Service 方法会抛出异常、server.ts 的路由层 catch 并调用 `sendError()`，但 plan 没有明确写出这个模式。这不是 MUST FIX（执行时自然会处理），但是 LOW 级别的文档完善建议。

### 6.5 非功能性要求

**通过。** Spec 明确约束了 Performance 方面：不引入异步 I/O，保持同步模式。Plan 遵守了这一约束。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:BG3/Task8 → SessionService constructor | AC-3 要求 SessionService 构造函数接受 IRpcClient 和 IEventAdapter，但 plan 使用 IProcessManager（间接获取 client）和 adapterFactory（工厂模式）。构造函数签名与 AC-3 矛盾 | 更新 spec AC-3 使其与 plan 一致（推荐），或调整 plan 构造函数 |
| 2 | MUST FIX | e2e-test-plan.md:Scenario 2 | Session Lifecycle 场景缺少 compact/clear/restore/history 四个核心操作测试。这些是 SessionService 从 session-pool 提取的关键逻辑，最易出错 | 补充测试步骤或在 S2 后新增 Scenario 2b |
| 3 | MUST FIX | e2e-test-plan.md:全文 | 缺少 AC-7 (Scanner Base) 测试场景。scanner-base.ts 提取无任何验证 | 新增 Scenario: Scanner Base Verification |
| 4 | LOW | plan.md:BG2/BG3/FG1 | BG2(8文件)、BG3 Task8(6文件)、FG1 Task9(9文件) 超过 5 文件建议上限 | 考虑拆分为更小的 subagent 任务 |
| 5 | LOW | plan.md:Wave Schedule | FG1 独立于 Runtime，可从 Wave 2 提前到 Wave 1 并行 | 调整 Wave 编排，FG1 与 BG1 并行 |
| 6 | LOW | plan.md:BG2 Execution Flow | Task 4 (config-store split) 和 Task 5 (scanner-base) 不涉及 types.ts，对 Task 3 的依赖过度 | Task 4/5 可与 Task 3 并行 |
| 7 | LOW | spec.md:AC-1 | AC-1 提到 "28 个消息 handler"，但列出的分类 9+2+10+2+3+1=27 | 修正计数或补充遗漏的分类 |
| 8 | LOW | spec.md:AC-5 | AC-5 第三条要求 session-pool.ts 导入 convertPiHistory，但 BG3 会删除 session-pool.ts | 更新 AC-5 为 "SessionService 通过 message-converter.ts 使用 convertPiHistory" |
| 9 | INFO | plan.md:BG3/Task8 | adapterFactory 模式（为每个 session 创建独立 adapter）比 spec 的单例 IEventAdapter 注入更合理 — 符合每个 pi 进程对应一个 EventAdapter 的实际需求 | — |
| 10 | INFO | plan.md:BG3/Task7 | IConfigService 使用 `ReturnType<import('./provider-store.js').listProviders>` 惰性类型引用，执行时需验证编译兼容性 | — |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

需修改后重审。

Plan 的整体架构清晰、任务拆分合理、依赖关系基本正确。核心问题是 **3 条 MUST FIX**：

1. **AC-3 与 Plan 的 SessionService 构造函数不一致** — 需要对齐 spec 和 plan（推荐更新 spec，plan 的设计更合理）
2. **E2E 缺少 session compact/clear/restore/history 测试** — 这些是从 session-pool 提取到 SessionService 的关键逻辑，最易在重构中出错
3. **E2E 缺少 AC-7 Scanner Base 测试** — scanner-base.ts 提取无验证场景

修复这 3 条后，plan 可以进入执行阶段。

### Summary

计划评审完成，第1轮，3条MUST FIX（AC-3构造函数不一致 + E2E缺2组场景），需修改后重审。
