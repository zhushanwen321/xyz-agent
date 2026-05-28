---
type: review
phase: 3
subtype: standards_review
date: 2026-05-28
reviewed_by: claude-code-agent
verdict: fail
must_fix: 5
files_reviewed: 15
review_metrics:
  linter_passed: false
  typecheck_passed: false
  eslint_errors_frontend: 0
  eslint_errors_runtime: 31
  tsc_errors_production: 18
  tsc_errors_test: 27
  issues_found: 35
  must_fix_count: 5
  low_count: 8
  info_count: 22
---

# 编码规范审查报告 — v2

## 审查范围

- **Branch**: feat-plugin-arch-3
- **基准 commit**: `9fba460` (fix: review fixes - permission checker wiring, bridge response types, error.code type fix)
- **未提交变更**: 6 个已修改文件 + 1 个 untracked review 文件（in-progress 修复）
- **对比**: v1 报告中的 7 个 Must Fix 逐项验证

---

## v1 Must Fix 回归验证

| MF# | v1 描述 | 状态 | 说明 |
|-----|---------|------|------|
| MF1 | `sessionDataCache` 重复声明 (readonly vs private) | **FIXED** | 单一声明 `private sessionDataCache = new Map<...>()` (line 42) |
| MF2 | `syncToolsToBridge()` 返回 void 而非 Promise | **FIXED** | 现为 `async syncToolsToBridge(): Promise<void>` (line 320) |
| MF3 | `BridgeToolExecuteResponse` 缺少 result 字段 | **PARTIAL** | 返回值改为 `{ content, isError }`，但类型本身未导入 → TS2304 |
| MF4 | `Error.code` TypeScript 类型不存在 | **PARTIAL** | 改为 `(err as Record<string, unknown>).code`，但双重断言不合法 → TS2352 |
| MF5 | `plugin-bootstrap.ts:208` 使用 `any[]` | **NOT FIXED** | 仍为 `...args: any[]` + eslint-disable 注释 |
| MF6 | `plugin-service.ts` 7 个未使用 import | **NOT FIXED** | 仍有 6 个未使用 type import (SessionHandlers, ConfigHandlers 等) |
| MF7 | `server.ts` 4 个赋值后未使用变量 | **NOT FIXED** | `toolName`, `params`, `eventData`(x2) 仍赋值后未使用 |

**v1 修复率**: 2/7 完全修复, 2/7 部分修复（引入新 tsc 错误）, 3/7 未修复

---

## Phase A: 自动化检查结果

### A1. ESLint

| 范围 | errors | warnings | 状态 |
|------|--------|----------|------|
| Frontend (`src-electron/renderer/src/`) | 0 | 0 | **PASS** |
| Runtime (`src-electron/runtime/src/`) | 31 | 0 | **FAIL** |

#### Runtime ESLint 明细（31 errors）

**no-explicit-any** — 1 处:
| 文件 | 行 | 内容 |
|------|-----|-------|
| `plugin-bootstrap.ts` | 208 | `...args: any[]` (带 eslint-disable 注释但 lint 仍报错) |

**no-unused-vars** — 30 处:

`plugin-service.ts` (26 处):
| 行 | 变量 | 说明 |
|-----|------|------|
| 12 | `SessionHandlers` | type import 未使用 |
| 14 | `ConfigHandlers` | type import 未使用 |
| 16 | `SessionDataHandlers` | type import 未使用 |
| 18 | `UiHandlers` | type import 未使用 |
| 20 | `AgentHandlers` | type import 未使用 |
| 22 | `WorkspaceHandlers` | type import 未使用 |
| 200 | `_id` | stub handler 参数 |
| 202 | `_sessionId`, `_role`, `_content` | stub handler 参数 (3 处) |
| 230 | `_sessionId`, `_key`, `_value` | stub handler 参数 (3 处) |
| 237 | `_title`, `_options`, `_pluginId` | stub handler 参数 (3 处) |
| 241 | `_title`, `_message`, `_pluginId` | stub handler 参数 (3 处) |
| 245 | `_title`, `_defaultValue`, `_pluginId` | stub handler 参数 (3 处) |
| 277 | `_pattern` | stub handler 参数 |
| 304 | `sorted` | 赋值后未使用 |

