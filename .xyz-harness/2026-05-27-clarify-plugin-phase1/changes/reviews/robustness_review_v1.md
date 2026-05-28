---
review:
  type: robustness_review
  round: 1
  timestamp: "2026-05-28T10:30:00+08:00"
  target: "src-electron/runtime/src/services/plugin-service/ (10 files) + server.ts + index.ts plugin integration"
  verdict: fail
  summary: "健壮性评审完成，第1轮，6条MUST FIX，需修改后重审"

statistics:
  total_issues: 9
  must_fix: 6
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plugin-host.ts:172 (createWorker)"
    title: "new Worker(bootstrapPath) 未做异常防护，Worker 创建失败会直接崩溃"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plugin-bootstrap.ts:102-108 (deactivate case)"
    title: "deactivate 失败仍发送 deactivated 回复，主线程收到假性的成功确认"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plugin-activator.ts:122 (activatePlugin catch)"
    title: "插件激活失败静默吞异常，没有任何日志记录 failure 原因"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plugin-host.ts:215-222 (shutdown)"
    title: "shutdown 中 worker.terminate() 未 await/未 catch，unhandled rejection 风险"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: MUST_FIX
    location: "plugin-service.ts:117-129 (shutdown 时序)"
    title: "storage.flushAll() 在 host.shutdown() 之后调用，Worker 被终止后 RPC 写操作可能丢失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: MUST_FIX
    location: "plugin-registry.ts:27-36,61-75 (parsePlugin / scan)"
    title: "插件扫描解析失败静默跳过，未记录失败原因，排查问题无迹可循"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plugin-activator.ts:184 (disposeContext)"
    title: "subscription dispose 失败被静默吞掉，未记录错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plugin-service.ts:14-22 (constructor)"
    title: "构造参数 registry/broker 未做 null 校验，传递 null 会产生晦涩的 NPE"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "plugin-host.ts:137-148 (startMemoryMonitor)"
    title: "方法名 startMemoryMonitor 与实际实现不符——仅更新时间戳，未采集内存数据"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性评审 v1

## 评审记录
- 评审时间：2026-05-28 10:30
- 评审类型：健壮性评审（六维度）
- 评审对象：`src-electron/runtime/src/services/plugin-service/` 目录下 10 个 .ts 文件 + server.ts 和 index.ts 中的 plugin 集成点

---

## 六维度审查结果

### 1. 错误处理（Error Handling）

| 文件 | 状态 | 说明 |
|------|------|------|
| plugin-activator.ts | ⚠️ 缺陷 | `activatePlugin` 的 catch 块（L122）静默将状态置为 UNLOADED，**未记录异常**。生产环境无法追溯插件激活失败的原因 |
| plugin-bootstrap.ts | ⚠️ 缺陷 | `deactivate` 分支（L102-108）没有 try-catch，`mod.deactivate()` 抛异常时 `deactivated` 消息仍被发送。主线程收到假性成功确认 |
| plugin-bootstrap.ts | ✅ | 外层 `parentPort.on('message', ...)` 有 `.catch()` 兜底，`load`/`activate` 分支有独立 try-catch |
| plugin-host.ts | ⚠️ 缺陷 | `createWorker` 中 `new Worker(bootstrapPath)` （L172）无 try-catch，bootstrap 文件缺失或 syntax error 会导致整个 `PluginHost` 崩溃 |
| plugin-host.ts | ⚠️ 缺陷 | `loadPlugin` 的 onMessage listener 通过闭包引用 worker，`worker.off('message', onMessage)` 在 event 内部调用，如果在中途并发调用会有风险 |
| plugin-rpc-server.ts | ✅ | `dispatch` 有 try-catch，错误码正确提取 |
| plugin-rpc-client.ts | ✅ | 有超时机制，dispose 时清理所有 pending |
| plugin-storage.ts | ✅ | getCache 防御性处理文件不存在/解析失败，有 debounce flush 和日志 |
| plugin-service.ts | ⚠️ 缺失 | `shutdown` 中的 `deactivateAll`/`host.shutdown`/`storage.flushAll` 均无 try-catch。如果任一步骤失败，后续步骤跳过，资源泄漏 |
| server.ts | ✅ | `plugin.list` / `plugin.toggle` 通过 outer catch 兜底 |
| index.ts | ✅ | `pluginService.initialize()` 有 try-catch，不阻塞 server 启动 |

