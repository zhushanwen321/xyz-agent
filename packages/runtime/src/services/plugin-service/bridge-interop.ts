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
 * 工具 schema 缓存 + bridge:sync 负载塑形（P5 从 plugin-service.ts 收口到此）。
 *
 * 持有 bridge 轮询缓存（`bridgeToolSchemas`），并把 ToolRegistration[]
 * 塑形成 {name,description,parameters} 数组——这是插件域能力塑形，
 * 归 adapter 而非 transport。transport 只 reply `getSyncPayload()` 的返回值。
 */
export class BridgeToolCache {
  private schemas: ToolRegistration[] = []

  /** 同步 toolRegistry schema 到 bridge 轮询缓存 */
  syncFrom(toolRegistry: Map<string, ToolEntry>): void {
    this.schemas = Array.from(toolRegistry.values()).map(e => e.schema)
  }

  /** 获取 bridge 轮询缓存的工具 schema */
  getSchemas(): ToolRegistration[] {
    return this.schemas
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
): Promise<BridgeToolExecuteResponse> {
  const entry = Array.from(toolRegistry.values())
    .find(e => e.schema.name === request.toolName)
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
  const context: HookContext = {
    pluginId: '',
    hookType: eventName as HookType,
    data: { eventName, data, sessionId },
    timestamp: Date.now(),
  }
  executeHooks(eventName, context).catch((err: unknown) => {
    console.error(`[plugin-service] handleBridgeEvent error:`, err)
  })
}

export async function handleBridgeIntercept(
  eventName: string,
  data: unknown,
  sessionId: string,
  executeHooks: (hookType: string, context: HookContext) => Promise<HookResult>,
): Promise<BridgeInterceptResponse> {
  const context: HookContext = {
    pluginId: '',
    hookType: eventName as HookType,
    data: { eventName, data, sessionId },
    timestamp: Date.now(),
  }

  const hookResult = await executeHooks(eventName, context)

  if (hookResult.blocked) {
    return { blocked: true, reason: hookResult.reason ?? `Blocked by ${hookResult.blockedBy}`, injectedMessages: [] }
  }

  return { injectedMessages: [] }
}
