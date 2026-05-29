---
verdict: pass
complexity: L1
---

# Plugin System 剩余工作 + CI Windows 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Plugin System P0 集成缺口（PluginsPane 接入 + Worker tool execute handler）并修复 CI Windows 构建失败。

**Architecture:** 4 个独立修复点，无跨系统新概念。FR-1 是前端接线（1 export + 1 import + 1 tab + 2 翻译），FR-2 是 RPC 协议补全（类型 + Worker handler + handler Map），FR-3 是 CI 兼容性修复（shell 脚本 + 测试路径标准化）。

**Tech Stack:** TypeScript, Vue 3, Node.js Worker Threads, Bash, Vitest

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/renderer/src/components/settings/index.ts` | modify | FG1 | 导出 PluginsPane |
| `src-electron/renderer/src/components/layout/SettingsView.vue` | modify | FG1 | import PluginsPane + 添加 plugins tab |
| `src-electron/renderer/src/i18n/locales/zh-CN.ts` | modify | FG1 | 添加 tabPlugins 翻译 |
| `src-electron/renderer/src/i18n/locales/en-US.ts` | modify | FG1 | 添加 tabPlugins 翻译 |
| `src-electron/runtime/src/services/plugin-service/plugin-types.ts` | modify | BG1 | 新增 ToolExecuteHandler 类型、HostToWorkerMessage.rpc 增加 request 字段 |
| `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts` | modify | BG1 | 新增 toolHandlers Map + msg.request 处理 + 导出 handleMessage |
| `src-electron/runtime/src/services/plugin-service/tool-api.ts` | modify | BG1 | Worker 侧 register 存储本地 handler |
| `src-electron/runtime/test/plugin-bootstrap-tool-execute.test.ts` | create | BG1 | Worker 端 tool execute RPC handler 单元测试 |
| `scripts/prepare-pi-resources.sh` | modify | BG2 | Windows zip 解压路径修复 |
| `src-electron/runtime/test/extension-service.test.ts` | modify | BG2 | 路径匹配 Windows 兼容 |

---

## Interface Contracts

### Module: plugin-service (Worker 侧)

#### Function: handleMessage (plugin-bootstrap.ts)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| handleMessage | (msg: HostToWorkerMessage) => Promise\<void\> | void | msg.request 未找到 handler → 发送 error response | AC-2 |
| registerToolHandler | (toolKey: string, handler: ToolExecuteHandler) => void | void | 重复注册覆盖 | AC-2 |

#### Type: ToolExecuteHandler

| Field | Type | Description |
|-------|------|-------------|
| params.arguments | Record\<string, unknown\> | 工具调用参数 |
| params.sessionId | string \| undefined | 会话 ID |
| params.toolCallId | string \| undefined | 工具调用 ID |
| return | Promise\<BridgeToolExecuteResponse\> | 执行结果 |

#### Type: HostToWorkerMessage (变更)

| Variant | 新增字段 | 类型 | 说明 |
|---------|---------|------|------|
| { type: 'rpc' } | request | RpcRequest \| undefined | 主线程发来的 RPC 请求（tool execute） |

### Module: tool-api (Worker 侧)

#### Function: createToolApi (变更)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| register | (registration: ToolRegistration) => Promise\<string\> | toolKey string | registration.execute 存入本地 Map，schema 通过 RPC 发主线程 | AC-2 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1 | PluginsPane (component) | SettingsView tabs → activeTab v-show | Task 1 |
| AC-2 | handleMessage (msg.request) | rpcServer.invoke → Worker msg.request → toolHandlers.get → parentPort response | Task 2 |
| AC-3 | prepare-pi-resources.sh (Windows path) | unzip → pi.exe rename → BINARY_NAME | Task 3 |
| AC-4 | extension-service.test.ts (path normalize) | readFile mock → p.replace → includes/endsWith | Task 4 |
| AC-5 | 所有 Task | lint + typecheck + test 不回归 | Task 5 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 PluginsPane 接入 SettingsView | adopted | Task 1 |
| AC-2 Worker 端 tool execute handler | adopted | Task 2 |
| AC-3 CI Windows pi 解压 | adopted | Task 3 |
| AC-4 CI Windows extension-service 测试 | adopted | Task 4 |
| AC-5 macOS/Linux CI 不受影响 | adopted | Task 5 |

---

## Task List

### Task 1: PluginsPane 接入 SettingsView

**Type:** frontend

**Files:**
- Modify: `src-electron/renderer/src/components/settings/index.ts`
- Modify: `src-electron/renderer/src/components/layout/SettingsView.vue`
- Modify: `src-electron/renderer/src/i18n/locales/zh-CN.ts`
- Modify: `src-electron/renderer/src/i18n/locales/en-US.ts`

- [ ] **Step 1: 导出 PluginsPane**

在 `src-electron/renderer/src/components/settings/index.ts` 末尾添加：
```typescript
export { default as PluginsPane } from './PluginsPane.vue'
```

- [ ] **Step 2: 在 SettingsView 中添加 plugins tab**

在 `SettingsView.vue` 中：
1. import 中添加 `PluginsPane`：
   ```typescript
   import { ProviderPane, SkillsPane, AgentsPane, ExtensionsPane, SystemPane, PluginsPane } from '../settings'
   ```
2. 在 `tabs` 数组的 `extensions` 条目之前添加：
   ```typescript
   { key: 'plugins', labelKey: 'settings.tabPlugins', icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 00-1 1v3m0 4v3a1 1 0 001 1h3m4-12h3a1 1 0 011 1v3m0 4v3a1 1 0 01-1 1h-3"/><path d="M6 6h4v4H6z"/></svg>' },
   ```
3. 在 template 的 Content div 中，extensions v-show 之前添加：
   ```html
   <div v-show="activeTab === 'plugins'">
     <PluginsPane />
   </div>
   ```

- [ ] **Step 3: 添加 i18n 翻译**

在 `zh-CN.ts` 的 settings 对象中 `tabExtensions` 行之前添加：
```typescript
tabPlugins: '插件',
```

在 `en-US.ts` 的 settings 对象中 `tabExtensions` 行之前添加：
```typescript
tabPlugins: 'Plugins',
```

- [ ] **Step 4: 验证**

Run: `cd src-electron && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

Run: `npm run lint 2>&1 | tail -5`
Expected: 无 lint 错误

- [ ] **Step 5: Commit**

```bash
git add src-electron/renderer/src/components/settings/index.ts src-electron/renderer/src/components/layout/SettingsView.vue src-electron/renderer/src/i18n/locales/zh-CN.ts src-electron/renderer/src/i18n/locales/en-US.ts
git commit -m "feat: wire PluginsPane into SettingsView tabs"
```

---

### Task 2: Worker 端 tool execute RPC handler

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-types.ts`
- Modify: `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts`
- Modify: `src-electron/runtime/src/services/plugin-service/tool-api.ts`
- Create: `src-electron/runtime/test/plugin-bootstrap-tool-execute.test.ts`

- [ ] **Step 1: 类型变更（plugin-types.ts）**

1. 在 `BridgeToolExecuteResponse` 之后添加 ToolExecuteHandler 类型：
```typescript
/** Worker 侧 tool 执行处理函数 */
export type ToolExecuteHandler = (params: {
  arguments: Record<string, unknown>
  sessionId?: string
  toolCallId?: string
}) => Promise<BridgeToolExecuteResponse>
```

2. 在 `ToolRegistration` 接口中添加 `execute` 字段：
```typescript
export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: ToolExecuteHandler
}
```

3. 修改 `HostToWorkerMessage` 的 `rpc` 变体，增加 `request` 字段：
```typescript
| { type: 'rpc'; response?: RpcResponse; notification?: RpcNotification; request?: RpcRequest }
```

- [ ] **Step 2: Worker 侧 handler Map + msg.request 处理（plugin-bootstrap.ts）**

1. 新增导入和模块级 Map：
```typescript
import type { ToolExecuteHandler, RpcRequest, RpcResponse } from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'

