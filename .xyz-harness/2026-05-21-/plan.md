---
verdict: pass
---

# Runtime + Front-end Architecture Refactoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Service layer from Runtime god classes (server.ts 574L + session-pool.ts 600L), bind pi-rpc-types to event-adapter, introduce constructor injection, clean dead code, and apply frontend quick fixes.

**Architecture:** Insert a Service layer between Transport (server.ts WS handling) and Store/Adapter layers. Extract 7 interfaces for constructor injection. Delete SessionPool class entirely — its responsibilities split into SessionService + message-converter. Frontend changes are limited to factory function + refCount fix.

**Tech Stack:** Node.js + TypeScript + ws (Runtime), Vue 3 + Pinia + Tailwind CSS v3 (Frontend)

**Complexity:** L1 (single plan, no parallel frontend/backend sub-documents)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `runtime/src/message-converter.ts` | create | BG1 | pi history → Message[] 纯函数 |
| `runtime/src/event-adapter.ts` | modify | BG1+BG2 | 删死方法 (BG1), 绑定 PiEvent 类型 (BG2) |
| `runtime/src/rpc-client.ts` | modify | BG1 | 删 4 个假方法 + getModels |
| `runtime/src/session-pool.ts` | modify → delete | BG1→BG3 | BG1 清理死代码, BG3 整体删除 |
| `runtime/src/server.ts` | modify | BG1+BG3 | BG1 删 pool.addClient 调用, BG3 重写为 Transport 层 |
| `runtime/src/types.ts` | rename | BG2 | 从 pi-rpc-types.ts 重命名 |
| `runtime/src/config-store.ts` | modify | BG2 | 删除 loadSkills/saveSkills/loadAgents/saveAgents |
| `runtime/src/skill-store.ts` | create | BG2 | loadSkills/saveSkills |
| `runtime/src/agent-store.ts` | create | BG2 | loadAgents/saveAgents |
| `runtime/src/scanner-base.ts` | create | BG2 | expandHome/inferSourceType/扫描框架 |
| `runtime/src/skill-scanner.ts` | modify | BG2 | 用 scanner-base |
| `runtime/src/agent-scanner.ts` | modify | BG2 | 用 scanner-base |
| `runtime/src/interfaces.ts` | create | BG3 | 7 个 DI 接口 |
| `runtime/src/services/session-service.ts` | create | BG3 | session CRUD + EventAdapter 管理 |
| `runtime/src/services/config-service.ts` | create | BG3 | provider/skill/agent/model CRUD 编排 |
| `runtime/src/services/model-service.ts` | create | BG3 | aggregateModels + discoverModelsFromApi |
| `runtime/src/index.ts` | modify | BG3 | DI 组装 |
| `renderer/src/composables/useModel.ts` | delete | FG1 | 死代码 |
| `renderer/src/composables/useRafBatch.ts` | delete | FG1 | 死代码 |
| `renderer/src/composables/useContext.ts` | delete | FG1 | 死代码 |
| `renderer/src/lib/system-notification.ts` | create | FG1 | 工厂函数 |
| `renderer/src/views/PanelSessionView.vue` | modify | FG1 | 用工厂函数 |
| `renderer/src/composables/useChat.ts` | modify | FG1 | 用工厂函数 |
| `renderer/src/views/EmptyPanel.vue` | modify | FG1 | 用工厂函数（如有） |
| `renderer/src/App.vue` | modify | FG1 | 用工厂函数 |
| `renderer/src/components/chat/ChatInput.vue` | modify | FG1 | 用工厂函数（如有） |
| `renderer/src/composables/useSession.ts` | modify | FG1 | 加 refCount |
| `renderer/src/composables/useProvider.ts` | modify | FG1 | 加 refCount |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Delete dead code from Runtime | backend | — | BG1 |
| 2 | Extract message-converter.ts | backend | 1 | BG1 |
| 3 | Rename pi-rpc-types.ts → types.ts | backend | — | BG2 |
| 4 | Split config-store.ts | backend | — | BG2 |
| 5 | Extract scanner-base.ts | backend | — | BG2 |
| 6 | Bind types.ts to event-adapter.ts | backend | 3 | BG2 |
| 7 | Define DI interfaces | backend | 1 | BG3 |
| 8 | Extract services + refactor server + delete session-pool | backend | 2,4,5,6,7 | BG3 |
| 9 | System notification factory + delete dead composables | frontend | — | FG1 |
| 10 | Fix useSession/useProvider refCount | frontend | — | FG1 |

