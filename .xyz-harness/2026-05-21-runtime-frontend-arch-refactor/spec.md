---
verdict: pass
---

# Runtime + Front-end Architecture Refactoring

## Background

xyz-agent 的 Agent Runtime（`src-electron/runtime/src/`）和前端（`src-electron/renderer/src/`）经过快速迭代积累了显著的架构债务。architecture review（2026-05-22）识别出 8 个候选重构项，其中 4 个为 Strong/High severity。

核心问题：Runtime 层没有 Service 层 — `server.ts`（574L）和 `session-pool.ts`（600L）是上帝类，混合了消息路由、session 生命周期、配置 CRUD、模型聚合、WS 广播等 10+ 种不相关职责。零依赖注入，全部不可测。`pi-rpc-types.ts`（384L）定义了 40+ 精确类型但从未被 import。前端有 3 个死 composable、缺 refCount 保护的 useSession/useProvider、5 处重复的系统消息构造代码。

本 spec 覆盖 Runtime 层的核心重构 + 前端快速修复。前端的 EventRouter 深化、App.vue 拆分、PanelSessionView 分解、MessageBubble 拆分推迟到后续 spec。

## Functional Requirements

### FR-1: Extract Service Layer from Runtime God Classes

**目标**: 将 `server.ts` 和 `session-pool.ts` 的业务逻辑提取到独立的 Service 模块，server.ts 只保留 WS 连接管理和消息分发。

**当前状态**:
- `server.ts` 直接处理 37 种消息，内联配置 CRUD（load→findIdx→splice→save）、模型聚合、API 发现
- `session-pool.ts` 同时管理 WS 客户端、session 生命周期、pi 历史格式转换、工具审批代理

**目标结构**:

```
runtime/src/
├── server.ts                    (WS 连接 + 消息分发到 Service, ~200L)
├── services/
│   ├── session-service.ts       (session CRUD, history, compact, restore)
│   ├── config-service.ts        (provider/skill/agent/model CRUD 编排)
│   └── model-service.ts         (模型聚合 + API 发现)
├── message-converter.ts         (pi history → Message[], 从 session-pool 提取)
├── types.ts                     (重命名自 pi-rpc-types.ts, 被 event-adapter/rpc-client 消费)
├── rpc-client.ts                (implements IRpcClient)
├── event-adapter.ts             (uses PiEvent union type)
├── process-manager.ts           (implements IProcessManager)
├── config-store.ts              (拆分后只管 config.json)
├── skill-store.ts               (新文件, 从 config-store 提取)
├── agent-store.ts               (新文件, 从 config-store 提取)
├── scanner-base.ts              (新文件, 共享扫描框架)
├── provider-store.ts            (已有文件, 缓存逻辑保留, 调用 config-store)
├── model-db.ts                  (不变)
├── session-scanner.ts           (不变)
├── session-label-store.ts       (不变)
├── trash.ts                     (不变)
└── index.ts                     (不变)
```

**server.ts 的目标职责**:
1. WS 连接管理（handleConnection, heartbeat, client set）
2. 消息分发（switch/case 路由到对应 Service 方法）
3. 统一广播（broadcast 通过注入的 MessageBroker 接口）

**server.ts 不再做的事**:
- 不再内联配置 CRUD — 委托 ConfigService
- 不再聚合模型 — 委托 ModelService
- 不再发现 API — 委托 ModelService
- 不再直接管理 session — 委托 SessionService

### FR-2: Bind pi-rpc-types to Event Adapter

**目标**: `event-adapter.ts` 的 `translate()` 方法使用 `pi-rpc-types.ts` 定义的精确联合类型，消除 `Record<string, any>`。

**当前状态**:
- `event-adapter.ts` 第 7 行: `type PiEvent = Record<string, any>` — 绕过所有类型
- `session-pool.ts` 内部重新定义了 `PiHistoryMessage`，与 `pi-rpc-types.ts` 重复
- `rpc-client.ts` 定义了自己的 `PiMessage` 类型