/** Worker 本地 tool handler 注册表，key 格式: `${pluginId}:${toolName}` */
const toolHandlers = new Map<string, ToolExecuteHandler>()

/** 注册 tool handler（由 tool-api.ts 的 register 调用） */
export function registerToolHandler(toolKey: string, handler: ToolExecuteHandler): void {
  toolHandlers.set(toolKey, handler)
}
```

2. 在 `handleMessage` 的 `msg.type === 'rpc'` case 中，在现有 `msg.response` 和 `msg.notification` 处理之后，添加 `msg.request` 处理：
```typescript
case 'rpc': {
  if (msg.response) {
    rpcClient.handleResponse(msg.response)
  }
  if (msg.notification) {
    rpcClient.handleNotification(msg.notification)
  }
  // 处理主线程发来的 RPC 请求（如 plugin.tool.execute）
  if (msg.request) {
    handleIncomingRequest(msg.request)
  }
  break
}
```

3. 新增 `handleIncomingRequest` 函数：
```typescript
async function handleIncomingRequest(request: RpcRequest): Promise<void> {
  if (request.method === 'plugin.tool.execute') {
    const { pluginId, toolName, arguments: args, sessionId, toolCallId } = request.params as Record<string, unknown>
    const toolKey = `${pluginId}:${toolName}`
    const handler = toolHandlers.get(toolKey)
    if (!handler) {
      postRpcResponse(request.id, undefined, {
        code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
        message: `Tool handler not found: ${toolKey}`,
      })
      return
    }
    try {
      const result = await handler({
        arguments: args as Record<string, unknown>,
        sessionId: sessionId as string | undefined,
        toolCallId: toolCallId as string | undefined,
      })
      postRpcResponse(request.id, result, undefined)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      postRpcResponse(request.id, undefined, {
        code: PluginRpcErrorCodes.INTERNAL_ERROR,
        message: `Tool execution error: ${msg}`,
      })
    }
  } else {
    postRpcResponse(request.id, undefined, {
      code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
      message: `Unknown method: ${request.method}`,
    })
  }
}