---

## Execution Groups

#### BG1: Runtime Dead Code + Message Converter

**Description:** 低风险清理：删除 runtime 死代码 + 提取纯函数。减小 session-pool.ts 体积，为 BG3 的 Service 提取做准备。

**Tasks:** Task 1, Task 2

**Files (预估):** 5 个（1 create + 3 modify + 1 create-then-delete-by-BG3）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose (executor) |
| Model | taskComplexity: medium |
| 注入上下文 | Task 1-2 描述 + spec FR-4/FR-5 + CLAUDE.md 编码规范 |
| 读取文件 | `runtime/src/event-adapter.ts`, `runtime/src/rpc-client.ts`, `runtime/src/session-pool.ts`, `runtime/src/server.ts` |
| 修改/创建文件 | `runtime/src/event-adapter.ts`, `runtime/src/rpc-client.ts`, `runtime/src/session-pool.ts`, `runtime/src/server.ts`, `runtime/src/message-converter.ts` |

**Execution Flow (BG1 内部):** 串行

  Task 1:
    1. general-purpose → 删除死代码

  Task 2 (depends on Task 1):
    1. general-purpose → 提取 convertPiHistory 到 message-converter.ts

**Dependencies:** 无

**设计细节:**

**Task 1: Delete Dead Code (FR-4 Runtime 部分)**

删除以下死代码：

1. **event-adapter.ts**: 删除末尾 6 个 helper 方法（L209-230）：
   - `sendSessionCreated()`, `sendSessionDeleted()`, `sendSessionList()`, `sendProviderList()`, `sendModelList()`, `sendError()`
   - 这些方法从未被调用（server.ts 直接构造 ServerMessage）

2. **rpc-client.ts**:
   - 删除 `approveTool()` 方法（L268-280）：假接口，pi 审批走 extension_ui_request/response 协议
   - 删除 `denyTool()` 方法（L281-291）：同上
   - 删除 `alwaysAllowTool()` 方法（L292-303）：同上
   - 删除 `getModels()` 方法（仅为 `getAvailableModels()` 的 alias）

3. **session-pool.ts**:
   - 删除 `addClient()` 方法（L53）：`addClient(ws)` 从未被外部调用（server.ts 管理自己的 client set）
   - 删除 `removeClient()` 方法（L56）：同上
   - 删除 `send()` 方法（L59-67）：WS 广播由 server.ts 统一管理
   - 删除 `clients` 成员变量（L48）及其类型 import

4. **server.ts**:
   - `handleConnection()`: 删除 `this.pool.addClient(ws)` 调用
   - `handleConnection()`: 删除 `this.pool.removeClient(ws)` 调用（close handler 和 error handler 中各一处）
   - `handleSettingsMessage()` 中 `tool.approve/deny/always_allow` 三个 case：改为直接返回成功响应，不再调用 pool 方法（因为 pool 的 approveTool/denyTool/alwaysAllowTool 会在 Task 2 中被删除）：
     ```typescript
     case 'tool.approve':
     case 'tool.deny':
     case 'tool.always_allow':
       // Tool approval handled via extension_ui_request/response protocol
       this.send(ws, { type: 'response', id: msg.id, payload: { success: true } })
       return true
     ```
   - 删除 `session-pool.ts` 中 `approveTool()`, `denyTool()`, `alwaysAllowTool()` 方法（它们调用已删除的 rpc-client 方法）

