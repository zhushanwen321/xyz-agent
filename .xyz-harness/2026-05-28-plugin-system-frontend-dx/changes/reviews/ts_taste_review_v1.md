---
review:
  type: ts_taste_review
  round: 1
  timestamp: "2026-05-29T07:00:00"
  verdict: pass
  must_fix: 3
  target:
    - src-electron/runtime/src/services/plugin-service/plugin-service.ts
    - src-electron/runtime/src/services/plugin-service/plugin-rpc-server.ts
    - src-electron/runtime/src/services/plugin-service/plugin-activator.ts
    - src-electron/renderer/src/stores/plugin.ts
    - src-electron/renderer/src/composables/usePlugin.ts
    - src-electron/renderer/src/components/settings/PluginsPane.vue
summary: >
  TypeScript/Vue 代码品味审查完成。整体品味良好：层次清晰（PluginService
  委托至子服务）、JSON-RPC 协议实现干净、状态机设计明确。发现 3 个
  MUST_FIX（1 个语义错误 + 2 个重复模式提炼）、3 个结构改进
  （长函数拆分、并行 Map 合并）。无严重 bug。

statistics:
  total_files: 6
  total_lines: 2115
  issues_must_fix: 3
  issues_structural: 3
  issues_naming: 2
  issues_type_safety: 1
  issues_testability: 2
  issues_duplication: 2