**变更**:
1. `pi-rpc-types.ts` 保持原位置，只重命名为 `types.ts`（不创建子目录，避免 tsconfig 变更）
2. `event-adapter.ts` 的 `translate()` 入参改为 `PiEvent` 联合类型
3. switch case 按 `event.type` 分支，编译器做 exhaustive check
4. 删除 `session-pool.ts` 内的重复 `PiHistoryMessage` 定义，引用 `types.ts`
5. 删除 `rpc-client.ts` 内的本地 `PiMessage` 类型，引用 `types.ts`

### FR-3: Introduce Constructor Injection for Core Runtime Modules

**目标**: 提取接口，构造函数注入依赖，使核心模块可独立测试。

**需要提取的接口**:

| Interface | 满足者 | 消费者 |
|-----------|--------|--------|
| `IRpcClient` | `RpcClient` | `SessionService` |
| `IProcessManager` | `ProcessManager` | `SessionService` |
| `IMessageBroker` | `Server` (广播方法) | `SessionService`, `ConfigService`, `EventAdapter` |
| `IEventAdapter` | `EventAdapter` | `SessionService` |
| `ISessionService` | `SessionService` | `Server` (消息路由) |
| `IConfigService` | `ConfigService` | `Server` (消息路由) |
| `IModelService` | `ModelService` | `Server` (消息路由) |

**注入方式**: 构造函数参数，不引入 IoC 容器。Server 在 `index.ts` 中组装依赖图。

**两个 adapter 验证 seam**: 每个接口在生产环境有真实实现，在测试中有 in-memory stub。测试时只需构造 stub 即可隔离。

### FR-4: Clean Dead Code

**Runtime 死代码**:

| 项目 | 位置 | 动作 |
|------|------|------|
| `EventAdapter.sendSessionCreated()` 等 6 个方法 | `event-adapter.ts` L209-230 | 删除 |
| `SessionPool.addClient()` / `removeClient()` / `send()` | `session-pool.ts` L53-67 | 删除 (WS 广播由 Server 统一管理) |
| `RpcClient.approveTool()` / `denyTool()` / `alwaysAllowTool()` | `rpc-client.ts` L268-303 | 删除 (假接口) |
| `RpcClient.getModels()` | `rpc-client.ts` | 删除 (与 getAvailableModels() 完全重复) |

**前端死代码**:

| 项目 | 位置 | 动作 |
|------|------|------|
| `useModel.ts` | `composables/useModel.ts` (17L) | 删除 |
| `useRafBatch.ts` | `composables/useRafBatch.ts` (45L) | 删除 |
| `useContext.ts` | `composables/useContext.ts` (19L) | 删除 |

### FR-5: Extract Message Converter

**目标**: 将 `session-pool.ts` 中的 `convertPiHistory()`（~55L 纯函数）提取为独立模块。

**当前状态**: `convertPiHistory()` 是 55 行纯函数，做 pi 历史格式到前端 `Message[]` 的转换。与 session pool 的核心职责（管理 session 生命周期）无关。内部重新定义了 `PiHistoryMessage` 接口（与 `pi-rpc-types.ts` 重复）。

**变更**: 提取到 `message-converter.ts`，使用 `types.ts` 中的 `PiHistoryMessage` 类型。

### FR-6: Split config-store.ts

**目标**: 将 `config-store.ts`（234L）中三种不相关的持久化拆分为独立模块。

**当前状态**: 一个文件同时管理 `config.json`（provider + defaults + toolPermissions）、`skills.json`、`agents.json`。三者存储路径不同、格式不同、调用方不同。

**变更**:
- `config-store.ts` — 只管 `~/.xyz-agent/config.json`（providers, defaults, toolPermissions）
- `skill-store.ts` — 管 `<project>/.xyz-agent/skills.json`
- `agent-store.ts` — 管 `<project>/.xyz-agent/agents.json`
- `provider-store.ts` — 保留验证缓存，内部调用 config-store

