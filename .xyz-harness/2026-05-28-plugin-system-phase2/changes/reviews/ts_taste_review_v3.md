---
verdict: fail
must_fix: 4
review_metrics:
  files_reviewed: 4
  issues_found: 8
  must_fix_count: 4
  low_count: 2
  info_count: 2
---

# TypeScript 代码品味审查报告 v3（快速验证）

**审查范围**: v2 报告后声明的 4 项修复验证
**审查日期**: 2026-05-28
**对比基线**: [v2 报告](ts_taste_review_v2.md)
**审查类型**: 第 3 轮快速验证

---

## 修复验证矩阵

| # | 声明修复 | 实际状态 | 判定 |
|---|---------|---------|------|
| 1 | goal-tool.ts: `api: any` → `api: Phase2AgentAPI` | L23 `api: Phase2AgentAPI` 已修复，有 eslint-disable 注释 | PASS |
| 2 | goal-hooks.ts: `err: any` → `err: unknown`, unused vars prefixed with `_` | `err: any` 问题在 goal-tool.ts L143 已改为 `err: unknown`；goal-hooks.ts 的 `_ctx`/`_data` 前缀已添加 | PARTIAL |
| 3 | bridge/index.ts: removed unused import, added eslint-disable for necessary `any` | 未移除未使用 import（`PiExtensionAPI` 仍不在文件中）；eslint-disable 注释已添加到 4 处 `any`；但 `any` 本身未替换 | FAIL |
| 4 | hook-api.ts: replaced `.catch(() => {})` with console.error | L150/L154/L182 三处已改为 `.catch((e: unknown) => { console.error(...) })`，包含 `instanceof Error` 判断 | PASS |

---

## 遗留 P0 问题

### P0-1: goal-tool.ts `err: unknown` 后未加类型守卫

**文件**: `resources/plugins/goal/src/goal-tool.ts` L146

```typescript
} catch (err: unknown) {
  await api.sessionData.set('goal-state', state)
  throw new Error(`${err.message}\n\nInput: ${JSON.stringify(params, null, 2)}`)
```

`err` 已改为 `unknown`（v2 要求），但随后直接 `err.message` —— `unknown` 类型没有 `.message` 属性。这段代码**无法通过 TypeScript 编译**。

**修复**: `err instanceof Error ? err.message : String(err)`

### P0-2: goal-tool.ts `extra: any` 未修复

**文件**: `resources/plugins/goal/src/goal-tool.ts` L92

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi tool handler extra context is loosely typed
handler: async (params: GoalManagerParams, extra: any) => {
```

虽然添加了 eslint-disable 注释，但 `extra: any` 仍然存在。`extra` 实际用于 `extra?.toolCallId`（bridge 侧）和 `extra?.sessionId`（goal 插件不直接使用 `extra`，但 handler 签名需与 pi 的 tool handler 对齐）。

**判定**: 有注释说明原因，降级为 P1。但如果 `extra` 在 goal-tool.ts 中根本未使用（grep 确认 `extra` 在 handler body 中未出现），可以改用 `_extra: unknown`。

### P0-3: bridge/index.ts `any` 全量未替换

**文件**: `resources/pi/agent/extensions/bridge/index.ts`

4 处 `any` 仍然存在，只是加了 eslint-disable 注释：

| 行 | 当前 | eslint-disable |
|----|------|---------------|
| L6 | `activate(api: any)` | 有 |
| L22 | `(params: any, extra: any)` | 有 |
| L44 | `(data: any)` | 有 |
| L60 | `(msg: any)` | 有 |

v2 P0-2 要求 "bridge 替换 `any`"，实际只加了 eslint-disable。bridge 是 plugin ↔ 主进程的关键通道，`any` 意味着所有拼写错误不会在编译期暴露。

**补充发现**: L22 的 handler 中使用了 `extra?.toolCallId` 和 `extra?.sessionId`，但 `extra: any` 意味着拼写成 `extra?.toolCallIdX` 也不会报错。

**修复**: 至少将 `params: any` 和 `extra: any` 改为 `params: unknown, extra: Record<string, unknown> | undefined`，内部通过可选链访问。`data: any` 和 `msg: any` 同理。

### P0-4: bridge 三处静默 catch 未修复

**文件**: `resources/pi/agent/extensions/bridge/index.ts` L36, L54, L66

```typescript
} catch { /* retry */ }
} catch { /* silent */ }
} catch { /* silent */ }
```

v2 P0-6 明确要求添加 `console.error`。3 处仍为静默 catch，无任何修改。

---

## 遗留 P1 问题

### P1-1: goal-hooks.ts `_ctx: any` / `_data: any` 未替换类型

**文件**: `resources/plugins/goal/src/goal-hooks.ts` L21, L79

```typescript
async (_ctx: any) => {   // L21
async (_data: any) => {  // L79
```

前缀 `_` 表示未使用（v2 建议的修复之一），但类型仍是 `any`。应改为 `_ctx: unknown` / `_data: unknown`，因为 goal-hooks 内部不使用这些参数。

### P1-2: goal-tool.ts `extra: any` 有注释但可改进

见 P0-2 分析。goal-tool handler 中未使用 `extra` 参数，可改为 `_extra: unknown`。

---

## 遗留 P3 信息级

### P3-1: eslint-disable 注释质量良好

所有 `any` 保留处都添加了 `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>` 注释，说明了保留原因（pi extension API loosely typed、pi API callbacks loosely typed 等）。注释质量比 v2 提升。

### P3-2: hook-api.ts 修复质量高

三处 `.catch` 改为：
```typescript
.catch((e: unknown) => {
  console.error('[hook-api] ...:', e instanceof Error ? e.message : String(e))
})
```
正确使用 `unknown` + `instanceof Error` 类型守卫 + 语义化错误前缀。这是范例级修复。

---

## v2 → v3 进度

| 优先级 | v2 | v3 | 变化 |
|--------|-----|-----|------|
| P0 (must-fix) | 6 | 4 | -2 (api 类型修复 ×1, hook-api 修复 ×1) |
| P1 (low) | 5 | 2 | -3 |
| P3 (info) | 3 | 2 | -1 |

### v2 P0 逐项状态

| v2 编号 | 问题 | v3 状态 |
|---------|------|--------|
| P0-1 | goal 插件 `any` | api 参数已修复；`err: unknown` 后 `.message` 编译错误（新 P0） |
| P0-2 | bridge `any` | 仅加 eslint-disable，类型未替换 |
| P0-3 | bootstrap `any[]` | **未验证**（不在本次修复范围） |
| P0-4 | todo-tool loadState | **未验证**（不在本次修复范围） |
| P0-5 | goal-tool err 处理 | `err: unknown` 已修复，但 `.message` 编译错误 |
| P0-6 | bridge 静默 catch | 未修复 |

---

## Verdict: FAIL

4 个 P0 问题阻塞通过：
1. goal-tool.ts L146 `err.message` 在 `unknown` 类型上不合法（编译错误）
2. bridge `any` 仅加注释未替换类型
3. bridge 三处静默 catch 未添加 console.error
4. v2 P0-3/P0-4 未在本次修复范围，需确认是否已修复

**建议下一步**:
1. 立即修复 goal-tool.ts `err.message` → 类型守卫（1 行）
2. bridge `any` → `unknown` + 可选链访问（10 分钟）
3. bridge catch 添加 `console.error`（3 行）
4. 验证 bootstrap `any[]` 和 todo-tool loadState
