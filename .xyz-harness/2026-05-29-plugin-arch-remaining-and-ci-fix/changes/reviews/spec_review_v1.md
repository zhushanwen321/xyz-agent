---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-29T20:00:00"
  target: ".xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/spec.md"
  verdict: fail
  summary: "计划评审完成，第1轮需重审，3条MUST FIX"

statistics:
  total_issues: 7
  must_fix: 3
  must_fix_resolved: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md: FR-2 / AC-2"
    title: "FR-2 execute handler 注册路径未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md: AC-2"
    title: "AC-2 验收标准不可直接验证（缺少 Worker 侧测试覆盖）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md: FR-2 改动范围"
    title: "HostToWorkerMessage 类型变更未在 scope 中列出"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md: FR-3"
    title: "Windows pi 解压 rename 目标未指定"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md: FR-3"
    title: "extension-service 路径修复策略过于简单"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md: FR-2"
    title: "HostToWorkerMessage 类型变更可能影响现有测试"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "spec.md: FR-2"
    title: "FR-2 未定义 tool 方法名冲突处理策略"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1 — Spec 完整性审查

## 评审记录
- 评审时间：2026-05-29 20:00
- 评审类型：计划评审（Spec 完整性）
- 评审对象：`.xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/spec.md`
- 上下文文件：`CLAUDE.md`、`plugin-bootstrap.ts`、`plugin-types.ts`、`tool-api.ts`、`plugin-rpc-server.ts`、`plugin-rpc-client.ts`、`SettingsView.vue`、`plugin-tool-execution.test.ts`

## 总体评价

Spec 结构清晰，FR/AC/Boundaries/Use Cases 完整，改动范围界定合理（4 个独立小改动）。但有 3 个 MUST FIX 问题集中在 FR-2（Worker 端 tool execute RPC handler）的设计定义上，核心问题是 **execute handler 如何从插件代码流到 Worker 侧的 tool handler Map** 没有定义清楚。

---

## 1. Spec 完整性逐项检查

### 1.1 目标是否明确
✅ **通过** — "完成剩余的 P0/P1 集成缺口，并修复 CI Windows 构建失败" — 一句话说清楚。

### 1.2 范围是否合理
✅ **通过** — 4 个独立修复点，每个变动范围小（< 50 行），边界清晰。Constraints 章节明确排除 Phase 4 内容和 P1 非关键项。

### 1.3 验收标准是否可量化
❌ **MUST FIX #2** — AC-2 "插件注册的 tool 能通过 LLM 调用并返回结果（Worker 端 execute handler 生效）" 不可直接验证：

- 现有 `plugin-tool-execution.test.ts` 仅测试了**主线程侧**链路（`handleBridgeToolExecute` + `rpcServer.invoke`），Worker 侧的 RPC request 处理完全被 mock 了
- FR-2 的核心改动在 Worker 侧（`plugin-bootstrap.ts` 的 `rpc` case 处理 `msg.request`），但没有定义任何测试覆盖这个新路径
- 依赖完整 AI Agent（pi LLM → bridge → main thread → Worker RPC）的端到端链路无法在 CI 中可靠运行
- **需要定义一个具体的测试策略**：直接对 `plugin-bootstrap.ts` 的 `handleMessage` 发伪造的 RPC request，验证 response 正确路由到 tool handler

### 1.4 是否标记了 [待决议] 项
⚠️ **无 [待决议] 标记，但存在未定义的设计决策**（详见 MUST FIX #1）

### 1.5 是否与现有代码架构一致
❌ **MUST FIX #1** 和 **MUST FIX #3** 反映架构层面的不一致。

---

## 2. 具体发现

### MUST FIX 问题

#### #1 — FR-2 execute handler 注册路径未定义 (MUST FIX)

| 项目 | 内容 |
|------|------|
| 位置 | spec.md FR-2 改动范围 |
| 问题 | Spec 说 "Worker 侧 register 同时存储 handler" 和 "ToolRegistration 增加 execute 签名"，但 execute handler 的注册路径未定义 |
| 详细说明 | 当前 `plugin-types.ts` 的 `ToolRegistration` 只包含 `{ name, description, parameters }`。<br>当前 `tool-api.ts` 的 `createToolApi()` 返回的 `register` 只接受 `ToolRegistration`，且通过 RPC 将 schema 发给主线程。Worker 侧**没有**存储任何本地 handler。Spec 没有定义：<br>1. `api.tools.register()` 的新签名 — 是否改为 `register(registration: ToolRegistration, handler?: ToolExecuteHandler)`？<br>2. Handler 类型签名是什么？<br>3. 如何在 Worker 侧维护这个 handler Map？<br>4. 已有内置插件（Goal/Todo）是否调用 `api.tools.register()`？如果调用，是否需要更新？ |
| 复现步骤 | 尝试按 spec 实现 FR-2 时会卡在：createToolApi 的 register 只收 schema，没有地方传入 execute handler |
| 修改方向 | 补充分段明确：<br>1. `ToolRegistration` 新增 `execute?: (params: Record<string, unknown>, sessionId?: string, toolCallId?: string) => Promise<BridgeToolExecuteResponse>`<br>2. `createToolApi()` 的 register 在 Worker 侧存储 handler（本地 Map），同时通过 RPC 发 schema 到主线程<br>3. `HostToWorkerMessage` 增加 `request?: RpcRequest` 类型字段（参见 #3）<br>4. `PluginRpcClient` 增加 `handleRequest()` 方法或由 bootstrap 直接 invoke 本地 handler Map<br>5. 说明 Goal/Todo 是否受此改动影响 |

