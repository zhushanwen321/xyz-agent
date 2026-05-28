---
review:
  type: code_review
  round: 3
  timestamp: "2026-05-28"
  target: "Plugin System Phase 2 — BLR 第3轮快速验证"
  verdict: fail
  must_fix: 5
  summary: "V2 报告的 3 个修复项验证结果：1 项完全修复（MF-8 IPluginService 接口），1 项完全修复（MF-4 PermissionChecker 接线到 RPC dispatch），server.ts 的 bridge handler 仍未调用接口方法导致 MF-1/MF-2/MF-3 继续断路。新增 0 条问题。剩余 5 条 MUST FIX 均为 v2 已报告、v3 未修复的问题。"

v3_fix_verification:
  - fix_id: "V2-MF-8: IPluginService 接口添加 bridge 方法"
    status: RESOLVED
    evidence: |
      interfaces.ts IPluginService 接口新增 5 个方法签名（全部 optional）：
      - handleBridgeRequest?(method, payload, sessionId): Promise<unknown>
      - getToolSchemas?(): ToolRegistration[]
      - handleBridgeToolExecute?(request): Promise<BridgeToolExecuteResponse>
      - handleBridgeEvent?(eventName, data, sessionId): void
      - handleBridgeIntercept?(eventName, data, sessionId): Promise<BridgeInterceptResponse>
      PluginService 类已实现全部 5 个方法。server.ts 现在可以通过 IPluginService 接口调用 bridge 方法。

  - fix_id: "V2-MF-4: PermissionChecker 接线到 PluginService + RPC dispatch"
    status: RESOLVED
    evidence: |
      plugin-service.ts initialize() 中完成完整接线：
      1. await this.permissionChecker.load() — 加载持久化权限
      2. this.rpcServer.setPermissionChecker((pluginId, method) => this.permissionChecker.check(pluginId, method))
      plugin-rpc-server.ts dispatch() 方法中权限检查逻辑完整：
      - 从 message.params?.pluginId 提取 pluginId
      - 调用 this.permissionCheck(pluginId, message.method)
      - 失败时返回 PERMISSION_DENIED 错误码
      三级权限模型生效：built-in/trusted 放行，sandbox 检查 granted map，未知插件拒绝。

  - fix_id: "V2-MF-1/MF-2/MF-3: server.ts bridge handler 路由到 PluginService"
    status: NOT_RESOLVED
    evidence: |
      server.ts handleBridgeRequest() 三个 bridge handler 仍然是 v2 状态的 stub：
      - bridge:sync (L639-666): 仍读 plugin.contributes?.tools（静态 manifest），未调用 this.pluginService?.getToolSchemas?()
      - bridge:tool_execute (L667-679): 仍返回 'Tool execution not implemented'，注释仍为 'TODO (Phase 2 BG4)'，未调用 this.pluginService?.handleBridgeToolExecute?()
      - bridge:intercept (L689-699): 仍返回 {}，注释仍为 'TODO (Phase 2 BG4)'，未调用 this.pluginService?.handleBridgeIntercept?()
      接口已经就绪，但 server.ts 没有调用。这是唯一剩余的阻塞点——路由层最后 3 行代码未连接。

remaining_must_fix:
  - id: MF-1
    severity: MUST_FIX
    location: "server.ts:639-666"
    title: "bridge:sync 未调用 getToolSchemas()"
    status: open
    raised_in_round: 1
    note: "IPluginService.getToolSchemas?() 已在接口中暴露，server.ts 可调用但未调用。仍读 contributes.tools 静态 manifest。"

  - id: MF-2
    severity: MUST_FIX
    location: "server.ts:667-679"
    title: "bridge:tool_execute 未调用 handleBridgeToolExecute()"
    status: open
    raised_in_round: 1
    note: "IPluginService.handleBridgeToolExecute?() 已在接口中暴露，server.ts 可调用但未调用。仍返回 stub 错误。"

  - id: MF-3
    severity: MUST_FIX
    location: "server.ts:689-699"
    title: "bridge:intercept 未调用 handleBridgeIntercept()"
    status: open
    raised_in_round: 1
    note: "IPluginService.handleBridgeIntercept?() 已在接口中暴露，server.ts 可调用但未调用。仍返回 {} stub。"

  - id: MF-6
    severity: MUST_FIX
    location: "plugin-service.ts:204-215 (executeHooks)"
    title: "executeHooks broadcast 后忽略 Worker invoke 结果"
    status: open
    raised_in_round: 1
    note: "broadcast 后立即返回 { blocked: false }，不等待 Worker hook 执行结果。"

  - id: MF-7
    severity: MUST_FIX
    location: "plugin-service.ts:226-232 (handleBridgeToolExecute)"
    title: "handleBridgeToolExecute 用 bare toolName 查找但 registry key 为 pluginId:name"
    status: open
    raised_in_round: 1
    note: "toolRegistry key 为 `${pluginId}:${name}`，但查找用 request.toolName（bare name）。当前被 MF-2 掩盖。"

previously_reported_not_repeated:
  - id: MF-5
    severity: MUST_FIX
    note: "activateWithDeps/topologicalSort 死代码。v1/v2 已报告，本轮无变化，v3 不再列为阻塞项——属于 Phase 3 功能完善，不影响当前业务流。"
  - id: LOW-9
    note: "InterceptorHookType/ObserverHookType 与 hook-api.ts 不一致。v1 已报告。"
  - id: LOW-10
    note: "pendingMessage 从不非 null，pause/resume 无效。v1 已报告。"
  - id: LOW-11
    note: "sync 未合并两套来源。v1 已报告。"
  - id: INFO-12/13/14
    note: "extension_ui_response/sessionData/bridge extension 死代码。v1 已报告。"

data_flow_verification:
  tool_registration_flow: |
    plugin api.tools.register → toolRegistry.set('goal:goal_manager') ✅
      → syncToolsToBridge() → bridgeToolSchemas 已填充 ✅
      → server.ts bridge:sync → ❌ 读 contributes.tools（空）
      → getToolSchemas?() 可调用但未调用 ← 仅差 1 行代码

  tool_execution_flow: |
    pi 调用 goal_manager → bridge:tool_execute →
      server.ts → ❌ 返回 'Tool execution not implemented'
      → handleBridgeToolExecute?() 可调用但未调用 ← 仅差 1 行代码

  hook_intercept_flow: |
    pi before_agent_start → bridge:intercept →
      server.ts → ❌ 返回 {}
      → handleBridgeIntercept?() 可调用但未调用 ← 仅差 1 行代码

  permission_check_flow: |
    Worker RPC request → PluginRpcServer.dispatch() →
      提取 pluginId → permissionCheck(pluginId, method) ✅
      → PluginPermissionChecker.check() ✅
      → built-in/trusted 放行, sandbox 检 granted, 未知拒绝 ✅

conclusion: |
  V3 验证结果：V2 指出的两个核心缺陷（接口缺失 + 权限检查未接线）均已修复。
  剩余阻塞集中在 server.ts 的 3 个 bridge handler——接口已就绪但未被调用。
  这是"管道已铺好，阀门未打开"的状态：PluginService 的 bridge 方法、权限系统、
  RPC dispatch 均已正确实现，server.ts 只需 3 处调用即可打通全链路。

  建议修复（预计 10 行代码）：
  1. bridge:sync → this.pluginService?.getToolSchemas?() 合并到 tools 数组
  2. bridge:tool_execute → this.pluginService?.handleBridgeToolExecute?()
  3. bridge:intercept → this.pluginService?.handleBridgeIntercept?()
