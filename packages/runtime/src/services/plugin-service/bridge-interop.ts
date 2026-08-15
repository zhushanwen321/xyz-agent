/**
 * Bridge interop — pi ↔ plugin adapter
 *
 * 统一持有所有 bridge 塑形逻辑：工具 schema 缓存 + 同步负载构造（P5 收口）
 * + tool 执行 + event/intercept 处理。plugin-service 只做薄门面委托，
 * transport（bridge-handler）只 reply 本模块产出的负载。
 *
 * 拆分前这些职责分散在 plugin-service.ts（syncToolsToBridge /
 * getBridgeSyncPayload）与 bridge-interop.ts（execute/event/intercept），
 * 现统一在此——pi↔plugin 适配器单一文件。
 */

import type { HookContext, HookResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, BridgeSyncPayload, HookType, ToolEntry, ToolRegistration } from './plugin-types.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import { toErrorMessage } from '../../utils/errors.js'

const TOOL_EXECUTE_TIMEOUT_MS = 30_000

/**
 * pi 事件 → plugin HookType 翻译映射表（IF1，D4）。
 *
 * pi 侧 bridge extension（resources/pi/agent/extensions/bridge/index.ts EVENTS 列表）
 * 转发的事件名是 snake_case（before_agent_start），而插件 HookRegistry 按 camelCase
 * HookType（onBeforeAgentStart/onPiEvent/onAfterToolResult）注册——不经翻译永远匹配不上。
 *
 * kind 语义：
 * - 'intercept'：可拦截事件，经 handleBridgeIntercept 链路，block/injectedMessages 生效
 * - 'observe'：纯观察事件，经 handleBridgeEvent 链路 → observe 快捷路径 notify（D2-2，零往返）
 *
 * 映射分流（D2-2 逐类定案，R-01）：
 * - observe 组 7 项挂泛型 `onPiEvent`——唯一可注册的 observe 通道（事件名随 context
 *   传给 handler，插件自滤），随 observe 快捷路径走 rpcServer.notify
 * - tool_call/tool_result 两项保持 `onAfterToolResult` + request 腿——该 hookType 的
 *   transform 语义（改写 output）需要同步回传，必须走 invoke；其 observe 需求由同事件
 *   的 onPiEvent 通知覆盖（event-interpreter 在 tool 事件点已有 onPiEvent 调用）
 *
 * 未在表中的事件名不翻译（返回空响应，保持 pi 协议兼容，ERR2）。
 */
export const PI_HOOK_EVENT_MAP: Record<string, { hookType: HookType; kind: 'intercept' | 'observe' }> = {
  before_agent_start: { hookType: 'onBeforeAgentStart', kind: 'intercept' },
  tool_call: { hookType: 'onAfterToolResult', kind: 'observe' },
  tool_result: { hookType: 'onAfterToolResult', kind: 'observe' },
  agent_start: { hookType: 'onPiEvent', kind: 'observe' },
  agent_end: { hookType: 'onPiEvent', kind: 'observe' },
  message_end: { hookType: 'onPiEvent', kind: 'observe' },
  turn_end: { hookType: 'onPiEvent', kind: 'observe' },
  session_start: { hookType: 'onPiEvent', kind: 'observe' },
  session_compact: { hookType: 'onPiEvent', kind: 'observe' },
  session_tree: { hookType: 'onPiEvent', kind: 'observe' },
}

/**
 * 工具 schema 缓存 + bridge:sync 负载塑形 + 按 name 执行路由索引（P5 从 plugin-service.ts 收口到此）。
 *
 * 持有 bridge 轮询缓存（`bridgeToolSchemas`）与 name → ToolEntry 索引（微项 7：
 * handleBridgeToolExecute 的 O(1) 路由），并把 ToolRegistration[] 塑形成
 * {name,description,parameters} 数组——这是插件域能力塑形，归 adapter 而非 transport。
 * transport 只 reply `getSyncPayload()` 的返回值。
 *
 * 索引与 registry 的同步约定：所有 toolRegistry 写点（plugin.tools.register/unregister
 * RPC handler、uninstallPlugin）之后都调 syncToolsToBridge() 刷新本缓存；索引 miss 时
 * handleBridgeToolExecute 回退线性扫 registry（防御未 sync 的写入），正确性不依赖
 * sync 时机。
 */
export class BridgeToolCache {
  private schemas: ToolRegistration[] = []
  private entriesByName = new Map<string, ToolEntry>()

