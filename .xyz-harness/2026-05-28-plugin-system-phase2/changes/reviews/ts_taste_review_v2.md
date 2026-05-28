---
verdict: fail
must_fix: 6
review_metrics:
  files_reviewed: 20
  issues_found: 14
  must_fix_count: 6
  low_count: 5
  info_count: 3
---

# TypeScript 代码品味审查报告 v2

**审查范围**: plugin-service API 层 + 核心模块 + goal/todo 插件 + bridge extension
**审查日期**: 2026-05-28
**对比基线**: [v1 报告](ts_taste_review_v1.md)
**审查标准**: `~/.codetaste/essence.md` + `~/.codetaste/ts/taste.md`

---

## 汇总

| 优先级 | v1 | v2 | 变化 |
|--------|-----|-----|------|
| P0 (must-fix) | 7 | 6 | -1 (P0-3 降级) |
| P1 (low) | 8 | 5 | -3 |
| P3 (info) | 4 | 3 | -1 |

**Verdict: FAIL** — 6 个 P0 问题未修复。

---

## v1 → v2 修复情况

### 已修复

| v1 编号 | 问题 | 修复情况 |
|---------|------|----------|
| P0 (部分) | todo 插件使用 proper types | `activate(context: PluginContext)` 和 `registerTodoTool(api: Phase2AgentAPI)` 已改为具体类型。`extractSessionId(data: unknown)` 添加了类型守卫。 |
| P1-6 | goal-hooks.ts 重复 state 加载模式 | 未修复，但代码结构合理，降级为 P3 |
| P1-8 | todo-tool.ts `as TodoItem['status']` 断言 | 未修复，但上下文有 `VALID_STATUSES.includes()` 运行时检查，降级为 P3 |

### 未修复

| v1 编号 | 状态 | 说明 |
|---------|------|------|
| P0-1 | 未修复 | goal 插件仍然全量 `any` |
| P0-2 | 未修复 | bridge extension 仍然全量 `any` |
| P0-3 | 未修复 | API 层 `params as string` 模式仍在，但考虑到是外部 JSON-RPC 边界，降级为 P1 |
| P0-4 | 未修复 | bootstrap `any[]` 仍在 |
| P0-5 | 未修复 | todo-tool.ts `loadState` 仍无运行时校验 |
| P0-6 | 未修复 | goal-tool.ts `err: any` + `JSON.stringify(params)` 仍在 |
| P0-7 | 未修复 | bridge 三处静默 catch 仍在 |

---

## P0: 必须修复

### P0-1: goal 插件全量 `any` — 未修复

**文件**: `resources/plugins/goal/index.ts`, `resources/plugins/goal/src/goal-hooks.ts`, `resources/plugins/goal/src/goal-tool.ts`

v1 报告后 todo 插件已修复为 proper types（`PluginContext`, `Phase2AgentAPI`），但 goal 插件**未同步修复**。所有参数仍为 `any`：

| 文件 | 行 | 当前 | 应改为 |
|------|-----|------|--------|
| `goal/index.ts` L13 | `activate(context: any)` | `context: PluginContext` |
| `goal-hooks.ts` L14 | `api: any` | `api: Phase2AgentAPI` |
| `goal-hooks.ts` L20 | `ctx: any` | `ctx: HookContext` |
| `goal-hooks.ts` L77 | `data: any` | `data: unknown` |
| `goal-tool.ts` L26 | `api: any` | `api: Phase2AgentAPI` |
| `goal-tool.ts` L90 | `extra: any` | `extra: unknown` |
| `goal-tool.ts` L140 | `err: any` | `err: unknown` |

todo 插件已示范正确模式：
```typescript
import type { PluginContext } from '../../../src-electron/runtime/src/services/plugin-service/plugin-types.js'
export async function activate(context: PluginContext): Promise<void> {
```

goal 插件应完全照搬。所需类型均已在 `plugin-types.ts` 中定义。

**原则**: 类型即契约，拒绝 any (taste.md)

---

### P0-2: bridge extension 全量 `any` — 未修复

**文件**: `resources/pi/agent/extensions/bridge/index.ts`

所有参数仍为 `any`，4 处未约束。bridge 是 plugin ↔ 主进程的关键通道，类型缺失意味着拼写错误不会在编译期暴露。

