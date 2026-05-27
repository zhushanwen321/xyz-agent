---
verdict: pass
---

# Business Use Cases — 插件系统 Phase 1

## UC-1: 插件发现与列表展示

**Actor:** 用户（通过前端 Settings 面板）

**Preconditions:**
- Sidecar 已启动
- `~/.xyz-agent/plugins/` 目录下有一个或多个符合规范的插件

**Main Flow:**
1. 用户打开 Settings → Extensions/Plugins tab
2. 前端发送 `plugin.list` ClientMessage
3. Sidecar server.ts 路由到 `pluginService.getDiscoveredPlugins()`
4. PluginService 返回缓存的 PluginDescriptor[]
5. 前端渲染插件列表（名称、版本、描述、状态、信任等级）

**Alternative Paths:**
- A1: `~/.xyz-agent/plugins/` 不存在 → PluginRegistry.scan() 返回空数组 → 前端显示空状态
- A2: 某插件 package.json 缺少 xyzAgent 字段 → scan 跳过该目录，不报错
- A3: manifestVersion ≠ 1 → scan 跳过该插件，日志记录不兼容

**Postconditions:**
- 前端获得完整的 PluginDescriptor 列表
- 每个插件状态为 'discovered'（未加载）或 'inactive'（已禁用）

**Module Boundaries:** Frontend → WS Client → SidecarServer → PluginService → PluginRegistry

---

## UC-2: 插件启用/禁用

**Actor:** 用户（通过前端 Settings 面板）

**Preconditions:**
- UC-1 已完成，插件列表已展示
- 至少一个插件处于 discovered 状态

**Main Flow:**
1. 用户点击插件的 toggle 开关（启用）
2. 前端发送 `plugin.toggle` ClientMessage（{ name: "my-plugin", enabled: true }）
3. Sidecar 路由到 `pluginService.togglePlugin(pluginId, true)`
4. PluginService 更新 extension-state.json（移出 disabled 列表）
5. 触发 PluginActivator 检查该插件的 activationEvents
6. 如果插件声明 `onStartupFinished` → 立即激活
7. 返回刷新后的 PluginDescriptor[] → 前端更新 UI

**Alternative Paths:**
- A1: 插件已在 enabled 状态，用户再次启用 → 无操作，返回当前列表
- A2: 用户禁用正在运行的插件 → deactivatePlugin() → terminateWorker（如果是独占 Worker）
- A3: 禁用 trusted 共享 Worker 中的插件 → 仅 deactivate，不 terminate Worker（其他插件仍在用）

**Postconditions:**
- extension-state.json 已更新
- 若启用且满足激活条件，插件进入 ACTIVE 状态
- 若禁用，插件进入 UNLOADED 状态，Worker 资源已释放（适用时）

**Module Boundaries:** Frontend → WS Client → SidecarServer → PluginService → PluginActivator + PluginHost

---

## UC-3: 插件懒激活（首次使用）

**Actor:** 系统（PluginActivator 自动触发）

**Preconditions:**
- 插件已通过 UC-2 启用
- 插件声明了 `activationEvents: ["onSlashCommand:hello"]`
- 插件尚未被激活（状态为 discovered）

**Main Flow:**
1. 用户在聊天中输入 `/hello` 斜杠命令
2. PluginActivator 收到 `onSlashCommand:hello` 事件
3. 匹配到 pluginId="hello-world" 的激活事件
4. PluginHost.assignWorker() 为插件分配 Worker Thread
5. PluginHost.loadPlugin() 通过 Worker 加载入口模块
6. PluginActivator.activatePlugin() 创建 PluginContext + 注入 agentAPI
7. Worker bootstrap 调用 `module.activate(context)`
8. 插件状态变为 ACTIVE

**Alternative Paths:**
- A1: Worker 创建失败（bootstrap 脚本不存在）→ 状态回退到 UNLOADED，日志记录错误
- A2: 模块 import 失败（入口文件语法错误）→ 状态回退到 UNLOADED
- A3: activate() 抛出异常 → 状态回退到 UNLOADED，通知前端 plugin:crashed

**Postconditions:**
- 插件代码已加载到 Worker Thread 中
- PluginContext 已注入 agentAPI 代理
- 插件状态为 ACTIVE
- 前端可通过 `config.plugins` 消息看到状态更新

**Module Boundaries:** SlashMenu → PluginActivator → PluginHost → Worker Thread → PluginModule.activate()

---

## UC-4: 插件使用 KV 存储

**Actor:** 插件代码（在 Worker Thread 中运行）

**Preconditions:**
- UC-3 已完成，插件处于 ACTIVE 状态
- 插件持有 PluginContext.globalState 代理

**Main Flow:**
1. 插件调用 `context.globalState.set('lastRun', Date.now())`
2. Worker 内 PluginStateStorage proxy 通过 PluginRpcClient 发送 RPC request `plugin.storage.set`
3. 主线程 PluginRpcServer 收到请求，路由到 PluginStorage.set()
4. PluginStorage 更新内存缓存，标记为 dirty
5. 500ms debounce timer 触发 → flush() → writeFile(temp) + rename（原子操作）
6. RPC 返回成功给 Worker
7. 插件后续调用 `context.globalState.get('lastRun')` → RPC → PluginStorage 从内存缓存返回

**Alternative Paths:**
- A1: 存储超出 10MB 限制 → PluginStorage.set() throw STORAGE_FULL → RPC 返回错误 → Worker 侧 agentAPI proxy throw
- A2: 单个 value 超出 1MB → 同 A1
- A3: Sidecar 重启后 → PluginStorage.init() 从磁盘加载 → get() 返回之前持久化的值

