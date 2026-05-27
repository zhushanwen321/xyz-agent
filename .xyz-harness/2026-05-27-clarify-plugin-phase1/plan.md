---
verdict: pass
complexity: L2
---

# 插件系统 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 xyz-agent 插件系统核心骨架：Worker Thread 隔离 + JSON-RPC 通信 + 懒激活 + KV 持久化

**Architecture:** 在 Sidecar (runtime) 中新增 PluginService 模块，与现有 Service 体系共存。插件在独立 Worker Thread 中运行，通过 JSON-RPC 2.0 与主线程通信。PluginRegistry 负责发现和 manifest 解析，PluginHost 管理 Worker 池，PluginActivator 驱动懒激活，PluginStorage 提供 KV 持久化。

**Tech Stack:** Node.js Worker Threads + MessagePort (内置)，TypeScript strict mode，无新增 npm 依赖

---

## Sub-documents
- Backend design: `plan-backend.md`
- API contract: `plan-api-contract.md`
- Frontend design: `plan-frontend.md` (minimal — Phase 1 无新增 UI)

## File Structure

所有新增文件集中在 `src-electron/runtime/src/services/plugin-service/` 目录下。

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/runtime/src/services/plugin-service/plugin-types.ts` | create | BG1 | 所有 plugin 内部类型定义（XyzAgentManifest, PluginDescriptor, WorkerHandle, ActivationEvent, PluginContext, PluginStateStorage 等） |
| `src-electron/shared/src/protocol.ts` | modify | BG1 | 新增 ClientMessage/ServerMessage 类型（plugin.list/toggle/install/notification, config.plugins, plugin:crashed, plugin:notification） |
| `src-electron/runtime/src/services/plugin-service/plugin-registry.ts` | create | BG2 | 插件扫描 + manifest 解析 + 兼容性检查 + 缓存 |
| `src-electron/runtime/src/services/plugin-service/plugin-storage.ts` | create | BG2 | KV 持久化（globalState + workspaceState），内存缓存 + 延迟写入 + 原子操作 + 大小限制 |
| `src-electron/runtime/src/services/plugin-service/plugin-rpc-server.ts` | create | BG2 | 主线程侧 JSON-RPC 2.0 服务端（request/response/dispatch/notify/broadcast） |
| `src-electron/runtime/src/services/plugin-service/plugin-rpc-client.ts` | create | BG3 | Worker 侧 JSON-RPC 2.0 客户端（request/notify/onNotification） |
| `src-electron/runtime/src/services/plugin-service/plugin-host.ts` | create | BG3 | Worker Thread 池（assignWorker/loadPlugin/terminateWorker）+ 崩溃恢复 + 资源监控 |
| `src-electron/runtime/src/services/plugin-service/plugin-activator.ts` | create | BG3 | 懒激活状态机 + activationEvents 注册 + PluginContext 构造 |
| `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts` | create | BG3 | Worker 入口脚本（消息监听、模块加载、activate/deactivate 委托） |
| `src-electron/runtime/src/services/plugin-service/plugin-service.ts` | create | BG4 | PluginService 顶层协调器，实现 IPluginService |
| `src-electron/runtime/src/services/plugin-service/index.ts` | create | BG4 | barrel export |
| `src-electron/runtime/src/interfaces.ts` | modify | BG4 | 新增 IPluginService 接口 |
| `src-electron/runtime/src/index.ts` | modify | BG4 | 创建 PluginService 实例 + setServices 注入 |
| `src-electron/runtime/src/server.ts` | modify | BG4 | setServices 新增 pluginService 参数 + 新增消息路由 |
| `src-electron/runtime/test/plugin-registry.test.ts` | create | BG5 | PluginRegistry 单元测试 |
| `src-electron/runtime/test/plugin-storage.test.ts` | create | BG5 | PluginStorage 单元测试 |
| `src-electron/runtime/test/plugin-rpc.test.ts` | create | BG5 | PluginRpc 单元测试 |
| `src-electron/runtime/test/plugin-activator.test.ts` | create | BG5 | PluginActivator 单元测试 |
| `src-electron/runtime/test/plugin-host.test.ts` | create | BG5 | PluginHost 单元测试 |
| `src-electron/runtime/test/plugin-integration.test.ts` | create | BG5 | 集成测试（hello-world 插件 8 个 TC） |
| `src-electron/runtime/test/fixtures/plugins/hello-world/package.json` | create | BG5 | 测试插件 manifest |
| `src-electron/runtime/test/fixtures/plugins/hello-world/index.js` | create | BG5 | 测试插件入口模块 |

## Task List

| # | Task | Type | Depends on | Group | Description |
|---|------|------|-----------|-------|-------------|
| 1 | 类型定义 + 共享协议 | backend | — | BG1 | plugin-types.ts 全部类型 + protocol.ts 新增消息类型 |
| 2 | PluginRegistry | backend | 1 | BG2 | 插件扫描 + manifest 解析 + 兼容性检查 |
| 3 | PluginStorage | backend | 1 | BG2 | KV 持久化（globalState + workspaceState） |
| 4 | PluginRpc (server + client) | backend | 1 | BG2 | JSON-RPC 2.0 主线程/Worker 双向通信 |
| 5 | PluginHost | backend | 1, 4 | BG3 | Worker Thread 池 + 崩溃恢复 + 资源监控 |
| 6 | PluginActivator + Bootstrap | backend | 1, 4 | BG3 | 懒激活状态机 + Worker 入口脚本 |
| 7 | PluginService + Server 集成 | backend | 2, 3, 4, 5, 6 | BG4 | 顶层协调器 + interfaces/index/server 修改 |
| 8 | 集成测试 | backend | 7 | BG5 | hello-world 插件 + 8 TC + 单元测试 |

## Execution Groups

### BG1: 类型定义 + 共享协议

**Description:** 所有插件系统基础类型和共享协议的变更。BG2-BG3 都依赖此 Group 的类型定义。

**Tasks:** Task 1

**Files (预估):** 2 个文件（1 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| taskComplexity | medium |
| 注入上下文 | spec.md FR-1/2/4/5/6/7 + 设计文档 Part 1 §通信协议 + Part 2 §Manifest/API 设计 |
| 读取文件 | src-electron/shared/src/protocol.ts (现有关键类型), src-electron/runtime/src/interfaces.ts (现有 Service 接口模式) |
| 修改/创建文件 | `src-electron/runtime/src/services/plugin-service/plugin-types.ts` (create), `src-electron/shared/src/protocol.ts` (modify) |

**Execution Flow (BG1 内部):** 单 Task，走标准 TDD 流程。

  Task 1:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 见 plan-backend.md §1, plan-api-contract.md §1

---

### BG2: 核心模块 — PluginRegistry + PluginStorage + PluginRpc

**Description:** 三个核心模块可并行开发（都只依赖 BG1 类型定义，彼此无直接依赖）。PluginRpcClient 虽然在 BG2 中创建，但尚未与 PluginHost/PluginActivator 集成。

**Tasks:** Task 2, 3, 4

**Files (预估):** 4 个文件（4 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| taskComplexity | high |
| 注入上下文 | spec.md FR-2/4/6 + 设计文档 Part 1 §通信协议 + Part 2 §持久化 |
| 读取文件 | plugin-types.ts (BG1 产出), src-electron/runtime/src/extension-service.ts (参考扫描模式), src-electron/runtime/src/interfaces.ts |
| 修改/创建文件 | `plugin-registry.ts` (create), `plugin-storage.ts` (create), `plugin-rpc-server.ts` (create), `plugin-rpc-client.ts` (create) |

**Execution Flow (BG2 内部):** Task 2, 3, 4 可并行（无相互依赖），但单一 subagent 内串行。

  Task 2:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 3:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 4:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1（类型定义）

**设计细节:** 见 plan-backend.md §2-4, plan-api-contract.md §2-4

---

### BG3: 运行时模块 — PluginHost + PluginActivator + Bootstrap

**Description:** Worker Thread 池管理 + 懒激活机制 + Worker 入口脚本。依赖 BG1 的类型和 BG2 的 PluginRpc。

**Tasks:** Task 5, 6

**Files (预估):** 3 个文件（3 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| taskComplexity | high |
| 注入上下文 | spec.md FR-3/5 + 设计文档 Part 1 §进程隔离模型/生命周期 |
| 读取文件 | plugin-types.ts (BG1), plugin-rpc-server.ts + plugin-rpc-client.ts (BG2), src-electron/runtime/src/process-manager.ts (参考子进程管理模式) |
| 修改/创建文件 | `plugin-host.ts` (create), `plugin-activator.ts` (create), `plugin-bootstrap.ts` (create) |

**Execution Flow (BG3 内部):** Task 5 完成后再 Task 6（PluginActivator 依赖 PluginHost 的 WorkerHandle）。

  Task 5:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 6:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1 + BG2

**设计细节:** 见 plan-backend.md §5-6, plan-api-contract.md §5-6

---

### BG4: 系统集成 — PluginService + Server + DI

**Description:** 将 BG1-BG3 的所有模块组合为 PluginService，注入到现有 Service 体系。修改 server.ts 消息路由、interfaces.ts 接口声明、index.ts DI 容器。

**Tasks:** Task 7

**Files (预估):** 4 个文件（2 create + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| taskComplexity | high |
| 注入上下文 | spec.md FR-1/8 + 项目 CLAUDE.md §Service 模式/DI |
| 读取文件 | plugin-types.ts + plugin-registry.ts + plugin-host.ts + plugin-storage.ts + plugin-rpc-server.ts + plugin-activator.ts (BG1-BG3 产出), src-electron/runtime/src/server.ts (handleMessage/setServices), src-electron/runtime/src/interfaces.ts, src-electron/runtime/src/index.ts |
| 修改/创建文件 | `plugin-service.ts` (create), `index.ts` (create), `server.ts` (modify), `interfaces.ts` (modify), `src-electron/runtime/src/index.ts` (modify) |

**Execution Flow (BG4 内部):** 单 Task，走标准 TDD 流程。

  Task 7:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1 + BG2 + BG3

**设计细节:** 见 plan-backend.md §7, plan-api-contract.md §7

---

### BG5: 集成测试

**Description:** hello-world 测试插件 + 8 个 TC + 各模块单元测试

**Tasks:** Task 8

**Files (预估):** 8 个文件（8 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| taskComplexity | high |
| 注入上下文 | spec.md FR-9 (8 TC) + e2e-test-plan.md + test_cases_template.json |
| 读取文件 | BG1-BG4 所有产出文件, src-electron/runtime/test/ (现有测试模式) |
| 修改/创建文件 | 6 个 test 文件 + 2 个 fixture 文件（见 File Structure 表） |

**Execution Flow (BG5 内部):** 单 Task，测试编写无需 TDD 子流程，直接写测试 + 验证。

**Dependencies:** BG4

**设计细节:** 见 e2e-test-plan.md, test_cases_template.json

---

## Dependency Graph & Wave Schedule

```
BG1 (types) ──┬──→ BG2 (registry+storage+rpc) ──→ BG3 (host+activator+bootstrap) ──→ BG4 (integration) ──→ BG5 (tests)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 类型基础，无依赖 |
| Wave 2 | BG2 | 核心模块，依赖 BG1 类型 |
| Wave 3 | BG3 | 运行时模块，依赖 BG2 RPC |
| Wave 4 | BG4 | 系统集成，依赖 BG1-3 全部模块 |
| Wave 5 | BG5 | 测试，依赖 BG4 集成完整 |

