# A5. plugin-service Worker 隔离健壮性设计

> 对应 Wave W7 / MUST FIX #13-17。最复杂的架构项，5 个 MUST FIX 集中在 Worker 并发模型。

## 1. 背景与问题

5 个 MUST FIX + 关键 SHOULD FIX，根因是 trusted Worker 共享模型的隔离承诺未完全兑现：

| # | 问题 | 文件:行号 | 根因分类 |
|---|------|-----------|---------|
| 13 | loadPlugin 不区分 pluginId，trusted Worker 并发加载错乱 | `plugin-host.ts:224` | 并发匹配 |
| 14 | loadPlugin 超时路径 onMessage 监听器泄漏 | `plugin-host.ts:219` | 资源清理 |
| 15 | crash Worker 未 terminate，线程句柄泄漏 | `plugin-host.ts:417` | 资源清理 |
| 16 | pendingReplies 以 pluginId 为 key，并发覆盖致 Promise 泄漏 | `plugin-activator.ts:469` | 并发匹配 |
| 17 | sessionData deactivate 强制 flush 未接线 | `plugin-activator.ts:213` | 接线遗漏 |
| — | crashCounts 永不重置，插件永久死亡 | `plugin-host.ts:432` | 状态机 |
| — | sandbox crash 完全无处理 | `plugin-host.ts:417` | 状态机 |
| — | hot-reload forceTerminate 殃及同 Worker 其他插件 | `plugin-hot-reload.ts:124` | 隔离粒度 |

## 2. 代码事实关键约束

- `MAX_PLUGINS_PER_TRUSTED_WORKER = 10`：trusted Worker 最多挂 10 个插件，共享同一 Worker 实例和 message 监听器
- `MAX_REBUILD_ATTEMPTS = 3`：超过 3 次崩溃不重建（注意是 `>` 判定，第 4 次崩溃才停）
- `PendingTracker` 工具已存在（`utils/async/pending-tracker.ts`），注释提到要"收编 plugin-rpc-client / plugin-rpc-server / plugin-activator.pendingReplies"，**但 activator 尚未迁移**
- `WriteBackCache` 的 `dispose()`（`json-store.ts:295`）只清 timer **不 flush**
- `flushSessionDataForSession` / `clearSessionData` 方法已定义但**零调用方**（死代码）
- hook 超时 5s / tool 超时 30s 后 Worker 不回收，卡住的 handler 继续占用线程

## 3. 修复方案（按 MUST FIX 编号）

### 3.1 #13 loadPlugin 区分 pluginId

**问题**：trusted Worker 上并发 `loadPlugin(A)` 和 `loadPlugin(B)`，A 的 onMessage 会消费 B 的 `loaded` 消息（不检查 pluginId）。

**方案：onMessage 匹配 pluginId**

```typescript
// plugin-host.ts loadPlugin 内
async loadPlugin(workerId: string, pluginPath: string, trustLevel?: ...): Promise<void> {
  const worker = this.workerInstances.get(workerId)
  if (!worker) throw new Error(`Worker not found: ${workerId}`)
  const pluginId = pluginPath.split('/').pop() ?? 'unknown'

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.off('message', onMessage)  // ← #14 修复：超时也清监听器
      reject(new Error(`loadPlugin timeout for ${pluginId}`))
    }, LOAD_PLUGIN_TIMEOUT_MS)

    const onMessage = (msg: unknown) => {
      const m = msg as Record<string, unknown>
      if ((m.type === 'loaded' || m.type === 'error') && m.pluginId === pluginId) {  // ← 匹配 pluginId
        clearTimeout(timeout)
        worker.off('message', onMessage)
        if (m.type === 'loaded') resolve()
        else reject(new Error(String(m.error ?? 'load failed')))
      }
    }
    worker.on('message', onMessage)
    worker.postMessage({ type: 'load', pluginId, pluginPath, trustLevel: trustLevel ?? this.inferTrustLevel(workerId) })
  })
}
```

**同时修复 #14**（超时路径监听器泄漏）：timeout 回调内加 `worker.off('message', onMessage)`。

**前提确认**：Worker 侧（plugin-bootstrap.ts:81/83）回复的 `loaded`/`error` 消息已携带 `pluginId`（事实收集确认）。若不带则需同步改 bootstrap。**需验证**。

