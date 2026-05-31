---
verdict: pass
complexity: L2
---

# Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 pi extension setStatus → xyz-agent frontend 的数据管道，新增 InputToolbar / SessionStrip / GlobalStatusbar 三个 UI 区域，让用户一目了然地看到 session 运行时状态。

**Architecture:** 三层架构——(1) Sidecar 层：event-adapter 翻译 setStatus → server.ts 路由到 plugin hooks → statusline plugin 适配转发为 plugin:statusBarUpdate；(2) Frontend 层：统一监听 plugin:statusBarUpdate，按 scope 路由到 SessionStrip（per-session）或 GlobalStatusbar（global），InputToolbar 直接从 chatStore 读取 context/model 数据；(3) Shared 层：扩展 StatusBarItem 类型增加 scope/sessionId 字段。

**Tech Stack:** Vue 3 + Pinia + Tailwind CSS v3 + xyz-ui (frontend) / Node.js + WebSocket (sidecar) / TypeScript (shared types)

---

## Sub-documents

- Backend design: [plan-backend.md](plan-backend.md)
- API contract: [plan-api-contract.md](plan-api-contract.md)
- Frontend design: [plan-frontend.md](plan-frontend.md)
- Interface chain: [interface_chain.json](interface_chain.json)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/shared/src/protocol.ts` | modify | BG1 | 扩展 StatusBarItem 增加 scope/sessionId；扩展 ServerMessageType 增加 plugin:statusSetUpdate |
| `src-electron/runtime/src/event-adapter.ts` | modify | BG1 | 修复 setStatus 丢弃逻辑，翻译为 plugin:statusSetUpdate |
| `src-electron/runtime/src/server.ts` | modify | BG1 | 修复 bridge:event + 路由 statusSetUpdate 到 plugin hooks |
| `src-electron/runtime/src/services/plugin-service/plugin-service.ts` | modify | BG1 | 扩展 updateStatusBarItem 参数；改为注册式管理 |
| `src-electron/runtime/src/services/plugin-service/api/ui-api.ts` | modify | BG1 | 扩展 RPC handler 接收新参数 |
| `src-electron/runtime/src/services/plugin-service/plugin-types.ts` | modify | BG1 | 扩展 Phase2AgentAPI.ui.updateStatusBarItem 签名 |
| `src-electron/runtime/src/index.ts` | modify | BG1 | 注册 onStatusSetUpdate 回调连接 event-adapter → server |
| `resources/plugins/statusline/package.json` | create | BG2 | Statusline built-in plugin manifest |
| `resources/plugins/statusline/index.ts` | create | BG2 | Statusline plugin 实现（hook + 映射表 + 转发） |
| `src-electron/renderer/src/stores/plugin.ts` | modify | FG1 | 增加 scope/sessionId 过滤 computed |
| `src-electron/renderer/src/composables/usePlugin.ts` | modify | FG1 | 扩展 plugin:statusBarUpdate handler 处理新字段 |
| `src-electron/renderer/src/components/chat/InputToolbar.vue` | create | FG1 | Input Toolbar 组件（model picker, thinking level, context bar, token stats） |
| `src-electron/renderer/src/components/chat/SessionStrip.vue` | create | FG1 | Session Strip 组件（branch, extension chips） |
| `src-electron/renderer/src/components/layout/AppStatusbar.vue` | modify | FG1 | 重构为左侧连接+版本，右侧 global extension chips |
| `src-electron/renderer/src/components/chat/ChatInput.vue` | modify | FG1 | 集成 InputToolbar + SessionStrip |
| `docs/plugin/built-in-plugin-guide.md` | create | FG2 | Built-in plugin 开发指南（以 statusline 为案例） |

---

## Task List

| # | Task | Type | Depends on | Group | Spec Ref |
|---|------|------|-----------|-------|----------|
| 1 | Extend shared protocol types | backend | — | BG1 | FR-1, FR-6 |
| 2 | Fix event-adapter to translate setStatus | backend | 1 | BG1 | FR-1, AC-1 |
| 3 | Fix server.ts bridge:event + route statusSetUpdate | backend | 2 | BG1 | FR-1, AC-8 |
| 4 | Wire onStatusSetUpdate callback in index.ts | backend | 2, 3 | BG1 | FR-1, AC-1 |
| 5 | Emit context.update from event-adapter | backend | 1 | BG1 | FR-3, AC-2 |
| 6 | Extend plugin-service + ui-api statusBarUpdate | backend | 1 | BG1 | FR-6, AC-6 |
| 7 | Create statusline built-in plugin | backend | 6 | BG2 | FR-2, AC-1 |
| 8 | Extend frontend plugin store + usePlugin composable | frontend | 1 | FG1 | FR-4, FR-5, AC-3 |
| 9 | Create InputToolbar.vue | frontend | 8 | FG1 | FR-3, AC-2 |
| 10 | Create SessionStrip.vue | frontend | 8 | FG1 | FR-4, AC-3 |
| 11 | Refactor AppStatusbar.vue | frontend | 8 | FG1 | FR-5, AC-4 |
| 12 | Integrate statusline into ChatInput.vue | frontend | 9, 10 | FG1 | FR-3, FR-4 |
| 13 | Write built-in plugin development guide | docs | 7 | FG2 | FR-7, AC-7 |

---

## Interface Contracts

### Module: shared-protocol

#### Type: StatusBarItem (extended)

| Field | Type | Description | Spec Ref |
|-------|------|-------------|----------|
| id | string | Unique item ID | existing |
| pluginId | string | Owning plugin ID | existing |
| text | string | Display text | existing |
| tooltip | string \| undefined | Hover tooltip | FR-6 |
| commandId | string \| undefined | Clickable command ID | FR-6 |
| priority | number | Sort order (lower = first) | existing |
| scope | 'per-session' \| 'global' | Routing scope | FR-6, AC-5 |
| sessionId | string \| undefined | Session ID for per-session items | FR-6 |

#### Type: ServerMessageType (extended)

| Value | Description | Spec Ref |
|-------|-------------|----------|
| 'plugin:statusSetUpdate' | event-adapter translated setStatus | FR-1 |

#### Type: StatusSetUpdatePayload

| Field | Type | Description |
|-------|------|-------------|
| sessionId | string | Source session ID |
| key | string | Pi extension setStatus key |
| text | string | Status display text |

### Module: plugin-service

#### Class: PluginService

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| updateStatusBarItem | (pluginId: string, id: string, text: string, options?: StatusBarItemOptions) → void | void | options omitted → defaults (priority=100, scope='global') | FR-6, AC-6 |
| getStatusBarItems | () → StatusBarItem[] | StatusBarItem[] | empty map → [] | FR-6 |

#### Type: StatusBarItemOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| tooltip | string \| undefined | undefined | Hover tooltip |
| commandId | string \| undefined | undefined | Click command |
| priority | number | 100 | Sort priority |
| scope | 'per-session' \| 'global' | 'global' | Routing scope |
| sessionId | string \| undefined | undefined | Session binding |

### Module: statusline-plugin

#### Function: activate

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| activate | (api: Phase2AgentAPI) → { dispose(): void } | Plugin activation result | — | FR-2 |

#### Internal: keyToMetadata mapping

| key | priority | tooltip | scope |
|-----|----------|---------|-------|
| 'goal' | 10 | 'Goal task progress' | 'per-session' |
| 'todo' | 20 | 'Todo list progress' | 'per-session' |
| 'workflow' | 15 | 'Workflow status' | 'per-session' |
| 'preset' | 30 | 'Active preset' | 'global' |
| *(unknown)* | 100 | undefined | 'global' |

### Module: plugin-store (frontend)

#### Class: usePluginStore (Pinia)

| Method/Computed | Signature | Returns | Edge Cases | Spec Ref |
|-----------------|-----------|---------|------------|----------|
| getSessionStatusBarItems | (sessionId: string) → StatusBarItem[] | filtered items | no matching items → [] | AC-3 |
| globalStatusBarItems | computed → StatusBarItem[] | scope='global' items sorted by priority | no global items → [] | AC-4 |

### Module: InputToolbar.vue

#### Props

| Prop | Type | Description |
|------|------|-------------|
| sessionId | string | Current panel's session ID |

#### Data Sources (from stores, not props)

| Data | Store | Field | Spec Ref |
|------|-------|-------|----------|
| modelId | sessionStore | getSessionState(sessionId).modelId | FR-3 |
| models | modelStore | models | FR-3 |
| thinkingLevelMap | modelStore | currentModel.thinkingLevelMap | FR-3 |
| contextUsagePercent | chatStore | getSessionState(sessionId).contextUsagePercent | FR-3 |
| contextInputTokens | chatStore | getSessionState(sessionId).contextInputTokens | FR-3 |
| tokenUsage | chatStore | getSessionState(sessionId).tokenUsage | FR-3 |

### Module: SessionStrip.vue

#### Props

| Prop | Type | Description |
|------|------|-------------|
| sessionId | string | Current panel's session ID |

#### Data Sources

| Data | Store | Field | Spec Ref |
|------|-------|-------|----------|
| branch | sessionStore | getSessionState(sessionId).gitBranch | FR-4 |
| extensionChips | pluginStore | getSessionStatusBarItems(sessionId) | FR-4 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method / Component | Data Flow | Task |
|---------|------------------------------|-----------|------|
| AC-1 (setStatus→frontend) | EventAdapter.translate → Server.handleBridgeRequest → PluginService.handleBridgeEvent → statusline plugin → updateStatusBarItem → WS broadcast → usePlugin handler | pi RPC → event-adapter → server → plugin hooks → plugin-service → WS → plugin store | 1, 2, 3, 4, 7 |
| AC-2 (Input Toolbar) | InputToolbar.vue → chatStore/sessionStore/modelStore | store reads + context.update WS | 5, 9 |
| AC-3 (Session Strip) | SessionStrip.vue → pluginStore.getSessionStatusBarItems | plugin:statusBarUpdate → store → computed filter | 6, 8 |
| AC-4 (Global Statusbar) | AppStatusbar.vue → pluginStore.globalStatusBarItems | plugin:statusBarUpdate → store → computed filter | 6, 9 |
| AC-5 (信息不重复) | scope routing in stores + components | scope field determines component target | 6, 8, 9 |
| AC-6 (statusBarUpdate 增强) | PluginService.updateStatusBarItem(id, text, options?) | plugin RPC → plugin-service → WS | 6 |
| AC-7 (开发指南) | built-in-plugin-guide.md | — | 11 |
| AC-8 (bridge:event 修复) | Server.handleBridgeRequest → PluginService.handleBridgeEvent | bridge WS → server → plugin-service | 3 |

---

## Spec Metrics Traceability

| Spec AC | 采纳状态 | 对应 Task |
|---------|---------|----------|
| AC-1: setStatus→frontend | adopted | Tasks 1, 2, 3, 4, 7 |
| AC-2: Input Toolbar 功能 | adopted | Tasks 5, 9 |
| AC-3: Session Strip 信息展示 | adopted | Tasks 8, 10 |
| AC-4: Global Statusbar 聚合 | adopted | Tasks 8, 11 |
| AC-5: 信息不重复 | adopted | Tasks 8, 10, 11 (scope routing) |
| AC-6: statusBarUpdate 增强 | adopted | Task 6 |
| AC-7: 开发指南 | adopted | Task 13 |
| AC-8: bridge:event 修复 | adopted | Task 3 |

---

## Execution Groups

#### BG1: Backend Pipeline

**Description:** 修复 event-adapter → server → plugin-service 数据管道。包含协议类型扩展、setStatus 翻译、bridge:event 接通、statusBarUpdate API 增强。这些变更共同打通 pi extension setStatus 到 plugin hooks 的通路。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6

**Files (预估):** 8 个文件（0 create + 8 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium、reviewer: medium） |
| 注入上下文 | Task 描述 + spec FR-1/FR-6/AC-1/AC-6/AC-8 + 后端编码规范 |
| 读取文件 | event-adapter.ts, server.ts, plugin-service.ts, ui-api.ts, plugin-types.ts, protocol.ts, index.ts |
| 修改/创建文件 | 同 File Structure 中 BG1 行 + index.ts |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1 (protocol types, no deps):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 2 (event-adapter, depends on Task 1):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 3 (server.ts, depends on Task 2):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 4 (wire onStatusSetUpdate in index.ts, depends on Tasks 2+3):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 5 (emit context.update from event-adapter, depends on Task 1):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 6 (plugin-service + ui-api, depends on Task 1):
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** 见 plan-backend.md §1-4 + plan-api-contract.md

---

#### BG2: Statusline Built-in Plugin

**Description:** 新建 statusline built-in plugin，作为 pi extension setStatus 数据的适配层。接收 plugin:statusSetUpdate 事件，查映射表附加 metadata，通过 updateStatusBarItem 转发到前端。

**Tasks:** Task 7

**Files (预估):** 2 个文件（2 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | Task 描述 + spec FR-2 + key→metadata 映射表 + 现有 plugin 示例路径 |
| 读取文件 | resources/plugins/todo/package.json, resources/plugins/todo/index.ts (参考结构) |
| 修改/创建文件 | resources/plugins/statusline/package.json, resources/plugins/statusline/index.ts |

**Execution Flow (BG2 内部):** 单 Task。

  Task 5:
    1. general-purpose (read xyz-harness-test-driven-development + xyz-harness-backend-dev) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 写实现代码
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1（需要 Task 6 的 updateStatusBarItem 新参数就绪）

**设计细节:** 见 plan-backend.md §5

---

#### FG1: Frontend Components

**Description:** 扩展前端 plugin store 支持 scope 过滤，创建 InputToolbar 和 SessionStrip 新组件，重构 AppStatusbar，集成到 ChatInput。

**Tasks:** Task 8, Task 9, Task 10, Task 11, Task 12

**Files (预估):** 6 个文件（2 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（前端: medium） |
| 注入上下文 | Task 描述 + spec UI 规格 (FR-3/FR-4/FR-5) + 前端规范 + 设计稿路径 |
| 读取文件 | plugin.ts, usePlugin.ts, AppStatusbar.vue, ChatInput.vue, css_design-system.css, views_statusline-v2.html |
| 修改/创建文件 | 同 File Structure 中 FG1 行 |

**Execution Flow (FG1 内部):** 串行派遣。

  Task 6 (store + composable, no deps within FG):
    1. general-purpose (read xyz-harness-frontend-dev) → 实现
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 7 (InputToolbar, depends on Task 6):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能→美化
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 8 (SessionStrip, depends on Task 6):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能→美化
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 9 (AppStatusbar refactor, depends on Task 6):
    1. general-purpose (read xyz-harness-frontend-dev) → 骨架→功能→美化
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 10 (ChatInput integration, depends on Tasks 7+8):
    1. general-purpose (read xyz-harness-frontend-dev) → 集成
    2. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** BG1（需要 Task 1 的 protocol types + Task 5 的 context.update 就绪）

**设计细节:** 见 plan-frontend.md §1-5

---

#### FG2: Documentation

**Description:** 产出 built-in plugin 开发指南，以 statusline plugin 为实际案例。

**Tasks:** Task 13

**Files (预估):** 1 个文件（1 create + 0 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | medium |
| 注入上下文 | Task 描述 + spec FR-7 + statusline plugin 源码路径 |
| 读取文件 | resources/plugins/statusline/package.json, resources/plugins/statusline/index.ts |
| 修改/创建文件 | docs/plugin/built-in-plugin-guide.md |

**Execution Flow (FG2 内部):** 单 Task。

  Task 7:
    1. general-purpose → 写开发指南文档

**Dependencies:** BG2（需要 Task 7 的 statusline plugin 实现作为参考）

---

## Dependency Graph & Wave Schedule

```
BG1 (backend pipeline + context.update) ──┬──→ BG2 (statusline plugin) ──→ FG2 (docs)
         │
         └──→ FG1 (frontend components)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 后端管道修复 + context.update 发出，无依赖 |