5. **验证**: `npx tsc --noEmit` 通过（`runtime/` workspace）

**Task 2: Extract message-converter.ts (FR-5)**

1. 创建 `runtime/src/message-converter.ts`：
   - 从 `session-pool.ts` 提取 `convertPiHistory()` 私有方法（约 55 行）
   - 改为 export function
   - 入参类型使用 `types.ts` 中已有的 `PiHistoryMessage`（注意：此时文件仍叫 `pi-rpc-types.ts`，BG2 Task 3 会重命名）
   - 暂时从 `./pi-rpc-types.js` import `PiHistoryMessage`，而不是 session-pool 内部重复定义的版本
   - 同时 export `PiHistoryMessage` 类型（从 types.ts re-export，保持兼容）

2. 修改 `session-pool.ts`：
   - 删除内部 `PiHistoryMessage` 接口定义
   - import `convertPiHistory` from `./message-converter.js`
   - import `PiHistoryMessage` from `./pi-rpc-types.js`
   - `getHistory()` 和 `getHistoryFromFile()` 中调用 `this.convertPiHistory(raw)` 改为 `convertPiHistory(raw)`

3. **验证**: `npx tsc --noEmit` 通过

---

#### BG2: Store/Scanner/Type Refactoring

**Description:** 拆分 config-store、提取 scanner-base、重命名 types 文件、绑定 PiEvent 到 event-adapter。所有改动都在 store/adapter 层，不触及 server.ts。

**Tasks:** Task 3, Task 4, Task 5, Task 6

**Files (预估):** 8 个（4 create + 1 rename + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose (executor) |
| Model | taskComplexity: medium |
| 注入上下文 | Task 3-6 描述 + spec FR-2/FR-6/FR-7 + CLAUDE.md 编码规范 |
| 读取文件 | `runtime/src/pi-rpc-types.ts`, `runtime/src/config-store.ts`, `runtime/src/skill-scanner.ts`, `runtime/src/agent-scanner.ts`, `runtime/src/event-adapter.ts`, `runtime/src/session-pool.ts` |
| 修改/创建文件 | `runtime/src/types.ts`, `runtime/src/config-store.ts`, `runtime/src/skill-store.ts`, `runtime/src/agent-store.ts`, `runtime/src/scanner-base.ts`, `runtime/src/skill-scanner.ts`, `runtime/src/agent-scanner.ts`, `runtime/src/event-adapter.ts` |

**Execution Flow (BG2 内部):** Task 3 先执行（重命名），然后 Task 4/5/6 可串行。

  Task 3:
    1. general-purpose → 重命名文件 + 更新所有 import

  Task 4 (depends on 3):
    1. general-purpose → 拆分 config-store

  Task 5 (depends on 3):
    1. general-purpose → 提取 scanner-base

  Task 6 (depends on 3):
    1. general-purpose → 绑定 PiEvent 类型到 event-adapter

**Dependencies:** BG1（session-pool.ts 需已清理死代码）

**设计细节:**

**Task 3: Rename pi-rpc-types.ts → types.ts**

1. `git mv runtime/src/pi-rpc-types.ts runtime/src/types.ts`
2. 更新所有 import 路径：
   - `message-converter.ts`: `from './pi-rpc-types.js'` → `from './types.js'`
   - `session-pool.ts`: `from './pi-rpc-types.js'` → `from './types.js'`（如有残留 import）
   - 其他任何引用（`grep -r "pi-rpc-types" runtime/src/`）
3. **验证**: `npx tsc --noEmit` 通过

**Task 4: Split config-store.ts (FR-6)**

