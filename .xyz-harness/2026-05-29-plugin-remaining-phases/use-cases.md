---
verdict: pass
---

# Use Cases — Plugin Remaining Phases

## UC-1: 插件读写 Session 状态

- **Actor**: 插件开发者
- **Preconditions**: PluginService 已注入 ISessionService，插件已激活
- **Main Flow**:
  1. 插件调用 `api.sessionData.set(sessionId, 'progress', { step: 3, total: 10 })`
  2. PluginService 将数据写入内存缓存，标记 dirty
  3. 定时 flush（5s）触发 `persistSessionData()`
  4. 数据写入 `~/.xyz-agent/plugins/session-data/{sessionId}.json`（atomic write）
  5. Sidecar 重启
  6. PluginService 初始化时调用 `loadSessionData()` 从文件恢复
  7. 插件调用 `api.sessionData.get(sessionId, 'progress')` 返回已持久化的数据
- **Alternative Paths**:
  - 4a. 数据超过 10MB → 抛出 STORAGE_LIMIT_EXCEEDED 错误，插件 catch 处理
  - 4b. 磁盘写入失败 → 日志记录错误，数据保留在内存，下次 flush 重试
  - 6a. JSON 文件损坏 → 日志警告，返回空缓存
- **Postconditions**: 插件 sessionData 跨 sidecar 重启持久化

**AC 覆盖**: AC-2

**Module Boundaries**: PluginService（内存缓存 + flush）→ 文件系统（持久化）。不依赖 pi bridge。

---

## UC-2: 插件与用户交互确认

- **Actor**: 插件开发者 → 终端用户
- **Preconditions**: PluginService 已注入 broadcastFn，前端 WS 已连接，ExtensionUIDialog 已挂载
- **Main Flow**:
  1. 插件调用 `api.ui.showConfirm('确认删除文件?')`
  2. PluginService UI handler 创建 requestId，生成 pending Promise
  3. PluginService 通过 broadcastFn 发送 `plugin:uiRequest` WS 消息
  4. 前端 usePlugin 监听器收到消息，设置 `activeRequest`（source: 'plugin'）
  5. ExtensionUIDialog 渲染确认对话框
  6. 用户点击"确认"
  7. 前端发送 `plugin.uiResponse` WS 消息（result: true）
  8. server.ts 路由到 `pluginService.handleUiResponse()`
  9. Pending Promise resolve(true)
  10. 插件收到 boolean 结果
- **Alternative Paths**:
  - 5a. 已有 pending request → 排队等待（串行处理）
  - 6a. 用户点击"取消" → resolve(false)
  - 6b. 用户无响应 60s → 超时 resolve(undefined)
  - 3a. WS 未连接 → 立即 resolve(undefined)
- **Postconditions**: 插件收到用户交互结果（boolean / string / undefined）

**AC 覆盖**: AC-4

**Module Boundaries**: Plugin UI handler → WS broadcast → 前端 dialog → WS response → PluginService resolve。四个节点，WS 协议为接口契约。

---

## UC-3: 插件拦截消息发送

- **Actor**: 插件开发者 → pi 引擎
- **Preconditions**: PluginService 已注册 sessionService.sendMessageHook，插件已注册 `onBeforeSendMessage` handler
- **Main Flow**:
  1. 用户在聊天框发送消息
  2. 前端 WS `session.sendMessage` 到 sidecar
  3. SessionService.sendMessage() 内部调用 sendMessageHook
  4. PluginService.executeHooks('onBeforeSendMessage', { sessionId, content })
  5. 插件 handler 返回 `{ transformedContent: content.toUpperCase() }`
  6. Hook 结果返回 sendMessageHook
  7. SessionService 用 transformedContent 替换原始 content
  8. pi 引擎收到修改后的消息
- **Alternative Paths**:
  - 5a. handler 返回 `{ blocked: true }` → SessionService 不发送消息，广播 error
  - 5b. handler 抛异常 → executeHooks 捕获，视为放行（original content）
  - 5c. handler 超时 5s → 视为放行
- **Postconditions**: pi 引擎可能收到被修改或被阻止的消息

**AC 覆盖**: AC-8

**Module Boundaries**: SessionService（hook 触发点）→ PluginService（hook 分发）→ Plugin Worker（handler 执行）。跨两个服务层，通过 hook callback 接口连接。

---

## UC-4: 插件感知 Agent 模型切换

- **Actor**: 插件开发者
- **Preconditions**: PluginService 已注入 IConfigService
- **Main Flow**:
  1. 插件调用 `api.agent.getModel()`
  2. Agent handler 调用 `configService.get('defaultModel')`
  3. 返回 `{ provider: 'openai', modelId: 'gpt-4o' }`
  4. 插件根据模型调整行为
  5. 插件调用 `api.agent.setModel('anthropic', 'claude-sonnet-4')`
  6. Agent handler 调用 `configService.set('defaultModel', { provider: 'anthropic', modelId: 'claude-sonnet-4' })`
  7. 后续 `getModel()` 返回新模型（读己之写一致性）
- **Alternative Paths**:
  - 2a. configService 未配置默认模型 → 返回 `{ provider: '', modelId: '' }`
  - 6a. configService 写入失败 → 抛出错误，插件 catch 处理
- **Postconditions**: 插件能读写当前模型配置

**AC 覆盖**: AC-3

**Module Boundaries**: Plugin Agent handler → IConfigService。单层调用，无跨服务。

---

## UC-5: Sandbox 插件权限审批

- **Actor**: 终端用户
- **Preconditions**: 用户安装了需要权限的 sandbox 插件，插件尚未激活
- **Main Flow**:
  1. 插件激活流程进入 ACTIVATING 状态
  2. PluginActivator 检查 manifest.permissions
  3. PermissionChecker 发现有未授权权限（['storage', 'sessions']）
  4. PluginActivator 广播 `plugin:permissionRequest`
  5. 前端 PermissionDialog 弹出，展示权限列表
  6. 用户点击"批准"
  7. 前端发送 `plugin.approvePermissions`
  8. 服务端记录授权，resolve 激活 Promise
  9. PluginActivator 继续激活流程
- **Alternative Paths**:
  - 5a. 用户点击"拒绝" → 插件标记 UNLOADED
  - 5b. 30s 超时无响应 → 插件标记 UNLOADED
  - 3a. 权限已全部授权 → 跳过推送，直接激活
- **Postconditions**: sandbox 插件在获得权限后激活，或因拒绝而保持 UNLOADED

**AC 覆盖**: AC-5

**Module Boundaries**: PluginActivator（权限检查 + 等待）→ broadcastFn（推送）→ 前端 dialog → WS response → PluginService（记录授权）→ PluginActivator（继续激活）。
