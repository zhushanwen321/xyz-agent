---
verdict: pass
complexity: L2
---

# Plugin System: Frontend Integration + Quality + Backend Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the plugin system by fixing backend stubs, building full frontend UI, adding quality safeguards, and documenting the architecture.

**Architecture:** Plugin system spans three layers: (1) Backend PluginService in Worker Thread pool with JSON-RPC to Workers, (2) Pi Bridge Extension as the only adapter between plugin system and pi engine, (3) Frontend Plugin Pinia Store + Vue components communicating via WebSocket. Frontend sends flat-type WS messages (`plugin.xxx`), backend routes to appropriate Worker via RPC.

**Tech Stack:** TypeScript (strict), Vue 3 + Pinia + Tailwind CSS, Node.js Worker Threads, WebSocket, Vitest

---

## Sub-documents

| Document | Content |
|----------|---------|
| `plan-backend.md` | Backend task details: RPC routing, hook serialization, sessionData cache, hot reload, WS handlers |
| `plan-api-contract.md` | WS protocol types, RPC method signatures, data flow chains |
| `plan-frontend.md` | Frontend task details: Pinia store, UI components, event handling |
| `interface_chain.json` | Machine-readable method chain for L2 verification |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Renderer (Vue 3)                        │
│  PluginStore ──→ WS Client ──→ Event Bus ──→ Components    │
│  (Pinia)         (plugin.xxx)              (PluginsPane,   │
│                                            SlashMenu, etc)  │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket
┌──────────────────────▼──────────────────────────────────────┐
│                   Agent Runtime (Node.js)                    │
│  server.ts ──→ PluginService ──→ PluginHost (Worker Pool)   │
│  (handlers)     (orchestrator)    ├─ Worker 1 (Goal)        │
│                                  ├─ Worker 2 (Todo)         │
│                                  └─ Worker N (external)     │
│                                                              │
│  PluginRPC (JSON-RPC over MessagePort)                       │
│  PluginActivator ──→ PluginRegistry ──→ PluginStorage       │
└──────────────────────┬──────────────────────────────────────┘
                       │ stdin/stdout JSON-RPC
