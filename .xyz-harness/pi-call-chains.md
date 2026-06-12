# xyz-agent → pi 调用链完整追踪

> 由 code-link AST tracer + 手动补齐前端 Vue composable 链路生成。
> 日期：2026-06-11

## 架构总览

```
前端 Vue 组件
  → Pinia Store / Composable (useChat / useSession / useTree / useModel ...)
    → ws-client.send({ type: 'xxx', payload })
      → WebSocket → sidecar Server (server.ts)
        → Service 层 (SessionService / TreeService / BridgeHandler)
          → RpcClient.sendCommand(type, params)
            → pi 子进程 stdin (JSONL)
```

**核心传输**：`RpcClient.sendCommand()` (`src-electron/runtime/src/rpc-client.ts:243`)
将 `{id, type, ...params}` 写入 pi stdin，等待 stdout 返回匹配 id 的响应。

---

## 一、对话消息类（4 条链路）

### 链路 1：发送消息 → `prompt`

```
[前端入口]
  useChat.ts:412  send({ type: 'message.send', payload: { sessionId, content, subagent? } })
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'message.send'
    ↓
  session-service.ts:sendMessage(sessionId, content)          [L243]
    ├── pm.getClient(sessionId) → RpcClient
    ├── client.prompt(content)                                 [rpc-client.ts:321]
    │     └── sendCommand('prompt', { message: content })      [rpc-client.ts:243 → pi stdin]
    └── broker.broadcast({ type: 'message.error', ... })       [错误路径]
```

**涉及文件** (code-link 14 文件, 37 nodes):
- `useChat.ts` → `ws-client.ts` → `server.ts` → `session-service.ts` → `process-manager.ts` → `rpc-client.ts`
- 辅助：`event-adapter.ts`, `pi-config-bridge.ts`, `git-info.ts`, `session-file-utils.ts`, `tree-service.ts`

### 链路 2：发送 subagent 消息 → `prompt`

```
[前端入口]
  useChat.ts:412  send({ type: 'message.send', payload: { sessionId, content, subagent: { agent, task } } })
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'message.send' → subagent 分支
    ↓
  session-service.ts:sendSubagentMessage(sessionId, agent, task, content)  [L258]
    └── client.prompt(`<!-- xyz-agent-force-subagent:base64 -->\n${content}`)
          └── sendCommand('prompt', { message: ... })           [→ pi stdin]
```

**与链路 1 共享入口**，区别是 payload 中有 `subagent` 字段时走 `sendSubagentMessage`。

### 链路 3：中止生成 → `abort`

```
[前端入口]
  useChat.ts:418  send({ type: 'message.abort', payload: { sessionId } })
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'message.abort'
    ↓
  session-service.ts:abort(sessionId)                         [L270]
    ├── pm.getClient(sessionId) → RpcClient
    └── client.abort()                                         [rpc-client.ts:325]
          └── sendCommand('abort')                              [→ pi stdin]
```

**涉及文件** (code-link 2 文件, 2 nodes):
- `session-service.ts` → `process-manager.ts` → `rpc-client.ts`

### 链路 4：steer / follow_up → `steer` / `follow_up`

```
[前端入口]
  (steer)   send({ type: 'message.steer', payload: { sessionId, content } })
  (follow)  send({ type: 'message.follow_up', payload: { sessionId, content } })
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'message.steer' / 'message.follow_up'
    ↓
  session-service.ts:steerMessage(sessionId, content)         [L276]
    └── client.steer(content)                                  [rpc-client.ts:329]
          └── sendCommand('steer', { message: content })        [→ pi stdin]

  session-service.ts:followUpMessage(sessionId, content)      [L282]
    └── client.followUp(content)                               [rpc-client.ts:333]
          └── sendCommand('follow_up', { message: content })    [→ pi stdin]
```

**涉及文件** (code-link 3 文件, 3 nodes):
- `session-service.ts` → `process-manager.ts` → `rpc-client.ts`

---

## 二、Session 生命周期类（6 条链路）

