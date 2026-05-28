---
review:
  type: code_review
  round: 4
  timestamp: "2026-05-28"
  target: "Plugin System Phase 2 — BLR 第4轮：server.ts bridge handler 接线验证"
  verdict: fail
  must_fix: 2
  summary: "commit d465aa5 修复了 server.ts 3 个 bridge handler 的接线问题（MF-1/MF-2/MF-3 全部 RESOLVED）。MF-6/MF-7 仍 OPEN：executeHooks 仍 fire-and-forget（MF-6），handleBridgeToolExecute 用 bare toolName 查找 pluginId:name 格式的 registry key（MF-7）。MF-7 现在从被掩盖变为可触发——因为 MF-2 修复后 tool_execute 实际走 PluginService 逻辑了。"
---

v4_fix_verification:
  - fix_id: "MF-1: bridge:sync 调用 getToolSchemas()"
    status: RESOLVED
    evidence: |
      server.ts L639-647 (commit d465aa5):
      - 旧代码: 遍历 this.pluginService.getDiscoveredPlugins() + plugin.contributes?.tools（静态 manifest）
      - 新代码: if (this.pluginService?.getToolSchemas) { const schemas = this.pluginService.getToolSchemas(); ... }
      直接获取 syncToolsToBridge() 缓存的 bridgeToolSchemas，不再依赖静态 manifest。
      数据流: plugin.tools.register → toolRegistry.set('goal:goal_manager') → syncToolsToBridge() → bridgeToolSchemas → getToolSchemas() → server.ts bridge:sync → pi

  - fix_id: "MF-2: bridge:tool_execute 调用 handleBridgeToolExecute()"
    status: RESOLVED
    evidence: |
      server.ts L652-665 (commit d465aa5):
      - 旧代码: 返回 'Tool execution not implemented' stub
      - 新代码: guard check `this.pluginService?.handleBridgeToolExecute`，然后调用并传递结果
      - 参数传递完整: toolName, params, toolCallId, sessionId 均正确传递
      - 返回值直接透传: response = result（BridgeToolExecuteResponse）
      注意: MF-7 的 key lookup 问题现在可触发了（之前被 stub 掩盖）。

  - fix_id: "MF-3: bridge:intercept 调用 handleBridgeIntercept()"
    status: RESOLVED
    evidence: |
      server.ts L675-681 (commit d465aa5):
      - 旧代码: 返回 {} stub，注释 'TODO (Phase 2 BG4)'
      - 新代码: guard check `this.pluginService?.handleBridgeIntercept && eventName === 'before_agent_start'`
      - 正确调用并返回 result（BridgeInterceptResponse）
      - 非 before_agent_start 事件仍 fallback 到空 response（合理）

remaining_must_fix:
  - id: MF-6
    severity: MUST_FIX
    location: "plugin-service.ts:310-329 (executeHooks)"
    title: "executeHooks broadcast 后不等待 Worker invoke 结果"
    status: open
    raised_in_round: 1
    unchanged_since_round: 3
    note: |
      代码不变: this.rpcServer.broadcast('plugin.hooks.invoke', ...) 后直接 return { blocked: false }。
      broadcast 是 fire-and-forget，Worker 的 hook 执行结果被完全忽略。
      影响: 所有 interceptor hook（包括 before_agent_start via handleBridgeIntercept → executeHooks）
      的 blocked=true 和 message 注入均无效。插件无法阻止或修改行为。

  - id: MF-7
    severity: MUST_FIX
    location: "plugin-service.ts:340-353 (handleBridgeToolExecute)"
    title: "handleBridgeToolExecute 用 bare toolName 查找但 registry key 为 pluginId:name"
    status: open
    raised_in_round: 1
    unchanged_since_round: 3
    severity_escalation: "v3 时被 MF-2（stub 返回）掩盖不可触发。v4 修复 MF-2 后此 bug 现在可触发。"
    note: |
      数据流分析确认 key 不匹配:
      1. tool-api.ts registerToolRpcHandlers: toolKey = `${pluginId}:${name}` → toolRegistry.set(toolKey, ...)
         例: pluginId='goal', name='goal_manager' → key='goal:goal_manager'
      2. schema.name = bare name ('goal_manager')，syncToolsToBridge() 保留 bare name
      3. bridge:sync 返回 { name: 'goal_manager' } 给 pi
      4. pi 调用 bridge:tool_execute，toolName = 'goal_manager'（bare name）
      5. handleBridgeToolExecute: toolRegistry.get('goal_manager') → undefined → 'Tool not found'
      修复方案: 要么在 syncToolsToBridge 返回完整 key 作为 name，要么在 handleBridgeToolExecute
      中遍历 registry 匹配 bare name，要么统一 key 格式。

previously_reported_not_repeated:
  - id: MF-5
    note: "activateWithDeps/topologicalSort 死代码。v1 起，不影响业务流。"
  - id: LOW-9
    note: "InterceptorHookType/ObserverHookType 与 hook-api.ts 不一致。v1 起。"
  - id: LOW-10
    note: "pendingMessage 从不非 null，pause/resume 无效。v1 起。"
  - id: LOW-11
    note: "sync 未合并两套来源。v1 起。bridge:sync 已改为读 getToolSchemas()，此问题自然消失。"
  - id: INFO-12/13/14
    note: "extension_ui_response/sessionData/bridge extension 死代码。v1 起。"

data_flow_verification:
  tool_registration_flow: |
    plugin Worker → api.tools.register({ name: 'goal_manager', ... })
      → tool-api.ts: toolKey = 'goal:goal_manager' → toolRegistry.set(key, { schema: { name: 'goal_manager' } })
      → syncToolsToBridge(): bridgeToolSchemas = [{ name: 'goal_manager', ... }]  ✅
      → server.ts bridge:sync → getToolSchemas() → 返回 tools: [{ name: 'goal_manager' }]  ✅

  tool_execution_flow: |
    pi → bridge:tool_execute({ toolName: 'goal_manager' })
      → server.ts → handleBridgeToolExecute({ toolName: 'goal_manager' })
      → toolRegistry.get('goal_manager') → undefined  ❌ MF-7
      → 返回 { content: 'Tool not found: goal_manager', isError: true }

  hook_intercept_flow: |
    pi → bridge:intercept({ eventName: 'before_agent_start', ... })
      → server.ts → handleBridgeIntercept(eventName, data, sessionId)
      → executeHooks('before_agent_start', context)
      → rpcServer.broadcast(...) → fire-and-forget  ❌ MF-6
      → return { blocked: false, injectedMessages: [] }

  permission_check_flow: |
    Worker RPC → PluginRpcServer.dispatch() → permissionCheck(pluginId, method)  ✅ (v2 confirmed)

conclusion: |
  V4 验证: server.ts 3 个 bridge handler 接线完成（MF-1/MF-2/MF-3 RESOLVED），"管道阀门已打开"。
  剩余 2 个 MUST FIX 均在 PluginService 内部实现层:
  - MF-7 (tool key lookup): 之前被 stub 掩盖，现在可触发。工具执行全链路断路。
  - MF-6 (hook fire-and-forget): 拦截/hook 系统形同虚设，blocked=true 永远无法生效。

  修复优先级: MF-7 > MF-6。MF-7 阻塞所有动态工具执行（goal_manager 等），是最核心的断路点。
