---
type: review
phase: 3
subtype: standards_review
date: 2026-05-28
reviewed_by: claude-code-agent
verdict: fail
must_fix: 7
files_reviewed: 15
review_metrics:
  linter_passed: false
  typecheck_passed: false
  files_reviewed: 15
  issues_found: 43
  must_fix_count: 7
  low_count: 12
  info_count: 24
---

# 编码规范审查报告 — v1

## 审查范围

- **Branch**: feat-plugin-arch-3
- **Diff base**: HEAD （未提交变更）
- **审查阶段**: Phase 2 开发中代码
- **审查文件**: 15 个变更/新增文件（git diff 覆盖 18 个文件 + 10+ 个 untracked 新文件）

### 文件清单

已修改（18 个文件，837 新增 / 27 删除）：
- `CONTEXT.md`
- `src-electron/renderer/src/components/layout/AppStatusbar.vue`
- `src-electron/runtime/src/event-adapter.ts`
- `src-electron/runtime/src/index.ts`
- `src-electron/runtime/src/server.ts`
- `src-electron/runtime/src/services/plugin-service/`（6 个文件）
- `src-electron/runtime/src/services/session-service.ts`
- `src-electron/runtime/vitest.config.ts`
- `src-electron/runtime/test/`（3 个测试文件）

新增未跟踪（`??` 状态）：
- `src-electron/runtime/src/services/plugin-service/api/`（多文件）
- `src-electron/runtime/src/services/plugin-service/plugin-sandbox.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-permission.ts`
- `src-electron/runtime/src/services/plugin-service/plugin-permission-storage.ts`
- `src-electron/runtime/src/services/plugin-service/hook-api.ts`
- `src-electron/runtime/src/services/plugin-service/tool-api.ts`
- `resources/pi/agent/extensions/bridge/index.ts`
- `resources/plugins/goal/`（多个文件）
- `src-electron/runtime/test/`（多文件）

---

## Phase A: 自动化检查结果

### A1. ESLint（49 errors, 0 warnings）

#### `@typescript-eslint/no-explicit-any` — 14 处

| 文件 | 行 | 内容 |
|------|-----|-------|
| `resources/pi/agent/extensions/bridge/index.ts` | 7,22x2,31,43,58 | 6 处 `any` 类型 |
| `resources/plugins/goal/index.ts` | 11 | 1 处 `any` |
| `resources/plugins/goal/src/goal-hooks.ts` | 14,20,77 | 3 处 `any` |
| `resources/plugins/goal/src/goal-tool.ts` | 26,90,140 | 3 处 `any` |
| `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts` | 208 | 1 处 `any` |

#### `@typescript-eslint/no-unused-vars` — 35 处

| 文件 | 行数 | 说明 |
|------|------|-------|
| `resources/pi/agent/extensions/bridge/index.ts` | 1,31 | `PiExtensionAPI` 未使用，`args` 未使用 |
| `resources/plugins/goal/src/goal-hooks.ts` | 20,77 | `ctx`、`data` 未使用 |
| `resources/plugins/goal/src/goal-tool.ts` | 90 | `extra` 未使用 |
| `src-electron/runtime/src/server.ts` | 659,660,673,682 | `toolName`, `params`, `eventData`(x2) 赋值后未使用 |
| `src-electron/runtime/src/services/plugin-service/api/session-api.ts` | 29,38 | `_params` 未使用 |
| `src-electron/runtime/src/services/plugin-service/plugin-service.ts` | 1,12,14,16,18,20,22,197,199,227,234,238,242,274,301 | 共 15 处未使用变量/import |

### A2. TypeScript 类型检查（tsc --noEmit）

#### 生产代码错误 — 7 处

