---
verdict: pass
must_fix: 3
reviewed_at: 2026-05-28
reviewed_by: ai-coder
target: src-electron/runtime/src/services/plugin-service/
total_files: 10 .ts files + 1 .js mock
total_lines: 1545 (excluding .js)
---

# TypeScript 代码品味审查报告

## 审查范围

目录 `src-electron/runtime/src/services/plugin-service/` 下所有 `.ts` 文件（10 个），含 `.js` mock 文件（1 个）。

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 7 | 模块导出入口 |
| `plugin-types.ts` | 201 | 内部类型定义 |
| `plugin-registry.ts` | 117 | 插件扫描与注册 |
| `plugin-activator.ts` | 260 | 懒激活状态机 |
| `plugin-bootstrap.ts` | 170 | Worker 入口脚本 |
| `plugin-host.ts` | 215 | Worker Thread 池管理 |
| `plugin-rpc-server.ts` | 93 | 主线程 RPC 服务端 |
| `plugin-rpc-client.ts` | 133 | Worker 侧 RPC 客户端 |
| `plugin-service.ts` | 151 | 服务编排（门面） |
| `plugin-storage.ts` | 198 | KV 持久化存储 |
| `plugin-bootstrap.js` | ~20 | Mock Worker（测试用） |

## 自动化 Lint 结果

```text
✖ 16 problems (2 errors, 14 warnings)
```

- 2 errors: `@typescript-eslint/no-unused-vars`（1 个）、`@typescript-eslint/no-require-imports`（1 个，在 `.js` 中）
- 14 warnings: 3 × `taste/no-silent-catch`、3 × `no-magic-numbers`(10/10000/30000 on host)、5 × `no-magic-numbers`(storage constants)、1 × `unused eslint-disable`、1 × `no-magic-numbers`(JSON.indent 2)、1 × `no-magic-numbers`(hash slice 12)

---

## P0 — 原则违反（必须修复）

### 1. `plugin-activator.ts` — 未使用参数

| 位置 | 文件 | 行 |
|------|------|---|
| `_rpcServer` 形参定义后从未使用 | `plugin-activator.ts` | L93 |

```typescript
async activatePlugin(
  pluginId: string,
  event: ActivationEvent,
  host: PluginHost,
  _rpcServer: PluginRpcServer,  // <-- 未使用，函数内无一次引用
): Promise<void> {
```

**建议**：删除 `_rpcServer` 参数，或如果 Phase 2 需要则用 `@ts-ignore` + 注释说明。当前代码中该参数完全未引用，属于死代码。

**严重程度**: 高 — ESLint error，阻塞 CI（`--max-warnings=0` 会失败）。

---

### 2. `plugin-bootstrap.ts` — deactivate 错误被静默吞掉

| 位置 | 文件 | 行 |
|------|------|---|
| 插件 deactivate 异常仅 console.error，仍发送 deactivated 成功 | `plugin-bootstrap.ts` | L73-L78 |

```typescript
case 'deactivate': {
  const mod = loadedModules.get(msg.pluginId)
  if (mod?.deactivate) {
    try {
      await mod.deactivate()
    } catch (e: unknown) {
      console.error(`[bootstrap] deactivate error for ${msg.pluginId}:`, e)
    }
  }
  parentPort!.postMessage({ type: 'deactivated', pluginId: msg.pluginId })
  // ↑ 即使 deactivate 抛异常，仍然报告成功
}
```

**问题**：插件 deactivate 抛异常后，主线程收到的仍是 `deactivated` 消息。`PluginActivator.handleWorkerReply()` 会认为停用成功（resolve(true)），导致错误被完全掩盖。

**建议**：
```typescript
try {
  await mod.deactivate()
  parentPort!.postMessage({ type: 'deactivated', pluginId: msg.pluginId })
} catch (e) {
  parentPort!.postMessage({ type: 'error', pluginId: msg.pluginId, error: String(e) })
}
```