### 3.2 #15 crash Worker terminate

**问题**：handleWorkerCrash 的 trusted 分支只 `delete` Map 不调 `worker.terminate()`，线程句柄泄漏。sandbox 分支完全无处理。

**方案：crash 时先 terminate 再 delete**

```typescript
// plugin-host.ts handleWorkerCrash 内
private handleWorkerCrash(workerId: string, error: string): void {
  const handle = this.workers.get(workerId)
  if (!handle || handle.status === 'crashed' || handle.status === 'terminated') return

  handle.status = 'crashed'
  const pluginIds = [...handle.pluginIds]
  const trustLevel = handle.trustLevel
  this.rpcServer.unregisterWorker(workerId)

  // 先 terminate Worker 线程，再清 Map（trusted 和 sandbox 都做）
  const worker = this.workerInstances.get(workerId)
  worker?.terminate().catch(() => {})  // fire-and-forget，terminate 失败也不阻塞清理
  this.workerInstances.delete(workerId)
  this.workers.delete(workerId)

  if (trustLevel === 'trusted') {
    this.crashedTrustedWorkers.set(workerId, { pluginIds, trustLevel })
    // ... crashCounts + rebuild 逻辑（不变）
    for (const pluginId of pluginIds) {
      const count = (this.crashCounts.get(pluginId) ?? 0) + 1
      this.crashCounts.set(pluginId, count)
    }
    const exceeded = pluginIds.some(pid => (this.crashCounts.get(pid) ?? 0) > PluginHost.MAX_REBUILD_ATTEMPTS)
    if (!exceeded) {
      setTimeout(() => { this.rebuildWorker(workerId, pluginIds).catch(...) }, this.rebuildCooldownMs)
    }
  }
  // sandbox 分支：terminate + delete Map 已在上面统一完成，不再"完全无处理"

  this.onCrash?.(workerId, pluginIds, error)
}
```

### 3.3 #16 pendingReplies 改唯一 replyId

**问题**：`pendingReplies` key 是 pluginId，并发 activate/deactivate 同一插件时第二个覆盖第一个，被覆盖的 Promise 永不 settle + timer 泄漏。

**方案：key 改为自增 replyId，消息携带 replyId**

```typescript
// plugin-activator.ts
private pendingReplies = new Map<string, PendingReply>()  // key 改为 replyId
private replyIdCounter = 0

private sendAndWaitReply(
  handle: { workerId: string; postMessage(message: unknown): void },
  message: unknown,
  pluginId: string,
  timeoutMs: number,
): Promise<boolean> {
  const replyId = `reply-${++this.replyIdCounter}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      this.pendingReplies.delete(replyId)
      resolve(false)
    }, timeoutMs)

    this.pendingReplies.set(replyId, { resolve, timer })
    handle.postMessage({ ...message, replyId })  // 消息带 replyId
  })
}

handleWorkerReply(msg: WorkerToHostMessage): void {
  if (!('replyId' in msg) || typeof msg.replyId !== 'string') return  // 匹配 replyId
  const pending = this.pendingReplies.get(msg.replyId)
  if (!pending) return
  clearTimeout(pending.timer)
  this.pendingReplies.delete(msg.replyId)
  if (msg.type === 'activated' || msg.type === 'deactivated') pending.resolve(true)
  else if (msg.type === 'error') pending.resolve(false)
}
```

**Worker 侧适配**：bootstrap 回复消息需携带 `replyId`（echo 请求中的 replyId）。**需确认 bootstrap 是否支持 echo replyId**，不支持则需同步改。

**备选方案（不改协议）**：用 `${pluginId}:${operation}` 做 key（activate/deactivate 区分），但不能防同一操作的并发覆盖（如两次 activate）。replyId 方案更彻底。

**注意 PendingTracker**：已有 `PendingTracker` 工具（`utils/async/pending-tracker.ts`），注释明确要收编 activator.pendingReplies。**优先用 PendingTracker** 而非裸 Map，与注释意图一致，减少未来重复迁移。

### 3.4 #17 sessionData flush 接线

**问题**：AGENTS.md 规则#11 要求"Plugin deactivate 时强制 flush"，但 deactivatePlugin 不调 flush；shutdown 调 `storage.flushAll()`（PluginStorage）但不调 `sessionDataStore.flushAll()`；`flushSessionDataForSession`/`clearSessionData` 零调用方。

**方案：三处接线**

```typescript
// 1. deactivatePlugin 内（plugin-activator.ts）
async deactivatePlugin(...): Promise<void> {
  // ... 现有逻辑
  // 新增：deactivate 前强制 flush 该插件所有 session 的数据
  this.sessionDataStore.flushAll()  // 或更精确：只 flush 该 pluginId 的分区（需 WriteBackCache 支持 per-partition flush by pluginId）
}