### FR-7: Extract Scanner Base

**目标**: 消除 `skill-scanner.ts` 和 `agent-scanner.ts` 之间的代码重复。

**重复代码**:
- `expandHome()` — 完全相同
- `inferSourceType()` — 完全相同
- 目录扫描主循环 — 结构相同

**变更**: 提取 `scanner-base.ts`，两个 scanner 只提供各自的 frontmatter 解析逻辑。

### FR-8: Create System Notification Factory (Front-end)

**目标**: 统一 5 个文件中分散的系统消息构造代码。

**当前状态**: `PanelSessionView.vue`、`useChat.ts`、`EmptyPanel.vue`、`App.vue`、`ChatInput.vue` 各自独立构造系统消息，每次手动 `crypto.randomUUID()` + 字段拼装 + `as const` 断言。

**变更**: 创建 `lib/system-notification.ts`，暴露 `createSystemNotification(type: SystemNotificationType, title: string, desc: string)` 工厂函数。`SystemNotificationType` 为 `'done' | 'alert' | 'info'` 字面量联合类型（从 shared/message.ts 导入或在此定义）。返回类型安全的 `SystemNotification` 对象（id 自动生成，timestamp 自动填充）。

### FR-9: Fix useSession/useProvider refCount

**目标**: 给 `useSession.ts` 和 `useProvider.ts` 添加与 `useChat.ts` 相同的 refCount 保护机制。

**当前状态**: `useChat.ts` 使用模块级 `globalListenerRefCount` 防止重复注册。`useSession.ts` 和 `useProvider.ts` 直接在 `onMounted` 注册，split mode 下会产生重复 handler。

**变更**: 复制 useChat 的 refCount 模式到 useSession 和 useProvider。

## Acceptance Criteria

### AC-1: Service Layer Extraction
- [ ] `server.ts` 行数 ≤ 250L
- [ ] `server.ts` 不包含任何 `loadSkills`/`saveSkills`/`loadAgents`/`saveAgents` 直接调用
- [ ] `server.ts` 不包含 `aggregateModels`/`discoverModelsFromApi` 函数
- [ ] `session-service.ts` 存在且包含 session create/delete/restore/rename/clear/compact/history 逻辑
- [ ] `config-service.ts` 存在且包含 provider/skill/agent/model CRUD 编排
- [ ] `model-service.ts` 存在且包含 aggregateModels + discoverModelsFromApi
- [ ] `session-pool.ts` 被删除。其 session 生命周期职责移入 `SessionService`，历史转换移入 `message-converter.ts`，EventAdapter 转接由 `SessionService` 直接管理
- [ ] 所有 27 个消息 handler case（`session.*` x9, `message.*` x2, `config.*` x10, `model.*` x2, `tool.*` x3, `ping` x1）都有对应的 Service 方法路由（`session.create` 含在 SessionService.create 中）

### AC-2: Type Safety
- [ ] `event-adapter.ts` 的 `translate()` 入参类型为 `PiEvent` 联合类型（非 `Record<string, any>`）
- [ ] `event-adapter.ts` 的 switch case 做 exhaustive check（新增 pi 事件类型时编译器报错）
- [ ] `session-pool.ts` 和 `rpc-client.ts` 不再各自定义本地 pi 类型
- [ ] `pi-rpc-types.ts`（或重命名后的 `types.ts`）被 ≥3 个文件 import

### AC-3: Dependency Injection
- [ ] `IRpcClient` 接口定义存在
- [ ] `IProcessManager` 接口定义存在
- [ ] `IMessageBroker` 接口定义存在
- [ ] `SessionService` 构造函数接受 `IProcessManager`、`IMessageBroker`、`IEventAdapter` 工厂参数（adapter factory: `(sessionId: string) => IEventAdapter`）。不直接接受 `IRpcClient` — 通过 `IProcessManager.createSession()` 间接获取
- [ ] `Server` 构造函数接受 `ISessionService`、`IConfigService`、`IModelService` 参数
- [ ] `index.ts` 负责组装依赖图