| # | 文件 | 行 | 类型 | 说明 |
|---|------|-----|------|-------|
| 1 | `plugin-sandbox.ts` | 52 | `TS2339` | `Property 'code' does not exist on type 'Error'` |
| 2 | `plugin-sandbox.ts` | 62 | `TS2339` | `Property 'code' does not exist on type 'Error'` |
| 3 | `plugin-service.ts` | 40 | `TS2687` | `readonly sessionDataCache` 与第 43 行 `private sessionDataCache` 修饰符不一致 |
| 4 | `plugin-service.ts` | 43 | `TS2300` | `Duplicate identifier 'sessionDataCache'` |
| 5 | `plugin-service.ts` | 43 | `TS2687` | 同上修饰符不一致 |
| 6 | `plugin-service.ts` | 144 | `TS2322` | `Type 'void' is not assignable to type 'Promise<void>'` — `syncToolsToBridge()` 返回 `void` |
| 7 | `plugin-service.ts` | 335 | `TS2741` | `Property 'result' is missing in type '{ success: false; error: string; }' but required in type 'BridgeToolExecuteResponse'` |

#### 测试代码错误 — 20+ 处

- `bridge-sync.test.ts`（3 处）：`EventAdapter` 类型不匹配 mock
- `plugin-api-extended.test.ts`（15 处）：`RpcResponse.result` 不存在
- `plugin-api-hooks.test.ts`（1 处）：`HookInterceptor` 参数类型不匹配
- `plugin-hooks-integration.test.ts`（含 `as any` 规避）

---

## Phase B: AI 人工审查 — 规范符合性

### CLAUDE.md 核心规则审查

#### B1. 禁止 `any` ❌

**MUST FIX**: `plugin-bootstrap.ts:208` 使用 `any[]`：

```typescript
...args: any[]
```

应改为 `...args: unknown[]` 并配合类型守卫访问。

**INFO**: `resources/` 目录下的 bridge extension 和 goal plugin 大量使用 `any`（8 处），但属于新资源文件。建议统一清理。

#### B2. emit 只传单个 payload 对象 ✅

本次变更未新增 `emit` 调用，无违规。

#### B3. Event bus listener 防重复注册 ✅

`AppStatusbar.vue` 正确实现了模块级 `_refCount` 模式：

```typescript
let _refCount = 0
let _cleanup: (() => void) | null = null
```

符合规范 §2.2 的要求。

#### B4. 错误必须重置 isGenerating + streamingMessage ⚠️

**INFO**: `session-service.ts` 新增的 `sendMessageHook` 错误路径：

```typescript
this.broker.broadcast({
  type: 'message.error',
  payload: { sessionId, message: 'Plugin hook error: ' + ... },
})
```

广播了 `message.error` 事件，但需要确认前端是否响应此事件重置生成状态。

#### B5. 外部系统对接先验证再编码 ✅

本次变更未引入新的外部系统对接。Pi Bridge Extension 在 `resources/` 目录，不在本次审查核心范围。

#### B6. Session 隔离 ✅

新增的 `bridge:event` 和 `bridge:intercept` 在 `server.ts` 中正确处理了 `sessionId`，路由正确。

#### B7. xyz-agent 数据目录隔离 ✅

`plugin-registry.ts` 新增 `resources/plugins` 和 `~/.xyz-agent/plugins/` 路径，未访问 pi 数据目录。

#### B8. Worktree 创建 ✅

不适用（基础设施规则）。

### 前端编码规范审查

#### B9. 禁止原生 HTML 表单元素 ✅

`AppStatusbar.vue` 无违规。

#### B10. 禁止 Emoji ✅

`AppStatusbar.vue` 无 emoji。

#### B11. 样式三层结构 ✅

`AppStatusbar.vue` 使用 Tailwind 类，无 `<style scoped>` 滥用。

#### B12. 禁止硬编码颜色 ✅

`AppStatusbar.vue` 使用 CSS 变量 `var(--success)`。

#### B13. 禁止魔数间距 ✅

使用 `w-[5px] h-[5px]` 的 arbitrary values 是必需的（5px 圆点大小），不属于魔数间距。其余使用标准 Tailwind scale。

#### B14. Border-radius 约束 ✅

`rounded-full` 用于圆形指示器，符合规范 §7.1。

#### B15. 行数上限 ✅

- `AppStatusbar.vue`: 103 行（模板 < 400，script setup < 300）
- 其他文件属于 sidecar，不适用前端行数上限

### 架构约定审查

#### B16. 共享类型 ✅

`plugin-types.ts` 扩展了 `Phase1AgentAPI` → `Phase2AgentAPI`，类型集中在 `shared/` 类型系统外（此为 runtime 内部类型）。虽然不在 `shared/src/` 中，但属于 plugin-service 模块的内部类型，设计上可接受。