// 2. shutdown 内（plugin-service.ts）
async shutdown(): Promise<void> {
  if (!this.initialized) return
  this.sessionDataStore.flushAll()   // ← 新增：先 flush 再停 timer
  this.sessionDataStore.stopFlushTimer()
  // ... 现有逻辑
}

// 3. session 删除时（session-lifecycle.ts delete 内）
// 新增：session 删除时清理该 session 的 sessionData
this.pluginService.clearSessionData(sessionId)  // ← 接线死代码
```

**依赖确认**：
- `SessionDataStore.flushAll()` 是否存在？事实收集显示 WriteBackCache 有 `flushAll`（`json-store.ts`），SessionDataStore 应代理它。**需确认**。
- `clearSessionData` 的参数签名是 `sessionId`，session-lifecycle 删除时有 sessionId，可直接调。

### 3.5 关键 SHOULD FIX：crashCounts 重置

**问题**：crashCounts 只增不减，插件长期运行必然触发"exceeded max rebuild"永久死亡。

**方案：手动 re-activate 时清零**

```typescript
// plugin-activator.ts activatePlugin 成功后
async activatePlugin(...): Promise<ActivateResult> {
  // ... 现有逻辑
  if (成功) {
    this.host.clearCrashCount(pluginId)  // 新增
  }
}

