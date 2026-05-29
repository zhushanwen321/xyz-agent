---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-29T10:00:00"
  target: ".xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮需重审，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md — Task 2 Step 1（ToolRegistration 类型变更）"
    title: "ToolRegistration.execute 应为可选字段，与主线程 ToolEntry.schema 类型不兼容"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plan.md — Task 2 Step 2（handleMessage 导出缺失）"
    title: "handleMessage 当前未 export，测试代码无法 import"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan.md — Task 3 Step 1（elif 分支缺少 chmod）"
    title: "Windows zip 分支缺少 chmod +x，与其他分支行为不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan.md — Task 4 Step 1（normalizePath 参数名假设）"
    title: "mockImplementation 参数名可能不是 path，需确认实际回调签名"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "plan.md — Interface Contracts / postRpcResponse 实现"
    title: "postRpcResponse 动态构建 RpcResponse 对象可能不符合 union type 安全性"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-29 10:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/plan.md`
- 参考文档：`spec.md`, `plan.md`, `e2e-test-plan.md`, `use-cases.md`, `non-functional-design.md`, CLAUDE.md, 实际代码文件（plugin-types.ts, plugin-bootstrap.ts, tool-api.ts）

---

## 1. Spec 完整性

| 维度 | 评价 | 详情 |
|------|------|------|
| 目标明确性 | ✅ | "完成 Plugin System P0 集成缺口 + CI Windows 构建修复"，一句话说清 |
| 范围合理性 | ✅ | 3 个 FR 边界清晰，明确排除 Phase 4、不修改 PluginHost 核心架构 |
| AC 可量化 | ✅ | 所有 5 个 AC 均可通过测试/CI 日志/视觉验证 |
| 待决议项 | ✅ | 无 `[待决议]` 标记 |
| FR 完整性 | ✅ | 3 个 FR 均已覆盖，无遗漏 |

**结论：spec 完整，无问题。**

---

## 2. Plan 可行性

### 2.1 任务拆分

| Task | 类型 | 文件数 | 粒度评价 |
|------|------|--------|---------|
| Task 1: PluginsPane 接入 | frontend | 4 modify | 适中 — 4 个独立文件的少量改动 |
| Task 2: Worker tool execute handler | backend | 3 modify + 1 create | 适中 — 类型 + handler + API + test |
| Task 3: CI pi 解压修复 | backend | 1 modify | 恰当 — 一个 shell 脚本单项修复 |
| Task 5: 回归验证 | backend | 0 | 恰当 — 验证步骤 |

每个 task 可由一个 subagent 独立完成 ✅

### 2.2 依赖关系

```
FG1 ──┐
BG1 ──┤──→ Task 5 (回归验证)
BG2 ──┘
```

依赖关系正确：三个 Group 完全独立，Wave 1 可全并行，Wave 2 验证 ✅

### 2.3 工作量估算

| Task | 预估改动量 | 评价 |
|------|-----------|------|
| Task 1 | ~12 行 (4 处) | 合理 |
| Task 2 | ~80 行类型 + ~60 行 handler + ~80 行测试 | 合理 |
| Task 3 | ~3 行 | 合理 |
| Task 4 | ~20 处替换 + 1 个 helper | 合理 |

---

## 3. Spec 与 Plan 一致性

### AC 覆盖矩阵

| Spec AC | Plan Task | 覆盖状态 | 备注 |
|---------|-----------|---------|------|
| AC-1: Settings Plugins tab | Task 1 | ✅ | 完整覆盖 |
| AC-2: Worker tool execute handler | Task 2 | ✅ | 完整覆盖 |
| AC-3: CI Windows pi 解压 | Task 3 | ✅ | 完整覆盖 |
| AC-4: CI Windows extension-service 测试 | Task 4 | ✅ | 完整覆盖 |
| AC-5: macOS/Linux CI 不回归 | Task 5 | ✅ | 完整覆盖 |

### FR 覆盖矩阵

| Spec FR | Plan Task | 覆盖状态 |
|---------|-----------|---------|
| FR-1: PluginsPane 接入 SettingsView | Task 1 | ✅ |
| FR-2: Worker 端 tool execute RPC handler | Task 2 | ✅ |
| FR-3: CI Windows 构建修复 | Task 3 + Task 4 | ✅ |

### 额外工作检查

plan 中没有 spec 未提及的额外工作 ✅

### 验收标准可追溯

所有 AC 都能在 plan 中找到对应实现步骤 ✅

---

## 4. Execution Groups 合理性

### 分组概览

| Group | Type | Tasks | Files | Model |
|-------|------|-------|-------|-------|
| FG1 | 前端 | 1 (Task 1) | 4 modify | taskComplexity: low |
| BG1 | 后端 | 1 (Task 2) | 3 modify + 1 create | taskComplexity: medium |
| BG2 | CI 修复 | 2 (Task 3, 4) | 2 modify | taskComplexity: low |

### 逐项检查

**FG1（PluginsPane 接线）**
| 检查项 | 结果 |
|--------|------|
| 类型划分 | ✅ 纯前端 |
| 功能关联度 | ✅ 全是 Settings tab 注册 |
| 文件数 ≤ 10 | ✅ 4 个 |
| Subagent 配置 | ✅ Agent + Model + 注入上下文完整 |
| 依赖关系 | ✅ 无外部依赖 |

**BG1（Worker RPC handler）**
| 检查项 | 结果 |
|--------|------|
| 类型划分 | ✅ 纯后端（Worker Thread 内部逻辑） |
| 功能关联度 | ✅ 所有文件属于 RPC request 处理链路 |
| 文件数 ≤ 10 | ✅ 4 个 |
| Subagent 配置 | ✅ 含 RPC 协议上下文 |
| 依赖关系 | ✅ 无外部依赖 |

**BG2（CI Windows 修复）**
| 检查项 | 结果 |
|--------|------|
| 类型划分 | ✅ 后端（shell 脚本 + 测试） |
| 功能关联度 | ✅ 都是 Windows 兼容性修复，无交叉干扰 |
| 文件数 ≤ 10 | ✅ 2 个 |
| Subagent 配置 | ✅ |
| 依赖关系 | ✅ 两个任务互相独立，同一 agent 串行执行 |

### Wave 编排

| Wave | Groups | 并行性 | 评价 |
|------|--------|--------|------|
| Wave 1 | FG1, BG1, BG2 | ✅ 完全独立 | 可全并行，无文件冲突 |
| Wave 2 | Task 5 | 串行 | 依赖 Wave 1 全部完成 |

---

## 5. 接口契约审查

### Interface Contracts

Plan 文档包含了清晰的 Interface Contracts 章节，涵盖关键函数签名和类型变更。审查基于实际代码文件（plugin-types.ts, plugin-bootstrap.ts, tool-api.ts）。

### AC 覆盖矩阵（plan 版）

| AC | Interface Method | Task | 覆盖状态 |
|----|-----------------|------|---------|
| AC-1 | PluginsPane component | Task 1 | ✅ |
| AC-2 | handleMessage → msg.request → toolHandlers.get | Task 2 | ✅ |
| AC-3 | prepare-pi-resources.sh Windows branch | Task 3 | ✅ |
| AC-4 | extension-service.test.ts normalizePath | Task 4 | ✅ |
| AC-5 | 全量回归 | Task 5 | ✅ |

---

## 发现的问题

### MUST FIX

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | MUST FIX | plan.md Task 2 Step 1 / `ToolRegistration` | `ToolRegistration.execute` 当前在 plan 中声明为 `execute: ToolExecuteHandler`（必填字段）。但 `ToolEntry.schema` 类型就是 `ToolRegistration`（plugin-types.ts:172），主线程在 `registerToolRpcHandlers`（tool-api.ts:57-62）构造的 tool schema 不包含 `execute` 字段——因为 execute 函数不可序列化，通过 RPC 传输时不会发送。如果 execute 是必填字段，tool-api.ts:62 的 `{ name, description, parameters }` 对象字面量会触发 TypeScript 编译错误。**实际代码验证：** tool-api.ts:62 确实使用 `{ name, description, parameters }` 赋值给了 `ToolEntry.schema`。 | 将 `ToolRegistration.execute` 改为可选字段：`execute?: ToolExecuteHandler`。Worker 侧有值时正常使用，主线程侧无值时不报错。同步修改 plan.md 中的接口说明。 |
| 2 | MUST FIX | plan.md Task 2 Step 2 / `handleMessage` 导出 | `handleMessage` 在 `plugin-bootstrap.ts` 中是内部 `async function`（第 41 行），当前未 export。但 plan 的单元测试（Step 4）需要 `import { handleMessage }` 来直接调用。Plan 只要求 export `registerToolHandler`，没有要求 export `handleMessage`。**实际代码验证：** plugin-bootstrap.ts:41 定义为 `async function handleMessage(...)`，无 export 关键字。 | 在 `handleMessage` 前加 `export` 关键字，改为 `export async function handleMessage(...)`。同步更新 plan.md 的 Step 2 描述。 |

### LOW

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 3 | LOW | plan.md Task 3 Step 1 / 脚本 `elif` 分支 | `elif [[ -f "pi.exe" ]]` 分支中只做了 `mv pi.exe "${BINARY_NAME}"`，没有执行 `chmod +x "${BINARY_NAME}"`。`if [[ -d "pi" ]]` 分支中通过 `cp pi/pi "${BINARY_NAME}"` 后跟随原脚本中的 `chmod`。虽然 Windows 上 .exe 文件不需要可执行权限位，Git Bash 可正常执行，但两个分支行为不一致，如果后续 CI 步骤依赖 `chmod` 返回码或在其他环境下使用，可能有隐患。 | 在 `mv pi.exe "${BINARY_NAME}"` 后添加 `chmod +x "${BINARY_NAME}" 2>/dev/null || true`（容错处理），与主分支行为一致。 |
| 4 | LOW | plan.md Task 4 Step 1 / mock 参数名 | Plan 描述「在 mockImplementation 回调的第一行加 `const p = normalizePath(path.toString())`」假设了回调的参数名为 `path`。实际代码中 `mockFs.readFile.mockImplementation((path, ...) => ...)` 确实常以 `path` 为参数名，但需要确认 extension-service.test.ts 中实际使用的参数名。 | 在实际实现时确认参数名，如果是 `filePath` 或其他名称则相应调整。当前 plan 不必改让执行者注意即可。 |

### INFO

| # | 优先级 | 位置 | 描述 |
|---|--------|------|------|
| 5 | INFO | plan.md / Interface Contracts / postRpcResponse | `postRpcResponse` 中先声明 `const response: RpcResponse = { jsonrpc: '2.0', id: id as number }` 再根据分支动态添加 `result`/`error` 字段。由于 `RpcResponse` 是 union 类型（`RpcSuccessResponse | RpcErrorResponse`），直接赋值一个不完整的对象然后添加字段可能触犯 TypeScript 严格模式（取决于 `RpcResponse` 是接口还是 union tag）。作为内部实现细节，执行者可自行决定类型断言方式。 |

---

## Spec-Plan 逐项对照（详细）

### FR-1: PluginsPane 接入 SettingsView

| Spec 要求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| settings/index.ts export PluginsPane | Task 1 Step 1 | ✅ |
| SettingsView.vue import + tab + v-show | Task 1 Step 2 | ✅ |
| zh-CN.ts 翻译 | Task 1 Step 3 | ✅ |
| en-US.ts 翻译 | Task 1 Step 3 | ✅ |

### FR-2: Worker 端 tool execute RPC handler

| Spec 要求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| ToolExecuteHandler 类型 | Task 2 Step 1 | ⚠️ 见 MUST_FIX #1 |
| ToolRegistration 增加 execute 字段 | Task 2 Step 1 | ⚠️ 应为可选 |
| HostToWorkerMessage.rpc 增加 request | Task 2 Step 1 | ✅ |
| Worker 侧 toolHandlers Map | Task 2 Step 2 | ✅ |
| msg.request 处理分支 | Task 2 Step 2 | ✅ |
| handleIncomingRequest 函数 | Task 2 Step 2 | ✅ |
| tool-api.ts register 本地存 handler | Task 2 Step 3 | ✅ |
| 单元测试 4 cases | Task 2 Step 4 | ⚠️ 见 MUST_FIX #2 |

### FR-3: CI Windows 构建修复

| Spec 要求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| pi 解压脚本 — Windows 路径修复 | Task 3 | ✅ |
| extension-service 测试路径标准化 | Task 4 | ✅ |

---

## E2E 测试计划审查

| 测试场景 | 覆盖的 AC | 可行性 | 评价 |
|---------|----------|--------|------|
| TS-1: PluginsPane Tab Navigation | AC-1 | ✅ | 手动 E2E 步骤清晰 |
| TS-2: Worker Tool Execute RPC | AC-2 | ⚠️ | 依赖 MUST_FIX #1/#2 修复 |
| TS-3: Windows CI pi 资源准备 | AC-3 | ✅ | CI 日志验证 |
| TS-4: Windows CI Extension 测试 | AC-4 | ✅ | CI 日志验证 |
| TS-5: macOS/Linux Regression | AC-5 | ✅ | CI 全通过 |

---

## Non-Functional Design 审查

| 维度 | 评价 |
|------|------|
| 稳定性 | ✅ 变更隔离性好，已有逻辑不修改 |
| 数据一致性 | ✅ schema/handler 分离设计合理，不一致无副作用 |
| 性能 | ✅ O(1) Map 查找，同机 Worker 通信 1-5ms |
| 业务安全 | ✅ 不涉及权限/数据变更 |
| 数据安全 | ✅ 仅在 CI 构建环境操作 |

---

## 等级判定校准检查（无违规）

- **数据丢失风险**：❌ 无 — schema/handler 分离设计，不一致不会导致数据丢失
- **功能失效风险**：❌ 无 — 路径标准化和 shell 兼容性修复正确
- **数据语义错误**：❌ 无
- **重复副作用**：❌ 无
- **时序错误**：❌ 无

---

## 结论

**需修改后重审。** 存在 2 条 MUST FIX，都是关于类型兼容性和函数导出的技术问题，修复范围小（各 1 行），不影响整体架构设计。修复后重审。

### Summary

计划评审完成，第1轮需重审，2条MUST FIX，2条LOW，1条INFO