`server.ts` (4 处):
| 行 | 变量 | 说明 |
|-----|------|------|
| 668 | `toolName` | bridge:tool_execute 解构后未使用 |
| 669 | `params` | bridge:tool_execute 解构后未使用 |
| 682 | `eventData` | bridge:event 解构后未使用 |
| 691 | `eventData` | bridge:intercept 解构后未使用 |

### A2. TypeScript 类型检查

#### 生产代码 tsc 错误 — 18 处

**TS2304 (Cannot find name)** — 16 处（均在 `plugin-service.ts`）:

`plugin-service.ts` 缺少从 `plugin-types.ts` 的类型导入，以下类型直接使用但未 import：

| 类型名 | 出现行数 | 次数 |
|--------|---------|------|
| `ToolEntry` | 34 | 1 |
| `HookEntry` | 38 | 1 |
| `PluginDescriptor` | 108, 111, 115 | 3 |
| `ToolRegistration` | 285, 325 | 2 |
| `HookContext` | 299, 349, 365 | 3 |
| `HookResult` | 299 | 1 |
| `HookType` | 351, 367 | 2 |
| `BridgeToolExecuteRequest` | 334 | 1 |
| `BridgeToolExecuteResponse` | 334 | 1 |
| `BridgeInterceptResponse` | 364 | 1 |
| 合计 | | **16** |

**TS2352 (bad cast)** — 2 处（均在 `plugin-sandbox.ts`）:
| 行 | 说明 |
|-----|------|
| 52 | `(err as Record<string, unknown>)` — Error 不能直接断言为 Record，需先 `as unknown` |
| 62 | 同上 |

#### 测试代码 tsc 错误 — 27 处

- `plugin-api-extended.test.ts` (15 处): `RpcResponse.result` 属性不存在 — 需要用类型守卫 `.type === 'success'` 后再访问 `.result`
- `plugin-api-hooks.test.ts` (2 处): `HookInterceptor` 返回值缺少 `proceed` 属性
- `plugin-api-tools.test.ts` (1 处): `resp.error` 可能为 undefined
- `plugin-hooks-integration.test.ts` (5 处): `HookType` 字面量不匹配 + `sessionDataCache` private 访问
- `bridge-sync.test.ts` (4 处): Mock 类型与 `PiEventListener` 签名不兼容

---

## Phase B: Must Fix 项（v2）

### MF2-1. plugin-service.ts 缺少 plugin-types.ts 类型导入

**严重度**: block（tsc 编译失败）
**文件**: `src-electron/runtime/src/services/plugin-service/plugin-service.ts`
**问题**: 16 个类型从 `plugin-types.ts` 导出但未在 `plugin-service.ts` 中 import。可能是 v1 MF6 修复时误删了类型导入。
**修复**: 添加 `import type { ToolEntry, HookEntry, PluginDescriptor, ToolRegistration, HookContext, HookResult, HookType, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse } from './plugin-types.js'`

### MF2-2. plugin-sandbox.ts 双重类型断言不合法

**严重度**: block（tsc 编译失败）
**文件**: `src-electron/runtime/src/services/plugin-service/plugin-sandbox.ts` line 52, 62
**问题**: `(err as Record<string, unknown>).code` — Error 类型不能直接断言为 `Record<string, unknown>`，TS 报 TS2352。
**修复方案 A**（推荐）: `(err as unknown as Record<string, unknown>).code`
**修复方案 B**: 使用 `Object.assign(err, { code: 'PERMISSION_DENIED' })`
**修复方案 C**: 定义 `class PermissionError extends Error { code = 'PERMISSION_DENIED' }`

### MF2-3. plugin-bootstrap.ts:208 使用 any[]

**严重度**: violation（CLAUDE.md 禁止 any 规范）
**文件**: `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts` line 208
**问题**: `Module._resolveFilename = function (request: string, ...args: any[])` 违反 CLAUDE.md 核心规则"禁止 any"。
**说明**: 此处覆盖 Node.js 内部 `Module._resolveFilename`，参数签名固定。eslint-disable 注释存在但 lint 仍报错（eslint-disable 行注释位置可能不对）。
**修复**: 改为 `...args: unknown[]`，调用 `_originalResolveFilename.call(this, request, ...args as [string, ...unknown[]])` 或使用 `Parameters<typeof _originalResolveFilename>` 提取类型。

### MF2-4. plugin-service.ts 6 个未使用 type import + 1 个未使用变量

