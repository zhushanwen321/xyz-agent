---
verdict: fail
must_fix: 7
review_metrics:
  files_reviewed: 20
  issues_found: 19
  must_fix_count: 7
  low_count: 8
  info_count: 4
---

# TypeScript 代码品味审查报告

**审查范围**: plugin-service API 层 + 核心模块 + goal/todo 插件 + bridge extension
**审查日期**: 2026-05-28
**审查标准**: `~/.codetaste/essence.md` + `~/.codetaste/ts/taste.md`

---

## 汇总

| 优先级 | 数量 | 说明 |
|--------|------|------|
| P0 (must-fix) | 7 | 类型安全违反、`any` 滥用 |
| P1 (low) | 8 | 静默 catch、魔法数字、重复模式 |
| P3 (info) | 4 | 结构/命名细节 |

**Verdict: FAIL** — 7 个 P0 问题需修复后方可通过。

---

## P0: 必须修复

### P0-1: goal 插件大面积使用 `any` 类型

**文件**: `resources/plugins/goal/index.ts` (L11), `resources/plugins/goal/src/goal-hooks.ts` (L14, L20, L77), `resources/plugins/goal/src/goal-tool.ts` (L26, L90, L140)

**问题**: 12 处 `any` 类型使用，包括函数参数、变量声明、catch 参数。`activate(context: any)` 丢失了所有类型信息——`context` 已有完整的 `PluginContext` 类型定义（`plugin-types.ts`），`api` 已有 `Phase2AgentAPI` 类型。

| 位置 | 当前 | 应改为 |
|------|------|--------|
| `goal/index.ts` L11 | `context: any` | `context: PluginContext` |
| `goal-hooks.ts` L14 | `api: any` | `api: Phase2AgentAPI` |
| `goal-hooks.ts` L20 | `ctx: any` | `ctx: HookContext` |
| `goal-hooks.ts` L77 | `data: any` | `data: unknown` |
| `goal-tool.ts` L26 | `api: any` | `api: Phase2AgentAPI` |
| `goal-tool.ts` L90 | `extra: any` | `extra: unknown` |
| `goal-tool.ts` L140 | `err: any` | `err: unknown` + `err instanceof Error ? err.message : String(err)` |

**原则**: 类型即契约，拒绝 any (taste.md)

---

### P0-2: bridge extension 全量 `any`

**文件**: `resources/pi/agent/extensions/bridge/index.ts` (L7, L22, L43, L58)

**问题**: 5 处 `any`。`activate(api: any)` 使用了 pi 的 `PiExtensionAPI` 但未引用。`registerTool` 回调 `(params: any, extra: any)` 缺少类型约束。事件回调 `(data: any)` 应为 `unknown`。

| 位置 | 当前 | 应改为 |
|------|------|--------|
| L7 | `api: any` | `api: PiExtensionAPI` |
| L22 | `params: any, extra: any` | 结构化类型或 `unknown` |
| L43 | `data: any` | `data: unknown` |
| L58 | `msg: any` | `msg: unknown` + 类型守卫 |

**原则**: 类型即契约 (essence.md: "生成的代码中不允许出现未经约束的 `any`")

---

### P0-3: API 层 `params as string` 模式性绕过类型检查

**文件**: 所有 6 个 `api/*.ts` 文件

**问题**: RPC handler 接收的 `params: Record<string, unknown>`，在 handler 内部全部用 `params.xxx as string` 提取字段。这是 `Record<string, unknown>` + `as` 的模式性违规——字段名拼错不报编译错误。

**涉及文件** (约 30 处):
- `agent-api.ts` L36, L49
- `config-api.ts` L30-31, L36, L41-42
- `session-api.ts` L34, L43-45
- `session-data-api.ts` L39-40, L47-48, L67-68, L80
- `ui-api.ts` L37-39, L44-46, L51-53, L58-60, L65-67
- `workspace-api.ts` L39

**建议**: 为每种 RPC 方法定义 `Params` interface，在 handler 入口处做类型断言：

```typescript
interface SetModelParams { pluginId: string; model: string }

rpcServer.registerMethod('plugin.agent.setModel', async (params) => {
  const { model } = params as unknown as SetModelParams
  await deps.setModel(model)
})
```

**白名单考量**: RPC handler 的 `params` 来源是 JSON-RPC 反序列化，属于外部输入边界。按 taste.md 白名单规则，此处可在白名单登记（外部接口签名约束），但每个方法应定义 `Params` 类型并在入口断言。

**原则**: `Record<string, unknown>` + `as` 断言是 `any` 的变体 (taste.md "类型即契约")

---

### P0-4: plugin-bootstrap.ts `any[]` 用于 Node.js 内部 API monkey-patch

**文件**: `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts` L208

```typescript
Module._resolveFilename = function (
  request: string,
  ...args: any[]   // <-- here
): string {
```