**严重程度**: 高 — 违反"错误必须重置状态"原则（项目规则 §3），deactivate 失败应当传播。

---

### 3. `plugin-storage.ts` — 空 catch 块吞错误

| 位置 | 文件 | 行 |
|------|------|---|
| 文件读失败静默吞掉 | `plugin-storage.ts` | L138 |

```typescript
try {
  const raw = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  // ...
} catch {
  // 文件不存在或解析失败 → 空 Map    ← 连 debug log 都没有
}
```

**问题**：虽然文件不存在是正常场景（首次使用），但 JSON 解析失败也进了同一个 catch，没有任何日志。JSON 损坏提示 IO 错误或并发写入冲突，应当记录。

**建议**：区分两种场景。ENOENT 可静默，解析错误需 log。

---

## P1 — 偏好（推荐修复）

### 4. `plugin-service.ts` — 三处 `as unknown as ActivatorHost` 类型桥接

| 文件 | 行 | 模式 |
|------|----|------|
| `plugin-service.ts` | L58, L80, L88 | `this.host as unknown as ActivatorHost` |

```typescript
await this.activator.handleEvent(
  { type: 'onStartupFinished' },
  this.host as unknown as ActivatorHost,  // 三次重复
  this.rpcServer,
)
```

**问题**：`PluginActivator` 定义了自己的缩小版 `PluginHost` 接口（`plugin-activator.ts:27-30`），与完整的 `PluginHost` 类之间没有正式的 implements 关系。这导致每次传递都需要 `as unknown as` 双重断言。

**建议**（三选一）：
1. 将 `ActivatorHost` 接口提取到 `plugin-types.ts`，让 `PluginHost` 显式 `implements` 它
2. 或合并接口，让 `PluginActivator` 直接接受完整的 `PluginHost`
3. 或 `PluginHost` 自身实现 `ActivatorHost` 并做类型检查

---

### 5. `plugin-service.ts` — registerRpcMethods 中 `params.xxx as string` 重复断言

| 位置 | 文件 | 行 |
|------|------|---|
| 存储 / notify / sessions 注册 | `plugin-service.ts` | L51-L72 |

```typescript
this.rpcServer.registerMethod('plugin.storage.global.get', async (params) => {
  return this.storage.get(params.pluginId as string, params.key as string)
})
```

**问题**：每个 handler 里都在重复 `params.xxx as string`。RPC handler signature 是 `(params: Record<string, unknown>) => Promise<unknown>`，内部使用入口断言模式本不违规范（有 `as` 断言），但跨 6 个方法重复同一模式。

**建议**：提取一个类型化的参数解析 helper：
```typescript
function paramStr(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== 'string') throw new Error(`Missing or invalid string param: ${key}`)
  return v
}
```
然后在 handler 中做**一次入口断言**（函数顶部 `const { pluginId, key } = params as { pluginId: string; key: string }`）。

---

### 6. `plugin-bootstrap.ts` — createStateStorageProxy 中脆弱条件类型

| 位置 | 文件 | 行 |
|------|------|---|
| sessions.list 的条件类型推断 | `plugin-bootstrap.ts` | L128 |

```typescript
sessions: {
  list: () =>
    rpcClient.request('plugin.sessions.list', { pluginId })
      .then(v => (v as unknown as Phase1AgentAPI['sessions'] extends { list(): Promise<infer R> } ? R : never) ?? []),
}
```

**问题**：`v as unknown as ... ? R : never` 是条件类型的内联使用，过于复杂且脆弱。`never` fallback 会导致类型层面空值传播不可追踪。

**建议**：直接 `v as SessionInfo[]` 或定义一个明确返回类型：
```typescript
list: (): Promise<SessionInfo[]> =>
  rpcClient.request('plugin.sessions.list', { pluginId })
    .then(v => (v as SessionInfo[]) ?? []),
```

---

### 7. `plugin-registry.ts` — 多个空 catch 块