**Postconditions:**
- globalState.json 文件写入磁盘
- 值在 Sidecar 重启后仍可读取
- 多插件并发写入互不阻塞（独立锁）

**Module Boundaries:** Worker PluginModule → PluginRpcClient → MessagePort → PluginRpcServer → PluginStorage → filesystem

---

## UC-5: 插件发送通知

**Actor:** 插件代码（在 Worker Thread 中运行）

**Preconditions:**
- 插件处于 ACTIVE 状态
- 插件持有 PluginContext.api.notify 代理

**Main Flow:**
1. 插件调用 `context.api.notify.info('Task completed successfully')`
2. Worker 内通过 PluginRpcClient.notify() 发送通知（不等响应）
3. 主线程 PluginRpcServer 收到 `plugin.notify` notification
4. PluginService 通过 IMessageBroker.sendEvent 广播 `plugin:notification` ServerMessage
5. 前端 event-bus 收到消息，显示 toast 通知

**Alternative Paths:**
- A1: Sidecar 未连接前端 → sendEvent 静默失败（无客户端，不影响插件运行）

**Postconditions:**
- 前端显示插件通知（toast 或消息气泡）
- 插件不需要等待通知完成

**Module Boundaries:** Worker PluginModule → PluginRpcClient → PluginRpcServer → PluginService → IMessageBroker → WS → Frontend

---

## UC-6: Worker 崩溃恢复

**Actor:** 系统（PluginHost 自动触发）

**Preconditions:**
- 插件处于 ACTIVE 状态，正在 trusted Worker 中运行

**Main Flow:**
1. 插件代码触发未捕获异常或 Worker OOM
2. Worker 的 `error` 事件触发
3. PluginHost 标记 WorkerHandle.status = 'crashed'
4. PluginHost 通知 PluginService
5. PluginService 通过 IMessageBroker 广播 `plugin:crashed` ServerMessage
6. trusted Worker → PluginHost 自动重建新 Worker，重新加载所有 trusted 插件
7. untrusted Worker → 等待下次激活时重建

**Alternative Paths:**
- A1: Worker 在 deactivate 过程中崩溃 → 强制 terminate，状态直接设为 UNLOADED
- A2: 重建 Worker 时再次崩溃 → 记录错误，不再重试，等待人工干预

**Postconditions:**
- 前端收到崩溃通知，显示错误提示
- trusted 插件自动恢复（用户无感知）
- untrusted 插件等待下次激活时恢复

**Module Boundaries:** Worker Thread (crash) → PluginHost → PluginService → IMessageBroker → Frontend

---

## UC-7: Sidecar 关闭时插件清理

**Actor:** 系统（Sidecar stop 流程）

**Preconditions:**
- Sidecar 正在运行，有活跃的插件

**Main Flow:**
1. 收到 SIGINT/SIGTERM
2. SidecarServer.stop() 调用 pluginService.shutdown()
3. PluginService 遍历所有 ACTIVE 插件，逐个调用 deactivatePlugin()
4. 每个 Worker 调用 `module.deactivate()`
5. PluginStorage.flushAll() 将所有脏数据写入磁盘
6. PluginHost terminate 所有 Worker
7. Worker 资源释放完成

**Alternative Paths:**
- A1: deactivate() 超时（>5s）→ 强制 terminate Worker
- A2: flushAll() 写入失败 → 日志记录错误，继续关闭流程

**Postconditions:**
- 所有 Worker 已终止
- 存储 数据已持久化到磁盘
- 无残留 Worker 进程

**Module Boundaries:** SIGINT/SIGTERM → SidecarServer.stop() → PluginService.shutdown() → PluginActivator + PluginStorage + PluginHost

---

## UC-8: 前端接收插件列表更新

**Actor:** 系统（Sidecar 主动推送）

**Preconditions:**
- Sidecar 已启动，前端已连接 WebSocket

**Main Flow:**
1. PluginService.initialize() 完成扫描
2. PluginService 通过 IMessageBroker 推送 `config.plugins` ServerMessage
3. 前端 WS Client 收到消息，通过 event-bus 分发
4. 前端更新 PluginStore 状态
5. Settings 面板（如果打开）自动更新列表

**Alternative Paths:**
- A1: 前端未连接 → 消息丢弃，前端下次发送 plugin.list 时重新获取

**Postconditions:**
- 前端 PluginStore 持有最新插件列表
- UI 反映当前插件状态

**Module Boundaries:** PluginService → IMessageBroker → WS Server → WS Client → Event Bus → PluginStore → Settings UI

---

## UC ↔ AC 覆盖映射表

| UC | 覆盖的 AC | 说明 |
|----|----------|------|
| UC-1 | AC-1 | PluginService 初始化 + 插件列表 |
| UC-2 | AC-1, AC-4 | 启用/禁用 + 懒激活触发 |
| UC-3 | AC-2, AC-4 | Worker 隔离 + 懒激活完整链路 |
| UC-4 | AC-3, AC-5 | JSON-RPC 通信 + KV 持久化 |
| UC-5 | AC-3 | JSON-RPC notification 通信 |
| UC-6 | AC-2 | Worker 崩溃恢复 |
| UC-7 | AC-6 | 关闭清理不影响现有功能 |
| UC-8 | AC-1 | 前端接收插件列表 |