### AC-4: Dead Code Removal
- [ ] `EventAdapter` 不再包含 `sendSessionCreated` 等 6 个未调用方法
- [ ] `SessionPool` 不再包含 `addClient`/`removeClient`/`send` 方法
- [ ] `RpcClient` 不再包含 `approveTool`/`denyTool`/`alwaysAllowTool` stub 方法
- [ ] 前端不再包含 `useModel.ts`、`useRafBatch.ts`、`useContext.ts`
- [ ] `npm run build` 通过

### AC-5: Message Converter
- [ ] `message-converter.ts` 存在，导出 `convertPiHistory` 函数
- [ ] `convertPiHistory` 使用 `types.ts` 中的 `PiHistoryMessage` 类型（非本地重复定义）
- [ ] `session-service.ts`（替代已删除的 `session-pool.ts`）import `convertPiHistory` 而非内联实现

### AC-6: Config Store Split
- [ ] `config-store.ts` 不包含 `loadSkills`/`saveSkills`/`loadAgents`/`saveAgents` 函数
- [ ] `skill-store.ts` 存在，导出 `loadSkills`/`saveSkills`
- [ ] `agent-store.ts` 存在，导出 `loadAgents`/`saveAgents`

### AC-7: Scanner Base
- [ ] `scanner-base.ts` 存在，导出 `expandHome`/`inferSourceType`/通用扫描框架
- [ ] `skill-scanner.ts` 和 `agent-scanner.ts` 不再各自定义 `expandHome` 和 `inferSourceType`

### AC-8: System Notification Factory
- [ ] `lib/system-notification.ts` 存在，导出 `createSystemNotification()`
- [ ] `PanelSessionView.vue`、`useChat.ts`、`EmptyPanel.vue`、`App.vue`、`ChatInput.vue` 全部使用工厂函数
- [ ] 不再有手动 `crypto.randomUUID()` + 字段拼装 + `as const` 断言

### AC-9: refCount Protection
- [ ] `useSession.ts` 有模块级 `globalListenerRefCount` 保护
- [ ] `useProvider.ts` 有模块级 `globalListenerRefCount` 保护
- [ ] split mode 下两个 Panel 挂载时，事件 handler 不重复注册

### AC-General: Non-regression
- [ ] `npm run build` 通过（前后端 + runtime）
- [ ] `npm run dev` 启动正常，Electron 窗口可交互
- [ ] 功能验证：创建 session、发送消息、分屏、切模型 — 行为与重构前一致

## Constraints

### Tech Stack (unchanged)
- Runtime: Node.js + TypeScript + ws + pi CLI (子进程 JSON-RPC)
- Front-end: Vue 3 + Pinia + Tailwind CSS v3 + xyz-ui
- Build: npm workspaces (shared, runtime, renderer)
- No new external dependencies

### Invariants
- **WS 协议不变**: `ClientMessage` / `ServerMessage` 类型签名不变。前端不需要改动来适配 Runtime 重构（FR-8/9 除外）
- **功能不变**: 纯重构，无新功能。所有 37 种消息类型的处理行为保持一致
- **单进程**: Runtime 仍然是单 Node.js 进程，不引入多进程或 IPC 框架
- **无 IoC 容器**: 依赖注入通过构造函数参数手动组装，不引入 tsyringe/inversify 等容器

### Architecture Constraints
- Service 层不直接处理 WS 连接（WS 是 Transport 层的职责）
- Service 层不直接 spawn 进程（进程管理通过 IProcessManager 接口）
- Store 层只管持久化，不含业务编排逻辑
- 前端 store 不直接调用 `send()`（除 provider store 的 skill/agent CRUD — 后续 spec 处理）

### Performance
- config-store 的 `readFileSync` 模式保持不变（后续优化另开 spec）
- 不引入异步 I/O 改造

## Complexity Assessment

**Overall: Medium-High**

