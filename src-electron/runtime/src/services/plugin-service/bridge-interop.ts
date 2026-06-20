/**
 * Bridge interop functions
 *
 * Extracted from PluginService to keep file under max-lines limit.
 */

import type { HookContext, HookResult, BridgeToolExecuteRequest, BridgeToolExecuteResponse, BridgeInterceptResponse, HookType, ToolEntry } from './plugin-types.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import { toErrorMessage } from '../../utils/errors.js'

const TOOL_EXECUTE_TIMEOUT_MS = 30_000

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