#### B17. 适配层隔离 ✅

`event-adapter.ts` 新增 `onBridgeUIRequest` 回调，正确维护适配层模式。

---

## 问题分级汇总

### Must Fix（7 items）

| ID | 级别 | 文件 | 行 | 问题 |
|----|------|------|-----|------|
| MF1 | **bug** | `plugin-service.ts` | 40,43 | `sessionDataCache` 重复声明，readonly 和 private 冲突 |
| MF2 | **bug** | `plugin-service.ts` | 144 | `syncToolsToBridge()` 返回 `void`，但 callback 需要 `Promise<void>` |
| MF3 | **bug** | `plugin-service.ts` | 335 | error response 缺少 `result` 字段，违反 `BridgeToolExecuteResponse` 类型 |
| MF4 | **ts-error** | `plugin-sandbox.ts` | 52,62 | `Error.code` 在 TypeScript 类型中不存在（`NodeJS.ErrnoException` 才行） |
| MF5 | **violation** | `plugin-bootstrap.ts` | 208 | 违反「禁止 `any`」规范，`...args: any[]` 应改为 `unknown[]` |
| MF6 | **lint** | `plugin-service.ts` | 1,12,14,16,18,20,22 | 7 个未使用的 import（HookBlockedResult, SessionHandlers, ConfigHandlers 等） |
| MF7 | **lint** | `server.ts` | 659,660,673,682 | 4 个变量赋值后未使用（toolName, params, eventData x2） |

### Low Priority（12 items）

| ID | 级别 | 文件 | 行 | 问题 |
|----|------|------|-----|------|
| LO1 | style | `plugin-service.ts` | 197-275 | 大量 stub handler 使用 `_` 前缀参数，但最好加类型注释 |
| LO2 | warning | `session-service.ts` | 188-200 | Hook 错误路径 broadcast `message.error`，需要确认前端 handler 是否匹配 |
| LO3 | warning | `plugin-service.ts` | 226 | 私有 `sessionDataCache` 通过 `getCache: () => this.sessionDataCache` 暴露引用，可能被外部篡改 |
| LO4 | style | `server.ts` | 615-708 | `handleBridgeRequest` 方法过长（~90 行），建议拆分 |
| LO5 | style | `plugin-activator.ts` | 215-264 | `topologicalSort` 和 `detectCycle` 参数类型可更精确 |
| LO6 | style | `plugin-types.ts` | 390-395 | `HookType` 的定义建议补充 JSDoc |
| LO7 | warning | `plugin-bootstrap.ts` | 193-218 | `initSandbox` 使用 `// eslint-disable-next-line` 规避 lint 但未解决根本问题 |
| LO8 | info | `plugin-registry.ts` | 56-59 | `refresh()` 返回 `this.scan()` 的类型签名可链式调用 |
| LO9 | info | `resources/` files | multiple | Bridge 和 Goal plugin 大量使用 `any`，建议在后续 Phase 清理（但不在核心 src 范围） |

### Info（24 items）

ESLint `no-unused-vars` 在三类文件中的实例：
- `resources/pi/agent/extensions/bridge/index.ts`: 2 处未使用变量
- `resources/plugins/goal/`: 3 处未使用变量
- `src-electron/runtime/test/` 新测试文件: 含 `as any` 类型强制转换多处

---

## 结论

**verdict: fail**

自动化检查（ESLint + tsc）均未通过。ESLint 报告 49 个 error，TypeScript 编译报告 7 个生产代码错误 + 20+ 个测试代码错误。

核心问题集中在：
1. **类型安全**：`sessionDataCache` 重复声明（bug）、`BridgeToolExecuteResponse` 类型不匹配（bug）、`Error.code` 访问（ts-error）
2. **规范违反**：`plugin-bootstrap.ts:208` 使用 `any[]`（CLAUDE.md 第 5 条）
3. **代码清理**：`plugin-service.ts` 大量未使用 import 和变量（15 处）

共 **7 个 must-fix** 需要在合并前解决，其中 3 个为运行时 bug（MF1-MF3）。

---

*审查人: claude-code-agent（自动化 + AI 规范对比）*
*审查日期: 2026-05-28*