## Interface Contracts

### Module: PluginRegistry

#### Class: PluginRegistry

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| scan | (pluginDirs: string[]) -> Promise<PluginDescriptor[]> | PluginDescriptor[] | 目录不存在 → 空数组；package.json 缺少 xyzAgent → 跳过；manifestVersion ≠ 1 → 跳过 | FR-2 |
| cacheDescriptors | (descriptors: PluginDescriptor[]) -> void | void | 同名 pluginId 覆盖 | FR-2 |
| getDescriptor | (pluginId: string) -> PluginDescriptor \| undefined | PluginDescriptor \| undefined | 未扫描 → undefined | FR-2 |
| getAllDescriptors | () -> PluginDescriptor[] | PluginDescriptor[] | 未扫描 → 空数组 | FR-2 |
| reload | () -> Promise<PluginDescriptor[]> | PluginDescriptor[] | 同 scan 边界条件 | FR-2 |

#### Data: PluginDescriptor

| Field | Type | Description |
|-------|------|-------------|
| pluginId | string | 唯一标识（目录名） |
| version | string | semver 版本号 |
| displayName | string | 插件显示名称 |
| description | string | 插件描述 |
| main | string | 入口文件相对路径 |
| activationEvents | string[] | 激活事件列表（扫描时自动推断） |
| trustLevel | 'trusted' \| 'sandbox' | 信任等级（默认 sandbox） |
| status | 'discovered' \| 'loaded' \| 'active' \| 'inactive' \| 'crashed' | 当前状态 |
| contributes | PluginContributes? | 声明式扩展点 |
| permissions | string[]? | 权限列表 |
| engines | { "xyz-agent": string } | 兼容性版本要求 |