function postRpcResponse(
  id: number | string | null,
  result: unknown,
  error: { code: number; message: string } | undefined,
): void {
  if (id === null) return
  const response: RpcResponse = { jsonrpc: '2.0', id: id as number }
  if (error) {
    response.error = error
  } else {
    response.result = result
  }
  parentPort!.postMessage({ type: 'rpc', response })
}
```

- [ ] **Step 3: tool-api.ts Worker 侧 register 存储 handler**

修改 `createToolApi` 中的 `register` 函数，在发送 RPC 到主线程之前，先将 execute handler 存到本地 Map：

```typescript
import { registerToolHandler } from './plugin-bootstrap.js'

// 在 createToolApi 内部：
register: (registration: ToolRegistration): Promise<string> => {
  // 本地存储 execute handler
  const toolKey = `${pluginId}:${registration.name}`
  registerToolHandler(toolKey, registration.execute)
  // 通过 RPC 将 schema（不含 execute）发送到主线程
  return rpcClient.request('plugin.tools.register', {
    pluginId,
    name: registration.name,
    description: registration.description,
    parameters: registration.parameters,
  }) as Promise<string>
},
```

- [ ] **Step 4: 写单元测试**

创建 `src-electron/runtime/test/plugin-bootstrap-tool-execute.test.ts`：
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecuteHandler, RpcRequest } from '../src/services/plugin-service/plugin-types.js'
import { PluginRpcErrorCodes } from '../src/services/plugin-service/plugin-types.js'

// Mock parentPort
const mockPostMessage = vi.fn()
vi.mock('node:worker_threads', () => ({
  parentPort: {
    on: vi.fn(),
    postMessage: mockPostMessage,
  },
}))

// Mock dynamic imports（plugin-bootstrap 顶层 import 会触发 worker_threads）
vi.mock('../src/services/plugin-service/plugin-rpc-client.js', () => ({
  PluginRpcClient: vi.fn().mockImplementation(() => ({
    attach: vi.fn(),
    request: vi.fn(),
    onNotification: vi.fn(),
    handleResponse: vi.fn(),
    handleNotification: vi.fn(),
    notify: vi.fn(),
  })),
}))

describe('plugin-bootstrap tool execute RPC handler', () => {
  // 需要在 mock 设置后 import
  let handleMessage: (msg: unknown) => Promise<void>
  let registerToolHandler: (key: string, handler: ToolExecuteHandler) => void

  beforeEach(async () => {
    vi.clearAllMocks()
    // 动态 import 获取模块函数
    const mod = await import('../src/services/plugin-service/plugin-bootstrap.js')
    handleMessage = mod.handleMessage
    registerToolHandler = mod.registerToolHandler
  })

  it('executes registered tool handler and returns result', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockResolvedValue({
      content: 'tool result',
    })
    registerToolHandler('test-plugin:my-tool', handler)

    const request: RpcRequest = {
      jsonrpc: '2.0',
      id: 42,
      method: 'plugin.tool.execute',
      params: {
        pluginId: 'test-plugin',
        toolName: 'my-tool',
        arguments: { input: 'hello' },
        sessionId: 'sess-1',
        toolCallId: 'tc-1',
      },
    }

    await handleMessage({ type: 'rpc', request })

    expect(handler).toHaveBeenCalledWith({
      arguments: { input: 'hello' },
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
    })
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: { jsonrpc: '2.0', id: 42, result: { content: 'tool result' } },
    })
  })

  it('returns error when tool handler not found', async () => {
    const request: RpcRequest = {
      jsonrpc: '2.0',
      id: 43,
      method: 'plugin.tool.execute',
      params: {
        pluginId: 'unknown-plugin',
        toolName: 'missing-tool',
        arguments: {},
      },
    }

    await handleMessage({ type: 'rpc', request })

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 43,
        error: {
          code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
          message: 'Tool handler not found: unknown-plugin:missing-tool',
        },
      },
    })
  })

  it('returns error when handler throws', async () => {
    const handler: ToolExecuteHandler = vi.fn().mockRejectedValue(new Error('boom'))
    registerToolHandler('err-plugin:fail-tool', handler)

    const request: RpcRequest = {
      jsonrpc: '2.0',
      id: 44,
      method: 'plugin.tool.execute',
      params: {
        pluginId: 'err-plugin',
        toolName: 'fail-tool',
        arguments: {},
      },
    }

    await handleMessage({ type: 'rpc', request })

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 44,
        error: {
          code: PluginRpcErrorCodes.INTERNAL_ERROR,
          message: 'Tool execution error: boom',
        },
      },
    })
  })

  it('returns error for unknown RPC method', async () => {
    const request: RpcRequest = {
      jsonrpc: '2.0',
      id: 45,
      method: 'unknown.method',
      params: {},
    }

    await handleMessage({ type: 'rpc', request })

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'rpc',
      response: {
        jsonrpc: '2.0',
        id: 45,
        error: {
          code: PluginRpcErrorCodes.METHOD_NOT_FOUND,
          message: 'Unknown method: unknown.method',
        },
      },
    })
  })
})
```

