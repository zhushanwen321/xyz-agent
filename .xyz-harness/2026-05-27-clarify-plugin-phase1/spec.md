---
verdict: pass
---

# Spec — 插件系统 Phase 1: 核心基础设施

## Background

xyz-agent 当前已有 Extension 系统（管理 pi 侧的 extension），但没有自己的 Plugin 系统。Plugin 系统与 Extension 系统的关键区别：

- Extension 在 pi 进程内运行，xyz-agent 只做管理和 UI 桥接
- Plugin 在 Sidecar 的 Worker Thread 中运行，有自己的 API、生命周期、安全模型

Phase 1 的目标是搭建 Plugin 系统的骨架：让插件能被发现、加载、激活、停用。实现 Worker Thread 隔离 + JSON-RPC 通信 + 最小 agentAPI。

## Functional Requirements

### FR-1: PluginService — 插件生命周期管理入口

Sidecar 中新增 `PluginService` 模块，作为插件系统的顶层入口，与现有 Service（SessionService、ConfigService 等）平级。

**职责**：协调 PluginRegistry、PluginHost、PluginActivator、PluginStorage 四个子模块，对外暴露统一的 `IPluginService` 接口。

**依赖方向**：
```
PluginService
  ├── PluginRegistry    (manifest 解析 + 发现)
  ├── PluginHost           (Worker Thread 池)
  ├── PluginActivator      (懒激活逻辑)
  └── PluginStorage        (KV 持久化)
```

**DI 注入**：构造函数接受 PluginRegistry，后者在 `index.ts` 中创建并注入。PluginHost、PluginActivator、PluginStorage 在 PluginService 内部创建。

**初始化流程**：
1. `initialize()` → PluginRegistry.scan() → 取得到所有 PluginDescriptor
2. 初始化 PluginStorage（确保数据目录存在）
3. 初始化 PluginHost（创建 Worker 池）
4. 将声明式扩展点（slashCommands、tools 等）注册到对应 Service
5. 等待激活事件

### FR-2: PluginRegistry — 插件发现 + Manifest 解析

**扫描路径**（与 ExtensionService 类似但独立）：
- 用户级：`~/.xyz-agent/plugins/<pluginId>/`
- 项目级：`<cwd>/.xyz-agent/plugins/<pluginId>/`

**扫描规则**：每个子目录必须包含 `package.json`，且包含 `xyzAgent` 字段。

**Manifest 解析**：从 `package.json` 的 `xyzAgent` 字段解析出以下信息：
- `manifestVersion: 1`（版本检查）
- `main: string`（入口文件相对路径）
- `engines.xyz-agent: string`（semver 兼容性检查）
- `contributes?`（声明式扩展点）
- `activationEvents?`（激活事件，可省略，从 contributes 自动推断）
- `permissions?`（权限声明）
- `trustLevel?`（信任等级，默认 untrusted）

**自动推断 activationEvents**：从 contributes 推导：
- `contributes.slashCommands` → `onSlashCommand:<name>`
- `contributes.tools` → `onToolCall:<name>`
- `contributes.hooks` → `onHook:<event>`
- `contributes.panels` → `onStartupFinished`
- `contributes.statusBarItems` → `onStartupFinished`

**缓存**：扫描结果缓存在 `Map<pluginId, PluginDescriptor>` 中，仅在 `reload()` 时刷新。

**激活事件注册**：扫描完成后，将 activationEvents 注册到 PluginActivator 的事件监听器映射表中，等待触发。

### FR-3: PluginHost — Worker Thread 池管理

**Worker 分组策略**：
- trusted 插件：共享一个 Worker Thread（默认 1 个，最大 10 个插件）
- untrusted 插件：每个独占一个 Worker Thread（崩溃隔离）

**Worker 生命周期**：