1. 创建 `runtime/src/skill-store.ts`：
   ```typescript
   import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
   import { join } from 'node:path'
   import type { SkillInfo } from '@xyz-agent/shared'
   // 从 config-store.ts 提取的 loadSkills/saveSkills 函数
   export function loadSkills(projectRoot: string): SkillInfo[] { ... }
   export function saveSkills(projectRoot: string, skills: SkillInfo[]): void { ... }
   ```

2. 创建 `runtime/src/agent-store.ts`：
   ```typescript
   import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
   import { join } from 'node:path'
   import type { AgentInfo } from '@xyz-agent/shared'
   // 从 config-store.ts 提取的 loadAgents/saveAgents 函数
   export function loadAgents(projectRoot: string): AgentInfo[] { ... }
   export function saveAgents(projectRoot: string, agents: AgentInfo[]): void { ... }
   ```

3. 修改 `config-store.ts`：删除 `loadSkills`/`saveSkills`/`loadAgents`/`saveAgents` 四个函数及其 `SkillInfo`/`AgentInfo` import。保留其余所有函数不变。

4. 更新 session-pool.ts import：
   - `import { getDefaultModel, loadSkills } from './config-store.js'` → 分为两行：
     ```typescript
     import { getDefaultModel } from './config-store.js'
     import { loadSkills } from './skill-store.js'
     ```
   - **注意**: server.ts 的 import 更新由 BG3 处理，BG2 不动 server.ts。

5. **验证**: `npx tsc --noEmit` 通过

**Task 5: Extract scanner-base.ts (FR-7)**

1. 创建 `runtime/src/scanner-base.ts`：
   ```typescript
   import { join } from 'node:path'
   import { homedir } from 'node:os'
   import type { ScanSourceType } from '@xyz-agent/shared'
   
   export function expandHome(p: string): string {
     return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
   }
   
   export function inferSourceType(path: string): ScanSourceType {
     if (path.includes('.pi/')) return 'pi'
     if (path.includes('.claude/')) return 'claude'
     if (path.includes('.agents/')) return 'agents'
     return 'custom'
   }
   ```

2. 修改 `skill-scanner.ts`：
   - 删除本地 `expandHome` 和 `inferSourceType` 函数
   - 添加 `import { expandHome, inferSourceType } from './scanner-base.js'`

3. 修改 `agent-scanner.ts`：
   - 删除本地 `expandHome` 和 `inferSourceType` 函数
   - 添加 `import { expandHome, inferSourceType } from './scanner-base.js'`

4. **验证**: `npx tsc --noEmit` 通过

**Task 6: Bind types.ts to event-adapter.ts (FR-2)**

1. 修改 `event-adapter.ts`：
   - 删除 `type PiEvent = Record<string, any>` 定义（L7 附近）
   - 添加 `import type { PiEvent } from './types.js'`
   - 更新 `attach()` 方法签名：`client.onEvent((listener: PiEventListener) => ...)` 中 PiEventListener 的事件参数改为 `PiEvent` 联合类型
   - `translate()` 入参类型已是 `PiEvent`（通过 import），编译器自动做 exhaustive check
   - 删除 L7 附近 eslint-disable 注释

2. 修改 `rpc-client.ts`：
   - 删除本地 `PiMessage` 接口定义
   - 添加 `import type { PiAnyIncomingMessage } from './types.js'`
   - `PiMessage` 改为 type alias：`export type PiMessage = PiAnyIncomingMessage`
   - 或直接替换所有 `PiMessage` 使用为 `PiAnyIncomingMessage`

3. **验证**: `npx tsc --noEmit` 通过。测试 exhaustive check：在 `translate()` 的 switch 中删除一个 case，编译器应报错。

---

#### BG3: Service Layer Extraction + Delete SessionPool

**Description:** 核心重构。定义 DI 接口，提取 3 个 Service 类，将 server.ts 从 574L 缩减为 ~200L 的 Transport 层，删除 session-pool.ts。

**Tasks:** Task 7, Task 8

