---
verdict: pass
---

# Plugin System 剩余工作 + CI Windows 修复

## Background

前一个 PR (#57, feat-plugin-arch-4) 完成了 Plugin System 的 Phase 1-3 主体工作（完成率 93%）。
当前分支 `feat-plugin-arch-5` 需要完成剩余的 P0/P1 集成缺口，并修复 CI Windows 构建失败。

### 已完成的工作（无需重复）

- PluginService 核心模块（Registry、Host、RPC、Activator、Storage）
- Full agentAPI 10 模块
- Permission 系统
- Goal/Todo 内置插件
- Plugin Pinia Store + WS 消息
- PluginsPane 组件（列表/Toggle/详情/权限/配置）
- StatusBar 集成 + MessageDecoration + SlashMenu 集成
- Bridge 重连测试 18 cases
- Goal/Todo 独立测试 46 cases

## Functional Requirements

### FR-1: PluginsPane 接入 SettingsView

SettingsView.vue 的 tabs 数组中缺少 plugins 条目，settings/index.ts 未 export PluginsPane。
所有前端 PluginsPane 代码已写好，但用户无法导航到插件管理页。

**改动范围：**
- `src-electron/renderer/src/components/settings/index.ts` — export PluginsPane
- `src-electron/renderer/src/components/layout/SettingsView.vue` — import + 添加 plugins tab + v-show
- `src-electron/renderer/src/i18n/locales/zh-CN.ts` — 添加 settings.tabPlugins 翻译
- `src-electron/renderer/src/i18n/locales/en-US.ts` — 添加 settings.tabPlugins 翻译

### FR-2: Worker 端 tool execute RPC handler

主线程 `rpcServer.invoke(handle.workerId, 'plugin.tool.execute', ...)` 发送 RPC 请求到 Worker，
但 Worker 端 `plugin-bootstrap.ts` 的 `msg.type === 'rpc'` 分支只处理 `response` 和 `notification`，
不处理主线程发来的 `request`，导致 LLM 调用插件工具时 Worker 无响应。

**设计细节：**

1. **ToolRegistration 新增 execute handler**：
   ```typescript
   // plugin-types.ts
   export type ToolExecuteHandler = (params: {
     arguments: Record<string, unknown>
     sessionId?: string
     toolCallId?: string
   }) => Promise<BridgeToolExecuteResponse>

   export interface ToolRegistration {
     name: string
     description: string
     parameters: Record<string, unknown>
     execute: ToolExecuteHandler
   }
   ```

2. **Worker 侧本地 handler Map**：
   - `plugin-bootstrap.ts` 新增 `const toolHandlers = new Map<string, ToolExecuteHandler>()`
   - key 格式：`${pluginId}:${toolName}`（与主线程 toolRegistry key 一致）

3. **tool-api.ts Worker 侧 register 流程**：
   - `createToolApi().register(registration)` → 本地存储 `registration.execute` 到 `toolHandlers` Map
   - 同时通过 RPC 将 schema（不含 execute）发送到主线程 toolRegistry
   - 注意：execute 函数不可序列化，仅留在 Worker 进程内

4. **plugin-bootstrap.ts 处理 msg.request**：
   - 在 `msg.type === 'rpc'` case 中增加 `msg.request` 处理
   - 根据 `msg.request.method === 'plugin.tool.execute'` 查找 `toolHandlers` Map
   - 找到 → 执行 handler → 通过 `parentPort` 发送 `{ type: 'rpc', response: { jsonrpc: '2.0', id, result } }`
   - 未找到 → 发送 error response `{ jsonrpc: '2.0', id, error: { code, message } }`

5. **HostToWorkerMessage 类型变更**：
   - `plugin-types.ts` 中 `HostToWorkerMessage` 的 `rpc` 变体增加 `request?: RpcRequest` 字段
   - 对应 `plugin-host.ts` 中 `rpcServer.invoke()` 已经发送的 `{ type: 'rpc', request: { ... } }` 格式

**改动范围：**
- `src-electron/runtime/src/services/plugin-service/plugin-types.ts` — 新增 `ToolExecuteHandler` 类型；`ToolRegistration` 增加 `execute` 字段；`HostToWorkerMessage.rpc` 增加 `request` 字段
- `src-electron/runtime/src/services/plugin-service/plugin-bootstrap.ts` — 新增 `toolHandlers` Map；`rpc` case 中处理 `msg.request`；分发到 tool handler
- `src-electron/runtime/src/services/plugin-service/tool-api.ts` — Worker 侧 `register` 同时存储 handler 到本地 Map（通过回调或直接 import Map）

**已知限制（Phase 4 处理）：**
- 多个插件注册同名 tool 时，`handleBridgeToolExecute` 返回第一个匹配，不保证顺序
- 内置插件 Goal/Todo 当前不使用 `api.tools.register()`（它们是 pi extension，不经过 xyz-agent plugin 系统），不受此改动影响

**测试策略：**
- 在 `plugin-bootstrap.ts` 中导出 `handleMessage` 函数，单元测试发送 `{ type: 'rpc', request: { jsonrpc: '2.0', id: 1, method: 'plugin.tool.execute', params: { ... } } }`
- 验证：注册 handler → 发 RPC request → 收到正确 response
- 验证：未注册 handler → 收到 error response

### FR-3: CI Windows 构建修复

两个问题：

1. **pi 解压脚本 Windows 不兼容** — Windows zip 没有外层 `pi/` 目录（文件直接在根层级），
   脚本 `if [[ -d "pi" ]]` 判断失败，`pi.exe` 未重命名为 `pi-windows-x64.exe`，`chmod +x` 失败。
2. **extension-service 测试 Windows 路径不兼容** — mock readFile 用 `p.includes('ext-a/package.json')`
   匹配路径，但 Windows 上路径分隔符是 `\`，导致 11/20 测试失败。

**改动范围：**
- `scripts/prepare-pi-resources.sh` — unzip 后检测 `pi.exe` 直接存在于根目录的情况（非 `pi/` 子目录），
  将 `pi.exe` 重命名为 `${BINARY_NAME}`（即 `pi-windows-x64.exe`）；
  同时将 `assets/`、`package.json`、`theme/` 等资源保留在 `RESOURCES_DIR` 根目录（已经是正确位置，无需移动）
- `src-electron/runtime/test/extension-service.test.ts` — 所有 `p.includes('xxx/package.json')` 匹配
  改为路径标准化后匹配：`p.replace(/\\/g, '/').endsWith('ext-a/package.json')`，
  或使用 `path.basename(path.dirname(p)) === 'ext-a' && path.basename(p) === 'package.json'` 精确匹配

## Acceptance Criteria

- AC-1: Settings 页面出现 Plugins tab，点击后显示 PluginsPane 内容
- AC-2: Worker 端 `plugin-bootstrap.ts` 的 `handleMessage` 能正确处理 `msg.request`（method=`plugin.tool.execute`），
  执行注册的 tool handler 并通过 `parentPort` 返回 RPC response（有单元测试覆盖）
- AC-3: CI Windows Build 的 "Download and prepare pi resources" 步骤成功
- AC-4: CI Windows Build 的 extension-service 测试全部通过
- AC-5: 现有 macOS/Linux CI 不受影响（lint + typecheck + test 全通过）

## Constraints

- 不修改 PluginHost、PluginRpcServer 核心架构
- 不实现 Phase 4 内容（npm install、脚手架、SDK）
- P1 项（sessionData flush、permission request、ui-api stubs、agent-api stubs）本期不做
- i18n 仅添加 plugins tab 的翻译 key，不重构 i18n 结构

## 业务用例

### UC-1: 用户在 Settings 管理插件
- **Actor**: 终端用户
- **场景**: 打开 Settings 页面，切换到 Plugins tab
- **预期结果**: 看到已安装插件列表，可启用/禁用/查看详情

### UC-2: LLM 调用插件工具
- **Actor**: AI Agent (通过 pi)
- **场景**: 用户消息触发 LLM 选择一个插件注册的 tool
- **预期结果**: tool 请求通过 bridge → main thread → Worker RPC → plugin execute handler → 返回结果

## Complexity Assessment

**中等** — 4 个独立修复点，每个改动范围小（< 50 行），但涉及跨层理解（shell 脚本、Windows 路径、RPC 协议、Vue 组件集成）。