### 链路 5：创建 Session → spawn pi + `get_state` + `get_commands`

```
[前端入口]
  useSession.ts:124  send({ type: 'session.create', payload: { cwd, label } })
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'session.create'
    ↓
  session-service.ts:create(cwd, label)                       [L71]
    ├── getDefaultModel() → pi-config-bridge.ts
    ├── getSkillPaths(cwd) → pi-config-bridge.ts + scanner-base.ts
    ├── getExtensionPaths() → extension-service.ts
    ├── pm.createSession(id, cwd, { skillPaths, extensionPaths })
    │     ├── findPiExecutable() → process-manager.ts          [查找 pi 二进制]
    │     ├── new RpcClient({ cwd, ...options })
    │     └── client.start()                                    [spawn pi --mode rpc]
    │           └── spawn(pi, ['--mode', 'rpc', '--no-extensions', '--skill', ..., '--extension', ...])
    ├── client.sendCommand('get_state')                         [L112 → pi stdin]
    │     └── 获取真实 sessionId / sessionFile / leafId
    ├── client.getCommands()                                    [rpc-client.ts:365]
    │     └── sendCommand('get_commands')                       [→ pi stdin]
    ├── initializeManagedSession()
    │     ├── treeService.registerSession()
    │     ├── readGitInfo()
    │     └── eventAdapter.attach(client)
    └── broker.broadcast({ type: 'session.list', ... })
```

**涉及文件** (code-link 17 文件, 41 nodes):
- `useSession.ts` → `server.ts` → `session-service.ts` → `process-manager.ts` → `rpc-client.ts`
- 辅助：`event-adapter.ts`, `pi-config-bridge.ts`, `scanner-base.ts`, `git-info.ts`, `tree-service.ts`, `session-file-utils.ts`

### 链路 6：恢复 Session → spawn pi + `switch_session` + `get_state` + `get_commands`

```
[前端入口]
  useSession.ts (隐式)  session.switch / session.restore → 恢复不活跃 session
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'session.restore'
    ↓
  session-service.ts:restoreSession(sessionId)                 [L400+]
    ├── findScannedSession(sessionId) → pi-config-bridge.ts
    ├── pm.createSession(id, cwd, { skillPaths, extensionPaths })
    │     └── client.start()                                    [spawn pi --mode rpc]
    ├── client.sendCommand('switch_session', { sessionPath })   [L451 → pi stdin]
    ├── client.sendCommand('get_state')                         [→ pi stdin]
    ├── client.getCommands() → sendCommand('get_commands')     [→ pi stdin]
    └── initializeManagedSession() → (同链路 5)
```

**涉及文件** (code-link 18 文件, 51 nodes):
- 同链路 5 + `trash.ts`, `extension-resolver.ts`

### 链路 7：删除 Session → kill pi

```
[前端入口]
  useSession.ts:128  send({ type: 'session.delete', payload: { sessionId } })
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'session.delete'
    ↓
  session-service.ts:delete(sessionId)
    ├── pm.destroySession(sessionId)
    │     └── proc.client.kill()                                [SIGTERM → 2s → SIGKILL]
    ├── treeService.unregisterSession(sessionId)
    ├── eventAdapter.detach(client)
    └── trash(sessionFilePath) → 移到回收站
```

**涉及文件** (code-link 9 文件, 18 nodes):
- `session-service.ts` → `process-manager.ts` → `rpc-client.ts` (kill)
- 辅助：`tree-service.ts`, `trash.ts`, `session-file-utils.ts`, `event-adapter.ts`

### 链路 8：压缩 Session → `compact`

```
[前端入口]
  useSession.ts:145  send({ type: 'session.compact', payload: { sessionId } })
    ↓ WS
[sidecar] server.ts → handleSessionCompact()
    ↓ (如果 session 不活跃，先 auto-restoreSession → 链路 6)
  session-service.ts:compact(sessionId)                        [L332]
    ├── pm.getClient(sessionId) → RpcClient
    ├── client.compact()                                        [rpc-client.ts:353]
    │     └── sendCommand('compact', {}, 300_000)               [→ pi stdin, 300s 超时]
    └── broker.broadcast({ type: 'session.compacted', ... })
```