// plugin-host.ts
clearCrashCount(pluginId: string): void {
  this.crashCounts.delete(pluginId)
}
```

**备选**：成功运行 N 分钟后衰减（更复杂，本轮不做）。手动 re-activate 清零最简单且符合"用户主动操作 = 给新机会"的语义。

### 3.6 关键 SHOULD FIX：hot-reload forceTerminate 细化

**问题**：hot-reload 的 forceTerminate 调 `terminateWorker(workerId)`，杀整个 trusted Worker，殃及同 Worker 其他插件。且不触发 rebuild，殃及的插件无法恢复。

**方案：forceTerminate 前检查是否有其他活跃插件**

```typescript
// plugin-activator.ts forceTerminate
forceTerminate: async (pluginId) => {
  const handle = host.getWorkerHandle(pluginId)
  if (!handle) return
  const otherPlugins = handle.pluginIds.filter(pid => pid !== pluginId)
  if (otherPlugins.length > 0) {
    // trusted Worker 上有其他插件 → 只标记目标插件 UNLOADED，不杀整个 Worker
    host.detachPluginFromWorker(handle.workerId, pluginId)  // 新增：从 pluginIds 移除
    // 不调 terminateWorker，其他插件不受影响
  } else {
    // 独占 Worker → 安全终止
    await host.terminateWorker(handle.workerId)
  }
}
```

**新增 `detachPluginFromWorker`**：从 WorkerHandle.pluginIds 移除指定 pluginId，Worker 本身保持运行。Worker 内对应的插件实例需通过 `postMessage({type:'unload', pluginId})` 通知 Worker 清理（如果 Worker 支持 unload 单个插件）。

**Worker 侧限制**：需确认 plugin-bootstrap 是否支持卸载单个插件而不终止 Worker。**如果不支持**，方案降级为"forceTerminate 仍杀整个 Worker，但殃及的插件触发 rebuild"（修改 terminateWorker 使其走 crash 路径而非静默终止）。

## 4. 改动范围

| 文件 | 改动 | MUST FIX |
|------|------|---------|
| `plugin-host.ts` loadPlugin | onMessage 匹配 pluginId + 超时清监听器 | #13 #14 |
| `plugin-host.ts` handleWorkerCrash | terminate Worker + sandbox 分支统一处理 | #15 |
| `plugin-host.ts` | 新增 `clearCrashCount(pluginId)` | SHOULD FIX |
| `plugin-host.ts` | 新增 `detachPluginFromWorker(workerId, pluginId)` | SHOULD FIX |
| `plugin-activator.ts` sendAndWaitReply | key 改 replyId（优先用 PendingTracker） | #16 |
| `plugin-activator.ts` deactivatePlugin | 新增 sessionDataStore.flushAll() | #17 |
| `plugin-activator.ts` activatePlugin | 成功后调 host.clearCrashCount | SHOULD FIX |
| `plugin-activator.ts` forceTerminate | 检查 otherPlugins 决定杀 Worker 还是 detach | SHOULD FIX |
| `plugin-service.ts` shutdown | 新增 sessionDataStore.flushAll() | #17 |
| `session-lifecycle.ts` delete | 新增 pluginService.clearSessionData(sessionId) | #17 |
| `plugin-bootstrap.ts` | 确认/适配 replyId echo + 单插件 unload 支持 | 协议确认 |

## 5. 需要验证的前提（实现前必须确认）

| # | 待验证 | 验证方法 |
|---|--------|---------|
| 1 | Worker 回复 loaded/error 消息是否带 pluginId | 读 plugin-bootstrap.ts:81/83 |
| 2 | Worker 是否支持 echo replyId（或需新增协议字段） | 读 plugin-bootstrap.ts 的消息构造 |
| 3 | Worker 是否支持卸载单个插件（unload message） | 读 plugin-bootstrap.ts 的 message handler |
| 4 | SessionDataStore 是否有 flushAll 方法 | 读 session-data-store.ts |
| 5 | WriteBackCache 是否支持 per-partition flush by pluginId | 读 json-store.ts |
| 6 | PendingTracker 接口是否适合 activator 场景 | 读 pending-tracker.ts |

**这些验证建议在 cw plan 阶段或 W7 dev 前的第一个子任务完成**，因为它们决定方案是否需要调整。

## 6. 测试策略

| 场景 | 方法 |
|------|------|
| trusted Worker 并发加载不串台 | mock 同一 Worker 上 loadPlugin(A) + loadPlugin(B)，A 先 resolve，断言 B 仍等自己的消息 |
| loadPlugin 超时清监听器 | fake timers + 超时后断言 worker.off 被调 + 监听器计数不增 |
| crash Worker terminate | mock Worker crash，断言 worker.terminate() 被调 |
| sandbox crash 清理 | mock sandbox Worker crash，断言 Map 被清（不再"完全无处理"）|
| pendingReplies 并发不覆盖 | mock 同一插件 activate + deactivate 并发，断言两个 Promise 都 settle |
| sessionData deactivate flush | mock deactivate，断言 sessionDataStore.flushAll 被调 |
| sessionData shutdown flush | mock shutdown，断言 sessionDataStore.flushAll 在 stopFlushTimer 前被调 |
| clearSessionData 接线 | mock session delete，断言 pluginService.clearSessionData 被调 |
| crashCounts 重置 | mock 插件 crash 2 次后成功 activate，断言 crashCounts 被清零 |
| forceTerminate 有其他插件时 detach | mock trusted Worker 上 2 个插件，forceTerminate 一个，断言 Worker 未 terminate + 另一个插件不受影响 |

## 7. 待决策

| # | 决策点 | 推荐方案 | 备选 |
|---|--------|---------|------|
| 1 | pendingReplies 迁移 | 用现有 PendingTracker | 裸 Map + replyId |
| 2 | sessionData flush 粒度 | flushAll（简单） | per-pluginId flush（精确但 WriteBackCache 需扩展） |
| 3 | forceTerminate 细化 | detachPluginFromWorker（需 Worker 支持 unload） | 仍杀 Worker 但触发 rebuild（降级） |
| 4 | crashCounts 重置时机 | 手动 re-activate 清零 | 成功运行 N 分钟衰减 |

## 8. 风险

| 风险 | 缓解 |
|------|------|
| Worker 侧不支持 replyId echo / 单插件 unload | 第 5 节前提验证先行；不支持则降级方案 |
| 改动面广（10+ 文件） | W7 独立 wave，与前 6 个 wave 无依赖，可充分测试 |
| plugin-service 测试覆盖薄弱 | 测试策略全覆盖每个 MUST FIX 的并发场景 |