#### Data: PluginContributes

| Field | Type | Description |
|-------|------|-------------|
| slashCommands | { name: string; description: string }[]? | 斜杠命令 |
| tools | { name: string; description: string; parameters: object }[]? | 工具定义 |
| hooks | string[]? | 钩子事件名称 |
| panels | { id: string; title: string; view: string }[]? | 面板扩展 |
| statusBarItems | { id: string; text: string; priority: number }[]? | 状态栏项 |

---

### Module: PluginStorage

#### Class: PluginStorage

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| init | (baseDir: string) -> Promise<void> | void | 目录已存在 → 无操作；创建失败 → throw | FR-6 |
| get | (pluginId: string, key: string) -> Promise<unknown \| undefined> | unknown \| undefined | key 不存在 → undefined；解析失败 → undefined | FR-6 |
| set | (pluginId: string, key: string, value: unknown) -> Promise<void> | void | value > 1MB → throw STORAGE_FULL；总存储 > 10MB → throw STORAGE_FULL | FR-6 |
| delete | (pluginId: string, key: string) -> Promise<void> | void | key 不存在 → 无操作 | FR-6 |
| keys | (pluginId: string) -> Promise<string[]> | string[] | 无数据 → 空数组 | FR-6 |
| flush | (pluginId: string) -> Promise<void> | void | 无脏数据 → 无操作 | FR-6 |
| flushAll | () -> Promise<void> | void | 同上 | FR-6 |
| onExternalChange | (pluginId: string) -> void | void | 强制下次 get 从磁盘读取 | FR-6 |

