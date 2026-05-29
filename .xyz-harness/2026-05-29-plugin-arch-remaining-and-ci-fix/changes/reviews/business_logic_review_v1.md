---
verdict: pass
must_fix: 0
reviewer: business-logic-reviewer
date: 2026-05-29
---

# 业务逻辑审查报告

## 审查范围

9 个变更文件，覆盖前端 PluginsPane 接入、Worker 侧 tool execute RPC handler、Windows CI zip 处理、ExtensionService 路径标准化测试。

---

## 1. PluginsPane 前端接入

### 文件列表
| 文件 | 变更类型 |
|------|----------|
| `src-electron/renderer/src/components/settings/index.ts` | 导出新增 |
| `src-electron/renderer/src/components/layout/SettingsView.vue` | tab 添加 |
| `src-electron/renderer/src/i18n/locales/zh-CN.ts` | 翻译项 |
| `src-electron/renderer/src/i18n/locales/en-US.ts` | 翻译项 |

### 验证结果 ✅

- `index.ts`: `PluginsPane` 导出声明存在，实际组件文件 `PluginsPane.vue` 存在于 `settings/` 目录下（13859 bytes） ✓
- `SettingsView.vue`: tabs 数组包含 `{ key: 'plugins', labelKey: 'settings.tabPlugins', icon: ... }`，内容区有 `<PluginsPane />` 按 v-show 切换 ✓
- 翻译键 `settings.tabPlugins` 在 zh-CN 和 en-US 中均定义 ✓
- tab 排序在 system 之后、extensions 之前，符合功能分层逻辑 ✓

**结论**: 接入路径完整，无遗漏。

---

## 2. Worker 侧 Tool Execute RPC Handler

### 2.1 类型层面

| 变更 | 位置 | 分析 |
|------|------|------|
| `ToolExecuteHandler` 类型新增 | `plugin-types.ts` | 签名 `(params: { arguments, sessionId?, toolCallId? }) => Promise<BridgeToolExecuteResponse>`。与 `BridgeToolExecuteRequest` 的 fields 一致 ✓ |
| `HostToWorkerMessage.rpc.request` 字段 | `plugin-types.ts` | 类型为 `RpcRequest?`，与已有的 `response?`/`notification?` 并列。这是 Host→Worker 方向的新 RPC 通道，之前只支持 Worker→Host 方向 ✓ |
| `ToolRegistration.execute?` 可选字段 | `plugin-types.ts` | 允许插件在 register 时附带本地 handler。Worker 侧保存，Host 侧不关心 ✓ |

### 2.2 Worker 侧执行路径

完整链路追踪（主线程调用插件 tool → Worker handler → response）：

```
[主线程 PluginHost]
  ↓ 发送 HostToWorkerMessage { type: 'rpc', request: { id, method: 'plugin.tool.execute', params: { pluginId, toolName, arguments, sessionId, toolCallId } } }

[Worker Thread plugin-bootstrap.ts]
  parentPort.on('message', msg)
    → handleMessage(msg)
      → switch(msg.type) case 'rpc':
        → msg.request 非空 → handleIncomingRequest(msg.request)
          → request.method === 'plugin.tool.execute'
            → toolKey = `${pluginId}:${toolName}`
            → toolHandlers.get(toolKey) 查找本地 handler
            → 找到: handler({ arguments, sessionId, toolCallId }) → postRpcResponse(id, result, undefined)
            → 未找到: postRpcResponse(id, undefined, { code: METHOD_NOT_FOUND, message: 'Tool handler not found: ...' })
            → handler 抛出: postRpcResponse(id, undefined, { code: INTERNAL_ERROR, message: 'Tool execution error: ...' })
          → request.method 未知:
            → postRpcResponse(id, undefined, { code: METHOD_NOT_FOUND, message: 'Unknown method: ...' })

[Worker Thread parentPort.postMessage]
  ↓ { type: 'rpc', response: { jsonrpc: '2.0', id, result | error } }

[主线程 PluginHost]
  → 收到 response，路由到调用方
```

### 2.3 Handler 注册链路

```
[插件 activate() 中调用 api.tools.register({ name, execute, ... })]
  → createToolApi().register(registration)
    → 如果 registration.execute 存在:
      → 动态 import('./plugin-bootstrap.js').registerToolHandler(toolKey, execute)
        → toolHandlers.set(toolKey, handler)  ← Worker 本地保存
    → 通过 RPC 转发到主线程 toolRegistry 注册
```

### 2.4 验证结果 ✅

- handleMessage 已从 `parentPort.on('message')` inline handler 提取为独立的 `export async function handleMessage`，可测试性提升 ✓
- `msg.request` 的处理在 `case 'rpc'` 分支中与 `msg.response`/`msg.notification` 平行，互斥关系通过三个独立的 `if` 判断维护 ✓
- `handleIncomingRequest` 只识别 `plugin.tool.execute` 一个 method，其余返回 `METHOD_NOT_FOUND`——设计保守，便于后续扩展 ✓
- `postRpcResponse` 对 `id === null` 做静默忽略（符合 JSON-RPC notification 语义）✓
- Worker 侧 handler 注册使用 **动态 import**（`await import('./plugin-bootstrap.js')`），避免了静态循环依赖（`plugin-bootstrap.ts` 静态 import `createToolApi`，`tool-api.ts` 动态 import `registerToolHandler`）✓

### 2.5 问题

**1. `postRpcResponse` 的 id 类型不安全**（严重程度：低）