- [ ] **Step 5: 运行测试验证**

Run: `cd src-electron && npx vitest run test/plugin-bootstrap-tool-execute.test.ts`
Expected: 4 tests PASS

- [ ] **Step 6: 类型检查**

Run: `cd src-electron && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 7: Commit**

```bash
git add src-electron/runtime/src/services/plugin-service/plugin-types.ts src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts src-electron/runtime/src/services/plugin-service/tool-api.ts src-electron/runtime/test/plugin-bootstrap-tool-execute.test.ts
git commit -m "feat: add Worker-side tool execute RPC handler for plugin system"
```

---

### Task 3: CI Windows — pi 解压脚本修复

**Type:** backend

**Files:**
- Modify: `scripts/prepare-pi-resources.sh`

- [ ] **Step 1: 修复 Windows zip 解压逻辑**

在 `prepare-pi-resources.sh` 的 `else`（unzip）分支中，修改解压后处理逻辑。

当前逻辑（仅处理 `pi/` 子目录的情况）：
```bash
else
  unzip -o "$ASSET"
  if [[ -d "pi" ]]; then
    cp -R pi/assets pi/export-html pi/package.json pi/photon_rs_bg.wasm pi/theme . 2>/dev/null || true
    cp pi/pi "${BINARY_NAME}" 2>/dev/null || cp pi/pi.exe "${BINARY_NAME}" 2>/dev/null || true
    rm -rf pi
  fi
fi
```

修改为：
```bash
else
  unzip -o "$ASSET"
  if [[ -d "pi" ]]; then
    # tar.gz 风格：外层有 pi/ 目录
    cp -R pi/assets pi/export-html pi/package.json pi/photon_rs_bg.wasm pi/theme . 2>/dev/null || true
    cp pi/pi "${BINARY_NAME}" 2>/dev/null || cp pi/pi.exe "${BINARY_NAME}" 2>/dev/null || true
    rm -rf pi
  elif [[ -f "pi.exe" ]]; then
    # Windows zip 风格：文件直接在根层级，无 pi/ 子目录
    mv pi.exe "${BINARY_NAME}"
    # assets/、theme/、package.json 等已在根目录，无需移动
  fi
fi
```

- [ ] **Step 2: 本地验证（macOS 路径不变）**

Run: `bash scripts/prepare-pi-resources.sh`
Expected: macOS 正常工作（走 tar.gz 分支，不受 Windows 逻辑影响）

- [ ] **Step 3: Commit**

```bash
git add scripts/prepare-pi-resources.sh
git commit -m "fix: handle Windows zip flat structure in prepare-pi-resources"
```

---

### Task 4: CI Windows — extension-service 测试路径修复

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/test/extension-service.test.ts`

- [ ] **Step 1: 路径标准化**

将所有 `mockFs.readFile` 实现中的 `p.includes('xxx/package.json')` 替换为路径标准化后匹配。

提取一个 helper 函数到文件顶部（`makePackageJson` 之后）：
```typescript
/** 标准化路径分隔符为 /，用于跨平台路径匹配 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}
```

然后在所有 `mockFs.readFile.mockImplementation` 回调中，将 `p.includes(...)` 改为 `normalizePath(p).includes(...)`。