┌──────────────────────▼──────────────────────────────────────┐
│                    Pi Engine Process                         │
│  Pi Bridge Extension ──→ extension_ui_request/response       │
│  (registers proxy tools/slash commands)                     │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/shared/src/protocol.ts` | modify | BG1 | Add new WS message types for plugin |
| `src-electron/runtime/src/services/plugin-service/plugin-service.ts` | modify | BG1 | Fix handleBridgeToolExecute + executeHooks |
| `src-electron/runtime/src/server.ts` | modify | BG1 | Add plugin WS message handlers |
| `src-electron/runtime/test/plugin-tool-execution.test.ts` | create | BG1 | Test tool RPC routing to Worker |
| `src-electron/runtime/test/plugin-hooks-serial.test.ts` | create | BG1 | Test hook serialization + block |
| `src-electron/runtime/src/services/plugin-service/plugin-activator.ts` | modify | BG2 | Add hot reload (fs.watch) |
| `src-electron/runtime/src/services/plugin-service/api/session-data-api.ts` | modify | BG2 | Add local cache + flush |
| `src-electron/runtime/test/plugin-hot-reload.test.ts` | create | BG2 | Test hot reload cycle |
| `src-electron/runtime/test/plugin-session-data-cache.test.ts` | create | BG2 | Test cache fallback |
| `src-electron/runtime/test/bridge-reconnect.test.ts` | create | BG3 | Test Bridge reconnection states |
| `resources/plugins/goal/__tests__/goal.test.ts` | create | BG3 | Goal plugin unit tests |
| `resources/plugins/todo/__tests__/todo.test.ts` | create | BG3 | Todo plugin unit tests |
| `src-electron/renderer/src/stores/plugin.ts` | create | FG1 | Plugin Pinia store |
| `src-electron/renderer/src/composables/usePlugin.ts` | create | FG1 | Plugin WS event composable |
| `src-electron/renderer/src/components/settings/PluginsPane.vue` | create | FG2 | Plugin management list UI |
| `src-electron/renderer/src/components/settings/PluginSettingsForm.vue` | create | FG2 | Dynamic plugin config form |
| `src-electron/renderer/src/components/plugin/PluginPermissionDialog.vue` | modify | FG2 | Enhance permission approval dialog |
| `src-electron/renderer/src/components/plugin/MessageDecoration.vue` | create | FG3 | Plugin message decoration tags |
| `src-electron/renderer/src/components/layout/AppStatusbar.vue` | modify | FG3 | Fix event name + enhance plugin items |
| `src-electron/renderer/src/components/chat/SlashMenu.vue` | modify | FG3 | Add plugin slash commands |
| `CLAUDE.md` | modify | DG1 | Add plugin architecture section |
| `README.md` | modify | DG1 | Add plugin system overview |

## Task List

| # | Task | Type | Depends on | Group | Spec Ref |
|---|------|------|-----------|-------|----------|
| T1 | Fix handleBridgeToolExecute — RPC route to Worker | backend | — | BG1 | FR-A1 |
| T2 | Fix executeHooks — serial await with block/transform | backend | T1 | BG1 | FR-A2/C3 |
| T3 | Expand WS protocol types + server handlers | backend | T1 | BG1 | FR-B1 |
| T4 | sessionData local cache + flush | backend | T2 | BG2 | FR-C4 |
| T5 | Plugin hot reload (fs.watch + debounce) | backend | T2 | BG2 | FR-C5 |
| T6 | Bridge reconnect tests | backend | T3 | BG3 | FR-C1 |
| T7 | Goal/Todo plugin unit tests | backend | — | BG3 | FR-C2 |
| T8 | Plugin Pinia Store + WS event composable | frontend | T3 | FG1 | FR-B1 |
| T9 | PluginsPane management UI | frontend | T8 | FG2 | FR-B2 |
| T10 | PluginSettingsForm dynamic config | frontend | T8 | FG2 | FR-B3 |
| T11 | Permission dialog enhancement | frontend | T8 | FG2 | FR-B5 |
| T12 | Status bar + MessageDecoration + SlashMenu | frontend | T8 | FG3 | FR-B4 |
| T13 | Documentation (CLAUDE.md + README.md) | docs | BG1 | DG1 | FR-D1/D2 |

## Execution Groups

### BG1: Backend Core Fixes

**Description:** Fix the two critical stubs in PluginService: handleBridgeToolExecute (tool execution) and executeHooks (hook chain). Add new WS protocol types and server handlers.

**Tasks:** T1, T2, T3

**Files (5):** 3 modify + 2 create

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: high (executor), medium (TDD), medium (reviewer) |
| 注入上下文 | T1-T3 描述 + spec FR-A1/A2/C3/B1 + backend-dev skill + plugin-types.ts 类型 |
| 读取文件 | `plugin-service.ts`, `plugin-rpc-server.ts`, `plugin-host.ts`, `server.ts`, `protocol.ts`, `plugin-types.ts` |
| 修改/创建文件 | 见 File Structure BG1 行 |

**Execution Flow (BG1 内部):** 串行派遣。

  T1 (handleBridgeToolExecute):
    1. general-purpose (TDD + backend-dev) → 写 plugin-tool-execution.test.ts 失败测试
    2. general-purpose (backend-dev) → 修改 plugin-service.ts handleBridgeToolExecute
    3. general-purpose (expert-reviewer) → spec 合规检查

  T2 (executeHooks — depends on T1):
    1. general-purpose (TDD + backend-dev) → 写 plugin-hooks-serial.test.ts 失败测试
    2. general-purpose (backend-dev) → 修改 plugin-service.ts executeHooks
    3. general-purpose (expert-reviewer) → spec 合规检查

  T3 (WS protocol + handlers — depends on T1):
    1. general-purpose (backend-dev) → 修改 protocol.ts 添加新类型
    2. general-purpose (backend-dev) → 修改 server.ts 添加新 handler
    3. general-purpose (expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 见 `plan-backend.md` §1-3

---

### BG2: Backend Quality Enhancements

**Description:** Add sessionData local cache with flush mechanism and plugin hot reload via fs.watch.

**Tasks:** T4, T5

**Files (5):** 3 modify + 2 create

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | T4-T5 描述 + spec FR-C4/C5 + backend-dev skill + session-data-api.ts 现有实现 |
| 读取文件 | `plugin-service.ts`, `plugin-activator.ts`, `api/session-data-api.ts`, `plugin-types.ts` |
| 修改/创建文件 | 见 File Structure BG2 行 |

**Execution Flow:** 串行派遣。

  T4 (sessionData cache):
    1. TDD → 写 plugin-session-data-cache.test.ts
    2. backend-dev → 修改 plugin-service.ts + session-data-api.ts
    3. reviewer → spec 合规检查

  T5 (hot reload — depends on T4):
    1. TDD → 写 plugin-hot-reload.test.ts
    2. backend-dev → 修改 plugin-activator.ts
    3. reviewer → spec 合规检查

**Dependencies:** BG1（plugin-service.ts 修改模式参照 BG1）

**设计细节:** 见 `plan-backend.md` §4-5

---

### BG3: Backend Test Suite

**Description:** Write Bridge reconnection tests and Goal/Todo plugin unit tests.

**Tasks:** T6, T7

**Files (3):** 3 create

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | T6-T7 描述 + spec FR-C1/C2 + bridge-sync.test.ts 作为参考模式 |
| 读取文件 | `bridge-sync.test.ts`（参考模式）, `resources/plugins/goal/index.ts`, `resources/plugins/todo/index.ts` |
| 修改/创建文件 | 见 File Structure BG3 行 |

**Execution Flow:** 串行派遣。

  T6 (Bridge reconnect — depends on T3 for protocol types):
    1. general-purpose → 写 bridge-reconnect.test.ts
    2. reviewer → spec 合规检查

  T7 (Goal/Todo tests — independent):
    1. general-purpose → 写 goal.test.ts + todo.test.ts
    2. reviewer → spec 合规检查

**Dependencies:** BG1（T6 测试 T3 新增的协议类型）

**设计细节:** 见 `plan-backend.md` §6-7

---

### FG1: Frontend Foundation

**Description:** Create Plugin Pinia store and usePlugin composable. Handle all plugin WS events.

**Tasks:** T8

**Files (3):** 2 create + 1 modify (protocol.ts 类型已由 BG1 添加)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | T8 描述 + spec FR-B1 + frontend-dev skill + 现有 store 模式（chat.ts, session.ts） |
| 读取文件 | `stores/chat.ts`, `stores/session.ts`, `composables/useChat.ts`, `protocol.ts` |
| 修改/创建文件 | 见 File Structure FG1 行 |

**Execution Flow:**

  T8 (Plugin Store + composable):
    1. general-purpose (frontend-dev) → 骨架→功能→美化（stores/plugin.ts + composables/usePlugin.ts）
    2. general-purpose (expert-reviewer) → spec 合规检查

**Dependencies:** BG1（需要 protocol.ts 中的新 WS 类型）

**设计细节:** 见 `plan-frontend.md` §1

---

### FG2: Frontend Plugin Management UI

**Description:** Build PluginsPane, PluginSettingsForm, and enhance PluginPermissionDialog.

**Tasks:** T9, T10, T11

**Files (3):** 2 create + 1 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | T9-T11 描述 + spec FR-B2/B3/B5 + frontend-dev skill + ExtensionsPane.vue 参考模式 |
| 读取文件 | `ExtensionsPane.vue`, `ExtensionSection.vue`, `PluginPermissionDialog.vue`, `stores/plugin.ts`（FG1 产出） |
| 修改/创建文件 | 见 File Structure FG2 行 |

**Execution Flow:** 串行派遣。

  T9 (PluginsPane):
    1. general-purpose (frontend-dev) → 骨架→功能→美化
    2. general-purpose (expert-reviewer) → spec 合规检查

  T10 (PluginSettingsForm):
    1. general-purpose (frontend-dev) → 骨架→功能→美化
    2. general-purpose (expert-reviewer) → spec 合规检查

  T11 (PermissionDialog):
    1. general-purpose (frontend-dev) → 增强现有骨架
    2. general-purpose (expert-reviewer) → spec 合规检查

**Dependencies:** FG1（需要 plugin store）

**设计细节:** 见 `plan-frontend.md` §2-4

---

### FG3: Frontend Integration Components

**Description:** Integrate plugins with existing UI: status bar, message decorations, slash commands.

**Tasks:** T12

**Files (3):** 1 create + 2 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | T12 描述 + spec FR-B4 + frontend-dev skill + 现有组件模式 |
| 读取文件 | `AppStatusbar.vue`, `SlashMenu.vue`, `MessageBubble.vue`, `stores/plugin.ts` |
| 修改/创建文件 | 见 File Structure FG3 行 |

**Execution Flow:**

  T12 (Status bar + Decoration + SlashMenu):
    1. general-purpose (frontend-dev) → 修改 AppStatusbar + 创建 MessageDecoration + 修改 SlashMenu
    2. general-purpose (expert-reviewer) → spec 合规检查

**Dependencies:** FG1（需要 plugin store）

**设计细节:** 见 `plan-frontend.md` §5

---

### DG1: Documentation

**Description:** Write plugin architecture into CLAUDE.md and README.md.

**Tasks:** T13

**Files (2):** 2 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: low |
| 注入上下文 | T13 描述 + spec FR-D1/D2 + CONTEXT.md 术语定义 |
| 读取文件 | `CLAUDE.md`, `README.md`, `docs/architecture/plugin-system-plan.md` |
| 修改/创建文件 | `CLAUDE.md`, `README.md` |

**Dependencies:** BG1 + FG1（需要最终架构确认）

## Dependency Graph & Wave Schedule

```
BG1 (backend core) ──┬──→ BG2 (backend quality)
         │
         ├──→ BG3 (backend tests)
         │
         └──→ FG1 (frontend foundation) ──┬──→ FG2 (frontend UI)
         │                                │
         │                                └──→ FG3 (frontend integration)
         │
         └──→ DG1 (documentation)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 后端核心修复，无依赖 |