```typescript
function postRpcResponse(
  id: number | string | null,
  ...
): void {
  if (id === null) return
  // 这里直接 cast as number，丢失了 string 类型的可能性
  parentPort!.postMessage({
    type: 'rpc',
    response: { jsonrpc: '2.0', id: id as number, ... },
  })
}
```

JSON-RPC 2.0 的 `id` 允许 `string | number | null`。实际中 `PluginRpcClient` 生成自增数字 ID（`nextId++`），所以当前永远是 `number`。但类型定义允许 `string`，cast 丢弃了类型信息。**不影响运行期，建议加注释说明**。

**2. `rpc` 分支未验证三个字段的互斥性**（严重程度：低）

```typescript
case 'rpc': {
  if (msg.response)  rpcClient.handleResponse(msg.response)
  if (msg.notification) rpcClient.handleNotification(msg.notification)
  if (msg.request) handleIncomingRequest(msg.request)
}
```

如果发送方误将 `response` 和 `request` 同时设置，三者都会被处理。当前无校验逻辑。实际使用中 `PluginHost` 保证互斥，因此 **不影响运行期**。

---

## 3. 单元测试分析

### 3.1 `plugin-bootstrap-tool-execute.test.ts`

**策略**: 由于 `plugin-bootstrap.ts` 顶层有 `if (parentPort)` 副作用导致 Vitest 下 import 后 exports 丢失，测试复制了核心逻辑。

**覆盖路径**:

| 用例 | 输入 | 预期输出 | 覆盖 |
|------|------|----------|------|
| 正常执行 | handler 返回 `{ content: 'ok' }` | `id: 42, result: { content: 'ok' }` | ✅ |
| handler 不存在 | 未注册的 toolKey | `error.code: METHOD_NOT_FOUND` | ✅ |
| handler 抛出 | reject `new Error('boom')` | `error.code: INTERNAL_ERROR, message: 'Tool execution error: boom'` | ✅ |
| 未知 method | method: `unknown.method` | `error.code: METHOD_NOT_FOUND` | ✅ |

**问题**: 测试代码与生产代码重复，注释已注明需手动同步。长期看易出现 drift，建议在 `plugin-bootstrap.ts` 中增加 `/* v8 ignore start/stop` 或重构将核心逻辑抽取到无副作用的纯函数模块。

### 3.2 `extension-service.test.ts`

**路径标准化**: 使用 `normalizePath(p).includes(...)` 处理 Windows `\` 分隔符。实现正确——`join(TEST_DIR, 'ext-a')` 在 Windows 会产生 `\`，`normalizePath` 统一转 `/` 后匹配。**这是跨平台测试的标准做法** ✅

**覆盖**: scan/toggle/getEnabled/getExtensionPaths 四个方法均覆盖，包含 ENOENT、空目录、JSON 解析失败、字段缺失等边缘情况 ✅

---

## 4. Windows CI 修复分析

### 4.1 `prepare-pi-resources.sh`

**变更动机**: Windows zip 压缩包是 flat structure（`pi.exe` + assets 在根目录，无 `pi/` 前缀目录），而 macOS/Linux tar.gz 有 `pi/` 前缀目录。

**提取逻辑**:

```
if [[ "$ASSET" == *.tar.gz ]]; then
  # macOS/Linux: tar xzf, 展平 pi/ 目录
else
  # Windows: unzip
  if [[ -d "pi" ]]; then
    # 有 pi/ 目录（如果上传方改了结构）
  elif [[ -f "pi.exe" ]]; then
    # flat structure: 直接重命名 pi.exe → pi-windows-x64.exe
  fi
fi
```

**验证**:
- Windows zip 解压后若为 flat structure → `[[ -d "pi" ]]` 为 false → 进入 `elif [[ -f "pi.exe" ]]` → `mv pi.exe pi-windows-x64.exe` ✓
- 其他 assets（`assets/`, `export-html/`, `package.json`, `photon_rs_bg.wasm`, `theme/`）在 flat structure 中已在当前目录，无需 cp ✓
- macOS/Linux tar.gz 分支则不同：因有 `pi/` 前缀，需要 `cp -R pi/* .` + `rm -rf pi` 展平 ✓

**结论**: 逻辑正确，Windows flat structure 处理完备。

---

## 5. 总体评估

| 维度 | 评估 | 说明 |
|------|------|------|
| 业务完整性 | ✅ | PluginsPane 接入完整，RPC handler 链路无断点，CI 修复合理 |
| 类型安全 | ✅ | 仅 cast 问题（低严重度，不影响运行期） |
| 边际情况 | ✅ | tool handler 不存在、handler 抛出、未知 method 均有明确处理 |
| 测试覆盖 | ✅ | 核心路径覆盖，边缘情况（ENOENT、非法 JSON）覆盖 |
| 一致性 | ✅ | 与现有 `rpc` 分支的 `response`/`notification` 处理模式一致 |
| 维护性 | ⚠️ | 测试代码复制生产逻辑，需人工同步；建议后续将无副作用逻辑抽取为独立模块 |

**must_fix: 0** — 无需强制修复项。

### 建议（非必须）

1. `postRpcResponse` 的 `id as number` 改为 `id as number | string`，或在注释中说明当前始终为 number
2. 考虑将 `handleIncomingRequest` + `toolHandlers` + `postRpcResponse` 抽取为独立 module（如 `plugin-tool-executor.ts`），消除测试文件中的代码复制