**涉及文件** (code-link 4 文件, 4 nodes):
- `server.ts` → `session-service.ts` → `process-manager.ts` → `rpc-client.ts`

### 链路 9：清空 Session → `new_session`

```
[前端入口]
  useSession.ts:151  send({ type: 'session.clear', payload: { sessionId } })
    ↓ WS
[sidecar] server.ts:handleSessionMessage → case 'session.clear'
    ↓
  session-service.ts:clear(sessionId)                          [L354]
    ├── pm.getClient(sessionId) → RpcClient
    ├── client.clear()                                          [rpc-client.ts:361]
    │     └── sendCommand('new_session')                         [→ pi stdin]
    └── session.lastActiveAt = Date.now()
```

**涉及文件** (code-link 3 文件, 3 nodes):
- `session-service.ts` → `process-manager.ts` → `rpc-client.ts`

### 链路 10：切换 / 查看历史 → `get_messages` (+ `switch_session` + `get_state`)

```
[前端入口]
  useSession.ts:139  send({ type: 'session.history', payload: { sessionId } })
  useTree.ts:64     send({ type: 'session.history', ... })     [navigate 后刷新]
  useTree.ts:90/107 send({ type: 'session.switch', ... })      [fork/clone 后切换]
    ↓ WS
[sidecar] server.ts:handleSessionMessage
    ↓ case 'session.switch'
  如果 session 活跃:
    session-service.ts:getHistory(sessionId)                   [L364]
      ├── client.getHistory()                                  [rpc-client.ts:349]
      │     └── sendCommand('get_messages')                     [→ pi stdin]
      ├── convertPiHistory(raw) → message-converter.ts
      └── fallback: getHistoryFromFile(sessionId) → session-history.ts

  如果 session 不活跃:
    session-service.ts:restoreSession(sessionId) → (链路 6)
      └── getHistory() → 同上
```

**涉及文件** (code-link 9 文件, 13 nodes):
- `session-service.ts` → `process-manager.ts` → `rpc-client.ts` → `message-converter.ts`
- 辅助：`session-history.ts`, `session-file-utils.ts`, `pi-config-bridge.ts`

---

## 三、Session Tree 类（4 条链路）

### 链路 11：读取 Tree → `get_state`

```
[前端入口]
  useTree.ts:150  send({ type: 'session.tree-data', payload: { sessionId } })
  useTree.ts:65   send({ type: 'session.tree-data', ... })     [navigate 后刷新]
    ↓ WS
[sidecar] server.ts → treeMessageHandler → case 'session.tree-data'
  tree-message-handler.ts → treeService.getTree(sessionId)
    ↓
  tree-service.ts:getTree(sessionId)                           [L63]
    ├── pm.getClient(sessionId) → RpcClient
    ├── client.sendCommand('get_state')                         [→ pi stdin]
    │     └── 获取 sessionFile / leafId
    ├── buildTreeFromFile(sessionFile) → session-tree-reader.ts
    └── 返回 { sessionId, tree, leafId, branchCount, navigateCapable }
```

**涉及文件** (code-link 6 文件, 10 nodes):
- `useTree.ts` → `server.ts` → `tree-message-handler.ts` → `tree-service.ts` → `process-manager.ts` → `rpc-client.ts`
- 辅助：`session-tree-reader.ts`

### 链路 12：Tree 导航 → `prompt` (via `/xyz-navigate`)

```
[前端入口]
  useTree.ts:163  send({ type: 'session.tree-navigate', payload: { sessionId, targetEntryId } })
    ↓ WS
[sidecar] server.ts → treeMessageHandler → case 'session.tree-navigate'
  tree-message-handler.ts → treeService.navigateTree(sessionId, targetEntryId)
    ↓
  tree-service.ts:navigateTree(sessionId, targetEntryId)       [L128]
    ├── pm.getClient(sessionId) → RpcClient
    ├── buildTreeFromFile() → 验证 entry 存在 + 提取 editorText
    ├── interceptor.setResolver(() => {}) → navigate-interceptor.ts
    ├── Promise.race([
    │     client.prompt(`/xyz-navigate ${targetEntryId}`),     [→ pi stdin]
    │     timeout(5s)
    │   ])
    └── 返回 { success, newLeafId, editorText }
```