| Wave 2 | BG2, BG3, FG1, DG1 | BG2/BG3 依赖 BG1；FG1 依赖 BG1 协议类型；DG1 可与 BG1 并行但建议等 BG1 确认架构 |
| Wave 3 | FG2, FG3 | 依赖 FG1 store 就绪 |

## Interface Contracts

### Module: PluginService (backend)

#### Class: PluginService

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| handleBridgeToolExecute | (request: BridgeToolExecuteRequest) → Promise\<BridgeToolExecuteResponse\> | `{ content, isError }` | Tool not found → isError; Worker crash → catch; RPC timeout 30s → isError | AC-A1 |
| executeHooks | (hookType: string, context: HookContext) → Promise\<HookResult\> | `{ blocked, blockedBy?, transformedContent? }` | No handlers → `{ blocked: false }`; Single Worker timeout 5s → skip; blocked → stop chain | AC-A2, AC-A3 |
| watchAndReload | (pluginPath: string) → void | void | built-in ignored; debounce 300ms; deactivate timeout 5s → force | AC-C5 |

### Module: PluginStore (frontend)

#### Class: usePluginStore (Pinia)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| fetchPlugins | () → Promise\<void\> | void | WS error → keep last state | AC-B1 |
| togglePlugin | (id: string, enabled: boolean) → Promise\<void\> | void | built-in → no-op | AC-B2 |
| approvePermissions | (id: string, perms: string[]) → Promise\<void\> | void | — | AC-B7 |
| revokePermissions | (id: string) → Promise\<void\> | void | — | AC-B7 |