**建议**: 按 taste.md "Node.js 内部 API 用 `as unknown as` 局部断言"，这里可以用 `...args: unknown[]` 并在 `call` 内部处理，或者至少用 `string[]` 因为 Module._resolveFilename 的后续参数都是 string。

---

### P0-5: todo-tool.ts 不安全的类型转换 `as TodoItem['status']`

**文件**: `resources/plugins/todo/src/todo-tool.ts`

**问题**: `loadState` 中 `raw as TodoState` 未做运行时校验。JSON 反序列化后的数据直接断言为 `TodoState`，如果 sessionData 中存储了旧格式数据，运行时会 silently 产生不一致。

```typescript
// L94-97
if (raw && typeof raw === 'object' && Array.isArray((raw as TodoState).todos)) {
  return raw as TodoState  // 信任外部存储的形状
}
```

**建议**: 至少验证 `nextId` 是 number 且每个 todo item 的 status 是合法值。或使用 zod schema 验证。

**原则**: 信任止于边界 (essence.md)

---

### P0-6: goal-tool.ts 错误处理中暴露内部状态给 LLM

**文件**: `resources/plugins/goal/src/goal-tool.ts` L141

```typescript
catch (err: any) {
  await api.sessionData.set('goal-state', state)
  throw new Error(`${err.message}\n\nInput: ${JSON.stringify(params, null, 2)}`)
}
```

**问题**:
1. `err: any` 应为 `err: unknown`
2. `JSON.stringify(params, null, 2)` 会把完整参数 dump 到错误消息中，可能包含敏感信息（goal 描述、evidence 等），且增加 token 消耗

**建议**: 改为 `err instanceof Error ? err.message : String(err)`，移除 Input dump。

---

### P0-7: bridge extension 三处静默 catch 无任何日志

**文件**: `resources/pi/agent/extensions/bridge/index.ts` L36, L53, L64

```typescript
} catch { /* retry */ }
} catch { /* silent */ }
} catch { /* silent */ }
```

**问题**: 三个 catch 块完全吞掉错误，无 `console.error` 或任何日志。bridge 是 plugin ↔ 主进程的关键通道，同步失败、事件转发失败、append_entry 解析失败时完全无法诊断。

**建议**: 至少 `console.error('[bridge]', err)`，或者记录到某个状态变量供诊断。

**原则**: 反馈不断裂 (essence.md: "底层错误至少记录日志——不允许完全吞掉错误")

---

## P1: 推荐修复

### P1-1: session-api.ts `.catch(() => {})` 模式性静默吞错

**文件**: `src-electron/runtime/src/services/plugin-service/api/session-api.ts` L99, L103, L111, L115

**问题**: 4 处 `.catch(() => {})` — 注册/注销 session 事件监听器的 RPC 失败时完全吞掉错误。如果注册失败，插件不会收到 session 事件，但开发者无法诊断原因。

**建议**: `.catch(e => console.error('[session-api] registration failed:', e))`

---

### P1-2: session-data-api.ts bridge 持久化静默失败

**文件**: `src-electron/runtime/src/services/plugin-service/api/session-data-api.ts` L61

```typescript
deps.appendEntry(sessionId, key, value).catch(() => {
  // bridge 未就绪时静默失败（缓存已更新）
})
```

**问题**: 注释说明了意图，但生产环境中如果 bridge 持续不可用，所有 sessionData 只存在于内存缓存，进程重启后丢失，且无任何告警。

**建议**: 计数失败次数，超过阈值时 `console.warn`。

---

### P1-3: workspace-api.ts 初始化失败静默保持空值

**文件**: `src-electron/runtime/src/services/plugin-service/api/workspace-api.ts` L79

```typescript
]).catch(() => {
  // 初始化失败保持空值
})
```

**问题**: rootPath/name 获取失败时返回空字符串，插件读取 `api.workspace.rootPath` 得到 `""` 而非报错，可能导致插件在错误目录下操作。

**建议**: 考虑将 getter 改为 `Promise<string>` 或在缓存为空时 throw。

---

### P1-4: plugin-host.ts 魔法数字

**文件**: `src-electron/runtime/src/services/plugin-service/plugin-host.ts`

| 位置 | 值 | 含义 | 建议 |
|------|-----|------|------|
| L85 | `10_000` | loadPlugin 超时 ms | `LOAD_PLUGIN_TIMEOUT_MS = 10_000` |
| L100 | `10` | trusted Worker 最大插件数 | `MAX_PLUGINS_PER_TRUSTED_WORKER = 10` |
| L149 | `30_000` | 内存监控间隔 | 已有参数默认值，但调用处可能用无参 |

**原则**: 语义化命名 (taste.md)

---

### P1-5: bridge extension 魔法数字

**文件**: `resources/pi/agent/extensions/bridge/index.ts`

