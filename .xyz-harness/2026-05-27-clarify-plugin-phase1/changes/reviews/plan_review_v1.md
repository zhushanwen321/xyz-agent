---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-27T22:30:00"
  target: ".xyz-harness/2026-05-27-clarify-plugin-phase1/plan.md"
  verdict: pass
  summary: "计划评审完成，第1轮通过，0条MUST FIX，5条LOW建议优化"

statistics:
  total_issues: 5
  must_fix: 0
  must_fix_resolved: 0
  low: 5
  info: 0

issues:
  - id: 1
    severity: LOW
    location: "plan.md:BG4 File Structure"
    title: "BG4 文件数标注为 4 但实际列出 5 个文件（2 create + 3 modify）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "interface_chain.json:data_flows"
    title: "data_flows df-activate chain 引用 'Worker.activate(context)'，不是 methods[] 表中的方法名"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan-backend.md:FR-6 PluginStorage"
    title: "PluginStorage.init() 签名在 plan-backend (baseDir, projectRoot) 和 interface_chain.json (baseDir) 之间不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Interface Contracts > PluginActivator"
    title: "activatePlugin 签名在 Interface Contracts 中接受 host+rpc 参数，但 PluginActivator 构造函数已注入这两个依赖"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Spec Coverage Matrix"
    title: "Coverage Matrix 缺少 UC-4/UC-5 的覆盖映射行"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-27 22:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-27-clarify-plugin-phase1/plan.md` 及关联文档（spec.md, plan-backend.md, plan-frontend.md, plan-api-contract.md, interface_chain.json, test_cases_template.json, e2e-test-plan.md, use-cases.md, non-functional-design.md）

---

## 1. Spec 完整性

### 目标明确性 ✅
spec.md 开头一段话清晰说明：**搭建 Plugin 系统骨架，让插件能被发现、加载、激活、停用，实现 Worker Thread 隔离 + JSON-RPC 通信 + 最小 agentAPI。** 目标明确，无歧义。

### 范围合理性 ✅
Scope Boundaries 清晰：Phase 1 做完的 9 个 FR（Registry/Host/RPC/Activator/Storage/类型/Server/测试）和 Out of Scope（完整 agentAPI、权限沙箱、安装卸载、前端 UI 等）有明确边界。范围不过大不过小。

### 验收标准可量化 ✅
6 条 AC（AC-1 ~ AC-6）均可写测试验证：
- AC-1: `config.plugins` 消息包含插件列表 → 测试 scan + broadcast
- AC-2: Worker crash 不影响 Sidecar → 测试崩溃隔离
- AC-3: RPC 超时返回错误码 → 测试 timeout 路径
- AC-4: 懒激活 → 测试 onSlashCommand 延迟加载
- AC-5: 存储持久化 → 测试 set + restart + get
- AC-6: 现有测试通过 → 回归验证

### 待决议项 ⚠️
无 `[待决议]` 标记。5 条 Decision 全部有结论和理由。

---

## 2. Plan 可行性

### 任务拆分合理性 ✅
8 个 Task 按"类型→核心模块→运行时→集成→测试"分层，粒度适中：
- Task 1（类型）：纯定义，1 subagent 可独立完成
- Task 2-4（Registry/Storage/RPC）：彼此无依赖，可并行
- Task 5-6（Host/Activator/Bootstrap）：依赖 Task 4 的 RPC
- Task 7（PluginService + Server 集成）：依赖全部前置模块
- Task 8（测试）：依赖集成完成

每个 Task 文件数 ≤ 5，修改行数可控，1 个 subagent 可独立完成。

### 依赖关系正确性 ✅
- BG1（类型）无依赖 → Wave 1
- BG2（Registry+Storage+RPC）依赖 BG1 → Wave 2
- BG3（Host+Activator+Bootstrap）依赖 BG1+BG2 → Wave 3
- BG4（PluginService+Server）依赖 BG1-3 → Wave 4
- BG5（测试）依赖 BG4 → Wave 5

依赖链 `BG1 → BG2 → BG3 → BG4 → BG5` 严格线性，无循环依赖。

### 工作量估算合理性 ✅
5 个 Wave 串行执行，每个 Wave 内 1-3 个 Task 并行/串行。总文件数 22 个（15 create + 2 modify + 5 test files + 2 fixture）。对照 Sidecar 现有代码规模（4 个 service 文件 + 测试），工作量合理。

### 遗漏 Task 检查 ✅
对照 spec 9 个 FR 逐条覆盖：
- FR-1 PluginService → Task 7
- FR-2 PluginRegistry → Task 2
- FR-3 PluginHost → Task 5
- FR-4 PluginRPC → Task 4
- FR-5 PluginActivator + Bootstrap → Task 6
- FR-6 PluginStorage → Task 3
- FR-7 类型定义 → Task 1
- FR-8 Server 集成 → Task 7
- FR-9 集成测试 → Task 8

无遗漏。plan 中也无 spec 未提及的额外工作（plan-frontend.md 明确 Phase 1 无新增 UI，仅 protocol.ts 类型变更）。

---

## 3. Spec 与 Plan 一致性

### Plan 覆盖 Spec 所有需求 ✅
逐条对照 spec FR-1 ~ FR-9，每个 FR 都有对应 Task。Spec Coverage Matrix 明确列出了 FR → Task 的映射关系。

### Plan 无 Spec 未提及的额外工作 ✅
plan-frontend.md 明确说明 Phase 1 无前端 UI 变更。plan.md 的 Task 1-8 全部落在 spec Scope Boundaries 范围内。

### 验收标准与 Task 对应 ✅
Spec Metrics Traceability 表覆盖了全部 AC 和 FR 的 adopted 状态和对应 Task。

---

## 4. Execution Groups 合理性

### 分组合理性 ✅
5 个 BG 组，每组文件数 ≤ 10，每组 Task 数 ≤ 4，符合约束。

### 类型划分 ✅
BG1-BG5 全部为后端 Task，无前端混合（Phase 1 无前端 UI Task）。

### 功能关联度 ✅
同组 Task 关联紧密：BG2 的三个 Task（Registry/Storage/RPC）虽然无相互依赖，但都属于"核心模块"层，共享类型基础，合并为一个 Group 并行开发合理。

### 依赖关系 ✅
Wave 编排正确：Wave 1→2→3→4→5 严格线性。同 Wave 内无并行 Group（每个 Wave 只有 1 个 Group），无文件冲突。

### Subagent 配置完整性 ✅
每组包含 Agent、taskComplexity、注入上下文、读取文件、修改/创建文件。

### 上下文充分性 ✅
注入上下文引用了具体的 spec FR 章节、设计文档 Part/Section、以及需要读取的现有文件路径。subagent 可独立完成。

### 文件数预估 ✅
各 Group 标注的文件数与 File Structure 表一致（除 BG4 标注为 4 但实际 5 个文件，见 Issue #1）。

---

## 5. 接口契约审查

### plan.md ↔ interface_chain.json 一致性

大部分方法名、参数、返回值在两处一致。发现以下不一致：

- `PluginStorage.init()` 签名：interface_chain.json 只列 `baseDir: string`，plan-backend.md 实现为 `init(baseDir: string, projectRoot: string)`（Issue #3）
- `PluginActivator.activatePlugin()` 签名：interface_chain.json 列了 `host: PluginHost, rpc: PluginRpcServer` 参数，但 plan-backend.md 中 PluginActivator 构造函数已通过 DI 注入这两个依赖，不需要在方法参数中重复传递（Issue #4）

### data_flows cross-reference

7 条 data_flow，大部分 chain 中的方法名存在于 methods[] 表。但：
- `df-activate` chain 引用 `Worker.activate(context)`，这不是 methods[] 表中的方法名（它是在 Worker Thread 内部执行的，不是 PluginHost/PluginActivator 的公开方法）。严格来说这是跨进程调用，不在同一 methods 表中可理解，但标注不够精确（Issue #2）。

### AC 覆盖矩阵完整性 ✅
Spec Coverage Matrix 覆盖了 AC-1 ~ AC-6 和 UC-1 ~ UC-3。但 UC-4（插件使用 KV 存储）、UC-5（插件发送通知）没有对应的映射行（Issue #5）。这两个 UC 的场景已被 Task 3（Storage）和 Task 6（Activator + agentAPI notify）覆盖，但 Coverage Matrix 未显式列出。

### 类型传递一致性 ✅
data_flows chain 中相邻方法的输出/输入类型兼容。例如 `PluginStorage.set()` 接受 `unknown`，RPC handler 透传 `params.value`（类型 `unknown`），类型一致。

---

## 6. 后端设计充分性

### 设计深度 ✅
plan-backend.md 对每个 FR 提供了类结构、方法签名、流程图（伪代码级别）、错误处理策略。不只有"做什么"，还说明了"为什么"（如 DI 注入拓扑的理由、Worker 分组策略的理由）。

### 存储变更选型理由 ✅
PluginStorage 选择 JSON 文件而非 SQLite/LevelDB：Phase 1 不新增 npm 依赖的约束下，JSON 文件是唯一选择。plan-backend.md 详细说明了写入策略（500ms debounce + temp + rename 原子操作）和大小限制（单值 1MB / 总量 10MB）。

### API 端点设计与业务场景对应 ✅
plan-api-contract.md 完整定义了 RPC 方法注册表、前后端 WS 消息定义、消息序列图。每个方法都有触发场景、参数、返回值、错误码。

### 边界条件和异常处理 ✅
plan-backend.md §错误处理策略定义了 4 层错误模型（Plugin Crash → Activation Error → RPC Error → Storage Error），每层有明确的触发条件、影响范围、恢复策略。plan-api-contract.md §5 详细列出 16 个错误码及其触发场景和传播路径。

### 非功能性要求对应 ✅
non-functional-design.md 覆盖了稳定性、数据一致性、性能、业务安全、数据安全 5 个维度，每个维度都有对应的 Task 实现。

---

## 7. plan-frontend.md 合理性

### Phase 1 无前端 UI 的结论 ✅
plan-frontend.md 论证了 Phase 1 无需新增 Vue/Store/Composable 代码，仅 `protocol.ts` 新增类型定义。与 spec Scope Boundaries 一致。前端对接时机清晰说明了 Phase 2 需要做什么。

### protocol.ts 变更完整性 ✅
plan-frontend.md 和 plan-api-contract.md §4.3 列出了所有需要新增到 protocol.ts 的类型变更，包括 ClientMessageType、ClientMessageMap、ServerMessageType 新增成员和 Payload Interface。

---

## 8. 测试计划合理性

### E2E 测试覆盖 ✅
e2e-test-plan.md 定义了 6 个测试场景（TS-1 ~ TS-6），覆盖全部 6 条 AC。test_cases_template.json 提供了 16 个具体 TC（TC-1-01 ~ TC-6-01），每个 TC 有明确的步骤和断言。

### 测试工具选择 ✅
使用 Node.js 内置 test runner（`node:test` + `node:assert`），与现有测试框架一致。Mock 依赖（MockBroker、MockWorkspaceContext）设计合理。

### 回归测试 ✅
TS-6 明确要求运行所有现有 extension 测试（4 个测试文件），确保 Phase 1 变更不影响现有功能。

---

## 9. 架构合规性

### Service 模式一致性 ✅
PluginService 遵循现有 Service 模式：constructor DI + interface 注入（`IPluginService` 在 `interfaces.ts` 中定义），`setServices()` 注入到 `SidecarServer`。

### 数据目录隔离 ✅
Plugin 数据目录 `~/.xyz-agent/plugins/` 与 pi 数据目录 `~/.pi/agent/` 完全隔离，符合 CLAUDE.md §10 的要求。

### 消息路由隔离 ✅
Server 集成中新增的 `plugin.list` / `plugin.toggle` 消息路由与现有 extension 消息路由完全独立，不会互相干扰。

### TypeScript strict + 禁止 any ✅
plan 和 plan-backend.md 多处强调 strict mode + 禁止 any，类型定义中无 any 使用。

### 不新增 npm 依赖 ✅
Worker Thread 和 MessagePort 是 Node.js 内置能力。spec Constraints 明确"不新增 npm 依赖"。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | plan.md:BG4 Files | BG4 描述"Files (预估): 4 个文件（2 create + 3 modify）"，2+3=5 不是 4 | 将预估文件数改为 5（2 create + 3 modify） |
| 2 | LOW | interface_chain.json:data_flows.df-activate | chain 中 `Worker.activate(context)` 不是 methods[] 表中的方法名，是 Worker Thread 内部调用，严格来说不在 interface_chain 的 methods 范围内 | 将 chain 中的 `Worker.activate(context)` 改为 `plugin-bootstrap.handleActivate → module.activate(context)`，更精确反映跨进程调用 |
| 3 | LOW | plan-backend.md:FR-6 vs interface_chain.json:PluginStorage.init | plan-backend.md 中 PluginStorage.init() 签名为 `(baseDir: string, projectRoot: string)`，但 interface_chain.json 中 init 只有 `(baseDir: string)` 一个参数 | 统一为 plan-backend.md 的两参数版本（baseDir + projectRoot），更新 interface_chain.json |
| 4 | LOW | plan.md:Interface Contracts > PluginActivator.activatePlugin | activatePlugin 签名列了 `(pluginId, event, host, rpc)` 4 个参数，但 plan-backend.md 中 PluginActivator 构造函数已注入 host 和 rpc，方法只需 `(pluginId, event)` | Interface Contracts 中 activatePlugin 签名改为 `(pluginId: string, event: ActivationEvent)`，与 plan-backend.md 一致 |
| 5 | LOW | plan.md:Spec Coverage Matrix | Coverage Matrix 有 UC-1/2/3 的映射行，但缺少 UC-4（KV 存储）和 UC-5（通知）的映射 | 补充 UC-4 → Task 3 (Storage) + Task 4 (RPC), UC-5 → Task 6 (Activator agentAPI notify) 的映射行 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

#### 等级判定说明

以上 5 条 LOW 均为文档一致性问题，不影响代码实现的正确性。subagent 在执行时主要参照 plan-backend.md 的详细设计，Interface Contracts 的签名差异不会导致功能失效。Coverage Matrix 缺少 UC-4/UC-5 行不影响测试覆盖——e2e-test-plan.md 和 test_cases_template.json 已完整覆盖了这两个 UC 的场景。

---

## 结论

通过

### Summary

计划评审完成，第1轮通过，0条MUST FIX，5条LOW（均为文档一致性问题），建议修复但不阻塞。
