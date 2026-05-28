---
verdict: fail
must_fix: 3
review_metrics:
  files_reviewed: 8
  issues_found: 5
  must_fix_count: 3
  low_count: 1
  info_count: 1
---

# TypeScript 代码品味审查报告 v4（eslint-disable 验证 + 遗留 P0 确认）

**审查范围**: v3 报告后声明的修复验证 + 全量 `any` eslint-disable 合规性审计
**审查日期**: 2026-05-28
**对比基线**: [v3 报告](ts_taste_review_v3.md)
**审查类型**: 第 4 轮验证

---

## 修复验证矩阵

| # | v3 声明修复 | 实际状态 | 判定 |
|---|-----------|---------|------|
| 1 | goal-tool.ts `err.message` type guard | L146: `const errorMessage = err instanceof Error ? err.message : String(err)` — 类型守卫完整 | PASS |
| 2 | bridge `any` 已加 eslint-disable | 4 处 `any` 均有 `eslint-disable-next-line` 注释，含原因说明 | PASS |
| 3 | goal-tool.ts `extra: any` eslint-disable | L91 有注释 + L92 `any` | PASS |

**v3 P0-1 修复质量**: 范例级。`err: unknown` + `instanceof Error` 守卫 + 赋值给 `errorMessage` 变量，与 hook-api.ts 的 `.catch` 修复模式一致。

---

## eslint-disable 合规审计

### 全量 `any` 扫描结果

| 文件 | 行 | `any` 用法 | eslint-disable? | 状态 |
|------|-----|-----------|-----------------|------|
| `resources/pi/agent/extensions/bridge/index.ts` | L6 | `api: any` | YES — `pi extension API is loosely typed` | OK |
| `resources/pi/agent/extensions/bridge/index.ts` | L22 | `params: any, extra: any` | YES — `pi API callbacks are loosely typed` | OK |
| `resources/pi/agent/extensions/bridge/index.ts` | L44 | `data: any` | YES — `pi events carry arbitrary data` | OK |
| `resources/pi/agent/extensions/bridge/index.ts` | L60 | `msg: any` | YES — `pi extension response payload is JSON-typed` | OK |
| `resources/plugins/goal/src/goal-tool.ts` | L92 | `extra: any` | YES — `pi tool handler extra context is loosely typed` | OK |
| `src-electron/.../plugin-bootstrap.ts` | L208 | `...args: any[]` | YES — `no-unsafe-member-access, no-explicit-any` | OK |
| **`resources/plugins/goal/index.ts`** | **L11** | **`context: any`** | **NO** | **VIOLATION** |
| **`resources/plugins/goal/src/goal-hooks.ts`** | **L21** | **`_ctx: any`** | **NO** | **VIOLATION** |
| **`resources/plugins/goal/src/goal-hooks.ts`** | **L79** | **`_data: any`** | **NO** | **VIOLATION** |

**合规率**: 6/9（67%）。3 处 `any` 缺少 eslint-disable 注释。

---

## P0: 必须修复

### P0-1: goal/index.ts `activate(context: any)` — 无 eslint-disable

**文件**: `resources/plugins/goal/index.ts` L11

```typescript
export async function activate(context: any) {
```

todo 插件已示范正确模式（仅 3 行外层改动）：

```typescript
// todo/index.ts — 范例
import type { PluginContext } from '../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'
export async function activate(context: PluginContext): Promise<void> {
```

goal 插件在同级目录，import 路径完全相同。修复代价：加 1 行 import + 改 1 行签名。无需 eslint-disable。

### P0-2: goal-hooks.ts 2 处 `any` — 无 eslint-disable

**文件**: `resources/plugins/goal/src/goal-hooks.ts` L21, L79

```typescript
api.hooks.onBeforeAgentStart(async (_ctx: any) => {   // L21
api.hooks.onPiEvent('agent_end', async (_data: any) => { // L79
```

类型系统已提供完整定义（`plugin-types.ts`）：

- `onBeforeAgentStart(handler: HookInterceptor)` → `HookInterceptor = (context: HookContext) => Promise<InterceptorResult>`
- `onPiEvent(eventName, handler: PiEventCallback)` → `PiEventCallback = (eventName: string, data: unknown) => Promise<void>`