---

#### #2 — AC-2 验收标准不可直接验证 (MUST FIX)

| 项目 | 内容 |
|------|------|
| 位置 | spec.md AC-2 |
| 问题 | AC-2 描述依赖端到端 LLM 链路验证，没有定义具体的测试工具、测试场景或 mock 方案 |
| 详细说明 | IR_2 的核心改动（Worker 侧处理 RPC request）缺少测试。现有 `plugin-tool-execution.test.ts` 测试主线程侧的 RPC invoke 但 mock 了 Worker 响应。FR-2 新增的 Worker 侧 `msg.request` 处理是无测试覆盖的代码路径。 |
| 修改方向 | 明确测试策略：<br>方案 A: 在 `plugin-bootstrap.ts` 中导出 `handleMessage` 并针对它写单元测试（发送 `{ type: 'rpc', request: { ... } }` 模拟 RPC request）<br>方案 B: 用一个测试用 Worker 启动，注册假 tool，通过 `rpcServer.invoke` 调用后验证响应<br>建议方案 A（更轻量） |

---

#### #3 — HostToWorkerMessage 类型变更未在 scope 中列出 (MUST FIX)

| 项目 | 内容 |
|------|------|
| 位置 | spec.md FR-2 改动范围 |
| 问题 | 当前 `plugin-types.ts` 的 `HostToWorkerMessage` 类型：`{ type: 'rpc'; response?: RpcResponse; notification?: RpcNotification }` — **没有 `request` 字段** |
| 详细说明 | FR-2 要求主线程向 Worker 发送 `plugin.tool.execute` RPC request，但 `HostToWorkerMessage` 类型不支持 `request` 字段。Spec 的改动范围列出了 `plugin-types.ts`（ToolRegistration 增加 execute 签名）但 **没有列出 `HostToWorkerMessage` 类型变更**。这是 FR-2 必不可少的类型级前提条件。 |
| 修改方向 | 在 spec FR-2 改动范围中补充：<br>`src-electron/runtime/src/services/plugin-service/plugin-types.ts` — `HostToWorkerMessage` 的 `rpc` 变体增加 `request?: RpcRequest` |

---

### LOW 问题

#### #4 — Windows pi 解压 rename 目标未指定 (LOW)

| 项目 | 内容 |
|------|------|
| 位置 | spec.md FR-3 第 1 点 |
| 问题 | "rename + 资源处理" 不够精确 |
| 详细说明 | 从上下文推测 rename 目标为 `pi-windows-x64.exe`，但 spec 未明确写出。脚本实现时可能产生歧义。 |

#### #5 — extension-service 路径修复策略过于简单 (LOW)

| 项目 | 内容 |
|------|------|
| 位置 | spec.md FR-3 第 2 点 |
| 问题 | `p.includes('ext-a/package.json')` 在 `ext-a/` 和 `sub-ext-a/` 的情况下都会匹配 |
| 详细说明 | Spec 建议 `p.replace(/\\/g, '/')` 路径标准化，但标准化后仍用 `includes` 匹配。如果某个路径包含 `ext-a/` 作为路径片段的一部分，会误匹配。更精确的做法是结合 `path.basename(p)` + `path.dirname(p)` 或 `path.parse`。 |

---

### INFO 问题

#### #6 — HostToWorkerMessage 类型变更可能影响现有测试 (INFO)

| 项目 | 内容 |
|------|------|
| 位置 | spec.md FR-2 |
| 说明 | `HostToWorkerMessage` 的 `rpc` 变体增加 `request` 字段后，现有 `plugin-rpc.test.ts` 中构造 mock message 的代码可能需要更新类型断言。建议在 spec 中标注这一影响。 |

#### #7 — FR-2 未定义 tool 方法名冲突处理策略 (INFO)

| 项目 | 内容 |
|------|------|
| 位置 | spec.md FR-2 |
| 说明 | 如果两个插件注册了同名 tool，`handleBridgeToolExecute` 通过 schema.name 匹配（`find(e => e.schema.name === ...)`），会返回第一个匹配的。如果多个插件都有同名 tool，行为未定义。当前可接受（Phase 4 会引入更完善的冲突解决），但建议在 spec 中注明"已知限制，Phase 4 处理"。 |

---

## 3. 结论

**需修改后重审** — verdict: fail，共 3 条 MUST FIX 待解决。

### Summary

计划评审（Spec 完整性）完成，第 1 轮，3 条 MUST FIX（FR-2 execute handler 注册路径未定义 / AC-2 不可验证 / HostToWorkerMessage 类型遗漏），需修改后重审。