| 位置 | 文件 | 行 |
|------|------|---|
| scan() 中目录/文件不可读 | `plugin-registry.ts` | L37, L39, L48, L51 |

```typescript
} catch {
  // 目录不存在 → 跳过
  continue
}
```

**问题**：4 个 `catch {}` / `catch { continue }` / `catch { return null }` 全部无日志。虽然"跳过非插件目录"是预期行为，但安全做法是至少 debug log，避免将来调试困难。

**建议**：对 4 个 catch 加 `console.debug`（或使用 `process.env.DEBUG` 门控的日志）。

---

### 8. `plugin-activator.ts` — disposeContext 中空 catch

| 位置 | 文件 | 行 |
|------|------|---|
| dispose subcription | `plugin-activator.ts` | L255 |

```typescript
for (const sub of ctx.subscriptions) {
  try { sub.dispose() } catch { /* best effort */ }
}
```

**问题**：虽然是标准的 best-effort 清理模式，但 dispose 抛异常可能指示 `Disposable` 内部错误（如有资源泄漏），应当记录。

**建议**：至少加 `console.debug` 或 `console.warn`。

---

### 9. `plugin-types.ts` — `Record<string, unknown>` 未登记白名单

| 位置 | 文件 | 行 |
|------|------|---|
| 多个接口使用 `Record<string, unknown>` | `plugin-types.ts` | 多处 |

以下场景使用 `Record<string, unknown>` 但未在 CLAUDE.md 白名单中登记：

| 类型 | 字段 | 白名单理由 |
|------|------|-----------|
| `PluginContributes` | `tools[].parameters` | 插件外部贡献 schema，类型不可预知 |
| `RpcRequest` | `params` | JSON-RPC 协议层，payload 动态 |
| `RpcNotification` | `params` | JSON-RPC 协议层，payload 动态 |
| `RpcMethodHandler` | 函数签名 | handler 接口约束，内部做入口断言 |

**建议**：在项目 CLAUDE.md 的 P0 白名单规则下补充这 4 条，注明理由。

---

### 10. `plugin-host.ts` — createWorker 方法过长

| 位置 | 文件 | 行 |
|------|------|---|
| `createWorker` | `plugin-host.ts` | L131-L172 |

**问题**：`createWorker` 约 42 行，混合了 Worker 实例创建、handle 构造、3 个事件监听注册、crash 路由逻辑。

**建议**：将事件监听注册（worker.on('message')、worker.on('error')、worker.on('exit')）提取为独立方法。

---

## P2 — 安全防御（推荐修复）

### 11. `plugin-host.ts` — 魔数缺命名常量

| 文件 | 行 | 魔数 | 含义 |
|------|----|------|------|
| `plugin-host.ts` | L54 | `10` | trusted worker 共享上限 |
| `plugin-host.ts` | L77 | `10_000` | loadPlugin 超时（ms） |
| `plugin-host.ts` | L123 | `30_000` | 内存监控间隔（ms） |

**建议**：提取为模块级 `const`：
```typescript
const MAX_TRUSTED_PLUGINS_PER_WORKER = 10
const LOAD_PLUGIN_TIMEOUT_MS = 10_000
const DEFAULT_MEMORY_MONITOR_INTERVAL_MS = 30_000
```

---

### 12. `plugin-storage.ts` — 哈希截断长度魔数

| 文件 | 行 | 魔数 | 含义 |
|------|----|------|------|
| `plugin-storage.ts` | L190 | `12` | 工作目录 hash 截断长度 |

Hash 截断到 12 个 hex 字符（48 bit）——碰撞概率在单机场景可忽略，但魔数缺少命名。

**建议**：`const WORKSPACE_HASH_LENGTH = 12`

---

## P3 — 细节

无严重违反。整体代码组织良好，职责分离清晰。

---

## 跨文件观察

### 类型桥接模式（ActivatorHost ↔ PluginHost）