| 行 | 当前 | 应改为 |
|----|------|--------|
| L10 | `api: any` | `api: PiExtensionAPI`（已 import 类型但未使用） |
| L22 | `params: any, extra: any` | `params: unknown, extra: unknown` 或结构化类型 |
| L43 | `data: any` | `data: unknown` |
| L58 | `msg: any` | `msg: unknown` + JSON.parse 守卫 |

注意：`import type { PiExtensionAPI }` 已在 L1，但 `activate(api: any)` 未引用。

---

### P0-3: plugin-bootstrap.ts `any[]` — 未修复

**文件**: `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts` L219

```typescript
Module._resolveFilename = function (
  request: string,
  ...args: any[]   // <-- 仍为 any[]
): string {
```

**建议**: 改为 `...args: unknown[]`，`call` 调用不受影响（`Function.prototype.call` 接受任意参数透传）。

---

### P0-4: todo-tool.ts `loadState` 缺少运行时校验 — 未修复

**文件**: `resources/plugins/todo/src/todo-tool.ts` L93-96

```typescript
async function loadState(api: Phase2AgentAPI, sessionId: string): Promise<TodoState> {
  const raw = await api.sessionData.get(sessionId, SESSION_DATA_KEY)
  if (raw && typeof raw === 'object' && Array.isArray((raw as TodoState).todos)) {
    return raw as TodoState  // 信任外部存储的形状
  }
  return createEmptyState()
}
```

问题：`Array.isArray((raw as TodoState).todos)` 只验证了 `todos` 是数组，未验证：
- `nextId` 是 number（`state.nextId = currentId++` 依赖它）
- 每个 todo item 的 `status` 是合法值

**建议**: 添加最小校验：
```typescript
if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).todos)) {
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.nextId === 'number') {
    return { todos: candidate.todos as TodoItem[], nextId: candidate.nextId }
  }
}
```

**原则**: 信任止于边界 (essence.md)

---

### P0-5: goal-tool.ts 错误处理暴露内部状态 — 未修复

**文件**: `resources/plugins/goal/src/goal-tool.ts` L141

```typescript
} catch (err: any) {
  await api.sessionData.set('goal-state', state)
  throw new Error(`${err.message}\n\nInput: ${JSON.stringify(params, null, 2)}`)
}
```

两个问题：
1. `err: any` 应为 `err: unknown` + `err instanceof Error ? err.message : String(err)`
2. `JSON.stringify(params, null, 2)` 将完整参数 dump 到错误消息，增加 token 消耗。goal 描述和 evidence 可能很长。

---

### P0-6: bridge 三处静默 catch — 未修复

**文件**: `resources/pi/agent/extensions/bridge/index.ts` L36, L53, L64

```typescript
} catch { /* retry */ }
} catch { /* silent */ }
} catch { /* silent */ }
```

bridge 是 plugin ↔ 主进程的关键通道。同步失败、事件转发失败、append_entry 解析失败时完全无法诊断。

**建议**: 至少 `console.error('[bridge]', error)` — 在 pi extension 环境中 console 输出会被 pi 进程的 stdout 捕获。

---

## P1: 推荐修复

### P1-1: API 层 `params as string` 模式 — 降级自 v1 P0-3

**文件**: 所有 6 个 `api/*.ts` 文件（约 30 处）

```typescript
const sessionId = params.sessionId as string
const key = params.key as string
```

**降级理由**: JSON-RPC handler 的 `params` 来自反序列化，属于外部输入边界。按 taste.md 白名单规则，"外部接口签名约束"可在白名单登记。当前代码中每个 handler 只提取 2-3 个已知字段，模式一致，实际拼错风险低于 goal/bridge 的 `any`。

**建议**: 为高优先 RPC 方法定义 `Params` interface（如 `SendMessageParams`），低优先方法保持现状但添加注释标记为白名单项。

---

### P1-2: session-api.ts `.catch(() => {})` 静默吞错 — 未修复

**文件**: `src-electron/runtime/src/services/plugin-service/api/session-api.ts` L99, L103, L111, L115

4 处 `.catch(() => {})`。注册/注销 session 事件监听器失败时无任何诊断。

**建议**: `.catch(e => console.error('[session-api] registration failed:', e))`