**Files (预估):** 8 个（5 create + 2 modify + 1 delete）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose (executor) |
| Model | taskComplexity: high |
| 注入上下文 | Task 7-8 描述 + spec FR-1/FR-3 + CLAUDE.md 架构约束 + CONTEXT.md Agent Runtime 模块表 |
| 读取文件 | `runtime/src/server.ts`, `runtime/src/session-pool.ts`, `runtime/src/types.ts`, `runtime/src/interfaces.ts`(Task 7 创建), `runtime/src/event-adapter.ts`, `runtime/src/rpc-client.ts`, `runtime/src/process-manager.ts`, `runtime/src/config-store.ts`, `runtime/src/skill-store.ts`, `runtime/src/agent-store.ts`, `runtime/src/model-db.ts`, `runtime/src/index.ts` |
| 修改/创建文件 | `runtime/src/interfaces.ts`, `runtime/src/services/session-service.ts`, `runtime/src/services/config-service.ts`, `runtime/src/services/model-service.ts`, `runtime/src/server.ts`, `runtime/src/index.ts`, 删除 `runtime/src/session-pool.ts` |

**Execution Flow (BG3 内部):** 串行

  Task 7:
    1. general-purpose → 创建 interfaces.ts

  Task 8 (depends on 7):
    1. general-purpose → 创建 services + 重写 server.ts + 删除 session-pool.ts + 更新 index.ts

**Dependencies:** BG1 + BG2（session-pool 已清理死代码，config-store 已拆分，types.ts 已就位）

**设计细节:**

**Task 7: Define DI Interfaces (FR-3)**

创建 `runtime/src/interfaces.ts`，包含 7 个接口：

```typescript
import type { ServerMessage, SessionSummary, SessionGroup, Message, ModelInfo, SkillInfo, AgentInfo } from '@xyz-agent/shared'
import type { PiEvent, PiHistoryMessage } from './types.js'

// ── Adapter interfaces ──────────────────────────────────────────

export interface IRpcClient {
  prompt(content: string): Promise<unknown>
  abort(): Promise<unknown>
  setModel(provider: string, modelId: string): Promise<unknown>
  getHistory(): Promise<unknown>
  compact(): Promise<unknown>
  clear(): Promise<unknown>
  sendCommand(type: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown>
  onEvent(listener: (event: PiEvent) => void): () => void
  onExit(callback: (code: number | null) => void): void
  get exited(): boolean
}

export interface IProcessManager {
  createSession(sessionId: string, cwd: string, options?: Record<string, unknown>): Promise<IRpcClient>
  destroySession(sessionId: string): Promise<void>
  getClient(sessionId: string): IRpcClient | undefined
  getSessionIdByClient(client: IRpcClient): string | undefined
  hasClient(sessionId: string): boolean
  rekey(oldId: string, newId: string): void
  onSessionExit(callback: (sessionId: string, code: number | null) => void): void
  destroyAll(): Promise<void>
}

export interface IMessageBroker {
  send(to: unknown, msg: ServerMessage): void
  broadcast(msg: ServerMessage): void
  sendError(to: unknown, code: string, message: string, id?: string, sessionId?: string): void
}

export interface IEventAdapter {
  attach(client: { onEvent(listener: (event: PiEvent) => (() => void)) }): void
  detach(): void
}

// ── Service interfaces ──────────────────────────────────────────

export interface ISessionService {
  create(cwd?: string, label?: string): Promise<SessionSummary>
  delete(sessionId: string): Promise<void>
  renameSession(sessionId: string, name: string): Promise<void>
  sendMessage(sessionId: string, content: string): Promise<void>
  abort(sessionId: string): Promise<void>
  switchModel(sessionId: string, provider: string, modelId: string): Promise<string>
  compact(sessionId: string): Promise<void>
  clear(sessionId: string): Promise<void>
  getHistory(sessionId: string): Promise<Message[]>
  restoreSession(sessionId: string): Promise<SessionSummary>
  hasActiveSession(sessionId: string): boolean
  getSummary(sessionId: string): SessionSummary | undefined
  listPersistedSessions(): SessionGroup[]
  destroyAll(): Promise<void>
}

export interface IConfigService {
  // Provider CRUD
  listProviders(): ReturnType<import('./provider-store.js').listProviders>
  setProvider(providerId: string, data: Record<string, unknown>): void
  deleteProvider(providerId: string): void
  getProvider(providerId: string): import('./config-store.js').ProviderConfig | undefined
  updateToolPermissions(permissions: Record<string, string>): void
  // Skill CRUD
  loadSkills(projectRoot: string): SkillInfo[]
  saveSkills(projectRoot: string, skills: SkillInfo[]): void
  // Agent CRUD
  loadAgents(projectRoot: string): AgentInfo[]
  saveAgents(projectRoot: string, agents: AgentInfo[]): void
}

export interface IModelService {
  aggregateModels(providers: ReturnType<import('./provider-store.js').listProviders>): ModelInfo[]
  discoverModelsFromApi(baseUrl: string, apiKey?: string, providerType?: string): Promise<Array<{ id: string; name: string; ctx?: number }>>
}
```