---

### Module: PluginRpcServer

#### Class: PluginRpcServer

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| registerMethod | (method: string, handler: (params: unknown[]) -> Promise<unknown>) -> void | void | 方法名重复 → 覆盖旧注册 | FR-4 |
| notify | (workerId: string, method: string, params: Record<string, unknown>) -> void | void | Worker 不存在 → 忽略 | FR-4 |
| broadcast | (method: string, params: Record<string, unknown>) -> void | void | 无活跃 Worker → 无操作 | FR-4 |
| dispatch | (workerId: string, message: WorkerMessage) -> void | void | Worker 不存在 → 忽略 | FR-4 |

#### Data: RpcRequest

| Field | Type | Description |
|-------|------|-------------|
| jsonrpc | '2.0' | 协议版本 |
| id | number | 请求 ID |
| method | string | 方法名 |
| params | Record<string, unknown>? | 参数 |

#### Data: RpcResponse

| Field | Type | Description |
|-------|------|-------------|
| jsonrpc | '2.0' | 协议版本 |
| id | number | 对应的请求 ID |
| result | unknown | 成功返回值 |
| error | { code: number; message: string; data?: unknown } | 错误信息 |

---

### Module: PluginRpcClient (Worker 侧)

#### Class: PluginRpcClient

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| request | (method: string, params: Record<string, unknown>, timeoutMs?: number) -> Promise<unknown> | unknown | 超时 → RPC_TIMEOUT；Worker 已终止 → throw | FR-4 |
| notify | (method: string, params: Record<string, unknown>) -> void | void | Worker 已终止 → 忽略 | FR-4 |
| onNotification | (method: string, handler: (params: unknown) -> void) -> () => void | Disposable | 重复注册 → 追加处理器 | FR-4 |
| handleResponse | (response: RpcResponse) -> void | void | id 不匹配 → 忽略 | FR-4 |
| dispose | () -> void | void | 清除所有 pending 请求（全部 reject） | FR-4 |