### 2. 异常安全（Exception Safety）

**Worker 生命周期资源泄漏风险：**

- **`PluginHost.createWorker` (L172)**：`new Worker(bootstrapPath)` 抛出异常时 Worker 已部分构造，存在资源泄漏（`Worker` 对象已分配但未被 tracked）。见 MUST_FIX #1。
- **`PluginHost.shutdown` (L215-222)**：`worker.terminate()` 返回 Promise 但未被 await，也未被 `.catch()`。如果 `terminate()` 抛出或 reject，产生 unhandled rejection。见 MUST_FIX #4。
- **`PluginHost.shutdown` vs `terminateWorker`**：`shutdown` 直接调 `worker.terminate()`，不走 `terminateWorker()` 流程，`rpcServer.unregisterWorker()` 未在每个 Worker 上调用。虽然 `shutdown` 最后有 `rpcServer.dispose()`，但短暂存在   `rpcServer.workers` 与真正活着的 Worker 不一致。

**Timer/Callback 泄漏：**

- `PluginHost.startMemoryMonitor` 的 interval timer：shutdown 时清理。✅
- `PluginStorage.scheduleFlush` 的 debounce timer：flush/flushAll 时清理。✅
- `PluginActivator.sendAndWaitReply` 的 timeout timer：handleWorkerReply 或超时触发时清理。✅
- `PluginRpcClient.request` 的 timeout timer：handleResponse 或超时触发时清理。✅

**Shutdown 时序缺陷——数据丢失风险：**

`PluginService.shutdown()` 的调用顺序是：
1. `deactivateAll()` → 向 Worker 发送 deactivate 消息
2. `host.shutdown()` → 立即 terminate 所有 Worker
3. `storage.flushAll()` → 尝试 flush 数据到磁盘

`deactivateAll()` 使用 `Promise.allSettled`，但 deactivate 走的是异步消息（`sendAndWaitReply` + Worker 处理），如果 Worker 处理慢或 deactivate 消息还  在队列中，`deactivateAll` 在 `async` 语义上 resolve 时，**Worker 可能仍在处理**。紧接着的 `host.shutdown()` 直接 terminate Worker，中断了：
- Worker 正在执行的 `deactivate()` 清理逻辑
- Worker 内未完成的 RPC storage 写操作

然后 `storage.flushAll()` flush 的数据是最后一次 flush debounce 之后的缓存状态，如果在 host shutdown 后 Worker 尝试 set 但未 flush 的数据会丢失。**见 MUST_FIX #5。**

**PluginActivator 状态一致性：**

- `activatePlugin` catch：设置 `UNLOADED`，但 descriptor cache 未清理。✅ 合理（descriptor 与 state 分离）
- `handleEvent`：`Promise.allSettled`，一个任务失败不影响其他。✅
- `sendAndWaitReply`：超时自动 resolve(false)，不会阻塞。✅

### 3. 日志（Logging）

| 路径 | 状态 | 详情 |
|------|------|------|
| PluginHost 的 worker error/exit | ✅ | `console.error` 带 workerId 和错误消息 |
| PluginStorage 的 flush 失败 | ✅ | `console.error` 带 pluginId |
| index.ts 的初始化失败 | ✅ | `console.error` 带错误 |
| **PluginRegistry.parsePlugin** 解析失败 | ❌ | 静默返回 null，不记录哪个目录的 package.json 为何解析失败 |
| **PluginActivator.activatePlugin catch** | ❌ | 完全不记录异常 |
| **PluginActivator.deactivatePlugin** 超时 | ❌ | 不记录哪个插件停用超时 |
| **PluginActivator.handleWorkerReply** stale 回复 | ❌ | pending entry 不存在时不记录（可能是 double reply 或 bug） |
| **PluginRpcServer.dispatch** 处理失败 | ❌ | 错误被序列化回 client，但不记录 server 端日志。如果客户端已崩溃，错误彻底丢失 |
| PluginRpcServer.dispatch method not found | ❌ | 不记录 server 端日志 |