| Wave 2 | BG2, FG1 | BG2 依赖 BG1 Task 6；FG1 依赖 BG1 Task 1 + Task 5 |
| Wave 3 | FG2 | 依赖 BG2 的 statusline plugin 实现作为参考 |

**并行约束:** Wave 2 中 BG2 和 FG1 可并行执行（不修改相同文件）。

---

## Context Discovery Notes

以下信息来自 Phase 1 深度代码扫描，plan 执行时需注意：

### 关键代码位置
- event-adapter.ts 丢弃 setStatus: `src-electron/runtime/src/event-adapter.ts` 行 ~145-146
- server.ts bridge:event 只打日志: `src-electron/runtime/src/server.ts` 行 ~715-719
- plugin-service updateStatusBarItem: `src-electron/runtime/src/services/plugin-service/plugin-service.ts` 行 ~290-297
- ui-api updateStatusBarItem RPC: `src-electron/runtime/src/services/plugin-service/api/ui-api.ts`
- protocol.ts StatusBarItem: `src-electron/shared/src/protocol.ts` 行 ~225-237
- plugin store: `src-electron/renderer/src/stores/plugin.ts`
- usePlugin handler: `src-electron/renderer/src/composables/usePlugin.ts` 行 ~60-63
- AppStatusbar.vue: `src-electron/renderer/src/components/layout/AppStatusbar.vue` (89 行)
- ChatInput.vue: `src-electron/renderer/src/components/chat/ChatInput.vue` (324 行)
- chatStore context fields: `src-electron/renderer/src/stores/chat.ts` 行 ~46-48
- useChat context handler: `src-electron/renderer/src/composables/useChat.ts` 行 ~172-178
- ModelInfo.thinkingLevelMap: `src-electron/shared/src/provider.ts` 行 ~38

### 已知风险
1. **context.update 后端未实现** → 已在 Task 5 中解决：event-adapter 的 agent_end case 在返回 message.complete 后，额外计算 contextUsagePercent 并发送 context.update 消息。
2. **contextOutputTokens 数据源** → message.complete 的 usage payload 已包含 outputTokens（event-adapter.ts 行 190）。useChat.ts 的 onComplete 需要提取此数据存入 chatStore。Task 9 (InputToolbar) 从 chatStore.tokenUsage 显示总 token 数（↑total），不再试图分离 input/output（因为 contextInputTokens 来自 context.update，outputTokens 来自 message.complete，两者数据源不同、时序不同，合并显示会造成混乱）。
3. **plugin:statusBarUpdate 是整体替换** → 已在 Task 6 解决：plugin-service 改为 Map 管理，每次广播完整 items 列表。

### 现有 Plugin 示例参考
- Todo plugin manifest: `resources/plugins/todo/package.json`
- Todo plugin 实现: `resources/plugins/todo/index.ts`（使用 hooks.onPiEvent、sessionData 权限）
- Goal plugin: `resources/plugins/goal/`（同结构）