**严重度**: lint block
**文件**: `src-electron/runtime/src/services/plugin-service/plugin-service.ts`
**问题**:
- lines 12-22: 6 个 type import 未使用（SessionHandlers, ConfigHandlers, SessionDataHandlers, UiHandlers, AgentHandlers, WorkspaceHandlers）
- line 304: `sorted` 赋值后未使用
**修复**: 删除未使用的 type import；`sorted` 变量需检查是否有后续逻辑遗漏，否则删除赋值。

### MF2-5. server.ts 4 个未使用变量

**严重度**: lint block
**文件**: `src-electron/runtime/src/server.ts` lines 668-691
**问题**: `bridge:tool_execute` 和 `bridge:event`/`bridge:intercept` handler 中解构了变量但当前 stub 实现未使用。
**修复方案**: 添加 `// TODO: Phase 2 BG4 — will use these vars` 注释 + 变量名加 `_` 前缀（如 `_toolName`），或在 TODO 实现前直接删除解构。

---

## Phase C: Low Priority 项

| ID | 文件 | 说明 |
|----|------|------|
| LO1 | `plugin-service.ts` stub handlers | 26 处 `_` 前缀参数触发 `no-unused-vars` — 应在 eslint 配置中允许 `_` 前缀或改用 `// eslint-disable-next-line` |
| LO2 | `session-api.ts` lines 29, 38 | `_params` 未使用，同样的 stub 参数问题 |
| LO3 | `session-service.ts` line 188 | Hook 错误 broadcast `message.error`，前端 handler 匹配未确认 |
| LO4 | `server.ts` lines 660-708 | `handleBridgeRequest` 方法约 90 行，建议拆分 |
| LO5 | `plugin-activator.ts` lines 215-264 | `topologicalSort` 参数类型可更精确 |
| LO6 | test files (27 tsc errors) | 测试类型错误需在 Phase 4 (test) 统一修复 |
| LO7 | `resources/` plugin files | Bridge/Goal plugin 的 `any` 使用（Phase 2 BG4 后续清理） |
| LO8 | `plugin-sandbox.ts` getCache 暴露引用 | 私有 cache 通过 `getCache: () => this.sessionDataCache` 暴露，外部可篡改 |

---

## Phase D: v1 Low/Info 项状态

| v1 ID | 描述 | v2 状态 |
|-------|------|---------|
| LO1 | stub handler `_` 前缀参数 | 未变，runtime eslint 暴露 26 处 |
| LO2 | `message.error` 前端匹配 | 未确认，保持 open |
| LO3 | getCache 暴露引用 | 未变，保留 |
| LO4 | server.ts 方法过长 | 未变，保留 |
| LO5 | topologicalSort 类型 | 未变，保留 |
| LO6 | HookType JSDoc | 未变，保留 |
| LO7 | eslint-disable 规避 | MF5 仍存在 |
| LO8 | refresh() 链式调用 | 未变 |
| LO9 | resources/ any 清理 | 未变 |

---

## 结论

**verdict: fail**

v1 提出的 7 个 Must Fix 中，仅 2 个（MF1, MF2）完全修复。commit `9fba460` 的修复引入了新问题：删除了 `plugin-types.ts` 的类型导入但未重建 import 语句，导致 16 个 tsc `Cannot find name` 错误。`Error.code` 的类型修复不完整（需要双重断言）。

**当前自动化检查状态**:
- Frontend ESLint: **PASS** (0 errors)
- Runtime ESLint: **FAIL** (31 errors)
- Production tsc: **FAIL** (18 errors)
- Test tsc: **FAIL** (27 errors)

**核心阻塞问题**: `plugin-service.ts` 缺少 `plugin-types.ts` 的类型导入（16 个 tsc 错误）。这很可能是 v1 MF6 修复时的回归 bug —— 删除了"未使用 import"但那些类型实际上在代码中被引用。

建议下一步:
1. 恢复 `plugin-types.ts` 的类型导入（MF2-1） — 这将一次性消除 16 个 tsc 错误
2. 修复 `plugin-sandbox.ts` 双重断言（MF2-2）
3. 修复 `plugin-bootstrap.ts` 的 `any[]`（MF2-3）
4. 清理未使用 import 和变量（MF2-4, MF2-5）
5. 将 31 个 ESLint error 清零后重新跑 gate

---

*审查人: claude-code-agent（自动化 + AI 规范对比）*
*审查日期: 2026-05-28*
*审查版本: v2*