---

### Module: PluginHost

#### Class: PluginHost

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| assignWorker | (pluginId: string, trustLevel: 'trusted' \| 'sandbox') -> WorkerHandle | WorkerHandle | trusted 池满 (≥10) → 新建 Worker 或 throw；sandbox → 总是新建 | FR-3 |
| loadPlugin | (workerId: string, pluginPath: string) -> Promise<void> | void | Worker 已崩溃 → throw；import 失败 → throw | FR-3 |
| terminateWorker | (workerId: string) -> Promise<void> | void | 不存在的 workerId → 无操作 | FR-3 |
| getWorkerHandle | (workerId: string) -> WorkerHandle \| undefined | WorkerHandle \| undefined | 不存在的 workerId → undefined | FR-3 |
| getAllWorkers | () -> WorkerHandle[] | WorkerHandle[] | 无 Worker → 空数组 | FR-3 |

#### Data: WorkerHandle

| Field | Type | Description |
|-------|------|-------------|
| workerId | string | "trusted-0" \| "sandbox-<pluginId>" |
| threadId | number | Worker 线程 ID |
| trustLevel | 'trusted' \| 'sandbox' | 信任等级 |
| pluginIds | string[] | 该 Worker 内已加载的插件 ID |
| status | 'idle' \| 'active' \| 'crashed' \| 'terminated' | 当前状态 |
| lastActiveAt | number | 最后活跃时间戳 (ms) |
| memoryUsage | number? | 内存使用量 (bytes) |

---

### Module: PluginActivator

#### Class: PluginActivator

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| registerEvent | (eventType: string, handler: (pluginId: string, event: ActivationEvent) -> Promise<void>) -> void | void | 重复注册 → 追加处理器 | FR-5 |
| handleEvent | (event: ActivationEvent) -> Promise<void> | void | 未匹配到插件 → 无操作 | FR-5 |
| activatePlugin | (pluginId: string, event: ActivationEvent, host: PluginHost, rpc: PluginRpcServer) -> Promise<void> | void | 已激活 → 无操作；Worker 崩溃 → 触发恢复 | FR-5 |
| deactivatePlugin | (pluginId: string, host: PluginHost) -> Promise<void> | void | 未激活 → 无操作 | FR-5 |
| getActivePlugins | () -> string[] | string[] | 无活跃插件 → 空数组 | FR-5 |

#### Data: ActivationEvent

| Field | Type | Description |
|-------|------|-------------|
| type | 'onStartupFinished' \| 'onSessionCreate' \| 'onSlashCommand' \| 'onToolCall' | 事件类型 |
| command | string? | onSlashCommand 时的命令名称 |
| tool | string? | onToolCall 时的工具名称 |

---

### Module: PluginService

#### Class: PluginService (implements IPluginService)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| initialize | () -> Promise<void> | void | 重复调用 → 无操作；scan 失败 → throw | FR-1 |
| getDiscoveredPlugins | () -> PluginDescriptor[] | PluginDescriptor[] | 未初始化 → 空数组 | FR-1 |
| togglePlugin | (pluginId: string, enabled: boolean) -> Promise<PluginDescriptor[]> | PluginDescriptor[] | 不存在的 pluginId → throw；已启用/禁用的重复操作 → 无操作 | FR-1 |
| shutdown | () -> Promise<void> | void | 停用所有活跃插件 → terminate 所有 Worker → flushAll storage | FR-1 |