#### Data: PluginInfo (frontend view model)

| Field | Type | Description |
|-------|------|-------------|
| pluginId | string | Unique plugin identifier |
| displayName | string | Human-readable name |
| version | string | Semver |
| status | 'discovered' \| 'loaded' \| 'active' \| 'inactive' \| 'crashed' | Current state |
| trustLevel | 'trusted' \| 'sandbox' | Trust classification |
| source | 'built-in' \| 'external' | Installation source |
| permissions | string[] | Granted permissions |
| contributes | PluginContributes | Slash commands, tools, hooks, status bar items |

### Module: WS Protocol (shared)

#### Client → Server (plugin.*)

| Type | Payload | Response | Spec Ref |
|------|---------|----------|----------|
| plugin.list | `{}` | config.plugins | AC-B1 |
| plugin.toggle | `{ pluginId, enabled }` | config.plugins | AC-B2 |
| plugin.uninstall | `{ pluginId }` | config.plugins | AC-B2 |
| plugin.approvePermissions | `{ pluginId, permissions }` | — | AC-B7 |
| plugin.revokePermissions | `{ pluginId }` | — | AC-B7 |
| plugin.executeCommand | `{ pluginId, commandId, args? }` | — | AC-A4 |
| plugin.config.get | `{ pluginId, key }` | plugin:config | AC-B3 |
| plugin.config.set | `{ pluginId, key, value }` | plugin:config | AC-B3 |