需要修改的 `p.includes(...)` 调用（约 20 处）：
- `p.includes('ext-a/package.json')` → `normalizePath(p).includes('ext-a/package.json')`
- `p.includes('ext-b/package.json')` → `normalizePath(p).includes('ext-b/package.json')`
- `p.includes('ext-c/package.json')` → `normalizePath(p).includes('ext-c/package.json')`
- `p.includes('my-ext/package.json')` → `normalizePath(p).includes('my-ext/package.json')`
- `p.includes('bad-ext/package.json')` → `normalizePath(p).includes('bad-ext/package.json')`
- `p.includes('no-name/package.json')` → `normalizePath(p).includes('no-name/package.json')`
- `p.includes('minimal/package.json')` → `normalizePath(p).includes('minimal/package.json')`
- `p.includes('extension-state.json')` → `normalizePath(p).includes('extension-state.json')`

在 `mockFs.readFile.mockImplementation` 回调的第一行加一行：
```typescript
const p = normalizePath(path.toString())
```

- [ ] **Step 2: 运行测试验证**

Run: `cd src-electron && npx vitest run test/extension-service.test.ts`
Expected: 20 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src-electron/runtime/test/extension-service.test.ts
git commit -m "fix: normalize path separators in extension-service tests for Windows"
```

---

### Task 5: 全量回归验证

**Type:** backend

**Files:** 无新增/修改

- [ ] **Step 1: 运行全量 lint**

Run: `npm run lint`
Expected: 0 errors

- [ ] **Step 2: 运行全量测试**

Run: `cd src-electron && npx vitest run`
Expected: 所有测试通过（包括新增的 plugin-bootstrap-tool-execute 和修复的 extension-service）

- [ ] **Step 3: 运行类型检查**

Run: `cd src-electron && npx vue-tsc --noEmit`
Expected: 0 errors

---

## Execution Groups

#### FG1: PluginsPane 接入 SettingsView

**Description:** 前端接线——将已有的 PluginsPane 组件接入 SettingsView 的 tab 系统。4 个文件改动，每个不超过 3 行。

**Tasks:** Task 1

**Files (预估):** 4 个文件（0 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: low |
| 注入上下文 | Task 1 描述 + 前端规范（禁止原生 HTML、Tailwind、i18n） |
| 读取文件 | SettingsView.vue, settings/index.ts, zh-CN.ts, en-US.ts |
| 修改文件 | 同上 |

**Execution Flow (FG1):**
1. general-purpose → 执行 Task 1 所有 step

**Dependencies:** 无

**设计细节:** PluginsPane 组件已完整实现（355 行），本次只需 export + import + tab 注册 + 翻译。

---

#### BG1: Worker 端 tool execute RPC handler

**Description:** 补全 Worker 侧的 RPC request 处理链路——类型定义、handler Map、msg.request 分发、单元测试。涉及 plugin-types.ts / plugin-bootstrap.ts / tool-api.ts 三个核心文件。

**Tasks:** Task 2

**Files (预估):** 4 个文件（1 create + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 2 描述 + RPC 协议说明 + plugin-types.ts 类型上下文 |
| 读取文件 | plugin-types.ts, plugin-bootstrap.ts, tool-api.ts, plugin-rpc-client.ts |
| 修改文件 | 同上 + 新建 test 文件 |

**Execution Flow (BG1):**
1. general-purpose → 按 TDD 顺序执行 Task 2

**Dependencies:** 无（与 FG1 独立）

---

#### BG2: CI Windows 兼容性修复

**Description:** 两个独立的 Windows 兼容性修复——pi 解压脚本 + 测试路径标准化。无交叉依赖。

**Tasks:** Task 3, Task 4

**Files (预估):** 2 个文件（0 create + 2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: low |
| 注入上下文 | Task 3-4 描述 + Windows zip 结构说明 |
| 读取文件 | prepare-pi-resources.sh, extension-service.test.ts |
| 修改文件 | 同上 |

**Execution Flow (BG2):**
1. general-purpose → Task 3（shell 脚本修复）
2. general-purpose → Task 4（测试路径修复）

**Dependencies:** 无（与 FG1、BG1 独立）

---

## Dependency Graph & Wave Schedule

```
FG1 (前端接线) ──┐
BG1 (RPC handler) ──┤──→ Task 5 (回归验证)
BG2 (CI 修复) ────────┘
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | FG1, BG1, BG2 | 三个 Group 完全独立，可并行执行 |
| Wave 2 | Task 5 | 依赖 Wave 1 全部完成，全量回归验证 |