**缺失日志总计：6 处。** 最严重的是 `activatePlugin` 和 `parsePlugin`——这两个是用户首要的调试入口。

### 4. Fail-Fast（快速失败）

**良好的 fast-fail 实践：**

- `PluginRpcClient.request`：port 未 attach 时立刻 reject，message 清晰 ✅
- `PluginRpcClient.request`：超时时 reject 带 error code ✅
- `PluginRpcServer.dispatch`：method 不存在时返回 error response ✅
- `PluginStorage.set`：value > 1MB / total > 10MB 时立即抛定制错误（带 error code）✅
- `PluginService.togglePlugin`：descriptor 不存在时立即抛 Error ✅
- `server.ts plugin.toggle`：pluginService 不存在时立即返回 error ✅

**缺失的 fast-fail：**

- **`PluginHost.createWorker`**：bootstrapPath 对应的文件是否存在应该在构造时或 `createWorker` 前预检，而不是等 `new Worker()` 抛异常。见 MUST_FIX #1。
- **`PluginService.constructor`**：`registry` 和 `broker` 未做 null 检查。null 会传递到 `registry.scan()` 或 `broker.broadcast()` 才暴露（晦涩的 NPE）。见 LOW #8。
- **`PluginRpcClient.attach`**：未检查 port 是否为 null，传递 null 后首次 `postMessage` 才抛异常。
- **`PluginActivator.registerDescriptors`**：未验证 descriptors 数组内容。如果传入空数组，注册通过但后续 handleEvent 不会激活任何插件——静默无响应。

### 5. 测试友好（Testability）

**高可测试性组件：**

| 组件 | 理由 |
|------|------|
| `PluginRpcServer` | 纯 map 操作，无 I/O，可 mock WorkerPort |
| `PluginRpcClient` | 依赖 `ClientPort` 接口，可 mock |
| `PluginActivator` | 依赖 `PluginHost` 接口（自定义狭接口 `ActivatorHost`），可 mock |
| `PluginRegistry` | 仅依赖文件系统，可用 tmp 目录测试 |

**低可测试性组件：**

| 组件 | 理由 |
|------|------|
| `PluginHost` | 硬编码 `new Worker(realBootstrapPath)`，无法 mock Worker 创建。静态 import 解析 `import.meta.url` 导致 bootstrap 路径在测试时可能不存在。没有 `WorkerFactory` 接口 |
| `PluginStorage` | 直接操作 `fs/promises`，未通过接口注入。测试需要真实文件系统（tmpdir） |
| `PluginService` | 构造函数内直接 `new` 所有子组件（`PluginStorage`、`PluginRpcServer`、`PluginHost`、`PluginActivator`），不支持 DI 替换。不可单独 mock 任一组件 |

**Global State：**

- `plugin-bootstrap.ts`：模块级 `loadedModules` Map 和 `rpcClient` 实例。设计上就是单例（Worker 上下文），可接受。
- 其余所有类：实例字段，无模块级可变状态。✅

### 6. 调试友好（Debugability）

**好的实践：**
- 错误消息包含具体变量值（`pluginId`、`workerId`、`method`、`valueSize`）
- `PluginRpcClient` 超时消息包含 method 名称