```
PluginActivator  ── 依赖 ──→  PluginHost (interface: 4 methods)
                                     ↑ 非 implements
                            PluginHost (class: 10+ methods)
```

`PluginActivator` 定义的缩小版 `PluginHost` 接口与其实际实现之间没有类型继承关系。这导致：
- `plugin-service.ts` 中 3 处 `as unknown as ActivatorHost`
- 编译期安全丢失：如果 `PluginHost` 类修改了方法签名，Activator 不会感知

### `Record<string, unknown>` 使用分布

| 位置 | 场景 | 在白名单中？ |
|------|------|------------|
| `plugin-types.ts:PluginContributes` | 外部贡献 schema | ❌ |
| `plugin-types.ts:RpcRequest.params` | JSON-RPC 协议 | ❌ |
| `plugin-types.ts:RpcNotification.params` | JSON-RPC 协议 | ❌ |
| `plugin-rpc-server.ts:RpcMethodHandler` | handler 接口签名 | ❌ |
| `plugin-service.ts:registerRpcMethods` | handler 内 `params.xxx as string` | ❌ |

前 4 项属于合法场景，应补充到白名单。第 5 项应在 handler 内做入口断言（一次 `as ConcreteType` 而非逐字段 `as string`）。

### Promise.allSettled 使用检查 ✅

所有并行操作均使用 `Promise.allSettled`，符合项目规范：
- `plugin-activator.ts:78` — 批量激活
- `plugin-activator.ts:156` — 批量停用
- `plugin-storage.ts:127` — 批量 flush

### `catch` 块审查

| 文件 | 行 | catch 类型 | 评价 |
|------|----|-----------|------|
| `plugin-registry.ts` | L37,39,48,51 | 空 catch / `continue` / `return null` | P1 — 应加 debug log |
| `plugin-activator.ts` | L255 | 空 catch | P1 — 应加 debug log |
| `plugin-storage.ts` | L138 | 空 catch | P0 — 应区分 ENOENT 与 parse error |
| `plugin-bootstrap.ts` | L76 | 仅 console.error | P0 — 应回送 error 消息 |
| `plugin-host.ts` | L113, L128 | console.error | ✅ 合适（host 级错误日志） |
| `plugin-storage.ts` | L165 | console.error | ✅ 合适（定时器内异常日志） |

---

## 汇总

| 优先级 | 数量 | 主要问题 |
|--------|------|---------|
| **P0** | **3** | 未使用参数（error）+ deactivate 错误吞没 + 空 catch 无区分 |
| **P1** | **7** | 类型桥接三重 cast、params 逐字段断言、条件类型脆弱、空 catch 缺日志、白名单缺失、过长方法 |
| **P2** | **3** | 魔数缺命名常量 ×3 |
| **P3** | **0** | — |
| **must_fix** | **3** | 所有 P0 项 |

### 建议修复顺序

1. **P0-1** `plugin-activator.ts` — 删除 `_rpcServer` 参数
2. **P0-2** `plugin-bootstrap.ts` — deactivate 异常回送 error 消息
3. **P0-3** `plugin-storage.ts` — catch 区分 ENOENT 与解析错误
4. **P1-4** `plugin-service.ts` — 消除三重 `as unknown as` 类型桥接（接口提取到 types）
5. **P1-5** `plugin-service.ts` — params 入口断言 helper
6. **P2-11/12** `plugin-host.ts` / `plugin-storage.ts` — 魔数命名
7. **其余 P1** — catch 加日志、条件类型简化、白名单补充

### 总体评价

**verdict: pass** — 代码整体质量良好，职责分离清晰（10 个文件各司其职），类型定义完整（无 `any` 逃逸），异步边界处理覆盖全面（loader/activator/worker/rpc/storage 均有完善的生命周期管理）。

**must_fix: 3** — 3 个 P0 项需在合并前修复，否则 CI 阻塞（ESLint error）且 deactivate 错误路径将静默丢失错误信息。