**涉及文件** (code-link 8 文件, 15 nodes):
- `tree-service.ts` → `process-manager.ts` → `rpc-client.ts` → `navigate-interceptor.ts`
- 辅助：`session-tree-reader.ts`

### 链路 13：Tree Fork → `fork` + `get_state`

```
[前端入口]
  useTree.ts:168  send({ type: 'session.tree-fork', payload: { sessionId, entryId } })
    ↓ WS
[sidecar] server.ts → treeMessageHandler → case 'session.tree-fork'
  tree-message-handler.ts → treeService.forkFromEntry(sessionId, entryId)
    ↓
  tree-service.ts:forkFromEntry(sessionId, entryId)            [L181]
    ├── pm.getClient(sessionId) → RpcClient
    ├── client.sendCommand('fork', { entryId })                 [→ pi stdin]
    ├── client.sendCommand('get_state')                         [→ pi stdin]
    │     └── 获取 newSessionId + sessionFile
    └── 返回 { success, newSessionId, sessionFile }
```

**涉及文件** (code-link 3 文件, 3 nodes):
- `tree-service.ts` → `process-manager.ts` → `rpc-client.ts`

### 链路 14：Tree Clone → `clone` + `get_state`

```
[前端入口]
  useTree.ts:176  send({ type: 'session.tree-clone', payload: { sessionId } })
    ↓ WS
[sidecar] server.ts → treeMessageHandler → case 'session.tree-clone'
  tree-message-handler.ts → treeService.cloneSession(sessionId)
    ↓
  tree-service.ts:cloneSession(sessionId)                       [L156]
    ├── pm.getClient(sessionId) → RpcClient
    ├── client.sendCommand('clone')                              [→ pi stdin]
    ├── client.sendCommand('get_state')                          [→ pi stdin]
    │     └── 获取 newSessionId
    └── 返回 { success, newSessionId }
```

**涉及文件** (code-link 7 文件, 12 nodes):
- `tree-service.ts` → `process-manager.ts` → `rpc-client.ts`
- 辅助：`session-service.ts`, `tree-message-handler.ts`

---

## 四、模型配置类（3 条链路）

### 链路 15：切换模型 → `set_model`

```
[前端入口]
  useModel.ts:8  send({ type: 'model.switch', payload: { sessionId, provider, modelId } })
    ↓ WS
[sidecar] server.ts → settings-message-handler → case 'model.switch'
    ↓
  session-service.ts:switchModel(sessionId, provider, modelId) [L295]
    ├── session.modelId = `${provider}/${modelId}`
    ├── pm.getClient(sessionId) → RpcClient
    └── client.setModel(provider, modelId)                     [rpc-client.ts:337]
          └── sendCommand('set_model', { provider, modelId })   [→ pi stdin]
```

**涉及文件** (code-link 4 文件, 4 nodes):
- `session-service.ts` → `process-manager.ts` → `rpc-client.ts`

### 链路 16：设置思考级别 → `set_thinking_level`

```
[前端入口]
  useModel.ts:11  send({ type: 'session.setThinkingLevel', payload: { sessionId, level } })
    ↓ WS
[sidecar] server.ts → settings-message-handler → case 'session.setThinkingLevel'
    ↓
  session-service.ts:setThinkingLevel(sessionId, level)        [L304]
    ├── pm.getClient(sessionId) → RpcClient
    └── client.setThinkingLevel(level)                         [rpc-client.ts:341]
          └── sendCommand('set_thinking_level', { level })      [→ pi stdin]
```

**涉及文件** (code-link 2 文件, 2 nodes):
- `session-service.ts` → `process-manager.ts` → `rpc-client.ts`