**注意**: 接口定义需要与实际实现的方法签名精确匹配。执行时需要读取 RpcClient、ProcessManager、EventAdapter、SessionPool 的方法签名来微调。

**验证**: `npx tsc --noEmit` 通过

**Task 8: Extract Services + Refactor Server + Delete SessionPool (FR-1)**

这是最复杂的 Task。核心步骤：

**Step 1: 创建 services/session-service.ts**

从 `session-pool.ts` 提取所有 session 生命周期逻辑。类结构：

```typescript
export class SessionService implements ISessionService {
  private sessions = new Map<string, ManagedSession>()
  
  constructor(
    private pm: IProcessManager,
    private broker: IMessageBroker,
    private adapterFactory: (sessionId: string) => IEventAdapter,
  ) {}
  
  // 从 session-pool.ts 搬入的方法:
  // create(), delete(), renameSession(), sendMessage(), abort(),
  // switchModel(), compact(), clear(), getHistory(), restoreSession(),
  // hasActiveSession(), getSummary(), listPersistedSessions(), destroyAll()
  // + 所有 private helpers (toSummary, findScannedSession, scannedToSummary, getSkillPaths)
}
```

关键变化：
- `this.send(msg)` → `this.broker.broadcast(msg)`（WS 广播委托给 IMessageBroker）
- `new EventAdapter(id, (msg) => this.send(msg))` → `this.adapterFactory(id)`
- `this.pm` 类型从 `ProcessManager` 改为 `IProcessManager`
- `getSkillPaths()` 中 `loadSkills` 改从 `./skill-store.js` import

**Step 2: 创建 services/config-service.ts**

从 `server.ts` 的 `handleSettingsMessage()` 提取配置 CRUD 逻辑：

```typescript
export class ConfigService implements IConfigService {
  constructor(private projectRoot: string) {}
  
  listProviders() { return providerStore.listProviders() }
  setProvider(providerId: string, data: ...) { ... }
  deleteProvider(providerId: string) { ... }
  loadSkills(projectRoot: string) { return loadSkillsFromStore(projectRoot) }
  saveSkills(projectRoot: string, skills: SkillInfo[]) { ... }
  loadAgents(projectRoot: string) { ... }
  saveAgents(projectRoot: string, agents: AgentInfo[]) { ... }
  // ...
}
```

这个 Service 主要是一个 facade，编排 provider-store + config-store + skill-store + agent-store 的调用。业务逻辑（如 findIdx→splice→save）保持不变，只是从 server.ts 的 switch/case 中提取到独立方法。

**Step 3: 创建 services/model-service.ts**

从 `server.ts` 提取 `aggregateModels()` 和 `discoverModelsFromApi()`：