issues:
  - id: T1
    file: PluginsPane.vue
    severity: MUST_FIX
    dimension: 错误处理模式
    title: "handlePermissionCancel 调用了错误的 API"
    detail: >
      `handlePermissionCancel()` 调用 `store.approvePermissions(id, [])`
      而非 `store.revokePermissions(id)`。虽然当前后端实现
      `grant(pluginId, [])` 是空操作（无副作用），但语义完全错误：
      “取消”应当“撤销”而非“批准空列表”。后续维护者会困惑为何
      cancel 走了 approve 路径。必须改为 `store.revokePermissions(id)`。

  - id: T2
    file: stores/plugin.ts
    severity: MUST_FIX
    dimension: 代码重复
    title: "togglePlugin() 的乐观更新逻辑与 setStatusChange() 重复"
    detail: >
      `togglePlugin()` 内联了状态更新：
      ```
      updatePluginField(id, { enabled, status: enabled ? 'active' : 'inactive' })
      pluginStatuses.set(id, enabled ? 'active' : 'inactive')
      ```
      这与 `setStatusChange()` 的职责完全相同。任何对状态更新规则
      的修改（如新增字段）需要同步两处。应让 `togglePlugin` 的乐
      观更新调用 `setStatusChange()` 而不是自行实现。

  - id: T3
    file: plugin-service.ts
    severity: MUST_FIX
    dimension: 职责单一性
    title: "三个并行 Map (sessionDataCache/Dirty/Size) 应封装为单一类"
    detail: >
      `sessionDataCache`, `sessionDataDirty`, `sessionDataSize` 三个
      Map 同步维护相同 key 集合的三个方面（值、脏标记、字节数）。
      任何遗漏同步都会导致静默数据不一致。`clearSessionData()`,
      `flushSessionData()`, `flushSessionDataForSession()` 都需重复
      delete/get 三个 Map。应封装为 `SessionDataStore` 类，统一
      管理读/写/脏标记/size tracking。

  - id: T4
    file: plugin-service.ts
    severity: STRUCTURAL
    dimension: 函数长度
    title: "registerRpcMethods() 130 行，需按领域拆分"
    detail: >
      该方法包含 15+ 个 `registerMethod` 调用覆盖 8 个 API 领域
      （tool/hook/storage/session/config/sessionData/ui/agent/workspace）。
      应按领域拆分为子方法：
      `registerStorageRpcMethods()` / `registerSessionRpcMethods()` /
      `registerConfigRpcMethods()` 等。当前所有 handler 通过闭包
      捕获的依赖（`this.storage`, `this.rpcServer`）在拆分后也
      同样可以访问。

  - id: T5
    file: plugin-service.ts
    severity: STRUCTURAL
    dimension: 函数长度
    title: "initialize() 72 行，9 个步骤可提取为阶段方法"
    detail: >
      `initialize()` 的 9 个步骤（1-9）各自有独立职责，但目前是
      顺序大块。建议提取为：
      `scanAndRegister()` (1)
      `initStorage()` (2)
      `setupRpcMethods()` (3)
      `setupHostCallbacks()` (4)
      `startMonitoring()` (5)
      `triggerStartupEvent()` (6)
      `broadcastState()` (7)
      `startFlushService()` (8)
      `startHotReloadWatchers()` (9)

  - id: T6
    file: plugin-activator.ts
    severity: STRUCTURAL
    dimension: 职责单一性
    title: "activateWithDeps() 做了 4 件事，应提取辅助方法"
    detail: >
      `activateWithDeps()` 顺序执行：注册 descriptor → 检查缺失依赖
      → 检测循环 → 拓扑排序 + 激活。缺失依赖检查和循环检测的逻辑
      可提取为独立方法 `validateDependencies()`，使主方法聚焦于
      编排流程而非细节。此外 `performReload()` 的 deactivate 超时
      回退可能和 `activatePlugin()` 产生竞态，建议加一个 per-plugin
      的 mutex guard。

  - id: T7
    file: plugin-rpc-server.ts
    severity: STRUCTURAL
    dimension: 可测试性
    title: "makeErrorResponse() 的 data 参数从未被使用"
    detail: >
      `makeErrorResponse(id, code, message, data?)` 的 `data` 参数
      在方法体内从未使用。要么移除该参数，要么在响应中添加 `data`
      字段以保持 JSON-RPC 2.0 的 `error.data` 规范兼容性。

  - id: T8
    file: plugin-service.ts
    severity: STRUCTURAL
    dimension: 可测试性
    title: "handleBridgeToolExecute 的 O(n) 工具查找"
    detail: >
      `Array.from(toolRegistry.values()).find(e => e.schema.name === ...)`
      每次工具执行都遍历全表。虽然当前插件数量少时可接受，但这是
      性能关键路径（每次 LLM tool call 都会触发）。建议在类初始化
      时建立 `schemaName → ToolEntry` 的二级索引 Map。

  - id: T9
    file: plugin-activator.ts / plugin-service.ts
    severity: STRUCTURAL
    dimension: 代码重复
    title: "Promise.race + setTimeout 超时模式重复出现"
    detail: >
      该模式在 `flushSessionDataForSession()` 和
      `performReload()` 中重复实现。考虑提取为工具函数
      `withTimeout<T>(promise, ms, fallback)` 统一处理超时逻辑。

  - id: T10
    file: usePlugin.ts
    severity: LOW
    dimension: 类型安全
    title: "type assertion 替代 discriminated union"
    detail: >
      handler 中使用 `msg.payload as {...}` 做类型断言，而非利用
      ServerMessage 的 discriminated union。虽然当前安全（payload
      结构与协议对齐），但类型错误会在运行时而非编译时暴露。
      可考虑在 `on()` 注册层面注入 payload 类型。

  - id: T11
    file: PluginsPane.vue
    severity: LOW
    dimension: 命名清晰度
    title: "handleToggle 双层 destructure + inversion 增加认知负担"
    detail: >
      调用处 `handleToggle({ id: plugin.pluginId, enabled: !plugin.enabled })`
      构造一个对象，handler 中接收 `{ id, enabled }`。`enabled`
      是经过一次取反的值（"改为禁用"），但变量名 `enabled` 暗示
      当前状态。建议直接传递两个参数或使用 `{ id, currentEnabled }`
      减少歧义。

  - id: T12
    file: stores/plugin.ts
    severity: LOW
    dimension: 命名清晰度
    title: "fetchPlugins() 命名与 setPlugins() 不易区分"
    detail: >
      `fetchPlugins()` 是 WS 发送动作，`setPlugins()` 是本地状态
      更新。建议将 WS 发送动作统一加 prefix：
      `requestPluginList()` vs `setPlugins()`，使读写意图一目了然。

  - id: T13
    file: PluginsPane.vue
    severity: LOW
    dimension: 职责单一性
    title: "组件模板承载过多职责，建议拆分子组件"
    detail: >
      355 行的单文件组件承载了：插件列表渲染、展开/折叠、权限
      展示、trust upgrade 对话框、uninstall 确认、权限请求弹窗。
      建议提取 `PluginRow.vue`（每行的渲染逻辑）和
      `PluginDetailCard.vue`（展开后详情面板），将 Dialog 独立出口。

summary_scores:
  function_length: "3/10 — registerRpcMethods() 130 行严重超标，initialize() 72 行超标"
  complexity: "7/10 — 整体圈复杂度可控，但 activateWithDeps 4 件事需拆分"
  naming_clarity: "7/10 — 多数命名清晰，fetchPlugins/setPlugins 略混淆"
  single_responsibility: "5/10 — sessionData 三个 Map 未封装，registerRpcMethods 过长"
  error_handling: "7/10 — handlePermissionCancel 语义错误需修复"
  type_safety: "8/10 — 少量 type assertions，整体类型设计良好"
  code_duplication: "6/10 — 乐观更新逻辑重复、超时模式重复、会话数据存取重复"
  testability: "6/10 — 超时工具函数未提取，长函数难测试，O(n) 查找不可 mock"