---

### Module: Server 集成

#### 修改: SidecarServer.setServices

| 变更 | 旧签名 | 新签名 | Spec Ref |
|------|--------|--------|----------|
| 新增参数 | `(session, config, model, tree, extension?)` | `(session, config, model, tree, extension?, plugin?)` | FR-8 |

#### 新增消息路由 (SidecarServer.handleMessage)

| ClientMessage 类型 | 处理 | 返回 ServerMessage | Spec Ref |
|---|---|---|---|
| `plugin.list` | `pluginService.getDiscoveredPlugins()` | `config.plugins` | FR-8 |
| `plugin.toggle` | `pluginService.togglePlugin(name, enabled)` | `config.plugins` | FR-8 |
| `plugin.notification` | 转发给前端 | `plugin:notification` | FR-8 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 (PluginService 初始化) | PluginService.initialize → PluginRegistry.scan | scan → cacheDescriptors → broadcast config.plugins | Task 7 |
| AC-2 (Worker 隔离) | PluginHost.assignWorker → Worker lifecycle | assignWorker → loadPlugin → activatePlugin → deactivatePlugin → terminateWorker | Task 5, 6 |
| AC-3 (JSON-RPC 通信) | PluginRpcServer + PluginRpcClient | request → dispatch → handleResponse | Task 4 |
| AC-4 (懒激活) | PluginActivator.handleEvent → activatePlugin | registerEvent → match event → assignWorker → loadPlugin → activatePlugin | Task 6 |
| AC-5 (KV 持久化) | PluginStorage.get/set/delete/flush | in-memory cache → debounced write → temp + rename | Task 3 |
| AC-6 (现有功能不受影响) | 所有 Service 共存 | server.ts 消息路由隔离 | Task 7 |
| UC-1 (插件发现与启用) | PluginRegistry.scan + PluginService.togglePlugin | scan → getDiscoveredPlugins → togglePlugin | Task 2, 7 |
| UC-2 (插件执行) | PluginHost + PluginActivator + PluginRpc | assignWorker → activatePlugin → handleEvent → rpc communication | Task 4, 5, 6 |
| UC-3 (插件崩溃恢复) | PluginHost worker.on('error') | crash → mark crashed → notify frontend → rebuild worker | Task 5 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-1 PluginService 模块骨架 | adopted | Task 7 |
| FR-2 PluginRegistry 发现 + Manifest | adopted | Task 2 |
| FR-3 PluginHost Worker Thread 池 | adopted | Task 5 |
| FR-4 PluginRPC JSON-RPC 2.0 | adopted | Task 4 |
| FR-5 PluginActivator 懒激活 | adopted | Task 6 |
| FR-6 PluginStorage KV 持久化 | adopted | Task 3 |
| FR-7 类型定义双轨 | adopted | Task 1 |
| FR-8 Server 集成 | adopted | Task 7 |
| FR-9 集成测试 | adopted | Task 8 |
| AC-1 PluginService 初始化 | adopted | Task 7 |
| AC-2 Worker Thread 隔离 | adopted | Task 5, 6 |
| AC-3 JSON-RPC 通信 | adopted | Task 4 |
| AC-4 懒激活 | adopted | Task 6 |
| AC-5 KV 持久化 | adopted | Task 3 |
| AC-6 现有功能不受影响 | adopted | Task 7 |
| D1 Worker 用 .js | adopted | Task 6 (plugin-bootstrap.ts → dist/plugin-bootstrap.js) |
| D2 不复用 ExtensionService 扫描逻辑 | adopted | Task 2 (独立实现 PluginRegistry) |
| D3 PluginHost 是内部模块 | adopted | Task 5 (PluginHost 仅被 PluginService 引用) |
| D4 agentAPI 在 Worker 侧冻结 | adopted | Task 6 (PluginActivator 注入冻结对象) |
| D5 workspace 隔离基于 cwd hash | adopted | Task 3 (PluginStorage workspace path) |