#### Server → Client (plugin:*)

| Type | Payload | Spec Ref |
|------|---------|----------|
| plugin:statusChange | `{ pluginId, oldStatus, newStatus }` | AC-C5 |
| plugin:permissionRequest | `{ pluginId, permissions }` | AC-B7 |
| plugin:statusBarUpdate | `{ items: StatusBarItem[] }` | AC-B4 |
| plugin:messageDecoration | `{ sessionId, messageId, decorations }` | AC-B6 |
| plugin:config | `{ pluginId, config }` | AC-B3 |
| plugin:crashed | `{ pluginId, error }` | AC-B1 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-A1 | PluginService.handleBridgeToolExecute | Bridge → server.ts → PluginService → Worker RPC → response | T1 |
| AC-A2 | PluginService.executeHooks | server.ts → PluginService → sorted Workers → block check | T2 |
| AC-A3 | PluginService.executeHooks (transformedContent) | Hook chain context mutation | T2 |
| AC-A4 | plugin.executeCommand WS | Frontend → WS → server.ts → PluginService → Worker | T3, T12 |
| AC-B1 | PluginStore.fetchPlugins | Frontend → WS plugin.list → server → PluginService.listPlugins → response | T8 |
| AC-B2 | PluginStore.togglePlugin | Frontend → WS plugin.toggle → server → PluginService.toggle → response | T8, T9 |
| AC-B3 | plugin.config.get/set | Frontend → WS → server → PluginService → Worker RPC config | T10 |
| AC-B4 | plugin:statusBarUpdate | Worker → PluginService → server broadcast → AppStatusbar | T12 |
| AC-B5 | plugin:statusBarUpdate (slash commands) | Same as AC-B4 for slash command list | T12 |
| AC-B6 | plugin:messageDecoration | Worker → PluginService → server broadcast → MessageDecoration | T12 |
| AC-B7 | plugin:permissionRequest / approvePermissions | Worker → PluginService → server → dialog → WS approve → PluginService | T11 |
| AC-C1 | Bridge reconnect test | test only | T6 |
| AC-C2 | Goal/Todo plugin tests | test only | T7 |
| AC-C3 | executeHooks serial test | test only (same as T2) | T2 |
| AC-C4 | sessionData cache | Worker set → cache → flush; Worker get → cache hit/miss | T4 |
| AC-C5 | hot reload | fs.watch → debounce → deactivate → activate → statusChange | T5 |
| AC-D1 | CLAUDE.md plugin section | docs only | T13 |
| AC-D2 | README.md update | docs only | T13 |

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-A1 handleBridgeToolExecute RPC routing | adopted | T1 |
| AC-A2 executeHooks block chain | adopted | T2 |
| AC-A3 hook content transform | adopted | T2 |
| AC-A4 plugin.executeCommand WS | adopted | T3, T12 |
| AC-B1 Plugin Store + WS init | adopted | T8 |
| AC-B2 Toggle + uninstall | adopted | T8, T9 |
| AC-B3 PluginSettingsForm config | adopted | T10 |
| AC-B4 Status bar items | adopted | T12 |
| AC-B5 SlashMenu commands | adopted | T12 |
| AC-B6 Message decoration | adopted | T12 |
| AC-B7 Permission dialog | adopted | T11 |
| AC-C1 Bridge reconnect test | adopted | T6 |
| AC-C2 Goal/Todo tests | adopted | T7 |
| AC-C3 executeHooks serial test | adopted | T2 (覆盖) |
| AC-C4 sessionData cache | adopted | T4 |
| AC-C5 Hot reload | adopted | T5 |
| AC-D1 CLAUDE.md | adopted | T13 |
| AC-D2 README.md | adopted | T13 |