```
assignWorker(pluginId, trustLevel)
  → 查找可用 Worker（trusted：检查容量；untrusted：新建）
  → 如果无可用 → 新建 Worker(`new Worker(bootstrapPath, { workerData })`)
  → 返回 WorkerHandle

loadPlugin(workerId, pluginPath)
  → 通过 Worker 的 parentPort 发送 { type: 'load', pluginPath }
  → Worker 内 `import(pluginPath)` 加载插件入口模块
  → 返回 { pluginId, status: 'loaded' }

activatePlugin(pluginId, event)
  → 发送 { type: 'activate', pluginId, event }
  → Worker 内调用 `module.activate(context)`
  → 注入 agentAPI 代理（冻结对象）
  → 状态变为 ACTIVE

deactivatePlugin(pluginId)
  → 发送 { type: 'deactivate', pluginId }
  → Worker 内调用 `module.deactivate()` + dispose subscriptions
  → 状态变为 UNLOADED

terminateWorker(workerId)
  → worker.terminate()
  → 清理 resource trackers
  → 通知 PluginService（→ 前端 "plugin:crashed"）
```

**崩溃恢复**：
- `worker.on('error')` → 捕获 → 标记 WorkerHandle.status = 'crashed'
- trusted Worker → 自动重建，重新加载所有 trusted 插件
- untrusted Worker → 等待下次激活时重建
- 通知前端 "plugin:crashed": [{ pluginId: "A", reason: "..." }]

**资源监控**（通过 `worker.threadId` 调用 `performance.threadMemoryUsage()`，Node.js 20.17+ 可用）：
- 定期（每 30s）采样内存使用量，超过阈值（256MB trusted / 128MB sandbox）时 warn

**WorkerHandle 接口**：
```typescript
interface WorkerHandle {
  workerId: string;          // "trusted-0" | "sandbox-<pluginId>"
  threadId: number;
  trustLevel: 'trusted' | 'sandbox';
  pluginIds: string[];       // 该 Worker 内已加载的插件 ID
  status: 'idle' | 'active' | 'crashed' | 'terminated';
  lastActiveAt: number;
  memoryUsage?: number;      // bytes
}
```

### FR-4: PluginRPC — JSON-RPC 2.0 over MessagePort

**协议**：遵循 JSON-RPC 2.0 规范，自实现 ~200 行，零外部依赖。

**消息格式**：
- Request: `{ jsonrpc: "2.0", id: number, method: string, params: Record<string, unknown> }`
- Success Response: `{ jsonrpc: "2.0", id: number, result: unknown }`
- Error Response: `{ jsonrpc: "2.0", id: number, error: { code: number, message: string, data?: unknown } }`
- Notification: `{ jsonrpc: "2.0", method: string, params: Record<string, unknown> }` (no id)

**传输层**：Worker 的 `parentPort.postMessage()` + `structuredClone` 序列化。

**主线程侧（PluginRpcServer）**：
- `registerMethod(method, handler)` — 注册 RPC 方法
- `notify(workerId, method, params)` — 向指定 Worker 推送通知
- `broadcast(method, params)` — 向所有活跃 Worker 广播通知
- 请求-响应映射：`Map<requestId, { resolve, reject, timeout }>` 
- 超时：默认 30s，超时返回 `PLUGIN_RPC_TIMEOUT (-32000)` 错误

**Worker 侧（PluginRpcClient）**：
- `request(method, params)` → Promise<unknown> — 发送请求并等待响应
- `notify(method, params)` → void — 发送通知（不等响应）
- `onNotification(method, handler)` → Disposable — 注册通知处理器
- 自增 requestId（从 1 开始，Worker 侧独立维护）

**RPC 方法注册（Phase 1 最小集）**：
```
主线程侧：
  "plugin.storage.get"      → PluginStorage.get(pluginId, key)
  "plugin.storage.set"      → PluginStorage.set(pluginId, key, value)
  "plugin.storage.delete"   → PluginStorage.delete(pluginId, key)
  "plugin.storage.keys"     → PluginStorage.keys(pluginId)
```

**错误码定义**：
```typescript
const PluginRpcErrorCodes = {
  RPC_TIMEOUT: -32000,
  PERMISSION_DENIED: -32001,
  PLUGIN_NOT_FOUND: -32010,
  PLUGIN_NOT_ACTIVE: -32011,
  STORAGE_FULL: -32040,
} as const;
```