| 位置 | 值 | 含义 | 建议 |
|------|-----|------|------|
| L4 | `30` | 最大同步尝试次数 | `MAX_SYNC_ATTEMPTS = 30` |
| L37 | `2000` | 同步间隔 ms | `SYNC_INTERVAL_MS = 2000` |

---

### P1-6: goal-hooks.ts 重复的 state 加载模式

**文件**: `resources/plugins/goal/src/goal-hooks.ts` L22-26 和 L79-83

**问题**: 两处完全相同的 state 加载 try/catch 模式（`sessionData.get('goal-state')` → catch → undefined）。同样的模式在 `goal-tool.ts` L96-99 也出现了。

**建议**: 提取为辅助函数 `loadGoalState(api: Phase2AgentAPI): Promise<GoalState | undefined>`

---

### P1-7: API 层 Worker 侧代理对象重复的 `then(v => (v as T) ?? [])` 模式

**文件**: 所有 6 个 `api/*.ts` 文件

**问题**: `rpcClient.request(...).then(v => (v as SomeType) ?? fallback)` 在 6 个文件中反复出现约 20 次。这是一个可提取为 `typedRequest<T>(method, params, fallback): Promise<T>` 的通用模式。

---

### P1-8: todo-tool.ts update handler 中 `as TodoItem['status']` 断言

**文件**: `resources/plugins/todo/src/todo-tool.ts` L165

```typescript
(todo.status as TodoItem['status']) = params.status
```

**问题**: 虽然 L154 已检查 `VALID_STATUSES.includes(params.status)`，但用 `as` 绕过了类型系统。应在检查后用类型守卫或直接赋值。

---

## P3: 信息级

### P3-1: plugin-host.ts `getWorkerHandle` 线性扫描

**文件**: `src-electron/runtime/src/services/plugin-service/plugin-host.ts` L130-140

**问题**: 按 `pluginId` 查找 Worker 使用 `for...of` 遍历所有 handle 的 `pluginIds` 数组。当 Worker 数量多时效率低。可考虑维护一个 `pluginToWorker: Map<string, string>` 反向索引。

**优先级**: 低 — Phase 2 中 Worker 数量很少，不影响功能。

---

### P3-2: bridge/index.ts 全局可变状态

**文件**: `resources/pi/agent/extensions/bridge/index.ts` L6-8

```typescript
let bridgeState: 'Disconnected' | 'Syncing' | 'Ready' = 'Disconnected'
let syncAttempts = 0
```

**问题**: 模块级全局变量，如果 activate 被多次调用（热重载场景），状态可能残留。应在 activate 内部初始化。

---

### P3-3: session-api.ts 模块级 `sessionCounter` 可能冲突

**文件**: `src-electron/runtime/src/services/plugin-service/api/session-api.ts` L50

```typescript
let sessionCounter = 0
```

**问题**: 模块级计数器在 Worker 进程中全局递增，不会冲突，但如果 `createSessionApi` 被多次调用（多插件），ID 格式 `session_create_${pluginId}_${counter}` 足够唯一，实际无问题。

---

### P3-4: goal-state.ts `formatTaskList` 中 emoji 作为状态图标

**文件**: `resources/plugins/goal/src/goal-state.ts` L96-107

**问题**: 使用 `●`, `☐`, `✓`, `✗`, `○` Unicode 字符作为任务状态图标。这些是 Unicode 符号而非 emoji，跨平台渲染基本一致，在 tool 返回的文本中使用合理。但如果要在 UI 中显示，应改用图标组件。

**优先级**: 低 — 当前仅在 tool 返回文本中使用，无 UI 渲染问题。

---

## 跨文件重复

### 重复 1: state 加载 try/catch 模式

出现在 3 处：
- `goal-hooks.ts` L22-26
- `goal-hooks.ts` L79-83
- `goal-tool.ts` L96-99

模式完全相同：
```typescript
try {
  state = (await api.sessionData.get('goal-state')) as GoalState | undefined
} catch {
  state = undefined
}
```

**建议**: 提取为 `loadGoalState(api)` 工具函数。

### 重复 2: RPC handler 中 `params.xxx as string` 提取模式

约 30 处，分布在 6 个 API 文件中。每个 handler 的模式相同：从 `Record<string, unknown>` 提取字段。见 P0-3。

---

## 建议修复顺序

1. **P0-1 + P0-2**: 替换 goal 插件和 bridge 的 `any` 为具体类型（最简单，改动最小）
2. **P0-4**: 替换 bootstrap 中的 `any[]`
3. **P0-5**: todo-tool.ts 添加 loadState 运行时校验
4. **P0-6**: goal-tool.ts 错误处理修正
5. **P0-7**: bridge catch 添加 console.error
6. **P0-3**: API 层 params 类型断言（涉及 6 个文件，改动面最大，建议最后做）
7. **P1 项**: 按优先级逐步修复
