---
verdict: pass
---

# Plugin System Phase 1 — Backend Detailed Design

> 对 spec.md FR-1 ~ FR-8 的逐模块详细设计，供 Task 1~8 实施时直接参照。

---

## 目录

1. [FR-1: PluginService — 顶层协调器](#fr1-pluginservice)
2. [FR-2: PluginRegistry — 插件发现 + Manifest 解析](#fr2-pluginregistry)
3. [FR-3: PluginHost — Worker Thread 池管理](#fr3-pluginhost)
4. [FR-4: PluginRPC — JSON-RPC 2.0 双向通信](#fr4-pluginrpc)
5. [FR-5: PluginActivator + Bootstrap — 懒激活 + Worker 入口](#fr5-pluginactivator--bootstrap)
6. [FR-6: PluginStorage — KV 持久化](#fr6-pluginstorage)
7. [FR-7: 类型定义](#fr7-类型定义)
8. [FR-8: Server 集成](#fr8-server-集成)
9. [错误处理策略](#错误处理策略)
10. [初始化 + 关闭时序](#初始化--关闭时序)

---

## FR-1: PluginService

### 类结构

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-service.ts

import type { IPluginService } from '../../interfaces.js'
import type { PluginRegistry } from './plugin-registry.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginActivator } from './plugin-activator.js'
import type { PluginStorage } from './plugin-storage.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { PluginDescriptor } from './plugin-types.js'

export class PluginService implements IPluginService {
  private registry: PluginRegistry
  private host: PluginHost
  private activator: PluginActivator
  private storage: PluginStorage
  private rpcServer: PluginRpcServer
  private broker: IMessageBroker
  private initialized = false

  /**
   * @param registry - PluginRegistry 在 index.ts 中创建并注入
   * @param broker - IMessageBroker，用于向前端推送 plugin 事件
   */
  constructor(registry: PluginRegistry, broker: IMessageBroker) {
    this.registry = registry
    this.broker = broker
    this.rpcServer = new PluginRpcServer()
    this.storage = new PluginStorage()
    this.host = new PluginHost(this.rpcServer)
    this.activator = new PluginActivator(this.registry, this.host, this.rpcServer)
  }

  /** spec FR-1: 初始化所有子模块 */
  async initialize(): Promise<void>

  /** spec FR-1: 获取已发现的插件列表 */
  getDiscoveredPlugins(): PluginDescriptor[]

  /** spec FR-1 / FR-8: 启用/禁用插件 */
  async togglePlugin(pluginId: string, enabled: boolean): Promise<PluginDescriptor[]>

  /** spec FR-8: 关闭所有子模块 */
  async shutdown(): Promise<void>
}
```

### 依赖注入拓扑

```
index.ts (DI container)
  │
  ├── new PluginRegistry(projectRoot)         ← 创建
  │
  ├── new PluginService(registry, server)     ← 注入 registry + IMessageBroker
  │     ├── .rpcServer = new PluginRpcServer()
  │     ├── .storage   = new PluginStorage()
  │     ├── .host      = new PluginHost(rpcServer)
  │     └── .activator = new PluginActivator(registry, host, rpcServer)
  │
  └── server.setServices(session, config, model, tree, extension, plugin)  ← 注入
```

### initialize() 内部流程

```
PluginService.initialize()
  │
  ├─ 1. registry.scan() → PluginDescriptor[]
  │     └─ 扫描 ~/.xyz-agent/plugins/ + <cwd>/.xyz-agent/plugins/
  │     └─ 解析 manifest + 版本检查 + 自动推断 activationEvents
  │
  ├─ 2. storage.init(baseDir)
  │     └─ 确保 ~/.xyz-agent/plugins/<id>/data/ 目录存在
  │
  ├─ 3. registerRpcMethods()
  │     └─ rpcServer.registerMethod('plugin.storage.get',    handler)
  │     └─ rpcServer.registerMethod('plugin.storage.set',    handler)
  │     └─ rpcServer.registerMethod('plugin.storage.delete', handler)
  │     └─ rpcServer.registerMethod('plugin.storage.keys',   handler)
  │     └─ rpcServer.registerMethod('plugin.sessions.list',  handler)
  │     └─ rpcServer.registerMethod('plugin.notify',         handler)  // notification, no response
  │
  ├─ 4. activator.registerActivationEvents()
  │     └─ 遍历 registry.getAllDescriptors()
  │     └─ 将每个 descriptor 的 activationEvents 注册到 activator 的事件映射表
  │
  ├─ 5. host.initialize()
  │     └─ 初始化 Worker 池（预分配 0 个 Worker，懒创建）
  │
  ├─ 6. activator.fireStartupEvents()
  │     └─ 触发 onStartupFinished → 激活声明了此事件的插件
  │
  └─ 7. broker.broadcast({ type: 'config.plugins', payload: { plugins } })
       └─ 通知前端插件列表
```

### togglePlugin() 流程

```
togglePlugin(pluginId, enabled)
  │
  ├─ enabled = true:
  │     ├─ activator.activatePlugin(pluginId, { type: 'onStartupFinished' })
  │     └─ 更新 descriptor.status → 'active'
  │
  ├─ enabled = false:
  │     ├─ activator.deactivatePlugin(pluginId)
  │     └─ 更新 descriptor.status → 'inactive'
  │
  └─ return registry.getAllDescriptors()  // 返回最新列表
```

### shutdown() 流程

```
PluginService.shutdown()
  │
  ├─ 1. activator.deactivateAll()
  │     └─ 遍历所有 active 插件，逐个调用 deactivate
  │
  ├─ 2. host.shutdown()
  │     └─ terminate 所有 Worker Thread
  │
  ├─ 3. storage.flushAll()
  │     └─ 将所有脏数据写入磁盘
  │
  └─ 4. rpcServer.dispose()
       └─ 清理所有 pending 请求（reject with shutdown error）
```

---

## FR-2: PluginRegistry

### 类结构

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-registry.ts

import type {
  PluginDescriptor,
  XyzAgentManifest,
  PluginContributes,
  ActivationEvent,
} from './plugin-types.js'

export class PluginRegistry {
  private cache = new Map<string, PluginDescriptor>()
  private pluginDirs: string[]

  constructor(projectRoot: string) {
    this.pluginDirs = buildPluginDirs(projectRoot)
  }

  /** 扫描所有插件目录，返回发现的 PluginDescriptor[] */
  async scan(): Promise<PluginDescriptor[]>

  /** 从缓存获取指定插件 */
  getDescriptor(pluginId: string): PluginDescriptor | undefined

  /** 获取所有已发现的插件 */
  getAllDescriptors(): PluginDescriptor[]

  /** 更新指定插件的状态 */
  updateStatus(pluginId: string, status: PluginDescriptor['status']): void

  /** 重新扫描（清空缓存后重新 scan） */
  async reload(): Promise<PluginDescriptor[]>
}
```

### 扫描路径构造

```typescript
function buildPluginDirs(projectRoot: string): string[] {
  const userDir = path.join(os.homedir(), '.xyz-agent', 'plugins')
  const projectDir = path.join(projectRoot, '.xyz-agent', 'plugins')
  return [userDir, projectDir]  // 用户级优先，项目级可覆盖
}
```

### scan() 详细流程

```
PluginRegistry.scan()
  │
  ├─ 清空 cache
  │
  ├─ for pluginDir of pluginDirs:
  │     │
  │     ├─ readdir(pluginDir) ─── ENOENT → 跳过
  │     │
  │     └─ for entry of entries:
  │           │
  │           ├─ join(pluginDir, entry, 'package.json')
  │           ├─ readFile(pkgPath) ─── ENOENT → 跳过
  │           ├─ JSON.parse(raw)
  │           │
  │           ├─ 提取 xyzAgent 字段
  │           │     ├─ 不存在 → 跳过（非插件）
  │           │     └─ 存在 → 继续
  │           │
  │           ├─ validateManifest(xyzAgent):
  │           │     ├─ manifestVersion !== 1 → 跳过 + console.warn
  │           │     ├─ main 缺失 → 跳过 + console.warn
  │           │     └─ engines.xyz-agent 不兼容 → 跳过 + console.warn
  │           │
  │           ├─ inferActivationEvents(xyzAgent.contributes):
  │           │     └─ 从 contributes 自动推导 activationEvents
  │           │
  │           └─ 构建 PluginDescriptor:
  │                 {
  │                   pluginId: entry,         // 目录名即 pluginId
  │                   version: pkg.version,
  │                   displayName: pkg.displayName ?? pkg.name,
  │                   description: pkg.description ?? '',
  │                   main: resolve(dir, xyzAgent.main),
  │                   activationEvents: [...],
  │                   trustLevel: xyzAgent.trustLevel ?? 'sandbox',
  │                   status: 'discovered',
  │                   contributes: xyzAgent.contributes,
  │                   permissions: xyzAgent.permissions ?? [],
  │                   engines: xyzAgent.engines,
  │                   manifestPath: pkgPath,
  │                   pluginDir: dir,
  │                 }
  │                 → cache.set(pluginId, descriptor)
  │
  └─ return Array.from(cache.values())
```

### Manifest 验证

```typescript
function validateManifest(manifest: XyzAgentManifest): {
  valid: boolean
  reason?: string
} {
  if (manifest.manifestVersion !== 1) {
    return { valid: false, reason: `Unsupported manifestVersion: ${manifest.manifestVersion}` }
  }
  if (!manifest.main || typeof manifest.main !== 'string') {
    return { valid: false, reason: 'Missing or invalid "main" field' }
  }
  if (manifest.engines?.['xyz-agent']) {
    const range = manifest.engines['xyz-agent']
    if (!semver.satisfies(APP_VERSION, range)) {
      return { valid: false, reason: `Incompatible: requires ${range}, current ${APP_VERSION}` }
    }
  }
  return { valid: true }
}
```

### 自动推断 ActivationEvents

```typescript
function inferActivationEvents(contributes?: PluginContributes): ActivationEvent[] {
  const events: ActivationEvent[] = []
  if (!contributes) return events

  for (const cmd of contributes.slashCommands ?? []) {
    events.push({ type: 'onSlashCommand', command: cmd.name })
  }
  for (const tool of contributes.tools ?? []) {
    events.push({ type: 'onToolCall', tool: tool.name })
  }
  for (const hook of contributes.hooks ?? []) {
    events.push({ type: 'onHook', event: hook.event })
  }
  if ((contributes.panels ?? []).length > 0 || (contributes.statusBarItems ?? []).length > 0) {
    if (!events.some(e => e.type === 'onStartupFinished')) {
      events.push({ type: 'onStartupFinished' })
    }
  }

  return events
}
```

> **注意**：spec 中 manifest 的 `activationEvents` 是可选字段。如果存在，优先使用显式声明；如果不存在，使用自动推断结果。

---

## FR-3: PluginHost

### 类结构

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-host.ts

import { Worker } from 'node:worker_threads'
import type { WorkerHandle, WorkerPoolConfig } from './plugin-types.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'

export class PluginHost {
  private rpcServer: PluginRpcServer
  private workers = new Map<string, WorkerHandle>()  // workerId → handle
  private workerInstances = new Map<string, Worker>() // workerId → Worker instance
  private config: WorkerPoolConfig
  private bootstrapPath: string
  private memoryMonitorTimer?: NodeJS.Timeout

  constructor(rpcServer: PluginRpcServer) {
    this.rpcServer = rpcServer
    this.config = {
      trustedWorkerCapacity: 10,
      idleTimeout: 60_000,
      memorySampleInterval: 30_000,
      memoryLimitTrusted: 256 * 1024 * 1024,   // 256MB
      memoryLimitSandbox: 128 * 1024 * 1024,   // 128MB
    }
    // 编译后的 bootstrap 路径（TS → JS）
    this.bootstrapPath = resolveBootstrapPath()
  }

  /** 初始化 Worker 池（Phase 1 懒创建，此步只设状态） */
  async initialize(): Promise<void>

  /** 为插件分配 Worker（复用 trusted Worker 或新建 sandbox Worker） */
  async assignWorker(pluginId: string, trustLevel: 'trusted' | 'sandbox'): Promise<WorkerHandle>

  /** 向指定 Worker 发送 load 指令，加载插件模块 */
  async loadPlugin(workerId: string, pluginPath: string): Promise<void>

  /** 终止指定 Worker（崩溃恢复或关闭时） */
  async terminateWorker(workerId: string): Promise<void>

  /** 获取所有 Worker 句柄 */
  getAllWorkers(): WorkerHandle[]

  /** 获取指定 Worker 句柄 */
  getWorkerHandle(workerId: string): WorkerHandle | undefined

  /** 获取插件所在的 Worker */
  getWorkerForPlugin(pluginId: string): WorkerHandle | undefined

  /** 关闭所有 Worker */
  async shutdown(): Promise<void>
}
```

### Worker 创建流程

```
assignWorker(pluginId, trustLevel)
  │
  ├─ trustLevel === 'trusted':
  │     ├─ 查找现有 trusted Worker（workerId.startsWith('trusted-')）
  │     │     ├─ 找到且 pluginIds.length < capacity → 复用
  │     │     └─ 找不到或已满 → 新建
  │     └─ 新建: createWorker('trusted-0', { pluginId })
  │
  └─ trustLevel === 'sandbox':
        └─ 总是新建: createWorker(`sandbox-${pluginId}`, { pluginId })

createWorker(workerId, workerData)
  │
  ├─ const worker = new Worker(bootstrapPath, { workerData })
  │
  ├─ 构造 WorkerHandle:
  │     {
  │       workerId,
  │       threadId: worker.threadId,
  │       trustLevel: workerData.trustLevel,
  │       pluginIds: [workerData.pluginId],
  │       status: 'idle',
  │       lastActiveAt: Date.now(),
  │     }
  │
  ├─ 注册事件:
  │     worker.on('message', (msg) => rpcServer.dispatch(workerId, msg))
  │     worker.on('error',   (err) => handleWorkerError(workerId, err))
  │     worker.on('exit',    (code) => handleWorkerExit(workerId, code))
  │
  ├─ workers.set(workerId, handle)
  ├─ workerInstances.set(workerId, worker)
  │
  └─ return handle
```

### loadPlugin() 流程

```
loadPlugin(workerId, pluginPath)
  │
  ├─ 获取 Worker 实例
  │     └─ 不存在 → throw new PluginError('PLUGIN_NOT_FOUND', ...)
  │
  ├─ 检查 Worker 状态
  │     └─ status === 'crashed' → throw new PluginError('PLUGIN_NOT_ACTIVE', ...)
  │
  ├─ 发送 load 消息:
  │     worker.postMessage({
  │       type: 'load',
  │       pluginPath,
  │       pluginId: handle.pluginIds[handle.pluginIds.length - 1],
  │     })
  │
  ├─ 等待 Worker 响应（通过 Promise +超时机制）:
  │     ├─ 成功: { type: 'loaded', pluginId }
  │     └─ 失败: { type: 'error', pluginId, error: string }
  │
  └─ 更新 handle.status = 'active', handle.lastActiveAt = Date.now()
```

> **注意**：load 消息的响应-等待机制通过 host 内部的 `pendingLoadPromises: Map<string, { resolve, reject }>` 实现，而非 RPC 层。因为 load 是 lifecycle 消息，不是 JSON-RPC 消息。

### 崩溃恢复流程

```
handleWorkerError(workerId, error)
  │
  ├─ 标记 handle.status = 'crashed'
  │
  ├─ 记录日志: console.error(`[plugin-host] Worker ${workerId} crashed:`, error)
  │
  ├─ 通知上层（PluginService）→ broker 广播:
  │     { type: 'plugin:crashed', payload: { pluginIds: handle.pluginIds, reason: error.message } }
  │
  ├─ 如果是 trusted Worker:
  │     ├─ 终止旧 Worker
  │     ├─ 收集 handle.pluginIds 中所有 trusted 插件 ID
  │     ├─ 创建新 Worker（复用 workerId）
  │     └─ 重新加载所有 trusted 插件（调用 loadPlugin）
  │           └─ 任一插件加载失败 → log + skip（不阻塞其他）
  │
  └─ 如果是 sandbox Worker:
        └─ 等待下次激活时由 PluginActivator 触发 assignWorker 重建
```

### 资源监控

```
startMemoryMonitor()
  │
  └─ setInterval(30_000ms, () => {
       for (const [workerId, handle] of workers) {
         if (handle.status !== 'active') continue
         const worker = workerInstances.get(workerId)
         if (!worker) continue

         // Node.js 20.17+: performance.threadMemoryUsage(worker)
         // 降级: worker.performance?.threadMemoryUsage?.() ?? null
         try {
           const mem = performance.threadMemoryUsage?.(worker) ?? null
           if (mem !== null) {
             handle.memoryUsage = mem.usedHeapSize
             const limit = handle.trustLevel === 'trusted'
               ? config.memoryLimitTrusted
               : config.memoryLimitSandbox
             if (mem.usedHeapSize > limit) {
               console.warn(`[plugin-host] Worker ${workerId} memory usage ${mem.usedHeapSize} exceeds limit ${limit}`)
             }
           }
         } catch {
           // performance.threadMemoryUsage not available (Node < 20.17)
         }
       }
     })
```

---

## FR-4: PluginRPC

### PluginRpcServer — 主线程侧

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-rpc-server.ts

import type { RpcRequest, RpcResponse, RpcNotification } from './plugin-types.js'

type RpcMethodHandler = (params: Record<string, unknown>) => Promise<unknown>

export class PluginRpcServer {
  /** 注册的 RPC 方法表 */
  private methods = new Map<string, RpcMethodHandler>()

  /** workerId → 消息处理回调（由 PluginHost 注入） */
  private workerSenders = new Map<string, (msg: RpcResponse | RpcNotification) => void>()

  /** 注册 RPC 方法 */
  registerMethod(method: string, handler: RpcMethodHandler): void

  /** 注入 Worker 的消息发送函数 */
  registerWorkerSender(workerId: string, send: (msg: RpcResponse | RpcNotification) => void): void

  /** 注销 Worker 的消息发送函数 */
  unregisterWorkerSender(workerId: string): void

  /** 收到 Worker 的 RPC 请求，路由到对应 handler */
  async dispatch(workerId: string, message: RpcRequest): Promise<void>

  /** 向指定 Worker 推送 RPC 通知 */
  notify(workerId: string, method: string, params: Record<string, unknown>): void

  /** 向所有活跃 Worker 广播 RPC 通知 */
  broadcast(method: string, params: Record<string, unknown>): void

  /** 清理所有 pending 请求 */
  dispose(): void
}
```

#### dispatch() 详细流程

```
PluginRpcServer.dispatch(workerId, message)
  │
  ├─ message 有 id (请求)?
  │     ├─ 是 → 请求-响应模式:
  │     │     ├─ 查找 methods.get(message.method)
  │     │     │     └─ 未找到 → sendError(workerId, message.id, METHOD_NOT_FOUND)
  │     │     ├─ await handler(message.params)
  │     │     │     ├─ 成功 → send({ jsonrpc: '2.0', id: message.id, result })
  │     │     │     └─ 异常 → send({ jsonrpc: '2.0', id: message.id, error: { code, message } })
  │     │     └─ 捕获超时（如果 Worker 已 terminated）
  │     │
  │     └─ 否 → 通知模式:
  │           ├─ 查找 methods.get(message.method)
  │           └─ handler(message.params)  // fire-and-forget，不回复
  │
  └─ 整个 dispatch 包在 try-catch 中，异常时发送 Internal Error 响应
```

### PluginRpcClient — Worker 侧

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-rpc-client.ts

import { parentPort } from 'node:worker_threads'
import type { RpcResponse, RpcNotification, Disposable } from './plugin-types.js'

export class PluginRpcClient {
  private nextId = 1
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
    timer: NodeJS.Timeout
  }>()
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  private defaultTimeout = 30_000  // 30s

  /** 发送 RPC 请求并等待响应 */
  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>

  /** 发送 RPC 通知（不等响应） */
  notify(method: string, params: Record<string, unknown>): void

  /** 注册通知处理器，返回 Disposable */
  onNotification(method: string, handler: (params: unknown) => void): Disposable

  /** 处理从主线程收到的 RPC 响应 */
  handleResponse(response: RpcResponse): void

  /** 处理从主线程收到的 RPC 通知 */
  handleNotification(notification: RpcNotification): void

  /** 销毁客户端，reject 所有 pending 请求 */
  dispose(): void
}
```

#### request() 详细流程

```
PluginRpcClient.request(method, params, timeoutMs)
  │
  ├─ const id = this.nextId++
  │
  ├─ 构造 Promise + 超时:
  │     const promise = new Promise((resolve, reject) => {
  │       const timer = setTimeout(() => {
  │         pending.delete(id)
  │         reject(new RpcError('RPC_TIMEOUT', -32000, `Request ${method} timed out`))
  │       }, timeoutMs ?? this.defaultTimeout)
  │
  │       pending.set(id, { resolve, reject, timer })
  │     })
  │
  ├─ 通过 parentPort 发送:
  │     parentPort!.postMessage({
  │       jsonrpc: '2.0',
  │       id,
  │       method,
  │       params,
  │     })
  │
  └─ return promise
```

#### handleResponse() 流程

```
handleResponse(response)
  │
  ├─ const entry = pending.get(response.id)
  │     └─ 不存在 → 忽略（可能是已超时的旧响应）
  │
  ├─ clearTimeout(entry.timer)
  ├─ pending.delete(response.id)
  │
  └─ 'error' in response?
        ├─ 是 → entry.reject(new RpcError(response.error.code, response.error.message))
        └─ 否 → entry.resolve(response.result)
```

---

## FR-5: PluginActivator + Bootstrap

### PluginActivator

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-activator.ts

import type {
  ActivationEvent,
  PluginDescriptor,
  PluginContext,
  PluginModule,
  PluginState,
} from './plugin-types.js'
import type { PluginRegistry } from './plugin-registry.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'

export class PluginActivator {
  private registry: PluginRegistry
  private host: PluginHost
  private rpcServer: PluginRpcServer

  /** 事件类型 → 插件 ID 列表的映射 */
  private eventMap = new Map<string, string[]>()

  /** 插件 ID → 当前生命周期状态 */
  private pluginStates = new Map<string, PluginState>()

  constructor(registry: PluginRegistry, host: PluginHost, rpcServer: PluginRpcServer) {
    this.registry = registry
    this.host = host
    this.rpcServer = rpcServer
  }

  /** 扫描所有 descriptor 的 activationEvents，建立 eventMap */
  registerActivationEvents(): void

  /** 触发激活事件，激活匹配的插件 */
  async handleEvent(event: ActivationEvent): Promise<void>

  /** 激活指定插件 */
  async activatePlugin(pluginId: string, event: ActivationEvent): Promise<void>

  /** 停用指定插件 */
  async deactivatePlugin(pluginId: string): Promise<void>

  /** 停用所有活跃插件 */
  async deactivateAll(): Promise<void>

  /** 获取所有活跃插件 ID */
  getActivePlugins(): string[]
}
```

#### registerActivationEvents() 逻辑

```
registerActivationEvents()
  │
  └─ for descriptor of registry.getAllDescriptors():
       │
       └─ for event of descriptor.activationEvents:
            │
            ├─ key = eventKey(event)
            │     // 'onSlashCommand:search'
            │     // 'onToolCall:webSearch'
            │     // 'onStartupFinished'
            │     // 'onSessionCreate'
            │
            └─ eventMap.get(key)?.push(descriptor.pluginId) ?? eventMap.set(key, [descriptor.pluginId])

function eventKey(event: ActivationEvent): string {
  switch (event.type) {
    case 'onSlashCommand':    return `onSlashCommand:${event.command}`
    case 'onToolCall':        return `onToolCall:${event.tool}`
    case 'onHook':            return `onHook:${event.event}`
    case 'onSessionCreate':   return 'onSessionCreate'
    case 'onStartupFinished': return 'onStartupFinished'
  }
}
```

#### handleEvent() 流程

```
handleEvent(event)
  │
  ├─ const key = eventKey(event)
  ├─ const pluginIds = eventMap.get(key) ?? []
  │
  └─ for pluginId of pluginIds:
       ├─ 当前状态不是 ACTIVE → activatePlugin(pluginId, event)
       └─ 已经 ACTIVE → 跳过
```

#### activatePlugin() 状态机

```
activatePlugin(pluginId, event)
  │
  ├─ state = pluginStates.get(pluginId) ?? 'UNLOADED'
  │
  ├─ state === 'ACTIVE' → return  // 已激活，幂等
  │
  ├─ state === 'LOADING' || state === 'ACTIVATING' → return  // 进行中，避免并发
  │
  ├─ pluginStates.set(pluginId, 'LOADING')
  │
  ├─ descriptor = registry.getDescriptor(pluginId)
  │     └─ 不存在 → throw PluginError('PLUGIN_NOT_FOUND')
  │
  ├─ host.assignWorker(pluginId, descriptor.trustLevel)
  │     └─ 失败 → pluginStates.set(pluginId, 'UNLOADED'), throw
  │
  ├─ host.loadPlugin(handle.workerId, descriptor.main)
  │     └─ 失败 → pluginStates.set(pluginId, 'UNLOADED'), throw
  │
  ├─ pluginStates.set(pluginId, 'ACTIVATING')
  │
  ├─ 向 Worker 发送 activate 消息:
  │     worker.postMessage({
  │       type: 'activate',
  │       pluginId,
  │       pluginDir: descriptor.pluginDir,
  │       event,
  │     })
  │
  ├─ 等待 Worker 响应:
  │     ├─ 成功: { type: 'activated', pluginId }
  │     └─ 失败: { type: 'error', pluginId, error }
  │
  ├─ 成功时:
  │     ├─ pluginStates.set(pluginId, 'ACTIVE')
  │     └─ registry.updateStatus(pluginId, 'active')
  │
  └─ 失败时:
        ├─ pluginStates.set(pluginId, 'UNLOADED')
        └─ registry.updateStatus(pluginId, 'discovered')
```

#### deactivatePlugin() 流程

```
deactivatePlugin(pluginId)
  │
  ├─ state = pluginStates.get(pluginId)
  │
  ├─ state !== 'ACTIVE' → return  // 未激活，幂等
  │
  ├─ pluginStates.set(pluginId, 'DEACTIVATING')
  │
  ├─ 获取 Worker:
  │     handle = host.getWorkerForPlugin(pluginId)
  │
  ├─ 向 Worker 发送 deactivate 消息:
  │     worker.postMessage({ type: 'deactivate', pluginId })
  │
  ├─ 等待响应（超时 10s，超时也继续清理）
  │
  ├─ sandbox Worker → terminateWorker（释放资源）
  │
  ├─ pluginStates.set(pluginId, 'UNLOADED')
  ├─ registry.updateStatus(pluginId, 'inactive')
  │
  └─ return
```

### Plugin Bootstrap — Worker 入口脚本

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts
//
// ⚠️ 此文件会被编译为 .js，由 new Worker(bootstrapPath) 加载

import { parentPort, workerData } from 'node:worker_threads'
import type { PluginModule, PluginContext, Disposable } from './plugin-types.js'
import { PluginRpcClient } from './plugin-rpc-client.js'

// ── Worker 全局状态 ──────────────────────────────────────────────

/** pluginId → { module, context, subscriptions } */
const loadedPlugins = new Map<string, {
  module: PluginModule
  context: PluginContext
}>()

/** JSON-RPC 客户端（与主线程通信） */
const rpcClient = new PluginRpcClient()

// ── 主消息循环 ──────────────────────────────────────────────────

parentPort!.on('message', (msg: Record<string, unknown>) => {
  switch (msg.type) {
    case 'load':
      return handleLoad(msg as { pluginId: string; pluginPath: string })
    case 'activate':
      return handleActivate(msg as { pluginId: string; pluginDir: string; event: unknown })
    case 'deactivate':
      return handleDeactivate(msg as { pluginId: string })
    case 'rpc':
      return handleRpc(msg as { response?: unknown; notification?: unknown })
    default:
      console.warn(`[plugin-bootstrap] Unknown message type: ${msg.type}`)
  }
})

// ── 异常兜底 ────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  parentPort!.postMessage({
    type: 'fatal_error',
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
})
```

#### handleLoad() — 模块加载

```
handleLoad({ pluginId, pluginPath })
  │
  ├─ try {
  │     const module = await import(pluginPath) as PluginModule
  │     loadedPlugins.set(pluginId, { module, context: null })
  │     parentPort!.postMessage({ type: 'loaded', pluginId })
  │   }
  │
  └─ catch (err) {
       parentPort!.postMessage({ type: 'error', pluginId, error: String(err) })
     }
```

#### handleActivate() — 插件激活

```
handleActivate({ pluginId, pluginDir, event })
  │
  ├─ entry = loadedPlugins.get(pluginId)
  │     └─ 不存在 → postMessage({ type: 'error', pluginId, error: 'Plugin not loaded' })
  │
  ├─ 构建 PluginContext:
  │     const context: PluginContext = {
  │       pluginId,
  │       extensionPath: pluginDir,
  │       api: createAgentAPI(pluginId, rpcClient),   // 冻结的代理对象
  │       globalState: createStateStorageProxy(pluginId, 'global', rpcClient),
  │       workspaceState: createStateStorageProxy(pluginId, 'workspace', rpcClient),
  │       subscriptions: [],
  │     }
  │
  ├─ Object.freeze(context)       // 防止插件篡改 context
  │
  ├─ try {
  │     await entry.module.activate(context)
  │     entry.context = context
  │     parentPort!.postMessage({ type: 'activated', pluginId })
  │   }
  │
  └─ catch (err) {
       parentPort!.postMessage({ type: 'error', pluginId, error: String(err) })
     }
```

#### handleDeactivate() — 插件停用

```
handleDeactivate({ pluginId })
  │
  ├─ entry = loadedPlugins.get(pluginId)
  │     └─ 不存在 → postMessage({ type: 'deactivated', pluginId })
  │
  ├─ try {
  │     // 调用插件的 deactivate()
  │     await entry.module.deactivate?.()
  │   } catch (err) {
  │     console.error(`[bootstrap] deactivate() threw for ${pluginId}:`, err)
  │   }
  │
  ├─ dispose 所有 subscriptions:
  │     for (const sub of entry.context?.subscriptions ?? []) {
  │       try { sub.dispose() } catch { /* best-effort */ }
  │     }
  │
  ├─ loadedPlugins.delete(pluginId)
  │
  └─ parentPort!.postMessage({ type: 'deactivated', pluginId })
```

#### createAgentAPI() — 构建 Phase1 最小 API

```typescript
function createAgentAPI(pluginId: string, rpc: PluginRpcClient): Phase1AgentAPI {
  const api: Phase1AgentAPI = {
    storage: {
      global: createStateStorageProxy(pluginId, 'global', rpc),
      workspace: createStateStorageProxy(pluginId, 'workspace', rpc),
    },
    notify: {
      async info(message: string): Promise<void> {
        rpc.notify('plugin.notify', { pluginId, level: 'info', message })
      },
      async warning(message: string): Promise<void> {
        rpc.notify('plugin.notify', { pluginId, level: 'warning', message })
      },
      async error(message: string): Promise<void> {
        rpc.notify('plugin.notify', { pluginId, level: 'error', message })
      },
    },
    sessions: {
      async list(): Promise<SessionInfo[]> {
        return rpc.request('plugin.sessions.list', { pluginId }) as Promise<SessionInfo[]>
      },
    },
    events: {
      on(event: string, handler: (data: unknown) => void): Disposable {
        const method = `plugin.events.${event}`
        rpc.onNotification(method, handler)
        return { dispose: () => { /* remove handler */ } }
      },
      emit(event: string, data: unknown): void {
        rpc.notify(`plugin.events.${event}`, { pluginId, data })
      },
    },
  }
  return deepFreeze(api)
}
```

#### createStateStorageProxy() — KV 存储代理

```typescript
function createStateStorageProxy(
  pluginId: string,
  scope: 'global' | 'workspace',
  rpc: PluginRpcClient,
): PluginStateStorage {
  const prefix = `plugin.storage.${scope}`
  return {
    async get<T>(key: string): Promise<T | undefined>
    async get<T>(key: string, defaultValue: T): Promise<T>
    async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
      const result = await rpc.request(`${prefix}.get`, { pluginId, key })
      return (result as T | undefined) ?? defaultValue
    },

    async set(key: string, value: unknown): Promise<void> {
      await rpc.request(`${prefix}.set`, { pluginId, key, value })
    },

    async delete(key: string): Promise<void> {
      await rpc.request(`${prefix}.delete`, { pluginId, key })
    },

    async keys(): Promise<string[]> {
      return rpc.request(`${prefix}.keys`, { pluginId }) as Promise<string[]>
    },
  }
}
```

---

## FR-6: PluginStorage

### 类结构

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-storage.ts

export class PluginStorage {
  /** pluginId → scope → Map<key, value> */
  private cache = new Map<string, {
    global: Map<string, unknown>
    workspace: Map<string, unknown>
  }>()

  /** pluginId → scope → dirty 标记 */
  private dirty = new Map<string, { global: boolean; workspace: boolean }>()

  /** pluginId → debounce timer */
  private flushTimers = new Map<string, NodeJS.Timeout>()

  private baseDir: string = ''
  private projectRoot: string = ''

  /** 初始化存储目录 */
  async init(baseDir: string, projectRoot: string): Promise<void>

  /** 读取值 */
  async get(pluginId: string, scope: 'global' | 'workspace', key: string): Promise<unknown | undefined>

  /** 设置值（带大小检查 + 延迟写入） */
  async set(pluginId: string, scope: 'global' | 'workspace', key: string, value: unknown): Promise<void>

  /** 删除键 */
  async delete(pluginId: string, scope: 'global' | 'workspace', key: string): Promise<void>

  /** 获取所有键 */
  async keys(pluginId: string, scope: 'global' | 'workspace'): Promise<string[]>

  /** 强制刷写指定插件到磁盘 */
  async flush(pluginId: string): Promise<void>

  /** 刷写所有插件到磁盘 */
  async flushAll(): Promise<void>

  /** 外部修改通知（强制下次 get 从磁盘重读） */
  onExternalChange(pluginId: string): void
}
```

### 文件路径映射

```
global:    ~/.xyz-agent/plugins/<pluginId>/data/globalState.json
workspace: ~/.xyz-agent/plugins/<pluginId>/data/workspace/<workspace-hash>/workspaceState.json

workspace-hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)
```

### init() 流程

```
init(baseDir, projectRoot)
  │
  ├─ this.baseDir = baseDir        // ~/.xyz-agent/plugins
  ├─ this.projectRoot = projectRoot
  │
  └─ mkdir(baseDir, { recursive: true })
```

### get() 流程

```
get(pluginId, scope, key)
  │
  ├─ 确保 pluginCache 已初始化:
  │     if (!cache.has(pluginId)) → loadFromDisk(pluginId, scope)
  │
  └─ return pluginCache[scope].get(key)
```

### set() 流程

```
set(pluginId, scope, key, value)
  │
  ├─ 大小检查:
  │     valueJson = JSON.stringify(value)
  │     if (valueJson.length > 1 * 1024 * 1024):
  │       throw new PluginStorageError('PAYLOAD_TOO_LARGE', -32021)
  │
  ├─ 总大小检查:
  │     currentSize = computeTotalSize(pluginCache[scope])
  │     if (currentSize + valueJson.length > 10 * 1024 * 1024):
  │       throw new PluginStorageError('STORAGE_FULL', -32040)
  │
  ├─ cache.get(pluginId)[scope].set(key, value)
  │
  ├─ 标记 dirty:
  │     dirty.get(pluginId)[scope] = true
  │
  └─ 触发延迟写入:
       scheduleFlush(pluginId)  // 500ms debounce
```

### 延迟写入（Debounced Flush）

```
scheduleFlush(pluginId)
  │
  ├─ 清除旧 timer
  │     const old = flushTimers.get(pluginId)
  │     if (old) clearTimeout(old)
  │
  └─ 设置新 timer:
       flushTimers.set(pluginId, setTimeout(() => {
         flushTimers.delete(pluginId)
         flush(pluginId).catch((err) => {
           console.error(`[plugin-storage] flush failed for ${pluginId}:`, err)
         })
       }, 500))
```

### flush() — 原子写入

```
flush(pluginId)
  │
  ├─ pluginDirty = dirty.get(pluginId)
  │     └─ 全部 clean → return
  │
  ├─ for scope of ['global', 'workspace']:
  │     │
  │     ├─ pluginDirty[scope] !== true → continue
  │     │
  │     ├─ filePath = getStoragePath(pluginId, scope)
  │     ├─ data = Object.fromEntries(cache.get(pluginId)[scope])
  │     ├─ json = JSON.stringify(data, null, 2)
  │     │
  │     ├─ 确保目录存在:
  │     │     mkdir(dirname(filePath), { recursive: true })
  │     │
  │     ├─ 原子写入:
  │     │     writeFile(filePath + '.tmp', json, 'utf-8')
  │     │     rename(filePath + '.tmp', filePath)
  │     │
  │     └─ pluginDirty[scope] = false
  │
  └─ return
```

### loadFromDisk() — 启动时加载

```
loadFromDisk(pluginId, scope)
  │
  ├─ filePath = getStoragePath(pluginId, scope)
  │
  ├─ try {
  │     raw = await readFile(filePath, 'utf-8')
  │     data = JSON.parse(raw) as Record<string, unknown>
  │     cacheMap = new Map(Object.entries(data))
  │   }
  │
  ├─ catch (ENOENT) {
  │     cacheMap = new Map()  // 文件不存在，空缓存
  │   }
  │
  └─ catch (parse error) {
       console.warn(`[plugin-storage] Corrupt state file for ${pluginId}/${scope}, resetting`)
       cacheMap = new Map()
     }
```

---

## FR-7: 类型定义

### plugin-types.ts — Runtime 内部完整类型

```typescript
// src-electron/runtime/src/services/plugin-service/plugin-types.ts

// ── Manifest 类型 ────────────────────────────────────────────────

export interface XyzAgentManifest {
  manifestVersion: 1
  main: string
  engines: { 'xyz-agent': string }
  contributes?: PluginContributes
  activationEvents?: ActivationEvent[]
  permissions?: PluginPermission[]
  trustLevel?: 'trusted' | 'sandbox'
}

// ── Contributes 类型 ─────────────────────────────────────────────

export interface PluginContributes {
  slashCommands?: SlashCommandContribution[]
  tools?: ToolContribution[]
  hooks?: HookContribution[]
  panels?: PanelContribution[]
  statusBarItems?: StatusBarItemContribution[]
}

export interface SlashCommandContribution {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

export interface ToolContribution {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface HookContribution {
  event: string
  description: string
}

export interface PanelContribution {
  id: string
  title: string
  location: 'sidebar' | 'drawer' | 'panel'
  icon?: string
}

export interface StatusBarItemContribution {
  id: string
  alignment: 'left' | 'right'
  priority: number
  text: string
  tooltip?: string
}

// ── Descriptor 类型 ──────────────────────────────────────────────

export interface PluginDescriptor {
  pluginId: string
  version: string
  displayName: string
  description: string
  main: string               // 入口文件的绝对路径
  activationEvents: ActivationEvent[]
  trustLevel: 'trusted' | 'sandbox'
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  contributes?: PluginContributes
  permissions: PluginPermission[]
  engines: { 'xyz-agent': string }
  manifestPath: string
  pluginDir: string
}

// ── Activation Event 类型 ────────────────────────────────────────

export type ActivationEvent =
  | { type: 'onSlashCommand'; command: string }
  | { type: 'onToolCall'; tool: string }
  | { type: 'onHook'; event: string }
  | { type: 'onSessionCreate' }
  | { type: 'onStartupFinished' }

// ── Worker 类型 ──────────────────────────────────────────────────

export interface WorkerHandle {
  workerId: string            // "trusted-0" | "sandbox-<pluginId>"
  threadId: number
  trustLevel: 'trusted' | 'sandbox'
  pluginIds: string[]
  status: 'idle' | 'active' | 'crashed' | 'terminated'
  lastActiveAt: number
  memoryUsage?: number        // bytes
}

export interface WorkerPoolConfig {
  trustedWorkerCapacity: number    // 默认 10
  idleTimeout: number              // ms，默认 60000
  memorySampleInterval: number     // ms，默认 30000
  memoryLimitTrusted: number       // bytes，默认 256MB
  memoryLimitSandbox: number       // bytes，默认 128MB
}

// ── Plugin Context 类型 ─────────────────────────────────────────

export interface PluginContext {
  readonly pluginId: string
  readonly extensionPath: string
  readonly api: Phase1AgentAPI
  readonly globalState: PluginStateStorage
  readonly workspaceState: PluginStateStorage
  readonly subscriptions: Disposable[]
}

export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

// ── AgentAPI 类型（Phase 1 最小集）───────────────────────────────

export interface Phase1AgentAPI {
  readonly storage: {
    readonly global: PluginStateStorage
    readonly workspace: PluginStateStorage
  }
  readonly notify: {
    info(message: string): Promise<void>
    warning(message: string): Promise<void>
    error(message: string): Promise<void>
  }
  readonly sessions: {
    list(): Promise<SessionInfo[]>
  }
  readonly events: {
    on(event: string, handler: (data: unknown) => void): Disposable
    emit(event: string, data: unknown): void
  }
}

export interface SessionInfo {
  id: string
  label: string
  cwd: string
  status: 'active' | 'idle' | 'error'
  createdAt: number
  lastActiveAt: number
}

// ── Storage 类型 ─────────────────────────────────────────────────

export interface PluginStateStorage {
  get<T>(key: string): Promise<T | undefined>
  get<T>(key: string, defaultValue: T): Promise<T>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

// ── RPC 类型 ─────────────────────────────────────────────────────

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

export interface RpcSuccessResponse {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface RpcErrorResponse {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params: Record<string, unknown>
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification

// ── Lifecycle 消息类型（Worker ↔ 主线程）────────────────────────

/** 主线程 → Worker 的生命周期消息 */
export type HostToWorkerMessage =
  | { type: 'load'; pluginId: string; pluginPath: string }
  | { type: 'activate'; pluginId: string; pluginDir: string; event: ActivationEvent }
  | { type: 'deactivate'; pluginId: string }
  | { type: 'rpc'; response?: RpcResponse; notification?: RpcNotification }

/** Worker → 主线程的生命周期消息 */
export type WorkerToHostMessage =
  | { type: 'loaded'; pluginId: string }
  | { type: 'activated'; pluginId: string }
  | { type: 'deactivated'; pluginId: string }
  | { type: 'error'; pluginId: string; error: string }
  | { type: 'fatal_error'; error: string; stack?: string }
  | { type: 'rpc' } & (RpcRequest | RpcNotification)

// ── 通用类型 ─────────────────────────────────────────────────────

export interface Disposable {
  dispose(): void
}

export type PluginPermission = string  // Phase 1 仅做存储，不做运行时检查

export type PluginState = 'UNLOADED' | 'LOADING' | 'ACTIVATING' | 'ACTIVE' | 'DEACTIVATING' | 'CRASHED'

// ── Error Codes ──────────────────────────────────────────────────

export const PluginRpcErrorCodes = {
  RPC_TIMEOUT: -32000,
  PERMISSION_DENIED: -32001,
  PLUGIN_NOT_FOUND: -32010,
  PLUGIN_NOT_ACTIVE: -32011,
  STORAGE_FULL: -32040,
  PAYLOAD_TOO_LARGE: -32021,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
} as const

export type PluginRpcErrorCode = typeof PluginRpcErrorCodes[keyof typeof PluginRpcErrorCodes]
```

### shared/protocol.ts — 新增消息类型

```typescript
// 新增到 ClientMessageMap:
'plugin.list': Record<string, never>
'plugin.toggle': { pluginId: string; enabled: boolean }

// 新增到 ClientMessage discriminated union:
| { type: 'plugin.list'; id?: string; payload: Record<string, never> }
| { type: 'plugin.toggle'; id?: string; payload: { pluginId: string; enabled: boolean } }

// 新增到 ServerMessageType:
'config.plugins'           // 插件列表（初始化 + toggle 后推送）
'plugin:crashed'           // Worker 崩溃通知
'plugin:notification'      // 插件 notify 消息（info/warning/error）

// 新增 payload interface:
export interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  enabled: boolean
}
```

---

## FR-8: Server 集成

### interfaces.ts 变更

```typescript
// 新增到 src-electron/runtime/src/interfaces.ts

import type { PluginDescriptor } from './services/plugin-service/plugin-types.js'

export interface IPluginService {
  initialize(): Promise<void>
  getDiscoveredPlugins(): PluginDescriptor[]
  togglePlugin(pluginId: string, enabled: boolean): Promise<PluginDescriptor[]>
  shutdown(): Promise<void>
}
```

### server.ts 变更

#### setServices() 签名变更

```typescript
// 旧:
setServices(session, config, model, tree, extension?): void

// 新:
setServices(session, config, model, tree, extension?, plugin?): void
```

#### 新增消息路由

在 `handleMessage()` 的 switch 中新增:

```typescript
case 'plugin.list': {
  if (!this.pluginService) {
    return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins: [] } })
  }
  const plugins = this.pluginService.getDiscoveredPlugins()
  return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins } })
}

case 'plugin.toggle': {
  if (!this.pluginService) {
    return this.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
  }
  const plugins = await this.pluginService.togglePlugin(msg.payload.pluginId, msg.payload.enabled)
  return this.send(ws, { type: 'config.plugins', id: msg.id, payload: { plugins } })
}
```

#### sendInitialState() 新增

```typescript
// 在 sendInitialState() 中追加:
try {
  if (this.pluginService) {
    const plugins = this.pluginService.getDiscoveredPlugins()
    this.send(ws, { type: 'config.plugins', id: this.nextPushId(), payload: { plugins } })
  }
} catch (e) { console.error('[runtime] sendInitialState: config.plugins failed:', e) }
```

#### stop() 变更

```typescript
async stop(): Promise<void> {
  if (this.pluginService) await this.pluginService.shutdown()  // ← 新增
  await this.sessionService.destroyAll()
  // ...其余不变
}
```

### index.ts 变更

```typescript
// 新增导入:
import { PluginRegistry } from './services/plugin-service/plugin-registry.js'
import { PluginService } from './services/plugin-service/plugin-service.js'

// main() 中新增:
const pluginRegistry = new PluginRegistry(effectiveRoot)
const pluginService = new PluginService(pluginRegistry, server)
server.setServices(sessionService, configService, modelService, treeService, extensionService, pluginService)

// 初始化流程:
await sessionService.initialize()  // 已有
await configService.initialize()   // 已有
await pluginService.initialize()   // ← 新增
```

---

## 错误处理策略

### 分层错误模型

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: Plugin Crash (Worker Thread 级别)                      │
│  ─────────────────────────────────────────                       │
│  触发: Worker uncaughtException / worker.on('error')             │
│  处理: PluginHost.handleWorkerError()                            │
│  影响: Worker 内所有插件标记为 CRASHED                            │
│  恢复: trusted → 自动重建 Worker + 重新加载                       │
│        sandbox → 等待下次激活时重建                               │
│  通知: 前端收到 plugin:crashed 消息                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: Plugin Activation Error (单个插件级别)                  │
│  ─────────────────────────────────────────────────               │
│  触发: activate() 抛异常 / import() 失败                         │
│  处理: PluginActivator.activatePlugin() try-catch                │
│  影响: 仅该插件回到 UNLOADED，其他插件不受影响                     │
│  恢复: 下次触发相同激活事件时重新尝试                               │
│  通知: console.error + Worker 响应 error 消息                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: RPC Error (单次调用级别)                                │
│  ─────────────────────────────────────────────                   │
│  触发: RPC handler 抛异常 / 超时 / 方法不存在                     │
│  处理: PluginRpcServer.dispatch() → error response               │
│  影响: 仅该次 RPC 调用失败                                        │
│  恢复: 插件可自行重试                                              │
│  通知: Worker 内 RpcClient reject promise                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Layer 4: Storage Error (持久化级别)                              │
│  ─────────────────────────────────────────                       │
│  触发: 文件写入失败 / 磁盘满 / 大小超限                            │
│  处理: PluginStorage.set() → throw PluginStorageError            │
│  影响: 该次 set() 调用失败，缓存中不更新                            │
│  恢复: 插件可自行处理（减小数据 / 删除旧数据）                      │
│  通知: 通过 RPC error response 传播到 Worker                      │
└─────────────────────────────────────────────────────────────────┘
```

### 错误码映射

```typescript
// JSON-RPC 标准错误码
-32700  Parse error           // JSON 解析失败
-32600  Invalid Request       // 请求格式错误
-32601  Method not found      // 未注册的 RPC 方法
-32603  Internal error        // handler 内部异常

// Plugin 自定义错误码（-32000 ~ -32099）
-32000  RPC_TIMEOUT           // RPC 请求超时
-32001  PERMISSION_DENIED     // 权限不足
-32010  PLUGIN_NOT_FOUND      // 插件未发现
-32011  PLUGIN_NOT_ACTIVE     // 插件未激活
-32021  PAYLOAD_TOO_LARGE     // 单个 value > 1MB
-32040  STORAGE_FULL          // 总存储 > 10MB
```

### 错误传播路径

```
Worker 内插件代码 throw
  │
  ├─ 在 activate() 中 → bootstrap catch → postMessage({ type: 'error' })
  │                                    → PluginActivator 标记 UNLOADED
  │
  ├─ 在 RPC handler 回调中 → 不可能（Phase 1 没有插件注册的 handler）
  │
  └─ 在 deactivate() 中 → bootstrap catch + best-effort dispose
                         → postMessage({ type: 'deactivated' })

RPC 调用失败
  │
  └─ PluginRpcServer.dispatch() catch → send error response
                                     → Worker 内 RpcClient reject
                                     → 插件拿到 rejected Promise

Storage 操作失败
  │
  └─ PluginStorage.set() throw
     → PluginRpcServer.dispatch() catch → send error response
                                       → Worker 内 storage proxy reject
```

---

## 初始化 + 关闭时序

### 完整初始化时序图

```
main() in index.ts
  │
  ├─ SidecarServer.start()              // HTTP + WebSocket 就绪
  │
  ├─ sessionService.initialize()        // 恢复 session
  ├─ configService.initialize()         // 加载配置
  │
  ├─ pluginService.initialize()         // ← 新增
  │     │
  │     ├─ 1. registry.scan()
  │     │     ├─ 扫描 ~/.xyz-agent/plugins/
  │     │     ├─ 扫描 <cwd>/.xyz-agent/plugins/
  │     │     ├─ 解析 manifest + 版本检查
  │     │     └─ 推断 activationEvents
  │     │
  │     ├─ 2. storage.init(baseDir, projectRoot)
  │     │
  │     ├─ 3. registerRpcMethods()
  │     │     ├─ plugin.storage.get/set/delete/keys
  │     │     ├─ plugin.sessions.list
  │     │     └─ plugin.notify
  │     │
  │     ├─ 4. activator.registerActivationEvents()
  │     │     └─ 建立 eventMap
  │     │
  │     ├─ 5. host.initialize()
  │     │     └─ 懒初始化，不预创建 Worker
  │     │
  │     ├─ 6. activator.handleEvent({ type: 'onStartupFinished' })
  │     │     └─ 激活声明了 onStartupFinished 的插件
  │     │           ├─ assignWorker → createWorker → loadPlugin → activate
  │     │           └─ 失败 → log + skip
  │     │
  │     └─ 7. broker.broadcast({ type: 'config.plugins', ... })
  │
  └─ console.log('[runtime] ready')
```

### 完整关闭时序图

```
shutdown() on SIGINT/SIGTERM
  │
  ├─ pluginService.shutdown()           // ← 新增
  │     │
  │     ├─ 1. activator.deactivateAll()
  │     │     ├─ for each active plugin:
  │     │     │     ├─ Worker.postMessage({ type: 'deactivate', pluginId })
  │     │     │     ├─ 等待 { type: 'deactivated' } (超时 5s)
  │     │     │     └─ dispose subscriptions
  │     │     └─ 清空 pluginStates
  │     │
  │     ├─ 2. host.shutdown()
  │     │     ├─ 清除 memory monitor timer
  │     │     ├─ for each worker:
  │     │     │     └─ worker.terminate()
  │     │     └─ 清空 workers + workerInstances
  │     │
  │     ├─ 3. storage.flushAll()
  │     │     ├─ 清除所有 flush timers
  │     │     └─ 逐个 flush（原子写入）
  │     │
  │     └─ 4. rpcServer.dispose()
  │           └─ reject 所有 pending 请求
  │
  ├─ sessionService.destroyAll()        // 已有
  │
  └─ server.stop()                      // 已有
       └─ wss.close() + httpServer.close()
```