### FR-5: PluginActivator — 懒激活 + 生命周期状态机

**激活事件类型**（Phase 1 支持）：
```typescript
type ActivationEvent =
  | { type: 'onSlashCommand'; command: string }
  | { type: 'onToolCall'; tool: string }
  | { type: 'onSessionCreate' }
  | { type: 'onStartupFinished' };
```

**状态机**（每个插件独立追踪）：

```
UNLOADED → LOADING → ACTIVATING → ACTIVE
                ↘ (加载失败，回到 UNLOADED)

UNLOADED ← DEACTIVATING ← ACTIVE
(停用后回到 UNLOADED，可重新激活)

CRASHED (Worker 崩溃，自动恢复或等待)
```

**PluginContext 构造**（Phase 1 最小集）：
```typescript
interface PluginContext {
  readonly pluginId: string;
  readonly extensionPath: string;
  readonly api: Phase1AgentAPI;      // 冻结的代理对象
  readonly globalState: PluginStateStorage;    // KV 代理
  readonly workspaceState: PluginStateStorage; // KV 代理
  readonly subscriptions: Disposable[];
}
```

**PluginModule 签名**：
```typescript
interface PluginModule {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

**Worker Bootstrap（`plugin-bootstrap.ts`）**：
1. 监听 `parentPort.on('message')`
2. 处理 `{ type: 'load' }` → `import(pluginPath)` → 缓存 `module` 对象
3. 处理 `{ type: 'activate' }` → 创建 PluginContext → 注入 agentAPI 代理（冻结） → `module.activate(ctx)`
4. 处理 `{ type: 'deactivate' }` → `module.deactivate()` → dispose subscriptions
5. 处理 `{ type: 'rpc' }` → 路由到 JSON-RPC client dispatcher
6. 捕获未处理异常 → 通过 parentPort 通知主线程

**Phase 1 agentAPI 最小集**：
```typescript
interface Phase1AgentAPI {
  readonly storage: {
    readonly global: PluginStateStorage;
    readonly workspace: PluginStateStorage;
  };
  readonly notify: {
    info(message: string): Promise<void>;
    warning(message: string): Promise<void>;
    error(message: string): Promise<void>;
  };
  readonly sessions: {
    list(): Promise<SessionInfo[]>;
  };
  readonly events: {
    on(event: string, handler: (data: unknown) => void): Disposable;
    emit(event: string, data: unknown): void;
  };
}
```

**notify 的实现**：Worker 侧通过 `PluginRpcClient.notify('plugin.notify', { pluginId, level: 'info'|'warning'|'error', message })` 发送通知，主线程 PluginRpcServer 收到后通过 `IMessageBroker.sendEvent` 广播到前端。

### FR-6: PluginStorage — KV 持久化

**存储后端**：
- globalState：`~/.xyz-agent/plugins/<pluginId>/data/globalState.json`
- workspaceState：`~/.xyz-agent/plugins/<pluginId>/data/workspace/<workspace-hash>/workspaceState.json`

**写入策略**：
- 内存缓存（Map + ReadWriteLock）
- 延迟批量写入：500ms debounce 后 `writeFile(temp) + rename`（原子操作）
- 多插件并发写互不阻塞（每个 pluginId 独立锁）

**限制**：
- 每个插件总存储 10MB（所有 key 的 JSON 序列化后的总大小）
- 单个 value 最大 1MB
- 超出限制返回 `STORAGE_FULL (-32040)` 错误

**接口**：
```typescript
interface PluginStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(key: string, defaultValue: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

### FR-7: 类型定义 — 共享 + Runtime 双轨

**共享类型（`src-electron/shared/src/`）**：
- `PluginDescriptor`（pluginId, version, status, trustLevel, contributes 摘要）
- 新增 ClientMessage 类型：`plugin.list`、`plugin.toggle`、`plugin.install`（stub）、`plugin.notification`
- 新增 ServerMessage 类型：`config.plugins`、`plugin:crashed`、`plugin:notification`

**Runtime 类型（`src-electron/runtime/src/services/plugin-service/`）**：
- `plugin-types.ts`：完整类型（XyzAgentManifest、PluginContributes、ActivationEvent、WorkerHandle、PluginContext、PluginStateStorage、Disposable、Event 等，按设计文档 Part 1/2 的定义）
- 所有类型禁止 `any`

### FR-8: Server 集成 — 消息路由 + 生命周期

**server.ts 变更**：
- `setServices()` 新增可选的 `pluginService?: IPluginService` 参数
- 新增消息处理：
  - `plugin.list` → `pluginService.getDiscoveredPlugins()` → `config.plugins`
  - `plugin.toggle` → `pluginService.togglePlugin(pluginId, enabled)` → `config.plugins`
  - `plugin.notification` → 转发给前端（通过 event-bus）

**index.ts 变更**：
- 创建 `PluginRegistry` → `PluginService`
- `server.setServices(..., pluginService)` 中传入

**初始化时序**：
```
SidecarServer.start()
  → sessionService.initialize()
  → configService.initialize()
  → pluginService.initialize()  ← 新增
    → PluginRegistry.scan()
    → PluginStorage.init()
    → PluginHost.initialize()
    → 注册声明式扩展点
    → 广播 config.plugins
```

**关闭流程**：
```
SidecarServer.stop()
  → pluginService.shutdown()  ← 新增
    → 停用所有活跃插件（deactivate）
    → terminate 所有 Worker
    → PluginStorage.flushAll()
```

### FR-9: 集成测试 — 端到端验证

创建一个 `hello-world` 测试插件，验证完整链路：

1. 插件目录结构：
```
test/fixtures/plugins/hello-world/
  ├── package.json       (含 xyzAgent 字段，main: "index.js")
  └── index.js           (activate/deactivate 函数)
```

2. 测试场景：
   - TC-1: PluginRegistry.scan() 发现并解析 manifest
   - TC-2: PluginHost 分配 Worker + 加载插件模块
   - TC-3: PluginActivator 触发 onStartupFinished → activate(context) 被调用
   - TC-4: context.api.storage.global.set(key, value) → globalState.json 写入
   - TC-5: context.api.notify.info("hello") → 前端收到 plugin:notification 消息
   - TC-6: deactivate() → subscription 被 dispose → storage 刷新到磁盘
   - TC-7: Worker crash → WorkerHandle 标记 crashed → 前端收到 plugin:crashed
   - TC-8: Manifest 版本不兼容 → scan 跳过该插件

3. 测试工具：
   - Mock IMessageBroker（捕获推送的消息）
   - Mock WorkspaceContext（提供 workspace hash）
   - 测试前后清理 `~/.xyz-agent/test-plugins/` 目录

## Acceptance Criteria

### AC-1: PluginService 初始化
- 启动 Sidecar 后，PluginService.initialize() 完成扫描
- 已安装插件出现在 `config.plugins` 消息中
- 前端能收到插件列表

### AC-2: Worker Thread 隔离
- Plugin 在独立的 Worker Thread 中运行，不在 Sidecar 主线程
- Worker crash 不影响 Sidecar 或其他 Worker
- 崩溃通知正确发送到前端

### AC-3: JSON-RPC 通信
- Plugin 通过 agentAPI proxy 调用 storage.get/set 成功
- 超时请求返回 RPC_TIMEOUT 错误
- 并发请求正确对应各自的响应

### AC-4: 懒激活
- 声明 `onStartupFinished` 的插件在启动后自动激活
- 声明 `onSlashCommand` 的插件在首次使用该命令前不加载代码
- deactivate 后 subscriptions 被正确清理

### AC-5: KV 持久化
- storage.global.set() 的值在重启后仍然可通过 get() 读取
- 超出 10MB 限制的写入返回 STORAGE_FULL
- 多个插件并发写入互不影响

### AC-6: 现有功能不受影响
- ExtensionService 的扫描、toggle、UI 桥接功能正常
- Session 创建/恢复/切换正常
- 所有已有测试继续通过

## Constraints

### Tech Stack
- 不新增 npm 依赖（Worker Thread 和 MessagePort 是 Node.js 内置能力）
- TypeScript strict mode + 禁止 any

### Architecture
- PluginService 遵循现有 Service 模式（constructor DI + interface 注入）
- 不与 ExtensionService 耦合（各自独立，各有消息类型）
- Worker Thread 的入口脚本（plugin-bootstrap.ts）必须是 `.js` 文件（Worker 构造函数不支持 TS）

### Version Compatibility
- 要求 Node.js ≥ 20.17（`worker.threadId` 和 `performance.threadMemoryUsage` 的最低版本）
- 目标 Electron 版本 ≥ 33（内嵌 Node.js 22）

### Scope Boundaries

**In Scope**（Phase 1 做完）：
- PluginRegistry：发现 + manifest 解析 + 兼容性检查
- PluginHost：Worker Thread 池 + 分配 + 崩溃恢复
- PluginRPC：JSON-RPC 2.0 request/response + notification
- PluginActivator：4 种激活事件 + 状态机 + 最小 agentAPI
- PluginStorage：globalState + workspaceState KV 持久化
- 共享类型：PluginDescriptor + 消息类型定义
- Server 集成：消息路由 + 生命周期
- 集成测试：hello-world 插件 8 个测试场景

**Out of Scope**（Phase 2+ 再做）：
- 完整 agentAPI（tools、slashCommands、hooks、ui、config、workspace、agent bridge）
- Pi 事件桥接（hooks 拦截链）
- 权限检查 + Worker 沙箱
- 安装/卸载（npm install 集成）
- 前端 Plugin Store + 管理 UI + Settings 面板 + 状态栏 + 消息装饰器
- 插件间通信隔离（跨 Worker EventBus）
- 热重载/热更新
- 插件脚手架 + SDK 包

## Decisions

| # | 决策 | 结论 | 理由 |
|---|------|------|------|
| D1 | Worker 用 `.js` 还是 `.ts`？ | `.js` | Worker 构造函数不支持 TS，编译产物或已编译的 JS 都可直接使用。开发时写 TS，构建时编译到 `dist/plugin-bootstrap.js` |
| D2 | PluginService 是否复用 ExtensionService 的扫描逻辑？ | 不复用，新写 | 扫描路径不同（extensions/ vs plugins/），manifest 格式不同（package.json 的 xyzAgent 字段），数据结构不同（PluginDescriptor vs ExtensionInfo） |
| D3 | PluginHost 是 Service 还是 PluginService 的内部模块？ | PluginService 的内部模块 | PluginHost 不需要被外部直接引用，只有 PluginService 通过 IP 接口暴露能力。减少 DI 参数 |
| D4 | agentAPI 冻结在 Worker 侧还是主线程侧？ | Worker 侧 | agentAPI 是 Worker 内的代理对象，通过 RPC 调用主线程能力。冻结在 Worker 侧可防止插件代码篡改别名 |
| D5 | PluginStorage 的 workspace 隔离粒度？ | 基于 cwd 的 hash | 与 session 的 workspace 概念一致。不同项目目录 = 不同 workspaceState |

## Risks

| 风险 | 影响 | 缓解 | 概率 |
|------|------|------|------|
| Worker Thread 的 `structuredClone` 对大对象的序列化性能 | PluginStorage 大 value 写入变慢 | 默认 1MB 单值限制，大型数据建议分包 | 低 |
| Electron 环境的 Worker Thread 行为与 Node.js 不同 | Phase 1 测试通过但 Electron 中崩溃 | Phase 1 验收时在 Electron 环境中做一次冒烟测试 | 中 |
| 多个 trusted 插件共享一个 Worker 的命名空间冲突 | 插件间变量污染 | Phase 1 暂不做 Worker 内的模块隔离（sandbox Worker 单独隔离），Phase 2 通过沙箱解决 | 低 |