```typescript
export class ModelService implements IModelService {
  aggregateModels(providers: ...): ModelInfo[] { /* 从 server.ts 搬入 */ }
  discoverModelsFromApi(baseUrl: string, ...): Promise<...> { /* 从 server.ts 搬入 */ }
}
```

**Step 4: 重写 server.ts**

server.ts 变为纯 Transport 层：

```typescript
export class SidecarServer implements IMessageBroker {
  private sessionService: ISessionService
  private configService: IConfigService
  private modelService: IModelService
  // ... WS 基础设施成员保留

  constructor(
    private port: number,
    projectRoot?: string,
    // Service 通过 setter 或 init 方法注入（index.ts 组装）
  ) { ... }
  
  // IMessageBroker 实现
  send(ws: WsType, msg: ServerMessage): void { ... }
  broadcast(msg: ServerMessage): void { ... }
  sendError(ws: WsType, ...): void { ... }
  
  // handleMessage 简化为路由:
  private async handleMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'ping': ...
      case 'session.create': { ... this.sessionService.create(...) ... }
      case 'session.delete': { ... this.sessionService.delete(...) ... }
      // ... 27 个 case 全部路由到 Service 方法
    }
  }
}
```

server.ts 不再包含：
- 配置 CRUD 逻辑（`loadSkills`→`findIdx`→`splice`→`saveSkills`）
- 模型聚合（`aggregateModels`）
- API 发现（`discoverModelsFromApi`）
- Session 生命周期管理

server.ts 保留：
- WS 连接管理（handleConnection, heartbeat, client set）
- 消息分发（switch/case）
- 统一广播（broadcast, send, sendError）
- 初始状态推送（sendInitialState，调用 Service 获取数据）

**Step 5: 更新 index.ts**

```typescript
async function main(): Promise<void> {
  const { port, projectRoot } = parseArgs()
  const pm = new ProcessManager()
  
  // 组装 Service
  const broker: IMessageBroker = /* server 还没创建... */
  // 方案: server 先创建，然后创建 Service，再注入回 server
  
  const server = new SidecarServer(port, projectRoot)
  const sessionService = new SessionService(pm, server, 
    (sid) => new EventAdapter(sid, (msg) => server.broadcast(msg))
  )
  const configService = new ConfigService(projectRoot ?? process.cwd())
  const modelService = new ModelService()
  
  server.setServices(sessionService, configService, modelService)
  
  // ... 启动逻辑
}
```

**Step 6: 删除 session-pool.ts**

```bash
rm runtime/src/session-pool.ts
```

确认无残留 import（`grep -r "session-pool" runtime/src/`）。

**验证**: `npx tsc --noEmit` 通过。`npm run build` 通过。手动功能测试：`npm run dev` → 创建 session → 发送消息 → 分屏 → 切模型。

---

#### FG1: Frontend Quick Fixes

**Description:** 创建系统消息工厂、修复 refCount、删除死 composable。

**Tasks:** Task 9, Task 10

**Files (预估):** 9 个（1 create + 3 delete + 5 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose (executor) |
| Model | taskComplexity: medium |
| 注入上下文 | Task 9-10 描述 + spec FR-8/FR-9 + CLAUDE.md 前端编码规范 + xyz-ui 组件库规则 |
| 读取文件 | `renderer/src/stores/chat.ts`(SystemNotification 类型), `renderer/src/composables/useChat.ts`(refCount 参考实现), `renderer/src/composables/useSession.ts`, `renderer/src/composables/useProvider.ts`, `renderer/src/views/PanelSessionView.vue`, `renderer/src/App.vue`, `renderer/src/views/EmptyPanel.vue`, `renderer/src/components/chat/ChatInput.vue` |
| 修改/创建文件 | `renderer/src/lib/system-notification.ts`, `renderer/src/composables/useSession.ts`, `renderer/src/composables/useProvider.ts`, `renderer/src/views/PanelSessionView.vue`, `renderer/src/composables/useChat.ts`, `renderer/src/App.vue`, 删除 `renderer/src/composables/useModel.ts`, `renderer/src/composables/useRafBatch.ts`, `renderer/src/composables/useContext.ts` |

