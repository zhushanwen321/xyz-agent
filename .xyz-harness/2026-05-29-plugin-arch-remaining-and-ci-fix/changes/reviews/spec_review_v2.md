---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-29T20:30:00"
  target: ".xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/spec.md"
  verdict: pass
  summary: "计划评审完成，第2轮通过，3条MUST FIX全部修复，0条open MUST_FIX"

statistics:
  total_issues: 8
  must_fix: 0
  must_fix_resolved: 3
  low: 2
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md: FR-2 改动范围"
    title: "FR-2 execute handler 注册路径未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md: AC-2"
    title: "AC-2 验收标准不可直接验证（缺少 Worker 侧测试覆盖）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "spec.md: FR-2 改动范围"
    title: "HostToWorkerMessage 类型变更未在 scope 中列出"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "spec.md: FR-3"
    title: "Windows pi 解压 rename 目标未指定"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "spec.md: FR-3"
    title: "extension-service 路径修复策略过于简单"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 6
    severity: INFO
    location: "spec.md: FR-2"
    title: "HostToWorkerMessage 类型变更可能影响现有测试"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 7
    severity: INFO
    location: "spec.md: FR-2"
    title: "FR-2 未定义 tool 方法名冲突处理策略"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 8
    severity: INFO
    location: "spec.md: FR-2 设计细节"
    title: "toolHandlers Map 共享机制的实现细节留待 plan 阶段"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2 — Spec 完整性（增量审查）

## 评审记录
- 评审时间：2026-05-29 20:30
- 评审类型：计划评审（增量审查 mode，基于 v1）
- 评审对象：`.xyz-harness/2026-05-29-plugin-arch-remaining-and-ci-fix/spec.md`
- 上下文：spec_review_v1.md（仅读取 MUST_FIX 列表用于增量验证）

---

## 增量审查范围

根据增量审查模式规则，本 v2 评审仅做：
1. [FIXED] 验证 v1 MUST_FIX 修复情况
2. [REGRESSION] 检查修复是否引入新问题
3. [NEW] 是否有新 MUST_FIX 出现
4. **不重新扫描 LOW/INFO**（已在上轮处理，v2 只验证其修复后状态）

---

## 1. MUST_FIX 修复验证

### [FIXED] MUST_FIX #1 — FR-2 execute handler 注册路径已定义

| 检查项 | 状态 |
|--------|------|
| `ToolExecuteHandler` 类型签名已定义 | ✅ spec 第 48-52 行，接收 `{ arguments, sessionId?, toolCallId? }`，返回 `Promise<BridgeToolExecuteResponse>` |
| `ToolRegistration` 增加 `execute: ToolExecuteHandler` 字段 | ✅ spec 第 54-59 行，新建 Required 字段 |
| `plugin-bootstrap.ts` 新增 `toolHandlers` Map | ✅ spec 第 62-64 行，key 格式 `${pluginId}:${toolName}` |
| `createToolApi().register()` 存储 handler 到局部 Map + 同步 schema 到主线程 | ✅ spec 第 66-69 行，描述了完整的双向注册流程 |
| `plugin-bootstrap.ts` `rpc` case 处理 `msg.request` | ✅ spec 第 71-75 行，找到 handler 返回响应，未找到返回错误 |
| `HostToWorkerMessage` 增加 `request` 字段 | ✅ spec 第 77-79 行，类型变更在 scope 中 |

**验证结论：** 注册路径从类型定义 → Worker Map 存储 → RPC 请求处理 → 响应返回的完整链路均已定义。✅ **已修复。**

### [FIXED] MUST_FIX #2 — AC-2 已有可验证的测试策略

| 检查项 | 状态 |
|--------|------|
| AC-2 中明确提到了"有单元测试覆盖" | ✅ spec 第 116 行 |
| 测试策略描述了导出 `handleMessage` | ✅ spec 第 91 行 |
| 测试策略描述了正向场景（注册 handler → RPC request → 响应） | ✅ spec 第 92 行 |
| 测试策略描述了异常场景（未注册 handler → error response） | ✅ spec 第 93 行 |

**验证结论：** AC-2 不再是"LLM 端到端链路验证"，而是"直接对 handleMessage 发 RPC request 验证"。✅ **已修复。**

### [FIXED] MUST_FIX #3 — HostToWorkerMessage 类型变更已在 scope 列出

| 检查项 | 状态 |
|--------|------|
| `HostToWorkerMessage.rpc` 增加 `request?: RpcRequest` | ✅ spec 第 78 行 |
| 该变更在改动范围中列出 | ✅ spec 第 82 行（`plugin-types.ts` 包含此项） |

**验证结论：** 类型变更既是设计细节的一部分，也在 scope 中明确列出。✅ **已修复。**

---

## 2. LOW/INFO 修复验证（快速检查）

| v1 ID | 问题 | 当前状态 | 验证 |
|-------|------|---------|------|
| #4 | Windows pi rename 目标 | 明确为 `${BINARY_NAME}（即 pi-windows-x64.exe）` | ✅ |
| #5 | 路径修复策略 | 给出两种精确方案（`.endsWith()` / `path.basename`+`path.dirname`） | ✅ |
| #6 | 类型变更影响测试 | HostToWorkerMessage 已在 scope 中，开发者可见 | ✅ |
| #7 | tool 冲突策略 | 已知限制已记录（Phase 4 处理） | ✅ |

---

## 3. 回归检查：修复是否引入新问题

### 3.1 `ToolRegistration.execute` 为 Required 字段

**问题：** `execute` 现在是 Required 字段（非 `execute?`），意味着所有 `ToolRegistration` 实例必须提供 handler。

**影响分析：**
- 已有内置插件（Goal/Todo）不使用 `api.tools.register()`（spec 已知限制已注明）→ 不受影响
- 任何未来注册 tool 的插件都必须提供 execute handler → 与 FR-2 目标一致（FR-2 就是要让每个注册的 tool 有对应的执行能力）
- 测试代码中构造 `ToolRegistration` 对象时不带 `execute` 可能需要更新 → 但测试侧本次也会新增（FR-2 测试策略），可一并处理

**判定：** 设计意图明确，不构成回归问题。✅ 通过。

### 3.2 `toolHandlers` Map 共享机制的实现细节

**问题：** spec 第 84 行对 `tool-api.ts` 访问 `toolHandlers` Map 的机制仅写了"通过回调或直接 import Map"。

**分析：** 这属于实现细节，计划阶段可选择的具体 wiring 模式有多种（参数注入、setter 注入、共享模块），均为标准模式。Spec 层次不需要锁定一种实现方案。

**判定：** 不构成 MUST_FIX 或 LOW。记录为 INFO。✅

---

## 4. 结论

**通过** — verdict: pass，0 条 open MUST_FIX。

3 条 MUST_FIX 全部修复，未引入新的严重问题。spec 质量从 v1 的"结构清晰但 FR-2 细节缺失"提升到"完整性合格，可直接进入 plan 阶段"。

### Summary

计划评审（Spec 完整性增量审查）完成，第 2 轮通过，3 条 MUST_FIX 全部修复，0 条 open MUST_FIX。