| 变更 | 复杂度 | 风险 | 理由 |
|------|--------|------|------|
| FR-1: Service Layer | **High** | Medium | 1174L 代码重组（574+600），37 个消息 handler 路由变更 |
| FR-2: Type Safety | **Medium** | Low | 类型绑定，编译器引导 |
| FR-3: DI Interfaces | **Medium** | Low | 接口提取 + 构造函数参数化 |
| FR-4: Dead Code | **Low** | Very Low | 纯删除，无行为变更 |
| FR-5: Message Converter | **Low** | Very Low | 提取纯函数 |
| FR-6: Config Store Split | **Low** | Very Low | 函数搬家 |
| FR-7: Scanner Base | **Low** | Very Low | 提取共享函数 |
| FR-8: Notification Factory | **Low** | Very Low | 5 处调用改为工厂 |
| FR-9: refCount Fix | **Low** | Very Low | 复制已有模式 |

**主要风险**: FR-1 的 Service Layer 提取是 1174L 的重组，需要确保 37 个消息 handler 的行为不丢失。建议先做 FR-4（死代码清理）和 FR-5（message converter 提取）减小文件体积，再做 FR-1。

**依赖关系**: FR-3 (DI) 是 FR-1 的前提 — 先定义接口，再提取 Service。FR-2 (类型) 独立于 FR-1/3，可以先做或并行。

**估算工作量**: 3-4 天（1 天 FR-4/5/6/7 清理 + 2 天 FR-1/2/3 核心重构 + 0.5 天 FR-8/9 前端修复 + 0.5 天集成测试）

## Scope Boundaries

### In Scope
- Runtime 层 Service 提取、类型绑定、DI 接口、死代码清理
- Runtime 层 config-store 拆分、scanner 去重、message-converter 提取
- 前端死 composable 清理、系统消息工厂、refCount 修复

### Out of Scope (deferred to future specs)
- **EventRouter 深化** — 将 useChat/useSession/useProvider 的事件处理收拢为统一 EventRouter 模块。依赖 Service Layer 先稳定
- **App.vue 拆分** — 248L 根组件提取为 focused composables
- **PanelSessionView 分解** — 262L 组件职责拆分
- **MessageBubble 拆分** — 293L 组件 composable 提取
- **provider store send() 解耦** — 将 provider store 的直接 `send()` 调用移到 composable 层
- **event-bus 类型化** — 将 `string→any[]` 改为泛型实现
- **术语对齐** (Pane→Panel, Drawer→SideInspector, Overview→PanelGrid) — 纯机械重命名
- **config-store 读写缓存优化** — 当前每次 `readFileSync` 的性能问题
- **chat store 浅 setter 清理** — 25 个方法中 17 个是单字段 setter

## Decisions Made

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | 不引入 IoC 容器 | 项目规模不需要，手动组装在 index.ts 足够。IoC 容器增加学习成本和调试难度 |
| D2 | Service 层不引入独立 npm workspace | 仍在 runtime/src/services/ 下，避免 package.json/tsconfig 变更 |
| D3 | 保持 config-store 同步 I/O 模式 | 异步改造影响面太广，不属于本次重构范围 |
| D4 | 假审批接口直接删除，不实现真实协议 | 真实工具审批走 `extension_ui_request/response` 事件协议，不走 RPC 命令。当前审批功能的完整实现属于 Phase 1.6（feature-map），不在本次重构范围 |
| D5 | SessionPool 整体删除 | scan 确认其 WS client 管理是死代码（`addClient()` 从未被调用）。剩余职责（session 生命周期、EventAdapter 管理、历史转换）分别移入 SessionService、message-converter。不再保留 SessionPool 类 |
| D6 | 前端 refCount 修复采用 useChat 的模块级变量模式 | 项目现有模式，一致性 > 新方案。不做 `provide/inject` 或 Pinia 替代方案 |
| D7 | `pi-rpc-types.ts` 重命名为 `types.ts` 但不创建子目录 | 避免 tsconfig paths 变更。文件仍在 `runtime/src/` 下 |