**Execution Flow (FG1 内部):** Task 9 先执行（创建工厂 + 删死代码），Task 10 并行。

  Task 9:
    1. general-purpose → 创建工厂函数 + 删除 3 个死 composable + 更新调用方

  Task 10 (可与 9 并行):
    1. general-purpose → 给 useSession/useProvider 加 refCount

**Dependencies:** 无（前端独立于 Runtime 重构）

**设计细节:**

**Task 9: System Notification Factory (FR-8) + Delete Dead Composables (FR-4 前端)**

1. 创建 `renderer/src/lib/system-notification.ts`：

```typescript
import type { SystemNotification } from '../stores/chat'

export type SystemNotificationType = 'done' | 'alert' | 'info'

export function createSystemNotification(
  type: SystemNotificationType,
  title: string,
  description?: string,
  action?: string,
): SystemNotification {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    notificationType: type,
    notificationTitle: title,
    notificationDescription: description,
    notificationAction: action,
    timestamp: Date.now(),
  }
}
```

2. 更新 `SystemNotification` 接口（stores/chat.ts）：在 `notificationType` 联合类型中加入 `'info'`：
   - `notificationType?: 'done' | 'alert'` → `notificationType?: 'done' | 'alert' | 'info'`

3. 更新所有调用方（逐个文件 grep `crypto.randomUUID()` + `role: 'system'` 的组合）：
   - `useChat.ts`: 替换手动构造为 `createSystemNotification('alert', ...)`
   - `App.vue`: 替换手动构造为 `createSystemNotification(...)`
   - `PanelSessionView.vue`: 如有手动构造，替换
   - `EmptyPanel.vue`: 如有手动构造，替换
   - `ChatInput.vue`: 如有手动构造，替换

4. 删除 3 个死 composable：
   - `rm renderer/src/composables/useModel.ts`
   - `rm renderer/src/composables/useRafBatch.ts`
   - `rm renderer/src/composables/useContext.ts`

5. **验证**: `npm run build` 通过（前后端）

**Task 10: Fix useSession/useProvider refCount (FR-9)**

1. 修改 `renderer/src/composables/useSession.ts`：
   - 添加模块级变量 `let globalListenerRefCount = 0`（与 useChat.ts 相同模式）
   - `onMounted` 中：先检查 `globalListenerRefCount === 0` 才注册 handler，然后 `globalListenerRefCount++`
   - `onUnmounted` 中：`globalListenerRefCount--`，当 `=== 0` 时注销 handler

2. 修改 `renderer/src/composables/useProvider.ts`：
   - 同上模式

3. **验证**: `npm run build` 通过。Split mode 功能测试。

---

## Dependency Graph & Wave Schedule

```
BG1 (Runtime 清理) ──→ BG2 (Store/Scanner/Type) ──→ BG3 (Service 提取)
         │
         └──→ FG1 (前端修复) [独立，可从 Wave 2 开始]
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | Runtime 死代码清理 + message-converter 提取 |
| Wave 2 | BG2, FG1 | BG2 依赖 BG1；FG1 独立可并行 |
| Wave 3 | BG3 | 依赖 BG1 + BG2 完成 |

---

## Self-Review Checklist

1. **Spec coverage**: 每个 FR (FR-1 to FR-9) 都有对应 Task。
2. **Placeholder scan**: 无 TBD/TODO/填空。
3. **Type consistency**: interfaces.ts 中的方法签名与实际实现匹配（执行时需微调）。
4. **AC coverage**: 每个 AC 条目可追溯到具体 Task 步骤。
5. **File count per group**: BG1=5, BG2=8, BG3=8, FG1=9 — 均 ≤ 10。