### 链路 17：验证 Provider → spawn 临时 pi + `get_available_models`

```
[前端入口]
  useProvider.ts:119  send({ type: 'config.setProvider', ... })
    ↓ WS
[sidecar] server.ts → settings-message-handler → case 'config.setProvider'
  config-service.ts:setProvider()
    ↓ (如果需要验证)
  process-manager.ts:validateProvider(providerId, apiKey, baseUrl)  [L235]
    ├── new RpcClient({ env }) → 临时进程
    ├── client.start()                                          [spawn 临时 pi]
    ├── client.getAvailableModels()                             [rpc-client.ts:345]
    │     └── sendCommand('get_available_models')                [→ pi stdin]
    └── client.kill()                                           [销毁临时进程]
```

**涉及文件** (code-link 3 文件, 4 nodes):
- `process-manager.ts` → `rpc-client.ts`

---

## 五、Extension UI 响应类（1 条链路，多入口）

### 链路 18：Extension UI Response → `extension_ui_response`

pi 在处理消息时可能发起 UI 请求（confirm、select、bridge 调用），xyz-agent 需要回复。

```
[pi → sidecar]
  pi 发送 extension_ui_request → event-adapter.ts 转发
    ↓ WS
[前端]
  用户操作 → useExtensionUI / useToolApproval
    ↓ WS
  send({ type: 'extension.ui_response', payload: { sessionId, requestId, result } })
    ↓ WS
[sidecar] server.ts:handleExtensionMessage → case 'extension.ui_response'
    ↓
  client.sendCommand('extension_ui_response', { id: requestId, response: result })
    [→ pi stdin]

  --- 或 Bridge 模式（不经过前端）---

[pi → sidecar]
  pi 发送 extension_ui_request (method=bridge:*)
    ↓
  bridge-handler.ts:handleBridgeRequest(sessionId, requestId, method, data, client)
    ↓
    case 'bridge:sync':
      pluginService.getToolSchemas() → 返回 tools/commands
      client.sendCommand('extension_ui_response', { id, response: { tools, commands } })

    case 'bridge:tool_execute':
      pluginService.handleBridgeToolExecute() → 执行工具
      client.sendCommand('extension_ui_response', { id, response: result })

    case 'bridge:event':
      pluginService.handleBridgeEvent() → 处理事件
      client.sendCommand('extension_ui_response', { id, response: null })

    case 'bridge:intercept':
      pluginService.handleBridgeIntercept() → 拦截处理
      client.sendCommand('extension_ui_response', { id, response: result })

  --- 超时路径 ---

  extension-timeout-manager.ts → 超时后:
    client.sendCommand('extension_ui_response', { id, response: defaultResponse })
      (confirm → false, 其他 → null)
```

**涉及文件** (code-link 6 文件, 9 nodes):
- `bridge-handler.ts` → `rpc-client.ts` → `plugin-service.ts` → `bridge-interop.ts`
- 辅助：`extension-timeout-manager.ts`, `server.ts`

---

## 六、插件 Agent API → `set_model`（1 条链路）

### 链路 19：Plugin Agent API → `set_model`

```
[Plugin Worker Thread]
  createAgentApi().setModel(model)
    ↓ RPC
  PluginRpcServer → plugin.agent.setModel
    ↓
  agent-api.ts → AgentHandlers.setModel(model)
    ↓
  session-service.ts:switchModel(sessionId, provider, modelId)
    ↓
  client.setModel(provider, modelId)
    └── sendCommand('set_model', { provider, modelId })         [→ pi stdin]
```

---

## 七、进程级调用（2 条链路）

### 链路 20：启动 pi 子进程

```
process-manager.ts:createSession(sessionId, cwd, options)
    ↓
  findPiExecutable()                                            [扫描 PATH/nvm/common]
    ↓
  new RpcClient({ cwd, ...options, piCommand })
    ↓
  rpc-client.ts:start()
    ├── spawn(piCommand, ['--mode', 'rpc', '--no-extensions', '--model', ..., '--skill', ..., '--extension', ...])
    ├── 设置 env: PI_CODING_AGENT_DIR, 白名单环境变量
    ├── readline.createInterface(proc.stdout) → 逐行解析 JSON
    └── proc.stderr → 收集错误信息
```