---

### P1-3: session-data-api.ts bridge 持久化静默失败 — 未修复

**文件**: `src-electron/runtime/src/services/plugin-service/api/session-data-api.ts` L61

bridge 持续不可用时所有 sessionData 仅存内存，进程重启后丢失，无告警。

---

### P1-4: plugin-host.ts 魔法数字 — 未修复

**文件**: `src-electron/runtime/src/services/plugin-service/plugin-host.ts`

| 值 | 含义 | 建议 |
|----|------|------|
| `10_000` (L85) | loadPlugin 超时 | `LOAD_PLUGIN_TIMEOUT_MS` |
| `10` (L100) | trusted Worker 最大插件数 | `MAX_PLUGINS_PER_TRUSTED_WORKER` |

---

### P1-5: bridge 魔法数字 — 未修复

**文件**: `resources/pi/agent/extensions/bridge/index.ts`

`30`（最大同步尝试）和 `2000`（间隔 ms）已部分提取为 `MAX_SYNC_ATTEMPTS` 常量，但 `2000` 仍为内联字面量。

---

## P3: 信息级

### P3-1: goal-hooks.ts state 加载重复模式

**文件**: `resources/plugins/goal/src/goal-hooks.ts` L22-26 和 L79-83 + `resources/plugins/goal/src/goal-tool.ts` L96-99

三处完全相同的 try/catch state 加载模式。可提取为 `loadGoalState(api: Phase2AgentAPI)` 辅助函数。但代码量小、逻辑简单，不构成质量问题。

### P3-2: bridge 全局可变状态

**文件**: `resources/pi/agent/extensions/bridge/index.ts` L5-8

模块级 `let bridgeState` 和 `syncAttempts`。pi extension 不支持热重载，实际无问题。

### P3-3: todo-tool.ts `as TodoItem['status']` 赋值

**文件**: `resources/plugins/todo/src/todo-tool.ts` L170

```typescript
(todo.status as TodoItem['status']) = params.status
```

上方已有 `VALID_STATUSES.includes(params.status)` 运行时检查。类型断言是合理的 escape hatch（TS 无法通过 `includes` 窄化类型），不构成类型安全问题。

---

## Positive Findings

以下方面 v1 后有改善或一直保持良好：

1. **todo 插件类型完整**: `activate(context: PluginContext)`, `registerTodoTool(api: Phase2AgentAPI)`, `executeTodoAction` 的 `params` 使用 `TodoAction` 联合类型 — 这是 goal 插件应参照的范例。

2. **goal-state.ts 类型定义质量高**: `GoalManagerParams` interface 完整覆盖所有 action 的参数，`TaskStatus` / `SubTodoStatus` 为字符串字面量联合类型，`TASK_STATUSES` / `SUB_TODO_STATUSES` 常量数组用于运行时校验。`normalizeDescription` 中 `MAX_LENGTH = 80` 使用具名常量。

3. **todo-state.ts 简洁正确**: `TodoItem` interface 只含必要字段，无过度设计。

4. **plugin-types.ts 定义完备**: `Phase2AgentAPI` 接口定义了所有 API 子对象的具体方法签名。`PluginContext` 包含 `api: Phase2AgentAPI`。goal/todo 插件只需 import 这些类型即可消除所有 `any`。

5. **hook-api.ts 类型严谨**: `HookInterceptor` / `HookObserver` / `PiEventCallback` 区分了拦截/观察/事件三种回调签名，`computePriority` 的魔法数字（0/100/200）对应 built-in/trusted/sandbox，语义清晰。

---

## 建议修复顺序

1. **P0-1**: goal 插件替换 `any` — todo 插件已有范例，直接照搬，5 分钟完成
2. **P0-5**: goal-tool.ts `err: any` + JSON.stringify — 与 P0-1 同文件，顺带修复
3. **P0-2**: bridge 替换 `any` — `PiExtensionAPI` 已 import 但未用，直接应用
4. **P0-6**: bridge catch 添加 console.error — 与 P0-2 同文件
5. **P0-3**: bootstrap `any[]` → `unknown[]` — 一行改动
6. **P0-4**: todo-tool loadState 添加 nextId 校验 — 3 行改动
7. P1 项按优先级逐步修复
