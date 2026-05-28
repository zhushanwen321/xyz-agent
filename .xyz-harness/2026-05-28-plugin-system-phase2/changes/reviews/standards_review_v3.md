---
type: review
phase: 3
subtype: standards_review
date: 2026-05-28
reviewed_by: claude-code-agent
verdict: fail
must_fix: 3
files_reviewed: 15
review_metrics:
  linter_passed: false
  typecheck_passed: true
  eslint_errors_frontend: 0
  eslint_errors_runtime: 29
  tsc_errors_production: 0
  tsc_errors_test: 0
  issues_found: 29
  must_fix_count: 3
  low_count: 7
  info_count: 19
---

# 编码规范审查报告 — v3

## 审查范围

- **Branch**: feat-plugin-arch-3
- **v2 必修项**: 5 个 Must Fix
- **本轮重点**: 验证 v2 修复项 + 全面 ESLint/tsc 重新扫描

---

## v2 Must Fix 回归验证

| MF# | v2 描述 | 状态 | 说明 |
|-----|---------|------|------|
| MF1 | `tsc` 编译失败 (18 production + 27 test errors) | **FIXED** | `tsc --noEmit` 零错误输出 |
| MF2 | `plugin-service.ts` 6 个未使用 type import | **NOT FIXED** | `SessionHandlers`, `ConfigHandlers`, `SessionDataHandlers`, `UiHandlers`, `AgentHandlers`, `WorkspaceHandlers` 仍在 line 13-23 |
| MF3 | `plugin-service.ts` 19 个未使用参数/变量 | **NOT FIXED** | stub handler 中 `_sessionId`, `_title` 等仍触发 no-unused-vars |
| MF4 | `plugin-bootstrap.ts:208` 使用 `any[]` | **NOT FIXED** | `...args: any[]` + eslint-disable 注释仍在 |
| MF5 | `server.ts` unused vars (`eventData` 等) | **PARTIAL** | `toolName`, `params` 已清理，但 `eventData` (line 668) 仍赋值后未使用 |

**v2 修复率**: 1/5 完全修复, 1/5 部分修复, 3/5 未修复

---

## Phase A: 自动化检查结果

### 1. tsc 编译（`tsc --noEmit`）

| 区域 | 结果 |
|------|------|
| `runtime/src/` | **PASS** — 零错误 |
| 总计 | **0 production + 0 test errors** |

TypeScript 编译完全通过。v2 报告的 45 个 TS 错误已全部消除。

### 2. ESLint（`eslint "runtime/src/**/*.ts"`）

| 指标 | v2 | v3 | 变化 |
|------|----|----|------|
| 总 errors | 31 | 29 | -2 |
| 总 warnings | 18 | 25 | +7 |
| 文件数 | 5 | 4 | -1 |

**ESLint 未通过** — 仍有 29 个 error。

#### 错误分布（按文件）

| 文件 | Errors | 类型 |
|------|--------|------|
| `plugin-service.ts` | 22 | no-unused-vars (imports + params + `sorted`) |
| `server.ts` | 1 | no-unused-vars (`eventData`) |
| `session-api.ts` | 2 | no-unused-vars (`_params`) |
| `plugin-bootstrap.ts` | 1 | no-explicit-any (`args: any[]`) |

---

## Phase B: Must Fix（v3 — 3 项）

### MF1: `plugin-service.ts` — 6 个未使用 type import（继续）

**行号**: 2, 13, 15, 17, 19, 21, 23

```typescript
// line 2: HookBlockedResult 未使用
import type { ..., HookBlockedResult, ... } from './plugin-types.js'
// line 13-23: Handler 类型全部未使用
import type { SessionHandlers } from './api/session-api.js'
import type { ConfigHandlers } from './api/config-api.js'
import type { SessionDataHandlers } from './api/session-data-api.js'
import type { UiHandlers } from './api/ui-api.js'
import type { AgentHandlers } from './api/agent-api.js'
import type { WorkspaceHandlers } from './api/workspace-api.js'
```

**修复方案**: 删除 7 个未使用的 import（包括 `HookBlockedResult`）。Handler type import 仅在函数签名中使用，但当前调用处直接 inline object literal，type import 无需保留。

### MF2: `plugin-service.ts` — 16 个未使用参数 + 1 个未使用变量

**行号**: 211, 213, 241, 248, 252, 256, 288, 315

stub handler 中的下划线前缀参数和 `sorted` 变量仍触发 ESLint。

```typescript
// line 315: sorted 赋值后未使用
const sorted = [...entries].sort((a, b) => a.priority - b.priority)
```

**修复方案**:
- `sorted` 变量: 要么使用它（后续 broadcast 中利用排序结果），要么删除排序语句
- stub handler params: 添加 `// eslint-disable-next-line @typescript-eslint/no-unused-vars` 注释或使用 `_` 单下划线（项目 ESLint 配置可能允许单下划线），确认 `.eslintrc` 的 `no-unused-vars` 规则中 `argsIgnorePattern` 设置

### MF3: `plugin-bootstrap.ts:208` — `any[]` 类型（继续）

```typescript
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
Module._resolveFilename = function (request: string, ...args: any[]): string {
```

**修复方案**: 用 `unknown[]` 替代 `any[]`，在函数体内做类型断言。`_resolveFilename` 的剩余参数类型为 `(...args: unknown[])`，调用 `.call(this, request, ...args)` 时不需要 any。

---

## Phase C: Low（7 项）

| # | 文件 | 行号 | 规则 | 描述 |
|---|------|------|------|------|
| L1 | `server.ts` | 668 | no-unused-vars | `eventData` 赋值后未使用 — 删除或加 `_` 前缀 |
| L2 | `session-api.ts` | 29 | no-unused-vars | `_params` — RPC handler 的空参数，加 eslint-disable 注释 |
| L3 | `session-api.ts` | 38 | no-unused-vars | `_params` — 同上 |
| L4 | `plugin-storage.ts` | 5-6 | no-magic-numbers | `10`, `1024` 等常量 (warnings) |
| L5 | `plugin-storage.ts` | 183 | no-magic-numbers | `2` (warning) |
| L6 | `plugin-storage.ts` | 200 | no-magic-numbers | `12` (warning) |
| L7 | `plugin-bootstrap.ts` | 205 | — | Unused eslint-disable directive (warning) |

---

## Phase D: Info（19 项）

`plugin-storage.ts` 中 7 个 no-magic-numbers warning，`plugin-bootstrap.ts` 中 unused eslint-disable directive，以及多个文件中的 warnings。均为非阻塞问题。

---

## 趋势总结

| 指标 | v1 | v2 | v3 |
|------|----|----|-----|
| tsc errors | N/A | 45 | **0** |
| ESLint errors | 35 | 31 | 29 |
| Must Fix | 7 | 5 | **3** |
| Verdict | fail | fail | **fail** |

tsc 编译已完全通过，ESLint 错误稳步下降。剩余 3 个 Must Fix 全部集中在 `plugin-service.ts` 和 `plugin-bootstrap.ts`，修复量小（删 import、改参数类型、删除/使用 `sorted` 变量）。

**预计 1 轮修复即可通过。**

---

## 下一步

1. 删除 `plugin-service.ts` 中 7 个未使用 import
2. 处理 `sorted` 变量（使用或删除）+ stub handler 参数 eslint 抑制
3. `plugin-bootstrap.ts` 的 `any[]` → `unknown[]`
4. 删除 `server.ts:668` 的 `eventData` 赋值