### 链路 21：终止 pi 子进程

```
process-manager.ts:destroySession(sessionId)
    ↓
  rpc-client.ts:kill()
    ├── SIGTERM
    ├── 等待 2s
    └── SIGKILL（如果仍未退出）
```

---

## 八、非 pi RPC 的 WS 消息（不直接调用 pi）

以下 WS 消息只操作本地数据（pi 配置文件、缓存等），不直接发起 RPC 调用 pi 子进程：

| WS 消息类型 | 处理文件 | 操作 |
|-------------|---------|------|
| `config.getProviders` | `settings-message-handler.ts` → `config-service.ts` | 读取 `models.json` |
| `config.setProvider` | `settings-message-handler.ts` → `config-service.ts` | 写入 `models.json` |
| `config.deleteProvider` | `settings-message-handler.ts` → `config-service.ts` | 删除 `models.json` 中的 provider |
| `config.discoverModels` | `settings-message-handler.ts` → `model-service.ts` | HTTP 请求 provider API |
| `config.scanSkills` | `settings-message-handler.ts` → `config-service.ts` | 扫描 skill 目录 |
| `config.setSkill` | `settings-message-handler.ts` → `config-service.ts` | 注册 skill 路径 |
| `config.deleteSkill` | `settings-message-handler.ts` → `config-service.ts` | 移除 skill 路径 |
| `config.scanAgents` | `settings-message-handler.ts` → `config-service.ts` | 扫描 agent 目录 |
| `config.setAgent` | `settings-message-handler.ts` → `config-service.ts` | 写 agent .md 文件 |
| `config.deleteAgent` | `settings-message-handler.ts` → `config-service.ts` | 删 agent .md 文件 |
| `session.list` | `server.ts` → `session-service.ts` | 扫描磁盘 + 内存 Map |
| `session.rename` | `server.ts` → `session-service.ts` | 写 session name 到文件 |
| `plugin.*` | `plugin-message-handler.ts` | 插件管理（安装/卸载/切换） |
| `extension.*` | `server.ts` | 扩展管理（安装/卸载/切换） |

---

## 九、汇总统计

### RPC 命令频次

| RPC 命令 | 调用次数 | 超时 |
|----------|---------|------|
| `prompt` | 3 (send + subagent + navigate) | 60s / 5s(navigate) |
| `get_state` | 5 (create + restore + getTree + clone + fork) | 60s |
| `extension_ui_response` | 8+ (bridge 各方法 + 超时) | 60s |
| `get_messages` | 1 (getHistory) | 60s |
| `get_commands` | 1 (create/restore 后检测) | 60s |
| `switch_session` | 1 (restoreSession) | 60s |
| `set_model` | 2 (前端切换 + 插件 API) | 60s |
| `compact` | 1 | 300s |
| `abort` | 1 | 60s |
| `steer` | 1 | 60s |
| `follow_up` | 1 | 60s |
| `new_session` | 1 (clear) | 60s |
| `clone` | 1 | 60s |
| `fork` | 1 | 60s |
| `get_available_models` | 1 (validateProvider) | 60s |
| `set_thinking_level` | 1 | 60s |

### 关键文件参与度

| 文件 | 参与链路数 | 角色 |
|------|-----------|------|
| `rpc-client.ts` | 全部 19 条 | 唯一 pi 通信出口 |
| `session-service.ts` | 10 条 | Session 生命周期管理 |
| `process-manager.ts` | 12 条 | 进程创建/销毁/查找 |
| `server.ts` | 全部 19 条 | WS 路由中枢 |
| `tree-service.ts` | 4 条 | Tree 操作 |
| `bridge-handler.ts` | 1 条 (多分支) | Extension bridge |
| `event-adapter.ts` | create/restore | pi 事件 → 前端广播 |