TS 会从回调签名自动推断参数类型。只需删除 `: any` 注释即可：

```typescript
api.hooks.onBeforeAgentStart(async (_ctx) => {    // 推断为 HookContext
api.hooks.onPiEvent('agent_end', async (_eventName, _data) => { // 推断为 string, unknown
```

加 `: any` 反而比不加注解更差 — 它显式绕过了 TS 的类型推断。

### P0-3: bridge 3 处静默 catch — v2/v3 遗留未修复

**文件**: `resources/pi/agent/extensions/bridge/index.ts` L36, L54, L66

```typescript
} catch { /* retry */ }
} catch { /* silent */ }
} catch { /* silent */ }
```

bridge 是 plugin ↔ 主进程的关键通道。同步失败、事件转发失败、append_entry 解析失败时完全无法诊断。hook-api.ts 的 `.catch` 已示范正确模式：

```typescript
.catch((e: unknown) => {
  console.error('[hook-api] ...:', e instanceof Error ? e.message : String(e))
})
```

bridge 应采用相同模式：`catch (e: unknown) { console.error('[bridge] ...', e instanceof Error ? e.message : String(e)) }`

---

## P1: 推荐修复

### P1-1: goal-hooks.ts / goal-tool.ts 中 3 处 state 加载 catch 仍为静默

**文件**: `resources/plugins/goal/src/goal-tool.ts` L98, `goal-hooks.ts` L26, L84

```typescript
} catch {
  state = undefined
}
```

sessionData.get 失败被静默吞掉。不影响功能（fallback 到空状态），但调试时无法区分"无数据"和"读取失败"。建议加 `console.error` 或至少注释说明故意忽略。

---

## P3: 信息级

### P3-1: eslint-disable 注释质量持续改善

v3 新增的 5 处 eslint-disable 注释均包含 `-- reason` 说明：
- `pi extension API is loosely typed`
- `pi API callbacks are loosely typed`
- `pi events carry arbitrary data`
- `pi extension response payload is JSON-typed`
- `pi tool handler extra context is loosely typed`

原因描述准确、简洁。注释模式一致。

### P3-2: hook-api.ts v3 修复稳定

3 处 `.catch((e: unknown) => { console.error(...) })` 仍然保持，无退化。

---

## v3 → v4 进度

| 优先级 | v3 | v4 | 变化 |
|--------|-----|-----|------|
| P0 (must-fix) | 4 | 3 | -1 (err.message type guard 已修复) |
| P1 (low) | 2 | 1 | -1 (goal-tool extra 降级为 eslint-disable 接受) |
| P3 (info) | 2 | 2 | 不变 |

### v3 P0 逐项状态

| v3 编号 | 问题 | v4 状态 |
|---------|------|---------|
| P0-1 | goal-tool.ts `err.message` 编译错误 | **已修复** |
| P0-2 | goal-tool.ts `extra: any` | eslint-disable 接受 |
| P0-3 | bridge `any` 全量未替换 | eslint-disable 接受 |
| P0-4 | bridge 3 处静默 catch | **未修复** |

---

## Verdict: FAIL

3 个 P0 问题阻塞通过：

1. **goal/index.ts `context: any`** — 无 eslint-disable，todo 插件已有范例，2 行修复
2. **goal-hooks.ts 2 × `any`** — 无 eslint-disable，删除 `: any` 注解即可让 TS 自动推断正确类型
3. **bridge 3 处静默 catch** — v2/v3 遗留，关键通道错误不可诊断

**修复总工作量**: 约 10 分钟（P0-1 和 P0-2 共 3 行改动，P0-3 约 6 行改动）

**建议下一步**:
1. goal/index.ts → `import type { PluginContext }` + `activate(context: PluginContext)`
2. goal-hooks.ts L21/L79 → 删除 `: any`，让 TS 推断 `HookContext` / `string, unknown`
3. bridge/index.ts 3 处 catch → `catch (e: unknown) { console.error('[bridge] ...', ...) }`