**待改进：**
- 缺乏 **每请求跟踪 ID**：多步操作（load→activate→rpc）无法关联
- 缺乏 **结构化错误元数据**：所有错误都是字符串，没有 `{ pluginId, workerId, state }` 等上下文
- **最严重**：`activatePlugin` 和 `parsePlugin` 的静默跳过使调试无从下手
- `handleWorkerReply` 收到 stale reply 时不记录——这可能是深层 bug 的信号

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | plugin-host.ts:172 | `new Worker(bootstrapPath)` 未做异常防护，bootstrap 文件不存在时抛未捕获异常，整个 PluginHost 崩溃 | 包裹 try-catch，catch 中设置 handle.status='crashed' + 调用 onCrash callback。考虑创建 Worker 前用 `access()` 预检文件存在 |
| 2 | **MUST FIX** | plugin-bootstrap.ts:102-108 | `deactivate` 分支无 try-catch，`mod.deactivate()` 抛异常时 `deactivated` 消息仍被发送，主线程收到假性成功确认 | 在 `deactivate` case 内加 try-catch：捕获异常，先 `console.error` 记录，**不应发送 undefined 的 `deactivated` 消息**——应发送 `{ type: 'error', pluginId, error }` 让主线程知道停用失败 |
| 3 | **MUST FIX** | plugin-activator.ts:122 | `activatePlugin` catch 块静默将状态置 UNLOADED，不记录任何错误信息 | catch 中添加 `console.error('[plugin-activator] activate failed for', pluginId, e)`，保留当前 return 逻辑 |
| 4 | **MUST FIX** | plugin-host.ts:215-222 | `shutdown()` 中 `worker.terminate()` 未 await、未 catch，产生未处理的 Promise rejection | 改为 `for (const worker of ...) { try { await worker.terminate() } catch { /* best effort */ } }` 或使用 `Promise.allSettled` |
| 5 | **MUST FIX** | plugin-service.ts:117-129 | `storage.flushAll()` 在 `host.shutdown()` 之后调用，Worker terminate 中断了未完成的 RPC storage 写操作 | 交换顺序：先 `storage.flushAll()` flush 所有脏缓存，再 `host.shutdown()` termination Worker。同时 `deactivateAll` 内部应等待 Worker 处理完成 |
| 6 | **MUST FIX** | plugin-registry.ts:27-36,61-75 | 插件解析失败静默跳过（catch → return null），无日志记录失败原因（是文件不存在？JSON 格式错误？manifest 版本不对？） | 在 catch 块中添加 `console.warn('[plugin-registry] failed to parse plugin at', fullPath, e)` |
| 7 | LOW | plugin-activator.ts:184 | `disposeContext` 中 `sub.dispose()` 失败被 await/catch 静默吞掉 | 添加 `console.warn('[plugin-activator] dispose failed for', pluginId, e)` |
| 8 | LOW | plugin-service.ts:14-22 | `constructor(registry, broker)` 未做 null 校验，传递 null/undefined 产生晦涩的 NPE | 添加 `if (!registry) throw new Error('registry required')` assert |
| 9 | INFO | plugin-host.ts:137-148 | `startMemoryMonitor` 实际未采集内存数据，仅更新时间戳，方法名具误导性 | 改名 `startActivityMonitor` 或添加真实的 `process.memoryUsage()` 采集 |

> 优先级定义：
> - **MUST FIX**：健壮性缺陷，修复前评审不通过
> - **LOW**：建议修复，不阻塞
> - **INFO**：观察记录

#### MUST FIX 判定依据（参考 expert-reviewer 等级校准规则）

| 规则 | 对应 issue |
|------|-----------|
| 功能失效：某段代码从未被执行 | #1（Worker 创建失败不通知，后续 load/activate 依赖隐式失败） |
| 数据丢失：Worker 被 terminate 但 pending 磁盘写未完成 | #5（shutdown 时序导致数据丢失） |
| 功能失效：停用失败但通知成功，主线程做出错误决策 | #2（deactivate 假阳性，致系统以为插件已停用） |
| 调试不可用：异常路径静默跳过，无法溯源 | #3 #6（激活/扫描失败无日志 = 盲区） |
| 内存/资源安全：unhandled rejection 在 Node 未来版本可能 crash | #4（Node.js 未来版本默认 crash on UnhandledPromiseRejection） |

---

## 总结

| 维度 | 评分 (A-F) | 关键问题 |
|------|-----------|---------|
| 错误处理 | D | 激活/扫描失败静默吞异常，deactivate 假阳性 |
| 异常安全 | C | shutdown 时序导致数据丢失，Worker 创建无保护 |
| 日志 | D | 6 处关键路径无日志，首要调试入口盲区 |
| Fail-Fast | B | 基础 RPC 和 Storage 良好，Worker 创建和构造参数验证缺失 |
| 测试友好 | C | PluginHost/PluginService 硬编码依赖，不可 mock |
| 调试友好 | D | 缺少跟踪 ID，关键失败路径无信息 |

**结论：需修改后重审（6 条 MUST FIX）**