  /** 同步 toolRegistry schema 到 bridge 轮询缓存 + name 执行路由索引 */
  syncFrom(toolRegistry: Map<string, ToolEntry>): void {
    const entries = Array.from(toolRegistry.values())
    this.schemas = entries.map(e => e.schema)
    this.entriesByName = new Map(entries.map(e => [e.schema.name, e]))
  }

  /** 获取 bridge 轮询缓存的工具 schema */
  getSchemas(): ToolRegistration[] {
    return this.schemas
  }

  /** 按工具 name 查执行路由条目（微项 7：O(1)） */
  getEntryByName(name: string): ToolEntry | undefined {
    return this.entriesByName.get(name)
  }

  /**
   * 构造 bridge:sync 同步负载（plugin 工具 schema 塑形）。
   * commands 目前固定空（pi 侧命令发现另走 getCommands）。
   */
  getSyncPayload(): BridgeSyncPayload {
    const tools = this.schemas.map(s => ({ name: s.name, description: s.description, parameters: s.parameters }))
    return { tools, commands: [], success: true }
  }
}

export async function handleBridgeToolExecute(
  request: BridgeToolExecuteRequest,
  toolRegistry: Map<string, ToolEntry>,
  host: PluginHost,
  rpcServer: PluginRpcServer,
  toolNameIndex?: { getEntryByName(name: string): ToolEntry | undefined },
): Promise<BridgeToolExecuteResponse> {
  // 微项 7：name 索引 Map.get O(1) 命中；miss（索引未刷新/未注入）回退线性扫，语义等价
  const entry = toolNameIndex?.getEntryByName(request.toolName)
    ?? Array.from(toolRegistry.values()).find(e => e.schema.name === request.toolName)
  if (!entry) {
    return { content: `Tool not found: ${request.toolName}`, isError: true }
  }

  const handle = host.getWorkerHandle(entry.pluginId)
  if (!handle) {
    return { content: 'Plugin worker crashed', isError: true }
  }

  try {
    const result = await rpcServer.invoke(
      handle.workerId,
      'plugin.tool.execute',
      {
        pluginId: entry.pluginId,
        toolName: request.toolName,
        arguments: request.parameters,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
      },
      TOOL_EXECUTE_TIMEOUT_MS,
    )
    return result as BridgeToolExecuteResponse
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('RPC timeout')) {
      return { content: 'Plugin tool execution timed out', isError: true }
    }
    const msg = toErrorMessage(err)
    return { content: `Plugin tool execution failed: ${msg}`, isError: true }
  }
}

export function handleBridgeEvent(
  eventName: string,
  data: unknown,
  sessionId: string,
  executeHooks: (hookType: string, context: HookContext) => Promise<HookResult>,
): void {
  const mapping = PI_HOOK_EVENT_MAP[eventName]
  // 有映射条目用翻译后 hookType（camelCase 才能命中 HookRegistry）；
  // 无映射条目（如 plugin:statusSetUpdate 等非 pi 事件）保持原 eventName，兼容既有行为。
  const hookType = mapping ? mapping.hookType : (eventName as HookType)
  const context: HookContext = {
    pluginId: '',
    hookType,
    data: { eventName, data, sessionId },
    timestamp: Date.now(),
  }
  executeHooks(hookType, context).catch((err: unknown) => {
    console.error(`[plugin-service] handleBridgeEvent error:`, err)
  })
}

export async function handleBridgeIntercept(
  eventName: string,
  data: unknown,
  sessionId: string,
  executeHooks: (hookType: string, context: HookContext) => Promise<HookResult>,
): Promise<BridgeInterceptResponse> {
  const mapping = PI_HOOK_EVENT_MAP[eventName]
  // 未在映射表中的事件名不翻译、不拦截（ERR2：返回空响应，保持 pi 协议兼容）
  if (!mapping) {
    return { injectedMessages: [] }
  }

  const context: HookContext = {
    pluginId: '',
    hookType: mapping.hookType,
    data: { eventName, data, sessionId },
    timestamp: Date.now(),
  }

  const hookResult = await executeHooks(mapping.hookType, context)

  if (hookResult.blocked) {
    return { blocked: true, reason: hookResult.reason ?? `Blocked by ${hookResult.blockedBy}`, injectedMessages: [] }
  }

  return { injectedMessages: [] }
}
